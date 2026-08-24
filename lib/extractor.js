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

  function isFacebookMediaHost(hostname) {
    return MEDIA_HOST_PATTERN.test(String(hostname || ""));
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
    if (!cleaned.startsWith("http")) return null;
    return cleaned;
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
            const cu = cleanMediaUrl(m[1]);
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
      audios,
      isDashSeparate: !!(videos.length > 0 && audios.length > 0)
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
    return m ? cleanMediaUrl(m[0]) : null;
  }

  /**
   * Extract progressive URLs or DASH manifest streams from any text snippet.
   */
  function extractStreamsFromText(text) {
    if (!text) return null;

    const hdMatch = text.match(/"(?:playable_url_quality_hd|browser_native_hd_url|hd_src_no_ratelimit|hd_src)"\s*:\s*"([^"]+)"/);
    const sdMatch = text.match(/"(?:playable_url|browser_native_sd_url|sd_src_no_ratelimit|sd_src)"\s*:\s*"([^"]+)"/);

    const progressiveHd = hdMatch ? cleanMediaUrl(hdMatch[1]) : null;
    const progressiveSd = sdMatch ? cleanMediaUrl(sdMatch[1]) : null;

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
          }).filter(Boolean);
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

    // Progressive combined MP4 has both audio and video natively
    const isProgressive = !!(progressiveHd || progressiveSd);
    const resolvedHd = progressiveHd || (dashParsed && dashParsed.hdUrl) || null;
    const resolvedSd = progressiveSd || (dashParsed && dashParsed.sdUrl) || findGenericMp4(text) || resolvedHd;
    const audioUrl = isProgressive ? null : (dashParsed ? dashParsed.audioUrl : null);

    if (resolvedHd || resolvedSd) {
      return {
        hdUrl: resolvedHd,
        sdUrl: resolvedSd,
        audioUrl: audioUrl,
        isProgressive: isProgressive,
        isDashSeparate: !isProgressive && !!(dashParsed && dashParsed.audioUrl)
      };
    }
    return null;
  }

  /**
   * Validate media stream URL for remote download.
   */
  function isValidMediaStream(u) {
    if (!u || typeof u !== "string") return false;
    let parsed;
    try {
      parsed = new URL(u);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    return isFacebookMediaHost(parsed.hostname);
  }

  return {
    decodeFbEscapes,
    cleanMediaUrl,
    parseDashManifest,
    findGenericMp4,
    extractStreamsFromText,
    isFacebookMediaHost,
    isValidMediaStream
  };
});
