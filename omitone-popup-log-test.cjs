#!/usr/bin/env node
'use strict';

// Real view module, controlled DOM/IO/clock. No network, clipboard or persisted fixtures.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Clock } = require('./omitone-regression.cjs');
const file = path.join(__dirname, 'popup-log-view.js');
const source = fs.readFileSync(file, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = (message, extra = {}) => ({ time: 1700000000000, level: 'info', message, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.value = ''; this.className = ''; this.replacements = 0; }
  set innerHTML(_value) { assert.fail('Unsafe HTML rendering'); }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.value = String(value); this.children = []; }
  get classList() {
    return { contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      } };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key]; }
  appendChild(node) { if (node.tagName === '#fragment') this.children.push(...node.children); else this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.value = ''; nodes.forEach(node => this.appendChild(node)); this.replacements++; }
}
function standalone(text = source) {
  const globals = {};
  for (const name of ['document', 'window', 'chrome', 'navigator', 'fetch', 'setTimeout', 'clearTimeout']) {
    Object.defineProperty(globals, name, { get() { throw new Error('Undeclared dependency: ' + name); } });
  }
  globals.self = globals;
  const context = vm.createContext(globals);
  vm.runInContext(text, context, { filename: file, timeout: 1000 });
  return context.OmitonePopupLogView;
}
function fixture(api, overrides = {}) {
  const clock = new Clock(), panel = new Element('section'), button = new Element('button');
  const state = { logs: [], reads: 0, clears: 0, clipboard: [], notices: [] };
  const document = { createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'),
    createTextNode(value) { const node = new Element('#text'); node.textContent = value; return node; } };
  const dependencies = { document, panel, toggleButton: button, ...clock.globals(), now: () => clock.now,
    version: () => '1.3.0', readLogs: () => { state.reads++; return Promise.resolve(state.logs); },
    clearLogs: () => { state.clears++; state.logs = []; return Promise.resolve({ success: true }); },
    writeClipboard: text => { state.clipboard.push(text); return Promise.resolve(); },
    notify: text => state.notices.push(text), ...overrides };
  const view = api.create(dependencies);
  return { clock, panel, button, state, document, view, dependencies,
    async dispose() { view.dispose(); await tick(); assert.equal(clock.timers.size, 0, 'View timers must be released'); clock.dispose(); } };
}
const tests = [];
const test = (id, name, run) => tests.push({ id, name, run });

test('P01', 'plain-text export keeps compatible header, metadata and chronological order', async api => {
  const text = api.buildLogsText([entry('first', { meta: { count: 2 } }), entry('last', { level: 'warn' })], '9.9.9', 1700000001000);
  assert.ok(text.startsWith('Omitone 诊断日志（版本 9.9.9）\n'));
  assert.ok(text.includes('共 2 条（新的在后）\n---\n'));
  assert.ok(text.includes('[info]') && text.includes('[warn]') && text.includes('{"count":2}'));
  assert.ok(text.indexOf('first') < text.indexOf('last'));
});
test('P02', 'invalid timestamps and malformed records do not break formatting', async api => {
  assert.equal(api.formatTime('invalid'), '--:--:--');
  const text = api.buildLogsText([null, false, entry('valid', { time: 'invalid', level: 'unknown' })], '', 0);
  assert.ok(text.includes('共 1 条') && text.includes('[info] --:--:-- valid'));
  assert.ok(api.buildLogsText(null, '', 0).includes('共 0 条'));
});
test('P03', 'cyclic metadata is displayed as a readable fallback', async api => {
  const cycle = {}; cycle.self = cycle;
  assert.ok(api.buildLogsText([entry('cycle', { meta: cycle })], '', 0).includes('日志详情无法序列化'));
});
test('P04', 'required capabilities are explicit and instance API is immutable', async api => {
  assert.throws(() => api.create({}), /requires DOM/);
  const f = fixture(api);
  try { assert.ok(Object.isFrozen(api) && Object.isFrozen(f.view)); assert.equal(f.state.reads, 0); }
  finally { await f.dispose(); }
});
test('P05', 'open displays newest first without mutating storage array', async api => {
  const f = fixture(api); f.state.logs = [entry('old'), entry('new')];
  try {
    assert.equal(await f.view.open(), true);
    assert.ok(f.panel.classList.contains('show'));
    assert.equal(f.button.getAttribute('aria-expanded'), 'true');
    assert.ok(f.panel.children[0].textContent.includes('new'));
    assert.equal(f.state.logs[0].message, 'old');
  } finally { await f.dispose(); }
});
test('P06', 'message, metadata and level are rendered as inert text', async api => {
  const f = fixture(api), marker = '<b data-log-probe="literal">plain-log</b>';
  f.state.logs = [entry(marker, { level: 'warn" data-injected="1', meta: { detail: '<img src="fixture">' } })];
  try {
    assert.equal(await f.view.open(), true);
    assert.ok(f.panel.textContent.includes(marker));
    assert.ok(f.panel.textContent.includes(JSON.stringify({ detail: '<img src="fixture">' })));
    assert.equal(f.panel.children[0].children[1].className, 'log-level info');
    assert.deepEqual(f.panel.children[0].children.map(node => node.tagName), ['span', 'span', '#text']);
  } finally { await f.dispose(); }
});
test('P07', 'error descriptions are inert text, not HTML', async api => {
  const f = fixture(api, { readLogs: () => Promise.reject(new Error('<b>read failure</b>')) });
  try { assert.equal(await f.view.open(), false); assert.ok(f.panel.textContent.includes('<b>read failure</b>')); }
  finally { await f.dispose(); }
});
test('P08', 'empty storage displays empty-state message', async api => {
  const f = fixture(api);
  try { await f.view.open(); assert.equal(f.panel.textContent, '暂无日志'); }
  finally { await f.dispose(); }
});
test('P09', 'unchanged logs avoid unnecessary DOM replacement', async api => {
  const f = fixture(api); f.state.logs = [entry('same')];
  try { await f.view.open(); const count = f.panel.replacements; await f.view.refresh(); assert.equal(f.panel.replacements, count); }
  finally { await f.dispose(); }
});
test('P10', 'closing during an unfinished open cancels refresh and prevents timer revival', async api => {
  const pending = deferred(), f = fixture(api, { readLogs: () => pending.promise });
  try {
    const opening = f.view.open(); await tick(); f.view.close(); await opening;
    pending.resolve([entry('late')]); await tick(); await f.clock.advance(3000);
    assert.equal(f.panel.classList.contains('show'), false);
    assert.equal(f.panel.replacements, 0);
    assert.equal(f.clock.timers.size, 0);
  } finally { await f.dispose(); }
});
test('P11', 'late older response cannot overwrite newer display', async api => {
  const reads = [], f = fixture(api, { readLogs: () => { const d = deferred(); reads.push(d); return d.promise; } });
  try {
    const a = f.view.open(); await tick(); const b = f.view.refresh(); await tick();
    reads[1].resolve([entry('new-result')]); await b;
    reads[0].resolve([entry('old-result')]); await a; await tick();
    assert.ok(f.panel.textContent.includes('new-result'));
    assert.equal(f.panel.textContent.includes('old-result'), false);
    assert.equal(f.clock.timers.size, 1);
  } finally { await f.dispose(); }
});
test('P12', 'automatic refresh waits for completion instead of overlapping intervals', async api => {
  const reads = [], f = fixture(api, { readLogs: () => { const d = deferred(); reads.push(d); return d.promise; } });
  try {
    const opening = f.view.open(); await tick(); await f.clock.advance(3000); assert.equal(reads.length, 1);
    reads[0].resolve([entry('done')]); await opening;
    await f.clock.advance(1499); assert.equal(reads.length, 1);
    await f.clock.advance(1); assert.equal(reads.length, 2);
    f.view.close(); reads[1].resolve([]); await tick(); assert.equal(f.clock.timers.size, 0);
  } finally { await f.dispose(); }
});
test('P13', 'hanging storage read times out and can be retried', async api => {
  let first = true; const f = fixture(api, { readLogs: () => first ? new Promise(() => {}) : Promise.resolve([entry('recovered')]) });
  try {
    const opening = f.view.open(); await f.clock.settle(opening, 'Read deadline must finish', 5000);
    assert.ok(f.panel.textContent.includes('操作超时')); first = false;
    await f.clock.advance(1500); assert.ok(f.panel.textContent.includes('recovered'));
  } finally { await f.dispose(); }
});
test('P14', 'close then reopen ignores the previous session response', async api => {
  const reads = [], f = fixture(api, { readLogs: () => { const d = deferred(); reads.push(d); return d.promise; } });
  try {
    const first = f.view.open(); await tick(); f.view.close(); const second = f.view.open(); await tick();
    reads[1].resolve([entry('reopened')]); await second; reads[0].resolve([entry('stale')]); await first; await tick();
    assert.ok(f.panel.textContent.includes('reopened')); assert.equal(f.panel.textContent.includes('stale'), false);
  } finally { await f.dispose(); }
});
test('P15', 'successful clear invalidates old read and never resurrects old display', async api => {
  const pending = deferred(), f = fixture(api, { readLogs: () => pending.promise });
  try {
    const opening = f.view.open(); await tick(); assert.equal(await f.view.clear(), true);
    pending.resolve([entry('before-clear')]); await opening; await tick();
    assert.equal(f.panel.textContent, '暂无日志'); assert.ok(f.state.notices.includes('日志已清空'));
  } finally { await f.dispose(); }
});
test('P16', 'clear failure retains existing display and reports failure', async api => {
  const f = fixture(api, { clearLogs: () => Promise.resolve({ success: false }) }); f.state.logs = [entry('keep')];
  try {
    await f.view.open(); assert.equal(await f.view.clear(), false);
    assert.ok(f.panel.textContent.includes('keep')); assert.ok(f.state.notices.at(-1).includes('失败'));
  } finally { await f.dispose(); }
});
test('P17', 'clear operation is single-flight and bounded', async api => {
  let clears = 0; const f = fixture(api, { clearLogs: () => { clears++; return new Promise(() => {}); } });
  try {
    const clearing = f.view.clear(); await tick(); assert.equal(await f.view.clear(), false); assert.equal(clears, 1);
    await f.clock.advance(20000); assert.equal(await clearing, false); assert.ok(f.state.notices.at(-1).includes('失败'));
  } finally { await f.dispose(); }
});
test('P18', 'copy writes compatible text and success notification', async api => {
  const f = fixture(api); f.state.logs = [entry('copy-text', { meta: { x: 1 } })];
  try {
    assert.equal(await f.view.copy(), true); assert.equal(f.state.clipboard.length, 1);
    assert.ok(f.state.clipboard[0].includes('版本 1.3.0') && f.state.clipboard[0].includes('copy-text'));
    assert.equal(f.state.notices.at(-1), '已复制 1 条日志');
    assert.equal(f.panel.classList.contains('show'), false);
  } finally { await f.dispose(); }
});
test('P19', 'empty copy does not touch clipboard', async api => {
  const f = fixture(api);
  try { assert.equal(await f.view.copy(), false); assert.equal(f.state.clipboard.length, 0); assert.equal(f.state.notices.at(-1), '暂无日志'); }
  finally { await f.dispose(); }
});
test('P20', 'copy read rejection reports failure without clipboard attempt', async api => {
  const f = fixture(api, { readLogs: () => Promise.reject(new Error('failed')) });
  try { assert.equal(await f.view.copy(), false); assert.equal(f.state.clipboard.length, 0); assert.equal(f.state.notices.at(-1), '日志读取失败'); }
  finally { await f.dispose(); }
});
test('P21', 'clipboard denial opens safe manual-copy fallback', async api => {
  const f = fixture(api, { writeClipboard: () => Promise.reject(new Error('denied')) }); f.state.logs = [entry('<b>fallback</b>')];
  try {
    assert.equal(await f.view.copy(), false); assert.ok(f.panel.classList.contains('show'));
    assert.ok(f.panel.textContent.includes('<b>fallback</b>')); assert.equal(f.button.getAttribute('aria-expanded'), 'true');
    assert.ok(f.state.notices.at(-1).includes('手动选中'));
  } finally { await f.dispose(); }
});
test('P22', 'clipboard hang is bounded and falls back to displayed text', async api => {
  const f = fixture(api, { writeClipboard: () => new Promise(() => {}) }); f.state.logs = [entry('clipboard-hang')];
  try {
    const copying = f.view.copy(); await tick(); await f.clock.advance(5000); assert.equal(await copying, false);
    assert.ok(f.panel.textContent.includes('clipboard-hang')); assert.ok(f.panel.classList.contains('show'));
  } finally { await f.dispose(); }
});
test('P23', 'closing while clipboard pending never reopens panel on rejection', async api => {
  const pending = deferred(), f = fixture(api, { writeClipboard: () => pending.promise }); f.state.logs = [entry('copy')];
  try {
    await f.view.open(); const copying = f.view.copy(); await tick(); f.view.close(); pending.reject(new Error('denied'));
    await copying; assert.equal(f.panel.classList.contains('show'), false); assert.equal(f.clock.timers.size, 0);
  } finally { await f.dispose(); }
});
test('P24', 'clear invalidates copy-in-flight before clipboard invocation', async api => {
  const pending = deferred(), f = fixture(api, { readLogs: () => pending.promise });
  try {
    const copying = f.view.copy(); await tick(); await f.view.clear(); pending.resolve([entry('obsolete')]); await copying;
    assert.equal(f.state.clipboard.length, 0);
  } finally { await f.dispose(); }
});
test('P25', 'dispose cancels unfinished reads and all timers without late notifications', async api => {
  const pending = deferred(), f = fixture(api, { readLogs: () => pending.promise });
  const opening = f.view.open(); const copying = f.view.copy(); await tick(); f.view.dispose();
  await Promise.all([opening, copying]); pending.resolve([entry('late')]); await tick();
  assert.equal(f.clock.timers.size, 0); assert.equal(f.state.notices.length, 0); assert.equal(f.panel.replacements, 0);
  assert.equal(await f.view.open(), false); assert.equal(await f.view.copy(), false); await f.dispose();
});
test('P26', 'independent view instances do not share timers or panel state', async api => {
  const a = fixture(api), b = fixture(api); a.state.logs = [entry('A')]; b.state.logs = [entry('B')];
  try { await a.view.open(); await b.view.open(); a.view.close(); assert.equal(a.clock.timers.size, 0); assert.equal(b.clock.timers.size, 1); assert.ok(b.panel.textContent.includes('B')); }
  finally { await a.dispose(); await b.dispose(); }
});
test('P27', 'version provider failure does not prevent copying logs', async api => {
  const f = fixture(api, { version: () => { throw new Error('extension gone'); } }); f.state.logs = [entry('still-readable')];
  try { assert.equal(await f.view.copy(), true); assert.ok(f.state.clipboard[0].startsWith('Omitone 诊断日志\n')); }
  finally { await f.dispose(); }
});

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test wall-clock timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}
function mutateOnce(text, anchor, replacement) {
  // Only VM copies are normalized. The on-disk source/hash stays byte-for-byte intact.
  const normalized = text.replace(/\r\n/g, '\n');
  const target = anchor.replace(/\r\n/g, '\n');
  assert.equal(normalized.split(target).length, 2, 'Mutation anchor must be unique');
  const changed = normalized.replace(target, replacement.replace(/\r\n/g, '\n'));
  assert.notEqual(changed, normalized, 'Mutation must change the target');
  return text.includes('\r\n') ? changed.replace(/\n/g, '\r\n') : changed;
}
async function main() {
  const api = standalone(); assert.equal(typeof require(file).create, 'function');
  for (const spec of tests) { await bounded(spec.run(api)); console.log('[PASS] ' + spec.id + ' ' + spec.name); }
  const controls = [
    ['P06', 'node.textContent = text;', 'node.innerHTML = text;', error => /Unsafe HTML rendering/.test(error.message)],
    ['P09', 'if (nextSignature === signature) return;', 'if (false) return;', error => error.expected === 1 && error.actual === 2],
    ['P13', 'operation(readLogs, 5000); activeRead', 'operation(readLogs, 1000000); activeRead', error => /Read deadline must finish/.test(error.message)],
    ['P21', "if (!opened) { epoch++; visibility(true); }\n          render(logs);", 'if (!opened) { epoch++; visibility(false); }\n          render(logs);', error => /f\.panel\.classList\.contains/.test(error.message)]
  ];
  assert.throws(() => mutateOnce('one', 'missing', 'x'), /unique/);
  assert.throws(() => mutateOnce('one one', 'one', 'x'), /unique/);
  for (const eol of ['\n', '\r\n']) {
    const original = source.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    for (const [id, anchor, replacement, expectedFailure] of controls) {
      const spec = tests.find(item => item.id === id);
      await bounded(spec.run(standalone(original))); // Same EOL + real behavior passes first.
      const changed = mutateOnce(original, anchor, replacement);
      assert.equal(changed.includes('\r\n'), eol === '\r\n', 'VM mutation preserves line-ending style');
      const mutant = standalone(changed); // Parse/setup failures cannot count as a caught regression.
      await assert.rejects(bounded(spec.run(mutant)), error => error.code === 'ERR_ASSERTION' && expectedFailure(error));
      console.log('[NEGATIVE CONTROL] ' + id + ' ' + (eol === '\n' ? 'LF' : 'CRLF'));
    }
  }
  assert.equal(hash(fs.readFileSync(file)), hash(source));
  console.log('POPUP_LOG_TEST_REPORT ' + JSON.stringify({ passed: true, cases: tests.length, negativeControls: controls.length * 2,
    lineEndings: ['LF', 'CRLF'], mutationAnchorGuards: 2, sourceUnchanged: true, sourceHash: hash(source) }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });