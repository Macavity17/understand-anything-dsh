// Installed-runtime integration only; no live agent/model or profile mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as host from '../host-v2.js';
import { runtimeAnchors } from '../runtime.js';
import { resolvePluginRoot } from '../bridge.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadSchemas } from '../validation.js';
test('Host activates with actual service keys; skill/status registrations unwind', {
  skip: !process.versions.electron ? 'Use the installed DSH Electron runtime' : false,
}, async () => {
  const req = createRequire(runtimeAnchors()[0]);
  const { Context } = await import(req.resolve('@deepseek-ai/cordis'));
  const { default: SkillRegistry } = await import(req.resolve('@deepseek-ai/dsh-skill'));
  const { ToolsService } = await import(req.resolve('@deepseek-ai/dsh-tools'));
  const ctx = new Context();
  ctx.provide('systemPrompt',{tools() { return () => {}; }});
  ctx.provide('agents',{list:()=>[]});
  ctx.provide('workingDirectory',{get:s=>s.cwd});
  try {
    const sf=ctx.plugin(SkillRegistry); if(sf.inertia)await sf.inertia;
    const tf=ctx.plugin(ToolsService); if(tf.inertia)await tf.inertia;
    const root = process.env.UA_PLUGIN_ROOT ?? resolvePluginRoot();
    const fiber=ctx.plugin(host,{upstreamRoot:root}); if(fiber.inertia)await fiber.inertia;
    const catalog=await ctx.skills.snapshot();
    assert.equal(catalog.skills.filter(s=>s.name.startsWith('ua-understand')).length,9);
    const skill=await ctx.skills.get('ua-understand'); assert.match(skill.content,/DeepSeek Harness execution adapter/);
    assert.match(skill.content,/## Phase 5 — TOUR/);
    const tool=ctx.tools.get('ua_status'); assert.ok(tool,'real tool registry accepts output schema');
    const status=JSON.parse(await tool.execute({}, {signal:new AbortController().signal}));
    assert.equal(status.upstreamVersion,'2.9.8');assert.equal(status.catalogComplete,true);assert.equal(status.skills.length,9);
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'ua-host-contract-')));
    try {
      const ua = join(project, '.ua'); mkdirSync(join(ua, 'intermediate'), { recursive: true });
      const put = (path, value) => writeFileSync(join(ua, path), JSON.stringify(value));
      writeFileSync(join(project, 'a.py'), 'print("hello")\n');
      const file = { path: 'a.py', language: 'python', sizeLines: 1, fileCategory: 'code' };
      put('config.json', { outputLanguage: 'zh' });
      put('intermediate/scan-result.json', { name: 'Fixture', description: 'Contract fixture', languages: ['python'], frameworks: [], totalFiles: 1, files: [file], importMap: { 'a.py': [] } });
      put('intermediate/batches.json', { schemaVersion: 1, totalFiles: 1, totalBatches: 1, batches: [{ batchIndex: 1, files: [file], batchImportData: { 'a.py': [] }, neighborMap: {} }] });
      const prepared = JSON.parse(await ctx.tools.get('ua_prepare_batch').execute({ projectRoot: project, batchIndex: 1 }, { signal: new AbortController().signal }));
      assert.ok(prepared.prompt.includes('fileCategory'));
      assert.equal(prepared.cwd, project);
      const node = { id: 'file:a.py', type: 'file', name: 'a.py', filePath: 'a.py', summary: 'Prints a greeting', tags: ['code'], complexity: 'simple' };
      const graph = { version: '1.0.0', project: { name: 'Fixture', languages: ['python'], frameworks: [], description: 'Contract fixture', analyzedAt: '2026-11-18T00:00:00Z', gitCommitHash: 'abc' }, nodes: [node], edges: [], layers: [{ id: 'main', name: 'Main', description: 'Main', nodeIds: [node.id] }], tour: [{ order: 1, title: 'Start', description: 'Print a greeting', nodeIds: [node.id] }] };
      put('knowledge-graph.json', graph); put('meta.json', { gitCommitHash: 'abc', analyzedFiles: 1 }); put('fingerprints.json', { version: '1.0.0', generatedAt: '2026-11-18T00:00:00Z', gitCommitHash: 'abc', files: { 'a.py': { filePath: 'a.py', contentHash: 'a'.repeat(64), totalLines: 1, hasStructuralAnalysis: false, functions: [], classes: [], imports: [], exports: [] } } });
      const validate = ctx.tools.get('ua_validate'); assert.ok(validate, 'real registry accepts the validation tool');
      assert.equal(JSON.parse(await validate.execute({ projectRoot: project, stage: 'published' }, {})).valid, true);
      // Permissive upstream validateGraph would fill defaults/drop records. Our gate must not.
      const upstream = await loadSchemas(root);
      assert.equal(upstream.KnowledgeGraphSchema.safeParse(graph).success, true);
      delete graph.nodes[0].name; delete graph.layers; delete graph.tour;
      put('knowledge-graph.json', graph);
      const refused = JSON.parse(await validate.execute({ projectRoot: project, stage: 'published' }, {}));
      assert.equal(refused.valid, false);
      assert.ok(refused.issues.some(i => i.path.endsWith('.name')));
      assert.ok(refused.issues.some(i => i.path.endsWith('.layers')));
    } finally { assert.ok(project.startsWith(join(realpathSync(tmpdir()), 'ua-host-contract-'))); rmSync(project, { recursive: true, force: true }); }
    console.log(JSON.stringify({inject:host.inject,skills:status.skills,activation:'PASS',statusTool:'PASS',batchTool:'PASS',validationTool:'PASS'}));
    await fiber.dispose();
    assert.equal(await ctx.skills.get('ua-understand'),undefined);
    assert.equal(ctx.tools.get('ua_status'),undefined);
    assert.equal(ctx.tools.get('ua_prepare_batch'),undefined);
    assert.equal(ctx.tools.get('ua_validate'),undefined);
  } finally { await ctx.fiber.dispose(); }
});
