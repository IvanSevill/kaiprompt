// Everything the runner paints: the quota bars, the job card, the big clock, the live
// feed, the parallel stack. State goes in, lines come out — nothing here touches the
// queue or launches anything, so a frame can always be rendered without consequences.

import path from 'node:path';

import { nowMs } from './store.mjs';
import { fmtTime, hhmmss, humanDur } from './time.mjs';
import { readUsage } from './quota.mjs';
import { isLinked, jobPreview, resolvePrompt } from './prompt.mjs';
import { runnerStatus } from './runner-status.mjs';

import {
  bar, bigText, bigWidth, box, c, centerBlock, centerLine, fit, size, SPINNER, toolLines,
  trunc, width, wrap,
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
export function quotaLines(cols, job = null) {
  if (job?.adapter && job.adapter !== 'claude') {
    return [c.muted(`quota: ${job.adapter} is checked when this job launches`)];
  }
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

const compactUsage = (value) => {
  if (!value) return '?';
  const n = value.value;
  const shown = n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  return `${value.partial ? '~' : ''}${shown}`;
};

/** The screen left after a foreground run: useful totals, not a disappearing last frame. */
function completionTabs(scopes, selected, maxWidth) {
  const labels = scopes.map((item, index) => index === selected ? c.accent(`[${item.label}]`) : c.muted(` ${item.label} `));
  if (!labels.length) return '';
  let start = selected;
  let end = selected;
  let line = labels[selected];
  while (start > 0 || end < labels.length - 1) {
    let expanded = false;
    if (start > 0) {
      const candidate = `${labels[start - 1]}  ${line}`;
      if (width(candidate) <= maxWidth) { line = candidate; start--; expanded = true; }
    }
    if (end < labels.length - 1) {
      const candidate = `${line}  ${labels[end + 1]}`;
      if (width(candidate) <= maxWidth) { line = candidate; end++; expanded = true; }
    }
    if (!expanded) break;
  }
  return fit(line, maxWidth);
}

export function completionFrame(summary, scopes, selectedScope = 0) {
  const { cols, rows } = size();
  const scope = scopes[selectedScope] ?? scopes[0];
  const tabs = completionTabs(scopes, selectedScope, Math.max(1, cols - 2));
  const totals = scope?.report?.totals ?? {};
  const cost = totals.cost?.value > 0 ? `  ·  $${totals.cost.value.toFixed(4)}` : '';
  const body = [
    '', c.ok('  ✓ run complete'),
    c.muted(`  ${summary.completed ?? 0} completed · ${summary.errors ?? 0} errors · ${summary.elapsed ?? '0s'}`),
    '', '  ' + tabs, '',
    c.bold(`  ${compactUsage(totals.total)} tokens`) + c.muted(`  ·  ${compactUsage(totals.input)} in  ·  ${compactUsage(totals.output)} out${cost}`),
  ];
  if (scope?.engine === 'claude') body.push('', ...quotaLines(cols).map((line) => '  ' + line));
  body.push('', c.muted('  ←/→ engine · Enter/q close'));
  return [...body, ...Array(Math.max(0, rows - body.length)).fill('')];
}

const CARD_MAX_LINES = 20;                // what fits on the card before we start counting

function jobCard(job, title, cols, { expanded = false } = {}) {
  const w = Math.min(cols - 8, 76);
  const meta = [
    job.target ? c.muted('target ') + job.target : null,
    job.dir ? c.muted('folder ') + path.basename(String(job.dir).replace(/[\\/]+$/, '')) : null,
    c.muted('engine ') + `${job.adapter || 'claude'}${job.provider ? '/' + job.provider : ''}${job.model ? '/' + job.model : ''}`,
    c.muted('perm ') + (job.permMode || 'bypass'),
  ].filter(Boolean).join(c.muted(' · '));

  // A --from job keeps the PATH, not the text: its `job.prompt` is null. Reading it the
  // same way the launch does (resolvePrompt) is the only way this card can show what will
  // actually be sent — reading job.prompt painted an empty card, expanded or not.
  //
  // resolvePrompt THROWS when the file is gone or empty, and that is deliberate (an
  // unattended launch must never get a blank prompt). But this is a frame: it only paints.
  // Blowing up here would take the runner down mid-launch, so the warning gets painted.
  let text = null;
  let broken = null;
  try { text = resolvePrompt(job); }
  catch (e) { broken = e.message.split('\n')[0]; }

  const from = isLinked(job) ? [c.muted('↪ ' + path.basename(job.promptFile))] : [];

  let body;
  let hint;
  if (broken) {
    body = [c.err('⚠ ' + trunc(broken, w - 4))];
    hint = c.muted(expanded ? '(i: collapse)' : '(i: full prompt)');
  } else if (expanded) {
    const lines = wrap(text, w - 2);
    body = lines.slice(0, CARD_MAX_LINES);
    // Say what is being held back. Cutting the prompt off in silence at line 20 is how you
    // end up sure you asked for something you never actually asked for.
    if (lines.length > CARD_MAX_LINES) {
      body.push(c.muted(`… +${lines.length - CARD_MAX_LINES} lines`));
    }
    hint = c.muted('(i: collapse)');
  } else {
    body = [trunc(text, w - 2)];
    // Folded, the card has to advertise that there IS something behind "i" — otherwise the
    // key looks dead, which is exactly how the bug that killed it went unnoticed.
    const n = text.split('\n').length;
    hint = c.muted(`(i: full prompt · ${n} line${n === 1 ? '' : 's'})`);
  }

  return box([...from, ...body, meta + '  ' + hint], { title, cols: w });
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

  // The one thing worth saying while idle: WILL anything still fire, and does it survive
  // this window closing? Ask runner-status, like everyone else — asking the daemon directly
  // is how this screen used to answer a different question than the goodbye screen right
  // next to it.
  const r = runnerStatus();
  const guard = r.durable
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
      c.accent('  kaip add "…" --at +10m') + c.muted('   · from another terminal, or ask the agent'),
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

  const clockText = hhmmss(remaining);
  const clock = bigText(clockText);
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - bigWidth(clockText)) / 2)));
  const waiting = pending.filter((j) => j.id !== job.id);

  const body = [
    ...centerBlock(quotaLines(cols, job), cols),
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
export function quotaWaitFrame(job, until, pending, startedAt, view = {}, kind = null) {
  const { cols } = size();
  const frame = clockFrame(job, until, pending, startedAt, view);
  const label = kind === 'weekly' ? 'cupo semanal' : 'cupo de sesión';
  return [c.warn(fit(`  ⏸ esperando ${label} agotado · reanudando automáticamente, mismo orden`, cols)), ...frame.slice(1)];
}

/**
 * The live view. `scroll` is how many lines back from the bottom we are looking: 0 is
 * the tail, which keeps following the launch, and anything else pins the view so you
 * can read back through what it did without the feed yanking you around.
 */
export function runningFrame(job, lines, startedAt, tick, { scroll = 0, expanded = false, info = false, infoScroll = 0, showDiff = false, pending = [] } = {}) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);

  const infoLines = jobInfoLines(job, cols);
  const infoRoom = Math.max(3, rows - 8);
  const maxInfoScroll = Math.max(0, infoLines.length - infoRoom);
  const shownInfo = infoLines.slice(Math.min(infoScroll, maxInfoScroll), Math.min(infoScroll, maxInfoScroll) + infoRoom);
  const head = info
    ? [...quotaLines(cols, job).map((l) => '  ' + l), '', ...shownInfo, c.muted(`${Math.min(infoScroll, maxInfoScroll) + 1}/${infoLines.length} lines · ↑↓ scroll · i close`)]
    : [...quotaLines(cols, job).map((l) => '  ' + l), '', ...jobCard(job, `running · ${job.id}`, cols, { expanded })];
  const foot = pendingPanel(pending, cols, 3);

  const room = Math.max(3, rows - head.length - foot.length - 4);
  const visibleLines = lines.flatMap((line) => typeof line === 'string' ? [line] : (showDiff ? line.lines : []));
  const maxScroll = Math.max(0, visibleLines.length - room);
  const at = Math.min(scroll, maxScroll);
  const end = visibleLines.length - at;
  const feed = visibleLines.slice(Math.max(0, end - room), end);

  const status = at > 0
    ? c.warn(`↑${at} scrolled back`) + c.muted(' · ↓/end: follow again')
    : c.muted(`${spin} ${humanDur(nowMs() - startedAt)} elapsed`);

  return [
    ...head, '',
    ...feed,
    ...Array(Math.max(0, room - feed.length)).fill(''),
    status + c.muted(`  ·  ↑↓: scroll · i: job info · d: toggle diff (${showDiff ? 'on' : 'off'}) · Ctrl+C: stop`),
    '',
    ...foot,
  ].map((l) => fit(l, cols));
}

function jobInfoLines(job, cols) {
  let prompt;
  try { prompt = resolvePrompt(job); } catch (e) { prompt = `ERROR: ${e.message.split('\n')[0]}`; }
  return [
    `id: ${job.id}`, `status: ${job.status}`, `target: ${job.target ?? '—'}`, `dir: ${job.dir ?? '—'}`,
    `engine: ${job.adapter ?? 'claude'}${job.provider ? '/' + job.provider : ''}${job.model ? '/' + job.model : ''}`,
    `sessionId: ${job.sessionId ?? '—'}`, `created: ${job.createdAt ? fmtTime(job.createdAt) : '—'}`,
    `started: ${job.startedAt ? fmtTime(job.startedAt) : '—'}`, `finished: ${job.finishedAt ? fmtTime(job.finishedAt) : '—'}`,
    `pausedUntil: ${job.pausedUntil ? fmtTime(job.pausedUntil) : '—'}`, job.error ? `error: ${job.error}` : null,
    '', 'prompt:', ...wrap(prompt, Math.max(20, cols - 6)),
  ].filter((line) => line !== null);
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
