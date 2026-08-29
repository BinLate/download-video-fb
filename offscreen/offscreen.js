/**
 * Download Video / Reel Facebook - Offscreen Muxing Worker
 * Handles DOM-based operations: Fetching media buffers, FFmpeg WASM & ISO-BMFF Remuxing, and Blob URL management.
 * Author: Bin.Late
 */

class FFmpegClient {
  #worker = null;
  #callbacks = {};
  #rejects = {};
  #msgId = 0;
  loaded = false;

  #init() {
    if (!this.#worker) return;
    this.#worker.onmessage = ({ data: { id, type, data } }) => {
      switch (type) {
        case "LOAD":
          this.loaded = true;
          this.#callbacks[id]?.(data);
          break;
        case "EXEC":
        case "WRITE_FILE":
        case "READ_FILE":
        case "DELETE_FILE":
          this.#callbacks[id]?.(data);
          break;
        case "ERROR":
          this.#rejects[id]?.(new Error(data));
          break;
      }
      delete this.#callbacks[id];
      delete this.#rejects[id];
    };
  }

  #send({ type, data }, transfer = []) {
    if (!this.#worker) return Promise.reject(new Error("Worker not initialized"));
    return new Promise((resolve, reject) => {
      const id = this.#msgId++;
      this.#worker.postMessage({ id, type, data }, transfer);
      this.#callbacks[id] = resolve;
      this.#rejects[id] = reject;
    });
  }

  async load() {
    if (this.loaded) return true;
    if (!this.#worker) {
      const workerUrl = chrome.runtime.getURL("worker.js");
      this.#worker = new Worker(workerUrl, { type: "module" });
      this.#init();
    }
    const coreURL = chrome.runtime.getURL("js/wasm/ffmpeg-core.js");
    const wasmURL = chrome.runtime.getURL("js/wasm/ffmpeg-core.wasm");
    await this.#send({ type: "LOAD", data: { coreURL, wasmURL } });
    this.loaded = true;
    return true;
  }

  async writeFile(path, data) {
    const transfer = data instanceof Uint8Array ? [data.buffer] : [];
    return this.#send({ type: "WRITE_FILE", data: { path, data } }, transfer);
  }

  async readFile(path) {
    return this.#send({ type: "READ_FILE", data: { path, encoding: "binary" } });
  }

  async exec(args) {
    return this.#send({ type: "EXEC", data: { args, timeout: -1 } });
  }

  async deleteFile(path) {
    try {
      return await this.#send({ type: "DELETE_FILE", data: { path } });
    } catch (_) {}
  }

  terminate() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
      this.loaded = false;
    }
  }
}

let sharedFfmpeg = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "OFFSCREEN_MUX_MEDIA") {
    const { videoUrl, audioUrl } = message.payload || {};
    handleOffscreenMux(videoUrl, audioUrl)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true; // Keep channel open for async response
  }

  if (message.action === "OFFSCREEN_REVOKE_URL") {
    if (message.blobUrl && typeof message.blobUrl === "string") {
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch (_) {}
    }
    sendResponse({ success: true });
    return false;
  }
});

async function handleOffscreenMux(videoUrl, audioUrl) {
  if (!videoUrl) {
    throw new Error("Không có đường dẫn video.");
  }

  const maxBudget = FbExtractor.MAX_TOTAL_MEDIA_BUDGET || 250 * 1024 * 1024;

  if (!audioUrl) {
    return {
      success: false,
      error: "Không có đường dẫn âm thanh để ghép.",
      isMuxed: false,
      hasAudio: false,
      reason: "no_audio_url_provided",
      videoBytesLength: 0,
      audioBytesLength: 0,
      outputBytesLength: 0
    };
  }

  console.log("[Download Video FB] Offscreen mux: fetching video...");
  const muxStartTime = Date.now();

  // 1. Stream-fetch video with total budget
  let videoBuffer;
  try {
    videoBuffer = await FbExtractor.fetchWithBudget(videoUrl, maxBudget);
  } catch (err) {
    console.error("[Download Video FB] Offscreen mux: video fetch failed:", err.message);
    return {
      success: false,
      error: "Không tải được luồng video: " + err.message,
      isMuxed: false,
      hasAudio: false,
      reason: "video_fetch_failed",
      videoBytesLength: 0,
      audioBytesLength: 0,
      outputBytesLength: 0
    };
  }

  console.log(`[Download Video FB] Offscreen mux: video fetched (${videoBuffer.byteLength} bytes). Fetching audio...`);

  // 2. Stream-fetch audio with remaining combined budget
  const remainingBudget = maxBudget - videoBuffer.byteLength;
  if (remainingBudget <= 0) {
    return {
      success: false,
      error: "Dung lượng video đã chiếm trọn hạn mức bộ nhớ, không thể tải thêm âm thanh.",
      isMuxed: false,
      hasAudio: false,
      reason: "budget_exhausted",
      videoBytesLength: videoBuffer.byteLength,
      audioBytesLength: 0,
      outputBytesLength: 0
    };
  }

  let audioBuffer;
  try {
    audioBuffer = await FbExtractor.fetchWithBudget(audioUrl, remainingBudget);
  } catch (err) {
    console.error("[Download Video FB] Offscreen mux: audio fetch failed:", err.message);
    return {
      success: false,
      error: "Không tải được luồng âm thanh: " + err.message,
      isMuxed: false,
      hasAudio: false,
      reason: "audio_fetch_failed",
      videoBytesLength: videoBuffer.byteLength,
      audioBytesLength: 0,
      outputBytesLength: 0
    };
  }

  console.log(`[Download Video FB] Offscreen mux: audio fetched (${audioBuffer.byteLength} bytes). Muxing...`);

  // 3. Mux video + audio via FFmpeg WASM (lossless stream copy) with Mp4Muxer fallback
  let outBuffer = null;
  let tracks = 2;
  let format = "ffmpeg_wasm";

  try {
    if (!sharedFfmpeg) sharedFfmpeg = new FFmpegClient();
    await sharedFfmpeg.load();

    const videoBytes = new Uint8Array(videoBuffer);
    const audioBytes = new Uint8Array(audioBuffer);
    await sharedFfmpeg.writeFile("video.mp4", videoBytes);
    await sharedFfmpeg.writeFile("audio.mp4", audioBytes);

    console.log("[Download Video FB] Offscreen mux: Running FFmpeg WASM stream-copy...");
    const exitCode = await sharedFfmpeg.exec("-i video.mp4 -i audio.mp4 -map 0:v -map 1:a -c:v copy -c:a copy -y output.mp4".split(" "));
    if (exitCode === 0) {
      const readResult = await sharedFfmpeg.readFile("output.mp4");
      outBuffer = readResult.buffer || readResult;
      console.log(`[Download Video FB] Offscreen mux: FFmpeg WASM SUCCESS (${outBuffer.byteLength} bytes) in ${Date.now() - muxStartTime}ms`);
    } else {
      console.warn(`[Download Video FB] Offscreen mux: FFmpeg exit code ${exitCode}, falling back to Mp4Muxer...`);
    }
    sharedFfmpeg.deleteFile("video.mp4").catch(() => {});
    sharedFfmpeg.deleteFile("audio.mp4").catch(() => {});
    sharedFfmpeg.deleteFile("output.mp4").catch(() => {});
  } catch (ffmpegErr) {
    console.warn("[Download Video FB] FFmpeg WASM failed or unavailable:", ffmpegErr, "Falling back to Mp4Muxer...");
  }

  // Fallback to pure JS Mp4Muxer if FFmpeg WASM failed
  if (!outBuffer) {
    const muxResult = Mp4Muxer.mergeMp4Buffers(videoBuffer, audioBuffer);
    if (muxResult && muxResult.muxed) {
      outBuffer = muxResult.buffer;
      format = muxResult.format || "mp4muxer_js";
      tracks = muxResult.tracks || 2;
    } else {
      const reason = muxResult?.reason || "all_muxers_failed";
      console.warn(`[Download Video FB] Offscreen mux: FAILED (reason: ${reason}) after ${Date.now() - muxStartTime}ms`);
      return {
        success: false,
        error: "Ghép video và âm thanh thất bại: " + reason,
        isMuxed: false,
        hasAudio: false,
        reason: reason,
        videoBytesLength: videoBuffer.byteLength,
        audioBytesLength: audioBuffer.byteLength,
        outputBytesLength: 0
      };
    }
  }

  const mergedBlob = new Blob([outBuffer], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(mergedBlob);

  return {
    success: true,
    blobUrl,
    isMuxed: true,
    hasAudio: true,
    reason: null,
    videoBytesLength: videoBuffer.byteLength,
    audioBytesLength: audioBuffer.byteLength,
    outputBytesLength: outBuffer.byteLength,
    tracks: tracks,
    format: format
  };
}
