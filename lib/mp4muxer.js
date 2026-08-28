/**
 * Lightweight in-browser ISO-BMFF (MP4) Remuxer
 * Merges separate MP4 video and audio streams (DASH) into a single dual-track MP4 container.
 * Supports both plain (moov+mdat) and fragmented (fMP4: moov + moof/mdat) inputs, which is
 * the format Facebook Reel DASH representations are served in.
 * Operates purely on binary ArrayBuffers without external heavy dependencies.
 * Author: Bin.Late
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Mp4Muxer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function readUint32(view, offset) {
    return view.getUint32(offset, false);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value, false);
  }

  function readBoxType(view, offset) {
    let type = "";
    for (let i = 0; i < 4; i++) {
      type += String.fromCharCode(view.getUint8(offset + i));
    }
    return type;
  }

  function writeBoxType(bytes, offset, type) {
    for (let i = 0; i < 4; i++) {
      bytes[offset + i] = type.charCodeAt(i);
    }
  }

  /**
   * Find top-level or child boxes within [start, end) range.
   */
  function findBoxes(buffer, start = 0, end = buffer.byteLength) {
    const boxes = [];
    const view = new DataView(buffer);
    let offset = start;

    while (offset + 8 <= end) {
      const size = readUint32(view, offset);
      const type = readBoxType(view, offset + 4);

      let headerSize = 8;
      let actualSize = size;

      if (size === 1) {
        // 64-bit large box size
        if (offset + 16 > end) break;
        const high = readUint32(view, offset + 8);
        const low = readUint32(view, offset + 12);
        actualSize = high * 4294967296 + low;
        headerSize = 16;
      } else if (size === 0) {
        // Box extends to end of file
        actualSize = end - offset;
      }

      if (actualSize < headerSize || offset + actualSize > end) {
        break;
      }

      boxes.push({
        type,
        start: offset,
        end: offset + actualSize,
        size: actualSize,
        headerSize
      });

      offset += actualSize;
    }

    return boxes;
  }

  function findBoxByType(buffer, targetType, start = 0, end = buffer.byteLength) {
    const boxes = findBoxes(buffer, start, end);
    return boxes.find((b) => b.type === targetType) || null;
  }

  function findBoxesRecursively(buffer, targetType, start = 0, end = buffer.byteLength) {
    const results = [];
    const boxes = findBoxes(buffer, start, end);

    for (const box of boxes) {
      if (box.type === targetType) {
        results.push(box);
      }
      // Container box types that contain nested child boxes
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type)) {
        const children = findBoxesRecursively(buffer, targetType, box.start + box.headerSize, box.end);
        results.push(...children);
      }
    }
    return results;
  }

  function hasFragmentedBoxes(buffer) {
    if (!buffer || buffer.byteLength < 8) return false;
    const moof = findBoxByType(buffer, "moof");
    const sidx = findBoxByType(buffer, "sidx");
    return Boolean(moof || sidx);
  }

  function adjustChunkOffsets(trakBuffer, box, delta) {
    const view = new DataView(trakBuffer);
    const boxStart = box.start;
    // FullBox header: 4 bytes size, 4 bytes type, 1 byte version, 3 bytes flags
    const entryCount = readUint32(view, boxStart + 12);

    if (box.type === "stco") {
      let offset = boxStart + 16;
      for (let i = 0; i < entryCount; i++) {
        if (offset + 4 > trakBuffer.byteLength) break;
        const cur = readUint32(view, offset);
        writeUint32(view, offset, cur + delta);
        offset += 4;
      }
    } else if (box.type === "co64") {
      let offset = boxStart + 16;
      for (let i = 0; i < entryCount; i++) {
        if (offset + 8 > trakBuffer.byteLength) break;
        const high = readUint32(view, offset);
        const low = readUint32(view, offset + 4);
        const cur64 = high * 4294967296 + low;
        const new64 = cur64 + delta;
        writeUint32(view, offset, Math.floor(new64 / 4294967296));
        writeUint32(view, offset + 4, new64 % 4294967296);
        offset += 8;
      }
    }
  }


  // ---------------------------------------------------------------------------
  // Box inspection helpers (version-aware, used by both merge paths)
  // ---------------------------------------------------------------------------

  /**
   * Read track_ID from a tkhd box. Layout: size(4) type(4) version/flags(4)
   * creation(4|8) modification(4|8) track_ID(4).
   */
  function readTkhdTrackId(buffer, tkhdBox) {
    const view = new DataView(buffer, tkhdBox.start, tkhdBox.size);
    const version = view.getUint8(8);
    return view.getUint32(12 + (version === 1 ? 16 : 8), false);
  }

  function writeTkhdTrackId(buffer, tkhdBox, trackId) {
    const view = new DataView(buffer, tkhdBox.start, tkhdBox.size);
    const version = view.getUint8(8);
    view.setUint32(12 + (version === 1 ? 16 : 8), trackId, false);
  }

  /**
   * next_track_ID is the final 4-byte field of mvhd in both version 0 and 1.
   */
  function writeMvhdNextTrackId(mvhdBytes, nextTrackId) {
    const offset = mvhdBytes.byteLength - 4;
    if (offset >= 8) {
      writeUint32(new DataView(mvhdBytes.buffer, mvhdBytes.byteOffset, mvhdBytes.byteLength), offset, nextTrackId);
    }
    return mvhdBytes;
  }

  function collectTraks(buffer, moovBox) {
    return findBoxesRecursively(buffer, "trak", moovBox.start, moovBox.end);
  }

  function collectTrackIds(buffer, moovBox) {
    const ids = [];
    for (const trak of collectTraks(buffer, moovBox)) {
      const tkhd = findBoxByType(buffer, "tkhd", trak.start + trak.headerSize, trak.end);
      if (tkhd) ids.push(readTkhdTrackId(buffer, tkhd));
    }
    return ids;
  }

  /**
   * Copy all trex boxes out of a moov's mvex container.
   */
  function extractTrexCopies(buffer, moovBox) {
    const mvex = findBoxByType(buffer, "mvex", moovBox.start + moovBox.headerSize, moovBox.end);
    if (!mvex) return [];
    return findBoxes(buffer, mvex.start + mvex.headerSize, mvex.end)
      .filter((b) => b.type === "trex")
      .map((b) => new Uint8Array(buffer.slice(b.start, b.end)));
  }

  function readTrexTrackId(trexBytes) {
    return new DataView(trexBytes.buffer, trexBytes.byteOffset, trexBytes.byteLength).getUint32(12, false);
  }

  function writeTrexTrackId(trexBytes, trackId) {
    trexBytes[12] = (trackId >>> 24) & 0xff;
    trexBytes[13] = (trackId >>> 16) & 0xff;
    trexBytes[14] = (trackId >>> 8) & 0xff;
    trexBytes[15] = trackId & 0xff;
    return trexBytes;
  }

  function createMinimalTrex(trackId) {
    const trex = new Uint8Array(32);
    const view = new DataView(trex.buffer);
    writeUint32(view, 0, 32);
    writeBoxType(trex, 4, "trex");
    // version/flags left as 0
    writeUint32(view, 12, trackId);
    writeUint32(view, 16, 1); // default_sample_description_index
    return trex;
  }

  function createMinimalMvhd(nextTrackId) {
    const mvhd = new Uint8Array(108); // version 0 mvhd
    const view = new DataView(mvhd.buffer);
    writeUint32(view, 0, 108);
    writeBoxType(mvhd, 4, "mvhd");
    writeUint32(view, 20, 1000); // timescale
    writeUint32(view, 104, nextTrackId);
    return mvhd;
  }

  /**
   * Assemble a box of `type` from an array of Uint8Array content parts.
   */
  function assembleBox(type, contentParts) {
    const contentLength = contentParts.reduce((sum, arr) => sum + arr.byteLength, 0);
    const box = new Uint8Array(8 + contentLength);
    writeUint32(new DataView(box.buffer), 0, 8 + contentLength);
    writeBoxType(box, 4, type);
    let offset = 8;
    for (const part of contentParts) {
      box.set(part, offset);
      offset += part.byteLength;
    }
    return box;
  }

  /**
   * Collect [moof, mdat] fragment pairs from a top-level box walk.
   */
  function extractFragmentRanges(buffer, boxes) {
    const fragments = [];
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].type === "moof") {
        const mdat = boxes[i + 1] && boxes[i + 1].type === "mdat" ? boxes[i + 1] : null;
        fragments.push({ moof: boxes[i], mdat });
      }
    }
    return fragments;
  }

  /**
   * Build a standalone, corrected copy of one moof box:
   * - optionally rewrites tfhd track_ID (per trackIdMap),
   * - renumbers mfhd sequence_number,
   * - fixes base_data_offset so sample data offsets remain valid at the
   *   fragment's new absolute position in the merged file.
   */
  function buildFragmentCopy(sourceBuffer, frag, opts) {
    const { trackIdMap = null, sequenceNumber = null, positionDelta = 0, oldMdatStart = 0 } = opts || {};
    const moofBytes = new Uint8Array(sourceBuffer.slice(frag.moof.start, frag.moof.end));
    const view = new DataView(moofBytes.buffer);
    const children = findBoxes(moofBytes.buffer, 8, moofBytes.byteLength);

    if (sequenceNumber !== null && sequenceNumber !== undefined) {
      const mfhd = children.find((b) => b.type === "mfhd");
      if (mfhd) writeUint32(view, mfhd.start + 12, sequenceNumber);
    }

    for (const traf of children) {
      if (traf.type !== "traf") continue;
      const tfhd = findBoxByType(moofBytes.buffer, "tfhd", traf.start + traf.headerSize, traf.end);
      if (!tfhd) continue;

      const flags = view.getUint32(tfhd.start + 8, false) & 0x00ffffff;

      if (trackIdMap) {
        const oldTrackId = view.getUint32(tfhd.start + 12, false);
        if (trackIdMap.has(oldTrackId)) {
          writeUint32(view, tfhd.start + 12, trackIdMap.get(oldTrackId));
        }
      }

      if (flags & 0x000001) {
        // Explicit absolute base_data_offset: shift it by the fragment's move delta.
        const high = view.getUint32(tfhd.start + 16, false);
        const low = view.getUint32(tfhd.start + 20, false);
        const newBase = high * 4294967296 + low + positionDelta;
        writeUint32(view, tfhd.start + 16, Math.floor(newBase / 4294967296));
        writeUint32(view, tfhd.start + 20, newBase % 4294967296);
      } else if (!(flags & 0x020000) && frag.mdat) {
        // No explicit base and no default-base-is-moof: anchor the base to the
        // fragment's own mdat start (its common inherited meaning), shifted by delta.
        const newBase = oldMdatStart + positionDelta;
        view.setUint32(tfhd.start + 8, (view.getUint32(tfhd.start + 8, false) & 0xff000000) | 0x000001, false);
        writeUint32(view, tfhd.start + 16, Math.floor(newBase / 4294967296));
        writeUint32(view, tfhd.start + 20, newBase % 4294967296);
      }
      // flags & 0x020000 (default-base-is-moof): base = start of this moof in the
      // merged file; trun data_offsets are relative and stay valid as-is.
    }

    return moofBytes;
  }

  /**
   * Merge two fragmented MP4 (fMP4) streams into a single dual-track fMP4:
   * [ftyp][merged moov: mvhd + video traks + audio traks + mvex(trex...)]
   * [video moof/mdat fragments][audio moof/mdat fragments]
   */
  function mergeFragmentedMp4Buffers(videoBuffer, audioBuffer) {
    const videoBoxes = findBoxes(videoBuffer, 0, videoBuffer.byteLength);
    const audioBoxes = findBoxes(audioBuffer, 0, audioBuffer.byteLength);

    const videoMoov = videoBoxes.find((b) => b.type === "moov") || null;
    const audioMoov = audioBoxes.find((b) => b.type === "moov") || null;
    if (!videoMoov || !audioMoov) {
      return { buffer: videoBuffer, muxed: false, reason: "missing_moov_or_mdat" };
    }

    const videoFragments = extractFragmentRanges(videoBuffer, videoBoxes);
    const audioFragments = extractFragmentRanges(audioBuffer, audioBoxes);
    if (videoFragments.length === 0 || audioFragments.length === 0) {
      return { buffer: videoBuffer, muxed: false, reason: "missing_movie_fragments" };
    }

    const ftypBox = videoBoxes.find((b) => b.type === "ftyp") || audioBoxes.find((b) => b.type === "ftyp");
    const ftypBytes = ftypBox
      ? new Uint8Array(videoBuffer.slice(ftypBox.start, ftypBox.end))
      : assembleBox("ftyp", [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32])]);

    // --- Allocate unique track IDs: video keeps its IDs, audio is renumbered after max(video) ---
    const videoTrackIds = collectTrackIds(videoBuffer, videoMoov);
    const audioTrackIds = collectTrackIds(audioBuffer, audioMoov);
    let nextTrackId = videoTrackIds.length > 0 ? Math.max(...videoTrackIds) : 0;
    if (nextTrackId < 1) nextTrackId = 1;

    const audioTraks = collectTraks(audioBuffer, audioMoov);
    const audioTrackCount = Math.max(audioTraks.length, 1);

    const audioTrackIdMap = new Map(); // old track id -> new track id
    const assignedAudioIds = [];
    for (let i = 0; i < audioTrackCount; i++) {
      nextTrackId += 1;
      const key = i < audioTrackIds.length ? audioTrackIds[i] : i;
      audioTrackIdMap.set(key, nextTrackId);
      assignedAudioIds.push(nextTrackId);
    }

    // --- traks ---
    const trakBytes = [];
    for (const trak of collectTraks(videoBuffer, videoMoov)) {
      trakBytes.push(new Uint8Array(videoBuffer.slice(trak.start, trak.end)));
    }
    audioTraks.forEach((trak, idx) => {
      const trakCopy = new Uint8Array(audioBuffer.slice(trak.start, trak.end));
      const assignedId = idx < assignedAudioIds.length
        ? assignedAudioIds[idx]
        : assignedAudioIds[assignedAudioIds.length - 1];
      const tkhd = findBoxByType(trakCopy.buffer, "tkhd", 8, trakCopy.byteLength);
      if (tkhd) writeTkhdTrackId(trakCopy.buffer, tkhd, assignedId);
      trakBytes.push(trakCopy);
    });

    // --- mvex: merged trex defaults for every track ---
    const trexById = new Map();
    for (const trex of extractTrexCopies(videoBuffer, videoMoov)) {
      const id = readTrexTrackId(trex);
      if (!trexById.has(id)) trexById.set(id, trex);
    }
    for (const trex of extractTrexCopies(audioBuffer, audioMoov)) {
      const oldId = readTrexTrackId(trex);
      const newId = audioTrackIdMap.has(oldId) ? audioTrackIdMap.get(oldId) : assignedAudioIds[0];
      if (!trexById.has(newId)) trexById.set(newId, writeTrexTrackId(new Uint8Array(trex), newId));
    }
    if (trexById.size === 0) {
      const implicitVideoIds = videoTrackIds.length > 0 ? videoTrackIds : [1];
      for (const id of [...implicitVideoIds, ...assignedAudioIds]) {
        if (!trexById.has(id)) trexById.set(id, createMinimalTrex(id));
      }
    }
    const mvexBytes = trexById.size > 0 ? assembleBox("mvex", [...trexById.values()]) : null;

    // --- mvhd ---
    const videoMvhd = findBoxByType(videoBuffer, "mvhd", videoMoov.start + videoMoov.headerSize, videoMoov.end);
    const mvhdBytes = videoMvhd
      ? writeMvhdNextTrackId(new Uint8Array(videoBuffer.slice(videoMvhd.start, videoMvhd.end)), nextTrackId + 1)
      : createMinimalMvhd(nextTrackId + 1);

    // --- merged moov ---
    const moovContent = [mvhdBytes, ...trakBytes];
    if (mvexBytes) moovContent.push(mvexBytes);
    const moovBytes = assembleBox("moov", moovContent);

    // --- plan fragment placement, then emit corrected copies ---
    const prefixLength = ftypBytes.byteLength + moovBytes.byteLength;
    let cursor = prefixLength;
    const plan = [];
    let seq = 1;
    for (const frag of videoFragments) {
      plan.push({ source: videoBuffer, frag, trackIdMap: null, seq: seq++, newStart: cursor });
      cursor += frag.moof.size + (frag.mdat ? frag.mdat.size : 0);
    }
    for (const frag of audioFragments) {
      plan.push({ source: audioBuffer, frag, trackIdMap: audioTrackIdMap, seq: seq++, newStart: cursor });
      cursor += frag.moof.size + (frag.mdat ? frag.mdat.size : 0);
    }

    const fragmentParts = [];
    for (const item of plan) {
      const positionDelta = item.newStart - item.frag.moof.start;
      fragmentParts.push(buildFragmentCopy(item.source, item.frag, {
        trackIdMap: item.trackIdMap,
        sequenceNumber: item.seq,
        positionDelta,
        oldMdatStart: item.frag.mdat ? item.frag.mdat.start : 0
      }));
      if (item.frag.mdat) {
        fragmentParts.push(new Uint8Array(item.source.slice(item.frag.mdat.start, item.frag.mdat.end)));
      }
    }

    // Concatenate top-level boxes directly (no wrapper box) so demuxers see ftyp/moof/mdat.
    const parts = [ftypBytes, moovBytes, ...fragmentParts];
    const merged = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
    let off = 0;
    for (const part of parts) {
      merged.set(part, off);
      off += part.byteLength;
    }

    return {
      buffer: merged.buffer,
      muxed: true,
      tracks: trakBytes.length,
      format: "fragmented"
    };
  }

  // ---------------------------------------------------------------------------
  // Plain (non-fragmented) MP4 merge
  // ---------------------------------------------------------------------------

  function cloneTrackBox(sourceBuffer, trakBox, trackId) {
    const trakCopy = new Uint8Array(sourceBuffer.slice(trakBox.start, trakBox.end));
    // Search INSIDE the trak box (skip its own 8-byte header) for the tkhd child.
    const tkhdBox = findBoxByType(trakCopy.buffer, "tkhd", 8, trakCopy.byteLength);
    if (tkhdBox) {
      writeTkhdTrackId(trakCopy.buffer, tkhdBox, trackId);
    }
    return trakCopy;
  }

  /**
   * Merge separate video and audio MP4 buffers into a single MP4 container.
   * Supports both plain MP4 (moov+mdat) and fragmented MP4 (fMP4) inputs.
   * Returns an explicit result object { buffer, muxed: boolean, reason?: string }.
   */
  function mergeMp4Buffers(videoBuffer, audioBuffer) {
    if (!videoBuffer && !audioBuffer) throw new Error("No media buffers provided");
    if (!videoBuffer) return { buffer: audioBuffer, muxed: false, reason: "missing_video_buffer" };
    if (!audioBuffer) return { buffer: videoBuffer, muxed: false, reason: "missing_audio_buffer" };

    // Dispatch on fragmented input: fMP4 in -> fMP4 out.
    const videoFragmented = hasFragmentedBoxes(videoBuffer);
    const audioFragmented = hasFragmentedBoxes(audioBuffer);
    if (videoFragmented && audioFragmented) {
      return mergeFragmentedMp4Buffers(videoBuffer, audioBuffer);
    }
    if (videoFragmented || audioFragmented) {
      // Mixed plain/fragmented inputs cannot be merged without full re-muxing.
      return { buffer: videoBuffer, muxed: false, reason: "fragmented_mp4_not_supported" };
    }

    // Locate boxes in video buffer
    const videoFtyp = findBoxByType(videoBuffer, "ftyp");
    const videoMoov = findBoxByType(videoBuffer, "moov");
    const videoMdat = findBoxByType(videoBuffer, "mdat");

    // Locate boxes in audio buffer
    const audioMoov = findBoxByType(audioBuffer, "moov");
    const audioMdat = findBoxByType(audioBuffer, "mdat");

    if (!videoMoov || !videoMdat || !audioMoov || !audioMdat) {
      return { buffer: videoBuffer, muxed: false, reason: "missing_moov_or_mdat" };
    }

    // Extract video trak
    const videoTraks = findBoxesRecursively(videoBuffer, "trak", videoMoov.start, videoMoov.end);
    if (videoTraks.length === 0) {
      return { buffer: videoBuffer, muxed: false, reason: "missing_video_trak" };
    }
    const videoTrakCopy = cloneTrackBox(videoBuffer, videoTraks[0], 1);

    // Extract audio trak
    const audioTraks = findBoxesRecursively(audioBuffer, "trak", audioMoov.start, audioMoov.end);
    if (audioTraks.length === 0) {
      return { buffer: videoBuffer, muxed: false, reason: "missing_audio_trak" };
    }
    const audioTrakCopy = cloneTrackBox(audioBuffer, audioTraks[0], 2);

    // Extract video mvhd
    const videoMvhd = findBoxByType(videoBuffer, "mvhd", videoMoov.start + videoMoov.headerSize, videoMoov.end);
    const mvhdCopy = videoMvhd
      ? new Uint8Array(videoBuffer.slice(videoMvhd.start, videoMvhd.end))
      : createMinimalMvhd(3);
    writeMvhdNextTrackId(mvhdCopy, 3);

    // Prepare ftyp box
    const ftypCopy = videoFtyp
      ? new Uint8Array(videoBuffer.slice(videoFtyp.start, videoFtyp.end))
      : new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);

    // Calculate new moov box size
    const newMoovContentSize = mvhdCopy.byteLength + videoTrakCopy.byteLength + audioTrakCopy.byteLength;
    const newMoovSize = 8 + newMoovContentSize;

    // Video mdat content
    const videoMdatContentStart = videoMdat.start + videoMdat.headerSize;
    const videoMdatContentLength = videoMdat.size - videoMdat.headerSize;
    const videoMdatContent = new Uint8Array(videoBuffer, videoMdatContentStart, videoMdatContentLength);

    // Audio mdat content
    const audioMdatContentStart = audioMdat.start + audioMdat.headerSize;
    const audioMdatContentLength = audioMdat.size - audioMdat.headerSize;
    const audioMdatContent = new Uint8Array(audioBuffer, audioMdatContentStart, audioMdatContentLength);

    const mergedMdatContentLength = videoMdatContentLength + audioMdatContentLength;
    const mergedMdatSize = 8 + mergedMdatContentLength;

    // Position of mdat content in new file
    const newMdatContentStart = ftypCopy.byteLength + newMoovSize + 8;

    // Adjust video track offsets
    const videoOffsetDelta = newMdatContentStart - videoMdatContentStart;
    const videoStcoList = findBoxesRecursively(videoTrakCopy.buffer, "stco");
    const videoCo64List = findBoxesRecursively(videoTrakCopy.buffer, "co64");
    for (const box of [...videoStcoList, ...videoCo64List]) {
      adjustChunkOffsets(videoTrakCopy.buffer, box, videoOffsetDelta);
    }

    // Adjust audio track offsets
    const newAudioMdatContentStart = newMdatContentStart + videoMdatContentLength;
    const audioOffsetDelta = newAudioMdatContentStart - audioMdatContentStart;
    const audioStcoList = findBoxesRecursively(audioTrakCopy.buffer, "stco");
    const audioCo64List = findBoxesRecursively(audioTrakCopy.buffer, "co64");
    for (const box of [...audioStcoList, ...audioCo64List]) {
      adjustChunkOffsets(audioTrakCopy.buffer, box, audioOffsetDelta);
    }

    // Construct final merged buffer
    const totalSize = ftypCopy.byteLength + newMoovSize + mergedMdatSize;
    const merged = new Uint8Array(totalSize);
    let cur = 0;

    // 1. Write ftyp
    merged.set(ftypCopy, cur);
    cur += ftypCopy.byteLength;

    // 2. Write moov header
    const moovHeader = new Uint8Array(8);
    writeUint32(new DataView(moovHeader.buffer), 0, newMoovSize);
    writeBoxType(moovHeader, 4, "moov");
    merged.set(moovHeader, cur);
    cur += 8;

    // 3. Write mvhd, video trak, audio trak inside moov
    merged.set(mvhdCopy, cur);
    cur += mvhdCopy.byteLength;
    merged.set(videoTrakCopy, cur);
    cur += videoTrakCopy.byteLength;
    merged.set(audioTrakCopy, cur);
    cur += audioTrakCopy.byteLength;

    // 4. Write mdat header
    const mdatHeader = new Uint8Array(8);
    writeUint32(new DataView(mdatHeader.buffer), 0, mergedMdatSize);
    writeBoxType(mdatHeader, 4, "mdat");
    merged.set(mdatHeader, cur);
    cur += 8;

    // 5. Write video mdat + audio mdat data
    merged.set(videoMdatContent, cur);
    cur += videoMdatContentLength;
    merged.set(audioMdatContent, cur);
    cur += audioMdatContentLength;

    return {
      buffer: merged.buffer,
      muxed: true,
      tracks: 2,
      format: "plain"
    };
  }

  return {
    findBoxes,
    findBoxByType,
    findBoxesRecursively,
    hasFragmentedBoxes,
    buildFragmentCopy,
    mergeMp4Buffers,
    mergeFragmentedMp4Buffers
  };
});
