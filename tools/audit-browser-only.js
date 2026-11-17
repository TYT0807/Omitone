#!/usr/bin/env node
/**
 * 「只能在电脑浏览器里用」这一口径的机检（被 `check.js` 第 29 项调用）。
 *
 * 为什么要有它：这一族断言散在**四个地方**（说明书封面那块红框、§7 排查表那一行、
 * §9.2 已知限制清单那一行、README 封面警示），四处必须说同一件事。
 * 批次 66/67 连着两轮在这条口径上改过措辞，而**没有任何机检覆盖它** ——
 * 第 27 项只管"界面字样说明书教没教"，管不到这类**方向性断言**：
 * 把封面那句「客户端和手机装不了」删掉，或者只在某一处留下「用浏览器打开就行」，
 * 集成测试、e2e、真实浏览器测试**一条都不会红**，只有新用户照着装到客户端里才发现。
 *
 * 判据形状（两处刻意做严，避免"自己不会红"的空守卫）：
 *  1. **按位置点名**，不对整篇文档求交集 —— 只在别处出现过的字样不能替这一处交差，
 *     所以四处里的任何一处被掏空都会红，而不是"全书还有一句"就混过去。
 *  2. **只认可见正文** —— 注释与 `script` / `style` 里的出现不算（与第 27 项同一把尺）。
 *  3. 锚点找不到 / 不唯一**算问题**，不算跳过 —— 否则"闸认不出这一处"会打印成"0 条问题"。
 *
 * 跑法：
 *   node tools/audit-browser-only.js            # 量真文档，有问题退出 1
 *   node tools/audit-browser-only.js --report   # 逐处打印每一族字样在不在（先量再钉）
 *   node tools/audit-browser-only.js --selftest # 九格自证（含"不许误报"那一格）
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var MANUAL = 'docs/manual.html';
var README = 'README.md';

/* ---------------------------------------------------------------- 字样族 */

/**
 * 每一族 = 「这一处必须传达的一件事」，alts 是允许的说法（同义写法都算传达到了）。
 * ⚠️ alts 不许扩到"什么都能命中"的程度 —— 「浏览器」这种单词一条都不写，
 *    因为 §7 那一行只说「确认是在浏览器里之后」也算传达，但封面那种正向声明必须
 *    真的写出「电脑浏览器」才叫口径（见下面 must 的分工）。
 */
var FAMILIES = [
  { key: 'browserOnly', name: '正向声明：只能装在电脑浏览器里', alts: ['电脑浏览器'] },
  { key: 'client', name: '点名学习通客户端', alts: ['客户端'] },
  { key: 'phone', name: '点名手机 APP', alts: ['手机'] },
  { key: 'cannot', name: '说清在那里装不了', alts: ['装不了', '用不了'] },
  { key: 'addrBar', name: '给出判据：有没有地址栏', alts: ['地址栏'] },
  { key: 'domain', name: '给出判据：地址里是 chaoxing.com', alts: ['chaoxing.com'] }
];

/** 每一处位置各自必须传达的那几件事（缺一样 = 口径在这处断了）。 */
var CORE = ['client', 'phone', 'cannot', 'addrBar', 'domain'];

var LOCATIONS = [
  {
    name: '说明书封面那块红框', file: MANUAL,
    from: '先确认这一件事', to: '登录进去后从「课程」打开要学的那一门',
    must: ['browserOnly'].concat(CORE)
  },
  {
    name: '说明书 §7 排查表「装了也开着却什么都没发生」那一行', file: MANUAL,
    from: '装了、也开着，可学习通里什么都没发生', to: '</tr>',
    must: CORE
  },
  {
    name: '说明书 §9.2 已知限制清单那一行', file: MANUAL,
    from: '<tr><td>只能在电脑浏览器里用</td>', to: '</tr>',
    must: ['browserOnly'].concat(CORE)
  },
  {
    name: 'README 封面警示', file: README,
    from: '它只能装在电脑浏览器', to: '网页版入口',
    must: ['browserOnly'].concat(CORE)
  }
];

/* ---------------------------------------------------------------- 取可见正文 */

// 行内标签：删掉不产生边界（`正常<b>运行</b>` 页面上就是"正常运行"）。
var INLINE_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'span', 'code', 'tt', 'small', 'big',
  'sub', 'sup', 'mark', 'a', 'font', 'abbr', 'cite', 'q'];

/**
 * HTML → 用户读到的那段文字。注释、`script`、`style` 全部去掉 —— 写在注释里的字样
 * 用户在页面上看不见，不能替正文交差。markdown 传进来也安全（它本来就没标签）。
 */
function visibleText(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  s = s.replace(/<!\s?[a-zA-Z][^>]*>/g, ' ');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g, function (_m, name) {
    return INLINE_TAGS.indexOf(String(name).toLowerCase()) !== -1 ? '' : '\n';
  });
  s = s.replace(/&nbsp;/gi, ' ').replace(/&[A-Za-z][A-Za-z0-9]{1,7};/g, ' ');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return s.replace(/\s+/g, ' ');
}

/** 从整篇里切出「这一处」那一段：锚点必须**唯一**，收尾锚点必须在起锚点之后。 */
function sliceRegion(raw, from, to) {
  if (!from) return { text: '', err: '没有起始锚点' };
  var first = raw.indexOf(from);
  if (first === -1) return { text: '', err: '起始锚点找不到' };
  if (raw.indexOf(from, first + from.length) !== -1) {
    return { text: '', err: '起始锚点出现不止一次，取哪一段不确定' };
  }
  var end = raw.indexOf(String(to || ''), first + from.length);
  if (!to) return { text: raw.slice(first), err: '' };
  if (end === -1) return { text: '', err: '收尾锚点找不到（这一段被搬走了？）' };
  return { text: raw.slice(first, end), err: '' };
}

/* ---------------------------------------------------------------- 审计 */

/**
 * @param files { 'docs/manual.html': '…', 'README.md': '…' }
 * @param locs  位置表（默认用真表；自证传同一张表配假文件内容）
 * @returns {{ issues: string[], rows: object[], checked: number, families: number }}
 *          rows 每格带 present / missing —— 供 `--report` 先量实际值再钉判据。
 */
function audit(files, locs) {
  var list = locs || LOCATIONS;
  var issues = [];
  var rows = [];
  var famByKey = {};
  FAMILIES.forEach(function (f) { famByKey[f.key] = f; });

  list.forEach(function (loc) {
    var raw = String((files && files[loc.file]) == null ? '' : files[loc.file]);
    var row = { name: loc.name, file: loc.file, present: [], missing: [], err: '' };
    if (!raw) {
      row.err = loc.file + ' 没读进来';
      issues.push(loc.name + '：' + row.err);
      rows.push(row);
      return;
    }
    var cut = sliceRegion(raw, loc.from, loc.to);
    if (cut.err) {
      row.err = cut.err;
      issues.push(loc.name + '（' + loc.file + '）认不出这一处：' + cut.err);
      rows.push(row);
      return;
    }
    var text = visibleText(cut.text);
    (loc.must || CORE).forEach(function (key) {
      var fam = famByKey[key];
      if (!fam) {
        issues.push(loc.name + '：判据里写了不存在的字样族「' + key + '」');
        return;
      }
      var hit = fam.alts.some(function (a) { return text.indexOf(a) !== -1; });
      if (hit) row.present.push(key);
      else {
        row.missing.push(key);
        issues.push(loc.name + '（' + loc.file + '）缺「' + fam.name + '」—— 允许的说法：' +
          fam.alts.join(' / '));
      }
    });
    row.snippet = text.slice(0, 90);
    rows.push(row);
  });

  return { issues: issues, rows: rows, checked: rows.length, families: FAMILIES.length };
}

/* ---------------------------------------------------------------- 读文件 */

function readFiles(root) {
  var out = {};
  [MANUAL, README].forEach(function (rel) {
    try { out[rel] = fs.readFileSync(path.join(root || ROOT, rel), 'utf8'); }
    catch (e) { out[rel] = ''; }
  });
  return out;
}

/* ---------------------------------------------------------------- 自证 */

/**
 * 干净夹具：四处位置 + 每一族各写一种说法。
 * ⚠️ 里面的字样是**合成写法**，不抄真文档（真文档对真闸另有单独一格，见最后一例）。
 */
function cleanFixture() {
  var box = '<div class="t">先确认这一件事：只能装在电脑浏览器里</div>' +
    '<p>学习通的电脑客户端、手机 APP 里装不了它。</p>' +
    '<p>判据：看屏幕最上面有没有一条能输网址的地址栏，里面带着 chaoxing.com。</p>' +
    '<p>登录进去后从「课程」打开要学的那一门，那一页才是插件干活的地方。</p>';
  var faqRow = '<tr><td>装了、也开着，可学习通里什么都没发生</td>' +
    '<td>先分清网页版还是客户端：电脑客户端和手机 APP 装不了扩展。' +
    '判据：看有没有地址栏，里面是 …chaoxing.com/…</td></tr>';
  var limitRow = '<tr><td>只能在电脑浏览器里用</td>' +
    '<td>学习通电脑客户端 / 手机 APP 装不了它 —— 地址栏里要有 chaoxing.com</td></tr>';
  var readme = '> ⚠️ **它只能装在电脑浏览器（Edge / Chrome）里。** ' +
    '学习通的电脑客户端、手机 APP 装不了这个插件。\n' +
    '> 判断自己在不在网页版：屏幕最上面有一条能输网址的地址栏、里面是 `…chaoxing.com/…`。\n' +
    '> 网页版入口：[i.chaoxing.com/base](https://i.chaoxing.com/base)\n';
  var f = {};
  f[MANUAL] = box + faqRow + limitRow;
  f[README] = readme;
  return f;
}

/** 在夹具里只改一处：把 from 换成 to（to 传空串 = 整段删掉）。 */
function mutate(files, file, from, to) {
  var out = {};
  Object.keys(files).forEach(function (k) { out[k] = files[k]; });
  var raw = String(out[file] || '');
  if (raw.indexOf(from) === -1) throw new Error('夹具里没有这段，改不动：' + from.slice(0, 24));
  out[file] = raw.replace(from, to);
  return out;
}

function selfTestCases() {
  var clean = cleanFixture();
  var realFiles = readFiles();
  return [
    { pin: '干净夹具', files: clean, want: 0, needle: '',
      note: '四处都写全 → 0 条（这条不成立就是判据写错了，不是文档错了）' },
    { pin: '封面缺正向声明', files: mutate(clean, MANUAL, '只能装在电脑浏览器里', '装在别的软件里'),
      want: 1, needle: '正向声明',
      note: '封面红框不再明说"电脑浏览器" → 要红（新用户最容易会错意的就是这一句）' },
    { pin: '排查表缺地址栏判据', files: mutate(clean, MANUAL, '看有没有地址栏', '看是不是网页'),
      want: 1, needle: '有没有地址栏',
      note: '§7 那一行把"怎么判断"删了 → 要红（只剩结论没有判据，用户照样分不清）' },
    { pin: '限制清单缺手机', files: mutate(clean, MANUAL, '电脑客户端 / 手机 APP', '电脑客户端'),
      want: 1, needle: '手机 APP',
      note: '§9.2 那一行漏掉手机 APP → 要红（装机的人第一个问的就是手机能不能用）' },
    { pin: 'README 缺域名判据', files: mutate(clean, README, '里面是 `…chaoxing.com/…`', '里面是网址'),
      want: 1, needle: 'chaoxing.com',
      note: 'GitHub 门面那一处删掉域名 → 要红（门面是用户唯一看过的一段）' },
    { pin: '字样只写在注释里', files: mutate(clean, MANUAL,
        '<p>判据：看屏幕最上面有没有一条能输网址的地址栏，里面带着 chaoxing.com。</p>',
        '<!-- 判据：看屏幕最上面有没有一条能输网址的地址栏，里面带着 chaoxing.com。 -->'),
      want: 2, needle: '有没有地址栏',
      note: '封面那句判据整段搬进 HTML 注释 → 要红 2 条（地址栏 + 域名；注释用户在页面上看不见）' },
    { pin: '字样散在别处', files: mutate(clean, MANUAL,
        '登录进去后从「课程」打开要学的那一门', 'x'.repeat(40)),
      want: 1, needle: '认不出这一处',
      note: '收尾锚点被搬走 = 这一处认不出 → 要红，不许打印成"0 条问题"' },
    { pin: '整处被删', files: (function () {
        var f = {};
        f[MANUAL] = clean[MANUAL].replace(clean[MANUAL].match(/<tr><td>装了、也开着[\s\S]*?<\/tr>/)[0], '');
        f[README] = clean[README];
        return f;
      })(), want: 1, needle: '起始锚点找不到',
      note: '§7 那一行整条被删 → 要红（静默少一处检查比不检查更坏）' },
    { pin: '真文档对真闸', files: realFiles, want: 0, needle: '',
      note: '真说明书 + 真 README → 0 条（现场这一格）' }
  ];
}

function selfTest() {
  var cases = selfTestCases();
  var bad = [];
  cases.forEach(function (c) {
    var res;
    try { res = audit(c.files); }
    catch (e) {
      bad.push(c.pin + '：审计抛了 ' + String((e && e.message) || e));
      return;
    }
    var okCount = res.issues.length === c.want;
    var okNeedle = !c.needle || res.issues.some(function (x) { return x.indexOf(c.needle) !== -1; });
    if (!okCount || !okNeedle) {
      bad.push(c.pin + ' 期望 ' + c.want + ' 条并含「' + (c.needle || '无') + '」，实际 ' +
        res.issues.length + ' 条: ' + JSON.stringify(res.issues.slice(0, 4)));
    }
    console.log('  [' + (okCount && okNeedle ? 'ok' : 'FAIL') + '] ' + c.pin + ' — ' + c.note);
  });
  return bad;
}

/* ---------------------------------------------------------------- CLI */

function main() {
  var args = process.argv.slice(2);
  if (args.indexOf('--selftest') !== -1) {
    console.log('「只能在电脑浏览器里用」口径自证（' + selfTestCases().length + ' 格）：');
    var bad = selfTest();
    if (bad.length) {
      console.log('SELFTEST-FAIL\n' + bad.join('\n'));
      process.exit(2);
    }
    console.log(selfTestCases().length + ' 格全部通过');
    process.exit(0);
  }
  var res = audit(readFiles());
  if (args.indexOf('--report') !== -1) {
    res.rows.forEach(function (r) {
      console.log('· ' + r.name + ' [' + r.file + ']');
      if (r.err) { console.log('    认不出：' + r.err); return; }
      console.log('    在：' + (r.present.join(', ') || '(无)'));
      console.log('    缺：' + (r.missing.join(', ') || '(无)'));
      console.log('    首 90 字：' + r.snippet);
    });
    process.exit(res.issues.length ? 1 : 0);
  }
  if (res.issues.length) {
    console.log('「只能在电脑浏览器里用」这一口径在 ' + res.issues.length + ' 处断了：');
    res.issues.forEach(function (i) { console.log('  - ' + i); });
    console.log('  改法：把缺的那句话写回**那一处**的可见正文（别只在别处留一句，' +
      '也别改 ' + path.basename(__filename) + ' 的判据来迁就现状）');
    process.exit(1);
  }
  console.log(MANUAL + ' 与 ' + README + ' 的「电脑浏览器 / 客户端与手机装不了 / 地址栏 + chaoxing.com」' +
    '口径一致（' + res.checked + ' 处位置逐处点名，共 ' + res.families + ' 族字样）');
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  FAMILIES: FAMILIES, LOCATIONS: LOCATIONS,
  visibleText: visibleText, sliceRegion: sliceRegion, audit: audit,
  readFiles: readFiles, cleanFixture: cleanFixture, mutate: mutate,
  selfTestCases: selfTestCases, selfTest: selfTest
};
