// wake 0.0.1 — durable agent-run continuity, single-file, zero deps.
//
// Storage layout (override root with $WAKE_HOME, default ~/.wake):
//   <home>/active                       run-id of the currently open run, if any
//   <home>/last                         run-id of the most recently handed-off run
//   <home>/runs/<run-id>/run.json       run header + final summary
//   <home>/runs/<run-id>/journal.ndjson append-only event log (source of truth)
//   <home>/runs/<run-id>/HANDOFF.md     generated on `wake handoff`
//
// Run resolution (first match wins): --id flag, $WAKE_RUN_ID,
// active pointer, last pointer, most-recent dir under runs/, error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

export const VERSION = "0.0.1";

// ---------- paths ----------

export function home() {
  return process.env.WAKE_HOME || path.join(os.homedir(), ".wake");
}

function runsDir() {
  return path.join(home(), "runs");
}

function runDir(id) {
  return path.join(runsDir(), id);
}

function activePath() {
  return path.join(home(), "active");
}

function lastPath() {
  return path.join(home(), "last");
}

// ---------- helpers ----------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writePointer(file, value) {
  ensureDir(home());
  // atomic-ish: write tmp then rename
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, value + "\n");
  fs.renameSync(tmp, file);
}

function clearPointer(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function readPointer(file) {
  if (!fs.existsSync(file)) return null;
  const v = fs.readFileSync(file, "utf8").trim();
  return v || null;
}

function nowIso() {
  return new Date().toISOString();
}

function newRunId() {
  // wake_YYYYMMDD_HHMMSS_<6 random hex>  — sorts lexicographically by time
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const rand = Math.random().toString(16).slice(2, 8);
  return `wake_${stamp}_${rand}`;
}

function safeGitInfo(cwd) {
  const info = { root: null, head: null, dirtyAtStart: null };
  try {
    info.root = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    info.head = execSync("git rev-parse --short HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const status = execSync("git status --porcelain", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    info.dirtyAtStart = status.trim().length > 0;
  } catch {
    // not a git repo / no git installed: that's fine
  }
  return info;
}

// ---------- journal I/O ----------

function appendEvent(id, evt) {
  const dir = runDir(id);
  ensureDir(dir);
  const line = JSON.stringify({ ts: nowIso(), ...evt }) + "\n";
  fs.appendFileSync(path.join(dir, "journal.ndjson"), line);
}

// Read NDJSON tolerantly: skip blank lines and a trailing partial/malformed line.
export function readJournal(id) {
  const file = path.join(runDir(id), "journal.ndjson");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerate exactly the trailing line being partial; surface anything else
      if (i !== lines.length - 1 && i !== lines.length - 2) {
        // mid-file corruption: skip but don't throw — the user wants
        // continuity, not a wedged tool.
      }
    }
  }
  return out;
}

function writeRunJson(id, data) {
  const file = path.join(runDir(id), "run.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readRunJson(id) {
  const file = path.join(runDir(id), "run.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------- run resolution ----------

export function resolveRunId(explicit) {
  if (explicit) return explicit;
  if (process.env.WAKE_RUN_ID) return process.env.WAKE_RUN_ID;
  const a = readPointer(activePath());
  if (a) return a;
  const l = readPointer(lastPath());
  if (l) return l;
  // most recent dir
  if (!fs.existsSync(runsDir())) return null;
  const dirs = fs
    .readdirSync(runsDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

// ---------- summary (used by status + handoff) ----------

export function summarize(id) {
  const run = readRunJson(id);
  const events = readJournal(id);
  const decisions = [];
  const attempts = [];
  const failures = [];
  const commands = [];
  const filesByPath = new Map(); // dedupe, last write wins
  const nexts = [];
  for (const e of events) {
    if (e.kind === "decision") decisions.push(e);
    else if (e.kind === "attempt") attempts.push(e);
    else if (e.kind === "failure") failures.push(e);
    else if (e.kind === "command") commands.push(e);
    else if (e.kind === "file") filesByPath.set(e.path, e);
    else if (e.kind === "next") nexts.push(e);
  }
  return {
    run,
    events,
    decisions,
    attempts,
    failures,
    commands,
    files: [...filesByPath.values()],
    nextStep: nexts.length ? nexts[nexts.length - 1].text : null,
  };
}

// ---------- commands ----------

export function cmdStart({ objective, cwd = process.cwd() }) {
  if (!objective) throw new Error("wake start: --objective is required");
  const existing = readPointer(activePath());
  if (existing && fs.existsSync(runDir(existing))) {
    throw new Error(
      `wake start: run ${existing} is still active. Run \`wake handoff\` or \`wake abandon\` first.`,
    );
  }
  const id = newRunId();
  ensureDir(runDir(id));
  const run = {
    id,
    version: VERSION,
    objective,
    cwd,
    git: safeGitInfo(cwd),
    startedAt: nowIso(),
    finishedAt: null,
    status: "open",
    handoff: null,
  };
  writeRunJson(id, run);
  appendEvent(id, { kind: "start", objective });
  writePointer(activePath(), id);
  return id;
}

const KINDS = new Set([
  "decision",
  "attempt",
  "command",
  "failure",
  "file",
  "next",
  "note",
]);

export function cmdNote({ id, kind, text, path: filePath, cmd, exit, ok, outputTail }) {
  const target = resolveRunId(id);
  if (!target) throw new Error("wake note: no run found (start one with `wake start`).");
  if (!fs.existsSync(runDir(target)))
    throw new Error(`wake note: run ${target} does not exist.`);
  if (!kind) throw new Error("wake note: --kind is required");
  if (!KINDS.has(kind))
    throw new Error(`wake note: unknown kind "${kind}". Allowed: ${[...KINDS].join(", ")}`);

  const evt = { kind };
  if (kind === "file") {
    if (!filePath) throw new Error("wake note --kind file: --file is required");
    evt.path = filePath;
    if (text) evt.note = text;
  } else if (kind === "command") {
    if (!cmd) throw new Error("wake note --kind command: --cmd is required");
    evt.cmd = cmd;
    if (exit !== undefined && exit !== null) evt.exit = Number(exit);
    if (outputTail) evt.outputTail = String(outputTail).slice(-8000);
  } else if (kind === "attempt") {
    if (!text) throw new Error("wake note --kind attempt: --text is required");
    evt.text = text;
    if (ok !== undefined) evt.ok = Boolean(ok);
  } else {
    if (!text) throw new Error(`wake note --kind ${kind}: --text is required`);
    evt.text = text;
  }
  appendEvent(target, evt);
  return { id: target, event: evt };
}

export function renderHandoff(id) {
  const s = summarize(id);
  const r = s.run || { objective: "(unknown)", id, startedAt: "", cwd: "" };
  const lines = [];
  lines.push(`# Wake handoff — ${r.id}`);
  lines.push("");
  lines.push(`**Objective:** ${r.objective}`);
  lines.push(`**Started:** ${r.startedAt}`);
  if (r.finishedAt) lines.push(`**Finished:** ${r.finishedAt}`);
  lines.push(`**cwd:** ${r.cwd}`);
  if (r.git && r.git.head) lines.push(`**git:** ${r.git.head}${r.git.dirtyAtStart ? " (dirty at start)" : ""}`);
  lines.push("");
  if (r.handoff && r.handoff.summary) {
    lines.push("## Summary");
    lines.push(r.handoff.summary);
    lines.push("");
  }
  lines.push("## Next step");
  lines.push(s.nextStep || "(none recorded)");
  lines.push("");
  lines.push("## Decisions");
  if (!s.decisions.length) lines.push("- (none)");
  for (const d of s.decisions) lines.push(`- ${d.text}`);
  lines.push("");
  lines.push("## Attempts");
  if (!s.attempts.length) lines.push("- (none)");
  for (const a of s.attempts)
    lines.push(`- [${a.ok === false ? "fail" : a.ok === true ? " ok " : "  ? "}] ${a.text}`);
  lines.push("");
  lines.push("## Failures");
  if (!s.failures.length) lines.push("- (none)");
  for (const f of s.failures) lines.push(`- ${f.text}`);
  lines.push("");
  lines.push("## Commands");
  if (!s.commands.length) lines.push("- (none)");
  for (const c of s.commands) {
    const exit = c.exit === undefined ? "" : ` (exit ${c.exit})`;
    lines.push(`- \`${c.cmd}\`${exit}`);
  }
  lines.push("");
  lines.push("## Changed files");
  if (!s.files.length) lines.push("- (none)");
  for (const f of s.files) lines.push(`- ${f.path}`);
  lines.push("");
  return lines.join("\n");
}

export function cmdStatus({ id, json = false } = {}) {
  const target = resolveRunId(id);
  if (!target) return { ok: false, message: "no runs found" };
  const s = summarize(target);
  if (json) return { ok: true, id: target, ...s };
  return { ok: true, id: target, text: renderHandoff(target) };
}

export function cmdHandoff({ id, summary, next }) {
  const target = resolveRunId(id);
  if (!target) throw new Error("wake handoff: no run found");
  const run = readRunJson(target);
  if (!run) throw new Error(`wake handoff: run ${target} missing run.json`);

  // resolve next: explicit > most recent kind:next note
  const s = summarize(target);
  const finalNext = next || s.nextStep || null;

  const evt = { kind: "handoff" };
  if (summary) evt.summary = summary;
  if (finalNext) evt.next = finalNext;
  appendEvent(target, evt);

  run.finishedAt = nowIso();
  run.status = "handoff";
  run.handoff = { summary: summary || null, next: finalNext };
  writeRunJson(target, run);

  const md = renderHandoff(target);
  fs.writeFileSync(path.join(runDir(target), "HANDOFF.md"), md);

  // active -> last (only clear active if it points at *this* run)
  if (readPointer(activePath()) === target) clearPointer(activePath());
  writePointer(lastPath(), target);

  return {
    id: target,
    handoffPath: path.join(runDir(target), "HANDOFF.md"),
    next: finalNext,
  };
}

export function cmdResume({ id } = {}) {
  // Convenience: print HANDOFF.md if present, else status.
  const target = resolveRunId(id);
  if (!target) return { ok: false, message: "no runs found" };
  const handoff = path.join(runDir(target), "HANDOFF.md");
  if (fs.existsSync(handoff)) {
    return { ok: true, id: target, text: fs.readFileSync(handoff, "utf8") };
  }
  return cmdStatus({ id: target });
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  // tiny long-flag parser: --key value, --flag (boolean), --key=value
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key, val;
      if (eq > -1) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          val = true;
        } else {
          val = next;
          i++;
        }
      }
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `wake ${VERSION} — durable agent-run continuity

Usage:
  wake start    --objective "<text>"
  wake note     --kind <decision|attempt|command|failure|file|next|note> [opts]
                  decision/failure/next/note: --text "..."
                  attempt:                    --text "..." [--ok]
                  command:                    --cmd "..." [--exit N] [--output-tail "..."]
                  file:                       --file <path> [--text "..."]
  wake status   [--id <run>] [--json]
  wake handoff  [--id <run>] [--summary "..."] [--next "..."]
  wake resume   [--id <run>]
  wake list

Env:
  WAKE_HOME      override storage root (default ~/.wake)
  WAKE_RUN_ID    pin a run id without using pointers
`;

export async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub === "--version" || sub === "-v" || sub === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const a = parseArgs(rest);
  try {
    if (sub === "start") {
      const id = cmdStart({ objective: a.objective });
      process.stdout.write(`${id}\n`);
      return 0;
    }
    if (sub === "note") {
      const r = cmdNote({
        id: a.id,
        kind: a.kind,
        text: a.text,
        path: a.file,
        cmd: a.cmd,
        exit: a.exit,
        ok: a.ok === true || a.ok === "true",
        outputTail: a["output-tail"],
      });
      process.stdout.write(`${r.id} ${r.event.kind}\n`);
      return 0;
    }
    if (sub === "status") {
      const r = cmdStatus({ id: a.id, json: a.json === true || a.json === "true" });
      if (!r.ok) {
        process.stderr.write(r.message + "\n");
        return 1;
      }
      if (a.json === true || a.json === "true") {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else {
        process.stdout.write(r.text);
      }
      return 0;
    }
    if (sub === "handoff") {
      const r = cmdHandoff({ id: a.id, summary: a.summary, next: a.next });
      process.stdout.write(`${r.handoffPath}\n`);
      if (r.next) process.stdout.write(`next: ${r.next}\n`);
      return 0;
    }
    if (sub === "resume") {
      const r = cmdResume({ id: a.id });
      if (!r.ok) {
        process.stderr.write(r.message + "\n");
        return 1;
      }
      process.stdout.write(r.text);
      return 0;
    }
    if (sub === "list") {
      if (!fs.existsSync(runsDir())) return 0;
      const dirs = fs
        .readdirSync(runsDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      for (const d of dirs) process.stdout.write(d + "\n");
      return 0;
    }
    process.stderr.write(`unknown command: ${sub}\n${HELP}`);
    return 2;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}
