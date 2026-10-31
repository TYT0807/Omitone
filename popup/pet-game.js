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
 *   - 加等级   → LEVELS 加一行（min 是好感度门槛）；
 *   - 加台词   → PAT_LINES 按等级加一组；
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
    max: 100,                 // 好感度上限
    patAffection: 1,          // 每次有效摸头的好感度
    patDailyCap: 20,          // 每日有效摸头次数（之后摸头只有演出、不再涨）
    studyMinutesPerPoint: 30, // 每刷课 30 分钟折 1 点好感
    studyPointsDailyCap: 10   // 刷课每日最多贡献的好感（= 150 分钟封顶）
  };

  // ── 等级表（按 min 升序；line 是升级时她会说的话）────────────────────
  var LEVELS = [
    { min: 0,  name: '初识',     line: '初次见面，请多指教～' },
    { min: 15, name: '打过招呼', line: '我们算认识啦！' },
    { min: 30, name: '熟络',     line: '和你待在一起很安心。' },
    { min: 50, name: '亲近',     line: '你已经是我最重要的伙伴了。' },
    { min: 70, name: '挚友',     line: '无论刷到多晚，我都陪着你。' },
    { min: 90, name: '形影不离', line: '有你在的地方，就是我的位置。' }
  ];

  // ── 摸头台词（按等级一组，随机抽一句；不含升级台词——那由 LEVELS.line 出）──
  var PAT_LINES = [
    ['谢谢你的摸摸～', '嘿嘿，很舒服。'],
    ['今天也来看我啦？', '摸摸充电中…'],
    ['你的手好暖。', '再摸一下也可以哦。'],
    ['嗯～最喜欢这样了。', '刷课累了吧？歇一下嘛。'],
    ['有你在，什么题都不怕。', '今晚也一起加油！'],
    ['无论多久，我都会在这里。', '和你在一起的每一天都开心。']
  ];

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /** 本地时区 YYYY-MM-DD（跨天判定用；用户半夜刷课要算当天，不许用 UTC） */
  function dayKeyOf(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 当前等级下标（LEVELS 按 min 升序，取最后一个满足门槛的） */
  function levelOf(affection) {
    var lv = 0;
    for (var i = 0; i < LEVELS.length; i++) if (affection >= LEVELS[i].min) lv = i;
    return lv;
  }

  /** 跨天兜底：任何读写前都过一遍 —— 日期变了就重置每日配额，字段缺失补默认值 */
  function rollDay(state, todayKey) {
    var s = state && typeof state === 'object' ? state : {};
    var next = {
      affection: clamp(Number(s.affection) || 0, 0, RULES.max),
      day: String(s.day || ''),
      patsToday: Number(s.patsToday) || 0,
      studyPointsToday: Number(s.studyPointsToday) || 0,
      countedSeconds: Number(s.countedSeconds) || 0
    };
    if (next.day !== todayKey) {
      next.day = todayKey;
      next.patsToday = 0;
      next.studyPointsToday = 0;
    }
    return next;
  }

  /**
   * 记一次摸头。
   * @returns {{state, gained, leveledUp, level, line}}
   *   line = 这次摸头她要说的话：升级时说等级台词，否则说本级摸头台词（可能为空串）
   */
  function onPat(state, todayKey) {
    var next = rollDay(state, todayKey);
    var beforeLevel = levelOf(next.affection);
    var gained = 0;
    var line = '';
    if (next.patsToday < RULES.patDailyCap) {
      next.patsToday += 1;
      gained = RULES.patAffection;
      next.affection = clamp(next.affection + gained, 0, RULES.max);
    }
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
    var afterLevel = levelOf(next.affection);
    return { state: next, gained: allowed, leveledUp: afterLevel > beforeLevel, level: afterLevel };
  }

  return {
    RULES: RULES,
    LEVELS: LEVELS,
    PAT_LINES: PAT_LINES,
    dayKeyOf: dayKeyOf,
    levelOf: levelOf,
    rollDay: rollDay,
    onPat: onPat,
    applyStudySeconds: applyStudySeconds
  };
});
