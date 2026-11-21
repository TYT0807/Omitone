#!/usr/bin/env node
/* audit-quiz-ask-claims.js —— 核「同一道弹题最多问几发／认不出的最多问几次」，文档与代码是不是同一个。
 *
 * 为什么要这一条（会话任务 #205 剩下的那半，批次 157）：
 *   这一族对用户报出来的是**两个**数，真源都在代码里：
 *     · 放手档 `A` = 默认值表里的 `popupQuizMaxAttempts`（`src/page/00-shell-constants.js:240`，现值 3）
 *       —— 「认不出的最多问 3 次后放手并冷却 60 秒」；
 *     · 预算档 `B` = `A × 倍率`（倍率写在 `src/page/80-popup-quiz.js:487` 的
 *       `Math.max(1, this._getPopupQuizMaxAttempts()) * 2` 里，现值 2 → `B` = 6）
 *       —— 「同一道最多 6 发，到顶本地选一个没被判错过的选项点掉」。
 *   倍速问价那一族在批次 146/150 有了尺（`audit-rate-ask-claims.js`，第 30 项第二把），它头注里明写
 *   「⚠️ **弹题那一族到现在也还没有尺**（2026-11-21 实测：`发` 与 `次` 两种单位在两份文档里各写一边），
 *   要立就走第 30/31 项那一套『两把尺各自排除对头』，别把它塞进本尺」—— 本件就是那笔欠账。
 *   同一族漂移已经踩过三次（批次 85/86 换课上限、批次 146/150 倍速问价）：代码改了而用户看得见的页没改，
 *   集成、真实浏览器、界面字样三条闸一条都不会红，只有照说明书理解现场的人被引到错方向。
 *
 * 判据口径（**故意做窄**，放宽就是一条会误报的守卫，同 §5「会误报的守卫和没有守卫一样害人」）：
 *   ① 两个真源各自单独读：`A` 只认 `popupQuizMaxAttempts: <整数>,` 那一行，倍率只认
 *      `_getPopupQuizMaxAttempts()) * <整数>` 那一行。读不到 / 认出多处 / 不是正整数一律**报错**，
 *      不许当成"没东西要核"（§2 #2 那条老教训）；**缺一个不许"只比另一个"**，那等于把倍率那一半的
 *      漂移静默放开（自证 ⑩⑪ 各钉一边，且要求命中照旧交回来 —— 早退不许把读数一起吞掉）。
 *   ② 文档里的形状必须是：**弹题引导词**（同一道／这一道／同一弹题／同一道题／这类题／认不出的／弹题）
 *      之后 ≤8 字内出现算符「问」或「最多」，且算符与数字、数字与单位（发／次）之间只许空白、**不许隔字**。
 *      ⚠️ 算符为什么也要认「最多」：README:485 的预算那句实际写的是「同一道最多 6 发」（**没有「问」字**）——
 *      只认「问」就漏掉真文档里的一类预算句（2026-11-21 只读探针实测）。
 *      这两半**各自**挡一整族误报，探针量出来的分布是**宽 49 处 / 窄 8 处**，那 41 处差额就是这两半挡掉的：
 *      `弹题请求**没有任何去重**，每 250ms 一轮就重问一次模型`（引导词距离 >8 字，且 `250` 那个数字挡住 GAP）、
 *      `问了不止一遍，钱付了两次`（数字必须紧贴算符）、`一支最多问三发`（倍速问价，真源 `_rateUnknownTries`）、
 *      `一轮最多问 40 门`（换课探针，第 31 项）、`最多两次`／`最多三次`（解码器自愈、重做预算等别的族）。
 *   ③ 分了档的句子必须等于**那一档**的数：命中之后 ≤24 字里出现「放手／冷却／作废／跳过」算放手档（应等 `A`），
 *      出现「本地选／到顶／记账／两倍／这一节／本节」算预算档（应等 `B`）；
 *      **两种线索都有或都没有 → 不猜档**，退回 ④ 那条弱判据，并计入 `unclassified` 打印出来
 *      （§2 #18：认不出来就交空，绝不猜 —— 猜错的档会把一次合法的红读成失败）。
 *      ⚠️ 24 字不是拍的：窗口取 12 与 28 时对真文档 8 处的**结论完全相同**（全部通过），
 *      只是分类能力不同（12 字 → 放手 3／预算 2／未分档 3；24 字 → 3／3／2）——
 *      这个数不当判据，故自证里没有任何一格的红依赖它（⑥ 钉"两线索都有→不猜"，靠的是同一句话，不靠字数）。
 *   ④ 未分档的命中仍要求 `N ∈ {A, B}` —— 这一半挡的是"代码把 3 改成 4、文档还写着 3 或 6"。
 *   另加一条**卫生检查**：命中要落在**至少两个不同文件**上 —— 那几句被整体改写、正则失效时，
 *   扫描会静默变成 0 条命中并打印"通过"，那是最坏的一种绿（§2 #21）。
 *
 * ⚠️ 掩码**只许有一份**：直接 `require` 第 30 项那份 `maskInvisible`（`audit-switch-budget.js`）。
 *    两处各写一份 = 同一件事两种口径，改一处另一处会静默过期（`check.js` 第 30 项钉"是同一个函数引用"）。
 * ⚠️ **`CHANGELOG.md` 不扫**：历史条目写的是**当时**的数，回改会把史实抹掉（口径同第 30 项那两把尺）。
 * ⚠️ 单位「发」与「次」**都认**，因为文档现在就各写一边（README 写 `6 发`、Release 页写 `6 次`）——
 *    本尺钉的是**数**；那句量词不一致登记在台账里另办，不在这里顺手改公开页的措辞
 *    （`release-notes-*.md` 与线上说明要**逐字**比，改它得连着发版，§3.7）。
 *
 * 用法：
 *   node tools/audit-quiz-ask-claims.js            # 核真文档，有问题退出 1
 *   node tools/audit-quiz-ask-claims.js --json     # 同上，机器可读（含每处的档位）
 *   node tools/audit-quiz-ask-claims.js --selftest # 十五格自证（含三格跨族阴性对照），不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

// ⚠️ 掩码只许有一份（口径同 `audit-rate-ask-claims.js` / `audit-course-probe-claims.js`）
var maskInvisible = require('./audit-switch-budget.js').maskInvisible;

var ROOT = path.resolve(__dirname, '..');
var GIVEUP_SOURCE = 'src/page/00-shell-constants.js';
var BUDGET_SOURCE = 'src/page/80-popup-quiz.js';
var DOCS = ['README.md', 'AGENTS.md', 'HANDOVER.md', 'release-notes-1.3.0.md',
  'release-notes-preview.md', 'docs/manual.html'];

var CN = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

function toInt(tok) {
  return /^[0-9]+$/.test(tok) ? parseInt(tok, 10) : (CN[tok] == null ? NaN : CN[tok]);
}

var LEAD = '(?:同一道|这一道|同一弹题|同一道题|这类题|认不出的|弹题)';
var GAPI = '[^0-9\\n]{0,8}?';
var NUM = '([0-9]{1,2}|[一二两三四五六七八九十])';
// 算符两认「问／最多」（只认「问」会漏掉 README:485 那句「同一道最多 6 发」）；算符与数字之间只许空白
var CLAIM_RE = new RegExp(LEAD + GAPI + '(?:问|最多)\\s*' + NUM + '\\s*(发|次)', 'g');

var SRC_RE = {
  giveup: /popupQuizMaxAttempts:\s*([0-9]+)/,
  mult: /_getPopupQuizMaxAttempts\(\)\)\s*\*\s*([0-9]+)/
};

var GIVEUP_TAIL = /放手|冷却|作废|跳过/;
var BUDGET_TAIL = /本地选|到顶|记账|两倍|这一节|本节/;
var TAIL_WINDOW = 24;

function readText(abs) { return fs.readFileSync(abs, 'utf8'); }

/** 通用：在指定文件里按正则读**唯一**一个正整数；读不到、多处、不合法一律抛，绝不返回 0 让闸以为"没东西要核"。 */
function readOneInt(file, re, shape, label) {
  var p = path.join(ROOT, file);
  if (!fs.existsSync(p)) throw new Error('找不到' + label + '的真源文件：' + file);
  var lines = readText(p).split(/\r?\n/);
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    var m = re.exec(lines[i]);
    if (m) hits.push({ no: i + 1, value: parseInt(m[1], 10) });
  }
  if (hits.length === 0) {
    throw new Error(file + ' 里找不到 ' + shape + ' 这一行（那一族改名或换形状了？常量改名要连这条闸一起改）');
  }
  if (hits.length > 1) {
    throw new Error(file + ' 里认出 ' + hits.length + ' 处 ' + shape + '（第 '
      + hits.map(function (h) { return h.no; }).join(' / ') + ' 行）—— 两处数字没法对用户只说一个');
  }
  if (!(hits[0].value > 0)) throw new Error(file + ':' + hits[0].no + ' 的取值不是正整数');
  return hits[0].value;
}

/** 放手档 `A`：默认值表里 `popupQuizMaxAttempts` 的那个数。 */
function giveupFromSource() {
  return readOneInt(GIVEUP_SOURCE, SRC_RE.giveup, '`popupQuizMaxAttempts: <整数>,`', '弹题放手档');
}

/** 倍率：`_popupQuizAskBudget` 里那个 `* 2`。 */
function multiplierFromSource() {
  return readOneInt(BUDGET_SOURCE, SRC_RE.mult, '`_getPopupQuizMaxAttempts()) * <整数>`', '弹题预算档的倍率');
}

/** 一次读出两档；任何一个读不出就抛（缺一个不许"只比另一个"）。 */
function quizAskBudgets() {
  var a = giveupFromSource();
  var mult = multiplierFromSource();
  return { giveup: a, multiplier: mult, budget: a * mult };
}

/**
 * 对账。
 * @param {Object} opts { docs: {相对路径: 文本}, giveup: A, multiplier: 倍率 }
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var a = opts ? Number(opts.giveup) : NaN;
  var mult = opts ? Number(opts.multiplier) : NaN;
  var problems = [];
  var claims = [];
  var filesWithClaim = {};
  var unclassified = 0;
  var b = (a > 0 && mult > 0) ? a * mult : NaN;
  if (!(a > 0) || !(mult > 0)) {
    problems.push('代码侧的两档数字没读到（放手档=' + a + '，倍率=' + mult + '），这一轮没东西可对账'
      + ' —— 缺一个不许"只比另一个"，那等于把倍率那一半的漂移静默放开');
  }
  Object.keys(docs).sort().forEach(function (file) {
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      CLAIM_RE.lastIndex = 0;
      var m;
      while ((m = CLAIM_RE.exec(lines[i])) !== null) {
        var n = toInt(m[1]);
        if (!(n > 0)) continue; // 认不出就跳过，**不猜**（§2 #18 那一族）
        var tail = lines[i].slice(m.index + m[0].length, m.index + m[0].length + TAIL_WINDOW);
        var compact = tail.replace(/\s+/g, '');
        var isGiveup = GIVEUP_TAIL.test(tail), isBudget = BUDGET_TAIL.test(tail);
        var family = (isGiveup && !isBudget) ? 'giveup' : (!isGiveup && isBudget ? 'budget' : '');
        claims.push({ file: file, line: i + 1, text: m[0], value: n, family: family, tail: compact });
        filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
        if (!(a > 0) || !(mult > 0)) continue;
        if (family === 'giveup' && n !== a) {
          problems.push(file + ':' + (i + 1) + ' 那句是**放手档**（后面紧跟「' + compact
            + '」），却写 ' + n + ' 而代码里 `popupQuizMaxAttempts` 是 ' + a
            + ' —— 对用户报的次数与真源不一致');
        } else if (family === 'budget' && n !== b) {
          problems.push(file + ':' + (i + 1) + ' 那句是**预算档**（后面紧跟「' + compact
            + '」），却写 ' + n + ' 而代码里是 ' + a + ' × ' + mult + ' = ' + b
            + ' —— 对用户报的发数与真源不一致');
        } else if (family === '') {
          unclassified++;
          if (n !== a && n !== b) {
            problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而 ' + n + ' 既不是 ' + a
              + ' 也不是 ' + b + '（这一句分不出档，只能要求它等于两档之一 —— 不许猜它属于哪一档）');
          }
        }
      }
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了「弹题问几发／几次」（判据：至少 2 个）'
      + ' —— 多半是那几句的措辞被整体改写（或引导词被换掉）、正则已经一条扫不到，而不是真的没人提这两个数');
  }
  var stats = [
    '代码真源 放手档 ' + a + ' 次 × 倍率 ' + mult + ' = 预算档 ' + b + ' 发（'
      + GIVEUP_SOURCE + ' / ' + BUDGET_SOURCE + '）',
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：'
      + Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）',
    '分档：放手 ' + countFamily({ claims: claims }, 'giveup') + ' / 预算 '
      + countFamily({ claims: claims }, 'budget') + ' / 未分档 ' + unclassified
  ];
  return {
    ok: problems.length === 0, problems: problems, stats: stats,
    claims: claims, unclassified: unclassified
  };
}

function countFamily(res, family) {
  return (res && res.claims || []).filter(function (c) { return c.family === family; }).length;
}

/** 干净夹具：八处**全部照抄 2026-11-21 只读探针量回来的真句子**（README×4 / HANDOVER×1 / Release 说明×2 / 说明书×1），
 *  并把探针里"宽口径抓到、窄口径必须放开"的形状各埋一条诱饵：围栏、HTML 注释、script、倍速那一族、
 *  探针那一族、`重问一次模型`／`问了不止一遍`／`最多两次` 那三族。 */
function cleanFixture() {
  return {
    'README.md': [
      '# 说明',
      '',
      '- 「判断题答错了…」同一道最多问 6 发（= 2×「最多问几次」，默认 3），到顶之后本地选一个还没被判错的选项点掉',
      '| **视频内嵌弹题** | 认不出的最多问 3 次后放手并冷却 60 秒。**弹窗每轮被站点收走又弹回来**；'
        + '同一道最多 6 发，到顶本地选一个没被判错过的选项点掉（零请求，也不挡住播放） |',
      '| 31 | 视频里弹出题后 AI 一直在扫描 | ① 弹题请求**没有任何去重**，每 250ms 一轮就重问一次模型；'
        + '② `_matchOptionItem` 只在选项里找，问了不止一遍、钱付了两次；'
        + '⑤ 同一弹题最多问 3 次后 `_giveUpPopupQuiz`（日志带 DOM 快照） |',
      '| **自动倍速** | 读它的倍速菜单，读不出就受控试写一次最高档；一支最多问三发，仍问不到就按原速播完 |',
      '```',
      '围栏里这句用户看不见：同一道最多问 9 发，到顶之后本地选',
      '```',
      ''
    ].join('\n'),
    'AGENTS.md': '# 守则\n\n换课前那一读一轮最多问 40 门、单页最多 12 秒；救不回来才最多等 2 分钟放手。\n',
    'HANDOVER.md': '台账旧账：弹题那一族「最多问 3 次」就放手，这一族一直没有尺对着真源核。\n',
    'release-notes-1.3.0.md': '  同一道最多问 6 次（是上面那个"最多问 3 次"的两倍，跟原来能花的总数一样，没有多给）。\n'
      + '  这一版之后同一道还是最多 6 次。\n',
    'release-notes-preview.md': '预览版这一段不提发数。\n',
    'docs/manual.html': [
      '<html><body>',
      '<p>这类题<b>最多问 3 次</b>就放手，课程会继续，不会卡死。</p>',
      '<!-- 注释里这句不算：同一道最多 8 发，到顶之后本地选 -->',
      '<script>var x = "同一道最多问 7 发，到顶之后本地选";</script>',
      '</body></html>'
    ].join('\n')
  };
}

/** 在夹具里把 `from` 换成 `to`（每份文件里的每一处），供反向验证与自证用。 */
function mutate(files, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) {
    out[k] = String(files[k]).split(from).join(to);
  });
  return out;
}

function runSelfTest() {
  var A = 3, MULT = 2;
  var cases = [];
  var okAll = true;
  function record(label, cond, detail) {
    cases.push({ label: label, pass: !!cond, detail: detail || '' });
    if (!cond) okAll = false;
  }
  function run(docs, giveup, mult) {
    return auditFiles({
      docs: docs,
      giveup: giveup == null ? A : giveup,
      multiplier: mult == null ? MULT : mult
    });
  }
  function values(res, v) {
    return res.claims.filter(function (c) { return c.value === v; }).length;
  }
  var clean = run(cleanFixture());
  record('①干净夹具（八句真形状）0 条问题、命中 8 处（README×4 / HANDOVER×1 / Release 说明×2 / 说明书×1）',
    clean.ok && clean.claims.length === 8,
    clean.problems.join(' | ') + ' / n=' + clean.claims.length
      + ' / ' + clean.claims.map(function (c) { return c.file + ':' + c.line; }).join(' '));
  record('②分档 = 放手 3 / 预算 3 / 未分档 2（档只由命中之后的线索认，不靠猜）',
    countFamily(clean, 'giveup') === 3 && countFamily(clean, 'budget') === 3 && clean.unclassified === 2,
    'giveup=' + countFamily(clean, 'giveup') + ' budget=' + countFamily(clean, 'budget')
      + ' unclassified=' + clean.unclassified + ' / ' + JSON.stringify(clean.claims.map(function (c) {
        return c.text + '→' + (c.family || '-') + '→' + c.tail;
      }), null, 1));
  record('③围栏／注释／script 里的错数不算，量词三族与倍速／探针两族也不抓，8 处取值全在 {3,6}',
    clean.claims.every(function (c) { return c.value === 3 || c.value === 6; }) && clean.claims.length === 8,
    clean.claims.map(function (c) { return c.file + ':' + c.line + '=' + c.text; }).join(' | '));
  var swapped = run(mutate(cleanFixture(), '认不出的最多问 3 次', '认不出的最多问 6 次'));
  record('④放手档那句写成 6 要红（尾部「后放手并冷却」认得出那一档）并点名放手档',
    !swapped.ok && swapped.problems.length === 1 && /对用户报的次数与真源不一致/.test(swapped.problems[0]),
    '红 ' + swapped.problems.length + ' 条：' + swapped.problems.join(' | '));
  var swapped2 = run(mutate(cleanFixture(), '同一道最多 6 发，到顶本地选', '同一道最多 3 发，到顶本地选'));
  record('⑤预算档那句写成 3 要红（尾部「到顶本地选」）并说出 `3 × 2 = 6`',
    !swapped2.ok && swapped2.problems.length === 1
      && /对用户报的发数与真源不一致/.test(swapped2.problems[0]) && /3 × 2 = 6/.test(swapped2.problems[0]),
    swapped2.problems.join(' | '));
  var bothClue = run({
    'README.md': '- 同一道最多问 3 发，本地选之后又冷却。\n',
    'HANDOVER.md': '- 这一道最多问 5 发，本地选也冷却。\n'
  });
  record('⑥两档线索同时出现的那句不许被猜成一档：写 3 放行、写 5 只报"等于两档之一"，两处都计入未分档',
    bothClue.claims.length === 2 && bothClue.unclassified === 2 && countFamily(bothClue, 'giveup') === 0
      && countFamily(bothClue, 'budget') === 0 && bothClue.problems.length === 1
      && /5 既不是 3 也不是 6/.test(bothClue.problems[0]) && /分不出档/.test(bothClue.problems[0]),
    'claims=' + JSON.stringify(bothClue.claims.map(function (c) { return c.family || '-'; }))
      + ' unclassified=' + bothClue.unclassified + ' / ' + bothClue.problems.join(' | '));
  // ⑦⑧ 预期**不写死条数**（§5：那个数不许是我拍的）—— 判据写成"凡是与两档都不等的句子全部红、只它们红"
  var aDrift = run(cleanFixture(), 6, 1); // A=6、倍率=1 ⇒ B=6：凡写 3 的句子过期，写 6 的一句不许红
  record('⑦放手档漂到 6（倍率=1 ⇒ 两档都是 6）：红的条数必须恰好等于文档里写 3 处数，写 6 的一处不许误报',
    !aDrift.ok && aDrift.problems.length === values(clean, 3) && values(clean, 3) === 4
      && aDrift.problems.every(function (p) { return /却写 3|而 3 既不是/.test(p); }),
    '红 ' + aDrift.problems.length + ' 条 / 写 3 的 ' + values(clean, 3) + ' 处：' + aDrift.problems.join(' | '));
  var mDrift = run(cleanFixture(), 3, 3); // 倍率 2→3 ⇒ B=9：凡写 6 的句子过期
  record('⑧倍率改成 3（预算档=9）：红的条数必须恰好等于文档里写 6 处数，倍率那一半也承重',
    !mDrift.ok && mDrift.problems.length === values(clean, 6) && values(clean, 6) === 4
      && mDrift.problems.every(function (p) { return /却写 6|而 6 既不是/.test(p); })
      && mDrift.problems.some(function (p) { return /3 × 3 = 9/.test(p); }),
    '红 ' + mDrift.problems.length + ' 条 / 写 6 的 ' + values(clean, 6) + ' 处：' + mDrift.problems.join(' | '));
  var empty = run({ 'README.md': '这里不提发数。\n', 'HANDOVER.md': '这里也不提。\n' });
  record('⑨一处都扫不到要红（防正则／引导词失效，不许当成没东西要核、不许打印全绿）',
    !empty.ok && empty.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    empty.problems.join(' | '));
  var noA = run(cleanFixture(), 0, 2);
  var noMult = run(cleanFixture(), 3, 0);
  record('⑩放手档读不出要红（不许"只比预算那一半"），且命中照旧要交回来',
    !noA.ok && noA.problems.some(function (p) { return /没读到/.test(p); }) && noA.claims.length === 8
      && noA.problems.length === 1,
    '红 ' + noA.problems.length + ' 条 / 命中 ' + noA.claims.length + '：' + noA.problems.join(' | '));
  record('⑪倍率读不出也要红，同样不许塌进"没东西要核"（两格各自独立，摘一半另一半仍要响）',
    !noMult.ok && noMult.problems.some(function (p) { return /没读到/.test(p); }) && noMult.claims.length === 8
      && noMult.problems.length === 1,
    '红 ' + noMult.problems.length + ' 条 / 命中 ' + noMult.claims.length + '：' + noMult.problems.join(' | '));
  var rateFamily = run({
    'README.md': '| **自动倍速** | 一支最多问三发，仍问不到就按原速播完这一支 |\n'
      + '- 同一道最多问 6 发，到顶之后本地选。\n',
    'HANDOVER.md': '倍速问不到连问三发才按原速播完。\n- 这一道最多 6 发，到顶本地选。\n'
  });
  record('⑫倍速那一族「一支最多问三发」不许被抓成弹题问价（跨族阴性对照，真源是 `_rateUnknownTries`）',
    rateFamily.ok && rateFamily.claims.length === 2
      && rateFamily.claims.every(function (c) { return c.value === 6; }),
    '命中 ' + rateFamily.claims.length + ' 处（期望 2，且全是 6）：'
      + rateFamily.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + rateFamily.problems.join(' | '));
  var probeFamily = run({
    'README.md': '- 换课前那一读一轮最多问 40 门、单页最多 12 秒。\n- 这一道最多问 3 次就放手。\n',
    'HANDOVER.md': '那一读最多问 40 门（第 31 项的账）。\n- 同一道最多 6 发，到顶之后本地选。\n'
  });
  record('⑬「一轮最多问 40 门」不许被抓（与第 31 项互不越界）',
    probeFamily.ok && probeFamily.claims.length === 2
      && probeFamily.claims.some(function (c) { return c.value === 3; })
      && probeFamily.claims.some(function (c) { return c.value === 6; }),
    '命中 ' + probeFamily.claims.length + ' 处（期望 2）：'
      + probeFamily.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + probeFamily.problems.join(' | '));
  var measure = run({
    'README.md': '- 弹题请求没有去重，每 250ms 一轮就重问一次模型；同一道最多问 6 发，到顶之后本地选。\n',
    'HANDOVER.md': '问了不止一遍，钱付了两次；这一道最多问 3 次就放手。\n'
      + '还是救不回来才最多等 2 分钟放手，试过最多三次。\n'
      + '这一道问明白是 3 次就放手。\n'
  });
  record('⑭「重问一次模型」「问了不止一遍」「付了两次」「最多三次」「问明白是 3 次」不许被读成数字承诺（引导词距离 + 算符紧贴数字，两半各自承重）',
    measure.ok && measure.claims.length === 2
      && measure.claims.every(function (c) { return c.value === 3 || c.value === 6; }),
    '命中 ' + measure.claims.length + ' 处（期望 2）：'
      + measure.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + measure.problems.join(' | '));
  var onlyComment = run({
    'README.md': '正文一句都不提。\n',
    'docs/manual.html': '<p>正文不提。</p>\n<!-- 同一道最多 6 发，到顶之后本地选 -->\n'
      + '<script>var y = "这一道最多问 3 次就放手";</script>\n'
  });
  record('⑮只在注释与 script 里提，要红而不是全绿（与第 30 项那两把尺同款对照）',
    !onlyComment.ok && onlyComment.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    onlyComment.problems.join(' | '));
  var noLead = run({
    'README.md': '- 最多问 6 发，到顶之后本地选。\n',
    'HANDOVER.md': '- 最多问 3 次就放手。\n'
  });
  record('⑯没有弹题引导词的那两句不许被抓（① 引导词这一半单独摘掉时，本尺就退化成"什么都抓"的会误报的守卫）',
    noLead.claims.length === 0 && noLead.problems.length === 1 && /只在 0 个文件/.test(noLead.problems[0]),
    '命中 ' + noLead.claims.length + ' 处（期望 0）：'
      + noLead.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + noLead.problems.join(' | '));
  cases.forEach(function (c) {
    console.log((c.pass ? '✓ ' : '✗ ') + c.label + (c.detail && !c.pass ? ' —— ' + c.detail : ''));
  });
  console.log(okAll ? '自证通过（共 ' + cases.length + ' 格）' : '自证失败（共 ' + cases.length + ' 格）');
  return okAll;
}

function main() {
  var argv = process.argv.slice(2);
  if (argv.indexOf('--selftest') >= 0) {
    process.exitCode = runSelfTest() ? 0 : 2;
    return;
  }
  var budgets = null, readErr = null, docs = {};
  try {
    budgets = quizAskBudgets();
  } catch (e) {
    readErr = (e && e.message) || String(e);
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p);
  });
  var r = auditFiles({
    docs: docs,
    giveup: budgets ? budgets.giveup : 0,
    multiplier: budgets ? budgets.multiplier : 0
  });
  var missing = DOCS.filter(function (f) { return !docs[f]; });
  if (missing.length) r.problems.push('该扫的页面读不到：' + missing.join(' / ') + '（读不到不许当"没问题"）');
  if (readErr) r.problems.unshift('读代码真源就失败：' + readErr);
  if (r.problems.length) r.ok = false;
  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      ok: r.ok,
      giveup: budgets ? budgets.giveup : null, multiplier: budgets ? budgets.multiplier : null,
      budget: budgets ? budgets.budget : null,
      sources: [GIVEUP_SOURCE, BUDGET_SOURCE], unclassified: r.unclassified,
      claims: r.claims.map(function (c) {
        return c.file + ':' + c.line + ' ' + c.text + ' [' + (c.family || '未分档') + ']';
      }),
      problems: r.problems
    }, null, 2));
  } else {
    r.claims.forEach(function (c) {
      console.log('  命中 ' + c.file + ':' + c.line + ' 「' + c.text + '」→ ' + c.value
        + '（' + (c.family === 'giveup' ? '放手档' : c.family === 'budget' ? '预算档' : '未分档') + '）');
    });
    r.stats.forEach(function (s) { console.log('  ' + s); });
    if (r.ok) {
      console.log('✓ 弹题问价对账通过：代码放手 ' + (budgets && budgets.giveup) + ' 次 × 倍率 '
        + (budgets && budgets.multiplier) + ' = 预算 ' + (budgets && budgets.budget) + ' 发，文档 '
        + r.claims.length + ' 处逐个对上（未分档 ' + r.unclassified + ' 处按两档之一核；CHANGELOG 按史实不扫）');
    } else {
      r.problems.forEach(function (p) { console.log('✗ ' + p); });
    }
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  NAME: '弹题问价发数文档对账',
  DOCS: DOCS,
  GIVEUP_SOURCE: GIVEUP_SOURCE,
  BUDGET_SOURCE: BUDGET_SOURCE,
  maskInvisible: maskInvisible,
  giveupFromSource: giveupFromSource,
  multiplierFromSource: multiplierFromSource,
  quizAskBudgets: quizAskBudgets,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  mutate: mutate,
  countFamily: countFamily,
  runSelfTest: runSelfTest
};
