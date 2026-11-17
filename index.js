/**
 * Understand-Anything DSH Bridge
 *
 * Adapts the Understand-Anything Claude Code plugin to DeepSeek Harness.
 * Replaces CC's hooks.json (external-process PostToolUse/SessionStart hooks)
 * with Cordis in-process event listeners.
 *
 * The existing skill symlinks at ~/.dsh/skills/understand* already load the
 * skill definitions.  This plugin adds the hook-equivalent behaviour:
 *
 *   1. Auto-update — after a `git commit|merge|cherry-pick|rebase`, when the
 *      project has autoUpdate enabled, inject a prompt telling the agent to
 *      run the incremental update.
 *
 *   2. Stale check — when a new agent starts in a project that has an
 *      autoUpdate-enabled knowledge graph behind HEAD, remind the agent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers — the logic is deliberately kept close to the original .mjs hooks
// so behaviour stays the same; only the transport (stdin/stdout JSON vs
// Cordis events + agent.inject()) differs.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Git commands that should trigger a potential incremental update. */
const COMMIT_COMMAND = /git\s+(commit|merge|cherry-pick|rebase)/;

/**
 * Resolve the Understand-Anything plugin root.
 *
 * In CC the hooks receive CLAUDE_PLUGIN_ROOT; in DSH the skill files are
 * symlinked from ~/.dsh/skills/ → Downloads/…/skills/ so we walk up from
 * the symlink target.
 */
function resolvePluginRoot() {
  const candidates = [
    // DSH skill symlink — follow ~/.dsh/skills/understand → real plugin root
    (() => {
      try {
        const dshSkills = resolve(
          process.env.HOME ?? process.env.USERPROFILE ?? '.',
          '.dsh/skills/understand',
        );
        const { readlink } = require('node:fs');
        const target = readlink(dshSkills);
        // target is .../skills/understand, go up 2 to plugin root
        if (target) return resolve(dirname(target), '..');
      } catch { /* symlink missing */ }
      return null;
    })(),
    // Direct clone location (install.sh default)
    resolve(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.understand-anything/repo/understand-anything-plugin',
    ),
    // Universal symlink
    resolve(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.understand-anything-plugin',
    ),
  ];

  for (const c of candidates) {
    if (c && existsSync(resolve(c, 'package.json'))) return c;
  }
  return null;
}

/**
 * Find the project data directory (legacy .understand-anything or .ua).
 */
function findDataDir(projectRoot) {
  if (existsSync(resolve(projectRoot, '.understand-anything'))) {
    return '.understand-anything';
  }
  return '.ua';
}

/**
 * Check whether auto-update is enabled for this project.
 */
function autoUpdateEnabled(projectRoot) {
  const dir = findDataDir(projectRoot);
  try {
    const config = JSON.parse(
      readFileSync(resolve(projectRoot, dir, 'config.json'), 'utf8'),
    );
    return config.autoUpdate === true;
  } catch {
    return false;
  }
}

/**
 * Check whether the knowledge graph is stale (commit hash in meta != HEAD).
 */
function isStale(projectRoot) {
  const dir = findDataDir(projectRoot);
  try {
    const config = JSON.parse(
      readFileSync(resolve(projectRoot, dir, 'config.json'), 'utf8'),
    );
    if (config.autoUpdate !== true) return false;
  } catch {
    return false;
  }

  if (!existsSync(resolve(projectRoot, dir, 'knowledge-graph.json')))
    return false;

  let graphCommit;
  try {
    graphCommit = JSON.parse(
      readFileSync(resolve(projectRoot, dir, 'meta.json'), 'utf8'),
    ).gitCommitHash;
  } catch {
    return false;
  }
  if (!graphCommit) return false;

  let head;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return false;
  }
  return graphCommit !== head;
}

/**
 * Build the auto-update prompt to inject into the agent context.
 */
function buildAutoUpdatePrompt(pluginRoot) {
  return (
    '[understand-anything] Commit detected with auto-update enabled. ' +
    'You MUST read the file at ' +
    `${pluginRoot}/hooks/auto-update-prompt.md ` +
    'and execute its instructions to incrementally update the knowledge graph. ' +
    'Do not ask the user for confirmation — just do it.'
  );
}

/**
 * Build the stale-check prompt.
 */
function buildStalePrompt(pluginRoot) {
  return (
    '[understand-anything] Knowledge graph is stale. You MUST read the file at ' +
    `${pluginRoot}/hooks/auto-update-prompt.md ` +
    'and execute its instructions to check for structural ' +
    'changes and update the graph. Do not ask the user for confirmation — just do it.'
  );
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const inject = ['agent', 'tools'];

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const pluginRoot = resolvePluginRoot();
  if (!pluginRoot) {
    // Plugin is installed but Understand-Anything checkout not found.
    // The skill symlinks may still work; hooks degrade gracefully.
    return;
  }

  // ------------------------------------------------------------------
  // 1. Auto-update hook — equivalent to CC PostToolUse (Bash|exec)
  // ------------------------------------------------------------------
  ctx.on('tools/result', (result) => {
    // Only react to bash tool executions
    if (result.tool_name !== 'bash') return;

    const command = result.input?.command;
    if (typeof command !== 'string' || !COMMIT_COMMAND.test(command)) return;

    // Resolve project root from the working directory
    let projectRoot = result.context?.workingDirectory ?? process.cwd();

    if (!autoUpdateEnabled(projectRoot)) return;

    const dataDir = findDataDir(projectRoot);
    if (!existsSync(resolve(projectRoot, dataDir, 'knowledge-graph.json')))
      return;

    // Inject the auto-update prompt into the agent's context.
    // Use agent.inject() so it arrives as additional context for the
    // next agent step — same effect as CC's hookSpecificOutput.
    const agent = ctx.get('agent');
    if (agent?.current) {
      agent.current.inject(buildAutoUpdatePrompt(pluginRoot));
    }
  });

  // ------------------------------------------------------------------
  // 2. Stale check — equivalent to CC SessionStart
  // ------------------------------------------------------------------
  ctx.on('agent/created', (agent) => {
    // Each agent creation is a chance to check staleness.
    // We defer the actual check to the first pre-step of that agent so
    // the working directory is already set.
    const dispose = agent.ctx.on('agent/pre-step', (_decision, next) => {
      dispose(); // run once per agent

      const projectRoot = agent.ctx.get('workingDirectory')?.current ?? process.cwd();

      if (isStale(projectRoot)) {
        agent.inject(buildStalePrompt(pluginRoot));
      }

      return next();
    });
  });
}