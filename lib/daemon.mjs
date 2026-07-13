// The daemon: a detached background runner, so a scheduled launch fires at its time
// without a terminal open and without anyone pressing "run".
//
// This is the piece that makes scheduling mean something. Without it, "9am" only
// happened if you happened to be sitting in front of `run` at 9am.
//
// It executes ONLY jobs that carry a time. A sequential job (no time) still waits for
// an explicit manual run — scheduling something must never launch it on the spot.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA, ROOT, alive, loadQueue, readJSON, writeJSON } from './store.mjs';
import { fmt } from './time.mjs';
import { LOCK } from './lock.mjs';
import { runnerStatus } from './runner-status.mjs';

const STATE = path.join(DATA, 'daemon.json');
export const LOG = path.join(DATA, 'daemon.log');
const CLI = path.join(ROOT, 'kaip.mjs');
export const TASK_NAME = 'kaip-daemon';       // Windows Task Scheduler entry

const readState = () => readJSON(STATE, null);
const clearState = () => { try { fs.rmSync(STATE, { force: true }); } catch { /* already gone */ } };

/** The next scheduled launch still pending, if any. */
function nextScheduled(queue = loadQueue()) {
  const times = queue.filter((j) => j.status === 'pending' && j.when).map((j) => j.when);
  return times.length ? Math.min(...times) : null;
}

/**
 * Is it up, since when, and what is it waiting for? Safe to call from anywhere.
 * Cheap on purpose — the GUI repaints this on every keystroke, so no subprocesses here
 * (that's why the autostart check lives in its own function).
 */
export function status() {
  const st = readState();
  const running = Boolean(st?.pid && alive(st.pid));
  if (st && !running) clearState();                     // it died: don't keep claiming it's up

  const queue = loadQueue();
  return {
    running,
    pid: running ? st.pid : null,
    startedAt: running ? st.startedAt : null,
    seq: running ? Boolean(st.seq) : false,
    pending: queue.filter((j) => j.status === 'pending').length,
    next: nextScheduled(queue),
    log: LOG,
  };
}

/** What `start` says when a `kaip run` already has the job. Shared, so nobody rewords it. */
export const RUN_IS_DRAINING = 'a "kaip run" is already draining the queue';

/**
 * Start it. `seq` also drains sequential jobs (off by default: opt in, never by surprise).
 * Idempotent — starting twice just returns the running one.
 *
 * There is ONE daemon, and a `kaip run` is the SAME role: drain the queue. So this is also
 * where we refuse to spawn a second one. The lock is what says who has the job.
 */
export function start({ seq = false } = {}) {
  // The escape hatch, and the one thing standing between a test suite and a pile of
  // orphaned background processes: nothing here may spawn when it's set.
  if (process.env.KAIP_NO_DAEMON) {
    return { started: false, reason: 'disabled by KAIP_NO_DAEMON', ...status() };
  }

  const st = status();
  if (st.running) return { started: false, reason: 'already running', ...st };

  // A daemon spawned now would race for the lock, lose it, and die in silence half a second
  // later — but not before we had written its pid down and announced "daemon started, it
  // will fire on time". Every `add` was spawning one of those. Ask the lock FIRST.
  const runner = runnerStatus();
  if (runner.willFire && runner.kind === 'run') {
    return { started: false, reason: RUN_IS_DRAINING, runner, ...st };
  }

  fs.mkdirSync(DATA, { recursive: true });
  const out = fs.openSync(LOG, 'a');                    // both pipes to the log; nothing on a console
  const args = [CLI, 'daemon', 'run', ...(seq ? ['--seq'] : [])];

  const child = spawn(process.execPath, args, {
    detached: true,                                     // survives the terminal that spawned it
    stdio: ['ignore', out, out],
    windowsHide: true,
    cwd: ROOT,
  });
  child.unref();

  writeJSON(STATE, { pid: child.pid, startedAt: Date.now(), seq: Boolean(seq) });
  return { started: true, pid: child.pid, seq: Boolean(seq), log: LOG };
}

/** Stop it. The lock goes too, or the next runner would wait 2 minutes for it to go stale. */
export function stop() {
  const st = readState();
  if (!st?.pid || !alive(st.pid)) { clearState(); return { stopped: false, reason: 'not running' }; }

  try { process.kill(st.pid); } catch { /* it went away between the check and the kill */ }
  clearState();
  try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ }
  return { stopped: true, pid: st.pid };
}

/**
 * Start it if it isn't up. What the hook, `add` and the GUI call after scheduling something.
 *
 * "If it isn't up" means "if nothing is draining the queue" — not "if there is no daemon".
 * start() is the one that knows the difference, so this is now just its front door.
 */
export function ensure({ seq = false } = {}) {
  return start({ seq });
}

// --- zombies -----------------------------------------------------------------
// There is one daemon and its pid lives in daemon.json. Anything else running `kaip daemon
// run` is a leftover — from a crash, or from a race we used to lose on every `add`. They are
// invisible (windowsHide, output to a log) so nothing tells you they are there; this does.

/** A command line that IS a daemon. The only way to tell one node.exe from another. */
export const isDaemonCmd = (cmd) => /kaip\.mjs["']?\s+daemon\s+run\b/i.test(String(cmd ?? ''));

/** PowerShell's ConvertTo-Json → [{pid, cmd}]. One process comes back as an object, not a list. */
export function parseWinProcs(json) {
  let data;
  try { data = JSON.parse(String(json || '')); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  return list
    .filter((p) => p && p.ProcessId)
    .map((p) => ({ pid: Number(p.ProcessId), cmd: String(p.CommandLine ?? '') }));
}

/** `ps -eo pid=,args=` → [{pid, cmd}]. */
export function parsePosixProcs(text) {
  return String(text || '').split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

/** Every live `kaip daemon run` on this machine, whoever started it. */
export function daemonProcesses() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" "
      + '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true });
    return parseWinProcs(r.stdout).filter((p) => isDaemonCmd(p.cmd));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return parsePosixProcs(r.stdout).filter((p) => isDaemonCmd(p.cmd));
}

/** The pure half, so the test does not need a machine full of daemons: who is unaccounted for. */
export const unaccounted = (procs, knownPid) =>
  procs.filter((p) => p.pid !== knownPid && p.pid !== process.pid);

/** Live daemons that are NOT the one in daemon.json. Nobody is tracking these. */
export function orphans() {
  return unaccounted(daemonProcesses(), readState()?.pid ?? null);
}

/** Kill them. Returns the pids that were swept. */
export function sweep() {
  const dead = orphans();
  for (const p of dead) {
    try { process.kill(p.pid); } catch { /* it beat us to it */ }
  }
  return dead.map((p) => p.pid);
}

// --- autostart (survives a reboot) -------------------------------------------
// Windows only for now: schtasks is there on every machine, no admin rights needed for
// an ONLOGON task. Elsewhere the daemon is started by hand (or by your own init).

/** The schtasks arguments, as a pure function — so the test can read them without running them. */
export function autostartArgs(node = process.execPath, cli = CLI) {
  return [
    '/Create', '/TN', TASK_NAME,
    '/TR', `"${node}" "${cli}" daemon start`,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',                                               // overwrite: install must be idempotent
  ];
}

export function autostartInstalled() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { windowsHide: true });
  return r.status === 0;
}

export function autostartInstall() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'autostart is Windows-only for now; start the daemon from your init/cron' };
  }
  const r = spawnSync('schtasks', autostartArgs(), { encoding: 'utf8', windowsHide: true });
  return r.status === 0
    ? { ok: true, task: TASK_NAME }
    : { ok: false, error: (r.stderr || r.stdout || 'schtasks failed').trim() };
}

export function autostartRemove() {
  if (process.platform !== 'win32') return { ok: false, error: 'autostart is Windows-only for now' };
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'schtasks failed').trim() };
}

// --- the one-line summary the GUI, the hook and `daemon status` all print -----
export function statusLine(st = status()) {
  if (st.running) {
    const next = st.next ? ` · next ${fmt(st.next)}` : ' · nothing scheduled';
    return `daemon: on (pid ${st.pid})${next} · ${st.pending} pending${st.seq ? ' · sequential too' : ''}`;
  }

  // "off" is not the same as "nothing will fire". A `kaip run` drains the queue exactly like
  // the daemon does, and saying otherwise while it does it is the tool lying about itself.
  const r = runnerStatus();
  if (r.willFire && r.kind === 'run') {
    return `daemon: off — but a "kaip run" is draining the queue (pid ${r.pid}); `
      + 'scheduled launches fire, until you close that window';
  }
  return `daemon: off — scheduled launches will NOT fire (start it with: kaip daemon start)`;
}
