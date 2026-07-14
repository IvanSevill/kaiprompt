// Read-only usage reporting over persisted attempt history. Keep normalization here so
// every surface reports the same totals without teaching adapters' wire formats to UIs.
import fs from 'node:fs';

import { HISTORY, historyPath, loadQueue } from './store.mjs';

const number = (value) => Number.isFinite(value) ? value : null;
const firstNumber = (...values) => values.map(number).find((value) => value !== null) ?? null;

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = firstNumber(usage.input, usage.inputTokens, usage.input_tokens);
  const output = firstNumber(usage.output, usage.outputTokens, usage.output_tokens);
  const reasoning = firstNumber(usage.reasoning, usage.reasoningTokens, usage.reasoning_tokens);
  const cacheRead = firstNumber(usage.cacheRead, usage.cache_read, usage.cache_read_input_tokens);
  const cacheWrite = firstNumber(usage.cacheWrite, usage.cache_write, usage.cache_creation_input_tokens);
  const reportedTotal = firstNumber(usage.total, usage.totalTokens, usage.total_tokens);
  // A provider that omits a total still gives an exact total when it supplied both sides.
  const total = reportedTotal ?? (input !== null && output !== null ? input + output + (reasoning ?? 0) : null);
  return { input, output, reasoning, cacheRead, cacheWrite, total };
}

function attemptHistory(id) {
  try {
    return fs.readFileSync(historyPath(id), 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry?.type === 'attempt-end');
  } catch { return []; }
}

function metric() { return { value: 0, known: false, complete: true }; }
function addMetric(total, value) {
  if (value === null) { total.complete = false; return; }
  total.value += value;
  total.known = true;
}
function addUsage(total, usage) {
  for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total']) {
    addMetric(total.tokens[key], usage?.[key] ?? null);
  }
  const cost = number(usage?.cost);
  if (cost === null) total.cost.complete = false;
  else { total.cost.value += cost; total.cost.known = true; }
}
function summary(total) {
  const result = {};
  for (const [key, value] of Object.entries(total.tokens)) {
    result[key] = value.known ? { value: value.value, partial: !value.complete } : null;
  }
  result.cost = total.cost.known ? { value: total.cost.value, partial: !total.cost.complete } : null;
  return result;
}
function blankTotal() {
  return { tokens: Object.fromEntries(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'].map((key) => [key, metric()])), cost: metric() };
}

/** Aggregate completed attempts, retaining unknown provider data instead of turning it into zero. */
export function aggregateUsage({ engine, provider, target, session } = {}, jobs = loadQueue()) {
  const totals = blankTotal();
  const sessions = new Map();
  // Finished jobs can leave the visible queue without erasing the accounting record. Histories
  // are append-only; queue metadata simply enriches old records while it is still available.
  const live = new Map(jobs.map((job) => [job.id, job]));
  try {
    for (const file of fs.readdirSync(HISTORY)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.slice(0, -'.jsonl'.length);
      if (!live.has(id)) live.set(id, { id });
    }
  } catch { /* no history yet */ }
  for (const job of live.values()) {
    for (const attempt of attemptHistory(job.id)) {
      const record = {
        engine: attempt.engine ?? job.adapter ?? 'claude',
        provider: attempt.provider ?? job.provider ?? null,
        target: attempt.target ?? job.target ?? null,
        session: attempt.sessionId ?? job.sessionId ?? null,
        jobId: job.id,
      };
      if ((engine && record.engine !== engine) || (provider && record.provider !== provider)
        || (target && record.target !== target) || (session && record.session !== session)) continue;

      const key = [record.engine, record.provider ?? '', record.target ?? '', record.session ?? `job:${job.id}`].join('\u0000');
      if (!sessions.has(key)) sessions.set(key, { ...record, attempts: 0, total: blankTotal() });
      const row = sessions.get(key);
      const usage = normalizeUsage(attempt.usage);
      if (usage) usage.cost = attempt.cost;
      // Cost can exist even when an engine has no token data.
      addUsage(row.total, usage ? usage : { cost: attempt.cost });
      addUsage(totals, usage ? usage : { cost: attempt.cost });
      row.attempts++;
    }
  }
  return {
    filters: { engine: engine ?? null, provider: provider ?? null, target: target ?? null, session: session ?? null },
    sessions: [...sessions.values()].map(({ total, ...row }) => ({ ...row, usage: summary(total) })),
    totals: summary(totals),
  };
}
