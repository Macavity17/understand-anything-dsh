import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const GRAPH_FILE = 'knowledge-graph.json';
const META_FILE = 'meta.json';
const CONFIG_FILE = 'config.json';
const JSON_CACHE_LIMIT = 64;
const NOTIFIED_LIMIT = 256;
const PENDING_LIMIT = 64;

/**
 * Parsed JSON reused while the file's modification time and size stay identical.
 * The Host event loop is single-threaded: the graph can be megabytes, so parsing it
 * on every step would stall every agent. Cached values are validated by `mtimeNs`,
 * which keeps a write in the same millisecond visible.
 */
const jsonCache = new Map();
/** `${project}\0${head}` already delivered, so one stale commit is announced once. */
const notified = new Map();

function remember(file, entry) {
  if (!jsonCache.has(file) && jsonCache.size >= JSON_CACHE_LIMIT) jsonCache.delete(jsonCache.keys().next().value);
  jsonCache.set(file, entry);
}

function cachedJson(file) {
  const stats = statSync(file, { bigint: true });
  const key = `${stats.mtimeNs}:${stats.size}`;
  const cached = jsonCache.get(file);
  if (cached && cached.key === key) return cached.value;
  // Parse failures are never cached: a transient read error must not blind the hook.
  const value = JSON.parse(readFileSync(file, 'utf8'));
  remember(file, { key, value });
  return value;
}

function describe(error) {
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr
    : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
  const detail = stderr.trim() || String(error?.message ?? error);
  const code = error?.status ?? error?.code;
  return code === undefined ? detail : `${String(code)}: ${detail}`;
}

export function resolvePluginRoot(explicit, home = homedir()) {
  const candidates = explicit ? [explicit] : [
    process.env.UNDERSTAND_PLUGIN_ROOT,
    resolve(home, '.understand-anything/repo/understand-anything-plugin'),
    // Follow the skill link itself before walking upwards.
    (() => { try { return resolve(realpathSync(resolve(home, '.dsh/skills/understand')), '../..'); } catch { return null; } })(),
    resolve(home, '.understand-anything-plugin'),
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const root = realpathSync(candidate);
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
      if (manifest.version === '2.9.8' && existsSync(resolve(root, 'skills/understand/SKILL.md')) && existsSync(resolve(root, 'agents/tour-builder.md'))) return root;
    } catch { /* next candidate */ }
  }
  throw new Error('Understand-Anything 2.9.8 not found. Run install.sh or set bundle config upstreamRoot to its understand-anything-plugin directory.');
}
export function dataDirectory(project) {
  for (const name of ['.understand-anything', '.ua']) {
    const dir = resolve(project, name);
    if (existsSync(resolve(dir, GRAPH_FILE))) return dir;
  }
  return resolve(project, '.ua');
}
/**
 * Read the project's graph state without parsing the whole graph when it can be avoided.
 * `meta.json` carries the analyzed commit and is tiny; the graph itself is only opened as a
 * fallback for layouts that keep the commit inline. Every read is cached until the file changes.
 */
export function graphState(project) {
  const dir = dataDirectory(project);
  const state = { dir, autoUpdate: false, graphHash: null, errors: [] };
  // A project without these files simply has not opted in; only real read/parse failures
  // belong in diagnostics, otherwise every unrelated project would look broken.
  const note = (prefix, error) => { if (error?.code !== 'ENOENT') state.errors.push(`${prefix}: ${describe(error)}`); };
  try {
    state.autoUpdate = cachedJson(resolve(dir, CONFIG_FILE)).autoUpdate === true;
  } catch (error) {
    note('config', error);
  }
  try {
    const hash = cachedJson(resolve(dir, META_FILE)).gitCommitHash;
    if (typeof hash === 'string' && hash.length > 0) state.graphHash = hash;
  } catch (error) {
    note('meta', error);
  }
  if (state.graphHash === null) {
    try {
      const hash = cachedJson(resolve(dir, GRAPH_FILE))?.project?.gitCommitHash;
      if (typeof hash === 'string' && hash.length > 0) state.graphHash = hash;
    } catch (error) {
      note('graph', error);
    }
  }
  return state;
}
/** HEAD probe that keeps "not a repository" apart from a real Git failure. */
export function probeHead(project) {
  try {
    const head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { head: head.length > 0 ? head : null, error: null };
  } catch (error) {
    const detail = describe(error);
    // A plain non-repository project is a supported state, not a diagnostic.
    if (/not a git repository|not a working tree/i.test(detail)) return { head: null, error: null };
    return { head: null, error: detail };
  }
}
export function gitHead(project) {
  return probeHead(project).head;
}
export function projectForExecution(ctx, exec) {
  if (!exec.agent) return null;
  const cwd = ctx.workingDirectory.get(exec.agent.session);
  const override = exec.arguments?.workdir;
  return typeof override === 'string' ? resolve(cwd, override) : cwd;
}
export function successfulShellResult(result) {
  if (result.isError) return false;
  const value = result.value;
  // DSH 0.2.2 returns canonical structured results, not rendered console text.
  // Promoted/background starts are not completed executions.
  if (value && typeof value === 'object') {
    return value.kind === 'foreground' && value.exitCode === 0 && value.aborted === false && value.timedOut === false && !value.stopped;
  }
  // Compatibility with older text-returning bash definitions only.
  if (typeof value !== 'string') return false;
  const matches = [...value.matchAll(/\[exit code: (\d+)\]/g)];
  return matches.length > 0 && matches.at(-1)[1] === '0';
}
export function installHooks(ctx, pluginRoot, createUserMessage) {
  const before = new Map();
  const diagnostics = {
    contract: 'canonical-foreground-v1',
    scope: 'since this plugin activation (not durable history)',
    preparedShells: 0,
    checks: 0,
    noticesQueued: 0,
    duplicatesSuppressed: 0,
    injectErrors: 0,
    hookErrors: 0,
    lastNotice: null,
    lastError: null,
  };
  const record = (stage, error, extra = {}) => {
    diagnostics.hookErrors++;
    diagnostics.lastError = { stage, message: describe(error), ...extra };
  };
  const notify = (agent, project, head, reason) => {
    const stamp = `${project}\0${head}`;
    if (notified.has(stamp)) {
      diagnostics.duplicatesSuppressed++;
      return;
    }
    const text = `[Understand-Anything DSH] ${reason} in ${JSON.stringify(project)}. ` +
      'This project opted into autoUpdate. Load the ua-understand skill and follow its original incremental decision, analysis, normalization and save gates. ' +
      // The skill is the interactive /understand procedure: its unchanged-commit and
      // missing-baseline branches ask the user or start a full analysis. Upstream's hook
      // replaces those branches with STOP, and this message is the only channel that can
      // tell the model it is running unattended.
      'Non-interactive hook rules: if knowledge-graph.json or meta.json is missing, or the saved commit already equals HEAD, report that and stop - never start a full analysis and never ask the user. ' +
      'Use only a stored outputLanguage; never detect or write one. ' +
      'Do not synthesize a graph from the file list, invent a tour, or advance metadata without validation. ' +
      `Plugin root: ${JSON.stringify(pluginRoot)}. ` +
      'Respect current user authorization; no hidden model run is started by this hook. This notice is queued for the next admitted step and does not wake an idle agent.';
    // Session format v4 admits producer-owned source kinds only; the released V3
    // `{ kind: 'plugin', plugin }` wrapper is refused with SessionFormatError.
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'understand-anything-dsh' } });
    try {
      agent.inject(message);
    } catch (error) {
      // Admission runs inside inject. Never throw from a Host hook: an escaping error
      // would abort the turn and discard the tool result that triggered it.
      diagnostics.injectErrors++;
      diagnostics.lastError = { stage: 'inject', message: describe(error), project, head };
      return;
    }
    if (!notified.has(stamp) && notified.size >= NOTIFIED_LIMIT) notified.delete(notified.keys().next().value);
    // Stamped only after a successful queue, so a refused notice stays retryable.
    notified.set(stamp, reason);
    diagnostics.noticesQueued++;
    diagnostics.lastNotice = { project, head, reason };
  };
  const check = agent => {
    const project = ctx.workingDirectory.get(agent.session);
    if (typeof project !== 'string' || project.length === 0) return;
    diagnostics.checks++;
    const state = graphState(project);
    if (state.errors.length > 0) diagnostics.lastError = { stage: 'graphState', message: state.errors.join('; '), project };
    if (!state.autoUpdate || !state.graphHash) return;
    const probe = probeHead(project);
    if (probe.error !== null) diagnostics.lastError = { stage: 'git', message: probe.error, project };
    if (probe.head !== null && probe.head !== state.graphHash) {
      notify(agent, project, probe.head, 'The saved graph is behind/different from HEAD');
    }
  };
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      // Without a per-execution token a baseline cannot be attributed to one call.
      if (exec.name === 'bash' && exec.agent && exec.token !== undefined) {
        const project = projectForExecution(ctx, exec);
        if (typeof project === 'string' && graphState(project).autoUpdate) {
          const probe = probeHead(project);
          if (probe.error !== null) diagnostics.lastError = { stage: 'git', message: probe.error, project };
          if (before.size >= PENDING_LIMIT) before.clear();
          before.set(exec.token, { project, head: probe.head });
          diagnostics.preparedShells++;
        }
      }
    } catch (error) {
      record('tools/pre-execute', error);
    }
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    let baseline;
    try {
      baseline = before.get(exec.token);
      before.delete(exec.token);
      if (!baseline || !exec.agent || !successfulShellResult(result)) return;
      const state = graphState(baseline.project);
      if (!state.autoUpdate || state.errors.length > 0) return;
      const probe = probeHead(baseline.project);
      if (probe.error !== null) diagnostics.lastError = { stage: 'git', message: probe.error, project: baseline.project };
      if (probe.head === null || baseline.head === null || probe.head === baseline.head) return;
      if (state.graphHash === probe.head) return;
      notify(exec.agent, baseline.project, probe.head, 'A successful shell execution changed Git HEAD');
    } catch (error) {
      record('tools/result', error, { callId: exec?.token === undefined ? undefined : String(exec.token) });
    }
  });
  // Upstream checks staleness at session start and after a commit, never on every step:
  // a per-step probe would spawn Git (and, without the cache, parse the graph) constantly.
  // `agent/created` plus the activation sweep below cover the session-start case.
  ctx.on('agent/created', ({ agent }) => {
    try {
      check(agent);
    } catch (error) {
      record('agent/created', error);
    }
  });
  ctx.effect(() => () => {
    before.clear();
    // A reload must be able to announce the same HEAD again.
    notified.clear();
  });
  // Existing live agents also receive stale checks after plugin activation.
  for (const agent of ctx.agents.list()) {
    try {
      check(agent);
    } catch (error) {
      record('activation', error);
    }
  }
  return diagnostics;
}