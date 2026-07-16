import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ADAPTERS = path.join(ROOT, 'src', 'adapters');

export const HOME = process.env.KAIP_HOME
  || process.env.PROMPTHEUS_HOME || process.env.PROGRAM_PROMPT_HOME
  || ROOT;
export const DATA = path.join(HOME, 'data');
export const OUT = path.join(HOME, 'out');
export const HISTORY = path.join(DATA, 'history');

export const QUEUE = path.join(DATA, 'queue.json');
export const SESSIONS = path.join(DATA, 'sessions.json');
export const HIDDEN_CONVERSATIONS = path.join(DATA, 'hidden-conversations.json');
export const LAUNCH_DEFAULTS = path.join(DATA, 'launch-defaults.json');
export const PROJECTS = path.join(HOME, 'projects.json');
export const DATA_FILES = Object.freeze({
  queue: QUEUE, sessions: SESSIONS, hidden: HIDDEN_CONVERSATIONS,
});

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(HISTORY, { recursive: true });

export const outPath = (id) => path.join(OUT, `${id}.txt`);
export const historyPath = (id) => path.join(HISTORY, `${id}.jsonl`);
