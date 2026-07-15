// `kaip serve` — the API the phone talks to.
//
// The payload is sealed end to end, so what travels the tunnel is unreadable to whoever moves
// the cable. That is the reason the API trims NOTHING: it serves the whole conversation. With
// a cloud relay in the middle you would have to be careful; here there is nothing to be
// careful about.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-server-'));
process.env.KAIP_HOME = TMP;

const { historyPath, outPath, patchJob, saveQueue, saveSessions } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { executeJob } = await import('../lib/runner.mjs');
const { emitLive } = await import('../lib/live-events.mjs');
const {
  addresses, createServer, noteClient, pairingPayload, publish, resetToken, serverConfig, saveServerConfig,
  BOOTED_AT, chatDTO, clientList, conversationStatus, forgetClients, pairedThisSession, stateDTO, targetsDTO,
} = await import('../lib/server.mjs');

const PORT = 7899;
let server;
let token;
const openCodeExports = new Map();
const openCodeRun = (_bin, args) => {
  const data = openCodeExports.get(args[1]);
  return data ? { status: 0, stdout: JSON.stringify(data) } : { status: 1, stdout: '' };
};

const get = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  headers: opts.noAuth ? {} : { authorization: `Bearer ${opts.token ?? token}` },
  ...opts,
});

/** A raw request, so we can send headers fetch() forbids (Host). */
const rawGet = (p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers },
    (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    },
  );
  req.on('error', reject);
  req.end();
});

before(async () => {
  token = serverConfig().token;
  server = createServer({ port: PORT, loadChat: (ref) => chatDTO(ref, { openCodeRun }) });
  await server.ready;
});

after(() => server?.close());

// --- who gets in --------------------------------------------------------------
test('no token: 401. Even on a private wire, another box on your network does not read your prompts', async () => {
  const r = await get('/api/state', { noAuth: true });
  assert.equal(r.status, 401);
});

test('with the wrong token: 401', async () => {
  const r = await get('/api/state', { token: 'x'.repeat(32) });
  assert.equal(r.status, 401);
});

test('/api/ping does NOT ask for a token: it is how the phone knows the PC is up', async () => {
  const r = await get('/api/ping', { noAuth: true });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.host);
});

test('the token works in the query too (Android SSE cannot easily send headers)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state?token=${token}`);
  assert.equal(r.status, 200);
});

// --- the main screen ----------------------------------------------------------
test('/api/state: the queue, the counts, the daemon and the quota in ONE call', async () => {
  saveQueue([]);
  addJob({ prompt: 'pending one', adapter: 'mock' });

  const s = await (await get('/api/state')).json();

  assert.equal(s.jobs.length, 1);
  assert.equal(s.counts.pending, 1);
  assert.ok('running' in s.daemon, 'the phone needs to know whether anything will fire at all');
  assert.ok('quota' in s);
});

test('/api/state: the prompt goes WHOLE, not trimmed (it never leaves the machine)', async () => {
  saveQueue([]);
  const long = 'line\n'.repeat(200);
  addJob({ prompt: long, adapter: 'mock' });

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, long.trim(), 'not truncated');
});

test('/api/state: a linked job (--from) resolves its file', async () => {
  saveQueue([]);
  const f = path.join(TMP, 'p.md');
  fs.writeFileSync(f, 'I come from a file');
  addJob({ from: f, adapter: 'mock' });

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, 'I come from a file');
  assert.ok(s.jobs[0].promptFile.endsWith('p.md'));
});

test('/api/state: if a linked job\'s file is gone, it says so — it does not go quiet', async () => {
  saveQueue([]);
  const f = path.join(TMP, 'fleeting.md');
  fs.writeFileSync(f, 'x');
  addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, null);
  assert.match(s.jobs[0].promptError, /gone/i);
});

test('/api/usage: exposes shared historical aggregation without delaying state', async () => {
  saveQueue([]);
  const claude = addJob({ prompt: 'count this', adapter: 'claude', target: 'alpha', session: 'claude-session' });
  const codex = addJob({ prompt: 'unknown usage', adapter: 'codex', target: 'beta', session: 'codex-session' });
  const openai = addJob({ prompt: 'costed', adapter: 'opencode', provider: 'openai', model: 'gpt', session: 'openai-session' });
  fs.writeFileSync(historyPath(claude.id), JSON.stringify({ type: 'attempt-end', engine: 'claude', sessionId: 'claude-session', usage: { input_tokens: 10, output_tokens: 4 } }) + '\n');
  fs.writeFileSync(historyPath(codex.id), JSON.stringify({ type: 'attempt-end', engine: 'codex', sessionId: 'codex-session' }) + '\n');
  fs.writeFileSync(historyPath(openai.id), JSON.stringify({ type: 'attempt-end', engine: 'opencode', provider: 'openai', sessionId: 'openai-session', usage: { input: 8, output: 2, total: 10 }, cost: 0.01 }) + '\n');

  const usage = await (await get('/api/usage')).json();
  assert.deepEqual(usage.scopes.map((scope) => scope.key), ['claude', 'codex', 'opencode:openai']);
  assert.equal(usage.scopes[0].sessions[0].usage.total.value, 14);
  assert.equal(usage.scopes[1].sessions[0].usage.total, null, 'missing Codex usage remains unavailable');
  assert.equal(usage.scopes[2].totals.cost.value, 0.01);
});

// --- the output and the conversation -------------------------------------------
test('/api/job/:id: the job with its final answer', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'hello', adapter: 'mock' });
  await executeJob(j);
  patchJob(j);                                          // the same thing the runner does

  const body = await (await get(`/api/job/${j.id}`)).json();
  assert.equal(body.id, j.id);
  assert.equal(body.status, 'done');
  assert.match(body.output, /\[mock\]/);
});

test('/api/job/:id for something that does not exist: a clean 404', async () => {
  const r = await get('/api/job/doesnotexist');
  assert.equal(r.status, 404);
});

test('/api/targets: the conversations, grouped — several jobs share one chat', async () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 'sess-9', adapter: 'claude', updatedAt: 5 } });
  addJob({ prompt: 'a', target: 'fixes', adapter: 'mock' });
  addJob({ prompt: 'b', target: 'fixes', adapter: 'mock' });

  const [t] = await (await get('/api/targets')).json();
  assert.equal(t.target, 'fixes');
  assert.equal(t.sessionId, 'sess-9');
  assert.equal(t.jobs.length, 2, 'both jobs hang off the same conversation');
});

test('/api/targets: enriched summaries preserve legacy fields and never use prompt text as a concept', () => {
  saveQueue([]);
  saveSessions({});
  const pending = addJob({ prompt: 'secret prompt must not become a title', target: 'phase-six', adapter: 'opencode', provider: 'openai', model: 'gpt-5' });
  const failed = addJob({ prompt: 'also private', target: 'phase-six', adapter: 'opencode', provider: 'openai', model: 'gpt-5' });
  patchJob({ ...pending, pausedUntil: Date.now() + 60_000 });
  patchJob({ ...failed, status: 'error', finishedAt: Date.now() + 1 });

  const [summary] = targetsDTO();
  assert.equal(summary.ref, 'phase-six');
  assert.equal(summary.concept, 'phase-six');
  assert.equal(summary.status, 'quota', 'pending/quota outranks an error');
  assert.equal(summary.currentJobId, pending.id);
  assert.equal(summary.chatAvailable, true);
  assert.equal(summary.target, 'phase-six', 'legacy target remains');
  assert.equal(summary.sessionId, null, 'legacy sessionId remains');
  assert.deepEqual(summary.jobs, [pending.id, failed.id]);
  assert.doesNotMatch(JSON.stringify(summary), /secret prompt|also private/);
});

test('/api/targets: status precedence is running > pending > error > done > missed', () => {
  const jobs = ['missed', 'done', 'error', 'pending', 'running'].map((status, index) => ({
    id: status, status, createdAt: index,
  }));
  assert.equal(conversationStatus(jobs).id, 'running');
  assert.equal(conversationStatus(jobs.filter((job) => job.status !== 'running')).id, 'pending');
  assert.equal(conversationStatus(jobs.filter((job) => !['running', 'pending'].includes(job.status))).id, 'error');
  assert.equal(conversationStatus(jobs.filter((job) => ['done', 'missed'].includes(job.status))).id, 'done');
});

test('/api/targets: an untargeted OpenCode conversation uses export metadata title and stable session ref', () => {
  saveQueue([]);
  saveSessions({});
  const job = addJob({ prompt: 'never title from this', adapter: 'opencode', provider: 'openai', model: 'gpt-5', session: 'ses-titled' });
  openCodeExports.set('ses-titled', { info: { id: 'ses-titled', title: 'Exported session title' }, messages: [] });

  const [summary] = targetsDTO({ openCodeRun });
  assert.equal(summary.ref, 'ses-titled');
  assert.equal(summary.concept, 'Exported session title');
  assert.equal(summary.currentJobId, job.id);
  assert.equal(summary.chatAvailable, true);
});

test('/api/job/:id/chat with no transcript: a 404 with a reason, not a 500', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  await executeJob(j);
  patchJob(j);                                           // the mock writes no transcript
  const r = await get(`/api/job/${j.id}/chat`);
  assert.equal(r.status, 404);
});

test('/api/job/:id/chat falls back to the prompt and output for OpenCode', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'ask OpenCode', adapter: 'opencode', provider: 'openai', model: 'gpt-5.6-terra' });
  fs.writeFileSync(outPath(j.id), 'OpenCode answer');
  patchJob({ ...j, status: 'done', output: `out/${j.id}.txt`, finishedAt: Date.now() });

  const r = await get(`/api/job/${j.id}/chat`);
  assert.equal(r.status, 200);
  const chat = await r.json();
  assert.equal(chat.adapter, 'opencode');
  assert.equal(chat.provider, 'openai');
  assert.equal(chat.model, 'gpt-5.6-terra');
  assert.deepEqual(chat.turns.map((t) => t.blocks[0].text), ['ask OpenCode', 'OpenCode answer']);
});

test('/api/job/:id/chat is useful for pending and failed OpenCode jobs before a session exists', async () => {
  saveQueue([]);
  const pending = addJob({ prompt: 'waiting prompt', adapter: 'opencode', provider: 'openai', model: 'gpt-5' });
  const failed = addJob({ prompt: 'failed prompt', adapter: 'opencode', provider: 'openai', model: 'gpt-5' });
  patchJob({ ...failed, status: 'error', error: 'launch failed', finishedAt: Date.now() });

  const waitingChat = await (await get(`/api/job/${pending.id}/chat`)).json();
  assert.equal(waitingChat.sessionId, `job:${pending.id}`);
  assert.equal(waitingChat.status, 'pending');
  assert.equal(waitingChat.terminal, false);
  assert.equal(waitingChat.turns[0].blocks[0].text, 'waiting prompt');

  const failedChat = await (await get(`/api/job/${failed.id}/chat`)).json();
  assert.equal(failedChat.status, 'error');
  assert.equal(failedChat.terminal, true);
  assert.deepEqual(failedChat.turns.map((turn) => turn.blocks[0].text), ['failed prompt', 'launch failed']);
});

test('/api/job/:id/chat returns every turn from the same OpenCode session', async () => {
  saveQueue([]);
  const a = addJob({ prompt: 'first question', target: 'shared', adapter: 'opencode', provider: 'openai', model: 'gpt-5.6-sol', session: 'ses-shared' });
  const b = addJob({ prompt: 'second question', target: 'shared', adapter: 'opencode', provider: 'openai', model: 'gpt-5.6-sol', session: 'ses-shared' });
  fs.writeFileSync(outPath(a.id), 'first answer');
  fs.writeFileSync(outPath(b.id), 'second answer');
  patchJob({ ...a, status: 'done', output: `out/${a.id}.txt`, finishedAt: Date.now() - 10 });
  patchJob({ ...b, status: 'done', output: `out/${b.id}.txt`, finishedAt: Date.now() });

  const chat = await (await get(`/api/job/${a.id}/chat`)).json();
  assert.deepEqual(chat.turns.map((turn) => turn.blocks[0].text), [
    'first question', 'first answer', 'second question', 'second answer',
  ]);
});

test('/api/chat/:target uses the normalized OpenCode export after queue history is cleared', async () => {
  saveQueue([]);
  saveSessions({ exported: {
    sessionId: 'ses-exported', adapter: 'opencode', provider: 'openai', model: 'gpt-5', dir: TMP, updatedAt: 1,
  } });
  openCodeExports.set('ses-exported', {
    info: { id: 'ses-exported', directory: TMP },
    messages: [
      { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'persisted question' }] },
      { info: { role: 'assistant', time: { created: 2 } }, parts: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'persisted answer' }] },
    ],
  });

  const response = await get('/api/chat/exported');
  assert.equal(response.status, 200);
  const chat = await response.json();
  assert.equal(chat.adapter, 'opencode');
  assert.equal(chat.dir, TMP);
  assert.deepEqual(chat.turns[1].blocks.map((block) => block.type), ['thinking', 'text']);
});

test('exported OpenCode camelCase Edit arguments produce canonical API diffs', async () => {
  saveQueue([]);
  saveSessions({ edits: {
    sessionId: 'ses-edit-export', adapter: 'opencode', provider: 'openai', model: 'gpt-5', dir: TMP, updatedAt: 1,
  } });
  openCodeExports.set('ses-edit-export', {
    info: { id: 'ses-edit-export', directory: TMP },
    messages: [{ info: { role: 'assistant', time: { created: 1 } }, parts: [{
      type: 'tool', toolName: 'edit', arguments: {
        filePath: 'lib/example.mjs', oldString: 'before', newString: 'after',
      },
    }] }],
  });

  const chat = await (await get('/api/chat/edits')).json();
  assert.deepEqual(chat.turns[0].blocks[0], {
    type: 'tool', name: 'Edit', input: {
      filePath: 'lib/example.mjs', oldString: 'before', newString: 'after',
      file_path: 'lib/example.mjs', old_string: 'before', new_string: 'after',
    },
  });
  assert.deepEqual(chat.turns[0].diffs, [{
    file: 'lib/example.mjs', added: 1, removed: 1, diff: '-before\n+after',
  }]);
});

test('OpenCode chat combines export and durable live events without duplicates and uses the requested job cursor', async () => {
  saveQueue([]);
  const current = addJob({ prompt: 'question', adapter: 'opencode', provider: 'openai', model: 'gpt-5', session: 'ses-live-export' });
  const other = addJob({ prompt: 'other', adapter: 'opencode', provider: 'openai', model: 'gpt-5', session: 'ses-live-export' });
  patchJob({ ...current, status: 'running', startedAt: Date.now() });
  patchJob({ ...other, status: 'running', startedAt: Date.now() });
  const duplicateStart = emitLive(current, { kind: 'text', text: 'already ' });
  const duplicate = emitLive(current, { kind: 'text', text: 'exported' });
  const thinking = emitLive(current, { kind: 'thinking', text: 'still working' });
  const otherLast = emitLive(other, { kind: 'text', text: 'belongs to the other job' });
  openCodeExports.set('ses-live-export', {
    info: { id: 'ses-live-export', directory: TMP },
    messages: [
      { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'question' }] },
      { info: { role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'already exported' }] },
    ],
  });

  const chat = await (await get(`/api/job/${current.id}/chat`)).json();
  const blocks = chat.turns.flatMap((turn) => turn.blocks);
  assert.equal(blocks.filter((block) => block.text === 'already exported').length, 1);
  assert.equal(blocks.find((block) => block.text === 'already exported').eventId, duplicate.id);
  assert.equal(blocks.find((block) => block.text === 'still working').eventId, thinking.id);
  assert.equal(chat.cursor, thinking.id, 'the cursor belongs to the requested job, not another job in its session');
  assert.notEqual(chat.cursor, otherLast.id);
  assert.ok(chat.eventIds.includes(chat.cursor), 'the cursor identifies an event represented in this snapshot');
  assert.ok(chat.eventIds.includes(duplicateStart.id), 'every reconciled chunk remains known for replay deduplication');
});

// --- pairing --------------------------------------------------------------------
test('pairingPayload: carries where to connect, and with what', () => {
  const p = pairingPayload(PORT);
  assert.equal(p.v, 1);
  assert.match(p.url, /^http:\/\//);
  assert.equal(p.token, serverConfig().token);
  assert.ok(p.host);
});

test('addresses: the tunnel-capable one goes FIRST (it is the only one that works away from home)', () => {
  const list = addresses(PORT);
  const i = list.findIndex((a) => a.tailscale);
  if (i >= 0) assert.equal(i, 0, 'if there is one, it has to come first');
});

test('the token is kept between calls (re-pairing must not throw the phone off the bedside table)', () => {
  assert.equal(serverConfig().token, serverConfig().token);
});

test('serve --reset rotates the token: paired phones stop getting in', async () => {
  const old = serverConfig().token;
  const fresh = resetToken();
  assert.notEqual(fresh, old);

  const r = await get('/api/state', { token: old });
  assert.equal(r.status, 401, 'the old token is no good any more');

  token = fresh;
  assert.equal((await get('/api/state')).status, 200);
});

// --- registering the phone for notifications ------------------------------------
test('POST /api/device: the phone says where to knock (the PC → phone webhook)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://100.1.2.3:8899/job-done', name: 'pixel' }),
  });
  assert.equal(r.status, 200);
  assert.ok(serverConfig().devices.some((d) => d.name === 'pixel'));
});

test('POST /api/device: a persistent id replaces only its own prior record', async () => {
  const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const id = '4f86ce8f-a65f-4061-9c9a-022a18cf2a2a';
  await post({ id, name: 'Pixel', url: 'http://10.0.0.1:8899/job-done' });
  await post({ id, name: 'Renamed Pixel', url: 'http://10.0.0.2:8899/job-done' });

  const own = serverConfig().devices.filter((d) => d.id === id);
  assert.equal(own.length, 1);
  assert.equal(own[0].name, 'Renamed Pixel');
  assert.equal(own[0].url, 'http://10.0.0.2:8899/job-done');
});

test('DELETE /api/device/:id removes only that identified device and preserves legacy records', async () => {
  const conf = serverConfig();
  conf.devices = [
    { id: 'device-a', name: 'first', url: null, pairedAt: Date.now() },
    { id: 'device-b', name: 'second', url: null, pairedAt: Date.now() },
    { name: 'old-client', url: null, pairedAt: Date.now() },
  ];
  saveServerConfig(conf);

  const r = await fetch(`http://127.0.0.1:${PORT}/api/device/device-a`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, removed: 1, devices: 2, mode: 'pairing' });
  assert.deepEqual(serverConfig().devices.map((d) => d.id ?? d.name), ['device-b', 'old-client']);

  const state = await (await get('/api/state')).json();
  assert.equal(state.server.devices.length, 2, 'the state count reflects unpairing immediately');
  const pairing = await (await get('/api/pairing/device-a')).json();
  assert.deepEqual(pairing, { ok: true, registered: false, mode: 'pairing', protocol: 2 });
});

test('DELETE /api/device/:id demands the pairing token', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/device/device-b`, { method: 'DELETE' });
  assert.equal(r.status, 401);
});

// This used to be a 400: "with no address there is nobody to knock on". True — but it followed
// from that that the phone was NOT registered, and with it went the one thing the PC cannot
// work out on its own: ITS NAME. The phone can only build that url if it knows its own LAN
// address, and on mobile data with no wifi it does not have one. Result: the phone really did
// pair, it talked to the PC — and the PC still had no idea it existed.
//
// Now the url is optional: the name goes in regardless. What the 400 really protected against
// (nobody calling a url that does not exist) is guaranteed by the test below, not by the
// rejection.
test('POST /api/device with no url: it goes in anyway — the name is what we cannot deduce', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'no-url' }),
  });
  assert.equal(r.status, 200);

  const dev = serverConfig().devices.find((d) => d.name === 'no-url');
  assert.ok(dev, 'the phone is registered even with nowhere to call it back');
  assert.equal(dev.url, null, 'and it is on record as having no address, rather than inventing one');
});

test('a phone with no url gets no knock: there is nowhere to knock, and it does not count as a failure', async () => {
  const { notifyFinished } = await import('../lib/notify.mjs');

  const conf = serverConfig();
  conf.devices = [{ url: null, name: 'no-url', pairedAt: Date.now() }];
  saveServerConfig(conf);

  // Without this filter, fetch(null) blows up inside the try and the phone counts as
  // "dropped": a failed notification that was never even attempted.
  const res = await notifyFinished({ id: 'x1', status: 'done', prompt: 'something', finishedAt: Date.now() });
  assert.equal(res.sent, 0);
  assert.equal(res.dropped, 0, 'it was not attempted: this is not a lost delivery');

  conf.devices = [];
  saveServerConfig(conf);
});

// --- the name: the phone sets it, and it is NEVER "?" ---------------------------
test('the phone names itself; with no name it stays "phone", never "?"', async () => {
  const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  await post({ url: 'http://10.0.0.9:8899/job-done', name: '  ' });
  const dev = serverConfig().devices.find((d) => d.url === 'http://10.0.0.9:8899/job-done');
  assert.equal(dev.name, 'phone', 'a blank name does NOT turn into "?"');

  assert.ok(
    !serverConfig().devices.some((d) => d.name === '?' || d.name === 'null' || !d.name),
    'no device is left without a name',
  );
});

// --- the live view ---------------------------------------------------------------
test('/api/events: SSE, and whatever the runner publishes reaches the phone', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');

  const reader = r.body.getReader();
  await new Promise((res) => setTimeout(res, 100));
  publish({ type: 'job', id: 'j1', status: 'running' });

  let got = '';
  const deadline = Date.now() + 3000;
  while (!got.includes('"id":"j1"') && Date.now() < deadline) {
    const { value } = await reader.read();
    got += new TextDecoder().decode(value ?? new Uint8Array());
  }
  ctrl.abort();

  assert.match(got, /"type":"job"/);
  assert.match(got, /"status":"running"/);
});

test('/api/events replays missed live chat events after a cursor', async () => {
  const job = { id: `live-${Date.now()}`, attemptId: 'attempt-1', target: 'chat' };
  const first = emitLive(job, { kind: 'text', text: 'one' });
  emitLive(job, { kind: 'text', text: 'two' });
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events?token=${token}&job=${job.id}&since=${encodeURIComponent(first.id)}`, { signal: ctrl.signal });
  const reader = r.body.getReader();
  let got = '';
  const deadline = Date.now() + 3000;
  while (!got.includes('"text":"two"') && Date.now() < deadline) {
    const { value } = await reader.read();
    got += new TextDecoder().decode(value ?? new Uint8Array());
  }
  ctrl.abort();
  assert.doesNotMatch(got, /"text":"one"/);
  assert.match(got, /id: attempt-1:2/);
});

test('/api/events delivers a terminal status and then closes the job stream cleanly', async () => {
  const job = { id: `terminal-${Date.now()}`, attemptId: 'attempt-terminal', target: 'chat' };
  emitLive(job, { kind: 'text', text: 'last words' });
  const ended = emitLive(job, { kind: 'status', status: 'done' });
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events?token=${token}&job=${job.id}`);
  const body = await r.text();
  assert.match(body, /"text":"last words"/);
  assert.match(body, /"status":"done"/);
  assert.match(body, new RegExp(`id: ${ended.id}`));
});

// --- what Cloudflare sees --------------------------------------------------------
// The tunnel goes through Cloudflare, which terminates the TLS. These tests pin down the one
// thing that makes that acceptable: what travels is unreadable to whoever moves the cable.

test('the app asks for a sealed envelope, and the prompt does NOT cross the tunnel in the clear', async () => {
  const { open } = await import('../lib/crypto.mjs');
  saveQueue([]);
  addJob({ prompt: 'the server password is hunter2', adapter: 'mock' });

  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
    headers: { authorization: `Bearer ${token}`, 'x-kaip-enc': '1' },
  });
  const raw = await r.text();

  assert.equal(r.headers.get('x-kaip-enc'), '1', 'it says it is sealed');
  assert.ok(!raw.includes('hunter2'), 'Cloudflare CANNOT read the prompt');
  assert.ok(!raw.includes('prompt'), 'nor even the field names');

  // And the phone, which does have the key, opens the whole thing.
  const s = open(JSON.parse(raw), serverConfig().key);
  assert.equal(s.jobs[0].prompt, 'the server password is hunter2');
});

test('unasked, it still serves plain JSON (curl, tests, and a LAN with nothing to hide)', async () => {
  saveQueue([]);
  addJob({ prompt: 'out in the open', adapter: 'mock' });
  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, 'out in the open');
});

test('the 401 is NOT sealed: whoever brings the wrong key must be able to read WHY they are turned away', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
    headers: { authorization: 'Bearer notvalid', 'x-kaip-enc': '1' },
  });
  assert.equal(r.status, 401);
  assert.match(await r.text(), /unauthorized/);
});

test('serve --reset rotates the key TOO: a lost phone cannot carry on decrypting', async () => {
  const { resetToken: rotate } = await import('../lib/server.mjs');
  const oldKey = serverConfig().key;
  rotate();
  assert.notEqual(serverConfig().key, oldKey, 'the key goes with the token');
  token = serverConfig().token;
});

// --- the APK: where Gradle really leaves it -------------------------------------
// apkPath looked in app/build/… but Gradle writes to app/APP/build/… (the module is called
// "app" and lives inside the "app" folder). It never found anything: "kaip app build" said
// "✓ APK ready" and then printed null, and /apk answered "no apk built yet" with the APK
// right there on disk. The phone could not download the app from the PC.
test('apkPath: finds the APK where Gradle really leaves it', async () => {
  const { apkPath } = await import('../lib/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-apk-'));

  assert.equal(apkPath(root), null, 'unbuilt, null (so it can say so)');

  const dir = path.join(root, 'app', 'app', 'build', 'outputs', 'apk', 'release');
  fs.mkdirSync(dir, { recursive: true });
  const apk = path.join(dir, 'app-release.apk');
  fs.writeFileSync(apk, 'I am not an apk, but I exist');

  assert.equal(apkPath(root), apk, 'the path ":app:assembleRelease" produces');
});

test('apkPath: an APK dropped in by hand beats the built one', async () => {
  const { apkPath } = await import('../lib/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-apk-'));

  const build = path.join(root, 'app', 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'app-debug.apk'), 'x');

  const byHand = path.join(root, 'app', 'kaiprompt.apk');
  fs.writeFileSync(byHand, 'x');

  assert.equal(apkPath(root), byHand, 'a downloaded release beats a stale debug build');
});

// --- /pair: the page that hands out the keys ------------------------------------
// It serves the token AND the encryption key with NO authentication: that is only acceptable
// because it can only be reached from this machine. Checking the socket address is not enough
// — with DNS rebinding, a page (evil.com resolving to 127.0.0.1) makes THE VICTIM'S OWN
// BROWSER open the connection: the socket is loopback and passes the filter, but the origin is
// still evil.com, so its JavaScript can read the response. It would walk off with the whole
// safe for the price of visiting a web page. The Host header is what closes it: the browser
// sends the name the user typed, not the address it resolved to.
test('/pair from localhost: it serves the pairing page', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/pair`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('/pair with somebody else\'s Host (DNS rebinding): 404, even though the socket is loopback', async () => {
  // fetch() will not let you forge Host (it is a forbidden header), and the real attack is
  // done by the browser itself. With node:http we send the request EXACTLY as it would
  // arrive: loopback socket — the victim opens it — and Host: evil.com, the name she typed.
  const { status, body } = await rawGet('/pair', { host: 'evil.com' });

  assert.equal(status, 404, 'this is precisely the attack: it may not return the page');
  assert.doesNotMatch(body, /token|key/i, 'and certainly not the keys');
});

test('/pair cannot be framed, nor talked to by outside scripts', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/pair`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('fromLoopback: demands BOTH things — a local socket and a local Host', async () => {
  const { fromLoopback } = await import('../lib/server.mjs');
  const req = (address, host) => ({ socket: { remoteAddress: address }, headers: { host } });

  assert.equal(fromLoopback(req('127.0.0.1', 'localhost:7777')), true);
  assert.equal(fromLoopback(req('::1', '[::1]:7777')), true);

  assert.equal(fromLoopback(req('127.0.0.1', 'evil.com')), false, 'DNS rebinding');
  assert.equal(fromLoopback(req('192.168.1.50', 'localhost:7777')), false, 'another machine on the network');
  assert.equal(fromLoopback(req('127.0.0.1', undefined)), false, 'with no Host it does not trust it');
});

// --- BUG 1: the QR never came down ----------------------------------------------
//
// The QR came down when a device appeared whose URL was not in the snapshot taken at boot. But
// the device list PERSISTS across runs, the server dedupes by NAME, and a quick tunnel hands
// out a new URL every time — so you re-pair on EVERY `kaip serve`, and the phone re-registers
// under the same name and the same LAN address it already had. Nothing looked new, so the QR
// never came down.
//
// It only ever worked the very first time you paired: precisely the one time you were not
// going to notice it was broken.
test('the QR comes down on pairing EVEN IF the phone was already on the list from another day', () => {
  forgetClients();

  // Yesterday's phone, already saved, with its usual url. This is what blinded the diff.
  const conf = serverConfig();
  conf.devices = [{ url: 'http://192.168.1.44:8899/job-done', name: 'pixel', pairedAt: Date.now() - 86_400_000 }];
  saveServerConfig(conf);

  const booted = Date.now();
  assert.equal(pairedThisSession(booted), null, "yesterday's phone is NOT a phone paired today");

  // And now it really pairs: same name, same url. The url diff saw nothing.
  const c2 = serverConfig();
  c2.devices = [{ url: 'http://192.168.1.44:8899/job-done', name: 'pixel', pairedAt: Date.now() }];
  saveServerConfig(c2);

  const live = pairedThisSession(booted);
  assert.ok(live, 'the QR HAS to come down: it has just paired');
  assert.equal(live.name, 'pixel');

  c2.devices.push({ url: 'http://192.168.1.45:8899/job-done', name: 'tablet', pairedAt: Date.now() });
  saveServerConfig(c2);
  assert.equal(pairedThisSession(booted, 3), null, 'the requested number of devices has not paired yet');
  assert.equal(pairedThisSession(booted, 2).devices, 2, 'two fresh devices close a --device 2 QR');

  c2.devices = [];
  saveServerConfig(c2);
});

test('our own requests do not count: a curl from the PC is not a phone', async () => {
  forgetClients();
  await get('/api/state');                       // from 127.0.0.1
  assert.equal(clientList().length, 0, 'loopback is not a connected device');
  assert.equal(pairedThisSession(BOOTED_AT), null, 'and the QR does not come down');
});

test('explicit mobile unpair returns pairing state to QR while the server stays up', async () => {
  forgetClients();
  const since = Date.now() - 100;
  const conf = serverConfig();
  conf.devices = [{ id: 'leaving-phone', name: 'pixel', url: null, pairedAt: Date.now() }];
  delete conf.pairingResetAt;
  saveServerConfig(conf);
  noteClient({ socket: { remoteAddress: '192.168.1.77' } });
  assert.ok(pairedThisSession(since), 'the connected panel is showing');

  const response = await fetch(`http://127.0.0.1:${PORT}/api/device/leaving-phone`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(pairedThisSession(since), null, 'the explicit farewell puts the UI back on its QR');
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).status, 200, 'serve itself remains alive');

  await new Promise((resolve) => setTimeout(resolve, 2));
  noteClient({ socket: { remoteAddress: '192.168.1.88' } });
  assert.ok(pairedThisSession(since), 'another authorized phone can still make the panel current');
});

test('an authenticated unpair resets pairing even when that device record was already lost', async () => {
  forgetClients();
  const since = Date.now() - 100;
  const conf = serverConfig();
  conf.devices = [];
  delete conf.pairingResetAt;
  saveServerConfig(conf);
  noteClient({ socket: { remoteAddress: '192.168.1.99' } });
  assert.ok(pairedThisSession(since));

  const response = await fetch(`http://127.0.0.1:${PORT}/api/device/missing-phone`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(pairedThisSession(since), null);
});

test('real serve process transitions QR → connected → QR and only stops explicitly', { timeout: 15_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-serve-cycle-'));
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(chosen));
    });
  });
  const cli = fileURLToPath(new URL('../kaip.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'serve', '--wifi', '--port', String(port)], {
    cwd: path.dirname(cli), env: { ...process.env, KAIP_HOME: home }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const waitFor = async (predicate, message) => {
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`${message}\n${output.slice(-2000)}`);
  };

  try {
    await waitFor(() => output.includes('scan this FROM the app'), 'serve never showed its QR');
    const conf = JSON.parse(fs.readFileSync(path.join(home, 'data', 'server.json'), 'utf8'));
    const headers = { authorization: `Bearer ${conf.token}`, 'content-type': 'application/json' };
    await fetch(`http://127.0.0.1:${port}/api/device`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'phone-e2e', name: 'test phone', url: null }),
    });
    await waitFor(() => output.includes('test phone paired'), 'serve never switched to its connected panel');

    await fetch(`http://127.0.0.1:${port}/api/device/phone-e2e`, { method: 'DELETE', headers });
    await waitFor(() => output.split('scan this FROM the app').length >= 3, 'serve never returned to the QR');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ping`)).status, 200, 'the HTTP server must still be alive');
    assert.equal(child.exitCode, null, 'only an explicit stop may end serve');
  } finally {
    child.kill();
  }
});

// --- BUG 6: "waiting for quota" vs "stalled", and the other three -----------------
//
// The two that matter are `quota` and `stalled`: from the phone they look THE SAME — nothing
// is moving — and they mean the opposite. One comes back on its own; the other is never going
// to happen.
test('the five states of "what is happening right now"', async () => {
  const { activityState } = await import('../lib/activity.mjs');
  const now = Date.now();

  const running = activityState({
    jobs: [{ id: 'a', status: 'running', startedAt: now - 60_000, preview: 'the tests' }],
    willFire: true, now,
  });
  assert.equal(running.state, 'running');
  assert.equal(running.since, now - 60_000, 'and since when');

  // Cut off by the quota: the runner wrote pausedUntil on the job and it is still there,
  // asleep. THIS is the one you want to see. It is not broken: it is waiting, and it comes
  // back at a specific time.
  const quota = activityState({
    jobs: [{ id: 'a', status: 'pending', pausedUntil: now + 3_600_000, preview: 'the tests' }],
    willFire: true, now,
  });
  assert.equal(quota.state, 'quota');
  assert.equal(quota.until, now + 3_600_000, 'and WHEN it comes back');

  // There is a queue and NOBODY to drain it: scheduled work will not fire. This is the one
  // that hurts.
  const stalled = activityState({
    jobs: [{ id: 'a', status: 'pending', when: now + 60_000 }],
    willFire: false, now,
  });
  assert.equal(stalled.state, 'stalled');
  assert.equal(stalled.scheduled, 1);

  const queued = activityState({
    jobs: [{ id: 'a', status: 'pending', when: now + 60_000 }],
    willFire: true, now,
  });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.next, now + 60_000);

  assert.equal(activityState({ jobs: [{ id: 'a', status: 'done' }], willFire: true }).state, 'idle');
});

test('stalled beats waiting-for-quota: if the runner died, that "back at 15:42" is a lie', async () => {
  const { activityState } = await import('../lib/activity.mjs');
  const now = Date.now();

  // The job says "I resume at 15:42". It was written by a runner that is no longer there. At
  // 15:42 nobody is coming: that is not waiting, that is being abandoned.
  const st = activityState({
    jobs: [{ id: 'a', status: 'pending', pausedUntil: now + 3_600_000 }],
    willFire: false, now,
  });
  assert.equal(st.state, 'stalled');
});

test('a pausedUntil that has already passed does not leave the state stuck on "waiting for quota"', async () => {
  const { activityState } = await import('../lib/activity.mjs');
  const now = Date.now();
  const st = activityState({
    jobs: [{ id: 'a', status: 'pending', pausedUntil: now - 1000, when: now + 5000 }],
    willFire: true, now,
  });
  assert.equal(st.state, 'queued', 'the quota is back: this is an ordinary queue');
});

test('/api/state carries the status strip and the Settings bits (tunnel, IPs, version)', () => {
  const s = stateDTO();
  assert.ok(s.activity, 'the strip travels already derived: the PC and the phone cannot disagree');
  assert.ok(['running', 'quota', 'stalled', 'queued', 'idle'].includes(s.activity.state));

  assert.ok(s.server.version, 'the version on the PC');
  assert.ok(Array.isArray(s.server.clients), 'who has spoken to the PC');
  assert.ok('tunnel' in s.server, 'the tunnel URL');
});

test('the job carries pausedUntil: without it the phone cannot tell "waiting" from "broken"', async () => {
  const { addJob } = await import('../lib/queue.mjs');
  const j = addJob({ prompt: 'cut off by the quota' });
  j.pausedUntil = Date.now() + 3_600_000;               // exactly what launch.mjs writes
  patchJob(j);

  const dto = stateDTO().jobs.find((x) => x.id === j.id);
  assert.ok(dto.pausedUntil > Date.now(), 'it travels to the phone');
});

test('DELETE /api/finished: clears what has run and does NOT touch what is pending', async () => {
  const { addJob } = await import('../lib/queue.mjs');
  const { loadQueue } = await import('../lib/store.mjs');

  const ran = addJob({ prompt: 'already ran' });
  ran.status = 'done';
  patchJob(ran);
  const pending = addJob({ prompt: 'not yet' });

  const r = await fetch(`http://127.0.0.1:${PORT}/api/finished`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);

  const ids = loadQueue().map((j) => j.id);
  assert.ok(!ids.includes(ran.id), 'what is finished goes');
  assert.ok(ids.includes(pending.id), 'what is pending stays: that is NOT deletable from the phone');
});

test('DELETE /api/finished demands a token: the queue is not emptied without credentials', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/finished`, { method: 'DELETE' });
  assert.equal(r.status, 401);
});
