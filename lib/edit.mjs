// Edit a job that hasn't run yet.
//
// Only `pending` jobs can be edited: a running job is already in the adapter's hands,
// and a finished one is history — rewriting either would make the queue lie.

import fs from 'node:fs';
import path from 'node:path';

import { ADAPTERS, loadQueue, patchJob, resolveDir } from './store.mjs';
import { parseWhen } from './time.mjs';
import { linkPrompt } from './prompt.mjs';

export const EDITABLE = ['prompt', 'from', 'at', 'target', 'dir', 'perm', 'adapter'];
const PERM_MODES = ['bypass', 'acceptEdits', 'default'];
const CLEARS = ['none', 'null', '-'];                 // --target none → back to no target

/** A flag the user wrote as `--target` with nothing after it has no value to apply. */
function value(flags, key) {
  const v = flags[key];
  if (v === true) throw new Error(`--${key} needs a value (e.g. --${key} something)`);
  return typeof v === 'string' ? v.trim() : null;
}

/** Apply the given flags to a copy of `job`. Returns the new job + what changed. */
export function applyEdits(job, flags = {}) {
  const next = { ...job };
  const changes = [];
  const set = (key, val) => { changes.push(key); next[key] = val; };

  // --prompt and --from are the two ways a job can get its text, and a job has exactly
  // one of them: setting either clears the other, or the job would carry a stale copy
  // alongside the link and you would not know which one actually goes out.
  if ('prompt' in flags) {
    const v = value(flags, 'prompt');
    if (!v) throw new Error('--prompt cannot be empty');
    set('prompt', v);
    if (next.promptFile) set('promptFile', null);
  }

  if ('from' in flags) {
    const v = value(flags, 'from');
    if (CLEARS.includes(String(v).toLowerCase())) {
      if (!next.prompt) throw new Error('--from none would leave the job with no prompt at all');
      set('promptFile', null);
    } else {
      set('promptFile', linkPrompt(v));
      if (next.prompt) set('prompt', null);
    }
  }

  if ('at' in flags) {
    const v = value(flags, 'at');
    set('when', CLEARS.includes(String(v).toLowerCase()) ? null : parseWhen(v));
  }

  if ('target' in flags) {
    const v = value(flags, 'target');
    set('target', CLEARS.includes(String(v).toLowerCase()) ? null : v);
  }

  if ('dir' in flags) {
    const v = value(flags, 'dir');
    set('dir', CLEARS.includes(String(v).toLowerCase()) ? null : resolveDir(v, job.dir));
  }

  if ('perm' in flags) {
    const v = value(flags, 'perm');
    if (CLEARS.includes(String(v).toLowerCase())) set('permMode', null);           // null → bypass
    else if (!PERM_MODES.includes(v)) throw new Error(`unknown --perm "${v}". Use: ${PERM_MODES.join(' | ')}`);
    else set('permMode', v);
  }

  if ('adapter' in flags) {
    const v = value(flags, 'adapter');
    if (!fs.existsSync(path.join(ADAPTERS, `${v}.mjs`))) {
      throw new Error(`unknown adapter: "${v}" (check the adapters/ folder)`);
    }
    set('adapter', v);
  }

  return { job: next, changes };
}

/** Edit job `id` in the queue and persist it. */
export function editJob(id, flags = {}) {
  if (!id) throw new Error('usage: kaip edit <id> [--prompt …] [--at …] [--target …] [--dir …] [--perm …] [--adapter …]');

  const job = loadQueue().find((j) => j.id === id);
  if (!job) throw new Error(`no job found with id "${id}" (see: kaip list)`);
  // A missed job never ran, so there is nothing to rewrite — and giving it a new time is
  // exactly how you recover one. That makes it editable, unlike running/done/error.
  if (job.status !== 'pending' && job.status !== 'missed') {
    throw new Error(`job "${id}" is ${job.status}: only pending (or missed) jobs can be edited.\n`
      + `  its result: kaip out ${id}`);
  }

  const { job: next, changes } = applyEdits(job, flags);
  if (!changes.length) {
    throw new Error(`nothing to change. Pass at least one of: ${EDITABLE.map((f) => '--' + f).join(' ')}`);
  }

  // Rescheduling a missed launch puts it back in the queue; that's the whole point.
  if (job.status === 'missed' && changes.includes('when')) {
    next.status = 'pending';
    delete next.error;
    delete next.finishedAt;
  }

  next.editedAt = Date.now();
  patchJob(next);
  return { job: next, changes };
}
