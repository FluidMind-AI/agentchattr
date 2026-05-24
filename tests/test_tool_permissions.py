"""Tests for the per-agent, per-tool permissions infrastructure.

Tier model + resolution order live in mcp_bridge._check_tool_permission.
The approval-card primitive (Future-based) wires through resolve_decision
in app.py.

Backend-only tests here; UI integration is exercised in P4.
"""

import concurrent.futures
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module
import mcp_bridge


class PermissionResolution(unittest.TestCase):
    """_check_tool_permission resolves (agent, tool) → allow/ask/deny."""

    def setUp(self):
        self._saved_settings = app_module.room_settings
        self._saved_config = app_module.config
        self._tmpdir = tempfile.TemporaryDirectory()
        app_module.config = {"server": {"data_dir": self._tmpdir.name}}
        app_module.room_settings = {"channels": ["general"]}

    def tearDown(self):
        app_module.room_settings = self._saved_settings
        app_module.config = self._saved_config
        self._tmpdir.cleanup()

    def test_default_tier_policy_when_no_settings(self):
        # No tool_permissions → falls back to DEFAULT_TIER_POLICY.
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_read"), "allow")     # tier 0
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_send"), "allow")     # tier 1
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_set_hat_other"), "deny")  # tier 2

    def test_unknown_tool_defaults_to_tier_1_self(self):
        # Unknown tools default to tier 1 (allow by default policy).
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "frob_widget"), "allow")

    def test_defaults_block_overrides_hardcoded(self):
        app_module.room_settings["tool_permissions"] = {
            "_defaults": {"tier_0": "ask", "tier_1": "deny"},
        }
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_read"), "ask")
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_send"), "deny")
        # tier_2 not in defaults → falls back to hardcoded "deny"
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_set_hat_other"), "deny")

    def test_agent_tier_bucket_overrides_defaults(self):
        app_module.room_settings["tool_permissions"] = {
            "_defaults": {"tier_2": "deny"},
            "noto":     {"tier_2": "allow"},
        }
        self.assertEqual(mcp_bridge._check_tool_permission("noto", "chat_set_hat_other"), "allow")
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_set_hat_other"), "deny")

    def test_per_tool_override_beats_tier_bucket(self):
        app_module.room_settings["tool_permissions"] = {
            "_defaults": {"tier_1": "allow"},
            "funky":     {"tier_1": "ask", "chat_send": "allow"},
        }
        # chat_send override beats tier_1 ask.
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_send"), "allow")
        # other tier-1 tools still ask.
        self.assertEqual(mcp_bridge._check_tool_permission("funky", "chat_join"), "ask")

    def test_invalid_decision_value_falls_through(self):
        # Garbage value gets ignored; resolution falls through.
        app_module.room_settings["tool_permissions"] = {
            "noto": {"chat_send": "maybe"},
        }
        self.assertEqual(mcp_bridge._check_tool_permission("noto", "chat_send"), "allow")  # tier 1 default

    def test_persist_per_tool_override(self):
        # Smoke test: writing an override saves to settings.
        with mock.patch.object(app_module, "_save_settings") as save:
            mcp_bridge._persist_per_tool_override("funky", "chat_send", "deny")
        self.assertEqual(
            app_module.room_settings["tool_permissions"]["funky"]["chat_send"],
            "deny",
        )
        save.assert_called_once()


class ApprovalFutureFlow(unittest.TestCase):
    """The Future-based approval flow that lets a sync MCP tool block on a
    user's in-chat click."""

    def test_resolve_pending_approval_sets_future_result(self):
        msg_id = 999
        fut = concurrent.futures.Future()
        with mcp_bridge._approvals_lock:
            mcp_bridge._pending_approvals[msg_id] = fut
        try:
            self.assertTrue(mcp_bridge.resolve_pending_approval(msg_id, "Allow"))
            self.assertEqual(fut.result(timeout=0.1), "Allow")
        finally:
            with mcp_bridge._approvals_lock:
                mcp_bridge._pending_approvals.pop(msg_id, None)

    def test_resolve_pending_approval_returns_false_for_unknown_msg(self):
        # Pass wait_ms=0 so the test doesn't actually sleep its 500ms budget.
        self.assertFalse(mcp_bridge.resolve_pending_approval(123456, "Allow", wait_ms=0))

    def test_resolve_pending_approval_waits_for_late_registration(self):
        # Race regression: simulate the worker thread registering the
        # Future AFTER resolve_pending_approval is called. The 500ms wait
        # should bridge the gap.
        import threading
        msg_id = 7777
        fut = concurrent.futures.Future()
        def register_late():
            time.sleep(0.05)  # simulate ~50ms gap
            with mcp_bridge._approvals_lock:
                mcp_bridge._pending_approvals[msg_id] = fut
        threading.Thread(target=register_late, daemon=True).start()
        try:
            self.assertTrue(
                mcp_bridge.resolve_pending_approval(msg_id, "Allow", wait_ms=500)
            )
            self.assertEqual(fut.result(timeout=0.1), "Allow")
        finally:
            with mcp_bridge._approvals_lock:
                mcp_bridge._pending_approvals.pop(msg_id, None)

    def test_resolve_pending_approval_idempotent(self):
        msg_id = 998
        fut = concurrent.futures.Future()
        with mcp_bridge._approvals_lock:
            mcp_bridge._pending_approvals[msg_id] = fut
        try:
            self.assertTrue(mcp_bridge.resolve_pending_approval(msg_id, "Deny"))
            # Already resolved → second call is a no-op.
            self.assertFalse(mcp_bridge.resolve_pending_approval(msg_id, "Allow"))
            self.assertEqual(fut.result(timeout=0.1), "Deny")
        finally:
            with mcp_bridge._approvals_lock:
                mcp_bridge._pending_approvals.pop(msg_id, None)


class AuthorizeToolEntryPoint(unittest.TestCase):
    """authorize_tool wraps the permission resolver + audit + (eventually)
    the approval flow. For P3 we test the synchronous allow/deny paths;
    the 'ask' path is covered by ApprovalFutureFlow + the _request_approval
    end-to-end (manually verified, not unit-tested here)."""

    def setUp(self):
        self._saved_settings = app_module.room_settings
        self._saved_config = app_module.config
        self._tmpdir = tempfile.TemporaryDirectory()
        app_module.config = {"server": {"data_dir": self._tmpdir.name}}
        app_module.room_settings = {"channels": ["general"]}

    def tearDown(self):
        app_module.room_settings = self._saved_settings
        app_module.config = self._saved_config
        self._tmpdir.cleanup()

    def test_allow_path_returns_true_no_error(self):
        ok, err = mcp_bridge.authorize_tool("funky", "chat_send", args_summary="hi")
        self.assertTrue(ok)
        self.assertIsNone(err)

    def test_deny_path_returns_false_with_error(self):
        app_module.room_settings["tool_permissions"] = {
            "funky": {"chat_send": "deny"},
        }
        ok, err = mcp_bridge.authorize_tool("funky", "chat_send", args_summary="hi")
        self.assertFalse(ok)
        self.assertIn("not permitted", err)

    def test_audit_log_writes_for_deny(self):
        # Tier-0 allow is intentionally NOT logged; deny always is.
        app_module.room_settings["tool_permissions"] = {
            "funky": {"chat_send": "deny"},
        }
        mcp_bridge.authorize_tool("funky", "chat_send", args_summary="hi")
        log_path = Path(self._tmpdir.name) / "tool_calls.jsonl"
        self.assertTrue(log_path.exists())
        line = log_path.read_text("utf-8").strip().splitlines()[-1]
        record = json.loads(line)
        self.assertEqual(record["agent"], "funky")
        self.assertEqual(record["tool"], "chat_send")
        self.assertEqual(record["decision"], "deny")
        self.assertEqual(record["tier"], 1)

    def test_audit_log_skipped_for_tier0_allow(self):
        # chat_read is tier 0 → default allow; no log entry expected.
        ok, err = mcp_bridge.authorize_tool("funky", "chat_read", args_summary="")
        self.assertTrue(ok)
        log_path = Path(self._tmpdir.name) / "tool_calls.jsonl"
        # Either the file doesn't exist or it's empty.
        if log_path.exists():
            self.assertEqual(log_path.read_text("utf-8").strip(), "")


if __name__ == "__main__":
    unittest.main()
