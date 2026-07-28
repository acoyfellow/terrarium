# BUGREPORT 2026-07-28: cmux surface resume leaves Pi children alive after pane close

Status: **BLOCKED — cmux application source is not present locally.**

## Observed condition

Terrarium host diagnostics identified `pi` processes launched through `cmux-surface-resume` wrappers under `/var/folders/.../cmux-surface-resume/pi-*.zsh`. Their controlling TTYs were absent from `cmux tree --all`, which is the pane-leak condition Terrarium now checks before reaping.

`/Applications/cmux.app` is installed as cmux `0.64.17` (bundle build `97`, `CMUXCommit` `9ed29d81a`). Its executable contains the strings `cmux-surface-resume`, `TerminalSurfaceHeadlessWindowCloseRequest`, `surface.close`, and `SIGTERM`, but it contains no editable source tree.

## Reproduction

1. Open a cmux terminal or agent surface that launches Pi through the surface-resume path.
2. Start a long-running Pi process.
3. Close the surface with `cmux close-surface --surface <surface-id>`.
4. Confirm that its TTY no longer appears in `cmux tree --all`.
5. Confirm the Pi process remains in `ps -eo pid=,tty=,pcpu=,etime=,comm=` with that absent TTY.

## Required cmux change

At the terminal or agent-surface teardown path that owns the child launched by `cmux-surface-resume`, retain the spawned Pi child PID and terminate it when the surface closes. Send `SIGTERM` during teardown and wait for child exit before releasing the surface. The needed source entry point is the implementation behind terminal surface close / `TerminalSurfaceHeadlessWindowCloseRequest` that starts or resumes the `cmux-surface-resume` Pi wrapper.

The change needs a regression test that creates a resumable Pi child, closes its surface, and verifies the child receives `SIGTERM` and no longer exists.

## Locations checked

- `/Users/jcoeyman/cloudflare/cmux-webchat`: an unrelated Node adapter repository, already containing user changes; it does not implement terminal surfaces or resume wrappers and was not modified.
- `/Users/jcoeyman/cloudflare/cmux*`: no cmux application source checkout.
- `~/Applications/cmux`: absent.
- `/Applications/cmux.app`: packaged binary and resources only, no source checkout.
- Local Git repositories under `/Users/jcoeyman`: no repository with origin `manaflow-ai/cmux`.

The cmux upstream is reachable as `https://github.com/manaflow-ai/cmux.git`, but no matching source checkout is available locally. Supply a clean checkout at commit `9ed29d81a` (or the source revision used for the installed app) and the terminal-surface teardown implementation can be changed and tested there.
