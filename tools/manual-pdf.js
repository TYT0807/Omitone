#!/usr/bin/env node
/**
 * 生成面向使用者的图文说明书 PDF：`npm run manual`
 *
 *   源文件   docs/manual.html          （排版真源，给人改的模板）
 *   产物     使用说明.pdf              （仓库根目录 —— 非技术用户要一眼能看到）
 *
 * 为什么产物放根目录而不是 docs/：
 *   这份 PDF 是给"完全不懂 GitHub 的同学"看的，放 docs/ 里他们找不到。
 *   根目录 + README 顶部的直链，是他们唯一能顺利拿到说明书的路径。
 *
 * 只用 Node 内置模块 + 系统已装的 Edge/Chrome 无头模式，不引入任何依赖。
 * 内联 SVG 会保留为矢量，缩放和印刷都清晰（不用截图贴图）。
 *
 * 版本号自动从 manifest.json 取并盖进 HTML —— 手册以前会忘了跟着升版本
 * （1.1.1 发布时它还写着旧号），所以这里不给人手工同步的机会。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');
var SRC = path.join(ROOT, 'docs', 'manual.html');
var OUT = path.join(ROOT, '使用说明.pdf');

/** 发布附件名固定为 omitone.zip（不带版本号），README 的永久直链依赖它。 */
var ZIP_NAME = 'omitone.zip';

// ---------------------------------------------------------------------------
// 1) 找浏览器
// ---------------------------------------------------------------------------
function findBrowser() {
  var pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  var pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  var lad = process.env['LOCALAPPDATA'] || '';

  var candidates = [
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    lad && path.join(lad, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    lad && path.join(lad, 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean);

  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2) 把版本号与附件名盖进 HTML
// ---------------------------------------------------------------------------
function stamp(html, version) {
  var counts = {};

  function sub(re, repl, key) {
    var n = 0;
    html = html.replace(re, function () {
      n++;
      return repl.apply(null, arguments);
    });
    counts[key] = n;
  }

  // `Omitone-1.1.1` / `Omitone 1.1.1` —— 保留原来的连接符（连字符或空格）
  sub(/Omitone([- ])\d+\.\d+\.\d+/g, function (m, sep) { return 'Omitone' + sep + version; }, '品牌名');
  // `版本 1.1.1`
  sub(/版本\s+\d+\.\d+\.\d+/g, function () { return '版本 ' + version; }, '版本行');
  // `omitone-1.1.1.zip` → 固定名
  sub(/omitone-\d+\.\d+\.\d+\.zip/g, function () { return ZIP_NAME; }, '压缩包名');

  return { html: html, counts: counts };
}

// ---------------------------------------------------------------------------
// 3) 打印
// ---------------------------------------------------------------------------
function print(browser, htmlPath, pdfPath, profileDir) {
  return spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profileDir,
    '--print-to-pdf=' + pdfPath,
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    'file:///' + htmlPath.replace(/\\/g, '/').replace(/^\/+/, '')
  ], { encoding: 'utf8', timeout: 120000 });
}

// ---------------------------------------------------------------------------
// 4) 校验产物（无头模式 stdout 没有任何有用信息，只能看产物）
// ---------------------------------------------------------------------------
function verify(pdfPath) {
  var buf = fs.readFileSync(pdfPath);
  var s = buf.toString('latin1');
  return {
    bytes: buf.length,
    pages: (s.match(/\/Type \/Page[^s]/g) || []).length,
    images: (s.match(/\/Subtype \/Image/g) || []).length,
    fonts: new Set(s.match(/\/BaseFont \/([A-Za-z0-9+\-]+)/g) || []).size
  };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('找不到源文件 ' + path.relative(ROOT, SRC));
    process.exitCode = 1;
    return;
  }

  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  var version = manifest.version;

  var browser = findBrowser();
  if (!browser) {
    console.error('没找到 Edge 或 Chrome，无法生成 PDF。');
    console.error('（说明书源文件 docs/manual.html 仍然可以用浏览器直接打开）');
    process.exitCode = 1;
    return;
  }

  var raw = fs.readFileSync(SRC, 'utf8');
  var result = stamp(raw, version);

  // 临时目录放 %TEMP%：不给 --user-data-dir 会去抢用户正在用的浏览器 profile
  var work = path.join(os.tmpdir(), 'omitone-manual-' + process.pid);
  fs.mkdirSync(work, { recursive: true });
  var tmpHtml = path.join(work, 'manual.html');
  var tmpPdf = path.join(work, 'manual.pdf');
  fs.writeFileSync(tmpHtml, result.html, 'utf8');

  console.log('\nOmitone 说明书生成\n');
  console.log('  浏览器     ' + browser);
  console.log('  版本       ' + version);
  Object.keys(result.counts).forEach(function (k) {
    console.log('  盖入' + k + '  ' + result.counts[k] + ' 处');
  });

  var run = print(browser, tmpHtml, tmpPdf, work);

  if (!fs.existsSync(tmpPdf)) {
    console.error('\n生成失败：没有产出 PDF。');
    if (run.error) console.error('  ' + run.error.message);
    if (run.stderr) console.error('  ' + String(run.stderr).trim().split('\n').slice(0, 5).join('\n  '));
    fs.rmSync(work, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  // 先输出到 ASCII 临时路径再改名 —— 避免把中文路径交给浏览器命令行
  fs.copyFileSync(tmpPdf, OUT);
  fs.rmSync(work, { recursive: true, force: true });

  var info = verify(OUT);
  console.log('  产物       ' + path.basename(OUT) + '  ' + (info.bytes / 1024).toFixed(1) + ' KB');
  console.log('  页数       ' + info.pages);
  console.log('  位图数     ' + info.images + (info.images === 0 ? '（全矢量，缩放印刷不糊）' : ' ← 有图退化成了位图，检查一下'));
  console.log('  字体数     ' + info.fonts);
  console.log('');

  if (info.pages < 5) {
    console.error('页数异常偏少（' + info.pages + ' 页），多半是 HTML 没渲染完就打印了。');
    process.exitCode = 1;
    return;
  }

  console.log('完成。改内容请改 ' + path.relative(ROOT, SRC).replace(/\\/g, '/') + ' 再跑一次本命令。\n');
}

main();
