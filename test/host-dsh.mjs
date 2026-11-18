// Installed-runtime integration only; no live agent/model or profile mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as host from '../host-v2.js';
import { runtimeAnchors } from '../runtime.js';
import { resolvePluginRoot } from '../bridge.js';
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
    console.log(JSON.stringify({inject:host.inject,skills:status.skills,activation:'PASS',statusTool:'PASS'}));
    await fiber.dispose();
    assert.equal(await ctx.skills.get('ua-understand'),undefined);
    assert.equal(ctx.tools.get('ua_status'),undefined);
  } finally { await ctx.fiber.dispose(); }
});
