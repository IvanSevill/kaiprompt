import fs from 'node:fs';

export const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read JSON from ${file}: ${error.message}`, { cause: error });
  }
}

export function writeJSON(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temp, 'wx');
    fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (handle != null) {
      try { fs.closeSync(handle); } catch { /* preserve the original error */ }
    }
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
}

const sleep = new Int32Array(new SharedArrayBuffer(4));

function acquireMutationLocks(files) {
  const handles = [];
  try {
    for (const file of [...files].sort()) {
      const lock = `${file}.mutation.lock`;
      const deadline = Date.now() + 10_000;
      let handle;
      while (handle == null) {
        try {
          handle = fs.openSync(lock, 'wx');
          fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try {
            const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
            if (!alive(owner.pid) || Date.now() - (owner.at ?? 0) > 120_000) {
              fs.rmSync(lock, { force: true });
              continue;
            }
          } catch { /* another process may still be creating the lock record */ }
          if (Date.now() >= deadline) throw new Error(`timed out waiting to update ${file}`);
          Atomics.wait(sleep, 0, 0, 10);
        }
      }
      handles.push({ handle, lock });
    }
    return () => {
      for (const { handle, lock } of handles.reverse()) {
        fs.closeSync(handle);
        fs.rmSync(lock, { force: true });
      }
    };
  } catch (error) {
    for (const { handle, lock } of handles.reverse()) {
      try { fs.closeSync(handle); } catch { /* preserve original error */ }
      fs.rmSync(lock, { force: true });
    }
    throw error;
  }
}

export function withMutationLocks(files, action) {
  const release = acquireMutationLocks(files);
  try { return action(); } finally { release(); }
}

export function mutateJSON(file, fallback, update) {
  const release = acquireMutationLocks([file]);
  try {
    const current = readJSON(file, fallback);
    const next = update(current) ?? current;
    writeJSON(file, next);
    return next;
  } finally {
    release();
  }
}
