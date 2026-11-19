import { realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve, join } from 'node:path';
import { isUnthemedViewerCommand } from './dashboard.js';
import { dataDirectory } from './validation.js';
import { normalizeLayers } from './phase.js';

/** Two narrow pre-execution gates, not a general autonomous pipeline controller. */
export function installExecutionGates(ctx, pluginRoot) {
  let receipts = new WeakMap();
  let states = new WeakMap();
  let activeRuns = new WeakMap();
  const stats = { shortenedPromptsRejected: 0, unthemedViewersRejected: 0, failedWaveDispatchesRejected: 0, prematureMergesRejected: 0 };
  const stateKey = data => `${data.projectRoot}\0${data.plan ?? 'batches'}\0${data.mode ?? 'full'}`;
  const stateFor = (agent, data) => {
    const projects = states.get(agent) ?? new Map();
    const key = stateKey(data);
    if (!projects.has(key)) projects.set(key, { cwd: data.projectRoot, failed: new Set(), mergeReady: false, phaseAttempts: new Set(), phasePrompts: new Map(), phaseInputHashes: new Map() });
    if (projects.size > 128) projects.delete(projects.keys().next().value);
    states.set(agent, projects);
    return projects.get(key);
  };
  const review = (agent, report, args) => {
    if (!agent || report.stage !== 'batches') return;
    const context = { projectRoot: report.projectRoot, plan: report.plan ?? args.plan ?? 'batches', mode: report.mode ?? args.mode ?? 'full' };
    const state = stateFor(agent, context);
    if (!report.valid) {
      state.mergeReady = false;
      const selected = args.batchIndexes ?? (receipts.get(agent) ?? []).filter(e => e.cwd === report.projectRoot && e.plan === context.plan && e.mode === context.mode).map(e => e.batchIndex);
      for (const index of selected) state.failed.add(index);
    } else if (args.batchIndexes) {
      for (const index of args.batchIndexes) state.failed.delete(index);
    } else { state.failed.clear(); state.mergeReady = true; }
  };
  const remember = (agent, prepared) => {
    if (!agent) return;
    let entries = receipts.get(agent) ?? [];
    const key = `${prepared.projectRoot}\0${prepared.plan}\0${prepared.mode}\0${prepared.batchIndex}`;
    const state = stateFor(agent, prepared);
    const runs = activeRuns.get(agent) ?? new Map();
    runs.set(prepared.cwd, { mode: prepared.mode, plan: prepared.plan });
    activeRuns.set(agent, runs);
    const hash = createHash('sha256');
    for (const source of ['scan', 'batches', 'config']) {
      hash.update(source + '\0');
      try { hash.update(readFileSync(prepared.sources?.[source])); } catch { hash.update('absent'); }
    }
    const runIdentity = hash.digest('hex');
    if (state.mergeReady || state.runIdentity && state.runIdentity !== runIdentity) {
      state.phaseAttempts.clear(); state.phasePrompts.clear(); state.phaseInputHashes.clear(); state.publishedIdentity = undefined; state.failed.clear();
      entries = entries.filter(e => e.cwd !== prepared.cwd || e.mode !== prepared.mode || e.plan !== prepared.plan);
    }
    state.runIdentity = runIdentity;
    const previous = entries.findIndex(e => e.key === key);
    if (previous >= 0) entries.splice(previous, 1);
    state.mergeReady = false;
    entries.push({ key, prompt: prepared.prompt, cwd: prepared.cwd, batchIndex: prepared.batchIndex, plan: prepared.plan, mode: prepared.mode });
    if (entries.length > 128) entries.shift();
    receipts.set(agent, entries);
  };
  const activeFull = (agent, projectRoot) => agent && activeRuns.get(agent)?.get(projectRoot)?.mode === 'full'
    && (receipts.get(agent) ?? []).some(e => e.cwd === projectRoot && e.mode === 'full')
    ? states.get(agent)?.get(stateKey({ projectRoot, mode: 'full' })) : undefined;
  const rememberPhase = (agent, prepared) => {
    if (!agent) return;
    const state = stateFor(agent, prepared);
    const hash = createHash('sha256');
    for (const [key, path] of Object.entries(prepared.sources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof path !== 'string') continue;
      hash.update(key + '\0'); try { hash.update(readFileSync(path)); } catch { hash.update('absent'); }
    }
    if (prepared.inputs?.mergeReport) hash.update(prepared.inputs.mergeReport);
    const inputHash = hash.digest('hex');
    if (state.phaseInputHashes.has(prepared.role) && state.phaseInputHashes.get(prepared.role) !== inputHash) {
      state.phasePrompts.delete(prepared.role); state.phaseAttempts.delete(prepared.role); state.publishedIdentity = undefined;
    }
    state.phaseInputHashes.set(prepared.role, inputHash);
    const prompts = state.phasePrompts.get(prepared.role) ?? [];
    if (!prompts.includes(prepared.prompt)) prompts.push(prepared.prompt);
    state.phasePrompts.set(prepared.role, prompts.slice(-128));
  };
  const completionIssues = (agent, projectRoot, graph) => {
    const state = activeFull(agent, projectRoot);
    if (!state) return [];
    const issues = [];
    const ua = dataDirectory(projectRoot);
    for (const role of ['assemble-reviewer', 'architecture-analyzer', 'tour-builder', 'code-lesson-writer']) {
      if (!state.phaseAttempts.has(role)) issues.push({ path: `phases.${role}`, message: `No complete-role ${role} dispatch request in this active full run. Directory scripts are not phase completion; use ua_prepare_phase.` });
    }
    for (const name of ['assemble-review.json', 'layers.json', 'tour.json', 'tour.normalized.json']) {
      try {
        const artifact = JSON.parse(readFileSync(join(ua, 'intermediate', name), 'utf8'));
        if (name === 'assemble-review.json' && (typeof artifact.fixedSectionOk !== 'boolean' || !Array.isArray(artifact.notes) || ['nodesRecovered', 'edgesRestored', 'crossBatchEdgesAdded', 'typesRemapped', 'complexityRemapped'].some(k => !Number.isInteger(artifact[k]) || artifact[k] < 0))) issues.push({ path: `phases.${name}`, message: 'Expected complete original assemble-review report, not an empty placeholder.' });
        if (name === 'layers.json') {
          const { layers } = normalizeLayers(artifact, new Set(graph?.nodes?.map(n => n.id) ?? []));
          const project = layers => layers?.map(({ id, name, description, nodeIds }) => ({ id, name, description, nodeIds }));
          if (!isDeepStrictEqual(project(layers), project(graph?.layers))) issues.push({ path: `phases.${name}`, message: 'Final architecture must come from the original normalized architecture output.' });
        }
        if (name === 'tour.normalized.json' && !isDeepStrictEqual(artifact, graph?.tour)) issues.push({ path: `phases.${name}`, message: 'Final graph tour must be the exact original normalized tour, not a directory/count fallback.' });
      } catch { issues.push({ path: `phases.${name}`, message: 'Missing or malformed current phase output; artifacts in trash do not count.' }); }
    }
    return issues;
  };
  const publicationIdentity = projectRoot => {
    const ua = dataDirectory(projectRoot);
    const hash = createHash('sha256');
    for (const name of ['knowledge-graph.json', 'meta.json', 'fingerprints.json', 'code-lessons.json']) {
      hash.update(name + '\0');
      try { hash.update(readFileSync(join(ua, name))); } catch (e) { if (name !== 'code-lessons.json' || e.code !== 'ENOENT') return undefined; hash.update('absent'); }
    }
    return hash.digest('hex');
  };
  const publication = (agent, report) => {
    const state = activeFull(agent, report.projectRoot);
    if (state && report.stage === 'published') state.publishedIdentity = report.valid ? publicationIdentity(report.projectRoot) : undefined;
  };
  const launchDenial = (agent, projectRoot) => {
    const state = activeFull(agent, projectRoot);
    return state && (!state.publishedIdentity || state.publishedIdentity !== publicationIdentity(projectRoot))
      ? 'This active full run requires a passing published acceptance for the EXACT current graph/meta/fingerprints/lessons before Dashboard launch. A prior invalid/stale check or schema-only repair is not completion.' : undefined;
  };
  // Installed ToolsService.guard returns a normal pre-dispatch denial; it does
  // not throw from an event listener or abort session admission.
  ctx.tools.guard(exec => {
    if (exec.name === 'bash' && isUnthemedViewerCommand(exec.arguments?.command)) {
      stats.unthemedViewersRejected++;
      return 'The themed Understand-Anything adapter rejects the downloaded upstream viewer: it lacks the local DeepSeek theme. Call ua_prepare_dashboard and execute its verified local launch command as a managed background bash job. No viewer was started.';
    }
    const entries = exec.agent ? receipts.get(exec.agent) : undefined;
    const delegation = exec.name === 'subagent' || exec.name === 'subagent_fork';
    let phaseAttempt;
    if (delegation && entries?.length && pluginRoot) {
      const label = [exec.arguments?.name, exec.arguments?.description].join('\n');
      const roles = ['assemble-reviewer', 'architecture-analyzer', 'tour-builder', 'code-lesson-writer', 'graph-reviewer'];
      const role = roles.find(name => label.includes(name)) ?? roles.find(name => exec.arguments?.prompt?.includes(`name: ${name}\n`));
      if (role) {
        let original;
        try { original = readFileSync(join(pluginRoot, 'agents', `${role}.md`), 'utf8'); }
        catch { return `Cannot read original ${role} definition; repair the verified upstream installation before dispatch.`; }
        if (!exec.arguments?.prompt?.includes(original)) {
          stats.shortenedPromptsRejected++;
          return `The ${role} child must receive the COMPLETE original agents/${role}.md unchanged, followed by phase inputs/addenda. The supplied role was shortened. No child was started.`;
        }
        let cwd;
        try { cwd = realpathSync(resolve(ctx.workingDirectory.get(exec.agent.session), exec.arguments?.cwd ?? '.')); }
        catch { return 'Cannot resolve semantic-phase cwd.'; }
        const state = activeFull(exec.agent, cwd);
        if (state) {
          const prepared = state.phasePrompts.get(role);
          if (prepared?.length && !prepared.some(p => exec.arguments.prompt === p || exec.arguments.prompt.startsWith(p + '\n\n# Retry feedback\n'))) return `Use the ua_prepare_phase ${role} prompt intact; do not remove its authoritative inputs/addenda.`;
          phaseAttempt = { state, role };
        }
      }
    }
    if (delegation && entries?.length) {
      const args = exec.arguments ?? {};
      const isBatch = /file-analyzer|analy[sz]e\s+batch|fa-batch/i.test([args.prompt, args.name, args.description].join('\n'));
      if (isBatch) {
        const sessionCwd = ctx.workingDirectory.get(exec.agent.session);
        let cwd;
        try { cwd = realpathSync(resolve(sessionCwd, args.cwd ?? sessionCwd)); } catch { cwd = undefined; }
        const match = entries.find(e => cwd === e.cwd && (args.prompt === e.prompt || args.prompt?.startsWith(e.prompt + '\n\n# Retry feedback\n')));
        if (!match) {
          stats.shortenedPromptsRejected++;
          return 'File-analyzer dispatch must use a ua_prepare_batch prompt intact and its returned cwd. The supplied prompt was shortened/changed or belongs to another project. Reuse the prepared prompt; for the authorized single retry append only "\\n\\n# Retry feedback\\n" plus validation evidence. No child was started.';
        }
        const state = stateFor(exec.agent, { projectRoot: match.cwd, plan: match.plan, mode: match.mode });
        if (state.failed.size && !state.failed.has(match.batchIndex)) {
          stats.failedWaveDispatchesRejected++;
          return 'Previous batch wave has failed acceptance. Repair and revalidate that wave before dispatching another batch. No child was started.';
        }
      }
    }
    if (exec.name === 'bash' && exec.agent && /merge-batch-graphs\.py/.test(exec.arguments?.command ?? '') && entries?.length) {
      let cwd;
      try { cwd = realpathSync(resolve(ctx.workingDirectory.get(exec.agent.session), exec.arguments?.workdir ?? '.')); } catch { return 'Cannot resolve project cwd for merge acceptance.'; }
      const active = activeRuns.get(exec.agent)?.get(cwd);
      const state = active ? states.get(exec.agent)?.get(stateKey({ projectRoot: cwd, ...active })) : undefined;
      if (state && !state.mergeReady) {
        stats.prematureMergesRejected++;
        return 'Before merge, ua_validate stage:batches must pass for ALL expected outputs (omit batchIndexes). Failed/partial wave acceptance is not permission to merge.';
      }
    }
    if (exec.name === 'bash' && exec.agent && /start-dashboard\.mjs/.test(exec.arguments?.command ?? '')) {
      for (const state of states.get(exec.agent)?.values() ?? []) {
        if ((exec.arguments?.command ?? '').includes(state.cwd)) {
          const denial = launchDenial(exec.agent, state.cwd);
          if (denial) return denial;
        }
      }
    }
    if (phaseAttempt) phaseAttempt.state.phaseAttempts.add(phaseAttempt.role);
    return undefined;
  });
  ctx.effect(() => () => { receipts = new WeakMap(); states = new WeakMap(); activeRuns = new WeakMap(); });
  return { remember, rememberPhase, review, completionIssues, publication, launchDenial, hasActiveFull: (agent, root) => !!activeFull(agent, root), stats };
}
