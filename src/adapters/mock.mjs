// Test adapter — calls no CLI and spends no tokens.
// Emits a realistic-looking event stream so the live view can be exercised offline.

export const name = 'mock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Voy a mirar el proyecto.' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.py' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app/main.py' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Ahora aplico el cambio.' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'app/main.py' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Tests en verde.' }] } },
];

export async function run({ prompt, sessionId, dryRun, dir, permMode, onEvent }) {
  const sid = sessionId || 'mock-' + Math.random().toString(36).slice(2, 10);
  const where = dir ? `  (in ${dir})` : '';
  if (dryRun) return { ok: true, sessionId: sid, output: `[dry-run mock] session ${sid}${where}\n${prompt}` };

  if (typeof onEvent === 'function') {
    onEvent({ type: 'system', subtype: 'init', session_id: sid });
    for (const evt of SCRIPT) {
      await sleep(700);
      onEvent(evt);
    }
    await sleep(400);
  } else {
    await sleep(120);
  }

  const output = `[mock] session=${sid}${where}\nprompt:\n${prompt}`;
  onEvent?.({ type: 'result', subtype: 'success', session_id: sid, result: output, is_error: false });
  return { ok: true, sessionId: sid, output };
}
