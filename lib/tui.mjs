// The guided GUI: `program-prompt` with no arguments.
//
// Split in three so it can be tested without a terminal:
//   decodeKey  raw stdin bytes → a key name
//   reduce     (state, key) → { state, effect }   — pure: no IO, no store writes
//   render     state → the lines to paint         — pure
//   applyEffect / startTUI                        — where the IO actually happens
//
// Every mutation goes through lib/queue.mjs and lib/edit.mjs: the GUI is another
// front-end for the existing commands, not a second implementation of them.

import fs from 'node:fs';

import { loadProjects, loadQueue, loadSessions, importProgramados, outPath, preview } from './store.mjs';
import { fmt, parseWhen } from './time.mjs';
import { addJob, jobDetails, removeJobs } from './queue.mjs';
import { editJob } from './edit.mjs';
import { renderChat } from './chat.mjs';
import { runQueue } from './runner.mjs';
import {
  altEnter, altExit, box, c, fit, installCleanup, isTTY, paint, size, trunc,
} from './ui.mjs';

export const VIEWS = ['queue', 'sessions', 'projects', 'help'];
const TITLES = { queue: 'Queue', sessions: 'Chats', projects: 'Projects', help: 'Help' };
const PERMS = ['bypass', 'acceptEdits', 'default'];
const ICON = { pending: '·', running: '▶', done: '✓', error: '✗' };

// The add/edit wizard, one step per line of a job.
const STEPS = [
  { key: 'prompt', label: 'Prompt', hint: 'what to launch' },
  { key: 'when', label: 'When', hint: 'HH:MM · +2h · "tomorrow 09:00" · empty = sequential' },
  { key: 'target', label: 'Target', hint: 'conversation to resume · empty = new session' },
  { key: 'dir', label: 'Folder', hint: 'project, alias or path · empty = current folder' },
  { key: 'perm', label: 'Permissions', hint: '← → to choose', choices: PERMS },
];

// --- keys --------------------------------------------------------------------
/** Raw stdin chunk → a key name ('up', 'enter', 'esc'…) or the character typed. */
export function decodeKey(data) {
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const named = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\r': 'enter', '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace',
    '\t': 'tab', '\x03': 'ctrl-c', ' ': 'space',
  };
  return named[s] ?? s;
}

// --- state -------------------------------------------------------------------
export const loadData = () => ({
  queue: loadQueue(),
  sessions: loadSessions(),
  projects: loadProjects(),
});

export function initialState() {
  return {
    view: 'queue',
    sel: 0,
    data: loadData(),
    detail: null,      // a job being shown in full
    wizard: null,      // { mode: 'add'|'edit', id, step, values, buffer }
    confirm: null,     // { text, effect }
    message: null,     // one-line feedback under the list
  };
}

/** The rows of the current view — what ↑↓ moves through. */
export function rows(state) {
  if (state.view === 'queue') return state.data.queue;
  if (state.view === 'sessions') {
    return Object.entries(state.data.sessions).map(([target, s]) => ({ target, ...s }));
  }
  if (state.view === 'projects') {
    return Object.entries(state.data.projects)
      .filter(([k]) => k !== '_base')
      .map(([alias, path]) => ({ alias, path }));
  }
  return [];
}

export const selected = (state) => rows(state)[state.sel] ?? null;

/** Re-read from disk and keep the cursor inside the list. */
export function refresh(state) {
  const next = { ...state, data: loadData() };
  return { ...next, sel: Math.max(0, Math.min(state.sel, Math.max(0, rows(next).length - 1))) };
}

// --- the wizard --------------------------------------------------------------
const wizardFor = (mode, job) => ({
  mode,
  id: job?.id ?? null,
  step: 0,
  values: {
    prompt: job?.prompt ?? '',
    when: job?.when ? new Date(job.when).toISOString().slice(0, 16) : '',
    target: job?.target ?? '',
    dir: job?.dir ?? '',
    perm: job?.permMode ?? 'bypass',
  },
  buffer: job?.prompt ?? '',
});

/** Keys inside the wizard: typing, ← → for the choice step, enter/esc. */
function reduceWizard(state, key) {
  const wiz = state.wizard;
  const step = STEPS[wiz.step];
  const keep = (over) => ({ state: { ...state, message: null, ...over }, effect: null });

  if (key === 'esc') return { state: { ...state, wizard: null, message: 'cancelled' }, effect: null };

  if (step.choices) {
    const i = Math.max(0, step.choices.indexOf(wiz.values[step.key]));
    if (key === 'left' || key === 'up') {
      const v = step.choices[(i - 1 + step.choices.length) % step.choices.length];
      return keep({ wizard: { ...wiz, values: { ...wiz.values, [step.key]: v } } });
    }
    if (key === 'right' || key === 'down' || key === 'space') {
      const v = step.choices[(i + 1) % step.choices.length];
      return keep({ wizard: { ...wiz, values: { ...wiz.values, [step.key]: v } } });
    }
  }

  if (key === 'enter') {
    const raw = step.choices ? wiz.values[step.key] : wiz.buffer.trim();

    if (step.key === 'prompt' && !raw) {
      return { state: { ...state, message: c.err('the prompt cannot be empty') }, effect: null };
    }
    if (step.key === 'when' && raw) {
      // Catch a bad time here, while it can still be retyped — not at 3am on launch.
      try { parseWhen(raw); }
      catch (e) { return { state: { ...state, message: c.err(e.message) }, effect: null }; }
    }

    const values = { ...wiz.values, [step.key]: raw };
    if (wiz.step === STEPS.length - 1) {
      const effect = wiz.mode === 'add'
        ? { type: 'add', values }
        : { type: 'edit', id: wiz.id, values };
      return { state: { ...state, wizard: null }, effect };
    }
    const next = wiz.step + 1;
    return keep({ wizard: { ...wiz, step: next, values, buffer: String(values[STEPS[next].key] ?? '') } });
  }

  if (key === 'backspace') return keep({ wizard: { ...wiz, buffer: wiz.buffer.slice(0, -1) } });
  if (key === 'space') return keep({ wizard: { ...wiz, buffer: wiz.buffer + ' ' } });
  if (key.length === 1 && key >= ' ') return keep({ wizard: { ...wiz, buffer: wiz.buffer + key } });
  return { state, effect: null };
}

// --- the state machine -------------------------------------------------------
/** (state, key) → the next state and, at most, one effect for the caller to run. */
export function reduce(state, key) {
  const msg = (m) => ({ state: { ...state, message: m }, effect: null });
  const none = { state, effect: null };

  if (key === 'ctrl-c') return { state, effect: { type: 'quit' } };

  if (state.confirm) {
    if (key === 'y') return { state: { ...state, confirm: null }, effect: state.confirm.effect };
    if (key === 'n' || key === 'esc' || key === 'q') {
      return { state: { ...state, confirm: null, message: 'cancelled' }, effect: null };
    }
    return none;
  }

  if (state.wizard) return reduceWizard(state, key);

  if (state.detail) {
    if (['esc', 'enter', 'q'].includes(key)) return { state: { ...state, detail: null }, effect: null };
    return none;
  }

  // --- navigation ---
  const list = rows(state);
  const view = (v) => ({ state: { ...state, view: v, sel: 0, message: null }, effect: null });

  if (key === 'q') return { state, effect: { type: 'quit' } };
  if (key === '?') return view('help');
  if (key >= '1' && key <= '4') return view(VIEWS[Number(key) - 1]);
  if (key === 'tab' || key === 'right') return view(VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length]);
  if (key === 'left') {
    return view(VIEWS[(VIEWS.indexOf(state.view) - 1 + VIEWS.length) % VIEWS.length]);
  }
  if (key === 'up') return { state: { ...state, sel: Math.max(0, state.sel - 1) }, effect: null };
  if (key === 'down') {
    return { state: { ...state, sel: Math.min(Math.max(0, list.length - 1), state.sel + 1) }, effect: null };
  }
  if (key === 'r') return { state, effect: { type: 'run' } };
  if (key === 'a') return { state: { ...state, wizard: wizardFor('add', null), message: null }, effect: null };

  const item = selected(state);

  if (state.view === 'sessions' && item) {
    if (key === 'enter' || key === 'c') return { state, effect: { type: 'chat', ref: item.target } };
  }

  if (state.view !== 'queue' || !item) {
    if (['e', 'd', 'o', 'c', 'enter'].includes(key)) return msg(c.muted('nothing selected'));
    return none;
  }

  // --- the queue view, on the selected job ---
  switch (key) {
    case 'enter':
      return { state: { ...state, detail: item }, effect: null };
    case 'e':
      if (item.status !== 'pending') return msg(c.err(`job is ${item.status}: only pending jobs can be edited`));
      return { state: { ...state, wizard: wizardFor('edit', item), message: null }, effect: null };
    case 'd':
      return {
        state: {
          ...state,
          confirm: { text: `delete ${item.id} (${preview(item.prompt, 30)})?`, effect: { type: 'delete', id: item.id } },
        },
        effect: null,
      };
    case 'o':
      return { state, effect: { type: 'out', id: item.id } };
    case 'c':
      return { state, effect: { type: 'chat', ref: item.id } };
    default:
      return none;
  }
}

// --- effects that touch the store --------------------------------------------
/** Run a store-mutating effect. Returns the line to show; never throws. */
export function applyEffect(effect) {
  try {
    if (effect.type === 'add') {
      const v = effect.values;
      const job = addJob({
        prompt: v.prompt, at: v.when || null, target: v.target || null,
        dir: v.dir || null, perm: v.perm === 'bypass' ? null : v.perm,
      });
      return c.ok(`+ ${job.id}`) + ` ${job.when ? '@ ' + fmt(job.when) : '(sequential)'} ${preview(job.prompt, 30)}`;
    }
    if (effect.type === 'edit') {
      const v = effect.values;
      // An emptied field means "clear it" — that's what edit.mjs reads as "none".
      const { job, changes } = editJob(effect.id, {
        prompt: v.prompt,
        at: v.when || 'none',
        target: v.target || 'none',
        dir: v.dir || 'none',
        perm: v.perm,
      });
      return c.ok(`✎ ${job.id}`) + c.muted(` updated: ${changes.join(', ')}`);
    }
    if (effect.type === 'delete') {
      const n = removeJobs([effect.id]);
      return n ? c.ok(`removed ${effect.id}`) : c.err('nothing removed');
    }
  } catch (e) {
    return c.err(e.message.split('\n')[0]);
  }
  return null;
}

// --- rendering ---------------------------------------------------------------
function queueRows(state, cols) {
  if (!state.data.queue.length) return [c.muted('  (empty queue — press "a" to add a launch)')];
  return state.data.queue.map((j, i) => {
    const when = j.when ? '@ ' + fmt(j.when) : 'seq';
    const line = `${ICON[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
      + `${when.padEnd(22)} ${j.adapter}${j.target ? '/' + j.target : ''}  ${preview(j.prompt, 34)}`;
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
  if (!list.length) out.push(c.muted('  (no aliases — program-prompt projects <alias> <path>)'));
  out.push(...list.map((p, i) => rowLine(`${p.alias.padEnd(16)} → ${p.path}`, i === state.sel, cols)));
  return out;
}

function rowLine(text, isSel, cols) {
  // fit, not trunc: trunc collapses runs of spaces and would eat the column alignment.
  const body = fit(text, cols - 4);
  return isSel ? c.accent('▸ ') + c.bold(body) : '  ' + body;
}

const HELP_ROWS = [
  ['↑ ↓', 'move through the list'],
  ['← → / tab / 1-4', 'switch view'],
  ['enter', 'detail of the selected job'],
  ['a', 'add a launch (guided: prompt → when → target → folder → permissions)'],
  ['e', 'edit a pending job'],
  ['d', 'delete a job (asks first)'],
  ['r', 'run the queue (full-screen countdown + live view)'],
  ['o', 'output of a launch'],
  ['c', 'the whole conversation of a launch'],
  ['?', 'this help'],
  ['q', 'quit'],
];

function wizardLines(state, cols) {
  const wiz = state.wizard;
  const step = STEPS[wiz.step];
  const title = `${wiz.mode === 'add' ? 'new launch' : 'edit ' + wiz.id} · step ${wiz.step + 1}/${STEPS.length}`;

  const body = STEPS.map((s, i) => {
    const label = c.muted((s.label + ':').padEnd(13));
    if (i > wiz.step) return label + c.muted('—');
    if (i < wiz.step) return label + trunc(wiz.values[s.key] || '(empty)', cols - 20);
    if (s.choices) {
      return label + s.choices
        .map((ch) => (ch === wiz.values[s.key] ? c.accent('[' + ch + ']') : c.muted(' ' + ch + ' ')))
        .join(' ');
    }
    return label + trunc(wiz.buffer, cols - 22) + c.accent('▏');
  });

  return [
    ...box([...body, '', c.muted(step.hint)], { title, cols: Math.min(cols - 6, 70) }),
    '',
    c.muted('  enter: next · esc: cancel'),
  ];
}

/** The whole screen, as lines. Pure: give it a state and a size, get the frame. */
export function render(state, dims = size()) {
  const cols = Math.max(40, dims.cols);
  const rowsN = Math.max(12, dims.rows);

  const tabs = VIEWS.map((v) => {
    const label = v === 'queue' ? `${TITLES[v]} (${state.data.queue.length})` : TITLES[v];
    return v === state.view ? c.accent('● ' + c.bold(label)) : c.muted('○ ' + label);
  }).join(c.muted('   '));

  const head = [c.bold(c.accent('program-prompt')) + c.muted('  ·  guided mode'), tabs, ''];

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

  const foot = state.confirm
    ? c.warn('  ' + state.confirm.text + ' ') + c.bold('[y/n]')
    : c.muted('  ↑↓ move · enter detail · a add · e edit · d del · r run · o out · c chat · ? help · q quit');

  const pad = Math.max(0, rowsN - head.length - body.length - 3);
  return [
    ...head,
    ...body,
    ...Array(pad).fill(''),
    state.message ? '  ' + state.message : '',
    foot,
  ].map((l) => fit(l, cols));            // nothing may wrap: one long line breaks the frame
}

// --- reading a launch's output ------------------------------------------------
/** The text `o` shows — same thing the `out` command prints. */
export function readOutput(id) {
  const job = loadQueue().find((j) => j.id === id);
  const file = outPath(id);
  if (!job || !fs.existsSync(file)) return c.muted(`(no output for ${id} yet — it hasn't run)`);

  const head = `── ${job.id} [${job.status}] ${preview(job.prompt, 40)} ──`;
  const resume = job.sessionId
    ? c.muted(`\nresume: cd "${job.dir || '.'}" && claude --resume ${job.sessionId}`)
    : '';
  return head + resume + '\n\n' + fs.readFileSync(file, 'utf8').trimEnd();
}

/** The text `c` shows, errors included: a missing transcript must not kill the GUI. */
export function chatText(ref) {
  try { return renderChat(ref, { last: 20 }); }
  catch (e) { return c.err(e.message); }
}

// --- the loop ----------------------------------------------------------------
/**
 * The GUI. Only reachable with a TTY: without one the CLI prints the help instead.
 * Raw mode on a piped stdin (Task Scheduler, a cron pipe) would hang the unattended
 * batch forever, so that door stays shut.
 */
export async function startTUI() {
  if (!isTTY() || !process.stdin.isTTY) throw new Error('the GUI needs an interactive terminal');

  importProgramados();                    // whatever /programar left pending shows up in the queue

  const stdin = process.stdin;
  const rawOn = () => { stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); };
  const rawOff = () => { try { stdin.setRawMode(false); } catch { /* already closed */ } stdin.pause(); };

  let state = refresh(initialState());
  let done;                               // resolved when the user quits
  let paused = null;                      // set while a pager owns the screen
  let busy = false;                       // a pager or the runner is drawing, not us

  const draw = () => { if (!busy) paint(render(state)); };

  // Suspend the GUI, hand the normal screen to `text`, wait for a key, come back.
  const pager = (text) => new Promise((resolve) => {
    busy = true;
    altExit();
    console.log(text);
    console.log(c.muted('\n(press any key to go back)'));
    paused = () => { paused = null; busy = false; altEnter(); draw(); resolve(); };
  });

  async function handle(effect) {
    switch (effect.type) {
      case 'quit':
        done();
        return;

      case 'run': {                       // hand the screen to the runner's clock + live view
        busy = true;
        rawOff();
        altExit();
        try { await runQueue({}); }
        catch (e) { state = { ...state, message: c.err(e.message) }; }
        rawOn();
        altEnter();
        busy = false;
        state = refresh(state);
        return;
      }

      case 'chat':
        await pager(chatText(effect.ref));
        return;

      case 'out':
        await pager(readOutput(effect.id));
        return;

      default:                            // add / edit / delete → straight to the store
        state = refresh({ ...state, message: applyEffect(effect) });
    }
  }

  const onData = (data) => {
    const key = decodeKey(data);
    if (paused) { paused(); return; }     // any key returns from the pager
    if (busy) return;                     // the runner owns the terminal; ignore

    const { state: next, effect } = reduce(state, key);
    state = next;
    draw();
    if (effect) handle(effect).then(draw);
  };

  // However we leave — q, Ctrl+C, a crash — the terminal goes back to normal.
  const restore = installCleanup(() => { rawOff(); stdin.removeListener('data', onData); });

  rawOn();
  stdin.on('data', onData);
  process.stdout.on('resize', draw);

  altEnter();
  draw();
  await new Promise((resolve) => { done = resolve; });

  restore();
  console.log(c.muted('bye.'));
}
