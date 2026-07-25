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
async function liveCmuxTtys(timeoutMs, run) {
  const r = await run("cmux", ["tree", "--all"], { timeoutMs });
  if (r.code !== 0 || r.timedOut) return null; // cmux absent/failed -> unknown
  return parseCmuxTtys(r.stdout);
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

export async function detectHostCapacity({ timeoutMs = 3000, run = spawnCapture } = {}) {
  const cpuCount = os.cpus().length || 1;
  const [load1] = os.loadavg();
  const loadRatio = Number((load1 / cpuCount).toFixed(2));
  const starved = loadRatio > LOAD_RATIO_STARVED;

  const [ttys, piProcs] = await Promise.all([
    liveCmuxTtys(timeoutMs, run),
    listPiProcesses(timeoutMs, run),
  ]);
  const cmuxAvailable = ttys !== null;
  const orphanedPi = classifyOrphans(piProcs, ttys);

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
