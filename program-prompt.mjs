#!/usr/bin/env node
// program-prompt — portable prompt queue for Claude Code (and opencode later).
//
// - Queues prompts and launches them headless, in order or at a scheduled time.
// - Persistent sessions: jobs sharing a --target resume the same conversation.
// - Each launch runs inside its own project folder (--dir).
// - Zero dependencies: plain Node only.
//
// CLI dispatch only — the real work lives in lib/.

import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT, importProgramados, loadProjects, loadQueue, loadSessions, nowMs,
  preview, saveProjects, saveSessions,
} from './lib/store.mjs';
import { fmt } from './lib/time.mjs';
import { runQueue } from './lib/runner.mjs';
import { renderChat } from './lib/chat.mjs';
import { editJob } from './lib/edit.mjs';
import { addJob, clearFinished, jobDetails, removeJobs } from './lib/queue.mjs';
import { isTTY } from './lib/ui.mjs';

// --- argument parsing --------------------------------------------------------
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// --- commands ----------------------------------------------------------------
function cmdAdd({ flags, pos, engine }) {
  const prompt = (pos.join(' ').trim())
    || (typeof flags.file === 'string' ? fs.readFileSync(flags.file, 'utf8') : '');
  if (!prompt) {
    throw new Error('missing prompt.\n  usage: program-prompt <engine> add "your message" '
      + '[--target name] [--at HH:MM|+30m] [--dir project] [--session id] [--perm mode]');
  }
  const job = addJob({
    prompt,
    target: typeof flags.target === 'string' ? flags.target : null,
    at: typeof flags.at === 'string' ? flags.at : null,
    dir: typeof flags.dir === 'string' ? flags.dir : null,
    perm: typeof flags.perm === 'string' ? flags.perm : null,       // null → bypass
    adapter: typeof flags.adapter === 'string' ? flags.adapter : (engine || 'claude'),
    session: typeof flags.session === 'string' ? flags.session : null,
  });
  console.log(`+ ${job.id}  ${job.when ? '@ ' + fmt(job.when) : '(sequential)'}  `
    + `${job.target ? '[' + job.target + '] ' : ''}${preview(prompt)}`);
}

function cmdList({ flags, pos }) {
  const imp = importProgramados();
  if (imp) console.log(`(imported ${imp} from programados.jsonl)`);
  const q = loadQueue();
  if (!q.length) return console.log('(empty queue)');
  // parseArgs only understands "--" flags; short ones (-f/-l) land in pos.
  const full = flags.full || flags.f || flags.l || pos.includes('-f') || pos.includes('-l');
  const icon = { pending: '·', running: '▶', done: '✓', error: '✗' };
  for (const j of q) {
    if (full) { console.log(jobDetails(j), '\n'); continue; }
    const when = j.when ? '@ ' + fmt(j.when) : 'seq';
    console.log(`${icon[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
      + `${when.padEnd(22)} ${j.adapter}${j.target ? '/' + j.target : ''}  ${preview(j.prompt)}`);
  }
}

function cmdShow({ pos }) {
  if (!pos.length) throw new Error('usage: program-prompt show <id>');
  importProgramados();                    // the id may be a scheduled job not imported yet
  const job = loadQueue().find((j) => j.id === pos[0]);
  if (!job) return console.log(`no job found with id "${pos[0]}"`);
  console.log(jobDetails(job));
}

function cmdChat({ flags, pos }) {
  importProgramados();                    // a job scheduled from the chat may not be in the queue yet
  const last = typeof flags.last === 'string' ? Number(flags.last) : 20;
  if (!Number.isFinite(last) || last < 1) throw new Error('--last needs a positive number of turns');
  console.log(renderChat(pos[0], { last, full: !!flags.full, raw: !!flags.raw }));
}

function cmdEdit({ flags, pos }) {
  const { job, changes } = editJob(pos[0], flags);
  console.log(`✎ ${job.id}  updated: ${changes.join(', ')}\n`);
  console.log(jobDetails(job));
}

function cmdRm({ pos }) {
  if (!pos.length) throw new Error('usage: program-prompt rm <id> [<id>...]');
  console.log(`removed ${removeJobs(pos)}`);
}

function cmdClear() {
  console.log(`cleared ${clearFinished()} finished entries`);
}

function cmdOut({ pos }) {
  const q = loadQueue();
  const job = pos.length
    ? q.find((j) => j.id === pos[0])
    : q.filter((j) => j.output).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
  if (!job) return console.log('(no outputs yet; run something with "program-prompt run")');
  console.log(`── ${job.id} [${job.status}]${job.target ? ' ' + job.target : ''}  ${preview(job.prompt)} ──`);
  if (job.dir) console.log(`   folder: ${job.dir}`);
  if (job.sessionId) {
    console.log(`   session: ${job.sessionId}`);
    console.log(`   resume:  cd "${job.dir || '.'}" && claude --resume ${job.sessionId}`);
  }
  const f = job.output ? path.join(ROOT, job.output) : null;
  if (f && fs.existsSync(f)) console.log('\n' + fs.readFileSync(f, 'utf8').trimEnd());
  else console.log('(no output file yet)');
}

function cmdProjects({ pos }) {
  const map = loadProjects();
  if (pos.length >= 2) {                          // projects <alias> <path>
    const alias = pos[0]; map[alias] = pos.slice(1).join(' ');
    saveProjects(map);
    return console.log(`+ ${alias} → ${map[alias]}`);
  }
  if (map._base) {
    console.log(`base: ${map._base}`);
    try {
      const subs = fs.readdirSync(map._base, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      if (subs.length) console.log('  projects (by name): ' + subs.join(', '));
    } catch { console.log('  (base not accessible)'); }
  }
  const alias = Object.keys(map).filter((k) => k !== '_base');
  if (alias.length) { console.log('aliases:'); for (const k of alias) console.log(`  ${k} → ${map[k]}`); }
  if (!map._base && !alias.length) console.log('(no projects; use: program-prompt projects <alias> <path>)');
}

function cmdSessions({ pos } = { pos: [] }) {
  if (pos[0] === 'set') {                          // sessions set <target> <session-id>
    const [, target, sid] = pos;
    if (!target || !sid) throw new Error('usage: program-prompt sessions set <target> <session-id>');
    const s = loadSessions();
    s[target] = { sessionId: sid, adapter: 'claude', updatedAt: nowMs() };
    saveSessions(s);
    return console.log(`set ${target} → ${sid}`);
  }
  const s = loadSessions(); const keys = Object.keys(s);
  if (!keys.length) return console.log('(no saved sessions)');
  for (const k of keys) console.log(`${k}  →  ${s[k].sessionId}  [${s[k].adapter}]  ${fmt(s[k].updatedAt)}`);
}

const HELP = `program-prompt — portable prompt queue for Claude Code (and opencode later)

Usage:
  program-prompt                       open the guided GUI (needs a terminal)
  program-prompt <engine> <subcommand> [args]
  <engine> = claude | opencode   (optional; defaults to claude)

Subcommands:
  add "<prompt>" [--target <n>] [--at <when>] [--dir <project>] [--session <id>] [--perm <mode>]
  list [--full|-f]            view the queue with status (--full for whole prompts)
  show <id>                   full details of one job
  run [--once] [--dry-run]    process the queue (full-screen countdown + live view)
  out [<id>]                  output of a launch (or the latest)
  chat <id|target|session>    read the conversation of a launch [--last N] [--full] [--raw]
  edit <id>                   change a pending job (--prompt --at --target --dir --perm --adapter)
  rm <id> [<id>...]           remove jobs
  clear                       clear finished/error entries
  gui                         the guided GUI (same as running with no arguments)
  sessions                    saved sessions (name → session-id)
  sessions set <t> <id>       assign a session-id to a target by hand
  projects                    folders/projects available for --dir
  projects <alias> <path>     register a folder alias
  help

Notes:
  <engine>   the adapter used to LAUNCH (--adapter). Stored per job by "add".
  --target   groups jobs into a persistent conversation: the 1st creates the session,
             the rest resume it (claude --resume). Stored in data/sessions.json.
  --at       HH:MM (today/tomorrow), +30m / +2h / +1d, "tomorrow 09:00", or ISO.
             Without --at the job is sequential: it runs when its turn comes.
  --dir      folder/project to run in. Accepts a project name (subfolder of _base),
             an alias, or a path. Defaults to the current folder.
  --perm     permission mode for the unattended launch. Default: bypass (full autonomy:
             edits + Bash + installs, no prompts). Use "acceptEdits" for edits only.
  run        due scheduled jobs first, then sequential ones, then waits for the future
             ones (unless --once). Output of each job → out/<id>.txt
  chat       the whole conversation, not just the last answer (that's "out"). Takes a
             target, a job id or a session-id. --last N turns (default 20), --full for
             everything (thinking + tool results), --raw for the transcript as-is.
  edit       only PENDING jobs (a running/finished one is already history). Same flags
             as "add"; --target/--dir/--perm accept "none" to clear them.
  gui        views: Queue · Chats · Projects · Help. Keys: ↑↓ move · ←→/tab/1-4 view ·
             enter detail · a add (guided) · e edit · d delete · r run · o output ·
             c chat · ? help · q quit. Without a terminal it prints this help instead.

Examples:
  program-prompt claude add "/test" --target fixes --dir FacturaSevi
  program-prompt claude run
  program-prompt list
  program-prompt out
  program-prompt chat fixes --last 40
  program-prompt edit jlzz4t3h6 --at "tomorrow 09:00" --perm acceptEdits
`;

// --- dispatch ----------------------------------------------------------------
// Optional first token = ENGINE (claude | opencode) → default --adapter for `add`.
let av = process.argv.slice(2);
let engine = null;
if (av[0] === 'claude' || av[0] === 'opencode') { engine = av[0]; av = av.slice(1); }
const [cmd, ...rest] = av;
const parsed = parseArgs(rest);
parsed.engine = engine;

try {
  switch (cmd) {
    case 'add': cmdAdd(parsed); break;
    case 'list': case 'ls': cmdList(parsed); break;
    case 'show': cmdShow(parsed); break;
    case 'run': await runQueue({ once: !!parsed.flags.once, dryRun: !!parsed.flags['dry-run'] }); break;
    case 'rm': cmdRm(parsed); break;
    case 'clear': cmdClear(); break;
    case 'out': cmdOut(parsed); break;
    case 'chat': cmdChat(parsed); break;
    case 'edit': cmdEdit(parsed); break;
    case 'projects': case 'project': cmdProjects(parsed); break;
    case 'sessions': cmdSessions(parsed); break;
    // No subcommand → the GUI, but only with a real terminal: raw mode on a piped
    // stdin (Task Scheduler, cron, a pipe) would hang forever. There, print the help.
    case undefined:
      if (isTTY() && process.stdin.isTTY) { const { startTUI } = await import('./lib/tui.mjs'); await startTUI(); }
      else console.log(HELP);
      break;
    case 'gui': { const { startTUI } = await import('./lib/tui.mjs'); await startTUI(); break; }
    case 'help': case '--help': case '-h': console.log(HELP); break;
    default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(1);
  }
} catch (e) { console.error('Error:', e.message); process.exit(1); }
