# Bug Report — Terrarium workspace leak + unbounded store growth + doctor false positives

Date: 2026-07-01
Reporter: Jordan (via Pi session)
Severity: **high** (disk exhaustion; 52 GB leaked)

Status (updated 2026-07-17): **MOSTLY RESOLVED.** Verified against current `src/`:
- ✅ isolation `copy` excludes `.git/node_modules/dist/build/target/coverage/.next` (`core.js` `workspaceExcludes()`), so full-monorepo copies no longer balloon the store.
- ✅ workspace auto-GC at terminal unless `keepWorkspace` (`finalizeWorkspace` removes copy via `rm`, worktree via `removeWorktree`; `prepareWorkspace` sets `cleanup: !keepWorkspace`).
- ✅ tests no longer write the real `~/.terrarium` (`test/setup-home.mjs` guard + supervisor `TERRARIUM_HOME` env-pin; verified home file-count unchanged across full suite).
- ✅ doctor now reports `workspaceDirs` + `workspaceBytes` + `leakedWorkspaces` and warns on terminal-run workspaces that survived without `keepWorkspace` (2026-07-17; test in `doctor.test.js`).
- ✅ bounded status/list scan so a large store can't starve `doctor`/`status` past the deadline (`listRuns` recent-file window).
- ⬜ REMAINING (low priority): explicit **retention/compaction** for `runs/`/`events/`/`groups/` (age/size-based GC). Today growth is bounded by the fixes above + manual archive; no automatic compaction. Not a leak, a housekeeping nicety.

## Summary
`~/.terrarium` has grown to a state where `terrarium doctor` returns `ok:false` with a
96-item repair backlog, and the on-disk store is **52 GB in `workspaces/` alone**. The
proximate "what just happened" is that isolated-workspace copies of the *entire*
`/Users/jcoeyman/cloudflare` monorepo were made and never cleaned up.

Disk at report time: `/System/Volumes/Data 460Gi used 348Gi, 71Gi free (84%)`.

## Evidence
`du -sh ~/.terrarium/*`:
```
52G   workspaces      <-- leak
127M  runs            (33,356 run-log files)
37M   events          (117 files)
9.2M  _backup-1782504712
4.0M  groups          (1013 groups)
684K  router
```

Biggest workspaces (`du -sh workspaces/*`):
```
13G   ter_20260630095438043_i44y81-cloudflare
13G   ter_20260629180305533_9homob-cloudflare
5.2G  ter_20260626095428721_84dav0-cloudflare
318M  ...-terrarium  (many, each ~267M node_modules)
```
`*-cloudflare` workspaces total **31 GB** — these are full copies of the monorepo
(all sub-repos' `node_modules`, `.git`, `dist`, build caches included).

## Root causes (ranked)

### 1. `isolation: copy` copies the whole cwd tree with no ignore/prune — HIGH
When a spawn runs with `isolation: copy` and cwd is a large monorepo, Terrarium copies
everything: `node_modules`, `.git`, `dist`, `.svelte-kit`, image assets. Two copies of
`/Users/jcoeyman/cloudflare` landed at 13 GB each.
- Fix: default-exclude `node_modules`, `.git`, `dist`, build/output dirs, and honor
  `.gitignore` (or copy only tracked files: `git archive` / `git worktree` instead of
  recursive `cp`). Add a configurable size ceiling that aborts the copy with a clear
  error instead of silently cloning 13 GB.

### 2. Workspaces are never cleaned up after terminal — HIGH
`keepWorkspace` defaults false, yet 207 workspaces spanning Jun 26–Jul 1 persist. Copy/
worktree workspaces should be removed on terminal unless `keepWorkspace:true`.
- Fix: on run terminal, if `!keepWorkspace`, `rm -rf` the copy / `git worktree remove`.
  Add a GC pass (age- or size-based) and surface leaked-workspace bytes in `doctor`.

### 3. Unbounded run-log / event / group accumulation — MED
33,356 files in `runs/`, 117 event files (37 MB), 1013 groups. No retention policy.
- Fix: retention/compaction (age + count cap) with a `doctor`-suggested prune, like the
  existing callback `prune`.

### 4. Test / e2e fixtures written into the *production* store — MED
295 runs in the real store match `ter_test_*` / `ter_pi_e2e_*`
(`ter_test_orphan_verified`, `ter_test_orphan_pending`, `ter_test_orphan_mismatch`,
`ter_test_recovered_cancel_*`, `ter_pi_e2e_*`). These are the bulk of the 91
"missing terminal callback" and 5 "orphaned run" doctor warnings.
- Fix: tests must use an isolated `TERRARIUM_HOME` / temp store, never `~/.terrarium`.
  Ensure e2e teardown removes fixtures. `doctor` should not count test fixtures against
  a real store.

### 5. `doctor` false-positive on router subdirectories — LOW
`malformedAcknowledgedCallbacks: 12` / `routerRepairCandidates: 12` correspond to the
router *directory entries* `journal/`, `mailboxes/`, `subscribers/`, `_archived-2026-06-27`
being scanned as if they were callback records (`head` on them errors: "Error reading …"
because they are directories). The scanner should skip non-record entries.

## Impact
- 52 GB disk consumed by leaked workspaces (31 GB from 3 monorepo copies).
- `doctor ok:false` permanently, drowning real signal (91 missing-callback entries are
  mostly test fixtures) — operators can't tell a real orphan from noise.
- Session slowness / "what the fuck just happened": large copies + a store this big make
  spawn/status operations slow.

## Suggested immediate remediation (operator, non-destructive first)
```bash
# 1. See the leak
du -sh ~/.terrarium/workspaces/* | sort -rh | head

# 2. Reclaim the 3 full-monorepo copies (31 GB) — SAFE: they are terminal-run copies
rm -rf ~/.terrarium/workspaces/*-cloudflare

# 3. Prune old callbacks/journal noise
#    terrarium_callbacks prune (olderThanMs) ; then recover only genuine runs

# 4. Purge leaked test fixtures from the real store (verify names first)
#    ls ~/.terrarium/runs | grep -E 'ter_test_|ter_pi_e2e_'
```

## Fixes to land in Terrarium
- [ ] `isolation: copy` prune list + `.gitignore` honoring + size ceiling (or use `git archive`/worktree).
- [ ] Auto-remove workspace on terminal unless `keepWorkspace`; add workspace GC.
- [ ] Retention/compaction for `runs/`, `events/`, `groups/`.
- [ ] Tests/e2e must not write to `~/.terrarium`; teardown fixtures.
- [ ] `doctor` skips router subdirectories; separates test fixtures from real orphans.
- [ ] `doctor` reports workspace bytes + leaked-workspace count.
