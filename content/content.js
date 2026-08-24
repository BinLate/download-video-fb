/**
 * Download Video / Reel Facebook - Content Script
 * Author: Bin.Late
 */

(function () {
  "use strict";

  const PROCESSED_ATTR = "data-binlate-processed";
  const BUTTON_CLASS = "binlate-fb-dl-btn";
  const CONTAINER_CLASS = "binlate-fb-dl-container";

  let detectedVideos = new Map();
  let scanDebounceTimer = null;

  // SVG Icons
  const ICONS = {
    download: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    hd: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15V9m4 0v6m-4-3h4m4 0h3a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-3v6z"/></svg>`,
    sd: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 10c0-1 1-1.5 2-1.5s2 .5 2 1.5c0 1.5-2 1.5-2 2.5 0 1 1 1.5 2 1.5s2-.5 2-1.5m4-5.5h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-3V9z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
  };

  /**
   * Decode JSON/Unicode/XML-escaped sequences commonly found in FB payloads.
   */
  function decodeFbEscapes(text) {
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
  }

  function cleanBaseUrl(url) {
    if (!url) return null;
    let u = decodeFbEscapes(url).trim();
    // Strip trailing tags or encoded artifacts like %3C/BaseURL or </BaseURL>
    u = u.replace(/(%3C|<)\/?BaseURL.*$/i, "").trim();
    if (!u.startsWith("http")) return null;
    return u;
  }

  /**
   * Parse DASH MPD XML manifest into ranked HD, SD, and Audio stream URLs.
   */
  function parseDashManifest(manifestText) {
    if (!manifestText) return null;
    const decoded = decodeFbEscapes(manifestText);

    const videos = [];
    const audios = [];

    const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
    const baseUrlRegex = /<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i;

    let repMatch;
    while ((repMatch = repRegex.exec(decoded)) !== null) {
      const attrs = repMatch[1];
      const body = repMatch[2];

      const urlMatch = baseUrlRegex.exec(body);
      if (!urlMatch) continue;

      const rawUrl = cleanBaseUrl(urlMatch[1]);
      if (!rawUrl) continue;

      const mimeM = attrs.match(/mimeType=["']([^"']+)["']/i);
      const widthM = attrs.match(/width=["'](\d+)["']/i);
      const heightM = attrs.match(/height=["'](\d+)["']/i);
      const bwM = attrs.match(/bandwidth=["'](\d+)["']/i);
      const codecsM = attrs.match(/codecs=["']([^"']+)["']/i);
      const qualityM = attrs.match(/FBQualityLabel=["']([^"']+)["']/i);

      const mime = mimeM ? mimeM[1].toLowerCase() : "";
      const width = widthM ? parseInt(widthM[1], 10) : 0;
      const height = heightM ? parseInt(heightM[1], 10) : 0;
      const bandwidth = bwM ? parseInt(bwM[1], 10) : 0;
      const codecs = codecsM ? codecsM[1].toLowerCase() : "";
      const qualityLabel = qualityM ? qualityM[1] : "";

      const isAudio = mime.includes("audio") || /^(mp4a|opus|aac)/i.test(codecs);
      const isVideo = !isAudio && (mime.includes("video") || width > 0 || height > 0 || /^(avc1|vp09|vp9|av01|hev1|hvc1)/i.test(codecs));

      const item = {
        url: rawUrl,
        width,
        height,
        bandwidth,
        codecs,
        qualityLabel,
        mime
      };

      if (isAudio) {
        audios.push(item);
      } else {
        videos.push(item);
      }
    }

    // Direct fallback: scan all <BaseURL> tags if <Representation> regex found none
    if (videos.length === 0) {
      const allBaseUrls = decoded.match(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/gi);
      if (allBaseUrls) {
        for (const bu of allBaseUrls) {
          const m = bu.match(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i);
          if (m) {
            const cu = cleanBaseUrl(m[1]);
            if (cu && (cu.includes("fbcdn.net") || cu.includes("fbsbx.com"))) {
              videos.push({
                url: cu,
                width: 0,
                height: 0,
                bandwidth: 0,
                codecs: "",
                qualityLabel: "",
                mime: "video/mp4"
              });
            }
          }
        }
      }
    }

    if (videos.length === 0 && audios.length === 0) return null;

    videos.sort((a, b) => (b.height * b.width - a.height * a.width) || (b.bandwidth - a.bandwidth) || (b.height - a.height));
    audios.sort((a, b) => b.bandwidth - a.bandwidth);

    const hdUrl = videos.length > 0 ? videos[0].url : null;
    let sdUrl = null;
    if (videos.length > 1) {
      const sdCandidate = videos.find(v => v.height > 0 && v.height <= 640);
      sdUrl = sdCandidate ? sdCandidate.url : videos[videos.length - 1].url;
    } else {
      sdUrl = hdUrl;
    }

    return {
      hdUrl,
      sdUrl,
      audioUrl: audios.length > 0 ? audios[0].url : null,
      videos,
      audios
    };
  }

  /**
   * Scan any fbcdn MP4 URL embedded inside a text blob.
   */
  function findGenericMp4(text) {
    if (!text) return null;
    const m = text.match(
      /https?(?::\\?\/\\?\/)[a-z0-9.-]*fbcdn\.net[^"'\s<>]+?\.mp4[^"'\s<>]*/i
    );
    return m ? cleanBaseUrl(m[0]) : null;
  }

  /**
   * Extract progressive URLs or DASH manifest streams from any text snippet.
   */
  function extractStreamsFromText(text) {
    if (!text) return null;

    const hdMatch = text.match(/"(?:playable_url_quality_hd|browser_native_hd_url|hd_src_no_ratelimit|hd_src)"\s*:\s*"([^"]+)"/);
    const sdMatch = text.match(/"(?:playable_url|browser_native_sd_url|sd_src_no_ratelimit|sd_src)"\s*:\s*"([^"]+)"/);

    const progressiveHd = hdMatch ? cleanBaseUrl(hdMatch[1]) : null;
    const progressiveSd = sdMatch ? cleanBaseUrl(sdMatch[1]) : null;

    // Check for DASH Manifest
    const dashMatch = text.match(/"(?:dash_manifest|playback_video_dash_xml|video_dash_manifest|dash_manifest_xml)"\s*:\s*"([^"]+)"/);
    let dashParsed = null;
    if (dashMatch) {
      dashParsed = parseDashManifest(dashMatch[1]);
    } else if (text.includes("<MPD") || text.includes("&lt;MPD") || text.includes("<BaseURL")) {
      dashParsed = parseDashManifest(text);
    }

    // Check GraphQL representations array
    if (!progressiveHd && !dashParsed) {
      const repArrayMatch = text.match(/"representations"\s*:\s*\[([\s\S]*?)\]/);
      if (repArrayMatch) {
        const baseUrls = repArrayMatch[1].match(/"base_url"\s*:\s*"([^"]+)"/g);
        if (baseUrls && baseUrls.length > 0) {
          const extracted = baseUrls.map(b => {
            const m = b.match(/"base_url"\s*:\s*"([^"]+)"/);
            return m ? cleanBaseUrl(m[1]) : null;
          }).filter(Boolean);
          if (extracted.length > 0) {
            dashParsed = {
              hdUrl: extracted[0],
              sdUrl: extracted.length > 1 ? extracted[extracted.length - 1] : extracted[0],
              audioUrl: null,
              videos: [],
              audios: []
            };
          }
        }
      }
    }

    const resolvedHd = progressiveHd || (dashParsed && dashParsed.hdUrl) || null;
    const resolvedSd = progressiveSd || (dashParsed && dashParsed.sdUrl) || findGenericMp4(text) || resolvedHd;

    if (resolvedHd || resolvedSd) {
      return {
        hdUrl: resolvedHd,
        sdUrl: resolvedSd,
        audioUrl: dashParsed ? dashParsed.audioUrl : null
      };
    }
    return null;
  }

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
      const decodedFull = decodeFbEscapes(raw);
      if (decodedFull !== raw) texts.add(decodedFull);

      for (const text of texts) {
        // Match JSON object blocks containing video id
        const objectRegex = /\{[^{}]*?"(?:video_id|id)"\s*:\s*"?(\d{8,25})"[^{}]*?\}/g;
        let match;

        while ((match = objectRegex.exec(text)) !== null) {
          const block = match[0];
          const videoId = match[1];
          const streams = extractStreamsFromText(block);
          if (streams) {
            urlsMap.set(videoId, streams);
          }
        }

        // Broader nested structure matching within ~4000 chars of video ID
        const broaderRegex = /"(?:video_id|id)"\s*:\s*"(\d{8,25})"[\s\S]{0,4000}?"(?:playable_url_quality_hd|browser_native_hd_url|playable_url|browser_native_sd_url|dash_manifest|playback_video_dash_xml|<BaseURL)"/g;
        let broaderMatch;
        while ((broaderMatch = broaderRegex.exec(text)) !== null) {
          const id = broaderMatch[1];
          if (!urlsMap.has(id)) {
            const section = text.substring(broaderMatch.index, Math.min(text.length, broaderMatch.index + 4000));
            const streams = extractStreamsFromText(section);
            if (streams) {
              urlsMap.set(id, streams);
            }
          }
        }

        // Global / page-level manifest fallback
        const globalStreams = extractStreamsFromText(text);
        if (globalStreams) {
          if (!urlsMap.has("fallback_any")) {
            urlsMap.set("fallback_any", globalStreams);
          }
          // If on a Reel page, associate with the current URL Reel ID
          const reelMatch = window.location.pathname.match(/\/reel(?:s)?\/(\d+)/);
          if (reelMatch && !urlsMap.has(reelMatch[1])) {
            urlsMap.set(reelMatch[1], globalStreams);
          }
          const videoMatch = window.location.pathname.match(/\/videos\/(\d+)/);
          if (videoMatch && !urlsMap.has(videoMatch[1])) {
            urlsMap.set(videoMatch[1], globalStreams);
          }
        }
      }
    }

    return urlsMap;
  }

  /**
   * Determine if the element is inside a Facebook Reel container or URL
   */
  function isReelContext(element) {
    if (window.location.pathname.includes("/reel/") || window.location.pathname.includes("/reels/")) {
      return true;
    }
    const reelContainer = element.closest('[aria-label*="Reel"], [data-pagelet*="Reel"], a[href*="/reel/"]');
    return !!reelContainer;
  }

  /**
   * Extract video ID from link, container, or pathname
   */
  function extractVideoId(postLink, element) {
    if (postLink) {
      const reelMatch = postLink.match(/\/reel(?:s)?\/(\d+)/);
      if (reelMatch) return reelMatch[1];
      const videoMatch = postLink.match(/\/videos\/(\d+)/) || postLink.match(/[?&]v=(\d+)/);
      if (videoMatch) return videoMatch[1];
    }
    if (element) {
      const postContainer = element.closest('[data-video-id], [data-store*="video_id"]');
      if (postContainer) {
        const directId = postContainer.getAttribute("data-video-id");
        if (directId) return directId;
        const dataStore = postContainer.getAttribute("data-store");
        const match = dataStore?.match(/"video_id":\s*"?(\d+)"?/);
        if (match) return match[1];
      }
    }
    const pathReel = window.location.pathname.match(/\/reel(?:s)?\/(\d+)/);
    if (pathReel) return pathReel[1];
    const pathVideo = window.location.pathname.match(/\/videos\/(\d+)/);
    if (pathVideo) return pathVideo[1];

    return null;
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
      const linkElem = postContainer.querySelector('a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch/"], a[href*="watch?v="]');
      if (linkElem) {
        postLink = linkElem.href;
      } else if (/\/(reel|videos|watch)\//.test(window.location.pathname) && /^https?:\/\/[^/]*facebook\.com/.test(window.location.href)) {
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
          await navigator.clipboard.writeText(targetUrl);
          showToast("Đã sao chép liên kết vào clipboard!");
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
    showToast(`Đang chuẩn bị tải ${videoInfo.type.toUpperCase()} (${quality})...`);

    let downloadUrl = null;
    const scriptUrls = extractUrlsFromScripts();

    // Match exact videoId to its streams
    if (videoInfo.videoId && scriptUrls.has(videoInfo.videoId)) {
      const match = scriptUrls.get(videoInfo.videoId);
      if (quality === "HD" && match.hdUrl) {
        downloadUrl = match.hdUrl;
      } else if (match.sdUrl) {
        downloadUrl = match.sdUrl;
      } else if (match.hdUrl) {
        downloadUrl = match.hdUrl;
      }
    } else if (scriptUrls.has("fallback_any")) {
      const match = scriptUrls.get("fallback_any");
      if (quality === "HD" && match.hdUrl) {
        downloadUrl = match.hdUrl;
      } else if (match.sdUrl) {
        downloadUrl = match.sdUrl;
      } else if (match.hdUrl) {
        downloadUrl = match.hdUrl;
      }
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

    // Direct stream URL on element
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

    chrome.runtime.sendMessage(
      {
        action: "DOWNLOAD_FILE",
        payload: {
          url: downloadUrl,
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
        if (chrome.runtime.lastError) {
          showToast(`⚠️ Lỗi kết nối tiện ích: ${chrome.runtime.lastError.message}`);
          return;
        }
        if (res && res.success) {
          showToast(`✅ Đang tải xuống: ${videoInfo.title.substring(0, 25)}...`);
        } else {
          const errMsg = res?.error || "Không tìm thấy luồng video. Hãy phát video vài giây rồi thử lại.";
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
      } else if (scriptData.has("fallback_any")) {
        const entry = scriptData.get("fallback_any");
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
    chrome.runtime.sendMessage({
      action: "REGISTER_VIDEOS",
      videos: list
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(`.${CONTAINER_CLASS}`)) {
      document.querySelectorAll(".binlate-dropdown-menu.binlate-active").forEach(el => el.classList.remove("binlate-active"));
    }
  });

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

  const observer = new MutationObserver(() => {
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(() => {
      scanPageVideos();
    }, 400);
  });

  observer.observe(document.body, {
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

