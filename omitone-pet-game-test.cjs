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
check('每日摸头上限 6 次（之后只有演出不再涨）',
  acc.patsToday === 6 && acc.affection === 6,
  'pats=' + acc.patsToday + ' affection=' + acc.affection);

var pNext = GAME.onPat(acc, '2026-11-02');
check('跨天重置每日配额（好感不重置）', pNext.state.patsToday === 1 && pNext.state.affection === 7);

// ⚠️ 配比是**用户能感觉到的那件事**（1.3.0：「刷课涨的经验远远慢于摸头」）。
// 这四个数一改，手感就变，所以在这里钉住实值，而不是只钉"上限不越界"那种恒真判据。
check('手感配比：1 次摸头 = 10 分钟刷课；每日摸头 6 / 刷课 15（刷课上限 > 摸头上限）',
  GAME.RULES.patAffection === 1 && GAME.RULES.studyMinutesPerPoint === 10
  && GAME.RULES.patDailyCap === 6 && GAME.RULES.studyPointsDailyCap === 15
  && GAME.RULES.studyPointsDailyCap > GAME.RULES.patDailyCap,
  JSON.stringify(GAME.RULES));

check('等级表判定（0/14 初识 · 15 打过招呼 · 30 熟络）',
  GAME.levelOf(0) === 0 && GAME.levelOf(14) === 0 && GAME.levelOf(15) === 1 && GAME.levelOf(30) === 2);

check('追加等级判定（139 形影不离 · 140 心有灵犀 · 200 岁月同行）',
  GAME.levelOf(139) === 5 && GAME.levelOf(140) === 6 && GAME.levelOf(200) === 7 && GAME.levelOf(240) === 7);

check('老档不降级（上限 100 时代的满档用户仍是形影不离）', GAME.levelOf(100) === 5);

var st1 = GAME.applyStudySeconds(GAME.rollDay(null, DAY), 3600, DAY);
check('刷课 60 分钟折 6 点好感（10 分钟 1 点，水位推进到 3600 秒）',
  st1.gained === 6 && st1.state.affection === 6 && st1.state.countedSeconds === 3600);

var st2 = GAME.applyStudySeconds(st1.state, 3600 + 1800, DAY);
check('水位只按已转化秒数推进（再 30 分钟 = +3）',
  st2.gained === 3 && st2.state.countedSeconds === 5400);

var st3 = GAME.applyStudySeconds(GAME.rollDay(null, DAY), 12 * 3600, DAY);
check('刷课每日上限 15 点（150 分钟封顶，水位只推进实际入账的那一段）',
  st3.gained === 15 && st3.state.studyPointsToday === 15 && st3.state.countedSeconds === 9000,
  'gained=' + st3.gained + ' counted=' + st3.state.countedSeconds);

// 现场实证（2026-11-15）：水位停在历日的 32400，新一天统计层从零重算到 1532 秒
// → pending 恒 0 → **刷课好感一整天一格都没加**，而摸头那天加了 20。
// 这一条就是那个 bug 的回归锚：跨天必须把水位一起归零。
var staleWater = GAME.applyStudySeconds(
  { affection: 20, day: '2026-11-02', patsToday: 6, studyPointsToday: 0, countedSeconds: 32400 },
  1532, '2026-11-03');
check('历日水位撞上新一天的统计也能折算（跨天归零；现场刷课好感恒 0 的根因）',
  staleWater.state.countedSeconds === 1200 && staleWater.gained === 2
  && staleWater.state.affection === 22,
  'counted=' + staleWater.state.countedSeconds + ' gained=' + staleWater.gained);

// 跨天归零要等零点，可**旧语义留下的那一格今晚还在**：2026-11-15 16:00 现场实测
// countedSeconds 32400 撞当天 activeSeconds 12840（已刷 3 小时 28 分）→ 好感一格不涨。
// 这一条钉的是"当场捡回来"，不是等明天。
var sameDayStale = GAME.applyStudySeconds(
  { affection: 78, day: '2026-11-15', patsToday: 6, studyPointsToday: 0, countedSeconds: 32400 },
  { date: '2026-11-15', activeSeconds: 12840 }, '2026-11-15');
check('同一天里水位高过统计（旧语义残留）当场归零，刷课时长立刻开始入账',
  sameDayStale.state.countedSeconds === 9000 && sameDayStale.gained === 15
  && sameDayStale.state.studyPointsToday === 15 && sameDayStale.state.affection === 93,
  'counted=' + sameDayStale.state.countedSeconds + ' gained=' + sameDayStale.gained);

// 反过来：水位**没**超过统计时不许动它，否则每拍都把已入账的秒数重折一遍（好感翻倍）。
var noOvercount = GAME.applyStudySeconds(
  { affection: 10, day: '2026-11-15', patsToday: 0, studyPointsToday: 2, countedSeconds: 1200 },
  { date: '2026-11-15', activeSeconds: 1500 }, '2026-11-15');
check('水位没超过统计时不许归零（不然同一段时间反复入账）',
  noOvercount.gained === 0 && noOvercount.state.countedSeconds === 1200
  && noOvercount.state.studyPointsToday === 2,
  'counted=' + noOvercount.state.countedSeconds + ' gained=' + noOvercount.gained);

// 统计层落盘是节流的（攒够 20 秒才写一次），跨天那一拍读到的可能是**昨天**那一格。
// 水位刚归零，这一拍不挡住就等于把昨天的时长在今天再折一次 —— 半夜白送一天上限。
var yestStats = GAME.applyStudySeconds(
  GAME.rollDay(null, '2026-11-03'), { date: '2026-11-02', activeSeconds: 43200 }, '2026-11-03');
check('昨天的统计格不在今天折算（date 不合就一格不折）',
  yestStats.gained === 0 && yestStats.state.countedSeconds === 0
  && yestStats.state.affection === 0,
  'gained=' + yestStats.gained);

var todayStats = GAME.applyStudySeconds(
  GAME.rollDay(null, '2026-11-03'), { date: '2026-11-03', activeSeconds: 1200 }, '2026-11-03');
check('同一天的统计格正常入账（对象入参，20 分钟 = 2 点）',
  todayStats.gained === 2 && todayStats.state.countedSeconds === 1200,
  'gained=' + todayStats.gained);

var up = GAME.onPat(
  GAME.rollDay({ affection: 14, day: DAY, patsToday: 0, studyPointsToday: 0, countedSeconds: 0 }, DAY),
  DAY
);
check('跨级时 leveledUp=true 且说等级台词', up.leveledUp === true && up.state.affection === 15 && up.line === GAME.LEVELS[1].line, up.line);

// 到顶必须说**一句实话**：好感条没动是唯一会被读成"她坏了"的表现，
// 而摸头台词池里任何一句（"再摸一下也可以哦"）都在暗示还有奖励。
var capState = GAME.rollDay({ affection: 6, day: DAY, patsToday: 6, studyPointsToday: 0, countedSeconds: 0 }, DAY);
var capPat = GAME.onPat(capState, DAY);
check('摸头到当日上限：gained=0、capped=true、台词出自 PAT_CAP_LINES',
  capPat.gained === 0 && capPat.capped === true && capPat.leveledUp === false
  && GAME.PAT_CAP_LINES.indexOf(capPat.line) >= 0,
  'gained=' + capPat.gained + ' line=' + capPat.line);

var capped = GAME.onPat(GAME.rollDay({ affection: 240, day: DAY, patsToday: 0, studyPointsToday: 0, countedSeconds: 0 }, DAY), DAY);
check('好感满值（240）不再上涨', capped.state.affection === 240 && capped.gained === 1, 'affection=' + capped.state.affection + ' gained=' + capped.gained);

check('到顶台词不写死次数（那句归案，上限是 RULES 里的数）',
  GAME.PAT_CAP_LINES.length > 0 && GAME.PAT_CAP_LINES.every(function (l) {
    return String(l).indexOf(String(GAME.RULES.patDailyCap)) < 0 && /明天|再|陪我/.test(String(l));
  }), JSON.stringify(GAME.PAT_CAP_LINES));

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
