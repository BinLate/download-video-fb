/**
 * Lightweight in-browser ISO-BMFF (MP4) Remuxer
 * Merges separate MP4 video and audio streams (DASH) into a single dual-track MP4 container.
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
        const newHigh = Math.floor(new64 / 4294967296);
        const newLow = new64 % 4294967296;
        writeUint32(view, offset, newHigh);
        writeUint32(view, offset + 4, newLow);
        offset += 8;
      }
    }
  }

  function cloneTrackBox(sourceBuffer, trakBox, trackId) {
    const trakData = sourceBuffer.slice(trakBox.start, trakBox.end);
    const trakView = new DataView(trakData);

    const tkhdBox = findBoxByType(trakData, "tkhd");
    if (tkhdBox) {
      const version = trakView.getUint8(tkhdBox.start + 8);
      const trackIdOffset = tkhdBox.start + 8 + (version === 1 ? 16 : 8);
      if (trackIdOffset + 4 <= trakData.byteLength) {
        writeUint32(trakView, trackIdOffset, trackId);
      }
    }
    return trakData;
  }

  /**
   * Merge separate video and audio MP4 buffers into a single MP4 container.
   * Returns explicit result object { buffer, muxed: boolean, reason?: string }.
   */
  function mergeMp4Buffers(videoBuffer, audioBuffer) {
    if (!videoBuffer && !audioBuffer) throw new Error("No media buffers provided");
    if (!videoBuffer) return { buffer: audioBuffer, muxed: false, reason: "missing_video_buffer" };
    if (!audioBuffer) return { buffer: videoBuffer, muxed: false, reason: "missing_audio_buffer" };

    // Check for fragmented MP4 boxes
    if (hasFragmentedBoxes(videoBuffer) || hasFragmentedBoxes(audioBuffer)) {
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
      ? videoBuffer.slice(videoMvhd.start, videoMvhd.end)
      : new Uint8Array(0).buffer;
    if (mvhdCopy.byteLength >= 32) {
      const mvhdView = new DataView(mvhdCopy);
      const v = mvhdView.getUint8(8);
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

    // Adjust audio track offsets
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

    return {
      buffer: merged.buffer,
      muxed: true,
      tracks: 2
    };
  }

  return {
    findBoxes,
    findBoxByType,
    findBoxesRecursively,
    hasFragmentedBoxes,
    mergeMp4Buffers
  };
});
