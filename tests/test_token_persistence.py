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
    """The persistence file is valid JSON with the full identity snapshot per wrapper."""
    import json
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmpdir:
        reg = _make_registry(tmpdir)
        reg.register("claude", label="funky")

        path = Path(tmpdir) / "agent_identities.json"
        assert path.exists()
        data = json.loads(path.read_text("utf-8"))

        assert "claude|funky" in data
        snapshot = data["claude|funky"]
        assert isinstance(snapshot, dict)
        assert "token" in snapshot and len(snapshot["token"]) == 32  # secrets.token_hex(16)
        assert "name" in snapshot
        assert "label" in snapshot
        assert "slot" in snapshot
        assert "color" in snapshot


def test_canonical_name_and_label_restored_after_rename_and_restart():
    """V2 promise: full identity (token + name + label + slot) survives across:
    initial register → user rename via /api/label → server restart."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg1 = _make_registry(tmpdir)
        first = reg1.register("claude", label=None)
        # User-facing rename via /api/label/{slot} flow
        renamed = reg1.rename(first["name"], "funky", "funky")
        assert isinstance(renamed, dict)
        assert renamed["name"] == "funky"
        assert renamed["label"] == "funky"
        original_token = first["token"]

        # Server restart simulation
        reg2 = _make_registry(tmpdir)
        # Same wrapper re-registers (sends original launch args)
        recovered = reg2.register("claude", label=None)

        # Same canonical name, same label, same token. Nothing for the user
        # to clean up after the restart.
        assert recovered["name"] == "funky"
        assert recovered["label"] == "funky"
        assert recovered["token"] == original_token


def test_multiple_claudes_keep_their_identities_across_restart():
    """4 wrappers of the same base, each renamed to a custom label, ALL recover
    their exact identities across server restart — regardless of re-register order."""
    with tempfile.TemporaryDirectory() as tmpdir:
        reg1 = _make_registry(tmpdir)
        # Initial launch: funky (no label), then 3 labeled siblings.
        # After the 2nd register, slot 1 ("claude") gets renamed to "claude-1".
        f = reg1.register("claude", label=None)
        r = reg1.register("claude", label="reviewer")
        ra = reg1.register("claude", label="racer")
        ar = reg1.register("claude", label="absolute-reviewer")

        # User-facing rename for funky. Its current canonical name is now
        # "claude-1" (auto-renamed by the slot1-rename when reviewer joined).
        funky = reg1.rename("claude-1", "funky", "funky")
        assert isinstance(funky, dict), f"rename failed: {funky}"
        # Capture pre-restart identities
        expected = {
            (None,): {"name": funky["name"], "label": funky["label"], "token": f["token"]},
            ("reviewer",): {"name": r["name"], "label": r["label"], "token": r["token"]},
            ("racer",): {"name": ra["name"], "label": ra["label"], "token": ra["token"]},
            ("absolute-reviewer",): {"name": ar["name"], "label": ar["label"], "token": ar["token"]},
        }

        # Server restart
        reg2 = _make_registry(tmpdir)
        # Re-register in REVERSE order — this would have shuffled slots in V1
        ar2 = reg2.register("claude", label="absolute-reviewer")
        ra2 = reg2.register("claude", label="racer")
        r2 = reg2.register("claude", label="reviewer")
        f2 = reg2.register("claude", label=None)

        actual = {
            (None,): {"name": f2["name"], "label": f2["label"], "token": f2["token"]},
            ("reviewer",): {"name": r2["name"], "label": r2["label"], "token": r2["token"]},
            ("racer",): {"name": ra2["name"], "label": ra2["label"], "token": ra2["token"]},
            ("absolute-reviewer",): {"name": ar2["name"], "label": ar2["label"], "token": ar2["token"]},
        }

        assert actual == expected, "every wrapper should recover its exact identity regardless of re-register order"


def test_v1_legacy_tokens_file_auto_migrated():
    """Old agent_tokens.json (V1 format: {key: token_str}) is read on startup
    and treated as partial entries. First register after upgrade falls back to
    fresh allocation but reuses the token; subsequent re-registers are full restore."""
    import json
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmpdir:
        # Seed the legacy V1 file
        legacy = Path(tmpdir) / "agent_tokens.json"
        legacy.write_text(json.dumps({"claude|reviewer": "0123456789abcdef0123456789abcdef"}))

        reg = _make_registry(tmpdir)
        result = reg.register("claude", label="reviewer")

        # Token is preserved (the V1 promise still holds for the upgrade path)
        assert result["token"] == "0123456789abcdef0123456789abcdef"
