import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the data (store) and the fake ~/.claude (transcripts) BEFORE importing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chat-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');

const { nid } = await import('../src/core/identity.mjs');
const { saveQueue, saveSessions } = await import('../src/storage/repositories.mjs');
const {
  encodeDir, findTranscript, loadOpenCodeTranscript, normalizeOpenCodeExport, parseTranscript,
  projectsRoot, renderChat, resolveRef, resumeCommand, resumeSpec,
} = await import('../lib/chat.mjs');
const { clearFinished } = await import('../src/core/jobs.mjs');

const DIR = 'C:\\proj\\app';
const SID = 'ff679ec5-531d-4424-aba3-7341b2fcaa38';
const ts = (n) => new Date(Date.UTC(2026, 6, 12, 9, n)).toISOString();

// A transcript like the real ones: it mixes turns with bookkeeping entries (attachment,
// queue-operation, mode…) that are NOT conversation.
const LINES = [
  { type: 'queue-operation', sessionId: SID },
  { type: 'user', cwd: DIR, timestamp: ts(0), message: { role: 'user', content: 'fix the tests' } },
  { type: 'attachment', cwd: DIR },
  { type: 'assistant', cwd: DIR, timestamp: ts(1), message: { content: [{ type: 'thinking', thinking: 'thinking…' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(2), message: { content: [{ type: 'text', text: 'I will look at the file.' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(3), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app/main.py' } }] } },
  { type: 'user', cwd: DIR, timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', content: 'def main(): ...' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(5), message: { content: [{ type: 'text', text: 'Done: 3 tests passing.' }] } },
  { type: 'user', cwd: DIR, timestamp: ts(6), isMeta: true, message: { role: 'user', content: 'internal noise' } },
];

const projDir = path.join(projectsRoot(), encodeDir(DIR));
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');

const job = (over = {}) => ({
  id: nid(), prompt: 'do something', target: null, adapter: 'mock', when: null,
  dir: DIR, permMode: null, status: 'done', createdAt: Date.now(),
  sessionId: SID, output: null, ...over,
});

// --- encoding the folder ------------------------------------------------------
test('encodeDir: swaps : \\ / . for dashes (that is how Claude Code names the folder)', () => {
  assert.equal(encodeDir('C:\\Users\\x\\.claude\\tools'), 'C--Users-x--claude-tools');
  assert.equal(encodeDir('C:/proj/app'), 'C--proj-app');
});

// --- resolving the reference --------------------------------------------------
test('resolveRef: a saved target → its session-id', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: SID, adapter: 'claude', updatedAt: 1 } });
  const r = resolveRef('fixes');
  assert.equal(r.sessionId, SID);
  assert.equal(r.target, 'fixes');
});

test('resolveRef: a job id → that job\'s session', () => {
  saveSessions({});
  const j = job({ target: 'review' });
  saveQueue([j]);
  const r = resolveRef(j.id);
  assert.equal(r.sessionId, SID);
  assert.equal(r.target, 'review');
  assert.deepEqual(r.jobs.map((x) => x.id), [j.id], 'and the jobs that used that session');
});

test('resolveRef: a bare session-id is taken as it is', () => {
  saveQueue([]); saveSessions({});
  assert.equal(resolveRef(SID).sessionId, SID);
});

test('resolveRef: a job that has not run yet → a clear error, not a crash', () => {
  const j = job({ status: 'pending', sessionId: null });
  saveQueue([j]);
  assert.throws(() => resolveRef(j.id), /no session yet/);
});

test('resolveRef: no argument → usage', () => {
  assert.throws(() => resolveRef(undefined), /usage/);
});

// --- finding the transcript ---------------------------------------------------
test('findTranscript: finds it by the job\'s folder', () => {
  assert.equal(findTranscript(SID, [DIR]), path.join(projDir, `${SID}.jsonl`));
});

test('findTranscript: with no folder hint, it sweeps every project', () => {
  assert.equal(findTranscript(SID, []), path.join(projDir, `${SID}.jsonl`));
});

test('findTranscript: a session that does not exist → null (it does not blow up)', () => {
  assert.equal(findTranscript('does-not-exist', [DIR]), null);
});

// --- parsing ------------------------------------------------------------------
test('parseTranscript: it keeps only the real conversation', () => {
  const chat = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  assert.equal(chat.cwd, DIR);
  assert.equal(chat.turns.length, 6, 'queue-operation, attachment and the isMeta are out');
  assert.ok(chat.turns.every((t) => t.role === 'user' || t.role === 'assistant'));
  assert.equal(chat.first, ts(0));
  assert.equal(chat.last, ts(5));
});

test('parseTranscript: the user is a string and the assistant is blocks', () => {
  const { turns } = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  assert.deepEqual(turns[0].blocks, [{ type: 'text', text: 'fix the tests' }]);
  assert.equal(turns[2].blocks[0].type, 'text');
});

test('parseTranscript: it marks a tool echo (that is not a human turn)', () => {
  const { turns } = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  const echo = turns.find((t) => t.role === 'user' && t.toolResult);
  assert.ok(echo, 'the tool_result must be marked');
  assert.equal(turns[0].toolResult, false, 'the human prompt is not');
});

// --- render -------------------------------------------------------------------
test('renderChat: a header with target, session, folder, turns and dates', () => {
  saveQueue([job({ target: 'fixes' })]);
  saveSessions({ fixes: { sessionId: SID, adapter: 'claude', updatedAt: 1 } });
  const out = renderChat('fixes');

  assert.match(out, /chat/);
  assert.match(out, /target\s+fixes/);
  assert.match(out, new RegExp(`session\\s+${SID}`));
  assert.match(out, /folder\s+C:\\proj\\app/);
  assert.match(out, /turns\s+6/);
  assert.match(out, /dates/);
  assert.match(out, /claude --resume/, 'and how to pick the conversation back up');
});

test('renderChat: it paints the conversation and summarises the tool_use calls', () => {
  const out = renderChat('fixes');
  assert.match(out, /❯ fix the tests/, 'the human turn');
  assert.match(out, /⏺ I will look at the file\./, 'the answer');
  assert.match(out, /Read\(app\/main\.py\)/, 'the tool, summarised');
  assert.doesNotMatch(out, /thinking…/, 'the thinking does not show without --full');
  assert.doesNotMatch(out, /def main/, 'nor the tool_result echo');
});

test('renderChat --full: it brings out the thinking and the tool results as well', () => {
  const out = renderChat('fixes', { full: true });
  assert.match(out, /thinking…/);
  assert.match(out, /def main/);
});

test('renderChat --last: limits the turns shown', () => {
  const out = renderChat('fixes', { last: 1 });
  assert.match(out, /Done: 3 tests passing\./, 'the last turn, yes');
  assert.doesNotMatch(out, /fix the tests/, 'the earlier ones, no');
  assert.match(out, /showing the last 1/);
});

test('renderChat --raw: returns the transcript lines exactly as they are', () => {
  const out = renderChat('fixes', { raw: true, last: 2 });
  for (const line of out.split('\n')) JSON.parse(line);           // it must be valid JSONL
  assert.doesNotMatch(out, /╭/, 'no decoration');
});

test('renderChat: no transcript → a clear error (not a crash)', () => {
  saveQueue([]); saveSessions({});
  assert.throws(() => renderChat('ghost-session'), /no transcript found/);
});

test('renderChat: a session with no messages does not blow up', () => {
  const empty = 'aaaaaaaa-0000-0000-0000-000000000000';
  fs.writeFileSync(path.join(projDir, `${empty}.jsonl`),
    JSON.stringify({ type: 'ai-title', aiTitle: 'x' }) + '\n');
  assert.match(renderChat(empty), /no messages yet/);
});

// --- walking INTO the conversation (the GUI's "y" key) ------------------------
// Reading the transcript tells you what happened. This lets you pick the thread back up and
// keep talking, in a real Claude Code.

// The folders have to REALLY exist: resumeTarget checks that on purpose (see the test below
// about the misleading ENOENT).
const realDir = (name) => {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test('resumeTarget: gives the session AND the folder (without the folder, --resume finds nothing)', async () => {
  const { resumeTarget, resumeCommand } = await import('../lib/chat.mjs');
  const dir = realDir('myapp');
  saveSessions({ fixes: { sessionId: 'sess-1', adapter: 'claude', updatedAt: 1 } });
  saveQueue([{
    id: 'j1', target: 'fixes', sessionId: 'sess-1', dir,
    status: 'done', adapter: 'claude', prompt: 'x', createdAt: 1,
  }]);

  const r = resumeTarget('fixes');
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.dir, dir, 'Claude Code sessions are PER FOLDER');
  assert.match(resumeCommand(r), /claude --resume sess-1$/);
});

test('resumeTarget: by job id too', async () => {
  const { resumeTarget } = await import('../lib/chat.mjs');
  saveQueue([{
    id: 'j2', target: null, sessionId: 'sess-2', dir: realDir('another'),
    status: 'done', adapter: 'claude', prompt: 'x', createdAt: 1,
  }]);
  assert.equal(resumeTarget('j2').sessionId, 'sess-2');
});

test('resumeTarget: if the folder is gone, a CLEAR error (not a "spawn cmd.exe ENOENT")', async () => {
  // A real regression: renaming the tool made the old sessions folder disappear, and the spawn
  // failed with ENOENT on cmd.exe — Node reports the SHELL's ENOENT when the cwd does not
  // exist, and sends you hunting for a broken cmd.exe that is perfectly fine.
  const { resumeTarget } = await import('../lib/chat.mjs');
  saveQueue([{
    id: 'j3', target: null, sessionId: 'sess-3', dir: path.join(TMP, 'folder-that-is-gone'),
    status: 'done', adapter: 'claude', prompt: 'x', createdAt: 1,
  }]);
  assert.throws(() => resumeTarget('j3'), /folder .* is gone/i);
});

test('resumeTarget: with no folder on record, a CLEAR error (not a --resume that finds nothing)', async () => {
  const { resumeTarget } = await import('../lib/chat.mjs');
  saveSessions({ orphan: { sessionId: 'sess-3', adapter: 'claude', updatedAt: 1 } });
  saveQueue([]);
  assert.throws(() => resumeTarget('orphan'), /which folder/i);
});

const OPEN_EXPORT = {
  info: { id: 'ses-open', directory: DIR },
  messages: [
    { info: { role: 'user', time: { created: Date.parse(ts(0)) } }, parts: [{ type: 'text', text: 'question' }] },
    { info: { role: 'assistant', time: { created: Date.parse(ts(1)) } }, parts: [
      { type: 'reasoning', text: 'considering' },
      { type: 'tool', tool: 'read', state: { input: { file_path: 'a.js' }, output: 'contents' } },
      { type: 'text', text: 'answer' },
    ] },
  ],
};
const exportRun = () => ({ status: 0, stdout: JSON.stringify(OPEN_EXPORT) });

test('OpenCode export normalization keeps user/assistant text, reasoning and tool blocks', () => {
  const chat = normalizeOpenCodeExport(OPEN_EXPORT, 'ses-open');
  assert.equal(chat.cwd, DIR);
  assert.deepEqual(chat.turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.deepEqual(chat.turns[1].blocks.map((block) => block.type), ['thinking', 'tool_use', 'tool_result', 'text']);
  assert.equal(chat.turns[1].blocks[1].input.file_path, 'a.js');
});

test('OpenCode loader invokes export through injection and rejects malformed output', () => {
  let call;
  const chat = loadOpenCodeTranscript('ses-open', { run: (bin, args) => {
    call = { bin, args }; return { status: 0, stdout: JSON.stringify(OPEN_EXPORT) };
  } });
  assert.deepEqual(call.args, ['export', 'ses-open']);
  assert.match(call.bin, /opencode/);
  assert.equal(chat.turns.length, 2);
  assert.equal(loadOpenCodeTranscript('bad', { run: () => ({ status: 0, stdout: 'not json' }) }), null);
});

test('OpenCode chat uses the full export and survives clearing finished jobs', () => {
  const dir = realDir('open-project');
  saveSessions({ open: { sessionId: 'ses-open', adapter: 'opencode', provider: 'openai', model: 'gpt-5', dir, updatedAt: 1 } });
  saveQueue([{ ...job({ id: 'open-job', adapter: 'opencode', target: 'open', sessionId: 'ses-open', dir }), status: 'done' }]);
  assert.equal(clearFinished(), 1);
  const out = renderChat('open', { full: true, openCodeRun: exportRun });
  assert.match(out, /question/);
  assert.match(out, /considering/);
  assert.match(out, /opencode --session ses-open --model openai\/gpt-5/);
});

test('OpenCode chat falls back to recorded prompt/output when export fails', () => {
  const j = job({ id: 'open-fallback', adapter: 'opencode', sessionId: 'ses-fallback', prompt: 'queued prompt' });
  saveQueue([j]); saveSessions({});
  fs.writeFileSync(path.join(TMP, 'out', `${j.id}.txt`), 'recorded answer');
  const out = renderChat(j.id, { openCodeRun: () => ({ status: 1, stdout: '' }) });
  assert.match(out, /queued prompt/);
  assert.match(out, /recorded answer/);
});

test('interactive resume commands are adapter-aware and preserve models', () => {
  assert.deepEqual(resumeSpec({ adapter: 'codex', sessionId: 'codex-id', dir: DIR, model: 'gpt-5' }).args,
    ['resume', '--model', 'gpt-5', 'codex-id']);
  assert.match(resumeCommand({ adapter: 'opencode', sessionId: 'open-id', dir: DIR, provider: 'google', model: 'gemini' }),
    /opencode --session open-id --model google\/gemini$/);
  assert.match(resumeCommand({ adapter: 'claude', sessionId: 'claude-id', dir: DIR, model: 'sonnet' }),
    /claude --model sonnet --resume claude-id$/);
  assert.throws(() => resumeSpec({ adapter: 'mock', sessionId: 'x', dir: DIR }), /cannot interactively resume/);
});
