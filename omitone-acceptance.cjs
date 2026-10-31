#!/usr/bin/env node
'use strict';

// Foreground supervisor + append-only evidence. Never reuse a browser or accept stdout as proof.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = __dirname;
const SCHEMA = 1;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const ZERO = '0'.repeat(64);
const FILE_PATTERN = /^omitone-acceptance-\d{8}T\d{6}Z-[a-f0-9-]{36}\.jsonl$/;

function seal(runId, seq, prev, event, data) {
  const value = { schema: SCHEMA, runId, seq, prev, event, at: new Date().toISOString(), pid: process.pid, data };
  return { ...value, hash: hash(JSON.stringify(value)) };
}
function parseJournal(text) {
  if (!text || !text.endsWith('\n')) throw new Error('Evidence empty or truncated');
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
  let previous = ZERO, runId;
  rows.forEach((row, seq) => {
    const { hash: digest, ...body } = row;
    assert.equal(row.schema, SCHEMA, 'Unknown evidence schema');
    assert.equal(row.seq, seq, 'Evidence sequence mismatch');
    if (seq === 0) runId = row.runId;
    assert.equal(row.runId, runId, 'Mixed run identifiers');
    assert.equal(row.prev, previous, 'Evidence chain mismatch');
    assert.equal(digest, hash(JSON.stringify(body)), 'Evidence checksum mismatch');
    previous = digest;
  });
  return rows;
}
class Journal {
  constructor(file, start) {
    this.file = file;
    if (start) {
      this.fd = fs.openSync(file, 'wx'); this.runId = start.runId; this.seq = 0; this.previous = ZERO;
      try { this.append('run_start', start.plan); } catch (error) { this.close(); throw error; }
    } else {
      const stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Evidence path must be a regular file');
      const rows = parseJournal(fs.readFileSync(file, 'utf8'));
      this.runId = rows[0].runId; this.seq = rows.length; this.previous = rows.at(-1).hash;
      this.fd = fs.openSync(file, 'a');
    }
  }
  append(event, data) {
    assert.notEqual(this.fd, null, 'Journal is closed');
    const row = seal(this.runId, this.seq, this.previous, event, data);
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    let position = 0;
    while (position < bytes.length) position += fs.writeSync(this.fd, bytes, position, bytes.length - position);
    fs.fsyncSync(this.fd);
    this.seq++; this.previous = row.hash;
  }
  close() { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }
}

function validate(rows) {
  const errors = [], starts = [], completed = [], baselines = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!Array.isArray(rows) || !rows.length) return { passed: false, status: 'incomplete', errors: ['No records'] };
  const only = event => {
    const found = rows.filter(row => row.event === event);
    require(found.length === 1, 'Expected exactly one ' + event);
    return found[0]?.data;
  };
  require(rows[0].event === 'run_start', 'Missing initial plan');
  const plan = only('run_start'), begin = only('sandbox_start'), build = only('build_verified');
  const temporary = only('temporary_created');
  const loaded = only('browser_ready'), scenarioPlan = only('scenario_plan');
  const probes = only('probes_complete'), finish = only('sandbox_finish'), exit = only('process_exit');
  let currentScenario = null, currentBaseline = null;
  const allowedEvents = new Set(['run_start', 'sandbox_start', 'temporary_created', 'baseline_start', 'baseline_end',
    'build_verified', 'browser_ready', 'probes_complete', 'scenario_plan', 'scenario_start', 'scenario_end',
    'sandbox_error', 'worker_error', 'sandbox_finish', 'process_exit']);
  const stageOrder = ['run_start', 'sandbox_start', 'temporary_created', 'build_verified', 'browser_ready',
    'probes_complete', 'scenario_plan', 'sandbox_finish', 'process_exit'];
  let lastStage = -1;
  const supervisorPid = rows[0].pid, workerPid = rows.find(row => row.event === 'sandbox_start')?.pid;
  require(Number.isInteger(supervisorPid) && Number.isInteger(workerPid) && supervisorPid !== workerPid,
    'Missing independent process identities');
  for (const row of rows) {
    require(allowedEvents.has(row.event), 'Unknown evidence event');
    require(row.pid === (row.event === 'run_start' || row.event === 'process_exit' ? supervisorPid : workerPid), 'Wrong event writer process');
    const stage = stageOrder.indexOf(row.event);
    if (stage >= 0) { require(stage > lastStage, 'Out-of-order evidence stage'); lastStage = stage; }
    if (row.event === 'baseline_start') {
      require(lastStage === 2, 'Baseline outside initialization phase');
      require(currentBaseline === null, 'Overlapping baseline'); currentBaseline = row.data.file;
    }
    if (row.event === 'baseline_end') {
      require(lastStage === 2, 'Baseline completion outside initialization phase');
      require(row.data.file === currentBaseline, 'Baseline completion mismatch');
      require(row.data.exitCode === 0 && row.data.signal === null, 'Baseline did not exit cleanly: ' + row.data.file);
      baselines.push(row.data.file); currentBaseline = null;
    }
    if (row.event === 'scenario_start') {
      require(lastStage === 6, 'Scenario outside planned browser phase');
      require(currentScenario === null, 'Overlapping scenario');
      require(row.data.index === starts.length, 'Scenario index mismatch');
      currentScenario = row.data.name; starts.push(row.data.name);
    }
    if (row.event === 'scenario_end') {
      require(lastStage === 6, 'Scenario completion outside planned browser phase');
      require(row.data.name === currentScenario, 'Scenario completion mismatch');
      require(Number.isInteger(row.data.assertions) && row.data.assertions > 0, 'Missing scenario assertions');
      require(row.data.failed === 0 && row.data.behaviorAssertions > 0 && row.data.pageErrors === 0, 'Scenario failed: ' + row.data.name);
      completed.push(row.data); currentScenario = null;
    }
    if (row.event === 'sandbox_error' || row.event === 'worker_error') require(false, 'Run reported ' + row.event);
  }
  require(currentScenario === null && currentBaseline === null, 'Unfinished stage');
  require(rows.at(-1).event === 'process_exit', 'Missing terminal exit witness');
  if (plan) {
    require(plan.mode === 'full' && plan.built === true && Array.isArray(plan.scenarios) && plan.scenarios.length > 0, 'Not a full built run');
    require(new Set(plan.scenarios || []).size === plan.scenarios?.length, 'Duplicate planned scenario');
    require(Array.isArray(plan.baselines) && plan.baselines.length > 0 && new Set(plan.baselines).size === plan.baselines.length,
      'Invalid baseline plan');
    require(Array.isArray(plan.probes) && plan.probes.length > 0, 'Missing probe plan');
    require(JSON.stringify(starts) === JSON.stringify(plan.scenarios), 'Scenario starts differ from plan');
    require(JSON.stringify(completed.map(item => item.name)) === JSON.stringify(plan.scenarios), 'Scenario completions differ from plan');
    require(JSON.stringify(baselines) === JSON.stringify(plan.baselines), 'Baseline list differs from plan');
    require(begin?.sourceFingerprint === plan.sourceFingerprint && begin?.mode === 'full' && begin?.built === true, 'Source identity mismatch');
    require(scenarioPlan?.hash === plan.scenarioSourceHash && JSON.stringify(scenarioPlan?.names) === JSON.stringify(plan.scenarios), 'Scenario source differs from plan');
    require(JSON.stringify(probes?.names) === JSON.stringify(plan.probes), 'Required browser probes missing');
  }
  require(build?.zipMatchesDirectory === true && build?.runtimeMatchesSource === true && build?.files > 0
    && /^[a-f0-9]{64}$/.test(build?.sha256 || ''), 'Build integrity not verified');
  require(loaded?.commandLineVerified === true && loaded?.extension === build?.directory && !!loaded?.browser,
    'Browser did not load verified build');
  if (finish) {
    const total = completed.reduce((sum, item) => sum + item.assertions, 0);
    require(finish.passed === true && finish.cleanup === true && finish.sourceUnchanged === true, 'Run/cleanup/source check failed');
    require(finish.loadedFrom === 'temporary-build' && finish.mode === 'full', 'Final mode mismatch');
    require(finish.assertions === total && finish.scenarios === completed.length && finish.failedAssertions === 0, 'Final counts mismatch');
    require(finish.unexpectedRequests === 0 && finish.guardErrors === 0, 'Network guard failed');
    require(finish.buildHash === build?.sha256 && finish.sourceFingerprint === plan?.sourceFingerprint, 'Final identity mismatch');
    require(finish.temporaryRoot === temporary?.path, 'Cleanup path differs from created directory');
  }
  require(exit?.code === 0 && exit?.signal === null && exit?.cleanupVerified === true && exit?.portReleased === true && exit?.timedOut === false,
    'No clean independent exit/cleanup witness');
  const incomplete = !finish || !exit || currentScenario !== null || currentBaseline !== null;
  return { passed: errors.length === 0, status: errors.length === 0 ? 'passed' : incomplete ? 'incomplete' : 'failed',
    errors, runId: rows[0].runId, scenarios: completed.length,
    assertions: completed.reduce((sum, item) => sum + item.assertions, 0), buildHash: build?.sha256 };
}
function audit(file) {
  try { return validate(parseJournal(fs.readFileSync(file, 'utf8'))); }
  catch (error) { return { passed: false, status: 'invalid', errors: [error.message] }; }
}
function verifyReceipt(file) {
  const result = audit(file);
  if (!result.passed) return result;
  try {
    const receipt = JSON.parse(fs.readFileSync(file.slice(0, -1), 'utf8'));
    assert.equal(receipt.evidence, path.resolve(file), 'Receipt path mismatch');
    assert.equal(receipt.evidenceSha256, hash(fs.readFileSync(file)), 'Receipt checksum mismatch');
    assert.equal(receipt.runId, result.runId, 'Receipt run mismatch');
    assert.equal(receipt.passed, true, 'Receipt is not passing');
    assert.equal(receipt.observedExit.code, 0, 'Receipt process failed');
    assert.equal(receipt.observedExit.signal, null, 'Receipt process interrupted');
    assert.equal(receipt.cleanupVerified, true, 'Receipt cleanup unverified');
    assert.equal(receipt.portReleased, true, 'Receipt port not released');
    assert.equal(receipt.scenarios, result.scenarios, 'Receipt scenario count differs');
    assert.equal(receipt.assertions, result.assertions, 'Receipt assertion count differs');
    assert.equal(receipt.buildHash, result.buildHash, 'Receipt build differs');
    return result;
  } catch (error) { return { ...result, passed: false, status: 'invalid', errors: [error.message] }; }
}
function releasedPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const server = net.createServer(); let finished = false;
    const end = result => { if (finished) return; finished = true; clearTimeout(timer); server.close(); resolve(result); };
    const timer = setTimeout(() => end(false), 2000);
    server.once('error', () => end(false));
    server.listen(port, '127.0.0.1', () => end(true));
  });
}
function writeReceipt(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function worker(file, runId) {
  assert.equal(path.dirname(path.resolve(file)), ROOT, 'Evidence must be in workspace root');
  assert.ok(FILE_PATTERN.test(path.basename(file)), 'Invalid evidence filename');
  const journal = new Journal(file);
  assert.equal(journal.runId, runId, 'Wrong run evidence');
  // Compact terminal output is not evidence. Detailed stage data is flushed directly to disk.
  const emit = (event, data) => {
    journal.append(event, data);
    if (process.connected && ['baseline_end', 'scenario_end'].includes(event)) process.send({ event, data: { name: data.name || data.file } });
  };
  const disconnect = () => { process.emit('SIGTERM'); };
  const cancel = message => { if (message?.event === 'cancel') process.emit('SIGTERM'); };
  process.on('disconnect', disconnect);
  process.on('message', cancel);
  try {
    const result = await require('./omitone-sandbox.cjs').execute({ mode: 'full', built: true, filter: '', edge: '', timeout: 900000, emit });
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    journal.append('worker_error', { name: error.name || 'Error' }); process.exitCode = 1;
  } finally {
    process.removeListener('disconnect', disconnect); process.removeListener('message', cancel); journal.close();
    if (process.connected) process.disconnect();
  }
}

async function supervise() {
  const sandbox = require('./omitone-sandbox.cjs');
  const plan = sandbox.acceptancePlan();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = stamp + '-' + crypto.randomUUID();
  const file = path.join(ROOT, 'omitone-acceptance-' + runId + '.jsonl');
  const receipt = file.slice(0, -1);
  const journal = new Journal(file, { runId, plan }); journal.close();
  console.log('EVIDENCE=' + file);
  console.log('RECEIPT=' + receipt);
  const child = spawn(process.execPath, [__filename, '--worker', file, runId],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
  let timedOut = false, killTimer, stopping = false;
  const stop = () => {
    if (child.exitCode !== null || stopping) return;
    stopping = true; timedOut = true;
    if (child.connected) child.send({ event: 'cancel' }, () => {});
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => {});
      }
    }, 10000);
  };
  const timer = setTimeout(stop, 18 * 60 * 1000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.on('message', value => {
    if (value?.event === 'baseline_end' || value?.event === 'scenario_end') console.log('[completed] ' + value.data.name);
  });
  const outcome = await new Promise(resolve => {
    child.once('error', () => resolve({ code: null, signal: 'spawn_error' }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(killTimer);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  let cleanupVerified = false, portReleased = false;
  try {
    const rows = parseJournal(fs.readFileSync(file, 'utf8'));
    const finish = rows.find(row => row.event === 'sandbox_finish')?.data;
    const created = rows.find(row => row.event === 'temporary_created')?.data.path;
    const browser = rows.find(row => row.event === 'browser_ready')?.data;
    cleanupVerified = finish?.cleanup === true && typeof created === 'string' && finish.temporaryRoot === created &&
      path.dirname(created) === path.resolve(os.tmpdir()) && path.basename(created).startsWith('omitone-sandbox-') && !fs.existsSync(created);
    portReleased = await releasedPort(browser?.port);
    const witness = new Journal(file);
    try { witness.append('process_exit', { ...outcome, timedOut, cleanupVerified, portReleased }); } finally { witness.close(); }
  } catch (_) { /* Truncated evidence stays invalid. Never repair it into a passing record. */ }
  const result = audit(file);
  writeReceipt(receipt, { schema: SCHEMA, evidence: file, evidenceSha256: hash(fs.readFileSync(file)),
    observedExit: outcome, timedOut, cleanupVerified, portReleased, ...result, recordedAt: new Date().toISOString() });
  console.log('ACCEPTANCE_RESULT ' + JSON.stringify({ ...result, evidence: file, receipt }));
  if (!result.passed) process.exitCode = 1;
  return result;
}

module.exports = { Journal, seal, parseJournal, validate, audit, verifyReceipt, writeReceipt, releasedPort, hash };
if (require.main === module) {
  const args = process.argv.slice(2);
  let action;
  if (args[0] === '--worker' && args.length === 3) action = worker(args[1], args[2]);
  else if (args[0] === '--verify' && args.length === 2) {
    const result = verifyReceipt(path.resolve(args[1])); console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1; action = Promise.resolve();
  } else if (!args.length) action = supervise();
  else action = Promise.reject(new Error('Usage: node omitone-acceptance.cjs [--verify <evidence.jsonl>]'));
  action.catch(error => { console.error('ACCEPTANCE_ERROR: ' + error.message); process.exitCode = 1; });
}