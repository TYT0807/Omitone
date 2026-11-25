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

function readProductConstant(src, name) {
  var hit = src.match(new RegExp('\\b' + name + '\\s*=\\s*([\\d\\s*]+)\\s*;'));
  if (!hit) return NaN;
  var parts = hit[1].trim().split(/\s*\*\s*/);
  if (!parts.every(function (part) { return /^\d+$/.test(part); })) return NaN;
  return parts.reduce(function (value, part) { return value * Number(part); }, 1);
}

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
  // ⚠️ console 不再是黑洞（队列 #213）：桥死的时候 console 是页面侧**唯一还活着的出口**
  //   （环正是死的那个），桩把它吞掉等于把这一族唯一的证人删了。留数组、不外印，别淹了控制台。
  sandbox.__consoleWarns = [];
  sandbox.console = {
    log: function () {}, info: function () {},
    warn: function () { sandbox.__consoleWarns.push('warn ' + Array.prototype.join.call(arguments, ' ')); },
    error: function () { sandbox.__consoleWarns.push('error ' + Array.prototype.join.call(arguments, ' ')); }
  };
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
  // #223：`performance` **只在调用方给了 timeOrigin 时才挂**。默认不挂，于是「页面读不到 timeOrigin」
  // 那一格由全场其它场景天然覆盖（桥就绪日志里 `doc.at` 必须是 -1，不是 0），
  // 而给了已知时刻的那一发才证得到那个数真是**读回来的**、不是写死的兜底。
  if (options.timeOrigin) sandbox.performance = { timeOrigin: options.timeOrigin };
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
  // ⚠️ 页面运行时那枚 `<script>` 必须**查得到、也摘得掉**（批次 18）。
  // 原先 `getElementById` 恒返回 null、`remove()` 是空操作，于是
  // `removeInjectedScript()` 在夹具里根本改不了任何东西 —— 「teardown 有没有把还在跑的
  // 运行时判死」这类断言压根观察不到，断言只能在夹具的盲点上"通过"。
  // 只登记 PAGE_SCRIPT_ID 一个 id：状态面板、宠物那些保持原样，免得把别的用例带下水。
  var pageScriptTag = null;
  var PAGE_SCRIPT_ID = 'xxt-page-script';
  sandbox.document = {
    readyState: 'loading',               // Test controls startup via startContent().
    isConnected: true,
    documentElement: documentElement,
    head: { appendChild: function (node) {
      sandbox.__injected.push(node);
      if (node && node.id === PAGE_SCRIPT_ID) { node.isConnected = true; pageScriptTag = node; }
    } },
    body: body,
    _listeners: {},
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function (id) {
      if (id === PAGE_SCRIPT_ID) return pageScriptTag && pageScriptTag.isConnected ? pageScriptTag : null;
      return null;
    },
    createElement: function () {
      var el = { style: {}, setAttribute: function () {}, addEventListener: function () {}, _id: '', isConnected: true };
      Object.defineProperty(el, 'id', {
        get: function () { return el._id; },
        set: function (v) { el._id = String(v); }
      });
      el.remove = function () {
        el.isConnected = false;
        if (el._id === PAGE_SCRIPT_ID && pageScriptTag === el) pageScriptTag = null;
      };
      // 状态面板要 attachShadow 才建得起来；没这道桩，`showStatusPanel()` 会在测试里
      // 抛 TypeError，把"重连提示"这条真正要验的路径炸成一条 reject 日志。
      el.attachShadow = function () {
        var shadow = { innerHTML: '' };
        shadow.querySelector = function () {
          return { setAttribute: function () {}, addEventListener: function () {}, textContent: '', isConnected: true, remove: function () {} };
        };
        return shadow;
      };
      return el;
    },
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
  // 批次 18 的两道权限桩（都只作用于发往 SW 的 scope 判定）：
  // - `denyWindow`：**一段时间内**所有 `get_page_scope` 回 'none'，过点自动恢复 ——
  //   真实的纪元跳格拒的就是"那一小段时间"，不是"第 N 条消息"。
  //   ⚠️ 原先写成"前 N 次"，而 content.js 里还有三条后台判据（配置回执 / 解密扫描 /
  //   状态面板）也在问 `get_page_scope`：它们会先把那 N 次吃掉，于是注入"只问一次"时
  //   重试链根本没被拒，断言照样绿 —— 反向验证 X2 第一次就是这么漏的。
  // - `forceScopeNone`：这一页**一直**被判无权限（纪元没恢复 / SW 没醒），
  //   连日志一起拒 —— 用来钉「本地闸不许把唯一的自证据吞掉」。
  var denyWindow = null;
  var forceScopeNone = false;
  // 队列 #213：重载扩展之后，页面里那份 content.js 是**孤儿副本** —— 它调
  // `chrome.runtime.sendMessage` 会**同步抛出** `Extension context invalidated.`，
  // 而不是安静地回 `{success:false}`。原先的桩永远答得上话，所以"桥死"这一族
  // 在集成层从来没有形状（AGENTS §5「断言'绿'有两种：走到了、和根本没走到那一层」）。
  var bridgeDead = null;

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
        if (bridgeDead) throw new Error(bridgeDead);
        sandbox.__runtimeMessages.push(message);
        var policy = sandbox.OmitonePolicy;
        var scope = policy && policy.isChaoxingUrl(sandbox.location.href) ? 'study' : (options.captchaAuthorized ? 'captcha' : 'none');
        if (forceScopeNone) scope = 'none';
        function respond(value) { if (cb) setTimeout(function () { cb(value); }, 0); }
        if (message.type === 'get_page_scope') {
          if (scope !== 'none' && denyWindow && Date.now() >= denyWindow.from && Date.now() < denyWindow.to) {
            return respond({ success: true, scope: 'none', expiresAt: options.expiresAt });
          }
          return respond({ success: true, scope: scope, expiresAt: options.expiresAt });
        }
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
    runtimeListener: function () { return runtimeListener; },
    // 批次 18 用这三道控制模拟「SW 侧权限抖动 + 页面换章节」。`navigateTo` 走的是
    // content.js 自己包装过的 `history.pushState`（真正的学习通切章节就是这条路），
    // 所以它带 500ms 的 `onPageChanged` 延迟 —— 断言等待时间要按这个算。
    navigateTo: function (url) {
      sandbox.location.href = url;
      sandbox.history.pushState({}, '', url);
    },
    denyScopeWindow: function (startMs, endMs) {
      var now = Date.now();
      denyWindow = { from: now + startMs, to: now + endMs };
    },
    forceScopeNone: function (on) { forceScopeNone = !!on; },
    /** 让桥**当场死掉**：`sendMessage` 同步抛出（重载扩展后页面里那份孤儿副本的真实形状）。
     *  传空串复活。⚠️ 它和 `forceScopeNone` 不是一回事：后者是"后台答得上来说没权限"，
     *  前者是"根本没人接话" —— 混用的话，#213 那三格断言测的就不是死桥而是拒绝。 */
    killBridge: function (reason) { bridgeDead = reason === undefined || reason ? (reason || 'Extension context invalidated.') : null; },
    /** 这一页自己 console 里说出去的话（队列 #213：桥死时这是唯一还活着的出口） */
    consoleWarns: function () { return sandbox.__consoleWarns.slice(); },
    /** 页面运行时那枚 `<script>` 此刻还挂在文档上吗（被摘 = 那份 page.js 已判死） */
    pageScriptAlive: function () {
      return !!(pageScriptTag && pageScriptTag.isConnected);
    }
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

/**
 * 把 content.js 里那份**真的**面板分类器 `runtimeLogToStatus` 取出来供测试调用。
 *
 * 为什么要有这一手（批次 92 的教训，批次 97 又撞上同一族）：这一族断言原先写成
 * 「拿正则比 `clsBlock` 里有没有那两句赋值」—— 判据分支被改成永远走不到的形状
 * （`data.allLoading === 'yes'`）时，正则照样匹配得上源字符串，断言照样绿。
 * 只有**真调用**才能把"红绿"交给返回值（AGENTS §5「断言的是行为还是实现细节」）。
 *
 * ⚠️ 取不出来时必须交回 `fn:null` 让调用方**当场点名"这一格没执行"**，
 *    不许返回一个空函数继续往下跑 —— 那是把「没跑到」报成「通过」，
 *    与生产里"还没问到就 return true 认领但不说话"是同一个形状。
 * @param {string} text content.js 原文（CRLF 已归一）
 * @returns {{fn:(Function|null), at:Object, err:string}}
 */
function extractPanelClassifier(text) {
  var at = { clsStart: text.indexOf('function jobKindLabel(') };
  at.fnStart = text.indexOf('function runtimeLogToStatus(', at.clsStart < 0 ? 0 : at.clsStart);
  at.fnEnd = at.fnStart < 0 ? -1 : text.indexOf('\n  }', at.fnStart);
  if (!(at.clsStart >= 0 && at.fnStart > at.clsStart && at.fnEnd > at.fnStart)) {
    return { fn: null, at: at, err: '' };
  }
  try {
    return { fn: new Function(text.slice(at.clsStart, at.fnEnd + 4) + '\n  return runtimeLogToStatus;')(), at: at, err: '' };
  } catch (e) {
    return { fn: null, at: at, err: String(e && e.message) };
  }
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

/**
 * [3c0] 批次 166：失败要点名「哪家哪个模型」，而**退不退由人点**。
 *
 * 用户裁定（issue #2 第 3 条）：
 *   「先做成『点名是哪一家哪个模型失败的』+『一键决定退不退』，不做全自动退到乱填」
 *
 * 为什么渠道只能由扩展侧说（整段断言的地基）：`libs/runtime-policy.js` 的投影里
 * 没有 providerPreset / apiUrl / model，所以页面那份 configs **天生读不到渠道身份**。
 * 让页面自己拼就只能猜，而猜出来的那一句会指着错的那家让用户去充值 —— 比不点名更贵。
 * 链路因此是单向的：整份配置 → channelOf（唯一那把尺）→ 回包 who → 页面存 _quizApiLastWho → 日志与弹窗转述。
 *
 * ⚠️ 每段先自证"东西真取出来了"，取不出来就 return（AGENTS §5「走到了 vs 根本没走到」）。
 */
async function testChannelNamingAndManualRetreat() {
  console.log('\n[3c0] 批次 166：失败点名哪家哪个模型，退不退由人点（不自动退到乱填）');

  var API_ERROR = require('../libs/api-error.js');
  var POLICY = require('../libs/runtime-policy.js');
  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var popupJs = read('popup/popup.js');
  var popupHtml = read('popup/popup.html');
  var quizSrc = read('src/page/70-quiz-flow.js');
  var popupQuizSrc = read('src/page/80-popup-quiz.js');
  var stateSrc = read('src/page/10-config-state.js');
  var contentSrc = read('content.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };

  // ================= ① 三张表必须逐枚相等 =================
  var labelKeys = Object.keys(API_ERROR.CHANNEL_LABELS).sort();
  var presetBlock = (function () {
    var at = popupJs.indexOf('const PROVIDER_PRESETS = {');
    var end = popupJs.indexOf('\n};', at);
    return (at < 0 || end <= at) ? '' : popupJs.slice(at, end);
  })();
  var presetKeys = [];
  presetBlock.replace(/^ {2}"?([A-Za-z0-9_.-]+)"?:\s*\{/gm, function (m, k) { presetKeys.push(k); return m; });
  presetKeys.sort();
  var optionKeys = (function () {
    var at = popupHtml.indexOf('<select id="providerPreset">');
    var end = at < 0 ? -1 : popupHtml.indexOf('</select>', at);
    if (at < 0 || end <= at) return [];
    var out = [], re = /<option value="([^"]+)"/g, m;
    while ((m = re.exec(popupHtml.slice(at, end)))) out.push(m[1]);
    return out.sort();
  })();
  var setDiff = [];
  if (JSON.stringify(labelKeys) !== JSON.stringify(presetKeys)) setDiff.push('CHANNEL_LABELS ⇔ PROVIDER_PRESETS');
  if (JSON.stringify(labelKeys) !== JSON.stringify(optionKeys)) setDiff.push('CHANNEL_LABELS ⇔ popup.html option');

  check('① 三张表逐枚相等（`libs/api-error.js` 的 CHANNEL_LABELS ⇔ 弹窗 PROVIDER_PRESETS ⇔ popup.html 那一排 `<option value>`）'
    + '—— 加了一家而忘了在尺里登记，失败日志就点名成「(渠道读不出)」：用户被告知"认不出是谁家的错"，'
    + '而真相只是我们少写一行，排查方向整个反了（这一族不报错、不留异常，只有那一句误导人）',
    labelKeys.length >= 5 && presetBlock.length > 200 && optionKeys.length >= 5 && setDiff.length === 0,
    JSON.stringify({ labels: labelKeys, presets: presetKeys, options: optionKeys, diff: setDiff }));
  if (setDiff.length || labelKeys.length < 5) return;

  // ================= ② 尺本体：四格各占一格，谁都不许压进谁 =================
  var cPreset = API_ERROR.channelOf({ providerPreset: 'deepseek', apiUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
  check('② 选过 DeepSeek 时 source 是 preset、一句话里厂牌与模型都在；两句"退路话"都不许出现'
    + '（认得出家还写「按接入地址认」，等于把已经拿到的证据扔掉）',
    cPreset.source === 'preset' && cPreset.vendor === 'DeepSeek' &&
    cPreset.text.indexOf('DeepSeek') === 0 && cPreset.text.indexOf('deepseek-chat') > 0 &&
    cPreset.text.indexOf('渠道读不出') < 0 && cPreset.text.indexOf('按接入地址认') < 0,
    JSON.stringify(cPreset));

  var cHost = API_ERROR.channelOf({ apiUrl: 'https://API.Test.com/v1', model: 'm1' });
  var borrowedLabel = labelKeys.filter(function (k) { return cHost.text.indexOf(API_ERROR.CHANNEL_LABELS[k]) >= 0; });
  check('② 没记录选过哪家、只有接入地址时 source 是 host，且**明写这是退回**（「按接入地址认」+ 域名小写）；'
    + '不许冒充成 CHANNEL_LABELS 里的任何一家 —— 冒充就是凭域名编厂牌，用户会去问错那家的客服',
    cHost.source === 'host' && cHost.vendor === 'api.test.com' &&
    cHost.text.indexOf('按接入地址认') > 0 &&
    cHost.text.indexOf('api.test.com') >= 0 && borrowedLabel.length === 0,
    JSON.stringify({ cell: cHost, borrowed: borrowedLabel }));

  var cStale = API_ERROR.channelOf({ providerPreset: 'minimax', apiUrl: 'https://api.minimax.test/v1', model: 'm' });
  check('② 老存档里那个 providerPreset 指向已经删掉的一家时，落回 host 那一格，'
    + '不许凭那串标识符凭空造出一个厂牌（弹窗那侧本来就会把它归一成 custom-openai，两边同形）',
    cStale.source === 'host' && cStale.text.indexOf('按接入地址认') > 0,
    JSON.stringify(cStale));

  var cNone = API_ERROR.channelOf({});
  check('② 渠道与模型双双读不出时，「(渠道读不出)」与「(模型名没填)」两格都在同一句里各说各的；'
    + '压成空串读起来像"没有渠道这回事"，而真相是"我们没读到"（AGENTS §2 #12）',
    cNone.source === 'none' && cNone.text.indexOf('(渠道读不出)') >= 0 &&
    cNone.text.indexOf('(模型名没填)') >= 0, JSON.stringify(cNone));

  var cProto = API_ERROR.channelOf({ apiType: 'claude' });
  var cBogus = API_ERROR.channelOf({ apiType: 'weird-proto' });
  check('② 认不出家时协议是唯一留着的身分线索：claude 那一发要点名「协议 claude」，'
    + '而协议本身是野值时不许编出一句"协议 weird-proto"（把脏数据说成线索 = 替用户指错方向）',
    cProto.text.indexOf('协议 claude') > 0 && cBogus.text.indexOf('协议') < 0,
    JSON.stringify({ claude: cProto.text, bogus: cBogus.text }));

  var junkInputs = [undefined, null, {}, '不是对象', { providerPreset: 123 }, { apiUrl: '不是网址' },
    { apiUrl: 'file:///C:/x' }, { apiUrl: 42, model: null }];
  var junkBad = junkInputs.filter(function (v) {
    var t = API_ERROR.channelText(v);
    return !(typeof t === 'string' && t.length > 0 && t.indexOf('渠道') >= 0);
  }).length;
  check('② channelText 对 ' + junkInputs.length + ' 种垃圾输入都交回**非空**且含「渠道」二字（含传进字符串、数字这种根本不该传的形状）'
    + ' —— 空串进日志就是"这一发没渠道"，而它只是形状怪',
    junkBad === 0, JSON.stringify({ 坏格数: junkBad, 样本: junkInputs.map(function (v) { return API_ERROR.channelText(v).slice(0, 40); }) }));

  // ================= ③ 页面天生说不出渠道（不是口头承诺，是投影里真没有） =================
  var pageView = POLICY.publicConfig({
    providerPreset: 'deepseek', apiUrl: 'https://api.deepseek.com', apiType: 'openai',
    model: 'deepseek-chat', apiKey: 'sk-should-not-leak', enableQuiz: true
  }, 'study');
  var leaked = ['providerPreset', 'apiUrl', 'apiType', 'model', 'apiKey'].filter(function (k) { return k in pageView; });
  var pageNamesPreset = ['src/page/70-quiz-flow.js', 'src/page/80-popup-quiz.js'];
  check('③ 渠道身份**只有扩展侧说得出**：整份配置过一遍投影，providerPreset / apiUrl / apiType / model / apiKey '
    + '一格都不落到页面手里（apiKey 泄漏是另一族，见 #210），所以页面只转述、不自己算；'
    + '静态那半：答题那两个片段里 0 处出现 providerPreset 这个键名',
    leaked.length === 0 && pageNamesPreset.every(function (f) { return read(f).indexOf('providerPreset') < 0 }),
    JSON.stringify({ leaked: leaked, 投影格数: Object.keys(pageView).length }));

  // ================= ④ 真跑请求链：who 随回包与日志一起出去 =================
  var questions = [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }];
  var netFail = function () {
    return { success: false, error: '后台请求失败 —— 无法把请求转发给服务商（网络不通或扩展刚被重载）' };
  };

  var hKimi = createHarness({
    config: { providerPreset: 'kimi', apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' },
    apiResponder: netFail
  });
  hKimi.sendFromPage({ source: 'xxt_app', id: 1661, type: 'llm_request', payload: { questions: questions } });
  var dKimi = await hKimi.waitForResponse(1661);
  check('④ 网络失败那一发的回包带 who，且逐字等于同一把尺算出来的那一句（`channelText(整份配置)`）'
    + ' —— 两处各写一份口径就必然漂移；这一格把「谁家的错」钉在请求链上，而不是钉在日志文本里',
    !!dKimi && typeof dKimi.who === 'string' &&
    dKimi.who === API_ERROR.channelText(hKimi.sandbox.__store.config) &&
    dKimi.who.indexOf('Kimi（Moonshot）') >= 0 && dKimi.who.indexOf('kimi-k3') >= 0,
    JSON.stringify({ who: dKimi && dKimi.who, error: dKimi && String(dKimi.error).slice(0, 40) }));

  var hDeep = createHarness({ apiResponder: netFail });
  hDeep.sendFromPage({ source: 'xxt_app', id: 1662, type: 'llm_request', payload: { questions: questions } });
  var dDeep = await hDeep.waitForResponse(1662);
  check('④ 换一家，who 跟着换（kimi 与默认那两发读出不一样了两句，各自含自己那家）'
    + ' —— 证明它是**从配置算出来的**，不是 content.js 里写死的一个字符串',
    !!dDeep && typeof dDeep.who === 'string' && dDeep.who !== dKimi.who &&
    dDeep.who.indexOf('DeepSeek') >= 0 && dKimi.who.indexOf('DeepSeek') < 0,
    JSON.stringify({ kimi: dKimi && dKimi.who, deep: dDeep && dDeep.who }));

  var directLogs = (hKimi.sandbox.__store.runtimeLogs || []).filter(function (x) {
    return x && x.message === 'llm_request direct failed';
  });
  check('④ 那句 `llm_request direct failed` 的 meta 带 who，且与回包那一格逐字相同'
    + ' —— 现场只导得出日志、导不出回包；两边不同形就等于日志在说另一件事',
    directLogs.length > 0 && directLogs.every(function (x) { return x.meta && x.meta.who === dKimi.who; }),
    JSON.stringify({ 条数: directLogs.length, meta: directLogs.map(function (x) { return x.meta; }).slice(0, 2) }));

  var storedErr = String((hKimi.sandbox.__store.config || {}).apiConnectionError || '');
  check('④ 存储里 `apiConnectionError` 仍是服务商那一句人话，**没有**被渠道前缀挤掉；退避照旧写 '
    + '—— 那格只有 300 字预算，前缀会把「原话」顶出去，而原话才是排查的唯一线索；'
    + '所以渠道落在弹窗独立的一行，不是那句话的开头',
    (hKimi.sandbox.__store.config || {}).apiConnectionFailed === true &&
    storedErr.indexOf('连接不上') >= 0 && storedErr.indexOf('Kimi') < 0 &&
    storedErr.indexOf('刚才问的是') < 0,
    JSON.stringify({ failed: (hKimi.sandbox.__store.config || {}).apiConnectionFailed, err: storedErr.slice(0, 80) }));

  // ================= ⑤ 页面侧的存与读：三格各有其话 =================
  var logs166 = [];
  var say166 = function (level, message, meta) { logs166.push({ level: level, message: String(message || ''), meta: meta }); };
  var markFn = buildFrom(quizSrc, '_markQuizApiConnectionFailed', { emitRuntimeLog: say166 });
  var whoFn = buildFrom(quizSrc, '_quizApiWhoForLog', {});
  check('⑤ 两个方法都能从 70-quiz-flow.js 原样取出来真跑（取不出来时后面每一格都是「没执行」，'
    + '而「没执行」和「通过」在报告里长得一模一样）',
    typeof markFn === 'function' && typeof whoFn === 'function',
    JSON.stringify({ mark: typeof markFn, who: typeof whoFn }));
  if (typeof markFn !== 'function' || typeof whoFn !== 'function') return;

  // #229 · 退避现在要落 sessionStorage，所以这两枚假 app 必须带上**真助手**（`buildFrom` 从片段里取）。
  // 少了它，`_markQuizApiConnectionFailed` 里的 `this._setQuizApiFailUntil` 在裸对象上是 undefined ——
  // 一抛就把整段 ⑤ 顶掉，红名看着像"断言失效"，真相是"根本没跑到"（AGENTS §5）。
  // 假盘的写法照 :10200 那枚假 localStorage：每次换 `data` 就等于"换了个标签页"，不换就等于"F5 之后"。
  var failBox = { data: Object.create(null) };
  var failStore = {
    getItem: function (k) { return failBox.data[k] !== undefined ? failBox.data[k] : null; },
    setItem: function (k, v) { failBox.data[k] = String(v); },
    removeItem: function (k) { delete failBox.data[k]; }
  };
  // 键名从真源读回来，不在测试里抄字面量：抄了 = 生产改了键名而断言照旧绿，
  // 而那正是"存进去 A、回来找 B"这一族的形状（AGENTS §2 #18）。
  var failKeyHit = /_QUIZ_API_FAIL_KEY:\s*'([^']+)'/.exec(quizSrc);
  var FAIL_KEY = failKeyHit ? failKeyHit[1] : '';
  var setFailFn = buildFrom(quizSrc, '_setQuizApiFailUntil', { sessionStorage: failStore });
  var restoreFailFn = buildFrom(quizSrc, '_restoreQuizApiFailUntil', { sessionStorage: failStore });
  var reasonFn = buildFrom(quizSrc, '_getQuizApiUnavailableReason', {});
  var randomFn = buildFrom(quizSrc, '_isRandomAnswerMode', {});
  // 退避那一档的秒数同样从真源读，不写死 45000（改了生产而测试照旧绿 = 空守卫）
  var backoffHit = /_setQuizApiFailUntil\(Date\.now\(\) \+ (\d+)\)/.exec(bodyOf(quizSrc, '_markQuizApiConnectionFailed'));
  var BACKOFF_MS = backoffHit ? Number(backoffHit[1]) : NaN;
  var mkBackoffApp = function (failUntil) {
    return {
      configs: { enableQuiz: true, hasApiKey: true, randomAnswer: false },
      _isRandomAnswerMode: randomFn,
      _QUIZ_API_FAIL_KEY: FAIL_KEY,
      _setQuizApiFailUntil: setFailFn,
      _quizApiFailUntil: failUntil || 0
    };
  };

  var app166 = mkBackoffApp();
  var whoText166 = 'Kimi（Moonshot） · kimi-k3';
  markFn.call(app166, new Error('【连接不上服务商】网络不通'), whoText166);
  var logged166 = logs166.filter(function (x) { return x.message === 'api connection failed, skip quiz'; })[0];
  check('⑤ 写入带 who 时 `_quizApiLastWho` 存下那一串，且 `api connection failed, skip quiz` 的 meta.who '
    + '**逐字等于**存下来那一格（写入口与读出口同形；只改一侧就是"存储说了 A、日志说了 B"）',
    app166._quizApiLastWho === whoText166 && !!logged166 && logged166.meta &&
    logged166.meta.who === app166._quizApiLastWho && logged166.meta.retryInMs > 0,
    JSON.stringify({ stored: app166._quizApiLastWho, meta: logged166 && logged166.meta }));

  var app166b = mkBackoffApp();
  markFn.call(app166b, 'LLM 请求失败');
  var logged166b = logs166.filter(function (x) { return x.message === 'api connection failed, skip quiz'; }).pop();
  check('⑤ 写入**不带** who（catch 那一支：异常在半路抛出，压根没走到服务商）→ 单独一格说清'
    + '「这一发没带渠道」，不许留空串；空串在日志里读起来像"没有渠道这回事"，'
    + '而真相是"请求没发出去" —— 两者的修复方向完全相反',
    app166b._quizApiLastWho.indexOf('这一发没带渠道') >= 0 && app166b._quizApiLastWho.length > 0 &&
    !!logged166b && logged166b.meta.who === app166b._quizApiLastWho,
    JSON.stringify({ stored: app166b._quizApiLastWho }));

  var appFresh = {};
  var freshWho = whoFn.call(appFresh);
  var appEmptyStr = { _quizApiLastWho: '' };
  var emptyWho = whoFn.call(appEmptyStr);
  check('⑤ 这一轮还没问过模型就去读，说的是「(这一轮还没问过模型，渠道没读过)」，不是空串；'
    + '而它必须与「这一发没带渠道」那一格**内容不同** —— 同一句话会把"没问过"与"问过但没带身份"混成一件，'
    + '那正是本轮要消掉的那种歧义',
    freshWho.indexOf('还没问过模型') >= 0 && emptyWho === freshWho && freshWho !== app166b._quizApiLastWho &&
    freshWho.length > 0,
    JSON.stringify({ fresh: freshWho, 没带渠道: app166b._quizApiLastWho }));

  var declAt = stateSrc.indexOf('_quizApiLastWho:');
  var resetSkip = bodyOf(quizSrc, '_resetQuizStateForSkip');
  var resetRuntime = bodyOf(stateSrc, '_resetRuntimeState');
  check('⑤ 它在 10-config-state.js 有自己的声明（默认空串，与 `_quizApiLastError` 并列），'
    + '且**不在**两处复位里被抹掉 —— 它是取证不是记账：45 秒退避一过、换了一节再看日志时，'
    + '这一格是唯一还能说"刚才是哪一家失败"的东西（AGENTS §2 #13 那一族：跨拍才生效的账不许被自己清零）',
    declAt > 0 && resetSkip.length > 100 && resetRuntime.length > 200 &&
    resetSkip.indexOf('_quizApiLastWho') < 0 && resetRuntime.indexOf('_quizApiLastWho') < 0,
    JSON.stringify({ 声明在: declAt > 0, 跳过复位长度: resetSkip.length, 复位长度: resetRuntime.length }));

  // ================= ⑤b 退避要活过 F5（#229）=================
  // 四格各占一格：写进去 / 恢复未来值 / 过期删键 / 读不出与压根没有不动。
  // 「取大不取新」单独钉 —— 覆盖成存值会把长窗口缩短，覆盖成 now+45s 等于把"恢复"变成"续期"。
  var app166c = mkBackoffApp();
  var tBackoff = Date.now();
  markFn.call(app166c, new Error('【连接不上服务商】网络不通'), whoText166);
  var landedBackoff = Number(failBox.data[FAIL_KEY]);
  var shellSrc166 = read('src/page/00-shell-constants.js');
  check('⑤b 退避·写一次就把**同一个未来时刻**同时落进内存字段与 sessionStorage，且写入只剩这一个口径'
    + '（只设内存 = 刷新即丢，正是这一轮的成因；只落存储 = 这一拍不生效；'
    + '而 00-shell-constants 那支若还自己赋字段，就是"存进去 A、回来找 B"那一族）',
    FAIL_KEY.length > 0 && isFinite(BACKOFF_MS) && typeof setFailFn === 'function' &&
    app166c._quizApiFailUntil === landedBackoff && landedBackoff > tBackoff &&
    landedBackoff - tBackoff >= BACKOFF_MS - 300 && landedBackoff - tBackoff <= BACKOFF_MS + 1500 &&
    shellSrc166.indexOf('_quizApiFailUntil') < 0,
    JSON.stringify({ key: FAIL_KEY, backoffMs: BACKOFF_MS, field: app166c._quizApiFailUntil, stored: failBox.data[FAIL_KEY],
      延迟: landedBackoff - tBackoff, 弹窗那支还自己赋字段: shellSrc166.indexOf('_quizApiFailUntil') >= 0 }));

  var appLonger = mkBackoffApp(Date.now() + BACKOFF_MS);
  var longerBefore = appLonger._quizApiFailUntil;
  failBox.data[FAIL_KEY] = String(Date.now() + 5000);
  restoreFailFn.call(appLonger);
  var appFresh166 = mkBackoffApp(0);
  var futureStamp = Date.now() + 30000;
  failBox.data[FAIL_KEY] = String(futureStamp);
  restoreFailFn.call(appFresh166);
  var freshReason = reasonFn.call(appFresh166);
  check('⑤b 退避·新 app（字段 0）读到还没到点的存值 → 恢复成未来时刻，**判据真说得出 api-connection-failed**'
    + '（不是只把字段填上就完事）；而这一轮已有更长窗口时**取大不取新**，恢复不许把窗口缩短、'
    + '更不许由它凭空续一个 45 秒',
    typeof restoreFailFn === 'function' && appFresh166._quizApiFailUntil === futureStamp &&
    freshReason === 'api-connection-failed' && appLonger._quizApiFailUntil === longerBefore &&
    /_restoreQuizApiFailUntil\(\)/.test(bodyOf(stateSrc, 'run')) &&
    bodyOf(stateSrc, 'run').indexOf('_restoreQuizApiFailUntil()') > bodyOf(stateSrc, 'run').indexOf('_resetRuntimeState()'),
    JSON.stringify({ 存值: futureStamp, 恢复后: appFresh166._quizApiFailUntil, 判据: freshReason,
      更长窗口进来时: longerBefore, 恢复后还在: appLonger._quizApiFailUntil,
      run里接上了: /_restoreQuizApiFailUntil\(\)/.test(bodyOf(stateSrc, 'run')) }));

  var appExpired = mkBackoffApp(0);
  failBox.data[FAIL_KEY] = String(Date.now() - 1000);
  restoreFailFn.call(appExpired);
  var expiredReason = reasonFn.call(appExpired);
  check('⑤b 退避·存值已过期 → 字段留在 0 **且键被删**，判据回到可以说得出话的那一格'
    + '（键留着，下一次读它的人要多算一格；而"过期"与"没有"在这一族都该是"可以问模型"）',
    appExpired._quizApiFailUntil === 0 && failBox.data[FAIL_KEY] === undefined &&
    expiredReason !== 'api-connection-failed',
    JSON.stringify({ field: appExpired._quizApiFailUntil, 键还在: failBox.data[FAIL_KEY] !== undefined, 判据: expiredReason }));

  var appGarbage = mkBackoffApp(0);
  failBox.data[FAIL_KEY] = 'not-a-time';
  restoreFailFn.call(appGarbage);
  var garbageKept = failBox.data[FAIL_KEY] === 'not-a-time';
  delete failBox.data[FAIL_KEY];
  var appAbsent166 = mkBackoffApp(0);
  appAbsent166._quizApiFailUntil = 777000000000;
  var absentBefore = appAbsent166._quizApiFailUntil;
  restoreFailFn.call(appAbsent166);
  check('⑤b 退避·「读不出」与「压根没有」各自单独占一格：值不是数 → 字段不动**且键不许删**'
    + '（把读不出实现成清账 = 替用户宣布"刚才没失败过"）；压根没有键 → 内存字段原样不动',
    appGarbage._quizApiFailUntil === 0 && garbageKept && appAbsent166._quizApiFailUntil === absentBefore,
    JSON.stringify({ 垃圾值: failBox.data[FAIL_KEY], 垃圾后字段: appGarbage._quizApiFailUntil,
      无键前: absentBefore, 无键后: appAbsent166._quizApiFailUntil }));

  // 「取大不取新」在**写入口**这一侧单独钉一格：弹窗那支原本就是 `Math.max(现值, now+45s)`，
  // 把口径并进助手之后若退化成直接赋值，先到的长窗口会被后到的一发**缩短** —— 而存储跟着一起缩短。
  var appShorter = mkBackoffApp(Date.now() + 60000);
  var longerField = appShorter._quizApiFailUntil;
  setFailFn.call(appShorter, Date.now() + 5000);
  check('⑤b 退避·写入口也**取大不取新**：已有更长窗口时，来一发更短的时刻既不改内存也不改存储'
    + '（弹窗那支原本的 `Math.max` 就是这个意思，并进口径时丢了它 = 后到的短窗口把在生效的长窗口顶掉）',
    appShorter._quizApiFailUntil === longerField && Number(failBox.data[FAIL_KEY]) === longerField,
    JSON.stringify({ 进来时: longerField, 之后: appShorter._quizApiFailUntil, 存储: failBox.data[FAIL_KEY] }));

  // ================= ⑥ 说话点覆盖：谁说了这句话，就得带上渠道 =================
  var speakSites = [
    ['src/page/70-quiz-flow.js', 'api connection failed, skip quiz'],
    ['src/page/70-quiz-flow.js', 'quiz blocked by api, holding unit'],
    ['src/page/70-quiz-flow.js', 'quiz blocked too long, giving up unit'],
    ['src/page/70-quiz-flow.js', 'skip quiz because api unavailable'],
    ['src/page/80-popup-quiz.js', 'popup quiz llm parse failed, keep popup for retry'],
    ['src/page/80-popup-quiz.js', 'popup quiz llm rejected permanently, no retry'],
    ['src/page/80-popup-quiz.js', 'skip popup quiz because api unavailable'],
    ['content.js', 'llm response parse failed'],
    ['content.js', 'llm_request rejected (permanent)'],
    ['content.js', 'llm request error'],
    ['content.js', 'llm_request direct failed'],
    ['content.js', 'llm_request aborted']
  ];
  var silentSites = [];
  var srcCache166 = {};
  speakSites.forEach(function (pair) {
    var srcText = srcCache166[pair[0]] || (srcCache166[pair[0]] = read(pair[0]));
    var at = srcText.indexOf("'" + pair[1] + "'");
    if (at < 0) { silentSites.push(pair[1] + '（这句在当前源码里找不到）'); return; }
    var next = srcText.indexOf('emitRuntimeLog(', at + 1);
    var block = srcText.slice(at, next < 0 ? at + 600 : next);
    if (!/\bwho\b/.test(block)) silentSites.push(pair[1] + '（' + pair[0] + ' 那一发没带 who）');
  });
  check('⑥ ' + speakSites.length + ' 个"答题用不了"的说话点**每一句**都带上渠道（按名字点名，缺哪句报哪句）'
    + ' —— 漏掉的那一句在现场就是一句"看起来正常"的 warn；下一轮接手的人只能看到"跳过了"，'
    + '看不到"为了什么跳过"（AGENTS §2 #22：needle 要从源码 grep 回来，不许照中文语义猜）',
    silentSites.length === 0, JSON.stringify({ 没带渠道的: silentSites }));

  // ================= ⑦ 退不退由人点：没有任何一条自动路径 =================
  var scanList = ['src/page/00-shell-constants.js', 'src/page/10-config-state.js', 'src/page/30-log.js',
    'src/page/70-quiz-flow.js', 'src/page/75-quiz-dom.js', 'src/page/80-popup-quiz.js',
    'content.js', 'background.js'];
  var randomHits = [];
  scanList.forEach(function (f) {
    var srcText = f.indexOf('80-popup-quiz') >= 0 ? popupQuizSrc : read(f);
    srcText.split('\n').forEach(function (line, i) {
      if (line.indexOf('randomAnswer') < 0) return;
      if (/^\s*[/*]/.test(line)) return;
      randomHits.push({ file: f, line: i + 1, text: line.trim().slice(0, 70) });
    });
  });
  var autoWrites = randomHits.filter(function (h) {
    return /randomAnswer["']?\s*[:=]\s*true/.test(h.text) || /\.randomAnswer\s*=[^=]/.test(h.text) ||
      /randomAnswer\s*\+\+/.test(h.text);
  });
  check('⑦ 页面与扩展侧**没有任何一处**能把乱选打开：' + randomHits.length +
    ' 处命中全部分是默认值 false 与读取（`configs.randomAnswer`），写 true 的那形 0 处 '
    + '—— 「退到乱填」只能由人点；一做成自动，交卷不可逆这件事就没有人负责了（用户原话：不做全自动退到乱填）',
    randomHits.length > 0 && autoWrites.length === 0,
    JSON.stringify({ 命中: randomHits.length, 自动写真的: autoWrites.slice(0, 3) }));

  var retreatWire = (function () {
    var at = popupJs.indexOf('const btn = document.getElementById("apiRetreatBtn");');
    var end = at < 0 ? -1 : popupJs.indexOf('\n})();', at);
    return (at < 0 || end <= at) ? '' : popupJs.slice(at, end);
  })();
  check('⑦ 那一键**只委托**给既有那枚「乱选」开关（找到节点就 `sw.click()`），'
    + '自己不另写一份保存/回滚 —— 复制一份就出现"内存翻了、盘上没翻"那族谎话；'
    + '找不到开关时把出口说清楚（重装 / 手动到「答题」那一栏翻），不许静默什么都不发生',
    retreatWire.indexOf('getElementById("randomAnswer")') >= 0 &&
    retreatWire.indexOf('sw.click()') >= 0 &&
    retreatWire.indexOf('patchConfig(') < 0 && retreatWire.indexOf('saveToggleConfig(') < 0 &&
    /找不到/.test(retreatWire),
    JSON.stringify({ 片段长度: retreatWire.length, 自己保存: retreatWire.indexOf('patchConfig(') >= 0 }));

  var renderBody = (function () {
    var at = popupJs.indexOf('function renderApiConnState');
    var end = popupJs.indexOf('\nfunction apiConfigSummary', at);
    return (at < 0 || end <= at) ? '' : popupJs.slice(at, end);
  })();
  check('⑦ 那一行「现在是不是乱选」从**存储**那份算：`Object.assign({}, DEFAULTS, config)` 之后读 `merged.randomAnswer === true`，'
    + '不读内存里那枚开关镜像 —— 保存被拒时内存已经翻了、盘上没翻，跟着内存说就是一句谎话。'
    + '补默认值也是必需的：新用户存储里 providerPreset 压根没写过，不补就当场读出「(渠道读不出)」'
    + '（AGENTS §2 #23 同族，基准与竞争闸**相反**是有意为之：那个比原始字节，这个比渲染出来的值）',
    renderBody.indexOf('Object.assign({}, DEFAULTS, config') >= 0 &&
    renderBody.indexOf('merged.randomAnswer === true') >= 0 &&
    renderBody.indexOf('randomAnswerVal') < 0,
    JSON.stringify({ 长度: renderBody.length, 读内存镜像: renderBody.indexOf('randomAnswerVal') >= 0 }));

  var hintBody = (function () {
    var at = popupJs.indexOf('function renderApiRetreat');
    var end = popupJs.indexOf('\nfunction ', at + 10);
    return (at < 0 || end <= at) ? '' : popupJs.slice(at, end);
  })();
  var noGuessReal = bodyOf(quizSrc, '_isNoGuessPaper').length > 100 &&
    quizSrc.indexOf('this._isNoGuessPaper()') >= 0;
  check('⑦ 说明那三句真话都在（交卷不可逆 / 插件不会自己打开它 / 下限「高」那一档仍不猜、停下来等），'
    + '而最后那句**有真判据撑着**（`_isNoGuessPaper` 存在且被答题链路调用）'
    + ' —— 少一句就成了"以为退得掉、其实这一张卷子照样不填"，那是比不退更贵的误会',
    hintBody.length > 200 && hintBody.indexOf('交卷不可逆') >= 0 &&
    hintBody.indexOf('插件不会自己打开它') >= 0 && hintBody.indexOf('不猜') >= 0 &&
    hintBody.indexOf('停下来等') >= 0 && noGuessReal,
    JSON.stringify({ 说明长度: hintBody.length, 不猜判据: noGuessReal }));
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

  var refillReq = harness.sandbox.__sentRequests[1];
  var refillPrompt = refillReq ? extractPromptText(JSON.parse(refillReq.body)) : '';
  check('补问只包含漏答的判断题（第 2 条请求也得真存在，不许拿空串蒙过"不含单选题甲"）',
    refillPrompt !== '' && refillPrompt.indexOf('判断题乙') !== -1 && refillPrompt.indexOf('单选题甲') === -1,
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
// [8c] 长度不符被丢弃的那一批：补问改成「一题一问」，别再拿同样的批回同样的形状
//
// 现场（2026-11-11 真页面，20 题卷子）：主批 3 题回 4 项被丢弃，补问还是这 3 题
// 一起问 → **回了逐字相同的 4 项**、又丢弃一次（日志里两条 mismatch 的 excerpt 一模一样）。
// 那三种对齐救法对这种形状全都够不着（多出来的是一个判断题接不住/不属于本题型的值），
// 于是页面侧只能按占位猜 —— 用户看到的「单选题欠了几个」就是这么欠的。
// 而同一份卷子里 5 道多选（本来就单独成批）被摊平成 4~6 项，**5 次全被救回、零丢弃**：
// 批缩小到 1 题就没有「错位给隔壁题」的歧义，这才是可靠的救法。
//
// ⚠️ 同时钉住上界：题多时不许退化成请求洪水（>6 题仍走原来的一次打包补问）。
// ---------------------------------------------------------------------------
async function testDiscardedBatchRefillPerQuestion() {
  console.log('\n[8c] 丢弃批次补问拆成一题一批（含 >6 题仍打包的上界）');

  // 形状 [单选, 单选, 判断] 收到 ["A","D",true,"历史|||人民"]：
  // 并给第 0 题 → 第 1 题拿到 true（单选接不住）；并给第 1 题 → "D" 后面跟的是 true（不是字母）。
  // 三种切法全错，主批必然丢弃 —— 这正是真页面那一格。
  var calls = 0;
  var harness = createHarness({
    modelResponder: function (promptText) {
      calls++;
      if (calls === 1) return JSON.stringify(['A', 'D', true, '历史|||人民']);
      if (String(promptText).indexOf('单选题甲') >= 0) return JSON.stringify(['A']);
      if (String(promptText).indexOf('单选题乙') >= 0) return JSON.stringify(['D']);
      return JSON.stringify([true]);
    }
  });
  harness.sendFromPage({
    source: 'xxt_app', id: 84, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题甲', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 1, type: 'single', title: '单选题乙', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 2, type: 'judge', title: '判断题丙', options: ['正确', '错误'], previousWrongAnswers: [] }
      ]
    }
  });
  var data = await harness.waitForResponse(84);

  check('丢弃批次拆分后收到应答', data !== null);
  if (!data) return;
  check('success = true（三道题不再靠页面占位猜）', data.success === true, JSON.stringify(data).slice(0, 240));
  // ⚠️ 这里**不许**再写 `if (!Array.isArray(data.data)) return;`：
  //   反向验证 X1（把拆批那一支关掉）时 `data.data` 正是缺失的，早退会让下面 4 条
  //   一条都不执行 —— 于是"抓得住"被测试自己的执行模型挡住了（AGENTS §5，批次 16 的 Z5 同款）。
  var list = Array.isArray(data.data) ? data.data : [];
  var byIndex = {};
  list.forEach(function (a) { byIndex[a.index] = a.answer; });
  check('三道题全有答案，且各归各题（0=A / 1=D / 2=true）',
    byIndex[0] === 'A' && byIndex[1] === 'D' && byIndex[2] === true, JSON.stringify(byIndex));
  check('填空那种"不属于本题型的多出来一项"没被硬塞进判断题',
    byIndex[2] === true, JSON.stringify(byIndex[2]));

  check('共 4 次请求（主批 1 + 拆开补问 3）',
    harness.sandbox.__sentRequests.length === 4, '实际 ' + harness.sandbox.__sentRequests.length + ' 次');
  var splitReq = harness.sandbox.__sentRequests[1];
  var onePrompt = splitReq ? extractPromptText(JSON.parse(splitReq.body)) : '';
  check('拆开后的每一批只含一道题（第 2 次请求存在、且里面没有别的题面）',
    onePrompt !== '' && onePrompt.indexOf('单选题乙') < 0 && onePrompt.indexOf('判断题丙') < 0, onePrompt.slice(0, 160));

  var logs = (harness.sandbox.__store && harness.sandbox.__store.runtimeLogs) || [];
  var msgs = logs.map(function (e) { return String(e.message || ''); });
  check('日志写的是 refill split per question，不再是一次打包补问',
    msgs.some(function (m) { return m.indexOf('refill split per question') >= 0; }) &&
    !msgs.some(function (m) { return m === 'llm refill unanswered'; }),
    JSON.stringify(msgs).slice(0, 240));
  var discardedLog = null;
  logs.forEach(function (e) { if (String(e.message || '').indexOf('batch discarded') >= 0) discardedLog = e; });
  check('丢弃日志带上这一批的题型（下一轮排查靠它判该修哪一层）',
    !!discardedLog && String((discardedLog.meta || {}).types || '') === 'single,single,judge',
    JSON.stringify(discardedLog && discardedLog.meta));

  // ===== 上界：丢弃的题一多，仍走原来的一次打包补问 =====
  // 形状要挑对：['A','B','C','D'] 那种会被 trimTrailing 直接切掉尾巴救回来（9 题全答上、
  // 压根到不了补问）。这里多出来的是一段布尔值，三种救法全都够不着 → 每批必丢弃。
  var flood = createHarness({
    modelResponder: function () { return JSON.stringify(['A', 'B', 'C', 'D', true]); }
  });
  var floodQuestions = [];
  for (var i = 0; i < 9; i++) {
    floodQuestions.push({ index: i, type: 'single', title: '单选题' + i, options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] });
  }
  flood.sendFromPage({
    source: 'xxt_app', id: 85, type: 'llm_request', payload: { questions: floodQuestions }
  });
  var floodData = await flood.waitForResponse(85);
  check('9 题全被丢弃时也有应答', floodData !== null);
  var floodLogs = (flood.sandbox && flood.sandbox.__store && flood.sandbox.__store.runtimeLogs) || [];
  var floodMsgs = floodLogs.map(function (e) { return String(e.message || ''); });
  check('题数超上界就不再拆成一题一问（不拿提交次数换请求洪水）',
    !floodMsgs.some(function (m) { return m.indexOf('refill split per question') >= 0; }) &&
    floodMsgs.some(function (m) { return m === 'llm refill unanswered'; }),
    JSON.stringify(floodMsgs).slice(0, 260));
}

// ---------------------------------------------------------------------------
// [8d] 模型**少答**（嫌简答题长、整题跳过）：这一格走整批丢弃，且拆开补问后长答案不许被削
//
// 批次 6 那条待办写的是「`libs/prompt.js` 里 3 题一批对应 `out:7`，一道简答题要占的字数
// 远超这个预算」。本轮先把句子里的**前提**量掉：`out:` 是 `tools/prompt-bench.js` 里
// **量出来的**合成输出 token 数，不是发给服务商的额度；整条链上唯一的输出上限是
// `content.js` 的 `max_tokens`（恒 8192，与题目数无关），而 `normalizeItem` → 位置对齐 →
// `_fillTextarea` 一路没有任何一处按长度截答案。所以「预算把简答挤掉」这一格**在代码里不存在**。
//
// 但同一条链上真有一格会把简答丢掉，方向与待办写的相反：三种长度救法
// （`resegmentFlatAnswers` / `trimTrailingOptionLetters` / `absorbExtraOptionLetters`）
// **全都只处理「回得比题多」**。模型回得**比题少**时三道救法一条都不够着，
// 直接落进「整批丢弃」——同批两道**已经答对**的选择题跟着一起被扔。钉四件事：
//   ① 少答这一格确实走丢弃（而不是错位硬填给隔壁题）；
//   ② 丢弃日志带上题型且**含 short**（[8c] 那格只有 single/judge，覆盖不到这一型 ——
//      AGENTS §2 #18：闸门按题型清单串起来时，新增一型必须同步进清单，这里补的是断言侧同族）；
//   ③ 拆开补问后简答题的长答案**逐字**回来（首尾都在，一处被削就红）；
//   ④ 主批请求文本里带着完整简答题题干 —— 排除「挤」发生在**输入侧**截题干那一族。
// ---------------------------------------------------------------------------
async function testTooFewAnswersKeepsShortAnswerVerbatim() {
  console.log('\n[8d] 模型少答（跳过简答题）：整批丢弃 + 拆开补问后长答案逐字不削');

  // 一条真会出现在简答题里的长度（不是 `'简答文本'` 那种四位占位）。
  var LONG_ANSWER = '答：数据库事务的ACID指原子性、一致性、隔离性与持久性。' +
    '原子性要求事务内的操作要么全部生效、要么全部撤销；一致性要求事务前后数据都满足既定约束；' +
    '隔离性要求并发事务互不干扰，一个事务中途写出的中间状态对其他事务不可见；' +
    '持久性要求一旦提交，即使断电重启这些改动也不会丢失。';
  var SHORT_TITLE = '简述数据库事务的ACID特性及其含义，并举例说明隔离性在并发场景下的表现。';

  var callNo = 0;
  var harness = createHarness({
    modelResponder: function (promptText) {
      callNo++;
      // 主批：3 道题只回 2 项 —— 模型把最后那道简答题整题跳过（「少答」那一格）。
      if (callNo === 1) return JSON.stringify(['A', true]);
      // 拆开补问：按题面认题，简答那一条回**完整长答案**。
      if (promptText.indexOf('事务的ACID') >= 0) return JSON.stringify([LONG_ANSWER]);
      if (promptText.indexOf('单选题甲') >= 0) return JSON.stringify(['A']);
      return JSON.stringify([true]);
    }
  });
  harness.sendFromPage({
    source: 'xxt_app', id: 86, type: 'llm_request',
    payload: {
      questions: [
        { index: 0, type: 'single', title: '单选题甲', options: ['甲', '乙', '丙', '丁'], previousWrongAnswers: [] },
        { index: 1, type: 'judge', title: '判断题丙', options: ['正确', '错误'], previousWrongAnswers: [] },
        { index: 2, type: 'short', title: SHORT_TITLE, options: [], previousWrongAnswers: [] }
      ]
    }
  });
  var data = await harness.waitForResponse(86);

  check('少答那一轮最终也拿到了应答', data !== null);
  if (!data) return;
  check('success = true（简答没让整卷卡死）', data.success === true, JSON.stringify(data).slice(0, 220));

  var reqs = harness.sandbox.__sentRequests || [];
  var firstPrompt = reqs.length ? extractPromptText(JSON.parse(reqs[0].body)) : '';
  check('前提自证：三道题在**同一批**里问出（简答题不像多选那样独占一批）',
    firstPrompt.indexOf('单选题甲') >= 0 && firstPrompt.indexOf('判断题丙') >= 0 &&
    firstPrompt.indexOf('ACID') >= 0, '第一批题面数=' +
    ['单选题甲', '判断题丙', 'ACID'].filter(function (k) { return firstPrompt.indexOf(k) >= 0; }).length);
  check('④ 输入侧没截题干（长题面逐字进了请求，"挤"不在这一头）',
    firstPrompt.indexOf(SHORT_TITLE) >= 0,
    '题目块里简答题干长度=' + (function () {
      var at = firstPrompt.indexOf('3|t|');
      return at < 0 ? -1 : firstPrompt.slice(at).split('\n')[0].length - 4;
    })() + ' / 原长 ' + SHORT_TITLE.length);

  var list = Array.isArray(data.data) ? data.data : [];
  var byIndex = {};
  list.forEach(function (a) { byIndex[a.index] = a.answer; });
  check('夹具自证：这条简答答案本身就够长（缩成占位符会让下面那条等值断言变廉价）',
    LONG_ANSWER.length >= 120, '实际 ' + LONG_ANSWER.length + ' 字');
  check('③ 简答题拿到**逐字完整**的长答案（任何一处被削、被压平、被换成都都红）',
    byIndex[2] === LONG_ANSWER,
    '回来 ' + (typeof byIndex[2] === 'string' ? byIndex[2].length : 0) + ' 字 / 应 ' + LONG_ANSWER.length +
    ' 字，头部=' + JSON.stringify(String(byIndex[2] == null ? '' : byIndex[2]).slice(0, 20)));
  check('① 跟着同批被丢弃的两道选择题，补问后各归各题（没被错位硬填）',
    byIndex[0] === 'A' && byIndex[1] === true, JSON.stringify({ q0: byIndex[0], q1: byIndex[1] }));

  check('共 4 次请求（主批 1 + 拆开补问 3），没退化成反复重问整批',
    reqs.length === 4, '实际 ' + reqs.length + ' 次');

  var logs = (harness.sandbox.__store && harness.sandbox.__store.runtimeLogs) || [];
  var msgs = logs.map(function (e) { return String(e.message || ''); });
  var discardedLog = null;
  logs.forEach(function (e) { if (String(e.message || '').indexOf('batch discarded') >= 0) discardedLog = e; });
  check('①+② 少答走的确实是「整批丢弃」，且丢弃日志的题型里含 short',
    !!discardedLog && String((discardedLog.meta || {}).types || '') === 'single,judge,short',
    JSON.stringify(discardedLog && discardedLog.meta));
  check('① 丢弃日志把收到的那几项抄回来了（只报"几个对几个"判不出是少答还是错批）',
    !!discardedLog && String((discardedLog.meta || {}).received || '') === '2' &&
    String((discardedLog.meta || {}).expected || '') === '3',
    JSON.stringify(discardedLog && discardedLog.meta));
  check('补问走的是 refill split per question（一题一问，简答这次独占一批）',
    msgs.some(function (m) { return m.indexOf('refill split per question') >= 0; }),
    JSON.stringify(msgs).slice(0, 240));
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

  // ---------------------------------------------------------------------------
  // 批次 123-b：三场景「上下限 + 模型自选」，从**页面发请求那一发**一直走到真实请求体。
  //
  // 为什么还要跑一遍全链路而不是只测 libs/thinking.js：这一族真正会坏的地方在**链路上** ——
  // 页面没带 paperKind → 整卷落回刷课档 → 用户放开了考试档却一个参数都没发（钱没多花、
  // 思考也没多出来，而且一句报错都没有）。函数级断言看不见这一格。
  // ---------------------------------------------------------------------------
  var DS = { apiUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };
  var RANGE_CASES = [
    { name: '刷课档 off-off（默认＝升级前，一字不差）', cfg: { thinkingRangeCourse: 'off-off' },
      payload: {}, expect: { thinking: { type: 'disabled' } }, forbid: ['reasoning_effort'], maxTokens: 8192 },
    { name: '刷课档放开 off-high：DeepSeek 出厂就开思考，于是**一个参数都不发**',
      cfg: { thinkingRangeCourse: 'off-high' }, payload: {}, expect: {},
      forbid: ['reasoning_effort', 'thinking'], maxTokens: 16384 },
    { name: '刷课档 low-high（下限不是 off）：只保证思考开着，不替它钉强度',
      cfg: { thinkingRangeCourse: 'low-high' }, payload: {}, expect: { thinking: { type: 'enabled' } },
      forbid: ['reasoning_effort'], maxTokens: 16384 },
    { name: '考试档放开、整卷按考试档发（paperKind=exam 必须走到 exam 档）',
      cfg: { thinkingRangeCourse: 'off-off', thinkingRangeExam: 'low-high' },
      payload: { kind: 'paper', paperKind: 'exam' }, expect: { thinking: { type: 'enabled' } },
      forbid: ['reasoning_effort'], maxTokens: 16384 },
    { name: '同一份配置：章节测验算测试档，不跟考试档混（paperKind 缺省）',
      cfg: { thinkingRangeQuiz: 'off-off', thinkingRangeExam: 'low-high' }, payload: { kind: 'paper' },
      expect: { thinking: { type: 'disabled' } }, forbid: ['reasoning_effort'], maxTokens: 8192 },
    { name: '弹题永远跟刷课档：考试档调到再高也管不着弹题',
      cfg: { thinkingRangeCourse: 'off-off', thinkingRangeExam: 'high-high' }, payload: { kind: 'popup' },
      expect: { thinking: { type: 'disabled' } }, forbid: ['reasoning_effort'], maxTokens: 8192 },
    { name: '只有老键的老用户：整卷 high 照旧按 high 发（新键没写 ≠ 新键写了 off）',
      cfg: { thinkingLevel: 'off', thinkingPaperLevel: 'high' }, payload: { kind: 'paper' },
      expect: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }, maxTokens: 16384 },
    { name: '非法形状（mid-high）落最省的一格，不猜',
      cfg: { thinkingRangeCourse: 'mid-high' }, payload: {}, expect: { thinking: { type: 'disabled' } }, maxTokens: 8192 },
    { name: '区间反着写（high-off）按省→重排：等于 off-high，不会变成「要求高」',
      cfg: { thinkingRangeCourse: 'high-off' }, payload: {}, expect: {},
      forbid: ['reasoning_effort', 'thinking'], maxTokens: 16384 }
  ];
  var rangeBad = [];
  for (var ri = 0; ri < RANGE_CASES.length; ri++) {
    var rc = RANGE_CASES[ri];
    var rHarness = createHarness({ config: Object.assign({}, DS, rc.cfg) });
    var rId = 300 + ri;
    rHarness.sendFromPage({
      source: 'xxt_app', id: rId, type: 'llm_request',
      payload: Object.assign({ questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }] }, rc.payload)
    });
    await rHarness.waitForResponse(rId);
    var rBody = rHarness.sandbox.__sentRequests[0]
      ? JSON.parse(rHarness.sandbox.__sentRequests[0].body) : null;
    if (!rBody) { rangeBad.push(rc.name + '：没有发出请求'); continue; }
    var rMiss = Object.keys(rc.expect).filter(function (k) {
      return JSON.stringify(rBody[k]) !== JSON.stringify(rc.expect[k]);
    });
    var rLeak = (rc.forbid || []).filter(function (k) { return k in rBody; });
    if (rBody.max_tokens !== rc.maxTokens) {
      rangeBad.push(rc.name + '：max_tokens 期望 ' + rc.maxTokens + '，实际 ' + rBody.max_tokens);
    }
    if (rMiss.length || rLeak.length) {
      rangeBad.push(rc.name + '：该带 ' + JSON.stringify(rc.expect) + ' 缺 ' + rMiss.join(',')
        + '；不该带 ' + (rc.forbid || []).join(',') + ' 实际多了 ' + rLeak.join(',')
        + '；请求体 thinking=' + JSON.stringify(rBody.thinking)
        + ' reasoning_effort=' + JSON.stringify(rBody.reasoning_effort)
        + ' enable_thinking=' + JSON.stringify(rBody.enable_thinking));
    }
  }
  check('三场景区间走完整链路（9 格：默认不变 / 放开只钉上限 / 测试与考试分档 / 老键迁移 / 非法与倒序落最省）',
    rangeBad.length === 0, rangeBad.join(' || ') || '9 格全部对上');

  // ---- 区间解析本身：认不出来**不猜**，一律落最省的那一格 ----
  var PARSE = [
    ['off-off', true, 'off', 'off'], ['off-high', true, 'off', 'high'],
    ['low-high', true, 'low', 'high'], ['high-off', true, 'off', 'high'],
    ['high-low', true, 'low', 'high'], ['high', true, 'high', 'high'],
    [' OFF-HIGH ', true, 'off', 'high'], ['mid-high', false, 'off', 'off'],
    ['off-mid', false, 'off', 'off'], ['bogus', false, 'off', 'off'],
    ['', false, 'off', 'off'], ['a-b-c', false, 'off', 'off'], ['off-', false, 'off', 'off']
  ];
  var parseBad = PARSE.filter(function (p) {
    var r = THINKING.parseRange(p[0]);
    return r.ok !== p[1] || r.min !== p[2] || r.max !== p[3];
  }).map(function (p) {
    var r = THINKING.parseRange(p[0]);
    return JSON.stringify(p[0]) + '→ ok=' + r.ok + ' ' + r.min + '/' + r.max + '（期望 ' + p[1] + ' ' + p[2] + '/' + p[3] + '）';
  });
  check('parseRange 十三格：认得的倒序也按省→重排，认不出的一律 ok:false 落 off-off',
    parseBad.length === 0, parseBad.join(' || ') || '13 格全对');

  // ---- 三级来源的**优先级**，出处要能报出来（现场"我明明设过"全靠这一格）----
  check('区间三级来源：单次覆盖 > 场景键 > 老键推导，且 source 点名从哪来',
    THINKING.rangeForTier({ thinkingRangeExam: '', thinkingLevel: 'high' }, 'exam').source === 'legacy'
    && THINKING.rangeForTier({ thinkingRangeExam: '', thinkingLevel: 'high' }, 'exam').min === 'high'
    && THINKING.rangeForTier({ thinkingRangeQuiz: 'low-high', thinkingLevel: 'high' }, 'quiz').source === 'thinkingRangeQuiz'
    && THINKING.rangeForTier({ thinkingRange: 'high-high', thinkingRangeQuiz: 'off-off' }, 'quiz').min === 'high'
    && THINKING.rangeForTier({ thinkingRange: 'high-high', thinkingRangeQuiz: 'off-off' }, 'quiz').source === 'override',
    JSON.stringify([
      THINKING.rangeForTier({ thinkingRangeExam: 'low-low', thinkingLevel: 'high' }, 'exam'),
      THINKING.rangeForTier({ thinkingRangeQuiz: 'low-high', thinkingLevel: 'high' }, 'quiz'),
      THINKING.rangeForTier({ thinkingRange: 'high-high', thinkingRangeQuiz: 'off-off' }, 'quiz')
    ]));
  check('单次覆盖写成认不出的形状也落最省（覆盖那一格同样不许猜）',
    THINKING.rangeForTier({ thinkingRange: 'mid-mid', thinkingLevel: 'high' }, 'course').min === 'off'
    && THINKING.rangeForTier({ thinkingRange: 'mid-mid', thinkingLevel: 'high' }, 'course').ok === false,
    JSON.stringify(THINKING.rangeForTier({ thinkingRange: 'mid-mid', thinkingLevel: 'high' }, 'course')));

  // ---- 老用户迁移：新键**没写过**时三格各推什么（写死 off-off 会在这里悄悄把人降级）----
  var MIGRATE = [
    [{ thinkingLevel: 'high' }, 'course', 'high'],
    [{ thinkingLevel: 'high' }, 'quiz', 'high'],
    [{ thinkingLevel: 'high' }, 'exam', 'high'],
    [{ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, 'course', 'low'],
    [{ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, 'quiz', 'high'],
    [{ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, 'exam', 'high'],
    [{ thinkingLevel: 'high', thinkingPaperLevel: '' }, 'exam', 'high'],
    [{ thinkingLevel: 'high', thinkingPaperLevel: 'bogus' }, 'exam', 'high'],
    [{}, 'exam', 'off'],
    [{ thinkingRangeExam: 'off-off', thinkingLevel: 'high' }, 'exam', 'off']
  ];
  var migrateBad = MIGRATE.filter(function (p) {
    var r = THINKING.rangeForTier(p[0], p[1]);
    // 上下限相等才等于改造前（固定档），否则就不是"迁移"而是"改了行为"
    return r.min !== p[2] || r.max !== p[2];
  }).map(function (p) {
    var r = THINKING.rangeForTier(p[0], p[1]);
    return JSON.stringify(p[0]) + ' / ' + p[1] + '→ ' + r.min + '-' + r.max + '（期望 ' + p[2] + '-' + p[2] + '）';
  });
  check('老键迁移十格：推出来的区间**上下限相等**（= 走固定档 = 与改造前逐字节等价）',
    migrateBad.length === 0, migrateBad.join(' || ') || '10 格全对');
  // 三处出厂默认必须是「这一格从没写过」，一处都不能写 off-off。
  // 为什么弹窗也在内（批次 123-b 实测踩过一次自己埋的坑）：popup 的 load() 写的是
  // `config = {...DEFAULTS, ...存储}`，DEFAULTS 里只要非空，`rangeForTier` 就**永远**拿不到
  // 老键那一支 —— 存量把全局档调到"高"的用户（盘上只有 thinkingLevel:'high'）
  // 打开弹窗看到的是"关闭"，他动任何一个开关触发保存就把 off-off 写回盘。
  // 症状是"答案变差了但一句报错都没有"，而且上面那十格迁移全等于没测。
  var EMPTY_DEFAULT_CELLS = [
    ['content.js', 'thinkingRangeCourse', /thinkingRangeCourse:\s*''/],
    ['content.js', 'thinkingRangeQuiz', /thinkingRangeQuiz:\s*''/],
    ['content.js', 'thinkingRangeExam', /thinkingRangeExam:\s*''/],
    ['src/page/00-shell-constants.js', 'thinkingRangeCourse', /thinkingRangeCourse:\s*''/],
    ['src/page/00-shell-constants.js', 'thinkingRangeQuiz', /thinkingRangeQuiz:\s*''/],
    ['src/page/00-shell-constants.js', 'thinkingRangeExam', /thinkingRangeExam:\s*''/],
    ['popup/popup.js', 'thinkingRangeCourse', /thinkingRangeCourse:\s*""/],
    ['popup/popup.js', 'thinkingRangeQuiz', /thinkingRangeQuiz:\s*""/],
    ['popup/popup.js', 'thinkingRangeExam', /thinkingRangeExam:\s*""/]
  ];
  var shadowed = EMPTY_DEFAULT_CELLS.filter(function (cell) {
    return !cell[2].test(fs.readFileSync(path.join(ROOT, cell[0]), 'utf8'));
  }).map(function (cell) { return cell[0] + ' 的 ' + cell[1]; });
  check('三处出厂默认的三格区间全是空串（写成 off-off 就等于把上面那十格迁移全部作废）',
    shadowed.length === 0,
    shadowed.length ? '这几格带着非空默认值，会永久盖住老键推导：' + shadowed.join(' | ')
      : EMPTY_DEFAULT_CELLS.length + ' 格全是空串');

  // ---- auto 只钉上限：每家能表达"上限"的字段不同，认不出的字段一个都不发 ----
  var AUTO = [
    ['deepseek', 'off-high', {}, 0],
    ['deepseek', 'low-high', { thinking: { type: 'enabled' } }, 0],
    ['qwen', 'low-high', { enable_thinking: true, thinking_budget: 16384 }, 16384],
    ['qwen', 'low-low', { enable_thinking: true, thinking_budget: 1024 }, 1024],
    ['kimi', 'low-high', {}, 0],
    ['unknown', 'off-high', {}, 0]
  ];
  var AUTO_URL = { deepseek: 'https://api.deepseek.com', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kimi: 'https://api.moonshot.ai/v1', unknown: 'https://my-proxy.example.com/v1' };
  var AUTO_MODEL = { deepseek: 'deepseek-v4-flash', qwen: 'qwen3.8-flash', kimi: 'kimi-k3', unknown: 'whatever' };
  // 写成函数：下面「摘掉某家的 auto」那一格还回去以后要**再算一遍**才能证明恢复了 ——
  // 拿摘之前算好的旧数组去比，等于断言"我还没动手时是对的"。
  var evalAuto = function () {
    return AUTO.map(function (p) {
      var built = THINKING.buildThinkingParams({ apiUrl: AUTO_URL[p[0]], model: AUTO_MODEL[p[0]], thinkingRangeCourse: p[1] });
      var same = JSON.stringify(built.params) === JSON.stringify(p[2]) && built.ceiling === p[3];
      return same ? '' : p[0] + ' ' + p[1] + '→ 发 ' + JSON.stringify(built.params)
        + ' 钉预算 ' + built.ceiling + '（期望 ' + JSON.stringify(p[2]) + ' / ' + p[3] + '）';
    }).filter(function (s) { return s; });
  };
  var autoBad = evalAuto();
  check('auto 六格按渠道只钉上限（DeepSeek 不替它定强度；Kimi 与认不出的渠道一个字段都不发）',
    autoBad.length === 0, autoBad.join(' || ') || '6 格全对');
  check('auto 一律算「未验证」，固定档才认实测（Kimi 恒思考，off 也说关不掉）',
    THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-high' }).verified === false
    && THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-off' }).verified === true
    && THINKING.buildThinkingParams({ apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', thinkingRangeCourse: 'off-off' }).canDisable === false,
    JSON.stringify({ offHigh: THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-high' }).verified,
      offOff: THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-off' }).verified }));

  // ---- 预算下限按**上限**取：auto 时不知道模型会想多高，钱要按最贵那一格备好 ----
  check('maxTokensFloor 按区间上限取（off-off 不抬 / off-high 抬到 16384，防"越高越没用"）',
    THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-off' }).maxTokensFloor === 0
    && THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-high' }).maxTokensFloor === 16384
    && THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'low-high' }).maxTokensFloor === 16384
    && THINKING.minMaxTokensForRange({ max: 'mid' }) === 0,
    JSON.stringify([
      THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-off' }).maxTokensFloor,
      THINKING.buildThinkingParams({ apiUrl: 'https://api.deepseek.com', thinkingRangeCourse: 'off-high' }).maxTokensFloor,
      THINKING.minMaxTokensForRange({ max: 'mid' })
    ]));

  // ---- 读模型自选的那一档：读不出必须是 -1，不许压成 0（0 是"真没想"）----
  check('readReasoningTokens 三家回包形状都读得回来，并报出命中哪条字段',
    THINKING.readReasoningTokens({ usage: { completion_tokens_details: { reasoning_tokens: 126 } } }).tokens === 126
    && THINKING.readReasoningTokens({ content: [], usage: { output_tokens_details: { thinking_tokens: 940 } } }).tokens === 940
    && THINKING.readReasoningTokens({ usageMetadata: { thoughtsTokenCount: 320 } }).tokens === 320
    && /thoughtsTokenCount/.test(THINKING.readReasoningTokens({ usageMetadata: { thoughtsTokenCount: 320 } }).field),
    JSON.stringify([
      THINKING.readReasoningTokens({ usage: { completion_tokens_details: { reasoning_tokens: 126 } } }),
      THINKING.readReasoningTokens({ usageMetadata: { thoughtsTokenCount: 320 } })
    ]));
  var unreadable = [[null], [{}], [{ usage: null }], [{ usage: {} }],
    [{ usage: { completion_tokens_details: { reasoning_tokens: '1200' } } }],
    [{ usage: { completion_tokens_details: { reasoning_tokens: -5 } } }]];
  check('读不出交 -1（字符串形状、负数、没有 usage 都算读不出，绝不当成"没花钱"）',
    unreadable.every(function (p) { return THINKING.readReasoningTokens(p[0]).tokens === -1; }),
    JSON.stringify(unreadable.map(function (p) { return THINKING.readReasoningTokens(p[0]); })));
  check('levelFromTokens 只是"按我们自己的预算表估"，读不出交空串',
    THINKING.levelFromTokens(0) === 'off' && THINKING.levelFromTokens(900) === 'low'
    && THINKING.levelFromTokens(5000) === 'high' && THINKING.levelFromTokens(-1) === ''
    && THINKING.levelFromTokens('1200') === '',
    JSON.stringify([0, 900, 5000, -1, '1200'].map(THINKING.levelFromTokens)));

  // ---- 一句话说明：界面与日志共用它，别两处各写一套措辞 ----
  check('describe 把场景、区间、发没发参数、实测与否写进同一句；关不掉的渠道要当场说明',
    /考试思考=\[off,high\] 交给模型自选/.test(THINKING.describe({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-high' }, { tier: 'exam' }))
    && /固定档 off · \{"thinking":\{"type":"disabled"\}\} · 已实测/.test(THINKING.describe({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-off' }, { tier: 'exam' }))
    && /该渠道关不掉思考，实际仍会推理/.test(THINKING.describe({ apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', thinkingRangeCourse: 'off-off' })),
    [
      THINKING.describe({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-high' }, { tier: 'exam' }),
      THINKING.describe({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-off' }, { tier: 'exam' }),
      THINKING.describe({ apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', thinkingRangeCourse: 'off-off' })
    ].join(' / '));
  // 渠道表里若某家**没有**自选写法（只有固定档那一列），auto 只能退化成"按下限发"。
  // 今天四家都有 auto，所以这一支平时走不到 —— 摘掉它就是那条话，测完必须还回去。
  var kimiAuto = THINKING.PROVIDERS.kimi.auto;
  var degraded = '';
  try {
    delete THINKING.PROVIDERS.kimi.auto;
    degraded = THINKING.describe({ apiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', thinkingRangeCourse: 'low-high' });
  } finally {
    THINKING.PROVIDERS.kimi.auto = kimiAuto;
  }
  check('渠道没有自选写法时，describe 说实话「按下限 low 发」而不是「交给模型自选」（摘掉 auto 才走到这一支）',
    /该渠道没有自选写法，按下限 low 发/.test(degraded), JSON.stringify(degraded));
  var autoRestored = evalAuto();
  check('摘掉的 auto 必须真还回去（还完再算一遍六格，别拿摘之前的旧数组当证据）',
    typeof THINKING.PROVIDERS.kimi.auto === 'function' && autoRestored.length === 0,
    autoRestored.join(' || ') || '还回去后 6 格照旧全对');

  // ---- 验证码那一发不跟区间走：它是"看图认字"，想再多也不会认得更准 ----
  var CAPTCHA = require('../libs/captcha.js');
  var capBody = null, capErr = '';
  try {
    capBody = JSON.parse(CAPTCHA.buildRequest({
      apiType: 'openai', apiUrl: 'https://api.deepseek.com', apiKey: 'sk-test-synthetic',
      model: 'deepseek-v4-flash', captchaModel: 'deepseek-v4-flash',
      thinkingRangeCourse: 'high-high', thinkingRangeExam: 'high-high'
    }, 'data:image/png;base64,iVBORw0KGgo=').body);
  } catch (eCap) {
    capErr = String(eCap && eCap.message).slice(0, 160);
  }
  check('验证码请求体自己钉死 off-off：用户放开答题思考不许顺手把识图也调贵',
    !!capBody && JSON.stringify(capBody.thinking) === JSON.stringify({ type: 'disabled' })
    && !('reasoning_effort' in capBody) && capBody.max_tokens === 2048,
    capBody ? ('thinking=' + JSON.stringify(capBody.thinking) + ' effort=' + JSON.stringify(capBody.reasoning_effort)
      + ' max_tokens=' + capBody.max_tokens) : '没拼出请求体：' + capErr);

  // ---- 三个新键必须在 runtime-policy 登记齐：认值 · 投影到页面 · 进摘要 ----
  // 为什么这一格要自己钉，而不是靠 npm run check 第 12 项：那一项判"页面读得到"靠的是
  // `var X = ….configs;` 那种紧贴分号的别名写法，而 70-quiz-flow.js 的 _examThinkingMin 写的是
  // `var cfg = this.configs || {};` —— 它的正则看不见这一处，于是"没投影"在那一项里**恒绿**。
  // 没投影的后果一句报错都没有：弹窗改了、页面读不到，用户只看见"改了没生效"。
  var POLICY = require('../libs/runtime-policy.js');
  var RANGE_KEYS = THINKING.TIERS.map(function (t) { return THINKING.TIER_RANGE_KEYS[t]; });
  var pairBad = [];
  ['off', 'low', 'high'].forEach(function (a) {
    ['off', 'low', 'high'].forEach(function (b) {
      var lo = THINKING.levelRank(a) <= THINKING.levelRank(b) ? a : b;
      var hi = THINKING.levelRank(a) <= THINKING.levelRank(b) ? b : a;
      var patch = { playbackRateCap: 1.5, enableQuiz: true, thinkingRangeExam: lo + '-' + hi };
      var r = POLICY.validatePatch(patch, 'popup');
      // 反序也要收：界面永远从小到大写，但存储可能被手改，真源取小当下限 ——
      // 这里比它严就会把「真源读得懂」的串顶成 invalid_patch，而它拒的是**整张补丁**。
      var rev = POLICY.validatePatch({ thinkingRangeExam: hi + '-' + lo }, 'popup');
      if (!r.success) pairBad.push(lo + '-' + hi + ' → ' + r.code + (r.field ? '/' + r.field : ''));
      if (!rev.success) pairBad.push('(反序)' + hi + '-' + lo + ' → ' + rev.code);
    });
  });
  check('弹窗能拼出的六格区间（含反序）必须被 validatePatch 收下，且不连坐同批其它字段',
    pairBad.length === 0 && POLICY.validatePatch({ thinkingRangeCourse: '', thinkingRangeQuiz: 'low-high',
      thinkingRangeExam: 'high-high', enableVote: true }, 'popup').success,
    pairBad.join(' || ') || '六格正反序 + 空串全部收下');
  check('区间写成认不出的形状要被当场拒（不许带着脏值落进存储，再由页面默默落最省那格）',
    POLICY.validatePatch({ thinkingRangeQuiz: 'mid-high' }, 'popup').code === 'invalid_patch'
    && POLICY.validatePatch({ thinkingRangeQuiz: 'low-high-off' }, 'popup').code === 'invalid_patch'
    && POLICY.validatePatch({ thinkingRangeQuiz: 7 }, 'popup').code === 'invalid_patch'
    && POLICY.validatePatch({ thinkingRangeQuiz: 'off' }, 'popup').success,
    ['mid-high', 'low-high-off', '数字', '单值 off'].map(function (v) {
      return v + ' → ' + JSON.stringify(POLICY.validatePatch({ thinkingRangeQuiz: v }, 'popup'));
    }).join(' || '));
  var projCfg = { apiUrl: 'https://api.deepseek.com', apiKey: 'sk-synthetic', model: 'deepseek-v4-flash',
    thinkingRangeCourse: 'off-low', thinkingRangeQuiz: 'off-high', thinkingRangeExam: 'high-high' };
  var projected = POLICY.publicConfig(projCfg, 'study');
  var missing = RANGE_KEYS.filter(function (k) { return !(k in projected); });
  check('三个区间键必须投影给刷课页面（publicConfig 的 study 面）—— 不投影就是「弹窗改了、页面读不到」',
    missing.length === 0 && projected.thinkingRangeQuiz === 'off-high',
    missing.length ? '页面拿不到：' + missing.join(',') : JSON.stringify(RANGE_KEYS.map(function (k) { return projected[k]; })));
  // 摘要管的是"这一家收不收这个参数"的旧结论何时作废：区间换了 = 发出去的字段换了。
  var fpOff = POLICY.configFingerprint({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-off' });
  var fpAuto = POLICY.configFingerprint({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'off-high' });
  var fpFixed = POLICY.configFingerprint({ apiUrl: 'https://api.deepseek.com', thinkingRangeExam: 'high-high' });
  check('区间换了必须让 API 摘要跟着变（off-off / off-high / high-high 三格互不相同），否则"这家收不收这参数"的旧结论永不过期',
    fpOff !== fpAuto && fpAuto !== fpFixed && fpOff !== fpFixed,
    JSON.stringify([fpOff, fpAuto, fpFixed]));

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

  // ---------------------------------------------------------------------------
  // 批次 121：整卷/弹题按 kind 路由 + max_tokens 随思考档位抬升。
  // 根因：OpenAI 兼容协议**没有独立的思考预算**，思考和答案共用 max_tokens ——
  // 不抬上限的话，"高档"的推理本身就把预算吃光，答案写到一半被截断（越高越没用）。
  // ---------------------------------------------------------------------------
  check('minMaxTokens 三档映射（off 不抬 / low 12288 / high 16384 / 未知回落 0）',
    THINKING.minMaxTokens('off') === 0 && THINKING.minMaxTokens('low') === 12288
    && THINKING.minMaxTokens('high') === 16384 && THINKING.minMaxTokens('bogus') === 0,
    'off=' + THINKING.minMaxTokens('off') + ' low=' + THINKING.minMaxTokens('low')
    + ' high=' + THINKING.minMaxTokens('high') + ' bogus=' + THINKING.minMaxTokens('bogus'));
  check('effectiveLevel：整卷单独档生效（paper 吃 thinkingPaperLevel）',
    THINKING.effectiveLevel({ thinkingLevel: 'off', thinkingPaperLevel: 'high' }, 'paper') === 'high');
  check('effectiveLevel：整卷空串跟随全局（空串是「跟随」不是「关」）',
    THINKING.effectiveLevel({ thinkingLevel: 'low', thinkingPaperLevel: '' }, 'paper') === 'low');
  check('effectiveLevel：整卷键缺失同样跟随全局',
    THINKING.effectiveLevel({ thinkingLevel: 'low' }, 'paper') === 'low');
  check('effectiveLevel：弹题只认全局档，不吃整卷档',
    THINKING.effectiveLevel({ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, 'popup') === 'low');
  check('effectiveLevel：kind 空串与未知值都按全局',
    THINKING.effectiveLevel({ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, '') === 'low'
    && THINKING.effectiveLevel({ thinkingLevel: 'low', thinkingPaperLevel: 'high' }, 'other') === 'low');
  check('effectiveLevel：大小写与空白容忍（界面存大写也不炸）',
    THINKING.effectiveLevel({ thinkingLevel: 'off', thinkingPaperLevel: ' HIGH ' }, 'paper') === 'high');

  // kind 真的从 payload 流到路由：整卷请求带 kind:'paper' 时按整卷档发参数、抬上限；
  // 弹题 kind:'popup' 时按全局档发、不抬。同一种配置跑两遍，两边形状必须相反。
  var kindCfg = { apiUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingLevel: 'off', thinkingPaperLevel: 'high' };
  var paperHarness = createHarness({ config: kindCfg });
  paperHarness.sendFromPage({
    source: 'xxt_app', id: 210, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }], kind: 'paper' }
  });
  await paperHarness.waitForResponse(210);
  var paperBody = paperHarness.sandbox.__sentRequests[0]
    ? JSON.parse(paperHarness.sandbox.__sentRequests[0].body) : null;
  check('kind=paper：按整卷档（high）发思考参数', !!paperBody && paperBody.reasoning_effort === 'high'
    && paperBody.thinking && paperBody.thinking.type === 'enabled',
    paperBody ? ('reasoning_effort=' + paperBody.reasoning_effort + ' thinking=' + JSON.stringify(paperBody.thinking)) : '没有发出请求');
  check('kind=paper：max_tokens 抬到 16384', !!paperBody && paperBody.max_tokens === 16384,
    paperBody ? ('max_tokens=' + paperBody.max_tokens) : '没有发出请求');
  var popupHarness = createHarness({ config: kindCfg });
  popupHarness.sendFromPage({
    source: 'xxt_app', id: 220, type: 'llm_request',
    payload: { questions: [{ index: 0, type: 'single', title: '题干', options: ['甲', '乙'], previousWrongAnswers: [] }], kind: 'popup' }
  });
  await popupHarness.waitForResponse(220);
  var popupBody = popupHarness.sandbox.__sentRequests[0]
    ? JSON.parse(popupHarness.sandbox.__sentRequests[0].body) : null;
  check('kind=popup：按全局档（off）发思考参数，不吃整卷档', !!popupBody && popupBody.thinking
    && popupBody.thinking.type === 'disabled' && !('reasoning_effort' in popupBody),
    popupBody ? ('thinking=' + JSON.stringify(popupBody.thinking)) : '没有发出请求');
  check('kind=popup：max_tokens 保持 8192 不抬', !!popupBody && popupBody.max_tokens === 8192,
    popupBody ? ('max_tokens=' + popupBody.max_tokens) : '没有发出请求');

  // ---- 页面侧「不乱猜」闸（批次 121 第三块拼图）：整卷高档时作业/考试卷不许拿猜测占位交卷 ----
  // 前面两组断言管「参数发出去的样子」；这一块管「模型没答上时页面上会发生什么」。
  // 这一闸此前零自动化覆盖，改坏了集成层不会有任何一格红。
  var quizSrc = fs.readFileSync(path.join(ROOT, 'src/page/70-quiz-flow.js'), 'utf8').replace(/\r\n/g, '\n');
  var buildSlice = function (name, inj) {
    var at = quizSrc.indexOf(name + ': function');
    if (at < 0) return null;
    var start = quizSrc.indexOf('function', at);
    var end = quizSrc.indexOf('\n    },', start);
    if (end <= start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + quizSrc.slice(start, end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  var tierFn = buildSlice('_paperTierFromTitle');
  var minFn = buildSlice('_examThinkingMin');
  var gate = buildSlice('_isNoGuessPaper');
  var holds = [];
  var hold = buildSlice('_noteNoGuessPaperHold', {
    emitRuntimeLog: function (level, msg, meta) { holds.push({ line: level + ' ' + msg, meta: meta }); }
  });
  check('「不乱猜」闸四件真源都能从 70-quiz-flow.js 取到（拿桩等于把闸放过去）',
    typeof gate === 'function' && typeof hold === 'function'
    && typeof tierFn === 'function' && typeof minFn === 'function',
    JSON.stringify({ gate: typeof gate, hold: typeof hold, tier: typeof tierFn, min: typeof minFn }));
  if (gate && hold && tierFn && minFn) {
    var mkGateApp = function (title, cfg) {
      // 两个判据都用**页面自己那份函数**（真从片段里取出来的），不许在这儿写等价逻辑 ——
      // 在这儿重写一遍，页面那句改坏了这七格照样全绿，闸就只剩测试台在保护测试台。
      var gateApp = { _getCurrentTitle: function () { return title; }, configs: cfg || {} };
      gateApp._paperTierFromTitle = tierFn;
      gateApp._examThinkingMin = minFn;
      return gateApp;
    };
    // 改造前后**同一份老配置**必须给出同一个答案（老键还在，只是接管方式为推导）
    check('作业卷、整卷高档时拦下（不拿猜测占位交卷）',
      gate.call(mkGateApp('第3章 作业', { thinkingPaperLevel: 'high' })) === true, '应判 true');
    check('考试卷、整卷高档时同样拦下',
      gate.call(mkGateApp('期末考试', { thinkingPaperLevel: 'high' })) === true, '应判 true');
    check('章节测验不拦（平时分小卷卡住等人的代价反而高）',
      gate.call(mkGateApp('第3章 章节测验', { thinkingPaperLevel: 'high' })) === false, '应判 false');
    check('整卷 low 保持原行为（猜测填满是既有兜底）',
      gate.call(mkGateApp('第3章 作业', { thinkingPaperLevel: 'low' })) === false, '应判 false');
    check('整卷 off 不拦',
      gate.call(mkGateApp('第3章 作业', { thinkingPaperLevel: 'off' })) === false, '应判 false');
    check('整卷空串跟随全局：全局 high 时作业卷拦下',
      gate.call(mkGateApp('第3章 作业', { thinkingPaperLevel: '', thinkingLevel: 'high' })) === true, '应判 true');
    check('整卷空串跟随全局：全局 off 时作业卷不拦',
      gate.call(mkGateApp('第3章 作业', { thinkingPaperLevel: '', thinkingLevel: 'off' })) === false, '应判 false');
    // ↓ 批次 123-b 的新语义：**只有下限钉到 high 才算"这一卷值得慢慢想"**
    check('考试档钉死 high-high 才拦（新键这一格是唯一的贵档承诺）',
      gate.call(mkGateApp('期末考试', { thinkingRangeExam: 'high-high' })) === true, '应判 true');
    check('考试档放开上限（off-high）**不拦**：那是"允许它想"，不是"要求它想"',
      gate.call(mkGateApp('期末考试', { thinkingRangeExam: 'off-high' })) === false, '应判 false');
    check('考试档下限 low 不拦（下限才是承诺）',
      gate.call(mkGateApp('期末考试', { thinkingRangeExam: 'low-high' })) === false, '应判 false');
    check('新键写过就不看老键：老键 high 而新键 off-off 时不拦',
      gate.call(mkGateApp('期末考试', { thinkingLevel: 'high', thinkingRangeExam: 'off-off' })) === false, '应判 false');
    check('认不出的区间落最省，不许把它读成"用户要求高"',
      gate.call(mkGateApp('期末考试', { thinkingRangeExam: 'mid-high' })) === false, '应判 false');
    check('测试档再高也管不着作业卷（考试档与测试档各算各的）',
      gate.call(mkGateApp('第3章 作业', { thinkingRangeQuiz: 'high-high', thinkingRangeExam: 'off-off' })) === false, '应判 false');
    // ---- 反分叉闸：页面重抄的那一小口解析，必须与 libs/thinking.js 逐个对齐 ----
    // 页面跑在主世界，`libs/thinking.js` 注入在隔离世界，**page.js 调不到真源**，
    // 所以 `_examThinkingMin` 只能本地再解析一遍字符串。两处一旦分叉，
    // 症状是「弹窗上显示的是这一档，页面按另一档决定要不要停下等人」——
    // 不报错、不留日志，只有用户觉得"我明明没让它慢慢想，它怎么卡住了"。
    var AGREE = [
      ['老键：全局 high（新键从没写过）', { thinkingLevel: 'high' }, 'high'],
      ['老键：整卷 high、全局 off', { thinkingLevel: 'off', thinkingPaperLevel: 'high' }, 'high'],
      ['老键：整卷空串跟随全局 low', { thinkingLevel: 'low', thinkingPaperLevel: '' }, 'low'],
      ['老键：两个都没写过 → 最省', {}, 'off'],
      ['新键写过就以它为准（压过老键）', { thinkingLevel: 'high', thinkingRangeExam: 'off-off' }, 'off'],
      ['下限 off', { thinkingRangeExam: 'off-high' }, 'off'],
      ['下限 low', { thinkingRangeExam: 'low-high' }, 'low'],
      ['钉死 high', { thinkingRangeExam: 'high-high' }, 'high'],
      ['倒着写要按省→重排（不是取下限字面）', { thinkingRangeExam: 'high-low' }, 'low'],
      ['单值形状＝上下限相等', { thinkingRangeExam: 'high' }, 'high'],
      ['半截认不出 → 落最省（不许拿认得那一格猜）', { thinkingRangeExam: 'mid-high' }, 'off'],
      ['整个认不出 → 落最省', { thinkingRangeExam: 'bogus' }, 'off'],
      ['大小写与空白容忍', { thinkingRangeExam: ' HIGH-LOW ' }, 'low'],
      ['空串是「没写过」，不是「写了 off」', { thinkingRangeExam: '', thinkingLevel: 'high' }, 'high']
    ];
    var fork = [];
    AGREE.forEach(function (p) {
      var bySource = THINKING.rangeForTier(p[1], 'exam').min;
      var byPage = minFn.call({ configs: p[1] });
      if (bySource !== byPage || bySource !== p[2]) {
        fork.push(p[0] + '：真源=' + bySource + '，页面=' + byPage + '，预期=' + p[2]);
      }
    });
    check('页面那句「考试档下限」与 libs/thinking.js 逐形状对齐（14 格，含倒序/单值/半截认不出）',
      fork.length === 0, fork.join(' || ') || '14 格三处读数全等');

    // ---- 场景归属：只有页面知道卷面标题，后台只看见 kind:'paper' 那一个字 ----
    var tierFork = [];
    [['第3章 作业', 'exam'], ['期末考试', 'exam'], ['第2章 章节测验', 'quiz'],
      ['目录', 'quiz'], ['作业：第5章 考试要点', 'exam']].forEach(function (p) {
      var byPage = tierFn.call({ _getCurrentTitle: function () { return p[0]; } });
      // 与真源 resolveTier 同一口径：paper + exam 才算考试档，其余整卷算测试档
      var bySource = THINKING.resolveTier('paper', byPage);
      if (byPage !== p[1] || bySource !== p[1]) tierFork.push(p[0] + '：页面=' + byPage + '，真源=' + bySource);
    });
    check('卷面标题→场景归属两处一致（5 格：作业/考试算考试档，测验与无名卷算测试档）',
      tierFork.length === 0, tierFork.join(' || ') || '5 格全部一致');

    var holdDoc = { quizKey: 'k1' };
    var holdApp = {
      _getQuizWorkKey: function (d) { return d.quizKey; },
      _isQuizQuestionFilled: function () { return false; },
      _getCurrentTitle: function () { return '第3章 作业'; },
      configs: { thinkingRangeExam: 'high-high' },
      // 这句话现在要**把拦它的那一格读回来**写进日志，所以取证的这份也得有真函数
      _examThinkingMin: minFn
    };
    hold.call(holdApp, holdDoc, [{}, {}]);
    var firstCount = holds.length;
    hold.call(holdApp, holdDoc, [{}, {}]);
    check('同一卷子只说一次（否则 200 条日志环被它冲成复读机）',
      firstCount === 1 && holds.length === 1 && String(holds[0].line).indexOf('quiz hold') >= 0,
      '说的话语数=' + holds.length + '，首条=' + JSON.stringify(holds[0] || ''));
    hold.call(holdApp, { quizKey: 'k2' }, [{}]);
    check('换一份卷子要再说一次（warn-once 按 workKey 记账，不跨卷）',
      holds.length === 2, '说的话语数=' + holds.length);
    check('拦下的那句要把「哪一格在拦」读回来（thinkingMin 从配置算，不许写死）',
      !!holds[0] && holds[0].meta && holds[0].meta.thinkingMin === 'high'
      && holds[0].meta.unfilled === 2 && String(holds[0].meta.reason).indexOf('考试档') >= 0,
      JSON.stringify((holds[0] || {}).meta || null));
  }
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
  check('232-E5：复位运行时**不许**抹掉交卷停滞的跨轮记账（#232 现场：stalls 轮轮回到 1，三次上限永远攒不满）',
    !/this\._quizSubmitStall(?:Key|Count|At)\s*=/.test(resetBody),
    resetBody.replace(/\s+/g, ' ').slice(0, 240));

  var stateBody = state.slice(0, state.indexOf('_resetRuntimeState: function'));
  check('四个按住时刻都在状态段声明过（没声明的字段 = 每轮 undefined，判据第一秒就误判）',
    ['_quizBlockedByApiAt', '_quizBlockedSinceAt', '_quizBlockedHoldLogAt', '_quizBlockedGiveUpLogAt']
      .every(function (k) { return stateBody.indexOf(k + ': 0,') >= 0; }),
    stateBody.replace(/\s+/g, ' ').slice(0, 120));
}

// ---------------------------------------------------------------------------
/**
 * 批次 18：章节切换后扩展通道不再空窗。
 *
 * 现场（2026-11-11 用户自己的调试浏览器实测）：学习通切章节走 `pushState`，同一个文档、
 * 不换 JS 上下文。旧 `onPageChanged` **先拆台再问一次权限**，而那一次恰好撞上 SW 侧
 * `tabs.onUpdated` → `revokeTab` 的纪元跳格 → 回 'none' → `start()` return。
 * 台已拆、重建失败，于是页面里那份 page.js 被自己缺失的标签判死，桥从此每条消息
 * `scope_denied`，而本地那道日志闸把唯一的自证据（`content bridge ready`）也一起吞了 ——
 * 用户看到的只有「又不答题了」「卡住了」，日志里一条都不动，唯一解法是手动 F5。
 */
async function testScopeReconnectAfterPageChange() {
  console.log('\n[17] 章节切换不再把通道弄死（先问权威再拆台 / 有界重试 / 日志不被本地闸吞）');

  var src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  function bodyOf(anchor) {
    var at = src.indexOf(anchor);
    if (at < 0) return '';
    var end = src.indexOf('\n  }', at);
    return end < 0 ? '' : src.slice(at, end);
  }

  var CH1 = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=701';
  var CH2 = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=702';
  var CH3 = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=703';

  // ---- ① 一次竞态就必须自己爬起来（真实形状：pushState 那一刻 SW 纪元跳格）
  var h = createHarness({ url: CH1 });
  h.startContent();
  await waitFor(function () { return h.sandbox.__injected.length > 0; }, 3000);
  check('①起点：学习通页面注入了一份 page.js，标签挂在文档上',
    h.sandbox.__injected.length === 1 && h.pageScriptAlive() === true);

  // 竞态窗口设在 pushState 之后 200~900ms：那正是 `onPageChanged`（500ms 延迟）
  // 第一问落下的地方，而后台判据在窗口之前问的都不受影响。
  // ⚠️ 这里不能用"前 N 次被拒"：content.js 里还有三条后台判据也在问 `get_page_scope`，
  //   它们会先把那 N 次吃掉 —— 反向验证 X2 第一次就是这么漏掉的。
  h.denyScopeWindow(200, 900);
  h.navigateTo(CH2);
  // ⚠️ 窗口只有 3 秒，故意比"兜底那一轮"（5 秒）短。
  // 反向验证 X2 就是从这里抓出来的：把重试链换成"只问一次"之后，5 秒兜底轮照样能救回来
  // （只是慢 5 秒），断言于是继续绿 —— 它测的是"最后会不会好"，不是"靠什么好的"。
  // 只问一次的真代价是**每次换章都白挂 5 秒**（视频/答题全停在那一格），
  // 所以这条必须卡在 3 秒之内认。
  await waitFor(function () { return h.sandbox.__injected.length > 1; }, 3000);
  var asks = h.sandbox.__runtimeMessages.filter(function (m) { return m.type === 'get_page_scope'; }).length;
  check('①换章节后第一问被拒**没有就此放弃**：不到 3 秒就重问并重建（不是等 5 秒那一轮兜底）',
    h.sandbox.__injected.length === 2 && h.pageScriptAlive() === true && asks >= 3,
    JSON.stringify({ injected: h.sandbox.__injected.length, scopeAsks: asks }));

  // ---- ② 一直问不到：不许拆掉正在跑的运行时，而且必须说话
  var g = createHarness({ url: CH1 });
  g.startContent();
  await waitFor(function () { return g.sandbox.__injected.length > 0; }, 3000);
  g.forceScopeNone(true);
  g.navigateTo(CH2);
  await new Promise(function (r) { setTimeout(r, 1200); });
  check('②权限还没问到手时**绝不先摘标签**（摘了 = 把还在跑的 page.js 判死，用户只剩 F5）',
    g.pageScriptAlive() === true && g.sandbox.__injected.length === 1,
    JSON.stringify({ alive: g.pageScriptAlive(), injected: g.sandbox.__injected.length }));

  // 四问全空（0/500/1500/3500ms）+ pushState 自己的 500ms 包装延迟
  await waitFor(function () {
    return g.sandbox.__runtimeMessages.some(function (m) {
      return m.type === 'runtime_log_append' && m.payload && m.payload.message === 'scope not granted after page change';
    });
  }, 9000);
  var heldAsks = g.sandbox.__runtimeMessages.filter(function (m) { return m.type === 'get_page_scope'; }).length;
  var heldLogSent = g.sandbox.__runtimeMessages.filter(function (m) {
    return m.type === 'runtime_log_append' && m.payload && m.payload.message === 'scope not granted after page change';
  }).length;
  check('②问满一轮仍无权限时**保持现状 + 说出为什么**：这条 warn 必须发到 SW（本地闸不再吞）',
    heldLogSent >= 1 && g.pageScriptAlive() === true,
    JSON.stringify({ warnSent: heldLogSent, alive: g.pageScriptAlive(), scopeAsks: heldAsks }));
  check('②但发出去 ≠ 存进去：**权威还是 SW**，被拒的页面日志进不了存储',
    (g.sandbox.__store.runtimeLogs || []).every(function (l) {
      return String(l.message || '') !== 'scope not granted after page change';
    }),
    '存储里 ' + JSON.stringify((g.sandbox.__store.runtimeLogs || []).map(function (l) { return l.message; })));
  // ⚠️ 这里**没有**"一轮问了几次"那种行为断言。量过之后发现问数根本测不出重试链：
  //   content.js 里还有三条后台判据（配置回执、解密扫描、状态面板）也在问 `get_page_scope`，
  //   6 秒里它们自己就贡献了 2~3 次，于是"只问一次"那种退化照样过 ——
  //   反向验证 X2 就是这么暴露的（红 1 条，且红的是不相干那条）。
  //   问数的上界交给下面 ⑤ 那张等待表（静态、可判真假），"重问了没有"交给上面 ① 的 2.5 秒窗口。

  // ---- ③ 权威回来后必须自己接上，不用人刷新
  g.forceScopeNone(false);
  g.navigateTo(CH3);
  await waitFor(function () { return g.sandbox.__injected.length > 1; }, 6000);
  check('③SW 重新放行后自动重连成功：重建了运行时尚且标签一直在',
    g.sandbox.__injected.length === 2 && g.pageScriptAlive() === true,
    JSON.stringify({ injected: g.sandbox.__injected.length, alive: g.pageScriptAlive() }));

  // ---- ④ 日志闸放宽只针对学习通，非学习通页面一条都不许多发
  var k = createHarness({ url: CH1 });
  k.forceScopeNone(true);
  k.startContent();
  await new Promise(function (r) { setTimeout(r, 80); });
  var readyOnChaoxing = k.sandbox.__runtimeMessages.filter(function (m) {
    return m.type === 'runtime_log_append' && m.payload && m.payload.message === 'content bridge ready';
  });
  check('④被拒的学习通页面照样把「content bridge ready」发出去（旧本地闸把它吞了 = 排查时一条日志都没有）',
    readyOnChaoxing.length === 1,
    JSON.stringify(k.sandbox.__runtimeMessages.map(function (m) { return m.type; })));
  check('④这条自证据带着 content.js 侧的修复标记（缺标记 = 磁盘改了页面没加载，批次 17 的坑）',
    !!(readyOnChaoxing[0] && readyOnChaoxing[0].payload.meta &&
      Array.isArray(readyOnChaoxing[0].payload.meta.marks) &&
      readyOnChaoxing[0].payload.meta.marks.indexOf('scope-retry') >= 0),
    JSON.stringify(readyOnChaoxing[0] && readyOnChaoxing[0].payload.meta || null));

  // ---- ④ #223：这一发还得说清「哪一份文档、哪一次加载」
  // 三格各钉一个方向，缺任何一格都有一段真实成因没人证：
  //   1 = 地址在场 + 身份在场 + **没有 performance 时读不出（-1，不许塌进 0）**
  //   2 = 那个 at 是**从页面读回来的**（夹具给已知时刻，对得上才算读过）
  //   3 = 同一网址两次执行分得开（href/at 逐字相同、只有 id 变 —— 这正是立项要的那把尺）
  var KNOWN_ORIGIN = 1764000000000;
  function readyMetaOf(h) {
    var got = h.sandbox.__runtimeMessages.filter(function (m) {
      return m.type === 'runtime_log_append' && m.payload && m.payload.message === 'content bridge ready';
    });
    return (got[0] && got[0].payload.meta) || null;
  }
  var metaNoPerf = readyMetaOf(k);
  check('④content bridge ready 报出 href 与文档身份，且没有 performance 时 at 落在「读不出」那一格（-1，不是 0）',
    !!metaNoPerf && metaNoPerf.href === CH1 && !!metaNoPerf.doc &&
      typeof metaNoPerf.doc.id === 'string' && metaNoPerf.doc.id.length > 0 &&
      metaNoPerf.doc.at === -1,
    JSON.stringify(metaNoPerf && { href: metaNoPerf.href, doc: metaNoPerf.doc } || null));
  var n1 = createHarness({ url: CH1, timeOrigin: KNOWN_ORIGIN });
  n1.forceScopeNone(true);
  n1.startContent();
  await new Promise(function (r) { setTimeout(r, 80); });
  var metaTimed = readyMetaOf(n1);
  check('④那个 at 是真从页面读回来的（夹具给了已知时刻就对得上，写死 -1 或抄 URL 都过不了这一格）',
    !!metaTimed && !!metaTimed.doc && metaTimed.doc.at === KNOWN_ORIGIN,
    JSON.stringify(metaTimed && { href: metaTimed.href, doc: metaTimed.doc } || null));
  var n2 = createHarness({ url: CH1, timeOrigin: KNOWN_ORIGIN });
  n2.forceScopeNone(true);
  n2.startContent();
  await new Promise(function (r) { setTimeout(r, 80); });
  var metaAgain = readyMetaOf(n2);
  check('④同一网址再加载一次，两条 ready 分得开（href 与 at 照旧相同，只有 doc.id 必不同）',
    !!metaAgain && !!metaAgain.doc && !!metaTimed && !!metaTimed.doc &&
      metaAgain.href === metaTimed.href && metaAgain.doc.at === metaTimed.doc.at &&
      metaAgain.doc.id !== metaTimed.doc.id,
    JSON.stringify({ first: metaTimed && metaTimed.doc, again: metaAgain && metaAgain.doc }));

  var outside = createHarness({ url: 'https://example.com/blank' });
  outside.startContent();
  await new Promise(function (r) { setTimeout(r, 80); });
  check('④普通域**一条日志都不许多发**：放宽只给学习通网址，别把闸彻底拆掉',
    outside.sandbox.__runtimeMessages.every(function (m) { return m.type !== 'runtime_log_append'; }),
    JSON.stringify(outside.sandbox.__runtimeMessages.map(function (m) { return m.type; })));

  var evil2 = createHarness({ url: 'https://evilchaoxing.com/course' });
  evil2.startContent();
  await new Promise(function (r) { setTimeout(r, 80); });
  check('④仿冒域名同样不发（`isChaoxingUrl` 是那道闸的唯一口径，两边不能各写一份）',
    evil2.sandbox.__runtimeMessages.every(function (m) { return m.type !== 'runtime_log_append'; }));

  // ---- ⑤ 接线守卫：行为测的是"这一次"，顺序测的是"别被人顺手改回去"
  var retry = bodyOf('async function refreshPageScopeWithRetry() {');
  check('⑤存在有界重试，且**网址一变这一轮就作废**（否则旧章节的答复会盖到新章节上）',
    retry.length > 0 && /location\.href\s*!==\s*askedUrl/.test(retry),
    retry.replace(/\s+/g, ' ').slice(0, 180));
  var waitCount = ((retry.match(/waits\s*=\s*\[([^\]]*)\]/) || [ '', '' ])[1].match(/\d+/g) || []).length;
  check('⑤重试链的问数由那张等待表写死：2~4 拍（拍数就是问数，改成无界循环会把 SW 打成筛子）',
    waitCount >= 2 && waitCount <= 4, 'waits 表 ' + waitCount + ' 拍');
  var startBody = bodyOf('async function start() {');
  check('⑤`start()` 走的是有界重试，不是一问就 return',
    startBody.indexOf('refreshPageScopeWithRetry') >= 0 && startBody.indexOf('await refreshPageScope();') < 0,
    startBody.replace(/\s+/g, ' ').slice(0, 160));
  var onChangedBody = bodyOf('function onPageChanged() {');
  // ⚠️ 这里**必须按"动作名"禁**，不能只禁 `removeInjectedScript`。
  //   反向验证 X1 一开始没被抓到：注入的是 `dropPageRuntime()`（一个包好的拆台动作），
  //   而断言只查 `removeInjectedScript` / `pageScope` 两个裸关键字 —— 换了个名字就绕过去了。
  //   拆台动作只准出现在 `restartForCurrentUrl` 里，判据要认的是"这一页该不该拆"，不是拼写。
  check('⑤`onPageChanged` 里不许有任何拆台动作（摘标签 / 抹权限 / `dropPageRuntime` / `resetBridgeState` 都不行）',
    onChangedBody.length > 0 &&
    ['removeInjectedScript', 'pageScope', 'dropPageRuntime', 'resetBridgeState'].every(function (k) {
      return onChangedBody.indexOf(k) < 0;
    }) && onChangedBody.indexOf('restartForCurrentUrl') >= 0,
    onChangedBody.replace(/\s+/g, ' ').slice(0, 200));
  var restartBody = bodyOf('async function restartForCurrentUrl(reason) {');
  check('⑤顺序是「先问权威，再拆台」：重试问排在重建之前',
    restartBody.length > 0 && restartBody.indexOf('refreshPageScopeWithRetry') >= 0 &&
    restartBody.indexOf('refreshPageScopeWithRetry') < restartBody.indexOf('startSafely'),
    restartBody.replace(/\s+/g, ' ').slice(0, 180));
  var resetBody2 = bodyOf('function resetBridgeState() {');
  var dropBody = bodyOf('function dropPageRuntime() {');
  check('⑤拆旧的重建时只清扩展侧状态，**不摘标签**（摘标签只在确定这一页该下线时用）',
    resetBody2.length > 0 && resetBody2.indexOf('removeInjectedScript') < 0 &&
    dropBody.indexOf('removeInjectedScript') >= 0 &&
    restartBody.indexOf('removeInjectedScript') < 0,
    JSON.stringify({ resetHasRemove: resetBody2.indexOf('removeInjectedScript') >= 0, dropHasRemove: dropBody.indexOf('removeInjectedScript') >= 0 }));
  check('⑤问不到又确实该下线时先把话说清（`scope lost` + 面板提示），别留一条空日志流',
    restartBody.indexOf("'scope lost, bridge stopped'") >= 0 && restartBody.indexOf('showStatusPanel') >= 0);
  check('⑤重连轮次有上限（无上限就是永远挂着一个不可信的运行时）',
    /urlRetryRound\s*<\s*URL_RETRY_MAX_ROUNDS/.test(restartBody) && /URL_RETRY_MAX_ROUNDS\s*=\s*3/.test(src));
  var logGate = bodyOf('function appendRuntimeLog(level, message, meta) {');
  check('⑤日志闸的放宽口径只有 `POLICY.isChaoxingUrl(location.href)` 一种写法',
    /if\s*\(!scopeIsCurrent\(\)\s*&&\s*!\(POLICY\s*&&\s*POLICY\.isChaoxingUrl\(location\.href\)\)\)\s*return;/.test(logGate),
    logGate.replace(/\s+/g, ' ').slice(0, 180));
  var marksLine = (src.match(/marks:\s*\[[^\]]*\]/) || [''])[0];
  check('⑤content.js 的自证标记栏非空，且批次 17 / 18 两个标记都在',
    marksLine.indexOf('refill-per-question') >= 0 && marksLine.indexOf('scope-retry') >= 0, marksLine);

  // ---- ⑥ 桥**真死**（重载扩展后那份孤儿副本）：console 是唯一的出口，它必须说得出为什么
  //
  // 现场（队列 #213，2026-11-23 夜）：`notes/field-213-bridge-dead-log.md` §二 量到四格死法
  // （同步抛 / lastError / 20 秒超时 / 空回包）各自都带着可归因的字符串，可旧那句 `console.warn`
  // 一个字都不带，于是四格打成同一句话；而台账把整件事记成 `scope_denied`，排查方向就此跑偏。
  // 测试台原先的桩**永远答得上话**（`runtime_log_append` 顶多回 `{success:false}`），
  // 所以"桥死"这一族在集成层从来没有形状 —— `killBridge` 就是为了补上这一格。
  var b = createHarness({ url: CH1 });
  b.startContent();
  await waitFor(function () { return b.sandbox.__injected.length > 0; }, 3000);
  b.killBridge('Extension context invalidated.');
  var bridgedBefore = b.sandbox.__runtimeMessages.length;
  b.navigateTo(CH2);
  await waitFor(function () {
    return b.consoleWarns().some(function (l) { return l.indexOf('runtime log unavailable') >= 0; });
  }, 9000);
  var deadWarns = b.consoleWarns();
  var logWarn = deadWarns.filter(function (l) { return l.indexOf('runtime log unavailable') >= 0; })[0] || '';
  check('⑥桥同步抛死时，console 那句带得出**原因**（旧那句只说"日志不可用"，四格死法打成一句话）',
    logWarn.indexOf('reason=Extension context invalidated.') >= 0, logWarn.slice(0, 200));
  check('⑥同一发还带出三态 verdict，学习通页权限过期这一格是 `unreadable`',
    logWarn.indexOf('verdict=unreadable') >= 0, logWarn.slice(0, 200));
  var deadTell = deadWarns.filter(function (l) { return l.indexOf('scope not granted after page change') >= 0; })[0] || '';
  check('⑥换章节问不到时 console 另说一句，点名"问不到"而不是"被拒"（面板那句的同源证据）',
    deadTell.indexOf('[verdict=unreadable') >= 0 && deadTell.indexOf('reason=Extension context invalidated.') >= 0,
    deadTell.slice(0, 220));
  // Y3 的那一格证人：这一发**本来就会被本地闸吞掉**（导航后 `scopeIsCurrent()` 已假），
  // 它现在还能出现在 console 里，靠的是 `POLICY.isChaoxingUrl` 那半截。摘掉那半截，本格当场红。
  check('⑥学习通页在本地权限过期时日志这一发**仍走到桥**（旧本地闸把它吞了 = 排查时一条都没有）',
    logWarn.length > 0 && b.sandbox.__injected.length >= 1,
    JSON.stringify({ warns: deadWarns.length, injected: b.sandbox.__injected.length }));
  check('⑥死桥期间一条消息都没上过桥（这才是"日志不进"的成因，不是权限被后台拒了）',
    b.sandbox.__runtimeMessages.length === bridgedBefore &&
    (b.sandbox.__store.runtimeLogs || []).every(function (l) {
      return String(l.message || '') !== 'scope not granted after page change';
    }),
    JSON.stringify({ before: bridgedBefore, after: b.sandbox.__runtimeMessages.length }));
  check('⑥桥死不等于把页面判死：这一页的运行时尚在，只等重连',
    b.pageScriptAlive() === true, 'alive: ' + b.pageScriptAlive());

  // 「问到了但被说不」单独占一格（§2 #12 那一族，与上面 `unreadable` 必须不同形）
  var c = createHarness({ url: CH1 });
  c.startContent();
  await waitFor(function () { return c.sandbox.__injected.length > 0; }, 3000);
  c.forceScopeNone(true);
  c.navigateTo(CH2);
  await waitFor(function () {
    return c.consoleWarns().some(function (l) { return l.indexOf('runtime log unavailable') >= 0; });
  }, 9000);
  var denyWarn = c.consoleWarns().filter(function (l) { return l.indexOf('runtime log unavailable') >= 0; })[0] || '';
  check('⑥「后台答得上来说没权限」那一格读得出来：`reason=scope_denied` + `verdict=denied`',
    denyWarn.indexOf('reason=scope_denied') >= 0 && denyWarn.indexOf('verdict=denied') >= 0, denyWarn.slice(0, 200));
  var healthy = createHarness({ url: CH1 });
  healthy.startContent();
  await new Promise(function (r) { setTimeout(r, 300); });
  check('⑥正常页一句"日志不可用"都不许多说（三态的第三格 `granted` 是沉默的）',
    healthy.consoleWarns().every(function (l) { return l.indexOf('runtime log unavailable') < 0; }),
    JSON.stringify(healthy.consoleWarns()));
  check('⑥普通域权限过期时依旧一条都不发：放宽只给学习通，别把那道闸顺手拆掉',
    outside.consoleWarns().every(function (l) { return l.indexOf('runtime log unavailable') < 0; }),
    JSON.stringify(outside.sandbox.__runtimeMessages.map(function (m) { return m.type; })));

  // ---- ⑦ 接线守卫：三态走的是旁路，取值契约一个字都不许多
  var askBody = bodyOf('function noteScopeAsk(verdict, reason) {');
  check('⑦`noteScopeAsk` 只交回 `none`：三态记在旁路上，`refreshPageScope` 的取值契约没多出第四格',
    /return\s*'none';/.test(askBody) && (askBody.match(/return\s/g) || []).length === 1,
    askBody.replace(/\s+/g, ' ').slice(0, 180));
  var scopeBody = bodyOf('async function refreshPageScope() {');
  check('⑦四格各自记名：`unreadable` / `denied` / `granted` / `stale`，一都没被压掉',
    ['unreadable', 'denied', 'granted', 'stale'].every(function (cell) {
      return scopeBody.indexOf("'" + cell + "'") >= 0;
    }), scopeBody.replace(/\s+/g, ' ').slice(0, 220));
  check('⑦`refreshPageScope` 仍只交 study / captcha / none 那一族，没把三态漏给调用点',
    /return\s+scopeIsCurrent\(\)\s*\?\s*pageScope\s*:\s*'none'/.test(scopeBody) &&
    /return\s+noteScopeAsk\(/.test(scopeBody), scopeBody.replace(/\s+/g, ' ').slice(-160));
  var reasonBody = bodyOf('function askReason(response) {');
  check('⑦取不到原因时交 `(未回原因)`，空串不许当成"原因就是空的"（读不出单独占一格）',
    reasonBody.indexOf("'(未回原因)'") >= 0 && reasonBody.indexOf('.slice(0, 120)') >= 0,
    reasonBody.replace(/\s+/g, ' ').slice(0, 180));
  check('⑦console 那句的原因取自回包本身（`askReason(result)`），不是写死的一串字',
    logGate.indexOf("'reason=' + askReason(result)") >= 0 &&
    logGate.indexOf("'verdict=' + SCOPE_ASK.verdict") >= 0,
    logGate.replace(/\s+/g, ' ').slice(0, 200));
  check('⑦两处出口都把 verdict 与 reason 同时带进 meta 与 console（各两发，少一处就是半截话）',
    (restartBody.match(/scopeAsk: SCOPE_ASK\.verdict/g) || []).length === 2 &&
    (restartBody.match(/askError: SCOPE_ASK\.reason/g) || []).length === 2 &&
    (restartBody.match(/announceBridgeDeath\(/g) || []).length === 2,
    JSON.stringify({ meta: (restartBody.match(/scopeAsk:/g) || []).length, tell: (restartBody.match(/announceBridgeDeath\(/g) || []).length }));
  check('⑦面板两处文字都按 `unreadable` 分格，且旧那句「没问到权限」「没通过」都留着',
    (restartBody.match(/SCOPE_ASK\.verdict === 'unreadable'/g) || []).length === 2 &&
    restartBody.indexOf('连不上扩展（刚重载过扩展就是这样）') >= 0 &&
    restartBody.indexOf('多次问不到扩展') >= 0 &&
    restartBody.indexOf('切换章节后没问到权限') >= 0 &&
    restartBody.indexOf('多次询问权限都没通过') >= 0,
    restartBody.replace(/\s+/g, ' ').slice(0, 200));
  var announceBody = bodyOf('function announceBridgeDeath(message, verdict, why) {');
  check('⑦console 那一句不复述 `href`（那里躺着选课 id，日志是要导出给人看的）',
    announceBody.length > 0 && announceBody.indexOf('href') < 0 && announceBody.indexOf('[verdict=') >= 0,
    announceBody.replace(/\s+/g, ' ').slice(0, 180));
  check('⑦自证标记栏带上本轮那一枚 `bridge-reason-193`（缺标记 = 磁盘改了页面没加载，批次 17 的坑）',
    marksLine.indexOf('bridge-reason-193') >= 0, marksLine);
}

// ---------------------------------------------------------------------------
/**
 * 批次 19-B：附件清单是**异步渲染**的，读到的 0 不等于"这一节没任务点"。
 *
 * 现场（2026-11-11 用户原话「7.3的就直接跳过了，不知道为什么」「单元测试也没写」）：
 *   13:15:33 `study begin {attachments:0}`
 *   13:15:36 `search job: every candidate frame was rejected {attachments:6,…}`  ← 同一个 getter 三秒后读到 6
 *   13:15:36 `study finished on page {searchedCount:0}`
 *   13:15:41 `study next unit {searchedCount:0}`                                 ← 整节 8 秒被翻过去
 * 旧公式 `min(3 + n*2, 10)` 在 n=0 时只给 3 秒：越是什么都没看见，越快要断定没活干。
 *
 * 同一天第二笔（13:41:33）证明"光把窗口拉长不够"：那一轮**已经等满 10 秒**，
 * 帧里却还写着平台自己的占位文案「正在为您加载文件...」→ `searchedCount:0` → 照样翻过去。
 * 于是 ⑤ 验第二半：认这个**正面证据**，给这一张卡片一个有界的额外窗口。
 */
async function testOcsDiscoveryWindow() {
  console.log('\n[18] 附件清单要重新问、帧自己说在加载要认：读 0 不许当成「这一节做完了」（3.1 / 7.3 被整节翻过去）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var detect = read('src/page/60-tasks-detect.js');
  var style = read('src/page/62-tasks-run.js');

  var buildFrom = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return null;
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    if (end <= start) return null;
    return new Function('return (' + src.slice(start, end) + '\n    })')();
  };
  var windowMs = buildFrom(detect, '_taskDiscoveryWindowMs');
  var tick = buildFrom(detect, '_noteOcsDiscoveryTick');
  check('①能取出窗口算术两个方法（取不到是签名/缩进变了，不等于没有回归）',
    typeof windowMs === 'function' && typeof tick === 'function',
    JSON.stringify({ windowMs: typeof windowMs, tick: typeof tick }));
  if (typeof windowMs !== 'function' || typeof tick !== 'function') return;

  var oldScaled = global.scaledMs;
  global.scaledMs = function (ms) { return ms; };
  var fake = { _taskDiscoveryWindowMs: windowMs };
  try {
    check('②空清单给**满窗 10 秒**（旧公式在这里只给 3 秒，正是 3.1 被翻过去的那 3 秒）',
      windowMs(0) === 10000, 'windowMs(0)=' + windowMs(0));
    check('②有附件时沿用原口径：1 个 5 秒 / 2 个 7 秒 / 4 个以上封顶 10 秒',
      windowMs(1) === 5000 && windowMs(2) === 7000 && windowMs(4) === 10000 && windowMs(30) === 10000,
      JSON.stringify([windowMs(1), windowMs(2), windowMs(4), windowMs(30)]));
    check('②读数坏掉（undefined / NaN / 负数 / 字符串）按空清单处理，**不许给 0**（0 = 立刻放弃）',
      windowMs(undefined) === 10000 && windowMs(NaN) === 10000 &&
      windowMs(-5) === 10000 && windowMs('x') === 10000,
      JSON.stringify([windowMs(undefined), windowMs(NaN), windowMs(-5), windowMs('x')]));
    check('②窗口随附件数单调不减，且空清单不短于任何有附件的情况',
      [1, 2, 3, 4, 5].every(function (n) { return windowMs(n) <= windowMs(n + 1); }) &&
      windowMs(0) >= windowMs(1),
      JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(windowMs)));

    var T0 = 1794402933000;
    var st = { startedAt: T0, until: T0 + windowMs(0), seen: 0, budget: 0 };
    check('③现场起点（13:15:33 读 0）窗口开到 T0+10s，而不是旧代码的 T0+3s',
      st.until === T0 + 10000, JSON.stringify(st));

    var grew = tick.call(fake, st, 6, T0 + 3000);
    check('③三秒后清单里冒出 6 个（13:15:36 的真实读数）→ 续窗，而不是当场宣布这一节做完了',
      grew === true && st.seen === 6 && st.budget === 6 && st.until === T0 + 3000 + windowMs(6),
      JSON.stringify(st));

    var again = tick.call(fake, st, 6, T0 + 4000);
    check('③数量不变就不续期（每轮都续等于这条循环永不超时，一个悬挂会杀死主循环）',
      again === false && st.until === T0 + 13000, JSON.stringify(st));

    var shrunk = tick.call(fake, st, 2, T0 + 5000);
    check('③清单往回抖（章节过滤回落）既不认账也不缩窗（缩窗会把刚认出来的任务点当场丢回去）',
      shrunk === false && st.seen === 6 && st.until === T0 + 13000, JSON.stringify(st));

    var late = tick.call(fake, st, 9, T0 + 46000);
    check('③续窗有硬顶：45 秒后的新增只能顶到 `startedAt+45s`，不许越过去',
      late === true && st.seen === 9 && st.budget === 9 && st.until === T0 + 45000, JSON.stringify(st));

    var past = tick.call(fake, st, 20, T0 + 60000);
    check('③窗口已经过期时，光靠"清单又变多了"不能复活它（45 秒是硬顶，不是每次都能加钱）',
      past === false && st.until === T0 + 45000, JSON.stringify(st));

    var untilBefore = st.until;
    var junk = tick.call(fake, st, undefined, T0 + 47000);
    check('③读数坏了不许把 until 写成 NaN（`now < NaN` 永远 false，又变回 3 秒跳过整节）',
      junk === false && st.until === untilBefore && Number.isFinite(st.until), JSON.stringify(st));
  } finally {
    global.scaledMs = oldScaled;
  }

  // ---- ④ 接线：算术对了但循环没重新问 = 白修 ----
  var rAt = detect.indexOf('_ensureOcsStudyRunner: function');
  var runnerBody = rAt < 0 ? '' : detect.slice(rAt, detect.indexOf('\n    },', rAt));
  check('④定位得到 `_ensureOcsStudyRunner`', runnerBody.length > 500, 'len=' + runnerBody.length);
  var asks = (runnerBody.match(/_getChaoxingAttachments\(\)/g) || []).length;
  check('④循环体里**又问了一次**附件清单（只在开跑那一刻读一次就是这次事故的形状）',
    asks >= 2, 'reads=' + asks);
  check('④旧的"一次性 setTimeout 关窗"没有回来（`searching = false` 那种写法）',
    !/searching\s*=\s*false/.test(runnerBody));
  check('④关窗判据读的是**会被续期的那个终点**（`Date.now() < discovery.until`）',
    runnerBody.indexOf('Date.now() < discovery.until') >= 0);
  // ⚠️ 认**调用形状**，不认光秃秃的方法名：方法名还会出现在注释里，
  //   反向验证 Y1（把调用换成 `if (false)`）第一次就是这么溜过去的 —— 断言绿得毫无意义。
  var tickCall = runnerBody.search(/_noteOcsDiscoveryTick\(\s*discovery\s*,/);
  var untilAt = runnerBody.indexOf('Date.now() < discovery.until');
  check('④续窗真的发生在关窗判定之前（写在后面等于这一轮白续）',
    tickCall >= 0 && tickCall < untilAt,
    JSON.stringify({ tickCall: tickCall, untilAt: untilAt }));
  check('④`study finished on page` 带着「凭什么说做完了」：附件数 + 实际等了多久',
    /'study finished on page'[\s\S]{0,200}attachments:\s*discovery\.seen[\s\S]{0,80}waitedMs:/.test(runnerBody),
    runnerBody.slice(runnerBody.indexOf('study finished on page'), runnerBody.indexOf('study finished on page') + 220).replace(/\s+/g, ' '));

  check('④窗口口径只有一份：style runner 也走 `_taskDiscoveryWindowMs`，不再自带公式',
    style.indexOf('this._taskDiscoveryWindowMs(') >= 0 && !/Math\.min\(3 \+/.test(style),
    JSON.stringify({ shared: style.indexOf('_taskDiscoveryWindowMs'), inline: /Math\.min\(3 \+/.test(style) }));
  var formulaFiles = fs.readdirSync(path.join(ROOT, 'src', 'page'))
    .filter(function (f) { return f.slice(-3) === '.js'; })
    .map(function (f) { return [f, (read('src/page/' + f).match(/Math\.min\(3 \+/g) || []).length]; })
    .filter(function (x) { return x[1] > 0; });
  check('④`min(3 + n*2, 10)` 全书只许出现一次（两份公式早晚漂回"读 0 就 3 秒放弃"）',
    formulaFiles.length === 1 && formulaFiles[0][0] === '60-tasks-detect.js',
    JSON.stringify(formulaFiles));

  // ---- ⑤ 帧自己说「正在加载」：10 秒窗也等不到的那一族（13:41:33 现场） ----
  var stillLoading = buildFrom(detect, '_noteTaskFrameStillLoading');
  check('⑤能取出 `_noteTaskFrameStillLoading`', typeof stillLoading === 'function',
    typeof stillLoading);
  check('⑤拒绝帧的取证里接上了这道闸（只记日志不接判据 = 白取证）',
    /_noteTaskFrameStillLoading\(\s*sig\s*,/.test(detect.slice(0, rAt)), 'caller missing');
  check('⑤runner 把加载窗当第 4 个实参交给续窗算术（不传 = 认了证据却不续期）',
    /_noteOcsDiscoveryTick\(\s*discovery\s*,\s*liveInventory\s*,\s*Date\.now\(\)\s*,\s*self\._taskFrameLoadingUntil\s*\)/.test(runnerBody),
    runnerBody.slice(runnerBody.indexOf('_noteOcsDiscoveryTick('), runnerBody.indexOf('_noteOcsDiscoveryTick(') + 120).replace(/\s+/g, ' '));
  check('⑤`study inventory grew` 只在清单**真的**变多时才发（被加载窗推后不是"清单变多"）',
    /if \(discovery\.seen > grewFrom\)/.test(runnerBody));

  if (typeof stillLoading === 'function') {
    var oldLog = global.emitRuntimeLog;
    var logs = [];
    global.emitRuntimeLog = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
    global.scaledMs = function (ms) { return ms; };
    var card = 'chapter-7|card-3|fp-6';
    var mk = function () {
      return {
        _taskFrameLoadingUntil: 0, _taskFrameLoadingScope: '', _studyProgressKey: function () { return card; },
        _taskDiscoveryWindowMs: windowMs,
      };
    };
    try {
      var a = mk();
      var armedAt = Date.now();
      var ret = stillLoading.call(a, { text: '正在为您加载文件...', textLen: 10, qTotal: 0, video: 0, answer: 0, pan: 0 }, 'readcache', true);
      check('⑤帧里写着「正在为您加载文件」→ 认成还没加载好，给出一个**未来**的窗口终点',
        ret > armedAt && a._taskFrameLoadingUntil === ret && logs.length === 1 &&
        logs[0].meta.why === 'loading-text', JSON.stringify({ ret: ret - armedAt, logs: logs }));

      var b = mk();
      var blankRet = stillLoading.call(b, { text: '', textLen: 0, qTotal: 0, video: 0, answer: 0, pan: 0 }, 'readcache', true);
      check('⑤整张白纸 + 清单上有任务点 = 同一个后果（13:15:36 `{attachments:6,textLen:0}` 那一笔）',
        blankRet > Date.now() && logs[logs.length - 1].meta.why === 'blank-frame-with-attachments',
        JSON.stringify({ ret: blankRet, why: logs[logs.length - 1].meta.why }));

      var c = mk();
      var noInv = stillLoading.call(c, { text: '', textLen: 0, qTotal: 0, video: 0, answer: 0, pan: 0 }, 'readcache', false);
      check('⑤白纸**且清单也空**不认（真空章节不许被磨蹭拖住，那是另一种翻过去）',
        noInv === 0 && c._taskFrameLoadingUntil === 0 && logs.length === 2, JSON.stringify({ ret: noInv, logs: logs.length }));

      var d = mk();
      var busy = stillLoading.call(d, { text: '下列哪个选项是正确的', textLen: 10, qTotal: 5, video: 0, answer: 4, pan: 0 }, 'readcache', true);
      check('⑤帧里有题有作答框时不认（这道闸只管"没加载好"，不许变成万能延时）',
        busy === 0 && d._taskFrameLoadingUntil === 0, JSON.stringify({ ret: busy }));

      logs.length = 0;
      var held = stillLoading.call(a, { text: '正在为您加载文件...' }, 'readcache', true);
      check('⑤窗口没到期时同样的证据**不续期**（每轮都续 = 这条循环永不超时）',
        held === a._taskFrameLoadingUntil && logs.length === 0, JSON.stringify({ held: held, logs: logs.length }));

      a._taskFrameLoadingUntil = Date.now() - 1;
      var spent = stillLoading.call(a, { text: '正在为您加载文件...' }, 'readcache', true);
      check('⑤同一张卡片的窗口用掉后放行（把「跳过」换成「磨蹭」是另一种事故）',
        spent === 0 && a._taskFrameLoadingScope === card, JSON.stringify({ spent: spent, scope: a._taskFrameLoadingScope }));

      var e = mk();
      var cap = stillLoading.call(e, { text: 'loading' }, 'readcache', true);
      check('⑤延时有界：单张卡片最多 20 秒',
        cap - Date.now() <= 20000 && cap - Date.now() > 0, 'holdMs=' + (cap - Date.now()));

      var g = mk();
      var lg = stillLoading.call(g, { text: '正在为您加载文件...' }, 'readcache', true);
      var st2 = { startedAt: Date.now(), until: Date.now() + 1000, seen: 6, budget: 0 };
      var merged = tick.call({ _taskDiscoveryWindowMs: windowMs }, st2, 6, Date.now(), g._taskFrameLoadingUntil);
      check('⑤加载窗接进续窗算术后，**数量没变**也能把窗口推后（③那条"不续期"只约束清单抖动）',
        lg > 0 && merged === true && st2.until === g._taskFrameLoadingUntil && st2.seen === 6,
        JSON.stringify({ until: st2.until - Date.now(), seen: st2.seen }));
    } finally {
      global.emitRuntimeLog = oldLog;
      global.scaledMs = oldScaled;
    }
  }
}

/**
 * 批次 76：短提示词的「缓存全没命中」不再当告警。
 *
 * 现场（2026-11-17，刷课中的日志环）：两条 `llm prefix cache all missed`，
 * 取证分别是 `{hit:0,miss:197}` 与 `{hit:0,miss:146}` —— 都来自视频弹题那种
 * **单题一次请求**的链路。DeepSeek 的公共前缀缓存以 256 token 为一块，
 * 不足一块的请求**结构上不可能命中**，所以"全没命中"这句话没有任何信息量，
 * 却是一条 warn：用户会照着"前缀被打脏了"去查提示词卫生，方向整个错掉。
 *
 * ⚠️ 这里取的是 content.js 里**真实的那一份**函数体，阈值也从源码读回来，
 * 不在测试里抄一份数字 —— 抄了就等于测试和生产各拿一把尺，谁漂了都不知道。
 */
async function testCacheBlockWarnThreshold() {
  console.log('\n[19] 短提示词的「缓存全没命中」不再骗人（不够一块就不该是 warn）');

  var src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  function bodyOf(anchor) {
    var at = src.indexOf(anchor);
    if (at < 0) return '';
    var end = src.indexOf('\n  }', at);
    return end < 0 ? '' : src.slice(at, end);
  }

  var blockFromSrc = Number((src.match(/CACHE_BLOCK_MIN_TOKENS\s*=\s*(\d+)/) || [])[1]);
  var body = bodyOf('function logCacheUsage(usage) {');
  check('①取得出 content.js 里的 logCacheUsage 与那块阈值（取不到是签名变了，不等于没回归）',
    body.length > 200 && blockFromSrc > 0 &&
    body.indexOf('prefixMissSuppressed++') >= 0 && body.indexOf('all missed') >= 0,
    JSON.stringify({ bodyLen: body.length, block: blockFromSrc }));
  if (body.length <= 200 || !(blockFromSrc > 0)) return;

  var BLOCK = blockFromSrc;
  var fnSrc = body;

  /** 把真实函数体装进一个可控时钟的沙箱里跑，回收它写出的每一条日志。 */
  function mk() {
    var logs = [];
    var box = { now: 1000000 };
    var FakeDate = { now: function () { return box.now; } };
    var factory = new Function('appendRuntimeLog', 'Date',
      'let prefixMissLogAt = 0;\n' +
      'let prefixMissSuppressed = 0;\n' +
      'const CACHE_BLOCK_MIN_TOKENS = ' + BLOCK + ';\n' +
      // bodyOf 交出的是**不含收尾花括号**的那一截，这里要自己补上再收尾
      fnSrc + '\n  }\n' +
      'return function (usage) { return logCacheUsage(usage); };');
    var call = factory(function (level, message, meta) {
      logs.push({ level: level, message: message, meta: meta });
    }, FakeDate);
    return { call: call, logs: logs, box: box };
  }

  // 装不起来就别往下跑：后面每一条都会变成"没执行"，而"没执行"和"通过"长得一样
  var probe = null, probeErr = '';
  try { probe = mk(); } catch (e) { probeErr = (e && e.message) || String(e); }
  check('①′真函数体能装进沙箱跑起来（装不起来后面每一条都是空测）', !!probe, probeErr);
  if (!probe) return;

  // ---- ① 现场那一族：单题弹题，整份输入不到一块
  var short = mk();
  short.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 197 });
  check('①现场形状（hit:0 / miss:197，不够 ' + BLOCK + ' 一块）只出 info，**不再出 warn**',
    short.logs.length === 1 && short.logs[0].level === 'info' &&
    short.logs[0].message === 'llm prefix cache' &&
    short.logs[0].meta.belowBlock === BLOCK,
    JSON.stringify(short.logs));

  // ---- ② 够一块还全 miss = 真的可疑，warn 必须保留（别把闸一起拆了）
  var longMiss = mk();
  longMiss.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 });
  check('②够一块而全没命中（miss:1200）**仍然**给那条 warn',
    longMiss.logs.length === 1 && longMiss.logs[0].level === 'warn' &&
    longMiss.logs[0].message === 'llm prefix cache all missed' &&
    longMiss.logs[0].meta.hit === 0 && longMiss.logs[0].meta.miss === 1200,
    JSON.stringify(longMiss.logs));

  // ---- ③ 边界钉住比较方向：恰好一块要 warn，差一个 token 不 warn
  var atBlock = mk();
  atBlock.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: BLOCK });
  var underBlock = mk();
  underBlock.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: BLOCK - 1 });
  check('③阈值两侧各钉一格（恰好 ' + BLOCK + ' 算够一块，该 warn；差一个 token 不该）',
    atBlock.logs.length === 1 && atBlock.logs[0].level === 'warn' &&
    underBlock.logs.length === 1 && underBlock.logs[0].level === 'info',
    JSON.stringify({ at: atBlock.logs.map(function (l) { return l.level; }),
      under: underBlock.logs.map(function (l) { return l.level; }) }));

  // ---- ④ 有命中的正常形状照旧，且不许带上 belowBlock（那是"短"的标记，不是通用字段）
  var hitCase = mk();
  hitCase.call({ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
  check('④有命中（hit:800 / miss:200）出 info 且不带 belowBlock',
    hitCase.logs.length === 1 && hitCase.logs[0].level === 'info' &&
    hitCase.logs[0].message === 'llm prefix cache' &&
    hitCase.logs[0].meta.belowBlock === undefined &&
    hitCase.logs[0].meta.hitRate === '80%',
    JSON.stringify(hitCase.logs));

  // ---- ⑤ 非 DeepSeek：两个字段都没有 → 一条都不写
  var noUsage = mk();
  noUsage.call({ prompt_tokens: 50, completion_tokens: 10 });
  noUsage.call(null);
  check('⑤服务商没给这两个字段时一条日志都不写（别的模型不该被这一族刷屏）',
    noUsage.logs.length === 0, JSON.stringify(noUsage.logs));

  // ---- ⑥ 防空转记账：短请求不许冒充"缓存恢复正常"把 suppressed 抹掉
  //      长 miss(warn) → 长 miss(被吞) → 短 miss(什么也没证明) → 窗口过后长 miss
  //      第四条里 suppressed 必须还是 1；写成 0 就是"中间那条短日志把账清了"。
  var acct = mk();
  acct.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 });
  acct.box.now += 1000;
  acct.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1500 });
  acct.box.now += 1000;
  acct.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 197 });
  acct.box.now += 400000;
  acct.call({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1300 });
  var warns = acct.logs.filter(function (l) { return l.level === 'warn'; });
  check('⑥节流与记账：四条请求只出两条 warn，且中间那条短请求**没把** suppressed 抹成 0',
    acct.logs.length === 3 && warns.length === 2 &&
    warns[0].meta.suppressed === 0 && warns[1].meta.suppressed === 1,
    JSON.stringify(acct.logs));

  // ---- ⑦ 函数活着不等于有人在叫它（AGENTS §2 #3 那一族的反面）
  var callSites = src.split(/\r?\n/).filter(function (l) {
    return l.indexOf('logCacheUsage(') >= 0 && l.indexOf('function logCacheUsage(') < 0;
  });
  check('⑦真调用点还在，且交的是响应里的 usage（函数留着、调用点被删 = 这一族日志静默消失）',
    callSites.length === 1 && callSites[0].indexOf('.usage') >= 0,
    JSON.stringify(callSites.map(function (l) { return l.trim(); })));
}

/**
 * 批次 92：「每枚候选帧都被拒」这句 warn 的节流地板，以及「还在加载」单独占一格。
 *
 * 现场（2026-11-17 巡检 notes/field-watch-20261117-0943.md §5①）：这一条在 24 分钟的环里
 * 出现 4 次，取证显示**每一枚候选帧都挂着 `frame-loading`** —— 帧还没长出来，
 * 而面板那一格写的是「这一节的帧挑不出活」（注意）。同族的两条老账：
 * 批次 37（节流被 reason 交替绕过）与批次 51（两句话轮流把证据窗挤空）——
 * **只认签名变了、不认时间**就是刷屏的入口，因为 OCS 循环每秒调一次，
 * 拒绝清单里两三条原因只要措辞或顺序抖一下就是一条新 warn。
 *
 * ⚠️ 两个判据都从 `src/page/60-tasks-detect.js` 里**取真实那一份**来跑，门槛数字也从源码读回来：
 * 抄进测试就等于两边各拿一把尺，改生产阈值时测试不会跟着红。
 */
async function testJobRejectLogThrottle() {
  console.log('\n[20] 「每枚候选帧都被拒」的节流地板与「还在加载」那一格');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var detect = read('src/page/60-tasks-detect.js');
  var cTxt = read('content.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var buildFrom = function (src, name) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    return new Function('return (' + src.slice(r.start, r.end) + '\n    })')();
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return '';
    return src.slice(r.start, r.end + 5);
  };

  var due = buildFrom(detect, '_jobRejectLogDue');
  var allLoading = buildFrom(detect, '_rejectsAllStillLoading');
  check('①′ 两个判据都能从切片里取出来真跑（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    typeof due === 'function' && typeof allLoading === 'function',
    'due=' + typeof due + ' allLoading=' + typeof allLoading);
  if (typeof due !== 'function' || typeof allLoading !== 'function') return;

  // ---- ① 门槛数字从源码读回来（两把尺：30 秒地板 + 防抖动的短地板）
  var nums = (bodyOf(detect, '_jobRejectLogDue').match(/now - lastAt > (\d+)/g) || [])
    .map(function (s) { return Number(s.replace(/\D+/g, '')); });
  var LONG = nums[0], FLOOR = nums[1];
  check('① 算术里确实是「两把尺」而不是一把（一把长地板补一句、一把短地板挡抖动），数字从磁盘读回来',
    nums.length === 2 && LONG > FLOOR && FLOOR > 0, '读到的门槛=' + JSON.stringify(nums));

  var T = 1700000000000;
  var cell = function (lastAt, lastSig, sig, at) {
    return due.call({ _jobRejectLogAt: lastAt, _jobRejectSignature: lastSig }, sig, at);
  };

  // ---- ② 节流矩阵（每一格都说得出它是哪一道闸给的）
  check('②a 从没记过就直接说（第一条不许被任何地板吞掉，否则新问题永远不出声）',
    cell(0, '', 'A', T) === true);
  check('②b 同签名且没到长地板就不说（这就是「每秒一调」原本的抑制路径）',
    cell(T - (LONG - 1000), 'A', 'A', T) === false);
  check('②c 同签名但过了长地板就补一句（状态可能真变了，长期沉默比刷屏更糟）',
    cell(T - (LONG + 1000), 'A', 'A', T) === true);
  check('②d 签名变了且过了短地板才说（页面结构变了要有声音）',
    cell(T - (FLOOR + 1000), 'A', 'B', T) === true);
  check('②e ★签名逐拍抖动但没到短地板就不说（这一格就是本批次新增的那道地板）',
    cell(T - (FLOOR - 1000), 'A', 'B', T) === false);

  // ---- ③ 边界两侧：门槛是 `>` 还是 `>=`，只钉一侧抓不住写反
  var bLong = cell(T - LONG, 'A', 'A', T);
  var bFloor = cell(T - FLOOR, 'A', 'B', T);
  check('③ 两道地板的「恰好等于门槛」都不算越线（比较方向写反这里必红，且两格分开取证）',
    bLong === false && bFloor === false, 'longBoundary=' + bLong + ' floorBoundary=' + bFloor);

  // ---- ④ 接线：emit 那一格真的走这道判据，旧写法不许留在原地形成两套尺
  var iCall = detect.indexOf('this._jobRejectLogDue(rejectSignature, nowReject)');
  check('④a 日志出口真的问 `_jobRejectLogDue`（判据写好了但调用点没换 = 这道地板是死的，现场照样刷屏）',
    iCall > 0, 'indexOf=' + iCall);
  check('④b 旧的「只看签名不看时间」那道 inline 判断已经不在了（两套判据并存时改哪一套都看不出）',
    !/rejectSignature !== this\._jobRejectSignature \|\|/.test(detect),
    '仍残留旧写法');

  // ---- ⑤ 「还在加载」那一格的口径（含 `every` 在空数组上的陷阱）
  check('⑤a 每一枚都挂着 frame-loading 才算「还在加载」，混进一枚真拒绝就不算',
    allLoading.call({}, [{ loading: 'frame-loading' }, { loading: 'frame-loading' }]) === true &&
    allLoading.call({}, [{ loading: 'frame-loading' }, { reason: '是测验任务但已完成' }]) === false);
  check('⑤b ★空清单不许被 `every` 读成「都在加载」（一帧都没找到恰恰是该出声音的那一格）',
    allLoading.call({}, []) === false && allLoading.call({}, null) === false);
  check('⑤c 项里没有 loading 字段、或者压根不是对象时一律不算在加载',
    allLoading.call({}, [{}, { loading: 'other' }]) === false && allLoading.call({}, [null]) === false);

  // ---- ⑥ 取证与级别：降噪靠分类，不靠把声音关掉
  var emitAt = detect.indexOf("emitRuntimeLog('warn', 'search job: every candidate frame was rejected'");
  var emitBlock = emitAt < 0 ? '' : detect.slice(emitAt, emitAt + 700);
  check('⑥ 取证里带 allLoading 这一格、级别仍是 warn（改成 info 就等于把这一族从现场摘掉），签名也带上「还在加载」的标记',
    emitAt > 0 && emitBlock.indexOf('allLoading: allStillLoading') > 0 &&
    detect.indexOf("'|still-loading'") > 0, JSON.stringify({ emitAt: emitAt, hasField: emitBlock.indexOf('allLoading') > 0 }));

  // ---- ⑦′⑦ 面板分类器**真跑**：把 content.js 里那份 `runtimeLogToStatus` 本体取出来喂两种形状
  // ⚠️ 批次 92：这一格原先是拿正则比 `clsBlock` 里有没有那两句赋值 —— 那样判据分支写成永远走不到
  // （例如条件被改成 `data.allLoading === 'yes'`）照样绿。改成真调用，红绿都由返回值说话。
  var pc = extractPanelClassifier(cTxt);
  var classifier = pc.fn;
  check('⑦′ 面板分类器能从 content.js 里取出来真跑（取不出来时下面那格是「没执行」，不是「通过」）',
    typeof classifier === 'function', JSON.stringify(pc.at) + (pc.err ? ' err=' + pc.err : ''));
  if (typeof classifier !== 'function') return;

  var MSG = 'search job: every candidate frame was rejected';
  var shapeAll = classifier('warn', MSG, { frames: 3, attachments: 2, allLoading: true,
    rejects: [{ loading: 'frame-loading' }, { loading: 'frame-loading' }, { loading: 'frame-loading' }] });
  var shapeNone = classifier('warn', MSG, { frames: 2, attachments: 1, rejects: [] });
  var shapeFalse = classifier('warn', MSG, { frames: 2, attachments: 1, allLoading: false,
    rejects: [{ loading: 'frame-loading' }, { reason: 'quiz done' }] });
  check('⑦ 面板按 allLoading 分两格：为真降成 wait「任务框还在加载」，为假／没给仍是 warn「这一节的帧挑不出活」（只留前者就是把真故障也哑掉）',
    shapeAll.state === 'wait' && shapeAll.task === '任务框还在加载' &&
    /3 个帧/.test(shapeAll.detail) && /每一帧都还写着在加载/.test(shapeAll.detail) &&
    shapeAll.named === true &&
    shapeNone.state === 'warn' && shapeNone.task === '这一节的帧挑不出活' &&
    /2 个帧/.test(shapeNone.detail) && /1 个任务点/.test(shapeNone.detail) &&
    shapeFalse.state === 'warn' && shapeFalse.task === '这一节的帧挑不出活',
    JSON.stringify({ all: shapeAll, none: shapeNone, asFalse: shapeFalse }));

  // ---- ⑨ 调用点反孤儿：两个新判据各只有一处真调用
  var callLines = function (needle, defNeedle) {
    return detect.split(/\r?\n/).filter(function (l) {
      return l.indexOf(needle) >= 0 && l.indexOf(defNeedle) < 0;
    });
  };
  var dueCalls = callLines('this._jobRejectLogDue(', '_jobRejectLogDue: function');
  var loadCalls = callLines('this._rejectsAllStillLoading(', '_rejectsAllStillLoading: function');
  check('⑧ 两个判据各自都还有真调用点（函数留着、没人叫它 = 这一格静默回到旧行为）',
    dueCalls.length === 1 && loadCalls.length === 1,
    JSON.stringify({ due: dueCalls.length, loading: loadCalls.length }));
}

/**
 * 批次 93：被站点顶下线的学习页 —— 四态分开说，能自己回去才回去。
 *
 * 现场（2026-11-16 用户原话「连续开两个课程有一个会被顶下去」；巡检
 * notes/field-watch-20261117-*.md 里那一枚停在 `i.mooc.chaoxing.com/space/index` 的标签页）：
 * 站点把同一账号的第二枚学习页顶下线，被顶的那一枚从此只会每 120 秒说一句
 * 「这一页认不出课程结构，请手动回到章节页」，可底下有四种完全不同的真相 ——
 * 能自己回去 / 另一枚还占着账号（不能抢）/ 回去过两次还被顶（该交给人的）/ 这页压根不是插件带来的。
 * 压成一句时，「不用管」和「这一门一直没刷」在用户眼里长得一模一样（AGENTS §2 #12 那一族）。
 *
 * ⚠️ 四件套都从盘上取**真实那一份**来跑，三个地板也从 `00-shell-constants.js` 读回来：
 *   后台 `background.js`               `noteTabStudyUrl` / `pruneTabStudyMemory` / `studyRescueVerdict`
 *   页面 `src/page/64-tasks-loop.js`   `_askStudyTabState` / `_displacedStudyPagePlan` / `_speakDisplacedStudyPage`
 * 抄进测试就等于两边各拿一把尺，改生产阈值时测试不会跟着红。
 */
async function testDisplacedStudyPageRescue() {
  console.log('\n[21] 被站点顶下线的学习页：四态分开说，能自己回去才回去');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var bg = read('background.js');
  var shell = read('src/page/00-shell-constants.js');
  var loop = read('src/page/64-tasks-loop.js');
  var runTxt = read('src/page/62-tasks-run.js');
  var cTxt = read('content.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return '';
    return src.slice(r.start, r.end + 5);
  };
  // 页面那三件是 app 的属性，跑之前要把自由变量注进去（emitRuntimeLog / location / bridgeSend）
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var args = names.map(function (k) { return inj[k]; });
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, args);
  };
  // 后台那几件是顶层 function，只在这一层缩进闭合；抓过了头就交白卷，宁可不跑
  var topFnText = function (src, name) {
    var at = src.indexOf('\n  function ' + name + '(');
    if (at < 0) return null;
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n  }', start);
    if (end < 0) return null;
    var text = src.slice(start, end + 4);
    return text.indexOf('\n  function ') >= 0 ? null : text;
  };
  var evalNum = function (expr) {
    try { return Number(new Function('return (' + expr + ')')()); } catch (e) { return null; }
  };
  var numVar = function (src, name) {
    var m = src.match(new RegExp('var ' + name + ' = ([^;\\n]+);'));
    return m ? evalNum(m[1]) : null;
  };

  var PENDING = numVar(shell, 'DISPLACED_ASK_PENDING_MS');
  var FRESH = numVar(shell, 'DISPLACED_ASK_FRESH_MS');
  var SILENCE = numVar(shell, 'DISPLACED_SILENCE_MS');
  var AWAY = numVar(bg, 'STUDY_AWAY_WINDOW_MS');
  var CAP = numVar(bg, 'STUDY_RESCUE_CAP');
  var MEM_MAX = numVar(bg, 'STUDY_MEMORY_MAX');
  var reM = bg.match(/var STUDY_URL_RE = (\/[^;\n]+\/[a-z]*)/);
  var SRE = null;
  try { SRE = reM ? new Function('return (' + reM[1] + ')')() : null; } catch (eRe) { SRE = null; }

  // 现场实测的两个地址（合成号，不带真实课程）
  var STUDY_URL = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=7&clazzid=3&cpi=9';
  var PORTAL_URL = 'https://i.mooc.chaoxing.com/space/index?t=1700000000000';

  // 后台那一本账：把 var 声明 + 三个顶层函数原样搬进一个闭包里跑，Date 由测试控制
  var fakeNow = 1700000000000;
  var harness = null;
  (function () {
    var varsAt = bg.indexOf('var STUDY_URL_RE');
    var varsEnd = bg.indexOf('Object.create(null);', varsAt);
    var varsBlock = (varsAt >= 0 && varsEnd > varsAt)
      ? bg.slice(varsAt, varsEnd + 'Object.create(null);'.length) : '';
    var fPrune = topFnText(bg, 'pruneTabStudyMemory');
    var fPruneCore = topFnText(bg, 'pruneStudyMemory');
    var fNote = topFnText(bg, 'noteTabStudyUrl');
    var fVerdict = topFnText(bg, 'studyRescueVerdict');
    if (!varsBlock || !fPrune || !fPruneCore || !fNote || !fVerdict) return;
    try {
      // 批次 134：`noteTabStudyUrl` 现在写完内存还要落一次盘，这里给一个空壳 ——
      // 落盘那条链在下面的 membox 里用**真函数**跑（㉖㉗㉘），别在这里假装有覆盖。
      harness = new Function('Date', 'return (function () {\n' + varsBlock +
        '\nfunction persistTabStudyMemory() {}\n' + fPruneCore + '\n' + fPrune + '\n' + fNote + '\n' + fVerdict +
        '\nreturn { note: noteTabStudyUrl, verdict: studyRescueVerdict,' +
        ' mem: function () { return tabStudyMemory; },' +
        ' reset: function () { tabStudyMemory = Object.create(null); } };\n})()')(
        { now: function () { return fakeNow; } });
    } catch (eBuild) { harness = null; }
  })();

  // ── 批次 134：整条持久化链都用**盘上真函数**跑，一次 build = 一整个 SW 生命周期 ──────
  // 为什么非要自己造一个盒子：#176 的根因就是「账只活在内存里，而 MV3 的 SW 会被回收」。
  // 用假对象替掉 `persistTabStudyMemory` 就只能证明"它被调用了"，证明不了"下一轮醒来还在" ——
  // 而只有后者才是那个死循环的解药。`sessions` 在两次 build 之间共享，正相当于
  // `chrome.storage.session`：跨 SW 休眠活着、跨浏览器重启死掉。
  var memFns = ['pruneStudyMemory', 'mergeStudyMemory', 'studyMemoryThen', 'hydrateStudyMemoryNow',
    'hydrateStudyMemory', 'persistStudyMemoryNow', 'persistTabStudyMemory', 'readTabStudyMemory',
    'studyMemoryOutcome', 'queueTabStudyNote'];
  var memText = memFns.map(function (n) { return topFnText(bg, n); });
  var keyM = bg.match(/var STUDY_MEMORY_KEY = '([^']+)'/);
  var MEM_KEY = keyM ? keyM[1] : null;
  var memBroken = !MEM_KEY || memText.some(function (t) { return !t; });
  var memLog = { sets: [], areas: [] };
  /** @param over.storageGet 可以换成一条会挂的读，用来量「问不到存储」那一格 */
  var buildMemBox = function (sessions, over) {
    var o = over || {};
    var varsAt = bg.indexOf('var STUDY_URL_RE');
    var varsEnd = bg.indexOf('Object.create(null);', varsAt);
    var varsBlock = (varsAt >= 0 && varsEnd > varsAt) ? bg.slice(varsAt, varsEnd + 'Object.create(null);'.length) : '';
    var prelude = varsBlock + '\nvar STUDY_MEMORY_KEY = ' + JSON.stringify(MEM_KEY) +
      ';\nvar studyMemoryLoaded = false;\nvar studyMemoryQueue = Promise.resolve();\n' + memText.join('\n') +
      '\nfunction pruneTabStudyMemory() { tabStudyMemory = pruneStudyMemory(tabStudyMemory, STUDY_MEMORY_MAX); }\n' +
      topFnText(bg, 'noteTabStudyUrl') + '\n' + topFnText(bg, 'studyRescueVerdict') +
      '\nreturn { note: noteTabStudyUrl, queue: queueTabStudyNote, merge: mergeStudyMemory,' +
      ' read: readTabStudyMemory, verdict: studyRescueVerdict, outcome: studyMemoryOutcome,' +
      ' mem: function () { return tabStudyMemory; }, loaded: function () { return studyMemoryLoaded; } };';
    return new Function('Date', 'storageGet', 'storageSet', 'return (function () {\n' + prelude + '\n})()')(
      { now: function () { return fakeNow; } },
      o.storageGet || function (area, key) {
        memLog.areas.push(area);
        var out = {};
        out[key] = sessions[area] && sessions[area][key];
        return Promise.resolve(out);
      },
      o.storageSet || function (area, patch) {
        memLog.areas.push(area);
        memLog.sets.push({ area: area, keys: Object.keys(patch), snap: JSON.parse(JSON.stringify(patch)) });
        if (!sessions[area]) sessions[area] = {};
        Object.keys(patch).forEach(function (k) { sessions[area][k] = patch[k]; });
        return Promise.resolve();
      });
  };
  var settle = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  // 三个地板住在 00 那片（同一个 IIFE 作用域），被单独取出来跑时看不见，只能按名字注进去；
  // 生产里改了名而测试还注旧名，ReferenceError 会当场响，不会静默当成没回归。
  var floors = {
    DISPLACED_ASK_PENDING_MS: PENDING,
    DISPLACED_ASK_FRESH_MS: FRESH,
    DISPLACED_SILENCE_MS: SILENCE
  };
  var plan = buildFrom(loop, '_displacedStudyPagePlan', floors);
  var logs = [];
  var speak = buildFrom(loop, '_speakDisplacedStudyPage', {
    emitRuntimeLog: function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); },
    location: { href: PORTAL_URL },
    DISPLACED_SILENCE_MS: SILENCE
  });
  var sends = [];
  var askMs = [];
  var askAnswer = null;
  // `Date` 也注进去：缓存上的时刻必须由测试控制，否则这一族断言会跟着真实时钟漂
  // （地板是 20 秒/60 秒，而一次全量跑里两条断言之间就可能跨过它 —— 那叫不稳定，不叫覆盖）。
  var askNow = 0;
  var ask = buildFrom(loop, '_askStudyTabState', Object.assign({
    bridgeSend: function (type, payload) {
      sends.push({ type: type, payload: payload });
      return Promise.resolve(askAnswer);
    },
    Date: { now: function () { return askNow; } }
  }, floors));

  check('①′ 四件套都能从盘上取出来真跑，三个地板也读得回来（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）；批次 134 起持久化那一族七个函数与那个存储键也各要各取出来，缺一个 ㉖㉗㉘ 就是空转',
    !!harness && typeof plan === 'function' && typeof speak === 'function' && typeof ask === 'function' &&
    PENDING > 0 && FRESH > PENDING && SILENCE > FRESH && memBroken === false,
    'harness=' + !!harness + ' plan=' + typeof plan + ' speak=' + typeof speak + ' ask=' + typeof ask +
      ' floors=' + JSON.stringify([PENDING, FRESH, SILENCE]) + ' memBroken=' + memBroken + ' memKey=' + MEM_KEY);
  if (!harness || typeof plan !== 'function' || typeof speak !== 'function' || typeof ask !== 'function') return;
  if (!(PENDING > 0 && FRESH > PENDING && SILENCE > FRESH)) return;
  var verdict = harness.verdict;
  var flushMicro = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  var askBodyTxt = bodyOf(loop, '_askStudyTabState');
  var planBodyTxt = bodyOf(loop, '_displacedStudyPagePlan');
  var speakBodyTxt = bodyOf(loop, '_speakDisplacedStudyPage');
  check('② 三个地板与后台那两个数都从源码读回来（不是抄进测试的常量），而且那三件套真的引用常量、没在原地再抄一遍数字 —— 日志里承诺的等待和判据真的等待必须是同一个数',
    PENDING > 0 && FRESH > PENDING && SILENCE > FRESH && AWAY > SILENCE && CAP >= 1 && MEM_MAX >= 8 &&
    askBodyTxt.indexOf('DISPLACED_ASK_PENDING_MS') >= 0 && askBodyTxt.indexOf('DISPLACED_ASK_FRESH_MS') >= 0 &&
    planBodyTxt.indexOf('DISPLACED_ASK_PENDING_MS') >= 0 && planBodyTxt.indexOf('DISPLACED_SILENCE_MS') >= 0 &&
    speakBodyTxt.indexOf('DISPLACED_SILENCE_MS') >= 0 &&
    !/[<>=] (20000|60000|300000)\b/.test(askBodyTxt + planBodyTxt + speakBodyTxt),
    JSON.stringify({ pending: PENDING, fresh: FRESH, silence: SILENCE, away: AWAY, cap: CAP, memMax: MEM_MAX }));

  check('③ 那条 URL 判据从源码读回来，且现场两个地址一个算学习页、一个不算（被顶回去落在用户中心门户，它不许被当成「还在刷课」）',
    SRE instanceof RegExp && SRE.test(STUDY_URL) === true && SRE.test(PORTAL_URL) === false,
    'pattern=' + (SRE && SRE.source));

  var N = 1700000000000;
  var mkMem = function (over) {
    return Object.assign({ studyHref: STUDY_URL, studyAt: N - 60000, awayAt: N - 30000, rescues: 0 }, over || {});
  };
  var rowsV = [
    { n: '台账里压根没有这一枚', mem: null, others: 0, reason: 'never-study', may: false, was: false, href: '' },
    { n: '账上 studyAt 是 0', mem: { studyHref: STUDY_URL, studyAt: 0, awayAt: 0, rescues: 0 }, others: 0, reason: 'never-study', may: false, was: false, href: '' },
    { n: '刚才在刷、现在被顶走', mem: mkMem(), others: 0, reason: 'go-back', may: true, was: true, href: STUDY_URL },
    { n: '另一枚学习页还活着', mem: mkMem(), others: 1, reason: 'another-study-tab', may: false, was: true, href: STUDY_URL },
    { n: '自己回去过 CAP 次', mem: mkMem({ rescues: CAP }), others: 0, reason: 'rescue-cap', may: false, was: true, href: STUDY_URL },
    { n: '上一次刷课早已超窗', mem: mkMem({ studyAt: N - AWAY - 5000, awayAt: 0 }), others: 0, reason: 'study-too-long-ago', may: false, was: false, href: '' },
    { n: '数不出有几枚（NaN）', mem: mkMem(), others: NaN, reason: 'others-unknown', may: false, was: true, href: STUDY_URL },
    { n: '数不出有几枚（负数）', mem: mkMem(), others: -3, reason: 'others-unknown', may: false, was: true, href: STUDY_URL }
  ];
  var badV = rowsV.filter(function (r) {
    var o = verdict(r.mem, r.others, N);
    return o.reason !== r.reason || o.mayRescue !== r.may || o.wasStudy !== r.was || o.studyHref !== r.href;
  }).map(function (r) {
    var o = verdict(r.mem, r.others, N);
    return r.n + '[' + o.reason + '/may=' + o.mayRescue + '/was=' + o.wasStudy + ']';
  });
  check('④ 四态真值表逐格对得上（外加一格：数不清账号里有几枚时**不许导航** —— 把这一枚送回去就是同时开两枚，站点会顶掉另一门）',
    badV.length === 0, '对不上的格=' + JSON.stringify(badV));

  var vAnother = verdict(mkMem(), 1, N);
  check('⑤ 另一枚学习页还活着时 wasStudy 仍为真（这一枚确实是学习页，只是不能抢），但 mayRescue 必须假、一次都不许导航（AGENTS §2 #15）',
    vAnother.wasStudy === true && vAnother.mayRescue === false && vAnother.reason === 'another-study-tab' &&
    vAnother.otherStudyTabs === 1, JSON.stringify(vAnother));

  var vLate = verdict(mkMem({ studyAt: N - AWAY - 120000, awayAt: 0 }), 0, N);
  check('⑥ 上一次刷课早已超出时间窗：不回去，但**不许**说成「这页从没刷过课」—— 年龄要带得回来、理由要和学习页缺失那一格分开',
    vLate.reason === 'study-too-long-ago' && vLate.reason !== 'never-study' &&
    vLate.studyAgeMs > AWAY && vLate.studyAgeMs !== -1 && vLate.mayRescue === false,
    JSON.stringify({ reason: vLate.reason, age: vLate.studyAgeMs, away: AWAY }));

  // ── 台账记账（noteTabStudyUrl 真写、真读回来比）───────────────────────────
  // ⚠️ 必须**冻结快照**再比对：账上存的是活对象，后面每一次 note 都会改它（超窗那一支
  //    就是把同一枚对象的 awayAt 又写了一次）。直接拿引用比，读到的永远是最后那个值。
  var snap = function (id) {
    var o = harness.mem()[id];
    return o ? Object.assign({}, o) : null;
  };
  harness.reset();
  fakeNow = N;
  harness.note(11, STUDY_URL);
  var e11 = snap(11);
  check('⑦ 学习页导航把地址与时刻记下来（时刻走的是注入的 Date，不是测试自己造的第二把尺）',
    !!e11 && e11.studyHref === STUDY_URL && e11.studyAt === N && e11.awayAt === 0 && e11.rescues === 0,
    JSON.stringify(e11));

  harness.note(11, PORTAL_URL);
  var away1 = snap(11).awayAt;
  harness.note(11, 'https://www.chaoxing.com/other');
  var away2 = snap(11).awayAt;
  check('⑧ 被顶走的时刻在第一次非学习页导航上落账（这是「离开多久」的基准，没它就没法说「刚被顶走」还是「停了一整天」）',
    away1 === N && away2 > 0 && snap(11).studyHref === STUDY_URL,
    JSON.stringify({ away1: away1, away2: away2, fakeNow: fakeNow }));
  check('⑨ 第二次导航不移动 awayAt（否则「离开多久」会被自己的心跳抹掉，永远数不到阈值），studyHref 也不许被非学习页地址覆盖（那就是回去的靶子）',
    away2 === away1 && snap(11).studyHref === STUDY_URL,
    JSON.stringify({ away1: away1, away2: away2 }));

  // 窗内走回来 = 自愈一次；超窗走回来 = 用户自己重开，不算自愈
  fakeNow = N + 60000;
  harness.note(11, STUDY_URL + '&back=1');
  var backIn = snap(11);
  var lateAt = N + AWAY + 10 * 60000;
  fakeNow = lateAt - 1000;
  harness.note(11, PORTAL_URL);
  var beforeLateBack = snap(11);
  fakeNow = lateAt;
  harness.note(11, STUDY_URL + '&back=2');
  var backLate = snap(11);
  check('⑩ 窗内自己走回来记一次自愈并把 awayAt 归零；超窗之后走回来**不涨**自愈次数（那是人手动重开的，账不许算到插件头上 —— 否则两三次后就直接放弃换课）',
    backIn.rescues === 1 && backIn.awayAt === 0 && backIn.studyAt === N + 60000 &&
    beforeLateBack.rescues === 1 && beforeLateBack.awayAt > backIn.awayAt &&
    backLate.rescues === 1 && backLate.awayAt === 0 && backLate.studyAt === lateAt,
    JSON.stringify({ inWin: backIn, displacedAgain: beforeLateBack, outWin: backLate }));

  var keysBefore = Object.keys(harness.mem()).length;
  harness.note('12', STUDY_URL);
  harness.note(12.5, STUDY_URL);
  harness.note(13, null);
  harness.note(14, 42);
  var dirtyKept = Object.keys(harness.mem()).length - keysBefore;
  harness.reset();
  for (var mi = 0; mi < MEM_MAX + 5; mi++) {
    fakeNow = N + mi * 1000;
    harness.note(100 + mi, STUDY_URL);
  }
  var idsLeft = Object.keys(harness.mem()).length;
  check('⑪ 台账卫生：tabId 不是整数、地址不是字符串都不落账（脏参数会把别人那一枚的账写歪）；台账封个底，超限时按 studyAt 丢最旧的而不是无限涨（开过很多标签页的会话不能吃光 SW 内存）',
    dirtyKept === 0 && !harness.mem()[12] && !harness.mem()[13] && !harness.mem()[14] &&
    idsLeft === MEM_MAX && harness.mem()[100] === undefined && harness.mem()[104] === undefined &&
    harness.mem()[100 + MEM_MAX + 4] !== undefined,
    JSON.stringify({ dirtyKept: dirtyKept, idsLeft: idsLeft, max: MEM_MAX }));

  harness.reset();
  fakeNow = N;
  harness.note(21, STUDY_URL);
  fakeNow = N + 8000;
  harness.note(21, PORTAL_URL);
  var chained = verdict(snap(21), 0, N + 20000);
  check('⑫ 记的那本账喂得进判定：noteTabStudyUrl 写的字段名与 studyRescueVerdict 读的字段名对得上（拼错一个字段这一格立刻红），离开时长从账上读回来',
    chained.reason === 'go-back' && chained.mayRescue === true && chained.studyHref === STUDY_URL &&
    chained.awayMs === 12000 && chained.rescues === 0, JSON.stringify(chained));

  // ── 页面侧四态（cache 形状就是 _askStudyTabState 写的那一份）──────────────
  var cacheOf = function (over) {
    return Object.assign({
      pendingAt: 0, at: N, answered: true, ok: true, reason: '', studyHref: '',
      studyAgeMs: 0, awayMs: 0, otherStudyTabs: 0, rescues: 0, mayRescue: false
    }, over || {});
  };
  var rowsAsk = [
    { n: '压根还没问', cache: null, want: 'asking' },
    { n: '问了、答案还没回来（地板内）', cache: cacheOf({ answered: false, ok: false, pendingAt: N - 1000 }), want: 'asking' },
    { n: '问了但始终没答案（地板外）', cache: cacheOf({ answered: false, ok: false, pendingAt: N - PENDING - 1 }), want: 'unknown' },
    { n: '问到过、可那条答案没用', cache: cacheOf({ answered: true, ok: false, reason: 'unreadable' }), want: 'unknown' }
  ];
  var badAsk = rowsAsk.filter(function (r) { return plan(r.cache, N, '', 0) !== r.want; })
    .map(function (r) { return r.n + '[' + plan(r.cache, N, '', 0) + ']'; });
  check('⑬ 「还没问 / 还在问 / 问了没答案 / 问到过但答案没用」四格分开：只有**还没拿到答案**才允许不说话，拿到过没用的那条必须立刻落进读不出（否则后台一直答非所问时这一族永久哑掉）',
    badAsk.length === 0, '落错的格=' + JSON.stringify(badAsk));

  var rowsAct = [
    { n: '能自己回去', cache: cacheOf({ mayRescue: true, reason: 'go-back', studyHref: STUDY_URL }), want: 'go-back' },
    { n: '另一枚占着账号', cache: cacheOf({ reason: 'another-study-tab', otherStudyTabs: 2 }), want: 'another-page' },
    { n: '回去过两次还被顶', cache: cacheOf({ reason: 'rescue-cap', rescues: CAP }), want: 'gave-up' },
    { n: '这页从没当过学习页', cache: cacheOf({ reason: 'never-study' }), want: 'not-ours' },
    { n: '上一次刷课早已超窗', cache: cacheOf({ reason: 'study-too-long-ago', studyAgeMs: AWAY + 60000 }), want: 'not-ours' },
    { n: '数不出有几枚', cache: cacheOf({ reason: 'others-unknown', otherStudyTabs: -1 }), want: 'unknown' },
    { n: '后台给了个没见过的说法', cache: cacheOf({ reason: '突然想起来了' }), want: 'unknown' }
  ];
  var badAct = rowsAct.filter(function (r) { return plan(r.cache, N, '__没说过过的另一种说法__', 0) !== r.want; })
    .map(function (r) { return r.n + '[' + plan(r.cache, N, '__没说过过的另一种说法__', 0) + ']'; });
  check('⑭ 后台那一格理由到界面那一句话的映射逐格对得上（七格都走一遍：五种 reason + 数不出 + 没见过的说法），不许有任何一格被压成「认不出课程结构」',
    badAct.length === 0, '落错的格=' + JSON.stringify(badAct));

  var notOursCache = cacheOf({ reason: 'never-study' });
  check('⑮ 不是插件带来的那一页每份页面只说一次：第一次要说（否则用户不知道我们看见了他开的页），说过之后隔一天也不重播',
    plan(notOursCache, N, '', 0) === 'not-ours' &&
    plan(notOursCache, N + 1000, 'not-ours', N) === 'silent' &&
    plan(notOursCache, N + 24 * 3600 * 1000, 'not-ours', N) === 'silent',
    JSON.stringify([plan(notOursCache, N, '', 0), plan(notOursCache, N + 1000, 'not-ours', N)]));

  var goCache = cacheOf({ mayRescue: true, reason: 'go-back', studyHref: STUDY_URL, studyAgeMs: 60000, awayMs: 120000 });
  var unknownCache = cacheOf({ reason: 'others-unknown', otherStudyTabs: -1 });
  check('⑯ 其余三格有地板但**不许永久静默**：同一格在地板内不重播、过了地板照旧再说；而「读不出」那一格永不静默（它是唯一会把活儿交回老口径的信号）',
    plan(goCache, N, '', 0) === 'go-back' &&
    plan(goCache, N + SILENCE - 1000, 'go-back', N) === 'silent' &&
    plan(goCache, N + SILENCE + 1000, 'go-back', N) === 'go-back' &&
    plan(unknownCache, N, 'unknown', N) === 'unknown' &&
    plan(unknownCache, N + 1000, 'unknown', N) === 'unknown',
    JSON.stringify([plan(goCache, N + SILENCE - 1000, 'go-back', N), plan(unknownCache, N + 1000, 'unknown', N)]));

  var mkCtx = function () {
    var st = {
      navs: [],
      ctx: {
        _studyTabStateCache: null,
        _displacedSpokeAct: '',
        _displacedSpokeAt: 0,
        _askStudyTabState: function () {},
        _displacedStudyPagePlan: plan,
        _gotoUrl: function (u) { st.navs.push(u); }
      }
    };
    return st;
  };
  var runSpeak = function (st, cache, now) {
    logs.length = 0;
    st.navs.length = 0;
    st.ctx._studyTabStateCache = cache;
    var threw = null, ret;
    try { ret = speak.call(st.ctx, now); } catch (e) { threw = e; }
    return { ret: ret, navs: st.navs.slice(), logs: logs.slice(), threw: threw, ctx: st.ctx };
  };

  var stGo = mkCtx();
  var rGo = runSpeak(stGo, goCache, N);
  var goMeta = rGo.logs[0] && rGo.logs[0].meta;
  var stBad = mkCtx();
  stBad.ctx._gotoUrl = function () { throw new Error('导航这一下炸了'); };
  var rBad = runSpeak(stBad, goCache, N);
  check('⑰ 「能自己回去」那一格真的在**同一枚标签页内**导航（靶地址就是台账里那一条，不是新开一枚），日志带得上读得回来的靶地址与离开时长；导航炸了也不许冒泡到主循环',
    rGo.ret === true && rGo.navs.length === 1 && rGo.navs[0] === STUDY_URL &&
    rGo.logs.length === 1 && rGo.logs[0].level === 'warn' && /study displaced, going back/.test(rGo.logs[0].message) &&
    !!goMeta && goMeta.target === STUDY_URL && goMeta.reason === 'go-back' &&
    goMeta.href === PORTAL_URL && goMeta.everyMs === SILENCE &&
    goMeta.studyAgeMs === goCache.studyAgeMs && goMeta.awayMs === goCache.awayMs &&
    stGo.ctx._displacedSpokeAct === 'go-back' && stGo.ctx._displacedSpokeAt === N &&
    rBad.threw === null && rBad.ret === true && rBad.logs.length === 1,
    JSON.stringify({ ret: rGo.ret, navs: rGo.navs, meta: goMeta, badThrew: String(rBad.threw), badRet: rBad.ret }));

  var rHold = runSpeak(mkCtx(), cacheOf({ reason: 'another-study-tab', otherStudyTabs: 2, awayMs: 5000 }), N);
  var rUnread = runSpeak(mkCtx(), cacheOf({ answered: true, ok: false, reason: 'unreadable', why: '后台没给答案' }), N);
  var rAsking = runSpeak(mkCtx(), null, N);
  var rPend = runSpeak(mkCtx(), cacheOf({ answered: false, ok: false, pendingAt: N - 1000 }), N);
  check('⑱ 三种「不许动」的形状：另一枚占着时一次都不导航（送回去就是把那一门顶下线）、问到过但没用时返回 false 把话交回老口径（既不导航也不闭嘴）、' +
    '还在问时同样返回 false —— 这一族**没有任何一格可以认领了却一个字都不说**（全量 e2e 的 20-I 与 89-C 就是被"还在问不说话"顶红的）',
    rHold.ret === true && rHold.navs.length === 0 && rHold.logs.length === 1 &&
    /study displaced, held back/.test(rHold.logs[0].message) &&
    rHold.logs[0].meta.otherStudyTabs === 2 && rHold.logs[0].meta.willRetryInMs === SILENCE &&
    rUnread.ret === false && rUnread.navs.length === 0 && rUnread.logs.length === 0 &&
    rAsking.ret === false && rAsking.navs.length === 0 && rAsking.logs.length === 0 &&
    rPend.ret === false && rPend.logs.length === 0,
    JSON.stringify({ hold: { ret: rHold.ret, navs: rHold.navs.length, logs: rHold.logs.length }, unread: { ret: rUnread.ret, logs: rUnread.logs.length }, asking: { ret: rAsking.ret, logs: rAsking.logs.length }, pend: { ret: rPend.ret, logs: rPend.logs.length } }));

  var rCap = runSpeak(mkCtx(), cacheOf({ reason: 'rescue-cap', rescues: CAP }), N);
  var rNever = runSpeak(mkCtx(), cacheOf({ reason: 'never-study' }), N);
  var rLong = runSpeak(mkCtx(), cacheOf({ reason: 'study-too-long-ago', studyAgeMs: AWAY + 120000 }), N);
  var capHintRe = new RegExp('回过 ' + CAP + ' 次');
  var longMinRe = new RegExp(Math.round((AWAY + 120000) / 60000) + ' 分钟前');
  check('⑲ 该交给人的那一格点亮 warn 并把「回过几次」从账上带回来（不在日志里另抄一个上限数，那个数归后台管）；「不是插件带来的页」只说一次、落 info，且「从没刷过」与「上一次是几分钟前」两种说法要分开',
    rCap.ret === true && rCap.navs.length === 0 && rCap.logs[0].level === 'warn' &&
    /study displaced, gave up/.test(rCap.logs[0].message) &&
    rCap.logs[0].meta.rescues === CAP && rCap.logs[0].meta.cap === undefined &&
    capHintRe.test(rCap.logs[0].meta.hint) &&
    rNever.logs[0].level === 'info' && /study idle: not our page/.test(rNever.logs[0].message) &&
    rNever.logs[0].meta.everyMs === 0 && /从没当过学习页/.test(rNever.logs[0].meta.hint) &&
    longMinRe.test(rLong.logs[0].meta.hint) && !/从没当过学习页/.test(rLong.logs[0].meta.hint),
    JSON.stringify({ cap: rCap.logs[0] && rCap.logs[0].meta, never: rNever.logs[0] && rNever.logs[0].meta, long: rLong.logs[0] && rLong.logs[0].meta }));

  // 抑制落到 speak 这一层：同一个 ctx 连说两次，第二次不许再发一条
  var stOnce = mkCtx();
  var first = runSpeak(stOnce, notOursCache, N);
  var second = runSpeak(stOnce, notOursCache, N + 5000);
  var third = runSpeak(stOnce, goCache, N + 10000);
  check('⑳ 抑制真的记账：同一格第二次一句话都不说，但**换了格就立刻再说**（换态时哑掉等于把新真相藏起来 —— 哪怕只过了 5 秒）',
    first.logs.length === 1 && second.logs.length === 0 && second.ret === true &&
    third.logs.length === 1 && /going back/.test(third.logs[0].message) && third.navs.length === 1,
    JSON.stringify({ first: first.logs.length, second: second.logs.length, third: third.logs.length }));

  // 问后台那一件：两把地板 + 超时数 + 读不出那一格的字段形状
  // ⚠️ 全程走虚拟时钟（`Date` 已注进 ask）：真实时钟下两条断言之间一旦跨过地板，
  //    这一族就变成看运气跑，全量／定向各红一次。
  var T0 = 1700000000000;
  sends.length = 0;
  askMs.length = 0;
  askAnswer = null;
  askNow = T0;
  var stAsk = { _withTimeout: function (p, ms) { askMs.push(ms); return p; } };
  ask.call(stAsk, T0);
  var sentFirst = sends.length;
  askNow = T0 + 1000;
  ask.call(stAsk, T0 + 1000);
  var sentPending = sends.length;
  await flushMicro();
  var failedCache = Object.assign({}, stAsk._studyTabStateCache);
  ask.call(stAsk, T0 + 1000);
  var sentAfterFailed = sends.length;
  askAnswer = {
    success: true, reason: 'go-back', mayRescue: true, studyHref: STUDY_URL,
    studyAgeMs: 60000, awayMs: 12000, otherStudyTabs: 0, rescues: 0
  };
  askNow = T0 + FRESH + 5000;
  ask.call(stAsk, T0 + FRESH + 5000);
  await flushMicro();
  var okCache = Object.assign({}, stAsk._studyTabStateCache);
  askNow = T0 + FRESH + 6000;
  ask.call(stAsk, T0 + FRESH + 6000);
  var sentAfterOk = sends.length;
  askNow = T0 + 2 * FRESH + 60000;
  ask.call(stAsk, T0 + 2 * FRESH + 60000);
  var sentStale = sends.length;
  var pMs = askBodyTxt.match(/_withTimeout\(bridgeSend\('study_tab_state'\), (\d+)\)/);
  check('㉑ 问后台有两把地板且都不许被绕过：还没答案时地板内不重敲、答案落地后（有用没用都算）另一把地板内不重敲 —— 停在门户页时每一拍（2 秒）都走到这里，没地板就是自己造一个轮询；超时数从源码读回来且远小于桥的 90 秒',
    sentFirst === 1 && sentPending === 1 && sentAfterFailed === 1 && sentAfterOk === 2 && sentStale === 3 &&
    !!pMs && Number(pMs[1]) > 0 && Number(pMs[1]) < 90000 && askMs.length === 3 && askMs[0] === Number(pMs[1]),
    JSON.stringify({ sends: [sentFirst, sentPending, sentAfterFailed, sentAfterOk, sentStale], ms: pMs && pMs[1], wrapped: askMs }));

  check('㉒ 答案的形状被原样收进缓存，读不出那一格单独占位：ok 假、reason 写死成 unreadable、枚数拿不到就是 -1（不许当成「零枚」，也不许当成「有很多枚」），mayRescue 一律假',
    !!failedCache && failedCache.answered === true && failedCache.ok === false &&
    failedCache.reason === 'unreadable' && failedCache.otherStudyTabs === -1 && failedCache.mayRescue === false &&
    !!okCache && okCache.ok === true && okCache.reason === 'go-back' && okCache.mayRescue === true &&
    okCache.studyHref === STUDY_URL && okCache.otherStudyTabs === 0 &&
    plan(okCache, T0 + FRESH + 7000, '', 0) === 'go-back' &&
    plan(failedCache, T0 + 100000, '', 0) === 'unknown',
    JSON.stringify({ failed: failedCache, ok: okCache }));

  var declineBody = bodyOf(runTxt, '_tryAdvanceIdleSection');
  var iAsk = declineBody.indexOf('this._speakDisplacedStudyPage(');
  var iLegacy = declineBody.indexOf("'study idle declined");
  check('㉓ 接线：这一族先问四态，「还在问」与「问不出」两格都退回老那句「认不出课程结构」（老话不许被删 —— 它是这两格唯一的出口，⑱ 钉的是这两格都返回 false），而且调用点不带 await、函数本身也不是 async（它的布尔值就是这一拍的仲裁，改成 Promise 就恒真）',
    iAsk >= 0 && iLegacy > iAsk && declineBody.indexOf('await this._speakDisplacedStudyPage') < 0 &&
    declineBody.indexOf("'study idle declined") >= 0 &&
    runTxt.indexOf('_tryAdvanceIdleSection: async function') < 0 &&
    loop.indexOf('_speakDisplacedStudyPage: async function') < 0 &&
    typeof runSpeak(mkCtx(), null, N).ret === 'boolean',
    JSON.stringify({ askAt: iAsk, legacyAt: iLegacy }));

  var dAt = cTxt.indexOf("/study displaced/.test(msg)");
  var nAt = cTxt.indexOf("/study idle: not our page/.test(msg)");
  var cAt = cTxt.indexOf("/study idle declined/.test(msg)");
  var band = cTxt.slice(dAt, nAt);
  check('㉔ 面板分类器把「被顶下线」排在「认不出课程结构」之前（顺序错了四态全被老那一格抢先，界面照样只有一句话），三格各自落等待/等待/注意，而「不是插件带来的那一页」落进正常档、不点亮注意',
    dAt >= 0 && nAt > dAt && cAt > dAt &&
    /going back[\s\S]{0,120}state = 'wait'/.test(band) &&
    /held back[\s\S]{0,120}state = 'wait'/.test(band) &&
    /state = 'warn'/.test(band) &&
    /state = 'normal';/.test(cTxt.slice(nAt, cAt)),
    JSON.stringify({ displaced: dAt, notOurs: nAt, declined: cAt }));

  var msC = cTxt.match(/sendRuntimeMessageWithTimeout\(\{ type: 'study_tab_state' \}, (\d+)/);
  var routeAt = bg.indexOf("message.type === 'study_tab_state'");
  var routeBand = routeAt >= 0 ? bg.slice(routeAt, routeAt + 1400) : '';
  check('㉕ 桥接三端都有这一条（页面问、content 转、后台答）且两头各自带超时；后台那一支是只读的：带 payload 就拒、只数别人不算自己、非学习页地址一条都不回',
    loop.indexOf("bridgeSend('study_tab_state'") >= 0 && cTxt.indexOf("msg.type === 'study_tab_state'") >= 0 &&
    routeAt >= 0 && !!msC && Number(msC[1]) > 0 && Number(msC[1]) < 90000 &&
    routeBand.indexOf('invalid_payload') >= 0 && routeBand.indexOf('t.id !== selfTab.id') >= 0 &&
    routeBand.indexOf('STUDY_URL_RE.test(') >= 0,
    JSON.stringify({ contentMs: msC && msC[1], pageMs: pMs && pMs[1], routeAt: routeAt }));

  // ── 批次 134（会话任务 #176）：这本账要扛得住 SW 被回收 ─────────────────────────
  // 现场那份 200 条日志里被推到用户中心的那一枚停了 105 分钟（`emptyForMs` 6,166,238 → 6,310,000），
  // 而 MV3 的 service worker 闲几十秒就回收 —— 旧实现把账只写在内存，于是每一轮醒来都是「全新账号」：
  //   ① `never-study` → 页面判成「这页不是插件带来的」，每份页面只说一次 → 再也没人送它回去；
  //   ② `rescues` 归零 → 「回去→被顶→再回去」的上限**永远数不满** → 死循环。
  // 这两条都在下面真跑：`buildMemBox` 换一次盒子 = SW 被回收又起来一次，`sessions` 跨盒子共享。
  var loopSess = {};
  fakeNow = N;
  var boxA = buildMemBox(loopSess);
  boxA.queue(41, STUDY_URL);
  await settle();
  var setsAfterFirstNote = memLog.sets.length;
  var areasUsed = memLog.areas.slice();
  fakeNow = N + 8000;
  var boxB = buildMemBox(loopSess);                       // SW 睡了又醒：内存账是空的
  var memEmptyBefore = Object.keys(boxB.mem()).length;   // ⚠️ 必须在记这一笔之前取，否则合并完就量不到「本来就空」
  boxB.queue(41, PORTAL_URL);                             // 被站点顶到用户中心
  await settle();
  var woke = await boxB.read(41);
  var wokeVerdict = boxB.outcome(boxB.verdict(woke.memory, 0, N + 20000), woke.known);
  check('㉖ 账落在 chrome.storage.session：SW 被回收又醒来时，那一枚"刚才在刷课"的账还在（内存空着也能从存储补回来），回去的靶地址与被顶走的时刻都读得回来 —— 不再一醒来就说「这页不是插件带来的」。⚠️ 走的是事件那条 queue 而不是裸 note：不先补账，"被顶走"那一发读不到旧账、压根不落 awayAt',
    setsAfterFirstNote >= 1 && memLog.sets[0].keys.indexOf(MEM_KEY) >= 0 &&
    areasUsed.every(function (a) { return a === 'session'; }) &&
    memEmptyBefore === 0 && woke.known === true && !!woke.memory &&
    woke.memory.studyHref === STUDY_URL && woke.memory.awayAt === N + 8000 &&
    wokeVerdict.reason === 'go-back' && wokeVerdict.mayRescue === true && wokeVerdict.wasStudy === true &&
    wokeVerdict.awayMs === 12000,
    JSON.stringify({ sets: setsAfterFirstNote, areas: areasUsed, emptyBefore: memEmptyBefore, known: woke.known, mem: woke.memory, verdict: wokeVerdict }));

  // 上限要跨休眠也还在涨：这是「重载有界」真正承重的那一格
  var sessLoop = {};
  fakeNow = N;
  var boot = buildMemBox(sessLoop);
  boot.queue(51, STUDY_URL);
  await settle();
  var seq = [];
  var navTotal = 0;
  var tLoop = N;
  for (var ci = 0; ci < 3; ci += 1) {
    tLoop += 30000;
    fakeNow = tLoop;
    var cycBox = buildMemBox(sessLoop);            // 每一次被顶都换一整个 SW 生命周期
    cycBox.queue(51, PORTAL_URL);
    await settle();
    var rd = await cycBox.read(51);
    var vd = cycBox.outcome(cycBox.verdict(rd.memory, 0, tLoop), rd.known);
    seq.push({ reason: vd.reason, rescues: vd.rescues, may: vd.mayRescue });
    var stLoop = runSpeak(mkCtx(), cacheOf({
      reason: vd.reason, mayRescue: vd.mayRescue, studyHref: vd.studyHref,
      studyAgeMs: vd.studyAgeMs, awayMs: vd.awayMs, otherStudyTabs: vd.otherStudyTabs, rescues: vd.rescues
    }), tLoop);
    navTotal += stLoop.navs.length;
    if (vd.mayRescue === true) {
      tLoop += 20000;                              // 回去路上花的十几秒
      fakeNow = tLoop;
      cycBox.queue(51, vd.studyHref);              // 同一枚标签页内导航回来
      await settle();
    }
  }
  check('㉗ 「回去→被顶→再回去」的上限跨 SW 休眠也算数：三次被顶的格子是 go-back / go-back / rescue-cap（第三格才交给人的），整场最多只导航 CAP 次 —— 旧实现每一轮醒来都从 0 数起，那就是那个死循环',
    seq.length === 3 && seq[0].reason === 'go-back' && seq[0].rescues === 0 &&
    seq[1].reason === 'go-back' && seq[1].rescues === 1 &&
    seq[2].reason === 'rescue-cap' && seq[2].may === false && seq[2].rescues === CAP &&
    navTotal === CAP,
    JSON.stringify({ seq: seq, navTotal: navTotal, cap: CAP }));

  var deadGet = function () { return Promise.reject(new Error('存储问不到')); };
  var boxDead = buildMemBox({}, { storageGet: deadGet });
  var deadRead = await boxDead.read(77);
  var deadVerdict = boxDead.outcome(boxDead.verdict(deadRead.memory, 0, N), deadRead.known);
  var deadCache = cacheOf({
    reason: deadVerdict.reason, mayRescue: deadVerdict.mayRescue,
    otherStudyTabs: deadVerdict.otherStudyTabs, studyAgeMs: deadVerdict.studyAgeMs
  });
  var deadPlan = plan(deadCache, N, '__没说过过的另一种说法__', 0);
  var rDead = runSpeak(mkCtx(), deadCache, N);
  var heldVerdict = boxDead.outcome(boxDead.verdict(mkMem(), 0, N), false);
  check('㉘ 存储问不到 = **「读不出」单独占一格**，不许塌进 never-study：后台交回 memory-unreadable，页面落进 unknown（不是 not-ours）、一次都不导航、返回 false 把话交回老那句（⑮ 钉过 not-ours 每份页面只说一次，塌进那一格就是永久闭嘴）；反面：账上已经有证据时"这一发问不到"不许盖掉它',
    deadRead.known === false && deadRead.memory === null &&
    deadVerdict.reason === 'memory-unreadable' && deadVerdict.mayRescue === false &&
    deadPlan === 'unknown' && rDead.ret === false && rDead.navs.length === 0 && rDead.logs.length === 0 &&
    heldVerdict.reason === 'go-back' && heldVerdict.mayRescue === true,
    JSON.stringify({ read: deadRead, verdict: deadVerdict, planAct: deadPlan, spoke: { ret: rDead.ret, navs: rDead.navs.length, logs: rDead.logs.length }, held: heldVerdict }));

  var persistTxt = memText[memFns.indexOf('persistTabStudyMemory')];
  var persistNowTxt = memText[memFns.indexOf('persistStudyMemoryNow')];
  var hydrateNowTxt = memText[memFns.indexOf('hydrateStudyMemoryNow')];
  // 「写之前先补账」这一道闸要**取得到才许算数**：只比 indexOf 的大小，把整句删掉会让
  // -1 < 正数 照样成立（§5「不会失败的检查等于没有检查」）。
  var gateAt = persistTxt.indexOf('hydrateStudyMemoryNow');
  var writeAt = persistTxt.indexOf('persistStudyMemoryNow');
  var setsBeforeBlind = memLog.sets.length;
  var boxBlind = buildMemBox(loopSess, { storageGet: deadGet });   // 账补不上，却又进来一次导航
  boxBlind.queue(41, STUDY_URL + '&back=9');
  await settle();
  var mA = boxA.merge({ 5: { studyHref: STUDY_URL, studyAt: N, awayAt: 0, rescues: CAP } },
    { 5: { studyHref: STUDY_URL, studyAt: N - 1000, awayAt: 0, rescues: 0 } }, 8);
  var mB = boxA.merge({ 5: { studyHref: STUDY_URL, studyAt: N - 1000, awayAt: 0, rescues: CAP } },
    { 5: { studyHref: STUDY_URL, studyAt: N, awayAt: 0, rescues: 0 } }, 8);
  var mDirty = boxA.merge({
    a: null, b: '字符串', c: { studyHref: 42, studyAt: 5 }, d: { studyHref: STUDY_URL, studyAt: 'abc' },
    e: { studyHref: '', studyAt: 5 }, f: { studyHref: STUDY_URL, studyAt: 0 }, g: { studyHref: STUDY_URL, studyAt: 5 }
  }, {}, 8);
  var mMany = {};
  for (var mj = 0; mj < MEM_MAX + 6; mj += 1) mMany['t' + mj] = { studyHref: STUDY_URL, studyAt: N + mj * 1000 };
  var mCap = boxA.merge(mMany, {}, MEM_MAX);
  check('㉙ 落盘的四条卫生：① 补不上账时**这一发干脆不写**（一写就把睡过去之前那本整抹掉，比不持久化更坏）；② 合并按「谁新听谁」而不是「谁后到听谁」（旧账覆盖新账会把 rescues 打回 0，同一族第二号死法）；③ 脏形状一律丢掉（脏 studyHref 会被拼成一条假导航地址）；④ 读与写都只碰 session 不碰 local（把刷课地址写进磁盘档案既过期又涉隐私），且写之前先过补账那一道闸',
    memLog.sets.length === setsBeforeBlind &&
    mA[5].rescues === CAP && mB[5].rescues === 0 &&
    Object.keys(mDirty).length === 1 && !!mDirty.g &&
    Object.keys(mCap).length === MEM_MAX && !!mCap['t' + (MEM_MAX + 5)] && !mCap.t0 &&
    persistNowTxt.indexOf("storageSet('session'") >= 0 && persistNowTxt.indexOf("'local'") < 0 &&
    hydrateNowTxt.indexOf("storageGet('session'") >= 0 && hydrateNowTxt.indexOf("'local'") < 0 &&
    gateAt >= 0 && writeAt > gateAt,
    JSON.stringify({ setsDelta: memLog.sets.length - setsBeforeBlind, mA: mA[5], mB: mB[5], dirty: Object.keys(mDirty), capped: Object.keys(mCap).length, gateAt: gateAt, writeAt: writeAt }));

  // ── 批次 158：每 60 秒那次刷新**不许**把已经答对的那一份抹成空白 ──────────────
  // 现场实测（1.3.1 预览版，用户中心那一枚，2026-11-21，只读）：后台明确答 `never-study`
  // （这页压根不是插件带来的，插件也按这一格只说过一次「不催你回章节页」），可 `tab-cache-probe` 同时读回
  // `plan:"silent"` 与地板那句 `study idle declined` 的年龄 `idleDeclineLogAge:"11s"` ——
  // 两句同时成立只有一种解释：刷新把答案抹成了「还在问」，于是每 120 秒又把「请手动回到章节页」说回去。
  // 这一族不报错、不留异常，只有用户那句"我有一科一直没刷"会留下来（AGENTS §2 #12）。
  var stCarry = { _withTimeout: function (p, ms) { askMs.push(ms); return p; } };
  var baseSends = sends.length;
  askAnswer = { success: true, reason: 'never-study', mayRescue: false, studyHref: '', studyAgeMs: 7200000, awayMs: 0, otherStudyTabs: 1, rescues: 0 };
  askNow = N;
  ask.call(stCarry, N);
  await flushMicro();
  var answeredOnce = Object.assign({}, stCarry._studyTabStateCache);
  // 刷新窗口内（后台这一发还没回话）：借旧答案继续说话，而不是退回「还在问」
  askAnswer = null;
  var refreshAt = N + FRESH + 2000;
  askNow = refreshAt;
  ask.call(stCarry, refreshAt);
  var gapCache = Object.assign({}, stCarry._studyTabStateCache);
  var sentRefresh = sends.length - baseSends;   // 首发 + 刷新那一发 = 2（多一发就是刷新窗口里重复敲）
  // ⚠️ 借答案之后「在问」这一格仍然是真，地板那把尺若还要求 `!answered`，这 8 秒里每一拍（2 秒）
  //    都会再敲一次后台 —— 批次 37/51 那族"自己造轮询"换了个入口进来。
  askNow = refreshAt + 2000;
  ask.call(stCarry, refreshAt + 2000);
  askNow = refreshAt + 4000;
  ask.call(stCarry, refreshAt + 4000);
  var sentInGap = sends.length - baseSends;     // 与上面相等才叫"地板挡住了"；多一发就是每拍重敲
  // 「每份页面只说一次」要**先说过一次**才谈不重播：同一个 ctx 连着走两拍，
  // 第一拍说（否则用户不知道我们看见了他开的页），刷新窗口里那一拍不许再说（这一发就是现场那句重播）。
  var stGap = mkCtx();
  var rFirst = runSpeak(stGap, answeredOnce, N);
  var rGap = runSpeak(stGap, gapCache, refreshAt + 1000);
  var planGap = plan(gapCache, refreshAt + 1000, 'not-ours', N);
  // 桥一直不回话：借期只有一个刷新窗口，超出就必须退回「还在问」= 老地板重新有声音（§2 #16(c)）
  askNow = refreshAt + PENDING + 1000;
  var borrowEnd = askNow;
  ask.call(stCarry, borrowEnd);
  var expiredCache = Object.assign({}, stCarry._studyTabStateCache);
  var sentExpired = sends.length - baseSends;
  var rExpired = runSpeak(mkCtx(), expiredCache, borrowEnd);
  var planExpired = plan(expiredCache, borrowEnd, 'not-ours', N);
  // 「答过、但那条没用」（ok 假）那一格不许借 —— 借过去就等于把「读不出」洗成「有结论」
  var stUseless = { _withTimeout: function (p, ms) { return p; } };
  askAnswer = null;
  askNow = N;
  ask.call(stUseless, N);
  await flushMicro();
  var uselessAnswered = Object.assign({}, stUseless._studyTabStateCache);
  askAnswer = { success: true, reason: 'never-study', mayRescue: false, studyHref: '', studyAgeMs: 7200000, awayMs: 0, otherStudyTabs: 1, rescues: 0 };
  askNow = N + FRESH + 1000;
  ask.call(stUseless, N + FRESH + 1000);
  var uselessGap = Object.assign({}, stUseless._studyTabStateCache);
  var rUselessGap = runSpeak(mkCtx(), uselessGap, N + FRESH + 1000);
  // 借来的那一份要能在日志里认出来（现场只看 reason 分不开"刚问到的"与"60 秒前那份"）
  var carriedAnother = Object.assign(cacheOf({ reason: 'another-study-tab', otherStudyTabs: 2 }), { carried: true, at: N });
  var rCarried = runSpeak(mkCtx(), carriedAnother, N + FRESH + SILENCE + 1000);
  var plainCache = cacheOf({ reason: 'another-study-tab', otherStudyTabs: 2 });
  var rPlain = runSpeak(mkCtx(), plainCache, N);
  var carriedMeta = rCarried.logs[0] && rCarried.logs[0].meta;
  var plainMeta = rPlain.logs[0] && rPlain.logs[0].meta;
  check('㉚ 刷新只敲门、不清账：① 后台明确答过「这页不是插件带来的」时，60 秒刷新那几秒里判据仍是 silent（每份页面只说一次），地板那句「请手动回到章节页」不许重播；' +
    '② 借期只有一个刷新窗口（新鲜地板 + 待问地板），桥真死了就退回「还在问」= 老地板照旧有声音，不许把借来的答案变成永久静音；' +
    '③ 只借**可用**的答案（ok 假那份不许借，否则「读不出」被洗成「有结论」）；④ 借的时候字段逐个保住（reason/mayRescue/枚数/靶地址），' +
    '把「另一枚占着」借成「能自己回去」就是把那一门顶下线（§2 #15）；⑤ 借答案时「在问」仍是真，待问地板照旧挡住，一刷新就每拍重敲 = 自己造轮询；' +
    '⑥ 借来的答案在日志里认得出来（carried 与答案年龄两格都要从缓存读回来，不是测试自己拍的常量）',
    answeredOnce.ok === true && answeredOnce.reason === 'never-study' && sentRefresh === 2 &&
    gapCache.carried === true && gapCache.answered === true && gapCache.ok === true &&
    gapCache.reason === 'never-study' && gapCache.otherStudyTabs === 1 && gapCache.mayRescue === false &&
    gapCache.studyAgeMs === 7200000 && gapCache.at === N && gapCache.pendingAt === refreshAt &&
    planGap === 'silent' &&
    rFirst.logs.length === 1 && /not our page/.test(rFirst.logs[0].message) &&
    rGap.ret === true && rGap.logs.length === 0 && rGap.navs.length === 0 &&
    sentInGap === sentRefresh &&
    expiredCache.carried === false && expiredCache.answered === false && expiredCache.ok === false &&
    expiredCache.pendingAt === borrowEnd &&
    planExpired === 'asking' && rExpired.ret === false && rExpired.logs.length === 0 && sentExpired === 3 &&
    uselessAnswered.ok === false && uselessGap.carried === false && uselessGap.answered === false &&
    uselessGap.ok === false && uselessGap.reason === '' && rUselessGap.ret === false &&
    carriedMeta && carriedMeta.carried === true &&
    carriedMeta.answerAgeMs === (N + FRESH + SILENCE + 1000) - N &&
    plainMeta && plainMeta.carried === false && plainMeta.answerAgeMs === 0,
    JSON.stringify({
      sent: [sentRefresh, sentInGap, sentExpired], gap: gapCache, planGap: planGap,
      gapSpoke: { ret: rGap.ret, logs: rGap.logs.length },
      expired: { carried: expiredCache.carried, answered: expiredCache.answered, plan: planExpired, ret: rExpired.ret },
      uselessGap: { carried: uselessGap.carried, ok: uselessGap.ok, ret: rUselessGap.ret },
      carriedMeta: { carried: carriedMeta && carriedMeta.carried, age: carriedMeta && carriedMeta.answerAgeMs },
      plainMeta: { carried: plainMeta && plainMeta.carried, age: plainMeta && plainMeta.answerAgeMs }
    }));
}

/** ---- [22] 批次 95：可拖区间还服务不了目标时，不许把一次性机会花在它身上 ---- */
async function testSeekDeferUntilSeekable() {
  console.log('\n[22] 拖到结尾：区间没长出来时先等，不把它判成「站点防拖拽」（批次 95）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var media = read('src/page/40-media.js');

  // ⚠️ `async` 必须一起认：`_detectMaxPlaybackRate` 声明成 `async function`，只锚 `name + ': function'`
  //   对它取不出本体，于是 ㉝ 那根**静态接线尺**量的是空串 —— 看着像"生产里没这一句"，
  //   真相是这一段从来没看见那一句（AGENTS §5「红 0 条的第一嫌疑人是根本没跑到」，本轮实测撞过）。
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) at = src.indexOf(name + ': async function');
    if (at < 0) return { start: -1, end: -1 };
    var fnAt = src.indexOf('function', at);
    // 切本体时把 `async ` 一起带走：只从 `function` 起重建出来的是普通函数，而体里有 `await` —— 当场 SyntaxError
    var start = src.slice(fnAt - 6, fnAt) === 'async ' ? fnAt - 6 : fnAt;
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  // 方法体里的 emitRuntimeLog / Date 是外壳注入的自由变量，单独取出来跑要自己注进去
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  var firstNum = function (src, re) {
    var m = src.match(re);
    return m ? Number(m[1]) : null;
  };

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
  var nowMs = 1700000000000;
  var FakeDate = { now: function () { return nowMs; } };
  var inj = { emitRuntimeLog: say, Date: FakeDate };

  var getKey = buildFrom(media, '_getMediaSeekKey', {});
  // 会话任务 #231 第 1 档：`_getMediaSeekKey` 现在经兄弟方法 `_mediaStablePath` 把签名查询串切掉。
  // `buildFrom` 只取**单个**方法体，假 app 少挂这一件就是 TypeError → 整段一条断言都不跑，
  // 而「没执行」在报告里和「通过」长得一模一样（AGENTS §5「红 0 条的第一嫌疑人是根本没跑到」）。
  var stablePath = buildFrom(media, '_mediaStablePath', {});
  // 只为「不经假 app、裸算一把钥匙」那几处准备的 `this`：生产里兄弟方法恒在 app 上，测试台得自己补
  var keyCtx = { _mediaStablePath: stablePath };
  var covers = buildFrom(media, '_seekableCovers', {});
  var defer = buildFrom(media, '_deferSeekUntilSeekable', inj);
  var trySeek = buildFrom(media, '_trySeekToEnd', inj);
  var quarantineTtl = readProductConstant(read('src/page/00-shell-constants.js'), 'TASK_GIVEUP_TTL_MS');
  var quarantine = buildFrom(media, '_isMediaQuarantined', { TASK_GIVEUP_TTL_MS: quarantineTtl });
  var noteSkip = buildFrom(media, '_noteSeekSkip', inj);
  var isNinety = buildFrom(media, '_isNinetyPercentVideo', {});
  // 站点「完成条件」标语那四件（任务 #193）—— `_siteSaysNoDrag` 经 `this._siteSeekCondition`
  // 再经 `this._readSiteSeekCondition`，三件都得挂上 app，缺任何一件就是 TypeError 而不是红
  var condNoDrag = buildFrom(media, '_siteConditionNoDrag', {});
  var readCond = buildFrom(media, '_readSiteSeekCondition', {});
  var siteCond = buildFrom(media, '_siteSeekCondition', inj);
  var siteNoDrag = buildFrom(media, '_siteSaysNoDrag', {});
  // 批次 173 / #199：课程级那一格（免拖 ≠ 免倍速，两格各记各的）。九件都要能取出来真跑 ——
  // 取不出来时后面每一条都是「没执行」，而「没执行」在报告里和「通过」长得一模一样（AGENTS §5）。
  var guardId = buildFrom(media, '_courseGuardId', {});
  var guardCell = buildFrom(media, '_courseGuardCell', inj);
  var guardPersist = buildFrom(media, '_persistCourseGuard', inj);
  var guardHit = buildFrom(media, '_courseGuardHit', inj);
  var guardNote = buildFrom(media, '_noteCourseGuard', inj);
  var guardClear = buildFrom(media, '_clearCourseGuard', inj);
  var guardSay = buildFrom(media, '_sayCourseGuard', inj);
  var guardRateSkip = buildFrom(media, '_noteCourseGuardRateSkipped', inj);
  var guardSource = buildFrom(media, '_seekNoDragSource', inj);
  // 「这条路被放弃了」那一句现在也吃课程账（倍速那一侧），所以它得和上面几件一起取出来 ——
  // 取不出来时 ㉛ 新增的那两格会当场抛出来把整段打死（AGENTS §5「红 0 条的第一嫌疑人是没跑到」）。
  var noteHeld22 = buildFrom(media, '_noteNinetyHeldBack', inj);
  // #231 第 3b 档：五处整体复位改成「只清最旧」，`_trySeekToEnd`／`_noteSeekSkip`／`_siteSeekCondition`
  // ／`_noteNinetyHeldBack` 现在都会 `this._evictOldestKeys(...)` —— 假 app 不挂这一件就是 TypeError，
  // 整段一条断言都不跑（同上面 `stablePath` 那一族的注释）。助手整段不读 `this`，可直接挂。
  var evictShared = buildFrom(media, '_evictOldestKeys', {});
  // NEED / TTL / 存储键三枚常数从源码读回来，测试里一份都不许写死（生产改了数而断言照旧跑 = 假绿）
  var guardNeed = firstNum(media, /_COURSE_GUARD_NEED:\s*(\d+)/);
  var guardTtl = firstNum(media, /_COURSE_GUARD_TTL_MS:\s*(\d+)/);
  var guardLedgerKey = (media.match(/_COURSE_GUARD_KEY:\s*'([^']+)'/) || [])[1] || '';

  // 两个预算从源码读回来，别抄成测试里的字面量（改了生产数而断言还按旧数跑 = 假绿）
  var deferBody = bodyOf(media, '_deferSeekUntilSeekable');
  var windowMs = firstNum(deferBody, /Date\.now\(\) \+ (\d+)/);
  var capTries = firstNum(deferBody, /st\.tries >= (\d+)/);
  // 标语缓存的 TTL 也从源码读，别在这里写死 30000
  var siteBody = bodyOf(media, '_siteSeekCondition');
  var condTtlMs = firstNum(siteBody, /now - \(hit\.at \|\| 0\) < (\d+)/);

  check('① 六件、钥匙归一那件与隔离谓词都能从 40-media.js 原样取出来真跑，标语那四件、课程格那九件与「这条路被放弃了」那一句也取得出来，两个预算、标语 TTL 与课程的 NEED／TTL／存储键都读得回来（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    [getKey, covers, defer, trySeek, quarantine, noteSkip, isNinety].every(function (f) { return typeof f === 'function'; }) &&
    typeof stablePath === 'function' &&
    quarantineTtl > 0 &&
    [condNoDrag, readCond, siteCond, siteNoDrag].every(function (f) { return typeof f === 'function'; }) &&
    [guardId, guardCell, guardPersist, guardHit, guardNote, guardClear, guardSay, guardRateSkip, guardSource].every(function (f) { return typeof f === 'function'; }) &&
    typeof noteHeld22 === 'function' &&
    windowMs > 0 && capTries > 1 && condTtlMs > 0 &&
    guardNeed > 0 && guardTtl > 0 && guardLedgerKey.length > 0,
    JSON.stringify({ key: typeof getKey, stable: typeof stablePath, covers: typeof covers, defer: typeof defer, seek: typeof trySeek, note: typeof noteSkip, ninety: typeof isNinety, cond: [typeof condNoDrag, typeof readCond, typeof siteCond, typeof siteNoDrag].join('/'), guard: [typeof guardId, typeof guardCell, typeof guardPersist, typeof guardHit, typeof guardNote, typeof guardClear, typeof guardSay, typeof guardRateSkip, typeof guardSource].join('/'), held: typeof noteHeld22, windowMs: windowMs, capTries: capTries, condTtlMs: condTtlMs, guardNeed: guardNeed, guardTtl: guardTtl, guardKey: guardLedgerKey }));
  if (!trySeek || !quarantine || !covers || !defer || !isNinety || !noteSkip || !readCond || !siteCond || !siteNoDrag || !noteHeld22 || !stablePath || !getKey ||
    !guardId || !guardCell || !guardPersist || !guardHit || !guardNote || !guardClear || !guardSay || !guardRateSkip || !guardSource) return;

  function mkRanges(list) {
    return {
      length: list.length,
      start: function (i) { return list[i][0]; },
      end: function (i) { return list[i][1]; }
    };
  }
  // opt.ranges：区间数组；'missing' = 这个属性压根没有；'throws' = 一读就抛
  // opt.ignoreWrites：站点把写入整个吞掉（规范里 seek 到区间外就是这个形状）
  function mkVideo(opt) {
    opt = opt || {};
    var rec = { writes: [], cur: opt.current == null ? 0 : opt.current };
    var v = {
      tagName: opt.tagName || 'VIDEO',
      isConnected: true,
      duration: opt.duration,
      currentSrc: 'https://ananas.chaoxing.com/video/910000001/at_1700000000000.mp4',
      __rec: rec
    };
    Object.defineProperty(v, 'currentTime', {
      get: function () { return rec.cur; },
      set: function (n) { rec.writes.push(n); if (!opt.ignoreWrites) rec.cur = n; }
    });
    if (opt.ranges === 'missing') return v;
    if (opt.ranges === 'throws') {
      v.seekable = { get length() { throw new Error('读不到'); } };
      return v;
    }
    v.seekable = mkRanges(opt.ranges || []);
    return v;
  }
  // shape.store：换页那一格用同一份存储重建一枚 app（账要活着）；shape.noCourse：认不出是哪门课；
  // shape.course：故意换一门课（旧课的账不许带进新课）。
  function mkApp(shape) {
    shape = shape || {};
    var delays = [];
    var store = shape.store || {};
    var app = {
      configs: { enableSeek: true },
      _rateProbing: false,
      _captchaActive: false,
      _activeJobId: '',
      _mediaQuarantine: new WeakMap(),
      _mediaReloadKeys: Object.create(null),
      _isMediaQuarantined: quarantine,
      _workerDelay: function (fn) { delays.push(fn); },
      _isRateLockedAtOne: function () { return true; },
      _getMediaSeekKey: getKey,
      _mediaStablePath: stablePath,
      _seekableCovers: covers,
      _evictOldestKeys: evictShared,
      _deferSeekUntilSeekable: defer,
      _trySeekToEnd: trySeek,
      _noteSeekSkip: noteSkip,
      _isNinetyPercentVideo: isNinety,
      _siteConditionNoDrag: condNoDrag,
      _readSiteSeekCondition: readCond,
      _siteSeekCondition: siteCond,
      _siteSaysNoDrag: siteNoDrag,
      // ㉛ 新增的两格要真跑 `_noteNinetyHeldBack`，它中间问一句「平台标记完成没有」——
      // 这一族钉的是**证据来源**，平台标记那一格由 [30] ⑥⑧ 各自钉，这里钉成"成立"就好。
      _isDocumentFrameFinished: function () { return true; },
      _COURSE_GUARD_NEED: guardNeed,
      _COURSE_GUARD_TTL_MS: guardTtl,
      _COURSE_GUARD_KEY: guardLedgerKey,
      _readSessionLedger: function (k) { return store[k] ? JSON.parse(store[k]) : null; },
      _writeSessionLedger: function (k, v) { store[k] = JSON.stringify(v); },
      _courseGuardId: guardId,
      _courseGuardCell: guardCell,
      _persistCourseGuard: guardPersist,
      _courseGuardHit: guardHit,
      _noteCourseGuard: guardNote,
      _clearCourseGuard: guardClear,
      _sayCourseGuard: guardSay,
      _noteCourseGuardRateSkipped: guardRateSkip,
      _seekNoDragSource: guardSource
    };
    if (!shape.noCourse) {
      var cid = shape.course || 'COURSE_A';
      app._currentStudyParams = function () { return { courseid: cid, clazzid: shape.clazz || 'CLASS_A' }; };
    }
    return { app: app, delays: delays, store: store };
  }
  var seekTo = function (app, v, reason) { return app._trySeekToEnd(v, reason); };
  var keyOf = function (v) { return getKey.call(keyCtx, v); };

  var DUR = 1401.4;
  var TARGET = DUR - 3;

  // ---- ② 口径本身：四格互斥，读不到时往「照旧拖一次」那一边失败 ----
  var lad = {
    yes: covers.call({}, mkVideo({ duration: DUR, ranges: [[0, DUR]] }), TARGET),
    empty: covers.call({}, mkVideo({ duration: DUR, ranges: [] }), TARGET),
    outside: covers.call({}, mkVideo({ duration: DUR, ranges: [[0, 60]] }), TARGET),
    missing: covers.call({}, mkVideo({ duration: DUR, ranges: 'missing' }), TARGET),
    throws: covers.call({}, mkVideo({ duration: DUR, ranges: 'throws' }), TARGET),
    mid: covers.call({}, mkVideo({ duration: DUR, ranges: [[0, 60], [1200, DUR]] }), TARGET)
  };
  check('② 区间口径四格分得开：含尾部 yes、没长出来 empty、长出来但不含尾部 outside、多段命中中间那段也算 yes；读不到与抛异常一律当 yes（宁可照旧拖一次，别把能拖的机会判成不可拖）',
    lad.yes === 'yes' && lad.empty === 'empty' && lad.outside === 'outside' &&
    lad.missing === 'yes' && lad.throws === 'yes' && lad.mid === 'yes',
    JSON.stringify(lad));

  // ---- ③ 这一拍区间还是空的：进度条一下都不许动，一次性机会不许花掉 ----
  logs.length = 0;
  var a3 = mkApp(), v3 = mkVideo({ duration: DUR, ranges: [] });
  var r3 = seekTo(a3.app, v3, 'loadedmetadata');
  var k3 = keyOf(v3);
  check('③ 区间还没长出来时：不写 currentTime、_seekTriedKeys 不登记、不排任何延时，且 90% 提前收尾那一格仍是 false（「现在还不行」没被压成「不行」）',
    r3 === false && v3.__rec.writes.length === 0 && !!a3.app._seekTriedKeys &&
    !a3.app._seekTriedKeys[k3] && !a3.app._seekRevertedKeys[k3] &&
    a3.delays.length === 0 && a3.app._isNinetyPercentVideo(v3) === false,
    JSON.stringify({ ret: r3, writes: v3.__rec.writes.length, tried: a3.app._seekTriedKeys, delays: a3.delays.length, ninety: a3.app._isNinetyPercentVideo(v3) }));
  check('④ 空区间这一拍要留一条日志点名凭什么没拖（cover 与 reason 都得在），不能静默什么都不做',
    logs.length === 1 && /waiting/.test(logs[0].message) && logs[0].meta &&
    logs[0].meta.cover === 'empty' && logs[0].meta.reason === 'loadedmetadata' &&
    Number(logs[0].meta.to) === Number(TARGET.toFixed(1)),
    JSON.stringify(logs));

  // ---- ⑤ 现场那一族的真实形状：先空、区间长出来之后同一支视频要真拖过去 ----
  logs.length = 0;
  var a5 = mkApp(), v5 = mkVideo({ duration: DUR, ranges: [] });
  seekTo(a5.app, v5, 'guard');
  v5.seekable = mkRanges([[0, DUR]]);
  var r5 = seekTo(a5.app, v5, 'guard');
  var w5 = v5.__rec.writes;
  check('⑤ 同一支视频：第一拍区间空（不写），区间长出来后的那一拍真把 currentTime 写到 duration-3、并登记为已检查',
    r5 === true && w5.length === 1 && Number(w5[0].toFixed(1)) === Number(TARGET.toFixed(1)) &&
    a5.app._seekTriedKeys[keyOf(v5)] === true && /seek to end/.test(logs.map(function (l) { return l.message; }).join('|')),
    JSON.stringify({ ret: r5, writes: w5, tried: a5.app._seekTriedKeys[keyOf(v5)], msgs: logs.map(function (l) { return l.message; }) }));

  // ---- ⑥ 区间一直不含尾部：时间预算用尽后**照旧真拖一次** ----
  // ⚠️ 收口不许写成"闸门自己判不可拖"：那等于把"等区间没等到"当成"站点防拖拽"，
  //    正是本次要修的那一族的反面。结论只能来自"写下去被弹回"（下面 flush 之后才成立）。
  logs.length = 0;
  var a6 = mkApp(), v6 = mkVideo({ duration: DUR, ranges: [[0, 60]], current: 1.1, ignoreWrites: true });
  seekTo(a6.app, v6, 'guard');
  nowMs += windowMs + 1;   // 时钟走过唯一的窗口，次数一格没多用 —— 这一格钉时间那条护栏
  var r6 = seekTo(a6.app, v6, 'guard');
  var revBefore6 = a6.app._seekRevertedKeys[keyOf(v6)];
  var flushed6 = 0;
  while (a6.delays.length && flushed6 < 5) { var fn6 = a6.delays.shift(); flushed6++; try { fn6(); } catch (e6b) { break; } }
  check('⑥ 时间预算用尽：那一拍真把 currentTime 写下去（闸门自己绝不预先判"不可拖"），弹回判定跑完之后 _seekRevertedKeys 才为真、90% 提前收尾才成立；日志点名 tries 与 cover，不静默放手',
    r6 === true && revBefore6 !== true && a6.app._seekTriedKeys[keyOf(v6)] === true &&
    a6.app._seekRevertedKeys[keyOf(v6)] === true && flushed6 >= 1 && v6.__rec.writes.length === 3 &&
    a6.app._isNinetyPercentVideo(v6) === true &&
    logs.some(function (l) { return /never became reachable/.test(l.message) && l.meta &&
      l.meta.cover === 'outside' && Number(l.meta.tries) === 2; }) &&
    logs.some(function (l) { return l.message === 'seek reverted by site, keep playing normally'; }),
    JSON.stringify({ ret: r6, revBefore: revBefore6, rev: a6.app._seekRevertedKeys[keyOf(v6)], writes: v6.__rec.writes.length, flushed: flushed6, ninety: a6.app._isNinetyPercentVideo(v6), msgs: logs.map(function (l) { return l.message; }) }));
  nowMs = 1700000000000;

  // ---- ⑦ 两条预算各自独立承重：只留次数那一条时也要能收口 ----
  logs.length = 0;
  var a7 = mkApp(), v7 = mkVideo({ duration: DUR, ranges: [[0, 60]], current: 1.1, ignoreWrites: true });
  var rets7 = [];
  for (var i7 = 0; i7 < capTries; i7++) rets7.push(seekTo(a7.app, v7, 'guard'));
  check('⑦ 次数预算用尽（时钟一步没走，只有 tries 到顶）：前 capTries-1 拍一格都不动进度条，最后一拍真写下去 —— 两条护栏各测一条，删掉任一条另一条都得还在',
    rets7[0] === false && rets7[capTries - 2] === false && rets7[capTries - 1] === true &&
    rets7.filter(function (x) { return x === true; }).length === 1 &&
    v7.__rec.writes.length === 1 && a7.app._seekTriedKeys[keyOf(v7)] === true &&
    a7.app._seekRevertedKeys[keyOf(v7)] !== true &&
    logs.filter(function (l) { return /never became reachable/.test(l.message); }).length === 1 &&
    Number(logs.filter(function (l) { return /never became reachable/.test(l.message); })[0].meta.tries) === capTries,
    JSON.stringify({ trueAt: rets7.indexOf(true), tries: capTries, writes: v7.__rec.writes.length, rev: a7.app._seekRevertedKeys[keyOf(v7)], msgs: logs.map(function (l) { return l.message; }) }));

  // ---- ⑧ 等待日志每支视频只说第一次（这一族每 1500 毫秒就来一拍） ----
  var a8 = mkApp(), v8 = mkVideo({ duration: DUR, ranges: [] });
  logs.length = 0;
  for (var i8 = 0; i8 < 40; i8++) seekTo(a8.app, v8, 'guard');
  check('⑧ 还在等区间的 40 拍里，「等区间」那条日志只出第一次（每拍重播会把 200 条证据环挤空，批次 37 / 51 同一族）',
    logs.filter(function (l) { return /waiting for it/.test(l.message); }).length === 1,
    JSON.stringify({ total: logs.length, msgs: logs.map(function (l) { return l.message; }).slice(0, 4) }));

  // ---- ⑨ 旧行为没被弄坏：区间明明含尾部却两次弹回，仍按「站点防拖拽」收尾 ----
  logs.length = 0;
  var a9 = mkApp(), v9 = mkVideo({ duration: DUR, ranges: [[0, DUR]], ignoreWrites: true });
  var r9 = seekTo(a9.app, v9, 'job-start');
  var flushed = 0;
  while (a9.delays.length && flushed < 5) {
    var fn9 = a9.delays.shift();
    flushed++;
    try { fn9(); } catch (e9) { break; }
  }
  check('⑨ 区间含尾部却两次弹回（真·防拖拽）：仍走旧收尾 —— 拖过、重试两次、_seekRevertedKeys 置真并出「keep playing normally」，本次改动没把这族放掉',
    r9 === true && v9.__rec.writes.length === 3 && a9.app._seekTriedKeys[keyOf(v9)] === true &&
    a9.app._seekRevertedKeys[keyOf(v9)] === true &&
    logs.some(function (l) { return /seek reverted by site, retry/.test(l.message); }) &&
    logs.some(function (l) { return l.message === 'seek reverted by site, keep playing normally'; }),
    JSON.stringify({ ret: r9, writes: v9.__rec.writes.length, flushed: flushed, msgs: logs.map(function (l) { return l.message; }) }));

  // ---- ⑩ 记账要有界：五处 `>300` 整体复位全部改成「只清最旧」（会话任务 #231 第 3b 档）----
  //   旧口径「过 300 就整本重建」有两笔账付不起：`_seekRevertedKeys` 是站点把进度条拽回去的**行为证据**，
  //   连坐抹平等于替每支视频重发一次性试拖预算（AGENTS §2 #17）；`_startNudgeKeys`／`_seekSkipLedger`
  //   归零则是 §2 #13 那族「跨拍记账被同一轮动作清零」。现在 8 本媒体钥匙账全走同一个助手。
  var resetBody = bodyOf(media, '_trySeekToEnd');
  var evictLedgers = ['_seekSkipLedger', '_seekSiteKeys', '_seekTriedKeys', '_seekRevertedKeys',
    '_seekDeferKeys', '_ninetyHeldBackKeys', '_startNudgeKeys', '_mediaReloadKeys'];
  var evictSeen = {};
  var evictCaps = {};
  evictLedgers.forEach(function (n) {
    var hits = media.match(new RegExp('_evictOldestKeys\\(\\s*this\\.' + n + '\\s*,\\s*(\\d+)\\s*\\)', 'g')) || [];
    evictSeen[n] = hits.length;
    evictCaps[n] = hits.map(function (s) { return Number(/(\d+)\s*\)/.exec(s)[1]); });
  });
  // 三本 seek 账那一发必须写在 `_trySeekToEnd` 里：写在别的片段里同样能让全书计数对上，却管不到这一族
  var inTrySeek = ['_seekTriedKeys', '_seekRevertedKeys', '_seekDeferKeys'].filter(function (n) {
    return resetBody.indexOf('this._evictOldestKeys(this.' + n + ',') >= 0;
  });
  var wholeReset = (media.match(/\.length\s*>\s*300/g) || []).length;
  var revertedRebuild = (media.match(/this\._seekRevertedKeys\s*=\s*Object\.create\(null\)/g) || []).length;
  var revertedGuarded = (media.match(/if\s*\(\s*!\s*this\._seekRevertedKeys\s*\)\s*this\._seekRevertedKeys\s*=\s*Object\.create\(null\)/g) || []).length;
  check('⑩ 媒体钥匙那一族 8 本账全部改成 `_evictOldestKeys(…, 300)` 只清最旧：每本恰好一处、上限从源码读回来全是 300，'
    + 'seek 那三本的一发确实写在 `_trySeekToEnd` 里；slice 内再无 `.length > 300` 整体复位（残留一发就是回到整本抹平）；'
    + '`_seekRevertedKeys` 的 `Object.create(null)` 只许出现在「没建过才建」那一格（连坐重建会红在这里）',
    evictLedgers.every(function (n) { return evictSeen[n] === 1 && evictCaps[n][0] === 300; }) &&
      inTrySeek.length === 3 && wholeReset === 0 &&
      revertedRebuild === revertedGuarded && revertedGuarded >= 1,
    JSON.stringify({ perLedger: evictSeen, caps: evictCaps, inTrySeek: inTrySeek.length,
      wholeReset: wholeReset, revertedRebuild: revertedRebuild, revertedGuarded: revertedGuarded }));
  check('⑪ 一次性标记排在区间闸门之后（写在前面就是本次要修的那个 bug 本身，静态钉住顺序）',
    resetBody.indexOf('_deferSeekUntilSeekable') >= 0 &&
    resetBody.indexOf('_seekTriedKeys[key] = true') > resetBody.indexOf('_deferSeekUntilSeekable'),
    JSON.stringify({ gate: resetBody.indexOf('_deferSeekUntilSeekable'), mark: resetBody.indexOf('_seekTriedKeys[key] = true') }));

  // ---- ⑫ 现场实测（2026-11-18，同一门鉴赏课连刷两支）：一支 `tried/reverted` 双双为真、
  //      另一支**一次都没试**（整支按 1x 白播 22 分钟），而盘上零证据 —— 那四个出口既不写日志
  //      也不登记。现在每一格出口按媒体钥匙留一笔账，探针读得回来。这一族**不发日志**：
  //      `_trySeekToEnd` 每 1500 毫秒就来一拍，说话会把 200 条的证据窗吃光（AGENTS §2 #16(b)）。
  logs.length = 0;
  var a12 = mkApp(), v12 = mkVideo({ duration: DUR, ranges: [[0, DUR]] });
  a12.app._captchaActive = true;
  var r12 = seekTo(a12.app, v12, 'guard');
  var k12 = keyOf(v12);
  var s12 = a12.app._seekSkipLedger && a12.app._seekSkipLedger[k12];
  check('⑫ 被验证码闸挡下的那一支：进度条一下都没写、tried 不登记，但按**这一支的钥匙**留下一格（last／reasons.captcha／dur 全读得回来），且这一族一条日志都不发',
    r12 === false && v12.__rec.writes.length === 0 &&
    !(a12.app._seekTriedKeys && a12.app._seekTriedKeys[k12]) &&
    !!s12 && s12.last === 'captcha' && s12.reasons.captcha === 1 &&
    s12.dur === Number(DUR.toFixed(1)) && s12.src === true && logs.length === 0,
    JSON.stringify({ ret: r12, writes: v12.__rec.writes.length, skip: s12 || null, logs: logs.length }));

  // ---- ⑬ 账必须按钥匙分家：并成一格就是「读得出却归错因」，比读不出更贵 ----
  var a13 = mkApp(), v13 = mkVideo({ duration: DUR, ranges: [[0, DUR]] }), k13 = keyOf(v13);
  a13.app._captchaActive = true;
  seekTo(a13.app, v13, 'guard'); seekTo(a13.app, v13, 'guard'); seekTo(a13.app, v13, 'guard');
  var v13b = mkVideo({ duration: 812.5, ranges: [[0, 812.5]] });
  v13b.currentSrc = 'https://ananas.chaoxing.com/video/910000002/at_1700000000000.mp4';
  var k13b = keyOf(v13b);
  a13.app._captchaActive = false;
  a13.app._rateProbing = true;
  seekTo(a13.app, v13b, 'guard');
  var L13 = a13.app._seekSkipLedger || {};
  var keys13 = Object.keys(L13);
  check('⑬ 同一支连问三拍累加到 3，换一枚（不同 src、不同时长、不同闸门）另开一格且各说各的原因 —— 两把钥匙并成一格就是归错因',
    k13 !== k13b && keys13.length === 2 && L13[k13].n === 3 && L13[k13].last === 'captcha' &&
    L13[k13b].n === 1 && L13[k13b].last === 'probing' && L13[k13b].dur === 812.5,
    JSON.stringify({ keys: keys13.length, a: L13[k13] || null, b: L13[k13b] || null }));

  // ---- ⑭ 出口清单与接线一一对应（§2 #18 那一族：新增一格忘了接线，什么都不红，只在现场少说一句话）----
  var exits14 = ['disabled', 'probing', 'captcha', 'no-key', 'no-meta', 'near-end', 'site-no-drag', 'course-no-drag'];
  var body14 = bodyOf(media, '_trySeekToEnd');
  var calls14 = (body14.match(/this\._noteSeekSkip\(/g) || []).length;
  var wired14 = exits14.filter(function (r) { return body14.indexOf("_noteSeekSkip('" + r + "'") >= 0; });
  check('⑭ 「不试拖」八格出口全部接上账，且方法体里恰好八处调用（多一格没进清单、少一格没接线，都在这条上红）',
    wired14.length === exits14.length && calls14 === exits14.length,
    JSON.stringify({ need: exits14.length, wired: wired14, calls: calls14 }));

  // ---- ⑮⑯⑰ 其他扩展注入痕迹探针（任务 #157）：四态诚实、缓存限频、提醒独立成句 ----
  // found 那一格的 DOM 扫描在无 DOM 的测试台里走不到（那是 e2e 的地盘），这里钉住的是
  // 测试台够得着的三件事：认不出就交 unreadable 绝不猜 found、60 秒缓存、提醒的 found 闸与限频。
  var scanForeign = buildFrom(media, '_scanForeignExtensionArtifacts', { Date: FakeDate });
  var noteHint = buildFrom(media, '_noteForeignExtensionHint', { emitRuntimeLog: say, Date: FakeDate });
  var probeApp = { _foreignExtScan: null };
  var probeRes = scanForeign.call(probeApp, null);
  check('⑮ 探针在无 DOM 的测试台里交 unreadable、痕迹数 0（认不出自家 id 就交空结论，绝不猜 found —— AGENTS §2 #18 同族）',
    typeof scanForeign === 'function' && !!probeRes && probeRes.state === 'unreadable' &&
    probeRes.count === 0 && probeRes.ids && probeRes.ids.length === 0,
    JSON.stringify(probeRes));
  var probeRes2 = scanForeign.call(probeApp, null);
  check('⑯ 探针 60 秒内复用缓存（give-up 路径卡住时每一拍都会问，不许每拍全页扫）',
    probeRes2 === probeRes && probeApp._foreignExtScan === probeRes,
    JSON.stringify({ same: probeRes2 === probeRes }));
  var hintApp = { _foreignExtHintAt: 0 };
  var hintMark = logs.length;
  noteHint.call(hintApp, { state: 'found', ids: ['ext_a', 'ext_b'], count: 3 });
  noteHint.call(hintApp, { state: 'found', ids: ['ext_a'], count: 1 });
  noteHint.call(hintApp, { state: 'none', ids: [], count: 0 });
  noteHint.call(hintApp, { state: 'unreadable', ids: [], count: 0 });
  var hintMsgs = logs.slice(hintMark).filter(function (m) {
    return String(m.message || '').indexOf('检测到其他浏览器扩展') === 0;
  });
  check('⑰ found 出一句用户向提醒（warn、带 ids/count/hint）且 10 分钟限频内第二发静默；none / unreadable 一句不出（页面干净 ≠ 没有隐形干预，说了「没事」就是假话）',
    hintMsgs.length === 1 && hintApp._foreignExtHintAt === nowMs &&
    !!hintMsgs[0].meta && String(hintMsgs[0].meta.ids) === 'ext_a,ext_b' &&
    Number(hintMsgs[0].meta.count) === 3 && String(hintMsgs[0].level) === 'warn',
    JSON.stringify(hintMsgs));

  // ---- ⑱–㉔ 站点自己写的「完成条件」标语（会话任务 #193）----
  // 假 DOM 的形状按 2026-11-20 现场只读实测搭：`<video>` 在播放器文档（`ananas/modules/video/index.html`）里，
  // 标语 `span.task-condition-text` 写在**上一层** cards 文档的那张任务卡里，而卡片 contains 的是
  // **承载播放器的那枚 iframe**（`contains` 不跨文档，拿 video 去比恒 false → 每一枚标语都会被判成"不是这一节的"）。
  var NO_DRAG_TEXT = '观看时长需 ≥ 总时长的 90% (未完成任务点前, 当前视频不可拖拽、观看时不可离开或将页面最小化)';
  var FREE_TEXT = '观看时长需 ≥ 总时长的 95% (未完成任务点前, 观看时不可离开或将页面最小化)';
  var L_FORBID = [[], [{ text: NO_DRAG_TEXT, owns: true }]];
  // opt.levels：从内到外每一层的标语数组（默认两层 = 播放器 + cards）；opt.throwsAt = 第几层一读就抛
  function mkBannerVideo(opt) {
    opt = opt || {};
    var stat = { scans: 0 };
    var card = { contains: function (n) { return !!n && n.__card === card; } };
    var docs = (opt.levels || [[], []]).map(function (list, i) {
      var d = {};
      d.querySelectorAll = function (sel) {
        stat.scans++;
        if (opt.throwsAt === i) throw new Error('这一层读不下去');
        return sel === '.task-condition-text' ? list.map(function (c) {
          return { textContent: c.text, closest: function () { return c.owns ? card : null; } };
        }) : [];
      };
      return d;
    });
    for (var i = 0; i < docs.length; i++) {
      // 最外层那枚的 `defaultView.frameElement` 恒为 null（那就是顶层帧）—— 爬到它还没标语才算 absent
      docs[i].defaultView = docs[i + 1] ? { frameElement: { __card: card, ownerDocument: docs[i + 1] } } : null;
    }
    var v = mkVideo({
      duration: opt.duration || DUR,
      ranges: opt.ranges || [[0, DUR]],
      current: opt.current == null ? 600 : opt.current
    });
    v.currentSrc = 'https://ananas.chaoxing.com/video/' + (opt.src || 'banner') + '.mp4';
    if (!opt.noDoc) v.ownerDocument = docs[0];
    return { video: v, stat: stat, docs: docs };
  }
  var readApp = { _siteConditionNoDrag: condNoDrag };

  var st18 = {
    forbid: readCond.call(readApp, mkBannerVideo({ levels: L_FORBID }).video),
    free: readCond.call(readApp, mkBannerVideo({ levels: [[], [{ text: FREE_TEXT, owns: true }]] }).video),
    mix: readCond.call(readApp, mkBannerVideo({ levels: [[], [{ text: NO_DRAG_TEXT, owns: true }, { text: FREE_TEXT, owns: true }]] }).video),
    empty: readCond.call(readApp, mkBannerVideo({ levels: [[], [], []] }).video),
    notOurs: readCond.call(readApp, mkBannerVideo({ levels: [[], [{ text: NO_DRAG_TEXT }, { text: NO_DRAG_TEXT }]] }).video),
    oldShape: readCond.call(readApp, mkBannerVideo({ levels: [[], [{ text: NO_DRAG_TEXT }]] }).video),
    sameDoc: readCond.call(readApp, mkBannerVideo({ levels: [[{ text: NO_DRAG_TEXT }]] }).video),
    noDoc: readCond.call(readApp, mkBannerVideo({ noDoc: true }).video),
    throws: readCond.call(readApp, mkBannerVideo({ levels: L_FORBID, throwsAt: 1 }).video)
  };
  check('⑱ 标语口径五格分得开、每格交得出自己的读数：卡片里那句带「不可拖拽」= forbidden（hop1、marks1、text 是站点原话），'
    + '同位置没有那三个字 = silent，两枚意见不一致 = ambiguous，爬到顶层一枚都没找到 = absent（hop2 说明真爬到头了），'
    + '某一层一读就抛 = unreadable（不猜）；另三格是形状边界：两枚标语都不属于这一节**不许**当成 forbidden、'
    + '只有一枚时卡片认不出来照旧用它（老形状）、标语就在播放器自己那一层也要读到（hop0）；'
    + '压根没有文档上下文 = absent 且 marks 交 -1 —— 「数到 0 枚」与「压根没文档」是两件事',
    st18.forbid.state === 'forbidden' && st18.forbid.hop === 1 && st18.forbid.marks === 1 &&
    String(st18.forbid.text).indexOf('不可拖拽') >= 0 &&
    st18.free.state === 'silent' && st18.mix.state === 'ambiguous' &&
    st18.empty.state === 'absent' && st18.empty.hop === 2 &&
    st18.notOurs.state === 'ambiguous' && st18.oldShape.state === 'forbidden' &&
    st18.sameDoc.state === 'forbidden' && st18.sameDoc.hop === 0 &&
    st18.throws.state === 'unreadable' &&
    st18.noDoc.state === 'absent' && st18.noDoc.marks === -1,
    JSON.stringify(st18));

  // ⑱b 站点那句由两个**独立开关**现拼：fastforward 决定「不可拖拽」在不在、switchwindow 决定「不可离开…」在不在
  //     （真源 src/page/40-media.js:427-430 的注释）。夹具原先只把后半句写在 NO_DRAG_TEXT 里 ——
  //     silent 那一格**压根不含「不可离开」**，于是"把后半句也认成禁令"这类改法一步都不会红（会话任务 #198）。
  check('⑱b 站点的两个开关各管半句：`fastforward` 决定「不可拖拽」在不在、`switchwindow` 决定「不可离开…」在不在 —— '
    + '夹具自证钉住两串文本**只差前一半**（FREE_TEXT 带「不可离开」且不带「不可拖拽」、NO_DRAG_TEXT 两半都带），'
    + '行为钉住后半句**不算**拖拽禁令的证据（silent），两枚意见不一致照旧 ambiguous',
    String(FREE_TEXT).indexOf('不可离开') >= 0 && String(FREE_TEXT).indexOf('不可拖拽') < 0 &&
    String(NO_DRAG_TEXT).indexOf('不可拖拽') >= 0 && String(NO_DRAG_TEXT).indexOf('不可离开') >= 0 &&
    st18.free.state === 'silent' && st18.mix.state === 'ambiguous',
    JSON.stringify({ freeText: FREE_TEXT, forbidText: NO_DRAG_TEXT, free: st18.free.state, mix: st18.mix.state }));

  // ⑲ 站点说了不可拖拽 → 一整下发都不许写，而且不许花掉那次"试拖"的机会
  logs.length = 0;
  var a19 = mkApp(), b19 = mkBannerVideo({ src: 'gate-forbid', levels: L_FORBID });
  var v19 = b19.video, k19 = keyOf(v19);
  var r19 = seekTo(a19.app, v19, 'loadedmetadata');
  var led19 = (a19.app._seekSkipLedger || {})[k19];
  var condLogs19 = logs.filter(function (l) {
    return String(l.message || '').indexOf('site condition says not draggable') === 0;
  });
  check('⑲ 站点自己写了「不可拖拽」：`_trySeekToEnd` 当场退回、一次 `currentTime` 都不写，'
    + '而且**不登记 `_seekTriedKeys`**（那一格的意思是"我们真写过一次"，在这里花掉就等于下一轮卡片换成允许拖也不再试）、'
    + '更**不写 `_seekRevertedKeys`**（标语只许减少动手，替站点宣布"防拖拽"就是拿别人的话给自己作证，AGENTS §2 #17），'
    + '账本记 `site-no-drag`，并出一句 info **照抄站点那句话**（`reason` 留空 = 不是我们判的）',
    r19 === false && v19.__rec.writes.length === 0 &&
    !(a19.app._seekTriedKeys && a19.app._seekTriedKeys[k19]) &&
    !(a19.app._seekRevertedKeys && a19.app._seekRevertedKeys[k19]) &&
    !!led19 && led19.last === 'site-no-drag' && led19.n === 1 &&
    condLogs19.length === 1 && condLogs19[0].level === 'info' &&
    String(condLogs19[0].meta.condition).indexOf('不可拖拽') >= 0 &&
    condLogs19[0].meta.hop === 1 && condLogs19[0].meta.marks === 1 &&
    condLogs19[0].meta.reason === '',
    JSON.stringify({ ret: r19, writes: v19.__rec.writes.length, tried: !!(a19.app._seekTriedKeys || {})[k19], reverted: !!(a19.app._seekRevertedKeys || {})[k19], led: led19, logs: condLogs19 }));

  // ⑳ 其余四格 + 无上下文那一格：一律照旧拖一次，而且一句"站点说不可拖"都不许说
  logs.length = 0;
  var a20 = mkApp();
  var cases20 = [
    ['silent', mkBannerVideo({ src: 'c-silent', levels: [[], [{ text: FREE_TEXT, owns: true }]] })],
    ['ambiguous', mkBannerVideo({ src: 'c-mix', levels: [[], [{ text: NO_DRAG_TEXT, owns: true }, { text: FREE_TEXT, owns: true }]] })],
    ['absent', mkBannerVideo({ src: 'c-empty', levels: [[], [], []] })],
    ['not-ours', mkBannerVideo({ src: 'c-notours', levels: [[], [{ text: NO_DRAG_TEXT }, { text: NO_DRAG_TEXT }]] })],
    ['unreadable', mkBannerVideo({ src: 'c-throw', levels: L_FORBID, throwsAt: 1 })],
    ['no-doc', mkBannerVideo({ src: 'c-nodoc', noDoc: true })]
  ];
  var gone20 = {};
  cases20.forEach(function (c) {
    var v = c[1].video, k = keyOf(v);
    seekTo(a20.app, v, 'itest-193');
    var L = (a20.app._seekSkipLedger || {})[k];
    gone20[c[0]] = { writes: v.__rec.writes.length, tried: !!(a20.app._seekTriedKeys || {})[k], ledLast: L ? L.last : '(无)' };
  });
  var noisy20 = logs.filter(function (l) {
    return String(l.message || '').indexOf('site condition says not draggable') === 0;
  });
  check('⑳ 「读不出 / 没读到 / 不属于这一节 / 意见不一致」这四格（外加没有文档上下文那一格）一律照旧试拖一次：'
    + '写进 `currentTime`、一次性机会照旧花掉，而且**一句"站点说不可拖拽"都不许出** —— '
    + '把"没证据"实现成"站点不让拖"就是拿缺数据放行（AGENTS §2 #12/#17），'
    + '把"没证据"实现成当场下结论同样是 §2 #14 那一族',
    Object.keys(gone20).length === 6 &&
    Object.keys(gone20).every(function (n) {
      return gone20[n].writes >= 1 && gone20[n].tried === true && gone20[n].ledLast !== 'site-no-drag';
    }) && noisy20.length === 0,
    JSON.stringify({ cells: gone20, noisy: noisy20.map(function (l) { return l.message; }) }));

  // ㉑ 缓存：主循环每 1500 毫秒就进来问一次，爬文档不许变成热路径
  var a21 = mkApp(), b21 = mkBannerVideo({ src: 'c-cache', levels: L_FORBID });
  var scan1 = (siteNoDrag.call(a21.app, b21.video), b21.stat.scans);
  siteNoDrag.call(a21.app, b21.video);
  siteNoDrag.call(a21.app, b21.video);
  var scan2 = b21.stat.scans;
  nowMs += 3600000;                                  // 一小时后再问：forbidden 长期有效
  siteNoDrag.call(a21.app, b21.video);
  var scan3 = b21.stat.scans;
  var b21other = mkBannerVideo({ src: 'c-cache-2', levels: L_FORBID });
  siteNoDrag.call(a21.app, b21other.video);
  var scanOther = b21other.stat.scans;               // 换一枚另开一格，不许吃上一枚的结论
  check('㉑ 同一支媒体只爬一次文档：第二、第三次问都复用缓存（每 1500 毫秒一拍，全页扫会把这一族变成热路径）；'
    + '`forbidden` 过了 TTL 也照旧复用（站点给这一支的字段不会自己变），'
    + '但换一枚（不同 src）必须另问一次 —— 两把钥匙并成一格就是拿上一节的结论替这一节说话',
    scan1 > 0 && scan2 === scan1 && scan3 === scan1 && scanOther === scan1,
    JSON.stringify({ first: scan1, repeat: scan2, hourLater: scan3, otherMedia: scanOther }));

  // ㉒ 非 forbidden 那几格过 TTL 要重问（卡片晚半拍才长出来是常态）
  var a22 = mkApp(), b22 = mkBannerVideo({ src: 'c-ttl', levels: [[], [{ text: FREE_TEXT, owns: true }]] });
  siteNoDrag.call(a22.app, b22.video);
  var ttl1 = b22.stat.scans;
  siteNoDrag.call(a22.app, b22.video);
  var ttl2 = b22.stat.scans;
  nowMs += condTtlMs + 1;
  siteNoDrag.call(a22.app, b22.video);
  var ttl3 = b22.stat.scans;
  check('㉒ 「没证据」那一格 TTL（' + condTtlMs + ' 毫秒，从源码读回来，别抄成字面量）一过要重新问一次 —— '
    + '标语是站点 JS 现拼的，卡片晚半拍才长出来是常态；一次读不出就永久当成"这一支没有标语"，'
    + '等于把这一支唯一那条省流量的捷径悄悄关掉，而且一条日志都不留',
    ttl2 === ttl1 && ttl1 > 0 && ttl3 === ttl1 * 2,
    JSON.stringify({ ttlMs: condTtlMs, first: ttl1, within: ttl2, afterTtl: ttl3 }));

  // ㉓ 「看到 90% 就收」的第二条证据来源：站点说了不可拖拽，不必先白拖一次
  // ⚠️ 三格各用**一枚新的 app**：批次 173 起，读到 `forbidden` 那一手会顺手把课程格记上，
  //   共用一本账时后两格读到的是第一格留下的课程证据 —— 那不是"这一支自己的标语"，是串了格。
  var a23f = mkApp(), a23g = mkApp(), a23h = mkApp();
  var n23 = {
    forbid: isNinety.call(a23f.app, mkBannerVideo({ src: 'c-ninety', levels: L_FORBID }).video),
    free: isNinety.call(a23g.app, mkBannerVideo({ src: 'c-ninety-free', levels: [[], [{ text: FREE_TEXT, owns: true }]] }).video),
    none: isNinety.call(a23h.app, mkBannerVideo({ src: 'c-ninety-none', noDoc: true }).video)
  };
  var reverted23 = [a23f.app, a23g.app, a23h.app].reduce(function (n, app) {
    return n + Object.keys(app._seekRevertedKeys || {}).length;
  }, 0);
  var guardSeen23 = [a23f.app, a23g.app, a23h.app].map(function (app) {
    return String((app._courseGuard && app._courseGuard.cell && app._courseGuard.cell.seek && app._courseGuard.cell.seek.n) || 0);
  }).join('/');
  check('㉓ 「看到 90% 就收」现在有两处**独立**证据：弹回过（旧那把尺）或站点自己写了不可拖拽 —— 后者不必先白拖一次'
    + '（死键那一族：`enableSeek` 关着就永远拿不到弹回证据）；反面两格照旧 false：'
    + '标语没写那三个字、压根读不到文档，都不算证据（两格都不许替用户宣布"这一支拖不动"）。'
    + '而三枚 app 的课程格要各归各：只有第一枚攒到证据，后两枚必须是 0'
    + '（"另一枚说了"推不出"这一枚也说了" —— 课程账只在同一枚 app 内跨媒体，不许跨夹具串）',
    n23.forbid === true && n23.free === false && n23.none === false && reverted23 === 0
      && guardSeen23 === '1/0/0',
    JSON.stringify({ cells: n23, reverted: reverted23, guardSeekN: guardSeen23 }));

  // ㉔ 跨轮的记账不许被"换章节 / 换一门"的复位抹掉（批次 86 那一族）
  var stateSrc = read('src/page/10-config-state.js');
  var resetBody = bodyOf(stateSrc, '_resetRuntimeState');
  var wiped24 = ['_seekTriedKeys', '_seekRevertedKeys', '_seekSiteKeys', '_seekSkipLedger', '_seekDeferKeys', '_courseGuard']
    .filter(function (n) { return resetBody.indexOf(n) >= 0; });
  check('㉔ 六本拖拽账（含批次 173 新加的课程格）都不在 `_resetRuntimeState` 里：它们是**跨拍累积**才生效的（复位一次就把"这一支已经试过了"忘掉，'
    + '下一拍又去拽一遍，正是批次 86 那一族"看起来在勤快地跑、其实永远数不到阈值"）',
    resetBody.length > 200 && wiped24.length === 0,
    JSON.stringify({ resetLen: resetBody.length, wiped: wiped24 }));

  // ==================== ㉕–㉜ 课程级那一格（批次 173 / issue #199）====================
  // 现场要省的那一发是「真往播放器上写」：同一门课里已经认出来一次，后面每一枚就别再试。
  // 三条硬边界各有独立承重的格子：**只许减少动手**＝㉚、**不许当许可**＝㉛＋㉖ 的另一格、
  // **不许伪造读数**＝㉝ 的静态接线格；身份认不出单独占一格＝㉕（AGENTS §2 #12）。
  var COURSE_ID = 'COURSE_A|CLASS_A';
  var SAY_SEEK = 'course says not draggable, stop trying to seek to end';
  var SAY_SPEED = 'course says rate locked at 1x, stop probing player speed';
  var onlySay = function (list, msg) {
    return list.filter(function (m) { return String(m.message) === msg; });
  };

  // ㉕ 认不出是哪门课 ⇒ 恒不命中（照旧每枚各试一次）+ 单独说一句话，且这一族一个字都不写进存储
  logs.length = 0;
  var a25 = mkApp({ noCourse: true });
  var hit25 = [guardHit.call(a25.app, 'seek'), guardHit.call(a25.app, 'speed')];
  var note25 = guardNote.call(a25.app, 'seek', 'reverted');
  var warns25 = logs.filter(function (m) { return String(m.message).indexOf('course guard off') === 0; });
  guardHit.call(a25.app, 'seek'); guardHit.call(a25.app, 'speed'); guardHit.call(a25.app, 'seek');
  check('㉕ 认不出课程号（courseid／clazzid 都读不到）那一格单独占：两格恒 false、证据记不上、存储一个字节都不写，'
    + '但要说一句「课程级免拖免倍速不启用」且每小时只说一次（绝不许塌成「已经免掉了」——那是替用户宣布可以乱动）',
    guardId.call(a25.app) === '' && hit25[0] === false && hit25[1] === false && note25 === false &&
    warns25.length === 1 && String(warns25[0].level) === 'warn' &&
    Object.keys(a25.store).length === 0 && !(a25.app._courseGuard || {}).cell,
    JSON.stringify({ id: guardId.call(a25.app), hit: hit25, note: note25, warns: warns25.length, stored: Object.keys(a25.store).length }));

  // ㉖ 记满 NEED（从源码读回来）才命中；**免拖 ≠ 免倍速**，两格各算各的；TTL 一过重新允许试一枚
  logs.length = 0;
  var a26 = mkApp();
  var before26 = [guardHit.call(a26.app, 'seek'), guardHit.call(a26.app, 'speed')];
  var noted26 = guardNote.call(a26.app, 'seek', 'reverted');
  var seek26 = guardHit.call(a26.app, 'seek');
  var speed26 = guardHit.call(a26.app, 'speed');
  var says26 = onlySay(logs, SAY_SEEK).length + onlySay(logs, SAY_SPEED).length;
  var keep26 = nowMs; nowMs += guardTtl + 1;
  var expired26 = [guardHit.call(a26.app, 'seek'), guardHit.call(a26.app, 'speed')];
  nowMs = keep26;
  check('㉖ 没记过两格都 false；记一笔 seek（NEED=' + guardNeed + '，从源码读回来）只有 seek 命中，'
    + 'speed 照旧不命中（「这一门课拖不动」推不出「这一门课锁 1x」，同一门课别枚说的也不是这一枚）；'
    + '攒满那一格只喊一句话；TTL（' + guardTtl + ' 毫秒，同样从源码读回来）一过两格都回到 false —— 少动手不等于永不试',
    guardId.call(a26.app) === COURSE_ID && before26[0] === false && before26[1] === false &&
    noted26 === true && seek26 === true && speed26 === false && says26 === 1 &&
    expired26[0] === false && expired26[1] === false,
    JSON.stringify({ id: guardId.call(a26.app), before: before26, seek: seek26, speed: speed26, says: says26, afterTtl: expired26 }));

  // ㉗ 拿到反证（这一门课其实拖得动）要当场撤销，且「喊过没有」那本账一起归零 —— 下次再攒满还得再喊
  logs.length = 0;
  var a27 = mkApp();
  guardNote.call(a27.app, 'seek', 'reverted');
  var cleared27 = guardClear.call(a27.app, 'seek', 'drag-ok');
  var hit27 = guardHit.call(a27.app, 'seek');
  var clearEmpty27 = guardClear.call(a27.app, 'seek', 'drag-ok');
  guardNote.call(a27.app, 'seek', 'reverted');
  var says27 = onlySay(logs, SAY_SEEK);
  var cell27 = ((a27.app._courseGuard || {}).cell || {}).seek || {};
  check('㉗ 真拖成功 = 正面证据 ⇒ 当场撤销（n 归零、命中回到 false、没账时撤销本身返回 false），'
    + '来源历史留着（谁攒到的、被谁撤掉的都要读得回来）；撤销后 said 那本账归零，再攒满要能**再喊一次**'
    + '（喊过就不说 = 第二枚起现场又变哑）',
    cleared27 === true && hit27 === false && clearEmpty27 === false &&
    says27.length === 2 && Number(cell27.n) === 1 &&
    String((cell27.srcs || []).join(',')) === 'reverted,clear:drag-ok',
    JSON.stringify({ cleared: cleared27, hit: hit27, clearEmpty: clearEmpty27, says: says27.length, n: cell27.n, srcs: (cell27.srcs || []).join(',') }));

  // ㉘ 存储：**整份**写回（只写改过那一格 = 把另一格抹掉）＋ 跨页存活 ＋ 换课不带旧账（AGENTS §2 #25）
  logs.length = 0;
  var a28 = mkApp();
  guardNote.call(a28.app, 'seek', 'reverted');
  guardNote.call(a28.app, 'speed', 'measured-1x');
  var raw28 = a28.store[guardLedgerKey] ? JSON.parse(a28.store[guardLedgerKey]) : null;
  var a28b = mkApp({ store: a28.store });
  var reloaded28 = [guardHit.call(a28b.app, 'seek'), guardHit.call(a28b.app, 'speed')];
  var a28c = mkApp({ store: a28.store, course: 'COURSE_B' });
  var other28 = [guardHit.call(a28c.app, 'seek'), guardHit.call(a28c.app, 'speed')];
  check('㉘ 写存储的是**整份** {course,seek,speed,ttl}：第二笔记进去时第一格还在（不补账就盖 = 拿内存里的空账删掉盘上的旧账）；'
    + '换页（内存账是空的、存储同一枚）两格都读得回来；换一门课两格都读不到（旧课的账不许带进新课）',
    !!raw28 && raw28.course === COURSE_ID && Number((raw28.seek || {}).n) === 1 && Number((raw28.speed || {}).n) === 1 &&
    Number(raw28.ttl) === guardTtl && reloaded28[0] === true && reloaded28[1] === true &&
    other28[0] === false && other28[1] === false,
    JSON.stringify({ raw: raw28 && { c: raw28.course, s: raw28.seek && raw28.seek.n, p: raw28.speed && raw28.speed.n, t: raw28.ttl }, reloaded: reloaded28, other: other28 }));

  // ㉙ 「这一枚为什么不再试拖」三条来源各占一格，顺序＝行为证据 → 声明证据 → 课程策略（压成两态就归错因）
  var a29 = mkApp();
  var v29 = mkVideo({ duration: DUR, ranges: [[0, DUR]] }), k29 = keyOf(v29);
  var s29none = guardSource.call(a29.app, v29);
  a29.app._seekRevertedKeys = {}; a29.app._seekRevertedKeys[k29] = true;
  guardNote.call(a29.app, 'seek', 'reverted');
  var s29rev = guardSource.call(a29.app, v29);
  delete a29.app._seekRevertedKeys[k29];
  var s29course = guardSource.call(a29.app, v29);
  var s29novideo = guardSource.call(a29.app, null);
  var v29b = mkBannerVideo({ src: 'c-banner-29', levels: L_FORBID }).video;
  var s29banner = guardSource.call(mkApp().app, v29b);
  check('㉙ `_seekNoDragSource` 四格分得开：无证据交空串、弹回过＝reverted（同一枚既弹回又有课程账时点名**行为**那一条，'
    + '别把最硬的那条让给策略）、只有课程账＝course、站点写了不可拖拽＝banner；没有元素时只剩课程那一格可读',
    s29none === '' && s29rev === 'reverted' && s29course === 'course' && s29novideo === 'course' && s29banner === 'banner',
    JSON.stringify({ none: s29none, reverted: s29rev, course: s29course, noVideo: s29novideo, banner: s29banner }));

  // ㉚ 只许减少动手：命中课程格那一拍，进度条一个字节都不写、一次性机会不花，但要落进 skip 账并说话
  var a30 = mkApp();
  guardNote.call(a30.app, 'seek', 'reverted');
  var v30 = mkVideo({ duration: DUR, ranges: [[0, DUR]] }), k30 = keyOf(v30);
  logs.length = 0;
  var r30 = seekTo(a30.app, v30, 'guard');
  var s30 = a30.app._seekSkipLedger && a30.app._seekSkipLedger[k30];
  var a30b = mkApp();
  var v30b = mkVideo({ duration: DUR, ranges: [[0, DUR]] }), k30b = keyOf(v30b);
  logs.length = 0;
  seekTo(a30b.app, v30b, 'guard');
  var writes30b = v30b.__rec.writes.length;
  check('㉚ 命中课程格 = 这一拍**一个字节都不写**（currentTime 没被碰）、一次性机会不花掉（tried 不登记）、更不替站点宣布弹回（reverted 不写），'
    + '但按这一支的钥匙落进 skip 账（reason 点名 course-no-drag）且出一句话；反面格：没有课程账的同一形状照旧真拖一次',
    r30 === false && v30.__rec.writes.length === 0 && !a30.app._seekTriedKeys[k30] &&
    !(a30.app._seekRevertedKeys || {})[k30] &&
    !!s30 && s30.last === 'course-no-drag' && s30.reasons['course-no-drag'] === 1 && logs.length > 0 &&
    writes30b === 1,
    JSON.stringify({ ret: r30, writes: v30.__rec.writes.length, tried: !!(a30.app._seekTriedKeys || {})[k30],
      reverted: !!(a30.app._seekRevertedKeys || {})[k30], skip: s30 || null, logs: logs.length, writesNoGuard: writes30b }));

  // ㉛ 「看到 90% 就收」的倍速前提现在也认课程格，而两格各管各的（只有倍速账 → 仍不收）
  var a31 = mkApp();
  a31.app._isRateLockedAtOne = function () { return false; };  // 前提钉住：这一枚自己没量到 1x
  var v31 = mkVideo({ duration: DUR, ranges: [[0, DUR]] }), k31 = keyOf(v31);
  var n31none = isNinety.call(a31.app, v31);
  guardNote.call(a31.app, 'speed', 'measured-1x');
  var n31speedOnly = isNinety.call(a31.app, v31);
  guardNote.call(a31.app, 'seek', 'reverted');
  var n31both = isNinety.call(a31.app, v31);
  var n31seekOnlyApp = mkApp();
  n31seekOnlyApp.app._isRateLockedAtOne = function () { return false; };
  guardNote.call(n31seekOnlyApp.app, 'seek', 'reverted');
  var n31seekOnly = isNinety.call(n31seekOnlyApp.app, mkVideo({ duration: DUR, ranges: [[0, DUR]] }));
  // 同一问法要落到「这条路被放弃了」那一句上：倍速那一侧只有课程账时这句话仍要说得出口，
  // 只有拖账（倍速没证据）时一声不出 —— 少了这两格，`_noteNinetyHeldBack` 里那一问就没有证人。
  var v31c = mkVideo({ duration: DUR, current: Math.round(DUR * 0.93), ranges: [[0, DUR]] });
  var held31speed = noteHeld22.call(a31.app, v31c);
  var v31d = mkVideo({ duration: DUR, current: Math.round(DUR * 0.93), ranges: [[0, DUR]] });
  var held31seekOnly = noteHeld22.call(n31seekOnlyApp.app, v31d);
  check('㉛ 提前收尾要「倍速锁 1x」+「拖不动」两条都有证据：课程格可以分别顶上这两处（同一门课别枚量到的），'
    + '但**两格不许互相顶** —— 只有倍速账、拖那一侧三条证据都没有 → false；只有拖账、倍速那条没证据 → 照旧 false；'
    + '而「这条路被放弃了」那一句同样认课程账（只有倍速账时说得出口，只有拖账时一声不出）',
    n31none === false && n31speedOnly === false && n31both === true && n31seekOnly === false &&
    !((n31seekOnlyApp.app._courseGuard || {}).cell || {}).speed &&
    held31speed === true && held31seekOnly === false,
    JSON.stringify({ none: n31none, speedOnly: n31speedOnly, both: n31both, seekOnly: n31seekOnly,
      heldSpeed: held31speed, heldSeekOnly: held31seekOnly }));

  // ㉜ 因为课程格而没问倍速的那一枚：每门课每格只说一次，且**不许**抢「问不出」那句
  // ⚠️ 「有账」那一格用**换页后的第二枚 app**（同一本存储、新的内存）：
  //   在刚记上账的那枚 app 上问，`said.speed` 已被 `_noteCourseGuard` 自己喊掉了，
  //   那一格量到的是「说过就不再说是纪律」，而不是「换一枚媒体还说不说得出这句」—— 现场要的是后者。
  logs.length = 0;
  var a32 = mkApp();
  var hit32none = guardHit.call(a32.app, 'speed');           // 生产里先问这一句（`_detectMaxPlaybackRate` 那一发）
  var said32none = guardRateSkip.call(a32.app);
  var logsAfterNone = logs.length;
  var h32 = mkApp();
  guardNote.call(h32.app, 'speed', 'measured-1x');
  var p32 = mkApp({ store: h32.store });
  logs.length = 0;
  var hit32 = guardHit.call(p32.app, 'speed');
  var said32 = guardRateSkip.call(p32.app);
  var said32again = guardRateSkip.call(p32.app);
  var says32 = onlySay(logs, SAY_SPEED);
  var said32onHome = (function () {
    logs.length = 0;
    var again = guardRateSkip.call(h32.app);       // 记账那一枚自己：已经喊过，第二次不许再喊
    var n = onlySay(logs, SAY_SPEED).length;
    logs.length = 0;
    return { again: again, says: n };
  })();
  check('㉜ 没有课程账时 `_noteCourseGuardRateSkipped` 一句不出、一个字节都不写（「问不出」与「同一门课不必再问」是两格，后者不许冒领前者）；'
    + '换一枚媒体（新内存、同一本存储）时先问得到命中，再说出课程那句、点名 from=menu-unreadable 与课程号；'
    + '而同一门课同一格**只喊一次** —— 第二枚问第二次、以及记账那一枚自己再问，都必须返回 false 且一个字不出',
    hit32none === false && said32none === false && logsAfterNone === 0
      && hit32 === true && said32 === true && said32again === false &&
    says32.length === 1 && says32[0].meta && says32[0].meta.from === 'menu-unreadable' &&
    says32[0].meta.course === COURSE_ID && said32onHome.again === false && said32onHome.says === 0,
    JSON.stringify({ hitNone: hit32none, none: said32none, logsNone: logsAfterNone, hit: hit32,
      said: said32, again: said32again, says: says32, home: said32onHome }));

  // ㉝ 接线与「不伪造读数」（静态格）：问价那一族命中课程格要**早于**真写播放器那一发，且交回的是 0（不知道）不是 1
  var rateBody = bodyOf(media, '_detectMaxPlaybackRate');
  var guardAt = rateBody.indexOf("this._courseGuardHit('speed')");
  var tryAt = rateBody.indexOf('this._tryRateOnce(');
  // ⚠️ 从**那一问之后**找：方法体开头的 `if (!video) return 0;` 也在同一句里，从头找会先撞上它，
  //   于是 `zeroAt < guardAt` 把一次合法的接线读成"没接线"（本轮实测撞过：zeroAt:43 / guardAt:778）。
  var zeroAt = guardAt < 0 ? -1 : rateBody.indexOf('return 0;', guardAt);
  var seekBack = bodyOf(media, '_trySeekToEnd');
  // ⚠️ 那两发在 `verifySeek` 里，而 `verifySeek` 是闭包、拿的是外层 `self`（不是 `this`）——
  //   按 `this.` 去锚两处都取不到，报出来像"生产里忘了接线"（本轮实测撞过）。
  var clearOkAt = seekBack.indexOf("self._clearCourseGuard('seek', 'drag-ok')");
  var noteRevAt = seekBack.indexOf("self._noteCourseGuard('seek', 'reverted')");
  // 「不许伪造读数」那一半的尺：真正把倍速落到播放器上的那两把，只认 `_detectedMaxRate`（量到的读数），
  // 不读课程格 —— 课程格是「别再问」的策略，写成这里的一问就等于替这一支伪造一次测量。
  var targetBody = bodyOf(media, '_getTargetPlaybackRate');
  var ensureBody = bodyOf(media, '_ensurePlaybackRate');
  var rateCheck = targetBody + ensureBody;
  check('㉝ 接线（声明覆盖的范围与实际走的分支之间的差不会自己喊出来 —— §2 #18）：课程格那一问排在**真写播放器**那一发之前，'
    + '命中时交回的是 0=「不知道」（写 1 就是替这支视频伪造一次测量，`_detectedMaxRate` 必须保持诚实）；'
    + '弹回记 course / 拖成功撤 course 两处都在 `verifySeek` 里（那一族在闭包里，只能经 `self.`）；'
    + '而落档那两把尺（`_getTargetPlaybackRate` + `_ensurePlaybackRate`）一个字都不读课程格',
    rateBody.length > 200 && seekBack.length > 400 && targetBody.length > 100 && ensureBody.length > 100 &&
    guardAt > 0 && tryAt > 0 && guardAt < tryAt &&
    zeroAt > guardAt && zeroAt < tryAt && /return\s+0\s*;/.test(rateBody.slice(guardAt, tryAt)) &&
    clearOkAt > 0 && noteRevAt > 0 && rateCheck.indexOf('_courseGuardHit') < 0,
    JSON.stringify({ rateLen: rateBody.length, seekLen: seekBack.length, targetLen: targetBody.length,
      ensureLen: ensureBody.length, guardAt: guardAt, tryAt: tryAt, zeroAt: zeroAt,
      clearOkAt: clearOkAt, noteRevAt: noteRevAt, checkHasGuard: rateCheck.indexOf('_courseGuardHit') >= 0 }));

  // ㉞ 钥匙归一（会话任务 #231 第 1 档）：站点按**播放会话**现签媒体地址（`?at_=<签发毫秒>&ak_=&ad_=`），
  //   重签名与换清晰度都会换写法，而这把钥匙喂的是「这一支试过没有」那六本账 —— 键一换写法 =
  //   每支的一次性试拖预算翻倍花，量到的「站点把进度条拽回去」也读不回来（AGENTS §2 #17）。
  //   ⚠️ 这一族跑在 node 里：`location` 恒不存在，所以「相对地址」那一格量的是**退回原串**这个兜底，
  //   浏览器的绝对化由 [30] 之外的真实页面负责 —— 别拿 node 的读数冒充浏览器那一格。
  var sigA = 'https://s2.cldisk.com/sv-1/video/abcd1234/sd.mp4?at_=1790000000000&ak_=aaa&ad_=bbb';
  var sigB = 'https://s2.cldisk.com/sv-1/video/abcd1234/sd.mp4?at_=1790000099999&ak_=zzz&ad_=yyy';
  var kA = getKey.call(keyCtx, { currentSrc: sigA });
  var kB = getKey.call(keyCtx, { currentSrc: sigB });
  var kHash = getKey.call(keyCtx, { currentSrc: 'https://s2.cldisk.com/sv-1/video/abcd1234/sd.mp4#t=120' });
  var kRel = getKey.call(keyCtx, { currentSrc: '/ananas/modules/video/index.html' });
  var kBlob = getKey.call(keyCtx, { currentSrc: 'blob:null/6f6a1c2d-0000-0000-0000-000000000001' });
  var kNoSrc = getKey.call(keyCtx, { currentSrc: '', src: '' });
  var kJob = getKey.call({ _mediaStablePath: stablePath, _activeJobId: 'job-7' }, {});
  check('㉞ 钥匙只认稳定段：同一支视频换签名、换 `#` 片段都必须是同一把钥匙（否则每支的一次性预算翻倍花）；'
    + '相对地址与 blob 各交回非空（blob 是补救换源留下的身份，切查询串治不了它 —— 那是第 2 档，本轮只钉住现状防漂移）；'
    + '「读不到地址」与「有作业号」两格各占各的：无地址又无作业号才交空串，有作业号退回 `job:` 而不是塌进空串（§2 #12）',
    kA === kB && kA === 'https://s2.cldisk.com/sv-1/video/abcd1234/sd.mp4' && kHash === kA &&
      kRel === '/ananas/modules/video/index.html' &&
      kBlob === 'blob:null/6f6a1c2d-0000-0000-0000-000000000001' &&
      kNoSrc === '' && kJob === 'job:job-7',
    JSON.stringify({ kA: kA, kB: kB, kHash: kHash, kRel: kRel, kBlob: kBlob, kNoSrc: kNoSrc, kJob: kJob }));

  // ㊱ 媒体钥匙 · 按**元素**记 blob 身份（会话任务 #231 第 2 档）：补救重载会给同一枚 `<video>` 挂一条
  //   新的 `blob:` 地址，第 1 档那把尺治不了它 —— 换的是整条路径，不是查询串。键一换 = 八本账从 0 数 =
  //   每支的一次性试拖预算按换源次数翻倍花（AGENTS §2 #17）。
  //   ⚠️ 两条各钉一个方向：㊱ 钉「同一枚不换号」（退回「每次现算」会红在这里），
  //      ㊲ 钉「不同元素各算各的」（实现成「见过任意 blob 就交回第一把」会红在㊲）—— 少任何一条都是半截尺。
  var elSame = { currentSrc: 'blob:null/aaaaaaaa-0000-0000-0000-000000000001' };
  var kBlobFirst = getKey.call(keyCtx, elSame);
  elSame.currentSrc = 'blob:null/bbbbbbbb-0000-0000-0000-000000000002';
  var kBlobAfter = getKey.call(keyCtx, elSame);
  var elOther = { currentSrc: 'blob:null/cccccccc-0000-0000-0000-000000000003' };
  var kBlobOther = getKey.call(keyCtx, elOther);
  check('㊱ 媒体钥匙 · 同一枚元素换 `blob:` 源不换号：补救重载后地址变了钥匙仍是第一次那把（否则八本账从 0 数、'
    + '一次性试拖预算按换源次数翻倍花）；第一次仍交回这条 blob 地址本身，不发明新编号（㉞ 的 blob 格照旧）',
    kBlobFirst === 'blob:null/aaaaaaaa-0000-0000-0000-000000000001' && kBlobAfter === kBlobFirst,
    JSON.stringify({ kBlobFirst: kBlobFirst, kBlobAfter: kBlobAfter }));
  check('㊲ 媒体钥匙 · 不同元素各算各的：两枚元素各喂一条 blob 时两把钥匙不相等（身份按元素、不按 src 前缀；'
    + '否则两支视频被并成一支，一支试过拖另一支就永不试，而标语与试拖账都读不出是谁的）',
    kBlobOther === 'blob:null/cccccccc-0000-0000-0000-000000000003' && kBlobOther !== kBlobFirst,
    JSON.stringify({ kBlobFirst: kBlobFirst, kBlobOther: kBlobOther }));

  // ㉟ 反分叉（第 30 项「掩码只许有一份」同一族）：稳定段只许由 `_mediaStablePath` 一处算。
  //   两处各自切一次，就能各自切错一次（少切 `#` / 把 blob 切成空），而**不报错、不留日志**，
  //   只是那六本账又回到按签名起账 —— 与改之前症状逐字相同，最难查的一类。
  var keyBody = bodyOf(media, '_getMediaSeekKey');
  var mimeBody = bodyOf(media, '_guessMediaMime');
  var pathCallers = ['_getMediaSeekKey', '_guessMediaMime']
    .filter(function (n) { return bodyOf(media, n).indexOf('this._mediaStablePath(') >= 0; });
  var rawCuts = [keyBody, mimeBody].filter(function (b) {
    return /\.split\(\s*['"]\?/.test(b) || /\.indexOf\(\s*['"]\?/.test(b) || /\.slice\([^)]*\?/.test(b) || /search\(\s*['"]\?/.test(b);
  }).length;
  check('㉟ 归一只有一份口径：`_getMediaSeekKey` 与 `_guessMediaMime` 两处都真经 `this._mediaStablePath(`，'
    + '且两个方法体里都留着不下一把自切的切查询串（各自切一次就能各自切错一次，且不报错只让账回到按签名起账）',
    keyBody.length > 50 && mimeBody.length > 50 && pathCallers.length === 2 && rawCuts === 0,
    JSON.stringify({ keyLen: keyBody.length, mimeLen: mimeBody.length, callers: pathCallers, rawCuts: rawCuts }));

  // ㊷ `_mediaReloadKeys` 加上限（会话任务 #231 第 3a 档）：重载**次数**有上限、**钥匙**没有 ——
  //   一节课几百支视频，每支换过一次源就留一格，这本账只会长。裁到 300 条且**只清最旧**：
  //   整本清空等于把所有媒体的重试计数抹回 0，`MEDIA_RELOAD_LIMIT` 那道三次闸结构上永远数不到顶
  //   （AGENTS §2 #13「跨轮记账不许被同一轮动作清零」）。
  //   ⚠️ 一次调用只许动被传进来那一本：`_seekRevertedKeys` 是「站点把进度条拽回去」的行为证据，
  //      被连坐抹掉就等于替每支视频重新发一次一次性试拖预算（§2 #17）—— 邻居账那一格就是钉这一条的。
  //      圈号跳开 ㊳–㊶：那四个别的段已占着，同名会让反向验证按断言名 needle 时分不清红在哪一段。
  var evict = buildFrom(media, '_evictOldestKeys', {});
  var ledgerCtx = {
    _mediaReloadKeys: {
      r1: { at: 1, n: 1, resumeAt: 0 },
      r2: { at: 2, n: 1, resumeAt: 0 },
      r3: { at: 3, n: 2, resumeAt: 0 },
      r4: { at: 4, n: 1, resumeAt: 0 },
      r5: { at: 5, n: 3, resumeAt: 0 }
    },
    _seekRevertedKeys: { 'https://s/x/a.mp4': true },
    _seekTriedKeys: { 'https://s/x/b.mp4': true },
    _seekSiteKeys: { 'https://s/x/c.mp4': { state: 'silent', at: 9 } }
  };
  var dropped = evict ? evict.call(ledgerCtx, ledgerCtx._mediaReloadKeys, 3) : -1;
  var leftReload = Object.keys(ledgerCtx._mediaReloadKeys).sort();
  var neighboursKept = ['_seekRevertedKeys', '_seekTriedKeys', '_seekSiteKeys'].every(function (n) {
    return Object.keys(ledgerCtx[n] || {}).length === 1;
  });
  // 「真的接在写入点后面」+「那个上限只有一份」：这两格从**源码文本**读回来，
  //   否则助手挂在 app 上却没人调、或别处又抄一份 300，运行时那三格照样全绿。
  var reloadBody = bodyOf(media, '_reloadMediaInPlace');
  var wiredAt = reloadBody.indexOf('this._evictOldestKeys(this._mediaReloadKeys,');
  var prodCap = firstNum(reloadBody, /_evictOldestKeys\(\s*this\._mediaReloadKeys\s*,\s*(\d+)\s*\)/);
  var writeAt = reloadBody.indexOf('this._mediaReloadKeys[key] =');
  var capSingles = (media.match(/_evictOldestKeys\(\s*this\._mediaReloadKeys\s*,\s*(\d+)/g) || []).length;
  // 没 `at` 的条目按 0 算（最旧先删），而不是抛、也不是当成最新留下
  var oddMap = { a: {}, b: { at: 7 }, c: { at: 8 } };
  var oddDrop = evict ? evict.call({}, oddMap, 2) : -1;
  check('㊷ 重载账裁到上限且只清最旧：5 条（at=1..5）配 cap=3，交回删除数 2 且留下 at=3/4/5（整本清空会红在这里）；'
    + '同一次调用之后 `_seekRevertedKeys`/`_seekTriedKeys`/`_seekSiteKeys` 三本邻居各还剩 1 条（连坐清掉会红在这里）；'
    + '没有 `at` 的条目按 0 算最旧先删（交回 1、只剩 at=7/8）；'
    + '写入点那一发接在 `_mediaReloadKeys[key] =` **之后**、上限从源码读回来是 300 且全文件只此一处',
    dropped === 2 && leftReload.join(',') === 'r3,r4,r5' && neighboursKept &&
      oddDrop === 1 && Object.keys(oddMap).sort().join(',') === 'b,c' &&
      wiredAt > 0 && writeAt > 0 && wiredAt > writeAt && prodCap === 300 && capSingles === 1,
    JSON.stringify({ dropped: dropped, leftReload: leftReload, neighboursKept: neighboursKept,
      oddDrop: oddDrop, oddLeft: Object.keys(oddMap), wiredAt: wiredAt, writeAt: writeAt,
      prodCap: prodCap, capSingles: capSingles }));

  // ㊸ 第 3b 档的**行为面**：真走一次写入点（`_noteSeekSkip`），而不是只调助手 ——
  //   305 条账塞进去后裁回整 300 条，掉的必须是**最旧那 6 条**（k1..k6）；k7／k305／新钥匙都在，
  //   「整本抹平」会红在 k7 这一格。同一次调用之后 `_seekRevertedKeys` 那一格不许动（§2 #17）。
  var noteSeek = buildFrom(media, '_noteSeekSkip', {});
  var bigLedger = {};
  for (var bi = 1; bi <= 305; bi++) bigLedger['k' + bi] = { n: 1, at: bi, first: bi, reasons: {} };
  var bigCtx = { _seekSkipLedger: bigLedger, _seekRevertedKeys: { 'https://s/x/keep.mp4': true }, _evictOldestKeys: evict };
  var stBig = noteSeek ? noteSeek.call(bigCtx, 'captcha',
    { duration: 12.34, currentSrc: 'https://s/x/new.mp4' }, 'https://s/x/new.mp4') : null;
  var bigLeft = Object.keys(bigCtx._seekSkipLedger);
  var oldestGone = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].every(function (n) { return !bigCtx._seekSkipLedger[n]; });
  var newestKept = !!bigCtx._seekSkipLedger.k7 && !!bigCtx._seekSkipLedger.k305 &&
    !!bigCtx._seekSkipLedger['https://s/x/new.mp4'];
  var revKept = Object.keys(bigCtx._seekRevertedKeys).length === 1 &&
    bigCtx._seekRevertedKeys['https://s/x/keep.mp4'] === true;
  check('㊸ 真触发一次写入（305 条账过 `_noteSeekSkip`）：裁回整 300 条、最旧 k1..k6 不在，而 k7/k305/新钥匙都在（整本抹平会红在 k7 这一格）；'
    + '新那格带着自己的账（n=1／last=captcha）；同一次调用之后 `_seekRevertedKeys` 仍是那 1 格 true（助手连坐清邻居会红在这里）',
    bigLeft.length === 300 && oldestGone && newestKept && revKept &&
      !!stBig && stBig.n === 1 && stBig.last === 'captcha',
    JSON.stringify({ left: bigLeft.length, oldestGone: oldestGone, newestKept: newestKept,
      revKept: revKept, st: stBig ? { n: stBig.n, last: stBig.last } : null }));
}

/** ---- [22b] 批次 178：开头一直卡住时，有界地去点站点自己的「开始」键 ----
 * 形状来自 2026-11-19 现场只读实测（`top > iframe#iframe > f0` 的
 * `/ananas/modules/video/index.html`，播放器 video.js v7）：
 * 「开始」有两枚 —— 中央层 `button.vjs-big-play-button`（文字「播放视频」，**在播时 display:none**）
 * 与控制条 `button.vjs-play-control`（**在播时带 `vjs-playing` 类、文字「暂停」**）。
 * 同一个容器里还躺着 `vjs-default-button`（「重启 恢复全部设定至预设值」）与 `vjs-playback-rate`（倍速菜单）——
 * 误点前者会把用户的播放器设定清掉，误点在播的切换键等于按停视频。
 *
 * ⚠️ 本段的 `visible` 是**注入的替身**（`__vis !== false`），它只钉「选中哪一枚 + 有界 + 说话」；
 *    `display:none` 在真引擎里到底读不读得出来，由 e2e `/media-start` 那一场景钉
 *    （名字里不许承诺它没测的东西 —— AGENTS §5）。
 */
async function testStartStuckSiteClickSelfHeal() {
  console.log('\n[22b] 开头卡住自愈：有界点一下站点的开始键，认不出与烧完都要说话（批次 178）');

  var media = fs.readFileSync(path.join(ROOT, 'src/page/40-media.js'), 'utf8').replace(/\r\n/g, '\n');
  var state = fs.readFileSync(path.join(ROOT, 'src/page/10-config-state.js'), 'utf8').replace(/\r\n/g, '\n');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  var firstNum = function (src, re) {
    var m = src.match(re);
    return m ? Number(m[1]) : null;
  };

  var nudgeBody = bodyOf(media, '_nudgeSiteStartControl');
  var siteBody = bodyOf(media, '_siteStartControlOf');
  var resumeBody = bodyOf(media, '_tryResumePlayback');
  // 四个预算从源码读回来，别抄成测试里的字面量（改了生产数而断言照旧 = 假绿）
  var capClicks = firstNum(nudgeBody, /done >= (\d+)/);
  var spacingMs = firstNum(nudgeBody, /- \(Number\(prev\.at\) \|\| 0\) < (\d+)/);
  var ctHard = firstNum(nudgeBody, /if \(ct > ([\d.]+)\) return false/);
  var ctRatio = firstNum(nudgeBody, /dur \* ([\d.]+)\)\) return false/);
  var rungAt = firstNum(resumeBody, /_resumeAttemptCount >= (\d+)/);

  check('⓪ 三件都能从 40-media.js 原样取出来真跑，四个预算与接进的档位也读得回来' +
    '（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    capClicks > 0 && spacingMs > 0 && ctHard > 0 && ctRatio > 0 && rungAt > 0,
    JSON.stringify({ cap: capClicks, spacing: spacingMs, ctHard: ctHard, ctRatio: ctRatio, rungAt: rungAt }));
  if (!(capClicks > 0 && spacingMs > 0 && ctHard > 0 && ctRatio > 0 && rungAt > 0)) return;

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: String(message || ''), meta: meta }); };
  var nowMs = 1700000000000;
  var FakeDate = { now: function () { return nowMs; } };
  var fakeVisible = function (el) { return !!el && el.__vis !== false; };
  var inj = { emitRuntimeLog: say, Date: FakeDate, visible: fakeVisible };

  var giveupTtl = readProductConstant(fs.readFileSync(path.join(ROOT, 'src/page/00-shell-constants.js'), 'utf8'), 'TASK_GIVEUP_TTL_MS');
  var getKey = buildFrom(media, '_getMediaSeekKey', {});
  // 假 app 少挂这一件，`this._mediaStablePath` 就是 TypeError —— 整段一条断言都不跑（AGENTS §5）
  var stablePath = buildFrom(media, '_mediaStablePath', {});
  var siteOf = buildFrom(media, '_siteStartControlOf', { visible: fakeVisible });
  var nudge = buildFrom(media, '_nudgeSiteStartControl', inj);
  // #231 第 3b 档：`_nudgeSiteStartControl` 满了改成只清最旧 → 这一段的假 app 也得带助手本体
  var evictB = buildFrom(media, '_evictOldestKeys', {});
  var quarantined = buildFrom(media, '_isMediaQuarantined', { Date: FakeDate, TASK_GIVEUP_TTL_MS: giveupTtl });
  check('⓪ `_getMediaSeekKey` / `_mediaStablePath` / `_siteStartControlOf` / `_nudgeSiteStartControl` 四件本体都取成了函数',
    [getKey, stablePath, siteOf, nudge].every(function (f) { return typeof f === 'function'; }),
    JSON.stringify({ key: typeof getKey, stable: typeof stablePath, siteOf: typeof siteOf, nudge: typeof nudge }));
  if (!getKey || !stablePath || !siteOf || !nudge) return;

  // 现场那副容器：开始键 + 三枚绝不能碰的邻居，一起放在同一个 host 里
  function mkShape(opt) {
    opt = opt || {};
    var rec = { clicks: [] };
    function b(cls, label, vis) {
      return {
        className: cls, textContent: label, __vis: vis !== false,
        click: function () { rec.clicks.push(cls.split(' ')[0]); }
      };
    }
    rec.big = b('vjs-big-play-button', '播放视频', opt.bigVisible !== false);
    rec.toggle = b(opt.togglePlaying === false
      ? 'vjs-play-control vjs-control vjs-button'
      : 'vjs-play-control vjs-control vjs-button vjs-playing',
      opt.togglePlaying === false ? '播放' : '暂停', opt.toggleVisible !== false);
    rec.restart = b('vjs-default-button', '重启 恢复全部设定至预设值', true);
    rec.rate = b('vjs-playback-rate', '倍速', true);
    var host = {
      querySelector: function (sel) {
        if (sel === '.vjs-big-play-button') return opt.noBig ? null : rec.big;
        if (sel === '.vjs-play-control') return opt.noToggle ? null : rec.toggle;
        return null;
      }
    };
    rec.video = {
      tagName: opt.tagName || 'VIDEO',
      currentSrc: opt.src === '' ? '' : 'https://ananas.chaoxing.com/video/910000001/at_1700000000000.mp4',
      currentTime: opt.ct == null ? 0 : opt.ct,
      duration: opt.dur == null ? 1200 : opt.dur,
      readyState: opt.ready == null ? 0 : opt.ready,
      paused: opt.paused !== false,
      error: null,
      closest: function () { return opt.noHost ? null : host; },
      ownerDocument: { querySelector: function () { return null; } }
    };
    return rec;
  }
  function mkApp(shape) {
    var app = {
      configs: {}, _isPlaying: true, _startNudgeKeys: null, _activeJobId: '',
      __quizBlocks: false
    };
    app._mediaQuarantine = null;
    app._mediaReloadKeys = null;
    app._getMediaSeekKey = function (v) { return getKey.call(app, v); };
    app._mediaStablePath = function (u) { return stablePath.call(app, u); };
    app._isMediaQuarantined = function (v) { return quarantined.call(app, v); };
    app._popupQuizBlocksPlayback = function () { return app.__quizBlocks === true; };
    app._siteStartControlOf = function (v) { return siteOf.call(app, v); };
    app._evictOldestKeys = function (m, c) { return evictB.call(app, m, c); };
    app._nudgeSiteStartControl = function (v, r) { return nudge.call(app, v, r); };
    return app;
  }
  function spoke(prefix) {
    return logs.filter(function (m) { return m.message.indexOf(prefix) === 0; });
  }

  var s1 = mkShape({});
  var a1 = mkApp(s1);
  var pick = a1._siteStartControlOf(s1.video);
  check('① 认得出的只有那两枚：中央层在（未开播）就点它，绝不点同一容器里的「重启 恢复全部设定至预设值」与倍速菜单',
    !!pick && pick.rung === 'big-play' && pick.el === s1.big,
    JSON.stringify({ rung: pick && pick.rung, isBig: !!(pick && pick.el === s1.big) }));

  var s2 = mkShape({ bigVisible: false, togglePlaying: true });
  var a2 = mkApp(s2);
  var pickPlaying = a2._siteStartControlOf(s2.video);
  logs.length = 0;
  var nudgePlaying = a2._nudgeSiteStartControl(s2.video, 'paused');
  check('② 正在播的时候一枚都不许点 —— 控制条那枚此刻带 `vjs-playing`、文字是「暂停」，' +
    '点下去就是替人把视频按停；中央层已经收起来了也不许当成"还能点"',
    pickPlaying === null && nudgePlaying === false && s2.clicks.length === 0,
    JSON.stringify({ pick: pickPlaying, ret: nudgePlaying, clicks: s2.clicks }));

  var s3 = mkShape({ bigVisible: false, togglePlaying: false });
  var a3 = mkApp(s3);
  var pickToggle = a3._siteStartControlOf(s3.video);
  check('③ 中央层收起、控制条写「播放」（暂停态）时改点它 —— 这一族是"人工点控制条那枚也能救回来"的等价路径',
    !!pickToggle && pickToggle.rung === 'play-toggle' && pickToggle.el === s3.toggle,
    JSON.stringify({ rung: pickToggle && pickToggle.rung }));

  // ④ 只在「还停在开头」那一形状上动手：两档阈值各钉两侧
  // 挑 60 秒是为了让第二道闸**单独**承重：60 * ctRatio = 1.2 秒 < 固定那档 ctHard，
  // 于是 ct=1.5 这一格第一道闸放行、只有比例闸能挡 —— 拿 1200 秒那档时第二道闸永远轮不到。
  var shortDur = 60;
  var edges = [
    { ct: 0, dur: 1200, want: true },
    { ct: ctHard, dur: 1200, want: true },
    { ct: ctHard + 0.5, dur: 1200, want: false },
    { ct: 1, dur: shortDur, want: true },
    { ct: 1.5, dur: shortDur, want: false },
    { ct: ctHard, dur: 0, want: true }
  ];
  var edgeOut = edges.map(function (e) {
    var sh = mkShape({ ct: e.ct, dur: e.dur });
    var ap = mkApp(sh);
    var got = ap._nudgeSiteStartControl(sh.video, 'no-progress');
    return { ct: e.ct, dur: e.dur, got: got === true, want: e.want, clicked: sh.clicks.length };
  });
  check('④ 两道位置闸各钉两侧（' + shortDur + ' 秒那种短视频按比例算出的上限 ' + (shortDur * ctRatio) +
    ' 秒比固定的 ' + ctHard + ' 秒更严，所以第二道闸必须自己承重，不能指望第一道）：' +
    '已经播出去一段的停滞不许点开始键 —— 那等于替人把看过的部分重播；时长读不出时不许拿 0 当"已经播完"',
    edgeOut.every(function (r) { return r.got === r.want && r.clicked === (r.want ? 1 : 0); }),
    JSON.stringify(edgeOut));

  // ⑤ 有界：最多 capClicks 发、间隔不低于 spacingMs，烧完只说一次并交回人
  var sh5 = mkShape({});
  var ap5 = mkApp(sh5);
  var seq5 = [];
  logs.length = 0;   // 取证窗口单独开：④ 那几发的日志混进来会把"每一发都说话"数成 6 条
  function step5(label) {
    seq5.push({
      step: label,
      ret: ap5._nudgeSiteStartControl(sh5.video, 'paused') === true,
      clicks: sh5.clicks.length,
      warn: spoke('media start stuck').length,
      gaveUp: spoke('media start stuck, left to human').length
    });
  }
  step5('第 1 发');
  nowMs += spacingMs - 1; step5('间隔差 1 毫秒');
  nowMs += 2; step5('间隔够了 → 第 2 发');
  nowMs += spacingMs * 3; step5('烧完再问 → 只许说话');
  nowMs += spacingMs * 3; step5('说过之后不再重复');
  check('⑤ 有界：最多 ' + capClicks + ' 发、相邻两发间隔不低于 ' + spacingMs + ' 毫秒；' +
    '差 1 毫秒不许点（否则每拍一次正好绕过间隔闸）',
    seq5[0].ret === true && seq5[0].clicks === 1 &&
    seq5[1].ret === false && seq5[1].clicks === 1 &&
    seq5[2].ret === true && seq5[2].clicks === 2 &&
    seq5[3].ret === false && seq5[3].clicks === 2 &&
    seq5[4].ret === false && seq5[4].clicks === 2,
    JSON.stringify(seq5));
  check('⑥ 烧完必须留一句话把人请进来（AGENTS §2 #7 静默跳过不可接受），而且**只说一次**、' +
    'hint 照用户自己的话说"亲手点一下开始"、取证带点过几回与页面读数',
    seq5[3].gaveUp === 1 && seq5[4].gaveUp === 1 &&
    spoke('media start stuck, left to human').every(function (m) { return m.level === 'warn'; }) &&
    (function () {
      var m = spoke('media start stuck, left to human')[0];
      return !!m && !!m.meta && /开始/.test(String(m.meta.hint || '')) &&
        Number(m.meta.nudges) === capClicks && Number(m.meta.ct) === 0 && Number(m.meta.dur) === 1200;
    })(),
    JSON.stringify(spoke('media start stuck, left to human')));
  check('⑦ 中间每一发也要留话（点了什么、第几回、位置/时长/readyState/paused 全从页面读回），' +
    '否则现场只能看见"它又白点了两下"',
    (function () {
      var picked = spoke('media start stuck, clicked site start control');
      return picked.length === capClicks && picked.every(function (m) {
        return m.level === 'warn' && !!m.meta && m.meta.rung === 'big-play' &&
          Number(m.meta.ct) === 0 && Number(m.meta.dur) === 1200 &&
          Number(m.meta.ready) === 0 && m.meta.paused === true;
      }) && Number(picked[1].meta.attempt) === 2;
    })(),
    JSON.stringify(spoke('media start stuck, clicked site start control')));

  // ⑧ 「认不出开始键」单独占一格，不许塌成"点过了"
  var sh8 = mkShape({ noBig: true, noToggle: true });
  var ap8 = mkApp(sh8);
  logs.length = 0;
  var r8a = ap8._nudgeSiteStartControl(sh8.video, 'paused');
  var ledger8 = ap8._startNudgeKeys && ap8._startNudgeKeys[String(getKey.call(ap8, sh8.video))];
  var none8 = spoke('media start stuck, no site start control');
  var sh8b = mkShape({ noHost: true });
  var ap8b = mkApp(sh8b);
  logs.length = 0;
  var r8b = ap8b._nudgeSiteStartControl(sh8b.video, 'paused');
  var none8b = spoke('media start stuck, no site start control');
  check('⑧ 这一族里没有开始键（两个类名都扫不到 / 压根不在 .video-js 里）单独占一格：' +
    '出一句「没认出来」的 warn，绝不冒充"已经点过了"，也不许因为返回 false 就不记账',
    r8a === false && r8b === false && sh8.clicks.length === 0 && sh8b.clicks.length === 0 &&
    none8.length === 1 && none8b.length === 1 &&
    !!none8[0].meta && none8[0].meta.rung === 'none' && none8[0].message.indexOf('clicked') < 0 &&
    !!ledger8 && Number(ledger8.n) === 1 && ledger8.rung === 'none',
    JSON.stringify({ a: none8.map(function (m) { return m.message; }), b: none8b.map(function (m) { return m.message; }), n: ledger8 && ledger8.n, rung: ledger8 && ledger8.rung }));

  // ⑨ 站点为弹题有意暂停 → 一发射都不许放，也不烧预算
  var sh9 = mkShape({});
  var ap9 = mkApp(sh9);
  ap9.__quizBlocks = true;
  logs.length = 0;
  var r9 = ap9._nudgeSiteStartControl(sh9.video, 'paused');
  check('⑨ 弹题盖着的时候不抢（与 `_handleVideoPause` 同一口径）：不点、不出声、' +
    '账也不记 —— 挡住不是我们的错，凭什么烧掉那一节仅有的两发',
    r9 === false && sh9.clicks.length === 0 && logs.length === 0 &&
    (ap9._startNudgeKeys === null || Object.keys(ap9._startNudgeKeys).length === 0),
    JSON.stringify({ clicks: sh9.clicks, logs: logs.map(function (m) { return m.message; }), keys: ap9._startNudgeKeys }));

  // ⑩ 音频不做 / 拿不到键不做（没量过的形状就不动手）
  var sh10 = mkShape({ tagName: 'AUDIO' });
  var ap10 = mkApp(sh10);
  var sh11 = mkShape({ src: '' });
  var ap11 = mkApp(sh11);
  ap11._isPlaying = true;
  logs.length = 0;
  var r10 = ap10._nudgeSiteStartControl(sh10.video, 'paused');
  var r11 = ap11._nudgeSiteStartControl(sh11.video, 'paused');
  check('⑩ 音频（现场只量过视频那一族）与「连这一源是谁都说不清」两格一律不动手：' +
    '不点、不出声，认不出交 false 让老流程接管',
    r10 === false && r11 === false && sh10.clicks.length === 0 && sh11.clicks.length === 0 && logs.length === 0,
    JSON.stringify({ audio: sh10.clicks, noKey: sh11.clicks, logs: logs.length }));

  check('⑪ `_isPlaying` 为假（用户自己按了暂停 / 还没认领这一节）时不许替他点开始',
    (function () {
      var sh = mkShape({});
      var ap = mkApp(sh);
      ap._isPlaying = false;
      var got = ap._nudgeSiteStartControl(sh.video, 'paused');
      return got === false && sh.clicks.length === 0;
    })(),
    JSON.stringify({ clicked: (function () { return '见谓词'; })() }));

  // ⑫ 接线：档位要真的挂在生产那条自愈链上，而且点着之后这一拍不许再补一发 play()
  var atHook = resumeBody.indexOf('this._resumeAttemptCount >= ' + rungAt);
  var beforePlay = resumeBody.indexOf('video.play()');
  check('⑫ 这一档接在 `_tryResumePlayback` 里第 ' + rungAt + ' 发之后（不是另起一条无人走的支路），' +
    '且点着了当拍就 return —— 不再补一发我们自己的 play()',
    atHook >= 0 && beforePlay >= 0 && atHook < beforePlay &&
    resumeBody.slice(atHook, atHook + 160).indexOf('_nudgeSiteStartControl') >= 0 &&
    /if \(this\._resumeAttemptCount >= \d+ && this\._nudgeSiteStartControl\([^)]*\)\) return;/.test(resumeBody),
    JSON.stringify({ atHook: atHook, beforePlay: beforePlay }));

  check('⑬ 记账不随换节清零（AGENTS §2 #13）：`_startNudgeKeys` 在声明表里，' +
    '而 `_clearMediaPendingState` 与 `_resetRuntimeState` 都不许抹它 —— 抹了就等于同一节反复点',
    /_startNudgeKeys: null,/.test(state) &&
    bodyOf(media, '_clearMediaPendingState').indexOf('_startNudgeKeys') < 0 &&
    (function () {
      var r = boundsOf(state, '_resetRuntimeState');
      var seg = r.start < 0 ? '' : state.slice(r.start, state.indexOf('\n    },', r.start));
      return seg.length > 0 && seg.indexOf('_startNudgeKeys') < 0;
    })(),
    JSON.stringify({
      declared: /_startNudgeKeys: null,/.test(state),
      inClear: bodyOf(media, '_clearMediaPendingState').indexOf('_startNudgeKeys') >= 0,
      resetBodyFound: boundsOf(state, '_resetRuntimeState').start >= 0
    }));

  check('⑭ 键名只用现场量到的那两枚写死的类名，而且必须先 `closest` 到这一枚视频自己的容器' +
    '（模糊的 `[class*=play]` 会把「重启」和倍速菜单扫进来）',
    siteBody.indexOf("closest('.video-js") >= 0 &&
    siteBody.indexOf(".vjs-big-play-button") >= 0 && siteBody.indexOf(".vjs-play-control") >= 0 &&
    siteBody.indexOf('[class*=') < 0 && /vjs-playing/.test(siteBody),
    JSON.stringify({
      closest: siteBody.indexOf("closest('.video-js") >= 0,
      fuzzy: siteBody.indexOf('[class*='),
      antiPlaying: /vjs-playing/.test(siteBody)
    }));

  // ⑮ 反向自查：这一段自己得真的动过站点元素（防止整段变成空测）
  check('⑮ 夹具自证：以上每一发的"点过了"都是**站点元素自己的 click 被真的调到**（记的是类名，不是我们自报的布尔）',
    sh5.clicks.length === capClicks && sh5.clicks.every(function (c) { return c === 'vjs-big-play-button'; }) &&
    s1.clicks.length === 0 && s3.clicks.length === 0 && sh9.clicks.length === 0,
    JSON.stringify({ ladder: sh5.clicks, untouched: [s1.clicks, s3.clicks, sh9.clicks] }));

  logs.length = 0;
}

/** ---- [22c] 批次 174：站点自己说「这一支放不出来」时别再白等，而且必须说话（会话任务 #24 / issue #225）
 * 现场取证 `notes/field-225-unplayable.md`：站点遇到**外部视频**时把播放器整块换成一句正文
 * （「非常抱歉，该视频为外部视频，当前浏览器版本不支持播放该视频…」），那一族页面里**压根没有 `<video>`**（形状 1）。
 * 改动前：等满 8 秒 → 只落一句 `console.warn` → 日志环一个字都没有（AGENTS §2 #14「不许停在决定不做」）。
 * 三条边界各有独立承重的格子：**只许减少等待、不许标记完成**＝㊵（静态扫方法体）＋㊶ 的接线格、
 * **120 秒那一格原样保留**＝㊶ 的另一半、**认不出交「读不出」单独占一格**＝㉟＋㊀（AGENTS §2 #12）。
 */
async function testSiteSaysUnplayable() {
  console.log('\n[22c] 站点写「外部视频不支持播放」那一格：提前收手、照抄原话、三格不许互塌（批次 174）');

  var media = fs.readFileSync(path.join(ROOT, 'src/page/40-media.js'), 'utf8').replace(/\r\n/g, '\n');
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };

  // 现场那句话照抄取证件（形状 1 的真身），断言里的输入全部**由源码词表拼出来**，只有这一句是现场锚点
  var SITE_SENTENCE = '非常抱歉，该视频为外部视频，当前浏览器版本不支持播放该视频，请使用 chrome 内核浏览器或更新浏览器版本后重试。';

  // 词组表从源码读回来 —— ⚠️ 不许在测试里另抄一份（改了生产词表而断言照旧 = 假绿，AGENTS §5「断言里出现的每一个数都要说得出它是从哪读回来的」）
  var tableRaw = (media.match(/_SITE_UNPLAYABLE_GROUPS:\s*\[([\s\S]*?)\n {4}\],/) || [])[1] || '';
  var table = [];
  tableRaw.replace(/\[([^\]]*)\]/g, function (_m, inner) {
    var toks = [];
    inner.replace(/'([^']*)'/g, function (_q, t) { toks.push(t); return t; });
    if (toks.length) table.push(toks);
    return inner;
  });

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: String(message || ''), meta: meta }); };
  var hitFn = buildFrom(media, '_siteUnplayableHit', {});
  var saidFn = buildFrom(media, '_siteSaysUnplayable', {});
  var waitFn = buildFrom(media, '_waitForMediaInDocument', {});
  var releaseFn = buildFrom(media, '_releaseMediaNotFound', { emitRuntimeLog: say });
  check('⓪ 四件都能从 40-media.js 原样取出来真跑，站点词组表也读得回来（取不出来时后面每一条都是「没执行」，'
    + '而「没执行」和「通过」在报告里长得一模一样 —— AGENTS §5「红 0 条的第一嫌疑人是没跑到」）',
    [hitFn, saidFn, waitFn, releaseFn].every(function (f) { return typeof f === 'function'; }) &&
    table.length >= 2 && table.every(function (g) { return g.length >= 2 && g[0].length >= 2; }),
    JSON.stringify({ fns: [typeof hitFn, typeof saidFn, typeof waitFn, typeof releaseFn], table: table }));
  if (!hitFn || !saidFn || !waitFn || !releaseFn || table.length < 2) return;

  var G1 = table[0], G2 = table[1];
  var appOf = function () {
    return { _SITE_UNPLAYABLE_GROUPS: table, _siteUnplayableHit: hitFn, _siteSaysUnplayable: saidFn };
  };
  var app = appOf();

  // ㉞ 词组尺：齐全才算、只有一半不算、换措辞走第二组、认不到交空串
  var r34both = hitFn.call(app, '前言' + G1.join('，') + '后语');
  var r34half = hitFn.call(app, '只有' + G1[0] + '没有后半句');
  var r34g2 = hitFn.call(app, G2.join('，'));
  var r34split = hitFn.call(app, G1[0] + '\n\t ' + G1[1].split('').join(' '));   // 第二个词被拆开 ⇒ 不算（不许猜措辞）
  var r34site = hitFn.call(app, SITE_SENTENCE);
  var chromeInTable = table.join('|').toLowerCase().indexOf('chrome') >= 0;
  check('㉞ 只认站点那两句的**稳定前缀**：两句齐全才命中并点名是哪个词组（站点换措辞时看得出来走的哪一条）、'
    + '只有一半不算、被拆开的也不算、空串与 null 不算，现场那句原话命中第一组；'
    + '词表里不许出现浏览器名（chrome／Edge 会随版本换，「外部视频」＋「不支持播放」才是这件事的本体）',
    r34both === G1.join('+') && r34half === '' && r34g2 === G2.join('+') &&
    r34split === '' && hitFn.call(app, '') === '' && hitFn.call(app, null) === '' &&
    r34site === G1.join('+') && chromeInTable === false,
    JSON.stringify({ both: r34both, half: r34half, g2: r34g2, split: r34split, site: r34site, chrome: chromeInTable }));

  // ㉟ 三格各占一格：said（带原话与词组）／silent（读得下去而没说）／unreadable（压根没读到）
  var r35said = saidFn.call(app, { body: { textContent: '章节导航 作业 讨论 ' + SITE_SENTENCE } });
  var r35silent = saidFn.call(app, { body: { textContent: '这一节是普通课件，站点没有说一句不支持。' } });
  var r35nil = saidFn.call(app, null);
  var r35nobody = saidFn.call(app, {});
  var r35boom = saidFn.call(app, {
    get body() { throw new Error('SecurityError: 跨域'); }
  });
  var quoteHasBoth = r35said.quote.indexOf(G1[0]) >= 0 && r35said.quote.indexOf(G1[1]) >= 0;
  check('㉟ 三格互不塌：`said` 交回词组与站点原话（命中在正文**中段**也算 —— 判的是全文，截断只用于展示，'
    + '先截断再比对就等于把被砍掉那一截变成断言的盲区 §5）、`silent` 是"整条链读得下去而没这句话"、'
    + '`null`／没有 body／取 body 抛异常都是 `unreadable`（**不许塌成 silent**，'
    + '那等于替站点说"我没说过"，下一轮就会拿它当"这一格可以删掉"的依据）',
    r35said.state === 'said' && r35said.group === G1.join('+') && r35said.hop === 0 && quoteHasBoth &&
    r35said.quote.length <= 180 && r35silent.state === 'silent' && r35silent.quote === '' &&
    r35nil.state === 'unreadable' && r35nobody.state === 'unreadable' && r35boom.state === 'unreadable',
    JSON.stringify({ said: { s: r35said.state, g: r35said.group, hop: r35said.hop, len: r35said.quote.length },
      silent: r35silent.state, nil: r35nil.state, nobody: r35nobody.state, boom: r35boom.state }));

  // ㊀ 往上爬（标语常在承载播放器那一层的**上一层**）：第 2 层命中要报出 hop；爬到一半抛 = unreadable，不许把已读的 silent 交出去
  var deepDoc = { body: { textContent: '知识卡片 ' + SITE_SENTENCE } };
  var midDoc = { body: { textContent: '空壳一层' }, defaultView: { frameElement: { ownerDocument: deepDoc } } };
  var topDoc = { body: { textContent: '空壳两层' }, defaultView: { frameElement: { ownerDocument: midDoc } } };
  var r36deep = saidFn.call(app, topDoc);
  var brokenParent = { body: { textContent: '这一层读得下去，没有那句话' }, defaultView: { get frameElement() { throw new Error('SecurityError'); } } };
  var r36broken = saidFn.call(app, brokenParent);
  var upSelf = { body: { textContent: '自指一层' } };
  upSelf.defaultView = { frameElement: { ownerDocument: upSelf } };
  var r36self = saidFn.call(app, upSelf);
  check('㊀ 文档链：第 3 层（hop=2）那句原话读得回来并**报出爬到第几层**（归因用）；'
    + '而爬到一半裸读抛异常交回的是 `unreadable` 而不是这一层已经读到的 `silent`（半条链不能当整条链说话），'
    + '`ownerDocument` 自指时当场停住、不许无限爬（停在已读到的那一格）',
    r36deep.state === 'said' && r36deep.hop === 2 && r36deep.quote.indexOf(G1[0]) >= 0 &&
    r36broken.state === 'unreadable' && r36self.state === 'silent',
    JSON.stringify({ deep: { s: r36deep.state, hop: r36deep.hop }, broken: r36broken.state, self: r36self.state }));

  // ㊁ 等元素那一族现在每一轮可以顺手问一句：命中就**提前**交回，没命中照旧花满窗口，没有问句时行为一字不变
  var W37 = 600;                       // 本段自用的窗口（不是生产那个 8000）：只钉 onTick 这一纸合同
  var mkWaiter = function (foundAfter, hook) {
    var host = { __n: 0, _findMediaInDocument: function () { return host.__n++ >= foundAfter ? media35 : null; } };
    var media35 = { tagName: 'VIDEO' };
    return { host: host, p: waitFn.call(host, {}, W37, hook) };
  };
  var asks = 0, w37a = mkWaiter(999, function () { asks++; return false; });
  var t37a = Date.now();
  var v37a = await w37a.p;
  var spent37a = Date.now() - t37a;
  var hits = 0, w37b = mkWaiter(999, function () { hits++; return true; });
  var t37b = Date.now();
  var v37b = await w37b.p;
  var spent37b = Date.now() - t37b;
  var w37c = mkWaiter(999, undefined);
  var t37c = Date.now();
  var v37c = await w37c.p;
  var spent37c = Date.now() - t37c;
  var asked37d = 0, w37d = mkWaiter(1, function () { asked37d++; return false; });
  var v37d = await w37d.p;
  var asked37dAfter = asked37d;
  check('㊁ `onTick` 只在**拿不到元素**之后问：问出结论立刻提前交回 null（窗口 600 毫秒只花了不到一半，'
    + '不花满 8 秒那一窗）、没问出来照旧花满窗口才交回 null（且至少问了两发）、'
    + '不传问句时与改动前逐字同形（旧调用方不许被这次改动牵动）、元素一拿到就交回元素本身并且**之后不再多问一发**',
    v37a === null && spent37a >= W37 - 20 && asks >= 2 &&
    v37b === null && hits === 1 && spent37b < W37 / 2 &&
    v37c === null && spent37c >= W37 - 20 &&
    v37d && v37d.tagName === 'VIDEO' && asked37dAfter === 1,
    JSON.stringify({ window: W37, noHit: { v: String(v37a), ms: spent37a, asks: asks },
      hit: { v: String(v37b), ms: spent37b, hits: hits },
      noHook: { v: String(v37c), ms: spent37c }, found: { tag: v37d && v37d.tagName, asked: asked37dAfter } }));

  // ㊂ 问句自己炸了不算结论，也不许把"等元素"这条主路弄死（取证助手不许顶掉正事）
  var threw38 = 0, w38 = mkWaiter(999, function () { threw38++; throw new Error('探针坏了'); });
  var t38 = Date.now();
  var v38 = await w38.p;
  var spent38 = Date.now() - t38;
  check('㊂ 问句抛异常 ⇒ 这一发只当"没问到"：照旧等到窗口结束、交回 null、后续每一轮还在问（≥2 发）—— '
    + '一次取证崩掉不许变成"永远等不到结果"（§2 #2），也不许变成"这一拍什么都不说"',
    v38 === null && spent38 >= 240 && threw38 >= 2,
    JSON.stringify({ v: String(v38), ms: spent38, threw: threw38 }));

  // ㊳ 三格各一个出口名字，谁都不许冒领谁；放手都要清 pending 并交回 false
  var host39a = { _activeMediaJobPending: true }, host39b = { _activeMediaJobPending: true };
  var host39c = { _activeMediaJobPending: true }, host39d = { _activeMediaJobPending: true };
  var out39said = releaseFn.call(host39a, '外部视频', { state: 'said', quote: SITE_SENTENCE, group: G1.join('+'), hop: 1 }, 180);
  var out39silent = releaseFn.call(host39b, '没等到', { state: 'silent', hop: 0 }, 8000);
  var out39nil = releaseFn.call(host39c, '读不出', null, 8000);
  var out39unread = releaseFn.call(host39d, '读不出2', { state: 'unreadable', hop: -1 }, 8000);
  var byName = function (n) { return logs.filter(function (m) { return m.message === n; }); };
  var saidLogs = byName('media unplayable by site player');
  var notReadyLogs = byName('media not ready, release pending');
  check('㊳ 放手说话分三格且各占各的名字：`said` → `media unplayable by site player`（照抄站点原话 + 词组 + 层号 + 等了多久），'
    + '`silent` / `unreadable` / 压根没有读数 → `media not ready, release pending` 并各带自己的 `siteText`'
    + '（**「读不出」不许塌成「站点没说」**，也不许由「站点没说」冒领「站点说了」那句）；'
    + '四格一律交回 false 并把 pending 清掉 —— 交回 false 才会重新派发，标完成是平台的事',
    out39said === false && out39silent === false && out39nil === false && out39unread === false &&
    [host39a, host39b, host39c, host39d].every(function (h) { return h._activeMediaJobPending === false; }) &&
    saidLogs.length === 1 && saidLogs[0].level === 'warn' &&
    String(saidLogs[0].meta.quote).indexOf(G1[0]) >= 0 && saidLogs[0].meta.siteText === 'said' &&
    Number(saidLogs[0].meta.hop) === 1 && Number(saidLogs[0].meta.waitedMs) === 180 &&
    notReadyLogs.length === 3 &&
    String(notReadyLogs[0].meta.siteText) === 'silent' && String(notReadyLogs[1].meta.siteText) === 'unreadable' &&
    String(notReadyLogs[2].meta.siteText) === 'unreadable',
    JSON.stringify({ said: saidLogs.length, notReady: notReadyLogs.map(function (m) { return m.meta.siteText; }),
      pending: [host39a._activeMediaJobPending, host39b._activeMediaJobPending,
        host39c._activeMediaJobPending, host39d._activeMediaJobPending] }));

  // ㊴ 只许减少等待，不许标记完成（静态格：整个出口里不许出现任何"完成"写入口，也不许碰一次性登记那两族）
  var relBody = bodyOf(media, '_releaseMediaNotFound');
  var saidBody = bodyOf(media, '_siteSaysUnplayable');
  var forbidden = ['isFinished', '_markMediaFinished', '_reportJobCompleted', '_seekTriedKeys', '_seekRevertedKeys', '_detectedMaxRate', 'localStorage'];
  var foundInRel = forbidden.filter(function (k) { return relBody.indexOf(k) >= 0; });
  var foundInSaid = forbidden.filter(function (k) { return saidBody.indexOf(k) >= 0; });
  check('㊴ 边界一（只许减少等待）：新出口与读取器两个方法体里**一个完成写入口都没有**'
    + '（`isFinished`／上报完成／一次性登记那两族／倍速读数／磁盘存储都在排除名单里）—— '
    + '「站点说不支持」不是"这一节做完了"，把话说清楚之后仍然要交回派发，反复重派由 `_countTaskIncomplete` 收住',
    relBody.length > 200 && saidBody.length > 400 && foundInRel.length === 0 && foundInSaid.length === 0,
    JSON.stringify({ relLen: relBody.length, saidLen: saidBody.length, inRel: foundInRel, inSaid: foundInSaid }));

  // ㊵ 接线（声明覆盖的范围与实际走的分支之间的差不会自己喊出来 —— §2 #18）
  var playAt = media.indexOf('_playChaoxingMediaJob: async function');
  var playBody = playAt < 0 ? '' : media.slice(playAt, media.indexOf('\n    },', playAt));
  var noSourceBody = bodyOf(media, '_isActiveMediaPending');
  var askAt = playBody.indexOf('this._siteSaysUnplayable(job.doc)');
  var waitAt = playBody.indexOf('this._waitForMediaInDocument(job.doc');
  var relAt = playBody.indexOf('this._releaseMediaNotFound(');
  var oldConsoleAt = playBody.indexOf("chaoxing media not ready");
  var throttleAt = playBody.indexOf('lastSiteAsk < 1000');   // 问话按 1 秒节流：这一族每 200 毫秒就来一发，不许变成热路径
  check('㊵ 接线：进门先问一次、等元素每一轮按节流再问、拿不到才走**有名字**的出口（顺序错了就等于新格永远走不到）；'
    + '旧那句只在控制台的 `chaoxing media not ready` 已经从派发路径上摘掉（日志环必须有记录，§2 #14）；'
    + '边界二：120 秒有界放手那一格**一个字没删**（`noSourceShape` 与它的 warn 都还在），'
    + '并且那一格的取证现在捎上站点原话（`siteText` + `siteQuote`）—— 新格是更早的出口，不是旧格的替换品',
    playBody.length > 800 && askAt > 0 && waitAt > askAt && relAt > waitAt && oldConsoleAt < 0 &&
    throttleAt > waitAt && /noSourceShape/.test(noSourceBody) &&
    /media has no source, release pending/.test(noSourceBody) &&
    /siteText:\s*noSrcSite\.state/.test(noSourceBody) && /siteQuote:\s*noSrcSite\.quote/.test(noSourceBody),
    JSON.stringify({ playLen: playBody.length, askAt: askAt, waitAt: waitAt, relAt: relAt,
      oldConsoleAt: oldConsoleAt, throttleAt: throttleAt, noSourceLen: noSourceBody.length }));

  logs.length = 0;
}

/** ---- [23] 批次 98：多选答案规范化「认不出来交空串」，合法形状一个都不许多拒 ---- */
async function testCanonicalMultipleAnswerOrEmpty() {
  console.log('\n[23] 多选答案规范化：认不出来交空串，但连写、乱序、重复这些合法形状一个不许变（批次 98）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  // ⚠️ 静态扫方法体之前先剥注释（批次 98 实测踩过）：注释里引了一句真源 `/^[A-F]$/i`，
  //    `letterBound` 于是读出两种字母类（F/H）→ 按「一个体里两种上界＝读不出」判成 0 →
  //    ① 当场红并触发整段提前 return，②-⑦ 一条都没执行 —— 而「没执行」在报告里和「通过」长得一样。
  //    注释是给人看的，不许进断言的证据；剥成等长空格、位置不动，`buildFrom` 仍拿原文拼函数。
  var stripComments = function (src) {
    var out = String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
    return out.replace(/(^|[^:])\/\/[^\n]*/g, function (m, prefix) {
      return prefix + new Array(m.length - prefix.length + 2).join(' ');
    });
  };
  var codeOf = function (body) { return stripComments(body); };
  // 字母上界不写死成 'F' / 'H'：那两处字面量改了而测试还按旧的跑，就是一条假绿。
  // 一个方法体里出现两种上界也当读不出处理（宁可没有结论，也不要一个错位的结论）。
  var letterBound = function (body) {
    var re = /\[A-([A-Z])/g, seen = {}, m;
    while ((m = re.exec(body))) seen[m[1]] = 1;
    var list = Object.keys(seen);
    return { bound: list.length === 1 ? list[0].charCodeAt(0) - 64 : 0, classes: list.join('/') };
  };

  var dom = read('src/page/75-quiz-dom.js');
  var quiz = read('src/page/72-quiz-answers.js');

  var app = {
    _normalizeAnswerValue: buildFrom(dom, '_normalizeAnswerValue', {}),
    _normalizeJudgeAnswerValue: buildFrom(dom, '_normalizeJudgeAnswerValue', {}),
    _canonicalQuizAnswer: buildFrom(quiz, '_canonicalQuizAnswer', {}),
    _canonicalQuizAnswerForQuestion: buildFrom(quiz, '_canonicalQuizAnswerForQuestion', {}),
    _expandMultiChoiceLetters: buildFrom(dom, '_expandMultiChoiceLetters', {}),
    // 桩只打在「读 DOM」这一发动作上（本集成层拿不到真 DOM），字母与规范化那一路全是真代码
    _getOptionItems: function () { return [1, 2, 3, 4, 5, 6]; },
    _matchOptionItem: function () { return null; },
    _getOptionStoredAnswerValue: function () { return ''; },
    _extractOptionText: function () { return ''; }
  };
  var ask = function (v, t) { return app._canonicalQuizAnswer(v, t); };

  var clickBound = letterBound(codeOf(bodyOf(dom, '_normalizeChoiceAnswerValues'))).bound;
  var canonInfo = letterBound(codeOf(bodyOf(quiz, '_canonicalQuizAnswer')));
  // 剥注释这一手自己也承重，所以要能量回来：剥完之后行数不变、多选分支与判定预查两句真代码
  // 还在原处 = 剥掉的确实只有注释。少了任何一件，说明字符串里的 `//` 把代码一起吃掉了。
  var canonCode = codeOf(bodyOf(quiz, '_canonicalQuizAnswer'));
  var stripKeptCode = canonCode.split('\n').length === bodyOf(quiz, '_canonicalQuizAnswer').split('\n').length &&
    canonCode.indexOf("type === 'multiple'") >= 0 && canonCode.indexOf('var judgeAny') >= 0 &&
    letterBound(canonCode).bound > 0;

  check('① 五件都能从盘上原样取出来真跑、两个字母上界也从**代码**（不是注释）里读得回来、剥注释没吃掉任何一行代码（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    ['_normalizeAnswerValue', '_normalizeJudgeAnswerValue', '_canonicalQuizAnswer',
      '_canonicalQuizAnswerForQuestion', '_expandMultiChoiceLetters'].every(function (n) {
        return typeof app[n] === 'function';
      }) && clickBound > 0 && canonInfo.bound > 0 && stripKeptCode,
    JSON.stringify({ types: Object.keys(app).map(function (k) { return k + '=' + typeof app[k]; }), clickBound: clickBound, canon: canonInfo, stripKeptCode: stripKeptCode }));
  if (typeof app._canonicalQuizAnswer !== 'function' || typeof app._expandMultiChoiceLetters !== 'function' ||
      clickBound <= 0 || canonInfo.bound <= 0 || !stripKeptCode) return;

  // ---- ② 合法形状：一个都不许多拒，而且四种写法必须收敛成同一串（AGENTS §2 #18 的「全序规范形」）----
  var legalShapes = ['A,C', 'C,A', 'AC', 'CA', ['A', 'C'], 'A、C', 'A;C', ' a , c ', 'A,A,C', 'C , A'];
  var shapeBad = [];
  legalShapes.forEach(function (v) {
    var got = ask(v, 'multiple');
    if (got !== 'AC') shapeBad.push(JSON.stringify(v) + '=' + JSON.stringify(got));
  });
  var idempotent = legalShapes.every(function (v) { return ask(ask(v, 'multiple'), 'multiple') === 'AC'; });
  var siteShape = ask('DBAC', 'multiple') === 'ABCD' && ask('G,H', 'multiple') === 'GH' && ask('ABCDEFGH', 'multiple') === 'ABCDEFGH';
  check('② 十种合法写法（逗号、顿号、分号、空格、重复、数组、连写、乱序）全部归成 AC、规范形幂等，站点那种连写 DBAC 与八选项 ABCDEFGH 照旧认（一刀切严就是「同一道多选反复花钱」）',
    shapeBad.length === 0 && idempotent && siteShape,
    JSON.stringify({ bad: shapeBad, idempotent: idempotent, dbac: ask('DBAC', 'multiple'), eight: ask('ABCDEFGH', 'multiple') }));

  // ---- ③ 规范化不许新拒一个「点得动」的字母 ----
  // 上界不是 `_normalizeChoiceAnswerValues` 那个 A-F 正则，而是补组合那一族的选项上限：
  // 隐藏域在无徽标那一路用 `String.fromCharCode(65 + order)` 兜底（75-quiz-dom.js 里
  // 「if (!/^[A-F]$/i.test(l))」那一行），所以第 7、8 枚字母是真点得动的 —— 只比 A-F 会低估。
  var capMatch = codeOf(bodyOf(dom, '_expandMultiChoiceLetters')).match(/total < 2 \|\| total > (\d+)/);
  var capTotal = capMatch ? Number(capMatch[1]) : 0;
  var rejectBad = [];
  // 规范形是「去重 + 排序」，期望值照这个口径算，别写成没去重的连写（BB 归成 B 是对的）
  var uniqSorted = function (s) {
    var bag = {};
    s.split('').forEach(function (ch) { bag[ch] = 1; });
    return Object.keys(bag).sort().join('');
  };
  for (var i = 1; i <= capTotal; i++) {
    var one = String.fromCharCode(64 + i);
    if (ask(one, 'multiple') !== one) rejectBad.push(one + ' 单枚=' + JSON.stringify(ask(one, 'multiple')));
    if (i > 1) {
      var want = uniqSorted(one + 'B');
      if (ask(one + 'B', 'multiple') !== want) rejectBad.push(one + 'B 连写=' + JSON.stringify(ask(one + 'B', 'multiple')) + '，期望 ' + want);
      if (ask(one + ',B', 'multiple') !== want) rejectBad.push(one + ',B 逗号=' + JSON.stringify(ask(one + ',B', 'multiple')) + '，期望 ' + want);
    }
  }
  check('③ 补组合那一族的选项上限是第 ' + capTotal + ' 枚字母（第 7、8 枚经 `65 + order` 兜底真点得动），规范化认到第 ' + canonInfo.bound + ' 枚，逐枚与两两组合真跑过且全部认；A 到第 ' + capTotal + ' 枚一个都不许多拒（改窄成 A-F 这一条就红 —— 那会新拒掉本来点得动的答案）',
    capTotal > 0 && canonInfo.bound >= capTotal && rejectBad.length === 0,
    JSON.stringify({ capTotal: capTotal, canonBound: canonInfo.bound, regexBoundOfClickPath: clickBound, bad: rejectBad }));

  // ---- ④ 认不出来的形状一律交空串（改前实测：ABEFHLOTV / ERTU / AC / AB，全是凭空造出来的选项）----
  var garbage = ['ALL OF THE ABOVE', 'TURE', 'A-C', 'AB,正确', '甲、乙', '选项1'];
  var garbageBad = [];
  garbage.forEach(function (v) {
    var got = ask(v, 'multiple');
    if (got !== '') garbageBad.push(JSON.stringify(v) + '=' + JSON.stringify(got));
  });
  check('④ 六种认不出来的形状（选项原文、拼错的字母组、破折号分隔、字母混中文、中文顿号、带数字）全部交空串，绝不猜（AGENTS §2 #18：凭空多出九个「选项」比「没有结论」危险得多）',
    garbageBad.length === 0,
    JSON.stringify({ bad: garbageBad, all: garbage.map(function (v) { return v + '=' + JSON.stringify(ask(v, 'multiple')); }) }));

  // ---- ⑤ 判定那一族排在 multiple 分支之前，新闸不许把它们改成交空串 ----
  var multiBody = canonCode;
  var judgeBeforeMulti = multiBody.indexOf('judgeAny') >= 0 &&
    multiBody.indexOf("type === 'multiple'") > multiBody.indexOf('var judgeAny');
  var judgeShapes = [['TRUE', 'true'], ['true', 'true'], ['对', 'true'], ['正确', 'true'], ['YES', 'true'], ['NONE', 'false']];
  var judgeBad = judgeShapes.filter(function (p) { return ask(p[0], 'multiple') !== p[1]; })
    .map(function (p) { return p[0] + '=' + JSON.stringify(ask(p[0], 'multiple')); });
  check('⑤ 判定形状在 type=multiple 下照旧给出 true/false（TRUE、对、正确、YES、NONE 六枚）且静态钉住判定预查排在 multiple 分支之前 —— 任务里那句「TRUE 交空串」实测是错的，TRUE 根本走不到多选那一支',
    judgeBeforeMulti && judgeBad.length === 0,
    JSON.stringify({ ordered: judgeBeforeMulti, bad: judgeBad }));

  // ---- ⑥ 交空串不等于放弃这一道：下游兜底要真在跑 ----
  var expandBody = bodyOf(dom, '_expandMultiChoiceLetters');
  var fellBack = expandBody.indexOf('if (!canonical) canonical = sorted.join(') >= 0;
  var oneGroup = app._expandMultiChoiceLetters(['A'], 2, {}, []);
  var twoGroup = app._expandMultiChoiceLetters(['C'], 2, {}, ['AC']);
  check('⑥ 规范化交空串时下游仍有兜底：拉黑比较那句「canonical 为空就退回 sorted.join」还在，真跑一次单枚 A 补足两格、被拉黑的 AC 也换得出别的组合（空串不许变成「这一道彻底不做」）',
    fellBack && oneGroup.length >= 2 && twoGroup.length >= 2 && twoGroup.join('') !== 'AC',
    JSON.stringify({ fallbackInSource: fellBack, one: oneGroup, banned: twoGroup }));

  // ---- ⑦ 其余题型一条都不许多变 ----
  check('⑦ 新闸只管 multiple：单选 A 还是 A、判断题 TRUE 还是 true、填空题 hello 还是 HELLO、空值与 null 还是空串（改错分支就是把整条答题链路一起废掉的那种改法）',
    ask('A', 'single') === 'A' && ask('TRUE', 'judge') === 'true' && ask('hello', 'fill') === 'HELLO' &&
      ask('', 'multiple') === '' && ask(null, 'multiple') === '' && ask(undefined, 'single') === '',
    JSON.stringify({ single: ask('A', 'single'), judge: ask('TRUE', 'judge'), fill: ask('hello', 'fill'), empty: ask('', 'multiple'), nul: ask(null, 'multiple') }));
}

/** ---- [24] 批次 99：多选弹题的本地兜底要凑出一整组，而且两把尺先收敛成一种写法 ---- */
async function testPopupQuizLocalComboGroup() {
  console.log('\n[24] 多选弹题本地兜底：凑一整组、避开被判过的组合、不定项不凭空补、点不动的字母不交（批次 99）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  // 静态判据一律先剥注释（同一族坑第二次）：本批那两句注释里**原样抄了**真源的正则与形状，
  // 拿原文数 `[A-F]` 会把注释也算成一处上界。
  var stripComments = function (src) {
    var out = String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
    return out.replace(/(^|[^:])\/\/[^\n]*/g, function (m, prefix) {
      return prefix + new Array(m.length - prefix.length + 2).join(' ');
    });
  };
  var codeOf = function (body) { return stripComments(body); };
  var letterBound = function (body) {
    var re = /\[A-([A-Z])/g, seen = {}, m;
    while ((m = re.exec(body))) seen[m[1]] = 1;
    var list = Object.keys(seen);
    return { bound: list.length === 1 ? list[0].charCodeAt(0) - 64 : 0, classes: list.join('/') };
  };

  var pop = read('src/page/80-popup-quiz.js');
  var dom = read('src/page/75-quiz-dom.js');
  var quiz = read('src/page/72-quiz-answers.js');

  // 「填答尺」的上界从代码读回来，不写死 F：组合里混进一枚这一路点不动的字母，
  // 整串会退化成"选项原文"而一个都不点（那比不接手更糟）。
  var clickBound = letterBound(codeOf(bodyOf(dom, '_normalizeChoiceAnswerValues'))).bound;
  var minByType = function (typeName, optCount) {
    return {
      __n: optCount,
      textContent: typeName || '',
      getAttribute: function (k) { return (k === 'typename' || k === 'typeName') ? String(typeName || '') : ''; },
      querySelector: function () { return null; }
    };
  };
  var mkItems = function (n) {
    var arr = [];
    for (var i = 0; i < n; i++) arr.push({ getAttribute: function () { return ''; }, querySelector: function () { return null; } });
    return arr;
  };
  var fakeTextOf = function (el) { return String((el && el.textContent) || ''); };

  var app = {
    _popupQuizLocalCombo: buildFrom(pop, '_popupQuizLocalCombo', {}),
    _popupQuizLetterGroup: buildFrom(pop, '_popupQuizLetterGroup', {}),
    _getMultiChoiceMinSelections: buildFrom(dom, '_getMultiChoiceMinSelections', { textOf: fakeTextOf }),
    _inferOptionLetter: buildFrom(dom, '_inferOptionLetter', { textOf: fakeTextOf }),
    _expandMultiChoiceLetters: buildFrom(dom, '_expandMultiChoiceLetters', {}),
    _canonicalQuizAnswer: buildFrom(quiz, '_canonicalQuizAnswer', {}),
    _normalizeAnswerValue: buildFrom(dom, '_normalizeAnswerValue', {}),
    _normalizeJudgeAnswerValue: buildFrom(dom, '_normalizeJudgeAnswerValue', {}),
    _canonicalQuizAnswerForQuestion: buildFrom(quiz, '_canonicalQuizAnswerForQuestion', {}),
    // 桩只打在「读 DOM」这一发（集成层拿不到真 DOM），字母、组合、规范化那一路全是真代码
    _getOptionItems: function (el) { return mkItems((el && el.__n) || 0); },
    _matchOptionItem: function () { return null; },
    _getOptionStoredAnswerValue: function () { return ''; },
    _extractOptionText: function () { return ''; }
  };
  // combo(题目形状, 选项数, 名单, 起步那一枚) → { group, why }
  var combo = function (typeName, optCount, banned, seed) {
    return app._popupQuizLocalCombo(minByType(typeName, optCount), mkItems(optCount), banned || [], seed);
  };
  var callerCode = codeOf(bodyOf(pop, '_answerPopupQuizLocally'));
  var wired = callerCode.indexOf("type === 'multiple' ? this._popupQuizLocalCombo(") >= 0;
  var guard = callerCode.indexOf('if (comboTry && comboTry.group) picked = comboTry.group;') >= 0;
  var headered = pop.indexOf('本段的方法（46 个）') >= 0 && /_answerPopupQuizLocally、_popupQuizLocalCombo/.test(pop);
  var need = ['_popupQuizLocalCombo', '_popupQuizLetterGroup', '_getMultiChoiceMinSelections',
    '_inferOptionLetter', '_expandMultiChoiceLetters', '_canonicalQuizAnswer'];

  check('① 六件都能从盘上原样取出来真跑、填答尺的上界从**代码**（不是注释）里读得回来、新方法登记进片段头部、调用方那一行接在填答之前且只在有组合时接手（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    need.every(function (n) { return typeof app[n] === 'function'; }) && clickBound > 0 && wired && guard && headered,
    JSON.stringify({ types: need.map(function (k) { return k + '=' + typeof app[k]; }), clickBound: clickBound, wired: wired, guard: guard, headered: headered }));
  if (!need.every(function (n) { return typeof app[n] === 'function'; }) || clickBound <= 0 || !wired || !guard || !headered) return;

  // ---- ② 真多选凑出一整组，而且交出去的就是本文件那一把尺 ----
  var g2 = combo('多选题', 4, [], 'A');
  var g2Letters = (g2.group || '').split(',');
  var g2Ok = g2.why === 'ok' && g2Letters.length >= 2 && g2.group === app._popupQuizLetterGroup(g2.group) &&
    g2Letters.every(function (ch) { return /^[A-Z]$/.test(ch) && ch.charCodeAt(0) - 64 <= clickBound; });
  var g1 = combo('单选题', 4, [], 'A');
  check('② 四选项的真多选题本地兜底交出「' + g2.group + '」：至少两格、是本文件尺的规范形（`_popupQuizLetterGroup` 原样认回、排序去重带逗号）、每一枚都不超过填答尺第 ' + clickBound + ' 枚；判断题/单选题按题型名交回空串（`why` 点名为什么没凑）',
    g2Ok && g1.group === '',
    JSON.stringify({ multiple: g2, single: g1, clickBound: clickBound, canonicalRoundTrip: app._popupQuizLetterGroup(g2.group) }));

  // ---- ③ 转尺那一格承重（AGENTS §2 #18）----
  // 名单在本文件是带逗号形 `"A,B"`，而 `_expandMultiChoiceLetters` 内部比的是不带逗号形 `"AB"`。
  // 摘掉转换，"避开已判错的组合"就永久为空：不报错、不留日志，只是每一轮又交出同一组。
  var g3 = combo('多选题', 4, ['A,B'], 'A');
  var bannedForm = ['A,B'].map(function (v) { return app._canonicalQuizAnswer(v, 'multiple'); });
  check('③ 名单里躺着 `"A,B"`（本文件的带逗号形）时，产出的组合不再是 A,B（实交「' + g3.group + '」）—— 因为喂给补组合那一族之前先过 `_canonicalQuizAnswer` 收敛成不带逗号形「' + bannedForm.join('/') + '」；不转尺就比不中、下一轮照旧交同一组（现场表现：这道多选弹题一直在转）',
    g3.why === 'ok' && g3.group !== 'A,B' && app._canonicalQuizAnswer(g3.group, 'multiple') !== 'AB',
    JSON.stringify({ bannedRaw: ['A,B'], bannedCanonical: bannedForm, got: g3 }));

  // ---- ④ 闭环：这一轮交出去的那一组，下一轮（平台判错、记进名单之后）必须换 ----
  var round1 = combo('多选题', 5, [], 'A');
  var asLedger = [app._popupQuizLetterGroup(round1.group)];   // `_notePopupQuizRejected` 记的就是这一形
  var round2 = combo('多选题', 5, asLedger, 'A');
  var commaFree = app._canonicalQuizAnswer(round1.group, 'multiple');
  check('④ 填完之后平台判错、名单里多出这一组，下一轮本地兜底换得出**别的一组**（round1 ' + round1.group + ' → round2 ' + round2.group + '），且那一条记进名单时经 `_canonicalQuizAnswer` 出来的就是补组合那一族比的那一形（' + JSON.stringify(commaFree) + '，不带逗号）—— 记账与避让必须是同一把尺，否则「换一组」这句承诺是空的',
    round2.why === 'ok' && round2.group !== round1.group && commaFree === String(round1.group).replace(/,/g, '') &&
      commaFree.indexOf(',') === -1 && round2.group.split(',').length >= 2,
    JSON.stringify({ round1: round1, ledger: asLedger, round2: round2, canonical: commaFree }));

  // ---- ⑤ 不定项与认不出题型的不凑（凭空多补一项＝造一个没人给的答案）----
  var free1 = combo('不定项选择题', 4, [], 'A');
  var unknown = combo('', 4, [], 'A');
  check('⑤ 不定项（站点允许只选一项）与认不出题型的一律不接手：`group` 交回空串、`why` 点名 min-1 —— 照真多选补第二格就是把一个没人给的答案交上去，那正是 75 片段里写明「不能一律钉成 2」的来源',
    free1.group === '' && free1.why === 'min-1' && unknown.group === '' && unknown.why === 'min-1',
    JSON.stringify({ budingxiang: free1, unknownType: unknown }));

  // ---- ⑥ 全被判过 / 只剩点不动的字母时不接手（调用方保留原来那一枚，行为不后退）----
  var allPairs = ['A,B', 'A,C', 'A,D', 'B,C', 'B,D', 'C,D'];
  var exhausted = combo('多选题', 4, allPairs, 'A');
  // 七选项、起步那枚是第 6 枚 F：补组合那一族给 F 找的第一个邻居正是第 7 枚 G。
  // 不摘掉那把 A–F 尺时这里交回的该是别的组合；摘掉它就交出 `F,G` —— 填答那一路读不出字母、
  // 整串退化成"选项原文"，一个选项都不会被点（比不接手更糟）。
  var seedF7 = combo('多选题', 7, [], 'F');
  check('⑥ 四选项的两两组合全被判过时交回空串（`why=all-banned`，此时调用方仍填原来那一枚，不是"这道干脆不做"）；七选项里起步第 6 枚 F 时不交含第 7 枚的组合（填答尺只认到第 ' + clickBound + ' 枚，' + JSON.stringify(seedF7.group) + ' 里不许出现点不动的字母）',
    exhausted.group === '' && exhausted.why === 'all-banned' && seedF7.group !== 'F,G' &&
      seedF7.group.split(',').every(function (ch) { return ch.charCodeAt(0) - 64 <= clickBound; }),
    JSON.stringify({ allBanned: exhausted, seedF7: seedF7, clickBound: clickBound }));

  // ---- ⑦ 单选/判断一条不动：接手条件由 type 与「有没有真组合」两半共同决定 ----
  var judgeRoot = combo('判断题', 2, [], 'A');
  var noSeed = combo('多选题', 0, [], 'G');
  check('⑦ 本地兜底只在 `type` 是 multiple 时问一次凑组，且只有真凑出组合才替换那一枚（静态钉住这两行：少了前者判断题也被改，少了后者空串会把唯一能点的那格丢掉）；判断题形状自己只交回空串，一个可用字母都认不出来时也交回空串（`why=no-seed`，绝不猜）',
    wired && guard && judgeRoot.group === '' && judgeRoot.why === 'min-1' &&
      noSeed.group === '' && noSeed.why === 'no-seed',
    JSON.stringify({ ternaryInCaller: wired, emptyGuard: guard, judge: judgeRoot, noSeed: noSeed }));
}

/** ---- [25] 批次 97：换课前问一轮课程首页 —— 判据真跑、顺序冻结、三端超时嵌套 ---- */
/**
 * 为什么这一段每条都要从盘上取真实那一份来跑：判据住在 `background.js` 的 IIFE 里，
 * 抄进测试就等于两边各拿一把尺，改生产阈值时测试不会跟着红（AGENTS §5）。
 * ⚠️ 本段之前 `classifyCourseHome` **从没被任何断言真跑过** —— 现场那份四态
 * （`notes/census-97-full.md`）是探针记下的计数器按同一判定顺序**重算**的，
 * 那个区别要紧：重算证明"当时那 38 页读回来该怎么判"，不证明"这段代码现在还那么判"。
 */
async function testCourseHomeProbeSignals() {
  console.log('\n[25] 课程首页进度探针：六格真值表 + 顺序冻结 + 字节解码 + payload 卫生 + 串行预算 + 三端超时嵌套（批次 97）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var bg = read('background.js');
  var cnt = read('content.js');
  var shell = read('src/page/00-shell-constants.js');
  var loop = read('src/page/64-tasks-loop.js');

  // 后台那几件是顶层 function，只在这一层缩进闭合；抓过了头就交白卷，宁可不跑
  var topFnText = function (src, name) {
    var at = src.indexOf('\n  function ' + name + '(');
    if (at < 0) return null;
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n  }', start);
    if (end < 0) return null;
    var text = src.slice(start, end + 4);
    return text.indexOf('\n  function ') >= 0 ? null : text;
  };
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  var evalNum = function (expr) {
    try { return Number(new Function('return (' + expr + ')')()); } catch (e) { return null; }
  };
  var numVar = function (src, name) {
    var m = src.match(new RegExp('var ' + name + ' = ([^;\\n]+);'));
    return m ? evalNum(m[1]) : null;
  };
  var codeOf = function (src) {
    var out = String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
    return out.replace(/(^|[^:])\/\/[^\n]*/g, function (m, prefix) {
      return prefix + new Array(m.length - prefix.length + 2).join(' ');
    });
  };

  // ---- 后台判据那一族：常量 + 四个顶层函数原样搬进一个闭包里跑 ----
  var varsAt = bg.indexOf('var COURSE_HOME_BASE');
  var varsEnd = bg.indexOf(';', bg.indexOf('var COURSE_PROBE_BODY_MAX', varsAt));
  var varsBlock = (varsAt >= 0 && varsEnd > varsAt) ? bg.slice(varsAt, varsEnd + 1) : '';
  var fClass = topFnText(bg, 'classifyCourseHome');
  var fDecode = topFnText(bg, 'decodeCourseHomeBody');
  var fProbe = topFnText(bg, 'probeCourseHome');
  var fBatch = topFnText(bg, 'courseHomeProbe');
  check('⓪ 后台那一族取得出完整四件（分类器 / 字节解码 / 单门探测 / 串行批）—— 取不全就整段不跑，那种"绿"是零覆盖',
    !!(varsBlock && fClass && fDecode && fProbe && fBatch),
    JSON.stringify({ vars: !!varsBlock, classify: !!fClass, decode: !!fDecode, probe: !!fProbe, batch: !!fBatch }));

  var sent = [];            // 每发探测的 {url, ms}
  var sentLimit = [];       // readLimited 收到的正文上限（拿去与常量比，不写死数字）
  var inflight = 0, maxInflight = 0;
  var fakeNow = 1700000000000;
  var responder = function () { return { html: '', status: 200, stepMs: 50 }; };
  // `failure()` 是后台 IIFE 里那一行的信封构造器（单行函数，顶层抓取器抓不到），
  // 这里只需它**不带 verdict** —— 生产正是靠"没有 verdict"落到「读不出」那一格。
  var failureStub = function (code, error) { return { success: false, code: code, error: error || code }; };
  var timedFetchStub = function (url, options, ms, consume) {
    sent.push({ url: url, ms: ms });
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    var resp = responder(url) || {};
    return Promise.resolve().then(function () {
      inflight--;
      if (resp.hang) { var f = failureStub('timeout', '请求超时'); f.status = resp.status || 0; return f; }
      fakeNow += (typeof resp.stepMs === 'number' ? resp.stepMs : 50);
      return consume({
        status: resp.status || 200,
        headers: { get: function () { return null; } },
        __html: resp.html
      });
    });
  };
  var readLimitedStub = function (response, limit) {
    sentLimit.push(limit);
    return Promise.resolve(new TextEncoder().encode(String(response.__html)));
  };

  var harness = null;
  try {
    harness = new Function('timedFetch', 'readLimited', 'failure', 'Date',
      'return (function () {\n' + varsBlock + '\n' + fClass + '\n' + fDecode + '\n' + fProbe + '\n' + fBatch +
      '\n  return { classify: classifyCourseHome, decode: decodeCourseHomeBody, probe: probeCourseHome,' +
      ' batch: courseHomeProbe, consts: function () { return { base: COURSE_HOME_BASE, limit: COURSE_PROBE_LIMIT,' +
      ' fetchMs: COURSE_PROBE_FETCH_MS, budgetMs: COURSE_PROBE_BUDGET_MS, bodyMax: COURSE_PROBE_BODY_MAX,' +
      ' idRe: String(COURSE_ID_RE) }; } };\n})()')(
      timedFetchStub, readLimitedStub, failureStub, { now: function () { return fakeNow; } });
  } catch (eHarness) { harness = null; }
  if (!harness) {
    check('⓪-b 后台那一族能拼成可跑的闭包（拼不出来这段一条都不算跑过）', false, String(eHarness && eHarness.message || eHarness));
    return;
  }
  var KC = harness.consts();

  // ---- 夹具：按站点自己的写法长出来的一页课程首页（合成号，不带真实课程）----
  var homeHtml = function (o) {
    o = o || {};
    var s = '<html><head>';
    if (o.enc !== 'none') s += '<script>var enc = "' + (o.enc || '0a1b2c3d4e5f') + '";</script>';
    s += '</head><body>';
    var n = o.toOld || 0;
    for (var i = 0; i < n; i++) s += '<a href="javascript:void(0)" onclick="toOld(\'' + (100 + i) + '\', \'' + (200 + i) + '\', \'' + (300 + i) + '\')">节</a>';
    for (var y = 0; y < (o.yi || []).length; y++) s += '<span class="catalog_points_yi">' + o.yi[y] + '</span>';
    for (var d = 0; d < (o.done || 0); d++) s += '<span class="catalog_state icon_yiwanc">已</span>';
    for (var p = 0; p < (o.prog || 0); p++) s += '<span class="catalog_jindu">中</span>';
    if (o.jobs) s += '<div class="catalog_ressbar">已完成任务点：' + o.jobs + '</div>';
    if (o.empty) s += '<p>暂无章节内容</p>';
    if (o.denied) s += '<p>很抱歉，您没有权限访问这个页面</p>';
    if (o.login) s += '<p>请登录</p>';
    return s + '</body></html>';
  };

  // ---- ① 六格真值表：每格钉一个现场形状 ----
  var vNeed = harness.classify(homeHtml({ jobs: '42 / 88', toOld: 22, done: 21, prog: 26 }));
  check('① 站点自己写「已完成任务点 42 / 88」→ 判「还要刷」（现场：戏剧鉴赏）',
    vNeed.verdict === 'need' && vNeed.why === 'jobs' && vNeed.jobsDone === 42 && vNeed.jobsAll === 88,
    JSON.stringify(vNeed));
  var vDone = harness.classify(homeHtml({ jobs: '72 / 72', toOld: 74, done: 74, prog: 1 }));
  check('① 同一格写成「72 / 72」→ 判「已完成」，且进度条那一类行信号（74 行打勾 + 1 行进行中）不许把它翻过去',
    vDone.verdict === 'done' && vDone.why === 'jobs-all-done', JSON.stringify(vDone));
  var vNone = harness.classify(homeHtml({ jobs: '0 / 0', toOld: 5, prog: 6 }));
  check('① 「0 / 0」而目录不空（5 个可点章节、6 行进行中）→ 判「这一门没有任务点」，**不许**当成刷完了（现场：数据结构）—— 误判成已完成等于永久不再进门',
    vNone.verdict === 'nopoints' && vNone.why === 'zero-task-points', JSON.stringify(vNone));
  var vEmpty = harness.classify(homeHtml({ jobs: '0 / 0', empty: true }));
  check('① 站点原话「暂无章节内容」→ 单独一格「目录为空」，哪怕同一页也写着「0 / 0」也轮不到它说话（现场：数据库原理及应用 / 安全知识竞赛）',
    vEmpty.verdict === 'empty' && vEmpty.why === 'site-says-no-catalog', JSON.stringify(vEmpty));
  var v403 = harness.classify(homeHtml({ denied: true, jobs: '0 / 10', toOld: 3 }));
  var vLogin = harness.classify(homeHtml({ login: true }));
  var vEnc = harness.classify(homeHtml({ enc: 'none', jobs: '3 / 10', toOld: 4 }));
  var vNode = harness.classify(homeHtml({ jobs: '3 / 10', toOld: 0 }));
  check('② 四种「进不去」各点名各的原因（403 说自己班号 / 短登录页 / 没有 enc / 没有可点节点）—— 少任何一格都会被读成"这门刷完了"',
    v403.why === 'server-denied-check-own-clazzid' && vLogin.why === 'need-login' &&
      vEnc.why === 'no-enc' && vNode.why === 'no-clickable-node' &&
      v403.verdict === 'blocked' && vLogin.verdict === 'blocked' &&
      vEnc.verdict === 'blocked' && vNode.verdict === 'blocked',
    JSON.stringify({ denied: v403.why, login: vLogin.why + '/' + vLogin.len, enc: vEnc.why, node: vNode.why }));
  var vUnread = harness.classify(homeHtml({ toOld: 3, done: 1, prog: 0, yi: [0, 0] }));
  check('② 什么信号都不闭合（3 个可点章节 vs 1 行打勾 + 0 行进行中）→ 判「读不出」并继续许它进门，**绝不猜成已完成**（AGENTS §2 #12：读不出必须单独占一格）',
    vUnread.verdict === 'unreadable' && vUnread.why === 'no-signal-closes', JSON.stringify(vUnread));

  // ---- ③ 求和 vs 数格子（批次 94 那一轮就错在这一格）----
  var vSum = harness.classify(homeHtml({ toOld: 6, yi: [5, 7], done: 1, prog: 1 }));
  var vZeros = harness.classify(homeHtml({ toOld: 5, yi: [0, 0, 0, 0, 0], prog: 6 }));
  check('③ `catalog_points_yi` 读的是**每行那个数字并求和**，不是数出现几次：两格 5/7 → 12（格数 2），五格全 0 → 0（格数 5 照样不算进度）—— 数格子会凭空造出进度（现场：离散数学 121 格真值 279 / 实用语文 51 格真值 131）',
    vSum.yi === 12 && vSum.yiCells === 2 && vSum.verdict === 'need' && vSum.why === 'row-pending-points' &&
      vZeros.yi === 0 && vZeros.yiCells === 5,
    JSON.stringify({ sum: { yi: vSum.yi, cells: vSum.yiCells }, zeros: { yi: vZeros.yi, cells: vZeros.yiCells } }));
  var vRows = harness.classify(homeHtml({ toOld: 72, done: 72, prog: 0 }));
  var vRowsNeed = harness.classify(homeHtml({ toOld: 141, done: 80, prog: 61 }));
  check('③ 老模板那两门（站点没写「已完成任务点」）靠**行分解闭合**判：72 打勾 + 0 进行中 = 72 个可点章节 → 已完成；80 + 61 = 141 → 还要刷；分解不闭合就退回读不出（上面那条）—— 三格共用同一把尺，差一行都不许报结论',
    vRows.verdict === 'done' && vRows.why === 'rows-all-checked' &&
      vRowsNeed.verdict === 'need' && vRowsNeed.why === 'rows-in-progress',
    JSON.stringify({ done: { d: vRows.doneRows, p: vRows.progRows, t: vRows.toOld, v: vRows.verdict }, need: { d: vRowsNeed.doneRows, p: vRowsNeed.progRows, t: vRowsNeed.toOld, v: vRowsNeed.verdict } }));

  // ---- ④ 顺序冻结：两种信号同时在场时，谁先说话由这段代码决定 ----
  var vBoth1 = harness.classify(homeHtml({ jobs: '63 / 63', yi: [9, 9], done: 0, prog: 9, toOld: 9 }));
  var vBoth2 = harness.classify(homeHtml({ jobs: '42 / 88', yi: [7], done: 0, prog: 0, toOld: 1 }));
  check('④ 「已完成任务点 X/Y」必须**排在**行信号之前：63/63 那一页哪怕挂着 18 个待完成点与 9 行进行中，也照站点总数判已完成；42/88 那一页 `why` 必须是 `jobs`，不许是行信号那一族（AGENTS §2 #5 同一族：判断顺序就是仲裁顺序）',
    vBoth1.verdict === 'done' && vBoth1.why === 'jobs-all-done' && vBoth1.yi === 18 &&
      vBoth2.verdict === 'need' && vBoth2.why === 'jobs',
    JSON.stringify({ bothDone: { v: vBoth1.verdict, why: vBoth1.why, yi: vBoth1.yi }, bothNeed: { v: vBoth2.verdict, why: vBoth2.why } }));

  // ---- ⑤ 字节 ≠ 字符串（批次 97 第一版踩的那一格）----
  var htmlStr = homeHtml({ jobs: '30 / 33', toOld: 25, done: 22, prog: 4 });
  var bytes = new TextEncoder().encode(htmlStr);
  var vBytes = harness.classify(bytes);
  var vDecoded = harness.classify(harness.decode(bytes));
  check('⑤ 探测拿到的是**字节流**：直接喂给判据只能落「空回包」那一格（不许把字节 `String()` 成 "60,33,68…" 再判 —— 那会把每一门都读成进不去）；先过解码器才与字符串同解（现场：程序设计基础 30/33）',
    vBytes.verdict === 'unreadable' && vBytes.why === 'empty-response' &&
      vDecoded.verdict === 'need' && vDecoded.jobs === '30/33',
    JSON.stringify({ rawBytes: { v: vBytes.verdict, why: vBytes.why }, decoded: { v: vDecoded.verdict, jobs: vDecoded.jobs } }));

  // ---- ⑥ payload 卫生：这一发带着用户 cookie 出门 ----
  sent.length = 0;
  var bad = [];
  bad.push(await harness.batch({ list: [{ cid: '700001', clazz: '900002', url: 'https://evil.example/' }], }));
  bad.push(await harness.batch({ list: [{ cid: '700001', clazz: '900002' }], extra: 1 }));
  bad.push(await harness.batch({ list: [{ cid: '700001', clazz: '别的课的班号' }] }));
  bad.push(await harness.batch({ list: [] }));
  bad.push(await harness.batch([]));
  var allRejected = bad.every(function (r) { return r && r.success === false && r.code === 'invalid_payload'; });
  check('⑥ payload 逐键白名单：条目多带 `url`、顶层多带键、班号不是纯数字、空清单、整体是数组 —— 五形一律拒收（`invalid_payload`），一个请求都不发。课号班号必须**成对**来自同一张卡片：拿别的课的班号站点直接回 403（AGENTS §2 #12）',
    allRejected && sent.length === 0,
    JSON.stringify({ codes: bad.map(function (r) { return r && r.code; }), fetched: sent.length }));

  // ---- ⑦ 地址只在后台拼 + 单页上限是真源那个数 ----
  sent.length = 0;
  var okRows = await harness.batch({ list: [{ cid: '700001', clazz: '900002' }, { cid: '700003', clazz: '900004' }] });
  check('⑦ 出门那条地址由后台拼：以真源 `COURSE_HOME_BASE` 开头、带得上这两门的课号与班号；单页正文上限用的就是常量那个数（不从测试里抄数字）',
    okRows.success === true && sent.length === 2 &&
      sent.every(function (s) { return s.url.indexOf(KC.base) === 0 && /\d{6}/.test(s.url); }) &&
      sentLimit.length === 2 && sentLimit.every(function (l) { return l === KC.bodyMax; }),
    JSON.stringify({ base: KC.base, url0: sent[0] && sent[0].url, limits: sentLimit, bodyMax: KC.bodyMax }));

  // ---- ⑧ 串行 + 预算：并发必须恒为 1，预算到点把没问到的记成 skip ----
  maxInflight = 0;
  var many = [];
  for (var mi = 0; mi < 6; mi++) many.push({ cid: String(700001 + mi), clazz: String(900001 + mi) });
  responder = function () { return { html: homeHtml({ jobs: '1 / 9', toOld: 2 }), status: 200, stepMs: 9000 }; };
  var slow = await harness.batch({ list: many });
  var skipRows = slow.rows.filter(function (r) { return r.verdict === 'skip'; });
  check('⑧ 六门串行（同时在飞的最多 1 发 —— 新开第二枚学习页会把前一门顶下线，AGENTS §2 #15），整轮预算一到就把剩下的记成 `skip/budget` 并**照常交回同样条数**，绝不让换课被探针拖死',
    maxInflight === 1 && slow.rows.length === many.length && slow.asked === many.length &&
      skipRows.length > 0 && skipRows.every(function (r) { return r.why === 'budget'; }),
    JSON.stringify({ maxInflight: maxInflight, rows: slow.rows.length, asked: slow.asked, skipped: skipRows.length, ms: slow.ms }));

  // ---- ⑨ 回不来 ≠ 进不去：两格分开 ----
  sent.length = 0;
  responder = function () { return { hang: true }; };
  var hung = await harness.batch({ list: [{ cid: '700009', clazz: '900009' }] });
  responder = function () { return { html: homeHtml({ toOld: 3, done: 1 }), status: 500 }; };
  var http5 = await harness.batch({ list: [{ cid: '700010', clazz: '900010' }] });
  check('⑨ 压根没拿到回话（超时）判「读不出」并点名 `timeout`；HTTP 非 200 而正文里一个认识的信号都没有判「进不去」并点名 `http-500` —— 两格混了，用户就会把"网络断了"听成"这门课没权限"',
    hung.rows.length === 1 && hung.rows[0].verdict === 'unreadable' && hung.rows[0].why === 'timeout' &&
      http5.rows[0].verdict === 'blocked' && http5.rows[0].why === 'http-500',
    JSON.stringify({ hang: hung.rows[0] && { v: hung.rows[0].verdict, why: hung.rows[0].why }, http5: http5.rows[0] && { v: http5.rows[0].verdict, why: http5.rows[0].why } }));
  responder = function () { return { html: homeHtml({ jobs: '1 / 9', toOld: 2 }), status: 200 }; };

  // ---- ⑩ 三端超时嵌套：从三份真源读回来比大小，不写死 ----
  var PENDING = numVar(shell, 'COURSE_PROBE_PENDING_MS');
  var FRESH = numVar(shell, 'COURSE_PROBE_FRESH_MS');
  var ASK = numVar(shell, 'COURSE_PROBE_ASK_MS');
  var DEFER = numVar(shell, 'COURSE_PROBE_DEFER_MS');
  var SPOKE = numVar(shell, 'COURSE_PROBE_SPOKE_MS');
  var bridgeM = cnt.match(/type: 'course_home_probe',\s*payload: msg\.payload \}, (\d+)/);
  var BRIDGE = bridgeM ? Number(bridgeM[1]) : null;
  check('⑩ 超时由外向内一层比一层长：后台最坏（整轮预算 ' + KC.budgetMs + ' + 单页 ' + KC.fetchMs + '）< 桥 ' + BRIDGE + ' < 页面 ' + ASK + '，且等待上限 ' + DEFER + ' < 页面那一头 —— 外面比里面短就等于**永远拿不到真答案**（AGENTS §2 #2：只有超时能救挂起）',
    BRIDGE !== null && ASK !== null && DEFER !== null && KC.budgetMs + KC.fetchMs < BRIDGE &&
      BRIDGE < ASK && DEFER < ASK && PENDING > 0 && FRESH > ASK && SPOKE > 0,
    JSON.stringify({ fetch: KC.fetchMs, budget: KC.budgetMs, bridge: BRIDGE, ask: ASK, defer: DEFER, pending: PENDING, fresh: FRESH, spoke: SPOKE }));

  // ---- 页面侧：计数格位 / 权重只重排 / 键形状一致 / 等待会说话 ----
  var logs = [];
  var emit = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
  var rankM = loop.match(/_COURSE_PROBE_RANK: \{([^}]*)\}/);
  var RANK = rankM ? (new Function('return ({' + rankM[1] + '})'))() : null;
  var asks = [];
  var app = {
    _COURSE_PROBE_RANK: RANK,
    _courseProbeCounts: buildFrom(loop, '_courseProbeCounts', {}),
    _courseProbeWeight: buildFrom(loop, '_courseProbeWeight', {}),
    _orderBlindByProbe: buildFrom(loop, '_orderBlindByProbe', {}),
    _courseProbeDeferred: buildFrom(loop, '_courseProbeDeferred', {
      emitRuntimeLog: emit, COURSE_PROBE_DEFER_MS: DEFER, COURSE_PROBE_SPOKE_MS: SPOKE
    }),
    _askCourseProbe: buildFrom(loop, '_askCourseProbe', {
      bridgeSend: function (type, payload) { asks.push({ type: type, payload: payload }); return Promise.resolve(askAnswer); },
      COURSE_PROBE_PENDING_MS: PENDING, COURSE_PROBE_FRESH_MS: FRESH, COURSE_PROBE_ASK_MS: ASK
    }),
    _withTimeout: function (p) { return p; }
  };
  var pageReady = !!(RANK && app._courseProbeCounts && app._courseProbeWeight && app._orderBlindByProbe &&
    app._courseProbeDeferred && app._askCourseProbe);
  check('⑩-b 页面侧五件都从 `src/page/64-tasks-loop.js` 取出来跑（取不全就整段不跑，那种绿是零覆盖）', pageReady,
    JSON.stringify({ rank: !!RANK, counts: !!app._courseProbeCounts, weight: !!app._courseProbeWeight, order: !!app._orderBlindByProbe, deferred: !!app._courseProbeDeferred, ask: !!app._askCourseProbe }));
  if (!pageReady) return;

  // ⑪ 数不清单独占一格，而且那一格是 -1 不是 0
  app._courseProbeCache = null;
  var c0 = app._courseProbeCounts();
  app._courseProbeCache = { pendingAt: 1, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
  var c1 = app._courseProbeCounts();
  app._courseProbeCache = { pendingAt: 0, at: 2, answered: true, ok: false, rows: {}, asked: 0, ms: -1, why: 'invalid_payload' };
  var c2 = app._courseProbeCounts();
  app._courseProbeCache = { pendingAt: 0, at: 3, answered: true, ok: true, asked: 4, ms: 120, rows: {
    '1:a': { verdict: 'need' }, '2:b': { verdict: 'done' }, '3:c': { verdict: '啥都不认识' }, '4:d': { verdict: 'skip', why: 'budget' } } };
  var c3 = app._courseProbeCounts();
  var minus = ['pRows', 'pNeed', 'pDone', 'pNoPts', 'pUnread', 'pBlocked', 'pEmpty', 'pSkip'];
  check('⑪ 「还没问 / 还在问 / 问了问不出」三格各自点名，且计数一律是 **-1 而不是 0**（`0` 在日志里读起来就是"确认没有还要刷的门"，方向是放行）；后台给出不认识的判法时**并进「读不出」那一格**，绝不落进已完成',
    c0.pAsk === 'no' && minus.every(function (k) { return c0[k] === -1; }) &&
      c1.pAsk === 'pending' && minus.every(function (k) { return c1[k] === -1; }) &&
      c2.pAsk === 'fail' && c2.pWhy === 'invalid_payload' &&
      c3.pAsk === 'ok' && c3.pRows === 4 && c3.pNeed === 1 && c3.pDone === 1 && c3.pSkip === 1 && c3.pUnread === 1,
    JSON.stringify({ no: c0, pending: c1, fail: c2, ok: c3 }));

  // ⑫ 权重只重排、绝不丢行；判法相同的门靠排序稳定性保住卡片顺序
  var cards = [
    { courseId: '1', clazzId: 'a' }, { courseId: '2', clazzId: 'b' },
    { courseId: '3', clazzId: 'c' }, { courseId: '4', clazzId: 'd' },
    { courseId: '5', clazzId: 'e' }, { courseId: '6', clazzId: 'f' }
  ];
  app._courseProbeCache = { pendingAt: 0, at: 4, answered: true, ok: true, asked: 6, ms: 200, rows: {
    '1:a': { verdict: 'done', jobsAll: 10, jobsDone: 10 },
    '2:b': { verdict: 'empty' },
    '3:c': { verdict: 'need', jobsAll: 88, jobsDone: 42 },
    '4:d': { verdict: 'need', jobsAll: 100, jobsDone: 0 },
    '5:e': { verdict: 'blocked' },
    '6:f': { verdict: 'nopoints' } } };
  var ordered = app._orderBlindByProbe(cards);
  var ids = ordered.map(function (o) { return o.card.courseId; });
  var wOf = function (id) { for (var i = 0; i < ordered.length; i++) if (ordered[i].card.courseId === id) return ordered[i].weight; return null; };
  // 没答过的门（缓存里没有它）必须落在「读不出」那一桶，照旧许它进门
  var orphan = app._courseProbeWeight(null);
  check('⑫ 探针**只改挑谁的顺序、不把任何一门从名单里删掉**：六门进六门出；差得最多的先挑（0/100 排在 42/88 前），已完成与目录为空排到最后，站点说没有任务点的那门排在已完成之前（它只是没活，不是刷完了）；缓存里压根没有的那门落在「读不出」桶（' + orphan + '），照旧许进门',
    ordered.length === cards.length && ids.join(',') === '4,3,6,1,5,2' &&
      wOf('4') < wOf('3') && wOf('3') < wOf('6') && wOf('6') < wOf('1') && wOf('1') < wOf('2') &&
      orphan === RANK.unreadable * 1000,
    JSON.stringify({ order: ids, weights: ordered.map(function (o) { return o.card.courseId + '=' + o.weight; }), rank: RANK, orphan: orphan }));

  // ⑬ 写进去的键与读出来的键必须是同一形状（不同形 = 探针答了但挑选永远读不到，且一声不响）
  var askAnswer = { success: true, asked: 2, ms: 90, rows: [
    { cid: '700001', clazz: '900002', verdict: 'need', jobsAll: 50, jobsDone: 1 },
    { cid: '700003', clazz: '900004', verdict: 'done', jobsAll: 9, jobsDone: 9 } ] };
  app._courseProbeCache = null;
  var blindCards = [{ courseId: 700001, clazzId: 900002 }, { courseId: 700003, clazzId: 900004 }];
  var askReturn = app._askCourseProbe.call(app, fakeNow, blindCards);
  await new Promise(function (r) { setTimeout(r, 10); });
  var askOrder = app._orderBlindByProbe.call(app, blindCards);
  var askIds = askOrder.map(function (o) { return o.card.courseId; });
  check('⑬ 问出去那一发只交课号与班号（不发地址、不发课程名），答回来按课号排进缓存；**写缓存用的键与挑选读的键是同一形状** —— 700001 那门被认成「还要刷」并排到 700003 之前（键形状一变就成了"探针答了但挑选永远读不到"，不报错、不留日志）',
    askReturn === undefined && asks.length === 1 && asks[0].type === 'course_home_probe' &&
      asks[0].payload.list.length === 2 &&
      Object.keys(asks[0].payload.list[0]).sort().join(',') === 'cid,clazz' &&
      String(asks[0].payload.list[0].url) === 'undefined' &&
      app._courseProbeCache.answered === true && app._courseProbeCache.ok === true &&
      app._courseProbeCache.asked === 2 && askIds.join(',') === '700001,700003' &&
      askOrder[0].row.verdict === 'need' && askOrder[1].row.verdict === 'done',
    JSON.stringify({ asks: asks.map(function (a) { return { type: a.type, keys: Object.keys(a.payload.list[0]) }; }), cache: { answered: app._courseProbeCache.answered, ok: app._courseProbeCache.ok, asked: app._courseProbeCache.asked, rows: Object.keys(app._courseProbeCache.rows) }, order: askIds }));

  // ⑭ 还在问那一格：认领这一拍、说一句话、但不锁死这一页
  logs.length = 0;
  var pickDoneBefore = false;
  app._coursePickDone = pickDoneBefore;
  app._courseProbeSpokeAt = 0;
  app._courseProbeCache = { pendingAt: 5000, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
  var defer1 = app._courseProbeDeferred.call(app, 5000 + Math.floor(DEFER / 2), 32);
  var deferSame = app._courseProbeDeferred.call(app, 5000 + Math.floor(DEFER / 2), 32);
  var spoke = logs.filter(function (l) { return l.message === 'course switch probing course homes'; });
  var hint = spoke.length === 1 ? String(spoke[0].meta.hint || '') : '';
  var hintSec = (hint.match(/最多等 (\d+) 秒/) || [])[1];
  check('⑭ 「还在问」那一格：**说话 + 认领这一拍**，但**不置** `_coursePickDone`（置了就等于这一页从此不再挑课）；同一拍再进来不许重复刷屏（`everyMs: 0` = 这句话每页只说一次）；hint 里那句「最多等 N 秒」的 N 必须等于真源那个等待上限换算的秒数（文档与判据同源，AGENTS §3 那条数字承诺）',
    defer1 === true && deferSame === true && spoke.length === 1 &&
      spoke[0].meta.everyMs === 0 && app._coursePickDone === pickDoneBefore &&
      hintSec !== undefined && Number(hintSec) === Math.round(DEFER / 1000),
    JSON.stringify({ defer1: defer1, deferSame: deferSame, spoke: spoke.length, everyMs: spoke[0] && spoke[0].meta.everyMs, pickDone: app._coursePickDone, hintSec: hintSec, deferMs: DEFER }));

  // ⑮ 等待有界：预算一到就照手里有的挑，而且这句话不许把答案锁死
  logs.length = 0;
  app._courseProbeCache = { pendingAt: 1000, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
  var deferPast = app._courseProbeDeferred.call(app, 1000 + DEFER, 32);
  app._courseProbeCache = { pendingAt: 0, at: 9, answered: true, ok: true, rows: {}, asked: 1, ms: 10, why: '' };
  var deferAnswered = app._courseProbeDeferred.call(app, 9, 32);
  app._courseProbeCache = null;
  var deferNoCache = app._courseProbeDeferred.call(app, 9, 32);
  check('⑮ 等待**有界**：预算一到就交回 false（照手里有的挑，探针再慢也不许把换课钉死在这一页）；已经答上来的那一格交回 false（该往下走了）；压根没问过的也交回 false（说话那一格只管"还在问"，别顺手把没问过的也认领走 —— 那一族由上面几条兜底）',
    deferPast === false && deferAnswered === false && deferNoCache === false && logs.length === 0,
    JSON.stringify({ past: deferPast, answered: deferAnswered, noCache: deferNoCache, logs: logs.length }));

  // ⑯ 顺序承诺的那句话与桶号一致（改桶号忘改句子 = 日志骗人）
  var SAY_ORDER = ['还要刷', '读不出', '没有任务点', '已完成', '进不去', '目录为空'];
  var verdictOfWord = { '还要刷': 'need', '读不出': 'unreadable', '没有任务点': 'nopoints', '已完成': 'done', '进不去': 'blocked', '目录为空': 'empty' };
  logs.length = 0;
  app._courseProbeSpokeAt = 0;
  app._courseProbeCache = { pendingAt: 2000, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
  app._courseProbeDeferred.call(app, 2000 + 1000, 5);
  var orderHint = logs.length === 1 ? String(logs[0].meta.hint || '') : '';
  var positions = SAY_ORDER.map(function (w) { return orderHint.indexOf(w); });
  var buckets = SAY_ORDER.map(function (w) { return RANK[verdictOfWord[w]]; });
  var ascending = buckets.every(function (b, i) { return i === 0 || b >= buckets[i - 1]; });
  check('⑯ hint 里承诺的判法顺序「还要刷 → 读不出 → 没有任务点 → 已完成 → 进不去 → 目录为空」必须与 `_COURSE_PROBE_RANK` 的桶号同向（' + buckets.join('/') + '）—— 桶号改了而句子没改，用户按那句理解现场就被引到错方向（AGENTS §3 那条「行为改了文档没改」唯一的失败形状）',
    positions.every(function (p) { return p >= 0; }) &&
      positions.every(function (p, i) { return i === 0 || p > positions[i - 1]; }) && ascending &&
      orderHint.indexOf('只改挑谁的顺序') >= 0,
    JSON.stringify({ positions: positions, buckets: buckets, count: logs[0] && logs[0].meta.hint ? String(logs[0].meta.hint).slice(0, 20) : '' }));

  // ⑰ 调用点顺序与「不 await」：判定那一拍的返回值就是认领与否
  var pickBody = codeOf(bodyOf(loop, '_pickNextCourseFromUserCenter'));
  var askBody = codeOf(bodyOf(loop, '_askCourseProbe'));
  var callAt = pickBody.indexOf('this._askCourseProbe(');
  var deferAt = pickBody.indexOf('this._courseProbeDeferred(');
  var orderAt = pickBody.indexOf('this._orderBlindByProbe(');
  check('⑰ 调用点顺序钉住：先问（不 await）、再看要不要为它等这一拍、最后才排队挑课 —— 三行各在彼此之后（少了 defer 那一行就会拿空缓存排序，少了排序就等于探针白问）；`_askCourseProbe` 体内一个 `await` 都不许有（那个返回值是"这一拍认领了没有"，改成 async 等于换掉整条换课的仲裁顺序，AGENTS §2 #8）',
    callAt >= 0 && deferAt > callAt && orderAt > deferAt && askBody.indexOf('await ') === -1,
    JSON.stringify({ call: callAt, defer: deferAt, order: orderAt, awaits: askBody.split('await ').length - 1 }));

  // ⑱ 单轮问课上限：上限就是那个常量，超了要报「丢了几个」而不是静默截断
  sent.length = 0;
  var over = [];
  for (var oi = 0; oi < KC.limit + 3; oi++) over.push({ cid: String(700000 + oi), clazz: String(900000 + oi) });
  var capped = await harness.batch({ list: over });
  var counted = [];
  for (var ci = 0; ci < over.length; ci++) counted.push({ courseId: String(700000 + ci), clazzId: String(900000 + ci) });
  app._courseProbeCache = { pendingAt: 0, at: 5, answered: true, ok: true, asked: capped.asked, ms: 10, rows: {} };
  for (var ri = 0; ri < capped.rows.length; ri++) {
    app._courseProbeCache.rows[capped.rows[ri].cid + ':' + capped.rows[ri].clazz] = capped.rows[ri];
  }
  var cappedOrder = app._orderBlindByProbe.call(app, counted);
  check('⑱ 一轮最多问 ' + KC.limit + ' 门（现场最大账号 38 门），多出来那 3 门**报得出丢了几个**（`dropped`），而不是静默截断；而且它们照旧留在候选里、只排到最后 —— 静默丢掉等于"这账号有几门课永远不会被挑"',
    capped.asked === KC.limit && capped.dropped === 3 && capped.rows.length === KC.limit &&
      sent.length === KC.limit && counted.length === KC.limit + 3 &&
      cappedOrder.length === counted.length &&
      cappedOrder.slice(KC.limit).every(function (o) { return o.row === null && o.weight === RANK.unreadable * 1000; }),
    JSON.stringify({ limit: KC.limit, asked: capped.asked, dropped: capped.dropped, rows: capped.rows.length,
      fetched: sent.length, candidates: counted.length, ordered: cappedOrder.length,
      tail: cappedOrder.slice(KC.limit).map(function (o) { return o.card.courseId + '=' + o.weight; }) }));

  // ⑲ 面板那一头**真跑**：页面刚发出去的那条日志（带它自己算的 meta）喂给 content.js 里那份真的
  //    `runtimeLogToStatus`，红绿由返回值说话。
  //    ⚠️ 这一格补的是批次 97 差点漏掉的那族：新增一条 `course switch *` 日志而**没在分类器里点名**，
  //    生产不会报错、集成上面那十几格照旧全绿 —— 它落进那句兜底 `else`，右下角点亮「注意」并说
  //    「没往下换课」，而这一刻插件**正要往下换**。症状与批次 55-B / 60 那两条「warn 兜底说反话」同形。
  //    判据同 ⑦′：正则比源字符串抓不到"分支压根走不到"，所以这里必须调用真函数（AGENTS §5）。
  logs.length = 0;
  app._courseProbeSpokeAt = 0;
  app._courseProbeCache = { pendingAt: 6000, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
  app._courseProbeDeferred.call(app, 6000 + 1000, 7);
  var probeMeta = logs.length === 1 ? logs[0].meta : null;
  var ppc = extractPanelClassifier(cnt);
  check('⑲a 页面说的那条探针日志能拿到 meta，且分类器取得出来（取不出来这一格是「没执行」，不是「通过」）',
    !!probeMeta && typeof ppc.fn === 'function',
    JSON.stringify({ logs: logs.length, meta: probeMeta, at: ppc.at, err: ppc.err }));
  if (probeMeta && typeof ppc.fn === 'function') {
    var panelReal = ppc.fn('info', 'course switch probing course homes', probeMeta);
    // 两个数都从**页面算出来的 meta** 里读回来比，不在这里抄一份 24 —— 抄了就成了第二把尺（AGENTS §4）
    var saysBlind = String(panelReal.detail).indexOf(String(probeMeta.blindCount)) >= 0;
    var saysDefer = String(panelReal.detail).indexOf(String(probeMeta.deferSec)) >= 0;
    check('⑲b 面板对这条的读法是 wait「这一门刷完了 / 正在后台读 N 门…最多等 M 秒」，不许落进兜底那句' +
      '「没往下换课」（漏了那一支就是给一条正常推进的日志点亮「注意」，而且**说的正好是反话**）；' +
      'N、M 两个数都取自页面 meta（' + probeMeta.blindCount + ' / ' + probeMeta.deferSec + '），不是这边抄的常量',
      panelReal.state === 'wait' && panelReal.task === '这一门刷完了' &&
        panelReal.named === true && saysBlind && saysDefer &&
        String(panelReal.detail).indexOf('没往下换课') < 0 &&
        Number(probeMeta.deferSec) === Math.round(DEFER / 1000),
      JSON.stringify({ panel: panelReal, meta: probeMeta, deferMs: DEFER }));
    // ⑳ meta 缺字段那一格（旧页面产物 / 拼接没跟上 / 常量那一行被删）：只许写「-」，不许压成 0
    var panelBare = ppc.fn('info', 'course switch probing course homes', { hint: 'x' });
    var panelNull = ppc.fn('info', 'course switch probing course homes', null);
    check('⑳ 读不到的数写「-」，不许被算成一个看起来很像真的 0 —— 「最多等 0 秒」是一条**具体的假承诺**，' +
      '现场没人会怀疑它（AGENTS §2 #12「读不出必须单独占一格」同族，缺字段那一格与 null meta 都要走到）',
      panelBare.state === 'wait' && /- 门/.test(panelBare.detail) && /- 秒/.test(panelBare.detail) &&
        String(panelBare.detail).indexOf('0') < 0 &&
        /- 门/.test(panelNull.detail) && /- 秒/.test(panelNull.detail),
      JSON.stringify({ bare: panelBare, nul: panelNull }));
  }
}

async function testPetChatRequest() {
  console.log('\n[26] 宠物聊天：请求构造纯函数 + 发送层接线（批次 123）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var pop = read('popup/popup.js');
  var promptSrc = read('libs/prompt.js');

  // 顶层 function 抓取器：从 `function 名字(` 起、按花括号配对收尾（popup.js 是 0 缩进顶层，
  // 函数体里没有会骗过配对的字符串花括号 —— 有就说明这段被改坏，取不出整段按零覆盖处理）
  var topFn = function (src, name) {
    var at = src.indexOf('function ' + name + '(');
    if (at < 0) return null;
    // `async function petChatSend(` 这种声明要从 async 起 —— 只截 function 就把
    // await 留在一个非 async 的函数体里，构造时 SyntaxError（整段「没跑到」）
    if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
    var depth = 0;
    for (var i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
    return null;
  };
  var builderText = topFn(pop, 'buildPetChatRequest');
  var sendText = topFn(pop, 'petChatSend');
  check('① 构造（buildPetChatRequest）与发送（petChatSend）两件都从 popup/popup.js 原样取出真跑 —— 取不出就整段不跑，那种「没执行」和「通过」在报告里长得一模一样（AGENTS §5）',
    !!builderText && !!sendText,
    JSON.stringify({ builder: !!builderText, send: !!sendText }));
  if (!builderText || !sendText) return;

  var made = new Function('return (' + builderText + ')')();
  // 地址构造注入成桩：url 是拼出来的字符串，断言它**收到了哪几个实参**（gemini 的 key 在 URL 里）
  var H = {
    openai: function (a) { return 'OPENAI|' + a; },
    claude: function (a) { return 'CLAUDE|' + a; },
    gemini: function (a, m, k) { return 'GEMINI|' + a + '|' + m + '|' + k; }
  };
  var hist = function () { return [
    { role: 'user', text: '你好' }, { role: 'assistant', text: '嗯嗯' }, { role: 'user', text: '在么' }]; };

  // ── 联网搜索那把尺（任务 #183）：提前到发送层之前声明 ──────────────────────
  // builder 与 petSearchMeta 两个纯函数都从 popup/popup.js 原样取出，把 `OmitoneWebSearch`
  // 当**参数**喂进去 —— 这样 ⑨-㉒ 走的是判据真身，而不是测试台自己另写的一份口径。
  // ⚠️ 不许改成往 globalThis 上挂 —— 那是整轮共用的状态，前一个场景挂上、后一个场景就永远
  //    测不到「模块压根没登记」那一格（AGENTS §5「夹具必须自己钉住它依赖的共享状态」）。
  var WS = require(path.join(ROOT, 'libs', 'web-search.js'));
  var madeWs = new Function('OmitoneWebSearch', 'return (' + builderText + ')')(WS);
  var madeNoLib = new Function('OmitoneWebSearch', 'return (' + builderText + ')')(undefined);
  // 官方域那个字面量从 libs 读回来，不在测试里抄第二份（改了真源这边跟着走）
  var CFG_OFFICIAL = { apiType: 'openai', apiUrl: 'https://' + WS.OFFICIAL_HOST, model: 'deepseek-flash', apiKey: 'sk-test' };
  var CFG_RELAY = { apiType: 'openai', apiUrl: 'https://relay.example.com/v1', model: 'deepseek-flash', apiKey: 'sk-test' };
  var metaText = topFn(pop, 'petSearchMeta');
  var metaWs = metaText ? new Function('OmitoneWebSearch', 'return (' + metaText + ')')(WS) : null;
  var metaNoLib = metaText ? new Function('OmitoneWebSearch', 'return (' + metaText + ')')(undefined) : null;

  // ---- ② OpenAI 兼容形：system 打头、Bearer 头、max_tokens 384 ----
  var rOpen = made({ apiType: 'openai', apiUrl: 'https://api.example/v1', model: 'm1', apiKey: 'sk-test' }, hist(), 'SYS', H);
  var bOpen = rOpen ? JSON.parse(rOpen.body) : null;
  check('② openai 形：system 那条打头、最后一条是用户刚说的话（`在么`）、`max_tokens` 封顶 384（聊天的钱有上限）、Authorization 用 `Bearer ` 前缀、地址来自真源构造器',
    rOpen && rOpen.apiType === 'openai' && rOpen.url === 'OPENAI|https://api.example/v1' &&
      rOpen.headers.Authorization === 'Bearer sk-test' && bOpen &&
      bOpen.messages[0].role === 'system' && bOpen.messages[0].content === 'SYS' &&
      bOpen.messages[bOpen.messages.length - 1].role === 'user' &&
      bOpen.messages[bOpen.messages.length - 1].content === '在么' && bOpen.max_tokens === 384,
    JSON.stringify({ url: rOpen && rOpen.url, auth: rOpen && rOpen.headers.Authorization,
      first: bOpen && bOpen.messages[0], last: bOpen && bOpen.messages[bOpen.messages.length - 1], max: bOpen && bOpen.max_tokens }));

  // ---- ③ Claude 形：system 是**顶层字段**、x-api-key 头 ----
  var rClaude = made({ apiType: 'claude', apiUrl: 'https://api.example', model: 'm2', apiKey: 'sk-c' }, hist(), 'SYS', H);
  var bClaude = rClaude ? JSON.parse(rClaude.body) : null;
  check('③ claude 形：system 在 body 顶层（不是 messages 里）、`x-api-key` 头带 anthropic-version、地址收到的是 apiUrl 本身',
    rClaude && rClaude.apiType === 'claude' && rClaude.url === 'CLAUDE|https://api.example' &&
      rClaude.headers['x-api-key'] === 'sk-c' && !!rClaude.headers['anthropic-version'] && bClaude &&
      bClaude.system === 'SYS' && bClaude.messages[bClaude.messages.length - 1].content === '在么',
    JSON.stringify({ url: rClaude && rClaude.url, sys: bClaude && bClaude.system, hdrs: rClaude && Object.keys(rClaude.headers) }));

  // ---- ④ Gemini 形：systemInstruction 包着、assistant→model 改名、key 进 URL ----
  var rGem = made({ apiType: 'gemini', apiUrl: 'https://g.example', model: 'm3', apiKey: 'sk-g' }, hist(), 'SYS', H);
  var bGem = rGem ? JSON.parse(rGem.body) : null;
  var roles = bGem ? bGem.contents.map(function (c) { return c.role; }).join(',') : '';
  check('④ gemini 形：systemInstruction 包着 SYS、assistant 一条改名叫 `model`（gemini 没有 assistant 角色，不改名整个请求 400）、地址把 **apiUrl+model+key 三个实参都收走**（key 只许在 URL，不许混进头）',
    rGem && rGem.apiType === 'gemini' && rGem.url === 'GEMINI|https://g.example|m3|sk-g' &&
      !rGem.headers.Authorization && bGem &&
      bGem.systemInstruction.parts[0].text === 'SYS' && roles === 'user,model,user' &&
      bGem.generationConfig.maxOutputTokens === 384,
    JSON.stringify({ url: rGem && rGem.url, roles: roles, sys: bGem && bGem.systemInstruction.parts[0].text }));

  // ---- ⑤ 截断两把尺：只留最近 8 条 + 单条压到 400 字 ----
  var long12 = [];
  for (var ti = 0; ti < 12; ti++) long12.push({ role: ti % 2 ? 'assistant' : 'user', text: 'msg' + ti });
  long12.push({ role: 'user', text: '长'.repeat(500) });
  var rTrim = made({ apiType: 'openai', apiUrl: 'u', model: 'm', apiKey: 'k' }, long12, 'SYS', H);
  var bTrim = rTrim ? JSON.parse(rTrim.body) : null;
  var lastContent = bTrim ? bTrim.messages[bTrim.messages.length - 1].content : '';
  check('⑤ 十二条历史进来只留**最近 8 条**（连 system 共 9 条 —— 历史无上限等于每发都把整本账重送一遍，钱翻倍）；单条 500 字压到 400（上限就是那把尺，不是测试抄的数）',
    bTrim && bTrim.messages.length === 9 && bTrim.messages[1].content === 'msg5' && lastContent.length === 400,
    JSON.stringify({ kept: bTrim && bTrim.messages.length, first: bTrim && bTrim.messages[1].content, lastLen: lastContent.length }));

  // ---- ⑥ 半截历史不发货：最后一发必须是用户的话 ----
  var nEmpty = made({ apiType: 'openai', apiUrl: 'u', model: 'm', apiKey: 'k' }, [], 'SYS', H);
  var nAssistant = made({ apiType: 'openai', apiUrl: 'u', model: 'm', apiKey: 'k' },
    [{ role: 'user', text: '你好' }, { role: 'assistant', text: '嗯' }], 'SYS', H);
  var nBlank = made({ apiType: 'openai', apiUrl: 'u', model: 'm', apiKey: 'k' },
    [{ role: 'user', text: '你好' }, { role: 'assistant', text: '嗯' }, { role: 'user', text: '   ' }], 'SYS', H);
  check('⑥ 三种半截历史一律交 null（**一个请求都不构造**）：空历史、最后一条是她说的、最后一条是纯空白（trim 完等于没说）—— 界面忙乱时不会把没问出口的话拿去花钱',
    nEmpty === null && nAssistant === null && nBlank === null,
    JSON.stringify({ empty: nEmpty, assistantLast: nAssistant, blankLast: nBlank }));

  // ---- ⑦ 人设提示词：libs/prompt.js 声明 + 导出 + 内容非空（提示词唯一真源，AGENTS §2 #4）----
  var petSysM = promptSrc.match(/var PET_CHAT_SYSTEM = (\[[\s\S]*?\])\.join/);
  var petSys = petSysM ? new Function('return ' + petSysM[1])().join('\n') : '';
  check('⑦ 人设 PET_CHAT_SYSTEM 在 libs/prompt.js 里**声明且导出**（两处都认），内容非空并点明身份（吉祥物）与限额（40 字）—— 提示词内联进调用方就分叉了',
    /PET_CHAT_SYSTEM: PET_CHAT_SYSTEM/.test(promptSrc) && petSys.length > 40 &&
      petSys.indexOf('吉祥物') >= 0 && petSys.indexOf('40') >= 0,
    JSON.stringify({ exported: /PET_CHAT_SYSTEM: PET_CHAT_SYSTEM/.test(promptSrc), len: petSys.length, head: petSys.slice(0, 24) }));

  // ---- ⑧ 发送层静态接线：超时、归一化、错误分类、人设、挂到 window ----
  check('⑧ petChatSend 体内五处接线都在：`fetchWithTimeout(`（⚠️ try/catch 拦不住挂起，只有超时能 —— AGENTS §2 #2）、`normalizeApiKey(`、`OmitoneApiError`（不再把业务拒绝叫「连接失败」）、`PET_CHAT_SYSTEM`（人设从这里来）、`window.omitonePetChatSend =`（界面钩子真的挂上）',
    sendText.indexOf('fetchWithTimeout(') >= 0 && sendText.indexOf('normalizeApiKey(') >= 0 &&
      sendText.indexOf('OmitoneApiError') >= 0 && sendText.indexOf('PET_CHAT_SYSTEM') >= 0 &&
      pop.indexOf('window.omitonePetChatSend = petChatSend;') >= 0,
    JSON.stringify({ fetch: sendText.indexOf('fetchWithTimeout(') >= 0, norm: sendText.indexOf('normalizeApiKey(') >= 0,
      apiErr: sendText.indexOf('OmitoneApiError') >= 0, hook: pop.indexOf('window.omitonePetChatSend = petChatSend;') >= 0 }));

  // ---- ⑨-⑬ 发送层动态：五个分支各说各的话，不许静默 ----
  // petChatSend 在生产里带 5 参调 buildPetChatRequest（第 4 参 urls 传 null 走默认，
  // 默认值取 popup.js 模块作用域的三个地址构造器 —— Node 里那三个名字不存在，一求值就 ReferenceError；
  // 第 5 参是模块作用域那枚三态开关、petSearchMeta 也在模块作用域 —— 三样都得当参数交进来，
  // 少任何一样 ⑨-⑬ 全体「没执行」，而报告里那种「没执行」和「通过」长得一模一样（AGENTS §5）。
  var wsVal = null;
  var wsArgs = [];
  var mkSend = function (cfgOver, fetchStub, selfStub) {
    var names = ['config', 'normalizeApiKey', 'buildPetChatRequest', 'fetchWithTimeout', 'self',
      'petWebSearchVal', 'petSearchMeta'];
    var inj = {
      config: Object.assign({ apiType: 'openai', apiUrl: 'https://api.example/v1', model: 'm1', apiKey: 'sk-test' }, cfgOver),
      normalizeApiKey: function (k) { return k; },
      // 第 5 参原样记下来（㉒ 钉的就是它有没有被 !! 压平），再交给**带真模块**的那份构造器，
      // 于是发送层往下走的判据是 libs/web-search.js 那把尺，不是测试台自己另写的一份。
      buildPetChatRequest: function (cfg, history, sys, urls, wsArg) { wsArgs.push(wsArg); return madeWs(cfg, history, sys, H, wsArg); },
      fetchWithTimeout: fetchStub,
      self: selfStub || {},
      petWebSearchVal: wsVal,
      petSearchMeta: metaWs
    };
    var fn = Reflect.construct(Function, names.concat(['return (' + sendText + ')']));
    var send = fn.apply(null, names.map(function (k) { return inj[k]; }));
    // fn.apply 交回的是 petChatSend 函数本身 —— 不调用它，五个断言拿到的全是函数，
    // await 一个函数只会原样resolve，症状是 fetchCalls:0（本轮实测踩过）。
    return send(hist());
  };
  var fetchCalls = 0;

  var noKey = await mkSend({ apiKey: '' }, function () { fetchCalls++; return null; }, {});
  check('⑨ 没填 Key：**一个请求都不发**（fetch 一次都没被调）就交回 `noKey:true` —— 「能接受用不了，不能接受花了钱」的底线格',
    noKey && noKey.noKey === true && noKey.ok === false && fetchCalls === 0,
    JSON.stringify({ res: noKey, fetchCalls: fetchCalls }));

  var netErr = await mkSend({}, function () { fetchCalls++; throw new Error('boom'); }, {});
  check('⑩ 网络抛错：交回 `ok:false` 且**带一句人话**（点「没连上」），绝不静默装作成功',
    netErr && netErr.ok === false && !netErr.noKey && String(netErr.error).indexOf('没连上') >= 0,
    JSON.stringify({ error: netErr && netErr.error, fetchCalls: fetchCalls }));

  var http401 = await mkSend({}, function () { fetchCalls++; return { ok: false, status: 401, text: async function () { return 'bad key'; } }; },
    { OmitoneApiError: { describe: function (s, b) { return { category: 'auth', human: 'Key 无效:' + b }; } } });
  check('⑪ HTTP 401：文案走 OmitoneApiError 分类（Key 无效那一句带回包原文），不是笼统的「连接失败」',
    http401 && http401.ok === false && http401.error === 'Key 无效:bad key',
    JSON.stringify({ error: http401 && http401.error, status: 401 }));

  var okRes = await mkSend({}, function () { fetchCalls++; return { ok: true, json: async function () { return { choices: [{ message: { content: '  好\n呀  ' } }] }; } }; }, {});
  check('⑫ 成功：回包按 apiType 拆出 content，空白收敛成单空格（换行/首尾空格不原样进对话流）',
    okRes && okRes.ok === true && okRes.text === '好 呀',
    JSON.stringify({ text: okRes && okRes.text, fetchCalls: fetchCalls }));

  var silent = await mkSend({}, function () { fetchCalls++; return { ok: true, json: async function () { return { choices: [{ message: { content: '   ' } }] }; } }; }, {});
  check('⑬ 「只想了没说话」那一格单独说话（点给用户「换个普通模型」），不许被当成成功、也不许静默',
    silent && silent.ok === false && String(silent.error).indexOf('只想了') >= 0,
    JSON.stringify({ error: silent && silent.error }));

  // ── ⑭-㉒ 联网搜索那一发（任务 #183）──────────────────────────────────────
  // WS / madeWs / madeNoLib / CFG_OFFICIAL / CFG_RELAY / metaWs / metaNoLib 都在本节开头、
  // 发送层之前声明好（⑨-⑬ 也要用 madeWs 与 metaWs，所以不能留在这里才建）。
  // builder 与 meta 都是从 popup/popup.js 抽出来 eval 的**纯函数**，里面的自由名字
  // `OmitoneWebSearch` 在生产里落到 popup.html 加载的那份模块上；测试台把它当**参数**喂进去，
  // 这样两种成因分得开：喂真模块 = 判据走 libs 那一份；压根不喂 = 「登记漏了一处」那一格（no-lib）。

  var rOn = madeWs(CFG_OFFICIAL, hist(), 'SYS', H, true);
  var bOn = rOn ? JSON.parse(rOn.body) : null;
  check('⑭ 开关开着 + 地址确实是官方域：那一发**真带上** tools，声明形状就是量过的那一条（`[{type:"deepseek_web_search"}]`，' +
    '多一格都没有），并且**不发 temperature** —— "带 tools 时服务端怎么对待 temperature" 没测过，' +
    '没测过的参数不许照发（探针 probe161 E / probe162 H–L 六发都是四格、全 200 且真搜）',
    rOn && rOn.search && rOn.search.cell === 'on' && rOn.search.on === true &&
      !!bOn && Array.isArray(bOn.tools) && bOn.tools.length === 1 &&
      Object.keys(bOn.tools[0]).length === 1 && bOn.tools[0].type === 'deepseek_web_search' &&
      !('temperature' in bOn) && bOn.max_tokens === 384,
    JSON.stringify({ cell: rOn && rOn.search && rOn.search.cell, tools: bOn && bOn.tools,
      keys: bOn && Object.keys(bOn) }));

  var rOff = madeWs(CFG_OFFICIAL, hist(), 'SYS', H, false);
  var bOff = rOff ? JSON.parse(rOff.body) : null;
  check('⑮ 开关**没开**时那一发与改动前**逐字节同形**：四个键按 model,messages,max_tokens,temperature 原序、' +
    '一个都不许多（`tools` 整个字段不写，不是写空数组），max_tokens 仍是 384 —— ' +
    '这格钉的是「加了这枚开关之后，没开它的用户那发请求一个字都没变」',
    rOff && rOff.search.cell === 'off' && rOff.search.on === false && !!bOff &&
      Object.keys(bOff).join(',') === 'model,messages,max_tokens,temperature' &&
      bOff.temperature === 0.8 && bOff.max_tokens === 384 && !('tools' in bOff),
    JSON.stringify({ cell: rOff && rOff.search.cell, keys: bOff && Object.keys(bOff) }));

  var rUnk = madeWs(CFG_OFFICIAL, hist(), 'SYS', H, null);
  var bUnk = rUnk ? JSON.parse(rUnk.body) : null;
  var rUndef = madeWs(CFG_OFFICIAL, hist(), 'SYS', H);
  check('⑯ 开关真值**还没从存储读回来**（null 与压根不传两格）：那一格叫 `unknown`、**不许塌进 `off`** —— ' +
    '两句在请求上一样（都不带 tools），但话完全不同：这时候对用户说"你没开联网搜索"是替他做了一个他没做过的决定。' +
    '同时也不许因为"看起来可能是开"就抢着带 tools —— 那正是"消耗余额"最不该发生的那一拍（AGENTS §2 #12）',
    rUnk && rUnk.search.cell === 'unknown' && rUnk.search.on === false && bUnk && !('tools' in bUnk) &&
      rUndef && rUndef.search.cell === 'unknown' && rUndef.search.on === false,
    JSON.stringify({ nullCell: rUnk && rUnk.search.cell, absentCell: rUndef && rUndef.search.cell,
      keys: bUnk && Object.keys(bUnk) }));

  var rRly = madeWs(CFG_RELAY, hist(), 'SYS', H, true);
  var bRly = rRly ? JSON.parse(rRly.body) : null;
  check('⑰ 用户开着开关、但接的是**中转站**：当场判 `not-official`、那一发**不带 tools**，并把读回来的域名交出去' +
    '（灰条要说的是这一句）—— 别人家的服务器替我们搜索，费用与内容都不受我们约束，' +
    '静默当成"已经搜过了"就是假话；地址后缀伪装（`api.deepseek.com.ru`）也走这一格，不做后缀匹配',
    rRly && rRly.search.cell === 'not-official' && rRly.search.on === false &&
      rRly.search.host === 'relay.example.com' && !!bRly && !('tools' in bRly) && bRly.temperature === 0.8,
    JSON.stringify({ cell: rRly && rRly.search.cell, host: rRly && rRly.search.host,
      why: rRly && rRly.search.why, keys: bRly && Object.keys(bRly) }));

  // ⚠️ 变量名带 Ws 后缀：`rClaude` / `rGem` 这一族在 ③④ 已经用过，`var` 重复声明不报错、
  // 只是把上面的读数悄悄覆盖掉 —— 后面若有人再拿它们做取证，读到的是这一档的 cfg 而不是 ③④ 那份。
  var rClaudeWs = madeWs({ apiType: 'claude', apiUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'k' }, hist(), 'SYS', H, true);
  var rGemWs = madeWs({ apiType: 'gemini', apiUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'k' }, hist(), 'SYS', H, true);
  check('⑱ 协议形状不是 OpenAI 兼容（claude / gemini）时那一格叫 `type`，两个分支的 body **都不许多出 tools** —— ' +
    '那两家没有这个字段，发过去是 400 或被忽略；判据先看开关再看协议再看地址，' +
    '顺序反过来"用户没开"就会被说成"你填的地址不对"（AGENTS §2 #5 同一族）',
    rClaudeWs && rClaudeWs.search.cell === 'type' && !('tools' in JSON.parse(rClaudeWs.body)) &&
      rGemWs && rGemWs.search.cell === 'type' && !('tools' in JSON.parse(rGemWs.body)),
    JSON.stringify({ claude: rClaudeWs && rClaudeWs.search.cell, gemini: rGemWs && rGemWs.search.cell }));

  var rNoLib = madeNoLib(CFG_OFFICIAL, hist(), 'SYS', H, true);
  check('⑲ 模块**压根没登记**（popup.html 少一行 script）：那一格叫 `no-lib`、不许塌进 `off`，' +
    '也不许当场抛 —— 这一族的失败形状是"不报错、只是那一发从来没带上搜索"，' +
    '而用户听到的那句话听起来像刚查过（AGENTS §2 #18）。格子内含量够调用方照原样发货',
    rNoLib && rNoLib.search.cell === 'no-lib' && rNoLib.search.on === false &&
      !('tools' in JSON.parse(rNoLib.body)),
    JSON.stringify({ cell: rNoLib && rNoLib.search.cell, why: rNoLib && rNoLib.search.why }));

  // metaText / metaWs / metaNoLib 由本节开头那一段建好（发送层要用同一份，不许在这里重建）
  check('⑳ 界面那一行小字的三格各说各话（petSearchMeta 抽出来真跑）：' +
    '搜到了 → 句子由 libs 按回包 usage 拼（含实际次数与 token，不是写死的）；' +
    '开关没开 → **交回 null 一个字都不说**（那行字出现只会让人以为刚才那句是搜出来的）；' +
    '开着但带不动 → 当场说"这次没有联网"并把原因带上。取不出这个函数就整段零覆盖（AGENTS §5）',
    !!metaText && !!metaWs &&
      metaWs({ cell: 'off', on: false, why: '联网搜索这枚开关没开' }, null) === null &&
      /^这次没有联网：/.test(String(metaWs(rRly && rRly.search, null).sentence)) &&
      metaWs(rRly && rRly.search, null).on === false &&
      /联网查了 2 次/.test(String(metaWs({ cell: 'on', on: true, why: '', host: 'api.deepseek.com' },
        { usage: { prompt_tokens: 4653, completion_tokens: 12, server_tool_use: { tool_search: 2, tool_fetch: 1 } } }).sentence)),
    JSON.stringify({ taken: !!metaText, off: String(metaWs && metaWs({ cell: 'off', on: false }, null)),
      blocked: metaWs && metaWs(rRly && rRly.search, null).sentence,
      searched: metaWs && metaWs({ cell: 'on', on: true, host: 'api.deepseek.com' },
        { usage: { prompt_tokens: 4653, completion_tokens: 12, server_tool_use: { tool_search: 2, tool_fetch: 1 } } }).sentence }));

  var sentNoLib = metaNoLib && metaNoLib({ cell: 'on', on: true, why: '', host: 'api.deepseek.com' },
    { usage: { prompt_tokens: 12, server_tool_use: { tool_search: 1 } } });
  check('㉑ 模块没登记时**连那句"花了多少"也不猜**：petSearchMeta 在 lib 缺席的那一路交一句' +
    '"这一回没读到用量数据"，而不是把回包里的数字自己乘一遍 —— 读不出单独占一格（AGENTS §2 #12）',
    !!metaNoLib && !!sentNoLib && String(sentNoLib.sentence).indexOf('没读到用量') >= 0 &&
    sentNoLib.on === true && sentNoLib.cell === 'on',
    JSON.stringify({ sentence: sentNoLib && sentNoLib.sentence, cell: sentNoLib && sentNoLib.cell }));

  // ㉒ 发送层（petChatSend 真身）把那枚三态**原样**递给第 5 参，并且"还没读到"与"用户没开"
  //     在界面那一行小字上说的话不同。这一格只能由**真跑发送层**证 ——
  //     ⑭-㉑ 测的是纯函数，把 `buildPetChatRequest(cfg, history, sys, null, petWebSearchVal)`
  //     改成 `!!petWebSearchVal` 时那五格一条都不会红（症状与改之前一模一样：都不搜），
  //     变的只有"这一行小字有没有说错原因"（AGENTS §2 #12 在调用点上的同族）。
  wsArgs.length = 0;
  var sentVals = [undefined, null, false, 0, 1, true];
  var sentMeta = [];
  for (var wi = 0; wi < sentVals.length; wi++) {
    wsVal = sentVals[wi];
    var rSent = await mkSend(CFG_OFFICIAL, function () {
      fetchCalls++;
      return { ok: true, json: async function () { return { choices: [{ message: { content: '嗯' } }] }; } };
    }, {});
    sentMeta.push(rSent ? rSent.meta : { cell: '(没走到)' });
  }
  wsVal = null;
  var verbatim = sentVals.every(function (v, i) { return Object.is(wsArgs[i], v); });
  var metaCells = sentMeta.map(function (m) { return m === null ? 'null' : (m && m.cell) || '(没格子)'; });
  check('㉒ 发送层把三态**原样**交进第 5 参（六种输入逐格 Object.is 比，!! / Number 压平当场红），' +
    '而且界面上「还没读到」与「用户没开」各占一格：null 与压根没读到 → 说一句"这次没有联网：还没读到…"，' +
    'false / 0 / 压根没这一枚 → **交回 null 一个字都不说**，true + 官方域 → 说"搜过"，' +
    '但回包没有 usage 时那句只能是"读不出"，不许把 0 当成没花（AGENTS §2 #2 / #12）',
    wsArgs.length === sentVals.length && verbatim &&
      sentMeta[0].cell === 'unknown' && sentMeta[0].on === false &&
      /^这次没有联网：/.test(String(sentMeta[0].sentence)) &&
      sentMeta[1].cell === 'unknown' &&
      sentMeta[2] === null && sentMeta[3] === null && sentMeta[4] === null &&
      sentMeta[5].on === true && /没读到用量/.test(String(sentMeta[5].sentence)),
    JSON.stringify({ got: wsArgs.map(function (v) { return String(v); }), want: sentVals.map(function (v) { return String(v); }),
      verbatim: verbatim, cells: metaCells, said: sentMeta.map(function (m) { return m === null ? '(不说话)' : String(m.sentence).slice(0, 18); }) }));
}

async function testLocalDoctor() {
  console.log('\n[27] 本地自愈「医生」：判断层四态与有界 + 页面/弹窗两侧接线 + 联网搜索那一发带不带（批次 130 / 任务 #183）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var diagSrc = read('libs/diagnose.js');
  var contentSrc = read('content.js');
  var popSrc = read('popup/popup.js');
  var petSrc = read('popup/pet.js');
  var gameSrc = read('popup/pet-game.js');
  var promptSrc = read('libs/prompt.js');
  var bgSrc = read('background.js');

  // 花括号配对取整段（顶层与缩进两种都行）；串里没有会骗过配对的裸花括号，坏了就交空串
  var fnText = function (src, decl) {
    var at = src.indexOf(decl);
    if (at < 0) return '';
    var start = src.indexOf('{', at);
    if (start < 0) return '';
    var depth = 0;
    for (var i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
    }
    return '';
  };
  var constOf = function (src, name) {
    var m = src.match(new RegExp('(?:var|let|const)\\s+' + name + '\\s*=\\s*([^;\\n]+);'));
    if (!m) return NaN;
    try { return new Function('return (' + m[1] + ')')(); } catch (e) { return NaN; }
  };

  var D = null;
  try { D = require(path.join(ROOT, 'libs/diagnose.js')); } catch (e) { D = null; }
  check('⓪ 判断层在 Node 里取得到（弹窗卡片、上课页她本人、集成测试三处共用同一份的前提是它自己可 require）——' +
    '取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样',
    !!D && typeof D.analyze === 'function' && typeof D.buildDigest === 'function' &&
      typeof D.selfCheck === 'function' && Array.isArray(D.RULES) && D.RULES.length > 0 &&
      Array.isArray(D.PROGRESS_NEEDLES) && !!D.LIMITS,
    'typeof analyze=' + (D ? typeof D.analyze : '模块没取到') + ' 规则条数=' + (D && D.RULES ? D.RULES.length : 0));
  if (!D || typeof D.analyze !== 'function') return;

  var L = D.LIMITS;
  // 联网搜索那把尺（任务 #183）：医生问模型那一发的「带不带 tools」也只问 libs/web-search.js，
  // 与弹窗两处出口问的是同一份。取不到时下面 ㉛-㉞ 全成「没执行」，所以那一格自己也要说话。
  var WS = null;
  try { WS = require(path.join(ROOT, 'libs/web-search.js')); } catch (e) { WS = null; }
  var DEFAULT_WINDOW = constOf(diagSrc, 'DEFAULT_WINDOW_MS');
  var MIN_IDLE = constOf(diagSrc, 'MIN_IDLE_WINDOW_MS');
  var T0 = Date.now();
  var log = function (msg, level, time) {
    return { time: time || T0, level: level || 'warn', message: msg };
  };
  // 用例只按 severity 从**真规则表**里挑，不写死 needle —— needle 换了名这里跟着换
  var sev3 = D.RULES.filter(function (r) { return r.severity >= 3; })[0];
  var sev1 = D.RULES.filter(function (r) { return r.severity === 1; })[0];
  var sev0 = D.RULES.filter(function (r) { return r.severity === 0; })[0];
  var altHard = D.RULES.filter(function (r) { return r.severity >= 2 && r.code !== sev3.code; })[0];
  var sameHard = D.RULES.filter(function (r) { return r.severity === sev3.severity && r.code !== sev3.code; })[0];
  check('⓪′ 规则表里四档 severity 各有真规则可挑（挑不到时下面那些格子会集体「没跑到」）',
    !!sev3 && !!sev1 && !!sev0 && !!altHard && !!sameHard &&
      Number.isFinite(DEFAULT_WINDOW) && Number.isFinite(MIN_IDLE),
    JSON.stringify({ sev3: sev3 && sev3.code, sev1: sev1 && sev1.code, sev0: sev0 && sev0.code,
      alt: altHard && altHard.code, same: sameHard && sameHard.code,
      window: DEFAULT_WINDOW, idle: MIN_IDLE }));

  // ---- ① 四态 ----
  var vEmpty = D.analyze([], { now: T0 }).verdict;
  var vNull = D.analyze(null, { now: T0 }).verdict;
  var vMalformed = D.analyze([{ x: 1 }, '一串', null], { now: T0 }).verdict;
  var vHealthy = D.analyze([log(D.PROGRESS_NEEDLES[0], 'info'), log('performance profile', 'info')], { now: T0 }).verdict;
  var vIssue = D.analyze([log(sev3.needles[0], 'error')], { now: T0 }).verdict;
  var vNote = D.analyze([log(sev0.needles[0], 'warn')], { now: T0 }).verdict;
  check('① 四态各占一格：读不出 / 没问题 / 有要处理的 / 只是提醒。**「读不出」与「没问题」是两个词** —— ' +
    '压成两态迟早变成用户那句「我有一科一直没刷」；把提醒级压成警报则会把「这门刷完了」渲染成一条异常（AGENTS §2 #12）',
    vEmpty === 'unknown' && vNull === 'unknown' && vMalformed === 'unknown' &&
      vHealthy === 'healthy' && vIssue === 'issue' && vNote === 'note',
    JSON.stringify({ empty: vEmpty, nul: vNull, malformed: vMalformed,
      healthy: vHealthy, issue: vIssue, note: vNote }));

  // ---- ②③ 有界输出 ----
  var allHit = D.RULES.map(function (r, i) { return log(r.needles[0], 'error', T0 + i); });
  var bounded = D.analyze(allHit, { now: T0 + 1000 });
  var overLong = (bounded.findings || []).filter(function (f) {
    return f.title.length > L.TITLE_MAX || f.advice.length > L.ADVICE_MAX || f.evidence.length > L.EVIDENCE_MAX;
  });
  check('① 命中数确实**超过了**上限（' + bounded.totalRules + ' > ' + L.MAX_FINDINGS + '），这一格才真测到了截断；' +
    '否则「只交 4 条」是恒真的废话',
    bounded.totalRules > L.MAX_FINDINGS && bounded.findings.length === L.MAX_FINDINGS,
    JSON.stringify({ totalRules: bounded.totalRules, given: bounded.findings.length, cap: L.MAX_FINDINGS }));
  check('② 每条的标题/建议/取证都不超各自的上限（三个数从 `LIMITS` 读回来，不是测试里抄的字面量）',
    overLong.length === 0,
    JSON.stringify({ limits: L, over: overLong.map(function (f) { return f.code + ':' + f.title.length + '/' + f.advice.length + '/' + f.evidence.length; }) }));
  var fatMsg = sev3.needles[0] + '，' + '详'.repeat(L.EVIDENCE_MAX + 210);
  var fat = D.analyze([log(fatMsg, 'error')], { now: T0 });
  check('③ 取证是被**压过**的，不是「这条本来就短」：300 多字的原话进来，交回的 evidence 恰好等于上限长并以省略号收尾 —— ' +
    '面板那一格挤爆之前只有这一手挡着',
    fat.findings[0].evidence.length === L.EVIDENCE_MAX &&
      fat.findings[0].evidence.slice(-1) === '…' &&
      fat.findings[0].count === 1 && fat.findings[0].lastAt === T0,
    JSON.stringify({ len: fat.findings[0].evidence.length, tail: fat.findings[0].evidence.slice(-3),
      count: fat.findings[0].count, lastAt: fat.findings[0].lastAt }));

  // ---- ④ 排序：先按有多硬，同级再按新 ----
  var noisy = [];
  for (var ni = 0; ni < 6; ni++) noisy.push(log(sev1.needles[0], 'warn', T0 + ni));
  noisy.push(log(sev3.needles[0], 'error', T0));
  var sorted = D.analyze(noisy, { now: T0 + 9000 });
  var twoSame = D.analyze([log(sev3.needles[0], 'error', T0), log(sameHard.needles[0], 'error', T0 + 5000)], { now: T0 + 6000 });
  check('④ 排序按「有多硬」而不是「有几条」：软的那型命中 6 次、硬伤只 1 次，第一条必须是硬伤；' +
    '同等级时新的一条在前 —— 最该先做的事不许排在噪声后面',
    sorted.findings[0].code === sev3.code && sorted.findings[1].code === sev1.code &&
      twoSame.findings[0].code === sameHard.code,
    JSON.stringify({ top1: sorted.findings[0].code, top2: (sorted.findings[1] || {}).code,
      softHits: sorted.findings[1] && sorted.findings[1].count, sameTop: twoSame.findings[0].code }));

  // ---- ⑤ 窗口真的在筛 ----
  var staleOne = [log(sev3.needles[0], 'error', T0 - 2 * 3600 * 1000)];
  var wShort = D.analyze(staleOne, { now: T0, windowMs: DEFAULT_WINDOW });
  var wLong = D.analyze(staleOne, { now: T0, windowMs: 3 * 3600 * 1000 });
  check('⑤ 两小时前的旧账在默认窗口（从源码读回来 = ' + Math.round(DEFAULT_WINDOW / 60000) + ' 分钟）里不许算成现在的结论；' +
    '把窗口放宽到三小时它又出现 —— 这一格证明的是「窗口真在筛」，不是「那条规则命中不到」',
    Number.isFinite(DEFAULT_WINDOW) && wShort.verdict === 'healthy' && !wShort.findings.length &&
      wLong.verdict === 'issue' && wLong.findings[0].code === sev3.code,
    JSON.stringify({ short: wShort.verdict, shortFindings: wShort.findings.length,
      long: wLong.verdict, longCode: (wLong.findings[0] || {}).code, windowMs: wShort.stats.windowMs }));

  // ---- ⑥ 「没看到推进」那三把闸各独立承重 ----
  var idle3 = [log('performance profile', 'info', T0), log('page idle', 'info', T0 + 1), log('page idle', 'info', T0 + 2)];
  var npShortWindow = D.analyze(idle3, { now: T0 + 3, windowMs: MIN_IDLE - 1 });
  var npTwoLines = D.analyze(idle3.slice(0, 2), { now: T0 + 3, windowMs: MIN_IDLE });
  var npHasProgress = D.analyze(idle3.concat([log(D.PROGRESS_NEEDLES[0], 'info', T0 + 1)]), { now: T0 + 3, windowMs: MIN_IDLE });
  var npFired = D.analyze(idle3, { now: T0 + 3, windowMs: MIN_IDLE });
  check('⑥ 「这段时间没看到刷课推进」要三把闸同时过：窗口不够长 / 日志不足 3 条 / 环里有任一推进事件 —— 摘掉任何一把，' +
    '她就变成「一有空就报没干活」（progress 词表从 `PROGRESS_NEEDLES` 读回来，不抄字面量）',
    npShortWindow.verdict === 'healthy' && npTwoLines.verdict === 'healthy' &&
      npHasProgress.verdict === 'healthy' && npFired.verdict === 'issue' &&
      npFired.findings[0].code === 'no-progress',
    JSON.stringify({ shortWindow: npShortWindow.verdict, twoLines: npTwoLines.verdict,
      hasProgress: npHasProgress.verdict, fired: npFired.findings[0].code, idleFloor: MIN_IDLE }));

  // ---- ⑦ 摘要 ----
  var threeFindings = { verdict: 'issue', findings: [
    { title: '甲题', count: 2, lastAt: T0, advice: '办法甲' },
    { title: '乙题', count: 3, lastAt: T0, advice: '办法乙' },
    { title: '丙题', count: 4, lastAt: T0, advice: '办法丙' }
  ] };
  var dgFull = D.buildDigest(threeFindings);
  var dgLines = dgFull.split('\n');
  var capTwo = dgLines[0].length + 1 + dgLines[1].length + 1 + dgLines[2].length;
  var dgCut = D.buildDigest(threeFindings, capTwo);
  var dgUnknown = D.buildDigest({ verdict: 'unknown', findings: [] });
  check('⑦ 交给模型的那份摘要：装不下的那条**整条丢掉**，不许截半句留一句断话 —— 截短版里第三条的标题与办法一个字都不出现，' +
    '行数正好少一；上限默认取 `DIGEST_MAX`（读回来 = ' + L.DIGEST_MAX + '），且「读不出」那一格照原话说读不出',
    dgLines.length === 4 && dgCut.split('\n').length === 3 && dgCut.indexOf('丙题') === -1 &&
      dgCut.indexOf('办法丙') === -1 && dgCut.indexOf('甲题') >= 0 && dgCut.length <= capTwo &&
      dgFull.length <= L.DIGEST_MAX && dgUnknown.indexOf('读不出') >= 0 && D.buildDigest(null) === '',
    JSON.stringify({ full: dgLines.length, cut: dgCut.split('\n').length, capTwo: capTwo,
      cutLen: dgCut.length, fullLen: dgFull.length, unknown: dgUnknown, nul: D.buildDigest(null) }));

  // ---- ⑧ 判断层自带的自证 ----
  var caseCount = (diagSrc.match(/\{ id: '/g) || []).length;
  var sc = D.selfCheck();
  check('⑧ 判断层自带的自证全绿，且条数**等于源码里真有的用例数 + 摘要那 2 格**（写死一个数会随用例增减说谎）',
    sc.ok === true && sc.total === caseCount + 2,
    JSON.stringify({ ok: sc.ok, total: sc.total, casesInSource: caseCount, problems: sc.problems }));

  // ---- ⑨ action 清单两侧对齐 ----
  var acts = [];
  D.RULES.forEach(function (r) { if (r.action && acts.indexOf(r.action) < 0) acts.push(r.action); });
  var actionBody = fnText(popSrc, 'async function petDiagAction(kind)');
  var kinds = [];
  (actionBody.match(/kind === "([a-z-]+)"/g) || []).forEach(function (s) {
    kinds.push(s.replace(/.*"([a-z-]+)".*/, '$1'));
  });
  var actMissing = acts.filter(function (a) { return kinds.indexOf(a) < 0; });
  var actExtra = kinds.filter(function (k) { return acts.indexOf(k) < 0; });
  var dupCode = [];
  var seenCode = {};
  D.RULES.forEach(function (r) { if (seenCode[r.code]) dupCode.push(r.code); seenCode[r.code] = 1; });
  check('⑨ 规则表里出现的每一型 action，弹窗那个出口都认识，**且反过来也相等**（' + acts.join(',') + ' 对 ' +
    kinds.join(',') + '）—— 规则新增一型而界面没接，卡片上就是一枚点了没反应的按钮；界面多认一型则是没有来源的死码' +
    '（AGENTS §2 #18：声明覆盖的范围与实际走的分支之间的差，不会自己喊出来）',
    !!actionBody && !!acts.length && actMissing.length === 0 && actExtra.length === 0 && dupCode.length === 0,
    JSON.stringify({ acts: acts, kinds: kinds, missing: actMissing, extra: actExtra, dup: dupCode }));

  // ---- ⑩ 规则只有一份 ----
  check('⑩ 规则表全盘只有一份：content.js 与 popup/pet.js 里 `var RULES =` 各 0 处，两处都经 `OmitoneDiagnose` 取 —— ' +
    '抄到界面上必然分叉（同台词池那条教训）',
    contentSrc.indexOf('var RULES =') < 0 && petSrc.indexOf('var RULES =') < 0 &&
      petSrc.indexOf('OmitoneDiagnose') >= 0 && contentSrc.indexOf('OmitoneDiagnose') >= 0,
    JSON.stringify({ contentHasRules: contentSrc.indexOf('var RULES =') >= 0,
      petHasRules: petSrc.indexOf('var RULES =') >= 0,
      petUsesLib: petSrc.indexOf('OmitoneDiagnose') >= 0, contentUsesLib: contentSrc.indexOf('OmitoneDiagnose') >= 0 }));

  // ---- ⑪⑫ 账本键与解释链路 ----
  var popLogKey = (popSrc.match(/const RUNTIME_LOGS_KEY = "([^"]+)"/) || [])[1];
  var bgLogKey = (bgSrc.match(/var RUNTIME_LOGS_KEY = '([^']+)'/) || [])[1];
  var explainBody = fnText(popSrc, 'async function petDiagExplain(digest)');
  var sliceCap = Number((explainBody.match(/\.slice\(0, (\d+)\)/) || [])[1]);
  check('⑪ 卡片读的那本账就是后台写的那本（`RUNTIME_LOGS_KEY` 两处逐字相等），且「让她解释」送出去之前的截断与摘要上限' +
    '**同一把尺**（slice 的数 = DIGEST_MAX = ' + L.DIGEST_MAX + '）—— 两侧各写一个数，迟早有一边把摘要拦腰截断',
    !!popLogKey && popLogKey === bgLogKey && sliceCap === L.DIGEST_MAX,
    JSON.stringify({ popupKey: popLogKey, bgKey: bgLogKey, sliceCap: sliceCap, digestMax: L.DIGEST_MAX }));
  check('⑫ 解释走的是 #161 那条聊天链路：`petChatSend(` + 人设键 `PET_DOCTOR_SYSTEM`（在 libs/prompt.js 里**声明且导出**，' +
    '提示词不许内联进调用方），全程不自己拼地址 —— 绝不接中转站（用户原话）',
    explainBody.indexOf('petChatSend(') >= 0 && /sysKey: "PET_DOCTOR_SYSTEM"/.test(explainBody) &&
      /var PET_DOCTOR_SYSTEM = \[/.test(promptSrc) && /PET_DOCTOR_SYSTEM: PET_DOCTOR_SYSTEM/.test(promptSrc) &&
      explainBody.indexOf('fetch(') < 0,
    JSON.stringify({ viaSend: explainBody.indexOf('petChatSend(') >= 0,
      sysKey: /sysKey: "PET_DOCTOR_SYSTEM"/.test(explainBody), declared: /var PET_DOCTOR_SYSTEM = \[/.test(promptSrc),
      exported: /PET_DOCTOR_SYSTEM: PET_DOCTOR_SYSTEM/.test(promptSrc), ownFetch: explainBody.indexOf('fetch(') >= 0 }));

  // ---- ⑬ 两套装束 + 换装不写存档 ----
  var rolesText = (gameSrc.match(/var ROLES = \{/) ? fnText(gameSrc, 'var ROLES = {') : '');
  var roles = null;
  try { roles = rolesText ? new Function('return (' + rolesText.slice(rolesText.indexOf('{')) + ')')() : null; } catch (e) { roles = null; }
  var roleOnText = fnText(contentSrc, 'function pagePetRoleOn(roleKey, msOverride)');
  var roleOffText = fnText(contentSrc, 'function pagePetRoleOff()');
  var writesOutfit = [roleOnText, roleOffText].join('\n');
  var outfitLeaks = ['setItem', 'OUT_KEY', 'SRC_KEY'].filter(function (k) { return writesOutfit.indexOf(k) >= 0; });
  var roleFiles = roles ? [roles.doctor, roles.detective].filter(function (r) {
    return r && fs.existsSync(path.join(ROOT, 'popup', String(r.file)));
  }) : [];
  check('⑬ 换装巧思的两套行头都真在池子里、图在盘上（医生=诊断、侦探=修复中，各带收尾 ms）；' +
    '且页面那一族**只临时改图** —— 两个函数体里 `setItem` / `OUT_KEY` / `SRC_KEY` 各 0 处：' +
    '体检把人自己挑好的衣服悄悄存掉，比不换更害人（批次 61 同形）',
    !!roles && !!roles.doctor && !!roles.detective && roleFiles.length === 2 &&
      Number(roles.doctor.ms) > 0 && Number(roles.detective.ms) > 0 &&
      !!roleOnText && !!roleOffText && outfitLeaks.length === 0,
    JSON.stringify({ doctor: roles && roles.doctor, detective: roles && roles.detective,
      filesOnDisk: roleFiles.length, leaks: outfitLeaks,
      onBody: !!roleOnText, offBody: !!roleOffText }));

  // ---- 页面那一整块：取出来真跑 ----
  var dStart = contentSrc.indexOf('const PAGE_DOCTOR_KEY');
  var dEnd = contentSrc.indexOf('// ── 她自己动');
  var dBlock = dStart >= 0 && dEnd > dStart ? contentSrc.slice(dStart, dEnd) : '';
  var DoctorFactory = null;
  // 医生块里引用到块外的名字：问模型那一发要 configs / apiFetch / normalizeApiKey /
  // PROMPT（提示词唯一真源）与三家渠道的 URL 构造器 —— 桩在 mkDoctor 里给。
  var names = ['chrome', 'self', 'pagePet', 'petGameModule', 'pagePetSayFrom', 'Date', 'setTimeout', 'clearTimeout', 'document',
    'configs', 'apiFetch', 'normalizeApiKey', 'PROMPT', 'buildOpenAICompatibleUrl', 'buildClaudeApiUrl', 'buildGeminiApiUrl'];
  try {
    DoctorFactory = Reflect.construct(Function, names.concat([dBlock +
      '\n    return { note: doctorNote, speak: doctorDeliver, analyzeNow: doctorAnalyze, roleOn: pagePetRoleOn, ' +
      'roleOff: pagePetRoleOff, on: isDoctorOn, asks: function () { return doctorAskCount; }, ' +
      'ring: function () { return doctorRing.slice(); }, ' +
      'skip: function () { return pagePet && pagePet.host ? pagePet.host.dataset.doctorSkip : undefined; }, ' +
      'flag: function () { return doctorOn; }, ' +
      'wsFlag: function () { return webSearchOn; }, ' +
      'wsCell: function () { return pagePet && pagePet.host ? pagePet.host.dataset.webSearch : undefined; }, ' +
      'stamps: function () { return { analyzeAt: doctorAnalyzeAt, ' +
      'lastCode: doctorLastCode, lastCodeAt: doctorLastCodeAt }; } };']));
  } catch (e) { DoctorFactory = null; }
  check('⑭ 页面那一整块医生代码切出来构造成功（doctorMark / doctorNote / doctorDeliver / 问模型两件 / ' +
    'isDoctorOn / 换装两件事 / 联网那四件都在这一格里）—— 切不出来的话 ⑮-㉟ 全部「没执行」，症状与「都通过」一模一样',
    !!DoctorFactory && dBlock.indexOf('function doctorMark') >= 0 &&
      dBlock.indexOf('function doctorNote') >= 0 &&
      dBlock.indexOf('function doctorDeliver') >= 0 && dBlock.indexOf('function isDoctorOn') >= 0 &&
      dBlock.indexOf('function doctorAskModel') >= 0 && dBlock.indexOf('function doctorAskBounded') >= 0 &&
      dBlock.indexOf('function pagePetRoleOn') >= 0 && dBlock.indexOf('function pagePetRoleOff') >= 0 &&
      dBlock.indexOf('const PAGE_WEB_SEARCH_KEY') >= 0 &&
      dBlock.indexOf('function doctorWebSearch') >= 0 && dBlock.indexOf('function doctorWebSearchMark') >= 0 &&
      dBlock.indexOf('function isPetSwitchOn') >= 0,
    JSON.stringify({ blockLen: dBlock.length, factory: !!DoctorFactory,
      wsKey: dBlock.indexOf('const PAGE_WEB_SEARCH_KEY') >= 0,
      wsJudge: dBlock.indexOf('function doctorWebSearch') >= 0,
      wsMark: dBlock.indexOf('function doctorWebSearchMark') >= 0,
      scale: dBlock.indexOf('function isPetSwitchOn') >= 0 }));
  if (!DoctorFactory) return;

  var RING_MAX = constOf(contentSrc, 'DOCTOR_RING_MAX');
  var THROTTLE = constOf(contentSrc, 'DOCTOR_ANALYZE_MS');
  var GAP = constOf(contentSrc, 'DOCTOR_GAP_MS');
  var MIN_SEV = constOf(contentSrc, 'DOCTOR_MIN_SEVERITY');
  var KEY_NAME = (contentSrc.match(/PAGE_DOCTOR_KEY = '([^']+)'/) || [])[1];
  // 联网搜索那枚开关的键名同样**从页面读回来**（测试台不许自己写死第二个键名，AGENTS §5）
  var WS_KEY_NAME = (contentSrc.match(/PAGE_WEB_SEARCH_KEY = '([^']+)'/) || [])[1];
  // 弹窗那两条语句**用页面读回来的键名去定位**：键名一旦两边不同，这里直接匹配不到，
  // popupOn 变成 null，下面那一格当场红 —— 比拿两个写死的字面量互比少一处会说谎的地方
  var popupReadSpan = KEY_NAME
    ? popSrc.match(new RegExp('var raw = r && r\\.' + KEY_NAME + ';\\s+petDoctorEnabledVal = ([^;]+);'))
    : null;
  var popupWriteSpan = KEY_NAME
    ? popSrc.match(new RegExp('chrome\\.storage\\.local\\.set\\(\\{ ' + KEY_NAME + ': value \\? 1 : 0'))
    : null;
  var popupOn = null;
  try {
    popupOn = popupReadSpan
      ? new Function('r', 'var petDoctorEnabledVal;' + popupReadSpan[0] + 'return petDoctorEnabledVal;')
      : null;
  } catch (e) { popupOn = null; }
  // 测试台里所有"这一格存档"都按页面读回来的那枚键名拼，避免测试自己写死第二个键名
  var storeOf = function (v, wv) {
    var o = {};
    o[KEY_NAME] = v;
    if (wv !== undefined) o[WS_KEY_NAME] = wv;
    return o;
  };
  // 联网搜索开关在弹窗那一侧的读回与写成，同样**按页面读回来的键名定位**（同一手法，AGENTS §2 #23）
  var popWsReadSpan = WS_KEY_NAME
    ? popSrc.match(new RegExp('var raw = r && r\\.' + WS_KEY_NAME + ';\\s+petWebSearchVal = ([^;]+);'))
    : null;
  var popWsWriteSpan = WS_KEY_NAME
    ? popSrc.match(new RegExp('chrome\\.storage\\.local\\.set\\(\\{ ' + WS_KEY_NAME + ': value \\? 1 : 0'))
    : null;
  var popWsOn = null;
  try {
    popWsOn = popWsReadSpan
      ? new Function('r', 'var petWebSearchVal;' + popWsReadSpan[0] + 'return petWebSearchVal;')
      : null;
  } catch (e) { popWsOn = null; }

  // 问模型那一发是异步的（`void doctorDeliver(res)`）：凡要断言"她说了/换了装"的格子
  // 都要先 flush 一拍（真实宏任务）把派发落完再读 —— 不然「没说」和「没等到」同形
  var flush = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  // 永不 resolve 的 apiFetch 桩：挂起那一族专用（硬超时由测试手动把注入的 setTimeout 拨响）
  var neverFetch = function () { return new Promise(function () {}); };

  var mkDoctor = function (o) {
    o = o || {};
    var clock = { t: T0 };
    var says = [];
    var writes = [];
    var gets = [];
    var listeners = [];
    var timers = [];
    var baseSrc = o.baseSrc || 'popup/pet-03.png';
    var img = {
      src: baseSrc,
      getAttribute: function (k) { return k === 'src' ? this.src : null; },
      setAttribute: function (k, v) { if (k === 'src') this.src = String(v); }
    };
    var roleProp = { textContent: '', shown: false };
    roleProp.classList = { add: function () { roleProp.shown = true; }, remove: function () { roleProp.shown = false; } };
    // 「被收起」在页面里就是 wrap 上那一枚 class —— 医生那一族要认它（看不见就别换装）
    var wrap = { tucked: !!o.tucked };
    wrap.classList = { contains: function (c) { return c === 'mode-hidden' ? wrap.tucked : false; } };
    var chrome = {
      runtime: { getURL: function (p) { return 'chrome-extension://omitone/' + p; } },
      storage: {
        local: {
          get: function (keys, cb) {
            gets.push(keys);                          // 「几发问存储、问了哪几枚键」要读得回来，不能由测试宣称
            if (o.hang) return;                       // 回调不回来 = 真值还没读到，这一格要单独测
            // 页面那一支一次问**两枚键**（医生开关 + 联网搜索开关）；两格各自由调用方给值，
            // 都没给时交空对象 = 两枚键都缺席（老用户的真实存档）
            cb(o.storeVal === undefined && o.wsVal === undefined
              ? {} : storeOf(o.storeVal, o.wsVal));
          },
          set: function (obj, cb) { writes.push(obj); if (cb) cb(); }
        },
        onChanged: { addListener: function (fn) { listeners.push(fn); } }
      }
    };
    var pagePet = {
      roleBase: '', els: { img: img, roleProp: roleProp, wrap: wrap },
      host: { isConnected: !o.disconnected, dataset: {} }
    };
    var doc = { hidden: !!o.bg };
    // 问模型桩：默认配置没 Key（→ no-key，连请求体都不拼）；带 cfg 的格子自选 apiFetch 行为。
    // fetchCalls 记账，让「没填 Key 一步都不发」有账可查
    var cfg = o.cfg || { apiType: 'openai', apiKey: '', model: '', apiUrl: '' };
    var fetchCalls = [];
    // 记账必须无条件发生：桩由调用方换掉时，「一步都没发」那格就变成没人数的假账
    // body 也要记下 —— 「这一发到底带没带 tools」只能从发出去的字节里读，不能由测试自己宣称
    var apiFetchStub = function (url, opts) {
      fetchCalls.push({ url: String(url), method: opts && opts.method,
        body: opts && typeof opts.body === 'string' ? opts.body : '' });
      if (o.apiFetch) return o.apiFetch(url, opts);
      return Promise.resolve({ success: false, error: 'stub-fetch' });
    };
    // 判断层与联网那把尺**各占一格缺席**：no-diagnose（体检没尺）与 no-lib（搜索没登记）
    // 症状都是"她不说/不搜"，修复方向一个在 libs/diagnose.js、一个在 manifest —— 合并注入就测不出来
    var selfStub = {};
    if (!o.noDx) selfStub.OmitoneDiagnose = D;
    if (!o.noWs) selfStub.OmitoneWebSearch = o.wsFake ? o.wsFake : WS;
    var api = DoctorFactory.call(null, chrome, selfStub, pagePet,
      function () { return { ART: { ROLES: roles } }; },
      function (nme, line) { says.push({ name: nme, line: String(line) }); return o.blockSay ? '' : String(line); },
      { now: function () { return clock.t; } },
      function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
      function (id) { if (id) timers[id - 1] = null; }, doc,
      cfg, apiFetchStub,
      function (k) { return String(k || '').trim(); },
      { PET_DOCTOR_SYSTEM: 'stub-system' },
      function (u) { return String(u || '') + '/openai'; },
      function (u) { return String(u || '') + '/claude'; },
      function (u, m, k) { return String(u || '') + '/gemini'; });
    return { api: api, says: says, clock: clock, img: img, pagePet: pagePet, roleProp: roleProp,
      timers: timers, listeners: listeners, writes: writes, gets: gets, baseSrc: baseSrc, wrap: wrap, doc: doc,
      cfg: cfg, fetchCalls: fetchCalls };
  };
  var hardNeedle = sev3.needles[0];
  // 换码那几格必须挑**同一等级**的另一条：等级低一格的结论在排序里永远排到第二，
  // 说出来的还是上一条硬伤，测到的就不是「换码」而是「冷却」（AGENTS §5「注入只破那一格」）
  var altNeedle = sameHard.needles[0];

  // ---- ⑮ 三态：真值还没读到那一格 ----
  var hAng = mkDoctor({ hang: true });
  hAng.api.note('error', hardNeedle);
  check('⑮ 开关真值**还没读回来**（storage 回调没进来）时不许抢在开关前面说话：`doctorOn` 停在 null、气泡一次都没弹，' +
    '但日志照旧记进环 —— 「还不知道」既不当成开着、也不当成关着，记账更不被一起圈掉（AGENTS §2 #16(b)）',
    hAng.api.flag() === null && hAng.says.length === 0 && hAng.api.ring().length === 1,
    JSON.stringify({ flag: hAng.api.flag(), says: hAng.says.length, ring: hAng.api.ring().length }));

  // ---- ⑯ 「关」的三格与默认关 ----
  var hZero = mkDoctor({ storeVal: 0 });
  var hFalse = mkDoctor({ storeVal: false });
  var hDefault = mkDoctor({});
  var hOne = mkDoctor({ storeVal: 1 });
  hZero.api.note('error', hardNeedle);
  hFalse.api.note('error', hardNeedle);
  hOne.api.note('error', hardNeedle);
  hDefault.api.note('error', hardNeedle);
  await flush();
  check('⑯ 「关」认**三格**：`0`（弹窗真写出去的值）、`false`、以及**键缺席** —— 医生改成默认关之后' +
    '（开口前会花 Key，不许用户看不见时默认烧钱），没写过这枚键的用户就是关；只有 `1`/`true` 算开。' +
    '无论开还是关，warn 都先进环 —— 静音不等于忘记',
    hZero.api.flag() === false && hFalse.api.flag() === false && hDefault.api.flag() === false &&
      hZero.says.length === 0 && hFalse.says.length === 0 && hDefault.says.length === 0 &&
      hZero.api.ring().length === 1 && hOne.api.flag() === true && hOne.says.length === 1,
    JSON.stringify({ zero: [hZero.api.flag(), hZero.says.length, hZero.api.ring().length],
      falseVal: [hFalse.api.flag(), hFalse.says.length, hFalse.api.ring().length],
      absent: [hDefault.api.flag(), hDefault.says.length], one: [hOne.api.flag(), hOne.says.length] }));

  // ---- ⑰ 两侧同一把尺 ----
  var scaleVals = [undefined, 0, 1, false, true];
  var scaleDiff = scaleVals.filter(function (v) {
    var contentSide = mkDoctor({ storeVal: v }).api.flag();
    var popupSide = popupOn ? popupOn(storeOf(v)) : null;
    return contentSide !== popupSide;
  });
  check('⑰ 弹窗回读那一条谓词与页面 `isDoctorOn` 对同一批存档值判出**同一个开/关**（逐个试 ' +
    scaleVals.map(function (v) { return String(v); }).join(' / ') + '）—— 基准不同就出现「界面显示开着、她一句话不说」，' +
    '两边都不报错（AGENTS §2 #23）。键名两侧也得是同一枚：弹窗的读回与写成都用**页面读回来的那个键**定位，定位不到就是分叉',
    !!popupOn && !!popupWriteSpan && scaleDiff.length === 0,
    JSON.stringify({ mismatch: scaleDiff, readFound: !!popupReadSpan, writeFound: !!popupWriteSpan,
      contentKey: KEY_NAME, popupTrue: popupOn ? popupOn(storeOf(1)) : null,
      popupFalse: popupOn ? popupOn(storeOf(false)) : null }));

  // ---- ⑱ info 只攒证据 ----
  var hInfo = mkDoctor({ storeVal: 1 });
  hInfo.api.note('info', hardNeedle);
  check('⑱ info 级只攒证据、不触发判断（一条 warn 就判一次 = 每拍都在体检）；环里那条还在',
    hInfo.says.length === 0 && hInfo.api.ring().length === 1,
    JSON.stringify({ says: hInfo.says.length, ring: hInfo.api.ring().length }));

  // ---- ⑲ 环有界，丢的是最旧 ----
  var hRing = mkDoctor({});
  var ringExtra = 50;
  for (var ri = 0; ri < RING_MAX + ringExtra; ri++) hRing.api.note('info', 'msg' + ri);
  var ringNow = hRing.api.ring();
  check('⑲ 环满丢**最旧**：灌进 ' + (RING_MAX + ringExtra) + ' 条只剩 `DOCTOR_RING_MAX`（从源码读回来 = ' + RING_MAX +
    '）条，第一条正好是第 ' + ringExtra + ' 号 —— 环无限长是内存漏洞，丢错方向则把刚出的事挤掉',
    Number.isFinite(RING_MAX) && ringNow.length === RING_MAX && ringNow[0].message === 'msg' + ringExtra &&
      ringNow[ringNow.length - 1].message === 'msg' + (RING_MAX + ringExtra - 1),
    JSON.stringify({ cap: RING_MAX, len: ringNow.length, first: ringNow[0] && ringNow[0].message,
      last: ringNow[ringNow.length - 1] && ringNow[ringNow.length - 1].message }));

  // ---- ⑳ 体检节流 ----
  var hTh = mkDoctor({ storeVal: 1 });
  hTh.api.note('error', hardNeedle);
  await flush();                             // 第一发真说完（派发是异步的）
  hTh.clock.t += 1000;                       // 没到地板
  hTh.api.note('error', altNeedle);
  var thBlocked = hTh.says.length;           // 节流闸在 doctorNote 同步段，这一读不用等
  hTh.clock.t += THROTTLE + 1;
  hTh.api.note('error', altNeedle);
  await flush();
  check('⑳ 两次体检之间有 `DOCTOR_ANALYZE_MS`（读回来 = ' + THROTTLE + ' 毫秒）的地板：抖动日志只判一次，过点才判第二次。' +
    '这一格特意**换一枚同等级、不同码**的结论来测，免得被下面那把冷却闸挡住、报成「节流真生效了」（自证式假绿）',
    Number.isFinite(THROTTLE) && thBlocked === 1 && hTh.says.length === 2,
    JSON.stringify({ throttle: THROTTLE, blocked: thBlocked, after: hTh.says.length, stamps: hTh.api.stamps() }));

  // ---- ㉑ 同一结论的冷却 ----
  var hCd = mkDoctor({ storeVal: 1 });
  hCd.api.note('error', hardNeedle);            // A 说出（异步落话）
  await flush();
  hCd.clock.t += THROTTLE + 1;
  hCd.api.note('error', altNeedle);             // B 同等级、时间更新 → 顶上；冷却不该拦别的码
  await flush();
  var cdOtherCode = hCd.says.length;
  hCd.clock.t += THROTTLE + 1;
  hCd.api.note('error', altNeedle);             // 还是 B：过了节流地板、没过 5 分钟冷却 → 收声（同步格）
  var cdBlocked = hCd.says.length;
  hCd.clock.t += GAP + THROTTLE + 1;
  hCd.api.note('error', altNeedle);             // 过冷却 → 又能说
  await flush();
  check('㉑ 同一个结论码在 `DOCTOR_GAP_MS`（读回来 = ' + GAP + ' 毫秒）内最多打扰一次；换一枚结论码立刻能说；' +
    '过了冷却又能再说 —— 三把少任何一把，要么变成刷屏、要么变成哑药。' +
    '故意不 wipe 环：wipe 会把 lastCode 一起抹掉，「过冷却又能说」就变成一条恒真的自证',
    Number.isFinite(GAP) && cdOtherCode === 2 && cdBlocked === 2 && hCd.says.length === 3,
    JSON.stringify({ gap: GAP, otherCode: cdOtherCode, blockedWithinGap: cdBlocked, afterGap: hCd.says.length }));

  // ---- ㉒ 她开口的等级地板 ----
  var hSoft = mkDoctor({ storeVal: 1 });
  hSoft.api.note('warn', sev0.needles[0]);
  check('㉒ 她本人只替「这一路走不通」以上说话（地板 `DOCTOR_MIN_SEVERITY` 读回来 = ' + MIN_SEV + '）：提醒级' +
    '（比如「这门刷完了」）交给卡片，不许为一句报平安打断刷课；但那条结论照旧进了环',
    Number.isFinite(MIN_SEV) && hSoft.says.length === 0 && hSoft.api.ring().length === 1 &&
      hSoft.api.stamps().lastCode === '',
    JSON.stringify({ floor: MIN_SEV, says: hSoft.says.length, ring: hSoft.api.ring().length, stamps: hSoft.api.stamps() }));

  // ---- ㉓ 换装与卸装 ----
  var doctorFile = 'chrome-extension://omitone/popup/' + roles.doctor.file;
  var hD = mkDoctor({ storeVal: 1 });
  hD.api.note('error', hardNeedle);
  await flush();                             // 换装发生在问模型之后（异步落地）
  var dressedSrc = hD.img.src;
  var dressedRole = hD.pagePet.host.dataset.role;
  var dressedProp = hD.roleProp.shown;
  var baseKept = hD.pagePet.roleBase === hD.baseSrc;
  hD.api.roleOff();
  check('㉓ 说话之前先换上医生装：图临时换成 `ROLES.doctor.file`（文件名从池子里读回来 = ' + roles.doctor.file +
    '）、dataset.role 记名、道具显影，换之前那身在穿的 original 留在 roleBase 里；卸装后回到那一身、dataset 清干净 —— ' +
    '「修完换回原来的衣服」是用户点名的巧思，全程一次 `storage.set` 都没发生',
    dressedSrc === doctorFile && dressedRole === 'doctor' && dressedProp === true && baseKept &&
      hD.img.src === hD.baseSrc && hD.pagePet.host.dataset.role === undefined &&
      hD.roleProp.shown === false && hD.writes.length === 0,
    JSON.stringify({ want: doctorFile, dressed: dressedSrc, role: dressedRole, prop: dressedProp,
      baseKept: baseKept, afterOff: hD.img.src, writes: hD.writes.length }));

  // ---- ㉔ 说不成/不在场/问的那一会儿被关掉，三处都要把行头收干净 ----
  var hNoSay = mkDoctor({ storeVal: 1, blockSay: true });
  hNoSay.api.note('error', hardNeedle);
  var hAway = mkDoctor({ storeVal: 1, disconnected: true });
  hAway.api.note('error', hardNeedle);
  var hSwitch = mkDoctor({ storeVal: 1 });
  hSwitch.api.note('error', hardNeedle);        // 过了闸、正在问模型（话还没落）
  hSwitch.listeners.forEach(function (fn) { fn(storeOf({ newValue: 0 }), 'local'); });   // 这一拍把开关关掉
  await flush();
  check('㉔ 气泡没弹成（`pagePetSayFrom` 交回空串，尝试那一次仍数得到）时行头当场收回、不许一个人挂着；' +
    '她不在场（宿主没连着）时既不说话也不换装；**问模型的那一会儿开关被关掉**：回话到手也要重过一遍闸 —— ' +
    '收到也不说（late 格单独点名 `switch-off-late`），行头从没挂上 —— ' +
    '三处「说了/没说」与「穿/没穿」必须成对，否则界面留着一身白大褂做着一件没做的事',
    hNoSay.says.length === 1 && hNoSay.img.src === hNoSay.baseSrc &&
      hNoSay.pagePet.host.dataset.role === undefined && hAway.says.length === 0 &&
      hAway.img.src === hAway.baseSrc && hAway.pagePet.host.dataset.role === undefined &&
      hSwitch.says.length === 0 && hSwitch.img.src === hSwitch.baseSrc &&
      hSwitch.api.flag() === false && hSwitch.api.skip() === 'switch-off-late',
    JSON.stringify({ noSay: { says: hNoSay.says.length, src: hNoSay.img.src, role: hNoSay.pagePet.host.dataset.role },
      away: { says: hAway.says.length, src: hAway.img.src, role: hAway.pagePet.host.dataset.role },
      switchOff: { says: hSwitch.says.length, flag: hSwitch.api.flag(), src: hSwitch.img.src, skip: hSwitch.api.skip() } }));

  // ---- ㉕ 她**看不见**的时候不换装（后台 / 被收起）----
  var hBg = mkDoctor({ storeVal: 1, bg: true });
  hBg.api.note('error', hardNeedle);
  var hTuck = mkDoctor({ storeVal: 1, tucked: true });
  hTuck.api.note('error', hardNeedle);
  var hShown = mkDoctor({ storeVal: 1 });
  hShown.api.note('error', hardNeedle);
  await flush();
  check('㉕ 标签页在后台、她被收起时，医生**既不换装也不说话**，并且点名是哪一道闸挡的（bg / hidden）；' +
    '对照格：同一条硬伤、她在场 → 换装 + 开口 + 归因格擦干净。两格被挡时那条日志照旧留在环里（静音不等于忘记）。' +
    '⚠️ 只取「看不见」那两道，不许顺手把 busy／减少动态一起抄进来 —— 体检是一句话不是动画，被它们压掉就变成有硬伤也不吭声',
    hBg.says.length === 0 && hBg.img.src === hBg.baseSrc && hBg.api.skip() === 'bg' &&
      hBg.api.ring().length === 1 && hTuck.says.length === 0 && hTuck.img.src === hTuck.baseSrc &&
      hTuck.api.skip() === 'hidden' && hTuck.api.ring().length === 1 &&
      hShown.says.length === 1 && hShown.img.src === doctorFile && hShown.api.skip() === '',
    JSON.stringify({ bg: [hBg.says.length, hBg.api.skip(), hBg.api.ring().length],
      tucked: [hTuck.says.length, hTuck.api.skip(), hTuck.api.ring().length],
      shown: [hShown.says.length, hShown.api.skip(), hShown.img.src === doctorFile] }));

  // ---- ㉖ 「这一拍为什么没说」八格各占一名 ----
  var dUnknown = mkDoctor({ hang: true });
  dUnknown.api.note('error', hardNeedle);
  var dOff = mkDoctor({ storeVal: 0 });
  dOff.api.note('error', hardNeedle);
  // dTh 的第一发**故意让问模型挂起**（neverFetch）：不然收尾给 dNoSay 的那一发 flush
  // 会把它叫醒、让它把话说出去，throttle 那一格就被自己擦掉了（AGENTS §5「先钉住共享状态」）
  var dTh = mkDoctor({ storeVal: 1, cfg: { apiKey: 'k', model: 'm', apiUrl: 'u' }, apiFetch: neverFetch });
  dTh.api.note('error', hardNeedle);
  dTh.api.note('error', altNeedle);                 // 第二发没过地板 → throttle
  var dQuiet = mkDoctor({ storeVal: 1 });
  dQuiet.api.note('warn', sev0.needles[0]);         // 提醒级 → quiet（同步格）
  var dNoPet = mkDoctor({ storeVal: 1, disconnected: true });
  dNoPet.api.note('error', hardNeedle);
  var dCd = mkDoctor({ storeVal: 1 });
  dCd.api.note('error', hardNeedle);
  await flush();                                    // A 说出 → lastCode 落档
  dCd.clock.t += THROTTLE + 1;                      // 过了地板、没过 5 分钟冷却 → cooldown（同步格）
  dCd.api.note('error', hardNeedle);
  var dNoSay = mkDoctor({ storeVal: 1, blockSay: true });
  dNoSay.api.note('error', hardNeedle);
  var dNoDx = mkDoctor({ storeVal: 1, noDx: true });
  dNoDx.api.note('error', hardNeedle);
  await flush();                                    // dNoSay 的「气泡没弹成」是异步落地的
  var dCells = [dUnknown, dOff, dTh, dQuiet, dNoPet, dCd, dNoSay, dNoDx];
  var skipNames = dCells.map(function (h) { return String(h.api.skip()); });
  check('㉖ 医生「这一拍为什么没说话」八格各有一个名字，逐格读回来必须互不相同（' + skipNames.join(' / ') + '）—— ' +
    '只回空串时这八种成因在 e2e 与现场里长得一模一样，摘掉任何一道闸都不会有人报警' +
    '（批次 61 给自动小动作立过的 `motionSkip` 规矩，体检这一族照抄）。' +
    '⚠️ 名单与 doctorDeliver/doctorNote 里的出口一一对应：新增一格不登记，这一条当场红',
    skipNames.join('|') === 'switch-unknown|switch-off|throttle|quiet|no-pet|cooldown|bubble-blocked|no-diagnose' &&
      skipNames.filter(function (n, i) { return skipNames.indexOf(n) === i; }).length === 8,
    JSON.stringify({ names: skipNames, says: dCells.map(function (h) { return h.says.length; }),
      dressed: dCells.map(function (h) { return h.img.src !== h.baseSrc; }) }));

  // ---- ㉗ 问模型那一发：问到了就照模型那句说 ----
  var hAskOk = mkDoctor({
    storeVal: 1,
    cfg: { apiType: 'openai', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://api.example.com' },
    apiFetch: function (url, opts) {
      return Promise.resolve({ success: true, data: { choices: [{ message: { content: ' 先把这一页刷新一下，再开一次扩展 ' } }] } });
    }
  });
  hAskOk.api.note('error', hardNeedle);
  await flush();
  var askOkLine = hAskOk.says.length ? hAskOk.says[0].line : '';
  check('㉗ 开关开着、Key 也在：开口**之前**先用你的 Key 问一句模型（走 `apiFetch`，POST），问到了就照模型那句说、' +
    '不是本地标题，回话头尾空白裁掉 —— 这是弹窗里「有事用你的 Key 问一句模型」那句承诺的执行',
    hAskOk.api.asks() === 1 && hAskOk.fetchCalls.length === 1 && hAskOk.fetchCalls[0].method === 'POST' &&
      askOkLine === '体检：先把这一页刷新一下，再开一次扩展' &&
      hAskOk.says.length === 1 && hAskOk.api.skip() === '',
    JSON.stringify({ asks: hAskOk.api.asks(), calls: hAskOk.fetchCalls, line: askOkLine, skip: hAskOk.api.skip() }));

  // ---- ㉘ 问失败 → 照本地结论说 ----
  var hAskFail = mkDoctor({
    storeVal: 1,
    cfg: { apiType: 'openai', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://api.example.com' }
  });   // 默认 apiFetch 交 { success:false } —— 网络/服务挂掉的那一格
  hAskFail.api.note('error', hardNeedle);
  await flush();
  var localLine = hShown.says.length ? hShown.says[0].line : '';   // hShown（㉕）就是没 Key 的本地对照
  check('㉘ 问模型不通（HTTP 失败那一格）不许哑：退回本地结论照样开口，且**没 Key 的对照格说的话一模一样** —— ' +
    '「网络坏了她也永远有话说」，只是少了模型润色那一步',
    hAskFail.api.asks() === 1 && hAskFail.fetchCalls.length === 1 && hAskFail.says.length === 1 &&
      hAskFail.says[0].line === localLine && localLine.indexOf('体检：') === 0,
    JSON.stringify({ asks: hAskFail.api.asks(), line: hAskFail.says[0] && hAskFail.says[0].line, local: localLine }));

  // ---- ㉙ 问挂起有硬超时，等的那一会儿并发的另一拍不跟着花钱 ----
  var hHang = mkDoctor({
    storeVal: 1,
    cfg: { apiType: 'openai', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://api.example.com' },
    apiFetch: neverFetch
  });
  hHang.api.note('error', hardNeedle);
  await flush();
  var hangPending = hHang.says.length === 0 && hHang.api.asks() === 1;
  hHang.clock.t += THROTTLE + 1;
  hHang.api.note('error', altNeedle);        // 并发那一拍：她在问 → 不再花钱，直接照本地说
  await flush();
  var reentry = hHang.says.length === 1 && hHang.api.asks() === 1;
  var ASK_TIMEOUT = constOf(contentSrc, 'DOCTOR_ASK_TIMEOUT_MS');
  var askTimer = hHang.timers.filter(function (t) { return t && t.ms === ASK_TIMEOUT + 2000; })[0];
  if (askTimer) askTimer.fn();               // 手动把硬超时拨响（注入的 setTimeout 是记录桩）
  await flush();
  var hAltCtl = mkDoctor({ storeVal: 1 });   // alt 码的本地对照（她说的第二句应与它一致）
  hAltCtl.api.note('error', altNeedle);
  await flush();
  var altLocalLine = hAltCtl.says.length ? hAltCtl.says[0].line : '';
  check('㉙ 问模型那一发带**硬超时**（`DOCTOR_ASK_TIMEOUT_MS` + 2 秒余量，读回来 = ' + (ASK_TIMEOUT + 2000) +
    ' 毫秒）：`await` 只有超时能拦住挂起（try/catch 拦不住，AGENTS §2 #2）—— 超时拨响后退回本地结论照样开口。' +
    '同一时刻最多一发在问：等回话的那一会儿并发的另一拍直接照本地说，`asks()` 恒 1 —— 否则一次体检烧两次钱',
    Number.isFinite(ASK_TIMEOUT) && hangPending && reentry && !!askTimer &&
      hHang.says.length === 2 && hHang.api.asks() === 1 &&
      hHang.says[0].line === altLocalLine && hHang.says[1].line === localLine,
    JSON.stringify({ askTimeout: ASK_TIMEOUT, hangPending: hangPending, reentry: reentry, timer: !!askTimer,
      says: hHang.says.map(function (s) { return s.line; }), asks: hHang.api.asks() }));

  // ---- ㉚ 没填 Key：一步都不发 ----
  var hNoKey = mkDoctor({
    storeVal: 1,
    apiFetch: function () { return Promise.resolve({ success: false, error: 'must-not-be-called' }); }
  });   // 默认 cfg 没填 Key
  hNoKey.api.note('error', hardNeedle);
  await flush();
  check('㉚ 没填 Key：一步都不发 —— `asks()` 与真发出去的请求数都是 0（连请求体都不拼），' +
    '然后照本地规矩开口 —— 弹窗里「不填 Key 只照本地规矩说」那句承诺钉在这里',
    hNoKey.api.asks() === 0 && hNoKey.fetchCalls.length === 0 && hNoKey.says.length === 1 &&
      hNoKey.says[0].line === localLine,
    JSON.stringify({ asks: hNoKey.api.asks(), calls: hNoKey.fetchCalls.length,
      line: hNoKey.says[0] && hNoKey.says[0].line }));

  // ==================== 联网搜索接进「她自己体检」（任务 #183）====================
  // 三处花钱的出口（弹窗聊天 / 让她解释 / 医生）里，**只有弹窗在 [26] 测到**的话，
  // manifest 漏登记 `libs/web-search.js` 这一族就永远没人报警：症状是"她从来不搜"，
  // 一条异常都不打（AGENTS §2 #18）。下面 ㉛-㉟ 把页面那一处也钉上同一把尺。
  var WS_HOST = WS ? WS.OFFICIAL_HOST : '';
  var TOOL_TYPE = WS && WS.toolsFor ? (WS.toolsFor({ on: true })[0] || {}).type : '';
  var CFG_WS_OPEN = { apiType: 'openai', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://' + WS_HOST };
  var CFG_WS_RELAY = { apiType: 'openai', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://relay.example.com/v1' };
  var CFG_WS_CLAUDE = { apiType: 'claude', apiKey: 'sk-test', model: 'stub-model', apiUrl: 'https://' + WS_HOST };
  // 发出去的字节才算证据：这一发到底带没带 tools，只能从 body 里读（测试台不许自己宣称）
  var wsBody = function (h) {
    if (!h.fetchCalls.length) return null;
    try { return JSON.parse(h.fetchCalls[0].body); } catch (e) { return null; }
  };
  var wsHasTools = function (h) { var b = wsBody(h); return b ? Array.isArray(b.tools) : null; };
  var wsBodyKeys = function (h) { var b = wsBody(h); return b ? Object.keys(b).join(',') : '(没发出去)'; };

  // ---- ㉛ 两侧同一枚键、同一把三态尺 ----
  var wsVals = [undefined, 0, 1, false, true];
  var wsPopupSide = wsVals.map(function (v) { return popWsOn ? popWsOn(storeOf(1, v)) : null; });
  var wsPageSide = wsVals.map(function (v) { return mkDoctor({ storeVal: 1, wsVal: v }).api.wsFlag(); });
  check('㉛ 「联网搜索」这枚开关在弹窗与页面两侧是**同一枚键名、同一把三态尺**（键名从页面首行读回 = ' + WS_KEY_NAME +
    '，弹窗那两句读写都按这一枚键定位 —— 两边一旦分叉，这里根本匹配不到，当场红）：' +
    '存档里 缺席 / 0 / 1 / false / true 五格，弹窗判出来的布尔与页面 `webSearchOn` 逐格相等，' +
    '且只有 1 与 true 两格算开。各写一把尺的下场是弹窗显示"已开启"、页面那一发从来不搜，' +
    '而且不报错、不留日志（AGENTS §2 #23 / #18 同族）',
    !!WS && !!WS_KEY_NAME && !!popWsReadSpan && !!popWsWriteSpan &&
      wsVals.every(function (v, i) {
        return typeof wsPopupSide[i] === 'boolean' && wsPopupSide[i] === wsPageSide[i];
      }) && wsPageSide[0] === false && wsPageSide[1] === false && wsPageSide[3] === false &&
      wsPageSide[2] === true && wsPageSide[4] === true,
    JSON.stringify({ key: WS_KEY_NAME, lib: !!WS, popRead: !!popWsReadSpan, popWrite: !!popWsWriteSpan,
      vals: wsVals.map(function (v) { return String(v); }), popup: wsPopupSide, page: wsPageSide }));

  // ---- ㉜ 两枚键一次读回；读不回来时不许猜 ----
  var hWsOne = mkDoctor({ storeVal: 1, wsVal: 1, cfg: CFG_WS_OPEN,
    apiFetch: function () {
      return Promise.resolve({ success: true, data: { choices: [{ message: { content: '刷新一下这一页就好' } }] } });
    } });
  hWsOne.api.note('error', hardNeedle);
  await flush();
  var hWsNoRead = mkDoctor({ hang: true, wsVal: 1, cfg: CFG_WS_OPEN });
  hWsNoRead.api.note('error', hardNeedle);
  await flush();
  var askedKeys = (hWsOne.gets[0] || []).map(String);
  check('㉜ 医生启动时**一发 `storage.get` 问两枚键**（体检开关 + 联网搜索开关，读回来 = ' + askedKeys.join(' / ') +
    '）：分两次读就多两个"真值还没回来"的窗口，而联网那一发要在**同一次问模型**上决定花不花额外的钱，' +
    '慢半拍那一支会被当成"用户没开"（三态里最不该塌的一格）。对照格：回调没进来时 `webSearchOn` 停在 **null**、' +
    '一步都不问、一个请求都不发，说的还是老那句"开关真值还没读到" —— 「还不知道」不许塌进"开着"，' +
    '也不许实现成这一拍什么都不说（AGENTS §2 #12 / #14）',
    hWsOne.gets.length === 1 && askedKeys.length === 2 && askedKeys.indexOf(KEY_NAME) >= 0 &&
      askedKeys.indexOf(WS_KEY_NAME) >= 0 && hWsOne.api.asks() === 1 &&
      hWsNoRead.gets.length === 1 && hWsNoRead.api.wsFlag() === null && hWsNoRead.api.asks() === 0 &&
      hWsNoRead.fetchCalls.length === 0 && hWsNoRead.api.skip() === 'switch-unknown',
    JSON.stringify({ gets: hWsOne.gets.length, keys: askedKeys, asks: hWsOne.api.asks(),
      hangFlag: hWsNoRead.api.wsFlag(), hangAsks: hWsNoRead.api.asks(),
      hangCalls: hWsNoRead.fetchCalls.length, hangSkip: hWsNoRead.api.skip() }));

  // ---- ㉝ 开关开着 + 官方域：那一份 tools 真进了请求体 ----
  var bodyWsOn = wsBody(hWsOne);
  check('㉝ 页面里的医生**真把联网搜索带出去了**：开关开着 + 官方域 + OpenAI 形状时，发出去的请求体里恰好一枚工具声明' +
    '（type = ' + TOOL_TYPE + '，从 `libs/web-search.js` 的 `toolsFor` 读回来，测试台不写第二份），' +
    '`temperature` 这一格整个不写（"带 tools 时服务端怎么对待它"没测过，没测过的参数不许照发），' +
    '`max_tokens` 保持改动前那个数，归因格 `dataset.webSearch` 落成 on —— ' +
    '只测弹窗那一处，manifest 漏登记这一族就是零覆盖（AGENTS §2 #18）',
    TOOL_TYPE === 'deepseek_web_search' && !!bodyWsOn && Array.isArray(bodyWsOn.tools) &&
      bodyWsOn.tools.length === 1 && bodyWsOn.tools[0].type === TOOL_TYPE &&
      Object.keys(bodyWsOn.tools[0]).length === 1 && bodyWsOn.temperature === undefined &&
      bodyWsOn.max_tokens === 320 && hWsOne.api.wsCell() === 'on' && hWsOne.fetchCalls.length === 1,
    JSON.stringify({ cell: hWsOne.api.wsCell(), keys: wsBodyKeys(hWsOne), tools: bodyWsOn && bodyWsOn.tools,
      max: bodyWsOn && bodyWsOn.max_tokens, url: hWsOne.fetchCalls[0] && hWsOne.fetchCalls[0].url }));

  // ---- ㉞ 「带不动」的成因各占一格，互不相同，且都不许多花一次钱 ----
  var cOff = mkDoctor({ storeVal: 1, wsVal: 0, cfg: CFG_WS_OPEN });
  var cRelay = mkDoctor({ storeVal: 1, wsVal: 1, cfg: CFG_WS_RELAY });
  var cType = mkDoctor({ storeVal: 1, wsVal: 1, cfg: CFG_WS_CLAUDE });
  var cNoLib = mkDoctor({ storeVal: 1, wsVal: 1, cfg: CFG_WS_OPEN, noWs: true });
  var cShape = mkDoctor({ storeVal: 1, wsVal: 1, cfg: CFG_WS_OPEN,
    wsFake: { decisionOf: function () { throw new Error('stub-throw'); } } });
  [cOff, cRelay, cType, cNoLib, cShape].forEach(function (h) { h.api.note('error', hardNeedle); });
  await flush();
  var cCells = [cOff, cRelay, cType, cNoLib, cShape].map(function (h) { return String(h.api.wsCell()); });
  var cTools = [cOff, cRelay, cType, cNoLib, cShape].map(wsHasTools);
  check('㉞ 医生「这一发带不动联网搜索」的成因有**五格各占一名**（' + cCells.join(' / ') +
    '），逐格读回来互不相同，并且五格**一个都没把 tools 拼进请求体**：' +
    '用户没开开关（off）/ 地址是别人的服务器（not-official）/ 协议形状不对（type）/ ' +
    '模块没登记（no-lib，该红的是 manifest 那一行）/ 判定本身读不出（lib-shape）—— ' +
    '压成一格的代价是"漏登记"被说成"你没开开关"，用户听完去点开关而修不好（AGENTS §2 #12 / #18）',
    cCells.filter(function (n, i) { return cCells.indexOf(n) === i; }).length === 5 &&
      cCells.join('|') === 'off|not-official|type|no-lib|lib-shape' &&
      cTools.every(function (t) { return t === false; }) &&
      [cOff, cRelay, cType, cNoLib, cShape].every(function (h) { return h.fetchCalls.length === 1; }) &&
      [cOff, cRelay, cType, cNoLib, cShape].every(function (h) { return h.says.length === 1; }),
    JSON.stringify({ cells: cCells, tools: cTools, calls: [cOff, cRelay, cType, cNoLib, cShape].map(function (h) { return h.fetchCalls.length; }),
      says: [cOff, cRelay, cType, cNoLib, cShape].map(function (h) { return h.says.length; }),
      keys: [cOff, cRelay, cType, cNoLib, cShape].map(wsBodyKeys) }));

  // ---- ㉟ 没开开关：那一发的字节形状与改动前逐字相同 ----
  var hWsOff = mkDoctor({ storeVal: 1, wsVal: 0, cfg: CFG_WS_OPEN,
    apiFetch: function () {
      return Promise.resolve({ success: true, data: { choices: [{ message: { content: '刷新一下这一页就好' } }] } });
    } });
  hWsOff.api.note('error', hardNeedle);
  await flush();
  var bodyWsOffKeys = wsBodyKeys(hWsOff);
  check('㉟ 开关没开时，医生那一发请求体的**键顺序与改动前逐字相同**（' + bodyWsOffKeys +
    ' = model,messages,temperature,max_tokens）：新参数只许在用户明确开了那枚开关之后才出现，' +
    '没开的人下载的字节变了、行为却没变，就是把"默认不烧钱"这句话实现成了"多带一格没人验过的参数"。' +
    '对照 ㉝：开了以后 `temperature` 让位给 `tools`，`max_tokens` 一格不动',
    bodyWsOffKeys === 'model,messages,temperature,max_tokens' &&
      hWsOff.api.wsCell() === 'off' && wsHasTools(hWsOff) === false && hWsOff.api.asks() === 1,
    JSON.stringify({ keys: bodyWsOffKeys, cell: hWsOff.api.wsCell(), asks: hWsOff.api.asks() }));
}

async function testPreviewChannelNotice() {
  console.log('\n[28] 预览版下载口：previewPlan 六格各说各话，接线一律不许落在正式版那两个地址上（批次 135）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var popSrc = read('popup/popup.js');
  var htmlSrc = read('popup/popup.html');
  var relSrc = read('tools/github-release.js');

  // 花括号配对取整段（函数体 / if 块两种都行）；坏了交空串，后面自证会响
  var fnText = function (src, decl) {
    var at = src.indexOf(decl);
    if (at < 0) return '';
    var start = src.indexOf('{', at);
    if (start < 0) return '';
    var depth = 0;
    for (var i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
    }
    return '';
  };
  // 那三条地址是模板串（里面带 `${UPDATE_REPO}`），所以 eval 时把仓库名当参数喂进去
  var repoM = popSrc.match(/(?:var|let|const)\s+UPDATE_REPO\s*=\s*["']([^"']+)["']/);
  var REPO = repoM ? repoM[1] : '';
  var constOf = function (src, name) {
    var m = src.match(new RegExp('(?:var|let|const)\\s+' + name + '\\s*=\\s*([^;\\n]+);'));
    if (!m) return NaN;
    try { return new Function('UPDATE_REPO', 'return (' + m[1] + ')')(REPO); } catch (e) { return NaN; }
  };
  var arrOf = function (src, name) {
    var m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;'));
    if (!m) return null;
    try { return new Function('return (' + m[1].replace(/\/\/[^\n]*/g, '') + ')')(); } catch (e) { return null; }
  };

  var planSrc = fnText(popSrc, 'function previewPlan(');
  var cmpSrc = fnText(popSrc, 'function cmpVersion(');
  var chkSrc = fnText(popSrc, 'function checkPreviewChannel(');
  var hideSrc = fnText(popSrc, 'function hidePreviewChannel(');
  var updSrc = fnText(popSrc, 'async function checkUpdate(');
  // 锚点紧到只命中那一处：`if (els.doPreview)` 带花括号才是处理器，光秃秃那句在
  // hidePreviewChannel 里也有一枚（少一个 `{` 就会切到别人的身上，AGENTS §5「锚点被定义本身命中」同族）
  var DL_ANCHOR = 'if (els.doPreview) {';
  var dlHits = popSrc.split(DL_ANCHOR).length - 1;
  var dlSrc = fnText(popSrc, DL_ANCHOR);
  var PV_ASSET = constOf(popSrc, 'UPDATE_PREVIEW_ASSET');
  var PV_API = constOf(popSrc, 'UPDATE_PREVIEW_API');
  var PV_ZIP = constOf(popSrc, 'UPDATE_PREVIEW_ZIP');
  var pvAssets = arrOf(relSrc, 'PREVIEW_ASSETS');
  var stableOnly = arrOf(relSrc, 'STABLE_ONLY_NAMES');
  var pvTag = constOf(relSrc, 'PREVIEW_TAG');

  var cmpV = null, plan = null;
  try { cmpV = new Function('return (' + cmpSrc + ')')(); } catch (e) { cmpV = null; }
  try {
    // 把弹窗里那一份**真函数**取出来，喂它自己文件里的真常量 —— 探针另写一份口径就等于没测
    plan = new Function('UPDATE_PREVIEW_ASSET', 'cmpVersion', 'return (' + planSrc + ')')(PV_ASSET, cmpV);
  } catch (e) { plan = null; }

  check('⓪ 真函数与真常量都取得到（判断层在弹窗文件顶层、可单独 eval）—— 取不到时后面每一条都是「没执行」，' +
    '而「没执行」和「通过」在报告里长得一模一样',
    typeof cmpV === 'function' && typeof plan === 'function' &&
      typeof PV_ASSET === 'string' && PV_ASSET.length > 4 &&
      typeof PV_API === 'string' && typeof PV_ZIP === 'string' &&
      !!chkSrc && !!hideSrc && !!updSrc && !!dlSrc &&
      Array.isArray(pvAssets) && pvAssets.length === 2 && Array.isArray(stableOnly) && stableOnly.length === 2,
    JSON.stringify({ plan: typeof plan, cmp: typeof cmpV, asset: PV_ASSET, chk: chkSrc.length,
      hide: hideSrc.length, upd: updSrc.length, dl: dlSrc.length, pv: pvAssets && pvAssets.length }));
  if (typeof plan !== 'function' || typeof cmpV !== 'function' ||
      typeof PV_API !== 'string' || typeof PV_ZIP !== 'string' || typeof PV_ASSET !== 'string' ||
      !Array.isArray(pvAssets) || !Array.isArray(stableOnly)) return;

  var STAMP = '2026-11-20T00:12:34Z';
  // 真包发出去那一发的回包形状（tag 恒为 'preview'、版本号只写在标题上 —— cmdPreview 就是这么 POST 的）
  var mkRel = function (over) {
    var r = {
      tag_name: 'preview',
      name: '预览版 1.3.1 experimental b20261120-0812',
      prerelease: true,
      assets: [{ name: 'omitone-preview.zip', updated_at: STAMP }]
    };
    for (var k in over) r[k] = over[k];
    return r;
  };
  var STABLE = '1.3.0';
  var W = function (rel, fetched, local, stable) { return plan(rel, fetched, local, stable); };

  // ---- ① 正常说话 ----
  var shown = W(mkRel(), true, { version: '1.3.0' }, STABLE);
  check('① 包真在、号比正式版新、还没装这一支 —— 这一格要说话，号从**标题**里读（`preview` 那个 tag 本身不带版本号），' +
    '包的 `updated_at` 原样带出（弹窗那句「上次打包」用它，不许拿正式版的时间）',
    shown.speak === true && shown.why === 'show' && shown.version === '1.3.1' && shown.stamp === STAMP,
    JSON.stringify(shown));

  // ---- ② 号的两处来源：tag 优先、标题兜底 ----
  var fromTag = W(mkRel({ tag_name: 'v1.3.2' }), true, { version: '1.3.0' }, STABLE);
  check('② 号先读 `tag_name`、读不到才退到标题 —— 两处都有号时以 tag 为准（只留一份口径，别让两个字段各说一个版本）',
    fromTag.speak === true && fromTag.version === '1.3.2', JSON.stringify(fromTag));

  // ---- ③ 没问到（404 与断网同形） ----
  var askOff = W(mkRel(), false, { version: '1.3.0' }, STABLE);
  var askNil = W(null, true, { version: '1.3.0' }, STABLE);
  check('③ 没问到一律落 `ask-failed`：`res.ok` 为假（预览口还没发，这是常态）与回包读不出都算这一格 —— ' +
    '它**不许**顺手说一句像"你网络坏了"的话，那句是正式版那一路的活儿',
    askOff.speak === false && askOff.why === 'ask-failed' &&
      askNil.speak === false && askNil.why === 'ask-failed',
    JSON.stringify({ notOk: askOff, noBody: askNil }));

  // ---- ④ 读不出号：绝不猜 ----
  var noVer = W(mkRel({ name: '预览版（还没写版本号）' }), true, { version: '1.3.0' }, STABLE);
  check('④ tag 与标题都没有版本号时落 `no-version`，**绝不猜一个号出来** —— 猜出来的号让同学以为线上真有这一版，' +
    '点下去拿到的却不知是哪一份包（AGENTS §2 #18「认不出来就交空串，绝不猜」同一族）',
    noVer.speak === false && noVer.why === 'no-version', JSON.stringify(noVer));

  // ---- ⑤ 包不在：三种形状都闭嘴 ----
  var emptyAssets = W(mkRel({ assets: [] }), true, { version: '1.3.0' }, STABLE);
  var nulAssets = W({ tag_name: 'preview', name: '预览版 1.3.1 experimental', assets: null }, true, { version: '1.3.0' }, STABLE);
  var otherAsset = W(mkRel({ assets: [{ name: 'omitone.zip', updated_at: STAMP }] }), true, { version: '1.3.0' }, STABLE);
  check('⑤ 没得下载就闭嘴（`assets` 是空数组 / 不是数组 / 里面只有正式版那个名字）三格都落 `no-asset` —— ' +
    '亮着按钮点下去是 GitHub 的 404 页，而它看起来像"预览版撤掉了"，不是"我们这边判错了"',
    emptyAssets.why === 'no-asset' && nulAssets.why === 'no-asset' && otherAsset.why === 'no-asset' &&
      emptyAssets.speak === false,
    JSON.stringify({ empty: emptyAssets.why, nul: nulAssets.why, other: otherAsset.why }));

  // ---- ⑥ 转正忘撤口 + 分格顺序 ----
  var stale = W(mkRel({ name: '预览版 1.3.0 experimental b20260101-0000' }), true, { version: '1.3.0' }, '1.3.0');
  var staleNewerLocal = W(mkRel({ name: '预览版 1.3.0 experimental b20260101-0000' }), true, { version: '1.2.9' }, '1.3.0');
  check('⑥ 预览号不比正式版新（**转正之后忘了撤口**）落 `same-as-stable`，即使本地比预览号还旧也不算"有更新的可以装" —— ' +
    '那份是旧实验包，装上只会让人一直被告知自己在用预览版。判据顺序也必须排在"已装过"之前，' +
    '倒了就把两格合成一格，「线上口过期」与「你已经装了」从此分不开',
    stale.why === 'same-as-stable' && staleNewerLocal.why === 'same-as-stable' && stale.speak === false,
    JSON.stringify({ same: stale, olderLocal: staleNewerLocal }));

  // ---- ⑦ 已经装了这一支 ----
  var hasIt = W(mkRel(), true, { version: '1.3.1' }, STABLE);
  var ahead = W(mkRel(), true, { version: '1.3.2' }, STABLE);
  var noLocal = W(mkRel(), true, null, STABLE);
  check('⑦ 同号与更高版本都落 `not-newer`（装了这一支的人不必再被预告一次）；读不到本地版本时不塞这一格、放行到说话 —— ' +
    '`cmpVersion` 把 `1.3` 与 `1.3.0` 视为相同，这一族只许用那一把尺',
    hasIt.why === 'not-newer' && ahead.why === 'not-newer' && noLocal.speak === true && noLocal.why === 'show',
    JSON.stringify({ same: hasIt.why, higher: ahead.why, unknownLocal: noLocal.why }));

  // ---- ⑧ 六格名字两两不等 ----
  var whyList = [shown.why, askOff.why, noVer.why, emptyAssets.why, stale.why, hasIt.why];
  var dup = whyList.filter(function (w, i) { return whyList.indexOf(w) !== i; });
  check('⑧ 上面六格的名字两两不等（AGENTS §2 #12）—— 五格都"不说话"，但只有分开写才测得出哪一格坏了；' +
    '压成两态时"预览口还没发"必然被划进"你装的就是最新"',
    dup.length === 0 && new Set(whyList).size === 6, JSON.stringify({ whys: whyList, dup: dup }));

  // ---- ⑨ 判断层不碰 DOM ----
  check('⑨ 判断层一个字 DOM 都不碰（`previewPlan` 体内没有 `els` / `document` / `style`）—— 分成这样上面那些格子才能' +
    '在 Node 里跑真函数；它一旦自己写界面，这一层就退化成"只有起浏览器才测得到"（AGENTS §5「端到端发现的问题下沉到集成层」反着走）',
    planSrc.indexOf('els') < 0 && planSrc.indexOf('document') < 0 && planSrc.indexOf('style') < 0,
    JSON.stringify({ els: planSrc.indexOf('els'), doc: planSrc.indexOf('document'), style: planSrc.indexOf('style') }));

  // ---- ⑩ 收那一格：话与按钮一起收 ----
  check('⑩ 收掉预览那一格时**两枚一起收**（`previewMsg` + `doPreview`，各自 `display = "none"`）—— 只收一枚就是' +
    '「话没了、按钮还在」，点下去落到一个包里根本没东西的地址',
    /els\.previewMsg[\s\S]{0,60}display\s*=\s*"none"/.test(hideSrc) &&
      /els\.doPreview[\s\S]{0,60}display\s*=\s*"none"/.test(hideSrc) &&
      hideSrc.indexOf('updateMsg') < 0,
    JSON.stringify({ msg: hideSrc.indexOf('previewMsg'), btn: hideSrc.indexOf('doPreview'), len: hideSrc.length }));

  // ---- ⑪ 落地层不越界 + 带超时 ----
  check('⑪ 预览那一格的落地只写 `previewMsg` / `doPreview`，**一个 `updateMsg` 都不碰**（共享正式版那句等于把「预览口还没发」' +
    '盖到刚说出口的正式版结论上，AGENTS §2 #14「谁先说话是要紧事」）；而那一发 `fetch` 外面包了 `withTimeout`' +
    '（挂起比报错贵，`try/catch` 拦不住，AGENTS §2 #2）；不说话那一支确实调了 `hidePreviewChannel(`',
    chkSrc.indexOf('updateMsg') < 0 && chkSrc.indexOf('previewMsg') >= 0 && chkSrc.indexOf('doPreview') >= 0 &&
      chkSrc.indexOf('withTimeout') >= 0 && chkSrc.indexOf('hidePreviewChannel(') >= 0 &&
      chkSrc.indexOf('plan.version') >= 0,
    JSON.stringify({ updateMsg: chkSrc.indexOf('updateMsg'), timeout: chkSrc.indexOf('withTimeout'),
      hide: chkSrc.indexOf('hidePreviewChannel('), ver: chkSrc.indexOf('plan.version') }));

  // ---- ⑫ 两条地址都钉在 preview 那一支 ----
  check('⑫ 查询与下载两条地址都钉在预览支上：查询走 `releases/tags/preview`、下载走 ' +
    '`releases/download/preview/omitone-preview.zip`，两条里都不出现 `/releases/latest` —— 那一条是正式版永久直链，' +
    '预览口挂上去就等于给所有人发实验包（1.2.9 那次「下载变成 1.2.8」的同一种形状，只是方向相反）；' +
    '地址里那枚文件名还必须等于判「包里有没有东西」用的那个常量，两处不同名就是"判据说有包、点下去 404"',
    PV_API.indexOf('/releases/tags/preview') >= 0 &&
      PV_ZIP.indexOf('/releases/download/preview/omitone-preview.zip') >= 0 &&
      PV_API.indexOf('releases/latest') < 0 && PV_ZIP.indexOf('releases/latest') < 0 &&
      PV_ZIP.slice(PV_ZIP.lastIndexOf('/') + 1) === PV_ASSET,
    JSON.stringify({ api: PV_API, zip: PV_ZIP, asset: PV_ASSET }));

  // ---- ⑬ 与发版侧同一把尺 ----
  check('⑬ 弹窗里那个预览附件名**逐字等于**发版工具写上去的那一个（`PREVIEW_ASSETS[0].name`），tag 也对得上 —— ' +
    '两侧各写一份迟早分叉，分叉的表现是「包发出去了、弹窗说没有」或反过来「弹窗说有、点下去 404」',
    pvAssets[0].name === PV_ASSET && pvTag === 'preview' &&
      PV_API.indexOf('/' + pvTag) >= 0 && PV_ZIP.indexOf('/' + pvTag + '/') >= 0,
    JSON.stringify({ popup: PV_ASSET, release: pvAssets[0].name, tag: pvTag, api: PV_API, zip: PV_ZIP }));

  // ---- ⑭ 两族附件名不许重合 ----
  var pvNames = pvAssets.map(function (a) { return a.name; });
  var collide = pvNames.filter(function (n) { return stableOnly.indexOf(n) >= 0; });
  check('⑭ 预览那两枚名字与稳定通道那两枚**一个都不重合** —— `omitone.zip` / `Omitone-manual.pdf` 出现在预览口里，' +
    '等于把实验包挂到正式版那条永久直链上（AGENTS §7.5：附件名一改，恰好是"只会点这一个链接"的那批用户拿到 404 或错包）',
    collide.length === 0 && pvNames.indexOf('omitone.zip') < 0 && stableOnly.indexOf('omitone-preview.zip') < 0,
    JSON.stringify({ pv: pvNames, stable: stableOnly, collide: collide }));

  // ---- ⑮ 预览按钮的处理体 ----
  check('⑮ 预览按钮点下去用的地址只有 `UPDATE_PREVIEW_ZIP` 一个 —— 处理体内 `UPDATE_ZIP`（正式版那条）一次都不出现，' +
    '`chrome.downloads.download` 那一发与它失败的兜底（新开标签）都指向预览包；两条地址混用就是「以为是预览、下到的是正式版」',
    dlHits === 1 && dlSrc.indexOf('UPDATE_PREVIEW_ZIP') >= 0 && dlSrc.indexOf('UPDATE_ZIP') < 0 &&
      dlSrc.indexOf('downloads.download') >= 0 && dlSrc.indexOf('tabs.create') >= 0,
    JSON.stringify({ hits: dlHits, prev: dlSrc.indexOf('UPDATE_PREVIEW_ZIP'), stable: dlSrc.indexOf('UPDATE_ZIP'),
      dl: dlSrc.indexOf('downloads.download'), tab: dlSrc.indexOf('tabs.create'), len: dlSrc.length }));

  // ---- ⑯ 页面出厂状态与 els 登记 ----
  check('⑯ 弹窗页面里那两枚（`previewMsg` / `doPreview`）**出厂就 `display:none`**，且 `els` 两枚都登记 —— ' +
    '默认亮着的话每个打开弹窗的人都被预告一句「有预览版」，而 `previewPlan` 那一层根本没走到（AGENTS §5「断言绿有两种：' +
    '走到了、和根本没走到那一层」）；登记漏一枚，`els.xxx` 是 undefined，说话那一支静默什么都不画',
    /id="previewMsg"[^>]*style="display:none"/.test(htmlSrc) &&
      /id="doPreview"[^>]*style="display:none"/.test(htmlSrc) &&
      popSrc.indexOf('previewMsg: $("previewMsg")') >= 0 &&
      popSrc.indexOf('doPreview: $("doPreview")') >= 0,
    JSON.stringify({ msg: htmlSrc.indexOf('id="previewMsg"'), btn: htmlSrc.indexOf('id="doPreview"') }));

  // ---- ⑰ checkUpdate 的先后 ----
  var hideAt = updSrc.indexOf('hidePreviewChannel();');
  var stableSetAt = updSrc.indexOf('stableRemote = remoteVersion;');
  var finallyAt = updSrc.indexOf('} finally {');
  var callAt = updSrc.indexOf('await checkPreviewChannel(local, stableRemote)');
  check('⑰ 检测更新这一轮的先后：开头先 `hidePreviewChannel()`（上一轮的预览话不许留在这一轮屏幕上）；' +
    '`let stableRemote = ""` 只在真读到线上号时赋值（查不到就写空串，不许拿上一轮的号冒充这一轮）；' +
    '`checkPreviewChannel` 调在 `} finally {` **之后**、自己套一个 try —— 预览口挂了不许把正式版那句改口',
    hideAt >= 0 && hideAt < stableSetAt && stableSetAt >= 0 && finallyAt >= 0 && callAt > finallyAt &&
      updSrc.indexOf('let stableRemote = "";') >= 0 &&
      updSrc.indexOf('checkPreviewChannel(local, stableRemote)') >= 0,
    JSON.stringify({ hideAt: hideAt, stableSetAt: stableSetAt, finallyAt: finallyAt, callAt: callAt }));

  // ---- ⑱ 稳定版那两条地址不许被顺手改掉 ----
  var ST_API = constOf(popSrc, 'UPDATE_API');
  var ST_ZIP = constOf(popSrc, 'UPDATE_ZIP');
  check('⑱ 稳定版那两条地址本轮一个字没动：查询仍是 `releases/latest`、下载仍是那条永久直链 `.../latest/download/omitone.zip`，' +
    '且与预览两条**互不相同** —— 预览这一族加进来最贵的失误就是顺手把正式版指向 preview，' +
    '那等于从此 README 那条入口给所有人发实验包（AGENTS §7.5）',
    typeof ST_API === 'string' && typeof ST_ZIP === 'string' &&
      ST_API.indexOf('/releases/latest') >= 0 &&
      ST_ZIP.indexOf('/releases/latest/download/omitone.zip') >= 0 &&
      ST_API !== PV_API && ST_ZIP !== PV_ZIP &&
      ST_API.indexOf('tags/preview') < 0 && ST_ZIP.indexOf('preview') < 0,
    JSON.stringify({ stApi: ST_API, stZip: ST_ZIP, pvApi: PV_API, pvZip: PV_ZIP }));

  // ---- ⑲ 说出口的那句要让人掂量，不是"有新版快点" ----
  check('⑲ 预览那一格说出口的话必须让人**掂量**：版本号取自判据（`plan.version`，不是又拼一次），句子写清代价（可能把正在刷的课弄坏）、' +
    '性质（实验支线）、出问题要报的三样（哪门课 · 哪一节 · 什么现象）、以及退回正式版怎么走；按钮那枚字也写明是「先掂量」—— ' +
    '只写「有预览版可以更新」等于把实验包推给正在赶作业的人',
    chkSrc.indexOf('plan.version') >= 0 && chkSrc.indexOf('弄坏') >= 0 && chkSrc.indexOf('实验支线') >= 0 &&
      chkSrc.indexOf('哪门课') >= 0 && chkSrc.indexOf('哪一节') >= 0 && chkSrc.indexOf('什么现象') >= 0 &&
      chkSrc.indexOf('重装 omitone.zip') >= 0 && htmlSrc.indexOf('先掂量') >= 0,
    JSON.stringify({ ver: chkSrc.indexOf('plan.version'), risk: chkSrc.indexOf('弄坏'),
      nature: chkSrc.indexOf('实验支线'), rollback: chkSrc.indexOf('重装 omitone.zip'),
      btn: htmlSrc.indexOf('先掂量') }));
}

/** ---- [29] 批次 137：多空填空的分隔符容错（GitHub issue #2） ---- */
/**
 * 为什么这一段要从盘上把方法取出来真跑：`_splitFillAnswerParts` 的判据是**段数 == 格子数**，
 * 而"切错了"这件事在页面上不留任何异常 —— 四格填了同一串、隐藏域拼了一次，
 * 站点照样判错，只有把形状摆到方法面前才知道它切不切。
 * ⚠️ ① 那条是闸门：拿不出方法时后面每一格都会"红 0 条"而不是"没执行"（AGENTS §5）。
 */
async function testFillAnswerSeparatorTolerance() {
  console.log('\n[29] 多空填空：模型自己发明分隔符时按空切开，段数对不上照旧整串并单独说一声（批次 137）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var dom = read('src/page/75-quiz-dom.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };

  var split = buildFrom(dom, '_splitFillAnswerParts', {});
  var note = buildFrom(dom, '_noteFillSplitMismatch', { emitRuntimeLog: say });
  var fillBody = bodyOf(dom, '_fillText');

  check('① 两件方法都能从 75 片段原样取出来真跑，`_fillText` 里三处接线也没被删（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    typeof split === 'function' && typeof note === 'function' &&
    fillBody.indexOf('this._splitFillAnswerParts(raw, inputs.length)') >= 0 &&
    fillBody.indexOf('this._noteFillSplitMismatch(el, inputs.length, values, splitMode)') >= 0 &&
    fillBody.indexOf('inputs.length >= 2 && values.length !== inputs.length') >= 0,
    JSON.stringify({ split: typeof split, note: typeof note, body: fillBody.length }));
  if (typeof split !== 'function' || typeof note !== 'function') return;

  // 段数对上才切，是这一族唯一的闸；顺序与候选表本身也要钉住
  var normalFirst = dom.indexOf("text.indexOf('|||')");
  // ⚠️ 锚点必须**紧到只认那张候选表**：本片段里 `var loose` 有三处，
  // 宽松式 `/var loose = \[([^\]]*)\]/` 先撞上第 237 行那个 `var loose = [];`，
  // 于是读出空表、断言当场红 —— 报的是"验证没抓到"，真相是 needle 挑错了行。
  var looseMatch = dom.match(/var loose = \[((?:\s*'[^']*'\s*,?)+)\]/);
  var looseAt = looseMatch ? dom.indexOf(looseMatch[0]) : -1;
  var candidates = looseMatch
    ? (looseMatch[1].match(/'([^']*)'/g) || []).map(function (s2) { return s2.slice(1, -1); })
    : null;
  check('② 约定分隔符 `|||` 那把尺排在候选表之前，且候选表没有单字符分隔符（顺序反了 `甲///乙|||丙` 会先撞上 `///` 只切两段；单枚 `/` 会让 `2024/07` 被切开）',
    normalFirst >= 0 && looseAt > normalFirst &&
    !!candidates && candidates.length === 3 &&
    candidates.every(function (c) { return c.length >= 2; }) &&
    candidates.indexOf('/') < 0 && candidates.indexOf('|') < 0 && candidates.indexOf('｜') < 0 &&
    candidates.indexOf('、') < 0 && candidates.indexOf('；') < 0,
    JSON.stringify({ normalFirst: normalFirst, looseAt: looseAt, candidates: candidates }));

  var s = function (raw, boxes) { return split(raw, boxes); };
  var shapes = [
    { in: '历史|||人民', boxes: 2, parts: ['历史', '人民'], mode: 'normal' },
    { in: '甲 ||| 乙 ||| 丙 ||| 丁', boxes: 4, parts: ['甲', '乙', '丙', '丁'], mode: 'normal' },
    { in: '1|||1|||1|||1', boxes: 4, parts: ['1', '1', '1', '1'], mode: 'normal' },
    { in: 'A///B///C///D', boxes: 4, parts: ['A', 'B', 'C', 'D'], mode: 'loose:///' },
    { in: 'A//B//C//D', boxes: 4, parts: ['A', 'B', 'C', 'D'], mode: 'loose://' },
    { in: '甲｜｜｜乙｜｜｜丙｜｜｜丁', boxes: 4, parts: ['甲', '乙', '丙', '丁'], mode: 'loose:｜｜｜' }
  ];
  var okShapes = shapes.every(function (c) {
    var r = s(c.in, c.boxes);
    return r.mode === c.mode && JSON.stringify(r.parts) === JSON.stringify(c.parts);
  });
  check('③ 段数正好等于答题框数的四种分隔符（`|||` 含带空格、`///`、`//`、全角 `｜｜｜`）都按空切开，mode 点名是哪一种',
    okShapes,
    JSON.stringify(shapes.map(function (c) { var r = s(c.in, c.boxes); return { in: c.in, got: r.parts, mode: r.mode }; })));

  var mixed = s('甲///乙|||丙', 2);
  check('④ 两种分隔符混在一串里时按约定的那把尺切（`|||` 优先，不被 `///` 抢先判成「段数对不上」）',
    mixed.mode === 'normal' && JSON.stringify(mixed.parts) === JSON.stringify(['甲///乙', '丙']),
    JSON.stringify(mixed));

  var off3 = s('A///B///C', 4);
  var offSlash = s('A//B', 4);
  check('⑤ 认出了非常规分隔符但段数对不上：整串原样交回，mode 单独是 `loose-count-off:<分隔符>`（这一格就是日志里那句"是哪一种"的真源）',
    off3.mode === 'loose-count-off:///' && JSON.stringify(off3.parts) === JSON.stringify(['A///B///C']) &&
    offSlash.mode === 'loose-count-off://' && JSON.stringify(offSlash.parts) === JSON.stringify(['A//B']),
    JSON.stringify({ three: off3, two: offSlash }));

  var verbatimIn = ['2024/07', '3/4', '甲、乙、丙、丁', 'A/B/C/D'];
  var verbatimOut = verbatimIn.map(function (raw) { return s(raw, 4); });
  var verbatim = verbatimOut.every(function (r, i) {
    return r.mode === 'none' && r.parts.length === 1 && r.parts[0] === verbatimIn[i];
  });
  check('⑥ 答案内部的单枚 `/` 与顿号压根不是分隔符：`2024/07`、`3/4`、`甲、乙、丙、丁` 一律整串（mode `none`），不许切出四段',
    verbatim,
    JSON.stringify(verbatimOut));

  var oneBox = s('甲///乙', 1);
  var empty = s('', 3);
  check('⑦ 只有一个答题框的题不许被切开（单空的答案本来就常带斜杠）；空答案是 `empty` 那一格，与「读不出」分开',
    oneBox.mode === 'none' && JSON.stringify(oneBox.parts) === JSON.stringify(['甲///乙']) &&
    empty.mode === 'empty' && empty.parts.length === 1 && empty.parts[0] === '',
    JSON.stringify({ oneBox: oneBox, empty: empty }));

  // 日志那一侧：三种成因各说各话 + 同一形状只说一次
  var ctx = { _getQuestionIdFromElement: function () { return '9401'; } };
  logs.length = 0;
  note.call(ctx, {}, 4, ['甲///乙///丙'], 'loose-count-off:///');
  note.call(ctx, {}, 4, ['甲///乙///丙'], 'loose-count-off:///');
  var oncePerKey = logs.length;
  note.call(ctx, {}, 3, ['甲///乙///丙'], 'loose-count-off:///');
  note.call(ctx, {}, 4, ['甲'], 'none');
  var lastTwo = logs.slice(1);
  check('⑧「拆不出来」按「题号 + 框数 + 段数 + 分隔符」记账：同一形状第二轮复读一条都不许出，换个形状才算新事（200 条环被同一句话吃满是真事）',
    oncePerKey === 1 && logs.length === 3,
    JSON.stringify({ afterTwice: oncePerKey, total: logs.length }));
  // ⚠️ 三格都先 `logs[i] &&` 再读 `.meta`：直接 `lastTwo[1].meta` 在生产被改坏、日志少一条时
  //    会抛 TypeError 把整套件打死在半路（批次 137 注入 I 实测撞上），报出来的是"没跑到"而不是红 ——
  //    测试台把"生产坏了"实现成崩溃，等于替生产删掉了一条断言。
  var firstLog = logs[0] && logs[0].meta;
  var repeatLog = lastTwo[0] && lastTwo[0].meta;
  var shapeLog = lastTwo[1] && lastTwo[1].meta;
  check('⑨ 日志那一格把话说全：warn 级、名字固定、`separator`/`boxes`/`parts` 三样齐，且「只有一串」与「段数不对」是两句不同的 hint（压成一句下次还得重查）',
    !!logs[0] && logs[0].level === 'warn' && logs[0].message === 'fill answers not splittable per blank' &&
      !!firstLog && firstLog.separator === 'loose-count-off:///' && firstLog.boxes === 4 && firstLog.parts === 1 &&
      String(firstLog.hint).indexOf('每一格') >= 0 &&
      !!repeatLog && repeatLog.parts === 1 && String(repeatLog.hint).indexOf('每一格') >= 0 &&
      !!shapeLog && shapeLog.boxes === 4 && shapeLog.parts === 1,
    JSON.stringify(logs));

  logs.length = 0;
  note.call(ctx, {}, 3, ['甲', '乙'], 'normal');
  note.call(ctx, {}, 2, ['', '  '], 'normal');
  var twoParts = logs[0] && logs[0].meta;
  var blank = logs[1] && logs[1].meta;
  check('⑩ 段数比框数少（`|||` 只给两段、三格）走的是另一句 hint「多出来的格子重复最后一格」，且全空答案要单独标 `emptyAnswer:true`',
    !!twoParts && twoParts.hint.indexOf('重复最后一格') >= 0 && twoParts.emptyAnswer === false &&
      !!blank && blank.emptyAnswer === true,
    JSON.stringify({ two: twoParts, blank: blank }));

  logs.length = 0;
  var badCtx = { _getQuestionIdFromElement: function () { throw new Error('没有 qid'); } };
  var threw = null;
  try { note.call(badCtx, {}, 4, ['甲'], 'none'); } catch (e) { threw = String(e && e.message); }
  check('⑪ 题号拿不到（读 DOM 抛了）不许把这一发变成异常 —— 日志照打、那一格叫 `anon`；回填路径上任何一处抛错都会把这一题悄悄丢掉',
    threw === null && logs.length === 1 && logs[0].meta.qid === '' &&
      String(logs[0].message) === 'fill answers not splittable per blank',
    JSON.stringify({ threw: threw, logs: logs }));

  check('⑫ 批次 16 的「不留白」口径没被这次改动带走：段数对不上时仍是**重复最后一格**而不是留空，隐藏域也仍是 `values.join(\'\')`',
    fillBody.indexOf('values[values.length - 1]') >= 0 && fillBody.indexOf("hidden.value = values.join('')") >= 0,
    JSON.stringify({ repeat: fillBody.indexOf('values[values.length - 1]'), join: fillBody.indexOf("hidden.value = values.join('')") }));
}

/** ---- [30] 会话任务 #185：「看到 90% 就进下一个」被「直接拖到结尾」单向绑定，且不再无声 —— */
/**
 * 为什么这一段要从盘上把方法取出来真跑：这一族**不报错、不留日志**，只是永远走不到 ——
 * 「90% 提前收尾」的证据（拖到结尾两次被弹回）只有 `_trySeekToEnd` 会写，而它第一道闸就是
 * `enableSeek`。关上上面那枚，下面那枚就成了死键，而界面一个字都不提（用户原话：
 * 「那不就是死键了？」）。这种"声明覆盖的范围与实际走的分支之间的差"不会自己喊出来
 *（AGENTS §2 #18 / §5），只能把方法摆到形状面前判。
 *
 * ⚠️ ① 那条是闸门：拿不出方法时后面每一格都会"红 0 条"而不是"没执行"（AGENTS §5）。
 */
async function testNinetyAdvanceBoundToSeek() {
  console.log('\n[30] 90% 提前收尾：单向绑上「直接拖到结尾」，被放弃时点名说一次（会话任务 #185）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var media = read('src/page/40-media.js');
  var tasks = read('src/page/62-tasks-run.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) return { start: -1, end: -1 };
    var start = src.indexOf('function', at);
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };

  var getKey = buildFrom(media, '_getMediaSeekKey', {});
  // 会话任务 #231 第 1 档：钥匙经兄弟方法归一，假 app 少挂这一件就是 TypeError（AGENTS §5「没跑到」同族）
  var stablePath = buildFrom(media, '_mediaStablePath', {});
  var rateLocked = buildFrom(media, '_isRateLockedAtOne', {});
  var isNinety = buildFrom(media, '_isNinetyPercentVideo', {});
  var noteSkip = buildFrom(media, '_noteSeekSkip', { emitRuntimeLog: say });
  var seekCovers = buildFrom(media, '_seekableCovers', {});
  var deferSeek = buildFrom(media, '_deferSeekUntilSeekable', { emitRuntimeLog: say });
  var trySeek = buildFrom(media, '_trySeekToEnd', { emitRuntimeLog: say });
  var qTtlR = readProductConstant(read('src/page/00-shell-constants.js'), 'TASK_GIVEUP_TTL_MS');
  var quarantine = buildFrom(media, '_isMediaQuarantined', { TASK_GIVEUP_TTL_MS: qTtlR });
  var noteHeld = buildFrom(media, '_noteNinetyHeldBack', { emitRuntimeLog: say });
  var shouldAdvance = buildFrom(media, '_shouldAdvanceAtNinetyPercent', { emitRuntimeLog: say });
  // 站点标语那一族（会话任务 #193）：这一段的 app 必须把它们挂上 —— 少了任何一件，
  // `shouldAdvance` 里那一下调用就是 TypeError，而**整个方法体套在 try/catch 里**，
  // 于是返回 false、一句日志都不出：症状与"生产把这句话删了"一模一样（AGENTS §5「断言绿有两种」）
  var condNoDrag = buildFrom(media, '_siteConditionNoDrag', {});
  var readCond = buildFrom(media, '_readSiteSeekCondition', {});
  var siteCond = buildFrom(media, '_siteSeekCondition', { emitRuntimeLog: say });
  var siteNoDrag = buildFrom(media, '_siteSaysNoDrag', {});
  // #231 第 3b 档：`_noteSeekSkip`／`_trySeekToEnd`／`_siteSeekCondition`／`_noteNinetyHeldBack` 现在都调
  // `this._evictOldestKeys` —— 这一段的 `seekApp` 与 `mkGateApp` 少挂这一件就是 TypeError（§5「没跑到」同族）。
  var evictR = buildFrom(media, '_evictOldestKeys', {});
  // 批次 173 / #199：`_shouldAdvanceAtNinetyPercent` 绑的那一句从「只问站点卡片原话」扩成
  //   **再问一句课程格**（同一门课里已经认出来过一次），而日志里的 `dragSource` 换成三源合成的
  //   `_seekNoDragSource`（弹回过 / 卡片原话 / 同一门课认过一次）—— 三条都不许在日志里塌成一格（§2 #12）。
  //   ⚠️ 绑定那一格**故意不含 `reverted`**：那份账只有 `_trySeekToEnd` 会写，而它第一行就被 `enableSeek`
  //     挡下 —— 用户中途关掉就该立刻失效，不许继续吃上一轮翻开关留下的旧证据（#185 的"单向"那半截，⑤ 钉的就是它）。
  //   这一族整套挂在 try/catch 里，少挂一件就是 TypeError → 返回 false → 与"生产删了这句话"同形（AGENTS §5）。
  var gNeedR = Number((media.match(/_COURSE_GUARD_NEED:\s*(\d+)/) || [])[1] || 0);
  var gTtlR = Number((media.match(/_COURSE_GUARD_TTL_MS:\s*(\d+)/) || [])[1] || 0);
  var gKeyR = (media.match(/_COURSE_GUARD_KEY:\s*'([^']+)'/) || [])[1] || '';
  var gId = buildFrom(media, '_courseGuardId', {});
  var gCell = buildFrom(media, '_courseGuardCell', { emitRuntimeLog: say });
  var gPersist = buildFrom(media, '_persistCourseGuard', { emitRuntimeLog: say });
  var gHit = buildFrom(media, '_courseGuardHit', { emitRuntimeLog: say });
  var gNote = buildFrom(media, '_noteCourseGuard', { emitRuntimeLog: say });
  var gClear = buildFrom(media, '_clearCourseGuard', { emitRuntimeLog: say });
  var gSay = buildFrom(media, '_sayCourseGuard', { emitRuntimeLog: say });
  var gSkip = buildFrom(media, '_noteCourseGuardRateSkipped', { emitRuntimeLog: say });
  var gSource = buildFrom(media, '_seekNoDragSource', {});
  // 门课号要给：认不出课的那一格会**单独说一句 warn**（㉕ 钉的就是它），留空会把这一段的
  // `logs.length` 类断言顶成"多出一条与本轮无关的话"。每枚 app 各带一本自己的存储。
  var guardKit = function () {
    return {
      _COURSE_GUARD_NEED: gNeedR, _COURSE_GUARD_TTL_MS: gTtlR, _COURSE_GUARD_KEY: gKeyR,
      _courseGuard: null, _guardStore: Object.create(null),
      _readSessionLedger: function (k) { var v = this._guardStore[String(k || '')]; return v ? JSON.parse(v) : null; },
      _writeSessionLedger: function (k, v) { this._guardStore[String(k || '')] = JSON.stringify(v); },
      _currentStudyParams: function () { return { courseid: 'COURSE_30', clazzid: 'CLASS_30' }; },
      _courseGuardId: gId, _courseGuardCell: gCell, _persistCourseGuard: gPersist,
      _courseGuardHit: gHit, _noteCourseGuard: gNote, _clearCourseGuard: gClear,
      _sayCourseGuard: gSay, _noteCourseGuardRateSkipped: gSkip, _seekNoDragSource: gSource
    };
  };
  var isFinished = buildFrom(tasks, '_isDocumentFrameFinished', {
    textOf: function (el) { return String((el && el.textContent) || ''); }
  });

  var gateBody = bodyOf(media, '_shouldAdvanceAtNinetyPercent');
  var heldBody = bodyOf(media, '_noteNinetyHeldBack');
  var seekBody = bodyOf(media, '_trySeekToEnd');

  var allFnsMedia = [getKey, stablePath, rateLocked, isNinety, noteSkip, seekCovers, deferSeek, trySeek, quarantine, noteHeld,
    shouldAdvance, isFinished, condNoDrag, readCond, siteCond, siteNoDrag,
    gId, gCell, gPersist, gHit, gNote, gClear, gSay, gSkip, gSource];
  check('① 廿五件（原十四件 + 批次 173 的课程格九件 + 隔离谓词一件 + 钥匙归一一件，其中 `_seekNoDragSource` 是日志里点名归因的那一句）'
    + '都能从盘上原样取出来真跑，绑定那一格也确实写进 `_shouldAdvanceAtNinetyPercent`，'
    + '而且绑的是**两半**：`enableSeek` 关上时还要再问一句「有没有**不必动手拖**的证据」（站点卡片原话 / 同一门课认过一次）'
    + '（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    allFnsMedia.every(function (f) { return typeof f === 'function'; }) && qTtlR > 0 &&
      gNeedR > 0 && gTtlR > 0 && gKeyR.length > 0 &&
      gateBody.indexOf("if (!this.configs.enableSeek && !this._siteSaysNoDrag(video) && !this._courseGuardHit('seek'))") >= 0 &&
      gateBody.indexOf('this._noteNinetyHeldBack(video)') >= 0,
    JSON.stringify({
      key: typeof getKey, stable: typeof stablePath, rate: typeof rateLocked, ninety: typeof isNinety, skip: typeof noteSkip,
      covers: typeof seekCovers, defer: typeof deferSeek,
      seek: typeof trySeek, held: typeof noteHeld, gate: typeof shouldAdvance, fin: typeof isFinished,
      cond: [typeof condNoDrag, typeof readCond, typeof siteCond, typeof siteNoDrag].join('/'),
      guard: [typeof gId, typeof gCell, typeof gPersist, typeof gHit, typeof gNote,
        typeof gClear, typeof gSay, typeof gSkip, typeof gSource].join('/'),
      gateBody: gateBody.length, heldBody: heldBody.length
    }));
  if (!allFnsMedia.every(function (f) { return typeof f === 'function'; })) return;

  // ---- 死键的成因先钉住：那份证据只有一个写入口，而写入口第一道闸就是 enableSeek ----
  // ⚠️ 按**字符偏移**判"这处赋值在不在 _trySeekToEnd 体内"，别按行算（AGENTS §2 #1 那条同一族：
  //    按行算会在同行闭合的形状上出错）。剥注释也不需要 —— 这里要的是赋值，注释里没有 `=`。
  var writes = [];
  var wRe = /_seekRevertedKeys\s*(\[[^\]]*\])?\s*=\s*[^=]/g;
  var wm;
  while ((wm = wRe.exec(media)) !== null) writes.push(wm.index);
  var seekBounds = boundsOf(media, '_trySeekToEnd');
  var allInside = writes.length > 0 && writes.every(function (at) {
    return at >= seekBounds.start && at < seekBounds.end;
  });
  var enableGateAt = seekBody.indexOf('this.configs.enableSeek');
  var firstWriteRel = seekBody.indexOf('_seekRevertedKeys');
  check('②「拖到结尾两次被弹回」这份证据**只有一个写入口**（`_trySeekToEnd`），而它第一道闸就是 `enableSeek`，且闸排在任何写入之前 —— 关上那枚就永远拿不到证据，这就是死键的成因',
    allInside && enableGateAt >= 0 && firstWriteRel > enableGateAt,
    JSON.stringify({ writes: writes.length, allInside: allInside, gateAt: enableGateAt, firstWrite: firstWriteRel }));

  // ---- 同一个成因的行为侧：关上那枚时，_trySeekToEnd 连账本都不新建，只把「为什么没试」记一笔 ----
  var mkSeekVideo = function (src) {
    var rec = { writes: [], cur: 20 };
    var v = {
      tagName: 'VIDEO', isConnected: true, duration: 1401.4,
      currentSrc: 'https://ananas.chaoxing.com/video/' + src + '.mp4', __rec: rec
    };
    Object.defineProperty(v, 'currentTime', {
      get: function () { return rec.cur; },
      set: function (n) { rec.writes.push(n); }
    });
    v.seekable = { length: 1, start: function () { return 0; }, end: function () { return 1401.4; } };
    return v;
  };
  var seekApp = {
    configs: { enableSeek: false, advanceAtNinetyPercent: true },
    _rateProbing: false, _captchaActive: false, _activeJobId: '',
    _mediaQuarantine: new WeakMap(), _mediaReloadKeys: Object.create(null),
    _isMediaQuarantined: quarantine,
    _workerDelay: function () {}, _isRateLockedAtOne: function () { return true; },
    _getMediaSeekKey: getKey, _mediaStablePath: stablePath, _noteSeekSkip: noteSkip, _evictOldestKeys: evictR,
    // ⚠️ 区间闸那两件也必须挂上来 —— 反向验证 G 轮把 `enableSeek` 那道闸改成"记一笔不退回"，
    //    执行流就走到 `_deferSeekUntilSeekable`， harness 里没有它 → TypeError 把整套件打死在半路，
    //    报出来的是"集成层没交出总账"而不是 ③ 红。**测试台把"生产坏了"实现成崩溃，等于替生产删掉一条断言。**
    //    挂真方法而不是桩：桩要打在"那个会把页面带走的动作"上，而这里 return false 是个**决定**，
    //    写了它就不测区间那一格了（AGENTS §5「桩要打在动作上」）。夹具的 `seekable` 恒含整支，
    //    所以干净树上它照旧 return false、③ 的行为一个字没变。
    _seekableCovers: seekCovers, _deferSeekUntilSeekable: deferSeek,
    _trySeekToEnd: trySeek
  };
  var sv = mkSeekVideo('deadkey');
  var svKey = seekApp._getMediaSeekKey(sv);
  var seekRet = trySeek.call(seekApp, sv, 'itest-185');
  var skipRec = seekApp._seekSkipLedger && seekApp._seekSkipLedger[svKey];
  check('③ `enableSeek:false` 时 `_trySeekToEnd` 当场退回：不写 currentTime、不新建 `_seekRevertedKeys`，只把「disabled」记进 skip 账（这一族以前在盘上是零证据）',
    seekRet === false && sv.__rec.writes.length === 0 && !seekApp._seekRevertedKeys &&
      !!skipRec && skipRec.last === 'disabled' && skipRec.n === 1,
    JSON.stringify({ ret: seekRet, writes: sv.__rec.writes.length, reverted: !!seekApp._seekRevertedKeys, skip: skipRec }));

  // ---- 判据矩阵的夹具：一支"除了拖拽证据，其余全都成立"的视频 ----
  var mkDoc = function (marker) {
    return {
      querySelector: function () { return marker ? { className: 'ans-job-finished' } : null; },
      defaultView: null
    };
  };
  var mkMedia = function (opt) {
    opt = opt || {};
    var v = {
      tagName: opt.tagName || 'VIDEO',
      duration: opt.duration == null ? 100 : opt.duration,
      currentSrc: 'https://ananas.chaoxing.com/video/' + (opt.src || 'a1') + '.mp4',
      ownerDocument: mkDoc(opt.marker !== false)
    };
    Object.defineProperty(v, 'currentTime', { get: function () { return opt.current == null ? 90 : opt.current; } });
    return v;
  };
  function mkGateApp(cfg) {
    return Object.assign({
      configs: cfg,
      _detectedMaxRate: 1,
      _seekRevertedKeys: Object.create(null),
      _ninetyHeldBackKeys: null,
      _activeJobId: 'job-910000001',
      _getMediaSeekKey: getKey,
      _mediaStablePath: stablePath,
      _evictOldestKeys: evictR,
      _isRateLockedAtOne: rateLocked,
      _isNinetyPercentVideo: isNinety,
      _noteNinetyHeldBack: noteHeld,
      _isDocumentFrameFinished: isFinished,
      _siteConditionNoDrag: condNoDrag,
      _readSiteSeekCondition: readCond,
      _siteSeekCondition: siteCond,
      _siteSaysNoDrag: siteNoDrag,
      _shouldAdvanceAtNinetyPercent: shouldAdvance
    }, guardKit());
  }
  var ON = { enableSeek: true, advanceAtNinetyPercent: true };
  var OFF = { enableSeek: false, advanceAtNinetyPercent: true };
  var heldCount = function () {
    return logs.filter(function (l) { return l.message === 'advance at 90% held back: seek disabled'; }).length;
  };

  // 旧行为那一支：证据齐了就提前收尾，而且一句"被放弃"都不许说
  var appOn = mkGateApp(ON);
  var vOn = mkMedia({ src: 'bound-on' });
  appOn._seekRevertedKeys[appOn._getMediaSeekKey(vOn)] = true;
  logs.length = 0;
  var retOn = shouldAdvance.call(appOn, vOn);
  check('④ `enableSeek:true` + 弹回过 + 锁 1x + 到 90% + 平台已标记，照旧提前收尾，且**一句"被放弃"都不多说**（绑定不许把顺利那一条拖下水；成功那句 `advance at 90%` 照旧在）',
    retOn === true && heldCount() === 0 &&
      logs.some(function (l) { return l.message === 'advance at 90% (locked 1x + not seekable)'; }),
    JSON.stringify({ ret: retOn, msgs: logs.map(function (l) { return l.message; }) }));

  // 新的那一格：证据被人硬塞进账本，但上面那枚是关的 → 不提前收尾
  var appOff = mkGateApp(OFF);
  var vOff = mkMedia({ src: 'bound-off' });
  appOff._seekRevertedKeys[appOff._getMediaSeekKey(vOff)] = true;  // 上一拍开着时留下的旧证据
  logs.length = 0;
  var retOff = shouldAdvance.call(appOff, vOff);
  check('⑤ 单向绑定的正半截：`enableSeek` 关上后**即使账本里躺着旧的弹回证据也不提前收尾**（用户中途关掉就该立刻失效，而不是继续吃上一轮的结论）',
    retOff === false,
    JSON.stringify({ ret: retOff, reverted: appOff._seekRevertedKeys[appOff._getMediaSeekKey(vOff)] }));

  // 被放弃要说一次，而且要指名道姓
  var heldLogs = logs.filter(function (l) { return l.message === 'advance at 90% held back: seek disabled'; });
  var heldMeta = heldLogs[0] && heldLogs[0].meta;
  check('⑥ 负半截：这一发**不是原地什么都不说**（AGENTS §2 #14），日志点名是被谁挡的、级别 info、带 `ratio`/`duration`/`jobid` 三格读数',
    heldLogs.length === 1 && heldLogs[0].level === 'info' &&
      !!heldMeta && Math.abs(heldMeta.ratio - 0.9) < 1e-6 && heldMeta.duration === 100 &&
      heldMeta.jobid === 'job-910000001',
    JSON.stringify({ count: heldLogs.length, meta: heldMeta }));

  // 同一支重复问只许说一次，换一支才算新事
  shouldAdvance.call(appOff, vOff);
  shouldAdvance.call(appOff, vOff);
  var afterRepeat = logs.length;
  var vOff2 = mkMedia({ src: 'bound-off-2' });
  shouldAdvance.call(appOff, vOff2);
  var heldKeysOff = appOff._ninetyHeldBackKeys ? Object.keys(appOff._ninetyHeldBackKeys).length : 'none';
  check('⑦ 同一支媒体重复巡检只说一次（每 1500 毫秒就来一拍，说个不停会把 200 条证据窗吃光，AGENTS §2 #16(b)）；换一支才算新事',
    afterRepeat === 1 && logs.length === 2 && heldKeysOff === 2,
    JSON.stringify({ afterRepeat: afterRepeat, total: logs.length, keys: heldKeysOff }));

  // 三格"其实没放弃捷径"的形状一句都不许说
  logs.length = 0;
  var appQuiet = mkGateApp(OFF);
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-half', current: 50 }));      // 还没到 90%
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-tail', current: 99.9 }));    // 让给 ended 那条路
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-nomark', marker: false }));  // 平台没认可
  appQuiet._detectedMaxRate = 2;
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-fast' }));                   // 倍速能加速
  appQuiet._detectedMaxRate = 0;
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-unknown' }));                // 探测没结果，宁可多播
  var quietCount = logs.length;
  logs.length = 0;
  appQuiet._detectedMaxRate = 1;
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-audio', tagName: 'AUDIO' }));
  var audioUntouched = logs.length;   // AUDIO 也适用（不是只放宽给视频）
  logs.length = 0;
  shouldAdvance.call(appQuiet, mkMedia({ src: 'q-embed', tagName: 'EMBED' }));
  var nonMedia = logs.length;         // 不是音视频的那一枚根本不配说话
  check('⑧ 只有"真被放弃了一趟捷径"才说话：不到 90%、接近结尾、平台没标记、倍速能加速、探测没结果这五格各问一遍，**一条都不许出**（放宽成"关上就每拍抱怨"是一次新的日志洪水）；同一格换成音频照旧要说（音频本来也适用），换成非音视频的元素又不说',
    quietCount === 0 && audioUntouched === 1 && nonMedia === 0,
    JSON.stringify({ quiet: quietCount, audio: audioUntouched, nonMedia: nonMedia }));

  // 用户自己关了下面那枚时，不许再劝
  logs.length = 0;
  var appSelfOff = mkGateApp({ enableSeek: false, advanceAtNinetyPercent: false });
  var retSelfOff = shouldAdvance.call(appSelfOff, mkMedia({ src: 'self-off' }));
  check('⑨ 是用户自己关掉「90% 提前收尾」时，绑定那一格**一句都不说**（第一道闸就退回，不拿"你上面那枚没开"去劝一个已经不要这一枚的人）',
    retSelfOff === false && logs.length === 0 && Object.keys(appSelfOff._ninetyHeldBackKeys || {}).length === 0,
    JSON.stringify({ ret: retSelfOff, logs: logs.length, keys: Object.keys(appSelfOff._ninetyHeldBackKeys || {}).length }));

  // 只读不写：不许为了凑齐条件替用户改存储
  // ⚠️ 尺必须分得开"赋值"和"比较" —— 第一版拿 `indexOf('configs.X =')` 当赋值，
  //    结果把 1192 行那句 `configs.advanceAtNinetyPercent === false` 读成赋值，当场红。
  //    所以这里要补两格对照：真的赋值必须逮住，三种比较形状一律不许误报。
  var assignRe = function (body, key) {
    var re = new RegExp('configs\\.' + key + '\\s*=[^=]', 'g');
    var hits = 0;
    while (re.exec(body) !== null) hits++;
    return hits;
  };
  var probes = [
    { make: function (k) { return 'this.configs.' + k + ' = false;'; }, want: 1 },
    { make: function (k) { return 'this.configs.' + k + '=true;'; }, want: 1 },
    { make: function (k) { return 'if (this.configs.' + k + ' === false) return false;'; }, want: 0 },
    { make: function (k) { return 'if (this.configs.' + k + ' == null) {}'; }, want: 0 },
    { make: function (k) { return 'if (this.configs.' + k + ' != 1) {}'; }, want: 0 },
    { make: function (k) { return 'if (this.configs.' + k + ' >= 1) {}'; }, want: 0 }
  ];
  var probeKeys = ['enableSeek', 'advanceAtNinetyPercent'];
  var probesOk = probes.every(function (p) {
    return probeKeys.every(function (k) { return assignRe(p.make(k), k) === p.want; });
  });
  var gateHits = assignRe(gateBody, 'enableSeek') + assignRe(gateBody, 'advanceAtNinetyPercent');
  var heldHits = assignRe(heldBody, 'enableSeek') + assignRe(heldBody, 'advanceAtNinetyPercent');
  check('⑩ 绑定只改判定、**绝不改写用户存的那个值**：两段方法体里都不许出现对 `configs.enableSeek` / `configs.advanceAtNinetyPercent` 的赋值（替他翻开关=把选择悄悄换掉）；'
    + '且这把尺自己先过一遍对照 —— 两种真赋值逮得住，`===` / `==` / `!=` / `>=` 四种比较一律不误报',
    probes && gateHits === 0 && heldHits === 0 && gateBody.indexOf('configs.enableSeek') >= 0,
    JSON.stringify({ probesOk: probes, gateHits: gateHits, heldHits: heldHits, readsSeek: gateBody.indexOf('configs.enableSeek') >= 0 }));

  // ==== 绑定的另一半证据：站点自己写的那句完成条件（会话任务 #193）====
  // 现场形状（只读探针，2026-11-20）：`<video>` 在第 2 层文档，标语 `span.task-condition-text`
  // 写在**它上一层**的卡片文档里，卡片那一层放着承载播放器的那枚 iframe ——
  // `contains()` 不跨文档，所以卡片对的是**那枚 iframe**，不是 video。夹具照这个形状造。
  var BANNER_NO = '观看时长需 ≥ 总时长的 90% (未完成任务点前, 当前视频不可拖拽、观看时不可离开或将页面最小化)';
  var BANNER_FREE = '观看时长需 ≥ 总时长的 95% (未完成任务点前, 观看时不可离开或将页面最小化)';
  function mkBannerMedia(opt) {
    opt = opt || {};
    var card = { contains: function (n) { return !!n && n.__inCard === true; } };
    var spans = (opt.texts || []).map(function (t) {
      return { textContent: t, closest: function () { return card; } };
    });
    var topDoc = { querySelectorAll: function () { return []; }, defaultView: null };
    var frameToCards = { ownerDocument: topDoc };            // 卡片文档在顶层里那枚 iframe
    var cardsDoc = {
      querySelectorAll: function (sel) { return sel === '.task-condition-text' ? spans : []; },
      defaultView: { frameElement: frameToCards }
    };
    var frameToPlayer = { ownerDocument: cardsDoc, __inCard: true };  // 卡片里承载播放器那枚
    var playerDoc = {
      querySelector: function (sel) {
        return opt.marker === false || sel.indexOf('ans-job-finished') < 0 ? null : { className: 'ans-job-finished' };
      },
      querySelectorAll: function () { return []; },
      defaultView: { frameElement: frameToPlayer }
    };
    var v = {
      tagName: 'VIDEO', duration: 100,
      currentSrc: 'https://ananas.chaoxing.com/video/' + (opt.src || 'banner') + '.mp4',
      ownerDocument: playerDoc
    };
    Object.defineProperty(v, 'currentTime', { get: function () { return 90; } });
    return v;
  }
  var bannerMsgs = function () {
    return logs.filter(function (l) { return l.message === 'site condition says not draggable, skip seek to end'; });
  };

  // ⑪ 用户要的那一条：站点自己写了「不可拖拽」，就不必先动手拖一次才拿到证据
  logs.length = 0;
  var appBan = mkGateApp(OFF);
  var vBan = mkBannerMedia({ src: 'ban-forbid', texts: [BANNER_NO] });
  var retBan = shouldAdvance.call(appBan, vBan);
  var banMeta = bannerMsgs()[0] && bannerMsgs()[0].meta;
  check('⑪ `enableSeek` 关上 + 站点在卡片上写了「当前视频不可拖拽」→ 90% 提前收尾**照旧生效**，'
    + '而且 `_seekRevertedKeys` 一个字没写（一次都没动手拖，风险为零）、一句「被放弃」都不出、'
    + '那句证据只说一次并**照抄站点原话**（带 `condition`/`marks`/`hop`）',
    retBan === true && heldCount() === 0 && bannerMsgs().length === 1 &&
      Object.keys(appBan._seekRevertedKeys).length === 0 &&
      logs.some(function (l) { return l.message === 'advance at 90% (locked 1x + not seekable)'; }) &&
      !!banMeta && banMeta.condition.indexOf('不可拖拽') >= 0 && banMeta.marks === 1 && banMeta.hop === 1,
    JSON.stringify({ ret: retBan, held: heldCount(), banner: bannerMsgs().length, reverted: Object.keys(appBan._seekRevertedKeys).length, meta: banMeta }));

  // ⑫ 三格「站点没这么说」一律不许当成证据 —— 压进上一格就是替站点宣布它禁止过
  var bailRows = [
    { name: 'silent', texts: [BANNER_FREE] },
    { name: 'absent', texts: [] },
    { name: 'ambiguous', texts: [BANNER_NO, BANNER_FREE] }
  ];
  var bailOut = bailRows.map(function (r) {
    logs.length = 0;
    var app = mkGateApp(OFF);
    var ret = shouldAdvance.call(app, mkBannerMedia({ src: 'bail-' + r.name, texts: r.texts }));
    return { name: r.name, ret: ret, held: heldCount(), banner: bannerMsgs().length };
  });
  check('⑫ 反过来三格各问一遍：标语在场但没那三个字（silent）、爬到顶也没有标语（absent）、'
    + '同屏两枚意见不一致（ambiguous）→ 一律**照旧按住并明说一次「这条路被放弃了」**，'
    + '而且一句「站点说不让拖」都不许说（没证据时替站点宣布禁令，等于把"少动手"实现成"永不试拖"）',
    bailOut.every(function (o) { return o.ret === false && o.held === 1 && o.banner === 0; }),
    JSON.stringify(bailOut));

  // ⑬ 上面那枚开着时，标语只许减少动手、不许多挡一次
  logs.length = 0;
  var appBoth = mkGateApp(ON);
  var retBoth = shouldAdvance.call(appBoth, mkBannerMedia({ src: 'both-forbid', texts: [BANNER_NO] }));
  check('⑬ 两枚都成立时**不许由标语多挡一次**：`enableSeek:true` + 站点写了不可拖拽 → 照旧提前收尾、'
    + '一句「被放弃」都不出（这条兜底本来就在走，标语只是多一条免拖的理由）',
    retBoth === true && heldCount() === 0 &&
      logs.some(function (l) { return l.message === 'advance at 90% (locked 1x + not seekable)'; }),
    JSON.stringify({ ret: retBoth, held: heldCount(), msgs: logs.map(function (l) { return l.message; }) }));

  // ⑭ 现场那枚「老形状」：标语只有一枚、没有卡片容器 —— 单枚时不要求那层容器
  logs.length = 0;
  var appOld = mkGateApp(OFF);
  var vOld = mkBannerMedia({ src: 'old-shape', texts: [BANNER_NO] });
  vOld.ownerDocument.defaultView.frameElement.ownerDocument.querySelectorAll = function () {
    return [{ textContent: BANNER_NO, closest: function () { return null; } }];   // 容器还没长出来
  };
  check('⑭ 卡片晚半拍才渲染（标语在、分界容器 `closest` 认不出来）时，**只有一枚标语就照它说**：'
    + '这一格照样提前收尾（多枚时才要求对得上卡片，否则永远等不到那句证据）',
    shouldAdvance.call(appOld, vOld) === true && heldCount() === 0 && bannerMsgs().length === 1,
    JSON.stringify({ held: heldCount(), banner: bannerMsgs().length }));
}


async function testRateAskBound() {
  console.log('\n[31] 倍速问不到那一格：一支最多受控地问 N 发，到点只说一次、按原速播完（批次 146）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var media = read('src/page/40-media.js');

  // ⚠️ 探测链里 `_detectMaxPlaybackRate` / `_tryRateOnce` / `_waitRateSettle` 声明成 `async function`，
  //   老那句锚点 `name + ': function'` 对它们一个都取不出来 —— 少这一支，下面全部是「没执行」。
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) at = src.indexOf(name + ': async function');
    if (at < 0) return { start: -1, end: -1 };
    var fnAt = src.indexOf('function', at);
    // ⚠️ `async` 必须一起带走：切出来只从 `function` 起，重建出来的就是普通函数，
    //   而 `_detectMaxPlaybackRate` / `_tryRateOnce` 体里有 `await` —— 当场 SyntaxError（实测）
    var start = src.slice(fnAt - 6, fnAt) === 'async ' ? fnAt - 6 : fnAt;
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var bodyOf = function (src, name) {
    var r = boundsOf(src, name);
    return (r.start < 0 || r.end <= r.start) ? '' : src.slice(r.start, r.end);
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  var firstNum = function (src, re) {
    var m = src.match(re);
    return m ? Number(m[1]) : null;
  };

  // 三个预算从源码读回来，别抄成测试里的字面量（改了生产数而断言照旧 = 假绿）
  var askBound = firstNum(bodyOf(media, '_noteRateUnreadable'), /this\._rateUnknownTries < (\d+)/);
  var pausedBound = firstNum(bodyOf(media, '_scheduleMaxRateDetection'), /tries >= (\d+)/);
  var settleMs = firstNum(bodyOf(media, '_tryRateOnce'), /_waitRateSettle\(video, (\d+)\)/);

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: String(message || ''), meta: meta }); };
  var spoke = function (prefix) {
    return logs.filter(function (m) { return m.message.indexOf(prefix) === 0; });
  };

  var ensureFn = buildFrom(media, '_ensurePlaybackRate', { console: { log: function () {} } });
  var targetFn = buildFrom(media, '_getTargetPlaybackRate', {});
  var clampFn = buildFrom(media, '_clampAutoRate', {});
  var resetFn = buildFrom(media, '_resetRateDetection', {});
  var noteFn = buildFrom(media, '_noteRateUnreadable', { emitRuntimeLog: say });
  // 暂停那一族的等待是真 `setInterval`，集成层不能真等 60×500 毫秒 —— 桩到「排了 timer」这一手，
  //   由测试自己把那些拍数**同步**驱动完，于是等待上限、到点那一发记不记账，都读得回来。
  //   ⚠️ 不跑暂停那一支的场景碰不到这两个桩（`if (!video.paused) { runDetect(); return; }` 在前），
  //   所以下面 ①–⑪ 的行为与打桩前逐字相同。
  var pausedTimers = [];
  var fakeSetInterval = function (fn, ms) {
    var id = pausedTimers.length + 1;
    pausedTimers.push({ id: id, fn: fn, ms: ms, cleared: false });
    return id;
  };
  var fakeClearInterval = function (id) {
    for (var z = 0; z < pausedTimers.length; z++) if (pausedTimers[z].id === id) pausedTimers[z].cleared = true;
  };
  var schedFn = buildFrom(media, '_scheduleMaxRateDetection',
    { emitRuntimeLog: say, setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
  var detectFn = buildFrom(media, '_detectMaxPlaybackRate', { emitRuntimeLog: say });
  var tryFn = buildFrom(media, '_tryRateOnce', { emitRuntimeLog: say });
  // `sleep` 换成立即兑现：稳态窗口照样跑满三轮，但不必让集成测试真等 700 毫秒
  var waitFn = buildFrom(media, '_waitRateSettle', { sleep: function () { return Promise.resolve(); } });
  var menuFn = buildFrom(media, '_readRateMenuMax', {
    textOf: function (el) { return String((el && (el.textContent || el.innerText)) || ''); }
  });
  // 批次 173 / #199：问价那一族的**前置**是课程格，八件都要真取出来挂上假 app ——
  // 挂不上就是 `TypeError` 顶掉整段（§5「红 0 条的第一嫌疑人是根本没跑到」，本轮实测撞过）。
  // ⚠️ 课程格那八件的话**另开一本账**（`guardLogs`）：① – ⑫ 数的是 `logs` 里按前缀筛出的句子，
  //   把「认不出是哪门课」那句 warn 混进同一本，会让它们读到本不属于问价那一族的条数。
  var guardLogs = [];
  var sayGuard = function (level, message, meta) { guardLogs.push({ level: level, message: String(message || ''), meta: meta }); };
  var guardIdFn = buildFrom(media, '_courseGuardId', {});
  var guardCellFn = buildFrom(media, '_courseGuardCell', { emitRuntimeLog: sayGuard });
  var guardPersistFn = buildFrom(media, '_persistCourseGuard', { emitRuntimeLog: sayGuard });
  var guardHitFn = buildFrom(media, '_courseGuardHit', { emitRuntimeLog: sayGuard });
  var guardNoteFn = buildFrom(media, '_noteCourseGuard', { emitRuntimeLog: sayGuard });
  var guardClearFn = buildFrom(media, '_clearCourseGuard', { emitRuntimeLog: sayGuard });
  var guardSayFn = buildFrom(media, '_sayCourseGuard', { emitRuntimeLog: sayGuard });
  var guardSkipFn = buildFrom(media, '_noteCourseGuardRateSkipped', { emitRuntimeLog: sayGuard });
  var guardNeedR = firstNum(media, /_COURSE_GUARD_NEED:\s*(\d+)/);
  var guardTtlR = firstNum(media, /_COURSE_GUARD_TTL_MS:\s*(\d+)/);
  var guardKeyR = (media.match(/_COURSE_GUARD_KEY:\s*'([^']+)'/) || [])[1] || '';
  var quarantineTtlR = readProductConstant(read('src/page/00-shell-constants.js'), 'TASK_GIVEUP_TTL_MS');
  var quarantineFn = buildFrom(media, '_isMediaQuarantined', { TASK_GIVEUP_TTL_MS: quarantineTtlR });
  var parts = [ensureFn, targetFn, clampFn, resetFn, noteFn, schedFn, detectFn, tryFn, waitFn, menuFn,
    guardIdFn, guardCellFn, guardPersistFn, guardHitFn, guardNoteFn, guardClearFn, guardSayFn, guardSkipFn, quarantineFn];
  var gotCount = parts.filter(function (f) { return typeof f === 'function'; }).length;

  check('⓪ 十九件本体都能从 `40-media.js` 原样取出来真跑（三件 `async` 的那一支也取得到，课程格那八件与隔离谓词也算在内），'
    + '问不出的预算、暂停那一族的等待上限、写入后的稳态窗口与隔离窗口也从源码读回来'
    + '（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    gotCount === parts.length && askBound > 0 && pausedBound > 0 && settleMs > 0 && quarantineTtlR > 0 &&
    guardNeedR > 0 && guardTtlR > 0 && guardKeyR.length > 0,
    JSON.stringify({ got: gotCount, need: parts.length, ask: askBound, paused: pausedBound, settle: settleMs, quarantineTtl: quarantineTtlR, guardNeed: guardNeedR, guardTtl: guardTtlR, guardKey: guardKeyR }));
  if (!(gotCount === parts.length && askBound > 0 && pausedBound > 0 && settleMs > 0 && quarantineTtlR > 0
    && guardNeedR > 0 && guardTtlR > 0 && guardKeyR.length > 0)) return;

  // 夹具只桩到「播放器接不接这一档」那一层：写入次数就是问了几发，判据读的数来自这里。
  // 站点拒写 = 问不出（`_tryRateOnce` 交回 0）；站点按住某一档 = 量到了，交回非 0。
  // ⚠️ 写入分「探测那一发」与「量到之后落档那一发」两栏记：`_tryRateOnce` 在 `_rateProbing`
  //   为真时写，收尾的守卫在后一拍写。混成一栏，⑦「菜单读得出就不许动手试档」那条就恒红 ——
  //   它要排掉的正是探测那几发，而不是量到之后本来就该落的那一发。
  function mkVideo(opt) {
    opt = opt || {};
    var rec = { writes: [], defWrites: [], probeWrites: 0, probeDefWrites: 0,
      rate: opt.startRate == null ? 1 : opt.startRate, def: 1, probing: function () { return false; } };
    var video = {
      tagName: 'VIDEO',
      paused: opt.paused === true,
      closest: function () { return null; },                       // 没有播放器容器，菜单只能整文档扫
      ownerDocument: { querySelectorAll: function () { return opt.menuCells || []; } }
    };
    Object.defineProperty(video, 'playbackRate', {
      get: function () { return rec.rate; },
      set: function (x) {
        rec.writes.push(Number(x));                                // 每一发「问」都落在这里
        if (rec.probing()) rec.probeWrites++;
        if (opt.deny) throw new Error('player refuses playbackRate');
        rec.rate = opt.held == null ? Number(x) : Number(opt.held);
      }
    });
    Object.defineProperty(video, 'defaultPlaybackRate', {
      get: function () { return rec.def; },
      set: function (x) {
        rec.defWrites.push(Number(x));                             // 只有真去探测才会写这一格
        if (rec.probing()) rec.probeDefWrites++;
        if (!opt.deny) rec.def = Number(x);
      }
    });
    return { video: video, rec: rec };
  }
  function mkApp(cfg) {
    var app = {
      configs: cfg || {}, _detectedMaxRate: 0, _rateDetectVideo: null, _rateUnknownVideo: null,
      _rateUnknownTries: 0, _rateDetectBusy: false, _rateProbing: false, _rateEpoch: 0, _videoEl: null,
      _rateLockedBy: '', _courseGuard: null, _courseGuardStore: Object.create(null),
      _mediaQuarantine: new WeakMap(), _mediaReloadKeys: Object.create(null),
      _COURSE_GUARD_NEED: guardNeedR, _COURSE_GUARD_TTL_MS: guardTtlR, _COURSE_GUARD_KEY: guardKeyR
    };
    // 课程格默认**认不出课**（没有 `_currentStudyParams`）⇒ `_courseGuardHit` 恒 false，
    // 于是 ① – ⑫ 走的与批次 173 之前逐字相同；只有 ⑬ 自己把课号装上。
    // 存储桩按 app 各一份（同一轮多个 app 不许共用一本账，否则前一个的课格会毒化后一个）
    app._readSessionLedger = function (key) {
      var v = app._courseGuardStore[String(key || '')];
      return (v && typeof v === 'object') ? v : null;
    };
    app._writeSessionLedger = function (key, value) { app._courseGuardStore[String(key || '')] = value; };
    app._courseGuardId = function () { return guardIdFn.call(app); };
    app._courseGuardCell = function (id) { return guardCellFn.call(app, id); };
    app._persistCourseGuard = function (id) { return guardPersistFn.call(app, id); };
    app._courseGuardHit = function (which) { return guardHitFn.call(app, which); };
    app._noteCourseGuard = function (which, src) { return guardNoteFn.call(app, which, src); };
    app._clearCourseGuard = function (which, src) { return guardClearFn.call(app, which, src); };
    app._sayCourseGuard = function (which, id, rec, src) { return guardSayFn.call(app, which, id, rec, src); };
    app._noteCourseGuardRateSkipped = function () { return guardSkipFn.call(app); };
    app._isMediaQuarantined = function (v) { return quarantineFn.call(app, v); };
    app._getMediaSeekKey = function () { return ''; };
    app._ensurePlaybackRate = function (v, r) { return ensureFn.call(app, v, r); };
    app._getTargetPlaybackRate = function () { return targetFn.call(app); };
    app._clampAutoRate = function (r) { return clampFn.call(app, r); };
    app._resetRateDetection = function () { return resetFn.call(app); };
    app._noteRateUnreadable = function (v) { return noteFn.call(app, v); };
    app._scheduleMaxRateDetection = function (v) { return schedFn.call(app, v); };
    app._detectMaxPlaybackRate = function (v) { return detectFn.call(app, v); };
    app._tryRateOnce = function (v) { return tryFn.call(app, v); };
    app._waitRateSettle = function (v, ms) { return waitFn.call(app, v, ms); };
    app._readRateMenuMax = function (v) { return menuFn.call(app, v); };
    app._getVideoEl = function () { return app._videoEl; };
    // 把「这一发写在探测里还是落档里」接到这个 app 的真实旗标上 —— 判据读的是生产那格 `_rateProbing`
    // ⚠️ 参数收的是**夹具那一整件**（`{ video, rec }`）：`rec` 挂在包装件上、不在元素上，
    //   传 `attach(x.video)` 会让那道旗标接不上线，探测栏恒读 0（实测撞过，症状像"生产没探测"）
    app.attach = function (v) {
      app._videoEl = v.video || v;
      if (v.rec) v.rec.probing = function () { return !!app._rateProbing; };
      return v;
    };
    return app;
  }
  async function flush() {
    for (var i = 0; i < 8; i++) await new Promise(function (r) { setTimeout(r, 0); });
  }

  // ① 前提：这一副形状真走的是「往播放器上写倍速」那一支，而不是一眼就报「问不出」
  var a = mkVideo({ deny: true, startRate: 0 });
  var appA = mkApp({});
  appA.attach(a);
  var roundWrites = [];
  var roundOwner = [];
  var roundWarns = [];
  for (var i = 0; i < askBound + 3; i++) {
    appA._ensurePlaybackRate(a.video, 'tick' + i);
    await flush();
    roundWrites.push(a.rec.writes.length);
    roundOwner.push(appA._rateDetectVideo === a.video ? 'held'
      : (appA._rateDetectVideo === null ? 'free' : 'other'));
    roundWarns.push(spoke('rate max unreadable').length);
  }
  var menuFirst = menuFn.call(appA, a.video);
  var detectFirst = await detectFn.call(appA, a.video);
  check('① 前提钉住形状：菜单读出 0 档、`_detectMaxPlaybackRate` 交回 0（不知道）而非某一档，'
    + '而每一拍真往 `playbackRate` 上写恰好一发（少了这一格，后面几条读的可能是菜单那一支，与写入无关）',
    menuFirst === 0 && detectFirst === 0 && roundWrites[1] - roundWrites[0] === 1,
    JSON.stringify({ menu: menuFirst, detect: detectFirst, w0: roundWrites[0], w1: roundWrites[1] }));

  // ② 到点就收手：这是这一族唯一承重的数 —— 问的方式就是动播放器，写得勤正是用户报的「抽搐 + 黑屏」
  var asksMade = roundWrites[roundWrites.length - 1];
  var writesPastBound = roundWrites.slice(askBound).map(function (n) { return n - roundWrites[askBound - 1]; });
  check('② 连问 ' + askBound + ' 发问不出之后**一次都不再写播放器**，而 warn 恰好一句'
    + '（不许退化成每 1.5 秒和站点对打一次，也不许三发各说一句把 200 条环吃空）',
    asksMade === askBound && writesPastBound.every(function (d) { return d === 0; })
      && roundWarns[roundWarns.length - 1] === 1,
    JSON.stringify({ asks: asksMade, past: writesPastBound, warns: roundWarns[roundWarns.length - 1], bound: askBound }));

  // ③ 上限前后是两半，各占一格：前 ' + (askBound - 1) + ' 轮要把问权交回 null（还能问），
  //   最后一轮必须**留着**指向这一支（这才叫收手）—— 摘掉任何一半，「永远在试」和「永不试」都能过
  var freeBefore = roundOwner.slice(0, askBound - 1);
  check('③ 上限两侧各钉一格：前 ' + (askBound - 1) + ' 轮把 `_rateDetectVideo` 交回 null（下一拍照旧能问），'
    + '第 ' + askBound + ' 轮把它留给这一支（从此不再问）',
    freeBefore.every(function (s) { return s === 'free'; }) && roundOwner[askBound - 1] === 'held',
    JSON.stringify({ owners: roundOwner, bound: askBound }));

  var metaWarn = spoke('rate max unreadable')[0] || {};
  check('④ 「问不到」那一格说的是真话：warn 的 `tries` 等于源码读回来的预算，级别是 warn 而非把异常咽掉',
    metaWarn.level === 'warn' && Number(metaWarn.meta && metaWarn.meta.tries) === askBound,
    JSON.stringify({ level: metaWarn.level, tries: metaWarn.meta && metaWarn.meta.tries, bound: askBound }));

  check('⑤ 问不到就按原速：`_getTargetPlaybackRate()` 必须回落到 1 —— '
    + '弹窗那根「播放速度」滑条已删（批次 146），没有量到的上限就许按原速，不许替用户猜一档',
    appA._getTargetPlaybackRate() === 1 && Number(appA._detectedMaxRate) === 0,
    JSON.stringify({ target: appA._getTargetPlaybackRate(), detected: appA._detectedMaxRate }));

  // ⑥ 换一支媒体重新起账（阳性对照：第二支真被问了 ' + askBound + ' 发；
  //   阴性那一半是第一支从此不再被打扰 —— 只断后者就测不出「计数压根没按媒体分开」）
  var x = mkVideo({ deny: true, startRate: 0 });
  var y = mkVideo({ deny: true, startRate: 0 });
  var appXY = mkApp({});
  appXY.attach(x);
  for (var k = 0; k < askBound; k++) { appXY._ensurePlaybackRate(x.video, 'x' + k); await flush(); }
  var xWritesAtSwitch = x.rec.writes.length;
  var warnsAtSwitch = spoke('rate max unreadable').length;
  appXY.attach(y);
  for (var k2 = 0; k2 < askBound + 2; k2++) { appXY._ensurePlaybackRate(y.video, 'y' + k2); await flush(); }
  check('⑥ 换一支媒体重新起账：第二支同样被问 ' + askBound + ' 发（不是接着上一支的账直接收手），'
    + '而已经放弃的第一支在这期间一次都没再被动过、每一支各说一句',
    y.rec.writes.length === askBound && x.rec.writes.length === xWritesAtSwitch
      && spoke('rate max unreadable').length === warnsAtSwitch + 1,
    JSON.stringify({ xWrites: x.rec.writes.length, xAtSwitch: xWritesAtSwitch, yWrites: y.rec.writes.length,
      warnsBefore: warnsAtSwitch, warnsAfter: spoke('rate max unreadable').length }));

  // ⑦ 菜单读得出档位时，一次都不许动手写倍速 —— 探测的代价只该在菜单读不出时才付
  var m = mkVideo({ menuCells: [{ textContent: '2.0x' }, { textContent: '1.0x' }] });
  var appM = mkApp({});
  appM.attach(m);
  var warnsBeforeMenu = spoke('rate max unreadable').length;
  appM._ensurePlaybackRate(m.video, 'menu');
  await flush();
  check('⑦ 播放器自己把档位列在菜单里时，上限直接取菜单那一档：**一次都没往播放器上探测**'
    + '（探测栏零写入 = 没试档，只落了量到的那一档），而这一支一句「问不到」都不该说',
    m.rec.probeWrites === 0 && m.rec.probeDefWrites === 0 && spoke('rate menu max found').length === 1
      && Number(appM._detectedMaxRate) === 2 && appM._getTargetPlaybackRate() === 2
      && spoke('rate max unreadable').length === warnsBeforeMenu,
    JSON.stringify({ probeWrites: m.rec.probeWrites, probeDefWrites: m.rec.probeDefWrites,
      writes: m.rec.writes, defWrites: m.rec.defWrites, detected: appM._detectedMaxRate,
      target: appM._getTargetPlaybackRate(), menuLogs: spoke('rate menu max found').length,
      warns: spoke('rate max unreadable').length - warnsBeforeMenu }));

  // ⑧ 站点按住 2x：量到的就是 2，而不是被复位出来的 1（批次 146 根因那一族）
  var h = mkVideo({ held: 2 });
  var appH = mkApp({});
  appH.attach(h);
  appH._ensurePlaybackRate(h.video, 'held');
  await flush();
  var warnsBeforeHeld = spoke('rate max unreadable').length;
  for (var kh = 0; kh < 3; kh++) { appH._ensurePlaybackRate(h.video, 'held' + kh); await flush(); }
  check('⑧ 站点把最高档按回 2x 时交回的是**非 0 的读数**：`_detectedMaxRate` 2、落上去的倍速 2，'
    + '而且之后三拍一次都不再问（交回 0 就会被当成「不知道」而每拍重问，那正是抽搐）；'
    + '站点认的那一档要一起落到 `defaultPlaybackRate`，否则换源时被复位成 1',
    Number(appH._detectedMaxRate) === 2 && h.rec.rate === 2 && h.rec.probeWrites === 1
      && h.rec.writes.length === 1 && h.rec.defWrites[h.rec.defWrites.length - 1] === 2
      && spoke('rate max unreadable').length === warnsBeforeHeld,
    JSON.stringify({ detected: appH._detectedMaxRate, rate: h.rec.rate, probeWrites: h.rec.probeWrites,
      writes: h.rec.writes, defWrites: h.rec.defWrites, extraWarns: spoke('rate max unreadable').length - warnsBeforeHeld }));

  // ⑨ 关掉自动倍速：一次都不问，也不写（阳性对照是 ② —— 开着时确实问了 ' + askBound + ' 发）
  var off = mkVideo({ deny: true, startRate: 0 });
  var appOff = mkApp({ autoMaxPlaybackRate: false });
  appOff.attach(off);
  var warnsBeforeOff = spoke('rate max unreadable').length;
  for (var k3 = 0; k3 < askBound + 2; k3++) { appOff._ensurePlaybackRate(off.video, 'off' + k3); await flush(); }
  check('⑨ 关掉「自动倍速」那一格：一次都不去问、一次都不写播放器，回落值仍是 1'
    + '（开着的那一半由 ② 作证，两半都钉住才不是"这道闸压根没接到"）',
    off.rec.writes.length === 0 && off.rec.defWrites.length === 0
      && appOff._rateDetectVideo === null && appOff._getTargetPlaybackRate() === 1
      && spoke('rate max unreadable').length === warnsBeforeOff,
    JSON.stringify({ writes: off.rec.writes.length, detectVideo: String(appOff._rateDetectVideo),
      target: appOff._getTargetPlaybackRate(), warns: spoke('rate max unreadable').length - warnsBeforeOff }));

  // ⑩ 用户把上限压到 1x：这一档压根没得试，于是问 ' + askBound + ' 发而零次写入 —— 有尽头，也不抽搐
  var capVideo = mkVideo({});
  var appCap = mkApp({ playbackRateCap: 1 });
  appCap.attach(capVideo);
  var warnsBeforeCap = spoke('rate max unreadable').length;
  for (var k4 = 0; k4 < askBound + 2; k4++) { appCap._ensurePlaybackRate(capVideo.video, 'cap' + k4); await flush(); }
  check('⑩ 上限压到 1x 那一格：一次都不往播放器上写（没档可试，`_tryRateOnce` 在动手之前就退出），'
    + '但这一族仍是**有尽头**的 —— 问不出的账停在 ' + askBound + ' 而不是接着涨，只说一句、随后收手',
    capVideo.rec.defWrites.length === 0 && capVideo.rec.writes.length === 0
      && capVideo.rec.probeWrites === 0 && Number(appCap._rateUnknownTries) === askBound
      && appCap._rateDetectVideo === capVideo.video
      && spoke('rate max unreadable').length === warnsBeforeCap + 1,
    JSON.stringify({ defWrites: capVideo.rec.defWrites.length, writes: capVideo.rec.writes,
      probeWrites: capVideo.rec.probeWrites, tries: appCap._rateUnknownTries, bound: askBound,
      held: appCap._rateDetectVideo === capVideo.video,
      warns: spoke('rate max unreadable').length - warnsBeforeCap }));

  // ⑪ 收手不等于永久按住：换任务点与 `loadedmetadata` 都会调 `_resetRateDetection`（`40-media.js:719`、`:1829`）
  var warnsBeforeReset = spoke('rate max unreadable').length;
  var writesBeforeReset = a.rec.writes.length;
  appA._resetRateDetection();
  appA._ensurePlaybackRate(a.video, 'after-reset');
  await flush();
  var asksAfterReset = 0;
  for (var k5 = 0; k5 < askBound - 1; k5++) { appA._ensurePlaybackRate(a.video, 'after-reset2' + k5); await flush(); }
  for (var k6 = 0; k6 < 3; k6++) { appA._ensurePlaybackRate(a.video, 'after-reset3' + k6); await flush(); }
  asksAfterReset = a.rec.writes.length - writesBeforeReset;
  check('⑪ 已放弃的那一支，在 `_resetRateDetection` 之后重新问得到：又问满 ' + askBound
    + ' 发并再说一句（AGENTS §2 #7「静默永久跳过不可接受」—— 收手是一轮的收手，不是把这支永久按住）',
    asksAfterReset === askBound && spoke('rate max unreadable').length === warnsBeforeReset + 1,
    JSON.stringify({ extraAsks: asksAfterReset, bound: askBound,
      extraWarns: spoke('rate max unreadable').length - warnsBeforeReset }));

  // ⑫ 暂停那一族（`video.paused` 为真）：这一支的「问」不是当场写播放器，而是排一枚 timer 等它开播。
  //   这一族以前**一条都不覆盖** —— `pausedBound` 那个数只在 ⓪ 里证明"源码里有"，
  //   而它到点那一发到底记不记进「问不出」的账，没人问过（夹具的 `paused` 选项一直没人用）。
  var pz = mkVideo({ deny: true, startRate: 0, paused: true });
  var appP = mkApp({});
  appP.attach(pz);
  var warnsBeforePaused = spoke('rate max unreadable').length;
  var timersBeforePaused = pausedTimers.length;
  var waitsDone = 0;
  for (var wp = 0; wp < askBound + 1; wp++) {
    appP._ensurePlaybackRate(pz.video, 'paused' + wp);
    await flush();
    var openTimer = null;
    for (var tp = pausedTimers.length - 1; tp >= 0; tp--) if (!pausedTimers[tp].cleared) { openTimer = pausedTimers[tp]; break; }
    if (!openTimer) break;                       // 收手之后不该再排新的等待 —— 这一格由 break 数出来
    for (var dp = 0; dp < pausedBound; dp++) openTimer.fn();
    waitsDone++;
  }
  check('⑫ 暂停那一族：等满 ' + pausedBound + ' 拍之前一次都不碰播放器、也不报「问不出」，'
    + '到点把这一发记进账里；等满 ' + askBound + ' 次才说那一句，随后连新的等待都不再排',
    waitsDone === askBound
      && pz.rec.writes.length === 0 && pz.rec.defWrites.length === 0 && pz.rec.probeWrites === 0
      && pausedTimers.length === timersBeforePaused + askBound
      && pausedTimers.slice(timersBeforePaused).every(function (t) { return t.cleared; })
      && spoke('rate max unreadable').length === warnsBeforePaused + 1
      && Number(appP._rateUnknownTries) === askBound && appP._rateDetectVideo === pz.video,
    JSON.stringify({ waits: waitsDone, askBound: askBound, pausedBound: pausedBound,
      writes: pz.rec.writes.length, defWrites: pz.rec.defWrites.length,
      timers: pausedTimers.length - timersBeforePaused, tries: appP._rateUnknownTries,
      held: appP._rateDetectVideo === pz.video,
      warns: spoke('rate max unreadable').length - warnsBeforePaused }));

  // ⑬ 批次 173 / #199 边界一 + 边界三：同一门课里已经量到过「倍速按住在 1x」⇒ 这一枚**连问都不问**。
  //   「问」在这里不是抽象动作，就是往 `playbackRate` / `defaultPlaybackRate` 上各写一发（用户嫌的正是这一发）。
  //   ⚠️ 第二枚用的是**同一本存储、新的一个 app**（换单元 / 换页就是新的一份内存），
  //   所以这一格证的正是「账跨得过那一枚」，而不是「同一个对象上顺手没写」。
  var gFirst = mkApp({});
  gFirst._currentStudyParams = function () { return { courseid: 'C173', clazzid: 'Z173' }; };
  var armed13 = gFirst._noteCourseGuard('speed', 'measured-1x');
  var saidFirst13 = guardLogs.filter(function (m) {
    return m.message.indexOf('course says rate locked at 1x') === 0
      && String((m.meta || {}).from) === 'measured-1x';
  }).length;
  var gSecond = mkApp({});
  gSecond._currentStudyParams = function () { return { courseid: 'C173', clazzid: 'Z173' }; };
  gSecond._courseGuardStore = gFirst._courseGuardStore;      // 同一门课，另一枚媒体（另一份内存）
  var v13 = mkVideo({ deny: true, startRate: 0 });
  gSecond.attach(v13);
  var warnsBefore13 = spoke('rate max unreadable').length;
  var guardSaysBefore13 = guardLogs.filter(function (m) {
    return m.message.indexOf('course says rate locked at 1x') === 0;
  }).length;
  for (var k13 = 0; k13 < askBound + 2; k13++) { gSecond._ensurePlaybackRate(v13.video, 'g' + k13); await flush(); }
  var says13 = guardLogs.filter(function (m) {
    return m.message.indexOf('course says rate locked at 1x') === 0;
  });
  var skipSays13 = says13.slice(guardSaysBefore13).filter(function (m) { return String((m.meta || {}).from) === 'menu-unreadable'; });
  // 对照组：同样的形状，只是**认不出是哪门课**（今天的行为）—— 必须照旧写播放器，否则 ⑬ 证的可能是「夹具坏了」
  var c13 = mkVideo({ deny: true, startRate: 0 });
  var appC13 = mkApp({});
  appC13.attach(c13);
  appC13._ensurePlaybackRate(c13.video, 'ctl13');
  await flush();
  check('⑬ 课程格命中那一枚：**一个字节都不往播放器上写**（`playbackRate` 与 `defaultPlaybackRate` 都零次），'
    + '交回的是「不知道」而不是伪造的 1x（`_detectedMaxRate` 仍 0），一次性的「问不出」账一下都不拨、'
    + '那一句 warn 也一个字不出，改由课程格单独说一句（`from:menu-unreadable`）；'
    + '同一形状换成「认不出是哪门课」的对照组照旧写 —— 少动手只许来自这一本账',
    armed13 === true && saidFirst13 === 1 && guardSaysBefore13 === 1
      && v13.rec.writes.length === 0 && v13.rec.defWrites.length === 0 && v13.rec.probeWrites === 0
      && gSecond._rateLockedBy === 'course' && Number(gSecond._detectedMaxRate) === 0
      && Number(gSecond._rateUnknownTries) === 0
      && spoke('rate max unreadable').length === warnsBefore13
      && skipSays13.length === 1 && Number(skipSays13[0].meta && skipSays13[0].meta.evidence) >= guardNeedR
      && c13.rec.writes.length === 1 && appC13._rateLockedBy === '',
    JSON.stringify({ armed: armed13, saidFirst: saidFirst13, writes: v13.rec.writes.length,
      defWrites: v13.rec.defWrites.length, lockedBy: gSecond._rateLockedBy,
      detected: gSecond._detectedMaxRate, tries: gSecond._rateUnknownTries,
      unreadableWarns: spoke('rate max unreadable').length - warnsBefore13,
      skipSays: skipSays13.length, evidence: skipSays13[0] && skipSays13[0].meta && skipSays13[0].meta.evidence,
      need: guardNeedR, ctlWrites: c13.rec.writes.length, ctlLockedBy: appC13._rateLockedBy }));

  // ⑭ 边界二：课程格是**策略**，不是许可，也不是不可撤销的判决。
  //   站点自己把档位列在菜单里（纯 DOM，一个字都不写播放器）= 反证 ⇒ 撤销这一门课的账，
  //   于是后面那一枚重新问得到。摘掉这一手，「少动手」就变成「这门课永不试倍速」。
  var g14 = mkApp({});
  g14._currentStudyParams = function () { return { courseid: 'C174', clazzid: 'Z174' }; };   // 另一门课，账是空的
  var armed14 = g14._noteCourseGuard('speed', 'measured-1x');
  var hitBefore14 = g14._courseGuardHit('speed');
  var v14 = mkVideo({ deny: true, startRate: 0, menuCells: [{ textContent: '2.0x' }] });
  g14.attach(v14);
  var menuRate14 = await g14._detectMaxPlaybackRate(v14.video);
  var cell14 = (g14._readSessionLedger(g14._COURSE_GUARD_KEY) || {}).speed || {};
  check('⑭ 菜单列出高于 1x 的档 = 反证：纯 DOM 那一支照旧走（不为课程格跳过），'
    + '并把这一门课的「免倍速」账**撤销**（`n` 归零、来源里留着 `clear:menu` 这一笔），随后又问得到',
    armed14 === true && hitBefore14 === true && menuRate14 === 2
      && g14._courseGuardHit('speed') === false && Number(cell14.n) === 0
      && (cell14.srcs || []).indexOf('clear:menu') >= 0 && g14._rateLockedBy === '',
    JSON.stringify({ armed: armed14, hitBefore: hitBefore14, menuRate: menuRate14,
      hitAfter: g14._courseGuardHit('speed'), n: cell14.n, srcs: (cell14.srcs || []).join(','),
      lockedBy: g14._rateLockedBy }));
}


// 批次 154 / 会话任务 #181：「获取模型列表」（issue #2 第 3 条）
// 为什么这一族要测得这么厚：三处模型名一直是**手抄**，抄错就是 400/404，而报错说的是
// 「模型不存在」，人往网络方向查。新增的这一条走的是同一根 api_fetch 桥，
// 于是它同时踩在三个已有规矩上：§2 #4（地址唯一真源，不许内联）、§2 #2（新增 await 要能超时，
// `.text()` 也算）、§2 #12（六格各占一格，「读不出」不许塌进「没有型号」）。
async function testModelListFetch() {
  console.log('\n[32] 获取模型列表：三型构造、六格说话、响应体超时、竞态不采用（批次 154）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var pop = read('popup/popup.js');
  var popHtml = read('popup/popup.html');
  var API = require('../libs/api-url.js');

  var topFn = function (src, name) {
    var at = src.indexOf('function ' + name + '(');
    if (at < 0) return null;
    if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
    var depth = 0;
    for (var i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
    return null;
  };
  var count = function (hay, needle) {
    var n = 0, at = hay.indexOf(needle);
    while (at >= 0) { n++; at = hay.indexOf(needle, at + needle.length); }
    return n;
  };

  var FN_NAMES = ['buildModelsRequest', 'readTextWithTimeout', 'fetchModelIds', 'modelListSentence',
    'renderModelOptions', 'setModelListState', 'modelsFormKey', 'listModelsFromProvider', 'fetchWithTimeout'];
  var texts = {};
  FN_NAMES.forEach(function (n) { texts[n] = topFn(pop, n); });
  var msLine = (pop.match(/const MODELS_FETCH_TIMEOUT_MS = (\d+);/) || [])[1];
  var genLine = (pop.match(/^let modelsFetchGeneration = 0;$/m) || [])[0];
  var missing = FN_NAMES.filter(function (n) { return !texts[n]; });
  check('⓪ 九件（八个模型列表函数 + 借来真跑的 fetchWithTimeout）都从 popup/popup.js 原样取出，超时数与代号声明也在盘上 —— ' +
    '取不出就整段不跑，那种「没执行」和「通过」在报告里长得一模一样（AGENTS §5）',
    missing.length === 0 && !!msLine && !!genLine,
    JSON.stringify({ missing: missing, msLine: msLine || null, genLine: !!genLine }));
  if (missing.length || !msLine || !genLine) return;

  // ── 模块台：把取出的函数拼进**同一个作用域**跑，注入依赖 ──────────────────
  // 拼一份而不是各跑各的，是为了 modelsFetchGeneration 这一格真的跨调用共享
  // （⑬ 的竞态那一格只有同作用域才测得出来）。
  var DEPS_NAMES = ['API_URL', 'normalizeApiKey', 'self', 'document', 'els', 'config',
    'getApiFormConfig', 'withoutRemovedConfigFields', 'appendPopupLog', 'apiConfigSummary',
    'sendRuntimeMessageWithTimeout', 'MODELS_FETCH_TIMEOUT_MS', 'fetch'];
  var buildModule = function (deps) {
    var body = FN_NAMES.map(function (n) { return texts[n]; }).join('\n') +
      '\n' + genLine +
      '\nreturn { buildModelsRequest: buildModelsRequest, fetchModelIds: fetchModelIds,' +
      ' modelListSentence: modelListSentence, renderModelOptions: renderModelOptions,' +
      ' modelsFormKey: modelsFormKey, list: listModelsFromProvider,' +
      ' fetchWithTimeout: fetchWithTimeout, readTextWithTimeout: readTextWithTimeout };';
    var prelude = DEPS_NAMES.map(function (n) { return 'var ' + n + ' = __deps.' + n + ';'; }).join('\n');
    return new Function('__deps', prelude + '\n' + body)(deps);
  };

  var mkEl = function () {
    var el = { hidden: true, children: [], disabled: false };
    var text = '';
    Object.defineProperty(el, 'textContent', {
      get: function () { return text; },
      set: function (v) { text = String(v); if (v === '') el.children.length = 0; },
      configurable: true
    });
    el.appendChild = function (o) { el.children.push(o); return o; };
    return el;
  };
  // form 是**可变**的：⑬ 要在两发之间改它
  var mkHarness = function (over) {
    over = over || {};
    var h = {
      form: Object.assign({ apiType: 'openai', apiUrl: 'https://a.example/v1', apiKey: 'sk-1' }, over.form || {}),
      logs: [], payloads: [], textCalls: 0
    };
    h.dl = mkEl();
    h.btn = mkEl();
    h.line = mkEl();
    h.deps = {
      API_URL: over.API_URL || API,
      // 用 libs 那份**真**清洗函数：断言里再写一份规则，测的就是"测试和自己的桩一致"而不是代码
      normalizeApiKey: API.normalizeApiKey,
      self: 'self' in over ? over.self : { OmitoneApiError: { describe: function (s, b) { return { category: 'auth', human: '分类:' + s + '|' + String(b).slice(0, 40) }; } } },
      document: { createElement: function (tag) { return { tag: tag, value: '' }; } },
      els: { listModels: h.btn, modelListState: h.line, modelOptions: h.dl },
      config: over.config || {},
      getApiFormConfig: function () { return Object.assign({}, h.form); },
      withoutRemovedConfigFields: function (c) { return c; },
      appendPopupLog: function (level, name, extra) { h.logs.push({ level: level, name: name, extra: extra }); return Promise.resolve(); },
      apiConfigSummary: function (c) { return { apiType: c.apiType, apiUrl: c.apiUrl, keyLength: String(c.apiKey || '').length }; },
      sendRuntimeMessageWithTimeout: over.send || function (msg) {
        h.payloads.push(msg && msg.payload);
        h.textCalls++;
        return Promise.resolve(over.respond ? over.respond(msg) : { success: false, error: 'no stub' });
      },
      // 超时数在盘上是 20000（⑭ 单独钉），这里换小只为让 ⑨ 那一格在毫秒级走到
      MODELS_FETCH_TIMEOUT_MS: over.ms || 50,
      fetch: over.localFetch || function () { h.localFetch = (h.localFetch || 0) + 1; throw new Error('不该掉进本地 fetch 兜底'); }
    };
    h.mod = buildModule(h.deps);
    return h;
  };

  // ---- ①-③ 三胞胎：三种 apiType 各占一格 ----
  var hArgArgs = null;
  var hArg = mkHarness({ API_URL: { buildModelsUrl: function (a, t) { hArgArgs = [a, t]; return 'URL|' + t; } } });
  var mA = hArg.mod.buildModelsRequest({ apiType: 'openai', apiUrl: 'https://x.example/v1', apiKey: 'sk-1' });
  check('① openai 形：走 GET、地址来自真源构造器（收到的实参**逐字**是 apiUrl 与 apiType，不是拼出来的字符串）、Key 进 Authorization 头',
    mA.ok === true && mA.state === 'ready' && mA.method === 'GET' && mA.url === 'URL|openai' &&
      hArgArgs && hArgArgs[0] === 'https://x.example/v1' && hArgArgs[1] === 'openai' &&
      mA.headers.Authorization === 'Bearer sk-1' && !mA.headers['x-api-key'] && !mA.headers['x-goog-api-key'],
    JSON.stringify({ m: mA, args: hArgArgs }));

  var mC = hArg.mod.buildModelsRequest({ apiType: 'claude', apiUrl: 'https://c.example', apiKey: 'sk-2' });
  check('② claude 形：`x-api-key` + `anthropic-version` 两头都在，**没有** Authorization（ anthropic 不认 Bearer，串台就 401）',
    mC.ok === true && mC.url === 'URL|claude' && mC.headers['x-api-key'] === 'sk-2' &&
      !!mC.headers['anthropic-version'] && !mC.headers.Authorization && !mC.headers['x-goog-api-key'],
    JSON.stringify({ hdrs: Object.keys(mC.headers || {}) }));

  var mG = hArg.mod.buildModelsRequest({ apiType: 'gemini', apiUrl: 'https://g.example', apiKey: 'sk-3' });
  check('③ gemini 形：Key 走 `x-goog-api-key` 头，**不进地址**（chat 那条链把 key 拼进 URL，而地址会进日志与「复制日志」的导出面 —— 只读列表没必要再添一处）',
    mG.ok === true && mG.url === 'URL|gemini' && mG.headers['x-goog-api-key'] === 'sk-3' &&
      !mG.headers.Authorization && !mG.headers['x-api-key'] && String(mG.url).indexOf('sk-3') < 0,
    JSON.stringify({ url: mG.url, hdrs: Object.keys(mG.headers || {}) }));

  // ---- ④ 资格先于请求：三格「压根没发出去」----
  var hNo = mkHarness();
  var nKey = hNo.mod.buildModelsRequest({ apiType: 'openai', apiUrl: 'https://x', apiKey: '' });
  var nAddrO = hNo.mod.buildModelsRequest({ apiType: 'openai', apiUrl: '   ', apiKey: 'sk-1' });
  var nAddrG = hNo.mod.buildModelsRequest({ apiType: 'gemini', apiUrl: '', apiKey: 'sk-1' });
  var okAddrC = hNo.mod.buildModelsRequest({ apiType: 'claude', apiUrl: '', apiKey: 'sk-1' });
  check('④ 没资格就不发请求，四格分开：没 Key → nokey；openai 空地址 → noaddr；gemini 空地址 → noaddr；' +
    '**claude 空地址照旧放行**（它有自己的默认地址，叫用户去填是假坎 —— 与 testApiConnectionNoBackground 同一口径）',
    nKey.state === 'nokey' && nAddrO.state === 'noaddr' && nAddrG.state === 'noaddr' &&
      okAddrC.ok === true && okAddrC.state === 'ready',
    JSON.stringify({ nokey: nKey.state, oai: nAddrO.state, gem: nAddrG.state, cla: okAddrC.state }));

  var hNoSend = mkHarness({ form: { apiKey: '' } });
  var outNoKey = await hNoSend.mod.fetchModelIds(hNoSend.form);
  check('⑤ 「没填 Key」那一发**一个请求都不发**（sendRuntimeMessageWithTimeout 计数为 0）—— 先问资格再拼地址不是措辞，是不花钱、也不让界面把「你没填」说成「这家未授权」',
    outNoKey.state === 'nokey' && hNoSend.textCalls === 0,
    JSON.stringify({ state: outNoKey.state, calls: hNoSend.textCalls }));

  var hBlankUrl = mkHarness({ API_URL: { buildModelsUrl: function () { return ''; } } });
  var outBlankUrl = await hBlankUrl.mod.fetchModelIds(hBlankUrl.form);
  check('⑥ 真源构造器交回空串时同样不发请求（noaddr 那一格不许被跳过）—— 少了这道门，空地址会带着 `undefined/v1/models` 出门，回包是一句看不懂的 404',
    outBlankUrl.state === 'noaddr' && hBlankUrl.textCalls === 0,
    JSON.stringify({ state: outBlankUrl.state, calls: hBlankUrl.textCalls }));

  var hQuote = mkHarness({ API_URL: { buildModelsUrl: function () { return 'URL'; } } });
  var mQuote = hQuote.mod.buildModelsRequest({ apiType: 'openai', apiUrl: 'u', apiKey: '"Bearer sk-5" ' });
  check('⑦ Key 先进清洗（normalizeApiKey）再进头：`"Bearer sk-5"` 抄进去的样子出去的是 `Bearer sk-5`（与答题同一条口径，AGENTS §2 #4 的那个唯一真源）',
    mQuote.ok === true && mQuote.headers.Authorization === 'Bearer sk-5',
    JSON.stringify({ auth: mQuote.headers && mQuote.headers.Authorization }));

  // ---- ⑧-⑨ 发送层：HTTP 分类 + 响应体挂住 ----
  var h401 = mkHarness({
    respond: function () { return { success: false, status: 401, text: 'bad key' }; }
  });
  var out401 = await h401.mod.fetchModelIds(h401.form);
  check('⑧ HTTP 401：state 落 http 且文案**走 OmitoneApiError 分类**（带回 status 与包体），不是笼统一句「连接失败」',
    out401.ok === false && out401.state === 'http' && out401.status === 401 &&
      out401.category === 'auth' && String(out401.why).indexOf('分类:401|bad key') === 0,
    JSON.stringify({ s: out401.state, st: out401.status, why: out401.why, cat: out401.category }));

  // 代理交回 `{success:true, status:200, text:''}` —— 这一形在生产里真会出现（8 MB 读上限、
  // 空体、或后台把 body 截干净），它必须落 unreadable（body-empty），不许落进 ok/empty 任何一格。
  var hEmpty = mkHarness({ respond: function () { return { success: true, status: 200, text: '' }; } });
  var emptyText = await hEmpty.mod.fetchModelIds(hEmpty.form);
  check('⑧-b 连上了但回包是空体：落 unreadable（why 是 body-empty），**不是** ok 也不是 empty —— ' +
    '"empty" 那一格留给服务商自己说「我名下没有型号」（回包里有清单、只是空数组），两者对用户是两件不同的事',
    emptyText.state === 'unreadable' && emptyText.ok === false && emptyText.why === 'body-empty',
    JSON.stringify({ state: emptyText.state, why: emptyText.why }));

  var hEmptyList = mkHarness({ respond: function () { return { success: true, status: 200, text: '{"data":[]}' }; } });
  var emptyList = await hEmptyList.mod.fetchModelIds(hEmptyList.form);
  var noCandidates = hEmptyList.dl.children.length;
  check('⑧-c 回包是空数组：落 empty 单独一格，且**不清空已有候选**（renderModelOptions 没被叫到，' +
    '用户上一次问到的清单还在 —— 把"这家说没有"实现成"把界面擦干净"是最气人的一种退化）',
    emptyList.state === 'empty' && emptyList.ok === false && noCandidates === 0,
    JSON.stringify({ state: emptyList.state, dl: noCandidates }));

  var hTrueHang = mkHarness();
  // 直接把 response.text() 换成永不 resolve：§2 #2 说 try/catch 拦不住挂起，只有超时能 —— 这一格就是那条规矩的尺
  var hungRead = await hTrueHang.mod.readTextWithTimeout.call(null, { text: function () { return new Promise(function () {}); } }, 40);
  check('⑨ 响应体永远不 resolve 时，readTextWithTimeout 在超时那一路交回 null（**单独一格**，不是空串）—— ' +
    '少了这一手，那一发会永远悬着：按钮停在「获取中…」、代号闸永远等不到回话，而没有任何异常可捕',
    hungRead === null,
    JSON.stringify({ got: String(hungRead), type: typeof hungRead }));

  // 整条链走到那一格（不只测助手）：代理没交出可用的字符串体 → 落本地 fetch 兜底 → 那一份的
  // text() 挂住 → fetchModelIds 必须说的是「响应体没读到」，而不是 parseModelIds 的某个 why。
  var hBodyLost = mkHarness({
    send: function (msg) { hBodyLost.payloads.push(msg && msg.payload); hBodyLost.textCalls++; return Promise.resolve({ success: true, status: 200, text: 42 }); },
    localFetch: function () { return Promise.resolve({ ok: true, status: 200, text: function () { return new Promise(function () {}); } }); }
  });
  var bodyLost = await hBodyLost.mod.fetchModelIds(hBodyLost.form);
  var bodyLostLine = hBodyLost.mod.modelListSentence(bodyLost);
  check('⑨-b 挂住的响应体走过整条链：state 是 unreadable、why 点名「响应体没读到」，句子也跟着说这一句 —— ' +
    '少了这一格，那一发会以 parseModelIds 的 why（no-list / not-json）交回，界面把「连接断了」说成「这家回包的形状认不出来」',
    bodyLost.state === 'unreadable' && bodyLost.ok === false &&
      String(bodyLost.why).indexOf('没读到') >= 0 && String(bodyLostLine).indexOf('没读到') >= 0,
    JSON.stringify({ state: bodyLost.state, why: bodyLost.why, line: bodyLostLine }));

  var emptyRead = await hTrueHang.mod.readTextWithTimeout.call(null, { text: function () { return Promise.resolve(''); } }, 40);  var threwSync = await hTrueHang.mod.readTextWithTimeout.call(null, { text: function () { throw new Error('连接断了'); } }, 40);
  var threwAsync = await hTrueHang.mod.readTextWithTimeout.call(null, { text: function () { return Promise.reject(new Error('连接断了')); } }, 40);
  var noTextFn = await hTrueHang.mod.readTextWithTimeout.call(null, {}, 40);
  var noResponse = await hTrueHang.mod.readTextWithTimeout.call(null, null, 40);
  check('⑩ 「读到空」与「没读到」分成两格：空体 → 空串（真读到，只是空）；text() 当场抛 / 拒绝 / 压根没有 text() / ' +
    '连 response 都没有 → null（没读到）—— 把 null 压成空串，「连接断了」就会冒充「这家回了个空体」，' +
    '而这两句用户听完要做的事相反（同一格同步抛与异步拒绝各测一次：它们走的是 catch 与 then 两条路）',
    emptyRead === '' && threwSync === null && threwAsync === null && noTextFn === null && noResponse === null,
    JSON.stringify({ empty: emptyRead, threwSync: threwSync, threwAsync: threwAsync, noTextFn: noTextFn, noResponse: noResponse }));

  // ---- ⑪ 六格句子各说各话 ----
  var sixStates = ['ok', 'empty', 'unreadable', 'http', 'nokey', 'noaddr'];
  var sixOuts = {
    ok: { state: 'ok', ids: ['deepseek-chat', 'deepseek-reasoner', 'm-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f'] },
    empty: { state: 'empty', ids: [] },
    unreadable: { state: 'unreadable', ids: [], why: 'no-list' },
    http: { state: 'http', ids: [], why: '分类:429|限流' },
    nokey: { state: 'nokey', ids: [] },
    noaddr: { state: 'noaddr', ids: [] }
  };
  var sixSent = sixStates.map(function (s) { return hNo.mod.modelListSentence(sixOuts[s]); });
  var uniq = sixSent.filter(function (x, i) { return sixSent.indexOf(x) === i; });
  check('⑪ 六格句子**互不相同且都不为空**（ok / empty / unreadable / http / nokey / noaddr 各一句），' +
    '而 ok 那句带**实际条数**（8 个型号是从回包读回来的，不是写死的）—— 压成「成功/失败」两格时，' +
    '「形状认不出来」会被读成「这家没有型号」，用户接下来做的事（换 Key、充值、查网络）一件都不对（AGENTS §2 #12）',
    uniq.length === 6 && sixSent.every(function (s) { return String(s).trim().length > 6; }) &&
      sixSent[0].indexOf('8 个型号') >= 0 && sixSent[0].indexOf('deepseek-chat') >= 0,
    JSON.stringify({ uniq: uniq.length, first: sixSent[0], unreadable: sixSent[2] }));

  var nullSent = hNo.mod.modelListSentence(null);
  check('⑪-b 「一句话都没读到」不许塌进上面任何一格：单独一句「再点一次试试」',
    !!nullSent && nullSent.indexOf('再点一次') >= 0,
    JSON.stringify({ nullSent: nullSent }));

  // ---- ⑫ libs 真源形状：认得出就剥前缀去重，认不出交 unreadable，绝不猜 ----
  var shapes = [
    [JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), 'ok', 2],
    [JSON.stringify({ models: ['x', 'y'] }), 'ok', 2],
    [JSON.stringify({ data: [{ name: 'models/gemini-2.5-pro' }] }), 'ok', 1],
    [JSON.stringify({ data: [] }), 'empty', 0],
    [JSON.stringify({ foo: 1 }), 'unreadable', 0],
    [JSON.stringify({ data: [{ id: 'ok' }, 42] }), 'unreadable', 0],
    ['这不是 JSON', 'unreadable', 0],
    ['', 'unreadable', 0]
  ];
  var shapeGot = shapes.map(function (row) {
    var r = API.parseModelIds(row[0]);
    return { state: r.state, n: r.ids.length, why: r.why };
  });
  var shapeOk = shapes.every(function (row, i) {
    return shapeGot[i].state === row[1] && shapeGot[i].n === row[2];
  });
  check('⑫ parseModelIds 八种形状逐格对账（data[] / models[] / name 带 `models/` 前缀要剥 / 空数组=empty / ' +
    '没有清单=unreadable / 混进非对象元素=**整份**unreadable / 非 JSON / 空体）—— ' +
    '「认不出交 unreadable，绝不猜」：拆 display_name 或按字符摊开会凭空造出发不出去的型号（AGENTS §2 #18 那一族）',
    shapeOk && API.parseModelIds(shapes[2][0]).ids[0] === 'gemini-2.5-pro' &&
      API.parseModelIds(shapes[0][0]).ids.join(',') === 'a,b',
    JSON.stringify(shapeGot));

  // ---- ⑬ 竞态：改过地址就不采用旧批次 ----
  var hRace = mkHarness();
  var raceMod = hRace.mod;
  var raceN = 0;
  hRace.deps.sendRuntimeMessageWithTimeout = function (msg) {
    raceN++;
    var body = raceN === 1
      ? JSON.stringify({ data: [{ id: 'old-a' }, { id: 'old-b' }] })
      : JSON.stringify({ data: [{ id: 'new-1' }] });
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ success: true, status: 200, text: body }); }, raceN === 1 ? 120 : 5);
    });
  };
  raceMod = buildModule(hRace.deps);
  var p1 = raceMod.list();
  hRace.form.apiUrl = 'https://b.example/v1';   // 等待期间换了地址
  var p2 = raceMod.list();
  await Promise.all([p1, p2]);
  var raceValues = hRace.dl.children.map(function (o) { return o.value; }).join(',');
  var discLogs = hRace.logs.filter(function (l) { return l.name.indexOf('discarded') >= 0; }).length;
  check('⑬ 两发并发、期间换了 API URL：**旧批次不采用**（候选里只有 new-1，没有 old-a/old-b），' +
    '状态行点名「改过了」，日志单独有一格 discarded —— ⚠️ 这一发**代号与表单键同时开火**，' +
    '单独承重各由 ⑬-b / ⑬-c 测（AGENTS §5「两层保护不许一起摘」），' +
    '少了它们用户会拿到「按旧 Key 问回来的清单」却以为是自己刚填那家（AGENTS §2 #13/#23 同一族，但这里刻意不用 apiFormFingerprint：开关不该挡型号清单）',
    raceValues === 'new-1' && discLogs === 1 && String(hRace.line.textContent).indexOf('改过') >= 0 &&
      hRace.logs.some(function (l) { return l.name === 'models list result'; }),
    JSON.stringify({ values: raceValues, discLogs: discLogs, line: hRace.line.textContent, logs: hRace.logs.map(function (l) { return l.name; }) }));

  // ---- ⑬-b / ⑬-c：把上面那两道闸**各拆一道**单独测 ----
  // ⑬ 那一发代号和表单键同时开火：摘掉任何一道，另一道照样拦下旧批次，于是两道都等于没测。
  // 这里 ⑬-b 只留代号（并发但配置一个字没改），⑬-c 只留表单键（只改地址、没有第二发）。
  var hRaceGen = mkHarness();
  var raceGenN = 0;
  hRaceGen.deps.sendRuntimeMessageWithTimeout = function () {
    raceGenN++;
    var body = raceGenN === 1
      ? JSON.stringify({ data: [{ id: 'old-a' }, { id: 'old-b' }] })
      : JSON.stringify({ data: [{ id: 'new-1' }] });
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ success: true, status: 200, text: body }); }, raceGenN === 1 ? 120 : 5);
    });
  };
  var modGen = buildModule(hRaceGen.deps);
  var g1 = modGen.list();   // 慢的那发先按下
  var g2 = modGen.list();   // 快的第二发：apiType / apiUrl / apiKey 一个字没改
  await Promise.all([g1, g2]);
  var genValues = hRaceGen.dl.children.map(function (o) { return o.value; }).join(',');
  var genDisc = hRaceGen.logs.filter(function (l) { return l.name.indexOf('discarded') >= 0; }).length;
  check('⑬-b 并发但**配置一个字没改**：只有代号拦下旧批次（候选只有 new-1，discarded 恰一格）—— ' +
    '少了代号这一格，慢的那发会把「上一秒点出来的清单」盖到候选里，而界面看不出任何异常',
    genValues === 'new-1' && genDisc === 1 && raceGenN === 2 &&
      hRaceGen.logs.some(function (l) { return l.name === 'models list result'; }),
    JSON.stringify({ values: genValues, disc: genDisc, sends: raceGenN }));

  var hRaceKey = mkHarness();
  hRaceKey.deps.sendRuntimeMessageWithTimeout = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ success: true, status: 200, text: JSON.stringify({ data: [{ id: 'late-1' }] }) });
      }, 20);
    });
  };
  var modKey = buildModule(hRaceKey.deps);
  var k1 = modKey.list();                 // 只有一发在飞：代号永远相等，拦得住的只剩表单键
  hRaceKey.form.apiUrl = 'https://c.example/v1';
  await k1;
  var keyValues = hRaceKey.dl.children.map(function (o) { return o.value; }).join(',');
  var keyDisc = hRaceKey.logs.filter(function (l) { return l.name.indexOf('discarded') >= 0; }).length;
  check('⑬-c 只换地址、**没有第二发**：表单键单独拦下（候选保持空，discarded 恰一格，状态行点名「改过」）—— ' +
    '这一格与 ⑬-b 各拆一道闸，摘掉任何一道只有对应那一格红',
    keyDisc === 1 && keyValues === '' && String(hRaceKey.line.textContent).indexOf('改过') >= 0,
    JSON.stringify({ values: keyValues, disc: keyDisc, line: hRaceKey.line.textContent }));

  // ---- ⑭ 候选渲染不叠加 ----
  var hDl = mkHarness();
  hDl.mod.renderModelOptions(['a', 'b', 'c']);
  var firstN = hDl.dl.children.length;
  hDl.mod.renderModelOptions(['x']);
  var secondValues = hDl.dl.children.map(function (o) { return o.value; }).join(',');
  var secondTags = hDl.dl.children.map(function (o) { return o.tag; }).join(',');
  check('⑭ 第二次点「获取模型列表」时旧候选先清空（3 → 1，值逐字是 x），并且建出来的是 `<option value=型号名>` —— ' +
    '少了那句清空，用户点开候选看到的是两批叠在一起、还带重复',
    firstN === 3 && secondValues === 'x' && secondTags === 'option',
    JSON.stringify({ firstN: firstN, second: secondValues, tags: secondTags }));

  hDl.mod.renderModelOptions(['k1', 'k2']);
  hDl.mod.renderModelOptions(null);
  check('⑭-b 交回 null / 空清单时清空候选（不许留上一批的残影，也不许报错）',
    hDl.dl.children.length === 0,
    JSON.stringify({ after: hDl.dl.children.length }));

  // ---- ⑮ GET 不带 body（fetchWithTimeout 那处真 bug 的尺）----
  var hBody = mkHarness({ respond: function () { return { success: true, status: 200, text: '{"data":[{"id":"m1"}]}' }; } });
  var outBody = await hBody.mod.fetchModelIds(hBody.form);
  check('⑮ 走代理的那一发 payload：**method 是 GET 且 body 是 null** —— ' +
    '后台那边是 `body == null ? undefined : String(body)`，空串也算「有 body」，浏览器对 GET 带 body 当场抛 TypeError；' +
    '而 fetchWithTimeout 把代理失败吞成「改走本地 fetch」，症状只是慢半拍、不是错（本轮实测撞在动手之前）',
    outBody.ok === true && hBody.payloads.length === 1 &&
      hBody.payloads[0].method === 'GET' && hBody.payloads[0].body === null &&
      hBody.localFetch === undefined,
    JSON.stringify({ payload: hBody.payloads[0], localFetch: hBody.localFetch, state: outBody.state }));

  var postPayload = null;
  var hPost = mkHarness({
    send: function (msg) { postPayload = msg.payload; return Promise.resolve({ success: true, status: 200, text: '{}' }); }
  });
  await hPost.mod.fetchWithTimeout('https://x/v1/chat/completions', { method: 'POST' }, 30);
  check('⑮-b 反向对照：**POST 不带 body 时仍然补空串**（老口径不许跟着这次修改一起松掉，否则答题/聊天那两条链路会少一样东西）',
    postPayload && postPayload.method === 'POST' && postPayload.body === '',
    JSON.stringify({ post: postPayload }));

  // ---- ⑯ 静态接线：界面三处都指向同一份候选，地址不内联 ----
  var listHits = count(popHtml, 'list="modelOptions"');
  var dlHits = count(popHtml, '<datalist id="modelOptions">');
  var btnHits = count(popHtml, 'id="listModels"');
  var stateHits = count(popHtml, 'id="modelListState"');
  check('⑯ 界面上四处接线都在且**不多不少**：三处模型名（主模型 / 看图 / 验证码）都挂同一份 datalist（少挂一处，那一处就还是手抄 —— 三胞胎的界面版）、' +
    'datalist 1 枚、按钮 1 枚、状态行 1 枚；popup.js 里按钮真绑到 listModelsFromProvider',
    listHits === 3 && dlHits === 1 && btnHits === 1 && stateHits === 1 &&
      count(pop, 'addEventListener("click", listModelsFromProvider)') === 1,
    JSON.stringify({ list: listHits, dl: dlHits, btn: btnHits, state: stateHits, hook: count(pop, 'addEventListener("click", listModelsFromProvider)') }));

  var inlined = count(pop, "'/models'") + count(pop, '"/models"') + count(pop, '`/models`') + count(pop, '") + "/models');
  var builderCalls = count(pop, 'buildModelsUrl(');
  var parserCalls = count(pop, 'parseModelIds(');
  check('⑰ 地址与解析都**只在 libs 那一份**里：popup.js 里 `/models` 字面量拼接 0 处、`buildModelsUrl(` 恰好 1 处（在 buildModelsRequest 体内）、' +
    '`parseModelIds(` 恰好 1 处（AGENTS §2 #4 —— 内联一份就会和答题那三条链路分叉，同样的 Key 这边通那边不通）',
    inlined === 0 && builderCalls === 1 && parserCalls === 1 &&
      texts.buildModelsRequest.indexOf('buildModelsUrl(') >= 0 &&
      texts.fetchModelIds.indexOf('parseModelIds(') >= 0,
    JSON.stringify({ inlined: inlined, builder: builderCalls, parser: parserCalls }));

  var msNum = Number(msLine);
  var msUses = count(texts.fetchModelIds, 'MODELS_FETCH_TIMEOUT_MS') + count(texts.readTextWithTimeout, 'MODELS_FETCH_TIMEOUT_MS');
  check('⑱ 超时数从盘上读回来比（断言里不写死）：`const MODELS_FETCH_TIMEOUT_MS = ' + msLine + '` 是正数，' +
    '且发送层与读体层都真的用它（合计 ' + msUses + ' 处）—— 只包 fetch 不包 `.text()` 的那一半，挂起照样拦不住（AGENTS §2 #2）',
    msNum > 0 && Number.isFinite(msNum) && msUses >= 3 &&
      count(texts.fetchModelIds, 'MODELS_FETCH_TIMEOUT_MS') === 3 &&
      count(texts.readTextWithTimeout, 'MODELS_FETCH_TIMEOUT_MS') >= 1,
    JSON.stringify({ msLine: msLine, msUses: msUses, send: count(texts.fetchModelIds, 'MODELS_FETCH_TIMEOUT_MS'), read: count(texts.readTextWithTimeout, 'MODELS_FETCH_TIMEOUT_MS') }));

  var libsHas = count(read('libs/api-url.js'), 'function buildModelsUrl(') + count(read('libs/api-url.js'), 'function parseModelIds(');
  var libsExport = /buildModelsUrl: buildModelsUrl/.test(read('libs/api-url.js')) &&
    /parseModelIds: parseModelIds/.test(read('libs/api-url.js'));
  check('⑱-b libs/api-url.js 里两件**各自只声明一处且都导出**（导出漏了 popup 那侧拿到 undefined，' +
    '一调用就抛 —— 而那正被 ⑥ 的空串格盖住，会读成「这家地址不对」）',
    libsHas === 2 && libsExport && typeof API.buildModelsUrl === 'function' && typeof API.parseModelIds === 'function',
    JSON.stringify({ decl: libsHas, export: libsExport }));
}

// ==================== 联网搜索那把尺（任务 #183）====================
// 为什么单开一段：libs/web-search.js 是「这一发到底带不带搜索」的唯一真源，而**登记漏一处
// 不会有任何异常**（AGENTS §2 #18）—— 弹窗与上课页各自退回本地那份"没搜"，用户听到的那句
// 模型回答照样听起来像刚查过。所以这一段测的是**尺本身**与**只有一份尺**，
// 三处出口真带没带 tools 在 [26]/[27] 里逐格钉。
async function testWebSearchGate() {
  console.log('\n[33] 联网搜索那把尺：libs 八格自证 + 两处登记 + 全仓只有一份判定（任务 #183）');

  var read = function (rel) {
    try { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return ''; }
  };
  var countStr = function (hay, needle) {
    var s = String(hay || ''), n = 0, at = s.indexOf(needle);
    while (at >= 0) { n++; at = s.indexOf(needle, at + needle.length); }
    return n;
  };
  // 剥注释必须**等长**、而且**不许把字符串里的 `//`（https://）当注释**（AGENTS §5：
  // 剥完行数不变、几句真代码仍在原处，才算"剥"这一手自己在承重）。
  var stripComments = function (src) {
    var s = String(src || ''), out = '', i = 0;
    while (i < s.length) {
      var c = s.charAt(i), d = s.charAt(i + 1);
      if (c === '/' && d === '/') {
        while (i < s.length && s.charAt(i) !== '\n') { out += ' '; i++; }
      } else if (c === '/' && d === '*') {
        out += '  '; i += 2;
        while (i < s.length && !(s.charAt(i) === '*' && s.charAt(i + 1) === '/')) { out += s.charAt(i) === '\n' ? '\n' : ' '; i++; }
        out += '  '; i += 2;
      } else if (c === '"' || c === "'" || c === '`') {
        out += c; i++;
        while (i < s.length && s.charAt(i) !== c) {
          if (s.charAt(i) === '\\') { out += s.charAt(i); i++; }
          out += s.charAt(i); i++;
        }
        if (i < s.length) { out += s.charAt(i); i++; }
      } else { out += c; i++; }
    }
    return out;
  };
  var topFn = function (src, name) {
    var at = String(src || '').indexOf('function ' + name + '(');
    if (at < 0) return null;
    var depth = 0;
    for (var i = String(src).indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
    return null;
  };

  var WS = null;
  try { WS = require('../libs/web-search.js'); } catch (e) { WS = null; }
  var libSrc = read('libs/web-search.js');
  var popSrc = read('popup/popup.js');
  var conSrc = read('content.js');
  var htmlSrc = read('popup/popup.html');
  var manSrc = read('manifest.json');
  var OFFICIAL = WS && WS.OFFICIAL_HOST ? String(WS.OFFICIAL_HOST) : '';
  var OK_CFG = { apiKey: 'sk-test', apiType: 'openai', apiUrl: 'https://' + OFFICIAL + '/chat/completions' };

  var seven = ['OFFICIAL_HOST', 'hostOf', 'isOfficialHost', 'decisionOf', 'toolsFor', 'usageOf', 'sentenceOf'];
  var missing = seven.filter(function (k) { return !WS || WS[k] === undefined; });
  check('⓪ libs/web-search.js  require 得到、七件导出齐全，五份生产文本都从盘上读回来 —— ' +
    '取不出就整段不跑（那种「没执行」和「通过」在报告里长得一模一样，AGENTS §5）',
    !missing.length && seven.every(function (k) { return k === 'OFFICIAL_HOST' || typeof WS[k] === 'function'; }) &&
      libSrc.length > 2000 && popSrc.length > 2000 && conSrc.length > 2000 && htmlSrc.length > 2000 && manSrc.length > 200,
    JSON.stringify({ missing: missing, libBytes: libSrc.length, official: OFFICIAL }));
  if (!WS || missing.length || !OFFICIAL) return;

  // ── ① 八格各占一格，判定顺序冻结在「开关 → Key → 协议 → 地址」────────────────
  var dUnknown = WS.decisionOf(OK_CFG, null);
  var dOff = WS.decisionOf(OK_CFG, false);
  var dKey = WS.decisionOf({ apiKey: '  ', apiType: 'claude', apiUrl: 'https://relay.example.com/v1' }, true);
  var dType = WS.decisionOf({ apiKey: 'sk-test', apiType: 'claude', apiUrl: OK_CFG.apiUrl }, true);
  var dNoAddr = WS.decisionOf({ apiKey: 'sk-test', apiType: 'openai', apiUrl: '' }, true);
  var dUnread = WS.decisionOf({ apiKey: 'sk-test', apiType: 'openai', apiUrl: '/v1/chat/completions' }, true);
  var dRelay = WS.decisionOf({ apiKey: 'sk-test', apiType: 'openai', apiUrl: 'https://relay.example.com/v1' }, true);
  var dOn = WS.decisionOf(OK_CFG, true);
  var cells8 = [dUnknown, dOff, dKey, dType, dNoAddr, dUnread, dRelay, dOn].map(function (d) { return d.cell; });
  // 同一份坏配置（没 Key + 协议不对 + 中转站）按开关三态各说一句话：
  // 把地址那一格排在前面的话，「用户压根没开」会被说成「你填的地址不是官方域」。
  var BAD_CFG = { apiKey: '', apiType: 'claude', apiUrl: 'https://relay.example.com/v1' };
  var bySwitch = [WS.decisionOf(BAD_CFG, null).cell, WS.decisionOf(BAD_CFG, false).cell, WS.decisionOf(BAD_CFG, true).cell];
  check('① decisionOf 八格各占一格（' + cells8.join(',') + '）且只有 on 那一格 on:true —— ' +
    '再钉同一份坏配置按开关三态说出三个不同的格子（' + bySwitch.join('/') + '），' +
    '顺序一旦把地址挪到开关之前，「还没读到」与「没开」就塌进「你地址不对」（AGENTS §2 #5 / #12）',
    cells8.join(',') === 'unknown,off,no-key,type,no-addr,unreadable,not-official,on' &&
      cells8.filter(function (v, i) { return cells8.indexOf(v) === i; }).length === 8 &&
      [dUnknown, dOff, dKey, dType, dNoAddr, dUnread, dRelay].every(function (d) { return d.on === false; }) &&
      dOn.on === true && bySwitch.join(',') === 'unknown,off,no-key' &&
      dRelay.host === 'relay.example.com' && dOn.host === OFFICIAL,
    JSON.stringify({ cells: cells8, bySwitch: bySwitch, onlyOn: [dUnknown, dOff, dKey, dType, dNoAddr, dUnread, dRelay, dOn].filter(function (d) { return d.on; }).length }));

  // ── ② hostOf 的十三种形状；isOfficialHost 与 decisionOf 必须是同一把尺 ────────
  var hostCases = [
    'HTTPS://API.DeepSeek.COM:443/v1?x=1', 'https://user:pw@api.deepseek.com/v1',
    'https://api.deepseek.com.ru/v1', 'http://127.0.0.1:8787/v1', '/v1/chat/completions',
    '//api.deepseek.com/v1', '   https://api.deepseek.com   ', '', null, 123, {}, 'api.deepseek.com',
    'https://api.deepseek.com'
  ];
  var hostRows = hostCases.map(function (u) {
    var d = WS.decisionOf({ apiKey: 'sk-test', apiType: 'openai', apiUrl: u }, true);
    return { u: String(u), host: WS.hostOf(u), same: WS.isOfficialHost(u) === (d.cell === 'on'), cell: d.cell };
  });
  check('② hostOf 十三种地址形状逐个量回（大写／端口／userinfo／query／前后空格／相对路径／协议缺失／空／非字符串），' +
    '后缀陷阱 `api.deepseek.com.ru` 读出的是它自己而不是官方域，且 isOfficialHost 与 decisionOf 对每一行结论一致 —— ' +
    '两处不一致就是两把尺，将来只改一处会分叉（AGENTS §2 #18）',
    hostRows.every(function (r) { return r.same; }) &&
      WS.hostOf(hostCases[0]) === OFFICIAL && WS.hostOf(hostCases[1]) === OFFICIAL &&
      WS.hostOf(hostCases[6]) === OFFICIAL && WS.hostOf(hostCases[12]) === OFFICIAL &&
      WS.hostOf(hostCases[2]) === 'api.deepseek.com.ru' && WS.isOfficialHost(hostCases[2]) === false &&
      WS.hostOf(hostCases[3]) === '127.0.0.1' &&
      [4, 5, 7, 8, 9, 10, 11].every(function (i) { return WS.hostOf(hostCases[i]) === ''; }),
    JSON.stringify(hostRows));

  // ── ③ 那一发 tools 的形状：字面量从 libs 源码读回来比，不在断言里抄第二份 ────────
  var toolLine = (libSrc.match(/var SEARCH_TOOL = \{ type: ["']([^"']+)["'] \};/) || [])[1] || '';
  var tOn = WS.toolsFor(dOn);
  var tOthers = [dUnknown, dOff, dKey, dType, dNoAddr, dUnread, dRelay].map(function (d) { return WS.toolsFor(d); });
  check('③ toolsFor 只在 on 那一格交出一份，形状是「只有一个字段的那一格」，字段值与 libs 里声明的那个字面量逐字相同' +
    '（值从 `var SEARCH_TOOL = …` 那行读回来，断言里没有第二份）；带不动的七格一律交**空数组**（不是 undefined），' +
    '调用方据此整个字段都不写 —— 写 `tools: []` 是让服务端猜',
    !!toolLine && tOn.length === 1 && Object.keys(tOn[0]).length === 1 && tOn[0].type === toolLine &&
      tOthers.every(function (t) { return Array.isArray(t) && t.length === 0; }) &&
      Array.isArray(WS.toolsFor(null)) && WS.toolsFor(null).length === 0,
    JSON.stringify({ decl: toolLine, on: tOn, emptyCells: tOthers.length }));

  // ── ④ usageOf 四格；读不出恒 -1，不许被压成 0（AGENTS §2 #2）───────────────────
  var uBadNull = WS.usageOf(null);
  var uBadStr = WS.usageOf('x');
  var uNoUsage = WS.usageOf({});
  var uNoTool = WS.usageOf({ usage: { prompt_tokens: 63, completion_tokens: 10 } });
  var uHalf = WS.usageOf({ usage: { server_tool_use: { tool_fetch: 1 }, prompt_tokens: 4653 } });
  var uOk = WS.usageOf({ usage: { server_tool_use: { tool_search: 2, tool_fetch: 1 }, prompt_tokens: 4653, completion_tokens: 410, prompt_tokens_details: { cached_tokens: 896 } } });
  var uNeg = WS.usageOf({ usage: { prompt_tokens: -5, completion_tokens: 'abc' } });
  var numFields = ['search', 'fetch', 'prompt', 'completion', 'cached'];
  check('④ usageOf 四格（bad-shape / no-usage / no-tool-cell / ok）各占一格，且「拿不到」一律 -1 而不是 0：' +
    '整份没有 usage、server_tool_use 在但 tool_search 缺、数字是负数或字符串 —— 三族都被压成 0 时，' +
    '取证里就凭空多出一条方向为「放行」的断言（AGENTS §2 #2）',
    uBadNull.cell === 'bad-shape' && uBadStr.cell === 'bad-shape' && uNoUsage.cell === 'no-usage' &&
      uNoTool.cell === 'no-tool-cell' && uHalf.cell === 'ok' && uOk.cell === 'ok' &&
      numFields.every(function (k) { return uBadNull[k] === -1 && uNoUsage[k] === -1; }) &&
      uNoTool.search === -1 && uNoTool.fetch === -1 && uNoTool.prompt === 63 &&
      uHalf.search === -1 && uHalf.fetch === 1 && uHalf.prompt === 4653 &&
      uOk.search === 2 && uOk.fetch === 1 && uOk.prompt === 4653 && uOk.completion === 410 && uOk.cached === 896 &&
      uNeg.prompt === -1 && uNeg.completion === -1,
    JSON.stringify({ cells: [uBadNull.cell, uNoUsage.cell, uNoTool.cell, uHalf.cell, uOk.cell, uNeg.cell], negPrompt: uNeg.prompt }));

  // ── ⑤ 对用户说话的那几句：各格不同，而且不许承诺「今天／最新／实时」─────────────
  // 实测（任务 #183，五发探针）：搜回来的答案分别说成 5月18日 / 7月6日 / 7月8日 / 7月14日 / 7月15日，
  // 而当天是 11 月 21 日 —— 所以任何一句界面话都不许把「刚查的」说成「今天的」。
  var sayDateBreak = function (s) {
    if (/实时|最新/.test(s)) return '承诺了「最新／实时」';
    if (/\d+月\d+日/.test(s)) return '写死了具体日期';
    if (/今天/.test(s) && !/不一定准|别拿它当/.test(s)) return '说了「今天」却没带更正';
    return '';
  };
  var spoken = [
    { k: 'bad-shape', t: WS.sentenceOf(uBadNull) },
    { k: 'no-usage', t: WS.sentenceOf(uNoUsage) },
    { k: 'no-tool-cell', t: WS.sentenceOf(uNoTool) },
    { k: '数字读不出', t: WS.sentenceOf(uNeg) },
    { k: 'ok', t: WS.sentenceOf(uOk) },
    { k: '半格', t: WS.sentenceOf(uHalf) }
  ];
  var popHintOff = (popSrc.match(/const PET_WEB_SEARCH_HINT_OFF = ["']([^"']*)["'];/) || [])[1] || '';
  var popHintUnknown = (popSrc.match(/textContent = ["']([^"']*)["'];\s*\n\s*els\.petWebSearchHint\.dataset\.cell = "unknown"/) || [])[1] || '';
  var popHintOn = (popSrc.match(/dataset\.cell = d\.cell;[\s\S]{0,240}?已生效[^;]*/) || [''])[0].replace(/^[\s\S]*?(?=已生效)/, '').replace(/;$/, '');
  var popHintBlocked = (popSrc.match(/dataset\.cell = d\.cell;[\s\S]{0,600}?这一枚暂时用不了[^;]*/) || [''])[0].replace(/^[\s\S]*?(?=这一枚)/, '').replace(/;$/, '');
  var htmlHint = (htmlSrc.match(/id="petWebSearchHint">([^<]*)</) || [])[1] || '';
  var spokenAll = spoken.concat([
    { k: 'popup off', t: popHintOff }, { k: 'popup unknown', t: popHintUnknown },
    { k: 'popup on', t: popHintOn }, { k: 'popup 灰掉', t: popHintBlocked }, { k: 'html 出厂', t: htmlHint }
  ]);
  var breakers = spokenAll.filter(function (r) { return sayDateBreak(r.t); })
    .map(function (r) { return r.k + '：' + sayDateBreak(r.t); });
  var distinctSpoken = spoken.map(function (r) { return r.t; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
  // 「开着、也确实问了，但服务端回包里没有搜索那一项」那句：口径是 libs 自己拼的
  // 「这次没有联网（…），按 N 个输入 token 计的」—— N 从 usageOf 读回来比，不在断言里抄第二个 63。
  var noToolSay = WS.sentenceOf(uNoTool);
  check('⑤ 说给用户的那 ' + spokenAll.length + ' 句里没有一句承诺日期或「最新／实时」（越界：' +
    (breakers.length ? breakers.join(' / ') : '0 处') + '），「今天」只许出现在带「不一定准」更正的那一句；' +
    'usage 那六句里读不出那两格（bad-shape 与 no-usage）**故意同一句**，其余各不相同，' +
    '而两句都明说「不代表没花钱」—— 不许把读不出说成没花；' +
    '「服务端没走搜索工具」那一格开头就说「这次没有联网」，并把读回来的输入 token 数原样带上',
    breakers.length === 0 && distinctSpoken.length === 5 &&
      WS.sentenceOf(uBadNull) === WS.sentenceOf(uNoUsage) &&
      /不代表没花钱/.test(WS.sentenceOf(uNoUsage)) && /不代表没花钱/.test(WS.sentenceOf(uNeg)) &&
      /^这次没有联网/.test(noToolSay) && noToolSay.indexOf('按 ' + uNoTool.prompt + ' 个输入 token') >= 0 &&
      /4653/.test(WS.sentenceOf(uOk)) &&
      /没数出查了几次/.test(WS.sentenceOf(uHalf)) && /比平时贵/.test(WS.sentenceOf(uOk)),
    JSON.stringify({ breakers: breakers, distinct: distinctSpoken.length,
      texts: spokenAll.map(function (r) { return r.k + '=' + String(r.t).slice(0, 30); }) }));

  // ── ⑥ 两处登记 + UMD 两条出口（漏一处不报错、不留日志，只是那一发压根没带搜索）────
  var man = null;
  try { man = JSON.parse(manSrc); } catch (e) { man = null; }
  var jsList = man && man.content_scripts && man.content_scripts[0] ? man.content_scripts[0].js : [];
  var libAt = htmlSrc.indexOf('../libs/web-search.js');
  var popAt = htmlSrc.indexOf('<script src="popup.js"');
  check('⑥ 两处登记都在，而且顺序对：manifest 的 content_scripts[0].js 里 libs/web-search.js 排在 content.js 之前' +
    '（下标 ' + jsList.indexOf('libs/web-search.js') + ' 对 ' + jsList.indexOf('content.js') + '），' +
    'popup.html 的 <script> 排在 popup.js 之前（字符位 ' + libAt + ' 对 ' + popAt + '）；' +
    'UMD 两条出口（node 的 module.exports 与浏览器全局 root.OmitoneWebSearch）各一条 —— 少一条就有一侧拿到 undefined',
    !!man && jsList.indexOf('libs/web-search.js') >= 0 &&
      jsList.indexOf('libs/web-search.js') < jsList.indexOf('content.js') &&
      jsList.indexOf('libs/diagnose.js') < jsList.indexOf('libs/web-search.js') &&
      libAt >= 0 && popAt >= 0 && libAt < popAt &&
      countStr(libSrc, 'module.exports = api') === 1 && countStr(libSrc, 'root.OmitoneWebSearch = api') === 1,
    JSON.stringify({ jsList: jsList, htmlLibAt: libAt, htmlPopAt: popAt }));

  // ── ⑦ 全仓只有一份判定：五个 needle 在生产文件里恒 0，在 libs 里（剥注释后）各 1 ────
  var prodFiles = ['popup/popup.js', 'content.js', 'background.js', 'popup/pet.js', 'popup/pet-game.js',
    'popup/popup.html', 'manifest.json'];
  try {
    prodFiles = prodFiles.concat(fs.readdirSync(path.join(ROOT, 'src', 'page'))
      .filter(function (f) { return /\.js$/.test(f); }).map(function (f) { return 'src/page/' + f; }));
  } catch (e) { /* 读不到目录就在下面那一格里红出来 */ }
  var needles = ['deepseek_web_search', 'function decisionOf', 'tools:', "'" + OFFICIAL + "'", '"' + OFFICIAL + '"'];
  var libCode = stripComments(libSrc);
  var hits = [];
  prodFiles.forEach(function (rel) {
    var src = read(rel);
    if (!src) { hits.push(rel + ' 读不到'); return; }
    needles.forEach(function (n) { if (countStr(src, n) > 0) hits.push(rel + ' 含 ' + n); });
  });
  // 「剥」这一手自己的自证：等长、且确实把文档注释里那一处摘掉了（原文 2 处，剥后 1 处）
  var libDecls = {
    tool: countStr(libCode, 'deepseek_web_search'),
    ruler: countStr(libCode, 'function decisionOf'),
    host: countStr(libCode, "'" + OFFICIAL + "'"),
    rawTool: countStr(libSrc, 'deepseek_web_search')
  };
  check('⑦ 全仓只有一份判定：' + prodFiles.length + ' 个生产文件（含 src/page 那 ' +
    (prodFiles.length - 7) + ' 段）里五个字面量命中 ' + hits.length + ' 处；libs 剥注释后 tools 声明、decisionOf 声明、' +
    '官方域字面量各恰好 1 份 —— 并钉「剥」自己在承重（等长 ' + (libSrc.length === libCode.length) +
    '，原文 ' + libDecls.rawTool + ' 处对剥后 ' + libDecls.tool + ' 处，摘掉的正是文档表格里那一处）',
    hits.length === 0 && prodFiles.length >= 20 &&
      libDecls.tool === 1 && libDecls.ruler === 1 && libDecls.host === 1 &&
      libSrc.length === libCode.length && libDecls.rawTool === libDecls.tool + 1,
    JSON.stringify({ files: prodFiles.length, hits: hits, lib: libDecls, len: [libSrc.length, libCode.length] }));

  // ── ⑧ 三处出口都问同一把尺（而不是各自再写一份域名判定）───────────────────────
  var exits = [
    { n: 'popup buildPetChatRequest', b: topFn(popSrc, 'buildPetChatRequest') },
    { n: 'popup petWebSearchDecision', b: topFn(popSrc, 'petWebSearchDecision') },
    { n: 'content doctorWebSearch', b: topFn(conSrc, 'doctorWebSearch') },
    { n: 'content doctorAskModel', b: topFn(conSrc, 'doctorAskModel') }
  ];
  var exitMiss = exits.filter(function (x) { return !x.b; }).map(function (x) { return x.n; });
  var exitBad = exits.filter(function (x) {
    return !!x.b && !(countStr(x.b, 'decisionOf(') + countStr(x.b, 'toolsFor(') > 0);
  }).map(function (x) { return x.n; });
  var exitOwnRuler = exits.filter(function (x) {
    return !!x.b && countStr(x.b, OFFICIAL) > 0;
  }).map(function (x) { return x.n; });
  check('⑧ 三处花钱出口（弹窗聊天／弹窗解释共用 buildPetChatRequest、界面灰不灰走 petWebSearchDecision、' +
    '上课页医生走 doctorWebSearch + doctorAskModel）四个函数体都从盘上取出、都真问 libs 的 decisionOf 或 toolsFor，' +
    '而且体内**没有一份自己的官方域字面量**（自己写一份就是第二把尺，AGENTS §2 #4 / #18）；' +
    '取不出函数体的话这一格只报「没取到」，不许当「通过」',
    exitMiss.length === 0 && exitBad.length === 0 && exitOwnRuler.length === 0 &&
      countStr(exits[3].b, 'doctorWebSearch(') >= 1,
    JSON.stringify({ missing: exitMiss, noAsk: exitBad, ownRuler: exitOwnRuler }));

  // ── ⑨ 键名只有一份、默认关四处齐、三态不许被 !! 压平 ───────────────────────
  var conKey = (conSrc.match(/const PAGE_WEB_SEARCH_KEY = ["']([^"']+)["']/) || [])[1] || '';
  var defaultsAt = popSrc.indexOf('const DEFAULTS = {');
  var defaultsEnd = popSrc.indexOf('\n};', defaultsAt);
  var defaultsSeg = defaultsAt < 0 || defaultsEnd < 0 ? '' : popSrc.slice(defaultsAt, defaultsEnd);
  var readAt = popSrc.indexOf('chrome.storage.local.get("' + conKey + '"');
  var readSeg = readAt < 0 ? '' : popSrc.slice(readAt, readAt + 260);
  // 出厂那一格钉在**开关自己那一个标签**上：按固定字符窗往两侧扩会量不稳（第一版扩到 +120
  // 就正好把 id="petWebSearchEnabled" 切在窗外，红成「没有 aria-checked=false」，真相是尺没够长）
  var swId = 'id="petWebSearchEnabled"';
  var swAt = htmlSrc.indexOf(swId);
  var swTag = swAt < 0 ? '' : htmlSrc.slice(htmlSrc.lastIndexOf('<', swAt), htmlSrc.indexOf('>', swAt));
  var c9 = {
    keyOk: conKey === 'omitonePetWebSearchOn',
    inContent: countStr(conSrc, conKey),
    declareContent: countStr(conSrc, 'const PAGE_WEB_SEARCH_KEY'),
    inPopup: countStr(popSrc, conKey),
    defaultsRead: defaultsAt >= 0 && defaultsEnd > defaultsAt,
    inDefaults: countStr(defaultsSeg, conKey),
    idCells: countStr(htmlSrc, swId),
    ariaOff: /aria-checked="false"/.test(swTag),
    resetZero: countStr(popSrc, 'chrome.storage.local.set({ ' + conKey + ': 0 })'),
    writeOneZero: countStr(popSrc, 'chrome.storage.local.set({ ' + conKey + ': value ? 1 : 0 }'),
    triState: readSeg.indexOf('raw === 1 || raw === true') >= 0,
    noFlatten: countStr(popSrc, 'petWebSearchVal = !!')
  };
  check('⑨ 存储键 `' + conKey + '` 全仓只有一份写法（content.js 声明 1 处、popup.js 引用 ' + c9.inPopup +
    ' 处、两边逐字相同），而且四处「默认关」都在：DEFAULTS 段里根本没有这一枚（' + c9.inDefaults +
    '）、开关自己那一个标签里 aria-checked=false、恢复默认显式写 0、写入口只落 1/0 —— ' +
    '会花钱的功能不许被默认值补成开（AGENTS §2 #23 同族：两侧基准不同就恒对不上）',
    c9.keyOk && c9.inContent >= 1 && c9.declareContent === 1 && c9.inPopup === 4 &&
      c9.defaultsRead && c9.inDefaults === 0 && c9.idCells === 1 && c9.ariaOff &&
      c9.resetZero === 1 && c9.writeOneZero === 1 && readAt >= 0 && c9.triState && c9.noFlatten === 0,
    JSON.stringify({ key: conKey, cells: c9, swTag: swTag.slice(0, 120), readSeg: readSeg.slice(0, 120) }));
}

/**
 * 会话任务 #184（批次 165）：被平台判「已结束」的问卷，那本记账以前活不过一次刷新。
 *
 * 现场症状是「刷完一门不换下一门」，链条是三件事叠出来的：
 *   ① 次数账 `_voteTryMap` 只在页面内存里 → 整页刷新归零 → 「4 发预算 + 30 分钟冷却」
 *      结构上永远走不完一轮（用完→刷新→归零→再用完）；
 *   ② 投票交不出任何「放弃」证据 → 读取侧那道 `skip task point in give-up list` 对它形同不存在；
 *   ③ 于是每一轮撞同一份问卷、进度键每轮换格 → `noop.rounds` 永远攒不满 → 换课判据永久进不来。
 * 修法是把**数满那一发的证据交给已有的 24 小时跳过名单**（不新造一本账），
 * 并让 `cool` 取两侧较大者（现场同一份问卷的两种失败形状会交替出现）。
 *
 * 三条成因各占一格，反向验证一刀只摘一层。
 */
async function testVoteEndedParkPersistent() {
  console.log('\n[34] 已结束问卷的记账：数满预算那一发交给 24 小时跳过名单，扛得住一次刷新（会话任务 #184）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var run = read('src/page/62-tasks-run.js');
  var loop = read('src/page/64-tasks-loop.js');
  var dom = read('src/page/20-dom.js');
  var cons = read('src/page/00-shell-constants.js');
  var state = read('src/page/10-config-state.js');
  var detect = read('src/page/60-tasks-detect.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) at = src.indexOf(name + ': async function');
    if (at < 0) return { start: -1, end: -1 };
    var fnAt = src.indexOf('function', at);
    // ⚠️ `async` 必须一起带走：从 `function` 起切出来重建的是普通函数，
    //   而 `_runChaoxingVoteJob` 体里有 `await` —— 当场 SyntaxError（实测）
    var start = src.slice(fnAt - 6, fnAt) === 'async ' ? fnAt - 6 : fnAt;
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };
  // 三个数从真源读回来，不在测试里抄一遍（AGENTS §5「断言里出现的每一个数，都要说得出它是从哪读回来的」）
  var constNum = function (src, name) {
    var m = new RegExp('var ' + name + '\\s*=\\s*([^;]+);').exec(src);
    if (!m) return -1;
    var v = -1;
    try { v = Number(Function('return (' + m[1] + ');')()); } catch (e) { v = -1; }
    return (isFinite(v) && v > 0) ? v : -1;
  };
  var countStr = function (hay, needle) {
    var n = 0, at = 0;
    while ((at = hay.indexOf(needle, at)) >= 0) { n++; at += needle.length; }
    return n;
  };
  var indexes = function (hay, needle) {
    var out = [], at = 0;
    while ((at = hay.indexOf(needle, at)) >= 0) { out.push(at); at += needle.length; }
    return out;
  };

  var MAX = constNum(cons, 'VOTE_MAX_TRIES');
  var COOL = constNum(cons, 'VOTE_COOLDOWN_MS');
  var ENDED = constNum(cons, 'VOTE_ENDED_COOLDOWN_MS');
  var skm = /_taskGiveUpStoreKey:\s*'([^']+)'/.exec(state);
  var STORE_KEY = skm ? skm[1] : '';

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
  var resetLogs = function () { logs.length = 0; };
  var saidOf = function (msg) {
    return logs.filter(function (l) { return l.message === msg; }).length;
  };
  var lastSaid = function (msg) {
    var hit = logs.filter(function (l) { return l.message === msg; });
    return hit.length ? hit[hit.length - 1] : null;
  };

  var injVote = {
    emitRuntimeLog: say,
    VOTE_MAX_TRIES: MAX,
    VOTE_COOLDOWN_MS: COOL,
    VOTE_ENDED_COOLDOWN_MS: ENDED
  };

  var voteJob = buildFrom(run, '_runChaoxingVoteJob', injVote);
  var noteTry = buildFrom(run, '_noteVoteTry', injVote);
  var clearTry = buildFrom(run, '_clearVoteTry', injVote);
  var cooledDown = buildFrom(run, '_voteTryCooledDown', injVote);
  var tryKeyOf = buildFrom(run, '_voteTryKeyOf', {});
  var overlayForm = buildFrom(run, '_voteOverlayForm', {});
  var overlayEnded = buildFrom(run, '_voteOverlayEnded', {});
  var pickOptions = buildFrom(run, '_pickVoteOptions', {});
  var safeParse = buildFrom(dom, '_safeJsonParse', {});
  var pointKey = buildFrom(loop, '_taskPointKey', {});

  // 「盘」那一格：MV3 页面里的 localStorage 在 node 里没有，`_taskGiveUpMap` 的 try/catch
  // 会把"没有盘"读成"名单是空的"（症状与"确实没落盘"一模一样）。所以这里给一枚真的假盘，
  // 并且**每一场自己换一枚** —— 「刷新之后」= 新 app 实例 + 同一枚盘。
  var current = null;
  var ls = {
    getItem: function (k) { return current && current.data[k] !== undefined ? current.data[k] : null; },
    setItem: function (k, v) { if (current) current.data[k] = String(v); },
    removeItem: function (k) { if (current) delete current.data[k]; }
  };
  var giveUpMap = buildFrom(loop, '_taskGiveUpMap', { localStorage: ls });
  var giveUpTtl = readProductConstant(read('src/page/00-shell-constants.js'), 'TASK_GIVEUP_TTL_MS');
  var isGivenUp = buildFrom(loop, '_isTaskGivenUp', { localStorage: ls, TASK_GIVEUP_TTL_MS: giveUpTtl });
  var markGivenUp = buildFrom(loop, '_markTaskGivenUp', { localStorage: ls });

  var mkStore = function () {
    var box = { data: Object.create(null) };
    current = box;
    return box;
  };

  var mkNoCheckInput = function () {
    var el = {
      name: 'answer8000083064', type: 'radio', disabled: false, value: 'A',
      click: function () {}, closest: function () { return { tagName: 'LI' }; }
    };
    // 点了也不勾：站点那种被禁用作答的选项就是这个形状
    Object.defineProperty(el, 'checked', { get: function () { return false; }, set: function () {} });
    return el;
  };
  var mkDoc = function (inputs, cands) {
    return {
      querySelectorAll: function (sel) {
        var s = String(sel || '');
        if (s.indexOf('radio') >= 0 || s.indexOf('checkbox') >= 0) return inputs.slice();
        if (s.indexOf('btn-submit') >= 0) return cands.slice();
        return [];
      }
    };
  };
  var SHAPES = {
    ended: { text: '本次问卷调查已被手动结束，无法作答。', inputs: [], cands: [] },
    'no-form': { text: '本次问卷暂无可选项。', inputs: [], cands: [] },
    'no-check': { text: '请选择一个选项后提交。', inputs: [mkNoCheckInput], cands: [{ innerText: '提交', className: 'btn-submit', value: '' }] },
    overlay: { text: '', doc: null }
  };

  var mkApp = function (box, kind) {
    current = box;
    var spec = SHAPES[kind];
    var app = {
      configs: { enableVote: true },
      _voteTryMap: {},
      _taskGiveUpStoreKey: STORE_KEY,
      _safeJsonParse: safeParse,
      _taskPointKey: pointKey,
      _taskGiveUpMap: giveUpMap,
      _isTaskGivenUp: isGivenUp,
      _markTaskGivenUp: markGivenUp,
      _voteTryKeyOf: tryKeyOf,
      _noteVoteTry: noteTry,
      _clearVoteTry: clearTry,
      _voteTryCooledDown: cooledDown,
      _voteOverlayForm: overlayForm,
      _voteOverlayEnded: overlayEnded,
      _pickVoteOptions: pickOptions,
      _voteBoxFinished: function () { return false; },
      _closeVoteOverlay: function () { app.__closed++; },
      __closed: 0,
      // 桩打在「那个会把覆盖层收掉的动作」与「那份文档」上，判定谓词（ended / form / pick）全是生产代码
      _voteOverlayText: function () { return spec.text; },
      _openVoteOverlay: function () {
        if (kind === 'overlay') return Promise.resolve(null);
        if (!app.__doc) {
          var ins = spec.inputs.map(function (f) { return typeof f === 'function' ? f() : f; });
          app.__doc = mkDoc(ins, spec.cands);
        }
        return Promise.resolve(app.__doc);
      }
    };
    return app;
  };

  // 合成夹具号（AGENTS §28-B：真实课程痕迹不进公开面）
  var JOB = {
    kind: 'vote', workType: 'job', jobid: '9000123456',
    attachment: { property: {} }, name: '问卷 A（合成夹具）'
  };
  var EXPECT_KEY = 'job:' + JOB.jobid;
  var GATE_SHAPE = { jobid: JOB.jobid, attachment: JOB.attachment, name: JOB.name };

  var parts = [voteJob, noteTry, clearTry, cooledDown, tryKeyOf, overlayForm, overlayEnded, pickOptions,
    safeParse, pointKey, giveUpMap, isGivenUp, markGivenUp];
  var extracted = parts.every(function (f) { return typeof f === 'function'; }) &&
    MAX > 0 && COOL > 0 && ENDED > 0 && !!STORE_KEY;
  check('① 十三件都能从盘上原样取出来真跑，三个数与那枚存储键也从真源读回来（不是抄进测试）—— '
    + '取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样',
    extracted,
    JSON.stringify({
      fns: parts.map(function (f) { return typeof f; }).join('/'),
      max: MAX, cool: COOL, ended: ENDED, storeKey: STORE_KEY
    }));
  if (!extracted) return;

  // ---- 成因②：同一份问卷的两种失败形状交替时，30 分钟那一格不能被覆盖成 0 ----
  var box2 = mkStore();
  var app2 = mkApp(box2, 'ended');
  resetLogs();
  var firstRec = noteTry.call(app2, JOB, 'ended', ENDED);
  var secondRec = noteTry.call(app2, JOB, 'no-check');
  for (var i2 = 2; i2 < MAX; i2++) noteTry.call(app2, JOB, 'no-check');
  var mixedCooled = cooledDown.call(app2, JOB);

  var app2b = mkApp(mkStore(), 'no-check');
  for (var j2 = 0; j2 < MAX; j2++) noteTry.call(app2b, JOB, 'no-check');
  var plainCooled = cooledDown.call(app2b, JOB);

  check('② `cool` 取**两侧较大者**：认成「已结束」之后下一拍换成不带 override 的失败形状，'
    + '30 分钟那一格照旧在 —— 旧写法把它覆盖成 0，日志那句「30 分钟后还会再点开」就成了假话'
    + '（两种形状交替恰是现场实测到的形状）',
    firstRec.cool === ENDED && secondRec.cool === ENDED && secondRec.n === 2 &&
      !!mixedCooled && mixedCooled.coolMs === ENDED && mixedCooled.retryInMs <= ENDED &&
      mixedCooled.tries === MAX,
    JSON.stringify({
      firstCool: firstRec.cool, secondCool: secondRec.cool, secondN: secondRec.n,
      mixed: mixedCooled && { tries: mixedCooled.tries, coolMs: mixedCooled.coolMs, retryInMs: mixedCooled.retryInMs },
      ENDED: ENDED
    }));

  check('②b 反过来也钉住：**从没认出「已结束」的问卷仍是默认那一档** —— '
    + '把 max 写成「永远取长的」等于给每种失败形状都放 30 分钟假冷却（AGENTS §5「会误报的守卫和没有守卫一样害人」）',
    !!plainCooled && plainCooled.coolMs === COOL,
    JSON.stringify({ plain: plainCooled && { coolMs: plainCooled.coolMs, tries: plainCooled.tries }, COOL: COOL }));

  // ---- 成因①：落盘排在数满那一发，不是第一发 ----
  var box3 = mkStore();
  var app3 = mkApp(box3, 'ended');
  resetLogs();
  for (var i3 = 0; i3 < MAX - 1; i3++) await voteJob.call(app3, JOB);
  var map3 = giveUpMap.call(app3);
  check('③ 前 ' + (MAX - 1) + ' 发只记在页面内存里、盘上那本名单**一个键都没有** —— '
    + '第一发就落盘会把「老师过会儿重新开放」那一族永久挡在门外（24 小时投不进去）',
    Object.keys(map3).length === 0 && saidOf('vote survey closed') === MAX - 1 &&
      saidOf('vote survey closed, parked 24h') === 0,
    JSON.stringify({
      mapKeys: Object.keys(map3), closed: saidOf('vote survey closed'),
      parked: saidOf('vote survey closed, parked 24h'), memN: (function () {
        var rec = app3._voteTryMap[tryKeyOf.call(app3, JOB)];
        return rec ? rec.n : 0;
      })()
    }));

  // ---- 成因①+③：数满那一发把证据交给已有的持久名单，并说清怎么恢复 ----
  var box4 = mkStore();
  var app4 = mkApp(box4, 'ended');
  resetLogs();
  for (var i4 = 0; i4 < MAX; i4++) await voteJob.call(app4, JOB);
  var map4 = giveUpMap.call(app4);
  var park4 = map4[EXPECT_KEY] || null;
  var parkedSaid = lastSaid('vote survey closed, parked 24h');
  var closedSaid = lastSaid('vote survey closed');
  check('④ 第 ' + MAX + ' 发认成「已结束」时，证据交给**已有的** 24 小时跳过名单：键是 `job:<jobid>`、'
    + 'reason 点名 vote-ended、attempts 等于预算，而且两句话并存 —— 30 分钟那句照旧说（还没落盘之前它是真话），'
    + '新那句必须讲清 24 小时 + 两个恢复出口（AGENTS §2 #7：跳过必须留日志且可恢复）',
    Object.keys(map4).length === 1 && !!park4 && park4.reason === 'vote-ended' &&
      Number(park4.attempts) === MAX && String(park4.name || '').length > 0 &&
      saidOf('vote survey closed, parked 24h') === 1 && saidOf('vote survey closed') === MAX &&
      !!parkedSaid && parkedSaid.meta.key === EXPECT_KEY && Number(parkedSaid.meta.tries) === MAX &&
      /24 小时/.test(parkedSaid.meta.hint) && /clearTaskGiveUp/.test(parkedSaid.meta.hint) &&
      /已完成任务重学/.test(parkedSaid.meta.hint) &&
      !!closedSaid && closedSaid.meta.retryInMs === ENDED,
    JSON.stringify({
      keys: Object.keys(map4), rec: park4, closedCount: saidOf('vote survey closed'),
      parkedMeta: parkedSaid && parkedSaid.meta, retryInMs: closedSaid && closedSaid.meta.retryInMs
    }));

  // ---- 键必须与读取侧那道闸同源，而且扛得住一次刷新 ----
  var fresh4 = mkApp(box4, 'ended');          // 新实例 = 整页刷新之后
  var gateKey = pointKey.call(fresh4, GATE_SHAPE);
  var gateKeyRenamed = pointKey.call(fresh4, { jobid: JOB.jobid, attachment: JOB.attachment, name: '换了个卷名' });
  var bareKey = tryKeyOf.call(fresh4, JOB);
  var survived = isGivenUp.call(fresh4, gateKey);
  var bareHit = isGivenUp.call(fresh4, bareKey);
  var memAfterReload = Object.keys(fresh4._voteTryMap).length;
  check('⑤ 写入口与读出口过**同一把尺**：读取侧那句原样（`_taskPointKey({jobid, attachment, name})`）算出的键，'
    + '与新实例（= 刷新之后，内存那本账是空的）读回的名单对上；卷名换了也不改键（键认 jobid 不认文案）；'
    + '而投票次数账那个裸 `jobid` **不算**键 —— 新造一本账或两套键，这道闸就永远走不到',
    gateKey === EXPECT_KEY && gateKey === gateKeyRenamed && gateKey === Object.keys(map4)[0] &&
      survived === true && memAfterReload === 0 && bareHit === false && bareKey !== EXPECT_KEY,
    JSON.stringify({
      gateKey: gateKey, gateKeyRenamed: gateKeyRenamed, bareKey: bareKey,
      survived: survived, bareHit: bareHit, memKeysAfterReload: memAfterReload, stored: Object.keys(map4)
    }));

  // ---- 阴性对照：三种"投不出去"的形状都不许落盘，冷却到期照旧再试 ----
  var controlCells = {};
  var controlKinds = ['no-form', 'no-check', 'overlay'];
  for (var c4 = 0; c4 < controlKinds.length; c4++) {
    var kindC = controlKinds[c4];
    var boxC = mkStore();
    var appC = mkApp(boxC, kindC);
    resetLogs();
    for (var i5 = 0; i5 < MAX; i5++) await voteJob.call(appC, JOB);
    var mapC = giveUpMap.call(appC);
    var cooledC = cooledDown.call(appC, JOB);
    // 把「上一次」往前拨过冷却：到期必须放行，不许实现成永久跳过
    var recC = appC._voteTryMap[tryKeyOf.call(appC, JOB)];
    if (recC) recC.at = Date.now() - COOL - 1000;
    var afterC = cooledDown.call(appC, JOB);
    controlCells[kindC] = {
      keys: Object.keys(mapC).length,
      parked: saidOf('vote survey closed, parked 24h'),
      gateHit: isGivenUp.call(appC, GATE_SHAPE),
      coolMs: cooledC ? cooledC.coolMs : -1,
      retryAfterCool: afterC === null
    };
  }
  check('⑥ 三种失败形状（没选项也没提交键 / 点了不勾 / 覆盖层压根开不出来）数满预算**都不落盘**，'
    + '拿到的仍是默认那一档冷却、到期就放行 —— 落盘只认「平台自己说这场已结束」那一句，'
    + '把别的形状一起永久跳过就是把还能投的问卷判死',
    controlKinds.every(function (k) {
      var cell = controlCells[k];
      return cell.keys === 0 && cell.parked === 0 && cell.gateHit === false &&
        cell.coolMs === COOL && cell.retryAfterCool === true;
    }),
    JSON.stringify({ cells: controlCells, COOL: COOL }));

  // ---- 不新造一本账 + 只有一处写入口（按字符偏移判，别按行算）----
  var directLs = countStr(run, 'localStorage.getItem') + countStr(run, 'localStorage.setItem') +
    countStr(run, 'localStorage.removeItem');
  var markSites = indexes(run, 'this._markTaskGivenUp(');
  var endedAt = run.indexOf('if (!form.firsts.length && this._voteOverlayEnded(form.text))');
  var nextAt = run.indexOf('if (!form.firsts.length && !form.submit)');
  var insideEnded = markSites.length === 1 && endedAt >= 0 && nextAt > endedAt &&
    markSites[0] > endedAt && markSites[0] < nextAt;
  var newLedger = countStr(run, 'omitone_vote') + countStr(cons, 'omitone_vote');
  var readGate = countStr(detect, 'this._isTaskGivenUp(this._taskPointKey(');
  check('⑦ 记账只走已有的那本账：62 片段里对 localStorage 直接动手 0 处、没有任何 `omitone_vote` 那样的新存储键、'
    + '`_markTaskGivenUp` 在投票这一族只有一个调用点且落在 ended 那一支之内（按字符偏移判），'
    + '而读取侧那道闸仍然是 `_isTaskGivenUp(this._taskPointKey(...))` 这一句原样 —— '
    + '写入口改了、读出口没改，症状与改之前一模一样，而且一条报错都不留（AGENTS §2 #18）',
    directLs === 0 && newLedger === 0 && insideEnded && readGate === 1,
    JSON.stringify({ directLs: directLs, markSites: markSites, endedAt: endedAt, nextAt: nextAt, newLedger: newLedger, readGate: readGate }));
}

async function testMediaRecoveryExhaustion() {
  var read = function (file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); };
  var media = read('src/page/40-media.js');
  var loop = read('src/page/64-tasks-loop.js');
  var tasks = read('src/page/62-tasks-run.js');
  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) at = src.indexOf(name + ': async function');
    if (at < 0) return { start: -1, end: -1 };
    var fnAt = src.indexOf('function', at);
    var start = src.slice(fnAt - 6, fnAt) === 'async ' ? fnAt - 6 : fnAt;
    return { start: start, end: src.indexOf('\n    },', start) };
  };
  var buildFrom = function (src, name, env) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(env || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return env[k]; }));
  };
  var firstNum = function (src, re) {
    var hit = src.match(re);
    return hit ? Number(hit[1]) : NaN;
  };
  var limitR = firstNum(read('src/page/00-shell-constants.js'), /MEDIA_RELOAD_LIMIT\s*=\s*(\d+)/);
  var ttlR = readProductConstant(read('src/page/00-shell-constants.js'), 'TASK_GIVEUP_TTL_MS');
  var mediaNames = ['_isMediaQuarantined', '_quarantineDeadMedia', '_clearMediaPendingState',
    '_isActiveMediaPending', '_isVisibleMedia', '_getVideoEl', '_reloadMediaInPlace', '_evictOldestKeys',
    '_handleVideoEnded',
    '_handleVideoLoaded', '_startSlideMedia', '_waitSlideAudioDone', '_ensurePlaybackRate',
    '_scheduleMaxRateDetection', '_rearmMediaGuardIfLost'];
  var loopNames = ['_taskPointKey', '_taskGiveUpMap', '_isTaskGivenUp', '_markTaskGivenUp', '_clearTaskGiveUp'];
  var missing = mediaNames.concat(loopNames, ['_runPptAudioJob']).filter(function (name) {
    var src = name === '_runPptAudioJob' ? tasks : (loopNames.indexOf(name) >= 0 ? loop : media);
    return boundsOf(src, name).start < 0;
  });
  check('177-0：生产方法、三次上限与 24 小时窗口都从源码取到',
    !missing.length && limitR === 3 && ttlR === 24 * 3600 * 1000,
    JSON.stringify({ missing: missing, limit: limitR, ttl: ttlR }));
  if (missing.length || limitR !== 3 || ttlR !== 24 * 3600 * 1000) return;

  var storage = {};
  var localStorage = {
    getItem: function (key) { return storage[key] === undefined ? null : storage[key]; },
    setItem: function (key, value) { storage[key] = String(value); },
    removeItem: function (key) { delete storage[key]; }
  };
  var logs = [];
  var env = {
    MEDIA_RELOAD_LIMIT: limitR,
    TASK_GIVEUP_TTL_MS: ttlR,
    localStorage: localStorage,
    emitRuntimeLog: function (level, message, meta) { logs.push({ level: level, message: message, meta: meta || {} }); },
    visible: function (el) { return !!(el && el._visible !== false); },
    document: {},
    window: {},
    sleep: function () { return Promise.resolve(); }
  };
  var fns = {};
  mediaNames.forEach(function (name) { fns[name] = buildFrom(media, name, env); });
  loopNames.forEach(function (name) { fns[name] = buildFrom(loop, name, env); });
  fns._runPptAudioJob = buildFrom(tasks, '_runPptAudioJob', env);

  var mkMedia = function (key, tag, code) {
    var listeners = Object.create(null);
    var media = {
      key: key, tagName: tag || 'VIDEO', isConnected: true, paused: false, ended: false,
      readyState: 4, networkState: 1, duration: 100, currentTime: 42, currentSrc: '',
      src: '', playbackRate: 1, defaultPlaybackRate: 1, muted: false,
      error: code ? { code: code, message: 'FFmpegDemuxer: data source error' } : null,
      loads: 0, plays: 0, pauses: 0, rateCalls: 0, listeners: listeners,
      addEventListener: function (type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      removeEventListener: function () {},
      load: function () { this.loads++; },
      play: function () { this.plays++; return Promise.resolve(); },
      pause: function () { this.pauses++; this.paused = true; }
    };
    return media;
  };
  var mkDoc = function (medias) {
    return {
      body: {},
      querySelectorAll: function (selector) {
        if (selector === 'video, audio' || selector === 'audio, video') return medias;
        return [];
      },
      querySelector: function (selector) { return selector === '.swiper-container' ? {} : null; }
    };
  };
  var mkApp = function (doc) {
    var app = {
      configs: { documentSkipTimeoutMs: 120000, muted: false, autoMaxPlaybackRate: false,
        playbackRateCap: 4, pptFlipIntervalMs: 1 },
      _taskGiveUpStoreKey: 'omitone_task_giveup', _taskAttempts: {}, _taskProgress: null,
      _mediaQuarantine: new WeakMap(), _mediaReloadKeys: Object.create(null),
      _videoEl: null, _videoCount: 0, _currentVideoIndex: 0, _isPlaying: false,
      _activeMediaJobPending: false, _activeMediaJobManaged: false, _activeDocumentJobPending: false,
      _activeDocumentJobManaged: false, _checkInterval: null, _mediaWaitLogAt: 0,
      _mediaNoSourceSince: 0, _mediaBrokenSince: 0, _guardLastTime: 0, _guardLastWallTs: 0,
      _guardLastResumeTs: 0, _resumeWindowStart: 0, _resumeAttemptCount: 0,
      _detectedMaxRate: 0, _rateDetectVideo: null, _rateDetectBusy: false, _rateProbing: false,
      _rateUnknownVideo: null, _rateUnknownTries: 0, _rateLockedBy: '', _rateEpoch: 0,
      finishCalls: 0, nextCalls: 0, clearChecks: 0, guardStarts: 0, resumeCalls: 0,
      rateCalls: 0, unreadableCalls: 0, resetRateCalls: 0, seekCalls: 0,
      doc: doc,
      _safeJsonParse: function (raw) { try { return JSON.parse(raw); } catch (e) { return null; } },
      _getMainDocument: function () { return this.doc; },
      _getMediaSeekKey: function (el) { return el && el.key || ''; },
      _mediaErrorCode: function (el) { return Number(el && el.error && el.error.code || 0); },
      _clearCheckInterval: function () { this.clearChecks++; this._checkInterval = null; },
      _shouldReleaseMediaPendingForCurrentCompletion: function () { return false; },
      _scanForeignExtensionArtifacts: function () { return { state: 'none', ids: [] }; },
      _siteSaysUnplayable: function () { return { state: 'absent', quote: '' }; },
      _noteForeignExtensionHint: function () {},
      _ensurePlaybackRate: function () { this.rateCalls++; },
      _tryResumePlayback: function () { this.resumeCalls++; },
      _startVideoMonitoring: function () { this.guardStarts++; },
      _finishCurrentMedia: function () { this.finishCalls++; },
      nextUnit: function () { this.nextCalls++; },
      _tickProgress: function () {},
      _assertActive: function () { return true; },
      _clearDocumentPendingState: function (reason) { this.documentClearReason = reason; },
      _resetRateDetection: function () { this.resetRateCalls++; },
      _trySeekToEnd: function () { this.seekCalls++; },
      _noteCourseGuard: function () {}, _clearCourseGuard: function () {},
      _noteRateUnreadable: function () { this.unreadableCalls++; }
    };
    mediaNames.concat(loopNames, ['_runPptAudioJob']).forEach(function (name) { app[name] = fns[name]; });
    return app;
  };
  var flush = async function () {
    for (var i = 0; i < 8; i++) await new Promise(function (resolve) { setTimeout(resolve, 0); });
  };

  var bad = mkMedia('bad-177', 'VIDEO', 2);
  var healthy = mkMedia('healthy-177', 'VIDEO', 2);
  var job = { jobid: 'job-177', attachment: { property: { module: 'video' } }, name: '坏媒体任务点' };
  var doc = mkDoc([bad, healthy]);
  var app = mkApp(doc);
  app._videoEl = bad;
  app._activeMediaJobPending = true;
  app._isPlaying = true;
  app._mediaBrokenSince = Date.now() - 120001;
  app._mediaReloadKeys[bad.key] = { n: 3, at: Date.now() - 20001 };
  app._mediaQuarantine.set(bad, { job: job });
  var pending = app._isActiveMediaPending('media-pending');
  var writeKey = app._taskPointKey(job);
  var readerKey = app._taskPointKey({ jobid: job.jobid, attachment: job.attachment, name: job.name });
  var givenUp = app._isTaskGivenUp(readerKey);
  check('177-1：三次耗尽后 pending 松开、精确元素隔离、任务键与读侧逐字相等',
    pending === false && app._activeMediaJobPending === false && app._isPlaying === false &&
    app._videoEl === null && app._isMediaQuarantined(bad) && writeKey === readerKey && givenUp === true,
    JSON.stringify({ pending: pending, active: app._activeMediaJobPending, playing: app._isPlaying,
      cached: !!app._videoEl, quarantined: app._isMediaQuarantined(bad), writeKey: writeKey,
      readerKey: readerKey, givenUp: givenUp }));
  check('177-2：放手不伪造平台完成，也不自行翻到下一节',
    app.finishCalls === 0 && app.nextCalls === 0,
    JSON.stringify({ finishCalls: app.finishCalls, nextCalls: app.nextCalls }));

  var picked = app._getVideoEl();
  check('177-3：释放后重扫不再拿回同一坏视频，健康媒体仍可选中',
    picked === healthy && app._videoEl === healthy,
    JSON.stringify({ picked: picked && picked.key, cached: app._videoEl && app._videoEl.key }));
  var hiddenBad = mkMedia('hidden-bad-177', 'AUDIO', 2);
  var hiddenHealthy = mkMedia('hidden-healthy-177', 'AUDIO', 0);
  hiddenBad._visible = false;
  hiddenHealthy._visible = false;
  var hiddenApp = mkApp(mkDoc([hiddenBad, hiddenHealthy]));
  hiddenApp._mediaQuarantine.set(hiddenBad, { job: job, quarantined: Date.now() });
  var hiddenPicked = hiddenApp._getVideoEl();
  check('177-4：隐藏音频兜底也排除已隔离元素',
    hiddenPicked === hiddenHealthy && hiddenApp._videoEl === hiddenHealthy,
    JSON.stringify({ picked: hiddenPicked && hiddenPicked.key }));

  app._mediaReloadKeys[healthy.key] = { n: 2, at: Date.now() - 20001 };
  var healthyReload = app._reloadMediaInPlace(healthy, 'case');
  var healthyLoads = healthy.loads;
  app._mediaReloadKeys[healthy.key].at = Date.now() - 20001;
  var fourthHealthy = app._reloadMediaInPlace(healthy, 'case');
  var badReload = app._reloadMediaInPlace(bad, 'case');
  check('177-5：健康元素保留独立三次预算，两枚都不产生第四次恢复',
    healthyReload === true && app._mediaReloadKeys[healthy.key].n === 3 &&
    fourthHealthy === false && healthy.loads === healthyLoads && badReload === false,
    JSON.stringify({ healthyReload: healthyReload, n: app._mediaReloadKeys[healthy.key].n,
      fourthHealthy: fourthHealthy, badReload: badReload, healthyLoads: healthy.loads }));

  var firstAt = app._taskGiveUpMap()[readerKey].at;
  var warnCount = logs.filter(function (line) { return line.message === 'media recovery exhausted, element quarantined'; }).length;
  app._quarantineDeadMedia(bad, { job: job, reloadTimes: 3, currentTime: 99 });
  var secondAt = app._taskGiveUpMap()[readerKey].at;
  var noKey = mkMedia('no-key-177', 'VIDEO', 2);
  app._quarantineDeadMedia(noKey, { reloadTimes: 3 });
  var noKeyLog = logs.filter(function (line) { return line.message === 'media recovery exhausted, element quarantined'; }).pop();
  check('177-6：重复耗尽不刷新放弃时刻、不重复说话，空任务键单独报 no-key',
    firstAt === secondAt &&
    logs.filter(function (line) { return line.message === 'media recovery exhausted, element quarantined'; }).length === warnCount + 1 &&
    noKeyLog && noKeyLog.meta.giveUp === 'no-key' && !app._taskGiveUpMap()[''],
    JSON.stringify({ firstAt: firstAt, secondAt: secondAt, noKey: noKeyLog && noKeyLog.meta.giveUp }));

  app._clearTaskGiveUp();
  var resetReload = app._reloadMediaInPlace(bad, 'reset');
  check('177-7：用户清除放弃名单时，当前页隔离与三次恢复预算一起恢复',
    !app._isMediaQuarantined(bad) && !app._isTaskGivenUp(readerKey) &&
    resetReload === true && app._mediaReloadKeys[bad.key].n === 1,
    JSON.stringify({ quarantined: app._isMediaQuarantined(bad), givenUp: app._isTaskGivenUp(readerKey),
      resetReload: resetReload, n: app._mediaReloadKeys[bad.key] && app._mediaReloadKeys[bad.key].n }));

  var late = mkMedia('late-177', 'VIDEO', 2);
  late.currentTime = 10;
  late.play = function () {
    this.plays++;
    return this.plays === 1 ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve();
  };
  var lateApp = mkApp(mkDoc([late]));
  lateApp._mediaReloadKeys[late.key] = { n: 2, at: Date.now() - 20001 };
  lateApp._reloadMediaInPlace(late, 'late');
  lateApp._quarantineDeadMedia(late, { job: job, reloadTimes: 3 });
  (late.listeners.loadedmetadata || []).forEach(function (fn) { fn(); });
  lateApp._handleVideoEnded({ target: late });
  lateApp._handleVideoLoaded({ target: late });
  await flush();
  check('177-8：隔离后的 loadedmetadata、播放拒绝与 ended 迟到回调不再重启或收尾',
    late.currentTime === 10 && late.plays === 1 && lateApp.rateCalls === 0 &&
    lateApp.finishCalls === 0 && lateApp.nextCalls === 0 && lateApp.resetRateCalls === 0 && lateApp.seekCalls === 0,
    JSON.stringify({ currentTime: late.currentTime, plays: late.plays, rateCalls: lateApp.rateCalls,
      finishCalls: lateApp.finishCalls, nextCalls: lateApp.nextCalls, resetRateCalls: lateApp.resetRateCalls,
      seekCalls: lateApp.seekCalls }));

  var pptAudio = mkMedia('ppt-audio-177', 'AUDIO', 2);
  var pptDoc = mkDoc([pptAudio]);
  var pptApp = mkApp(pptDoc);
  var pptJob = { jobid: 'ppt-177', name: '隔离音频课件', doc: pptDoc, win: {
    swiperNext: function () { pptApp.nextCalls++; },
    finishJob: function () { pptApp.finishCalls++; }
  } };
  pptApp._mediaQuarantine.set(pptAudio, { job: pptJob, quarantined: Date.now() });
  var pptStart = pptApp._startSlideMedia(pptDoc, pptJob);
  var pptWait = await pptApp._waitSlideAudioDone(pptDoc, pptJob);
  var pptRun = await pptApp._runPptAudioJob(pptJob);
  check('177-9：课件只剩隔离音频时不假报播完、不翻页、不调用平台完成',
    pptStart === 0 && pptWait === false && pptRun === false && pptApp.nextCalls === 0 &&
    pptApp.finishCalls === 0 && pptApp.documentClearReason === 'ppt-audio-media-quarantined',
    JSON.stringify({ pptStart: pptStart, pptWait: pptWait, pptRun: pptRun,
      nextCalls: pptApp.nextCalls, finishCalls: pptApp.finishCalls,
      clearReason: pptApp.documentClearReason }));

  var guardApp = mkApp(mkDoc([bad]));
  guardApp._videoEl = bad;
  guardApp._isPlaying = true;
  guardApp._mediaQuarantine.set(bad, { job: job, quarantined: Date.now() });
  var rearmed = guardApp._rearmMediaGuardIfLost('test');
  check('177-10：隔离缓存不会补回媒体看护句柄',
    rearmed === false && guardApp._videoEl === null && guardApp.guardStarts === 0,
    JSON.stringify({ rearmed: rearmed, cached: !!guardApp._videoEl, guardStarts: guardApp.guardStarts }));

  var rateVideo = mkMedia('rate-late-177', 'VIDEO', 0);
  var rateWrites = 0;
  var rateValue = 1;
  Object.defineProperty(rateVideo, 'playbackRate', {
    configurable: true, get: function () { return rateValue; },
    set: function (value) { rateWrites++; rateValue = value; }
  });
  var defaultWrites = 0;
  var defaultRateValue = 1;
  Object.defineProperty(rateVideo, 'defaultPlaybackRate', {
    configurable: true, get: function () { return defaultRateValue; },
    set: function (value) { defaultWrites++; defaultRateValue = value; }
  });
  var rateApp = mkApp(mkDoc([rateVideo]));
  var rateTargetFn = buildFrom(media, '_getTargetPlaybackRate', env);
  var rateClampFn = buildFrom(media, '_clampAutoRate', env);
  rateApp._getTargetPlaybackRate = function () { return rateTargetFn.call(rateApp); };
  rateApp._clampAutoRate = function (rate) { return rateClampFn.call(rateApp, rate); };
  rateApp.configs.autoMaxPlaybackRate = true;
  rateApp._videoEl = rateVideo;
  rateApp._getVideoEl = function () { return rateVideo; };
  rateApp._detectMaxPlaybackRate = function () { return rateDeferred; };
  var resolveRate;
  var rateDeferred = new Promise(function (resolve) { resolveRate = resolve; });
  rateApp._scheduleMaxRateDetection(rateVideo);
  rateApp._quarantineDeadMedia(rateVideo, { job: job, reloadTimes: 3 });
  resolveRate(4);
  await flush();
  var rateQuarantine = rateApp._isMediaQuarantined(rateVideo);
  check('177-11：倍速探测在隔离后作废，迟到结果不再写播放器',
    rateQuarantine === true && rateWrites === 0 && defaultWrites === 0 && rateApp._detectedMaxRate === 0 &&
    rateApp._rateDetectBusy === false && rateApp._rateDetectVideo === null && rateApp.unreadableCalls === 0,
    JSON.stringify({ quarantined: rateQuarantine, rateWrites: rateWrites, defaultWrites: defaultWrites,
      detected: rateApp._detectedMaxRate,
      busy: rateApp._rateDetectBusy, detectVideo: !!rateApp._rateDetectVideo,
      unreadableCalls: rateApp.unreadableCalls }));
  var quarantinedRateWrites = rateWrites;
  rateApp._ensurePlaybackRate(rateVideo, 'quarantined');
  rateApp._scheduleMaxRateDetection(rateVideo);
  check('177-12：已隔离媒体不进入倍速写入或探测入口',
    rateWrites === quarantinedRateWrites && rateApp._rateDetectVideo === null && rateApp._rateDetectBusy === false,
    JSON.stringify({ rateWrites: rateWrites, detectVideo: !!rateApp._rateDetectVideo, busy: rateApp._rateDetectBusy }));
}

async function testQuizSubmitNeverAccepted() {
  console.log('\n[35] 交卷被平台静默拒收：旁路取证进环 + 攒满三次有界放手（会话任务 #232）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var quiz = read('src/page/70-quiz-flow.js');
  var loop = read('src/page/64-tasks-loop.js');
  var cons = read('src/page/00-shell-constants.js');
  var state = read('src/page/10-config-state.js');

  var boundsOf = function (src, name) {
    var at = src.indexOf(name + ': function');
    if (at < 0) at = src.indexOf(name + ': async function');
    if (at < 0) return { start: -1, end: -1 };
    var fnAt = src.indexOf('function', at);
    var start = src.slice(fnAt - 6, fnAt) === 'async ' ? fnAt - 6 : fnAt;
    var end = src.indexOf('\n    },', start);
    return { start: start, end: end };
  };
  var buildFrom = function (src, name, inj) {
    var r = boundsOf(src, name);
    if (r.start < 0 || r.end <= r.start) return null;
    var names = Object.keys(inj || {});
    var made = Reflect.construct(Function, names.concat(['return (' + src.slice(r.start, r.end) + '\n    })']));
    return made.apply(null, names.map(function (k) { return inj[k]; }));
  };

  var logs = [];
  var say = function (level, message, meta) { logs.push({ level: level, message: message, meta: meta }); };
  var logsOf = function (msg) { return logs.filter(function (l) { return l.message === msg; }); };

  var fakeDoc = function (ids) {
    var map = ids || {};
    return {
      URL: 'https://mooc1.chaoxing.com/work/doHomeWork?courseId=SECRET_COURSE',
      getElementById: function (id) {
        return Object.prototype.hasOwnProperty.call(map, id) ? { value: map[id] } : null;
      }
    };
  };
  var topDoc = fakeDoc({});
  var fakeLocation = { href: 'https://mooc1.chaoxing.com/work/doHomeWork' };
  var localConsole = { log: function () {}, warn: function () {}, error: function () {} };

  // ---- A：超时记账按卷子键起算，换卷子才清零 ----
  var fieldFn = buildFrom(quiz, '_getQuizFieldValue', {});
  var workKeyFn = buildFrom(quiz, '_getQuizWorkKey', { document: topDoc, location: fakeLocation });
  var stallFn = buildFrom(quiz, '_noteQuizSubmitStall', {});
  check('232-A0：切出了超时记账要用的三个方法（切不出来下面全是空转）',
    typeof fieldFn === 'function' && typeof workKeyFn === 'function' && typeof stallFn === 'function',
    JSON.stringify({ field: typeof fieldFn, workKey: typeof workKeyFn, stall: typeof stallFn }));

  var appA = {
    _quizSubmitStallKey: '',
    _quizSubmitStallCount: 0,
    _quizSubmitStallAt: 0,
    _resolveQuizSubmitDocument: function (d) { return d || topDoc; },
    _getMainDocument: function () { return topDoc; },
    _getCurrentChapterId: function () { return 'chap1'; },
    _getQuizAccountDocument: function (d) { return d || topDoc; }
  };
  appA._getQuizFieldValue = fieldFn;
  appA._getQuizWorkKey = function (d) { return workKeyFn.call(appA, d); };
  appA._noteQuizSubmitStall = function (d) { return stallFn.call(appA, d); };

  var docA = fakeDoc({ courseId: 'c1', classId: 'k1', workRelationId: 'w1', jobid: '404', knowledgeid: 'n1' });
  var docB = fakeDoc({ courseId: 'c1', classId: 'k1', workRelationId: 'w1', jobid: '405', knowledgeid: 'n2' });
  var a1 = appA._noteQuizSubmitStall(docA);
  var a2 = appA._noteQuizSubmitStall(docA);
  var keyA = appA._quizSubmitStallKey;
  var a3 = appA._noteQuizSubmitStall(docB);
  var a4 = appA._noteQuizSubmitStall(docA);
  check('232-A1：同一份卷子连攒是 1→2，换一份卷子重新起算（回来也是新账）',
    a1 === 1 && a2 === 2 && a3 === 1 && a4 === 1 && appA._quizSubmitStallCount === 1 && appA._quizSubmitStallAt > 0,
    JSON.stringify({ a1: a1, a2: a2, a3: a3, a4: a4, count: appA._quizSubmitStallCount }));
  check('232-A2：账记在卷子身份上（含 jobid），不是页面地址',
    keyA.indexOf(encodeURIComponent('c1|k1|w1|404|n1')) >= 0 && keyA.indexOf('SECRET_COURSE') < 0,
    keyA);

  // ---- B：超时那一发把「为什么没认出结果页」与旁路账一起进环 ----
  var monitorFn = buildFrom(quiz, '_monitorQuizSubmit', {
    emitRuntimeLog: say,
    scaledMs: function (n) { return n; },
    console: localConsole
  });
  check('232-B0：切出了 _monitorQuizSubmit', typeof monitorFn === 'function', typeof monitorFn);

  var makeMonitorApp = function (net) {
    return {
      configs: { quizSubmitWaitMs: 25000 },
      _quizSubmitPending: true,
      _quizSubmitStartedAt: Date.now() - 26000,
      _quizSubmitLogAt: 0,
      _quizSubmitNet: net,
      _submitSnifferCoverage: 'xhr+fetch',
      _quizSubmitStallCount: 0,
      _prepareQuizRedoIfNeeded: function () { return false; },
      _isQuizPassedOrFinished: function () { return false; },
      _isQuizAnswersCleared: function () { return false; },
      _describeQuizResultPage: function () { return { containers: 10, controls: 1, gradeSelector: 'Py_tk' }; },
      _noteQuizSubmitStall: function () { return 2; },
      _clearQuizSubmitAttemptCount: function () {}
    };
  };

  var bBefore = logs.length;
  var appB = makeMonitorApp({ xhr: 2, fetch: 1, done: 2, failed: 0, statuses: [200], words: ['提交'] });
  var bRet = monitorFn.call(appB);
  var bLogs = logs.slice(bBefore).filter(function (l) { return l.message === 'quiz submit wait timeout'; });
  var bMeta = bLogs.length ? bLogs[0].meta : {};
  check('232-B1：超时诊断里带 stalls / observer / net 计数与状态码',
    bRet === false && appB._quizSubmitPending === false && bLogs.length === 1 &&
    bMeta.waitMs === 25000 && bMeta.stalls === 2 && bMeta.observer === 'xhr+fetch' &&
    bMeta.containers === 10 && bMeta.net && bMeta.net.xhr === 2 && bMeta.net.fetch === 1 &&
    bMeta.net.statuses[0] === 200 && String(bMeta.netHint || '').indexOf('net.statuses') >= 0,
    JSON.stringify({ ret: bRet, pending: appB._quizSubmitPending, logs: bLogs.length, meta: bMeta }));
  check('232-B2：net 这一格只有计数与判分词，没有任何地址或回包原文的字段',
    bMeta.net && Object.keys(bMeta.net).sort().join(',') === 'done,failed,fetch,statuses,words,xhr',
    JSON.stringify(Object.keys(bMeta.net || {})));

  var b2Before = logs.length;
  var appB2 = makeMonitorApp({ xhr: 0, fetch: 0, done: 0, failed: 0, statuses: [], words: [] });
  monitorFn.call(appB2);
  var b2Logs = logs.slice(b2Before).filter(function (l) { return l.message === 'quiz submit wait timeout'; });
  var b2Meta = b2Logs.length ? b2Logs[0].meta : {};
  check('232-B3：一条请求都没观察到时单独说「0 条不等于没发」，不许当成没发',
    b2Logs.length === 1 && b2Meta.net && b2Meta.net.xhr === 0 && String(b2Meta.netHint || '').indexOf('0 条不等于没发') >= 0,
    JSON.stringify(b2Meta.netHint || ''));

  var b3Before = logs.length;
  var appB3 = makeMonitorApp(null);
  monitorFn.call(appB3);
  var b3Logs = logs.slice(b3Before).filter(function (l) { return l.message === 'quiz submit wait timeout'; });
  var b3Meta = b3Logs.length ? b3Logs[0].meta : {};
  check('232-B4：账本压根没建时 net 交 null，netHint 仍说清「没观察到」',
    b3Logs.length === 1 && b3Meta.net === null && String(b3Meta.netHint || '').indexOf('0 条不等于没发') >= 0,
    JSON.stringify({ net: b3Meta.net, hint: b3Meta.netHint }));

  // ---- C：旁路观测器只记计数/状态码/判分词，绝不把地址与回包原文带进环 ----
  var FakeXHR = function () { this.listeners = []; };
  FakeXHR.prototype.open = function (method, url) { this.__openMethod = method; this.__openUrl = url; };
  FakeXHR.prototype.send = function () { this.__sent = true; };
  FakeXHR.prototype.addEventListener = function (ev, fn) { if (ev === 'loadend') this.listeners.push(fn); };

  var fetchHits = 0;
  var fakeWindow = {
    XMLHttpRequest: FakeXHR,
    fetch: function () {
      fetchHits++;
      return Promise.resolve({
        status: 201,
        clone: function () { return this; },
        text: function () { return Promise.resolve('已提交成功'); }
      });
    }
  };
  var snifferFn = buildFrom(quiz, '_installSubmitSniffer', {
    window: fakeWindow,
    emitRuntimeLog: say,
    console: localConsole
  });
  check('232-C0：切出了 _installSubmitSniffer', typeof snifferFn === 'function', typeof snifferFn);

  var appC = {
    _submitSnifferInstalled: false,
    _submitSnifferFetch: false,
    _submitSnifferCoverage: '',
    _quizSubmitPending: true,
    _quizSubmitNet: { xhr: 0, fetch: 0, done: 0, failed: 0, statuses: [], words: [] }
  };
  var cBefore = logs.length;
  snifferFn.call(appC);
  var firstWrappedFetch = fakeWindow.fetch;
  snifferFn.call(appC);
  check('232-C1：观测器只装一次，能力格如实报 xhr+fetch',
    appC._submitSnifferInstalled === true && appC._submitSnifferFetch === true &&
    appC._submitSnifferCoverage === 'xhr+fetch' && fakeWindow.fetch === firstWrappedFetch,
    JSON.stringify({ installed: appC._submitSnifferInstalled, fetch: appC._submitSnifferFetch, coverage: appC._submitSnifferCoverage }));

  var xhr1 = new FakeXHR();
  xhr1.open('POST', 'https://secret.example/work/submit?enc=TOKEN123');
  xhr1.send('answer=1');
  xhr1.status = 200;
  xhr1.responseText = '提交失败：重复提交';
  check('232-C2：相关地址的请求挂上了旁路回调', xhr1.listeners.length === 1, String(xhr1.listeners.length));
  xhr1.listeners.forEach(function (fn) { fn.call(xhr1); });

  var xhr2 = new FakeXHR();
  xhr2.open('GET', '/static/app.js');
  xhr2.send();
  check('232-C3：不相关地址不挂回调、不计数', xhr2.listeners.length === 0 && appC._quizSubmitNet.xhr === 1,
    JSON.stringify({ listeners: xhr2.listeners.length, xhr: appC._quizSubmitNet.xhr }));

  await fakeWindow.fetch('https://secret.example/work/submit?enc=TOKEN123');
  await new Promise(function (r) { setTimeout(r, 10); });

  var cLogs = logs.slice(cBefore).filter(function (l) { return l.message === 'quiz submit network'; });
  var cText = JSON.stringify(cLogs);
  var cMeta = cLogs.length ? cLogs[0].meta : {};
  check('232-C4：XHR 与 fetch 两条都在记账，回包里的判分词落进 words',
    appC._quizSubmitNet.xhr === 1 && appC._quizSubmitNet.fetch === 1 && appC._quizSubmitNet.done === 2 &&
    appC._quizSubmitNet.words.indexOf('重复') >= 0 && appC._quizSubmitNet.words.indexOf('提交') >= 0 &&
    appC._quizSubmitNet.words.indexOf('已提交') >= 0 && fetchHits === 1,
    JSON.stringify({ net: appC._quizSubmitNet, fetchHits: fetchHits }));
  check('232-C5：进环的那一条只有计数/状态/判分词，地址与回包原文一个字都不许出现',
    cLogs.length === 2 && Object.keys(cMeta).sort().join(',') === 'kind,ok,pendingAtSend,respLen,status,words' &&
    cText.indexOf('secret.example') < 0 && cText.indexOf('TOKEN123') < 0 &&
    cText.indexOf('提交失败：重复提交') < 0 && cText.indexOf('已提交成功') < 0,
    JSON.stringify({ count: cLogs.length, keys: Object.keys(cMeta), text: cText.slice(0, 300) }));

  // ---- D：攒满三次 → 写 24 小时放弃名单 + 放开这一节，不冒充平台完成 ----
  var storeMatch = /_taskGiveUpStoreKey:\s*'([^']+)'/.exec(state);
  var STORE_KEY = storeMatch ? storeMatch[1] : '';
  var TTL = readProductConstant(cons, 'TASK_GIVEUP_TTL_MS');
  check('232-D0：放弃名单的存储键与 TTL 都从源码读回来了',
    !!STORE_KEY && isFinite(TTL) && TTL > 0,
    JSON.stringify({ key: STORE_KEY, ttl: TTL }));

  var store = {};
  var fakeLS = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var giveUpMapFn = buildFrom(loop, '_taskGiveUpMap', { localStorage: fakeLS });
  var isGivenUpFn = buildFrom(loop, '_isTaskGivenUp', { TASK_GIVEUP_TTL_MS: TTL });
  var markGivenUpFn = buildFrom(loop, '_markTaskGivenUp', { localStorage: fakeLS });
  var forceSkipFn = buildFrom(quiz, '_setQuizForceSkip', {});
  var givenUpJobIdFn = buildFrom(quiz, '_getQuizGiveUpJobId', {});
  var domCtl = { sel: [], button: { clicked: 0, click: function () { this.clicked++; } } };
  var fakeGlobalDoc = {
    querySelector: function (sel) {
      domCtl.sel.push(sel);
      if (sel !== '#prevNextFocusNext') return null;
      return domCtl.button || null;
    }
  };
  var giveUpFn = buildFrom(quiz, '_giveUpQuizSubmitAfterStalls', {
    emitRuntimeLog: say,
    document: fakeGlobalDoc
  });
  check('232-D1a：切出了放弃出口与它依赖的四个方法',
    typeof giveUpFn === 'function' && typeof giveUpMapFn === 'function' && typeof isGivenUpFn === 'function' &&
    typeof markGivenUpFn === 'function' && typeof forceSkipFn === 'function' && typeof givenUpJobIdFn === 'function',
    JSON.stringify({ giveUp: typeof giveUpFn, map: typeof giveUpMapFn, mark: typeof markGivenUpFn }));

  var makeGiveUpApp = function (doc, opts) {
    var app = {
      _quizSubmitStallCount: 3,
      _quizSubmitPending: true,
      _quizAnswered: false,
      _quizSubmitStartedAt: Date.now(),
      _quizSubmitNet: { xhr: 1, fetch: 0, done: 0, failed: 1, statuses: [0], words: [] },
      _submitSnifferCoverage: 'xhr',
      _quizInProgress: true,
      _quizForceSkipUntil: 0,
      _quizForceSkipPaperKey: '',
      _quizReadyToSubmit: true,
      _quizReadyWorkKey: 'x',
      _quizCurrentAnsweredKeys: { q1: true },
      _quizCurrentAnswerValues: { q1: 'A' },
      _quizCurrentQuestions: [{ title: 'q1' }],
      _taskGiveUpStoreKey: STORE_KEY,
      _resetCalls: 0,
      _nextUnitCalls: 0,
      _switchCalls: [],
      _resolveQuizSubmitDocument: function (d) { return d || doc; },
      _getMainDocument: function () { return doc; },
      _getCurrentChapterId: function () { return 'chap1'; },
      _getQuizAccountDocument: function (d) { return d || doc; },
      _getQuizSubmitAttemptCount: function () { return opts.attempts; },
      _getQuizMaxSubmitAttempts: function () { return 20; },
      _collectVisibleTaskFrames: function () { return opts.tasks || []; },
      _getQuizPaperKeyFromTask: function (t) { return String((t && t.paperId) || ''); },
      _safeJsonParse: function (text, dflt) { try { return JSON.parse(text); } catch (e) { return dflt; } },
      _switchToNextLearningCard: function (reason) { app._switchCalls.push(reason); return !!opts.switchOk; },
      _resetRuntimeState: function () {
        app._resetCalls++;
        app._quizForceSkipUntil = 0;
        app._quizForceSkipPaperKey = '';
      },
      nextUnit: function () { app._nextUnitCalls++; }
    };
    return app;
  };
  var wireGiveUp = function (app) {
    app._getQuizFieldValue = fieldFn;
    app._taskGiveUpMap = function () { return giveUpMapFn.call(app); };
    app._isTaskGivenUp = function (k) { return isGivenUpFn.call(app, k); };
    app._markTaskGivenUp = function (k, info) { return markGivenUpFn.call(app, k, info); };
    app._setQuizForceSkip = function (ms, pk) { return forceSkipFn.call(app, ms, pk); };
    app._getQuizWorkKey = function (d) { return workKeyFn.call(app, d); };
    app._getQuizGiveUpJobId = function (d, scan) { return givenUpJobIdFn.call(app, d, scan); };
    app._giveUp = function (d, reason) { return giveUpFn.call(app, d, reason); };
  };

  var docD = fakeDoc({ courseId: 'c1', classId: 'k1', workRelationId: 'w1', jobid: '404', knowledgeid: 'n1' });
  var appD = makeGiveUpApp(docD, { attempts: 2 });
  wireGiveUp(appD);
  var dBefore = logs.length;
  var dRet = appD._giveUp(docD, 'next-unit');
  var dLogs = logs.slice(dBefore).filter(function (l) { return l.message === 'quiz submit never accepted, giving up unit'; });
  var dMeta = dLogs.length ? dLogs[0].meta : {};
  var dRecord = {};
  try { dRecord = JSON.parse(fakeLS.getItem(STORE_KEY))['job:404'] || {}; } catch (eRec) { dRecord = {}; }
  check('232-D1b：这一枚任务点真写进了 24 小时放弃名单，理由与次数逐字可查',
    dRet === true && appD._isTaskGivenUp('job:404') === true &&
    dRecord.reason === 'quiz-submit-never-accepted' && dRecord.name === '404' && dRecord.attempts === 2,
    JSON.stringify({ ret: dRet, record: dRecord, store: fakeLS.getItem(STORE_KEY) }));
  check('232-D1c：日志点名是谁判的，并给出可恢复的出口',
    dLogs.length === 1 && dMeta.reason === 'next-unit' && dMeta.stalls === 3 && dMeta.attempts === 2 &&
    dMeta.maxAttempts === 20 && dMeta.jobid === '404' && dMeta.gaveUp === true &&
    String(dMeta.hint || '').indexOf('clearTaskGiveUp') >= 0 && dMeta.observer === 'xhr',
    JSON.stringify(dMeta));

  check('232-D2：交卷状态清空、点了下一节、暂停窗口带着卷子键重新写上',
    appD._quizSubmitPending === false && appD._quizAnswered === true &&
    appD._quizSubmitStallCount === 0 && appD._quizCurrentQuestions === null &&
    appD._quizInProgress === false && appD._quizReadyToSubmit === false &&
    domCtl.button.clicked === 1 && appD._resetCalls === 1 &&
    appD._quizForceSkipUntil > Date.now() &&
    appD._quizForceSkipPaperKey.indexOf(encodeURIComponent('c1|k1|w1|404|n1')) >= 0 &&
    appD._nextUnitCalls === 0,
    JSON.stringify({ pending: appD._quizSubmitPending, answered: appD._quizAnswered, stalls: appD._quizSubmitStallCount,
      clicked: domCtl.button.clicked, resets: appD._resetCalls, until: appD._quizForceSkipUntil,
      paper: appD._quizForceSkipPaperKey, nextUnit: appD._nextUnitCalls }));
  check('232-D3：只认「下一节」那一枚按钮，不碰任何完成标记',
    domCtl.sel.length >= 1 && domCtl.sel.every(function (s) { return s === '#prevNextFocusNext'; }) &&
    domCtl.sel.join(',').indexOf('isFinished') < 0,
    JSON.stringify(domCtl.sel));

  domCtl.button.clicked = 0;
  var appD2 = makeGiveUpApp(docD, { attempts: 2, switchOk: true });
  wireGiveUp(appD2);
  var d2Ret = appD2._giveUp(docD, 'next-unit');
  check('232-D4：卡片切换那条出口优先，成功时不再点按钮、也不走到 nextUnit',
    d2Ret === true && appD2._switchCalls.length === 1 && appD2._switchCalls[0] === 'quiz-submit-given-up' &&
    domCtl.button.clicked === 0 && appD2._nextUnitCalls === 0,
    JSON.stringify({ calls: appD2._switchCalls, clicked: domCtl.button.clicked, nextUnit: appD2._nextUnitCalls }));

  var docNoId = fakeDoc({ courseId: 'c2', classId: 'k2', workRelationId: 'w2' });
  var appD3 = makeGiveUpApp(docNoId, { attempts: 1, tasks: [] });
  wireGiveUp(appD3);
  domCtl.button = null;
  var d3Before = logs.length;
  var d3Ret = appD3._giveUp(docNoId, 'next-unit');
  var d3Logs = logs.slice(d3Before).filter(function (l) { return l.message === 'quiz submit never accepted, giving up unit'; });
  var d3Meta = d3Logs.length ? d3Logs[0].meta : {};
  var storeKeys = [];
  try { storeKeys = Object.keys(JSON.parse(fakeLS.getItem(STORE_KEY)) || {}); } catch (eKeys) { storeKeys = []; }
  check('232-D5：认不出 jobid 时明说「没写放弃名单」，但这一节照样放开',
    d3Ret === true && d3Meta.gaveUp === false && d3Meta.jobid === '' &&
    String(d3Meta.hint || '').indexOf('没写放弃名单') >= 0 &&
    storeKeys.length === 1 && storeKeys[0] === 'job:404' && appD3._nextUnitCalls === 1,
    JSON.stringify({ meta: d3Meta, storeKeys: storeKeys, nextUnit: appD3._nextUnitCalls }));

  // ---- E：攒满三次才放手，没攒满照旧按住 ----
  var holdFn = buildFrom(quiz, '_shouldHoldQuizBeforeNext', { emitRuntimeLog: say });
  check('232-E0：切出了 _shouldHoldQuizBeforeNext', typeof holdFn === 'function', typeof holdFn);

  var giveUpSentinel = { calls: 0, reason: '' };
  var makeHoldApp = function (stalls) {
    return {
      _quizSubmitStallCount: stalls,
      _quizHoldLogAt: 0,
      _isQuizSkipWindowLive: function () { return false; },
      _isQuizApiUnavailable: function () { return false; },
      _isQuizBlockedByApi: function () { return false; },
      _monitorQuizSubmit: function () { return false; },
      _resolveQuizSubmitDocument: function () { return docD; },
      _getMainDocument: function () { return docD; },
      _detectQuiz: function () { return true; },
      _isQuizPassedOrFinished: function () { return false; },
      _isQuizRedoRequired: function () { return false; },
      _hasActiveQuizSubmitForm: function () { return true; },
      _shouldSkipQuizBySubmitAttempts: function () { return false; },
      _giveUpQuizSubmitAfterStalls: function (doc, reason) {
        giveUpSentinel.calls++;
        giveUpSentinel.reason = reason;
        return 'GAVEUP';
      }
    };
  };
  var eBefore = logs.length;
  var e0 = holdFn.call(makeHoldApp(0), 'next-unit');
  var e1 = holdFn.call(makeHoldApp(1), 'next-unit');
  var e2 = holdFn.call(makeHoldApp(2), 'next-unit');
  var e3 = holdFn.call(makeHoldApp(3), 'next-unit');
  var eLogs = logs.slice(eBefore).filter(function (l) { return l.message === 'hold unsubmitted quiz before next'; });
  check('232-E1：没攒满三次照旧按住，日志带当前次数',
    e0 === true && e1 === true && e2 === true && eLogs.length === 3 &&
    eLogs[0].meta.stalls === 0 && eLogs[1].meta.stalls === 1 && eLogs[2].meta.stalls === 2,
    JSON.stringify({ e0: e0, e1: e1, e2: e2, stalls: eLogs.map(function (l) { return l.meta.stalls; }) }));
  check('232-E2：第三次交给放手出口（有界），不再原地按住',
    e3 === 'GAVEUP' && giveUpSentinel.calls === 1 && giveUpSentinel.reason === 'next-unit',
    JSON.stringify({ e3: e3, calls: giveUpSentinel.calls, reason: giveUpSentinel.reason }));

  var appDebug = makeHoldApp(3);
  appDebug.configs = { quizRejectGiveUp: false };
  var dbgBefore = logs.length;
  var dbgHold = holdFn.call(appDebug, 'next-unit');
  var dbgLogs = logs.slice(dbgBefore).filter(function (l) {
    return l.message === 'quiz submit rejected, holding in debug mode';
  });
  check('232-E3：调试档（quizRejectGiveUp=false）第三次也不放手，单独点名「死磕」而不是静默按住',
    dbgHold === true && giveUpSentinel.calls === 1 && dbgLogs.length === 1 &&
    dbgLogs[0].meta.stalls === 3 && dbgLogs[0].meta.reason === 'next-unit',
    JSON.stringify({ hold: dbgHold, calls: giveUpSentinel.calls, logs: dbgLogs.length,
      meta: dbgLogs.length ? dbgLogs[0].meta : null }));

  var skipFn = buildFrom(quiz, '_shouldSkipQuizBySubmitAttempts', {});
  var appSkip = {
    configs: { quizRejectGiveUp: false },
    _getQuizSubmitAttemptCount: function () { return 20; },
    _getQuizMaxSubmitAttempts: function () { return 20; }
  };
  var dbgSkip = skipFn.call(appSkip);
  appSkip.configs = {};
  var defaultSkip = skipFn.call(appSkip);
  check('232-E4：调试档下交卷次数到顶也不跳过；默认档仍按上限跳过（两半各钉一格）',
    dbgSkip === false && defaultSkip === true,
    JSON.stringify({ debug: dbgSkip, normal: defaultSkip }));

  // ---- F：放弃名单里那一枚不再算 pending，但正在飞的提交不许被截断 ----
  var pendingFn = buildFrom(quiz, '_isQuizLearningPending', {});
  check('232-F0：切出了 _isQuizLearningPending', typeof pendingFn === 'function', typeof pendingFn);

  var makePendingApp = function (o) {
    return {
      _quizForceSkipUntil: 0,
      _isQuizForceSkipping: function () { return false; },
      _isQuizApiUnavailable: function () { return false; },
      _isQuizBlockedByApi: function () { return false; },
      _monitorQuizSubmit: function () { return !!o.monitor; },
      _isQuizGivenUpInDom: function () { return !!o.givenUp; },
      _quizInProgress: false,
      _quizSubmitPending: false,
      _quizAnswered: false,
      _resolveQuizSubmitDocument: function () { return docD; },
      _getMainDocument: function () { return docD; },
      _isQuizPassedOrFinished: function () { return false; },
      _isQuizRedoRequired: function () { return false; },
      _hasActiveQuizSubmitForm: function () { return true; },
      _detectQuiz: function () { return true; }
    };
  };
  var f1 = pendingFn.call(makePendingApp({ givenUp: true, monitor: false }));
  var f2 = pendingFn.call(makePendingApp({ givenUp: true, monitor: true }));
  var f3 = pendingFn.call(makePendingApp({ givenUp: false, monitor: false }));
  check('232-F1：放弃名单里那一枚不再算 pending；提交还在飞时不许被它截断；对照组仍算 pending',
    f1 === false && f2 === true && f3 === true,
    JSON.stringify({ givenUp: f1, inFlight: f2, control: f3 }));

  // ---- G：确认弹窗那一发不清账，只有新的一轮才换新账本 ----
  var markFn = buildFrom(quiz, '_markQuizSubmitPending', { emitRuntimeLog: say });
  check('232-G0：切出了 _markQuizSubmitPending', typeof markFn === 'function', typeof markFn);

  var attemptCounter = { value: 0, increments: 0 };
  var appG = {
    configs: {},
    _quizSubmitPending: false,
    _quizSubmitStartedAt: 0,
    _quizSubmitLogAt: 0,
    _quizLastSubmitAttemptAt: 0,
    _quizSubmitNet: null,
    _quizCurrentQuestions: [],
    _quizReadyWorkKey: 'rk',
    _getQuizSubmitAttemptCount: function () { return attemptCounter.value; },
    _incrementQuizSubmitAttemptCount: function () { attemptCounter.value++; attemptCounter.increments++; return attemptCounter.value; },
    _getQuizMaxSubmitAttempts: function () { return 20; },
    _getQuizWorkKey: function () { return 'k'; },
    _getQuizAccountDocument: function () { return docD; },
    _getQuizDocumentFromQuestions: function () { return null; }
  };
  markFn.call(appG, docD, 'btnBlueSubmit');
  var gNet1 = appG._quizSubmitNet;
  if (gNet1) gNet1.xhr = 3;
  markFn.call(appG, docD, 'confirm-dialog');
  var gKept = appG._quizSubmitNet === gNet1 && appG._quizSubmitNet && appG._quizSubmitNet.xhr === 3 && attemptCounter.increments === 1;
  appG._quizSubmitPending = false;
  markFn.call(appG, docD, 'again');
  var gReset = appG._quizSubmitNet !== gNet1 && appG._quizSubmitNet && appG._quizSubmitNet.xhr === 0 && attemptCounter.increments === 2;
  check('232-G1：确认弹窗那一发不清账、不重复计次；只有新的一轮才换新账本',
    !!gNet1 && gKept === true && gReset === true,
    JSON.stringify({ kept: gKept, reset: gReset, increments: attemptCounter.increments }));

  // ---- H：交卷前的人机验证窗（#232 现场抓包：空 pyFlag 提交必被平台拒绝） ----
  var domSrc = read('src/page/75-quiz-dom.js');
  var findVerifyFn = buildFrom(domSrc, '_findWorkVerifyWindow', {});
  var solveFn = buildFrom(domSrc, '_solveWorkVerifyCaptcha', { emitRuntimeLog: say });
  var confirmFn = buildFrom(domSrc, '_handleSubmitConfirmDialog', { emitRuntimeLog: say, textOf: function () { return ''; } });

  var fakeInput = { value: '', dispatchEvent: function () { fakeInput.events = (fakeInput.events || 0) + 1; } };
  var fakeImg = { src: 'https://mooc1.chaoxing.com/verifyCode/stuWork?123' };
  var fakeWin = {
    id: 'verifyCodeWin',
    querySelector: function (sel) {
      if (sel.indexOf('#inputCode') >= 0) return fakeInput;
      if (sel.indexOf('#workVerifyImg') >= 0) return fakeImg;
      return null;
    }
  };
  var found = findVerifyFn.call({}, fakeWin);
  check('232-H0：验证码窗能认出输入框与验证码图（#verifyCodeWin / #inputCode / #workVerifyImg）',
    !!found && found.input === fakeInput && found.img === fakeImg, JSON.stringify(!!found));

  var hClick = 0, hSolve = 0, hPending = 0;
  var hButton = { click: function () { hClick++; } };
  var makeConfirmApp = function (inputValue) {
    fakeInput.value = inputValue;
    return {
      _submitConfirmLastClickAt: 0,
      _quizReadyToSubmit: true,
      _quizAnswered: false,
      _quizSubmitPending: false,
      _quizReadyWorkKey: 'rk',
      _findWorkVerifyWindow: function () { return { win: fakeWin, input: fakeInput, img: fakeImg }; },
      _dismissQuizSubmitAlerts: function () {},
      _solveWorkVerifyCaptcha: function () { hSolve++; },
      _findDialogButtonByText: function () { return hButton; },
      _getQuizAccountDocument: function () { return docD; },
      _getQuizWorkKey: function () { return 'rk'; },
      _hasActiveQuizSubmitForm: function () { return true; },
      _markQuizSubmitPending: function () { hPending++; }
    };
  };
  var h1 = confirmFn.call(makeConfirmApp(''), fakeWin);
  check('232-H1：验证码没填时**绝不许点确定**（空 pyFlag 必被拒），而是去识别填码',
    h1 === true && hClick === 0 && hSolve === 1 && hPending === 0,
    JSON.stringify({ ret: h1, click: hClick, solve: hSolve, pending: hPending }));

  hClick = 0; hSolve = 0; hPending = 0;
  var h2 = confirmFn.call(makeConfirmApp('AB12'), fakeWin);
  check('232-H2：码已就位时才点「确定」并记一轮提交（原来那条确认出口照旧）',
    h2 === true && hClick === 1 && hSolve === 0 && hPending === 1,
    JSON.stringify({ ret: h2, click: hClick, solve: hSolve, pending: hPending }));

  var h3Input = { value: '', events: 0, ownerDocument: null, dispatchEvent: function () { h3Input.events++; } };
  var h3Img = { src: 'https://mooc1.chaoxing.com/verifyCode/stuWork?9' };
  var h3App = {
    configs: { model: 'm' },
    _captchaBusy: false,
    _recognizeCaptchaImage: function () { return Promise.resolve({ ok: true, code: '7X2K' }); }
  };
  await solveFn.call(h3App, { input: h3Input, img: h3Img });
  check('232-H3：识别成功后把码写进 #inputCode 并派发 input/change（等下一拍由确认出口点确定）',
    h3Input.value === '7X2K' && h3Input.events === 2 && h3App._captchaBusy === false &&
    h3Img.__omitoneVerifyTries === 1,
    JSON.stringify({ value: h3Input.value, events: h3Input.events, busy: h3App._captchaBusy,
      tries: h3Img.__omitoneVerifyTries }));

  var h4Hidden = 0;
  fakeWin.ownerDocument = { defaultView: { hideWorkVerify: function () { h4Hidden++; } } };
  fakeWin.style = {};
  fakeImg.__omitoneVerifyTries = 2;
  hClick = 0; hPending = 0;
  var h4 = confirmFn.call(makeConfirmApp(''), fakeWin);
  fakeImg.__omitoneVerifyTries = 0;
  check('232-H4：上线版识别两次仍空码时关掉验证码窗（交回三次停滞放手），绝不用空码提交',
    h4 === true && h4Hidden === 1 && hClick === 0 && hPending === 0,
    JSON.stringify({ ret: h4, hidden: h4Hidden, click: hClick, pending: hPending }));

  var findVerifyDocFn = buildFrom(domSrc, '_findWorkVerifyWindow', { visible: function (el) { return !!el.__visible; } });
  fakeWin.__visible = true;
  var fakeDocVerify = {
    getElementById: function (id) { return id === 'verifyCodeWin' ? fakeWin : null; }
  };
  var alertDialog = { id: 'workFailAlert', querySelector: function () { return null; } };
  var appV5 = {
    _resolveQuizSubmitDocument: function () { return fakeDocVerify; },
    _getMainDocument: function () { return fakeDocVerify; }
  };
  var fallback = findVerifyDocFn.call(appV5, alertDialog);
  fakeWin.__visible = false;
  var hiddenFallback = findVerifyDocFn.call(appV5, alertDialog);
  fakeWin.__visible = true;
  check('232-H5：告警层当弹层传进来时，回落到文档里**可见**的验证码窗；隐藏的旧窗不许认领',
    !!fallback && fallback.input === fakeInput && fallback.img === fakeImg && hiddenFallback === null,
    JSON.stringify({ fallback: !!fallback, hidden: hiddenFallback }));

  var knowClicks = 0;
  var alertBtn = { textContent: '知道了', click: function () { knowClicks++; } };
  var failLayer = {
    __visible: true,
    innerText: '作业提交失败！',
    querySelectorAll: function () { return [alertBtn]; }
  };
  var otherLayer = {
    __visible: true,
    innerText: '别的东西',
    querySelectorAll: function () { return [{ textContent: '知道了', click: function () { knowClicks += 999; } }]; }
  };
  var fakeDocAlerts = {
    querySelectorAll: function (sel) { return sel === '.AlertCon02' ? [fakeWin, failLayer, otherLayer] : []; }
  };
  fakeWin.ownerDocument = fakeDocAlerts;
  var dismissFn = buildFrom(domSrc, '_dismissQuizSubmitAlerts', { visible: function (el) { return !!el.__visible; } });
  dismissFn.call({}, { win: fakeWin, input: fakeInput, img: fakeImg });
  check('232-H6：等码时顺手关掉「作业提交失败/知道了」的旧告警层（验证码窗本身与其他层都不动）',
    knowClicks === 1, JSON.stringify({ clicks: knowClicks }));

  var h7Click = 0, h7Pending = 0;
  var h7Btn = { click: function () { h7Click++; } };
  var confirmAlertFn = buildFrom(domSrc, '_handleSubmitConfirmDialog', {
    emitRuntimeLog: say, textOf: function () { return '作业提交失败！ 知道了'; }
  });
  var h7 = confirmAlertFn.call({
    _submitConfirmLastClickAt: 0,
    _findWorkVerifyWindow: function () { return null; },
    _findDialogButtonByText: function () { return h7Btn; },
    _markQuizSubmitPending: function () { h7Pending++; }
  }, { id: 'workFailAlert' });
  check('232-H7：失败告知层只收尾、不记成一轮提交（否则三次停滞额度会被空耗，真提交还没发就被判放手）',
    h7 === true && h7Click === 1 && h7Pending === 0,
    JSON.stringify({ ret: h7, click: h7Click, pending: h7Pending }));

  // ---- J：randomOptions 下「位置字母」与「平台 data 字母」分道 ----
  var answersSrc = read('src/page/72-quiz-answers.js');
  var matchFn = buildFrom(domSrc, '_matchOptionItem', { textOf: function (el) { return String(el && el.textContent || ''); } });
  var mkOpt = function (dataLetter, visibleLabel, idx) {
    var badge = {
      getAttribute: function (n) { return n === 'data' ? dataLetter : ''; },
      textContent: visibleLabel
    };
    return {
      _idx: idx,
      querySelector: function (sel) { return /num_option/.test(sel) ? badge : null; },
      getAttribute: function () { return ''; }
    };
  };
  var optA = mkOpt('C', 'A', 0);
  var optB = mkOpt('A', 'B', 1);
  var optC = mkOpt('B', 'C', 2);
  var matchApp = {
    _getOptionItems: function () { return [optA, optB, optC]; },
    _normalizeAnswerValue: function (v) { return String(v || ''); },
    _detectQuestionType: function () { return 'single'; },
    _inferOptionLetter: function (it) {
      var b = it.querySelector('.num_option');
      return b && /^[A-F]$/i.test(b.getAttribute('data')) ? String(b.getAttribute('data')).toUpperCase() : '';
    },
    _extractOptionText: function (it) { return 'text' + it._idx; },
    _isJudgeOptionMatch: function () { return false; }
  };
  var j1 = matchFn.call(matchApp, {}, 'A', 'single');
  var j2 = matchFn.call(matchApp, {}, 'C', 'single');
  check('232-J1：模型的位置字母按 DOM 次序命中（A=第 1 个可见项），不按徽标 data 认项',
    j1 === optA, JSON.stringify({ hit: j1 && j1._idx }));
  check('232-J2：位置字母 C 命中第 3 个可见项（它的 data 是 B）',
    j2 === optC, JSON.stringify({ hit: j2 && j2._idx }));

  // ---- K：addChoice 宿主只许被触发一次 ----
  var clickFn = buildFrom(domSrc, '_clickOptionItem', { textOf: function (el) { return String(el && el.textContent || ''); }, document: {} });
  var kCounts = { host: 0, inner: 0 };
  var mkClickItem = function (hasHost) {
    var badge = {
      getAttribute: function (n) { return n === 'data' ? 'C' : ''; },
      textContent: 'A',
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
      click: function () { kCounts.inner++; }
    };
    var innerSpan = { click: function () { kCounts.inner++; } };
    var item = {
      ownerDocument: {},
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
      click: function () { kCounts.host++; },
      getAttribute: function () { return ''; },
      closest: function (sel) { return hasHost && /addChoice|addMultipleChoice/.test(sel) ? item : null; },
      querySelector: function (sel) {
        if (/num_option/.test(sel)) return badge;
        if (/input\[type=/.test(sel)) return null;
        return innerSpan;
      },
      querySelectorAll: function () { return []; }
    };
    return item;
  };
  var kApp = {
    _getQuestionIdFromElement: function () { return ''; },
    _inferOptionLetter: function () { return 'C'; },
    _dispatchQuizInputEvents: function () {}
  };
  kCounts.host = 0; kCounts.inner = 0;
  clickFn.call(kApp, mkClickItem(true), 'radio');
  check('232-K1：选项宿主带 addChoice 时整发只触发一次（不再补点内层徽标 → 不复选反选）',
    kCounts.host === 1 && kCounts.inner === 0, JSON.stringify(kCounts));
  kCounts.host = 0; kCounts.inner = 0;
  clickFn.call(kApp, mkClickItem(false), 'radio');
  check('232-K2：普通形状照旧补点内层（旧行为不丢）', kCounts.host === 1 && kCounts.inner === 1, JSON.stringify(kCounts));

  // ---- I：qid 三源仲裁（老引擎 li[qid] / 隐藏域 / 容器 data 序号） ----
  var qidFn = buildFrom(answersSrc, '_getQuestionIdFromElement', {});
  var docWith = function (ids) {
    return { getElementById: function (id) { return ids.indexOf(id) >= 0 ? { id: id } : null; } };
  };
  var iApp = {
    _quizDetectorSelector: '.TiMu',
    _findQuizAnswerInput: function () { return null; }
  };
  var i1El = {
    getAttribute: function () { return ''; },
    ownerDocument: docWith(['answer213']),
    querySelector: function (sel) { return /\[qid\]/.test(sel) ? { getAttribute: function (n) { return n === 'qid' ? '213' : ''; } } : null; },
    closest: function () { return { getAttribute: function () { return '1'; } }; }
  };
  var i2El = {
    getAttribute: function () { return ''; },
    ownerDocument: docWith(['answer213']),
    querySelector: function () { return null; },
    closest: function () { return { getAttribute: function () { return '213'; } }; }
  };
  var i3El = {
    getAttribute: function () { return ''; },
    ownerDocument: docWith([]),
    querySelector: function () { return null; },
    closest: function () { return { getAttribute: function () { return '1'; } }; }
  };
  var i1 = qidFn.call(iApp, i1El);
  var i2 = qidFn.call(iApp, i2El);
  var i3 = qidFn.call(iApp, i3El);
  check('232-I1：老引擎从子项 li[qid] 取号（容器 data 只是序号，不许当代号）',
    i1 === '213', JSON.stringify({ qid: i1 }));
  check('232-I2：新版容器 data 且存在 #answer{data} 时照旧认它', i2 === '213', JSON.stringify({ qid: i2 }));
  check('232-I3：容器 data 缺对应 #answer 时不认（否则序号 1 会被当成 qid）', i3 === '', JSON.stringify({ qid: i3 }));

  // ---- L：qtype 题型兜底 ----
  var typeFn = buildFrom(domSrc, '_detectQuestionType', { textOf: function () { return '题干'; } });
  var mkTypeEl = function (qt) {
    return {
      getAttribute: function () { return ''; },
      querySelector: function (sel) {
        if (/newZy_TItle/.test(sel)) return null;
        if (/\[qtype\]/.test(sel)) return { getAttribute: function (n) { return n === 'qtype' ? qt : ''; } };
        return null;
      },
      querySelectorAll: function () { return []; }
    };
  };
  var typeApp = {
    _mapQuizTypeValue: function (v) { return v === '1' ? 'multiple' : v === '3' ? 'judge' : 'single'; }
  };
  var l1 = typeFn.call(typeApp, mkTypeEl('1'));
  var l2 = typeFn.call(typeApp, mkTypeEl('3'));
  check('232-L1：其它信号都没有时用 li[qtype] 兜底判题型（1→多选，3→判断）',
    l1 === 'multiple' && l2 === 'judge', JSON.stringify({ l1: l1, l2: l2 }));

  // ---- M：多选答案写隐藏域前必须按字母序（#232 现场：BAC/CDA 被拒，ABC/ACD 通过） ----
  var sortHidden = { value: '' };
  var mkChoice = function (dataLetter) {
    return {
      classList: { contains: function (n) { return n === 'check_answer_dx'; } },
      getAttribute: function (n) { return n === 'data' ? dataLetter : ''; }
    };
  };
  var sortDoc = {
    querySelectorAll: function (sel) { return sel === '.choice213' ? [mkChoice('B'), mkChoice('A'), mkChoice('C')] : []; },
    getElementById: function (id) { return id === 'answer213' ? sortHidden : null; }
  };
  var sortItem = {
    ownerDocument: sortDoc,
    click: function () {},
    // 有 qid 时生产会给选项宿主写 `aria-checked`（232-K 那两台 qid 恒空所以走不到这一行），
    // 假元素少这一件就是 TypeError → 整段一条断言都不跑（§5「红 0 条的第一嫌疑人是根本没跑到」）。
    setAttribute: function () {},
    getAttribute: function (n) { return n === 'qid' ? '213' : ''; },
    closest: function (sel) { return /\[qid\]/.test(sel) ? sortItem : null; },
    querySelector: function (sel) {
      if (/num_option/.test(sel)) {
        return { getAttribute: function (n) { return n === 'data' ? 'B' : ''; }, textContent: 'B',
          classList: { add: function () {}, remove: function () {}, contains: function () { return false; } } };
      }
      return null;
    },
    querySelectorAll: function () { return []; }
  };
  clickFn.call(kApp, sortItem, 'checkbox');
  check('232-M1：多选写隐藏域前按字母序收敛（DOM 序拼出 BAC 也必须写成 ABC）',
    sortHidden.value === 'ABC', JSON.stringify({ value: sortHidden.value }));
}

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
  await testChannelNamingAndManualRetreat();
  await testPermanentRoundStopAndConfigRace();
  await testMissingApiKey();
  await testClaudeProtocol();
  await testGeminiProtocol();
  await testPromptContainsBannedAnswers();
  await testEmptyAnswerRefill();
  await testMiddleOptionLetterAbsorb();
  await testDiscardedBatchRefillPerQuestion();
  await testTooFewAnswersKeepsShortAnswerVerbatim();
  await testFontTable();
  await testThinkingLevels();
  await testApiKeyNormalize();
  await testNormalizeItemIndex();
  await testRejectSignatureSurvivesLogStore();
  await testInjectionWatchdogOwnershipGuard();
  await testQuizScanHoldWiring();
  await testQuizPaperDepthAndApiBlock();
  await testScopeReconnectAfterPageChange();
  await testOcsDiscoveryWindow();
  await testCacheBlockWarnThreshold();
  await testJobRejectLogThrottle();
  await testDisplacedStudyPageRescue();
  await testSeekDeferUntilSeekable();
  await testStartStuckSiteClickSelfHeal();
  await testSiteSaysUnplayable();
  await testCanonicalMultipleAnswerOrEmpty();
  await testPopupQuizLocalComboGroup();
  await testCourseHomeProbeSignals();
  await testPetChatRequest();
  await testLocalDoctor();
  await testPreviewChannelNotice();
  await testFillAnswerSeparatorTolerance();
  await testNinetyAdvanceBoundToSeek();
  await testRateAskBound();
  await testMediaRecoveryExhaustion();
  await testModelListFetch();
  await testWebSearchGate();
  await testVoteEndedParkPersistent();
  await testQuizSubmitNeverAccepted();

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
