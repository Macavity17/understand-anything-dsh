import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolvePluginRoot, installHooks, gitHead, dataDirectory, successfulShellResult } from '../bridge.js';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-bridge-test-')));
  t.after(() => { assert.ok(root.startsWith(realpathSync(tmpdir())+'/ua-bridge-test-')); rmSync(root,{recursive:true}); });
  const git = (...args) => execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init'); git('config','user.name','UA Test'); git('config','user.email','ua@example.invalid');
  writeFileSync(join(root,'example.txt'),'one');git('add','.');git('commit','-m','first');
  mkdirSync(join(root,'.ua'));
  const save = (auto = true, hash = gitHead(root)) => {
    writeFileSync(join(root,'.ua/config.json'),JSON.stringify({autoUpdate:auto}));
    // The real analyzer writes the commit to both files; meta.json is the one upstream's
    // own stale check reads, so the adapter must honour it too.
    writeFileSync(join(root,'.ua/meta.json'),JSON.stringify({gitCommitHash:hash}));
    writeFileSync(join(root,'.ua/knowledge-graph.json'),JSON.stringify({project:{gitCommitHash:hash}}));
  }; save();
  const handlers = new Map(), notices=[], diagnostics=[];
  let refuse = false;
  const spawn = () => ({ session:{cwd:root}, inject: message => {
    if (refuse) { refuse = false; throw new Error('format v4 message requires a producer-owned source kind'); }
    notices.push(message);
  } });
  const agent = spawn();
  const ctx = {on:(name,fn)=>handlers.set(name,fn), effect:fn=>fn(), workingDirectory:{get:s=>s.cwd}, agents:{list:()=>[agent]}};
  const message = value => ({...value, role:'user',id:'fixture'});
  diagnostics.push(installHooks(ctx,'/upstream/plugin',message));
  const call = workdir => ({name:'bash',arguments:workdir?{workdir}:{},agent,token:{}});
  const commit = () => {writeFileSync(join(root,'example.txt'),Math.random().toString());git('add','example.txt');git('commit','-m','change');};
  return {root,git,save,ctx,agent,handlers,notices,call,commit,spawn,diagnostics:diagnostics[0],
    refuseNextInject:()=>{refuse=true;}};
}
test('shell completion accepts canonical foreground and rejects nonzero, errors and async job starts',()=>{
  assert.equal(successfulShellResult({isError:false,value:{kind:'foreground',exitCode:0,aborted:false,timedOut:false}}),true);
  assert.equal(successfulShellResult({isError:false,value:{kind:'foreground',exitCode:1,aborted:false,timedOut:false}}),false);
  assert.equal(successfulShellResult({isError:false,value:{kind:'promoted',jobId:'fixture'}}),false);
  assert.equal(successfulShellResult({isError:false,value:{kind:'foreground',exitCode:0,aborted:true,timedOut:false}}),false);
  assert.equal(successfulShellResult({isError:false,value:'done\n[exit code: 0]'}),true);
  assert.equal(successfulShellResult({isError:false,value:'[exit code: 1]'}),false);
  assert.equal(successfulShellResult({isError:false,value:'started background job id'}),false);
  assert.equal(successfulShellResult({isError:true}),false);
});
test('HEAD-changing success injects producer-owned context, never per-step, and dedupes across agents',t=>{
  const f=fixture(t),exec=f.call(), decision={kind:'allow'};
  assert.equal(f.handlers.get('tools/pre-execute')(exec,()=>decision),decision);
  f.commit();f.handlers.get('tools/result')(exec,{isError:false,value:'[exit code: 0]'});
  assert.equal(f.notices.length,1);assert.equal(f.notices[0].source.kind,'understand-anything-dsh');assert.notEqual(f.notices[0].source.kind,'plugin');assert.match(f.notices[0].content[0].text,/ua-understand/);
  assert.equal(f.handlers.has('agent/pre-step'),false,'staleness must not be probed on every step');
  const text=f.notices[0].content[0].text;
  assert.match(text,/never start a full analysis and never ask the user/,'missing-baseline and unchanged-commit branches must not fall into the interactive \/understand path');
  assert.match(text,/never detect or write one/,'the hook must not persist a detected outputLanguage');
  assert.match(text,/meta\.json is missing/);
  f.handlers.get('agent/created')({agent:f.agent});
  assert.equal(f.notices.length,1,'same project and HEAD deduplicated');
  f.handlers.get('agent/created')({agent:f.spawn()});
  assert.equal(f.notices.length,1,'a sibling agent does not repeat the same notice');
  assert.equal(f.diagnostics.noticesQueued,1);assert.equal(f.diagnostics.duplicatesSuppressed,2);
});
test('meta.json alone is enough: the graph is not parsed for the commit hash',t=>{
  const f=fixture(t),stale=gitHead(f.root);
  writeFileSync(join(f.root,'.ua/knowledge-graph.json'),JSON.stringify({project:{}}));
  writeFileSync(join(f.root,'.ua/meta.json'),JSON.stringify({gitCommitHash:stale}));
  f.commit();f.handlers.get('agent/created')({agent:f.agent});
  assert.equal(f.notices.length,1);assert.match(f.notices[0].content[0].text,/behind\/different from HEAD/);
});
test('unchanged HEAD, disabled auto-update and failed commands do not inject',t=>{
  const f=fixture(t);let exec=f.call();f.handlers.get('tools/pre-execute')(exec,()=>({kind:'allow'}));f.handlers.get('tools/result')(exec,{isError:false,value:'[exit code: 0]'});assert.equal(f.notices.length,0);
  exec=f.call();f.handlers.get('tools/pre-execute')(exec,()=>({kind:'allow'}));f.commit();f.handlers.get('tools/result')(exec,{isError:false,value:'[exit code: 1]'});assert.equal(f.notices.length,0);
  f.save(false);f.handlers.get('agent/created')({agent:f.agent});assert.equal(f.notices.length,0);
});
test('a refused injection is reported and stays retryable instead of being silently stamped',t=>{
  const f=fixture(t);f.commit();
  f.refuseNextInject();
  f.handlers.get('agent/created')({agent:f.agent});
  assert.equal(f.notices.length,0);assert.equal(f.diagnostics.injectErrors,1);assert.equal(f.diagnostics.noticesQueued,0);
  assert.match(f.diagnostics.lastError.message,/producer-owned source kind/);assert.equal(f.diagnostics.lastError.stage,'inject');
  f.handlers.get('agent/created')({agent:f.agent});
  assert.equal(f.notices.length,1,'the same HEAD is still announced after a failed attempt');
  assert.equal(f.diagnostics.noticesQueued,1);
});
test('hook failures never escape into the Host and are recorded for ua_status',t=>{
  const f=fixture(t);const decision={kind:'allow'};
  f.ctx.workingDirectory.get=()=>{throw new Error('cwd unavailable');};
  assert.doesNotThrow(()=>f.handlers.get('agent/created')({agent:f.agent}));
  assert.equal(f.diagnostics.hookErrors,1);assert.equal(f.diagnostics.lastError.stage,'agent/created');assert.match(f.diagnostics.lastError.message,/cwd unavailable/);
  assert.equal(f.handlers.get('tools/pre-execute')(f.call(),()=>decision),decision,'the tool pipeline keeps running');
  assert.equal(f.diagnostics.hookErrors,2);
});
test('created payload and relative workdir are interpreted using real APIs',t=>{
  const f=fixture(t);f.commit();f.handlers.get('agent/created')({agent:f.agent});assert.equal(f.notices.length,1);
  f.save();f.agent.session.cwd=join(f.root,'.ua');const exec=f.call('..');f.handlers.get('tools/pre-execute')(exec,()=>({kind:'allow'}));f.commit();f.handlers.get('tools/result')(exec,{isError:false,value:'[exit code: 0]'});assert.equal(f.notices.length,2);
});
test('legacy data directory requires a graph, not just an empty directory',t=>{
  const f=fixture(t);mkdirSync(join(f.root,'.understand-anything'));assert.equal(dataDirectory(f.root),join(f.root,'.ua'));
});
test('plugin symlink follows actual target and incompatible explicit roots fail',t=>{
  const f=fixture(t);const root=join(f.root,'upstream');mkdirSync(join(root,'skills/understand'),{recursive:true});mkdirSync(join(root,'agents'));writeFileSync(join(root,'package.json'),JSON.stringify({version:'2.9.8'}));writeFileSync(join(root,'skills/understand/SKILL.md'),'skill');writeFileSync(join(root,'agents/tour-builder.md'),'tour');mkdirSync(join(f.root,'.dsh/skills'),{recursive:true});symlinkSync(join(root,'skills/understand'),join(f.root,'.dsh/skills/understand'));
  assert.equal(resolvePluginRoot(undefined,f.root),root);
  assert.throws(()=>resolvePluginRoot(f.root),/2.9.8 not found/);
});