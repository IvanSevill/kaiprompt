import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as claude from '../adapters/claude.mjs';
import * as codex from '../adapters/codex.mjs';
import * as mock from '../adapters/mock.mjs';
import * as opencode from '../adapters/opencode.mjs';
import { claudeModels, discoverCodexModels } from '../lib/engines.mjs';

const dry = (over = {}) => claude.run({ prompt: 'p', dryRun: true, ...over });

test('engine model autocomplete reads Claude aliases and Codex account cache', () => {
  assert.ok(claudeModels().includes('sonnet'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-codex-models-'));
  const file = path.join(dir, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({ models: [
    { slug: 'hidden', visibility: 'hide', priority: 0 },
    { slug: 'gpt-second', visibility: 'list', priority: 2 },
    { slug: 'gpt-first', visibility: 'list', priority: 1 },
  ] }));
  assert.deepEqual(discoverCodexModels(file), ['gpt-first', 'gpt-second']);
});

test('claude: BYPASS by default (full autonomy for unattended launches)', async () => {
  const { output } = await dry();
  assert.match(output, /--dangerously-skip-permissions/);
  assert.doesNotMatch(output, /--permission-mode/);
});

test('claude: --perm acceptEdits lowers the permission mode', async () => {
  const { output } = await dry({ permMode: 'acceptEdits' });
  assert.match(output, /--permission-mode acceptEdits/);
  assert.doesNotMatch(output, /--dangerously-skip-permissions/);
});

test('claude: resumes the conversation with sessionId', async () => {
  const { output } = await dry({ sessionId: 'abc-123' });
  assert.match(output, /--resume abc-123/);
  assert.match(output, /resumes abc-123…/);
});

test('claude: opens a new session without sessionId', async () => {
  const { output } = await dry();
  assert.match(output, /new session/);
  assert.doesNotMatch(output, /--resume/);
});

test('claude: onEvent enables streaming (for the live view)', async () => {
  const { output } = await dry({ onEvent: () => {} });
  assert.match(output, /--output-format stream-json/);
  assert.match(output, /--verbose/, 'stream-json requires --verbose');
});

test('claude: without onEvent uses one-shot JSON (scripts, dry-run)', async () => {
  const { output } = await dry();
  assert.match(output, /--output-format json/);
  assert.doesNotMatch(output, /stream-json/);
});

test('claude: dry-run executes NOTHING and returns ok', async () => {
  const res = await dry();
  assert.equal(res.ok, true);
  assert.match(res.output, /^\[dry-run\]/);
});

// --- the model reaches the CLI -----------------------------------------------
// `--model` was parsed in kaip.mjs, validated, passed to addJob... and then fell through a
// hole: the job did not save it, so the launch used the default model. The flag was accepted
// without complaint and did nothing, the worst way to do nothing. The complete chain
// (add -> job -> launch -> adapter) is tested end to end.

test('claude: --model reaches the command line', async () => {
  const { output } = await dry({ model: 'sonnet' });
  assert.match(output, /--model sonnet/);
});

test('claude: without a model, --model is NOT passed (respects the Claude Code default)', async () => {
  const { output } = await dry();
  assert.doesNotMatch(output, /--model/);
});

test('codex: dry-run, no session -> new exec', async () => {
  const res = await codex.run({ prompt: 'p', dryRun: true });
  assert.equal(res.ok, true);
  assert.match(res.output, /new session/);
  assert.doesNotMatch(res.output, /resume/);
});

test('codex: resumes the thread with a session', async () => {
  const res = await codex.run({ prompt: 'p', dryRun: true, sessionId: 'th_123' });
  assert.match(res.output, /exec resume/);
  assert.match(res.output, /th_123/);
});

test('codex: --model also reaches the command line', async () => {
  const res = await codex.run({ prompt: 'p', dryRun: true, model: 'gpt-5' });
  assert.match(res.output, /--model gpt-5/);
});

test('mock: emits a realistic event stream and ends with result', async () => {
  const types = [];
  const res = await mock.run({ prompt: 'x', onEvent: (e) => types.push(e.type) });

  assert.equal(res.ok, true);
  assert.equal(types.at(0), 'system', 'starts with init');
  assert.equal(types.at(-1), 'result', 'ends with the result');
  assert.ok(types.filter((t) => t === 'assistant').length >= 3);
  assert.ok(res.sessionId.startsWith('mock-'));
});

test('mock: respects an existing session', async () => {
  const res = await mock.run({ prompt: 'x', sessionId: 'previous' });
  assert.equal(res.sessionId, 'previous');
});

test('opencode: dry-run validates its provider/model and builds the unattended command', async () => {
  const res = await opencode.run({ prompt: 'x', provider: 'google', model: 'gemini-2.5-flash', dryRun: true });
  assert.equal(res.ok, true);
  assert.match(res.output, /--format json/);
  assert.match(res.output, /--auto/);
  assert.match(res.output, /-m google\/gemini-2.5-flash/);
});

test('opencode: tool parts reach the live renderer with file and diff fields', () => {
  const event = opencode.toolEvent({
    part: { type: 'tool', tool: 'edit', state: { input: { filePath: 'lib/a.mjs', oldText: 'before', newText: 'after' } } },
  }, 'ses-1');
  assert.deepEqual(event, {
    type: 'assistant', session_id: 'ses-1',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: {
      filePath: 'lib/a.mjs', oldText: 'before', newText: 'after', file_path: 'lib/a.mjs', old_string: 'before', new_string: 'after',
    } }] },
  });
});

test('opencode: normalizes punctuated TodoWrite tool names', () => {
  const event = opencode.toolEvent({
    part: { type: 'tool', tool: 'todo_write', state: { input: { todos: [{ content: 'test it', status: 'pending' }] } } },
  }, 'ses-2');
  assert.equal(event.message.content[0].name, 'TodoWrite');
  assert.equal(event.message.content[0].input.todos[0].content, 'test it');
});
