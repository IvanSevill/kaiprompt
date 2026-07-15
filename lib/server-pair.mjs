// Who this server is, who is allowed to talk to it, and how a phone gets in.
//
// The secrets live here (the token and the encryption key), and so does the one rule that
// makes the Cloudflare tunnel safe: the key is minted on this machine and reaches the phone
// INSIDE the pairing QR, scanned off your own screen — it never travels the wire it protects.
//
// Split out of server.mjs, which had grown to hold the pairing, the DTOs and the HTTP
// routing all at once. Nothing here knows what a job is.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA, ROOT, readJSON, writeJSON } from './store.mjs';
import { newKey } from './crypto.mjs';
import { encode as qrEncode } from './qr.mjs';

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

/** Everyone who has spoken to this server, newest first: "who is on the other end?". */
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
export function pairedThisSession(since = BOOTED_AT, devices = 1) {
  const conf = serverConfig();
  const activeSince = Math.max(since, conf.pairingResetAt ?? 0);
  const fresh = (conf.devices ?? [])
    .filter((d) => (d.pairedAt ?? 0) >= activeSince)
    .sort((a, b) => b.pairedAt - a.pairedAt);

  // An explicit mobile unpair is a stronger fact than an old authorized request. Without
  // this boundary, the DELETE itself kept the phone in `clients` and the QR could never
  // return even though the device had just asked to leave.
  const talkingSince = activeSince;
  // A still-paired client becomes current again on its next authorized request.
  const talking = clientList().filter((client) => (client.at ?? 0) > talkingSince);
  const count = Math.max(fresh.length, talking.length);
  if (count < devices) return null;

  return {
    name: fresh[0]?.name ?? null,          // null: it is here, we just do not know its name yet
    at: fresh[0]?.pairedAt ?? talking[0]?.at ?? Date.now(),
    clients: talking,
    devices: count,
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
export function pairPage(payload) {
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

  return `<!doctype html><meta charset="utf-8"><title>Pair Kaiprompt</title>
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
  <h1>✦ Pair Kaiprompt</h1>
  <p>Scan it <b>from the app</b>.</p>
  <div class="qr"><svg viewBox="0 0 ${side} ${side}" fill="#000">${rects.join('')}</svg></div>
  <p>${payload.u}</p>
  <p>The encryption key travels inside this code, not through the tunnel:<br>
     you scan it off your own screen.</p>
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
