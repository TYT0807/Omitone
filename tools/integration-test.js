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
  var onePrompt = extractPromptText(JSON.parse(harness.sandbox.__sentRequests[1].body));
  check('拆开后的每一批只含一道题（第 2 次请求里没有别的题面）',
    onePrompt.indexOf('单选题乙') < 0 && onePrompt.indexOf('判断题丙') < 0, onePrompt.slice(0, 160));

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
    var fNote = topFnText(bg, 'noteTabStudyUrl');
    var fVerdict = topFnText(bg, 'studyRescueVerdict');
    if (!varsBlock || !fPrune || !fNote || !fVerdict) return;
    try {
      harness = new Function('Date', 'return (function () {\n' + varsBlock + '\n' + fPrune + '\n' + fNote + '\n' + fVerdict +
        '\nreturn { note: noteTabStudyUrl, verdict: studyRescueVerdict,' +
        ' mem: function () { return tabStudyMemory; },' +
        ' reset: function () { tabStudyMemory = Object.create(null); } };\n})()')(
        { now: function () { return fakeNow; } });
    } catch (eBuild) { harness = null; }
  })();

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

  check('①′ 四件套都能从盘上取出来真跑，三个地板也读得回来（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    !!harness && typeof plan === 'function' && typeof speak === 'function' && typeof ask === 'function' &&
    PENDING > 0 && FRESH > PENDING && SILENCE > FRESH,
    'harness=' + !!harness + ' plan=' + typeof plan + ' speak=' + typeof speak + ' ask=' + typeof ask +
      ' floors=' + JSON.stringify([PENDING, FRESH, SILENCE]));
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
}

/** ---- [22] 批次 95：可拖区间还服务不了目标时，不许把一次性机会花在它身上 ---- */
async function testSeekDeferUntilSeekable() {
  console.log('\n[22] 拖到结尾：区间没长出来时先等，不把它判成「站点防拖拽」（批次 95）');

  var read = function (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  };
  var media = read('src/page/40-media.js');

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
  var covers = buildFrom(media, '_seekableCovers', {});
  var defer = buildFrom(media, '_deferSeekUntilSeekable', inj);
  var trySeek = buildFrom(media, '_trySeekToEnd', inj);
  var noteSkip = buildFrom(media, '_noteSeekSkip', inj);
  var isNinety = buildFrom(media, '_isNinetyPercentVideo', {});

  // 两个预算从源码读回来，别抄成测试里的字面量（改了生产数而断言还按旧数跑 = 假绿）
  var deferBody = bodyOf(media, '_deferSeekUntilSeekable');
  var windowMs = firstNum(deferBody, /Date\.now\(\) \+ (\d+)/);
  var capTries = firstNum(deferBody, /st\.tries >= (\d+)/);

  check('① 六件都能从 40-media.js 原样取出来真跑，两个预算也读得回来（取不出来时后面每一条都是「没执行」，而「没执行」和「通过」在报告里长得一模一样）',
    [getKey, covers, defer, trySeek, noteSkip, isNinety].every(function (f) { return typeof f === 'function'; }) &&
    windowMs > 0 && capTries > 1,
    JSON.stringify({ key: typeof getKey, covers: typeof covers, defer: typeof defer, seek: typeof trySeek, note: typeof noteSkip, ninety: typeof isNinety, windowMs: windowMs, capTries: capTries }));
  if (!trySeek || !covers || !defer || !isNinety || !noteSkip) return;

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
  function mkApp() {
    var delays = [];
    var app = {
      configs: { enableSeek: true },
      _rateProbing: false,
      _captchaActive: false,
      _activeJobId: '',
      _workerDelay: function (fn) { delays.push(fn); },
      _isRateLockedAtOne: function () { return true; },
      _getMediaSeekKey: getKey,
      _seekableCovers: covers,
      _deferSeekUntilSeekable: defer,
      _trySeekToEnd: trySeek,
      _noteSeekSkip: noteSkip,
      _isNinetyPercentVideo: isNinety
    };
    return { app: app, delays: delays };
  }
  var seekTo = function (app, v, reason) { return app._trySeekToEnd(v, reason); };
  var keyOf = function (v) { return getKey.call({}, v); };

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

  // ---- ⑩ 记账要有界：>300 复位那一块必须把这一族三本账一起清 ----
  var resetBody = bodyOf(media, '_trySeekToEnd');
  var resetBand = resetBody.slice(resetBody.indexOf('length > 300'));
  check('⑩ 「只检查一次」那本账过 300 就整体复位，且把新增的 _seekDeferKeys 一起清掉（漏一本就是无界增长的账）',
    resetBand.indexOf('_seekTriedKeys = Object.create(null)') >= 0 &&
    resetBand.indexOf('_seekRevertedKeys = Object.create(null)') >= 0 &&
    resetBand.indexOf('_seekDeferKeys = Object.create(null)') >= 0,
    resetBand.slice(0, 220).replace(/\s+/g, ' '));
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
  var exits14 = ['disabled', 'probing', 'captcha', 'no-key', 'no-meta', 'near-end'];
  var body14 = bodyOf(media, '_trySeekToEnd');
  var calls14 = (body14.match(/this\._noteSeekSkip\(/g) || []).length;
  var wired14 = exits14.filter(function (r) { return body14.indexOf("_noteSeekSkip('" + r + "'") >= 0; });
  check('⑭ 「不试拖」六格出口全部接上账，且方法体里恰好六处调用（多一格没进清单、少一格没接线，都在这条上红）',
    wired14.length === exits14.length && calls14 === exits14.length,
    JSON.stringify({ need: exits14.length, wired: wired14, calls: calls14 }));
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
  await testDiscardedBatchRefillPerQuestion();
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
  await testCanonicalMultipleAnswerOrEmpty();
  await testPopupQuizLocalComboGroup();
  await testCourseHomeProbeSignals();

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
