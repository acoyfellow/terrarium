#!/usr/bin/env bash
# Generic command shim: logs argv+cwd as a JSON line to $DRIFT_CMD_LOG, then execs the
# real binary (found by walking PATH minus this shim dir) with the original args.
name="$(basename "$0")"
if [ -n "$DRIFT_CMD_LOG" ]; then
  json_args="$(printf '%s\n' "$@" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const parts = s.length ? s.split("\n").slice(0,-1) : [];
      process.stdout.write(JSON.stringify(parts));
    })')"
  printf '{"argv":["%s"%s],"cwd":"%s"}\n' "$name" "$(node -e "const a=$json_args; process.stdout.write(a.length? ','+a.map(x=>JSON.stringify(x)).join(','):'')" )" "$PWD" >> "$DRIFT_CMD_LOG"
fi
real="$(PATH="$DRIFT_REAL_PATH" command -v "$name")"
if [ -z "$real" ]; then
  echo "drift-shim: no real '$name' found on DRIFT_REAL_PATH" >&2
  exit 127
fi
exec "$real" "$@"
