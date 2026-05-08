"""Tests for channel-scoped rules.

Rules can be scoped to a specific channel (e.g. 'notolink-dev'). When fetched
with a channel filter, the active list returns rules for that channel plus any
global rules (channel == ""). Legacy rules without a channel field load as
global so existing rules.json files continue to work unchanged.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rules import RuleStore


class ChannelScopedRulesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "rules.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _make_active(self, store, text, author="user", channel=""):
        rule = store.propose(text, author, channel=channel)
        self.assertIsNotNone(rule)
        store.activate(rule["id"])
        return rule

    def test_propose_persists_channel(self):
        store = RuleStore(str(self.path))
        rule = store.propose("scope test", "noto", channel="notolink-dev")
        self.assertEqual(rule["channel"], "notolink-dev")

        # Reload from disk and confirm channel survived save+load.
        store2 = RuleStore(str(self.path))
        loaded = store2.get(rule["id"])
        self.assertEqual(loaded["channel"], "notolink-dev")

    def test_propose_without_channel_is_global(self):
        store = RuleStore(str(self.path))
        rule = store.propose("global rule", "noto")
        self.assertEqual(rule["channel"], "")

    def test_active_list_no_channel_returns_all(self):
        store = RuleStore(str(self.path))
        self._make_active(store, "global one")
        self._make_active(store, "scoped notolink", channel="notolink-dev")
        self._make_active(store, "scoped general", channel="general")

        all_active = store.active_list()
        self.assertEqual(
            sorted(all_active["rules"]),
            ["global one", "scoped general", "scoped notolink"],
        )

    def test_active_list_with_channel_filters_to_scope_plus_global(self):
        store = RuleStore(str(self.path))
        self._make_active(store, "global rule")
        self._make_active(store, "notolink rule", channel="notolink-dev")
        self._make_active(store, "noto-dev rule", channel="noto-dev")

        scoped = store.active_list("notolink-dev")
        self.assertEqual(sorted(scoped["rules"]), ["global rule", "notolink rule"])

        other = store.active_list("noto-dev")
        self.assertEqual(sorted(other["rules"]), ["global rule", "noto-dev rule"])

    def test_active_list_excludes_inactive_rules(self):
        store = RuleStore(str(self.path))
        active = self._make_active(store, "active scoped", channel="notolink-dev")
        proposed = store.propose("pending scoped", "noto", channel="notolink-dev")
        store.deactivate(active["id"])

        result = store.active_list("notolink-dev")
        self.assertEqual(result["rules"], [])

    def test_legacy_rules_without_channel_field_load_as_global(self):
        # Pre-channel rules.json had no 'channel' field on rule records.
        legacy_payload = {
            "epoch": 3,
            "rules": [
                {
                    "id": 1,
                    "uid": "legacy-1",
                    "text": "be terse",
                    "author": "user",
                    "reason": "",
                    "status": "active",
                    "created_at": 1700000000.0,
                },
            ],
        }
        self.path.write_text(json.dumps(legacy_payload), "utf-8")

        store = RuleStore(str(self.path))
        rule = store.get(1)
        self.assertEqual(rule["channel"], "")
        self.assertIn("be terse", store.active_list()["rules"])
        self.assertIn("be terse", store.active_list("notolink-dev")["rules"])

    def test_active_list_handles_general_channel_as_explicit_scope(self):
        store = RuleStore(str(self.path))
        self._make_active(store, "global rule")
        self._make_active(store, "general scoped", channel="general")

        general_view = store.active_list("general")
        self.assertEqual(sorted(general_view["rules"]),
                         ["general scoped", "global rule"])
        notolink_view = store.active_list("notolink-dev")
        self.assertEqual(notolink_view["rules"], ["global rule"])


if __name__ == "__main__":
    unittest.main()
