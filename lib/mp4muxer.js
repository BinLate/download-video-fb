/**
 * Pure JavaScript ISO-BMFF (MP4) Muxer
 * Merges separate DASH Video and Audio MP4 streams into a single playable MP4 file.
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

  function readBoxHeader(view, offset, limit) {
    if (offset + 8 > limit) return null;
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > limit) return null;
      // 64-bit size (handle safely within JS 53-bit integers)
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      size = high * 0x100000000 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    return { size, type, headerSize, start: offset, end: offset + size };
  }

  function findBoxes(buffer, parentStart = 0, parentEnd = buffer.byteLength) {
    const view = new DataView(buffer);
    const boxes = [];
    let offset = parentStart;
    while (offset + 8 <= parentEnd) {
      const box = readBoxHeader(view, offset, parentEnd);
      if (!box || box.size < 8 || box.end > parentEnd) break;
      boxes.push(box);
      offset = box.end;
    }
    return boxes;
  }

  function findBoxByType(buffer, targetType, parentStart = 0, parentEnd = buffer.byteLength) {
    const boxes = findBoxes(buffer, parentStart, parentEnd);
    return boxes.find(b => b.type === targetType) || null;
  }

  function findSubBox(buffer, parentBox, subType) {
    const contentStart = parentBox.start + parentBox.headerSize;
    return findBoxByType(buffer, subType, contentStart, parentBox.end);
  }

  function findBoxesRecursively(buffer, targetType, start = 0, end = buffer.byteLength) {
    const results = [];
    const boxes = findBoxes(buffer, start, end);
    for (const b of boxes) {
      if (b.type === targetType) {
        results.push(b);
      } else if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type)) {
        const sub = findBoxesRecursively(buffer, targetType, b.start + b.headerSize, b.end);
        results.push(...sub);
      }
    }
    return results;
  }

  /**
   * Adjust chunk offsets in stco or co64 box.
   */
  function adjustChunkOffsets(buffer, stcoBox, delta) {
    if (delta === 0) return;
    const view = new DataView(buffer);
    const contentStart = stcoBox.start + stcoBox.headerSize;
    // version(1) + flags(3) = 4 bytes
    const entryCount = readUint32(view, contentStart + 4);
    if (stcoBox.type === "stco") {
      let offset = contentStart + 8;
      for (let i = 0; i < entryCount; i++) {
        if (offset + 4 > stcoBox.end) break;
        const current = readUint32(view, offset);
        writeUint32(view, offset, current + delta);
        offset += 4;
      }
    } else if (stcoBox.type === "co64") {
      let offset = contentStart + 8;
      for (let i = 0; i < entryCount; i++) {
        if (offset + 8 > stcoBox.end) break;
        const high = readUint32(view, offset);
        const low = readUint32(view, offset + 4);
        const current = high * 0x100000000 + low + delta;
        writeUint32(view, offset, Math.floor(current / 0x100000000));
        writeUint32(view, offset + 4, current >>> 0);
        offset += 8;
      }
    }
  }

  /**
   * Extract or clone trak box with modified trackId.
   */
  function cloneTrackBox(buffer, trakBox, newTrackId = null) {
    const copy = buffer.slice(trakBox.start, trakBox.end);
    const view = new DataView(copy);
    if (newTrackId !== null) {
      // Find tkhd box inside trak
      const tkhd = findBoxByType(copy, "tkhd", 8, copy.byteLength);
      if (tkhd) {
        const version = view.getUint8(tkhd.start + tkhd.headerSize);
        // Track ID offset: version 0 -> 12 bytes from content start, version 1 -> 20 bytes
        const trackIdOffset = tkhd.start + tkhd.headerSize + (version === 1 ? 20 : 12);
        if (trackIdOffset + 4 <= tkhd.end) {
          writeUint32(view, trackIdOffset, newTrackId);
        }
      }
    }
    return copy;
  }

  /**
   * Merge video ArrayBuffer and audio ArrayBuffer into a single ISO-BMFF MP4 ArrayBuffer.
   */
  function mergeMp4Buffers(videoBuffer, audioBuffer) {
    if (!videoBuffer && !audioBuffer) throw new Error("No media buffers provided");
    if (!videoBuffer) return audioBuffer;
    if (!audioBuffer) return videoBuffer;

    // Locate boxes in video buffer
    const videoFtyp = findBoxByType(videoBuffer, "ftyp");
    const videoMoov = findBoxByType(videoBuffer, "moov");
    const videoMdat = findBoxByType(videoBuffer, "mdat");

    // Locate boxes in audio buffer
    const audioMoov = findBoxByType(audioBuffer, "moov");
    const audioMdat = findBoxByType(audioBuffer, "mdat");

    if (!videoMoov || !videoMdat || !audioMoov || !audioMdat) {
      // If either file lacks moov/mdat box, return videoBuffer as fallback
      return videoBuffer;
    }

    // Extract video trak
    const videoTraks = findBoxesRecursively(videoBuffer, "trak", videoMoov.start, videoMoov.end);
    if (videoTraks.length === 0) return videoBuffer;
    const videoTrakCopy = cloneTrackBox(videoBuffer, videoTraks[0], 1);

    // Extract audio trak
    const audioTraks = findBoxesRecursively(audioBuffer, "trak", audioMoov.start, audioMoov.end);
    if (audioTraks.length === 0) return videoBuffer;
    const audioTrakCopy = cloneTrackBox(audioBuffer, audioTraks[0], 2);

    // Extract video mvhd
    const videoMvhd = findBoxByType(videoBuffer, "mvhd", videoMoov.start + videoMoov.headerSize, videoMoov.end);
    const mvhdCopy = videoMvhd
      ? videoBuffer.slice(videoMvhd.start, videoMvhd.end)
      : new Uint8Array(0).buffer;
    if (mvhdCopy.byteLength >= 32) {
      const mvhdView = new DataView(mvhdCopy);
      const v = mvhdView.getUint8(8);
      // next_track_id is at the end of mvhd
      const nextTrackOffset = 8 + (v === 1 ? 32 + 80 : 16 + 80);
      if (nextTrackOffset + 4 <= mvhdCopy.byteLength) {
        writeUint32(mvhdView, nextTrackOffset, 3);
      }
    }

    // Prepare ftyp box
    const ftypCopy = videoFtyp
      ? videoBuffer.slice(videoFtyp.start, videoFtyp.end)
      : new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]).buffer;

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
    const videoOldMdatContentStart = videoMdatContentStart;
    const audioOldMdatContentStart = audioMdatContentStart;

    // Adjust video track offsets
    const videoOffsetDelta = newMdatContentStart - videoOldMdatContentStart;
    const videoStcoList = findBoxesRecursively(videoTrakCopy, "stco");
    const videoCo64List = findBoxesRecursively(videoTrakCopy, "co64");
    for (const box of [...videoStcoList, ...videoCo64List]) {
      adjustChunkOffsets(videoTrakCopy, box, videoOffsetDelta);
    }

    // Adjust audio track offsets (audio data starts after video data in mdat)
    const newAudioMdatContentStart = newMdatContentStart + videoMdatContentLength;
    const audioOffsetDelta = newAudioMdatContentStart - audioOldMdatContentStart;
    const audioStcoList = findBoxesRecursively(audioTrakCopy, "stco");
    const audioCo64List = findBoxesRecursively(audioTrakCopy, "co64");
    for (const box of [...audioStcoList, ...audioCo64List]) {
      adjustChunkOffsets(audioTrakCopy, box, audioOffsetDelta);
    }

    // Construct final merged buffer
    const totalSize = ftypCopy.byteLength + newMoovSize + mergedMdatSize;
    const merged = new Uint8Array(totalSize);
    let cur = 0;

    // 1. Write ftyp
    merged.set(new Uint8Array(ftypCopy), cur);
    cur += ftypCopy.byteLength;

    // 2. Write moov header
    const moovHeader = new DataView(new ArrayBuffer(8));
    moovHeader.setUint32(0, newMoovSize, false);
    moovHeader.setUint8(4, 0x6d); // 'm'
    moovHeader.setUint8(5, 0x6f); // 'o'
    moovHeader.setUint8(6, 0x6f); // 'o'
    moovHeader.setUint8(7, 0x76); // 'v'
    merged.set(new Uint8Array(moovHeader.buffer), cur);
    cur += 8;

    // 3. Write mvhd, video trak, audio trak inside moov
    merged.set(new Uint8Array(mvhdCopy), cur);
    cur += mvhdCopy.byteLength;
    merged.set(new Uint8Array(videoTrakCopy), cur);
    cur += videoTrakCopy.byteLength;
    merged.set(new Uint8Array(audioTrakCopy), cur);
    cur += audioTrakCopy.byteLength;

    // 4. Write mdat header
    const mdatHeader = new DataView(new ArrayBuffer(8));
    mdatHeader.setUint32(0, mergedMdatSize, false);
    mdatHeader.setUint8(4, 0x6d); // 'm'
    mdatHeader.setUint8(5, 0x64); // 'd'
    mdatHeader.setUint8(6, 0x61); // 'a'
    mdatHeader.setUint8(7, 0x74); // 't'
    merged.set(new Uint8Array(mdatHeader.buffer), cur);
    cur += 8;

    // 5. Write video mdat + audio mdat data
    merged.set(videoMdatContent, cur);
    cur += videoMdatContentLength;
    merged.set(audioMdatContent, cur);
    cur += audioMdatContentLength;

    return merged.buffer;
  }

  /**
   * Fetch both video and audio streams from CDN and mux them into a single Blob URL.
   */
  async function fetchAndMuxMedia(videoUrl, audioUrl, onProgress = null) {
    if (!videoUrl) throw new Error("Video stream URL is required");

    if (onProgress) onProgress("Đang tải dữ liệu video...");
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Lỗi tải luồng video: HTTP ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();

    if (!audioUrl) {
      const videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
      return { blobUrl: URL.createObjectURL(videoBlob), isMuxed: false, hasAudio: false };
    }

    if (onProgress) onProgress("Đang tải dữ liệu âm thanh...");
    try {
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        // Fallback to video-only if audio fetch fails
        const fallbackBlob = new Blob([videoBuffer], { type: "video/mp4" });
        return { blobUrl: URL.createObjectURL(fallbackBlob), isMuxed: false, hasAudio: false };
      }
      const audioBuffer = await audioRes.arrayBuffer();

      if (onProgress) onProgress("Đang ghép hình ảnh và âm thanh HD...");
      const mergedBuffer = mergeMp4Buffers(videoBuffer, audioBuffer);
      const mergedBlob = new Blob([mergedBuffer], { type: "video/mp4" });
      return { blobUrl: URL.createObjectURL(mergedBlob), isMuxed: true, hasAudio: true };
    } catch (err) {
      console.warn("[Mp4Muxer] Muxing error, using video-only:", err);
      const fallbackBlob = new Blob([videoBuffer], { type: "video/mp4" });
      return { blobUrl: URL.createObjectURL(fallbackBlob), isMuxed: false, hasAudio: false };
    }
  }

  return {
    mergeMp4Buffers,
    fetchAndMuxMedia,
    findBoxes,
    findBoxByType,
    adjustChunkOffsets
  };
});
