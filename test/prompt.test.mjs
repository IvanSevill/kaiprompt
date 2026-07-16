// A prompt can be the text itself, or a LINK to a file that holds it.
//
// The difference is WHEN it is read. --file copies the contents in at queue time (a snapshot).
// --from stores the PATH, and the file is read at LAUNCH: so you can keep polishing the prompt
// right up to the second it goes out, and whatever the file says at 03:00 is what gets sent.
// That is what makes the /prompt skill useful: it writes a file, and you queue the file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prompt-'));
process.env.KAIP_HOME = TMP;
const { loadQueue, saveQueue } = await import('../src/storage/repositories.mjs');
const { addJob } = await import('../src/core/jobs.mjs');
const { editJob } = await import('../src/core/edit.mjs');
const { executeJob } = await import('../src/runner/index.mjs');
const { isLinked, jobPreview, linkPrompt, resolvePrompt } = await import('../src/core/prompt.mjs');

const write = (name, body) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, body);
  return f;
};

// --- linking -----------------------------------------------------------------
test('addJob --from: stores the PATH, not the text', () => {
  saveQueue([]);
  const f = write('p1.md', 'run the tests');
  const j = addJob({ from: f, adapter: 'mock' });

  assert.equal(j.promptFile, path.resolve(f));
  assert.equal(j.prompt, null, 'the text is NOT copied: it is read at launch');
  assert.ok(isLinked(j));
});

test('addJob --from: a path that does not exist is refused AT QUEUE TIME (not at 3am)', () => {
  assert.throws(() => addJob({ from: path.join(TMP, 'does-not-exist.md') }), /no such prompt file/);
});

test('addJob --from: an empty file is refused at queue time', () => {
  const f = write('empty.md', '   \n  ');
  assert.throws(() => addJob({ from: f }), /empty/i);
});

test('linkPrompt: returns an ABSOLUTE path (the job may run from another folder)', () => {
  const f = write('abs.md', 'x');
  assert.ok(path.isAbsolute(linkPrompt(f)));
});

// --- the point of it: it is read at LAUNCH -----------------------------------
test('the file is read when it RUNS, not when queued: editing it afterwards changes what is sent', async () => {
  saveQueue([]);
  const f = write('live.md', 'old version');
  const j = addJob({ from: f, adapter: 'mock' });

  fs.writeFileSync(f, 'NEW VERSION');            // you polish it right before it goes out

  assert.equal(resolvePrompt(j), 'NEW VERSION', 'it sends what the file says NOW');

  await executeJob(j);
  assert.equal(j.status, 'done');
  const out = fs.readFileSync(path.join(TMP, 'out', `${j.id}.txt`), 'utf8');
  assert.match(out, /NEW VERSION/, 'and that is what really reached the adapter');
});

test('an ordinary prompt (pasted text) still works exactly as before', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'good old plain text', adapter: 'mock' });
  assert.equal(isLinked(j), false);
  assert.equal(resolvePrompt(j), 'good old plain text');
  await executeJob(j);
  assert.equal(j.status, 'done');
});

// --- what may never happen ---------------------------------------------------
// An unattended launch runs with full autonomy in a real project. Handing it a blank prompt
// and letting it improvise is the worst thing this tool could do. So if the file is not
// there, NOTHING is launched.

test('if the file DISAPPEARS before launch, nothing is sent: a clear error', async () => {
  saveQueue([]);
  const f = write('gets-deleted.md', 'something');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  await assert.rejects(() => executeJob(j), /prompt file is gone/i);
  assert.ok(!fs.existsSync(path.join(TMP, 'out', `${j.id}.txt`)), 'it never gets as far as running');
});

test('if the file is EMPTIED before launch, nothing is sent either', async () => {
  saveQueue([]);
  const f = write('gets-emptied.md', 'something');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.writeFileSync(f, '');

  await assert.rejects(() => executeJob(j), /empty/i);
});

test('the error says HOW to fix it (point the job at another file)', async () => {
  const f = write('tmp2.md', 'something');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);
  await assert.rejects(() => executeJob(j), /kaip edit/);
});

// --- seeing it in the queue ---------------------------------------------------
test('jobPreview: for a linked job it shows what the file says NOW, marked with ↪', () => {
  const f = write('prev.md', 'first line\nsecond');
  const j = addJob({ from: f, adapter: 'mock' });
  assert.match(jobPreview(j), /^↪ first line/);

  fs.writeFileSync(f, 'it has changed');
  assert.match(jobPreview(j), /it has changed/, 'it does not keep a stale copy');
});

test('jobPreview: a file that is gone shows as a WARNING in the list (you find out early)', () => {
  const f = write('broken.md', 'x');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);
  assert.match(jobPreview(j), /⚠.*unreadable/);
});

// --- editing -------------------------------------------------------------------
test('edit --from: repoints a job at another file', () => {
  saveQueue([]);
  const a = write('a.md', 'file A');
  const b = write('b.md', 'file B');
  const j = addJob({ from: a, adapter: 'mock' });

  const { job } = editJob(j.id, { from: b });
  assert.equal(job.promptFile, path.resolve(b));
  assert.equal(resolvePrompt(job), 'file B');
});

test('edit --prompt on a linked job BREAKS the link (otherwise you would not know which wins)', () => {
  saveQueue([]);
  const f = write('c.md', 'from the file');
  const j = addJob({ from: f, adapter: 'mock' });

  const { job } = editJob(j.id, { prompt: 'plain text now' });
  assert.equal(job.promptFile, null, 'no longer linked');
  assert.equal(job.prompt, 'plain text now');
  assert.equal(resolvePrompt(job), 'plain text now');
});

test('edit --from pointing at something that does not exist is refused (the queue is not corrupted)', () => {
  saveQueue([]);
  const f = write('d.md', 'x');
  const j = addJob({ from: f, adapter: 'mock' });
  assert.throws(() => editJob(j.id, { from: path.join(TMP, 'ghost.md') }), /no such prompt file/);
  assert.equal(loadQueue()[0].promptFile, path.resolve(f), 'the job is left as it was');
});

// --- resuming is NOT repeating -------------------------------------------------
// If the quota cuts a launch off halfway, the session is still there: it has already read the
// project, made a plan and maybe written half the feature. Pasting the whole prompt at it
// again makes it START OVER: it pays for all that context a second time and may undo the work.

test('a job cut off by the quota, WITH a session, resumes with "carry on" and not with the prompt', async () => {
  const { CONTINUATION, isContinuation } = await import('../src/core/prompt.mjs');
  const { requeue, settle } = await import('../src/runner/lifecycle.mjs');

  saveQueue([]);
  const j = addJob({ prompt: 'an enormous prompt with all the context', adapter: 'mock' });
  j.sessionId = 'sess-alive';                         // the launch did get started

  const s = settle(j, {
    ok: false,
    output: "You've hit your session limit · resets 1:30pm",
    error: 'exited 1',
  });
  requeue(j, s);

  assert.equal(j.continuation, true);
  assert.equal(isContinuation(j), true);
  assert.match(CONTINUATION, /carry on/i);
  assert.match(CONTINUATION, /do NOT start over/i);
  assert.doesNotMatch(CONTINUATION, /enormous prompt/);
});

test('with no session, the launch never started: the ORIGINAL prompt is sent', async () => {
  // There is nothing to continue here. Sending "carry on" to a conversation that does not
  // exist would be sending Claude a message with no context at all.
  const { isContinuation } = await import('../src/core/prompt.mjs');
  const { requeue, settle } = await import('../src/runner/lifecycle.mjs');

  saveQueue([]);
  const j = addJob({ prompt: 'the original', adapter: 'mock' });   // sessionId null

  requeue(j, settle(j, { ok: false, output: "You've hit your session limit", error: 'x' }));

  assert.equal(j.continuation, false);
  assert.equal(isContinuation(j), false);
});
