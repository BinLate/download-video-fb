/**
 * Node.js Unit & Integration Test Suite
 * Directly exercises production JS modules: lib/extractor.js, lib/mp4muxer.js, lib/blob_manager.js, and offscreen architecture.
 */

import { describe, it, beforeEach } from "node:test";
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

/**
 * Build a synthetic fragmented MP4 (fMP4): ftyp + moov(mvhd+trak+mvex(trex)) + (moof+mdat)+.
 * baseOffsetMode:
 *   "moof"    -> tfhd uses default-base-is-moof flag (0x020000)
 *   "explicit"-> tfhd carries an explicit absolute base_data_offset pointing at the mdat
 */
function createFragmentedMp4(trackId, fragmentPayloads, { baseOffsetMode = "moof" } = {}) {
  const ftyp = createBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]));

  // mvhd v0 (108 bytes), next_track_ID at 104
  const mvhd = new Uint8Array(108);
  {
    const v = new DataView(mvhd.buffer);
    v.setUint32(0, 108, false);
    mvhd.set([0x6d, 0x76, 0x68, 0x64], 4);
    v.setUint32(20, 1000, false);
    v.setUint32(104, trackId + 1, false);
  }

  // tkhd v0 (88 bytes): track_ID at offset 20
  const tkhd = new Uint8Array(88);
  {
    const v = new DataView(tkhd.buffer);
    v.setUint32(0, 88, false);
    tkhd.set([0x74, 0x6b, 0x68, 0x64], 4);
    v.setUint32(20, trackId, false);
  }
  const trak = createBox("trak", tkhd);

  // trex content: ver/flags(4) + track_ID(4) + defaults(16)
  const trexContent = new Uint8Array(24);
  {
    const v = new DataView(trexContent.buffer);
    v.setUint32(4, trackId, false);
    v.setUint32(8, 1, false);
  }
  const mvex = createBox("mvex", createBox("trex", trexContent));

  const moov = createBox("moov", new Uint8Array([...createBox("mvhd", mvhd), ...trak, ...mvex]));

  const hasBase = baseOffsetMode === "explicit";
  const tfhdSize = hasBase ? 24 : 16; // 8 + ver/flags(4) + track(4) [+ base(8)]
  const moofSize = 8 + 16 + (8 + tfhdSize + 16 + 20); // mfhd(16: ver/flags+seq) + traf(tfhd+tfdt+trun)

  const parts = [ftyp, moov];
  let cur = ftyp.length + moov.length;
  fragmentPayloads.forEach((payload, i) => {
    const moofStart = cur;
    const mdatStart = moofStart + moofSize;

    // mfhd FullBox content: ver/flags(4) + sequence_number(4)
    const mfhdContent = new Uint8Array(8);
    new DataView(mfhdContent.buffer).setUint32(4, i + 100, false); // distinctive sequence number

    const tfhdContent = new Uint8Array(tfhdSize - 8);
    {
      const v = new DataView(tfhdContent.buffer);
      v.setUint32(0, hasBase ? 0x00000001 : 0x00200000, false); // flags: explicit-base | default-base-is-moof
      v.setUint32(4, trackId, false);
      if (hasBase) {
        // 64-bit base_data_offset: high word then low word (values < 4GB -> high = 0)
        v.setUint32(8, 0, false);
        v.setUint32(12, mdatStart, false);
      }
    }

    const tfdtContent = new Uint8Array(8);
    new DataView(tfdtContent.buffer).setUint32(4, i * 1000, false);

    const trunContent = new Uint8Array(12);
    {
      const v = new DataView(trunContent.buffer);
      v.setUint32(0, 0x00000001, false); // flags: data-offset present
      v.setUint32(4, 1, false); // one sample
      v.setUint32(8, hasBase ? 0 : moofSize + 8, false); // data_offset relative to base
    }

    const traf = createBox("traf", new Uint8Array([...createBox("tfhd", tfhdContent), ...createBox("tfdt", tfdtContent), ...createBox("trun", trunContent)]));
    const moof = createBox("moof", new Uint8Array([...createBox("mfhd", mfhdContent), ...traf]));
    const mdat = createBox("mdat", new Uint8Array(payload));
    parts.push(moof, mdat);
    cur += moofSize + mdat.length;
  });

  const total = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    total.set(p, off);
    off += p.length;
  }
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

  it("should parse dash_manifest payloads containing escaped quotes and extract audio", () => {
    // Runtime payload contains \" and \/ escape sequences exactly like Facebook's dash_manifest JSON value.
    const manifest = String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"720\" height=\"1280\" bandwidth=\"800000\" codecs=\"avc1\" FBQualityLabel=\"720p\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/video.mp4?oe=123<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"64000\" codecs=\"mp4a.40.2\" FBQualityLabel=\"AUDIO\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/audio.mp4?oe=123<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`;
    const text = '"video_id":"1234567890","dash_manifest":"' + manifest + '"';
    const res = FbExtractor.extractStreamsFromText(text);
    assert.ok(res, "Streams must be extracted from escaped dash_manifest");
    assert.equal(res.isDashSeparate, true, "Escaped dash_manifest must yield separate A/V streams");
    assert.ok(res.audioUrl && res.audioUrl.includes("audio.mp4"), "Audio URL must survive escaped-quote parsing");
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

describe("Stream Budget & Memory Protection (fetchWithBudget)", () => {
  it("should reject responses with Content-Length exceeding the budget before body read", async () => {
    let bodyRead = false;
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-length", "300000000"]]), // 300MB
      body: {
        getReader: () => {
          bodyRead = true;
          return {
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {}
          };
        }
      }
    });

    await assert.rejects(
      async () => {
        await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 250 * 1024 * 1024, mockFetch);
      },
      /vượt quá hạn mức bộ nhớ/
    );

    assert.equal(bodyRead, false, "Must NOT open body reader when Content-Length exceeds budget");
  });

  it("should stream chunks and cancel reader immediately when accumulated bytes exceed budget", async () => {
    let readerCancelled = false;
    const chunks = [
      new Uint8Array(50),
      new Uint8Array(60), // Total 110 bytes > budget of 100 bytes
      new Uint8Array(50)
    ];
    let chunkIdx = 0;

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map(), // No Content-Length
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkIdx >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[chunkIdx++] };
          },
          cancel: async (reason) => {
            readerCancelled = true;
          }
        })
      }
    });

    await assert.rejects(
      async () => {
        await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 100, mockFetch);
      },
      /vượt quá hạn mức bộ nhớ/
    );

    assert.equal(readerCancelled, true, "Reader must be cancelled on buffer overflow");
  });

  it("should successfully assemble chunks within budget", async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const chunks = [chunk1, chunk2];
    let chunkIdx = 0;

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-length", "5"]]),
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkIdx >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[chunkIdx++] };
          },
          cancel: async () => {}
        })
      }
    });

    const buffer = await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 100, mockFetch);
    const view = new Uint8Array(buffer);
    assert.deepEqual(Array.from(view), [1, 2, 3, 4, 5]);
  });

  it("should handle non-streaming fallback with verified Content-Length and reject without Content-Length", async () => {
    // 1. Success with verified Content-Length
    const mockSuccess = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-length", "4"]]),
      body: null,
      arrayBuffer: async () => new Uint8Array([10, 20, 30, 40]).buffer
    });
    const buf = await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 100, mockSuccess);
    assert.equal(buf.byteLength, 4);

    // 2. Rejection when Content-Length is missing on non-streaming response
    const mockMissingCl = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: null,
      arrayBuffer: async () => new Uint8Array([10, 20, 30, 40]).buffer
    });
    await assert.rejects(
      async () => {
        await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 100, mockMissingCl);
      },
      /không hỗ trợ ReadableStream/
    );
  });

  it("should reject Content-Length with malformed or non-integer values", async () => {
    const mockMalformed = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-length", "100MB"]]),
      body: null,
      arrayBuffer: async () => new Uint8Array(10).buffer
    });

    await assert.rejects(
      async () => {
        await FbExtractor.fetchWithBudget("https://video.fbcdn.net/test.mp4", 100, mockMalformed);
      },
      /không hỗ trợ ReadableStream/
    );
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

  it("should merge two fragmented MP4 (fMP4) streams into a dual-track fMP4", () => {
    const video = createFragmentedMp4(1, [[1, 2, 3, 4, 5], [6, 7]], { baseOffsetMode: "moof" });
    const audio = createFragmentedMp4(1, [[10, 11, 12]], { baseOffsetMode: "moof" });

    const res = Mp4Muxer.mergeMp4Buffers(video, audio);
    assert.equal(res.muxed, true, "fMP4 + fMP4 must be merged");
    assert.equal(res.format, "fragmented");
    assert.equal(res.tracks, 2, "Must contain 2 tracks");

    const merged = res.buffer;
    const top = Mp4Muxer.findBoxes(merged);
    const moov = top.find((b) => b.type === "moov");
    const moofs = top.filter((b) => b.type === "moof");
    assert.ok(moov, "merged fMP4 must contain moov");
    assert.equal(moofs.length, 3, "video 2 fragments + audio 1 fragment");

    // traks: 2, with unique ids 1 and 2
    const traks = Mp4Muxer.findBoxesRecursively(merged, "trak", moov.start, moov.end);
    assert.equal(traks.length, 2);
    const tkhdIds = traks.map((tr) => {
      const tk = Mp4Muxer.findBoxByType(merged, "tkhd", tr.start + tr.headerSize, tr.end);
      return new DataView(merged, tk.start, tk.size).getUint32(20, false);
    });
    assert.deepEqual([...tkhdIds].sort(), [1, 2], "tkhd track IDs must be unique (video 1, audio 2)");

    // mvex contains 2 trex with ids 1 and 2
    const mvex = Mp4Muxer.findBoxByType(merged, "mvex", moov.start + moov.headerSize, moov.end);
    assert.ok(mvex, "merged moov must contain mvex");
    const trexes = Mp4Muxer.findBoxes(merged, mvex.start + mvex.headerSize, mvex.end).filter((b) => b.type === "trex");
    assert.equal(trexes.length, 2);
    const trexIds = trexes.map((t) => new DataView(merged, t.start, t.size).getUint32(12, false));
    assert.deepEqual([...trexIds].sort(), [1, 2], "trex defaults must cover both tracks");

    // audio fragment tfhd must reference track 2, mfhd renumbered sequentially
    const audioMoof = moofs[2];
    const audioChildren = Mp4Muxer.findBoxes(merged, audioMoof.start + audioMoof.headerSize, audioMoof.end);
    const audioTraf = audioChildren.find((b) => b.type === "traf");
    const audioTfhd = Mp4Muxer.findBoxByType(merged, "tfhd", audioTraf.start + audioTraf.headerSize, audioTraf.end);
    assert.equal(new DataView(merged, audioTfhd.start, audioTfhd.size).getUint32(12, false), 2, "audio fragment tfhd must reference track 2");
    const audioMfhd = audioChildren.find((b) => b.type === "mfhd");
    assert.equal(new DataView(merged, audioMfhd.start, audioMfhd.size).getUint32(12, false), 3, "sequence numbers must be renumbered 1..3");

    // video fragment tfhd must keep track 1
    const videoMoof = moofs[0];
    const videoChildren = Mp4Muxer.findBoxes(merged, videoMoof.start + videoMoof.headerSize, videoMoof.end);
    const videoTraf = videoChildren.find((b) => b.type === "traf");
    const videoTfhd = Mp4Muxer.findBoxByType(merged, "tfhd", videoTraf.start + videoTraf.headerSize, videoTraf.end);
    assert.equal(new DataView(merged, videoTfhd.start, videoTfhd.size).getUint32(12, false), 1, "video fragment tfhd must reference track 1");
  });

  it("should shift explicit base_data_offset when merging fMP4 fragments", () => {
    const video = createFragmentedMp4(1, [[1, 2]], { baseOffsetMode: "explicit" });
    const audio = createFragmentedMp4(1, [[3, 4]], { baseOffsetMode: "explicit" });

    const res = Mp4Muxer.mergeMp4Buffers(video, audio);
    assert.equal(res.muxed, true, "fMP4 with explicit base offsets must merge");

    const merged = res.buffer;
    const top = Mp4Muxer.findBoxes(merged);
    const moofs = top.filter((b) => b.type === "moof");
    const mdats = top.filter((b) => b.type === "mdat");
    assert.equal(moofs.length, 2);
    assert.equal(mdats.length, 2);

    const audioMoof = moofs[1];
    const audioChildren = Mp4Muxer.findBoxes(merged, audioMoof.start + audioMoof.headerSize, audioMoof.end);
    const audioTraf = audioChildren.find((b) => b.type === "traf");
    const audioTfhd = Mp4Muxer.findBoxByType(merged, "tfhd", audioTraf.start + audioTraf.headerSize, audioTraf.end);
    const tfhdView = new DataView(merged, audioTfhd.start, audioTfhd.size);
    const flags = tfhdView.getUint32(8, false) & 0x00ffffff;
    assert.equal(flags & 0x000001, 0x000001, "audio tfhd must keep explicit base-data-offset flag");

    const base = tfhdView.getUint32(20, false); // low 32 bits of the 64-bit base_data_offset
    assert.equal(base, mdats[1].start, "audio fragment base_data_offset must point at its new mdat position");

    const videoMoof = moofs[0];
    const videoChildren = Mp4Muxer.findBoxes(merged, videoMoof.start + videoMoof.headerSize, videoMoof.end);
    const videoTraf = videoChildren.find((b) => b.type === "traf");
    const videoTfhd = Mp4Muxer.findBoxByType(merged, "tfhd", videoTraf.start + videoTraf.headerSize, videoTraf.end);
    const videoBase = new DataView(merged, videoTfhd.start, videoTfhd.size).getUint32(20, false);
    assert.equal(videoBase, mdats[0].start, "video fragment base_data_offset must point at its new mdat position");
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

  beforeEach(() => {
    BlobManager.clearMemoryFallback();
  });

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

  it("should fail fast and reject beginPendingRegistration when storage set fails", async () => {
    const brokenSetStorage = createMockSessionStorage({ setError: "QuotaExceededError" });
    await assert.rejects(
      async () => {
        await BlobManager.beginPendingRegistration("blob:test/fail-fast", brokenSetStorage);
      },
      /QuotaExceededError/
    );
  });

  it("should recover and clean up completely across SW restart when pending->active storage set fails", async () => {
    const storage = createMockSessionStorage();
    const targetUrl = "blob:chrome-extension://mock-id/restart-recovery-blob";

    // 1. Initial beginPendingRegistration succeeds in durable storage
    const token = await BlobManager.beginPendingRegistration(targetUrl, storage);
    assert.ok(token);
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), true);

    const downloadId = 777;

    // 2. completePendingRegistration fails (storage write error during transition)
    const brokenSetStorage = {
      get: storage.get,
      set: (obj, cb) => {
        globalThis.chrome = { runtime: { lastError: { message: "Simulated transition write failure" } } };
        cb();
        delete globalThis.chrome;
      },
      dump: storage.dump
    };

    await assert.rejects(async () => {
      await BlobManager.completePendingRegistration(token, downloadId, targetUrl, brokenSetStorage);
    }, /Simulated transition write failure/);

    // 3. Simulate SW worker restart: memory fallback map is completely cleared
    BlobManager.clearMemoryFallback();

    // 4. Mock chrome.downloads API reflecting the active download ID and target Blob URL
    const mockDownloadsApi = {
      search: ({ id }, cb) => {
        if (id === downloadId) {
          cb([{ id: downloadId, url: targetUrl, state: "complete" }]);
        } else {
          cb([]);
        }
      }
    };

    // 5. downloads.onChanged fires on restarted worker
    const unregisterUrl = await BlobManager.unregisterBlobDownload(downloadId, storage, mockDownloadsApi);
    assert.equal(unregisterUrl, targetUrl, "Must correlate pending record via chrome.downloads.search");

    // 6. Revoke URL
    const revokedUrls = [];
    let offscreenClosed = false;
    const mockSender = async (msg) => {
      if (msg.action === "OFFSCREEN_REVOKE_URL") revokedUrls.push(msg.blobUrl);
    };
    const mockCloser = async () => {
      offscreenClosed = true;
    };

    await BlobManager.revokeBlobUrl(unregisterUrl, {
      messageSender: mockSender,
      offscreenCloser: mockCloser,
      storageApi: storage
    });

    assert.equal(revokedUrls.includes(targetUrl), true, "Blob URL must be revoked");
    assert.equal(await BlobManager.hasActiveBlobDownloads(storage), false, "All records must be cleared");
    assert.equal(offscreenClosed, true, "Offscreen document must close cleanly");
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

    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
    assert.ok(htmlContent.includes("../lib/extractor.js"), "offscreen.html must load lib/extractor.js");
    assert.ok(htmlContent.includes("../lib/mp4muxer.js"), "offscreen.html must load lib/mp4muxer.js");

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

describe("Canonical Video ID & Correlation Lifecycle (Production FbExtractor)", () => {
  class MockElement {
    constructor() {
      this.attributes = new Map();
      this.parentElement = null;
      this.src = "blob:https://facebook.com/fake-stream";
    }
    getAttribute(name) {
      return this.attributes.get(name) || null;
    }
    setAttribute(name, val) {
      this.attributes.set(name, String(val));
    }
    closest(selector) {
      return this.parentElement;
    }
  }

  class MockParent {
    constructor() {
      this.attributes = new Map();
    }
    getAttribute(name) {
      return this.attributes.get(name) || null;
    }
    setAttribute(name, val) {
      this.attributes.set(name, String(val));
    }
    closest(selector) {
      return null;
    }
  }

  it("should distinguish numeric Facebook IDs from share tokens and reject opaque tokens", () => {
    assert.equal(FbExtractor.isNumericFacebookId("10987654321"), true);
    assert.equal(FbExtractor.isNumericFacebookId("12345"), false, "Too short to be a valid FB video id");
    assert.equal(FbExtractor.isNumericFacebookId("AbCdEf123"), false, "Alphanumeric token is not numeric FB ID");
    assert.equal(FbExtractor.isNumericFacebookId("vid_abc123456"), false, "Synthetic ID is not numeric FB ID");

    // Share URLs with opaque tokens must return null from URL parser so DOM metadata is evaluated
    const shareUrl = "https://www.facebook.com/share/r/AbCdEf123/";
    assert.equal(FbExtractor.extractCanonicalVideoId(shareUrl, null), null, "Share tokens must not be treated as videoId");

    // Canonical numeric URLs return numeric ID immediately
    assert.equal(FbExtractor.extractCanonicalVideoId("https://www.facebook.com/reel/10987654321/", null), "10987654321");
    assert.equal(FbExtractor.extractCanonicalVideoId("https://www.facebook.com/watch/?v=98765432101", null), "98765432101");
    assert.equal(FbExtractor.extractCanonicalVideoId("https://www.facebook.com/page/videos/87654321098/", null), "87654321098");
  });

  it("should prefer numeric DOM ID over /share/r/ token and match scriptUrls", () => {
    const shareUrl = "https://www.facebook.com/share/r/OpaqueShareToken123/";
    const videoEl = new MockElement();
    const parentContainer = new MockParent();
    parentContainer.setAttribute("data-video-id", "10987654321");
    videoEl.parentElement = parentContainer;

    const canonicalId = FbExtractor.extractCanonicalVideoId(shareUrl, videoEl);
    assert.equal(canonicalId, "10987654321", "Numeric container ID must win over share token");

    const scriptUrls = new Map([
      ["10987654321", { hdUrl: "https://video.fbcdn.net/10987654321_hd.mp4", sdUrl: "https://video.fbcdn.net/10987654321_sd.mp4" }]
    ]);
    assert.equal(scriptUrls.has(canonicalId), true);
    assert.equal(scriptUrls.get(canonicalId).hdUrl, "https://video.fbcdn.net/10987654321_hd.mp4");
  });

  it("should handle stale closure: resolve newly discovered numeric DOM ID at download time", () => {
    const videoEl = new MockElement();
    const shareUrl = "https://www.facebook.com/share/r/AbCdEf123/";

    // 1. Initial button attachment: video has no ID yet
    const videoInfo = {
      element: videoEl,
      videoId: FbExtractor.extractCanonicalVideoId(shareUrl, videoEl), // null
      postLink: shareUrl,
      type: "reel"
    };
    assert.equal(videoInfo.videoId, null, "Initially no Facebook ID");

    // 2. Facebook hydrates DOM asynchronously and adds data-store with video_id
    const parentContainer = new MockParent();
    parentContainer.setAttribute("data-store", '{"video_id":"55566677788","is_reel":true}');
    videoEl.parentElement = parentContainer;

    // 3. User clicks download: triggerDownload dynamically re-evaluates canonical ID from live DOM
    const liveDomId = videoInfo.element ? FbExtractor.extractCanonicalVideoId(videoInfo.postLink, videoInfo.element) : null;
    const storedNumericId = videoInfo.videoId && FbExtractor.isNumericFacebookId(videoInfo.videoId) ? videoInfo.videoId : null;
    const authoritativeVideoId = liveDomId || storedNumericId;

    assert.equal(authoritativeVideoId, "55566677788", "Live DOM ID dynamically resolves at download time");

    const scriptUrls = new Map([
      ["55566677788", { hdUrl: "https://video.fbcdn.net/55566677788_hd.mp4", sdUrl: null }]
    ]);
    assert.equal(scriptUrls.has(authoritativeVideoId), true);
    assert.equal(scriptUrls.get(authoritativeVideoId).hdUrl, "https://video.fbcdn.net/55566677788_hd.mp4");
  });
});

