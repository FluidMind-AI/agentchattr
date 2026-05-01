"""Tests for token persistence across registration cycles and registry restarts.

The token persistence feature ensures that a wrapper re-registering after a
server restart receives the SAME bearer token it had before. This means the
inner agent process (claude-code, codex, etc.) — which cached the token at
startup from its --mcp-config file — does NOT have to be killed and restarted
to recover after a server crash or restart. It just keeps working.

Tokens are keyed by ``(base, label)`` — the tuple the wrapper was launched with
on its command line. This is what wrapper.py sends to /api/register on every
registration, including the recovery path in the heartbeat-409 branch.
"""

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from registry import RuntimeRegistry


CLAUDE_BASE = {"label": "Claude", "color": "#da7756"}


def _make_registry(tmpdir: str) -> RuntimeRegistry:
    reg = RuntimeRegistry(data_dir=tmpdir)
    reg.seed({"claude": dict(CLAUDE_BASE)})
    return reg


def test_token_persists_across_deregister_register():
    """A wrapper that disconnects and re-registers (same base, same label) keeps its token."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg = _make_registry(tmpdir)

        first = reg.register("claude", label="reviewer")
        original_token = first["token"]
        original_name = first["name"]

        reg.deregister(original_name)
        # GRACE_PERIOD reservation prevents immediate slot collisions in
        # pathological cases; a fresh re-register from the same base+label
        # picks the next free slot but should still recover the prior token.
        second = reg.register("claude", label="reviewer")

        assert second["token"] == original_token, (
            "wrapper re-registering with the same (base, label) must receive "
            "the same bearer token so the inner agent's cached token stays valid"
        )


def test_token_survives_registry_restart():
    """A fresh RuntimeRegistry instance loads the persisted token from disk and reuses it."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg1 = _make_registry(tmpdir)
        first = reg1.register("claude", label="reviewer")
        original_token = first["token"]

        # Simulate full server process restart: brand new registry, same data dir
        reg2 = _make_registry(tmpdir)
        recovered = reg2.register("claude", label="reviewer")

        assert recovered["token"] == original_token


def test_no_label_persists_separately_from_labeled():
    """``wrapper.py claude`` and ``wrapper.py claude --label X`` get DIFFERENT persisted tokens."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg = _make_registry(tmpdir)

        bare = reg.register("claude", label=None)
        labeled = reg.register("claude", label="reviewer")

        assert bare["token"] != labeled["token"]

        # After full restart, each wrapper still gets its own token back
        reg2 = _make_registry(tmpdir)
        bare_again = reg2.register("claude", label=None)
        labeled_again = reg2.register("claude", label="reviewer")

        assert bare_again["token"] == bare["token"]
        assert labeled_again["token"] == labeled["token"]


def test_canonical_name_rename_does_not_break_token_persistence():
    """User-facing rename via /api/label changes canonical name but NOT the wrapper's
    (base, label) args, so re-registration must still find the token."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg = _make_registry(tmpdir)

        first = reg.register("claude", label=None)
        original_token = first["token"]
        original_name = first["name"]  # "claude"

        # Simulate the /api/label/{name} flow: rename canonical name to "funky"
        result = reg.rename(original_name, "funky", "funky")
        assert isinstance(result, dict), f"rename failed: {result}"
        assert result["name"] == "funky"

        # Server restart: deregister and re-register with the original wrapper
        # args (the wrapper continues sending base="claude", label=None — see
        # wrapper.py:_heartbeat 409 branch which uses args.label).
        reg.deregister("funky")
        recovered = reg.register("claude", label=None)

        assert recovered["token"] == original_token, (
            "renaming the canonical name must not orphan the persisted token; "
            "the wrapper still uses its launch (base, label) for re-registration"
        )


def test_persisted_file_is_valid_json():
    """The token file is valid JSON so it can be inspected and edited by hand."""
    import json
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmpdir:
        reg = _make_registry(tmpdir)
        reg.register("claude", label="funky")

        tokens_file = Path(tmpdir) / "agent_tokens.json"
        assert tokens_file.exists()
        data = json.loads(tokens_file.read_text("utf-8"))

        assert "claude|funky" in data
        assert isinstance(data["claude|funky"], str)
        assert len(data["claude|funky"]) == 32  # secrets.token_hex(16)
