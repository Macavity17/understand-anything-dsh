import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateArtifacts, dataDirectory } from '../validation.js';

// Unit tests exercise acceptance logic independently of an installed upstream.
// The installed-runtime test feeds the same fixtures to the real Zod schemas.
const schema = validate => ({ safeParse(value) {
  const errors = validate(value);
  return errors.length ? { success: false, error: { issues: errors.map(message => ({ path: [], message })) } } : { success: true, data: value };
} });
const schemas = {
  GraphNodeSchema: schema(n => n && ['id', 'type', 'name', 'summary', 'complexity'].every(k => typeof n[k] === 'string') && Array.isArray(n.tags) ? [] : ['Missing canonical node fields']),
  GraphEdgeSchema: schema(e => e && typeof e.source === 'string' && typeof e.target === 'string' && typeof e.weight === 'number' && e.direction === 'forward' ? [] : ['Invalid edge']),
  KnowledgeGraphSchema: schema(g => g?.project && Array.isArray(g.layers) && Array.isArray(g.tour) ? [] : ['Missing graph collections/project']),
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ua-validation-'));
  t.after(() => { assert.equal(resolve(root), root); rmSync(root, { recursive: true, force: true }); });
  const dir = join(root, '.ua'); mkdirSync(join(dir, 'intermediate'), { recursive: true });
  const put = (path, data) => writeFileSync(join(dir, path), JSON.stringify(data));
  const file = path => ({ path, language: 'python', sizeLines: 2, fileCategory: 'code' });
  const files = [file('a.py'), file('b.py')];
  const scan = { name: 'Fixture', description: 'Small test project', languages: ['python'], frameworks: [], files, importMap: { 'a.py': ['b.py'], 'b.py': [] } };
  put('intermediate/scan-result.json', scan);
  const node = path => ({ id: `file:${path}`, type: 'file', filePath: path, name: path, summary: 'A meaningful description', complexity: 'simple', tags: ['code'] });
  const edge = { source: 'file:a.py', target: 'file:b.py', type: 'imports', direction: 'forward', weight: 0.7 };
  const graph = { version: '1.0.0', project: { name: 'Fixture', description: 'Small test project', languages: ['python'], frameworks: [], analyzedAt: '2026-11-18T00:00:00Z', gitCommitHash: 'abcdef' }, nodes: files.map(f => node(f.path)), edges: [edge], layers: [{ id: 'main', name: 'Main', description: 'Main layer', nodeIds: ['file:a.py', 'file:b.py'] }], tour: [{ order: 1, title: 'Start', description: 'Read this', nodeIds: ['file:a.py'] }] };
  const plan = { totalBatches: 2, batches: files.map((f, i) => ({ batchIndex: i, files: [f], batchImportData: { [f.path]: scan.importMap[f.path] }, neighborMap: {} })) };
  put('intermediate/batches.json', plan);
  for (let i = 0; i < 2; i++) put(`intermediate/batch-${i}.json`, { nodes: [node(files[i].path)], edges: i ? [] : [edge] });
  put('knowledge-graph.json', graph);
  put('intermediate/assembled-graph.json', graph);
  put('meta.json', { gitCommitHash: 'abcdef', analyzedFiles: 2 });
  const fingerprint = path => ({ filePath: path, contentHash: 'a'.repeat(64), functions: [], classes: [], imports: [], exports: [], totalLines: 2, hasStructuralAnalysis: false });
  put('fingerprints.json', { version: '1.0.0', generatedAt: '2026-11-18T00:00:00Z', gitCommitHash: 'abcdef', files: { 'a.py': fingerprint('a.py'), 'b.py': fingerprint('b.py') } });
  const run = (stage = 'published', indexes) => validateArtifacts('/tmp/upstream', root, stage, schemas, indexes);
  return { root, dir, put, run, graph, scan, plan, node };
}

test('accepts valid batches with cross-batch edges and complete published baseline without mutation', async t => {
  const f = fixture(t); const before = readFileSync(join(f.dir, 'knowledge-graph.json'));
  for (const stage of ['batches', 'candidate', 'published']) {
    const result = await f.run(stage); assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.analysisCompleted, false, 'Structural acceptance is not semantic certification');
  }
  assert.deepEqual(readFileSync(join(f.dir, 'knowledge-graph.json')), before);
});

test('rejects the real trial directory/count tour and template/pseudo-file repairs without altering data', async t => {
  const f = fixture(t);
  f.graph.nodes[0].summary = 'Module: a.py';
  f.graph.nodes.push({ ...f.node('a.py'), id: 'file:a.py:Agent.method' });
  f.graph.nodes.push({ ...f.node('b.py'), id: 'document:b.py', type: 'document' });
  f.graph.tour[0] = { order: 1.5, title: 'src', description: 'Overview of src — 77 files', nodeIds: Array(10).fill('file:a.py') };
  f.put('knowledge-graph.json', f.graph); const before = readFileSync(join(f.dir, 'knowledge-graph.json'));
  const result = await f.run(); assert.equal(result.valid, false);
  for (const marker of ['Template-only', 'Whole-file', 'Duplicate whole-file', '1–5', 'sequential integer', 'Directory/count fallback']) assert.ok(result.issues.some(i => i.message.includes(marker)), marker);
  assert.deepEqual(readFileSync(join(f.dir, 'knowledge-graph.json')), before);
  assert.equal(result.analysisCompleted, false);
});

test('rejects the trial raw scanner handoff rather than silently using empty dependencies', async t => {
  const f = fixture(t); f.put('intermediate/scan-result.json', { files: f.scan.files, stats: {} });
  const result = await f.run('batches'); assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.path === 'scan.importMap'));
});

test('rejects extraction-only nodes and ad-hoc graph missing architecture/tour and baseline', async t => {
  const f = fixture(t); f.put('knowledge-graph.json', { nodes: [{ id: 'a.py', type: 'file', filePath: 'a.py' }], edges: [] });
  const result = await f.run(); assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.path.endsWith('.nodes.0')));
  assert.ok(result.issues.some(i => i.path === 'baseline.gitCommitHash'));
  assert.ok(result.issues.some(i => i.path.endsWith('.layers')));
});

test('rejects wrong-batch ownership even if every expected file is present', async t => {
  const f = fixture(t); f.put('intermediate/batch-0.json', { nodes: [f.node('a.py'), f.node('b.py')], edges: [] });
  const result = await f.run('batches'); assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => /another batch/.test(i.message)));
});

test('first-wave validation does not demand unfinished batches; unknown indexes fail', async t => {
  const f = fixture(t); f.put('intermediate/batch-1.json', {});
  assert.equal((await f.run('batches', [0])).valid, true);
  assert.equal((await f.run('batches')).valid, false);
  assert.equal((await f.run('batches', [99])).valid, false);
  await assert.rejects(f.run('batches', [0, 0]), /unique/);
});

test('rejects missing batch files and stale single-plus-split shards', async t => {
  const f = fixture(t); f.put('intermediate/batch-0-part-1.json', { nodes: [f.node('a.py')], edges: [] });
  const result = await f.run('batches'); assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => /Both single and split/.test(i.message)));
  f.plan.batches.push({ batchIndex: 8, files: [f.scan.files[0]] }); f.put('intermediate/batches.json', f.plan);
  assert.ok((await f.run('batches')).issues.some(i => /Missing output/.test(i.message)));
});

test('rejects dangling edges and layer/tour references, duplicate IDs and missing coverage', async t => {
  const f = fixture(t); f.graph.edges[0].target = 'file:missing.py'; f.graph.layers[0].nodeIds.push('missing'); f.graph.tour[0].nodeIds.push('missing'); f.graph.nodes = [f.node('a.py'), f.node('a.py')];
  f.put('knowledge-graph.json', f.graph);
  const result = await f.run(); assert.equal(result.valid, false);
  for (const expected of ['Dangling', 'Unknown node', 'Duplicate', 'Missing graph coverage']) assert.ok(result.issues.some(i => i.message.includes(expected)), expected);
});

test('requires a complete same-commit fingerprints baseline and analyzed file count', async t => {
  const f = fixture(t); f.put('meta.json', { gitCommitHash: 'different', analyzedFiles: 1798 }); f.put('fingerprints.json', { gitCommitHash: 'abcdef', files: { 'a.py': {} } });
  const result = await f.run(); assert.equal(result.valid, false);
  for (const path of ['baseline.gitCommitHash', 'meta.analyzedFiles', 'fingerprints.files']) assert.ok(result.issues.some(i => i.path === path));
});

test('reports malformed/missing inputs and caps issue samples without hiding total', async t => {
  const f = fixture(t); writeFileSync(join(f.dir, 'knowledge-graph.json'), '{');
  assert.equal((await f.run()).valid, false);
  f.graph.nodes = Array.from({ length: 100 }, () => ({})); f.put('knowledge-graph.json', f.graph);
  const result = await f.run(); assert.ok(result.issueCount > 50); assert.equal(result.issues.length, 50); assert.equal(result.issuesTruncated, true);
});

test('rejects missing imports and dangling local symbol endpoints before merge can erase them', async t => {
  const f = fixture(t);
  f.put('intermediate/batch-0.json', { nodes: [f.node('a.py')], edges: [{ source: 'function:a.py:missing', target: 'file:b.py', type: 'calls', direction: 'forward', weight: 0.8 }] });
  const result = await f.run('batches', [0]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => /1:1/.test(i.message)));
  assert.ok(result.issues.some(i => /Unresolved local/.test(i.message)));
});

test('rejects foreign numeric outputs and invalid or duplicate split parts', async t => {
  const f = fixture(t);
  f.put('intermediate/batch-93.json', { nodes: [f.node('a.py')], edges: [] });
  assert.ok((await f.run('batches')).issues.some(i => /stale\/foreign/.test(i.message)));
  const single = join(f.dir, 'intermediate/batch-0.json'); assert.equal(resolve(single), single); unlinkSync(single);
  f.put('intermediate/batch-0-part-1.json', { nodes: [f.node('a.py')], edges: [] });
  f.put('intermediate/batch-0-part-3.json', { nodes: [f.node('a.py')], edges: [] });
  const result = await f.run('batches', [0]);
  assert.ok(result.issues.some(i => /contiguous/.test(i.message)));
  assert.ok(result.issues.some(i => /Duplicate node ID across parts/.test(i.message)));
});

function removeFixtureOutputs(f) {
  for (const name of ['batch-0.json', 'batch-1.json']) {
    const path = join(f.dir, 'intermediate', name); assert.equal(resolve(path), path); assert.ok(path.startsWith(f.dir + '/intermediate/')); unlinkSync(path);
  }
}

test('deletion-only incremental batches accept the authorized retained graph without fresh dispatch', async t => {
  const f = fixture(t); removeFixtureOutputs(f);
  f.put('intermediate/incremental-plan.json', { action: 'PARTIAL_UPDATE', baseCommit: 'base', headCommit: 'head', filesToReanalyze: [] });
  f.put('intermediate/batches.json', { schemaVersion: 1, totalFiles: 2, totalBatches: 0, batches: [] });
  f.put('intermediate/batch-existing.json', f.graph);
  const result = await validateArtifacts('/tmp/upstream', f.root, 'batches', schemas, undefined, 'batches', 'incremental');
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal((await f.run('batches')).valid, false, 'Full analysis cannot silently reuse incremental outputs');
});

test('repair validation uses retry ownership and the original retained batch-0, not the abandoned plan', async t => {
  const f = fixture(t); removeFixtureOutputs(f);
  f.put('intermediate/incremental-plan.json', { action: 'PARTIAL_UPDATE', baseCommit: 'base', headCommit: 'head', filesToReanalyze: ['a.py'] });
  f.put('intermediate/incremental-symbol-retry.json', { version: 1, attempt: 1, baseCommit: 'base', headCommit: 'head', batches: [{ batchIndex: 2, files: [f.scan.files[0]], batchImportData: { 'a.py': ['b.py'] }, neighborMap: {} }] });
  f.put('intermediate/batch-0.json', { nodes: [f.node('b.py')], edges: [] });
  f.put('intermediate/batch-2.json', { nodes: [f.node('a.py')], edges: [f.graph.edges[0]] });
  const result = await validateArtifacts('/tmp/upstream', f.root, 'batches', schemas, undefined, 'symbol-retry');
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('non-code cross-batch relations use inventory, not neighbor metadata as an ACL', async t => {
  const f = fixture(t);
  const doc = { path: 'README.md', language: 'markdown', sizeLines: 3, fileCategory: 'docs' };
  f.scan.files.push(doc); f.put('intermediate/scan-result.json', f.scan);
  f.plan.batches.push({ batchIndex: 2, files: [doc], batchImportData: { 'README.md': [] }, neighborMap: {} }); f.put('intermediate/batches.json', f.plan);
  const node = { ...f.node('README.md'), id: 'document:README.md', type: 'document' };
  f.put('intermediate/batch-2.json', { nodes: [node], edges: [{ source: node.id, target: 'file:a.py', type: 'documents', direction: 'forward', weight: 0.5 }] });
  assert.equal((await f.run('batches', [2])).valid, true);
  assert.equal((await f.run('batches')).valid, true);
});

test('incremental retained edge identities defer to original reconciliation, but final dangling edges fail', async t => {
  const f = fixture(t); removeFixtureOutputs(f);
  f.put('intermediate/incremental-plan.json', { action: 'PARTIAL_UPDATE', baseCommit: 'base', headCommit: 'head', filesToReanalyze: [] });
  f.put('intermediate/batches.json', { batches: [] });
  const pending = structuredClone(f.graph); pending.edges[0].target = 'function:b.py:old-identity';
  f.put('intermediate/batch-existing.json', pending);
  assert.equal((await validateArtifacts('/tmp/upstream', f.root, 'batches', schemas, undefined, 'batches', 'incremental')).valid, true);
  f.put('intermediate/assembled-graph.json', pending);
  assert.equal((await f.run('candidate')).valid, false);
});

test('validates absolute roots and legacy data-directory precedence', async t => {
  const f = fixture(t); assert.throws(() => dataDirectory('relative'), /absolute/);
  mkdirSync(join(f.root, '.understand-anything'));
  assert.equal(dataDirectory(f.root), join(f.root, '.understand-anything'));
  await assert.rejects(f.run('unknown'), /stage/);
});
