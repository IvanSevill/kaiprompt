// A job's prompt can be the text itself, or a LINK to a file that holds it.
//
// The difference is when the text is read. `--file` reads it at queue time and stores a
// copy: a snapshot. `--from` stores the *path*, and the file is read at LAUNCH time — so
// you can keep sharpening the prompt right up to the second it goes out, and whatever the
// file says at 03:00 is what gets sent.
//
// That is what makes the /prompt skill useful: it writes a file, and you queue the file.

import fs from 'node:fs';
import path from 'node:path';

/** A job whose text lives in a file rather than in the queue. */
export const isLinked = (job) => Boolean(job?.promptFile);

/**
 * What a quota-killed launch is told when it comes back.
 *
 * NOT the original prompt again. The session is resumed, so Claude already has the whole
 * conversation and whatever work it managed to do — re-sending the brief would make it read
 * everything a second time and start over from the top, paying for the context twice and
 * quite possibly undoing what it had already finished.
 *
 * It only needs to be told that the interruption is over.
 */
export const CONTINUATION = [
  'Carry on from where you left off.',
  '',
  'The quota ran out halfway through the work and has now come back. This is the same',
  'conversation: you already have the context and whatever you had done. Do NOT start over',
  'or redo what is already done — check where you got to and carry on from there.',
].join('\n');

/**
 * A job that got cut off mid-launch and has a session to go back to.
 *
 * The session is what makes the difference: without one, the launch never really started
 * and the original prompt is still the right thing to send.
 */
export const isContinuation = (job) => Boolean(job?.continuation && job?.sessionId);

/**
 * The text this job will actually send.
 *
 * A missing or empty file is a HARD error, never an empty prompt. An unattended launch
 * runs with full autonomy in a real project — handing it a blank instruction and letting
 * it improvise is the worst thing this tool could do.
 */
export function resolvePrompt(job) {
  if (!isLinked(job)) {
    const text = String(job?.prompt ?? '').trim();
    if (!text) throw new Error('the job has no prompt');
    return text;
  }

  const file = job.promptFile;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `the prompt file is gone: ${file}\n`
      + `  (${e.code === 'ENOENT' ? 'it does not exist' : e.message})\n`
      + '  nothing was launched. Point the job at a file that exists: '
      + `kaip edit ${job.id ?? '<id>'} --from <path>`
    );
  }

  if (!text.trim()) {
    throw new Error(
      `the prompt file is empty: ${file}\n`
      + '  nothing was launched — an empty prompt would let an unattended launch improvise.'
    );
  }
  return text.trim();
}

/** Validate a --from path at queue time, so a typo surfaces now and not at 3am. */
export function linkPrompt(file) {
  const abs = path.resolve(String(file ?? '').trim());
  if (!fs.existsSync(abs)) throw new Error(`no such prompt file: ${abs}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${abs}`);
  if (!fs.readFileSync(abs, 'utf8').trim()) throw new Error(`the prompt file is empty: ${abs}`);
  return abs;
}

/**
 * One line for a list. For a linked job this reads the file, so what you see is what
 * WILL be sent — not a stale copy. A file that has gone missing shows up as a warning
 * here, which is how you find out before 3am rather than after.
 */
export function jobPreview(job, n = 60) {
  let text;
  try { text = resolvePrompt(job); }
  catch { return isLinked(job) ? `⚠ ${path.basename(job.promptFile)} — unreadable` : ''; }

  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const t = first.replace(/\s+/g, ' ').trim();
  const cut = t.length > n ? t.slice(0, n - 1) + '…' : t;
  return isLinked(job) ? `↪ ${cut}` : cut;      // ↪ = it comes from a file
}
