#!/usr/bin/env node
/* audit-fixture-pages.js —— 核「全表 99 页夹具」这个数字，文档与代码是不是同一个（会话任务 #187）。
 *
 * 为什么要这一条：
 *   `tools/browser-e2e.js --validate-fixtures` 那句自报是**离线夹具守卫的覆盖范围**（第 23 项 spawn 它做证据），
 *   而文档里对用户／对接手的人承诺了「全表 99 页」。只读探针量回（2026-11-22）：
 *   `tools/README.md` 三处写 99（第 11 / 183 / 665 行），而 `HANDOVER.md:1586` **还停在 71 页** ——
 *   71 是批次 48 那一刻的数，此后夹具涨了近三成而那一行一个字没改。
 *   与批次 85/86 换课上限、批次 146/150 倍速问价、批次 157 弹题问价**同一族第四现**：
 *   集成、真实浏览器、界面字样三条闸一条都不会红，只有照那一行理解覆盖范围的人被引到错方向。
 *
 * 判据口径（**故意做窄**，同 §5「会误报的守卫和没有守卫一样害人」）：
 *   ① 真源是 `tools/browser-e2e.js` 里 `var MOCK_PAGES = { … };` 那一段的**顶层键**：
 *      逐行只认「行首最多两格缩进 + 单引号键 + 冒号」，注释与深缩进的函数体都不算。
 *      页数的权威取**去重后的键数**（= 运行时 `Object.keys(MOCK_PAGES).length`），
 *      而**文本键数与去重键数不等**单独报一条并点名重复的键与行号 ——
 *      本轮实测正是这一格抓到东西：`/mycourse/studentstudy` 被写了两遍（第 2630 / 2687 行），
 *      文本 100、运行时 99，前一行被静默覆盖，改它的人以为改了夹具、其实一个字没生效。
 *   ② 还要钉一句「自报那行确实拿 `Object.keys(MOCK_PAGES).length` 当数」——
 *      有人把守卫自报改成手写数字，这一族的真源就断了。
 *   ③ 文档里只有两种形状算承诺：`N 页夹具`（数字紧贴「页夹具」）与 `全表 N 页`（引导词「全表」）。
 *      掩码只许有一份：直接复用 `audit-switch-budget.js` 的 `maskInvisible`，
 *      `check.js` 第 30 项钉"五把尺是同一个函数"（批次 184 起；本把是第四把，往下还有起账窗口那一把）。
 *   ④ 卫生检查：命中要落在**至少两个不同文件**上 —— 措辞被整体改写时扫描会静默变成 0 条命中并打印"通过"（§2 #21）。
 *
 * ⚠️ 四族**故意不扫**，扫了就是误报（每一族都有真句子）：
 *   - **说明书 PDF 的页数**：README.md:712「40 页，含界面示意」、HANDOVER.md:1631「31 页」「33 页」——
 *     那是 `使用说明.pdf` 的页数（第 27/28 项那一族，真源是 pdf 本身），与夹具毫无关系。
 *   - **「N 页面」**：tools/README.md:863「5 页面**；」、HANDOVER.md:251「38 页面就在动」——
 *     「页」后面跟「面」是"网页"，不是页数。形状尺要求「页」后面紧跟「夹具」，所以天然出界。
 *   - **中文数字**：HANDOVER.md:1592「两代各自**一页**夹具」是叙述，不是承诺 —— 只认阿拉伯数字。
 *   - **场景数 / 项数**：`149 个场景`、`1356 条` 由第 9 项与计数账那两把尺管（真源不同，不许合并）。
 *   - **`CHANGELOG.md` 与 `docs/manual.html` 不扫**：前者按史实不回改（口径同上），后者压根不提夹具。
 *
 * 用法：
 *   node tools/audit-fixture-pages.js            # 核真文档，有问题退出 1
 *   node tools/audit-fixture-pages.js --json     # 同上，机器可读
 *   node tools/audit-fixture-pages.js --selftest # 十三格自证（含三格跨族阴性对照），不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

// ⚠️ 掩码只许有一份（口径同 `audit-rate-ask-claims.js` / `audit-quiz-ask-claims.js`：两把尺也是复用这一份）
var maskInvisible = require('./audit-switch-budget.js').maskInvisible;

var ROOT = path.resolve(__dirname, '..');
var SOURCE = 'tools/browser-e2e.js';
// 会承诺覆盖范围的那几页；CHANGELOG 与说明书故意不在这里（见头注）
var DOCS = ['README.md', 'tools/README.md', 'HANDOVER.md'];

// ⚠️ 夹具自己那一份"代码侧的数"是**夹具内部的常数**，不是盘上 MOCK_PAGES 的真读数：
//    对照表要测的是这把尺**认不认得出漂移**，所以它必须与夹具句子自洽（真数长到 100 页时这张表照样有效）。
//    真文档那一份对账由 `check.js` 第 30 项拿 `pagesFromSource()` 的实际读数跑，两边不共用这个常数。
var CLEAN_PAGES = 99;

// 形状 ①：`99 页夹具`；形状 ②：`全表 99 页`。数字与「页」之间只许空白，不许隔字。
var RE_PAGE_FIXTURE = /([0-9]{1,3})\s*页夹具/g;
var RE_FULL_TABLE = /全表\s*([0-9]{1,3})\s*页/g;

// 真源那一段的形状（见头注 ①②）
var BLOCK_START = /^var MOCK_PAGES = \{$/m;
var BLOCK_END = /^};$/m;
var KEY_LINE = /^[ \t]{0,2}'([^']+)':[ \t]/;
var SELF_REPORT_KEY = "Object.keys(MOCK_PAGES).length";
var SELF_REPORT_LABEL = '夹具可解析守卫：';

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/**
 * 从 `tools/browser-e2e.js` 的 MOCK_PAGES 字面量里读回夹具页数。
 * @returns {{pages:number, textual:number, dups:Array<{key:string,lines:number[]}>}}
 * @throws 找不到那一段 / 收尾不干净 / 一处键都没有 —— **绝不返回 0 让闸以为"没东西要核"**
 */
function parseFixtureKeys(text) {
  var lines = String(text).split(/\r?\n/);
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (BLOCK_START.test(lines[i])) { start = i; break; }
  }
  if (start < 0) {
    throw new Error(SOURCE + ' 里找不到顶格的 `var MOCK_PAGES = {` 那一行'
      + '（那一段改名或缩进了？改名要连这条闸一起改）');
  }
  var end = -1;
  for (var j = start + 1; j < lines.length; j++) {
    if (BLOCK_END.test(lines[j])) { end = j; break; }
  }
  if (end < 0) {
    throw new Error(SOURCE + ':' + (start + 1) + ' 起的 MOCK_PAGES 那一段找不到顶格的 `};` 收尾 —— 数不出边界');
  }
  var byKey = {};
  var order = [];
  var textual = 0;
  for (var k = start + 1; k < end; k++) {
    var m = KEY_LINE.exec(lines[k]);
    if (!m) continue; // 注释、空行、深缩进的函数体都不算
    textual++;
    var key = m[1];
    if (!byKey[key]) { byKey[key] = []; order.push(key); }
    byKey[key].push(k + 1);
  }
  if (textual === 0) {
    throw new Error(SOURCE + ' 的 MOCK_PAGES 那一段（第 ' + (start + 1) + '～' + (end + 1)
      + ' 行）一个顶层键都没数到 —— 键的写法变了（双引号？换行了？）而不是没有夹具');
  }
  var dups = order.filter(function (key) { return byKey[key].length > 1; })
    .map(function (key) { return { key: key, lines: byKey[key].slice() }; });
  return { pages: order.length, textual: textual, dups: dups, blockStart: start + 1, blockEnd: end + 1 };
}

/** 钉住"守卫自报那一句真的是拿 Object.keys(MOCK_PAGES).length 当数"（头注 ②）。 */
function assertSelfReportTether(text) {
  var t = String(text);
  if (t.indexOf(SELF_REPORT_LABEL) < 0) {
    throw new Error(SOURCE + ' 里读不到「' + SELF_REPORT_LABEL + '」那句自报 —— 离线守卫换了名字，'
      + '这一族对用户说的"全表 N 页"就没有出处了');
  }
  if (t.indexOf(SELF_REPORT_KEY) < 0) {
    throw new Error(SOURCE + ' 的自报那句不再用 `' + SELF_REPORT_KEY + '` —— '
      + '改成手写数字之后，文档对的是代码、代码对的是空气');
  }
  return true;
}

/** 读真源（代码那一份），一次读完三件事：页数、重复键、自报接线。 */
function pagesFromSource(root) {
  var p = path.join(root || ROOT, SOURCE);
  if (!fs.existsSync(p)) throw new Error('找不到夹具表真源文件：' + SOURCE);
  var text = readText(p);
  var parsed = parseFixtureKeys(text);
  assertSelfReportTether(text);
  return parsed;
}

/**
 * 对账文档里那两种形状。
 * @param {Object} opts { docs: {相对路径: 文本}, pages: 代码里的页数 }
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var pages = opts && opts.pages;
  var problems = [];
  var claims = [];
  var filesWithClaim = {};
  if (!(Number(pages) > 0)) {
    problems.push('代码侧的夹具页数没读到（pages=' + pages + '），这一轮没东西可对账');
  }
  Object.keys(docs).sort().forEach(function (file) {
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      [RE_PAGE_FIXTURE, RE_FULL_TABLE].forEach(function (re) {
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(lines[i])) !== null) {
          var n = parseInt(m[1], 10);
          if (!(n > 0)) continue; // 认不出来就跳过，**不猜**（§2 #18 那一族）
          claims.push({ file: file, line: i + 1, text: m[0], value: n });
          filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
          if (Number(pages) > 0 && n !== Number(pages)) {
            problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而代码里 MOCK_PAGES 的去重键数是 '
              + pages + ' 页 —— 对用户承诺的那一份覆盖范围与真源不一致');
          }
        }
      });
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了夹具页数（判据：至少 2 个）'
      + ' —— 多半是那一句的措辞被整体改写（或形状换成了别的说法）、正则已经一条扫不到，而不是真的没人提这个数');
  }
  var stats = [
    '代码真源 MOCK_PAGES 去重 ' + pages + ' 页（' + SOURCE + '）',
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：'
      + Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）'
  ];
  return { ok: problems.length === 0, problems: problems, stats: stats, claims: claims };
}

/**
 * 干净夹具：四句**逐字抄自盘上真形状**（tools/README.md 第 11 / 183 / 665 行 + HANDOVER 那句修好之后的数），
 * 再把"不许抓"的四族诱饵埋进 README 那一份：说明书页数、`N 页面`、中文数字「一页夹具」、场景数。
 */
function cleanFixture() {
  return {
    'README.md': [
      '# 说明',
      '',
      '| `使用说明.pdf` | 40 页，含界面示意 |',
      '- 真实 Edge 端到端共 149 个场景',
      '- 两代各自一页夹具：同一份 HTML 里既放有 src 又放没 src',
      '- 这一族覆盖了 5 页面**；定向跑只覆盖访问过的那几页',
      '',
      '```',
      '围栏里这句用户看不见：全表 7 页',
      '```',
      ''
    ].join('\n'),
    'tools/README.md': [
      '| `browser-e2e.js` | `npm run e2e` | 真实 Edge 端到端。`--validate-fixtures` 是**离线**入口：不起浏览器，把 99 页夹具逐段试解析 |',
      '    两条路径：`browser-e2e.js --validate-fixtures` 全表扫（99 页夹具，本项 spawn 一次做证据）+',
      '> 离线入口扫**全表 99 页**（定向跑只覆盖访问过的那几页）。'
    ].join('\n'),
    'HANDOVER.md': '夹具现形即扫 + `--validate-fixtures` 全表扫（99 页夹具，不起浏览器、秒级）。\n'
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

/** 合成一段 MOCK_PAGES 源码，专给解析器那一格用：注释里有像键的东西、函数体里有深缩进行、还有一枚重复键。 */
function fakeE2eText(opts) {
  var o = opts || {};
  var head = o.renameStart ? 'var FIXTURE_PAGES = {' : 'var MOCK_PAGES = {';
  var tail = o.noClose ? '' : '};\n';
  var report = o.noSelfReport ? ''
    : "console.log('夹具可解析守卫：' + Object.keys(MOCK_PAGES).length + ' 页、');\n";
  return [
    'var fs = require("fs");',
    head,
    "  // 注释里这句像键：'/fake-in-comment': buildNothing,",
    "  '/blank': buildBlankHtml,",
    "  '/quiz': function () {",
    "    return '<a href=\'http://x.example/\'>页</a>';",
    "  },",
    "  '/course-end': buildCourseEndHtml,",
    "  // 批次 89：同一份形状挂到真实路径（注释不算键）",
    "  '/space/index': buildUserCenterTopHtml,",
    "  '/mycourse/studentstudy': buildBlankHtml,",
    "      '/deep-indented-should-not-count': buildSomething,",
    "  '/mycourse/studentstudy': buildStudyDiscussionDecoyHtml,",
    "  '/frame-sig': buildFrameSigHtml",
    tail,
    report,
    'module.exports = {};'
  ].join('\n');
}

function runSelfTest() {
  var PAGES = CLEAN_PAGES;
  var cases = [];
  var okAll = true;
  function record(label, cond, detail) {
    cases.push({ label: label, pass: !!cond, detail: detail || '' });
    if (!cond) okAll = false;
  }
  function run(docs, pages) {
    return auditFiles({ docs: docs, pages: pages == null ? PAGES : pages });
  }

  var clean = run(cleanFixture());
  record('①干净夹具 0 条问题、命中 4 处（tools/README×3 / HANDOVER×1，README 那一份只埋诱饵）',
    clean.ok && clean.claims.length === 4,
    clean.problems.join(' | ') + ' / n=' + clean.claims.length
      + ' / ' + clean.claims.map(function (c) { return c.file + ':' + c.line; }).join(' '));
  record('②四处全是 99，诱饵一句都没进（说明书页数／N 页面／中文数字／场景数四族都在窗外）',
    clean.claims.every(function (c) { return c.value === 99; }),
    clean.claims.map(function (c) { return c.file + ':' + c.line + '=' + c.text; }).join(' | '));

  // ⚠️ 锚点要**带上下句**钉到唯一那一处 —— 「全表扫（99 页夹具」在 tools/README 与 HANDOVER 两份里都有，
  //    只换成半句会得到 2 条红、看着像注入越界（§5「预期表按谁在读这一栏写」的反面：先数清命中几处）
  var stale = run(mutate(cleanFixture(), '全表扫（99 页夹具，不起浏览器', '全表扫（71 页夹具，不起浏览器'));
  var staleBad = stale.claims.filter(function (c) { return c.value === 71; });
  record('③HANDOVER 那句退成「71 页夹具」（本轮实测的真漂移）要红，且只有它红',
    !stale.ok && staleBad.length === 1 && stale.problems.length === 1
      && /HANDOVER\.md/.test(stale.problems[0]) && /不一致/.test(stale.problems[0]),
    '红 ' + stale.problems.length + ' 条：' + stale.problems.join(' | '));

  var tableShape = run(mutate(cleanFixture(), '全表 99 页', '全表 120 页'));
  record('④另一形状「全表 120 页」要红 —— 形状 ② 那半把尺独立承重',
    !tableShape.ok && tableShape.problems.length === 1 && /全表 120 页/.test(tableShape.problems[0])
      && /tools\/README\.md:3/.test(tableShape.problems[0]),
    tableShape.problems.join(' | '));

  var onlyDecoy = run({
    'README.md': '| `使用说明.pdf` | 40 页，含界面示意 |\n- 覆盖了 5 页面；两代各自一页夹具。\n',
    'HANDOVER.md': '本机已 `npm run manual` 重出（31 页，新表体里旧句 0 处）；再出一次是 33 页。\n',
    'tools/README.md': '共 149 个场景、1687 项断言。\n'
  });
  record('⑤只有跨族诱饵（说明书页数／N 页面／中文数字／场景数）时一条都不许抓，且要报"只在 0 个文件"',
    onlyDecoy.claims.length === 0 && onlyDecoy.problems.length === 1 && /只在 0 个文件/.test(onlyDecoy.problems[0]),
    '命中 ' + onlyDecoy.claims.length + ' 处（期望 0）：'
      + onlyDecoy.claims.map(function (c) { return c.text; }).join(' | ') + ' / ' + onlyDecoy.problems.join(' | '));

  // 「凡是写 100 的句子全部要红」的期望条数**从夹具自己读回来**（§5：那个数不许是我拍的）
  var ten0 = run(mutate(cleanFixture(), '99 页夹具', '100 页夹具'));
  var tenBad = ten0.claims.filter(function (c) { return c.value === 100; }).length;
  record('⑥三位数也认（"100 页夹具"要红并说出代码是 99，不许因只认两位数而漏）',
    !ten0.ok && ten0.problems.length === tenBad && tenBad > 0
      && ten0.problems.every(function (p) { return /键数是 99 页/.test(p); }),
    '红 ' + ten0.problems.length + ' 条 / 写成一百页的 ' + tenBad + ' 处：' + ten0.problems.join(' | '));

  var empty = run({ 'README.md': '这里不提页数。\n', 'HANDOVER.md': '这里也不提。\n' });
  record('⑦一处都扫不到要红（防正则失效，不许打印全绿）',
    !empty.ok && empty.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    empty.problems.join(' | '));

  var noPages = run(cleanFixture(), 0);
  record('⑧代码侧没读到页数要红（不许当成没东西要核）',
    !noPages.ok && noPages.problems.some(function (p) { return /没读到/.test(p); }),
    noPages.problems.join(' | '));

  var fence = run({
    'README.md': '正文一句都不提。\n',
    'tools/README.md': '```\n全表 99 页\n99 页夹具\n```\n'
  });
  record('⑨只在围栏代码块里提要红（用户看不见的不算承诺，与第 30 项同款对照）',
    !fence.ok && fence.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    fence.problems.join(' | '));

  // 解析器契约（头注 ①②）—— 真源读错，整套对账都是空的
  var parsed = parseFixtureKeys(fakeE2eText());
  record('⑩解析器：合成块数到 7 个文本键、去重 6 页，注释与深缩进与函数体都不算',
    parsed.textual === 7 && parsed.pages === 6,
    'textual=' + parsed.textual + '（期望 7）/ pages=' + parsed.pages + '（期望 6）/ dups='
      + JSON.stringify(parsed.dups));
  record('⑪解析器：重复键要**点名键名与两处行号**（本轮实测的 /mycourse/studentstudy 那一族）',
    parsed.dups.length === 1 && parsed.dups[0].key === '/mycourse/studentstudy'
      && parsed.dups[0].lines.length === 2,
    JSON.stringify(parsed.dups));
  var noBlock = null, noBlockErr = null;
  try { noBlock = parseFixtureKeys(fakeE2eText({ renameStart: true })); } catch (e) { noBlockErr = e.message; }
  record('⑫`var MOCK_PAGES = {` 读不到要抛，不许返回 0 页让闸以为"没东西要核"',
    !noBlock && /找不到顶格/.test(String(noBlockErr)), String(noBlockErr || '没抛（返回 ' + JSON.stringify(noBlock) + '）'));
  var noReportErr = null, reportOk = null;
  try { reportOk = assertSelfReportTether(fakeE2eText({ noSelfReport: true })); } catch (e2) { noReportErr = e2.message; }
  record('⑬自报那句没了要抛（真源断了必须说话，不许只对文档）',
    reportOk !== true && /读不到/.test(String(noReportErr)), String(noReportErr || '没抛'));
  var handWritten = null, handErr = null;
  try {
    handWritten = assertSelfReportTether(
      fakeE2eText().replace("Object.keys(MOCK_PAGES).length", "'99'"));
  } catch (e3) { handErr = e3.message; }
  record('⑭自报改成手写数字要抛（文档对代码、代码对空气就是这一格挡的）',
    handWritten !== true && /不再用/.test(String(handErr)), String(handErr || '没抛'));

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
  var src = null, readErr = null, docs = {};
  try {
    src = pagesFromSource();
  } catch (e) {
    readErr = (e && e.message) || String(e);
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p);
  });
  var r = auditFiles({ docs: docs, pages: src ? src.pages : null });
  var missing = DOCS.filter(function (f) { return !docs[f]; });
  if (missing.length) r.problems.push('该扫的页面读不到：' + missing.join(' / ') + '（读不到不许当"没问题"）');
  if (readErr) r.problems.unshift('读代码真源就失败：' + readErr);
  if (src && src.dups.length) {
    src.dups.forEach(function (d) {
      r.problems.unshift(SOURCE + ' 的 MOCK_PAGES 里键「' + d.key + '」写了 ' + d.lines.length
        + ' 次（第 ' + d.lines.join(' / ') + ' 行）—— 后一份静默覆盖前一份，'
        + '于是"改了这个夹具"可以一个字都没生效，而文本键数比运行时的页数多 '
        + (src.textual - src.pages) + ' 个（文档与测试看到的都是被覆盖之后那一份）');
    });
  }
  if (r.problems.length) r.ok = false;
  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      ok: r.ok, pages: src ? src.pages : null, textual: src ? src.textual : null,
      dups: src ? src.dups : null, source: SOURCE,
      claims: r.claims.map(function (c) { return c.file + ':' + c.line + ' ' + c.text; }),
      problems: r.problems
    }, null, 2));
  } else {
    r.claims.forEach(function (c) {
      console.log('  命中 ' + c.file + ':' + c.line + ' 「' + c.text + '」→ ' + c.value + ' 页');
    });
    r.stats.forEach(function (s) { console.log('  ' + s); });
    if (src) {
      console.log('  文本键数 ' + src.textual + ' / 去重 ' + src.pages
        + '（第 ' + src.blockStart + '～' + src.blockEnd + ' 行）'
        + (src.dups.length ? ' —— 有 ' + src.dups.length + ' 枚重复键' : ' —— 无重复键'));
    }
    if (r.ok) {
      console.log('✓ 夹具页数对账通过：代码 ' + (src ? src.pages : '?') + ' 页，文档 '
        + r.claims.length + ' 处逐个相等（CHANGELOG 按史实不扫）');
    } else {
      r.problems.forEach(function (p) { console.log('✗ ' + p); });
    }
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  NAME: '夹具页数文档对账',
  DOCS: DOCS,
  SOURCE: SOURCE,
  CLEAN_PAGES: CLEAN_PAGES,
  maskInvisible: maskInvisible,
  parseFixtureKeys: parseFixtureKeys,
  assertSelfReportTether: assertSelfReportTether,
  pagesFromSource: pagesFromSource,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  fakeE2eText: fakeE2eText,
  mutate: mutate,
  runSelfTest: runSelfTest
};
