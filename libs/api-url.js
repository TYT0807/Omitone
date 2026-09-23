/**
 * Omitone API 地址构造与密钥清洗 —— 唯一真源。
 *
 * 这段逻辑原本在 content.js 和 popup/popup.js 里各写了一份（还有一份在
 * legacy/background-core.js），三份已经出现细微分叉：只有 popup 那份会顺带
 * 剥掉用户粘贴时带上的引号。抽出来之后两边行为一致，改一处即可。
 *
 * 同时兼容 content script 隔离世界（挂 self.OmitoneApiUrl）与 Node（module.exports）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitoneApiUrl = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_OPENAI_BASE = 'https://api.minimaxi.com';
  var DEFAULT_CLAUDE_BASE = 'https://api.anthropic.com';
  var DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';

  /**
   * 清洗用户粘贴的 API Key：
   * 去掉首尾空白、包裹的引号（从 JSON / 配置文件里复制时常见）、
   * 以及 `Bearer ` 前缀（用户常把整段 Authorization 头贴进来）。
   *
   * ⚠️ **顺序是关键：必须先剥引号、再剥 `Bearer`。** 反过来会漏掉最常见的那种粘贴 ——
   * 从 JSON 配置里整段复制出来的 `"Bearer sk-xxx"`（引号把 Bearer 一起包住了）：
   *   - 先剥 Bearer：它以引号开头，`^Bearer` 匹配不上 → 原样留着
   *   - 再剥引号：变成 `Bearer sk-xxx` —— **前缀还在**
   * 调用方是这么用的：`'Authorization': 'Bearer ' + normalizeApiKey(key)`
   * （`content.js`），于是真正发出去的是 **`Bearer Bearer sk-xxx`** →
   * 服务端一律 **401**，而用户看到的是"Key 填错了"，完全找不到原因。
   *
   * 这里用一个有界的循环跑到"稳定"为止，顺带覆盖双层包裹
   * （`'Bearer "sk-xxx"'`、`"  Bearer sk-xxx  "` 这类）。
   */
  function normalizeApiKey(apiKey) {
    var out = String(apiKey || '').trim();
    for (var i = 0; i < 3; i++) {
      var before = out;
      out = out.replace(/^["']+|["']+$/g, '').trim();   // 先剥引号
      out = out.replace(/^Bearer\b\s*/i, '').trim();    // 再剥 Bearer 前缀
      if (out === before) break;                        // 已稳定，提前收工
    }
    return out;
  }

  /** 去掉末尾斜杠，统一成可拼接的基址 */
  function trimBase(apiUrl) {
    return String(apiUrl || '').trim().replace(/\/+$/, '');
  }

  function buildOpenAICompatibleUrl(apiUrl) {
    var base = trimBase(apiUrl);
    if (!base) return DEFAULT_OPENAI_BASE + '/v1/chat/completions';
    if (/\/v1\/chat\/completions$/i.test(base) || /\/chat\/completions$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }

  function buildClaudeApiUrl(apiUrl) {
    var base = trimBase(apiUrl) || DEFAULT_CLAUDE_BASE;
    if (/\/v1\/messages$/i.test(base) || /\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return base + '/messages';
    return base + '/v1/messages';
  }

  function buildGeminiApiUrl(apiUrl, model, apiKey) {
    var base = trimBase(apiUrl) || DEFAULT_GEMINI_BASE;
    if (/\/models\/[^/]+:generateContent/i.test(base)) {
      if (/[?&]key=/.test(base)) return base;
      return base + (base.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(apiKey);
    }
    var root = /\/v1beta$/i.test(base) ? base : base + '/v1beta';
    return root + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
  }

  return {
    DEFAULT_OPENAI_BASE: DEFAULT_OPENAI_BASE,
    normalizeApiKey: normalizeApiKey,
    buildOpenAICompatibleUrl: buildOpenAICompatibleUrl,
    buildClaudeApiUrl: buildClaudeApiUrl,
    buildGeminiApiUrl: buildGeminiApiUrl
  };
});
