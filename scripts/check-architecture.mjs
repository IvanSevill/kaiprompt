import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src', 'lib'];
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.resolve(target));
  }
}

for (const directory of roots.map((name) => path.join(ROOT, name))) collect(directory);
for (const name of ['kaip.mjs', 'install.mjs', 'uninstall.mjs']) files.push(path.join(ROOT, name));

const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
let lines = 0;
let boundaryLines = 0;
const IMPORT_RE = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const fileLines = source ? source.split(/\r?\n/).length : 0;
  lines += fileLines;
  if (path.relative(ROOT, file).startsWith(`src${path.sep}`)) boundaryLines += fileLines;
  for (const match of source.matchAll(IMPORT_RE)) {
    if (!match[1].startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), match[1]);
    if (fileSet.has(target)) graph.get(file).push(target);
  }
}

const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const boundary = (file) => relative(file).match(/^src\/(storage|core|events|adapters|runner)\//)?.[1] ?? null;
const rank = { storage: 0, core: 1, events: 1, adapters: 2, runner: 3 };
const violations = [];
for (const [source, targets] of graph) {
  const owner = boundary(source);
  if (!owner) continue;
  for (const target of targets) {
    const dependency = boundary(target);
    if (dependency && rank[owner] < rank[dependency]) {
      violations.push(`${relative(source)} -> ${relative(target)}`);
    }
  }
}

const state = new Map();
const stack = [];
const cycles = [];
function visit(file) {
  state.set(file, 1);
  stack.push(file);
  for (const target of graph.get(file)) {
    if (!state.has(target)) visit(target);
    else if (state.get(target) === 1) {
      const start = stack.indexOf(target);
      cycles.push([...stack.slice(start), target].map(relative).join(' -> '));
    }
  }
  stack.pop();
  state.set(file, 2);
}
for (const file of files) if (!state.has(file)) visit(file);

if (cycles.length || violations.length) {
  if (cycles.length) console.error(`Static import cycles (${cycles.length}):\n${cycles.join('\n')}`);
  if (violations.length) console.error(`Forbidden reverse dependencies (${violations.length}):\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture OK: ${files.length} modules, ${lines} LOC (${boundaryLines} in src boundaries), 0 static import cycles, 0 forbidden reverse dependencies.`);
}
