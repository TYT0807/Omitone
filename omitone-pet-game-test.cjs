#!/usr/bin/env node
/**
 * 小游戏纯规则测试：libs/study-stats.js + popup/pet-game.js。`npm run pet-game:test`
 *
 * 两个库都是纯函数（无 DOM / 无 chrome.*），直接 require 断言行为。
 * 覆盖：连续刷课计秒 / 挂机间隔不计 / 跨天清零 / 时钟回拨 / 落盘节流 /
 *       摸头每日上限与跨天重置 / 等级判定 / 刷课折算的每日上限与水位推进 / 跨级判定。
 * 为什么下沉成纯函数：这两个库喂的是游戏数值，错了顶多数值不对，但**绝不能**为了
 * 测它们把 content.js / pet.js 拖进测试环境 —— 抽出来才能便宜地测满。
 */
'use strict';
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

// ══ study-stats：刷课活跃时长 ═══════════════════════════════
var T0 = new Date('2026-11-01T10:00:00').getTime();

var r1 = STATS.recordActivity(null, T0);
check('首条信号只推进游标、不计秒', r1.gained === 0 && r1.state.lastActiveAt === T0);

var r2 = STATS.recordActivity(r1.state, T0 + 5000);
check('连续信号把间隔计入活跃秒（5 秒后 +5）', r2.gained === 5 && r2.state.activeSeconds === 5);

var r3 = STATS.recordActivity(r2.state, T0 + 5000 + 600000);
check('超过会话间隔（90s）的挂机不计入', r3.gained === 0 && r3.state.activeSeconds === 5);

var nextDay = new Date('2026-11-02T09:00:00').getTime();
var r4 = STATS.recordActivity(r3.state, nextDay);
check('跨天清零（昨天的时长不滚到今天）',
  r4.gained === 0 && r4.state.activeSeconds === 0 && r4.state.date === STATS.localDateKey(nextDay));

var r5 = STATS.recordActivity(
  { date: '2026-11-02', activeSeconds: 10, lastActiveAt: nextDay, lastFlushAt: 0 },
  nextDay - 1000
);
check('时钟回拨不产生负增长', r5.gained === 0 && r5.state.activeSeconds === 10);

check('刚记 5 秒不该落盘', STATS.shouldFlush(r2.state) === false);
var busy2 = STATS.recordActivity(r2.state, T0 + 5000 + 25000).state;
check('攒满 20 秒新增后该落盘', STATS.shouldFlush(busy2) === true);
check('落盘后到同一活跃点不再触发', STATS.shouldFlush(STATS.markFlushed(busy2, T0 + 30005)) === false);

// ══ pet-game：好感度 / 等级 ════════════════════════════════
var DAY = '2026-11-01';

var p1 = GAME.onPat(GAME.rollDay(null, DAY), DAY);
check('摸头 +1 入账', p1.gained === 1 && p1.state.affection === 1);

var acc = p1.state;
for (var i = 0; i < 30; i++) acc = GAME.onPat(acc, DAY).state;
check('每日摸头上限 20 次（之后只有演出不再涨）',
  acc.patsToday === 20 && acc.affection === 20,
  'pats=' + acc.patsToday + ' affection=' + acc.affection);

var pNext = GAME.onPat(acc, '2026-11-02');
check('跨天重置每日配额（好感不重置）', pNext.state.patsToday === 1 && pNext.state.affection === 21);

check('等级表判定（0/14 初识 · 15 打过招呼 · 30 熟络）',
  GAME.levelOf(0) === 0 && GAME.levelOf(14) === 0 && GAME.levelOf(15) === 1 && GAME.levelOf(30) === 2);

check('追加等级判定（139 形影不离 · 140 心有灵犀 · 200 岁月同行）',
  GAME.levelOf(139) === 5 && GAME.levelOf(140) === 6 && GAME.levelOf(200) === 7 && GAME.levelOf(240) === 7);

check('老档不降级（上限 100 时代的满档用户仍是形影不离）', GAME.levelOf(100) === 5);

var st1 = GAME.applyStudySeconds(GAME.rollDay(null, DAY), 3600, DAY);
check('刷课 60 分钟折 2 点好感（水位推进到 3600 秒）',
  st1.gained === 2 && st1.state.affection === 2 && st1.state.countedSeconds === 3600);

var st2 = GAME.applyStudySeconds(st1.state, 3600 + 1800, DAY);
check('水位只按已转化秒数推进（再 30 分钟 = +1）',
  st2.gained === 1 && st2.state.countedSeconds === 5400);

var st3 = GAME.applyStudySeconds(GAME.rollDay(null, DAY), 12 * 3600, DAY);
check('刷课每日上限 10 点（150 分钟封顶）',
  st3.gained === 10 && st3.state.studyPointsToday === 10 && st3.state.countedSeconds === 18000);

var st3b = GAME.applyStudySeconds(st3.state, 12 * 3600, '2026-11-02');
check('被上限挡住的时长跨天继续折（不清空不蒸发）',
  st3b.gained > 0 && st3b.state.countedSeconds > st3.state.countedSeconds,
  'counted=' + st3b.state.countedSeconds);

var up = GAME.onPat(
  GAME.rollDay({ affection: 14, day: DAY, patsToday: 0, studyPointsToday: 0, countedSeconds: 0 }, DAY),
  DAY
);
check('跨级时 leveledUp=true 且说等级台词', up.leveledUp === true && up.state.affection === 15 && up.line === GAME.LEVELS[1].line, up.line);

var capped = GAME.onPat(GAME.rollDay({ affection: 240, day: DAY, patsToday: 0, studyPointsToday: 0, countedSeconds: 0 }, DAY), DAY);
check('好感满值（240）不再上涨', capped.state.affection === 240 && capped.gained === 1, 'affection=' + capped.state.affection + ' gained=' + capped.gained);

// ══ 成就（1.3.0 追加）══════════════════════════════════════
var carried = GAME.rollDay(
  { totalPats: 7, streakDays: 3, lastMetDay: '2026-10-31', ach: { pat100: '2026-10-01' }, day: DAY },
  DAY
);
check('rollDay 携带成就与统计字段（丢了就是丢进度）',
  carried.totalPats === 7 && carried.streakDays === 3 && carried.lastMetDay === '2026-10-31'
  && carried.ach && carried.ach.pat100 === '2026-10-01');

var t1 = GAME.rollDay(null, DAY);
t1 = GAME.touchDay(t1, DAY);
var yKey = GAME.prevDayKeyOf(DAY);
t1 = GAME.rollDay(t1, yKey);
t1 = GAME.touchDay(t1, yKey);
t1 = GAME.rollDay(t1, DAY);
t1 = GAME.touchDay(t1, DAY);
check('连续两天见面 streak=2，touchDay 同日幂等', t1.streakDays === 2 && t1.lastMetDay === DAY);

var broken = GAME.rollDay(t1, GAME.prevDayKeyOf(yKey));
broken = GAME.touchDay(broken, GAME.prevDayKeyOf(yKey));
check('断一天后重见 streak 归 1', broken.streakDays === 1);

var night = GAME.onPat(GAME.rollDay(null, DAY), DAY, new Date('2026-11-01T03:00:00').getTime());
var day2 = GAME.onPat(night.state, DAY, new Date('2026-11-01T14:00:00').getTime());
check('凌晨摸头计入夜猫子（白天不计）', night.state.nightPats === 1 && day2.state.nightPats === 1);

var achState = GAME.rollDay({ totalPats: 100, totalStudyMinutes: 600, nightPats: 20, affection: 55, day: DAY }, DAY);
var got = GAME.evaluateAchievements(achState, DAY);
var gotIds = got.map(function (a) { return a.id; }).sort().join(',');
check('统计达标一次点亮（pat100/study600/night20；亲近非冬不点）',
  gotIds === 'night20,pat100,study600', gotIds);

var marked = GAME.markAchievements(achState, ['pat100', 'study600'], DAY);
var again = GAME.evaluateAchievements(marked, DAY).map(function (a) { return a.id; }).join(',');
check('点亮后不重复解锁', again.indexOf('pat100') < 0 && again.indexOf('study600') < 0, again);

var winter = GAME.evaluateAchievements(GAME.rollDay(null, '2026-12-20'), '2026-12-20');
check('初雪之约在冬季点亮（12 月）', winter.map(function (a) { return a.id; }).indexOf('firstSnow') >= 0);

var patLine = GAME.onPat(GAME.rollDay(null, DAY), DAY);
check('onPat 返回体仍含 line/level（伴侣与弹窗共用）',
  typeof patLine.line === 'string' && patLine.level === 0 && patLine.state.totalPats === 1);

console.log('');
if (failures.length) {
  console.log('小游戏规则测试未通过：' + failures.length + ' 项');
  process.exitCode = 1;
} else {
  console.log('小游戏规则测试通过：' + checks + ' 项');
}
