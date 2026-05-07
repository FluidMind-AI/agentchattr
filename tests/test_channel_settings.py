"""Tests for channel-scoped settings (loop guard, rules refresh).

Per-channel overrides for room defaults are persisted in
room_settings['channel_settings'] as {channel: {key: value}}. Resolution
order: per-channel override > room default > config default > hard-coded
fallback.

These exercise the in-process helpers and the router's per-channel
hop-ceiling integration. The HTTP endpoints are thin wrappers.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module
from router import Router


class ChannelSettingsHelpers(unittest.TestCase):
    def setUp(self):
        self._saved_settings = app_module.room_settings
        self._saved_config = app_module.config
        self._tmpdir = tempfile.TemporaryDirectory()
        app_module.config = {
            "server": {"data_dir": self._tmpdir.name},
            "routing": {"max_agent_hops": 7},
        }
        app_module.room_settings = {
            "channels": ["general", "noto-dev"],
            "channel_settings": {},
        }

    def tearDown(self):
        app_module.room_settings = self._saved_settings
        app_module.config = self._saved_config
        self._tmpdir.cleanup()

    def test_max_hops_falls_through_default_when_no_overrides(self):
        # No room-level setting either → falls back to config (7) then 4.
        self.assertEqual(app_module.get_channel_max_hops("general"), 7)

    def test_max_hops_uses_room_default_when_no_channel_override(self):
        app_module.room_settings["max_agent_hops"] = 5
        self.assertEqual(app_module.get_channel_max_hops("general"), 5)
        self.assertEqual(app_module.get_channel_max_hops("noto-dev"), 5)

    def test_max_hops_channel_override_wins(self):
        app_module.room_settings["max_agent_hops"] = 5
        app_module.set_channel_setting("noto-dev", "max_agent_hops", 12)
        self.assertEqual(app_module.get_channel_max_hops("noto-dev"), 12)
        self.assertEqual(app_module.get_channel_max_hops("general"), 5)

    def test_clear_channel_setting_reverts_to_default(self):
        app_module.room_settings["max_agent_hops"] = 5
        app_module.set_channel_setting("noto-dev", "max_agent_hops", 12)
        app_module.set_channel_setting("noto-dev", "max_agent_hops", None)
        self.assertEqual(app_module.get_channel_max_hops("noto-dev"), 5)
        # Channel entry is removed when its dict becomes empty.
        self.assertNotIn("noto-dev", app_module.room_settings["channel_settings"])

    def test_rules_refresh_resolution(self):
        self.assertEqual(app_module.get_channel_rules_refresh("general"), 10)
        app_module.room_settings["rules_refresh_interval"] = 20
        self.assertEqual(app_module.get_channel_rules_refresh("general"), 20)
        app_module.set_channel_setting("noto-dev", "rules_refresh_interval", 5)
        self.assertEqual(app_module.get_channel_rules_refresh("noto-dev"), 5)
        self.assertEqual(app_module.get_channel_rules_refresh("general"), 20)

    def test_resolved_snapshot_marks_overridden(self):
        app_module.room_settings["max_agent_hops"] = 5
        app_module.set_channel_setting("noto-dev", "max_agent_hops", 12)
        snap = app_module.get_channel_settings_resolved("noto-dev")
        self.assertEqual(snap["max_agent_hops"]["value"], 12)
        self.assertTrue(snap["max_agent_hops"]["overridden"])
        self.assertFalse(snap["rules_refresh_interval"]["overridden"])
        # Channel without an override
        snap = app_module.get_channel_settings_resolved("general")
        self.assertFalse(snap["max_agent_hops"]["overridden"])
        self.assertEqual(snap["max_agent_hops"]["value"], 5)


class RouterPerChannelHops(unittest.TestCase):
    """Router's per-channel hop ceiling pulls live from the resolver."""

    def test_resolver_per_channel(self):
        # max_hops baseline is 4; resolver overrides per channel.
        per_channel = {"chat-a": 2, "chat-b": 6}
        r = Router(
            agent_names=["alpha", "beta"],
            default_mention="none",
            max_hops=4,
            max_hops_resolver=lambda c: per_channel.get(c, 4),
        )
        # Channel "chat-a" should pause after 2 hops; "chat-b" allows 6.
        # Hop counter increments only on agent senders with a @mention.
        for _ in range(2):
            r.get_targets("alpha", "@beta hello", channel="chat-a")
        # The 3rd agent hop on chat-a trips the guard.
        self.assertEqual(r.get_targets("alpha", "@beta again", channel="chat-a"), [])
        self.assertTrue(r.is_paused("chat-a"))
        # chat-b is independent and still well under its higher limit.
        for _ in range(5):
            r.get_targets("alpha", "@beta hello", channel="chat-b")
        self.assertFalse(r.is_paused("chat-b"))

    def test_resolver_fallback_on_exception(self):
        def boom(_):
            raise RuntimeError("nope")
        r = Router(
            agent_names=["alpha", "beta"],
            default_mention="none",
            max_hops=2,
            max_hops_resolver=boom,
        )
        # Resolver throws → fallback to self.max_hops (2). 3rd hop pauses.
        r.get_targets("alpha", "@beta x", channel="any")
        r.get_targets("alpha", "@beta x", channel="any")
        self.assertEqual(r.get_targets("alpha", "@beta x", channel="any"), [])
        self.assertTrue(r.is_paused("any"))


if __name__ == "__main__":
    unittest.main()
