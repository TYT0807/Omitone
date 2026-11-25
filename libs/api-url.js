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

  /**
   * 「这家有哪些型号」那一条地址 —— 与上面三个 chat 地址同一把尺，唯一真源。
   *
   * 为什么要在库里而不是弹窗里就地拼：弹窗原先只有钉死的预置模型名（批次 124 之前
   * 连自定义渠道都只能手抄），抄错一个字符就是 400/404 那一族。
   *
   * ⚠️ 用户粘进「API URL」那格的常常是**完整的 chat 地址**
   * （`https://xxx/v1/chat/completions`），所以这一族必须先把尾巴摘掉再换 `/models`，
   * 照抄 `buildOpenAICompatibleUrl` 的四种形状，别另立一套。
   */
  function buildModelsUrl(apiUrl, apiType) {
    if (apiType === 'claude') {
      var cbase = trimBase(apiUrl) || DEFAULT_CLAUDE_BASE;
      if (/\/v1\/models$/i.test(cbase) || /\/models$/i.test(cbase)) return cbase;
      if (/\/v1$/i.test(cbase)) return cbase + '/models';
      return cbase + '/v1/models';
    }
    if (apiType === 'gemini') {
      var gbase = trimBase(apiUrl) || DEFAULT_GEMINI_BASE;
      if (/\/models$/i.test(gbase)) return gbase;
      var groot = /\/v1beta$/i.test(gbase) ? gbase : gbase + '/v1beta';
      return groot + '/models';
    }
    var obase = trimBase(apiUrl);
    if (!obase) return DEFAULT_OPENAI_BASE + '/v1/models';
    // 摘掉 chat 那一截尾巴：`/v1/chat/completions` → `/v1`，`/chat/completions` → 空
    var stripped = obase.replace(/\/chat\/completions$/i, '');
    if (/\/v1\/models$/i.test(stripped) || /\/models$/i.test(stripped)) return stripped;
    if (/\/v1$/i.test(stripped)) return stripped + '/models';
    return stripped + '/v1/models';
  }

  /**
   * 把 `/models` 的回包收成一份型号名清单。
   *
   * 三家的形状不一样（OpenAI 兼容与 Claude 都是 `data: [{id}]`，Gemini 是
   * `models: [{name: "models/xxx"}]`），所以这里**只认这两把键**；
   * 认不出来一律回 `unreadable`，**绝不猜**。
   *
   * ⚠️ 「猜」在这里比「没有结论」危险（AGENTS §2 #18）：把 `display_name`
   * 或整条 `object` 当成型号名交出去，界面会显示一个**发不出去**的名字，
   * 用户拿它去答题只会收到「模型不存在」。
   * 清单里**任何**一个元素取不出合法型号名 → 整份按 `unreadable` 交回，
   * 而不是「取到几个算几个」—— 半份清单会让人以为这家只有这几个型号。
   *
   * 返回 `{ state: 'ok' | 'empty' | 'unreadable', ids, source, why }`：
   * `empty` 与 `unreadable` **各占一格**（§2 #12），不许压成同一句「没有型号」。
   */
  function parseModelIds(raw) {
    var data = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) return { state: 'unreadable', ids: [], source: '', why: 'body-empty' };
      try { data = JSON.parse(raw); } catch (e) { return { state: 'unreadable', ids: [], source: '', why: 'not-json' }; }
    }
    if (!data || typeof data !== 'object') {
      return { state: 'unreadable', ids: [], source: '', why: 'not-object' };
    }
    var list = null, source = '';
    if (Array.isArray(data.data)) { list = data.data; source = 'data'; }
    else if (Array.isArray(data.models)) { list = data.models; source = 'models'; }
    else return { state: 'unreadable', ids: [], source: '', why: 'no-list' };

    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var item = list[i], id = '';
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') id = String(item.id || item.name || '');
      id = id.replace(/^models\//, '').trim();      // gemini 的 name 带 `models/` 前缀
      if (!id) return { state: 'unreadable', ids: [], source: source, why: 'bad-element' };
      if (!seen[id]) { seen[id] = 1; out.push(id); }
    }
    return { state: out.length ? 'ok' : 'empty', ids: out, source: source, why: '' };
  }

  return {
    DEFAULT_OPENAI_BASE: DEFAULT_OPENAI_BASE,
    normalizeApiKey: normalizeApiKey,
    buildOpenAICompatibleUrl: buildOpenAICompatibleUrl,
    buildClaudeApiUrl: buildClaudeApiUrl,
    buildGeminiApiUrl: buildGeminiApiUrl,
    buildModelsUrl: buildModelsUrl,
    parseModelIds: parseModelIds
  };
});
