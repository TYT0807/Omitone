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
 * v2（本次）
 *   4) **输出改成纯位置式数组**：`["A",["A","C"],true,"x|||y"]`，连 `i`/`a` 键名都省掉。
 *      答案与题目按位置一一对应 —— 这本来就是 content.js 在 index 缺失时的兜底行为，
 *      现在把它提升为唯一协议。每题输出约 11 token → 约 5 token，
 *      示例本身也短了一半。
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
    's"A" m["A","C"] j true|false f/t"文本"(多空用|||按序连)',
    '"禁:"=已错答案,禁重复;不确定也给最可能答案。'
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
   * 把题目数组渲染成紧凑文本块。
   * 每题形如：
   *   1|s|题干文本
   *   A.选项一
   *   B.选项二
   *   禁:A,C
   *
   * 题号从 1 开始（人类可读），但模型返回的 index 从 0 开始 —— 这两者不一致是
   * 有意的：题号只是阅读锚点，index 由 FORMAT_HINT 明确指定为 0 基。
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

      var banned = (question.previousWrongAnswers || []).filter(function (item) {
        return item !== null && item !== undefined && String(item).trim() !== '';
      });
      if (banned.length) {
        text += '\n' + BANNED_PREFIX + banned.join(',');
      }

      return text;
    }).join('\n\n');
  }

  /** 完整 user 消息：题目块 + 一行输出格式示例。 */
  function buildUserPrompt(questions) {
    var body = buildQuestionsText(questions);
    return body ? body + '\n\n' + FORMAT_HINT : FORMAT_HINT;
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
    var index = Number(rawIndex);
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
    buildUserPrompt: buildUserPrompt,
    buildSystemPrompt: buildSystemPrompt,
    normalizeItem: normalizeItem
  };
});
