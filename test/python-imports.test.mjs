import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveScopedPythonImport, transformUpstreamHelper, loadUpstreamHelper, runCli } from '../scripts/extract-import-map.mjs';

// Minimal probe double implements upstream's leaf/package lookup + ancestor
// search. Real upstream exports are also exercised by the integration test.
function upstreamProbe(source, specs, file, ctx) {
  const dir = file.path.split('/').slice(0, -1);
  let dots = 0;
  while (source[dots] === '.') dots++;
  const tail = source.slice(dots).split('.').filter(Boolean);
  const probe = parts => {
    const base = parts.join('/');
    if (ctx.fileSet.has(`${base}.py`)) return [`${base}.py`];
    if (ctx.fileSet.has(`${base}/__init__.py`)) return [`${base}/__init__.py`, ...specs.map(s => `${base}/${s}.py`).filter(p => ctx.fileSet.has(p))];
    return [];
  };
  if (dots) return dots - 1 > dir.length ? [] : probe([...dir.slice(0, dir.length - dots + 1), ...tail]);
  for (let i = dir.length; i >= 0; i--) {
    const hits = probe([...dir.slice(0, i), ...tail]);
    if (hits.length) return hits;
  }
  return [];
}
const paths = ['tests/test_runtime.py', 'src/autogen_core/__init__.py', 'src/autogen_core/_agent.py', 'src/autogen_core/logging.py', 'src/autogen_core/_telemetry/config.py'];
const ctx = { fileSet: new Set(paths) };
const resolveImport = (source, specs = [], path = paths[0]) => resolveScopedPythonImport(source, specs, { path }, ctx, upstreamProbe);

test('src-layout imports from tests resolve the scoped package and submodule', () => {
  assert.deepEqual(resolveImport('autogen_core', ['Agent']), ['src/autogen_core/__init__.py']);
  assert.deepEqual(resolveImport('autogen_core._agent', ['Agent']), ['src/autogen_core/_agent.py']);
});
test('absolute stdlib logging does not match an arbitrary inner package', () => {
  assert.deepEqual(resolveImport('logging', [], 'src/autogen_core/_telemetry/config.py'), []);
  assert.deepEqual(resolveImport('autogen_core.logging'), ['src/autogen_core/logging.py']);
});
test('relative imports delegate to upstream with the real importer', () => {
  assert.deepEqual(resolveImport('.._agent', ['Agent'], 'src/autogen_core/_telemetry/config.py'), ['src/autogen_core/_agent.py']);
  let seen;
  resolveScopedPythonImport('.x', [], { path: paths[0] }, ctx, (...args) => { seen = args; return []; });
  assert.equal(seen[2].path, paths[0]);
});
test('out-of-scope references and traversal never resolve', () => {
  assert.deepEqual(resolveImport('autogen_test_utils'), []);
  assert.deepEqual(resolveImport('../../outside'), []);
  assert.deepEqual(resolveImport('....outside', [], 'src/autogen_core/_agent.py'), []);
  const unsafe = { fileSet: new Set([...paths, '../outside.py', '/outside.py']) };
  assert.deepEqual(resolveScopedPythonImport('outside', [], { path: paths[0] }, unsafe, () => ['../outside.py', '/outside.py']), []);
});
test('unsupported source/version fails closed before importing anything', () => {
  assert.throws(() => transformUpstreamHelper('unknown', 'file:///tmp/helper.mjs', '2.9.8'), /Unsupported upstream/);
  assert.throws(() => transformUpstreamHelper('unknown', 'file:///tmp/helper.mjs', '3.0.0'), /Unsupported upstream/);
});
test('CLI validates its original two positionals plus absolute plugin root', async () => {
  await assert.rejects(runCli([]), /Usage:/);
  await assert.rejects(runCli(['--plugin-root', 'relative', 'input', 'output']), /Usage:/);
});

const pluginRoot = process.env.UA_TEST_PLUGIN_ROOT || join(homedir(), '.understand-anything/repo/understand-anything-plugin');
const hasUpstream = existsSync(join(pluginRoot, 'skills/understand/extract-import-map.mjs'));
test('verified upstream parser/CLI preserves mixed-language shape and selective analysis', { skip: !hasUpstream }, async t => {
  const helper = await loadUpstreamHelper(pluginRoot);
  const actual = (source, specs, path) => helper.resolvePythonImport(source, specs, { path }, ctx);
  assert.deepEqual(actual('autogen_core', ['Agent'], paths[0]), ['src/autogen_core/__init__.py']);
  assert.deepEqual(actual('logging', [], paths[4]), []);
  assert.deepEqual(actual('.._agent', ['Agent'], paths[4]), ['src/autogen_core/_agent.py']);
  assert.deepEqual(actual('autogen_test_utils', [], paths[0]), []);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-python-imports-')));
  t.after(() => { assert.equal(resolve(root), root); assert.match(root, /ua-python-imports-/); rmSync(root, { recursive: true }); });
  const project = join(root, 'project');
  const contents = {
    'tests/test_runtime.py': 'from autogen_core import Agent\nfrom autogen_core._agent import Agent\nfrom autogen_test_utils import Unknown\n',
    'src/autogen_core/__init__.py': 'from ._agent import Agent\n',
    'src/autogen_core/_agent.py': 'class Agent: pass\n',
    'src/autogen_core/logging.py': 'X = 1\n',
    'src/autogen_core/_telemetry/config.py': 'import logging\nfrom .._agent import Agent\n',
    'src/a.js': 'import { b } from "./b.js";\n',
    'src/b.js': 'export const b = 1;\n',
    'README.md': '# Demo\n',
  };
  for (const [path, content] of Object.entries(contents)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content); }
  const files = Object.keys(contents).map(path => ({ path, language: path.endsWith('.py') ? 'python' : path.endsWith('.js') ? 'javascript' : 'markdown', fileCategory: path.endsWith('.md') ? 'docs' : 'code' }));
  const input = join(root, 'input.json'); const output = join(root, 'output.json'); const original = join(root, 'original.json');
  writeFileSync(input, JSON.stringify({ projectRoot: project, files }));
  const wrapper = fileURLToPath(new URL('../scripts/extract-import-map.mjs', import.meta.url));
  const run = (script, args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  run(join(pluginRoot, 'skills/understand/extract-import-map.mjs'), [input, original]);
  run(wrapper, ['--plugin-root', pluginRoot, input, output]);
  const before = JSON.parse(readFileSync(original, 'utf8')); const after = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.equal(after.scriptCompleted, true);
  assert.deepEqual(after.failures, []);
  assert.deepEqual(after.importMap['tests/test_runtime.py'], ['src/autogen_core/__init__.py', 'src/autogen_core/_agent.py']);
  assert.deepEqual(after.importMap['src/autogen_core/_telemetry/config.py'], ['src/autogen_core/_agent.py']);
  for (const path of ['src/a.js', 'src/b.js', 'README.md']) assert.deepEqual(after.importMap[path], before.importMap[path]);
  assert.equal(after.stats.totalEdges, Object.values(after.importMap).reduce((n, edges) => n + edges.length, 0));
  writeFileSync(input, JSON.stringify({ projectRoot: project, files, analysisPaths: ['tests/test_runtime.py'] }));
  run(wrapper, ['--plugin-root', pluginRoot, input, output]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(output, 'utf8')).importMap), ['tests/test_runtime.py']);
  writeFileSync(input, JSON.stringify({ projectRoot: project, files, analysisPaths: [] }));
  run(wrapper, ['--plugin-root', pluginRoot, input, output]);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).importMap, {});
  const outside = join(root, 'outside.py'); writeFileSync(outside, 'import os\n');
  symlinkSync(outside, join(project, 'escape.py'));
  writeFileSync(input, JSON.stringify({ projectRoot: project, files: [{ path: 'escape.py', language: 'python', fileCategory: 'code' }] }));
  const escaped = spawnSync(process.execPath, [wrapper, '--plugin-root', pluginRoot, input, output], { encoding: 'utf8' });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /symlink escapes/);
});
