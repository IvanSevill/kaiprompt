import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const FETCH_STATE = Symbol.for('kaiprompt.opencode.usage-metrics.fetch');
const SCAN_CACHE_MS = 60_000;
const STALE_MS = 15 * 60_000;

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isCodexResponsesURL(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port
      && url.pathname === '/backend-api/codex/responses';
  } catch {
    return false;
  }
}

function header(headers, name) {
  try { return headers?.get?.(name) ?? null; } catch { return null; }
}

export function normalizeWindow(raw, { observedAt = Date.now(), source = 'live', now = Date.now() } = {}) {
  if (!raw) return null;
  const used = number(raw.used_percent ?? raw.used_percentage ?? raw.usedPercent);
  const duration = number(raw.window_minutes ?? raw.windowMinutes);
  const reset = timestamp(raw.reset_at ?? raw.resets_at ?? raw.resetAt ?? raw.resetsAt);
  if (used === null && duration === null && reset === null) return null;
  const usedPercent = used === null ? null : Math.min(100, Math.max(0, used));
  const observed = timestamp(observedAt) ?? now;
  return {
    used_percent: usedPercent,
    remaining_percent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    window_minutes: duration,
    resets_at: reset === null ? null : new Date(reset).toISOString(),
    observed_at: new Date(observed).toISOString(),
    source,
    stale: now - observed > STALE_MS || (reset !== null && now >= reset),
  };
}

export function classifyWindows(primary, secondary) {
  const result = { five_hour: null, weekly: null };
  for (const [name, window] of [['primary', primary], ['secondary', secondary]]) {
    if (!window) continue;
    const duration = window.window_minutes;
    if (duration !== null && Math.abs(duration - 300) <= 30) result.five_hour = window;
    else if (duration !== null && Math.abs(duration - 10080) <= 120) result.weekly = window;
    else result[name] = window;
  }
  return result;
}

export function quotaFromHeaders(headers, now = Date.now()) {
  const read = (name) => normalizeWindow({
    used_percent: header(headers, `x-codex-${name}-used-percent`),
    window_minutes: header(headers, `x-codex-${name}-window-minutes`),
    reset_at: header(headers, `x-codex-${name}-reset-at`),
  }, { observedAt: now, source: 'live', now });
  const primary = read('primary');
  const secondary = read('secondary');
  return primary || secondary ? classifyWindows(primary, secondary) : null;
}

export function installFetchObserver(target = globalThis) {
  let state = target[FETCH_STATE];
  if (state?.wrapper && target.fetch === state.wrapper) return state;
  if (typeof target.fetch !== 'function') return null;

  const original = target.fetch;
  state = { original, wrapper: null, latest: state?.latest ?? null };
  state.wrapper = async function kaipromptUsageFetch(...args) {
    const response = await original.apply(this, args);
    if (isCodexResponsesURL(args[0]) && response?.ok) {
      const quota = quotaFromHeaders(response.headers);
      if (quota) state.latest = quota;
    }
    return response;
  };
  target[FETCH_STATE] = state;
  target.fetch = state.wrapper;
  return state;
}

export function quotaFromRateLimits(rateLimits, observedAt, now = Date.now()) {
  if (!rateLimits) return null;
  const primary = normalizeWindow(rateLimits.primary, { observedAt, source: 'rollout', now });
  const secondary = normalizeWindow(rateLimits.secondary, { observedAt, source: 'rollout', now });
  return primary || secondary ? classifyWindows(primary, secondary) : null;
}

async function filesBelow(dir, found = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return found; }
  await Promise.all(entries.map(async (entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesBelow(file, found);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      try { found.push({ file, mtime: (await fs.promises.stat(file)).mtimeMs }); } catch { /* vanished */ }
    }
  }));
  return found;
}

export function rateLimitsFromEvent(event, now = Date.now()) {
  const payload = event?.payload ?? event;
  if (payload?.type !== 'token_count' && event?.type !== 'token_count') return null;
  const limits = payload?.rate_limits ?? payload?.rateLimits ?? event?.rate_limits ?? event?.rateLimits;
  return quotaFromRateLimits(limits, event?.timestamp ?? payload?.timestamp ?? now, now);
}

async function readRollout(file, now) {
  let latest = null;
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const event = JSON.parse(line);
        const quota = rateLimitsFromEvent(event, now);
        if (quota) latest = quota;
      } catch { /* incomplete or unrelated line */ }
    }
  } catch { return null; }
  return latest;
}

export function createRolloutScanner({
  sessionsDir = path.join(os.homedir(), '.codex', 'sessions'),
  cacheMs = SCAN_CACHE_MS,
} = {}) {
  let cache = { at: -Infinity, value: null };
  return async function scan(now = Date.now()) {
    if (now - cache.at < cacheMs) return cache.value;
    let value = null;
    const files = (await filesBelow(sessionsDir)).sort((a, b) => b.mtime - a.mtime);
    for (const candidate of files) {
      value = await readRollout(candidate.file, now);
      if (value) break;
    }
    cache = { at: now, value };
    return value;
  };
}

const defaultScan = createRolloutScanner();

function modelDetails(input, output) {
  const model = input?.model ?? output?.model ?? {};
  const provider = input?.provider ?? output?.provider ?? {};
  return {
    provider_id: model.providerID ?? model.provider_id ?? provider.id ?? input?.providerID ?? null,
    model_id: model.modelID ?? model.model_id ?? model.id ?? input?.modelID ?? null,
    context_limit: number(model.limit?.context ?? model.contextLimit ?? model.context_limit
      ?? output?.limit?.context ?? input?.contextLimit),
  };
}

export function contextSnapshot(session, message) {
  if (!session || !message) return null;
  const providerID = message.providerID ?? message.provider_id ?? message.provider?.id ?? null;
  const modelID = message.modelID ?? message.model_id ?? message.model?.id ?? null;
  if (session.provider_id && providerID && session.provider_id !== providerID) return null;
  if (session.model_id && modelID && session.model_id !== modelID) return null;
  const input = Math.max(0, number(message.tokens?.input) ?? 0);
  const output = Math.max(0, number(message.tokens?.output) ?? 0);
  const used = Math.max(0, input + output);
  const limit = Math.max(0, session.context_limit ?? 0);
  return {
    provider_id: session.provider_id,
    model_id: session.model_id,
    context_limit: limit || null,
    tokens: { input, output },
    occupancy: {
      tokens: used,
      percent: limit ? Math.min(100, Math.max(0, used / limit * 100)) : null,
      estimated: true,
      basis: 'tokens.input + tokens.output',
    },
    remaining_tokens: limit ? Math.max(0, limit - used) : null,
  };
}

function eventMessage(input) {
  const event = input?.event ?? input;
  if (event?.type !== 'message.updated') return null;
  return event.properties?.info ?? event.properties?.message ?? event.message ?? null;
}

export async function plugin() {
  const fetchState = installFetchObserver();
  const sessions = new Map();
  const snapshots = new Map();
  let sequence = 0;

  return {
    'chat.params': async (input, output) => {
      const sessionID = input?.sessionID ?? input?.session_id;
      if (sessionID) sessions.set(sessionID, modelDetails(input, output));
    },
    event: async (input) => {
      const message = eventMessage(input);
      if (!message || message.role !== 'assistant') return;
      const sessionID = message.sessionID ?? message.session_id;
      const session = sessions.get(sessionID);
      const snapshot = contextSnapshot(session, message);
      if (!snapshot) return;
      const messageID = message.id ?? `event-${sequence}`;
      const order = timestamp(message.time?.created ?? message.createdAt ?? message.created_at) ?? ++sequence;
      let messages = snapshots.get(sessionID);
      if (!messages) snapshots.set(sessionID, messages = new Map());
      messages.set(messageID, { order, sequence: ++sequence, snapshot });
    },
    tool: {
      usage_metrics: {
        description: 'Show current Codex quota windows and OpenCode context occupancy.',
        args: {},
        execute: async (_args, context) => {
          const live = fetchState?.latest ?? null;
          const codex = live ?? await defaultScan();
          const messages = snapshots.get(context?.sessionID);
          const latest = messages ? [...messages.values()].sort((a, b) => b.order - a.order || b.sequence - a.sequence)[0] : null;
          return JSON.stringify({
            codex: codex ?? { five_hour: null, weekly: null },
            context: latest?.snapshot ?? null,
          }, null, 2);
        },
      },
    },
  };
}

export default plugin;
