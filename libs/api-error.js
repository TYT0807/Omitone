/**
 * AI 服务商报错的分类器 —— 错误文案的唯一真源。
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

  return { describe: describe, extractProviderMessage: extractProviderMessage };
});
