#!/usr/bin/env bash
# Run a child agent with a trusted shell-command recorder active.
# Usage: run-recorded.sh <cwd> <cmd-log-path> <agent-cmd...>
set -euo pipefail
TARGET_CWD="$(cd "$1" && pwd)"; CMD_LOG="$2"; shift 2
SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/shim-bin" && pwd)"
CMD_DIR="$(dirname "$CMD_LOG")"
mkdir -p "$CMD_DIR"
CMD_DIR_REAL="$(cd "$CMD_DIR" && pwd)"
CMD_LOG_REAL="$CMD_DIR_REAL/$(basename "$CMD_LOG")"
case "$CMD_LOG_REAL" in
  "$TARGET_CWD"/*|"$TARGET_CWD")
    echo "drift-lab: command log must be outside target cwd" >&2
    exit 2
    ;;
esac
: > "$CMD_LOG_REAL"
export DRIFT_CMD_LOG="$CMD_LOG_REAL"
export DRIFT_REAL_PATH="$PATH"
cd "$TARGET_CWD"
PATH="$SHIM_DIR:$PATH" "$@"
