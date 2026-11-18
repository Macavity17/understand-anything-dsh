import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareBatch } from '../batch.js';

// Minimal upstream fixture: a complete distinctive role and the real Phase-2
// contract shape, rather than loading a user's checkout or trial artifacts.
const role = `---\nname: file-analyzer\n---\n# Fixture canonical role\nKeep all role instructions, including this beginning.\n## Structural extraction\nUse ua-file-analyzer-input-<batchIndex>.json and ua-file-extract-results-<batchIndex>.json.\n## Last instruction\nCANONICAL_ROLE_END_DO_NOT_TRUNCATE\n`;
const skill = `# Fixture skill\nThis giant unrelated skill body must not appear in the child.\n\n> **Language directive**: Generate all textual content (summaries, descriptions, tags, titles, languageNotes, languageLesson) in **{language}**. Maintain technical accuracy while using natural, native-level phrasing in the target language. Keep technical terms in English when no standard translation exists.\n\n## Phase 2 — ANALYZE\n\n### Full analysis path\n\n> **Additional context from main session:**\n>\n> Project: \`<projectName>\` — \`<projectDescription>\`\n> Languages: \`<languages from Phase 1>\`\n>\n> $LANGUAGE_DIRECTIVE\n\nDispatch prompt template (fill in batch-specific values from batches.json[i]):\n\n> Analyze these files and produce GraphNode and GraphEdge objects.\n> Project root: \`$PROJECT_ROOT\`\n> Project: \`<projectName>\`\n> Languages: \`<languages>\`\n> Batch: \`<batchIndex>/<totalBatches>\`\n> Skill directory (for bundled scripts): \`<SKILL_DIR>\`\n> Output: write to \`$UA_DIR/intermediate/batch-<batchIndex>.json\` OR \`batch-<batchIndex>-part-<k>.json\`.\n>\n> Pre-resolved import data for this batch (use directly — do NOT re-resolve imports from source):\n> \`\`\`json\n> <batchImportData JSON from batches.json[i].batchImportData>\n> \`\`\`\n>\n> Cross-batch neighbors with their exported symbols (confidence boost for cross-batch edges):\n> \`\`\`json\n> <neighborMap JSON from batches.json[i].neighborMap>\n> \`\`\`\n>\n> Files to analyze in this batch (every entry MUST be passed through to batchFiles with all four fields — path, language, sizeLines, fileCategory):\n> 1. \`<path>\` (<sizeLines> lines, language: \`<language>\`, fileCategory: \`<fileCategory>\`)\n> 2. \`<path>\` (<sizeLines> lines, language: \`<language>\`, fileCategory: \`<fileCategory>\`)\n> ...\n\n**Output naming is per-batchIndex — no fusion.**\n\n### Incremental path\nUnrelated coordinator gates.\n\n## Phase 3 — ASSEMBLE\nDo not include this phase.\n`;

function fixture(t, { legacy = false, indexes = [1, 0] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-batch-test-')));
  // The checked absolute temp root is the only recursive cleanup target.
  t.after(() => { assert.equal(resolve(root), root); assert.match(root, /ua-batch-test-/); rmSync(root, { recursive: true }); });
  const plugin = join(root, 'upstream');
  const project = join(root, 'project with spaces');
  const ua = join(project, legacy ? '.understand-anything' : '.ua');
  mkdirSync(join(plugin, 'agents'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'understand'), { recursive: true });
  mkdirSync(join(ua, 'intermediate'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(plugin, 'agents', 'file-analyzer.md'), role);
  writeFileSync(join(plugin, 'skills', 'understand', 'SKILL.md'), skill);
  writeFileSync(join(project, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'src/b.py'), 'def b(): pass\n');
  const files = [
    { path: 'src/a.ts', language: 'typescript', sizeLines: 1, fileCategory: 'code' },
    { path: 'src/b.py', language: 'python', sizeLines: 1, fileCategory: 'code' },
  ];
  const scan = { name: 'Fixture', description: 'Stored project description', languages: ['python', 'typescript'],
    files, totalFiles: 2, importMap: { 'src/a.ts': ['src/b.py'], 'src/b.py': [] } };
  const batches = { schemaVersion: 1, totalFiles: 2, totalBatches: 2, batches: [
    { batchIndex: indexes[0], files: [files[1]], batchImportData: { 'src/b.py': [] }, neighborMap: {} },
    { batchIndex: indexes[1], files: [files[0]], batchImportData: { 'src/a.ts': ['src/b.py'] },
      neighborMap: { 'src/a.ts': [{ path: 'src/b.py', batchIndex: indexes[0], symbols: ['b'] }] } },
  ] };
  const config = { autoUpdate: true, outputLanguage: 'zh' };
  const save = () => {
    writeFileSync(join(ua, 'intermediate/batches.json'), JSON.stringify(batches));
    writeFileSync(join(ua, 'intermediate/scan-result.json'), JSON.stringify(scan));
    writeFileSync(join(ua, 'config.json'), JSON.stringify(config));
  };
  save();
  return { root, plugin, project, ua, files, scan, batches, config, save,
    prepare: index => prepareBatch(plugin, project, index) };
}

function snapshot(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path).toString('base64')]];
  });
}

test('selects exact zero-based index, preserves full role and complete inputs without any writes', t => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = f.prepare(0);
  assert.equal(result.batchIndex, 0);
  assert.equal(result.totalBatches, 2);
  assert.deepEqual(result.files, [f.files[0]]);
  assert.equal(result.cwd, f.project);
  assert.equal(result.output, join(f.ua, 'intermediate/batch-0.json'));
  assert.equal(result.outputPartPattern, join(f.ua, 'intermediate/batch-0-part-<k>.json'));
  assert.equal(result.inputPath, join(f.ua, 'tmp/ua-file-analyzer-input-0.json'));
  assert.equal(result.extractionPath, join(f.ua, 'tmp/ua-file-extract-results-0.json'));
  assert.ok(result.prompt.includes(role));
  assert.ok(result.prompt.includes(JSON.stringify(f.batches.batches[1].batchImportData, null, 2)));
  assert.ok(result.prompt.includes(JSON.stringify(f.batches.batches[1].neighborMap, null, 2)));
  assert.ok(result.prompt.includes(JSON.stringify([f.files[0]], null, 2)));
  for (const root of [f.plugin, f.project, f.ua, join(f.plugin, 'skills/understand')]) assert.ok(result.prompt.includes(root));
  assert.match(result.prompt, /Batch: `0\/2`/);
  assert.match(result.prompt, /Do not delegate or launch nested agents/);
  assert.match(result.prompt, /write\/edit/);
  assert.ok(!result.prompt.includes('giant unrelated skill'));
  assert.ok(!result.prompt.includes('Do not include this phase'));
  assert.ok(!result.prompt.includes('<path>'));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.prepare(1).files[0].path, 'src/b.py');
});

test('supports sparse original indexes without array-position lookup or off-by-one correction', t => {
  const f = fixture(t, { indexes: [93, 116] });
  assert.equal(f.prepare(93).files[0].path, 'src/b.py');
  assert.equal(f.prepare(116).output, join(f.ua, 'intermediate/batch-116.json'));
  for (const index of [0, 1, 92, 117]) assert.throws(() => f.prepare(index), /not found/);
  for (const index of [-1, 0.5, '93', NaN, Infinity]) assert.throws(() => f.prepare(index), /nonnegative safe integer/);
});

test('uses persisted output language only for text and preserves language/schema enums', t => {
  const f = fixture(t);
  for (const [code, expected] of [['zh', 'Chinese'], ['en', 'English'], ['ja', 'Japanese'], ['zh-TW', 'Chinese (Taiwan)']]) {
    f.config.outputLanguage = code; f.save();
    const result = f.prepare(0);
    assert.equal(result.outputLanguage, code);
    assert.ok(result.languageDirective.includes(`**${expected}**`));
    assert.match(result.prompt, /"language": "typescript"/);
    assert.match(result.prompt, /"fileCategory": "code"/);
  }
  delete f.config.outputLanguage; f.save();
  assert.throws(() => f.prepare(0), /outputLanguage/);
  f.config.outputLanguage = 'chinese'; f.save();
  assert.throws(() => f.prepare(0), /stored language code/);
});

test('preserves optional incremental checklists and repair payloads verbatim', t => {
  const f = fixture(t);
  const batch = f.batches.batches[1];
  batch.previousSymbols = { 'src/a.ts': [{ id: 'function:src/a.ts:a', name: 'a', type: 'function', lineRange: [1, 1] }] };
  batch.missingSymbols = [{ id: 'function:src/a.ts:a', filePath: 'src/a.ts', className: null }];
  f.save();
  const result = f.prepare(0);
  for (const key of ['previousSymbols', 'missingSymbols']) {
    assert.deepEqual(result[key], batch[key]);
    assert.ok(result.prompt.includes(JSON.stringify(batch[key], null, 2)));
  }
});

for (const field of ['path', 'language', 'sizeLines', 'fileCategory']) {
  test(`rejects missing ${field}, without repairing metadata from the scan`, t => {
    const f = fixture(t);
    f.batches.batches[1].files = [{ ...f.files[0] }];
    delete f.batches.batches[1].files[0][field]; f.save();
    assert.throws(() => f.prepare(0), new RegExp(field));
  });
}

test('rejects invalid category, line count, translated language and conflicting metadata', t => {
  const f = fixture(t);
  const original = { ...f.files[0] };
  for (const change of [{ fileCategory: 'source' }, { sizeLines: -1 }, { sizeLines: 1.2 }, { language: '类型脚本' }, { language: 'javascript' }]) {
    f.batches.batches[1].files = [{ ...original, ...change }]; f.save();
    assert.throws(() => f.prepare(0), /fileCategory|sizeLines|language|disagrees/);
  }
});

for (const filePath of ['src/nonexistent.ts', '../outside.ts', '/absolute.ts', 'C:\\outside.ts', 'src/../../outside.ts', '.']) {
  test(`rejects nonexistent, absolute or escaping file: ${filePath}`, t => {
    const f = fixture(t);
    f.files[0].path = filePath;
    f.batches.batches[1].batchImportData = { [filePath]: [] };
    f.batches.batches[1].neighborMap = {};
    f.scan.importMap[filePath] = [];
    f.save();
    assert.throws(() => f.prepare(0), /ENOENT|project-relative|escapes|name a file/);
  });
}

test('requires absolute existing project and plugin roots', t => {
  const f = fixture(t);
  for (const [plugin, project] of [['upstream', f.project], [f.plugin, 'project'], [join(f.root, 'missing'), f.project], [f.plugin, join(f.project, 'src/a.ts')]]) {
    assert.throws(() => prepareBatch(plugin, project, 0), /absolute directory|ENOENT|directory/);
  }
});

test('rejects symlink escapes for source, metadata and output ancestors', t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'escape.ts'), 'outside');
  symlinkSync(join(outside, 'escape.ts'), join(f.project, 'src/escape.ts'));
  f.files[0].path = 'src/escape.ts';
  f.scan.importMap['src/escape.ts'] = [];
  f.batches.batches[1].batchImportData = { 'src/escape.ts': [] };
  f.batches.batches[1].neighborMap = {}; f.save();
  assert.throws(() => f.prepare(0), /escapes/);
  f.files[0].path = 'src/a.ts';
  f.batches.batches[1].batchImportData = { 'src/a.ts': ['src/b.py'] }; f.save();
  symlinkSync(outside, join(f.ua, 'tmp'));
  assert.throws(() => f.prepare(0), /escapes/);
});

test('matches upstream legacy directory precedence without fallback to another inventory', t => {
  const f = fixture(t, { legacy: true });
  mkdirSync(join(f.project, '.ua'));
  assert.equal(f.prepare(0).uaDir, f.ua);
  writeFileSync(join(f.ua, 'intermediate/batches.json'), '{}');
  assert.throws(() => f.prepare(0), /schemaVersion|batches\[\]/);
});

test('rejects incomplete raw trial scan output instead of synthesizing project context', t => {
  const f = fixture(t);
  delete f.scan.name; delete f.scan.description; delete f.scan.languages; delete f.scan.importMap;
  f.scan.scriptCompleted = true; f.scan.stats = { byLanguage: { typescript: 1, python: 1 } }; f.save();
  assert.throws(() => f.prepare(0), /scan-result.name/);
});

test('rejects duplicate index, wrong totals, missing imports/neighbors and nonexistent references', t => {
  const f = fixture(t);
  const original = structuredClone(f.batches);
  const scenarios = [
    data => { data.batches[0].batchIndex = 0; },
    data => { data.totalBatches = 3; },
    data => { delete data.batches[1].batchImportData; },
    data => { delete data.batches[1].neighborMap; },
    data => { delete data.batches[1].batchImportData['src/a.ts']; },
    data => { data.batches[1].neighborMap['src/a.ts'][0].path = 'src/missing.py'; },
  ];
  for (const mutate of scenarios) {
    Object.assign(f.batches, structuredClone(original)); mutate(f.batches); f.save();
    assert.throws(() => f.prepare(0), /duplicate|totalBatches|must be objects|import metadata|ENOENT/);
  }
});

function incrementalFixture(f) {
  const plan = { action: 'PARTIAL_UPDATE', baseCommit: 'base', headCommit: 'head', filesToReanalyze: ['src/a.ts'], deletedFiles: [] };
  const baseline = { version: 1, baseCommit: 'base', headCommit: 'head', files: [{ filePath: 'src/a.ts',
    nodes: [{ id: 'class:src/a.ts:A', name: 'A', type: 'class', filePath: 'src/a.ts', lineRange: [1, 20], summary: 'DO NOT COPY OLD SEMANTICS' },
      { id: 'function:src/a.ts:A.run', name: 'run', type: 'method', filePath: 'src/a.ts', lineRange: [2, 3] }],
    edges: [{ source: 'class:src/a.ts:A', target: 'function:src/a.ts:A.run', type: 'contains' }] }] };
  writeFileSync(join(f.ua, 'intermediate/incremental-plan.json'), JSON.stringify(plan));
  writeFileSync(join(f.ua, 'intermediate/incremental-symbol-baseline.json'), JSON.stringify(baseline));
  return { plan, baseline };
}

test('ordinary incremental batches receive complete baseline symbol identities and class ownership', t => {
  const f = fixture(t);
  incrementalFixture(f);
  const before = snapshot(f.root);
  const result = prepareBatch(f.plugin, f.project, 0, 'batches', 'incremental');
  assert.equal(result.previousSymbols.length, 2);
  assert.deepEqual(result.previousSymbols[1].owners, ['A']);
  assert.deepEqual(result.previousSymbols[1].lineRange, [2, 3]);
  assert.ok(!result.prompt.includes('DO NOT COPY OLD SEMANTICS'));
  assert.deepEqual(snapshot(f.root), before);
});

test('explicit symbol-retry plan consumes the actual retry schema and rejects stale commits', t => {
  const f = fixture(t);
  incrementalFixture(f);
  const batch = structuredClone(f.batches.batches[1]);
  batch.previousSymbols = [{ id: 'class:src/a.ts:A', name: 'A', type: 'class', filePath: 'src/a.ts' }];
  batch.missingSymbols = [{ filePath: 'src/a.ts', missing: [{ id: 'class:src/a.ts:A' }] }];
  const retry = { version: 1, attempt: 1, baseCommit: 'base', headCommit: 'head', filesToReanalyze: ['src/a.ts'], batches: [batch] };
  const path = join(f.ua, 'intermediate/incremental-symbol-retry.json');
  writeFileSync(path, JSON.stringify(retry));
  const result = prepareBatch(f.plugin, f.project, 0, 'symbol-retry');
  assert.equal(result.plan, 'symbol-retry');
  assert.equal(result.totalBatches, 1);
  assert.deepEqual(result.missingSymbols, batch.missingSymbols);
  assert.equal(result.sources.batches, path);
  retry.headCommit = 'stale'; writeFileSync(path, JSON.stringify(retry));
  assert.throws(() => prepareBatch(f.plugin, f.project, 0, 'symbol-retry'), /commits do not match/);
  assert.throws(() => prepareBatch(f.plugin, f.project, 0, 'guess'), /plan must be/);
});

test('a full run ignores stale partial diagnostics, while an explicit incremental run requires them', t => {
  const f = fixture(t);
  incrementalFixture(f);
  const baseline = join(f.ua, 'intermediate/incremental-symbol-baseline.json');
  writeFileSync(baseline, '{}');
  assert.equal(f.prepare(0).mode, 'full');
  assert.throws(() => prepareBatch(f.plugin, f.project, 0, 'batches', 'incremental'), /baseline/);
});

test('filtered incremental batches preserve full scan totals and unchanged neighbor indexes', t => {
  const f = fixture(t); incrementalFixture(f);
  f.batches.batches = [f.batches.batches[1]];
  f.batches.totalBatches = 1;
  f.save();
  const result = prepareBatch(f.plugin, f.project, 0, 'batches', 'incremental');
  assert.equal(result.totalFiles, 2); assert.equal(result.files.length, 1);
  assert.equal(result.neighborMap['src/a.ts'][0].batchIndex, 1);
});

test('fails on missing upstream role, malformed JSON or incompatible skill contract', t => {
  const f = fixture(t);
  writeFileSync(join(f.ua, 'config.json'), '{');
  assert.throws(() => f.prepare(0), /cannot read JSON/);
  f.save();
  writeFileSync(join(f.plugin, 'skills/understand/SKILL.md'), '# Wrong skill');
  assert.throws(() => f.prepare(0), /Phase 2/);
});
