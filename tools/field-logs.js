/**
 * 直读**现场**（用户那台调试浏览器）的运行日志环 —— 不用人去点弹窗里的「复制日志」。
 *
 *   node tools/field-logs.js                       // 最近 40 条
 *   node tools/field-logs.js --grep=catalog         // 只看含某串的（子串匹配，不是正则）
 *   node tools/field-logs.js --level=warn --tail=200
 *   node tools/field-logs.js --watch=90             // 持续追 90 秒（每 3 秒一轮，只打新条）
 *
 * 为什么要有这一步：守则与 HANDOVER 反复写着「现场出问题**先看日志再改代码**」，
 * 但日志一直只有两个出口 —— 弹窗里「查看日志」用眼睛看，或「复制日志」手动粘出来。
 * 于是 agent 在现场其实仍然是半蒙眼的：量得到 DOM，量不到"插件当场怎么判的"。
 *
 * 日志环就存在 `chrome.storage.local` 的**那一个键** `runtimeLogs` 里（SW 侧串行写入）。
 * ⚠️ 这里刻意**只读这一个键**：同一个存储里躺着 API Key，整份 dump 一次就是把密钥打进终端。
 *    所以下面 `READ_EXPR` 把键名写死，并且拿到对象后只取 `runtimeLogs`，
 *    顺带自证"回来的确实只有这一个键"（键数 ≠ 1 就明说，别悄悄多用）。
 *
 * ⚠️ 与 `debug-probe.js` 的分工：那个跑在**页面主世界**（读 DOM / `_xxtApp` / `xxtAI.probe()`），
 *    这个跑在**扩展的 service worker**里（读存储）。两侧各有各的看不见，别拿一个冒充另一个。
 */
'use strict';

var http = require('http');

function arg(name, dflt) {
  var pre = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  var at = process.argv.indexOf('--' + name);
  if (at > 0 && process.argv[at + 1]) return process.argv[at + 1];
  return dflt;
}

var PORT = Number(arg('port', process.env.OMITONE_DEBUG_PORT || 9334));
var TAIL = Number(arg('tail', 40));
var GREP = String(arg('grep', ''));
var LEVEL = String(arg('level', ''));
var WATCH_MS = Number(arg('watch', 0));
var TIMEOUT = Number(arg('timeout', 20000));

// meta 里可能带页面文字，也可能带看起来像凭据的东西 —— 键名一撞就当敏感，值整个打掉。
var SENSITIVE_KEY = /(key|token|secret|password|passwd|pwd|authorization|cookie|credential|apikey)/i;

function getJson(p) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, function (res) {
      var body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('端口 ' + PORT + ' 上不是 CDP：' + body.slice(0, 60))); }
      });
    }).on('error', function (e) {
      reject(new Error('连不上 127.0.0.1:' + PORT + '（' + e.message + '）—— 现场调试浏览器没开？先跑 node tools/debug-live.js'));
    });
  });
}

function cdp(wsUrl, method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error('CDP 超时（' + (timeoutMs || TIMEOUT) + 'ms）: ' + method));
    }, timeoutMs || TIMEOUT);
    ws.onopen = function () { ws.send(JSON.stringify({ id: 1, method: method, params: params || {} })); };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    };
    ws.onerror = function () { clearTimeout(timer); reject(new Error('WebSocket 握手失败 —— SW 目标可能刚被回收，重试即可')); };
  });
}

var READ_EXPR = [
  '(async () => {',
  '  const KEY = "runtimeLogs";',
  '  const got = await chrome.storage.local.get(KEY);',
  '  const keys = Object.keys(got || {});',
  '  const logs = got && Array.isArray(got[KEY]) ? got[KEY] : [];',
  '  return { keys: keys, logs: logs };',
  '})()'
].join('\n');

async function readLogs() {
  var targets = await getJson('/json/list');
  var sws = targets.filter(function (t) {
    return t.type === 'service_worker' && /^chrome-extension:\/\//.test(String(t.url || '')) && t.webSocketDebuggerUrl;
  });
  if (!sws.length) {
    throw new Error('端口 ' + PORT + ' 上没有扩展的 service_worker 目标 —— 现场那台浏览器里扩展没装/被禁用了？');
  }
  var r = await cdp(sws[0].webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: READ_EXPR, awaitPromise: true, returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('SW 里求值抛错: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200));
  }
  var v = (r.result && r.result.value) || {};
  if (!Array.isArray(v.logs)) throw new Error('回来的不是数组：' + JSON.stringify(v).slice(0, 120));
  if (v.keys && v.keys.length !== 1) {
    console.log('⚠️ 存储回来的键有 ' + v.keys.length + ' 个（预期 1 个 runtimeLogs）—— 本工具仍然只用其中那一个');
  }
  return { logs: v.logs, swUrl: String(sws[0].url || '').slice(0, 60) };
}

function redact(obj, depth) {
  if (depth > 3) return '…';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj.length > 300 ? obj.slice(0, 300) + '…' : obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 8).map(function (x) { return redact(x, depth + 1); });
  var out = {};
  Object.keys(obj).forEach(function (k) {
    out[k] = SENSITIVE_KEY.test(k) ? '(已屏蔽)' : redact(obj[k], depth + 1);
  });
  return out;
}

function line(item, nowMs) {
  var t = Number(item && item.time) || 0;
  var ageS = t ? Math.max(0, Math.round((nowMs - t) / 1000)) : -1;
  var meta = item && item.meta ? redact(item.meta, 0) : null;
  var metaText = meta && Object.keys(meta).length ? '  ' + JSON.stringify(meta).slice(0, 240) : '';
  return '  +' + (ageS < 0 ? '?' : ageS + 's') + ' [' + String(item.level || 'info') + '] ' +
    String(item.message || '').slice(0, 160) + metaText;
}

function pick(logs) {
  var out = logs.filter(function (x) {
    if (LEVEL && String(x.level || 'info') !== LEVEL) return false;
    if (GREP && String(x.message || '').indexOf(GREP) < 0 && JSON.stringify(x.meta || '').indexOf(GREP) < 0) return false;
    return true;
  });
  return out.slice(-TAIL);
}

(async function () {
  var first = await readLogs();
  console.log('SW: ' + first.swUrl);
  console.log('日志环：共 ' + first.logs.length + ' 条（工具只读 runtimeLogs 这一个键，绝不碰同存储里的其它键）');
  if (!first.logs.length) {
    console.log('环是空的 —— 这**不是**"没有新日志"：要么刚清过、要么桥没通（页面那条 `content bridge ready` 都没进来）。');
    console.log('下一步：node tools/debug-probe.js --port=' + PORT + ' --expr="return {rev:(typeof OMITONE_CODE_REV!==\'undefined\'?OMITONE_CODE_REV:\'(无)\'),app:typeof window._xxtApp}"');
    return;
  }
  var nowMs = Date.now();
  var newest = Number(first.logs[first.logs.length - 1].time) || 0;
  console.log('最新一条距今 ' + Math.round((nowMs - newest) / 1000) + ' 秒' +
    (GREP ? '（过滤「' + GREP + '」）' : '') + '\n');
  pick(first.logs).forEach(function (x) { console.log(line(x, nowMs)); });

  if (!WATCH_MS) return;
  var lastTime = newest;
  var until = Date.now() + WATCH_MS * 1000;
  console.log('\n--- 追 ' + WATCH_MS + ' 秒（每 3 秒一轮，只打比 ' + new Date(lastTime).toLocaleTimeString() + ' 更新的）---');
  while (Date.now() < until) {
    await new Promise(function (r) { setTimeout(r, 3000); });
    var round = await readLogs();
    var fresh = round.logs.filter(function (x) { return (Number(x.time) || 0) > lastTime; });
    fresh.forEach(function (x) { lastTime = Math.max(lastTime, Number(x.time) || 0); console.log(line(x, Date.now())); });
  }
  console.log('--- 追完 ---');
})().catch(function (e) {
  console.log('失败: ' + e.message);
  process.exit(1);
});
