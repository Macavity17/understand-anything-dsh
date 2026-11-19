#!/usr/bin/env node
/** Narrow, fail-closed compatibility wrapper for the verified upstream 2.9.8 helper.
 * Preserve its parser, every non-Python resolver, selective analysis and output
 * protocol. Only Python absolute-import search roots change; no upstream edits.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUPPORTED_HELPER_SHA256 = '4f75bcb76d5c0febc4265bce3fdf29060c0e7059cf83057691b7dbb8137e1df9';

function projectPath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0') && !/^[A-Za-z]:/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.' || !part);
}

/** Resolve against inventory-backed project/src and project roots, never each
 * importing package's parents. Original Python package/specifier probing and
 * relative-dot behavior remain upstream-owned. No filesystem walk or fallback.
 */
export function resolveScopedPythonImport(source, specifiers, file, ctx, upstreamResolver) {
  if (typeof source !== 'string' || !projectPath(file?.path) || !(ctx?.fileSet instanceof Set)) return [];
  const safeFiles = new Set([...ctx.fileSet].filter(projectPath));
  if (!safeFiles.has(file.path)) return [];
  const safeContext = { ...ctx, fileSet: safeFiles };
  const inInventory = matches => [...new Set(matches.filter(path => safeFiles.has(path)))];
  if (source.startsWith('.')) return inInventory(upstreamResolver(source, specifiers, file, safeContext));
  if (!source || !source.split('.').every(part => /^[A-Za-z_]\w*$/.test(part))) return [];
  // A src root is inferred only from scoped inventory, not arbitrary directories.
  const roots = [...safeFiles].some(path => /^src\/.+\.pyi?$/.test(path)) ? ['src', ''] : [''];
  for (const root of roots) {
    // Original ancestor probing from this synthetic anchor can visit ONLY src
    // and project, or project alone. It cannot visit autogen_core/ etc.
    const anchor = { ...file, path: root ? `${root}/__ua_import_anchor__.py` : '__ua_import_anchor__.py' };
    const matches = inInventory(upstreamResolver(source, specifiers, anchor, safeContext));
    if (matches.length) return matches;
  }
  return [];
}

function replaceOnce(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw new Error('Unsupported upstream import-helper shape; repair compatibility before analysis');
  return source.replace(oldText, newText);
}

export function transformUpstreamHelper(source, helperUrl, version) {
  if (version !== '2.9.8' || createHash('sha256').update(source).digest('hex') !== SUPPORTED_HELPER_SHA256) {
    throw new Error('Unsupported upstream import helper: expected verified 2.9.8 SHA-256; no fallback or upstream mutation');
  }
  let patched = replaceOnce(source,
    'export function resolvePythonImport(rawImport, specifiers, file, ctx) {',
    'export function __uaUpstreamResolvePythonImport(rawImport, specifiers, file, ctx) {');
  // The data-URL module must retain the original installation/dependency anchor.
  patched = patched.replaceAll('import.meta.url', JSON.stringify(helperUrl));
  // Embed the two narrow functions to avoid a CLI top-level-await import cycle.
  // Their only dependency, isAbsolute, is already an upstream path import.
  return `const projectPath = ${projectPath.toString()};\nconst __uaResolve = ${resolveScopedPythonImport.toString()};\n`
    + patched.replace(/^#![^\n]*\n/, '')
    + '\nexport function resolvePythonImport(source, specifiers, file, ctx) { return __uaResolve(source, specifiers, file, ctx, __uaUpstreamResolvePythonImport); }\n'
    + 'export { main as runUpstreamMain };\n';
}

export async function loadUpstreamHelper(pluginRoot) {
  if (typeof pluginRoot !== 'string' || !isAbsolute(pluginRoot)) throw new Error('--plugin-root must be an absolute upstream plugin directory');
  const root = realpathSync(pluginRoot);
  if (!statSync(root).isDirectory()) throw new Error('--plugin-root must name a directory');
  const helper = realpathSync(join(root, 'skills/understand/extract-import-map.mjs'));
  const rel = relative(root, helper);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Upstream helper escapes plugin root');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const source = transformUpstreamHelper(readFileSync(helper, 'utf8'), pathToFileURL(helper).href, version);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function checkInput(input) {
  if (!isAbsolute(input?.projectRoot ?? '') || !Array.isArray(input.files)) throw new Error('Invalid input: absolute projectRoot and files array required');
  const root = realpathSync(input.projectRoot);
  for (const file of input.files) {
    if (!projectPath(file?.path)) throw new Error('Invalid input: inventory file escapes projectRoot');
    const target = join(root, file.path);
    // Missing files retain upstream per-file failure behavior. Existing symlinks
    // must not let an inventory-only resolver read outside the confirmed scope.
    let actual;
    try { actual = realpathSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Invalid input: inventory symlink escapes projectRoot');
  }
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--plugin-root' || !isAbsolute(args[1])) {
    throw new Error('Usage: node extract-import-map.mjs --plugin-root <absolute-plugin-root> <input.json> <output.json>');
  }
  const [, pluginRoot, inputPath, outputPath] = args;
  checkInput(JSON.parse(readFileSync(inputPath, 'utf8')));
  const helper = await loadUpstreamHelper(pluginRoot);
  const previous = process.argv;
  try {
    process.argv = [process.execPath, previous[1], inputPath, outputPath];
    await helper.runUpstreamMain();
  } finally { process.argv = previous; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(); }
  catch (error) { process.stderr.write(`DSH extract-import-map failed: ${error.message}\n`); process.exitCode = 1; }
}
