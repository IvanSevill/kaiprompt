import fs from 'node:fs';
import path from 'node:path';
import { normalizeSelection, qualifiedModel } from '../core/engines.mjs';
import { runChildProcess } from './child-process.mjs';
import { normalizeOpenCodePart } from './opencode-normalize.mjs';

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

/** Translate OpenCode's tool part into the Claude-shaped event the live renderer consumes. */
export function toolEvent(evt, sessionId) {
  const block = normalizeOpenCodePart(evt, { output: false }).find((item) => item.type === 'tool_use');
  if (!block) return null;
  return {
    type: 'assistant', session_id: sessionId,
    message: { content: [block] },
  };
}

/** Translate every user-visible OpenCode part into the shared adapter event shape. */
export function liveEvent(evt, sessionId) {
  const block = normalizeOpenCodePart(evt, { output: false })[0];
  return block ? { type: 'assistant', session_id: sessionId, message: { content: [block] } } : null;
}

export async function run({ prompt, sessionId, dryRun, dir, provider, model, onEvent, spawnProcess }) {
  const args = buildArgs({ sessionId, provider, model, dir: dir && fs.existsSync(dir) ? dir : null });
  const unattended = `${prompt}\n\n---\nUNATTENDED LAUNCH: nobody can answer questions. Do not ask for confirmation, offer choices, or wait. Make the safest reversible decision, continue, and record assumptions in your final answer. If blocked by a secret, external access, or an irreversible decision, complete everything else and report the blocker without waiting.`;
  const shown = `${BIN} ${args.join(' ')} ${JSON.stringify(unattended)}`;
  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}` };
  let sid = sessionId;
  let output = '';
  let usage = null;
  let cost = null;
  let sawError = false;
  let eventError = null;
  const seenTools = new Set();
  return runChildProcess({
    command: SHELL ? 'opencode.cmd' : BIN,
    args: [...args, unattended],
    options: {
        stdio: ['ignore', 'pipe', 'pipe'], shell: SHELL,
        windowsHide: true,
        env: { ...process.env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' },
    },
    ...(spawnProcess ? { spawnProcess } : {}),
    onJSON: (evt) => {
      const eventSession = evt.sessionID ?? evt.sessionId ?? evt.session_id ?? evt.part?.sessionID;
      if (eventSession && eventSession !== sid) {
        sid = eventSession;
        try { onEvent?.({ type: 'system', subtype: 'init', session_id: sid }); } catch { /* rendering cannot stop a launch */ }
      }
      if (evt.type === 'error') {
        sawError = true;
        eventError = evt.error?.data?.message ?? evt.error?.message ?? eventError;
      }
      const normalized = liveEvent(evt, sid);
      if (normalized?.message?.content?.[0]?.type === 'text') output += normalized.message.content[0].text;
      if (normalized) {
        const block = normalized.message.content[0];
        const signature = block.type === 'tool_use'
          ? (evt.part?.id ? `id:${evt.part.id}` : JSON.stringify(block))
          : null;
        if (signature == null || !seenTools.has(signature)) {
          if (signature != null) seenTools.add(signature);
          try { onEvent?.(normalized); } catch { /* rendering cannot stop a launch */ }
        }
      }
      if (evt.type === 'step_finish') {
        const t = evt.part?.tokens;
        if (t) usage = { input: t.input ?? null, output: t.output ?? null, reasoning: t.reasoning ?? null, total: t.total ?? null, cacheRead: t.cache?.read ?? null, cacheWrite: t.cache?.write ?? null };
        if (Number.isFinite(evt.part?.cost)) cost = evt.part.cost;
      }
    },
    onError: (error) => ({
      ok: false, sessionId: sid, output, error: `could not launch ${BIN}: ${error.message}`, usage, cost,
    }),
    onClose: ({ code, stderr }) => {
      const ok = code === 0 && !sawError;
      return { ok, sessionId: sid, output, error: ok ? null : (eventError || stderr || `opencode exited with code ${code}`), usage, cost };
    },
  });
}
