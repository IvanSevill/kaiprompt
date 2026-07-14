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
import { claudeModels, discoverCodexModels, discoverOpenCodeModels, engineNames } from './engines.mjs';
import { aggregateUsage } from './usage.mjs';

export const VIEWS = ['queue', 'sessions', 'projects', 'usage', 'help'];
export const TITLES = { queue: 'Queue', sessions: 'Chats', projects: 'Projects', usage: 'Usage', help: 'Help' };
export const PERMS = ['bypass', 'acceptEdits', 'default'];
export const ICON = { pending: '·', running: '▶', done: '✓', error: '✗', missed: '⊘' };

// The add/edit wizard, one step per line of a job.
// Nothing here launches anything: the wizard writes a job to the queue and stops. A job
// with a time is fired later by the daemon; one without waits for an explicit run.
export const STEPS = [
  { key: 'prompt', label: 'Prompt', hint: 'write the prompt · ←/→ switches to a prompt file' },
  { key: 'when', label: 'When', hint: 'HH:MM · +2h · "tomorrow 09:00" — empty = only on a manual run' },
  // The two steps with suggestions. Reusing a target is the biggest token saving there
  // is — the launch resumes a conversation that already has the context loaded — so the
  // ones you already have are offered right there instead of made you remember them.
  {
    key: 'target',
    label: 'Target',
    hint: '←→ pick a conversation to continue (cheaper: context already loaded) · or type a new name',
    suggest: () => suggestTargets().map((t) => ({
      value: t.target,
      note: t.upcoming ? 'queued, no session yet' : `session ${String(t.sessionId).slice(0, 8)}… · ${t.jobs} job(s)`,
    })),
  },
  {
    key: 'dir',
    label: 'Folder',
    hint: '←→ pick a project you already use · or type a path · empty = current folder',
    suggest: () => suggestDirs().map((d) => ({ value: d.dir, note: d.label || '' })),
  },
  { key: 'engine', label: 'Engine', hint: '← → to choose; every launch names its engine', choices: engineNames() },
  { key: 'provider', label: 'Provider', hint: 'required only for OpenCode (for example: google)', },
  { key: 'model', label: 'Model', hint: '←→ pick an available model · optional for Claude/Codex; required for OpenCode', },
  { key: 'perm', label: 'Permissions', hint: '← → to choose', choices: PERMS },
];

export const ENGINE_STEPS = STEPS.filter((step) => ['engine', 'provider', 'model'].includes(step.key));

/** Provider is an OpenCode concept; it must not occupy a field for Claude or Codex. */
export function visibleWizardSteps(wiz) {
  const steps = wiz.steps || STEPS;
  return steps.filter((step) => step.key !== 'provider' || wiz.values.engine === 'opencode');
}

/** Choices which depend on the engine and provider selected earlier in the wizard. */
export function wizardChoices(step, values) {
  if (step.key === 'provider') {
    if (values.engine !== 'opencode') return [];
    return [...new Set(discoverOpenCodeModels().map((m) => m.provider))];
  }
  if (step.key === 'model') {
    if (values.engine === 'claude') return claudeModels();
    if (values.engine === 'codex') return discoverCodexModels();
    if (values.engine !== 'opencode' || !values.provider) return [];
    const models = discoverOpenCodeModels(values.provider).map((m) => m.model);
    if (values.provider === 'openai') {
      const preferred = 'gpt-5.6-terra';
      return models.includes(preferred) ? [preferred, ...models.filter((model) => model !== preferred)] : models;
    }
    return models;
  }
  return step.choices || [];
}

/** A selected provider/model is a value, not a filter. Partial typed text is a filter. */
export function visibleWizardChoices(step, values, buffer = '') {
  const all = wizardChoices(step, values);
  const query = String(buffer).trim();
  if (!query || all.includes(query)) return all;
  return all.filter((choice) => choice.toLowerCase().includes(query.toLowerCase()));
}

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
export function usageScopes(report) {
  const providers = [...new Set(report.sessions
    .filter((row) => row.engine === 'opencode' && row.provider)
    .map((row) => row.provider))].sort();
  return [
    { key: 'claude', label: 'Claude', filters: { engine: 'claude' } },
    { key: 'codex', label: 'Codex', filters: { engine: 'codex' } },
    ...providers.map((provider) => ({ key: `opencode:${provider}`, label: `OpenCode / ${provider}`, filters: { engine: 'opencode', provider } })),
  ];
}

export const usageReport = (state) =>
  state.data.usageReports[state.usageScope] ?? state.data.usageReports.claude;

export const loadData = () => {
  const queue = loadQueue();
  const allUsage = aggregateUsage();
  const scopes = usageScopes(allUsage);
  return {
    queue,
    sessions: loadSessions(),
    projects: loadProjects(),
    runner: runnerStatus(),           // who is ACTUALLY processing the queue: daemon, a run, or nobody
    next: nextScheduledAt(queue),     // when the next scheduled launch is due
    usageScopes: scopes,
    usageReports: Object.fromEntries(scopes.map((scope) => [scope.key, aggregateUsage(scope.filters)])),
  };
};

export function initialState({ offer = null } = {}) {
  return {
    view: 'queue',
    usageScope: 'claude',
    sel: 0,
    data: loadData(),
    detail: null,      // { job, scroll } — a job being shown in full
    update: null,      // latest release, populated asynchronously by the GUI
    wizard: null,      // { mode: 'add'|'edit', id, step, values, buffer }
    confirm: null,     // { text, effect }
    message: null,     // one-line feedback under the list
    selectedIds: [],   // pending queue jobs selected for a bulk engine change
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
