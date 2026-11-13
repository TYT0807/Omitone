#!/usr/bin/env node
'use strict';

/**
 * 1.3.0 实验线的独立测试入口。仅运行临时副本，不修改输入源码。
 * Node >= 22；仅 Node 内置模块 + 本机 Edge。不是操作系统安全沙箱。
 * --self-test / --list / --smoke（默认）/ --full / --filter <名称子串>
 * --edge <绝对路径> / --timeout-ms <浏览器阶段截止时间>
 * --built：在本次临时副本内构建，核验 ZIP/展开目录后加载产物，而非源码目录。
 * 输出到终端；源码副本、浏览器数据和测试计数只写本次拥有的 TEMP 目录。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = __dirname;
const UPDATE_URL = 'https://api.github.com/repos/TYT0807/Omitone/releases/latest';
const COURSE_HOSTS = new Set(['mooc1.chaoxing.com', 'mobilelearn.chaoxing.com', '127.0.0.1']);
// `.debug-profile` 是 tools/debug-live.js 在**仓库根**建的现场调试浏览器用户目录（已 gitignore）。
// 它里面有正在被 Edge 独占的文件（EdgeCoupons/coupons_data.db/LOCK），inventory 一旦走进去
// readFileSync 直接 EBUSY —— 于是这套件从"能跑"变成"根本起不来"，而且它不在 `npm test` 里，
// 坏了三个批次没人知道。check.js / publish-audit.js 早就排掉了它，这边补齐。
const OMIT = new Set(['.git', '.workbuddy', 'dist', 'node_modules', '.vscode', '.idea', 'tmp', '.debug-profile']);
const owned = new Set();
const EVIDENCE_FILE = /^omitone-acceptance-\d{8}T\d{6}Z-[a-f0-9-]{36}\.jsonl?$/;
const BASELINE_FILES = ['tools/check.js', 'tools/prompt-bench.js', 'tools/integration-test.js',
  'tools/background-test.js', 'omitone-regression.cjs', 'omitone-log-store-test.cjs',
  'omitone-popup-log-test.cjs', 'omitone-pet-game-test.cjs', 'omitone-fuzz-test.cjs',
  'omitone-acceptance-test.cjs'];
const REQUIRED_PROBES = [
  'network interception precedes document script',
  'page egress denied at browser network boundary',
  'no-runtime page is rejected rather than manually injected',
  'service worker egress denied at browser network boundary',
  'two real pages and popup preserve concurrent log entries',
  'real popup clear button uses serialized log route',
  'experimental version is distinguished from older stable release',
  'popup log text remains inert in the real DOM',
  'popup log close prevents timer revival after late reads',
  'popup log refresh and clear reject stale responses',
  'popup clipboard denial falls back without reopening a closed view',
  'popup log pagehide cancels pending operations and refresh timers'
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
  })]).finally(() => clearTimeout(timer));
}

function options(argv) {
  const result = { mode: 'smoke', timeout: 900000, filter: '', edge: '', built: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--self-test', '--list', '--smoke', '--full'].includes(arg)) result.mode = arg.slice(2);
    else if (arg === '--built') result.built = true;
    else if (['--edge', '--filter', '--timeout-ms'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (arg === '--edge') result.edge = value;
      if (arg === '--filter') { result.filter = value; result.mode = 'filter'; }
      if (arg === '--timeout-ms') result.timeout = Number(value);
    } else throw new Error('Unknown argument: ' + arg);
  }
  if (!Number.isInteger(result.timeout) || result.timeout < 1000 || result.timeout > 1800000) {
    throw new Error('timeout-ms must be between 1000 and 1800000');
  }
  return result;
}

function edgePath(explicit) {
  const choices = explicit ? [explicit] : [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const found = choices.find(file => path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) throw new Error('EDGE_MISSING: no browser, no successful skip');
  return found;
}

function inventory(root) {
  const files = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (OMIT.has(item.name) || /\.(zip|log)$/i.test(item.name) || (dir === root && EVIDENCE_FILE.test(item.name))) continue;
      const file = path.join(dir, item.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Link refused: ' + file);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) {
        if (/(^\.env($|\.)|ghtoken|gh-token|\.(pem|key)$)/i.test(item.name)) throw new Error('Credential-like filename refused');
        files.push({ relative: path.relative(root, file), hash: digest(fs.readFileSync(file)) });
      }
    }
  }
  walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function createTemporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omitone-sandbox-'));
  owned.add(dir);
  return dir;
}

function copySnapshot(root, destination, files) {
  fs.mkdirSync(destination);
  for (const entry of files) {
    const data = fs.readFileSync(path.join(root, entry.relative));
    assert.equal(digest(data), entry.hash, 'Source changed before snapshot');
    const target = path.join(destination, entry.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    assert.equal(digest(fs.readFileSync(target)), entry.hash, 'Snapshot checksum mismatch');
  }
  fs.mkdirSync(path.join(destination, '.workbuddy'));
}

async function removeOwned(dir) {
  assert.ok(owned.has(dir), 'Cleanup refuses directories not created by this process');
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  function noLinks(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'Cleanup refuses reparse points');
      if (item.isDirectory()) noLinks(file);
    }
  }
  assert.ok(!fs.lstatSync(dir).isSymbolicLink());
  noLinks(dir);
  // Only this run's freshly-created directory; never backups or existing user data.
  await fs.promises.rm(dir, { recursive: true, force: false, maxRetries: 1, retryDelay: 500 });
  owned.delete(dir);
  assert.ok(!fs.existsSync(dir));
}

function listen(server, port = 0) {
  return deadline(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  }), 5000, 'listen');
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  if (server.closeAllConnections) server.closeAllConnections();
  await deadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'server close');
}

function localUrl(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && COURSE_HOSTS.has(url.hostname) && Number(url.port) === port && !url.username && !url.password;
  } catch (_) { return false; }
}

/** Startup-deny proxy. Forwarding always uses a literal loopback address, never remote DNS. */
async function denyProxy(mockPort) {
  const blocked = new Map();
  const connections = new Set();
  const record = host => blocked.set(host, (blocked.get(host) || 0) + 1);
  const server = http.createServer((req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => req.destroy());
    if (!localUrl(req.url, mockPort)) {
      let host = 'invalid';
      try { host = new URL(req.url).host; } catch (_) {}
      record(host); res.writeHead(403); res.end('Sandbox denied'); return;
    }
    const url = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request({ host: '127.0.0.1', port: mockPort, method: req.method,
      path: url.pathname + url.search, headers }, response => {
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.setTimeout(10000, () => upstream.destroy(new Error('Local proxy timeout')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => connections.delete(socket));
  });
  server.on('connect', (req, socket) => { record(req.url.split('/')[0]); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await listen(server);
  return { port, blocked, async close() { connections.forEach(socket => socket.destroy()); await closeServer(server); } };
}

class Cdp extends EventEmitter {
  constructor(url, WebSocketType = WebSocket) {
    super(); this.url = url; this.WebSocketType = WebSocketType;
    this.pending = new Map(); this.seq = 0; this.closed = false;
  }
  async connect() {
    this.ws = new this.WebSocketType(this.url);
    this.ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result || {});
      } else if (message.method) this.emit('event', message);
    });
    this.ws.addEventListener('close', () => this.failPending('CDP disconnected'));
    this.ws.addEventListener('error', () => this.failPending('CDP transport error'));
    try {
      await deadline(new Promise((resolve, reject) => {
        this.ws.addEventListener('open', resolve, { once: true });
        this.ws.addEventListener('error', () => reject(new Error('CDP connect failed')), { once: true });
      }), 10000, 'CDP connect');
    } catch (error) { this.close(); throw error; }
  }
  send(method, params = {}, sessionId, timeout = 15000) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  failPending(reason) {
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    this.pending.clear();
  }
  close() { this.failPending('CDP closed'); if (this.ws) this.ws.close(); }
}

class PageSession {
  constructor(cdp, id, info) { this.cdp = cdp; this.id = id; this.info = info; this.events = []; }
  send(method, params) { return this.cdp.send(method, params, this.id); }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error('Page evaluation failed: ' +
      (response.exceptionDetails.exception?.description || response.exceptionDetails.text));
    return response.result?.value;
  }
  errors() {
    return this.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => {
      const detail = e.params.exceptionDetails;
      // 只回 description 的那一版，把「哪一份文档、哪一行」丢掉了。而「定向跑绿、全量跑红」
      // 那一族异常能分辨的线索恰好只有这两样（批次 47 的 SyntaxError 就是这么悬了三轮）。
      const frame = (detail.stackTrace && detail.stackTrace.callFrames || [])[0] || {};
      const at = detail.url || frame.url || '';
      const line = Number.isInteger(detail.lineNumber) ? detail.lineNumber : frame.lineNumber;
      return (detail.exception?.description || detail.text) + (at ? ' @ ' + at + ':' + line : '');
    });
  }
}

class NetworkGuard {
  constructor(cdp, mockPort, version) {
    this.cdp = cdp; this.mockPort = mockPort; this.version = version;
    this.targets = new Map(); this.sessions = new Map(); this.pendingSetups = new Set();
    this.errors = []; this.denied = []; this.expected = new Set(); this.expectedHits = new Set();
    this.localCount = 0; this.updateCount = 0; this.stopping = false;
    cdp.on('event', event => this.event(event));
  }
  event(event) {
    if (event.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = event.params;
      const session = new PageSession(this.cdp, sessionId, targetInfo);
      this.sessions.set(sessionId, session); this.targets.set(targetInfo.targetId, session);
      const setup = this.configure(session).catch(error => {
        if (!this.stopping) this.errors.push('Target guard: ' + error.message);
      }).finally(() => this.pendingSetups.delete(setup));
      session.ready = setup; this.pendingSetups.add(setup);
    } else if (event.method === 'Fetch.requestPaused') {
      this.request(event).catch(error => { if (!this.stopping) this.errors.push('Fetch guard: ' + error.message); });
    } else if (event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.executionContextCreated') {
      const session = this.sessions.get(event.sessionId);
      if (session) {
        session.events.push(event);
        if (session.events.length > 2000) { session.events.shift(); this.errors.push('CDP event capacity exceeded'); }
      }
    }
  }
  async configure(session) {
    if (['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(session.info.type)) {
      await session.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
      await session.send('Runtime.enable');
      if (['page', 'iframe'].includes(session.info.type)) {
        await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      }
    }
    await session.send('Runtime.runIfWaitingForDebugger');
  }
  async start() {
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  async request(event) {
    const { requestId, request } = event.params;
    const send = (method, params) => this.cdp.send(method, { requestId, ...params }, event.sessionId);
    if (request.url === UPDATE_URL && request.method === 'GET') {
      this.updateCount++;
      return send('Fetch.fulfillRequest', { responseCode: 200, responseHeaders: [
        { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }
      ], body: Buffer.from(JSON.stringify({ tag_name: 'v' + this.version, assets: [] })).toString('base64') });
    }
    if (localUrl(request.url, this.mockPort)) { this.localCount++; return send('Fetch.continueRequest', {}); }
    if (this.expected.has(request.url)) this.expectedHits.add(request.url);
    else {
      const url = new URL(request.url);
      this.denied.push({ method: request.method, origin: url.origin, path: url.pathname });
    }
    return send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
  }
  async waitTarget(id) {
    const until = Date.now() + 10000;
    while (!this.targets.has(id)) { if (Date.now() > until) throw new Error('Target not attached'); await sleep(25); }
    const session = this.targets.get(id); await session.ready;
    if (this.errors.length) throw new Error(this.errors.join('; '));
    return session;
  }
  async open(url, beforeScript) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = await this.waitTarget(targetId);
    await session.send('Page.enable');
    if (beforeScript) await session.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeScript });
    const response = await session.send('Page.navigate', { url });
    if (response.errorText) throw new Error('Navigation failed: ' + response.errorText);
    return session;
  }
  async closePage(session) { if (session) await this.cdp.send('Target.closeTarget', { targetId: session.info.targetId }); }
}

/** Reuse scenario definitions without invoking their original launcher or writing counts. */
function legacySuite(snapshot) {
  const filename = path.join(snapshot, 'tools', 'browser-e2e.js');
  const source = fs.readFileSync(filename, 'utf8');
  const anchor = '\nmain().catch(function (err) {';
  const end = source.lastIndexOf(anchor);
  const boundaryLines = source.split(/\r?\n/)
    .map((line, i) => (line.startsWith('main().catch(function (err) {') ? i + 1 : 0))
    .filter(Boolean);
  assert.ok(end > 0 && source.indexOf(anchor) === end && boundaryLines.length === 1,
    'tools/browser-e2e.js must keep exactly ONE `main().catch(function (err) {` line at column 0 ' +
    `(the sandbox reuses everything before it and cannot see anything after it). ` +
    `File: ${filename}. Found ${boundaryLines.length} at line(s): ` +
    (boundaryLines.join(', ') || 'none — the launcher tail is missing or indented'));
  const timers = new Set();
  const context = vm.createContext({
    require: createRequire(filename), __dirname: path.dirname(filename), __filename: filename,
    console, process: { env: {}, platform: process.platform, cwd: () => snapshot },
    Buffer, URL, WebSocket,
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }
  });
  vm.runInContext(source.slice(0, end), context, { filename, timeout: 5000 });
  assert.ok(context.SCENARIOS.length > 0, 'No scenarios loaded');
  context.PORT = 0;
  return { context, hash: digest(source), dispose() { timers.forEach(clearTimeout); timers.clear(); } };
}

async function poll(test, ms, label) {
  const until = Date.now() + ms;
  do {
    if (await test()) return;
    await sleep(50);
  } while (Date.now() < until);
  throw new Error(label + ' timed out');
}

async function launchEdge(edge, profile, extension, proxyPort) {
  fs.mkdirSync(profile);
  const args = [
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--enable-automation',
    '--disable-extensions-except=' + extension, '--load-extension=' + extension,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // 批次 47 实测的唯一开关：留着 CalculateNativeWinOcclusion 时，同窗口把另一枚标签端上去，
    // hasFocus 正确翻过去了，可两枚标签的 document.hidden 都恒为 false —— 宠物「真后台」那条
    // 前提在沙盒里永远挤不出来（三趟重试 flipMs 全是 -1）。关掉它，同一发操作 200 毫秒翻成 true。
    '--disable-features=CalculateNativeWinOcclusion',
    '--proxy-server=http://127.0.0.1:' + proxyPort, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'
  ];
  const child = spawn(edge, args, { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  const browser = { child, args, port: 0, websocket: '' };
  // Return the process handle immediately so failure during readiness can still be cleaned up.
  browser.ready = async () => {
    const activePort = path.join(profile, 'DevToolsActivePort');
    await poll(() => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Edge exited before debugger readiness');
      if (!fs.existsSync(activePort)) return false;
      const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(lines[0]) || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(lines[1] || '')) return false;
      browser.port = Number(lines[0]);
      browser.websocket = 'ws://127.0.0.1:' + browser.port + lines[1];
      return true;
    }, 30000, 'Owned browser readiness');
  };
  return browser;
}

async function portFree(port) {
  const server = net.createServer();
  try { await listen(server, port); await closeServer(server); return true; }
  catch (error) { if (error.code === 'EADDRINUSE') return false; throw error; }
}

async function stopBrowser(browser, cdp) {
  if (!browser) return;
  if (cdp && !cdp.closed) { try { await cdp.send('Browser.close', {}, undefined, 3000); } catch (_) {} }
  if (cdp) cdp.close();
  try { await poll(() => browser.child.exitCode !== null, 5000, 'Browser exit'); }
  catch (_) {
    // Never use /IM or kill-all. Only the PID created above and its descendants.
    if (browser.child.exitCode === null && browser.child.pid) {
      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], { stdio: 'ignore' });
        const timer = setTimeout(() => reject(new Error('Owned process termination timed out')), 8000);
        killer.once('error', error => { clearTimeout(timer); reject(error); });
        killer.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  await poll(() => browser.child.exitCode !== null, 5000, 'Owned browser termination');
  if (browser.port) await poll(() => portFree(browser.port), 5000, 'Owned debugging port release');
}

async function nodeTest(snapshot, file, emit = () => {}) {
  const started = Date.now();
  emit('baseline_start', { file });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(snapshot, file)], { cwd: snapshot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(file + ' timed out')); }, 120000);
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(-150000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try { emit('baseline_end', { file, exitCode: code, signal, ms: Date.now() - started }); }
      catch (error) { reject(error); return; }
      console.log(output.trim());
      if (code !== 0) reject(new Error(file + ' exited ' + code));
      else resolve({ file, exitCode: code, ms: Date.now() - started });
    });
  });
}

/** Verify the locally generated, non-ZIP64 archive without extracting files or trusting names. */
function verifyBuild(snapshot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'));
  const stage = path.join(snapshot, 'dist', 'omitone-' + manifest.version);
  const archivePath = stage + '.zip', archive = fs.readFileSync(archivePath);
  assert.ok(archive.length >= 22, 'Build archive too short');
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'Build archive end record');
  assert.equal(archive.readUInt16LE(end + 20), 0, 'Unexpected ZIP comment');
  const count = archive.readUInt16LE(end + 10);
  const centralStart = archive.readUInt32LE(end + 16);
  assert.equal(centralStart + archive.readUInt32LE(end + 12), end, 'Invalid ZIP central bounds');
  const archived = new Set();
  let cursor = centralStart, files = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'ZIP central entry');
    const method = archive.readUInt16LE(cursor + 10), packed = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !/[:\\]/.test(name) && !name.split('/').includes('..'), 'Unsafe ZIP path');
    assert.ok(!archived.has(name), 'Duplicate ZIP path'); archived.add(name);
    assert.equal(archive.readUInt32LE(offset), 0x04034b50, 'ZIP local entry');
    assert.equal(archive.readUInt16LE(offset + 8), method, 'ZIP method mismatch');
    const localNameLength = archive.readUInt16LE(offset + 26);
    assert.equal(archive.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8'), name, 'ZIP filename mismatch');
    const begin = offset + 30 + localNameLength + archive.readUInt16LE(offset + 28);
    assert.ok(begin + packed <= centralStart && size <= 32 * 1024 * 1024, 'ZIP entry bounds');
    const compressed = archive.subarray(begin, begin + packed);
    assert.ok(method === 0 || method === 8, 'Unsupported local ZIP method');
    const bytes = method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    assert.equal(bytes.length, size, 'ZIP size mismatch');
    if (!name.endsWith('/')) {
      assert.equal(digest(bytes), digest(fs.readFileSync(path.join(stage, name))), 'ZIP and staged file differ: ' + name);
      files++;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end, 'ZIP entry count mismatch');
  let stagedFiles = 0;
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'Link in staged output');
      if (item.isDirectory()) walk(file);
      else { stagedFiles++; assert.ok(archived.has(path.relative(stage, file).replaceAll('\\', '/')), 'Staged file absent from ZIP'); }
    }
  }
  walk(stage); assert.equal(stagedFiles, files);
  for (const file of ['background.js', 'runtime-log-store.js', 'popup-log-view.js', 'content.js', 'page.js', 'popup/popup.js']) {
    assert.ok(archived.has(file), 'Runtime file missing from build: ' + file);
    assert.equal(digest(fs.readFileSync(path.join(stage, file))), digest(fs.readFileSync(path.join(snapshot, file))), 'Stale staged runtime');
  }
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  assert.equal(stagedManifest.version, manifest.version);
  if (/\bexperimental\b/.test(manifest.version_name || '')) assert.match(stagedManifest.version_name, /\bexperimental\b/);
  assert.ok(!archived.has('omitone-regression.cjs') && !archived.has('omitone-log-store-test.cjs') &&
    !archived.has('omitone-popup-log-test.cjs'), 'Development tests leaked into package');
  return { directory: stage, archive: archivePath, files, sha256: digest(archive), zipMatchesDirectory: true,
    runtimeMatchesSource: true, versionName: stagedManifest.version_name };
}

function selectScenarios(scenarios, opts) {
  if (opts.mode === 'full') return scenarios;
  if (opts.mode === 'filter') return scenarios.filter(s => s.name.toLowerCase().includes(opts.filter.toLowerCase()));
  return scenarios.filter(s => ['抠题（5 种题型）', '抠题（题在 frame_content iframe 里）'].includes(s.name) || s.name.startsWith('弹窗检查更新'));
}

// These legacy scenarios relied on the preceding scenario's saved mock API config.
// State reset must not be disabled to hide that dependency. Declare only their actual
// prerequisites; never patch production methods or weaken the original assertions.
function scenarioConfig(name, mockPort) {
  const configured = new Set([
    '弹题反复失败会放弃而不是死循环',
    '交完卷之后不能一直卡在"还有题要做"'
  ]);
  if (!configured.has(name)) return null;
  return { apiType: 'openai', apiUrl: 'http://127.0.0.1:' + mockPort,
    apiKey: 'sandbox-fixture-not-a-real-key', model: 'sandbox-mock',
    enableQuiz: true, enableCaptcha: false, enableDiscussion: false, autoNext: false, randomAnswer: false };
}

async function strictReady(session, ms = 10000) {
  await poll(async () => {
    try { return await session.evaluate('!!(document.readyState === "complete" && window._xxtApp && ' +
      'window._xxtApp._extractQuestions && window._xxtApp.configs.pageScope === "study")'); }
    catch (_) { return false; }
  }, ms, 'STRICT_INJECTION_FAILED: runtime never auto-injected');
}

async function browserProbes(guard, version) {
  const results = [];
  function check(name, condition) { assert.ok(condition, name); results.push(name); console.log('[sandbox ok] ' + name); }
  let session;
  try {
    const source = 'window.__sandboxStartup=fetch(' + JSON.stringify(UPDATE_URL) + ').then(r=>r.json()).then(x=>x.tag_name);';
    session = await guard.open('http://127.0.0.1:' + guard.mockPort + '/blank', source);
    await poll(() => session.evaluate('document.readyState === "complete" && !!window.__sandboxStartup'), 10000, 'Startup probe ready');
    check('network interception precedes document script', await session.evaluate('window.__sandboxStartup') === 'v' + version);
    const denied = 'https://omitone-egress.invalid/probe';
    guard.expected.add(denied);
    const blocked = await session.evaluate('(async()=>{try{await fetch(' + JSON.stringify(denied) + ');return false;}catch(e){return true;}})()');
    check('page egress denied at browser network boundary', blocked && guard.expectedHits.has(denied));
    await assert.rejects(strictReady(session, 200), /STRICT_INJECTION_FAILED/);
    check('no-runtime page is rejected rather than manually injected', true);
  } finally { await guard.closePage(session); }
  return results;
}

/** Wrap only IO after the real popup has initialized; do not replace its module or controller. */
function installPopupLogProbe(view) {
  const probe = window.__popupLogProbe = { view, readMode: 'real', reads: [], readCount: 0,
    clipboardMode: 'reject', clipboardCalls: 0, clipboard: [], clipboardPending: [] };
  const read = chrome.storage.local.get.bind(chrome.storage.local);
  chrome.storage.local.get = function (keys, ...args) {
    if (keys === 'runtimeLogs' && args.length === 0) {
      probe.readCount++;
      if (probe.readMode === 'hold') return new Promise((resolve, reject) => probe.reads.push({
        resolve: logs => resolve({ runtimeLogs: logs }), reject
      }));
    }
    return read(keys, ...args);
  };
  Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value(text) {
      probe.clipboardCalls++; probe.clipboard.push(text);
      if (probe.clipboardMode === 'hold') return new Promise((resolve, reject) => probe.clipboardPending.push({ resolve, reject }));
      if (probe.clipboardMode === 'reject') return Promise.reject(new Error('controlled clipboard rejection'));
      return Promise.resolve();
    }
  });
}

async function popupLogBrowserProbes(guard, extensionId, report) {
  let page;
  try {
    page = await guard.open('chrome-extension://' + extensionId + '/popup/popup.html?ui=lite');
    await poll(() => page.evaluate('document.readyState === "complete" && typeof popupLogView !== "undefined"'), 10000, 'Real popup log initialization');
    await page.evaluate('(' + installPopupLogProbe.toString() + ')(popupLogView);true');
    const marker = '<b data-log-probe="literal">plain-log</b>';
    await page.evaluate('chrome.storage.local.set({runtimeLogs:' + JSON.stringify([
      { time: 1700000000000, level: 'info', message: 'older-record' },
      { time: 1700000001000, level: 'warn" data-log-probe="level', message: marker, meta: { note: '<i data-log-probe="meta">meta</i>' } }
    ]) + '}).then(()=>{document.getElementById("toggleLogs").click();return true;})');
    await poll(() => page.evaluate('document.getElementById("logPanel").textContent.includes("plain-log")'), 10000, 'Literal log rendering');
    const rendered = await page.evaluate('({text:document.getElementById("logPanel").textContent,' +
      'injected:document.getElementById("logPanel").querySelectorAll("[data-log-probe]").length,' +
      'level:document.querySelector("#logPanel .log-level").className,' +
      'expanded:document.getElementById("toggleLogs").getAttribute("aria-expanded")})');
    assert.ok(rendered.text.includes(marker) && rendered.injected === 0 && rendered.level === 'log-level info' && rendered.expanded === 'true', 'Log text interpreted as markup');
    assert.ok(rendered.text.indexOf('plain-log') < rendered.text.indexOf('older-record'), 'Log display order changed');
    report.probes.push('popup log text remains inert in the real DOM');

    await page.evaluate('document.getElementById("toggleLogs").click();window.__popupLogProbe.readMode="hold";' +
      'document.getElementById("toggleLogs").click();true');
    await poll(() => page.evaluate('window.__popupLogProbe.reads.length===1'), 5000, 'Deferred open actually requested');
    await page.evaluate('document.getElementById("toggleLogs").click();window.__popupLogProbe.closedReadCount=window.__popupLogProbe.readCount;' +
      'window.__popupLogProbe.reads.shift().resolve([{message:"late-hidden",time:1}]);true');
    await sleep(1700);
    const closed = await page.evaluate('({open:document.getElementById("logPanel").classList.contains("show"),' +
      'readCount:window.__popupLogProbe.readCount,closedReadCount:window.__popupLogProbe.closedReadCount,reads:window.__popupLogProbe.reads.length,' +
      'text:document.getElementById("logPanel").textContent,expanded:document.getElementById("toggleLogs").getAttribute("aria-expanded")})');
    assert.ok(!closed.open && closed.readCount === closed.closedReadCount && closed.reads === 0 && !closed.text.includes('late-hidden') && closed.expanded === 'false', 'Closed view revived after a late response');
    report.probes.push('popup log close prevents timer revival after late reads');

    await page.evaluate('document.getElementById("toggleLogs").click();true');
    await poll(() => page.evaluate('window.__popupLogProbe.reads.length===1'), 5000, 'First competing read');
    await page.evaluate('window.__popupLogProbe.view.refresh();true');
    await poll(() => page.evaluate('window.__popupLogProbe.reads.length===2'), 5000, 'Second competing read');
    await page.evaluate('window.__popupLogProbe.reads[1].resolve([{message:"new-response",time:2}]);true');
    await poll(() => page.evaluate('document.getElementById("logPanel").textContent.includes("new-response")'), 5000, 'New response displayed');
    await page.evaluate('window.__popupLogProbe.reads[0].resolve([{message:"old-response",time:1}]);window.__popupLogProbe.reads=[];true');
    await sleep(50);
    assert.ok(await page.evaluate('document.getElementById("logPanel").textContent.includes("new-response") && !document.getElementById("logPanel").textContent.includes("old-response")'), 'Older read overwrote new result');
    await page.evaluate('window.__popupLogProbe.view.refresh();true');
    await poll(() => page.evaluate('window.__popupLogProbe.reads.length===1'), 5000, 'Pre-clear read pending');
    await page.evaluate('document.getElementById("clearLogs").click();true');
    await poll(() => page.evaluate('document.getElementById("toast").textContent === "日志已清空"'), 10000, 'Real Worker clear completed');
    await page.evaluate('window.__popupLogProbe.reads.shift().resolve([{message:"resurrected",time:1}]);true');
    await sleep(50);
    const cleared = await page.evaluate('chrome.storage.local.get(["runtimeLogs"]).then(r=>({count:(r.runtimeLogs||[]).length,text:document.getElementById("logPanel").textContent}))');
    assert.ok(cleared.count === 0 && cleared.text === '暂无日志', 'Clear was undone by stale display');
    report.probes.push('popup log refresh and clear reject stale responses');

    await page.evaluate('window.__popupLogProbe.view.close();window.__popupLogProbe.readMode="real";' +
      'chrome.storage.local.set({runtimeLogs:[{message:"copy-fallback",time:1700000000000}]}).then(()=>{document.getElementById("copyLogs").click();return true;})');
    await poll(() => page.evaluate('document.getElementById("toast").textContent === "复制失败，请在上方日志里手动选中"'), 5000, 'Clipboard failure fallback');
    assert.ok(await page.evaluate('document.getElementById("logPanel").classList.contains("show") && document.getElementById("logPanel").textContent.includes("copy-fallback") && window.__popupLogProbe.clipboard[0].includes("Omitone 诊断日志")'), 'Clipboard fallback not readable');
    await page.evaluate('window.__popupLogProbe.clipboardMode="hold";document.getElementById("copyLogs").click();true');
    await poll(() => page.evaluate('window.__popupLogProbe.clipboardPending.length===1'), 5000, 'Clipboard operation in flight');
    await page.evaluate('document.getElementById("toggleLogs").click();window.__popupLogProbe.closedReadCount=window.__popupLogProbe.readCount;' +
      'window.__popupLogProbe.clipboardPending.shift().reject(new Error("controlled late rejection"));true');
    await sleep(1700);
    assert.ok(await page.evaluate('!document.getElementById("logPanel").classList.contains("show") && window.__popupLogProbe.readCount===window.__popupLogProbe.closedReadCount'), 'Late clipboard error reopened closed view');
    report.probes.push('popup clipboard denial falls back without reopening a closed view');

    await page.evaluate('window.__popupLogProbe.readMode="hold";document.getElementById("toggleLogs").click();true');
    await poll(() => page.evaluate('window.__popupLogProbe.reads.length===1'), 5000, 'Pending read before pagehide');
    await page.evaluate('window.dispatchEvent(new Event("pagehide"));window.__popupLogProbe.closedReadCount=window.__popupLogProbe.readCount;' +
      'window.__popupLogProbe.reads.shift().resolve([{message:"after-dispose",time:1}]);true');
    await sleep(1700);
    assert.ok(await page.evaluate('window.__popupLogProbe.readCount===window.__popupLogProbe.closedReadCount && !document.getElementById("logPanel").classList.contains("show") && !document.getElementById("logPanel").textContent.includes("after-dispose")'), 'Disposed log view retained work');
    assert.equal(page.errors().length, 0, 'Popup log browser probe had uncaught exceptions');
    report.probes.push('popup log pagehide cancels pending operations and refresh timers');
  } catch (error) {
    // Scope is a controlled fixture. Retain diagnostic detail in terminal output without
    // persisting storage contents, clipboard contents or page text into acceptance evidence.
    console.error('Popup log browser probe failed: ' + error.message);
    if (page) console.error('Popup probe uncaught errors: ' + page.errors().join(' | '));
    throw error;
  } finally { await guard.closePage(page); }
}

async function runBrowserSuite(snapshot, profile, edge, proxy, mock, suite, opts, report, resources) {
  const c = suite.context;
  const emit = opts.emit || (() => {});
  resources.browser = await launchEdge(edge, profile, snapshot, proxy.port);
  await resources.browser.ready();
  const cdp = resources.cdp = new Cdp(resources.browser.websocket);
  await cdp.connect();
  const commandLine = await cdp.send('Browser.getBrowserCommandLine');
  assert.ok(commandLine.arguments.includes('--user-data-dir=' + profile), 'Wrong browser profile');
  assert.ok(commandLine.arguments.includes('--load-extension=' + snapshot), 'Wrong extension snapshot');
  report.browser = await cdp.send('Browser.getVersion');
  delete report.browser.jsVersion;
  report.browser.commandLineVerified = !!commandLine;
  emit('browser_ready', { extension: snapshot, profile, browser: report.browser.product,
    commandLineVerified: true, pid: resources.browser.child.pid, port: resources.browser.port });
  // browser-e2e 里走 CDP **HTTP** 的那几个端点（activateTab / closeTab / withBrowserClient）
  // 读的是模块级 CDP_PORT。沙盒用 --remote-debugging-port=0 起浏览器，真实端口只有这里知道：
  // 不灌进去，它们全都连到默认的 9222 上，于是宠物「真后台」那两条把"连不上 CDP"
  // 报成"找不到同窗口的接管标签"（批次 45/47 的恒红，定向跑与全量跑同形）。
  assert.ok(resources.browser.port > 0, 'Owned browser debug port must be resolved before scenarios run');
  c.CDP_PORT = resources.browser.port;
  const version = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8')).version;
  const guard = resources.guard = new NetworkGuard(cdp, c.PORT, version);
  await guard.start();
  report.probes = await browserProbes(guard, version);

  let probe = await guard.open('http://127.0.0.1:' + c.PORT + '/blank');
  let extensionId;
  try {
    await poll(() => {
      const match = probe.events.find(e => e.method === 'Runtime.executionContextCreated' &&
        /^chrome-extension:\/\/[a-p]{32}$/.test(e.params.context.origin) && /Omitone/i.test(e.params.context.name));
      if (match) extensionId = match.params.context.origin.slice('chrome-extension://'.length);
      return !!extensionId;
    }, 10000, 'Runtime extension identity');
  } finally { await guard.closePage(probe); }
  report.extensionId = extensionId;
  const config = await guard.open('chrome-extension://' + extensionId + '/popup/popup.html?ui=lite');
  await poll(() => config.evaluate('!!(globalThis.chrome && chrome.storage && document.readyState === "complete")'), 10000, 'Config writer');
  const workerDenied = 'https://omitone-worker-egress.invalid/probe';
  guard.expected.add(workerDenied);
  const workerResponse = await config.evaluate('new Promise(resolve=>chrome.runtime.sendMessage(' +
    JSON.stringify({ type: 'api_fetch', payload: { url: workerDenied, method: 'GET', timeoutMs: 3000 } }) +
    ', response=>resolve(response)))');
  assert.ok(workerResponse && !workerResponse.success && guard.expectedHits.has(workerDenied), 'Worker egress must be intercepted');
  report.probes.push('service worker egress denied at browser network boundary');
  // Real page-message -> content -> worker -> storage path, not a direct helper mock.
  const logPages = [];
  try {
    for (let i = 0; i < 2; i++) {
      const page = await guard.open('http://mooc1.chaoxing.com:' + c.PORT + '/blank');
      logPages.push(page); await strictReady(page);
    }
    const cleared = await config.evaluate('new Promise(r=>chrome.runtime.sendMessage({type:"runtime_log_clear"},r))');
    assert.ok(cleared && cleared.success, 'Popup log clear refused');
    await Promise.all(logPages.map((page, i) => page.evaluate('window.postMessage({source:"xxt_app",type:"runtime_log",level:"info",message:' +
      JSON.stringify('sandbox-concurrent-' + i) + '},"*");true')));
    await config.evaluate('appendPopupLog("info","sandbox-popup-entry",null)');
    await poll(async () => {
      const logs = await config.evaluate('chrome.storage.local.get("runtimeLogs").then(r=>r.runtimeLogs||[])');
      return ['sandbox-concurrent-0', 'sandbox-concurrent-1', 'sandbox-popup-entry'].every(message => logs.some(item => item.message === message));
    }, 10000, 'Concurrent page/popup logs');
    report.probes.push('two real pages and popup preserve concurrent log entries');
    await config.evaluate('document.getElementById("clearLogs").click();true');
    await poll(() => config.evaluate('chrome.storage.local.get("runtimeLogs").then(r=>(r.runtimeLogs||[]).length===0)'), 10000, 'Popup clear button');
    report.probes.push('real popup clear button uses serialized log route');
  } finally { for (const page of logPages) await guard.closePage(page); }
  try {
    guard.version = '1.2.9'; // 已发布稳定版本；仍由网络层合成，不请求 GitHub。
    const update = await config.evaluate('(async()=>{' +
      'localStorage.removeItem("omitone.update.manualAt");await checkUpdate({manual:true});' +
      'return {text:document.getElementById("updateMsg").textContent,offer:document.getElementById("doUpdate").style.display};})()');
    assert.ok(update.text.includes('高于线上 1.2.9') && !update.text.includes('与线上一致') && update.offer === 'none',
      'Experimental build must not pretend to match or upgrade to older stable release');
    report.probes.push('experimental version is distinguished from older stable release');
  } finally { guard.version = version; }
  await popupLogBrowserProbes(guard, extensionId, report);
  emit('probes_complete', { names: report.probes.slice() });
  c.cfgClient = config;
  c.initConfigWriter = async () => config;
  const selected = selectScenarios(c.SCENARIOS, opts);
  if (!selected.length) throw new Error('No scenarios selected');
  report.availableScenarios = c.SCENARIOS.length;
  report.selectedScenarios = selected.length;
  emit('scenario_plan', { hash: suite.hash, names: selected.map(scenario => scenario.name) });
  // 夹具那两面「跨域墙」把 #iframe 指向 http://mooc2.chaoxing.com:PORT 与 http://localhost:PORT
  // ——「同站不同源」与「别家」两种形状。场景要的是 **JS 读不到那一帧**，不是那一帧的内容，
  // 所以沙盒在 Fetch 边界把它拦掉是**正确行为**（现场跑时 host-resolver 把 mooc2 映到
  // 127.0.0.1，那一发压根不经过这道闸）。但下面那条「不许有意外的业务出网」数的是
  // guard.denied，于是它被记成违规；而这条闸排在「断言数=0」后面 —— 前面一抛，它永远轮不到，
  // 全量跑里这三条红就是这么一直被同一条 808 挡着的。
  // 处置：按既有 expected 机制**显式登记**（与 omitone-egress.invalid 同一做法），
  // allowlist 一个字没放宽；并按**本轮真选中的场景**登记，定向跑不会凭空多出一条没命中的登记。
  const blockedWallTargets = { '/blocked-same-site': 'mooc2.chaoxing.com', '/blocked-off-site': 'localhost' };
  for (const scenario of selected) {
    const host = blockedWallTargets[String(scenario.path || '')];
    if (host) guard.expected.add('http://' + host + ':' + c.PORT + '/blocked-inner');
  }
  report.scenarios = [];
  for (const scenario of selected) {
    if (guard.stopping) throw new Error('Suite cancelled');
    if (guard.errors.length) throw new Error(guard.errors.join('; '));
    // Reset persistent configuration between scenarios; no real API credentials are imported.
    await config.evaluate('new Promise(r=>chrome.storage.local.clear(()=>chrome.storage.session.clear(()=>r(true))))');
    await config.evaluate('localStorage.clear();true');
    const fixture = scenarioConfig(scenario.name, c.PORT);
    if (fixture) await config.evaluate('new Promise((resolve,reject)=>chrome.storage.local.set({config:' +
      JSON.stringify(fixture) + '},()=>chrome.runtime.lastError?reject(new Error("Fixture storage failed")):resolve(true)))');
    mock.setStatus(0); mock.setResponseMode(''); mock.requests.length = 0;
    const before = c.checks, failuresBefore = c.failures.length;
    emit('scenario_start', { name: scenario.name, index: report.scenarios.length });
    const label = String(scenario.url || scenario.path).replace('{EXT}', extensionId);
    const url = /^[a-z-]+:\/\//i.test(label) ? label : 'http://mooc1.chaoxing.com:' + c.PORT + label;
    c.section(scenario.name);
    let session, behaviorAssertions = 0, pageErrors = -1;
    try {
      session = await guard.open(url, scenario.beforeInject ? scenario.beforeInject() : undefined);
      await session.send('Page.bringToFront');
      if (scenario.inject === false) await poll(() => session.evaluate('document.readyState === "complete"'), 10000, 'Popup load');
      else await strictReady(session);
      c.check('严格加载成功（无手动注入兜底）', true);
      if (fixture) c.check('独立场景已加载本地模拟 API 配置', await session.evaluate(
        'window._xxtApp.configs.hasApiKey === true && window._xxtApp.configs.enableQuiz === true'));
      const behaviorBefore = c.checks;
      // targetId 必须一起给：browser-e2e 里凡是查「这一页在哪扇窗口」的场景
      // （宠物「真后台」要核对同窗口候选）都要拿它去调 Browser.getWindowForTarget；
      // 少了它，那一次调用直接报错，而 withBrowserClient 把错误吞成 null ——
      // 报出来的就是「找不到同窗口的接管标签」，和真因（夹具没给 id）完全不同形。
      const ctx = { client: session, url, extensionId, mock,
        targetId: session.info && session.info.targetId, close: () => guard.closePage(session) };
      await deadline(scenario.run(ctx, mock), 180000, 'Scenario');
      behaviorAssertions = c.checks - behaviorBefore;
      // ⚠️ 这条闸抓不住**迟到的导航异常**：批次 47 实测把坏 `javascript:` src 注回夹具、
      // 定向跑读到 3 秒仍是 `pageErrors:0`（同一条在 --full 里红过一次）。所以保护不在这里，
      // 在夹具自己 —— 页面里写进去的程序必须能解析（见 tools/browser-e2e.js 的 fEmpty 那条注释）。
      // 异常一律带上「哪份文档 + 第几行」，否则下一次红只剩一句 description，又是三轮悬案。
      pageErrors = session.errors().length;
      c.check('场景至少执行一条原有断言', c.checks > behaviorBefore);
      c.check('场景结束无未捕获页面异常', session.errors().length === 0, session.errors().join(' | '));
    } catch (error) { c.check('场景执行', false, error.message); }
    finally { await guard.closePage(session); }
    const result = { name: scenario.name, assertions: c.checks - before, failed: c.failures.length - failuresBefore,
      behaviorAssertions, pageErrors };
    report.scenarios.push(result);
    emit('scenario_end', result);
  }
  report.assertions = c.checks;
  report.failures = Array.from(c.failures);
  report.network = { localRequests: guard.localCount, mockedUpdates: guard.updateCount,
    unexpectedRequests: guard.denied, guardErrors: guard.errors,
    expectedDenials: Array.from(guard.expected), expectedHits: guard.expectedHits.size,
    startupProxyDeniedHosts: Object.fromEntries(proxy.blocked) };
  await guard.closePage(config);
  // 三条闸排在一条抛错后面 = 后面那两条从来没验收过（批次 47 数出 5 条出网红，全被第一条挡住）。
  // 判据一个字没改，只是**一次跑完再一起报**：哪几条红，一眼看全。
  const gates = [];
  if (c.failures.length) gates.push('Scenario assertions failed ' + c.failures.length);
  if (guard.errors.length) gates.push('Network instrumentation failed ' + guard.errors.length);
  if (guard.denied.length) gates.push('Unexpected business egress attempted ' + guard.denied.length);
  // 登记过就必须真的拦到一次 —— 否则 expected 会烂成"什么都能塞进来"的洞：
  // 夹具哪天改了地址、或者那两面墙压根没跑到，登记条目等于替真出网打掩护。
  const declaredUnhit = Array.from(guard.expected).filter(url => !guard.expectedHits.has(url));
  if (declaredUnhit.length) gates.push('Declared egress never attempted ' + declaredUnhit.join(', '));
  report.gates = gates;
  assert.equal(gates.length, 0, 'Suite gates failed: ' + gates.join(' | '));
}

async function execute(opts) {
  const emit = opts.emit || (() => {});
  const report = { sandbox: '1.3.0-experimental-foundation', productionVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version,
    startedAt: new Date().toISOString(), mode: opts.mode, loadedFrom: opts.built ? 'temporary-build' : 'temporary-source', passed: false, cleanup: false };
  const edge = edgePath(opts.edge);
  if (typeof WebSocket !== 'function') throw new Error('Node >=22 with native WebSocket required');
  const before = inventory(ROOT);
  report.sourceFingerprint = digest(JSON.stringify(before));
  emit('sandbox_start', { mode: opts.mode, built: opts.built === true, sourceFingerprint: report.sourceFingerprint });
  const temp = createTemporary(), snapshot = path.join(temp, 'source');
  report.temporaryRoot = temp;
  emit('temporary_created', { path: temp });
  const resources = {};
  let suite, proxy, mock, cleanupError;
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  const onFatal = error => rejectFatal(error instanceof Error ? error : new Error(String(error)));
  const onInterrupt = () => onFatal(new Error('Sandbox interrupted'));
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  console.log('Sandbox temporary root: ' + temp);
  try {
    copySnapshot(ROOT, snapshot, before);
    report.baseline = [];
    for (const file of BASELINE_FILES) {
      report.baseline.push(await nodeTest(snapshot, file, emit));
    }
    let extension = snapshot;
    if (opts.built) {
      assert.ok(!fs.existsSync(path.join(snapshot, 'dist')), 'Refuse to overwrite an existing build directory');
      report.baseline.push(await nodeTest(snapshot, 'tools/build.js', emit));
      report.build = verifyBuild(snapshot);
      emit('build_verified', report.build);
      extension = report.build.directory;
    }
    suite = legacySuite(snapshot);
    report.scenarioSourceHash = suite.hash;
    mock = await suite.context.startMockServer();
    suite.context.PORT = mock.server.address().port;
    proxy = await denyProxy(suite.context.PORT);
    await deadline(Promise.race([fatal, runBrowserSuite(extension, path.join(temp, 'profile'), edge, proxy, mock, suite, opts, report, resources)]), opts.timeout, 'Browser suite');
    report.passed = true;
  } catch (error) { report.error = error.message; emit('sandbox_error', { name: error.name || 'Error' }); }
  finally {
    if (resources.guard) resources.guard.stopping = true;
    if (suite) suite.dispose();
    try { await stopBrowser(resources.browser, resources.cdp); }
    catch (error) { cleanupError = error; }
    try { if (proxy) await proxy.close(); if (mock) await closeServer(mock.server); }
    catch (error) { cleanupError = cleanupError || error; }
    try { assert.deepEqual(inventory(ROOT), before, 'Original source changed during sandbox run'); report.sourceUnchanged = true; }
    catch (error) { report.passed = false; report.sourceUnchanged = false; report.error = error.message; }
    if (!cleanupError) {
      try { await removeOwned(temp); report.cleanup = true; }
      catch (error) { cleanupError = error; }
    }
    if (cleanupError) { report.passed = false; report.cleanupError = cleanupError.message; }
    report.finishedAt = new Date().toISOString();
    emit('sandbox_finish', { passed: report.passed, cleanup: report.cleanup, sourceUnchanged: report.sourceUnchanged === true,
      temporaryRoot: temp, loadedFrom: report.loadedFrom, mode: report.mode, sourceFingerprint: report.sourceFingerprint,
      buildHash: report.build?.sha256 || null, scenarios: report.scenarios?.length || 0, assertions: report.assertions || 0,
      failedAssertions: report.failures?.length ?? null, unexpectedRequests: report.network?.unexpectedRequests?.length ?? null,
      guardErrors: report.network?.guardErrors?.length ?? null });
    console.log('\nSANDBOX_REPORT\n' + JSON.stringify(report, null, 2));
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
  if (!report.passed) process.exitCode = 1;
  return report;
}

async function selfTest() {
  let count = 0;
  function ok(name, condition) { assert.ok(condition, name); count++; console.log('[self ok] ' + name); }
  assert.throws(() => edgePath(path.join(ROOT, 'does-not-exist-edge.exe')), /EDGE_MISSING/);
  ok('missing browser fails closed', true);
  assert.throws(() => options(['--timeout-ms', 'NaN']));
  assert.throws(() => options(['--unknown']));
  ok('invalid CLI inputs rejected', true);
  for (const url of ['https://127.0.0.1:1234/', 'http://localhost:1234/', 'http://mooc1.chaoxing.com.evil.test:1234/',
    'http://name:password@127.0.0.1:1234/', 'http://127.0.0.1:1235/', 'file:///private']) {
    ok('local allowlist rejects ' + new URL(url).protocol + ' boundary', !localUrl(url, 1234));
  }
  ok('literal local mock allowed', localUrl('http://127.0.0.1:1234/a', 1234));
  ok('mock course origin allowed', localUrl('http://mooc1.chaoxing.com:1234/a', 1234));
  const fixture = scenarioConfig('弹题反复失败会放弃而不是死循环', 1234);
  ok('previously inherited fixture is explicit and local', fixture.enableQuiz && localUrl(fixture.apiUrl, 1234));
  ok('unrelated scenarios receive no invented API config', scenarioConfig('other', 1234) === null);
  await assert.rejects(deadline(new Promise(() => {}), 10, 'fixture'), /timed out/);
  ok('deadline catches never-settling operation', true);
  await assert.rejects(removeOwned(ROOT), /not created/);
  ok('cleanup refuses original workspace', true);
  const held = net.createServer(socket => socket.end('occupied, not JSON'));
  const port = await listen(held);
  try { ok('occupied non-JSON port is not free', !(await portFree(port))); }
  finally { await closeServer(held); }
  ok('released port really accepts exclusive binding', await portFree(port));

  class FakeSocket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.handlers.open?.()); }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    send(data) {
      const request = JSON.parse(data);
      if (request.method === 'hang') return;
      if (request.method === 'throw') throw new Error('send failed');
      queueMicrotask(() => this.handlers.message({ data: JSON.stringify({ id: request.id, result: { ok: true } }) }));
    }
    close() { this.handlers.close?.(); }
  }
  const client = new Cdp('ws://fixture', FakeSocket);
  await client.connect();
  const response = client.send('ok');
  const successTimer = Array.from(client.pending.values())[0].timer;
  await response;
  ok('successful CDP request clears pending and timer', client.pending.size === 0 && successTimer._destroyed);
  await assert.rejects(client.send('throw'), /send failed/);
  ok('synchronous send failure clears pending', client.pending.size === 0);
  await assert.rejects(client.send('hang', {}, undefined, 10), /CDP timeout/);
  ok('CDP timeout clears pending', client.pending.size === 0);
  const disconnected = client.send('hang'); client.close();
  await assert.rejects(disconnected, /CDP closed/);
  ok('disconnect rejects waiting commands immediately', client.pending.size === 0);

  const stubCdp = new EventEmitter();
  const sent = [];
  stubCdp.send = async (...args) => { sent.push(args); return {}; };
  const guard = new NetworkGuard(stubCdp, 1234, '1.2.9');
  await guard.request({ sessionId: 'fixture', params: { requestId: '1', request: { url: UPDATE_URL, method: 'GET' } } });
  ok('update fixture fulfilled without network', sent.at(-1)[0] === 'Fetch.fulfillRequest');
  await guard.request({ sessionId: 'fixture', params: { requestId: '2', request: { url: 'https://external.invalid/path?private=1', method: 'POST' } } });
  ok('unexpected request denied and query redacted', sent.at(-1)[0] === 'Fetch.failRequest' && guard.denied.length === 1 && !JSON.stringify(guard.denied).includes('private'));
  await guard.request({ sessionId: 'fixture', params: { requestId: '3', request: { url: 'http://127.0.0.1:1234/quiz', method: 'GET' } } });
  ok('mock request continued', sent.at(-1)[0] === 'Fetch.continueRequest');
  await assert.rejects(strictReady({ evaluate: async () => false }, 10), /STRICT_INJECTION_FAILED/);
  ok('runtime readiness has no manual-injection fallback', true);

  const mock = http.createServer((_req, res) => res.end('local-only'));
  let proxy;
  try {
    const mockPort = await listen(mock);
    proxy = await denyProxy(mockPort);
    function proxyRequest(url) {
      return deadline(new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url }, res => {
          let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject); req.end();
      }), 2000, 'proxy fixture');
    }
    const local = await proxyRequest('http://mooc1.chaoxing.com:' + mockPort + '/fixture');
    ok('proxy forwards course mock only to loopback', local.status === 200 && local.body === 'local-only');
    const external = await proxyRequest('http://external.invalid/fixture');
    ok('proxy refuses external destination', external.status === 403 && proxy.blocked.has('external.invalid'));
  } finally { if (proxy) await proxy.close(); await closeServer(mock); }
  const suite = legacySuite(ROOT);
  try {
    ok('legacy scenarios imported without original main', suite.context.SCENARIOS.length > 0 && suite.context.checks === 0);
    ok('unknown filter selects zero (execution refuses)', selectScenarios(suite.context.SCENARIOS, { mode: 'filter', filter: 'no-such-scenario-0123' }).length === 0);
    ok('smoke selection is nonempty', selectScenarios(suite.context.SCENARIOS, { mode: 'smoke' }).length > 0);
  } finally { suite.dispose(); }
  console.log('SELF_TEST_REPORT ' + JSON.stringify({ passed: true, assertions: count }));
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.mode === 'self-test') return selfTest();
  if (opts.mode === 'list') {
    const suite = legacySuite(ROOT);
    try { suite.context.SCENARIOS.forEach((scenario, i) => console.log((i + 1) + '. ' + scenario.name)); }
    finally { suite.dispose(); }
    return;
  }
  return execute(opts);
}

function acceptancePlan() {
  const suite = legacySuite(ROOT);
  try {
    return { mode: 'full', built: true, sourceFingerprint: digest(JSON.stringify(inventory(ROOT))),
      scenarioSourceHash: suite.hash, scenarios: suite.context.SCENARIOS.map(scenario => scenario.name),
      baselines: BASELINE_FILES.concat('tools/build.js'), probes: REQUIRED_PROBES.slice() };
  } finally { suite.dispose(); }
}

module.exports = { options, localUrl, deadline, Cdp, NetworkGuard, selectScenarios, acceptancePlan, execute };
if (require.main === module) main().catch(error => { console.error('SANDBOX_FAILED: ' + error.message); process.exitCode = 1; });