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
      .replace(/&quot;/g, '"');
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
  async function fetchWithBudget(url, maxBytesAllowed = MAX_TOTAL_MEDIA_BUDGET, fetchFn = globalThis.fetch) {
    if (typeof fetchFn !== "function") {
      throw new Error("Fetch implementation is not available");
    }
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(`Không thể tải dữ liệu media: HTTP ${res.status}`);
    }

    const clHeader = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null;
    if (clHeader) {
      const cl = parseInt(clHeader, 10);
      if (!isNaN(cl) && cl > maxBytesAllowed) {
        throw new Error(
          `Dung lượng stream (${Math.round(cl / (1024 * 1024))}MB) vượt quá hạn mức bộ nhớ cho phép (${Math.round(maxBytesAllowed / (1024 * 1024))}MB).`
        );
      }
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      // In non-streaming fallback environments, strictly require a valid Content-Length <= maxBytesAllowed
      if (!clHeader || isNaN(parseInt(clHeader, 10))) {
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

    const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
    const baseUrlRegex = /<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i;

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
            return m ? cleanMediaUrl(m[1]) : null;
          }).filter(u => u && isValidMediaStream(u));
          if (extracted.length > 0) {
            dashParsed = {
              hdUrl: extracted[0],
              sdUrl: extracted.length > 1 ? extracted[extracted.length - 1] : extracted[0],
              audioUrl: null,
              videos: [],
              audios: [],
              isDashSeparate: false
            };
          }
        }
      }
    }

    // Progressive format takes priority when available
    if (progressiveHd || progressiveSd) {
      return {
        hdUrl: progressiveHd || progressiveSd,
        sdUrl: progressiveSd || progressiveHd,
        audioUrl: null,
        isProgressive: true,
        isDashSeparate: false
      };
    }

    if (dashParsed && (dashParsed.hdUrl || dashParsed.sdUrl)) {
      return {
        hdUrl: dashParsed.hdUrl,
        sdUrl: dashParsed.sdUrl || dashParsed.hdUrl,
        audioUrl: dashParsed.audioUrl,
        isProgressive: false,
        isDashSeparate: Boolean(dashParsed.isDashSeparate)
      };
    }

    const generic = findGenericMp4(text);
    if (generic) {
      return {
        hdUrl: generic,
        sdUrl: generic,
        audioUrl: null,
        isProgressive: true,
        isDashSeparate: false
      };
    }

    return null;
  }

  return {
    MAX_TOTAL_MEDIA_BUDGET,
    isFacebookMediaHost,
    isValidMediaStream,
    decodeFbEscapes,
    cleanMediaUrl,
    fetchWithBudget,
    parseDashManifest,
    findGenericMp4,
    extractStreamsFromText
  };
});
