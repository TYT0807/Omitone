/**
 * AI 服务商报错的分类器 —— 错误文案的唯一真源。
 *
 * 两件事实同住一份文件：**哪一类错**（`describe`）与**是谁家的错**（`channelOf`）。
 * 分成两份就会各说各话 —— 现场排查「这次失败的是哪家哪个模型」时，
 * 日志里只有类别、渠道名得靠人翻弹窗下拉框，两家一多就只能猜。
 *
 * 为什么必须有一个分类器（现场故障）：用户 API 账户没钱了，弹窗测试显示的是
 * 「连接失败 (402): {"error":{"message":"Insufficient Balance"...}}」——
 * 请求明明已经成功到达服务商、被业务规则拒绝，文案却说"连接失败"，
 * 用户于是去查网络、重装插件，唯独没想到去充值。同样形态的还有：
 * OpenAI 系把"没钱"报成 429 + insufficient_quota（按旧规则会被当成网络故障
 * 写 apiConnectionFailed，让答题进 45 秒退避循环）。
 *
 * 设计口径：**一条报错要让人和 AI 都一眼定位** ——
 *   - 人看「【类别】中文说明 —— 下一步」：先说结论，再说该做什么；
 *   - AI（以及贴日志来求助的用户）看「category 标签 + 服务商原话 + HTTP 状态」：
 *     原话永远原样保留，分类只是翻译，不篡改证据。
 *
 * 同时兼容三类世界：content script 隔离世界（挂 self.OmitoneApiError）、
 * popup（popup.html 按路径加载）、Node 测试（module.exports）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitoneApiError = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 从服务商响应体里抠出人话。四家协议的错误体都是 JSON、都把人话放在
   * error.message（OpenAI / DeepSeek / Claude / Gemini 一致），抠不到就原样截断。
   */
  function extractProviderMessage(bodyText) {
    var text = String(bodyText || '').trim();
    if (!text) return '';
    try {
      var data = JSON.parse(text);
      var err = data && data.error;
      var msg = err && (err.message || err.msg || err.status);
      if (msg) return String(msg).slice(0, 300);
    } catch (e) { /* 非 JSON 响应体（HTML 错误页等）—— 原样给出 */ }
    return text.slice(0, 300);
  }

  /**
   * 分类一条 HTTP 失败。
   * @param {number|undefined} status  HTTP 状态码；falsy = 请求根本没到达对方（网络层失败）
   * @param {string} bodyText  响应体原文（可空）
   * @returns {{category: string, human: string}}
   *   category: auth | balance | rate_limit | model | request | server | network
   *   human:    直接可以展示给用户的一行中文（内含类别、下一步、原话、状态码）
   */
  function describe(status, bodyText) {
    var raw = extractProviderMessage(bodyText);
    var hasRaw = !!raw;
    var rawPart = hasRaw ? '服务商原话：' + raw : '';
    var code = typeof status === 'number' && status > 0 ? status : 0;

    // —— 请求没到达对方：这才是真正的「连接失败」——
    if (!code) {
      return {
        category: 'network',
        human: '【连接不上服务商】网络不通、被代理/防火墙拦截或请求超时 —— 先确认电脑能正常上网；校园网可能拦截了 AI 站点。' + (rawPart || '')
      };
    }

    // —— 没钱：402 是显式欠费；OpenAI 系的 429 + insufficient_quota 也是没钱 ——
    var looksQuota = /insufficient|quota|balance|exhaust|欠费|余额|额度/i.test(raw);
    if (code === 402 || (code === 429 && looksQuota)) {
      return {
        category: 'balance',
        human: '【账户余额不足】不是网络问题：请求已经到达服务商，是账户欠费或额度用尽 —— 去服务商控制台充值/购买额度后自动恢复。' + rawPart + '（HTTP ' + code + '）'
      };
    }

    if (code === 401 || code === 403) {
      return {
        category: 'auth',
        human: '【API Key 无效或无权限】常见原因：Key 复制不完整（带了引号/Bearer 前缀/空格）、Key 已被删除或过期、该 Key 无权访问这个模型 —— 去服务商控制台重新生成并整段复制。' + rawPart + '（HTTP ' + code + '）'
      };
    }

    if (code === 404) {
      return {
        category: 'model',
        human: '【模型名或接入地址不对】服务商说不存在这个路径/模型 —— 核对模型名拼写（区分大小写）、该渠道是否提供这个模型、接入地址是否照官方文档填。' + rawPart + '（HTTP 404）'
      };
    }

    if (code === 429) {
      return {
        category: 'rate_limit',
        human: '【触发限流】请求太频繁或超出该账户的速率上限 —— 插件会自动退避重试；持续出现就换小一批题、或到控制台申请提额。' + rawPart + '（HTTP 429）'
      };
    }

    if (code >= 500) {
      return {
        category: 'server',
        human: '【服务商服务端故障】HTTP ' + code + ' —— 不是你的配置问题，等一会儿自动重试即可。' + rawPart
      };
    }

    // 其余 4xx（400 / 413 / 422 …）：请求内容本身被拒
    return {
      category: 'request',
      human: '【服务商拒绝了请求】常见原因：模型名写错、该渠道不支持某个参数、单次内容超限 —— 服务商原话里通常写了具体原因。' + rawPart + '（HTTP ' + code + '）'
    };
  }

  /**
   * 渠道名单 —— 「这一发问的是哪一家、哪个模型」的唯一真源。
   *
   * 为什么要它：AI 挂了的时候，`describe` 说的是**哪一类错**，但没说**是谁家的错**。
   * 多家渠道之间换一家是唯一的自救路径，而第一步是知道自己此刻用的是哪一家 ——
   * 否则用户只能贴一句「连接失败」来求助，谁也答不出该去哪家充值/改模型名。
   *
   * 口径（同一件事先收敛成一种写法）：
   *   - **用户在弹窗选的那一家（`providerPreset`）是身份的真源**，不是接入地址域名 ——
   *     「自定义 OpenAI 兼容」那一路 host 由用户自己填，读出来是一串域名而不是「这家叫什么」；
   *   - preset 缺失或指向已删掉的预置（老存档会这样）才**退回域名**，并明写这是退回；
   *   - 两者都拿不到 → `(渠道读不出)` 单独占一格，不许塌成「没配」或「配错了」。
   *
   * 键名必须与 `popup/popup.js` 的 `PROVIDER_PRESETS` 逐枚相等（集成层有闸对着比）——
   * 加一家却忘了在这里登记，失败日志就会点名成 `(渠道读不出)`，那是当场能发现的红。
   */
  var CHANNEL_LABELS = {
    deepseek: 'DeepSeek',
    kimi: 'Kimi（Moonshot）',
    qwen: '通义千问（DashScope）',
    claude: 'Claude（Anthropic）',
    gemini: 'Gemini（Google）',
    'custom-openai': '自定义渠道'
  };

  function hostOf(apiUrl) {
    try {
      var url = new URL(String(apiUrl || ''));
      return (url.protocol === 'http:' || url.protocol === 'https:') ? url.host.toLowerCase() : '';
    } catch (e) { return ''; }
  }

  /**
   * @param {object} config  **完整**配置（providerPreset / apiUrl / apiType / model）。
   *   ⚠️ 页面侧那份投影里没有这几个键，所以只能在 content script / popup 里问。
   * @returns {{vendor:string, model:string, source:string, text:string}}
   *   source: preset（认得出这家）| host（退回地址域名）| none（读不出）
   *   text:   一行可直接进日志与界面的中文
   */
  function channelOf(config) {
    var cfg = config || {};
    var preset = String(cfg.providerPreset || '').trim();
    var host = hostOf(cfg.apiUrl);
    var vendor = '';
    var source = 'none';
    if (preset && Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, preset)) {
      vendor = CHANNEL_LABELS[preset];
      source = 'preset';
    } else if (host) {
      vendor = host;
      source = 'host';
    } else {
      vendor = '(渠道读不出)';
    }
    var model = String(cfg.model || '').trim();
    // 认不出家的时候，协议（openai / claude / gemini）是唯一还留着的身分线索
    var protocol = ['openai', 'claude', 'gemini'].indexOf(cfg.apiType) !== -1 ? cfg.apiType : '';
    var text = vendor + ' · ' + (model ? model : '(模型名没填)');
    if (source === 'host') text += '（没记录选过哪家，按接入地址认：' + host + '）';
    else if (source === 'none') text += (protocol ? '（协议 ' + protocol + '，但渠道与地址都读不出）' : '（渠道与地址都读不出）');
    return { vendor: vendor, model: model, source: source, text: text };
  }

  /** 只要那一行文字；模块缺失／配置为空都交回 `(渠道读不出)`，不许交回空串。 */
  function channelText(config) {
    try {
      return channelOf(config).text;
    } catch (e) {
      return '(渠道读不出) · (模型名没填)';
    }
  }

  return {
    describe: describe,
    extractProviderMessage: extractProviderMessage,
    channelOf: channelOf,
    channelText: channelText,
    CHANNEL_LABELS: CHANNEL_LABELS
  };
});
