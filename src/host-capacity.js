import os from "node:os";
import { spawnCapture } from "./core.js";

// Host-capacity detection. The 2026-07-24 incident showed that a synchronous
// spawn step (git metadata) could cross the MCP RPC deadline when the host was
// CPU-starved by leaked pi processes from closed cmux panes. The git call is now
// bounded (core.js), but the STARVATION itself is a real, recurring host fault:
// closing a cmux pane does not always kill its pi, and a stuck pi can peg a core
// for days. This module reports that condition so doctor + a spawn preflight can
// surface it as a host-capacity fault rather than an opaque timeout.

const LOAD_RATIO_STARVED = (() => {
  const v = Number(process.env.TERRARIUM_LOAD_RATIO_STARVED);
  return Number.isFinite(v) && v > 0 ? v : 1.5; // 1-min loadavg > 1.5x cpu count
})();

// Orphaned-pi detection: a `pi` process whose controlling tty is NOT a live cmux
// surface. cmux keeps each pane's tty in `cmux tree --all` (tty=ttysNNN). A pi on
// a tty absent from that set is a leak from a closed pane (the exact 7721/8162
// class). cmux is optional: if it is not installed, we cannot classify orphans,
// so we report cmuxAvailable:false and an empty list rather than guessing.
function parseCmuxTtys(stdout) {
  const set = new Set();
  for (const m of stdout.matchAll(/tty=(ttys\d+)/g)) set.add(m[1]);
  return set;
}

function parseTmuxTtys(stdout) {
  const set = new Set();
  for (const line of stdout.split("\n")) {
    const value = line.trim();
    const tty = normTty(value.startsWith("/dev/") ? value.slice(5) : value);
    if (tty) set.add(tty);
  }
  return set;
}

async function liveCmuxTtys(timeoutMs, run) {
  const r = await run("cmux", ["tree", "--all"], { timeoutMs });
  if (r.code !== 0 || r.timedOut) return null;
  return parseCmuxTtys(r.stdout);
}

async function liveTmuxTtys(timeoutMs, run) {
  const r = await run("tmux", ["list-panes", "-a", "-F", "#{pane_tty}"], { timeoutMs });
  if (r.code !== 0 || r.timedOut) return new Set();
  return parseTmuxTtys(r.stdout);
}

// List pi processes with pid, controlling tty, %cpu, elapsed time. Uses `ps`
// which is portable on macOS/Linux. Returns [] on any failure (best-effort).
export function parsePiProcesses(stdout) {
  const procs = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // comm may be a path; match the trailing basename === 'pi'.
    const m = t.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, tty, pcpu, etime, comm] = m;
    const base = comm.split("/").pop();
    if (base !== "pi") continue;
    // ps prints tty as 'ttysNNN' (macOS/Linux) or '??' (no controlling terminal).
    // cmux tree prints 'tty=ttysNNN', so the ps value compares directly.
    procs.push({ pid: Number(pid), tty: tty === "??" ? null : normTty(tty), pcpu: Number(pcpu), etime });
  }
  return procs;
}
async function listPiProcesses(timeoutMs, run) {
  // -o with no header on macOS uses trailing '='; ask for tty,pid,pcpu,etime,comm.
  const r = await run("ps", ["-eo", "pid=,tty=,pcpu=,etime=,comm="], { timeoutMs });
  if (r.code !== 0 || r.timedOut) return [];
  return parsePiProcesses(r.stdout);
}

// Pure classifier (deterministic, testable): given the pi process list and the
// set of live cmux ttys, return the orphans (a pi on a real tty that is NOT a
// live cmux surface). A tty-less pi (detached, tty=null) is NOT an orphan — it
// is a background process, not a leaked pane.
export function classifyOrphans(piProcs, cmuxTtys) {
  if (cmuxTtys === null) return [];
  const orphans = [];
  for (const p of piProcs) {
    if (p.tty && !cmuxTtys.has(p.tty)) orphans.push({ pid: p.pid, tty: p.tty, pcpu: p.pcpu, etime: p.etime });
  }
  return orphans;
}

// Normalize a ps tty field to the 'ttysNNN' form cmux emits. macOS ps already
// prints 'ttys003'; some Linux ps print 'pts/3' or 's003'. Only the macOS/cmux
// 'ttysNNN' form is matched; anything else is passed through unchanged (it will
// simply not match a cmux tty, which is the safe/conservative outcome).
function normTty(tty) {
  if (!tty) return null;
  if (tty.startsWith("ttys")) return tty;
  if (/^s\d+$/.test(tty)) return `tty${tty}`;
  return tty;
}

function isPaneLeaked(processInfo, cmuxTtys, tmuxTtys) {
  return cmuxTtys !== null && Boolean(processInfo.tty) && !cmuxTtys.has(processInfo.tty) && !tmuxTtys.has(processInfo.tty);
}

async function currentPiProcess(pid, timeoutMs, run) {
  const r = await run("ps", ["-p", String(pid), "-o", "pid=,tty=,pcpu=,etime=,comm="], { timeoutMs });
  if (r.code !== 0 || r.timedOut) return null;
  return parsePiProcesses(r.stdout).find((processInfo) => processInfo.pid === Number(pid)) ?? null;
}

async function ancestorPids(processId, timeoutMs, run) {
  const ancestors = new Set();
  let current = Number(processId);
  while (Number.isInteger(current) && current > 1 && !ancestors.has(current)) {
    ancestors.add(current);
    const r = await run("ps", ["-o", "ppid=", "-p", String(current)], { timeoutMs });
    const parentText = r.code === 0 && !r.timedOut ? r.stdout.trim() : "";
    if (!/^\d+$/.test(parentText)) return { ancestors, complete: false };
    const parent = Number(parentText);
    if (!Number.isInteger(parent) || parent < 1 || parent === current) return { ancestors, complete: false };
    current = parent;
  }
  return { ancestors, complete: current === 1 };
}

function processAlive(pid, kill) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reapOrphanedPi({ timeoutMs = 3000, processId = process.pid, run = spawnCapture, kill = process.kill, sleep = wait } = {}) {
  const ancestry = await ancestorPids(processId, timeoutMs, run);
  if (!ancestry.complete) {
    return {
      ok: false,
      reaped: [],
      skipped: [{ reason: "ancestor-chain-unavailable" }],
      ancestorPids: [...ancestry.ancestors],
    };
  }

  const [cmuxTtys, tmuxTtys, piProcesses] = await Promise.all([
    liveCmuxTtys(timeoutMs, run),
    liveTmuxTtys(timeoutMs, run),
    listPiProcesses(timeoutMs, run),
  ]);
  const reaped = [];
  const skipped = [];

  for (const candidate of piProcesses) {
    if (!isPaneLeaked(candidate, cmuxTtys, tmuxTtys)) continue;
    if (ancestry.ancestors.has(candidate.pid)) {
      skipped.push({ pid: candidate.pid, tty: candidate.tty, reason: "own-ancestor" });
      continue;
    }

    const [current, currentCmuxTtys, currentTmuxTtys] = await Promise.all([
      currentPiProcess(candidate.pid, timeoutMs, run),
      liveCmuxTtys(timeoutMs, run),
      liveTmuxTtys(timeoutMs, run),
    ]);
    if (!current || !isPaneLeaked(current, currentCmuxTtys, currentTmuxTtys)) {
      skipped.push({ pid: candidate.pid, tty: candidate.tty, reason: "no-longer-pane-leaked" });
      continue;
    }

    try {
      kill(candidate.pid, "SIGTERM");
    } catch {
      skipped.push({ pid: candidate.pid, tty: candidate.tty, reason: "sigterm-failed" });
      continue;
    }
    await sleep(2000);
    const killed = processAlive(candidate.pid, kill);
    if (killed) {
      try {
        kill(candidate.pid, "SIGKILL");
      } catch {
        skipped.push({ pid: candidate.pid, tty: candidate.tty, reason: "sigkill-failed" });
        continue;
      }
    }
    reaped.push({ pid: candidate.pid, tty: candidate.tty, signal: killed ? "SIGKILL" : "SIGTERM" });
  }

  return {
    ok: skipped.length === 0,
    reaped,
    skipped,
    ancestorPids: [...ancestry.ancestors],
  };
}

export async function detectHostCapacity({ timeoutMs = 3000, run = spawnCapture } = {}) {
  const cpuCount = os.cpus().length || 1;
  const [load1] = os.loadavg();
  const loadRatio = Number((load1 / cpuCount).toFixed(2));
  const starved = loadRatio > LOAD_RATIO_STARVED;

  const [ttys, tmuxTtys, piProcs] = await Promise.all([
    liveCmuxTtys(timeoutMs, run),
    liveTmuxTtys(timeoutMs, run),
    listPiProcesses(timeoutMs, run),
  ]);
  const cmuxAvailable = ttys !== null;
  const orphanedPi = classifyOrphans(piProcs, ttys).filter((processInfo) => !tmuxTtys.has(processInfo.tty));

  return {
    cpuCount,
    loadavg1: Number(load1.toFixed(2)),
    loadRatio,
    loadRatioThreshold: LOAD_RATIO_STARVED,
    starved,
    cmuxAvailable,
    piProcessCount: piProcs.length,
    orphanedPi,
    orphanedPiCount: orphanedPi.length,
  };
}
