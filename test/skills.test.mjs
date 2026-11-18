import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildGuide, registerSkills, SKILL_PROVIDER, UPSTREAM_SKILLS } from '../skills.js';

const ROOT = '/tmp/Understand Anything/understand-anything-plugin';
function setup({ skills = [], complete = true, observation, missing = false, changedIdentity = false } = {}) {
  const state = { registrations: 0, removals: 0, disposals: 0, invalidations: 0 };
  const original = {
    name: 'understand', description: 'Original complete analysis',
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'custom', provider: SKILL_PROVIDER, rank: 300,
    locator: { path: `${ROOT}/skills/understand/SKILL.md` },
    path: `${ROOT}/skills/understand/SKILL.md`,
    resourceBase: { kind: 'directory', path: `${ROOT}/skills/understand` },
    metadata: { owner: 'upstream' },
  };
  const body = '# Original\r\n\r\nAll phases preserved. 中文\n```json\n{"version":1}\n```\n';
  class Provider {
    constructor(ctx, control, config) {
      state.config = config;
      assert.equal(control.signal.aborted, false);
    }
    async list(options) { state.listOptions = options; return observation ?? [original]; }
    async get(candidate, options) {
      assert.equal(candidate, original);
      state.getOptions = options;
      if (missing) return undefined;
      return { ...original, name: changedIdentity ? 'changed' : original.name, content: body };
    }
    async dispose() { state.disposals++; }
  }
  const ctx = { skills: {
    async snapshot() { return { complete, skills }; },
    registerProvider(factory) {
      state.registrations++;
      state.wrapper = factory({ signal: new AbortController().signal, invalidate() { state.invalidations++; } });
      return () => { state.removals++; };
    },
  } };
  return { ctx, Provider, state, original, body };
}
const sha = text => createHash('sha256').update(text).digest('hex');

test('unique aliases preserve metadata, policies, paths and byte-exact full original body', async () => {
  const { ctx, Provider, state, original, body } = setup();
  const cleanup = await registerSkills(ctx, ROOT, Provider);
  const options = { cwd: '/tmp/project', signal: new AbortController().signal };
  const result = await state.wrapper.list(options);
  assert.equal(result.complete, true);
  assert.equal(result.candidates[0].name, 'ua-understand');
  assert.equal(result.candidates[0].locator, original);
  assert.equal(result.candidates[0].provider, SKILL_PROVIDER);
  assert.deepEqual(state.config, { providerName: SKILL_PROVIDER, includeDefaultRoots: false, customSkillDirs: [`${ROOT}/skills`], watch: true });
  const loaded = await state.wrapper.get(result.candidates[0], options);
  const prefix = buildGuide(ROOT, 'understand');
  assert.equal(loaded.content.slice(0, prefix.length), prefix);
  assert.equal(sha(loaded.content.slice(prefix.length)), sha(body));
  assert.equal(loaded.resourceBase, original.resourceBase);
  assert.equal(loaded.path, original.path);
  assert.equal(loaded.invocation, original.invocation);
  assert.equal(loaded.metadata, original.metadata);
  assert.equal(state.listOptions, options);
  assert.equal(state.getOptions, options);
  assert.equal(cleanup(), cleanup(), 'cleanup shares one promise');
  await cleanup();
  assert.equal(state.removals, 1);
  assert.equal(state.disposals, 1);
});

test('existing raw upstream names do not conflict; existing ua aliases fail closed', async () => {
  const raw = setup({ skills: [{ name: 'understand', provider: 'third-party' }] });
  await (await registerSkills(raw.ctx, ROOT, raw.Provider))();
  const clash = setup({ skills: [{ name: 'ua-understand', provider: 'third-party' }] });
  await assert.rejects(registerSkills(clash.ctx, ROOT, clash.Provider), /refusing to shadow.*third-party/);
  assert.equal(clash.state.registrations, 0);
});

test('incomplete preflight and invalid configuration never register', async () => {
  const mock = setup({ complete: false });
  await assert.rejects(registerSkills(mock.ctx, ROOT, mock.Provider), /discovery is incomplete/);
  await assert.rejects(registerSkills(mock.ctx, 'relative', mock.Provider), /absolute/);
  await assert.rejects(registerSkills(mock.ctx, ROOT, undefined), /constructor/);
  assert.equal(mock.state.registrations, 0);
});

test('provider forwards incomplete discovery and ignores unrelated upstream entries', async () => {
  const mock = setup();
  const { original } = mock;
  const second = setup({ observation: { complete: false, candidates: [original, { ...original, name: 'unrelated' }] } });
  const cleanup = await registerSkills(second.ctx, ROOT, second.Provider);
  const result = await second.state.wrapper.list({});
  assert.equal(result.complete, false);
  assert.deepEqual(result.candidates.map(c => c.name), ['ua-understand']);
  await cleanup();
});

test('missing and identity-changed skill invalidates the catalog; forged locators fail', async () => {
  for (const variant of [{ missing: true }, { changedIdentity: true }]) {
    const mock = setup(variant);
    const cleanup = await registerSkills(mock.ctx, ROOT, mock.Provider);
    const candidate = (await mock.state.wrapper.list({})).candidates[0];
    if (variant.missing) assert.equal(await mock.state.wrapper.get(candidate, {}), undefined);
    else await assert.rejects(mock.state.wrapper.get(candidate, {}), /changed identity/);
    assert.equal(mock.state.invalidations, 1);
    await assert.rejects(mock.state.wrapper.get({ ...candidate, name: 'ua-understand-chat' }, {}), /does not match/);
    await cleanup();
  }
});

test('guide describes real DSH boundaries and all original phase gates', () => {
  const text = buildGuide(ROOT, 'understand');
  for (const required of ['TaskOutput', 'subagent.prompt', 'agent_preset', 'list_subagent_models', 'completion notices', 'FIVE', 'TWELVE', 'SKIP', 'PARTIAL_UPDATE', 'ARCHITECTURE_UPDATE', 'FULL_UPDATE', 'scan-project.mjs', 'compute-batches.mjs', 'merge-batch-graphs.py', 'assemble-reviewer', 'architecture-analyzer', 'tour-builder', 'normalize-tour.mjs', 'code-lesson-writer', 'graph-reviewer', '--review', 'ELECTRON_RUN_AS_NODE=1', 'read-only', 'atomic']) {
    assert.ok(text.includes(required), `missing guide invariant: ${required}`);
  }
  assert.equal(UPSTREAM_SKILLS.length, 9);
});
