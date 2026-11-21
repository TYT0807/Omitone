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
var fs = require('fs');
var path = require('path');
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

check('追加等级判定（139 形影不离 · 140 心有灵犀 · 200 岁月同行 · 214/215 长夜同守 · 231/232 往后都在 · 240 仍封顶）',
  GAME.levelOf(139) === 5 && GAME.levelOf(140) === 6 && GAME.levelOf(200) === 7 &&
  GAME.levelOf(214) === 7 && GAME.levelOf(215) === 8 && GAME.LEVELS[8].name === '长夜同守' &&
  GAME.levelOf(231) === 8 && GAME.levelOf(232) === 9 && GAME.LEVELS[9].name === '往后都在' &&
  GAME.levelOf(240) === 9 && GAME.levelOf(999) === 9);

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

// 季节成就现在四季各一枚（C 阶段起）—— 期望名单必须按测试日期**自己算**当季那枚，
// 手抄固定名单会让这条断言变成"看日历"的随机红（11 月跑就多出 autumnDay，实测撞过）。
var seasonAchOf = function (dayKey) {
  return { spring: 'springDay', summer: 'summerDay', autumn: 'autumnDay', winter: 'firstSnow' }[GAME.seasonOf(dayKey)];
};
var achState = GAME.rollDay({ totalPats: 100, totalStudyMinutes: 600, nightPats: 20, affection: 55, day: DAY }, DAY);
var got = GAME.evaluateAchievements(achState, DAY);
var gotIds = got.map(function (a) { return a.id; }).sort().join(',');
check('统计达标一次点亮（pat100/study600/night20；亲近非冬不点，但当季那枚会亮）',
  gotIds === ['night20', 'pat100', 'study600', seasonAchOf(DAY)].sort().join(','), gotIds);

var marked = GAME.markAchievements(achState, ['pat100', 'study600'], DAY);
var again = GAME.evaluateAchievements(marked, DAY).map(function (a) { return a.id; }).join(',');
check('点亮后不重复解锁', again.indexOf('pat100') < 0 && again.indexOf('study600') < 0, again);

var winter = GAME.evaluateAchievements(GAME.rollDay(null, '2026-12-20'), '2026-12-20');
check('初雪之约在冬季点亮（12 月）', winter.map(function (a) { return a.id; }).indexOf('firstSnow') >= 0);

var patLine = GAME.onPat(GAME.rollDay(null, DAY), DAY);
check('onPat 返回体仍含 line/level（伴侣与弹窗共用）',
  typeof patLine.line === 'string' && patLine.level === 0 && patLine.state.totalPats === 1);

// ══ 台词层（批次 64）：时段分桶 / 单一真源 / 不撞带 ═══════════
// 用户原话「吉祥物的话有点单一和少了」。判据全部对着**规则层**量，不看界面 ——
// 界面那两份（content.js / popup/pet.js）只要求它们**从这里取**，不许自带池子。

// ① 时段边界：注释里那张表就是真源，改了边界必须同时改这里（别把判据改松）
var PERIOD_EDGE = [
  [0, 'dawn'], [4, 'dawn'], [5, 'morning'], [9, 'morning'],
  [10, 'midday'], [13, 'midday'], [14, 'afternoon'], [17, 'afternoon'],
  [18, 'evening'], [21, 'evening'], [22, 'night'], [23, 'night']
];
var edgeBad = PERIOD_EDGE.filter(function (p) { return GAME.periodOf(p[0]) !== p[1]; });
check('periodOf 的十二个边界钟点落在注释说的那一格',
  edgeBad.length === 0, JSON.stringify(edgeBad));
check('24 个钟点全覆盖且只出六个时段名',
  (function () {
    var seen = {};
    for (var h = 0; h < 24; h++) seen[GAME.periodOf(h)] = 1;
    return Object.keys(seen).sort().join(',') === GAME.PERIODS.slice().sort().join(',');
  })());
check('越界／非数的钟点折回 0~23（不把 -5 点当成不存在的格子）',
  GAME.periodOf(-5) === GAME.periodOf(19) && GAME.periodOf(27) === GAME.periodOf(3) &&
  GAME.PERIODS.indexOf(GAME.periodOf('abc')) >= 0 && GAME.periodOf('abc') === GAME.periodOf(undefined));

// ② 池子形状：六个桶都在、都不空、都短
['idle', 'greet'].forEach(function (name) {
  var miss = GAME.PERIODS.filter(function (p) { return !(GAME.SAY[name] && GAME.SAY[name][p] && GAME.SAY[name][p].length >= 2); });
  check('SAY.' + name + ' 六个时段桶各有至少两句', miss.length === 0, miss.join(','));
});
['poke', 'dodge', 'moodHigh', 'moodLow', 'start', 'stop', 'nightWarn'].forEach(function (name) {
  check('SAY.' + name + ' 是至少三句的平池',
    Array.isArray(GAME.SAY[name]) && GAME.SAY[name].length >= 3,
    GAME.SAY && GAME.SAY[name] && GAME.SAY[name].length);
});
check('SAY.season 四季各有至少三句（原先在 pet.js 里只有两句一季）',
  ['spring', 'summer', 'autumn', 'winter'].every(function (s) {
    return GAME.SAY.season && GAME.SAY.season[s] && GAME.SAY.season[s].length >= 3;
  }));
var allLines = [];
Object.keys(GAME.SAY).forEach(function (k) {
  var p = GAME.SAY[k];
  if (Array.isArray(p)) allLines = allLines.concat(p);
  else Object.keys(p).forEach(function (b) { allLines = allLines.concat(p[b]); });
});
// ⚠️ 带占位的那几族（批次 65：levelup / achievement / daily / dailyHigh）量的必须是**填完之后**的句子。
//   按模板量会两样都错：`{line}` 在模板里只有 6 个字符，填进去是一整句（实测最坏 17 字），
//   于是"太长"是假的；反过来模板很短、填完爆掉 60 字被页面气泡截成「…」，那种长才是真的。
//   上限取**它替换掉的那两句硬编码**的实际长度：旧「好感度达到「岁月同行」！从初识走到今天，谢谢你没缺席。」
//   最坏 29~30 字，用户从没说过长 —— 所以 34 是"不比原来更长"的实测上限，离页面 60 字截断线还有一半。
var WORST = { name: '岁月同行', line: '从初识走到今天，谢谢你没缺席。', mins: '999' };
function filledOf(s) {
  return String(s).replace(/\{([A-Za-z_]\w*)\}/g, function (w, k) { return WORST[k] === undefined ? w : WORST[k]; });
}
var tooLong = allLines.filter(function (s) {
  var out = filledOf(s);
  return /\{/.test(s) ? out.length > 34 : out.length > 20;
});
check('台词长度按"填完之后"量：平池 ≤20 字，带占位那几族 ≤34 字（页面气泡 60 字才截断）',
  tooLong.length === 0, JSON.stringify(tooLong));
// 占位名打错（{mians}）在生产里等于"她永远不说这一句"（fill 缺值回空串），一条测试都看不见 ——
// 所以把占位名单钉成"界面真的会传的那几个键"。
var KNOWN_KEYS = { name: 1, line: 1, mins: 1 };
var badTokens = [];
allLines.forEach(function (s) {
  String(s).replace(/\{([A-Za-z_]\w*)\}/g, function (w, k) { if (!KNOWN_KEYS[k]) badTokens.push(s + ' ← ' + w); return w; });
});
check('模板里的占位只许是界面真的会传的键（name / line / mins），打错=她永远不说这一句',
  badTokens.length === 0, JSON.stringify(badTokens));
check('带占位的那几族：缺任一字段就整句不说（半句话比闭嘴坏），填满就一定不含花括号',
  ['levelup', 'achievement', 'daily', 'dailyHigh'].every(function (f) {
    var need = { levelup: ['name', 'line'], achievement: ['name', 'line'], daily: ['mins'], dailyHigh: ['mins'] }[f];
    var full = { name: '熟络', line: '和你待在一起很安心。', mins: '42' };
    if (GAME.pickLine(f, full, function () { return 0.5; }).indexOf('{') >= 0) return false;
    return need.every(function (key) {
      var c = {};
      need.forEach(function (k2) { c[k2] = full[k2]; });
      c[key] = '';
      return GAME.pickLine(f, c, function () { return 0.5; }) === '';
    });
  }));
check('池子总量比批次 64 之前厚（自言自语 ≥20 句、全部 ≥60 句）',
  GAME.IDLE_LINES.length >= 20 && allLines.length >= 60,
  'idle=' + GAME.IDLE_LINES.length + ' all=' + allLines.length);
var dupAll = allLines.length - Object.keys(allLines.reduce(function (m, s) { m[s] = (m[s] || 0) + 1; return m; }, {})).length;
check('同一份池子里不许有重复句子（重复=抽到两次同句的元凶）', dupAll === 0,
  JSON.stringify(allLines.filter(function (s, i) { return allLines.indexOf(s) !== i; })));

// ②′ 说出口的那句不许带省略号（任务 #215，2026-11-21 用户：「吉祥物的成就怎么还出现了省略的"......"，这很不合理」）
//   她本人的气泡**不截断**（批次 162 之后卡片宽度随内容让位），所以盘上那句「…」就是**她自己写的**，
//   而用户读到的是「这句话被剪了」—— 两种成因在界面上长得一模一样，只能从源头禁止。
//   尺扫**五族全部字符串叶子**（含 name / desc，成就面板那一格用户同样看得见），不止 line：
//   只扫 line 会漏 desc，而「省略号在句子里」和「以省略号收尾」同形，都读成截断。
//   ⚠️ 每一族**各自**有下限：合并成一格"总共 ≥ N 句"时，一整族被改名／搬走字段
//     只让总数掉一截，报出来的是"少了 40 句"，而不是"哪一族不见了"（AGENTS §2 #12）。
var SPOKEN_KEYS = ['LEVELS', 'PAT_LINES', 'PAT_CAP_LINES', 'SAY', 'ACHIEVEMENTS'];
// 下限取**实测**（2026-11-21 数回来的：LEVELS 20 / PAT_LINES 40 / PAT_CAP_LINES 5 / SAY 114 / ACHIEVEMENTS 64，共 243）
// 再留一成余量给"合法合并两句"那种改写；掉到下限以下 = 少扫一整族，必须点名。
var SPOKEN_MIN = { LEVELS: 16, PAT_LINES: 32, PAT_CAP_LINES: 5, SAY: 96, ACHIEVEMENTS: 52 };
function collectStrings(node, at, out) {
  if (typeof node === 'string') { out.push({ at: at, s: node }); return; }
  if (Array.isArray(node)) { node.forEach(function (v, i) { collectStrings(v, at + '[' + i + ']', out); }); return; }
  if (node && typeof node === 'object') {
    Object.keys(node).forEach(function (k) { collectStrings(node[k], at + '.' + k, out); });
  }
}
var spokenBy = {};
SPOKEN_KEYS.forEach(function (k) { spokenBy[k] = []; collectStrings(GAME[k], k, spokenBy[k]); });
var spoken = SPOKEN_KEYS.reduce(function (acc, k) { return acc.concat(spokenBy[k]); }, []);
var thinFam = SPOKEN_KEYS.filter(function (k) { return spokenBy[k].length < SPOKEN_MIN[k]; });
check('五族说出口的话各自扫得到（' + SPOKEN_KEYS.map(function (k) {
  return k + ':' + spokenBy[k].length;
}).join(' / ') + '，共 ' + spoken.length + ' 句）—— 哪一族掉到下限（' +
  SPOKEN_KEYS.map(function (k) { return SPOKEN_MIN[k]; }).join('/') +
  '）以下就单独点名，"少扫一整族"和"这一族本来就干净"不许混成一格',
  thinFam.length === 0,
  JSON.stringify(thinFam.map(function (k) { return k + ' 只扫到 ' + spokenBy[k].length + ' 句（下限 ' + SPOKEN_MIN[k] + '）'; })));
var ELL = /…|\.{3,}/;
var withEll = spoken.filter(function (o) { return ELL.test(o.s) || ELL.test(filledOf(o.s)); });
check('说出口的 ' + spoken.length + ' 句里没有一句带省略号（收尾与句中都不许；要停顿就写逗号，说完就写句号）',
  withEll.length === 0,
  JSON.stringify(withEll.map(function (o) { return o.at + ' = ' + o.s; })));

// ③ IDLE_LINES 只是 SAY.idle 的展平，不是第二份真源
check('IDLE_LINES 恰好等于六个时段桶的并（不是另抄一份）',
  GAME.IDLE_LINES.join('\u0001') === GAME.PERIODS.reduce(function (acc, p) {
    return acc.concat(GAME.SAY.idle[p] || []);
  }, []).join('\u0001'));

// ③b 按好感阶段分化的自言自语（批次 104：用户「不同阶段的对话也分化一下」）
//     ⚠️ 这一族的成立条件是**两族并池 + 归因指得对**，不是"多加了几句"。
//       所以断言读的是 from / band 这两格，而不是句子数量 —— 数量那条上面已经跟着 allLines 走了。
var HOUR = { dawn: 2, morning: 7, midday: 12, afternoon: 15, evening: 19, night: 23 };
var bondKeys = Object.keys(GAME.SAY.idleBond || {});
check('阶段三池的格子名与 bandOf 的取值一一对应（名单与谓词不对齐时，新增那一池一步都不会走到）',
  bondKeys.length === 3 && ['new', 'close', 'deep'].every(function (k) {
    return bondKeys.indexOf(k) >= 0 && (GAME.SAY.idleBond[k] || []).length >= 3;
  }), JSON.stringify(bondKeys.map(function (k) { return k + ':' + GAME.SAY.idleBond[k].length; })));
var idleFlat = GAME.IDLE_LINES;
var bondOverlap = bondKeys.reduce(function (acc, k) {
  return acc.concat((GAME.SAY.idleBond[k] || []).filter(function (s) { return idleFlat.indexOf(s) >= 0; }));
}, []);
check('阶段三池与时段六桶字面不重叠（重叠了 from 归因就指错桶，测试按 from 断"走到过"）',
  bondOverlap.length === 0, JSON.stringify(bondOverlap));
check('bandOf 的分界：0~2 生分 / 3~5 熟络 / 6~9 深，拿不到等级交空串（不许把"不知道"猜成初识）',
  GAME.bandOf(0) === 'new' && GAME.bandOf(2) === 'new' && GAME.bandOf(3) === 'close' &&
  GAME.bandOf(5) === 'close' && GAME.bandOf(6) === 'deep' && GAME.bandOf(9) === 'deep' &&
  GAME.bandOf(undefined) === '' && GAME.bandOf(NaN) === '' && GAME.bandOf(-1) === '' &&
  GAME.bandOf('x') === '');
var bandBad = [];
['new', 'close', 'deep'].forEach(function (b, bi) {
  var lvl = [0, 3, 6][bi];
  var seenPeriod = 0, seenBond = 0;
  for (var i = 0; i < 400; i++) {
    var g = GAME.pickIdleLine({ hour: HOUR.midday, level: lvl });
    if (g.period !== 'midday') bandBad.push('period:' + g.period);
    if (g.band !== b) bandBad.push('band:' + g.band);
    if (g.from === 'bond') { seenBond++; if (GAME.SAY.idleBond[b].indexOf(g.line) < 0) bandBad.push('from-bond:' + g.line); }
    else if (g.from === 'period') { seenPeriod++; if (GAME.SAY.idle.midday.indexOf(g.line) < 0) bandBad.push('from-period:' + g.line); }
    else bandBad.push('from-empty:' + g.line);
  }
  if (!seenBond || !seenPeriod) bandBad.push(b + ':只走到一族 period=' + seenPeriod + ' bond=' + seenBond);
});
check('两族真的并成一个池：时段格照旧对得上，阶段那几句也真说得上口，且 from 与实际来源逐次相符',
  bandBad.length === 0, JSON.stringify(bandBad.slice(0, 4)));
var noLevelBad = [];
for (var ni = 0; ni < 200; ni++) {
  var gn = GAME.pickIdleLine({ hour: HOUR.night });      // 老档／等级读不出来那一族
  if (gn.band !== '' || gn.from !== 'period' || GAME.SAY.idle.night.indexOf(gn.line) < 0) noLevelBad.push(gn);
}
check('不知道熟不熟时只走时段那一族（阶段那几句不会当着面把老档说成生分）',
  noLevelBad.length === 0, JSON.stringify(noLevelBad.slice(0, 2)));
// ⚠️ 这一条是**为什么排除要传"最近几句"而不是"上一句"**的根据：并池之后 dawn 抽阶段、
//   midday 抽时段、night 又抽回 dawn 那一句是常见形状，而 e2e ⑥-c 按"三个时段三句不同"断言。
var recentBad = [];
var recent = [];
for (var ri = 0; ri < 300; ri++) {
  var gr = GAME.pickIdleLine({ hour: HOUR.dawn, level: 4 }, null, recent.slice(-3));
  if (recent.slice(-3).indexOf(gr.line) >= 0) recentBad.push(gr.line);
  recent.push(gr.line);
}
check('把最近三句交进去就不会隔一两句又卡带（并池后单挡上一句不够，三时段断言会随机红）',
  recentBad.length === 0, JSON.stringify(recentBad.slice(0, 3)));
var wholePool = GAME.SAY.idle.midday.concat(GAME.SAY.idleBond.close);
var starved = GAME.pickIdleLine({ hour: HOUR.midday, level: 3 }, null, wholePool);
check('整个池子都被记成"刚说过"时照旧说一句（记严了不许把她憋成闭嘴）',
  wholePool.indexOf(starved.line) >= 0, JSON.stringify(starved));

// ④ pickLine 的四条行为
check('名字不在表里 → 空串（调用方据此什么都不说，不硬凑一句）',
  GAME.pickLine('nope', {}) === '' && GAME.pickLine('', {}) === '');
check('点名点错格子（季节格子给了时段名）→ 空串',
  GAME.pickLine('season', { bucket: 'rainy' }) === '');
check('季节按 bucket 取，不落在时段上',
  GAME.SAY.season.winter.indexOf(GAME.pickLine('season', { bucket: 'winter', hour: 12 }, function () { return 0; })) >= 0);
check('按时段取句：同一格永远从那一桶里出（钉死钟点取证，不靠运气）',
  ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'].every(function (p) {
    var hour = { dawn: 2, morning: 7, midday: 12, afternoon: 15, evening: 19, night: 23 }[p];
    var got = GAME.pickLine('idle', { hour: hour }, function () { return 0.999; });
    return GAME.SAY.idle[p].indexOf(got) >= 0;
  }));
check('可注入随机源 → 同一拍抽同一句（测试要确定性，不能靠 Math.random 碰）',
  GAME.pickLine('poke', {}, function () { return 0; }) === GAME.SAY.poke[0] &&
  GAME.pickLine('poke', {}, function () { return 0.999; }) === GAME.SAY.poke[GAME.SAY.poke.length - 1]);
var repeatBad = [];
['idle', 'greet', 'poke', 'season'].forEach(function (name) {
  var ctx = name === 'season' ? { bucket: 'spring' } : { hour: 20 };
  var last = GAME.pickLine(name, ctx);
  for (var i = 0; i < 200; i++) {
    var got = GAME.pickLine(name, ctx, null, last);
    if (got === last) repeatBad.push(name + ':' + got);
    last = got;
  }
});
check('带上上一句就不会连着两句一模一样（200 轮 × 四格都不撞带）',
  repeatBad.length === 0, JSON.stringify(repeatBad.slice(0, 3)));
// 批次 65：带占位的那几族，`exclude` 里存的是她**说出来**的那一句（填完的）。
// ⚠️ 这条测的是"比的是填完的句子"而不是"比模板" —— 拿模板比，`{name}` 永远不等于填好的句子，
//   那道避让分支一次都不会走到，200 轮里 1/4 概率撞带，红得毫无悬念（不是恒绿的摆设）。
var tRepeat = [];
[['levelup', { name: '熟络', line: '和你待在一起很安心。' }],
  ['achievement', { name: '温柔惯犯', line: '被你摸了一百次，都摸出习惯来了。' }],
  ['daily', { mins: '42' }], ['dailyHigh', { mins: '128' }]].forEach(function (pair) {
  var last = GAME.pickLine(pair[0], pair[1]);
  for (var i = 0; i < 200; i++) {
    var got = GAME.pickLine(pair[0], pair[1], null, last);
    if (got === last) tRepeat.push(pair[0] + ':' + got);
    last = got;
  }
});
check('带占位那几族连着两句也不重样（exclude 比的是填完之后的句子，不是模板）',
  tRepeat.length === 0, JSON.stringify(tRepeat.slice(0, 3)));

// ⑤ 摸头池子加宽 + onPat 的 lastLine
check('PAT_LINES 每级至少三句且与等级表同长（旧值 2 句/级，一下午必撞重复）',
  GAME.PAT_LINES.length === GAME.LEVELS.length &&
  GAME.PAT_LINES.every(function (g) { return g.length >= 3; }),
  GAME.PAT_LINES.map(function (g) { return g.length; }).join(','));
check('PAT_CAP_LINES ≥5 句（到顶那句实话一天要说很多次）', GAME.PAT_CAP_LINES.length >= 5, GAME.PAT_CAP_LINES.length);
var patRepeat = '', patBad = [];
for (var pi = 0; pi < 60; pi++) {
  var st = GAME.rollDay({ affection: 40, day: DAY }, DAY);
  st.patsToday = 0;
  var pr = GAME.onPat(st, DAY, Date.now(), patRepeat);
  if (pr.line && pr.line === patRepeat) patBad.push(pr.line);
  if (pr.line) patRepeat = pr.line;
}
check('onPat 传了上一句就不重样（60 次连戳）', patBad.length === 0, JSON.stringify(patBad.slice(0, 3)));
check('onPat 不传第四参时行为与旧调用点一致（仍给一句本级台词）',
  typeof GAME.onPat(GAME.rollDay({ affection: 40, day: DAY }, DAY), DAY, Date.now()).line === 'string');

// ⑥ 两处界面必须从规则层取词，不许再自带池子（这一格是防"漂移回去"的静态闸）
var fs = require('fs');
var path = require('path');
function srcOf(f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); }
var petSrc = srcOf('popup/pet.js'), pageSrc = srcOf('content.js');
check('popup/pet.js 不再自带 POKES / SEASON_LINES 池子',
  !/var\s+POKES\s*=/.test(petSrc) && !/var\s+SEASON_LINES\s*=/.test(petSrc));
check('popup/pet.js 与 content.js 都走 pickLine（台词真源只有一份）',
  /pickLine\(/.test(petSrc) && /pickLine\(/.test(pageSrc));
// 批次 65：升级／成就／日报那三句以前**两处各抄一份**（字符串拼接），这一格钉"抄回去就报警"。
// ⚠️ 判据是**拼接形状**而不是字面：池子里当然有「好感度达到」这几个字，但那在规则层；
//   界面里再出现 `'…「' + name` / `'…」！' + def.line` 这种拼法，就是第二份真源又长出来了。
var COPY_ANCHORS = [
  // ⚠️ 锚点必须**咬住"这是说出来的那句"**：界面里还有正当的 `'「' + name + '」'` 拼接
  //   （宠物徽章那行「下一级「X」还差 N 点」是**标签**不是台词，两处都有），
  //   不加 say/pagePetSay 前缀它会一并报上来 —— 会误报的守卫和没有守卫一样害人。
  ['说出来的台词里拼等级/成就名', /(?:say|sayAs|pagePetSay|pagePetSayLine)\s*\(\s*['"][^'"\n]*['"]\s*\+/],
  ['说出来的台词里拼分钟数', /(?:say|sayAs|pagePetSay|pagePetSayLine)\s*\(\s*['"][^'"\n]*刷了 ['"]\s*\+/]
];
var copiedLine = [];
[['popup/pet.js', petSrc], ['content.js', pageSrc]].forEach(function (pair) {
  COPY_ANCHORS.forEach(function (a) { if (a[1].test(pair[1])) copiedLine.push(pair[0] + ' ← ' + a[0]); });
});
check('两处界面都不再把等级名/成就名/分钟数拼进台词（第二份真源不许长回来）',
  copiedLine.length === 0, JSON.stringify(copiedLine));
// 称号的读法也只许有一份真源：界面若绕过 displayLevelOf 直接拿 levelOf 现算，
// 棘轮就等于没装 —— 表现正是用户说的那句"更新完她突然不熟了"。
// ⚠️ 先摘掉整行注释再匹配（批次 98 那一族：注释里提一句"别再调 levelOf()"就能把守卫搅浑）。
function codeOnly(src) {
  return src.split('\n').filter(function (ln) {
    var t = ln.replace(/^\s+/, '');
    return t.indexOf('//') !== 0 && t.indexOf('*') !== 0;
  }).join('\n');
}
var rawLevelRead = [];
[['popup/pet.js', petSrc], ['content.js', pageSrc]].forEach(function (pair) {
  var code = codeOnly(pair[1]);
  if (!/displayLevelOf\(/.test(code)) rawLevelRead.push(pair[0] + ' 没走 displayLevelOf');
  if (/(^|[^A-Za-z])levelOf\(/.test(code)) rawLevelRead.push(pair[0] + ' 还在自己算 levelOf');
});
check('两处界面都只从 displayLevelOf 读称号（不许再各自拿 levelOf 现算，棘轮才承重）',
  rawLevelRead.length === 0, JSON.stringify(rawLevelRead));
// 进度句交空串的意思是"这一格没话"。界面若再补一句兜底文案，就是那句写死的「（等冬天）」
// 换个位置长回来 —— 新 kinds 又会被标成假话，而且这回藏在规则层调用后面，更难看见。
var achHintFallback = [];
[['popup/pet.js', petSrc], ['content.js', pageSrc]].forEach(function (pair) {
  if (/achHint\([^)]*\)\s*(\|\||\?\?)/.test(codeOnly(pair[1]))) achHintFallback.push(pair[0]);
});
check('界面不许给进度句补兜底文案（achHint 交空串=这格没话，补一句假的就是旧 bug 回魂）',
  achHintFallback.length === 0, JSON.stringify(achHintFallback));

// ══ 存档版本化与「永不掉级」（批次 100）══════════════════════════════
// 用户要的是这一句：「保证更新的时候吉祥物不会从很熟变成不熟这种充满挫败感的情况」。
// 1.3.0 已经发生过一半：上限 100 → 240、六档 → 八档，当年刷满 100 的老档今天读出来是
// 「100 / 240，下一级还差 40 点」—— 称号没退（六道老门槛一字没动），但"我们到过顶"这件事
// 在界面上一点痕迹都不留，用户读到的就是突然生疏了。下面这批断言钉四件事：
//   ① 老尺度写下的存档，换算后显示的等级**与当年完全一致**（按 0 到当年上限逐格遍历）
//   ② 换算不许把 affection 放大（悄悄送分是另一种"更新把我当小孩"）
//   ③ 到过的档位只升不降（棘轮）—— 将来有人抬门槛或压上限也退不回去
//   ④ rollDay 幂等：新增字段漏携带，第二次读写就静默丢掉

var OLD = (GAME.PAST_SCALES || [])[0] || {};
check('PAST_SCALES 登记了第 1 代的尺度（上限／门槛清单／纪念成就 id 三样都齐）',
  OLD.version === 1 && OLD.max > 0 && Array.isArray(OLD.levelMins) && OLD.levelMins.length > 0 && !!OLD.grant,
  JSON.stringify(OLD));
// 历史门槛与当前表前 N 档对账 —— 两条独立写下的数据必须一致；不一致就是"改了史实"，
// 那一族的后果由下一条遍历断言指到具体哪一个好感度会掉档。
check('登记的历史门槛与当前等级表前 ' + OLD.levelMins.length + ' 档一字不差（改已有门槛=当众掉级，得显式认账）',
  GAME.LEVELS.slice(0, OLD.levelMins.length).map(function (l) { return l.min; }).join(',') === OLD.levelMins.join(','),
  '表内=' + GAME.LEVELS.map(function (l) { return l.min; }).join(',') + ' 史实=' + OLD.levelMins.join(','));

/** 第 1 代尺度下**当年界面会显示**的那一档 —— 门槛取自登记的历史数据，不从 LEVELS 现推 */
function legacyLevelOf(a) {
  var lv = 0;
  for (var i = 0; i < OLD.levelMins.length; i++) if (a >= OLD.levelMins[i]) lv = i;
  return lv;
}
var titleBad = [], inflateBad = [], verBad = [];
for (var oa = 0; oa <= OLD.max; oa++) {
  // 第 1 代存档的真实形状：没有 bondVersion、没有 peak*、没有成就表之外的字段
  var v1 = GAME.rollDay({ affection: oa, day: DAY, patsToday: 0, studyPointsToday: 0, countedSeconds: 0 }, DAY);
  if (GAME.displayLevelOf(v1) !== legacyLevelOf(oa)) {
    titleBad.push(oa + ' 档=' + (GAME.LEVELS[GAME.displayLevelOf(v1)] || {}).name);
  }
  if (v1.affection !== oa) inflateBad.push(oa + ' 分=' + v1.affection);
  if (v1.bondVersion !== GAME.BOND_VERSION) verBad.push(oa + ' 版本=' + v1.bondVersion);
}
check('黄金老档逐格遍历（0 到当年上限 ' + OLD.max + '，一格不漏）：称号与当年一字不差、好感一个不放大、版本补上',
  titleBad.length === 0 && inflateBad.length === 0 && verBad.length === 0,
  JSON.stringify({ title: titleBad.slice(0, 3), inflate: inflateBad.slice(0, 3), ver: verBad.slice(0, 3) }));

// 棘轮真正承重的场景：好感那一格被压回去了（将来压上限／垃圾存档手改），称号仍不许倒退
var ratchet = GAME.rollDay({ affection: 20, day: DAY, bondVersion: GAME.BOND_VERSION, peakLevel: 6, peakAffection: 150 }, DAY);
check('棘轮：到过第七档的人就算好感被压回 20 也仍显示第七档（只升不降）',
  GAME.displayLevelOf(ratchet) === 6 && GAME.levelOf(ratchet.affection) === 1
  && ratchet.affection === 20 && ratchet.peakAffection === 150,
  JSON.stringify({ show: GAME.displayLevelOf(ratchet), raw: GAME.levelOf(ratchet.affection), aff: ratchet.affection }));
check('棘轮自己也不许越界（手改存档吹到 99 档，界面按数组取元素不许崩）',
  GAME.displayLevelOf(GAME.rollDay({ affection: 0, day: DAY, peakLevel: 99 }, DAY)) === GAME.LEVELS.length - 1
  && GAME.displayLevelOf(null) === 0);

// 「当年满过格」只认那一代的满格，且必须是一枚**纪念**（不靠统计、也不人人有份）
function achIds(list) { return list.map(function (a) { return a.id; }).join(','); }
function byId(id) {
  for (var i = 0; i < GAME.ACHIEVEMENTS.length; i++) if (GAME.ACHIEVEMENTS[i].id === id) return GAME.ACHIEVEMENTS[i];
  return null;
}
var maxedV1 = GAME.rollDay({ affection: OLD.max, day: DAY }, DAY);
check('当年刷满上限的老档记下"满过"，并点亮「' + OLD.grant + '」（补一枚纪念，而不是把数字补大）',
  maxedV1.legacyCeil === OLD.max &&
  GAME.evaluateAchievements(maxedV1, DAY).map(function (a) { return a.id; }).sort().join(',') ===
    [OLD.grant, seasonAchOf(DAY)].sort().join(','),
  JSON.stringify({ ceil: maxedV1.legacyCeil, got: achIds(GAME.evaluateAchievements(maxedV1, DAY)) }));
var almostV1 = GAME.rollDay({ affection: OLD.max - 1, day: DAY }, DAY);
check('差一点没满的老档不许白送这一枚（上限那一格就是那一格）',
  almostV1.legacyCeil === 0 && achIds(GAME.evaluateAchievements(almostV1, DAY)).indexOf(OLD.grant) < 0,
  achIds(GAME.evaluateAchievements(almostV1, DAY)));
check('今天新建的档拿不到这一枚（是纪念，不是签到），但版本号照样写上',
  GAME.rollDay(null, DAY).legacyCeil === 0 && GAME.rollDay(null, DAY).bondVersion === GAME.BOND_VERSION
  && achIds(GAME.evaluateAchievements(GAME.rollDay(null, DAY), DAY)).indexOf(OLD.grant) < 0);
// 回滚留下的"比当前还新"的档：字段照带、数字照留、棘轮照旧不回退，但版本标记**降回当前** ——
// 因为换算必须幂等（上面那条遍历），降回来才能在下一次升版时补做那一代的换算。
var newer = GAME.rollDay({ affection: OLD.max, day: DAY, bondVersion: 99, ach: { pat100: 'x' }, peakLevel: 6 }, DAY);
check('比当前更新的档（回滚留下的）不补领纪念、字段照带、棘轮照旧不退，版本标记降回当前以便补换算',
  newer.legacyCeil === 0 && newer.affection === OLD.max && newer.bondVersion === GAME.BOND_VERSION
  && newer.ach.pat100 === 'x' && newer.peakLevel === 6, JSON.stringify(newer));

// 幂等 + 携带：漏一格字段 = 下次读写把它静默丢掉（这正是 1.3.0 那批字段容易踩的坑）
var probeIn = { affection: 40, day: DAY, totalPats: 9, totalStudyMinutes: 120, nightPats: 3,
  streakDays: 2, lastMetDay: DAY, ach: { pat100: DAY }, peakLevel: 3, peakAffection: 40,
  legacyCeil: OLD.max, bondVersion: 1 };
var pass1 = GAME.rollDay(probeIn, DAY), pass2 = GAME.rollDay(pass1, DAY);
var drift = Object.keys(pass1).filter(function (k) {
  return JSON.stringify(pass1[k]) !== JSON.stringify(pass2[k]);
}).concat(Object.keys(pass2).filter(function (k) { return !(k in pass1); }));
check('rollDay 幂等且字段全携带（第二次过一遍，一格不变也不多长一格）',
  drift.length === 0, JSON.stringify({ drift: drift, keys: Object.keys(pass1).length }));
var carriedAll = Object.keys(probeIn).filter(function (k) {
  return k !== 'bondVersion' && JSON.stringify(pass1[k]) !== JSON.stringify(probeIn[k]);
});
check('喂进去的每一格都读得回来（除版本标记外不许被换算改掉）',
  carriedAll.length === 0, JSON.stringify(carriedAll));

// ── 成就那侧：进度句搬进规则层，界面不许再自己写死兜底 ──
var hintState = GAME.rollDay({ affection: 0, day: DAY, totalPats: 7, totalStudyMinutes: 30,
  streakDays: 2, nightPats: 1 }, DAY);
var noHint = GAME.ACHIEVEMENTS.filter(function (a) { return String(GAME.achHint(hintState, a)).length === 0; });
check('每一枚未点亮的成就都得有一句进度（界面原先写死"等冬天"兜底，新 kinds 会被标成假话）',
  noHint.length === 0, noHint.map(function (a) { return a.id + ' need=' + JSON.stringify(a.need); }).join(' | '));
check('进度句里的数是读回来的，不是常量（30 分钟说 0.5 小时、7 次说 7/100、连击 2 说 2/7）',
  GAME.achHint(hintState, byId('pat100')) === '（7/100）'
  && GAME.achHint(hintState, byId('study600')) === '（0.5 / 10 小时）'
  && GAME.achHint(hintState, byId('streak7')) === '（2/7 天）'
  && GAME.achHint(hintState, byId('night20')) === '（1/20）',
  ['pat100', 'study600', 'streak7', 'night20'].map(function (i) { return i + '=' + GAME.achHint(hintState, byId(i)); }).join(' | '));
check('季节那一句照 need.season 说季节名（不再写死"冬天"），认不出的 need 交空串不硬凑',
  GAME.achHint(hintState, { need: { season: 'autumn' } }) === '（等秋天）'
  && GAME.achHint(hintState, { need: { season: 'rainy' } }) === '（等那个季节）'
  && GAME.achHint(hintState, { need: { whatever: 1 } }) === ''
  && GAME.achHint(hintState, null) === '');
check('进度句只认 need、不看亮没亮（亮不亮归界面判，规则层不该两份都算）',
  GAME.achHint(GAME.markAchievements(hintState, ['pat100'], DAY), byId('pat100')) === '（7/100）',
  GAME.achHint(hintState, byId('pat100')));

// C 阶段新增的 need 种类（peakLevel / patsToday / studyPointsToday）：进度句与判达标都从状态读。
// peakLevel 那句按「第几级」1 起算（与文档「10 级」同一口径）； affection 给 100 是故意的 ——
// rollDay 末尾的 bumpPeak 只会往上记，别让它把 peakLevel 顶过夹具给的 6，否则期望值就是猜的。
var hintPeak = GAME.rollDay({ affection: 100, day: DAY, totalPats: 7, totalStudyMinutes: 30,
  streakDays: 2, nightPats: 1, patsToday: 4, studyPointsToday: 9, peakLevel: 6 }, DAY);
check('新增三档 need 的进度句都从状态读数（峰值档 1 起算、当日两格按今天读）',
  GAME.achHint(hintPeak, byId('peakTop')) === '（曾到过 7 / 10 级）'
  && GAME.achHint(hintPeak, byId('fullDayPats')) === '（今天 4/6 次）'
  && GAME.achHint(hintPeak, byId('fullDayStudy')) === '（今天 9/15 点）',
  ['peakTop', 'fullDayPats', 'fullDayStudy'].map(function (i) { return i + '=' + GAME.achHint(hintPeak, byId(i)); }).join(' | '));
var evalIds = GAME.evaluateAchievements(
  GAME.rollDay({ affection: 0, day: DAY, patsToday: 6, studyPointsToday: 15, peakLevel: 9 }, DAY),
  DAY).map(function (a) { return a.id; });
check('新增三档 need 真会被判达标（峰值到顶 / 摸满当日 / 刷满当日；11 月那季成就也会亮，成员式断言容得住）',
  ['peakTop', 'fullDayPats', 'fullDayStudy'].every(function (i) { return evalIds.indexOf(i) >= 0; }),
  JSON.stringify(evalIds));

// 成就表本身的形状：id 唯一、四样齐全、台词填进庆祝模板后仍在 34 字上限内
var achIdsAll = GAME.ACHIEVEMENTS.map(function (a) { return a.id; });
var dupAch = achIdsAll.filter(function (v, i) { return achIdsAll.indexOf(v) !== i; });
var thinAch = GAME.ACHIEVEMENTS.filter(function (a) {
  return !a.id || !a.name || !a.desc || !a.line || !a.need || Object.keys(a.need).length === 0;
});
check('每一枚成就都有 id/名称/说明/台词与非空 need，id 不重样',
  dupAch.length === 0 && thinAch.length === 0,
  JSON.stringify({ dup: dupAch, thin: thinAch.map(function (a) { return a.id; }) }));
var achOverflow = [];
GAME.ACHIEVEMENTS.forEach(function (a) {
  (GAME.SAY.achievement || []).forEach(function (tpl) {
    var out = filledOf(tpl.replace(/\{name\}/g, a.name).replace(/\{line\}/g, a.line));
    if (out.length > 34) achOverflow.push(a.id + '=' + out.length);
  });
});
check('成就台词填进庆祝模板后仍 ≤34 字（量的是**填完之后**，不是句子本身）',
  achOverflow.length === 0, JSON.stringify(achOverflow));
check('纪念成就说明里那个数就是登记过的当年上限（写了数字就得同源）',
  byId(OLD.grant) && String(byId(OLD.grant).desc).indexOf(String(OLD.max)) >= 0,
  byId(OLD.grant) ? byId(OLD.grant).desc : '（没有这枚成就）');

// ══ 记忆翻牌：发牌 / 每天首胜 / 最佳纪录棘轮（批次 108，D 阶段）════════
// e2e 只验「面板开得开、牌翻得动」；配对规则与记账全在规则层，这里用纯函数量。
function deckInfo(deck) {
  var uniq = deck.filter(function (v, i, a) { return a.indexOf(v) === i; });
  return { total: deck.length, faces: uniq.length,
    allFromFaces: uniq.every(function (f) { return GAME.ART.FACES.indexOf(f) >= 0; }),
    eachTwice: uniq.every(function (f) { return deck.filter(function (x) { return x === f; }).length === 2; }) };
}
var detI = 0;
var dDeck1 = GAME.dealMemoryDeck(function () { return (detI++) / 1000; });
var dInfo1 = deckInfo(dDeck1);
check('发牌 12 张 = 6 对、每张恰好两枚、全部来自表情池（配对判定靠 data-face 对得上）',
  dInfo1.total === GAME.RULES.memoryPairs * 2 && dInfo1.faces === GAME.RULES.memoryPairs
  && dInfo1.allFromFaces && dInfo1.eachTwice,
  JSON.stringify(dInfo1));
var dDeckHalf = GAME.dealMemoryDeck(function () { return 0.5; });
check('常数 rnd 仍是合法牌堆（洗牌不许抛异常）', deckInfo(dDeckHalf).total === GAME.RULES.memoryPairs * 2
  && deckInfo(dDeckHalf).eachTwice, JSON.stringify(deckInfo(dDeckHalf)));
var dDeckNaN = GAME.dealMemoryDeck(function () { return NaN; });
check('恒 NaN 的 rnd 退化为恒等交换也不抛（烂随机数不能让面板开不出牌）',
  dDeckNaN.length === GAME.RULES.memoryPairs * 2
  && dDeckNaN.slice(0, GAME.RULES.memoryPairs).every(function (f, i) { return dDeckNaN[GAME.RULES.memoryPairs + i] === f; }),
  JSON.stringify(dDeckNaN.slice(0, 3)));

var mState = GAME.rollDay({ affection: 10, day: DAY }, DAY);
var mW1 = GAME.recordMemoryWin(mState, DAY, 9, 42);
check('首胜 +1：好感入账、memoryRewardDay 记下今天、胜场起账、最佳按步数落档',
  mW1.gained === GAME.RULES.gameDailyReward && mW1.firstToday === true
  && mW1.state.affection === 11 && mW1.state.memoryRewardDay === DAY
  && mW1.state.memoryWins === 1 && mW1.state.memoryBestMoves === 9
  && mW1.state.memoryBestSeconds === 42,
  JSON.stringify({ gained: mW1.gained, aff: mW1.state.affection, best: mW1.state.memoryBestMoves }));
var mW2 = GAME.recordMemoryWin(mW1.state, DAY, 12, 50);
check('同天第二局纯玩：不涨好感、胜场照记、首胜标记不再亮',
  mW2.gained === 0 && mW2.firstToday === false && mW2.state.memoryWins === 2
  && mW2.state.affection === 11 && mW2.state.memoryRewardDay === DAY);
var mW3 = GAME.recordMemoryWin(mW2.state, DAY, 7, 30);
check('更少步数刷新最佳（棘轮往上）', mW3.bestMoves === true
  && mW3.state.memoryBestMoves === 7 && mW3.state.memoryBestSeconds === 30);
var mW4 = GAME.recordMemoryWin(mW3.state, DAY, 11, 5);
check('更差的成绩不许把最佳往下带', mW4.bestMoves === false
  && mW4.state.memoryBestMoves === 7 && mW4.state.memoryBestSeconds === 30);
var mW5 = GAME.recordMemoryWin(mW4.state, DAY, 7, 21);
check('平步数比秒数：更快那局刷新', mW5.bestMoves === true
  && mW5.state.memoryBestMoves === 7 && mW5.state.memoryBestSeconds === 21);
var mW6 = GAME.recordMemoryWin(mW5.state, DAY, 7, 44);
check('平步数更慢不刷新（不是随便写）', mW6.bestMoves === false
  && mW6.state.memoryBestMoves === 7 && mW6.state.memoryBestSeconds === 21);
var NEXT_DAY = '2026-11-02';
var mCarried = GAME.rollDay(mW6.state, NEXT_DAY);
check('rollDay 携带翻牌四格：胜场/最佳/秒数照旧，memoryRewardDay 不重置（它是门槛不是余额）',
  mCarried.memoryWins === mW6.state.memoryWins && mCarried.memoryBestMoves === 7
  && mCarried.memoryBestSeconds === 21 && mCarried.memoryRewardDay === DAY,
  JSON.stringify({ rewardDay: mCarried.memoryRewardDay, wins: mCarried.memoryWins }));
var mW7 = GAME.recordMemoryWin(mCarried, NEXT_DAY, 8, 40);
check('跨天首胜再领一次（门槛比对 todayKey，过了就重亮）',
  mW7.gained === GAME.RULES.gameDailyReward && mW7.firstToday === true
  && mW7.state.memoryRewardDay === NEXT_DAY);
var mMax = GAME.recordMemoryWin(GAME.rollDay({ affection: GAME.RULES.max, day: DAY }, DAY), DAY, 6, 20);
check('好感满值那天的首胜照样记账（clamp 吃掉 +1，不许出现"满了就整天白玩"的特殊状态）',
  mMax.gained === GAME.RULES.gameDailyReward && mMax.state.affection === GAME.RULES.max
  && mMax.state.memoryRewardDay === DAY && mMax.leveledUp === false);
var mEdge = GAME.recordMemoryWin(GAME.rollDay({ affection: 14, day: DAY }, DAY), DAY, 5, 10);
check('跨级那局 leveledUp=true 且 level 指新档', mEdge.leveledUp === true
  && mEdge.level === GAME.levelOf(15) && mEdge.state.affection === 15);
var mFresh = GAME.rollDay({ affection: 0, day: DAY }, DAY);
check('没玩过的老档 rollDay 补出翻牌四格（不补就是 undefined 算术）',
  mFresh.memoryWins === 0 && mFresh.memoryBestMoves === 0
  && mFresh.memoryBestSeconds === 0 && mFresh.memoryRewardDay === '');
check('gamewin 台词池非空且抽得出来（空池=赢了不说话，静默失灵）',
  (GAME.SAY.gamewin || []).length >= 2
  && GAME.SAY.gamewin.indexOf(GAME.pickLine('gamewin', {}, null, '')) >= 0);

// ══ 用户向文档里那两处数字，与规则层同源（批次 100）═══════════════════
// 本轮把「6 枚成就」改成 7 枚 —— 而 README / 说明书里那个数是手抄的。
// AGENTS §4：「行为改了而文档没改，是这一族唯一的失败形状」，集成 403、e2e 1529、界面字样三条闸
// 一条都不会红，只有照说明书理解现场的用户被引到错方向。所以照第 30 项（换课上限）的手法办。
// ⚠️ 只核**承诺页**（README + 说明书），不核 CHANGELOG —— 那里写的是史实，按 AGENTS 不回改。
function docText(f) {
  var raw;
  try { raw = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (e) { return null; }
  // 注释与 script 里的出现不算（第 27 项同一口径）：那两处用户看不见，抄错也不该红
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
}
var docAchBad = [], docLevelBad = [], docNameBad = [], docLevelNameBad = [];
['README.md', 'docs/manual.html'].forEach(function (f) {
  var txt = docText(f);
  if (txt === null) { docAchBad.push(f + ' 读不到'); docLevelBad.push(f + ' 读不到'); docNameBad.push(f + ' 读不到'); docLevelNameBad.push(f + ' 读不到'); return; }
  var ach = (txt.match(/(\d+)\s*枚成就/g) || []).map(function (s) { return Number(/\d+/.exec(s)[0]); });
  var lv = (txt.match(/好感度?分?\s*(?:<b>|\*\*)?(\d+)\s*级/g) || [])
    .concat(txt.match(/(\d+)\s*级成长/g) || [])
    .map(function (s) { return Number(/\d+/.exec(s)[0]); });
  if (!ach.length) docAchBad.push(f + ' 一处「N 枚成就」都没写（句子被改断，闸要跟着改）');
  if (!lv.length) docLevelBad.push(f + ' 一处「N 级」都没写（句子被改断，闸要跟着改）');
  ach.forEach(function (n) { if (n !== GAME.ACHIEVEMENTS.length) docAchBad.push(f + ' 写 ' + n + ' 枚、真源 ' + GAME.ACHIEVEMENTS.length); });
  lv.forEach(function (n) { if (n !== GAME.LEVELS.length) docLevelBad.push(f + ' 写 ' + n + ' 级、真源 ' + GAME.LEVELS.length); });
  GAME.ACHIEVEMENTS.forEach(function (a) { if (txt.indexOf(a.name) < 0) docNameBad.push(f + ' 缺「' + a.name + '」'); });
  GAME.LEVELS.forEach(function (l) { if (txt.indexOf(l.name) < 0) docLevelNameBad.push(f + ' 缺「' + l.name + '」'); });
});
check('文档里「N 枚成就」那个数与规则层同源（README + 说明书，且句子不许被改断到扫不着）',
  docAchBad.length === 0, JSON.stringify(docAchBad));
check('文档里「好感分 N 级 / N 级成长」那个数与等级表同源（README + 说明书）',
  docLevelBad.length === 0, JSON.stringify(docLevelBad));
check('每一枚成就的名字都出现在 README 与说明书里（新增成就没登记=用户看不见的功能）',
  docNameBad.length === 0, JSON.stringify(docNameBad));
check('每一档好感称号名都出现在 README 与说明书里（追加档位没登记=用户不知道自己到过哪）',
  docLevelNameBad.length === 0, JSON.stringify(docLevelNameBad));

// ⚠️ 句数也是**对用户承诺的数字**（AGENTS §4「改了行为没改文档」那一族）。这两处原先写的是
//   「二十五句 / 一百三十来句」—— 后面那个数从没量过（真源 95 句，现在 110），
//   而"来句"这种中文概数正则也抓不住。所以口径改成**阿拉伯数字 + 两条都核对**。
var bondTotal = bondKeys.reduce(function (a, k) { return a + GAME.SAY.idleBond[k].length; }, 0);
var docSaidBad = [];
['README.md', 'docs/manual.html'].forEach(function (f) {
  var txt = docText(f);
  if (txt === null) { docSaidBad.push(f + ' 读不到'); return; }
  var said = txt.match(/随口\S{0,6}句就有\s*(?:<b>|\*\*)?(\d+)\s*句/);
  var tot = txt.match(/全部加起来\s*(?:<b>|\*\*)?(\d+)\s*句/);
  if (!said) docSaidBad.push(f + ' 那句「随口…句就有 N 句」扫不着（被改断了，闸要跟着改）');
  if (!tot) docSaidBad.push(f + ' 那句「全部加起来 N 句」扫不着（被改断了，闸要跟着改）');
  if (said && Number(said[1]) !== idleFlat.length + bondTotal) {
    docSaidBad.push(f + ' 写 ' + said[1] + ' 句、真源 ' + (idleFlat.length + bondTotal));
  }
  if (tot && Number(tot[1]) !== allLines.length) docSaidBad.push(f + ' 写 ' + tot[1] + ' 句、真源 ' + allLines.length);
});
check('文档里那句「随口 N 句 / 全部 N 句」与台词表同源（句数是承诺，手抄必然过期）',
  docSaidBad.length === 0, JSON.stringify(docSaidBad));

// 新小游戏也是对用户的承诺：名字要登记、那个「+N」必须与 RULES.gameDailyReward 同源
var docGameBad = [];
['README.md', 'docs/manual.html'].forEach(function (f) {
  var txt = docText(f);
  if (txt === null) { docGameBad.push(f + ' 读不到'); return; }
  if (txt.indexOf('记忆翻牌') < 0) docGameBad.push(f + ' 没提「记忆翻牌」（新功能没登记=用户看不见）');
  var gain = txt.match(/每天首胜\s*(?:<b>|\*\*)?\+\s*(\d+)/);
  if (!gain) docGameBad.push(f + ' 那句「每天首胜 +N」扫不着（被改断了，闸要跟着改）');
  else if (Number(gain[1]) !== GAME.RULES.gameDailyReward) {
    docGameBad.push(f + ' 写 +' + gain[1] + '、真源 +' + GAME.RULES.gameDailyReward);
  }
});
check('文档里「记忆翻牌 / 每天首胜 +N」与规则层同源（README + 说明书）',
  docGameBad.length === 0, JSON.stringify(docGameBad));

console.log('');
if (failures.length) {
  console.log('小游戏规则测试未通过：' + failures.length + ' 项');
  process.exitCode = 1;
} else {
  console.log('小游戏规则测试通过：' + checks + ' 项');
}
