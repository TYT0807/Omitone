/**
 * 本地自愈「医生」的规则表（`libs/diagnose.js`）里每一条 needle，必须是代码里真发出去过的那句日志。
 *
 * 为什么要这把尺（批次 130）：规则靠 `message.indexOf(needle)` 命中日志环，
 * needle 写错**不会抛、不会红、不会留日志** —— 只会让那一条规则一辈子不触发，
 * 用户点开「诊」看到的永远是「这次没查出问题」。AGENTS §2 #22 记过同一族的现场：
 * 按中文语义猜一组词去数，四格全 0 条。差别在于那次是临时探针，**这次是常驻功能**，
 * 猜错一次就一直错下去。
 *
 * ⚠️ 为什么不用第 32 项的 `emittedNames()` 当唯一真源：它有一条 `/[a-z]/i` 的形状筛
 * （防把选择器当日志名），于是**整句中文**的日志名会被它丢掉 —— 实测
 * `检测到其他浏览器扩展注入了页面资源` 那一条它读不到（418 条里没有）。
 * 放宽它那把尺会把第 32 项的说明书对账顶红，所以这里**复用取法、不复用过滤**：
 * 同一套 `skipOneArg` / `spanLiterals` / `literalAt`，只把「必须含拉丁字母」那一格去掉。
 *
 * 判据（每条都要有一格**只在它身上红**的对照，见 `--selftest`）：
 *   1. 规则的 `needles` 与 `PROGRESS_NEEDLES` 的每一条，必须出现在某个
 *      `emitRuntimeLog(等级, 名字…)` / `appendRuntimeLog(…)` 的**名字那一格**的字面量里
 *      （整句包含即可 —— `study stuck:` 这种前缀写法是合法的）。
 *   2. **注释里的不算**：只在注释里提到过的字样，等于从来没发过。
 *   3. 一条 needle 只许属于**一条**规则（同一条日志点亮两条，四条上限会被同族挤满）。
 *   4. `needles` 不许为空（空 needles 的规则恒不触发，写在表里只是给人误读成"有这条"）。
 *   5. `action` 必须是弹窗 `petDiagAction` 真认的那一种；反过来弹窗认的动作规则表里一条都没有，
 *      也是白挂的按钮（AGENTS §2 #18：声明覆盖的范围与实际走的分支之间的差，不会自己喊出来）。
 *   6. `severity` 必须是 0..3 的整数（界面按 sev0..sev3 上色，越界那一格没有样式）。
 *   7. `title` / `advice` 不许超过 `LIMITS`（超了会被截断，用户看到的是缺半截的句子 ——
 *      用户明确要求过"输出必须有界"）。
 *   8. `selfCheck()` 必须 ok —— 判断层自己的 25 格假日志全过才算数。
 *   9. 规则表**读不出来**（0 条 / 弹窗源码读不到）→ FATAL，不许打印「0 条问题、全部通过」。
 *
 * 用法：
 *   node tools/audit-diagnose-needles.js            // 核真仓库；红了退出非 0
 *   node tools/audit-diagnose-needles.js --selftest // 逐格对照；每格自己说走到没走到
 *   node tools/audit-diagnose-needles.js --dump     // 只印读数（needle 数 / 字面量数 / 动作）
 */
'use strict';

var fs = require('fs');
var path = require('path');

var NAMES = require('./audit-manual-log-names.js');
var ROOT = path.resolve(__dirname, '..');
var DIAGNOSE = path.join(ROOT, 'libs', 'diagnose.js');
var POPUP = path.join(ROOT, 'popup', 'popup.js');

/** 真源文件：发运行日志的那几份 + 弹窗（她那一族的日志只在弹窗里发）。 */
function sourceFiles() {
  var files = [];
  var sliceDir = path.join(ROOT, 'src', 'page');
  fs.readdirSync(sliceDir).filter(function (n) { return /\.js$/.test(n); }).forEach(function (n) {
    files.push(path.join(sliceDir, n));
  });
  files.push(path.join(ROOT, 'content.js'));
  files.push(path.join(ROOT, 'background.js'));
  files.push(POPUP);
  return files;
}

function read(f) { return fs.readFileSync(f, 'utf8'); }

/**
 * 注释区间（返回逐字符的布尔掩码）。
 * 走一遍状态机：行注释 / 块注释 / 三种引号的字面量。字面量里的 `//` 不当注释起点。
 * ⚠️ 正则字面量里的引号**会让它错位** —— 错位的后果是把真代码标成注释，
 * 于是那一条 needle 报成"没发过"（**响在明处**，不是把闸放开），所以宁可保留这一手。
 * `--selftest` 里 C 格专门测"只在注释里"必须红。
 */
function commentMask(src) {
  var mask = new Array(src.length);
  var i = 0;
  while (i < src.length) {
    var c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { mask[i] = true; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { mask[i] = true; i++; }
      mask[i] = true; mask[i + 1] = true; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      var lit = NAMES.literalAt(src, i);
      if (!lit) { i++; continue; }
      for (var k = i; k < lit.end; k++) mask[k] = false;   // 字面量内部绝不是注释
      i = lit.end;
      continue;
    }
    i++;
  }
  return mask;
}

/**
 * 代码里「作为日志名发出去过」的那些字面量整句（不做第 32 项那条 `[a-z]` 形状筛）。
 * @returns {{texts:string[], sites:number, dropped:number}}
 */
function emitNameTexts(srcs) {
  var texts = [], sites = 0, dropped = 0;
  srcs.forEach(function (x) {
    var mask = commentMask(x.src);
    var re = /(?:emit|append)RuntimeLog\s*\(\s*/g;
    var m;
    while ((m = re.exec(x.src))) {
      if (mask[m.index]) continue;                       // 注释里的那一句不算发过
      sites++;
      var afterLevel = NAMES.skipOneArg(x.src, re.lastIndex);
      if (afterLevel < 0) { dropped++; continue; }
      var found = NAMES.spanLiterals(x.src, afterLevel, ',)', false, true);
      if (!found.length) { dropped++; continue; }
      found.forEach(function (v) { texts.push(v); });
    }
  });
  return { texts: texts, sites: sites, dropped: dropped };
}

/** 弹窗 `petDiagAction` 真认的动作种类。 */
function uiActionsFrom(popupSrc) {
  var out = [];
  var re = /kind\s*===\s*["']([^"']+)["']/g;
  var m;
  while ((m = re.exec(popupSrc))) out.push(m[1]);
  return out;
}

/**
 * 核对。所有输入都可注入，好让 `--selftest` 逐格单独破一道闸。
 * @param {{rules:Array, progress:string[], nameTexts:string[], actions:string[],
 *          limits:Object, selfCheck:Object|null}} inp
 * @returns {{problems:string[], fatal:boolean, stats:Object}}
 */
function evaluate(inp) {
  var rules = inp.rules || [];
  var progress = inp.progress || [];
  var texts = inp.nameTexts || [];
  var actions = inp.actions || [];
  var limits = inp.limits || {};
  var problems = [];

  if (!rules.length) {
    return { problems: ['规则表读出来是空的 —— 守卫失效，判据没跑就不要打印通过'], fatal: true, stats: {} };
  }
  if (!actions.length && !rules.every(function (r) { return !r.action; })) {
    return { problems: ['弹窗那侧读不出任何动作 —— 这一格没验到，别说「动作全部接得上」'], fatal: true, stats: {} };
  }

  function emitted(n) {
    for (var i = 0; i < texts.length; i += 1) if (texts[i].indexOf(n) !== -1) return true;
    return false;
  }

  var owner = Object.create(null);
  rules.forEach(function (r) {
    var code = r.code || '(无名)';
    if (!r.needles || !r.needles.length) {
      problems.push(code + ': needles 是空的 —— 这一条永远不触发，写在表里只是让人误读成「有这条」');
    }
    (r.needles || []).forEach(function (n) {
      if (!emitted(n)) {
        problems.push(code + ': needle「' + n + '」在代码里从来没作为日志名发出去过 —— ' +
          '这一条规则一辈子不会命中，用户只会看到「这次没查出问题」。' +
          '正解是去 src/page/*.js、content.js、background.js 里 grep emitRuntimeLog( 把真名抄回来，别改这把尺');
      }
      if (owner[n]) {
        problems.push('needle「' + n + '」同时属于 ' + owner[n] + ' 与 ' + code +
          ' —— 一条日志点亮两条规则，四条上限会被同一族挤满');
      } else owner[n] = code;
    });

    if (r.action) {
      if (actions.indexOf(r.action) < 0) {
        problems.push(code + ': action「' + r.action + '」弹窗的 petDiagAction 不认 —— ' +
          '卡片上会出一枚点了没反应的按钮（新动作要同时落进 popup/popup.js 的分支里）');
      }
    }
    if (!(r.severity >= 0 && r.severity <= 3) || Math.floor(r.severity) !== r.severity) {
      problems.push(code + ': severity「' + r.severity + '」不是 0..3 的整数 —— 界面按 sev0..sev3 上色，这一格没有样式');
    }
    if (!r.title || !r.advice) problems.push(code + ': title / advice 少了一格 —— 卡片只有半句话');
    if (r.title && limits.TITLE_MAX && r.title.length > limits.TITLE_MAX) {
      problems.push(code + ': title ' + r.title.length + ' 字，超上限 ' + limits.TITLE_MAX + ' —— 会被截成缺半截');
    }
    if (r.advice && limits.ADVICE_MAX && r.advice.length > limits.ADVICE_MAX) {
      problems.push(code + ': advice ' + r.advice.length + ' 字，超上限 ' + limits.ADVICE_MAX + ' —— 会被截成缺半截');
    }
  });

  progress.forEach(function (n) {
    if (!emitted(n)) {
      problems.push('PROGRESS_NEEDLES:「' + n + '」从来没作为日志名发出去过 —— ' +
        '「这段时间没看到推进」那条会把一直在推进的课也说成没推进');
    }
  });

  var deadActions = actions.filter(function (a) {
    return !rules.some(function (r) { return r.action === a; });
  });
  if (deadActions.length) {
    problems.push('弹窗认的动作 ' + deadActions.join(' / ') + ' 规则表里一条都没有 —— 白挂的按钮（改判据前先问谁在用）');
  }

  if (inp.selfCheck && inp.selfCheck.ok !== true) {
    problems.push('libs/diagnose.js 的 selfCheck() 没通过: ' + (inp.selfCheck.problems || []).join('；'));
  }

  return {
    problems: problems,
    fatal: false,
    stats: {
      rules: rules.length,
      needles: rules.reduce(function (a, r) { return a + (r.needles || []).length; }, 0),
      progress: progress.length,
      sites: inp.sites || 0,
      texts: texts.length,
      dropped: inp.dropped || 0,
      actions: actions.length
    }
  };
}

function realInput() {
  var D = require(DIAGNOSE);
  var srcs = sourceFiles().map(function (f) { return { f: f, src: read(f) }; });
  var e = emitNameTexts(srcs);
  var popupSrc = '';
  try { popupSrc = read(POPUP); } catch (err) { popupSrc = ''; }
  return {
    rules: D.RULES,
    progress: D.PROGRESS_NEEDLES,
    nameTexts: e.texts,
    sites: e.sites,
    dropped: e.dropped,
    actions: uiActionsFrom(popupSrc),
    limits: D.LIMITS,
    selfCheck: D.selfCheck()
  };
}

function audit() {
  var inp = realInput();
  var r = evaluate(inp);
  if (r.fatal) {
    console.log('[FATAL] ' + r.problems.join('\n[FATAL] '));
    return 1;
  }
  if (r.problems.length) {
    console.log('[FAIL] 医生规则表对不上代码（' + r.problems.length + ' 处，改规则别改判据）：');
    r.problems.forEach(function (p) { console.log('      ' + p); });
    return 1;
  }
  console.log('[ok]   医生规则表（' + r.stats.rules + ' 条规则 / ' + r.stats.needles + ' 条 needle / ' +
    r.stats.progress + ' 条推进字样）全部对着代码里真发过的那一句；' +
    '动作 ' + r.stats.actions + ' 种由弹窗接住；selfCheck ' + (inp.selfCheck.total || 0) + ' 格全过' +
    '（发日志的调用点 ' + r.stats.sites + ' 处，取不出名字的 ' + r.stats.dropped + ' 处已计入旁证）');
  return 0;
}

function dump() {
  var inp = realInput();
  console.log(JSON.stringify({
    rules: inp.rules.length,
    needles: inp.rules.reduce(function (a, r) { return a + r.needles.length; }, 0),
    progress: inp.progress.length,
    emitSites: inp.sites,
    nameTexts: inp.nameTexts.length,
    dropped: inp.dropped,
    actions: inp.actions
  }, null, 2));
  return 0;
}

// ── 逐格对照 ────────────────────────────────────────────────────────
// 每格只破一道闸，并断言「红的恰好是这一道」。格数由 `tools/check.js` 第 35 项钉住，删一格就红。
// ⚠️ 干净夹具必须**两条规则各用一个动作** —— 只有一条动作时，「弹窗白挂一枚没人发的动作」
// 那一格会在**所有**夹具里恒红，于是每一格报的都不是自己那一刀（AGENTS §5「一条注入只破一层」同族）。
var BASE_SRC = [
  { f: 'a.js', src: "emitRuntimeLog('warn', 'demo fired', {a:1});" },
  { f: 'b.js', src: "appendRuntimeLog('info', 'settings needed');" },
  { f: 'c.js', src: "emitRuntimeLog('warn', '检测到别的扩展动了这一页，先关掉再看', {ids:1});" }
];
var BASE_RULES = [
  {
    code: 'demo', severity: 2, action: 'reload',
    needles: ['demo fired'], title: '演示一条', advice: '照建议做一次就行'
  },
  {
    code: 'demo2', severity: 1, action: 'open-settings',
    needles: ['settings needed', '检测到别的扩展动了这一页'],
    title: '第二条', advice: '去设置里补一下'
  }
];
var BASE_ACTIONS = ['reload', 'open-settings'];
var BASE_LIMITS = { MAX_FINDINGS: 4, TITLE_MAX: 26, ADVICE_MAX: 72, EVIDENCE_MAX: 96, DIGEST_MAX: 900 };

/** @param {{srcs?:Array, rules?:Array, actions?:Array, progress?:Array, selfCheck?:Object}} over */
function baseInput(over) {
  over = over || {};
  var e = emitNameTexts(over.srcs || BASE_SRC);
  return {
    rules: JSON.parse(JSON.stringify(over.rules || BASE_RULES)),
    progress: over.progress || [],
    nameTexts: e.texts,
    sites: e.sites,
    dropped: e.dropped,
    actions: (over.actions || BASE_ACTIONS).slice(),
    limits: BASE_LIMITS,
    selfCheck: over.selfCheck || { ok: true, total: 1, problems: [] }
  };
}

var CELLS = [
  {
    pin: 'A 干净夹具 → 0 条',
    run: function () { return evaluate(baseInput()); },
    want: { fatal: false, count: 0 }
  },
  {
    pin: 'B needle 代码里没有 → 点名那条规则',
    run: function () {
      var i = baseInput();
      i.rules[0].needles = ['demo fired but never logged'];
      return evaluate(i);
    },
    want: { fatal: false, count: 1, has: 'needle「demo fired but never logged」' }
  },
  {
    pin: 'C 只在注释里提到 → 两条 needle 都算没发过',
    run: function () {
      return evaluate(baseInput({
        srcs: [{
          f: 'x.js',
          src: "// emitRuntimeLog('warn', 'demo fired');\nvar y = 1;\n/*\nappendRuntimeLog('info', 'settings needed');\n*/\n" +
            BASE_SRC[2].src
        }]
      }));
    },
    want: { fatal: false, count: 2, has: 'needle「demo fired」' }
  },
  {
    pin: 'D 名字长在别的调用里（不是 emit 那一发）→ 不算',
    run: function () {
      return evaluate(baseInput({ srcs: [{ f: 'x.js', src: "foo('demo fired');" }].concat(BASE_SRC.slice(1)) }));
    },
    want: { fatal: false, count: 1, has: 'needle「demo fired」' }
  },
  {
    pin: 'E 同一条 needle 属于两条规则 → 点名两条',
    run: function () {
      var i = baseInput();
      i.rules[1].needles = ['demo fired'];
      return evaluate(i);
    },
    want: { fatal: false, count: 1, has: '同时属于 demo 与 demo2' }
  },
  {
    pin: 'F needles 为空 → 恒不触发要响',
    run: function () {
      var i = baseInput();
      i.rules[0].needles = [];
      return evaluate(i);
    },
    want: { fatal: false, count: 1, has: 'needles 是空的' }
  },
  {
    pin: 'G 动作弹窗不认 → 点名那个动作（顺带 reload 变白挂）',
    run: function () {
      var i = baseInput();
      i.rules[0].action = 'rerun-study';
      return evaluate(i);
    },
    want: { fatal: false, count: 2, has: '弹窗的 petDiagAction 不认' }
  },
  {
    pin: 'H severity 越界 → 点名那一格',
    run: function () {
      var i = baseInput();
      i.rules[0].severity = 7;
      return evaluate(i);
    },
    want: { fatal: false, count: 1, has: '不是 0..3 的整数' }
  },
  {
    pin: 'I title 超上限 → 会被截断要响',
    run: function () {
      var i = baseInput();
      i.rules[0].title = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
      return evaluate(i);
    },
    want: { fatal: false, count: 1, has: '超上限' }
  },
  {
    pin: 'J 推进字样没发过 → 单独点名',
    run: function () {
      return evaluate(baseInput({ progress: ['study next unit'] }));
    },
    want: { fatal: false, count: 1, has: 'PROGRESS_NEEDLES' }
  },
  {
    pin: 'K 规则表空 → FATAL（不许打印通过）',
    run: function () {
      return evaluate(baseInput({ rules: [] }));
    },
    want: { fatal: true }
  },
  {
    pin: 'L 弹窗源码读不到而规则有动作 → FATAL',
    run: function () {
      return evaluate(baseInput({ actions: [] }));
    },
    want: { fatal: true, count: 1, has: '读不出任何动作' }
  },
  {
    pin: 'M 弹窗白挂一枚没人发的动作 → 点名',
    run: function () {
      return evaluate(baseInput({ actions: BASE_ACTIONS.concat(['drop-table']) }));
    },
    want: { fatal: false, count: 1, has: '白挂的按钮' }
  },
  {
    pin: 'N selfCheck 没通过 → 转述它自己的话',
    run: function () {
      return evaluate(baseInput({
        selfCheck: { ok: false, total: 2, problems: ['s3: 期望 issue，实得 healthy'] }
      }));
    },
    want: { fatal: false, count: 1, has: 'selfCheck() 没通过' }
  },
  {
    pin: 'O 阴性对照：注释与真代码混在一处，真代码那一发必须算发过',
    run: function () {
      return evaluate(baseInput({
        srcs: [{
          f: 'o.js',
          src: "// 这条以前叫别的名字，别照抄\nemitRuntimeLog('warn', 'demo fired');\n" +
            BASE_SRC[1].src + '\n' + BASE_SRC[2].src
        }]
      }));
    },
    want: { fatal: false, count: 0 }
  },
  {
    pin: 'P 整句中文的日志名必须收进真源（承重：不许退回第 32 项那条 `[a-z]` 形状筛）',
    run: function () {
      var e = emitNameTexts(BASE_SRC);
      var has = e.texts.some(function (t) { return t.indexOf('检测到别的扩展动了这一页') !== -1; });
      return {
        fatal: false,
        problems: has ? [] : ['整句中文的日志名被形状筛丢掉了 —— keepShape 那一格没生效，' +
          '于是 foreign-ext 那一条规则会永远命中不了'],
        stats: {}
      };
    },
    want: { fatal: false, count: 0 }
  }
];

function selftest() {
  var failed = 0;
  CELLS.forEach(function (c) {
    var got = null, err = null;
    try { got = c.run(); } catch (e) { err = e; }
    if (err) {
      console.log('[FAIL] ' + c.pin + ' → 跑挂了: ' + err.message);
      failed++;
      return;
    }
    var ok = !!got.fatal === !!c.want.fatal;
    if (ok && c.want.count !== undefined && got.problems.length !== c.want.count) {
      ok = false;
      console.log('[FAIL] ' + c.pin + ' → 期望 ' + c.want.count + ' 条，实得 ' + got.problems.length +
        ' 条：' + got.problems.join(' / '));
      return;
    }
    if (ok && c.want.has && !got.problems.some(function (p) { return p.indexOf(c.want.has) !== -1; })) {
      ok = false;
      console.log('[FAIL] ' + c.pin + ' → 没有点名「' + c.want.has + '」：' + got.problems.join(' / '));
      return;
    }
    if (ok) console.log('[ok]   ' + c.pin);
    else failed++;
  });

  // 真仓库那一格：红了整轮就不算过
  var real = evaluate(realInput());
  if (real.fatal || real.problems.length) {
    failed++;
    console.log('[FAIL] 真仓库 → ' + (real.problems.join('\n      ') || 'FATAL'));
  } else {
    console.log('[ok]   真仓库（' + real.stats.rules + ' 条规则 / ' + real.stats.needles + ' 条 needle / ' +
      real.stats.progress + ' 条推进字样 / 发日志的调用点 ' + real.stats.sites + ' 处，字面量 ' +
      real.stats.texts + ' 段）');
  }
  console.log('对照格数: ' + CELLS.length + '（另有真仓库 1 格）' + (failed ? '，未通过 ' + failed + ' 格' : ''));
  return failed ? 1 : 0;
}

if (require.main === module) {
  var argv = process.argv;
  var code = argv.indexOf('--selftest') >= 0 ? selftest()
    : (argv.indexOf('--dump') >= 0 ? dump() : audit());
  process.exit(code);
}

module.exports = {
  sourceFiles: sourceFiles,
  commentMask: commentMask,
  emitNameTexts: emitNameTexts,
  uiActionsFrom: uiActionsFrom,
  evaluate: evaluate,
  realInput: realInput,
  CELLS: CELLS
};
