import { createRequire } from 'node:module';
import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareUpstream } from './scripts/prepare-upstream.mjs';

const launchScriptPath = fileURLToPath(new URL('./scripts/start-dashboard.mjs', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function directory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute directory`);
  const resolved = await realpath(path.resolve(value));
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory (${label}): ${resolved}`);
  return resolved;
}

async function file(value, label) {
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isFile()) throw new Error(`Not a regular file (${label}): ${resolved}`);
  return resolved;
}

/** Read-only launch preflight. Stock theme files are valid patch inputs, NOT a themed dashboard. */
export async function prepareDashboard(pluginRoot, projectRoot) {
  pluginRoot = await directory(pluginRoot, 'pluginRoot');
  projectRoot = await directory(projectRoot, 'projectRoot');
  const theme = await prepareUpstream(path.dirname(pluginRoot), { check: true });
  if (path.join(theme.root, 'understand-anything-plugin') !== pluginRoot) {
    throw new Error('pluginRoot must identify the verified understand-anything-plugin checkout');
  }
  if (theme.changed !== 0) {
    throw new Error(`DeepSeek-blue theme is not applied: ${theme.changed} pending file(s). Prepare the pinned theme explicitly before launching; no files changed.`);
  }

  // Match upstream endpoint semantics: an existing legacy directory wins even
  // when its graph is missing. Do not silently show the graph from another tree.
  const legacy = path.join(projectRoot, '.understand-anything');
  const legacyStat = await stat(legacy).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const dataDir = legacyStat?.isDirectory() ? legacy : path.join(projectRoot, '.ua');
  let graphPath;
  try { graphPath = await file(path.join(dataDir, 'knowledge-graph.json'), 'knowledge graph'); }
  catch (error) { throw new Error(`No knowledge graph found at ${path.join(dataDir, 'knowledge-graph.json')}. Run /understand first. ${error.message}`); }

  const dashboardDir = await directory(path.join(pluginRoot, 'packages/dashboard'), 'dashboard');
  const dashboardPackage = await file(path.join(dashboardDir, 'package.json'), 'dashboard package');
  const require = createRequire(dashboardPackage);
  let viteBin;
  let vitePackage;
  let viteMetadata;
  try {
    // Require the installed local entry first. require.resolve alone can climb
    // to ancestor/global dependencies; pnpm's local symlink is fine, fallback is not.
    const localPackage = await file(path.join(dashboardDir, 'node_modules/vite/package.json'), 'local Vite package');
    vitePackage = await file(require.resolve('vite/package.json'), 'resolved Vite package');
    if (vitePackage !== localPackage) throw new Error('Vite resolved outside dashboard/node_modules/vite');
    viteMetadata = JSON.parse(await readFile(vitePackage, 'utf8'));
    if (viteMetadata.name !== 'vite' || typeof viteMetadata.version !== 'string') throw new Error('Invalid local Vite package');
    let bin;
    try { bin = require.resolve('vite/bin/vite.js'); }
    catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      bin = path.join(path.dirname(vitePackage), 'bin/vite.js');
    }
    viteBin = await file(bin, 'local Vite executable');
    if (viteBin !== await file(path.join(path.dirname(localPackage), 'bin/vite.js'), 'local Vite executable')) {
      throw new Error('Vite executable does not belong to the local Vite package');
    }
  } catch (error) {
    throw new Error(`Installed local dashboard Vite is required; no installation or npx fallback attempted. ${error.message}`);
  }

  const launchScript = await file(launchScriptPath, 'dashboard launcher');
  const argv = [launchScript, '--plugin-root', pluginRoot, '--project-root', projectRoot];
  const env = { GRAPH_DIR: projectRoot, VITE_DEMO_MODE: 'false', VITE_DSH_THEME: 'deepseek' };
  return {
    themeId: 'DeepSeek-blue', theme: 'DeepSeek-blue', themeVerification: theme,
    pluginRoot, projectRoot, dashboardDir, dataDir, graphPath,
    viteBin, vitePackage, viteVersion: viteMetadata.version,
    launchScript, cwd: dashboardDir, argv, env,
    nodeExecutablePlaceholder: '${DSH_NODE_EXECUTABLE:?}',
    // The parent runs this with bash workdir=cwd and run_in_background=true.
    // Electron's verified Node executable requires ELECTRON_RUN_AS_NODE=1.
    command: `ELECTRON_RUN_AS_NODE=1 "\${DSH_NODE_EXECUTABLE:?Set DSH_NODE_EXECUTABLE to Node.js >=22}" ${argv.map(quote).join(' ')}`,
  };
}

// This is a narrow recognizer, not a shell evaluator or general npx ban. Quotes
// are decoded so echo/read commands mentioning the viewer remain ordinary data.
function shellStatements(command) {
  const statements = [];
  let words = [], word = '', started = false, quoteMode = null;
  const pushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const pushStatement = () => { pushWord(); if (words.length) statements.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quoteMode === "'") {
      if (char === "'") quoteMode = null;
      else word += char;
    } else if (char === '\\' && command[i + 1] !== undefined) {
      if (command[i + 1] === '\n') { i++; continue; }
      word += command[++i]; started = true;
    } else if (quoteMode === '"') {
      if (char === '"') quoteMode = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quoteMode = char; started = true;
    } else if (char === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (';&|\n()'.includes(char)) {
      pushStatement();
    } else if (/\s/.test(char)) pushWord();
    else { word += char; started = true; }
  }
  pushStatement();
  return statements;
}

export function isUnthemedViewerCommand(command) {
  if (typeof command !== 'string') return false;
  const variables = new Map();
  const expand = (word) => word.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced, plain) => variables.get(braced || plain) ?? match);
  const isViewer = (word) => /https?:\/\/[^\s]*\/understand-anything-viewer\.tgz(?:[?#][^\s]*)?(?:$|["'])/i.test(word);
  for (const statement of shellStatements(command)) {
    let index = 0;
    if (statement[index] === 'export') index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(statement[index] || '')) {
      const assignment = statement[index++];
      const equals = assignment.indexOf('=');
      variables.set(assignment.slice(0, equals), expand(assignment.slice(equals + 1)));
    }
    // Only actual command positions count; `echo 'npx URL'` is not execution.
    while (['command', 'exec'].includes(statement[index])) index++;
    if (path.basename(statement[index] || '') === 'env') {
      index++;
      while (statement[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(statement[index] || '')) {
        const assignment = statement[index++];
        const equals = assignment.indexOf('=');
        if (equals > 0 && !assignment.startsWith('-')) variables.set(assignment.slice(0, equals), expand(assignment.slice(equals + 1)));
      }
    }
    const executable = path.basename(statement[index++] || '');
    if (executable === 'npm' && statement[index++] !== 'exec') continue;
    if (executable !== 'npx' && executable !== 'npm') continue;
    // Match the package being executed, not arbitrary data passed to an
    // unrelated tool (e.g. `npx eslint URL`). Explicit --package is also a
    // download/execution of that viewer even when a --call command follows.
    let target;
    let optionsEnded = false;
    for (; index < statement.length; index++) {
      const word = expand(statement[index]);
      if (!optionsEnded && word === '--') { optionsEnded = true; continue; }
      if (!optionsEnded && /^(?:--package|-p)=/.test(word)) {
        if (isViewer(word.slice(word.indexOf('=') + 1))) return true;
        continue;
      }
      if (!optionsEnded && ['--package', '-p'].includes(word)) {
        if (isViewer(expand(statement[++index] || ''))) return true;
        continue;
      }
      if (!optionsEnded && ['--cache', '--userconfig', '--registry', '--prefix', '--call', '-c'].includes(word)) { index++; continue; }
      if (!optionsEnded && word.startsWith('-')) continue;
      target ??= word;
    }
    if (target && isViewer(target)) return true;
  }
  return false;
}
