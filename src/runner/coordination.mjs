import fs from 'node:fs';
import path from 'node:path';

import { alive, readJSON } from '../storage/json.mjs';
import { DATA } from '../storage/paths.mjs';
import { lockInfo } from './lock.mjs';

export const DAEMON_STATE = path.join(DATA, 'daemon.json');

export const readDaemonState = () => readJSON(DAEMON_STATE, null);
export const clearDaemonState = () => {
  try { fs.rmSync(DAEMON_STATE, { force: true }); } catch { /* already gone */ }
};

export function daemonProcessStatus() {
  const state = readDaemonState();
  const running = Boolean(state?.pid && alive(state.pid));
  if (state && !running) clearDaemonState();
  return {
    running,
    pid: running ? state.pid : null,
    startedAt: running ? state.startedAt : null,
    seq: running ? Boolean(state.seq) : false,
  };
}

export function runnerStatus() {
  const lock = lockInfo();
  const daemon = daemonProcessStatus();
  if (!lock.held) {
    return daemon.running
      ? { willFire: true, kind: 'daemon', pid: daemon.pid, durable: true, since: daemon.startedAt ?? null }
      : { willFire: false, kind: null, pid: null, durable: false, since: null };
  }
  const isDaemon = daemon.running && daemon.pid === lock.pid;
  return {
    willFire: true,
    kind: isDaemon ? 'daemon' : 'run',
    pid: lock.pid,
    durable: isDaemon,
    since: lock.at,
  };
}

export function runnerLine(status = runnerStatus()) {
  if (!status.willFire) {
    return { ok: false, text: 'nothing is processing the queue: scheduled work will NOT fire', hint: 'kaip daemon start' };
  }
  if (status.kind === 'daemon') {
    return { ok: true, text: `daemon up (pid ${status.pid}) — it fires on its own, even with everything closed`, hint: null };
  }
  return {
    ok: true,
    text: `a "kaip run" is processing the queue (pid ${status.pid})`,
    hint: 'close that window and nothing fires any more: kaip daemon start',
  };
}
