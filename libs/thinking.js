/**
 * Omitone 思考强度 → 各家 API 参数的**唯一真源**。
 *
 * 为什么单独抽出来：
 *   1. 思考参数是**按厂商各写各的**（DeepSeek 用 `thinking:{type}`、
 *      通义用 `enable_thinking`、Kimi 用 `reasoning_effort`），而且厂商改版很勤。
 *      散在 content.js 里改一次要翻半天，这里一眼能看完。
 *   2. 用户报过"某个品牌用不了"，根因往往就是**给不支持该参数的接口发了参数**，
 *      对方直接 400 —— 那种失败看起来像"插件坏了"，极难排查。
 *      所以这里的规则是**白名单**：不认识的渠道，`off` 档一个参数都不发。
 *
 * ⚠️ 诚实声明（不要美化）：
 *   三档里**只有 `off` 是实测过的** —— DeepSeek 关思考，也就是本项目一直以来的行为。
 *   `low` / `high` 的参数是照各家官方文档写的，**没有在真实题库上验证过**。
 *   UI 上必须显示"未验证"。Kimi K3 是**恒思考**模型（关不掉），
 *   选 `off` 时不会报错，但也不会真的关闭 —— 这一点在 `describe()` 里说清楚。
 *
 * 与 api-url.js 一样，同时兼容 content script 隔离世界（self.OmitoneThinking）
 * 与 Node（module.exports），供 tools/ 下的测试直接 require。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitoneThinking = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 三档思考强度。顺序即 UI 顺序：越靠前越省。 */
  var LEVELS = ['off', 'low', 'high'];

  var LEVEL_LABEL = {
    off: '关闭（默认·最省最快）',
    low: '低',
    high: '高'
  };

  function normalizeLevel(level) {
    var value = String(level == null ? '' : level).trim().toLowerCase();
    return LEVELS.indexOf(value) === -1 ? 'off' : value;
  }

  /**
   * 认渠道。用**地址优先**，地址认不出来再看模型名 ——
   * 自定义渠道常常填了别名地址而模型名是官方名，反之亦然，两边都认更稳。
   */
  function detectProvider(apiUrl, model) {
    var url = String(apiUrl || '').toLowerCase();
    var name = String(model || '').toLowerCase();
    if (/deepseek/.test(url) || /deepseek/.test(name)) return 'deepseek';
    if (/moonshot|kimi/.test(url) || /kimi|moonshot/.test(name)) return 'kimi';
    if (/dashscope|aliyuncs|qwen/.test(url) || /^qwen/.test(name)) return 'qwen';
    return 'unknown';
  }

  /**
   * 渠道表。每项：
   *   label          给 UI 看的名字
   *   verifiedLevels **实测过**的档位数组 —— 没有实测过的一律不许写进来
   *   canDisable     是否真的能关掉思考（Kimi K3 为 false）
   *   params         档位 → 要合并进请求体的字段
   *   note           给用户看的说明（UI 直接显示）
   *
   * ⚠️ `verifiedLevels` 是**按档**而不是按渠道的：DeepSeek 只有"关闭"档在真实
   *    答题链路上跑过（那是本项目一直以来的行为），"低/高"只是照官方文档写的。
   *    把整家标成"已实测"是不诚实的，也会让用户以为低/高不会有兼容问题。
   */
  var PROVIDERS = {
    deepseek: {
      label: 'DeepSeek',
      verifiedLevels: ['off'],
      canDisable: true,
      // 官方文档：thinking:{type:enabled|disabled}（默认 enabled）；
      // 强度 reasoning_effort: low|high|max。关思考时不要同时发 reasoning_effort。
      //
      // 为什么要关：V4 默认开思考，一道选择题要先烧约 200 个推理 token
      // 才输出 5 个答案 token（实测 361 → 133）。答题是模式化任务，不需要推理。
      // ⚠️ 实测关闭后模型可能改回 {"answer":...} 对象格式 —— normalizeItem 的兼容层
      // 同时认识位置式与对象式两套输出，这是设计内的抖动，不是回归。
      params: {
        off: { thinking: { type: 'disabled' } },
        low: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
        high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
      },
      note: '唯一实测过的渠道。关闭思考即本项目一直以来的行为。'
    },
    qwen: {
      label: '通义千问（DashScope）',
      verifiedLevels: [],
      canDisable: true,
      // 官方文档：enable_thinking: true|false；强度 reasoning_effort: low|medium|xhigh。
      // 注意**商业版默认关闭思考**（开源版默认开启），所以 off 档要显式发 false 才稳。
      params: {
        off: { enable_thinking: false },
        low: { enable_thinking: true, reasoning_effort: 'low' },
        high: { enable_thinking: true, reasoning_effort: 'xhigh' }
      },
      note: '参数照官方文档填写，未在真实题库验证。'
    },
    kimi: {
      label: 'Kimi（Moonshot）',
      verifiedLevels: [],
      canDisable: false,
      // ⚠️ 资料里有两种说法（reasoning_effort 与 thinking/enable_thinking），
      // 官方文档未直接确认，这里采用与 DeepSeek 相近、且被多份资料提到的
      // reasoning_effort；**关不掉**是明确的（K3 恒思考）。
      params: {
        off: {},
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'max' }
      },
      note: 'K3 是恒思考模型，选"关闭"不会报错但也不会真的关闭；强度参数未验证。'
    },
    unknown: {
      label: '其他 / 自定义',
      verifiedLevels: [],
      canDisable: true,
      // 认不出的渠道：**只在用户显式选了低/高时才发**最通用的 OpenAI 风格字段。
      // off（默认）一个参数都不发 —— 这正是升级前的行为，所以不会把任何人搞挂。
      params: {
        off: {},
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'high' }
      },
      note: '不认识这个渠道。选"关闭"时不发任何参数（最安全）；选低/高会尝试发送通用的 reasoning_effort，部分服务商会拒绝（400）。'
    }
  };

  function providerInfo(provider) {
    return PROVIDERS[provider] || PROVIDERS.unknown;
  }

  /** 这个渠道的这一档，参数是否在真实答题链路上实测过。 */
  function isVerified(provider, level) {
    var list = providerInfo(provider).verifiedLevels || [];
    return list.indexOf(level) !== -1;
  }

  /**
   * 计算这次请求该带哪些思考参数。
   *
   * 返回：
   *   provider   识别到的渠道 key
   *   label      渠道显示名
   *   level      归一化后的档位
   *   params     要合并进请求体的字段（可能为空对象）
   *   verified   **这一档**是否实测过（不是整家渠道）
   *   canDisable 该渠道能否真的关掉思考
   *   note       给用户看的说明
   */
  function buildThinkingParams(config) {
    var cfg = config || {};
    var provider = detectProvider(cfg.apiUrl, cfg.model);
    var info = providerInfo(provider);
    var level = normalizeLevel(cfg.thinkingLevel);
    var params = Object.assign({}, info.params[level] || {});
    return {
      provider: provider,
      label: info.label,
      level: level,
      params: params,
      verified: isVerified(provider, level),
      canDisable: info.canDisable !== false,
      note: info.note || ''
    };
  }

  /** 一行人类可读的说明，写日志 / 上 UI 都用它，避免两处措辞分叉。 */
  function describe(config) {
    var built = buildThinkingParams(config);
    var keys = Object.keys(built.params);
    var sent = keys.length ? JSON.stringify(built.params) : '不发参数';
    var flag = built.verified ? '已实测' : '未验证';
    // 只有"用户要求关闭、但这渠道关不掉"时才提示 —— 说反了会让人以为开着思考是异常
    var compose = built.level === 'off' && !built.canDisable ? '（该渠道关不掉思考，实际仍会推理）' : '';
    return built.label + ' · 思考强度=' + built.level + ' · ' + sent + ' · ' + flag + compose;
  }

  return {
    LEVELS: LEVELS,
    LEVEL_LABEL: LEVEL_LABEL,
    PROVIDERS: PROVIDERS,
    normalizeLevel: normalizeLevel,
    detectProvider: detectProvider,
    isVerified: isVerified,
    buildThinkingParams: buildThinkingParams,
    describe: describe
  };
});
