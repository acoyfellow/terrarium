#!/usr/bin/env python3
"""Wake — durable agent-run continuity. Tiny single-file CLI, stdlib only."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any


def wake_home() -> Path:
    env = os.environ.get("WAKE_HOME")
    if env:
        return Path(env)
    return Path.home() / ".wake"


def runs_dir() -> Path:
    d = wake_home() / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def active_pointer() -> Path:
    return wake_home() / "active"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def slugify(text: str) -> str:
    out = []
    for ch in text.lower().strip():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_"):
            out.append("-")
    s = "".join(out).strip("-")
    return s[:40] or "run"


def new_run_id(objective: str) -> str:
    ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{ts}-{slugify(objective)}"


def run_path(run_id: str) -> Path:
    return runs_dir() / run_id / "run.json"


def load_run(run_id: str) -> dict[str, Any]:
    p = run_path(run_id)
    if not p.exists():
        raise FileNotFoundError(f"run not found: {run_id}")
    return json.loads(p.read_text())


def save_run(run: dict[str, Any]) -> None:
    p = run_path(run["id"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(run, indent=2))


def set_active(run_id: str) -> None:
    active_pointer().parent.mkdir(parents=True, exist_ok=True)
    active_pointer().write_text(run_id)


def get_active() -> str | None:
    p = active_pointer()
    if not p.exists():
        return None
    rid = p.read_text().strip()
    return rid or None


def resolve_run_id(maybe_id: str | None) -> str:
    if maybe_id:
        return maybe_id
    rid = get_active()
    if not rid:
        raise SystemExit("no active run; pass --run or call `wake start`")
    return rid


# ---------- commands ----------

def cmd_start(args: argparse.Namespace) -> int:
    objective = args.objective.strip()
    if not objective:
        print("error: objective required", file=sys.stderr)
        return 2
    rid = new_run_id(objective)
    run = {
        "id": rid,
        "objective": objective,
        "started_at": now_iso(),
        "cwd": os.getcwd(),
        "notes": [],
        "decisions": [],
        "attempts": [],
        "files": [],
        "commands": [],
        "failures": [],
        "next_step": None,
        "handoff": None,
    }
    save_run(run)
    set_active(rid)
    print(rid)
    return 0


def cmd_note(args: argparse.Namespace) -> int:
    rid = resolve_run_id(args.run)
    run = load_run(rid)
    entry = {"at": now_iso(), "kind": args.kind, "text": args.text}
    bucket = {
        "note": "notes",
        "decision": "decisions",
        "attempt": "attempts",
        "file": "files",
        "command": "commands",
        "failure": "failures",
    }[args.kind]
    run[bucket].append(entry)
    if args.next:
        run["next_step"] = args.next
    save_run(run)
    print(f"ok ({bucket}, {len(run[bucket])})")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    rid = args.run or get_active()
    if not rid:
        print("no active run")
        return 0
    run = load_run(rid)
    if args.json:
        print(json.dumps(run, indent=2))
        return 0
    print(f"run:       {run['id']}")
    print(f"objective: {run['objective']}")
    print(f"started:   {run['started_at']}")
    print(f"cwd:       {run['cwd']}")
    for bucket in ("notes", "decisions", "attempts", "files", "commands", "failures"):
        items = run.get(bucket, [])
        if items:
            print(f"\n{bucket} ({len(items)}):")
            for e in items[-5:]:
                print(f"  - [{e['at']}] {e['text']}")
    if run.get("next_step"):
        print(f"\nnext_step: {run['next_step']}")
    if run.get("handoff"):
        print(f"\nhandoff written at {run['handoff']['at']}")
        print(f"  → {run['handoff']['path']}")
    return 0


def render_handoff(run: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# Wake handoff — {run['id']}")
    lines.append("")
    lines.append(f"- **objective:** {run['objective']}")
    lines.append(f"- **started:** {run['started_at']}")
    lines.append(f"- **cwd:** `{run['cwd']}`")
    if run.get("next_step"):
        lines.append(f"- **next step:** {run['next_step']}")
    lines.append("")
    sections = [
        ("Decisions", "decisions"),
        ("Attempts", "attempts"),
        ("Changed files", "files"),
        ("Commands", "commands"),
        ("Failures", "failures"),
        ("Notes", "notes"),
    ]
    for title, key in sections:
        items = run.get(key, [])
        if not items:
            continue
        lines.append(f"## {title}")
        lines.append("")
        for e in items:
            lines.append(f"- `{e['at']}` — {e['text']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def cmd_handoff(args: argparse.Namespace) -> int:
    rid = resolve_run_id(args.run)
    run = load_run(rid)
    if args.next:
        run["next_step"] = args.next
    out_path = Path(args.out) if args.out else (run_path(rid).parent / "handoff.md")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    md = render_handoff(run)
    out_path.write_text(md)
    run["handoff"] = {"at": now_iso(), "path": str(out_path)}
    save_run(run)
    print(str(out_path))
    if args.print:
        sys.stdout.write(md)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="wake", description="durable agent-run continuity")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_start = sub.add_parser("start", help="start a new run")
    p_start.add_argument("objective", help="what this run is trying to accomplish")
    p_start.set_defaults(func=cmd_start)

    p_note = sub.add_parser("note", help="record a note/decision/attempt/file/command/failure")
    p_note.add_argument("text", help="the entry text")
    p_note.add_argument(
        "--kind",
        choices=["note", "decision", "attempt", "file", "command", "failure"],
        default="note",
    )
    p_note.add_argument("--run", help="run id (default: active)")
    p_note.add_argument("--next", help="set next_step at the same time")
    p_note.set_defaults(func=cmd_note)

    p_status = sub.add_parser("status", help="show active run status")
    p_status.add_argument("--run", help="run id (default: active)")
    p_status.add_argument("--json", action="store_true")
    p_status.set_defaults(func=cmd_status)

    p_hand = sub.add_parser("handoff", help="render a handoff.md for the next agent")
    p_hand.add_argument("--run", help="run id (default: active)")
    p_hand.add_argument("--out", help="output path (default: <run>/handoff.md)")
    p_hand.add_argument("--next", help="set next_step before rendering")
    p_hand.add_argument("--print", action="store_true", help="also print to stdout")
    p_hand.set_defaults(func=cmd_handoff)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
