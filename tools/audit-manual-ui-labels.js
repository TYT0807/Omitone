#!/usr/bin/env node
/* audit-manual-ui-labels.js —— 核「说明书教的界面字样」是否就是代码里真实会显示的那几个字。
 *
 * 为什么要这一条（2026-11-14，批次 56）：
 *   说明书图 3 画的是右下角状态面板，原来那四行写的是「运行中 / 当前任务：播放视频 /
 *   进度：2.1 节 / 共 8 节 / 最近事件：answer filled 10/10」—— 后两行**面板上根本没有**，
 *   第一行也不是面板会打的字（`task` 的兜底字面是「运行中」，但徽标那一格只会说
 *   正常运行 / 等待中 / 注意 / 异常运行）。弹窗那一格同理：源码注释自己就写着
 *   「写成『运行中』就是骗人」，真实字样是「已开启 / 未开启」。
 *   这类过期**一条测试都不会红**：界面照常工作，只有新手照说明书去认界面时
 *   被引到错方向（「我这儿写的不是这四个字，是不是坏了」）。
 *
 * 判据口径（**故意只做三件事**，放宽就会误报）：
 *   ① 取值从**代码**读，不写死词表：`content.js` 的 `setStatusPanel` 里那份 `labels` 表
 *      + `popup/popup.js` 的 `runState.textContent = running ? … : …` 两个分支
 *      + `content.js` 的 `jobKindLabel` 那份表（面板第二行「执行任务：××」）。
 *      读不出来（锚点丢了 / 认出多处 / 值为空串）一律**报红**，不许当成"没东西要核"。
 *   ② 每个真实取值必须在 `docs/manual.html` 的**可见正文**里逐字出现。
 *      注释里、`<script>` / `<style>` 里出现的**不算**（用户看不见）；
 *      被行内标签加粗切开（`正常<b>运行</b>`）算出现，被块级标签切开（两个 `<p>`）不算。
 *   ③ 面板第二行会出现的**英文种类键**（从仲裁真源 `src/page/60-tasks-detect.js` 读
 *      `fromDom = 'x'` 与兜底 `|| 'other'`）必须在 `jobKindLabel` 里有中文取值。
 *      少一个键 = 那一格直接打英文原词（`vote` 漏了三周，说明书连它长什么样都写不出）。
 *
 * 不核什么：面板 `task` / `detail` 那两行的**动态句子**（章节切换中、附件数：N …）——
 *   它们是拼出来的整句，取值表形状一变就会误报，能核住的是「有哪几种字」。
 *
 * 用法：
 *   node tools/audit-manual-ui-labels.js            # 核真说明书，有问题退出 1
 *   node tools/audit-manual-ui-labels.js --json     # 同上，机器可读
 *   node tools/audit-manual-ui-labels.js --selftest # 十一格自证，不过退出 2
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var CONTENT_JS = 'content.js';
var POPUP_JS = 'popup/popup.js';
var DETECT_JS = 'src/page/60-tasks-detect.js';
var MANUAL = 'docs/manual.html';   // 消息里要出现它，用正斜杠写死，别让 Windows 反斜杠混进人读的那句话

/* ---------------------------------------------------------------- 真值 */

/** 从 `function 名字(` 之后取到与之配对的右花括号，返回整段函数体（含最外层括号）。 */
function findFunctionBody(txt, name) {
  var sig = 'function ' + name + '(';
  var at = txt.indexOf(sig);
  if (at < 0) return { body: '', error: '没找到 function ' + name + '(' };
  if (txt.indexOf(sig, at + 1) >= 0) {
    return { body: '', error: 'function ' + name + '( 出现不止一处，取哪一份不确定' };
  }
  var open = txt.indexOf('{', at + sig.length);
  if (open < 0) return { body: '', error: 'function ' + name + ' 后面没有函数体' };
  var depth = 0, i = open;
  while (i < txt.length) {
    var ch = txt[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(txt, i, ch); continue; }
    if (ch === '/' && txt[i + 1] === '/') { i = skipLineComment(txt, i); continue; }
    if (ch === '/' && txt[i + 1] === '*') { i = skipBlockComment(txt, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { body: txt.slice(open, i + 1), error: '' };
    }
    i++;
  }
  return { body: '', error: 'function ' + name + ' 的函数体花括号没配上' };
}

function skipString(txt, i, quote) {
  var j = i + 1;
  while (j < txt.length) {
    if (txt[j] === '\\') { j += 2; continue; }
    if (txt[j] === quote) return j + 1;
    j++;
  }
  return txt.length;
}
function skipLineComment(txt, i) {
  var nl = txt.indexOf('\n', i);
  return nl < 0 ? txt.length : nl;
}
function skipBlockComment(txt, i) {
  var end = txt.indexOf('*/', i + 2);
  return end < 0 ? txt.length : end + 2;
}

/** 把 `{ normal: '正常运行', … }` 这种字面量拆成 [{key, text}]（值必须是字符串字面量）。 */
function readLiteralPairs(objText) {
  var out = [];
  var re = /(^|[{,])(?:\s*)([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*(['"])([^'"\\]*)\3/g;
  var m;
  while ((m = re.exec(objText))) {
    out.push({ key: m[2].replace(/^['"]|['"]$/g, ''), text: m[4] });
  }
  return out;
}

/** 找出 `名字 = {` 在那个范围内出现几次、并取第一份的花括号内容。 */
function findObjectLiteral(txt, anchor) {
  var hits = txt.split(anchor).length - 1;
  if (hits !== 1) return { obj: '', error: anchor + ' 命中 ' + hits + ' 次（要求恰好 1 次）' };
  var open = txt.indexOf('{', txt.indexOf(anchor));
  if (open < 0) return { obj: '', error: anchor + ' 后面没有花括号' };
  var depth = 0, i = open;
  while (i < txt.length) {
    var ch = txt[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(txt, i, ch); continue; }
    if (ch === '/' && txt[i + 1] === '/') { i = skipLineComment(txt, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { obj: txt.slice(open, i + 1), error: '' };
    }
    i++;
  }
  return { obj: '', error: anchor + ' 的花括号没配上' };
}

/**
 * 读出「界面上真实会显示的那几个字」。
 * 返回 `{ labels: [{from, text}], readErrors: [字符串] }` ——
 * ⚠️ 读不出来时**必须**留下 readErrors，绝不能返回一个空 labels 就完事：
 * 空清单在下游长得像"全部核过了"。
 */
function readUiLabels(root) {
  var labels = [];
  var readErrors = [];

  function read(rel) {
    try {
      return fs.readFileSync(path.join(root || ROOT, rel), 'utf8');
    } catch (e) {
      readErrors.push(rel + ' 读不到：' + String((e && e.message) || e));
      return '';
    }
  }

  // ① content.js 的 status 徽标取值表（必须锚在 setStatusPanel 里 —— content.js 还有
  //    第二份同形状 labels（jobKindLabel），全局找 `labels = {` 会命中 2 次拿错那份）
  var cTxt = read(CONTENT_JS);
  if (cTxt) {
    var fn = findFunctionBody(cTxt, 'setStatusPanel');
    if (fn.error) {
      readErrors.push(CONTENT_JS + ' 的状态徽标取值表锚点失效：' + fn.error);
    } else {
      var lit = findObjectLiteral(fn.body, 'labels = {');
      if (lit.error) {
        readErrors.push(CONTENT_JS + ' 的状态徽标取值表锚点失效：' + lit.error);
      } else {
        var pairs = readLiteralPairs(lit.obj);
        if (!pairs.length) {
          readErrors.push(CONTENT_JS + ' 的状态徽标取值表里读不出任何「键: ' + "'字样'" +
            '」形式的取值 —— 取值表形状改了，审计口径要跟着改，不许静默当"没东西要核"');
        }
        pairs.forEach(function (p) {
          if (!p.text) {
            readErrors.push(CONTENT_JS + ' 的状态徽标取值「' + p.key + '」是空串 —— 值被读丢了');
            return;
          }
          labels.push({ from: CONTENT_JS + ' setStatusPanel 徽标 ' + p.key, text: p.text });
        });
      }
    }
  }

  // ② popup 顶部那颗状态徽章的两个分支字样
  var pTxt = read(POPUP_JS);
  if (pTxt) {
    var anchor = 'runState.textContent';
    var hits = pTxt.split(anchor).length - 1;
    var line = '';
    if (hits !== 1) {
      readErrors.push(POPUP_JS + ' 的顶部状态字样锚点失效：' + anchor + ' 命中 ' + hits + ' 次（要求恰好 1 次）');
    } else {
      line = pTxt.slice(pTxt.indexOf(anchor), pTxt.indexOf('\n', pTxt.indexOf(anchor)));
      var m = line.match(/=\s*[^?]{0,40}\?\s*(['"])([^'"]+)\1\s*:\s*(['"])([^'"]+)\3/);
      if (!m) {
        readErrors.push(POPUP_JS + ' 顶部状态那一格读不出「开 / 关」两个字样（这一行形状改了）：' +
          line.trim().slice(0, 80));
      } else {
        labels.push({ from: POPUP_JS + ' 顶部状态（开启）', text: m[2] });
        labels.push({ from: POPUP_JS + ' 顶部状态（未开启）', text: m[4] });
      }
    }
  }

  // ③ content.js 的面板第二行「执行任务：××」—— 任务种类词表
  //    （同样必须锚在函数体里：content.js 有两份同形状的 `labels = {`，全局找命中 2 次）
  if (cTxt) {
    var kfn = findFunctionBody(cTxt, 'jobKindLabel');
    if (kfn.error) {
      readErrors.push(CONTENT_JS + ' 的任务种类词表锚点失效：' + kfn.error);
    } else {
      var klit = findObjectLiteral(kfn.body, 'labels = {');
      if (klit.error) {
        readErrors.push(CONTENT_JS + ' 的任务种类词表锚点失效：' + klit.error);
      } else {
        var kpairs = readLiteralPairs(klit.obj);
        if (kpairs.length < 2) {
          readErrors.push(CONTENT_JS + ' 的任务种类词表只读出 ' + kpairs.length +
            ' 个「键: ' + "'字样'" + '」取值 —— 表形状改了，审计口径要跟着改，不许静默缩成"只核一种"');
        }
        kpairs.forEach(function (p) {
          if (!p.text) {
            readErrors.push(CONTENT_JS + ' 的任务种类词「' + p.key + '」是空串 —— 值被读丢了');
            return;
          }
          labels.push({ from: CONTENT_JS + ' jobKindLabel 种类 ' + p.key, text: p.text, kindKey: p.key });
        });
      }
    }
  }

  // ④ 键对账的**期望**从仲裁真源读（读不出来也要留话，不许当成"没键要对"）
  var kres = readJobKinds(root);
  if (kres.error) readErrors.push(kres.error);

  return { labels: labels, readErrors: readErrors, kinds: kres.kinds };
}

/**
 * 面板第二行**会出现**的英文种类键，从仲裁真源 src/page/60-tasks-detect.js 读：
 *   `fromDom = 'x'`（DOM 那一路逐族给出）与兜底 `|| 'other'`。
 * 读不出来时返回 `{ error: … }`，不许返回空清单 —— 空清单会让「键没配齐」这一格永远绿。
 */
function readJobKinds(root) {
  var txt;
  try {
    txt = fs.readFileSync(path.join(root || ROOT, DETECT_JS), 'utf8');
  } catch (e) {
    return { kinds: [], error: DETECT_JS + ' 读不到：' + String((e && e.message) || e) };
  }
  var kinds = [];
  var m, re = /fromDom = '([a-z][a-z-]*)'/g;
  while ((m = re.exec(txt))) {
    if (kinds.indexOf(m[1]) === -1) kinds.push(m[1]);
  }
  if (/\)\s*\|\|\s*'other'/.test(txt)) kinds.push('other');
  if (kinds.length < 2) {
    return { kinds: [], error: DETECT_JS + ' 里只读出 ' + kinds.length +
      ' 个任务种类键（`fromDom = ' + "'x'" + '` 的形状改了？）—— 对账这一格要跟着改口径，不许静默当"没键要对"' };
  }
  return { kinds: kinds, error: '' };
}

/* ---------------------------------------------------------------- 说明书可见正文 */

// 行内标签：删掉不产生边界（`正常<b>运行</b>` 页面上就是"正常运行"）。
// 其余标签（含 div / p / td / li / 块级 svg …）一律当一个边界，避免把两块互不相干的
// 文字拼成一个字样 —— 那种"自己拼出来的命中"会让这条闸只会绿。
var INLINE_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'span', 'code', 'tt', 'small', 'big',
  'sub', 'sup', 'mark', 'a', 'font', 'abbr', 'cite', 'q'];

/** HTML → 用户在页面上读到的那段文字（注释、script、style 全部去掉）。 */
function visibleText(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  s = s.replace(/<!\s?[a-zA-Z][^>]*>/g, ' ');        // DOCTYPE / 处理指令
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g, function (_m, name) {
    return INLINE_TAGS.indexOf(String(name).toLowerCase()) !== -1 ? '' : '\n';
  });
  s = s.replace(/&nbsp;/gi, ' ').replace(/&[A-Za-z][A-Za-z0-9]{1,7};/g, ' ');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return s.replace(/\s+/g, ' ');
}

/* ---------------------------------------------------------------- 审计 */

/**
 * @param labelInfo readUiLabels() 的返回值（也可传自证夹具）
 * @param manualHtml docs/manual.html 原文
 * @returns 问题清单（空数组 = 说明书教的字样与真实界面一致，且真源确实读出来了）
 */
function audit(labelInfo, manualHtml) {
  var info = labelInfo || { labels: [], readErrors: ['没有输入取值表'] };
  var issues = [];

  (info.readErrors || []).forEach(function (e) {
    issues.push('取值真源读不出来：' + e);
  });
  if (!info.labels || !info.labels.length) {
    if (!(info.readErrors || []).length) {
      issues.push('取值真源读不出来：一份取值都没读到，而这条闸报"没问题"等于它不存在');
    }
    return issues;
  }

  var text = visibleText(manualHtml);
  info.labels.forEach(function (lb) {
    if (!lb || !lb.text) return;   // 空值由 readUiLabels 报，这里不重复
    if (text.indexOf(lb.text) === -1) {
      issues.push('界面真实字样「' + lb.text + '」（真源 ' + lb.from + '）在 ' + MANUAL +
        ' 的可见正文里一次都没出现 —— 说明书教的界面字样和真实界面不一致');
    }
  });

  // 键对账：面板会说出的英文种类必须在 jobKindLabel 有中文取值，否则那一格打的是英文原词
  var kindKeys = {};
  info.labels.forEach(function (lb) {
    if (lb && lb.kindKey) kindKeys[lb.kindKey] = lb.text;
  });
  (info.kinds || []).forEach(function (k) {
    if (kindKeys[k]) return;
    issues.push('任务种类「' + k + '」（真源 ' + DETECT_JS + '）在 ' + CONTENT_JS +
      ' 的 jobKindLabel 里没有中文取值 —— 面板第二行会直接打英文原词「执行任务：' + k +
      '」，说明书也教不到它');
  });
  return issues;
}

/* ---------------------------------------------------------------- 自证 */

function fixtureLabels() {
  return [
    { from: CONTENT_JS + ' setStatusPanel 徽标 normal', text: '正常运行' },
    { from: CONTENT_JS + ' setStatusPanel 徽标 wait', text: '等待中' },
    { from: POPUP_JS + ' 顶部状态（开启）', text: '已开启' },
    { from: POPUP_JS + ' 顶部状态（未开启）', text: '未开启' },
    { from: CONTENT_JS + ' jobKindLabel 种类 video', text: '视频播放', kindKey: 'video' },
    { from: CONTENT_JS + ' jobKindLabel 种类 quiz', text: '测验答题', kindKey: 'quiz' }
  ];
}

function fixtureKinds() {
  return ['video', 'quiz'];
}

function buildCleanManual() {
  return '<!DOCTYPE html>\n<html>\n<head><title>说明书</title></head>\n<body>\n' +
    '<h1>状态面板</h1>\n<p>徽标只会说这几个词：正常运行 / 等待中。</p>\n' +
    '<p>弹窗顶部那一格是「已开启」或「未开启」。</p>\n' +
    '<p>面板第二行会说：执行任务：视频播放、执行任务：测验答题。</p>\n</body>\n</html>\n';
}

function replaceOnce(txt, from, to) {
  var hits = txt.split(from).length - 1;
  if (hits !== 1) throw new Error('自证锚点命中 ' + hits + ' 次（要求恰好 1）: ' + from);
  return txt.replace(from, to);
}

/**
 * 十一格阴性对照。⚠️ `check.js` 第 27 项另存一份按 pin 索引的期望逐格复算 ——
 * 照抄这里的 want，把 want 改成实际值就能让这条闸永远绿（同第 24 / 25 / 26 项的规矩）。
 * 夹具词表是**自己拼的**，不取真代码读出来的值：真代码加一个徽标词时这些格子不该跟着变。
 */
function selfTestCases() {
  var clean = buildCleanManual();
  var labs = fixtureLabels();
  var ok = { labels: labs, readErrors: [], kinds: fixtureKinds() };
  var root = ROOT;

  return [
    { pin: '干净说明书每个字样都点名', labelInfo: ok, txt: clean, want: 0, needle: '',
      note: '四个真实取值都在正文里 → 0 条（会误报的守卫和没有守卫一样害人）' },
    { pin: '少写一个徽标词', labelInfo: ok,
      txt: replaceOnce(clean, '正常运行 / 等待中', '正常运行'), want: 1, needle: '等待中',
      note: '正文删掉一个取值 → 恰好 1 条并点名那个词' },
    { pin: '字样只活在注释里', labelInfo: ok,
      txt: replaceOnce(clean, '<p>徽标只会说这几个词：正常运行 / 等待中。</p>',
        '<!-- 徽标只会说这几个词：正常运行 / 等待中 --><p>徽标只会说这几个词：等待中。</p>'),
      want: 1, needle: '正常运行',
      note: '只在 HTML 注释里出现 = 用户看不见 → 要报（注释不算正文）' },
    { pin: '字样被块级标签切开', labelInfo: ok,
      txt: replaceOnce(clean, '正常运行 / 等待中', '正常</p>\n<p>运行 / 等待中'),
      want: 1, needle: '正常运行',
      note: '两段 <p> 各装半句，页面上是两行 —— 拼出来的命中不算，要报' },
    { pin: '字样被行内标签加粗', labelInfo: ok,
      txt: replaceOnce(clean, '正常运行 / 等待中', '正常<b>运行</b> / 等待中'), want: 0, needle: '',
      note: '<b> 加粗不产生换行，页面上仍是"正常运行" → 不许误报' },
    { pin: '取值表一条都没读出', labelInfo: { labels: [], readErrors: ['content.js 里没读出状态徽标取值表'] },
      txt: clean, want: 1, needle: '取值真源读不出来',
      note: '锚点失效读出 0 个取值 → 必须响（空清单不能被当成"全部核过"）' },
    { pin: '真源只读出一半', labelInfo: { labels: labs,
      readErrors: [POPUP_JS + ' 顶部状态那一格读不出「开 / 关」两个字样'] },
      txt: clean, want: 1, needle: '取值真源读不出来',
      note: '两个真源只读出一个 → 也要响，不许静默缩成"核了四格"' },
    { pin: 'script 里的字样不算教给用户', labelInfo: ok,
      txt: replaceOnce(clean, '<p>弹窗顶部那一格是「已开启」或「未开启」。</p>',
        '<p>弹窗顶部那一格是「已开启」。</p><script>var t = "或「未开启」";</script>'),
      want: 1, needle: '未开启',
      note: '唯一一次出现被搬进 <script> → 用户看不见，要报' },
    { pin: '少写一个任务种类词', labelInfo: ok,
      txt: replaceOnce(clean, '执行任务：视频播放、执行任务：测验答题', '执行任务：视频播放'),
      want: 1, needle: '测验答题',
      note: '说明书漏教一种任务字样 → 恰好 1 条并点名那个词' },
    { pin: '种类表漏一个键', labelInfo: { labels: labs, readErrors: [],
      kinds: fixtureKinds().concat(['vote']) },
      txt: clean, want: 1, needle: '没有中文取值',
      note: '仲裁真源多出一种键而 jobKindLabel 没配中文 → 面板会打英文原词，要报（vote 漏过三周）' },
    { pin: '真说明书对真代码', labelInfo: readUiLabels(root),
      txt: fs.readFileSync(path.join(root, MANUAL), 'utf8'), want: 0, needle: '',
      note: '真取值 + 真说明书 → 0 条（现场这一格）' }
  ];
}

function selfTest() {
  var cases = selfTestCases();
  var bad = [];
  cases.forEach(function (c) {
    var issues;
    try {
      issues = audit(c.labelInfo, c.txt);
    } catch (e) {
      bad.push(c.pin + '：审计抛了 ' + String((e && e.message) || e));
      return;
    }
    var okCount = issues.length === c.want;
    var okNeedle = !c.needle || issues.some(function (x) { return x.indexOf(c.needle) !== -1; });
    if (!okCount || !okNeedle) {
      bad.push(c.pin + ' 期望 ' + c.want + ' 条并含「' + (c.needle || '无') + '」，实际 ' +
        issues.length + ' 条: ' + JSON.stringify(issues.slice(0, 4)));
    }
    console.log('  [' + (okCount && okNeedle ? 'ok' : 'FAIL') + '] ' + c.pin + ' — ' + c.note);
  });
  return bad;
}

/* ---------------------------------------------------------------- CLI */

function main() {
  var args = process.argv.slice(2);
  if (args.indexOf('--selftest') !== -1) {
    console.log('界面字样自证（' + selfTestCases().length + ' 格）：');
    var bad = selfTest();
    if (bad.length) {
      console.log('SELFTEST-FAIL\n' + bad.join('\n'));
      process.exit(2);
    }
    console.log(selfTestCases().length + ' 格全部通过');
    process.exit(0);
  }
  var info = readUiLabels(ROOT);
  var txt = fs.readFileSync(path.join(ROOT, MANUAL), 'utf8');
  var issues = audit(info, txt);
  if (args.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ issues: issues, labels: info.labels, readErrors: info.readErrors,
      kinds: info.kinds }, null, 2));
  } else if (issues.length) {
    console.log(MANUAL + ' 教的界面字样和真实界面不一致（' + issues.length + ' 处）：');
    issues.forEach(function (i) { console.log('  - ' + i); });
    console.log('  改法：字样缺哪一种就把哪一种写进 ' + MANUAL + ' 的可见正文；' +
      '种类键缺中文取值就补 ' + CONTENT_JS + ' 的 jobKindLabel —— 别改这条审计来迁就现状');
  } else {
    console.log(MANUAL + ' 的界面字样与代码一致（' + info.labels.length + ' 个真实取值全部点名，' +
      '其中任务种类 ' + info.kinds.length + ' 种全部有中文取值）');
  }
  process.exit(issues.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  readUiLabels: readUiLabels, readJobKinds: readJobKinds,
  visibleText: visibleText, audit: audit,
  selfTestCases: selfTestCases, selfTest: selfTest
};
