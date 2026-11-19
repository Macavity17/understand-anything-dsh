// Execute the shipped TS/TSX with a deterministic React hook/effect harness.
// No source-pattern assertions: provider state, storage writes and picker actions run.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

export function installedTypeScript() {
  try {
    if (process.env.UA_THEME_TYPESCRIPT) return createRequire(import.meta.url)(process.env.UA_THEME_TYPESCRIPT);
    const root = process.env.UA_UPSTREAM_ROOT || path.join(os.homedir(), '.understand-anything/repo');
    return createRequire(path.join(root, 'understand-anything-plugin/packages/dashboard/package.json'))('typescript');
  } catch { return null; }
}

export async function themeRuntime(ts, { mode, saved, storageUnavailable = false } = {}) {
  const modules = new Map();
  let cursor = 0, dirty = false, mounting = true, value;
  const slots = [], pending = [];
  const applied = [], writes = [];
  let stored = saved === undefined ? null : JSON.stringify(saved);
  const react = {
    createContext: () => ({ Provider: 'ThemeProvider' }),
    createElement: (_type, props) => { value = props.value; return props; },
    useContext: () => value,
    useCallback: (callback) => callback,
    useRef: (initial) => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState: (initial) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => {
        const resolved = typeof next === 'function' ? next(slots[i]) : next;
        if (!Object.is(slots[i], resolved)) { slots[i] = resolved; dirty = true; }
      }];
    },
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = slots[i];
      if (!previous || deps.some((dep, index) => !Object.is(dep, previous[index]))) pending.push(effect);
      slots[i] = deps;
    },
  };
  const localStorage = {
    getItem: () => { if (storageUnavailable) throw Error('Storage unavailable'); return stored; },
    setItem: (_key, raw) => { if (storageUnavailable) throw Error('Storage unavailable'); stored = raw; writes.push(raw); },
  };
  function execute(source, name) {
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
      fileName: name, reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => '', getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
    const exports = {};
    const require = (id) => {
      if (id === 'react') return react;
      if (id === './theme-engine.ts') return { applyTheme: (config) => applied.push({ ...config }) };
      if (!modules.has(id)) throw Error('Unexpected module: ' + id);
      return modules.get(id);
    };
    // Classic JSX factory imported explicitly for this controlled harness only.
    vm.runInNewContext('(function(exports, require, createElement) {' + compiled.outputText + '\n})', { localStorage })(exports, require, react.createElement);
    return exports;
  }
  for (const name of ['types.ts', 'presets.ts']) {
    modules.set('./' + name, execute(await readFile(new URL('./upstream-2.9.8/themes/' + name, import.meta.url), 'utf8'), name));
  }
  const source = await readFile(new URL('./upstream-2.9.8/themes/ThemeContext.tsx', import.meta.url), 'utf8');
  // Vite's single compile-time env substitution, not replacement of any theme logic.
  const context = execute(source.replace('import.meta.env.VITE_DSH_THEME', JSON.stringify(mode) ?? 'undefined'), 'ThemeContext.tsx');
  const render = (metaTheme, { replayMountEffects = false } = {}) => {
    let rounds = 0;
    do {
      if (++rounds > 10) throw Error('Unstable render loop');
      dirty = false; cursor = 0; pending.length = 0;
      context.ThemeProvider({ metaTheme, children: null });
      const effects = [...pending];
      for (const effect of effects) effect();
      if (mounting && replayMountEffects) for (const effect of effects) effect();
      mounting = false;
    } while (dirty);
    return JSON.parse(JSON.stringify(value.config));
  };
  return {
    render, applied, writes,
    get picker() { return value; },
    get stored() { return stored; },
    get preset() { return modules.get('./presets.ts').getPreset(value.config.presetId); },
    get accent() { const presets = modules.get('./presets.ts'); return presets.getAccent(presets.getPreset(value.config.presetId), value.config.accentId); },
    resolver: modules.get('./types.ts'),
  };
}
