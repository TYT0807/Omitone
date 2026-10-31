#!/usr/bin/env node
'use strict';

/**
 * 1.3.0 实验线：字体缓存、加载恢复、多标签页日志的持久化回归闸门。
 * Node 内置模块，无网络、无文件写入、无真实凭据。不改生产源码。
 * 默认断言正确行为；已知缺陷仍返回 exit 1，绝不以复现成功代替产品通过。
 * --list | --self-test | --group font|load|logs | --case F01 | --root <绝对路径>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const RECOVERY_BUDGET = 120000; // 虚拟毫秒：测试约定，不是声称现有代码有该超时。
const EXTENSION = 'regression-extension';
const ENCODED = ['\ue001', '\ue002'];
const PLAIN = { 1: ['甲', '乙'], 2: ['丙', '丁'] };
const turn = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value === undefined ? undefined : structuredClone(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const cleanError = error => String(error?.message || error).replace(/\u001b\[[0-9;]*m/g, '');

class HarnessError extends Error {
  constructor(message) { super(message); this.name = 'HarnessError'; this.code = 'REGRESSION_HARNESS_ERROR'; }
}

function parseArgs(argv) {
  const out = { root: __dirname, group: '', id: '', mode: 'test' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list' || arg === '--self-test') out.mode = arg.slice(2);
    else if (['--root', '--group', '--case'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing argument: ' + arg);
      if (arg === '--root') out.root = value;
      if (arg === '--group') out.group = value;
      if (arg === '--case') out.id = value;
    } else throw new Error('Unknown argument: ' + arg);
  }
  if (!path.isAbsolute(out.root)) throw new Error('--root must be absolute');
  if (out.group && !['font', 'load', 'logs'].includes(out.group)) throw new Error('Unknown group');
  return out;
}

class SourceTree {
  constructor(root) { this.root = path.resolve(root); this.files = new Map(); }
  read(relative) {
    const absolute = path.resolve(this.root, relative);
    const rel = path.relative(this.root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Source path escaped root');
    if (!this.files.has(rel)) this.files.set(rel, fs.readFileSync(absolute));
    return this.files.get(rel).toString('utf8');
  }
  verify() {
    for (const [relative, bytes] of this.files) {
      assert.equal(sha256(fs.readFileSync(path.join(this.root, relative))), sha256(bytes), 'Source changed during tests: ' + relative);
    }
  }
  hashes() { return Object.fromEntries([...this.files].map(([key, bytes]) => [key.replaceAll('\\', '/'), sha256(bytes)])); }
}

/** Advance actual scheduled callbacks, not wall time. Every step drains real microtasks. */
class Clock {
  constructor() { this.now = 1800000000000; this.seq = 0; this.timers = new Map(); this.closed = false; }
  set(fn, ms = 0, repeat = false, args = []) {
    if (this.closed) return 0;
    if (typeof fn !== 'function') throw new Error('String timers are unsupported');
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, repeat, ms, args });
    return id;
  }
  async advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new HarnessError('Invalid virtual clock duration');
    const end = this.now + ms;
    await turn();
    for (let count = 0; ; count++) {
      const next = [...this.timers].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) { this.now = end; await turn(); return; }
      if (count > 10000) throw new HarnessError('Harness timer runaway');
      const [id, task] = next;
      this.now = task.at; this.timers.delete(id);
      if (task.repeat) this.timers.set(id, { ...task, at: this.now + Math.max(1, task.ms) });
      task.fn(...task.args); await turn();
    }
  }
  async settle(promise, label, budget = RECOVERY_BUDGET) {
    let done = false, value, failure;
    Promise.resolve(promise).then(result => { value = result; done = true; }, error => { failure = error; done = true; });
    const end = this.now + budget;
    await turn();
    while (!done && this.now < end) {
      const next = Math.min(end, ...[...this.timers.values()].map(task => task.at));
      await this.advance(Math.max(0, next - this.now));
    }
    assert.ok(done, label + ': did not settle within ' + budget + ' virtual ms');
    if (failure) throw failure;
    return value;
  }
  globals() {
    const clock = this;
    class VirtualDate extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    }
    return { Date: VirtualDate,
      setTimeout: (fn, ms, ...args) => clock.set(fn, ms, false, args),
      clearTimeout: id => clock.timers.delete(id),
      setInterval: (fn, ms, ...args) => clock.set(fn, ms, true, args),
      clearInterval: id => clock.timers.delete(id) };
  }
  dispose() { this.closed = true; this.timers.clear(); }
}

function documentFixture(font = 1) {
  const listeners = new Map(), roots = [], attrs = new Map();
  const document = {
    readyState: 'loading', roots, font,
    documentElement: { setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key), removeAttribute: key => attrs.delete(key) },
    body: { innerText: '', appendChild() {} }, head: { appendChild() {} },
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
    querySelector() { return null; }, getElementById() { return null; },
    querySelectorAll(selector) {
      if (selector === 'style') return document.font == null ? [] : [{ textContent:
        '@font-face{font-family:font-cxsecret;src:url(data:font/ttf;base64,' + Buffer.from([document.font]).toString('base64') + ')}' }];
      if (selector === '.font-cxsecret') return roots.filter(root => root.classList.contains('font-cxsecret'));
      return [];
    },
    createElement() { return { style: {}, setAttribute() {}, remove() {}, addEventListener() {} }; },
    createTreeWalker(root) { let read = false; return { nextNode() { if (read) return null; read = true; return root.textNode; } }; },
    add(text, attributes = {}) {
      const classes = new Set(['font-cxsecret']);
      const root = { textNode: { nodeValue: text }, ownerDocument: document, parentElement: null,
        get textContent() { return this.textNode.nodeValue; },
        hasAttribute: key => Object.hasOwn(attributes, key), getAttribute: key => attributes[key],
        setAttribute: (key, value) => { attributes[key] = value; }, querySelectorAll: () => [],
        classList: { contains: value => classes.has(value), remove: value => classes.delete(value) } };
      roots.push(root); return root;
    }
  };
  return document;
}

function glyphPath(font, glyph) { return { cmds: ['M'], crds: [font, glyph] }; }
function glyphHash(font, glyph) { return crypto.createHash('md5').update(JSON.stringify(glyphPath(font, glyph))).digest('hex').slice(24); }
function tableFixture() {
  const result = {};
  for (const font of [1, 2]) ENCODED.forEach((char, i) => { result[glyphHash(font, char.codePointAt(0))] = PLAIN[font][i].codePointAt(0); });
  return result;
}

/** Browser storage copies values across boundaries. Capturing at get time makes races deterministic. */
class BrowserState {
  constructor(clock) {
    this.clock = clock; this.local = { runtimeLogs: [], config: {} }; this.session = {};
    this.tabs = new Map(); this.trace = []; this.fault = null;
  }
  area(name, runtime, owner) {
    const store = this[name];
    const callback = (cb, result, fault) => queueMicrotask(() => {
      if (fault === 'hang') return;
      runtime.lastError = fault === 'error' ? { message: 'controlled storage failure' } : null;
      try { if (cb) cb(clone(result)); } finally { runtime.lastError = null; }
    });
    const faultFor = (op, key) => {
      if (this.fault && this.fault.op === op && this.fault.key === key && (!this.fault.owner || this.fault.owner === owner)) {
        const result = this.fault.kind; this.fault = null; return result;
      }
      return null;
    };
    return {
      get: (key, cb) => {
        const result = {};
        if (typeof key === 'string') result[key] = clone(store[key]);
        else if (Array.isArray(key)) key.forEach(k => { result[k] = clone(store[k]); });
        else Object.assign(result, clone(store));
        const fault = faultFor('get', key);
        this.trace.push({ owner, op: 'get', key, count: result.runtimeLogs?.length, fault });
        callback(cb, result, fault);
      },
      set: (values, cb) => {
        const captured = clone(values), key = Object.keys(captured)[0], fault = faultFor('set', key);
        this.trace.push({ owner, op: 'set', key, count: captured.runtimeLogs?.length, fault });
        queueMicrotask(() => { if (!fault) Object.assign(store, captured); callback(cb, undefined, fault); });
      },
      remove: (key, cb) => { delete store[key]; callback(cb); },
      clear: cb => { Object.keys(store).forEach(key => delete store[key]); callback(cb); }
    };
  }
}

function contextBase(clock) {
  const context = vm.createContext({ ...clock.globals(), URL, AbortController, TextDecoder, TextEncoder,
    Uint8Array, ArrayBuffer, DataView, console: { log() {}, info() {}, warn() {}, error() {} },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64') });
  context.self = context;
  return context;
}

function exposeFontHooks(source) {
  const footer = /\}\)\(\);\s*$/;
  assert.ok(footer.test(source), 'content IIFE boundary changed; update test adapter');
  return source.replace(footer, 'globalThis.__regressionFont = Object.freeze({' +
    'getDecryptTable, buildDecryptMapForDoc, decryptSecretFontsInDocument});\n})();');
}

function createWorld(tree, transform = source => source) {
  const transformFile = (file, source) => typeof transform === 'function'
    ? (file === 'content.js' ? transform(source) : source)
    : (transform[file] ? transform[file](source) : source);
  const clock = new Clock(), browser = new BrowserState(clock), failures = [], contexts = [];
  const worker = contextBase(clock); let workerListener;
  worker.chrome = { runtime: { id: EXTENSION, lastError: null, getURL: p => 'chrome-extension://' + EXTENSION + '/' + p,
    onMessage: { addListener(fn) { workerListener = fn; } } }, storage: {},
    tabs: { get(id, cb) { queueMicrotask(() => cb(clone(browser.tabs.get(id)))); },
      onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } } };
  worker.chrome.storage.local = browser.area('local', worker.chrome.runtime, 'worker');
  worker.chrome.storage.session = browser.area('session', worker.chrome.runtime, 'worker');
  worker.fetch = () => { failures.push('Unexpected worker network'); return Promise.reject(new Error('Network forbidden')); };
  worker.importScripts = (...files) => files.forEach(file => vm.runInContext(transformFile(file, tree.read(file)), worker, { filename: file, timeout: 1000 }));
  vm.runInContext(transformFile('background.js', tree.read('background.js')), worker, { filename: 'background.js', timeout: 1000 });
  assert.equal(typeof workerListener, 'function', 'Actual worker did not install message handler');

  function createTab({ url = 'https://mooc1.chaoxing.com/course', font = 1, transport } = {}) {
    const id = contexts.length + 1, context = contextBase(clock), document = documentFixture(font);
    contexts.push(context); browser.tabs.set(id, { id, url, active: true });
    const listeners = new Map(), posted = [], calls = [], glyphCalls = [];
    const fontState = { available: true };
    context.window = context; context.top = context; context.parent = context;
    context.location = { href: url }; context.document = document;
    context.history = { pushState() {}, replaceState() {} };
    context.NodeFilter = { SHOW_TEXT: 4 };
    context.MutationObserver = class { observe() {} disconnect() {} };
    context.addEventListener = (type, fn) => { listeners.set(type, fn); };
    context.removeEventListener = () => {};
    context.postMessage = message => { posted.push(clone(message)); };
    const runtime = { id: EXTENSION, lastError: null, getURL: p => 'chrome-extension://' + EXTENSION + '/' + p,
      getManifest: () => JSON.parse(tree.read('manifest.json')), onMessage: { addListener() {} },
      sendMessage(message, cb) {
        const sender = { id: EXTENSION, frameId: 0, url: context.location.href, tab: { id, url: context.location.href } };
        workerListener(clone(message), sender, value => queueMicrotask(() => cb && cb(clone(value))));
      } };
    context.chrome = { runtime, storage: { local: browser.area('local', runtime, 'tab-' + id),
      session: browser.area('session', runtime, 'tab-' + id), onChanged: { addListener() {} } } };
    const manifest = JSON.parse(tree.read('manifest.json'));
    const files = manifest.content_scripts[0].js;
    for (const file of files) {
      if (file === 'content.js' || file === 'libs/Typr.js' || file === 'libs/Typr.U.js') continue;
      vm.runInContext(tree.read(file), context, { filename: file, timeout: 1000 });
    }
    assert.ok(files.includes('content.js') && context.OmitoneFontTable && context.OmitonePolicy && typeof context.md5 === 'function', 'Manifest dependencies incomplete');
    context.Typr = { parse(buffer) { return fontState.available ? [{ id: new Uint8Array(buffer)[0] }] : []; }, U: {
      codeToGlyph(_font, cp) { return ENCODED.some(char => char.codePointAt(0) === cp) ? cp : 0; },
      glyphToPath(fontObject, cp) { glyphCalls.push([fontObject.id, cp]); return glyphPath(fontObject.id, cp); }
    } };
    const entries = tableFixture();
    const binary = context.OmitoneFontTable.encode(entries);
    const response = type => type === 'bin'
      ? { ok: true, arrayBuffer: async () => binary.slice(0) }
      : { ok: true, json: async () => clone(entries) };
    context.fetch = (url, options) => {
      const kind = String(url).endsWith('/resources/table.bin') ? 'bin' : String(url).endsWith('/resources/table.json') ? 'json' : '';
      if (!kind || !String(url).startsWith('chrome-extension://' + EXTENSION + '/')) {
        failures.push('Unexpected content network'); return Promise.reject(new Error('Network forbidden'));
      }
      calls.push({ kind, signal: options?.signal });
      return Promise.resolve().then(() => transport ? transport(kind, response, calls.length, options) : response(kind));
    };
    vm.runInContext(exposeFontHooks(transformFile('content.js', tree.read('content.js'))), context, { filename: 'content.js', timeout: 1000 });
    const hooks = context.__regressionFont;
    assert.ok(hooks && typeof listeners.get('message') === 'function', 'Content test adapter not attached');
    const innerWindow = vm.runInContext('window', context);
    return { context, hooks, document, calls, glyphCalls, fontState, entries, response,
      async decrypt(doc = document) { return clock.settle(hooks.decryptSecretFontsInDocument(doc), 'Font decryption'); },
      async table() { return clock.settle(hooks.getDecryptTable(), 'Font table load'); },
      log(message) { return listeners.get('message')({ source: innerWindow, data: { source: 'xxt_app', type: 'runtime_log', message, level: 'info' } }); },
      posted, newDocument: documentFixture };
  }
  function tab(options) {
    try { return createTab(options); }
    catch (error) { throw new HarnessError('Content tab setup: ' + cleanError(error)); }
  }
  const popupSender = { id: EXTENSION, frameId: 0, url: 'chrome-extension://' + EXTENSION + '/popup/popup.html' };
  return { clock, browser, tab, failures,
    sendWorker(message, sender = popupSender) {
      return new Promise(resolve => workerListener(clone(message), sender, value => resolve(clone(value))));
    }, async dispose() {
    clock.dispose(); await turn();
    if (failures.length) throw new HarnessError(failures.join('; '));
  } };
}

const CASES = [];
function test(id, group, name, run) { CASES.push({ id, group, name, run }); }
function texts(roots) { return roots.map(root => root.textContent); }
function messages(world) { return (world.browser.local.runtimeLogs || []).map(item => item.message); }
async function drain(world) { await world.clock.advance(0); }

test('F01', 'font', '正常字体：文本、属性和明文混合内容正确转换', async w => {
  const t = w.tab(); const root = t.document.add('ASCII ' + ENCODED.join(''), { title: ENCODED[0] });
  await t.decrypt();
  assert.equal(root.textContent, 'ASCII 甲乙'); assert.equal(root.getAttribute('title'), '甲');
  assert.equal(root.classList.contains('font-cxsecret'), false);
});
test('F02', 'font', '同一字体动态新增字符后继续解码', async w => {
  const t = w.tab(); const first = t.document.add(ENCODED[0]);
  await t.decrypt(); assert.equal(first.textContent, '甲', 'First batch must really decode');
  const next = t.document.add(ENCODED.join(''));
  await t.decrypt(); assert.equal(next.textContent, '甲乙', 'Cached font must supplement the newly encountered character');
});
test('F03', 'font', '同字体的另一份文档新增字符不受旧缓存限制', async w => {
  const t = w.tab(); t.document.add(ENCODED[0]); await t.decrypt();
  const other = t.newDocument(1), root = other.add(ENCODED[1]);
  await t.decrypt(other); assert.equal(root.textContent, '乙', 'Same-font document must not inherit an incomplete character map');
});
test('F04', 'font', '重复扫描已知字符不重复计算字形', async w => {
  const t = w.tab(); t.document.add(ENCODED.join('')); await t.decrypt();
  const calls = t.glyphCalls.length; assert.equal(calls, 2);
  const root = t.document.add(ENCODED.join('')); await t.decrypt();
  assert.equal(root.textContent, '甲乙'); assert.equal(t.glyphCalls.length, calls);
});
test('F05', 'font', '不同字体的相同编码字符互不串映射', async w => {
  const t = w.tab(); const a = t.document.add(ENCODED[0]); await t.decrypt();
  const other = t.newDocument(2), b = other.add(ENCODED[0]); await t.decrypt(other);
  assert.deepEqual(texts([a, b]), ['甲', '丙']);
});
test('F06', 'font', '映射表暂时不可用不能永久缓存空映射', async w => {
  const t = w.tab(), root = t.document.add(ENCODED[0]);
  const key = Buffer.from([1]).toString('base64');
  const failed = t.hooks.buildDecryptMapForDoc(t.document, key, null, [root]);
  assert.equal(failed.size, 0, 'Fixture must reach missing-table branch');
  await t.decrypt(); assert.equal(root.textContent, '甲', 'Valid table must recover the same font after temporary failure');
});
test('F07', 'font', '字体解析暂时失败后同一字体可以恢复', async w => {
  const t = w.tab(), root = t.document.add(ENCODED[0]);
  t.fontState.available = false; await t.decrypt();
  assert.equal(root.textContent, ENCODED[0]);
  assert.equal(root.classList.contains('font-cxsecret'), true, 'Failure must preserve undecoded marker');
  t.fontState.available = true; await w.clock.advance(RECOVERY_BUDGET); await t.decrypt();
  assert.equal(root.textContent, '甲', 'Parser recovery must not be blocked by cached failure');
});

test('L01', 'load', '二进制映射表成功加载且后续复用', async w => {
  const t = w.tab(), table = await t.table();
  assert.equal(table.get(glyphHash(1, ENCODED[0].codePointAt(0))), '甲');
  await t.table(); assert.deepEqual(t.calls.map(call => call.kind), ['bin']);
});
test('L02', 'load', '二进制资源缺失时回退到 JSON', async w => {
  const t = w.tab({ transport: (kind, good) => kind === 'bin' ? { ok: false } : good(kind) });
  const root = t.document.add(ENCODED[0]); await t.decrypt();
  assert.equal(root.textContent, '甲'); assert.deepEqual(t.calls.map(call => call.kind), ['bin', 'json']);
});
test('L03', 'load', '二进制内容损坏时回退到 JSON', async w => {
  const t = w.tab({ transport: (kind, good) => kind === 'bin' ? { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } : good(kind) });
  const root = t.document.add(ENCODED[1]); await t.decrypt();
  assert.equal(root.textContent, '乙'); assert.ok(t.calls.some(call => call.kind === 'json'));
});
test('L04', 'load', '并发调用共享一次成功加载', async w => {
  let release;
  const t = w.tab({ transport: (kind, good) => new Promise(resolve => { release = () => resolve(good(kind)); }) });
  const pending = Array.from({ length: 8 }, () => t.hooks.getDecryptTable());
  await drain(w); assert.equal(t.calls.length, 1, 'Concurrent load must not fan out');
  release(); const results = await w.clock.settle(Promise.all(pending), 'Shared load');
  assert.ok(results.every(table => table.get(glyphHash(1, ENCODED[0].codePointAt(0))) === '甲'));
});
test('L05', 'load', '两种资源失败后恢复服务可以重新加载', async w => {
  let healthy = false;
  const t = w.tab({ transport: (kind, good) => healthy ? good(kind) : Promise.reject(new Error('Temporary resource failure')) });
  const root = t.document.add(ENCODED[0]); await t.decrypt();
  assert.equal(root.textContent, ENCODED[0]);
  assert.ok(t.calls.some(call => call.kind === 'bin') && t.calls.some(call => call.kind === 'json'));
  const before = t.calls.length; healthy = true;
  await w.clock.advance(RECOVERY_BUDGET); await t.decrypt();
  assert.equal(root.textContent, '甲', 'Previously failed load must retry after recovery budget; fetches=' + t.calls.length);
  assert.ok(t.calls.length > before, 'Recovery must perform a new resource load');
});
test('L06', 'load', '二进制请求头永久挂起仍能回退 JSON', async w => {
  const t = w.tab({ transport: (kind, good) => kind === 'bin' ? new Promise(() => {}) : good(kind) });
  const root = t.document.add(ENCODED[0]); await t.decrypt();
  assert.equal(root.textContent, '甲'); assert.ok(t.calls.some(call => call.kind === 'json'));
});
test('L07', 'load', '二进制响应体永久挂起仍能回退 JSON', async w => {
  const t = w.tab({ transport: (kind, good) => kind === 'bin'
    ? { ok: true, arrayBuffer: () => new Promise(() => {}) } : good(kind) });
  const root = t.document.add(ENCODED[0]); await t.decrypt();
  assert.equal(root.textContent, '甲'); assert.ok(t.calls.some(call => call.kind === 'json'));
});
test('L08', 'load', '资源都失败时有界结束并保留原文和标记', async w => {
  const t = w.tab({ transport: () => Promise.reject(new Error('Both sources failed')) });
  const root = t.document.add(ENCODED.join('')); await t.decrypt();
  assert.equal(root.textContent, ENCODED.join('')); assert.ok(root.classList.contains('font-cxsecret'));
});
test('L09', 'load', '二进制响应体拒绝时回退 JSON', async w => {
  const t = w.tab({ transport: (kind, good) => kind === 'bin'
    ? { ok: true, arrayBuffer: () => Promise.reject(new Error('Broken stream')) } : good(kind) });
  const root = t.document.add(ENCODED[0]); await t.decrypt(); assert.equal(root.textContent, '甲');
});
test('L10', 'load', 'JSON 响应体挂起必须有界失败且不破坏原文', async w => {
  const t = w.tab({ transport: kind => kind === 'bin' ? { ok: false }
    : { ok: true, json: () => new Promise(() => {}) } });
  const root = t.document.add(ENCODED[0]); await t.decrypt();
  assert.equal(root.textContent, ENCODED[0]); assert.ok(root.classList.contains('font-cxsecret'));
});

test('G01', 'logs', '单标签连续日志保序且保留时间和级别', async w => {
  const t = w.tab(); await t.log('one'); await t.log('two'); await drain(w);
  assert.deepEqual(messages(w), ['one', 'two']);
  assert.ok(w.browser.local.runtimeLogs.every(item => item.level === 'info' && item.time === w.clock.now));
});
test('G02', 'logs', '两个标签并发写入都保留', async w => {
  const a = w.tab(), b = w.tab();
  await Promise.all([a.log('tab-a'), b.log('tab-b')]); await drain(w);
  assert.deepEqual(messages(w).sort(), ['tab-a', 'tab-b'], 'Lost concurrent log; trace=' + JSON.stringify(w.browser.trace.filter(x => x.key === 'runtimeLogs')));
});
test('G03', 'logs', '三标签多轮突发写入不丢日志', async w => {
  const tabs = [w.tab(), w.tab(), w.tab()], expected = [];
  for (let round = 0; round < 5; round++) {
    const batch = tabs.map((t, i) => { const message = i + ':' + round; expected.push(message); return t.log(message); });
    await Promise.all(batch); await drain(w);
  }
  assert.deepEqual(messages(w).sort(), expected.sort(), 'Every message below the 200-entry limit must survive');
});
test('G04', 'logs', '200 条容量边界保留最新日志', async w => {
  w.browser.local.runtimeLogs = Array.from({ length: 200 }, (_, i) => ({ message: 'old-' + i }));
  const t = w.tab(); await t.log('new'); await drain(w);
  assert.equal(messages(w).length, 200); assert.equal(messages(w)[0], 'old-1'); assert.equal(messages(w).at(-1), 'new');
});
test('G05', 'logs', '普通外站不能写入运行日志', async w => {
  const t = w.tab({ url: 'https://untrusted.invalid/' }); await t.log('not-allowed'); await drain(w);
  assert.deepEqual(messages(w), []);
  assert.equal(w.browser.trace.some(x => x.key === 'runtimeLogs'), false);
});
test('G06', 'logs', '一次存储读取错误不堵住后续日志', async w => {
  const t = w.tab(); w.browser.fault = { op: 'get', key: 'runtimeLogs', kind: 'error' };
  await t.log('may-fail'); await drain(w); await t.log('recovered'); await drain(w);
  assert.ok(messages(w).includes('recovered'));
  assert.ok(w.browser.trace.some(x => x.fault === 'error'), 'Fault injection must actually execute');
});
test('G07', 'logs', '存储读取回调挂起后队列有界恢复', async w => {
  const t = w.tab(); w.browser.fault = { op: 'get', key: 'runtimeLogs', kind: 'hang' };
  await t.log('stalled'); await drain(w);
  assert.ok(w.browser.trace.some(x => x.fault === 'hang'), 'Fault injection must actually execute');
  await w.clock.advance(RECOVERY_BUDGET); await t.log('recovered'); await w.clock.advance(RECOVERY_BUDGET);
  assert.ok(messages(w).includes('recovered'), 'One missing get callback must not freeze later log writes');
});
test('G08', 'logs', '存储写入回调挂起后队列有界恢复', async w => {
  const t = w.tab(); w.browser.fault = { op: 'set', key: 'runtimeLogs', kind: 'hang' };
  await t.log('stalled'); await drain(w);
  assert.ok(w.browser.trace.some(x => x.fault === 'hang'), 'Fault injection must actually execute');
  await w.clock.advance(RECOVERY_BUDGET); await t.log('recovered'); await w.clock.advance(RECOVERY_BUDGET);
  assert.ok(messages(w).includes('recovered'), 'One missing set callback must not freeze later log writes');
});
test('G09', 'logs', '新页面实例追加日志不抹掉旧记录', async w => {
  await w.tab().log('before-reload'); await drain(w);
  await w.tab().log('after-reload'); await drain(w);
  assert.deepEqual(messages(w), ['before-reload', 'after-reload']);
});
test('G10', 'logs', '两个标签并发追加不覆盖已有记录', async w => {
  w.browser.local.runtimeLogs = [{ message: 'existing' }];
  const a = w.tab(), b = w.tab(); await Promise.all([a.log('a'), b.log('b')]); await drain(w);
  assert.deepEqual(messages(w).sort(), ['a', 'b', 'existing']);
});

async function runCase(tree, spec, transform) {
  let world;
  try { world = createWorld(tree, transform); }
  catch (error) { throw new HarnessError('World setup: ' + cleanError(error)); }
  let timer;
  try {
    await Promise.race([spec.run(world), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HarnessError('Harness wall-clock timeout: ' + spec.id)), 8000);
    })]);
  } catch (error) {
    // Normal behavior assertions use the host assert module. Missing adapters, invalid
    // source, syntax errors and wall-time timeouts must not masquerade as product failures.
    if (error?.code === 'ERR_ASSERTION') throw error;
    throw new HarnessError(spec.id + ': ' + cleanError(error));
  } finally { clearTimeout(timer); await world.dispose(); }
}

function mutateOnce(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, 'Mutation anchor must exist exactly once');
  const changed = source.replace(anchor, replacement);
  assert.notEqual(changed, source, 'Mutation must change VM source');
  return changed;
}

async function selfTest(tree) {
  let count = 0;
  function ok(name) { count++; console.log('[self ok] ' + name); }
  const clock = new Clock(); let fired = false;
  clock.set(() => { fired = true; }, 20); await clock.advance(19); assert.equal(fired, false);
  await clock.advance(1); assert.equal(fired, true); clock.dispose(); ok('virtual clock boundary');
  const hanging = new Clock();
  await assert.rejects(hanging.settle(new Promise(() => {}), 'test', 10), /did not settle/);
  hanging.dispose(); ok('non-settling promise is a failure, not a skipped test');
  assert.throws(() => mutateOnce('a a', 'a', 'b')); assert.throws(() => mutateOnce('a', 'missing', 'b'));
  ok('missing or duplicate mutation anchors rejected');
  const controls = [
    ['F01', 'glyph mapping removed', 'content.js', 'const decoded = table.get(hash);', "const decoded = '';", 'ASCII 甲乙'],
    ['F02', 'new characters ignored', 'content.js', 'if (checked.has(char)) return;', 'if (checked.size) return;', '甲乙'],
    ['L02', 'JSON fallback removed', 'content.js', 'const table = FONT_TABLE.fromObject(data);', 'const table = null;', '甲'],
    ['L05', 'failure cached permanently', 'content.js', '          decryptTablePromise = null;', '          void 0;', '甲'],
    ['L06', 'resource timeout disabled', 'content.js', '}, DECRYPT_FETCH_TIMEOUT_MS);', '}, 1000000);', true],
    ['G01', 'log append removed', 'runtime-log-store.js', 'logs.push(item);', 'void item;', ['one', 'two']],
    ['G02', 'global serialization removed', 'runtime-log-store.js', 'var task = logQueue.then(function () {', 'var task = Promise.resolve().then(function () {', ['tab-a', 'tab-b']],
    ['G04', 'capacity bound removed', 'runtime-log-store.js', 'var nextLogs = logs.slice(-MAX_LOGS);', 'var nextLogs = logs;', 200]
  ];
  for (const [id, name, file, anchor, replacement, expected] of controls) {
    const spec = CASES.find(item => item.id === id);
    await runCase(tree, spec); ok(id + ' normal control');
    // Validate outside assert.rejects: an invalid mutation must fail self-test itself.
    const source = tree.read(file), mutated = mutateOnce(source, anchor, replacement);
    let applied = false;
    await assert.rejects(runCase(tree, spec, { [file]: current => {
      assert.equal(current, source, 'Mutation targets the inspected source');
      applied = true; return mutated;
    } }), error => error?.code === 'ERR_ASSERTION' && JSON.stringify(error.expected) === JSON.stringify(expected),
    'Known fault must break the specific behavior assertion');
    assert.equal(applied, true, 'Mutated content must actually execute');
    ok(id + ' catches ' + name);
  }
  const broken = CASES.find(item => item.id === 'F01');
  await assert.rejects(runCase(tree, broken, () => 'invalid source ['),
    error => error?.code === 'REGRESSION_HARNESS_ERROR');
  ok('invalid source is a harness error, not a caught behavior regression');
  const world = createWorld(tree);
  try {
    const a = world.tab(), b = world.tab();
    const entry = { time: world.clock.now, level: 'info', message: 'popup-entry', meta: { apiKey: 'fixture-only', nested: { authorization: 'fixture-only' }, count: 2 } };
    await world.clock.settle(Promise.all([a.log('page-a'), b.log('page-b'),
      world.sendWorker({ type: 'runtime_log_append', payload: entry })]), 'Popup and pages');
    await drain(world);
    assert.deepEqual(messages(world).sort(), ['page-a', 'page-b', 'popup-entry']);
    ok('popup and pages share the actual worker log writer');
    const stored = world.browser.local.runtimeLogs.find(item => item.message === 'popup-entry');
    assert.equal(stored.meta.apiKey, '[redacted]'); assert.equal(stored.meta.nested.authorization, '[redacted]'); assert.equal(stored.meta.count, 2);
    ok('sensitive metadata redacted while normal metadata survives');
    const before = world.sendWorker({ type: 'runtime_log_append', payload: { message: 'before-clear' } });
    const clear = world.sendWorker({ type: 'runtime_log_clear' });
    const after = world.sendWorker({ type: 'runtime_log_append', payload: { message: 'after-clear' } });
    await world.clock.settle(Promise.all([before, clear, after]), 'Serialized clear');
    assert.deepEqual(messages(world), ['after-clear']); ok('clear is ordered between earlier and later appends');
    const denied = await world.clock.settle(world.sendWorker({ type: 'runtime_log_clear' }, {
      id: EXTENSION, frameId: 0, url: a.context.location.href, tab: { id: 1 }
    }), 'Denied page clear');
    assert.equal(denied.success, false); assert.deepEqual(messages(world), ['after-clear']); ok('study page cannot clear logs');
    const invalid = await world.clock.settle(world.sendWorker({ type: 'runtime_log_append', payload: { message: 'x'.repeat(2001) } }), 'Invalid payload');
    assert.equal(invalid.success, false); ok('oversized log payload rejected');
  } finally { await world.dispose(); }
  const loadWorld = createWorld(tree);
  try {
    const tab = loadWorld.tab({ transport: () => Promise.reject(new Error('controlled failure')) });
    await tab.table(); const countBefore = tab.calls.length;
    await tab.table(); await tab.table(); assert.equal(tab.calls.length, countBefore); ok('failed table loads respect retry cooldown');
  } finally { await loadWorld.dispose(); }
  return { passed: true, assertions: count };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2)), tree = new SourceTree(opts.root);
  const selected = CASES.filter(spec => (!opts.group || spec.group === opts.group) && (!opts.id || spec.id === opts.id));
  if (!selected.length) throw new Error('No matching regression cases');
  if (opts.mode === 'list') {
    selected.forEach(spec => console.log(spec.id + ' [' + spec.group + '] ' + spec.name)); return;
  }
  if (opts.mode === 'self-test') {
    const result = await selfTest(tree); tree.verify(); console.log('REGRESSION_SELF_TEST ' + JSON.stringify(result)); return;
  }
  const report = { mode: 'correct-behavior-regression', sourceRoot: tree.root, virtualRecoveryBudgetMs: RECOVERY_BUDGET,
    startedAt: new Date().toISOString(), passed: true, total: selected.length, executed: 0,
    passedCases: 0, failedCases: 0, harnessErrors: 0, cases: [] };
  for (const spec of selected) {
    report.executed++;
    try {
      await runCase(tree, spec); report.passedCases++;
      report.cases.push({ id: spec.id, group: spec.group, name: spec.name, passed: true });
      console.log('[PASS] ' + spec.id + ' ' + spec.name);
    } catch (error) {
      report.passed = false;
      const harness = error?.code !== 'ERR_ASSERTION';
      if (harness) report.harnessErrors++; else report.failedCases++;
      report.cases.push({ id: spec.id, group: spec.group, name: spec.name, passed: false,
        kind: harness ? 'harness' : 'behavior', error: cleanError(error) });
      console.log((harness ? '[HARNESS ERROR] ' : '[FAIL] ') + spec.id + ' ' + spec.name + '\n  ' + cleanError(error));
      if (harness) break; // Broken test infrastructure invalidates the remaining run.
    }
  }
  tree.verify(); report.sourceUnchanged = true; report.sourceHashes = tree.hashes(); report.finishedAt = new Date().toISOString();
  console.log('\nREGRESSION_REPORT\n' + JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = report.harnessErrors ? 2 : 1;
}

module.exports = { CASES, Clock, SourceTree, createWorld, runCase, selfTest, parseArgs };
if (require.main === module) main().catch(error => { console.error('REGRESSION_HARNESS_ERROR: ' + error.stack); process.exitCode = 2; });