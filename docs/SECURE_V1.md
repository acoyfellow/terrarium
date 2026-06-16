# Terrarium secure-v1

`terra secure "task"` is the opt-in hostile/untrusted execution profile. Ordinary `terra "task"` remains the compatible cooperative-agent primitive.

## Guarantees

For the exact policy version recorded in the receipt:

- source enters through an archive copy, never a host bind mount;
- no host environment is forwarded;
- no network namespace attachment (`--network none`);
- read-only container root;
- non-root UID/GID 65534;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- writable workspace and `/tmp` are `noexec,nosuid` tmpfs;
- CPU, memory, PID, wall-time, and output limits;
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
