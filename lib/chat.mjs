// Chat viewer: find and render the transcript of a launch's session.
//
// Claude Code writes one JSONL transcript per session, under the *encoded* project
// folder: ~/.claude/projects/<encoded-dir>/<session-id>.jsonl. A launch only knows
// its session id, so we go: target | job id | session id → session id → transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadQueue, loadSessions } from './store.mjs';
import { fmt } from './time.mjs';
import { box, c, size, toolSummary, trunc, wrap } from './ui.mjs';

/** ~/.claude — CLAUDE_CONFIG_DIR wins, same env var Claude Code itself honours. */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectsRoot = () => path.join(claudeHome(), 'projects');

/** How Claude Code flattens a folder into a project name: ':' '\' '/' and '.' → '-'. */
export const encodeDir = (dir) => String(dir ?? '').replace(/[:\\/.]/g, '-');

/**
 * What the user typed → which session to show.
 * A saved target wins, then a job id, then it's taken as a raw session id.
 */
export function resolveRef(ref) {
  if (!ref) throw new Error('usage: kaip chat <id|target|session-id> [--last N] [--full] [--raw]');
  const queue = loadQueue();
  const sessions = loadSessions();
  const jobsOf = (sid) => queue.filter((j) => j.sessionId === sid);

  const saved = sessions[ref]?.sessionId;
  if (saved) return { sessionId: saved, target: ref, jobs: jobsOf(saved) };

  const job = queue.find((j) => j.id === ref);
  if (job) {
    if (!job.sessionId) {
      throw new Error(`job "${ref}" has no session yet: it is ${job.status} `
        + '(a session only exists once the launch has run)');
    }
    return { sessionId: job.sessionId, target: job.target || null, jobs: jobsOf(job.sessionId) };
  }

  const target = Object.keys(sessions).find((k) => sessions[k]?.sessionId === ref) || null;
  return { sessionId: ref, target, jobs: jobsOf(ref) };
}

/**
 * Everything needed to walk INTO a conversation: which session, and in which folder.
 *
 * The folder matters as much as the id. Claude Code sessions are per-directory — a
 * `--resume` from the wrong place simply will not find the session, which is exactly the
 * "no lo encuentra con dichas credenciales" dead end.
 */
export function resumeTarget(ref) {
  const { sessionId, target, jobs } = resolveRef(ref);
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
  const dir = jobs.find((j) => j.dir)?.dir
    || byTarget.find((j) => j.dir)?.dir
    || dirFromTranscript(sessionId);

  if (!dir) {
    throw new Error(`don't know which folder session ${sessionId} belongs to.\n`
      + '  Claude Code sessions are per-folder, so resuming from the wrong one finds nothing.');
  }

  // A folder that has since been renamed or deleted is the real cause of the baffling
  // "spawn cmd.exe ENOENT": Node reports ENOENT for the SHELL when the cwd is missing,
  // which sends you hunting for a broken cmd.exe that is perfectly fine.
  if (!fs.existsSync(dir)) {
    throw new Error(`the folder this session ran in is gone: ${dir}\n`
      + '  it was moved, renamed or deleted. The transcript is still readable with "chat",\n'
      + '  but Claude Code cannot resume a session outside its folder.');
  }
  return { sessionId, target, dir, jobs };
}

/** The command that drops you into that conversation, for real. */
export const resumeCommand = ({ dir, sessionId }) =>
  `cd "${dir}" && claude --resume ${sessionId}`;

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
export function renderChat(ref, { last = 20, full = false, raw = false } = {}) {
  const { sessionId, target, jobs } = resolveRef(ref);
  const dirs = [...new Set(jobs.map((j) => j.dir).filter(Boolean))];
  const file = findTranscript(sessionId, dirs);

  if (!file) {
    throw new Error(`no transcript found for session "${sessionId}".\n`
      + `  looked in ${projectsRoot()}\n`
      + '  the launch may not have run yet, or the session was started elsewhere.\n'
      + '  see what is available: kaip sessions');
  }

  const chat = parseTranscript(file);
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

  return [
    ...box(head, { title: 'chat', cols: Math.min(cols - 2, 78) }),
    '',
    ...body,
    '',
    c.muted(`resume: cd "${dir}" && claude --resume ${sessionId}`),
  ].join('\n');
}
