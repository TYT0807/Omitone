#!/usr/bin/env node
'use strict';

// Public-contract tests; no browser, network, disk writes or production-source mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const file = path.join(__dirname, 'runtime-log-store.js');
const source = fs.readFileSync(file, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const append = (message, extra) => ({ type: 'runtime_log_append', payload: { message, ...extra } });
const clear = () => ({ type: 'runtime_log_clear' });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Module test deadline exceeded')), 3000);
  })]).finally(() => clearTimeout(timer));
}
function standalone(text = source) {
  const globals = {};
  for (const name of ['chrome', 'document', 'window', 'fetch', 'localStorage', 'Date']) {
    Object.defineProperty(globals, name, { get() { throw new Error('Undeclared global dependency: ' + name); } });
  }
  globals.self = globals;
  const context = vm.createContext(globals);
  vm.runInContext(text, context, { filename: file, timeout: 1000 });
  return context.OmitoneRuntimeLogStore;
}
function fixture(api, overrides = {}) {
  const state = { logs: [], now: 100000, calls: [] };
  const dependencies = {
    now: () => state.now,
    authorize: async (sender, clearing) => { state.calls.push(['authorize', sender, clearing]); return true; },
    read: async () => { state.calls.push(['read']); return copy(state.logs); },
    write: async logs => { state.calls.push(['write']); state.logs = copy(logs); },
    ...overrides
  };
  return { state, dependencies, store: api.create(dependencies) };
}
const tests = [];
const test = (id, name, run) => tests.push({ id, name, run });

test('M01', 'module loads and operates without browser or clock globals', async api => {
  assert.deepEqual(Object.keys(api), ['create']);
  assert.ok(Object.isFrozen(api));
  const f = fixture(api);
  assert.ok(Object.isFrozen(f.store));
  assert.deepEqual(Object.keys(f.store), ['handle']);
  assert.equal((await f.store.handle(append('local'))).success, true);
  assert.deepEqual(f.state.logs, [{ time: 100000, level: 'info', message: 'local', meta: null }]);
});
test('M02', 'missing injected capabilities fail construction', async api => {
  for (const missing of ['read', 'write', 'authorize', 'now']) {
    const dependencies = { read() {}, write() {}, authorize() {}, now() {} };
    delete dependencies[missing];
    assert.throws(() => api.create(dependencies), /requires read, write, authorize and now/);
  }
});
test('M03', 'unknown message and malformed payload never invoke dependencies', async api => {
  const f = fixture(api);
  assert.equal((await f.store.handle({ type: 'unrelated' })).code, 'unknown_message');
  for (const message of [append('x', { unexpected: true }), append('x', { level: 'invalid' }),
    append('x'.repeat(2001)), { type: 'runtime_log_append' }, { type: 'runtime_log_clear', payload: {} }]) {
    assert.equal((await f.store.handle(message)).code, 'invalid_log');
  }
  assert.equal(f.state.calls.length, 0);
});
test('M04', 'authorization must explicitly return true', async api => {
  for (const allowed of [false, null, undefined, 'yes', 1, {}]) {
    const f = fixture(api, { authorize: () => allowed });
    assert.equal((await f.store.handle(append('denied'))).code, 'forbidden_sender');
    assert.deepEqual(f.state.calls, []);
    assert.deepEqual(f.state.logs, []);
  }
});
test('M05', 'sender and clear intent reach host authorization', async api => {
  const f = fixture(api), sender = { id: 'trusted-host-test' };
  await f.store.handle(append('one'), sender);
  await f.store.handle(clear(), sender);
  const auth = f.state.calls.filter(call => call[0] === 'authorize');
  assert.equal(auth.length, 2); assert.equal(auth[0][1], sender);
  assert.deepEqual(auth.map(call => call[2]), [false, true]);
  assert.deepEqual(f.state.logs, []);
});
test('M06', 'failed authorization never reads or writes', async api => {
  for (const authorize of [() => { throw new Error('host failure'); }, () => Promise.reject(new Error('host failure'))]) {
    const f = fixture(api, { authorize });
    assert.equal((await f.store.handle(append('denied'))).code, 'log_storage_failed');
    assert.deepEqual(f.state.calls, []);
  }
});
test('M07', 'concurrent appends preserve all entries and call order', async api => {
  const f = fixture(api);
  await Promise.all(['a', 'b', 'c'].map(message => f.store.handle(append(message))));
  assert.deepEqual(f.state.logs.map(item => item.message), ['a', 'b', 'c']);
});
test('M08', 'clear is ordered between earlier and later appends', async api => {
  const f = fixture(api);
  await Promise.all([f.store.handle(append('before')), f.store.handle(clear()), f.store.handle(append('after'))]);
  assert.deepEqual(f.state.logs.map(item => item.message), ['after']);
});
test('M09', 'read failure releases queue for next request', async api => {
  let first = true;
  const f = fixture(api, { read: () => { if (first) { first = false; throw new Error('read failed'); } return []; } });
  assert.equal((await f.store.handle(append('failed'))).success, false);
  assert.equal((await f.store.handle(append('recovered'))).success, true);
  assert.deepEqual(f.state.logs.map(item => item.message), ['recovered']);
});
test('M10', 'write rejection releases queue for next request', async api => {
  let first = true, saved;
  const f = fixture(api, { write: logs => {
    if (first) { first = false; return Promise.reject(new Error('write failed')); }
    saved = copy(logs);
  } });
  assert.equal((await f.store.handle(append('failed'))).code, 'log_storage_failed');
  assert.equal((await f.store.handle(append('recovered'))).success, true);
  assert.deepEqual(saved.map(item => item.message), ['recovered']);
});
test('M11', 'two instances isolate queues and data', async api => {
  const gate = deferred();
  const a = fixture(api, { read: () => gate.promise }), b = fixture(api);
  const pending = a.store.handle(append('A'));
  try {
    await bounded(b.store.handle(append('B')));
    assert.deepEqual(b.state.logs.map(item => item.message), ['B']);
    assert.deepEqual(a.state.logs, []);
  } finally { gate.resolve([]); await pending; }
  assert.deepEqual(a.state.logs.map(item => item.message), ['A']);
});
test('M12', 'capabilities cannot be swapped after store creation', async api => {
  const f = fixture(api, { authorize: () => false });
  f.dependencies.authorize = () => true;
  assert.equal((await f.store.handle(append('denied'))).code, 'forbidden_sender');
  assert.deepEqual(f.state.logs, []);
});
test('M13', 'capacity keeps last 200 entries', async api => {
  const f = fixture(api);
  f.state.logs = Array.from({ length: 200 }, (_, i) => ({ message: String(i) }));
  await f.store.handle(append('new'));
  assert.equal(f.state.logs.length, 200); assert.equal(f.state.logs[0].message, '1');
  assert.equal(f.state.logs.at(-1).message, 'new');
});
test('M14', 'queue saturation is rejected and later recovers', async api => {
  const gate = deferred(); let first = true;
  const f = fixture(api, { authorize: () => { if (first) { first = false; return gate.promise; } return true; } });
  const pending = Array.from({ length: 200 }, (_, i) => f.store.handle(append(String(i))));
  try { assert.equal((await f.store.handle(append('overflow'))).code, 'log_queue_full'); }
  finally { gate.resolve(true); await Promise.all(pending); }
  assert.equal((await f.store.handle(append('later'))).success, true);
});
test('M15', 'expired queued request is not authorized or written', async api => {
  const gate = deferred(); let first = true;
  const f = fixture(api, { read: () => { if (first) { first = false; return gate.promise; } return []; } });
  const running = f.store.handle(append('running'));
  await turn();
  const waiting = f.store.handle(append('expired'));
  f.state.now += 15001; gate.resolve([]); await running;
  assert.equal((await waiting).code, 'log_queue_expired');
  assert.deepEqual(f.state.logs.map(item => item.message), ['running']);
  assert.equal((await f.store.handle(append('fresh'))).success, true);
});
test('M16', 'permission is checked on execution, not only at enqueue', async api => {
  const gate = deferred(); let permission = true, first = true;
  const f = fixture(api, { authorize: () => permission, read: () => {
    if (first) { first = false; return gate.promise; } return [];
  } });
  const running = f.store.handle(append('first')); await turn();
  const queued = f.store.handle(append('revoked')); permission = false;
  gate.resolve([]); await running;
  assert.equal((await queued).code, 'forbidden_sender');
  assert.deepEqual(f.state.logs.map(item => item.message), ['first']);
});
test('M17', 'metadata redaction preserves ordinary values and prevents prototype keys', async api => {
  const f = fixture(api);
  const meta = JSON.parse('{"apiKey":"fixture","nested":{"authorization":"fixture","count":2},"__proto__":{"polluted":true}}');
  await f.store.handle(append('meta', { meta }));
  const stored = f.state.logs[0].meta;
  assert.equal(stored.apiKey, '[redacted]'); assert.equal(stored.nested.authorization, '[redacted]');
  assert.equal(stored.nested.count, 2); assert.equal(Object.hasOwn(stored, '__proto__'), false);
});
test('M18', 'cyclic and oversized metadata remain bounded', async api => {
  const f = fixture(api), cyclic = {}; cyclic.self = cyclic;
  await f.store.handle(append('cycle', { meta: cyclic }));
  assert.ok(JSON.stringify(f.state.logs[0].meta).includes('[truncated]'));
  const large = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['field' + i, 'x'.repeat(2000)]));
  await f.store.handle(append('large', { meta: large }));
  assert.deepEqual(f.state.logs[1].meta, { note: 'log metadata too large' });
});
test('M19', 'valid supplied timestamps and defaults are preserved', async api => {
  const f = fixture(api);
  await f.store.handle(append('one', { time: 1234, level: 'warn' }));
  await f.store.handle(append('two', { time: -1 }));
  assert.equal(f.state.logs[0].time, 1234); assert.equal(f.state.logs[0].level, 'warn');
  assert.equal(f.state.logs[1].time, 100000); assert.equal(f.state.logs[1].level, 'info');
});
test('M20', 'module normalizes unexpected stored data without mutating caller metadata', async api => {
  const f = fixture(api, { read: () => ({ not: 'an array' }) }), meta = { token: 'fixture', count: 7 };
  await f.store.handle(append('one', { meta }));
  assert.equal(f.state.logs.length, 1); assert.equal(meta.token, 'fixture');
  assert.equal(f.state.logs[0].meta.token, '[redacted]');
});

function dependencyGuardTests() {
  const checkFile = path.join(__dirname, 'tools', 'check.js'), text = fs.readFileSync(checkFile, 'utf8');
  const anchor = "console.log('\\nOmitone 工程自检\\n');", end = text.indexOf(anchor);
  assert.ok(end > 0 && text.lastIndexOf(anchor) === end, 'Check-script execution boundary changed');
  function harness(files) {
    const context = vm.createContext({ require: createRequire(checkFile), __dirname: path.dirname(checkFile) });
    vm.runInContext(text.slice(0, end), context, { filename: checkFile, timeout: 1000 });
    context.read = file => { assert.ok(Object.hasOwn(files, file), 'Unexpected fixture read: ' + file); return files[file]; };
    context.exists = file => Object.hasOwn(files, file);
    return context;
  }
  let count = 0;
  function check(name, condition) { assert.ok(condition, name); count++; console.log('[GUARD] ' + name); }
  const normal = harness({ 'background.js': "importScripts('libs/a.js', 'runtime-log-store.js');",
    'libs/a.js': "importScripts('libs/b.js');", 'libs/b.js': "importScripts('libs/a.js');", 'runtime-log-store.js': '' });
  const graph = normal.collectWorkerScripts('background.js');
  check('transitive imports resolve from worker entry and cycles terminate', graph.issues.length === 0 && graph.files.length === 4);
  const nested = harness({ 'worker/main.js': "importScripts('lib/a.js');", 'worker/lib/a.js': "importScripts('helper.js');", 'worker/helper.js': '' });
  check('nested worker URL is the import base', nested.collectWorkerScripts('worker/main.js').issues.length === 0);
  const missing = harness({ 'background.js': "importScripts('runtime-log-store.js');" });
  check('missing worker-only script is reported', missing.collectWorkerScripts('background.js').issues.some(message => message.includes('runtime-log-store.js')));
  for (const value of ["'https://external.invalid/a.js'", "'../escape.js'", 'computedPath']) {
    const invalid = harness({ 'background.js': 'importScripts(' + value + ');' });
    check('unsafe or unverifiable import rejected: ' + value, invalid.collectWorkerScripts('background.js').issues.length > 0);
  }
  const files = { 'background.js': "importScripts('runtime-log-store.js');", 'runtime-log-store.js': '',
    'tools/build.js': "var INCLUDE = ['background.js'];" };
  const omitted = harness(files);
  omitted.checkManifestFiles({ background: { service_worker: 'background.js' } });
  check('worker dependency omitted from build whitelist fails check', omitted.problems.some(message => message.includes('runtime-log-store.js')));
  const included = harness({ ...files, 'tools/build.js': "var INCLUDE = ['background.js', 'runtime-log-store.js'];" });
  included.checkManifestFiles({ background: { service_worker: 'background.js' } });
  check('complete build whitelist passes check', included.problems.length === 0);
  included.collectHtmlScriptRefs = () => [];
  included.checkDeadFiles(['background.js', 'runtime-log-store.js'], { background: { service_worker: 'background.js' } });
  check('worker-only script is not mislabeled as a dead file', included.warnings.length === 0);
  assert.equal(hash(fs.readFileSync(checkFile)), hash(text), 'Check source changed during tests');
  return count;
}

function buildVerifierTests() {
  const builderFile = path.join(__dirname, 'tools', 'build.js');
  const builderSource = fs.readFileSync(builderFile, 'utf8');
  const end = builderSource.lastIndexOf('\nmain();');
  assert.ok(end > 0 && end === builderSource.indexOf('\nmain();'), 'Build-script boundary changed');
  const builder = vm.createContext({ require: createRequire(builderFile), __dirname: path.dirname(builderFile), Buffer, console });
  vm.runInContext(builderSource.slice(0, end), builder, { filename: builderFile, timeout: 1000 });
  const sandboxFile = path.join(__dirname, 'omitone-sandbox.cjs');
  const sandboxSource = fs.readFileSync(sandboxFile, 'utf8');
  const start = sandboxSource.indexOf('function verifyBuild(snapshot) {');
  const finish = sandboxSource.indexOf('function selectScenarios(', start);
  assert.ok(start >= 0 && finish > start, 'Build verifier boundary changed');
  const snapshot = path.join(__dirname, 'virtual-build-fixture');
  const stage = path.join(snapshot, 'dist', 'omitone-1.3.0');
  const originals = { 'manifest.json': Buffer.from('{"version":"1.3.0","version_name":"1.3.0 experimental"}'),
    'background.js': Buffer.from('worker'), 'runtime-log-store.js': Buffer.from('log-module'),
    'popup-log-view.js': Buffer.from('popup-log-module'),
    'content.js': Buffer.from('content'), 'page.js': Buffer.from('page'), 'popup/popup.js': Buffer.from('popup') };
  function fixture(mode) {
    const staged = { ...originals };
    if (mode === 'missing-module') delete staged['runtime-log-store.js'];
    if (mode === 'stale-module') staged['runtime-log-store.js'] = Buffer.from('stale');
    if (mode === 'missing-popup-module') delete staged['popup-log-view.js'];
    if (mode === 'stale-popup-module') staged['popup-log-view.js'] = Buffer.from('stale-popup');
    if (mode === 'lost-experimental') staged['manifest.json'] = Buffer.from('{"version":"1.3.0","version_name":"1.3.0 b20261023-0000"}');
    if (mode === 'development-leak') staged['omitone-regression.cjs'] = Buffer.from('test');
    if (mode === 'popup-test-leak') staged['omitone-popup-log-test.cjs'] = Buffer.from('test');
    let archive = builder.createZip(Object.entries(staged).map(([name, data]) => ({ name, data })));
    if (mode === 'corrupt-zip') archive = archive.subarray(0, archive.length - 1);
    if (mode === 'zip-directory-mismatch') staged['content.js'] = Buffer.from('changed after ZIP');
    const fakeFs = {
      readFileSync(file, encoding) {
        let data;
        if (file === stage + '.zip') data = archive;
        else if (file.startsWith(stage + path.sep)) data = staged[path.relative(stage, file).replaceAll('\\', '/')];
        else data = originals[path.relative(snapshot, file).replaceAll('\\', '/')];
        assert.ok(data, 'Unexpected fixture read: ' + file);
        return encoding ? data.toString(encoding) : data;
      },
      readdirSync(dir) {
        const prefix = path.relative(stage, dir).replaceAll('\\', '/');
        const base = prefix ? prefix + '/' : '';
        const entries = new Map();
        for (const file of Object.keys(staged)) {
          if (!file.startsWith(base)) continue;
          const remaining = file.slice(base.length), name = remaining.split('/')[0];
          if (name) entries.set(name, remaining.includes('/'));
        }
        return [...entries].map(([name, directory]) => ({ name, isDirectory: () => directory }));
      },
      lstatSync() { return { isSymbolicLink: () => false }; }
    };
    const context = vm.createContext({ fs: fakeFs, path, assert, zlib: require('node:zlib'), digest: hash });
    vm.runInContext(sandboxSource.slice(start, finish), context, { timeout: 1000 });
    return () => context.verifyBuild(snapshot);
  }
  const result = fixture('normal')();
  assert.equal(result.files, 7); assert.equal(result.zipMatchesDirectory, true);
  console.log('[BUILD GUARD] matching ZIP and directory accepted');
  const failures = [
    ['missing-module', /Runtime file missing/], ['stale-module', /Stale staged runtime/],
    ['lost-experimental', /experimental/], ['zip-directory-mismatch', /ZIP and staged file differ/],
    ['development-leak', /Development tests leaked/], ['corrupt-zip', /Build archive end record/],
    ['missing-popup-module', /Runtime file missing/], ['stale-popup-module', /Stale staged runtime/],
    ['popup-test-leak', /Development tests leaked/]
  ];
  for (const [mode, expected] of failures) {
    assert.throws(fixture(mode), expected); console.log('[BUILD GUARD] ' + mode + ' rejected');
  }
  assert.equal(hash(fs.readFileSync(builderFile)), hash(builderSource));
  assert.equal(hash(fs.readFileSync(sandboxFile)), hash(sandboxSource));
  return 1 + failures.length;
}

async function main() {
  const api = standalone();
  const commonjs = require(file);
  assert.equal(typeof commonjs.create, 'function');
  const results = [];
  for (const spec of tests) {
    await bounded(spec.run(api));
    results.push(spec.id); console.log('[PASS] ' + spec.id + ' ' + spec.name);
  }
  const mutations = [
    ['M04', 'if (allowed !== true)', 'if (false)', 'forbidden_sender'],
    ['M07', 'var task = logQueue.then(function () {', 'var task = Promise.resolve().then(function () {', ['a', 'b', 'c']],
    ['M13', 'var nextLogs = logs.slice(-MAX_LOGS);', 'var nextLogs = logs;', 200],
    ['M15', 'if (now() > expiresAt)', 'if (false)', 'log_queue_expired']
  ];
  for (const [id, anchor, replacement, expected] of mutations) {
    assert.equal(source.split(anchor).length, 2, 'Mutation anchor must be unique');
    const altered = source.replace(anchor, replacement); assert.notEqual(altered, source);
    const mutant = standalone(altered), spec = tests.find(item => item.id === id);
    await assert.rejects(bounded(spec.run(mutant)), error => error.code === 'ERR_ASSERTION'
      && JSON.stringify(error.expected) === JSON.stringify(expected));
    console.log('[NEGATIVE CONTROL] ' + id);
  }
  assert.equal(hash(fs.readFileSync(file)), hash(source), 'Source changed during tests');
  const dependencyGuards = dependencyGuardTests();
  const buildGuards = buildVerifierTests();
  console.log('LOG_STORE_TEST_REPORT ' + JSON.stringify({ passed: true, cases: results.length,
    negativeControls: mutations.length, dependencyGuards, buildGuards, sourceUnchanged: true, sourceHash: hash(source) }));
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });