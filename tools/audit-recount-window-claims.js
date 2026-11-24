#!/usr/bin/env node
/* audit-recount-window-claims.js —— 核「六小时重新起账」这个数字，文档与代码是不是同一个。
 *
 * 为什么要这一条（会话任务 #65，批次 180）：
 *   `src/page/64-tasks-loop.js` 里那句 `Date.now() - Number(ledger.at || 0) > 6 * 3600 * 1000`
 *   是**被站点退回的课唯一那扇门**（`tried` 名单到点整本作废），而它同时对用户承诺了两句话：
 *   README「连续换课最多 30 门、六小时重新起账」、说明书「六小时重新起账 / 同一门六小时内只进一次」、
 *   Release 页「（六小时之后重新起账，同一门六小时内只进一次）」，还有代码里那句给用户看的原话
 *   「要么等六小时换课名单重新起账再试」。**这一族当时一处尺都没有** —— 只读探针量回（2026-11-23）
 *   4 份文档 9 处命中，全部手抄同一个 6。
 *   于是「代码把 6 改成 8 而说明书还写着六小时」这件事，集成、真实浏览器、字样三条闸
 *   **一条都不会红**，只有照那一页理解「被退回的课还要等多久」的人被引到错方向 ——
 *   与批次 85/86 换课上限、批次 146/150 倍速问价、批次 157 弹题问价、批次 168 夹具页数
 *   **同一族第五现**（第 30 项第五把尺，**不占新项号**：项数是文档里手抄的数，多一项要动一串页面）。
 *
 * 判据口径（**故意做窄**，放宽就是一条会误报的守卫，同 §5「会误报的守卫和没有守卫一样害人」）：
 *   ① 真源只认那一行「`ledger.at` 比 `N * 3600 * 1000`」的形状：从 `src/page/64-tasks-loop.js`
 *      **逐行**读。读不到 / 认出多处 / 不是正整数 / 被改写成裸毫秒数一律**抛错**，
 *      不许塌成"没东西要核"（§2 #2 那一族老教训：`Number(undefined)` 变成 0 就像确认了没有）。
 *   ② 文档里「数字 + 小时 …（≤8 字，不跨行、不越过 HTML 标签与数字）… 重新起账 / 起账 /
 *      只进一次 / 换课名单」**这一族**句子的数字必须等于 ①。中文数字与阿拉伯数字都认；
 *      **认不出来的写法单独计数并印出来，绝不猜**（§2 #18：把不认识的形状拆成数字比没结论危险）。
 *      围栏代码块、HTML 注释、`<script>` / `<style>` 里的**不算** —— 掩码**只许有一份**，
 *      这里直接复用 `audit-switch-budget.js` 的 `maskInvisible`，`check.js` 第 30 项钉"五把尺是同一个函数"。
 *   ③ **反向不扫**（「重新起账 … 六小时」这种倒装）。这不是偷懒，是量出来的：2026-11-23 实测
 *      倒装命中 2 处，两处所在的那一句**前向都已经抓到**（Release 页那句「六小时之后重新起账，
 *      同一门六小时内只进一次」两个分句各算一次就够），加进去只会让同一句报两条，
 *      而"报两条"在红项清单里长得像"两处漂移"。自证 ⑬ 钉的就是这一条。
 *   ④ 代码侧还要钉一句**运行时原话**（头注第一段那句给用户看的 `要么等六小时换课名单重新起账再试`）
 *      的小时数也等于 ① —— 常量改了而那句话没改，现场日志就对用户说了一句假话，而文档对账量不到它。
 *   ⑤ 卫生检查：命中要落在**至少两个不同文件**上 —— 那一族句式被整体改写、正则失效时，
 *      扫描会静默变成 0 条命中并打印"通过"，那是最坏的一种绿（§2 #21）。
 *
 * ⚠️ 六族**故意不扫**，扫了就是误报（每一族都有真句子，别"顺手放宽一格"）：
 *   - **更新检查那一族**：`docs/manual.html:566` 「手动 6 小时一次、自动 24 小时一次」是 GitHub
 *     配额频率。它离「起账」这类线索词很远，且「6 小时」后面紧跟的是 `</b>` —— 间隔字符类排掉了
 *     `<` `>` 与数字，所以天然出界（自证 ⑧）。
 *   - **24 小时跳过名单**：README:474 与代码里「24 小时内不再尝试」是**任务点放弃**那一本账，
 *     线索词是「跳过名单」不是「换课名单」（自证 ⑨）。
 *   - **非数字量词**：「每小时提醒一次」（课程卫士那句）、「最多刷 3 次就停半小时」——
 *     「每」「半」不在数字字符类里（自证 ⑩）。
 *   - **AGENTS 里那句「TTL（6 小时）到点允许再问一枚」**：同一枚数字、完全不同的承诺（倍速问价的
 *     课程策略账）—— 它后面 8 字内没有任何线索词（自证 ⑪）。
 *   - **「最多 30 门」「一轮最多问 40 门」**：换课上限与探针预算两族，单位是**门**不是小时，
 *     由第 30 项第一把尺与第 31 项各自承重（自证 ⑫）。
 *   - **`CHANGELOG.md` 不扫**：历史条目写的是**当时**的数（批次 86 那条就得写"由 8 提到 30"那种句子），
 *     回改会把史实抹掉 —— 口径同上四把尺。
 *
 * 用法：
 *   node tools/audit-recount-window-claims.js            # 核真文档，有问题退出 1
 *   node tools/audit-recount-window-claims.js --json     # 同上，机器可读
 *   node tools/audit-recount-window-claims.js --selftest # 逐格自证（格数看它自己打印的那一行，别在散文里手抄）
 */
'use strict';

var fs = require('fs');
var path = require('path');

// ⚠️ 掩码只许有一份（口径同 `audit-rate-ask-claims.js` / `audit-quiz-ask-claims.js` / `audit-fixture-pages.js`）
var maskInvisible = require('./audit-switch-budget.js').maskInvisible;

var ROOT = path.resolve(__dirname, '..');
var SOURCE = 'src/page/64-tasks-loop.js';
// 用户看得见的那几页 + 交接文档；CHANGELOG 故意不在这里（见头注）
var DOCS = ['README.md', 'AGENTS.md', 'HANDOVER.md', 'release-notes-1.3.0.md',
  'release-notes-preview.md', 'docs/manual.html'];

// 夹具自己那一份"代码侧的数"是**夹具内部的常数**，不是盘上的真读数：对照表要测的是这把尺
// **认不认得出漂移**，所以它必须与夹具句子自洽（真源哪天改成 8 小时，这张表照样有效）。
var CLEAN_HOURS = 6;

var DIGITS = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

/** 中文数字只认「六」「十」「十二」「二十三」这一族；认不出交 NaN，**由调用方单独计数，不许猜**。 */
function cnToInt(tok) {
  var s = String(tok == null ? '' : tok);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  var ten = /^十([一二三四五六七八九])?$/.exec(s);
  if (ten) return 10 + (ten[1] ? DIGITS[ten[1]] : 0);
  var m = /^([一二两三四五六七八九])十([一二三四五六七八九])?$/.exec(s);
  if (m) return DIGITS[m[1]] * 10 + (m[2] ? DIGITS[m[2]] : 0);
  if (s.length === 1 && DIGITS[s]) return DIGITS[s];
  return NaN;
}

// ⚠️ 这一族必须**先把"数字那一串"整口吃掉再判认不认得**：字符类如果只装常规数字，
//    「廿一小时」会退化成从「一」开始匹配，于是凭空产出一条「一小时」的承诺（§2 #18
//    「认不出来交空串要每一把尺都装」在这里的第二张脸 —— 少装一个字，尺就自己替文档猜了一档）。
//    所以「廿」「卅」「〇」「零」都装进类里，让整串落到 `cnToInt` 手上，认不出就进 `unknown` 那一格。
var NUM = '([0-9〇零一二两三四五六七八九十廿卅]{1,4})';
var CLUE = '(?:重新起账|起账|只进一次|换课名单)';
// 间隔：不跨行、不越过另一枚数字、不越过 HTML 标签（更新检查那一族靠这一条出界）
var GAP = '[^0-9<>\\n]{0,8}?';
var CLAIM_RE = new RegExp(NUM + '\\s*小时' + GAP + CLUE, 'g');

// 真源那一行的形状：`if (Date.now() - Number(ledger.at || 0) > 6 * 3600 * 1000) { … }`
var WINDOW_RE = /Number\(\s*ledger\.at\b[^)]*\)\s*(?:>|>=)\s*([0-9]+)\s*\*\s*3600\s*\*\s*1000/;
// 代码里那句给用户看的原话（头注 ④）
var SENTENCE_RE = /等\s*([0-9一二两三四五六七八九十]{1,3})\s*小时\s*换课名单\s*重新起账/;
// 故意点名的"读不出"形状：有人把窗口写成裸毫秒，这一族就断了
var BARE_MS_RE = /Number\(\s*ledger\.at\b[^)]*\)\s*(?:>|>=)\s*[0-9]{6,}\b/;

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/**
 * 从代码文本里读回"换课名单隔几个小时重新起账"（纯函数，自证能在内存里喂它任意形状）。
 * @returns {{hours:number, line:number}}
 * @throws 读不到 / 多处 / 不是正整数 / 被写成裸毫秒 —— **绝不返回 0 让闸以为"没东西要核"**
 */
function hoursFromText(text) {
  var lines = String(text == null ? '' : text).split(/\r?\n/);
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    var m = WINDOW_RE.exec(lines[i]);
    if (m) hits.push({ no: i + 1, hours: parseInt(m[1], 10) });
  }
  if (hits.length === 0) {
    var bare = null;
    for (var b = 0; b < lines.length; b++) {
      if (BARE_MS_RE.test(lines[b])) { bare = b + 1; break; }
    }
    throw new Error(SOURCE + ' 里找不到「`ledger.at` 比 N * 3600 * 1000」那一行'
      + (bare ? ' —— 第 ' + bare + ' 行现在写的是**裸毫秒数**：这一族读不出小时数，'
        + '要改承诺就得连这条闸一起改，别让它静默变成"没有东西要核"' : '（那一行换名或换形状了？）'));
  }
  if (hits.length > 1) {
    throw new Error(SOURCE + ' 里认出 ' + hits.length + ' 处 `ledger.at` 窗口（第 '
      + hits.map(function (h) { return h.no; }).join(' / ') + ' 行）—— 两处数字没法对用户只说一个');
  }
  if (!(hits[0].hours > 0)) throw new Error(SOURCE + ':' + hits[0].no + ' 的小时数不是正整数');
  return { hours: hits[0].hours, line: hits[0].no };
}

/** 头注 ④：钉住代码里那句**对用户说的话**与常量说的是同一个数。 */
function assertRuntimeSentenceTether(text, hours) {
  var t = String(text == null ? '' : text);
  var m = SENTENCE_RE.exec(t);
  if (!m) {
    throw new Error(SOURCE + ' 里读不到「等 N 小时换课名单重新起账」那句给用户看的原话 —— '
      + '那句话改写之后，"被退回的课还要等多久"这一族对用户就不再说小时数了，这条尺也就没了出处');
  }
  var said = cnToInt(m[1]);
  if (!(said > 0)) {
    throw new Error(SOURCE + ' 那句原话里的小时数「' + m[1] + '」这一族写法认不出来 —— 不许猜成任何一档');
  }
  if (said !== Number(hours)) {
    throw new Error(SOURCE + ' 那句原话说「等' + m[1] + '小时」=' + said + ' 小时，而窗口常量是 '
      + hours + ' 小时 —— 现场日志会对用户报一个假窗口');
  }
  return { text: m[0], hours: said };
}

/** 读真源（代码那一份）：窗口常量 + 运行时原话接线。 */
function recountFromSource(root) {
  var p = path.join(root || ROOT, SOURCE);
  if (!fs.existsSync(p)) throw new Error('找不到换课起账窗口真源文件：' + SOURCE);
  var text = readText(p);
  var w = hoursFromText(text);
  var tether = assertRuntimeSentenceTether(text, w.hours);
  return { hours: w.hours, line: w.no || w.line, sentence: tether.text };
}

/**
 * 对账。
 * @param {Object} opts { docs: {相对路径: 文本}, hours: 代码里的小时数 }
 * @returns {{ok:boolean, problems:string[], stats:string[], claims:Array, unknown:Array}}
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var hours = opts && opts.hours;
  var problems = [];
  var claims = [];
  var unknown = [];
  var filesWithClaim = {};
  if (!(Number(hours) > 0)) {
    problems.push('代码侧的起账窗口没读到（hours=' + hours + '），这一轮没东西可对账');
  }
  Object.keys(docs).sort().forEach(function (file) {
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      CLAIM_RE.lastIndex = 0;
      var m;
      while ((m = CLAIM_RE.exec(lines[i])) !== null) {
        var n = cnToInt(m[1]);
        if (!(n > 0)) {
          // 认不出单独占一格（§2 #12）：印出来给人看，既不猜成承诺、也不当"没这句话"
          unknown.push({ file: file, line: i + 1, text: m[0] });
          continue;
        }
        claims.push({ file: file, line: i + 1, text: m[0], value: n });
        filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
        if (Number(hours) > 0 && n !== Number(hours)) {
          problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而代码里的起账窗口是 '
            + hours + ' 小时 —— 对用户承诺的那一个数与真源不一致');
        }
      }
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了起账窗口（判据：至少 2 个）'
      + ' —— 多半是那一句的措辞被整体改写（或线索词换成了别的说法），正则已经一条扫不到，'
      + '而不是真的没人提这个窗口');
  }
  var stats = [
    '代码真源 ledger.at 窗口 = ' + hours + ' 小时（' + SOURCE + '）',
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：'
      + Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）',
    '认不出的写法 ' + unknown.length + ' 处' + (unknown.length ? '：'
      + unknown.map(function (u) { return u.file + ':' + u.line + '「' + u.text + '」'; }).join(' / ') : '（不猜，也不当成没有）')
  ];
  return { ok: problems.length === 0, problems: problems, stats: stats, claims: claims, unknown: unknown };
}

/**
 * 干净夹具：句子按 2026-11-23 实测的真形状写（README 1 + 说明书 2 + Release 页 2 + HANDOVER 2 = 7 处），
 * 并把六族"不许算／不许抓"的诱饵各埋一条真句子。
 */
function cleanFixture() {
  return {
    'README.md': [
      '# 说明',
      '',
      '- 四道保险：进过的课记在换课名单里，**同一门不会反复进**；连续换课**最多 30 门**、六小时重新起账，**60 秒内不重复换**。',
      '| **做不完就放弃** | 反复做不完的任务点记入 **24 小时跳过名单**，可一键清除让它重试 |',
      '- 换课前先在后台挨门读一遍进度：一轮最多问 40 门、单页最多 12 秒。',
      '',
      '```',
      '围栏里这句用户看不见：八小时重新起账',
      '```',
      ''
    ].join('\n'),
    'AGENTS.md': '# 守则\n\nTTL（6 小时）到点**允许再问一枚** —— 「少动手」不等于「永不试」。\n'
      + '跨 30 分钟或换了课就重新起账（这一族是另一本账，没有小时数）。\n',
    'HANDOVER.md': '三道账：`at` 隔 6 小时重新起账；被退回的课最长要等满一个六小时窗口才重新起账。\n',
    'release-notes-1.3.0.md': '  （六小时之后重新起账，同一门六小时内只进一次），到顶就停下来告诉你为什么。\n',
    'docs/manual.html': [
      '<html><body>',
      '  <b>为什么不能一直点</b>：查询走的是 GitHub 的免费额度。手动 <b>6 小时</b>一次、',
      '  自动 <b>24 小时</b>一次 —— 点太勤会把额度用光。<br>',
      '  而且<b>一轮连续刷课最多换几门，按你用户中心里能进的课来给，最少 30 门</b>（六小时重新起账，',
      '  真正防来回空转的是名单：同一门六小时内只进一次）。',
      '  到上限了日志会直说，想继续就手动进下一门，或者关掉再打开刷课重新起账。',
      '  <p>课程卫士<b>每小时提醒一次</b>，不是每一拍都喊。</p>',
      '  <p>验证码墙现在<b>最多刷 3 次就停半小时</b>。</p>',
      '<!-- 注释里这句不算：五小时重新起账 -->',
      '<script>var x = "七小时重新起账";</script>',
      '</body></html>'
    ].join('\n')
  };
}

/** 在夹具里把 `from` 换成 `to`（每份文件里的每一处），供反向验证用。 */
function mutate(files, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) {
    out[k] = String(files[k]).split(from).join(to);
  });
  return out;
}

function runSelfTest() {
  var cases = [];
  var okAll = true;
  function record(label, cond, detail) {
    cases.push({ label: label, pass: !!cond, detail: detail || '' });
    if (!cond) okAll = false;
  }
  function run(docs, hours) {
    return auditFiles({ docs: docs, hours: hours == null ? CLEAN_HOURS : hours });
  }
  function throws(fn) {
    try { fn(); return null; } catch (e) { return String((e && e.message) || e); }
  }

  var clean = run(cleanFixture());
  record('①干净夹具 0 条问题、命中 7 处（README×1 / HANDOVER×2 / Release 页×2 / 说明书×2）',
    clean.ok && clean.claims.length === 7,
    clean.problems.join(' | ') + ' / n=' + clean.claims.length + ' / '
      + clean.claims.map(function (c) { return c.file + ':' + c.line + '「' + c.text + '」'; }).join(' '));
  var arabic = run({
    'README.md': '连续换课最多 30 门，6 小时重新起账。\n',
    'HANDOVER.md': '名单隔十二小时才起账。\n'
  });
  record('②阿拉伯数字与「十二」这类中文写法都要认（只认单个中文数字就会把「十二」读成"没这句话"）',
    !arabic.ok && arabic.claims.length === 2 && arabic.unknown.length === 0
      && arabic.claims.some(function (c) { return c.value === 6; })
      && arabic.claims.some(function (c) { return c.value === 12; }),
    'unknown=' + arabic.unknown.length + ' / '
      + arabic.claims.map(function (c) { return c.text + '=' + c.value; }).join(' | ')
      + ' / ' + arabic.problems.join(' | '));
  record('③围栏代码块里的「八小时重新起账」不算命中',
    clean.claims.every(function (c) { return c.text.indexOf('八小时') !== 0; })
      && clean.claims.every(function (c) { return c.value === 6; }),
    clean.claims.map(function (c) { return c.file + ':' + c.line + '=' + c.value; }).join(' | '));
  record('④HTML 注释与 `<script>` 里的「五小时／七小时」不算命中',
    clean.claims.every(function (c) { return c.file !== 'docs/manual.html' || c.value === 6; }),
    clean.claims.filter(function (c) { return c.file === 'docs/manual.html'; })
      .map(function (c) { return c.line + '=' + c.value; }).join(' | '));
  var stale = run(mutate(cleanFixture(), '六小时内只进一次', '两小时内只进一次'));
  var staleBad = stale.claims.filter(function (c) { return c.value === 2; });
  record('⑤文档凡是退成「两小时」的那几处全部红，且只有它们红（预期按"谁被改"写，不写死条数）',
    !stale.ok && staleBad.length > 0 && stale.problems.length === staleBad.length
      && stale.problems.every(function (p) { return /不一致/.test(p); }),
    '红 ' + stale.problems.length + ' 条 / 写成两小时的 ' + staleBad.length + ' 处：' + stale.problems.join(' | '));
  var upper = run(mutate(cleanFixture(), '、六小时重新起账', '、八小时重新起账'));
  var upperBad = upper.claims.filter(function (c) { return c.value === 8; });
  record('⑥README 那一处改成「八小时」要红，并只点名 README.md',
    !upper.ok && upperBad.length === 1 && upper.problems.length === 1 && /README\.md/.test(upper.problems[0]),
    '红 ' + upper.problems.length + ' 条（期望 1）：' + upper.problems.join(' | '));
  var shortClue = run({ 'README.md': '名单六小时起账。\n', 'HANDOVER.md': '隔六小时才起账一次。\n' });
  record('⑦「六小时起账」这种把「重新」省掉的写法也要抓到（线索词表里 `起账` 单独在）',
    shortClue.claims.length === 2 && shortClue.ok,
    '命中 ' + shortClue.claims.length + ' 处：' + shortClue.claims.map(function (c) { return c.text; }).join(' | ')
      + ' / ' + shortClue.problems.join(' | '));
  // ⚠️ 这一格的夹具**必须自带两处合法承诺**（两个不同文件）：hygiene 那一格（⑨）要求"至少 2 个文件点名"，
  //   只放一处就会被 hygiene 顶红，于是"认不出单独占一格"这条判据读起来永远带一条与它无关的红（§5「注入越界」同族）。
  var unknownShape = run({ 'README.md': '等廿一小时重新起账。\n', 'HANDOVER.md': '六小时重新起账。\n',
    'release-notes-preview.md': '同一门六小时内只进一次。\n' });
  record('⑧认不出的中文写法（「廿一」）单独占一格并印出来 —— 既不猜成数字，也不当成没有，且不替它编出一条红项',
    unknownShape.unknown.length === 1 && /廿一/.test(unknownShape.unknown[0].text)
      && unknownShape.claims.length === 2 && unknownShape.claims.every(function (c) { return c.value === 6; })
      && unknownShape.problems.length === 0 && unknownShape.ok,
    'unknown=' + unknownShape.unknown.length + ' claims=' + unknownShape.claims.length
      + ' 红=' + unknownShape.problems.length + ' / ' + unknownShape.stats[2]);
  var empty = run({ 'README.md': '这里不提窗口。\n', 'HANDOVER.md': '这里也不提。\n' });
  record('⑨一处都扫不到要红（防正则失效，不许打印全绿）',
    !empty.ok && empty.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    empty.problems.join(' | '));
  var noHours = run(cleanFixture(), 0);
  record('⑩代码侧没读到数字要红（不许当成没东西要核）',
    !noHours.ok && noHours.problems.some(function (p) { return /没读到/.test(p); }),
    noHours.problems.join(' | '));
  record('⑪跨族阴性：更新检查「手动 6 小时一次、自动 24 小时一次」不许被抓（说明书真句子，靠 `<` 出界）',
    clean.claims.every(function (c) { return c.value !== 24; })
      && clean.claims.filter(function (c) { return c.file === 'docs/manual.html'; }).length === 2,
    clean.claims.filter(function (c) { return c.file === 'docs/manual.html'; })
      .map(function (c) { return c.line + '「' + c.text + '」'; }).join(' | '));
  record('⑫跨族阴性：「24 小时跳过名单」「一轮最多问 40 门」「最多 30 门」三族都不许进来（README 真句子）',
    clean.claims.filter(function (c) { return c.file === 'README.md'; }).length === 1,
    clean.claims.filter(function (c) { return c.file === 'README.md'; })
      .map(function (c) { return c.line + '「' + c.text + '」'; }).join(' | '));
  record('⑬跨族阴性：AGENTS 那句「TTL（6 小时）到点允许再问一枚」与「跨 30 分钟…重新起账」都不许报红',
    clean.claims.filter(function (c) { return c.file === 'AGENTS.md'; }).length === 0 && clean.ok,
    clean.claims.filter(function (c) { return c.file === 'AGENTS.md'; })
      .map(function (c) { return c.line + '「' + c.text + '」'; }).join(' | ') + ' / ' + clean.problems.join(' | '));
  record('⑭跨族阴性：「每小时提醒一次」「停半小时」这种非数字量词不许被读成承诺',
    clean.claims.every(function (c) { return !/^每|^半/.test(c.value); })
      && clean.claims.filter(function (c) { return c.file === 'docs/manual.html'; })
        .every(function (c) { return c.value === 6; }),
    clean.claims.filter(function (c) { return c.file === 'docs/manual.html'; })
      .map(function (c) { return c.line + '=' + c.value; }).join(' | '));
  record('⑮倒装那一句只计一次（「六小时之后重新起账，同一门六小时内只进一次」= 2 处，不是 3 处）',
    clean.claims.filter(function (c) { return c.file === 'release-notes-1.3.0.md'; }).length === 2,
    clean.claims.filter(function (c) { return c.file === 'release-notes-1.3.0.md'; })
      .map(function (c) { return c.line + '「' + c.text + '」'; }).join(' | '));
  var onlyHidden = run({
    'README.md': '正文一句都不提。\n',
    'docs/manual.html': '<p>正文不提。</p>\n<!-- 六小时重新起账 -->\n<script>var y="六小时起账";</script>\n'
  });
  record('⑯只在注释与 script 里提，要红而不是全绿（掩码这一手在承重）',
    !onlyHidden.ok && onlyHidden.problems.some(function (p) { return /只在 0 个文件/.test(p); }),
    onlyHidden.problems.join(' | '));
  var e1 = throws(function () { hoursFromText('  if (Date.now() - Number(ledger.at || 0) > 21600000) { x = 1; }'); });
  record('⑰真源被写成裸毫秒（21600000）要抛，且点名是哪一行',
    !!e1 && /裸毫秒/.test(e1), String(e1));
  var e2 = throws(function () {
    hoursFromText('a\nif (Number(ledger.at || 0) > 6 * 3600 * 1000) { }\nif (Number(ledger.at || 0) > 8 * 3600 * 1000) { }');
  });
  record('⑱代码里认出两处窗口要抛并点名两行（两处数字没法对用户只说一个）',
    !!e2 && /2 处/.test(e2) && /第 2 \/ 3 行/.test(e2), String(e2));
  var e3 = throws(function () { hoursFromText('var x = 1;\n// 没有任何窗口'); });
  record('⑲真源那一行读不到要抛（不许把"改名了"读成"没有承诺"）',
    !!e3 && /找不到/.test(e3), String(e3));
  var e4 = throws(function () {
    assertRuntimeSentenceTether('if (Number(ledger.at || 0) > 8 * 3600 * 1000) { }\n要么等六小时换课名单重新起账再试', 8);
  });
  record('⑳代码里那句原话说「六小时」而常量是 8 要抛（现场日志会对用户报假窗口）',
    !!e4 && /假窗口/.test(e4), String(e4));
  var e5 = throws(function () { assertRuntimeSentenceTether('if (Number(ledger.at || 0) > 6 * 3600 * 1000) { }', 6); });
  record('㉑代码里那句原话整句被改写要抛并说清"这一族没了出处"',
    !!e5 && /读不到/.test(e5), String(e5));
  var okTether = throws(function () {
    assertRuntimeSentenceTether('if (Number(ledger.at || 0) > 6 * 3600 * 1000) { }\n要么等六小时换课名单重新起账再试', 6);
  });
  record('㉒接线自证：同一句话、同一个数，不抛（否则⑳㉑两格是恒红的尺）', okTether === null, String(okTether));

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
  var hours = null, readErr = null, docs = {};
  try {
    hours = recountFromSource().hours;
  } catch (e) {
    readErr = (e && e.message) || String(e);
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p);
  });
  var r = auditFiles({ docs: docs, hours: hours });
  var missing = DOCS.filter(function (f) { return !docs[f]; });
  if (missing.length) r.problems.push('该扫的页面读不到：' + missing.join(' / ') + '（读不到不许当"没问题"）');
  if (readErr) r.problems.unshift('读代码真源就失败：' + readErr);
  if (r.problems.length) r.ok = false;
  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      ok: r.ok, hours: hours, source: SOURCE,
      claims: r.claims.map(function (c) { return c.file + ':' + c.line + ' ' + c.text; }),
      unknown: r.unknown.map(function (u) { return u.file + ':' + u.line + ' ' + u.text; }),
      problems: r.problems
    }, null, 2));
  } else {
    r.claims.forEach(function (c) {
      console.log('  命中 ' + c.file + ':' + c.line + ' 「' + c.text + '」→ ' + c.value + ' 小时');
    });
    r.stats.forEach(function (s) { console.log('  ' + s); });
    if (r.ok) {
      console.log('✓ 换课起账窗口对账通过：代码 ' + hours + ' 小时，文档 ' + r.claims.length
        + ' 处逐个对上（CHANGELOG 按史实不扫）');
    } else {
      r.problems.forEach(function (p) { console.log('✗ ' + p); });
    }
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  NAME: '换课起账窗口文档对账',
  DOCS: DOCS,
  SOURCE: SOURCE,
  CLEAN_HOURS: CLEAN_HOURS,
  cnToInt: cnToInt,
  hoursFromText: hoursFromText,
  assertRuntimeSentenceTether: assertRuntimeSentenceTether,
  recountFromSource: recountFromSource,
  maskInvisible: maskInvisible,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  mutate: mutate
};
