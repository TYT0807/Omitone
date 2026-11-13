/**
 * 跨域裸读审计 —— `AGENTS.md` §2 第 1 条的机检实现。
 *
 * 那条规矩原本**只写在文档里**：跨域 iframe 永远不要裸读 `.document`，
 * 要走 `_safeDocOf()` / `_safeWinDoc()`。裸读抛出的 SecurityError 会静默打断
 * 整个 tick 循环 —— 文档自己管它叫「最难查的一类 bug」。
 * 现在它是 `npm run check` 的第 24 项（那一项直接 require 本文件的 `scanSource`），
 * 本文件同时也能单独跑：
 *
 *   node tools/audit-safedoc.js          # 先自证，再全量列出并汇总；有裸读则 exit 1
 *   node tools/audit-safedoc.js --json   # 机器可读，给 check.js 的失败信息用
 *
 * ⚠️ **判定必须落在字符位置上，不能落在「行」上。**
 * 上一版按行算大括号深度，再问「这一行的**起始**深度有没有落在某个 try 区间里」，
 * 于是这样一行
 *
 *     try { doc = frame.contentDocument; } catch (eCross) { return null; }
 *
 * 被报成「没有保护」—— 同行里左括号还没被算进深度，命中点却在括号后面。
 * 实测它在干净树上打出「没有保护 1 处」并 exit 1（`62-tasks-run.js` 的
 * `_voteOverlayDocReady`）。会误报的审计等于没有审计，而且比没有更糟：
 * 它训练接手的人忽略这一行输出。所以这里逐字符走，**命中点当下的深度**才算数。
 *
 * ⚠️ **catch / finally 体不算保护。**
 * 裸读落在 `catch (e) { … }` 里，意思是**进去之前已经抛过一次**了；
 * 把那里当成「被 try 包住」会正好把最危险的位置洗白。
 * 所以栈上的帧要带 kind，只有 `try` 体算保护。
 *
 * ⚠️ **词法器一旦吞掉一整段，报出来的「0 处」是假的。**
 * 更早上的一版漏了正则字面量，`60-tasks-detect.js:125` 那个含引号的正则
 * 被当成进了字符串，从此该文件后面的行全被剥成空 ——
 * 那 4 处裸读一处没报，汇总行照样打印「没有保护 0 处」。
 * 两道兜底：文件读到结尾仍停在注释 / 字符串 / 模板里 → `lexerProblems`；
 * 外加下面那组 `SELF_CASES`（含「正则字面量之后还有裸读」那一格）。
 * **自证不过就不出结论**（exit 2），因为「审计说干净」这句话的内容全靠它。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'page');

/** 裸读跨域 document 的两种形态：直接摸 contentDocument，或 contentWindow.document */
const BARE = /\.contentDocument|\.contentWindow\s*\.\s*document/;

/** 这几个助手**本身就是**做安全读取的地方，它们内部的访问是合法的 */
const ALLOWED_FNS = ['_safeDocOf', '_safeWinDoc', '_isFrameSameOrigin', '_getMainWindow'];

/** 判 `/` 是正则还是除号时，认这些关键字后面接的是正则 */
const REGEX_BEFORE_WORDS = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete',
  'void', 'instanceof', 'do', 'else', 'yield', 'await'];

/**
 * 把一行的字符串 / 注释 / 正则字面量剥成**等长**空白，只留会影响括号计数的代码。
 *
 * 跨行状态（块注释、字符串、模板字符串里的 `${}`）用 state 传递。
 * 等长很重要：命中点的列号要和原文对得上，报错时人才看得懂。
 *
 * 模板字符串里的 `${…}` 按**代码**处理（`${` 与 `}` 原样留着、里面的内容不剥）：
 * 那样大括号天然平衡，嵌在模板表达式里的裸读也抓得到。
 */
function blankOut(line, state) {
  let out = '';
  let i = 0;
  const pad = function (n) { out += ' '.repeat(n); };

  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    if (state.block) {
      if (c === '*' && next === '/') { state.block = false; pad(2); i += 2; continue; }
      pad(1);
      i++;
      continue;
    }
    if (state.str) {
      if (c === '\\') { pad(2); i += 2; continue; }
      if (state.str === '`' && c === '$' && next === '{') {
        state.str = null;
        state.tpl = 1;
        out += '${';
        i += 2;
        continue;
      }
      if (c === state.str) { state.str = null; pad(1); i++; continue; }
      pad(1);
      i++;
      continue;
    }

    // 模板的 ${…} 内部仍是代码，只是要认出收尾的那个 }
    // ⚠️ 这里的 `}` 必须**原样留下**（不能 pad）：`${` 是 emit 出去的，
    // 把它对应的 `}` 抹掉会让整份文件的括号深度净 +1，后面的 try 判定全错。
    if (state.tpl > 0 && c === '}') {
      state.tpl--;
      if (state.tpl === 0) state.str = '`';
      out += '}';
      i++;
      continue;
    }

    if (c === '/' && next === '/') { pad(line.length - i); break; }   // 行注释：本行其余留空
    if (c === '/' && next === '*') { state.block = true; pad(2); i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { state.str = c; pad(1); i++; continue; }
    if (c === '{' && state.tpl > 0) { state.tpl++; out += c; i++; continue; }
    if (c === '/') {
      const before = out.replace(/\s+$/, '');
      const last = before.slice(-1);
      const lastWord = (before.match(/[A-Za-z_$][\w$]*$/) || [''])[0];
      const regexOk = last === '' ||
        /[({[;,=:!&|?+\-*%~^<>]/.test(last) ||
        REGEX_BEFORE_WORDS.indexOf(lastWord) !== -1;
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < line.length) {
          const d = line[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { j++; closed = true; break; }
          j++;
        }
        while (j < line.length && /[a-z]/i.test(line[j])) j++;   // 修饰符
        if (closed) { pad(j - i); i = j; continue; }
        // 找不到闭合的正则起点：按普通字符放行，让 EOF 自校验去报警，别在这里吞掉整段
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 逐行剥注释/字符串，并带上文件读完时的残留状态（残留 = 词法器吞掉了后面的内容）。 */
function toCodeLines(text) {
  const lines = text.split(/\r?\n/);
  const state = { block: false, str: null, tpl: 0 };
  const code = lines.map(function (raw) { return blankOut(raw, state); });
  const leftover = { block: state.block, str: state.str, tpl: state.tpl };
  // ⚠️ 等长是**地基**：命中点的偏移是从 code 拼出来的串上取的，行列号却按原文算。
  // 一旦某行剥完变短，后面所有命中的行列全部错位 —— 实测把 `//` 那一路忘了补空，
  // 结果报出 32 处「裸读」，里面一半是注释和压根不含这字样的行。
  const ragged = [];
  code.forEach(function (one, idx) {
    if (one.length !== lines[idx].length) ragged.push(idx + 1);
  });
  return { lines: lines, code: code, leftover: leftover, ragged: ragged };
}

/** 这一行属于哪个函数：向上找最近的 `xxx: function` 或 `function xxx`。 */
function ownerFn(code, lineIdx) {
  for (let i = lineIdx; i >= 0; i--) {
    const m = code[i].match(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/) ||
              code[i].match(/function\s+([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return '(文件顶层)';
}

/**
 * 逐字符走出每一处裸读，并记下**它当下**是否落在某个 try 体内。
 *
 * frames 存 `{enter: 进入该块之前的深度, kind: 'try'|'catch'|'finally'}`，
 * 只有 kind === 'try' 的帧算保护。命中点要在处理该列字符**之前**判定，
 * 这样同行 `try { … }` 的左括号才已经被算进深度。
 */
function findBareReads(lines, code) {
  const text = code.join('\n');
  const lineStarts = [0];
  for (let k = 0; k < lines.length; k++) lineStarts.push(lineStarts[k] + lines[k].length + 1);
  const lineOf = function (off) {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const marks = [];
  const re = new RegExp(BARE.source, 'g');
  let m;
  while ((m = re.exec(text))) marks.push(m.index);

  const found = [];
  const frames = [];
  const len = text.length;
  let next = 0;
  let depth = 0;
  let pending = null;     // 刚见到 try/catch/finally，在等它的左括号
  let prevChar = '';      // 前面最后一个有效字符（用来排除 `obj.try` 这种属性名）

  for (let i = 0; i <= len; i++) {
    while (next < marks.length && marks[next] === i) {
      const ln = lineOf(i);
      found.push({
        offset: i,
        line: ln + 1,
        col: i - lineStarts[ln],
        raw: lines[ln] || '',
        inTry: frames.some(function (f) { return f.kind === 'try' && depth > f.enter; }),
        frameKind: frames.length ? frames[frames.length - 1].kind : '无 try/catch/finally 帧'
      });
      next++;
    }
    if (i === len) break;
    const ch = text[i];
    if (ch === '{') {
      if (pending) { frames.push({ enter: depth, kind: pending }); pending = null; }
      depth++;
    } else if (ch === '}') {
      depth--;
      while (frames.length && depth <= frames[frames.length - 1].enter) frames.pop();
    } else if (ch === ';') {
      pending = null;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (prevChar !== '.' && (word === 'try' || word === 'catch' || word === 'finally')) {
        pending = word;
      }
      prevChar = word.slice(-1);
      i = j - 1;
      continue;
    }
    if (!/\s/.test(ch)) prevChar = ch;
  }
  found.depthEnd = depth;      // 走完一整份源码后应该是 0，不是 0 就是词法器漏了形状
  return found;
}

/**
 * 扫一份源码：返回裸读清单、危险 / 受保护计数，以及词法器残留告警。
 *
 * @param {string} label 文件名（只用于报错时能指到哪一份）
 * @param {string} text  源码全文
 */
function scanSource(label, text) {
  const parsed = toCodeLines(text);
  const hits = findBareReads(parsed.lines, parsed.code);

  const rows = [];
  let risky = 0;
  let guarded = 0;
  let inHelpers = 0;
  let depthNote = '';
  hits.forEach(function (hit) {
    const fn = ownerFn(parsed.code, hit.line - 1);
    rows.push({ file: label, line: hit.line, col: hit.col, fn: fn,
      inTry: hit.inTry, frameKind: hit.frameKind, text: hit.raw.trim() });
    if (ALLOWED_FNS.indexOf(fn) !== -1) { inHelpers++; return; }   // 助手自身，跳过
    if (hit.inTry) guarded++; else risky++;
  });

  const lexerProblems = [];
  const lv = parsed.leftover;
  if (lv.block) {
    lexerProblems.push(label + ': 文件读到结尾仍停在块注释里（词法器吞掉了后面的内容）');
  }
  if (lv.str) {
    lexerProblems.push(label + ': 文件读到结尾仍停在字符串里（词法器吞掉了后面的内容）');
  }
  if (lv.tpl > 0) {
    lexerProblems.push(label + ': 文件读到结尾仍有 ' + lv.tpl + ' 层模板字符串 ${} 没闭合');
  }

  // ⚠️ 对位自证：报出来的行:列**必须**真的以裸读字样开头。
  // 命中是从剥完注释的整串上取的偏移，行列号是换算出来的 —— 换算只要错一次，
  // 报出来的位置就是别人的代码，而且计数照样「对得上」。所以这里逐条回原文核对，
  // 不合格直接把结论作废（CLI  exit 2），而不是等人看出来。
  const aligned = new RegExp('^(?:' + BARE.source + ')');
  const alignmentProblems = [];
  if (parsed.ragged.length) {
    alignmentProblems.push(label + ': 剥注释后长度变了的一行 —— 行号 ' +
      parsed.ragged.slice(0, 8).join(',') + (parsed.ragged.length > 8 ? '…' : ''));
  }
  if (hits.depthEnd !== 0 && !lv.block && !lv.str && !lv.tpl) {
    // ⚠️ 单个片段的括号净深度**不作断言**：`src/page/` 那 16 个片段是同一个巨石的切片，
    // 一段开头开、另一段结尾关（实测 `00-shell-constants.js` 末尾净 +2、
    // `90-console-api-startup.js` 末尾净 -2）。真该断的是**拼起来总量为 0**，
    // 那由 summarize 汇总 depthEnd 来做 —— 这里只把数带出来，别把它当告警。
    depthNote = label + ': 本片末尾大括号净 ' + hits.depthEnd;
  }
  hits.forEach(function (hit) {
    const raw = parsed.lines[hit.line - 1] || '';
    if (!aligned.test(raw.slice(hit.col))) {
      alignmentProblems.push(label + ':' + hit.line + ':' + hit.col +
        ' 那一列不是裸读：' + raw.trim().slice(0, 90));
    }
  });

  const rawHits = parsed.lines.filter(function (l) { return BARE.test(l); }).length;

  return {
    label: label,
    rows: rows,
    reads: rows.length,
    risky: risky,
    guarded: guarded,
    inHelpers: inHelpers,
    lexerProblems: lexerProblems,
    alignmentProblems: alignmentProblems,
    rawHits: rawHits,
    codeHits: hits.length,
    depthEnd: hits.depthEnd,
    depthNote: depthNote
  };
}

/** 扫一个目录里的所有 .js（按文件名排序，保证输出稳定）。 */
function scanDir(dir) {
  const files = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).sort();
  return files.map(function (f) {
    return scanSource(f, fs.readFileSync(path.join(dir, f), 'utf8'));
  });
}

/** 一处的身份，给 check.js 做「报告命中 == 实际命中」的接线自证用。 */
function keyOf(row) {
  return row.file + ':' + row.line + ':' + row.col + '#' + row.fn;
}

/**
 * 自检：九格已知答案的合成样本。
 *
 * 这组东西是整个审计的地基 —— 「没有裸读」这个结论只有在这组全过时才有内容。
 * 尤其第 4、5、8、9 格，它们分别钉住本工具（以及这次重写自己）真实翻过的车。
 *
 * ⚠️ 每格带一个 `pin`（稳定标识）。`tools/check.js` 第 24 项**自带一份期望数字**、
 * 按 pin 逐格复算，而不是照抄这里的 `expect` —— 否则「把 expect 改成实际值」
 * 就能让自检永远绿，那和没有自检一模一样。
 */
const SELF_CASES = [
  {
    pin: 'same-line-try',
    name: '同行闭合的 try/catch 算受保护（上一版在这里误报）',
    src: [
      'var _x = {',
      '  f: function () {',
      '    var doc = null;',
      '    try { doc = frame.contentDocument; } catch (e) { return null; }',
      '    return doc;',
      '  }',
      '}'],
    expect: { reads: 1, risky: 0, guarded: 1 }
  },
  {
    pin: 'multiline-try',
    name: '跨行 try 体算受保护',
    src: [
      'function g() {',
      '  try {',
      '    var d = a.contentWindow.document;',
      '    use(d);',
      '  } catch (e) {',
      '    return null;',
      '  }',
      '}'],
    expect: { reads: 1, risky: 0, guarded: 1 }
  },
  {
    pin: 'no-try',
    name: '完全没有 try 的裸读要报危险',
    src: ['function h() {', '  return iFrame.contentDocument.body;', '}'],
    expect: { reads: 1, risky: 1, guarded: 0 }
  },
  {
    pin: 'catch-body',
    name: '落在 catch 体里的裸读不算受保护',
    src: [
      'function k() {',
      '  try {',
      '    var n = 1;',
      '  } catch (e) {',
      '    var d2 = iFrame.contentDocument;',
      '    return d2;',
      '  }',
      '}'],
    expect: { reads: 1, risky: 1, guarded: 0 }
  },
  {
    pin: 'after-regex',
    name: '正则字面量含引号之后，裸读仍然要抓得到（吞段回归格）',
    src: [
      'function q(s) {',
      '  var re = /x("[^"]*")y/;',
      '  var hit = s.match(re);',
      '  return hit;',
      '}',
      'function r() {',
      '  var d = third.contentDocument;',
      '  return d;',
      '}'],
    expect: { reads: 1, risky: 1, guarded: 0 }
  },
  {
    pin: 'inside-helper',
    name: '安全读取助手内部的访问是合法的',
    src: [
      'var _api = {',
      '  _safeDocOf: function (f) {',
      '    try { return f.contentDocument; } catch (e) { return null; }',
      '  }',
      '}'],
    expect: { reads: 1, risky: 0, guarded: 0, inHelpers: 1 }
  },
  {
    pin: 'comment-only',
    name: '注释里的字样不算命中',
    src: [
      '// 这里说的是 iframe.contentDocument，但它不是代码',
      '/* 多行注释里的 iframe.contentDocument 也不算 */',
      'function t() { return 1; }'],
    expect: { reads: 0, risky: 0, guarded: 0, rawHits: 2 }
  },
  {
    pin: 'unclosed-block',
    name: '块注释没闭合要被词法自校验发现',
    src: ['function u() {', '  /* 这里忘了关', '  var v = 1;', '  return v;', '}'],
    expect: { reads: 0, lexerProblems: 1 }
  },
  {
    pin: 'template-depth',
    name: '模板字符串的 ${} 不许把括号深度算歪',
    src: [
      'function w(n) {',
      '  var s = `x${n}y`;',
      '  try {',
      '    var d = f.contentDocument;',
      '    return d;',
      '  } catch (e) {',
      '    return null;',
      '  }',
      '}',
      'function z() {',
      '  var t = `a${ "b{c" }d`;',
      '  return t;',
      '}'],
    expect: { reads: 1, risky: 0, guarded: 1 }
  }
];

/** 跑自检，返回失败清单（空数组 = 九格全过）。 */
function runSelfCheck() {
  const bad = [];
  SELF_CASES.forEach(function (c) {
    const got = scanSource('(自检)', c.src.join('\n'));
    const want = c.expect;
    ['reads', 'risky', 'guarded', 'inHelpers', 'rawHits'].forEach(function (field) {
      if (want[field] === undefined) return;
      if (got[field] !== want[field]) {
        bad.push(c.name + '：' + field + ' 期望 ' + want[field] + '，实际 ' + got[field]);
      }
    });
    if (want.lexerProblems !== undefined && got.lexerProblems.length !== want.lexerProblems) {
      bad.push(c.name + '：词法告警期望 ' + want.lexerProblems + ' 条，实际 ' +
        got.lexerProblems.length + ' 条');
    }
    if (got.alignmentProblems.length) {
      bad.push(c.name + '：对位自证不过 —— ' + got.alignmentProblems.join('；'));
    }
  });
  return bad;
}

/** 把一批 scanSource 结果汇总。 */
function summarize(results) {
  const sum = { files: results.length, reads: 0, risky: 0, guarded: 0, inHelpers: 0,
    rawHits: 0, codeHits: 0, depthTotal: 0, lexerProblems: [], alignmentProblems: [],
    problems: [], riskyRows: [] };
  results.forEach(function (r) {
    sum.reads += r.reads;
    sum.risky += r.risky;
    sum.guarded += r.guarded;
    sum.inHelpers += r.inHelpers;
    sum.rawHits += r.rawHits;
    sum.codeHits += r.codeHits;
    sum.depthTotal += r.depthEnd;
    r.lexerProblems.forEach(function (p) { sum.lexerProblems.push(p); });
    r.alignmentProblems.forEach(function (p) { sum.alignmentProblems.push(p); });
    r.rows.forEach(function (row) {
      if (ALLOWED_FNS.indexOf(row.fn) === -1 && !row.inTry) sum.riskyRows.push(row);
    });
  });
  // ⚠️ 用 `depthEnd` 而不是某个不存在字段：写成 `r.depthTotal || 0` 会恒为 0，
  // 于是这条不变量永远绿 —— 正是本批要消灭的那类假绿。
  if (sum.depthTotal !== 0) {
    sum.alignmentProblems.push('整目录拼起来大括号净 ' + sum.depthTotal +
      '（应为 0）—— 词法器漏了某种形状，上面的计数不可信');
  }
  sum.problems = sum.lexerProblems.concat(sum.alignmentProblems);
  return sum;
}

module.exports = {
  BARE: BARE,
  ALLOWED_FNS: ALLOWED_FNS,
  SELF_CASES: SELF_CASES,
  blankOut: blankOut,
  toCodeLines: toCodeLines,
  findBareReads: findBareReads,
  ownerFn: ownerFn,
  scanSource: scanSource,
  scanDir: scanDir,
  keyOf: keyOf,
  runSelfCheck: runSelfCheck,
  summarize: summarize,
  DIR: DIR
};

// ---- CLI ----

if (require.main === module) {
  const selfBad = runSelfCheck();
  if (selfBad.length) {
    console.error('自检失败 ' + selfBad.length + ' 格 —— 本审计的结论不可信，先修脚本：');
    selfBad.forEach(function (b) { console.error('  ✗ ' + b); });
    process.exit(2);
  }
  console.log('自检：' + SELF_CASES.length + ' 格全过（同行 try / 跨行 try / 无 try / catch 体 / ' +
    '正则吞段 / 助手自身 / 注释 / 未闭合块注释 / 模板 ${}）');

  const results = scanDir(DIR);
  const asJson = process.argv.indexOf('--json') !== -1;
  if (!asJson) {
    results.forEach(function (r) {
      r.rows.forEach(function (row) {
        if (ALLOWED_FNS.indexOf(row.fn) !== -1) return;
        console.log((row.inTry ? 'OK   ' : '危险  ') + row.file + ':' + row.line + ':' +
          row.col + '  [' + row.fn + ']  当下在 ' + row.frameKind + ' 里');
        console.log('        ' + row.text.slice(0, 110));
      });
    });
  }

  const sum = summarize(results);
  if (asJson) {
    console.log(JSON.stringify({
      selfChecks: SELF_CASES.length,
      files: sum.files,
      reads: sum.reads,
      risky: sum.risky,
      guarded: sum.guarded,
      inHelpers: sum.inHelpers,
      rawHits: sum.rawHits,
      codeHits: sum.codeHits,
      depthTotal: sum.depthTotal,
      problems: sum.problems,
      riskyRows: sum.riskyRows
    }, null, 2));
    process.exit(sum.risky || sum.problems.length ? 1 : 0);
  }

  console.log('');
  console.log('扫了 ' + sum.files + ' 个片段：裸读共 ' + (sum.risky + sum.guarded) +
    ' 处（另在安全助手内部 ' + sum.inHelpers + ' 处）—— 被 try 包住 ' + sum.guarded +
    ' 处，**没有保护 ' + sum.risky + ' 处**');

  // ---- 自校验：词法器有没有把某一段整体吞掉、报出来的行列对不对得上原文 ----
  console.log('');
  console.log('自校验：原文命中 ' + sum.rawHits + ' 行，剥注释/字符串后命中 ' + sum.codeHits + ' 处');
  if (sum.problems.length) {
    console.log('  ⚠️ 词法/对位自证不过，上面的计数不可信：');
    sum.problems.forEach(function (p) { console.log('     ' + p); });
    process.exit(2);
  }
  console.log('  ✅ 没有整段被吞，且每一处的行列都回原文核对过');

  if (sum.risky) {
    console.log('');
    console.log('⚠️ 没有保护的这些，一旦命中跨域 iframe 就会抛 SecurityError。');
    console.log('   看它们会不会冒泡到 _runTick：若调用链上没有 try/catch，整轮调度会停摆。');
    process.exit(1);
  }
  process.exit(0);
}
