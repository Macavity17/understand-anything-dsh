import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installExecutionGates } from '../execution-gates.js';

function fixture(pluginRoot, project) {
  let guard, dispose;
  const cwd = project ?? realpathSync(tmpdir());
  const ctx = { tools: { guard(fn) { guard = fn; } }, workingDirectory: { get(s) { return s.cwd; } }, effect(fn) { dispose = fn(); } };
  const agent = { session: { cwd } };
  const gates = installExecutionGates(ctx, pluginRoot);
  const prepared = index => ({ projectRoot: cwd, cwd, mode: 'full', plan: 'batches', batchIndex: index, prompt: `# Complete canonical file-analyzer role\nROLE-END\nBatch ${index}` });
  const dispatch = p => ({ name: 'subagent', agent, arguments: { cwd, name: `fa-batch-${p.batchIndex}`, prompt: p.prompt } });
  return { gates, guard: e => guard(e), dispose: () => dispose(), agent, prepared, dispatch, cwd };
}

test('rejects the actual trial viewer command but not unrelated npx or data reads', () => {
  const f = fixture();
  assert.match(f.guard({ name: 'bash', arguments: { command: 'VIEWER_URL="https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.8/understand-anything-viewer.tgz"\nnpx --yes "$VIEWER_URL" "$PROJECT_DIR"' } }), /lacks the local DeepSeek theme/);
  assert.equal(f.guard({ name: 'bash', arguments: { command: 'npx eslint .' } }), undefined);
  assert.equal(f.gates.stats.unthemedViewersRejected, 1);
});

test('canonical prompt is accepted, shortened prompt denied before dispatch, retry preserves original', () => {
  const f = fixture(), p = f.prepared(1); f.gates.remember(f.agent, p);
  assert.equal(f.guard(f.dispatch(p)), undefined);
  assert.match(f.guard(f.dispatch({ ...p, prompt: 'file-analyzer: just convert metrics' })), /shortened/);
  assert.equal(f.guard(f.dispatch({ ...p, prompt: p.prompt + '\n\n# Retry feedback\nMissing direction; repair original output.' })), undefined);
  const wrong = f.dispatch(p); wrong.arguments.cwd = '/'; assert.match(f.guard(wrong), /another project/);
  assert.equal(f.gates.stats.shortenedPromptsRejected, 2);
});

test('subagent_fork cannot bypass the canonical prompt or failed-wave gate', () => {
  const f = fixture(), p = f.prepared(1), q = f.prepared(2);
  f.gates.remember(f.agent, p); f.gates.remember(f.agent, q);
  const fork = x => ({ ...f.dispatch(x), name: 'subagent_fork' });
  assert.equal(f.guard(fork(p)), undefined);
  assert.match(f.guard(fork({ ...p, prompt: 'file-analyzer shortened' })), /shortened/);
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: false }, { batchIndexes: [1] });
  assert.match(f.guard(fork(q)), /Previous batch wave/);
});

test('full-run completion needs phase requests and exact normalized tour; publication expires on mutation', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-phase-proof-')));
  t.after(() => { assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'ua-phase-proof-'))); rmSync(root, { recursive: true }); });
  mkdirSync(join(root, 'agents')); mkdirSync(join(root, '.ua/intermediate'), { recursive: true });
  const f = fixture(root, root); f.gates.remember(f.agent, f.prepared(1));
  const graph = { nodes: [{ id: 'file:a.py' }], layers: [{ id: 'layer:main', name: 'Main', description: 'Agent contracts', nodeIds: ['file:a.py'] }], tour: [{ order: 1, description: 'Actual narrative', nodeIds: ['file:a.py'] }] };
  assert.equal(f.gates.completionIssues(f.agent, root, graph).length, 8);
  for (const role of ['assemble-reviewer', 'architecture-analyzer', 'tour-builder', 'code-lesson-writer']) {
    const original = `---\nname: ${role}\n---\nComplete ${role} instructions`;
    writeFileSync(join(root, 'agents', role + '.md'), original);
    const p = { ...f.prepared(1), role, prompt: original + '\nAuthoritative inputs' };
    f.gates.rememberPhase(f.agent, p);
    assert.match(f.guard({ name: 'subagent_fork', agent: f.agent, arguments: { cwd: root, name: role, prompt: original } }), /inputs\/addenda/);
    assert.equal(f.guard({ name: 'subagent_fork', agent: f.agent, arguments: { cwd: root, name: role, prompt: p.prompt } }), undefined);
  }
  writeFileSync(join(root, '.ua/intermediate/assemble-review.json'), JSON.stringify({ fixedSectionOk: true, nodesRecovered: 0, edgesRestored: 0, crossBatchEdgesAdded: 0, typesRemapped: 0, complexityRemapped: 0, notes: [] }));
  writeFileSync(join(root, '.ua/intermediate/layers.json'), JSON.stringify(graph.layers));
  writeFileSync(join(root, '.ua/intermediate/tour.json'), JSON.stringify(graph.tour));
  writeFileSync(join(root, '.ua/intermediate/tour.normalized.json'), JSON.stringify(graph.tour));
  assert.deepEqual(f.gates.completionIssues(f.agent, root, graph), []);
  assert.match(f.gates.completionIssues(f.agent, root, { ...graph, tour: [] })[0].message, /exact original normalized/);
  assert.match(f.gates.launchDenial(f.agent, root), /EXACT current/);
  for (const name of ['knowledge-graph.json', 'meta.json', 'fingerprints.json']) writeFileSync(join(root, '.ua', name), '{}');
  f.gates.publication(f.agent, { stage: 'published', projectRoot: root, valid: true });
  assert.equal(f.gates.launchDenial(f.agent, root), undefined);
  writeFileSync(join(root, '.ua/meta.json'), '{"changed":true}');
  assert.match(f.gates.launchDenial(f.agent, root), /EXACT current/);
  assert.deepEqual(f.gates.completionIssues({}, root, graph), [], 'Unrelated agent has no invented historical phase proof');
  f.gates.review(f.agent, { stage: 'batches', projectRoot: root, valid: true }, {});
  f.gates.remember(f.agent, f.prepared(1));
  assert.equal(f.gates.completionIssues(f.agent, root, graph).filter(i => i.path.startsWith('phases.') && !i.path.endsWith('.json')).length, 4, 'Returning to batch preparation invalidates old full-run role evidence');
  f.gates.remember(f.agent, { ...f.prepared(1), mode: 'incremental' });
  assert.equal(f.gates.hasActiveFull(f.agent, root), false, 'An incremental invocation must not inherit an earlier full-run obligation');
});

test('failed-wave acceptance blocks next wave; repaired acceptance frees it', () => {
  const f = fixture(), p = f.prepared(1), q = f.prepared(2);
  f.gates.remember(f.agent, p); f.gates.remember(f.agent, q);
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: false }, { batchIndexes: [1] });
  assert.equal(f.guard(f.dispatch(p)), undefined, 'The failed role may be retried');
  assert.match(f.guard(f.dispatch(q)), /Previous batch wave/);
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: true }, { batchIndexes: [1] });
  assert.equal(f.guard(f.dispatch(q)), undefined);
});

test('recognized later-phase roles retain their complete original definitions', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-role-gate-')));
  t.after(() => { assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'ua-role-gate-'))); rmSync(root, { recursive: true }); });
  mkdirSync(join(root, 'agents')); const original = '# architecture-analyzer\nFull original instructions\nROLE END\n';
  writeFileSync(join(root, 'agents/architecture-analyzer.md'), original);
  const f = fixture(root); f.gates.remember(f.agent, f.prepared(1));
  const exec = { name: 'subagent', agent: f.agent, arguments: { name: 'architecture-analyzer', prompt: 'Summarized architecture role' } };
  assert.match(f.guard(exec), /COMPLETE original/);
  exec.arguments.prompt = original + '\nFull phase inputs'; assert.equal(f.guard(exec), undefined);
  exec.arguments.name = 'tour-builder'; assert.match(f.guard(exec), /Cannot read original/);
});

test('merge requires complete acceptance rather than a passing subset, receipts clear on unload', () => {
  const f = fixture(), p = f.prepared(1); f.gates.remember(f.agent, p);
  const exec = { name: 'bash', agent: f.agent, arguments: { command: 'python /upstream/merge-batch-graphs.py', workdir: f.cwd } };
  assert.match(f.guard(exec), /ALL expected outputs/);
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: true }, { batchIndexes: [1] });
  assert.match(f.guard(exec), /ALL expected outputs/);
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: true }, {});
  assert.equal(f.guard(exec), undefined);
  f.dispose(); assert.equal(f.guard(f.dispatch({ ...p, prompt: 'file-analyzer shortened' })), undefined);
  f.gates.remember(f.agent, p);
  f.gates.remember(f.agent, { ...p, mode: 'incremental' });
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: true, mode: 'incremental', plan: 'batches' }, {});
  assert.equal(f.guard(exec), undefined, 'Merge uses the current incremental plan, not an earlier full-run state');
  f.gates.remember(f.agent, { ...p, mode: 'incremental', plan: 'symbol-retry' });
  f.gates.review(f.agent, { stage: 'batches', projectRoot: f.cwd, valid: true, mode: 'incremental', plan: 'symbol-retry' }, { mode: 'full', plan: 'symbol-retry' });
  assert.equal(f.guard(exec), undefined, 'Original retry mode normalization is authoritative');
});
