import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSelection, qualifiedModel } from '../lib/engines.mjs';

export const name = 'opencode';
// npm's Windows shim forwards through cmd.exe, which both interprets prompt characters and
// imposes an 8191-character command limit. Its sibling executable accepts argv directly.
const BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
  : 'opencode';
const SHELL = process.platform === 'win32' && !fs.existsSync(BIN);

export function buildArgs({ sessionId, provider, model, dir }) {
  const fullModel = qualifiedModel(normalizeSelection({ adapter: 'opencode', provider, model }, { required: true }));
  const args = ['run', '--format', 'json', '--auto', '--print-logs', '--log-level', 'ERROR'];
  if (dir) args.push('--dir', dir);
  args.push('-m', fullModel);
  if (sessionId) args.push('-s', sessionId);
  return args;
}

const TOOL_NAMES = {
  read: 'Read', edit: 'Edit', write: 'Write', multiedit: 'MultiEdit',
  bash: 'Bash', glob: 'Glob', grep: 'Grep', task: 'Task', todowrite: 'TodoWrite',
};

/** Translate OpenCode's tool part into the Claude-shaped event the live renderer consumes. */
export function toolEvent(evt, sessionId) {
  const part = evt?.part;
  if (!part || !['tool', 'tool_use'].includes(part.type)) return null;
  const raw = part.tool ?? part.name ?? part.toolName;
  if (!raw) return null;
  const source = part.state?.input ?? part.input ?? part.arguments ?? {};
  const input = { ...source };
  input.file_path ??= input.filePath ?? input.path ?? input.filename;
  input.old_string ??= input.oldString ?? input.oldText ?? input.old;
  input.new_string ??= input.newString ?? input.newText ?? input.new;
  return {
    type: 'assistant', session_id: sessionId,
    message: { content: [{ type: 'tool_use', name: TOOL_NAMES[String(raw).toLowerCase()] ?? String(raw), input }] },
  };
}

export async function run({ prompt, sessionId, dryRun, dir, provider, model, onEvent }) {
  const args = buildArgs({ sessionId, provider, model, dir: dir && fs.existsSync(dir) ? dir : null });
  const unattended = `${prompt}\n\n---\nUNATTENDED LAUNCH: nobody can answer questions. Do not ask for confirmation, offer choices, or wait. Make the safest reversible decision, continue, and record assumptions in your final answer. If blocked by a secret, external access, or an irreversible decision, complete everything else and report the blocker without waiting.`;
  const shown = `${BIN} ${args.join(' ')} ${JSON.stringify(unattended)}`;
  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}` };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(SHELL ? 'opencode.cmd' : BIN, [...args, unattended], {
        stdio: ['ignore', 'pipe', 'pipe'], shell: SHELL,
        windowsHide: true,
        env: { ...process.env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' },
      });
    }
    catch (e) { resolve({ ok: false, sessionId, output: '', error: `could not launch ${BIN}: ${e.message}` }); return; }
    let stderr = '', buffer = '', sid = sessionId, output = '';
    let usage = null, cost = null, sawError = false, eventError = null;
    const handle = (evt) => {
      if (evt.sessionID) sid = evt.sessionID;
      if (evt.type === 'error') {
        sawError = true;
        eventError = evt.error?.data?.message ?? evt.error?.message ?? eventError;
      }
      if (evt.type === 'text' && typeof evt.part?.text === 'string') {
        output += evt.part.text;
        try { onEvent?.({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: evt.part.text }] } }); } catch { /* rendering cannot stop a launch */ }
      }
      const tool = toolEvent(evt, sid);
      if (tool) { try { onEvent?.(tool); } catch { /* rendering cannot stop a launch */ } }
      if (evt.type === 'step_finish') {
        const t = evt.part?.tokens;
        if (t) usage = { input: t.input ?? null, output: t.output ?? null, reasoning: t.reasoning ?? null, total: t.total ?? null, cacheRead: t.cache?.read ?? null, cacheWrite: t.cache?.write ?? null };
        if (Number.isFinite(evt.part?.cost)) cost = evt.part.cost;
      }
    };
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buffer += String(d); let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (line) { try { handle(JSON.parse(line)); } catch { /* diagnostic line */ } } }
    });
    child.on('error', (e) => resolve({ ok: false, sessionId: sid, output, error: `could not launch ${BIN}: ${e.message}`, usage, cost }));
    child.on('close', (code) => {
      if (buffer.trim()) { try { handle(JSON.parse(buffer)); } catch { /* ignored */ } }
      const ok = code === 0 && !sawError;
      resolve({ ok, sessionId: sid, output, error: ok ? null : (eventError || stderr || `opencode exited with code ${code}`), usage, cost });
    });
  });
}
