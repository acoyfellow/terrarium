# Terrarium secure-v1

`terra secure "task"` is the opt-in hostile/untrusted execution profile. Ordinary `terra "task"` remains the compatible cooperative-agent primitive.

## Guarantees

For the exact policy version recorded in the receipt:

- source enters through an archive copy, never a host bind mount;
- no host environment is forwarded into the container (`docker run` receives no `-e` flags);
- no network namespace attachment (`--network none`);
- read-only container root;
- non-root UID/GID 65534;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- writable workspace and `/tmp` are `noexec,nosuid` tmpfs;
- explicit resource limits for the `secure-v1` profile: `--cpus 1`, `--memory 512m`, `--pids-limit 32`, 300s wall-time, 65536-byte captured-output cap, and `size=64m`/`size=16m` `noexec,nosuid` tmpfs for `/workspace` and `/tmp`;
- forced container teardown;
- receipt binds task digest, source revision, profile, timestamps, and result.

## Non-guarantees

- `noexec` does not stop an explicitly available interpreter from reading code as data.
- Docker is a security boundary implemented by the host kernel; secure-v1 does not claim resistance to kernel/container-runtime vulnerabilities.
- Network-enabled variants have broader authority and are not secure-v1.
- Copy/worktree isolation in ordinary `terra` is workspace separation, not this sandbox.
- secure-v1 does not currently provide package installation or arbitrary network-dependent coding tasks.

## Seven-minute quickstart

```sh
npm install
npm test
terra hardening verify
terra secure "run the repository tests"
```

Read the JSON receipt. A successful task is not sufficient on its own: `teardownVerified` and the recorded profile are part of the result.

## Secure agent wrapper

```sh
terra secure-agent --model <model-id> --cwd ./repo "fix the failing parser test"
```

Pi remains the agent and model transport on the host. Terrarium launches it with built-in tools disabled and a run-scoped code-mode MCP. The host Pi process receives only an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, and `XDG_*`); provider/API-key environment variables are dropped. Because `HOME` is forwarded and provider extensions stay enabled, provider credentials stored under `HOME` remain reachable by the trusted host Pi transport. They are never copied into, nor reachable from inside, the disposable container.

The tool surface has two layers. The Pi agent on the host sees only the code-mode MCP tools `search` and `execute`, plus the native `finish` action — these are the only tool names the audit allows, and the only names that appear in the receipt's `toolAudit`. Agent-authored orchestration JavaScript runs inside a QuickJS sandbox (via `execute`) and from there can call only the six brokered workspace tools `list_files`, `read_file`, `search_text`, `write_file`, `run_tests`, and `get_diff`, each operating inside the disposable secure-v1 container. `finish` stays a native explicit action (it is not callable from inside the sandbox) and runs the tests and bounded diff exactly once.

The receipt includes only the safe tool audit (`search`/`execute`/`finish` metadata), final summary, test result, diff, source revision, and teardown proof. Provider/model identity and raw Pi events remain private.

Current scope: one proven dependency-free Node fixture. Package installation, network use, arbitrary shell, binary edits, and broad repository compatibility remain unsupported.
