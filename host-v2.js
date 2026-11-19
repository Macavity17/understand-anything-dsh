import { hostModule } from './runtime.js';
import { resolvePluginRoot, installHooks, graphState, gitHead } from './bridge.js';
import { registerSkills } from './skills.js';
import { prepareBatch } from './batch.js';
import { validateArtifacts } from './validation.js';
import { prepareDashboard } from './dashboard.js';
import { installExecutionGates } from './execution-gates.js';
import { preparePhase } from './phase.js';
import { readFileSync } from 'node:fs';

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
  const gates = installExecutionGates(ctx, root);
  ctx.tools.register({
    name: 'ua_prepare_dashboard',
    description: 'Verify the local DeepSeek-themed dashboard and return its exact managed bash launch command. Read-only: no downloads, writes or server start. Theme mismatch and missing local Vite fail.',
    parameters: { type: 'object', properties: { projectRoot: { type: 'string', description: 'Absolute project directory containing .ua or legacy graph data.' } }, required: ['projectRoot'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prepared = await prepareDashboard(root, args.projectRoot);
      const denial = gates.launchDenial(exec?.agent, prepared.projectRoot);
      if (denial) throw new Error(denial);
      return JSON.stringify(prepared, null, 2);
    },
  });
  ctx.tools.register({
    name: 'ua_prepare_phase',
    description: 'Prepare an untouched upstream semantic-role prompt with authoritative phase inputs. Read-only: no dispatch, synthesis or file writes. Use returned prompt and cwd intact; read full spill output if truncated.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string', description: 'Absolute codebase project directory.' },
      role: { type: 'string', enum: ['assemble-reviewer', 'architecture-analyzer', 'tour-builder', 'code-lesson-writer'] },
      mode: { type: 'string', enum: ['full', 'incremental'] },
      mergeReport: { type: 'string', description: 'Complete original merger stderr, required for assemble-reviewer.' },
      detailedFiles: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, uniqueItems: true, description: 'Exact tour-covered lesson chunk paths; preparation reports available chunks when selection is absent.' },
    }, required: ['projectRoot', 'role'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => {
      const p = JSON.parse(value);
      const metadata = { role: p.role, mode: p.mode, cwd: p.cwd, output: p.output, sources: p.sources, lessonBatches: p.lessonBatches, allowedWriteTargets: p.allowedWriteTargets };
      return [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'text', text: p.prompt },
        { type: 'text', text: '# Root-owned original phase instructions (normalization/publication remain with the coordinator)\n\n' + p.phaseInstructions }];
    } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const p = await preparePhase(root, args.projectRoot, args.role, args);
      gates.rememberPhase(exec?.agent, p);
      return JSON.stringify(p, null, 2);
    },
  });
  ctx.tools.register({
    name: 'ua_prepare_batch',
    description: 'Read the authoritative scan/batch plan and complete upstream file-analyzer role to construct an exact DSH child prompt. No writes or agent dispatch. Use the returned prompt intact.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string', description: 'Absolute project directory, not the plugin directory.' },
      batchIndex: { type: 'integer', minimum: 0, description: 'Exact batchIndex stored in the plan, not an array position.' },
      plan: { type: 'string', enum: ['batches', 'symbol-retry'], description: 'Normal batching plan or the original prepared symbol repair plan.' },
      mode: { type: 'string', enum: ['full', 'incremental'], description: 'Explicit invocation mode, defaults to full. Incremental loads the current commit-bound symbol baseline; stale diagnostics do not redefine full runs.' },
    }, required: ['projectRoot', 'batchIndex'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => {
      const prepared = JSON.parse(value);
      return [{ type: 'text', text: JSON.stringify({ batchIndex: prepared.batchIndex, cwd: prepared.cwd, output: prepared.output, sources: prepared.sources }) },
        { type: 'text', text: prepared.prompt }];
    } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prepared = await prepareBatch(root, args.projectRoot, args.batchIndex, args.plan, args.mode);
      gates.remember(exec?.agent, prepared);
      return JSON.stringify(prepared, null, 2);
    },
  });
  ctx.tools.register({
    name: 'ua_validate',
    description: 'Read-only codebase acceptance checks: strict upstream schema, batch ownership/coverage, graph references and publication baseline checks. Does not fix, publish, launch Dashboard or certify semantic analysis.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string', description: 'Absolute project directory.' },
      stage: { type: 'string', enum: ['batches', 'candidate', 'published'] },
      plan: { type: 'string', enum: ['batches', 'symbol-retry'] },
      mode: { type: 'string', enum: ['full', 'incremental'] },
      batchIndexes: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, uniqueItems: true, description: 'For batches only: validate a completed wave before dispatching the next. Omit before final merge to check all batches.' },
    }, required: ['projectRoot', 'stage'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.batchIndexes !== undefined && args.stage !== 'batches') throw new TypeError('batchIndexes is only valid at the batches stage');
      const report = await validateArtifacts(root, args.projectRoot, args.stage, undefined, args.batchIndexes, args.plan, args.mode);
      gates.review(exec?.agent, report, args);
      if (args.stage !== 'batches') {
        let graph;
        try { graph = JSON.parse(readFileSync(join(report.uaDir, args.stage === 'published' ? 'knowledge-graph.json' : 'intermediate/assembled-graph.json'), 'utf8')); } catch {}
        const phaseIssues = gates.completionIssues(exec?.agent, report.projectRoot, graph);
        report.phaseEvidence = { checked: gates.hasActiveFull(exec?.agent, report.projectRoot), scope: 'active full run in this plugin activation', admittedRequestsOnly: true, semanticQualityCertified: false, issues: phaseIssues };
        report.structuralValid = report.valid;
        report.valid = report.valid && phaseIssues.length === 0;
        report.issueCount += phaseIssues.length;
        report.issues.push(...phaseIssues.slice(0, Math.max(0, 50 - report.issues.length)));
        report.issuesTruncated = report.issueCount > report.issues.length;
        gates.publication(exec?.agent, report);
      }
      return JSON.stringify(report, null, 2);
    },
  });
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
        head: gitHead(cwd), hooks: 'next-step notices only; no hidden analysis', hookDiagnostics, executionGates: gates.stats,
        analysisCompleted: false, note: 'Adapter status does not certify a project analysis.' }, null, 2);
    },
  });
}
