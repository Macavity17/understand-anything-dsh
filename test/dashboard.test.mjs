import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installedTypeScript, themeRuntime } from '../theme/test-runtime.mjs';
import { prepareDashboard, isUnthemedViewerCommand } from '../dashboard.js';
import { parseDashboardArgs } from '../scripts/start-dashboard.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const launcher = path.join(repo, 'scripts/start-dashboard.mjs');
const manifest = JSON.parse(await readFile(path.join(repo, 'theme/upstream-2.9.8.json'), 'utf8'));
const stock = path.join(repo, 'tests/fixtures/upstream-2.9.8');
const stub = `console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), graph: process.env.GRAPH_DIR, demo: process.env.VITE_DEMO_MODE, theme: process.env.VITE_DSH_THEME }));\nprocess.exitCode = 0;\n`;

async function fixture(t, { themed = true, bin = stub, exports = true } = {}) {
  const prefix = path.join(await realpath(os.tmpdir()), 'ua-dashboard-test-');
  const root = await mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(prefix) && resolved !== prefix, `Unexpected cleanup path: ${resolved}`);
    await rm(resolved, { recursive: true, force: true });
  });
  const upstream = path.join(root, 'upstream copy with spaces');
  await cp(stock, upstream, { recursive: true });
  const pluginRoot = path.join(upstream, 'understand-anything-plugin');
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'understand-anything', version: '2.9.8' }));
  if (themed) for (const entry of manifest.files) await cp(path.join(repo, entry.payload), path.join(upstream, entry.target));
  const dashboardDir = path.join(pluginRoot, 'packages/dashboard');
  await writeFile(path.join(dashboardDir, 'package.json'), JSON.stringify({ name: '@understand-anything/dashboard', private: true }));
  const viteDir = path.join(dashboardDir, 'node_modules/vite');
  await mkdir(path.join(viteDir, 'bin'), { recursive: true });
  await writeFile(path.join(viteDir, 'package.json'), JSON.stringify({ name: 'vite', version: '6.3.5', type: 'module', bin: { vite: 'bin/vite.js' }, ...(exports ? { exports: { './package.json': './package.json' } } : {}) }));
  await writeFile(path.join(viteDir, 'bin/vite.js'), bin);
  const projectRoot = path.join(root, "project's graph with spaces");
  await mkdir(path.join(projectRoot, '.ua'), { recursive: true });
  await writeFile(path.join(projectRoot, '.ua/knowledge-graph.json'), '{}\n');
  const cliArgs = [launcher, '--plugin-root', pluginRoot, '--project-root', projectRoot];
  const run = (extra = [], env = {}) => spawnSync(process.execPath, [...cliArgs, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { root, upstream, pluginRoot, dashboardDir, viteDir, projectRoot, cliArgs, run };
}

async function themeBytes(env) {
  return Promise.all(manifest.files.map((entry) => readFile(path.join(env.upstream, entry.target))));
}

async function removeFixtureFile(env, target) {
  const resolved = path.resolve(target);
  assert.ok(resolved.startsWith(path.resolve(env.root) + path.sep), `Refuse unexpected removal: ${resolved}`);
  await rm(resolved, { recursive: true });
}

test('read-only preparation verifies applied theme and returns exact local launch paths', async (t) => {
  const env = await fixture(t);
  const before = await themeBytes(env);
  const result = await prepareDashboard(env.pluginRoot, env.projectRoot);
  assert.equal(result.themeId, 'DeepSeek-blue');
  assert.equal(result.themeVerification.check, true);
  assert.equal(result.themeVerification.changed, 0);
  assert.equal(result.pluginRoot, await realpath(env.pluginRoot));
  assert.equal(result.projectRoot, await realpath(env.projectRoot));
  assert.equal(result.cwd, await realpath(env.dashboardDir));
  assert.equal(result.graphPath, await realpath(path.join(env.projectRoot, '.ua/knowledge-graph.json')));
  assert.equal(result.viteBin, await realpath(path.join(env.viteDir, 'bin/vite.js')));
  assert.equal(result.viteVersion, '6.3.5');
  assert.deepEqual(result.argv, [launcher, '--plugin-root', result.pluginRoot, '--project-root', result.projectRoot]);
  assert.deepEqual(result.env, { GRAPH_DIR: result.projectRoot, VITE_DEMO_MODE: 'false', VITE_DSH_THEME: 'deepseek' });
  assert.match(result.command, /DSH_NODE_EXECUTABLE:\?/);
  assert.doesNotMatch(result.command, /npx|npm exec| &$/);
  assert.deepEqual(await themeBytes(env), before);
  // Verify shell quoting (including apostrophes) with a non-serving Vite stub.
  const commandRun = spawnSync('/bin/bash', ['-c', result.command], { cwd: result.cwd, encoding: 'utf8', env: { ...process.env, DSH_NODE_EXECUTABLE: process.execPath } });
  assert.equal(commandRun.status, 0, commandRun.stderr);
  assert.equal(JSON.parse(commandRun.stdout).graph, result.projectRoot);
});

test('stock files pass theme hash check but MUST NOT claim a themed dashboard or launch', async (t) => {
  const env = await fixture(t, { themed: false });
  const before = await themeBytes(env);
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /theme is not applied: 4 pending/);
  const result = env.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /4 pending/);
  assert.deepEqual(await themeBytes(env), before);
});

test('partially applied or user-edited theme is a hard read-only failure', async (t) => {
  const env = await fixture(t, { themed: false });
  const entry = manifest.files[0];
  await cp(path.join(repo, entry.payload), path.join(env.upstream, entry.target));
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /3 pending/);
  await writeFile(path.join(env.upstream, entry.target), 'user edits');
  const before = await themeBytes(env);
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /preimage mismatch/);
  assert.deepEqual(await themeBytes(env), before);
});

test('unsupported upstream version fails before launch', async (t) => {
  const env = await fixture(t);
  await writeFile(path.join(env.pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'understand-anything', version: '2.9.9' }));
  const result = env.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unsupported upstream version/);
});

test('legacy directory takes precedence; a missing legacy graph never falls back to .ua', async (t) => {
  const env = await fixture(t);
  const legacy = path.join(env.projectRoot, '.understand-anything');
  await mkdir(legacy);
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /No knowledge graph found.*\.understand-anything/);
  await writeFile(path.join(legacy, 'knowledge-graph.json'), '{"legacy":true}');
  const result = await prepareDashboard(env.pluginRoot, env.projectRoot);
  assert.equal(result.graphPath, path.join(legacy, 'knowledge-graph.json'));
});

test('a non-directory legacy entry uses .ua, as upstream does', async (t) => {
  const env = await fixture(t);
  await writeFile(path.join(env.projectRoot, '.understand-anything'), 'not a directory');
  assert.equal((await prepareDashboard(env.pluginRoot, env.projectRoot)).graphPath, path.join(env.projectRoot, '.ua/knowledge-graph.json'));
});

test('missing graph and non-file graph fail before any Vite execution', async (t) => {
  const env = await fixture(t);
  const graph = path.join(env.projectRoot, '.ua/knowledge-graph.json');
  await removeFixtureFile(env, graph);
  let result = env.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  await mkdir(graph);
  result = env.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Not a regular file/);
});

test('Vite exports fallback and direct bin resolution both work locally', async (t) => {
  const env = await fixture(t, { exports: false });
  assert.equal((await prepareDashboard(env.pluginRoot, env.projectRoot)).viteBin, path.join(env.viteDir, 'bin/vite.js'));
});

test('pnpm-style local Vite symlink resolves to its verified installed target', async (t) => {
  const env = await fixture(t);
  const stored = path.join(env.root, 'pnpm store/vite');
  await mkdir(path.dirname(stored));
  await cp(env.viteDir, stored, { recursive: true });
  await removeFixtureFile(env, env.viteDir);
  await symlink(stored, env.viteDir, 'dir');
  const result = await prepareDashboard(env.pluginRoot, env.projectRoot);
  assert.equal(result.viteBin, path.join(stored, 'bin/vite.js'));
});

test('missing local dependencies do not resolve ancestor Vite, install, or use npx', async (t) => {
  const env = await fixture(t);
  const ancestor = path.join(env.pluginRoot, 'node_modules/vite');
  await mkdir(path.dirname(ancestor), { recursive: true });
  await cp(env.viteDir, ancestor, { recursive: true });
  await removeFixtureFile(env, env.viteDir);
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /Installed local dashboard Vite is required/);
  const result = env.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no installation or npx fallback/);
});

test('missing Vite bin fails preflight', async (t) => {
  const env = await fixture(t);
  await removeFixtureFile(env, path.join(env.viteDir, 'bin/vite.js'));
  await assert.rejects(prepareDashboard(env.pluginRoot, env.projectRoot), /Installed local dashboard Vite is required/);
});

test('CLI launches normal Vite with explicit loopback, strict port, cwd and non-demo environment', async (t) => {
  const env = await fixture(t);
  const result = env.run([], { VITE_DEMO_MODE: 'true', GRAPH_DIR: '/wrong', VITE_DSH_THEME: 'gold' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv: ['--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd: env.dashboardDir, graph: env.projectRoot, demo: 'false', theme: 'deepseek' });
  const custom = env.run(['--port', '5210']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.deepEqual(JSON.parse(custom.stdout).argv, ['--host', '127.0.0.1', '--port', '5210', '--strictPort']);
});

test('CLI rejects invalid or duplicate arguments without starting a child', async (t) => {
  const env = await fixture(t);
  for (const extra of [['--port', '0'], ['--port', '65536'], ['--port', '12.5'], ['--port'], ['--bad'], ['--plugin-root', env.pluginRoot]]) {
    const result = env.run(extra);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  assert.throws(() => parseDashboardArgs([]), /Usage/);
});

test('Vite nonzero status and child signal propagate to the launcher', async (t) => {
  const env = await fixture(t, { bin: 'process.exitCode = 23;\n' });
  assert.equal(env.run().status, 23);
  await writeFile(path.join(env.viteDir, 'bin/vite.js'), "process.kill(process.pid, 'SIGTERM');\n");
  const result = env.run();
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
});

const typescript = installedTypeScript();
const runtimeOptions = { skip: !typescript && 'Install upstream TypeScript or set UA_THEME_TYPESCRIPT for TSX behavior tests' };
const gold = { presetId: 'dark-gold', accentId: 'gold', headingFont: 'mono' };
const forest = { presetId: 'dark-forest', accentId: 'emerald' };
const deepseek = { presetId: 'dark-deepseek', accentId: 'deepseek-blue' };

test('branded boot overrides old gold storage without changing it, including StrictMode replay', runtimeOptions, async () => {
  const runtime = await themeRuntime(typescript, { mode: 'deepseek', saved: gold });
  assert.deepEqual(runtime.render(gold, { replayMountEffects: true }), deepseek);
  assert.equal(runtime.preset.id, 'dark-deepseek');
  assert.equal(runtime.preset.colors.root, '#070b18');
  assert.equal(runtime.accent.accent, '#4D6BFE');
  assert.equal(runtime.stored, JSON.stringify(gold));
  assert.equal(runtime.writes.length, 0);
  assert.ok(runtime.applied.length >= 2); // Both mount effect executions apply DeepSeek.
  for (const config of runtime.applied) assert.equal(config.presetId, 'dark-deepseek');
  assert.deepEqual(runtime.render(forest), deepseek);
  assert.equal(runtime.writes.length, 0);
});

test('branded boot with no preference ignores late metadata and does not create a preference', runtimeOptions, async () => {
  const runtime = await themeRuntime(typescript, { mode: 'deepseek' });
  assert.deepEqual(runtime.render(), deepseek);
  assert.deepEqual(runtime.render(gold), deepseek);
  assert.equal(runtime.stored, null);
  assert.equal(runtime.writes.length, 0);
});

test('ordinary launch keeps saved > metadata > default precedence and async metadata behavior', runtimeOptions, async () => {
  for (const mode of [undefined, 'gold', 'DEEPSEEK']) {
    const runtime = await themeRuntime(typescript, { mode, saved: gold });
    assert.deepEqual(runtime.render(forest), gold);
    assert.deepEqual(runtime.render(forest), gold);
    assert.equal(runtime.writes.length, 0);
  }
  const withMeta = await themeRuntime(typescript);
  assert.deepEqual(withMeta.render(forest), forest);
  const delayed = await themeRuntime(typescript);
  assert.deepEqual(delayed.render(), deepseek);
  assert.deepEqual(delayed.render(gold), gold);
  assert.equal(delayed.stored, JSON.stringify(gold)); // Ordinary upstream async persistence retained.
});

test('branded mode permits and persists in-session preset/accent/font choices; metadata cannot reset them', runtimeOptions, async () => {
  const runtime = await themeRuntime(typescript, { mode: 'deepseek', saved: gold });
  runtime.render();
  runtime.picker.setPreset('dark-forest');
  assert.deepEqual(runtime.render(), forest);
  runtime.picker.setAccent('ocean');
  runtime.render();
  runtime.picker.setHeadingFont('sans');
  const chosen = { presetId: 'dark-forest', accentId: 'ocean', headingFont: 'sans' };
  assert.deepEqual(runtime.render(), chosen);
  assert.equal(runtime.stored, JSON.stringify(chosen));
  assert.deepEqual(runtime.render(gold), chosen);
  const ordinary = await themeRuntime(typescript, { saved: JSON.parse(runtime.stored) });
  assert.deepEqual(ordinary.render(gold), chosen);
  const nextBranded = await themeRuntime(typescript, { mode: 'deepseek', saved: chosen });
  assert.deepEqual(nextBranded.render(), deepseek);
  assert.equal(nextBranded.stored, JSON.stringify(chosen));
});

test('branded picker remains usable when browser storage is unavailable', runtimeOptions, async () => {
  const runtime = await themeRuntime(typescript, { mode: 'deepseek', storageUnavailable: true });
  assert.deepEqual(runtime.render(), deepseek);
  runtime.picker.setPreset('dark-forest');
  assert.deepEqual(runtime.render(gold), forest);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} stops/reaps Vite and its subprocess without orphaning`, { timeout: 10000 }, async (t) => {
    const bin = `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const alive = setInterval(() => {}, 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  child.once('close', () => { clearInterval(alive); process.exit(0); });
  child.kill(signal);
});
console.log('READY ' + process.pid + ' ' + child.pid);
`;
    const env = await fixture(t, { bin });
    const child = spawn(process.execPath, env.cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const ready = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(/READY (\d+) (\d+)/);
        if (match) resolve(match.slice(1).map(Number));
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', () => reject(new Error(`Launcher exited before readiness: ${stdout} ${stderr}`)));
    });
    child.kill(signal);
    assert.deepEqual(await closed, { code: null, signal });
    for (const pid of ready) assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  });
}

test('recognizer catches only known external upstream viewer executions, including quoted/variable fast path', () => {
  const url = 'https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.8/understand-anything-viewer.tgz';
  const commands = [
    `npx --yes ${url} /project`, `npx --yes "${url}" "/project space"`,
    `/usr/local/bin/npx '${url}'`, `npm exec --yes -- '${url}' /project`,
    `npm exec --package="${url}" -- understand-anything-viewer`,
    `VIEWER_URL="${url}"\nnpx --yes "$VIEWER_URL" "$PROJECT_DIR"`,
    `export VIEWER_URL='${url}'; npx --yes \${VIEWER_URL}`,
    `VIEWER_URL="https://github.com/Egonex-AI/Understand-Anything/releases/download/v\${PLUGIN_VERSION}/understand-anything-viewer.tgz"; npx --yes "$VIEWER_URL" "$PROJECT_DIR"`,
    `env VIEWER_URL='${url}' npx --yes "$VIEWER_URL"`,
    `command npx --yes '${url}'`,
  ];
  for (const command of commands) assert.equal(isUnthemedViewerCommand(command), true, command);
  for (const command of [
    `echo 'npx --yes ${url}'`, `printf '%s' '${url}'`,
    `node -p "require('/plugin/package.json').version"`,
    `read '${url}'`, `cat /tmp/understand-anything-viewer.tgz`,
    `ls /tmp/understand-anything-viewer.tgz`, `test -f /tmp/understand-anything-viewer.tgz`,
    `npx --yes vite --host 127.0.0.1`, `npm exec -- eslint .`,
    `npx eslint '${url}'`, `npm exec -- some-reader '${url}'`,
    `npx --yes https://example.com/unrelated.tgz`, `npm install '${url}'`,
    `VIEWER_URL='${url}'; printf '%s' "$VIEWER_URL"`,
    `# npx '${url}'\necho ok`, '', null,
  ]) assert.equal(isUnthemedViewerCommand(command), false, String(command));
});
