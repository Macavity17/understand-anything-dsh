import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Host processes do not receive the environment injected into individual bash calls.
// Resolve only from the plugin, an explicit installed DSH anchor, or the running
// Desktop application's own verified runtime. Never use the session cwd.
export function runtimeAnchors({ env = process.env, resourcesPath = process.resourcesPath, argv = process.argv } = {}) {
  const anchors = [];
  if (env.DSH_INSTALL_DIR) {
    const file = resolve(env.DSH_INSTALL_DIR, 'package.json');
    try { if (JSON.parse(readFileSync(file, 'utf8')).name === '@deepseek-ai/dsh') anchors.push(file); } catch { /* invalid */ }
  }
  if (resourcesPath) {
    const file = resolve(resourcesPath, 'app.asar/dsh/package.json');
    try { if (JSON.parse(readFileSync(file, 'utf8')).name === '@deepseek-ai/dsh-desktop-runtime') anchors.push(file); } catch { /* not this Desktop layout */ }
  }
  // Conventional Node CLI launch: use the actual entrypoint's dependency tree.
  if (argv[1] && existsSync(argv[1])) {
    try {
      const req = createRequire(resolve(argv[1]));
      const file = req.resolve('@deepseek-ai/dsh/package.json');
      if (JSON.parse(readFileSync(file, 'utf8')).name === '@deepseek-ai/dsh') anchors.push(file);
    } catch { /* unsupported launcher; do not guess */ }
  }
  return [...new Set(anchors)];
}
export async function hostModule(name, options) {
  if (!name.startsWith('@deepseek-ai/')) throw new Error('Only installed DSH packages may be resolved');
  const errors = [];
  for (const anchor of [import.meta.url, ...runtimeAnchors(options)]) {
    try {
      const req = createRequire(anchor);
      return await import(pathToFileURL(req.resolve(name)).href);
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`Cannot resolve installed DSH package ${name} from the plugin or verified runtime: ${errors.join('; ')}`);
}
