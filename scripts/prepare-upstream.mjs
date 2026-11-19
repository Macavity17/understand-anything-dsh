#!/usr/bin/env node
// Replays only the four explicitly versioned theme files. No dependency
// installation, skill rewrites, git pulls, demo mode or token-mode changes.
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeRoot = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(bridgeRoot, 'theme/upstream-2.9.8.json');
const targets = [
  'understand-anything-plugin/packages/dashboard/src/themes/types.ts',
  'understand-anything-plugin/packages/dashboard/src/themes/presets.ts',
  'understand-anything-plugin/packages/dashboard/src/index.css',
  'understand-anything-plugin/packages/dashboard/src/themes/ThemeContext.tsx',
];
// Exact prior three-file release payload accepted only for its changed types.ts.
const priorTypesSha256 = '4aee72a12965d74644426cf33700c2237948dc4e516b004176a43351af05454e';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Reject links even when they point back inside the tree: a theme patch must
// never write through an alias into another checkout or a running dashboard.
async function regularFile(root, relative) {
  if (path.isAbsolute(relative) || relative.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`Unsafe patch path: ${relative}`);
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
  }
  if (!(await lstat(current)).isFile()) throw new Error(`Not a regular file: ${current}`);
  return current;
}

export async function prepareUpstream(upstreamRoot, { check = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js >=22 is required');
  const root = await realpath(upstreamRoot);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== '2.9.8' || manifest.commit !== 'b861852dda79273bd9d2e01c3160d42e2df510d2' ||
      !Array.isArray(manifest.files) || manifest.files.length !== targets.length ||
      manifest.files.some((file, i) => file.target !== targets[i] ||
        (i === 0 ? file.priorSha256 !== priorTypesSha256 : file.priorSha256 !== undefined))) {
    throw new Error('Invalid pinned theme manifest');
  }
  const metadataPath = await regularFile(root, 'understand-anything-plugin/.claude-plugin/plugin.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.name !== 'understand-anything' || metadata.version !== manifest.version) {
    throw new Error(`Unsupported upstream version ${metadata.version}; only ${manifest.version} is supported (${manifest.commit})`);
  }

  // All inputs and payloads are validated before the first write. A changed
  // theme is a hard error, not a best-effort skip or an overwrite of user work.
  const plan = [];
  for (const file of manifest.files) {
    const target = await regularFile(root, file.target);
    const payload = await regularFile(bridgeRoot, file.payload);
    const before = await readFile(target);
    const after = await readFile(payload);
    if (sha256(after) !== file.afterSha256) throw new Error(`Corrupt theme payload: ${file.payload}`);
    const digest = sha256(before);
    if (digest !== file.beforeSha256 && digest !== file.afterSha256 && digest !== file.priorSha256) {
      throw new Error(`Theme preimage mismatch (user edits or incompatible upstream): ${file.target}; expected ${file.beforeSha256} or ${file.afterSha256}${file.priorSha256 ? ` or prior ${file.priorSha256}` : ''}, got ${digest}. No files changed.`);
    }
    plan.push({ target, before, after, changed: digest !== file.afterSha256 });
  }

  if (!check) {
    // Recheck immediately before writing, so ordinary concurrent edits are
    // detected rather than overwritten. Keep same inode; never remove paths.
    for (const file of plan) {
      await regularFile(root, path.relative(root, file.target).split(path.sep).join('/'));
      if (!(await readFile(file.target)).equals(file.before)) throw new Error(`Concurrent edit: ${file.target}`);
    }
    const written = [];
    try {
      for (const file of plan.filter((p) => p.changed)) {
        await writeFile(file.target, file.after);
        written.push(file);
      }
    } catch (error) {
      // Restore only bytes we actually wrote and only if still unchanged.
      for (const file of written.reverse()) {
        if ((await readFile(file.target)).equals(file.after)) await writeFile(file.target, file.before);
      }
      throw error;
    }
  }
  return { version: manifest.version, commit: manifest.commit, changed: plan.filter((p) => p.changed).length, check, root };
}

async function main(args) {
  let upstreamRoot;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--upstream' && args[i + 1] && !upstreamRoot) upstreamRoot = args[++i];
    else if (args[i] === '--check' && !check) check = true;
    else throw new Error('Usage: node scripts/prepare-upstream.mjs --upstream <root> [--check]');
  }
  if (!upstreamRoot) throw new Error('Missing --upstream <root>');
  const result = await prepareUpstream(upstreamRoot, { check });
  console.log(`${check ? 'Validated' : 'Prepared'} DeepSeek blue theme: upstream ${result.version}, ${result.changed} ${check ? 'pending' : 'patched'} file(s); ${result.root}`);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`prepare-upstream: ${error.message}`); process.exitCode = 1; });
}
