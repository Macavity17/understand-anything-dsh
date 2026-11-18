import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide } from '../skills.js';

test('trial guard rails stay codebase-specific without changing other skill pipelines', () => {
  const root = '/tmp/upstream';
  const guide = buildGuide(root, 'understand');
  for (const required of ['working_directory({cd:', 'compute-batches extracts exports', 'ua_prepare_batch', 'ua_validate', 'batchIndexes', 'same mode/plan', 'first wave', 'backpressure', 'not artifact existence', 'NOT analysis finished', 'not the DSH Web GUI URL']) assert.ok(guide.includes(required), required);
  for (const name of ['understand-domain', 'understand-knowledge', 'understand-figma', 'understand-dashboard']) {
    const other = buildGuide(root, name);
    assert.ok(!other.includes('Trial-tested codebase execution checklist'));
    assert.ok(!other.includes('call ua_validate with stage:'), name);
  }
  const dashboard = buildGuide(root, 'understand-dashboard');
  for (const required of ['prebuilt viewer does NOT contain', 'local fallback', 'GRAPH_DIR', 'token URL', 'managed background job', 'shell &', 'not a codebase fingerprint requirement']) assert.ok(dashboard.includes(required), required);
});
