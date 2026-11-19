import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareUpstream } from '../scripts/prepare-upstream.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(repo, 'theme/upstream-2.9.8.json')));
const fixture = path.join(repo, 'tests/fixtures/upstream-2.9.8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const metadata = 'understand-anything-plugin/.claude-plugin/plugin.json';

async function isolated(t) {
  const prefix = path.join(os.tmpdir(), 'ua-install-test-');
  const root = await mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(prefix) && resolved !== prefix, `Refuse unexpected cleanup: ${resolved}`);
    await rm(resolved, { recursive: true, force: true });
  });
  const upstream = path.join(root, 'upstream copy with spaces');
  await cp(fixture, upstream, { recursive: true });
  await mkdir(path.dirname(path.join(upstream, metadata)), { recursive: true });
  await writeFile(path.join(upstream, metadata), JSON.stringify({ name: 'understand-anything', version: '2.9.8' }));
  return { root, upstream };
}

async function installFixture(t) {
  const env = await isolated(t);
  const bridge = path.join(env.root, 'bridge copy with spaces');
  await mkdir(bridge);
  for (const entry of ['install.sh', 'scripts/prepare-upstream.mjs', 'theme']) {
    await cp(path.join(repo, entry), path.join(bridge, entry), { recursive: true });
  }
  await writeFile(path.join(bridge, 'cordis.patch.yml'), '# fixture\n');
  const home = path.join(env.root, 'home');
  const skills = path.join(home, '.dsh/skills');
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(skills, 'understand'), 'third-party owned skill');
  await symlink('/third-party/skill', path.join(skills, 'understand-dashboard'));
  const log = path.join(env.root, 'pnpm-log');
  const pnpm = path.join(env.root, 'pnpm.mjs');
  await writeFile(pnpm, `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.MOCK_PNPM_VERSION || '10.6.2'); }
else { fs.appendFileSync(process.env.MOCK_LOG, args.join(' ') + '\\n'); process.exitCode = Number(process.env.MOCK_PNPM_EXIT || 0); }
`);
  const run = (args = [], overrides = {}) => spawnSync('/bin/bash', [path.join(bridge, 'install.sh'), ...args], {
    cwd: env.root, encoding: 'utf8', env: {
      ...process.env, HOME: home, UA_DIR: env.upstream, BRIDGE_DIR: bridge,
      NODE_BIN: process.execPath, PNPM_SCRIPT: pnpm, MOCK_LOG: log, ...overrides,
    },
  });
  return { ...env, bridge, home, skills, log, run };
}

async function unchangedSkills(env) {
  assert.equal(await readFile(path.join(env.skills, 'understand'), 'utf8'), 'third-party owned skill');
  assert.ok((await lstat(path.join(env.skills, 'understand-dashboard'))).isSymbolicLink());
}

test('theme baseline and payload hashes match the pinned manifest', async () => {
  for (const file of manifest.files) {
    assert.equal(hash(await readFile(path.join(fixture, file.target))), file.beforeSha256);
    assert.equal(hash(await readFile(path.join(repo, file.payload))), file.afterSha256);
  }
});

test('theme reproduces all four files byte-for-byte and is idempotent', async (t) => {
  const { upstream } = await isolated(t);
  assert.equal((await prepareUpstream(upstream)).changed, 4);
  for (const file of manifest.files) assert.deepEqual(await readFile(path.join(upstream, file.target)), await readFile(path.join(repo, file.payload)));
  assert.equal((await prepareUpstream(upstream)).changed, 0);
});

test('--check validates without writing', async (t) => {
  const { upstream } = await isolated(t);
  assert.equal((await prepareUpstream(upstream, { check: true })).changed, 4);
  for (const file of manifest.files) assert.equal(hash(await readFile(path.join(upstream, file.target))), file.beforeSha256);
});

test('unknown upstream version fails before any write', async (t) => {
  const { upstream } = await isolated(t);
  await writeFile(path.join(upstream, metadata), JSON.stringify({ name: 'understand-anything', version: '2.9.9' }));
  await assert.rejects(prepareUpstream(upstream), /Unsupported upstream version/);
  for (const file of manifest.files) assert.equal(hash(await readFile(path.join(upstream, file.target))), file.beforeSha256);
});

test('changed last file fails preflight without patching earlier files', async (t) => {
  const { upstream } = await isolated(t);
  const last = manifest.files.at(-1);
  await writeFile(path.join(upstream, last.target), 'user stylesheet');
  await assert.rejects(prepareUpstream(upstream), /preimage mismatch/);
  for (const file of manifest.files.slice(0, -1)) assert.equal(hash(await readFile(path.join(upstream, file.target))), file.beforeSha256);
  assert.equal(await readFile(path.join(upstream, last.target), 'utf8'), 'user stylesheet');
});

test('mixed already-patched/pristine files are explicitly completed', async (t) => {
  const { upstream } = await isolated(t);
  await writeFile(path.join(upstream, manifest.files[0].target), await readFile(path.join(repo, manifest.files[0].payload)));
  assert.equal((await prepareUpstream(upstream)).changed, 3);
});

test('prior three-file patch upgrades exactly types and context; edited context is preserved', async (t) => {
  const { upstream } = await isolated(t);
  const types = manifest.files[0];
  const currentTypes = await readFile(path.join(repo, types.payload), 'utf8');
  const priorTypes = currentTypes.slice(0, currentTypes.indexOf('\n/** The branded launcher'));
  assert.equal(hash(priorTypes), types.priorSha256);
  await writeFile(path.join(upstream, types.target), priorTypes);
  for (const file of manifest.files.slice(1, 3)) {
    await writeFile(path.join(upstream, file.target), await readFile(path.join(repo, file.payload)));
  }
  assert.equal((await prepareUpstream(upstream, { check: true })).changed, 2);
  const context = path.join(upstream, manifest.files[3].target);
  const pristine = await readFile(context);
  await writeFile(context, '// user edit\n' + pristine);
  await assert.rejects(prepareUpstream(upstream), /preimage mismatch/);
  assert.equal(hash(await readFile(path.join(upstream, types.target))), types.priorSha256);
  assert.equal(await readFile(context, 'utf8'), '// user edit\n' + pristine);
  await writeFile(context, pristine);
  assert.equal((await prepareUpstream(upstream)).changed, 2);
  assert.equal((await prepareUpstream(upstream)).changed, 0);
});

test('missing theme file fails before any write', async (t) => {
  const { upstream } = await isolated(t);
  const target = path.resolve(upstream, manifest.files.at(-1).target);
  assert.ok(target.startsWith(path.resolve(upstream) + path.sep));
  await rm(target);
  await assert.rejects(prepareUpstream(upstream), /ENOENT/);
  assert.equal(hash(await readFile(path.join(upstream, manifest.files[0].target))), manifest.files[0].beforeSha256);
});

test('theme symlink into a different checkout is refused and untouched', async (t) => {
  const { root, upstream } = await isolated(t);
  const file = manifest.files.at(-1);
  const external = path.join(root, 'external.css');
  const target = path.resolve(upstream, file.target);
  assert.ok(target.startsWith(path.resolve(upstream) + path.sep));
  await writeFile(external, await readFile(target));
  await rm(target);
  await symlink(external, target);
  await assert.rejects(prepareUpstream(upstream), /Refusing symlink/);
  assert.equal(hash(await readFile(external)), file.beforeSha256);
});

test('CLI rejects missing arguments instead of silently skipping', async () => {
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/prepare-upstream.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing --upstream/);
});

test('installer builds core then normal dashboard, preserves skills, prints AI-tool JSON', async (t) => {
  const env = await installFixture(t);
  const result = env.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(env.log, 'utf8'), 'install --frozen-lockfile\n--filter @understand-anything/core build\n--filter @understand-anything/dashboard build\n');
  assert.match(result.stdout, /"action": "install_bundle"/);
  assert.match(result.stdout, /不是 shell 命令/);
  assert.match(result.stdout, /token=/);
  assert.match(result.stdout, /4 patched file/);
  for (const file of manifest.files) assert.equal(hash(await readFile(path.join(env.upstream, file.target))), file.afterSha256);
  await unchangedSkills(env);
});

test('--update repeats preparation only and never pulls user Git changes', async (t) => {
  const env = await installFixture(t);
  // A repository-like checkout must not trigger a pull, checkout or fetch.
  await mkdir(path.join(env.upstream, '.git'));
  await writeFile(path.join(env.upstream, 'user-file.txt'), 'local user work');
  const result = env.run(['--update']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(env.upstream, 'user-file.txt'), 'utf8'), 'local user work');
  await unchangedSkills(env);
});

test('pnpm 9 is refused; no npm workspace fallback or theme writes', async (t) => {
  const env = await installFixture(t);
  const result = env.run([], { MOCK_PNPM_VERSION: '9.15.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /需要 pnpm >=10/);
  assert.equal(hash(await readFile(path.join(env.upstream, manifest.files[0].target))), manifest.files[0].beforeSha256);
});

test('missing pnpm fails, even with npm available', async (t) => {
  const env = await installFixture(t);
  const result = env.run([], { PNPM_SCRIPT: '', PNPM_BIN: '/no-such-pnpm' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不支持 npm workspace fallback/);
});

test('dependency failure is visible and never retried without frozen lockfile', async (t) => {
  const env = await installFixture(t);
  const result = env.run([], { MOCK_PNPM_EXIT: '17' });
  assert.equal(result.status, 17);
  assert.equal(await readFile(env.log, 'utf8'), 'install --frozen-lockfile\n');
  assert.doesNotMatch(result.stdout, /"action": "install_bundle"/);
});

test('unknown upstream directory is preserved and refused', async (t) => {
  const env = await installFixture(t);
  const unknown = path.join(env.root, 'unknown user directory');
  await mkdir(unknown);
  await writeFile(path.join(unknown, 'keep.txt'), 'keep');
  const result = env.run([], { UA_DIR: unknown });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /上游目录未知/);
  assert.equal(await readFile(path.join(unknown, 'keep.txt'), 'utf8'), 'keep');
});

test('unknown bridge directory is preserved and refused', async (t) => {
  const env = await installFixture(t);
  const unknown = path.join(env.root, 'unknown bridge');
  await mkdir(unknown);
  const result = env.run([], { BRIDGE_DIR: unknown });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bridge 目录未知/);
  assert.ok((await lstat(unknown)).isDirectory());
});

test('Node.js 21 fails before preparation or dependency installation', async (t) => {
  const env = await installFixture(t);
  const oldNode = path.join(env.root, 'old-node');
  await writeFile(oldNode, '#!/bin/sh\nprintf "需要 Node.js >=22\\n" >&2\nexit 1\n', { mode: 0o755 });
  const result = env.run([], { NODE_BIN: oldNode });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /需要 Node.js >=22/);
  assert.equal(hash(await readFile(path.join(env.upstream, manifest.files[0].target))), manifest.files[0].beforeSha256);
});

test('corrupt packaged payload fails before changing upstream', async (t) => {
  const env = await installFixture(t);
  await writeFile(path.join(env.bridge, manifest.files.at(-1).payload), 'tampered payload');
  const result = env.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Corrupt theme payload/);
  for (const file of manifest.files) assert.equal(hash(await readFile(path.join(env.upstream, file.target))), file.beforeSha256);
});

test('fresh clone uses v2.9.8 and refuses a moved release tag', async (t) => {
  const env = await installFixture(t);
  const bin = path.join(env.root, 'bin');
  await mkdir(bin);
  const git = path.join(bin, 'git');
  const gitLog = path.join(env.root, 'git-log');
  await writeFile(git, `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_GIT_LOG"
if [ "$1" = "clone" ]; then
  for last do :; done
  mkdir -p "$last"
  exit 0
fi
printf 'wrong-commit\\n'
`, { mode: 0o755 });
  const newUpstream = path.join(env.root, 'new upstream');
  const result = env.run([], { UA_DIR: newUpstream, PATH: bin + path.delimiter + process.env.PATH, MOCK_GIT_LOG: gitLog });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /标签提交不匹配/);
  assert.match(await readFile(gitLog, 'utf8'), /clone --depth 1 --branch v2\.9\.8 -- https:\/\/github\.com\/Egonex-AI\/Understand-Anything\.git/);
  assert.ok((await lstat(newUpstream)).isDirectory());
});

test('--uninstall never deletes arbitrary skill files or symlinks', async (t) => {
  const env = await installFixture(t);
  const result = env.run(['--uninstall']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /remove_bundle/);
  await unchangedSkills(env);
});
