/**
 * 白天／黑夜 × 四季那套主题变量，**底色与文字色必须成对存在，且算出来真的看得清**。
 *
 * 为什么要这把尺（会话任务 #191，2026-11-22 现场量出来的）：
 *   `popup/pet.css` 里舞台那五条底色（素底 + 四季天光）只写了白天那一版，
 *   而 `popup/popup.html` 的暗色档把 `--fg` 从近黑翻成近白 —— 于是暗夜下**近白字压在浅天光上**：
 *   真实 Edge 里逐格算 WCAG 对比度量到 `i#petRoleProp`「🩺」= **1.05**、底部六枚舞台键 = **2.84**
 *   （合格线 4.5），弹窗本体（设置页）却全绿 —— 所以这不是"暗色整体偏淡"，
 *   是**成对的东西只写了一半**。
 *   ⚠️ 这种漏**一条测试都不会红**：文件语法正常、集成与真实浏览器全绿，只有人在黑夜里看得见。
 *
 * 判据（窄，且每格要各自承重）：
 *   1. **结构**：舞台底色（素底 + 4 季）每一条都得在 `@media (prefers-color-scheme:dark)`
 *      里有一份同名孪生；`--fg / --fg-2 / --muted / --bg / --card` 两档都要声明**且取值不许相同**
 *      （"暗档照抄浅档"与"暗档没写"是同一件事的两张脸）。
 *   2. **数学**：成对的（文字 token × 实际落底的颜色）算 WCAG 对比度，**逐对 ≥ 4.5**。
 *      舞台那一对拿渐变**最后一个色标**当底（文字排在页面下部，量的是它真压着的那一档）；
 *      半透明的 `--card` 先按 alpha 合成到 `--bg` 再算。
 *   3. **引用普查**：`var(--x)` 引用的 token 必须有人声明（含 `popup/*.js` 运行时 `setProperty` 写的），
 *      没声明又**不带兜底** → 红；没声明但带兜底 → 必须逐名落在台账里（新冒出来要红，不许静默靠兜底）。
 *   4. **读不出单独占一格**（AGENTS §2 #12）：文件缺失／`:root` 解析不出／一季底色都没扫到／
 *      某个色值解析不出 —— 各自说话并退出非 0，**绝不当成通过**。
 *
 * 这一族**不核对**强调色（`--accent*` / `--error` / `--warn` / `--ok`）—— 它们目前两档逐字节相同，
 * 而且同一枚色相既当"深底上的链接字"又当"白字垫底的按钮面"，两个方向的要求互相冲突
 * （实测数字与推导见 `docs/theme-191-dark-audit.md`），要动得先由用户裁"要不要拆成字色／底色两枚"。
 *
 * 用法：
 *   node tools/audit-dark-theme.js            // 核对；红了退出非 0
 *   node tools/audit-dark-theme.js --dump     // 只打印解析回来的两档 token 与四季底色
 *   node tools/audit-dark-theme.js --selftest // 逐格期望表；每格自己说走到没走到
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var POPUP_HTML = path.join(ROOT, 'popup', 'popup.html');
var PET_CSS = path.join(ROOT, 'popup', 'pet.css');
var POPUP_DIR = path.join(ROOT, 'popup');
var AA = 4.5;

// 舞台底色的五条：素底 + 四季（选择器里 `body.im` 才是天光本体，`body.im::before` 是压暗渐层，不参与）
var SKY_KEYS = ['floor', 'spring', 'summer', 'autumn', 'winter'];
// 中性档：两档必须都声明且取值不同
var RAMP = ['--fg', '--fg-2', '--muted', '--bg', '--card'];
// 没声明但带兜底的引用（靠兜底活着，逐名登记；新增一名就要红一次）
var FALLBACK_LEDGER = ['--fg-3'];
// 成对核对的文字色（强调色一族故意不在此列，见文件头）
var INK = ['--fg', '--fg-2', '--muted'];

function read(f) { return fs.readFileSync(f, 'utf8'); }

/** 注释剥成等长空格 —— 位置不动，否则后面的偏移换算整体错位（AGENTS §5）。 */
function stripComments(s) {
  var out = s.split('');
  var i = 0;
  while (i < out.length) {
    if (out[i] === '/' && out[i + 1] === '*') {
      var j = s.indexOf('*/', i + 2);
      if (j < 0) j = out.length; else j += 2;
      for (var k = i; k < j; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
      i = j;
    } else if (out[i] === '/' && out[i + 1] === '/') {
      var e = s.indexOf('\n', i);
      if (e < 0) e = out.length;
      for (var k2 = i; k2 < e; k2++) out[k2] = ' ';
      i = e;
    } else i++;
  }
  return out.join('');
}

/** `@media (prefers-color-scheme:dark)` 的**花括号区间**（可能有多段，全部收进来）。 */
function darkRanges(css) {
  var ranges = [];
  var re = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*/g;
  var m;
  while ((m = re.exec(css))) {
    var open = css.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    var depth = 0;
    for (var i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) { ranges.push([open + 1, i]); break; }
      }
    }
  }
  return ranges;
}
function inRange(ranges, pos) {
  for (var i = 0; i < ranges.length; i++) if (pos >= ranges[i][0] && pos < ranges[i][1]) return true;
  return false;
}

/** 把一段 CSS 切成「选择器 → 声明串」，带上它在原文里的起始位置。 */
function rulesOf(css, ranges) {
  var out = [];
  var re = /([^{}]+)\{([^{}]*)\}/g;
  var m;
  while ((m = re.exec(css))) {
    if (m[1].trim().charAt(0) === '@') continue;
    out.push({
      sel: m[1].trim().replace(/\s+/g, ' '),
      body: m[2],
      dark: inRange(ranges, m.index)
    });
  }
  return out;
}

function declMap(body) {
  var map = {};
  body.split(';').forEach(function (d) {
    var i = d.indexOf(':');
    if (i < 0) return;
    var k = d.slice(0, i).trim();
    if (k) map[k] = d.slice(i + 1).trim();
  });
  return map;
}

/** 两档 token 表：`light` = :root 在暗色 @media 之外的那一份，`dark` = 之内的那一份。 */
function tokensByMode(rules) {
  var t = { light: {}, dark: {} };
  rules.forEach(function (r) {
    if (r.sel.indexOf(':root') < 0) return;
    var d = declMap(r.body);
    Object.keys(d).forEach(function (k) {
      if (k.slice(0, 2) !== '--') return;
      t[r.dark ? 'dark' : 'light'][k] = d[k];
    });
  });
  return t;
}

/** 舞台底色：`{light:{floor:'#…',spring:'渐变原串'…}, dark:{…}}`。 */
function skiesByMode(rules) {
  var s = { light: {}, dark: {} };
  rules.forEach(function (r) {
    if (/::/.test(r.sel)) return;              // 压暗渐层不是天光本体
    if (/\bbody\.im\b/.test(r.sel) === false) return;
    var d = declMap(r.body);
    var bg = d.background || d['background-color'];
    if (!bg) return;
    var season = /data-season\s*=\s*["']?([a-z]+)/.exec(r.sel);
    var key = season ? season[1] : (/html/.test(r.sel) ? null : 'floor');
    if (!key || SKY_KEYS.indexOf(key) < 0) return;
    s[r.dark ? 'dark' : 'light'][key] = bg;
  });
  return s;
}

// ---------------- 颜色 ----------------

function parseColor(s) {
  if (!s) return null;
  var str = String(s).trim();
  var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (m) {
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)], a: 1 };
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(str);
  if (m) {
    var p = m[1].split(/[,\s/]+/).filter(Boolean).map(function (x) { return parseFloat(x); });
    if (p.length < 3 || p.some(isNaN)) return null;
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
/** 一串颜色里取**最后一个**能解析的（渐变 = 最外/最下那一档 = 文字真压着的那一档）。 */
function lastColor(decl) {
  if (!decl) return null;
  var found = null;
  var re = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|rgba?\([^)]*\)/g;
  var m;
  while ((m = re.exec(decl))) {
    var c = parseColor(m[0]);
    if (c) found = c;
  }
  return found;
}
function over(fg, bg) {
  var a = fg.a === undefined ? 1 : fg.a;
  return { rgb: [0, 1, 2].map(function (i) { return Math.round(fg.rgb[i] * a + bg.rgb[i] * (1 - a)); }), a: 1 };
}
function chan(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function lum(c) { return 0.2126 * chan(c.rgb[0]) + 0.7152 * chan(c.rgb[1]) + 0.0722 * chan(c.rgb[2]); }
function ratio(a, b) {
  if (!a || !b) return null;
  var la = lum(a), lb = lum(b);
  return +(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2));
}
function css(text) { return stripComments(String(text || '')).replace(/<style[^>]*>/gi, '').replace(/<\/style>/gi, ''); }

/** 合成"文字实际落底的颜色"：半透明 token 逐层压到页面底上。 */
function flat(tokenValue, baseColor) {
  var c = parseColor(tokenValue);
  if (!c) return null;
  return c.a >= 1 ? c : over(c, baseColor);
}

// ---------------- 核对 ----------------

/** 从 popup/*.js 里读"运行时才写进 --x 的那些"，免得把 `--bg-image` 误报成没声明。 */
function runtimeTokens() {
  var names = [];
  var files = [];
  try {
    files = fs.readdirSync(POPUP_DIR).filter(function (n) { return /\.js$/.test(n); });
  } catch (e) { return { names: null, why: 'popup 目录读不出：' + String(e.message || e) }; }
  files.forEach(function (n) {
    var t;
    try { t = stripComments(read(path.join(POPUP_DIR, n))); } catch (e) { return; }
    var re = /setProperty\(\s*['"](--[a-z0-9-]+)['"]/gi;
    var m;
    while ((m = re.exec(t))) if (names.indexOf(m[1]) < 0) names.push(m[1]);
  });
  return { names: names, files: files.length };
}

function tokenCensus(texts) {
  var declared = {}, refs = {};
  Object.keys(texts).forEach(function (f) {
    var t = texts[f];
    var dm = /(?:^|[{;\s])(--[a-z0-9-]+)\s*:/g, m;
    while ((m = dm.exec(t))) declared[m[1]] = true;
    var rm = /var\(\s*(--[a-z0-9-]+)\s*(,)?/g;
    while ((m = rm.exec(t))) {
      if (!refs[m[1]] || (m[2] && !refs[m[1]].fb)) refs[m[1]] = { fb: !!m[2], in: f };
    }
  });
  return { declared: declared, refs: refs };
}

/** 主核：交文本进来就能跑（自检拿内存里的变体复用同一把尺，不另写一份判据）。 */
function evaluate(popupHtml, petCss, runtime) {
  var cells = [];
  var popText = css(popupHtml);
  var petText = css(petCss);
  var popRules = rulesOf(popText, darkRanges(popText));
  var petRules = rulesOf(petText, darkRanges(petText));
  var tok = tokensByMode(popRules);
  var sky = skiesByMode(petRules);

  // ---- 1a 舞台底色：素底 + 四季各有暗色孪生 ----
  var missingTwin = SKY_KEYS.filter(function (k) { return sky.light[k] && !sky.dark[k]; });
  var missingLight = SKY_KEYS.filter(function (k) { return sky.dark[k] && !sky.light[k]; });
  cells.push({
    id: 'sky-twin', name: '舞台底色（素底 + 四季）每一条都有白天／黑夜两份',
    ok: SKY_KEYS.every(function (k) { return !!sky.light[k] && !!sky.dark[k]; }),
    info: '浅档扫到 ' + Object.keys(sky.light).length + '/' + SKY_KEYS.length +
      ' 暗档 ' + Object.keys(sky.dark).length + '/' + SKY_KEYS.length +
      (missingTwin.length ? ' 缺暗孪生：' + missingTwin.join(',') : '') +
      (missingLight.length ? ' 缺浅孪生：' + missingLight.join(',') : '')
  });

  // ---- 1b 中性档两档都声明且取值不同 ----
  var rampMiss = RAMP.filter(function (k) { return !tok.light[k] || !tok.dark[k]; });
  var rampSame = RAMP.filter(function (k) { return tok.light[k] && tok.light[k] === tok.dark[k]; });
  cells.push({
    id: 'ramp-pair', name: '--fg/--fg-2/--muted/--bg/--card 两档都声明**且取值不许照抄**',
    ok: rampMiss.length === 0 && rampSame.length === 0,
    info: rampMiss.length ? '只有一档：' + rampMiss.join(',') : (rampSame.length ? '暗档照抄浅档：' + rampSame.join(',') : RAMP.length + ' 枚两档齐且互不相同')
  });

  // ---- 2a 中性文字 × 页面底（含卡片合成）----
  var rampRows = [];
  ['light', 'dark'].forEach(function (mode) {
    var base = parseColor(tok[mode] && tok[mode]['--bg']);
    var card = base && flat(tok[mode] && tok[mode]['--card'], base);
    INK.forEach(function (k) {
      var ink = parseColor(tok[mode] && tok[mode][k]);
      [{ at: '页面底', c: base }, { at: '卡片上', c: card }].forEach(function (bg) {
        var r = ratio(ink, bg.c);
        rampRows.push({ mode: mode, ink: k, at: bg.at, ratio: r, inkHex: tok[mode][k], bg: bg.c });
      });
    });
  });
  var rampBad = rampRows.filter(function (r) { return r.ratio === null || r.ratio < AA; });
  cells.push({
    id: 'ramp-contrast', name: '中性文字 × 页面底/卡片底 的对比度逐对 ≥ ' + AA,
    ok: rampBad.length === 0,
    info: rampBad.length ? rampBad.slice(0, 6).map(function (r) {
      return r.mode + ' ' + r.ink + ' ' + r.inkHex + ' on ' + r.at + '=' + (r.bg ? r.bg.rgb.join(',') : '?') + ' → ' + r.ratio;
    }).join(' ｜ ') : rampRows.length + ' 对全过（最低 ' + Math.min.apply(null, rampRows.map(function (r) { return r.ratio; })) + '）'
  });

  // ---- 2b 中性文字 × 四季舞台底 ----
  var skyRows = [];
  ['light', 'dark'].forEach(function (mode) {
    SKY_KEYS.forEach(function (k) {
      var bg = lastColor((sky[mode] || {})[k]);
      ['--fg', '--fg-2'].forEach(function (ink) {
        var c = parseColor(tok[mode] && tok[mode][ink]);
        skyRows.push({ mode: mode, sky: k, ink: ink, ratio: ratio(c, bg), bg: bg });
      });
    });
  });
  var skyBad = skyRows.filter(function (r) { return r.ratio === null || r.ratio < AA; });
  cells.push({
    id: 'sky-contrast', name: '舞台上的字（--fg/--fg-2）× 素底与四季天光 逐对 ≥ ' + AA,
    ok: skyBad.length === 0,
    info: skyBad.length ? skyBad.slice(0, 6).map(function (r) {
      return r.mode + ' ' + r.ink + ' on ' + r.sky + '=' + (r.bg ? r.bg.rgb.join(',') : '解析不出') + ' → ' + r.ratio;
    }).join(' ｜ ') : skyRows.length + ' 对全过（最低 ' + Math.min.apply(null, skyRows.map(function (r) { return r.ratio; })) + '）'
  });

  // ---- 3 引用普查 ----
  var cen = tokenCensus({ 'popup/popup.html': popText, 'popup/pet.css': petText });
  var rt = runtime || { names: [], files: 0 };
  function isDeclared(n) { return !!cen.declared[n] || (rt.names && rt.names.indexOf(n) >= 0); }
  var bare = Object.keys(cen.refs).filter(function (n) { return !isDeclared(n) && !cen.refs[n].fb; });
  var viaFb = Object.keys(cen.refs).filter(function (n) { return !isDeclared(n) && cen.refs[n].fb; });
  cells.push({
    id: 'token-bare', name: 'var(--x) 引用的 token 有人声明（没声明**又不带兜底**就红）',
    ok: bare.length === 0,
    info: bare.length ? '没声明也没兜底：' + bare.join(',') : '引用 ' + Object.keys(cen.refs).length + ' 枚，全部有出处（含运行时写的 ' + (rt.names || []).join(',') + '）'
  });
  var newFb = viaFb.filter(function (n) { return FALLBACK_LEDGER.indexOf(n) < 0; });
  var gone = FALLBACK_LEDGER.filter(function (n) { return viaFb.indexOf(n) < 0; });
  cells.push({
    id: 'token-fallback', name: '靠兜底活着的引用必须逐名在台账里（新增/消失都要红一次）',
    ok: newFb.length === 0 && gone.length === 0,
    info: (newFb.length ? '台账外新冒出来：' + newFb.join(',') + ' ' : '') +
      (gone.length ? '台账里这名已经不引用了：' + gone.join(',') + '（按史实删掉还是补声明，说了再走）' : '') +
      (!newFb.length && !gone.length ? '台账 ' + FALLBACK_LEDGER.join(',') + ' 与实际一致' : '')
  });

  // ---- 4 读不出：单独占一格，不许塌进上面任何一格 ----
  var unread = [];
  if (!tok.light['--bg']) unread.push('浅档 :root 没解析出 --bg');
  if (!tok.dark['--bg']) unread.push('暗档 :root 没解析出 --bg');
  if (!Object.keys(sky.light).length) unread.push('一条浅档舞台底色都没扫到（选择器改形了？）');
  if (!Object.keys(sky.dark).length) unread.push('一条暗档舞台底色都没扫到（@media 那一段没了？）');
  if (rt.names === null) unread.push('运行时 token 读不出：' + rt.why);
  cells.push({
    id: 'unreadable', name: '上面几把尺的**前提**都读得回来（读不出单独占一格）',
    ok: unread.length === 0, info: unread.length ? unread.join(' ｜ ') : '两档 token + 四季底色 + 运行时名单都读回来了'
  });

  return { cells: cells, detail: { tokens: tok, skies: sky, rampRows: rampRows, skyRows: skyRows, refs: Object.keys(cen.refs).length } };
}

function audit() {
  var html, pcss;
  try { html = read(POPUP_HTML); } catch (e) { console.log('[X] 读不出 popup/popup.html：' + String(e.message || e)); return 1; }
  try { pcss = read(PET_CSS); } catch (e) { console.log('[X] 读不出 popup/pet.css：' + String(e.message || e)); return 1; }
  var rt = runtimeTokens();
  var r = evaluate(html, pcss, rt);
  var bad = 0;
  r.cells.forEach(function (c) {
    console.log((c.ok ? '[ok] ' : '[X]  ') + c.name + ' —— ' + c.info);
    if (!c.ok) bad++;
  });
  if (bad) {
    console.log('');
    console.log('[X] 白天／黑夜 × 四季对账未通过：' + bad + ' 格。' +
      '\n      这一族红了就是"黑夜里有人看不清字"，只有用户看得见、任何测试都不红（AGENTS §2 #12/#191）。');
    return 1;
  }
  console.log('');
  console.log('[ok] 白天／黑夜 × 四季底色成对，中性文字 ' + (r.detail.rampRows.length + r.detail.skyRows.length) + ' 对逐对 ≥ ' + AA);
  return 0;
}

function dump() {
  var r = evaluate(read(POPUP_HTML), read(PET_CSS), runtimeTokens());
  console.log('两档 token：');
  ['light', 'dark'].forEach(function (m) {
    console.log('  ' + m + '  ' + RAMP.map(function (k) { return k + '=' + (r.detail.tokens[m][k] || '(缺)'); }).join('  '));
  });
  console.log('舞台底色：');
  SKY_KEYS.forEach(function (k) {
    console.log('  ' + k.padEnd(7) + ' 浅 ' + String(r.detail.skies.light[k] || '(缺)').slice(0, 46) +
      '\n          暗 ' + String(r.detail.skies.dark[k] || '(缺)').slice(0, 46));
  });
  console.log('逐对对比度（' + AA + ' 为合格线）：');
  r.detail.skyRows.concat(r.detail.rampRows).forEach(function (x) {
    console.log('  ' + (x.ratio !== null && x.ratio >= AA ? '  ' : '❌') + ' ' + String(x.mode).padEnd(6) +
      String(x.ink).padEnd(8) + ' on ' + String(x.sky || x.at).padEnd(8) + ' = ' + x.ratio);
  });
  return 0;
}

// —— 自检：每格自己说走到没走到，红在预期之外也算失败 ——
//
// ⚠️ 全部在**内存里的文本变体**上跑同一把 evaluate()，一个字节都不落盘，
//    所以并发窗口里也能安全跑（口径同 tools/check-concurrency.js --selftest）。
//
// ⚠️ 注入**不许用"第一条匹配"**：`html[data-season="summer"] body.im{` 在浅档与暗档各有一条，
//    按第一条下手会摘掉**浅档那一条**，于是红的是"缺浅孪生"而不是"缺暗孪生" ——
//    看着像抓到了，其实测的是另一件事（AGENTS §5「注入没生效时，反向验证会给出假绿」）。
//    这里按**在不在 `@media (prefers-color-scheme:dark)` 区间内**选靶，并断言"这一发真动掉了"。
function findRule(cssText, selRe, wantDark) {
  var stripped = stripComments(cssText);
  var ranges = darkRanges(stripped);
  var re = /([^{}]+)\{([^{}]*)\}/g, m;
  var hit = null;
  while ((m = re.exec(stripped))) {
    var sel = m[1].trim().replace(/\s+/g, ' ');
    if (!selRe.test(sel)) continue;
    if (inRange(ranges, m.index) !== wantDark) continue;
    hit = { start: m.index, end: m.index + m[0].length, sel: sel, body: m[2].trim() };
    break;
  }
  return hit;
}
function cutRule(cssText, selRe, wantDark) {
  var r = findRule(cssText, selRe, wantDark);
  return r ? { text: cssText.slice(0, r.start) + cssText.slice(r.end), cut: r.sel } : { text: cssText, cut: null };
}
function swapRule(cssText, selRe, wantDark, newBody) {
  var r = findRule(cssText, selRe, wantDark);
  if (!r) return { text: cssText, cut: null };
  return { text: cssText.slice(0, r.start) + r.sel + '{' + newBody + '}' + cssText.slice(r.end), cut: r.sel };
}
var SEL_SUMMER = /data-season="summer"[\s\S]*body\.im/;
var SEL_WINTER = /data-season="winter"[\s\S]*body\.im/;

function selftest() {
  var html = read(POPUP_HTML);
  var pcss = read(PET_CSS);
  var base = evaluate(html, pcss, runtimeTokens());
  var baseOk = base.cells.every(function (c) { return c.ok; });
  // 先自证选靶打得中：浅／暗各一条，两条不能是同一处
  var tDark = findRule(stripComments(pcss), SEL_SUMMER, true);
  var tLight = findRule(stripComments(pcss), SEL_SUMMER, false);
  var targetOk = !!(tDark && tLight && tDark.start !== tLight.start);

  var cSummerDark = cutRule(pcss, SEL_SUMMER, true);
  var pWinterLightBack = swapRule(pcss, SEL_WINTER, true,
    'background:radial-gradient(70% 60% at 50% 20%, #e8f1ff, #f4f8ff 60%, #eef2f8)');
  // 把**声明那批中性 token 的那一道**暗档 @media 改名：区间解析不出来 → 暗档等于没声明
  // ⚠️ popup.html 里有**三道** `prefers-color-scheme:dark`（:139 组件、:416 是 `:root` 那一档、:528 另一段），
  //    按"第一条命中"下手会摘错那道 —— 摘错时盘上照样全绿，于是这一格恒 0 红、什么也抓不住
  //    （AGENTS §5「注入没生效时，反向验证会给出假绿」——本轮实测撞的就是这条：第一版摘到 :139）。
  var darkMediaBroken = html.replace(/@media \(prefers-color-scheme:dark\)(\s*\{\s*\n\s*:root\{)/,
    '@media (prefers-color-scheme:night)$1');

  var cellsOf = function (r) {
    var map = {};
    r.cells.forEach(function (c) { map[c.id] = c.ok; });
    return map;
  };
  var mSummerDark = cellsOf(evaluate(html, cSummerDark.text, runtimeTokens()));
  var mWinterSwap = cellsOf(evaluate(html, pWinterLightBack.text, runtimeTokens()));
  var mMutedSame = cellsOf(evaluate(html.replace(/--muted:#979ead/, '--muted:#616875'), pcss, runtimeTokens()));
  var mMutedLightOld = cellsOf(evaluate(html.replace(/--muted:#616875/, '--muted:#767d8a'), pcss, runtimeTokens()));
  var mBare = cellsOf(evaluate(html, pcss + '\n.selftest-x{ color:var(--nope-191); }', runtimeTokens()));
  var mFallback = cellsOf(evaluate(html, pcss + '\n.selftest-y{ color:var(--nope-2-191, #000); }', runtimeTokens()));
  var mNoDarkMedia = cellsOf(evaluate(darkMediaBroken, pcss, runtimeTokens()));
  var mSelRenamed = cellsOf(evaluate(html, pcss.replace(/body\.im/g, 'body.stage'), runtimeTokens()));
  var mCommentOnly = cellsOf(evaluate(html, pcss + '\n/* html[data-season="spring"] body.im 没有暗色版 */', runtimeTokens()));
  var rt = runtimeTokens();
  var mNoRuntime = cellsOf(evaluate(html, pcss, { names: [], files: rt.files }));
  var mWithRuntime = cellsOf(evaluate(html, pcss, rt));

  var ALL_OK = {};
  base.cells.forEach(function (c) { ALL_OK[c.id] = true; });
  var pins = [
    ['⓪选靶自证：夏天那条浅档与暗档都找得到，且不是同一处', targetOk, true],
    ['①盘上六格全绿（前提：尺本身不空转）', baseOk, true],
    ['②摘掉夏天**暗档**那条孪生 → 结构格与舞台对比度格各自红，中性格照旧绿',
      mSummerDark, { 'sky-twin': false, 'sky-contrast': false, 'ramp-pair': true, 'ramp-contrast': true, 'unreadable': true },
      function () { return cSummerDark.cut === 'html[data-season="summer"] body.im'; }],
    ['③暗档孪生**在**但颜色改回浅天光 → 只有舞台对比度格红（结构格抓不到这一族）',
      mWinterSwap, { 'sky-twin': true, 'sky-contrast': false },
      function () { return pWinterLightBack.cut === 'html[data-season="winter"] body.im'; }],
    ['④暗档 --muted 照抄浅档 → 成对格红', mMutedSame, { 'ramp-pair': false }, null],
    ['⑤浅档 --muted 退回旧的 #767d8a → 只有中性对比度格红，成对格照旧绿',
      mMutedLightOld, { 'ramp-pair': true, 'ramp-contrast': false }, null],
    ['⑥塞一枚没声明也不带兜底的 var(--nope) → 普查格红，兜底台账格照旧绿',
      mBare, { 'token-bare': false, 'token-fallback': true }, null],
    ['⑦台账外新冒出一枚"靠兜底"的引用 → 兜底台账格红，普查格照旧绿',
      mFallback, { 'token-bare': true, 'token-fallback': false }, null],
    ['⑧暗档 @media 名字被改坏 → 成对格红**且**读不出格红，不许只当"两档没差异"',
      mNoDarkMedia, { 'ramp-pair': false, 'unreadable': false },
      function () { return darkMediaBroken !== html && !evaluate(darkMediaBroken, pcss, rt).detail.tokens.dark['--bg']; }],
    ['⑨舞台选择器改名（body.im → body.stage）→ 读不出格红而不是"0 条通过"',
      mSelRenamed, { 'unreadable': false }, null],
    ['⑩注释里写一句假的"浅孪生缺失"不许惊动尺（剥注释承重）', mCommentOnly, ALL_OK, null],
    ['⑪运行时 setProperty 写的那名不算"没声明"（摘掉运行时名单才会红）',
      mWithRuntime['token-bare'] && !mNoRuntime['token-bare'], true,
      function () { return rt.names.indexOf('--bg-image') >= 0; }]
  ];
  var failed = 0;
  pins.forEach(function (p) {
    var label = p[0], got = p[1], want = p[2], selfProof = p[3];
    var ok;
    if (want && typeof want === 'object') {
      ok = Object.keys(want).every(function (k) { return got[k] === want[k]; });
    } else {
      ok = got === want;
    }
    if (ok && selfProof) ok = !!selfProof();
    console.log((ok ? '  [ok] ' : '  [X]  ') + label +
      (ok ? (selfProof ? '（注入落盘已自证）' : '') : ' → 实得 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want) +
        (selfProof ? '，注入自证=' + JSON.stringify(selfProof()) : '')));
    if (!ok) failed++;
  });
  var total = pins.length;
  console.log(failed ? '[X] 自检：' + (total - failed) + ' / ' + total + ' 格通过' : '[ok] 自检：' + total + ' / ' + total + ' 格通过');
  return failed ? 1 : 0;
}

var CELLS = [
  { id: 'sky-twin' }, { id: 'ramp-pair' }, { id: 'ramp-contrast' }, { id: 'sky-contrast' },
  { id: 'token-bare' }, { id: 'token-fallback' }, { id: 'unreadable' }
];

if (require.main === module) {
  var argv = process.argv;
  var code = argv.indexOf('--selftest') >= 0 ? selftest() : (argv.indexOf('--dump') >= 0 ? dump() : audit());
  process.exit(code);
}

module.exports = {
  CELLS: CELLS,
  SKY_KEYS: SKY_KEYS,
  RAMP: RAMP,
  FALLBACK_LEDGER: FALLBACK_LEDGER,
  AA: AA,
  evaluate: evaluate,
  stripComments: stripComments,
  darkRanges: darkRanges,
  parseColor: parseColor,
  lastColor: lastColor,
  ratio: ratio,
  runtimeTokens: runtimeTokens
};
