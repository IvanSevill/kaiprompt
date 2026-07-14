import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KAIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-update-'));
const { checkVersion } = await import('../lib/update.mjs');

test('checkVersion reports a newer public release without a token', async () => {
  const update = await checkVersion({ fetcher: async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://example.test/release', body: 'notes' }),
  }) });
  assert.deepEqual(update, {
    current: '2.0.0', latest: '99.0.0', url: 'https://example.test/release', notes: 'notes',
  });
});
