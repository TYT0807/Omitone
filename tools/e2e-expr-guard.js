'use strict';
/**
 * e2e 页面脚本串可解析守卫（任务 #139）。
 *
 * 要拦的事：`tools/browser-e2e.js` 里那些**拼成字符串、再交给 `Runtime.evaluate` 的页面脚本**
 * 有语法错。批次 87 实测踩过：一段 `'…' + '…' + '…'` 折叠出来的串少写一个右花括号，
 * 于是 `node --check` 全绿、集成测试全绿、`--validate-fixtures` 也全绿（它只管夹具 HTML），
 * 要跑完整整一轮 e2e 才报「页面抛异常: SyntaxError: Unexpected token 'catch'」——
 * 而且报的是**页面**抛的，不带行号，人得从场景名反推是哪一串。
 *
 * 这一族的成因很具体：JS 源码本身合法（那只是字符串），错在**字符串的内容**，
 * 所以守卫必须把内容折叠出来再解析一次。
 *
 * 覆盖范围（说清楚，别让人以为它什么都管）：
 *   1. `X.evaluate(<纯字面串>)` —— 只由字符串字面量与 `+` 组成的实参；
 *   2. `waitFor(X, <纯字面串>)` 的**第二个**实参（它最终发的是同一个 evaluate）。
 * 不覆盖（计入 `skipped` 并**当场打印条数**，免得"零条问题"被读成"全都干净"）：
 *   含变量、模板串、函数引用的实参 —— 那些折叠不出唯一内容；
 *   它们多来自 `runIn(client, function(){…})` 那类**从真函数 toString() 生成**的写法，
 *   内容由 `node --check` 直接保证，比这一族更强。
 *
 * ⚠️ 解析失败先换一种包裹再判一次：`return 1` 这种**函数体片段**按脚本解析必红，
 *   而它是合法内容。两种形状都解析不了才算真错 ——
 *   AGENTS §5：**会误报的守卫和没有守卫一样害人**，假红的代价是人开始忽略这条守卫。
 */

var vm = require('vm');

function isIdent(c) { return /[A-Za-z0-9_$]/.test(c); }

/**
 * 单遍扫描源码，产出**代码上下文里**（不在字符串/注释/正则字面量里）的调用点。
 * 必须自己走一遍：`var s = 'c.evaluate("(function(){")'` 拿正则去匹配会当成真调用点，
 * 九格自证里有这两格（注释里的、字符串里的）。
 */
function findEntries(src) {
  var out = [];
  var i = 0;
  var n = src.length;
  var lastCode = '';   // 上一个非空白代码字符 —— 用来分「除号」与「正则起始」（经典启发式）
  while (i < n) {
    var c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      var end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/') {
      // 只有前一个代码字符不可能是"操作数的结尾"时，这个 / 才是正则字面量的开头
      if (lastCode === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastCode)) {
        i = skipRegex(src, i);
        continue;
      }
    }
    if (c === '.' && src.startsWith('evaluate', i + 1)) {
      var open = skipSpaceTo(src, i + 1 + 'evaluate'.length);
      if (src[open] === '(') {
        out.push({ open: open, argSlot: 0 });
        lastCode = ')';
        i = open + 1;
        continue;
      }
    }
    if (c === 'w' && src.startsWith('waitFor', i) &&
        !isIdent(src[i - 1] || '') && !isIdent(src[i + 7] || '')) {
      var open2 = skipSpaceTo(src, i + 7);
      if (src[open2] === '(') {
        out.push({ open: open2, argSlot: 1 });
        lastCode = ')';
        i = open2 + 1;
        continue;
      }
    }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out;
}

function skipSpaceTo(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function skipQuoted(src, i, quote) {
  var n = src.length;
  i++;
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return n;
}

function skipTemplate(src, i) {
  var n = src.length;
  i++;
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      var d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') d--;
        else if (src[i] === '"' || src[i] === "'") { i = skipQuoted(src, i, src[i]) - 1; }
        else if (src[i] === '`') { i = skipTemplate(src, i) - 1; }
        i++;
      }
      continue;
    }
    i++;
  }
  return n;
}

function skipRegex(src, i) {
  var n = src.length;
  i++;
  var inClass = false;
  while (i < n) {
    var c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return i;           // 正则不跨行：当作没吃掉
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;   // 修饰符
      return i;
    }
    i++;
  }
  return n;
}

/** 从 openIdx（左圆括号）读出括号配平的实参正文；不配平交 null。 */
function readArgs(src, openIdx) {
  var n = src.length;
  var i = openIdx;
  var depth = 0;
  while (i < n) {
    var c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      if (src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; }
      else { var end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; }
      continue;
    }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
      if (depth < 0) return null;
    }
    i++;
  }
  return null;
}

/** 按**顶层逗号**切开（字符串/模板/括号里的逗号不算）。 */
function splitTopLevel(argsText) {
  var out = [];
  var buf = '';
  var depth = 0;
  var i = 0;
  var n = argsText.length;
  while (i < n) {
    var c = argsText[i];
    if (c === '"' || c === "'") { var q = c; var a = i; i = skipQuoted(argsText, i, q); buf += argsText.slice(a, i); continue; }
    if (c === '`') { var b = i; i = skipTemplate(argsText, i); buf += argsText.slice(b, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(buf); buf = ''; i++; continue; }
    buf += c;
    i++;
  }
  out.push(buf);
  return out;
}

/**
 * 只认「字面量 + 字面量 + …」这一族，折叠成一条字符串。
 * 出现标识符、模板串、别的运算符就交 null（= 折叠不出唯一内容 → skipped）。
 */
function foldLiterals(seg) {
  var text = String(seg);
  var parts = [];
  var i = 0;
  var n = text.length;
  var expect = 'string';
  while (i < n) {
    var c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (expect === 'plus') {
      if (c === '+') { i++; expect = 'string'; continue; }
      return null;
    }
    if (c === '`') return null;
    if (c === '"' || c === "'") {
      var j = i + 1;
      var closed = false;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '\n') return null;   // 单/双引号串不裸换行 → 这不是纯字面串
        if (text[j] === c) { closed = true; break; }
        j++;
      }
      if (!closed) return null;
      parts.push(text.slice(i, j + 1));
      i = j + 1;
      expect = 'plus';
      continue;
    }
    return null;
  }
  if (!parts.length || expect !== 'plus') return null;
  // 纯字面量 + 加号：不含标识符，空沙箱里折一下即可
  var folded = vm.runInNewContext('(' + parts.join(' + ') + ')', {}, { timeout: 500 });
  return typeof folded === 'string' ? folded : null;
}

/** 脚本本体 / 函数体片段，两种形状都解析不了才算真错。 */
function parseFails(code) {
  try { new vm.Script(code, { filename: 'e2e-expr' }); return null; } catch (e) { /* 再试函数体 */ }
  try {
    new vm.Script('(async function(){' + code + '})()', { filename: 'e2e-expr' });
    return null;
  } catch (e2) {
    return String((e2 && e2.message) || e2).split('\n')[0];
  }
}

function lineOf(src, idx) {
  var line = 1;
  for (var i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

/** 扫一份源码 → {checked, skipped, total, problems:[{file,line,why,head}]}。 */
function scan(src, label) {
  var text = String(src);
  var entries = findEntries(text);
  var checked = 0;
  var skipped = 0;
  var problems = [];
  entries.forEach(function (en) {
    var argsText = readArgs(text, en.open);
    if (argsText === null) { skipped++; return; }
    var seg = splitTopLevel(argsText)[en.argSlot];
    if (seg === undefined) { skipped++; return; }
    var folded = foldLiterals(seg);
    if (folded === null) { skipped++; return; }
    checked++;
    var why = parseFails(folded);
    if (why) problems.push({ file: label || 'e2e', line: lineOf(text, en.open), why: why, head: folded.slice(0, 90) });
  });
  return { checked: checked, skipped: skipped, total: entries.length, problems: problems };
}

/**
 * 九格自证。⚠️ `checked` / `skipped` 也要钉 ——
 * 只钉"红几条"的话，守卫整个不认调用点也会报"0 条问题"通过（AGENTS §5 第四类假绿）。
 */
function selfTest() {
  var cases = [
    { name: '1 干净的单串', src: "c.evaluate('(function(){return 1;})()');", red: 0, checked: 1, skipped: 0 },
    {
      name: '2 干净的折行拼接', red: 0, checked: 1, skipped: 0,
      src: "c.evaluate('(function(){var a=1;' +\n  'return a;})()');"
    },
    {
      name: '3 少一个右花括号（批次 87 那一族）必报', red: 1, checked: 1, skipped: 0,
      src: "c.evaluate('(function(){try{x();}catch(e){});');"
    },
    { name: '4 函数体片段（顶层 return）不许报', src: "c.evaluate('return document.hidden;');", red: 0, checked: 1, skipped: 0 },
    { name: '5 含变量只计 skipped', src: "c.evaluate('x=' + n + ';');", red: 0, checked: 0, skipped: 1 },
    { name: '6 模板串只计 skipped', src: 'c.evaluate(`x=${n}`);', red: 0, checked: 0, skipped: 1 },
    { name: '7 waitFor 取第二个实参', src: "waitFor(c, '(function(){return 1})');", red: 0, checked: 1, skipped: 0 },
    { name: '8 waitFor 的坏表达式要报', src: "waitFor(c, '(function(){return 1);');", red: 1, checked: 1, skipped: 0 },
    {
      name: '9 注释里与字符串里的调用点都不算（含正则字面量不打乱扫描）', red: 0, checked: 1, skipped: 0,
      src: "// c.evaluate('(function(){');\n" +
        "var s = 'c.evaluate(\"(function(){\");';\n" +
        "var re = /['\"]\\)/g;\n" +
        "c.evaluate('(function(){return re.test(s);})()');"
    }
  ];
  var bad = [];
  cases.forEach(function (t) {
    var r = scan(t.src, 'selftest');
    if (r.problems.length !== t.red) {
      bad.push(t.name + '：期望红 ' + t.red + ' 条，实报 ' + r.problems.length + ' 条' +
        (r.problems[0] ? '（' + r.problems[0].why + ' ｜ ' + r.problems[0].head + '）' : ''));
    }
    if (r.checked !== t.checked) {
      bad.push(t.name + '：期望折叠解析 ' + t.checked + ' 条，实报 ' + r.checked + ' 条（覆盖面虚报=守卫不存在）');
    }
    if (r.skipped !== t.skipped) {
      bad.push(t.name + '：期望跳过 ' + t.skipped + ' 条，实报 ' + r.skipped + ' 条');
    }
  });
  return bad;
}

exports.scan = scan;
exports.selfTest = selfTest;

if (require.main === module) {
  var fs = require('fs');
  var path = require('path');
  var grid = selfTest();
  if (grid.length) {
    console.log('  ❌ 九格自证未过：\n      ' + grid.join('\n      '));
    process.exit(1);
  }
  console.log('  ✅ 九格自证全过（坏串必报、函数体片段不误报、变量与模板串计入 skipped、' +
    '注释/字符串/正则里的调用点不算）');
  var target = process.argv[2] || path.join(__dirname, 'browser-e2e.js');
  var res = scan(fs.readFileSync(target, 'utf8'), path.basename(target));
  console.log('页面脚本串守卫：' + path.basename(target) + ' 共认到 ' + res.total + ' 处页面脚本入口，' +
    '其中 ' + res.checked + ' 条纯字面串已折叠解析，' + res.skipped + ' 条含变量/模板串（由真函数 toString() 保证）');
  if (res.problems.length) {
    res.problems.forEach(function (p) {
      console.log('  ❌ ' + p.file + ':' + p.line + ' —— ' + p.why + '\n      串开头：' + p.head);
    });
    process.exit(1);
  }
  console.log('  ✅ 全部可解析');
  process.exit(0);
}
