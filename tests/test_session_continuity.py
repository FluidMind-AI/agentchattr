"""Tests for claude session continuity (--session-uuid).

Covers wrapper._claude_session_args (first-boot vs resume decision) and
wrapper_unix.run_agent's per-restart rebuild of the tmux launch command via
dynamic_args_fn.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wrapper  # noqa: E402


UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


class ClaudeSessionArgsTests(unittest.TestCase):
    def test_fresh_boot_pins_session_id(self):
        """No transcript on disk → start a new session pinned to the UUID."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(Path, "home", return_value=Path(tmp)):
                args = wrapper._claude_session_args(
                    UUID, Path("/Users/alejandro/notolink/engine")
                )
        self.assertEqual(args, ["--session-id", UUID])

    def test_existing_transcript_resumes(self):
        """Transcript exists under the munged project dir → resume it."""
        import tempfile
        project_dir = Path("/Users/alejandro/notolink/engine")
        munged = "-Users-alejandro-notolink-engine"
        with tempfile.TemporaryDirectory() as tmp:
            transcript_dir = Path(tmp) / ".claude" / "projects" / munged
            transcript_dir.mkdir(parents=True)
            (transcript_dir / f"{UUID}.jsonl").write_text("{}\n", "utf-8")
            with mock.patch.object(Path, "home", return_value=Path(tmp)):
                args = wrapper._claude_session_args(UUID, project_dir)
        self.assertEqual(args, ["--resume", UUID])

    def test_munging_replaces_all_non_alphanumerics(self):
        """Dots, spaces, underscores all munge to '-' like the claude CLI does."""
        import tempfile
        project_dir = Path("/Users/al.e_j andro/my proj")
        munged = "-Users-al-e-j-andro-my-proj"
        with tempfile.TemporaryDirectory() as tmp:
            transcript_dir = Path(tmp) / ".claude" / "projects" / munged
            transcript_dir.mkdir(parents=True)
            (transcript_dir / f"{UUID}.jsonl").write_text("{}\n", "utf-8")
            with mock.patch.object(Path, "home", return_value=Path(tmp)):
                args = wrapper._claude_session_args(UUID, project_dir)
        self.assertEqual(args, ["--resume", UUID])


class DynamicArgsRebuildTests(unittest.TestCase):
    """run_agent must recompute dynamic args at each inner-CLI (re)start."""

    def test_tmux_command_rebuilt_per_iteration(self):
        import wrapper_unix

        calls = []          # tmux new-session commands actually issued
        dyn_state = {"n": 0}

        def dynamic_args_fn():
            dyn_state["n"] += 1
            if dyn_state["n"] == 1:
                return ["--session-id", UUID]
            return ["--resume", UUID]

        # Session lifecycle: after each new-session the session "exists" once
        # (attach returns), then is gone (agent exited) → restart loop runs
        # again. Second iteration: create, exists-check → gone → no_restart
        # is False but we stop the test by raising KeyboardInterrupt.
        def fake_run(args, **kwargs):
            m = mock.Mock()
            m.returncode = 0
            if args[:2] == ["tmux", "new-session"]:
                calls.append(args[-1])
                if len(calls) >= 2:
                    raise KeyboardInterrupt  # end the loop after 2 launches
            elif args[:2] == ["tmux", "has-session"]:
                m.returncode = 1  # session gone → agent exited → restart
            return m

        with mock.patch.object(wrapper_unix.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(wrapper_unix.shutil, "which", return_value="/usr/bin/tmux"), \
             mock.patch.object(wrapper_unix.time, "sleep"):
            wrapper_unix.run_agent(
                command="claude",
                extra_args=["--permission-mode", "acceptEdits"],
                cwd=".",
                env={},
                queue_file=None,
                agent="claude",
                no_restart=False,
                start_watcher=lambda inject_fn: None,
                session_name="agentchattr-test",
                dynamic_args_fn=dynamic_args_fn,
            )

        self.assertEqual(len(calls), 2)
        self.assertIn("--session-id", calls[0])
        self.assertIn("--resume", calls[1])
        # Static args present in both iterations
        for cmd in calls:
            self.assertIn("--permission-mode", cmd)

    def test_no_dynamic_args_fn_keeps_plain_command(self):
        import wrapper_unix

        calls = []

        def fake_run(args, **kwargs):
            m = mock.Mock()
            m.returncode = 0
            if args[:2] == ["tmux", "new-session"]:
                calls.append(args[-1])
                raise KeyboardInterrupt
            elif args[:2] == ["tmux", "has-session"]:
                m.returncode = 1
            return m

        with mock.patch.object(wrapper_unix.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(wrapper_unix.shutil, "which", return_value="/usr/bin/tmux"), \
             mock.patch.object(wrapper_unix.time, "sleep"):
            wrapper_unix.run_agent(
                command="claude",
                extra_args=[],
                cwd=".",
                env={},
                queue_file=None,
                agent="claude",
                no_restart=True,
                start_watcher=lambda inject_fn: None,
                session_name="agentchattr-test",
            )

        self.assertEqual(calls, ["claude"])


if __name__ == "__main__":
    unittest.main()
