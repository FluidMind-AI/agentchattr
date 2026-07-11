"""Tests for X-ray terminal helpers (tmux session resolution, capture, input)."""

import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402

_HAS_TMUX = shutil.which("tmux") is not None
_TEST_SESSION = "agentchattr-xraytesting"
_TEST_AGENT = "xraytesting"


class XrayNameValidationTests(unittest.TestCase):
    def test_valid_agent_names(self):
        for name in ("noto", "pixel", "claude-2", "absolute-reviewer"):
            self.assertTrue(app._XRAY_NAME_RE.match(name), name)

    def test_rejects_tmux_target_injection(self):
        for bad in ("", "a" * 40, "foo;rm", "foo bar", "$(x)", "-flag", "UPPER", "a\nb"):
            self.assertFalse(app._XRAY_NAME_RE.match(bad), repr(bad))

    def test_key_allowlist_blocks_arbitrary_strings(self):
        self.assertIn("Enter", app._XRAY_KEYS)
        self.assertIn("C-c", app._XRAY_KEYS)
        self.assertNotIn("C-b d; run-shell evil", app._XRAY_KEYS)


@unittest.skipUnless(_HAS_TMUX, "tmux not installed")
class XrayTmuxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run(["tmux", "kill-session", "-t", _TEST_SESSION],
                       capture_output=True)
        r = subprocess.run(
            ["tmux", "new-session", "-d", "-s", _TEST_SESSION, "cat"],
            capture_output=True)
        if r.returncode != 0:
            raise unittest.SkipTest(f"could not create tmux session: {r.stderr}")

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["tmux", "kill-session", "-t", _TEST_SESSION],
                       capture_output=True)

    def test_session_resolution(self):
        self.assertEqual(app._xray_session_for(_TEST_AGENT), _TEST_SESSION)

    def test_session_resolution_missing(self):
        self.assertIsNone(app._xray_session_for("no-such-agent-zz"))

    def test_capture_returns_pane_content(self):
        content = app._xray_capture(_TEST_SESSION)
        self.assertIsNotNone(content)
        self.assertIsInstance(content, str)

    def test_input_roundtrip(self):
        app._xray_send_input(_TEST_AGENT, "hello-xray", "Enter")
        deadline = time.time() + 3
        content = ""
        while time.time() < deadline:
            content = app._xray_capture(_TEST_SESSION) or ""
            if "hello-xray" in content:
                break
            time.sleep(0.1)
        self.assertIn("hello-xray", content)

    def test_disallowed_key_is_ignored(self):
        # Must not raise, must not kill the session
        app._xray_send_input(_TEST_AGENT, None, "C-b d; run-shell evil")
        self.assertEqual(app._xray_session_for(_TEST_AGENT), _TEST_SESSION)


if __name__ == "__main__":
    unittest.main()
