// Chat viewer: find and render the transcript of a launch's session.
//
// Claude Code writes one JSONL transcript per session, under the *encoded* project
// folder: ~/.claude/projects/<encoded-dir>/<session-id>.jsonl. A launch only knows
// its session id, so we go: target | job id | session id → session id → transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadQueue, loadSessions } from '../src/storage/repositories.mjs';
import { outPath } from '../src/storage/paths.mjs';
import { fmt } from '../src/core/time.mjs';
import { resolvePrompt } from '../src/core/prompt.mjs';
import { box, c, size, toolSummary, trunc, wrap } from './ui.mjs';
import { normalizeOpenCodeContent } from '../src/adapters/opencode-normalize.mjs';
import { normalizeToolDiffs } from '../src/events/tool-normalize.mjs';

/** ~/.claude — CLAUDE_CONFIG_DIR wins, same env var Claude Code itself honours. */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectsRoot = () => path.join(claudeHome(), 'projects');

/** How Claude Code flattens a folder into a project name: ':' '\' '/' and '.' → '-'. */
export const encodeDir = (dir) => String(dir ?? '').replace(/[:\\/.]/g, '-');

/**
 * What the user typed → which session to show.
 * A saved target wins, then a job id, then it's taken as a raw session id.
 */
export function resolveChatRef(ref, { pendingExternal = false } = {}) {
  if (!ref) throw new Error('usage: kaip chat <id|target|session-id> [--last N] [--full] [--raw]');
  const queue = loadQueue();
  const sessions = loadSessions();
  const jobsOf = (sid) => queue.filter((j) => j.sessionId === sid);

  const savedEntry = sessions[ref];
  const saved = savedEntry?.engines ? Object.values(savedEntry.engines).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] : savedEntry;
  if (saved?.sessionId) return {
    sessionId: saved.sessionId, target: ref, adapter: saved.adapter,
    provider: saved.provider ?? null, model: saved.model ?? null, dir: saved.dir ?? null,
    jobs: jobsOf(saved.sessionId),
  };

  const job = queue.find((j) => j.id === ref);
  if (job) {
    if (!job.sessionId) {
      if (pendingExternal && ['opencode', 'codex'].includes(job.adapter)) return {
        sessionId: `job:${job.id}`, target: job.target || null, adapter: job.adapter,
        provider: job.provider ?? null, model: job.model ?? null, dir: job.dir ?? null,
        jobs: [job],
      };
      throw new Error(`job "${ref}" has no session yet: it is ${job.status} `
        + '(a session only exists once the launch has run)');
    }
    return {
      sessionId: job.sessionId, target: job.target || null, adapter: job.adapter,
      provider: job.provider ?? null, model: job.model ?? null, dir: job.dir ?? null,
      jobs: jobsOf(job.sessionId),
    };
  }

  if (pendingExternal && sessions[ref] == null) {
    const targetJobs = queue.filter((candidate) => candidate.target === ref);
    const recent = targetJobs.at(-1);
    if (recent && ['opencode', 'codex'].includes(recent.adapter)) return {
      sessionId: recent.sessionId ?? `job:${recent.id}`, target: ref, adapter: recent.adapter,
      provider: recent.provider ?? null, model: recent.model ?? null, dir: recent.dir ?? null,
      jobs: recent.sessionId
        ? queue.filter((candidate) => candidate.adapter === recent.adapter && candidate.sessionId === recent.sessionId)
        : targetJobs.filter((candidate) => candidate.adapter === recent.adapter && !candidate.sessionId),
    };
  }

  const target = Object.keys(sessions).find((k) => Object.values(sessions[k]?.engines ?? { [sessions[k]?.adapter ?? 'claude']: sessions[k] }).some((s) => s?.sessionId === ref)) || null;
  const record = target
    ? Object.values(sessions[target]?.engines ?? { [sessions[target]?.adapter ?? 'claude']: sessions[target] }).find((s) => s?.sessionId === ref)
    : null;
  const jobs = jobsOf(ref);
  const recent = jobs.at(-1);
  return {
    sessionId: ref, target, adapter: record?.adapter ?? recent?.adapter ?? null,
    provider: record?.provider ?? recent?.provider ?? null,
    model: record?.model ?? recent?.model ?? null,
    dir: record?.dir ?? recent?.dir ?? null, jobs,
  };
}

export const resolveRef = (ref) => resolveChatRef(ref);

/**
 * Everything needed to walk INTO a conversation: which session, and in which folder.
 *
 * The folder matters as much as the id. Claude Code sessions are per-directory — a
 * `--resume` from the wrong place simply will not find the session, which is exactly the
 * "no lo encuentra con dichas credenciales" dead end.
 */
export function resumeTarget(ref) {
  const resolved = resolveRef(ref);
  const { sessionId, target, jobs } = resolved;
  const adapter = resolved.adapter || 'claude';
  if (!sessionId) throw new Error(`no session for "${ref}"`);

  // Where to look for the folder, in order of how sure we are:
  //   1. a job that actually RAN in this session — it knows where it ran
  //   2. any job queued against the same target — not proof, but the same intent
  //   3. the transcript itself, which records the cwd it was created in
  //
  // Only (1) existed, and it is the one case that does NOT hold for a session attached by
  // hand with `sessions set`: nothing has run in it yet, so there is no job to ask. That is
  // exactly when you most want to walk into the conversation you were already having.
  const byTarget = target ? loadQueue().filter((j) => j.target === target) : [];
  const dir = resolved.dir
    || jobs.find((j) => j.dir)?.dir
    || byTarget.find((j) => j.dir)?.dir
    || (adapter === 'claude' ? dirFromTranscript(sessionId) : null);

  if (!dir) {
    throw new Error(`don't know which folder session ${sessionId} belongs to.\n`
      + `  ${adapter} sessions need their recorded folder to resume reliably.`);
  }

  // A folder that has since been renamed or deleted is the real cause of the baffling
  // "spawn cmd.exe ENOENT": Node reports ENOENT for the SHELL when the cwd is missing,
  // which sends you hunting for a broken cmd.exe that is perfectly fine.
  if (!fs.existsSync(dir)) {
    throw new Error(`the folder this session ran in is gone: ${dir}\n`
      + '  it was moved, renamed or deleted. The transcript is still readable with "chat",\n'
      + `  but ${adapter} cannot resume a session outside its folder.`);
  }
  return { ...resolved, adapter, dir };
}

/** The command that drops you into that conversation, for real. */
export function resumeSpec({ adapter = 'claude', dir, sessionId, provider, model }) {
  if (!sessionId) throw new Error('no session to resume');
  const cwd = dir || '.';
  if (adapter === 'opencode') {
    const selected = model && provider && !String(model).includes('/') ? `${provider}/${model}` : model;
    return { command: 'opencode', args: ['--session', sessionId, ...(selected ? ['--model', selected] : [])], cwd };
  }
  if (adapter === 'codex') {
    return { command: 'codex', args: ['resume', ...(model ? ['--model', model] : []), sessionId], cwd };
  }
  if (adapter !== 'claude') throw new Error(`cannot interactively resume adapter "${adapter}"`);
  return { command: 'claude', args: [...(model ? ['--model', model] : []), '--resume', sessionId], cwd };
}

const shellArg = (value) => /[\s"]/u.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
export const resumeCommand = (target) => {
  const spec = resumeSpec(target);
  return `cd "${spec.cwd}" && ${spec.command} ${spec.args.map(shellArg).join(' ')}`;
};

/**
 * The last resort, and the most reliable one: the transcript records the `cwd` it was
 * written in. If a conversation exists at all, it knows where it happened.
 */
function dirFromTranscript(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return null;
  try { return parseTranscript(file).cwd || null; }
  catch { return null; }
}

/**
 * Locate <session-id>.jsonl. The job's folder tells us where to look; if that misses
 * (the job ran elsewhere, or we only got a bare session id) we sweep every project.
 */
export function findTranscript(sessionId, dirs = []) {
  const root = projectsRoot();
  const file = `${sessionId}.jsonl`;

  for (const dir of dirs.filter(Boolean)) {
    const hit = path.join(root, encodeDir(dir), file);
    if (fs.existsSync(hit)) return hit;
  }

  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }                                  // no ~/.claude/projects at all
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const hit = path.join(root, p.name, file);
    if (fs.existsSync(hit)) return hit;
  }
  return null;
}

/** user content is a string; assistant content is an array of blocks. Normalize both. */
const blocksOf = (content) => {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
};

/**
 * JSONL → the conversation. Keeps only real turns: the transcript also carries
 * bookkeeping entries (attachment, queue-operation, mode, ai-title…) that aren't chat.
 */
export function parseTranscript(file) {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const turns = [];
  let cwd = null;

  for (const line of raw) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.isMeta) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;

    const blocks = blocksOf(e.message?.content);
    if (!blocks.length) continue;
    turns.push({
      role: e.type,
      blocks,
      timestamp: e.timestamp || null,
      sidechain: !!e.isSidechain,
      // A user turn made only of tool_result blocks is the tool's echo, not the human.
      toolResult: e.type === 'user' && blocks.every((b) => b.type === 'tool_result'),
      // Claude Code writes its own errors into the transcript as `assistant` turns flagged
      // with this — the quota cut-off among them. Without the flag they are indistinguishable
      // from Claude simply *talking about* a limit, which is what cutshort.mjs turns on.
      apiError: !!e.isApiErrorMessage,
      raw: line,
    });
  }

  const stamped = turns.filter((t) => t.timestamp);
  return {
    file, cwd, turns,
    first: stamped.at(0)?.timestamp || null,
    last: stamped.at(-1)?.timestamp || null,
  };
}

const openCodeTime = (value) => {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Normalize `opencode export` into the same transcript shape used for Claude JSONL. */
export function normalizeOpenCodeExport(data, sessionId = null) {
  const messages = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
  const turns = [];
  for (const message of messages) {
    const info = message?.info ?? message?.message ?? {};
    const role = info.role ?? message?.role ?? message?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = message?.parts ?? info.parts ?? info.content ?? message?.content;
    const blocks = normalizeOpenCodeContent(content);
    if (!blocks.length) continue;
    turns.push({
      role, blocks,
      timestamp: openCodeTime(info.time?.created ?? info.createdAt ?? message?.timestamp),
      sidechain: false,
      toolResult: role === 'user' && blocks.every((block) => block.type === 'tool_result'),
      apiError: false,
      raw: JSON.stringify(message),
    });
  }
  const stamped = turns.filter((turn) => turn.timestamp);
  return {
    sessionId: data?.info?.id ?? sessionId,
    title: data?.info?.title ?? data?.title ?? null,
    file: null,
    cwd: data?.info?.directory ?? data?.directory ?? null,
    turns,
    first: stamped.at(0)?.timestamp ?? null,
    last: stamped.at(-1)?.timestamp ?? null,
  };
}

const externalAdapter = (adapter) => ['opencode', 'codex'].includes(adapter);

function queueConversation(resolved) {
  const turns = [];
  for (const job of resolved.jobs) {
    let prompt = '';
    try { prompt = resolvePrompt(job); } catch { /* the caller can still show the job error */ }
    if (prompt) turns.push({
      role: 'user', blocks: [{ type: 'text', text: prompt }],
      timestamp: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      sidechain: false, toolResult: false, apiError: false, raw: JSON.stringify({ role: 'user', content: prompt }),
    });
    let output = '';
    try { output = fs.readFileSync(outPath(job.id), 'utf8').trim(); } catch { /* no result yet */ }
    if (output || job.error) turns.push({
      role: 'assistant', blocks: [{ type: 'text', text: output || String(job.error) }],
      timestamp: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      sidechain: false, toolResult: false, apiError: false,
      raw: JSON.stringify({ role: 'assistant', content: output || String(job.error) }),
    });
  }
  const stamped = turns.filter((turn) => turn.timestamp);
  return {
    sessionId: resolved.sessionId, title: null, file: null, cwd: resolved.dir ?? resolved.jobs.find((job) => job.dir)?.dir ?? null,
    turns, first: stamped.at(0)?.timestamp ?? null, last: stamped.at(-1)?.timestamp ?? null,
  };
}

/** Resolve a reference and load one canonical transcript, including external queue fallback. */
export function loadConversation(ref, { openCodeRun, pendingExternal = false } = {}) {
  const resolved = resolveChatRef(ref, { pendingExternal });
  const dirs = [...new Set([resolved.dir, ...resolved.jobs.map((job) => job.dir)].filter(Boolean))];
  const adapter = resolved.adapter ?? resolved.jobs.at(-1)?.adapter ?? null;
  const external = externalAdapter(adapter) || resolved.jobs.some((job) => externalAdapter(job.adapter));
  const file = external ? null : findTranscript(resolved.sessionId, dirs);
  const exported = adapter === 'opencode'
    ? loadOpenCodeTranscript(resolved.sessionId, { ...(openCodeRun ? { run: openCodeRun } : {}) })
    : null;
  if (exported) return { resolved, chat: exported, dirs, source: 'export' };
  if (file) return { resolved, chat: parseTranscript(file), dirs, source: 'transcript' };
  if (external) return { resolved, chat: queueConversation(resolved), dirs, source: 'fallback' };
  return { resolved, chat: null, dirs, source: null };
}

/** Export with a bounded process; failures and malformed output fall back to queue/output. */
export function loadOpenCodeTranscript(sessionId, { run = spawnSync } = {}) {
  if (!sessionId || String(sessionId).startsWith('job:')) return null;
  try {
    const result = run(process.platform === 'win32' ? 'opencode.cmd' : 'opencode', ['export', sessionId], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      shell: process.platform === 'win32',
    });
    if (result?.error || (result?.status != null && result.status !== 0)) return null;
    const stdout = String(result?.stdout ?? '').trim();
    if (!stdout) return null;
    let data;
    try { data = JSON.parse(stdout); }
    catch {
      const start = stdout.indexOf('{'); const end = stdout.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      data = JSON.parse(stdout.slice(start, end + 1));
    }
    if (!data || typeof data !== 'object') return null;
    return normalizeOpenCodeExport(data, sessionId);
  } catch { return null; }
}

// --- rendering ---------------------------------------------------------------
const TEXT_LINES = 8;                     // per text block, unless --full

function turnLines(turn, { cols, full }) {
  const out = [];
  const say = (text, prefix, colour) => {
    let lines = wrap(String(text).trim(), cols - 2);
    if (!full && lines.length > TEXT_LINES) {
      const hidden = lines.length - TEXT_LINES;
      lines = [...lines.slice(0, TEXT_LINES), c.muted(`… +${hidden} more lines (--full)`)];
    }
    out.push(colour(prefix) + ' ' + lines[0]);
    for (const l of lines.slice(1)) out.push('  ' + l);
  };

  for (const b of turn.blocks) {
    if (b.type === 'text' && String(b.text ?? '').trim()) {
      if (turn.role === 'user') say(b.text, '❯', c.accent);
      else say(b.text, '⏺', c.ok);
    } else if (b.type === 'tool_use') {
      const { name, arg } = toolSummary(b.name, b.input, cols - 6);
      out.push('  ' + c.muted('⎿ ') + c.bold(name) + c.muted(arg ? `(${arg})` : ''));
      for (const diff of normalizeToolDiffs(b.name, b.input)) {
        out.push(c.muted(`    ${diff.file}  +${diff.added} -${diff.removed}`));
        if (full) for (const line of diff.lines) {
          const shown = `    ${trunc(line, cols - 6)}`;
          out.push(line.startsWith('+') ? c.ok(shown)
            : (line.startsWith('-') ? c.err(shown) : c.muted(shown)));
        }
      }
    } else if (b.type === 'thinking' && full) {
      say(b.thinking ?? '', '✻', c.muted);
    } else if (b.type === 'tool_result' && full) {
      const text = typeof b.content === 'string'
        ? b.content
        : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : '');
      if (text.trim()) out.push('  ' + c.muted('→ ' + trunc(text, cols - 6)));
    }
  }
  return out;
}

/**
 * Render a session as text. `last` limits how many turns are shown (default 20);
 * `full` shows every turn untruncated (thinking and tool results included);
 * `raw` dumps the transcript lines as they are on disk.
 */
export function renderChat(ref, { last = 20, full = false, raw = false, openCodeRun } = {}) {
  const loaded = loadConversation(ref, { openCodeRun });
  const { resolved, chat, dirs, source } = loaded;
  const { sessionId, target, jobs } = resolved;

  if (!chat) {
    throw new Error(`no transcript found for session "${sessionId}".\n`
      + `  looked in ${projectsRoot()}\n`
      + '  the launch may not have run yet, or the session was started elsewhere.\n'
      + '  see what is available: kaip sessions');
  }
  if (source === 'fallback') {
      const lines = [];
      for (const turn of chat.turns) {
        const text = turn.blocks.find((block) => block.type === 'text')?.text;
        if (!text) continue;
        if (turn.role === 'user') lines.push(c.accent('you'), ...wrap(text, Math.min(size().cols, 100) - 2));
        else lines.push('', c.ok(resolved.adapter || jobs[0]?.adapter || 'assistant'), ...wrap(text, Math.min(size().cols, 100) - 2));
      }
      let footer = null;
      try { if (resolved.dir && !String(sessionId).startsWith('job:')) footer = resumeCommand(resolved); } catch { /* unsupported adapter */ }
      return [...box([
        c.muted('target  ') + (target || '—'),
        c.muted('session ') + sessionId,
        c.muted('engine  ') + (resolved.adapter || jobs[0]?.adapter || '—'),
      ], { title: 'chat', cols: Math.min(size().cols - 2, 78) }), '', ...lines,
      ...(footer ? ['', c.muted(`resume: ${footer}`)] : []),
      ].join('\n');
  }

  const cols = Math.min(size().cols, 100);

  const shown = chat.turns.filter((t) => full || (!t.sidechain && !t.toolResult));
  const slice = full ? shown : shown.slice(-Math.max(1, Number(last) || 20));

  if (raw) return slice.map((t) => t.raw).join('\n');

  const dir = chat.cwd || dirs[0] || '—';
  const range = chat.first
    ? `${fmt(Date.parse(chat.first))}  →  ${fmt(Date.parse(chat.last))}`
    : '—';
  const head = [
    c.muted('target  ') + (target || '—'),
    c.muted('session ') + sessionId,
    c.muted('folder  ') + trunc(dir, cols - 12),
    c.muted('turns   ') + `${chat.turns.length}`
      + (slice.length < shown.length ? c.muted(` (showing the last ${slice.length})`) : ''),
    c.muted('dates   ') + range,
  ];
  if (jobs.length) {
    head.push(c.muted('jobs    ') + trunc(jobs.map((j) => j.id).join(', '), cols - 12));
  }

  const body = [];
  for (const t of slice) {
    const lines = turnLines(t, { cols, full });
    if (!lines.length) continue;
    if (body.length) body.push('');
    body.push(...lines);
  }
  if (!body.length) body.push(c.muted('(the session has no messages yet)'));

  const footer = dir === '—' ? null : resumeCommand({ ...resolved, adapter: resolved.adapter || 'claude', dir });
  return [
    ...box(head, { title: 'chat', cols: Math.min(cols - 2, 78) }),
    '',
    ...body,
    '',
    footer ? c.muted(`resume: ${footer}`) : null,
  ].filter((line) => line != null).join('\n');
}
