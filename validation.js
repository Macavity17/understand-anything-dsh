import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function dataDirectory(projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw new TypeError('projectRoot must be an absolute directory');
  return join(resolve(projectRoot), existsSync(join(projectRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
}

export async function loadSchemas(pluginRoot) {
  if (typeof pluginRoot !== 'string' || !isAbsolute(pluginRoot)) throw new TypeError('pluginRoot must be an absolute directory');
  // Load only the upstream schema module, not its parser/runtime-heavy index.
  return import(pathToFileURL(join(pluginRoot, 'packages/core/dist/schema.js')).href);
}

/** Strict, read-only checks: never normalize, invent fields, or drop bad records. */
export async function validateArtifacts(pluginRoot, projectRoot, stage = 'published', suppliedSchemas, batchIndexes, planName = 'batches', mode = 'full') {
  if (!['batches', 'symbol-retry'].includes(planName)) throw new TypeError('plan must be batches or symbol-retry');
  if (!['full', 'incremental'].includes(mode)) throw new TypeError('mode must be full or incremental');
  if (planName === 'symbol-retry') mode = 'incremental';
  if (!['batches', 'candidate', 'published'].includes(stage)) throw new TypeError('stage must be batches, candidate or published');
  const uaDir = dataDirectory(projectRoot);
  const schemas = suppliedSchemas ?? await loadSchemas(pluginRoot);
  let issueCount = 0;
  const issues = [];
  const groups = new Map();
  const issue = (path, message) => {
    issueCount++;
    if (issues.length < 50) issues.push({ path, message });
    const batch = path.match(/batch-[0-9]+(?:-part-[0-9]+)?/)?.[0] ?? 'project';
    const category = path.includes('.tour') ? 'tour-contract' : path.includes('.layers') ? 'architecture' : path.includes('.edges') ? 'edge-schema' : path.includes('.nodes') ? 'node-schema' : path.includes('fingerprint') || path.includes('gitCommitHash') ? 'baseline' : /coverage|covers/.test(message) ? 'coverage' : /Imports/.test(message) ? 'imports' : /endpoint|Dangling/.test(message) ? 'references' : 'contract';
    const key = `${batch}:${category}`;
    const group = groups.get(key) ?? { batch, category, count: 0, samples: [] };
    group.count++;
    if (group.samples.length < 2) group.samples.push({ path, message });
    groups.set(key, group);
  };
  const readJson = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { issue(path, error.message); return undefined; }
  };
  const checkSchema = (schema, value, path) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return true;
    for (const error of parsed.error.issues) issue(`${path}${error.path.length ? '.' + error.path.join('.') : ''}`, error.message);
    return false;
  };
  const scan = readJson(join(uaDir, 'intermediate/scan-result.json'));
  if (scan && (!Array.isArray(scan.files) || !scan.files.length)) issue('scan.files', 'A nonempty original scan inventory is required');
  if (scan) {
    for (const key of ['name', 'description']) if (typeof scan[key] !== 'string' || !scan[key].trim()) issue(`scan.${key}`, 'Completed project-scanner metadata required, not raw scan-project output');
    for (const key of ['languages', 'frameworks']) if (!Array.isArray(scan[key])) issue(`scan.${key}`, 'Completed project-scanner metadata required');
    if (!scan.importMap || typeof scan.importMap !== 'object' || Array.isArray(scan.importMap)) issue('scan.importMap', 'Required import-map handoff is absent; compute-batches extracts exports, not imports');
    for (const [i, file] of (Array.isArray(scan.files) ? scan.files : []).entries()) {
      if (!file || typeof file.path !== 'string' || !file.path || isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) issue(`scan.files.${i}.path`, 'Relative in-project file path required');
      if (typeof file?.language !== 'string' || !Number.isSafeInteger(file?.sizeLines) || file.sizeLines < 0 || !['code', 'config', 'docs', 'infra', 'data', 'script', 'markup'].includes(file?.fileCategory)) issue(`scan.files.${i}`, 'Preserve path/language/sizeLines/fileCategory metadata');
    }
  }
  const inventory = new Set((Array.isArray(scan?.files) ? scan.files : []).map(f => f?.path));
  const covered = new Set();
  let nodes = 0, edges = 0, layers = 0, tour = 0;
  const checkRecords = (graph, path, final) => {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) { issue(path, 'Expected a graph object'); return; }
    if (!Array.isArray(graph.nodes) || !graph.nodes.length) issue(path + '.nodes', 'Nonempty nodes array required');
    if (!Array.isArray(graph.edges)) issue(path + '.edges', 'Edges array required');
    const ids = new Set();
    const wholeFiles = new Map();
    for (const [i, node] of (Array.isArray(graph.nodes) ? graph.nodes : []).entries()) {
      nodes++;
      if (!checkSchema(schemas.GraphNodeSchema, node, `${path}.nodes.${i}`)) continue;
      if (!node.name.trim() || !node.summary.trim()) issue(`${path}.nodes.${i}`, 'Nonempty semantic name and summary required; structural extraction is not analysis');
      if (!node.id.startsWith(`${node.type}:`)) issue(`${path}.nodes.${i}.id`, 'ID must carry the canonical node-type prefix');
      if (ids.has(node.id)) issue(`${path}.nodes.${i}.id`, 'Duplicate node ID');
      ids.add(node.id);
      if (/^(?:Module|Class|Function|Method|File|模块|类|函数|方法|文件)\s*[:：]\s*[^\s，。]+\.?$/i.test(node.summary.trim()) || /^.+中定义的[类函数方法]+.+[，,]\s*包含\d+个方法[，,]\s*\d+行[。.]?$/.test(node.summary.trim())) issue(`${path}.nodes.${i}.summary`, 'Template-only name/count summary is not semantic responsibility/behavior evidence; repair with the original role, not guessed defaults');
      if (node.filePath) {
        covered.add(node.filePath);
        if (['file', 'config', 'document'].includes(node.type)) {
          if (node.id !== `${node.type}:${node.filePath}`) issue(`${path}.nodes.${i}.id`, 'Whole-file nodes must use type:filePath identity; do not retype methods/symbols as files');
          if (wholeFiles.has(node.filePath)) issue(`${path}.nodes.${i}.filePath`, 'Duplicate whole-file representations inflate coverage; use the canonical inventory category');
          wholeFiles.set(node.filePath, node.id);
        }
      }
    }
    for (const [i, edge] of (Array.isArray(graph.edges) ? graph.edges : []).entries()) {
      edges++;
      if (!checkSchema(schemas.GraphEdgeSchema, edge, `${path}.edges.${i}`)) continue;
      // Cross-batch edges intentionally refer to nodes in other batches.
      if (final && (!ids.has(edge.source) || !ids.has(edge.target))) issue(`${path}.edges.${i}`, 'Dangling edge endpoint');
    }
    if (final) {
      checkSchema(schemas.KnowledgeGraphSchema, graph, path);
      layers = Array.isArray(graph.layers) ? graph.layers.length : 0;
      tour = Array.isArray(graph.tour) ? graph.tour.length : 0;
      if (!layers) issue(path + '.layers', 'Architecture is absent: do not call this a completed full analysis');
      if (!tour) issue(path + '.tour', 'Tour is absent: do not call this a completed full analysis');
      for (const [i, step] of (mode === 'full' && Array.isArray(graph.tour) ? graph.tour : []).entries()) {
        if (!Number.isInteger(step?.order) || step.order !== i + 1) issue(`${path}.tour.${i}.order`, 'Tour role requires sequential integer order starting at one');
        if (!Array.isArray(step?.nodeIds) || step.nodeIds.length < 1 || step.nodeIds.length > 5 || new Set(step.nodeIds).size !== step.nodeIds.length) issue(`${path}.tour.${i}.nodeIds`, 'Tour role requires 1–5 distinct real node IDs per step, not the first ten files in a directory');
        if (/^Overview of .+\s[—-]\s\d+ files?\.?$/i.test(step?.description ?? '')) issue(`${path}.tour.${i}.description`, 'Directory/count fallback is not a pedagogical narrative; dispatch the original tour-builder');
      }
      for (const key of ['layers', 'tour']) {
        for (const [i, item] of (Array.isArray(graph[key]) ? graph[key] : []).entries()) {
          if (Array.isArray(item?.nodeIds)) for (const id of item.nodeIds) {
            if (!ids.has(id)) issue(`${path}.${key}.${i}.nodeIds`, `Unknown node ${id}`);
          }
        }
      }
    }
  };
  if (stage === 'batches') {
    const plan = readJson(join(uaDir, 'intermediate', planName === 'symbol-retry' ? 'incremental-symbol-retry.json' : 'batches.json'));
    const incremental = mode === 'incremental' ? readJson(join(uaDir, 'intermediate/incremental-plan.json')) : undefined;
    const authorizedIncremental = incremental && ['PARTIAL_UPDATE', 'ARCHITECTURE_UPDATE'].includes(incremental.action) && Array.isArray(incremental.filesToReanalyze);
    if (mode === 'incremental' && !authorizedIncremental) issue('incremental-plan', 'Current partial/architecture plan required for retained contributions');
    if (!Array.isArray(plan?.batches) || (!plan.batches.length && !(authorizedIncremental && incremental.filesToReanalyze.length === 0))) issue('batches', 'Original batches plan required; empty fresh batches are valid only for zero-reanalysis incremental work');
    if (planName === 'symbol-retry' && (plan?.attempt !== 1 || plan?.baseCommit !== incremental?.baseCommit || plan?.headCommit !== incremental?.headCommit)) issue('symbol-retry', 'Retry attempt/commits do not match the original incremental plan');
    let entries = [];
    try { entries = readdirSync(join(uaDir, 'intermediate')); } catch (error) { issue('intermediate', error.message); }
    if (batchIndexes !== undefined && (!Array.isArray(batchIndexes) || !batchIndexes.length || batchIndexes.some(n => !Number.isSafeInteger(n) || n < 0) || new Set(batchIndexes).size !== batchIndexes.length)) throw new TypeError('batchIndexes must be unique nonnegative integers in a nonempty array');
    const selected = batchIndexes === undefined ? undefined : new Set(batchIndexes);
    const indexes = new Set();
    const acceptedFiles = new Set();
    const allIds = new Set();
    const allEdges = [];
    const collect = (graph, path) => {
      for (const node of (Array.isArray(graph?.nodes) ? graph.nodes : [])) if (typeof node?.id === 'string') allIds.add(node.id);
      for (const edge of (Array.isArray(graph?.edges) ? graph.edges : [])) allEdges.push({ edge, path });
    };
    const retainedName = authorizedIncremental ? (planName === 'symbol-retry' ? 'batch-0.json' : 'batch-existing.json') : undefined;
    if (retainedName) {
      acceptedFiles.add(retainedName);
      const path = join(uaDir, 'intermediate', retainedName);
      const retained = readJson(path);
      // An empty retained graph is valid when every old file was removed.
      if (retained && Array.isArray(retained.nodes) && retained.nodes.length === 0 && Array.isArray(retained.edges) && retained.edges.length === 0) collect(retained, path);
      else { checkRecords(retained, path, false); collect(retained, path); }
    }
    for (const batch of (Array.isArray(plan?.batches) ? plan.batches : [])) {
      if (!batch || typeof batch !== 'object' || !Number.isSafeInteger(batch.batchIndex) || batch.batchIndex < 0 || indexes.has(batch.batchIndex)) {
        issue('batches.batchIndex', 'Indexes must be unique nonnegative integers'); continue;
      }
      indexes.add(batch.batchIndex);
      if (selected && !selected.has(batch.batchIndex)) continue;
      const owned = new Set((Array.isArray(batch.files) ? batch.files : []).map(f => f?.path));
      const full = `batch-${batch.batchIndex}.json`;
      const pattern = new RegExp(`^batch-${batch.batchIndex}-part-([0-9]+)\\.json$`);
      const shards = entries.filter(n => pattern.test(n));
      if (entries.includes(full) && shards.length) issue(full, 'Both single and split outputs exist: stale shards must not enter merge');
      const numbers = shards.map(n => Number(n.match(pattern)[1])).sort((a, b) => a - b);
      if (numbers.some((n, i) => n !== i + 1)) issue(full, 'Split parts must be contiguous and start at 1');
      const files = entries.includes(full) ? [full] : shards;
      if (!files.length) issue(full, 'Missing output for the original batch index');
      const batchCovered = new Set();
      const batchIds = new Set();
      const batchEdges = [];
      for (const file of files) {
        const path = join(uaDir, 'intermediate', file);
        const graph = readJson(path);
        acceptedFiles.add(file);
        checkRecords(graph, path, false);
        collect(graph, path);
        for (const node of (Array.isArray(graph?.nodes) ? graph.nodes : [])) if (typeof node?.id === 'string') {
          if (batchIds.has(node.id)) issue(path, `Duplicate node ID across parts: ${node.id}`);
          batchIds.add(node.id);
        }
        batchEdges.push(...(Array.isArray(graph?.edges) ? graph.edges : []));
        for (const node of (Array.isArray(graph?.nodes) ? graph.nodes : [])) if (node?.filePath) {
          batchCovered.add(node.filePath);
          if (!owned.has(node.filePath)) issue(path, `Node belongs to another batch: ${node.filePath}; cross-batch edges are allowed, imported foreign file nodes are not`);
        }
      }
      if (!Array.isArray(batch.files)) issue(full, 'Original batch files are missing');
      for (const file of (Array.isArray(batch.files) ? batch.files : [])) {
        if (!file || typeof file !== 'object') { issue(full, 'Malformed original batch file'); continue; }
        if (!batchCovered.has(file.path)) issue(full, `No node covers dispatched file ${file.path}`);
        if (file.fileCategory === 'code') {
          const imports = batch.batchImportData?.[file.path];
          if (!Array.isArray(imports)) { issue(full, `Missing authoritative imports for ${file.path}`); continue; }
          const emitted = batchEdges.filter(e => e?.type === 'imports' && e.source === `file:${file.path}`).map(e => e.target).sort();
          const expected = imports.map(path => `file:${path}`).sort();
          if (JSON.stringify(emitted) !== JSON.stringify(expected)) issue(full, `Imports must be emitted 1:1 for ${file.path}, not omitted or aggregated`);
        }
      }
      const authorizedEndpoint = endpoint => {
        if (batchIds.has(endpoint) || allIds.has(endpoint)) return true;
        if (typeof endpoint !== 'string') return false;
        // neighborMap is confidence metadata, NOT an ACL: non-code documents,
        // config and deployment files legitimately point across batches too.
        for (const path of inventory) {
          const matches = ['file', 'config', 'document', 'service', 'pipeline', 'schema', 'resource'].some(type => endpoint === `${type}:${path}`)
            || ['function', 'class', 'table', 'endpoint'].some(type => endpoint.startsWith(`${type}:${path}:`));
          if (matches) return !owned.has(path); // A locally owned endpoint must exist in this batch.
        }
        return /^(module|concept):.+/.test(endpoint); // Resolve these against the complete graph after merge.
      };
      for (const edge of batchEdges) for (const endpoint of [edge?.source, edge?.target]) {
        if (!authorizedEndpoint(endpoint)) issue(full, `Unresolved local or unauthorized cross-batch edge endpoint: ${endpoint}`);
      }
    }
    for (const index of selected ?? []) if (!indexes.has(index)) issue('batchIndexes', `Index ${index} is absent from the authoritative plan`);
    if (!selected) {
      for (const entry of entries) if (/^batch-(?:[0-9]+(?:-part-[0-9]+)?|existing)\.json$/.test(entry) && !acceptedFiles.has(entry)) issue(entry, 'Unvalidated stale/foreign output would enter the original merge');
      // Incremental merge must first reconcile original symbol/edge candidates
      // and identity replacements. Strict candidate/published checks run AFTER it.
      if (mode === 'full') for (const { edge, path } of allEdges) if (!allIds.has(edge?.source) || !allIds.has(edge?.target)) issue(path, 'Dangling edge in the complete merge input set; do not rely on merge dropping it');
    }
  } else {
    const path = join(uaDir, stage === 'candidate' ? 'intermediate/assembled-graph.json' : 'knowledge-graph.json');
    const graph = readJson(path);
    checkRecords(graph, path, true);
    if (stage === 'published') {
      const meta = readJson(join(uaDir, 'meta.json'));
      const fingerprints = readJson(join(uaDir, 'fingerprints.json'));
      const hash = graph?.project?.gitCommitHash;
      if (!hash || meta?.gitCommitHash !== hash || fingerprints?.gitCommitHash !== hash) issue('baseline.gitCommitHash', 'Graph, meta and fingerprints must share a nonempty analyzed commit');
      if (meta?.analyzedFiles !== inventory.size) issue('meta.analyzedFiles', 'Analyzed file count does not match the retained inventory');
      if (fingerprints?.version !== '1.0.0' || typeof fingerprints?.generatedAt !== 'string' || !Number.isFinite(Date.parse(fingerprints.generatedAt))) issue('fingerprints', 'Original versioned fingerprint store with generatedAt required');
      for (const path of inventory) {
        const fingerprint = fingerprints?.files?.[path];
        if (!fingerprint) { issue('fingerprints.files', `Missing baseline for ${path}`); continue; }
        if (fingerprint.filePath !== path || !/^[0-9a-f]{64}$/i.test(fingerprint.contentHash ?? '') || !Number.isInteger(fingerprint.totalLines) || fingerprint.totalLines < 0 || typeof fingerprint.hasStructuralAnalysis !== 'boolean' || ['functions', 'classes', 'imports', 'exports'].some(k => !Array.isArray(fingerprint[k]))) issue(`fingerprints.files.${path}`, 'Malformed fingerprint; use the original build-fingerprints helper, not a fabricated baseline');
      }
    }
  }
  if (stage !== 'batches') for (const path of inventory) if (!covered.has(path)) issue('inventory', `Missing graph coverage for ${path}`);
  return { stage, plan: planName, mode, projectRoot: resolve(projectRoot), uaDir, valid: issueCount === 0, issueCount, issues,
    issuesTruncated: issueCount > issues.length, issueGroups: [...groups.values()], counts: { inventory: inventory.size, nodes, edges, layers, tour },
    analysisCompleted: false,
    note: 'Read-only structural acceptance check, not proof of semantic quality or execution of every upstream phase. Invalid/partial artifacts must not be reported as a completed analysis or auto-launched in Dashboard.' };
}
