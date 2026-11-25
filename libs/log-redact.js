/**
 * 日志导出面的凭据掩码 —— 唯一真源（队列 #210）。
 *
 * 这一族原本有两套政策，而且**面向用户那套最松**：
 * `popup-log-view.js` 的「复制日志」把 meta 整份 `JSON.stringify` 原样交出去（零掩码），
 * `tools/field-logs.js` 只按**键名**掩 —— `{url:"…?key=<KEY>"}` 键名是 `url`，过闸。
 * 两份口径各写各的正是 AGENTS §4 第 30 项「掩码函数只许有一份」那一族，
 * 而漂移方向是用户那一侧。现在两侧都调这一份。
 *
 * 三处共用：弹窗（`popup.html` 用 `<script>` 挂 `self.OmitoneLogRedact`）、
 * node 侧 `tools/field-logs.js`（`require`）、以及 `omitone-popup-log-test.cjs`
 * 的 vm 台（先跑本文件再跑 `popup-log-view.js`，与弹窗的加载顺序一致）。
 *
 * ⚠️ 判据方向与平时**相反**：认不出的形状一律**打掉**而不是放行，
 *   旁边留一格 `(形状可疑，已屏蔽)` —— 导出面宁可少说，不可多说（AGENTS §2 #12）。
 * ⚠️ 掩码必须排在截断**之前**：先切 300 字再把尾巴打掉，剩下的正好是一段被切短的凭据。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitoneLogRedact = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MASKED = '(已屏蔽)';
  var SUSPECT = '(形状可疑，已屏蔽)';
  var ELLIPSIS = '…';
  // 边界由函数自己带，不许调用方各配一份（批次 9-D 争来的深度闸就是被各配一份配没的）。
  var MAX_STRING = 300;
  var MAX_ITEMS = 8;
  var DEPTH_NORMAL = 3;
  var DEPTH_WIDE = 8;
  var WIDE_WIDTH = 240;

  // 键名一撞就当敏感：值整个打掉，不看内容（`tools/field-logs.js` 既有断言钉的就是这一格）。
  var SENSITIVE_KEY = /(key|token|secret|password|passwd|pwd|authorization|cookie|credential|apikey)/i;

  // 查询串里**认得**的参数名：打掉等号右边，留住 `?key=` 这一形状，
  // 好让人说得出「是哪一发带出去的」，又不交出凭据。
  var KNOWN_PARAM = /^(?:key|token|secret|password|passwd|pwd|auth|authorization|sig|signature|access|apikey|access[_.-]?token|api[_.-]?key|x[_.-]api[_.-]?key)$/i;
  // **认不出**的那一格：参数名带着凭据字样、却不在上面那份名单里 —— 名字都不认识，
  // 更不敢赌等号右边只有凭据，于是整段打掉。（`chapterId` / `courseId` / `cpi` / `enc` 都不撞这一族）
  // 名字先按驼峰拆成下划线形状，`authToken` / `accessToken` 这一族才量得到；
  // 尾部允许一串数字（`passwd2` 要打掉，`keyboard` 不能误伤）。
  var FAMILY_PARAM = /(?:^|[-_.])(?:key|token|secret|passwd|password|pwd|auth|authorization|sig|signature|credential|apikey)(?:[-_.]|\d*(?:[-_.]|$))/i;
  var QUERY_PAIR = /([?&])([^=&#]+?)=(.*?)((?=[&#])|$)/g;

  // 头一族的形状：JSON 里是 `"x-api-key":"sk-…"`，冒号前后都可能带引号。
  // ⚠️ `Authorization: Bearer <t>` 的凭据在**第二段**，所以先摘 scheme+token，
  //    再摘不带 scheme 的那一支（负向前瞻防止把 `Bearer` 这个词当成凭据打掉、把真 token 留下；
  //    那条 `(?!\()` 是防第二段重打时把已经摘成 `(已屏蔽)` 的形状又改写成冒号形状）。
  var HEADER_CRED = /\b(authorization|proxy-authorization|x[-_.]api[-_.]key|api[-_.]key)\b["']?\s*[:=]\s*["']?(?!Bearer\b|Basic\b|\()([^\s,;'"]+)/gi;
  var AUTH_SCHEME = /\b(Bearer|Basic)\s+(["']?)[^\s,;'"]+/gi;
  // 裸 token：服务商自己那几种前缀（`sk-` / `ghp_` / `xoxb-`）。
  var RAW_TOKEN = /\b(?:sk|ghp|gho|ghu|ghs|xoxb)[-_][A-Za-z0-9]{10,}\b/g;

  function maxDepthFromWidth(width) {
    var w = Number(width);
    return (Number.isFinite(w) && w > WIDE_WIDTH) ? DEPTH_WIDE : DEPTH_NORMAL;
  }

  // 名字先按驼峰拆出边界（`authToken` → `auth_token`），否则 `FAMILY_PARAM` 那道
  // 「边界 + 词 + 边界」的尺对连写名字恒读不出。**只做这一件**，不改写原样。
  function nameShape(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  }

  function maskQuery(str) {
    var suspect = false;
    var out = str.replace(QUERY_PAIR, function (whole, sep, name, value) {
      var raw = String(name).trim();
      var n = nameShape(raw);
      if (KNOWN_PARAM.test(n)) return value ? sep + raw + '=' + MASKED : whole;
      if (FAMILY_PARAM.test(n)) suspect = true;
      return whole;
    });
    return suspect ? null : out;
  }

  function sanitizeString(value) {
    var str = String(value);
    var query = maskQuery(str);
    if (query === null) return SUSPECT;
    var out = query
      .replace(HEADER_CRED, function (whole, name) { return name + ': ' + MASKED; })
      .replace(AUTH_SCHEME, function (whole, scheme) { return scheme + ' ' + MASKED; })
      .replace(RAW_TOKEN, MASKED);
    return out;
  }

  function truncate(str) {
    return str.length > MAX_STRING ? str.slice(0, MAX_STRING) + ELLIPSIS : str;
  }

  function walk(value, depth, limit, ancestors) {
    if (depth > limit) return ELLIPSIS;
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncate(sanitizeString(value));
    if (typeof value !== 'object') return value;
    if (ancestors.indexOf(value) >= 0) {
      // 循环引用交回「可读的兜底」这条路，由调用方的 catch 说话，不许在这里静默变成一份原文。
      throw new Error('cyclic meta');
    }
    var next = ancestors.concat([value]);
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ITEMS).map(function (x) { return walk(x, depth + 1, limit, next); });
    }
    var out = {};
    Object.keys(value).forEach(function (k) {
      out[k] = SENSITIVE_KEY.test(k) ? MASKED : walk(value[k], depth + 1, limit, next);
    });
    return out;
  }

  /**
   * @param {*} obj 日志条目的 meta
   * @param {{width?:number, maxDepth?:number}} [options] `width` 走 field-logs 那把行宽尺；
   *        不给就用 DEPTH_NORMAL。**深度由这里自己算**，调用方不许再各配一份。
   */
  function redactMeta(obj, options) {
    var opts = options || {};
    var limit = (typeof opts.maxDepth === 'number') ? opts.maxDepth : maxDepthFromWidth(opts.width);
    return walk(obj, 0, limit, []);
  }

  return {
    redactMeta: redactMeta,
    sanitizeString: sanitizeString,
    maxDepthFromWidth: maxDepthFromWidth,
    MASKED: MASKED,
    SUSPECT: SUSPECT,
    ELLIPSIS: ELLIPSIS,
    SENSITIVE_KEY: SENSITIVE_KEY,
    KNOWN_PARAM: KNOWN_PARAM,
    FAMILY_PARAM: FAMILY_PARAM,
    MAX_STRING: MAX_STRING,
    MAX_ITEMS: MAX_ITEMS,
    DEPTH_NORMAL: DEPTH_NORMAL,
    DEPTH_WIDE: DEPTH_WIDE,
    WIDE_WIDTH: WIDE_WIDTH
  };
});
