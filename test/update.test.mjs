import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-update-'));
process.env.KAIP_HOME = HOME;
const { checkVersion, openRelease } = await import('../lib/update.mjs');

test('checkVersion reports a newer public release without a token', async () => {
  const update = await checkVersion({ fetcher: async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://example.test/release', body: 'notes' }),
  }) });
  assert.deepEqual(update, {
    current: '2.0.0', latest: '99.0.0', url: 'https://example.test/release', notes: 'notes',
  });
  const cacheFiles = fs.readdirSync(path.join(HOME, 'data')).filter((name) => name.startsWith('update.json'));
  assert.deepEqual(cacheFiles, ['update.json'], 'the optional cache is atomically renamed with no temp file left');
});

test('openRelease uses a detached cross-platform command without inherited stdout', () => {
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const url = openRelease('https://example.test/release', {
    platform: 'linux',
    spawnImpl(command, args, options) { calls.push({ command, args, options }); return child; },
  });
  assert.equal(url, 'https://example.test/release');
  assert.deepEqual(calls, [{
    command: 'xdg-open', args: ['https://example.test/release'],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
  }]);
  assert.equal(child.unrefCalled, true);
});

test('openRelease rejects non-web schemes before spawning', () => {
  let called = false;
  assert.throws(() => openRelease('file:///tmp/release', { spawnImpl() { called = true; } }), /http or https/);
  assert.equal(called, false);
});
