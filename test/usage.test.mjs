import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-usage-'));
process.env.KAIP_HOME = HOME;

const { aggregateUsage } = await import('../lib/usage.mjs');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const history = path.join(HOME, 'data', 'history');
fs.mkdirSync(history, { recursive: true });

const jobs = [
  { id: 'claude-job', adapter: 'claude', target: 'alpha', sessionId: 'claude-session' },
  { id: 'opencode-job', adapter: 'opencode', provider: 'openai', target: 'beta', sessionId: 'opencode-session' },
  { id: 'codex-job', adapter: 'codex', target: 'alpha', sessionId: 'codex-session' },
];
fs.writeFileSync(path.join(HOME, 'data', 'queue.json'), JSON.stringify(jobs));

function end(id, entry) {
  fs.writeFileSync(path.join(history, `${id}.jsonl`), JSON.stringify({ type: 'attempt-end', ...entry }) + '\n');
}

end('claude-job', {
  engine: 'claude', sessionId: 'claude-session',
  usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10 },
});
end('opencode-job', {
  engine: 'opencode', provider: 'openai', sessionId: 'opencode-session',
  usage: { input: 40, output: 10, total: 50, reasoning: 5 }, cost: 0.0125,
});
end('codex-job', { engine: 'codex', sessionId: 'codex-session' });

test('usage aggregation normalizes Claude and OpenCode while retaining unavailable Codex data', () => {
  const report = aggregateUsage();
  assert.equal(report.sessions.length, 3);

  const claude = report.sessions.find((row) => row.engine === 'claude');
  assert.deepEqual(claude.usage.input, { value: 100, partial: false });
  assert.deepEqual(claude.usage.total, { value: 125, partial: false });

  const openCode = report.sessions.find((row) => row.engine === 'opencode');
  assert.deepEqual(openCode.usage.total, { value: 50, partial: false });
  assert.deepEqual(openCode.usage.cost, { value: 0.0125, partial: false });

  const codex = report.sessions.find((row) => row.engine === 'codex');
  assert.equal(codex.usage.total, null, 'unavailable Codex usage is not zero');
  assert.deepEqual(report.totals.total, { value: 175, partial: true });
});

test('usage aggregation filters by engine, provider, target, and session', () => {
  assert.equal(aggregateUsage({ engine: 'claude' }).sessions[0].session, 'claude-session');
  assert.equal(aggregateUsage({ provider: 'openai' }).sessions[0].engine, 'opencode');
  assert.equal(aggregateUsage({ target: 'alpha' }).sessions.length, 2);
  assert.equal(aggregateUsage({ session: 'opencode-session' }).sessions[0].target, 'beta');
});

test('usage survives clearing finished jobs because history is its own archive', () => {
  const report = aggregateUsage({}, []);
  assert.equal(report.sessions.length, 3);
  assert.equal(report.sessions.find((row) => row.engine === 'opencode').usage.total.value, 50);
});

function usageCli(...args) {
  return childProcess.execFileSync(process.execPath, ['kaip.mjs', 'usage', ...args], {
    cwd: ROOT, env: { ...process.env, KAIP_HOME: HOME }, encoding: 'utf8',
  });
}

test('usage CLI reports sessions, known cost, partial totals, and every filter', () => {
  const output = usageCli();
  assert.match(output, /claude-session/);
  assert.match(output, /opencode-session/);
  assert.match(output, /cost: \$0\.0125/);
  assert.match(output, /total 175 \(partial\)/);
  assert.doesNotMatch(output, /%/);
  assert.match(usageCli('--engine', 'claude'), /claude-session/);
  assert.match(usageCli('--provider', 'openai'), /opencode-session/);
  assert.match(usageCli('--target', 'beta'), /opencode-session/);
  assert.match(usageCli('--session', 'codex-session'), /codex-session/);
});
