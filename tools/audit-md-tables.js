/**
 * Markdown 表格列数审计 —— `npm run check` 第 25 项的机检实现（批次 53）。
 *
 * 为什么要有这条：**GitHub 渲染表格时，代码片段里的竖线不转义就会把一行切成多余的格**
 * —— 整行向右溢、多出来的那几格变成新列，读起来是断的。2026-11-14 抓到 4 行：
 * `README.md` §6 的 #52（`preferredDoc || 题目那份文档` 写在反引号里），`HANDOVER.md` §9
 * 三行（`"历史|||人民"`、`"loading-text"|"blank-frame…"`、`` `insertcard|` ``）。
 * 其中 `HANDOVER.md` 那一行还是**两条被并成一条**（少了换行，后半条的「项」格整个不见了）——
 * 竖线计数顺带能抓到这种"看着像多了一格"的损坏。
 *
 * 这类损坏**不会让任何测试变红**，只在网页上看得见，而那一页是用户与接手的人第一眼读的东西。
 *
 *   node tools/audit-md-tables.js            # 先自证（六格对照），再扫全部跟踪中的 .md
 *   node tools/audit-md-tables.js --json     # 机器可读，给 check.js 的失败信息用
 *
 * ⚠️ **只数「没被反斜杠转义的竖线」，并且跳过 ``` 围栏代码块。**
 * 反引号里 `\|` 才算字面竖线，GitHub 也一样处理；不转义就是列分隔符。
 * 围栏里的东西是给人看的代码，不是表格 —— 本项目 README 里有大量 ASCII 流程图与
 * `|` 开头的示例，不跳过就会一片假红。**会误报的守卫和没有守卫一样害人**（批次 48 的教训），
 * 所以本文件自带六格对照，`check.js` 那一项按 pin 逐格复算：把 pin 改小不能把闸蒙过去。
 *
 * ⚠️ **口径比 GFM 窄，是有意的**：GFM 也认「不以竖线开头的表头行」（只要下一行是分隔行），
 * 这种写法本审计**不报**。放宽到那一步就会把 README 里的 ASCII 图与正文里的竖线成片报红，
 * 而假红的代价不是多一行输出，是人开始忽略这条守卫。**宁窄勿宽**：
 * 本审计覆盖的是本项目公开文档实际在用的那一种表格写法。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');

/** 这一行里「算分隔符」的竖线有几根：连续奇数个反斜杠紧跟的竖线是转义，不算。 */
function countCells(row) {
  var n = 1;
  for (var i = 0; i < row.length; i++) {
    if (row.charAt(i) !== '|') continue;
    var bs = 0;
    for (var j = i - 1; j >= 0 && row.charAt(j) === '\\'; j--) bs++;
    if (bs % 2 === 1) continue;
    n++;
  }
  return n;
}

/** 第二行必须长成像 `| --- | --- |` 的分隔行，否则这一组不当表格看（防假红）。 */
function isSeparator(line) {
  return /^\s*\|[\s:|-]+\|\s*$/.test(String(line)) && line.indexOf('-') >= 0;
}

/**
 * 扫一份 markdown 文本，返回「列数和表头不一致」的行说明（带**这份文本里的**行号）。
 * @param {string} text
 */
function scanText(text) {
  var lines = String(text).split(/\r?\n/);
  var out = [];
  var fence = null;
  var i = 0;
  while (i < lines.length) {
    var fm = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fm) {
      var mark = fm[1].charAt(0);
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      i++;
      continue;
    }
    if (fence) { i++; continue; }
    if (!/^\s*\|/.test(lines[i])) { i++; continue; }

    var start = i;
    var rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
    if (rows.length < 2 || !isSeparator(rows[1])) continue;
    var head = countCells(rows[0]);
    rows.forEach(function (r, k) {
      var n = countCells(r);
      if (n === head) return;
      out.push({
        line: start + k + 1,
        cells: n,
        headCells: head,
        headLine: start + 1,
        text: r.trim().slice(0, 70)
      });
    });
  }
  return out;
}

/**
 * 六格对照：三格必须报、三格必须不报。任一不符就整项作废。
 * `want` 是**期望的问题条数**，不是实际值 —— 改动扫描逻辑时这里会先响。
 */
var SELF_TEST = [
  { name: '干净三列表 → 不报', want: 0,
    text: '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n' },
  { name: '格里有未转义竖线 → 要报', want: 1,
    text: '| a | b | c |\n| --- | --- | --- |\n| 1 | `x || y` | 3 |\n' },
  { name: '同一处写成转义 → 不报', want: 0,
    text: '| a | b | c |\n| --- | --- | --- |\n| 1 | `x \\|\\| y` | 3 |\n' },
  { name: '围栏代码块里的表样行 → 不报', want: 0,
    text: '```md\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n' },
  { name: '正文以竖线开头但没有分隔行 → 不报', want: 0,
    text: '| 这不是表格\n| 这一行也不是\n' },
  { name: '两列表被写成三列 → 要报', want: 1,
    text: '| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n' }
];

/** 跑六格对照，返回不合格的那些（空数组 = 自证通过）。 */
function selfCheck() {
  return SELF_TEST.filter(function (t) {
    return scanText(t.text).length !== t.want;
  }).map(function (t) {
    return t.name + '（实际 ' + scanText(t.text).length + ' 条，期望 ' + t.want + ' 条）';
  });
}

/** 仓库里要扫的那批 .md（排除 `legacy/` 与 `node_modules/`）。git 不可用时回退到目录走查。 */
function markdownFiles() {
  var r = cp.spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
  if (r.status === 0) {
    return r.stdout.toString('utf8').split('\0').filter(Boolean).filter(function (f) {
      return /\.md$/i.test(f) && f.indexOf('legacy/') !== 0 && f.indexOf('node_modules/') !== 0;
    });
  }
  var out = [];
  (function walk(dir) {
    fs.readdirSync(dir).forEach(function (name) {
      if (name === 'node_modules' || name === '.git' || name === 'legacy' || name === 'dist' ||
          name === '.workbuddy' || name === '.debug-profile') return;
      var full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.md$/i.test(name)) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    });
  })(ROOT);
  return out;
}

/** 全量扫描。返回 {files, problems:[{file,line,cells,headCells,headLine,text}], selfFails} */
function scanAll() {
  var selfFails = selfCheck();
  var files = markdownFiles();
  var problems = [];
  var scanned = 0;
  files.forEach(function (f) {
    var text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
    scanned++;
    scanText(text).forEach(function (p) {
      p.file = f;
      problems.push(p);
    });
  });
  return { files: scanned, total: files.length, problems: problems, selfFails: selfFails };
}

function summarize(r) {
  return r.problems.map(function (p) {
    return p.file + ':' + p.line + ' —— ' + p.cells + ' 格，表头（' + p.headLine + ' 行）是 ' +
      p.headCells + ' 格：' + p.text;
  });
}

module.exports = {
  ROOT: ROOT,
  SELF_TEST: SELF_TEST,
  countCells: countCells,
  scanText: scanText,
  selfCheck: selfCheck,
  markdownFiles: markdownFiles,
  scanAll: scanAll,
  summarize: summarize
};

if (require.main === module) {
  var asJson = process.argv.indexOf('--json') >= 0;
  var res = scanAll();
  console.log('文档表格审计 —— 扫了 ' + res.files + ' 份 .md（清单共 ' + res.total + ' 份）');
  if (res.selfFails.length) {
    console.log('');
    console.log('❌ 六格对照没过，上面与下面的计数都不可信：');
    res.selfFails.forEach(function (x) { console.log('   ' + x); });
    process.exit(2);
  }
  console.log('  ✅ 六格对照全过（未转义竖线要报、转义与围栏代码块不报、无分隔行的正文不报）');
  if (asJson) {
    console.log(JSON.stringify({ files: res.files, problems: summarize(res) }, null, 2));
  } else if (res.problems.length) {
    console.log('');
    console.log('⚠️ ' + res.problems.length + ' 行的列数和表头不一致（GitHub 会把整行渲染成溢出的多列）：');
    summarize(res).forEach(function (x) { console.log('   ' + x); });
    console.log('');
    console.log('   改法：把那一格里的竖线写成 `\\|`；若是两条被并成了一条，补回换行。');
    process.exit(1);
  } else {
    console.log('  ✅ 全部表格每行的列数都与表头一致');
  }
  process.exit(0);
}
