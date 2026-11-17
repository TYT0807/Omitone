#!/usr/bin/env node
/* audit-switch-budget.js —— 核「一轮连续刷课最多换几门」这个数字，文档与代码是不是同一个。
 *
 * 为什么要这一条（2026-11-17，批次 93 收尾自查）：
 *   批次 85 把 `_COURSE_SWITCH_LIMIT` 由 8 提到 30，批次 86 又把预算改成
 *   `Math.max(_COURSE_SWITCH_LIMIT, 用户中心里能进的课数)`。**代码改了，用户看的那几页没跟着改**：
 *   `release-notes-1.3.0.md` 一直写到收尾当天仍是「一次连续刷课最多换 8 门」，
 *   `docs/manual.html` 日志对照表里那句「换课到上限」也还按 8 门解释，
 *   而且这一族还连带着「卡片上没写进度的课一律不盲进」这条已被批次 85 推翻的旧保险。
 *   这类过期**一条测试都不会红** —— 判据、日志、沙盒全绿，只有用户照 Release 页
 *   那一行去理解现场（「才换 8 门就停，是不是坏了」）时被引到错方向。
 *
 * 判据口径（**故意只做两件事**，放宽就会误报）：
 *   ① 真源只认代码里的 `_COURSE_SWITCH_LIMIT`：从 `src/page/64-tasks-loop.js` 读那**一行**，
 *      读不到 / 认出多处 / 不是正整数一律**报错**，不许当成"没东西要核"（§7 那条老教训）。
 *   ② 文档里凡是「最多 / 最少 / 上限 / 预算 …N 门」这一族句子，N 必须等于 ①。
 *      围栏代码块、HTML 注释、`<script>` / `<style>` 里的**不算**（用户看不见，那是给机器的）。
 *   另加一条**卫生检查**：整套文档至少要落在**两个不同文件**上有这句话 ——
 *   正则被改坏、或那一族句式被整体换掉时，扫描会静默变成 0 条命中并打印"通过"，
 *   那是最坏的一种绿（同 §5「不会失败的检查等于没有检查」）。
 *
 * 不核什么：
 *   - **`CHANGELOG.md` 不扫**。历史条目写的是**当时**的数（批次 85 那条就得写"由 8 提到 30"），
 *     回改会把史实抹掉 —— 口径同 `tools/check.js` 里 `checkTestCounts()` 的 `liveOnly()`。
 *   - **`Math.max(N, …)` 那个 N 不扫**，它是代码的转述、不是对用户承诺的数字；扫它会逼着
 *     维护文档用正则的措辞写句子。
 *   - 预算**怎么算**（取大值、按课数）属行为，不在数字对账这一格。
 *
 * 用法：
 *   node tools/audit-switch-budget.js            # 核真文档，有问题退出 1
 *   node tools/audit-switch-budget.js --json     # 同上，机器可读
 *   node tools/audit-switch-budget.js --selftest # 八格自证，不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SOURCE = 'src/page/64-tasks-loop.js';
// 用户看得见的那几页 + 交接文档；CHANGELOG 故意不在这里（见头注）
var DOCS = ['README.md', 'AGENTS.md', 'HANDOVER.md', 'release-notes-1.3.0.md', 'docs/manual.html'];

// 「最多 30 门」「最少 30 门」「上限 30 门」「预算 30 门」「换课上限 30 门」
// _lead 与数字之间允许少量非数字（ markdown 加粗、中文连接词 ），但不许跨行
var LEAD = '(?:最多|最少|至多|上限|预算)';
var CLAIM_RE = new RegExp(LEAD + '[^0-9<>\\n]{0,12}?([0-9]{1,3})\\s*门', 'g');

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** 从代码里读回那个真源数字；读不出来就抛，绝不返回 0 让闸以为"没东西要核"。 */
function limitFromSource(root) {
  var base = root || ROOT;
  var p = path.join(base, SOURCE);
  if (!fs.existsSync(p)) throw new Error('找不到换课上限的真源文件：' + SOURCE);
  var lines = readText(p).split(/\r?\n/);
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    var m = /^[ \t]*_COURSE_SWITCH_LIMIT[ \t]*:[ \t]*([0-9]+)[ \t]*,?[ \t]*(\/\/.*)?$/.exec(lines[i]);
    if (m) hits.push({ no: i + 1, value: parseInt(m[1], 10) });
  }
  if (hits.length === 0) throw new Error(SOURCE + ' 里找不到 `_COURSE_SWITCH_LIMIT: <整数>,` 这一行（常量被改名或换形状了？）');
  if (hits.length > 1) {
    throw new Error(SOURCE + ' 里认出 ' + hits.length + ' 处 `_COURSE_SWITCH_LIMIT:`（第 '
      + hits.map(function (h) { return h.no; }).join(' / ') + ' 行）—— 两处数字没法对用户只说一个');
  }
  if (!(hits[0].value > 0)) throw new Error(SOURCE + ':' + hits[0].no + ' 的取值不是正整数');
  return hits[0].value;
}

function blankOut(s) {
  return s.replace(/[^\n]/g, ' ');
}

/** 剥掉"用户看不见"的那一片，但保持行数与列位置不变（报行号要对得上原文）。 */
function maskInvisible(text, isHtml) {
  var body = String(text == null ? '' : text);
  if (isHtml) {
    // 整段挖空，含跨行与单行内联两种形状（`<script>var x='…'</script>` 在一行上很常见）
    body = body.replace(/<script\b[\s\S]*?<\/script>/gi, blankOut);
    body = body.replace(/<style\b[\s\S]*?<\/style>/gi, blankOut);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, blankOut);
  // 围栏代码块：逐行记状态，整块挖空
  var lines = body.split(/\r?\n/);
  var inFence = false;
  for (var i = 0; i < lines.length; i++) {
    if (/^[ \t]*```/.test(lines[i])) {
      inFence = !inFence;
      lines[i] = blankOut(lines[i]);
      continue;
    }
    if (inFence) lines[i] = blankOut(lines[i]);
  }
  return lines.join('\n');
}

/**
 * 对账。
 * @param {Object} opts { docs: {相对路径: 文本}, limit: 代码里的数字 }
 * @returns {{ ok:boolean, problems:string[], stats:string[], claims:Array }}
 */
function auditFiles(opts) {
  var docs = (opts && opts.docs) || {};
  var limit = opts && opts.limit;
  var problems = [];
  var claims = [];
  if (!(Number(limit) > 0)) problems.push('代码侧的换课上限没读到（limit=' + limit + '），这一轮没东西可对账');
  var filesWithClaim = {};
  Object.keys(docs).sort().forEach(function (file) {
    // 掩码在审计内部做：调用方交原文，注入打在注释／脚本里就不该算命中
    var lines = maskInvisible(docs[file], /\.html$/i.test(file)).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      CLAIM_RE.lastIndex = 0;
      var m;
      while ((m = CLAIM_RE.exec(lines[i])) !== null) {
        var n = parseInt(m[1], 10);
        claims.push({ file: file, line: i + 1, text: m[0], value: n });
        filesWithClaim[file] = (filesWithClaim[file] || 0) + 1;
        if (Number(limit) > 0 && n !== Number(limit)) {
          problems.push(file + ':' + (i + 1) + ' 说「' + m[0] + '」，而代码里的 `_COURSE_SWITCH_LIMIT` 是 '
            + limit + ' —— 对用户承诺的那个数与真源不一致');
        }
      }
    }
  });
  var distinct = Object.keys(filesWithClaim).length;
  if (distinct < 2) {
    problems.push('整套文档只在 ' + distinct + ' 个文件里点名了换课上限（判据：至少 2 个）'
      + ' —— 多半是那一句的措辞被整体改写、正则已经一条扫不到，而不是真的没人提这个数字');
  }
  var stats = [
    '代码真源 _COURSE_SWITCH_LIMIT = ' + limit,
    '文档命中 ' + claims.length + ' 处（' + distinct + ' 个文件：'
      + Object.keys(filesWithClaim).map(function (f) { return f + '×' + filesWithClaim[f]; }).join(' / ') + '）'
  ];
  return { ok: problems.length === 0, problems: problems, stats: stats, claims: claims };
}

/** 干净夹具：每份文档都写对，且覆盖围栏代码块 / HTML 注释两个"不许算"的形状。 */
function cleanFixture() {
  return {
    'README.md': [
      '# 说明',
      '',
      '- 连续换课**最多 30 门**、六小时重新起账。',
      '',
      '```',
      '这一句写在围栏里，用户看不见：最多 8 门',
      '```',
      ''
    ].join('\n'),
    'AGENTS.md': '# 守则\n\n这里不提门数。\n',
    'HANDOVER.md': '三道账：一轮换课预算**最少 30 门**（取用户中心课数的较大值）。\n',
    'release-notes-1.3.0.md': '- 一轮连续刷课**最多换几门按你用户中心里能进的课来给，最少 30 门**。\n',
    'docs/manual.html': [
      '<html><body>',
      '<p>一轮连续刷课<b>最少 30 门</b>。</p>',
      '<!-- 注释里这句不算：最少 8 门 -->',
      '<script>var x = "最少 5 门";</script>',
      '</body></html>'
    ].join('\n')
  };
}

/** 在夹具里把 `from` 换成 `to`（只换第一次出现），供反向验证用。 */
function mutate(files, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) { out[k] = files[k]; });
  Object.keys(out).forEach(function (k) {
    if (out[k].indexOf(from) >= 0) out[k] = out[k].replace(from, to);
  });
  return out;
}

function main() {
  var argv = process.argv.slice(2);
  var asJson = argv.indexOf('--json') >= 0;
  if (argv.indexOf('--selftest') >= 0) {
    process.exitCode = runSelfTest() ? 0 : 2;
    return;
  }
  var limit, docs = {};
  var readErr = null;
  try {
    limit = limitFromSource();
  } catch (e) {
    readErr = e.message;
  }
  DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = readText(p);
  });
  var r = auditFiles({ docs: docs, limit: limit });
  if (readErr) {
    r.problems.unshift('读代码真源就失败：' + readErr);
    r.ok = false;
  }
  if (asJson) {
    console.log(JSON.stringify({
      ok: r.ok, limit: limit, claims: r.claims.map(function (c) {
        return c.file + ':' + c.line + ' ' + c.text;
      }),
      problems: r.problems
    }, null, 2));
  } else {
    (r.claims || []).forEach(function (c) {
      console.log('  命中 ' + c.file + ':' + c.line + ' 「' + c.text + '」→ ' + c.value + ' 门');
    });
    r.stats.forEach(function (s) { console.log('  ' + s); });
    if (r.ok) console.log('✓ 换课上限对账通过：代码 ' + limit + ' 门，文档 ' + r.claims.length + ' 处逐个相等（CHANGELOG 按史实不扫）');
    else r.problems.forEach(function (p) { console.log('✗ ' + p); });
  }
  process.exitCode = r.ok ? 0 : 1;
}

function runSelfTest() {
  var LIMIT = 30;
  var cases = [];
  var okAll = true;
  function record(label, cond, detail) {
    cases.push({ label: label, pass: !!cond, detail: detail || '' });
    if (!cond) okAll = false;
  }
  function auditClone(mutator) {
    var docs = cleanFixture();
    if (mutator) docs = mutator(docs);
    return auditFiles({ docs: docs, limit: LIMIT });
  }
  var clean = auditClone(null);
  record('干净夹具 0 条', clean.ok && clean.claims.length === 4, clean.problems.join(' | ') + ' / n=' + clean.claims.length);
  record('围栏代码块里的「最多 8 门」不算命中', clean.claims.every(function (c) { return c.value === 30; }));
  record('HTML 注释里的「最少 8 门」不算命中', clean.claims.every(function (c) { return c.file !== 'docs/manual.html' || c.value === 30; }));
  var stale = auditClone(function (d) { return mutate(d, '最少 30 门', '最少 8 门'); });
  record('文档写 8 门要红', !stale.ok && stale.problems.length === 3, stale.problems.join(' | '));
  var upper = auditClone(function (d) { return mutate(d, '最多 30 门', '最多 8 门'); });
  record('README 写 8 门要红', !upper.ok && upper.problems.some(function (p) { return /README\.md/.test(p); }), upper.problems.join(' | '));
  var noClaim = { 'README.md': '这里不提门数。\n', 'HANDOVER.md': '这里也不提。\n' };
  var empty = auditFiles({ docs: noClaim, limit: LIMIT });
  record('一处都扫不到要红（防正则失效）', !empty.ok && empty.problems.some(function (p) { return /只在 0 个文件/.test(p); }), empty.problems.join(' | '));
  var noLimit = auditFiles({ docs: cleanFixture(), limit: 0 });
  record('代码侧没读到数字要红（不许当成没东西要核）', !noLimit.ok, noLimit.problems.join(' | '));
  var inComment = auditFiles({
    docs: { 'README.md': 'A\n', 'docs/manual.html': '<p>最少 30 门</p>\n<p>最少 30 门</p>\n<!-- 最少 30 门 -->\n' },
    limit: LIMIT
  });
  record('HTML 注释里补一句不会把"至少 2 个文件"这条糊过去', !inComment.ok, inComment.problems.join(' | '));
  cases.forEach(function (c) { console.log((c.pass ? '✓ ' : '✗ ') + c.label + (c.detail && !c.pass ? ' —— ' + c.detail : '')); });
  console.log(okAll ? '自证通过（共 ' + cases.length + ' 格）' : '自证失败');
  return okAll;
}

if (require.main === module) main();

module.exports = {
  NAME: '换课上限文档对账',
  DOCS: DOCS,
  SOURCE: SOURCE,
  limitFromSource: limitFromSource,
  maskInvisible: maskInvisible,
  audit: auditFiles,
  auditFiles: auditFiles,
  cleanFixture: cleanFixture,
  mutate: mutate
};
