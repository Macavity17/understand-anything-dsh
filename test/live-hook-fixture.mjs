// Disposable, explicitly synthetic fixture for live hook transport validation.
// It is not a knowledge graph analysis and must never be advertised as one.
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-live-hook-')));
const git = (...args) => execFileSync('git',['-C',root,...args],{stdio:'pipe'});
git('init');git('config','user.name','UA Live Hook Test');git('config','user.email','ua-live@example.invalid');
writeFileSync(join(root,'fixture.txt'),'one\n');git('add','fixture.txt');git('commit','-m','fixture baseline');
mkdirSync(join(root,'.ua'));
writeFileSync(join(root,'.ua/config.json'),JSON.stringify({autoUpdate:true,fixtureOnly:true}));
writeFileSync(join(root,'.ua/knowledge-graph.json'),JSON.stringify({fixtureOnly:true,project:{gitCommitHash:git('rev-parse','HEAD').toString().trim()}}));
console.log(JSON.stringify({root,purpose:'Hook notice transport only; do not analyze',cleanup:'Remove only after checking this exact resolved fixture root'}));
