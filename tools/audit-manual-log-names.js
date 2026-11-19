/**
 * 说明书 §7「日志里的字样」那张表教的字样，必须能在代码里找到真发过的那一句。
 *
 * 为什么要这把尺（批次 117 实测）：第 27 项（`audit-manual-ui-labels.js`）只核**界面字样**
 * （面板徽标 / 弹窗顶部 / 任务种类词），说明书里那一张**日志名表**没有任何东西对着。
 * 本轮抓到两条过期，其中一条正是用户会照着找不到的那种：
 *   - 表里教 `quiz skipped: text stays garbled`，代码发的是 `quiz paused: text stays garbled`
 *     （`src/page/70-quiz-flow.js:1517`），而 `quiz skipped:` 这个前缀下面另有真句子
 *     （`quiz skipped: no question could be filled`，:1568）——
 *     **按冒号前的前缀比**会绿，所以这把尺必须比整句。
 *   - 同一条还带着已经改掉的旧行为描述（「已自动跳过」→ 实际是「暂停 90 秒再来」）。
 *
 * 判据（窄，但要各有一格只在它身上红）：
 *   1. 真源 = 代码里作为 `emitRuntimeLog` / `appendRuntimeLog` **第二个实参**出现**的字符串字面量**。
 *   2. 手册一格过 = 与某条字面量**整句相等**，或是某条字面量 + `:`／`：`／空格 + 后缀
 *      （`course switch declined: 这一科读不出进度` 那族站点原因中文、`llm prefix cache hit:180 …` 那族 meta）。
 *   3. **不认前缀**：`quiz skipped` 单独**不是**一条真日志名，所以 `quiz skipped: text stays garbled` 必须红。
 *   4. 中文散文格（`倒计时结束 / 视频或课件播完`）不参与核对，否则误报一片。
 *   5. 那张表**找不到**（表头/表体被人改形）→ 直接 FATAL，不许打印「0 条不对、全部通过」。
 *
 * 用法：
 *   node tools/audit-manual-log-names.js            // 核表；红了退出非 0
 *   node tools/audit-manual-log-names.js --selftest // 二十三格期望表；每格自己说走到没走到
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var MANUAL = path.join(ROOT, 'docs', 'manual.html');
var HEADER = '日志里的字样';

function read(f) { return fs.readFileSync(f, 'utf8'); }

/** 真源：哪些字符串真被当成日志名发出去过。 */
function emittedNames() {
  var files = [];
  var sliceDir = path.join(ROOT, 'src', 'page');
  fs.readdirSync(sliceDir).filter(function (n) { return /\.js$/.test(n); }).forEach(function (n) {
    files.push(path.join(sliceDir, n));
  });
  files.push(path.join(ROOT, 'content.js'));
  files.push(path.join(ROOT, 'background.js'));
  var out = [];
  var dynamic = 0;
  files.forEach(function (f) {
    var src = read(f);
    // emitRuntimeLog('warn', 'xxx'  /  appendRuntimeLog("info", `xxx`
    var re = /(?:emit|append)RuntimeLog\s*\(\s*/g;
    var m;
    while ((m = re.exec(src))) {
      // 第一个实参是**等级**，它自己也可能是变量或三元（`emitRuntimeLog(auditBad ? 'warn' : 'info', auditLabel, meta)`）
      // —— 先把那一格跳过去，再取名字那一格。
      var afterLevel = skipOneArg(src, re.lastIndex);
      if (afterLevel < 0) { dynamic++; continue; }
      var found = nameLiterals(src, afterLevel);
      if (!found.length) { dynamic++; continue; }
      found.forEach(function (v) {
        out.push({ name: v, where: path.basename(f) + ':' + lineOf(src, m.index), via: 'panel' });
      });
    }
    // ⚠️ `console.log('[Omitone] xxx'…)` 那一族**只出现在 F12 控制台**，全仓没有任何接管 `console` 的代码
    // （`src/page/30-log.js` 自己只有两句 console.log，AGENTS §2 #22 同一口径）——
    // 但手册 §7 有一行教的正是这种字样，所以它也算真源，只是**认得出它是控制台那一面**。
    consoleNamesFrom(src, path.basename(f)).forEach(function (n) { out.push(n); });
  });
  return { names: out, dynamic: dynamic };
}

/** 一个文件里所有 `console.*('[Omitone] …')` 打头的那句字样（冒号与尾巴已经去掉）。 */
function consoleNamesFrom(src, base) {
  var out = [];
  var cre = /console\.(?:log|warn|error)\s*\(\s*(['"`])\[Omitone\]\s*/g;
  var m;
  while ((m = cre.exec(src))) {
    // 字面量是从**那个引号**开始的（`[Omitone] ` 在引号里面），从引号处整条读回来再摘前缀
    var lit = literalAt(src, m.index + m[0].indexOf(m[1]));
    if (!lit) continue;
    var cn = lit.value.replace(/^\[Omitone\]\s*/, '').replace(/\s*[:：]\s*$/, '').trim();
    if (cn.length >= 3) out.push({ name: cn, where: base + ':' + lineOf(src, m.index), via: 'console' });
  }
  return out;
}

/** 跳过一整个实参，返回**逗号之后**的下标；括号先闭合（走到实参表外）就交回 -1。 */
function skipOneArg(src, pos) {
  var depth = 0;
  for (var i = pos; i < src.length; i++) {
    var c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return -1; depth--; continue; }
    if (c === ',' && depth === 0) return i + 1;
    if (c === "'" || c === '"' || c === '`') {
      var lit = literalAt(src, i);
      if (!lit) return -1;
      i = lit.end - 1;
    }
  }
  return -1;
}

/**
 * 名字实参那一整段（到顶层 `,` 或 `)` 为止）里的所有字符串字面量。
 * 为什么要一整段而不只第一个：代码里有 `pick ? 'a' : 'b'` 与 `'x' + (label ? '（' + label : '')`
 * 这种**拼出来的**名字（`src/page/20-dom.js:184`、`src/page/70-quiz-flow.js` 少答那一族）——
 * 只取第一段会把三元运算的第二个名字漏掉，手册教它时就是一次假红。
 */
function spanLiterals(src, pos, stops, depth0Only, keepShape) {
  var out = [];
  stops = stops || ',)';
  var depth = 0;
  for (var i = pos; i < src.length; i++) {
    var c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { if (stops.indexOf(')') >= 0) break; }
      else depth--;
      continue;
    }
    if (depth === 0 && (c === ',' || c === ';') && stops.indexOf(c) >= 0) break;
    if (c === "'" || c === '"' || c === '`') {
      var lit = literalAt(src, i);
      if (!lit) break;
      var v = lit.value.replace(/\s+$/, '');
      // `depth0Only`（回 `var 变量 = …` 那一手）本来是"只看顶层、别把函数实参里的选择器当名字"。
      // 但真码的三元链最后一支带括号 —— `src/page/75-quiz-dom.js:1836-1840`
      // 是 `: (auditChecked < auditChoice ? '…' : 'quiz fill audit ok');`，落在 depth 1。
      // 只认顶层会把这条**真发过的名字**漏掉，手册教它时就是一次假红
      // （会误报的守卫和没有守卫一样害人，AGENTS §5）。
      // 所以嵌套那一格改按**它长在什么位置上**判：三元／拼接的延续位算名字，调用实参与数组元素不算。
      var nested = depth0Only && depth > 0 && !isPhraseContinuation(src, i);
      // `keepShape`（第 35 项要用）：那条 `/[a-z]/i` 的形状筛是为了**不让选择器混进日志名**，
      // 但它会把**整句中文**的日志名一起丢掉 —— 实测 `检测到其他浏览器扩展注入了页面资源`
      // 从 418 条里消失，而那句真发过（`src/page/40-media.js:315`）。
      // 本工具那一族按「短 + 不含换行」筛够用；医生规则表要的是**全都要**，所以把这一格做成可选，
      // 默认关（本工具的判据与手册对账的期望表一个字没动）。
      if (v.length >= 3 && (keepShape || /[a-z]/i.test(v)) && v.indexOf('\n') < 0 && !nested) out.push(v);
      i = lit.end - 1;
    }
  }
  return out;
}

/** 这一发嵌套字面量是不是长在 `? : = + & |` 之后（三元／拼接的延续位）——那种才是名字。 */
function isPhraseContinuation(src, quoteIdx) {
  var j = quoteIdx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j >= 0 && /[?:=+&|]/.test(src[j]);
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

/**
 * 名字实参那一整段里的所有字面量；**若那一格是个变量**，回到 `var 变量 = …` 那一句再取一遍。
 * 为什么要有第二手：`src/page/75-quiz-dom.js:1835` 那一族先写
 * `var auditLabel = 条件 ? 'quiz fill audit: …' : 条件 ? '…' : 'quiz fill audit ok';`
 * 再 `emitRuntimeLog(等级, auditLabel, meta)` —— 只认实参那一格的话，
 * 手册教这种名字就会**假红**（本轮第一次跑就撞上了）。
 */
function nameLiterals(src, pos) {
  var found = spanLiterals(src, pos, ',)');
  if (found.length) return found;
  var head = src.slice(pos, pos + 80);
  var idm = /^\s*([A-Za-z_$][\w$]*)/.exec(head);
  if (!idm) return [];
  var out = [];
  var re = new RegExp('(?:var|let|const)\\s+' + idm[1].replace(/\$/g, '\\$') + '\\s*=', 'g');
  var m;
  while ((m = re.exec(src))) {
    // 只看**顶层那几段 + 三元／拼接延续位**（depth0Only）：`'a' : (b ? 'x' : 'y')` 要收，
    // 但 `foo('一些压根不是日志名的选择器')` 里的不能混进来当名字。
    spanLiterals(src, m.index + m[0].length, ';', true).forEach(function (v) { out.push(v); });
  }
  return out;
}

/** 从 pos 起读整条字符串字面量（单/双/反引号）；不是字面量就交回 null（不猜）。 */
function literalAt(src, pos) {
  var i = pos;
  while (i < src.length && /\s/.test(src[i])) i++;
  var q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  var buf = '';
  for (i = i + 1; i < src.length; i++) {
    var c = src[i];
    if (c === '\\') {
      var n = src[i + 1];
      buf += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i++;
      continue;
    }
    if (c === q) return { value: buf, end: i + 1 };
    buf += c;
  }
  return null;
}

/** 手册那一格：只取「日志里的字样」表每行第一个 td 里的 <code>。
 *  `html` / `minCells` 只给闸门喂合成表用；真表仍按「少于 10 格 = 形状不对」FATAL。 */
function manualCells(html, minCells) {
  var man = html || read(MANUAL);
  var floor = Number(minCells) > 0 ? Number(minCells) : 10;
  var h = man.indexOf(HEADER);
  if (h < 0) return { error: '手册里找不到表头「' + HEADER + '」' };
  var tableStart = man.lastIndexOf('<table', h);
  var tableEnd = man.indexOf('</table>', h);
  if (tableStart < 0 || tableEnd < 0) return { error: '表头附近圈不出那张 <table>' };
  var cells = [];
  var re = /<tr>([\s\S]*?)<\/tr>/g;
  re.lastIndex = tableStart;
  var m, ri = 0;
  while ((m = re.exec(man)) && m.index < tableEnd) {
    ri++;
    if (m[1].indexOf('<th') >= 0) continue;                       // 表头行不算数据
    var line = lineOf(man, m.index);
    var firstTd = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/);
    if (!firstTd) { cells.push({ row: ri, line: line, text: stripTags(m[1]), skip: true }); continue; }
    var codes = firstTd[1].match(/<code[^>]*>([\s\S]*?)<\/code>/g) || [];
    if (!codes.length) { cells.push({ row: ri, line: line, text: stripTags(firstTd[1]), skip: true }); continue; }
    codes.forEach(function (c) {
      cells.push({ row: ri, line: line, text: cellText(decode(stripTags(c))) });
    });
  }
  if (cells.length < floor) return { error: '那张表只圈出 ' + cells.length + ' 格，形状不对（判据 5）' };
  return { cells: cells };
}

/**
 * 手册把控制台那一族的字样写成 `[Omitone] xxx`（站点页面里 F12 打的就是带前缀的那一句）。
 * 核对时把前缀摘掉 —— **不许因为多了这个中括号就整格不对核对**，
 * 否则手册只要给某一行标出面别，那一行就从尺底下溜走了。
 */
function cellText(s) { return s.replace(/^\[Omitone\]\s*/, '').trim(); }

function stripTags(s) { return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/**
 * 只有**开头**长成英文日志名样子的格才核对。
 * ⚠️ 只判开头那一截，不判整格 —— 手册有一族是「真名 + 冒号 + 中文原因／meta」（
 * `course switch declined: 这一科读不出进度`、`study idle declined: …不点前进`），
 * 整格要求纯 ASCII 会把它们放成不对核对，那一族恰恰最该核（真名前缀写错没人管）。
 */
function looksLikeLogName(s) {
  return /^[A-Za-z][A-Za-z0-9 ()._,:'\-/]{5,}/.test(s);
}

/**
 * 这一格要不要核对。
 * ⚠️ 短名字（`start` 那种一个词的）若**整格正好等于一条真名**，也核对 ——
 * 否则手册写对一个短名、写错一个短名，都在"不对核对"那一格混过去。
 */
function isCheckable(text, names) {
  if (looksLikeLogName(text)) return true;
  return names.some(function (n) { return n.name === text; });
}

/**
 * 一格过不过。四格各自承重，缺一格就有一族手册过期抓不到：
 *   exact    —— 与某条真名整句相等
 *   composed —— 以某条真名开头，后面跟 `:`／`：`／空格（中文原因、meta 读数）
 *   family   —— 手册写了省略号（`course switch declined: …`）：省略号那一截必须是**某条真名的开头**，
 *               省略号只许代表"后面还有原因"，不许代表"这名字我自己编一个"
 *   abbrev   —— 整格是某条真名里的一段（手册摘了尾巴，如 `answers are not ready`
 *               ⊂ `block quiz submit because answers are not ready`，
 *               或 `video paused unexpectedly, resuming` ⊂ 带括注那条）；用户照这串搜得到
 * ⚠️ 反过来：**既不是任何真名的一段、又不以真名开头**的手册字样一律红 ——
 * `quiz skipped: text stays garbled`（真名是 `quiz paused: …`，`quiz skipped:` 下面另有别的句子）
 * 与两条真名各取一半拼出来的那种，都在这儿断。
 */
function matches(cell, names) {
  var best = null;
  var ellipsis = cell.indexOf('…') >= 0 || /\.\.\.$/.test(cell);
  var head = ellipsis ? cell.split('…')[0].replace(/\.\.\.\s*$/, '').trim() : cell;
  var words = cell.split(/\s+/).filter(Boolean).length;
  function take(kind, n, len) {
    var rank = { exact: 4, composed: 3, family: 2, abbrev: 1 };
    if (!best || rank[kind] > rank[best.kind] || (rank[kind] === rank[best.kind] && len > best.len)) {
      best = { ok: true, kind: kind, hit: n, len: len };
    }
  }
  names.forEach(function (n) {
    var nm = n.name;
    if (!nm) return;
    if (cell === nm) return take('exact', n, nm.length);
    if (cell.indexOf(nm + ':') === 0 || cell.indexOf(nm + '：') === 0 || cell.indexOf(nm + ' ') === 0) {
      return take('composed', n, nm.length);
    }
    if (ellipsis) {
      if (head.length >= 6 && (nm === head || nm.indexOf(head) === 0)) take('family', n, head.length);
      return;
    }
    if (cell.length >= 12 && words >= 2 && nm.indexOf(cell) >= 0) take('abbrev', n, cell.length);
  });
  return best || { ok: false };
}

/** 红了给个「最近的那条真名」，否则人只知道不存在、不知道笔误在哪。 */
function suggest(cell, names) {
  var head = cell.split(/[:\s]/)[0];
  var near = names.filter(function (n) { return n.name.indexOf(head) === 0; }).map(function (n) { return n.name; });
  return near.length ? near.slice(0, 4) : [];
}

function dump() {
  var reg = emittedNames();
  var got = manualCells();
  if (got.error) { console.log('FATAL: ' + got.error); return 1; }
  got.cells.forEach(function (c) {
    if (c.skip) { console.log('  [散文格·不核对] 第 ' + c.row + ' 行: ' + c.text); return; }
    var isName = isCheckable(c.text, reg.names);
    var r = isName ? matches(c.text, reg.names) : { ok: false };
    console.log('  [' + (isName ? (r.ok ? '过/' + r.kind : 'RED') : '跳过') + '] 第 ' + c.row + ' 行: ' + c.text +
      (isName && !r.ok ? ' ← 建议:' + suggest(c.text, reg.names).join(' / ') : ''));
  });
  console.log('  —— 真名 ' + reg.names.length + ' 条 / 拼自变量 ' + reg.dynamic + ' 处');
  return 0;
}

/**
 * 核对本体（不读盘、不打印）—— `tools/check.js` 第 32 项拿合成表喂它做阴性对照。
 * 判据只有一份：这里改了，CLI 与闸门一起变，不会各说各话。
 */
function evaluate(cells, names) {
  var checked = 0, skipped = 0, bad = [];
  (cells || []).forEach(function (c) {
    if (c.skip || !isCheckable(c.text, names)) { skipped++; return; }
    checked++;
    var r = matches(c.text, names);
    if (!r.ok) bad.push({ row: c.row, line: c.line, text: c.text, near: suggest(c.text, names) });
  });
  return { checked: checked, skipped: skipped, bad: bad, total: (cells || []).length };
}

function audit() {
  var reg = emittedNames();
  var got = manualCells();
  if (got.error) {
    console.log('FATAL: ' + got.error + ' —— 这张表不再被核对，先修表形或修本工具，别当通过。');
    return 1;
  }
  var res = evaluate(got.cells, reg.names);
  var checked = res.checked, skipped = res.skipped, bad = res.bad;
  var panel = reg.names.filter(function (n) { return n.via === 'panel'; }).length;
  var cons = reg.names.length - panel;
  console.log('[i] 日志名核对: 手册第 1 列取到 ' + got.cells.length + ' 格，核过 ' + checked +
    ' 条、按判据不核对 ' + skipped + ' 条（中文散文与短标签，见 --dump）；' +
    '代码里的真名 ' + reg.names.length + ' 条（面板 ' + panel + ' / 控制台 ' + cons +
    '，另有 ' + reg.dynamic + ' 处名字整个拼自变量，静态核不到）');
  if (!checked) {
    console.log('[X] 这一张格一条都没核对 —— 措辞被整体改写时扫描会静默变成 0 命中，那是最坏的一种绿（AGENTS §2 #21）。');
    return 1;
  }
  if (bad.length) {
    console.log('[X] 手册教了代码里从来不发的字样 ' + bad.length + ' 处：');
    bad.forEach(function (b) {
      console.log('    docs/manual.html:' + b.line + '（表内第 ' + b.row + ' 行）: ' + b.text +
        (b.near.length ? ' —— 代码里同前缀的真名: ' + b.near.join(' / ') : ' —— 代码里连同前缀都没有'));
    });
    console.log('    要改的是手册那一行，不是这把尺（AGENTS §4「要改文档，不许改判据」）。');
    return 1;
  }
  console.log('[ok] 手册教的 ' + checked + ' 条日志名都在代码里发得出来');
  return 0;
}

// —— 自检：每格自己说走到没走到，红在预期之外也算失败 ——
function selftest() {
  var reg = [
    { name: 'quiz paused: text stays garbled', where: 'x' },
    { name: 'quiz skipped: no question could be filled', where: 'x' },
    { name: 'llm prefix cache', where: 'x' },
    { name: 'course switch declined: auto switch is off', where: 'x' },
    { name: 'media playback stalled (decoder died)', where: 'x' },
    { name: 'block quiz submit because answers are not ready', where: 'x' },
    { name: 'video paused unexpectedly, resuming (anti background pause)', where: 'x' },
    { name: 'quiz answers count', where: 'x', via: 'console' },
    { name: 'start', where: 'x' }
  ];
  var pins = [
    ['①整句相等过', 'quiz paused: text stays garbled', true, 'exact'],
    ['②真名+冒号+中文原因过', 'llm prefix cache: 整份输入还凑不满一块', true, 'composed'],
    ['③真名+空格+meta 过', 'llm prefix cache hit:180 miss:120', true, 'composed'],
    ['④括号算名字一部分', 'media playback stalled (decoder died) 连续 40 秒', true, 'composed'],
    ['⑤手册摘掉真名尾巴算过', 'answers are not ready', true, 'abbrev'],
    ['⑥摘掉真名开头也算过', 'video paused unexpectedly, resuming', true, 'abbrev'],
    ['⑦同前缀换整句必须红', 'quiz skipped: text stays garbled', false, ''],
    ['⑧没听过的名字红', 'totally unknown log name here', false, ''],
    ['⑨中文散文不核对', '倒计时结束 / 视频或课件播完', null, ''],
    ['⑩太短又不等于真名，不核对', 'ok', null, ''],
    ['⑪短标签整格等于真名要核对', 'start', true, 'exact'],
    ['⑫省略号族：真名开头过', 'course switch declined: …', true, 'family'],
    ['⑬省略号族：编的名字红', 'course switch faked: …', false, ''],
    ['⑭两条真名各取一半拼出来要红', 'quiz paused: no question could be filled', false, '']
  ];
  var failed = 0;
  pins.forEach(function (p) {
    var label = p[0], cell = p[1], want = p[2], wantKind = p[3];
    var isName = isCheckable(cell, reg);
    var r = isName ? matches(cell, reg) : { ok: false, kind: '' };
    var gotOk = isName ? r.ok : null;
    var ok = (gotOk === want) && (want !== true || r.kind === wantKind);
    console.log((ok ? '  [ok] ' : '  [X]  ') + label + ' → 核对:' + (gotOk === null ? '跳过' : (gotOk ? '过(' + r.kind + ')' : '红')) +
      (ok ? '' : '，期望:' + (want === null ? '跳过' : (want ? '过(' + wantKind + ')' : '红'))));
    if (!ok) failed++;
  });
  // 取名那两手也要各有一格：真源收漏了，手册再多字也照旧"全绿"
  var c1 = consoleNamesFrom("        console.log('[Omitone] quiz answers count:', answers.length, answers);", 'x');
  var c2 = consoleNamesFrom("        console.log('who cares about this line');", 'x');
  var c3 = consoleNamesFrom("        console.warn('[Omitone] media repair failed');", 'x');
  // 取名那两手的直接探针：从一发调用里把名字格读回来
  function namesOfCall(code) {
    var m = /(?:emit|append)RuntimeLog\s*\(\s*/.exec(code);
    if (!m) return [];
    var pos = skipOneArg(code, m.index + m[0].length);
    if (pos < 0) return [];
    return nameLiterals(code, pos);
  }
  var v1 = namesOfCall("emitRuntimeLog(bad ? 'warn' : 'info', 'media repair failed', meta);");
  // ⚠️ 这一格必须照抄**真码那形状**（带括号的三元链尾巴）—— 上一版fixture写成扁平的，
  // 尺把真名漏了却照样绿（AGENTS §5「夹具要长得像现场，不像实现」）。真源：src/page/75-quiz-dom.js:1836-1840
  var v2 = namesOfCall("var auditLabel = a\n" +
    "        ? 'quiz fill audit: text answer not in a visible box'\n" +
    "        : (b ? 'quiz fill audit: value without visible selection' : 'quiz fill audit ok');\n" +
    "      emitRuntimeLog(auditBad ? 'warn' : 'info', auditLabel, meta);");
  var v3 = namesOfCall("emitRuntimeLog('info', 'plain ok name', meta);");
  var v4 = namesOfCall("emitRuntimeLog(level, msg, meta);");
  var v5 = namesOfCall("var auditLabel = pick ? 'media repair ok' : build(doc.querySelectorAll('.Cy_TITle'), ['.TiMu', 'div[class*=\"question\"]']);\n" +
    "      emitRuntimeLog('info', auditLabel, meta);");
  var extra = [
    ['⑮控制台那句收进真源', c1.length === 1 && c1[0].name === 'quiz answers count' && c1[0].via === 'console'],
    ['⑯不带 [Omitone] 的不收', c2.length === 0],
    ['⑰warn/error 那两发也收', c3.length === 1 && c3[0].name === 'media repair failed'],
    ['⑱手册带中括号前缀照常核对', matches(cellText('[Omitone] quiz answers count: N'), reg).kind === 'composed'],
    ['⑲等级是变量也要认到名字', v1.length === 1 && v1[0] === 'media repair failed'],
    ['⑳名字整个来自 var 三元链也要认到', v2.length === 3 && v2.indexOf('quiz fill audit ok') >= 0 && v2.indexOf('quiz fill audit: text answer not in a visible box') >= 0],
    ['㉑平常那一发照旧认得到', v3.length === 1 && v3[0] === 'plain ok name'],
    ['㉒名字是变量时交回空、记成动态', v4.length === 0],
    ['㉓赋值里的选择器不许混成名字', v5.length === 1 && v5[0] === 'media repair ok']
  ];
  extra.forEach(function (p) {
    console.log((p[1] ? '  [ok] ' : '  [X]  ') + p[0]);
    if (!p[1]) failed++;
  });
  var total = pins.length + extra.length;
  console.log(failed ? '[X] 自检失败 ' + failed + ' 格' : '[ok] 自检 ' + total + ' 格全对');
  return failed ? 1 : 0;
}

// 被 `tools/check.js` 第 32 项 require 时只交函数，不许顺手跑一遍审计再 process.exit（那会把整个自检掐死）
if (require.main === module) {
  var code = process.argv.indexOf('--selftest') >= 0 ? selftest()
    : (process.argv.indexOf('--dump') >= 0 ? dump() : audit());
  process.exit(code);
}

module.exports = {
  HEADER: HEADER,
  MANUAL: MANUAL,
  emittedNames: emittedNames,
  manualCells: manualCells,
  consoleNamesFrom: consoleNamesFrom,
  nameLiterals: nameLiterals,
  skipOneArg: skipOneArg,
  spanLiterals: spanLiterals,
  // 第 35 项（audit-diagnose-needles.js）要自己走一遍"注释 vs 字面量"的状态机，
  // 复用这一把而不是抄第二份 —— 两份扫描器必然分叉（AGENTS §2 #4 同一口径）。
  literalAt: literalAt,
  evaluate: evaluate,
  matches: matches,
  isCheckable: isCheckable,
  looksLikeLogName: looksLikeLogName,
  cellText: cellText
};
