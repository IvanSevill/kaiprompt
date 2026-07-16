import { execFile } from 'node:child_process';

const ANSI_RE = /\x1B\[[0-?]*[ -\/]*[@-~]/g;

export function catalogSnapshot(value = {}) {
  value ??= {};
  return {
    status: value.status ?? 'idle',
    models: [...(value.models ?? [])],
    lastSuccessful: value.lastSuccessful ? [...value.lastSuccessful] : null,
    error: value.error ?? null,
    generation: value.generation ?? 0,
  };
}

export function parseOpenCodeModels(output) {
  const clean = String(output ?? '').replace(ANSI_RE, '');
  return [...new Set(clean.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.-]+\/[\w.-]+$/.test(line)))].map((id) => {
    const [provider, ...rest] = id.split('/');
    return { id, provider, model: rest.join('/') };
  });
}

function discover({ timeoutMs = 5000 } = {}) {
  const bin = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
  return new Promise((resolve, reject) => {
    execFile(bin, ['models'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      shell: process.platform === 'win32',
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function createModelCatalog({ discoverModels = discover, timeoutMs = 5000 } = {}) {
  let generation = 0;
  let loaded = false;
  let inFlight = null;
  let value = catalogSnapshot({ generation });

  const snapshot = () => catalogSnapshot(value);

  const load = ({ force = false } = {}) => {
    if (!force && loaded) return inFlight ?? Promise.resolve(snapshot());
    if (!force && inFlight) return inFlight;

    const mine = ++generation;
    loaded = true;
    value = { ...value, status: 'loading', error: null, generation: mine };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`OpenCode model discovery timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    inFlight = Promise.race([Promise.resolve().then(() => discoverModels({ timeoutMs })), timeout])
      .then((output) => {
        if (mine !== generation) return snapshot();
        const models = Array.isArray(output) ? output : parseOpenCodeModels(output);
        value = { status: models.length ? 'ready' : 'empty', models, lastSuccessful: [...models], error: null, generation: mine };
        return snapshot();
      })
      .catch((error) => {
        if (mine !== generation) return snapshot();
        value = {
          status: 'error', models: value.lastSuccessful ? [...value.lastSuccessful] : [],
          lastSuccessful: value.lastSuccessful, error: error?.message || String(error), generation: mine,
        };
        return snapshot();
      })
      .finally(() => {
        clearTimeout(timer);
        if (mine === generation) inFlight = null;
      });
    return inFlight;
  };

  const invalidate = () => {
    generation++;
    loaded = false;
    inFlight = null;
    value = { ...value, status: 'idle', error: null, generation };
    return snapshot();
  };

  const reload = () => {
    invalidate();
    return load();
  };

  return { snapshot, load, invalidate, reload };
}

export const modelCatalog = createModelCatalog();
