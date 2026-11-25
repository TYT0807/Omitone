#!/usr/bin/env node
/**
 * 把「现场那枚页面与扩展到底连不连着」量成**分开的格子** —— 这一件是「读不出」那一族的真源。
 *
 *   node tools/field-bridge.js                       纯只读：只看，一条消息都不发
 *   node tools/field-bridge.js --wake                只多发**一条** ping（不写配置、不发请求、不导航）
 *   node tools/field-bridge.js --url-match=space     换一枚页来量（默认学习页）
 *   node tools/field-bridge.js --selftest            跑内置逐格对照，不碰现场
 *
 * 为什么仓库里要有这一件（2026-11-21 现场，notes/field-159-orphaned-bridge.md）：
 * `tools/field-logs.js` 取不到日志时只有一句「问不到扩展的 service_worker —— 这一格是读不出，
 * 可能是后台在睡，也可能扩展真被禁用」。**三种形状的处置完全不同**（等 / F5 / 重装），
 * 压成一句就永远在说"读不出"，于是那一夜学习页空转了两小时零落地（`memo.rounds` 32→146）
 * 而每一个想取证的窗口都被这句话挡回去（AGENTS §2 #12「读不出单独占一格」的那一族的现场版）。
 *
 * 三格分开的尺（都在现场量过，见上面那份台账 §2 第 6–8 格）：
 *   A workerListed      扩展 service worker 在不在 CDP 目标列表里 —— **0 枚只是 MV3 的正常回收**，
 *                       它自己一句都不说明"刷课停了"
 *   B 世界读数           页面里非默认上下文（`name` 形如 `Omitone-1.3.1`）有几枚，
 *                       每枚各自读 `typeof chrome.runtime.sendMessage` 与 `chrome.runtime.id`，**不调用**
 *   C verdict           `alive` / `invalidated`（**桥断了**）/ `no-world`（没装或没注入）/
 *                       `no-page` / `unreadable` / `port-down`，纯只读时只许给 `*-suspect`
 *
 * ⚠️ 「桥断了」的现场形状（不是"旧构建"，那一格已被页面 rev 归因排掉）：
 *   `sendMessage` 仍是 `function`、`chrome.runtime.id` 读回**空串**、真发一条 ping 当场抛
 *   `Extension context invalidated.` —— 成因是 AGENTS §3.3 第 3 步：**只重载扩展不 F5 页面**。
 *   所以 `invalidated` 那一格必须把「重载扩展之后必须 F5 这一枚页面」那句话交出去；
 *   丢掉那句话，这一格就退化成又一句"读不出"。
 *
 * ⚠️ 这一件**不改任何东西**：`--wake` 那一条 `ping` 只让后台回一个 `startedAt`。
 *   要真把现场修好得重载扩展 + F5 —— 那是导航，超出探针授权，要先跟人确认。
 *
 * 与技能侧 `bridge-check.js` 的分工：那一件是排查现场的即席探针（第 159 轮升格），
 * 这一件是**仓库里挂闸的那一份** —— `tools/field-logs.js` 与 `npm run check` 都吃这里的 `classify()`。
 * 两份判据必须同形；改这里要顺手核那一份，别让它变成"只有探针知道该怎么说"。
 */
'use strict';

var http = require('http');

var DEFAULT_MATCH = 'mooc1.chaoxing.com/mycourse/studentstudy';
var FALLBACK_MATCH = 'chaoxing.com';
var MAX_CONSOLE_WAIT_MS = 30000;
var BRIDGE_CONSOLE_MESSAGES = [
  'runtime log unavailable; study continues',
  'scope not granted after page change',
  'scope lost, bridge stopped'
];

// 退出码：0 = 桥能用；1 = 桥断/没注入（要人动手）；2 = 读不出（**不许读成"没事"**，也不许读成"坏了"）
var EXIT = { ok: 0, action: 1, unreadable: 2 };

function arg(name, dflt) {
  var pre = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  return dflt;
}

function normalizeConsoleWaitMs(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_CONSOLE_WAIT_MS, Math.max(0, Math.floor(n)));
}

function bridgeConsoleRecord(args) {
  var strings = (args || []).map(function (a) {
    return a && a.type === 'string' ? String(a.value || '') : '';
  });
  var message = '';
  BRIDGE_CONSOLE_MESSAGES.forEach(function (name) {
    var prefix = '[Omitone] ' + name;
    if (!message && strings.some(function (s) {
      return s.indexOf(prefix) === 0 && /^(?:$|\s|\[)/.test(s.slice(prefix.length));
    })) message = name;
  });
  if (!message) return null;
  var joined = strings.join(' ');
  var verdictMatch = joined.match(/(?:^|\s|\[)verdict=([a-z-]+)(?=\s|\]|$)/);
  var reasonMatch = joined.match(/reason=([^\]]*?)(?=\s+verdict=|\s*\]|$)/);
  var reason = String((reasonMatch && reasonMatch[1]) || '(未回原因)')
    .replace(/https?:\/\/\S+/gi, '(url omitted)').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    message: message,
    verdict: verdictMatch ? verdictMatch[1] : 'unparsed',
    reason: reason || '(未回原因)'
  };
}

function summarizeConsoleRecords(records) {
  var seen = (records || []).filter(Boolean);
  var last = seen[seen.length - 1] || null;
  return {
    capture: 'enabled',
    verdict: last ? last.verdict : 'not-observed',
    message: last ? last.message : '',
    reason: last ? last.reason : '',
    count: seen.length
  };
}

// ---------------------------------------------------------------------------
// 判定层：纯函数，读数进、格子出。现场那一发与 --selftest 的合成读数走的是同一把尺。
// ---------------------------------------------------------------------------

/**
 * g = {
 *   portOk, attachErr,                    // 探针自己能不就连上
 *   workerListed, extensionPageListed,    // A 两格（枚数）
 *   pageFound,                            // 有没有 url 命中的页面目标
 *   matched,                              // 'exact' | 'fallback' | 'none'
 *   worldCount, worldsHaveFn, worldsHaveId,   // B 三格
 *   wakeAllowed, pingTried, pingOk, pingErr   // C 那一发
 * }
 */
function classify(g) {
  if (!g || g.portOk === false) {
    return grid('port-down', 'unreadable',
      '端口上问不到 CDP —— 现场调试浏览器没开（或没带 --remote-debugging-port）。' +
      '这一格只说"量不到"，不说"没在刷"。', g);
  }
  if (g.attachErr) {
    return grid('unreadable', 'unreadable',
      '页面目标找到了，但 attach 求值没成：' + String(g.attachErr).slice(0, 120) +
      ' —— 目标可能刚被回收，重试即可，别据此定性。', g);
  }
  if (!g.pageFound) {
    return grid('no-page', 'unreadable',
      '没有 url 命中 ' + (g.urlMatch || DEFAULT_MATCH) + ' 的页面目标。' +
      '这一格**既不等于桥断、也不等于没在刷**：现场可能停在门户、目录页，或那一枚已经被人关掉。', g);
  }

  // 桥的三格先判，再看 worker —— worker 不在列表**永远不是**桥断的理由（§2 #12）
  var bridge, verdict, via = '', final = true, note = '';

  if (g.worldCount === 0) {
    bridge = 'no-world';
    verdict = 'no-world';
    note = g.workerListed > 0
      ? '后台醒着、这一页里却没有一枚 Omitone 的 content script 世界 —— 扩展装着，是这一页没注入' +
        '（不是 all_frames，或那一枚压根不是学习通课程页）。处置是**换页/重开这一页**，不是重装。'
      : '页面里没有 content script 世界，后台也不在列表里，扩展页面目标 ' + (g.extensionPageListed || 0) +
        ' 枚 —— 这才轮到「扩展没装或被禁用」那一格（`edge://extensions` 看一眼）。';
  } else if (g.pingTried && g.pingOk) {
    bridge = 'alive';
    verdict = g.workerListedAfter !== undefined && !g.workerListedAfter ? 'alive-worker-unlisted' : 'alive';
    final = g.wakeAllowed;
    note = verdict === 'alive-worker-unlisted'
      ? '桥能用（ping 答上来了），可 worker 目标仍不在列表里 —— 这一格说明"能不能读存储"与"列表认不认得出"是两件事，' +
        '读环那一发可以照走（见 tools/field-logs.js 的扩展页面兜底）。'
      : '桥活着：' + g.worldCount + ' 枚世界里有 ' + g.worldsHaveFn + ' 枚还发得出 sendMessage，ping 答上了。';
  } else if (g.pingTried && /invalidated/i.test(String(g.pingErr || ''))) {
    bridge = 'invalidated';
    verdict = 'invalidated';
    via = 'ping-throw';
    note = '那一发 `ping` 当场抛「Extension context invalidated.」—— 页面还在跑、桥已经死了。';
  } else if (g.worldsHaveFn === 0) {
    bridge = 'invalidated';
    verdict = 'invalidated';
    via = 'namespace-stripped';
    note = g.worldCount + ' 枚 Omitone 世界里 `chrome.runtime.sendMessage` **一枚都不是函数**了 —— ' +
      '断连时 chrome 命名空间被整个剥掉，这条不需要发东西就能判。';
  } else if (g.wakeAllowed && g.pingTried) {
    bridge = 'unreadable';
    verdict = 'unreadable';
    note = 'ping 发出去了，回来的既不是 ok 也不是 invalidated：' + String(g.pingErr || g.pingRaw || '(空)').slice(0, 120) +
      ' —— 单独占一格，不许塌进桥断，也不许塌进活着。';
  } else if (g.wakeAllowed) {
    bridge = 'unreadable';
    verdict = 'unreadable';
    note = '加了 --wake 却压根没发出 ping（' + g.worldCount + ' 枚世界没有一枚读到 function，' +
      '也没有一枚真抛出）—— 见 worlds 每格读数，别读成"桥断"。';
  } else if (g.worldsHaveId === 0) {
    bridge = 'invalidated';
    verdict = 'invalidated-suspect';
    via = 'id-empty';
    final = false;
    note = g.worldCount + ' 枚世界的 `chrome.runtime.id` **全读回空串**，而 `sendMessage` 还是函数 —— ' +
      '这是断连的形状，但纯只读轮不下终审：要加 --wake 发那一条 ping 看它抛不抛（AGENTS §2 #12：嫌疑是嫌疑、事实是事实）。';
  } else {
    bridge = 'alive';
    verdict = 'alive-suspect';
    final = false;
    note = '没加 --wake，只给嫌疑：' + g.worldsHaveId + '/' + g.worldCount + ' 枚世界读得到非空 `runtime.id` —— ' +
      '倾向"桥能用"。（这一格存在的意义：只有 id 那一格时，桥断与在睡会被同一句话挡回去。）';
  }

  var out = grid(verdict, bridge, note, g);
  out.via = via;
  out.final = final;
  out.workerListed = g.workerListed || 0;
  out.extensionPageListed = g.extensionPageListed || 0;
  out.worldCount = g.worldCount || 0;
  out.matched = g.matched || 'exact';
  if (verdict === 'invalidated' || verdict === 'invalidated-suspect') {
    // ⚠️ 这一句是给**人**看的出口，也是第 37 项要对着比的那一句：删掉它，这一格就又变成"读不出"
    out.fix = '重载扩展之后必须 F5 这一枚页面（AGENTS §3.3 第 3 步）。F5 是导航，超出探针授权，要先确认。';
  } else if (verdict === 'no-world') {
    out.fix = '先 `edge://extensions` 看扩展在不在、开没开；在的话这一页重开一次（那是导航，要先确认）。';
  } else if (verdict === 'alive-worker-unlisted') {
    out.fix = '不用管 worker 列表：MV3 约 30 秒空闲就回收。读环走扩展页面那一枚目标（tools/field-logs.js）。';
  } else if (verdict === 'alive' || verdict === 'alive-suspect') {
    out.fix = '';
  } else {
    out.fix = '这一格是"读不出"：重试或换一枚页量，别把它当阴性，也别把它当故障。';
  }
  return out;
}

function grid(verdict, bridge, note, g) {
  var evidence = summarizeConsoleRecords(g && g.consoleRecords);
  evidence.waitMs = normalizeConsoleWaitMs(g && g.consoleWaitMs);
  evidence.capture = g && g.portOk !== false && g.pageFound && !g.attachErr ? 'enabled' : 'unavailable';
  return { verdict: verdict, bridge: bridge, note: note, exit: exitFor(verdict), consoleEvidence: evidence };
}

function exitFor(verdict) {
  if (verdict === 'alive' || verdict === 'alive-suspect' || verdict === 'alive-worker-unlisted') return EXIT.ok;
  if (verdict === 'invalidated' || verdict === 'invalidated-suspect' || verdict === 'no-world') return EXIT.action;
  return EXIT.unreadable;   // no-page / unreadable / port-down —— 读不出单独一个码，别和"坏了"共用
}

// ---------------------------------------------------------------------------
// 现场层：CDP 只读探针（默认一条消息都不发）
// ---------------------------------------------------------------------------

function makeGetJson(port) {
  return function getJson(p) {
    return new Promise(function (res, rej) {
      var req = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 8000 }, function (r) {
        var b = '';
        r.on('data', function (d) { b += d; });
        r.on('end', function () {
          try { res(JSON.parse(b)); } catch (e) { rej(new Error('端口 ' + port + ' 上不是 CDP：' + String(b).slice(0, 60))); }
        });
      });
      req.on('error', function (e) { rej(new Error('连不上 127.0.0.1:' + port + '（' + e.message + '）')); });
      req.on('timeout', function () { req.destroy(); rej(new Error('CDP HTTP 超时: ' + p)); });
    });
  };
}

/** 一次 ws 一个调用；页面目标可以直接吃 Runtime.evaluate。 */
function oneShot(wsUrl, method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    var timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error((method || 'ws') + ' 超时 ' + (timeoutMs || 15000) + 'ms'));
    }, timeoutMs || 15000);
    ws.onopen = function () { ws.send(JSON.stringify({ id: 1, method: method, params: params || {} })); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (m.error) return reject(new Error(m.error.message));
      resolve(m.result);
    };
    ws.onerror = function () { clearTimeout(timer); reject(new Error('WebSocket 握手失败（目标可能刚被回收，重试即可）')); };
  });
}

// 只读那一发：读 sendMessage 的类型与 runtime.id —— **不调用**
var READ_BRIDGE = '[typeof (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage),' +
  ' String((globalThis.chrome && chrome.runtime && chrome.runtime.id) || "")]';
// --wake 才发的这一发：只让后台回 startedAt
var SEND_PING = '(async () => { try { const r = await chrome.runtime.sendMessage({ type: "ping" });' +
  ' return { ok: 1, startedAt: (r && r.startedAt) || "(回包没有 startedAt)" }; }' +
  ' catch (e) { return { ok: 0, err: String((e && e.message) || e) }; } })()';

/**
 * 一次会话：Runtime.enable 收执行上下文与控制台事件，再逐枚非默认世界读桥。
 * 这里的 `contexts` 事件收集是必需的 —— 世界枚数（现场实测 3→8 枚）本身就是取证。
 * console 只留三条已知诊断的 canonical 字段；`consoleWaitMs` 默认 0，显式等待也封顶 30 秒。
 */
function readWorlds(wsUrl, wakeAllowed, timeoutMs, consoleWaitMs) {
  var waitMs = normalizeConsoleWaitMs(consoleWaitMs);
  return new Promise(function (resolve, reject) {
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    var nextId = 0, pending = {}, contexts = [], consoleRecords = [], settled = false;
    var timer = setTimeout(function () {
      finish(new Error('会话超时（' + (timeoutMs || 60000) + 'ms）'));
    }, timeoutMs || 60000);
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }
    function send(method, params) {
      return new Promise(function (res, rej) {
        var my = ++nextId;
        pending[my] = { res: res, rej: rej };
        ws.send(JSON.stringify({ id: my, method: method, params: params || {} }));
      });
    }
    function evalIn(contextId, expr) {
      return send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, contextId: contextId })
        .then(function (r) {
          if (r.exceptionDetails) {
            var d = r.exceptionDetails.exception || {};
            return { err: String(d.description || r.exceptionDetails.text || '抛了') };
          }
          return { val: r.result && r.result.value };
        });
    }
    ws.onopen = function () {
      ws.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && pending[m.id]) {
          var p = pending[m.id];
          delete pending[m.id];
          if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
        } else if (m.method === 'Runtime.executionContextCreated') {
          var c = m.params.context;
          contexts.push({ id: c.id, name: c.name || '(无名)', origin: c.origin,
            isDefault: !!(c.auxData && c.auxData.isDefault) });
        } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warn') {
          var record = bridgeConsoleRecord(m.params.args);
          if (record) consoleRecords.push(record);
        }
      };
      ws.onerror = function () { finish(new Error('WebSocket 握手失败')); };
      send('Runtime.enable')
        .then(function () { return new Promise(function (r) { setTimeout(r, 400); }); })
        .then(function () {
          // ⚠️ "只发一条"要用**闭包变量**钉，不许挂在 chain 上：chain 每一轮都被重新赋值，
          //    挂上去的那个旗子下一轮就看不见 —— 那等于对每一枚世界各发一条 ping，把探针授权越过去。
          var pingSent = false;
          var rows = [];
          var chain = Promise.resolve();
          contexts.filter(function (c) { return !c.isDefault; }).forEach(function (c) {
            chain = chain.then(function () {
              if (!/Omitone|chrome-extension:\/\//.test(c.name + '|' + c.origin)) return;
              return evalIn(c.id, READ_BRIDGE).then(function (r) {
                var row = { ctx: c.id, name: c.name, read: r.val || null, err: r.err || '' };
                rows.push(row);
                if (!wakeAllowed || pingSent) return;
                if (r.val && r.val[0] === 'function') {
                  pingSent = true;
                  return evalIn(c.id, SEND_PING).then(function (w) { row.ping = w.val || { ok: 0, err: w.err }; });
                }
              });
            });
          });
          return chain.then(function () {
            if (!waitMs) return rows;
            return new Promise(function (r) { setTimeout(r, waitMs); }).then(function () { return rows; });
          });
        })
        .then(function (rows) { finish(null, { worlds: rows, consoleRecords: consoleRecords }); },
          function (e) { finish(e); });
    };
    ws.onerror = function () { finish(new Error('WebSocket 握手失败')); };
  });
}

/**
 * probe(opts) → { readings, verdict 对象, worlds 行数, raw }
 * opts: { port, urlMatch, wake, timeout, consoleWaitMs }
 * ⚠️ 纯只读：默认只读 DOM/全局量，一条消息都不发；`wake:true` 才多发那一条 ping。
 * consoleWaitMs 默认 0；显式等待只多等新事件，不回填 CDP 连接前的历史。
 */
function probe(opts) {
  opts = opts || {};
  var port = Number(opts.port || process.env.OMITONE_DEBUG_PORT || 9334);
  var want = String(opts.urlMatch || DEFAULT_MATCH);
  var wake = !!opts.wake;
  var consoleWaitMs = normalizeConsoleWaitMs(opts.consoleWaitMs);
  var getJson = makeGetJson(port);
  var r = { urlMatch: want, wakeAllowed: wake, portOk: true,
    workerListed: 0, extensionPageListed: 0, pageFound: false, matched: 'none',
    worldCount: 0, worldsHaveFn: 0, worldsHaveId: 0, pingTried: false, pingOk: false, pingErr: '',
    worlds: [], consoleRecords: [], consoleWaitMs: consoleWaitMs };

  function pickPages(list) {
    return list.filter(function (t) {
      return t.type === 'page' && String(t.url || '').indexOf(want) >= 0 && t.webSocketDebuggerUrl;
    });
  }

  return listTargetsOrThrow(getJson)
    .then(function (list) {
      r.workerListed = list.filter(function (t) {
        return t.type === 'service_worker' && /^chrome-extension:\/\//.test(String(t.url || ''));
      }).length;
      r.extensionPageListed = list.filter(function (t) {
        return /^chrome-extension:\/\//.test(String(t.url || '')) && t.type !== 'service_worker';
      }).length;
      var pages = pickPages(list);
      if (pages.length) r.matched = 'exact';
      else {
        // 学习页不在 → 换一枚 chaoxing 页量，并把"来错页"单独说出口（不等于桥断，也不等于没在刷）
        pages = list.filter(function (t) {
          return t.type === 'page' && String(t.url || '').indexOf(FALLBACK_MATCH) >= 0 && t.webSocketDebuggerUrl;
        });
        if (pages.length) r.matched = 'fallback';
      }
      r.pageFound = pages.length > 0;
      if (!r.pageFound) return null;
      r.pageTitle = String(pages[0].title || '').slice(0, 44);
      r.pageUrl = String(pages[0].url || '').slice(0, 80);
      return readWorlds(pages[0].webSocketDebuggerUrl, wake, opts.timeout, consoleWaitMs).then(function (got) {
        r.worlds = got.worlds;
        r.consoleRecords = got.consoleRecords;
        var rows = got.worlds;
        r.worldCount = rows.length;
        rows.forEach(function (x) {
          if (x.read && x.read[0] === 'function') r.worldsHaveFn++;
          if (x.read && String(x.read[1] || '') !== '') r.worldsHaveId++;
          if (x.ping) { r.pingTried = true; if (x.ping.ok === 1) r.pingOk = true; else r.pingErr = String(x.ping.err || ''); }
        });
        return null;
      }, function (e) { r.attachErr = String((e && e.message) || e); });
    })
    .then(function () {
      // ping 答上来之后再看一次列表：那一格区分 alive 与 alive-worker-unlisted
      if (r.pingOk) {
        return listTargetsOrThrow(getJson).then(function (list) {
          r.workerListedAfter = list.filter(function (t) {
            return t.type === 'service_worker' && /^chrome-extension:\/\//.test(String(t.url || ''));
          }).length;
        });
      }
    })
    .then(function () {
      r.urlMatchUsed = r.matched === 'fallback' ? FALLBACK_MATCH : want;
      var v = classify(r);
      v.raw = r;
      return v;
    })
    .catch(function (e) {
      r.portOk = false;
      r.portErr = String((e && e.message) || e);
      var v = classify(r);
      v.raw = r;
      return v;
    });
}

function listTargetsOrThrow(getJson) {
  // ⚠️ 两次都问：裸 /json/list 在 Edg/157 上不返回 service_worker（口径同 field-logs.js）
  return getJson('/json/list?includeServiceWorkers=true')
    .catch(function () { return getJson('/json/list'); })
    .then(function (list) {
      if (!Array.isArray(list)) throw new Error('目标列表回来的不是数组');
      return list;
    });
}

// ---------------------------------------------------------------------------
// 逐格对照：每格只在它自己身上红（AGENTS §2 #9 / 第 33 项的手法）
// ---------------------------------------------------------------------------

function consoleRecordCell(why, args, want) {
  return {
    why: why,
    run: function () {
      var got = bridgeConsoleRecord(args);
      var bad = [];
      if (!want) {
        if (got !== null) bad.push('随机或形似诊断的 console 也被收进来了：' + JSON.stringify(got));
      } else if (!got) {
        bad.push('这条已知诊断没被识别');
      } else {
        Object.keys(want).forEach(function (k) {
          if (got[k] !== want[k]) bad.push(k + ' 期望 ' + JSON.stringify(want[k]) + '，实际 ' + JSON.stringify(got[k]));
        });
      }
      return bad;
    }
  };
}

var CELLS = [
  { why: '桥能用：ping 答上、worker 在列表 —— 唯一该给 0 的那格',
    g: { portOk: true, workerListed: 1, pageFound: true, worldCount: 2, worldsHaveFn: 2, worldsHaveId: 2,
      wakeAllowed: true, pingTried: true, pingOk: true },
    want: 'alive', exit: 0, final: true, fixHas: null },
  { why: 'MV3 正常回收：worker 不在列表，桥却答得上来 —— 不许读成桥断',
    g: { portOk: true, workerListed: 0, extensionPageListed: 0, pageFound: true, worldCount: 2, worldsHaveFn: 2,
      worldsHaveId: 2, wakeAllowed: true, pingTried: true, pingOk: true, workerListedAfter: 0 },
    want: 'alive-worker-unlisted', exit: 0, final: true, fixHas: 'MV3' },
  { why: '现场 159 那一格：ping 当场抛 Extension context invalidated → 桥断（via=ping-throw）',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 8, worldsHaveFn: 1, worldsHaveId: 0,
      wakeAllowed: true, pingTried: true, pingOk: false, pingErr: 'Extension context invalidated.' },
    want: 'invalidated', via: 'ping-throw', exit: 1, final: true, fixHas: 'F5' },
  { why: '命名空间被剥掉：sendMessage 一枚都不是函数 —— 不用发东西也能判桥断',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 3, worldsHaveFn: 0, worldsHaveId: 0,
      wakeAllowed: false },
    want: 'invalidated', via: 'namespace-stripped', exit: 1, final: true, fixHas: 'F5' },
  { why: '纯只读、id 全空：只许给嫌疑，不许下终审（final=false）',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 3, worldsHaveFn: 1, worldsHaveId: 0,
      wakeAllowed: false },
    want: 'invalidated-suspect', exit: 1, final: false, fixHas: 'F5' },
  { why: '纯只读、id 读得到：倾向能用，同样不下终审，而且**不许**报成桥断',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 3, worldsHaveFn: 3, worldsHaveId: 2,
      wakeAllowed: false },
    want: 'alive-suspect', exit: 0, final: false },
  { why: '这一页压根没有世界、后台也不在列表 —— 才轮到"没装/禁用"那一格',
    g: { portOk: true, workerListed: 0, extensionPageListed: 0, pageFound: true, worldCount: 0 },
    want: 'no-world', exit: 1, noteHas: '没装' },
  { why: '同样是 no-world，后台醒着 → 处置换成"这一页没注入"，不是重装（两格不许压成一格）',
    g: { portOk: true, workerListed: 1, pageFound: true, worldCount: 0 },
    want: 'no-world', exit: 1, noteHas: '没注入' },
  { why: '学习页不在（现场停在门户/被人关掉）：no-page 单独一格，既不等于桥断也不等于没在刷',
    g: { portOk: true, workerListed: 0, pageFound: false },
    want: 'no-page', exit: 2 },
  { why: 'attach 都没成功 → unreadable 单独一格（读不出 ≠ 坏了，也 ≠ 没事）',
    g: { portOk: true, pageFound: true, attachErr: '会话超时（60000ms）' },
    want: 'unreadable', exit: 2 },
  { why: 'CDP 端口连不上 → port-down，只说"量不到"',
    g: { portOk: false },
    want: 'port-down', exit: 2 },
  { why: '加了 --wake 却没有一枚世界读到 function，也没真抛出 → 读不出，不许塌进桥断',
    g: { portOk: true, pageFound: true, worldCount: 2, worldsHaveFn: 1, worldsHaveId: 0, wakeAllowed: true,
      pingTried: false },
    want: 'unreadable', exit: 2 },
  { why: 'ping 回了第三样东西（既非 ok 也非 invalidated）→ 单独占一格',
    g: { portOk: true, pageFound: true, worldCount: 2, worldsHaveFn: 1, worldsHaveId: 0, wakeAllowed: true,
      pingTried: true, pingOk: false, pingErr: 'Cannot access chrome extension' },
    want: 'unreadable', exit: 2 },
  { why: 'workerListed=0 **单独永不**给出 invalidated —— 在睡与桥断分家的承重格（下面几格各摘一半尺）',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 2, worldsHaveFn: 2, worldsHaveId: 2,
      wakeAllowed: false },
    ban: ['invalidated'], want: 'alive-suspect', exit: 0 },
  { why: 'worldCount=0 也不许被读成桥断（那是没注入）',
    g: { portOk: true, workerListed: 0, pageFound: true, worldCount: 0 },
    ban: ['invalidated', 'invalidated-suspect'], want: 'no-world', exit: 1 },
  { why: '每一格都要有处置那句话：桥断族必须说得出 F5',
    g: { portOk: true, pageFound: true, worldCount: 1, worldsHaveFn: 1, worldsHaveId: 0, wakeAllowed: true,
      pingTried: true, pingOk: false, pingErr: 'Extension context invalidated.' },
    want: 'invalidated', fixHas: '重载扩展之后必须 F5 这一枚页面' },
  { why: '读不出那几格不许给出"没在刷/没装"这种当成结论的话',
    g: { portOk: true, workerListed: 0, pageFound: false },
    want: 'no-page', exit: 2, noteBan: ['扩展没装'] },
  consoleRecordCell('console 第一条已知诊断：日志桥不可用，保留 unreadable 与真实 reason',
    [{ type: 'string', value: '[Omitone] runtime log unavailable; study continues' },
      { type: 'string', value: 'reason=Extension context invalidated.' },
      { type: 'string', value: 'verdict=unreadable' }],
    { message: 'runtime log unavailable; study continues', verdict: 'unreadable',
      reason: 'Extension context invalidated.' }),
  consoleRecordCell('console 第二条已知诊断：换章节后没问到，denied 与 unreadable 不许混格',
    [{ type: 'string', value: '[Omitone] scope not granted after page change [verdict=denied reason=scope_denied]' }],
    { message: 'scope not granted after page change', verdict: 'denied', reason: 'scope_denied' }),
  consoleRecordCell('console 第三条已知诊断：重连停止，stale 仍单独占一格',
    [{ type: 'string', value: '[Omitone] scope lost, bridge stopped [verdict=stale]' }],
    { message: 'scope lost, bridge stopped', verdict: 'stale', reason: '(未回原因)' }),
  consoleRecordCell('无关 console 不许被收进取证（只认三条精确诊断）',
    [{ type: 'string', value: '[Omitone] 别的诊断 [verdict=unreadable reason=secret]' }], null),
  consoleRecordCell('只差一个后缀的形似消息也不许冒充已知诊断',
    [{ type: 'string', value: '[Omitone] runtime log unavailable; study continuesXYZ' }], null),
  consoleRecordCell('已知诊断缺 verdict 时交 unparsed，不许猜成 unreadable',
    [{ type: 'string', value: '[Omitone] runtime log unavailable; study continues reason=timeout' }],
    { verdict: 'unparsed', reason: 'timeout' }),
  consoleRecordCell('console reason 里的 URL 必须掩码后再交回，课程标识不进取证',
    [{ type: 'string', value: '[Omitone] scope lost, bridge stopped [verdict=unreadable reason=failed https://example.test/course?id=42&enc=secret]' }],
    { verdict: 'unreadable', reason: 'failed (url omitted)' }),
  { why: '多条 console 取最新一条并计数，主桥 verdict 不被 console 改写',
    run: function () {
      var records = [
        { message: 'runtime log unavailable; study continues', verdict: 'unreadable', reason: 'timeout' },
        { message: 'scope not granted after page change', verdict: 'denied', reason: 'scope_denied' }
      ];
      var e = summarizeConsoleRecords(records);
      var v = classify({ portOk: true, pageFound: true, worldCount: 1, worldsHaveFn: 1,
        worldsHaveId: 0, wakeAllowed: true, pingTried: true, pingOk: false,
        pingErr: 'Extension context invalidated.', consoleRecords: records, consoleWaitMs: 0 });
      var unavailable = classify({ portOk: true, pageFound: true, attachErr: 'timeout', consoleRecords: records });
      var bad = [];
      if (e.count !== 2 || e.verdict !== 'denied' || e.message !== records[1].message) {
        bad.push('汇总没取最新或没数够：' + JSON.stringify(e));
      }
      if (v.verdict !== 'invalidated' || v.consoleEvidence.verdict !== 'denied' || v.consoleEvidence.capture !== 'enabled') {
        bad.push('主判定与 console 没分格：' + JSON.stringify({ verdict: v.verdict, console: v.consoleEvidence }));
      }
      if (unavailable.consoleEvidence.capture !== 'unavailable') bad.push('attach 失败时 console 仍被写成可采集');
      return bad;
    } },
  { why: 'console 采集开但没有匹配诊断时交 not-observed，不许塌成 unavailable',
    run: function () {
      var v = classify({ portOk: true, pageFound: true, worldCount: 1, worldsHaveFn: 1,
        worldsHaveId: 1, wakeAllowed: false, consoleRecords: [], consoleWaitMs: 0 });
      return v.consoleEvidence.capture === 'enabled' && v.consoleEvidence.verdict === 'not-observed' &&
        v.consoleEvidence.count === 0 ? [] : ['空取证读成了 ' + JSON.stringify(v.consoleEvidence)];
    } },
  { why: 'console 等待默认 0：未传值不许额外等',
    run: function () {
      return normalizeConsoleWaitMs(undefined) === 0 ? [] : ['默认等待不是 0'];
    } },
  { why: 'console 正常等待值向下取整',
    run: function () {
      return normalizeConsoleWaitMs(123.9) === 123 ? [] : ['正常等待值没向下取整'];
    } },
  { why: 'console 负数等待归 0，不许变成长时间等待',
    run: function () {
      return normalizeConsoleWaitMs(-20) === 0 ? [] : ['负数等待没归 0'];
    } },
  { why: 'console 等待封顶 30 秒，超长参数不能挂住巡检',
    run: function () {
      var got = normalizeConsoleWaitMs(999999);
      return MAX_CONSOLE_WAIT_MS === 30000 && got === MAX_CONSOLE_WAIT_MS
        ? [] : ['上限读到 ' + MAX_CONSOLE_WAIT_MS + '，归一化读到 ' + got];
    } }
];

function selftest() {
  var bad = [];
  CELLS.forEach(function (c, i) {
    var tag = '第 ' + (i + 1) + ' 格[' + c.why.slice(0, 26) + ']';
    if (typeof c.run === 'function') {
      c.run().forEach(function (message) { bad.push(tag + ' ' + message); });
      return;
    }
    var v = classify(c.g);
    if (v.verdict !== c.want) bad.push(tag + ' 期望 verdict=' + c.want + '，实际 ' + v.verdict);
    if (c.via && v.via !== c.via) bad.push(tag + ' 期望 via=' + c.via + '，实际 ' + v.via);
    if (c.exit !== undefined && v.exit !== c.exit) bad.push(tag + ' 期望退出码 ' + c.exit + '，实际 ' + v.exit);
    if (c.final !== undefined && !!v.final !== c.final) bad.push(tag + ' final 应为 ' + c.final + '，实际 ' + v.final);
    if (c.fixHas && String(v.fix || '').indexOf(c.fixHas) === -1) {
      bad.push(tag + ' 处置那句话里找不到「' + c.fixHas + '」—— 那句话丢了，这一格就退化成又一句读不出');
    }
    if (c.noteHas && String(v.note || '').indexOf(c.noteHas) === -1) bad.push(tag + ' note 里找不到「' + c.noteHas + '」');
    if (c.noteBan) {
      var hitN = c.noteBan.filter(function (s) { return String(v.note || '').indexOf(s) >= 0; });
      if (hitN.length) bad.push(tag + ' note 里出现了不许说的话：' + hitN.join(' / '));
    }
    if (c.ban) {
      var hit = c.ban.filter(function (s) { return String(v.verdict || '').indexOf(s) === 0; });
      if (hit.length) bad.push(tag + ' 不许报成 ' + hit.join(' / ') + '（实际 ' + v.verdict + '）—— 那一族又压回一格了');
    }
  });
  // 通用卫生：任何 verdict 都要有 exit，任何桥断族都要有 fix
  var seen = {};
  CELLS.forEach(function (c) {
    if (typeof c.run === 'function') return;
    var v = classify(c.g);
    seen[v.verdict] = v;
    if (typeof v.exit !== 'number') bad.push('verdict=' + v.verdict + ' 没有退出码');
    if (String(v.verdict).indexOf('invalidated') === 0 && !/F5/.test(String(v.fix || ''))) {
      bad.push('verdict=' + v.verdict + ' 的处置里没提 F5 —— §3.3 第 3 步那句话丢了');
    }
  });
  var kinds = Object.keys(seen);
  console.log('桥判定逐格对照：' + CELLS.length + ' 格，覆盖 verdict ' + kinds.length + ' 种（' + kinds.join(' / ') + '）');
  console.log('对照格数: ' + CELLS.length);
  if (bad.length) {
    // ⚠️ 通过数要数出来，不许写 0：一格可以报多条（同一格既错 verdict 又丢处置），
    //    写死 0 会把"红了 2 条"读成"一格都没过"，归因就错了（AGENTS §5「失败信息够不够定位」）。
    var failedCells = {};
    bad.forEach(function (b) { failedCells[b.split(' 格[')[0]] = 1; });
    var passed = CELLS.length - Object.keys(failedCells).length;
    console.log('自检：' + passed + ' / ' + CELLS.length + ' 格通过 —— 以下 ' + bad.length + ' 条：');
    bad.forEach(function (b) { console.log('  [FAIL] ' + b); });
    return 1;
  }
  console.log('自检：' + CELLS.length + ' / ' + CELLS.length + ' 格通过');
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (process.argv.indexOf('--selftest') !== -1) {
    process.exitCode = selftest();
  } else {
    var json = process.argv.indexOf('--json') !== -1;
    probe({
      port: Number(arg('port', process.env.OMITONE_DEBUG_PORT || 9334)),
      urlMatch: arg('url-match', DEFAULT_MATCH),
      wake: process.argv.indexOf('--wake') !== -1,
      consoleWaitMs: normalizeConsoleWaitMs(arg('console-wait-ms', 0))
    }).then(function (v) {
      if (json) {
        var raw = v.raw;
        delete v.raw;
        v.worlds = raw.worlds;
        console.log(JSON.stringify(v, null, 1));
      } else {
        console.log('verdict=' + v.verdict + (v.via ? '  via=' + v.via : '') + (v.final === false ? '  （嫌疑，未下终审）' : ''));
        console.log('  ' + v.note);
        if (v.fix) console.log('  处置：' + v.fix);
        console.log('  读数：worker ' + v.raw.workerListed + ' 枚 / 扩展页面 ' + v.raw.extensionPageListed +
          ' 枚 / Omitone 世界 ' + v.raw.worldCount + ' 枚（function ' + v.raw.worldsHaveFn + '、id 非空 ' + v.raw.worldsHaveId + '）' +
          ' / 命中 ' + v.raw.matched + ' 量的是 ' + String(v.raw.pageUrl || '(无页面)').slice(0, 60));
        var ce = v.consoleEvidence;
        console.log('  console：capture=' + ce.capture + ' / verdict=' + ce.verdict + ' / count=' + ce.count +
          ' / waitMs=' + ce.waitMs + (ce.message ? ' / message=' + ce.message : '') +
          (ce.reason ? ' / reason=' + ce.reason : ''));
      }
      process.exitCode = v.exit;
    }).catch(function (e) {
      console.log('FATAL ' + ((e && e.message) || e));
      process.exitCode = EXIT.unreadable;
    });
  }
}

module.exports = { classify: classify, probe: probe, selftest: selftest, readWorlds: readWorlds,
  oneShot: oneShot, makeGetJson: makeGetJson, listTargetsOrThrow: listTargetsOrThrow,
  normalizeConsoleWaitMs: normalizeConsoleWaitMs, bridgeConsoleRecord: bridgeConsoleRecord,
  summarizeConsoleRecords: summarizeConsoleRecords, BRIDGE_CONSOLE_MESSAGES: BRIDGE_CONSOLE_MESSAGES,
  MAX_CONSOLE_WAIT_MS: MAX_CONSOLE_WAIT_MS,
  DEFAULT_MATCH: DEFAULT_MATCH, FALLBACK_MATCH: FALLBACK_MATCH, EXIT: EXIT, CELLS: CELLS };
