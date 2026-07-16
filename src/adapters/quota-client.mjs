import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fileInvocation(value, fsImpl = fs) {
  if (!value) return null;
  let target = path.resolve(String(value));
  try {
    if (fsImpl.statSync(target).isDirectory()) target = path.join(target, 'usage.mjs');
    if (!fsImpl.statSync(target).isFile()) return null;
  } catch { return null; }
  return { command: process.execPath, args: [target], label: target, shell: false };
}

function pathInvocation(env, fsImpl = fs) {
  const names = process.platform === 'win32'
    ? ['claude-usage.cmd', 'claude-usage.exe', 'claude-usage.bat', 'claude-usage']
    : ['claude-usage'];
  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      try {
        if (!fsImpl.statSync(candidate).isFile()) continue;
        return {
          command: candidate,
          args: [],
          label: candidate,
          shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate),
        };
      } catch { /* keep searching PATH */ }
    }
  }
  return null;
}

export function claudeUsageCandidates({ env = process.env, root = ROOT, fsImpl = fs } = {}) {
  const candidates = [];
  const configured = fileInvocation(env.CLAUDE_USAGE_PATH, fsImpl);
  if (configured) candidates.push(configured);
  const sibling = fileInvocation(path.resolve(root, '..', 'claude-usage', 'usage.mjs'), fsImpl);
  if (sibling && !candidates.some((item) => item.label === sibling.label)) candidates.push(sibling);
  const executable = pathInvocation(env, fsImpl);
  if (executable && !candidates.some((item) => item.label === executable.label)) candidates.push(executable);
  return candidates;
}

function execute(candidate, args, spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(candidate.command, [...candidate.args, ...args], {
        stdio: 'inherit',
        windowsHide: true,
        shell: candidate.shell,
      });
    } catch (error) { resolve({ error }); return; }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

function executeCaptured(candidate, args, spawn, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(candidate.command, [...candidate.args, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: candidate.shell,
      });
    } catch (error) { resolve({ error }); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ error: Object.assign(new Error('claude-usage timed out'), { code: 'timeout' }) });
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

const quotaError = (provider, code, message = null) => ({
  provider,
  status: code === 'unavailable' ? 'unavailable' : 'error',
  source: { kind: null, official: null, observedAt: new Date().toISOString(), stale: null },
  freshness: { observedAt: new Date().toISOString(), stale: null },
  limits: {},
  plan: null,
  credits: null,
  error: { code, message },
});

function apiSnapshot(provider, snapshot) {
  const source = snapshot?.source && typeof snapshot.source === 'object' ? snapshot.source : {};
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  return {
    provider,
    status: typeof snapshot?.status === 'string' ? snapshot.status : 'error',
    source: {
      kind: source.kind ?? null,
      official: typeof source.official === 'boolean' ? source.official : null,
    },
    freshness: {
      observedAt: source.observedAt ?? null,
      stale: typeof source.stale === 'boolean' ? source.stale : null,
    },
    limits: snapshot?.limits && typeof snapshot.limits === 'object' && !Array.isArray(snapshot.limits)
      ? snapshot.limits : {},
    plan: snapshot?.plan ?? null,
    credits: snapshot?.credits ?? null,
    error: errors[0] ?? null,
  };
}

export async function runClaudeUsage(args, {
  env = process.env, root = ROOT, spawn = nodeSpawn, fsImpl = fs,
} = {}) {
  const candidates = claudeUsageCandidates({ env, root, fsImpl });
  const failures = [];
  for (const candidate of candidates) {
    const result = await execute(candidate, args, spawn);
    if (!result.error) {
      return {
        status: 'completed',
        exitCode: Number.isInteger(result.code) ? result.code : 2,
        signal: result.signal ?? null,
        path: candidate.label,
      };
    }
    failures.push({ path: candidate.label, code: result.error.code ?? 'spawn-error' });
  }
  return {
    status: 'unavailable',
    exitCode: 2,
    path: null,
    failures,
    message: 'claude-usage is not installed or could not be launched. Set CLAUDE_USAGE_PATH to its usage.mjs or clone it beside Kaiprompt.',
  };
}

/** Read the canonical provider-neutral schema without exposing credentials or tool stderr. */
export async function fetchQuotaSchema(provider, {
  env = process.env, root = ROOT, spawn = nodeSpawn, fsImpl = fs, timeoutMs = 12_000,
} = {}) {
  if (!['claude', 'codex'].includes(provider)) throw new TypeError('provider must be claude or codex');
  const candidates = claudeUsageCandidates({ env, root, fsImpl });
  if (candidates.length === 0) {
    return quotaError(provider, 'unavailable', 'claude-usage is not installed');
  }
  const failures = [];
  for (const candidate of candidates) {
    const result = await executeCaptured(candidate, ['--schema', '--provider', provider], spawn, timeoutMs);
    if (result.error) {
      failures.push(result.error.code ?? 'spawn-error');
      continue;
    }
    try {
      return apiSnapshot(provider, JSON.parse(result.stdout));
    } catch {
      failures.push(result.code === 0 ? 'invalid-schema' : 'tool-error');
    }
  }
  return quotaError(provider, failures.at(-1) ?? 'unavailable', 'claude-usage did not return valid schema JSON');
}

/** Provider-scoped TTL cache plus in-flight sharing prevents polling from multiplying subprocesses. */
export function createQuotaLoader({ fetch = fetchQuotaSchema, ttlMs = 15_000, now = Date.now } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  return function loadQuota(provider) {
    const cached = cache.get(provider);
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inFlight.has(provider)) return inFlight.get(provider);
    const pending = Promise.resolve().then(() => fetch(provider)).then((value) => {
      cache.set(provider, { at: now(), value });
      return value;
    }).finally(() => inFlight.delete(provider));
    inFlight.set(provider, pending);
    return pending;
  };
}
