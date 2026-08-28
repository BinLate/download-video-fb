/**
 * Download Video / Reel Facebook - Background Service Worker
 * Author: Bin.Late
 */

importScripts("lib/extractor.js", "lib/mp4muxer.js", "lib/blob_manager.js");

const tabVideosMap = new Map();
// tabId -> { sessionId, armedAt, list: [{url, videoTyped, ts, session}] }
// Captures are ONLY recorded while an extraction session is armed for the tab,
// so autoplay/feed/previous-page media can never contaminate a later result.
const tabMediaMap = new Map();
const MEDIA_URL_FILTER = ["*://*.fbcdn.net/*", "*://*.fbsbx.com/*"];
const MAX_CAPTURED_PER_TAB = 12;
const MAX_CAPTURE_AGE_MS = 5 * 60 * 1000;
let captureSessionSeq = 0;
let networkCaptureAvailable = true;
let networkCaptureReason = "";

// ---------------------------------------------------------------------------
// MV3 service worker storage hydration & persistence
// ---------------------------------------------------------------------------
let storageHydration = null;
const hydrationInvalidatedTabs = new Set();
function markTabInvalidated(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  if (storageHydration) hydrationInvalidatedTabs.add(id);
}
function persistMaps() {
  try {
    if (!chrome.storage?.session) return Promise.resolve();
    const payload = {
      binlate_tabMediaMap: Array.from(tabMediaMap.entries()),
      binlate_tabVideosMap: Array.from(tabVideosMap.entries()),
      binlate_sessionSeq: captureSessionSeq,
    };
    persistMaps._chain = (persistMaps._chain || Promise.resolve()).then(
      () => new Promise((resolve) => {
        try {
          chrome.storage.session.set(payload, () => resolve());
        } catch (_) { resolve(); }
      })
    );
    return persistMaps._chain;
  } catch (_) {
    return Promise.resolve();
  }
}
function hydrateFromSessionStorage() {
  if (storageHydration) return storageHydration;
  storageHydration = new Promise((resolve) => {
    const ready = persistMaps._chain || Promise.resolve();
    ready.then(() => {
      try {
        if (!chrome.storage?.session) return resolve();
        chrome.storage.session.get(
          ["binlate_tabMediaMap", "binlate_tabVideosMap", "binlate_sessionSeq"],
          (data) => {
            try {
              if (chrome.runtime.lastError) return resolve();
              if (Array.isArray(data.binlate_tabMediaMap)) {
                for (const [k, v] of data.binlate_tabMediaMap) {
                  const id = Number(k);
                  if (tabMediaMap.has(id) || hydrationInvalidatedTabs.has(id)) continue;
                  tabMediaMap.set(id, v);
                }
              }
              if (tabVideosMap.size === 0 && Array.isArray(data.binlate_tabVideosMap)) {
                for (const [k, v] of data.binlate_tabVideosMap) {
                  const id = Number(k);
                  if (tabVideosMap.has(id) || hydrationInvalidatedTabs.has(id)) continue;
                  tabVideosMap.set(id, v);
                }
              }
              const seq = Number(data.binlate_sessionSeq);
              if (Number.isFinite(seq) && seq > captureSessionSeq) captureSessionSeq = seq;
            } catch (_) {}
            resolve();
          }
        );
      } catch (_) { resolve(); }
    });
  });
  return storageHydration.finally(() => {
    hydrationInvalidatedTabs.clear();
  });
}

// Initialize Context Menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "fb_downloader_download_video",
    title: "⬇️ Tải Video/Reel này (Bin.Late Downloader)",
    contexts: ["video", "link"]
  });
  console.log("[Bin.Late FB Downloader] Service worker initialized.");
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "fb_downloader_download_video") {
    const targetUrl = info.srcUrl || info.linkUrl;
    if (targetUrl) {
      handleDownloadFlow({
        url: targetUrl,
        tabId: tab?.id,
        type: "video",
        title: tab?.title || "facebook_video"
      }).catch(err => {
        console.warn("[Bin.Late Downloader] Context menu download error:", err.message);
      });
    } else if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: "TRIGGER_CURRENT_VIDEO_DOWNLOAD" });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideosMap.delete(tabId);
  disarmCaptureSession(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabVideosMap.delete(tabId);
    disarmCaptureSession(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
    persistMaps();
  }
});

/**
 * Read a (case-insensitive) header value from a webRequest responseHeaders array.
 */
function getResponseHeader(headers, name) {
  if (!Array.isArray(headers)) return "";
  const hit = headers.find((h) => h && h.name && h.name.toLowerCase() === name);
  return (hit && hit.value) || "";
}

/**
 * Classification of a CDN response as downloadable video media.
 * Recognizes progressive MP4s, DASH segments, and versioned binary video payloads.
 */
function classifyVideoResponse(url, contentType) {
  if (!url) return null;
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch (_) {
    pathname = String(url).split("?")[0].toLowerCase();
  }
  const ct = String(contentType || "").toLowerCase().trim();

  // 1. DASH manifests: recorded for tracking/manifest parsing, flagged as manifest
  if (ct.includes("dash+xml") || pathname.endsWith(".mpd")) {
    return { url, videoTyped: false, manifest: true };
  }

  // 2. Explicit video typing from server
  if (ct.startsWith("video/")) return { url, videoTyped: true, manifest: false };

  // 3. Progressive MP4 or M4V
  if (/\.(mp4|m4v)$/.test(pathname)) return { url, videoTyped: false, manifest: false };

  // 4. Binary media payload on FB CDN (e.g. /v/, /o1/v/, /hvideo/, etc.)
  const binaryMediaCt =
    ct.startsWith("audio/") ||
    ct === "application/octet-stream" ||
    ct === "binary/octet-stream" ||
    ct === "application/x-mp4";
  if (
    binaryMediaCt &&
    (/^\/(v|o1\/v|hvideo|rsrc\.php)\//.test(pathname) || isValidMediaStream(url))
  ) {
    return { url, videoTyped: false, manifest: false };
  }

  return null;
}

/**
 * Arm a fresh capture session for a tab.
 */
function armCaptureSession(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id) || id < 0) return null;
  captureSessionSeq += 1;
  markTabInvalidated(id);
  tabMediaMap.set(id, {
    sessionId: captureSessionSeq,
    armedAt: Date.now(),
    list: []
  });
  persistMaps();
  return captureSessionSeq;
}

/**
 * Tear down the capture session for a tab.
 */
function disarmCaptureSession(tabId, expectedSessionId = null) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  if (
    expectedSessionId !== null &&
    expectedSessionId !== undefined &&
    tabMediaMap.get(id)?.sessionId !== Number(expectedSessionId)
  ) {
    return;
  }
  tabMediaMap.delete(id);
  markTabInvalidated(id);
  persistMaps();
}

async function isSessionLiveForTab(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id) || id < 0) return null;
  let state = tabMediaMap.get(id);
  if (!state) {
    if (tabMediaMap.size !== 0) return null;
    await hydrateFromSessionStorage();
    state = tabMediaMap.get(id);
    if (!state) return null;
  }
  if (Date.now() - state.armedAt > MAX_CAPTURE_AGE_MS) return null;
  return state.sessionId;
}

/**
 * Record a classified media response into the tab's capture list.
 */
function recordTabMedia(tabId, url, videoTyped, manifest, expectedSessionId = null) {
  const id = Number(tabId);
  if (!Number.isFinite(id) || id < 0 || !url) return;
  const state = tabMediaMap.get(id);
  if (!state) return;
  if (
    expectedSessionId !== null &&
    expectedSessionId !== undefined &&
    state.sessionId !== Number(expectedSessionId)
  ) {
    return;
  }
  if (Date.now() - state.armedAt > MAX_CAPTURE_AGE_MS) {
    tabMediaMap.delete(id);
    markTabInvalidated(id);
    persistMaps();
    return;
  }
  if (state.list.some((entry) => entry.url === url)) return;
  state.list.unshift({
    url,
    videoTyped: !!videoTyped,
    manifest: !!manifest,
    session: state.sessionId,
    ts: Date.now()
  });
  if (state.list.length > MAX_CAPTURED_PER_TAB) {
    state.list.length = MAX_CAPTURED_PER_TAB;
  }
  persistMaps();
  console.log("[Bin.Late FB Downloader] captured:", url);
}

function handleMediaWebRequest(details) {
  if (details.tabId === undefined || details.tabId < 0) return;
  void isSessionLiveForTab(details.tabId).then((observedSessionId) => {
    if (observedSessionId === null) return;
    const contentType = getResponseHeader(details.responseHeaders, "content-type");
    const classified = classifyVideoResponse(details.url, contentType);
    if (classified) {
      recordTabMedia(
        details.tabId,
        classified.url,
        classified.videoTyped,
        classified.manifest,
        observedSessionId
      );
    }
  });
}

try {
  chrome.webRequest.onResponseStarted.addListener(handleMediaWebRequest, { urls: MEDIA_URL_FILTER }, ["responseHeaders"]);
  chrome.webRequest.onCompleted.addListener(handleMediaWebRequest, { urls: MEDIA_URL_FILTER }, ["responseHeaders"]);
} catch (err) {
  networkCaptureAvailable = false;
  networkCaptureReason = (err && err.message) || String(err);
  console.warn("[Bin.Late FB Downloader] webRequest capture unavailable:", networkCaptureReason);
}

/**
 * Decode JSON/Unicode/XML-escaped sequences.
 */
function decodeFbEscapes(text) {
  return FbExtractor.decodeFbEscapes(text);
}

/**
 * Clean URL and strip trailing XML tags or byte-range parameters.
 */
function cleanMediaUrl(u) {
  return FbExtractor.cleanMediaUrl(u);
}

/**
 * Validate that URL belongs to authorized Facebook CDN hosts.
 */
function isFacebookMediaHost(hostname) {
  return FbExtractor.isFacebookMediaHost(hostname);
}

/**
 * Validate media stream URL for chrome.downloads.
 */
function isValidMediaStream(u) {
  return FbExtractor.isValidMediaStream(u);
}

/**
 * Resolve Facebook web URL to direct video stream.
 */
async function resolveFacebookVideoUrl(targetUrl, preferredQuality = "HD") {
  if (!targetUrl || typeof targetUrl !== "string") {
    return null;
  }

  if (isValidMediaStream(targetUrl)) {
    return cleanMediaUrl(targetUrl);
  }

  const ATTEMPT_TIMEOUT_MS = 8000;
  const fetchStream = async (url, label = "attempt") => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        console.warn(`[Bin.Late FB Downloader] ${label} -> HTTP ${response.status} (${Date.now() - startedAt}ms)`);
        return null;
      }
      const html = await response.text();
      const streams = FbExtractor.extractStreamsFromText(html);
      if (streams) {
        return streams;
      }

      if (response.url && response.url !== url && /facebook\.com/i.test(response.url)) {
        const embedFinal = await fetchEmbedStream(response.url);
        if (embedFinal) return embedFinal;
      }
    } catch (err) {
      console.warn(`[Bin.Late FB Downloader] ${label} -> failed (${Date.now() - startedAt}ms):`, err && err.message ? err.message : err);
    } finally {
      clearTimeout(timer);
    }
    return null;
  };

  const fetchEmbedStream = async (pageUrl) => {
    try {
      const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(pageUrl)}&show_text=0`;
      return await fetchStream(embedUrl, "embed-attempt");
    } catch (err) {
      console.warn("[Bin.Late FB Downloader] Embed fetch error:", err);
      return null;
    }
  };

  const attempts = [];
  const pushAttempt = (u) => {
    if (u && !attempts.includes(u)) attempts.push(u);
  };

  const trimmed = targetUrl.trim();
  if (/^\d{6,30}$/.test(trimmed)) {
    pushAttempt(`https://www.facebook.com/reel/${trimmed}`);
    pushAttempt(`https://www.facebook.com/watch/?v=${trimmed}`);
    pushAttempt(`https://m.facebook.com/reel/${trimmed}`);
  } else {
    try {
      const parsed = new URL(trimmed);
      if (/(^|\.)facebook\.com$/i.test(parsed.hostname) || /(^|\.)fb\.watch$/i.test(parsed.hostname)) {
        const idMatch = parsed.pathname.match(/\/(?:reel|reels|videos|watch)(?:\/[^/]+)*\/(\d{6,30})/i) || parsed.search.match(/[?&]v=(\d{6,30})/);
        if (idMatch) {
          const numId = idMatch[1];
          pushAttempt(`https://www.facebook.com/reel/${numId}`);
          pushAttempt(`https://www.facebook.com/watch/?v=${numId}`);
          pushAttempt(`https://m.facebook.com/reel/${numId}`);
        } else if (parsed.pathname !== "/" && parsed.pathname !== "" && !/^\/(?:reels?|watch)\/?$/i.test(parsed.pathname)) {
          pushAttempt(trimmed);
          pushAttempt(`${parsed.protocol}//m.facebook.com${parsed.pathname}${parsed.search}`);
          pushAttempt(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(trimmed)}&show_text=0`);
        } else {
          // Generic root URL like facebook.com/ or facebook.com/reels/ WITHOUT ID -> DO NOT SSR to avoid grabbing random feed video!
          return null;
        }
      } else {
        pushAttempt(trimmed);
      }
    } catch (_) {
      return null;
    }
  }

  for (let i = 0; i < attempts.length; i++) {
    const resolved = await fetchStream(attempts[i], `ssr-attempt ${i + 1}/${attempts.length}`);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Pick the best captured network stream for a tab.
 */
function pickBestCapturedStream(tabId, targetHint, expectedSrc) {
  void hydrateFromSessionStorage();
  const state = tabMediaMap.get(Number(tabId));
  if (!state) return null;
  const cutoff = Date.now() - MAX_CAPTURE_AGE_MS;
  const eligible = state.list.filter(
    (entry) => entry.session === state.sessionId && entry.ts >= cutoff
  );
  if (eligible.length === 0) return null;
  const downloadable = eligible.filter((entry) => !entry.manifest);
  if (downloadable.length === 0) return null;

  // 1. Exact-source correlation if provided
  if (Array.isArray(expectedSrc) && expectedSrc.length > 0) {
    const sources = expectedSrc.filter(
      (src) => typeof src === "string" && src
    );
    const srcMatches = downloadable.filter(
      (entry) => sources.some((src) => entry.url === src)
    );
    if (srcMatches.length > 0) return cleanMediaUrl(pickTop(srcMatches));
  }

  // 2. Pick the highest quality / most recent stream captured in this active session
  const top = pickTop(downloadable);
  return top ? cleanMediaUrl(top) : null;
}

function pickTop(pool) {
  const score = (entry) =>
    (/\.(mp4|m4v)($|[?#])/.test(entry.url.toLowerCase()) ? 3 : 0) +
    (entry.videoTyped ? 2 : 0) +
    (entry.url.includes("o1/v/") ? 1 : 0);
  const sorted = [...pool].sort((a, b) => score(b) - score(a) || b.ts - a.ts);
  return sorted[0]?.url || null;
}

function nudgeAndAwaitCapture(tabId, waitMs = 1000) {
  const id = Number(tabId);
  if (!Number.isFinite(id) || id < 0) {
    return Promise.resolve({ sources: [] });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result || { sources: [] });
      }
    };
    try {
      chrome.tabs.sendMessage(id, { action: "SCAN_NOW" }, (response) => {
        void chrome.runtime.lastError;
        setTimeout(() => done({
          sources: Array.isArray(response && response.videos)
            ? response.videos
                .map((v) => (v && (v.elementSrc || v.url)) || null)
                .filter((u) => typeof u === "string" && u && !u.startsWith("blob:"))
            : [],
        }), waitMs);
      });
    } catch (_) {
      done({ sources: [] });
    }
  });
}

let offscreenCreating = null;

async function hasOffscreenDoc() {
  if (typeof chrome.offscreen?.hasDocument === "function") {
    return await chrome.offscreen.hasDocument();
  }
  if (typeof chrome.runtime?.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    }).catch(() => []);
    return contexts && contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === "undefined") {
    return false;
  }
  if (await hasOffscreenDoc()) {
    return true;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["BLOBS"],
    justification: "Ghép luồng video và âm thanh DASH thành file MP4 hoàn chỉnh"
  });

  try {
    await offscreenCreating;
    return true;
  } catch (err) {
    console.warn("[Bin.Late FB Downloader] Offscreen creation error:", err);
    return false;
  } finally {
    offscreenCreating = null;
  }
}

// Track and revoke active Blob URLs across MV3 lifecycle events
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
    const blobUrl = await BlobManager.unregisterBlobDownload(delta.id);
    if (blobUrl) {
      await BlobManager.revokeBlobUrl(blobUrl);
    }
  }
});

/**
 * Unified download flow.
 */
async function handleDownloadFlow({ url, audioUrl = null, isDashSeparate = false, postUrl, tabId, type = "video", title = "facebook", quality = "HD", selectedSource = null }) {
  let resolvedUrl = null;
  let resolvedAudioUrl = audioUrl;
  let resolvedDashSeparate = isDashSeparate;

  const captureSessionId = armCaptureSession(tabId);

  // 1. Direct stream URL provided by caller
  if (isValidMediaStream(url)) {
    resolvedUrl = cleanMediaUrl(url);
  }

  const lookupTarget = postUrl || url;

  // 2. Nudge the tab to re-scan
  let nudgeSources = [];
  if (captureSessionId !== null && !resolvedUrl) {
    const nudge = await nudgeAndAwaitCapture(tabId);
    nudgeSources = (nudge && nudge.sources) || [];
  }

  const targetSource =
    typeof selectedSource === "string" && selectedSource && !selectedSource.startsWith("blob:")
      ? [selectedSource]
      : nudgeSources;

  // 3. Resolve from the post/page URL via SSR + embed strategies only when needed
  if (!resolvedUrl) {
    if (lookupTarget && typeof lookupTarget === "string" && lookupTarget.startsWith("http")) {
      const streamInfo = await resolveFacebookVideoUrl(lookupTarget, quality);
      if (streamInfo) {
        if (typeof streamInfo === "string") {
          resolvedUrl = streamInfo;
        } else {
          resolvedUrl = (quality === "HD" && streamInfo.hdUrl) ? streamInfo.hdUrl : (streamInfo.sdUrl || streamInfo.hdUrl);
          resolvedAudioUrl = streamInfo.audioUrl || null;
          resolvedDashSeparate = !!streamInfo.isDashSeparate;
        }
      }
    }
  } else if (!resolvedAudioUrl && lookupTarget && typeof lookupTarget === "string" && lookupTarget.startsWith("http")) {
    // If we already have resolvedUrl from DOM, only query SSR to enrich audio if lookupTarget has a numeric ID
    if (/\/(?:reel|reels|videos|watch)(?:\/[^/]+)*\/(\d{6,30})/i.test(lookupTarget) || /[?&]v=(\d{6,30})/.test(lookupTarget)) {
      const streamInfo = await resolveFacebookVideoUrl(lookupTarget, quality);
      if (streamInfo && typeof streamInfo === "object" && streamInfo.audioUrl) {
        resolvedAudioUrl = streamInfo.audioUrl;
        resolvedDashSeparate = true;
      }
    }
  }

  // 4. Validate we have a resolved URL
  try {
    if (!isValidMediaStream(resolvedUrl)) {
      throw new Error(
        "Không tìm thấy luồng video trực tiếp cho liên kết này. " +
        "Hãy mở video/reel trên Facebook, phát video vài giây rồi thử lại " +
        "(hoặc dùng nút 'Tải Reel' hiển thị ngay trên video)."
      );
    }

    // 5. If this is a separate DASH stream (video + audio), mux them via offscreen!
    if (resolvedUrl && resolvedAudioUrl) {
      if (!FbExtractor.isValidMediaStream(resolvedAudioUrl)) {
        throw new Error("Đường dẫn âm thanh không hợp lệ hoặc không thuộc máy chủ Facebook.");
      }
      const offscreenReady = await ensureOffscreenDocument();
      if (!offscreenReady) {
        throw new Error("Không thể khởi tạo bộ ghép video/âm thanh (Offscreen Document không khả dụng).");
      }

      const muxResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: "OFFSCREEN_MUX_MEDIA",
            payload: { videoUrl: resolvedUrl, audioUrl: resolvedAudioUrl }
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: false, error: "Không nhận được phản hồi từ bộ ghép." });
            }
          }
        );
      });

      if (!muxResponse || !muxResponse.success || !muxResponse.blobUrl) {
        throw new Error(
          `Ghép âm thanh và hình ảnh thất bại: ${muxResponse?.error || "Không thể tạo file MP4"}.`
        );
      }

      // Fail loudly instead of silently delivering a video-only file.
      if (muxResponse.isMuxed === false || muxResponse.hasAudio === false) {
        const reasonMap = {
          fragmented_mp4_not_supported: "một trong hai luồng là MP4 phân mảnh chưa được hỗ trợ",
          mixed_fragmented_and_plain_mp4: "hai luồng không cùng định dạng MP4 phân mảnh",
          missing_moov_or_mdat: "luồng âm thanh tải về không hợp lệ (URL có thể đã hết hạn)",
          missing_movie_fragments: "luồng âm thanh không chứa dữ liệu phân đoạn",
          missing_audio_buffer: "không tải được dữ liệu âm thanh",
          missing_video_buffer: "không tải được dữ liệu video",
          missing_video_trak: "luồng video thiếu thông tin track",
          missing_audio_trak: "luồng âm thanh thiếu thông tin track"
        };
        const muxReason = reasonMap[muxResponse.reason] || ("lý do: " + (muxResponse.reason || "không xác định"));
        throw new Error(
          "Video và âm thanh KHÔNG ghép được (" + muxReason + "). " +
          "Hãy phát video vài giây rồi thử tải lại."
        );
      }

      resolvedUrl = muxResponse.blobUrl;
      return await downloadMedia({
        url: resolvedUrl,
        isInternalBlob: true,
        type: type,
        title: title,
        quality: quality
      });
    }

    return await downloadMedia({
      url: resolvedUrl,
      isInternalBlob: false,
      type: type,
      title: title,
      quality: quality
    });
  } finally {
    if (captureSessionId !== null) disarmCaptureSession(tabId, captureSessionId);
  }
}

// Main message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case "REGISTER_VIDEOS": {
      if (tabId && Array.isArray(message.videos)) {
        tabVideosMap.set(tabId, message.videos);
        const count = message.videos.length;
        if (count > 0) {
          chrome.action.setBadgeText({ tabId, text: count.toString() });
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#1877F2" });
        } else {
          chrome.action.setBadgeText({ tabId, text: "" });
        }
      }
      sendResponse({ status: "success" });
      break;
    }

    case "GET_TAB_VIDEOS": {
      const queryTabId = message.tabId || tabId;
      const videos = tabVideosMap.get(queryTabId) || [];
      sendResponse({ videos });
      break;
    }

    case "DOWNLOAD_FILE":
    case "RESOLVE_AND_DOWNLOAD": {
      const payload = { ...(message.payload || {}) };
      if ((payload.tabId === undefined || payload.tabId === null) && tabId !== undefined) {
        payload.tabId = tabId;
      }
      handleDownloadFlow(payload)
        .then((downloadId) => {
          sendResponse({ success: true, downloadId });
        })
        .catch((error) => {
          console.warn("[Bin.Late Downloader] Download rejected:", error.message);
          sendResponse({ success: false, error: error.message });
        });
      return true;
    }

    default:
      sendResponse({ status: "unknown_action" });
      break;
  }
});

function sanitizeFilename(name) {
  if (!name) return "video";
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 60);
}

async function downloadMedia({ url, isInternalBlob = false, type = "video", title = "facebook", quality = "HD" }) {
  if (!url || typeof url !== "string") {
    throw new Error("No valid media URL provided for download");
  }

  let targetUrl = null;
  const isBlob = url.startsWith("blob:");

  if (isBlob) {
    if (!isInternalBlob) {
      throw new Error("Direct external blob URL download is not permitted.");
    }
    targetUrl = url;
  } else {
    targetUrl = cleanMediaUrl(url);
    if (!targetUrl || !isValidMediaStream(targetUrl)) {
      throw new Error("No valid Facebook CDN media URL provided for download");
    }
  }

  let mediaPath = "";
  try {
    mediaPath = new URL(targetUrl).pathname.toLowerCase();
  } catch (_) {
    mediaPath = String(targetUrl).split("?")[0].toLowerCase();
  }
  if (mediaPath.endsWith(".mpd")) {
    throw new Error("Luồng tải được là manifest DASH (.mpd), không phải video MP4.");
  }

  const cleanTitle = sanitizeFilename(title);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `BinLate_FB_${type.toUpperCase()}_${quality}_${cleanTitle}_${timestamp}.mp4`;

  let pendingToken = null;
  if (isBlob) {
    try {
      pendingToken = await BlobManager.beginPendingRegistration(targetUrl);
    } catch (regErr) {
      console.error("[Bin.Late FB Downloader] Failed to register pending blob download:", regErr);
      await BlobManager.revokeBlobUrl(targetUrl);
      throw new Error("Không thể khởi tạo lưu trữ phiên tải cho luồng video/âm thanh đã ghép: " + regErr.message);
    }
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: targetUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      async (downloadId) => {
        if (chrome.runtime.lastError) {
          const err = new Error(chrome.runtime.lastError.message);
          if (isBlob) {
            await BlobManager.cancelPendingRegistration(pendingToken);
            await BlobManager.revokeBlobUrl(targetUrl);
          }
          reject(err);
        } else {
          if (isBlob) {
            try {
              await BlobManager.completePendingRegistration(pendingToken, downloadId, targetUrl);
            } catch (storageErr) {
              console.warn("[Bin.Late FB Downloader] Failed to persist active registration; recording downloadId on pending:", storageErr.message);
              await BlobManager.recordPendingDownloadId(pendingToken, downloadId);
            }
          }
          resolve(downloadId);
        }
      }
    );
  });
}

// Track download completion to automatically revoke Blob URLs and close offscreen document
if (typeof chrome !== "undefined" && chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta || !delta.id) return;
    const downloadId = delta.id;
    const isComplete = delta.state && delta.state.current === "complete";
    const isInterrupted = delta.error && delta.error.current;

    if (isComplete || isInterrupted) {
      const blobUrl = await BlobManager.unregisterBlobDownload(downloadId);
      if (blobUrl) {
        await BlobManager.revokeBlobUrl(blobUrl);
      }
    }
  });
}
