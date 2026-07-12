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

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class TunnelError extends Error {}

/**
 * Start a quick tunnel to `port` and resolve with its public URL.
 *
 * Quick tunnels need no Cloudflare account and no login — which matters, because a tool
 * nobody can try without signing up for something is a tool nobody tries. The URL changes
 * every run, so the phone re-pairs; a named tunnel (stable URL) is the upgrade path once
 * you care.
 */
export function startTunnel(port, { timeoutMs = 30_000, bin = 'cloudflared' } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
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

    child.on('exit', (code) => done(reject, new TunnelError(
      `cloudflared exited (code ${code}) before giving a URL.\n${log.trim().split('\n').slice(-3).join('\n')}`
    )));

    const timer = setTimeout(() => {
      child.kill();
      done(reject, new TunnelError('cloudflared did not produce a URL in time. Is the network up?'));
    }, timeoutMs);
  });
}

const notInstalled = (extra = '') =>
  'cloudflared is not installed.\n'
  + '  Windows:  winget install --id Cloudflare.cloudflared\n'
  + '  macOS:    brew install cloudflared\n'
  + '  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n'
  + '  (no Cloudflare account needed — quick tunnels are anonymous)'
  + (extra ? `\n  ${extra}` : '');
