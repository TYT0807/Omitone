/**
 * 提示词 token 基准测试。
 *
 * 对比 1.0.10 的内联提示词（baseline，逐字复制自旧版 content.js）与 libs/prompt.js
 * （current）在同一个模拟考卷上的 token 用量，并给出每种题型的单题成本。
 *
 * 运行：
 *   node tools/prompt-bench.js
 *
 * 若装了真实分词器（gpt-tokenizer，见 tools/README.md），会使用它精确计数；
 * 否则退化为启发式估算并明确标注，避免把估算值当实测值。
 */
'use strict';

var path = require('path');
var prompt = require(path.join(__dirname, '..', 'libs', 'prompt.js'));

// ---------------------------------------------------------------------------
// 分词器：优先真实分词器，缺失时启发式估算
// ---------------------------------------------------------------------------
var tokenizer = null;
try {
  tokenizer = require('gpt-tokenizer');
} catch (e) {
  // 未安装依赖时退化为估算。安装方式见 tools/README.md
  try {
    tokenizer = require(path.join(process.env.OMITONE_TOKENIZER_DIR || '', 'gpt-tokenizer'));
  } catch (e2) {
    tokenizer = null;
  }
}

function countTokens(text) {
  if (tokenizer) return tokenizer.encode(String(text)).length;
  // 启发式：CJK 约 1 字 1 token；ASCII 约 4 字符 1 token（含空格）
  var cjk = 0;
  var ascii = 0;
  for (var i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x2e80) cjk++; else ascii++;
  }
  return Math.ceil(cjk + ascii / 4);
}

var EXACT = !!tokenizer;
var LABEL = EXACT ? '实测 (gpt-tokenizer, o200k)' : '估算 (启发式，非精确值)';

// ---------------------------------------------------------------------------
// 模拟考卷：题型分布与题干长度贴近学习通章节测验
// ---------------------------------------------------------------------------
var EXAM = [
  {
    type: 'single',
    title: '中国特色社会主义最本质的特征是什么？',
    options: ['中国共产党的领导', '共同富裕', '人民当家作主', '依法治国'],
    previousWrongAnswers: []
  },
  {
    type: 'single',
    title: '下列关于计算机网络的描述中，正确的是：',
    options: [
      '局域网的地理范围通常大于广域网',
      'IP 地址用于唯一标识接入网络的设备',
      'TCP 协议是无连接的传输层协议',
      'HTTP 协议工作在传输层'
    ],
    previousWrongAnswers: ['A']
  },
  {
    type: 'multiple',
    title: '以下属于操作系统核心功能的有：',
    options: ['进程管理', '内存管理', '文件系统管理', '编译源代码', '设备管理'],
    previousWrongAnswers: []
  },
  {
    type: 'judge',
    title: '在面向对象程序设计中，继承可以提高代码的复用性。',
    options: ['正确', '错误'],
    previousWrongAnswers: []
  },
  {
    type: 'fill',
    title: '马克思主义中国化时代化的第二次历史性飞跃形成了______。',
    options: [],
    previousWrongAnswers: []
  },
  {
    type: 'fill',
    title: '一个完整的 IP 地址由______和______两部分组成。',
    options: [],
    previousWrongAnswers: []
  },
  {
    type: 'short',
    title: '简述数据库事务的 ACID 特性及其含义。',
    options: [],
    previousWrongAnswers: []
  },
  {
    type: 'multiple',
    title: '下列哪些措施有助于提升 Web 应用的页面加载性能？',
    options: ['启用 HTTP 缓存', '资源压缩与合并', '使用 CDN 分发静态资源', '把全部逻辑写在同步阻塞的脚本中'],
    previousWrongAnswers: ['D']
  },
  {
    type: 'judge',
    title: '对称加密算法的加密密钥与解密密钥相同。',
    options: ['正确', '错误'],
    previousWrongAnswers: []
  },
  {
    type: 'single',
    title: '在一段长度为 10 的数组上执行二分查找，最多需要比较多少次？',
    options: ['3 次', '4 次', '5 次', '10 次'],
    previousWrongAnswers: []
  }
];

var CHUNK_SIZE = 10; // 与 content.js 的 CHUNK_SIZE 保持一致

// ---------------------------------------------------------------------------
// baseline：逐字复制自 1.0.10 的 content.js
// ---------------------------------------------------------------------------
function baselineSystemPrompt() {
  return [
    'You are a quiz answering assistant.',
    'Return JSON array only. Do not explain.',
    'Every item must include index, type, and a non-empty answer.',
    'For single choice, answer like "A". For multiple choice, answer like ["A","C"].',
    'For true/false, answer true or false. For fill/short answer, answer text.',
    'For fill questions with multiple blanks, join answers with "|||" or return an array, one answer per blank.'
  ].join('\n');
}

function baselineQuestionsText(questions) {
  return (questions || []).map(function (q, i) {
    var text = 'Question ' + (i + 1) + ' [' + q.type + ']: ' + q.title;
    if (q.options && q.options.length) {
      text += '\nOptions:';
      q.options.forEach(function (opt, j) {
        text += '\n' + String.fromCharCode(65 + j) + '. ' + opt;
      });
    }
    if (q.previousWrongAnswers && q.previousWrongAnswers.length) {
      text += '\nKnown wrong answers, do not repeat: ' + q.previousWrongAnswers.join(', ');
    }
    return text;
  }).join('\n\n');
}

function baselineOutputFormat(questions) {
  return '[\n' + (questions || []).map(function (q, i) {
    if (q.type === 'multiple') return '  {"index": ' + i + ', "type": "multiple", "answer": ["A", "C"]}';
    if (q.type === 'fill') return '  {"index": ' + i + ', "type": "fill", "answer": "blank1|||blank2"}';
    return '  {"index": ' + i + ', "type": "' + q.type + '", "answer": "A"}';
  }).join(',\n') + '\n]';
}

function baselineRequest(chunk) {
  return {
    system: baselineSystemPrompt(),
    user: baselineQuestionsText(chunk) + '\n\nReturn format:\n' + baselineOutputFormat(chunk)
  };
}

// ---------------------------------------------------------------------------
// v1：1.0.11 首版（对象式输出 {"i":0,"a":"A"}）
// 保留它是为了让"每一代各省了多少"有可复算的数字，而不是凭记忆。
// ---------------------------------------------------------------------------
function v1SystemPrompt() {
  return [
    '答题。只输出JSON数组,与题目等长同序,不解释不思考。',
    's"A" m["A","C"] j true|false f/t"文本"(多空用|||按序连)',
    'answer非空;"禁:"为已错答案,禁止重复,不确定也给最可能答案。'
  ].join('\n');
}

function v1Request(chunk) {
  return {
    system: v1SystemPrompt(),
    user: prompt.buildQuestionsText(chunk) +
      '\n\n输出格式：[{"i":0,"a":"A"},{"i":1,"a":["A","C"]},{"i":2,"a":true},{"i":3,"a":"填空1|||填空2"}]'
  };
}

// ---------------------------------------------------------------------------
// current（v2）：libs/prompt.js 的当前版本（位置式输出）
// ---------------------------------------------------------------------------
function currentRequest(chunk) {
  return {
    system: prompt.buildSystemPrompt({}),
    user: prompt.buildUserPrompt(chunk)
  };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
function chunkify(list, size) {
  var out = [];
  for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function measure(request) {
  var system = countTokens(request.system);
  var user = countTokens(request.user);
  return { system: system, user: user, total: system + user };
}

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = ' ' + text;
  return text;
}

function pct(a, b) {
  if (!b) return 'n/a';
  return (((a - b) / b) * 100).toFixed(1) + '%';
}

/** 节省比例（正数表示 current 比 baseline 更省）。 */
function saved(current, baseline) {
  if (!baseline) return 'n/a';
  return (((baseline - current) / baseline) * 100).toFixed(1) + '%';
}

function main() {
  console.log('');
  console.log('Omitone 提示词 token 基准');
  console.log('计数方式: ' + LABEL);
  console.log('题量: ' + EXAM.length + ' 题 / 分批大小 ' + CHUNK_SIZE + ' 题 (' + Math.ceil(EXAM.length / CHUNK_SIZE) + ' 批)');
  console.log('');

  // 单批明细
  var first = EXAM.slice(0, CHUNK_SIZE);
  var baseOne = measure(baselineRequest(first));
  var v1One = measure(v1Request(first));
  var currOne = measure(currentRequest(first));

  console.log('== 第一批（' + CHUNK_SIZE + ' 题）单次请求 ==');
  console.log('                    system   user   合计');
  console.log('  baseline(1.0.10)  ' + pad(baseOne.system, 8) + pad(baseOne.user, 8) + pad(baseOne.total, 7));
  console.log('  v1(1.0.11 首版)   ' + pad(v1One.system, 8) + pad(v1One.user, 8) + pad(v1One.total, 7));
  console.log('  v2(current)       ' + pad(currOne.system, 8) + pad(currOne.user, 8) + pad(currOne.total, 7));
  console.log('  v2 相对 baseline 节省 ' + saved(currOne.total, baseOne.total));
  console.log('  v2 相对 v1       节省 ' + saved(currOne.total, v1One.total));
  console.log('');

  // 整卷汇总
  var chunks = chunkify(EXAM, CHUNK_SIZE);
  var baseTotal = 0;
  var v1Total = 0;
  var currTotal = 0;
  chunks.forEach(function (chunk) {
    baseTotal += measure(baselineRequest(chunk)).total;
    v1Total += measure(v1Request(chunk)).total;
    currTotal += measure(currentRequest(chunk)).total;
  });

  console.log('== 整卷（' + chunks.length + ' 批，system 每批重复）==');
  console.log('  baseline  输入合计 ' + baseTotal + ' tokens');
  console.log('  v1        输入合计 ' + v1Total + ' tokens');
  console.log('  v2        输入合计 ' + currTotal + ' tokens');
  console.log('  v2 相对 baseline 省 ' + (baseTotal - currTotal) + ' tokens (' + saved(currTotal, baseTotal) + ')');
  console.log('  v2 相对 v1       省 ' + (v1Total - currTotal) + ' tokens (' + saved(currTotal, v1Total) + ')');
  console.log('');

  // ---- 40 题整卷：三代**真实配置**对比
  //
  // 这一步才是最终用户能感知的数字：1.0.10 与 v1 都是每批 5 题，v2 是每批 10 题。
  // 输入侧 system/格式示例每批重发，输出侧三代写法不同，两者都要算进去。
  // 只比"单次请求"会漏掉分批带来的固定开销差异。
  console.log('== 40 题整卷：三代真实配置对比（输入 + 输出）==');

  var bigExam = EXAM.concat(EXAM, EXAM, EXAM);

  function outputText(list, gen) {
    return list.map(gen).join('\n');
  }

  function baselineOut(list) {
    return outputText(list, function (q, i) {
      if (q.type === 'multiple') return '{"index": ' + i + ', "type": "multiple", "answer": ["A", "C"]}';
      return '{"index": ' + i + ', "type": "' + q.type + '", "answer": "A"}';
    });
  }
  function v1Out(list) {
    return outputText(list, function (q, i) {
      if (q.type === 'multiple') return '{"i":' + i + ',"a":["A","C"]}';
      return '{"i":' + i + ',"a":"A"}';
    });
  }
  function v2Out(list) {
    return outputText(list, function (q) {
      if (q.type === 'multiple') return '["A","C"]';
      if (q.type === 'judge') return 'true';
      if (q.type === 'fill') return '"填空甲|||填空乙"';
      if (q.type === 'short') return '"简答文本"';
      return '"A"';
    });
  }

  var configs = [
    { label: '1.0.10  baseline @5题/批', chunk: 5, req: baselineRequest, out: baselineOut },
    { label: '1.0.11  v1       @5题/批', chunk: 5, req: v1Request, out: v1Out },
    { label: '1.0.11  v2       @10题/批', chunk: 10, req: currentRequest, out: v2Out }
  ];

  var firstTotals = null;
  console.log('  配置                          批数    输入    输出    合计');
  configs.forEach(function (cfg) {
    var cs = chunkify(bigExam, cfg.chunk);
    var input = 0;
    cs.forEach(function (c) { input += measure(cfg.req(c)).total; });
    var output = countTokens(cfg.out(bigExam));
    var total = input + output;
    if (!firstTotals) firstTotals = total;
    console.log('  ' + cfg.label + '   ' + pad(cs.length, 4) + pad(input, 8) + pad(output, 8) + pad(total, 8) +
      '   ' + (total === firstTotals ? '' : '省 ' + saved(total, firstTotals)));
  });
  console.log('');


  // 输出侧：三代各写一遍同样 10 题
  var baseOut = countTokens(EXAM.map(function (q, i) {
    if (q.type === 'multiple') return '{"index": ' + i + ', "type": "multiple", "answer": ["A", "C"]}';
    return '{"index": ' + i + ', "type": "' + q.type + '", "answer": "A"}';
  }).join('\n'));
  var v1Out = countTokens(EXAM.map(function (q, i) {
    if (q.type === 'multiple') return '{"i":' + i + ',"a":["A","C"]}';
    return '{"i":' + i + ',"a":"A"}';
  }).join('\n'));
  var currOut = countTokens(EXAM.map(function (q) {
    if (q.type === 'multiple') return '["A","C"]';
    if (q.type === 'judge') return 'true';
    if (q.type === 'fill') return '"填空甲|||填空乙"';
    if (q.type === 'short') return '"简答文本"';
    return '"A"';
  }).join('\n'));

  console.log('== 输出侧（' + EXAM.length + ' 题）==');
  console.log('  baseline ' + baseOut + ' tokens  → current ' + currOut + ' tokens  (节省 ' + saved(currOut, baseOut) + ')');
  console.log('');

  // 分批总数不变的情况下，等价于每卷省下的总输入
  var perQuestionBase = baseTotal / EXAM.length;
  var perQuestionCurr = currTotal / EXAM.length;
  console.log('== 单题均摊（输入）==');
  console.log('  baseline ' + perQuestionBase.toFixed(1) + ' tokens/题  → current ' + perQuestionCurr.toFixed(1) + ' tokens/题');
  console.log('');

  // ---------------------------------------------------------------------------
  // 前缀缓存可命中性（v3 新增，也是本轮最重要的一条）
  //
  // 只看"输入有多短"会得出**完全相反**的结论：提示词压得越短，
  // 跨请求的公共前缀就越短，短到无法被识别成「缓存前缀单元」时，
  // 全部输入都按未命中价计费 —— 输入短了，账单反而涨了。
  //
  // DeepSeek 的命中规则（官方 Context Caching 文档）：
  //   - 缓存单元来源之一是"跨请求被识别出的公共前缀"
  //   - 命中要求请求前缀**完整匹配**某个已持久化的单元
  //   - 因此"同一批题重试"这种场景，第 2 次请求必须是第 1 次的**前缀超集**
  //     （官方 Example 1：A+B → A+B+C 命中 A+B）
  //
  // 所以这里量两件事：
  //   1) 稳定前缀有多长（system + 消息头）—— 它决定所有请求共享的那截能否被缓存
  //   2) 同批重试时前缀能重合多少 —— 它决定重试（最多 20 次交卷）是不是白花钱
  // ---------------------------------------------------------------------------
  function commonPrefixLength(a, b) {
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a.charAt(i) === b.charAt(i)) i++;
    return i;
  }

  /** 命中部分按 1/10 价计费时的"等价输入量"，用于和全未命中对比 */
  function equivalentCost(hit, miss) {
    return hit * 0.1 + miss;
  }

  console.log('== 前缀缓存可命中性 ==');
  var benchBatch = EXAM.slice(0, CHUNK_SIZE);
  var systemTokens = countTokens(currentRequest(benchBatch).system);
  var userHeadTokens = countTokens(prompt.FORMAT_HINT);
  var stablePrefix = systemTokens + userHeadTokens;
  console.log('  稳定前缀（system ' + systemTokens + ' + 消息头 ' + userHeadTokens + '）= ' + stablePrefix + ' tokens');
  console.log('    -> 这一段对所有请求逐字节相同，是"跨请求公共前缀"能否被识别成缓存单元的关键');
  if (stablePrefix < 64) {
    console.log('    ⚠️ 低于 64 token：历史上 1.0.11 的稳定前缀只有约 50 token，' +
      '缓存命中率恒为 0，全部输入按原价计费');
  }

  // 同批重试：第 1 次不带错误标注，第 2 次多出一条 `禁:`（放在末尾，不污染前缀）
  var retryBatch = benchBatch.map(function (q, i) {
    if (i !== 0) return q;
    return Object.assign({}, q, { previousWrongAnswers: ['A', 'C'] });
  });
  var reqFirst = currentRequest(benchBatch);
  var reqRetry = currentRequest(retryBatch);

  var firstInput = reqFirst.system + reqFirst.user;
  var retryInput = reqRetry.system + reqRetry.user;
  var overlapChars = commonPrefixLength(firstInput, retryInput);
  // 命中的 token 就是"重试输入里与首次输入完全一致的那段前缀"
  var hitTokens = countTokens(retryInput.slice(0, overlapChars));
  var retryTotal = countTokens(retryInput);
  var missTokens = retryTotal - hitTokens;
  var retryHitRate = retryTotal ? Math.round(hitTokens / retryTotal * 100) : 0;

  console.log('  同批重试（第 2 次提问）');
  console.log('    输入 ' + retryTotal + ' tokens，前缀完整重合 ' + hitTokens + ' tokens（命中率 ' + retryHitRate + '%）');
  console.log('    等价费用（命中按 1/10 价）= ' + equivalentCost(hitTokens, missTokens).toFixed(1) +
    '，全未命中 = ' + retryTotal +
    '  → 省 ' + saved(equivalentCost(hitTokens, missTokens), retryTotal));
  if (retryHitRate === 0) {
    console.log('    ⚠️ 命中率为 0：说明有"每次都变"的内容跑到了前缀里，' +
      '或者重试时题目被从中间删掉了（前缀会从删除处断掉）');
  }
  console.log('');

  // 断言：压缩不能把信息压掉 —— 题干与选项必须原样出现在新提示词里
  var currentUser = currentRequest(first).user;
  var missing = [];
  first.forEach(function (q) {
    if (currentUser.indexOf(q.title) === -1) missing.push(q.title);
    (q.options || []).forEach(function (opt) {
      if (currentUser.indexOf(opt) === -1) missing.push(opt);
    });
  });

  // 断言：normalizeItem 同时认得三种形态 —— 位置式 / 新短键 / 旧键名。
  // 第 2 例（位置式数组）是最容易写错的一个：数组的 typeof 是 object，
  // 若被当成 {a:…} 包装对象去解析，多选题答案会被整条丢掉。
  var cases = [
    { input: 'A', expect: { index: null, answer: 'A' }, label: '位置式标量 "A"' },
    { input: ['A', 'C'], expect: { index: null, answer: ['A', 'C'] }, label: '位置式数组 ["A","C"]（多选）' },
    { input: true, expect: { index: null, answer: true }, label: '位置式布尔 true（判断）' },
    { input: '填空甲|||填空乙', expect: { index: null, answer: '填空甲|||填空乙' }, label: '位置式多空填空' },
    { input: '', expect: null, label: '空字符串必须丢弃' },
    { input: null, expect: null, label: 'null 必须丢弃' },
    { input: [], expect: null, label: '空数组必须丢弃' },
    { input: { i: 2, a: 'A' }, expect: { index: 2, answer: 'A' }, label: '新短键 {i,a}' },
    { input: { a: ['A', 'C'] }, expect: { index: null, answer: ['A', 'C'] }, label: '短键且无 index' },
    { input: { index: 3, type: 'single', answer: 'B' }, expect: { index: 3, answer: 'B' }, label: '旧键名 {index,type,answer}' },
    { input: { i: 'x', a: 'A' }, expect: { index: null, answer: 'A' }, label: '非法 index 归为位置式' },
    { input: { answer: '' }, expect: null, label: '包装式空答案必须丢弃' },
    { input: { answer: null }, expect: null, label: '包装式 null 必须丢弃' }
  ];

  var normalizeFailures = [];
  cases.forEach(function (c) {
    var got = prompt.normalizeItem(c.input);
    var ok;
    if (c.expect === null) {
      ok = got === null;
    } else {
      ok = !!got && got.index === c.expect.index
        && JSON.stringify(got.answer) === JSON.stringify(c.expect.answer);
    }
    if (!ok) normalizeFailures.push(c.label + ' → 实际 ' + JSON.stringify(got));
  });

  console.log('== 自检 ==');
  console.log('  题干/选项完整保留: ' + (missing.length ? '失败 → ' + missing.join(' | ') : '通过'));
  console.log('  normalizeItem 兼容性: ' + (normalizeFailures.length ? '失败 → ' + normalizeFailures.join(' | ') : '通过 (' + cases.length + ' 例)'));
  console.log('');

  if (missing.length || normalizeFailures.length) {
    process.exitCode = 1;
  }
}

main();
