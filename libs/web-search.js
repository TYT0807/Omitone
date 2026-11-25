/**
 * DeepSeek 服务端联网搜索 —— 「能不能搜 / 这一发搜了几次 / 花了多少 token」的唯一真源。
 *
 * ## 为什么要有这一份
 * 问模型的出口有**三处**：弹窗「和她聊天」（popup/popup.js 的 petChatSend）、
 * 弹窗「让她解释」（同一个 petChatSend，换了提示词键）、上课页她自己开口体检
 * （content.js 的 doctorAskModel，走后台 api_fetch）。
 * 三处各写一份"这个渠道能不能带 tools"，就一定会有第 N 处忘了写 ——
 * 而这一族的失败形状是**不报错、不留日志，只是那一发根本没带搜索**，
 * 用户听到的却是一句听起来像"我已经查过了"的话（AGENTS §2 #18：
 * 声明覆盖的范围与实际走的分支之间的差，不会自己喊出来）。
 *
 * ## 形状是量出来的，不是照文档推的（任务 #183 明确要求）
 * 2026-11-21 用真实请求在本机现场量回（探针 `.workbuddy/probe16x-*.js`，六发）：
 *
 * | 量的事 | 实测读数 |
 * | --- | --- |
 * | 参数走哪条 | `POST https://api.deepseek.com/chat/completions`，`tools: [{type:"deepseek_web_search"}]`，**非流式**就回结论 —— 不需要 `/responses` |
 * | 哪些模型名收 | `deepseek-flash` / `deepseek-chat` / `deepseek-reasoner` 三档都 200 且真搜（`server_tool_use.tool_search` 2~3）—— 所以**资格只看域名，不看模型名** |
 * | 回包里的标记 | `choices[0].message` 多出 `server_tool_calls` 与 `annotations`；`usage.server_tool_use = {tool_search, tool_fetch, tool_image_search}`（**不是** Responses 那族的 `web_search_requests`） |
 * | 花在哪 | 同问一句：不带 tools `prompt_tokens 63`，带 tools **4653**（搜回来的正文按输入 token 计费）；另一发带到 10568 |
 * | 能不能限次 | **没有任何参数能限**：六发里搜几次由服务端自己定（2~3 次），我们只能决定"这一发带不带 tools" |
 * | 搜索给的日子准不准 | 五发分别说成 5月18日 / 7月6日 / 7月8日 / 7月14日 / 7月15日，而当天是 11 月 21 日 —— **不许对用户承诺"今天的信息"** |
 *
 * ## 为什么默认关，而且"读不出"不许算开
 * 用户那句口径是「DeepSeek 的搜索能用就配，但**不能消耗我们的余额**」。
 * 量完之后这条落成两句真话：搜索调用本身不计费，**但搜回来的正文按输入 token 计费**，
 * 一句天气能多花两个数量级的输入。所以这枚开关默认关，
 * 并且只有在"域名确实是官方那一个"时才可能打开 ——
 * 中转站带 tools 是**别人家的服务器**替我们搜索，费用与内容都不受我们约束，
 * 那种情况一律当场灰掉并说清原因，绝不静默当"已经搜过了"。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitoneWebSearch = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 官方域：**只有这一枚 host** 有资格带 tools。
  // 大小写不敏感（用户手粘时常带大写），但**不做后缀匹配** ——
  // `api.deepseek.com.ru` 这种"看着像"的地址必须落到 not-official，
  // 拿后缀匹配就是替中转站开了绿灯。
  var OFFICIAL_HOST = 'api.deepseek.com';

  // 服务端自己的工具，声明形状只有一个字段（实测：多写字段不会报错，但也没有"限次"那种字段）。
  var SEARCH_TOOL = { type: 'deepseek_web_search' };

  /** 取 host：只认 http(s) 的绝对地址，别的（相对路径、`//host/path`、空串）一律交空串 = 读不出。 */
  function hostOf(apiUrl) {
    var raw = String(apiUrl || '').trim();
    if (!raw) return '';
    var m = /^https?:\/\/([^/?#\s]+)/i.exec(raw);
    if (!m) return '';
    return String(m[1] || '').split('@').pop().split(':')[0].toLowerCase();
  }

  /** 是不是官方那一个域（去端口、去大小写、不许后缀匹配）。 */
  function isOfficialHost(apiUrl) {
    return hostOf(apiUrl) === OFFICIAL_HOST;
  }

  /**
   * 这一发到底能不能带搜索工具。
   *
   * ⚠️ 判定顺序不许动（AGENTS §2 #5 同一族）：先问开关，再问协议形状，最后才解析地址 ——
   *   把地址那一格排在前面的话，「用户压根没开这枚开关」会被说成「你填的地址不是官方域」，
   *   而用户听完去做的事是去改地址。
   *
   * 返回值 `{ cell, on, why, host }`，**七格各占一格**，谁都不许压进谁（AGENTS §2 #12）：
   *   `off` 用户没开这枚开关（含键缺席 —— 花钱的功能默认不开）
   *   `unknown` 开关真值还没从存储读回来 —— 与 `off` 症状相同（都不搜），
   *             但话必须不同：这时候说"你没开联网搜索"是替用户做了一个他没做过的决定
   *   `no-key` 没填 Key —— 三处出口本来就在更前面折返，这里补一格是为了**不许由它拼出 tools**
   *   `type` 协议形状不是 OpenAI 兼容（claude / gemini 没有这个字段，发过去是 400 或被忽略）
   *   `no-addr` 地址那格是空的 —— 此时实际走的是内置默认渠道，那不是官方域
   *   `not-official` 地址有，但域名不是 `api.deepseek.com`（中转站）
   *   `unreadable` 地址解析不出 host（填的是相对路径或压根不是 URL）
   *   `on` 带得动
   *
   * @param {object} cfg 生效配置（用到 apiType / apiUrl / apiKey / model）
   * @param {boolean|null} switchOn 开关三态；`null`/`undefined` = 还没读到（不许当成 false）
   */
  function decisionOf(cfg, switchOn) {
    var c = cfg || {};
    if (switchOn === null || switchOn === undefined) {
      return { cell: 'unknown', on: false, why: '还没读到开关的真值', host: '' };
    }
    if (switchOn !== true) {
      return { cell: 'off', on: false, why: '联网搜索这枚开关没开', host: '' };
    }
    if (!String(c.apiKey || '').trim()) {
      return { cell: 'no-key', on: false, why: '还没填 API Key', host: '' };
    }
    var type = String(c.apiType || 'openai');
    if (type !== 'openai') {
      return { cell: 'type', on: false, why: '联网搜索只有 DeepSeek 官方接口有这个参数，当前协议形状是 ' + type, host: '' };
    }
    var host = hostOf(c.apiUrl);
    if (!String(c.apiUrl || '').trim()) {
      return { cell: 'no-addr', on: false, why: 'API URL 那格是空的，走的是内置默认渠道，不是 DeepSeek 官方', host: '' };
    }
    if (!host) {
      return { cell: 'unreadable', on: false, why: 'API URL 读不出域名（' + String(c.apiUrl || '').slice(0, 60) + '）', host: '' };
    }
    if (host !== OFFICIAL_HOST) {
      return { cell: 'not-official', on: false, why: '这台是 ' + host + '，不是 DeepSeek 官方域，带上搜索参数就是让别人家的服务器替我们搜', host: host };
    }
    return { cell: 'on', on: true, why: '', host: host };
  }

  /** 该带的那份 tools；带不动就交空数组（调用方据此**整个字段都不写**，别写 `tools: []`）。 */
  function toolsFor(decision) {
    return decision && decision.on ? [{ type: SEARCH_TOOL.type }] : [];
  }

  /**
   * 从回包里把「这一发搜了几次 / 花了多少 token」读回来。
   *
   * ⚠️ 拿不到一律写 **-1**，不许 `Number(x || 0)`（AGENTS §2 #2：超时/缺失被算术压成
   * 一个合法读数，取证里就凭空多出一条方向为"放行"的断言）。
   * `usage` 整份没有 与 「有 usage 但没有 server_tool_use」也是两格：
   * 后者说明**服务端这一发压根没走搜索工具**，这时候对用户说"已经联网查过"就是假话。
   *
   * @returns {{cell:string, search:number, fetch:number, prompt:number, completion:number, cached:number}}
   *   cell：`ok` 有计数 / `no-usage` 回包里没有 usage / `no-tool-cell` 有 usage 但没有搜索那一格 / `bad-shape` data 不是对象
   */
  function usageOf(data) {
    var bad = { cell: 'bad-shape', search: -1, fetch: -1, prompt: -1, completion: -1, cached: -1 };
    if (!data || typeof data !== 'object') return bad;
    var u = data.usage;
    if (!u || typeof u !== 'object') {
      return { cell: 'no-usage', search: -1, fetch: -1, prompt: -1, completion: -1, cached: -1 };
    }
    function num(v) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : -1; }
    var stu = u.server_tool_use;
    var cell = stu && typeof stu === 'object' ? 'ok' : 'no-tool-cell';
    return {
      cell: cell,
      search: stu && typeof stu === 'object' ? num(stu.tool_search) : -1,
      fetch: stu && typeof stu === 'object' ? num(stu.tool_fetch) : -1,
      prompt: num(u.prompt_tokens),
      completion: num(u.completion_tokens),
      cached: num((u.prompt_tokens_details || {}).cached_tokens)
    };
  }

  /** 把读数拼成对用户说话的那一句。读不出那一格照实说，不猜、不四舍五入成"没花"。 */
  function sentenceOf(usage) {
    var r = usage || {};
    if (r.cell === 'no-usage' || r.cell === 'bad-shape') return '这一回没读到用量数据（回包里就没有 usage 那一格）—— 不代表没花钱。';
    if (r.prompt < 0) return '用量读不出（有 usage，但里面的数字认不出来）—— 不代表没花钱。';
    if (r.cell === 'no-tool-cell') {
      return '这次没有联网（服务端回包里没有搜索那一项），按 ' + r.prompt + ' 个输入 token 计的。';
    }
    var head = r.search >= 0 ? '联网查了 ' + r.search + ' 次' : '联网查过（这一回没数出查了几次）';
    if (r.fetch > 0) head += '、翻了 ' + r.fetch + ' 个网页';
    head += '；输入 ' + r.prompt + ' token';
    if (r.cached > 0) head += '（其中 ' + r.cached + ' 个走缓存）';
    if (r.completion >= 0) head += '、输出 ' + r.completion + ' 个';
    head += '。搜回来的内容按输入 token 计费，所以开着它说话比平时贵。';
    return head;
  }

  return {
    OFFICIAL_HOST: OFFICIAL_HOST,
    hostOf: hostOf,
    isOfficialHost: isOfficialHost,
    decisionOf: decisionOf,
    toolsFor: toolsFor,
    usageOf: usageOf,
    sentenceOf: sentenceOf
  };
});
