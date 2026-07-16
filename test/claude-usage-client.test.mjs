import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claudeUsageCandidates, createQuotaLoader, fetchQuotaSchema, runClaudeUsage,
} from '../src/adapters/quota-client.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-claude-usage-'));
const KAIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaip.mjs');

function fakeTool(root, source = '') {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'usage.mjs');
  fs.writeFileSync(file, source || 'process.exitCode = 0;\n');
  return file;
}

test('discovery orders configured path, sibling clone, then PATH executable', () => {
  const configuredRoot = path.join(TMP, 'configured');
  const configured = fakeTool(configuredRoot);
  const root = path.join(TMP, 'layout', 'kaiprompt');
  const sibling = fakeTool(path.join(TMP, 'layout', 'claude-usage'));
  const bin = path.join(TMP, 'bin');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'claude-usage.cmd' : 'claude-usage');
  fs.writeFileSync(executable, 'stub');

  const candidates = claudeUsageCandidates({
    root,
    env: { CLAUDE_USAGE_PATH: configuredRoot, PATH: bin },
  });
  assert.deepEqual(candidates.map((item) => item.label), [configured, sibling, executable]);
});

test('external client forwards exact arguments and returns the child exit code', async () => {
  const root = path.join(TMP, 'injected-root');
  const tool = fakeTool(path.join(TMP, 'injected-tool'));
  const calls = [];
  const result = await runClaudeUsage(['--provider', 'codex', '--quiet'], {
    root,
    env: { CLAUDE_USAGE_PATH: tool, PATH: '' },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      process.nextTick(() => child.emit('close', 7, null));
      return child;
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 7);
  assert.deepEqual(calls[0].args, [tool, '--provider', 'codex', '--quiet']);
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('external client returns structured unavailable state without reading credentials', async () => {
  const result = await runClaudeUsage(['--json'], {
    root: path.join(TMP, 'missing', 'kaiprompt'),
    env: { CLAUDE_USAGE_PATH: path.join(TMP, 'also-missing'), PATH: '', OPENAI_API_KEY: 'SECRET' },
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.exitCode, 2);
  assert.match(result.message, /CLAUDE_USAGE_PATH/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('kaip quota streams the external tool output and preserves its exit code', () => {
  const tool = fakeTool(path.join(TMP, 'cli-tool'), [
    "process.stdout.write(`forward:${process.argv.slice(2).join('|')}\\n`);",
    "process.stderr.write('tool-stderr\\n');",
    'process.exitCode = 7;',
    '',
  ].join('\n'));
  const result = spawnSync(process.execPath, [KAIP, 'quota', '--provider', 'codex', '--min', '12'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_USAGE_PATH: tool, PATH: '' },
  });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'forward:--provider|codex|--min|12\n');
  assert.equal(result.stderr, 'tool-stderr\n');
});

test('schema client captures canonical external output even when its guard exits nonzero', async () => {
  const tool = fakeTool(path.join(TMP, 'schema-tool'), [
    "if (!process.argv.includes('--schema')) process.exit(9);",
    "process.stdout.write(JSON.stringify({provider:'codex',status:'available',limits:{requests:{id:'requests',primary:{remainingPercent:17,resetAt:'2026-07-15T12:00:00.000Z'}}},source:{kind:'app-server',official:true,observedAt:'2026-07-15T11:00:00.000Z',stale:false},plan:'plus',credits:null,errors:[]}));",
    'process.exitCode = 1;',
  ].join('\n'));
  const result = await fetchQuotaSchema('codex', {
    root: path.join(TMP, 'no-sibling'), env: { CLAUDE_USAGE_PATH: tool, PATH: '' },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.limits.requests.primary.remainingPercent, 17);
  assert.deepEqual(result.source, { kind: 'app-server', official: true });
  assert.deepEqual(result.freshness, { observedAt: '2026-07-15T11:00:00.000Z', stale: false });
  assert.equal(result.plan, 'plus');
  assert.equal(result.error, null);
});

test('schema client reports missing and malformed tools as structured provider states', async () => {
  const missing = await fetchQuotaSchema('claude', {
    root: path.join(TMP, 'missing-schema'), env: { PATH: '' },
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.error.code, 'unavailable');
  assert.deepEqual(missing.limits, {});

  const malformed = fakeTool(path.join(TMP, 'malformed-tool'), "process.stdout.write('not json');\n");
  const invalid = await fetchQuotaSchema('claude', {
    root: path.join(TMP, 'no-sibling'), env: { CLAUDE_USAGE_PATH: malformed, PATH: '' },
  });
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.error.code, 'invalid-schema');
});

test('quota loader deduplicates in-flight calls and caches independently by provider', async () => {
  let calls = 0;
  let clock = 100;
  let release;
  const fetch = async (provider) => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
    return { provider, status: 'available' };
  };
  const load = createQuotaLoader({ fetch, ttlMs: 10, now: () => clock });
  const first = load('claude');
  const duplicate = load('claude');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await duplicate);
  await load('claude');
  assert.equal(calls, 1);
  clock += 11;
  const codex = load('codex');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  await codex;
});
