"""Tests for channel-scoped agent membership.

Membership is stored in room_settings['channel_members'] as
{channel_name: [agent_name, ...]}. An empty (or missing) list = the channel
is OPEN — every registered agent can read/send/be-mentioned. A non-empty list
restricts the channel to the listed agents only.

These tests exercise the in-process helpers and persistence path. The HTTP
endpoints and WebSocket events are thin wrappers around these helpers.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module


class ChannelMembershipHelpers(unittest.TestCase):
    """Direct unit tests for the membership helpers in app.py."""

    def setUp(self):
        # Snapshot and reset module-level state.
        self._saved_settings = app_module.room_settings
        self._saved_config = app_module.config
        self._tmpdir = tempfile.TemporaryDirectory()
        app_module.config = {"server": {"data_dir": self._tmpdir.name}}
        app_module.room_settings = {
            "channels": ["general", "absolute-crm", "noto-dev"],
            "channel_members": {},
        }

    def tearDown(self):
        app_module.room_settings = self._saved_settings
        app_module.config = self._saved_config
        self._tmpdir.cleanup()

    def test_open_channel_allows_every_agent(self):
        self.assertTrue(app_module.is_channel_open("general"))
        self.assertEqual(app_module.get_channel_members("general"), [])
        self.assertTrue(app_module.agent_can_use_channel("anyone", "general"))

    def test_explicit_list_restricts_to_listed_agents(self):
        app_module.set_channel_members("absolute-crm", ["racer", "absolute-reviewer"])
        self.assertFalse(app_module.is_channel_open("absolute-crm"))
        self.assertEqual(
            app_module.get_channel_members("absolute-crm"),
            ["racer", "absolute-reviewer"],
        )
        self.assertTrue(app_module.agent_can_use_channel("racer", "absolute-crm"))
        self.assertTrue(app_module.agent_can_use_channel("absolute-reviewer", "absolute-crm"))
        self.assertFalse(app_module.agent_can_use_channel("funky", "absolute-crm"))
        self.assertFalse(app_module.agent_can_use_channel("user", "absolute-crm"))

    def test_setting_empty_list_reopens_channel(self):
        app_module.set_channel_members("absolute-crm", ["racer"])
        self.assertFalse(app_module.is_channel_open("absolute-crm"))
        app_module.set_channel_members("absolute-crm", [])
        self.assertTrue(app_module.is_channel_open("absolute-crm"))
        self.assertTrue(app_module.agent_can_use_channel("anyone", "absolute-crm"))

    def test_add_and_remove_helpers(self):
        # Start from scratch.
        result = app_module.add_channel_members("noto-dev", ["funky", "reviewer"])
        self.assertEqual(result, ["funky", "reviewer"])
        # Adding an existing one is a no-op.
        result = app_module.add_channel_members("noto-dev", ["funky", "outsider"])
        self.assertEqual(result, ["funky", "reviewer", "outsider"])
        # Remove drops listed names.
        result = app_module.remove_channel_members("noto-dev", ["reviewer"])
        self.assertEqual(result, ["funky", "outsider"])

    def test_set_dedupes_input(self):
        app_module.set_channel_members(
            "noto-dev", ["funky", "funky", "reviewer", "outsider", "reviewer"]
        )
        self.assertEqual(
            app_module.get_channel_members("noto-dev"),
            ["funky", "reviewer", "outsider"],
        )

    def test_persists_to_settings_json(self):
        app_module.set_channel_members("absolute-crm", ["racer", "absolute-reviewer"])
        # File should now contain the list.
        path = Path(self._tmpdir.name) / "settings.json"
        self.assertTrue(path.exists())
        data = json.loads(path.read_text("utf-8"))
        self.assertEqual(
            data["channel_members"]["absolute-crm"],
            ["racer", "absolute-reviewer"],
        )

    def test_no_channel_arg_is_always_allowed(self):
        # Empty channel name (broadcast or non-channel context) shouldn't gate.
        self.assertTrue(app_module.agent_can_use_channel("racer", ""))


class MentionRoutingFilter(unittest.TestCase):
    """Verify the routing-side filter behaves as expected."""

    def setUp(self):
        self._saved_settings = app_module.room_settings
        self._saved_config = app_module.config
        self._tmpdir = tempfile.TemporaryDirectory()
        app_module.config = {"server": {"data_dir": self._tmpdir.name}}
        app_module.room_settings = {
            "channels": ["general", "absolute-crm", "noto-dev"],
            "channel_members": {},
        }

    def tearDown(self):
        app_module.room_settings = self._saved_settings
        app_module.config = self._saved_config
        self._tmpdir.cleanup()

    def test_open_channel_does_not_filter(self):
        targets = ["racer", "funky", "absolute-reviewer"]
        filtered = [t for t in targets if app_module.agent_can_use_channel(t, "general")]
        self.assertEqual(filtered, targets)

    def test_restricted_channel_filters_non_members(self):
        app_module.set_channel_members("absolute-crm", ["racer", "absolute-reviewer"])
        targets = ["racer", "funky", "absolute-reviewer"]
        filtered = [t for t in targets if app_module.agent_can_use_channel(t, "absolute-crm")]
        self.assertEqual(filtered, ["racer", "absolute-reviewer"])


if __name__ == "__main__":
    unittest.main()
