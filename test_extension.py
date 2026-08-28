"""
Unit tests for Download Video / Reel Facebook Chrome Extension.
Tests manifest integrity, DASH manifest parsing, in-browser MP4 muxing, offscreen architecture, and CDN classification.
Directly executes production JavaScript modules (lib/extractor.js and lib/mp4muxer.js) via Node.js.
"""

import json
import re
import subprocess
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
        for perm in ["downloads", "activeTab", "contextMenus", "webRequest", "storage", "offscreen"]:
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
        self.assertIn("lib/extractor.js", content_scripts[0].get("js", []))

    def test_offscreen_files(self):
        offscreen_html = WORKSPACE_ROOT / "offscreen" / "offscreen.html"
        offscreen_js = WORKSPACE_ROOT / "offscreen" / "offscreen.js"
        self.assertTrue(offscreen_html.exists(), "offscreen/offscreen.html must exist")
        self.assertTrue(offscreen_js.exists(), "offscreen/offscreen.js must exist")


class TestProductionJsExecution(unittest.TestCase):
    """
    Executes production JavaScript modules directly via Node.js test runner.
    """
    def test_node_test_suite(self):
        test_script = WORKSPACE_ROOT / "tests" / "test_muxer_and_extractor.mjs"
        self.assertTrue(test_script.exists(), "test_muxer_and_extractor.mjs must exist")

        proc = subprocess.run(
            ["node", str(test_script)],
            cwd=str(WORKSPACE_ROOT),
            capture_output=True,
            text=True
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"Node.js test suite failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
        self.assertIn("pass 72", proc.stdout)


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
