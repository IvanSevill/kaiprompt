// Everything the runner paints: the quota bars, the job card, the big clock, the live
// feed, the parallel stack. State goes in, lines come out — nothing here touches the
// queue or launches anything, so a frame can always be rendered without consequences.

import path from 'node:path';

import { nowMs } from './store.mjs';
import { fmtTime, hhmmss, humanDur } from './time.mjs';
import { readUsage } from './quota.mjs';
import { jobPreview } from './prompt.mjs';
import { status as daemonStatus } from './daemon.mjs';

import {
  bar, bigText, bigWidth, box, c, centerBlock, centerLine, fit, size, SPINNER, toolLines,
  trunc, wrap,
} from './ui.mjs';

// --- live event → display lines ----------------------------------------------
export function eventLines(evt, cols) {
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

// --- pieces ------------------------------------------------------------------
/**
 * BOTH quota windows, as two aligned bars.
 *
 * The 5-hour one is what usually cuts a launch off mid-flight, but the weekly one can too
 * — and when it does, you are out for days, not hours. Showing only the session bar was
 * hiding the more expensive of the two.
 */
export function quotaLines(cols) {
  const u = readUsage();
  if (!u) return [c.muted('quota: unknown (no reading yet — open a Claude chat once)')];

  const len = Math.max(10, Math.min(22, cols - 46));
  const row = (label, w) => {
    if (!w || w.freePct === null) return c.muted(label.padEnd(8)) + c.muted('—');

    const renewed = w.resetsAt && nowMs() >= w.resetsAt;
    const free = renewed ? 100 : w.freePct;
    const colour = free > 40 ? c.ok : (free > 15 ? c.warn : c.err);
    const when = renewed
      ? c.ok('renewed')
      : c.muted(`resets ${fmtTime(w.resetsAt)}  (in ${humanDur(Math.max(0, w.resetsAt - nowMs()))})`);

    return c.muted(label.padEnd(8)) + bar(free, len, colour) + c.muted(' free  ·  ') + when;
  };

  return [row('session', u.session), row('week', u.weekly)];
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

/** What is still waiting behind this one — asked for, and genuinely reassuring to see. */
export function pendingPanel(pending, cols, max = 5) {
  if (!pending.length) return [c.muted('  queue: empty — this is the last one')];
  const rows = pending.slice(0, max).map((j) => c.muted(
    `  ${j.when ? '@ ' + fmtTime(j.when) : '  seq  '}  ${j.id}  ${jobPreview(j, cols - 34)}`
  ));
  if (pending.length > max) rows.push(c.muted(`  … +${pending.length - max} more`));
  return [c.muted(`  ── queue · ${pending.length} waiting ──`), ...rows];
}

// --- whole frames ------------------------------------------------------------
/** --watch, queue empty: parked, listening. Not finished — waiting to be fed. */
export function idleFrame() {
  const { cols, rows } = size();
  const d = daemonStatus();

  // The one thing worth saying while idle: this window is what keeps the promise. Close
  // it and scheduled work stops going out — unless the daemon is armed, which survives it.
  const guard = d.running
    ? c.ok('◆ daemon on') + c.muted(' — scheduled work goes out even if you close this')
    : c.warn('◇ daemon off') + c.muted(' — close this and nothing fires · ')
      + c.accent('kaip daemon start');

  const w = Math.min(cols - 6, 72);
  const body = [
    ...box([
      c.bold('waiting for work'),
      '',
      c.muted('the queue is empty and this runner is staying up.'),
      c.muted('anything added from now on runs on its own:'),
      '',
      c.accent('  kaip add "…" --at +10m') + c.muted('   · from another terminal'),
      c.accent('  /programar +10m | …') + c.muted('      · from a Claude chat (0 tokens)'),
      '',
      guard,
    ], { title: 'idle', cols: w }),
    '',
    ...quotaLines(cols),
    '',
    c.muted('Ctrl+C to stop'),
  ];

  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  return [...Array(top).fill(''), ...centerBlock(body, cols)];
}

/** The big countdown: what goes next, and how long until it does. */
export function clockFrame(job, next, pending, startedAt, view = {}) {
  const { cols, rows } = size();
  const remaining = Math.max(0, next - nowMs());
  const total = Math.max(1, next - startedAt);
  const pct = ((total - remaining) / total) * 100;

  const clock = bigText(hhmmss(remaining));
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - bigWidth(hhmmss(remaining))) / 2)));
  const waiting = pending.filter((j) => j.id !== job.id);

  const body = [
    ...centerBlock(quotaLines(cols), cols),
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

/** The big clock again, but counting down to the quota coming back. */
export function quotaWaitFrame(job, until, pending, startedAt, view = {}) {
  const { cols } = size();
  const frame = clockFrame(job, until, pending, startedAt, view);
  return [c.warn(fit('  ⏸ out of quota — resuming automatically, same order', cols)), ...frame.slice(1)];
}

/**
 * The live view. `scroll` is how many lines back from the bottom we are looking: 0 is
 * the tail, which keeps following the launch, and anything else pins the view so you
 * can read back through what it did without the feed yanking you around.
 */
export function runningFrame(job, lines, startedAt, tick, { scroll = 0, expanded = false, pending = [] } = {}) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);

  const head = [...quotaLines(cols).map((l) => '  ' + l), '', ...jobCard(job, `running · ${job.id}`, cols, { expanded })];
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

/** One compact block per running job — the frame when several are in flight at once. */
export function multiFrame(actives, pending, tick) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);
  const head = [...quotaLines(cols).map((l) => '  ' + l), '', c.bold(`  ${spin} ${actives.length} launches running in parallel`), ''];
  const foot = pendingPanel(pending, cols, 3);

  const room = Math.max(2, Math.floor((rows - head.length - foot.length - 4) / actives.length) - 3);
  const body = [];
  for (const a of actives) {
    body.push(c.accent(`  ▶ ${a.job.id}`) + c.muted(`  ${a.job.target ? '[' + a.job.target + '] ' : ''}`)
      + c.muted(jobPreview(a.job, cols - 30)));
    body.push(...a.lines.slice(-room).map((l) => '  ' + l));
    body.push('');
  }

  return [...head, ...body, ...Array(Math.max(0, rows - head.length - body.length - foot.length - 2)).fill(''),
    ...foot].map((l) => fit(l, cols));
}
