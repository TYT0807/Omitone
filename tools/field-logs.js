/**
 * 直读**现场**（用户那台调试浏览器）的运行日志环 —— 不用人去点弹窗里的「复制日志」。
 *
 *   node tools/field-logs.js                       // 最近 40 条
 *   node tools/field-logs.js --grep=catalog         // 只看含某串的（子串匹配，不是正则）
 *   node tools/field-logs.js --level=warn --tail=200
 *   node tools/field-logs.js --grep=rejected --width=4000   // 把某一条的取证读到底
 *   node tools/field-logs.js --watch=90             // 持续追 90 秒（每 3 秒一轮，只打新条）
 *   node tools/field-logs.js --wake                 // 问不到后台时多发**一条** ping 叫醒它（不写不跳）
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
 *
 * ## 「取不到环」现在说得出是哪一格（会话任务 #195，2026-11-21）
 *
 * 以前只有一句「重试 5 轮仍问不到扩展的 service_worker —— 这一格是读不出，可能是后台在睡，
 * 也可能扩展真被禁用」。现场那一夜（`notes/field-159-orphaned-bridge.md`）三种形状混在这一句里，
 * 于是学习页空转两小时零落地、每个想取证的窗口都被同一句话挡回去。现在：
 *
 *   1. 问不到 SW 目标 → 先走 `tools/field-bridge.js` 的判定层，把**桥断 / 后台在睡 / 没装 / 来错页**
 *      四格分开说话（桥断那一格必须把「重载扩展之后必须 F5 这一枚页面」交出去）；
 *   2. 同时换一条**读得到的路**：环的真源是 `chrome.storage.local`，任何扩展页面都读得到它
 *      （`popup/popup.js` 的 `petDiagReadLogs()` 就是这么读的）。所以只要现场**已经开着**一枚
 *      `chrome-extension://…` 页面目标，就从那一枚里读 —— 零新增动作。
 *      一枚都没有时要走 `--open-popup`：那会新开一枚后台标签再关掉，**属于动现场，要先跟人确认**。
 *   3. 环**读得到却冻住**（最新一条比 `--stale=` 还旧）是另一格：那不等于"没在刷"，
 *      现场量过的形状是 `tickEpoch` 照涨而环零新增 —— 照样去问判定层，别自己猜。
 */
'use strict';

var http = require('http');
var bridge = require('./field-bridge.js');

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
// 问不到后台时是否多发**一条** `ping`（只让后台回 `startedAt`，不写配置、不发请求、不导航）。
var WAKE = process.argv.indexOf('--wake') >= 0;
// ⚠️ 默认**不**开扩展页面那一枚标签：新开标签属于"动现场"。只有显式 --open-popup 才做，
//    且只开 `chrome-extension://<id>/popup/popup.html`，读完就关，绝不碰学习通那一枚。
var OPEN_POPUP = process.argv.indexOf('--open-popup') >= 0;
// 「环冻住」那一格的尺：最新一条超过这么多秒就单独说话（默认 180 = 地板句 120 秒的两拍）。
// ⚠️ 阈值走 safeNum：`age > NaN` 恒 false，写成 --stale=abc 会把这一闸**静默取消**（§2 #2）。
var STALE_S = safeNum(arg('stale', 180), 180);
// 一条最多打这么多字的 meta（默认 240 = 环里 200 条还能一眼扫完）。
// `--width=4000` 是用来**读某一条的完整取证**的，配合 `--grep=` 用。
function safeNum(raw, dflt) {
  var n = Number(raw);
  return n >= 1 ? n : dflt;
}

var WIDTH = safeNum(arg('width', 240), 240);
// ⚠️ 非数字必须落回默认，不许留 NaN：`json.length > NaN` 恒 false，
// 写成 `--width=abc` 会让这道闸**静默取消**、把整份 meta 原样倒进终端。
// ⚠️ 深度闸必须跟着行宽一起松。`rejects[].sig.answer` 落在第 4 层，
// 原来写死 `depth > 3` 就把批次 9-D / 10-A 争来的帧签名**全部打成 `…`** ——
// 存储侧费了三批改好的取证，在读它的这个工具里又看不见，而且无声无息。
var MAX_DEPTH = WIDTH > 240 ? 8 : 3;

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

// 问不到 SW 目标时的那一重试：每轮问两次地址（裸 /json/list 在 Edg/157 上不返回 service_worker），
// 轮与轮之间等 6 秒 —— MV3 的后台约 30 秒空闲就被回收，回收后这条目标**整个从列表消失**，
// 所以「问不到」的第一嫌疑人是后台在睡，不是扩展没装。
// ⚠️ --watch 的每一轮走 quick（只问一轮）：不然现场一旦进入"没有 SW 目标"那一形，
//    每 3 秒睡 30 秒，追日志这个动作自己就变成了负载。
async function scanSwTargets(quick) {
  var asked = ['/json/list?includeServiceWorkers=true', '/json/list'];
  var rounds = quick ? 1 : 5;
  var sws = [];
  var tries = 0;
  for (var round = 0; round < rounds && !sws.length; round++) {
    tries++;
    for (var i = 0; i < asked.length && !sws.length; i++) {
      sws = (await getJson(asked[i])).filter(function (t) {
        return t.type === 'service_worker' && /^chrome-extension:\/\//.test(String(t.url || '')) && t.webSocketDebuggerUrl;
      });
    }
    if (!sws.length && round < rounds - 1) await new Promise(function (r) { setTimeout(r, 6000); });
  }
  return { sws: sws, tries: tries };
}

async function listAll() {
  var asked = ['/json/list?includeServiceWorkers=true', '/json/list'];
  for (var i = 0; i < asked.length; i++) {
    try { return await getJson(asked[i]); } catch (e) { if (i === asked.length - 1) throw e; }
  }
  return [];
}

// 已经开着的扩展页面目标（popup / 设置页都算）——**不新建**，读到就用，读不到就回 null。
function findExtensionPageTarget(list) {
  return (list || []).filter(function (t) {
    return /^chrome-extension:\/\//.test(String(t.url || '')) && t.type === 'page' && t.webSocketDebuggerUrl;
  })[0] || null;
}

// 环的真源是存储里那一个键，任何扩展页面都读得到它（popup.js 的 petDiagReadLogs 就是这么读的）。
// 这一路是**桥断那一夜的唯一取证出口**（notes/field-159-logring-dead.md §4）：
// 现场 SW 目标不在列表时，field-logs 与技能 sw-eval.js --in=sw 同时瞎，而这里读得回来。
async function readRingViaExtensionPage(openIfMissing) {
  var hit = findExtensionPageTarget(await listAll());
  var opened = null;
  if (!hit && openIfMissing) {
    var id = await discoverExtId();
    if (!id) return null;
    var Browser = bridgeBrowserWs();
    var bw = new Browser((await getJson('/json/version')).webSocketDebuggerUrl);
    try {
      var created = await bw.send('Target.createTarget', {
        url: 'chrome-extension://' + id + '/popup/popup.html', background: true
      });
      opened = created.targetId;
      for (var i = 0; i < 12 && !hit; i++) {
        await new Promise(function (r) { setTimeout(r, 1000); });
        hit = (await listAll()).filter(function (t) { return t.id === opened && t.webSocketDebuggerUrl; })[0] || null;
      }
    } finally {
      if (opened) { try { await bw.send('Target.closeTarget', { targetId: opened }); } catch (e) {} }
      bw.close();
    }
  }
  if (!hit) return null;
  var r = await cdp(hit.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: READ_EXPR, awaitPromise: true, returnByValue: true
  });
  if (r.exceptionDetails) {
    // ⚠️ 这一格单独说话：扩展页面找到了却在里面求值抛错，与"压根没有这一枚页面"是两件事
    throw new Error('扩展页面目标（' + String(hit.url || '').slice(0, 50) + '）里求值抛错: ' +
      ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 160));
  }
  var v = (r.result && r.result.value) || {};
  if (!Array.isArray(v.logs)) return null;
  return { logs: v.logs, via: 'extension-page:' + String(hit.url || '').replace(/^chrome-extension:\/\/[a-p]{32}\//, '') };
}

// 扩展 ID 从学习页里那枚注入脚本的 src 读回来（真源，不猜）；一枚 chaoxing 页都没有就回 null。
async function discoverExtId() {
  var page = (await listAll()).filter(function (t) {
    return t.type === 'page' && /chaoxing\.com/.test(String(t.url || '')) && t.webSocketDebuggerUrl;
  })[0];
  if (!page) return null;
  var r = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: '(function(){var s=document.getElementById("xxt-page-script");' +
      'return s?String(s.src||""):"(没找到注入脚本)";})()',
    returnByValue: true
  });
  var src = r && r.result && r.result.value;
  var m = /^chrome-extension:\/\/([a-p]{32,})\//.exec(String(src || ''));
  return m ? m[1] : null;
}

// 浏览器级 ws：--open-popup 那一发要 createTarget / closeTarget，那只能在浏览器级发。
function bridgeBrowserWs() {
  return function BrowserWs(url) {
    var ws = new WebSocket(url);
    var pending = {}, seq = 0;
    var ready = new Promise(function (res, rej) {
      ws.onopen = res;
      ws.onerror = function () { rej(new Error('浏览器级 ws 握手失败')); };
    });
    this.send = function (method, params) {
      return ready.then(function () {
        return new Promise(function (res, rej) {
          var id = ++seq;
          pending[id] = function (m) { m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result); };
          setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error(method + ' 超时 15s')); } }, 15000);
          ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
      });
    };
    this.close = function () { try { ws.close(); } catch (e) {} };
  };
}

// 取不到环时的出口：把「桥断 / 在睡 / 没装 / 来错页 / 读不出」交给判定层说，不许自己猜。
async function whyNoSw(wakeResult) {
  var v = wakeResult || await bridge.probe({ port: PORT, wake: WAKE });
  var lines = ['问不到扩展的 service_worker —— 这一格现在按**桥的读数**分开说：'];
  lines.push('  verdict=' + v.verdict + (v.via ? '（via=' + v.via + '）' : '') + (v.final === false ? '（嫌疑，未下终审）' : ''));
  lines.push('  ' + v.note);
  if (v.fix) lines.push('  处置：' + v.fix);
  lines.push('  读数：worker ' + v.raw.workerListed + ' 枚 / 扩展页面 ' + v.raw.extensionPageListed +
    ' 枚 / Omitone 世界 ' + v.raw.worldCount + ' 枚（function ' + v.raw.worldsHaveFn + '、id 非空 ' + v.raw.worldsHaveId + '）');
  if (!WAKE && String(v.verdict).indexOf('suspect') >= 0) {
    lines.push('  只想把嫌疑定成事实：加 --wake（多发那一条 ping，仍然不写配置、不导航）。');
  }
  // 只在"环这条路本来可能读得通、只是没现成的扩展页面"时提 --open-popup；
  // no-page / port-down / unreadable 那三格开标签也救不回来，别给现场加没用的动作。
  if (v.raw.extensionPageListed === 0 && !OPEN_POPUP &&
      ['no-page', 'port-down', 'unreadable'].indexOf(v.verdict) < 0) {
    lines.push('  想拿到环本身：现场没有已开着的扩展页面目标，可加 --open-popup（会新开一枚再关掉，属于动现场，先确认）。');
  }
  var err = new Error(lines.join('\n'));
  err.verdict = v.verdict;
  throw err;
}

async function readLogs(quick) {
  var scan = await scanSwTargets(quick);
  var wakeResult = null;
  if (!scan.sws.length && WAKE) {
    // 叫醒那一发由判定层做（它只发一条 ping），叫醒后再扫一轮
    wakeResult = await bridge.probe({ port: PORT, wake: true });
    scan = await scanSwTargets(true);
  }
  if (scan.sws.length) {
    var r = await cdp(scan.sws[0].webSocketDebuggerUrl, 'Runtime.evaluate', {
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
    return { logs: v.logs, swUrl: String(scan.sws[0].url || '').slice(0, 60), via: 'service-worker', tries: scan.tries };
  }
  // SW 目标不在列表：先换那一条**读得到的路**，读到了就照常用，只是要把"从哪儿读的"说出口
  var alt = await readRingViaExtensionPage(OPEN_POPUP);
  if (alt) {
    alt.swUrl = '(SW 目标不在列表，本次从扩展页面目标读的)';
    alt.tries = scan.tries;
    console.log('⚠️ 问不到 SW 目标（重试 ' + scan.tries + ' 轮），本次改从 ' + alt.via +
      ' 读同一个键 runtimeLogs —— 环的内容与 SW 那一路同源，但**这不证明后台醒着**（' +
      '桥的判定见 node tools/field-bridge.js）。');
    return alt;
  }
  throw await whyNoSw(wakeResult);
}

function redact(obj, depth) {
  if (depth > MAX_DEPTH) return '…';
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
  var json = meta && Object.keys(meta).length ? JSON.stringify(meta) : '';
  // 截断必须自己说出口：一行被切掉一半和"这条日志本来就这么短"在屏幕上长得一模一样。
  var metaText = '';
  if (json) {
    metaText = '  ' + (json.length > WIDTH
      ? json.slice(0, WIDTH) + '…（这条还有 ' + (json.length - WIDTH) + ' 字没打，--width=' + (json.length + 1) + ' 看全）'
      : json);
  }
  return '  +' + (ageS < 0 ? '?' : ageS + 's') + ' [' + String(item.level || 'info') + '] ' +
    String(item.message || '').slice(0, 160) + metaText;
}

// ⚠️ 谓词单独抽出来：--grep / --level 必须同时管住「打印哪几条」和「报哪个数」。
//    原来计数那句拿的是**未过滤**的环尾时间，却在同一行后面挂「（过滤「X」）」
//    —— 四条不同 needle 报出同一个「最新一条距今 22 秒」就是这么来的（AGENTS §2 #22 同族：
//    会误报的读数比没有读数更害人）。
function matchesFilter(x) {
  if (LEVEL && String(x.level || 'info') !== LEVEL) return false;
  if (GREP && String(x.message || '').indexOf(GREP) < 0 && JSON.stringify(x.meta || '').indexOf(GREP) < 0) return false;
  return true;
}

function pick(logs) {
  return logs.filter(matchesFilter).slice(-TAIL);
}

// 把「筛了什么、命中几条、最新一条命中距今多久」当一句话交出去；没筛就不打这行。
function reportFilter(allLogs, nowMs) {
  if (!GREP && !LEVEL) return;
  var hit = allLogs.filter(matchesFilter);
  var label = (GREP ? "「" + GREP + "」" : '') + (GREP && LEVEL ? ' + ' : '') + (LEVEL ? 'level=' + LEVEL : '');
  var tail = '（环内共 ' + allLogs.length + ' 条）';
  if (!hit.length) {
    console.log('筛选 ' + label + '：命中 0 条' + tail);
    console.log('  ⚠️ 0 条不等于「没发生过」：环只留最后 ' + allLogs.length + ' 条；' +
      '也可能是 needle 与日志真名不符 —— 先回源码 grep emitRuntimeLog 把原句抄出来，' +
      '且 --grep 是子串不是正则，写成 a|b 恒 0（AGENTS §2 #22）。');
    return;
  }
  var newestHit = Number(hit[hit.length - 1].time) || 0;
  console.log('筛选 ' + label + '：命中 ' + hit.length + ' 条' + tail +
    '，最新命中距今 ' + Math.round((nowMs - newestHit) / 1000) + ' 秒' +
    (hit.length > TAIL ? '；下面只打最后 ' + TAIL + ' 条（--tail= 可放宽）' : ''));
}

// 环读得到、却像冻住了 —— 这是与"取不到环"**另一格**（notes/field-159-logring-dead.md）：
// 现场量过的形状是页面 `tickEpoch` 照涨、环里零新增，而当时工具只会打印一句"最新一条距今 759 秒"，
// 读的人要么当"这门课刷完了"、要么当"扩展停了"，两种都错。
// 「环冻住」那一格的尺，抽成纯函数：--selftest 要能在不起浏览器的前提下钉住它。
// ⚠️ 用 `>` 而不是 `>=`：地板句自己每 120 秒一发，默认档 180 就是"两拍都没出话"。
function isRingStale(ageS, forced) {
  return forced === true || (Number(ageS) > STALE_S);
}

async function reportStaleRing(ageS, forced) {
  if (!isRingStale(ageS, forced)) return;
  console.log(forced === true
    ? '⚠️ 环是空的 —— 这一格单独问桥，不许读成"没有新日志"。'
    : '⚠️ 环像冻住了：最新一条已 ' + ageS + ' 秒没动（--stale= 改这一档，默认 ' + STALE_S + '）。');
  console.log('   这一格**不等于没在刷、也不等于刷完了**：页面自己还在 tick 时，缺的是"发了没落地"那一截。');
  try {
    var v = await bridge.probe({ port: PORT, wake: WAKE });
    console.log('   桥的判定：verdict=' + v.verdict + (v.via ? '（via=' + v.via + '）' : '') +
      (v.final === false ? '（嫌疑，未下终审）' : ''));
    console.log('     ' + v.note);
    if (v.fix) console.log('     处置：' + v.fix);
  } catch (e) {
    // 问不出桥的读数也要单独占一格，不许因为探针失败就把上面那句"冻住"撤回
    console.log('     桥问不出去：' + String((e && e.message) || e).slice(0, 120) + ' —— 这一格是读不出，不是"环没事"。');
  }
}

// 取不到环时的退出码 —— **三格分家**（AGENTS §2 #12：读不出不许塌进"坏了"，也不许塌进"没事"）：
//   1 = 桥断 / 没注入（要人动手；`npm run field-bridge` 同一形也回 1）
//   2 = 读不出（来错页 / CDP 没开 / attach 没成 —— 不能当成"现场没问题"）
//   3 = 工具自己的问题（没 verdict 还失败，别拿它当现场结论）
// ⚠️ 0 永远不出现在这一族：**"没拿到东西"最贵的读法就是"看起来没事"**。
var EXIT_BY_VERDICT = {
  invalidated: 1, 'invalidated-suspect': 1, 'no-world': 1,
  'no-page': 2, unreadable: 2, 'port-down': 2, alive: 2, 'alive-suspect': 2, 'alive-worker-unlisted': 2
};
function exitForError(e) {
  var v = e && e.verdict;
  if (v && EXIT_BY_VERDICT[v] !== undefined) return EXIT_BY_VERDICT[v];
  if (v) return 2;                       // 判定层将来加新格时**默认落"读不出"**，不许落 0/1
  return 3;
}

function main() {
  return (async function () {
    var first = await readLogs();
    console.log('SW: ' + first.swUrl);
    console.log('日志环：共 ' + first.logs.length + ' 条（工具只读 runtimeLogs 这一个键，绝不碰同存储里的其它键）');
    if (!first.logs.length) {
      console.log('环是空的 —— 这**不是**"没有新日志"：要么刚清过，要么页面那条 `content bridge ready` 压根没送进来。');
      console.log('后者现在单独一格，去问桥（不猜）：node tools/field-bridge.js' + (WAKE ? ' --wake' : ''));
      await reportStaleRing(0, true);
      console.log('下一步：node tools/debug-probe.js --port=' + PORT + ' --expr="return {rev:(typeof OMITONE_CODE_REV!==\'undefined\'?OMITONE_CODE_REV:\'(无)\'),app:typeof window._xxtApp}"');
      return;
    }
    var nowMs = Date.now();
    var newest = Number(first.logs[first.logs.length - 1].time) || 0;
    var newestAge = Math.round((nowMs - newest) / 1000);
    console.log('环内最新一条距今 ' + newestAge + ' 秒（没过滤，整环最后一条）');
    await reportStaleRing(newestAge);
    reportFilter(first.logs, nowMs);
    console.log('');
    pick(first.logs).forEach(function (x) { console.log(line(x, nowMs)); });

    if (!WATCH_MS) return;
    var lastTime = newest;
    var until = Date.now() + WATCH_MS * 1000;
    console.log('\n--- 追 ' + WATCH_MS + ' 秒（每 3 秒一轮，只打比 ' + new Date(lastTime).toLocaleTimeString() + ' 更新的）---');
    while (Date.now() < until) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      // ⚠️ 追日志的每一轮走 quick：现场进入"没有 SW 目标"那一形时，5 轮 × 6 秒会让这一发自己变成负载
      var round = await readLogs(true);
      var fresh = round.logs.filter(function (x) { return (Number(x.time) || 0) > lastTime && matchesFilter(x); });
      fresh.forEach(function (x) { lastTime = Math.max(lastTime, Number(x.time) || 0); console.log(line(x, Date.now())); });
    }
    console.log('--- 追完 ---');
  })().catch(function (e) {
    console.log('失败: ' + (e && e.message ? e.message : String(e)));
    process.exit(exitForError(e));
  });
}

// ---------------------------------------------------------------------------
// 逐格对照（--selftest）：纯函数，不起浏览器、不碰现场。每格只在它自己身上红。
// ---------------------------------------------------------------------------
function selftest() {
  var bad = [];
  var cells = 0;
  // ⚠️ 比的是 JSON 形状，不是引用：有两格交回的是数组（token/cookie 同族、阈值 0/负数），
  //    拿 !== 比两个数组**恒红** —— 那正是"会误报的守卫"（AGENTS §5）。
  // ⚠️ 格数**由这一发自己数出来**，不写死：手抄的格数就是批次 142 那一族。
  function eq(label, got, want) {
    cells++;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad.push(label + ' 期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
    }
  }

  // 1. 退出码三格分家 —— 这一族最贵的读法是"看起来没事"
  eq('桥断的退出码', exitForError({ verdict: 'invalidated' }), 1);
  eq('桥断嫌疑也是 1（处置相同：F5）', exitForError({ verdict: 'invalidated-suspect' }), 1);
  eq('没注入是 1', exitForError({ verdict: 'no-world' }), 1);
  eq('来错页是 2（读不出，不当故障也不当没事）', exitForError({ verdict: 'no-page' }), 2);
  eq('CDP 没开是 2', exitForError({ verdict: 'port-down' }), 2);
  eq('attach 没成是 2', exitForError({ verdict: 'unreadable' }), 2);
  eq('没有 verdict 的失败是 3（工具自己的问题）', exitForError(new Error('boom')), 3);
  eq('判定层将来新增的 verdict 默认落"读不出"，不许落 0', exitForError({ verdict: '某一新格' }), 2);
  eq('这一族永远不许回 0', [ 'invalidated', 'no-page', 'alive', 'no-world', 'port-down', 'unreadable' ]
    .map(exitForError).indexOf(0), -1);

  // 2. 兜底那一格：只认**已经开着的扩展页面**，不许把 SW 目标或学习通页面当成它
  var list = [
    { type: 'service_worker', url: 'chrome-extension://aaaa/popup/popup.html', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'page', url: 'https://mooc1.chaoxing.com/x', webSocketDebuggerUrl: 'ws://p' },
    { type: 'page', url: 'chrome-extension://aaaa/popup/popup.html', webSocketDebuggerUrl: 'ws://ext' }
  ];
  eq('拿到的是那枚扩展页面目标（不是 SW、不是课程页）',
    (findExtensionPageTarget(list) || {}).webSocketDebuggerUrl, 'ws://ext');
  eq('只有 SW 目标时兜底路读不出（回 null，不假装读到）',
    findExtensionPageTarget([list[0]]), null);
  eq('列表为空时不许抛（那是"没有这一枚页面"那一格）',
    findExtensionPageTarget([]), null);
  eq('列表读不出（undefined）同样回 null', findExtensionPageTarget(null), null);

  // 3. 敏感键屏蔽：环里可能带页面文字，也可能带看起来像凭据的东西
  eq('apiKey 这个键的值整个打掉', JSON.stringify(redact({ apiKey: 'sk-live-123', qid: '9' }, 0)),
    JSON.stringify({ apiKey: '(已屏蔽)', qid: '9' }));
  eq('token / cookie 同族', [redact({ token: 't' }, 0).token, redact({ Cookie: 'c' }, 0).Cookie],
    ['(已屏蔽)', '(已屏蔽)']);
  eq('普通键不许打掉（打掉就等于取证看不见）', redact({ answer: 'A' }, 0).answer, 'A');

  // 4. 截断必须自己说出口（否则"被切一半"与"本来就这么短"同形）
  var wide = WIDTH; WIDTH = 40;
  var s = line({ time: Date.now(), level: 'info', message: 'x', meta: { a: 'y'.repeat(60) } }, Date.now());
  WIDTH = wide;
  eq('截断那一句要说还剩多少字没打 + 怎么看全', /还有 (\d+) 字没打，--width=(\d+) 看全/.test(s), true);

  // 5. --stale 的 NaN 卫生：非数字必须落回默认，`age > NaN` 恒 false 会把这一闸静默取消
  eq('非数字落回默认', safeNum('abc', 180), 180);
  eq('0 与负数不许当阈值（那等于关掉这一格）', [safeNum('0', 180), safeNum('-5', 180)], [180, 180]);
  eq('正常数照收', safeNum('60', 180), 60);
  var keepStale = STALE_S; STALE_S = 180;
  eq('179 秒不算冻住（地板句每 120 秒一发）', isRingStale(179), false);
  eq('181 秒算冻住', isRingStale(181), true);
  eq('空环 forced 单独走这一格（不看秒数）', isRingStale(0, true), true);
  STALE_S = keepStale;

  console.log('读环侧逐格对照：' + cells + ' 格（退出码分家 / 兜底选目标 / 敏感键屏蔽 / 截断自证 / 阈值卫生）');
  console.log('对照格数: ' + cells);
  if (bad.length) {
    console.log('自检：' + (cells - bad.length) + ' / ' + cells + ' 格通过 —— 以下 ' + bad.length + ' 条：');
    bad.forEach(function (b) { console.log('  [FAIL] ' + b); });
    return 1;
  }
  console.log('自检：' + cells + ' / ' + cells + ' 格通过');
  return 0;
}

if (require.main === module) {
  if (process.argv.indexOf('--selftest') !== -1) process.exitCode = selftest();
  else main();
}

module.exports = { exitForError: exitForError, EXIT_BY_VERDICT: EXIT_BY_VERDICT,
  findExtensionPageTarget: findExtensionPageTarget, isRingStale: isRingStale, safeNum: safeNum,
  selftest: selftest, whyNoSw: whyNoSw };


