// `kaip serve` — the local HTTP API the phone talks to.
//
// Over Tailscale the phone and this machine are on the same private network (WireGuard,
// end to end). Nothing goes through anyone else's servers, so — unlike a cloud relay —
// there is no reason to trim what we send: the API serves the FULL conversation.
//
// Zero dependencies: node:http and the same lib/ the CLI uses. The server is a second
// front-end, not a second implementation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DATA, loadQueue, loadSessions, outPath, readJSON, writeJSON } from './store.mjs';
import { jobPreview, resolvePrompt } from './prompt.mjs';
import { findTranscript, parseTranscript, resolveRef } from './chat.mjs';
import { sessionQuota } from './quota.mjs';
import { newKey, seal, wantsSealed } from './crypto.mjs';
import * as daemon from './daemon.mjs';

export const DEFAULT_PORT = 7777;
const CONF = path.join(DATA, 'server.json');

// --- pairing -----------------------------------------------------------------
/**
 * The token the phone carries. Generated once and kept — re-pairing a phone should not
 * silently lock out the one already on your nightstand.
 */
export function serverConfig() {
  const conf = readJSON(CONF, {});
  let dirty = false;

  if (!conf.token) { conf.token = crypto.randomBytes(24).toString('base64url'); dirty = true; }
  // The key that makes the Cloudflare tunnel safe: it is minted here and handed to the
  // phone by QR — off your own screen — so it never travels the wire it protects.
  if (!conf.key) { conf.key = newKey(); dirty = true; }
  if (!conf.devices) { conf.devices = []; dirty = true; }

  if (dirty) writeJSON(CONF, conf);
  return conf;
}

export const saveServerConfig = (conf) => writeJSON(CONF, conf);

/**
 * Rotate BOTH secrets: every paired phone stops working until it pairs again.
 *
 * The key goes too, not just the token. This is the "I lost my phone" button — leaving the
 * encryption key alive would mean the lost phone could still read anything it managed to
 * fetch, which is not what anyone pressing this button expects.
 */
export function resetToken() {
  const conf = serverConfig();
  conf.token = crypto.randomBytes(24).toString('base64url');
  conf.key = newKey();
  conf.devices = [];
  saveServerConfig(conf);
  return conf.token;
}

/**
 * The address the phone should use. On Tailscale that is the 100.x.x.x one — it is the
 * only address that works from outside the house, and picking the LAN address here is
 * the difference between an app that works everywhere and one that works on the sofa.
 */
export function addresses(port = DEFAULT_PORT) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = a.address.startsWith('100.') || /tailscale/i.test(name);
      out.push({ name, address: a.address, url: `http://${a.address}:${port}`, tailscale });
    }
  }
  return out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));   // Tailscale first
}

/**
 * What goes in the QR: where to connect, the proof you are allowed to, and the key that
 * makes the tunnel unreadable to whoever owns it.
 *
 * `publicUrl` is the tunnel (Cloudflare) when there is one — that is the address that works
 * from anywhere. The LAN address is the fallback, and it only ever works on your own wifi.
 */
export function pairingPayload(port = DEFAULT_PORT, publicUrl = null) {
  const { token, key } = serverConfig();
  const lan = addresses(port)[0];

  return {
    v: 1,
    url: publicUrl || (lan ? lan.url : `http://127.0.0.1:${port}`),
    lan: lan ? lan.url : null,              // handy when the phone IS on the home wifi
    token,
    key,                                    // never crosses the wire it protects: you scan it
    host: os.hostname(),
    tunnel: Boolean(publicUrl),
  };
}

// --- what the API answers with -----------------------------------------------
/** A job, as the phone sees it. The prompt is resolved (a --from job reads its file). */
function jobDTO(job) {
  let prompt;
  try { prompt = resolvePrompt(job); }
  catch (e) { prompt = null; job = { ...job, promptError: e.message.split('\n')[0] }; }

  return {
    id: job.id,
    status: job.status,
    prompt,                                   // the FULL prompt: nothing to hide, nothing leaves the machine
    promptFile: job.promptFile ?? null,
    promptError: job.promptError ?? null,
    preview: jobPreview(job, 80),
    target: job.target ?? null,
    sessionId: job.sessionId ?? null,
    adapter: job.adapter,
    dir: job.dir ?? null,
    when: job.when ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    hasOutput: Boolean(job.output),
  };
}

/** Everything the main screen needs, in one call. */
export function stateDTO() {
  const queue = loadQueue();
  const d = daemon.status();
  const q = sessionQuota();

  return {
    host: os.hostname(),
    now: Date.now(),
    jobs: queue.map(jobDTO),
    counts: ['pending', 'running', 'done', 'error', 'missed'].reduce((acc, s) => {
      acc[s] = queue.filter((j) => j.status === s).length;
      return acc;
    }, {}),
    // "Will anything actually fire?" is the question the phone most needs answered.
    daemon: { running: Boolean(d.running), pid: d.pid ?? null, next: d.next ?? null },
    quota: q ? { freePct: q.freePct, resetsAt: q.resetsAt, renewed: q.renewed } : null,
  };
}

/** The conversations, grouped by target — several jobs share one chat, and that is the point. */
export function targetsDTO() {
  const sessions = loadSessions();
  const queue = loadQueue();

  return Object.entries(sessions).map(([target, s]) => ({
    target,
    sessionId: s.sessionId,
    adapter: s.adapter,
    updatedAt: s.updatedAt,
    jobs: queue.filter((j) => j.target === target).map((j) => j.id),
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * The WHOLE conversation, as structured turns. No truncation: this is the payoff of not
 * using a cloud relay — the transcript never leaves your machine, so there is nothing to
 * be careful about.
 */
export function chatDTO(ref) {
  const { sessionId, target, jobs } = resolveRef(ref);
  const dirs = [...new Set(jobs.map((j) => j.dir).filter(Boolean))];
  const file = findTranscript(sessionId, dirs);
  if (!file) throw Object.assign(new Error(`no transcript for session ${sessionId}`), { status: 404 });

  const chat = parseTranscript(file);
  return {
    sessionId,
    target,
    dir: chat.cwd || dirs[0] || null,
    jobs: jobs.map((j) => j.id),
    first: chat.first,
    last: chat.last,
    turns: chat.turns.map((t) => ({
      role: t.role,
      at: t.timestamp,
      toolResult: t.toolResult,
      sidechain: t.sidechain,
      blocks: t.blocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'thinking') return { type: 'thinking', text: b.thinking };
        if (b.type === 'tool_use') return { type: 'tool', name: b.name, input: b.input };
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string'
            ? b.content
            : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
          return { type: 'tool_result', text };
        }
        return { type: b.type };
      }),
    })),
  };
}

export function outputDTO(id) {
  const job = loadQueue().find((j) => j.id === id);
  if (!job) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
  const file = outPath(id);
  return {
    ...jobDTO(job),
    output: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  };
}

// --- live events --------------------------------------------------------------
// The runner pushes here; every open SSE connection gets it. In-memory on purpose: a
// phone that was not listening catches up by re-reading the state, which it does anyway.
const listeners = new Set();

export function publish(event) {
  const line = `data: ${JSON.stringify({ ...event, at: Date.now() })}\n\n`;
  for (const res of listeners) {
    try { res.write(line); } catch { listeners.delete(res); }
  }
}

// --- the server ----------------------------------------------------------------
/**
 * Answer with JSON — sealed, if the caller asked for it.
 *
 * The app always asks. That is what keeps the Cloudflare tunnel honest: the operator of
 * the wire moves an envelope it has no key to. Plain JSON stays available for curl and
 * for the tests, and on a LAN or a VPN there is nothing to hide from anyway.
 */
const json = (res, body, status = 200, key = null) => {
  const payload = key ? seal(body, key) : body;
  const s = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    ...(key ? { 'x-kaip-enc': '1' } : {}),
  });
  res.end(s);
};

/** Bearer token on every call. Over Tailscale the wire is already private; this stops a
 *  another device ON your tailnet from reading your prompts. */
function authorized(req, token) {
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : (new URL(req.url, 'http://x').searchParams.get('token') || '');
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer({ port = DEFAULT_PORT } = {}) {
  serverConfig();                       // mint the token now, so `pair` can show it

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);       // ['api', 'job', 'abc']

    // Liveness needs no token: it is how the phone knows the PC is up at all.
    if (url.pathname === '/api/ping') return json(res, { ok: true, host: os.hostname(), now: Date.now() });

    // Read the token per request, not once at startup. `kaip pair --reset` exists to lock
    // out a lost phone RIGHT NOW — and a server still honouring the token it cached at
    // boot would keep letting it in. An unpair button that does not unpair is worse than
    // no button at all.
    if (!authorized(req, serverConfig().token)) return json(res, { error: 'unauthorized' }, 401);

    // From here on the answer is sealed if the caller asked. The 401 above is NOT sealed:
    // a client with the wrong key must still be able to read WHY it was turned away.
    const enc = wantsSealed(req) ? serverConfig().key : null;

    try {
      if (seg[0] !== 'api') return json(res, { error: 'not found' }, 404, enc);

      // GET /api/state — the whole main screen in one call
      if (seg[1] === 'state' && seg.length === 2) return json(res, stateDTO(), 200, enc);

      // GET /api/targets — conversations, grouped
      if (seg[1] === 'targets' && seg.length === 2) return json(res, targetsDTO(), 200, enc);

      // GET /api/job/:id            → the job + its final answer
      // GET /api/job/:id/chat       → the WHOLE conversation it had
      if (seg[1] === 'job' && seg[2]) {
        if (seg[3] === 'chat') return json(res, chatDTO(seg[2]), 200, enc);
        return json(res, outputDTO(seg[2]), 200, enc);
      }

      // GET /api/chat/:ref — by target or session id
      if (seg[1] === 'chat' && seg[2]) return json(res, chatDTO(seg[2]), 200, enc);

      // GET /api/events — SSE: what the launch is doing, live
      if (seg[1] === 'events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        listeners.add(res);
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 20_000);
        req.on('close', () => { clearInterval(beat); listeners.delete(res); });
        return undefined;
      }

      // POST /api/device — the phone tells us where to push notifications
      if (seg[1] === 'device' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let dev;
          try { dev = JSON.parse(body || '{}'); } catch { return json(res, { error: 'bad json' }, 400); }
          if (!dev.url) return json(res, { error: 'device needs a url to be notified at' }, 400);

          const c2 = serverConfig();
          c2.devices = (c2.devices || []).filter((d) => d.url !== dev.url);
          c2.devices.push({ url: dev.url, name: dev.name || 'phone', pairedAt: Date.now() });
          saveServerConfig(c2);
          return json(res, { ok: true, devices: c2.devices.length });
        });
        return undefined;
      }

      return json(res, { error: 'not found' }, 404);
    } catch (e) {
      return json(res, { error: e.message }, e.status || 500, enc);
    }
  });

  server.listen(port, '0.0.0.0');
  return server;
}
