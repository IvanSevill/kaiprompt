import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-quota-endpoint-'));
const tool = path.join(home, 'fake-usage.mjs');
fs.writeFileSync(tool, [
  "if (!process.argv.includes('--schema')) process.exit(8);",
  "const provider = process.argv[process.argv.indexOf('--provider') + 1];",
  "process.stdout.write(JSON.stringify({provider,status:'available',limits:{dynamic:{id:'dynamic',primary:{remainingPercent:42,resetAt:null}}},source:{kind:'fake-app-server',official:true,observedAt:'2026-07-15T10:00:00.000Z',stale:false},plan:null,credits:null,errors:[]}));",
].join('\n'));
process.env.KAIP_HOME = home;
process.env.CLAUDE_USAGE_PATH = tool;
process.env.PATH = '';

const { createServer, serverConfig } = await import('../lib/server.mjs');
let server;
let base;

before(async () => {
  server = createServer({ port: 0 });
  await server.ready;
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('quota endpoint consumes canonical schema from a fake external tool', async () => {
  const response = await fetch(`${base}/api/quota?provider=codex`, {
    headers: { authorization: `Bearer ${serverConfig().token}` },
  });
  assert.equal(response.status, 200);
  const quota = await response.json();
  assert.equal(quota.provider, 'codex');
  assert.equal(quota.status, 'available');
  assert.equal(quota.limits.dynamic.primary.remainingPercent, 42);
  assert.deepEqual(quota.source, { kind: 'fake-app-server', official: true });
  assert.deepEqual(quota.freshness, { observedAt: '2026-07-15T10:00:00.000Z', stale: false });
  assert.equal(quota.error, null);
});
