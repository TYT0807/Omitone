/**
 * 把 `src/page/*.js` 按文件名排序拼回根目录的 `page.js`。
 *
 * 为什么要有这个脚本：`page.js` 原本是一个 9899 行 / 330 个方法的巨石，
 * 改一个域要在近万行里翻找。拆成 `src/page/` 下的多段之后，
 * **根目录的 `page.js` 变成构建产物** —— 它是扩展真正加载的那一份
 * （`content.js` 用 `chrome.runtime.getURL('page.js')` 注入、
 * `manifest.json` 的 `web_accessible_resources` 也列的是它），
 * 所以拼接产物必须落在根目录、文件名不能变。
 *
 * ⚠️ **改代码要改 `src/page/` 里的片段，然后跑 `npm run concat`。**
 * 直接改根目录的 `page.js` 会在下一次拼接时被覆盖掉。
 * `npm run concat:check`（已并入 `npm test`）就是为了把这种漂移当场抓出来。
 *
 * ⚠️ 它现在**还做第二件事**：按 `manifest.json` 的 `content_scripts[0].js` 清单
 * （`libs/` 下那些 + `popup/pet-game.js` + `content.js` 自己，按列出顺序、换行归一后）
 * 算一个**桥戳** `OMITONE_CODE_REV_BRIDGE`，写进 `content.js` 首行。
 * 为什么归在这一步：`content.js` 是被注入的**桥**，已注入的副本不随重载扩展而换（要 F5），
 * 所以它必须在加载那一刻自报身份；而 `page.js` 早就有 `OMITONE_CODE_REV` 了，
 * 两者是同一族「被加载的那一份到底是哪一份」的问题（见 AGENTS §7.7）。
 * 只戳 `content.js` 一个文件会造出「提示词换了、戳没换」那种**比没有戳更坏**的读数，
 * 所以清单从 manifest 读、不写死文件名单：加一个 lib 进来，戳当场变、工具不用改。
 *
 * 用法：
 *   node tools/concat-page.js            生成 page.js
 *   node tools/concat-page.js --check    只校验（不一致则退出码 1）
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARTS_DIR = path.join(ROOT, 'src', 'page');
const OUT_FILE = path.join(ROOT, 'page.js');

// 每段片段头部的最后一行。拼接时**本行及其之前的所有行都被丢弃** ——
// 这样头部注释写多少都不会漏进产物（产物必须与拆分前的 page.js 逐字节相同）。
const HEADER_END = '// @omitone-part-header-end';

/** 列出参与拼接的片段文件（按文件名排序 —— 文件名前缀就是顺序）。 */
function listParts() {
  if (!fs.existsSync(PARTS_DIR)) {
    throw new Error('找不到片段目录: ' + PARTS_DIR);
  }
  const files = fs
    .readdirSync(PARTS_DIR)
    .filter(function (name) { return /\.js$/.test(name); })
    .sort();
  if (!files.length) throw new Error('src/page/ 里一个 .js 片段都没有');
  return files.map(function (name) { return path.join(PARTS_DIR, name); });
}

/** 取出一个片段去掉头部注释后的正文（数组，元素为不带换行的行）。 */
function partBody(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const idx = lines.indexOf(HEADER_END);
  if (idx === -1) {
    throw new Error(
      path.basename(file) + ' 缺少头部结束标记「' + HEADER_END + '」——\n' +
      '      每段片段都必须带它，否则拼接时整份头部会被当成代码写进 page.js。'
    );
  }
  if (lines.lastIndexOf(HEADER_END) !== idx) {
    throw new Error(path.basename(file) + ' 里出现了多个头部结束标记 —— 只允许一个');
  }
  const body = lines.slice(idx + 1);
  // 文件末尾那个换行是「文件的」，不是「内容的」：丢掉恰好一个。
  // 注意只能丢一个 —— 片段正文本身可能以空行结尾。
  if (body.length && body[body.length - 1] === '') body.pop();
  return body;
}

/** 拼出 page.js 的完整文本（换行符沿用片段里的实际值）。 */
function buildPageText() {
  const files = listParts();
  const first = fs.readFileSync(files[0], 'utf8');
  const eol = first.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const chunks = files.map(function (file) { return partBody(file).join(eol); });
  const body = chunks.join(eol);

  // 给代码本身算一个**内容指纹**，拼在文件最前面。
  //
  // 为什么需要：`version_name` 只在 dist 产物里有 —— 而"直接加载源码目录"的人
  // 拿到的是 `(源码目录，未经 build)`，等于还是没有版本信息。2026-10-17 就因为
  // 四个包全叫 1.2.8、日志里分不清跑的是哪一版，白排查了一轮。
  //
  // ⚠️ 指纹**只由片段内容决定**（不掺时间戳）：这样拼接可复现，
  // `npm run concat:check` 不会因为每次跑都不同而永远报"不一致"。
  const rev = crypto.createHash('sha1').update(body, 'utf8').digest('hex').slice(0, 10);
  return { text: "var OMITONE_CODE_REV = '" + rev + "';" + eol + body, files: files, eol: eol, rev: rev };
}

// ---------------------------------------------------------------------------
// 桥戳（content.js 那一侧的身份）
//
// ⚠️ 三条护栏，缺一条整格作废（工单 §3.2）：
//   1. 换行归一 —— `content.js` 实测 CRLF，不 `\r\n→\n` 会把「换行被动过」算成代码变了；
//      而**写回戳行时保留原 EOL**，否则每次 restamp 把整个文件重写成 LF，那是一次 20 万字的假 diff。
//   2. 戳行自己不参与哈希（否则自指，永远对不上）。
//   3. 首行不是戳行时报「读不出」并退出非 0 —— 不许退化成「戳为空 = 一致」（AGENTS §2 #12）。
// ---------------------------------------------------------------------------
const CONTENT_FILE = path.join(ROOT, 'content.js');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');
const BRIDGE_STAMP_RE = /^var OMITONE_CODE_REV_BRIDGE = '([0-9a-f]{10})';(\r?\n)/;

/** 摘掉首行那枚桥戳（哈希之前做，避免自指）。 */
function stripBridgeStamp(text) {
  const m = text.match(BRIDGE_STAMP_RE);
  return m ? text.slice(m[0].length) : text;
}

/** 按 manifest 的注入清单算桥戳：顺序敏感、换行归一、戳行不参与。 */
function buildBridgeStamp() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const listed = (((manifest.content_scripts || [])[0] || {}).js || []);
  if (!listed.length) {
    throw new Error('manifest.json 里读不到 content_scripts[0].js —— 桥戳的清单来源没了，不许猜');
  }
  const chunks = listed.map(function (rel) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) throw new Error('manifest 列的注入文件不在盘上: ' + rel);
    return stripBridgeStamp(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  });
  return {
    rev: crypto.createHash('sha256').update(chunks.join('\n'), 'utf8').digest('hex').slice(0, 10),
    files: listed
  };
}

/** 把桥戳落到 content.js 首行；`checkOnly` 时只核对不写。 */
function bridgeStep(checkOnly) {
  let stamp;
  try {
    stamp = buildBridgeStamp();
  } catch (error) {
    console.error('[concat-page] 桥戳算不出: ' + (error && error.message ? error.message : error));
    process.exit(1);
  }
  if (!fs.existsSync(CONTENT_FILE)) {
    console.error('[concat-page] 没有 content.js —— 桥戳没地方落');
    process.exit(1);
  }
  const raw = fs.readFileSync(CONTENT_FILE, 'utf8');
  const eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const m = raw.match(BRIDGE_STAMP_RE);
  if (m && m[1] === stamp.rev) {
    console.log('[concat-page] content.js 桥戳已是最新（' + stamp.rev + '，' + stamp.files.length + ' 个注入文件）');
    return;
  }
  if (checkOnly) {
    console.error('[concat-page] content.js 首行的桥戳' +
      (m ? '过期（首行 ' + m[1] + '，按 manifest 清单重算应是 ' + stamp.rev + '）'
          : '读不出（首行不是戳行，形如 var OMITONE_CODE_REV_BRIDGE = \'…\';）') +
      ' —— 跑 `npm run concat`');
    process.exit(1);
  }
  const body = m ? raw.slice(m[0].length) : raw;
  fs.writeFileSync(CONTENT_FILE, "var OMITONE_CODE_REV_BRIDGE = '" + stamp.rev + "';" + eol + body);
  console.log('[concat-page] 已重写 content.js 首行桥戳 ' + (m ? m[1] + ' → ' : '(无) → ') + stamp.rev);
}

/** 正文里是否残留头部结束标记（说明片段被人改坏了） */
function assertNoMarkerLeak(text) {
  if (text.indexOf(HEADER_END) !== -1) {
    throw new Error('拼接产物里出现了头部结束标记 —— 有片段的标记写在了头部之外');
  }
}

function main() {
  const checkOnly = process.argv.indexOf('--check') !== -1;
  let built;
  try {
    built = buildPageText();
    assertNoMarkerLeak(built.text);
  } catch (error) {
    console.error('[concat-page] ' + (error && error.message ? error.message : error));
    process.exit(1);
  }

  const buffer = Buffer.from(built.text, 'utf8');
  const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE) : null;

  if (checkOnly) {
    if (existing && existing.equals(buffer)) {
      console.log('[concat-page] page.js 与 src/page/ 一致（' + built.files.length + ' 个片段，' +
        buffer.length + ' 字节）');
      bridgeStep(true);
      return;
    }
    console.error(
      '[concat-page] page.js 与 src/page/ 不一致 —— 扩展加载的是根目录那份，\n' +
      '      所以现在跑的东西和源码对不上。\n' +
      '      如果你改的是 src/page/ 里的片段：跑 `npm run concat` 重新拼接。\n' +
      '      如果你改的是根目录的 page.js：那份改动会在下次拼接时被覆盖，请改到片段里。'
    );
    process.exit(1);
  }

  if (existing && existing.equals(buffer)) {
    console.log('[concat-page] 无需改动（' + built.files.length + ' 个片段，' + buffer.length + ' 字节）');
    bridgeStep(false);
    return;
  }
  fs.writeFileSync(OUT_FILE, buffer);
  console.log('[concat-page] 已写出 page.js（' + built.files.length + ' 个片段，' +
    buffer.length + ' 字节，换行 ' + (built.eol === '\r\n' ? 'CRLF' : 'LF') + '）');
  built.files.forEach(function (file) {
    console.log('  + ' + path.relative(ROOT, file).replace(/\\/g, '/'));
  });

  bridgeStep(false);
}

module.exports = {
  buildPageText: buildPageText,
  buildBridgeStamp: buildBridgeStamp,
  BRIDGE_STAMP_RE: BRIDGE_STAMP_RE,
  CONTENT_FILE: CONTENT_FILE,
  listParts: listParts,
  PARTS_DIR: PARTS_DIR,
  OUT_FILE: OUT_FILE,
  HEADER_END: HEADER_END
};

if (require.main === module) main();
