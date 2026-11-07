/**
 * 小角色的成长小游戏 —— 好感度 / 等级 / 刷课时长（规则层）。
 *
 * 定位与边界（和 pet.js 的既有原则完全同向）：
 *   - 数据全部本地：好感度存弹窗自己的 localStorage；刷课时长来自 content.js
 *     写进 chrome.storage 的 `omitoneStudyStats`（只读消费）；
 *   - 对刷课逻辑零反向影响：没有任何代码路径从这里写回调度/答题状态；
 *   - 本文件只放**纯规则**（可被 Node 测试），存取与演出在 pet.js 里。
 *
 * 拓展点（想加内容就是加数据，不是改逻辑）：
 *   - 加等级   → LEVELS 加一行（min 是好感度门槛；只准往后追加，勿动老门槛）；
 *   - 加台词   → PAT_LINES 按等级加一组；
 *   - 加成就   → ACHIEVEMENTS 加一行（id/name/desc/need/line）；
 *   - 调手感   → RULES 一处（摸头上限 / 每日刷课转化上限 / 每多少分钟一点）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitonePetGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 规则表 ──────────────────────────────────────────────────────────
  var RULES = {
    max: 240,                 // 好感度上限（1.3.0 首发 100；加到 240 是给老档留出继续养的空间）
    patAffection: 1,          // 每次有效摸头的好感度
    patDailyCap: 20,          // 每日有效摸头次数（之后摸头只有演出、不再涨）
    studyMinutesPerPoint: 30, // 每刷课 30 分钟折 1 点好感
    studyPointsDailyCap: 10   // 刷课每日最多贡献的好感（= 150 分钟封顶）
  };

  // ── 等级表（按 min 升序；line 是升级时她会说的话）────────────────────
  // ⚠️ 前六级门槛勿动：老存档（上限 100 时代）按这套门槛点亮等级，改了等于当着
  //    用户的面降级。加等级只准**往后追加**。
  var LEVELS = [
    { min: 0,   name: '初识',     line: '初次见面，请多指教～' },
    { min: 15,  name: '打过招呼', line: '我们算认识啦！' },
    { min: 30,  name: '熟络',     line: '和你待在一起很安心。' },
    { min: 50,  name: '亲近',     line: '你已经是我最重要的伙伴了。' },
    { min: 70,  name: '挚友',     line: '无论刷到多晚，我都陪着你。' },
    { min: 90,  name: '形影不离', line: '有你在的地方，就是我的位置。' },
    { min: 140, name: '心有灵犀', line: '原来陪伴久了，连沉默都很舒服。' },
    { min: 200, name: '岁月同行', line: '从初识走到今天，谢谢你没缺席。' }
  ];

  // ── 摸头台词（按等级一组，随机抽一句；不含升级台词——那由 LEVELS.line 出）──
  var PAT_LINES = [
    ['谢谢你的摸摸～', '嘿嘿，很舒服。'],
    ['今天也来看我啦？', '摸摸充电中…'],
    ['你的手好暖。', '再摸一下也可以哦。'],
    ['嗯～最喜欢这样了。', '刷课累了吧？歇一下嘛。'],
    ['有你在，什么题都不怕。', '今晚也一起加油！'],
    ['无论多久，我都会在这里。', '和你在一起的每一天都开心。'],
    ['这份默契，不用说出来也存在。', '和你并肩坐着，就很有干劲。'],
    ['不管刷到多晚，我都在。', '往后也请多指教啦。']
  ];

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /** 本地时区 YYYY-MM-DD（跨天判定用；用户半夜刷课要算当天，不许用 UTC） */
  function dayKeyOf(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 某天的「昨天」的 dayKey（连续见面判定用；跨夏令时的误差可容忍，只影响连击一天） */
  function prevDayKeyOf(todayKey) {
    var t = new Date(todayKey + 'T00:00:00').getTime();
    if (!isFinite(t)) return '';
    return dayKeyOf(t - 86400000);
  }

  /** 当前等级下标（LEVELS 按 min 升序，取最后一个满足门槛的） */
  function levelOf(affection) {
    var lv = 0;
    for (var i = 0; i < LEVELS.length; i++) if (affection >= LEVELS[i].min) lv = i;
    return lv;
  }

  /** 跨天兜底：任何读写前都过一遍 —— 日期变了就重置每日配额，字段缺失补默认值。
   *  ⚠️ 新增存档字段必须在这里补携带，否则下次读写会被这层重建静默丢掉。 */
  function rollDay(state, todayKey) {
    var s = state && typeof state === 'object' ? state : {};
    var next = {
      affection: clamp(Number(s.affection) || 0, 0, RULES.max),
      day: String(s.day || ''),
      patsToday: Number(s.patsToday) || 0,
      studyPointsToday: Number(s.studyPointsToday) || 0,
      countedSeconds: Number(s.countedSeconds) || 0,
      // ── 成就/长线统计（1.3.0 起）──
      totalPats: Number(s.totalPats) || 0,
      totalStudyMinutes: Number(s.totalStudyMinutes) || 0,
      nightPats: Number(s.nightPats) || 0,
      streakDays: Number(s.streakDays) || 0,
      lastMetDay: String(s.lastMetDay || ''),
      ach: (s.ach && typeof s.ach === 'object' && !Array.isArray(s.ach)) ? s.ach : {}
    };
    if (next.day !== todayKey) {
      next.day = todayKey;
      next.patsToday = 0;
      next.studyPointsToday = 0;
    }
    return next;
  }

  // ── 成就（纯装饰：解锁只多一句台词和一格亮灯，不影响任何功能）────────
  // need 是达标条件；evaluate 时逐条对照统计字段。加成就 = 这里加一行。
  var ACHIEVEMENTS = [
    { id: 'pat100',    name: '温柔惯犯',  desc: '累计摸头 100 次',
      need: { pats: 100 },          line: '被你摸了一百次，都摸出习惯来了。' },
    { id: 'study600',  name: '学习搭子',  desc: '累计陪伴刷课 10 小时',
      need: { studyMinutes: 600 },  line: '十个小时了——这都是我们俩的时间。' },
    { id: 'streak7',   name: '天天见面',  desc: '连续 7 天都见面',
      need: { streakDays: 7 },      line: '连续一周都见面，这算不算默契？' },
    { id: 'streak30',  name: '老朋友',    desc: '连续 30 天都见面',
      need: { streakDays: 30 },     line: '一个月了。你已经是我生活的一部分。' },
    { id: 'night20',   name: '夜猫子搭档', desc: '累计 20 次凌晨（0-5 点）摸头',
      need: { nightPats: 20 },      line: '这个点还醒着啊……记得早点休息，我陪你。' },
    { id: 'firstSnow', name: '初雪之约',  desc: '在下雪的季节（12-2 月）来摸摸她',
      need: { season: 'winter' },   line: '冬天的第一场雪，是你陪我一起看的。' }
  ];

  function seasonOf(todayKey) {
    var m = Number(String(todayKey || '').slice(5, 7));
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
  }

  /** 记一次「今天见过面」：同一天多次只算一次，跨天连续则连击 +1，断了归 1 */
  function touchDay(state, todayKey) {
    if (!state || state.lastMetDay === todayKey) return state;
    state.streakDays = (state.lastMetDay === prevDayKeyOf(todayKey)) ? (state.streakDays || 0) + 1 : 1;
    state.lastMetDay = todayKey;
    return state;
  }

  /** 对照成就表，返回**新达标且尚未点亮**的成就（不写状态，markAchievements 才写） */
  function evaluateAchievements(state, todayKey) {
    var out = [];
    if (!state || typeof state !== 'object') return out;
    var lv = levelOf(state.affection);
    var season = seasonOf(todayKey);
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (state.ach && state.ach[a.id]) continue;
      var met = false;
      if (a.need.pats != null) met = (state.totalPats || 0) >= a.need.pats;
      else if (a.need.studyMinutes != null) met = (state.totalStudyMinutes || 0) >= a.need.studyMinutes;
      else if (a.need.streakDays != null) met = (state.streakDays || 0) >= a.need.streakDays;
      else if (a.need.nightPats != null) met = (state.nightPats || 0) >= a.need.nightPats;
      else if (a.need.season != null) met = season === a.need.season;
      if (met) out.push(a);
    }
    return out;
  }

  /** 把已解锁的成就写进存档（id → 解锁那天的 dayKey） */
  function markAchievements(state, ids, todayKey) {
    if (!state || !state.ach) state.ach = {};
    for (var i = 0; i < ids.length; i++) {
      if (!state.ach[ids[i]]) state.ach[ids[i]] = todayKey;
    }
    return state;
  }

  /**
   * 记一次摸头。
   * @returns {{state, gained, leveledUp, level, line}}
   *   line = 这次摸头她要说的话：升级时说等级台词，否则说本级摸头台词（可能为空串）
   */
  function onPat(state, todayKey, now) {
    var next = rollDay(state, todayKey);
    var beforeLevel = levelOf(next.affection);
    var gained = 0;
    var line = '';
    if (next.patsToday < RULES.patDailyCap) {
      next.patsToday += 1;
      gained = RULES.patAffection;
      next.affection = clamp(next.affection + gained, 0, RULES.max);
    }
    next.totalPats += 1;                                  // 成就统计：每次摸头都算（每日上限只锁好感入账）
    var hour = new Date(now || Date.now()).getHours();    // 凌晨与否看本地钟（dayKey 没有时刻字段）
    if (hour >= 0 && hour < 5) next.nightPats += 1;       // 夜猫子搭档
    touchDay(next, todayKey);
    var afterLevel = levelOf(next.affection);
    if (afterLevel > beforeLevel) {
      line = (LEVELS[afterLevel] || {}).line || '';
    } else {
      var lines = PAT_LINES[Math.min(afterLevel, PAT_LINES.length - 1)] || [];
      if (lines.length) line = lines[Math.floor(Math.random() * lines.length)];
    }
    return { state: next, gained: gained, leveledUp: afterLevel > beforeLevel, level: afterLevel, line: line };
  }

  /**
   * 把统计到的刷课时长折算成好感度。
   *
   * 水位（countedSeconds）只按**实际转化为分数的秒数**推进 —— 今天被每日上限
   * 挡住的部分留在水位之后，明天接着算（今天刷 3 小时不会一次全折完，也不会蒸发）。
   * @param {number} activeSeconds 统计层报上来的今日累计活跃秒数
   * @returns {{state, gained, leveledUp, level}}
   */
  function applyStudySeconds(state, activeSeconds, todayKey) {
    var next = rollDay(state, todayKey);
    var beforeLevel = levelOf(next.affection);
    var perPointSeconds = RULES.studyMinutesPerPoint * 60;
    var pending = Math.max(0, (Number(activeSeconds) || 0) - next.countedSeconds);
    var earnable = Math.floor(pending / perPointSeconds);
    var room = RULES.studyPointsDailyCap - next.studyPointsToday;
    var allowed = Math.max(0, Math.min(earnable, room));
    next.countedSeconds += allowed * perPointSeconds;
    next.studyPointsToday += allowed;
    next.affection = clamp(next.affection + allowed, 0, RULES.max);
    if (allowed > 0) {
      next.totalStudyMinutes += allowed * RULES.studyMinutesPerPoint;   // 成就统计：只记实际入账的分钟
      touchDay(next, todayKey);
    }
    var afterLevel = levelOf(next.affection);
    return { state: next, gained: allowed, leveledUp: afterLevel > beforeLevel, level: afterLevel };
  };

  return {
    RULES: RULES,
    LEVELS: LEVELS,
    PAT_LINES: PAT_LINES,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dayKeyOf: dayKeyOf,
    prevDayKeyOf: prevDayKeyOf,
    seasonOf: seasonOf,
    levelOf: levelOf,
    rollDay: rollDay,
    touchDay: touchDay,
    evaluateAchievements: evaluateAchievements,
    markAchievements: markAchievements,
    onPat: onPat,
    applyStudySeconds: applyStudySeconds
  };
});
