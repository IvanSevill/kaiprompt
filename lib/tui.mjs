// The guided GUI: `kaip` with no arguments.
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
import { spawn } from 'node:child_process';

import { loadProjects, loadQueue, loadSessions, importProgramados, outPath, preview } from './store.mjs';
import { fmt, parseWhen } from './time.mjs';
import { addJob, clearFinished, jobDetails, removeJobs, suggestDirs, suggestTargets } from './queue.mjs';
import { editJob } from './edit.mjs';
import { renderChat, resumeTarget } from './chat.mjs';
import { jobPreview } from './prompt.mjs';
import { goodbye } from './goodbye.mjs';
import { reapStale, runQueue } from './runner.mjs';
import * as daemon from './daemon.mjs';
import { runnerStatus } from './runner-status.mjs';
import {
  altEnter, altExit, box, c, clear, fit, installCleanup, isTTY, paint, size, trunc, wrap, writeLines,
} from './ui.mjs';

export const VIEWS = ['queue', 'sessions', 'projects', 'help'];
const TITLES = { queue: 'Queue', sessions: 'Chats', projects: 'Projects', help: 'Help' };
const PERMS = ['bypass', 'acceptEdits', 'default'];
const ICON = { pending: '·', running: '▶', done: '✓', error: '✗', missed: '⊘' };

// The add/edit wizard, one step per line of a job.
// Nothing here launches anything: the wizard writes a job to the queue and stops. A job
// with a time is fired later by the daemon; one without waits for an explicit run.
const STEPS = [
  { key: 'prompt', label: 'Prompt', hint: 'what to launch — it is NOT sent now' },
  { key: 'when', label: 'When', hint: 'HH:MM · +2h · "tomorrow 09:00" — empty = only on a manual run' },
  // The two steps with suggestions. Reusing a target is the biggest token saving there
  // is — the launch resumes a conversation that already has the context loaded — so the
  // ones you already have are offered right there instead of made you remember them.
  {
    key: 'target',
    label: 'Target',
    hint: '↑↓ pick a conversation to continue (cheaper: context already loaded) · or type a new name',
    suggest: () => suggestTargets().map((t) => ({
      value: t.target,
      note: t.upcoming ? 'queued, no session yet' : `session ${String(t.sessionId).slice(0, 8)}… · ${t.jobs} job(s)`,
    })),
  },
  {
    key: 'dir',
    label: 'Folder',
    hint: '↑↓ pick a project you already use · or type a path · empty = current folder',
    suggest: () => suggestDirs().map((d) => ({ value: d.dir, note: d.label || '' })),
  },
  { key: 'perm', label: 'Permissions', hint: '← → to choose', choices: PERMS },
];

// --- keys --------------------------------------------------------------------
// Bracketed paste: the terminal wraps pasted text in these two markers, which is the only
// way to tell "the user pasted this" from "the user typed this very fast" without guessing.
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Pasted text, marked as such. A key name ('up', 'tab') is text too — this is what tells them apart. */
export const asPaste = (text) => PASTE_START + String(text).replace(/\r\n?/g, '\n') + PASTE_END;

/** A burst of printable characters in one chunk is a paste: nobody types 200 characters at once. */
const looksPasted = (s) => s.length > 1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);

/** Raw stdin chunk → a key name ('up', 'enter', 'esc'…) or the character(s) typed. */
export function decodeKey(data) {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  // Windows Terminal sends \r for Enter, and a pasted line break arrives as \r\n. Normalising
  // here means the rest of the file only ever has to know about \n.
  const s = raw.replace(/\r\n?/g, '\n');
  const named = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace',
    '\t': 'tab', '\x03': 'ctrl-c', ' ': 'space',
  };
  return named[s] ?? s;
}

/**
 * Is this key actually a paste? Then the text of it — otherwise null.
 *
 * In raw mode a paste is not an event: it is a burst of characters in one `data` chunk. The
 * key reader was treating each burst as ONE keypress and dropping the rest, which is why
 * Ctrl+V did nothing at all in the wizard.
 */
export function pasteText(key) {
  const s = String(key ?? '');
  if (!s.startsWith(PASTE_START) || !s.endsWith(PASTE_END)) return null;
  return s.slice(PASTE_START.length, -PASTE_END.length);
}

/**
 * A stdin chunk → the keys it carries.
 *
 * Stateful, and only for one reason: a big bracketed paste can arrive split across chunks, so
 * the text between the markers has to be stitched back together before it counts as one key.
 * Terminals that do not do bracketed paste get the burst heuristic instead, and either way
 * what comes out is one marked paste key.
 */
export function keyReader() {
  let pending = null;                     // an open paste, still waiting for its end marker

  return function read(data) {
    const s = (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).replace(/\r\n?/g, '\n');
    if (!s) return [];

    if (pending !== null) {
      const buf = pending + s;
      const end = buf.indexOf(PASTE_END);
      if (end === -1) { pending = buf; return []; }              // more of it is still coming
      pending = null;
      return [asPaste(buf.slice(0, end)), ...read(buf.slice(end + PASTE_END.length))];
    }

    const start = s.indexOf(PASTE_START);
    if (start !== -1) {
      const before = start ? read(s.slice(0, start)) : [];
      const rest = s.slice(start + PASTE_START.length);
      const end = rest.indexOf(PASTE_END);
      if (end === -1) { pending = rest; return before; }
      return [...before, asPaste(rest.slice(0, end)), ...read(rest.slice(end + PASTE_END.length))];
    }

    const key = decodeKey(s);
    // decodeKey gave back the text unchanged ⇒ it is not a named key. Several characters of
    // plain text in one chunk did not come off a keyboard: they were pasted.
    return [key === s && looksPasted(s) ? asPaste(s) : key];
  };
}

// --- state -------------------------------------------------------------------
export const loadData = () => ({
  queue: loadQueue(),
  sessions: loadSessions(),
  projects: loadProjects(),
  daemon: daemon.status(),        // cheap: a small JSON + "is that pid alive?"
  runner: runnerStatus(),         // who is ACTUALLY processing the queue: daemon, a run, or nobody
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

  // ↑↓ walk the suggestions into the buffer; you can still just type over them.
  if (step.suggest && (key === 'up' || key === 'down')) {
    const list = step.suggest();
    if (!list.length) return { state, effect: null };
    const at = wiz.pick ?? -1;
    const next = key === 'down'
      ? (at + 1) % list.length
      : (at - 1 + list.length) % list.length;
    return keep({ wizard: { ...wiz, pick: next, buffer: list[next].value } });
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
    return keep({
      wizard: { ...wiz, step: next, values, pick: null, buffer: String(values[STEPS[next].key] ?? '') },
    });
  }

  // A paste goes in WHOLE. Its line breaks are text, not Enter — reading them as Enter is what
  // turned one Ctrl+V into "I confirmed the form three times", and it was never possible to
  // paste a prompt in the first place: only the first character of the burst survived.
  const pasted = pasteText(key);
  if (pasted && !step.choices) {
    return keep({ wizard: { ...wiz, pick: null, buffer: wiz.buffer + pasted } });
  }

  // Typing anything means you are writing your own value, not picking from the list.
  if (key === 'backspace') return keep({ wizard: { ...wiz, pick: null, buffer: wiz.buffer.slice(0, -1) } });
  if (key === 'space') return keep({ wizard: { ...wiz, pick: null, buffer: wiz.buffer + ' ' } });
  if (key.length === 1 && key >= ' ') {
    return keep({ wizard: { ...wiz, pick: null, buffer: wiz.buffer + key } });
  }
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

  // Outside the wizard there is nothing to paste INTO, and a paste is a burst of characters —
  // any one of which could be 'd' or 'x'. It is text, so here it is nothing.
  if (pasteText(key)) return none;

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
  if (key === 'D') return { state, effect: { type: 'daemon' } };   // arm/disarm the background runner

  // Redraw from scratch. Anything that writes to the terminal behind the GUI's back —
  // a launch's stray output, a resize the terminal swallowed — leaves debris on screen,
  // and there was no way to get a clean frame back short of quitting.
  if (key === 'R' || key === 'ctrl-l') return { state, effect: { type: 'restart' } };

  // Clear out everything that already ran. Asks first: it is the one key that throws
  // away more than one thing at a time.
  if (key === 'x') {
    const spent = state.data.queue.filter((j) => j.status !== 'pending' && j.status !== 'running');
    if (!spent.length) return msg(c.muted('nothing finished to clear'));
    return {
      state: {
        ...state,
        // Say TODOS, and say how many. "clear N finished job(s)?" reads like it might be
        // clearing the one you have selected, which is what `d` does — and the difference
        // between those two keys is the whole queue.
        confirm: {
          text: `¿seguro que quieres borrar los ${spent.length} terminados? (TODOS)`,
          effect: { type: 'clear' },
        },
      },
      effect: null,
    };
  }
  if (key === 'a') return { state: { ...state, wizard: wizardFor('add', null), message: null }, effect: null };

  const item = selected(state);

  // `y` walks INTO the conversation: hands the terminal to a real, interactive Claude
  // Code resumed on that session. Reading a transcript ("c") tells you what happened;
  // this lets you pick the thread back up and keep talking.
  if (key === 'y' && item) {
    const ref = state.view === 'sessions' ? item.target : item.id;
    return { state, effect: { type: 'resume', ref } };
  }

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
      if (item.status !== 'pending' && item.status !== 'missed') {
        return msg(c.err(`job is ${item.status}: only pending (or missed) jobs can be edited`));
      }
      return { state: { ...state, wizard: wizardFor('edit', item), message: null }, effect: null };
    case 'd':
      return {
        state: {
          ...state,
          // "SOLO este" spelled out, because the other delete key is one row away and takes
          // the entire finished half of the queue.
          confirm: {
            text: `¿borrar SOLO este job? ${item.id} — ${jobPreview(item, 30)}`,
            effect: { type: 'delete', id: item.id },
          },
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
    if (effect.type === 'daemon') {
      const st = daemon.status();
      if (st.running) { daemon.stop(); return c.warn('daemon stopped — scheduled launches will not fire'); }

      const r = daemon.start();
      // A daemon AND a run at once is not a state that should exist: they are the same role.
      // So this key does nothing here, and says why — instead of spawning a process that
      // hits the lock, dies, and leaves the GUI announcing a pid that is already gone.
      if (r.reason === daemon.RUN_IS_DRAINING) {
        return c.ok(`◆ un "kaip run" ya drena la cola (pid ${r.runner.pid})`)
          + c.muted(' — no hace falta daemon: no arranco ninguno');
      }
      if (!r.started) return c.warn(daemon.statusLine());
      return c.ok(`daemon on (pid ${r.pid})`) + c.muted(' — scheduled launches now fire on their own');
    }

    if (effect.type === 'add') {
      const v = effect.values;
      const job = addJob({
        prompt: v.prompt, at: v.when || null, target: v.target || null,
        dir: v.dir || null, perm: v.perm === 'bypass' ? null : v.perm,
      });
      const head = c.ok(`+ ${job.id}`) + ` ${jobPreview(job, 30)}`;

      // Queued, not launched. If it has a time, SOMETHING has to be up to keep that promise —
      // so make sure something is. ensure() no longer spawns a daemon when a `run` already
      // holds the lock, and what we print here is whichever of the two is really there.
      if (!job.when) return head + c.muted('  · sequential: only runs when you press "r"');

      const d = daemon.ensure();
      const when = head + c.muted(`  · ${fmt(job.when)} · `);
      if (d.reason === daemon.RUN_IS_DRAINING) {
        return when + c.ok(`lo lanza el "run" que ya corre (pid ${d.runner.pid})`);
      }
      if (d.started) return when + c.ok(`daemon started (pid ${d.pid})`);
      if (d.running) return when + c.ok(`daemon on (pid ${d.pid})`);
      return when + c.err('nada procesa la cola: NO se lanzará')
        + c.muted(' — pulsa "D"');
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
    if (effect.type === 'clear') {
      const n = clearFinished();
      return n ? c.ok(`cleared ${n} finished job(s)`) : c.muted('nothing to clear');
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
  ['── borrar ──', ''],
  ['d  UNO', 'borra SOLO el job seleccionado. Pregunta antes'],
  ['x  TODOS', 'borra TODOS los terminados de golpe (done, error, missed). Pregunta antes'],
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
  const next = state.data.daemon?.next;
  const when = next ? c.muted(' · siguiente ') + fmt(next) : c.muted(' · nada agendado');

  if (!r?.willFire) {
    return c.err('◇ nada procesa la cola')
      + c.muted(' — lo agendado NO se lanzará · "D" para armar el daemon');
  }
  if (r.kind === 'daemon') {
    return c.ok('◆ daemon activo') + c.muted(` (pid ${r.pid})`) + when;
  }
  // A run keeps the promise too — but only until that window closes, and that is the bit
  // worth saying out loud.
  return c.ok('◆ un "run" procesa la cola') + c.muted(` (pid ${r.pid})`) + when
    + c.warn('  · muere si cierras esa ventana');
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
    if (hidden > 0) out.push(c.muted(`  … ${hidden} línea${hidden === 1 ? '' : 's'} más arriba`));
    out.push(label + (shown[0] ?? '') + (shown.length === 1 ? c.accent('▏') : ''));
    shown.slice(1).forEach((l, k) => {
      const last = k === shown.length - 2;
      out.push('             ' + l + (last ? c.accent('▏') : ''));
    });
    if (wiz.buffer) out.push(c.muted(`             ${wiz.buffer.length} caracteres`));
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
  const onQueue = state.view === 'queue' && !state.wizard && !state.detail;
  const here = selected(state);

  const sweep = onQueue && (here || spent.length)
    ? ['  ' + [
      here ? c.accent('d') + c.muted(` — borrar SOLO este (${here.id})`) : null,
      spent.length ? c.accent('x') + c.muted(` — borrar los ${spent.length} TERMINADOS`) : null,
    ].filter(Boolean).join(c.muted('     '))]
    : [];

  const foot = state.confirm
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

// --- reading a launch's output ------------------------------------------------
/** The text `o` shows — same thing the `out` command prints. */
export function readOutput(id) {
  const job = loadQueue().find((j) => j.id === id);
  const file = outPath(id);
  if (!job || !fs.existsSync(file)) return c.muted(`(no output for ${id} yet — it hasn't run)`);

  const head = `── ${job.id} [${job.status}] ${jobPreview(job, 40)} ──`;
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
  reapStale();                            // and whatever a dead runner left hanging as "running"

  const stdin = process.stdin;

  // Bracketed paste goes on with raw mode and off with it. It is what lets a paste be
  // recognised as a paste instead of guessed at — and leaving it on after we exit would
  // wrap every paste in the NEXT program in markers it does not understand.
  const rawOn = () => {
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    if (process.stdout.isTTY) process.stdout.write(PASTE_ON);
  };
  const rawOff = () => {
    if (process.stdout.isTTY) process.stdout.write(PASTE_OFF);
    try { stdin.setRawMode(false); } catch { /* already closed */ }
    stdin.pause();
  };

  let state = refresh(initialState());
  let done;                               // resolved when the user quits
  let paused = null;                      // set while a pager owns the screen
  let busy = false;                       // a pager or the runner is drawing, not us
  let quitting = false;                   // once true, NOTHING may paint again

  // Every repaint goes through here, and once we are leaving, none of them do. A stray
  // frame drawn after the goodbye lands on top of it and undoes the whole exit — and there
  // are three ways in (a key, a finished effect, a terminal resize), so the guard belongs
  // at the door rather than at each of them.
  const draw = () => { if (!busy && !quitting) paint(render(state)); };

  // Suspend the GUI, hand the normal screen to `text`, wait for a key, come back.
  // writeLines, not console.log: raw mode is still on, and a bare "\n" would step the
  // text diagonally down the screen instead of returning to column 0.
  const pager = (text) => new Promise((resolve) => {
    busy = true;
    altExit();
    writeLines(text);
    writeLines(c.muted('\n(press any key to go back)'));
    paused = () => { paused = null; busy = false; altEnter(); draw(); resolve(); };
  });

  async function handle(effect) {
    switch (effect.type) {
      case 'quit':
        quitting = true;                  // from here on nothing paints, whatever fires
        done();
        return;

      case 'restart': {                   // tear the screen down and build it back clean
        rawOff();
        altExit();
        rawOn();
        altEnter();
        state = refresh({ ...state, detail: null, wizard: null, confirm: null, message: c.ok('interface restarted') });
        return;
      }

      case 'resume': {                   // walk into the real, interactive Claude Code
        let where;
        try { where = resumeTarget(effect.ref); }
        catch (e) { state = { ...state, message: c.err(e.message.split('\n')[0]) }; return; }

        busy = true;
        rawOff();
        altExit();
        writeLines(c.muted(`resuming ${where.sessionId.slice(0, 8)}… in ${where.dir}\n`));

        // stdio: 'inherit' — Claude Code takes the terminal whole, keyboard included.
        // We are just the doorway; we get the terminal back when it exits.
        await new Promise((resolve) => {
          const child = spawn('claude', ['--resume', where.sessionId], {
            cwd: where.dir, stdio: 'inherit', shell: true,
          });
          child.on('exit', resolve);
          child.on('error', (e) => {
            state = { ...state, message: c.err(`could not start claude: ${e.message}`) };
            resolve();
          });
        });

        rawOn();
        altEnter();
        busy = false;
        state = refresh(state);
        return;
      }

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

  // One chunk can carry more than one key (and a paste can span several chunks), so the
  // reader owns that stitching and hands us keys one at a time.
  const readKeys = keyReader();

  const onData = (data) => {
    for (const key of readKeys(data)) {
      if (paused) { paused(); return; }     // any key returns from the pager
      if (busy) return;                     // the runner owns the terminal; ignore
      if (quitting) return;                 // we are on our way out; do not touch the screen

      const { state: next, effect } = reduce(state, key);
      state = next;
      draw();

      // NOT `.then(draw)` unconditionally: on quit, handle() closes the GUI and prints the
      // farewell on a freshly cleared screen — and then this would paint the entire frame
      // straight back over it. That was the flash: the screen wiped itself clean and the
      // program immediately dirtied it again.
      if (effect) handle(effect).then(() => { if (!quitting) draw(); });
    }
  };

  // However we leave — q, Ctrl+C, a crash — the terminal goes back to normal.
  const restore = installCleanup(() => { rawOff(); stdin.removeListener('data', onData); goodbye(); });

  rawOn();
  stdin.on('data', onData);
  process.stdout.on('resize', draw);

  altEnter();
  draw();
  await new Promise((resolve) => { done = resolve; });

  restore();
  goodbye();          // clear + "is anything still going to happen?" — shared with `run`
}
