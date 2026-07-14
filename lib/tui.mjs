// The guided GUI: `kaip` with no arguments.
//
// Split so it can be tested without a terminal, each part with one job:
//   tui-keys.mjs    raw stdin bytes → a key name
//   tui-state.mjs   what the screen is looking at, and where it is read from
//   tui-render.mjs  state → the lines to paint               — pure
//   this file       reduce (pure) + applyEffect / startTUI   — where the IO actually happens
//
// It grew to a thousand lines with all four tangled together, which meant you could not
// look at the key handling without scrolling past the wizard's layout. The public surface is
// unchanged — everything is re-exported below — so nothing that imports from here had to move.
//
// Every mutation goes through lib/queue.mjs and lib/edit.mjs: the GUI is another
// front-end for the existing commands, not a second implementation of them.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { loadLaunchDefaults, loadQueue, outPath, saveLaunchDefaults } from './store.mjs';
import { fmt, parseWhen } from './time.mjs';
import { dismiss, resumeCutShort } from './cutshort.mjs';
import { addJob, clearFinished, removeJobs, retryJob } from './queue.mjs';
import { editJob } from './edit.mjs';
import { renderChat, resumeTarget } from './chat.mjs';
import { jobPreview } from './prompt.mjs';
import { goodbye } from './goodbye.mjs';
import { reapStale, runQueue } from './runner.mjs';
import * as daemon from './daemon.mjs';
import {
  altEnter, altExit, c, installCleanup, isTTY, paint, size, writeLines,
} from './ui.mjs';

import { keyReader, pasteText, PASTE_OFF, PASTE_ON } from './tui-keys.mjs';
import { ENGINE_STEPS, initialState, openOffer, refresh, rows, selected, STEPS, VIEWS, visibleWizardChoices, visibleWizardSteps, wizardChoices } from './tui-state.mjs';
import { detailMaxScroll, render } from './tui-render.mjs';

// The public surface, unchanged: the GUI is `lib/tui.mjs` to everyone outside it.
export { asPaste, decodeKey, keyReader, pasteText, PASTE_END, PASTE_OFF, PASTE_ON, PASTE_START } from './tui-keys.mjs';
export { initialState, loadData, openOffer, refresh, rows, selected, VIEWS } from './tui-state.mjs';
export { render } from './tui-render.mjs';

// --- the wizard --------------------------------------------------------------
const wizardFor = (mode, job, ids = []) => {
  const defaults = mode === 'add' && !job ? loadLaunchDefaults() : {};
  return ({
  mode,
  id: job?.id ?? null,
  step: 0,
  values: {
    prompt: job?.prompt ?? '',
    from: job?.promptFile ?? '',
    when: job?.when ? new Date(job.when).toISOString().slice(0, 16) : '',
    target: job?.target ?? '',
    dir: job?.dir ?? '',
    engine: job?.adapter ?? defaults.engine ?? 'claude',
    provider: job?.provider ?? defaults.provider ?? '',
    model: job?.model ?? defaults.model ?? '',
    perm: job?.permMode ?? defaults.perm ?? 'bypass',
  },
  promptMode: job?.promptFile ? 'file' : 'text',
  buffer: job?.promptFile ?? job?.prompt ?? '',
  ids,
  steps: mode === 'bulk-engine' ? ENGINE_STEPS : STEPS,
  });
};

function wizardBuffer(wiz, step) {
  if (step.key === 'prompt') return wiz.promptMode === 'file' ? wiz.values.from : wiz.values.prompt;
  return String(wiz.values[step.key] ?? '');
}

function saveWizardBuffer(wiz, step) {
  if (step.choices) return wiz;
  const raw = wiz.buffer.trim();
  let values = step.key === 'prompt'
    ? wiz.promptMode === 'file' ? { ...wiz.values, prompt: '', from: raw } : { ...wiz.values, prompt: raw, from: '' }
    : { ...wiz.values, [step.key]: raw };
  if (step.key === 'provider' && raw !== wiz.values.provider) values = { ...values, model: '' };
  return { ...wiz, values };
}

function wizardError(wiz) {
  const values = wiz.values;
  if (wiz.mode !== 'bulk-engine' && !(values.prompt || values.from)) return { key: 'prompt', text: 'the prompt cannot be empty' };
  if (values.when) {
    try { parseWhen(values.when); }
    catch (e) { return { key: 'when', text: e.message }; }
  }
  if (values.engine === 'opencode' && !values.provider) return { key: 'provider', text: 'choose or type an OpenCode provider' };
  if (values.engine === 'opencode' && !values.model) return { key: 'model', text: 'choose or type an OpenCode model' };
  return null;
}

/** Form keys: ↑↓ field, ←→ option, Enter validate/create, Esc cancel. */
function reduceWizard(state, key) {
  const wiz = state.wizard;
  const steps = visibleWizardSteps(wiz);
  const step = steps[wiz.step];
  const keep = (over) => ({ state: { ...state, message: null, ...over }, effect: null });

  if (key === 'esc') return { state: { ...state, wizard: null, message: 'cancelled' }, effect: null };

  if ((key === 'left' || key === 'right') && step.key === 'prompt') {
    const promptMode = wiz.promptMode === 'file' ? 'text' : 'file';
    return keep({
      wizard: { ...wiz, promptMode, pick: null, buffer: promptMode === 'file' ? wiz.values.from : wiz.values.prompt },
    });
  }

  const allChoices = wizardChoices(step, wiz.values);
  const dynamicChoice = step.key === 'provider' || step.key === 'model';
  const choices = dynamicChoice ? visibleWizardChoices(step, wiz.values, wiz.buffer) : allChoices;
  const choiceStep = step.choices || (dynamicChoice && choices.length);
  if (choiceStep) {
    const current = step.choices ? wiz.values[step.key] : wiz.buffer;
    const i = choices.indexOf(current);
    if (key === 'left') {
      const v = choices[i < 0 ? choices.length - 1 : (i - 1 + choices.length) % choices.length];
      return keep({ wizard: selectedWizardValue(wiz, step, v) });
    }
    if (key === 'right') {
      const v = choices[i < 0 ? 0 : (i + 1) % choices.length];
      return keep({ wizard: selectedWizardValue(wiz, step, v) });
    }
  }

  // Suggestions use ←→ too; ↑↓ always means moving between form fields.
  if (step.suggest && (key === 'left' || key === 'right')) {
    const list = step.suggest();
    if (!list.length) return { state, effect: null };
    const at = wiz.pick ?? -1;
    const next = key === 'right'
      ? (at + 1) % list.length
      : (at - 1 + list.length) % list.length;
    return keep({ wizard: { ...wiz, pick: next, buffer: list[next].value } });
  }

  if (key === 'up' || key === 'down') {
    const saved = saveWizardBuffer(wiz, step);
    const next = key === 'down'
      ? (wiz.step + 1) % steps.length
      : (wiz.step - 1 + steps.length) % steps.length;
    return keep({ wizard: { ...saved, step: next, pick: null, buffer: wizardBuffer(saved, steps[next]) } });
  }

  if (key === 'enter') {
    const saved = saveWizardBuffer(wiz, step);
    const invalid = wizardError(saved);
    if (invalid) {
      const at = steps.findIndex((candidate) => candidate.key === invalid.key);
      const next = at < 0 ? saved.step : at;
      return {
        state: { ...state, message: c.err(invalid.text), wizard: { ...saved, step: next, pick: null, buffer: wizardBuffer(saved, steps[next]) } },
        effect: null,
      };
    }
    const effect = saved.mode === 'add'
      ? { type: 'add', values: saved.values }
      : saved.mode === 'bulk-engine' ? { type: 'bulk-engine', ids: saved.ids, values: saved.values } : { type: 'edit', id: saved.id, values: saved.values };
    return { state: { ...state, wizard: null }, effect };
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

function selectedWizardValue(wiz, step, value) {
  if (step.key === 'provider' || step.key === 'model') {
    return { ...wiz, pick: null, buffer: value };
  }
  const values = { ...wiz.values, [step.key]: value };
  if (step.key === 'engine') {
    values.provider = '';
    values.model = '';
  }
  return { ...wiz, values };
}

// --- the state machine -------------------------------------------------------
/** (state, key) → the next state and, at most, one effect for the caller to run. */
export function reduce(state, key) {
  const msg = (m) => ({ state: { ...state, message: m }, effect: null });
  const none = { state, effect: null };

  if (key === 'ctrl-c') return { state, effect: { type: 'quit' } };

  // The offer owns the keyboard while it is up: it is a question, and enter/esc mean
  // different things here than anywhere else. `q` still quits — a question you cannot walk
  // away from is a trap, not an offer.
  if (state.offer) {
    const { hits, sel } = state.offer;
    const hit = hits[sel];

    // Answered — either way, this one is off the list. "Yes" queues it (and the queue itself
    // is what keeps it from being re-offered); "no" silences it for good.
    const answered = (effect) => {
      const left = hits.filter((h) => h.sessionId !== hit.sessionId);
      return {
        state: { ...state, offer: left.length ? { hits: left, sel: 0 } : null },
        effect,
      };
    };

    if (key === 'q') return { state, effect: { type: 'quit' } };
    if (key === 'up') return { state: { ...state, offer: { hits, sel: Math.max(0, sel - 1) } }, effect: null };
    if (key === 'down') {
      return { state: { ...state, offer: { hits, sel: Math.min(hits.length - 1, sel + 1) } }, effect: null };
    }
    if (key === 'enter') return answered({ type: 'resume-cut', hit });
    if (key === 'esc') return answered({ type: 'dismiss-cut', hit });
    return none;
  }

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
    if (key === 't' && state.detail.job.status === 'error') {
      return { state: { ...state, detail: null }, effect: { type: 'retry', id: state.detail.job.id } };
    }
    if (key === 'up') return { state: { ...state, detail: { ...state.detail, scroll: Math.max(0, state.detail.scroll - 1) } }, effect: null };
    if (key === 'down') return { state: { ...state, detail: { ...state.detail, scroll: Math.min(detailMaxScroll(state.detail, size()), state.detail.scroll + 1) } }, effect: null };
    return none;
  }

  // --- navigation ---
  const list = rows(state);
  const view = (v) => ({ state: { ...state, view: v, sel: 0, message: null }, effect: null });

  if (key === 'q') return { state, effect: { type: 'quit' } };
  if (key === '?') return view('help');
  if (key === 'u') return view('usage');
  if (key >= '1' && key <= String(VIEWS.length)) return view(VIEWS[Number(key) - 1]);
  if (state.view === 'usage' && (key === 'up' || key === 'down')) {
    const scopes = state.data.usageScopes;
    const index = Math.max(0, scopes.findIndex((scope) => scope.key === state.usageScope));
    const step = key === 'down' ? 1 : -1;
    return { state: { ...state, usageScope: scopes[(index + step + scopes.length) % scopes.length].key, message: null }, effect: null };
  }
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
        // Say ALL, and say how many. "clear N finished job(s)?" reads like it might be
        // clearing the one you have selected, which is what `d` does — and the difference
        // between those two keys is the whole queue.
        confirm: {
          text: `delete the ${spent.length} finished jobs? (ALL of them)`,
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
  if (key === 'y' && item && item.sessionId && item.status !== 'running') {
    const ref = state.view === 'sessions' ? item.target : item.id;
    return { state, effect: { type: 'resume', ref } };
  }

  if (state.view === 'sessions' && item) {
    if (key === 'enter' || key === 'c') return { state, effect: { type: 'chat', ref: item.target } };
  }

  if (state.view !== 'queue' || !item) {
    if (['e', 'd', 'o', 'c', 'i', 'enter'].includes(key)) return msg(c.muted('nothing selected'));
    return none;
  }

  if (key === 'space') {
    if (item.status !== 'pending') return msg(c.warn('only pending jobs can be selected'));
    const selectedIds = state.selectedIds.includes(item.id)
      ? state.selectedIds.filter((id) => id !== item.id)
      : [...state.selectedIds, item.id];
    return { state: { ...state, selectedIds, message: null }, effect: null };
  }
  if (key === 'm') {
    const ids = state.selectedIds.length ? state.selectedIds : (item.status === 'pending' ? [item.id] : []);
    if (!ids.length) return msg(c.warn('select pending jobs with space first'));
    return { state: { ...state, wizard: wizardFor('bulk-engine', null, ids), message: null }, effect: null };
  }

  // --- the queue view, on the selected job ---
  switch (key) {
    case 'enter':
    case 'i':
      return { state: { ...state, detail: { job: item, scroll: 0 } }, effect: null };
    case 'e':
      if (item.status !== 'pending' && item.status !== 'missed') {
        return msg(c.err(`job is ${item.status}: only pending (or missed) jobs can be edited`));
      }
      return { state: { ...state, wizard: wizardFor('edit', item), message: null }, effect: null };
    case 'd':
      return {
        state: {
          ...state,
          // "ONLY this one" spelled out, because the other delete key is one row away and
          // takes the entire finished half of the queue.
          confirm: {
            text: `delete ONLY this job? ${item.id} — ${jobPreview(item, 30)}`,
            effect: { type: 'delete', id: item.id },
          },
        },
        effect: null,
      };
    case 'o':
      if (!['done', 'error'].includes(item.status)) return msg(c.muted('output is available after the job finishes'));
      return { state, effect: { type: 'out', id: item.id } };
    case 'c':
      if (!['done', 'error'].includes(item.status)) return msg(c.muted('conversation is available after the job finishes'));
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
        return c.ok(`◆ a "kaip run" is already draining the queue (pid ${r.runner.pid})`)
          + c.muted(' — no daemon needed: none started');
      }
      if (!r.started) return c.warn(daemon.statusLine());
      return c.ok(`daemon on (pid ${r.pid})`) + c.muted(' — scheduled launches now fire on their own');
    }

    if (effect.type === 'add') {
      const v = effect.values;
      const job = addJob({
        prompt: v.from ? null : v.prompt, from: v.from || null, at: v.when || null, target: v.target || null,
        dir: v.dir || null, perm: v.perm === 'bypass' ? null : v.perm,
        adapter: v.engine || 'claude', provider: v.provider || null, model: v.model || null,
      });
      saveLaunchDefaults({ engine: job.adapter, provider: job.provider, model: job.model, perm: v.perm || 'bypass' });
      const head = c.ok(`+ ${job.id}`) + ` ${jobPreview(job, 30)}`;

      // Queued, not launched. If it has a time, SOMETHING has to be up to keep that promise —
      // so make sure something is. ensure() no longer spawns a daemon when a `run` already
      // holds the lock, and what we print here is whichever of the two is really there.
      if (!job.when) return head + c.muted('  · sequential: only runs when you press "r"');

      const d = daemon.ensure();
      const when = head + c.muted(`  · ${fmt(job.when)} · `);
      if (d.reason === daemon.RUN_IS_DRAINING) {
        return when + c.ok(`the "run" already up will fire it (pid ${d.runner.pid})`);
      }
      if (d.started) return when + c.ok(`daemon started (pid ${d.pid})`);
      if (d.running) return when + c.ok(`daemon on (pid ${d.pid})`);
      return when + c.err('nothing is processing the queue: it will NOT fire')
        + c.muted(' — press "D"');
    }
    if (effect.type === 'edit') {
      const v = effect.values;
      // An emptied field means "clear it" — that's what edit.mjs reads as "none".
      const edit = {
        prompt: v.prompt,
        at: v.when || 'none',
        target: v.target || 'none',
        dir: v.dir || 'none',
        perm: v.perm,
      };
      if (v.from != null) edit.from = v.from || 'none';
      if (v.engine != null) edit.engine = v.engine;
      if (v.provider != null) edit.provider = v.provider || null;
      if (v.model != null) edit.model = v.model || 'none';
      const { job, changes } = editJob(effect.id, edit);
      return c.ok(`✎ ${job.id}`) + c.muted(` updated: ${changes.join(', ')}`);
    }
    if (effect.type === 'bulk-engine') {
      const v = effect.values;
      for (const id of effect.ids) editJob(id, { engine: v.engine, provider: v.provider || null, model: v.model || 'none' });
      return c.ok(`✎ ${effect.ids.length} job(s)`) + c.muted(` engine: ${v.engine}${v.provider ? '/' + v.provider : ''}${v.model ? '/' + v.model : ''}`);
    }
    // Yes: finish that conversation. It goes in as a continuation — same session, no prompt
    // re-sent — and it goes FIRST: it is already half-done and its context is already paid for.
    if (effect.type === 'resume-cut') {
      const job = resumeCutShort(effect.hit);
      const head = c.ok(`+ ${job.id}`) + c.muted(` continues ${effect.hit.sessionId.slice(0, 8)}… · `)
        + c.bold('first in line');

      // Same honesty as `add`: queued is not launched. With no time on it, it needs SOMEONE
      // draining the queue, and if that is nobody it will sit there — so say which it is.
      const d = daemon.ensure();
      if (d.reason === daemon.RUN_IS_DRAINING) return head + c.muted(` · the "run" in progress will fire it (pid ${d.runner.pid})`);
      if (d.started || d.running) return head + c.muted(` · as soon as there is quota (daemon pid ${d.pid})`);
      return head + c.err(' · nothing is processing the queue: it will NOT fire') + c.muted(' — press "D"');
    }

    // No. And never again for this one: a question that comes back is a question you stop
    // reading, and then it is worth nothing on the day it actually matters.
    if (effect.type === 'dismiss-cut') {
      dismiss(effect.hit.sessionId);
      return c.muted(`right — I won't ask about ${effect.hit.sessionId.slice(0, 8)}… again`);
    }

    if (effect.type === 'delete') {
      const n = removeJobs([effect.id]);
      return n ? c.ok(`removed ${effect.id}`) : c.err('nothing removed');
    }
    if (effect.type === 'retry') {
      const job = retryJob(effect.id);
      return c.ok(`↻ ${job.id}`) + c.muted(' pending again; it keeps its existing session');
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

  reapStale();                            // whatever a dead runner left hanging as "running"

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

  // The offer is built HERE and nowhere else: inside the GUI, once, with a person in front of
  // it. Nothing on the CLI path ever calls openOffer, so without a TTY kaip behaves exactly as
  // it did before — there is nobody there to answer a question, and asking anyway is noise.
  let state = refresh(initialState({ offer: openOffer() }));
  let done;                               // resolved when the user quits
  let paused = null;                      // set while a pager owns the screen
  let busy = false;                       // a pager or the runner is drawing, not us
  let quitting = false;                   // once true, NOTHING may paint again

  // Every repaint goes through here, and once we are leaving, none of them do. A stray
  // frame drawn after the goodbye lands on top of it and undoes the whole exit — and there
  // are three ways in (a key, a finished effect, a terminal resize), so the guard belongs
  // at the door rather than at each of them.
  const draw = () => { if (!busy && !quitting) paint(render(state)); };

  // Network failures are deliberately invisible: this is a convenience, never a startup dependency.
  import('./update.mjs').then(({ checkVersion }) => checkVersion()).then((update) => {
    if (update && !quitting) { state = { ...state, update }; draw(); }
  }).catch(() => {});

  // Jobs can arrive from another terminal while this GUI stays open. Re-read the small local
  // data files often enough to show them promptly, but never repaint over a pager or runner.
  const refreshTimer = setInterval(() => {
    if (paused || busy || quitting) return;
    state = refresh(state);
    draw();
  }, 2000);

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

        // `run` owns the terminal until it finishes, and its cleanup has already printed the
        // farewell. Returning to the GUI would immediately hide that farewell behind another
        // alternate screen, so close this TUI too.
        quitting = true;
        done();
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
  const restore = installCleanup(() => {
    clearInterval(refreshTimer);
    rawOff();
    stdin.removeListener('data', onData);
    goodbye();
  });

  rawOn();
  stdin.on('data', onData);
  process.stdout.on('resize', draw);

  altEnter();
  draw();
  await new Promise((resolve) => { done = resolve; });

  restore();
  goodbye();          // clear + "is anything still going to happen?" — shared with `run`
}
