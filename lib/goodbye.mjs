// How kaip leaves the screen — the same way from the GUI and from `run`, including on
// Ctrl+C.
//
// It clears, so you are not left staring at the wreck of a full-screen interface. And it
// answers the one question that matters as you walk away: is anything still going to
// happen, and is there anything left running to make it happen? Closing up with work
// scheduled and the daemon off is precisely the mistake this tool exists to prevent, so
// it gets said out loud on the way out.

import { loadQueue } from './store.mjs';
import { fmt } from './time.mjs';
import { altExit, c, hardClear, writeLines } from './ui.mjs';
import { status as daemonStatus } from './daemon.mjs';
import { runnerStatus } from './runner-status.mjs';
import { nextScheduledAt } from './schedule.mjs';
import { cachedVersion } from './update.mjs';

export function farewellLines(summary = null) {
  const pending = loadQueue().filter((j) => j.status === 'pending');
  const scheduled = pending.filter((j) => j.when);
  const daemon = daemonStatus();

  const out = ['', c.accent('  ✦ kaip') + c.muted('  — see you'), ''];
  if (summary) {
    out.push(c.muted(`  run: ${summary.completed ?? 0} completed · ${summary.errors ?? 0} errors · ${summary.elapsed ?? '0s'}`));
  }
  const update = cachedVersion();
  if (update) out.push(c.warn(`  📦 Update available: v${update.latest}`));

  if (!pending.length) {
    out.push(c.muted('  the queue is empty. Nothing pending.'));
    return out;
  }

  const next = nextScheduledAt(pending);
  out.push(`  ${c.bold(String(pending.length))} pending`
    + (next ? c.muted(`  ·  next: ${fmt(next)}`) : ''));

  // The goodbye is the LAST place that can warn you, so it has to be right. And the right
  // question is not "is the daemon on?" — a `kaip run` fires scheduled work just as well.
  // But it is the last place worth saying that a run does not survive its window, either.
  if (daemon.running) {
    out.push(c.ok(`  ◆ daemon up (pid ${daemon.pid})`)
      + c.muted(daemon.seq ? ' — draining the queue on its own.' : ' — it sends scheduled work on its own.'));
  } else if (scheduled.length) {
    const r = runnerStatus();

    if (!r.willFire) {
      out.push('',
        c.err('  ⚠ nothing is processing the queue: scheduled work will NOT fire.'),
        c.muted('    start it with:  ') + c.accent('kaip daemon start'));
    } else {
      out.push(
        c.ok(`  ◆ a "kaip run" is processing the queue (pid ${r.pid})`),
        c.warn('    but it dies if you close that window. ') + c.muted('To make it survive: ')
          + c.accent('kaip daemon start'));
    }
  }

  const seq = pending.length - scheduled.length;
  if (seq && !(daemon.running && daemon.seq)) {
    out.push(c.muted(`  ${seq} with no time: ${seq === 1 ? 'it waits' : 'they wait'} for a `)
      + c.accent('kaip run') + c.muted('.'));
  }
  return out;
}

/**
 * Leave the full-screen buffer, clear, and say goodbye. Safe to call twice — only the
 * first one prints.
 *
 * altExit() has to come FIRST. Printing while the alternate screen is still up puts the
 * farewell on the buffer we are about to throw away: it was being written, correctly, onto
 * a screen that then vanished. Hence "no hace el clear" — it did, just somewhere you never
 * got to see.
 */
let said = false;
export function goodbye(summary = null) {
  if (said) return;
  said = true;
  altExit();                    // back to the real screen…
  hardClear();                  // …wipe it for real (conhost ignores the ANSI erase)…
  writeLines(farewellLines(summary).join('\n') + '\n');   // …and say it where it can be read
}
