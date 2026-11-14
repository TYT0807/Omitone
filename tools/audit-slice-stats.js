#!/usr/bin/env node
/* audit-slice-stats.js —— 核 `src/page/README.md` 里「*N 行 / M 方法*」那批快照数字。
 *
 * 为什么要这一条（2026-11-14，批次 55-A）：
 *   那份 README 是每个域「几行、几个方法」的唯一人读入口，而它**逐字抄**片段头部与文件本身。
 *   实测 16 段里 **16 段全过期**（最远的 `50-captcha.js` 写 478 行 / 14 方法，实际 1008 行 / 27 方法 ——
 *   差出一倍），合计句写的「423 个 app 方法」实际已是 446。
 *   这条过期**一条测试都不会红**：片段头部由 `npm run check` 第 15 项核着（所以头部是对的），
 *   而 README 抄的是旧值 —— 于是「有错地图比没地图更糟」（AGENTS §3 第 4 条）在地图的底稿上重演一遍：
 *   读的人照着「478 行」去找代码，翻到的却是两倍大的文件，还以为文档在骗他。
 *
 * 判据口径（**故意只做三件事**，放宽就会误报）：
 *   ① 每个 `### \`NN-xxx.js\`` 标题后面**紧跟**的那一行 `*…*` 必须是可识别的形状，
 *      并且数字与文件实际一致；形状不认识就报（不许静默跳过 —— 静默跳过 = 这条闸没了）。
 *   ② 片段目录里真实存在的 16 个文件，README 必须**一个不漏、一个不多**地各出现一次。
 *   ③ 合计句「14 个域片段合计 **N 个 app 方法**，加上 … = **M 个方法**；状态字段 **K** 个」
 *      三个数按实际复算（少了这句也报）。
 *   状态字段那一格：**只有片段头部自己声明了才要求 README 写**（`00` / `65` 那种
 *   「4 空格缩进配置项」造成的假字段数，第 15 项不核，这里也不逼文档写）。
 *
 * 用法：
 *   node tools/audit-slice-stats.js            # 核真文档，有问题退出 1
 *   node tools/audit-slice-stats.js --json     # 同上，机器可读
 *   node tools/audit-slice-stats.js --selftest # 十格自证，不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PARTS_DIR = path.join(ROOT, 'src', 'page');
var README = path.join('src', 'page', 'README.md');
var HEADER_END = '// @omitone-part-header-end';
var DOMAIN_COUNT = 14;   // 10..80 那 14 个域片段（00 是外壳、90 是收尾 + 手动入口）

/* ---------------------------------------------------------------- 真值 */

/** 逐片段算出「实际行数 / app 方法数 / app 状态字段数」，与 check.js 第 15 项同一把尺。 */
function sliceStats(dir) {
  var files = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).sort();
  return files.map(function (file) {
    var txt = fs.readFileSync(path.join(dir, file), 'utf8');
    var lines = txt.split(/\r?\n/);
    var markerAt = lines.indexOf(HEADER_END);
    var body = markerAt === -1 ? [] : lines.slice(markerAt + 1);
    var inApp = markerAt !== -1 && !/^\s*\};/.test(body[0] || '');
    var methods = [];
    var fields = [];
    body.forEach(function (l) {
      if (/^  var app = \{/.test(l)) { inApp = true; return; }
      if (/^  \};/.test(l)) { inApp = false; return; }
      if (!inApp) return;
      var m = l.match(/^ {4}([A-Za-z_$][\w$]*)\s*:\s*(.*)$/);
      if (!m) return;
      if (/^(?:async\s+)?function\b/.test(m[2].trim())) methods.push(m[1]);
      else fields.push(m[1]);
    });
    // `wc -l` 数的是换行符，不是"行数 + 1" —— 文档里那句 `wc -l src/page/*.js` 是尺，
    // 这里必须跟它同，否则"按文档教的命令自己量一遍"就会跟闸打架。
    return {
      file: file,
      lines: (txt.match(/\n/g) || []).length,
      methods: methods.length,
      fields: fields.length,
      declaresFields: headerDeclaresFields(txt),
      xxtAI: countXxtAI(txt)
    };
  });
}

/** 片段头部有没有写「本段的状态字段（N 个）」—— 写了才算真值，没写就不逼文档报数。 */
function headerDeclaresFields(txt) {
  return /本段的状态字段（\d+ 个）：/.test(txt);
}

/** `window.xxtAI = { … }` 里那几个手动入口（只 `90-` 有）。 */
function countXxtAI(txt) {
  var at = txt.indexOf('window.xxtAI = {');
  if (at === -1) return 0;
  var tail = txt.slice(at).split(/\r?\n/);
  var n = 0;
  for (var i = 1; i < tail.length; i++) {
    if (/^  \};/.test(tail[i])) break;
    if (/^ {4}[A-Za-z_$][\w$]*\s*:\s*(?:async\s+)?function\b/.test(tail[i])) n++;
  }
  return n;
}

/* ---------------------------------------------------------------- 文档 */

/**
 * 从 README 里取出「标题 → 快照行」的对照表。
 * 跳过围栏代码块：``` 里出现的 `###` 或 `*…*` 是示例，不是声明（批次 53 的同一课）。
 */
function parseReadme(txt) {
  var lines = txt.split(/\r?\n/);
  var out = [];
  var fence = false;
  var pendingFile = null;
  var pendingLine = 0;
  lines.forEach(function (l, i) {
    if (/^\s*```/.test(l)) { fence = !fence; pendingFile = null; return; }
    if (fence) return;
    var h = l.match(/^### `([^`]+\.js)`\s*$/);
    if (h) { pendingFile = h[1]; pendingLine = i + 1; return; }
    if (!pendingFile) return;
    if (!l.trim()) return;                       // 标题与快照行之间允许空行
    var s = l.match(/^\*([^*]*)\*$/);
    if (!s) { pendingFile = null; return; }
    out.push({ file: pendingFile, raw: s[1], line: pendingLine + 1 });
    pendingFile = null;
  });
  return out;
}

/** `*743 行 / 4 方法 + 162 状态字段*` → `{lines,methods,fields}`；认不出来返回 null。 */
function parseStat(raw) {
  var m = raw.match(/^(\d+) 行(?: \/ (\d+) 方法)?(?: \+ (\d+) 状态字段)?$/);
  if (!m) return null;
  return {
    lines: Number(m[1]),
    methods: m[2] === undefined ? null : Number(m[2]),
    fields: m[3] === undefined ? null : Number(m[3])
  };
}

/** 合计句：三个数都得从文档里读得出来，读不出来就报（不许因为"句子被改写了"而静默放行）。 */
function parseTotals(txt) {
  var re = /(\d+) 个域片段合计 \*\*(\d+) 个 app 方法\*\*[^]*?= (\d+) 个方法；状态字段 (\d+) 个/;
  var m = txt.match(re);
  if (!m) return null;
  return { domain: Number(m[1]), appMethods: Number(m[2]), totalMethods: Number(m[3]), fields: Number(m[4]) };
}

/* ---------------------------------------------------------------- 比对 */

function audit(stats, readmeTxt) {
  var byFile = {};
  stats.forEach(function (s) { byFile[s.file] = s; });
  var issues = [];
  var entries = parseReadme(readmeTxt);
  var seen = {};

  entries.forEach(function (e) {
    seen[e.file] = true;
    var st = byFile[e.file];
    if (!st) { issues.push(e.file + '：README 写了这一段的快照，但 src/page/ 里没有这个文件'); return; }
    var want = st.lines + ' 行' +
      (st.methods ? ' / ' + st.methods + ' 方法' : (st.methods === 0 && st.fields === 0 ? '' : '')) +
      (st.declaresFields ? ' + ' + st.fields + ' 状态字段' : '');
    var got = parseStat(e.raw);
    if (!got) {
      issues.push(e.file + '：快照行 `*' + e.raw + '*` 形状不认识（应为 `*' + want + '*`）' +
        ' —— 认不出来就报，不许静默跳过');
      return;
    }
    if (got.lines !== st.lines) issues.push(e.file + '：行数写 ' + got.lines + '，实际 ' + st.lines);
    var stateMethod = st.methods;
    if (got.methods === null) {
      if (stateMethod > 0) issues.push(e.file + '：实际有 ' + stateMethod + ' 个 app 方法，快照却没写方法数');
    } else if (got.methods !== stateMethod) {
      issues.push(e.file + '：方法数写 ' + got.methods + '，实际 ' + stateMethod);
    }
    if (st.declaresFields) {
      if (got.fields === null) issues.push(e.file + '：头部声明了 ' + st.fields + ' 个状态字段，快照却没写');
      else if (got.fields !== st.fields) issues.push(e.file + '：状态字段写 ' + got.fields + '，实际 ' + st.fields);
    } else if (got.fields !== null) {
      issues.push(e.file + '：快照写了状态字段数，但片段头部没声明这份清单（第 15 项不核它，写进来就是抄来的死数字）');
    }
  });

  stats.forEach(function (s) {
    if (!seen[s.file]) issues.push(s.file + '：README 没有这一段的快照行');
  });

  var totals = parseTotals(readmeTxt);
  var domainStats = stats.filter(function (s) { return !/^(00|90)-/.test(s.file); });
  var shellStats = stats.filter(function (s) { return /^(00|90)-/.test(s.file); });
  if (!totals) {
    issues.push('合计句读不出来（应含「' + DOMAIN_COUNT + ' 个域片段合计 **N 个 app 方法** … = M 个方法；状态字段 K 个」）');
  } else {
    var appMethods = domainStats.reduce(function (a, s) { return a + s.methods; }, 0);
    var manual = shellStats.reduce(function (a, s) { return a + s.xxtAI; }, 0);
    var fieldTotal = stats.reduce(function (a, s) { return a + (s.declaresFields ? s.fields : 0); }, 0);
    if (totals.domain !== domainStats.length) {
      issues.push('合计句：域片段数写 ' + totals.domain + '，实际 ' + domainStats.length);
    }
    if (totals.appMethods !== appMethods) {
      issues.push('合计句：app 方法写 ' + totals.appMethods + '，实际各域相加 ' + appMethods);
    }
    if (totals.totalMethods !== appMethods + manual) {
      issues.push('合计句：总方法写 ' + totals.totalMethods + '，实际 ' + appMethods +
        ' + 手动入口 ' + manual + ' = ' + (appMethods + manual));
    }
    if (totals.fields !== fieldTotal) {
      issues.push('合计句：状态字段写 ' + totals.fields + '，实际 ' + fieldTotal);
    }
  }
  return issues;
}

/* ---------------------------------------------------------------- 自证 */

/**
 * 自证格子的**底稿**：干净必须 0 条，其余每格**恰好**红在它要点名的那一段/那一句上，
 * 最后一格是「真 README + 真片段 → 0 条」（现场这一格）。
 * 锚点全部由算出来的实际统计拼出，不写死数字 —— 写死的话片段一变，自证自己就失效。
 * ⚠️ `check.js` 第 26 项另存一份按 pin 索引的期望逐格复算（照抄这里的 want，
 *    就等于把 want 改成实际值即可让闸永远绿 —— 同第 24 / 25 项的规矩）。
 */
function selfTestCases() {
  var stats = sliceStats(PARTS_DIR);
  var real = fs.readFileSync(path.join(ROOT, README), 'utf8');
  var clean = buildCleanReadme(stats);

  function replaceOnce(txt, from, to) {
    var hits = txt.split(from).length - 1;
    if (hits !== 1) throw new Error('自证锚点命中 ' + hits + ' 次（要求恰好 1）: ' + from);
    return txt.replace(from, to);
  }
  function statOf(s) {
    var one = stats.filter(function (x) { return x.file === s.file; })[0];
    var t = one.lines + ' 行' + (one.methods ? ' / ' + one.methods + ' 方法' : '');
    if (one.declaresFields) t += ' + ' + one.fields + ' 状态字段';
    return '*' + t + '*';
  }

  var plain = stats.filter(function (s) { return s.methods > 0 && !s.declaresFields; })[0];
  var withFields = stats.filter(function (s) { return s.declaresFields && s.fields > 0; })[0];
  var appMethods = stats.filter(function (s) { return !/^(00|90)-/.test(s.file); })
    .reduce(function (a, s) { return a + s.methods; }, 0);

  return [
    { pin: '干净快照全部对得上', txt: clean, want: 0, needle: '',
      note: '用实际数字拼一份完整 README —— 必须一条不报（会误报的守卫和没有守卫一样害人）' },
    { pin: '某段行数写错', txt: replaceOnce(clean, statOf(plain),
        statOf(plain).replace(String(plain.lines), String(plain.lines + 1))), want: 1,
      needle: '行数写', note: '某一段行数 +1 → 恰好 1 条，且点名"行数写"' },
    { pin: '某段方法数写少', txt: replaceOnce(clean, statOf(plain),
        statOf(plain).replace(plain.methods + ' 方法', (plain.methods - 1) + ' 方法')), want: 1,
      needle: '方法数写', note: '方法数写少 1 → 1 条"方法数写"' },
    { pin: '凭空加一格没人核的状态字段', txt: replaceOnce(clean, statOf(plain),
        statOf(plain).replace(/\*$/, ' + 7 状态字段*')), want: 1,
      needle: '片段头部没声明这份清单', note: '给**没声明**这份清单的段凭空加一格状态字段 → 要报' +
        '（否则文档里就多出一个没有任何闸核过的数字）' },
    { pin: '状态字段数写错', txt: replaceOnce(clean, statOf(withFields),
        statOf(withFields).replace(withFields.fields + ' 状态字段', (withFields.fields + 9) + ' 状态字段')), want: 1,
      needle: '状态字段写', note: '声明过的状态字段数写错 → 1 条"状态字段写"' },
    { pin: '整段快照被删掉', txt: clean.replace(new RegExp('### `' + plain.file + '`\\n\\n' +
        statOf(plain).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n'), ''), want: 1,
      needle: 'README 没有这一段的快照行', note: '整段标题 + 快照删掉 → 恰好 1 条点名"没有这一段"' },
    { pin: '多写一段不存在的文件', txt: replaceOnce(clean, statOf(plain),
        statOf(plain) + '\n\n### `99-ghost.js`\n\n*10 行 / 1 方法*'), want: 1,
      needle: '但 src/page/ 里没有这个文件', note: '多写一段不存在的文件 → 1 条（不能被"只核存在的"糊过去）' },
    { pin: '快照行形状不认识', txt: replaceOnce(clean, statOf(plain),
        statOf(plain).replace(' / ', ', ')), want: 1,
      needle: '形状不认识', note: '快照行的分隔符改成逗号 → 必须报"形状不认识"，' +
        '**不许静默跳过**（静默跳过等于这条闸没了）' },
    { pin: '合计句的方法总数写错', txt: replaceOnce(clean, '合计 **' + appMethods + ' 个 app 方法**',
        '合计 **9 个 app 方法**'), want: 1,
      needle: '合计句：app 方法写', note: '合计句的方法总数写错 → 1 条点名"合计句"' },
    { pin: '真 README 对真片段', txt: real, want: 0, needle: '',
      note: '真 README + 真片段 → 0 条（现场这一格）' }
  ];
}

function selfTest() {
  var cases = selfTestCases();
  var stats = sliceStats(PARTS_DIR);
  var bad = [];
  cases.forEach(function (c) {
    var issues = audit(stats, c.txt);
    var okCount = issues.length === c.want;
    var okNeedle = !c.needle || issues.some(function (x) { return x.indexOf(c.needle) !== -1; });
    if (!okCount || !okNeedle) {
      bad.push(c.pin + ' 期望 ' + c.want + ' 条并含「' + (c.needle || '无') + '」，实际 ' +
        issues.length + ' 条: ' + JSON.stringify(issues.slice(0, 4)));
    }
    console.log('  [' + (okCount && okNeedle ? 'ok' : 'FAIL') + '] ' + c.pin + ' — ' + c.note);
  });
  if (!withFieldsExist(stats)) bad.push('自证前提不成立：没有任何片段头部声明状态字段清单');
  if (!stats.length) bad.push('自证前提不成立：src/page/ 是空的');
  return bad;
}

function withFieldsExist(stats) {
  return stats.some(function (s) { return s.declaresFields && s.fields > 0; });
}

/** 按真实统计拼一份"应该长这样"的 README（自证 1-8 格的底稿）。 */
function buildCleanReadme(stats) {
  var appMethods = 0, manual = 0, fieldTotal = 0, domain = 0;
  var body = stats.map(function (s) {
    if (!/^(00|90)-/.test(s.file)) { appMethods += s.methods; domain++; }
    manual += s.xxtAI;
    if (s.declaresFields) fieldTotal += s.fields;
    var stat = s.lines + ' 行' + (s.methods ? ' / ' + s.methods + ' 方法' : '');
    if (s.declaresFields) stat += ' + ' + s.fields + ' 状态字段';
    return '### `' + s.file + '`\n\n*' + stat + '*\n';
  }).join('\n');
  return body + '\n（跑出来大致是：' + domain + ' 个域片段合计 **' + appMethods + ' 个 app 方法**，加上 `90-` 里\n' +
    '**' + manual + ' 个挂在 `window.xxtAI` 上的手动入口** = ' + (appMethods + manual) + ' 个方法；状态字段 ' + fieldTotal + ' 个。\n';
}

/* ---------------------------------------------------------------- CLI */

function main() {
  var args = process.argv.slice(2);
  if (args.indexOf('--selftest') !== -1) {
    var n = selfTestCases().length;
    console.log('片段快照自证（' + n + ' 格）：');
    var bad = selfTest();
    if (bad.length) {
      console.log('SELFTEST-FAIL\n' + bad.join('\n'));
      process.exit(2);
    }
    console.log(n + ' 格全部通过');
    process.exit(0);
  }
  var stats = sliceStats(PARTS_DIR);
  var txt = fs.readFileSync(path.join(ROOT, README), 'utf8');
  var issues = audit(stats, txt);
  if (args.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ issues: issues, stats: stats }, null, 2));
  } else if (issues.length) {
    console.log('src/page/README.md 的快照数字与实际对不上（' + issues.length + ' 处）：');
    issues.forEach(function (i) { console.log('  - ' + i); });
    console.log('  改文档：按上面报的实际值改 ' + README + '（别改这条审计来迁就文档）');
  } else {
    console.log('src/page/README.md 快照与实际一致（' + stats.length + ' 个片段：行数 + 方法数 + 状态字段数 + 合计句）');
  }
  process.exit(issues.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  sliceStats: sliceStats, audit: audit, parseStat: parseStat, parseReadme: parseReadme,
  selfTestCases: selfTestCases, selfTest: selfTest
};
