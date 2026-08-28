/**
 * Facebook Video & Reel Stream Extractor Core Logic
 * Shared across Content Script, Background Service Worker, and Unit Tests.
 * Author: Bin.Late
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FbExtractor = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MEDIA_HOST_PATTERN = /(?:^|\.)(?:fbcdn\.net|fbsbx\.com)$/i;
  const MAX_TOTAL_MEDIA_BUDGET = 250 * 1024 * 1024; // 250MB combined media allowance

  function isFacebookMediaHost(hostname) {
    return MEDIA_HOST_PATTERN.test(String(hostname || ""));
  }

  /**
   * Validate that URL is HTTPS and belongs to authorized Facebook CDN hosts.
   */
  function isValidMediaStream(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      return isFacebookMediaHost(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  /**
   * Determine whether a page URL structurally represents a dedicated single-video surface
   * (e.g., /reel/<id>, /share/r/<token>, /watch/?v=<id>, /videos/<id>), as opposed to
   * a multi-video feed surface (e.g., generic /watch, /reels, /feed).
   */
  function isDedicatedSingleVideoPage(pathname, search) {
    const path = String(pathname || "");
    const searchStr = String(search || "");
    if (/^\/(?:reel|reels)\/\d{6,30}\/?$/i.test(path)) return true;
    if (/^\/share\/r\/[^/]+\/?$/i.test(path)) return true;
    if (/^\/videos\/(?:[^/]+\/)?\d{6,30}\/?$/i.test(path)) return true;
    if (/^\/watch\/?$/i.test(path)) {
      try {
        const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr : `?${searchStr}`);
        const watchId = params.get("v");
        return Boolean(watchId && /^\d{6,30}$/.test(watchId.trim()));
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /**
   * Decode JSON/Unicode/XML-escaped sequences.
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
      .replace(/&quot;/g, '"')
      // Unescape JSON backslash sequences (\", \/, \\) so DASH XML attributes parse correctly.
      .replace(/\\([\\"'/])/g, "$1");
  }

  /**
   * Clean URL and strip trailing XML tags or byte-range parameters.
   */
  function cleanMediaUrl(u) {
    if (!u || typeof u !== "string") return null;
    let cleaned = decodeFbEscapes(u).trim();
    // Strip trailing %3C/BaseURL or </BaseURL>
    cleaned = cleaned.replace(/(%3C|<)\/?BaseURL.*$/i, "").trim();
    // Strip bytestart/byteend range parameters so the full continuous stream is downloaded
    cleaned = cleaned.replace(/[?&]bytestart=\d+/g, "");
    cleaned = cleaned.replace(/[?&]byteend=\d+/g, "");
    if (!cleaned.includes("?") && cleaned.includes("&")) {
      cleaned = cleaned.replace("&", "?");
    }
    if (!cleaned.startsWith("https://")) return null;
    return isValidMediaStream(cleaned) ? cleaned : null;
  }

  /**
   * Streamed fetch with strict pre-allocation and accumulated size limits.
   * Usable in both browser environments and unit tests.
   */
  async function fetchWithBudget(url, maxBytesAllowed = MAX_TOTAL_MEDIA_BUDGET, fetchFn = globalThis.fetch, fetchInit = null) {
    if (typeof fetchFn !== "function") {
      throw new Error("Fetch implementation is not available");
    }
    // Include cookies so signed fbcdn media URLs resolve in offscreen/service-worker contexts.
    const res = await fetchFn(url, Object.assign({ credentials: "include" }, fetchInit || {}));
    if (!res.ok) {
      throw new Error(`Không thể tải dữ liệu media: HTTP ${res.status}`);
    }

    const clHeader = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null;
    let parsedContentLength = NaN;
    if (clHeader) {
      const trimmedCl = String(clHeader).trim();
      if (/^\d+$/.test(trimmedCl)) {
        parsedContentLength = Number(trimmedCl);
        if (parsedContentLength > maxBytesAllowed) {
          throw new Error(
            `Dung lượng stream (${Math.round(parsedContentLength / (1024 * 1024))}MB) vượt quá hạn mức bộ nhớ cho phép (${Math.round(maxBytesAllowed / (1024 * 1024))}MB).`
          );
        }
      }
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      // In non-streaming fallback environments, strictly require a valid Content-Length <= maxBytesAllowed
      if (isNaN(parsedContentLength)) {
        throw new Error("Môi trường không hỗ trợ ReadableStream và dung lượng dữ liệu không xác định trước qua Content-Length.");
      }
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

    try {
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
    } catch (err) {
      try {
        await reader.cancel("Aborted on error");
      } catch (_) {}
      throw err;
    }

    const mergedBuffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return mergedBuffer.buffer;
  }

  /**
   * Parse DASH MPD XML manifest into ranked HD, SD, and Audio stream URLs.
   */
  function parseDashManifest(manifestText) {
    if (!manifestText) return null;
    const decoded = decodeFbEscapes(manifestText);

    const videos = [];
    const audios = [];

    const adaptRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
    const baseUrlRegex = /<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i;

    let hasRepresentations = false;
    let adaptMatch;

    while ((adaptMatch = adaptRegex.exec(decoded)) !== null) {
      const adaptAttrs = adaptMatch[1];
      const adaptBody = adaptMatch[2];

      const adaptMimeM = adaptAttrs.match(/mimeType=["']([^"']+)["']/i);
      const adaptContentTypeM = adaptAttrs.match(/contentType=["']([^"']+)["']/i);
      const adaptCodecsM = adaptAttrs.match(/codecs=["']([^"']+)["']/i);

      const adaptMime = adaptMimeM ? adaptMimeM[1].toLowerCase() : "";
      const adaptContentType = adaptContentTypeM ? adaptContentTypeM[1].toLowerCase() : "";
      const adaptCodecs = adaptCodecsM ? adaptCodecsM[1].toLowerCase() : "";

      let repMatch;
      repRegex.lastIndex = 0;

      while ((repMatch = repRegex.exec(adaptBody)) !== null) {
        hasRepresentations = true;
        const attrs = repMatch[1];
        const body = repMatch[2];

        const urlMatch = baseUrlRegex.exec(body);
        if (!urlMatch) continue;

        const rawUrl = cleanMediaUrl(urlMatch[1]);
        if (!rawUrl || !isValidMediaStream(rawUrl)) continue;

        const mimeM = attrs.match(/mimeType=["']([^"']+)["']/i);
        const widthM = attrs.match(/width=["'](\d+)["']/i);
        const heightM = attrs.match(/height=["'](\d+)["']/i);
        const bwM = attrs.match(/bandwidth=["'](\d+)["']/i);
        const codecsM = attrs.match(/codecs=["']([^"']+)["']/i);
        const qualityM = attrs.match(/FBQualityLabel=["']([^"']+)["']/i);

        const mime = mimeM ? mimeM[1].toLowerCase() : (adaptMime || adaptContentType || "");
        const width = widthM ? parseInt(widthM[1], 10) : 0;
        const height = heightM ? parseInt(heightM[1], 10) : 0;
        const bandwidth = bwM ? parseInt(bwM[1], 10) : 0;
        const codecs = codecsM ? codecsM[1].toLowerCase() : adaptCodecs;
        const qualityLabel = qualityM ? qualityM[1] : "";

        const isAudio = mime.includes("audio") || adaptContentType.includes("audio") || /^(mp4a|opus|aac)/i.test(codecs);
        const isVideo = !isAudio && (mime.includes("video") || adaptContentType.includes("video") || width > 0 || height > 0 || /^(avc1|vp09|vp9|av01|hev1|hvc1)/i.test(codecs));

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
    }

    if (!hasRepresentations) {
      repRegex.lastIndex = 0;
      let repMatch;
      while ((repMatch = repRegex.exec(decoded)) !== null) {
        const attrs = repMatch[1];
        const body = repMatch[2];

        const urlMatch = baseUrlRegex.exec(body);
        if (!urlMatch) continue;

        const rawUrl = cleanMediaUrl(urlMatch[1]);
        if (!rawUrl || !isValidMediaStream(rawUrl)) continue;

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
    }

    // Direct fallback: scan all <BaseURL> tags if <Representation> regex found none
    if (videos.length === 0) {
      const allBaseUrls = decoded.match(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/gi);
      if (allBaseUrls) {
        for (const bu of allBaseUrls) {
          const m = bu.match(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i);
          if (m) {
            const cu = cleanMediaUrl(m[1]);
            if (cu && isValidMediaStream(cu)) {
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
      audios,
      isDashSeparate: audios.length > 0 && videos.length > 0
    };
  }

  /**
   * Parse GraphQL representations JSON array into ranked Video and Audio stream URLs.
   */
  function parseRepresentationsArray(repArrayText) {
    if (!repArrayText) return null;
    const decoded = decodeFbEscapes(repArrayText);
    const videos = [];
    const audios = [];

    // Match individual representation JSON objects within the array
    const objRegex = /\{[^{}]*?"base_url"\s*:\s*"([^"]+)"[^{}]*?\}/gi;
    let match;
    while ((match = objRegex.exec(decoded)) !== null) {
      const block = match[0];
      const rawUrl = cleanMediaUrl(match[1]);
      if (!rawUrl || !isValidMediaStream(rawUrl)) continue;

      const mimeM = block.match(/"mime_type"\s*:\s*"([^"]+)"/i);
      const widthM = block.match(/"width"\s*:\s*(\d+)/i);
      const heightM = block.match(/"height"\s*:\s*(\d+)/i);
      const bwM = block.match(/"bandwidth"\s*:\s*(\d+)/i);
      const codecsM = block.match(/"codecs"\s*:\s*"([^"]+)"/i);
      const qualityM = block.match(/"(?:quality_label|FBQualityLabel)"\s*:\s*"([^"]+)"/i);

      const mime = mimeM ? mimeM[1].toLowerCase() : "";
      const width = widthM ? parseInt(widthM[1], 10) : 0;
      const height = heightM ? parseInt(heightM[1], 10) : 0;
      const bandwidth = bwM ? parseInt(bwM[1], 10) : 0;
      const codecs = codecsM ? codecsM[1].toLowerCase() : "";
      const qualityLabel = qualityM ? qualityM[1] : "";

      const isAudio = mime.includes("audio") || /^(mp4a|opus|aac)/i.test(codecs) || /audio/i.test(qualityLabel);
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

    // Fallback if structured objects weren't matched: scan all base_url strings
    if (videos.length === 0 && audios.length === 0) {
      const baseUrls = decoded.match(/"base_url"\s*:\s*"([^"]+)"/g);
      if (baseUrls && baseUrls.length > 0) {
        for (const b of baseUrls) {
          const m = b.match(/"base_url"\s*:\s*"([^"]+)"/);
          const cu = m ? cleanMediaUrl(m[1]) : null;
          if (cu && isValidMediaStream(cu)) {
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
      audios,
      isDashSeparate: audios.length > 0 && videos.length > 0
    };
  }

  /**
   * Scan any valid fbcdn MP4 URL embedded inside a text blob.
   */
  function findGenericMp4(text) {
    if (!text) return null;
    const m = text.match(
      /https:\/\/[a-z0-9.-]*fbcdn\.net[^"'\s<>]+?\.mp4[^"'\s<>]*/i
    );
    if (!m) return null;
    const cleaned = cleanMediaUrl(m[0]);
    return isValidMediaStream(cleaned) ? cleaned : null;
  }

  /**
   * Extract progressive URLs or DASH manifest streams from any text snippet.
   */
  function extractStreamsFromText(text) {
    if (!text) return null;

    const hdMatch = text.match(/"(?:playable_url_quality_hd|browser_native_hd_url|hd_src_no_ratelimit|hd_src)"\s*:\s*"([^"]+)"/);
    const sdMatch = text.match(/"(?:playable_url|browser_native_sd_url|sd_src_no_ratelimit|sd_src)"\s*:\s*"([^"]+)"/);

    const rawHd = hdMatch ? cleanMediaUrl(hdMatch[1]) : null;
    const rawSd = sdMatch ? cleanMediaUrl(sdMatch[1]) : null;
    const progressiveHd = isValidMediaStream(rawHd) ? rawHd : null;
    const progressiveSd = isValidMediaStream(rawSd) ? rawSd : null;

    // Check for DASH Manifest
    // Capture until an UNESCAPED closing quote so manifests containing \" survive intact.
    const dashMatch = text.match(/"(?:dash_manifest|playback_video_dash_xml|video_dash_manifest|dash_manifest_xml|dash_prefetch_experimental|playable_url_dash)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let dashParsed = null;
    if (dashMatch) {
      dashParsed = parseDashManifest(dashMatch[1]);
      if (!dashParsed) {
        // Handle double-escaped payloads (\\u003C...) by decoding once more.
        const decodedDash = decodeFbEscapes(dashMatch[1]);
        if (decodedDash !== dashMatch[1]) {
          dashParsed = parseDashManifest(decodedDash);
        }
      }
    } else if (text.includes("<MPD") || text.includes("&lt;MPD") || text.includes("<BaseURL")) {
      dashParsed = parseDashManifest(text);
    }

    // Check GraphQL representations array
    if (!dashParsed) {
      const repArrayMatch = text.match(/"representations"\s*:\s*\[([\s\S]*?)\]/);
      if (repArrayMatch) {
        dashParsed = parseRepresentationsArray(repArrayMatch[1]);
      }
    } else if (!dashParsed.audioUrl) {
      // If dashParsed exists from DASH manifest but has no audio, check representations array for audio
      const repArrayMatch = text.match(/"representations"\s*:\s*\[([\s\S]*?)\]/);
      if (repArrayMatch) {
        const repParsed = parseRepresentationsArray(repArrayMatch[1]);
        if (repParsed && repParsed.audioUrl) {
          dashParsed.audioUrl = repParsed.audioUrl;
          dashParsed.audios = repParsed.audios;
          dashParsed.isDashSeparate = true;
        }
      }
    }

    // Check if there is a standalone audio stream matching the video streams
    const audioMatch = text.match(/"(?:audio_stream_url|audio_url|audio_src|playable_url_quality_audio|browser_native_audio_url)"\s*:\s*"([^"]+)"/);
    const directAudio = audioMatch ? cleanMediaUrl(audioMatch[1]) : null;
    const validDirectAudio = isValidMediaStream(directAudio) ? directAudio : null;

    // Look for standalone audio stream field if dashParsed exists but lacks audioUrl
    if (dashParsed && !dashParsed.audioUrl && validDirectAudio) {
      dashParsed.audioUrl = validDirectAudio;
      dashParsed.isDashSeparate = true;
    }

    // Always preserve progressive URLs so callers can fall back from DASH to progressive
    // if muxing fails (progressive MP4s already contain embedded audio).
    const progHd = progressiveHd || null;
    const progSd = progressiveSd || null;

    // DASH format with separate audio takes priority if available to ensure we have sound
    if (dashParsed && (dashParsed.hdUrl || dashParsed.sdUrl) && dashParsed.audioUrl) {
      return {
        hdUrl: dashParsed.hdUrl,
        sdUrl: dashParsed.sdUrl || dashParsed.hdUrl,
        audioUrl: dashParsed.audioUrl,
        isProgressive: false,
        isDash: true,
        isDashSeparate: Boolean(dashParsed.isDashSeparate),
        progressiveHdUrl: progHd,
        progressiveSdUrl: progSd
      };
    }

    // Progressive format with separate audio stream (DASH properties without MPD XML)
    if ((progressiveHd || progressiveSd) && validDirectAudio) {
      return {
        hdUrl: progressiveHd || progressiveSd,
        sdUrl: progressiveSd || progressiveHd,
        audioUrl: validDirectAudio,
        isProgressive: false,
        isDash: true,
        isDashSeparate: true,
        progressiveHdUrl: progHd,
        progressiveSdUrl: progSd
      };
    }

    // Progressive format takes priority next
    if (progressiveHd || progressiveSd) {
      return {
        hdUrl: progressiveHd || progressiveSd,
        sdUrl: progressiveSd || progressiveHd,
        audioUrl: null,
        isProgressive: true,
        isDash: false,
        isDashSeparate: false,
        progressiveHdUrl: progHd,
        progressiveSdUrl: progSd
      };
    }

    if (dashParsed && (dashParsed.hdUrl || dashParsed.sdUrl)) {
      return {
        hdUrl: dashParsed.hdUrl,
        sdUrl: dashParsed.sdUrl || dashParsed.hdUrl,
        audioUrl: dashParsed.audioUrl,
        isProgressive: false,
        isDash: true,
        isDashSeparate: Boolean(dashParsed.isDashSeparate),
        progressiveHdUrl: progHd,
        progressiveSdUrl: progSd
      };
    }

    const generic = findGenericMp4(text);
    if (generic) {
      return {
        hdUrl: generic,
        sdUrl: generic,
        audioUrl: null,
        isProgressive: true,
        isDash: false,
        isDashSeparate: false,
        progressiveHdUrl: progHd,
        progressiveSdUrl: progSd
      };
    }

    return null;
  }

  /**
   * Determine if an identifier is a canonical Facebook numeric media ID (usually 8-25 digits).
   */
  function isNumericFacebookId(id) {
    if (!id || typeof id !== "string") return false;
    return /^\d{6,30}$/.test(id.trim());
  }

  /**
   * Extract authoritative canonical Facebook video or reel ID.
   * Priority:
   * 1. Numeric ID from canonical URL patterns (/videos/.../\d+, /reel/\d+, /reels/\d+, watch?v=\d+)
   * 2. Authoritative numeric ID from DOM element / parent data attributes (data-video-id, data-reel-id, data-store)
   * 3. Numeric ID from page pathname
   * NOTE: Navigation share tokens (/share/r/<token>) and synthetic IDs (vid_*) are NEVER treated as videoId.
   */
  function extractCanonicalVideoId(url, element, currentPath = "") {
    // 1. Direct canonical URL patterns with numeric IDs
    if (url && typeof url === "string") {
      const numReel = url.match(/\/(?:reel|reels)\/(\d{6,30})/i);
      if (numReel) return numReel[1];

      const watchMatch = url.match(/[?&]v=(\d{6,30})/);
      if (watchMatch) return watchMatch[1];

      const videoMatch = url.match(/\/videos\/(?:[^/]+\/)?(\d{6,30})/);
      if (videoMatch) return videoMatch[1];
    }

    // 2. Element's own and parent DOM metadata (always preferred over non-numeric share tokens)
    if (element) {
      const rawReelId = typeof element.getAttribute === "function" ? element.getAttribute("data-reel-id") : null;
      if (isNumericFacebookId(rawReelId)) return rawReelId.trim();

      const rawVideoId = typeof element.getAttribute === "function" ? element.getAttribute("data-video-id") : null;
      if (isNumericFacebookId(rawVideoId)) return rawVideoId.trim();

      // Parent container metadata
      if (typeof element.closest === "function") {
        const postContainer = element.closest('[data-video-id], [data-reel-id], [data-store*="video_id"], [data-store*="reel_id"]');
        if (postContainer) {
          const directReel = postContainer.getAttribute("data-reel-id");
          if (isNumericFacebookId(directReel)) return directReel.trim();

          const directVideo = postContainer.getAttribute("data-video-id");
          if (isNumericFacebookId(directVideo)) return directVideo.trim();

          const dataStore = postContainer.getAttribute("data-store");
          const match = dataStore?.match(/"(?:video_id|reel_id)":\s*"?(\d{6,30})"?/);
          if (match) return match[1];
        }
      }
    }

    // 3. Fallback to current page pathname if numeric
    const pathToCheck = currentPath || (typeof window !== "undefined" && window.location ? window.location.pathname : "");
    if (pathToCheck) {
      const pathReel = pathToCheck.match(/\/(?:reel|reels)\/(\d{6,30})/i);
      if (pathReel) return pathReel[1];
      const pathVideo = pathToCheck.match(/\/videos\/(?:[^/]+\/)?(\d{6,30})/);
      if (pathVideo) return pathVideo[1];
    }

    return null;
  }

  /**
   * Extract video stream configurations from embedded script text safely.
   * Parses nested JSON structures within balanced object boundaries without prematurely breaking on inner non-video objects.
   */
  /**
   * Extract video stream configurations from embedded script text safely.
   * Performs a single structural linear pass over the text using a stack to track enclosing JSON objects.
   */
  /**
   * Extract video stream configurations from embedded script text safely and efficiently.
   * Performs a single structural linear pass over the text using a stack to track enclosing JSON objects.
   */
  function extractUrlsFromScriptText(raw) {
    const urlsMap = new Map();
    if (!raw || typeof raw !== "string" || raw.length < 30) return urlsMap;

    const hasVideoKeys =
      raw.includes("dash_manifest") ||
      raw.includes("playback_video_dash_xml") ||
      raw.includes("video_dash_manifest") ||
      raw.includes("dash_prefetch_experimental") ||
      raw.includes("playable_url_dash") ||
      raw.includes("representations") ||
      raw.includes("playable_url") ||
      raw.includes("browser_native_hd_url") ||
      raw.includes("browser_native_sd_url") ||
      raw.includes("audio_stream_url");

    if (!hasVideoKeys) return urlsMap;

    const texts = [raw];
    const decoded = decodeFbEscapes(raw);
    if (decoded !== raw) texts.push(decoded);

    for (const text of texts) {
      const stack = []; // stores { start: number, hasStreamKey: boolean, videoId: string|null, candidateId: string|null, isVideoNode: boolean }
      let inString = false;
      let escaped = false;
      let stringStart = -1;
      let lastKey = null;
      const len = text.length;

      for (let i = 0; i < len; i++) {
        const char = text[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          if (!inString) {
            inString = true;
            stringStart = i + 1;
          } else {
            inString = false;
            const strVal = text.substring(stringStart, i);
            const currentFrame = stack.length > 0 ? stack[stack.length - 1] : null;

            if (currentFrame) {
              if (
                strVal === "dash_manifest" ||
                strVal === "playback_video_dash_xml" ||
                strVal === "video_dash_manifest" ||
                strVal === "dash_manifest_xml" ||
                strVal === "dash_manifest_raw" ||
                strVal === "representations" ||
                strVal === "playable_url_quality_hd" ||
                strVal === "browser_native_hd_url" ||
                strVal === "playable_url" ||
                strVal === "browser_native_sd_url" ||
                strVal === "playable_url_dash" ||
                strVal === "dash_prefetch_experimental" ||
                strVal === "audio_stream_url" ||
                strVal === "audio_url" ||
                strVal === "audio_src" ||
                strVal === "browser_native_audio_url"
              ) {
                currentFrame.hasDirectStreamKey = true;
                currentFrame.hasStreamKey = true;
              }

              if (strVal === "Video" && (lastKey === "__typename" || lastKey === "type")) {
                currentFrame.isVideoNode = true;
                currentFrame.isExplicitVideoTypename = true;
              }

              // Capture direct stream values belonging to this exact JSON frame
              if (
                lastKey === "browser_native_hd_url" ||
                lastKey === "playable_url_quality_hd" ||
                lastKey === "hd_src" ||
                lastKey === "hd_src_no_ratelimit"
              ) {
                currentFrame.directStreams.hdUrl = strVal;
              } else if (
                lastKey === "browser_native_sd_url" ||
                lastKey === "playable_url" ||
                lastKey === "sd_src" ||
                lastKey === "sd_src_no_ratelimit"
              ) {
                currentFrame.directStreams.sdUrl = strVal;
              } else if (
                lastKey === "audio_stream_url" ||
                lastKey === "audio_url" ||
                lastKey === "audio_src" ||
                lastKey === "browser_native_audio_url" ||
                lastKey === "playable_url_quality_audio"
              ) {
                currentFrame.directStreams.audioUrl = strVal;
              } else if (
                lastKey === "dash_manifest" ||
                lastKey === "playback_video_dash_xml" ||
                lastKey === "video_dash_manifest" ||
                lastKey === "dash_manifest_xml" ||
                lastKey === "dash_manifest_raw"
              ) {
                currentFrame.directStreams.dashManifest = strVal;
              }

              if (lastKey === "video_id" || lastKey === "videoId") {
                if (/^\d{6,30}$/.test(strVal)) {
                  currentFrame.videoId = strVal;
                }
              } else if (lastKey === "id") {
                if (/^\d{6,30}$/.test(strVal)) {
                  if (currentFrame.isVideoNode) {
                    currentFrame.videoId = strVal;
                  } else {
                    currentFrame.candidateId = strVal;
                  }
                }
              }

              // Lookahead to see if this string was a key ("key":)
              let peek = i + 1;
              while (peek < len && (text[peek] === " " || text[peek] === "\t" || text[peek] === "\r" || text[peek] === "\n")) {
                peek++;
              }
              if (peek < len && text[peek] === ":") {
                lastKey = strVal;
              } else {
                lastKey = null;
              }
            }
          }
          continue;
        }

        if (!inString) {
          if (char === "{") {
            const isStreamProp = lastKey === "video" || lastKey === "story_video" || lastKey === "playback_video";
            stack.push({
              start: i,
              hasDirectStreamKey: false,
              videoId: null,
              candidateId: null,
              isVideoNode: false,
              isExplicitVideoTypename: false,
              isStreamContainerProp: isStreamProp,
              directStreams: {
                hdUrl: null,
                sdUrl: null,
                audioUrl: null,
                dashManifest: null
              }
            });
            lastKey = null;
          } else if (char === "}") {
            if (stack.length > 0) {
              const frame = stack.pop();

              if (frame.hasDirectStreamKey) {
                const effectiveId =
                  frame.videoId ||
                  (frame.isVideoNode || frame.hasDirectStreamKey ? frame.candidateId : null);

                if (effectiveId) {
                  let streams = null;
                  const d = frame.directStreams;

                  // 1. Prefer direct frame-level streams (guarantees strict sibling scoping)
                  if (d && d.dashManifest) {
                    let dp = parseDashManifest(d.dashManifest);
                    if (!dp) {
                      const decodedDash = decodeFbEscapes(d.dashManifest);
                      if (decodedDash !== d.dashManifest) dp = parseDashManifest(decodedDash);
                    }
                    if (dp) {
                      if (!dp.audioUrl && d.audioUrl) {
                        const da = cleanMediaUrl(d.audioUrl);
                        if (isValidMediaStream(da)) {
                          dp.audioUrl = da;
                          dp.isDashSeparate = true;
                        }
                      }
                      const progHd = isValidMediaStream(cleanMediaUrl(d.hdUrl)) ? cleanMediaUrl(d.hdUrl) : null;
                      const progSd = isValidMediaStream(cleanMediaUrl(d.sdUrl)) ? cleanMediaUrl(d.sdUrl) : null;
                      streams = {
                        hdUrl: dp.hdUrl || dp.sdUrl,
                        sdUrl: dp.sdUrl || dp.hdUrl,
                        audioUrl: dp.audioUrl || null,
                        isProgressive: false,
                        isDash: true,
                        isDashSeparate: Boolean(dp.isDashSeparate),
                        progressiveHdUrl: progHd,
                        progressiveSdUrl: progSd
                      };
                    }
                  } else if (d && (d.hdUrl || d.sdUrl)) {
                    const rawHd = cleanMediaUrl(d.hdUrl);
                    const rawSd = cleanMediaUrl(d.sdUrl);
                    const validHd = isValidMediaStream(rawHd) ? rawHd : null;
                    const validSd = isValidMediaStream(rawSd) ? rawSd : null;
                    const rawAudio = cleanMediaUrl(d.audioUrl);
                    const validAudio = isValidMediaStream(rawAudio) ? rawAudio : null;
                    if (validHd || validSd) {
                      streams = {
                        hdUrl: validHd || validSd,
                        sdUrl: validSd || validHd,
                        audioUrl: validAudio,
                        isProgressive: !validAudio,
                        isDash: Boolean(validAudio),
                        isDashSeparate: Boolean(validAudio),
                        progressiveHdUrl: validHd,
                        progressiveSdUrl: validSd
                      };
                    }
                  }

                  // 2. Fallback to block parsing only if direct stream key exists (e.g. representations array)
                  if (!streams && frame.hasDirectStreamKey) {
                    const block = text.substring(frame.start, i + 1);
                    streams = extractStreamsFromText(block);
                  }

                  if (streams && (streams.hdUrl || streams.sdUrl || streams.audioUrl)) {
                    if (!urlsMap.has(effectiveId) || (streams.audioUrl && !urlsMap.get(effectiveId).audioUrl)) {
                      urlsMap.set(effectiveId, streams);
                    }
                  }
                } else if (
                  stack.length > 0 &&
                  stack[stack.length - 1].isExplicitVideoTypename &&
                  frame.isStreamContainerProp
                ) {
                  // Structured transfer to explicit Video parent ONLY when child is a stream property and has no ID
                  const parent = stack[stack.length - 1];
                  if (!parent.directStreams.dashManifest && !parent.directStreams.hdUrl && !parent.directStreams.sdUrl) {
                    parent.directStreams = frame.directStreams;
                    parent.hasDirectStreamKey = true;
                  }
                }
              }
            }
          } else if ((char >= "0" && char <= "9") && (lastKey === "video_id" || lastKey === "videoId" || lastKey === "id")) {
            // Unquoted numeric literal ID
            let numEnd = i;
            while (numEnd < len && (text[numEnd] >= "0" && text[numEnd] <= "9")) {
              numEnd++;
            }
            const numVal = text.substring(i, numEnd);
            if (numVal.length >= 6 && numVal.length <= 30 && stack.length > 0) {
              const currentFrame = stack[stack.length - 1];
              if (lastKey === "video_id" || lastKey === "videoId") {
                currentFrame.videoId = numVal;
              } else if (lastKey === "id") {
                if (currentFrame.isVideoNode) {
                  currentFrame.videoId = numVal;
                } else {
                  currentFrame.candidateId = numVal;
                }
              }
            }
            i = numEnd - 1;
            lastKey = null;
          }
        }
      }
    }

    return urlsMap;
  }

  return {
    MAX_TOTAL_MEDIA_BUDGET,
    isFacebookMediaHost,
    isValidMediaStream,
    isNumericFacebookId,
    extractCanonicalVideoId,
    decodeFbEscapes,
    cleanMediaUrl,
    fetchWithBudget,
    parseDashManifest,
    parseRepresentationsArray,
    findGenericMp4,
    extractStreamsFromText,
    extractUrlsFromScriptText,
    isDedicatedSingleVideoPage
  };
});
