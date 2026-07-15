// `kaip serve` — the local HTTP API the phone talks to.
//
// This file is the HTTP layer and nothing else: the routes, who is allowed to call them,
// and the live event stream. What it ANSWERS with lives in server-dto.mjs; how a phone gets
// in lives in server-pair.mjs. It had all three at once and had grown to 600 lines, so you
// could not read the routing without wading through a QR encoder.
//
// The payload is sealed end to end (AES-256-GCM): Cloudflare terminates the TLS and could
// otherwise read everything passing through, so it carries an envelope it has no key to.
//
// Zero dependencies: node:http and the same lib/ the CLI uses. The server is a second
// front-end, not a second implementation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { outPath } from './store.mjs';
import { seal, wantsSealed } from './crypto.mjs';
import { clearFinished } from './queue.mjs';

import {
  apkPath, DEFAULT_PORT, fromLoopback, noteClient, pairPage, pairingCompact, pairingPayload,
  pairedThisSession, serverConfig, saveServerConfig,
} from './server-pair.mjs';
import { chatDTO, outputDTO, stateDTO, targetsDTO, usageDTO } from './server-dto.mjs';
import { isTerminalStatus, replayLive, subscribeLive } from './live-events.mjs';

// The public surface, unchanged: `lib/server.mjs` is still the whole API to everyone outside.
export {
  addresses, apkPath, BOOTED_AT, clientList, DEFAULT_PORT, forgetClients, fromLoopback,
  noteClient, pairedThisSession, pairingCompact, pairingPayload, resetToken, saveServerConfig,
  serverConfig, VERSION,
} from './server-pair.mjs';
export { chatDTO, conversationStatus, outputDTO, stateDTO, targetsDTO, usageDTO } from './server-dto.mjs';

// --- live events --------------------------------------------------------------
// The runner pushes here; every open SSE connection gets it. In-memory on purpose: a
// phone that was not listening catches up by re-reading the state, which it does anyway.
const listeners = new Set();

export function publish(event) {
  const record = { ...event, at: Date.now() };
  for (const listener of listeners) {
    try { listener(record); } catch { listeners.delete(listener); }
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

export function createServer({ port = DEFAULT_PORT, loadChat = chatDTO, loadTargets = targetsDTO } = {}) {
  serverConfig();                       // mint the token now, so the pairing QR can show it

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);       // ['api', 'job', 'abc']

    // Liveness needs no token: it is how the phone knows the PC is up at all.
    if (url.pathname === '/api/ping') return json(res, {
      ok: true, host: os.hostname(), now: Date.now(), protocol: 2,
      capabilities: ['device-id', 'explicit-unpair', 'pairing-state', 'live-chat-replay'],
    });

    // The pairing QR, as a web page. A terminal draws a module as half a character cell, so
    // a 61x61 code comes out a couple of centimetres across and a phone camera has to
    // resolve every module out of that. It is right at the edge, and a long tunnel URL
    // pushes it over — which is exactly how a QR that worked yesterday stops working today.
    //
    // A browser has no such limit. Same code, ten times the size, scans every time.
    //
    // LOCALHOST ONLY. It hands out the token AND the encryption key with no auth — which is
    // fine for a page only reachable from the machine that owns them, and would be a
    // catastrophe through the tunnel. fromLoopback is the only thing standing between this
    // page and giving your keys away.
    if (url.pathname === '/pair') {
      if (!fromLoopback(req)) return json(res, { error: 'not found' }, 404);

      const conf = serverConfig();
      const html = pairPage(pairingCompact(port, conf.publicUrl || null));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // Nobody frames this page and nobody's script talks to it.
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
      return res.end(html);
    }

    // The app itself, downloadable. No token — you cannot pair before you have the app, so
    // demanding the token here would be a lock whose key is inside the box.
    if (url.pathname === '/apk') {
      const apk = apkPath();
      if (!apk) return json(res, { error: 'no apk built yet' }, 404);
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': fs.statSync(apk).size,
        'content-disposition': 'attachment; filename="kaiprompt.apk"',
      });
      return fs.createReadStream(apk).pipe(res);
    }

    // Read the token per request, not once at startup. `kaip serve --reset` exists to lock
    // out a lost phone RIGHT NOW — and a server still honouring the token it cached at
    // boot would keep letting it in. An unpair button that does not unpair is worse than
    // no button at all.
    if (!authorized(req, serverConfig().token)) return json(res, { error: 'unauthorized' }, 401);

    // Past the token, so this only ever counts the phone — never a random port scan. It is
    // what takes the pairing QR off the screen, and what fills the "who has talked to this
    // PC" list in the app's Settings.
    noteClient(req);

    // From here on the answer is sealed if the caller asked. The 401 above is NOT sealed:
    // a client with the wrong key must still be able to read WHY it was turned away.
    const enc = wantsSealed(req) ? serverConfig().key : null;

    try {
      if (seg[0] !== 'api') return json(res, { error: 'not found' }, 404, enc);

      // GET /api/state — the whole main screen in one call
      if (seg[1] === 'state' && seg.length === 2) return json(res, stateDTO(), 200, enc);

      // GET /api/targets — conversations, grouped
      if (seg[1] === 'targets' && seg.length === 2) return json(res, loadTargets(), 200, enc);

      // GET /api/usage — historical tokens/costs, separate from the live queue snapshot.
      if (seg[1] === 'usage' && seg.length === 2) return json(res, usageDTO(), 200, enc);

      if (seg[1] === 'pairing' && seg.length === 2 && req.method === 'GET') {
        return json(res, { ok: true, mode: pairedThisSession() ? 'connected' : 'pairing', protocol: 2 }, 200, enc);
      }

      // GET /api/pairing/:id — authoritative confirmation used before Android clears credentials.
      if (seg[1] === 'pairing' && seg[2] && req.method === 'GET') {
        const id = decodeURIComponent(seg[2]);
        const conf = serverConfig();
        return json(res, {
          ok: true, registered: (conf.devices ?? []).some((device) => device.id === id),
          mode: pairedThisSession() ? 'connected' : 'pairing', protocol: 2,
        }, 200, enc);
      }

      // GET /api/job/:id            → the job + its final answer
      // GET /api/job/:id/chat       → the WHOLE conversation it had
      if (seg[1] === 'job' && seg[2]) {
        if (seg[3] === 'chat') return json(res, loadChat(seg[2]), 200, enc);
        return json(res, outputDTO(seg[2]), 200, enc);
      }

      // GET /api/chat/:ref — by target or session id
      if (seg[1] === 'chat' && seg[2]) return json(res, loadChat(decodeURIComponent(seg[2])), 200, enc);

      // GET /api/events — SSE: what the launch is doing, live
      if (seg[1] === 'events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const jobId = url.searchParams.get('job');
        const since = url.searchParams.get('since');
        let beat = null;
        let unsubscribe = () => {};
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (beat) clearInterval(beat);
          listeners.delete(writeEvent);
          unsubscribe();
        };
        const writeEvent = (event) => {
          if (jobId && event.jobId !== jobId && event.id !== jobId) return;
          const payload = enc ? seal(event, enc) : event;
          if (event.id) res.write(`id: ${event.id}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          if (jobId && isTerminalStatus(event.status)) {
            cleanup();
            res.end();
            return true;
          }
          return false;
        };
        res.write(': connected\n\n');
        if (jobId) {
          const replay = replayLive(jobId, since);
          if (replay === null) writeEvent({ type: 'reset', jobId, reason: 'cursor-expired' });
          else if (replay.some(writeEvent)) return undefined;
        }
        listeners.add(writeEvent);
        unsubscribe = subscribeLive(writeEvent);
        beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { cleanup(); } }, 20_000);
        req.on('close', cleanup);
        res.on('close', cleanup);
        return undefined;
      }

      // POST /api/device — the phone introduces itself.
      //
      // This is where the NAME comes from, and it has to: the name worth showing is the
      // phone's ("Pixel 7"), and the only machine that knows it is the phone. The PC used to
      // try to carry a name in the pairing QR, the compact QR dropped the field to save
      // bytes, and everything downstream went on rendering the `?` that was left behind.
      if (seg[1] === 'device' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let dev;
          try { dev = JSON.parse(body || '{}'); } catch { return json(res, { error: 'bad json' }, 400); }

          // The url is OPTIONAL, and that is a fix, not a shrug. It is only there for the
          // notification knock, and the phone can only build it once it knows its own LAN
          // address — which it cannot on mobile data with no wifi. Refusing the whole
          // registration over it meant that phone never told us its name and never paired as
          // far as the PC was concerned. A phone with no callback still gets its news: the
          // 15-minute catch-up poll is the safety net the webhook sits on top of.
          const name = String(dev.name || '').trim() || 'phone';
          const url = dev.url ? String(dev.url) : null;
          const id = typeof dev.id === 'string' && dev.id.trim() ? dev.id.trim() : null;

          // New clients identify an installation by its random, persistent id. Old clients
          // did not send one, so retain their name/url matching until they register again.
          const c2 = serverConfig();
          const legacyMatch = (d) => d.name === name || (url && d.url === url);
          c2.devices = (c2.devices || []).filter((d) => id ? d.id !== id && !(d.id == null && legacyMatch(d)) : !legacyMatch(d));
          c2.devices.push({ ...(id ? { id } : {}), url, name, pairedAt: Date.now() });
          saveServerConfig(c2);
          return json(res, { ok: true, id, name, devices: c2.devices.length }, 200, enc);
        });
        return undefined;
      }

      // DELETE /api/device/:id — an explicit phone unpair, never an app-close signal.
      if (seg[1] === 'device' && seg[2] && seg.length === 3 && req.method === 'DELETE') {
        const id = decodeURIComponent(seg[2]);
        const c2 = serverConfig();
        const before = (c2.devices || []).length;
        c2.devices = (c2.devices || []).filter((d) => d.id !== id);
        const removed = before - c2.devices.length;
        // The phone's explicit farewell is authoritative even if its registration was lost.
        c2.pairingResetAt = Date.now();
        saveServerConfig(c2);
        publish({ type: 'devices', devices: c2.devices.map((d) => ({ name: d.name, pairedAt: d.pairedAt })) });
        return json(res, { ok: true, removed, devices: c2.devices.length, mode: pairedThisSession() ? 'connected' : 'pairing' }, 200, enc);
      }

      // DELETE /api/finished — clear everything that has already run.
      //
      // The only destructive thing the phone can do, and it is the safe one: `done`, `error`
      // and `missed` are history. Individual jobs are deliberately NOT deletable from the
      // phone — deleting the wrong pending job by a mis-tap, from a pocket, with no undo, is
      // not a capability worth having.
      if (seg[1] === 'finished' && req.method === 'DELETE') {
        const n = clearFinished();
        return json(res, { ok: true, cleared: n }, 200, enc);
      }

      return json(res, { error: 'not found' }, 404, enc);
    } catch (e) {
      return json(res, { error: e.message }, e.status || 500, enc);
    }
  });

  // Without this, a port that is already taken throws an unhandled 'error' event and the
  // whole process dies with a stack trace — which reads as "the server does not run" rather
  // than "something else is already on 7777", and leaves you no idea it was your own
  // previous `serve`, still alive in another window.
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nport ${port} is already taken.`);
      console.error('  almost certainly another "kaip serve", still alive in another window.');
      console.error(`  close it, or use another port:  kaip serve --port ${port + 1}\n`);
      process.exit(1);
    }
    console.error(`\nthe server could not start: ${e.message}\n`);
    process.exit(1);
  });

  server.ready = new Promise((resolve) => server.once('listening', resolve));
  server.listen(port, '0.0.0.0');
  return server;
}
