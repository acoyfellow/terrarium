# Secure agent vertical-slice proof

Date: 2026-06-17

Command shape:

```sh
terra secure-agent --model <private-model> --cwd fixtures/secure-agent-parser \
  "fix parsePort so all tests pass"
```

The model/provider identity is private and is not stored in the receipt.

## Result

```json
{
  "profile": "secure-v1",
  "testsPassed": true,
  "filesChanged": 1,
  "paths": ["parser.js"],
  "toolAudit": [
    { "server": "terrarium-secure", "tool": "search", "isError": false },
    { "server": "terrarium-secure", "tool": "execute", "isError": false },
    { "server": "terrarium-secure", "tool": "finish", "isError": false }
  ],
  "teardownVerified": true,
  "containsPrivateModelName": false
}
```

The agent changed only the disposable container copy. The host fixture remained byte-for-byte unchanged. The repaired parser accepted integer ports 1–65535 and rejected fractions, zero, negatives, and values above 65535. Both tests passed.

## Authority

Pi ran outside Docker as model transport with built-in tools disabled. It had no host read/write/bash tools. The only enabled work surface was one run-scoped MCP. Code-mode orchestration ran in QuickJS and exposed six allowlisted workspace operations. Repository tests ran inside the no-network secure-v1 Docker container.

## Limits

This proves one dependency-free Node bug-fix fixture, not broad repository compatibility. The MCP adapter is currently a required local Pi extension. Package installation, arbitrary shell, binary files, and network-dependent tasks remain unsupported.
