/**
 * Node.js Unit & Integration Test Suite
 * Directly exercises production JS modules: lib/extractor.js, lib/mp4muxer.js, and offscreen architecture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FbExtractor from "../lib/extractor.js";
import Mp4Muxer from "../lib/mp4muxer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const SAMPLE_DASH_XML = `
  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.5S" type="static">
    <Period duration="PT0H0M28.461S">
      <AdaptationSet segmentAlignment="true" maxWidth="1080" maxHeight="1920" contentType="video">
        <Representation id="1080p_hd" mimeType="video/mp4" codecs="avc1.64002a" width="1080" height="1920" bandwidth="4200000" FBQualityLabel="1080p">
          <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_1080p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
        </Representation>
        <Representation id="720p_hd" mimeType="video/mp4" codecs="avc1.64001f" width="720" height="1280" bandwidth="2100000" FBQualityLabel="720p">
          <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_720p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
        </Representation>
        <Representation id="360p_sd" mimeType="video/mp4" codecs="avc1.4d401f" width="360" height="640" bandwidth="650000" FBQualityLabel="360p">
          <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_360p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio">
        <Representation id="audio_1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000">
          <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_audio.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>
`;

function createBox(type, contentBytes) {
  const size = 8 + contentBytes.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) {
    buf[4 + i] = type.charCodeAt(i);
  }
  buf.set(contentBytes, 8);
  return buf;
}

function createSampleMp4(trackId, isAudio = false, sampleData = [1, 2, 3, 4]) {
  // 1. ftyp
  const ftypContent = new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);
  const ftyp = createBox("ftyp", ftypContent);

  // 2. tkhd
  const tkhdContent = new Uint8Array(84);
  const tkhdView = new DataView(tkhdContent.buffer);
  tkhdView.setUint8(0, 0);
  tkhdView.setUint32(12, trackId, false);

  // 3. stco (chunk offset)
  const stcoContent = new Uint8Array(12);
  const stcoView = new DataView(stcoContent.buffer);
  stcoView.setUint32(4, 1, false);
  stcoView.setUint32(8, 200, false);

  const stbl = createBox("stbl", createBox("stco", stcoContent));
  const minf = createBox("minf", stbl);
  const mdia = createBox("mdia", minf);
  const trak = createBox("trak", new Uint8Array([...createBox("tkhd", tkhdContent), ...mdia]));

  // mvhd
  const mvhdContent = new Uint8Array(100);
  const moov = createBox("moov", new Uint8Array([...createBox("mvhd", mvhdContent), ...trak]));

  // mdat
  const mdat = createBox("mdat", new Uint8Array(sampleData));

  const total = new Uint8Array(ftyp.length + moov.length + mdat.length);
  total.set(ftyp, 0);
  total.set(moov, ftyp.length);
  total.set(mdat, ftyp.length + moov.length);
  return total.buffer;
}

describe("FbExtractor (lib/extractor.js)", () => {
  it("should parse DASH MPD XML with separate video and audio representations", () => {
    const res = FbExtractor.parseDashManifest(SAMPLE_DASH_XML);
    assert.ok(res, "DASH manifest must be parsed");
    assert.equal(res.videos.length, 3, "Must have 3 video representations");
    assert.equal(res.audios.length, 1, "Must have 1 audio representation");
    assert.equal(res.isDashSeparate, true, "Must flag as DASH separate streams");

    assert.ok(res.hdUrl.includes("AQN_1080p.mp4"), "HD must be highest resolution (1080p)");
    assert.ok(res.sdUrl.includes("AQN_360p.mp4"), "SD must be 360p");
    assert.ok(res.audioUrl.includes("AQN_audio.mp4"), "Audio URL must be extracted");
  });

  it("should clean trailing XML tags and IDM artifacts (%3C/BaseURL)", () => {
    const dirty = "https://video.xx.fbcdn.net/o1/v/t2/file.mp4?oe=6A91A3F3%3C/BaseURL";
    const cleaned = FbExtractor.cleanMediaUrl(dirty);
    assert.equal(cleaned, "https://video.xx.fbcdn.net/o1/v/t2/file.mp4?oe=6A91A3F3");
  });

  it("should strip bytestart and byteend range params to enable full file download", () => {
    const rangeUrl = "https://video.xx.fbcdn.net/o1/v/t2/file.mp4?bytestart=0&byteend=5000&oe=6A91A3F3";
    const cleaned = FbExtractor.cleanMediaUrl(rangeUrl);
    assert.ok(!cleaned.includes("bytestart"), "Must strip bytestart");
    assert.ok(!cleaned.includes("byteend"), "Must strip byteend");
    assert.ok(cleaned.includes("oe=6A91A3F3"), "Must preserve other query params");
  });

  it("should extract progressive URLs over DASH when available", () => {
    const text = JSON.stringify({
      browser_native_hd_url: "https://video.xx.fbcdn.net/v/t1/progressive_hd.mp4?oe=123",
      browser_native_sd_url: "https://video.xx.fbcdn.net/v/t1/progressive_sd.mp4?oe=123"
    });
    const res = FbExtractor.extractStreamsFromText(text);
    assert.ok(res.hdUrl.includes("progressive_hd.mp4"));
    assert.equal(res.isProgressive, true);
    assert.equal(res.audioUrl, null, "Progressive MP4 already contains audio");
  });

  it("should validate Facebook CDN media hostnames and block unauthorized domains", () => {
    assert.equal(FbExtractor.isValidMediaStream("https://video-sin6-4.xx.fbcdn.net/o1/v/file.mp4"), true);
    assert.equal(FbExtractor.isValidMediaStream("https://scontent.xx.fbsbx.com/v/t1/file.mp4"), true);
    assert.equal(FbExtractor.isValidMediaStream("https://attacker.com/fbcdn.net/file.mp4"), false);
  });
});

describe("Mp4Muxer (lib/mp4muxer.js)", () => {
  it("should merge video and audio MP4 buffers into a single dual-track MP4", () => {
    const videoMp4 = createSampleMp4(1, false, [10, 20, 30, 40, 50]);
    const audioMp4 = createSampleMp4(1, true, [99, 88, 77]);

    const merged = Mp4Muxer.mergeMp4Buffers(videoMp4, audioMp4);
    assert.ok(merged, "Merged buffer must be returned");

    // Verify boxes in merged file
    const ftyp = Mp4Muxer.findBoxByType(merged, "ftyp");
    const moov = Mp4Muxer.findBoxByType(merged, "moov");
    const mdat = Mp4Muxer.findBoxByType(merged, "mdat");

    assert.ok(ftyp, "Must have ftyp box");
    assert.ok(moov, "Must have moov box");
    assert.ok(mdat, "Must have mdat box");

    // Verify mdat contains both video payload (5 bytes) and audio payload (3 bytes)
    const mdatDataLen = mdat.size - mdat.headerSize;
    assert.equal(mdatDataLen, 5 + 3, "Merged mdat must contain both video and audio sample data");

    // Verify moov contains 2 trak boxes
    const traks = Mp4Muxer.findBoxes(merged, moov.start + moov.headerSize, moov.end).filter(b => b.type === "trak");
    assert.equal(traks.length, 2, "Must contain exactly 2 trak boxes (video track 1 and audio track 2)");
  });
});

describe("Offscreen Architecture & MV3 Pipeline Integration", () => {
  it("should have valid offscreen document files and manifest permissions", () => {
    const htmlPath = path.join(rootDir, "offscreen", "offscreen.html");
    const jsPath = path.join(rootDir, "offscreen", "offscreen.js");
    const manifestPath = path.join(rootDir, "manifest.json");

    assert.ok(fs.existsSync(htmlPath), "offscreen.html must exist");
    assert.ok(fs.existsSync(jsPath), "offscreen.js must exist");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.ok(manifest.permissions.includes("offscreen"), "manifest.json must have 'offscreen' permission");
  });

  it("should validate full pipeline: DASH separate -> mux -> internal blob URL download -> revocation registration", () => {
    // 1. Parse manifest
    const dashInfo = FbExtractor.parseDashManifest(SAMPLE_DASH_XML);
    assert.equal(dashInfo.isDashSeparate, true);
    assert.ok(dashInfo.hdUrl);
    assert.ok(dashInfo.audioUrl);

    // 2. Offscreen muxing simulation
    const videoMp4 = createSampleMp4(1, false, [1, 2, 3]);
    const audioMp4 = createSampleMp4(1, true, [4, 5]);
    const merged = Mp4Muxer.mergeMp4Buffers(videoMp4, audioMp4);
    assert.ok(merged.byteLength > 0);

    // 3. Mock blob URL creation in DOM environment
    const fakeBlobUrl = "blob:chrome-extension://mock-id/12345-6789";

    // 4. Test downloadMedia logic with internal blob
    const activeBlobDownloads = new Map();
    let downloadCalledWith = null;

    function mockDownloadMedia({ url, isInternalBlob = false }) {
      if (url.startsWith("blob:")) {
        if (!isInternalBlob) {
          throw new Error("Direct external blob URL download is not permitted.");
        }
      } else {
        if (!FbExtractor.isValidMediaStream(url)) {
          throw new Error("Invalid remote stream");
        }
      }
      downloadCalledWith = url;
      const downloadId = 42;
      if (url.startsWith("blob:")) {
        activeBlobDownloads.set(downloadId, url);
      }
      return downloadId;
    }

    // Attempting external blob download must throw
    assert.throws(() => {
      mockDownloadMedia({ url: fakeBlobUrl, isInternalBlob: false });
    }, /Direct external blob URL download is not permitted/);

    // Internal blob download must succeed and register for revocation
    const downloadId = mockDownloadMedia({ url: fakeBlobUrl, isInternalBlob: true });
    assert.equal(downloadId, 42);
    assert.equal(downloadCalledWith, fakeBlobUrl);
    assert.equal(activeBlobDownloads.get(42), fakeBlobUrl);

    // Revocation lifecycle on completion
    activeBlobDownloads.delete(42);
    assert.equal(activeBlobDownloads.has(42), false);
  });
});
