// What the GUI is looking at: the shape of the screen's state, and where it comes from.
//
// Pure reads. Nothing here writes to the store, launches anything or paints anything —
// which is what lets both the reducer (tui.mjs) and the renderer (tui-render.mjs) depend
// on it without depending on each other.

import { loadProjects, loadQueue, loadSessions } from './store.mjs';
import { findCutShort, resumable } from './cutshort.mjs';
import { runnerStatus } from './runner-status.mjs';
import { nextScheduledAt } from './schedule.mjs';
import { suggestDirs, suggestTargets } from './queue.mjs';

export const VIEWS = ['queue', 'sessions', 'projects', 'help'];
export const TITLES = { queue: 'Queue', sessions: 'Chats', projects: 'Projects', help: 'Help' };
export const PERMS = ['bypass', 'acceptEdits', 'default'];
export const ICON = { pending: '·', running: '▶', done: '✓', error: '✗', missed: '⊘' };

// The add/edit wizard, one step per line of a job.
// Nothing here launches anything: the wizard writes a job to the queue and stops. A job
// with a time is fired later by the daemon; one without waits for an explicit run.
export const STEPS = [
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

/**
 * Everything the screen reads off disk, in one go.
 *
 * `runner` — not `daemon`. The GUI used to ask the daemon whether it was up, which answers a
 * DIFFERENT question than the one on screen: a `kaip run` in another window drains the queue
 * exactly the same. That question now has one owner (runner-status.mjs) and everyone — this,
 * the phone, the goodbye screen — reads the same answer.
 *
 * `next` is a fact about the QUEUE, not about the daemon, so it is taken from the queue we
 * have just read rather than by asking the daemon for its own copy of it.
 */
export const loadData = () => {
  const queue = loadQueue();
  return {
    queue,
    sessions: loadSessions(),
    projects: loadProjects(),
    runner: runnerStatus(),           // who is ACTUALLY processing the queue: daemon, a run, or nobody
    next: nextScheduledAt(queue),     // when the next scheduled launch is due
  };
};

export function initialState({ offer = null } = {}) {
  return {
    view: 'queue',
    sel: 0,
    data: loadData(),
    detail: null,      // a job being shown in full
    wizard: null,      // { mode: 'add'|'edit', id, step, values, buffer }
    confirm: null,     // { text, effect }
    message: null,     // one-line feedback under the list
    // { hits: [...], sel } — conversations the quota killed, waiting to be offered.
    // Computed ONCE, when the GUI opens (startTUI), and never recomputed on a refresh:
    // an offer that reappears mid-session is an offer you learn to swat away.
    offer,
  };
}

/**
 * The conversations to offer to finish — or null, if there are none worth asking about.
 *
 * GUI ONLY. Nothing calls this from the CLI, and that is the point: without a TTY there is
 * nobody to answer the question, and a tool that asks anyway just prints noise into a log.
 * Never throws: a broken transcript must not be the reason `kaip` won't open.
 */
export function openOffer() {
  try {
    const hits = findCutShort().filter(resumable);
    return hits.length ? { hits, sel: 0 } : null;
  } catch { return null; }
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
