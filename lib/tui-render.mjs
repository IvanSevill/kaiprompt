// State → the lines to paint. Pure: give it a state and a size, get the frame back.
//
// Nothing here reads the disk, writes to the store or launches anything. That is what makes
// the whole GUI testable with no terminal: the tests build a state, call render, and read
// what a person would have seen.

import { ago, fmt } from './time.mjs';
import { jobDetails } from './queue.mjs';
import { jobPreview, resolvePrompt } from './prompt.mjs';
import { box, c, fit, size, trunc, wrap } from './ui.mjs';
import { ICON, rows, selected, STEPS, TITLES, usageReport, VIEWS, visibleWizardChoices, wizardChoices } from './tui-state.mjs';

function queueRows(state, cols) {
  if (!state.data.queue.length) return [c.muted('  (empty queue — press "a" to add a launch)')];
  return state.data.queue.map((j, i) => {
    // A job that jumps the queue has to LOOK like it does. It sits wherever it was added,
    // but runs before everything above it — and a row that says "seq" while the runner
    // quietly takes it first is the tool lying about its own order.
    const when = j.when ? '@ ' + fmt(j.when) : j.priority ? '↑ first in line' : 'seq';
    const marked = state.selectedIds?.includes(j.id) ? c.accent('●') : ' ';
    const line = `${marked}${ICON[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
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

function compactNumber(value) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function usageValue(value) {
  return value ? `${value.partial ? '~' : ''}${compactNumber(value.value)}` : '?';
}

function shortSession(value, jobId) {
  if (!value) return `job ${String(jobId ?? '?').slice(0, 8)}`;
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

function usageRows(state, cols) {
  const report = usageReport(state);
  const scope = state.data.usageScopes.find((item) => item.key === state.usageScope) ?? state.data.usageScopes[0];
  const selector = `  Usage · ${scope.label}   ${c.muted('↑/↓ switch scope')}`;
  if (!report.sessions.length) return [c.accent(selector), '', c.muted('  (no usage data for this scope)')];

  const total = report.totals;
  const totalCost = total.cost?.value > 0 ? ` · $${total.cost.value.toFixed(4)}` : '';
  const out = [c.accent(selector), '', c.bold(`  ${usageValue(total.total)} tokens total`)
    + c.muted(` · ${usageValue(total.input)} in · ${usageValue(total.output)} out${totalCost}`), ''];
  report.sessions.forEach((row) => {
    const label = row.target || shortSession(row.session, row.jobId);
    const cost = row.usage.cost?.value > 0 ? ` · $${row.usage.cost.value.toFixed(4)}` : '';
    const metrics = row.usage.total
      ? `${usageValue(row.usage.total)} tok · ${usageValue(row.usage.input)} in · ${usageValue(row.usage.output)} out${cost}`
      : 'usage unavailable';
    out.push(rowLine(`${label.padEnd(20)} ${metrics}`, false, cols));
  });
  return out;
}

function rowLine(text, isSel, cols) {
  // fit, not trunc: trunc collapses runs of spaces and would eat the column alignment.
  const body = fit(text, cols - 4);
  return isSel ? c.accent('▸ ') + c.bold(body) : '  ' + body;
}

const HELP_ROWS = [
  ['← → / tab / 1-5', 'switch view'],
  ['u', 'usage view; ↑ ↓ chooses Claude, Codex, or an OpenCode provider'],
  ['enter / i', 'full, scrollable information about the selected job'],
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
  ['o  the ANSWER', 'finished jobs only: just the last answer'],
  ['c  the CONVERSATION', 'finished jobs only: every turn it took'],
  ['y  Open <adapter> chat', 'jobs with a saved session, except while running'],
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
  const steps = wiz.steps || STEPS;
  const step = steps[wiz.step];
  const title = `${wiz.mode === 'add' ? 'new launch' : wiz.mode === 'bulk-engine' ? `change engine · ${wiz.ids.length} jobs` : 'edit ' + wiz.id} · step ${wiz.step + 1}/${steps.length}`;

  const w = Math.min(cols - 6, 74);
  const field = w - 4;

  // The field you are typing in WRAPS. A prompt is a paragraph, not a word — truncating it
  // to one line meant you could not see what you had written, which is a strange thing to
  // do to the one screen whose whole purpose is composing text.
  const body = steps.flatMap((s, i) => {
    const promptFile = s.key === 'prompt' && wiz.promptMode === 'file';
    const label = c.muted(((promptFile ? 'Prompt file' : s.label) + ':').padEnd(13));
    const shownValue = promptFile ? wiz.values.from : wiz.values[s.key];

    if (i !== wiz.step) return [label + trunc(shownValue || '(empty)', field - 14)];

    const allChoices = wizardChoices(s, wiz.values);
    const dynamicChoice = s.key === 'provider' || s.key === 'model';
    const choices = dynamicChoice ? visibleWizardChoices(s, wiz.values, wiz.buffer) : allChoices;
    if (s.choices || (dynamicChoice && allChoices.length)) {
      const current = s.choices ? wiz.values[s.key] : wiz.buffer;
      if (dynamicChoice) {
        const selectedAt = choices.indexOf(current);
        const start = Math.max(0, Math.min(selectedAt < 0 ? 0 : selectedAt - 3, Math.max(0, choices.length - 7)));
        const shown = choices.slice(start, start + 7);
        const list = shown.map((choice) => '             '
          + (choice === current ? c.accent('▸ ' + choice) : c.muted('  ' + choice)));
        if (choices.length > shown.length) list.push(c.muted(`             ${start + 1}-${start + shown.length} of ${choices.length}`));
        return [label + (current ? c.accent(current) : c.muted('(type to filter)')) + c.accent('▏'), ...list];
      }
      const options = choices
        .map((ch) => (ch === current ? c.accent('[' + ch + ']') : c.muted(' ' + ch + ' ')))
        .join(' ');
      return [label + (dynamicChoice && current ? c.accent(current + ' ') : '') + options];
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
    ...box([...body, ...picks, '', c.muted(step.key === 'prompt' && wiz.promptMode === 'file'
      ? 'path to a prompt file; read at launch · ←/→ writes text instead'
      : step.hint)], { title, cols: Math.min(cols - 6, 74) }),
    '',
    c.muted('  ↑/↓: field · ←/→: choose · enter: validate & save · esc: cancel'),
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

function detailFields(detail, cols) {
  const job = detail.job ?? detail;
  let prompt;
  try { prompt = resolvePrompt(job); } catch (e) { prompt = `ERROR: ${e.message.split('\n')[0]}`; }
  return [
    `id: ${job.id ?? '—'}`, `status: ${job.status ?? '—'}`, `target: ${job.target ?? '—'}`,
    `dir: ${job.dir ?? '—'}`, `adapter: ${job.adapter ?? 'claude'}${job.provider ? '/' + job.provider : ''}${job.model ? '/' + job.model : ''}`,
    `sessionId: ${job.sessionId ?? '—'}`, `created: ${job.createdAt ? fmt(job.createdAt) : '—'}`,
    `started: ${job.startedAt ? fmt(job.startedAt) : '—'}`, `finished: ${job.finishedAt ? fmt(job.finishedAt) : '—'}`,
    `pausedUntil: ${job.pausedUntil ? fmt(job.pausedUntil) : '—'}`, job.error ? `error: ${job.error}` : null,
    '', 'prompt:', ...wrap(prompt, Math.max(20, Math.min(cols - 12, 70))),
  ].filter((line) => line !== null);
}

/** The reducer needs the same limit as the renderer, or Down can walk off the detail page. */
export function detailMaxScroll(detail, dims = size()) {
  const room = Math.max(3, Math.max(12, dims.rows) - 10);
  return Math.max(0, detailFields(detail, Math.max(40, dims.cols)).length - room);
}

function detailLines(detail, cols, rowsN) {
  const fields = detailFields(detail, cols);
  const room = Math.max(3, rowsN - 10);
  const max = detailMaxScroll(detail, { cols, rows: rowsN });
  const scroll = Math.min(detail.scroll ?? 0, max);
  const shown = fields.slice(scroll, scroll + room);
  const indicator = fields.length > room ? c.muted(`${scroll + 1}/${fields.length} lines · ↑↓ scroll · enter/esc/q close`) : c.muted(`${fields.length} lines · enter/esc/q close`);
  return [...box(shown, { title: 'job info', cols: Math.min(cols - 6, 76) }), indicator];
}

function helpLines(cols) {
  const keyWidth = cols >= 90 ? 20 : 18;
  return HELP_ROWS.flatMap(([key, description]) => {
    if (!key) return [''];
    if (cols < 70) return ['  ' + c.accent(key), description ? '    ' + c.muted(description) : ''];
    return ['  ' + c.accent(key.padEnd(keyWidth)) + c.muted(description)];
  });
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
    ...(state.update ? [c.ok(`  📦 new: v${state.update.latest}`)] : []),
  ];

  let body;
  if (state.wizard) body = wizardLines(state, cols);
  else if (state.detail) body = detailLines(state.detail, cols, rowsN);
  else if (state.view === 'queue') body = queueRows(state, cols);
  else if (state.view === 'sessions') body = sessionRows(state, cols);
  else if (state.view === 'projects') body = projectRows(state, cols);
  else if (state.view === 'usage') body = usageRows(state, cols);
  else body = helpLines(cols);

  // Keep the selected row on screen when the queue is longer than the terminal.
  const room = Math.max(3, rowsN - head.length - 4);
  if (!state.wizard && !state.detail && body.length > room) {
    if (state.view === 'usage') {
      // Historical usage has no row cursor yet, but its totals must not scroll out of sight.
      body = [...body.slice(0, Math.max(1, room - 4)), c.muted('  … sessions omitted …'), ...body.slice(-3)];
    } else {
      const start = Math.max(0, Math.min(state.sel - Math.floor(room / 2), body.length - room));
      body = body.slice(start, start + room);
    }
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
        : c.muted('  ' + footerKeys(here));

  const pad = Math.max(0, rowsN - head.length - body.length - sweep.length - 3);
  return [
    ...head,
    ...body,
    ...Array(pad).fill(''),
    ...sweep,
    state.message ? '  ' + state.message : '',
    foot,
  ].flatMap((l) => wrapFooter(l, cols));
}

function footerKeys(job) {
  const basic = '↑↓ · space select · m change engine · a add · e edit · i info · D daemon · r run';
  const finished = ['done', 'error'].includes(job?.status) ? 'o answer · c conversation' : '';
  const retry = job?.status === 'error' ? 't retry' : '';
  const resume = job?.sessionId && job.status !== 'running' ? `y Open ${job.adapter || ''} chat`.replace('  ', ' ') : '';
  return [basic, finished, retry, resume, 'u usage · R redraw · ? help · q quit'].filter(Boolean).join('  │  ');
}

function wrapFooter(line, cols) {
  // Only the footer may grow: frames otherwise rely on one physical row per logical line.
  if (!String(line).includes('↑↓ · space select')) return [fit(line, cols)];
  return wrap(line, cols).map((part) => c.muted(part));
}
