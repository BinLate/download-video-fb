/**
 * Download Video / Reel Facebook - Content Script
 * Robust video detection, Reel extraction, safe MV3 messaging, and DASH stream support.
 * Author: Bin.Late
 */

(function () {
  "use strict";

  const PROCESSED_ATTR = "data-binlate-processed";
  const BUTTON_CLASS = "binlate-fb-dl-btn";
  const CONTAINER_CLASS = "binlate-fb-dl-container";

  let detectedVideos = new Map();
  let scanDebounceTimer = null;
  let domObserver = null;

  // SVG Icons
  const ICONS = {
    download: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    hd: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15V9m4 0v6m-4-3h4m4 0h3a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-3v6z"/></svg>`,
    sd: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 10c0-1 1-1.5 2-1.5s2 .5 2 1.5c0 1.5-2 1.5-2 2.5 0 1 1 1.5 2 1.5s2-.5 2-1.5m4-5.5h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-3V9z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
  };

  /**
   * Check if extension context is valid and active.
   */
  function isExtensionValid() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id);
  }

  /**
   * Safe messaging wrapper that catches context invalidation and disconnects observers.
   */
  function safeSendMessage(message, callback) {
    if (!isExtensionValid()) {
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime?.lastError) {
          const errText = chrome.runtime.lastError.message || "";
          if (errText.includes("context invalidated") || errText.includes("Could not establish connection")) {
            if (domObserver) {
              domObserver.disconnect();
              domObserver = null;
            }
            return;
          }
        }
        if (typeof callback === "function") {
          callback(res);
        }
      });
    } catch (err) {
      if (err.message && err.message.includes("context invalidated")) {
        if (domObserver) {
          domObserver.disconnect();
          domObserver = null;
        }
      } else {
        console.warn("[Bin.Late FB Downloader] Messaging exception:", err.message);
      }
    }
  }

  /**
   * Delegate to shared FbExtractor module or fallback in-memory helpers.
   */
  const Extractor = (typeof FbExtractor !== "undefined" && FbExtractor) ? FbExtractor : {
    decodeFbEscapes: function (text) {
      if (!text) return "";
      return text
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\+\//g, "/")
        .replace(/\\+\\/g, "\\")
        .replace(/\\+"/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
    },
    cleanMediaUrl: function (url) {
      if (!url) return null;
      let u = url.trim().replace(/(%3C|<)\/?BaseURL.*$/i, "").trim();
      u = u.replace(/[?&]bytestart=\d+/g, "").replace(/[?&]byteend=\d+/g, "");
      if (u.includes("?") && !u.split("?")[1]) u = u.split("?")[0];
      return u.startsWith("http") ? u : null;
    },
    parseDashManifest: function () { return null; },
    extractStreamsFromText: function () { return null; },
    isValidMediaStream: function () { return true; }
  };

  /**
   * Helper to extract HD and SD URLs from embedded scripts or DOM
   */
  function extractUrlsFromScripts() {
    const urlsMap = new Map();
    const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');

    for (const script of scripts) {
      const raw = script.textContent;
      if (!raw) continue;

      const hasVideoKeys =
        raw.includes("playable_url") ||
        raw.includes("browser_native") ||
        raw.includes("dash_manifest") ||
        raw.includes("playback_video_dash_xml") ||
        raw.includes("video_dash_manifest") ||
        raw.includes("representations") ||
        raw.includes("BaseURL") ||
        raw.includes(".mp4") ||
        raw.includes("video_delivery");

      if (!hasVideoKeys) continue;

      const texts = new Set([raw]);
      const decodedFull = Extractor.decodeFbEscapes(raw);
      if (decodedFull !== raw) texts.add(decodedFull);

      for (const text of texts) {
        // 1. Match JSON object blocks containing video id
        const objectRegex = /\{[^{}]*?"(?:video_id|id)"\s*:\s*"?(\d{8,25})"[^{}]*?\}/g;
        let match;

        while ((match = objectRegex.exec(text)) !== null) {
          const block = match[0];
          const videoId = match[1];
          const streams = Extractor.extractStreamsFromText(block);
          if (streams) {
            urlsMap.set(videoId, streams);
          }
        }

        // 2. Broader nested structure matching within ~4000 chars of video ID
        const broaderRegex = /"(?:video_id|id)"\s*:\s*"(\d{8,25})"[\s\S]{0,4000}?"(?:playable_url_quality_hd|browser_native_hd_url|playable_url|browser_native_sd_url|dash_manifest|playback_video_dash_xml|<BaseURL)"/g;
        let broaderMatch;
        while ((broaderMatch = broaderRegex.exec(text)) !== null) {
          const id = broaderMatch[1];
          if (!urlsMap.has(id)) {
            const section = text.substring(broaderMatch.index, Math.min(text.length, broaderMatch.index + 4000));
            const streams = Extractor.extractStreamsFromText(section);
            if (streams) {
              urlsMap.set(id, streams);
            }
          }
        }

      }
    }

    // Removed fallback_any mechanism - it caused cross-Reel contamination
    // Each video must have exact videoId match to get its stream

    return urlsMap;
  }

  /**
   * Determine if element is in a Reel context
   */
  function isReelContext(element) {
    if (window.location.pathname.includes("/reel/") || window.location.pathname.includes("/reels/") || window.location.pathname.includes("/share/r/")) {
      return true;
    }
    const container = element.closest(
      '[data-pagelet*="Reel"], [aria-label*="Reel" i], [role="dialog"], [data-pagelet*="FeedUnit"]'
    );
    if (!container) return false;

    if (container.getAttribute("data-pagelet")?.includes("Reel")) return true;
    if (container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/share/r/"]')) return true;

    return false;
  }

  /**
   * Extract video ID from URL or DOM element
   */
  function extractVideoId(url, element) {
    // Priority 1: Direct URL patterns
    if (url) {
      const reelMatch = url.match(/\/(?:reel|reels|share\/r)\/([a-zA-Z0-9_-]+)/i);
      if (reelMatch) return reelMatch[1];

      const watchMatch = url.match(/[?&]v=(\d+)/);
      if (watchMatch) return watchMatch[1];

      const videoMatch = url.match(/\/videos\/(?:[^/]+\/)?(\d+)/);
      if (videoMatch) return videoMatch[1];
    }
    
    // Priority 2: Element's own data attributes (most accurate for Reels)
    if (element) {
      // Check video element directly for data attributes
      const videoReelId = element.getAttribute("data-reel-id") || element.getAttribute("data-video-id");
      if (videoReelId) return videoReelId;
      
      // Check parent containers
      const postContainer = element.closest('[data-video-id], [data-reel-id], [data-store*="video_id"]');
      if (postContainer) {
        const directId = postContainer.getAttribute("data-video-id") || postContainer.getAttribute("data-reel-id");
        if (directId) return directId;
        const dataStore = postContainer.getAttribute("data-store");
        const match = dataStore?.match(/"(?:video_id|reel_id)":\s*"?(\d+)"?/);
        if (match) return match[1];
      }
    }
    
    // Priority 3: URL pathname (current page)
    const pathReel = window.location.pathname.match(/\/(?:reel|reels|share\/r)\/([a-zA-Z0-9_-]+)/i);
    if (pathReel) return pathReel[1];
    const pathVideo = window.location.pathname.match(/\/videos\/(\d+)/);
    if (pathVideo) return pathVideo[1];

    // Priority 4: Fallback to element ID or generated ID
    return element?.id || `vid_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Extract video information from a <video> element
   */
  function parseVideoElement(video) {
    let src = video.src || video.currentSrc;
    if (!src || src.startsWith("blob:")) {
      const source = video.querySelector("source");
      if (source && source.src) {
        src = source.src;
      }
    }

    const postContainer = video.closest('[role="article"], [data-pagelet*="FeedUnit"], [data-pagelet*="Reel"]') || video.parentElement;
    let postLink = "";
    let title = document.title || "Facebook Video";

    if (postContainer) {
      const linkElem = postContainer.querySelector('a[href*="/videos/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/share/r/"], a[href*="/watch/"], a[href*="watch?v="]');
      if (linkElem) {
        postLink = linkElem.href;
      } else if (/\/(reel|reels|videos|watch)\//.test(window.location.pathname) && /^https?:\/\/[^/]*facebook\.com/.test(window.location.href)) {
        postLink = window.location.href.split("?")[0];
      }
      const textElem = postContainer.querySelector('[data-ad-preview="message"], [dir="auto"]');
      if (textElem && textElem.textContent.trim().length > 3) {
        title = textElem.textContent.trim().slice(0, 50);
      }
    }

    const isReel = isReelContext(video);
    const videoType = isReel ? "reel" : "video";
    const videoId = extractVideoId(postLink, video) || video.id || `vid_${Math.random().toString(36).substr(2, 9)}`;
    
    // Set data-reel-id on video element for later correlation
    video.setAttribute("data-reel-id", videoId);

    return {
      element: video,
      videoId: videoId,
      url: src,
      isBlob: !src || src.startsWith("blob:"),
      postLink: postLink || window.location.href,
      type: videoType,
      title: title,
      id: videoId
    };
  }

  /**
   * Create and attach the download button to a video element
   */
  function attachDownloadButton(videoInfo) {
    const video = videoInfo.element;
    if (video.getAttribute(PROCESSED_ATTR)) {
      return;
    }
    video.setAttribute(PROCESSED_ATTR, "true");

    const container = video.parentElement;
    if (!container) return;

    const computedPos = window.getComputedStyle(container).position;
    if (computedPos === "static") {
      container.style.position = "relative";
    }

    const btnWrapper = document.createElement("div");
    btnWrapper.className = CONTAINER_CLASS;
    btnWrapper.setAttribute("data-binlate-downloader", "true");

    const mainBtn = document.createElement("button");
    mainBtn.className = BUTTON_CLASS;
    mainBtn.setAttribute("type", "button");
    mainBtn.setAttribute("title", `Tải ${videoInfo.type === "reel" ? "Reel" : "Video"} Facebook (Bin.Late)`);
    mainBtn.innerHTML = `
      <span class="binlate-icon">${ICONS.download}</span>
      <span class="binlate-label">${videoInfo.type === "reel" ? "Tải Reel" : "Tải Video"}</span>
      <span class="binlate-badge">HD</span>
    `;

    const dropdown = document.createElement("div");
    dropdown.className = "binlate-dropdown-menu";
    dropdown.innerHTML = `
      <div class="binlate-dropdown-header">
        <span>Tải về bởi <strong>Bin.Late</strong></span>
      </div>
      <button type="button" class="binlate-menu-item" data-quality="HD">
        <span class="item-icon">${ICONS.hd}</span>
        <span class="item-text">Tải chất lượng HD (Cao nhất)</span>
      </button>
      <button type="button" class="binlate-menu-item" data-quality="SD">
        <span class="item-icon">${ICONS.sd}</span>
        <span class="item-text">Tải chất lượng SD (Tiêu chuẩn)</span>
      </button>
      <button type="button" class="binlate-menu-item" data-quality="COPY">
        <span class="item-icon">${ICONS.copy}</span>
        <span class="item-text">Sao chép liên kết</span>
      </button>
    `;

    mainBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const isActive = dropdown.classList.contains("binlate-active");
      document.querySelectorAll(".binlate-dropdown-menu.binlate-active").forEach(el => el.classList.remove("binlate-active"));
      if (!isActive) {
        dropdown.classList.add("binlate-active");
      }
    });

    dropdown.querySelectorAll(".binlate-menu-item").forEach((item) => {
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        dropdown.classList.remove("binlate-active");

        const actionType = item.getAttribute("data-quality");

        if (actionType === "COPY") {
          const targetUrl = videoInfo.url || videoInfo.postLink || window.location.href;
          try {
            await navigator.clipboard.writeText(targetUrl);
            showToast("Đã sao chép liên kết vào clipboard!");
          } catch (_) {
            showToast("Không thể sao chép liên kết.");
          }
          return;
        }

        triggerDownload(videoInfo, actionType);
      });
    });

    btnWrapper.appendChild(mainBtn);
    btnWrapper.appendChild(dropdown);
    container.appendChild(btnWrapper);
  }

  /**
   * Request background script to start downloading
   */
  function triggerDownload(videoInfo, quality = "HD") {
    let downloadUrl = null;
    let audioUrl = null;
    let isDashSeparate = false;
    const scriptUrls = extractUrlsFromScripts();

    let streamMatch = null;
    if (videoInfo.videoId && scriptUrls.has(videoInfo.videoId)) {
      streamMatch = scriptUrls.get(videoInfo.videoId);
    }
    // REMOVED: fallback_any - it caused cross-Reel contamination
    // Only exact videoId match is allowed

    if (streamMatch) {
      if (quality === "HD" && streamMatch.hdUrl) {
        downloadUrl = streamMatch.hdUrl;
      } else if (streamMatch.sdUrl) {
        downloadUrl = streamMatch.sdUrl;
      } else if (streamMatch.hdUrl) {
        downloadUrl = streamMatch.hdUrl;
      }
      audioUrl = streamMatch.audioUrl || null;
      isDashSeparate = Boolean(streamMatch.isDashSeparate || (streamMatch.audioUrl && downloadUrl && streamMatch.audioUrl !== downloadUrl));
    }

    const looksLikeMediaUrl = (candidate) => {
      if (!candidate || typeof candidate !== "string" || candidate.startsWith("blob:")) return false;
      try {
        const u = new URL(candidate);
        return u.protocol === "https:" && (u.hostname.endsWith("fbcdn.net") || u.hostname.endsWith("fbsbx.com"));
      } catch (_) {
        return false;
      }
    };

    // Direct stream URL on element if available
    if (!downloadUrl && looksLikeMediaUrl(videoInfo.url)) {
      downloadUrl = videoInfo.url;
    }

    // Fallback: live element currentSrc
    if (!downloadUrl) {
      const liveElem = videoInfo.element;
      if (liveElem && looksLikeMediaUrl(liveElem.currentSrc)) {
        downloadUrl = liveElem.currentSrc;
      }
    }

    if (isDashSeparate && audioUrl) {
      showToast(`🎬 Đang ghép Video & Âm thanh ${videoInfo.type.toUpperCase()} (${quality})...`);
    } else {
      showToast(`⏳ Đang chuẩn bị tải ${videoInfo.type.toUpperCase()} (${quality})...`);
    }

    safeSendMessage(
      {
        action: "DOWNLOAD_FILE",
        payload: {
          url: downloadUrl,
          audioUrl: audioUrl,
          isDashSeparate: isDashSeparate,
          postUrl: videoInfo.postLink || window.location.href,
          videoId: videoInfo.videoId,
          selectedSource:
            videoInfo.url && !videoInfo.url.startsWith("blob:")
              ? videoInfo.url
              : null,
          type: videoInfo.type,
          title: videoInfo.title,
          quality: quality
        }
      },
      (res) => {
        if (!res) return;
        if (res.success) {
          showToast(`✅ Đang tải xuống: ${videoInfo.title.substring(0, 25)}...`);
        } else {
          const errMsg = res.error || "Không tìm thấy luồng video. Hãy phát video vài giây rồi thử lại.";
          showToast(`⚠️ ${errMsg}`);
        }
      }
    );
  }

  function showToast(message) {
    let toast = document.getElementById("binlate-fb-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "binlate-fb-toast";
      toast.className = "binlate-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("binlate-toast-visible");
    setTimeout(() => {
      toast.classList.remove("binlate-toast-visible");
    }, 3500);
  }

  function scanPageVideos() {
    if (!isExtensionValid()) {
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      return;
    }

    const videoElements = document.querySelectorAll("video");
    const scriptData = extractUrlsFromScripts();
    const liveIds = new Set();

    videoElements.forEach((video) => {
      const info = parseVideoElement(video);
      liveIds.add(info.id);
      let matchedHd = null;
      let matchedSd = null;

      if (info.videoId && scriptData.has(info.videoId)) {
        const entry = scriptData.get(info.videoId);
        matchedHd = entry.hdUrl;
        matchedSd = entry.sdUrl;
      }

      detectedVideos.set(info.id, {
        id: info.id,
        videoId: info.videoId,
        type: info.type,
        title: info.title,
        url: matchedHd || matchedSd || (info.url && !info.url.startsWith("blob:") ? info.url : null),
        elementSrc: info.url && !info.url.startsWith("blob:") ? info.url : null,
        hdUrl: matchedHd,
        sdUrl: matchedSd,
        isBlob: info.isBlob,
        postLink: info.postLink
      });
      attachDownloadButton(info);
    });

    for (const key of Array.from(detectedVideos.keys())) {
      if (!liveIds.has(key)) detectedVideos.delete(key);
    }

    const list = Array.from(detectedVideos.values());
    safeSendMessage({
      action: "REGISTER_VIDEOS",
      videos: list
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(`.${CONTAINER_CLASS}`)) {
      document.querySelectorAll(".binlate-dropdown-menu.binlate-active").forEach(el => el.classList.remove("binlate-active"));
    }
  });

  if (isExtensionValid()) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "SCAN_NOW") {
        scanPageVideos();
        sendResponse({ count: detectedVideos.size, videos: Array.from(detectedVideos.values()) });
      } else if (request.action === "TRIGGER_CURRENT_VIDEO_DOWNLOAD") {
        const firstVideo = document.querySelector("video");
        if (firstVideo) {
          const info = parseVideoElement(firstVideo);
          triggerDownload(info, "HD");
          sendResponse({ status: "triggered" });
        } else {
          showToast("Không tìm thấy video nào trên trang này.");
          sendResponse({ status: "no_video" });
        }
      }
    });
  }

  domObserver = new MutationObserver(() => {
    if (!isExtensionValid()) {
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      return;
    }
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(() => {
      scanPageVideos();
    }, 400);
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanPageVideos);
  } else {
    scanPageVideos();
  }

  console.log("[Bin.Late FB Downloader] Content script running & monitoring videos/reels.");
})();
