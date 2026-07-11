"""Tests for the Noto hub: routing outbox (grace-period delivery + cancel),
origin stamping via chat_send, hub-agent grace enqueue, and hub reply
auto-routing."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub_router import HubOutbox  # noqa: E402
from store import MessageStore  # noqa: E402


def _wait_until(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class HubOutboxTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = MessageStore(str(Path(self._tmp.name) / "log.jsonl"))
        self.events = []

    def tearDown(self):
        self._tmp.cleanup()

    def _outbox(self, grace):
        ob = HubOutbox(self.store, grace_seconds=grace)
        ob.on_event(lambda e, r: self.events.append((e, r)))
        return ob

    def test_delivers_after_grace_window(self):
        ob = self._outbox(0.1)
        route = ob.enqueue("noto", "@pixel fix the sidebar", "notolink-dev")
        self.assertEqual(self.events[0][0], "pending")
        self.assertEqual(ob.pending()[0]["route_id"], route["route_id"])
        # Nothing lands in the store during the grace window
        self.assertEqual(len(self.store.get_recent(10, channel="notolink-dev")), 0)

        self.assertTrue(_wait_until(lambda: any(e == "delivered" for e, _ in self.events)))
        msgs = self.store.get_recent(10, channel="notolink-dev")
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["sender"], "noto")
        self.assertEqual(msgs[0]["text"], "@pixel fix the sidebar")
        delivered = [r for e, r in self.events if e == "delivered"][0]
        self.assertEqual(delivered["msg_id"], msgs[0]["id"])
        self.assertEqual(ob.pending(), [])

    def test_cancel_prevents_delivery(self):
        ob = self._outbox(0.3)
        route = ob.enqueue("noto", "wrong channel oops", "absolute-crm")
        self.assertTrue(ob.cancel(route["route_id"]))
        time.sleep(0.5)  # well past the grace window
        self.assertEqual(len(self.store.get_recent(10, channel="absolute-crm")), 0)
        self.assertIn("cancelled", [e for e, _ in self.events])
        self.assertNotIn("delivered", [e for e, _ in self.events])
        # Second cancel is a no-op
        self.assertFalse(ob.cancel(route["route_id"]))

    def test_cancel_after_delivery_is_noop(self):
        ob = self._outbox(0.05)
        route = ob.enqueue("noto", "hello", "notolink-dev")
        self.assertTrue(_wait_until(lambda: any(e == "delivered" for e, _ in self.events)))
        self.assertFalse(ob.cancel(route["route_id"]))
        self.assertEqual(len(self.store.get_recent(10, channel="notolink-dev")), 1)

    def test_delivery_preserves_reply_and_metadata(self):
        parent = self.store.add("pixel", "shipped it", channel="notolink-dev")
        ob = self._outbox(0.05)
        ob.enqueue("noto", "nice work", "notolink-dev",
                   reply_to=parent["id"], metadata={"origin_channel": "general"})
        self.assertTrue(_wait_until(lambda: any(e == "delivered" for e, _ in self.events)))
        msg = self.store.get_recent(10, channel="notolink-dev")[-1]
        self.assertEqual(msg["reply_to"], parent["id"])
        self.assertEqual(msg["metadata"]["origin_channel"], "general")


class ChatSendHubTests(unittest.TestCase):
    """chat_send behavior for origin stamping and the hub grace window."""

    def setUp(self):
        import mcp_bridge
        self.bridge = mcp_bridge
        self._tmp = tempfile.TemporaryDirectory()
        self.store = MessageStore(str(Path(self._tmp.name) / "log.jsonl"))
        self._saved = {k: getattr(mcp_bridge, k) for k in
                       ("store", "room_settings", "registry", "router",
                        "agents", "jobs", "hub_outbox")}
        mcp_bridge.store = self.store
        mcp_bridge.room_settings = {
            "channels": ["general", "notolink-dev", "noto-dev"],
            "hub_channel": "general",
            "hub_agent": "noto",
        }
        mcp_bridge.registry = None
        mcp_bridge.router = None
        mcp_bridge.agents = None
        mcp_bridge.jobs = None
        self.outbox = HubOutbox(self.store, grace_seconds=5)  # long: never fires in-test
        mcp_bridge.hub_outbox = self.outbox

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(self.bridge, k, v)
        self._tmp.cleanup()

    def test_origin_stamp_attached(self):
        origin = self.store.add("pixel", "done!", channel="notolink-dev")
        result = self.bridge.chat_send(
            sender="noto", message="pixel finished the fix",
            channel="general", origin_channel="notolink-dev",
            origin_msg_id=origin["id"])
        self.assertIn("Sent", result)
        msg = self.store.get_recent(10, channel="general")[-1]
        self.assertEqual(msg["metadata"]["origin_channel"], "notolink-dev")
        self.assertEqual(msg["metadata"]["origin_msg_id"], origin["id"])

    def test_bogus_origin_dropped_but_message_sent(self):
        result = self.bridge.chat_send(
            sender="noto", message="report", channel="general",
            origin_channel="no-such-channel", origin_msg_id=999)
        self.assertIn("Sent", result)
        msg = self.store.get_recent(10, channel="general")[-1]
        self.assertNotIn("origin_channel", (msg.get("metadata") or {}))

    def test_hub_agent_cross_channel_send_is_queued(self):
        result = self.bridge.chat_send(
            sender="noto", message="@pixel please fix", channel="notolink-dev")
        self.assertIn("Queued for #notolink-dev", result)
        # Not in the store yet — waiting in the outbox
        self.assertEqual(len(self.store.get_recent(10, channel="notolink-dev")), 0)
        self.assertEqual(len(self.outbox.pending()), 1)

    def test_hub_agent_send_to_hub_is_immediate(self):
        result = self.bridge.chat_send(
            sender="noto", message="team is up", channel="general")
        self.assertIn("Sent", result)
        self.assertEqual(len(self.store.get_recent(10, channel="general")), 1)
        self.assertEqual(self.outbox.pending(), [])

    def test_non_hub_agent_sends_are_immediate(self):
        result = self.bridge.chat_send(
            sender="pixel", message="on it", channel="notolink-dev")
        self.assertIn("Sent", result)
        self.assertEqual(len(self.store.get_recent(10, channel="notolink-dev")), 1)
        self.assertEqual(self.outbox.pending(), [])


class HubReplyRoutingTests(unittest.TestCase):
    """_resolve_hub_reply: replies to origin-stamped hub messages route back."""

    def setUp(self):
        import app
        self.app = app
        self._tmp = tempfile.TemporaryDirectory()
        self.store = MessageStore(str(Path(self._tmp.name) / "log.jsonl"))
        self._saved_store = app.store
        self._saved_settings = dict(app.room_settings)
        app.store = self.store
        app.room_settings["hub_channel"] = "general"
        app.room_settings["channels"] = ["general", "notolink-dev"]

    def tearDown(self):
        self.app.store = self._saved_store
        self.app.room_settings.clear()
        self.app.room_settings.update(self._saved_settings)
        self._tmp.cleanup()

    def test_reply_to_origin_stamped_message_routes(self):
        origin = self.store.add("pixel", "shipped", channel="notolink-dev")
        relay = self.store.add(
            "noto", "pixel shipped the fix", channel="general",
            metadata={"origin_channel": "notolink-dev", "origin_msg_id": origin["id"]})
        routed = self.app._resolve_hub_reply(relay["id"], "general")
        self.assertEqual(routed, ("notolink-dev", origin["id"]))

    def test_reply_to_plain_hub_message_is_normal(self):
        plain = self.store.add("noto", "hello", channel="general")
        self.assertIsNone(self.app._resolve_hub_reply(plain["id"], "general"))

    def test_reply_outside_hub_is_normal(self):
        origin = self.store.add("pixel", "shipped", channel="notolink-dev")
        relay = self.store.add(
            "noto", "report", channel="notolink-dev",
            metadata={"origin_channel": "general", "origin_msg_id": origin["id"]})
        self.assertIsNone(self.app._resolve_hub_reply(relay["id"], "notolink-dev"))

    def test_deleted_origin_message_falls_back_to_channel_only(self):
        origin = self.store.add("pixel", "shipped", channel="notolink-dev")
        relay = self.store.add(
            "noto", "report", channel="general",
            metadata={"origin_channel": "notolink-dev", "origin_msg_id": origin["id"]})
        self.store.delete([origin["id"]])
        routed = self.app._resolve_hub_reply(relay["id"], "general")
        self.assertEqual(routed, ("notolink-dev", None))

    def test_unknown_origin_channel_is_normal_reply(self):
        relay = self.store.add(
            "noto", "report", channel="general",
            metadata={"origin_channel": "deleted-channel", "origin_msg_id": 1})
        self.assertIsNone(self.app._resolve_hub_reply(relay["id"], "general"))


if __name__ == "__main__":
    unittest.main()
