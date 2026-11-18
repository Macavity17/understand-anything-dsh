// Contract check against the installed DSH session-format v4 admission gate.
// Runs under the Desktop Electron runtime, like test:dsh, because the gate lives in app.asar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostModule } from '../runtime.js';
import { installHooks } from '../bridge.js';

const [{ assertV4RowAdmission }, { createUserMessage }] = await Promise.all([
  hostModule('@deepseek-ai/dsh-session-format-v3-to-v4'),
  hostModule('@deepseek-ai/dsh-llm'),
]);

const notice = source => ({ id: 'msg-contract', role: 'user', content: [{ type: 'text', text: 'notice' }], source });
const spliced = source => ({ type: 'agent/inbox/spliced', seq: 7, time: 1794923734409,
  data: { target: 'next-step', start: 0, removedCount: 0, inserted: [notice(source)] } });
const userRow = source => ({ type: 'user/message', seq: 8, time: 1794923734409, data: notice(source) });
const retirement = error => error?.message === 'format v4 message requires a producer-owned source kind';

test('the retired V3 wrapper is still refused by the installed gate', () => {
  assert.throws(() => assertV4RowAdmission(spliced({ kind: 'plugin', plugin: 'understand-anything-dsh' })), retirement);
  assert.throws(() => assertV4RowAdmission(userRow({ kind: 'plugin', plugin: 'understand-anything-dsh' })), retirement);
});

test('the message the bridge really injects passes the installed gate', {
  skip: !process.versions.electron ? 'Use the installed DSH Electron runtime' : false,
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-contract-')));
  t.after(() => rmSync(root, { recursive: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'UA Test'); git('config', 'user.email', 'ua@example.invalid');
  writeFileSync(join(root, 'example.txt'), 'one'); git('add', '.'); git('commit', '-m', 'first');
  const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync(join(root, '.ua'));
  const saved = head();
  writeFileSync(join(root, '.ua/config.json'), JSON.stringify({ autoUpdate: true }));
  writeFileSync(join(root, '.ua/meta.json'), JSON.stringify({ gitCommitHash: saved }));
  writeFileSync(join(root, '.ua/knowledge-graph.json'), JSON.stringify({ project: { gitCommitHash: saved } }));
  writeFileSync(join(root, 'example.txt'), 'two'); git('add', '.'); git('commit', '-m', 'change');

  const captured = [];
  const agent = { session: { cwd: root }, inject: message => captured.push(message) };
  const ctx = {
    on: () => {}, effect: fn => fn(), agents: { list: () => [agent] },
    workingDirectory: { get: session => session.cwd },
  };
  const diagnostics = installHooks(ctx, '/upstream/plugin', createUserMessage);
  // Activation sweep runs at install time and must already have queued the notice.
  assert.equal(captured.length, 1, 'the stale project queues exactly one notice');
  assert.equal(diagnostics.noticesQueued, 1);
  const [message] = captured;
  assert.equal(message.source.kind, 'understand-anything-dsh');

  assert.doesNotThrow(() => assertV4RowAdmission(userRow(message.source)));
  assert.doesNotThrow(() => assertV4RowAdmission(spliced(message.source)));
  console.log(JSON.stringify({ injectedKind: message.source.kind, spliced: 'PASS', userRow: 'PASS' }));
});