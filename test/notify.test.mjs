// The PC calling the phone when a launch finishes.
//
// The RECEIVER on the phone had been built, but not the sender: the notification would never
// arrive, and there would be no way to notice without holding the phone at 3am. This test
// prevents that.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-notify-'));
process.env.KAIP_HOME = TMP;

const { saveQueue } = await import('../src/storage/repositories.mjs');
const { addJob } = await import('../src/core/jobs.mjs');
const { notifyFinished } = await import('../lib/notify.mjs');
const { saveServerConfig, serverConfig } = await import('../lib/server.mjs');
const { open } = await import('../lib/crypto.mjs');

// A fake phone: it listens just like the real one (a JSON POST).
const received = [];
let phone;
const PORT = 8901;

before(async () => {
  phone = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const conf = serverConfig();
      received.push({
        payload: open(JSON.parse(body || '{}'), conf.key),
        authorization: req.headers.authorization,
        encrypted: req.headers['x-kaip-enc'],
        method: req.method,
        path: req.url,
        raw: body,
      });
      res.writeHead(204).end();
    });
  });
  phone.listen(PORT, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 150));
});

after(() => phone?.close());

const pair = (url) => {
  const conf = serverConfig();
  conf.devices = url ? [{ url, name: 'movil-de-prueba', pairedAt: Date.now() }] : [];
  saveServerConfig(conf);
};

test('a completed job makes the PC call the phone', async () => {
  received.length = 0;
  pair(`http://127.0.0.1:${PORT}/job-done`);
  saveQueue([]);

  const j = addJob({ prompt: 'run the tests', adapter: 'mock' });
  j.status = 'done';
  j.finishedAt = Date.now();

  const r = await notifyFinished(j);

  assert.equal(r.sent, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.id, j.id);
  assert.equal(received[0].payload.status, 'done');
  assert.match(received[0].payload.preview, /run the tests/);
  assert.equal(received[0].authorization, `Bearer ${serverConfig().token}`);
  assert.equal(received[0].encrypted, '1');
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].path, '/job-done');
  assert.doesNotMatch(received[0].raw, /run the tests/);
});

test('a FAILED job also notifies, including the reason', async () => {
  received.length = 0;
  pair(`http://127.0.0.1:${PORT}/job-done`);

  const j = addJob({ prompt: 'algo', adapter: 'mock' });
  j.status = 'error';
  j.error = 'quota ran out';
  j.finishedAt = Date.now();

  await notifyFinished(j);
  assert.equal(received[0].payload.status, 'error');
  assert.equal(received[0].payload.error, 'quota ran out');
});

test('without a paired phone nobody is called (and it does not crash)', async () => {
  received.length = 0;
  pair(null);

  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  const r = await notifyFinished(j);
  assert.equal(r.sent, 0);
  assert.equal(received.length, 0);
});

test('a phone that is OFF does not break anything: the launch DID finish', async () => {
  // This is what matters. A launch cannot be considered failed because a notification could
  // not be delivered. The work was done; the phone missed the news and the app poll gets it later.
  received.length = 0;
  pair('http://127.0.0.1:9/nobody-listens-here');

  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  const r = await notifyFinished(j);       // must not throw
  assert.equal(r.sent, 0);
  assert.equal(r.dropped, 1);
});

test('the phone is not UNPAIRED after failing to answer once', async () => {
  // Removing it after the first failure would unpair the phone in a highway tunnel.
  pair('http://127.0.0.1:9/nobody');
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  await notifyFinished(j);
  assert.equal(serverConfig().devices.length, 1, 'it remains paired');
});

test('a non-success callback response counts as a miss', async () => {
  pair('http://phone.invalid/job-done');
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  const result = await notifyFinished(j, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.deepEqual(result, { sent: 0, dropped: 1 });
});
