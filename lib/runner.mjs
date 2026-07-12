// The runner: processes the queue, shows a full-screen countdown while waiting
// and a live view of what Claude is doing while a launch runs.
//
// Non-TTY (Task Scheduler, background, piped output) → plain log, no TUI.
// That path must never break: the unattended 3am batch depends on it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ADAPTERS, OUT, ROOT, importProgramados, loadQueue, loadSessions, nowMs,
  outPath, patchJob, preview, saveQueue, saveSessions,
} from './store.mjs';
import { fmt, fmtTime, hhmmss, humanDur } from './time.mjs';
import {
  altEnter, bar, bigText, bigWidth, box, c, centerLine, installCleanup,
  isTTY, paint, size, SPINNER, trunc,
} from './ui.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadAdapter(name) {
  const p = path.join(ADAPTERS, `${name || 'claude'}.mjs`);
  if (!fs.existsSync(p)) throw new Error(`unknown adapter: "${name}" (check the adapters/ folder)`);
  return import(pathToFileURL(p).href);
}

/** Pick what runs next: due scheduled jobs first (earliest), then sequential ones. */
function nextUp(pending, t = nowMs()) {
  const due = pending.filter((j) => j.when && j.when <= t).sort((a, b) => a.when - b.when);
  const seq = pending.filter((j) => !j.when);
  return { job: due[0] || seq[0], due, seq };
}

/** Run one job through its adapter, persist the output, the status and the session. */
export async function executeJob(job, { dryRun = false, onEvent } = {}) {
  const sessions = loadSessions();
  const key = job.target;
  const sid = job.sessionId || (key && sessions[key]?.sessionId) || null;
  const adapter = await loadAdapter(job.adapter);

  const res = await adapter.run({
    prompt: job.prompt, sessionId: sid, dryRun, dir: job.dir || null,
    permMode: job.permMode || null, onEvent,
  });

  const file = outPath(job.id);
  fs.writeFileSync(file, (res.output ?? '') + (res.error ? `\n\n[ERROR] ${res.error}` : '') + '\n');
  job.status = res.ok ? 'done' : 'error';
  job.finishedAt = nowMs();
  job.output = path.relative(ROOT, file).replace(/\\/g, '/');
  if (res.sessionId) {
    job.sessionId = res.sessionId;
    if (key) {
      sessions[key] = { sessionId: res.sessionId, adapter: job.adapter, updatedAt: nowMs() };
      saveSessions(sessions);
    }
  }
  return res;
}

// --- live event → one display line -------------------------------------------
const ARG_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'prompt', 'query'];

function eventLines(evt, cols) {
  const out = [];
  if (evt.type === 'system' && evt.subtype === 'init') {
    out.push(c.muted(`  session ${String(evt.session_id || '').slice(0, 8)}…`));
    return out;
  }
  if (evt.type !== 'assistant') return out;
  const blocks = evt.message?.content;
  if (!Array.isArray(blocks)) return out;

  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) {
      out.push(c.accent('⏺') + ' ' + trunc(b.text, cols - 4));
    } else if (b.type === 'tool_use') {
      const k = ARG_KEYS.find((key) => b.input?.[key]);
      const arg = k ? trunc(String(b.input[k]), Math.max(10, cols - b.name.length - 8)) : '';
      out.push(c.accent('⏺') + ' ' + c.bold(b.name) + c.muted(arg ? `(${arg})` : ''));
    }
  }
  return out;
}

// --- frames ------------------------------------------------------------------
function jobCard(job, title, cols) {
  const w = Math.min(cols - 8, 64);
  const meta = [
    job.target ? c.muted('target ') + job.target : null,
    job.dir ? c.muted('folder ') + path.basename(String(job.dir).replace(/[\\/]+$/, '')) : null,
    c.muted('perm ') + (job.permMode || 'bypass'),
  ].filter(Boolean).join(c.muted(' · '));
  return box([trunc(job.prompt, w), meta], { title, cols: w });
}

function clockFrame(job, next, pendingCount, startedAt) {
  const { cols, rows } = size();
  const remaining = Math.max(0, next - nowMs());
  const total = Math.max(1, next - startedAt);
  const pct = ((total - remaining) / total) * 100;

  const clock = bigText(hhmmss(remaining));
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - bigWidth(hhmmss(remaining))) / 2)));

  const body = [
    ...jobCard(job, 'next launch', cols).map((l) => centerLine(l, cols)),
    '',
    ...clock.map((l) => pad + l),
    '',
    centerLine(bar(pct, Math.min(40, cols - 20)), cols),
    '',
    centerLine(c.muted(`starts at ${fmtTime(next)} · ${pendingCount} pending`), cols),
    centerLine(c.muted('Ctrl+C to stop'), cols),
  ];

  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  return [...Array(top).fill(''), ...body];
}

function runningFrame(job, lines, startedAt, tick) {
  const { cols, rows } = size();
  const spin = c.accent(SPINNER[tick % SPINNER.length]);
  const head = jobCard(job, `running · ${job.id}`, cols);
  const elapsed = c.muted(`${spin} ${humanDur(nowMs() - startedAt)} elapsed · Ctrl+C to stop`);

  const room = Math.max(3, rows - head.length - 4);
  const feed = lines.slice(-room);
  return [...head, '', ...feed, '', elapsed];
}

// --- plain (non-TTY) ---------------------------------------------------------
async function runPlain({ once }) {
  for (;;) {
    const q = loadQueue();
    const pending = q.filter((j) => j.status === 'pending');
    if (!pending.length) { console.log('empty queue; nothing pending.'); return; }

    const { job } = nextUp(pending);
    if (!job) {
      const next = Math.min(...pending.map((j) => j.when));
      if (once) { console.log(`${pending.length} remaining (next: ${fmt(next)}); --once won't wait.`); return; }
      console.log(`waiting for the next scheduled launch: ${fmt(next)}`);
      await sleep(Math.max(1000, Math.min(next - nowMs(), 60000)));
      continue;
    }

    job.status = 'running'; job.startedAt = nowMs();
    patchJob(job);
    console.log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}] ${preview(job.prompt)}`);
    let res;
    try { res = await executeJob(job); }
    catch (e) { job.status = 'error'; job.finishedAt = nowMs(); res = { ok: false, error: e.message }; }
    patchJob(job);
    console.log(res.ok
      ? `  ✓ done → ${job.output}${job.sessionId ? '  (session ' + String(job.sessionId).slice(0, 8) + '…)' : ''}`
      : `  ✗ error: ${res.error}`);
  }
}

// --- TUI ---------------------------------------------------------------------
async function runTUI({ once }) {
  const restore = installCleanup();
  altEnter();
  try {
    for (;;) {
      const q = loadQueue();
      const pending = q.filter((j) => j.status === 'pending');
      if (!pending.length) break;

      const { job } = nextUp(pending);

      if (!job) {                                   // only future scheduled jobs left
        const next = Math.min(...pending.map((j) => j.when));
        if (once) break;
        const upcoming = pending.find((j) => j.when === next);
        const waitStart = nowMs();
        while (nowMs() < next) {                    // 1-second countdown tick
          paint(clockFrame(upcoming, next, pending.length, waitStart));
          await sleep(1000);
        }
        continue;
      }

      // --- run it, streaming what Claude does ---
      job.status = 'running'; job.startedAt = nowMs();
      patchJob(job);

      const { cols } = size();
      const lines = [];
      let tick = 0;
      const draw = () => paint(runningFrame(job, lines, job.startedAt, tick));
      draw();
      const spinner = setInterval(() => { tick++; draw(); }, 150);

      let res;
      try {
        res = await executeJob(job, {
          onEvent: (evt) => { lines.push(...eventLines(evt, cols)); },
        });
      } catch (e) {
        job.status = 'error'; job.finishedAt = nowMs();
        res = { ok: false, error: e.message };
      } finally {
        clearInterval(spinner);
      }
      patchJob(job);

      lines.push('', res.ok
        ? c.ok('✓ done') + c.muted(` · ${humanDur(nowMs() - job.startedAt)} · out/${job.id}.txt`)
        : c.err('✗ error') + c.muted(` · ${res.error}`));
      paint(runningFrame(job, lines, job.startedAt, tick));
      await sleep(1200);                            // let the result be read
    }
  } finally {
    restore();
  }

  // Back on the normal screen: leave a short summary behind.
  const q = loadQueue();
  const left = q.filter((j) => j.status === 'pending');
  if (!left.length) console.log('empty queue; nothing pending.');
  else console.log(`${left.length} scheduled remaining (next: ${fmt(Math.min(...left.map((j) => j.when)))}).`);
}

// --- dry run ------------------------------------------------------------------
async function dryRunPreview() {
  const pending = loadQueue().filter((j) => j.status === 'pending');
  if (!pending.length) return console.log('(nothing pending)');
  console.log('— dry-run: nothing will actually execute —');
  const t = nowMs();
  const { due, seq } = nextUp(pending, t);
  for (const job of [...due, ...seq]) {
    const sid = job.sessionId || loadSessions()[job.target]?.sessionId || null;
    const adapter = await loadAdapter(job.adapter);
    const res = await adapter.run({
      prompt: job.prompt, sessionId: sid, dryRun: true,
      dir: job.dir || null, permMode: job.permMode || null,
    });
    console.log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}]`);
    console.log('   ' + String(res.output || '').replace(/\n/g, '\n   '));
  }
  const future = pending.filter((j) => j.when && j.when > t);
  if (future.length) {
    console.log(`(+${future.length} scheduled: next ${fmt(Math.min(...future.map((j) => j.when)))})`);
  }
}

export async function runQueue({ once = false, dryRun = false } = {}) {
  const imp = importProgramados();
  if (imp) console.log(`(imported ${imp} from programados.jsonl)`);
  if (dryRun) return dryRunPreview();
  return isTTY() ? runTUI({ once }) : runPlain({ once });
}
