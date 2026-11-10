/**
 * 把一段表达式送进「正在运行的调试浏览器」里那个真实页面执行，并把结果打印出来。
 *
 * 与 `debug-live.js` 配对使用：
 *   1) `node tools/debug-live.js <课程页URL>` —— 起一个独立 profile 的 Edge，扫码登录后留着不动
 *   2) `node tools/debug-probe.js`           —— 在**用户自己的真实页面**上读插件的当场判断
 *
 * 为什么要有这一步：**看导出日志推不出「现场到底长什么样」**。1.3.0 前 11 轮全部只跑 mock 页面，
 * 结果用户一句「没变化」把三轮修复全打回来；批次 12 第一次连真页面量，当场抓到四个
 * 只有真页面能暴露的取证缺陷（容器在外层文档上数、重叠选择器族把 24 道题数成 73、
 * 四格对象被按数字读成 NaN、以及「这页到底跑的是哪一版代码」）。
 *
 * 默认跑只读探针 `xxtAI.probe()` —— 它**不改任何东西**：不调有副作用的判据、不点交卷、
 * 不发模型请求。要看别的就自己给表达式。
 *
 * 用法：
 *   node tools/debug-probe.js                                   // 探针（默认端口 9333、匹配 mooc1）
 *   node tools/debug-probe.js --port=9334 --match=studentstudy
 *   node tools/debug-probe.js --expr="xxtAI.diagnose()"         // 任意表达式，需自己 return
 *
 * ⚠️ `Runtime.evaluate` 落在页面的**主世界顶层帧** —— 正好是 page.js 被注入的那一层，
 *   所以 `xxtAI.*` 与 `window._xxtApp` 都能直接调。子帧里的东西要靠表达式自己走 `contentDocument`。
 */
'use strict';

var fs = require('fs');
var http = require('http');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

function arg(name, dflt) {
  var pre = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  // 也支持空格分隔：--port 9334
  var at = process.argv.indexOf('--' + name);
  if (at > 0 && process.argv[at + 1]) return process.argv[at + 1];
  return dflt;
}

var PORT = Number(arg('port', process.env.OMITONE_DEBUG_PORT || 9333));
var TIMEOUT = Number(arg('timeout', 25000));

function getJson(p) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, function (res) {
      var body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('端口 ' + PORT + ' 上不是 CDP：' + body.slice(0, 80))); }
      });
    }).on('error', function (e) { reject(new Error('连不上 127.0.0.1:' + PORT + '（' + e.message + '）—— 先跑 node tools/debug-live.js')); })
      .on('timeout', function () { reject(new Error('CDP 端口无响应')); });
  });
}

function cdpSend(wsUrl, method, params) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error('CDP 超时（' + TIMEOUT + 'ms）: ' + method + ' —— 页面若被冻结（标签页在后台／隐藏）就会这样'));
    }, TIMEOUT);
    ws.onopen = function () { ws.send(JSON.stringify({ id: 1, method: method, params: params || {} })); };
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    };
    ws.onerror = function () {
      clearTimeout(timer);
      reject(new Error('WebSocket 握手失败 —— 该 target 可能已经关了，重新 F5 页面再试'));
    };
  });
}

var PROBE_EXPR = [
  'var r = { title: document.title, url: String(location.href || "").slice(0, 90),',
  '  xxtAI: typeof window.xxtAI, app: typeof window._xxtApp,',
  '  frames: document.querySelectorAll("iframe").length };',
  'if (window.xxtAI && typeof window.xxtAI.probe === "function") {',
  '  try { r.probe = window.xxtAI.probe(); } catch (e) { r.probe = "ERR " + (e && e.message); }',
  '} else {',
  '  r.probe = "没有 probe()：这一页跑的 page.js 早于批次 12，或者压根不是课程页（先 F5）";',
  '}',
  'return r;'
].join('\n');

async function main() {
  var match = arg('match', 'mooc1');
  var file = arg('file', '');
  var expr = arg('expr', '');
  if (file) expr = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  if (!expr) expr = PROBE_EXPR;

  var targets = await getJson('/json/list');
  var pages = targets.filter(function (t) {
    return t.type === 'page' && t.url.indexOf(match) >= 0 && t.webSocketDebuggerUrl;
  });
  if (!pages.length) {
    console.log('没找到 url 含「' + match + '」的页面目标。端口 ' + PORT + ' 上的现有目标：');
    targets.forEach(function (t) { console.log('  [' + t.type + '] ' + String(t.url).slice(0, 90)); });
    console.log('\n排查顺序：① 调试浏览器是否还开着（debug-live.js 不会自己关）；' +
      '② 端口对不对；③ --match 换个词。');
    process.exit(1);
  }

  for (var i = 0; i < pages.length; i++) {
    console.log('=== ' + pages[i].url.slice(0, 110));
    var r = await cdpSend(pages[i].webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: '(async () => {' + expr + '\n})()',
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true
    });
    if (r.exceptionDetails) {
      console.log('  抛错: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        JSON.stringify(r.exceptionDetails).slice(0, 300)));
      continue;
    }
    var v = r.result && r.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  }
}

main().catch(function (e) {
  console.log('失败: ' + e.message);
  process.exit(1);
});
