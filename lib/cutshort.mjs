// A conversation of YOURS that the quota killed — and that nobody will ever finish.
//
// kaip already rescues its own launches: `requeue` puts a quota-killed job back in the queue
// and `CONTINUATION` resumes it instead of re-sending the brief. But a chat you were having
// BY HAND has none of that. It just stops. Five minutes of work left, and the only thing
// standing between you and it is remembering, four and a half hours later, which chat it was.
//
// This module is the missing half: it finds those conversations. Everything downstream
// (queueing, resuming) is the machinery that already existed.
//
// --- WHICH SIGNAL, AND WHY -----------------------------------------------------------------
//
// Found by reading the 180 real transcripts under ~/.claude/projects, not by guessing.
// Classified by how each one ENDS (last real conversational turn):
//
//     60  ends on assistant text ......... a normal finish
//     45  ends on a tool_result .......... assistant ran a tool and never spoke again
//     14  ends on an api-error that is NOT quota
//     14  ends on a user turn nobody answered
//      8  empty
//   >  6  ends on a QUOTA api-error  ← the signal
//      2  ends on a tool_use with no result
//
// THE SIGNAL: the last real turn is an `assistant` entry with `isApiErrorMessage: true`
// whose text is a quota message ("You've hit your session limit · resets 1:30pm").
//
// Why that one and not the others the eye is drawn to:
//
//   · "ends on a tool_result" is the tempting one — it *looks* like being cut mid-work, and
//     it is the single most common non-normal ending. It is also worthless: 45 of them. Every
//     escape key, every closed terminal, every Ctrl-C lands there too. Offering all of those
//     is offering everything, and an offer that fires constantly is one you learn to ignore.
//
//   · "ends on a user turn nobody answered" (14) has the same disease, quieter.
//
//   · Grepping the transcript for "session limit" ANYWHERE is worse than useless. It matches
//     any conversation that merely *discusses* quota — the kaiprompt repo is full of them, and
//     this very file would trip it. 34 transcripts match on a user turn alone.
//
//   · `isApiErrorMessage` alone is too broad: it also carries 429 throttles, "Please run
//     /login" and "your organization has disabled subscription access". None of those come
//     back when the quota does, so none of them are worth an offer.
//
// The flag AND the text AND the position. The flag says Claude Code wrote it rather than said
// it; the text (`isQuotaExhausted`, the same matcher the launcher already trusts) says it was
// the quota and not an auth failure; the position says nobody has picked the thread back up
// since. Take any one away and it misfires.
//
// One wrinkle worth knowing: the quota error is almost never the last LINE of the file.
// Bookkeeping keeps trailing after it (`last-prompt`, `queue-operation`, `ai-title`, `mode`,
// `permission-mode`, `file-history-snapshot`…). So position has to be measured in real turns —
// which is exactly what `parseTranscript` already filters down to. Read the raw tail instead
// and you find nothing.
//
// And it heals itself: the moment the conversation is resumed the transcript grows new turns,
// the quota error stops being last, and the session stops being a candidate. Nothing to clean.

import fs from 'node:fs';
import path from 'node:path';

import { findTranscript, parseTranscript, projectsRoot } from './chat.mjs';
import { isQuotaExhausted, parseResetAt } from '../src/core/quota-retry.mjs';
import { CONTINUATION } from '../src/core/prompt.mjs';
import { addJob } from '../src/core/jobs.mjs';
import { DATA } from '../src/storage/paths.mjs';
import { loadQueue, loadSessions } from '../src/storage/repositories.mjs';
import { readJSON, writeJSON } from '../src/storage/json.mjs';

// A conversation from last week does not get "picked back up" — it died of old age, and the
// project has moved on without it. The offer is for work you still remember starting.
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Saying "no" has to STICK. An offer that comes back every time you open the GUI is an offer
// you learn to dismiss without reading, and then it is worth nothing on the day it matters.
const DISMISSED = path.join(DATA, 'cutshort.json');

const flatten = (turn) => (turn?.blocks ?? [])
  .filter((b) => b.type === 'text')
  .map((b) => String(b.text ?? ''))
  .join(' ')
  .trim();

/** The turn is Claude Code telling you the quota ran out — not Claude talking about quotas. */
export const isQuotaError = (turn) => {
  const text = flatten(turn);
  // These transcripts belong to Claude Code. An API 429 can be temporary provider throttling;
  // only Claude's named subscription windows are safe to offer as a later continuation.
  return Boolean(turn && turn.role === 'assistant' && turn.apiError
    && /\b(session|weekly|week)\s+limit\b/i.test(text) && isQuotaExhausted(text));
};

/**
 * Was this conversation cut short by the quota, with nobody coming back to it?
 *
 * Sidechains (sub-agents) are not the conversation you were having, so they do not get a vote
 * on how it ended — but a tool_result does: being cut off right after a tool ran is still
 * being cut off, and the quota error lands after it all the same.
 */
export function readCutShort(file) {
  let chat;
  try { chat = parseTranscript(file); }
  catch { return null; }                                  // unreadable / half-written

  const turns = chat.turns.filter((t) => !t.sidechain);
  const last = turns.at(-1);
  if (!isQuotaError(last)) return null;

  // What you were asking for when the lights went out. The unanswered request IS the job:
  // it is the only thing that says what those last five minutes were supposed to be.
  const asked = [...turns].reverse().find((t) => t.role === 'user' && !t.toolResult);

  const at = Date.parse(last.timestamp ?? '');
  return {
    sessionId: path.basename(file, '.jsonl'),
    file,
    dir: chat.cwd || null,
    at: Number.isFinite(at) ? at : fs.statSync(file).mtimeMs,
    ask: flatten(asked).replace(/\s+/g, ' ').trim(),
    resetsAt: parseResetAt(flatten(last)),                // when it said the quota comes back
  };
}

/**
 * Every session kaip already knows about — launched by it, or attached to a target by hand.
 *
 * These are not ours to offer. A job kaip launched and the quota killed is already back in
 * the queue via `requeue`, resuming through the same `CONTINUATION` path; offering it again
 * would queue the work twice and resume one session from two places at once, which is the
 * one thing the lane rule exists to prevent.
 */
const kaipsOwn = () => new Set([
  ...loadQueue().map((j) => j.sessionId),
  ...Object.values(loadSessions()).map((s) => s?.sessionId),
].filter(Boolean));

export const dismissed = () => new Set(readJSON(DISMISSED, { sessions: [] }).sessions ?? []);

/** Never ask about this session again. */
export function dismiss(sessionId) {
  const all = dismissed();
  all.add(sessionId);
  writeJSON(DISMISSED, { sessions: [...all] });
  return all;
}

/** Every transcript on disk, newest first — sub-agent sidechains excluded, they are not sessions. */
function transcripts(root = projectsRoot()) {
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }                                    // no ~/.claude/projects at all

  const out = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, p.name)); }
    catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(root, p.name, f);
      try { out.push({ file, mtime: fs.statSync(file).mtimeMs }); }
      catch { /* vanished between readdir and stat */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * The conversations worth offering to finish, most recent first.
 *
 * Filtered by mtime BEFORE anything is parsed: 180 transcripts is 180 stats and a handful of
 * reads, not 180 reads. The GUI runs this on every open, so it has to be cheap.
 */
export function findCutShort({ now = Date.now(), maxAgeMs = MAX_AGE_MS, root } = {}) {
  const mine = kaipsOwn();
  const said_no = dismissed();
  const out = [];

  for (const { file, mtime } of transcripts(root)) {
    if (now - mtime > maxAgeMs) break;                    // sorted newest first: the rest are older
    const sid = path.basename(file, '.jsonl');
    if (mine.has(sid) || said_no.has(sid)) continue;

    const hit = readCutShort(file);
    if (!hit) continue;
    if (now - hit.at > maxAgeMs) continue;                // the turn's own clock, not the file's
    out.push(hit);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A resumable session still needs its folder to exist — Claude Code sessions are per-folder. */
export const resumable = (hit) =>
  Boolean(hit?.sessionId && hit.dir && fs.existsSync(hit.dir) && findTranscript(hit.sessionId, [hit.dir]));

/**
 * Yes: finish it. The offer becomes a job — and the FIRST job.
 *
 * There is nothing new here on purpose. `continuation` + a `sessionId` is exactly the state
 * `requeue` leaves a quota-killed launch in, so this goes down the same road: `isContinuation`
 * sees it, `executeJob` sends CONTINUATION instead of the prompt, and Claude picks the thread
 * back up with its context intact rather than re-reading the project and starting over.
 *
 * No `when`. It is not scheduled for a time — it is waiting for the quota, and it goes the
 * moment whoever is draining the queue has some.
 */
export function resumeCutShort(hit) {
  if (!hit?.sessionId) throw new Error('no session to continue');
  if (!hit.dir) {
    throw new Error(`don't know which folder session ${hit.sessionId} belongs to; cannot resume it`);
  }
  if (!fs.existsSync(hit.dir)) {
    throw new Error(`the folder that conversation ran in is gone: ${hit.dir}`);
  }

  // The stored prompt is CONTINUATION itself, and it is never the thing that gets sent:
  // `executeJob` reaches for the same constant the moment it sees `continuation` + a session.
  // Writing it here anyway keeps the job honest in `list` and `show` — the queue displays what
  // this launch will actually say, instead of an empty row or a prompt that is a lie.
  return addJob({
    prompt: CONTINUATION,
    session: hit.sessionId,
    continuation: true,
    priority: true,
    dir: hit.dir,
    at: null,
  });
}
