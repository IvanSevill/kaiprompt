// The runner: processes the queue, shows a full-screen countdown while waiting
// and a live view of what Claude is doing while a launch runs.
//
// Non-TTY (Task Scheduler, background, piped output) → plain log, no TUI.
// That path must never break: the unattended 3am batch depends on it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ADAPTERS, DATA, HOME, alive, importProgramados, loadQueue, loadSessions, nowMs,
  outPath, patchJob, preview, saveQueue, saveSessions,
} from './store.mjs';
import { fmt, fmtTime, hhmmss, humanDur } from './time.mjs';
import { planRetry, quotaVerdict, sessionQuota } from './quota.mjs';

import {
  altEnter, bar, bigText, bigWidth, box, c, centerLine, fit, installCleanup,
  isTTY, paint, size, SPINNER, toolLines, trunc, wrap,
} from './ui.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- single-runner lock ------------------------------------------------------
// Two runners racing on the same queue would execute a job twice (both read it as
// "pending" before either marks it "running"). The lock makes it safe to have a
// background runner AND a scheduled task as a fallback: the second one just exits.
const LOCK = path.join(DATA, 'runner.lock');
const LOCK_STALE_MS = 120_000;          // heartbeat older than this ⇒ the runner died

export function lockIsHeld() {
  try {
    const { at } = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    return Date.now() - at < LOCK_STALE_MS;
  } catch { return false; }
}

function acquireLock() {
  if (lockIsHeld()) return null;
  const beat = () => {
    try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })); }
    catch { /* best effort */ }
  };
  beat();
  const timer = setInterval(beat, 30_000);
  timer.unref?.();
  return () => { clearInterval(timer); try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } };
}

async function loadAdapter(name) {
  const p = path.join(ADAPTERS, `${name || 'claude'}.mjs`);
  if (!fs.existsSync(p)) throw new Error(`unknown adapter: "${name}" (check the adapters/ folder)`);
  return import(pathToFileURL(p).href);
}

/**
 * Pick what runs next: due scheduled jobs first (earliest), then sequential ones.
 *
 * `scheduledOnly` is what keeps the background daemon honest. A sequential job (no
 * time) means "run it on my next manual run" — if the daemon took those too, adding
 * a job would fire it seconds later, which is exactly the surprise we're avoiding.
 */
function nextUp(pending, t = nowMs(), { scheduledOnly = false } = {}) {
  const due = pending.filter((j) => j.when && j.when <= t).sort((a, b) => a.when - b.when);
  const seq = scheduledOnly ? [] : pending.filter((j) => !j.when);
  return { job: due[0] || seq[0], due, seq };
}

// How late a launch can be and still go. Inside the window, being late is normal and
// catching up is the whole point: the daemon was off at 03:00, you turn the machine on
// at 09:00, the job runs. Past it, "overdue" stops meaning "run me now" — a job from
// last week must not wake up and fire the moment a runner appears. That resurrection is
// the same surprise as launching on the spot, just delayed.
export const GRACE_MS = 12 * 60 * 60 * 1000;

/** Jobs so overdue that firing them would be a surprise, not a catch-up. */
export function reapMissed(graceMs = GRACE_MS, t = nowMs()) {
  const q = loadQueue();
  let n = 0;
  for (const j of q) {
    if (j.status !== 'pending' || !j.when || j.when > t - graceMs) continue;
    j.status = 'missed';
    j.finishedAt = t;
    j.error = `missed: its time (${fmt(j.when)}) passed more than ${humanDur(graceMs)} ago; `
      + 'nothing was running then. Reschedule it with "edit" if you still want it';
    n++;
  }
  if (n) saveQueue(q);
  return n;
}

/**
 * A job left `running` by a runner that died (killed daemon, closed terminal, reboot)
 * would sit there forever and block nothing — but it lies in `list` and its output is
 * never written. On every start we close those out as errors.
 */
export function reapStale() {
  const q = loadQueue();
  let n = 0;
  for (const j of q) {
    if (j.status !== 'running') continue;
    // No pid at all means nobody can ever vouch for it: either it predates runnerPid, or
    // it was killed before the field was written. Left alone it sits at `running`
    // forever — which is exactly what happened to the launch that got cancelled.
    if (j.runnerPid && alive(j.runnerPid)) continue;
    j.status = 'error';
    j.finishedAt = nowMs();
    j.error = 'interrupted: the runner died while this was running';
    n++;
  }
  if (n) saveQueue(q);
  return n;
}

/** Run one job through its adapter, persist the output, the status and the session. */
export async function executeJob(job, { dryRun = false, onEvent } = {}) {
  const sessions = loadSessions();
  const key = job.target;
  const sid = job.sessionId || (key && sessions[key]?.sessionId) || null;
  const adapter = await loadAdapter(job.adapter);

  const res = await adapter.run({
    prompt: job.prompt, sessionId: sid, dryRun, dir: job.dir || null,
    permMode: job.permMode || null, onEvent,
  });

  const file = outPath(job.id);
  fs.writeFileSync(file, (res.output ?? '') + (res.error ? `\n\n[ERROR] ${res.error}` : '') + '\n');
  job.status = res.ok ? 'done' : 'error';
  job.finishedAt = nowMs();
  job.output = path.relative(HOME, file).replace(/\\/g, '/');   // "out/<id>.txt", wherever HOME is
  if (res.sessionId) {
    job.sessionId = res.sessionId;
    if (key) {
      sessions[key] = { sessionId: res.sessionId, adapter: job.adapter, updatedAt: nowMs() };
      saveSessions(sessions);
    }
  }
  return res;
}

// --- how a launch ended ------------------------------------------------------
/**
 * A launch came back empty-handed. Was it broken — or just cut off because the quota
 * ran out? That third case is what lost the overnight batch: Claude prints "you've hit
 * your session limit" and exits 1, which to anything watching the exit code looks
 * exactly like a crash. So we tell them apart and put the job BACK in the queue.
 */
export function settle(job, res) {
  if (res.ok) return { action: 'done' };

  const plan = planRetry(job, quotaVerdict(`${res.output ?? ''}\n${res.error ?? ''}`));
  if (plan.action !== 'requeue') return { action: 'fail', reason: plan.reason ?? res.error };
  return { action: 'requeue', waitUntil: plan.waitUntil, quotaRetries: plan.quotaRetries };
}

/**
 * Put a quota-killed job back exactly where it was.
 *
 * `when` is deliberately left ALONE: it is what preserves the order. The job keeps the
 * time it was scheduled for, so when the quota comes back it is still the earliest job
 * due and goes first, and everything behind it stays behind it.
 */
export function requeue(job, plan) {
  job.status = 'pending';
  job.startedAt = null;
  job.finishedAt = null;
  job.quotaRetries = plan.quotaRetries;
  job.pausedUntil = plan.waitUntil;
  job.error = `out of quota; back in the queue, resumes ${fmt(plan.waitUntil)}`;
  patchJob(job);
  return job;
}

// --- live event → display lines ----------------------------------------------
function eventLines(evt, cols) {
  const out = [];
  if (evt.type === 'system' && evt.subtype === 'init') {
    return [c.muted(`  session ${String(evt.session_id || '').slice(0, 8)}…`)];
  }
  if (evt.type !== 'assistant') return out;
  const blocks = evt.message?.content;
  if (!Array.isArray(blocks)) return out;

  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) {
      // Wrap, don't truncate: the answer is the point, and cutting it at one line was
      // hiding most of what the launch actually said.
      const [first, ...more] = wrap(b.text.trim(), cols - 4);
      out.push(c.accent('⏺') + ' ' + first, ...more.map((l) => '  ' + l));
    } else if (b.type === 'tool_use') {
      out.push(...toolLines(b.name, b.input, cols - 2));   // TodoWrite + Edit expand here
    }
  }
  return out;
}

// --- frames ------------------------------------------------------------------
/** The 5-hour window, as a bar: the one that can cut this launch off mid-flight. */
function quotaBar(cols) {
  const q = sessionQuota();
  if (!q || q.freePct === null) return c.muted('  session quota: unknown (no reading yet)');

  const colour = q.freePct > 40 ? c.ok : (q.freePct > 15 ? c.warn : c.err);
  const when = q.renewed
    ? c.ok('renewed')
    : c.muted(`resets ${fmtTime(q.resetsAt)} (in ${humanDur(Math.max(0, q.resetsAt - nowMs()))})`);

  return fit('  ' + c.muted('session ') + bar(q.freePct, Math.min(24, cols - 40), colour)
    + c.muted(' free · ') + when, cols);
}

function jobCard(job, title, cols, { expanded = false } = {}) {
  const w = Math.min(cols - 8, 76);
  const meta = [
    job.target ? c.muted('target ') + job.target : null,
    job.dir ? c.muted('folder ') + path.basename(String(job.dir).replace(/[\\/]+$/, '')) : null,
    c.muted('perm ') + (job.permMode || 'bypass'),
  ].filter(Boolean).join(c.muted(' · '));

  // One line by default — but the whole prompt is right there behind "i". Without it
  // you cannot see what you actually asked for once a launch is under way.
  const body = expanded
    ? wrap(job.prompt, w - 2).slice(0, 20)
    : [trunc(job.prompt, w - 2)];
  const hint = c.muted(expanded ? '(i: collapse)' : '(i: full prompt)');

  return box([...body, meta + '  ' + hint], { title, cols: w });
}

/** --watch, queue empty: parked, listening. Not finished — waiting to be fed. */
function idleFrame() {
  const { cols, rows } = size();
  const body = [
    quotaBar(cols),
    '',
    ...box([
      c.bold('waiting for work'),
      '',
      c.muted('the queue is empty and this runner is staying up.'),
      c.muted('anything added from now on runs on its own:'),
      '',
      c.accent('  promptheus add "…" --at +10m') + c.muted('   from another terminal'),
      c.accent('  /programar +10m | …') + c.muted('              from a Claude chat (0 tokens)'),
    ], { title: 'idle', cols: Math.min(cols - 8, 64) }).map((l) => centerLine(l, cols)),
    '',
    centerLine(c.muted('Ctrl+C to stop'), cols),
  ];
  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  return [...Array(top).fill(''), ...body].map((l) => fit(l, cols));
}

/** What is still waiting behind this one — asked for, and genuinely reassuring to see. */
function pendingPanel(pending, cols, max = 5) {
  if (!pending.length) return [c.muted('  queue: empty — this is the last one')];
  const rows = pending.slice(0, max).map((j) => c.muted(
    `  ${j.when ? '@ ' + fmtTime(j.when) : '  seq  '}  ${j.id}  ${preview(j.prompt, cols - 34)}`
  ));
  if (pending.length > max) rows.push(c.muted(`  … +${pending.length - max} more`));
  return [c.muted(`  ── queue · ${pending.length} waiting ──`), ...rows];
}

function clockFrame(job, next, pending, startedAt, view = {}) {
  const { cols, rows } = size();
  const remaining = Math.max(0, next - nowMs());
  const total = Math.max(1, next - startedAt);
  const pct = ((total - remaining) / total) * 100;

  const clock = bigText(hhmmss(remaining));
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - bigWidth(hhmmss(remaining))) / 2)));
  const waiting = pending.filter((j) => j.id !== job.id);

  const body = [
    quotaBar(cols),
    '',
    ...jobCard(job, 'next launch', cols, view).map((l) => centerLine(l, cols)),
    '',
    ...clock.map((l) => pad + l),
    '',
    centerLine(bar(pct, Math.min(40, cols - 20)), cols),
    '',
    centerLine(c.muted(`starts at ${fmtTime(next)}`), cols),
    '',
    ...pendingPanel(waiting, cols, 3),
    '',
    centerLine(c.muted('i: full prompt · Ctrl+C: stop'), cols),
  ];

  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  return [...Array(top).fill(''), ...body].map((l) => fit(l, cols));
}

/**
 * The live view. `scroll` is how many lines back from the bottom we are looking: 0 is
 * the tail, which keeps following the launch, and anything else pins the view so you
 * can read back through what it did without the feed yanking you around.
 */
function runningFrame(job, lines, startedAt, tick, { scroll = 0, expanded = false, pending = [] } = {}) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);

  const head = [quotaBar(cols), '', ...jobCard(job, `running · ${job.id}`, cols, { expanded })];
  const foot = pendingPanel(pending, cols, 3);

  const room = Math.max(3, rows - head.length - foot.length - 4);
  const maxScroll = Math.max(0, lines.length - room);
  const at = Math.min(scroll, maxScroll);
  const end = lines.length - at;
  const feed = lines.slice(Math.max(0, end - room), end);

  const status = at > 0
    ? c.warn(`↑${at} scrolled back`) + c.muted(' · ↓/end: follow again')
    : c.muted(`${spin} ${humanDur(nowMs() - startedAt)} elapsed`);

  return [
    ...head, '',
    ...feed,
    ...Array(Math.max(0, room - feed.length)).fill(''),
    status + c.muted('  ·  ↑↓: scroll · i: full prompt · Ctrl+C: stop'),
    '',
    ...foot,
  ].map((l) => fit(l, cols));
}

// --- plain (non-TTY) ---------------------------------------------------------
/**
 * The unattended path: Task Scheduler, a pipe, and the background daemon.
 *
 *   loop:false  drain what's runnable and exit (the old behaviour)
 *   loop:true   never exit — this is the daemon: sleep, re-read the queue (jobs
 *               scheduled from the chat land there while we sleep) and fire on time
 */
async function runPlain({ once, scheduledOnly = false, loop = false, watch = false, pollMs = 15_000 }) {
  loop = loop || watch;                             // --watch is "stay up and keep listening"
  const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
  if (loop) log(`daemon up (pid ${process.pid}) · ${scheduledOnly ? 'scheduled jobs only' : 'scheduled + sequential'}`);

  for (;;) {
    importProgramados();                    // /programar wrote to the inbox while we slept
    const missed = reapMissed();            // and time passed: some of it may be too old now
    if (missed) log(`${missed} launch(es) too overdue to fire; marked as missed`);

    const pending = loadQueue().filter((j) => j.status === 'pending');
    const { job } = nextUp(pending, nowMs(), { scheduledOnly });

    if (!job) {
      const times = pending.filter((j) => j.when).map((j) => j.when);
      const next = times.length ? Math.min(...times) : null;

      if (once) {
        if (pending.length) log(`${pending.length} pending (next: ${fmt(next)}); --once won't wait.`);
        else log('empty queue; nothing pending.');
        return;
      }
      if (!loop) {
        if (!next) { log('empty queue; nothing pending.'); return; }
        log(`waiting for the next scheduled launch: ${fmt(next)}`);
      }
      // Sleep until the next launch, but wake up regularly anyway: a new job may have
      // been scheduled for *sooner* than the one we're waiting on.
      const wait = next ? Math.max(1000, Math.min(next - nowMs(), pollMs)) : pollMs;
      await sleep(wait);
      continue;
    }

    job.status = 'running'; job.startedAt = nowMs(); job.runnerPid = process.pid;
    patchJob(job);
    log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}] ${preview(job.prompt)}`);

    let res;
    try { res = await executeJob(job); }
    catch (e) { job.status = 'error'; job.finishedAt = nowMs(); res = { ok: false, error: e.message }; }

    // Out of quota is an interruption, not a failure: put the job back where it was and
    // sleep until the reset. This is the whole reason the overnight batch lost its last
    // phase — it was marked `error` and nothing ever picked it up again.
    const end = settle(job, res);
    if (end.action === 'requeue') {
      requeue(job, end);
      log(`  ⏸ out of quota; ${job.id} back in the queue, resuming ${fmt(end.waitUntil)}`);
      if (once) return;
      await sleep(Math.max(1000, end.waitUntil - nowMs()));
      continue;                                   // same job, same place in the queue
    }

    patchJob(job);
    log(res.ok
      ? `  ✓ done → ${job.output}${job.sessionId ? '  (session ' + String(job.sessionId).slice(0, 8) + '…)' : ''}`
      : `  ✗ error: ${end.reason ?? res.error}`);
  }
}

// --- TUI ---------------------------------------------------------------------
/** Arrow keys, `i`, Ctrl+C — the live view is something you read, not just watch. */
function attachKeys(view, redraw) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  const onData = (data) => {
    const s = String(data);
    if (s === '\x03') { process.kill(process.pid, 'SIGINT'); return; }
    if (s === '\x1b[A') view.scroll += 1;                       // up: back through the feed
    else if (s === '\x1b[B') view.scroll = Math.max(0, view.scroll - 1);
    else if (s === '\x1b[5~') view.scroll += 10;                // page up
    else if (s === '\x1b[6~') view.scroll = Math.max(0, view.scroll - 10);
    else if (s === '\x1b[F' || s === 'g') view.scroll = 0;      // end: follow the tail again
    else if (s === 'i') view.expanded = !view.expanded;
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

/** Everything still waiting, read fresh off disk — not a snapshot. */
const pendingNow = () => loadQueue().filter((j) => j.status === 'pending');

async function runTUI({ once, watch = false }) {
  const restore = installCleanup();
  const view = { scroll: 0, expanded: false };
  let repaint = () => {};
  const detachKeys = attachKeys(view, () => repaint());

  altEnter();
  try {
    for (;;) {
      importProgramados();
      const pending = pendingNow();

      // With --watch the runner stays up on an empty queue instead of exiting: leave it
      // running and anything added later — from another terminal, from /programar — gets
      // picked up on its own. That is the point: queue the work, walk away.
      if (!pending.length) {
        if (!watch || once) break;
        repaint = () => paint(idleFrame(view));
        repaint();
        await sleep(2000);
        continue;
      }

      const { job } = nextUp(pending);

      if (!job) {                                   // only future scheduled jobs left
        if (once) break;
        let next = Math.min(...pending.map((j) => j.when));
        let upcoming = pending.find((j) => j.when === next);
        const waitStart = nowMs();
        repaint = () => paint(clockFrame(upcoming, next, pendingNow(), waitStart, view));

        while (nowMs() < next) {                    // 1-second countdown tick
          repaint();
          await sleep(1000);

          // Re-read every tick. A prompt added WHILE we are counting down — possibly for
          // sooner than the one we are waiting on — must not be ignored until this one
          // fires; the whole point of leaving a run up is that you can feed it.
          const fresh = pendingNow();
          const { job: dueNow } = nextUp(fresh);
          if (dueNow) break;                        // something is runnable right now
          const soonest = Math.min(...fresh.map((j) => j.when));
          if (soonest < next) {                     // someone queued something earlier
            next = soonest;
            upcoming = fresh.find((j) => j.when === soonest);
          }
        }
        continue;
      }

      // --- run it, streaming what Claude does ---
      job.status = 'running'; job.startedAt = nowMs(); job.runnerPid = process.pid;
      patchJob(job);
      view.scroll = 0;

      const { cols } = size();
      const behind = () => pendingNow().filter((j) => j.id !== job.id);
      const lines = [];
      let tick = 0;
      repaint = () => paint(runningFrame(job, lines, job.startedAt, tick, { ...view, pending: behind() }));
      repaint();
      const spinner = setInterval(() => { tick++; repaint(); }, 150);

      let res;
      try {
        res = await executeJob(job, { onEvent: (e) => { lines.push(...eventLines(e, cols)); } });
      } catch (e) {
        job.status = 'error'; job.finishedAt = nowMs();
        res = { ok: false, error: e.message };
      } finally {
        clearInterval(spinner);
      }

      // Out of quota is not a failure: hold the job, wait for the reset, carry on.
      const end = settle(job, res);
      if (end.action === 'requeue') {
        requeue(job, end);
        lines.push('', c.warn('⏸ out of quota') + c.muted(` · resumes ${fmt(end.waitUntil)}`));
        repaint();
        await sleep(1500);
        if (once) break;
        await waitForQuota(end.waitUntil, job, view, (f) => { repaint = f; });
        continue;                                   // same job, same place in the queue
      }

      patchJob(job);
      lines.push('', res.ok
        ? c.ok('✓ done') + c.muted(` · ${humanDur(nowMs() - job.startedAt)} · out/${job.id}.txt`)
        : c.err('✗ error') + c.muted(` · ${end.reason ?? res.error}`));
      repaint();
      await sleep(1200);                            // let the result be read
    }
  } finally {
    detachKeys();
    restore();
  }

  // Back on the normal screen: leave a short summary behind.
  const left = loadQueue().filter((j) => j.status === 'pending');
  if (!left.length) console.log('empty queue; nothing pending.');
  else {
    const times = left.filter((j) => j.when).map((j) => j.when);
    console.log(`${left.length} remaining${times.length ? ` (next: ${fmt(Math.min(...times))})` : ''}.`);
  }
}

/** The big clock again, but counting down to the quota coming back. */
async function waitForQuota(until, job, view, setRepaint) {
  const start = nowMs();
  const paused = { ...job, prompt: job.prompt };
  const draw = () => {
    const { cols } = size();
    const frame = clockFrame(paused, until, loadQueue().filter((j) => j.status === 'pending'), start, view);
    paint([c.warn(fit('  ⏸ out of quota — resuming automatically, same order', cols)), ...frame.slice(1)]);
  };
  setRepaint(draw);
  while (nowMs() < until) { draw(); await sleep(1000); }
}

// --- parallel ----------------------------------------------------------------
/**
 * Which jobs may NOT overlap. Two jobs on the same target share one conversation, and
 * resuming a session twice at once corrupts it — so a target is a lane, and a lane runs
 * one job at a time. Jobs with no target can't collide with anything, so each is its own
 * lane and they all go at once.
 *
 * That is the whole answer to "why should a prompt for one chat wait for another chat's".
 */
export const laneOf = (job) => job.target || `job:${job.id}`;

/** The jobs we can start right now: runnable, and not on a lane that is already busy. */
export function startable(pending, busyLanes, room, t = nowMs()) {
  const runnable = [
    ...pending.filter((j) => j.when && j.when <= t).sort((a, b) => a.when - b.when),
    ...pending.filter((j) => !j.when),
  ];
  const out = [];
  const taken = new Set(busyLanes);
  for (const j of runnable) {
    if (out.length >= room) break;
    const lane = laneOf(j);
    if (taken.has(lane)) continue;                  // its conversation is already busy
    taken.add(lane);
    out.push(j);
  }
  return out;
}

/** One compact block per running job — the frame when several are in flight at once. */
function multiFrame(actives, pending, tick) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);
  const head = [quotaBar(cols), '', c.bold(`  ${spin} ${actives.length} launches running in parallel`), ''];
  const foot = pendingPanel(pending, cols, 3);

  const room = Math.max(2, Math.floor((rows - head.length - foot.length - 4) / actives.length) - 3);
  const body = [];
  for (const a of actives) {
    body.push(c.accent(`  ▶ ${a.job.id}`) + c.muted(`  ${a.job.target ? '[' + a.job.target + '] ' : ''}`)
      + c.muted(preview(a.job.prompt, cols - 30)));
    body.push(...a.lines.slice(-room).map((l) => '  ' + l));
    body.push('');
  }

  return [...head, ...body, ...Array(Math.max(0, rows - head.length - body.length - foot.length - 2)).fill(''),
    ...foot].map((l) => fit(l, cols));
}

/**
 * Run several launches at once, one per lane. Used when --parallel > 1.
 * Works with or without a terminal: with one it paints the stacked live view, without
 * one it just logs, so the daemon can use it too.
 */
async function runParallel({ once, max, scheduledOnly = false, pollMs = 15_000, tty = isTTY(), watch = false }) {
  const log = (s) => { if (!tty) console.log(`[${new Date().toISOString()}] ${s}`); };
  const restore = tty ? installCleanup() : () => {};
  if (tty) altEnter();

  const actives = [];                               // { job, lines, done }
  let tick = 0;
  const draw = () => { if (tty && actives.length) paint(multiFrame(actives, waiting(), tick)); };
  const waiting = () => loadQueue().filter((j) => j.status === 'pending'
    && !actives.some((a) => a.job.id === j.id));

  const spinner = tty ? setInterval(() => { tick++; draw(); }, 200) : null;

  const launch = (job) => {
    job.status = 'running'; job.startedAt = nowMs(); job.runnerPid = process.pid;
    patchJob(job);
    log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}] ${preview(job.prompt)}`);

    const entry = { job, lines: [] };
    const { cols } = size();
    entry.done = executeJob(job, { onEvent: (e) => { entry.lines.push(...eventLines(e, cols - 4)); } })
      .catch((e) => ({ ok: false, error: e.message }))
      .then((res) => {
        const end = settle(job, res);
        if (end.action === 'requeue') {
          requeue(job, end);
          log(`  ⏸ ${job.id} out of quota; back in the queue, resumes ${fmt(end.waitUntil)}`);
        } else {
          job.status = res.ok ? 'done' : 'error';
          job.finishedAt = nowMs();
          patchJob(job);
          log(res.ok ? `  ✓ ${job.id} done → ${job.output}` : `  ✗ ${job.id} error: ${end.reason ?? res.error}`);
        }
        actives.splice(actives.indexOf(entry), 1);
        return res;
      });
    actives.push(entry);
  };

  try {
    for (;;) {
      importProgramados();
      reapMissed();

      const pending = loadQueue().filter((j) => j.status === 'pending'
        && !(j.pausedUntil && j.pausedUntil > nowMs())     // waiting for its quota to come back
        && !(scheduledOnly && !j.when));

      const busy = actives.map((a) => laneOf(a.job));
      for (const j of startable(pending, busy, max - actives.length)) launch(j);
      draw();

      if (actives.length) { await Promise.race(actives.map((a) => a.done)); continue; }
      if (once) break;

      const times = loadQueue()
        .filter((j) => j.status === 'pending')
        .map((j) => Math.max(j.when || 0, j.pausedUntil || 0))
        .filter(Boolean);
      if (!times.length) {
        if (!watch) break;                          // nothing running, nothing coming
        await sleep(pollMs);                        // --watch: stay up, wait to be fed
        continue;
      }
      await sleep(Math.max(1000, Math.min(Math.min(...times) - nowMs(), pollMs)));
    }
    await Promise.all(actives.map((a) => a.done));
  } finally {
    if (spinner) clearInterval(spinner);
    restore();
  }
  console.log('queue drained.');
}

// --- dry run ------------------------------------------------------------------
async function dryRunPreview() {
  const pending = loadQueue().filter((j) => j.status === 'pending');
  if (!pending.length) return console.log('(nothing pending)');
  console.log('— dry-run: nothing will actually execute —');
  const t = nowMs();
  const { due, seq } = nextUp(pending, t);
  for (const job of [...due, ...seq]) {
    const sid = job.sessionId || loadSessions()[job.target]?.sessionId || null;
    const adapter = await loadAdapter(job.adapter);
    const res = await adapter.run({
      prompt: job.prompt, sessionId: sid, dryRun: true,
      dir: job.dir || null, permMode: job.permMode || null,
    });
    console.log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}]`);
    console.log('   ' + String(res.output || '').replace(/\n/g, '\n   '));
  }
  const future = pending.filter((j) => j.when && j.when > t);
  if (future.length) {
    console.log(`(+${future.length} scheduled: next ${fmt(Math.min(...future.map((j) => j.when)))})`);
  }
}

/**
 * Process the queue. One runner at a time, enforced by the lock: the daemon and a
 * manual `run` would otherwise both grab the same pending job and launch it twice.
 *
 *   loop           never exit (the daemon). Implies the plain view.
 *   scheduledOnly  only jobs with a time — sequential ones wait for a manual run.
 *   parallel       how many launches may run at once. Never two on the same target:
 *                  they share a conversation and resuming it twice would corrupt it.
 *   plain          force the plain log even on a terminal — for servers and CI, where
 *                  a full-screen TUI is just noise in the logs.
 */
export async function runQueue({
  once = false, dryRun = false, loop = false, scheduledOnly = false,
  pollMs = 15_000, parallel = 1, plain = false, watch = false,
} = {}) {
  const imp = importProgramados();
  if (imp) console.log(`(imported ${imp} from programados.jsonl)`);
  if (dryRun) return dryRunPreview();

  const reaped = reapStale();
  if (reaped) console.log(`(${reaped} job(s) left running by a dead runner marked as error)`);
  const missed = reapMissed();
  if (missed) console.log(`(${missed} launch(es) too overdue to fire; marked as missed)`);

  const release = acquireLock();
  if (!release) {
    console.log('another runner is already active; nothing to do.');
    return;
  }

  const max = Math.max(1, Number(parallel) || 1);
  const tui = isTTY() && !loop && !plain;

  try {
    if (max > 1) return await runParallel({ once, max, scheduledOnly, pollMs, tty: tui, watch });
    return tui
      ? await runTUI({ once, watch })
      : await runPlain({ once, loop, watch, scheduledOnly, pollMs });
  } finally {
    release();
  }
}
