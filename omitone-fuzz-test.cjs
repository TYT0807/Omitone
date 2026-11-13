#!/usr/bin/env node
/**
 * 暴力测试（fuzz）：用全空间扫描与随机注入轰击纯函数库。`npm run fuzz:test`
 *
 * 为什么要有它：分类器/统计器/游戏规则这类纯函数，单测只喂"想得到"的输入，
 * 而真实世界送来的是**想不到**的输入（服务商返回 HTML 错误页、响应体里 message 是
 * 数字、时钟回拨半小时、存档被别的扩展写坏……）。这里用三类暴力补盲区：
 *   ① api-error：状态码 0~999 全扫描 + 17 种垃圾响应体交叉 —— 错误信息落实的守门员
 *     （每条必须带【类别】、保留原话、类别落在已知集合内，永不抛异常）；
 *   ② study-stats：随机时钟 5000 次（含回拨/同毫秒/跨天/巨跳）—— 秒数永不带负、
 *     永远等于当日增益之和；
 *   ③ pet-game：垃圾存档 3000 轮 —— 好感度永远被钳回 [0,100]、等级永不越界、永不抛异常。
 * 全部用固定种子的随机数：失败可精确复现，不是撞运气。
 * 已知设计取舍：随机范围覆盖 ±1 天与 ±1e9 量级，更大的混沌由调用方的 try/catch 兜底。
 */
'use strict';
var API_ERROR = require('./libs/api-error.js');
var STATS = require('./libs/study-stats.js');
var GAME = require('./popup/pet-game.js');

var failures = [];
var checks = 0;
function check(name, condition, detail) {
  checks++;
  if (condition) console.log('  [ok]   ' + name);
  else {
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  [FAIL] ' + name + (detail ? ' → ' + detail : ''));
  }
}

/** mulberry32：固定种子的可复现随机数（暴力但不失重现性） */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══ ① api-error：状态码全空间 + 垃圾响应体 ═══════════════════
var CATEGORIES = ['auth', 'balance', 'rate_limit', 'model', 'request', 'server', 'network'];
var sweepBad = [];
for (var status = 0; status <= 999; status++) {
  var r;
  try {
    r = API_ERROR.describe(status, '{"error":{"message":"raw-' + status + '"}}');
  } catch (e) {
    sweepBad.push('status ' + status + ' threw: ' + e.message);
    continue;
  }
  if (!r || CATEGORIES.indexOf(r.category) === -1) sweepBad.push('status ' + status + ' → 非法类别 ' + (r && r.category));
  if (!r || typeof r.human !== 'string' || r.human.indexOf('【') !== 0) sweepBad.push('status ' + status + ' → 文案缺【类别】');
  if (r && status > 0 && r.human.indexOf('HTTP ' + status) === -1) sweepBad.push('status ' + status + ' → HTTP 码丢失');
  if (r && r.human.indexOf('raw-' + status) === -1) sweepBad.push('status ' + status + ' → 原话丢失');
}
check('状态码 0~999 全扫描：类别合法 / 【类别】开头 / 原话保留 / HTTP 码在文案里',
  sweepBad.length === 0, sweepBad.slice(0, 4).join(' | '));

check('语义锚点：402 与 429+quota → balance；401 → auth；429 普通 → rate_limit；404 → model；500 → server；断网 → network',
  API_ERROR.describe(402, '{}').category === 'balance' &&
  API_ERROR.describe(429, '{"error":{"message":"insufficient_quota"}}').category === 'balance' &&
  API_ERROR.describe(429, '{"error":{"message":"slow down"}}').category === 'rate_limit' &&
  API_ERROR.describe(401, '{}').category === 'auth' &&
  API_ERROR.describe(404, '{}').category === 'model' &&
  API_ERROR.describe(500, '{}').category === 'server' &&
  API_ERROR.describe(undefined, '').category === 'network');

var GARBAGE = ['', '   ', '<html>502 Bad Gateway</html>', 'null', '123', 'Internal Server Error',
  '{"error":null}', '{"error":{}}', '{"error":{"message":42}}', '{"error":{"message":["a","b"]}}',
  '{"error":{"message":"_insufficient_balance_"}}', '{"error":"plain string"}',
  '{"error":{"message":"' + new Array(5001).join('A') + '"}}',
  '{"a":{"b":{"c":[1,2,{"d":"撇号\\\\"与换行\\n"}]}}}', '\u0000\uFFFF mixed', '{"error":{"message":""}}'];
var garbageBad = [];
GARBAGE.forEach(function (body) {
  [0, 402, 429, 401, 404, 500].forEach(function (st) {
    try {
      var r = API_ERROR.describe(st, body);
      if (!r || CATEGORIES.indexOf(r.category) === -1) { garbageBad.push(JSON.stringify(body).slice(0, 30) + '@' + st + ' 类别非法'); return; }
      if (r.human.length > 600) garbageBad.push(JSON.stringify(body).slice(0, 30) + '@' + st + ' 文案失控 ' + r.human.length + ' 字');
      if (r.human.indexOf('undefined') !== -1) garbageBad.push(JSON.stringify(body).slice(0, 30) + '@' + st + ' 文案漏出 undefined');
    } catch (e) {
      garbageBad.push(JSON.stringify(body).slice(0, 30) + '@' + st + ' threw ' + e.message);
    }
  });
});
check('16 种垃圾响应体 × 6 状态码：永不抛异常 / 类别合法 / 文案 ≤600 字 / 不漏 undefined',
  garbageBad.length === 0, garbageBad.slice(0, 4).join(' | '));

// ══ ② study-stats：随机时钟 5000 次 ══════════════════════════
var rng = mulberry32(0x0B7E5A1D);
var state = null;
var sumToday = 0;
var todayKey = '';
var invBad = [];
for (var i = 0; i < 5000; i++) {
  // 时间在基点 ±36 小时内随机（覆盖回拨、同毫秒、跨天、巨跳）
  var now = 1793570000000 + Math.floor((rng() * 2 - 1) * 36 * 3600 * 1000) + Math.floor(rng() * 60000);
  var r;
  try { r = STATS.recordActivity(state, now); } catch (e) { invBad.push('第 ' + i + ' 次 threw: ' + e.message); break; }
  var key = STATS.localDateKey(now);
  if (key !== todayKey) { sumToday = 0; todayKey = key; }
  sumToday += r.gained;
  if (!(r.gained >= 0)) { invBad.push('第 ' + i + ' 次 gained 为负: ' + r.gained); break; }
  if (r.state.activeSeconds !== sumToday) { invBad.push('第 ' + i + ' 次 activeSeconds ≠ 当日增益和: ' + r.state.activeSeconds + ' vs ' + sumToday); break; }
  state = r.state;
}
check('随机时钟 5000 次（回拨/同毫秒/跨天/巨跳）：gained 永不为负，activeSeconds 恒等于当日增益和',
  invBad.length === 0, invBad.slice(0, 3).join(' | '));

var flushBad = [];
for (var j = 0; j < 500; j++) {
  var s = { date: '2026-11-01', activeSeconds: Math.floor(rng() * 100000), lastActiveAt: 1000 + Math.floor(rng() * 1e9), lastFlushAt: Math.floor(rng() * 1e9) };
  try {
    var should = STATS.shouldFlush(s);
    var marked = STATS.markFlushed(s, s.lastActiveAt);
    if (should && marked.lastFlushAt !== s.lastActiveAt) flushBad.push('shouldFlush 但基线没推进');
    if (!should && STATS.shouldFlush(marked)) flushBad.push('落盘后再次判定可写');
    if (marked.activeSeconds !== s.activeSeconds) flushBad.push('markFlushed 丢失秒数');
  } catch (e) { flushBad.push('threw ' + e.message); break; }
}
check('随机状态 500 次落盘判定：shouldFlush/markFlushed 互恰、秒数不丢',
  flushBad.length === 0, flushBad.slice(0, 3).join(' | '));

// ══ ③ pet-game：垃圾存档 3000 轮 ═════════════════════════════
var GARBAGE_AFFECTION = [-1e9, 0, 1, 99, 100, 100.5, 1e9, NaN, null, undefined, '50', '', {}, [], true];
var DAY_GARBAGE = ['2026-11-01', '', null, undefined, ' nonsense ', 42, '9999-99-99'];
var gameBad = [];
var grng = mulberry32(20261031);
for (var k = 0; k < 3000; k++) {
  var aff = GARBAGE_AFFECTION[Math.floor(grng() * GARBAGE_AFFECTION.length)];
  var day = DAY_GARBAGE[Math.floor(grng() * DAY_GARBAGE.length)];
  var st = {
    affection: aff, day: day,
    patsToday: Math.floor(grng() * 40) - 5,
    studyPointsToday: Math.floor(grng() * 30) - 5,
    countedSeconds: Math.floor(grng() * 1e9)
  };
  try {
    var rolled = GAME.rollDay(st, '2026-11-01');
    if (!(rolled.affection >= 0 && rolled.affection <= GAME.RULES.max && Number.isFinite(rolled.affection))) {
      gameBad.push('rollDay 未钳制: ' + JSON.stringify(aff)); break;
    }
    if (GAME.levelOf(rolled.affection) < 0 || GAME.levelOf(rolled.affection) >= GAME.LEVELS.length) {
      gameBad.push('levelOf 越界: ' + rolled.affection); break;
    }
    var pat = GAME.onPat(st, '2026-11-01');
    if (!(pat.state.affection >= 0 && pat.state.affection <= GAME.RULES.max) || typeof pat.line !== 'string') {
      gameBad.push('onPat 越界或台词缺失'); break;
    }
    var seconds = Math.floor(grng() * 1e9) - 1e8;
    var study = GAME.applyStudySeconds(st, seconds, '2026-11-01');
    if (study.state.countedSeconds < st.countedSeconds - 1e-9) {
      gameBad.push('水位倒退: ' + st.countedSeconds + ' → ' + study.state.countedSeconds); break;
    }
    if (!(study.state.affection >= 0 && study.state.affection <= GAME.RULES.max)) {
      gameBad.push('applyStudySeconds 未钳制'); break;
    }
  } catch (e) { gameBad.push('第 ' + k + ' 轮 threw: ' + e.message); break; }
}
check('垃圾存档 3000 轮（NaN/负数/1e9/错型/怪日期）：好感恒在 [0, RULES.max]、等级不越界、水位不倒退、永不抛异常',
  gameBad.length === 0, gameBad.slice(0, 3).join(' | '));

// ⚠️ 上面三条判据读的是生产自己的 RULES.max，所以这里把**那个数本身**钉住 ——
// 否则有人把 max 改成 10 万，暴力测试照样全绿（自筛自证的老问题，见 AGENTS.md §5）。
// 1.3.0 把上限从 100 提到 240 是给老档留继续养的空间；最高一档门槛必须仍在上限之内，
// 否则「岁月同行」永远点亮不了。
check('好感上限与等级表自洽：RULES.max 仍是 240，且最高一档 min（200）不超过它',
  GAME.RULES.max === 240 && GAME.LEVELS[GAME.LEVELS.length - 1].min === 200 &&
  GAME.LEVELS[GAME.LEVELS.length - 1].min <= GAME.RULES.max,
  JSON.stringify({ max: GAME.RULES.max, topMin: GAME.LEVELS[GAME.LEVELS.length - 1].min }));

// 每日配额的边界暴力：连续 onPat 至上限后不再涨
var capped = GAME.rollDay(null, '2026-11-01');
for (var m = 0; m < 100; m++) capped = GAME.onPat(capped, '2026-11-01').state;
check('连摸 100 次：好感恰为每日上限（' + GAME.RULES.patDailyCap + '），多摸不涨', capped.affection === GAME.RULES.patDailyCap, 'affection=' + capped.affection);

console.log('');
if (failures.length) {
  console.log('暴力测试未通过：' + failures.length + ' 项');
  process.exitCode = 1;
} else {
  console.log('暴力测试通过：' + checks + ' 项');
}
