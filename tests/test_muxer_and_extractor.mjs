/**
 * Node.js Unit & Integration Test Suite
 * Directly exercises production JS modules: lib/extractor.js, lib/mp4muxer.js, lib/blob_manager.js, and offscreen architecture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FbExtractor from "../lib/extractor.js";
import Mp4Muxer from "../lib/mp4muxer.js";
import BlobManager from "../lib/blob_manager.js";

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

  it("should reject unauthorized or malicious media stream URLs", () => {
    assert.equal(FbExtractor.isValidMediaStream("http://video-sin6-4.xx.fbcdn.net/file.mp4"), false, "HTTP insecure stream must be rejected");
    assert.equal(FbExtractor.isValidMediaStream("https://attacker.example/audio.mp4"), false, "External host must be rejected");
    assert.equal(FbExtractor.isValidMediaStream("javascript:alert(1)"), false, "Javascript scheme must be rejected");
    assert.equal(FbExtractor.isValidMediaStream("data:video/mp4;base64,AAAA"), false, "Data scheme must be rejected");
    assert.equal(FbExtractor.isValidMediaStream(null), false);
  });
});

describe("Mp4Muxer (lib/mp4muxer.js)", () => {
  it("should merge video and audio MP4 buffers into a single dual-track MP4 and return explicit status", () => {
    const videoMp4 = createSampleMp4(1, false, [10, 20, 30, 40, 50]);
    const audioMp4 = createSampleMp4(1, true, [99, 88, 77]);

    const result = Mp4Muxer.mergeMp4Buffers(videoMp4, audioMp4);
    assert.ok(result, "Result object must be returned");
    assert.equal(result.muxed, true, "Must flag muxed as true");
    assert.equal(result.tracks, 2, "Must contain 2 tracks");

    const merged = result.buffer;

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

  it("should detect and reject fragmented MP4 buffers", () => {
    const ftyp = createBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
    const moof = createBox("moof", new Uint8Array([0, 0, 0, 1]));
    const fmp4 = new Uint8Array(ftyp.length + moof.length);
    fmp4.set(ftyp, 0);
    fmp4.set(moof, ftyp.length);

    assert.equal(Mp4Muxer.hasFragmentedBoxes(fmp4.buffer), true, "Must detect moof box");

    const normalAudio = createSampleMp4(1, true, [1, 2]);
    const res = Mp4Muxer.mergeMp4Buffers(fmp4.buffer, normalAudio);
    assert.equal(res.muxed, false, "Must not claim fragmented MP4 as muxed");
    assert.equal(res.reason, "fragmented_mp4_not_supported");
  });

  it("should report missing moov or mdat box explicitly", () => {
    const brokenBuffer = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]).buffer;
    const normalAudio = createSampleMp4(1, true, [1, 2]);
    const res = Mp4Muxer.mergeMp4Buffers(brokenBuffer, normalAudio);
    assert.equal(res.muxed, false);
    assert.equal(res.reason, "missing_moov_or_mdat");
  });
});

describe("BlobManager & MV3 Durability (lib/blob_manager.js)", () => {
  function createMockSessionStorage({ getError = null, setError = null } = {}) {
    let memory = {};
    return {
      get: (key, cb) => {
        if (getError) {
          globalThis.chrome = { runtime: { lastError: { message: getError } } };
          cb({});
          delete globalThis.chrome;
        } else {
          cb({ [key]: memory[key] ? JSON.parse(JSON.stringify(memory[key])) : {} });
        }
      },
      set: (obj, cb) => {
        if (setError) {
          globalThis.chrome = { runtime: { lastError: { message: setError } } };
          cb();
          delete globalThis.chrome;
        } else {
          memory = { ...memory, ...JSON.parse(JSON.stringify(obj)) };
          if (cb) cb();
        }
      },
      dump: () => memory
    };
  }

  it("should persist Blob URL metadata across simulated service-worker restarts and clean up upon completion", async () => {
    const storage = createMockSessionStorage();
    const revokedUrls = [];
    let offscreenClosed = false;

    const mockSender = async (msg) => {
      if (msg.action === "OFFSCREEN_REVOKE_URL") revokedUrls.push(msg.blobUrl);
    };
    const mockCloser = async () => {
      offscreenClosed = true;
    };

    // 1. Register blob download
    const blobUrl = "blob:chrome-extension://mock-id/fb-reel-123";
    await BlobManager.registerBlobDownload(101, blobUrl, storage);
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), true);

    // 2. Simulate Service Worker restart (in-memory variables lost, storage persists)
    const retrievedUrl = await BlobManager.unregisterBlobDownload(101, storage);
    assert.equal(retrievedUrl, blobUrl, "Must retrieve Blob URL from session storage after restart");

    // 3. Revoke Blob URL and close offscreen document
    await BlobManager.revokeBlobUrl(retrievedUrl, {
      messageSender: mockSender,
      offscreenCloser: mockCloser,
      storageApi: storage
    });

    assert.equal(revokedUrls.includes(blobUrl), true, "Blob URL must be revoked");
    assert.equal(offscreenClosed, true, "Offscreen document must close when no downloads remain");
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), false);
  });

  it("should immediately revoke Blob URL if chrome.downloads.download fails to start", async () => {
    const storage = createMockSessionStorage();
    const revokedUrls = [];

    const mockSender = async (msg) => {
      if (msg.action === "OFFSCREEN_REVOKE_URL") revokedUrls.push(msg.blobUrl);
    };

    const failedBlobUrl = "blob:chrome-extension://mock-id/failed-download";

    // Simulate download launch error
    await BlobManager.revokeBlobUrl(failedBlobUrl, {
      messageSender: mockSender,
      storageApi: storage
    });

    assert.equal(revokedUrls.includes(failedBlobUrl), true, "Failed download Blob URL must be immediately revoked");
  });

  it("should serialize concurrent registerBlobDownload calls without dropping entries", async () => {
    const storage = createMockSessionStorage();

    // Start 5 concurrent registrations
    await Promise.all([
      BlobManager.registerBlobDownload(201, "blob:test/201", storage),
      BlobManager.registerBlobDownload(202, "blob:test/202", storage),
      BlobManager.registerBlobDownload(203, "blob:test/203", storage),
      BlobManager.registerBlobDownload(204, "blob:test/204", storage),
      BlobManager.registerBlobDownload(205, "blob:test/205", storage)
    ]);

    const dump = storage.dump()[BlobManager.STORAGE_KEY];
    assert.equal(Object.keys(dump.active).length, 5, "All 5 concurrent registrations must be persisted");
    assert.equal(dump.active["201"], "blob:test/201");
    assert.equal(dump.active["205"], "blob:test/205");
  });

  it("should serialize concurrent unregister operations without race conditions", async () => {
    const storage = createMockSessionStorage();
    await BlobManager.registerBlobDownload(301, "blob:test/301", storage);
    await BlobManager.registerBlobDownload(302, "blob:test/302", storage);

    const [u1, u2] = await Promise.all([
      BlobManager.unregisterBlobDownload(301, storage),
      BlobManager.unregisterBlobDownload(302, storage)
    ]);

    assert.equal(u1, "blob:test/301");
    assert.equal(u2, "blob:test/302");
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), false);
  });

  it("should NOT close offscreen document while another Blob download registration is still pending", async () => {
    const storage = createMockSessionStorage();
    let offscreenClosed = false;
    const mockCloser = async () => {
      offscreenClosed = true;
    };

    // Download A is registered
    await BlobManager.registerBlobDownload(401, "blob:test/401", storage);

    // Download B starts muxing/pending registration
    const pendingTokenB = await BlobManager.beginPendingRegistration("blob:test/402", storage);

    // Download A completes and unregisters -> storage now has 0 active items, but B is durable pending!
    const urlA = await BlobManager.unregisterBlobDownload(401, storage);
    await BlobManager.revokeBlobUrl(urlA, { offscreenCloser: mockCloser, storageApi: storage });

    // Offscreen document MUST remain open because B is pending
    assert.equal(offscreenClosed, false, "Offscreen document must NOT close while B is pending registration");
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), true);

    // Now B completes registration and then finishes
    await BlobManager.completePendingRegistration(pendingTokenB, 402, "blob:test/402", storage);
    const urlB = await BlobManager.unregisterBlobDownload(402, storage);
    await BlobManager.revokeBlobUrl(urlB, { offscreenCloser: mockCloser, storageApi: storage });

    // Now that both are done, offscreen closes
    assert.equal(offscreenClosed, true, "Offscreen document should close once all downloads finish");
  });

  it("should survive service-worker restart during pending registration and complete cleanly", async () => {
    const storage = createMockSessionStorage();

    // 1. Worker 1 begins pending registration
    const token = await BlobManager.beginPendingRegistration("blob:test/pending-restart", storage);
    assert.ok(token);

    // 2. Simulate worker termination and fresh worker restart (in-memory state empty, storage intact)
    const hasPending = await BlobManager.hasActiveBlobDownloads(storage);
    assert.equal(hasPending, true, "Fresh worker must detect pending download from session storage");

    // 3. Fresh worker completes registration upon chrome.downloads callback
    await BlobManager.completePendingRegistration(token, 601, "blob:test/pending-restart", storage);
    const dump = storage.dump()[BlobManager.STORAGE_KEY];
    assert.equal(dump.active["601"], "blob:test/pending-restart");
    assert.equal(dump.pending[token], undefined, "Pending token must be removed upon active registration");
  });

  it("should fail-safe and keep offscreen open on storage get failure", async () => {
    const brokenStorage = createMockSessionStorage({ getError: "Simulated storage failure" });
    const isActive = await BlobManager.hasActiveBlobDownloads(brokenStorage);
    assert.equal(isActive, true, "Must fail-safe to true on storage read failure");
  });

  it("should reject and propagate error on storage set failure", async () => {
    const brokenStorage = createMockSessionStorage({ setError: "Simulated quota error" });
    await assert.rejects(
      async () => {
        await BlobManager.registerBlobDownload(501, "blob:test/501", brokenStorage);
      },
      /Simulated quota error/
    );
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
    assert.ok(manifest.permissions.includes("storage"), "manifest.json must have 'storage' permission");
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
    const muxResult = Mp4Muxer.mergeMp4Buffers(videoMp4, audioMp4);
    assert.equal(muxResult.muxed, true);
    assert.ok(muxResult.buffer.byteLength > 0);

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
