// The full-screen runner: the big countdown while it waits, the live feed while it runs.
//
// This is the one you sit in front of. Everything it draws comes from frames.mjs; what
// lives here is the loop, the keys, and knowing which of the two states we are in.

import { nowMs } from './store.mjs';
import { sleep, fmt, hhmmss, humanDur } from './time.mjs';
import { nextScheduledAt, nextUp, pendingJobs } from './schedule.mjs';
import { commit, launch, markRunning } from './launch.mjs';
import { jobPreview } from './prompt.mjs';
import { clockFrame, completionFrame, eventLines, idleFrame, quotaWaitFrame, runningFrame } from './frames.mjs';
import { aggregateUsage } from './usage.mjs';
import { goodbye } from './goodbye.mjs';
import { altEnter, c, installCleanup, paint, setTitle, size, toolLines } from './ui.mjs';

const SPIN_MS = 150;

/**
 * The clock, in the taskbar.
 *
 * Minimise the window and the frame we spent all this effort painting is gone — but the
 * title is still there, and it is the only thing left that can tell you how long is left.
 * So it says exactly that. (setTitle is a no-op without a TTY.)
 */
const countdownTitle = (job, next) => setTitle(`⏳ ${hhmmss(next - nowMs())} → ${jobPreview(job, 40)}`);

/** Arrow keys, `i`, `d`, Ctrl+C — the live view is something you read, not just watch. */
function attachKeys(view, redraw, quit) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  const onData = (data) => {
    const s = String(data);
    if (s === '\x03') { quit(); return; }
    if (s === '\x1b[A') view.info ? view.infoScroll += 1 : view.scroll += 1;
    else if (s === '\x1b[B') view.info ? view.infoScroll = Math.max(0, view.infoScroll - 1) : view.scroll = Math.max(0, view.scroll - 1);
    else if (s === '\x1b[5~') view.scroll += 10;                // page up
    else if (s === '\x1b[6~') view.scroll = Math.max(0, view.scroll - 10);
    else if (s === '\x1b[F' || s === 'g') view.scroll = 0;      // end: follow the tail again
    else if (s === 'i') { view.info = !view.info; view.infoScroll = 0; }
    else if (s === 'd') view.showDiff = !view.showDiff;
    else if (s === '\x1b[D') view.horizontal?.(-1);
    else if (s === '\x1b[C') view.horizontal?.(1);
    else if ((s === '\r' || s === '\n' || s === 'q' || s === '\x1b') && view.finish) view.finish();
    else return;
    redraw();
  };

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on('data', onData);
  return () => {
    stdin.removeListener('data', onData);
    try { stdin.setRawMode?.(false); } catch { /* already closed */ }
    stdin.pause();
  };
}

/** Count down to the quota coming back. Same job, same place in the queue, no input needed. */
async function waitForQuota(until, kind, job, view, setRepaint) {
  const start = nowMs();
  const paused = { ...job };
  const label = kind === 'weekly' ? 'cupo semanal' : 'cupo de sesión';
  const draw = () => paint(quotaWaitFrame(paused, until, pendingJobs(), start, view, kind));
  setRepaint(draw);
  while (nowMs() < until) {
    draw();
    setTitle(`⏸ ${label} · ${hhmmss(until - nowMs())}`);
    await sleep(1000);
  }
}

export async function runTUI({ once, watch = false }) {
  const view = { scroll: 0, info: false, infoScroll: 0, showDiff: false };
  const startedAt = nowMs();
  const summary = { completed: 0, errors: 0, elapsed: '0s' };
  let repaint = () => {};
  let restore = () => {};
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    restore();
    // Exit after the farewell write has reached Windows Terminal/conhost.
    setTimeout(() => process.exit(130), 50);
  };

  // Ctrl+C lands here too: the terminal goes back to normal AND we say goodbye, instead
  // of dumping you back onto the wreckage of a half-painted full-screen frame.
  const detachKeys = attachKeys(view, () => repaint(), quit);
  restore = installCleanup(() => { detachKeys(); summary.elapsed = humanDur(nowMs() - startedAt); goodbye(summary); });

  altEnter();
  try {
    for (;;) {
      const pending = pendingJobs();

      // With --watch the runner stays up on an empty queue instead of exiting: leave it
      // running and anything added later — from another terminal, from the agent — gets
      // picked up on its own. That is the point: queue the work, walk away.
      if (!pending.length) {
        if (!watch || once) break;
        repaint = () => paint(idleFrame());
        repaint();
        setTitle('kaip · queue empty');
        await sleep(2000);
        continue;
      }

      const { job } = nextUp(pending);

      if (!job) {                                   // only future scheduled jobs left
        if (once) break;
        let next = nextScheduledAt(pending);
        let upcoming = pending.find((j) => j.when === next);
        const waitStart = nowMs();
        repaint = () => paint(clockFrame(upcoming, next, pendingJobs(), waitStart, view));

        while (nowMs() < next) {                    // 1-second countdown tick
          repaint();
          countdownTitle(upcoming, next);           // the clock, where a minimised window shows it
          await sleep(1000);

          // Re-read every tick. A prompt added WHILE we are counting down — possibly for
          // sooner than the one we are waiting on — must not be ignored until this one
          // fires; the whole point of leaving a run up is that you can feed it.
          const fresh = pendingJobs();
          const { job: dueNow } = nextUp(fresh);
          if (dueNow) break;                        // something is runnable right now
          const soonest = nextScheduledAt(fresh);
          if (soonest && soonest < next) {          // someone queued something earlier
            next = soonest;
            upcoming = fresh.find((j) => j.when === soonest);
          }
        }
        continue;
      }

      // --- run it, streaming what Claude does ---
      markRunning(job);
      view.scroll = 0;
      setTitle(`▶ ${jobPreview(job, 40)}`);

      const { cols } = size();
      const behind = () => pendingJobs().filter((j) => j.id !== job.id);
      const lines = [];
      let todos = null;
      let tick = 0;
      repaint = () => paint(runningFrame(job, lines, job.startedAt, tick, { ...view, todos, pending: behind() }));
      repaint();
      const spinner = setInterval(() => { tick++; repaint(); }, SPIN_MS);

      let res, end;
      try {
        ({ res, end } = await launch(job, { onEvent: (e) => {
          const live = classifyLiveEvent(e, cols);
          lines.push(...live.lines);
          if (live.todos !== undefined) todos = live.todos;
          repaint();
        } }));
      } finally {
        clearInterval(spinner);
      }

      await commit(job, end);

      // Out of quota is not a failure: hold the job, wait for the reset, carry on.
      if (end.action === 'requeue') {
        lines.push('', c.warn('⏸ out of quota') + c.muted(` · resumes ${fmt(end.waitUntil)}`));
        repaint();
        await sleep(1500);
        if (once) break;
        await waitForQuota(end.waitUntil, end.kind, job, view, (f) => { repaint = f; });
        continue;                                   // same job, same place in the queue
      }

      lines.push('', res.ok
        ? c.ok('✓ done') + c.muted(` · ${humanDur(nowMs() - job.startedAt)} · out/${job.id}.txt`)
        : c.err('✗ error') + c.muted(` · ${end.reason ?? res.error}`));
      repaint();
      if (res.ok) summary.completed++; else summary.errors++;
      await sleep(1200);                            // let the result be read
    }
    if (!once && (summary.completed || summary.errors)) {
      summary.elapsed = humanDur(nowMs() - startedAt);
      await waitAtCompletion(summary, view, (f) => { repaint = f; });
    }
  } finally {
    restore();          // restores the terminal, detaches the keys, and says goodbye
  }
}

function completionScopes() {
  const all = aggregateUsage();
  const providers = [...new Set(all.sessions.filter((row) => row.engine === 'opencode' && row.provider).map((row) => row.provider))].sort();
  const scopes = [
    { label: 'Claude', engine: 'claude' },
    { label: 'Codex', engine: 'codex' },
    ...providers.map((provider) => ({ label: `OpenCode/${provider}`, engine: 'opencode', provider })),
  ];
  return scopes.map((scope) => ({
    ...scope,
    report: aggregateUsage({ engine: scope.engine, ...(scope.provider ? { provider: scope.provider } : {}) }),
  }));
}

async function waitAtCompletion(summary, view, setRepaint) {
  const scopes = completionScopes();
  let selected = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const draw = () => paint(completionFrame(summary, scopes, selected));
  view.horizontal = (delta) => {
    selected = (selected + delta + scopes.length) % scopes.length;
    draw();
  };
  view.finish = finish;
  setRepaint(draw);
  draw();
  await done;
  view.horizontal = null;
  view.finish = null;
}

/** Keep semantic live state before rendering it; strings alone cannot power toggles or panels. */
export function classifyLiveEvent(event, cols = 80) {
  if (event?.type !== 'assistant') return { lines: eventLines(event, cols) };
  const blocks = event.message?.content ?? [];
  const lines = [];
  let todos;
  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      lines.push(...eventLines({ ...event, message: { ...event.message, content: [block] } }, cols));
      continue;
    }
    const rendered = toolLines(block.name, block.input ?? {}, cols);
    if (block.name === 'TodoWrite') {
      lines.push(rendered[0]);
      todos = Array.isArray(block.input?.todos) ? block.input.todos : [];
    } else if (['Edit', 'MultiEdit', 'Write'].includes(block.name)) {
      lines.push(rendered[0]);
      if (rendered.length > 1) lines.push({ diff: true, lines: rendered.slice(1) });
    } else {
      lines.push(...rendered);
    }
  }
  return { lines, ...(todos !== undefined ? { todos } : {}) };
}
