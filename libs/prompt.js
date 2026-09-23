/**
 * Omitone prompt builder — 发给 LLM 的全部文本的唯一真源。
 *
 * 该文件同时运行在两个环境，刻意不依赖任何宿主 API：
 *   1. content script 隔离世界 —— 挂到 `self.OmitonePrompt`（manifest 里排在 content.js 之前）
 *   2. Node —— 走 `module.exports`，供 tools/prompt-bench.js 量化 token 用量
 *
 * 修改提示词只改这里。content.js / page.js 都不应再内联任何提示词字面量。
 *
 * ---------------------------------------------------------------------------
 * 省 token 的历代改动（相对 1.0.10 的旧实现，实测值见 tools/prompt-bench.js）
 *
 * v1（1.0.11 首版）
 *   1) 用「一行图例」代替逐题 JSON 示例。旧实现每次请求都按题目数量生成样板行
 *      （`{"index": 0, "type": "single", "answer": "A"}`），在分批策略下
 *      随批次数线性重复，且几乎不携带信息。
 *   2) 题目用 `序号|题型代号|题干` 代替 `Question 1 [single]: …` + `Options:`。
 *      题型代号是单字符，含义由 system 里的图例给出，只在单次请求内有效。
 *   3) 答案对象用短键 `{"i":0,"a":"A"}`，且**不回传 type** ——
 *      page.js 的 `_fillAnswers` 在 type 缺失时回退 `question.type`（DOM 实测结果，
 *      比模型自报更可靠），所以 type 是冗余字段。
 *
 * v2
 *   4) **输出改成纯位置式数组**：`["A",["A","C"],true,"x|||y"]`，连 `i`/`a` 键名都省掉。
 *      答案与题目按位置一一对应 —— 这本来就是 content.js 在 index 缺失时的兜底行为，
 *      现在把它提升为唯一协议。每题输出约 11 token → 约 5 token，
 *      示例本身也短了一半。
 *
 * v3（本次）—— 为**前缀缓存命中**重排结构
 *
 *   ⚠️ 背景（踩过的坑，别再犯）：把提示词压到极短**会反向增加开销**。
 *   DeepSeek 的上下文缓存不是按"固定长度"命中的，而是要求请求前缀**完整匹配**
 *   某个已持久化的「缓存前缀单元」；单元来源之一是**跨请求被识别出的公共前缀**
 *   （官方 Example 2：同一 system + 变动 user，要等到第二次请求之后才把这个
 *   公共前缀持久化成单元，第三次才命中）。
 *
 *   v2 时代我们只有 3 行 system（约 50 token）是稳定的，且 user 的第一行就是
 *   随时在变的题目 —— 公共前缀既短又不干净，**永远持久化不了，命中率恒为 0**。
 *   省下的那点提示词，换来的是全部输入按未命中价计费。
 *
 *   所以 v3 把 user 消息固定成三段，**稳定在前、易变在后**：
 *
 *     [稳定头]   FORMAT_HINT —— 所有请求逐字节相同
 *     [题目块]   题号|题型|题干 + 选项 —— 同一批题内逐字节相同
 *     [易变尾]   禁:…… —— 只有这里随"上次答错了什么"变化
 *
 *   于是同一批题被重复提问时（交卷判错后的重试最多 20 次），第 2 次起的请求
 *   前缀**完整覆盖**第 1 次的整个输入 → 直接命中，命中部分按约 1/10 价计费。
 *   这也意味着**重试时不要把题目从中间删掉**（删了前缀就从删除处断掉）——
 *   page.js 因此改为整批重发，见那里的注释。
 *
 * ---------------------------------------------------------------------------
 * v3.1（结构未动，只记录实测）—— 现场命中率**仍然是 0**
 *
 * 用户实测（DeepSeek V4 Flash）：`prompt_cache_hit_tokens` 基本恒为 0。
 * 当前稳定前缀 = system 70 + 消息头 14 = **84 tokens**（写这段时是 70；
 * 后来为修「多选题只给一个答案」加了「多选给全部正确项」，system 变成 78 ——
 * 以 `npm run bench` 的输出为准，别照抄这里的数字），已经高于
 * `tools/prompt-bench.js` 里那条 64 token 的经验阈值，**但现场就是不命中** ——
 * 说明 64 这个数字不可信，或者"公共前缀落盘"对短前缀压根不生效。
 * bench 里那条判据只能当参考，**不能当保证**。
 *
 * ⚠️ 所以**不要**为了"凑够长度"去加长稳定前缀。算过账（每请求，10 题一批）：
 *
 *   现状（84，不命中）                   = 477
 *   加长到 256 且**真的命中**（按 1/10 价）= 418.6  → 省 12%
 *   加长到 256 但**依然不命中**            = 649    → **多花 36%**
 *
 * 也就是"赢 12%、输 36%"的赌注（输面是赢面的 2.9 倍），而且赢面没有任何证据：
 * 前缀够不够长、会不会被识别成单元，本地都无法验证，只能花用户的钱去试。
 * 按总账单口径（输出价是输入的 4 倍）算，命中稳定前缀的上限也只是**约 8%**。
 * 1.0.11 已经在这个方向上栽过一次（压短 → 命中恒为 0 → 全价计费）。
 *
 * 结论：**结构不动**。真正能命中的场景只有"同一批题重试"（前缀是首次的超集），
 * bench 已测到 99%，那是当前设计唯一可靠的收益来源。
 * 想再省，方向是**减少请求数**，不是拉长前缀 —— 但批量变大要撞超时与
 * `max_tokens` 截断，权衡见 content.js 里 CHUNK_SIZE 的注释。
 *
 * 兼容性：`normalizeItem` 同时接受三种形态，任何一种都能被正确解析：
 *   - 位置式：`"A"` / `["A","C"]` / `true` / `"填空甲|||填空乙"`
 *   - 新短键：`{"i":0,"a":"A"}`
 *   - 旧键名：`{"index":0,"type":"single","answer":"A"}`
 * 所以用户自定义 systemPrompt、或模型自作主张换格式，都不会导致解析失败。
 *
 * ⚠️ 数组（多选题答案）在 `normalizeItem` 里必须归到"位置式"那一类。
 * 它看起来是 object，但绝不能被当成 `{a:…}` 包装对象解析，否则多选答案会被整条丢掉。
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitonePrompt = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 题型 → 单字符代号。
   * 注意 fill 与 short 的代号必须不同：page.js 里 `fill` 走 `_fillText`（input），
   * `short` 走 `_fillTextarea`（textarea / 富文本），两者不能合并。
   */
  var TYPE_CODE = {
    single: 's',
    multiple: 'm',
    judge: 'j',
    fill: 'f',
    short: 't'
  };

  /** 与 TYPE_CODE 反向对应，仅用于日志与排错展示。 */
  var CODE_TYPE = {
    s: 'single',
    m: 'multiple',
    j: 'judge',
    f: 'fill',
    t: 'short'
  };

  /**
   * system 提示词。三行各司其职：
   * 第 1 行锁定输出形状（数组、等长、同序）并压制推理模型的思考前缀；
   * 第 2 行是题型代号图例，同时给出每类答案的形态；
   * 第 3 行是"绝不允许空答案"与"不得重复历史错误答案"的硬约束。
   *
   * 刻意写得极短：这段文本在分批策略下每批都会重发一次。
   * 用 `=` 代替"等于"、去掉"answer"这类可由上下文推出的词 —— 实测省 token
   * 而模型理解没有下降（自检见 tools/prompt-bench.js）。
   */
  var SYSTEM = [
    '答题。只输出JSON数组,长度=题目数,顺序一致,不解释不思考。',
    // ⚠️ 「多选给全部正确项」这半句不能省。原先只给格式样例 m["A","C"]，
    // 而下面还写着「不确定也给最可能答案」—— 于是模型对**两个**答案的多选题
    // 常常只给一个（现场实测：真答案是两项，模型只回 "A"）。
    // 本地补选（_expandMultiChoiceLetters）只能靠猜第二个字母，猜错就反复重交。
    's"A" m["A","C"] j true|false f/t"文本"(多空用|||按序连;多选给全部正确项)',
    '"禁:"后的题号是已错答案,禁重复;不确定也给最可能答案。'
  ].join('\n');

  /**
   * 输出格式示例 —— **位置式数组**：第 n 个元素就是第 n 题的答案，
   * 没有 index、没有键名。
   *
   * 两个要点：
   *   1) 示例长度固定 4，不随题目数变化。否则每次请求都要重新生成，
   *      长卷还会把这段样板撑得很大。
   *   2) 位置对齐本来就是 content.js 在 index 缺失时的兜底行为，
   *      这里只是把它提升成唯一协议 —— 每题输出从约 11 token 降到约 5 token。
   *
   * 若模型返回的长度与题目数不符，content.js 会按位置尽力对齐并记一条 warn 日志：
   * 没对上的题保持未填 → page.js 判定"未填写"因而不会提交 → 下一轮 tick 重试。
   */
  var FORMAT_HINT = '输出:["A",["A","C"],true,"填空1|||填空2"]';

  /** 题目标注里使用的"历史错误答案"前缀，短且不会出现在正常题干中。 */
  var BANNED_PREFIX = '禁:';

  function typeCode(type) {
    return TYPE_CODE[type] || TYPE_CODE.single;
  }

  function typeFromCode(code) {
    return CODE_TYPE[String(code || '').toLowerCase()] || '';
  }

  /**
   * 把题目数组渲染成紧凑文本块 —— **只有稳定内容**。
   * 每题形如：
   *   1|s|题干文本
   *   A.选项一
   *   B.选项二
   *
   * 题号从 1 开始（人类可读），但模型返回的 index 从 0 开始 —— 这两者不一致是
   * 有意的：题号只是阅读锚点，index 由 FORMAT_HINT 明确指定为 0 基。
   *
   * ⚠️ 这里**不允许**出现任何随"上次答错了什么"变化的内容（历史上的 `禁:` 就是）。
   * 前缀缓存要求这段文本逐字节相同，插入一个会变的字符就会让命中从那里断掉。
   * 变动的内容一律交给 buildBannedText 放到消息末尾。
   */
  function buildQuestionsText(questions) {
    return (questions || []).map(function (q, i) {
      var question = q || {};
      var text = (i + 1) + '|' + typeCode(question.type) + '|' + String(question.title || '');

      var options = (question.options || []).filter(function (opt) {
        return opt !== null && opt !== undefined && String(opt).trim() !== '';
      });
      if (options.length) {
        text += '\n' + options.map(function (opt, j) {
          return String.fromCharCode(65 + j) + '.' + String(opt);
        }).join('\n');
      }

      return text;
    }).join('\n\n');
  }

  /**
   * 易变尾：历史错误答案，形如
   *   `禁:题号=答案[,答案];题号=答案`
   *
   * 放在消息**最末**是为了让前面 [稳定头 + 题目块] 保持逐字节不变 ——
   * 同一批题重试时，第 2 次请求的前缀就能完整覆盖第 1 次的全部输入，从而命中缓存。
   * 之前把 `禁:` 插在每道题中间，前缀会从第一处错误标注就断掉，等于完全命中不了。
   */
  function buildBannedText(questions) {
    var lines = [];
    (questions || []).forEach(function (q, i) {
      var question = q || {};
      var banned = (question.previousWrongAnswers || []).filter(function (item) {
        return item !== null && item !== undefined && String(item).trim() !== '';
      });
      if (!banned.length) return;
      lines.push((i + 1) + '=' + banned.map(function (item) { return String(item).trim(); }).join(','));
    });
    return lines.length ? BANNED_PREFIX + lines.join(';') : '';
  }

  /**
   * 完整 user 消息：**稳定头 → 题目块 → 易变尾**。
   *
   * 顺序是这个函数唯一重要的事（见文件头 v3 说明）：
   *   - 稳定头 FORMAT_HINT 放最前，于是所有请求共享一个干净的公共前缀，
   *     足以被识别成「缓存前缀单元」；
   *   - 题目块紧随其后，同一批题内不变；
   *   - `禁:` 这种每次都变的东西压在最后，不污染前缀。
   * 空段自动省略，不留下多余空行（空行同样会影响前缀一致性）。
   */
  function buildUserPrompt(questions) {
    return [FORMAT_HINT, buildQuestionsText(questions), buildBannedText(questions)]
      .filter(function (part) { return part; })
      .join('\n\n');
  }

  /** 生效的 system 提示词：用户自定义优先，为空时用内置压缩版。 */
  function buildSystemPrompt(config) {
    var custom = config && config.systemPrompt ? String(config.systemPrompt).trim() : '';
    return custom || SYSTEM;
  }

  /** 判断一个值是不是"非空答案"。 */
  function hasAnswer(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) {
      return value.some(function (item) {
        return item !== null && item !== undefined && String(item).trim() !== '';
      });
    }
    // 布尔（判断题）与数字一律算有效答案
    return true;
  }

  /**
   * 把模型返回的单个元素规范成 `{ index, answer }`。
   * `index` 为 null 表示"按位置对齐"（位置式输出的正常情况）。
   * 返回 null 表示该元素没有可用答案，调用方应丢弃。
   */
  function normalizeItem(item) {
    if (item === null || item === undefined) return null;

    // 位置式：元素本身就是答案。
    // ⚠️ 数组（多选题的答案）必须归到这一类 —— 它看起来是 object，
    // 但绝不能被当成 `{a:…}` 包装对象去解析，否则多选答案会被整条丢掉。
    if (typeof item !== 'object' || Array.isArray(item)) {
      return hasAnswer(item) ? { index: null, answer: item } : null;
    }

    // 包装式：新短键 i/a，或旧键名 index/answer/type。两套都认，保证向后兼容。
    var answer = item.a !== undefined ? item.a : item.answer;
    if (answer === undefined) answer = item.text;
    if (!hasAnswer(answer)) return null;

    var rawIndex = item.i !== undefined ? item.i : item.index;
    // ⚠️ **别直接 `Number(rawIndex)`**：`Number(null)` 是 0、`Number('')` 也是 0，
    // 于是模型显式回了 `"i": null`（表示"没给序号、按位置对齐"）时会被当成 **index = 0** ——
    // 那条答案被硬塞给第 0 题，真正该拿它的那一题落空，
    // 然后白跑一轮"空答案补问"（多花一次请求的 token）。
    // 这里先把"空值"挡掉，让它按本函数开头声明的语义落到 `index: null`（按位置对齐）。
    var index = (rawIndex === null || rawIndex === undefined || rawIndex === '')
      ? NaN
      : Number(rawIndex);
    return {
      index: Number.isFinite(index) && index >= 0 ? index : null,
      answer: answer
    };
  }

  return {
    SYSTEM: SYSTEM,
    FORMAT_HINT: FORMAT_HINT,
    BANNED_PREFIX: BANNED_PREFIX,
    TYPE_CODE: TYPE_CODE,
    CODE_TYPE: CODE_TYPE,
    typeCode: typeCode,
    typeFromCode: typeFromCode,
    buildQuestionsText: buildQuestionsText,
    buildBannedText: buildBannedText,
    buildUserPrompt: buildUserPrompt,
    buildSystemPrompt: buildSystemPrompt,
    normalizeItem: normalizeItem
  };
});
