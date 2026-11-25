/**
 * README §12.1「体积账本」的对账尺（check.js 用户入口守卫的一格，真源在这里）。
 *
 * 为什么要有这一把：这一本账是**手抄**的 —— 立绘每补一批、page.js 每长一截，
 * 那十行数字就 collectively 过期一次。实测（2026-11-20）五格已经漂了：
 * 文档写「解压后约 3.3 MB / zip 约 2.02 MB / popup 约 1.75 MB (52.4%)」，
 * 而 zip 中央目录里记的实际是 3.49 MB / 2.25 MB / 1.80 MB (51.5%)。
 * 一条测试都不会红，只有照这一页理解「软件为什么这么大」的人看得见 ——
 * 与 AGENTS §3「行为改了而文档没改，是这一族唯一的失败形状」同族。
 *
 * 口径三条，都是为了避免"会误报的守卫和没有守卫一样害人"（AGENTS §5）：
 *
 *   1. **真源是 `dist/omitone-<版本>.zip` 的中央目录**，不是磁盘目录、也不是 `unzip -l` 的排版。
 *      每个条目自己带着 uncompressedSize，这里逐条目加起来 —— 这才是用户下载到的那一份。
 *      ⚠️ 别改成按磁盘目录合计：`popup/` 里有 `README.md` 之类的件，磁盘与包里不是一回事。
 *   2. **只认表格行与两句固定形状**（「解压后约 N MB」「zip 约 N MB」「约 N MB，大部分是 M 张立绘」）。
 *      散文里的历史数字（「88 张从 3.6 MB 压到 1.38 MB」「体积从约 660 KB 涨到 2 MB」）
 *      一律**不在射程内** —— 那是当时的 fact，不承诺现行基线（AGENTS §2 #21 同一族）。
 *   3. **命中 0 处按失败报**，不许打印通过 —— 措辞被整段改写时，扫描会静默变成空命中，
 *      那是最坏的绿（§2 #21 的卫生格）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');

/** 账本那一节的小区名（README 里以 `### 12.1` 开头的那一段）。 */
var SECTION = '体积账本';

// ---------------------------------------------------------------------------
// 1. zip 中央目录：每个条目的名字与它自己的 uncompressedSize
// ---------------------------------------------------------------------------

function readZipEntries(zipPath) {
  var buf = fs.readFileSync(zipPath);
  // EOCD（End of Central Directory）从尾部往前找，注释长度可变
  var eocd = -1;
  for (var i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { err: 'zip 里找不到中央目录结尾记录（EOCD 签名）' };
  var cdCount = buf.readUInt16LE(eocd + 10);
  var cdSize = buf.readUInt32LE(eocd + 12);
  var cdOff = buf.readUInt32LE(eocd + 16);
  var entries = [];
  var p = cdOff;
  for (var n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return { err: '中央目录第 ' + (n + 1) + ' 条签名不对，偏移 ' + p };
    var nameLen = buf.readUInt16LE(p + 28);
    var extraLen = buf.readUInt16LE(p + 30);
    var cmtLen = buf.readUInt16LE(p + 32);
    var compSize = buf.readUInt32LE(p + 20);
    var rawSize = buf.readUInt32LE(p + 24);
    var method = buf.readUInt16LE(p + 10);
    var name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name: name, size: rawSize, compSize: compSize, method: method, dir: /\/$/.test(name) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p !== cdOff + cdSize) return { err: '中央目录长度对不上（读到 ' + p + '，声明 ' + (cdOff + cdSize) + '）' };
  return { entries: entries, count: cdCount };
}

// ---------------------------------------------------------------------------
// 2. 打包白名单：真源是 tools/build.js 的 INCLUDE / EXCLUDE
// ---------------------------------------------------------------------------

/**
 * 从 `tools/build.js` 源码里把 INCLUDE / EXCLUDE 两份数组读回来。
 *
 * ⚠️ 不许在本文件里再抄一份词表 —— 白名单改了而这里没改，就会把新目录读成"未归类"，
 * 或者把删掉的目录读成"README 多写一行"，报的还是子虚乌有的文档错。
 */
function readPackList() {
  var src = fs.readFileSync(path.join(ROOT, 'tools', 'build.js'), 'utf8');
  function grab(name) {
    var m = src.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];'));
    if (!m) return null;
    return (m[1].match(/'[^']*'/g) || []).map(function (s) { return s.slice(1, -1); });
  }
  var inc = grab('INCLUDE'), exc = grab('EXCLUDE');
  if (!inc || !exc) return { err: 'tools/build.js 里读不到 INCLUDE / EXCLUDE —— 尺的口径要同步' };
  return { include: inc, exclude: exc };
}

/**
 * 三个立绘池的长度（`popup/pet-game.js` 的 SKINS / FACES / POSES）。
 *
 * ⚠️ **不许按文件名前缀数**：美术的命名和画面内容是错位的（pet-e2~e6 画的是服装、
 * pet-i5~i8 画的是表情），`popup/pet-game.js` 顶部把这一族写死在注释里，
 * check.js 第 20 项「立绘池守卫」读的就是这三个池子 —— 这里必须读同一份真源，
 * 否则「48 套服装」这种一直正确的句子会被前缀计数判成漂了。
 */
function readPools() {
  var src;
  try { src = fs.readFileSync(path.join(ROOT, 'popup', 'pet-game.js'), 'utf8'); }
  catch (e) { return { err: '读不到 popup/pet-game.js（' + e.message + '）' }; }
  var out = {};
  ['SKINS', 'FACES', 'POSES'].forEach(function (name) {
    var m = src.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];'));
    if (!m) { out.err = 'popup/pet-game.js 里找不到 ' + name + ' 池子 —— 池子被改名/搬走时要同步这把尺'; return; }
    out[name] = (m[1].match(/"(pet[^"]*\.png)"/g) || []).length;
  });
  return out;
}

function splitPath(p) {
  var parts = String(p).split('/');
  return { head: parts[0], leaf: parts[parts.length - 1], depth: parts.length - 1 };
}

/**
 * 按 INCLUDE 分桶。返回 { buckets: {token: bytes}, unclassified: [名字], empty: [token] }
 */
function bucketize(entries, packList) {
  var buckets = {}, unclassified = [], seen = {};
  packList.include.forEach(function (t) { buckets[t] = 0; });
  var excludeSet = {};
  packList.exclude.forEach(function (t) { excludeSet[t] = true; });

  entries.forEach(function (e) {
    if (e.dir) return;                       // 目录条目本身 0 字节，不算件
    if (excludeSet[e.name]) return;          // build.js 明令不打包的件
    var sp = splitPath(e.name);
    var hit = null;
    if (packList.include.indexOf(e.name) !== -1) hit = e.name;
    else if (packList.include.indexOf(sp.head) !== -1 && sp.depth > 0) hit = sp.head;
    if (!hit) { unclassified.push(e.name); return; }
    buckets[hit] += e.size;
    seen[hit] = (seen[hit] || 0) + 1;
  });
  var empty = packList.include.filter(function (t) { return !seen[t]; });
  return { buckets: buckets, unclassified: unclassified, empty: empty };
}

// ---------------------------------------------------------------------------
// 3. README 那一侧：只认表格行 + 两句固定形状
// ---------------------------------------------------------------------------

function eol(text) { return String(text).replace(/\r\n/g, '\n'); }

function sectionOf(readmeText) {
  var lines = eol(readmeText).split('\n');
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i]) && lines[i].indexOf(SECTION) !== -1) { start = i; break; }
  }
  if (start < 0) return { lines: [], at: -1 };
  var out = [];
  for (var j = start; j < lines.length; j++) {
    if (j > start && /^#{2,4}\s/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return { lines: out, at: start + 1 };
}

/** 表格体行（跳过表头与 `---` 分隔行），按 GFM 切格。 */
function tableRows(secLines) {
  var rows = [];
  var inFence = false;
  secLines.forEach(function (ln, idx) {
    if (/^\s*```/.test(ln)) { inFence = !inFence; return; }
    if (inFence) return;
    if (ln.charAt(0) !== '|') return;
    if (/^\|\s*-{2,}/.test(ln) || /`?文件`?\s*\|\s*`?体积`?/.test(ln)) return;
    var cells = ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    if (cells.length < 2) return;
    rows.push({ line: idx + 1, cells: cells.map(function (c) { return c.trim(); }) });
  });
  return rows;
}

var SIZE_RE = /^约?\s*(\d+(?:\.\d+)?)\s*(MB|KB)\s*[（(]\s*(\d+(?:\.\d+)?)\s*%\s*[)）]$/;
var TOKEN_RE = /`([^`]+)`/g;

/** 单位按文档自己写的来：写 MB 就比 MB，写 KB 就比 KB（不替人换单位）。 */
function expected(bytes, unit, totalBytes) {
  var mb = bytes / 1048576, kb = bytes / 1024;
  var size = unit === 'MB' ? (mb < 10 ? round(mb, 2) : round(mb, 1)) : String(Math.round(kb));
  // 占比那一格文档恒写一位小数（`0.0%` 也是合法形状），所以这里不许被 round 削成「0」
  var pct = (totalBytes ? (bytes / totalBytes) * 100 : 0).toFixed(1);
  return { size: size, pct: pct };
}

function round(x, d) { return Number(x.toFixed(d)).toFixed(d).replace(/\.0$/, ''); }

function tokensOf(labelCell) {
  // 括注里的是**说明**（如 `resources/`（装的是 `table.bin`）），不是这一行承诺的打包件。
  // 不收窄就会把 `table.bin` 读成"白名单里没有的这一件"，报一条子虚乌有的文档错。
  var stripped = String(labelCell).replace(/（[^（）]*）/g, ' ');
  var m, out = [], re = new RegExp(TOKEN_RE.source, 'g');
  while ((m = re.exec(stripped))) out.push(m[1].replace(/\/$/, ''));
  return out;
}

// ---------------------------------------------------------------------------
// 4. 主判据
// ---------------------------------------------------------------------------

/**
 * @param {string} readmeText  某一页 README 的正文
 * @param {string} from        这一页的出处名（报错要点名是谁）
 * @param {object} actual      { buckets, total, zipBytes, pngCount, skins, faces, poses, zipName }
 * @returns { problems: [...], readouts: {...} }
 */
function compare(readmeText, from, actual) {
  var problems = [];
  var sec = sectionOf(readmeText);
  var rows = tableRows(sec.lines);
  var readouts = { rows: rows.length, claims: 0 };

  if (sec.at < 0) {
    problems.push(from + ' 里找不到「' + SECTION + '」那一节 —— 这一格本轮根本没跑（标题被改名就要同步尺，别让它静默消失）');
    return { problems: problems, readouts: readouts };
  }
  if (!rows.length) {
    problems.push(from + ' 的「' + SECTION + '」里一行表格都没扫到 —— 命中 0 不是通过：账本被整段删掉或改写成散文，' +
      '就等于从此没有任何东西要求这几格数字回填');
    return { problems: problems, readouts: readouts };
  }

  // 4a) 每一行：体积与百分比对着 zip 实测比
  var claimedTokens = {};
  rows.forEach(function (r) {
    var sizeCell = r.cells[1];
    var m = SIZE_RE.exec(sizeCell);
    if (!m) {
      problems.push(from + ' 第 ' + r.line + ' 行的体积格「' + sizeCell + '」读不出形状（要写成 `约 1.80 MB (51.5%)` 那样）—— ' +
        '形状认不出来就不比大小，但必须单独占一格，不许悄悄跳过');
      return;
    }
    readouts.claims++;
    var toks = tokensOf(r.cells[0]);
    if (!toks.length) {
      problems.push(from + ' 第 ' + r.line + ' 行的第一格没有任何反引号里的路径 —— 这一行对不上打包白名单里的哪一件？');
      return;
    }
    var bytes = 0, unknown = [];
    toks.forEach(function (t) {
      if (Object.prototype.hasOwnProperty.call(actual.buckets, t)) bytes += actual.buckets[t];
      else unknown.push(t);
    });
    if (unknown.length) {
      problems.push(from + ' 第 ' + r.line + ' 行写的是 ' + unknown.join(' + ') + '，打包白名单 tools/build.js 的 INCLUDE 里没有这一件 —— ' +
        '要么白名单改了而账本没跟着改，要么这一行管的是不打包的东西');
      return;
    }
    toks.forEach(function (t) {
      if (claimedTokens[t]) problems.push(from + ' 里 `' + t + '` 被两行各自承诺（第 ' + claimedTokens[t] + ' 行与第 ' + r.line +
        ' 行）—— 同一个字节数写两处，改一处漏一处');
      claimedTokens[t] = r.line;
    });
    var exp = expected(bytes, m[2], actual.total);
    if (numEq(m[1], exp.size)) problems.push(from + ' 第 ' + r.line + ' 行「' + r.cells[0] + '」体积写 ' + m[1] + ' ' + m[2] +
      '，zip 里实际是 ' + exp.size + ' ' + m[2] + '（' + bytes + ' 字节）');
    if (numEq(m[3], exp.pct)) problems.push(from + ' 第 ' + r.line + ' 行「' + r.cells[0] + '」占比写 ' + m[3] + '%，' +
      '按实测总量 ' + actual.total + ' 字节算是 ' + exp.pct + '%');
    // 立绘张数：这一族数字最容易随补图漂移，形状只认「N 张立绘」
    var cnt = /(\d+)\s*张立绘/.exec(r.cells[0]);
    if (cnt && Number(cnt[1]) !== actual.pngCount) {
      problems.push(from + ' 第 ' + r.line + ' 行写「' + cnt[1] + ' 张立绘」，popup/ 里实际 ' + actual.pngCount + ' 张');
    }
    var trio = /(\d+)\s*套服装\s*\/\s*(\d+)\s*表情\s*\/\s*(\d+)\s*姿势/.exec(r.cells[2] || '');
    if (trio) {
      if (Number(trio[1]) !== actual.skins) problems.push(from + ' 第 ' + r.line + ' 行写 ' + trio[1] + ' 套服装，SKINS 池里实际 ' + actual.skins + ' 套');
      if (Number(trio[2]) !== actual.faces) problems.push(from + ' 第 ' + r.line + ' 行写 ' + trio[2] + ' 表情，FACES 池里实际 ' + actual.faces + ' 张');
      if (Number(trio[3]) !== actual.poses) problems.push(from + ' 第 ' + r.line + ' 行写 ' + trio[3] + ' 姿势，POSES 池里实际 ' + actual.poses + ' 个');
      readouts.artwork = true;
    }
  });

  // 4b) 打包白名单里每一件都必须被某一行的第一格点名（新增目录不许躲进"其它"）
  var notClaimed = Object.keys(actual.buckets).filter(function (t) { return !claimedTokens[t]; });
  if (notClaimed.length) {
    problems.push(from + ' 的账本没有为 ' + notClaimed.join(' / ') + ' 单独列行 —— 白名单添了件而账本没加行，' +
      '这几 KB 就会凭空从表里消失（合计对得上、每一行都对得上，而总量少了谁都不知道）');
  }

  // 4c) 两句固定形状：整包与下载句
  var joined = eol(readmeText);
  var lead = /扩展\*\*解压后约\s*(\d+(?:\.\d+)?)\s*MB\*\*/.exec(joined);
  if (!lead) {
    problems.push(from + ' 里扫不到「扩展**解压后约 N MB**」那一句 —— 账本的总量那句被改写掉了，这一格本轮没跑');
  } else {
    readouts.claims++;
    var expAll = round(actual.total / 1048576, 2);
    if (numEq(lead[1], expAll)) problems.push(from + ' 说解压后约 ' + lead[1] + ' MB，zip 条目合计实际是 ' + expAll +
      ' MB（' + actual.total + ' 字节，' + actual.zipName + '）');
  }
  var zipClaim = /`dist\/\*\.zip` 约\s*(\d+(?:\.\d+)?)\s*MB/.exec(joined);
  if (!zipClaim) {
    problems.push(from + ' 里扫不到「`dist/*.zip` 约 N MB」那一句 —— 同上，压缩那份的承诺没人接了');
  } else {
    readouts.claims++;
    var expZip = round(actual.zipBytes / 1048576, 2);
    if (numEq(zipClaim[1], expZip)) problems.push(from + ' 说 dist/*.zip 约 ' + zipClaim[1] + ' MB，而 ' + actual.zipName +
      ' 实际 ' + actual.zipBytes + ' 字节 = ' + expZip + ' MB');
  }

  // 4d) 下载句（给用户看的那一句，精度只到整数 MB）
  var dl = /（约\s*(\d+)\s*MB，大部分是\s*(\d+)\s*张立绘）/.exec(joined);
  if (dl) {
    readouts.claims++;
    if (Number(dl[1]) !== Math.round(actual.zipBytes / 1048576)) {
      problems.push(from + ' 的下载句写「约 ' + dl[1] + ' MB」，按 ' + actual.zipName + ' 实际 ' +
        Math.round(actual.zipBytes / 1048576) + ' MB 该这么说');
    }
    if (Number(dl[2]) !== actual.pngCount) {
      problems.push(from + ' 的下载句写「' + dl[2] + ' 张立绘」，popup/ 里实际 ' + actual.pngCount + ' 张');
    }
  }

  return { problems: problems, readouts: readouts };
}

/** 两个"约"数不相等才算漂：按写的那份精度比（写 1.80 就比两位，写 156 就比整数）。 */
function numEq(docVal, expVal) {
  return Number(docVal) !== Number(expVal);
}

// ---------------------------------------------------------------------------
// 5. 现场测量
// ---------------------------------------------------------------------------

function measure() {
  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
  var zipName = 'omitone-' + manifest.version + '.zip';
  var zipPath = path.join(ROOT, 'dist', zipName);
  var out = { zipName: zipName, zipPath: zipPath, verdict: '' };
  if (!fs.existsSync(zipPath)) {
    out.verdict = 'missing-zip';
    return out;
  }
  var zp = readZipEntries(zipPath);
  if (zp.err) { out.verdict = 'unreadable: ' + zp.err; return out; }
  var pl = readPackList();
  if (pl.err) { out.verdict = 'unreadable: ' + pl.err; return out; }
  var bk = bucketize(zp.entries, pl);
  if (bk.unclassified.length) {
    out.verdict = 'unclassified: ' + bk.unclassified.slice(0, 5).join(', ') +
      (bk.unclassified.length > 5 ? '（共 ' + bk.unclassified.length + ' 件）' : '');
    return out;
  }
  if (bk.empty.length) {
    out.verdict = 'empty-bucket: ' + bk.empty.join(', ');
    return out;
  }
  var total = 0;
  Object.keys(bk.buckets).forEach(function (k) { total += bk.buckets[k]; });
  // 立绘计数用**包里的**件数，不用磁盘目录（磁盘可能有没打包的件）
  var png = zp.entries.filter(function (e) { return !e.dir && /^popup\/.*\.png$/i.test(e.name); });
  var pop = bk.buckets['popup'] || 0;
  var pools = readPools();
  out.buckets = bk.buckets;
  out.total = total;
  out.entries = zp.entries.length;
  out.zipBytes = fs.statSync(zipPath).size;
  out.pngCount = png.length;
  out.popupBytes = pop;
  out.verdict = 'ok';
  if (pools.err) out.verdict = 'unreadable: ' + pools.err;
  else {
    // readPools() 交回的就是**个数**（不是数组），这里别再 .length 一次
    out.skins = pools.SKINS;
    out.faces = pools.FACES;
    out.poses = pools.POSES;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. 入口
// ---------------------------------------------------------------------------

/**
 * 被 check.js 调用：两页都扫（工作树那一份 + 门面那一份），出处各自点名。
 * @param {Array<{text:string,from:string}>} pages
 * @param {object} actual measure() 的结果
 */
function auditPages(pages, actual) {
  var problems = [], readouts = [];
  pages.forEach(function (pg) {
    var r = compare(pg.text, pg.from, actual);
    problems = problems.concat(r.problems);
    readouts.push(pg.from + '(' + r.readouts.rows + ' 行 / ' + r.readouts.claims + ' 处承诺)');
  });
  return { problems: problems, readouts: readouts };
}

// ---------------------------------------------------------------------------
// 7. --selftest：每道闸各配一格只在它身上红（AGENTS §2 #9 的手法）
// ---------------------------------------------------------------------------

var CLEAN_TABLE = [
  '### 12.1 为什么「软件这么大」——体积账本',
  '',
  '扩展**解压后约 3.50 MB**（对着构建出来的 `dist/*.zip` 逐条目合计，不是磁盘目录 —— 2026-11-20 随批次 143 重算），`dist/*.zip` 约 2.25 MB。构成如下',
  '',
  '| 文件 | 体积 | 说明 |',
  '| --- | --- | --- |',
  '| `popup/`（100 张立绘 + 界面） | 约 1.80 MB (51.5%) | 立绘是主体：48 套服装 / 25 表情 / 28 姿势，每张 8~24 KB |',
  '| `page.js` | 1.05 MB (30.1%) | 全部页面侧逻辑 |',
  '| `libs/` | 198 KB (5.5%) | 字体解析 Typr + 提示词 |',
  '| `content.js` | 211 KB (5.9%) | 桥接层 |',
  '| `resources/`（装的是 `table.bin`） | 123 KB (3.4%) | 字形映射 |',
  '| `LICENSE` | 35 KB (1.0%) | GPL-3.0 全文 |',
  '| `icons/` | 28 KB (0.8%) | 三个尺寸的图标 |',
  '| `background.js` | 50 KB (1.4%) | service worker |',
  '| `runtime-log-store.js` + `popup-log-view.js` | 13 KB (0.4%) | 日志工厂 + 前端视图 |',
  '| `manifest.json` | 2 KB (0.0%) | 扩展清单 |',
  '',
  '> 历史句：1.3.0 又把立绘扩到 **88 张**，光素材就 ~1.38 MB。体积从约 660 KB 涨到 2 MB，' +
    '去掉 `popup/*.png` 后整个扩展仍只有 ~1.64 MB。88 张从约 3.6 MB 压到 1.38 MB（−62%）。',
  '',
  '浏览器会直接开始下载一个叫 `omitone.zip` 的文件（约 2 MB，大部分是 100 张立绘）。',
  ''
].join('\n');

function fakeActual() {
  var b = {
    'manifest.json': 1702, 'background.js': 50861, 'runtime-log-store.js': 6100, 'popup-log-view.js': 6826,
    'content.js': 215661, 'page.js': 1101797, 'libs': 203174, 'icons': 28877, 'popup': 1887572,
    'resources': 126427, 'LICENSE': 35823
  };
  var total = 0;
  Object.keys(b).forEach(function (k) { total += b[k]; });
  return {
    buckets: b, total: total, zipBytes: 2362779, zipName: 'omitone-1.3.1.zip',
    pngCount: 100, skins: 48, faces: 25, poses: 28, verdict: 'ok'
  };
}

function runSelfTest() {
  var actual = fakeActual();
  var base = compare(CLEAN_TABLE, '干净样例', actual);
  var cells = [];
  function hit(text, mut) {
    var t = CLEAN_TABLE.replace(mut[0], mut[1]);
    if (t === CLEAN_TABLE) return '锚点没动到（' + mut[0] + '）';
    return compare(t, '注入', actual).problems.length;
  }
  cells.push(['干净样例零红', base.problems.length === 0 ? 'ok' : '红 ' + base.problems.length + '：' + base.problems[0]]);
  cells.push(['体积写小了要红', hit(CLEAN_TABLE, ['约 1.80 MB', '约 1.75 MB']) > 0 ? 'ok' : '不红']);
  cells.push(['占比写漂了要红', hit(CLEAN_TABLE, ['(51.5%)', '(52.4%)']) > 0 ? 'ok' : '不红']);
  cells.push(['KB 那几格漂了要红', hit(CLEAN_TABLE, ['198 KB (5.5%)', '156 KB (5.5%)']) > 0 ? 'ok' : '不红']);
  cells.push(['立绘张数漂了要红', hit(CLEAN_TABLE, ['100 张立绘 + 界面', '88 张立绘 + 界面']) > 0 ? 'ok' : '不红']);
  cells.push(['服装配比漂了要红', hit(CLEAN_TABLE, ['48 套服装', '42 套服装']) > 0 ? 'ok' : '不红']);
  cells.push(['总量句漂了要红', hit(CLEAN_TABLE, ['解压后约 3.50 MB', '解压后约 3.3 MB']) > 0 ? 'ok' : '不红']);
  cells.push(['zip 句漂了要红', hit(CLEAN_TABLE, ['`dist/*.zip` 约 2.25 MB', '`dist/*.zip` 约 2.02 MB']) > 0 ? 'ok' : '不红']);
  cells.push(['下载句整数漂了要红', hit(CLEAN_TABLE, ['（约 2 MB，大部分', '（约 3 MB，大部分']) > 0 ? 'ok' : '不红']);
  cells.push(['体积格形状读不出要单独占一格', hit(CLEAN_TABLE, ['约 1.80 MB (51.5%)', '约 1.8 MB']) > 0 ? 'ok' : '不红']);
  cells.push(['新增白名单件没列行要红', compare(CLEAN_TABLE.replace('| `manifest.json` | 2 KB (0.0%) | 扩展清单 |\n', ''), '注入', actual).problems
    .some(function (p) { return /没有为|单独列行/.test(p); }) ? 'ok' : '不红']);
  cells.push(['整节改名要红', compare(CLEAN_TABLE.replace('体积账本', '体积说明'), '注入', actual).problems
    .some(function (p) { return /找不到/.test(p); }) ? 'ok' : '不红']);
  cells.push(['表格整段删掉要红（卫生格）', compare(CLEAN_TABLE.split('\n').filter(function (l) { return l.charAt(0) !== '|'; }).join('\n'), '注入', actual).problems
    .some(function (p) { return /一行表格都没扫到/.test(p); }) ? 'ok' : '不红']);
  // 把表格里那一行历史句原样搬进正文，尺一条都不许多报
  var historyOnly = '> 1.3.0 又把立绘扩到 **88 张**，光素材就 ~1.38 MB。体积从约 660 KB 涨到 2 MB，' +
    '去掉 `popup/*.png` 后仍只有 ~1.64 MB。\n' + CLEAN_TABLE;
  var histProblems = compare(historyOnly, '注入', actual).problems;
  cells.push(['历史句不许被逮住（误报对照）', histProblems.length === 0 ? 'ok' : '误报：' + histProblems[0]]);
  cells.push(['同一件写两行要红', compare(CLEAN_TABLE.replace('| `icons/` | 28 KB (0.8%) | 三个尺寸的图标 |',
    '| `icons/` | 28 KB (0.8%) | 三个尺寸的图标 |\n| `icons/` | 28 KB (0.8%) | 又写一遍 |'), '注入', actual).problems
    .some(function (p) { return /两行各自承诺/.test(p); }) ? 'ok' : '不红']);
  // 括注（`resources/`（装的是 `table.bin`））里的是说明，不是承诺件：
  // 上一版把括注也当成白名单件去比，`table.bin` 当场被报成"INCLUDE 里没有的这一件"——
  // 干净文档假红，而且报的是子虚乌有的文档错（AGENTS §5「会误报的守卫和没有守卫一样害人」）。
  var annotated = CLEAN_TABLE.replace('（装的是 `table.bin`）', '（装的是 `whatever.bin`）');
  var annProblems = compare(annotated, '注入', actual).problems;
  cells.push(['括注里的文件名不许当承诺件（误报对照）', annotated !== CLEAN_TABLE && annProblems.length === 0 ? 'ok' : '不成立：' + (annProblems[0] || '括注锚点没动到')]);
  // 挂载对照：这把尺自己绿不算数 —— `check.js` 不 require 它、或 require 了却不调 `auditPages`，
  // 盘上这几格数字就退回"只能靠人肉心算"（AGENTS §5「留在链外的套件会无声腐烂」同一族）。
  var checkSrc = '';
  try { checkSrc = fs.readFileSync(path.join(ROOT, 'tools', 'check.js'), 'utf8'); } catch (e) { checkSrc = ''; }
  var needles = ["require('./audit-readme-size.js')", '.auditPages(', 'audit-readme-size.js', '--selftest'];
  var unwired = needles.filter(function (s) { return checkSrc.indexOf(s) === -1; });
  cells.push(['check.js 真的挂了这把尺（挂载对照）', checkSrc && unwired.length === 0 ? 'ok' :
    (checkSrc ? '缺：' + unwired.join(' / ') : '读不到 tools/check.js —— 读不出当失败')]);
  // 登记对照：下一轮的人找不到真源，就会照着 README 那句话再写第二把尺（口径同 check.js 第 35 项
  // 要求 tools/README.md 认得 audit-diagnose-needles.js）。
  var toolsDoc = '';
  try { toolsDoc = fs.readFileSync(path.join(ROOT, 'tools', 'README.md'), 'utf8'); } catch (e) { toolsDoc = ''; }
  cells.push(['tools/README.md 登记了这把尺（登记对照）', toolsDoc ? (toolsDoc.indexOf('audit-readme-size.js') >= 0 ? 'ok' :
    '没扫到 `audit-readme-size.js` 这个名字') : '读不到 tools/README.md —— 读不出当失败']);

  var bad = cells.filter(function (c) { return c[1] !== 'ok'; });
  console.log('自检 ' + (cells.length - bad.length) + ' / ' + cells.length + ' 格通过');
  cells.forEach(function (c) { console.log((c[1] === 'ok' ? '[ok]   ' : '[FAIL] ') + c[0] + (c[1] === 'ok' ? '' : ' → ' + c[1])); });
  return bad.length === 0;
}

function main() {
  if (process.argv.indexOf('--selftest') !== -1) {
    process.exit(runSelfTest() ? 0 : 1);
  }
  var actual = measure();
  if (actual.verdict !== 'ok') {
    console.log('体积实测读不出：' + actual.verdict);
    process.exit(2);
  }
  if (process.argv.indexOf('--report') !== -1) {
    console.log('zip: ' + actual.zipName + ' = ' + actual.zipBytes + ' 字节 (' + round(actual.zipBytes / 1048576, 2) + ' MB)，' +
      '条目 ' + actual.entries + ' 个，解压合计 ' + actual.total + ' 字节 (' + round(actual.total / 1048576, 2) + ' MB)');
    Object.keys(actual.buckets).forEach(function (k) {
      var v = actual.buckets[k];
      console.log('  ' + k + ': ' + v + ' 字节 → ' + (v / 1048576).toFixed(2) + ' MB / ' + Math.round(v / 1024) + ' KB / ' +
        ((v / actual.total) * 100).toFixed(1) + '%');
    });
    console.log('立绘: ' + actual.pngCount + ' 张（池子：服装 ' + actual.skins + ' / 表情 ' + actual.faces +
      ' / 姿势 ' + actual.poses + '），popup/ 合计 ' + actual.popupBytes + ' 字节');
    process.exit(0);
  }
  console.log(JSON.stringify(actual, null, 2));
}

module.exports = { measure: measure, auditPages: auditPages, readZipEntries: readZipEntries, readPackList: readPackList, sectionOf: sectionOf, tableRows: tableRows, expected: expected, CLEAN_TABLE: CLEAN_TABLE, fakeActual: fakeActual };

if (require.main === module) main();
