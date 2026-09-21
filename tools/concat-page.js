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
 * 用法：
 *   node tools/concat-page.js            生成 page.js
 *   node tools/concat-page.js --check    只校验（不一致则退出码 1）
 */
'use strict';

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
  return { text: chunks.join(eol), files: files, eol: eol };
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
    return;
  }
  fs.writeFileSync(OUT_FILE, buffer);
  console.log('[concat-page] 已写出 page.js（' + built.files.length + ' 个片段，' +
    buffer.length + ' 字节，换行 ' + (built.eol === '\r\n' ? 'CRLF' : 'LF') + '）');
  built.files.forEach(function (file) {
    console.log('  + ' + path.relative(ROOT, file).replace(/\\/g, '/'));
  });
}

module.exports = {
  buildPageText: buildPageText,
  listParts: listParts,
  PARTS_DIR: PARTS_DIR,
  OUT_FILE: OUT_FILE,
  HEADER_END: HEADER_END
};

if (require.main === module) main();
