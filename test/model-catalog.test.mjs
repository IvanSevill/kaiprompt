import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelCatalog, parseOpenCodeModels } from '../src/adapters/model-catalog.mjs';

test('one OpenCode result derives every provider and model and is cached', async () => {
  let calls = 0;
  const catalog = createModelCatalog({ discoverModels: async () => {
    calls++;
    return '\x1b[32mopenai/gpt-5\x1b[0m\ngoogle/gemini-2.5-flash\nopenai/gpt-5\n';
  } });

  const first = await catalog.load();
  const second = await catalog.load();
  assert.equal(calls, 1);
  assert.equal(first.status, 'ready');
  assert.deepEqual(first.models, [
    { id: 'openai/gpt-5', provider: 'openai', model: 'gpt-5' },
    { id: 'google/gemini-2.5-flash', provider: 'google', model: 'gemini-2.5-flash' },
  ]);
  assert.deepEqual(second.models, first.models);
});

test('empty and failed discovery results stay cached until explicit reload', async () => {
  let calls = 0;
  const empty = createModelCatalog({ discoverModels: async () => { calls++; return ''; } });
  assert.equal((await empty.load()).status, 'empty');
  assert.equal((await empty.load()).status, 'empty');
  assert.equal(calls, 1);
  await empty.reload();
  assert.equal(calls, 2);

  const failed = createModelCatalog({ discoverModels: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await failed.load()).status, 'error');
  assert.equal((await failed.load()).error, 'offline');
  assert.equal(calls, 3);
});

test('timeout is reported without real processes', async () => {
  const catalog = createModelCatalog({ discoverModels: () => new Promise(() => {}), timeoutMs: 5 });
  const result = await catalog.load();
  assert.equal(result.status, 'error');
  assert.match(result.error, /timed out/);
});

test('a stale generation cannot replace a newer successful snapshot', async () => {
  const pending = [];
  const catalog = createModelCatalog({ discoverModels: () => new Promise((resolve) => pending.push(resolve)), timeoutMs: 1000 });
  const old = catalog.load();
  const current = catalog.reload();
  await new Promise((resolve) => setImmediate(resolve));
  pending[1]('google/new-model');
  await current;
  pending[0]('openai/stale-model');
  await old;
  assert.deepEqual(catalog.snapshot().models.map((m) => m.id), ['google/new-model']);
  assert.deepEqual(catalog.snapshot().lastSuccessful.map((m) => m.id), ['google/new-model']);
});

test('an error keeps the last successful model snapshot', async () => {
  let fail = false;
  const catalog = createModelCatalog({ discoverModels: async () => {
    if (fail) throw new Error('temporarily offline');
    return 'openai/gpt-5';
  } });
  await catalog.load();
  fail = true;
  const result = await catalog.reload();
  assert.equal(result.status, 'error');
  assert.deepEqual(result.models.map((m) => m.id), ['openai/gpt-5']);
  assert.deepEqual(result.lastSuccessful.map((m) => m.id), ['openai/gpt-5']);
});

test('parser ignores diagnostics and malformed model identifiers', () => {
  assert.deepEqual(parseOpenCodeModels('loading...\nopenai/gpt-5\nnot/a/model\n'), [
    { id: 'openai/gpt-5', provider: 'openai', model: 'gpt-5' },
  ]);
});
