#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareDashboard } from '../dashboard.js';

const usage = 'Usage: node scripts/start-dashboard.mjs --plugin-root <root> --project-root <root> [--port 5173]';

export function parseDashboardArgs(args) {
  const result = { port: 5173 };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--plugin-root', '--project-root', '--port'].includes(flag) || seen.has(flag)) throw new Error(usage);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(usage);
    seen.add(flag);
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Port must be an integer from 1 to 65535');
      result.port = Number(value);
    } else result[flag === '--plugin-root' ? 'pluginRoot' : 'projectRoot'] = value;
  }
  if (!result.pluginRoot || !result.projectRoot) throw new Error(usage);
  return result;
}

/** Remain foregrounded under the parent's managed job; no shell and no internal &. */
export async function startDashboard(args) {
  const { pluginRoot, projectRoot, port } = parseDashboardArgs(args);
  const prepared = await prepareDashboard(pluginRoot, projectRoot);
  const grouped = process.platform !== 'win32';
  const child = spawn(process.execPath, [prepared.viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: prepared.cwd,
    // Prepared branded-launch env wins over inherited gold/other mode values.
    env: { ...process.env, ...prepared.env },
    // A separate process group lets termination cover Vite's subprocesses too.
    // We DO NOT unref the child: this launcher lives until Vite is reaped.
    detached: grouped,
    stdio: 'inherit',
  });
  let requestedSignal;
  let escalation;
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = (signal) => {
    requestedSignal ??= signal;
    kill(signal);
    escalation ??= setTimeout(() => kill('SIGKILL'), 5000);
    escalation.unref();
  };
  const onTerm = () => terminate('SIGTERM');
  const onInt = () => terminate('SIGINT');
  const onExit = () => kill('SIGKILL');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('exit', onExit);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Vite is already reaped. Force cleanup of remaining group descendants,
    // including ones which ignored the forwarded graceful termination signal.
    kill('SIGKILL');
    return { code: result.code ?? 1, signal: requestedSignal ?? result.signal };
  } finally {
    clearTimeout(escalation);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    process.removeListener('exit', onExit);
  }
}

async function main(args) {
  const result = await startDashboard(args);
  if (result.signal) {
    // Re-raise after removing handlers, preserving the child's signal rather
    // than reporting a successful wrapper exit or an arbitrary numeric status.
    process.kill(process.pid, result.signal);
  } else process.exitCode = result.code;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`start-dashboard: ${error.message}`);
    process.exitCode = 1;
  });
}
