#!/usr/bin/env node
'use strict';

// In-memory guards plus one owned TEMP child-exit fixture; no browser or retained test reports.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const api = require('./omitone-acceptance.cjs');
const file = path.join(__dirname, 'omitone-acceptance.cjs');
const source = fs.readFileSync(file, 'utf8');
const runId = '20261023T000000Z-12345678-1234-1234-1234-123456789abc';

function events() {
  const identity = 'a'.repeat(64), buildHash = 'b'.repeat(64);
  return [
    ['run_start', { mode: 'full', built: true, sourceFingerprint: identity, scenarioSourceHash: 'c'.repeat(64), scenarios: ['one', 'two'], baselines: ['unit', 'build'], probes: ['guard'] }],
    ['sandbox_start', { mode: 'full', built: true, sourceFingerprint: identity }],
    ['temporary_created', { path: 'D:/fixture-temp' }],
    ['baseline_start', { file: 'unit' }], ['baseline_end', { file: 'unit', exitCode: 0, signal: null }],
    ['baseline_start', { file: 'build' }], ['baseline_end', { file: 'build', exitCode: 0, signal: null }],
    ['build_verified', { directory: 'D:/fixture-build', files: 66, sha256: buildHash, zipMatchesDirectory: true, runtimeMatchesSource: true }],
    ['browser_ready', { extension: 'D:/fixture-build', browser: 'Edge/fixture', commandLineVerified: true, port: 12345 }],
    ['probes_complete', { names: ['guard'] }],
    ['scenario_plan', { names: ['one', 'two'], hash: 'c'.repeat(64) }],
    ['scenario_start', { name: 'one', index: 0 }],
    ['scenario_end', { name: 'one', assertions: 3, behaviorAssertions: 1, failed: 0, pageErrors: 0 }],
    ['scenario_start', { name: 'two', index: 1 }],
    ['scenario_end', { name: 'two', assertions: 4, behaviorAssertions: 2, failed: 0, pageErrors: 0 }],
    ['sandbox_finish', { passed: true, cleanup: true, sourceUnchanged: true, temporaryRoot: 'D:/fixture-temp',
      mode: 'full', loadedFrom: 'temporary-build', sourceFingerprint: identity, buildHash, scenarios: 2, assertions: 7,
      failedAssertions: 0, unexpectedRequests: 0, guardErrors: 0 }],
    ['process_exit', { code: 0, signal: null, timedOut: false, cleanupVerified: true, portReleased: true }]
  ];
}
function encode(values = events()) {
  let previous = '0'.repeat(64);
  return values.map(([event, data], seq) => {
    const row = api.seal(runId, seq, previous, event, data);
    row.pid = event === 'run_start' || event === 'process_exit' ? 100 : 200;
    const { hash, ...body } = row; row.hash = api.hash(JSON.stringify(body));
    previous = row.hash; return JSON.stringify(row) + '\n';
  }).join('');
}
const rows = values => api.parseJournal(encode(values));

function fakeFsHarness() {
  const files = new Map(), descriptors = new Map(); let seq = 0, syncs = 0, failWrite = false;
  const fakeFs = {
    openSync(name, mode) {
      if (mode === 'wx' && files.has(name)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      if (mode === 'wx') files.set(name, Buffer.alloc(0));
      if (!files.has(name)) throw new Error('missing');
      const fd = ++seq; descriptors.set(fd, name); return fd;
    },
    writeSync(fd, bytes, offset, length) {
      if (failWrite) throw new Error('disk failure');
      const size = Math.min(length, 23); // Force partial writes through the actual write loop.
      const name = descriptors.get(fd); assert.ok(name);
      files.set(name, Buffer.concat([files.get(name), bytes.subarray(offset, offset + size)])); return size;
    },
    writeFileSync(fd, text) { const name = descriptors.get(fd); assert.ok(name); files.set(name, Buffer.from(text)); },
    fsyncSync(fd) { assert.ok(descriptors.has(fd)); syncs++; },
    closeSync(fd) { descriptors.delete(fd); },
    readFileSync(name, encoding) { const bytes = files.get(name); if (!bytes) throw new Error('missing'); return encoding ? bytes.toString(encoding) : bytes; },
    lstatSync() { return { isFile: () => true, isSymbolicLink: () => false }; }
  };
  const module = { exports: {} };
  const requireMock = name => name === 'node:fs' ? fakeFs : require(name);
  const context = vm.createContext({ require: requireMock, module, __dirname, process, Buffer, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: file, timeout: 1000 });
  return { api: module.exports, files, descriptors, syncs: () => syncs, failWrite: () => { failWrite = true; } };
}

async function main() {
  let cases = 0;
  const check = (name, condition) => { assert.ok(condition, name); cases++; console.log('[PASS] ' + name); };
  const valid = api.validate(rows());
  check('complete built evidence passes', valid.passed && valid.scenarios === 2 && valid.assertions === 7);
  const reject = (name, mutate) => {
    const values = events(); mutate(values);
    check(name, api.validate(rows(values)).passed === false);
  };
  const change = (values, event, fields) => Object.assign(values.find(row => row[0] === event)[1], fields);
  reject('missing final report is incomplete', values => values.splice(values.findIndex(row => row[0] === 'sandbox_finish'), 1));
  reject('missing independent exit is incomplete', values => values.pop());
  reject('nonzero exit rejected', values => change(values, 'process_exit', { code: 1 }));
  reject('signal termination rejected', values => change(values, 'process_exit', { code: null, signal: 'SIGTERM' }));
  reject('uncleared temporary resources rejected', values => change(values, 'sandbox_finish', { cleanup: false }));
  reject('independent cleanup witness required', values => change(values, 'process_exit', { cleanupVerified: false }));
  reject('occupied debugging port rejected', values => change(values, 'process_exit', { portReleased: false }));
  reject('timeout never accepted', values => change(values, 'process_exit', { timedOut: true }));
  reject('source-mode run cannot pass built acceptance', values => change(values, 'sandbox_finish', { loadedFrom: 'temporary-source' }));
  reject('wrong build directory rejected', values => change(values, 'browser_ready', { extension: 'D:/other' }));
  reject('missing build integrity rejected', values => change(values, 'build_verified', { zipMatchesDirectory: false }));
  reject('changed build hash rejected', values => change(values, 'sandbox_finish', { buildHash: 'd'.repeat(64) }));
  reject('changed source hash rejected', values => change(values, 'sandbox_start', { sourceFingerprint: 'e'.repeat(64) }));
  reject('duplicate scenario rejected', values => change(values, 'scenario_end', { name: 'two' }));
  reject('missing scenario end rejected', values => values.splice(values.findIndex(row => row[0] === 'scenario_end'), 1));
  reject('missing scene despite green total rejected', values => values.splice(13, 2));
  reject('assertion count mismatch rejected', values => change(values, 'sandbox_finish', { assertions: 99 }));
  reject('no original behavior assertions rejected', values => change(values, 'scenario_end', { behaviorAssertions: 0 }));
  reject('page error rejected', values => change(values, 'scenario_end', { pageErrors: 1 }));
  reject('failed assertion rejected', values => change(values, 'scenario_end', { failed: 1 }));
  reject('missing baseline rejected', values => values.splice(3, 2));
  reject('baseline failure rejected', values => change(values, 'baseline_end', { exitCode: 1 }));
  reject('missing probe rejected', values => change(values, 'probes_complete', { names: [] }));
  reject('unexpected business egress rejected', values => change(values, 'sandbox_finish', { unexpectedRequests: 1 }));
  reject('wrong cleanup path rejected', values => change(values, 'sandbox_finish', { temporaryRoot: 'D:/wrong' }));
  reject('out-of-order stage rejected', values => { const pair = values.splice(7, 1)[0]; values.splice(9, 0, pair); });
  reject('unknown event rejected', values => values.splice(11, 0, ['pretend_success', {}]));
  assert.throws(() => api.parseJournal(encode().slice(0, -1)), /truncated/); check('truncated last line detected', true);
  assert.throws(() => api.parseJournal(encode().replace('fixture-build', 'corrupt-build')), /checksum/); check('corrupted record detected', true);
  const mixed = encode().split('\n'); mixed[1] = mixed[1].replace(runId, 'other-run');
  assert.throws(() => api.parseJournal(mixed.join('\n')), /run identifiers/); check('mixed run evidence rejected', true);
  const reordered = encode().split('\n'); [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  assert.throws(() => api.parseJournal(reordered.join('\n')), /sequence/); check('reordered lines detected', true);
  const sameProcess = rows(); sameProcess.forEach(row => { row.pid = 100; });
  check('same writer cannot claim independent exit', api.validate(sameProcess).passed === false);

  const h = fakeFsHarness(), name = path.join(__dirname, 'fixture.jsonl');
  const journal = new h.api.Journal(name, { runId, plan: {} });
  journal.append('sandbox_start', {}); journal.close();
  check('journal flushes each record including partial writes', h.syncs() === 2 && h.api.parseJournal(h.files.get(name).toString()).length === 2);
  assert.throws(() => new h.api.Journal(name, { runId, plan: {} }), /exists/); check('existing evidence never overwritten', true);
  const continuation = new h.api.Journal(name); continuation.append('stage', {}); continuation.close();
  check('reopened journal preserves chain', h.api.parseJournal(h.files.get(name).toString()).length === 3);
  h.failWrite(); assert.throws(() => new h.api.Journal('failed-write', { runId, plan: {} }), /disk failure/);
  check('write failure closes descriptor', h.descriptors.size === 0);

  h.files.set(name, Buffer.from(encode()));
  const receipt = { evidence: path.resolve(name), evidenceSha256: api.hash(h.files.get(name)), runId,
    passed: true, observedExit: { code: 0, signal: null }, cleanupVerified: true, portReleased: true,
    scenarios: 2, assertions: 7, buildHash: 'b'.repeat(64) };
  h.api.writeReceipt(name.slice(0, -1), receipt);
  check('receipt and journal verify together', h.api.verifyReceipt(name).passed === true);
  assert.throws(() => h.api.writeReceipt(name.slice(0, -1), receipt), /exists/); check('existing receipt never overwritten', true);
  h.files.set(name.slice(0, -1), Buffer.from(JSON.stringify({ ...receipt, evidenceSha256: 'f'.repeat(64) })));
  check('receipt bound to exact journal bytes', h.api.verifyReceipt(name).passed === false);

  // Incomplete state is distinct from a failed but complete run.
  const abrupt = events().slice(0, 13);
  check('mid-run termination retains evidence but cannot pass', api.validate(rows(abrupt)).status === 'incomplete');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omitone-acceptance-test-'));
  try {
    const evidence = path.join(temp, 'interrupted.jsonl');
    const child = spawnSync(process.execPath, [__filename, '--interrupted-fixture', evidence],
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    assert.equal(child.error, undefined);
    check('real child exit status is observed', child.status === 7 && child.signal === null);
    const persisted = api.parseJournal(fs.readFileSync(evidence, 'utf8'));
    check('records flushed before abrupt child exit survive', persisted.length === 2 && persisted[1].event === 'sandbox_start');
    check('abrupt child journal is never accepted', api.audit(evidence).passed === false && api.audit(evidence).status === 'incomplete');
    assert.throws(() => new api.Journal(evidence, { runId, plan: {} }), /EEXIST/);
    check('real existing evidence cannot be overwritten', api.parseJournal(fs.readFileSync(evidence, 'utf8')).length === 2);
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('omitone-acceptance-test-') && !fs.lstatSync(temp).isSymbolicLink());
    for (const entry of fs.readdirSync(temp)) {
      const item = path.join(temp, entry); assert.ok(fs.lstatSync(item).isFile() && !fs.lstatSync(item).isSymbolicLink());
      fs.unlinkSync(item);
    }
    fs.rmdirSync(temp);
  }
  check('child-exit fixture temporary files removed', !fs.existsSync(temp));
  assert.equal(api.hash(fs.readFileSync(file)), api.hash(source));
  console.log('ACCEPTANCE_TEST_REPORT ' + JSON.stringify({ passed: true, cases, writes: 'owned-temp-cleaned', sourceUnchanged: true }));
}

if (require.main === module) {
  if (process.argv[2] === '--interrupted-fixture') {
    const target = path.resolve(process.argv[3] || '');
    assert.equal(path.dirname(path.dirname(target)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(path.dirname(target)).startsWith('omitone-acceptance-test-'));
    const writer = new api.Journal(target, { runId, plan: { mode: 'full', built: true } });
    writer.append('sandbox_start', { mode: 'full', built: true });
    process.exit(7); // Deliberately bypass close: fsync must already have persisted both records.
  } else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}