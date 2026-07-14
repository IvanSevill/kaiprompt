// "Will anything actually fire?"
//
// That is the one question the queue can silently get wrong, and everything in this tool —
// the GUI banner, the goodbye screen, the phone app, the message `add` prints — was
// answering a DIFFERENT question: "is the daemon on?".
//
// They are not the same. A `kaip run` left up in a terminal processes the queue exactly like
// the daemon does; scheduled jobs fire on time and you get your notification. But every
// screen would tell you, in red, that nothing was going to happen. That is worse than an
// unhelpful message — it is the tool lying about its own state while doing the right thing.
//
// So ask the queue, not the daemon: is ANYONE holding the runner lock?

import { lockInfo } from './lock.mjs';
import { status as daemonStatus } from './daemon.mjs';

/**
 * Who, if anyone, is processing the queue.
 *
 *   kind: 'daemon'  the detached background runner — survives closing every window
 *   kind: 'run'     a `kaip run` in a terminal — dies with that window
 *   kind: null      nobody. Scheduled work will NOT fire.
 *
 * `since` is when the runner TOOK the lock, not its last heartbeat: the lock is rewritten
 * every 30s to prove it is alive, but `at` is only ever stamped on the way in. So it is the
 * runner's real start time — which is what "running for 3h" on the phone is built on.
 */
export function runnerStatus() {
  const lock = lockInfo();
  const daemon = daemonStatus();

  if (!lock.held) {
    // The daemon can be up and still not hold the lock for a moment at startup. Trust the
    // daemon's own liveness in that gap rather than declaring the queue dead.
    if (daemon.running) {
      return { willFire: true, kind: 'daemon', pid: daemon.pid, durable: true, since: daemon.startedAt ?? null };
    }
    return { willFire: false, kind: null, pid: null, durable: false, since: null };
  }

  // The lock is held. By the daemon, or by someone at a keyboard?
  const isDaemon = daemon.running && daemon.pid === lock.pid;

  return {
    willFire: true,
    kind: isDaemon ? 'daemon' : 'run',
    pid: lock.pid,
    // The distinction that matters when you are about to close a window: the daemon
    // survives it, a `run` does not.
    durable: isDaemon,
    since: lock.at,
  };
}

/** One line, for a banner. */
export function runnerLine(st = runnerStatus()) {
  if (!st.willFire) {
    return { ok: false, text: 'nothing is processing the queue: scheduled work will NOT fire', hint: 'kaip daemon start' };
  }
  if (st.kind === 'daemon') {
    return { ok: true, text: `daemon up (pid ${st.pid}) — it fires on its own, even with everything closed`, hint: null };
  }
  return {
    ok: true,
    text: `a "kaip run" is processing the queue (pid ${st.pid})`,
    hint: 'close that window and nothing fires any more: kaip daemon start',
  };
}
