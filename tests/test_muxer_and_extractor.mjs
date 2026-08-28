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

  it("should prioritize DASH manifest with audio over progressive URLs", () => {
    const manifest = String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"720\" height=\"1280\" bandwidth=\"800000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/video.mp4?oe=123<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"64000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/audio.mp4?oe=123<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`;
    const text = JSON.stringify({
      browser_native_hd_url: "https://video.xx.fbcdn.net/v/t1/progressive_hd.mp4?oe=123",
      browser_native_sd_url: "https://video.xx.fbcdn.net/v/t1/progressive_sd.mp4?oe=123",
      dash_manifest: manifest
    });
    const res = FbExtractor.extractStreamsFromText(text);
    assert.ok(res, "Result must be defined");
    assert.equal(res.isProgressive, false, "Must choose DASH over progressive when DASH has separate audio");
    assert.equal(res.isDashSeparate, true);
    assert.ok(res.audioUrl && res.audioUrl.includes("audio.mp4"));
  });

  it("should inherit mimeType and codecs from parent AdaptationSet in parseDashManifest", () => {
    const xml = `
      <MPD>
        <Period>
          <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64002a">
            <Representation id="v1" width="1080" height="1920" bandwidth="4000000">
              <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/video_hd.mp4?oe=123</BaseURL>
            </Representation>
          </AdaptationSet>
          <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
            <Representation id="a1" bandwidth="128000">
              <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/a/audio_hd.mp4?oe=123</BaseURL>
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `;
    const res = FbExtractor.parseDashManifest(xml);
    assert.ok(res);
    assert.equal(res.isDashSeparate, true, "Must recognize separate A/V tracks via inherited contentType/mimeType");
    assert.ok(res.hdUrl.includes("video_hd.mp4"));
    assert.ok(res.audioUrl.includes("audio_hd.mp4"));
  });

  it("should parse GraphQL representations array with separate video and audio streams", () => {
    const repArrayJson = JSON.stringify([
      {
        id: "rep_1080p",
        base_url: "https://video.xx.fbcdn.net/o1/v/t2/reel_1080p.mp4?oe=123",
        mime_type: "video/mp4",
        codecs: "avc1.64002a",
        width: 1080,
        height: 1920,
        bandwidth: 3500000,
        quality_label: "1080p"
      },
      {
        id: "rep_720p",
        base_url: "https://video.xx.fbcdn.net/o1/v/t2/reel_720p.mp4?oe=123",
        mime_type: "video/mp4",
        codecs: "avc1.4d401f",
        width: 720,
        height: 1280,
        bandwidth: 1500000,
        quality_label: "720p"
      },
      {
        id: "rep_audio",
        base_url: "https://video.xx.fbcdn.net/o1/a/t2/reel_audio.mp4?oe=123",
        mime_type: "audio/mp4",
        codecs: "mp4a.40.2",
        bandwidth: 128000,
        quality_label: "AUDIO"
      }
    ]);

    const res = FbExtractor.parseRepresentationsArray(repArrayJson);
    assert.ok(res, "GraphQL representations must be parsed");
    assert.equal(res.videos.length, 2, "Must extract 2 video streams");
    assert.equal(res.audios.length, 1, "Must extract 1 audio stream");
    assert.equal(res.isDashSeparate, true, "Must flag as separate A/V streams");
    assert.ok(res.hdUrl.includes("reel_1080p.mp4"), "HD must be 1080p");
    assert.ok(res.sdUrl.includes("reel_720p.mp4"), "SD must be 720p");
    assert.ok(res.audioUrl.includes("reel_audio.mp4"), "Audio URL must be extracted");
  });

  it("should extract GraphQL representations and audio stream from raw script text", () => {
    const rawText = JSON.stringify({
      video_id: "9876543210123",
      representations: [
        {
          id: "v1",
          base_url: "https://video.xx.fbcdn.net/v/reel_hd.mp4?oe=456",
          mime_type: "video/mp4",
          codecs: "avc1.64002a",
          width: 1080,
          height: 1920,
          bandwidth: 2500000
        },
        {
          id: "a1",
          base_url: "https://video.xx.fbcdn.net/a/reel_audio.mp4?oe=456",
          mime_type: "audio/mp4",
          codecs: "mp4a.40.2",
          bandwidth: 128000
        }
      ]
    });

    const res = FbExtractor.extractStreamsFromText(rawText);
    assert.ok(res, "Streams must be extracted from raw text with representations");
    assert.equal(res.isDashSeparate, true, "Must be DASH separate");
    assert.ok(res.hdUrl.includes("reel_hd.mp4"));
    assert.ok(res.audioUrl.includes("reel_audio.mp4"));
  });

  it("should merge GraphQL audio representation when DASH manifest contains only video", () => {
    const videoOnlyDash = String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v_dash\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/dash_video.mp4?oe=789<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`;
    const rawPayload = JSON.stringify({
      video_id: "112233445566",
      dash_manifest: videoOnlyDash,
      representations: [
        {
          id: "audio_rep",
          base_url: "https://video-sin6-4.xx.fbcdn.net/o1/a/graphql_audio.mp4?oe=789",
          mime_type: "audio/mp4",
          codecs: "mp4a.40.2",
          bandwidth: 128000,
          quality_label: "AUDIO"
        }
      ]
    });

    const res = FbExtractor.extractStreamsFromText(rawPayload);
    assert.ok(res, "Result must be extracted");
    assert.equal(res.isDashSeparate, true, "Must be DASH separate with merged audio");
    assert.ok(res.hdUrl.includes("dash_video.mp4"), "DASH video URL must be preserved");
    assert.ok(res.audioUrl.includes("graphql_audio.mp4"), "GraphQL audio URL must be merged");
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

  it("should correctly isolate distinct video streams from multi-video payloads", () => {
    const video1Payload = JSON.stringify({
      id: "10001",
      dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/video1_hd.mp4?oe=111<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/audio1.mp4?oe=111<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
    });

    const video2Payload = JSON.stringify({
      id: "20002",
      dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v2\" mimeType=\"video/mp4\" width=\"720\" height=\"1280\" bandwidth=\"1500000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/video2_sd.mp4?oe=222<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a2\" mimeType=\"audio/mp4\" bandwidth=\"96000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/audio2.mp4?oe=222<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
    });

    const res1 = FbExtractor.extractStreamsFromText(video1Payload);
    const res2 = FbExtractor.extractStreamsFromText(video2Payload);

    assert.ok(res1, "Video 1 must be extracted");
    assert.ok(res2, "Video 2 must be extracted");
    assert.ok(res1.hdUrl.includes("video1_hd.mp4"), "Video 1 must have video1 stream");
    assert.ok(res1.audioUrl.includes("audio1.mp4"), "Video 1 must have audio1 stream");
    assert.ok(res2.hdUrl.includes("video2_sd.mp4"), "Video 2 must have video2 stream");
    assert.ok(res2.audioUrl.includes("audio2.mp4"), "Video 2 must have audio2 stream");

    // Strict non-contamination
    assert.ok(!res1.hdUrl.includes("video2"), "Video 1 must not contain Video 2 URL");
    assert.ok(!res2.hdUrl.includes("video1"), "Video 2 must not contain Video 1 URL");
  });

  it("should extract streams from nested script payloads where id is on outer object and stream is on inner object", () => {
    const nestedScript = JSON.stringify({
      id: "98765432101",
      __typename: "Video",
      video: {
        dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/nested_hd.mp4?oe=333<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/nested_audio.mp4?oe=333<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
      }
    });

    const map = FbExtractor.extractUrlsFromScriptText(nestedScript);
    assert.ok(map.has("98765432101"), "Must extract outer ID 98765432101");
    const stream = map.get("98765432101");
    assert.ok(stream.hdUrl.includes("nested_hd.mp4"), "Must extract inner DASH video URL");
    assert.ok(stream.audioUrl.includes("nested_audio.mp4"), "Must extract inner DASH audio URL");
    assert.equal(stream.isDashSeparate, true);
  });

  it("should isolate multiple nested video objects within a single large script payload", () => {
    const combinedScript = JSON.stringify({
      feed_units: [
        {
          id: "post_comment_id_111",
          author: { id: "user_id_222" },
          story_video: {
            id: "30000000001",
            playback_video_dash_xml: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/feed_video1.mp4?oe=444<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/feed_audio1.mp4?oe=444<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
          }
        },
        {
          id: "post_comment_id_333",
          author: { id: "user_id_444" },
          story_video: {
            id: "30000000002",
            representations: [
              {
                id: "v2",
                base_url: "https://video-sin6-4.xx.fbcdn.net/o1/v/feed_video2.mp4?oe=555",
                mime_type: "video/mp4",
                codecs: "avc1.64002a",
                width: 720,
                height: 1280,
                bandwidth: 1500000
              },
              {
                id: "a2",
                base_url: "https://video-sin6-4.xx.fbcdn.net/o1/a/feed_audio2.mp4?oe=555",
                mime_type: "audio/mp4",
                codecs: "mp4a.40.2",
                bandwidth: 96000
              }
            ]
          }
        }
      ]
    });

    const map = FbExtractor.extractUrlsFromScriptText(combinedScript);
    assert.ok(map.has("30000000001"), "Must extract video 1 ID");
    assert.ok(map.has("30000000002"), "Must extract video 2 ID");

    const v1 = map.get("30000000001");
    const v2 = map.get("30000000002");

    assert.ok(v1.hdUrl.includes("feed_video1.mp4"), "Video 1 must have feed_video1");
    assert.ok(v1.audioUrl.includes("feed_audio1.mp4"), "Video 1 must have feed_audio1");

    assert.ok(v2.sdUrl.includes("feed_video2.mp4") || v2.hdUrl.includes("feed_video2.mp4"), "Video 2 must have feed_video2");
    assert.ok(v2.audioUrl.includes("feed_audio2.mp4"), "Video 2 must have feed_audio2");

    // Ensure non-numeric or unrelated comment IDs were NOT mapped as video IDs
    assert.equal(map.has("post_comment_id_111"), false, "Comment ID must not be mapped as video");
  });

  it("should extract stream when ID is separated from nested stream by more than 4KB of metadata", () => {
    const largePadding = "x".repeat(6000);
    const largeScript = JSON.stringify({
      id: "778899001122",
      __typename: "Video",
      filler_metadata: largePadding,
      video: {
        dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/large_gap_hd.mp4?oe=999<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/large_gap_audio.mp4?oe=999<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
      }
    });

    const map = FbExtractor.extractUrlsFromScriptText(largeScript);
    assert.ok(map.has("778899001122"), "Must extract ID separated by >4KB metadata");
    const stream = map.get("778899001122");
    assert.ok(stream.hdUrl.includes("large_gap_hd.mp4"));
    assert.ok(stream.audioUrl.includes("large_gap_audio.mp4"));
  });

  it("should perform linear single-pass parsing efficiently under large multi-video payload stress test", () => {
    const items = [];
    for (let i = 1; i <= 50; i++) {
      items.push({
        id: `post_comment_${i}`,
        author: { id: `author_${i}` },
        video: {
          id: `50000000000${i}`,
          dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/stress_${i}.mp4?oe=888<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/audio_${i}.mp4?oe=888<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
        },
        padding: "p".repeat(2000)
      });
    }

    const largeScript = JSON.stringify({ feed_stream: items });
    const startTime = Date.now();
    const map = FbExtractor.extractUrlsFromScriptText(largeScript);
    const duration = Date.now() - startTime;

    assert.equal(map.size, 50, "Must extract all 50 distinct video IDs");
    assert.ok(duration < 100, `Parsing 50 videos in 100KB payload must complete in <100ms (took ${duration}ms)`);
    assert.ok(map.get("500000000001").hdUrl.includes("stress_1.mp4"));
    assert.ok(map.get("5000000000050").hdUrl.includes("stress_50.mp4"));
  });

  it("should strictly prevent mapping video streams to numeric parent or ancestor IDs", () => {
    const scriptWithNumericParentId = JSON.stringify({
      id: "1111222233334444", // Numeric User or Post container ID
      user_name: "Facebook User",
      story_video: {
        id: "5555666677778888", // Authoritative Video ID
        __typename: "Video",
        dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/non_contam_hd.mp4?oe=777<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/non_contam_audio.mp4?oe=777<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
      }
    });

    const map = FbExtractor.extractUrlsFromScriptText(scriptWithNumericParentId);
    assert.ok(map.has("5555666677778888"), "Must associate stream with video ID");
    assert.equal(map.has("1111222233334444"), false, "Numeric parent ID must NOT be contaminated with video stream");
  });

  it("should scale linearly O(N) when parsing deeply nested large JSON script payloads", () => {
    function buildNestedPayload(depth) {
      let current = {
        video: {
          id: "999988887777",
          __typename: "Video",
          dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/depth.mp4?oe=1<\/BaseURL><\/Representation><\/AdaptationSet><AdaptationSet contentType=\"audio\"><Representation id=\"a1\" mimeType=\"audio/mp4\" bandwidth=\"128000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/a\/depth_audio.mp4?oe=1<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
        }
      };
      for (let i = 0; i < depth; i++) {
        current = {
          id: `parent_level_${i}`,
          data: "d".repeat(100),
          nested: current
        };
      }
      return JSON.stringify(current);
    }

    const payloadSmall = buildNestedPayload(50);
    const payloadLarge = buildNestedPayload(200);

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) FbExtractor.extractUrlsFromScriptText(payloadSmall);
    const durationSmall = (Date.now() - t0) / 5;

    const t1 = Date.now();
    for (let i = 0; i < 5; i++) FbExtractor.extractUrlsFromScriptText(payloadLarge);
    const durationLarge = (Date.now() - t1) / 5;

    // Linear scaling: 4x payload increase should not cause quadratic slowdown
    assert.ok(durationLarge < Math.max(durationSmall * 10, 50), `Large payload (${durationLarge}ms) scaled linearly vs Small (${durationSmall}ms)`);
  });

  it("should not map numeric container ID when nested child video node lacks its own ID", () => {
    const containerWithChildStreamNoId = JSON.stringify({
      container: {
        id: "1111222233334444",
        story_video: {
          dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/anonymous_stream.mp4?oe=111<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
        }
      }
    });

    const map = FbExtractor.extractUrlsFromScriptText(containerWithChildStreamNoId);
    assert.equal(map.has("1111222233334444"), false, "Container ID must NOT receive stream from anonymous child video node");
  });

  it("should not map numeric generic node ID when nested descendant video lacks its own ID", () => {
    const genericNodeWithDescendantStream = JSON.stringify({
      node: {
        id: "1111222233334444",
        attachments: {
          story_video: {
            dash_manifest: String.raw`<MPD><Period><AdaptationSet contentType=\"video\"><Representation id=\"v1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3000000\"><BaseURL>https:\/\/video-sin6-4.xx.fbcdn.net\/o1\/v\/descendant_video.mp4?oe=222<\/BaseURL><\/Representation><\/AdaptationSet><\/Period><\/MPD>`
          }
        }
      }
    });

    const map = FbExtractor.extractUrlsFromScriptText(genericNodeWithDescendantStream);
    assert.equal(map.has("1111222233334444"), false, "Generic node ID must NOT receive stream from anonymous descendant story_video");
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

// =============================================================================
// Download Decision / Mux Flow Tests (v1.2.1)
// =============================================================================
describe("Download Decision & Mux Flow (v1.2.1)", () => {

  // ---------- Test 1: Progressive MP4 with audio ----------
  it("T1: extractStreamsFromText returns progressiveHdUrl for progressive MP4", () => {
    const text = `{"browser_native_hd_url":"https://video-sin6-4.xx.fbcdn.net/hd_prog.mp4?oe=ABC","browser_native_sd_url":"https://video-sin6-4.xx.fbcdn.net/sd_prog.mp4?oe=DEF"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse progressive URLs");
    assert.ok(result.isProgressive, "Should be marked progressive");
    assert.ok(result.hdUrl.includes("hd_prog.mp4"), "HD URL correct");
    assert.ok(result.sdUrl.includes("sd_prog.mp4"), "SD URL correct");
    assert.equal(result.audioUrl, null, "Progressive has no separate audio URL");
    assert.ok(result.progressiveHdUrl.includes("hd_prog.mp4"), "progressiveHdUrl populated");
    assert.ok(result.progressiveSdUrl.includes("sd_prog.mp4"), "progressiveSdUrl populated");
  });

  // ---------- Test 2: DASH video-only + DASH audio ----------
  it("T2: extractStreamsFromText returns both video and audio from DASH manifest", () => {
    const dashXml = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000" codecs="avc1.64002a"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dash_video.mp4?oe=X</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dash_audio.mp4?oe=Y</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text = `{"dash_manifest":"${dashXml.replace(/"/g, '\\"')}"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse DASH manifest");
    assert.equal(result.isProgressive, false, "DASH is not progressive");
    assert.ok(result.isDashSeparate, "DASH has separate audio");
    assert.ok(result.hdUrl.includes("dash_video.mp4"), "Video URL from DASH");
    assert.ok(result.audioUrl.includes("dash_audio.mp4"), "Audio URL from DASH");
  });

  // ---------- Test 3: Multiple FB videos — audio matched to correct videoId ----------
  it("T3: extractUrlsFromScriptText matches audio to correct video across multiple videos", () => {
    const script = `{
      "video_id": "111111111111",
      "dash_manifest": "<MPD><Period><AdaptationSet contentType=\\"video\\"><Representation mimeType=\\"video/mp4\\" width=\\"1080\\" height=\\"1920\\" bandwidth=\\"4000000\\"><BaseURL>https://video-sin6-4.xx.fbcdn.net/v1_video.mp4?oe=A</BaseURL></Representation></AdaptationSet><AdaptationSet contentType=\\"audio\\"><Representation mimeType=\\"audio/mp4\\" bandwidth=\\"128000\\"><BaseURL>https://video-sin6-4.xx.fbcdn.net/v1_audio.mp4?oe=B</BaseURL></Representation></AdaptationSet></Period></MPD>"
    }
    {
      "video_id": "222222222222",
      "dash_manifest": "<MPD><Period><AdaptationSet contentType=\\"video\\"><Representation mimeType=\\"video/mp4\\" width=\\"720\\" height=\\"1280\\" bandwidth=\\"2000000\\"><BaseURL>https://video-sin6-4.xx.fbcdn.net/v2_video.mp4?oe=C</BaseURL></Representation></AdaptationSet><AdaptationSet contentType=\\"audio\\"><Representation mimeType=\\"audio/mp4\\" bandwidth=\\"96000\\"><BaseURL>https://video-sin6-4.xx.fbcdn.net/v2_audio.mp4?oe=D</BaseURL></Representation></AdaptationSet></Period></MPD>"
    }`;
    const urlsMap = FbExtractor.extractUrlsFromScriptText(script);
    assert.ok(urlsMap.has("111111111111"), "Video 1 found");
    assert.ok(urlsMap.has("222222222222"), "Video 2 found");
    assert.ok(urlsMap.get("111111111111").audioUrl.includes("v1_audio"), "Video 1 gets its own audio");
    assert.ok(urlsMap.get("222222222222").audioUrl.includes("v2_audio"), "Video 2 gets its own audio");
    // Cross-contamination check
    assert.ok(!urlsMap.get("111111111111").audioUrl.includes("v2_audio"), "No cross-contamination V1→V2");
    assert.ok(!urlsMap.get("222222222222").audioUrl.includes("v1_audio"), "No cross-contamination V2→V1");
  });

  // ---------- Test 4: Video available, audio missing ----------
  it("T4: extractStreamsFromText returns audioUrl:null when DASH has no audio AdaptationSet", () => {
    const dashXml = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/video_only.mp4?oe=X</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text = `{"dash_manifest":"${dashXml.replace(/"/g, '\\"')}"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse video-only DASH");
    assert.ok(result.hdUrl.includes("video_only.mp4"), "Video URL present");
    assert.equal(result.audioUrl, null, "No audio URL when DASH lacks audio");
    assert.equal(result.isDashSeparate, false, "Not dash separate without audio");
  });

  // ---------- Test 5: Muxer — plain video + plain audio → merged has 2 traks ----------
  it("T5: mergeMp4Buffers produces a muxed file with 2 tracks for plain MP4 inputs", () => {
    const videoBuffer = createSampleMp4(1, false, [0x00, 0x01, 0x02, 0x03]);
    const audioBuffer = createSampleMp4(1, true, [0x10, 0x11, 0x12, 0x13]);
    const result = Mp4Muxer.mergeMp4Buffers(videoBuffer, audioBuffer);
    assert.ok(result, "Result exists");
    assert.equal(result.muxed, true, "Muxing succeeded");
    assert.equal(result.tracks, 2, "Output has 2 tracks");
    assert.equal(result.format, "plain", "Format is plain");
    assert.ok(result.buffer.byteLength > videoBuffer.byteLength, "Output is larger than video alone");
  });

  // ---------- Test 6: Muxer — fMP4 video + fMP4 audio → merged has fragments for both ----------
  it("T6: mergeMp4Buffers produces muxed fMP4 with fragments for both tracks", () => {
    const videoFmp4 = createFragmentedMp4(1, [[0xAA, 0xBB]], { baseOffsetMode: "moof" });
    const audioFmp4 = createFragmentedMp4(1, [[0xCC, 0xDD]], { baseOffsetMode: "moof" });
    const result = Mp4Muxer.mergeMp4Buffers(videoFmp4, audioFmp4);
    assert.ok(result, "Result exists");
    assert.equal(result.muxed, true, "fMP4 muxing succeeded");
    assert.equal(result.format, "fragmented", "Format is fragmented");
    // Verify both moof boxes exist in output
    const boxes = Mp4Muxer.findBoxes(result.buffer);
    const moofBoxes = boxes.filter(b => b.type === "moof");
    assert.ok(moofBoxes.length >= 2, `Should have at least 2 moof boxes, got ${moofBoxes.length}`);
  });

  // ---------- Test 7: Muxer — no audio buffer → returns muxed:false ----------
  it("T7: mergeMp4Buffers returns muxed:false with reason when audio buffer is missing", () => {
    const videoBuffer = createSampleMp4(1, false);
    const result = Mp4Muxer.mergeMp4Buffers(videoBuffer, null);
    assert.ok(result, "Result exists");
    assert.equal(result.muxed, false, "Muxing did NOT succeed");
    assert.equal(result.reason, "missing_audio_buffer", "Reason is missing_audio_buffer");
  });

  // ---------- Test 8: Muxer — mixed fMP4/plain → returns muxed:false ----------
  it("T8: mergeMp4Buffers returns muxed:false when one input is fMP4 and other is plain", () => {
    const plainVideo = createSampleMp4(1, false);
    const fmp4Audio = createFragmentedMp4(1, [[0xCC, 0xDD]], { baseOffsetMode: "moof" });
    const result = Mp4Muxer.mergeMp4Buffers(plainVideo, fmp4Audio);
    assert.ok(result, "Result exists");
    assert.equal(result.muxed, false, "Mixed format muxing failed");
    assert.ok(result.reason, "Has a failure reason");
  });

  // ---------- Test 9: Fallback — DASH without audio + progressive available ----------
  it("T9: extractStreamsFromText preserves progressive URLs when DASH has no audio", () => {
    const dashXml = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dash_video.mp4?oe=X</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text = `{"browser_native_hd_url":"https://video-sin6-4.xx.fbcdn.net/prog_hd.mp4?oe=P","browser_native_sd_url":"https://video-sin6-4.xx.fbcdn.net/prog_sd.mp4?oe=Q","dash_manifest":"${dashXml.replace(/"/g, '\\"')}"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse");
    // Since DASH has no audio, progressive should be preferred
    assert.ok(result.isProgressive, "Progressive preferred when DASH has no audio");
    assert.ok(result.hdUrl.includes("prog_hd.mp4"), "HD URL is progressive");
    assert.ok(result.progressiveHdUrl.includes("prog_hd.mp4"), "progressiveHdUrl preserved");
    assert.ok(result.progressiveSdUrl.includes("prog_sd.mp4"), "progressiveSdUrl preserved");
  });

  // ---------- Test 10: DASH with audio + progressive available → progressive preserved for fallback ----------
  it("T10: extractStreamsFromText returns DASH as primary but preserves progressive for fallback", () => {
    const dashXml = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dash_v.mp4?oe=X</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="128000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dash_a.mp4?oe=Y</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text = `{"browser_native_hd_url":"https://video-sin6-4.xx.fbcdn.net/fallback_prog.mp4?oe=F","dash_manifest":"${dashXml.replace(/"/g, '\\"')}"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse");
    // DASH with audio takes priority
    assert.equal(result.isProgressive, false, "DASH is primary when it has audio");
    assert.ok(result.hdUrl.includes("dash_v.mp4"), "Primary URL is DASH video");
    assert.ok(result.audioUrl.includes("dash_a.mp4"), "Audio URL is DASH audio");
    // But progressive is preserved for fallback
    assert.ok(result.progressiveHdUrl.includes("fallback_prog.mp4"), "Progressive HD URL preserved as fallback");
  });

  // ---------- Test 11: Genuinely silent source — no audio in any source ----------
  it("T11: Video with no audio anywhere returns null audioUrl and no progressive", () => {
    const dashXml = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="360" height="640" bandwidth="500000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/silent_dash.mp4?oe=Z</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text = `{"dash_manifest":"${dashXml.replace(/"/g, '\\"')}"}`;
    const result = FbExtractor.extractStreamsFromText(text);
    assert.ok(result, "Should parse");
    assert.equal(result.audioUrl, null, "No audio URL");
    assert.equal(result.progressiveHdUrl, null, "No progressive HD fallback");
    assert.equal(result.progressiveSdUrl, null, "No progressive SD fallback");
    assert.equal(result.isDash, true, "DASH video-only is still flagged as isDash");
    // This is a genuinely silent source — downloading video-only is correct
  });

  // ---------- Test 12: isDash flag is true for DASH-origin streams (with or without audio) ----------
  it("T12: isDash is true for DASH streams regardless of audio presence", () => {
    // DASH with audio
    const dashWithAudio = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dv.mp4?oe=X</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="128000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/da.mp4?oe=Y</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text1 = `{"dash_manifest":"${dashWithAudio.replace(/"/g, '\\"')}"}`;
    const r1 = FbExtractor.extractStreamsFromText(text1);
    assert.equal(r1.isDash, true, "DASH with audio: isDash should be true");
    assert.ok(r1.audioUrl, "DASH with audio: audioUrl should be present");

    // DASH without audio
    const dashNoAudio = `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="720" height="1280" bandwidth="2000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/dv_only.mp4?oe=Z</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const text2 = `{"dash_manifest":"${dashNoAudio.replace(/"/g, '\\"')}"}`;
    const r2 = FbExtractor.extractStreamsFromText(text2);
    assert.equal(r2.isDash, true, "DASH without audio: isDash should be true");
    assert.equal(r2.audioUrl, null, "DASH without audio: audioUrl should be null");
  });

  // ---------- Test 13: isDash flag is false for progressive and generic streams ----------
  it("T13: isDash is false for progressive and generic MP4 streams", () => {
    // Progressive
    const text1 = `{"browser_native_hd_url":"https://video-sin6-4.xx.fbcdn.net/prog.mp4?oe=P"}`;
    const r1 = FbExtractor.extractStreamsFromText(text1);
    assert.equal(r1.isDash, false, "Progressive: isDash should be false");
    assert.equal(r1.isProgressive, true, "Progressive: isProgressive should be true");

    // Generic MP4
    const text2 = `here is a video https://video-sin6-4.xx.fbcdn.net/generic.mp4?oe=G end`;
    const r2 = FbExtractor.extractStreamsFromText(text2);
    assert.equal(r2.isDash, false, "Generic: isDash should be false");
    assert.equal(r2.isProgressive, true, "Generic: isProgressive should be true");
  });

  // ---------- Test 14: Direct id matching on stream-bearing JSON object ----------
  it("T14: extractUrlsFromScriptText extracts video and audio when id and dash_manifest are directly on the object", () => {
    const raw = JSON.stringify({
      short_form_video_context: {
        id: "998877665544",
        dash_manifest: `<MPD><Period><AdaptationSet contentType="video"><Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="4000000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/v_direct.mp4?oe=X</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="128000"><BaseURL>https://video-sin6-4.xx.fbcdn.net/a_direct.mp4?oe=Y</BaseURL></Representation></AdaptationSet></Period></MPD>`
      }
    });
    const map = FbExtractor.extractUrlsFromScriptText(raw);
    assert.equal(map.has("998877665544"), true, "Should extract object with direct ID and manifest");
    const stream = map.get("998877665544");
    assert.ok(stream.hdUrl.includes("v_direct.mp4"), "HD URL matches");
    assert.ok(stream.audioUrl.includes("a_direct.mp4"), "Audio URL matches");
    assert.equal(stream.isDashSeparate, true, "Is DASH separate");
  });

  // ---------- Test 15: isDedicatedSingleVideoPage URL classification ----------
  it("T15: isDedicatedSingleVideoPage correctly identifies dedicated single-video URLs vs multi-video feeds", () => {
    // True cases (Dedicated Single Video)
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/reel/123456789012", ""), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/reels/123456789012/", ""), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/share/r/abc123XYZ/", ""), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/videos/123456789012/", ""), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch/", "?v=123456789012"), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch", "?ref=search&v=123456789012"), true);
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch", "?v=123456789012&ref=foo"), true);

    // False cases (Generic Multi-Video Feeds / Malformed IDs)
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch", "?v=123456789abc"), false, "Malformed non-numeric ?v= must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch", ""), false, "Generic /watch without ?v= must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/watch/", ""), false, "Generic /watch/ without ?v= must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/reels", ""), false, "Generic /reels feed must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/reels/", ""), false, "Generic /reels/ feed must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/reel", ""), false, "Generic /reel feed must be false");
    assert.equal(FbExtractor.isDedicatedSingleVideoPage("/", ""), false, "Home feed must be false");
  });

  // ---------- Test 16: Paired progressive video + separate audio_stream_url ----------
  it("T16: extractStreamsFromText extracts paired audioUrl and flags DASH muxing when browser_native_hd_url and audio_stream_url coexist", () => {
    const raw = JSON.stringify({
      browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/v_prog_dash.mp4?oe=11",
      audio_stream_url: "https://video-sin6-4.xx.fbcdn.net/a_prog_dash.mp4?oe=22"
    });
    const result = FbExtractor.extractStreamsFromText(raw);
    assert.ok(result, "Should parse stream info");
    assert.ok(result.hdUrl.includes("v_prog_dash.mp4"), "HD URL is present");
    assert.ok(result.audioUrl.includes("a_prog_dash.mp4"), "Audio URL is paired");
    assert.equal(result.isDashSeparate, true, "isDashSeparate is true");
    assert.equal(result.isDash, true, "isDash is true");
    assert.equal(result.isProgressive, false, "isProgressive is false (needs muxing)");
  });

  // ---------- Test 17: Parent video URL + nested child's audio URL must NOT pair ----------
  it("T17: Parent video URL must not consume nested child's audio URL", () => {
    const raw = JSON.stringify({
      id: "111111111111",
      browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/parent_video.mp4?oe=1",
      related_media: {
        id: "222222222222",
        audio_stream_url: "https://video-sin6-4.xx.fbcdn.net/child_audio.mp4?oe=2"
      }
    });
    const map = FbExtractor.extractUrlsFromScriptText(raw);
    assert.equal(map.has("111111111111"), true, "Parent video should be extracted");
    const parentStream = map.get("111111111111");
    assert.ok(parentStream.hdUrl.includes("parent_video.mp4"), "Parent has its video URL");
    assert.equal(parentStream.audioUrl, null, "Parent must NOT consume child's audio URL");
    assert.equal(parentStream.isProgressive, true, "Parent video remains progressive when child has audio");
  });

  // ---------- Test 18: Nested video object with its own video+audio gets its own pair ----------
  it("T18: Nested video object with video+audio pairs correctly and is not stolen by parent", () => {
    const raw = JSON.stringify({
      id: "333333333333",
      browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/outer_video.mp4?oe=3",
      nested_video: {
        id: "444444444444",
        browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/inner_video.mp4?oe=4",
        audio_stream_url: "https://video-sin6-4.xx.fbcdn.net/inner_audio.mp4?oe=5"
      }
    });
    const map = FbExtractor.extractUrlsFromScriptText(raw);
    assert.equal(map.has("444444444444"), true, "Nested video node should be extracted");
    const childStream = map.get("444444444444");
    assert.ok(childStream.hdUrl.includes("inner_video.mp4"), "Child has its own video");
    assert.ok(childStream.audioUrl.includes("inner_audio.mp4"), "Child pairs its own audio");
    assert.equal(childStream.isDashSeparate, true, "Child is DASH separate");

    const parentStream = map.get("333333333333");
    assert.ok(parentStream.hdUrl.includes("outer_video.mp4"), "Parent has its own video");
    assert.equal(parentStream.audioUrl, null, "Parent does NOT steal child's audio");
  });

  // ---------- Test 19: Two sibling media objects do not cross-pair ----------
  it("T19: Sibling media objects do not cross-pair streams", () => {
    const raw = JSON.stringify({
      feed: [
        {
          id: "555555555555",
          browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/sibling1_video.mp4?oe=6",
          audio_stream_url: "https://video-sin6-4.xx.fbcdn.net/sibling1_audio.mp4?oe=7"
        },
        {
          id: "666666666666",
          browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/sibling2_video.mp4?oe=8"
        }
      ]
    });
    const map = FbExtractor.extractUrlsFromScriptText(raw);
    assert.equal(map.has("555555555555"), true);
    assert.equal(map.has("666666666666"), true);
    const s1 = map.get("555555555555");
    const s2 = map.get("666666666666");
    assert.ok(s1.audioUrl.includes("sibling1_audio.mp4"), "Sibling 1 has its own audio");
    assert.equal(s2.audioUrl, null, "Sibling 2 must NOT receive Sibling 1's audio");
  });

  // ---------- Test 20: Recognized parent with ID but no direct streams receives NO stream from nested child ----------
  it("T20: Recognized parent video container with ID but no direct streams receives NO stream from nested child", () => {
    const raw = JSON.stringify({
      video: {
        id: "777777777777",
        related_media: {
          browser_native_hd_url: "https://video-sin6-4.xx.fbcdn.net/child_video.mp4?oe=9",
          audio_stream_url: "https://video-sin6-4.xx.fbcdn.net/child_audio.mp4?oe=10"
        }
      }
    });
    const map = FbExtractor.extractUrlsFromScriptText(raw);
    assert.equal(map.has("777777777777"), false, "Parent video container must NOT receive streams from nested child without direct streams");
  });
});
