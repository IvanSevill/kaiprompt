import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the data (store) and the fake ~/.claude (transcripts) BEFORE importing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cut-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');

const { loadQueue, saveQueue, saveSessions } = await import('../src/storage/repositories.mjs');
const { writeJSON } = await import('../src/storage/json.mjs');
const { encodeDir, projectsRoot } = await import('../lib/chat.mjs');
const { CONTINUATION, isContinuation } = await import('../src/core/prompt.mjs');
const {
  dismiss, dismissed, findCutShort, isQuotaError, MAX_AGE_MS, readCutShort, resumeCutShort,
} = await import('../lib/cutshort.mjs');

// A folder that EXISTS: resumeCutShort and `resumable` insist it is still there, because a
// Claude Code session lives in its folder and resuming it from another one finds nothing.
const DIR = path.join(TMP, 'project');
fs.mkdirSync(DIR, { recursive: true });

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const ts = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();

const user = (text, minsAgo) => ({
  type: 'user', cwd: DIR, timestamp: ts(minsAgo), message: { role: 'user', content: text },
});
const bot = (text, minsAgo) => ({
  type: 'assistant', cwd: DIR, timestamp: ts(minsAgo), message: { content: [{ type: 'text', text }] },
});
/** What Claude Code writes when the quota runs out: an `assistant` with isApiErrorMessage. */
const quotaError = (minsAgo, text = "You've hit your session limit · resets 1:30pm (Europe/Madrid)") => ({
  type: 'assistant', cwd: DIR, timestamp: ts(minsAgo), isApiErrorMessage: true,
  message: { content: [{ type: 'text', text }] },
});

// The real noise: after the quota error the transcript KEEPS growing with bookkeeping
// entries. Look at the last LINE instead of the last turn and you find nothing.
const bookkeeping = () => [
  { type: 'last-prompt', lastPrompt: 'whatever it was', cwd: DIR },
  { type: 'queue-operation', cwd: DIR },
  { type: 'ai-title', cwd: DIR },
  { type: 'permission-mode', cwd: DIR },
];

let n = 0;
/** Write a fake transcript and return its session id. */
function transcript(entries, { dir = DIR, mtime = NOW } = {}) {
  const sid = `0000000${++n}-dead-beef-cafe-000000000000`;
  const folder = path.join(projectsRoot(), encodeDir(dir));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sid}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return { sid, file };
}

const reset = () => {
  saveQueue([]); saveSessions({}); writeJSON(path.join(TMP, 'data', 'cutshort.json'), { sessions: [] });
};

// --- the signal --------------------------------------------------------------
test('a session cut off by the quota IS DETECTED', () => {
  const { file } = transcript([
    user('fix the network config', 20),
    bot('I will take a look.', 19),
    user('still need to wire up the network config', 12),
    quotaError(12),
    ...bookkeeping(),                     // ← the error is NOT the last line of the file
  ]);

  const hit = readCutShort(file);
  assert.ok(hit, 'it should be detected');
  assert.equal(hit.dir, DIR);
  // The preview is the request nobody answered: it is the only thing that says what was left.
  assert.equal(hit.ask, 'still need to wire up the network config');
});

test('a FINISHED conversation is not detected', () => {
  const { file } = transcript([
    user('fix the tests', 30),
    bot('Done: 3 tests passing.', 29),
  ]);
  assert.equal(readCutShort(file), null);
});

test('a quota error MID-WAY, with the user coming back afterwards, does NOT count', () => {
  // It ran out of quota, waited, came back and finished it. There is nothing left to offer.
  const { file } = transcript([
    user('do something', 300),
    quotaError(299),
    ...bookkeeping(),
    user('carry on', 20),
    bot('Done.', 19),
  ]);
  assert.equal(readCutShort(file), null);
});

test('ending on a tool_result is NOT a quota signal (that is closing the terminal)', () => {
  // 45 of the 180 real transcripts end like this. Offering them all would be offering
  // everything.
  const { file } = transcript([
    user('read the file', 10),
    { type: 'assistant', cwd: DIR, timestamp: ts(9), message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', cwd: DIR, timestamp: ts(9), message: { role: 'user', content: [{ type: 'tool_result', content: 'def main()' }] } },
  ]);
  assert.equal(readCutShort(file), null);
});

test('other API errors (login, 429) are NOT running out of quota', () => {
  for (const text of [
    'Please run /login · API Error: 401 Invalid authentication credentials',
    'Your organization has disabled Claude subscription access for Claude Code',
    "API Error: Request rejected (429) · This request would exceed your account's rate limit.",
  ]) {
    const { file } = transcript([user('do something', 10), quotaError(9, text)]);
    assert.equal(readCutShort(file), null, `should not detect: ${text}`);
  }
});

test('CLAUDE TALKING about limits is not a limit', () => {
  // The mistake a grep for "session limit" would make: this whole repo talks about quotas.
  // Without isApiErrorMessage, an assistant that MENTIONS the limit is just conversation.
  const { file } = transcript([
    user('what does quota.mjs do?', 10),
    bot("It detects when you have hit your session limit and requeues the job.", 9),
  ]);
  assert.equal(readCutShort(file), null);
});

test('isQuotaError needs the flag AND the text AND to be from the assistant', () => {
  const q = { role: 'assistant', apiError: true, blocks: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] };
  assert.equal(isQuotaError(q), true);
  assert.equal(isQuotaError({ ...q, apiError: false }), false, 'without the flag: it is just text');
  assert.equal(isQuotaError({ ...q, role: 'user' }), false, 'from the user: that is a complaint, not a cut-off');
  assert.equal(isQuotaError({ ...q, blocks: [{ type: 'text', text: 'API Error: 500' }] }), false);
  assert.equal(isQuotaError(undefined), false);
});

test('the WEEKLY limit cuts things off too', () => {
  const { file } = transcript([
    user('carry on', 10),
    quotaError(9, "You've hit your weekly limit · resets Thursday at 9am"),
  ]);
  assert.ok(readCutShort(file));
});

// --- who is NOT offered --------------------------------------------------------
test('a session KAIP launched is not offered (the requeue already resumes it)', () => {
  reset();
  const { sid } = transcript([user('do something', 10), quotaError(9)]);

  assert.equal(findCutShort({ now: NOW }).filter((h) => h.sessionId === sid).length, 1);

  // Now there is a kaip job on that session: offering it would queue the work twice and
  // resume the same session from two places at once.
  saveQueue([{ id: 'j1', status: 'done', sessionId: sid, prompt: 'x' }]);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);

  // And not if it is only tied to a target in sessions.json either.
  reset();
  saveSessions({ fixes: { sessionId: sid, adapter: 'claude' } });
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('an OLD session is not offered', () => {
  reset();
  const old = NOW - 30 * 60 * 60 * 1000;                 // 30 h: past the 24 h threshold
  const { sid } = transcript([
    { type: 'user', cwd: DIR, timestamp: new Date(old).toISOString(), message: { role: 'user', content: 'do something' } },
    { type: 'assistant', cwd: DIR, timestamp: new Date(old).toISOString(), isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] } },
  ], { mtime: old });

  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
  // …but the signal is still there: what rules it out is its age, not the detection.
  assert.equal(findCutShort({ now: NOW, maxAgeMs: 48 * 60 * 60 * 1000 }).some((h) => h.sessionId === sid), true);
  assert.equal(MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test('saying NO silences it FOR GOOD', () => {
  reset();
  const { sid } = transcript([user('do something', 10), quotaError(9)]);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), true);

  dismiss(sid);
  assert.equal(dismissed().has(sid), true);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);

  // And it survives re-reading the state from disk: this is not one GUI session's memory.
  assert.equal(dismissed().has(sid), true);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('the most recent ones first', () => {
  reset();
  const a = transcript([user('old', 600), quotaError(600)]);
  const b = transcript([user('new', 5), quotaError(5)]);
  const found = findCutShort({ now: NOW }).map((h) => h.sessionId);
  assert.ok(found.indexOf(b.sid) < found.indexOf(a.sid));
});

// --- saying yes: the bridge ----------------------------------------------------
test('accepting queues it as a CONTINUATION and FIRST IN LINE', () => {
  reset();
  const { sid } = transcript([user('the network config is missing', 8), quotaError(8)]);
  const hit = findCutShort({ now: NOW }).find((h) => h.sessionId === sid);

  const job = resumeCutShort(hit);

  assert.equal(job.sessionId, sid, 'the same session');
  assert.equal(job.continuation, true);
  assert.equal(job.priority, true, 'it goes first');
  assert.equal(job.when, null, 'no time: as soon as there is quota');
  assert.equal(job.dir, DIR);

  // It reuses the machinery that already existed: isContinuation → executeJob sends
  // CONTINUATION, not the prompt. There is no second resume mechanism.
  assert.equal(isContinuation(job), true);
  assert.equal(job.prompt, CONTINUATION);

  assert.equal(loadQueue().length, 1);
});

test('once queued it is not offered again', () => {
  reset();
  const { sid } = transcript([user('do something', 8), quotaError(8)]);
  resumeCutShort(findCutShort({ now: NOW }).find((h) => h.sessionId === sid));
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('a conversation whose folder is gone is not resumed', () => {
  reset();
  const gone = path.join(TMP, 'deleted');
  fs.mkdirSync(gone, { recursive: true });
  const { file } = transcript([
    { type: 'user', cwd: gone, timestamp: ts(5), message: { role: 'user', content: 'do something' } },
    { type: 'assistant', cwd: gone, timestamp: ts(5), isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] } },
  ], { dir: gone });
  const hit = readCutShort(file);
  fs.rmSync(gone, { recursive: true, force: true });

  assert.throws(() => resumeCutShort(hit), /folder/i);
});

test('with no ~/.claude/projects it does not blow up: there is simply nothing to offer', () => {
  reset();
  assert.deepEqual(findCutShort({ now: NOW, root: path.join(TMP, 'does-not-exist') }), []);
});
