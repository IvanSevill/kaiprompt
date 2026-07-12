#!/usr/bin/env node
// promptheus — portable prompt queue for Claude Code (and opencode later).
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
  importProgramados, loadProjects, loadQueue, loadSessions, nowMs,
  outPath, preview, saveProjects, saveSessions,
} from './lib/store.mjs';
import { fmt } from './lib/time.mjs';
import { reapStale, runQueue } from './lib/runner.mjs';
import { renderChat } from './lib/chat.mjs';
import { editJob } from './lib/edit.mjs';
import { addJob, clearFinished, jobDetails, removeJobs } from './lib/queue.mjs';
import { c, isTTY } from './lib/ui.mjs';

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
async function cmdAdd({ flags, pos, engine }) {
  const prompt = (pos.join(' ').trim())
    || (typeof flags.file === 'string' ? fs.readFileSync(flags.file, 'utf8') : '');
  if (!prompt) {
    throw new Error('missing prompt.\n  usage: promptheus <engine> add "your message" '
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

  // Adding never launches. But a job with a time is a promise, and only the daemon can
  // keep it — so arm it here rather than let 09:00 come and go with nothing running.
  if (job.when) {
    const d = await import('./lib/daemon.mjs');
    const st = d.ensure();
    console.log('  ' + (st.started ? `daemon started (pid ${st.pid}) — it will fire on time`
      : d.statusLine()));
  } else {
    console.log('  sequential: it will go on your next "run" (nothing is launched now)');
  }
}

function cmdList({ flags, pos }) {
  const imp = importProgramados();
  if (imp) console.log(`(imported ${imp} from programados.jsonl)`);
  // A job whose runner died still says "running" until someone closes it out, and this
  // is the screen you actually read — a status that lies here is the worst place for it.
  const dead = reapStale();
  if (dead) console.log(`(${dead} job(s) left hanging by a dead runner marked as error)`);

  const q = loadQueue();
  if (!q.length) return console.log('(empty queue)');
  // parseArgs only understands "--" flags; short ones (-f/-l) land in pos.
  const full = flags.full || flags.f || flags.l || pos.includes('-f') || pos.includes('-l');
  const icon = { pending: '·', running: '▶', done: '✓', error: '✗', missed: '⊘' };
  for (const j of q) {
    if (full) { console.log(jobDetails(j), '\n'); continue; }
    const when = j.when ? '@ ' + fmt(j.when) : 'seq';
    console.log(`${icon[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
      + `${when.padEnd(22)} ${j.adapter}${j.target ? '/' + j.target : ''}  ${preview(j.prompt)}`);
  }
}

function cmdShow({ flags, pos }) {
  if (!pos.length) throw new Error('usage: promptheus show <id>');
  importProgramados();                    // the id may be a scheduled job not imported yet
  const job = loadQueue().find((j) => j.id === pos[0]);
  if (!job) return console.log(`no job found with id "${pos[0]}"`);

  console.log(jobDetails(job));

  // The details are only half the story. Once a launch has run, what you actually want
  // to see is the CONVERSATION it had — not the prompt you already know you wrote.
  if (!job.sessionId) {
    console.log(c.muted(`\n(no conversation yet: this job is ${job.status})`));
    return;
  }
  const last = typeof flags.last === 'string' ? Number(flags.last) : 20;
  try {
    console.log('\n' + renderChat(job.id, { last, full: !!flags.full }));
  } catch (e) {
    console.log(c.muted(`\n(no transcript: ${e.message.split('\n')[0]})`));
  }
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
  if (!pos.length) throw new Error('usage: promptheus rm <id> [<id>...]');
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
  if (!job) return console.log('(no outputs yet; run something with "promptheus run")');
  console.log(`── ${job.id} [${job.status}]${job.target ? ' ' + job.target : ''}  ${preview(job.prompt)} ──`);
  if (job.dir) console.log(`   folder: ${job.dir}`);
  if (job.sessionId) {
    console.log(`   session: ${job.sessionId}`);
    console.log(`   resume:  cd "${job.dir || '.'}" && claude --resume ${job.sessionId}`);
  }
  const f = outPath(job.id);                    // the file is always out/<id>.txt under HOME
  if (job.output && fs.existsSync(f)) console.log('\n' + fs.readFileSync(f, 'utf8').trimEnd());
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
  if (!map._base && !alias.length) console.log('(no projects; use: promptheus projects <alias> <path>)');
}

// The daemon is what makes a scheduled launch fire on its own. `run` is the loop
// itself (what the detached child executes); the rest are controls around it.
async function cmdDaemon({ flags, pos }) {
  const d = await import('./lib/daemon.mjs');
  const sub = pos[0] || 'status';
  const seq = Boolean(flags.seq);

  switch (sub) {
    case 'run':                                   // foreground loop — this IS the daemon
      return runQueue({ loop: true, scheduledOnly: !seq });

    case 'start': {
      const r = d.start({ seq });
      if (!r.started) return console.log(d.statusLine());
      console.log(`daemon started (pid ${r.pid})${seq ? ' · sequential jobs too' : ''}`);
      console.log(`  log: ${r.log}`);
      return console.log('  scheduled launches will now fire on their own.');
    }

    case 'stop': {
      const r = d.stop();
      return console.log(r.stopped ? `daemon stopped (pid ${r.pid})` : 'daemon was not running');
    }

    case 'restart': {
      d.stop();
      const r = d.start({ seq });
      return console.log(`daemon restarted (pid ${r.pid})`);
    }

    case 'status': {
      const st = d.status();
      const auto = d.autostartInstalled();
      console.log(d.statusLine(st));
      if (st.running) console.log(`  since ${fmt(st.startedAt)}`);
      console.log(`  autostart at logon: ${auto ? 'installed' : 'not installed'}`
        + `${auto ? '' : '  (promptheus daemon install)'}`);
      return console.log(`  log: ${st.log}`);
    }

    case 'install': {
      const r = d.autostartInstall();
      if (!r.ok) throw new Error(r.error);
      console.log(`autostart installed (task "${r.task}"): the daemon comes back up when you log in.`);
      return console.log(d.statusLine(d.ensure({ seq })));
    }

    case 'uninstall': {
      const r = d.autostartRemove();
      if (!r.ok) throw new Error(r.error);
      return console.log('autostart removed (the daemon itself keeps running until you stop it)');
    }

    case 'log': {
      if (!fs.existsSync(d.LOG)) return console.log('(no log yet — the daemon has not run)');
      const n = Number(flags.last) || 30;
      const lines = fs.readFileSync(d.LOG, 'utf8').trimEnd().split('\n');
      return console.log(lines.slice(-n).join('\n'));
    }

    default:
      throw new Error(`unknown: daemon ${sub}\n  use: start | stop | restart | status | install | uninstall | log`);
  }
}

function cmdSessions({ pos } = { pos: [] }) {
  if (pos[0] === 'set') {                          // sessions set <target> <session-id>
    const [, target, sid] = pos;
    if (!target || !sid) throw new Error('usage: promptheus sessions set <target> <session-id>');
    const s = loadSessions();
    s[target] = { sessionId: sid, adapter: 'claude', updatedAt: nowMs() };
    saveSessions(s);
    return console.log(`set ${target} → ${sid}`);
  }
  const s = loadSessions(); const keys = Object.keys(s);
  if (!keys.length) return console.log('(no saved sessions)');
  for (const k of keys) console.log(`${k}  →  ${s[k].sessionId}  [${s[k].adapter}]  ${fmt(s[k].updatedAt)}`);
}

const HELP = `promptheus — portable prompt queue for Claude Code (and opencode later)

Usage:
  promptheus                       open the guided GUI (needs a terminal)
  promptheus <engine> <subcommand> [args]
  <engine> = claude | opencode   (optional; defaults to claude)

Subcommands:
  add "<prompt>" [--target <n>] [--at <when>] [--dir <project>] [--session <id>] [--perm <mode>]
  list [--full|-f]            view the queue with status (--full for whole prompts)
  show <id>                   full details of one job
  daemon <start|stop|status>  the background runner: fires scheduled launches on time
  run [--once] [--dry-run]    process the queue NOW (full-screen countdown + live view)
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

Scheduling vs running — the one thing to understand:
  A job WITH a time (--at) is scheduled: the daemon fires it at that time, on its own.
  Nothing else needs to be open. That is the point of the tool.
  A job WITHOUT a time is sequential: it sits in the queue and only goes when YOU run
  the queue ("run", or "r" in the GUI). Adding it never launches it.
  So: scheduling is not launching. Neither the GUI nor "add" ever sends a prompt.

Notes:
  <engine>   the adapter used to LAUNCH (--adapter). Stored per job by "add".
  --target   groups jobs into a persistent conversation: the 1st creates the session,
             the rest resume it (claude --resume). Stored in data/sessions.json.
  --at       HH:MM (today/tomorrow), +30m / +2h / +1d, "tomorrow 09:00", or ISO.
             Without --at the job is sequential (see above).
  daemon     start: a detached background runner; scheduled launches fire without a
             terminal open. stop / restart / status / log [--last N].
             install: bring it back automatically when you log in (Windows).
             It only takes scheduled jobs. --seq makes it drain sequential ones too.
  --dir      folder/project to run in. Accepts a project name (subfolder of _base),
             an alias, or a path. Defaults to the current folder.
  --perm     permission mode for the unattended launch. Default: bypass (full autonomy:
             edits + Bash + installs, no prompts). Use "acceptEdits" for edits only.
  run        runs the queue now: due scheduled jobs first, then sequential ones, then
             waits for the future ones (unless --once). Output → out/<id>.txt
             You do NOT need this for scheduled jobs — that's the daemon's job.
  chat       the whole conversation, not just the last answer (that's "out"). Takes a
             target, a job id or a session-id. --last N turns (default 20), --full for
             everything (thinking + tool results), --raw for the transcript as-is.
  edit       only PENDING jobs (a running/finished one is already history). Same flags
             as "add"; --target/--dir/--perm accept "none" to clear them.
  gui        views: Queue · Chats · Projects · Help. Keys: ↑↓ move · ←→/tab/1-4 view ·
             enter detail · a add (guided) · e edit · d delete · D daemon on/off ·
             r run now · o output · c chat · ? help · q quit. The header tells you
             whether the daemon is up — if it isn't, nothing you schedule will fire.
             Adding a launch never sends it. Without a terminal it prints this help.

Examples:
  promptheus daemon start                       arm it once; scheduled jobs now fire alone
  promptheus claude add "/test" --at "tomorrow 09:00" --target fixes --dir myapp
  promptheus claude run
  promptheus list
  promptheus out
  promptheus chat fixes --last 40
  promptheus edit jlzz4t3h6 --at "tomorrow 09:00" --perm acceptEdits
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
    case 'add': await cmdAdd(parsed); break;
    case 'list': case 'ls': cmdList(parsed); break;
    case 'show': cmdShow(parsed); break;
    case 'run': await runQueue({
      once: !!parsed.flags.once,
      dryRun: !!parsed.flags['dry-run'],
      parallel: Number(parsed.flags.parallel) || 1,
      plain: !!parsed.flags.plain || !!parsed.flags['no-tui'],
      watch: !!parsed.flags.watch,
    }); break;
    case 'rm': cmdRm(parsed); break;
    case 'clear': cmdClear(); break;
    case 'out': cmdOut(parsed); break;
    case 'chat': cmdChat(parsed); break;
    case 'edit': cmdEdit(parsed); break;
    case 'projects': case 'project': cmdProjects(parsed); break;
    case 'sessions': cmdSessions(parsed); break;
    case 'daemon': await cmdDaemon(parsed); break;
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
