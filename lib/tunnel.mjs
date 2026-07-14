// The Cloudflare tunnel: how the phone reaches this machine from anywhere.
//
// `cloudflared` opens a connection OUTWARDS and Cloudflare hands back a public HTTPS URL
// that points at it. No port forwarding, no router config, and — the reason we are here at
// all — no VPN on the phone, so a firewall app like NetGuard keeps its one VPN slot.
//
// The price is that Cloudflare terminates the TLS and could read what passes through. That
// is exactly what lib/crypto.mjs takes away from them: the payload is sealed with a key
// that only this machine and your phone have. They carry an envelope they cannot open.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class TunnelError extends Error {}

/**
 * Find cloudflared, PATH or no PATH.
 *
 * An installer (winget, brew) puts it on the PATH — but only for shells opened *afterwards*.
 * The very first thing anyone does is install it and immediately retry in the same window,
 * where it is still "not recognized". Telling them to open a new terminal is a poor answer
 * when we can simply look where it lives.
 */
export function findCloudflared() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const known = process.platform === 'win32'
    ? [
      path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'cloudflared', exe),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'cloudflared', exe),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', exe),
    ]
    : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];

  return known.find((p) => p && fs.existsSync(p)) || 'cloudflared';   // else trust the PATH
}

/**
 * Start a quick tunnel to `port` and resolve with its public URL.
 *
 * Quick tunnels need no Cloudflare account and no login — which matters, because a tool
 * nobody can try without signing up for something is a tool nobody tries. The URL changes
 * every run, so the phone re-pairs; a named tunnel (stable URL) is the upgrade path once
 * you care.
 */
export function startTunnel(port, { timeoutMs = 30_000, bin = findCloudflared() } = {}) {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32';

    // Through a shell, a path with spaces has to be quoted or cmd reads "C:\Program" as the
    // command and everything after it as arguments. cloudflared installs to "Program Files
    // (x86)" by default, so this is not an edge case — it is the normal case.
    const cmd = shell && bin.includes(' ') ? `"${bin}"` : bin;

    let child;
    try {
      child = spawn(cmd, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell,
      });
    } catch (e) {
      return reject(new TunnelError(notInstalled(e.message)));
    }

    let settled = false;
    let log = '';

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    // cloudflared announces the URL on stderr, not stdout — watching only stdout is the
    // classic way to sit there forever convinced it never started.
    const onData = (chunk) => {
      log += chunk.toString();
      const m = log.match(URL_RE);
      if (m) done(resolve, { url: m[0], child, stop: () => child.kill() });
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => done(reject, new TunnelError(
      e.code === 'ENOENT' ? notInstalled() : `cloudflared failed: ${e.message}`
    )));

    child.on('exit', (code) => {
      // On Windows we spawn through a shell, and a missing binary does NOT come back as
      // ENOENT: cmd exits 1 and prints "is not recognized". Without this the helpful
      // "here is how to install it" message never fires on the one platform where it is
      // most needed, and you get cmd's raw complaint instead.
      if (/not recognized|not found|no such file/i.test(log)) {
        return done(reject, new TunnelError(notInstalled()));
      }
      done(reject, new TunnelError(
        `cloudflared exited (code ${code}) before giving a URL.\n${log.trim().split('\n').slice(-3).join('\n')}`
      ));
    });

    const timer = setTimeout(() => {
      child.kill();
      done(reject, new TunnelError('cloudflared did not produce a URL in time. Is the network up?'));
    }, timeoutMs);
  });
}

/**
 * Wait until the tunnel URL actually ANSWERS.
 *
 * This is the bug where "the phone does not connect the first time, and a minute later it
 * does". cloudflared prints the URL the moment Cloudflare *assigns* it — not when the edge
 * has finished routing to it. For the next few seconds that hostname is live DNS pointing at
 * a route that does not exist yet, and it answers 502/530.
 *
 * `serve` painted the QR the instant that line appeared, and you are standing right there
 * with the phone already out — so the very first request the app ever makes is the one that
 * lands in the gap. It fails, and the failure looks like a broken pairing rather than a
 * tunnel that was not up yet. Wait a bit, retry, and by then it works.
 *
 * So we ask the tunnel ourselves, from here, and do not hand out a QR until it has answered.
 * A QR pointing at a door that does not exist yet is worse than two seconds of waiting: the
 * two seconds cost you two seconds, and the QR costs you the trust that the thing works.
 *
 * /api/ping needs no token, which is exactly why it is the right probe: it proves the whole
 * path (Cloudflare edge → tunnel → our server) end to end, with nothing else able to fail.
 */
export async function waitForTunnel(url, { timeoutMs = 30_000, now = () => Date.now(), fetchFn = fetch, sleep = defaultSleep } = {}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last = null;

  while (now() < deadline) {
    attempts++;
    try {
      const res = await fetchFn(`${url}/api/ping`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { ok: true, attempts };
      last = `HTTP ${res.status}`;               // 502/530: the edge is up, the route is not
    } catch (e) {
      last = e.message;                          // DNS not propagated yet, usually
    }
    await sleep(1000);
  }

  // Not fatal. The tunnel may still come up a moment after we stop asking, and refusing to
  // print a QR at all would be a worse failure than printing one that needs a retry — so the
  // caller warns and carries on rather than dying here.
  return { ok: false, attempts, error: last };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const notInstalled = (extra = '') =>
  'cloudflared is not installed.\n'
  + '  Windows:  winget install --id Cloudflare.cloudflared\n'
  + '  macOS:    brew install cloudflared\n'
  + '  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n'
  + '  (no Cloudflare account needed — quick tunnels are anonymous)'
  + (extra ? `\n  ${extra}` : '');
