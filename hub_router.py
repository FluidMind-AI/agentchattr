"""Hub routing outbox — grace-period delivery for the hub agent's cross-channel sends.

The hub channel (room_settings["hub_channel"], default "general") is the
user's front door: they talk to the hub agent (room_settings["hub_agent"],
default "noto") there, and the hub agent routes work out to the right
channel. Routing mistakes are cheap to make and expensive to walk back once
other agents' mention triggers fire — so cross-channel sends from the hub
agent do NOT deliver immediately. They sit here for a short grace window,
visible in the hub UI as a cancellable routing card. On expiry the message
is written to the store like any other message (broadcast + mention fan-out
happen downstream of store.add, so nothing fires early). On cancel it
simply never existed.

Thread-model: enqueue() is called from MCP worker threads; delivery runs on
a threading.Timer thread; store.add is thread-safe and app.py's store
callback bridges to the asyncio loop. Event listeners registered via
on_event() are called from whichever thread mutates the outbox — app.py
wraps them with run_coroutine_threadsafe for WebSocket broadcast.
"""

import threading
import time


class HubOutbox:
    def __init__(self, store, grace_seconds: float = 10.0):
        self._store = store
        self.grace_seconds = grace_seconds
        self._lock = threading.Lock()
        self._routes: dict[int, dict] = {}      # route_id → route record
        self._timers: dict[int, threading.Timer] = {}
        self._next_id = 1
        self._listeners: list = []

    def on_event(self, cb):
        """Register cb(event_name, route) for 'pending' | 'delivered' | 'cancelled'.

        'delivered' routes carry 'msg_id' of the stored message.
        """
        self._listeners.append(cb)

    def _fire(self, event: str, route: dict):
        for cb in self._listeners:
            try:
                cb(event, dict(route))
            except Exception:
                pass

    def enqueue(self, sender: str, text: str, channel: str, *,
                reply_to: int | None = None,
                attachments: list | None = None,
                msg_type: str = "chat",
                metadata: dict | None = None) -> dict:
        """Queue a message for delayed delivery to `channel`. Returns the route record."""
        with self._lock:
            route_id = self._next_id
            self._next_id += 1
            route = {
                "route_id": route_id,
                "sender": sender,
                "text": text,
                "channel": channel,
                "reply_to": reply_to,
                "attachments": attachments or [],
                "msg_type": msg_type,
                "metadata": metadata,
                "created_at": time.time(),
                "deliver_at": time.time() + self.grace_seconds,
                "status": "pending",
            }
            self._routes[route_id] = route
            timer = threading.Timer(self.grace_seconds, self._deliver, args=(route_id,))
            timer.daemon = True
            self._timers[route_id] = timer
            timer.start()
        self._fire("pending", route)
        return route

    def cancel(self, route_id: int) -> bool:
        """Cancel a pending route. Returns True if it was still pending."""
        with self._lock:
            route = self._routes.get(route_id)
            if not route or route["status"] != "pending":
                return False
            timer = self._timers.pop(route_id, None)
            if timer:
                timer.cancel()
            route["status"] = "cancelled"
            self._routes.pop(route_id, None)
        self._fire("cancelled", route)
        return True

    def pending(self) -> list[dict]:
        """Snapshot of still-pending routes (for late-connecting clients)."""
        with self._lock:
            return [dict(r) for r in self._routes.values() if r["status"] == "pending"]

    def _deliver(self, route_id: int):
        with self._lock:
            route = self._routes.pop(route_id, None)
            self._timers.pop(route_id, None)
            if not route or route["status"] != "pending":
                return
            route["status"] = "delivered"
        try:
            msg = self._store.add(
                route["sender"], route["text"],
                msg_type=route["msg_type"],
                attachments=route["attachments"] or None,
                reply_to=route["reply_to"],
                channel=route["channel"],
                metadata=route["metadata"],
            )
            route["msg_id"] = msg["id"]
        except Exception:
            route["status"] = "failed"
            self._fire("failed", route)
            return
        self._fire("delivered", route)
