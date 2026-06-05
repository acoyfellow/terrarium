# Environment leak fixture

This is an intentionally synthetic containment defect for proving Terrarium's public reporting and remediation workflows.

- `vulnerable.json` enables injection of a planted canary and should report `escaped`.
- `fixed.json` disables the canary injection and should report `contained`.

Neither variant contains a real secret. The vulnerable variant is not a discovered vulnerability and must not be published as one.
