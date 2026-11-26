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
 *   固定档里**只有 `off` 是实测过的** —— DeepSeek 关思考，也就是本项目一直以来的行为。
 *   `low` / `high` 的参数是照各家官方文档写的，**没有在真实题库上验证过**。
 *   UI 上必须显示"未验证"。Kimi K3 是**恒思考**模型（关不掉），
 *   选 `off` 时不会报错，但也不会真的关闭 —— 这一点在 `describe()` 里说清楚。
 *
 * 2026-11-19 改成「上下限 + 模型自选」（批次 123-b）：
 *   用户不再选"这一档是多少"，而是按**三个场景**（刷课 / 测试 / 考试）各给一段
 *   **允许的区间** `min-max`。插件只做两件事：钉住区间（省钱的那一半是**上限**）、
 *   以及把区间翻成各家接口**能表达上限的那几个字段**。
 *   - `min === max` 时与改造前逐字节等价（发固定档参数）—— 默认全档都是 `off-off`，
 *     所以老用户升级后**一个请求都不该变**，这是"能接受用不了、不能接受用了钱也用不了"
 *     这条要求落进代码的地方。
 *   - `min < max` 时进入 auto：**不再指定强度**，只保证"至少开到 min、尽量不超过 max"，
 *     中间由模型自己挑。认不出的渠道在 auto 下一律**不发参数**（发错字段是 400，
 *     比少一个参数贵得多）。
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

  /** 三个场景（界面上的三个按钮），顺序即 UI 顺序。 */
  var TIERS = ['course', 'quiz', 'exam'];

  var TIER_LABEL = {
    course: '刷课',
    quiz: '测试',
    exam: '考试'
  };

  /** 每个场景一个配置键，值是 `'min-max'` 那一族字符串（如 `off-off`、`off-high`）。 */
  var TIER_RANGE_KEYS = {
    course: 'thinkingRangeCourse',
    quiz: 'thinkingRangeQuiz',
    exam: 'thinkingRangeExam'
  };

  /** 越靠前越省 —— 用来判"这段区间是不是真的给了模型余地"。 */
  var LEVEL_RANK = { off: 0, low: 1, high: 2 };

  function levelRank(level) {
    return LEVEL_RANK[normalizeLevel(level)];
  }

  /**
   * 解析区间字符串。认不出来**不猜**：返回 `ok:false`，由调用方落到最省那格。
   *
   * 接受的形状：`off-high` / `low-low` / 单个档位 `high`（= `high-high`，
   * 手改存储或老数据只有单值时不至于整个失效）。
   */
  function parseRange(value) {
    var raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return { ok: false, min: 'off', max: 'off' };
    var parts = raw.split('-');
    if (parts.length === 1) {
      if (LEVELS.indexOf(parts[0]) === -1) return { ok: false, min: 'off', max: 'off' };
      return { ok: true, min: parts[0], max: parts[0] };
    }
    if (parts.length !== 2) return { ok: false, min: 'off', max: 'off' };
    if (LEVELS.indexOf(parts[0]) === -1 || LEVELS.indexOf(parts[1]) === -1) {
      return { ok: false, min: 'off', max: 'off' };
    }
    // 顺序反了（`high-off`）不报错也不解释成别的：按省→贵重排，
    // 因为界面永远从小到大写，反了只能是手改存储，重排是唯一不会多花钱的读法。
    return {
      ok: true,
      min: LEVELS[Math.min(levelRank(parts[0]), levelRank(parts[1]))],
      max: LEVELS[Math.max(levelRank(parts[0]), levelRank(parts[1]))]
    };
  }

  function rangeText(range) {
    return range.min + '-' + range.max;
  }

  /**
   * 这次请求属于哪个场景。
   *
   * `kind === 'paper'`（整卷）再看页面递过来的 `paperKind`：
   * 标题含「考试」或「作业」算 exam，其余整卷（章节测验/测试）算 quiz。
   * 其它一切（弹题、验证码、讨论、老调用方不传 opts）算刷课 ——
   * 刷课是量，答错可重试，最省的一档就该落在这里。
   */
  function resolveTier(kind, paperKind) {
    if (String(kind || '') !== 'paper') return 'course';
    return String(paperKind || '') === 'exam' ? 'exam' : 'quiz';
  }

  /**
   * 改造前的两个键（全局档 + 整卷档）推出现在三个场景的区间。
   *
   * 为什么要留这一支：老用户存储里**只有**那两个键。若"新键缺失就当 off-off"，
   * 把全局档调到"高"的用户升级后思考会**悄悄关掉** —— 症状是"答案变差了但没报错"，
   * 最难查的那类回归。这里推出来的区间上下限相等，所以后续走的是**固定档**那一条，
   * 与改造前逐字节等价。
   */
  function legacyRange(config, tier) {
    var cfg = config || {};
    var global = normalizeLevel(cfg.thinkingLevel);
    if (tier === 'course') return { min: global, max: global };
    var paper = String(cfg.thinkingPaperLevel == null ? '' : cfg.thinkingPaperLevel).trim().toLowerCase();
    var level = LEVELS.indexOf(paper) === -1 ? global : paper;
    return { min: level, max: level };
  }

  /**
   * 这个场景这次该用哪段区间。三级来源，按优先级：
   *   ① `thinkingRange` —— content.js 在**单次请求**里临时挂上的覆盖键，不落盘、不投影；
   *   ② 该场景的键（`thinkingRangeCourse` 等）；写成无法解析的形状 → 落最省的 `off-off`
   *      （认不出来就少花钱，不许拿别的档猜）；
   *   ③ 键缺失或为空串 → 由老键推导。
   */
  function rangeForTier(config, tier) {
    var cfg = config || {};
    var override = String(cfg.thinkingRange == null ? '' : cfg.thinkingRange).trim();
    if (override) {
      var parsedOverride = parseRange(override);
      return parsedOverride.ok
        ? { min: parsedOverride.min, max: parsedOverride.max, ok: true, source: 'override' }
        : { min: 'off', max: 'off', ok: false, source: 'override' };
    }
    var key = TIER_RANGE_KEYS[tier] || TIER_RANGE_KEYS.course;
    var stored = String(cfg[key] == null ? '' : cfg[key]).trim();
    if (stored) {
      var parsed = parseRange(stored);
      return parsed.ok
        ? { min: parsed.min, max: parsed.max, ok: true, source: key }
        : { min: 'off', max: 'off', ok: false, source: key };
    }
    var legacy = legacyRange(cfg, tier);
    return { min: legacy.min, max: legacy.max, ok: true, source: 'legacy' };
  }

  /** 区间是否真的留了余地给模型（上下限不等）。 */
  function isAutoRange(range) {
    return levelRank(range.max) > levelRank(range.min);
  }

  /**
   * 思考档位 → 输出总预算（max_tokens）的**下限**。
   *
   * 为什么要有这张表：OpenAI 兼容协议里思考与答案**共用同一份 max_tokens**，
   * 没有单独的思考额度。low/high 打开思考后，推理先烧掉一大截，
   * 留给答案的不够 → 输出被截断 → 上层拆批重问 → 「强度越高越没用」。
   * off 不抬（= 升级前的行为，一个字节都不变）。
   * 用户自己填过更大的 maxTokens 时取大者，不会被压小。
   */
  var LEVEL_MIN_MAX_TOKENS = { off: 0, low: 12288, high: 16384 };

  function minMaxTokens(level) {
    return LEVEL_MIN_MAX_TOKENS[normalizeLevel(level)] || 0;
  }

  /**
   * 这段区间要给输出预算抬到的**下限**（取上限那一档，只抬不降）。
   *
   * 为什么按上限：auto 时我们不知道模型会选多高，预算必须按**最贵的那一格**备好，
   * 否则模型真想了想就被截断，又回到「越高越没用」。
   * `off-off`（默认）与固定 `off` 一样是 0 —— 不抬，等于升级前的行为。
   */
  function minMaxTokensForRange(range) {
    return minMaxTokens((range || {}).max);
  }

  /**
   * 按任务类型算「这次请求该用哪一档」。
   *
   * kind 'paper'（整卷：章节测验/作业/考试）看 thinkingPaperLevel ——
   * 用户可以给整卷单独设一档，''（默认）表示跟随全局 thinkingLevel；
   * 其他请求（弹题、验证码等）一律跟随全局 —— 弹题是刷课量、答错可重试，
   * 跟着全局默认 off 最省。档位认不出来就落 off（与 normalizeLevel 同一口径）。
   */
  function effectiveLevel(config, kind) {
    var cfg = config || {};
    if (String(kind || '') === 'paper') {
      var paper = String(cfg.thinkingPaperLevel == null ? '' : cfg.thinkingPaperLevel).trim().toLowerCase();
      if (LEVELS.indexOf(paper) !== -1) return paper;
    }
    return normalizeLevel(cfg.thinkingLevel);
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
   * 通义的思考长度（`thinking_budget`）按档位取值。
   * 固定档与 auto 的上限**共用这一张表** —— 两处各写一份迟早会分叉，
   * 而分叉的表现是"放开上限后预算还停在低档"，钱没多花、思考也没多出来。
   */
  var THINKING_BUDGET_BY_LEVEL = { off: 0, low: 1024, high: 16384 };

  /**
   * 渠道表。每项：
   *   label          给 UI 看的名字
   *   verifiedLevels **实测过**的档位数组 —— 没有实测过的一律不许写进来
   *   canDisable     是否真的能关掉思考（Kimi K3 为 false）
   *   params         档位 → 要合并进请求体的字段（固定档用）
   *   auto           区间 → 要合并进请求体的字段（上下限不等时用）；
   *                  **没有"模型自己挑"这个字段的渠道就返回空对象** ——
   *                  少发一个字段只是没帮它省，多发一个错字段是 400。
   *   note           给用户看的说明（UI 直接显示）
   *
   * ⚠️ `verifiedLevels` 是**按档**而不是按渠道的：DeepSeek 只有"关闭"档在真实
   *    答题链路上跑过（那是本项目一直以来的行为），"低/高"只是照官方文档写的。
   *    把整家标成"已实测"是不诚实的，也会让用户以为低/高不会有兼容问题。
   * ⚠️ 这一张表里有函数，**不许 JSON.stringify 发给别处**（UI 只读 label/note）。
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
      // auto（区间上下限不等）：**去掉 reasoning_effort**，只保证思考是开着的。
      // 发一个下限等于替它定死强度 —— 那正是这次要改掉的毛病。
      // min 为 off 时连 `thinking:enabled` 都不发：V4 出厂默认就是开思考、
      // 强度自己判，"不干预"在这种渠道上恰好就是模型自选。
      auto: function (range) {
        return range.min === 'off' ? {} : { thinking: { type: 'enabled' } };
      },
      note: '唯一实测过的渠道。关闭思考即本项目一直以来的行为。'
    },
    qwen: {
      label: '通义千问（DashScope）',
      verifiedLevels: [],
      canDisable: true,
      // 官方文档（2026-10-22 核对）：开关 enable_thinking: true|false；
      // 思考长度用 **thinking_budget**（1–32768，控制台默认 4000）。
      // ⚠️ `reasoning_effort` 只出现在 Qwen3.8 **Omni** 系列，主模型文档里没有这个字段 ——
      // 往主模型发它属于未知参数，部分网关直接 400，所以这里按文档改用 thinking_budget。
      // 商业版默认关闭思考（开源版默认开启），所以 off 档要显式发 false 才稳。
      params: {
        off: { enable_thinking: false },
        low: { enable_thinking: true, thinking_budget: THINKING_BUDGET_BY_LEVEL.low },
        high: { enable_thinking: true, thinking_budget: THINKING_BUDGET_BY_LEVEL.high }
      },
      // auto：通义没有"强度"字段，但**有**预算字段 —— 区间上限正好是它能量化的含义。
      // 于是这一家把上限钉死、中间由模型自己烧，是四家里最贴近"AI 自选"的。
      auto: function (range) {
        var budget = THINKING_BUDGET_BY_LEVEL[range.max];
        // 认不出上限就不钉预算（宁可不省，也不发一个 0 把思考按死）。
        return budget > 0
          ? { enable_thinking: true, thinking_budget: budget }
          : { enable_thinking: true };
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
      // auto：这一家**恒思考**，"至少想一下"这一半不用发参数就成立；
      // 而"上限"没有确认过的字段可表达，发错就是 400 —— 所以只交回空对象。
      auto: function () {
        return {};
      },
      note: 'K3 是恒思考模型，选"关闭"不会报错但也不会真的关闭；强度参数未验证。'
    },
    unknown: {
      label: '其他 / 自定义',
      verifiedLevels: [],
      canDisable: true,
      // 认不出的渠道：**只在用户显式选了固定低/高时才发**最通用的 OpenAI 风格字段。
      // off（默认）一个参数都不发 —— 这正是升级前的行为，所以不会把任何人搞挂。
      params: {
        off: {},
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'high' }
      },
      // auto：认不出渠道就更不许替它挑字段 —— 空对象是这里唯一安全的写法，
      // 表现成"由服务商自己决定"，而不是"报 400 说这个参数不认识"。
      auto: function () {
        return {};
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
   * `opts`：`{ kind, paperKind }`（content.js 用请求自带的种类）或 `{ tier }`。
   * 不传 opts 时按刷课档 —— 老调用方（验证码、弹窗提示）只带 config 就能继续用。
   *
   * 返回（新增字段都带旧字段，老代码不必一起改）：
   *   provider / label   渠道
   *   tier / tierLabel   这次属于哪个场景（刷课 / 测试 / 考试）
   *   min / max / range  这个场景的区间，以及它从哪来（rangeSource：override|键名|legacy）
   *   auto               区间是否真的留了余地给模型
   *   level              auto 时是 `'auto'`，固定档时是那一档
   *   params             要合并进请求体的字段（可能为空对象）
   *   maxTokensFloor     输出预算要抬到的下限（按区间上限；off-off 是 0 = 不抬）
   *   ceiling            我们**钉出去的**思考预算数字（没钉就是 0）
   *   verified           这一格是否实测过（auto 一律 false —— 没人验过"模型自己挑"）
   *   canDisable / note  渠道说明
   */
  function buildThinkingParams(config, opts) {
    var cfg = config || {};
    var o = opts || {};
    var tier = TIERS.indexOf(o.tier) !== -1
      ? o.tier
      // content 侧会把本次场景挂在临时副本的 thinkingTier 上；describe(effConfig) 只有配置、
      // 没有 opts，不认这一格就会把考试请求的标签误写成「刷课」（批次 228 现场）。
      : (TIERS.indexOf(cfg.thinkingTier) !== -1 ? cfg.thinkingTier : resolveTier(o.kind, o.paperKind));
    var provider = detectProvider(cfg.apiUrl, cfg.model);
    var info = providerInfo(provider);
    var range = rangeForTier(cfg, tier);
    var auto = isAutoRange(range);
    var level = auto ? 'auto' : range.min;
    var modeled = typeof info.auto === 'function';
    var params = auto && modeled
      ? Object.assign({}, info.auto(range))
      // 固定档（含 auto 但这家没有自选写法 —— 退化成"按下限发"，仍然满足"至少想 min"）
      : Object.assign({}, info.params[level === 'auto' ? range.min : level] || {});
    return {
      provider: provider,
      label: info.label,
      tier: tier,
      tierLabel: TIER_LABEL[tier],
      min: range.min,
      max: range.max,
      range: rangeText(range),
      rangeSource: range.source || '',
      rangeOk: range.ok !== false,
      auto: auto,
      autoModeled: auto ? modeled : false,
      level: level,
      params: params,
      maxTokensFloor: minMaxTokensForRange(range),
      ceiling: typeof params.thinking_budget === 'number' ? params.thinking_budget : 0,
      verified: auto ? false : isVerified(provider, range.min),
      canDisable: info.canDisable !== false,
      note: info.note || ''
    };
  }

  /**
   * 回包里"模型自己烧了多少推理 token"的候选路径。
   * 四家字段名各写各的，所以按列表试；命中哪一条要能报出来（不然日志说不清出处）。
   */
  var REASONING_TOKEN_FIELDS = [
    ['completion_tokens_details', 'reasoning_tokens'],
    ['output_tokens_details', 'thinking_tokens'],
    ['completion_tokens_details', 'thinking_tokens'],
    ['reasoning_tokens'],
    ['thinking_tokens'],
    ['thoughtsTokenCount']
  ];

  /**
   * 读推理 token 数。**读不出返回 -1，绝不当成 0** ——
   * 0 是「这一步真没想」，-1 是「这一家的字段我们不认识」，
   * 混成一样会让人把"没记账"读成"没花钱"（AGENTS §2 #2/#12 同一族）。
   */
  function readReasoningTokens(data) {
    var usage = data && typeof data === 'object'
      ? (data.usage || data.usageMetadata || (data.response && data.response.usageMetadata) || null)
      : null;
    if (!usage || typeof usage !== 'object') return { tokens: -1, field: '' };
    for (var i = 0; i < REASONING_TOKEN_FIELDS.length; i++) {
      var path = REASONING_TOKEN_FIELDS[i];
      var node = usage;
      for (var j = 0; j < path.length && node && typeof node === 'object'; j++) node = node[path[j]];
      // 只认数字：字符串形状（"1200"）宁可算读不出，也不要 Number() 把 undefined 变成 NaN 再变成 0
      if (typeof node === 'number' && Number.isFinite(node) && node >= 0) {
        return { tokens: node, field: path.join('.') };
      }
    }
    return { tokens: -1, field: '' };
  }

  /**
   * 把观测到的推理 token 数翻成一句"大致是哪一档"。
   *
   * ⚠️ 尺子是**我们自己的预算表**（低 ≈1024 / 高 ≈16384），不是厂商口径 ——
   * 所以日志与界面都必须带"按我们的预算估"，不许写成"模型自报是低档"。
   */
  function levelFromTokens(tokens) {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return '';
    if (tokens === 0) return 'off';
    if (tokens <= THINKING_BUDGET_BY_LEVEL.low * 4) return 'low';
    return 'high';
  }

  /** 一行人类可读的说明，写日志 / 上 UI 都用它，避免两处措辞分叉。 */
  function describe(config, opts) {
    var built = buildThinkingParams(config, opts);
    var keys = Object.keys(built.params);
    var sent = keys.length ? JSON.stringify(built.params) : '不发参数';
    var flag = built.verified ? '已实测' : '未验证';
    var mode = built.auto
      ? (built.autoModeled ? '[' + built.min + ',' + built.max + '] 交给模型自选'
        : '[' + built.min + ',' + built.max + '] 该渠道没有自选写法，按下限 ' + built.min + ' 发')
      : '固定档 ' + built.min;
    // 只有"用户要求关闭、但这渠道关不掉"时才提示 —— 说反了会让人以为开着思考是异常
    var compose = built.level === 'off' && !built.canDisable ? '（该渠道关不掉思考，实际仍会推理）' : '';
    return built.label + ' · ' + built.tierLabel + '思考=' + mode + ' · ' + sent + ' · ' + flag + compose;
  }

  return {
    LEVELS: LEVELS,
    LEVEL_LABEL: LEVEL_LABEL,
    TIERS: TIERS,
    TIER_LABEL: TIER_LABEL,
    TIER_RANGE_KEYS: TIER_RANGE_KEYS,
    PROVIDERS: PROVIDERS,
    LEVEL_MIN_MAX_TOKENS: LEVEL_MIN_MAX_TOKENS,
    THINKING_BUDGET_BY_LEVEL: THINKING_BUDGET_BY_LEVEL,
    normalizeLevel: normalizeLevel,
    levelRank: levelRank,
    parseRange: parseRange,
    rangeText: rangeText,
    resolveTier: resolveTier,
    legacyRange: legacyRange,
    rangeForTier: rangeForTier,
    isAutoRange: isAutoRange,
    minMaxTokens: minMaxTokens,
    minMaxTokensForRange: minMaxTokensForRange,
    effectiveLevel: effectiveLevel,
    detectProvider: detectProvider,
    isVerified: isVerified,
    buildThinkingParams: buildThinkingParams,
    readReasoningTokens: readReasoningTokens,
    levelFromTokens: levelFromTokens,
    describe: describe
  };
});
