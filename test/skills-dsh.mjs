// Run with ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/skills-dsh.mjs
// This creates only a disposable in-process Cordis registry. It never starts an
// agent, invokes a model, changes the live profile, or installs a package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { buildGuide, registerSkills, SKILL_PROVIDER } from '../skills.js';
import { resolvePluginRoot } from '../bridge.js';

const anchor = process.env.DSH_INSTALL_DIR;
// Portable default: the same resolution the plugin uses at runtime (env override,
// prepared install under $HOME, then the ~/.dsh skill symlink).
const upstreamRoot = () => process.env.UA_PLUGIN_ROOT ?? resolvePluginRoot();
const sha = text => createHash('sha256').update(text).digest('hex');

test('installed Electron/ASAR skill registry and filesystem parser preserve the original body', {
  skip: !anchor || !process.versions.electron ? 'Requires the installed DSH Electron runtime and DSH_INSTALL_DIR' : false,
}, async () => {
  assert.ok(isAbsolute(anchor));
  const root = upstreamRoot();
  assert.ok(isAbsolute(root));
  const requireFromInstallation = createRequire(join(anchor, 'package.json'));
  async function installed(name) {
    return import(pathToFileURL(requireFromInstallation.resolve(name)).href);
  }
  const { Context } = await installed('@deepseek-ai/cordis');
  const { default: SkillRegistry } = await installed('@deepseek-ai/dsh-skill');
  const { FileSystemSkillProvider } = await installed('@deepseek-ai/dsh-skill-filesystem');
  // Keep parsing/discovery real, but do not leave any filesystem watchers open.
  class ReadOnlyProvider extends FileSystemSkillProvider {
    constructor(ctx, control, config) { super(ctx, control, { ...config, watch: false }); }
  }
  const ctx = new Context();
  const registryFiber = ctx.plugin(SkillRegistry);
  // Installed Cordis has fiber lifecycle, not ctx.start()/ctx.stop().
  if (registryFiber.inertia) await registryFiber.inertia;
  assert.ok(ctx.skills, 'the installed skill service must publish before discovery');
  let cleanup;
  let originalProvider;
  try {
    const originalControl = { signal: new AbortController().signal, invalidate() {} };
    originalProvider = new ReadOnlyProvider(ctx, originalControl, {
      providerName: SKILL_PROVIDER, includeDefaultRoots: false, customSkillDirs: [join(root, 'skills')],
    });
    const originalObservation = await originalProvider.list({});
    const originals = Array.isArray(originalObservation) ? originalObservation : originalObservation.candidates;
    assert.equal(originals.length, 9, 'fixture must contain all nine original upstream skills');
    // An existing raw-name third-party contribution must remain untouched.
    ctx.skills.register({ name: 'understand', description: 'Third-party raw skill', source: 'runtime', content: 'DO NOT OVERWRITE', resourceBase: { kind: 'directory', path: '/third-party' } });
    cleanup = await registerSkills(ctx, root, ReadOnlyProvider);
    const catalog = await ctx.skills.snapshot();
    assert.equal(catalog.complete, true);
    assert.equal(catalog.skills.filter(s => s.provider === SKILL_PROVIDER).length, 9);
    for (const candidate of originals) {
      const original = await originalProvider.get(candidate, {});
      const adapted = await ctx.skills.get(`ua-${candidate.name}`);
      assert.ok(adapted);
      assert.equal(adapted.provider, SKILL_PROVIDER);
      assert.equal(adapted.path, original.path);
      assert.deepEqual(adapted.resourceBase, original.resourceBase);
      assert.deepEqual(adapted.invocation, original.invocation);
      const guide = buildGuide(root, original.name);
      assert.ok(adapted.content.startsWith(guide));
      assert.equal(sha(adapted.content.slice(guide.length)), sha(original.content), candidate.name);
      console.log(JSON.stringify({ name: adapted.name, originalBytes: Buffer.byteLength(original.content), sha256: sha(original.content), resourceBase: adapted.resourceBase }));
    }
    assert.equal((await ctx.skills.get('understand')).content, 'DO NOT OVERWRITE');
    await assert.rejects(registerSkills(ctx, root, ReadOnlyProvider), /refusing to shadow/);
    await cleanup();
    cleanup = undefined;
    assert.equal(await ctx.skills.get('ua-understand'), undefined);
    assert.equal((await ctx.skills.get('understand')).content, 'DO NOT OVERWRITE');
  } finally {
    await cleanup?.();
    await originalProvider?.dispose();
    await ctx.fiber.dispose();
  }
});
