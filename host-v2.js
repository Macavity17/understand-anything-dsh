import { hostModule } from './runtime.js';
import { resolvePluginRoot, installHooks, graphState, gitHead } from './bridge.js';
import { registerSkills } from './skills.js';

// These are the actual service keys in DSH 0.2.2-rc.3.
export const inject = ['agents', 'tools', 'workingDirectory', 'skills'];
const { default: z } = await hostModule('@deepseek-ai/schemastery');
export const Config = z.object({
  upstreamRoot: z.string().description('Absolute path to the Understand-Anything 2.9.8 understand-anything-plugin directory; omitted uses the prepared default installation.'),
});

export async function apply(ctx, config = {}) {
  const [{ FileSystemSkillProvider }, { createUserMessage }] = await Promise.all([
    hostModule('@deepseek-ai/dsh-skill-filesystem'), hostModule('@deepseek-ai/dsh-llm'),
  ]);
  return applyWithRuntime(ctx, config, { FileSystemSkillProvider, createUserMessage });
}

export async function applyWithRuntime(ctx, config, runtime) {
  const root = resolvePluginRoot(config.upstreamRoot);
  const disposeSkills = await registerSkills(ctx, root, runtime.FileSystemSkillProvider);
  ctx.effect(function* () { yield disposeSkills; }, 'Understand-Anything skills');
  const hookDiagnostics = installHooks(ctx, root, runtime.createUserMessage);
  ctx.tools.register({
    name: 'ua_status',
    description: 'Inspect the Understand-Anything DSH adapter, skill discovery and graph metadata without running analysis.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : process.cwd();
      const snapshot = await ctx.skills.snapshot({ cwd, scope: exec.agent, signal: exec.signal });
      const aliases = snapshot.skills.filter(skill => skill.name.startsWith('ua-understand'));
      const graph = graphState(cwd);
      return JSON.stringify({ adapter: 'understand-anything-dsh', upstreamRoot: root, upstreamVersion: '2.9.8',
        catalogComplete: snapshot.complete, skills: aliases.map(s => s.name), cwd, graph,
        head: gitHead(cwd), hooks: 'next-step notices only; no hidden analysis', hookDiagnostics,
        analysisCompleted: false, note: 'Adapter status does not certify a project analysis.' }, null, 2);
    },
  });
}
