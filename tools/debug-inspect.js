/**
 * 连上 debug-live.js 启动的调试实例，检查页面状态。
 *
 * 用法：
 *   node tools/debug-inspect.js tabs                       列出所有标签页
 *   node tools/debug-inspect.js eval <URL片段> <JS表达式>   在匹配的标签页里求值
 *   node tools/debug-inspect.js watch <URL片段> [秒数]      监听该页控制台输出
 *
 * eval 的表达式在页面主世界执行（window 上能看到 xxtAI），
 * 支持 Promise（自动 await），结果以 JSON 打印。
 * watch 会打印页面 console.* 输出与未捕获异常，默认 30 秒。
 */
'use strict';

var http = require('http');

var PORT = Number(process.env.OMITONE_DEBUG_PORT || 9333);

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 极简 CDP 客户端：连上 WS，发一条 Runtime.evaluate，等结果，断开 */
function evaluate(wsUrl, expression, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var id = 1;
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('evaluate 超时')); }
    }, timeoutMs || 20000);

    ws.onopen = function () {
      ws.send(JSON.stringify({
        id: id,
        method: 'Runtime.evaluate',
        params: {
          expression: expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }
      }));
    };
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result);
    };
    ws.onerror = function (err) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('WebSocket 连接失败'));
    };
  });
}

async function main() {
  var mode = process.argv[2];

  var targets;
  try {
    targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
  } catch (e) {
    console.error('连不上调试实例（端口 ' + PORT + '）。先跑 node tools/debug-live.js');
    process.exit(1);
  }

  var pages = targets.filter(function (t) { return t.type === 'page'; });

  if (mode === 'tabs') {
    if (!pages.length) { console.log('（没有打开的标签页）'); return; }
    pages.forEach(function (t, i) {
      console.log('[' + i + '] ' + (t.title || '(无标题)').slice(0, 60));
      console.log('    ' + t.url.slice(0, 150));
    });
    return;
  }

  if (mode === 'watch') {
    var needleW = (process.argv[3] || '').toLowerCase();
    var seconds = Number(process.argv[4] || 30);
    var hitW = pages.find(function (t) { return t.url.toLowerCase().indexOf(needleW) !== -1; });
    if (!hitW) {
      console.error('没有 URL 含 "' + needleW + '" 的标签页。当前标签页：');
      pages.forEach(function (t) { console.error('  ' + t.url.slice(0, 150)); });
      process.exit(1);
    }
    console.log('监听 [' + (hitW.title || '').slice(0, 40) + '] ' + seconds + ' 秒...\n');
    var ws = new WebSocket(hitW.webSocketDebuggerUrl);
    var nextId = 1;
    var pending = new Map();
    function send(method, params) {
      return new Promise(function (resolve) {
        var id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    }
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        var p = msg.params;
        var text = (p.args || []).map(function (a) {
          return a.value !== undefined ? String(a.value) : (a.description || a.type);
        }).join(' ');
        var tag = { error: '✗', warning: '⚠', log: ' ', info: '·', debug: ' ' }[p.type] || ' ';
        console.log('[' + new Date(p.timestamp * 1000).toISOString().slice(11, 23) + '] ' + tag + ' ' + text.slice(0, 400));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        var d = msg.params.exceptionDetails;
        console.log('[异常] ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 500));
      }
    };
    ws.onopen = async function () {
      await send('Runtime.enable');
      await send('Page.enable');
      setTimeout(function () { console.log('\n（监听结束）'); process.exit(0); }, seconds * 1000);
    };
    ws.onerror = function () { console.error('WebSocket 连接失败'); process.exit(1); };
    return;
  }

  if (mode === 'eval') {
    var needle = (process.argv[3] || '').toLowerCase();
    var expr = process.argv[4];
    if (!expr) { console.error('缺少表达式'); process.exit(1); }
    var hit = pages.find(function (t) { return t.url.toLowerCase().indexOf(needle) !== -1; });
    if (!hit) {
      console.error('没有 URL 含 "' + needle + '" 的标签页。当前标签页：');
      pages.forEach(function (t) { console.error('  ' + t.url.slice(0, 150)); });
      process.exit(1);
    }
    var result = await evaluate(hit.webSocketDebuggerUrl, expr, 30000);
    if (result.exceptionDetails) {
      console.log('页面抛异常：');
      console.log(JSON.stringify(result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails, null, 2));
      process.exitCode = 2;
      return;
    }
    var v = result.result && result.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    return;
  }

  console.error('用法：node tools/debug-inspect.js tabs | eval <URL片段> <JS表达式>');
  process.exit(1);
}

main().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
