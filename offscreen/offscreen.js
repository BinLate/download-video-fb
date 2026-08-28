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

  // 1. Stream-fetch video with total budget
  const videoBuffer = await FbExtractor.fetchWithBudget(videoUrl, maxBudget);

  if (!audioUrl) {
    const videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(videoBlob);
    return { success: true, blobUrl, isMuxed: false, hasAudio: false, reason: "no_audio_url_provided" };
  }

  // 2. Stream-fetch audio with remaining combined budget
  const remainingBudget = maxBudget - videoBuffer.byteLength;
  if (remainingBudget <= 0) {
    throw new Error("Dung lượng video đã chiếm trọn hạn mức bộ nhớ, không thể tải thêm âm thanh.");
  }
  const audioBuffer = await FbExtractor.fetchWithBudget(audioUrl, remainingBudget);

  const muxResult = Mp4Muxer.mergeMp4Buffers(videoBuffer, audioBuffer);
  const outBuffer = muxResult && muxResult.buffer ? muxResult.buffer : (muxResult instanceof ArrayBuffer ? muxResult : videoBuffer);
  const isMuxed = Boolean(muxResult && muxResult.muxed);

  const mergedBlob = new Blob([outBuffer], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(mergedBlob);

  return {
    success: true,
    blobUrl,
    isMuxed: isMuxed,
    hasAudio: isMuxed,
    reason: muxResult && muxResult.reason ? muxResult.reason : null
  };
}
