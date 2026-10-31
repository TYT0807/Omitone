/**
 * 刷课活跃时长统计 —— 小游戏（好感度）的数据源，纯函数、可独立测试。
 *
 * 数据源是 content.js 收到的 `runtime_log` 消息流：**只有插件真的在跑、
 * 页面真的是学习页时才有消息** —— 所以「两条消息的间隔」就是刷课活跃的天然信号。
 *
 * 设计约束（与 pet 的「零耦合」原则同向）：
 *   - 纯读侧：只消费已经发生的日志事件，绝不向调度/答题链路注入任何东西；
 *   - 有损无妨：这是游戏数值不是计费账单，页面关闭丢掉最后一段（≤落盘间隔）可接受；
 *   - 任何调用方的失败都被上层 try/catch 吞掉，绝不能影响刷课本身。
 *
 * 同时兼容 content script 隔离世界（挂 self.OmitoneStudyStats）与 Node（module.exports）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitoneStudyStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 两条活跃信号间隔 ≤90s 视为同一段连续刷课（日志本身是节流过的，
  // 5 秒一轮的 study 循环远密于这个上限；间隔过长 = 挂机/合盖，不计入）
  var SESSION_GAP_MS = 90 * 1000;
  // 落盘节流：攒够 20 秒的新增活跃才写一次 storage，别把 chrome.storage 打爆
  var FLUSH_MIN_MS = 20 * 1000;

  /** 本地时区的 YYYY-MM-DD（跨天清零用；不许用 UTC —— 用户半夜刷课算当天） */
  function localDateKey(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * 记一次活跃信号。
   * @param {Object|null} state 已持久化状态 {date, activeSeconds, lastActiveAt, lastFlushAt}
   * @param {number} nowMs 本次信号时间戳
   * @returns {{state: Object, gained: number}} gained = 本次信号为今天新增的活跃秒数
   */
  function recordActivity(state, nowMs) {
    var s = state && typeof state === 'object' ? state : {};
    var today = localDateKey(nowMs);
    var sameDay = s.date === today;
    var next = {
      date: today,
      activeSeconds: sameDay ? (Number(s.activeSeconds) || 0) : 0,
      lastActiveAt: nowMs,
      // 落盘基线：新的一天/新会话以当前信号起算 —— 「从未落盘」绝不能拿
      // 纪元时间当基线（否则 first flush 判定永远是"该写了"，实测踩过）
      lastFlushAt: sameDay ? (Number(s.lastFlushAt) || nowMs) : nowMs
    };

    var gained = 0;
    var last = Number(s.lastActiveAt) || 0;
    if (last && nowMs > last && nowMs - last <= SESSION_GAP_MS) {
      gained = Math.round((nowMs - last) / 1000);
      next.activeSeconds += gained;
    }
    // last 缺失（首条信号）或间隔过长 → 新的一段：间隔不计，只推进游标
    return { state: next, gained: gained };
  }

  /** 是否该落盘：今天确有新增，且距上次落盘点又攒够了 FLUSH_MIN_MS 的活跃
   *  （首刷也一样等 —— 打开页面晃一下就写 storage 没有意义） */
  function shouldFlush(state) {
    var s = state || {};
    if (!(Number(s.activeSeconds) > 0)) return false;
    var lastFlushAt = Number(s.lastFlushAt) || 0;
    var lastActiveAt = Number(s.lastActiveAt) || 0;
    return lastActiveAt - lastFlushAt >= FLUSH_MIN_MS;
  }

  /** 标记「已写到这个活跃点」—— 把 lastFlushAt 推进到本次落盘对应的活跃位置 */
  function markFlushed(state, nowMs) {
    var s = state || {};
    var copy = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
    copy.lastFlushAt = Number(nowMs) || Number(s.lastActiveAt) || 0;
    return copy;
  }

  return {
    recordActivity: recordActivity,
    shouldFlush: shouldFlush,
    markFlushed: markFlushed,
    localDateKey: localDateKey,
    SESSION_GAP_MS: SESSION_GAP_MS,
    FLUSH_MIN_MS: FLUSH_MIN_MS
  };
});
