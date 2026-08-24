/**
 * Download Video / Reel Facebook - Offscreen Muxing Worker
 * Handles DOM-based operations: Fetching media buffers, ISO-BMFF Remuxing, and Blob URL management.
 * Author: Bin.Late
 */

// Max combined memory budget for video + audio streams during in-browser remuxing
const MAX_TOTAL_MEDIA_BUDGET = 250 * 1024 * 1024; // 250MB

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

/**
 * Streamed fetch with strict pre-allocation and accumulated size limits.
 */
async function fetchWithBudget(url, maxBytesAllowed) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Không thể tải dữ liệu media: HTTP ${res.status}`);
  }

  const clHeader = res.headers.get("content-length");
  if (clHeader) {
    const cl = parseInt(clHeader, 10);
    if (!isNaN(cl) && cl > maxBytesAllowed) {
      throw new Error(
        `Dung lượng stream (${Math.round(cl / (1024 * 1024))}MB) vượt quá hạn mức bộ nhớ cho phép (${Math.round(maxBytesAllowed / (1024 * 1024))}MB).`
      );
    }
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytesAllowed) {
      throw new Error(
        `Dung lượng stream (${Math.round(buf.byteLength / (1024 * 1024))}MB) vượt quá hạn mức bộ nhớ cho phép (${Math.round(maxBytesAllowed / (1024 * 1024))}MB).`
      );
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytesAllowed) {
      try {
        await reader.cancel("Size limit exceeded");
      } catch (_) {}
      throw new Error(
        `Dung lượng stream tải về vượt quá hạn mức bộ nhớ cho phép (${Math.round(maxBytesAllowed / (1024 * 1024))}MB).`
      );
    }
    chunks.push(value);
  }

  const mergedBuffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    mergedBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return mergedBuffer.buffer;
}

async function handleOffscreenMux(videoUrl, audioUrl) {
  if (!videoUrl) {
    throw new Error("Không có đường dẫn video.");
  }

  // 1. Stream-fetch video with total budget
  const videoBuffer = await fetchWithBudget(videoUrl, MAX_TOTAL_MEDIA_BUDGET);

  if (!audioUrl) {
    const videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(videoBlob);
    return { success: true, blobUrl, isMuxed: false, hasAudio: false };
  }

  // 2. Stream-fetch audio with remaining combined budget
  const remainingBudget = MAX_TOTAL_MEDIA_BUDGET - videoBuffer.byteLength;
  if (remainingBudget <= 0) {
    throw new Error("Dung lượng video đã chiếm trọn hạn mức bộ nhớ, không thể tải thêm âm thanh.");
  }
  const audioBuffer = await fetchWithBudget(audioUrl, remainingBudget);

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
