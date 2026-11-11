#!/usr/bin/env node
/**
 * 集成测试：把 content.js 的**真实代码**跑起来，验证答题往返链路。`npm run itest`
 *
 * 为什么需要它：1.0.11 改动了「分批 + index 回填」这个最容易错的地方 ——
 * page.js 可能只把一部分题发过来（已有正确缓存的不再问），
 * 而 content.js 必须把这些题的**原始 index** 原样回传，不能按数组位置反推。
 * 这个场景没法靠单元测试覆盖，因为逻辑藏在 IIFE 里、又依赖 chrome.* 与 window.postMessage。
 *
 * 做法：用 vm 建一个隔离的全局，打桩 chrome / document / window.postMessage，
 * 然后加载 content.js 本体，通过它自己注册的 message 监听器驱动，
 * 再用一个「假模型」按提示词的格式要求回答案。
 *
 * 顺带验证了两件事：
 *   - libs/prompt.js 生成的提示词是**可被独立解析**的（假模型就是独立解析器）
 *   - content.js 对不同模型协议的适配（OpenAI / Claude / Gemini）
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

var failures = [];
var checks = 0;

/**
 * 等一个条件成立（最多 timeoutMs）。
 * 固定 sleep 20ms 在慢机器上会假失败 —— 注入是异步的（scope 查询 → 读配置 → 插 script），
 * 断言"注入了几次"必须等它真的发生，而不是赌 20ms 够用。
 */
function waitFor(cond, timeoutMs) {
  var started = Date.now();
  return new Promise(function (resolve) {
    (function tick() {
      var ok = false;
      try { ok = !!cond(); } catch (e) {}
      if (ok || Date.now() - started > (timeoutMs || 1000)) return resolve(ok);
      setTimeout(tick, 10);
    })();
  });
}

function check(name, condition, detail) {  checks++;
  if (condition) {
    console.log('  [ok]   ' + name);
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  [FAIL] ' + name + (detail ? ' → ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// 假模型：按 libs/prompt.js 约定的题目格式独立解析并作答
//
// 这是刻意写成"独立解析器"的 —— 如果 prompt.js 生成的题目行不可解析，
// 这里会直接答不上来，测试就会失败。等于顺带验证了提示词格式的自洽性。
// ---------------------------------------------------------------------------
var QUESTION_LINE = /^(\d+)\|([a-z])\|(.*)$/;

var ANSWER_BY_CODE = {
  s: 'A',
  m: ['A', 'C'],
  j: true,
  f: '填空甲|||填空乙',
  t: '简答文本'
};

/** 从提示词里解析出题目，返回 [{localIndex, code, title}] */
function parsePromptQuestions(promptText) {
  var out = [];
  var pending = null;
  String(promptText).split('\n').forEach(function (line) {
    var m = line.match(QUESTION_LINE);
    if (m) {
      pending = { localIndex: Number(m[1]) - 1, code: m[2], title: m[3] };
      out.push(pending);
      return;
    }
    // 选项行 / 禁选行挂到当前题上，这里不需要，忽略即可
  });
  return out;
}

/** 生成符合当前协议（位置式数组）的模型回复体 */
function fakeAnswerPositional(promptText) {
  var questions = parsePromptQuestions(promptText);
  var payload = questions.map(function (q) {
    return ANSWER_BY_CODE[q.code] || 'A';
  });
  return JSON.stringify(payload);
}

/** 生成 v1 协议（短键对象 {"i":n,"a":…}）的回复体，用于验证向后兼容 */
function fakeAnswerObjectKeys(promptText) {
  var questions = parsePromptQuestions(promptText);
  var payload = questions.map(function (q) {
    return { i: q.localIndex, a: ANSWER_BY_CODE[q.code] || 'A' };
  });
  return JSON.stringify(payload);
}

/** 生成旧 schema 的回复体，用于验证向后兼容 */
function fakeAnswerLegacySchema(promptText) {
  var questions = parsePromptQuestions(promptText);
  var payload = questions.map(function (q) {
    return { index: q.localIndex, type: 'single', answer: 'B' };
  });
  return '```json\n' + JSON.stringify(payload) + '\n```';
}

// ---------------------------------------------------------------------------
// 建隔离环境并加载 content.js
// ---------------------------------------------------------------------------
function createHarness(options) {
  options = options || {};

  var sandbox = {};
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // content.js 开头有 `if (window.top !== window) return;` —— 嵌套 iframe 直接静默退出。
  // 不补 top 的话整份脚本会立刻 return，连监听器都不会注册。
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;
  sandbox.console = { log: function () {}, error: function () {}, warn: function () {}, info: function () {} };
  sandbox.URL = URL;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.NodeFilter = { SHOW_TEXT: 4 };
  sandbox.MutationObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };

  var store = { config: Object.assign({ apiKey: 'test-key', apiType: options.apiType || 'openai', model: 'test-model', apiUrl: 'https://api.test' }, options.config || {}) };
  sandbox.__store = store;

  // Trusted study URL; DOMContentLoaded is deliberately held by the harness.
  // This tests actual scope enforcement without starting injection/font work as a side effect.
  sandbox.location = { href: options.url || 'https://mooc1.chaoxing.com/mycourse/studentstudy' };
  sandbox.__storageReads = [];
  sandbox.__runtimeMessages = [];
  sandbox.__injected = [];
  sandbox.__configPatches = [];

  // ---- document 桩
  var documentElement = {
    setAttribute: function (k, v) { documentElement._attrs = documentElement._attrs || {}; documentElement._attrs[k] = v; },
    getAttribute: function (k) { return (documentElement._attrs || {})[k]; },
    removeAttribute: function (k) { if (documentElement._attrs) delete documentElement._attrs[k]; }
  };
  var body = { innerText: '', appendChild: function () {} };
  sandbox.document = {
    readyState: 'loading',               // Test controls startup via startContent().
    documentElement: documentElement,
    head: { appendChild: function (node) { sandbox.__injected.push(node); } },
    body: body,
    _listeners: {},
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; },
    createElement: function () { return { style: {}, setAttribute: function () {}, remove: function () {}, addEventListener: function () {} }; },
    createTreeWalker: function () { return { nextNode: function () { return null; } }; }
  };

  // ---- history 桩（content.js 会包装 pushState / replaceState）
  sandbox.history = {
    pushState: function () {},
    replaceState: function () {}
  };

  // ---- 捕获 content.js 发往页面的消息（page.js 收到的就是这些）
  var posted = [];
  sandbox.__posted = posted;
  sandbox.postMessage = function (msg) { posted.push(msg); };

  // ---- 捕获 content.js 注册的两个监听器
  var messageListener = null;
  var runtimeListener = null;

  sandbox.addEventListener = function (type, fn) {
    if (type === 'message') messageListener = fn;
    // popstate / load 等无需处理
  };
  sandbox.removeEventListener = function () {};

  // ---- chrome.* 桩
  var modelResponder = options.modelResponder || fakeAnswerPositional;
  // 可选：自定义 api_fetch 的应答。返回 falsy 就走默认的"成功应答"。
  // 加它是为了测**错误路径**（例如服务商拒绝思考参数时会不会摘掉重试）——
  // 没有它就只能测成功路径，而现场出事的全是失败路径。
  var apiResponder = options.apiResponder || null;
  var sentRequests = [];
  sandbox.__sentRequests = sentRequests;

  function storageGet(keys, cb) {
    sandbox.__storageReads.push(keys);
    var result = {};
    if (typeof keys === 'string') {
      if (keys in store) result[keys] = store[keys];
    } else if (Array.isArray(keys)) {
      keys.forEach(function (k) { if (k in store) result[k] = store[k]; });
    } else if (keys && typeof keys === 'object') {
      Object.keys(keys).forEach(function (k) { result[k] = (k in store) ? store[k] : keys[k]; });
    } else {
      Object.keys(store).forEach(function (k) { result[k] = store[k]; });
    }
    if (cb) setTimeout(function () { cb(result); }, 0);
  }

  sandbox.chrome = {
    runtime: {
      lastError: null,
      getURL: function (p) { return 'chrome-extension://test/' + p; },
      onMessage: { addListener: function (fn) { runtimeListener = fn; } },
      sendMessage: function (message, cb) {
        sandbox.__runtimeMessages.push(message);
        var policy = sandbox.OmitonePolicy;
        var scope = policy && policy.isChaoxingUrl(sandbox.location.href) ? 'study' : (options.captchaAuthorized ? 'captcha' : 'none');
        function respond(value) { if (cb) setTimeout(function () { cb(value); }, 0); }
        if (message.type === 'get_page_scope') return respond({ success: true, scope: scope, expiresAt: options.expiresAt });
        if (message.type === 'runtime_log_append') {
          if (scope === 'none') return respond({ success: false, error: 'scope_denied' });
          // 本层只模拟日志回执；真正 Worker 并发/超时行为由 omitone-regression.cjs 验证。
          var logs = Array.isArray(store.runtimeLogs) ? store.runtimeLogs : [];
          logs.push(JSON.parse(JSON.stringify(message.payload)));
          store.runtimeLogs = logs.slice(-200);
          return respond({ success: true });
        }
        if (message.type === 'get_config') {
          if (scope === 'none') return respond({ success: false, error: 'scope_denied' });
          return respond({ success: true, config: scope === 'study' ? store.config : policy.publicConfig(store.config, 'captcha') });
        }
        if (message.type === 'config_patch') {
          sandbox.__configPatches.push(message.payload);
          if (message.payload.expectedFingerprint !== policy.configFingerprint(store.config)) return respond({ success: false, error: 'stale_config' });
          store.config = Object.assign({}, store.config, message.payload.patch);
          return respond({ success: true, config: store.config });
        }
        if (message.type === 'storage_set') {
          if (scope !== 'study') return respond({ success: false, error: 'scope_denied' });
          store.xxtRunning = message.payload.xxtRunning;
          return respond({ success: true });
        }
        if (message.type === 'captcha_fetch') return respond({ success: true, data: 'ABC1' });
        if (message && message.type === 'api_fetch') {
          sentRequests.push(message.payload);

          if (apiResponder) {
            var custom = apiResponder(message.payload, sentRequests.length);
            if (custom) {
              setTimeout(function () { cb(custom); }, 0);
              return;
            }
          }

          var requestBody = null;
          try { requestBody = JSON.parse(message.payload.body); } catch (e) {}
          var promptText = extractPromptText(requestBody);
          var content = modelResponder(promptText);

          var apiPayload = {
            choices: [{ message: { content: content } }],
            content: [{ text: content }],
            candidates: [{ content: { parts: [{ text: content }] } }]
          };

          setTimeout(function () {
            cb({ success: true, status: 200, statusText: 'OK', text: JSON.stringify(apiPayload), data: apiPayload });
          }, 0);
          return;
        }
        if (cb) setTimeout(function () { cb({ success: true }); }, 0);
      }
    },
    storage: {
      local: {
        get: storageGet,
        set: function (items, cb) {
          Object.keys(items || {}).forEach(function (k) { store[k] = items[k]; });
          if (cb) setTimeout(cb, 0);
        }
      },
      onChanged: { addListener: function (fn) { sandbox.__storageChanged = fn; } }
    }
  };

  // ---- 加载隔离世界里的脚本本体，顺序必须与 manifest.content_scripts.js 一致
  //
  // ⚠️ 这份清单**必须与 manifest 同步**。历史教训：libs/thinking.js 加进 manifest 之后
  // 忘了加到这里，content.js 在测试里读到 null 模块 —— 于是集成测试报的错
  // 看起来像"答题功能坏了"，其实是测试环境自己缺文件。
  // 下面这条守卫就是为了让这种漏项当场报错、而不是伪装成业务 bug。
  var INJECTED_FILES = ['libs/runtime-policy.js', 'libs/api-url.js', 'libs/api-error.js', 'libs/study-stats.js', 'libs/prompt.js', 'libs/thinking.js', 'popup/pet-game.js', 'content.js'];
  (function guardInjectionList() {
    var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    var injectedLibs = [];
    (((manifest.content_scripts || [])[0] || {}).js || []).forEach(function (f) {
      if (f.indexOf('libs/') === 0) injectedLibs.push(f);
    });
    // 只盯"content.js 会读的模块"：md5 / Typr 这类纯浏览器库不进测试沙箱是有意的
    ['libs/runtime-policy.js', 'libs/api-url.js', 'libs/api-error.js', 'libs/study-stats.js', 'libs/prompt.js', 'libs/thinking.js'].forEach(function (file) {
      if (injectedLibs.indexOf(file) === -1) {
        throw new Error('manifest 未注入 ' + file + '，但测试清单里有它 —— 两者已分叉');
      }
      if (INJECTED_FILES.indexOf(file) === -1) {
        throw new Error('manifest 注入了 ' + file + '，但测试清单里没有 —— 请同步 INJECTED_FILES');
      }
    });
  })();
  INJECTED_FILES.forEach(function (file) {
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, file), 'utf8'),
      sandbox,
      { filename: file }
    );
  });

  // ⚠️ vm 会把跨上下文的对象包成代理：宿主手里的 sandbox !== 上下文里的 window。
  // content.js 的监听器第一句就是 `if (event.source !== window) return;`，
  // 所以派发事件时必须用**从上下文内部取出来的** window，否则会被静默丢弃。
  var innerWindow = vm.runInContext('window', sandbox);

  return {
    sandbox: sandbox,
    innerWindow: innerWindow,
    startContent: function () { (sandbox.document._listeners.DOMContentLoaded || []).forEach(function (fn) { fn(); }); },
    startFromPopup: function () { return new Promise(function (resolve) { runtimeListener({ type: 'xxt_start' }, {}, resolve); }); },
    configChanged: function (config) { store.config = config; sandbox.__storageChanged({ config: { newValue: config } }, 'local'); },
    /** 模拟 page.js 发来的消息 */
    sendFromPage: function (msg) {
      if (typeof messageListener !== 'function') {
        throw new Error('content.js 未注册 message 监听器（可能被顶层的 early-return 拦掉了）');
      }
      messageListener({ source: innerWindow, data: msg });
    },
    /** 取出指定 id 的应答 */
    waitForResponse: function (id, timeoutMs) {
      timeoutMs = timeoutMs || 5000;
      var started = Date.now();
      return new Promise(function (resolve) {
        (function poll() {
          var hit = posted.filter(function (m) { return m && m.id === id && (m.type === 'llm_response' || m.type === 'config_response'); })[0];
          if (hit) return resolve(hit.data);
          if (Date.now() - started > timeoutMs) return resolve(null);
          setTimeout(poll, 10);
        })();
      });
    },
    runtimeListener: function () { return runtimeListener; }
  };
}

/** 从请求体里取出提示词文本，兼容三种协议 */
function extractPromptText(requestBody) {
  if (!requestBody) return '';
  if (requestBody.messages && requestBody.messages.length) {
    return requestBody.messages.map(function (m) { return m.content; }).join('\n');
  }
  if (requestBody.contents && requestBody.contents.length) {
    return requestBody.contents[0].parts.map(function (p) { return p.text || ''; }).join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------
async function testScopeAndSecretBoundaries() {
  console.log('\n[0] scope gate / public config / restricted storage');
  var ordinary = createHarness({ url: 'https://example.com/blank' });
  ordinary.startContent();
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  check('普通域不注入 page.js', ordinary.sandbox.__injected.length === 0);
  check('普通域不读取 storage.config', ordinary.sandbox.__storageReads.indexOf('config') === -1);

  var evil = createHarness({ url: 'https://evilchaoxing.com/course' });
  evil.startContent();
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  check('evilchaoxing 不被识别为学习通', evil.sandbox.__injected.length === 0);

  var deniedCaptcha = createHarness({ url: 'https://verify.example/captcha' });
  deniedCaptcha.startContent();
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  check('未授权外站验证码不注入', deniedCaptcha.sandbox.__injected.length === 0);

  var captcha = createHarness({ url: 'https://verify.example/captcha', captchaAuthorized: true });
  captcha.startContent();
  await waitFor(function () { return captcha.sandbox.__injected.length > 0; }, 1000);
  check('授权外站验证码可注入专用路径', captcha.sandbox.__injected.length === 1,
    '实际注入 ' + captcha.sandbox.__injected.length + ' 次');
  captcha.sendFromPage({ source: 'xxt_app', id: 900, type: 'get_config' });
  var captchaConfig = await captcha.waitForResponse(900);
  check('验证码 config 不含 API key', captchaConfig && !Object.prototype.hasOwnProperty.call(captchaConfig, 'apiKey'));
  captcha.sendFromPage({ source: 'xxt_app', id: 901, type: 'llm_captcha', payload: { image: 'data:image/png;base64,AA==' } });
  var captchaResult = await captcha.waitForResponse(901);
  check('验证码请求只转发窄 captcha_fetch', captchaResult && captchaResult.success === true && captchaResult.data === 'ABC1', JSON.stringify(captcha.sandbox.__runtimeMessages));
  check('验证码未发普通 api_fetch', captcha.sandbox.__runtimeMessages.every(function (m) { return m.type !== 'api_fetch'; }));

  captcha.sendFromPage({ source: 'xxt_app', id: 904, type: 'llm_request', payload: { questions: [] } });
  var captchaDenied = await captcha.waitForResponse(904);
  check('授权验证码仍拒绝整卷答题', captchaDenied && captchaDenied.success === false && captchaDenied.error === 'scope_denied');
  captcha.sendFromPage({ source: 'xxt_app', id: 905, type: 'llm_vision', payload: { images: [] } });
  var visionDenied = await captcha.waitForResponse(905);
  check('授权验证码仍拒绝普通视觉请求', visionDenied && visionDenied.error === 'scope_denied');
  check('授权验证码从不读取秘密 storage.config', captcha.sandbox.__storageReads.indexOf('config') === -1);

  var study = createHarness({});
  study.startContent();
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  study.sendFromPage({ source: 'xxt_app', id: 902, type: 'get_config' });
  var studyConfig = await study.waitForResponse(902);
  check('学习通页面 config 公开投影不含 API key', studyConfig && !Object.prototype.hasOwnProperty.call(studyConfig, 'apiKey') && studyConfig.hasApiKey === true);
  study.sendFromPage({ source: 'xxt_app', id: 903, type: 'storage_set', payload: { config: { apiKey: 'evil' } } });
  var storageResult = await study.waitForResponse(903);
  check('不可信 storage_set 被拒绝', storageResult && storageResult.success === false);
  var ordinaryStart = await ordinary.startFromPopup();
  check('普通域 xxt_start 结构化拒绝', ordinaryStart && ordinaryStart.success === false && ordinaryStart.error === 'scope_denied');
}

async function testIndexPlumbing() {
  console.log('\n[1] 稀疏 index 透传（page.js 只发部分题）');

  // 模拟：20 题的卷子里，page.js 因为已有正确缓存，只发了这 12 道。
  // 12 道**远大于一个 CHUNK_SIZE**，能真正验证跨批次的 index 映射（批数见下面的建模）。
  var sparseIndices = [0, 1, 2, 5, 6, 7, 9, 11, 12, 15, 16, 19];
  var types = ['single', 'multiple', 'judge', 'fill', 'short', 'single', 'multiple',
    'judge', 'fill', 'single', 'multiple', 'judge'];
  var questions = sparseIndices.map(function (idx, i) {
    return {
      index: idx,
      type: types[i],
      title: '第' + idx + '题的题干内容',
      options: (types[i] === 'single' || types[i] === 'multiple') ? ['选项甲', '选项乙', '选项丙'] : [],
      previousWrongAnswers: []
    };
  });

  var harness = createHarness({});
  harness.sendFromPage({ source: 'xxt_app', id: 1, type: 'llm_request', payload: { questions: questions } });
  var data = await harness.waitForResponse(1);

  check('收到应答', data !== null);
  if (!data) return;

  check('success = true', data.success === true, JSON.stringify(data).slice(0, 200));
  check('返回 12 条答案（输入 12 题）', Array.isArray(data.data) && data.data.length === 12,
    '实际 ' + (data.data ? data.data.length : 'n/a'));

  if (!Array.isArray(data.data)) return;

  var gotIndices = data.data.map(function (a) { return a.index; }).sort(function (a, b) { return a - b; });
  check('index 与原始稀疏下标完全一致 [' + sparseIndices.join(',') + ']',
    JSON.stringify(gotIndices) === JSON.stringify(sparseIndices),
    '实际 [' + gotIndices.join(',') + ']');

  // 批数**不写死**：CHUNK_SIZE 会变（实测 2026-10-10 从 10 调到 5，
  // 因为 10 题的批次会退化成长篇输出、顶满 max_tokens），
  // 而这条断言真正要保的是"**跨批次**的 index 映射不串味" —— 只要 ≥ 2 批就成立。
  // 直接从 content.js 里读常量，避免下次改批大小又忘了同步这里（这次就漂了一次）。
  var chunkSize = (function () {
    try {
      var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');
      var m = src.match(/const CHUNK_SIZE\s*=\s*(\d+)/);
      return m ? Number(m[1]) : 0;
    } catch (e) {
      return 0;
    }
  })();
  // 期望批数按 content.js 的分批规则建模（2026-11-10 批次 7 改过这一条）：
  // **多选随时单独成批，其余题继续凑满 chunkSize** —— 多选不连累同批的邻居。
  // 旧模型是"切片里只要有多选就整片逐题拆批"：那是"只有重试轮才把多选交回模型"时代的写法，
  // 多选默认进请求之后，它会把两道无辜的题也降成一题一批（固定开销按**批**计）。
  var expectedBatches = (function () {
    if (!(chunkSize > 0)) return 0;
    var count = 0;
    var pending = 0;
    questions.forEach(function (q) {
      if (q && q.type === 'multiple') { count++; return; }
      pending++;
      if (pending === chunkSize) { count++; pending = 0; }
    });
    if (pending) count++;
    return count;
  })();
  check('按 CHUNK_SIZE=' + chunkSize + ' 与多选拆批规则分 ' + expectedBatches + ' 批发出（跨批次不串味）',
    expectedBatches >= 2 && harness.sandbox.__sentRequests.length === expectedBatches,
    '实际 ' + harness.sandbox.__sentRequests.length + ' 批');

  // 定版策略的**硬断言**（不随 content.js 实现漂移）：任何一批 ≤3 题；
  // 含多选的批只有那一题 —— 用户 2026-10-31 定版「宁慢勿废」的上下文保护。
  var batchShapes = harness.sandbox.__sentRequests
    .filter(function (r) { return r && typeof r.body === 'string'; })
    .map(function (r) {
      try {
        var body = JSON.parse(r.body);
        var userText = (body.messages || []).filter(function (m) { return m.role === 'user'; })
          .map(function (m) { return m.content || ''; }).join('\n');
        var heads = userText.match(/^\d+\|[a-z]\|/gm) || [];
        var multi = userText.match(/^\d+\|m\|/gm) || [];
        return { n: heads.length, multi: multi.length };
      } catch (e) { return { n: -1, multi: -1, err: String(e.message).slice(0, 40) }; }
    });
  check('定版策略硬断言：每批 ≤3 题、多选独占一批（宁慢勿废的上下文保护）',
    batchShapes.length > 0 && batchShapes.every(function (b) { return b.n > 0 && b.n <= 3 && (b.multi === 0 || b.n === 1); }),
    JSON.stringify(batchShapes));

  var typesOk = data.data.every(function (a) {
    var expected = types[sparseIndices.indexOf(a.index)];
    return a.type === expected;
  });
  check('type 取自题目本身（非模型自报）', typesOk);

  var answersOk = data.data.every(function (a) {
    return a.answer !== null && a.answer !== undefined && String(a.answer).trim() !== '';
  });
  check('所有答案非空', answersOk);
}

async function testLegacySchemaCompat() {
  console.log('\n[2] 旧 schema 兼容（index/type/answer + ```json 包裹）');

  var questions = [
    { index: 3, type: 'single', title: '兼容性测试题一', options: ['甲', '乙'], previousWrongAnswers: [] },
    { index: 8, type: 'judge', title: '兼容性测试题二', options: ['正确', '错误'], previousWrongAnswers: [] }
  ];

  var harness = createHarness({ modelResponder: fakeAnswerLegacySchema });
  harness.sendFromPage({ source: 'xxt_app', id: 2, type: 'llm_request', payload: { questions: questions } });
  var data = await harness.waitForResponse(2);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true（旧格式不导致解析失败）', data.success === true, JSON.stringify(data).slice(0, 200));
  if (!Array.isArray(data.data)) return;
  var indices = data.data.map(function (a) { return a.index; }).sort(function (a, b) { return a - b; });
  check('index 正确回填为 [3,8]', JSON.stringify(indices) === '[3,8]', '实际 [' + indices.join(',') + ']');
  check('答案取自旧键 answer', data.data.every(function (a) { return a.answer === 'B'; }));
}

async function testV1ObjectCompat() {
  console.log('\n[2b] v1 对象协议兼容（{"i":n,"a":…}）');

  var questions = [
    { index: 2, type: 'single', title: '短键题一', options: ['甲', '乙'], previousWrongAnswers: [] },
    { index: 7, type: 'multiple', title: '短键题二', options: ['甲', '乙', '丙'], previousWrongAnswers: [] }
  ];

  var harness = createHarness({ modelResponder: fakeAnswerObjectKeys });
  harness.sendFromPage({ source: 'xxt_app', id: 20, type: 'llm_request', payload: { questions: questions } });
  var data = await harness.waitForResponse(20);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true（旧协议不被破坏）', data.success === true, JSON.stringify(data).slice(0, 200));
  if (!Array.isArray(data.data)) return;
  var indices = data.data.map(function (a) { return a.index; }).sort(function (a, b) { return a - b; });
  check('index 按模型回传的 i 正确回填为 [2,7]', JSON.stringify(indices) === '[2,7]', '实际 [' + indices.join(',') + ']');
  check('多选题的数组答案完整保留',
    JSON.stringify(data.data.filter(function (a) { return a.index === 7; })[0].answer) === '["A","C"]',
    JSON.stringify(data.data));
}

async function testAnswerCoercion() {
  console.log('\n[2c] 按题型规整答案形态（位置式输出的常见偏差）');

  // 模型返回的三种"偏差形状"：单选给单元素数组、判断给中文、多选给数组。
  // ⚠️ 必须**按这一批里实际有哪几题**来回，不能整卷写死一个三元素数组：
  //   批次 7 之后多选单独成批，写死的那一份会漂到别的题上（实测单选拿到的是判断的答案）。
  var SHAPE_BY_CODE = { s: ['A'], j: '正确', m: ['A', 'C'] };
  var harness = createHarness({ modelResponder: function (promptText) {
    return JSON.stringify(parsePromptQuestions(promptText).map(function (q) {
      return SHAPE_BY_CODE[q.code] !== undefined ? SHAPE_BY_CODE[q.code] : 'A';
    }));
  } });
  harness.sendFromPage({
    source: 'xxt_app', id: 21, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题', options: ['甲', '乙'], previousWrongAnswers: [] },
        { index: 1, type: 'judge', title: '判断题', options: ['正确', '错误'], previousWrongAnswers: [] },
        { index: 2, type: 'multiple', title: '多选题', options: ['甲', '乙', '丙'], previousWrongAnswers: [] }
      ]
    }
  });
  var data = await harness.waitForResponse(21);

  check('收到应答', data !== null);
  if (!data || !Array.isArray(data.data)) return;

  var byIndex = {};
  data.data.forEach(function (a) { byIndex[a.index] = a.answer; });

  check('单选收到 ["A"] → 解包成 "A"', byIndex[0] === 'A', JSON.stringify(byIndex[0]));
  check('判断收到 "正确" → 归一成 true', byIndex[1] === true, JSON.stringify(byIndex[1]));
  check('多选数组必须原样保留（不能被解包）',
    JSON.stringify(byIndex[2]) === '["A","C"]', JSON.stringify(byIndex[2]));
}

async function testParseErrorClassification() {
  console.log('\n[3] 解析失败必须归类为 parseError（不能污染 API 连接状态）');

  var harness = createHarness({ modelResponder: function () { return '抱歉，我无法回答这个问题。'; } });
  harness.sendFromPage({
    source: 'xxt_app', id: 3, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
  });
  var data = await harness.waitForResponse(3);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = false', data.success === false);
  check('带 parseError 标记', data.parseError === true, JSON.stringify(data).slice(0, 200));

  // 关键：这个标记决定 page.js 是"保留题目稍后重试"还是"标记 API 不可用并跳过整页"
  var config = harness.sandbox.__store.config || {};
  check('未写入 apiConnectionFailed（避免自锁死循环）', config.apiConnectionFailed !== true,
    'apiConnectionFailed=' + config.apiConnectionFailed);
}

/**
 * HTTP 4xx（Key 无效 / 无权限 / 模型名错）是**永久错误**：重试一万次也一样。
 *
 * ⚠️ 这条补的是 [3] 没覆盖到的那条入口 ——
 * [3] 已经保证了"解析失败不污染连接状态"，但服务商返回 401 走的是另一条路，
 * 结果被一律当成网络故障，写进 apiConnectionFailed，
 * 让 page.js 进入 45 秒退避循环。用户填错 Key 的表现是"插件卡死"，而不是"Key 错了"。
 *
 * 所以这里同时验证两件事：
 *   1) 401/403 → 不重试、不写 apiConnectionFailed
 *   2) 500/429 → 行为**不变**（仍重试、仍标记退避）—— 防止修 A 把 B 改坏
 */
async function testPermanentHttpError() {
  console.log('\n[3b] HTTP 4xx 永久错误：不重试，也不能污染 API 连接状态');

  var questions = [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }];

  // ---- 1) 401：永久错误
  var h401 = createHarness({
    apiResponder: function () {
      return { success: false, status: 401, text: '{"error":{"message":"Invalid API key"}}', error: 'HTTP 401', data: null };
    }
  });
  h401.sendFromPage({ source: 'xxt_app', id: 31, type: 'llm_request', payload: { questions: questions } });
  var d401 = await h401.waitForResponse(31);

  check('401 收到应答', d401 !== null);
  if (d401) {
    check('401 success = false', d401.success === false);
    check('401 只发 1 次请求（永久错误不该重试）',
      h401.sandbox.__sentRequests.length === 1,
      '实际发了 ' + h401.sandbox.__sentRequests.length + ' 次');
    check('401 带 permanentError 标记', d401.permanentError === true, JSON.stringify(d401).slice(0, 160));
  }
  check('401 未写入 apiConnectionFailed（否则会 45 秒退避死循环）',
    (h401.sandbox.__store.config || {}).apiConnectionFailed !== true,
    'apiConnectionFailed=' + (h401.sandbox.__store.config || {}).apiConnectionFailed);

  // ---- 2) 403：同样是永久错误
  var h403 = createHarness({
    apiResponder: function () {
      return { success: false, status: 403, text: '{"error":{"message":"Forbidden"}}', error: 'HTTP 403', data: null };
    }
  });
  h403.sendFromPage({ source: 'xxt_app', id: 32, type: 'llm_request', payload: { questions: questions } });
  await h403.waitForResponse(32);
  check('403 未写入 apiConnectionFailed',
    (h403.sandbox.__store.config || {}).apiConnectionFailed !== true);
  check('403 只发 1 次请求', h403.sandbox.__sentRequests.length === 1,
    '实际发了 ' + h403.sandbox.__sentRequests.length + ' 次');

  // ---- 3) 500：可重试的服务端错误，行为必须与修复前一致
  var h500 = createHarness({
    apiResponder: function () {
      return { success: false, status: 500, text: '{"error":{"message":"internal error"}}', error: 'HTTP 500', data: null };
    }
  });
  h500.sendFromPage({ source: 'xxt_app', id: 33, type: 'llm_request', payload: { questions: questions } });
  await h500.waitForResponse(33);
  check('500 仍然重试（服务端错误可能恢复）', h500.sandbox.__sentRequests.length === 2,
    '实际发了 ' + h500.sandbox.__sentRequests.length + ' 次');
  check('500 仍然标记 apiConnectionFailed（退避对它是对的）',
    (h500.sandbox.__store.config || {}).apiConnectionFailed === true);

  // ---- 4) 429：限流，同样属于"等一会儿能恢复"，不能当成永久错误
  var h429 = createHarness({
    apiResponder: function () {
      return { success: false, status: 429, text: '{"error":{"message":"rate limited"}}', error: 'HTTP 429', data: null };
    }
  });
  h429.sendFromPage({ source: 'xxt_app', id: 34, type: 'llm_request', payload: { questions: questions } });
  await h429.waitForResponse(34);
  check('429 不被当成永久错误（仍需重试）', h429.sandbox.__sentRequests.length === 2,
    '实际发了 ' + h429.sandbox.__sentRequests.length + ' 次');
}

/**
 * [3b+] 错误分类：报错要让人和 AI 一眼定位根因。
 *
 * 现场故障：用户 API 没钱（DeepSeek 报 402 Insufficient Balance；OpenAI 系报
 * 429 + insufficient_quota），旧文案显示「连接失败 (402): {JSON}」—— 用户去查
 * 网络、重装插件，唯独没想到充值。现在错误经 libs/api-error.js 分类：
 *   - 人看到「【账户余额不足】… 去充值」；
 *   - 返回值/日志带 errorCategory 标签 + 服务商原话（分类是翻译，不篡改证据）；
 *   - 余额类一律按永久错误处理（不重试、不写 apiConnectionFailed）。
 * 同时验证真·限流（429 无额度字样）行为不变 —— 防止修 A 把 B 改坏。
 */
async function testApiErrorClassification() {
  console.log('\n[3b+] 错误分类：没钱不再显示成连接失败');

  var questions = [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }];

  // ---- 1) 402：显式欠费 → 永久 + 人话
  var h402 = createHarness({
    apiResponder: function () {
      return { success: false, status: 402, text: '{"error":{"message":"Insufficient Balance","type":"insufficient_balance"}}', error: 'HTTP 402', data: null };
    }
  });
  h402.sendFromPage({ source: 'xxt_app', id: 41, type: 'llm_request', payload: { questions: questions } });
  var d402 = await h402.waitForResponse(41);
  check('402 收到应答', d402 !== null);
  if (d402) {
    check('402 按永久错误处理（不重试）', d402.permanentError === true && h402.sandbox.__sentRequests.length === 1,
      'requests=' + h402.sandbox.__sentRequests.length);
    check('402 文案说出「余额不足」并带上服务商原话（人/AI 都能定位）',
      /余额不足/.test(String(d402.error)) && /Insufficient Balance/.test(String(d402.error)),
      String(d402.error).slice(0, 160));
    check('402 带 errorCategory 标签', d402.errorCategory === 'balance', String(d402.errorCategory));
  }
  check('402 未写入 apiConnectionFailed（它不是网络问题）',
    (h402.sandbox.__store.config || {}).apiConnectionFailed !== true);

  // ---- 2) 429 + insufficient_quota：OpenAI 系的"没钱"报法，同样按余额处理
  var hQuota = createHarness({
    apiResponder: function () {
      return { success: false, status: 429, text: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}', error: 'HTTP 429', data: null };
    }
  });
  hQuota.sendFromPage({ source: 'xxt_app', id: 42, type: 'llm_request', payload: { questions: questions } });
  var dQuota = await hQuota.waitForResponse(42);
  check('429+insufficient_quota 按余额类永久处理（不重试）',
    !!dQuota && dQuota.permanentError === true && hQuota.sandbox.__sentRequests.length === 1,
    'requests=' + (hQuota ? hQuota.sandbox.__sentRequests.length : 'n/a'));
  check('429+insufficient_quota 文案说出「余额不足」',
    !!dQuota && /余额不足/.test(String(dQuota.error)), String(dQuota && dQuota.error).slice(0, 160));
  check('429+insufficient_quota 未写入 apiConnectionFailed',
    (hQuota.sandbox.__store.config || {}).apiConnectionFailed !== true);

  // ---- 3) 真·限流（429 + 无额度字样）：行为必须不变，文案是【触发限流】
  var hRate = createHarness({
    apiResponder: function () {
      return { success: false, status: 429, text: '{"error":{"message":"rate limit exceeded, try again later"}}', error: 'HTTP 429', data: null };
    }
  });
  hRate.sendFromPage({ source: 'xxt_app', id: 43, type: 'llm_request', payload: { questions: questions } });
  var dRate = await hRate.waitForResponse(43);
  check('普通 429 仍重试（限流等一会儿真能恢复）', hRate.sandbox.__sentRequests.length === 2,
    '实际发了 ' + hRate.sandbox.__sentRequests.length + ' 次');
  check('普通 429 文案是【触发限流】（不是余额）',
    !!dRate && /触发限流/.test(String(dRate.error)) && !/余额不足/.test(String(dRate.error)),
    String(dRate && dRate.error).slice(0, 120));

  // ---- 4) 分类器本体：一张表把各状态码钉死
  var API_ERROR = require('../libs/api-error.js');
  var c401 = API_ERROR.describe(401, '{"error":{"message":"Invalid API key"}}');
  var c402 = API_ERROR.describe(402, '{"error":{"message":"Insufficient Balance"}}');
  var c404 = API_ERROR.describe(404, '{"error":{"message":"model not found"}}');
  var c500 = API_ERROR.describe(500, '{"error":{"message":"internal error"}}');
  var cNet = API_ERROR.describe(undefined, '');
  check('分类表 401→auth / 402→balance / 404→model / 500→server / 断网→network',
    c401.category === 'auth' && c402.category === 'balance' && c404.category === 'model' &&
    c500.category === 'server' && cNet.category === 'network',
    [c401.category, c402.category, c404.category, c500.category, cNet.category].join(','));
  check('人话格式：以【类别】开头，余额文案含「充值」且保留原话',
    /^【/.test(c402.human) && /充值/.test(c402.human) && /Insufficient Balance/.test(c402.human),
    c402.human.slice(0, 80));
  check('断网文案如实说「连接不上」，不伪装成业务拒绝',
    /连接不上/.test(cNet.human), cNet.human.slice(0, 60));
}

/**
 * [3b++] 错误契约模糊测试：把随机化的服务商响应轰进真实 content.js，
 * 验证「错误信息落实」端到端成立 —— 无论送来什么，出口必须**恒定**：
 *   success=false、error 是【类别】开头的人话、permanentError 与分类规则一致、
 *   永久类不重试且不写 apiConnectionFailed、可重试类恰好重试一次。
 * 与 omitone-fuzz-test.cjs 的分工：那边在纯函数层扫全空间（1000 状态码），
 * 这边在 vm 层抽代表样本走完整请求链 —— 两层各守各的。
 */
async function testErrorContractFuzz() {
  console.log('\n[3b++] 错误契约模糊：随机响应轰进真实请求链');

  var API_ERROR = require('../libs/api-error.js');
  var questions = [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }];

  // 固定代表样本（覆盖每个类别）+ 种子化随机样本（4xx 为主，避开重试等待拖慢套件）
  var GARBAGE = ['<html>502</html>', '', '{"error":{"message":42}}', '{"error":{"message":"insufficient_quota"}}',
    '{"error":{"message":"raw ok"}}', 'null', 'Internal Server Error'];
  var fixed = [
    [402, '{"error":{"message":"Insufficient Balance"}}'],
    [401, '{"error":{"message":"Invalid API key"}}'],
    [403, '{"error":{"message":"Forbidden"}}'],
    [404, '{"error":{"message":"model not found"}}'],
    [429, '{"error":{"message":"You exceeded your current quota"}}'],
    [429, '{"error":{"message":"slow down"}}']
  ];
  var rng = mulberry32Fixed(20261031);
  var randoms = [];
  var pool = [400, 401, 402, 403, 404, 406, 409, 410, 418, 422, 428, 431, 451];
  for (var i = 0; i < 6; i++) {
    randoms.push([pool[Math.floor(rng() * pool.length)], GARBAGE[Math.floor(rng() * GARBAGE.length)]]);
  }

  var cases = fixed.concat(randoms);
  var bad = [];
  for (var c = 0; c < cases.length; c++) {
    var st = cases[c][0];
    var body = cases[c][1];
    var h = createHarness({
      apiResponder: function () {
        return { success: false, status: st, text: body, error: 'HTTP ' + st, data: null };
      }
    });
    h.sendFromPage({ source: 'xxt_app', id: 700 + c, type: 'llm_request', payload: { questions: questions } });
    var d = await h.waitForResponse(700 + c);
    var described = API_ERROR.describe(st, body);
    var expectedPermanent = (st >= 400 && st < 500 && st !== 429) || described.category === 'balance';
    if (!d || d.success !== false) { bad.push('@' + st + ' 未失败返回'); continue; }
    if (typeof d.error !== 'string' || d.error.indexOf('【') !== 0) { bad.push('@' + st + ' 文案缺【类别】: ' + String(d.error).slice(0, 40)); continue; }
    if (d.error.indexOf('HTTP ' + st) === -1 && described.category !== 'network') { bad.push('@' + st + ' HTTP 码丢失'); continue; }
    if (!!d.permanentError !== expectedPermanent) { bad.push('@' + st + ' permanentError=' + !!d.permanentError + ' 期望 ' + expectedPermanent); continue; }
    if (expectedPermanent) {
      if (d.errorCategory !== described.category) { bad.push('@' + st + ' 标签不一致: ' + d.errorCategory); continue; }
      if (h.sandbox.__sentRequests.length !== 1) { bad.push('@' + st + ' 永久类却重试了'); continue; }
      if ((h.sandbox.__store.config || {}).apiConnectionFailed === true) { bad.push('@' + st + ' 污染了连接状态'); continue; }
    } else {
      if (h.sandbox.__sentRequests.length !== 2) { bad.push('@' + st + ' 可重试类没重试'); continue; }
      if ((h.sandbox.__store.config || {}).apiConnectionFailed !== true) { bad.push('@' + st + ' 可重试类应写退避'); continue; }
    }
  }
  check('错误契约模糊 ' + cases.length + ' 例：出口恒定（人话 / 标签 / 永久判定 / 重试与退避互恰）',
    bad.length === 0, bad.slice(0, 3).join(' | '));

  // 断网形态：响应体里连 status 都没有 —— 必须走网络分支并写退避
  var hNet = createHarness({
    apiResponder: function () {
      return { success: false, error: '后台请求失败 —— 无法把请求转发给服务商（网络不通或扩展刚被重载）' };
    }
  });
  hNet.sendFromPage({ source: 'xxt_app', id: 790, type: 'llm_request', payload: { questions: questions } });
  var dNet = await hNet.waitForResponse(790);
  check('无状态码的失败如实报「连接不上服务商」并写退避（这才是真网络问题）',
    !!dNet && dNet.success === false && dNet.permanentError !== true &&
    /连接不上/.test(String(dNet.error)) &&
    (hNet.sandbox.__store.config || {}).apiConnectionFailed === true,
    JSON.stringify({ error: dNet && String(dNet.error).slice(0, 60) }));
}

/** 与 omitone-fuzz-test.cjs 同款的种子随机（两处各留一份，避免为测试建共享模块） */
function mulberry32Fixed(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function testPermanentRoundStopAndConfigRace() {
  console.log('\n[3c] permanent failures stop the whole round; config state is request-scoped');
  var questions = Array.from({ length: 12 }, function (_, index) {
    return { index: index, type: 'single', title: 'Question ' + index, options: ['A', 'B'] };
  });
  function unauthorized() { return { success: false, status: 401, text: 'Invalid API key' }; }
  var first = createHarness({ apiResponder: unauthorized });
  first.sendFromPage({ source: 'xxt_app', id: 910, type: 'llm_request', payload: { questions: questions } });
  var firstResult = await first.waitForResponse(910);
  check('401 跨三批仅发一次请求', first.sandbox.__sentRequests.length === 1 && firstResult && firstResult.permanentError === true);

  for (var retryStatus of [500, 429]) {
    var retry = createHarness({ apiResponder: function () { return { success: false, status: retryStatus, text: 'temporary failure' }; } });
    retry.sendFromPage({ source: 'xxt_app', id: 916 + retryStatus, type: 'llm_request', payload: { questions: questions.slice(0, 6) } });
    var retryResult = await retry.waitForResponse(916 + retryStatus);
    check(retryStatus + ' 跨批仍重试，不被扩大为永久错误', retry.sandbox.__sentRequests.length === 4 && retryResult && !retryResult.permanentError);
  }

  var partial = createHarness({ apiResponder: function (_, count) { return count === 1 ? null : unauthorized(); } });
  partial.sendFromPage({ source: 'xxt_app', id: 911, type: 'llm_request', payload: { questions: questions } });
  var partialResult = await partial.waitForResponse(911);
  check('后续批 401 保留部分数据但整轮失败且不补问', partial.sandbox.__sentRequests.length === 2 && partialResult && partialResult.success === false && partialResult.permanentError && partialResult.partial && partialResult.data.length === 3);

  var split = createHarness({ apiResponder: function (_, count) {
    if (count === 1) {
      var data = { choices: [{ finish_reason: 'length', message: { content: '[]' } }] };
      return { success: true, status: 200, text: JSON.stringify(data), data: data };
    }
    return unauthorized();
  } });
  split.sendFromPage({ source: 'xxt_app', id: 912, type: 'llm_request', payload: { questions: questions } });
  var splitResult = await split.waitForResponse(912);
  check('拆批左侧 401 后不请求右侧/下一批/补问', split.sandbox.__sentRequests.length === 2 && splitResult && splitResult.permanentError);

  var refill = createHarness({ modelResponder: function () { return '["A",null]'; }, apiResponder: function (_, count) { return count > 1 ? unauthorized() : null; } });
  refill.sendFromPage({ source: 'xxt_app', id: 913, type: 'llm_request', payload: { questions: questions.slice(0, 2) } });
  var refillResult = await refill.waitForResponse(913);
  check('补问 401 不把先前部分数据伪装成功', refill.sandbox.__sentRequests.length === 2 && refillResult && refillResult.success === false && refillResult.permanentError && refillResult.data.length === 1);

  var failedRace;
  failedRace = createHarness({ apiResponder: function () {
    failedRace.sandbox.__store.config = Object.assign({}, failedRace.sandbox.__store.config, { apiKey: 'new-key', apiConnectionFailed: false });
    return { success: false, status: 500, text: 'temporary failure' };
  } });
  failedRace.sendFromPage({ source: 'xxt_app', id: 914, type: 'llm_request', payload: { questions: questions.slice(0, 1) } });
  await failedRace.waitForResponse(914);
  check('旧请求失败不回写新 API 配置连接状态', failedRace.sandbox.__store.config.apiConnectionFailed === false && failedRace.sandbox.__configPatches.length === 1 && failedRace.sandbox.__configPatches[0].expectedFingerprint !== failedRace.sandbox.OmitonePolicy.configFingerprint(failedRace.sandbox.__store.config));

  var successRace;
  successRace = createHarness({ apiResponder: function () {
    successRace.sandbox.__store.config = Object.assign({}, successRace.sandbox.__store.config, { apiKey: 'new-key', apiConnectionFailed: true });
    return null;
  } });
  successRace.sendFromPage({ source: 'xxt_app', id: 915, type: 'llm_request', payload: { questions: questions.slice(0, 1) } });
  await successRace.waitForResponse(915);
  check('旧请求成功不清除新 API 配置失败状态', successRace.sandbox.__store.config.apiConnectionFailed === true && successRace.sandbox.__configPatches.length === 1);
}

async function testMissingApiKey() {
  console.log('\n[4] 未配置 API Key 时明确拒绝');

  var harness = createHarness({ config: { apiKey: '' } });
  harness.sendFromPage({
    source: 'xxt_app', id: 4, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
  });
  var data = await harness.waitForResponse(4);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = false', data.success === false);
  check('未发出任何模型请求', harness.sandbox.__sentRequests.length === 0,
    '实际 ' + harness.sandbox.__sentRequests.length + ' 次');
}

async function testClaudeProtocol() {
  console.log('\n[5] Claude 协议适配');

  var harness = createHarness({ apiType: 'claude', config: { apiUrl: 'https://api.anthropic.com' } });
  harness.sendFromPage({
    source: 'xxt_app', id: 5, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: 'Claude 题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
  });
  var data = await harness.waitForResponse(5);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true', data.success === true, JSON.stringify(data).slice(0, 200));

  var sent = harness.sandbox.__sentRequests[0];
  check('请求打到 /v1/messages', !!sent && /\/v1\/messages$/.test(sent.url), sent ? sent.url : 'n/a');
  var body = sent ? JSON.parse(sent.body) : null;
  check('system 走顶层 system 字段', !!body && typeof body.system === 'string' && body.system.length > 0);
  check('携带 anthropic-version 头', !!sent && sent.headers['anthropic-version'] === '2023-06-01');
}

async function testGeminiProtocol() {
  console.log('\n[6] Gemini 协议适配');

  var harness = createHarness({ apiType: 'gemini', config: { apiUrl: 'https://generativelanguage.googleapis.com' } });
  harness.sendFromPage({
    source: 'xxt_app', id: 6, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: 'Gemini 题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
  });
  var data = await harness.waitForResponse(6);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true', data.success === true, JSON.stringify(data).slice(0, 200));
  var sent = harness.sandbox.__sentRequests[0];
  check('URL 含 generateContent 与 key', !!sent && /generateContent/.test(sent.url) && /[?&]key=/.test(sent.url), sent ? sent.url : 'n/a');
}

async function testPromptContainsBannedAnswers() {
  console.log('\n[7] 历史错误答案必须以"禁:"标注进提示词');

  var harness = createHarness({});
  harness.sendFromPage({
    source: 'xxt_app', id: 7, type: 'llm_request',
    payload: {
      questions: [{
        index: 0, type: 'single', title: '有过错误记录的题', options: ['甲', '乙', '丙'],
        previousWrongAnswers: ['A', 'C']
      }]
    }
  });
  await harness.waitForResponse(7);

  var sent = harness.sandbox.__sentRequests[0];
  var body = sent ? JSON.parse(sent.body) : null;
  var prompt = body ? extractPromptText(body) : '';
  // 断言只针对 **user 消息**：system 里也有「禁:」这个说明词，用整段 prompt 做 indexOf
  // 会被它命中，得出的先后顺序是假的。
  var userPrompt = (body && body.messages && body.messages[1]) ? String(body.messages[1].content) : '';
  var bannedAt = userPrompt.indexOf('禁:');

  check('提示词含禁选项标注', prompt.indexOf('禁:') !== -1, prompt.slice(0, 220));
  check('禁选项标注带题号', bannedAt !== -1 && userPrompt.indexOf('禁:1=A,C') !== -1, userPrompt.slice(-120));
  check('输出格式说明排在最前（稳定头，所有请求共享同一前缀）',
    userPrompt.indexOf('输出:[') === 0, userPrompt.slice(0, 60));
  check('禁选项标注位于全部题目之后（易变内容不污染前缀）',
    bannedAt > userPrompt.lastIndexOf('丙'), userPrompt.slice(-120));
  check('题目块内不再夹带禁选项（前缀逐字节稳定）',
    bannedAt !== -1 && userPrompt.slice(0, bannedAt).indexOf('禁') === -1, userPrompt.slice(0, 200));
}

async function testEmptyAnswerRefill() {
  console.log('\n[8] 空答案补问（模型漏答一题时只重问漏掉的题，不整卷重答）');

  // 第一次请求：3 题只答对 2 题，判断题返回空串（真实日志里出现过的偏差）。
  // 补问请求：把漏掉的题完整答上。
  var calls = 0;
  var harness = createHarness({
    modelResponder: function (promptText) {
      calls++;
      if (calls === 1) return JSON.stringify(['A', '', 'B']);
      // 补问只包含未答上的判断题
      return JSON.stringify([true]);
    }
  });
  harness.sendFromPage({
    source: 'xxt_app', id: 8, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题甲', options: ['甲', '乙'], previousWrongAnswers: [] },
        { index: 1, type: 'judge', title: '判断题乙', options: ['正确', '错误'], previousWrongAnswers: [] },
        { index: 2, type: 'single', title: '单选题丙', options: ['甲', '乙'], previousWrongAnswers: [] }
      ]
    }
  });
  var data = await harness.waitForResponse(8);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true（部分成功触发补问而不是失败）', data.success === true, JSON.stringify(data).slice(0, 200));
  if (!Array.isArray(data.data)) return;

  var byIndex = {};
  data.data.forEach(function (a) { byIndex[a.index] = a.answer; });
  check('3 题全部有答案（含补问的判断题）',
    byIndex[0] === 'A' && byIndex[1] === true && byIndex[2] === 'B',
    JSON.stringify(byIndex));

  check('共发出 2 次请求（原批 + 1 次补问）', harness.sandbox.__sentRequests.length === 2,
    '实际 ' + harness.sandbox.__sentRequests.length + ' 次');

  var refillPrompt = extractPromptText(JSON.parse(harness.sandbox.__sentRequests[1].body));
  check('补问只包含漏答的判断题',
    refillPrompt.indexOf('判断题乙') !== -1 && refillPrompt.indexOf('单选题甲') === -1,
    refillPrompt.slice(0, 160));
  check('补问的答案按原 index 回填（index=1）', byIndex[1] === true, JSON.stringify(byIndex[1]));
}

// ---------------------------------------------------------------------------
// [8b] 单选题多吐一个字母（2026-11-11 真实卷子的当场形状）：并回同一题，别整批丢弃
//
// 为什么单独立一条：那天的日志里 `llm answer count mismatch, batch discarded`
// 主批 + 补问一共响了 10 次，`excerpt` 是 `["A","D",true,"历史|||人民"]` ——
// **答案其实全在**，只因为 3 道题回了 4 项就被整批扔掉，
// 于是那份 20 题的卷子「填空题空的，单选题欠了几个」（用户原话）。
// 上面两个救法够不着这种形状：resegment 只归多选（多选独占一批），
// trimTrailing 只切尾部，而多出来的字母夹在中间。
//
// ⚠️ 同时钉住**反向**的那半：形状有歧义时（相邻两题都是单选，并给谁都成立）
// 必须仍然丢弃 —— 错位把答案填到别的题上，比留空重问糟得多。
// ---------------------------------------------------------------------------
async function testMiddleOptionLetterAbsorb() {
  console.log('\n[8b] 单选多吐一个字母（夹在中间）并回该题，有歧义时仍不猜');

  var harness = createHarness({
    modelResponder: function () { return JSON.stringify(['A', 'D', true, '历史|||人民']); }
  });
  harness.sendFromPage({
    source: 'xxt_app', id: 82, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题甲', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 1, type: 'judge', title: '判断题乙', options: ['正确', '错误'], previousWrongAnswers: [] },
        { index: 2, type: 'fill', title: '填空题丙', options: [], previousWrongAnswers: [] }
      ]
    }
  });
  var data = await harness.waitForResponse(82);

  check('收到应答', data !== null);
  if (!data) return;
  check('success = true（这一批不再整批丢弃）', data.success === true, JSON.stringify(data).slice(0, 240));
  if (!Array.isArray(data.data)) return;

  var byIndex = {};
  data.data.forEach(function (a) { byIndex[a.index] = a.answer; });
  check('三道题一个不少（0/1/2 全有答案）',
    Object.keys(byIndex).length === 3, JSON.stringify(byIndex));
  check('单选拿到 A（吸收多余字母，不是丢掉整批）', byIndex[0] === 'A', JSON.stringify(byIndex[0]));
  check('判断仍是 true —— 没被多出来的那个字母顶下去', byIndex[1] === true, JSON.stringify(byIndex[1]));
  check('填空仍是「历史|||人民」（用户看到"填空全空"的正是这一格）',
    byIndex[2] === '历史|||人民', JSON.stringify(byIndex[2]));

  var logs = (harness.sandbox.__store && harness.sandbox.__store.runtimeLogs) || [];
  var absorbed = logs.filter(function (e) { return String(e.message || '').indexOf('absorbed') >= 0; });
  var discarded = logs.filter(function (e) { return String(e.message || '').indexOf('batch discarded') >= 0; });
  check('日志写的是 absorbed，不是 discarded（现场靠这一条分辨救没救上）',
    absorbed.length >= 1 && discarded.length === 0,
    'absorbed=' + absorbed.length + ' discarded=' + discarded.length +
    ' | ' + JSON.stringify(logs.map(function (e) { return e.message; })).slice(0, 200));

  // ===== 歧义形状必须仍然不采用 =====
  // [single, single, fill] 收到 4 项：把 'D' 并给第 0 题、或把 'E' 并给第 1 题，
  // 两种切法都说得通 —— 这时任何"看起来对"的猜测都可能把答案填到隔壁题上。
  var amb = createHarness({
    modelResponder: function () { return JSON.stringify(['A', 'D', 'E', '填空答案']); }
  });
  amb.sendFromPage({
    source: 'xxt_app', id: 83, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题甲', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 1, type: 'single', title: '单选题乙', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 2, type: 'fill', title: '填空题丙', options: [], previousWrongAnswers: [] }
      ]
    }
  });
  var ambData = await amb.waitForResponse(83);
  check('歧义形状收到应答', ambData !== null);
  if (ambData && Array.isArray(ambData.data)) {
    var ambBy = {};
    ambData.data.forEach(function (a) { ambBy[a.index] = a.answer; });
    var fillGotLetter = typeof ambBy[2] === 'string' && /^[A-Za-z]$/.test(ambBy[2].trim());
    check('有歧义时不猜：填空题绝不拿到光一个选项字母', !fillGotLetter, JSON.stringify(ambBy[2]));
  } else {
    check('有歧义时不猜：整批仍按丢弃处理', true);
  }
  var ambLogs = (amb.sandbox.__store && amb.sandbox.__store.runtimeLogs) || [];
  check('歧义那一批没有被 absorbed 采用（日志里不许出现 absorbed）',
    ambLogs.every(function (e) { return String(e.message || '').indexOf('absorbed') < 0; }),
    JSON.stringify(ambLogs.map(function (e) { return e.message; })).slice(0, 200));
}

// ---------------------------------------------------------------------------
// [9] 字形映射表：运行时解码器必须与明文表给出同样的结果
//
// 二进制表（122KB）替代了明文 JSON（347KB），这里验的就是 content.js 实际调用的
// 那两个入口：`FONT_TABLE.decode`（正常路径）与 `FONT_TABLE.fromObject`（退路）。
// 两者必须逐条等价，否则"扩展里能解出题干、源码目录下解不出"这种事会悄悄发生。
// ---------------------------------------------------------------------------
async function testFontTable() {
  console.log('\n[9] 字形映射表（二进制与明文必须等价）');

  var FONT_TABLE = require('../libs/font-table.js');
  var fs = require('fs');
  var path = require('path');
  var root = path.join(__dirname, '..');

  var json = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'table.json'), 'utf8'));
  var bin = fs.readFileSync(path.join(root, 'resources', 'table.bin'));

  var binary = FONT_TABLE.decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  var plain = FONT_TABLE.fromObject(json);

  check('二进制表可解码', !!binary && binary.size > 10000, binary ? String(binary.size) : 'null');
  check('明文表可包装成同一接口', !!plain && plain.size === binary.size,
    plain ? String(plain.size) : 'null');

  var hashes = Object.keys(json).filter(function (k) { return FONT_TABLE.hashCodePoint(k) >= 0; });
  var mismatch = 0;
  var sample = '';
  for (var i = 0; i < hashes.length; i++) {
    var a = binary.get(hashes[i]);
    var b = plain.get(hashes[i]);
    if (a !== b || !a) { mismatch++; if (!sample) sample = hashes[i] + ': bin=' + JSON.stringify(a) + ' json=' + JSON.stringify(b); }
  }
  check('两条路径逐条一致（' + hashes.length + ' 条）', mismatch === 0,
    mismatch ? mismatch + ' 条不一致，样本 ' + sample : '全一致');

  // 反向验证：坏数据必须被拒绝，否则 content.js 不会退回到明文表 ——
  // 拿着一堆序号当哈希查，症状是"题干一直解不出来"，而日志里什么都不会有
  var broken = Buffer.from(bin);
  broken[0] = 0x00;
  check('magic 被破坏时返回 null（据此回退明文表）', FONT_TABLE.decode(
    broken.buffer.slice(broken.byteOffset, broken.byteOffset + broken.byteLength)) === null);

  var truncated = Buffer.from(bin.subarray(0, 100));
  check('数据被截断时返回 null', FONT_TABLE.decode(
    truncated.buffer.slice(truncated.byteOffset, truncated.byteOffset + truncated.byteLength)) === null);

  // 命中 / 未命中
  var firstHash = hashes[0];
  check('已知哈希能查到字符', binary.get(firstHash) === String.fromCharCode(json[firstHash]),
    JSON.stringify(binary.get(firstHash)));
  check('未知哈希返回空串（不是 undefined，调用点直接当假值用）',
    binary.get('deadbeef') === '', JSON.stringify(binary.get('deadbeef')));
}

// ---------------------------------------------------------------------------
// [10] 思考强度按渠道白名单发参数
//
// 这一段的重点是**不该发的千万别发**：升级前写死"只对 DeepSeek 加 thinking"，
// 其他服务商一个思考参数都收不到。现在改成表驱动，最大的回归风险就是
// 给某家发了它不认识的字段 → 对方直接 400 → 用户看到"换成 Kimi 就不能答题了"。
// 所以断言里"什么都没有"和"有正确的字段"一样重要。
// ---------------------------------------------------------------------------
async function testThinkingLevels() {
  console.log('\n[10] 思考强度：按渠道白名单发参数');

  var THINKING = require('../libs/thinking.js');
  var CASES = [
    { name: 'DeepSeek / 关闭（升级前的行为，必须一字不差）',
      cfg: { apiUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingLevel: 'off' },
      expect: { thinking: { type: 'disabled' } }, forbid: ['reasoning_effort'] },
    { name: 'DeepSeek / 低',
      cfg: { apiUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingLevel: 'low' },
      expect: { thinking: { type: 'enabled' }, reasoning_effort: 'low' }, forbid: [] },
    { name: 'Kimi / 关闭（K3 关不掉，那就一个参数都不发）',
      cfg: { apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', thinkingLevel: 'off' },
      expect: {}, forbid: ['thinking', 'reasoning_effort', 'enable_thinking'] },
    { name: '通义 / 关闭（显式发 false，因为商业版默认关、开源版默认开）',
      cfg: { apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-flash', thinkingLevel: 'off' },
      expect: { enable_thinking: false }, forbid: ['thinking'] },
    { name: '认不出的渠道 / 关闭 —— 一个参数都不发（最安全的默认）',
      cfg: { apiUrl: 'https://my-proxy.example.com/v1', model: 'whatever', thinkingLevel: 'off' },
      expect: {}, forbid: ['thinking', 'reasoning_effort', 'enable_thinking'] }
  ];

  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    var harness = createHarness({ config: c.cfg });
    var id = 100 + i;
    harness.sendFromPage({
      source: 'xxt_app', id: id, type: 'llm_request',
      payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
    });
    await harness.waitForResponse(id);

    var sent = harness.sandbox.__sentRequests[0];
    var body = sent ? JSON.parse(sent.body) : null;
    if (!body) {
      check(c.name + ' —— 拿得到请求体', false, '没有发出请求');
      continue;
    }
    var expectedKeys = Object.keys(c.expect);
    var ok = expectedKeys.every(function (k) {
      return JSON.stringify(body[k]) === JSON.stringify(c.expect[k]);
    });
    check(c.name + ' —— 该带的字段带对了', ok,
      '期望 ' + JSON.stringify(c.expect) + '，实际 thinking=' + JSON.stringify(body.thinking)
      + ' reasoning_effort=' + JSON.stringify(body.reasoning_effort)
      + ' enable_thinking=' + JSON.stringify(body.enable_thinking));
    var leaked = c.forbid.filter(function (k) { return k in body; });
    check(c.name + ' —— 不该带的字段一个都没有', leaked.length === 0,
      leaked.length ? '多发了：' + leaked.join(',') : '干净');
  }

  // 反向验证 ①：档位写成非法值必须回落 'off'（而不是让 undefined 混进请求体）
  check('非法档位回落 off', THINKING.normalizeLevel('bogus') === 'off'
    && Object.keys(THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingLevel: 'bogus' }).params).length === 1,
    'normalizeLevel(bogus)=' + THINKING.normalizeLevel('bogus'));

  // 反向验证 ②：服务商**拒绝**思考参数时必须摘掉重试，而不是把整次答题判死。
  // 这条是失败路径，没有它就只能等用户现场撞上"换个模型就一直 400"。
  var rejected = [];
  var retryHarness = createHarness({
    config: { apiUrl: 'https://my-proxy.example.com/v1', model: 'proxy-x', thinkingLevel: 'high' },
    apiResponder: function (payload) {
      var body = {};
      try { body = JSON.parse(payload.body); } catch (e) {}
      rejected.push(Object.keys(body).filter(function (k) {
        return k === 'reasoning_effort' || k === 'thinking' || k === 'enable_thinking';
      }));
      if (body.reasoning_effort) {
        return {
          success: false, status: 400, statusText: 'Bad Request',
          text: '{"error":"unknown parameter: reasoning_effort"}', data: null
        };
      }
      return null; // 第二次放行，走默认成功应答
    }
  });
  retryHarness.sendFromPage({
    source: 'xxt_app', id: 200, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }
  });
  var retryData = await retryHarness.waitForResponse(200);
  check('被拒绝后仍拿到答案（没有把整次答题判死）', !!retryData && retryData.success === true,
    JSON.stringify(retryData).slice(0, 160));
  check('共发 2 次请求（先带参数、再摘掉参数）', retryHarness.sandbox.__sentRequests.length === 2,
    '实际 ' + retryHarness.sandbox.__sentRequests.length + ' 次');
  check('第一次确实带了 reasoning_effort', rejected.length > 0 && rejected[0].indexOf('reasoning_effort') !== -1,
    JSON.stringify(rejected));
  var secondBody = retryHarness.sandbox.__sentRequests[1]
    ? JSON.parse(retryHarness.sandbox.__sentRequests[1].body) : {};
  check('第二次已经摘掉思考参数', !('reasoning_effort' in secondBody) && !('thinking' in secondBody),
    JSON.stringify(secondBody).slice(0, 160));
}

/**
 * ---- [11] API Key 清洗：引号与 Bearer 的剥离顺序 ----
 *
 * 这条盯的是一个**静默**的坑：`normalizeApiKey` 原先先剥 `Bearer`、**后**剥引号。
 * 于是从 JSON 配置里整段复制出来的 `"Bearer sk-xxx"`（引号把 Bearer 一起包住）：
 *   - 先剥 Bearer：它以引号开头，`^Bearer` 匹配不上 → 原样留着
 *   - 再剥引号：变成 `Bearer sk-xxx` —— **前缀还在**
 *
 * 调用方是这么用的（`content.js`）：`'Authorization': 'Bearer ' + normalizeApiKey(key)`
 * → 真正发出去的是 **`Bearer Bearer sk-xxx`** → 服务端一律 **401**。
 *
 * **为什么值得单独立一条**：症状是"Key 明明是对的却报 401"，
 * 而项目里现成的排查路径（`_markQuizApiConnectionFailed`、模型 401 那个场景）
 * 会把人引向"Key 填错了 / 额度没了"，**方向完全错**。
 */
async function testApiKeyNormalize() {
  console.log('\n[11] API Key 清洗（引号与 Bearer 的剥离顺序）');

  var API = require('../libs/api-url.js');

  var CASES = [
    ['sk-abc', 'sk-abc'],
    ['  sk-abc  ', 'sk-abc'],
    ['Bearer sk-abc', 'sk-abc'],
    ['bearer sk-abc', 'sk-abc'],
    ['Bearer   sk-abc', 'sk-abc'],
    ['"sk-abc"', 'sk-abc'],
    ["'sk-abc'", 'sk-abc'],
    ['Bearer "sk-abc"', 'sk-abc'],
    ['"Bearer sk-abc"', 'sk-abc'],            // ← 这条就是那个 bug 的形态
    ["'Bearer sk-abc'", 'sk-abc'],
    ['"  Bearer sk-abc  "', 'sk-abc'],
    ['', ''],
    [null, ''],
    ['Bearer', '']
  ];

  CASES.forEach(function (c, i) {
    var got = API.normalizeApiKey(c[0]);
    check('清洗 #' + (i + 1) + ' ' + JSON.stringify(c[0]) + ' → ' + JSON.stringify(c[1]),
      got === c[1], '实际 ' + JSON.stringify(got));
  });

  // 反向对照：**键名里本来就带 Bearer** 的不能被误剥。
  // 没有这两条，把规则写成"见到 Bearer 就删"也能全绿 —— 而那会破坏合法的 key。
  ['Bearersk-abc', 'sk-Bearer-x'].forEach(function (raw) {
    check('不能误剥：' + JSON.stringify(raw) + ' 原样返回',
      API.normalizeApiKey(raw) === raw, '实际 ' + JSON.stringify(API.normalizeApiKey(raw)));
  });

  // 真正用户看得见的那一步：拼进 Authorization 头之后不能出现两个 Bearer
  var header = 'Bearer ' + API.normalizeApiKey('"Bearer sk-abc"');
  check('拼成 Authorization 头后只有一个 Bearer（否则服务端 401）',
    header === 'Bearer sk-abc', JSON.stringify(header));
}

/**
 * ---- [12] index 归一化的边界：`Number(null)` 是 0 ----
 *
 * `normalizeItem` 开头就写明：**`index` 为 null 表示"按位置对齐"**。
 * 但原先是直接 `Number(rawIndex)` —— 而 `Number(null)` 和 `Number('')` **都是 0**，
 * 于是模型显式回了 `"i": null`（意思是"我没给序号"）时会被当成 **index = 0**：
 * 那条答案被硬塞给第 0 题，真正该拿它的那一题落空，
 * 然后白跑一轮"空答案补问" —— **多花一次请求的 token**（这个项目最在意的成本项）。
 *
 * ⚠️ 反向对照必须有：`i: 0` 就是**货真价实的第 0 题**，不能和"没给"混为一谈。
 * 没有那几条，把规则写成"见到 0 就当没给"也能全绿。
 */
async function testNormalizeItemIndex() {
  console.log('\n[12] index 归一化（显式 null / 空串不能被当成 index 0）');

  var PROMPT = require('../libs/prompt.js');

  var CASES = [
    [{ a: 'A' }, null, '没给 index → 按位置对齐'],
    [{ a: 'A', i: null }, null, '显式 i:null → 按位置对齐（这就是被修掉的那条）'],
    [{ a: 'A', i: '' }, null, '空串 i:"" → 按位置对齐'],
    [{ a: 'A', index: null }, null, '旧键名 index:null 同理'],
    [{ a: 'A', i: 0 }, 0, 'i=0 是**货真价实的第 0 题**，不能当成"没给"'],
    [{ a: 'A', i: 2 }, 2, '正常序号'],
    [{ a: 'A', i: '1' }, 1, '数字串也认'],
    [{ a: 'A', index: 3 }, 3, '旧键名 index 也认'],
    [{ a: 'A', i: -1 }, null, '负数序号无效 → 按位置'],
    [{ a: 'A', i: 'abc' }, null, '非数字 → 按位置'],
    [['A', 'C'], null, '数组（多选）是位置式，不能被当成包装对象']
  ];

  CASES.forEach(function (c, i) {
    var got = PROMPT.normalizeItem(c[0]);
    var index = got ? got.index : undefined;
    check('#' + (i + 1) + ' ' + JSON.stringify(c[0]) + ' → index ' + JSON.stringify(c[1]) +
      '（' + c[2] + '）', index === c[1], '实际 index ' + JSON.stringify(index));
  });

  // 多选答案不能被丢掉 —— 数组必须原样归到"位置式"
  var multi = PROMPT.normalizeItem(['A', 'C']);
  check('多选数组答案完整保留（不是被当成 {a:…} 包装对象后丢掉）',
    !!multi && Array.isArray(multi.answer) && multi.answer.join('') === 'AC',
    JSON.stringify(multi));
}

/**
 * 跨层契约：页面里写出的取证字段，必须能在 worker 落盘清洗**之后**还读得出东西。
 *
 * 为什么要有这一条（批次 10-A；现场是用户 2026-11-11 导出的真实日志）：
 *   批次 9-D 给被拒的帧加了 `rejects[].sig`，e2e 里断言「字段都在」—— 全绿。
 *   可用户那份日志里这条长这样：
 *     `"sig":{"answer":0,"frames":1,"qHit":"[truncated]","text":""}`
 *   原因在 `runtime-log-store.js` 的 `cleanLogMeta`：深度 ≥4 的值一律压成 `'[truncated]'`，
 *   而这条路径是 meta(0) → rejects(1) → 单条帧(2) → sig(3) → **sig 里的对象/数组 = 第 4 层**。
 *   批次 9 那版 `qHit` 正好是「选择器 → 命中数」的对象。**两层各自都没错，拼起来才是 bug** ——
 *   单独测页面（字段齐全）或单独测存储（截断规则）都测不出来，只能两层一起跑。
 *
 * ⚠️ 两处都不打桩：sig 由 `_frameRejectSignature` 的**函数源码本体**算出来，
 *   日志由 `create().handle()` 真写一遍。以后谁再往 sig 里塞嵌套对象，这里当场变红，
 *   而不是等用户再导一次日志才发现取证字段自己是空的。
 *   反向对照（对象**必须**被压掉）也在 —— 不会失败的检查等于没有检查。
 */
async function testRejectSignatureSurvivesLogStore() {
  console.log('\n[13] 被拒帧取证必须活过日志落盘深度闸（page.js → runtime-log-store.js）');

  var STORE = require('../runtime-log-store.js');
  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };

  // 抠真源，不手抄：手抄一份等于给诊断开出第二份选择器清单，改版时它比排查更容易骗人。
  var slice = read('src/page/60-tasks-detect.js');
  var anchor = '_frameRejectSignature: function (doc, found) {';
  var at = slice.indexOf(anchor);
  check('能从 60-tasks-detect.js 定位 _frameRejectSignature', at >= 0, '锚点没命中：函数改名或签名参数变了');
  var stateSrc = read('src/page/10-config-state.js');
  var selMatch = stateSrc.match(/\n    _questionSelectors: (\[[\s\S]*?\n    \]),/);
  check('能从 10-config-state.js 抠出 _questionSelectors 真源', !!selMatch, '锚点没命中：清单改名或缩进变了');
  var ctlMatch = stateSrc.match(/\n    _quizAnswerControlSelector: '([^']+)'/);
  check('能从 10-config-state.js 抠出 _quizAnswerControlSelector 真源', !!ctlMatch, '锚点没命中：签名改成读真源后这里要跟得上');
  if (at < 0 || !selMatch || !ctlMatch) return;

  var selectors = new Function('return ' + selMatch[1])();
  var bodyStart = slice.indexOf('function', at);
  var bodyEnd = slice.indexOf('\n    },', bodyStart);
  check('_frameRejectSignature 函数体能按缩进闭合', bodyEnd > bodyStart, '没找到方法结束的那一行');
  if (bodyEnd <= bodyStart) return;
  var fn = new Function('return (' + slice.slice(bodyStart, bodyEnd) + '\n    })')();

  function fakeDoc(text, hits) {
    return {
      body: { innerText: text },
      // 单条选择器：直接查表；并集（`a,b,c`）：把命中的各条**当不同元素**相加 ——
      // 生产里 `qTotal` 走的就是 `_questionSelectors.join(',')` 这一条路。
      querySelectorAll: function (sel) {
        var parts = String(sel).split(',');
        if (parts.length === 1) {
          return { length: Object.prototype.hasOwnProperty.call(hits, sel) ? hits[sel] : 0 };
        }
        var total = 0;
        parts.forEach(function (p) {
          var k = p.trim();
          if (Object.prototype.hasOwnProperty.call(hits, k)) total += hits[k];
        });
        return { length: total };
      },
      getElementById: function () { return null; }
    };
  }

  var stored = [];
  var store = STORE.create({
    read: function () { return stored; },
    write: function (logs) { stored = logs; },
    authorize: function () { return true; },
    now: function () { return Date.now(); }
  });

  function appendSig(sig) {
    return store.handle({
      type: 'runtime_log_append',
      payload: {
        level: 'warn',
        message: 'search job: every candidate frame was rejected',
        meta: {
          frames: 8, attachments: 0,
          rejects: [{ src: 'javascript:void(function(){document.open', reason: 'unknown task type', sig: sig }]
        }
      }
    }, { url: 'https://mooc1.chaoxing.com/knowledge/cards' });
  }

  var hitMap = {};
  hitMap[selectors[0]] = 0;
  // 夹具故意命中**第 15 条**（真实日志 00:46:04 唯一命中的就是 `div[class*="question"]`）：
  // 前 5 条的位置串因此全是 0，只有按整份清单并集数出来的 `qTotal` 才是 3。
  // 这条同时把"qTotal 只数了前 5 条"这类取数错误钉住 —— 它会让批次 10-C 的延时永不武装。
  hitMap[selectors[14]] = 3;
  // 作答控件按真源那串的**第一个**口径计数（`[qid]`）—— 批次 10-C 的门要用它。
  var ctlFirst = ctlMatch[1].split(',')[0].trim();
  hitMap[ctlFirst] = 2;
  check('真源清单第 15 条存在（夹具要它来暴露"只数前 5 条"的取数错误）',
    typeof selectors[14] === 'string', '清单只有 ' + selectors.length + ' 条');
  var appStub = { _questionSelectors: selectors, _quizAnswerControlSelector: ctlMatch[1] };
  var sig = fn.call(appStub, fakeDoc('一、单选题 1. 下列说法正确的是（）', hitMap), { quizLike: true, video: false });

  var res = await appendSig(sig);
  check('日志真的写进存储（store 返回 success）', res && res.success === true, JSON.stringify(res));
  var meta = stored.length ? stored[0].meta : null;
  var outSig = meta && meta.rejects && meta.rejects[0] ? meta.rejects[0].sig : null;
  check('落盘后 sig 仍在（第 3 层没被整个压掉）', !!outSig && typeof outSig === 'object', JSON.stringify(meta));
  if (!outSig) return;
  var dumped = JSON.stringify(outSig);
  check('sig 里没有一个字段被压成 [truncated]（批次 9 的那条就是这里红的）',
    dumped.indexOf('[truncated]') < 0, dumped);
  check('qHits 是「按选择器位置」的字符串命中数',
    typeof outSig.qHits === 'string' && /^[\d\/]+$/.test(outSig.qHits) &&
    outSig.qHits.split('/').length === Math.min(5, selectors.length),
    JSON.stringify(outSig.qHits) + ' / 清单 ' + selectors.length + ' 项');
  check('qTotal 是数字，且按**整份**清单并集数出来（夹具命中第 15 条 → 3）',
    outSig.qTotal === 3, JSON.stringify(outSig.qTotal));
  check('qHits 只覆盖前 5 条，因此这里必须全是 0（两个字段各管一件事，别混）',
    outSig.qHits === '0/0/0/0/0', JSON.stringify(outSig.qHits));
  check('textLen 与 text 同时在场（「本来就空」与「片段切没了」要分得开）',
    typeof outSig.textLen === 'number' && outSig.textLen > 0 && typeof outSig.text === 'string', dumped);
  check('answer / frames / video 是数字（判据要用它们，不能是字符串）',
    typeof outSig.answer === 'number' && typeof outSig.frames === 'number' && typeof outSig.video === 'number', dumped);
  check('作答控件计数读的是真源 _quizAnswerControlSelector（只数 [id^="answer"] 会把只有 qid/role 的卷子读成没框）',
    outSig.answer === 2, JSON.stringify(outSig.answer));

  // ⚠️ 反向对照：批次 9 第一版那种**嵌套对象**必须被第 4 层闸压掉。
  //   没有这几条，上面那串断言在"存储层规则被改掉"之后会一起变绿 —— 假绿。
  var nested = {};
  nested[selectors[0]] = 3;
  var revRes = await appendSig({ qHit: nested, text: '', answer: 0, frames: 1 });
  var revSig = stored.length ? stored[stored.length - 1].meta.rejects[0].sig : null;
  check('反向对照：嵌套的 qHit 对象确实被压成 [truncated]',
    revRes && revRes.success === true && !!revSig && revSig.qHit === '[truncated]',
    JSON.stringify(revSig));
  check('反向对照：同层的标量没被牵连（截断只吃第 4 层）',
    !!revSig && revSig.answer === 0 && revSig.frames === 1, JSON.stringify(revSig));
}

/**
 * 看门狗不许在"已经不握着这一页"的时候说话（批次 10-B）。
 *
 * 现场：真实日志 00:45:35 page.js 已经打出 `start`（它活着、还在答题），00:45:45 却冒出一条红色
 * `page script no response after tag injection {waitedMs:10000}` —— 用户看到的就是「插件坏了，去刷新」，
 * 而刷新正好把这一轮进度全丢掉。两处毛病：① 换文档/重复注入之后，**旧那份实例的定时器照样会说话**；
 * ② `waitedMs` 是**两个常数相加**写出来的 10000，一次都没量过 —— 看着像证据，其实什么都不是。
 *
 * ⚠️ 这一节是**结构性**守卫，不是行为断言：看门狗是一条 6s + 4s 的真实定时链，
 *   照行为验要把整个集成测试拖慢 20 秒以上，而且定时链在 CI 上必然偶发红。
 *   守卫的是"这三道条件与这两个字段还在"，改坏能立刻红 —— 与 check.js 的
 *   「选择器真源守卫」「桥接消息类型两端一致」是同一类机检。
 */
async function testInjectionWatchdogOwnershipGuard() {
  console.log('\n[14] 注入看门狗：只在自己还握着那份文档时说话，waitedMs 必须是测量值');

  var src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');

  function bodyOf(anchor) {
    var at = src.indexOf(anchor);
    if (at < 0) return '';
    var end = src.indexOf('\n  }', at);
    return end < 0 ? '' : src.slice(at, end);
  }

  var owns = bodyOf('function watchdogStillOwnsPage(seq) {');
  check('存在 watchdogStillOwnsPage（没有它 = 旧实例的定时器也会报错）', owns.length > 0);
  check('它问"本次注入是否仍是最新一次"（seq vs pageInjectSeq）',
    /seq\s*!==\s*pageInjectSeq/.test(owns), owns.replace(/\s+/g, ' ').slice(0, 160));
  check('它问"这份文档还挂在浏览器上"（导航后的旧文档必须闭嘴）',
    /document\.isConnected/.test(owns), owns.replace(/\s+/g, ' ').slice(0, 160));
  check('它问"自己那块 <script> 还在不在"（被移走 = 本次注入已作废）',
    owns.indexOf('getElementById(PAGE_SCRIPT_ID)') >= 0, owns.replace(/\s+/g, ' ').slice(0, 160));

  var dog = bodyOf('function scheduleInjectionWatchdog(');
  check('存在 scheduleInjectionWatchdog', dog.length > 0);
  var timers = (dog.match(/setTimeout\(/g) || []).length;
  check('两级定时都装了所有权守卫（守卫数量必须等于 setTimeout 数量）',
    timers > 0 && (dog.match(/watchdogStillOwnsPage\(seq\)/g) || []).length === timers,
    'setTimeout=' + timers + ' 守卫=' + (dog.match(/watchdogStillOwnsPage\(seq\)/g) || []).length);
  check('waitedMs 是测量值 Date.now() - pageRuntimeArmedAt（写死的 10000 就是把猜测伪装成证据）',
    /waitedMs:\s*Math\.max\(0,\s*Date\.now\(\)\s*-\s*pageRuntimeArmedAt\)/.test(dog) &&
    !/waitedMs:\s*\d/.test(dog), dog.replace(/\s+/g, ' ').slice(0, 200));
  check('报错那条带得上判据的输入（everSawLog / docConnected / href），下一份日志能自证',
    dog.indexOf('everSawLog') >= 0 && dog.indexOf('docConnected') >= 0 && dog.indexOf('href') >= 0);
  // ⚠️ 这里**故意没有**"日志流最近有新条目就算活着"那种判据 —— 运行日志是**跨文档共享**的
  //   200 条环形缓冲，别的框架、别的标签页、刷新前那份旧实例都在往里写。
  //   上面三条守卫锁住的就是这一点：说话的前提是"这一份实例还握着这一页"，不是"流里有没有动静"。
}

/**
 * 批次 11-A / 11-B：0 题诊断 → 完成判定延时窗口 的**接线**，以及完成依据取证。
 *
 * 为什么集成层要管这件事：批次 10-C 的窗口在真实页面一次都没武装过 —— 它只挂在
 * 「帧被拒」那条路上，而真实日志 01:49:17 那一帧的签名是 `answer:0`、`text:""`
 * （卷子还没被 `document.write` 进子帧），闸门 `qTotal>=1 && answer>=1` 当场不成立。
 * 真正量到正确形状的一直是 `_handleQuiz` 的 0 题诊断（00:46:04：inputs:9 + 题形命中 1）。
 * **判据对、数字也量到了，只是两者之间没有线** —— 这条线必须在集成层钉住，
 * 因为浏览器场景调的是 `_quizScanRetrySignal` 本身，看不见调用点有没有被挪到 `return` 后面。
 */
async function testQuizScanHoldWiring() {
  console.log('\n[15] 0 题诊断必须接进完成判定的延时窗口（接线 + 闸门 + 成本封顶）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var detect = read('src/page/60-tasks-detect.js');
  var quiz = read('src/page/70-quiz-flow.js');

  // ---- ① 接线：调用点存在，而且在 0 题分支的那个 `return` 之前 ----
  var anchor = "console.warn('[Omitone] no questions extracted');";
  var at = quiz.indexOf(anchor);
  check('能在 70-quiz-flow.js 定位「扫到 0 题」那条分支', at >= 0, '锚点没命中：那句 warn 改名或挪走了');
  var branch = at < 0 ? '' : quiz.slice(at, at + 6000);
  // ⚠️ 窗口只能宽不能窄：批次 12 给 0 题诊断那几行多补了三个取证字段，
  //   把下面两条调用点从 1600 字里推了出去 —— 断言当场变红，而不是"接线被改坏"。
  //   留 6000 字，靠 `firstReturn` 的顺序判定来管"写在 return 后面等于没接线"。
  var iSig = branch.indexOf('this._quizScanRetrySignal(preferredDoc)');
  var iHold = branch.indexOf("_maybeHoldSkipForUnparsedQuiz(scanSig, 'quiz-scan')");
  var iRet = branch.indexOf('return;');
  check('0 题分支真的调了页面级信号 `_quizScanRetrySignal`', iSig > 0,
    branch.replace(/\s+/g, ' ').slice(0, 180));
  check('量到的形状交给同一个有界窗口，且 `src` 写成 quiz-scan（与「帧被拒」那条分得开）',
    iHold > 0, '找不到 _maybeHoldSkipForUnparsedQuiz(scanSig, \'quiz-scan\')');
  check('接线在分支返回之前（写在 `return;` 后面等于没接线）',
    iRet > 0 && iRet > iHold, 'firstReturn=' + iRet + ' hold=' + iHold);

  // ---- ② 闸门 + 成本封顶：把方法从源码里取出来真跑 ----
  var mAnchor = '_quizScanRetrySignal: function (preferredDoc) {';
  var mAt = detect.indexOf(mAnchor);
  check('能从 60-tasks-detect.js 定位 _quizScanRetrySignal', mAt >= 0, '锚点没命中：方法改名或签名变了');
  var hAnchor = '_maybeHoldSkipForUnparsedQuiz: function (sig, src) {';
  var hAt = detect.indexOf(hAnchor);
  check('能从 60-tasks-detect.js 定位 _maybeHoldSkipForUnparsedQuiz', hAt >= 0);
  if (mAt < 0 || hAt < 0) return;

  var build = function (name) {
    var start = detect.indexOf('function', detect.indexOf(name + ': function'));
    var end = detect.indexOf('\n    },', start);
    return new Function('return (' + detect.slice(start, end) + '\n    })')();
  };
  var scanRetrySignal = build('_quizScanRetrySignal');
  var maybeHold = build('_maybeHoldSkipForUnparsedQuiz');

  // 压平函数在 30-log.js，这里**取真实那一份**而不是桩：三处取证共用它，
  // 用桩就等于把"两处口径不一致"这个 bug 类别放过去了。
  var buildFrom = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return null;
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    if (end <= start) return null;
    return new Function('return (' + src.slice(start, end) + '\n    })')();
  };
  var flatten = buildFrom(read('src/page/30-log.js'), '_flattenDropStages');
  check('存在 _flattenDropStages（三处取证共用同一个口径，别再各写一遍各错一遍）',
    typeof flatten === 'function', '锚点没命中：签名或缩进变了');

  var logs = [];
  var oldEmit = global.emitRuntimeLog;
  var oldScaled = global.scaledMs;
  global.emitRuntimeLog = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
  global.scaledMs = function (ms) { return ms; };

  function makeApp(diagReport) {
    var calls = 0;
    return {
      calls: function () { return calls; },
      scope: 'card-7',
      _quizParseRetryUntil: 0,
      _quizParseRetryScope: '',
      _quizParseRetryWarnAt: 0,
      _studyProgressKey: function () { return this.scope; },
      _getCurrentTitle: function () { return '课后检测'; },
      _flattenDropStages: flatten,
      _diagnoseQuestionScan: function () { calls++; return diagReport; }
    };
  }
  // 真实页面（rig 里的 `xxtAI.probe()`）实测到的形状：**每条选择器对应一个四格对象**。
  // 批次 12 之前，三处取证都按 `{选择器: 数字}` 读它 —— `Number(对象)` 当场变成 NaN。
  var QSEL = 'div[class*="question"]';
  var realShape = {
    docs: [{ inputs: 9, selectors: { [QSEL]: 1 } }],
    containers: 0,
    dropStages: { [QSEL]: { matched: 1, filtered: 1, deduped: 0, unparsable: 0 } }
  };
  var flatDrop = QSEL + ':matched1/filtered1/deduped0/unparsable0';

  try {
    var app = makeApp(realShape);
    var sig = scanRetrySignal.call(app, null);
    check('00:46:04 的形状现在给出 sig：qTotal=1（第 15 条那族）/ answer=9 / containers=0',
      !!sig && sig.qTotal === 1 && sig.answer === 9 && sig.containers === 0 && sig.docs === 1,
      JSON.stringify(sig));
    check('dropStages 压成**四格定序**的串再落盘（批次 12：真实形状是「每条选择器一个对象」，' +
      '按数字读它就是 div[class*="question"]:NaN）',
      !!sig && sig.drop === flatDrop, JSON.stringify(sig && sig.drop));

    app.scope = 'card-8';
    var before = app.calls();
    var armed = maybeHold.call(app, sig, 'quiz-scan');
    check('sig 喂给窗口 → 武装成功并留下 delay skip（src=quiz-scan、带 containers/drop）',
      armed === true && app._quizParseRetryUntil > Date.now() && logs.length === 1 &&
      logs[0].meta.src === 'quiz-scan' && logs[0].meta.containers === 0 && logs[0].meta.drop === flatDrop,
      JSON.stringify(logs.map(function (l) { return l.meta; })));

    var callsAfterArm = app.calls();
    var held = scanRetrySignal.call(app, null);
    check('窗口已武装时**不再做全页诊断**（一次诊断 = ≤8 文档 × 18 选择器，成本必须封顶）',
      held === null && app.calls() === callsAfterArm,
      'calls ' + callsAfterArm + ' → ' + app.calls());

    app._quizParseRetryUntil = Date.now() - 1;
    var spent = scanRetrySignal.call(app, null);
    check('同一张卡片预算用掉后也不再诊断（把「跳过」换成另一种「磨蹭」是这次要避免的）',
      spent === null && app.calls() === callsAfterArm, 'calls=' + app.calls());

    app.scope = 'card-9';
    var nextCard = scanRetrySignal.call(app, null);
    check('换一张卡片重新量一次（上一节用掉的窗口不该冤枉下一节的真卷子）',
      !!nextCard && app.calls() === callsAfterArm + 1, 'calls=' + app.calls());

    // ⚠️ 上面两条成本闸**互不替代**，必须各钉各的：实测把「窗口未过期」那条删掉，
    //   紧接着的「预算用掉」那条照样返回 null（作用域相同），整组断言全绿 ——
    //   典型的"改坏了却没人报警"。这里造出只有第一条闸起作用的那一态：
    //   窗口还开着，但作用域已经换到别的卡片（卡片推进比窗口过期快时会真的发生）。
    app._quizParseRetryUntil = Date.now() + 9000;
    app.scope = 'card-11';
    var callsBeforeOverlap = app.calls();
    var overlap = scanRetrySignal.call(app, null);
    check('两条成本闸各自独立：窗口未过期 + 作用域已换卡片时**仍然不扫**（删掉第一条闸，上一条断言照样绿）',
      overlap === null && app.calls() === callsBeforeOverlap,
      'overlap=' + JSON.stringify(overlap) + ' calls ' + callsBeforeOverlap + ' → ' + app.calls());
    app._quizParseRetryUntil = Date.now() - 1;

    var noShape = makeApp({ docs: [{ inputs: 5, selectors: {} }], containers: 0 });
    check('有作答框但没命中任何题形 → 不武装（否则每个纯输入页都能拖住整节）',
      scanRetrySignal.call(noShape, null) === null);
    var noControls = makeApp({ docs: [{ inputs: 0, selectors: { '.TiMu': 2 } }], containers: 0 });
    check('命中题形但没有作答框 → 不武装（课件那一族照旧推进）',
      scanRetrySignal.call(noControls, null) === null);
    var brokenDiag = makeApp(null);
    brokenDiag._diagnoseQuestionScan = function () { throw new Error('boom'); };
    check('诊断抛错时返回 null 而不是把整轮 tick 打断（这一条在 _handleQuiz 的收尾路径上）',
      scanRetrySignal.call(brokenDiag, null) === null);
  } finally {
    global.emitRuntimeLog = oldEmit;
    global.scaledMs = oldScaled;
  }

  // ---- ②-B 批次 12：压平口径、深度闸、以及 qTotal 不许把同一批题数三遍 ----
  if (typeof flatten !== 'function') return;
  try {
    check('四格按固定顺序全写出来（少写一格就回答不了「死在哪一道」）',
      flatten({ a: { matched: 3, filtered: 2, deduped: 1, unparsable: 0 } }) ===
        'a:matched3/filtered2/deduped1/unparsable0',
      flatten({ a: { matched: 3, filtered: 2, deduped: 1, unparsable: 0 } }));

    // ⚠️ 这一条钉的是批次 12 **那个 bug 本身**：旧代码把每条选择器当数字读。
    check('没有一格被写成 NaN（旧写法 Number(对象) 的现场就是 div[class*="question"]:NaN）',
      flatten({ a: { matched: 1 } }).indexOf('NaN') < 0 &&
      flatten({ a: 1 }).indexOf('NaN') < 0 &&
      flatten({ a: null }).indexOf('NaN') < 0,
      flatten({ a: { matched: 1 } }) + ' | ' + flatten({ a: 1 }) + ' | ' + flatten({ a: null }));

    check('缺格按 0 补、旧误读的「值是数字」也不会炸（判据不能因取证形状而抛异常）',
      flatten({ a: 1 }) === 'a:matched0/filtered0/deduped0/unparsable0', flatten({ a: 1 }));
    check('没有 dropStages 时给出空串而不是 "undefined" 之类的脏值',
      flatten(null) === '' && flatten(undefined) === '' && flatten({}) === '',
      JSON.stringify([flatten(null), flatten({})]));
    check('最多 4 条选择器（其余留在 matchedSelectors 里，串太长会把一行日志挤爆）',
      flatten({ a: {}, b: {}, c: {}, d: {}, e: {}, f: {} }).split(';').length === 4,
      flatten({ a: {}, b: {}, c: {}, d: {}, e: {}, f: {} }));

    // 落盘：压平后的串必须活过 runtime-log-store 的深度闸（批次 10-A 是同一坑的另一处落点）
    var STORE12 = require('../runtime-log-store.js');
    var stored12 = [];
    var store12 = STORE12.create({
      read: function () { return stored12; },
      write: function (logs2) { stored12 = logs2; },
      authorize: function () { return true; },
      now: function () { return Date.now(); }
    });
    var r12 = await store12.handle({
      type: 'runtime_log_append',
      payload: {
        level: 'warn', message: 'quiz scan found 0 questions',
        meta: { hint: 'x', docs: 8, inputs: 82, containers: 0, containerDocs: 2,
          containerPaths: '/mooc-ans/knowledge/cards|/mooc-ans/work/doHomeWorkNew',
          dropStages: flatten(realShape.dropStages), samples: [] }
      }
    }, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
    var m12 = stored12.length ? stored12[stored12.length - 1].meta : null;
    check('压平后的 dropStages 真的落盘（store 返回 success 且 meta 在场）',
      r12 && r12.success === true && !!m12, JSON.stringify(r12));
    check('落盘后 dropStages 还是那句四格串（它是唯一能回答「为什么一题没抠出来」的字段，不许在路上变形）',
      !!m12 && m12.dropStages === flatDrop, JSON.stringify(m12 && m12.dropStages));
    check('containers / containerDocs / containerPaths 都是标量并且原样留着',
      !!m12 && m12.containers === 0 && m12.containerDocs === 2 &&
      /doHomeWorkNew/.test(String(m12.containerPaths)), JSON.stringify(m12));

    // ⚠️ 反向对照钉的是**深度闸本身还活着**（`cleanLogMeta`：第 4 层起换成 [truncated]）。
    //   批次 12 原先把"压平"的理由写成"否则会被截"—— 实测**站不住**：
    //   `meta.dropStages` 只有两层，落在第 2、3 层，根本截不到。
    //   压平真正的理由是①旧代码按数字读它当场 NaN ②三处取证要同一个口径 ③落盘字段一律标量最稳。
    await store12.handle({
      type: 'runtime_log_append',
      payload: { level: 'warn', message: 'quiz scan found 0 questions',
        meta: { l1: { l2: { l3: { deep: { matched: 1 } } } }, dropStages: flatDrop } }
    }, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
    var rev12 = stored12.length ? stored12[stored12.length - 1].meta : null;
    check('反向对照：第 4 层的对象确实被压成 [truncated]（「落盘字段全标量」这条规矩不是迷信）',
      !!rev12 && rev12.l1 && rev12.l1.l2 && rev12.l1.l2.l3 && rev12.l1.l2.l3.deep === '[truncated]',
      JSON.stringify(rev12));
    check('反向对照：同层的标量串没被牵连（截断只吃第 4 层）',
      !!rev12 && rev12.dropStages === flatDrop, JSON.stringify(rev12 && rev12.dropStages));

    // qTotal：真页面 24 道题被三族选择器各数一遍，旧写法相加给出 73
    var overlapApp = makeApp({
      docs: [{ inputs: 82, selectors: { '.TiMu': 24, '.singleQuesId': 24, 'div[class*="TiMu"]': 24 } }],
      containers: 24, dropStages: {}
    });
    var o12 = scanRetrySignal.call(overlapApp, null);
    check('同一文档里重叠的几族选择器只数一次（qTotal=24，不是 72 —— 页面里没有这个数字）',
      !!o12 && o12.qTotal === 24, JSON.stringify(o12 && o12.qTotal));

    var twoDocApp = makeApp({
      docs: [{ inputs: 82, selectors: { '.TiMu': 24 } }, { inputs: 0, selectors: { '.TiMu': 1 } }],
      containers: 25, dropStages: {}
    });
    var t12 = scanRetrySignal.call(twoDocApp, null);
    check('跨文档才相加（两份卷子各 24/1 → 25，与真页面 probe 的 sig.qTotal 对得上）',
      !!t12 && t12.qTotal === 25, JSON.stringify(t12 && t12.qTotal));
  } finally {}

  // ---- ③ 完成依据取证只许用只读判据 ----
  var evAt = detect.indexOf('_skipCompletedEvidence: function () {');
  check('存在 _skipCompletedEvidence（skip completed 必须自证凭什么）', evAt >= 0);
  var evBody = evAt < 0 ? '' : detect.slice(evAt, detect.indexOf('\n    },', evAt));
  check('取证里不许调 `_isQuizLearningPending`（它会重置答题状态，是有副作用的判据）',
    evBody.length > 0 && evBody.indexOf('_isQuizLearningPending') < 0,
    evBody.replace(/\s+/g, ' ').slice(0, 160));
  check('skip completed 那条日志把依据并进 meta（Object.assign）',
    /emitRuntimeLog\('info',\s*'skip completed',\s*Object\.assign\(/.test(detect),
    '找不到 Object.assign 合并依据的写法');
}

/** ---- [16] 批次 13-A / 13-B：取题文档的有界深走 +「答不了」不等于「没题做」 ---- */
async function testQuizPaperDepthAndApiBlock() {
  console.log('\n[16] 卷子埋三层时的取题文档 + 被链路挡住时的按住判据（批次 13-A / 13-B）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var dom = read('src/page/75-quiz-dom.js');
  var quiz = read('src/page/70-quiz-flow.js');
  var state = read('src/page/10-config-state.js');
  var detect = read('src/page/60-tasks-detect.js');

  var buildFrom = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return null;
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    if (end <= start) return null;
    return new Function('return (' + src.slice(start, end) + '\n    })')();
  };
  // 方法体：从签名到下一个「四空格 + `},`」—— 片段里所有方法都是这个缩进。
  // ⚠️ 别拿「下一个方法的签名」当终点：同文件里 `_isQuizPassedOrFinished` 排在
  //   `_isQuizLearningPending` **前面**，那样切出来是空串，断言会假绿。
  var bodyOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return '';
    var end = src.indexOf('\n    },', at);
    return end < 0 ? src.slice(at) : src.slice(at, end);
  };

  var hasShape = buildFrom(dom, '_docHasQuizPaperShape');
  var findBelow = buildFrom(dom, '_findQuizPaperDocumentBelow');
  var resolveDoc = buildFrom(dom, '_resolveQuizAnswerDocument');
  check('三个方法都能从 75-quiz-dom.js 取到真实那一份（用桩等于把"两处口径不一致"放过去）',
    typeof hasShape === 'function' && typeof findBelow === 'function' && typeof resolveDoc === 'function',
    JSON.stringify({ shape: typeof hasShape, below: typeof findBelow, resolve: typeof resolveDoc }));
  if (!resolveDoc) return;

  // ---- ① 13-A：造出实测拓扑（卡片页 → work 帧 → #frame_content 里的卷子）----
  // 文档用最小替身：只有解析器真的会碰的那三个入口，别的一律不认。
  var frameScans = 0;
  function mkDoc(name, opt) {
    opt = opt || {};
    return {
      __name: name,
      querySelector: function () { return opt.shape ? { node: name } : null; },
      querySelectorAll: function (sel) {
        if (sel !== 'iframe') return [];
        frameScans++;
        return opt.frames || [];
      },
      getElementById: function () { return null; }
    };
  }
  function mkFrame(id, doc) { return { id: id, __doc: doc }; }

  function mkApp(mainDoc) {
    return {
      _quizContainerSelector: '.TiMu, .questionLi',
      _getMainDocument: function () { return mainDoc; },
      _safeDocOf: function (f) { return (f && f.__doc) || null; },
      _docHasQuizPaperShape: hasShape,
      _findQuizPaperDocumentBelow: findBelow,
      _resolveQuizAnswerDocument: resolveDoc
    };
  }
  // ⚠️ 替身必须挡在**解析器**前面，而不是挡在断言前面：这一族文档一旦被裸读 `.document`
  //   就会抛 SecurityError 打断整轮 tick（AGENTS §2 #1），所以深走的每一帧都必须走 _safeDocOf。
  var quizDoc = mkDoc('quiz', { shape: true });
  var workDoc = mkDoc('work', { frames: [mkFrame('frame_content', quizDoc)] });
  var cardsDoc = mkDoc('cards', { frames: [mkFrame('ans-attach-work', workDoc)] });
  var topDoc = mkDoc('top', { frames: [mkFrame('iframe', cardsDoc)] });

  frameScans = 0;
  var landed = mkApp(topDoc)._resolveQuizAnswerDocument(null);
  check('13-A：三层外的卷子**当场被走到**（旧实现停在卡片页，"题还没做"就被读成"这节做完了"）',
    landed && landed.__name === 'quiz', '落在 ' + (landed && landed.__name));
  check('深走的成本有界：只按 iframe 一类选择器逐层看，一次解析不超过 3 层帧',
    frameScans > 0 && frameScans <= 6, 'frameScans=' + frameScans);

  frameScans = 0;
  var selfShape = mkApp(quizDoc)._resolveQuizAnswerDocument(quizDoc);
  check('手里那份文档自己就有题形 → **一帧都不下探**（十几条已经传对文档的读路径成本不变）',
    selfShape === quizDoc && frameScans === 0, 'frameScans=' + frameScans);

  // 深度封顶：卷子挂在第 4 层帧之后 —— 必须放弃深走、原样返回起点文档
  var deepQuiz = mkDoc('deep-quiz', { shape: true });
  var d3 = mkDoc('d3', { frames: [mkFrame('f3', deepQuiz)] });
  var d2 = mkDoc('d2', { frames: [mkFrame('f2', d3)] });
  var d1 = mkDoc('d1', { frames: [mkFrame('f1', d2)] });
  var d0 = mkDoc('d0', { frames: [mkFrame('f0', d1)] });
  var tooDeep = mkApp(d0)._resolveQuizAnswerDocument(null);
  check('超过深度上限（4 层以外）时**不认**：宁可回到起点文档，也不把整轮 tick 拖进无界帧遍历',
    tooDeep === d0, '落在 ' + (tooDeep && tooDeep.__name));

  // 每层帧数封顶：13 帧，卷子在最后一帧里 —— 上限之外的不该被看见
  var many = [];
  for (var mi = 0; mi < 13; mi++) {
    many.push(mkFrame('f' + mi, mi === 12 ? mkDoc('late-quiz', { shape: true }) : mkDoc('late-' + mi)));
  }
  var capped = mkApp(mkDoc('many', { frames: many }))._resolveQuizAnswerDocument(null);
  check('每层最多 12 帧：第 13 帧里的卷子**不去认**（成本封顶是真的封顶，不是写在注释里）',
    capped && capped.__name === 'many', '落在 ' + (capped && capped.__name));

  // 学习通把卷子放在 #frame_content，DOM 顺序却常排在别的任务点帧之后
  var otherQuiz = mkDoc('other-quiz', { shape: true });
  var fcQuiz = mkDoc('fc-quiz', { shape: true });
  var ordered = mkApp(mkDoc('outer', { frames: [mkFrame('other', otherQuiz), mkFrame('frame_content', fcQuiz)] }))
    ._resolveQuizAnswerDocument(null);
  check('同一层里 `#frame_content` 优先（真实页面它常排在后面，按 DOM 顺序取会拿错那份）',
    ordered && ordered.__name === 'fc-quiz', '落在 ' + (ordered && ordered.__name));

  // 跨域帧：_safeDocOf 给 null 时必须跳过而不是抛错打断整轮
  var crossQuiz = mkDoc('cross-quiz', { shape: true });
  var withCross = mkApp(mkDoc('mix', { frames: [mkFrame('x', null), mkFrame('ok', crossQuiz)] }))
    ._resolveQuizAnswerDocument(null);
  check('跨域帧（取不到文档）只跳过、不抛错 —— 裸读 .document 会静默打断整轮 tick',
    withCross && withCross.__name === 'cross-quiz', '落在 ' + (withCross && withCross.__name));

  var belowBody = bodyOf(dom, '_findQuizPaperDocumentBelow');
  check('深走里不许出现裸读（`.contentDocument` / `.document`），只准走 _safeDocOf',
    belowBody.length > 0 && belowBody.indexOf('.contentDocument') < 0 &&
    belowBody.indexOf('.document') < 0 && belowBody.indexOf('_safeDocOf') >= 0,
    belowBody.replace(/\s+/g, ' ').slice(0, 160));

  // ---- ② 13-B：按住判据（新鲜度 30 秒 / 预算 3 分钟 / 用户关掉答题不算故障）----
  var isBlocked = buildFrom(quiz, '_isQuizBlockedByApi');
  var noteBlocked = buildFrom(quiz, '_noteQuizBlockedByApi');
  check('两个方法都能从 70-quiz-flow.js 取到真实那一份',
    typeof isBlocked === 'function' && typeof noteBlocked === 'function',
    JSON.stringify({ judge: typeof isBlocked, note: typeof noteBlocked }));
  if (!isBlocked || !noteBlocked) return;

  var realNow = Date.now;
  var fakeNow = 1000000000000;
  Date.now = function () { return fakeNow; };
  try {
    function mkBlock(reason) {
      return {
        _getQuizApiUnavailableReason: function () { return reason; },
        _quizBlockedByApiAt: 0, _quizBlockedSinceAt: 0,
        _isQuizBlockedByApi: isBlocked, _noteQuizBlockedByApi: noteBlocked
      };
    }
    var a1 = mkBlock('api-key-missing');
    check('13-B：从没记过「被挡住」时**不凭空按住**（没有证据就不许把整节冻住）',
      isBlocked.call(a1) === false);
    noteBlocked.call(a1, 'api-key-missing');
    check('13-B：记过一次之后，同一轮里算「被挡住」（这就是「答不了」不再等于「没题做」的那条证据）',
      isBlocked.call(a1) === true && a1._quizBlockedSinceAt === fakeNow);
    fakeNow += 10000;
    noteBlocked.call(a1, 'api-key-missing');
    check('连续拒帧**不续期**本轮起点（否则每秒拒一次就永远不会到预算、永远翻不了页）',
      a1._quizBlockedSinceAt === 1000000000000);
    fakeNow += 70000;
    noteBlocked.call(a1, 'api-key-missing');
    check('隔了 60 秒以上再拒 = **新一轮**（填过 key 又掉线的，不该继承第一次的时长直接跳过）',
      a1._quizBlockedSinceAt === fakeNow);
    var a2 = mkBlock('api-key-missing');
    noteBlocked.call(a2, 'api-key-missing');
    a2._quizBlockedByApiAt = fakeNow - 31000;
    check('新鲜度闸：30 秒内没有再拒过 → 不算按住（页面早就换了，凭旧证据按住整节是磨蹭）',
      isBlocked.call(a2) === false);
    var a3 = mkBlock('api-key-missing');
    noteBlocked.call(a3, 'api-key-missing');
    a3._quizBlockedSinceAt = fakeNow - 181000;
    check('预算闸：按住满 3 分钟就放手（永远不填 key 的用户不能被冻在这一节）',
      isBlocked.call(a3) === false);
    var a4 = mkBlock('quiz-toggle-off');
    noteBlocked.call(a4, 'quiz-toggle-off');
    check('用户自己关掉答题**不算故障**：不记、也不按住（那是选择，照旧该翻页）',
      a4._quizBlockedByApiAt === 0 && isBlocked.call(a4) === false);
    // ⚠️ 上面那条**只证明了"记不上"这一层**：`_quizBlockedByApiAt` 一直是 0，
    //   判据第一行（没有标记就返回 false）先把它拦掉，判据里那道**同样的过滤**换根本没被走到。
    //   真会走到那一层的是这个形状 —— **先因为没填 key 被按住，中途用户把答题关掉**：
    //   旧标记还在，此时只有判据那道过滤会立刻放手。（反向验证 B10 / B10b 一手一条。）
    var a4b = mkBlock('api-key-missing');
    noteBlocked.call(a4b, 'api-key-missing');
    var heldBefore = a4b._quizBlockedByApiAt;
    a4b._getQuizApiUnavailableReason = function () { return 'quiz-toggle-off'; };
    check('按住途中用户把答题关掉 → **立刻放手**（判据里那道过滤的独立职责，旧标记还在时只有它管用）',
      heldBefore !== 0 && isBlocked.call(a4b) === false,
      JSON.stringify({ heldBefore: heldBefore, blocked: isBlocked.call(a4b) }));
    var a5 = mkBlock('');
    noteBlocked.call(a5, 'api-key-missing');
    check('链路其实可用（理由为空）时拒帧也记不上：判据不吃「先记了再恢复」的残留',
      isBlocked.call(a5) === false);
  } finally {
    Date.now = realNow;
  }

  // ---- ③ 接线：这三处一旦被人"顺手简化"回去，症状就是用户报的那句「怎么说已完成了」----
  var learnBody = bodyOf(quiz, '_isQuizLearningPending');
  check('_isQuizLearningPending 里链路不可用那一支必须**交给按住判据**，不许退回无条件 false',
    /_isQuizApiUnavailable\(\)\)\s*return\s+this\._isQuizBlockedByApi\(\);/.test(learnBody),
    learnBody.replace(/\s+/g, ' ').slice(0, 160));

  var holdBody = bodyOf(quiz, '_shouldHoldQuizBeforeNext');
  check('_shouldHoldQuizBeforeNext 只在「没被按住」时才放手（两道判据口径一致，别一处按住一处翻节）',
    /_isQuizApiUnavailable\(\)\s*&&\s*!\s*this\._isQuizBlockedByApi\(\)\)\s*return\s+false;/.test(holdBody),
    holdBody.replace(/\s+/g, ' ').slice(0, 200));

  var passedBody = quiz.slice(quiz.indexOf('_isQuizPassedOrFinished: function'),
    quiz.indexOf('\n    },', quiz.indexOf('_isQuizPassedOrFinished: function')));
  check('_isQuizPassedOrFinished 带**题形闸**：只有「已完成」、全书没题形的文档不许被说成做完',
    passedBody.indexOf('!this._docHasQuizPaperShape(doc)') >= 0,
    passedBody.replace(/\s+/g, ' ').slice(0, 200));

  var skipBody = quiz.slice(quiz.indexOf('_skipQuizForApiUnavailable: function'),
    quiz.indexOf('\n    },', quiz.indexOf('_skipQuizForApiUnavailable: function')));
  check('_skipQuizForApiUnavailable 里**不许**清 `_quizBlockedSinceAt`（清了就等于自己把自己锁死在这一节）',
    skipBody.length > 0 && skipBody.indexOf('_quizBlockedSinceAt = 0') < 0,
    skipBody.replace(/\s+/g, ' ').slice(0, 200));

  var rejectAt = detect.indexOf("if (this._isQuizApiUnavailable()) {");
  var rejectBranch = rejectAt < 0 ? '' : detect.slice(rejectAt, rejectAt + 900);
  check('扫帧拒掉必做测验帧时**自己**把按住标记记上（接线断了就等于「答不了」又被读成「没题做」）',
    rejectBranch.indexOf('this._noteQuizBlockedByApi(') >= 0,
    rejectBranch.replace(/\s+/g, ' ').slice(0, 200));
  check('只在平台说这份卷子**还必做**（workType===job）时才记（已做完的卷子不该因为没填 key 按住整节）',
    /if\s*\(workType\s*===\s*'job'\)\s*this\._noteQuizBlockedByApi\(/.test(rejectBranch),
    rejectBranch.replace(/\s+/g, ' ').slice(0, 200));

  var resetBody = state.slice(state.indexOf('_resetRuntimeState: function'),
    state.indexOf('\n    },', state.indexOf('_resetRuntimeState: function')));
  check('换节 / 换卡片时四个按住时刻一起清（少清 `_quizBlockedSinceAt` 会让下一节秒判超时）',
    ['_quizBlockedByApiAt', '_quizBlockedSinceAt', '_quizBlockedHoldLogAt', '_quizBlockedGiveUpLogAt']
      .every(function (k) { return resetBody.indexOf('this.' + k + ' = 0;') >= 0; }),
    resetBody.replace(/\s+/g, ' ').slice(0, 200));

  var stateBody = state.slice(0, state.indexOf('_resetRuntimeState: function'));
  check('四个按住时刻都在状态段声明过（没声明的字段 = 每轮 undefined，判据第一秒就误判）',
    ['_quizBlockedByApiAt', '_quizBlockedSinceAt', '_quizBlockedHoldLogAt', '_quizBlockedGiveUpLogAt']
      .every(function (k) { return stateBody.indexOf(k + ': 0,') >= 0; }),
    stateBody.replace(/\s+/g, ' ').slice(0, 120));
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\nOmitone 集成测试（真实 content.js + libs/prompt.js，打桩 chrome.*）');

  await testScopeAndSecretBoundaries();
  await testIndexPlumbing();
  await testLegacySchemaCompat();
  await testV1ObjectCompat();
  await testAnswerCoercion();
  await testParseErrorClassification();
  await testPermanentHttpError();
  await testApiErrorClassification();
  await testErrorContractFuzz();
  await testPermanentRoundStopAndConfigRace();
  await testMissingApiKey();
  await testClaudeProtocol();
  await testGeminiProtocol();
  await testPromptContainsBannedAnswers();
  await testEmptyAnswerRefill();
  await testMiddleOptionLetterAbsorb();
  await testFontTable();
  await testThinkingLevels();
  await testApiKeyNormalize();
  await testNormalizeItemIndex();
  await testRejectSignatureSurvivesLogStore();
  await testInjectionWatchdogOwnershipGuard();
  await testQuizScanHoldWiring();
  await testQuizPaperDepthAndApiBlock();

  // 落盘断言总数，供 `npm run check` 核对文档里写的「集成 N 项」。
  // 静态数不出来（每个用例的断言数是动态的），只能由测试自己交出来 ——
  // 与 e2e 的 `.workbuddy/e2e-counts.json` 同款。
  //
  // 为什么需要它：改了测试条数就得手工同步十几处文档（AGENTS / README /
  // tools/README / HANDOVER / CHANGELOG 最新段），**漏一处不会有任何提示**。
  // 1.2.7 那次 77 → 106 就是手工改了 14 处，全靠人眼。
  try {
    fs.writeFileSync(path.join(ROOT, '.workbuddy', 'itest-counts.json'), JSON.stringify({
      assertions: checks,
      failed: failures.length,
      passed: failures.length === 0,
      at: new Date().toISOString()
    }, null, 2));
  } catch (e) {}

  console.log('');
  if (failures.length) {
    console.log('集成测试未通过：' + failures.length + ' / ' + checks + ' 项失败');
    failures.forEach(function (f) { console.log('  - ' + f); });
    console.log('');
    process.exitCode = 1;
  } else {
    console.log('集成测试通过：' + checks + ' / ' + checks + ' 项');
    console.log('');
  }
}

main();
