#!/usr/bin/env node
/* audit-course-probe-claims.js —— 核「换课前沿课程首页问一轮」这一族对用户承诺的数字，文档与代码是不是同一个。
 *
 * 为什么要这一条（2026-11-17，批次 97 收尾）：
 *   批次 97 把「卡片上没写进度」那一族候选改成**先在后台挨门读一遍站点自己的课程首页**。
 *   这一族一口气引入九个数字（一轮问几门 · 单页最多等多久 · 整轮预算 · 页面等桥 · 桥等后台 ·
 *   最多为它等几拍 · 这句话多久再说一次 · 答案多久算过期 · 问了没答上多久不重敲），
 *   而用户看得见的那几页（README / 说明书 / Release 说明）只挑其中几个说话。
 *   **数字改了而文档没改，是这一族唯一的失败形状**（AGENTS §4「换课上限」那一条同样的教训：
 *   批次 85 把上限由 8 提到 30，Release 页那一行停了 8 个批次没人发现，判据/日志/沙盒全绿）。
 *   反过来也成立：文档里凭空写一个代码没有的数，会把人引到错方向去理解现场。
 *
 * 判据口径（**故意只做两件事**，放宽就会误报）：
 *   ① 真源只认代码里那九个常量，分别从 `background.js` / `src/page/00-shell-constants.js` /
 *      `content.js` **三个文件**读回来。任何一个读不到 / 认出多处 / 不是正整数一律**抛错**，
 *      绝不返回 0 让闸以为"没东西要核"（§7 那条老教训）。
 *   ② 文档里凡是**带着这一族句式**的句子（`最多为它等 N 秒` / `桥那一头 N 秒` / `页面等桥 N 秒` /
 *      `单页最多 N 秒` / `整轮最多 N 秒` / `最多问 N 门` / `N 分钟内不重问`），N 必须等于 ① 里对应那一个。
 *      句式是**故意做窄**的，有两层原因：
 *      - 本仓库文档里 `20 秒` `8 秒` `12 秒` 这些数字大量出现在解密等待、站点重绘、退避窗口那一族
 *        （`README.md` §6 #382、HANDOVER §202、Release 页 85/143 行），照"扫所有 N 秒"办会一次报出
 *        十几条假红 —— 会误报的守卫和没有守卫一样害人。
 *      - 每一格的**引导词必须互不重叠**。上一版让 `桥…N 秒` 与 `页面…N 秒` 各扫各的，于是
 *        「页面等桥 36 秒」被两格各抓一次，桥那一格把 36 当 34 报红 —— **一份写对了的文档凭空挨假红**，
 *        自证十格里七格因此长红。现在两格各自要求自己的词组紧贴数字（`桥那一头` / `页面等桥`），
 *        窄到彼此咬不住；代价是句式被改写就等于脱审，所以另有一条"每种句式都至少得出现一次"兜着。
 *      - **引导词还不能是"通用中文"**。第二版把族内分开后，真跑文档又挨了两条跨族假红：
 *        `最多等 N 秒` 抓到 README 批次 40 那句「（视频压根没源）这类等待有界：**最多等 120 秒**」，
 *        `单页 N 秒` 抓到 HANDOVER 1.2.2 那句「`_waitSlideAudioDone` **单页上限 600 秒**」——
 *        两个都是**别的家族本来就这么说话**。所以本族的引导词必须带上只有这一族才用的词
 *        （`最多为它等` 的"它"= 这一读；本族写 `单页最多`，媒体那一族写 `单页上限`），
 *        并且把文档里那几处**统一改成这几种说法**，不是把判据改松。
 *   另加三条**卫生检查**：整套文档至少要落在**两个不同文件**上；`最多为它等 N 秒`（对用户唯一那句
 *   "可能要等一会儿"的承诺）**一处都不许缺**；七格句式**每一格都至少出现一次** ——
 *   正则被改坏时扫描会静默变成 0 条命中并打印"通过"，那是最坏的一种绿。
 *
 * 不核什么：
 *   - **`CHANGELOG.md` 不扫**：历史条目写的是**当时**的数，回改会把史实抹掉
 *     （口径同 `tools/audit-switch-budget.js`）。批次 97 那一段就写着"单页 12 秒、整轮 20 秒、桥 34 秒"，
 *     那是史实，不是承诺。
 *   - **`AGENTS.md` 不扫**：那是给 AI/维护者的守则，不是用户看的那几页。
 *   - **换课上限「30 门」不扫**：那是 `_COURSE_SWITCH_LIMIT` 那一族，由 `audit-switch-budget.js` 承重；
 *     本件只认**带「问」字**的那一句（`最多问 N 门`），两把尺各管一头，互不误报。
 *   - **常量之间的嵌套关系不扫**（预算 + 单页 < 桥 < 页面等桥、defer < 页面等桥）：
 *     那条由集成层 `[25]` 的 ⑩ 从同样三个真源读回来比，比在这里更严（它比的是大小关系，不只是相等）。
 *
 * 用法：
 *   node tools/audit-course-probe-claims.js            # 核真文档，有问题退出 1
 *   node tools/audit-course-probe-claims.js --json     # 同上，机器可读
 *   node tools/audit-course-probe-claims.js --selftest # 十三格自证，不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

// 掩码那一手不重写第二遍 —— 直接借批次 94 那一份（围栏代码块 / HTML 注释 / script / style 都挖空，
// 且保持行数与列位不变）。两处各写一份的话，改一处另一处静默过期，正是本件要防的那类事。
var budget = require('./audit-switch-budget.js');
var maskInvisible = budget.maskInvisible;

var ROOT = path.resolve(__dirname, '..');
// 用户看得见的那几页；CHANGELOG / AGENTS 故意不在这里（见头注）
var DOCS = ['README.md', 'HANDOVER.md', 'release-notes-1.3.0.md', 'docs/manual.html'];

var SRC_BG = 'background.js';
var SRC_PAGE = 'src/page/00-shell-constants.js';
var SRC_CONTENT = 'content.js';

// 九个常量 → 对用户说话的哪一格。`ms` 那一族统一换算成秒；`门` / `分钟` 另有单位。
var CONSTANT_SPECS = [
  { key: 'limit', unit: '门', file: SRC_BG, re: /var COURSE_PROBE_LIMIT\s*=\s*(\d+)/ },
  { key: 'bodyMax', unit: '字节', file: SRC_BG, re: /var COURSE_PROBE_BODY_MAX\s*=\s*(\d+)/ },
  { key: 'fetch', unit: '秒', file: SRC_BG, re: /var COURSE_PROBE_FETCH_MS\s*=\s*(\d+)/, div: 1000 },
  { key: 'budget', unit: '秒', file: SRC_BG, re: /var COURSE_PROBE_BUDGET_MS\s*=\s*(\d+)/, div: 1000 },
  { key: 'pending', unit: '秒', file: SRC_PAGE, re: /var COURSE_PROBE_PENDING_MS\s*=\s*(\d+)/, div: 1000 },
  { key: 'ask', unit: '秒', file: SRC_PAGE, re: /var COURSE_PROBE_ASK_MS\s*=\s*(\d+)/, div: 1000 },
  { key: 'defer', unit: '秒', file: SRC_PAGE, re: /var COURSE_PROBE_DEFER_MS\s*=\s*(\d+)/, div: 1000 },
  { key: 'spoke', unit: '秒', file: SRC_PAGE, re: /var COURSE_PROBE_SPOKE_MS\s*=\s*(\d+)/, div: 1000 },
  // FRESH 写成乘积（30 * 60 * 1000），所以要按乘积读，不能只抓第一串数字
  { key: 'fresh', unit: '分钟', file: SRC_PAGE, re: /var COURSE_PROBE_FRESH_MS\s*=\s*(\d+)(?:\s*\*\s*(\d+)\s*\*\s*(\d+))?/, div: 60000 },
  // 桥那一头是个**内联字面量**（`sendRuntimeMessageWithTimeout({ type: 'course_home_probe', … }, 34000, …)`），
  // 没有常量名可指 —— 所以两步读：先定位那一发，再在它的下一步找第一个 `, <数字>,`。
  { key: 'bridge', unit: '秒', file: SRC_CONTENT, inlineAfter: "type: 'course_home_probe'", re: /\}\s*,\s*(\d{3,6})\s*,/, div: 1000 }
];

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** 从三个真源读回九个数字；任何一个读不出来就抛，绝不返回 0 让闸以为"没东西要核"。 */
function constsFromSource(root) {
  var base = root || ROOT;
  var cache = {};
  var out = {};
  var missing = [];
  CONSTANT_SPECS.forEach(function (spec) {
    var p = path.join(base, spec.file);
    if (!fs.existsSync(p)) { missing.push(spec.file); return; }
    if (!(spec.file in cache)) cache[spec.file] = readText(p);
    var text = cache[spec.file];
    var raw;
    if (spec.inlineAfter) {
      // 内联字面量：先在**整个文件**里数锚点，再取锚点后 400 字符里的第一个 `, <数字>,`。
      // 通用那条「全文件数命中」对这一格天生不适用（`, 34000,` 这种形状在 content.js 里有 7 处，
      // 每一发桥都是那个样子），所以这一格判的是**锚点唯一 + 窗口内唯一命中**。
      var anchorHits = text.split(spec.inlineAfter).length - 1;
      var at = anchorHits === 1 ? text.indexOf(spec.inlineAfter) : -1;
      var win = at >= 0 ? text.slice(at, at + 400) : '';
      var im = win.match(new RegExp(spec.re.source));
      if (anchorHits !== 1) {
        throw new Error(spec.key + ' 的真源锚点在 ' + spec.file + ' 里出现 ' + anchorHits +
          ' 次（要正好 1 次）：' + spec.inlineAfter + ' —— 两处以上本闸不知道该信哪一发桥');
      }
      if (!im) {
        throw new Error(spec.key + ' 的真源读不出：' + spec.file + ' 里那一发桥后面找不到 `}, <毫秒>,` 的形状');
      }
      raw = Number(im[1]);
    } else {
      var hits = [];
      var re = new RegExp(spec.re.source, 'g');
      var m;
      while ((m = re.exec(text)) !== null) hits.push(m);
      if (hits.length !== 1) {
        throw new Error(spec.key + ' 的真源读不出：' + spec.file + ' 里 `' + spec.re.source + '` 命中 ' +
          hits.length + ' 次（要正好 1 次）。命中 0 次 = 那一行被改名；命中多次 = 有两处定义，本闸不知道该信谁');
      }
      raw = Number(hits[0][1]);
      if (spec.key === 'fresh' && hits[0][2] && hits[0][3]) {
        raw = Number(hits[0][1]) * Number(hits[0][2]) * Number(hits[0][3]);
      }
    }
    if (spec.key === 'bridge' && !(Number(raw) > 0)) {
      throw new Error('bridge 读出来不是正毫秒数（' + raw + '）');
    }
    if (!(raw > 0)) throw new Error(spec.key + ' 读出来不是正整数（' + raw + '），这一轮不许当"没东西要核"');
    out[spec.key] = spec.div ? Math.round(raw / spec.div) : raw;
    out[spec.key + '__raw'] = raw;
  });
  if (missing.length) throw new Error('探针常量的真源文件没读进来：' + missing.join(' / '));
  return out;
}

// 对用户说话的那几种句式 → 该等于哪一个常量。
// ⚠️ 每一格的**引导词必须互不重叠，而且必须"只有这一族会这么写"** —— 这是这一条闸能不能用的关键。
//    第一版栽在**同一族内部**：`桥…N 秒` 与 `页面…N 秒` 各扫各的，于是「页面等桥 36 秒」被两个句式
//    各抓一次，桥那一格把 36 当 34 报红 —— 一份写对了的文档凭空挨一条假红（会误报的守卫等于没有守卫）。
//    现在两格各自要求自己的词组紧贴在数字前：`桥那一头 …` 归桥、`页面等桥 …` 归页面。
//    第二版栽在**跨族**：`最多等 N 秒` 与 `单页 N 秒` 这两个引导词太普通，别的家族本来就这么说话 ——
//    README「（视频压根没源）这类等待有界：**最多等 120 秒**」（批次 40）、
//    HANDOVER「`_waitSlideAudioDone` **单页上限 600 秒**」（1.2.2 看门狗那一族）各挨一条假红。
//    判据：**引导词得带上只有本族才有的名词或动词**（`最多为它等` 的"它"就是这一读、
//    `单页最多` / `整轮最多` 是这一族的说法，媒体那一族写的是"单页上限"），
//    并且把文档里那几处**统一改成这几种说法**。
//    代价说清楚：**句式被整体改写就等于脱审**，所以下面另有一格「每种句式都至少得出现一次」兜着。
var CLAIM_PATTERNS = [
  { id: 'defer', key: 'defer', unit: '秒', label: '最多为它等 N 秒', re: /最多为它等[^0-9<>\n]{0,8}?([0-9]{1,4})\s*秒/g },
  { id: 'bridge', key: 'bridge', unit: '秒', label: '桥那一头 N 秒', re: /桥那一头[^0-9<>\n]{0,8}?([0-9]{1,4})\s*秒/g },
  { id: 'ask', key: 'ask', unit: '秒', label: '页面等桥 N 秒', re: /页面等桥[^0-9<>\n]{0,8}?([0-9]{1,4})\s*秒/g },
  { id: 'fetch', key: 'fetch', unit: '秒', label: '单页最多 N 秒', re: /单页最多[^0-9<>\n]{0,8}?([0-9]{1,4})\s*秒/g },
  { id: 'budget', key: 'budget', unit: '秒', label: '整轮最多 N 秒', re: /整轮最多[^0-9<>\n]{0,8}?([0-9]{1,4})\s*秒/g },
  { id: 'limit', key: 'limit', unit: '门', label: '最多问 N 门', re: /最多问[^0-9<>\n]{0,8}?([0-9]{1,3})\s*门/g },
  { id: 'fresh', key: 'fresh', unit: '分钟', label: 'N 分钟内不重问', re: /([0-9]{1,3})\s*分钟[^0-9<>\n]{0,8}?不重问/g }
];

/**
 * 对账。
 * @param {Object} opts { docs: {相对路径: 文本}, consts: constsFromSource() 的结果 }
 * @returns {{ ok:boolean, problems:string[], stats:string[], claims:Array, perId:Object }}
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var consts = (opts && opts.consts) || {};
  var problems = [];
  var claims = [];
  var perId = {};
  var keys = Object.keys(CLAIM_PATTERNS);
  var haveAll = keys.every(function (k) {
    var c = consts[CLAIM_PATTERNS[k].key];
    return Number(c) > 0;
  });
  if (!haveAll) {
    problems.push('代码侧的探针常量有读不齐的（' + keys.filter(function (k) {
      return !(Number(consts[CLAIM_PATTERNS[k].key]) > 0);
    }).join(' / ') + '），这一轮没东西可对账');
  }
  var filesWithClaim = {};
  Object.keys(docs).sort().forEach(function (file) {
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      CLAIM_PATTERNS.forEach(function (pat) {
        pat.re.lastIndex = 0;
        var m;
        while ((m = pat.re.exec(lines[i])) !== null) {
          var n = parseInt(m[1], 10);
          claims.push({ file: file, line: i + 1, id: pat.id, text: m[0], value: n });
          perId[pat.id] = (perId[pat.id] || 0) + 1;
          filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
          if (Number(consts[pat.key]) > 0 && n !== Number(consts[pat.key])) {
            problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而代码里的真源是 ' +
              consts[pat.key] + ' ' + pat.unit + '（常量 ' + pat.key + '，句式 ' + pat.label + '）—— ' +
              '对用户承诺的那个数与真源不一致');
          }
        }
      });
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了探针数字（判据：至少 2 个）' +
      ' —— 多半是那几句的措辞被整体改写、正则已经一条扫不到，而不是真的没人提这些数');
  }
  if (!perId.defer) {
    problems.push('「最多为它等 N 秒」这一句在用户看得见的那几页里**一处都没有** —— 那是这一族唯一对用户' +
      '说"换课前可能要等一会儿"的承诺，缺了等于把一次可能几百毫秒到几十秒的额外等待藏起来');
  }
  // 句式被整体改写 = 数字静默脱审，比写错更糟（写错会红，脱审永远绿）。
  // 所以每一格句式都必须**至少在某一份被扫文档里出现一次**；少了就点名，别让它安静地消失。
  var missingIds = CLAIM_PATTERNS.filter(function (pat) {
    return pat.id !== 'defer' && !perId[pat.id];
  }).map(function (pat) { return pat.label + '（' + pat.key + '）'; });
  if (missingIds.length) {
    problems.push('这几种句式在用户看得见的那几页里一句都没有：' + missingIds.join(' / ') +
      ' —— 要么是被改写（那这一条闸对那个数就彻底失效了），要么是承诺真被删了（那得连带删代码里的常量）。' +
      '两种都要人来判，闸不许自己认"没人提 = 通过"');
  }
  var stats = [
    '代码真源：一轮最多问 ' + consts.limit + ' 门 · 单页最多 ' + consts.fetch + ' 秒 · 整轮最多 ' + consts.budget +
      ' 秒 · 桥那一头 ' + consts.bridge + ' 秒 · 页面等桥 ' + consts.ask + ' 秒 · 最多为它等 ' + consts.defer +
      ' 秒 · 这句话最少隔 ' + consts.spoke + ' 秒 · 敲过 ' + consts.pending + ' 秒内不重敲 · ' +
      consts.fresh + ' 分钟内不重问 · 正文上限 ' + consts.bodyMax + ' 字节',
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：' +
      Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）'
  ];
  return { ok: problems.length === 0, problems: problems, stats: stats, claims: claims, perId: perId };
}

/**
 * 夹具那七格的数**一律从真源算**，自证里不许再抄一份字面量。
 * ⚠️ 反例（批次 97 反向验证 E2 实测撞到）：夹具原先写死 40 / 24 / 34 / 36 / 12 / 20 / 30，
 * 于是把代码里的 `COURSE_PROBE_ASK_MS` 改成 35000 之后，**自证那一族先红**
 * （「①干净夹具」期望 0 条、实报 2 条），而 `npm run check` 第 31 项遇自证不成立就 `return` ——
 * 用户真正需要的那句「文档说 36 秒，而代码里的真源是 35 秒」被压在一句**错的原因**底下
 * （"守卫自己坏了" vs "守卫好好的、文档过期了"）。
 * 判据：**自证只测扫描逻辑，数字跟着真源走** —— 改一个常量时应当只有"文档没跟上"这一条红。
 */
function rightValues(consts) {
  var d = { limit: 40, defer: 24, bridge: 34, ask: 36, fetch: 12, budget: 20, fresh: 30 };
  Object.keys(d).forEach(function (k) {
    if (consts && Number(consts[k]) > 0) d[k] = Number(consts[k]);
  });
  return d;
}

/** 自证里"错一位"的那个数：往后挪到不与**任何一格**的真源值撞上，撞上了那一格就测不到它要测的东西。 */
function wrongValue(key, right) {
  var used = Object.keys(right).map(function (k) { return Number(right[k]); });
  var n = Number(right[key]) + 1;
  while (used.indexOf(n) >= 0) n++;
  return n;
}

/** 干净夹具：七格句式都写对（数从真源来），且覆盖围栏代码块 / HTML 注释 / script 三个"不许算"的形状。 */
function cleanFixture(consts) {
  var v = rightValues(consts);
  return {
    'README.md': [
      '# 换课',
      '',
      '- 换课前先在后台挨门读一遍课程首页进度：**最多问 ' + v.limit + ' 门**，**单页最多 ' + v.fetch +
        ' 秒**，**整轮最多 ' + v.budget + ' 秒**。',
      '- 挑下一门那一拍会为它等一会儿：**最多为它等 ' + v.defer + ' 秒**，到点就照手里已有的进度挑。',
      '',
      '```',
      '围栏里这句不算：最多为它等 99 秒、最多问 99 门',
      '```',
      ''
    ].join('\n'),
    'HANDOVER.md': '桥那一头 **' + v.bridge + ' 秒**超时，页面等桥 **' + v.ask + ' 秒**；答过的 ' +
      v.fresh + ' 分钟内不重问，敲过 45 秒内不重敲。\n',
    'release-notes-1.3.0.md': '- 换课前先问一轮课程首页进度，最多为它等 ' + v.defer + ' 秒，到点照手里有的挑。\n',
    'docs/manual.html': [
      '<html><body>',
      '<p>换课前先在后台读进度：桥那一头 ' + v.bridge + ' 秒、页面等桥 ' + v.ask + ' 秒，最多为它等 ' +
        v.defer + ' 秒。</p>',
      '<!-- 注释里这句不算：最多为它等 77 秒 -->',
      '<script>var hint = "最多问 88 门";</script>',
      '</body></html>'
    ].join('\n')
  };
}

/** 在夹具里把 `from` 换成 `to`（每个文件只换第一次出现），供自证与反向验证用。 */
function mutate(files, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) {
    out[k] = files[k].indexOf(from) >= 0 ? files[k].replace(from, to) : files[k];
  });
  return out;
}

/**
 * 十三格自证的**判据本体**。返回 `{ ok, bad, lines }`：
 * `--selftest` 只负责把 `lines` 打印出来，`npm run check` 第 31 项直接吃 `bad` ——
 * 两处吃同一份，才不会发生"改了打印那一份、判据那份静默过期"。
 * ⚠️ 真源读不出时**不许**返回 ok：那是"没跑"，不是"跑了没问题"。
 */
function selfCheck() {
  var lines = [];
  var bad = [];
  function record(label, isOk, detail) {
    lines.push((isOk ? '  [ok]   ' : '  [FAIL] ') + label + (detail ? ' → ' + detail : ''));
    if (!isOk) bad.push(label + '：' + detail);
  }
  var consts;
  try {
    consts = constsFromSource();
  } catch (e) {
    var why = String((e && e.message) || e);
    return { ok: false, bad: ['真源读不出，自证无从算起：' + why], lines: ['  [FAIL] 真源读不出：' + why] };
  }
  var right = rightValues(consts);
  /** 把夹具里 `key` 那一格的数字换成"错一位"的数，其余文字一字不动。
   *  ⚠️ 用该格**自己的正则**定位，不拿裸数字去 `mutate` —— 数字会撞车（见 `wrongValue`），
   *     而引导词才是这一格的身份证：`桥那一头 34 秒` 与 `页面等桥 36 秒` 只差在词上。 */
  function staleKey(files, key) {
    var pat = CLAIM_PATTERNS.filter(function (p) { return p.id === key; })[0];
    var re = new RegExp(pat.re.source, 'g');
    var wrong = wrongValue(key, right);
    var out = {};
    Object.keys(files).forEach(function (f) {
      out[f] = files[f].replace(re, function (m, g1) { return m.replace(g1, String(wrong)); });
    });
    return out;
  }
  var clean = auditFiles({ docs: cleanFixture(consts), consts: consts });
  // 每一格的期望条数是**算出来再写上去**的，不是照着"应该报几条"的想象：
  // ②3 条（README / release-notes / 说明书各写了一次「最多为它等 N 秒」）、④2 条、⑥2 条（桥与页面各在两页出现）。
  var grid = [
    { name: '①干净夹具（七格句式都写对，含围栏/注释/script 三种不许算的形状）', docs: cleanFixture(consts), expect: 0, coverMin: 7 },
    { name: '②defer 错一位（三页各写了一次）', docs: staleKey(cleanFixture(consts), 'defer'), expect: 3 },
    { name: '③limit 错一位', docs: staleKey(cleanFixture(consts), 'limit'), expect: 1 },
    { name: '④bridge 错一位（HANDOVER + 说明书两处）', docs: staleKey(cleanFixture(consts), 'bridge'), expect: 2 },
    { name: '⑤fresh 错一位', docs: staleKey(cleanFixture(consts), 'fresh'), expect: 1 },
    { name: '⑥ask 错一位（HANDOVER + 说明书两处）', docs: staleKey(cleanFixture(consts), 'ask'), expect: 2 },
    { name: '⑦整套文档都不提这些数（正则被改坏时的形状：0 命中必须报）',
      docs: { 'README.md': '# 换课\n\n这里什么都不说。\n', 'HANDOVER.md': '同上。\n',
        'release-notes-1.3.0.md': '- 换课。\n', 'docs/manual.html': '<html><body><p>换课</p></body></html>' },
      expect: 3 },
    { name: '⑧真源读不出（指到一个不存在的目录）必须抛，不许静默当"没东西要核"', throwOnly: true },
    { name: '⑨把「最多问 N 门」换成换课上限那句「最少 30 门」：两把尺互不误报，但句式消失要点名',
      docs: mutate(cleanFixture(consts), '最多问 ' + right.limit + ' 门', '最少 30 门'), expect: 1,
      mustMatch: '这几种句式在用户看得见的那几页里一句都没有' },
    { name: '⑩只改数字不改句式（把 N 秒写成 N 分钟）不许被 fetch 那一格抓走',
      docs: mutate(cleanFixture(consts), '单页最多 ' + right.fetch + ' 秒',
        '单页最多 ' + right.fetch + ' 分钟'), expect: 1,
      mustMatch: '这几种句式在用户看得见的那几页里一句都没有' }
  ];
  var TOTAL = grid.length + 3;
  lines.push('十三格自证（真源：一轮 ' + consts.limit + ' 门 · defer ' + consts.defer + ' 秒 · 桥 ' +
    consts.bridge + ' 秒 · 页面 ' + consts.ask + ' 秒）');
  grid.forEach(function (g) {
    if (g.throwOnly) {
      var threw = false;
      try { constsFromSource(path.join(ROOT, '.workbuddy', 'definitely-missing-dir')); } catch (e) { threw = true; }
      record(g.name, threw, '抛错=' + threw);
      return;
    }
    var r = auditFiles({ docs: g.docs, consts: consts });
    var hit = r.problems.length;
    var okCount = hit === g.expect;
    // 报了条数还不够：⑨⑩ 期望的是**那一条**，不是随便哪一条 —— 否则缺失句式的守卫坏了也看不出来
    var okWhich = !g.mustMatch || r.problems.some(function (p) { return p.indexOf(g.mustMatch) >= 0; });
    // 第 ① 格还要求命中数本身对得上（干净夹具必须真扫到东西，否则"0 问题"是空扫）
    // ⚠️ 判据用格子自己带的 `coverMin`，**不许**写成 `g.docs === cleanFixture(consts)` ——
    //    `cleanFixture()` 每次调用返回新对象，那个恒等式永远为 false，"① 扫到了东西"这条就从来没生效过。
    var needCover = Number(g.coverMin) > 0;
    var okCover = !needCover || r.claims.length >= Number(g.coverMin);
    record(g.name, okCount && okWhich && okCover,
      '报 ' + hit + ' 条（期望 ' + g.expect + (g.mustMatch ? '，且要点名句式消失' : '') + '）' +
      (okCover ? '' : '；命中 ' + r.claims.length + ' 处，少于 ' + g.coverMin) +
      (!okWhich && hit ? '；报的不是期望那一条' : '') +
      (hit ? '：' + r.problems.join(' | ').slice(0, 320) : ''));
  });
  var cover = clean.claims.map(function (c) { return c.id; });
  var needIds = ['defer', 'bridge', 'fetch', 'budget', 'ask', 'limit', 'fresh'];
  var absent = needIds.filter(function (id) { return cover.indexOf(id) === -1; });
  record('⑪干净夹具必须把七格句式全扫到一遍（漏格 = 那一格的正则压根没被测过）', absent.length === 0,
    '命中 ' + clean.claims.length + ' 处' + (absent.length ? '，缺：' + absent.join(' / ') : ''));
  // ⑫ 反向自证：桥与页面两格的关键字必须互不越界。这一格里故意写一句「这一发桥最多 N 秒」
  //    （N = 页面那一头的数）—— 上一版 `桥…N 秒` 那条正则会把页面的数也抓成桥的承诺，当场报一条假红。
  var crossed = auditFiles({
    docs: { 'README.md': '最多为它等 ' + right.defer + ' 秒，最多问 ' + right.limit + ' 门，单页最多 ' +
        right.fetch + ' 秒，整轮最多 ' + right.budget + ' 秒。\n',
      'HANDOVER.md': '桥那一头 ' + right.bridge + ' 秒超时，这一发桥最多 ' + right.ask + ' 秒；' +
        right.fresh + ' 分钟内不重问。\n',
      'docs/manual.html': '<p>最多为它等 ' + right.defer + ' 秒。</p>',
      'release-notes-1.3.0.md': '- 最多问 ' + right.limit + ' 门。\n' },
    consts: consts
  });
  var askOnly = crossed.problems.filter(function (p) { return /与真源不一致/.test(p); });
  record('⑫文档里没有「页面等桥 N 秒」时，桥那一格不许把邻居的数当成自己的（上一版的假红就在这儿）',
    askOnly.length === 0, '数字不符 ' + askOnly.length + ' 条 / 共报 ' + crossed.problems.length +
    ' 条：' + crossed.problems.join(' | ').slice(0, 200));
  // ⑬ 跨族阴性对照（**这一格比上面那些更贵**，因为它防的是"守卫自己害人"）：
  //     文档里本来就有一族别的等待这么说话 —— 批次 40「（视频压根没源）这类等待有界：最多等 120 秒」、
  //     1.2.2「`_waitSlideAudioDone` 单页上限 600 秒」。上一版 `最多等 N 秒` / `单页 N 秒` 各抓一次，
  //     报出两条**根本不存在的承诺不符**。会误报的守卫和没有守卫一样害人（AGENTS §5）。
  //     判据：这两句必须**一条数字不符都不报**，而本族那七格句式照常被抓到。
  var neighbors = auditFiles({
    docs: { 'README.md': '这一读最多为它等 **' + right.defer + ' 秒**，一轮最多问 ' + right.limit +
          ' 门、单页最多 ' + right.fetch + ' 秒、整轮最多 ' + right.budget + ' 秒。\n' +
        '| **某一节的视频从头到尾不动** | 现在这类等待**有界**：最多等 120 秒（和设置里文档等待上限同一把尺） |\n',
      'HANDOVER.md': '桥那一头 ' + right.bridge + ' 秒超时，页面等桥 ' + right.ask + ' 秒；' +
        right.fresh + ' 分钟内不重问。\n' +
        '**1.2.2**：`_waitSlideAudioDone` 单页上限 600 秒，远超看门狗的 150 秒。\n',
      'docs/manual.html': '<p>挑的那一拍最多为它等 ' + right.defer + ' 秒。</p>',
      'release-notes-1.3.0.md': '- 一轮最多问 ' + right.limit + ' 门。\n' },
    consts: consts
  });
  var neighborReds = neighbors.problems.filter(function (p) { return /与真源不一致/.test(p); });
  record('⑬媒体那一族「最多等 120 秒」与录音那一族「单页上限 600 秒」不许被抓成本族的承诺（误报的守卫会让人开始忽略它）',
    neighborReds.length === 0 && neighbors.claims.length >= 7,
    '数字不符 ' + neighborReds.length + ' 条 / 命中 ' + neighbors.claims.length + ' 处（期望 0 条 / ≥7 处）' +
    (neighborReds.length ? '：' + neighborReds.join(' | ').slice(0, 220) : ''));
  return { ok: bad.length === 0, bad: bad, lines: lines, total: TOTAL };
}

/** `--selftest` 的打印壳：判据全在 `selfCheck()` 里，`npm run check` 第 31 项吃同一个函数。 */
function runSelfTest() {
  var r = selfCheck();
  r.lines.forEach(function (l) { console.log(l); });
  console.log(r.ok
    ? '\n探针数字对账自证通过（' + r.total + ' 格全过）'
    : '\n探针数字对账自证未通过：' + r.bad.length + ' 格红');
  return r.ok;
}

function main() {
  var argv = process.argv.slice(2);
  if (argv.indexOf('--selftest') >= 0) {
    process.exitCode = runSelfTest() ? 0 : 2;
    return;
  }
  var consts, docs = {}, missing = [], readErr = null;
  try {
    consts = constsFromSource();
  } catch (e) {
    readErr = e.message;
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p); else missing.push(f);
  });
  if (readErr) {
    console.log('[FAIL] 探针常量真源读不出：' + readErr);
    process.exitCode = 1;
    return;
  }
  if (missing.length) {
    console.log('[FAIL] 有 ' + missing.length + ' 份文档没读进来：' + missing.join(' / ') +
      '\n       文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    process.exitCode = 1;
    return;
  }
  var r = auditFiles({ docs: docs, consts: consts });
  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({ consts: consts, docs: DOCS, result: r }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  r.stats.forEach(function (s) { console.log('[ok] ' + s); });
  if (!r.ok) {
    console.log('[FAIL] 探针数字文档对账有 ' + r.problems.length + ' 条要说：\n  ' + r.problems.join('\n  '));
    console.log('\n  改法：把文档那一处改成真源现在的数，别改判据迁就现状；' +
      '\n       CHANGELOG 里的历史条目**按史实不扫**，也不要顺手回改。');
    process.exitCode = 1;
    return;
  }
  console.log('[ok] 探针数字文档对账通过（' + r.claims.length + ' 处承诺逐个等于真源；判据自身的十三格自证跑 `--selftest`）');
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = {
  NAME: '探针数字文档对账',
  DOCS: DOCS,
  SOURCES: [SRC_BG, SRC_PAGE, SRC_CONTENT],
  CLAIM_PATTERNS: CLAIM_PATTERNS,
  CONSTANT_SPECS: CONSTANT_SPECS,
  constsFromSource: constsFromSource,
  maskInvisible: maskInvisible,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  rightValues: rightValues,
  wrongValue: wrongValue,
  mutate: mutate,
  selfCheck: selfCheck,
  runSelfTest: runSelfTest
};
