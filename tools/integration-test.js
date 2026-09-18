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

function check(name, condition, detail) {
  checks++;
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
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.NodeFilter = { SHOW_TEXT: 4 };
  sandbox.MutationObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };

  var store = { config: Object.assign({ apiKey: 'test-key', apiType: options.apiType || 'openai', model: 'test-model', apiUrl: 'https://api.test' }, options.config || {}) };
  sandbox.__store = store;

  // ---- location：非学习通、非验证码页 —— content.js 的 start() 会立即静默返回，
  //      从而跳过字体解密 sweep 与 page.js 注入，让测试聚焦在 LLM 链路上
  sandbox.location = { href: 'https://example.com/blank' };

  // ---- document 桩
  var documentElement = {
    setAttribute: function (k, v) { documentElement._attrs = documentElement._attrs || {}; documentElement._attrs[k] = v; },
    getAttribute: function (k) { return (documentElement._attrs || {})[k]; },
    removeAttribute: function (k) { if (documentElement._attrs) delete documentElement._attrs[k]; }
  };
  var body = { innerText: '', appendChild: function () {} };
  sandbox.document = {
    readyState: 'complete',              // 让 start() 立即执行而不是等 DOMContentLoaded
    documentElement: documentElement,
    head: { appendChild: function () {} },
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
      onChanged: { addListener: function () {} }
    }
  };

  // ---- 加载隔离世界里的脚本本体，顺序必须与 manifest.content_scripts.js 一致
  //
  // ⚠️ 这份清单**必须与 manifest 同步**。历史教训：libs/thinking.js 加进 manifest 之后
  // 忘了加到这里，content.js 在测试里读到 null 模块 —— 于是集成测试报的错
  // 看起来像"答题功能坏了"，其实是测试环境自己缺文件。
  // 下面这条守卫就是为了让这种漏项当场报错、而不是伪装成业务 bug。
  var INJECTED_FILES = ['libs/api-url.js', 'libs/prompt.js', 'libs/thinking.js', 'content.js'];
  (function guardInjectionList() {
    var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    var injectedLibs = [];
    (((manifest.content_scripts || [])[0] || {}).js || []).forEach(function (f) {
      if (f.indexOf('libs/') === 0) injectedLibs.push(f);
    });
    // 只盯"content.js 会读的模块"：md5 / Typr 这类纯浏览器库不进测试沙箱是有意的
    ['libs/api-url.js', 'libs/prompt.js', 'libs/thinking.js'].forEach(function (file) {
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
          var hit = posted.filter(function (m) { return m && m.id === id && m.type === 'llm_response'; })[0];
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
async function testIndexPlumbing() {
  console.log('\n[1] 稀疏 index 透传（page.js 只发部分题）');

  // 模拟：20 题的卷子里，page.js 因为已有正确缓存，只发了这 12 道。
  // 12 题刚好跨 2 批（CHUNK_SIZE=10），能真正验证跨批次的 index 映射。
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

  check('按 CHUNK_SIZE=10 分两批发出（10 + 2）', harness.sandbox.__sentRequests.length === 2,
    '实际 ' + harness.sandbox.__sentRequests.length + ' 批');

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

  // 模型返回：单选给了单元素数组、判断给了中文、多选给了数组
  var replied = JSON.stringify([['A'], '正确', ['A', 'C']]);

  var harness = createHarness({ modelResponder: function () { return replied; } });
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

// ---------------------------------------------------------------------------
async function main() {
  console.log('\nOmitone 集成测试（真实 content.js + libs/prompt.js，打桩 chrome.*）');

  await testIndexPlumbing();
  await testLegacySchemaCompat();
  await testV1ObjectCompat();
  await testAnswerCoercion();
  await testParseErrorClassification();
await testPermanentHttpError();
  await testMissingApiKey();
  await testClaudeProtocol();
  await testGeminiProtocol();
  await testPromptContainsBannedAnswers();
  await testEmptyAnswerRefill();
  await testFontTable();
  await testThinkingLevels();

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
