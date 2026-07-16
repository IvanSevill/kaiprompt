import { spawn } from 'node:child_process';

/** Shared stdout/stderr lifecycle for provider CLIs that emit JSON or NDJSON. */
export function runChildProcess({
  command, args, options, stdin = null, mode = 'ndjson', spawnProcess = spawn,
  onJSON = () => {}, onClose, onError, onLaunchError = onError,
}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(command, args, options); }
    catch (error) { resolve(onLaunchError(error, { stdout: '', stderr: '' })); return; }

    let stdout = '';
    let stderr = '';
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { onJSON(JSON.parse(trimmed)); } catch { /* provider diagnostics may be non-JSON */ }
    };

    child.on('error', (error) => finish(onError(error, { stdout, stderr })));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (mode === 'text') { stdout += text; return; }
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.on('close', (code) => {
      if (mode === 'ndjson' && buffer.trim()) parseLine(buffer);
      finish(onClose({ code, stdout, stderr }));
    });
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
