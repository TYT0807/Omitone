#!/usr/bin/env node
/* audit-rate-ask-claims.js —— 核「一支最多问三发」这个数字，文档与代码是不是同一个。
 *
 * 为什么要这一条（会话任务 #209，批次 151）：
 *   批次 146 把倍速探测改成「受控试写一次最高档，问不到最多连问三发，仍问不到就按原速播完这一支」，
 *   批次 150 又给那三格补了十三格集成断言（`tools/integration-test.js` 的 `[31]`）。
 *   但那十三格核的是**代码内部的行为**（连问三发、到点收手、暂停那 60 拍），
 *   **对用户承诺的那句「三发」当时一处尺都没有** —— 只读探针量回 7 处命中分布在 3 份文档：
 *   README 两处（功能表 / 配置对照表）、说明书三处（开关表 / 故障排查 / 日志说明）、HANDOVER 两处。
 *   于是「代码把 3 改成 4 而界面与说明书还写着三发」这件事，集成、真实浏览器、字样三条闸
 *   **一条都不会红**，只有照说明书理解现场的用户被引到错方向 —— 与批次 85/86 那族换课上限漂移同形
 *   （那条已经有 `audit-switch-budget.js` 承重，这一族当时没有）。
 *
 * 判据口径（**故意做窄**，放宽就是一条会误报的守卫，同 §5「会误报的守卫和没有守卫一样害人」）：
 *   ① 真源只认 `src/page/40-media.js` 里 `this._rateUnknownTries < <整数>` 那**一行**：
 *      读不到 / 认出多处 / 不是正整数一律**报错**，不许当成"没东西要核"（§2 #2 那条老教训）。
 *   ② 文档里**问价那一族的引导词**（一支／这一支／问不到／上限／连）之后 8 字内出现
 *      「问 + 数字 + 发」，数字必须等于 ①；「问」与数字、数字与「发」之间只许空白，**不许隔字**。
 *      围栏代码块、HTML 注释、`<script>` / `<style>` 里的**不算**（用户看不见，那是给机器的）——
 *      掩码**只许有一份**，这里直接复用 `audit-switch-budget.js` 的 `maskInvisible`，
 *      `check.js` 第 30 项钉"是同一个函数"（两处各写一份，改一处另一处会静默过期）。
 *   另加一条**卫生检查**：命中要落在**至少两个不同文件**上 —— 那一句被整体改写、正则失效时，
 *   扫描会静默变成 0 条命中并打印"通过"，那是最坏的一种绿（§2 #21）。
 *
 * ⚠️ 四族**故意不扫**，扫了就是误报（每一族都有真句子，别"顺手放宽一格"）：
 *   - **「同一道最多问 6 发」——弹题那一族**（`release-notes-1.3.0.md` 同一处写的是「6 次」）。
 *     它是"同一节里同一道题"的预算，真源是 `2 ×「最多问几次」`（配置项，默认 3 → 6），**不是倍速问价**。
 *     这一条不是推的：本尺第一版只要求「问 + 数字 + 发」，**当场把 README:113 那句抓成假红**
 *     （"文档说 6 发而代码是 3"），所以引导词必须是**只有问价这一族会这么写**。
 *     ⚠️ **弹题那一族到现在也还没有尺**（2026-11-21 实测：`发` 与 `次` 两种单位在两份文档里各写一边），
 *     要立就走第 30/31 项那一套"两把尺各自排除对头"，别把它塞进本尺。
 *   - **`问 … 门`**：批次 97 那句「换课前一轮最多问 40 门」是 `COURSE_PROBE_LIMIT` 的承诺，
 *     由 `audit-course-probe-claims.js`（第 31 项）承重；反过来那一族要求数字前必须有「问」，
 *     两把尺各自排除对头，互不越界（自证 ⑩ 就是钉这一对）。
 *   - **单位是「次」的别的预算**：「三次都用尽」（解码器自愈，批次 50）、「连着三次抢回播放」
 *     （后台对打，批次 63）—— 与本尺的「发」不是同一把尺（自证 ⑨）。
 *   - **「那一发」这种量词用法**：文档里满屏的「挡下的那一发」「每一发都想那么深」不是数字承诺。
 *     数字必须**紧跟在「问」后面**，「问了一句，那一发没记下」不许读成"承诺问一句"（自证 ⑪）。
 *   - **`CHANGELOG.md` 不扫**：历史条目写的是**当时**的数，回改会把史实抹掉（口径同上）。
 *   - **中文数字只到「十」**：要写「问十一发」得用阿拉伯数字，否则这一族读不出来。
 *
 * 用法：
 *   node tools/audit-rate-ask-claims.js            # 核真文档，有问题退出 1
 *   node tools/audit-rate-ask-claims.js --json     # 同上，机器可读
 *   node tools/audit-rate-ask-claims.js --selftest # 十三格自证（含四格跨族阴性对照），不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

// ⚠️ 掩码只许有一份（口径同 `audit-course-probe-claims.js`：那边也是复用这一份）
var maskInvisible = require('./audit-switch-budget.js').maskInvisible;

var ROOT = path.resolve(__dirname, '..');
var SOURCE = 'src/page/40-media.js';
// 用户看得见的那几页 + 交接文档；CHANGELOG 故意不在这里（见头注）
var DOCS = ['README.md', 'AGENTS.md', 'HANDOVER.md', 'release-notes-1.3.0.md',
  'release-notes-preview.md', 'docs/manual.html'];

var CN = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

function toInt(tok) {
  return /^[0-9]+$/.test(tok) ? parseInt(tok, 10) : (CN[tok] == null ? NaN : CN[tok]);
}

// 引导词 = 只有"问价这一族"会这么写的词；「同一道」那一族因此落在窗外（头注 ① 那条实测假红）
var LEAD = '(?:一支|问不到|上限|读不到|按原速|连)';
var GAP = '[^0-9<>\\n]{0,8}?';
var NUM = '([0-9]{1,2}|[一二两三四五六七八九十])';
// 「问」与数字、数字与「发」之间只许空白，**不许隔字**（隔字就会把「那一发」那族量词抓进来）
var CLAIM_RE = new RegExp(LEAD + GAP + '问\\s*' + NUM + '\\s*发', 'g');
// 真源那一行：`if (this._rateUnknownTries < 3) { … }`
var SRC_RE = /this\._rateUnknownTries\s*<\s*([0-9]+)/;

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** 从代码里读回"一支最多问几发"；读不出来就抛，绝不返回 0 让闸以为"没东西要核"。 */
function askBudgetFromSource(root) {
  var p = path.join(root || ROOT, SOURCE);
  if (!fs.existsSync(p)) throw new Error('找不到倍速问价上限的真源文件：' + SOURCE);
  var lines = readText(p).split(/\r?\n/);
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    var m = SRC_RE.exec(lines[i]);
    if (m) hits.push({ no: i + 1, value: parseInt(m[1], 10) });
  }
  if (hits.length === 0) {
    throw new Error(SOURCE + ' 里找不到 `this._rateUnknownTries < <整数>` 这一行'
      + '（那一族改名或换形状了？常量改名要连这条闸一起改）');
  }
  if (hits.length > 1) {
    throw new Error(SOURCE + ' 里认出 ' + hits.length + ' 处 `_rateUnknownTries <`（第 '
      + hits.map(function (h) { return h.no; }).join(' / ') + ' 行）—— 两处数字没法对用户只说一个');
  }
  if (!(hits[0].value > 0)) throw new Error(SOURCE + ':' + hits[0].no + ' 的取值不是正整数');
  return hits[0].value;
}

/**
 * 对账。
 * @param {Object} opts { docs: {相对路径: 文本}, budget: 代码里的发数 }
 * @returns {{ ok:boolean, problems:string[], stats:string[], claims:Array }}
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var budget2 = opts && opts.budget;
  var problems = [];
  var claims = [];
  var filesWithClaim = {};
  if (!(Number(budget2) > 0)) {
    problems.push('代码侧的问价上限没读到（budget=' + budget2 + '），这一轮没东西可对账');
  }
  Object.keys(docs).sort().forEach(function (file) {
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      CLAIM_RE.lastIndex = 0;
      var m;
      while ((m = CLAIM_RE.exec(lines[i])) !== null) {
        var n = toInt(m[1]);
        if (!(n > 0)) continue; // 认不出就跳过，**不猜**（§2 #18 那一族）
        claims.push({ file: file, line: i + 1, text: m[0], value: n });
        filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
        if (Number(budget2) > 0 && n !== Number(budget2)) {
          problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而代码里 `_rateUnknownTries <` 的是 '
            + budget2 + ' —— 对用户承诺的那一发数与真源不一致');
        }
      }
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了「问几发」（判据：至少 2 个）'
      + ' —— 多半是那一句的措辞被整体改写（或单位换成了别的字）、正则已经一条扫不到，而不是真的没人提这个数字');
  }
  var stats = [
    '代码真源 _rateUnknownTries < ' + budget2 + '（' + SOURCE + '）',
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：'
      + Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）'
  ];
  return { ok: problems.length === 0, problems: problems, stats: stats, claims: claims };
}

/** 干净夹具：按 2026-11-21 实测的真形状写（README 2 + 说明书 3 + HANDOVER 2 = 7 处），
 *  并把"不许算／不许抓"的形状各埋一条诱饵：围栏、HTML 注释、script、弹题那一族、次那一族、量词「那一发」。 */
function cleanFixture() {
  return {
    'README.md': [
      '# 说明',
      '',
      '| **自动倍速** | 读它的倍速菜单，读不出就受控试写一次最高档；一支最多问三发，仍问不到就按原速播完 |',
      '| **自动最大倍速** | 一支最多问三发，问不到就按原速 |',
      '- 「判断题答错了…」同一道最多问 6 发（= 2×「最多问几次」，默认 3）—— 弹题那一族，不是这一尺的真源',
      '- 三次都用尽就放手；连着三次抢回播放都没动就不对打',
      '',
      '```',
      '围栏里这句用户看不见：一支最多问九发',
      '```',
      ''
    ].join('\n'),
    'AGENTS.md': '# 守则\n\n这里只提规矩，不提发数；问了一句，那一发并没有记进账。\n',
    'HANDOVER.md': '倍速问不到最多连问三发就按原速播完这一支；旧版是问不到连问三发才收手。\n',
    'docs/manual.html': [
      '<html><body>',
      '<tr><td>自动最大倍速</td><td>问不到最多连问三发，仍问不到就按原速播完这一支</td></tr>',
      '<p>读不到上限时<b>最多连问三发</b>，还问不出就这一支按原速播完。</p>',
      '<td>后者：这一支<b>连问三发</b>都没问出上限</td>',
      '<!-- 注释里这句不算：一支最多问八发 -->',
      '<script>var x = "连问 5 发";</script>',
      '</body></html>'
    ].join('\n')
  };
}

/** 在夹具里把 `from` 换成 `to`（**每份文件里的每一处**），供反向验证用。 */
function mutate(files, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) {
    out[k] = String(files[k]).split(from).join(to);
  });
  return out;
}

function runSelfTest() {
  var BUDGET = 3;
  var cases = [];
  var okAll = true;
  function record(label, cond, detail) {
    cases.push({ label: label, pass: !!cond, detail: detail || '' });
    if (!cond) okAll = false;
  }
  function run(docs, budget2) {
    return auditFiles({ docs: docs, budget: budget2 == null ? BUDGET : budget2 });
  }
  var clean = run(cleanFixture());
  record('①干净夹具 0 条问题、命中 7 处（README×2 / 说明书×3 / HANDOVER×2）',
    clean.ok && clean.claims.length === 7,
    clean.problems.join(' | ') + ' / n=' + clean.claims.length
      + ' / ' + clean.claims.map(function (c) { return c.file + ':' + c.line; }).join(' '));
  record('②围栏与注释与 script 里的错数不算，弹题／次／那一发三族也不算（全 7 处都是 3）',
    clean.claims.every(function (c) { return c.value === 3; }),
    clean.claims.map(function (c) { return c.file + ':' + c.line + '=' + c.text; }).join(' | '));
  // ③ 阿拉伯数字也要认（只认中文数字会漏掉"问 3 发"那种写法）
  var arabic = run({
    'README.md': '一支最多问三发。\n', 'HANDOVER.md': '问不到时最多问 3 发，就按原速播完。\n'
  });
  record('③「问 3 发」这种阿拉伯写法也要抓到（不许只认中文数字）',
    arabic.ok && arabic.claims.length === 2 && arabic.claims.some(function (c) { return c.text.indexOf('问 3 发') >= 0; }),
    arabic.problems.join(' | ') + ' / ' + arabic.claims.map(function (c) { return c.text; }).join(' | '));
  // ④⑤ 预期**不写死条数**（§5：那个数不许是我拍的）—— 判据是"被改的那几处全部红，只有它们红"
  var stale = run(mutate(cleanFixture(), '连问三发', '连问二发'));
  var staleBad = stale.claims.filter(function (c) { return c.value === 2; });
  record('④说明书与台账里凡是退成「二发」的那几处全部红，且只有它们红',
    !stale.ok && staleBad.length > 0 && stale.problems.length === staleBad.length
      && stale.claims.every(function (c) { return c.value === 2 || c.value === 3; })
      && stale.problems.every(function (p) { return /不一致/.test(p); }),
    '红 ' + stale.problems.length + ' 条 / 写成二发的 ' + staleBad.length + ' 处：' + stale.problems.join(' | '));
  var upper = run(mutate(cleanFixture(), '最多问三发', '最多问四发'));
  var upperBad = upper.claims.filter(function (c) { return c.value === 4; });
  record('⑤README 那两处改成「四发」要红，并只点名 README.md（其余两处照旧不许红）',
    !upper.ok && upperBad.length === 2 && upper.problems.length === 2
      && upper.problems.every(function (p) { return /README\.md/.test(p); }),
    '红 ' + upper.problems.length + ' 条（期望 = 写成四发的 2 处）：' + upper.problems.join(' | '));
  // ⑥ 这一格钉的是"引导词这一半在承重"：本尺第一版没有它，README:113 那句弹题承诺被当场抓成假红
  var quizOnly = run({
    'README.md': '- 同一道最多问 6 发（= 2×「最多问几次」，默认 3）。\n',
    'HANDOVER.md': '弹题那一族：同一节里同一道最多问 6 发，到顶就本地选。\n'
  });
  record('⑥「同一道最多问 6 发」（弹题那一族）不许被抓成倍速问价 —— 少了引导词这一半就是实测的那条假红',
    quizOnly.claims.length === 0 && quizOnly.problems.length === 1 && /只在 0 个文件/.test(quizOnly.problems[0]),
    '命中 ' + quizOnly.claims.length + ' 处（期望 0）：' + quizOnly.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + quizOnly.problems.join(' | '));
  var ten = run({ 'README.md': '一支最多问十发。\n', 'HANDOVER.md': '这一支连问十发才收手。\n' });
  record('⑦「问十发」读成 10 并因此报红（不许认不出就跳过）',
    !ten.ok && ten.problems.length === 2 && /代码里 `_rateUnknownTries <` 的是 3/.test(ten.problems[0]),
    ten.problems.join(' | '));
  var empty = run({ 'README.md': '这里不提发数。\n', 'HANDOVER.md': '这里也不提。\n' });
  record('⑧一处都扫不到要红（防正则失效，不许打印全绿）',
    !empty.ok && empty.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    empty.problems.join(' | '));
  var noBudget = run(cleanFixture(), 0);
  record('⑨代码侧没读到数字要红（不许当成没东西要核）',
    !noBudget.ok && noBudget.problems.some(function (p) { return /没读到/.test(p); }),
    noBudget.problems.join(' | '));
  var neighbor = run({
    'README.md': '- 三次都用尽或压根没救回来就放手；连着三次抢回播放都没动就不对打；同一道题最多 6 次。\n'
      + '- 一支最多问三发。\n',
    'HANDOVER.md': '倍速问不到连问三发就按原速。\n'
  });
  record('⑩「三次／6 次」那一族不许被抓成倍速问价（跨族阴性对照）',
    neighbor.ok && neighbor.claims.length === 2,
    '命中 ' + neighbor.claims.length + ' 处（期望 2）：' + neighbor.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + neighbor.problems.join(' | '));
  var probe = run({
    'README.md': '- 换课前那一读一轮最多问 40 门；一支最多问三发。\n',
    'HANDOVER.md': '那一读最多问 40 门；倍速问不到连问三发才收手。\n'
  });
  record('⑪「一轮最多问 40 门」不许被抓成倍速问价（与第 31 项互不越界）',
    probe.ok && probe.claims.length === 2,
    '命中 ' + probe.claims.length + ' 处（期望 2）：' + probe.claims.map(function (c) { return c.text; }).join(' | '));
  var measure = run({
    'README.md': '- 问了一句，那一发并没有记进账；这一支最多问三发。\n',
    'HANDOVER.md': '挡下的那一发不登记，问明白再说。\n'
  });
  record('⑫「那一发」这种量词用法不许被读成数字承诺（锚点紧到只认本族）',
    measure.claims.length === 1 && measure.claims[0].value === 3,
    '命中 ' + measure.claims.length + ' 处：' + measure.claims.map(function (c) { return c.text; }).join(' | '));
  var onlyComment = run({
    'README.md': '正文一句都不提。\n',
    'docs/manual.html': '<p>正文不提。</p>\n<!-- 一支最多问三发 -->\n<script>var y="连问三发";</script>\n'
  });
  record('⑬只在注释与 script 里提，要红而不是全绿（与第 30 项同款对照）',
    !onlyComment.ok && onlyComment.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    onlyComment.problems.join(' | '));
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
  var budget2 = null, readErr = null, docs = {};
  try {
    budget2 = askBudgetFromSource();
  } catch (e) {
    readErr = (e && e.message) || String(e);
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p);
  });
  var r = auditFiles({ docs: docs, budget: budget2 });
  var missing = DOCS.filter(function (f) { return !docs[f]; });
  if (missing.length) r.problems.push('该扫的页面读不到：' + missing.join(' / ') + '（读不到不许当"没问题"）');
  if (readErr) r.problems.unshift('读代码真源就失败：' + readErr);
  if (r.problems.length) r.ok = false;
  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      ok: r.ok, budget: budget2, source: SOURCE,
      claims: r.claims.map(function (c) { return c.file + ':' + c.line + ' ' + c.text; }),
      problems: r.problems
    }, null, 2));
  } else {
    r.claims.forEach(function (c) {
      console.log('  命中 ' + c.file + ':' + c.line + ' 「' + c.text + '」→ ' + c.value + ' 发');
    });
    r.stats.forEach(function (s) { console.log('  ' + s); });
    if (r.ok) {
      console.log('✓ 倍速问价对账通过：代码 ' + budget2 + ' 发，文档 ' + r.claims.length
        + ' 处逐个相等（CHANGELOG 按史实不扫）');
    } else {
      r.problems.forEach(function (p) { console.log('✗ ' + p); });
    }
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  NAME: '倍速问价发数文档对账',
  DOCS: DOCS,
  SOURCE: SOURCE,
  maskInvisible: maskInvisible,
  askBudgetFromSource: askBudgetFromSource,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  mutate: mutate,
  runSelfTest: runSelfTest
};
