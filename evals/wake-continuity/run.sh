#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD/evals/wake-continuity"
MODEL_AGENT=${MODEL_AGENT:-"opencode run"}

rm -rf "$ROOT/runs/no-terrarium/wake" "$ROOT/runs/with-terrarium/wake"

$MODEL_AGENT "$(cat "$ROOT/task-no-terrarium.md")" | tee "$ROOT/runs/no-terrarium/transcript.txt"
$MODEL_AGENT "$(cat "$ROOT/task-with-terrarium.md")" | tee "$ROOT/runs/with-terrarium/transcript.txt"
