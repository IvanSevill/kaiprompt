// What the runner paints. State in, lines out: a frame can always be drawn, with no
// consequences.
//
// This is where the "i" key regression lives (see the whole prompt). jobCard read job.prompt,
// but a job queued with --from stores the PATH, not the text: its prompt is null. So wrap(null)
// and trunc(null) came back empty on BOTH branches — folded and expanded — and the key looked
// dead. There was not a single frames test: which is how it reached the user.
//
// The rule, and it is the same everywhere: a job's prompt is read with resolvePrompt(), which
// is what the launch does. What the card shows has to be what gets sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-frames-'));
process.env.KAIP_HOME = TMP;

const { saveQueue } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { clockFrame, completionFrame, quotaLines, quotaWaitFrame, runningFrame } = await import('../lib/frames.mjs');
const { strip } = await import('../lib/ui.mjs');

// With no TTY, size() falls back to 80x24; force something roomy so the box does not cut.
process.stdout.columns = 100;
process.stdout.rows = 40;

const text = (lines) => strip(lines.join('\n'));
const card = (job, view = {}) => text(runningFrame(job, [], Date.now(), 0, view));

const promptFile = (name, content) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, content);
  return f;
};

test('completion tabs stay within the terminal and keep the selected provider visible', () => {
  process.stdout.columns = 48;
  const scopes = ['Claude', 'Codex', 'OpenCode/openai', 'OpenCode/anthropic', 'OpenCode/google'].map((label) => ({
    label, engine: label === 'Claude' ? 'claude' : label === 'Codex' ? 'codex' : 'opencode',
    report: { totals: {} },
  }));
  const frame = completionFrame({ completed: 1, errors: 0, elapsed: '1s' }, scopes, 4);
  assert.ok(frame.every((line) => strip(line).length <= 48));
  assert.match(text(frame), /\[OpenCode\/google\]/);
  process.stdout.columns = 100;
});

// --- an ordinary job (the text lives in the queue) ---------------------------
test('folded: one line of the prompt, and the hint says how many there are', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'fix the tests\nand then the README', adapter: 'mock' });

  const out = card(job);
  assert.match(out, /fix the tests/);
  assert.match(out, /i: full prompt · 2 lines/, 'folded, it has to say there is more behind');
});

test('folded: a single-line prompt says so in the singular', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'run the tests', adapter: 'mock' });
  assert.match(card(job), /i: full prompt · 1 line\b/);
});

test('expanded: the WHOLE prompt comes out, not just the first line', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'first line\nsecond line\nthird line', adapter: 'mock' });

  const out = card(job, { expanded: true });
  assert.match(out, /first line/);
  assert.match(out, /second line/, 'this is exactly what the "i" key exists to show');
  assert.match(out, /third line/);
  assert.match(out, /i: collapse/);
});

// --- THE REGRESSION: a job with --from (prompt: null) ------------------------
test('--from, folded: shows the text of the FILE, not a blank', () => {
  saveQueue([]);
  const f = promptFile('task.md', 'refactor the runner\ncarefully');
  const job = addJob({ from: f, adapter: 'mock' });

  assert.equal(job.prompt, null, 'a --from job stores the path, not the text (that was the trap)');

  const out = card(job);
  assert.match(out, /refactor the runner/, 'the card read job.prompt (null) and came out empty');
  assert.match(out, /task\.md/, 'and if it comes from a file, say which one');
  assert.match(out, /2 lines/);
});

test('--from, expanded: the whole prompt from the file', () => {
  saveQueue([]);
  const f = promptFile('long.md', 'one\ntwo\nthree\nfour');
  const job = addJob({ from: f, adapter: 'mock' });

  const out = card(job, { expanded: true });
  for (const l of ['one', 'two', 'three', 'four']) {
    assert.match(out, new RegExp(`\\b${l}\\b`), `"${l}" is missing: the "i" key shows nothing`);
  }
});

test('--from: what the card shows is what the file says NOW', () => {
  // The file is read at launch, not at queue time: you can keep polishing it. The card has to
  // go to the same source, or it would show a stale copy of what is about to be sent.
  saveQueue([]);
  const f = promptFile('live.md', 'old version');
  const job = addJob({ from: f, adapter: 'mock' });

  fs.writeFileSync(f, 'NEW version');

  const out = card(job, { expanded: true });
  assert.match(out, /NEW version/);
  assert.doesNotMatch(out, /old version/);
});

// --- the file breaks: warn, do not blow up -----------------------------------
test('--from with the file deleted: it paints the warning and does NOT take the runner down', () => {
  // resolvePrompt THROWS when the file is not there, and that is deliberate: an unattended
  // launch cannot be handed a blank prompt and left to improvise (test/prompt.test.mjs).
  // But this is a frame, it only paints: if the exception rose, it would take the runner out
  // in the middle of a batch.
  saveQueue([]);
  const f = promptFile('ephemeral.md', 'this is about to disappear');
  const job = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  let out;
  assert.doesNotThrow(() => { out = card(job); }, 'the frame may not propagate the exception');
  assert.match(out, /⚠/);
  assert.match(out, /prompt file is gone|ephemeral\.md/i, 'and it has to say which one is missing');

  assert.doesNotThrow(() => card(job, { expanded: true }), 'nor expanded');
});

test('--from with an empty file: the same warning (a blank prompt is never launched)', () => {
  saveQueue([]);
  const f = promptFile('empty.md', 'something, so it can be queued');
  const job = addJob({ from: f, adapter: 'mock' });
  fs.writeFileSync(f, '   \n  ');

  const out = card(job);
  assert.match(out, /⚠/);
  assert.match(out, /empty/i);
});

// --- long prompts ------------------------------------------------------------
test('expanded: if the prompt does not fit, it says how many lines are left out', () => {
  // Cutting it off in silence at line 20 is how you end up sure you asked for something you
  // never actually asked for.
  saveQueue([]);
  const job = addJob({ prompt: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'), adapter: 'mock' });

  const out = card(job, { expanded: true });
  assert.match(out, /line 1\b/);
  assert.match(out, /\+\d+ lines/, 'say how much is left out, do not just chop it');
});

// --- the other screen that uses the same card --------------------------------
test('the clock (a scheduled job) uses the same card: it shows the file too', () => {
  saveQueue([]);
  const f = promptFile('scheduled.md', 'the 3am job');
  const job = addJob({ from: f, at: '+2h', adapter: 'mock' });

  const out = text(clockFrame(job, Date.now() + 7200_000, [job], Date.now(), { expanded: true }));
  assert.match(out, /the 3am job/, 'the prompt of the job about to go out has to be visible');
});

test('the clock keeps the large digits when the wait includes days', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'later', at: '+2d', adapter: 'mock' });

  const out = text(clockFrame(job, Date.now() + 2 * 86400_000, [job], Date.now()));
  assert.match(out, /██/, 'days, hours, minutes and seconds stay in the large clock');
});

test('the runner card identifies the engine, provider and model', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'run it', adapter: 'opencode', provider: 'openai', model: 'gpt-5.6-terra' });

  const out = card(job);
  assert.match(out, /engine opencode\/openai\/gpt-5\.6-terra/);
});

test('an OpenCode job does not display Claude usage as its quota', () => {
  const lines = text(quotaLines(100, { adapter: 'opencode' }));
  assert.match(lines, /opencode is checked when this job launches/);
  assert.doesNotMatch(lines, /session|week/);
});

test('the quota wait frame identifies a weekly limit', () => {
  const job = { prompt: 'resume this', adapter: 'mock' };
  const out = text(quotaWaitFrame(job, Date.now() + 3600_000, [job], Date.now(), {}, 'weekly'));
  assert.match(out, /cupo semanal agotado/);
});

test('the completion screen switches token totals across every engine scope', () => {
  const scopes = [
    { label: 'Claude', engine: 'claude', report: { totals: { input: { value: 100 }, output: { value: 20 }, total: { value: 120 } } } },
    { label: 'Codex', engine: 'codex', report: { totals: { input: { value: 2000 }, output: { value: 30 }, total: { value: 2030 } } } },
    { label: 'OpenCode/openai', engine: 'opencode', report: { totals: { input: { value: 3000 }, output: { value: 40 }, total: { value: 3040 } } } },
  ];
  const codex = text(completionFrame({ completed: 2, errors: 0, elapsed: '3s' }, scopes, 1));
  assert.match(codex, /\[Codex\]/);
  assert.match(codex, /2\.0k tokens.*2\.0k in.*30 out/s);
  assert.match(codex, /←\/→ engine · Enter\/q close/);
});

test('running info keeps the kaip job box and TODO appears only when present', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'ship it', adapter: 'mock' });
  const plain = text(runningFrame(job, [], Date.now(), 0, { info: true }));
  assert.match(plain, /kaip job/);
  assert.match(plain, /[╭╰]/);
  assert.doesNotMatch(plain, /TODO/);

  const withTodos = text(runningFrame(job, [], Date.now(), 0, {
    todos: [{ content: 'run tests', status: 'in_progress' }],
  }));
  assert.match(withTodos, /TODO/);
  assert.match(withTodos, /run tests/);
});

test('running diff details obey the d toggle and empty mode explains itself', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'change it', adapter: 'mock' });
  const lines = ['Edit(file)', { diff: true, lines: ['- before', '+ after'] }];
  assert.doesNotMatch(text(runningFrame(job, lines, Date.now(), 0)), /before/);
  assert.match(text(runningFrame(job, lines, Date.now(), 0, { showDiff: true })), /before/);
  assert.match(text(runningFrame(job, [], Date.now(), 0, { showDiff: true })), /no changes captured yet/);
});
