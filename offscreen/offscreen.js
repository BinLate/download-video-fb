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

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    throw new Error(`Không thể tải luồng video: HTTP ${videoRes.status}`);
  }
  const videoBuffer = await videoRes.arrayBuffer();

  if (!audioUrl) {
    const videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(videoBlob);
    return { success: true, blobUrl, isMuxed: false, hasAudio: false };
  }

  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error(`Không thể tải luồng âm thanh: HTTP ${audioRes.status}`);
  }
  const audioBuffer = await audioRes.arrayBuffer();

  const mergedBuffer = Mp4Muxer.mergeMp4Buffers(videoBuffer, audioBuffer);
  const mergedBlob = new Blob([mergedBuffer], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(mergedBlob);

  return { success: true, blobUrl, isMuxed: true, hasAudio: true };
}
