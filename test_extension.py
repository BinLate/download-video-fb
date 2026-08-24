"""
Unit tests for Download Video / Reel Facebook Chrome Extension.
Tests manifest integrity, DASH manifest parsing, JSON extraction, and URL classification.
"""

import json
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse

WORKSPACE_ROOT = Path(__file__).resolve().parent

class TestExtensionManifest(unittest.TestCase):
    def setUp(self):
        manifest_path = WORKSPACE_ROOT / "manifest.json"
        self.assertTrue(manifest_path.exists(), "manifest.json must exist")
        with open(manifest_path, "r", encoding="utf-8") as f:
            self.manifest = json.load(f)

    def test_manifest_version_and_metadata(self):
        self.assertEqual(self.manifest.get("manifest_version"), 3)
        self.assertIn("name", self.manifest)
        self.assertIn("version", self.manifest)
        self.assertIn("permissions", self.manifest)
        self.assertIn("host_permissions", self.manifest)

    def test_required_permissions(self):
        permissions = self.manifest.get("permissions", [])
        for perm in ["downloads", "activeTab", "contextMenus", "webRequest", "storage"]:
            self.assertIn(perm, permissions, f"Missing permission: {perm}")

    def test_host_permissions(self):
        hosts = self.manifest.get("host_permissions", [])
        self.assertTrue(any("facebook.com" in h for h in hosts))
        self.assertTrue(any("fbcdn.net" in h for h in hosts))
        self.assertTrue(any("fbsbx.com" in h for h in hosts))

    def test_content_scripts_and_worker(self):
        self.assertEqual(self.manifest.get("background", {}).get("service_worker"), "background.js")
        content_scripts = self.manifest.get("content_scripts", [])
        self.assertTrue(len(content_scripts) > 0)
        self.assertIn("content/content.js", content_scripts[0].get("js", []))


def decode_fb_escapes(text: str) -> str:
    if not text:
        return ""
    # Unicode escapes \uXXXX
    text = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), text)
    # Hex escapes \xXX
    text = re.sub(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m.group(1), 16)), text)
    # Backslashes before forward slashes e.g. \/ -> / and \\/ -> /
    text = re.sub(r'\\+/', '/', text)
    # Escaped quotes
    text = re.sub(r'\\+"', '"', text)
    # XML entities
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    return text


def parse_dash_manifest(manifest_text: str):
    """
    Robust DASH MPD manifest parser supporting both XML strings and raw JSON fragments.
    """
    if not manifest_text:
        return {"hdUrl": None, "sdUrl": None, "audioUrl": None, "videos": [], "audios": []}

    decoded = decode_fb_escapes(manifest_text)
    
    videos = []
    audios = []

    # 1. Structured XML <Representation> parsing
    rep_regex = re.compile(r'<Representation\b([^>]*)>([\s\S]*?)<\/Representation>', re.IGNORECASE)
    base_url_regex = re.compile(r'<BaseURL\b[^>]*>([^<]+)<\/BaseURL>', re.IGNORECASE)

    for match in rep_regex.finditer(decoded):
        attrs = match.group(1)
        body = match.group(2)

        url_match = base_url_regex.search(body)
        if not url_match:
            continue
        raw_url = url_match.group(1).strip()
        # Clean IDM or tag artifacts
        raw_url = re.sub(r'(%3C|<)\/?BaseURL.*$', '', raw_url, flags=re.IGNORECASE).strip()
        if not raw_url.startswith("http"):
            continue

        mime_m = re.search(r'mimeType=["\']([^"\']+)["\']', attrs, re.I)
        width_m = re.search(r'width=["\'](\d+)["\']', attrs, re.I)
        height_m = re.search(r'height=["\'](\d+)["\']', attrs, re.I)
        bw_m = re.search(r'bandwidth=["\'](\d+)["\']', attrs, re.I)
        codecs_m = re.search(r'codecs=["\']([^"\']+)["\']', attrs, re.I)
        quality_m = re.search(r'FBQualityLabel=["\']([^"\']+)["\']', attrs, re.I)

        mime = mime_m.group(1).lower() if mime_m else ""
        width = int(width_m.group(1)) if width_m else 0
        height = int(height_m.group(1)) if height_m else 0
        bandwidth = int(bw_m.group(1)) if bw_m else 0
        codecs = codecs_m.group(1).lower() if codecs_m else ""
        quality_label = quality_m.group(1) if quality_m else ""

        is_audio = "audio" in mime or codecs.startswith(("mp4a", "opus", "aac"))
        is_video = not is_audio and ("video" in mime or width > 0 or height > 0 or codecs.startswith(("avc1", "vp09", "vp9", "av01", "hev1", "hvc1")))

        item = {
            "url": raw_url,
            "width": width,
            "height": height,
            "bandwidth": bandwidth,
            "codecs": codecs,
            "qualityLabel": quality_label,
            "mime": mime
        }

        if is_audio:
            audios.append(item)
        else:
            videos.append(item)

    # 2. Fallback direct <BaseURL> extraction if no <Representation> tags parsed
    if not videos:
        direct_baseurls = base_url_regex.findall(decoded)
        for u in direct_baseurls:
            cleaned_u = re.sub(r'(%3C|<)\/?BaseURL.*$', '', u, flags=re.IGNORECASE).strip()
            if cleaned_u.startswith("http") and ("fbcdn.net" in cleaned_u or "fbsbx.com" in cleaned_u):
                videos.append({
                    "url": cleaned_u,
                    "width": 0,
                    "height": 0,
                    "bandwidth": 0,
                    "codecs": "",
                    "qualityLabel": "",
                    "mime": "video/mp4"
                })

    # Sort video representations by resolution and bandwidth
    videos.sort(key=lambda x: (x["height"] * x["width"], x["bandwidth"], x["height"]), reverse=True)
    audios.sort(key=lambda x: x["bandwidth"], reverse=True)

    hd_url = videos[0]["url"] if videos else None
    # SD URL is medium/lower representation if multiple available
    sd_url = None
    if len(videos) > 1:
        # Find a representation around 360p-540p or second half
        sd_candidates = [v for v in videos if v["height"] <= 640 and v["height"] > 0]
        sd_url = sd_candidates[0]["url"] if sd_candidates else videos[-1]["url"]
    else:
        sd_url = hd_url

    audio_url = audios[0]["url"] if audios else None

    return {
        "hdUrl": hd_url,
        "sdUrl": sd_url,
        "audioUrl": audio_url,
        "videos": videos,
        "audios": audios
    }


class TestDashParsingLogic(unittest.TestCase):
    SAMPLE_DASH_XML = """
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT0H0M28.461S">
      <Period duration="PT0H0M28.461S">
        <AdaptationSet segmentAlignment="true" maxWidth="1080" maxHeight="1920" contentType="video">
          <Representation id="1080p_hd" mimeType="video/mp4" codecs="avc1.64002a" width="1080" height="1920" bandwidth="4200000" FBQualityLabel="1080p">
            <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_1080p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
          </Representation>
          <Representation id="720p_hd" mimeType="video/mp4" codecs="avc1.64001f" width="720" height="1280" bandwidth="2100000" FBQualityLabel="720p">
            <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_720p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
          </Representation>
          <Representation id="360p_sd" mimeType="video/mp4" codecs="avc1.4d401f" width="360" height="640" bandwidth="650000" FBQualityLabel="360p">
            <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_360p.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
          </Representation>
        </AdaptationSet>
        <AdaptationSet contentType="audio">
          <Representation id="audio_1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000">
            <BaseURL>https://video-sin6-4.xx.fbcdn.net/o1/v/t2/f2/m86/AQN_audio.mp4?_nc_cat=101&amp;oe=6A91A3F3</BaseURL>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>
    """

    SAMPLE_ESCAPED_DASH_JSON = json.dumps({
        "dash_manifest": "<MPD><Period><AdaptationSet><Representation id=\"1\" mimeType=\"video/mp4\" width=\"1080\" height=\"1920\" bandwidth=\"3500000\"><BaseURL>https:\\/\\/video.xx.fbcdn.net\\/o1\\/v\\/t2\\/f2\\/m86\\/AQN_escaped_1080.mp4?oe=6A91A3F3<\\/BaseURL><\\/Representation><Representation id=\"2\" mimeType=\"video/mp4\" width=\"480\" height=\"854\" bandwidth=\"800000\"><BaseURL>https:\\/\\/video.xx.fbcdn.net\\/o1\\/v\\/t2\\/f2\\/m86\\/AQN_escaped_480.mp4?oe=6A91A3F3<\\/BaseURL><\\/Representation><\\/AdaptationSet><\\/Period><\\/MPD>"
    })

    def test_parse_sample_dash_xml(self):
        res = parse_dash_manifest(self.SAMPLE_DASH_XML)
        self.assertEqual(len(res["videos"]), 3)
        self.assertEqual(len(res["audios"]), 1)

        # HD should be 1080p
        self.assertEqual(res["videos"][0]["height"], 1920)
        self.assertEqual(res["videos"][0]["width"], 1080)
        self.assertIn("AQN_1080p.mp4", res["hdUrl"])

        # SD should be 360p
        self.assertIn("AQN_360p.mp4", res["sdUrl"])

        # Audio
        self.assertIn("AQN_audio.mp4", res["audioUrl"])

    def test_parse_escaped_dash_json(self):
        res = parse_dash_manifest(self.SAMPLE_ESCAPED_DASH_JSON)
        self.assertEqual(len(res["videos"]), 2)
        self.assertEqual(res["videos"][0]["height"], 1920)
        self.assertIn("AQN_escaped_1080.mp4", res["hdUrl"])
        self.assertEqual(res["videos"][1]["height"], 854)
        self.assertIn("AQN_escaped_480.mp4", res["sdUrl"])

    def test_clean_baseurl_with_idm_artifact(self):
        dirty_url = "https://video.xx.fbcdn.net/o1/v/t2/m86/AQN.mp4?oe=6A91A3F3%3C/BaseURL"
        cleaned = re.sub(r'(%3C|<)\/?BaseURL.*$', '', dirty_url, flags=re.IGNORECASE).strip()
        self.assertEqual(cleaned, "https://video.xx.fbcdn.net/o1/v/t2/m86/AQN.mp4?oe=6A91A3F3")


class TestCdnUrlClassification(unittest.TestCase):
    MEDIA_HOST_PATTERN = re.compile(r'(?:^|\.)(?:fbcdn\.net|fbsbx\.com)$', re.I)

    def is_fb_media_host(self, url: str) -> bool:
        try:
            parsed = urlparse(url)
            return bool(parsed.hostname and self.MEDIA_HOST_PATTERN.search(parsed.hostname))
        except Exception:
            return False

    def test_host_patterns(self):
        self.assertTrue(self.is_fb_media_host("https://video-sin6-4.xx.fbcdn.net/o1/v/t2/file.mp4"))
        self.assertTrue(self.is_fb_media_host("https://scontent.xx.fbsbx.com/v/t1/file.mp4"))
        self.assertFalse(self.is_fb_media_host("https://facebook.com/reel/123"))
        self.assertFalse(self.is_fb_media_host("https://attacker.com/fbcdn.net/file.mp4"))

    def test_strip_byte_range(self):
        url = "https://video.xx.fbcdn.net/o1/v/t2/file.mp4?_nc_cat=101&bytestart=0&byteend=12345&oe=6A91A3F3"
        cleaned = re.sub(r'[?&]bytestart=\d+', '', url)
        cleaned = re.sub(r'[?&]byteend=\d+', '', cleaned)
        if '?' not in cleaned and '&' in cleaned:
            cleaned = cleaned.replace('&', '?', 1)
        self.assertNotIn("bytestart", cleaned)
        self.assertNotIn("byteend", cleaned)
        self.assertIn("oe=6A91A3F3", cleaned)


if __name__ == "__main__":
    unittest.main()
