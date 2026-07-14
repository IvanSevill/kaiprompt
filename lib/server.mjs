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

import { DATA, ROOT, loadQueue, loadSessions, outPath, readJSON, writeJSON } from './store.mjs';
import { jobPreview, resolvePrompt } from './prompt.mjs';
import { findTranscript, parseTranscript, resolveRef } from './chat.mjs';
import { sessionQuota } from './quota.mjs';
import { newKey, seal, wantsSealed } from './crypto.mjs';
import { encode as qrEncode } from './qr.mjs';
import * as daemon from './daemon.mjs';
import { runnerStatus } from './runner-status.mjs';
import { activityState } from './activity.mjs';
import { lockInfo } from './lock.mjs';
import { clearFinished } from './queue.mjs';

export const DEFAULT_PORT = 7777;
const CONF = path.join(DATA, 'server.json');

/** The version of the PC half, so the phone can say what it is talking to. */
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '?'; }
})();

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

// --- who is actually on the other end ------------------------------------------
//
// "Is a phone paired?" cannot be answered from server.json alone, and that is what kept the
// pairing QR on screen for good. The device list PERSISTS across runs, and a quick tunnel
// gets a new URL on every `kaip serve` — so you re-pair every single time, and the phone
// re-registers under the same name and the same LAN address it had yesterday. Diffing that
// list against a snapshot taken at boot finds nothing new, forever.
//
// The honest question is not "is this phone in a file I wrote last week?" — it is "has a
// phone talked to THIS server, since it started?". So we watch the live traffic.

/** When this process started serving. Everything below is measured against it. */
export const BOOTED_AT = Date.now();

/** ip → what we have seen from it. In memory: it describes this run and nothing else. */
const clients = new Map();

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Note an authorized request. This — not the device registry — is the proof a phone is
 * really there, and it is the stronger signal of the two: the phone registers itself only
 * if it can work out its own LAN address, which it cannot do on mobile data with no wifi.
 * It always makes API calls.
 */
export function noteClient(req) {
  const ip = req.socket?.remoteAddress;
  if (!ip || LOOPBACK.includes(ip)) return;                // our own curl is not a phone

  const seen = clients.get(ip) ?? { ip, first: Date.now(), calls: 0 };
  seen.calls++;
  seen.at = Date.now();
  clients.set(ip, seen);
}

/** Everyone who has spoken to this server, newest first. The "quién ha hablado con el PC". */
export const clientList = () =>
  [...clients.values()].sort((a, b) => b.at - a.at);

export const forgetClients = () => clients.clear();       // tests

/**
 * Has a phone paired with THIS run of the server?
 *
 * Either signal will do, and they cover each other:
 *   · a device registered since we booted   — the handshake, and it carries the NAME
 *   · any authorized call from off-machine  — works even when registration cannot
 */
export function pairedThisSession(since = BOOTED_AT) {
  const fresh = (serverConfig().devices ?? [])
    .filter((d) => (d.pairedAt ?? 0) >= since)
    .sort((a, b) => b.pairedAt - a.pairedAt);

  const talking = clientList();
  if (!fresh.length && !talking.length) return null;

  return {
    name: fresh[0]?.name ?? null,          // null: it is here, we just do not know its name yet
    at: fresh[0]?.pairedAt ?? talking[0]?.first ?? Date.now(),
    clients: talking,
  };
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

/**
 * The same thing, squeezed. Every byte here is a QR module, and modules are the whole
 * problem: the full payload comes to 232 bytes, which forces a version-11 code — 61x61
 * modules that a phone has to resolve out of a few centimetres of terminal. It is right at
 * the edge of scannable, and a long tunnel URL pushes it over.
 *
 * Short keys, no hostname (decoration), no `tunnel` flag (derivable from the scheme). That
 * is ~60 bytes gone and two QR versions with it.
 */
export function pairingCompact(port = DEFAULT_PORT, publicUrl = null) {
  const p = pairingPayload(port, publicUrl);
  const out = { v: 1, u: p.url, t: p.token, k: p.key };
  if (p.lan && p.lan !== p.url) out.l = p.lan;
  return out;
}

/**
 * The built app, if there is one. Looked up fresh: you may build it while serving.
 *
 * Gradle writes it under app/APP/build — the module is `app` inside the project dir, also
 * called `app`. Looking one level up (app/build) found nothing, ever: `kaip app build` said
 * "✓ APK listo" and printed `null`, and /apk answered "no apk built yet" with the APK sitting
 * right there on disk. `root` is a parameter so this can be tested against a fake tree
 * instead of depending on whether someone happened to have run a build.
 */
export function apkPath(root = ROOT) {
  const out = (variant, name) =>
    path.join(root, 'app', 'app', 'build', 'outputs', 'apk', variant, name);

  const candidates = [
    path.join(root, 'app', 'kaiprompt.apk'),          // dropped in by hand / by a release
    out('release', 'app-release.apk'),
    out('debug', 'app-debug.apk'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * The pairing page. One big QR drawn as an SVG grid — no image, no font, no dependency.
 *
 * Every module is one <rect>, which is why this is crisp at any size: the phone is reading
 * geometry, not a scaled-up bitmap. That, and the sheer size, is what makes it scan where
 * the terminal version does not.
 */
function pairPage(payload) {
  const m = qrEncode(JSON.stringify(payload));
  const n = m.length;
  const quiet = 4;                                  // no margin, no scan. Not optional.
  const side = n + quiet * 2;

  const rects = [];
  for (let r = 0; r < n; r++) {
    for (let cc = 0; cc < n; cc++) {
      if (m[r][cc]) rects.push(`<rect x="${cc + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }

  return `<!doctype html><meta charset="utf-8"><title>Emparejar Kaiprompt</title>
<style>
  body{background:#0f1114;color:#e8eaed;font:16px/1.6 system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
  .qr{background:#fff;padding:20px;border-radius:16px;line-height:0}
  svg{width:min(78vw,420px);height:auto;shape-rendering:crispEdges}
  h1{color:#d97757;font-size:22px;margin:0 0 6px}
  p{color:#7c8a9a;font-size:14px;margin:6px 0}
  code{color:#d97757;font-family:ui-monospace,monospace}
</style>
<div>
  <h1>✦ Emparejar Kaiprompt</h1>
  <p>Escanéalo <b>desde la app</b>.</p>
  <div class="qr"><svg viewBox="0 0 ${side} ${side}" fill="#000">${rects.join('')}</svg></div>
  <p>${payload.u}</p>
  <p>La clave de cifrado va dentro de este código y no viaja por el túnel:<br>
     la escaneas de tu propia pantalla.</p>
</div>`;
}

/**
 * Is this request really coming from THIS machine, for this machine?
 *
 * Checking the socket address is not enough, and the gap is DNS rebinding: a page on
 * evil.com whose domain resolves to 127.0.0.1 makes the victim's own browser open the
 * connection — so the socket address IS loopback and passes — while the page's origin
 * stays evil.com, which means its JavaScript can read the response. On an endpoint that
 * hands out the token and the encryption key with no auth, that is the whole safe handed
 * over by visiting a web page.
 *
 * The Host header is what closes it: the browser sends the name the user typed
 * (evil.com), not the address it resolved to. A real localhost visit says localhost.
 */
export function fromLoopback(req) {
  const addr = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;

  const host = String(req.headers?.host || '').toLowerCase();
  const name = host.replace(/:\d+$/, '');                    // drop the port
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(name);
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
    // Written by the runner when the quota cut this job short and put it back in the queue.
    // It is the difference, from a phone, between "it is broken" and "it is waiting" — the
    // two states that look identical and mean opposite things.
    pausedUntil: job.pausedUntil ?? null,
    error: job.error ?? null,
    hasOutput: Boolean(job.output),
  };
}

/** Everything the main screen needs, in one call. */
export function stateDTO() {
  const queue = loadQueue();
  const d = daemon.status();
  const r = runnerStatus();
  const q = sessionQuota();
  const lock = lockInfo();
  const jobs = queue.map(jobDTO);

  return {
    host: os.hostname(),
    now: Date.now(),
    jobs,
    counts: ['pending', 'running', 'done', 'error', 'missed'].reduce((acc, s) => {
      acc[s] = queue.filter((j) => j.status === s).length;
      return acc;
    }, {}),
    // "Will anything actually fire?" is the question the phone most needs answered.
    // The phone kept showing a red "the daemon is off, nothing will fire" while a `kaip run`
    // in a terminal was about to fire it. The question is not whether the daemon exists —
    // it is whether ANYONE is processing the queue.
    daemon: {
      running: Boolean(r.willFire),           // "will my scheduled work go out?"
      kind: r.kind,                           // 'daemon' | 'run' | null
      durable: r.durable,                     // a `run` dies with its window; the daemon does not
      pid: r.pid ?? null,
      next: d.next ?? null,
      // Since when. The lock is rewritten every 30s as a heartbeat, but `at` is only ever set
      // when it is TAKEN, so it is the runner's real start time and not its last beat.
      since: lock.held ? lock.at : null,
    },
    quota: q ? { freePct: q.freePct, resetsAt: q.resetsAt, renewed: q.renewed } : null,

    // The one line at the top of the phone. Derived here so the terminal panel and the phone
    // cannot disagree about what this machine is doing.
    activity: activityState({ jobs, willFire: Boolean(r.willFire) }),

    // Diagnosis. Not what you look at every time — which is exactly why it lives behind
    // Settings in the app rather than shouting from the main screen.
    server: {
      version: VERSION,
      startedAt: BOOTED_AT,
      tunnel: serverConfig().publicUrl ?? null,
      clients: clientList(),
      devices: (serverConfig().devices ?? []).map((x) => ({ name: x.name, pairedAt: x.pairedAt })),
    },
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
  serverConfig();                       // mint the token now, so the pairing QR can show it

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);       // ['api', 'job', 'abc']

    // Liveness needs no token: it is how the phone knows the PC is up at all.
    if (url.pathname === '/api/ping') return json(res, { ok: true, host: os.hostname(), now: Date.now() });

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
          const name = String(dev.name || '').trim() || 'móvil';
          const url = dev.url ? String(dev.url) : null;

          // Dedupe by NAME, not by url. The url carries the phone's local IP, which changes
          // every time it joins a different wifi — so the same handset kept registering
          // itself again and again and the list filled up with ghosts of one phone. Only the
          // newest address is any use anyway: the old one is a dead socket on a network it
          // has left.
          const c2 = serverConfig();
          c2.devices = (c2.devices || []).filter((d) => d.name !== name && !(url && d.url === url));
          c2.devices.push({ url, name, pairedAt: Date.now() });
          saveServerConfig(c2);
          return json(res, { ok: true, name, devices: c2.devices.length }, 200, enc);
        });
        return undefined;
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
      console.error(`\nel puerto ${port} ya está ocupado.`);
      console.error('  casi seguro es otro "kaip serve" que sigue vivo en otra ventana.');
      console.error(`  ciérralo, o usa otro puerto:  kaip serve --port ${port + 1}\n`);
      process.exit(1);
    }
    console.error(`\nel servidor no pudo arrancar: ${e.message}\n`);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0');
  return server;
}
