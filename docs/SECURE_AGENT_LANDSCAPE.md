# Secure agent landscape research

Research date: 2026-06-17. This is architectural comparison, not a claim that each product has identical threat models.

## Observed patterns

### Full remote computer / sandbox

- [E2B](https://github.com/e2b-dev/E2B) describes cloud sandboxes for AI-generated code and exposes command/code execution through JS and Python SDKs.
- [Daytona](https://github.com/daytonaio/daytona) describes isolated composable computers with dedicated kernel, filesystem, network stack, CPU/RAM/disk, plus SDK/API/CLI filesystem and process operations.
- [OpenHands](https://github.com/All-Hands-AI/OpenHands) runs coding agents across local, Docker, VM, cloud, and enterprise backends, including third-party agents through ACP.

These maximize agent compatibility by presenting a computer or shell. The tradeoff is a broad capability surface: command execution, package managers, network, credentials, and persistent state must be governed at the sandbox/control-plane level.

### Agent-specific command interface

- [SWE-agent](https://github.com/SWE-agent/SWE-agent) and its successor mini-SWE-agent let a chosen model use tools to fix repository issues and security bugs. This optimizes the environment and interface for software-engineering tasks rather than exposing every host capability.

This improves task performance but couples the runtime more closely to an agent design.

### Typed capability tools

MCP and custom tool brokers keep the model client outside while exposing filesystem/test/process operations through schemas. Provider credentials remain outside the workspace. The main cost is tool schema/context size and model round trips.

### Code-mode capability composition

[`mcp-code-mode`](https://github.com/acoyfellow/mcp-code-mode) compresses an MCP server to `search` + `execute`; agent-authored JavaScript composes a positive allowlist of tools in a worker or QuickJS sandbox. The package explicitly notes that guest timeout does not cancel already-started downstream side effects and recommends keeping consequential operations native.

The official experimental [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) targets Worker Loader execution and connectors in Cloudflare Workers.

## Terrarium's chosen composition

```text
Pi / another external agent
  ├─ owns model reasoning and provider transport
  ├─ has built-in host tools disabled
  └─ sees one run-scoped MCP
       ├─ search
       ├─ execute (QuickJS)
       │    └─ allowlisted secure workspace tools
       └─ finish (native and explicit)
            ↓
       secure-v1 Docker workspace
```

This differs from full-computer products by intentionally withholding arbitrary shell, network, package installation, host mounts, and provider credentials. It differs from agent frameworks by leaving planning/model behavior to Pi or another caller.

## Why this shape

- **Agent-independent:** Terrarium wraps the agent rather than becoming one.
- **Credentials outside:** the model transport remains on the host; secrets do not enter Docker.
- **Small model surface:** code mode exposes three top-level tools instead of six eager workspace tools.
- **Typed authority:** every underlying operation is path-confined, bounded, and audited.
- **Two execution boundaries:** QuickJS isolates orchestration code; Docker isolates repository code/tests.
- **Explicit finish:** final tests and diff are a native action rather than hidden inside guest JavaScript.

## Tradeoffs

- Lower compatibility than a full shell/computer.
- Every operation must be modeled as a capability.
- Current `npm test` support assumes dependencies are already present or unnecessary.
- The outer Pi MCP adapter is part of the trusted computing base.
- Docker/host kernel and daemon remain part of the security boundary.
- Tool timeout cannot undo a test process or write that already started; tools need their own bounds and idempotency.

## Current proof

The first vertical slice used Pi to repair a failing parser fixture through only the Terrarium secure MCP. It changed one file in the disposable workspace, passed 2/2 tests, produced a bounded tool audit (`search`, `execute`, `finish`), left the host fixture unchanged, exposed no private model identifier, and verified container teardown. See [SECURE_AGENT_PROOF.md](./SECURE_AGENT_PROOF.md).

## Next comparative benchmark

Run the same five dependency-free Node defects through:

1. ordinary Pi with host tools;
2. Pi wrapped by Terrarium secure-agent;
3. optionally a full sandbox/computer backend.

Measure success, duration, tokens, files changed, tool calls, granted capabilities, host mutation, and teardown. The product goal is not maximum benchmark score; it is maximum useful work per granted capability.
