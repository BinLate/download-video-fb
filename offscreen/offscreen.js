/**
 * Download Video / Reel Facebook - Offscreen Muxing Worker
 * Handles DOM-based operations: Fetching media buffers, ISO-BMFF Remuxing, and Blob URL management.
 * Author: Bin.Late
 */

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

  // If no audioUrl provided, signal failure immediately so caller can use fallback
  // instead of creating a useless video-only Blob.
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

  // 3. Mux video + audio
  const muxResult = Mp4Muxer.mergeMp4Buffers(videoBuffer, audioBuffer);
  const isMuxed = Boolean(muxResult && muxResult.muxed);

  if (!isMuxed) {
    // Muxing failed — return failure with details so caller can use fallback
    const reason = (muxResult && muxResult.reason) ? muxResult.reason : "mux_unknown_error";
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

  const outBuffer = muxResult.buffer;
  const mergedBlob = new Blob([outBuffer], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(mergedBlob);

  console.log(`[Download Video FB] Offscreen mux: SUCCESS (${outBuffer.byteLength} bytes, ${muxResult.tracks} tracks, ${muxResult.format}) in ${Date.now() - muxStartTime}ms`);

  return {
    success: true,
    blobUrl,
    isMuxed: true,
    hasAudio: true,
    reason: null,
    videoBytesLength: videoBuffer.byteLength,
    audioBytesLength: audioBuffer.byteLength,
    outputBytesLength: outBuffer.byteLength,
    tracks: muxResult.tracks,
    format: muxResult.format
  };
}
