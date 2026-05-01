"""One real end-to-end test for wake. Uses WAKE_HOME to isolate state."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WAKE = HERE / "wake.py"


def run_wake(env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(WAKE), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class WakeFlowTest(unittest.TestCase):
    def test_full_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            env = {**os.environ, "WAKE_HOME": td}

            # start
            r = run_wake(env, "start", "ship wake 0.0.1")
            self.assertEqual(r.returncode, 0, r.stderr)
            run_id = r.stdout.strip()
            self.assertTrue(run_id, "start should print run id")

            # active pointer was set
            active = (Path(td) / "active").read_text().strip()
            self.assertEqual(active, run_id)

            # record entries of every kind
            for kind, text in [
                ("decision", "use python stdlib only"),
                ("attempt", "first cli sketch"),
                ("file", "wake.py"),
                ("command", "python3 wake.py start ..."),
                ("failure", "forgot to mkdir runs/"),
                ("note", "remember to add README"),
            ]:
                r = run_wake(env, "note", text, "--kind", kind)
                self.assertEqual(r.returncode, 0, r.stderr)

            # set a next step via note --next
            r = run_wake(env, "note", "audited the cli", "--kind", "note", "--next", "wire up handoff")
            self.assertEqual(r.returncode, 0, r.stderr)

            # status (json) — verify all buckets populated
            r = run_wake(env, "status", "--json")
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)
            self.assertEqual(data["objective"], "ship wake 0.0.1")
            self.assertEqual(len(data["decisions"]), 1)
            self.assertEqual(len(data["attempts"]), 1)
            self.assertEqual(len(data["files"]), 1)
            self.assertEqual(len(data["commands"]), 1)
            self.assertEqual(len(data["failures"]), 1)
            self.assertEqual(len(data["notes"]), 2)
            self.assertEqual(data["next_step"], "wire up handoff")

            # handoff
            r = run_wake(env, "handoff")
            self.assertEqual(r.returncode, 0, r.stderr)
            handoff_path = Path(r.stdout.strip())
            self.assertTrue(handoff_path.exists(), "handoff.md should exist")
            md = handoff_path.read_text()
            self.assertIn("ship wake 0.0.1", md)
            self.assertIn("use python stdlib only", md)
            self.assertIn("wire up handoff", md)
            self.assertIn("## Decisions", md)
            self.assertIn("## Failures", md)

            # status text mode mentions handoff
            r = run_wake(env, "status")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("handoff written", r.stdout)


if __name__ == "__main__":
    unittest.main()
