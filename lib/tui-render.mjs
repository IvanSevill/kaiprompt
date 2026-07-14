// State → the lines to paint. Pure: give it a state and a size, get the frame back.
//
// Nothing here reads the disk, writes to the store or launches anything. That is what makes
// the whole GUI testable with no terminal: the tests build a state, call render, and read
// what a person would have seen.

import { ago, fmt } from './time.mjs';
import { jobDetails } from './queue.mjs';
import { jobPreview } from './prompt.mjs';
import { box, c, fit, size, trunc, wrap } from './ui.mjs';
import { ICON, rows, selected, STEPS, TITLES, VIEWS } from './tui-state.mjs';

function queueRows(state, cols) {
  if (!state.data.queue.length) return [c.muted('  (empty queue — press "a" to add a launch)')];
  return state.data.queue.map((j, i) => {
    // A job that jumps the queue has to LOOK like it does. It sits wherever it was added,
    // but runs before everything above it — and a row that says "seq" while the runner
    // quietly takes it first is the tool lying about its own order.
    const when = j.when ? '@ ' + fmt(j.when) : j.priority ? '↑ first in line' : 'seq';
    const line = `${ICON[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
      + `${when.padEnd(22)} ${j.adapter}${j.target ? '/' + j.target : ''}  ${jobPreview(j, 34)}`;
    return rowLine(line, i === state.sel, cols);
  });
}

function sessionRows(state, cols) {
  const list = rows(state);
  if (!list.length) return [c.muted('  (no sessions yet — a launch with --target creates one)')];
  return list.map((s, i) =>
    rowLine(`${s.target.padEnd(16)} → ${s.sessionId}  ${c.muted(`[${s.adapter}] ${fmt(s.updatedAt)}`)}`,
      i === state.sel, cols));
}

function projectRows(state, cols) {
  const list = rows(state);
  const out = [];
  if (state.data.projects._base) out.push(c.muted('  base  ') + state.data.projects._base, '');
  if (!list.length) out.push(c.muted('  (no aliases — kaip projects <alias> <path>)'));
  out.push(...list.map((p, i) => rowLine(`${p.alias.padEnd(16)} → ${p.path}`, i === state.sel, cols)));
  return out;
}

function rowLine(text, isSel, cols) {
  // fit, not trunc: trunc collapses runs of spaces and would eat the column alignment.
  const body = fit(text, cols - 4);
  return isSel ? c.accent('▸ ') + c.bold(body) : '  ' + body;
}

const HELP_ROWS = [
  ['← → / tab / 1-4', 'switch view'],
  ['enter', 'detail of the selected job'],
  ['a', 'add a launch (guided). Queues it — nothing is sent now'],
  ['e', 'edit a pending job'],
  ['D', 'daemon on/off — the one that fires scheduled launches by itself'],
  ['r', 'run the queue NOW (countdown + live view). Not needed for scheduled jobs'],
  ['R', 'restart the interface (redraw from scratch if the screen gets dirty)'],
  ['?', 'this help'],
  ['q', 'quit'],
  ['', ''],
  // The two deletes are one key apart and take wildly different amounts of the queue with
  // them. They get their own heading so nobody learns the difference the hard way.
  ['── deleting ──', ''],
  ['d  ONE', 'deletes ONLY the selected job. Asks first'],
  ['x  ALL', 'deletes ALL the finished ones at once (done, error, missed). Asks first'],
  ['', ''],
  // These three are the same conversation at three depths, and the old names ("out",
  // "chat") gave no clue which was which. Say what you get.
  ['── seeing a launch ──', ''],
  ['o  the ANSWER', 'just the last thing Claude said. The result, nothing else'],
  ['c  the CONVERSATION', 'every turn it took to get there: what it read, ran and edited'],
  ['y  JOIN the chat', 'opens a real, interactive Claude Code on that session. You keep talking'],
  ['', ''],
  ['── scheduling ──', ''],
  ['a job WITH a time', 'the daemon launches it at that time, with everything closed'],
  ['a job WITHOUT a time', 'sits in the queue until you press "r". It never self-launches'],
];

/**
 * The line under the tabs: the answer to "will this actually fire?".
 *
 * It used to answer a different question — "is the daemon on?" — and so it would sit there
 * in red, insisting nothing would be launched, while a `kaip run` in the next window was
 * about to launch it. Ask the queue who is holding it, not the daemon whether it exists.
 */
function daemonLine(state) {
  const r = state.data.runner;
  const next = state.data.next;
  const when = next ? c.muted(' · next ') + fmt(next) : c.muted(' · nothing scheduled');

  if (!r?.willFire) {
    return c.err('◇ nothing is processing the queue')
      + c.muted(' — scheduled work will NOT fire · "D" to arm the daemon');
  }
  if (r.kind === 'daemon') {
    return c.ok('◆ daemon up') + c.muted(` (pid ${r.pid})`) + when;
  }
  // A run keeps the promise too — but only until that window closes, and that is the bit
  // worth saying out loud.
  return c.ok('◆ a "run" is processing the queue') + c.muted(` (pid ${r.pid})`) + when
    + c.warn('  · it dies if you close that window');
}

function wizardLines(state, cols) {
  const wiz = state.wizard;
  const step = STEPS[wiz.step];
  const title = `${wiz.mode === 'add' ? 'new launch' : 'edit ' + wiz.id} · step ${wiz.step + 1}/${STEPS.length}`;

  const w = Math.min(cols - 6, 74);
  const field = w - 4;

  // The field you are typing in WRAPS. A prompt is a paragraph, not a word — truncating it
  // to one line meant you could not see what you had written, which is a strange thing to
  // do to the one screen whose whole purpose is composing text.
  const body = STEPS.flatMap((s, i) => {
    const label = c.muted((s.label + ':').padEnd(13));

    if (i > wiz.step) return [label + c.muted('—')];
    if (i < wiz.step) return [label + trunc(wiz.values[s.key] || '(empty)', field - 14)];

    if (s.choices) {
      return [label + s.choices
        .map((ch) => (ch === wiz.values[s.key] ? c.accent('[' + ch + ']') : c.muted(' ' + ch + ' ')))
        .join(' ')];
    }

    const lines = wrap(wiz.buffer || '', field);
    const shown = lines.slice(-10);                 // a very long prompt keeps its tail visible
    const hidden = lines.length - shown.length;

    const out = [];
    if (hidden > 0) out.push(c.muted(`  … ${hidden} line${hidden === 1 ? '' : 's'} further up`));
    out.push(label + (shown[0] ?? '') + (shown.length === 1 ? c.accent('▏') : ''));
    shown.slice(1).forEach((l, k) => {
      const last = k === shown.length - 2;
      out.push('             ' + l + (last ? c.accent('▏') : ''));
    });
    if (wiz.buffer) out.push(c.muted(`             ${wiz.buffer.length} characters`));
    return out;
  });

  // The conversations/folders you already have, right under the field. Continuing one
  // is much cheaper than starting fresh: the session still has the context loaded.
  const picks = [];
  if (step.suggest) {
    const list = step.suggest().slice(0, 5);
    if (list.length) {
      picks.push('', c.muted('  ── or continue one of these ──'));
      list.forEach((s, i) => {
        const row = `  ${s.value.padEnd(18)} ${c.muted(s.note)}`;
        picks.push(i === wiz.pick ? c.accent('▸') + c.bold(row) : ' ' + row);
      });
    }
  }

  return [
    ...box([...body, ...picks, '', c.muted(step.hint)], { title, cols: Math.min(cols - 6, 74) }),
    '',
    c.muted('  enter: next · esc: cancel'),
  ];
}

/** The last segment of a path — the project, as a person would name it. */
const projectName = (dir) => String(dir ?? '').split(/[\\/]/).filter(Boolean).pop() || '—';

/**
 * "A conversation looks like it was cut off."
 *
 * An OFFER, not an action: nothing has been queued, and nothing will be until enter. That
 * distinction is the whole reason this is a box on the screen and not a job in the queue.
 */
function offerLines(state, cols) {
  const { hits, sel } = state.offer;
  const inner = Math.min(cols - 6, 76);

  const body = [c.bold('A conversation looks like it was cut off.'), ''];
  hits.forEach((h, i) => {
    const here = i === sel;
    const head = `${projectName(h.dir)} · ${ago(h.at)}`;
    body.push((here ? c.accent('▸ ') : '  ') + (here ? c.bold(head) : c.muted(head)));
    // The request nobody answered. It is the best available answer to "which chat was this?" —
    // far better than a session id, which tells you nothing you can recognise.
    body.push('    ' + c.muted(h.ask ? `«${trunc(h.ask, inner - 10)}»` : '(no text)'));
  });
  body.push('');
  body.push(hits.length > 1
    ? 'Finish the selected one as soon as the quota is back?'
    : 'Finish it as soon as the quota is back?');

  return box(body, { title: 'cut short', cols: inner });
}

/** The whole screen, as lines. Pure: give it a state and a size, get the frame. */
export function render(state, dims = size()) {
  const cols = Math.max(40, dims.cols);
  const rowsN = Math.max(12, dims.rows);

  const tabs = VIEWS.map((v) => {
    const label = v === 'queue' ? `${TITLES[v]} (${state.data.queue.length})` : TITLES[v];
    return v === state.view ? c.accent('● ' + c.bold(label)) : c.muted('○ ' + label);
  }).join(c.muted('   '));

  const head = [
    c.bold(c.accent('kaip')) + c.muted('  ·  guided mode'),
    tabs,
    daemonLine(state),
    '',
    ...(state.offer ? [...offerLines(state, cols), ''] : []),
  ];

  let body;
  if (state.wizard) body = wizardLines(state, cols);
  else if (state.detail) body = box(jobDetails(state.detail).split('\n'), { title: 'job', cols: Math.min(cols - 6, 76) });
  else if (state.view === 'queue') body = queueRows(state, cols);
  else if (state.view === 'sessions') body = sessionRows(state, cols);
  else if (state.view === 'projects') body = projectRows(state, cols);
  else body = HELP_ROWS.map(([k, d]) => '  ' + c.accent(k.padEnd(17)) + c.muted(d));

  // Keep the selected row on screen when the queue is longer than the terminal.
  const room = Math.max(3, rowsN - head.length - 4);
  if (!state.wizard && !state.detail && body.length > room) {
    const start = Math.max(0, Math.min(state.sel - Math.floor(room / 2), body.length - room));
    body = body.slice(start, start + room);
  }

  // The two deletes are DIFFERENT and easy to mistake for each other — one takes the row
  // under the cursor, the other takes the whole finished half of the queue. So they get
  // their own line, side by side, spelled out, right above the list they act on. In the
  // footer they were two letters lost among nine.
  const spent = state.data.queue.filter((j) => j.status !== 'pending' && j.status !== 'running');
  const onQueue = state.view === 'queue' && !state.wizard && !state.detail && !state.offer;
  const here = selected(state);

  const sweep = onQueue && (here || spent.length)
    ? ['  ' + [
      here ? c.accent('d') + c.muted(` — delete ONLY this one (${here.id})`) : null,
      spent.length ? c.accent('x') + c.muted(` — delete the ${spent.length} FINISHED ones`) : null,
    ].filter(Boolean).join(c.muted('     '))]
    : [];

  const foot = state.offer
    ? '  ' + c.bold(c.accent('[enter]')) + ' yes' + c.muted('   ·   ')
      + c.bold('[esc]') + ' no' + c.muted(" (won't ask again)")
      + (state.offer.hits.length > 1 ? c.muted('   ·   ↑↓ choose') : '')
    : state.confirm
      ? c.warn('  ' + state.confirm.text + ' ') + c.bold('[y/n]')
      // "out" and "chat" told you nothing about how they differ. Say what you GET, not the
      // name of the command: the answer, the whole conversation, or a seat in it.
      : c.muted('  ↑↓ · a add · e edit · D daemon · r run  │  '
        + 'o answer · c conversation · y JOIN chat  │  R redraw · ? help · q quit');

  const pad = Math.max(0, rowsN - head.length - body.length - sweep.length - 3);
  return [
    ...head,
    ...body,
    ...Array(pad).fill(''),
    ...sweep,
    state.message ? '  ' + state.message : '',
    foot,
  ].map((l) => fit(l, cols));            // nothing may wrap: one long line breaks the frame
}
