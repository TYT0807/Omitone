#!/usr/bin/env node
/**
 * 工程自检。`npm run check` / `npm test` 的第一段。
 *
 * 覆盖这个项目历史上真正踩过的坑：
 *   - 改完代码忘了同步版本号（manifest / popup.html / content.js 三处）
 *   - manifest 被编辑器写回 UTF-8 BOM，Chrome 能忍但 JSON.parse 会炸
 *   - 往 manifest 里加了文件却没真的创建（或反过来，文件成了死代码）
 *   - 某个 JS 文件被外部编辑器用旧快照覆盖后留下语法错误
 *
 * 不做任何网络请求、不写任何文件，可安全地反复执行。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var os = require('os');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');

var problems = [];
var warnings = [];
var passed = [];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function fail(msg) {
  problems.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function pass(msg) {
  passed.push(msg);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

// ---------------------------------------------------------------------------
// 1. 所有 JS 通过语法编译
// ---------------------------------------------------------------------------
function collectJsFiles() {
  var out = [];
      // .debug-profile 是 CDP 调试用的 Edge 独立用户目录（.gitignore 已排除），
      // 里面全是 Edge 内置 JS，扫进来只会产生死代码误报。
      // src/ 也要排除：src/page/*.js 是 page.js 的**切片**，不是独立的 JS 文件
      // （单独看必然语法错误）。它们由 tools/concat-page.js 拼成根目录的 page.js，
      // 而 page.js 本身就在扫描范围内 —— 所以排掉 src/ 不会漏检任何东西，
      // 只是避免把「片段语法错误」当成真错误刷屏。
      var EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.debug-profile', '.workbuddy', 'src'];
      function walk(dir) {
        var base = path.join(ROOT, dir);
        if (!fs.existsSync(base)) return;
        fs.readdirSync(base, { withFileTypes: true }).forEach(function (entry) {
          var relPath = dir ? dir + '/' + entry.name : entry.name;
          if (EXCLUDED_DIRS.indexOf(entry.name) !== -1) return;
          if (entry.isDirectory()) return walk(relPath);
          if (!/\.js$/.test(entry.name)) return;
          out.push(relPath);
        });
      }
  walk('');
  return out;
}

function checkSyntax() {
  var files = collectJsFiles();
  var bad = [];
  files.forEach(function (file) {
    // 源码里可能出现 UTF-8 BOM，vm 会把它当成非法 token，先去干净
    var source = read(file).replace(/^\uFEFF/, '');
    try {
      new vm.Script(source, { filename: file });
    } catch (error) {
      bad.push(rel(file) + ' → ' + (error && error.message ? error.message : error));
    }
  });
  if (bad.length) fail('JS 语法错误:\n      ' + bad.join('\n      '));
  else pass(files.length + ' 个 JS 文件语法通过');
  return files;
}

// ---------------------------------------------------------------------------
// 2. manifest.json 可解析、无 BOM、必填字段齐全
// ---------------------------------------------------------------------------
function checkManifest() {
  var raw = fs.readFileSync(path.join(ROOT, 'manifest.json'));
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    fail('manifest.json 带 UTF-8 BOM —— 浏览器能加载，但 JSON.parse 会失败（node tools/fix-bom.js 可修）');
  }

  var manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('manifest.json 解析失败: ' + error.message);
    return null;
  }

  ['manifest_version', 'name', 'version', 'background', 'content_scripts', 'action'].forEach(function (key) {
    if (manifest[key] === undefined) fail('manifest.json 缺少必填字段: ' + key);
  });

  if (manifest.manifest_version !== 3) warn('manifest_version 不是 3，与当前 MV3 代码结构不符');

  pass('manifest.json 解析正常 (v' + manifest.version + ')');
  return manifest;
}

// ---------------------------------------------------------------------------
// 3. manifest 引用的文件都必须真实存在
// ---------------------------------------------------------------------------
/** Classic-worker dependencies resolve against the worker entry URL, not each imported file. */
function collectWorkerScripts(entry) {
  var files = [], issues = [], visited = Object.create(null);
  var base = path.posix.dirname(String(entry || '').replace(/\\/g, '/'));
  function visit(file) {
    if (visited[file]) return;
    visited[file] = true;
    files.push(file);
    if (!exists(file)) { issues.push('Worker 依赖不存在: ' + file); return; }
    if (files.length > 100) { issues.push('Worker 依赖图超过 100 个文件'); return; }
    var source = stripComments(read(file));
    var re = /\b(?:self\.)?importScripts\s*\(([^)]*)\)/g, match;
    while ((match = re.exec(source))) {
      var args = match[1].trim();
      if (!args) continue;
      // Literal-only imports are deliberate: dynamic paths cannot be statically packaged.
      if (!/^(['"])[^'"\\]*\1(?:\s*,\s*(['"])[^'"\\]*\2)*\s*,?$/.test(args)) {
        issues.push(file + ': importScripts 只支持可核对的本地字面量路径');
        continue;
      }
      var literal = /['"]([^'"]*)['"]/g, item;
      while ((item = literal.exec(args))) {
        var name = item[1];
        if (!name || /[:?#%\\]/.test(name) || name.charAt(0) === '/') {
          issues.push(file + ': 非本地 Worker 依赖: ' + name); continue;
        }
        var resolved = path.posix.normalize(path.posix.join(base, name));
        if (resolved === '..' || resolved.indexOf('../') === 0 || !/\.js$/.test(resolved)) {
          issues.push(file + ': Worker 依赖越界或非 JS: ' + name); continue;
        }
        visit(resolved);
      }
    }
  }
  if (entry) visit(entry);
  return { files: files, issues: issues };
}

function checkManifestFiles(manifest) {
  if (!manifest) return;

  var referenced = [];

  var background = manifest.background || {};
  var worker = collectWorkerScripts(background.service_worker);
  referenced = referenced.concat(worker.files);
  worker.issues.forEach(fail);
  // Build whitelist must include worker-only modules too; don't add them to page permissions.
  var buildList = read('tools/build.js').match(/var INCLUDE\s*=\s*\[([\s\S]*?)\];/);
  if (!buildList) fail('打包 INCLUDE 清单不可解析');
  else {
    var includes = (buildList[1].match(/['"][^'"]+['"]/g) || []).map(function (value) { return value.slice(1, -1); });
    worker.files.forEach(function (file) {
      if (!includes.some(function (include) { return file === include || file.indexOf(include + '/') === 0; })) {
        fail('Worker 依赖未纳入打包白名单: ' + file);
      }
    });
  }

  (manifest.content_scripts || []).forEach(function (entry) {
    (entry.js || []).forEach(function (f) { referenced.push(f); });
    (entry.css || []).forEach(function (f) { referenced.push(f); });
  });

  ((manifest.web_accessible_resources || [])[0] || {}).resources &&
    ((manifest.web_accessible_resources || [])[0].resources || []).forEach(function (f) { referenced.push(f); });

  if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);

  Object.keys(manifest.icons || {}).forEach(function (size) { referenced.push(manifest.icons[size]); });
  var actionIcons = (manifest.action && manifest.action.default_icon) || {};
  Object.keys(actionIcons).forEach(function (size) { referenced.push(actionIcons[size]); });

  referenced = Array.from(new Set(referenced));
  // web_accessible_resources 的资源条目支持通配（如 popup/pet*.png）——
  // 逐字 exists() 会把合法的 glob 当成"不存在的文件"。展开成真实文件再验，
  // 顺带保证 glob 至少能匹配到一个文件（写错模式名照样报红）。
  function expandGlob(pattern) {
    if (pattern.indexOf('*') === -1) return exists(pattern) ? [pattern] : [];
    var starAt = pattern.indexOf('*');
    var dir = path.dirname(pattern.slice(0, starAt));
    var prefix = pattern.slice(0, starAt).slice(dir.length + 1);
    var suffix = pattern.slice(starAt + 1);
    var matched = [];
    try {
      fs.readdirSync(path.join(ROOT, dir)).forEach(function (f) {
        if (f.indexOf(prefix) !== 0) return;
        if (suffix && !f.slice(prefix.length).endsWith(suffix)) return;
        matched.push(dir ? dir + '/' + f : f);
      });
    } catch (e) {}
    return matched;
  }
  var missing = [];
  var globTotal = 0;
  referenced.forEach(function (f) {
    if (f.indexOf('*') !== -1) {
      var expanded = expandGlob(f);
      globTotal += expanded.length;
      if (!expanded.length) missing.push(f + '（通配没匹配到任何文件）');
    } else if (!exists(f)) {
      missing.push(f);
    }
  });
  if (missing.length) fail('manifest 引用了不存在的文件: ' + missing.join(', '));
  else pass(referenced.length + ' 个 manifest / Worker 依赖文件全部存在' +
    (globTotal ? '（含通配展开 ' + globTotal + ' 个资源）' : ''));
}

// ---------------------------------------------------------------------------
// 4. 版本号三处一致（manifest.json / popup.html / content.js 品牌位）
// ---------------------------------------------------------------------------
function checkVersionConsistency(manifest) {
  if (!manifest) return;
  var version = manifest.version;
  var mismatch = [];

  if (manifest.name && manifest.name.indexOf(version) === -1) {
    mismatch.push('manifest.name = "' + manifest.name + '"');
  }
  var title = manifest.action && manifest.action.default_title;
  if (title && title.indexOf(version) === -1) {
    mismatch.push('manifest.action.default_title = "' + title + '"');
  }

  try {
    var html = read('popup/popup.html');
    var htmlHits = html.match(/Omitone-(\d+\.\d+\.\d+)/);
    if (!htmlHits) mismatch.push('popup/popup.html 未找到 Omitone-<版本> 标记');
    else if (htmlHits[1] !== version) mismatch.push('popup/popup.html = ' + htmlHits[1]);
    var verMatch = html.match(/<span class="ver">([\d.]+)<\/span>/);
    if (verMatch && verMatch[1] !== version) mismatch.push('popup/popup.html .ver = ' + verMatch[1]);
  } catch (e) {
    mismatch.push('popup/popup.html 读取失败');
  }

  try {
    var content = read('content.js');
    var brand = content.match(/<span class="brand">Omitone ([\d.]+)<\/span>/);
    if (!brand) mismatch.push('content.js 未找到状态面板品牌版本标记');
    else if (brand[1] !== version) mismatch.push('content.js 状态面板 = ' + brand[1]);
  } catch (e) {
    mismatch.push('content.js 读取失败');
  }

  // package.json —— 以前只查 manifest / popup / content 三处，package.json 漏在检查之外。
  // 它是 npm 脚本与发版脚本读的版本号，漂了不会有人发现。
  try {
    var pkg = JSON.parse(read('package.json'));
    if (pkg.version !== version) mismatch.push('package.json = ' + pkg.version);
  } catch (e) {
    mismatch.push('package.json 读取或解析失败');
  }

  // README 顶部的「版本」徽章 —— 它是用户第一眼看到的版本号，
  // 但一直没纳入自检，每发一版都可能忘了改（README 里其他 1.x.y 多是历史对照，不查）。
  try {
    var readme = read('README.md');
    var badge = readme.match(/badge\/版本-(\d+\.\d+\.\d+)-/);
    if (!badge) mismatch.push('README.md 未找到「版本」徽章');
    else if (badge[1] !== version) mismatch.push('README.md 版本徽章 = ' + badge[1]);
  } catch (e) {
    mismatch.push('README.md 读取失败');
  }

  if (mismatch.length) {
    fail('版本号不一致（manifest.version = ' + version + '）:\n      ' + mismatch.join('\n      '));
  } else {
    pass('版本号一致（manifest / popup / content / package.json / README 徽章）: ' + version);
  }
}

// ---------------------------------------------------------------------------
// 5. 唯一真源：提示词与 API 地址构造都不许内联
//
// 这两块历史上都在多处各写过一份，并且真的分叉过：
//   - 提示词曾同时存在于 content.js 与 legacy/background-core.js
//   - API 地址构造曾同时存在于 content.js 与 popup/popup.js，
//     且只有 popup 那份会剥掉用户粘贴时带的引号
// 分叉的后果是"弹窗测试通过、页面回答题失败"这类很难查的现象。
// ---------------------------------------------------------------------------
function checkSingleSources(manifest) {
  var content = read('content.js');
  var popup = read('popup/popup.js');
  var problems = [];

  // content.js 依赖的两个扩展模块必须真的在注入清单里，否则运行期会读成 null
  // （这个坑真踩过：抽走 API 构造函数后忘了加进 manifest）
  var injected = [];
  ((manifest && manifest.content_scripts) || []).forEach(function (entry) {
    (entry.js || []).forEach(function (f) { injected.push(f); });
  });
  if (content.indexOf('OmitoneApiUrl') !== -1 && injected.indexOf('libs/api-url.js') === -1) {
    problems.push('manifest.content_scripts 未注入 libs/api-url.js，但 content.js 依赖它');
  }
  if (content.indexOf('OmitonePrompt') !== -1 && injected.indexOf('libs/prompt.js') === -1) {
    problems.push('manifest.content_scripts 未注入 libs/prompt.js，但 content.js 依赖它');
  }
  if (content.indexOf('OmitoneFontTable') !== -1 && injected.indexOf('libs/font-table.js') === -1) {
    problems.push('manifest.content_scripts 未注入 libs/font-table.js，但 content.js 依赖它');
  }
  if (content.indexOf('OmitoneThinking') !== -1 && injected.indexOf('libs/thinking.js') === -1) {
    problems.push('manifest.content_scripts 未注入 libs/thinking.js，但 content.js 依赖它');
  }

  // 提示词
  [['buildQuestionsText', '提示词应只在 libs/prompt.js'],
   ['buildOutputFormat', '提示词应只在 libs/prompt.js'],
   ['Return format:', '不应内联 "Return format:" 字面量，应改用 PROMPT.buildUserPrompt']
  ].forEach(function (pair) {
    if (content.indexOf(pair[0]) !== -1) problems.push('content.js: ' + pair[1]);
  });
  if (content.indexOf('OmitonePrompt') === -1) {
    problems.push('content.js 未引用 OmitonePrompt，提示词模块可能未接入');
  }

  // API 地址构造
  [['content.js', content], ['popup/popup.js', popup]].forEach(function (pair) {
    var file = pair[0];
    var src = pair[1];
    // 只允许"转发"形态：函数体里应当出现 API_URL.xxx(...)
    ['buildOpenAICompatibleUrl', 'buildClaudeApiUrl', 'buildGeminiApiUrl'].forEach(function (fn) {
      var re = new RegExp('function\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{[^}]*\\}', 'm');
      var body = src.match(re);
      if (body && body[0].indexOf('API_URL.') === -1) {
        problems.push(file + ': ' + fn + ' 未走 libs/api-url.js（又内联了一份实现）');
      }
    });
  });
  if (content.indexOf('OmitoneApiUrl') === -1) problems.push('content.js 未引用 OmitoneApiUrl');
  if (popup.indexOf('OmitoneApiUrl') === -1) problems.push('popup/popup.js 未引用 OmitoneApiUrl');
  if (read('popup/popup.html').indexOf('libs/api-url.js') === -1) {
    problems.push('popup/popup.html 未加载 libs/api-url.js（弹窗会直接报错）');
  }

  if (problems.length) fail('唯一真源检查未通过:\n      ' + problems.join('\n      '));
  else pass('唯一真源检查通过（libs/prompt.js + libs/api-url.js）');
}

// ---------------------------------------------------------------------------
// 5b. 字形映射表：resources/table.bin 必须与 table.json 完全一致
//
// table.json 是**唯一真源**（可读、可维护，347KB），table.bin 是给运行时用的
// 紧凑二进制（122KB，占扩展体积的大头）。改了一个忘了重新打包，症状是
// "部分题干继续显示乱码"——不报错、不影响启动，非常难查。
// 所以这里逐条比对，而不是只比文件大小。
// ---------------------------------------------------------------------------
function checkFontTable() {
  // 注意 exists() 会再拼一次 ROOT，这里用相对路径传参
  var binRel = 'resources/table.bin';
  var jsonRel = 'resources/table.json';
  if (!exists(jsonRel)) { fail('resources/table.json 缺失（字形映射表的唯一真源）'); return; }
  if (!exists(binRel)) {
    fail('resources/table.bin 缺失 —— 跑 `node tools/table-pack.js --pack` 生成');
    return;
  }
  var result = spawnSync(process.execPath, [path.join(__dirname, 'table-pack.js'), '--verify'],
    { encoding: 'utf8' });
  if (result.status !== 0) {
    // ⚠️ 必须把 `result.error` 一起打出来。否则**spawn 本身失败**（实测本机
    // `spawnSync node.exe → EBUSY`）时，stdout/stderr 都是空的，
    // 报出来就是一句"字形映射表 bin/json 不同步:"后面**什么都没有** ——
    // 看起来像两个文件不一致，实际是两个文件根本没被比较过。
    // 这类"诊断信息把真实原因吞掉"的坑，本项目已经栽过好几次。
    var detail = String((result.stderr || '') + (result.stdout || '')).trim();
    if (!detail && result.error) detail = String(result.error);
    if (!detail) detail = '子进程没有输出（status=' + result.status + ' signal=' + result.signal + '）';
    fail('字形映射表 bin/json 不同步:\n      ' +
      detail.split('\n').join('\n      '));
    return;
  }
  var jsonSize = Math.round(fs.statSync(path.join(ROOT, jsonRel)).size / 1024);
  var binSize = Math.round(fs.statSync(path.join(ROOT, binRel)).size / 1024);
  pass('字形映射表同步（json ' + jsonSize + 'KB → bin ' + binSize + 'KB）');
}

// ---------------------------------------------------------------------------
// 5c. 用户入口守卫：下载直链与说明书
//
// 这两样是**非技术用户唯一的入手路径**。他们在 GitHub 上不会点绿色的 Code 按钮、
// 不会装 Git、也不看 Release 页面长什么样 —— 只会点 README 顶部那个下载链接。
//
// 链接一断，整个项目对他们就是"打不开"，而且**不会报错、不会留日志**，
// 只有用户默默走掉。所以当硬性检查：
//
//   1. 说明书 PDF 必须在**仓库根目录**（放 docs/ 里他们找不到）—— 它现在是
//      "离线 / 转发"入口，**在线**入口是 docs/manual.html（见第 7 条）
//   2. README 必须含指向 releases/latest/download/<固定附件名> 的直链
//   3. README 里所有相对链接指向的本地文件/目录必须真实存在
//   4. 说明书源文件里不许写死带版本号的压缩包名
// ---------------------------------------------------------------------------
var MANUAL_FILE = '使用说明.pdf';
var ZIP_ASSET = 'omitone.zip';

// 门面那一份 README —— 用户口径 2026-11-20「稳定版是我们的门面，树枝那边只为 AI 做事服务」：
// 稳定线上门面 = 工作树这一份（**不许**改成读 HEAD，否则未提交的门面改动量不到，
// 那是一条只会读旧账的尺）；支线上工作树那份是工作笔记，门面只能从 `git show main:README.md` 取。
// 第 5c 项（预览直链附件名形状）与第 34 项（门面该不该有入口）共用这一把尺，免得两处各判各的通道。
function facadeReadme(isExp) {
  if (!isExp) return { text: read('README.md'), from: 'README.md（工作树 = 门面）', why: '' };
  try {
    var gres = spawnSync('git', ['show', 'main:README.md'], {
      encoding: 'utf8', timeout: 15000, cwd: ROOT
    });
    if (gres.error) return { text: null, from: 'main:README.md', why: String(gres.error.code || gres.error.message) };
    if (gres.status !== 0) {
      return { text: null, from: 'main:README.md', why: '退出码 ' + gres.status + '（' +
        String(gres.stderr || '').trim().split(/\r?\n/)[0] + '）' };
    }
    if (!String(gres.stdout || '').trim()) return { text: null, from: 'main:README.md', why: '回包是空的' };
    return { text: String(gres.stdout).replace(/\r\n/g, '\n'), from: 'main:README.md', why: '' };
  } catch (e) { return { text: null, from: 'main:README.md', why: String((e && e.message) || e) }; }
}

function checkUserEntryPoints() {
  var problemsHere = [];

  // 1) 说明书在根目录
  if (!exists(MANUAL_FILE)) {
    problemsHere.push('仓库根目录缺少 ' + MANUAL_FILE +
      ' —— 跑 `npm run manual` 生成（README 顶部的下载入口直接指向它，缺了就是死链）');
  } else {
    var manualKb = Math.round(fs.statSync(path.join(ROOT, MANUAL_FILE)).size / 1024);
    if (manualKb < 100) problemsHere.push(MANUAL_FILE + ' 只有 ' + manualKb + 'KB，疑似生成失败的空壳');
  }
  if (exists('docs/Omitone-manual.pdf')) {
    problemsHere.push('docs/Omitone-manual.pdf 还在 —— 说明书已挪到根目录，' +
      '旧文件留着会变成两份各自漂移的说明书');
  }

  var readme = read('README.md');

  // 2) 下载直链
  var zipRe = ZIP_ASSET.replace(/\./g, '\\.');
  if (!new RegExp('releases/latest/download/' + zipRe).test(readme)) {
    problemsHere.push('README.md 里没有 releases/latest/download/' + ZIP_ASSET + ' 直链 —— ' +
      '不懂 GitHub 的人只认这个链接');
  }
  if (/releases\/latest\/download\/omitone-\d/.test(readme)) {
    problemsHere.push('README.md 的下载直链用了带版本号的附件名 —— ' +
      '附件名必须固定为 ' + ZIP_ASSET + '，否则每发一版直链就失效一次');
  }

  // 2b) 预览直链的形状（**门面**上的第二个入口，不管当前在哪条线工作）
  //
  // ⚠️ 这里只钉**形状**，不钉"该不该有"（那归第 34 项按通道判）。理由：
  //    这一条一旦写错，两种错法都不报错 —— 挂到 `/releases/latest` 下面就是 404
  //    （预览附件不在正式版那一版里），复用 `omitone.zip` 这个名字就是把实验版
  //    发到正式口上（`releases/latest/download/omitone.zip` 按**名字**取件）。
  //    前者同学骂作者链接坏了，后者是**所有人静悄悄地换上实验版**，都只有人来反馈才知道。
  // ⚠️ 这一族**两页都要扫**：工作树那份与门面那一份。只扫工作树，在支线上等于
  //    给草稿本查门面的错（main 上写错形状没人管）；只扫门面，支线工作树上真写错了又抓不住。
  var pvShapes = [
    [/releases\/download\/preview\/omitone\.zip/, '写成 releases/download/preview/omitone.zip —— 那是稳定通道的附件名，' +
      '两条通道共用一个名字，正式版那条永久直链就变成给实验版发件'],
    [/releases\/latest\/download\/omitone-preview/, '挂在 /releases/latest 下面 —— 预览附件不在正式版那一版里，点开就是 404']
  ];
  var pvScanTexts = [{ from: 'README.md（工作树）', text: readme }];
  var PV_OK = ['omitone-preview.zip', 'Omitone-manual-preview.pdf'];
  // ⚠️ 提取只取**文件名那一截**的合法字符。上一版的字符类是「除空白和括号引号之外都吃」，
  //    而 README 除了完整直链，还把路径写进反引号小字（`…/preview/omitone-preview.zip`）——
  //    闭引号和全角括号一起进了匹配，切出的尾巴带着那两个字符，**干净文档也报红**。
  //    会误报的守卫和没有守卫一样害人（AGENTS §5），所以这一格配三条对照自己钉住提取器。
  var pvNamesOf = function (text) {
    var out = [], mm, re = /releases\/download\/preview\/([A-Za-z0-9._\-]+)/g;
    while ((mm = re.exec(text))) out.push(mm[1]);
    return out;
  };
  var pvSelf = [
    ['名字写错的完整直链必须被逮住', pvNamesOf('https://git.io/x/releases/download/preview/omitone.zip').join() === 'omitone.zip'],
    ['反引号里的相对路径不许读成名字对不上', pvNamesOf('写在 `releases/download/preview/omitone-preview.zip`）里').join() === 'omitone-preview.zip'],
    ['说明书附件名照旧在许可名单里', pvNamesOf('releases/download/preview/Omitone-manual-preview.pdf').join() === 'Omitone-manual-preview.pdf']
  ];
  var pvSelfBad = pvSelf.filter(function (c) { return c[1] === false; });
  if (pvSelfBad.length) {
    problemsHere.push('预览直链提取器自己的对照格没过：' + pvSelfBad.map(function (c) { return c[0]; }).join(' / ') +
      ' —— 这一闸现在要么抓不住写错的名字，要么会误报');
  }
  // 门面那一页才有人类看得见的下载入口 —— 支线上工作树是工作笔记，只扫它会得到"0 处命中"这种
  // **最坏的绿**（闸没跑却像跑过）。所以这一格与第 34 项同一把尺：按通道取门面文本，两页各扫一遍。
  var pvGate = require('./channel-gate.js');
  var pvIsExp = pvGate.isExperimental(pvGate.readChannelNames().version_name);
  var pvFacade = facadeReadme(pvIsExp);
  if (pvFacade.text && pvFacade.text !== readme) pvScanTexts.push({ from: pvFacade.from, text: pvFacade.text });
  pvScanTexts.forEach(function (t) {
    pvShapes.forEach(function (p) {
      if (p[0].test(t.text)) problemsHere.push(t.from + ' 的预览直链' + p[1]);
    });
  });
  var pvLinks = pvFacade.text ? pvNamesOf(pvFacade.text) : [];
  var pvBad = pvFacade.text ? pvLinks.filter(function (u) { return PV_OK.indexOf(u) === -1; }) : [];
  if (pvBad.length) {
    problemsHere.push('门面（' + pvFacade.from + '）的预览直链里有对不上预览附件名的地址：' + pvBad.join(' / ') +
      '（只许 ' + PV_OK.join(' / ') + '）—— 名字写错就是 404，而 README 那一页看不出来');
  }
  if (!pvFacade.text) {
    problemsHere.push('取不回门面那一页（' + pvFacade.why + '）—— 「预览附件名对不对」这一格本轮**根本没跑**，' +
      '别把没跑读成通过（支线上门面只能从 git 取，第 34 项 g 同一发）');
  } else if (!pvLinks.length) {
    // 卫生格：门面里一处预览直链都扫不到 = 提取器整体空命中，措辞被改写时这条会静默变绿。
    // 通道无关（预览入口是门面的固定组成部分，转正也不撤 —— 用户 2026-11-20）。
    problemsHere.push('门面（' + pvFacade.from + '）里一处预览直链都没扫到 —— 「预览附件名对不对」这一闸这一轮根本没跑，' +
      '别把这条读成通过（该不该有预览口归第 34 项判）');
  }

  // 3) 给人读的文档里的相对链接必须真实存在
  //
  // 只查 README 是不够的：HANDOVER / AGENTS / ARCHITECTURE 之间互相引用很多，
  // 而"重命名了文件却忘了改引用"不会报错、不会有人发现，点开就是 404。
  // 文档链接的死活恰恰是接手的人最先踩到的坑。
  var DOCS = ['README.md', 'HANDOVER.md', 'AGENTS.md', 'ARCHITECTURE.md'];
  var broken = [];
  DOCS.forEach(function (doc) {
    if (!exists(doc)) return;
    var text = read(doc);
    var linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    var m;
    while ((m = linkRe.exec(text))) {
      var target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.charAt(0) === '#') continue; // 外链 / 页内锚点
      target = target.split('#')[0];
      if (target && !exists(target)) broken.push(doc + ' → ' + target);
    }
  });
  if (broken.length) {
    problemsHere.push('文档里有指向不存在文件的链接（点开就是 404）: ' + broken.join(', '));
  }

  // 3b) README 里的 `<img>` **不许用相对路径**（GitHub 只重写 markdown 图片，不重写 HTML 的）
  //
  // 真实故障：门面两张弹窗截图写成 `<img src="docs/images/popup.png">`。
  // GitHub 的渲染器把 markdown `![]()` 的相对路径改写成 raw 直链，
  // 却**原样留着 HTML `<img src>`** —— 浏览器于是按当前页面地址去拼，
  // 请求打到 `https://github.com/TYT0807/Omitone/blob/main/docs/images/popup.png`，
  // 那是一整张网页而不是 PNG，**图片当场裂掉、什么错都不报**。
  // 上面第 3 条只查"文件在不在仓库里"，它一直是通过的 —— 所以这条单独查**能不能渲染**。
  // 写法只有两种是对的：绝对 raw 直链，或改用 markdown `![alt](路径)` 语法。
  var imgRe = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  var badImg = [];
  var imgM;
  while ((imgM = imgRe.exec(readme))) {
    var src = imgM[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.charAt(0) === '/') continue; // 绝对地址 / 站根路径
    badImg.push(src);
  }
  if (badImg.length) {
    problemsHere.push('README.md 的 HTML <img> 用了相对路径（GitHub 不会重写，页面上就是裂图）: ' +
      badImg.join(', ') + ' —— 改成绝对 raw 直链，或换成 markdown 图片语法');
  }

  // 4) 说明书源文件里不许写死带版本号的压缩包名
  var hardcoded = read('docs/manual.html').match(/omitone-\d+\.\d+\.\d+\.zip/);
  if (hardcoded) {
    problemsHere.push('docs/manual.html 写死了压缩包名 ' + hardcoded[0] + ' —— ' +
      '附件名固定为 ' + ZIP_ASSET + '，写版本号会让说明书一升级就过期');
  }

  // 5) 发布附件名必须是纯 ASCII
  //
  // GitHub 的上传接口会把非 ASCII 附件名**洗成 `default.pdf`**，而且照常返回 201 成功 ——
  // 不报错、不留日志，用户看到的就是 Release 页面上一个叫 default.pdf 的附件。
  // v1.1.2 发布时真踩过（附件 `使用说明.pdf` 落成了 `default.pdf`），
  // 所以在这里静态拦下：**文件可以叫中文名，上传的名字必须是 ASCII**。
  var relSrc = read('tools/github-release.js');
  var assetsBlock = relSrc.match(/var ASSETS = \[[\s\S]*?\];/);
  if (!assetsBlock) {
    problemsHere.push('tools/github-release.js 里找不到 ASSETS 声明 —— ' +
      '附件名守卫读不到目标，请同步这段正则');
  } else {
    var nameRe = /name:\s*'([^']*)'/g;
    var nm;
    while ((nm = nameRe.exec(assetsBlock[0]))) {
      if (/[^\x00-\x7F]/.test(nm[1])) {
        problemsHere.push('发布附件名 "' + nm[1] + '" 含非 ASCII 字符 —— ' +
          'GitHub 会把它洗成 default.pdf，且返回 201 不报错。附件名必须纯 ASCII');
      }
    }
  }


  // 6) 说明书**源文件**里的版本号必须与当前版本一致
  //
  // 为什么单列一条：stamp() 只在生成 PDF 时盖**临时副本**，
  // 源文件 docs/manual.html 不会被改回去 —— 于是它会一直烂着。
  // 实测 1.1.6 时源文件里同时躺着 `1.1.1`（三处）与 `1.1.5`（两处）。
  //
  // 为什么是**真问题**：只要有人直接打开 docs/manual.html
  // （浏览器打开、或将来开 GitHub Pages 当网页版入口），
  // 他看到的就是一份自己写着"版本 1.1.1"的说明书。不报错、不留日志。
  //
  // 判定口径：带历史措辞的引用（「1.1.0 专门修过」）允许保留；
  // 裸的 `版本 x.y.z` / `Omitone-x.y.z` 必须等于当前版本。
  var manualHtml = read('docs/manual.html');
  var manualVer = JSON.parse(read('manifest.json').replace(/^\uFEFF/, '')).version;
  [['版本行', /版本\s+(\d+\.\d+\.\d+)/g], ['品牌名', /Omitone[-\s](\d+\.\d+\.\d+)/g]]
    .forEach(function (pair) {
      var label = pair[0], re = pair[1], m;
      re.lastIndex = 0;
      while ((m = re.exec(manualHtml))) {
        if (m[1] === manualVer) continue;
        var ls = manualHtml.lastIndexOf('\n', m.index) + 1;
        var le = manualHtml.indexOf('\n', m.index);
        var line = manualHtml.slice(ls, le === -1 ? undefined : le);
        // 历史措辞（「1.1.0 专门修过」这类）是正文引用，允许保留
        if (/\d+\.\d+\.\d+\s*(起|已修|专门|新增|时|之前|那时)/.test(line)) continue;
        problemsHere.push('docs/manual.html 第 ' +
          (manualHtml.slice(0, m.index).split('\n').length) + ' 行「' + m[0].trim() +
          '」与当前版本 ' + manualVer + ' 不符 —— ' +
          '直接打开这份源文件的人会看到过期版本号。跑 `npm run manual` 或手工同步');
      }
    });

  // 7) 说明书必须有**双入口**：在线版 + PDF 版
  //
  // 本项目的真实故障：原来只有 `使用说明.pdf` 相对链接，在 GitHub 上会落到
  // `blob/main/使用说明.pdf` —— 代码视图。PDF 走这条路是"赌运气"：
  // GitHub 社区里 `Unable to render code block` 的头号成因是浏览器扩展
  // （暗色模式 / 翻译 / 广告拦截），其次是代理与渲染器超时。用户实测点开就是报错。
  //
  // 所以两条都要有，且各自不赌渲染器：
  //   - 在线版 docs/manual.html：纯 HTML，GitHub 一定显示得出来
  //   - PDF 版 走 Release 附件直链：下载通道，与渲染器完全无关
  //
  // 将来若有人图省事删掉在线入口、只留 PDF，故障会原样复发 —— 且不报错。
  var MANUAL_ONLINE = 'docs/manual.html';
  var MANUAL_PDF_ASSET = 'Omitone-manual.pdf';
  if (!exists(MANUAL_ONLINE)) {
    problemsHere.push('缺少在线说明书 ' + MANUAL_ONLINE +
      ' —— README 顶部的"在线看图解说明书"指向它，缺了就是死链');
  }
  // 在线入口当前走 GitHub Pages（真网页，比 blob 源码视图体验好得多），
  // 但两种写法都认 —— 判据只看"有没有指向说明书的链接目标"：
  //   1) Pages 外链   ](https://<user>.github.io/.../docs/manual.html)
  //   2) 仓库内相对路径 ](docs/manual.html)
  //
  // ⚠️ 别把这里改成"README 里必须出现 docs/manual.html 这个字符串" ——
  // 那会让"只留 Pages 外链"这种完全正确的写法被误判成失败（反向验证抓到过）。
  var hasPagesLink = /\]\(https:\/\/[a-z0-9-]+\.github\.io\/[^)\s]*docs\/manual\.html/i.test(readme);
  var hasRelLink = readme.indexOf('](' + MANUAL_ONLINE + ')') !== -1;
  var hasOnlineEntry = hasPagesLink || hasRelLink;
  if (!hasOnlineEntry) {
    problemsHere.push('README.md 里没有指向在线说明书的入口（' + MANUAL_ONLINE + '）—— ' +
      'Pages 外链或仓库内相对路径都行，但**必须有**。只留 PDF 的话，' +
      'PDF 在 GitHub 上会赌渲染器（报 Unable to render code block）。双入口缺一不可');
  }
  if (readme.indexOf('releases/latest/download/' + MANUAL_PDF_ASSET) === -1) {
    problemsHere.push('README.md 里没有指向 releases/latest/download/' + MANUAL_PDF_ASSET +
      ' 的 PDF 下载入口 —— 走附件通道才不会赌渲染器（附件名必须是纯 ASCII）');
  }

  // 5) 说明书的「四问结构」不许漏
  //
  // 这份说明书的全部价值就在那四问上：读者卡住几乎从来不是"不知道要装扩展"，
  // 而是"不知道自己看到的那一屏算不算对"。所以每一处动手点都必须四问齐全 ——
  // 漏掉"怎样才算对"这一行，读者就只能靠猜，而这是**看不出来**的（页面照样渲染）。
  //
  // 只数总数没用：四问是四行，光看「怎样才算对」出现几次，漏一个也发现不了
  // —— 必须逐个检查每一张表里的四个关键词。
  if (exists(MANUAL_ONLINE)) {
    var man = read(MANUAL_ONLINE);
    var blocks = man.split('class="do"').slice(1);
    if (!blocks.length) {
      problemsHere.push(MANUAL_ONLINE + ' 里一个"四问表"（class="do"）都没有 —— ' +
        '说明书改版时把担架段删了？读者就没法判断"做对了没有"了');
    }
    var FOUR = ['你会看到什么', '点哪里', '怎样才算对', '不对怎么办'];
    blocks.forEach(function (blk, i) {
      var cut = blk.indexOf('</table>');
      var inner = cut >= 0 ? blk.slice(0, cut) : blk;
      var lack = FOUR.filter(function (k) { return inner.indexOf(k) === -1; });
      if (lack.length) {
        problemsHere.push('说明书第 ' + (i + 1) + ' 个四问表缺少：' + lack.join('、') +
          ' —— 四问少一问，读者就只能靠猜（页面不会报错，只能靠这条守卫）');
      }
    });
  }

  // 6) README 写的说明书页数必须与 PDF 实际页数一致
  //
  // 这条以前是"等下次有人发现"的：README 长期写着 13 页而 PDF 是 14 页，
  // 后来又写成 14 页而 PDF 变成 20 页。页数会随内容变，**必须机器核对**。
  //
  // ⚠️ 只在 PDF 存在时才查 —— 缺 PDF 那件事上面第 1 条已经报过了，
  // 这里再报一次只会让同一个故障出现两条信息。
  if (exists(MANUAL_FILE)) {
    var pdfText = fs.readFileSync(path.join(ROOT, MANUAL_FILE)).toString('latin1');
    var realPages = (pdfText.match(/\/Type \/Page[^s]/g) || []).length;
    // ⚠️ 这段踩过两次坑，别再改回去：
    //   1) 不能写 `使用说明\.pdf\*{0,2}\s*\|...` —— 实际那格是
    //      `**\`使用说明.pdf\`** | ...（反引号+星号+竖线），放行星号匹配不上；
    //   2) 固定窗口也**不够** —— 从文件名往后数 40 字才刚够到「PDF 版**」，
    //      那个「（20 页」的括号落在窗口外，于是照样静默通过。
    //   改成：先定位**整行**（到换行符为止），再在这一行里找「N 页」。
    var claim = null;
    var at = readme.indexOf(MANUAL_FILE);
    if (at >= 0) {
      var nl = readme.indexOf('\n', at);
      var line = readme.slice(at, nl < 0 ? readme.length : nl);
      var cm = line.match(/（\s*(\d+)\s*页/);
      if (cm) claim = cm[1];
    }
    if (claim && realPages && Number(claim) !== realPages) {
      problemsHere.push('README 说说明书 ' + claim + ' 页，而 使用说明.pdf 实际是 ' +
        realPages + ' 页 —— 改完说明书要跑 `npm run manual` 并同步这一处');
    }
  }
  // 7) 说明书**自己**也要能点着下载
  //
  // 这条是补漏：README 有双入口（上面第 4 条盯着），但说明书**正文里一个可点的
  // 下载链接都没有** —— 只写着"打开项目首页，点最上面那个按钮"。
  // 问题在于说明书是会被**单独转发**的：有人把 PDF 或在线版链接发给同学，
  // 对方手里只有这一份文件，上面那句"打开项目首页"就成了空话 —— 他得自己
  // 去搜仓库名。而且这两件事都不会报错，页面照样渲染得好好的。
  //
  // ⚠️ 判据只看"说明书里有没有指向这两个附件直链的 <a href>"，
  //    不要求它出现在封面 —— 放哪儿都行，改版时挪位置不算故障。
  if (exists(MANUAL_ONLINE)) {
    var manLinks = read(MANUAL_ONLINE);
    if (manLinks.indexOf('releases/latest/download/' + ZIP_ASSET) === -1) {
      problemsHere.push(MANUAL_ONLINE + ' 里没有指向 releases/latest/download/' + ZIP_ASSET +
        ' 的下载链接 —— 说明书会被单独转发，对方手里只有这一份，' +
        '没有可点的链接他就只能自己去找仓库');
    }
    if (manLinks.indexOf('releases/latest/download/' + MANUAL_PDF_ASSET) === -1) {
      problemsHere.push(MANUAL_ONLINE + ' 里没有指向 releases/latest/download/' + MANUAL_PDF_ASSET +
        ' 的 PDF 下载链接 —— 同上：单独拿到这份说明书的人应该能就地转存 PDF 版');
    }
  }

  // 8) 体积账本：README 里那些「约 N MB (P%)」必须对着构建出来的 zip 逐条目对得上
  //
  // 这一族以前只能靠人肉 `wc -c` 加心算，实测一批就漂了五格（文档写 3.3 / 2.02 / 1.75 MB，
  // zip 里实际是 3.50 / 2.25 / 1.80）—— 文件语法正常、集成与 e2e 全绿，
  // 只有用户在 GitHub 那一页看得见（§2 #9 那一族"只有人眼能看见"的失败形状）。
  // ⚠️ 真源是 **`dist/*.zip` 的中央目录**，不是磁盘目录：磁盘上躺着不打包的件
  //    （`resources/table.json` 347 KB、各处 README、`src/`），拿磁盘合计会得出另一套"错"数。
  // ⚠️ 缺 zip / 量不出来 / 门面读不到 / 一行表格都没扫到，各自单独占一格（§2 #12），不许压成通过。
  var sizeReadout = '';
  try {
    // 先跑这把尺自己的逐格对照，再拿它量文档 —— 尺坏了，量出来的"对"没有内容
    var sizePath = path.join(__dirname, 'audit-readme-size.js');
    var stRes = spawnSync(process.execPath, [sizePath, '--selftest'], { encoding: 'utf8', timeout: 60000 });
    var stTxt = String(stRes.stdout || '') + String(stRes.stderr || '');
    var stM = stTxt.match(/自检\s*(\d+)\s*\/\s*(\d+)\s*格通过/);
    if (stRes.error) {
      problemsHere.push('体积账本的逐格对照没跑成：' + String(stRes.error.code || stRes.error.message));
    } else if (!stM) {
      problemsHere.push('体积账本的逐格对照没打印那句「自检 N / M 格」（末行=' +
        JSON.stringify(stTxt.trim().split(/\r?\n/).pop()) + '）—— 读不出当失败，不当通过');
    } else if (stRes.status !== 0) {
      // 退出码非 0 的两种成因分开说：某一格红了要点名是哪一格（要修尺），
      // 中途崩了连格子名单都没交出来才是读不出（§2 #12，不许压成同一格）
      var stFails = stTxt.split(/\r?\n/).filter(function (l) { return /^\[FAIL\]/.test(l); })
        .map(function (l) { return l.split('[FAIL]')[1].split(' → ')[0].trim(); });
      problemsHere.push(stFails.length ?
        '体积账本的逐格对照红在 ' + stFails.join(' / ') + '（绿 ' + stM[1] + ' / ' + stM[2] + ' 格）—— 尺自己坏了，' +
          '它量出来的「对」没有内容（摘掉任意一格，红就点那一格的名）' :
        '体积账本的逐格对照退出码 ' + stRes.status + ' 却没交回任何格子名（末行=' +
          JSON.stringify(stTxt.trim().split(/\r?\n/).pop()) + '）—— 读不出当失败，不许当通过');
    } else if (Number(stM[1]) !== Number(stM[2]) || Number(stM[2]) < 18) {
      problemsHere.push('体积账本的逐格对照只绿 ' + stM[1] + ' / ' + stM[2] + ' 格（下限 18）—— ' +
        '有格被跳过或被删时，"全绿"这两个字就没有内容');
    } else {
      var sizeAudit = require('./audit-readme-size.js');
      var sizeAct = sizeAudit.measure();
      if (sizeAct.verdict === 'missing-zip') {
        problemsHere.push('体积账本这一格本轮没跑：没有 ' + sizeAct.zipName +
          ' —— 先 `npm run build`，没有包就没有"用户下载到的字节"这份真源，不许拿磁盘目录顶上');
      } else if (sizeAct.verdict !== 'ok') {
        problemsHere.push('体积账本量不出来：' + sizeAct.verdict + '（读不出单独占一格，不许当成通过）');
      } else {
        var sizeGate = require('./channel-gate.js');
        var sizeExp = sizeGate.isExperimental(sizeGate.readChannelNames().version_name);
        var sizePages = [{ text: readme, from: 'README.md（工作树）' }];
        if (sizeExp) {
          var sizeFacade = facadeReadme(true);
          if (sizeFacade.text === null) {
            problemsHere.push('体积账本没量到门面那一份（' + sizeFacade.why + '）—— 门面是用户默认看到的' +
              '那一页，读不到就单独占一格，不许只量工作树那一份就打印通过');
          } else {
            sizePages.push({ text: sizeFacade.text, from: sizeFacade.from });
          }
        }
        var sizeRes = sizeAudit.auditPages(sizePages, sizeAct);
        sizeRes.problems.forEach(function (p) { problemsHere.push(p); });
        // 扫到几行、几处承诺必须印出来：措辞被整体改写时扫描会静默变成 0 命中，那是最坏的一种绿（§2 #21）
        sizeReadout = '，体积账本对着 ' + sizeAct.zipName + '（' + sizeAct.entries + ' 个条目 / ' +
          Math.round(sizeAct.zipBytes / 1048576 * 100) / 100 + ' MB）逐格比过 ' + sizeRes.readouts.join(' + ');
      }
    }
  } catch (sizeErr) {
    problemsHere.push('体积账本这一格跑挂了：' + String((sizeErr && sizeErr.message) || sizeErr));
  }

  if (problemsHere.length) fail('用户入口检查未通过:\n      ' + problemsHere.join('\n      '));
  else pass('用户入口完好（根目录 ' + MANUAL_FILE + ' + README 直链 ' + ZIP_ASSET + sizeReadout + '）');
}

// ---------------------------------------------------------------------------
// 6. 死代码探测：没人引用的 .js
//
// 一个 JS 文件可以通过四种途径被加载，四种都要认，否则会误报：
//   1. manifest.content_scripts[].js —— content.js 及其依赖
//   2. manifest.background.service_worker —— background.js
//   3. manifest.web_accessible_resources —— page.js（运行时动态插入 <script src>）
//   4. 任意 .html 里的 <script src="...">
// ---------------------------------------------------------------------------
function collectHtmlScriptRefs() {
  var refs = [];
  function walk(dir) {
    var base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) return;
    fs.readdirSync(base, { withFileTypes: true }).forEach(function (entry) {
      if (['node_modules', '.git', 'dist', '.debug-profile', '.workbuddy'].indexOf(entry.name) !== -1) return;
      var relPath = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) return walk(relPath);
      if (!/\.html$/.test(entry.name)) return;
      var html = read(relPath);
      var re = /<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
      var m;
      while ((m = re.exec(html))) {
        if (/^https?:|^chrome-extension:/.test(m[1])) continue;
        refs.push(path.posix.normalize(path.posix.join(path.posix.dirname(relPath), m[1])));
      }
    });
  }
  walk('');
  return refs;
}

// ---------------------------------------------------------------------------
// 12. 配置接线守卫（两件事，都属于"配好了却没生效"这一类）
//
// A) 读了就必须有自己的默认值
//    三份默认值（page.js 的 DEFAULT_CONFIG / content.js 的 configs / popup.js 的 DEFAULTS）
//    服务的目的本来就不同，**不该长得一样**：page 是全部运行期开关，popup 只管界面上有的，
//    content 是"配置还没加载时"的兜底。所以"三份键不一致"本身不是 bug ——
//    真正会出事的是：**某个文件读了 configs.X，但它自己的默认值里没有 X。**
//    这时读到的永远是 undefined，开关表现成"打开了也没用"，不报错、不留日志。
//    （实测查出过 popupQuizMaxAttempts / apiConnectionError 两个。）
//
// B) 界面上有的开关，就必须完整接线
//    一个开关要能用，得同时满足三件事：bindToggle 绑上、load() 里读回、保存时写出去。
//    少任何一件，开关就是"看着能点、其实不生效"或"存不住"。
//    ⚠️ 不能用"UI 的 id 就是配置键"来推断 —— 实测 autoMaxRate 的配置键叫
//    autoMaxPlaybackRate，按 id 猜会误报。这里用**变量名**做纽带：
//    bindToggle(els.<id>, () => <VAR> …) 拿到 VAR，再看 VAR 与哪个 config.<KEY> 对应。
//
// C) 界面能存的键，后台策略（libs/runtime-policy.js）必须认
//    A/B 全绿也照样能废掉整张配置表：弹窗保存发的是**一整张补丁**，
//    策略里 `validatePatch` 遇到任何没登记（或值不合法）的键就拒**整张**，
//    于是"一个键没登记"表现成"所有开关都存不住"。
//    （2026-11-12 同学机器实测：slowMachineMode 自 2026-11-10 起没登记，
//    弹窗每次保存都带上它 → 用户点任何一个开关都失败。）
//    这一条拿 DEFAULTS 当"界面可存词汇表"逐键喂给真的 validatePatch，
//    并顺带核对该键在界面上**实际会发出的字面量**（三元分支，如 "on"/"auto"）。
//
// D) 存得住 ≠ 生效：页面会读的键必须真的被 publicConfig(study) 投影出去
//    页面那份 configs 只装得下投影结果，没投影的键页面读到的永远是自己的默认值，
//    症状同样是"打开了也没用"。这一条把 C 的词汇表接着往下游查一层。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 13. 测试数字守卫：文档里写的场景数必须等于代码里真实的场景数
//
// 这个数字散在五份文档里，全靠手工同步 —— 历史上已经漂过三轮（14 → 18 → 19），
// 每次都要人工找出"哪几份忘了改"。
//
// 场景数是**静态可数**的（browser-e2e.js 里几个 `SCENARIOS.push` 就是几个场景），
// 所以这条能真正守住。断言总数是**运行期**才算出来的（含每场景动态断言），
// 静态守不住，只能靠 e2e 自己打印，这里不查。
//
// ⚠️ CHANGELOG 是历史记录：里面「14 个场景」「18 个场景」都是**当时的事实**，
// 不能拿今天的数字去要求它。所以只查它的「未发布」段，其余整篇跳过。
// ---------------------------------------------------------------------------
function checkTestCounts() {
  var problems = [];
  // ⚠️ 这两个标志必须声明在**所有**用到它们的代码块之前。
  // 踩过：itestChecked 原先声明在集成校验块后面，块里刚置的真被后面的 var 重置回 false ——
  // 症状是明明跑过 itest、守卫却说「集成条数未校验」。
  var assertionsChecked = false;
  var itestChecked = false;
  var itestPairHits = 0;
  var selfCheckChecked = false;
  // ⚠️ 同上一条教训：这两格也必须声明在所有用到它的代码块之前（下面「N 场景 / M 项」那一段才置位）。
  var scenePairChecked = false;
  var scenePairHits = 0;

  var src = read('tools/browser-e2e.js');
  var actualScenes = (src.match(/SCENARIOS\.push\(/g) || []).length;
  if (!actualScenes) {
    problems.push('tools/browser-e2e.js 里没数到 SCENARIOS.push —— 守卫失效，请同步这段正则');
  }

  // 取 CHANGELOG 的**最新一段**（第一个二级标题到下一个二级标题之间）。
  // 别写死找「## 未发布」—— 发版时那一段会被改名成 `## 1.2.0 — …`，
  // 写死的话守卫会静默失去覆盖（找不到就当空字符串跳过了）。
  var latest = '';
  try {
    var cl = read('CHANGELOG.md');
    var start = cl.search(/^## /m);
    if (start >= 0) {
      var rest = cl.slice(start + 1);
      var next = rest.indexOf('\n## ');
      latest = next >= 0 ? rest.slice(0, next) : rest;
    }
  } catch (e) {}

  // ⚠️ **历史记录豁免**（2026-11-10 加，代价极高的一次教训）：
  // 这条守卫原先把文档**整文件逐行**核数，于是「新一轮实测项数变多」会逼着
  // 把历轮台账里的旧实测值一起刷新 —— 上一轮就为了绿灯，把 20 多处历史行
  // 整片 610→635，1.2.9 那一行现在写着「集成 106 项 / e2e 635 项」这种
  // **从来没同时存在过的组合**。假记录比旧记录更糟：它会误导下一个接手的人，
  // 而他自己没法分辨。
  //
  // 写法**只有一种**：把 `<!-- 历史计数:start --><!-- 历史计数:end -->` 成对写在
  // **那一行的行尾**，它只豁免**自己这一行**。
  // 为什么不提供"区间式"豁免（start 一行、end 一行）：两个实测踩到的理由 ——
  //   ① 这些历史行是 **markdown 表格行 / 引用块 / 列表续行**，中间插一整行注释会
  //      **打断表格与引用块的结构**（渲染出来就不是那张表了）；
  //   ② 区间式一旦漏写 end，它**下面的所有内容静默脱检**，守卫照样绿灯。
  //      （本轮反向验证就是这么发现我自己的 bug 的：把单行标记误判成区间起点后，
  //       从第一条历史行起整篇 HANDOVER 全部免检，而抹掉标记的注入**照样不报红**。）
  // 半截标记（只有 start 或只有 end）直接报错；把整篇计数全豁免掉也直接报错。
  //
  // 覆盖率没有下降：现行声明（HANDOVER 页首基线、§1 三十秒速览、§9 当前已知未解决、
  // README「本版新增」、AGENTS §1、CHANGELOG 最新段）全在标记之外，照旧逐行硬核。
  var HIST_START = /<!--\s*历史计数:start\s*-->/;
  var HIST_END = /<!--\s*历史计数:end\s*-->/;
  var HIST_COUNT = /(?:e2e|交叉检验|端到端)[^。\n]{0,40}?\d+\**\s*项/;
  function liveOnly(file, text) {
    if (!text) return '';
    var lines = String(text).split(/\r?\n/);
    var out = [];
    lines.forEach(function (line) {
      var s = HIST_START.test(line), e = HIST_END.test(line);
      if (!s && !e) { out.push(line); return; }
      if (s !== e) {
        problems.push(file + ' 有一处「历史计数」标记只写了半截（start=' + s + ' end=' + e + '）：' +
          line.slice(0, 60) + ' —— 只支持**同一行成对**的写法，半截等于没说清豁免哪一行');
        out.push(line);   // 半截时**不豁免**，宁可多报也不静默脱检
        return;
      }
      // 同行成对 = 只豁免这一行
    });
    // **豁免面自证**：原文有计数声明、豁免后一条不剩 → 这条守卫对该文件已等于不存在，必须响。
    var before = lines.filter(function (l) { return HIST_COUNT.test(l); }).length;
    var after = out.filter(function (l) { return HIST_COUNT.test(l); }).length;
    if (before > 0 && after === 0) {
      problems.push(file + ' 的「历史计数」标记把全部 ' + before + ' 条计数声明都豁免了 —— ' +
        '这条守卫对它已经等于不存在；只该给**当时的事实**那一行加标记，现行的基线声明必须留检');
    }
    return out.join('\n');
  }

  var targets = [
    ['AGENTS.md', null],
    ['README.md', null],
    ['tools/README.md', null],
    ['HANDOVER.md', null],
    ['CHANGELOG.md', latest]
  ].map(function (t) {
    var text = t[1];
    if (text === null) { try { text = read(t[0]); } catch (e) { text = ''; } }
    return [t[0], liveOnly(t[0], text)];
  });

  targets.forEach(function (t) {
    var file = t[0], text = t[1];
    if (text === null) {
      try { text = read(file); } catch (e) { return; }
    }
    if (!text) return;
    var re = /(\d+)\s*个场景/g, m;
    while ((m = re.exec(text))) {
      if (Number(m[1]) !== actualScenes) {
        problems.push(file + ' 写的是 ' + m[1] + ' 个场景，代码里实际是 ' + actualScenes + ' 个');
      }
    }
  });

  // ---- 集成测试条数：同样由测试自己落盘（`.workbuddy/itest-counts.json`）----
  // 与上面 e2e 那段同款。**为什么也要守**：改了集成测试条数就得手工同步十几处文档，
  // 漏一处不会有任何提示（1.2.7 那次 77 → 106 就是手工改了 14 处）。
  //
  // ⚠️ 关键词用 `集成`，取它**之后**的第一个 `N 项`。
  // 同一行常同时含「自检 17 项 · 集成 106 项 · e2e 312 项」，
  // 所以不能整行扫数字（那会把自检、e2e 的数字一起误伤 —— 上面那段注释记着这个坑）。
  var itestFile = path.join(ROOT, '.workbuddy', 'itest-counts.json');
  if (fs.existsSync(itestFile)) {
    try {
      var itestCounts = JSON.parse(fs.readFileSync(itestFile, 'utf8'));
      var actualItest = Number(itestCounts.assertions);
      if (actualItest > 0) {
        itestChecked = true;
        targets.forEach(function (t) {
          var file = t[0], text = t[1];
          if (text === null) { try { text = read(file); } catch (e) { return; } }
          if (!text) return;
          text.split(/\r?\n/).forEach(function (line) {
            // ⚠️ 判据是「`集成` 之后**很短一段内**出现数字 + 项」——
            // 不能写成"关键词之后的第一个数字 + 项"：正文里凡是提到"集成"的行
            // （比如「把集成条数 77 → 106 改了一遍…加第 18 项自检」）
            // 都会把那个无关数字当成集成条数（实测被自己的说明文字误报过 3 次）。
            // 6 个字符够覆盖「集成测试（106 项）」这种写法，又够不着下一句的数字。
            // 也不能跨句（`[^。\n]`）—— 计数声明不会跨句。
            // ⚠️ 间隔里**不许出现数字**（`[^。\n\d]`）：否则 `集成 106 项` 会被
            // 拆成"间隔吃掉了 10、数字只匹配到 6"（实测报出「集成 6 项」）。
            var m2 = line.match(/集成[^。\n\d]{0,6}(\d+)\**\s*项/);
            if (!m2) return;
            itestPairHits++;
            var n2 = Number(m2[1]);
            if (n2 !== actualItest) {
              problems.push(file + ' 写的是「集成 ' + n2 + ' 项」，实测是 ' + actualItest + ' 项');
            }
          });
        });
        if (itestPairHits === 0) {
          problems.push('「集成 N 项」这一族一条都没扫到（当前 ' + actualItest + ' 项）—— ' +
            '要么基线写法被整体改写、这条尺已等于不存在，要么数字与「集成」二字被拆到两句说话；' +
            '请把它俩写回同一处且间隔不超过 6 字符（AGENTS §2 #21：会误报的守卫和没有守卫一样害人）');
        }
      }
    } catch (e) {}
  }


  // ---- 自检项数：直接数 check.js **执行段**里的 checkXxx() 调用 ----
  //
  // ⚠️ 判据与上面两条**不同**，这里用「`自检` 紧跟着 `数字 + 项`」的**正向匹配**，
  // 而不是"关键词之后的第一个数字"。因为文档里有
  // 「`npm test  # 自检 + 提示词基准 + 集成测试（106 项）`」这种**没有给自检报数**的行 ——
  // "取第一个数字"会把集成条数误当成自检项数。
  //
  // 为什么只数**执行段**：函数定义（`function checkXxx(`）也长得一样，
  // 而执行段里只有调用、没有定义。
  var selfSrc = read('tools/check.js');
  var execAt = selfSrc.indexOf("console.log('\\nOmitone 工程自检");
  // ⚠️ 字符类里**要带数字**：`checkE2eExprParsable`（第 28 项）这个名字含「2」，
  //    旧口径 `[A-Za-z]*` 走到那里就断在 `(` 之前 —— 于是"31 项自检"数出来是 30，
  //    文档里那句「自检 29 项」与注释里最大的编号 30 长期差一格而没人发现。
  //    口径改成"能数到人写的编号"：**声明覆盖的范围与实际走的分支之间的差，不会自己喊出来**（AGENTS §2 #18）。
  var actualChecks = execAt < 0
    ? 0
    : new Set(selfSrc.slice(execAt).match(/\bcheck[A-Z][A-Za-z0-9]*\(/g) || []).size;
  if (actualChecks > 0) {
    selfCheckChecked = true;
    targets.forEach(function (t) {
      var file = t[0], text = t[1];
      if (text === null) { try { text = read(file); } catch (e) { return; } }
      if (!text) return;
      text.split(/\r?\n/).forEach(function (line) {
        var m = line.match(/自检\s*\**\s*(\d+)\s*\**\s*项/);
        if (!m) return;
        if (Number(m[1]) !== actualChecks) {
          problems.push(file + ' 写的是「自检 ' + m[1] + ' 项」，实际 ' + actualChecks + ' 项');
        }
      });
    });
  } else {
    problems.push('自检项数守卫失效：在 tools/check.js 的执行段里没数到 checkXxx() 调用 —— ' +
      '守卫失效比没有守卫更糟，请同步这段正则');
  }

  // 静态数不出来（含每场景动态断言），所以只能由 e2e 自己交出来。
  // 没跑过 e2e 就跳过 —— 不能因为「文件不存在」就判失败。
  var countsFile = path.join(ROOT, '.workbuddy', 'e2e-counts.json');
  if (fs.existsSync(countsFile)) {
    try {
      var counts = JSON.parse(fs.readFileSync(countsFile, 'utf8'));
      var actualAssertions = Number(counts.assertions);
      if (actualAssertions > 0) {
        assertionsChecked = true;
        targets.forEach(function (t) {
          var file = t[0], text = t[1];
          if (text === null) { try { text = read(file); } catch (e) { return; } }
          if (!text) return;
          // 只看「提到了 e2e / 交叉检验 / 端到端」的行 —— 否则会把「集成 52 项」
          // 「自检 13 项」这些别的数字一起误伤
          text.split(/\r?\n/).forEach(function (line) {
            // ⚠️ 只取**关键词之后的第一个**数字。整行扫所有数字会误伤：
            // HANDOVER 有一行同时含「自检 13 项 / 集成 52 项 / 端到端 190 项」，
            // 整行扫会把 13 和 52 也当成 e2e 项数报错（实测踩过）。
            var km = line.search(/e2e|交叉检验|端到端/i);
            if (km === -1) return;
            // `\**` 同下面那段：数字常被加粗（`e2e **312** 项`），
            // 不写会把正则跳到行里下一个数字去。
            var m2 = line.slice(km).match(/(\d+)\**\s*项/);
            if (!m2) return;
            var n2 = Number(m2[1]);
            if (n2 !== actualAssertions && n2 !== Number(counts.scenarios)) {
              problems.push(file + ' 写的是 ' + n2 + ' 项，e2e 实测是 ' + actualAssertions + ' 项');
            }
          });
        });

        // ---- 「N 场景 / M 项」成对声明：M 等于账本当前项数时，N 必须等于代码里的场景数 ----
        //
        // 为什么要这一条（2026-11-18，批次 111）：上面那段场景尺只认 **带「个」的** `N 个场景`，
        // 而公开面写基线用的是不带「个」的那一族（`136 场景 / 1556 项`）。于是加/删一个场景后
        // **那一族一条都不会红** —— 与批次 105 那族「恒绿的尺」同一形状（声明覆盖的范围与实际
        // 走的分支之间的差，不会自己喊出来，AGENTS §2 #18）。
        //
        // ⚠️ **为什么不干脆把尺放宽成 `N 个?场景`**：实测会一次报出 28 条假红，而假红里大半
        //   根本不是在承诺当前基线 —— `402 场景` 是 HTTP 状态码、`104 场景一个都没跑` 是失败现场、
        //   `5 场景` 是定向筛选跑掉的条数、`批次 74 场景内` 是编号、`136 场景` 后面接的是**当时的**项数。
        //   **会误报的守卫和没有守卫一样害人**（AGENTS §5），所以不放宽。
        //
        // 判据因此只做一件事：**看这句话说的是不是"现在"**。同一处并排写的 `M 项` 等于账本当前读数
        // （1556），才认定这句在承诺现行基线，于是要求 `N` 等于代码场景数。历史句写的是
        // `104 场景 / 1280 项`、`136 场景 / 1529 项`，M 对不上就天然出界 —— 既不用给它们贴
        // 「历史计数」标记，也不用把判据改松（口径同 `tools/audit-switch-budget.js` 的"承诺 vs 引述旧数"）。
        //
        // ⚠️ 反面的一条**卫生检查**：若整套文档里一对「与当前项数并排的场景数」都扫不到，这条尺
        //   等于不存在（措辞被整体改写就会静默脱检，那是最坏的一种绿），必须响。
        var pairRe = /(\d{1,4})\s*个?场景\s*[/／]\s*(\d{1,5})\**\s*项/g;
        var pairHits = 0;
        var pairFiles = {};
        targets.forEach(function (t) {
          var file = t[0], text = t[1];
          if (text === null) { try { text = read(file); } catch (e) { return; } }
          if (!text) return;
          text.split(/\r?\n/).forEach(function (line) {
            pairRe.lastIndex = 0;
            var mp;
            while ((mp = pairRe.exec(line)) !== null) {
              if (Number(mp[2]) !== actualAssertions) continue;   // 引述的是别的日子那份账，不算承诺
              pairHits++;
              pairFiles[file] = (pairFiles[file] || 0) + 1;
              if (Number(mp[1]) !== actualScenes) {
                problems.push(file + ' 写的是「' + mp[0] + '」—— 项数对得上当前账本（' + actualAssertions +
                  '），那同一处的场景数就该是代码里的 ' + actualScenes + '，不是 ' + mp[1]);
              }
            }
          });
        });
        scenePairChecked = true;
        scenePairHits = pairHits;
        if (pairHits === 0) {
          problems.push('「N 场景 / M 项」这一族一条都没扫到（当前项数 ' + actualAssertions +
            '）—— 要么基线写法被整体改写、这条尺已等于不存在，要么场景数与项数被拆到两处说话；' +
            '请把它俩并排写回同一处（AGENTS §4：改了承诺的数字，用户看得见的每一页都要跟着改，而且要有闸）');
        }
      }
    } catch (e) {}
  }

  var sceneNote = '场景数与代码一致: ' + actualScenes + ' 个' +
    (assertionsChecked ? '；断言总数与 e2e 实测一致' : '（断言总数未校验：还没跑过 e2e，跑一次即可）') +
    // ⚠️ 这一格要说清**扫到几对**：一条都没扫到时上面已经报错，但"扫到 1 对"与"扫到 8 对"
    //    是完全不同的覆盖面 —— 数字印出来，下一次改措辞的人才有东西可对照。
    (scenePairChecked ? '；「N 场景 / M 项」并排承诺 ' + scenePairHits + ' 处逐个与代码同数'
                      : '（并排的场景数未校验：还没跑过 e2e 交账）') +
    (itestChecked ? '；集成条数与实测一致（在检 ' + itestPairHits + ' 处）'
                      : '（集成条数未校验：还没跑过 itest，跑一次即可）') +
    (selfCheckChecked ? '；自检项数与实际一致' : '（自检项数未校验：守卫失效）') +
    '（CHANGELOG 只查最新一段，历史记录不查）';

  if (problems.length) fail('测试数字检查未通过:\n      ' + problems.join('\n      '));
  else pass(sceneNote);
}

function checkConfigDefaults() {
  // 运行时注入、不写进默认值对象的键。
  //   pageScope 是 content.js 每次下发的「当前页面属于哪一类场景」
  //   （study / captcha / none），不是用户配置 —— 写进 DEFAULT_CONFIG
  //   反而会被存盘、出现在配置列表里。
  var RUNTIME_INJECTED = { 'page.js': ['pageScope'] };
  var specs = [
    ['page.js', /var DEFAULT_CONFIG = \{/, /\bthis\.configs\.([A-Za-z_][A-Za-z0-9_]*)/g],
    ['content.js', /let configs = \{/, /\bconfigs\.([A-Za-z_][A-Za-z0-9_]*)/g],
    ['popup/popup.js', /const DEFAULTS = \{/, /\bconfig\.([A-Za-z_][A-Za-z0-9_]*)/g]
  ];
  var problems = [];

  specs.forEach(function (spec) {
    var file = spec[0], objRe = spec[1], useRe = spec[2];
    var src = read(file);
    var m = src.match(objRe);
    if (!m) {
      problems.push(file + ' 里找不到默认值对象 —— 守卫读不到目标，请同步这段正则');
      return;
    }
    // 括号配平，取出整个对象字面量
    var i = src.indexOf('{', m.index), depth = 0, end = -1;
    for (var j = i; j < src.length; j++) {
      if (src.charAt(j) === '{') depth++;
      else if (src.charAt(j) === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    var keys = Object.create(null);
    src.slice(i + 1, end).split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t || t.indexOf('//') === 0) return;
      var km = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (km) keys[km[1]] = true;
    });
    var used = Object.create(null), mm;
    useRe.lastIndex = 0;
    while ((mm = useRe.exec(src))) used[mm[1]] = true;
    var missing = Object.keys(used).filter(function (k) {
      return !keys[k] && (RUNTIME_INJECTED[file] || []).indexOf(k) === -1;
    }).sort();
    if (missing.length) {
      problems.push(file + ' 读了但没有默认值的配置项: ' + missing.join(', ') +
        '（读到的永远是 undefined，开关会表现成「打开了也没用」）');
    }
  });

  // ---- B) 界面上的开关必须完整接线 ----
  try {
    var html = read('popup/popup.html');
    var popupJs = read('popup/popup.js');
    var ids = [], mm2, reId = /class="toggle[^"]*"[^>]*id="([^"]+)"/g;
    while ((mm2 = reId.exec(html))) ids.push(mm2[1]);
    if (!ids.length) {
      problems.push('popup/popup.html 里没找到开关 —— 守卫失效，请同步这段正则');
    }
    var PET_LOCAL_TOGGLES = {
      pagePetEnabled: {
        key: 'omitonePagePetMinimal',
        clickNeedle: 'els.pagePetEnabled.addEventListener("click", togglePagePetEnabled)',
        saveNeedle: '{ omitonePagePetMinimal: value ? 0 : 1 }',
        loadNeedle: 'pagePetEnabledVal = !(r && r.omitonePagePetMinimal)'
      },
      petChatEnabled: {
        key: 'omitonePetChatOn',
        clickNeedle: 'els.petChatEnabled.addEventListener("click", togglePetChatEnabled)',
        saveNeedle: '{ omitonePetChatOn: value ? 1 : 0 }',
        loadNeedle: 'petChatEnabledVal = !!(r && r.omitonePetChatOn === 1)'
      },
      // 医生主动提醒：默认**关**（问模型那一发按量计费，不许用户看不见时默认烧钱），
      // 所以「缺席/0/false 都算关」，只有 1/true 算开 —— 与上面两枚都不一样，
      // 这正是每个开关各带一份 needle 的理由。
      // pageNeedle 那一格是这一族最贵的一处（批次 130 实测踩过）：**页面侧读回的基准
      // 必须和弹窗写出去的是同一种写法**。原先写成 `=== false`，而弹窗写的是 `0`，
      // `0 === false` 不成立 → 开关关掉、提醒照旧响，界面和日志都不报错。
      petDoctorEnabled: {
        key: 'omitonePetDoctorOn',
        clickNeedle: 'els.petDoctorEnabled.addEventListener("click", togglePetDoctorEnabled)',
        saveNeedle: '{ omitonePetDoctorOn: value ? 1 : 0 }',
        // 默认改关之后弹窗那一支只认 1/true —— 缺席 = 关，不许再走"算关"的旧尺。
        // ⚠️ 这一格只钉"弹窗那一行长成这样"；**两侧是不是真的同一把尺**由集成层 [27] ⑰
        // 拿五个值（缺席/0/false/1/'0'）分别喂两份读回来的代码比出来，别只靠这里的字面串。
        loadNeedle: 'petDoctorEnabledVal = raw === 1 || raw === true',
        // 批次 183 把这条尺钉的三个字面量搬进了一枚共用助手 `isPetSwitchOn`（同一件事三种来源
        // 只许一种写法，AGENTS §2 #18）。字面串尺跟着改**不许变松**：委派与助手本体两句都要在，
        // 助手哪天被改成 `!!v`（把 0/'0' 也算开）当场红 —— 只认委派那一行就是一次恒绿的尺。
        pageNeedle: [
          'function isDoctorOn(v) { return isPetSwitchOn(v); }',
          'function isPetSwitchOn(v) { return v === 1 || v === true; }'
        ]
      },
      // 联网搜索（批次 183）：付费那一枚，出厂关，且**页面侧那一路（刷课页医生问模型）也要读它**。
      // 缺这一条会怎样：弹窗照旧打勾、开关照旧存盘，而注入页里那一发永远按"没开"拼请求 ——
      // 用户点了开关、钱没多花、话也没搜，一条日志都不留（§2 #12「读不出/没读到」不许塌成"关"）。
      petWebSearchEnabled: {
        key: 'omitonePetWebSearchOn',
        clickNeedle: 'els.petWebSearchEnabled.addEventListener("click", togglePetWebSearchEnabled)',
        saveNeedle: '{ omitonePetWebSearchOn: value ? 1 : 0 }',
        loadNeedle: 'petWebSearchVal = raw === 1 || raw === true',
        pageNeedle: [
          'function isPetSwitchOn(v) { return v === 1 || v === true; }',
          'isPetSwitchOn(r[PAGE_WEB_SEARCH_KEY])'
        ]
      }
    };
    // 白名单的 id 不走下面的 bindToggle 尺（放在 forEach **之前**——先前放后面，flag 完才过滤，等于没豁免）
    ids = ids.filter(function (id) { return !PET_LOCAL_TOGGLES[id]; });
    ids.forEach(function (id) {
      // 用 bindToggle(els.<id>, () => <VAR> …) 里的变量名做纽带
      var reBind = new RegExp('bindToggle\\(els\\.' + id + '\\b[^,]*,\\s*\\(\\)\\s*=>\\s*([A-Za-z_][A-Za-z0-9_]*)');
      var bm = popupJs.match(reBind);
      if (!bm) {
        problems.push('开关 ' + id + ' 没有 bindToggle 绑定 —— 点了不会有反应');
        return;
      }
      var v = bm[1];
      var reLoad = new RegExp('\\b' + v + '\\s*=\\s*[^;]*config\\.([A-Za-z_][A-Za-z0-9_]*)');
      var lm = popupJs.match(reLoad);
      if (!lm) {
        problems.push('开关 ' + id + '（变量 ' + v + '）在 load() 里没有从 config 读回 —— 重新打开弹窗会显示错误的状态');
        return;
      }
      var key = lm[1];
      var reSave = new RegExp('\\n\\s*' + key + '\\s*:\\s*' + v + '\\b');
      if (!reSave.test(popupJs)) {
        problems.push('开关 ' + id + '（配置键 ' + key + '）保存时没有写出去 —— 改了存不住');
      }
    });

    // 吉祥物本地开关不走主配置：存档一族（收起/聊天）全在 storage.local 的独立键上，
    // 与调度零耦合，页面端有独立监听器即时生效。白名单不是免检 —— 换一把尺按「真接线」核对：
    // 点击/键盘两路都挂上、落盘写的就是她自己的键、打开弹窗从她的键读回。
    // ⚠️ 三个 needle 必须**每个开关各带一份**，不许共用 pagePetEnabled 的形状 ——
    // 两枚开关语义相反：收起是「存 1 = 关」（pagePetEnabled），聊天是「存 1 = 开」（petChatEnabled，
    // 付费功能出厂关）。照抄同一把尺会把第二枚的接线判死；每份 needle 按 popup.js 的现形写死，
    // 少任何一条当场红。开关从 HTML 里摘掉时 ids 里不再出现，这些条照旧对 popup.js 核 ——
    // 界面没了代码还在，同样算失配。
    Object.keys(PET_LOCAL_TOGGLES).forEach(function (id) {
      var t = PET_LOCAL_TOGGLES[id];
      if (popupJs.indexOf(t.clickNeedle) < 0 ||
          popupJs.indexOf('els.' + id + '.addEventListener("keydown"') < 0) {
        problems.push('开关 ' + id + ' 没有接上点击/键盘两路 —— 点了不会有反应');
      }
      if (popupJs.indexOf(t.saveNeedle) < 0) {
        problems.push('开关 ' + id + ' 落盘没有写她自己的键 ' + t.key + ' —— 改了存不住');
      }
      if (popupJs.indexOf(t.key + '", (r)') < 0 ||
          popupJs.indexOf(t.loadNeedle) < 0) {
        problems.push('开关 ' + id + ' 打开弹窗没有从 ' + t.key + ' 读回 —— 重开会显示错的状态');
      }
      // pageNeedle：这一枚的存档**页面侧也要读**（弹窗与学习页两份代码各自算一次开关）。
      // 只核弹窗两路 = 半边覆盖：弹窗写 0/1、页面比 === false，界面照常打勾、日志照常响，
      // 一条测试都不红（批次 130 实测）。判据只认「读回的基准写死在这一串里」，
      // 页面源码取不到就当失败 —— 宁可红，不要一声不响地跳过这一格。
      if (t.pageNeedle) {
        var contentJs = '';
        try { contentJs = read('content.js'); } catch (eRead) { contentJs = ''; }
        // 数组 = 这一枚的页面侧写法由**几句共同**成立（委派 + 助手本体那种）；少任何一句都点名，
        // 不许"其中一句在就算过"—— 只认委派那一句，助手被改成 `!!v` 时这把尺恒绿。
        var pnList = Array.isArray(t.pageNeedle) ? t.pageNeedle : [t.pageNeedle];
        if (!contentJs) {
          problems.push('开关 ' + id + ' 声明了页面侧判据，但 content.js 读不到 —— 这一格没验到');
        } else if (contentJs.indexOf(t.key) < 0) {
          problems.push('开关 ' + id + ' 页面侧根本没读 ' + t.key + ' —— 关掉了她照样提醒');
        } else {
          var pnMiss = pnList.filter(function (one) { return contentJs.indexOf(one) < 0; });
          if (pnMiss.length) {
            problems.push('开关 ' + id + ' 页面侧读回的基准和弹窗写出去的不是一套（content.js 里缺 ' +
              pnMiss.length + '/' + pnList.length + ' 句：' + pnMiss.join(' ;; ') + '）—— 关掉开关可能没反应');
          }
        }
      }
    });
  } catch (e) {
    problems.push('开关接线检查自身出错: ' + e.message);
  }

  // ---- C) 界面能存的键，后台策略必须认 ----
  // 同学机器现场（2026-11-12）：弹窗每次都带上 `slowMachineMode:"auto"`，
  // 而 libs/runtime-policy.js 没登记这个键 → `validatePatch` 拒掉**整张补丁** →
  // 症状不是"这一个开关坏了"，而是**任何设置都存不住**（一次保存里的其它改动一起被吞）。
  // B) 管的是"界面 ↔ popup.js 接线"，接得上却登记漏了照样全废 —— 所以这一条独立存在。
  try {
    var POLICY = require(path.join(ROOT, 'libs', 'runtime-policy.js'));
    var popupSrc = read('popup/popup.js');
    var popupDefaults = literalMap(popupSrc, /const DEFAULTS = \{/);
    if (!Object.keys(popupDefaults).length) {
      problems.push('popup/popup.js 里没读到 DEFAULTS —— 守卫失效，请同步这段正则');
    }
    var rejected = [];
    Object.keys(popupDefaults).forEach(function (key) {
      // 默认值本身必须能存（DEFAULTS 是"恢复默认"整张写回去的内容）
      var v = sampleLiteral(popupDefaults[key]);
      var bad = null;
      if (v === undefined) {
        bad = '取不到样本值「' + popupDefaults[key] + '」，守卫无法判定 —— 请把它写成字面量';
      } else if (!POLICY.validatePatch(mkPatch(key, v), 'popup').success) {
        bad = '策略不认这个键/值（存下去会被整张补丁拒绝）';
      }
      // 再看这个键在界面上**实际会发出去**的其它字面量（三元分支等）——
      // 只认引号串和纯数字，长表达式一律跳过，避免把 .slice(0, 300) 里的 300 当成值。
      if (!bad) {
        var reLine = new RegExp('^[ \\t]*' + key + '[ \\t]*:[ \\t]*(.*)$', 'gm');
        var lm3, seen = Object.create(null);
        while ((lm3 = reLine.exec(popupSrc))) {
          var expr = lm3[1];
          if (expr.length > 120) continue;
          var cands = [];
          var pure = expr.replace(/,$/, '').trim();
          if (/^-?[\d.]+$/.test(pure)) cands.push(Number(pure));
          // 只在"界面自己会在几个字面量里挑一个"（三元）时收集分支值 ——
          // 否则 els 表里 `apiUrl: document.getElementById("apiUrl")` 这种行，
          // 会把**元素 id**当成要保存的值来验，报出一屏假红。
          else if (expr.indexOf('?') !== -1 && expr.indexOf('getElementById') === -1) {
            var qm, reQ = /"([^"]*)"|'([^']*)'/g;
            while ((qm = reQ.exec(expr))) cands.push(qm[1] !== undefined ? qm[1] : qm[2]);
          }
          cands.forEach(function (c) {
            var sig = typeof c + ':' + c;
            if (seen[sig]) return;
            seen[sig] = true;
            if (!POLICY.validatePatch(mkPatch(key, c), 'popup').success) {
              bad = '界面会发出的值 ' + JSON.stringify(c) + ' 被策略拒掉（存下去会连带整张补丁一起失败）';
            }
          });
          if (bad) break;
        }
      }
      if (bad) rejected.push(key + '（' + bad + '）');
    });
    if (rejected.length) {
      problems.push('界面存得出去、但策略不认的配置项: ' + rejected.join(', ') +
        '\n      —— 一个没登记在 libs/runtime-policy.js 里的键，会让**所有**设置一起存不住' +
        '（用户看到的是"点哪个开关都保存失败"），不是只有它自己坏');
    }

    // ---- D) 界面存得下、页面却要读的键，必须真的投影给页面 ----
    // C 通过只说明"存得住"。存住之后还要能被 `publicConfig(config,'study')` 带到页面，
    // 否则页面读到的永远是它自己那份默认值 —— 开关一样"打开了也没用"。
    // （实测：slowMachineMode 存得住之后仍然不生效，就是因为没进 runtimeFields。）
    // ⚠️ 页面读配置不全走 `this.configs.X`：慢机开关是在 perfFactor() 里
    // `var cfg = window._xxtApp && window._xxtApp.configs; cfg.slowMachineMode` 读的。
    // 只按 `this.configs.` 找会漏掉这一族（反向验证实测：注入"没进 runtimeFields"照样绿）。
    // 所以别名从源码现推：`var <名字> = ….configs;` 这种收尾才算数，
    // 免得把 `var max = configs.visionMax…` 这类**取值**的变量名误当成别名。
    var pageSrc = read('page.js');
    var readNames = ['configs'];
    var am, aliasRe = /\b(?:var|let|const)\s+([\w$]+)\s*=\s*[^;]*?\.configs\s*;/g;
    while ((am = aliasRe.exec(pageSrc))) {
      if (readNames.indexOf(am[1]) === -1) readNames.push(am[1]);
    }
    var notProjected = Object.keys(popupDefaults).filter(function (key) {
      return new RegExp('\\b(?:' + readNames.map(function (n) {
        return n.replace(/[$]/g, '\\$&');
      }).join('|') + ')\\.' + key + '\\b').test(pageSrc) &&
        !Object.prototype.hasOwnProperty.call(
          POLICY.publicConfig(mkConfigSample(popupDefaults), 'study'), key);
    }).sort();
    if (notProjected.length) {
      problems.push('页面会读、但 publicConfig(study) 不投影的配置项: ' + notProjected.join(', ') +
        '\n      —— 存进去了却送不到页面，开关表现成「打开了也没用」；' +
        '要它生效就加进 runtime-policy.js 的 runtimeFields（能到页面 = 页面脚本看得见，' +
        '带密钥或服务商原话的字段绝对不要投影）');
    }
  } catch (e) {
    problems.push('配置策略守卫自身出错: ' + e.message);
  }

  if (problems.length) fail('配置接线检查未通过:\n      ' + problems.join('\n      '));
  else pass('配置接线完整（默认值齐全 · 界面开关的绑定/读取/保存三件齐全 · 策略认键且投影到页面）');
}

// 取出源码里某个对象字面量的「键 → 冒号后面那段原文（第一行）」，只认顶层键。
// 用于 C/D：这里要的是"界面会存出去什么"，不是运行时求值。
function literalMap(src, anchorRe) {
  var m = src.match(anchorRe);
  var result = Object.create(null);
  if (!m) return result;
  var i = src.indexOf('{', m.index), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src.charAt(j) === '{') depth++;
    else if (src.charAt(j) === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return result;
  src.slice(i + 1, end).split(/\r?\n/).forEach(function (line) {
    var t = line.trim();
    if (!t || t.indexOf('//') === 0) return;
    var km = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    if (km) result[km[1]] = km[2];
  });
  return result;
}

// 把字面量文本转成 JS 值。认不出的一律返回 undefined（守卫会点名"取不到样本"，
// 不会静默放过 —— 静默跳过的守卫等于没有守卫）。
function sampleLiteral(text) {
  var t = String(text || '').replace(/,$/, '').trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?[\d.]+$/.test(t)) return Number(t);
  var q = t.match(/^"([^"]*)"$/) || t.match(/^'([^']*)'$/);
  if (q) return q[1];
  return undefined;
}

function mkPatch(key, value) {
  var patch = {};
  patch[key] = value;
  return patch;
}

// publicConfig 的输入：整份界面默认值 + 一个非空 apiKey（hasApiKey 需要它才为 true）。
function mkConfigSample(defaults) {
  var cfg = {};
  Object.keys(defaults).forEach(function (key) {
    var v = sampleLiteral(defaults[key]);
    if (v !== undefined) cfg[key] = v;
  });
  cfg.apiKey = 'sample-key';
  return cfg;
}

function checkDeadFiles(jsFiles, manifest) {
  var loaded = [];
  if (manifest) {
    (manifest.content_scripts || []).forEach(function (e) {
      (e.js || []).forEach(function (f) { loaded.push(f); });
    });
    if (manifest.background && manifest.background.service_worker) {
      loaded = loaded.concat(collectWorkerScripts(manifest.background.service_worker).files);
    }
    (manifest.web_accessible_resources || []).forEach(function (entry) {
      (entry.resources || []).forEach(function (f) {
        if (/\.js$/.test(f)) loaded.push(f);
      });
    });
  }
  collectHtmlScriptRefs().forEach(function (f) { loaded.push(f); });

  var dead = jsFiles.filter(function (file) {
    if (file.indexOf('tools/') === 0) return false;
    if (file.indexOf('legacy/') === 0) return false;
    return loaded.indexOf(file) === -1;
  });

  if (dead.length) {
    warn('以下 JS 文件未通过任何途径加载，确认是否为死代码: ' + dead.join(', '));
  } else {
    pass('无游离 JS 文件（tools/ 与 legacy/ 为开发期目录，不计入）');
  }
}

// ---------------------------------------------------------------------------
// 7. 编码损坏探测（告警级）
//
// 这个项目出现过把 UTF-8 字节按 GBK 解码后写回源码的事故，
// 例如 `选项` 变成 `閫夐」`，导致正则永远匹配不上、功能静默失效。
// 这类字符肉眼极易漏看，所以单独扫一遍。
//
// 判定方式：在非注释行里找"几乎只出现在乱码里"的字符。
// 只报警告不报错 —— 引文里出现生僻字是可能的，需要人来判断。
// 注释行被排除，因为解释这类事故的注释本身就要写出乱码字符。
// ---------------------------------------------------------------------------
var MOJIBAKE_CHARS = '閫夐鐨勬槸涓浜嗗湪鏈夎繖涔堝彲浠ヤ负鎴戜綘浠栧ス锛鐢鐩鍙鍚鍜鍦璁粯搴鐜潵鍒鏂鏃閿欏鐣珮';

function isCommentLine(line) {
  var t = line.trim();
  return t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0;
}

function checkEncodingDamage(jsFiles) {
  var hits = [];
  jsFiles.forEach(function (file) {
    if (file.indexOf('tools/') === 0) return; // 工具脚本自己会写出这些字符做说明
    var lines = read(file).split('\n');
    lines.forEach(function (line, i) {
      if (isCommentLine(line)) return;
      for (var k = 0; k < MOJIBAKE_CHARS.length; k++) {
        if (line.indexOf(MOJIBAKE_CHARS[k]) !== -1) {
          hits.push(rel(path.join(ROOT, file)) + ':' + (i + 1) + ' 含可疑乱码字符 "' + MOJIBAKE_CHARS[k] + '"');
          return;
        }
      }
    });
  });

  if (hits.length) {
    warn('疑似 GBK 乱码残留（请人工确认，注释行已排除）:\n      ' + hits.join('\n      '));
  } else {
    pass('无编码损坏迹象');
  }
}

// ---------------------------------------------------------------------------
// 7. 未定义方法调用（幽灵调用）
//
// 这个项目真实发生过：早前一轮"清理调试代码"删掉了 `_diagnoseBlockedPage`，
// 但**调用点没删**，于是 `_checkCaptchaDialog()` 在没有验证码时每次都会抛
// TypeError。4 处调用点里只有 1 处包了 try/catch，另外 3 处直接把链路打断，
// 表现为"验证码功能整体失灵"。
//
// 这里做一次粗粒度但有效的静态检查：把所有 `this._x(` / `app._x(` / `self._x(`
// 的调用名收集起来，和文件里定义的方法名对一遍，缺的就报出来。
// 只查 `_` 开头的方法 —— 它们占绝大多数，且不会和 DOM/库函数混淆，误报极低。
// ---------------------------------------------------------------------------
/**
 * 去掉注释后再做标识符扫描。
 *
 * 必要：注释里天然会提到方法名（比如"这里原本调用 _foo()"），
 * 不剥注释就会把这些说明当成真实调用，产生误报。
 * 行注释那一步要求 `//` 前面不是冒号，避免把 `https://…` 截断。
 */
function stripComments(source) {
  var out = String(source).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
  return out.replace(/(^|[^:])\/\/[^\n]*/g, function (m, prefix) {
    return prefix + new Array(m.length - prefix.length + 1).join(' ');
  });
}

function checkUndefinedMethods(jsFiles) {
  var targets = ['page.js', 'content.js'];
  var problemsPerFile = [];

  targets.forEach(function (file) {
    if (jsFiles.indexOf(file) === -1) return;
    var source = stripComments(read(file));

    // 定义：形如 `    _name: function (…)` / `    _name: async function`
    var defined = Object.create(null);
    var defRe = /^\s{2,}(_?[A-Za-z$][\w$]*)\s*:\s*(?:async\s+)?function/gm;
    var m;
    while ((m = defRe.exec(source))) defined[m[1]] = true;

    // 调用：this._x( / app._x( / self._x( / window._xxtApp._x(
    var called = Object.create(null);
    var callRe = /(?:this|app|self|window\._xxtApp)\.(_[A-Za-z$][\w$]*)\s*\(/g;
    while ((m = callRe.exec(source))) {
      if (!called[m[1]]) called[m[1]] = 0;
      called[m[1]]++;
    }

    var missing = Object.keys(called).filter(function (name) {
      return !defined[name] && !defined[name.slice(1)]; // 也接受不带下划线的同名定义
    });
    if (missing.length) {
      problemsPerFile.push(file + ' 调用了未定义的方法: ' +
        missing.map(function (n) { return n + '() ×' + called[n]; }).join(', '));
    }
  });

  if (problemsPerFile.length) fail(problemsPerFile.join('\n      '));
  else pass('无未定义方法调用（幽灵调用检查）');
}

// ---------------------------------------------------------------------------
// 8. 死方法探测（告警级）
//
// 定义在 page.js / content.js 里、但全项目找不到任何 `._name(` 调用的方法。
// 只查 `_` 开头的方法：它们是内部的、不会被外部协议按名字调用。
//
// 为什么只报警告不报错：page.js 里确实存在"由事件/消息按名字触发"的入口
// （如 window.xxtAI 暴露的几个），以及少量保留给排错用的方法。
// 但绝大多数命中项都是真正的历史遗留，值得清掉。
// ---------------------------------------------------------------------------
function checkDeadMethods(jsFiles) {
  var targets = ['page.js', 'content.js'];
  // 这些是按名字被外部调用的入口/钩子，不算死代码
  var ALLOW = {
    _extractQuestions: true, _handleQuiz: true, _runTick: true, _tick: true,
    _checkVideoStatus: true, _backgroundCaptchaTick: true, _runDiscussionMode: true,
    _runStandaloneCaptchaMode: true, _handleVideoEnded: true, _handleVideoLoaded: true,
    _handleVideoPlay: true, _handleVideoPause: true, _handleVideoRateChange: true,
    _handleMediaError: true, _handleSubmitConfirmDialog: true, _handlePopupQuiz: true,
    _handleDocumentTask: true, _runPptAudioJob: true, _runChaoxingReadJob: true,
    _playChaoxingMediaJob: true, _runChaoxingJob: true, _runOcsStyleStudy: true,
    _ensureOcsStudyRunner: true, _searchChaoxingJob: true, _searchChaoxingJobOcs: true,
    _searchIFramesOcs: true, _collectVisibleTaskFrames: true, _classifyTaskFrame: true
  };

  var all = jsFiles
    .filter(function (f) { return f.indexOf('tools/') !== 0 && f.indexOf('legacy/') !== 0; })
    .map(function (f) { return stripComments(read(f)); })
    .join('\n');

  var unused = [];
  targets.forEach(function (file) {
    if (jsFiles.indexOf(file) === -1) return;
    var source = stripComments(read(file));
    var defRe = /^\s{2,}(_[A-Za-z$][\w$]*)\s*:\s*(?:async\s+)?function/gm;
    var seen = Object.create(null);
    var m;
    while ((m = defRe.exec(source))) {
      var name = m[1];
      if (seen[name] || ALLOW[name]) continue;
      seen[name] = true;
      // 统计"被调用"的次数（定义那一行不含 `._name(`，所以计数为 0 即无人调用）
      var calls = all.split('.' + name + '(').length - 1;
      if (calls === 0) unused.push(file + ':' + name);
    }
  });

  if (unused.length) {
    warn('以下方法全项目无人调用，确认是否为历史遗留:\n      ' + unused.join('\n      '));
  } else {
    pass('无死方法（无人调用的下划线方法）');
  }
}

// ---------------------------------------------------------------------------
// 14. page.js 与 src/page/ 片段一致 + content.js 的桥戳
//
// 根目录的 `page.js` 现在是**构建产物** —— 由 tools/concat-page.js 从
// src/page/*.js 拼出来，而扩展真正加载的正是根目录那一份（content.js 注入它、
// manifest 的 web_accessible_resources 列它）。
//
// 于是多出一种静默失效：直接改了根目录的 page.js、却没改片段 ——
// **跑起来是对的**（浏览器加载的就是改过的那份），但下一次拼接就把改动全丢掉，
// 而且丢得毫无声响。所以这里把它守住。
// ---------------------------------------------------------------------------
function checkPageConcat() {
  var concat = require('./concat-page.js');
  var built;
  try {
    built = concat.buildPageText();
  } catch (error) {
    fail('page.js 拼接检查自身出错: ' + (error && error.message ? error.message : error));
    return;
  }

  var expected = Buffer.from(built.text, 'utf8');
  var actual = fs.existsSync(concat.OUT_FILE) ? fs.readFileSync(concat.OUT_FILE) : null;
  if (!actual) {
    fail('根目录没有 page.js —— 扩展加载的就是它，跑 `npm run concat` 生成');
    return;
  }
  if (actual.equals(expected)) {
    pass('page.js 与 src/page/ 一致（' + built.files.length + ' 个片段，' + expected.length + ' 字节）');
    checkBridgeStamp(concat);
    return;
  }
  fail(
    'page.js 与 src/page/ 不一致（当前 ' + actual.length + ' 字节，按片段拼出来应是 ' + expected.length + ' 字节）\n' +
    '      扩展加载的是根目录那份，所以现在跑的东西和源码对不上。\n' +
    '      改的是片段 → 跑 `npm run concat`；改的是根目录 page.js → 那份会被下次拼接覆盖，请改到片段里。'
  );
}

// ---------------------------------------------------------------------------
/**
 * 第 14 项的第二半：`content.js` 首行的桥戳对不对得上「manifest 说这一枚注入要跑的那些字节」。
 *
 * 尺**从 tools/concat-page.js 要回来**（`buildBridgeStamp`），这里不另写一份 ——
 * 两份口径写在一起才有意义：拼接写的是 A、校验算的是 B，这道闸就只是稳定地报假话。
 *
 * ⚠️ 「首行不是戳行」单独占一格并报**读不出**（AGENTS §2 #12/#18）：
 * 把它并进「不一致」会让人去跑 concat（以为能修好），而真原因可能是戳行被并发写坏了。
 */
function checkBridgeStamp(concat) {
  var stamp;
  try {
    stamp = concat.buildBridgeStamp();
  } catch (error) {
    fail('桥戳检查自身出错（清单来源在 manifest）: ' + (error && error.message ? error.message : error));
    return;
  }
  if (!fs.existsSync(concat.CONTENT_FILE)) {
    fail('没有 content.js —— 桥戳没处比，这一格读不出');
    return;
  }
  var raw = fs.readFileSync(concat.CONTENT_FILE, 'utf8');
  var m = raw.match(concat.BRIDGE_STAMP_RE);
  if (!m) {
    fail('content.js 首行读不出桥戳（应形如 var OMITONE_CODE_REV_BRIDGE = \'…\';）—— 不许当成「没戳也算一致」');
    return;
  }
  if (m[1] !== stamp.rev) {
    fail('content.js 首行的桥戳过期（首行 ' + m[1] + '，按 manifest 的 ' + stamp.files.length +
      ' 个注入文件重算是 ' + stamp.rev + '）\n      注入的桥不随重载扩展而换：跑 `npm run concat` 再 F5 学习页。');
    return;
  }
  pass('content.js 桥戳与注入清单一致（' + stamp.rev + '，' + stamp.files.length + ' 个文件）');
}

// ---------------------------------------------------------------------------
// 15. 片段头部与实际内容一致（序号 + 方法清单）
//
// 拆分之后，"哪个域在哪个文件"完全靠每个片段头部那段注释传达 —— 它是模块地图的底稿。
// 头部长了、短了、方法搬走了却没改头部，读的人就会照着错的地图找代码，
// 那比没有地图更糟（没有地图时他会去 grep，有错地图时他会信）。
// 所以把头部当断言守住。
// ---------------------------------------------------------------------------
/**
 * 从片段头部读出某一份清单（方法 / 状态字段）。
 *
 * 两种排布都要认：
 *   `本段的方法（4 个）：`      → 清单在**下面几行**（` * 名字、名字、…`）
 *   `本段的状态字段（120 个）：a、b、c` → 清单在**同一行**
 *
 * 返回 `{ names, count }`；`count` 为 null 表示头部没有这份清单。
 */
function readHeaderList(header, label) {
  var names = [];
  var count = null;
  var collecting = false;
  var re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '（(\\d+) 个）：(.*)$');

  header.forEach(function (l) {
    if (l.indexOf(label) !== -1) {
      var m = l.match(re);
      if (m) {
        count = Number(m[1]);
        if (m[2].trim()) {
          // 同一行就带清单（状态字段是这种）
          m[2].split('、').forEach(function (s) { s = s.trim(); if (s) names.push(s); });
          collecting = false;
        } else {
          collecting = true;   // 清单在下面几行（方法是这种）
        }
        return;
      }
      collecting = true;
      return;
    }
    if (!collecting) return;
    if (/^\s\* =+/.test(l)) { collecting = false; return; }
    var mm = l.match(/^\s\*\s+(.*)$/);
    if (mm) mm[1].split('、').forEach(function (s) { s = s.trim(); if (s) names.push(s); });
  });

  return { names: names, count: count };
}

/** 比对一份头部清单与文件里的实际情况，把差异写进 issues */
function compareList(issues, file, kind, declared, actual) {
  if (!declared.length && !actual.length) return;
  if (new Set(declared).size !== declared.length) {
    issues.push(file + ' 头部' + kind + '清单里有重复项');
  }
  var declaredSet = new Set(declared);
  var actualSet = new Set(actual);
  var missing = actual.filter(function (n) { return !declaredSet.has(n); });
  var ghost = declared.filter(function (n) { return !actualSet.has(n); });
  if (missing.length) {
    issues.push(file + ' 头部漏了 ' + missing.length + ' 个' + kind + '：' +
      missing.slice(0, 6).join('、') + (missing.length > 6 ? ' …' : ''));
  }
  if (ghost.length) {
    issues.push(file + ' 头部写了 ' + ghost.length + ' 个本文件不存在的' + kind + '：' +
      ghost.slice(0, 6).join('、') + (ghost.length > 6 ? ' …' : ''));
  }
}

function checkPagePartHeaders() {
  var partsDir = path.join(ROOT, 'src', 'page');
  var files = fs.readdirSync(partsDir).filter(function (f) { return /\.js$/.test(f); }).sort();
  var issues = [];

  files.forEach(function (file, index) {
    var lines = fs.readFileSync(path.join(partsDir, file), 'utf8').split(/\r?\n/);
    var markerAt = lines.indexOf('// @omitone-part-header-end');
    if (markerAt === -1) { issues.push(file + ' 缺头部结束标记'); return; }
    var header = lines.slice(0, markerAt);

    // ① 序号行：NN 必须等于文件排序位置，MM 必须是最后一位
    var seqLine = null;
    header.forEach(function (l) { if (/片段\s+\d\d\/\d\d/.test(l)) seqLine = l; });
    if (!seqLine) {
      issues.push(file + ' 头部没有「片段 NN/MM」序号行');
    } else {
      var seq = seqLine.match(/片段\s+(\d\d)\/(\d\d)/);
      var wantSelf = String(index).padStart(2, '0');
      var wantTotal = String(files.length - 1).padStart(2, '0');
      if (seq[1] !== wantSelf) issues.push(file + ' 头部序号是 ' + seq[1] + '，按文件名排序应是 ' + wantSelf);
      if (seq[2] !== wantTotal) issues.push(file + ' 头部分母是 ' + seq[2] + '，片段总数应是 ' + wantTotal);
    }

    // ② 头部清单。头部有两种清单，都要核：
    //    `本段的方法（N 个）：`  —— 方法名，清单在**下面几行**
    //    `本段的状态字段（N 个）：` —— 字段名，清单在**同一行**
    //    （第二种原先没人核，于是 1.2.3 加了 `_quizRunPaperKey` 却没同步头部，
    //      头部数字静静地从 119 停在 118 —— 又一次"错地图"。）
    var methods = readHeaderList(header, '本段的方法');
    var fields = readHeaderList(header, '本段的状态字段');

    // ③ 文件里真实的 app 成员。
    //    注意别把 window.xxtAI 上那 8 个也算进来 —— 它们在 app 对象闭合之后，
    //    是给用户手动调的入口，不是 app 的成员。
    var body = lines.slice(markerAt + 1);
    var inApp = !/^\s*\};/.test(body[0] || '');   // 以 `};` 开头的那个片段，开头还在 app 内
    var actualMethods = [];
    var actualFields = [];
    body.forEach(function (l) {
      if (/^  var app = \{/.test(l)) { inApp = true; return; }
      if (/^  \};/.test(l)) { inApp = false; return; }
      if (!inApp) return;
      var m = l.match(/^ {4}([A-Za-z_$][\w$]*)\s*:\s*(.*)$/);
      if (!m) return;
      if (/^(?:async\s+)?function\b/.test(m[2].trim())) actualMethods.push(m[1]);
      else actualFields.push(m[1]);
    });

    // ⚠️ 只有头部**真的列了**这份清单才去核。
    //    否则 `00-shell-constants.js` 会误报：它的 `DEFAULT_CONFIG` 里有一堆 4 空格缩进的
    //    `playbackRate: 1,` 之类的配置项，会被当成 app 的状态字段（实测误报 50 个）。
    if (methods.count !== null) {
      if (methods.count !== actualMethods.length) {
        issues.push(file + ' 头部说方法有 ' + methods.count + ' 个，实际 ' + actualMethods.length + ' 个');
      }
      compareList(issues, file, '方法', methods.names, actualMethods);
    }
    if (fields.count !== null) {
      if (fields.count !== actualFields.length) {
        issues.push(file + ' 头部说状态字段有 ' + fields.count + ' 个，实际 ' + actualFields.length + ' 个');
      }
      compareList(issues, file, '状态字段', fields.names, actualFields);
    }
  });

  if (issues.length) {
    fail('片段头部与实际内容不一致（改完片段记得同步头部）:\n      ' + issues.join('\n      '));
    return;
  }
  pass('片段头部与实际一致（' + files.length + ' 个片段：序号 + 方法清单 + 状态字段清单）');
}

// ---------------------------------------------------------------------------
// 16. await 必须可超时（`AGENTS.md` §2 第 2 条）
//
// 为什么单独立一条守卫：**"永久挂起"不是异常，try/catch 拦不住它，只有超时能。**
// 而 `_runTick` 是一条 await 链 —— 其中任何一处永远不 resolve，整个调度就停摆
// （验证码检测、播放巡检、任务点推进全停），且页面一条异常都不会有，极难定位。
//
// 只盯**已知会挂起的原生调用**（网络 / 读响应体 / 媒体 play），并要求同一行出现
// `_withTimeout(`。不写"名字里带 play/load 就算"那种宽泛规则 —— 实测会把
// `_detectMaxPlaybackRate()`（内部各发都自带超时或有限轮询）误报，误报多了守卫就没人信了。
// ---------------------------------------------------------------------------
function checkAwaitTimeouts() {
  var partsDir = path.join(ROOT, 'src', 'page');
  var HANG_PRONE = [
    { re: /\bfetch\s*\(/, what: 'fetch' },
    { re: /\.\s*(?:text|json|arrayBuffer|blob|formData)\s*\(\s*\)/, what: '读响应体' },
    { re: /\.\s*(?:play|pause)\s*\(\s*\)/, what: '媒体 play/pause' }
  ];
  var GUARD = /_withTimeout\s*\(/;
  var issues = [];
  var guarded = 0;

  fs.readdirSync(partsDir).filter(function (f) { return /\.js$/.test(f); }).sort()
    .forEach(function (file) {
      fs.readFileSync(path.join(partsDir, file), 'utf8').split(/\r?\n/).forEach(function (line, i) {
        if (!/\bawait\b/.test(line)) return;
        if (line.trim().indexOf('//') === 0) return;
        var hit = HANG_PRONE.filter(function (h) { return h.re.test(line); });
        if (!hit.length) return;
        if (GUARD.test(line)) { guarded++; return; }
        issues.push(file + ':' + (i + 1) + '  ' + hit.map(function (h) { return h.what; }).join('+') +
          ' 没超时 → ' + line.trim().slice(0, 90));
      });
    });

  if (issues.length) {
    fail('有 await 没有超时护栏（永久挂起会让 _runTick 停摆，且不抛异常）:\n      ' +
      issues.join('\n      ') + '\n      包一层 this._withTimeout(promise, ms) 即可');
    return;
  }
  pass('await 都有超时护栏（' + guarded + ' 处已知会挂起的原生调用全部包了 _withTimeout）');
}

// ---------------------------------------------------------------------------
// 17. 选择器类名大小写一致
//
// **CSS 类名大小写敏感**，所以 `.Cy_TITle` 和 `.Cy_TItle` 是两个完全不同的类 ——
// 写错一个字母的那个 selector **匹配不到任何元素，而且不报错、不留日志**。
//
// 实测踩过：`_describeQuizResultPage`（`30-log.js`）里手抄的一份容器选择器写成 `.Cy_TITle`
// （真源 `_questionSelectors` 里是 `.Cy_TItle`）。后果是那条「quiz submit wait timeout」
// 日志里的 `containers` 少算、在只用 `.Cy_TITle` 的作业/考试页上直接报 0 ——
// 而那条日志**唯一的作用**就是告诉人"没认出结果页时缺的是哪一道条件"。
// **诊断工具骗人比没有诊断更糟**：看日志的人会以为页面上没有题目容器，往错的方向查。
//
// （注：同一个文件里 `xxtAI.diagnose()` 的 `containers` 走的是 `_collectQuestionContainers()`
//  → `_questionSelectors` 真源，**没被这个笔误影响**。两个诊断各算各的，手抄的那份漂移了。）
//
// 判据：把代码里出现过的类名按小写分组，同组出现**多种拼写**即报错。
//
// ⚠️ 两条必须的收窄，否则全是误报（都实测过）：
//   1. **只看普通的 `.Foo` 选择器**，不看 `[class*="Foo"]` 这种子串匹配 ——
//      第三方 UI 库类名大小写不确定时，本仓库的既定写法是 `[class*="player"], [class*="Player"]`
//      两套都列上（`40-media.js` 的 player / speed、`50-captcha.js` 的 dialog 都是）。
//      那些是**故意的**，不是笔误。
//   2. 同组拼写若**出现在同一行**（即同一个选择器列表里两套都列了，是并集），也不算冲突 ——
//      `60-tasks-detect.js` 的 `.icon_Completed, .icon_completed` 就是这种。
//
// 这样收窄之后，只有"两个地方各写了一个大小写不同的普通类名"才会报 ——
// 而那正是 `.Cy_TITle` 那个真 bug 的形态。
// ---------------------------------------------------------------------------
function checkSelectorCase() {
  var partsDir = path.join(ROOT, 'src', 'page');

  var groups = Object.create(null);        // 小写键 -> { 拼写 -> { 位置, 行内容 } }
  var linesBySpelling = Object.create(null);

  fs.readdirSync(partsDir).filter(function (f) { return /\.js$/.test(f); }).sort()
    .forEach(function (file) {
      fs.readFileSync(path.join(partsDir, file), 'utf8').split(/\r?\n/).forEach(function (line, i) {
        if (!/querySelector|querySelectorAll|\bclosest\b|\bmatches\b|classList/.test(line)) return;
        var m;
        var reDot = /\.([A-Za-z_][\w-]*)/g;
        while ((m = reDot.exec(line))) {
          var name = m[1];
          if (name.length < 4) continue;                 // 太短的（.on / .li）噪声太大
          var key = name.toLowerCase();
          if (!groups[key]) groups[key] = Object.create(null);
          if (!groups[key][name]) groups[key][name] = file + ':' + (i + 1);
          if (!linesBySpelling[name]) linesBySpelling[name] = [];
          linesBySpelling[name].push(line);
        }
      });
    });

  var issues = [];
  Object.keys(groups).sort().forEach(function (key) {
    var variants = Object.keys(groups[key]);
    if (variants.length < 2) return;
    // 收窄 2：若存在某一行同时含全部拼写 → 是"两套都列上"的并集写法，放行
    var unionHedge = variants.some(function (v) {
      return linesBySpelling[v].some(function (line) {
        return variants.every(function (w) { return line.indexOf('.' + w) !== -1; });
      });
    });
    if (unionHedge) return;
    issues.push(key + ' 出现了 ' + variants.length + ' 种拼写：' +
      variants.map(function (v) { return v + '（' + groups[key][v] + '）'; }).join('  /  '));
  });

  if (issues.length) {
    fail('选择器类名只差大小写（CSS 大小写敏感，错的那个匹配不到任何元素且不报错）:\n      ' +
      issues.join('\n      ') +
      '\n      对着真实页面确认哪个对，然后统一；确实是"两套都存在"就写成 ' +
      '`.A, .B` 并排（那样会被判为并集写法而放行）');
    return;
  }
  pass('选择器类名大小写一致（' + Object.keys(groups).length + ' 个类名，无同小写多拼写）');
}

// ---------------------------------------------------------------------------
// 18. 题目选择器真源守卫
//
// 学习通的题目结构知识（容器/题干/选项的类名）只准写在 `10-config-state.js` 的
// 真源字段里（_questionSelectors / _quizContainerSelector / _quizDetectorSelector /
// _questionTitleSelectors / _optionListSelectors）。
//
// 为什么必须机械地拦：这批类名已经**手抄漂移过三次** ——
//   ① `_quizContainerSelector` 曾被手抄三处，其中一处抄成 `.Cy_TITle`（大小写错）；
//   ② `_detectQuiz` 手抄的清单漏了 `.Cy_TItle`，作业/考试页的 DOM 兜底整体失效；
//   ③ `_rememberWrongQuizAnswers` 手抄的清单同样漏了 `.Cy_TItle`，作业/考试页的
//      错答永远进不了「避开错答」缓存 —— 不报错、不留日志，只表现成"反复错同一题"。
// 三次的共同点：**平台改版时没人记得还有第 N 份手抄**。
// 判据：剥掉注释后，真源文件之外出现这些类名的字面量就报错 ——
// 学习通改版时只改真源一处，其余全部自动跟随。
//
// ⚠️ 名单只收**题目结构族**（历史上被手抄过、或多处共用的类名）；
// 单处使用的站点类名（.answerCon / .answerScore / input[id^=answertype] 等）
// 只有唯一一份、无从漂移，不在列。新增平台类名进真源时，把这个名单同步加一行。
// ---------------------------------------------------------------------------
function checkSelectorTruthSource() {
  var guarded = [
    'TiMu', 'Cy_TItle', 'Zy_TItle', 'questionLi', 'singleQuesId', 'questionItem', 'tiBank', 'topicItem',
    'exam_question', 'singleQues', 'mark_item', 'questionBox', 'answerOption',
    'Zy_ulTop', 'Zy_ulBottom', 'Zy_ulTk', 'Cy_ulTop', 'Cy_ulBottom', 'Cy_ulTk',
    'fontLabel', 'mark_name', 'Pt1',
    'question-title', 'question-stem', 'topicTitle', 'question_content', 'qContent', 'mark_title', 'question-name'
  ];
  var sources = ['content.js'];
  fs.readdirSync(path.join(ROOT, 'src', 'page')).filter(function (f) { return /\.js$/.test(f); }).sort()
    .forEach(function (f) { if (f !== '10-config-state.js') sources.push('src/page/' + f); });

  var issues = [];
  sources.forEach(function (file) {
    var lines = stripComments(read(file)).split(/\r?\n/);
    lines.forEach(function (line, i) {
      guarded.forEach(function (name) {
        var at = line.indexOf(name);
        while (at !== -1) {
          var before = at > 0 ? line.charAt(at - 1) : '';
          var after = line.charAt(at + name.length) || '';
          if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
            issues.push(file + ':' + (i + 1) + '  .' + name + '  →  ' + line.trim().slice(0, 90));
            break;
          }
          at = line.indexOf(name, at + 1);
        }
      });
    });
  });

  if (issues.length) {
    fail('题目选择器手抄出真源（平台改版只准改 10-config-state.js 的真源字段）:\n      ' +
      issues.join('\n      ') +
      '\n      改成引用 this._quizContainerSelector / this._quizDetectorSelector / ' +
      'this._questionTitleSelectors / this._optionListSelectors（按用途选，见真源处注释）');
    return;
  }
  pass('题目选择器真源守卫（' + guarded.length + ' 个平台类名，真源外零手抄）');
}

// ---------------------------------------------------------------------------
// 20. 立绘池守卫
//
// 角色的三个池子（服装 SKINS / 表情 FACES / 姿势 POSES）与她自己动的小动作池
// （MOTIONS）定义在 `popup/pet-game.js` 的 `ART` 里 —— 弹窗的立绘册和上课页伴侣
// （content.js 的自动换装）读同一份，抄两份必然漂移。
// 历史事故：**文件名前缀与画面内容错位**（pet-e2~e6 画的是服装却被放进表情池、
// pet-i5~i8 是表情却被放进表情池前的姿势族……），用户看到的就是
// 「按了表情怎么换衣服了 / 表情里混着姿势」。2026-10-31 已逐张看图重建。
//
// 这条守卫钉住五件事，防止未来加立绘时再漂：
//   ① 池子里引用的每个文件都真实存在（防手滑写错文件名 —— 不报错、图片裂图）；
//   ② popup/ 下所有 pet*.png 都被某个池子引用（防孤儿 —— 加了图忘了归类，
//      立绘册里永远看不到它，还以为丢了）；
//   ③ 除 pet.png（默认立绘，兼作服装与姿势的基座）外，**禁止跨池重复** ——
//      一张图两个身份，正是"切换搞混"的根源；
//   ④ 池子并集去重后必须等于磁盘上的实际张数（以上三条的合并断言）；
//   ⑤ MOTIONS 里每个动作名都要在 `content.js` 的样式里有同名 `@keyframes` ——
//      名字写错**不报错**，只会让她"越来越安静"（自动动作那一拍找不到动画）。
// ---------------------------------------------------------------------------
function checkPetSpritePools() {
  var src;
  try { src = read('popup/pet-game.js'); } catch (e) { fail('读取 popup/pet-game.js 失败: ' + e.message); return; }

  function pool(name) {
    var m = src.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];'));
    if (!m) { fail('popup/pet-game.js 里找不到 ' + name + ' 池子（被改名/移动了？同步本守卫）'); return []; }
    var out = [];
    // ⚠️ 必须是 [^"]*（零个或多个）：用 [^"]+ 会恰好匹配不到 "pet.png" 本身
    //    （pet 和 .png 之间没有字符）—— 基座立绘就这样从所有池子里消失了
    var re = /"(pet[^"]*\.png)"/g, mm;
    while ((mm = re.exec(m[1]))) out.push(mm[1]);
    return out;
  }

  var pools = { SKINS: pool('SKINS'), FACES: pool('FACES'), POSES: pool('POSES') };
  if (problems.length && (!pools.SKINS.length && !pools.FACES.length && !pools.POSES.length)) return;

  var onDisk = [];
  try {
    onDisk = fs.readdirSync(path.join(ROOT, 'popup')).filter(function (f) { return /^pet.*\.png$/.test(f); }).sort();
  } catch (e) { fail('读取 popup/ 立绘目录失败: ' + e.message); return; }

  var issues = [];
  var union = {};
  Object.keys(pools).forEach(function (name) {
    if (!pools[name].length) { issues.push(name + ' 池子是空的'); return; }
    pools[name].forEach(function (f) {
      if (onDisk.indexOf(f) === -1) issues.push(name + ' 引用了不存在的文件 ' + f);
      if (union[f] && f !== 'pet.png') issues.push(f + ' 同时出现在 ' + union[f] + ' 与 ' + name + '（跨池重复 = 切换搞混的根源；只有 pet.png 允许双身份）');
      union[f] = union[f] || name;
    });
  });
  onDisk.forEach(function (f) {
    if (!union[f]) issues.push('孤儿立绘 ' + f + ' —— 在 popup/ 里但没有任何池子引用（立绘册里看不到它）');
  });

  // ⑤ 自动动作池与 content.js 的动画名对账（**两个文件之间**的字符串契约，拼错不报错）
  var motions = [];
  var mm2 = src.match(/var MOTIONS = \[([\s\S]*?)\];/);
  if (!mm2) {
    issues.push('popup/pet-game.js 里找不到 MOTIONS 池子（她自己在上课页做的那些小动作；同步本守卫）');
  } else {
    // ⚠️ 引号两种都要认 —— 只写 `'...'` 时，`["tilt","hop"]` 一个都匹配不到，
    //   于是 motions 是空数组、下面 forEach 一格都不跑，守卫打印"自动动作 0 个都在 content.js 有动画"
    //   照样绿（2026-11-15 实测：这条空守卫就是本批次第一版写出来的）。
    var re2 = /["']([a-z-]+)["']/g, m2;
    while ((m2 = re2.exec(mm2[1]))) motions.push(m2[1]);
    if (!motions.length) {
      issues.push('MOTIONS 池子解析出 0 个动作名（池子是空的，或写法改了正则读不到 —— 她不会再自己动，而本守卫会假绿）');
    }
    var contentSrc = '';
    try { contentSrc = read('content.js'); } catch (e) { issues.push('读不到 content.js，自动动作对不了账'); }
    motions.forEach(function (name) {
      if (contentSrc.indexOf('@keyframes om-pet-' + name) === -1) {
        issues.push('自动动作 ' + name + ' 在 content.js 里没有 @keyframes om-pet-' + name +
          '（她那一拍什么都不会动，且不报错）');
      }
    });
    if (motions.length && contentSrc.indexOf('.card .pet.mv-') === -1) {
      issues.push('content.js 里没有 `.card .pet.mv-` 那族规则 —— 动作名对上了也不会被应用');
    }
  }

  if (issues.length) {
    fail('立绘池与磁盘不一致（分类漂移 / 文件名写错 / 漏归类）:\n      ' +
      issues.join('\n      '));
    return;
  }
  pass('立绘池守卫（服装 ' + pools.SKINS.length + ' / 表情 ' + pools.FACES.length +
    ' / 姿势 ' + pools.POSES.length + '，去重 ' + Object.keys(union).length +
    ' 张 = 磁盘 ' + onDisk.length + ' 张，无跨池无孤儿；自动动作 ' + motions.length + ' 个都在 content.js 有动画）');
}

// ---------------------------------------------------------------------------
// 21. 桥接消息类型两端一致
//
// page.js 与 content.js 靠 `window.postMessage` 通信，**按字符串类型分发**。
// 任何一端把类型名拼错，另一端就**收不到、也不报错** ——
// 唯一的表现是 `bridgeSend` 那条 promise **一直等到 90 秒超时才 resolve**，
// 日志里写的是 **「bridge timeout: xxx no response」**。
//
// ⚠️ 这就是为什么必须守它：那个报错**把人指向"网络/桥接坏了"**，
// 而真正的原因是**一个拼错的字符串**。本项目最讨厌的就是这种"症状指错方向"的坑
// （同族：`.Cy_TITle` 那个大小写笔误让诊断自己骗人）。
//
// 判据：两个方向都比对 ——
//   ① page 用 `bridgeSend('X')` 发出的，content.js 必须有 `msg.type === 'X'` 分支
//   ② content.js 用 `source: 'xxt_bridge'` 发出的，page 侧必须有对应分支
// ---------------------------------------------------------------------------
function checkBridgeMessageTypes() {
  var partsDir = path.join(ROOT, 'src', 'page');
  var pageLines = [];
  fs.readdirSync(partsDir).filter(function (f) { return /\.js$/.test(f); }).sort()
    .forEach(function (file) {
      fs.readFileSync(path.join(partsDir, file), 'utf8').split(/\r?\n/).forEach(function (line, i) {
        pageLines.push({ file: file, no: i + 1, text: line });
      });
    });

  function collect(list, re, pick) {
    var out = Object.create(null);
    list.forEach(function (l) {
      var m;
      var r = new RegExp(re.source, 'g');
      while ((m = r.exec(l.text))) {
        var v = pick(m);
        if (v && !out[v]) out[v] = l.file + ':' + l.no;
      }
    });
    return out;
  }

  // 行式扫描：`source: '<src>'` 之后（含同行）最多 3 行内的第一个 `type: '...'`。
  // ⚠️ 用行式而不是跨行正则：`source:` 与 `type:` 常常隔着一两行（中间还有 id:），
  // 跨行正则容易把远处无关的 `type:` 配进来。
  // 也**不认** `type: type`（变量形式）—— 那是 bridgeSend 内部转发，由上面那条覆盖。
  function collectEmitted(lines, sourceLiteral) {
    var out = Object.create(null);
    lines.forEach(function (l, i) {
      if (l.text.indexOf(sourceLiteral) === -1) return;
      for (var j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
        var m = lines[j].text.match(/type:\s*['"]([A-Za-z_][\w]*)['"]/);
        if (m) {
          if (!out[m[1]]) out[m[1]] = l.file + ':' + lines[j].no;
          return;
        }
      }
    });
    return out;
  }

  // ① page 发出的类型。**两条路都要收**：
  //    - `bridgeSend('X')`（要等回执的）
  //    - 直接 `window.postMessage({ source: 'xxt_app', type: 'X' })`（不等回执的，
  //      例如 `emitRuntimeLog` 的 runtime_log、10-config-state.js 的 storage_set）
  //    只收前者会漏掉后面这两种（实测漏了 2 种）。
  var sent = collect(pageLines, /bridgeSend\(\s*['"]([A-Za-z_][\w]*)['"]/, function (m) { return m[1]; });
  var sentDirect = collectEmitted(pageLines, "source: 'xxt_app'");
  Object.keys(sentDirect).forEach(function (t) { if (!sent[t]) sent[t] = sentDirect[t]; });

  // page 侧能处理的类型（收 xxt_bridge 那一段）
  var pageHandled = collect(pageLines, /msg\.type\s*===\s*['"]([A-Za-z_][\w]*)['"]/, function (m) { return m[1]; });

  // content.js 侧
  var contentLines = read('content.js').split(/\r?\n/).map(function (t, i) {
    return { file: 'content.js', no: i + 1, text: t };
  });
  var contentHandled = collect(contentLines, /msg\.type\s*===\s*['"]([A-Za-z_][\w]*)['"]/, function (m) { return m[1]; });

  // ② content.js 用 source: 'xxt_bridge' 发出的类型
  var emitted = collectEmitted(contentLines, "source: 'xxt_bridge'");

  var issues = [];

  // 方向 ①：page 发的，content 必须认
  Object.keys(sent).forEach(function (t) {
    if (!contentHandled[t]) {
      issues.push('page 发出 bridgeSend(\'' + t + '\')（' + sent[t] + '），' +
        '但 content.js 里没有 `msg.type === \'' + t + '\'` 分支 —— 消息会被静默丢弃，' +
        '表现是 90 秒后报 bridge timeout（看起来像网络问题）');
    }
  });

  // 方向 ②：content 回的，page 必须认
  Object.keys(emitted).forEach(function (t) {
    if (!pageHandled[t]) {
      issues.push('content.js 发出 xxt_bridge 消息 type: \'' + t + '\'（' + emitted[t] + '），' +
        '但 page.js 里没有对应分支 —— 回调永远不触发，同样是等到 bridge timeout');
    }
  });

  if (Object.keys(sent).length === 0 || Object.keys(emitted).length === 0) {
    fail('桥接消息类型守卫失效：page 发出 ' + Object.keys(sent).length + ' 种、' +
      'content 发出 ' + Object.keys(emitted).length + ' 种 —— 至少一侧是 0，说明提取正则没匹配上，' +
      '请同步这段正则（守卫失效比没有守卫更糟）');
    return;
  }

  if (issues.length) {
    fail('桥接消息类型两端不一致:\n      ' + issues.join('\n      '));
    return;
  }
  pass('桥接消息类型两端一致（page 发出 ' + Object.keys(sent).length + ' 种、' +
    'content 回 ' + Object.keys(emitted).length + ' 种，都有对应分支）');
}

// ---------------------------------------------------------------------------
// 21. 仓库公开面卫生
//
// 为什么要有这条：本机路径（带着 Windows 用户名）、逐阶段验收证据、临时 profile 目录
// 这类东西**只该留在自己机器上**。它们不会让任何一条测试变红，却能跟着一次
// `git add -A` 整包提交上去 —— 而仓库是公开的。实测踩过：5 份 `omitone-acceptance-*.jsonl`
// 里写着 `C:\Users\<用户名>\AppData\Local\Temp\omitone-sandbox-XXXX`，
// 连着一批真实 `chapterId` 一起挂在 GitHub 上好几天。
//
// 判据分两半，**文件名与内容都要管**：
//   ① 文件名：证据 jsonl/json、`*.bak*`、`*.log`、`tmp/`、`.workbuddy/`、`dist/` 不许被跟踪
//   ② 内容：跟踪中的文本文件不许出现本机 home 路径、`<盘>:\Users\` 这种带用户名的路径，
//      也不许出现现场粘来的真编号（学习通章节号 10 位 `12…`；id 上下文里非 9 开头的长数字）
// 反向验证：临时把某个跟踪文件里塞一行 `C:\Users\someone\` 必须让它变红。
// ---------------------------------------------------------------------------
function checkPublicHygiene() {
  var r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
  if (r.status !== 0) {
    warn('仓库公开面卫生：`git ls-files` 不可用，这一项没跑成');
    return;
  }
  var files = r.stdout.toString('utf8').split('\0').filter(Boolean);

  // ① 文件名闸
  var BAD_NAME = [
    [/^omitone-acceptance-\d{8}T\d{6}Z-[a-f0-9-]{36}\.jsonl?$/, '验收证据/回执（里面有本机路径）'],
    [/\.bak\d*$/, '备份文件'],
    [/\.log$/, '日志'],
    [/^(tmp|\.workbuddy|dist|node_modules)\//, '本地工作目录']
  ];
  var nameHits = [];
  files.forEach(function (f) {
    BAD_NAME.forEach(function (b) {
      if (b[0].test(f)) nameHits.push(f + '（' + b[1] + '）');
    });
  });

  // ② 内容闸。两份文件天生带着这些字面量，属于"检测器自己的样例"，排除掉：
  //    publish-audit.js 的注释里写着 `C:/Users/<用户名>`，本文件写着这些正则。
  var SELF_EXPLAIN = ['tools/publish-audit.js', 'tools/check.js'];
  var TEXT_EXT = /\.(js|cjs|mjs|json|md|html|css|txt|xml|yml|yaml|expr|gitignore|editorconfig|svg)$/i;
  var home = (os.homedir() || '').replace(/\\/g, '/');
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // 本仓库的**夹具号一律 9 开头**（章节 9000049xxx、课程 900000001、任务 9000000000000001）。
  // 所以「出现在 id 上下文里、又不是 9 开头」的长数字 = 从现场粘过来的真号，必须换掉。
  // 「本仓库的绝对路径」(D:\Omite) **不算泄漏**：里面没有用户名，而文档与工具注释是真要靠它
  // 讲道理（扩展 ID 由路径大小写算出来，见 AGENTS.md §7.2）。带用户名的路径由前两条管。
  var ID_CTX = "(?:chapterId|courseId|chapterid|courseid|jobid|jobId|qid)[=:'\"\\\\ ]{1,4}|getTeacherAjax\\(\\\\*['\"]|nodeId_|answer field ";
  var COMMON = [
    [new RegExp(esc(home), 'i'), '本机 home 路径'],
    [/[a-z]:[\\/]{1,2}(?:users|home)[\\/]{1,2}\w/i, '带用户名的用户目录路径'],
    [/\b12\d{8}\b/, '疑似真实课程章节号（学习通章节号出厂就是 12 开头 10 位）'],
    [new RegExp('(?:' + ID_CTX + ')(?!9)\\d{8,}', 'i'), 'id 上下文里的真实编号（该换成 9 开头的合成夹具号）']
  ];
  var contentHits = [];
  files.forEach(function (f) {
    if (SELF_EXPLAIN.indexOf(f) !== -1) return;
    if (/\.min\.js$/i.test(f)) return; // 第三方压缩库：满屏数字，扫它只会误报
    if (!TEXT_EXT.test(f)) return;
    var abs = path.join(ROOT, f);
    var buf;
    try { buf = fs.readFileSync(abs); } catch (e) { return; }
    if (buf.indexOf(0) !== -1) return; // 二进制（图片/PDF）交给 publish-audit 去扫
    var lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach(function (line, i) {
      if (/卫生样例/.test(line)) return;
      COMMON.forEach(function (p) {
        if (p[0].test(line) && contentHits.length < 12) {
          contentHits.push(f + ':' + (i + 1) + ' ' + p[1] + ' → ' + line.trim().slice(0, 90));
        }
      });
    });
  });

  if (nameHits.length || contentHits.length) {
    var msg = [];
    if (nameHits.length) {
      msg.push('不该被跟踪的文件：\n      ' + nameHits.slice(0, 8).join('\n      ') +
        (nameHits.length > 8 ? '\n      …共 ' + nameHits.length + ' 个' : ''));
    }
    if (contentHits.length) {
      msg.push('公开内容里带着私人信息：\n      ' + contentHits.join('\n      '));
    }
    fail('仓库公开面卫生未过：' + msg.join('\n    '));
    return;
  }
  pass('仓库公开面卫生（' + files.length + ' 个跟踪文件：无证据/备份/日志入库，无本机路径与真实章节号）');
}

// ---------------------------------------------------------------------------
// 22. 根目录那些独立套件必须挂在 `npm test` 链上
//
// 为什么要有这一条（批次 46 的直接教训）：`omitone-*.cjs` 这批套件各自只要 0~1 秒，
// 却**一个都不在 `npm test` 里**，于是它们连着烂了三个批次没人发现 ——
//   - `omitone-sandbox.cjs` 全盘扫描走进 `.debug-profile` 撞上 Edge 独占的 LOCK 文件，
//     直接 EBUSY，整套**起不来**；
//   - `omitone-regression.cjs` 的 L06 负控锚点 `}, DECRYPT_FETCH_TIMEOUT_MS);`
//     早在批次 34 就不存在了，而它的 `mutateOnce` 要求锚点恰好命中 1 次 ——
//     也就是说那一条自检当时必然抛错；
//   - `omitone-fuzz-test.cjs` 还在按宠物好感上限的**旧值 100** 判越界，
//     而正典早已提到 240（`GAME.RULES.max`），三处判据同时读错。
// 三个都是"跑一下就会红"的量级，但没人跑，所以没人知道。
//
// 判据口径：**按目录里实际存在哪些套件来要求，而不是照抄一份写死的清单** ——
// 写死清单的话，下次新增套件仍然会漏（这次烂的就是"漏"本身）。
// 重件（`sandbox` 297 秒、`acceptance:built` 要起真浏览器）留在链外，但**留名要有理由、
// 理由要能被校验**：排除表里的文件必须还存在、且必须仍被某个 npm 脚本调用得到，
// 否则就是在给未来的漏挂开后门。
// ---------------------------------------------------------------------------
function checkTestSuiteWiring() {
  var SUITE_RE = /^omitone-.*\.cjs$/;
  var onDisk = fs.readdirSync(ROOT).filter(function (f) { return SUITE_RE.test(f); });

  // 不进 `npm test` 的重件 —— 值是这个套件对应的 npm 脚本名
  var HEAVY = {
    'omitone-sandbox.cjs': 'sandbox',
    'omitone-acceptance.cjs': 'acceptance:built'
  };

  var scripts = {};
  try { scripts = JSON.parse(read('package.json')).scripts || {}; } catch (e) {}
  var testChain = String(scripts.test || '');
  if (!testChain) {
    fail('package.json 里没有 `test` 脚本 —— 这一项守卫无从校验，请先修 `npm test`');
    return;
  }
  if (!onDisk.length) {
    fail('独立套件挂载检查失效：根目录数不到任何 `omitone-*.cjs` —— ' +
      '守卫失效比没有守卫更糟，请核对这里的正则');
    return;
  }

  var missing = [];
  var expected = onDisk.filter(function (f) { return !HEAVY[f]; });
  expected.forEach(function (f) {
    if (testChain.indexOf('node ' + f) < 0) missing.push(f);
  });

  // 同一文件跑两种模式的（回归件：全场 + 自检），只挂一种等于漏了一半
  var MODES = { 'omitone-regression.cjs': ['--self-test'] };
  var missingModes = [];
  Object.keys(MODES).forEach(function (f) {
    if (onDisk.indexOf(f) < 0) return;
    MODES[f].forEach(function (flag) {
      if (testChain.indexOf('node ' + f + ' ' + flag) < 0) missingModes.push(f + ' ' + flag);
    });
  });

  // 链上不许指向不存在的文件（那会让 `npm test` 直接炸在半路，且看不出是挂载问题）
  var dangling = [];
  (testChain.match(/node (omitone-[^\s]+\.cjs)/g) || []).forEach(function (frag) {
    var f = frag.slice(5);
    if (onDisk.indexOf(f) < 0) dangling.push(f);
  });

  // 排除表自证：条目要还存在于磁盘、且仍被它对应的那个脚本调用得到
  var heavyBad = [];
  Object.keys(HEAVY).forEach(function (f) {
    if (onDisk.indexOf(f) < 0) { heavyBad.push(f + '（磁盘上已没有这个文件，排除表该删掉这一条）'); return; }
    var scriptName = HEAVY[f];
    var body = String(scripts[scriptName] || '');
    if (!body) { heavyBad.push(f + '（排除理由指向脚本 `' + scriptName + '`，但 package.json 里没有它）'); return; }
    if (body.indexOf('node ' + f) < 0) {
      heavyBad.push(f + '（排除理由说它由 `' + scriptName + '` 跑，但那个脚本并没有调用它）');
    }
  });

  var msg = [];
  if (missing.length) msg.push('这些独立套件在根目录里、却没挂进 `npm test`：' + missing.join('、'));
  if (missingModes.length) msg.push('这些套件只挂了一种模式：' + missingModes.join('、'));
  if (dangling.length) msg.push('`npm test` 链里有不存在的套件：' + dangling.join('、'));
  if (heavyBad.length) msg.push('重件排除表对不上：' + heavyBad.join('；'));
  if (msg.length) {
    fail('独立套件挂载未过：' + msg.join('\n      ') +
      '\n      （留在链外的只有 ' + Object.keys(HEAVY).join(' / ') + '，其余秒级套件必须跟着 `npm test` 跑）');
    return;
  }
  pass('独立套件挂载（链内 ' + expected.length + ' 个 + 链外重件 ' + Object.keys(HEAVY).length + ' 个，排除项均有脚本可跑）');
}

// ---------------------------------------------------------------------------
// 23. 夹具 HTML 必须能被浏览器解析（批次 48）
//
// 要拦的是这一族：夹具照着**日志摘录**写，于是 `javascript:` 里少一个右括号
// —— `String(src).slice(0, 40)` 那个长度是摘录宽度，不是页面真串。
// 批次 47 的反向验证给出的是**否证**：把坏形状注回去，沙盒那条「场景结束无未捕获
// 页面异常」读到 3 秒仍是 `pageErrors:0` —— 浏览器压根没跑那段程序，
// 于是「页面静默丢掉整块脚本」和「代码坏了」在断言里长得一模一样。
// 这一族只能静态量：每段内联 `<script>` 与每个 `javascript:` URL 过一次
// `new vm.Script`（真源 tools/fixture-parse-guard.js），解析不了就报红。
// ---------------------------------------------------------------------------
function checkFixtureParsable() {
  var guard;
  try {
    guard = require('./fixture-parse-guard.js');
  } catch (e) {
    fail('夹具可解析守卫加载失败：' + String((e && e.message) || e));
    return;
  }

  // ---- 阴性对照：先证明这道闸关得上 ----
  // 前两格证明它**会响**（坏内联体 / 坏 javascript: URL 各一条）；
  // 第三格证明它**不误报**，且带 `src=` 的外链脚本与 `type="application/json"`
  // 不算程序 —— 那两样浏览器也不会跑，扫了只会造出假红。
  var CASES = [
    { name: '内联 <script> 体少一个右括号', want: 1,
      html: '<html><body><script>var a = (function(){document.open</script></body></html>' },
    { name: 'javascript: URL 少一个右括号', want: 1,
      html: '<html><body><a href="javascript:void(function(){document.open">go</a></body></html>' },
    { name: '干净夹具（含外链脚本与 JSON 脚本，不许误报）', want: 0,
      html: '<html><body><script>var a = (function(){return 1;})();</script>' +
        '<a href="javascript:void(0)">go</a>' +
        '<script src="./not-inlined.js"></script>' +
        '<script type="application/json">{"broken": </script></body></html>' }
  ];
  var bad = [];
  CASES.forEach(function (c) {
    var n;
    try { n = guard.problemsIn('阴性对照/' + c.name, c.html).length; }
    catch (e2) { bad.push(c.name + '：探测本身抛了 ' + String((e2 && e2.message) || e2)); return; }
    if (n !== c.want) bad.push(c.name + '：应报 ' + c.want + ' 条，实际 ' + n + ' 条');
  });
  if (bad.length) {
    fail('夹具可解析守卫的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }

  // ---- 接线自证：守卫写好了但没人调用 = 没有守卫 ----
  var e2eSrc = read('tools/browser-e2e.js');
  var wiring = [];
  if (e2eSrc.indexOf("require('./fixture-parse-guard.js')") < 0) wiring.push('没有 require 这个守卫');
  if (e2eSrc.indexOf('scanFixture(urlPath, fixtureHtml)') < 0) wiring.push('serve 那一步没把正要发出去的 HTML 交给 scanFixture()');
  if (e2eSrc.indexOf('FIXTURE_PROBLEMS.length') < 0) wiring.push('收尾没有把 FIXTURE_PROBLEMS 报出来');
  if (e2eSrc.indexOf('--validate-fixtures') < 0) wiring.push('没有 --validate-fixtures 全表入口');
  if (wiring.length) {
    fail('夹具守卫在 tools/browser-e2e.js 里没接到位：' + wiring.join('、'));
    return;
  }

  // ---- 扫全表：MOCK_PAGES 每一页逐页生成并解析（定向跑只覆盖访问过的那几页） ----
  // 为什么走子进程：MOCK_PAGES 住在 browser-e2e.js 里，而那个文件末尾就是 `main()`，
  // 直接 require 会把整套真实 Edge 端到端拉起来。
  // ⚠️ 与 checkFontTable 同一个教训：spawn **本身**失败时（实测本机 `spawnSync node.exe → EBUSY`）
  // stdout/stderr 都是空的，不把 `result.error` 打出来，报出来就是一句「扫不了」后面什么都没有。
  // EBUSY 是瞬时的，所以重试一次；两次都不行才报红 —— 报红也比静默跳过好。
  var script = path.join(__dirname, 'browser-e2e.js');
  var VALIDATE_SCAN_FLAG = '--validate-fixtures';
  var result = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    result = spawnSync(process.execPath, [script, VALIDATE_SCAN_FLAG], { encoding: 'utf8', timeout: 60000 });
    // 只有 EBUSY 这类**起不来**才值得重试；挂住（ETIMEDOUT）再跑一遍只会多等 60 秒。
    if (!result.error || result.error.code === 'ETIMEDOUT') break;
  }
  if (result.error) {
    // 两种失败输出都是空的，原因完全不同，必须分开说（否则又是一次「诊断把真原因吞掉」）：
    // EBUSY = 本机 spawn 抖动；ETIMEDOUT = 子进程**挂住** —— 扫 71 页本是秒级的事，
    // 挂住多半是那个分支没收尾、把启动器也叫起来了（批次 48 实测）。
    var hint = result.error.code === 'ETIMEDOUT'
      ? '（60 秒没返回：扫全表本该是秒级，怀疑它掉进了启动器）'
      : '（已重试一次）';
    fail('夹具全表扫描的子进程没跑成' + hint + '：' + String(result.error) +
      '\n      status=' + result.status + ' signal=' + result.signal);
    return;
  }
  var out = String((result.stdout || '') + (result.stderr || '')).trim();
  if (result.status !== 0) {
    fail('夹具里有浏览器解析不了的程序：\n      ' +
      (out ? out.split('\n').join('\n      ') : '（子进程没有输出，status=' + result.status + '）'));
    return;
  }
  pass('夹具 HTML 可解析（' + out.split(/\r?\n/).filter(Boolean).join('；') + '；含 3 格阴性对照）');
}

// ---------------------------------------------------------------------------
// 24. 跨域裸读必须有保护（AGENTS.md §2 第 1 条的机检）
// ---------------------------------------------------------------------------
// 这条规矩原本只写在文档里、靠人自觉，而它的失败模式正是文档自己承认「最难查」的那类：
// 裸读跨域 iframe 的 `.document` 抛 SecurityError，异常冒泡到 `_runTick` 就把整轮调度
// 静默打断 —— 页面不报错、日志不动，看起来像「扩展没干活」。
//
// ⚠️ 期望数字在**这里**各写一份，不照抄 `audit.SELF_CASES[].expect`。
// 照抄的话，「把 expect 改成实际值」就能让自检永远绿 —— 那是假绿的另一个形状。
// 这个审计的上一版就是反例：它按「行」判 try 保护，于是同行闭合的
// `try { doc = frame.contentDocument; } catch (eCross) { return null; }`
// 被报成危险，干净树也 exit 1（`62-tasks-run.js` 的 `_voteOverlayDocReady`）；
// 再上一版漏了正则字面量，吞掉半份文件之后报「0 处」。
// **误报和漏报都会训练人忽略这道闸**，所以九格按 pin 逐格复算，两个方向都得有格子。
function checkSafedocGuard() {
  var audit;
  try {
    audit = require('./audit-safedoc.js');
  } catch (e) {
    fail('跨域裸读审计加载失败：' + String((e && e.message) || e));
    return;
  }

  var WANT = {
    'same-line-try': { reads: 1, risky: 0, guarded: 1 },
    'multiline-try': { reads: 1, risky: 0, guarded: 1 },
    'no-try': { reads: 1, risky: 1, guarded: 0 },
    'catch-body': { reads: 1, risky: 1, guarded: 0 },
    'after-regex': { reads: 1, risky: 1, guarded: 0 },
    'inside-helper': { reads: 1, risky: 0, guarded: 0, inHelpers: 1 },
    'comment-only': { reads: 0, rawHits: 2 },
    'unclosed-block': { reads: 0, lexerProblems: 1 },
    'template-depth': { reads: 1, risky: 0, guarded: 1 }
  };

  var cases = audit.SELF_CASES || [];
  var bad = [];
  Object.keys(WANT).forEach(function (pin) {
    var hit = cases.filter(function (c) { return c.pin === pin; });
    if (hit.length !== 1) {
      bad.push(pin + '：这一格应当恰好 1 个，实际 ' + hit.length + ' 个（自检格子被删掉或重复了）');
      return;
    }
    var got;
    try {
      got = audit.scanSource('(自检)/' + pin, hit[0].src.join('\n'));
    } catch (e2) {
      bad.push(pin + '：复算时审计抛了 ' + String((e2 && e2.message) || e2));
      return;
    }
    var want = WANT[pin];
    Object.keys(want).forEach(function (field) {
      var actual = field === 'lexerProblems' ? got.lexerProblems.length : got[field];
      if (actual !== want[field]) {
        bad.push(pin + '：' + field + ' 应为 ' + want[field] + '，审计给出 ' + actual);
      }
    });
    if (got.alignmentProblems.length) {
      bad.push(pin + '：对位自证不过 —— ' + got.alignmentProblems.join('；'));
    }
  });
  var selfBad = audit.runSelfCheck();
  if (selfBad.length) {
    bad.push('审计自带的自检不过 ' + selfBad.length + ' 格：' + selfBad.join('；'));
  }
  if (bad.length) {
    fail('跨域裸读审计的九格阴性对照不成立（会误报的守卫比没有守卫更害人）：\n      ' +
      bad.join('\n      '));
    return;
  }

  // ---- 接线自证：它得真的在扫那 16 份片段，而不是构建产物或一个空目录 ----
  var dirName = rel(audit.DIR);
  if (dirName !== 'src/page') {
    fail('跨域裸读审计的目录指错了：实际 ' + dirName +
      '（要扫源码片段 src/page，不是构建产物 page.js）');
    return;
  }
  var results;
  var sum;
  try {
    results = audit.scanDir(audit.DIR);
    sum = audit.summarize(results);
  } catch (e3) {
    fail('扫 src/page 时审计抛了：' + String((e3 && e3.message) || e3));
    return;
  }
  var realCount = fs.readdirSync(audit.DIR).filter(function (f) {
    return /\.js$/.test(f);
  }).length;
  if (sum.files !== realCount) {
    fail('跨域裸读审计只扫了 ' + sum.files + ' 份，src/page 里实有 ' + realCount +
      ' 份 .js —— 扫过的不是要保护的那批文件');
    return;
  }
  // ⚠️ 「0 处命中」必须能和「根本没走到」区分开。安全助手本体（`_safeDocOf` /
  // `_safeWinDoc`）**自己就要读 contentDocument**，所以一处都没有只可能是词法器
  // 或目录坏了。这一格今天实测是三十多处命中。
  if (sum.reads <= 0) {
    fail('跨域裸读审计一处都没命中 —— 这不可能是真的（安全助手本体里必然有），' +
      '怀疑词法器把内容吞掉了');
    return;
  }
  if (sum.problems.length) {
    fail('跨域裸读审计自己的对位/词法自证没过，它报的「没有保护 0 处」不可信：\n      ' +
      sum.problems.join('\n      '));
    return;
  }
  if (sum.risky > 0) {
    fail('src/page 里有 ' + sum.risky +
      ' 处裸读跨域 document 没被 try 包住（AGENTS.md §2 第 1 条；改用 _safeDocOf() / _safeWinDoc()，' +
      '或把这一处放进 try 并留兜底）：\n      ' +
      sum.riskyRows.map(function (r) {
        return r.file + ':' + r.line + ':' + r.col + ' [' + r.fn + '] 当下在 ' + r.frameKind +
          ' 里 → ' + r.text.slice(0, 90);
      }).join('\n      '));
    return;
  }
  pass('跨域裸读必须有保护（' + sum.files + ' 份片段共 ' + sum.reads + ' 处命中：try 体内 ' +
    sum.guarded + ' 处、安全助手内 ' + sum.inHelpers + ' 处、裸奔 0 处；' +
    '九格阴性对照按 pin 逐格复算 + 每一处行列回原文核对）');
}

// ---------------------------------------------------------------------------
// 25. 公开文档的 markdown 表格不许有"列数和表头不一样"的行
// ---------------------------------------------------------------------------
// GitHub 渲染表格时，**代码片段里的竖线不转义也算列分隔符** —— 那一行会向右溢、
// 多出来的格变成新列，网页上读起来是断的。这类损坏不进任何测试：文件语法正常、
// 自检/集成/e2e 全绿，只有用户在 GitHub 上读那一页时看得见。
// 2026-11-14 抓到 4 行（README §6 #52、HANDOVER §9 三行），其中一行还是**两条被并成一条**
// —— 竖线计数顺带能抓到这种损坏。
//
// ⚠️ 期望数字在**这里**各写一份，不照抄 `audit.SELF_TEST[].want`（同第 24 项的规矩：
// 照抄的话，把 want 改成实际值就能让自检永远绿）。三格"要报" + 三格"不报" ——
// **会误报的守卫和没有守卫一样害人**，负向那三格（转义写法、围栏代码块、
// 以竖线开头但没有分隔行的正文）少一格都不行，README 里大量 ASCII 图就靠它们不炸。
function checkMarkdownTables() {
  var audit;
  try {
    audit = require('./audit-md-tables.js');
  } catch (e) {
    fail('文档表格审计加载失败：' + String((e && e.message) || e));
    return;
  }

  var WANT = {
    '干净三列表 → 不报': 0,
    '格里有未转义竖线 → 要报': 1,
    '同一处写成转义 → 不报': 0,
    '围栏代码块里的表样行 → 不报': 0,
    '正文以竖线开头但没有分隔行 → 不报': 0,
    '两列表被写成三列 → 要报': 1,
    // 后六格是 2026-11-18 补的两族盲区（旧口径**数竖线根数**，对这两族恒绿：
    // 行尾竖线外续了句子的行，根数与规整行**相等**；缺行首竖线的行压根不在表里）
    '行尾竖线外续了句子 → 要报': 1,
    '行尾只贴一对 HTML 注释也算外溢 → 要报': 1,
    '没写行尾竖线但格数正好 → 不报': 0,
    '缺行首竖线把表截断 → 要报': 1,
    '表后一句散文提到竖线 → 不报': 0,
    '孤行格数对得上但表没接着写 → 不报': 0
  };

  var cells = audit.SELF_TEST || [];
  var bad = [];
  Object.keys(WANT).forEach(function (name) {
    var hit = cells.filter(function (c) { return c.name === name; });
    if (hit.length !== 1) {
      bad.push(name + '：这一格应当恰好 1 个，实际 ' + hit.length + ' 个（对照格被删掉或重复了）');
      return;
    }
    var got;
    try {
      got = audit.scanText(hit[0].text).length;
    } catch (e2) {
      bad.push(name + '：复算时审计抛了 ' + String((e2 && e2.message) || e2));
      return;
    }
    if (got !== WANT[name]) {
      bad.push(name + '：应报 ' + WANT[name] + ' 条，审计给出 ' + got + ' 条');
    }
  });
  if (audit.selfCheck().length) {
    bad.push('审计自带的十二格对照没过：' + audit.selfCheck().join('；'));
  }
  if (bad.length) {
    fail('文档表格审计的十二格阴性对照不成立（会误报的守卫比没有守卫更害人）：\n      ' +
      bad.join('\n      '));
    return;
  }

  // ---- 接线自证：清单要真的含 GitHub 首页那几份，且不碰 legacy ----
  var files = audit.markdownFiles();
  var need = ['README.md', 'HANDOVER.md', 'AGENTS.md'];
  var missing = need.filter(function (n) { return files.indexOf(n) < 0; });
  if (missing.length) {
    fail('文档表格审计的清单里缺 ' + missing.join('、') +
      ' —— GitHub 首页那一页压根没被扫到');
    return;
  }
  if (files.some(function (f) { return f.indexOf('legacy/') === 0; })) {
    fail('文档表格审计扫到了 legacy/ 下的 .md（那是死代码区，第 25 项只管公开面）');
    return;
  }

  var res;
  try {
    res = audit.scanAll();
  } catch (e4) {
    fail('扫公开文档时审计抛了：' + String((e4 && e4.message) || e4));
    return;
  }
  if (res.files !== res.total) {
    fail('文档表格审计只读了 ' + res.files + ' 份，清单里共 ' + res.total +
      ' 份 .md —— 有文件读不到，「没有不一致」是假的');
    return;
  }
  // 先点名坏行，再谈自证：否则真坏的那一行会被下面的反向验证抢掉，
  // 报出来的是「反向验证没过」，人得自己反推到底哪儿坏了。
  if (res.problems.length) {
    fail('公开文档里有 ' + res.problems.length +
      ' 行的列数和表头不一致（GitHub 会把整行渲染成溢出的多列；把那一格里的竖线写成 ' +
      '`\\|`，若是两条被并成一条就补回换行）：\n      ' +
      audit.summarize(res).join('\n      '));
    return;
  }

  // ---- 反向验证（拿真文档的形状，不是合成夹具）----
  // 只测合成夹具的话，"README 里一张表都没认出来"和"扫描器只对短文本有效"都会照样报 0 条 ——
  // 那正是本项最危险的假绿：干净结论和没干活长得一模一样。
  var readme;
  try {
    readme = fs.readFileSync(path.join(audit.ROOT, 'README.md'), 'utf8');
  } catch (e3) {
    fail('文档表格审计读不到 README.md：' + String((e3 && e3.message) || e3));
    return;
  }
  var rlines = readme.split(/\r?\n/);
  var sepRow = /^\s*\|[\s:|-]+\|\s*$/;
  var firstTable = -1;
  // 第三刀（摘行首竖线）要一张**至少两行数据**的真表：断表判据要求那一行**后面还接着写**，
  // 只有一行数据的表摘掉它就没有"后面那一段"，注入会合法地一条不报 —— 那一刀等于没测。
  var twoRow = -1;
  var fenced = null;
  for (var t = 0; t + 2 < rlines.length; t++) {
    var fm = /^\s*(`{3,}|~{3,})/.exec(rlines[t]);
    if (fm) {
      var mark = fm[1].charAt(0);
      if (!fenced) fenced = mark;
      else if (fenced === mark) fenced = null;
      continue;
    }
    if (fenced) continue;
    if (/^\s*\|/.test(rlines[t]) && sepRow.test(rlines[t + 1]) &&
        rlines[t + 1].indexOf('-') >= 0 && /^\s*\|/.test(rlines[t + 2])) {
      if (firstTable < 0) firstTable = t;
      if (twoRow < 0 && /^\s*\|/.test(rlines[t + 3]) && !sepRow.test(rlines[t + 3])) twoRow = t;
      if (firstTable >= 0 && twoRow >= 0) break;
    }
  }
  if (firstTable < 0) {
    fail('文档表格审计在 README.md 的正文（围栏代码块之外）里认不出任何一张表 —— ' +
      '它报的「0 条不一致」不可信，怀疑扫描口径与真实文档脱节');
    return;
  }
  if (twoRow < 0) {
    fail('反向验证第三刀要一张**至少两行数据**的真表（断表判据要求那一行后面还接着写），' +
      'README.md 正文里找不出这样的表 —— 那一刀不能省，省了「表被一行截断」这一族就没人自证');
    return;
  }
  // ⚠️ 注入打在**整份 README** 上、判据用**增量**（多报恰好 1 条），不截三行片段：
  // 截片段的话，"扫描器只对夹具有效、对几百行的真文档失效"这一类坏法照样绿。
  var poisonedRows = rlines.slice(0);
  poisonedRows[firstTable + 2] = poisonedRows[firstTable + 2] + ' 多出来的一格 |';
  var before = audit.scanText(readme).length;
  var after = audit.scanText(poisonedRows.join('\n')).length;
  if (after !== before + 1) {
    fail('文档表格审计的反向验证没过：把 README.md:' + (firstTable + 3) +
      ' 那一行多加一格，应在原本的 ' + before + ' 条之上多报 1 条，实际共报 ' + after +
      ' 条 —— 这条闸对真实文档（整份几百行）失效，它报的「一致」不可信');
    return;
  }
  // 第二刀：**把句子写在收尾竖线外面** —— 旧口径（数竖线根数）对这一族恒绿，
  // 而 2026-11-18 实测 HANDOVER.md 里 15 行就是这个形状（GitHub 把它们渲染成多出来的一列）。
  var tailRows = rlines.slice(0);
  tailRows[firstTable + 2] = String(tailRows[firstTable + 2]).replace(/\s+$/, '') +
    ' <!-- 写在竖线外面的一句 -->';
  var tailRes = audit.scanText(tailRows.join('\n'));
  var tailOnRow = tailRes.filter(function (p) { return p.line === firstTable + 3; }).length;
  if (tailRes.length !== before + 1 || tailOnRow !== 1) {
    fail('文档表格审计对「收尾竖线外面还有文字」这一族没抓到：把 README.md:' + (firstTable + 3) +
      ' 的行尾竖线后面续一句，应恰好在原本 ' + before + ' 条之上多报 1 条并点名到那一行，' +
      '实际共报 ' + tailRes.length + ' 条、落在该行 ' + tailOnRow + ' 条 —— ' +
      '旧口径数的是竖线根数：规整行是「格数 + 1 根」、这种行是「格数根」，两者相等所以恒绿');
    return;
  }

  // 第三刀：**摘掉一行的行首竖线**（GFM 一见不以竖线开头的行就收表，后面整段不再是表）。
  var brokenRows = rlines.slice(0);
  brokenRows[twoRow + 2] = String(brokenRows[twoRow + 2]).replace(/^\s*\|/, ' ');
  var brokenRes = audit.scanText(brokenRows.join('\n'));
  var brokenOnRow = brokenRes.filter(function (p) { return p.line === twoRow + 3; }).length;
  if (brokenRes.length !== before + 1 || brokenOnRow !== 1) {
    fail('文档表格审计对「缺行首竖线把表截断」这一族没抓到：摘掉 README.md:' + (twoRow + 3) +
      ' 的行首竖线（那张表后面还接着写），应恰好在原本 ' + before + ' 条之上多报 1 条并点名到那一行，' +
      '实际共报 ' + brokenRes.length + ' 条、落在该行 ' + brokenOnRow + ' 条 —— ' +
      '批次 34 实测 §9 因此掉了 37 行，而这一族此前没有任何东西替它数过');
    return;
  }

  pass('公开文档表格列数一致（' + res.files + ' 份 .md 逐行按 GFM 切法与表头同格；十二格阴性对照按名字逐格复算' +
    ' + 拿 README 正文真表三刀各恰好多报 1 条：第一/二刀（多加一格、行尾竖线外续句子）落在 README.md:' +
    (firstTable + 3) + '，第三刀（摘掉行首竖线）落在 README.md:' + (twoRow + 3) + '）');
}

// ---------------------------------------------------------------------------
// 26. src/page/README.md 里逐段抄的「N 行 / M 方法」快照要对得上实际
// ---------------------------------------------------------------------------
// 那份 README 是每个域「几行、几个方法」的唯一人读入口，而它**手抄**片段头部。
// 2026-11-14 实测 16 段**全过期**（`50-captcha.js` 文档写 478 行 / 14 方法，实际 1008 行 / 27 方法），
// 一条测试都没红 —— 头部由第 15 项核着是对的，抄下来的旧值没有任何东西对它。
// 「有错地图比没地图更糟」（AGENTS §3 第 4 条）在这里的代价是：读的人照「478 行」去找代码，
// 翻到两倍大的文件，还以为文档在骗他。
//
// ⚠️ 期望在**这里**各写一份，不照抄 `audit.selfTestCases()` 的 want（同第 24 / 25 项的规矩：
// 照抄的话，把 want 改成实际值就能让这条闸永远绿）。十格里「要报」占七格，
// 因为本项最危险的坏法是**静默跳过**：快照行换个分隔符、片段目录换路径、合计句改写 ——
// 任何一种都让"没核到"长得像"核过了"。干净那一格是防误报的对照
// （会误报的守卫和没有守卫一样害人）。
function checkSliceStatsDoc() {
  var audit;
  try {
    audit = require('./audit-slice-stats.js');
  } catch (e) {
    fail('片段快照审计加载失败：' + String((e && e.message) || e));
    return;
  }

  var WANT = {
    '干净快照全部对得上': { want: 0, needle: '' },
    '某段行数写错': { want: 1, needle: '行数写' },
    '某段方法数写少': { want: 1, needle: '方法数写' },
    '凭空加一格没人核的状态字段': { want: 1, needle: '片段头部没声明这份清单' },
    '状态字段数写错': { want: 1, needle: '状态字段写' },
    '整段快照被删掉': { want: 1, needle: 'README 没有这一段的快照行' },
    '多写一段不存在的文件': { want: 1, needle: '但 src/page/ 里没有这个文件' },
    '快照行形状不认识': { want: 1, needle: '形状不认识' },
    '合计句的方法总数写错': { want: 1, needle: '合计句：app 方法写' },
    '真 README 对真片段': { want: 0, needle: '' }
  };

  var stats, cases, bad = [];
  try {
    stats = audit.sliceStats(path.join(ROOT, 'src', 'page'));
    cases = audit.selfTestCases();
  } catch (e2) {
    fail('片段快照审计自证跑不起来：' + String((e2 && e2.message) || e2));
    return;
  }

  // ---- 审计读的是不是这一个目录（路径常量写错时它会安静地数出一堆 0）----
  var realFiles = fs.readdirSync(path.join(ROOT, 'src', 'page'))
    .filter(function (f) { return /\.js$/.test(f); });
  if (stats.length !== realFiles.length) {
    fail('片段快照审计只看到 ' + stats.length + ' 个片段，src/page/ 实际有 ' + realFiles.length +
      ' 个 .js —— 它扫的目录或口径和真源脱节，报的「一致」不可信');
    return;
  }
  if (stats.some(function (s) { return !(s.lines > 0); })) {
    fail('片段快照审计算出的行数里有 0 —— 读取失败被当成空片段，结论不可信');
    return;
  }

  // ---- 十格期望：按 pin 逐格复算，格数本身也要恰好一一对应 ----
  var names = Object.keys(WANT);
  cases.forEach(function (c) {
    if (names.indexOf(c.pin) < 0) bad.push('多出一格没登记在 check.js 的期望表里：' + c.pin);
  });
  names.forEach(function (name) {
    var hit = cases.filter(function (c) { return c.pin === name; });
    if (hit.length !== 1) {
      bad.push(name + '：这一格应当恰好 1 个，实际 ' + hit.length + ' 个（对照格被删掉或重复了）');
      return;
    }
    var got;
    try {
      got = audit.audit(stats, hit[0].txt);
    } catch (e3) {
      bad.push(name + '：复算时审计抛了 ' + String((e3 && e3.message) || e3));
      return;
    }
    if (got.length !== WANT[name].want) {
      bad.push(name + '：应报 ' + WANT[name].want + ' 条，审计给出 ' + got.length + ' 条' +
        (got.length ? '（' + got.slice(0, 3).join('；') + '）' : ''));
      return;
    }
    if (WANT[name].needle && !got.some(function (x) { return x.indexOf(WANT[name].needle) !== -1; })) {
      bad.push(name + '：报出的 ' + got.length + ' 条里没有点名「' + WANT[name].needle + '」 —— ' +
        '红在别处等于这一格没测到');
    }
  });
  if (bad.length) {
    fail('片段快照审计的十格阴性对照不成立（会误报或抓不住的守卫比没有守卫更害人）：\n      ' +
      bad.join('\n      '));
    return;
  }

  // ---- 真文档：先点名，再谈反向验证（否则真坏那一段会被下面的增量抢掉）----
  var readme;
  try {
    readme = fs.readFileSync(path.join(ROOT, 'src', 'page', 'README.md'), 'utf8');
  } catch (e4) {
    fail('片段快照审计读不到 src/page/README.md：' + String((e4 && e4.message) || e4));
    return;
  }
  var realIssues = audit.audit(stats, readme);
  if (realIssues.length) {
    fail('src/page/README.md 的快照数字与实际对不上（' + realIssues.length + ' 处，改文档别改判据）：\n      ' +
      realIssues.join('\n      '));
    return;
  }

  // ---- 反向验证打在**整份真 README** 上、判据用**增量** ----
  // 只测合成夹具的话，"审计只对短夹具有效、对几百行的真文档失效"照样报 0 条。
  var rl = readme.split(/\r?\n/);
  var target = -1, targetFile = '';
  for (var i = 0; i + 1 < rl.length; i++) {
    var hm = /^### `([^`]+\.js)`\s*$/.exec(rl[i]);
    if (!hm || rl[i + 1].trim() !== '') continue;
    var sm = /^\*(\d+) 行/.exec(rl[i + 2]);
    if (sm) { target = i + 2; targetFile = hm[1]; break; }
  }
  if (target < 0) {
    fail('片段快照审计在 src/page/README.md 里认不出任何一段「标题 + 快照」—— ' +
      '它报的「一致」不可信，怀疑扫描口径与真实文档脱节');
    return;
  }
  var poisoned = rl.slice(0);
  poisoned[target] = poisoned[target].replace(/^\*(\d+) 行/, function (_m, n) {
    return '*' + (Number(n) + 1) + ' 行';
  });
  if (poisoned[target] === rl[target]) {
    fail('片段快照审计的反向验证没跑成：那一行（src/page/README.md:' + (target + 1) +
      '）改成 +1 行后字面没变，注入等于没注入');
    return;
  }
  var before = audit.audit(stats, readme).length;
  var after = audit.audit(stats, poisoned.join('\n')).length;
  if (after !== before + 1 ||
      !audit.audit(stats, poisoned.join('\n')).some(function (x) { return x.indexOf(targetFile) === 0; })) {
    fail('片段快照审计的反向验证没过：把 src/page/README.md:' + (target + 1) + '（' + targetFile +
      '）的行数 +1，应在原本的 ' + before + ' 条之上多报恰好 1 条并点名 ' + targetFile +
      '，实际共报 ' + after + ' 条 —— 这条闸对真实文档失效，它报的「一致」不可信');
    return;
  }
  pass('src/page/README.md 快照与实际一致（' + stats.length + ' 个片段：行数 + 方法数 + 状态字段数 + 合计句；' +
    '十格阴性对照按 pin 逐格复算 + 拿真 README 把 ' + targetFile +
    ' 的行数 +1 恰好多报 1 条，src/page/README.md:' + (target + 1) + '）');
}

// ---------------------------------------------------------------------------
// 27. 说明书教的界面字样 == 代码真实会显示的那几个字
// ---------------------------------------------------------------------------
// 为什么要这一条（2026-11-14，批次 56）：说明书图 3 那块状态面板画的是
// 「运行中 / 当前任务：播放视频 / 进度：2.1 节 / 共 8 节 / 最近事件：answer filled 10/10」，
// 后两行面板上**根本没有**，第一行也不是徽标那一格的字（徽标只会说
// 正常运行 / 等待中 / 注意 / 异常运行）；弹窗那格同理，真实字样是「已开启 / 未开启」，
// 源码注释自己就写着"写成运行中就是骗人"。这类过期**一条测试都不会红**：
// 界面照常工作，只有新手照说明书去认界面时被引到错方向。
//
// ⚠️ 期望在**这里**各写一份，不照抄 `audit.selfTestCases()` 的 want（同第 24 / 25 / 26 项的规矩：
// 照抄的话，把 want 改成实际值就能让这条闸永远绿）。十四格里「要报」占十一格，因为本项最危险的
// 坏法是**读不出来却装作核过了**：锚点失效 → 0 个取值 → "全部命中"。
// 三格「不报」是防误报的对照（干净正文、被 `<b>` 加粗切开的字样）——
// 会误报的守卫和没有守卫一样害人。
//
// 批次 129 接进第四份真源（弹窗里 20 枚开关的名字）时，同批加了两格：
// 「开关名漏教一枚」抓文档漂移，「开关配对只读出几枚」抓**口径失效后静默缩范围**
// —— 后者是这一族唯一会"读成核过了"的坏法（配对口径一坏，20 枚变 3 枚，文档照样一条不红）。
function checkManualUiLabels() {
  var audit;
  try {
    audit = require('./audit-manual-ui-labels.js');
  } catch (e) {
    fail('界面字样审计加载失败：' + String((e && e.message) || e));
    return;
  }

  var WANT = {
    '干净说明书每个字样都点名': { want: 0, needle: '' },
    '少写一个徽标词': { want: 1, needle: '等待中' },
    '字样只活在注释里': { want: 1, needle: '正常运行' },
    '字样被块级标签切开': { want: 1, needle: '正常运行' },
    '字样被行内标签加粗': { want: 0, needle: '' },
    '取值表一条都没读出': { want: 1, needle: '取值真源读不出来' },
    '真源只读出一半': { want: 1, needle: '取值真源读不出来' },
    'script 里的字样不算教给用户': { want: 1, needle: '未开启' },
    '少写一个任务种类词': { want: 1, needle: '测验答题' },
    '种类表漏一个键': { want: 1, needle: '没有中文取值' },
    '开关名漏教一枚': { want: 1, needle: '已完成任务重学' },
    '开关配对只读出几枚': { want: 1, needle: '取值真源读不出来' },
    '分段开关只教了一半': { want: 1, needle: '精简' },
    '真说明书对真代码': { want: 0, needle: '' }
  };

  var info, cases, bad = [];
  try {
    info = audit.readUiLabels(ROOT);
    cases = audit.selfTestCases();
  } catch (e2) {
    fail('界面字样审计自证跑不起来：' + String((e2 && e2.message) || e2));
    return;
  }

  // ---- 审计读的是不是那**四**份真源（锚点写错时它会安静地交出一份空清单）----
  if (!info.labels.length && !info.readErrors.length) {
    fail('界面字样审计交出「0 个取值 + 0 条读取错误」—— 这条闸等于不存在，报的「一致」不可信');
    return;
  }
  var fromContent = info.labels.filter(function (l) {
    return l.from.indexOf('content.js setStatusPanel') === 0;
  }).length;
  var fromPopup = info.labels.filter(function (l) { return l.from.indexOf('popup/popup.js') === 0; }).length;
  var fromKind = info.labels.filter(function (l) { return l.from.indexOf('jobKindLabel') !== -1; }).length;
  var fromSwitch = info.labels.filter(function (l) { return !!l.switchKey; }).length;
  if (info.labels.length && (!fromContent || !fromPopup || !fromKind || !fromSwitch)) {
    fail('界面字样审计只读出 徽标 ' + fromContent + ' 个 / popup 顶部 ' + fromPopup +
      ' 个 / 任务种类 ' + fromKind + ' 个 / 弹窗开关 ' + fromSwitch +
      ' 个取值 —— 四份真源必须各出一半，否则「核过了」是假的');
    return;
  }
  if (!info.kinds || info.kinds.length < 2) {
    fail('界面字样审计：任务种类键只读出 ' + ((info.kinds || []).length) + ' 个（真源 src/page/60-tasks-detect.js）—— ' +
      '键清单空了等于「种类表漏键」那一格从来没跑过');
    return;
  }
  // 开关这一族的"一枚都没漏"要单独对：配对口径（label for ↔ id + role="switch"）若认不出
  // 某枚没有 label 的开关，上面那几个计数照样非 0，而漏掉的那一枚**永远不会被要求进说明书**。
  var switchTags = 0, popupHtmlTxt = '';
  try {
    popupHtmlTxt = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
    switchTags = (popupHtmlTxt.match(/role="switch"/g) || []).length;
  } catch (e5) {
    fail('界面字样审计读不到 popup/popup.html 的开关总数：' + String((e5 && e5.message) || e5));
    return;
  }
  if (!switchTags) {
    fail('popup/popup.html 里一个 role="switch" 都数不到 —— 弹窗改成别的控件形状了，' +
      '第 27 项的开关这一族要跟着改口径，不许静默当"没有开关要核"');
    return;
  }
  if (switchTags !== (info.switchIds || []).length) {
    fail('弹窗开关数对不上：popup/popup.html 里 role="switch" 有 ' + switchTags + ' 处，' +
      '而审计只数出 ' + (info.switchIds || []).length + ' 枚带 id 的开关 —— ' +
      '多出来的那些要么没有 id（对不上界面字样），要么控件形状换了（批次 129 的量是 21 处 = 21 枚）');
    return;
  }
  if (!info.labels.some(function (l) { return l.switchKey === 'modeSwitch'; })) {
    fail('审计没读出顶部那枚「精简 / 精美」分段开关身上的字 —— 它没有 label，' +
      '字在自己那两个 span 里；这一族漏掉 = 界面上有的字说明书永远不必教，闸少一族');
    return;
  }
  // 反向的那半：**输入框 / 下拉的 label 不许混进开关这一族**，否则这一条闸会要求
  // 说明书逐个教到"API URL""模型名"那一族字段名 —— 那不是会显示的状态字，是一片误报。
  var notSwitch = ['discussionReply', 'apiUrl', 'model'].filter(function (k) {
    return (popupHtmlTxt.match(new RegExp('<label\\s[^>]*for="' + k + '"', 'g')) || []).length > 0;
  });
  var leaked = (info.switches || []).filter(function (s) { return notSwitch.indexOf(s.key) !== -1; });
  if (leaked.length) {
    fail('界面字样审计把非开关的 label 当成开关了：' + leaked.map(function (s) { return s.key; }).join(' / ') +
      '（它们是输入框 / 下拉，不是 role="switch"）—— 这一族放宽就等于开始误报');
    return;
  }

  // ---- 真文档先点名（放在十四格之前）----
  // 文档漂移是这一项最常见的坏法，人看到的应当是「哪个字样在说明书里不见了」，
  // 而不是「第几格期望数字不符」—— 后者把真正的原因塞在括号里第三句。
  var manualTxt;
  try {
    manualTxt = fs.readFileSync(path.join(ROOT, 'docs', 'manual.html'), 'utf8');
  } catch (e4) {
    fail('界面字样审计读不到 docs/manual.html：' + String((e4 && e4.message) || e4));
    return;
  }
  var realIssues = audit.audit(info, manualTxt);
  if (realIssues.length) {
    fail('docs/manual.html 教的界面字样和真实界面不一致（' + realIssues.length +
      ' 处，改文档别改判据）：\n      ' + realIssues.join('\n      '));
    return;
  }

  // ---- 十四格期望：按 pin 逐格复算，格数本身也要恰好一一对应 ----
  var names = Object.keys(WANT);
  cases.forEach(function (c) {
    if (names.indexOf(c.pin) < 0) bad.push('多出一格没登记在 check.js 的期望表里：' + c.pin);
  });
  names.forEach(function (name) {
    var hit = cases.filter(function (c) { return c.pin === name; });
    if (hit.length !== 1) {
      bad.push(name + '：这一格应当恰好 1 个，实际 ' + hit.length + ' 个（对照格被删掉或重复了）');
      return;
    }
    var got;
    try {
      got = audit.audit(hit[0].labelInfo, hit[0].txt);
    } catch (e3) {
      bad.push(name + '：复算时审计抛了 ' + String((e3 && e3.message) || e3));
      return;
    }
    if (got.length !== WANT[name].want) {
      bad.push(name + '：应报 ' + WANT[name].want + ' 条，审计给出 ' + got.length + ' 条' +
        (got.length ? '（' + got.slice(0, 3).join('；') + '）' : ''));
      return;
    }
    if (WANT[name].needle && !got.some(function (x) { return x.indexOf(WANT[name].needle) !== -1; })) {
      bad.push(name + '：报出的 ' + got.length + ' 条里没有点名「' + WANT[name].needle + '」 —— ' +
        '红在别处等于这一格没测到');
    }
  });
  if (bad.length) {
    fail('界面字样审计的十四格阴性对照不成立（会误报或抓不住的守卫比没有守卫更害人）：\n      ' +
      bad.join('\n      '));
    return;
  }

  // ---- 反向验证打在**整份真说明书**上、判据用**增量**，且**三份取值表各摘一次** ----
  // 只测合成夹具的话，"审计只对短夹具有效、对几千行的真说明书失效"照样报 0 条。
  // 只摘徽标那一份的话，"任务种类词这一族对真说明书失效"又没人看得见（批次 57 新接的就是这一族）；
  // 批次 129 接的弹窗开关这一族同理 —— 三族各自承重，少一族就少一条路。
  var vtext = audit.visibleText(manualTxt);
  var before = audit.audit(info, manualTxt).length;
  var AXES = [
    { name: '状态徽标 / 弹窗顶部字样', pool: info.labels.filter(function (l) { return !l.kindKey && !l.switchKey; }) },
    { name: '面板第二行任务种类词', pool: info.labels.filter(function (l) { return !!l.kindKey; }) },
    { name: '弹窗里每一枚开关的名字', pool: info.labels.filter(function (l) { return !!l.switchKey; }) }
  ];
  var poisonedNames = [];
  for (var ai = 0; ai < AXES.length; ai++) {
    var ax = AXES[ai];
    var skipped = [];
    var hit = null;
    for (var pi = 0; pi < ax.pool.length; pi++) {
      var cand = ax.pool[pi];
      if (vtext.indexOf(cand.text) === -1) continue;
      // 摘一条不许连带摘掉别的取值：两个词互相包含时一次注入会多报一条，看着像"注入越界"
      var collide = info.labels.some(function (o) {
        return o !== cand && (o.text.indexOf(cand.text) !== -1 || cand.text.indexOf(o.text) !== -1);
      });
      if (collide) { skipped.push('「' + cand.text + '」与别的取值互相包含'); continue; }
      var poisoned = manualTxt.split(cand.text).join('〔字样被摘掉〕');
      if (poisoned === manualTxt) { skipped.push('「' + cand.text + '」摘不动（字面没变）'); continue; }
      // ⚠️ 批次 57 踩过的那族假绿：原文摘干净了，可见正文里**别处**又拼出同一个词。
      if (audit.visibleText(poisoned).indexOf(cand.text) !== -1) {
        skipped.push('「' + cand.text + '」摘完可见正文里还剩（别处拼得出来）');
        continue;
      }
      var afterIssues = audit.audit(info, poisoned);
      if (afterIssues.length !== before + 1 ||
          !afterIssues.some(function (x) { return x.indexOf('「' + cand.text + '」') !== -1; })) {
        skipped.push('「' + cand.text + '」摘完报 ' + afterIssues.length + ' 条（要 ' + (before + 1) + '）');
        continue;
      }
      hit = cand;
      break;
    }
    if (!hit) {
      fail('界面字样审计的反向验证没过（' + ax.name + '）：这一族 ' + ax.pool.length +
        ' 个取值里没有任何一个能"摘掉后恰好多报 1 条并点名它"（原本 ' + before + ' 条）。' +
        '逐条原因：' + (skipped.slice(0, 4).join('；') || '这一族在真说明书里一个都没命中') +
        ' —— 要么这条闸对该族失效，要么说明书里这一族的字样全互相包着；两种都得改文档/口径，别改判据');
      return;
    }
    poisonedNames.push('「' + hit.text + '」');
  }
  pass('docs/manual.html 教的界面字样与代码一致（' + info.labels.length + ' 个真实取值：' +
    'content.js 徽标 ' + fromContent + ' 个 + popup 顶部 ' + fromPopup + ' 个 + 任务种类 ' + fromKind +
    ' 个 + 弹窗开关 ' + fromSwitch + ' 个（与 role="switch" 计数逐枚对上）；' +
    '键对账覆盖 src/page/60-tasks-detect.js 读出的 ' + info.kinds.length + ' 种；' +
    '十四格阴性对照按 pin 逐格复算 + 拿真说明书把' + poisonedNames.join(' / ') +
    ' 全部摘掉各恰好多报 1 条）');
}

// ---------------------------------------------------------------------------
// 28. e2e 里「拼成字符串、再交给页面执行」的脚本必须能解析（任务 #139）
//
// 要拦的是这一族：`client.evaluate('(function(){…' + '…})()')` 里的 JS **源码本身合法**
// —— 那只是几个字符串字面量，`node --check` 全绿、集成测试全绿、
// 上一项（夹具 HTML 可解析）也全绿（它只管 MOCK_PAGES 那批 HTML）。
// 错在**字符串的内容**，所以只有把内容折出来再解析一次才量得到。
//
// 批次 87 实测撞过：换课场景里那一串少写一个右花括号，一路跑到真实 Edge 才报
// 「页面抛异常: SyntaxError」—— 不带文件行号，人得从场景名反推是哪一串。
// 这一项把它压成秒级静态闸。
//
// ⚠️ 覆盖面必须一起钉：只钉「红几条」的话，守卫整个认不出调用点也会报「0 条问题」，
//    那是 AGENTS §5 第四类假绿最干净的形状。所以自证里每格都要求 `checked` 计数，
//    真文件跑之前还有一道「折叠解析条数不许塌到地板以下」的闸。
// ---------------------------------------------------------------------------
function checkE2eExprParsable() {
  var guard;
  try {
    guard = require('./e2e-expr-guard.js');
  } catch (e) {
    fail('页面脚本串守卫加载失败：' + String((e && e.message) || e));
    return;
  }

  // ---- 阴性对照：期望数字在**这里**各写一份，不照抄守卫自带的 selfTest ----
  // 第 1 格证明它会响；第 2 格证明它不把「函数体片段」当错（`return 1` 按脚本解析必红，
  // 而那是合法内容 —— 会误报的守卫和没有守卫一样害人）；
  // 第 3 格证明含变量的实参**不计入已检查**；第 4 格证明注释与字符串里的调用点不算。
  var CASES = [
    {
      name: '少一个右花括号必报', src: "c.evaluate('(function(){try{x();}catch(e){});');",
      problems: 1, checked: 1, skipped: 0
    },
    {
      name: '函数体片段（顶层 return）不许误报', src: "c.evaluate('return document.hidden;');",
      problems: 0, checked: 1, skipped: 0
    },
    {
      name: '含变量只计 skipped（不许冒充已检查）', src: "c.evaluate('x=' + n + ';');",
      problems: 0, checked: 0, skipped: 1
    },
    {
      name: '注释里与字符串里的调用点都不算',
      src: "// c.evaluate('(function(){');\nvar s = 'c.evaluate(\"(function(){\");';",
      problems: 0, checked: 0, skipped: 0
    },
    {
      name: 'waitFor 认第二个实参（坏串要响）', src: "waitFor(c, '(function(){return 1);');",
      problems: 1, checked: 1, skipped: 0
    }
  ];
  var bad = [];
  CASES.forEach(function (t) {
    var r;
    try { r = guard.scan(t.src, '阴性对照/' + t.name); }
    catch (e2) { bad.push(t.name + '：探测本身抛了 ' + String((e2 && e2.message) || e2)); return; }
    if (r.problems.length !== t.problems) bad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + r.problems.length + ' 条');
    if (r.checked !== t.checked) bad.push(t.name + '：应计入"已折叠解析" ' + t.checked + ' 条，实际 ' + r.checked + ' 条');
    if (r.skipped !== t.skipped) bad.push(t.name + '：应计入"跳过" ' + t.skipped + ' 条，实际 ' + r.skipped + ' 条');
  });
  if (bad.length) {
    fail('页面脚本串守卫的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }

  // ---- 扫真文件 ----
  var FILES = ['tools/browser-e2e.js', 'tools/integration-test.js'];
  var total = 0;
  var checked = 0;
  var skipped = 0;
  var found = [];
  FILES.forEach(function (f) {
    var r = guard.scan(read(f), f);
    total += r.total;
    checked += r.checked;
    skipped += r.skipped;
    r.problems.forEach(function (p) { found.push({ file: f, line: p.line, why: p.why, head: p.head }); });
  });

  // 地板：写这份守卫时实测 total 743 / 折叠解析 515（integration-test.js 那 7 处全是
  // 变量实参，本来就折叠不出唯一内容）。**取整千以下的松地板** —— 将来把某段串改成
  // `runIn(client, function(){…})`（内容由 node --check 保证，比这一族更强）
  // 会让计数往下走，那是好事，不该被这道闸拦住；而"调用点一个都认不出"必须拦住。
  if (total < 500) {
    fail('页面脚本串守卫的入口识别塌了：只认到 ' + total + ' 处 `.evaluate(`/`waitFor(`（写这份闸时 743 处）。' +
      '\n      多半是扫描器本身认不出调用点了 —— 它报「0 条问题」时并没有在检查任何东西');
    return;
  }
  if (checked < 300) {
    fail('页面脚本串守卫的覆盖面塌了：' + total + ' 处入口里只折叠出 ' + checked + ' 条纯字面串（写这份闸时 515 条）。' +
      '\n      覆盖面下降要说清原因并一起改这里的地板，别让它静默变成"什么都没查"');
    return;
  }
  if (found.length) {
    fail('e2e 里有页面脚本串解析不了（跑起来就是「页面抛异常: SyntaxError」，且不带行号）：\n      ' +
      found.map(function (p) {
        return p.file + ':' + p.line + ' —— ' + p.why + '\n        串开头：' + p.head;
      }).join('\n      '));
    return;
  }
  pass('e2e 页面脚本串可解析（' + FILES.join(' + ') + '：' + total + ' 处入口，折叠解析 ' + checked +
    ' 条纯字面串，' + skipped + ' 条含变量/模板串由真函数 toString() 保证；含 5 格阴性对照）');
}

// ---------------------------------------------------------------------------
// 29. 「只能在电脑浏览器里用」这一口径在四处说同一件事（任务 #116 / 批次 70）
// ---------------------------------------------------------------------------
// 为什么要有它（批次 66/67 连着两轮留下、一直没人钉的一条）：这一族断言散在
// **四个地方**（说明书封面那块红框、§7 排查表「装了也开着却什么都没发生」那一行、
// §9.2 已知限制清单那一行、README 封面警示）。把其中任何一处的「客户端和手机装不了」
// 或「看有没有地址栏」删掉，**集成测试、真实浏览器测试、上一项那条语法闸一条都不会红** ——
// 只有照着一份过期门面去装的新用户会发现：他装进了学习通客户端，那里根本没有扩展。
// 第 27 项管的是"界面字样说明书教没教"，管不到这类**方向性断言**，所以另开一项。
//
// ⚠️ 期望数字在**这里**各写一份，不照抄 `audit-browser-only.js --selftest` 的 want
//    （同第 24~28 项的规矩：照抄的话，把 want 改成实际值就能让这条闸永远绿）。
//    六格里「要报」占五格，因为本项最危险的坏法是**位置认不出却报「0 条问题」**：
//    锚点失效 → 四处缩成三处 → "该在的都在"。所以每一格都同时钉 `checked` 恒为 4。
// ---------------------------------------------------------------------------
function checkBrowserOnlyClaim() {
  var audit;
  try {
    audit = require('./audit-browser-only.js');
  } catch (e) {
    fail('装机口径审计加载失败：' + String((e && e.message) || e));
    return;
  }
  var M = 'docs/manual.html';
  var R = 'README.md';
  var clean;
  try { clean = audit.cleanFixture(); }
  catch (e0) { fail('装机口径审计的干净夹具造不出来：' + String((e0 && e0.message) || e0)); return; }

  var CASES = [
    { name: '四处都写全必不报', files: clean, problems: 0, needle: '' },
    {
      name: '封面漏掉「电脑浏览器」必报',
      files: audit.mutate(clean, M, '只能装在电脑浏览器里', '装在别的软件里'),
      problems: 1, needle: '正向声明'
    },
    {
      name: '排查表漏掉「地址栏」判据必报',
      files: audit.mutate(clean, M, '看有没有地址栏', '看是不是网页'),
      problems: 1, needle: '有没有地址栏'
    },
    {
      name: '域名只写在注释里必报（注释用户在页面上看不见）',
      files: audit.mutate(clean, M, '有没有一条能输网址的地址栏，里面带着 chaoxing.com。',
        '有没有一条能输网址的地址栏。<!-- 里面带着 chaoxing.com。 -->'),
      problems: 1, needle: 'chaoxing.com'
    },
    {
      name: '整处被改写得认不出要说「锚点找不到」，不许报 0 条',
      files: audit.mutate(clean, M, '<tr><td>装了、也开着，可学习通里什么都没发生</td>', '<tr><td>另一件事</td>'),
      problems: 1, needle: '起始锚点找不到'
    },
    {
      name: 'README 整个没读进来也要响',
      files: (function () { var f = {}; f[M] = clean[M]; return f; })(),
      problems: 1, needle: '没读进来'
    }
  ];

  var bad = [];
  var N = audit.LOCATIONS.length;
  CASES.forEach(function (t) {
    var res;
    try { res = audit.audit(t.files); }
    catch (e2) { bad.push(t.name + '：审计本身抛了 ' + String((e2 && e2.message) || e2)); return; }
    if (res.issues.length !== t.problems) {
      bad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.issues.length + ' 条 ' +
        JSON.stringify(res.issues.slice(0, 3)));
    } else if (t.needle && !res.issues.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      bad.push(t.name + '：报了 ' + res.issues.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
    // 认不出某一处时**不许把那一处从账上抹掉** —— 覆盖数恒为 4 才说明"少了"会被看见
    if (res.checked !== N) bad.push(t.name + '：位置数应恒为 ' + N + '，实际 ' + res.checked);
  });
  if (bad.length) {
    fail('装机口径审计的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }

  var real = audit.audit(audit.readFiles(ROOT));
  if (real.checked !== N) {
    fail('装机口径审计只核到 ' + real.checked + ' 处位置（判据里写了 ' + N + ' 处）——' +
      '\n      有一处的锚点认不出，这条闸正在"少查一处还打印全绿"');
    return;
  }
  if (real.issues.length) {
    fail('「只能在电脑浏览器里用」这一口径在 ' + real.issues.length + ' 处断了：\n      ' +
      real.issues.join('\n      ') +
      '\n      改法：把缺的那句话写回**那一处**的可见正文，别改判据迁就现状');
    return;
  }
  pass('装机口径四处一致（' + N + ' 处位置逐处点名 × ' + real.families + ' 族字样，' +
    '说明书封面 / §7 / §9.2 / README 门面全部传达；含 5 格阴性对照）');
}

// 30. 换课上限那个数字：文档写的必须就是代码里的那一个
//     批次 85 把 8 提到 30、批次 86 再改成按用户中心课数取大，可 Release 页与说明书
//     到批次 93 收尾还写着「最多换 8 门」—— 判据、日志、沙盒全绿，只有用户看得见那一页是错的。
function checkSwitchBudgetClaim() {
  var audit = require('./audit-switch-budget.js');
  var limit;
  try {
    limit = audit.limitFromSource();
  } catch (e) {
    fail('换课上限对账读不出代码真源：' + ((e && e.message) || e) +
      '\n      真源是 ' + audit.SOURCE + ' 里的 `_COURSE_SWITCH_LIMIT`；常量改名要连这条闸一起改');
    return;
  }
  var clean = audit.cleanFixture();
  var CASES = [
    { name: '干净夹具（数字全对 + 围栏与注释里的错数不算）', files: clean, problems: 0 },
    {
      name: '三处文档退回旧的 8 门要红',
      files: audit.mutate(clean, '最少 30 门', '最少 8 门'),
      problems: 3, needle: '不一致'
    },
    {
      name: 'README 那句写歪要红并点名文件',
      files: audit.mutate(clean, '最多 30 门', '最多 8 门'),
      problems: 1, needle: 'README.md'
    },
    {
      // 这一格防的是"正则被改坏 → 一条扫不到 → 打印全绿"
      name: '整套文档一句都不提时要响（不许当成没东西要核）',
      files: { 'README.md': '这里不提门数。\n', 'HANDOVER.md': '这里也不提。\n' },
      problems: 1, needle: '只在 0 个文件'
    },
    {
      name: '代码侧没读到数字要响（不许当成没东西要核）',
      files: clean,
      limitOverride: 0, problems: 1, needle: '代码侧的换课上限没读到'
    },
    {
      // 批次 97 撞出来的真红：探针那一族「一轮最多问 40 门」句式与本族只差一个「问」字，
      // 旧口径把它读成换课上限，四份写对了的文档各挨一条**根本不存在的**承诺不符。
      // 期望写在 check.js 里，与审计自带的那一格各算各的（口径同第 24 项的九格）。
      name: '探针那一族「一轮最多问 40 门」不许被抓成换课上限（跨族阴性对照）',
      files: Object.assign({}, clean, {
        'README.md': '- 一轮连续刷课**最多换 30 门**；换课前那一读一轮最多问 40 门。\n'
      }),
      problems: 0, claims: 4, needle: ''
    }
  ];
  var bad = [];
  CASES.forEach(function (t) {
    var res;
    try {
      res = audit.audit({ docs: t.files, limit: ('limitOverride' in t) ? t.limitOverride : limit });
    } catch (e2) {
      bad.push(t.name + '：审计本身抛了 ' + String((e2 && e2.message) || e2));
      return;
    }
    if (res.problems.length !== t.problems) {
      bad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.problems.length + ' 条 ' +
        JSON.stringify(res.problems.slice(0, 3)));
    } else if ('claims' in t && res.claims.length !== t.claims) {
      // 「0 条问题」有两种：都对上了，与**压根没扫到**。所以这一格除了要求不报，还要求命中数照旧
      bad.push(t.name + '：问题 0 条，但命中 ' + res.claims.length + ' 处（期望 ' + t.claims +
        ' 处）—— 少了是扫描失效，多了是把别人的句式也抓进来了');
    } else if (t.needle && !res.problems.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      bad.push(t.name + '：报了 ' + res.problems.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
  });
  // 掩码不许是空操作，也不许改变行数／列宽：围栏与 HTML 注释里的错数必须真被挖掉，
  // 而报出来的行号与原文对得上（否则夹具第一条就是假绿）
  function checkMaskShape(label, raw, isHtml, visibleLine, sink) {
    var bad2 = sink || bad;
    var masked = audit.maskInvisible(raw, isHtml);
    var a = raw.split('\n');
    var b = masked.split('\n');
    if (a.length !== b.length) {
      bad2.push(label + '：掩码后行数变了（' + a.length + ' → ' + b.length + '），报出来的行号会对不上原文');
      return;
    }
    for (var i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) {
        bad2.push(label + '：第 ' + (i + 1) + ' 行掩码后长度 ' + b[i].length + '，原文 ' + a[i].length + '（列位置要保住）');
      }
      if (i === visibleLine) continue;
      if (/[0-9]/.test(b[i])) bad2.push(label + '：第 ' + (i + 1) + ' 行的数字没被挖掉 —— 掩码没生效，那是用户看不见的地方');
    }
  }
  checkMaskShape('围栏代码块', '```\n最多 8 门\n```\n', false, 3);
  checkMaskShape('HTML 注释与 script',
    '<p>最少 30 门</p>\n<!-- 最少 8 门 -->\n<script>a="最少 5 门";</script>\n', true, 0);
  if (bad.length) {
    fail('换课上限对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }

  var docs = {};
  var missing = [];
  audit.DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = fs.readFileSync(p, 'utf8');
    else missing.push(f);
  });
  var real = audit.audit({ docs: docs, limit: limit });
  if (missing.length) {
    fail('换课上限对账有 ' + missing.length + ' 份文档没读进来：' + missing.join(' / ') +
      '\n      文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  if (real.problems.length) {
    fail('换课上限对账有 ' + real.problems.length + ' 条要说：\n      ' + real.problems.join('\n      ') +
      '\n      改法：把文档那一处改成 `_COURSE_SWITCH_LIMIT` 现在写的数（' + limit + '），别改判据迁就现状；' +
      '\n      CHANGELOG 里的历史条目**按史实不扫**，也不要顺手回改');
    return;
  }
  pass('换课上限文档对账（代码 ' + limit + ' 门；文档 ' + real.claims.length + ' 处逐个相等，' +
    '分布在 ' + new Set(real.claims.map(function (c) { return c.file; })).size + ' 份；含 6 格阴性对照（其中一格是跨族不许误报）+ 2 格掩码形状自证）');

  // ---- 第 30 项的**第二把尺**：倍速问价「一支最多问三发」（会话任务 #209 / 批次 151）----
  //   同一族漂移的形状在 2026-11-21 实测到"文档 7 处、代码 1 处、**尺 0 条**"：批次 146 改了那一族的行为、
  //   批次 150 给它补了十三格集成断言，而那十三格核的是代码内部，用户看得见的那句「三发」没人对着真源比。
  //   **这一族不新开项号**（口径同批次 148）：项数是 `tools/README.md` 与台账里手抄的数，多一项要动一串文档，
  //   而这一族本来就该和"承诺的数字要有尺"那一条闸住在一起。
  //   ⚠️ 当年那句「不新增第 36 项」里的 36 号**已被批次 160 用掉**（联网搜索开关对账，另一族），
  //   本条尺照旧并在这第 30 项里，不因此挪窝。
  var rate, rateLimit;
  try {
    rate = require('./audit-rate-ask-claims.js');
  } catch (e3) {
    fail('倍速问价对账加载失败：' + String((e3 && e3.message) || e3) +
      '\n      真源是 tools/audit-rate-ask-claims.js —— 它被改名或删除时，这一半闸会**静默消失**');
    return;
  }
  if (rate.maskInvisible !== audit.maskInvisible) {
    fail('倍速问价与换课上限**各写了一份掩码**（判据同第 31 项）：\n      ' +
      '两处各一份，改一处另一处会静默过期 —— "围栏／注释／script 里用户看不见"这个口径只许有一个真源');
    return;
  }
  try {
    rateLimit = rate.askBudgetFromSource();
  } catch (e4) {
    fail('倍速问价对账读不出代码真源：' + String((e4 && e4.message) || e4) +
      '\n      真源是 ' + rate.SOURCE + ' 里 `this._rateUnknownTries < <整数>` 那一行；那一族改名要连这条闸一起改');
    return;
  }
  var rclean = rate.cleanFixture();
  var RCASES = [
    { name: '干净夹具（数字全对 + 围栏与注释与 script 里的错数不算）', files: rclean, problems: 0, claims: 7 },
    {
      name: '说明书与台账退成「二发」要红，且只有那几处红',
      files: rate.mutate(rclean, '连问三发', '连问二发'),
      problems: 5, needle: '不一致'
    },
    {
      name: 'README 那两处改成「四发」要红并点名文件',
      files: rate.mutate(rclean, '最多问三发', '最多问四发'),
      problems: 2, needle: 'README.md'
    },
    {
      // 这一格防的是"正则被改坏 → 一条扫不到 → 打印全绿"
      name: '整套文档一句都不提时要响（不许当成没东西要核）',
      files: { 'README.md': '这里不提发数。\n', 'HANDOVER.md': '这里也不提。\n' },
      problems: 1, needle: '只在 0 个文件'
    },
    {
      name: '代码侧没读到数字要响（不许当成没东西要核）',
      files: rclean, budgetOverride: 0, problems: 1, needle: '代码侧的问价上限没读到'
    },
    {
      // 这一格钉的是**引导词那一半在承重**：本尺第一版只要求「问 + 数字 + 发」，
      // 当场把 README:113「同一道最多问 6 发」（弹题预算，真源是 2×「最多问几次」）抓成一条**根本不存在的**假红。
      // 夹具里故意写 9（≠ 代码的 3）：引导词那一半一旦松开，命中数与红条数会**同时**越界，这一格当场红。
      name: '弹题那一族「同一道最多问 9 发」不许被抓成倍速问价（跨族阴性对照，实测的那条假红）',
      files: {
        'README.md': '- 同一道最多问 9 发（= 3×「最多问几次」，弹题的账）。\n- 一支最多问三发。\n',
        'HANDOVER.md': '弹题那一族：同一节里同一道最多问 9 发，到顶就本地选。\n倍速问不到连问三发才收手。\n'
      },
      problems: 0, claims: 2, needle: ''
    },
    {
      name: '探针那一族「一轮最多问 40 门」不许被抓（与第 31 项互不越界）',
      files: {
        'README.md': '- 换课前那一读一轮最多问 40 门；一支最多问三发。\n',
        'HANDOVER.md': '那一读最多问 40 门；倍速问不到连问三发才收手。\n'
      },
      problems: 0, claims: 2, needle: ''
    }
  ];
  var rbad = [];
  RCASES.forEach(function (t) {
    var res;
    try {
      res = rate.audit({ docs: t.files, budget: ('budgetOverride' in t) ? t.budgetOverride : rateLimit });
    } catch (e5) {
      rbad.push(t.name + '：审计本身抛了 ' + String((e5 && e5.message) || e5));
      return;
    }
    if (res.problems.length !== t.problems) {
      rbad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.problems.length + ' 条 ' +
        JSON.stringify(res.problems.slice(0, 3)));
    } else if ('claims' in t && res.claims.length !== t.claims) {
      // 「0 条问题」有两种：都对上了，与**压根没扫到**；「没越界」也有两种：排掉了，与正则坏了
      rbad.push(t.name + '：问题 ' + t.problems + ' 条对得上，但命中 ' + res.claims.length +
        ' 处（期望 ' + t.claims + ' 处）—— 少了是扫描失效，多了是把别人的句式也抓进来了');
    } else if (t.needle && !res.problems.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      rbad.push(t.name + '：报了 ' + res.problems.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
  });
  checkMaskShape('倍速问价 - HTML 注释与 script',
    '<p>一支最多问三发</p>\n<!-- 一支最多问八发 -->\n<script>a="连问 5 发";</script>\n', true, 0, rbad);
  if (rbad.length) {
    fail('倍速问价对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + rbad.join('\n      '));
    return;
  }
  var rdocs = {};
  var rmissing = [];
  rate.DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) rdocs[f] = fs.readFileSync(p, 'utf8');
    else rmissing.push(f);
  });
  var rreal = rate.audit({ docs: rdocs, budget: rateLimit });
  if (rmissing.length) {
    fail('倍速问价对账有 ' + rmissing.length + ' 份文档没读进来：' + rmissing.join(' / ') +
      '\n      文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  if (rreal.problems.length) {
    fail('倍速问价对账有 ' + rreal.problems.length + ' 条要说：\n      ' + rreal.problems.join('\n      ') +
      '\n      改法：把文档那一处改成 `_rateUnknownTries <` 现在写的数（' + rateLimit + '），别改判据迁就现状；' +
      '\n      弹题那一族「同一道最多问 N 发」是**另一把尺**（真源不同），别把它塞进这一族');
    return;
  }
  // 工具自带的那批逐格对照**在这里真跑一次**，不当"另由人手跑"的承诺：
  // 那批格子改坏了、被删了，只靠"`node tools/xxx.js --selftest` 记得跑"就等于没有（口径同第 33 / 34 项）。
  // 格数从它自己打印的那一行读回来 —— 不许在 check.js 或文档里手抄一个数当判据（批次 142 那一族）。
  var rateSelfCells = null;
  var rateSelfErr = null;
  for (var rattempt = 0; rattempt < 2; rattempt++) {
    var rr = spawnSync(process.execPath,
      [path.join(__dirname, 'audit-rate-ask-claims.js'), '--selftest'],
      { encoding: 'utf8', timeout: 60000 });
    rateSelfErr = rr.error || null;
    if (!rr.error || rr.error.code === 'ETIMEDOUT') {   // 只有"起不来"值得重试
      if (rr.status !== 0) {
        rateSelfErr = new Error('退出码 ' + rr.status + '，末行=' +
          JSON.stringify(String(rr.stdout || '').trim().split(/\r?\n/).pop()));
      } else {
        var rmc = String(rr.stdout || '').match(/自证通过（共 (\d+) 格）/);
        if (!rmc) {
          rateSelfErr = new Error('没打印那句「自证通过（共 N 格）」，末行=' +
            JSON.stringify(String(rr.stdout || '').trim().split(/\r?\n/).pop()));
        } else rateSelfCells = Number(rmc[1]);
      }
      break;
    }
  }
  if (rateSelfErr) {
    fail('倍速问价的逐格对照没跑成或本身是红的：' + String(rateSelfErr) +
      '\n      读不出当失败，不许因为"文档那 7 处都对上了"就打印通过');
    return;
  }
  if (rateSelfCells < 13) {
    fail('倍速问价的逐格对照只报了 ' + rateSelfCells + ' 格（下限 13）—— ' +
      '有格被跳过或删掉时，"全绿"这两个字就没有内容；跨族阴性对照那两格（弹题的「道…发」、探针的「问…门」）尤其承重');
    return;
  }
  pass('倍速问价发数文档对账（代码 ' + rateLimit + ' 发；文档 ' + rreal.claims.length + ' 处逐个相等，' +
    '分布在 ' + new Set(rreal.claims.map(function (c) { return c.file; })).size + ' 份；' +
    '含 7 格夹具对照（其中两格是跨族不许误报：弹题的「道…发」与探针的「问…门」）+ 1 格掩码形状自证；' +
    '工具自带 ' + rateSelfCells + ' 格逐格对照当场真跑过，格数由它自己打印的那一行读回来）');

  // ---- 第 30 项的**第三把尺**：弹题问价「放手 3 次 / 预算 6 发」（会话任务 #205 剩下的那半 / 批次 157）----
  //   第二把尺的头注里欠着这一句：「⚠️ 弹题那一族到现在也还没有尺……要立就走第 30/31 项那一套"两把尺各自排除对头"」——
  //   同一族漂移第三次出现：批次 85/86 换课上限、批次 146/150 倍速问价、这一族。
  //   与倍速那把**不同真源**（`popupQuizMaxAttempts` 与 `_getPopupQuizMaxAttempts()) * 2`），所以两把尺互斥而不是合并：
  //   合并的结果是每一句都被另一族的数顶红（第一版真的这样咬过 README:113，见第二把尺头注那条实测假红）。
  //   **这一族同样不新开项号**（口径同批次 148）：项数是 `tools/README.md` 与台账里手抄的数，多一项要动一串文档。
  //   ⚠️ 当年那句「仍然不新增第 36 项」里的 36 号**已被批次 160 用掉**（联网搜索开关对账，另一族），
  //   本条尺照旧并在这第 30 项里。
  var quiz, quizA, quizMult;
  try {
    quiz = require('./audit-quiz-ask-claims.js');
  } catch (q1) {
    fail('弹题问价对账加载失败：' + String((q1 && q1.message) || q1) +
      '\n      真源是 tools/audit-quiz-ask-claims.js —— 它被改名或删除时，这半把闸会**静默消失**');
    return;
  }
  if (quiz.maskInvisible !== audit.maskInvisible || quiz.maskInvisible !== rate.maskInvisible) {
    fail('弹题问价与前两把尺**各写了一份掩码**（判据同第 31 项）：\n      ' +
      '三处各一份，改一处另一处会静默过期 —— "围栏／注释／script 里用户看不见"这个口径只许有一个真源');
    return;
  }
  try {
    quizA = quiz.giveupFromSource();
    quizMult = quiz.multiplierFromSource();
  } catch (q2) {
    fail('弹题问价对账读不出代码真源：' + String((q2 && q2.message) || q2) +
      '\n      真源是 ' + quiz.GIVEUP_SOURCE + ' 的 `popupQuizMaxAttempts: <整数>,` 与 '
      + quiz.BUDGET_SOURCE + ' 的 `_getPopupQuizMaxAttempts()) * <整数>`；常量改名要连这条闸一起改');
    return;
  }
  var qclean = quiz.cleanFixture();
  // 「凡是写 6 的句子全部要红」那一格的预期条数**从夹具自己读回来**，不在这里手抄
  // （§5：断言里出现的每一个数都要说得出它是从哪儿量回来的 —— 手拍的条数正是批次 111 那一族）
  var qCleanRes = quiz.audit({ docs: qclean, giveup: quizA, multiplier: quizMult });
  var qSix = qCleanRes.claims.filter(function (c) { return c.value === 6; }).length;
  var QCASES = [
    {
      // 八句夹具**逐字抄自只读探针量回来的真文档形状**（README×4 / HANDOVER×1 / Release 说明×2 / 说明书×1）
      name: '干净夹具（八句真形状 + 围栏与注释与 script 里的错数不算）',
      files: qclean, problems: 0, claims: 8
    },
    {
      name: '放手档那句写成预算档的数要红，并点名「次数与真源不一致」',
      files: quiz.mutate(qclean, '认不出的最多问 3 次', '认不出的最多问 6 次'),
      problems: 1, needle: '次数与真源不一致'
    },
    {
      name: '预算档那句写成放手档的数要红，并说出 `3 × 2 = 6`',
      files: quiz.mutate(qclean, '同一道最多 6 发，到顶本地选', '同一道最多 3 发，到顶本地选'),
      problems: 1, needle: '3 × 2 = 6'
    },
    {
      // 这一格钉的是**两档各自由不同常数承重**：倍率一旦漂，全部写 6 的句子过期；
      // 条数不写死 —— 期望等于夹具里写 6 的处数（§5：那个数不许是我拍的，要从盘上读回来）
      name: '倍率由 2 改成 3（预算档=9）时，凡是写 6 的句子全部要红，写 3 的一处不许误报',
      files: qclean, giveupOverride: 3, multOverride: 3,
      problems: qSix,
      needle: '3 × 3 = 9'
    },
    {
      name: '整套文档一句都不提时要响（不许当成没东西要核）',
      files: { 'README.md': '这里不提发数。\n', 'HANDOVER.md': '这里也不提。\n' },
      problems: 1, needle: '只在 0 个文件'
    },
    {
      name: '代码侧两档没读到要响，且不许"只比另一个"',
      files: qclean, giveupOverride: 0, multOverride: 2, problems: 1, needle: '没读到'
    },
    {
      // 跨族阴性对照第一格：**这一格正是第二把尺头注里那条实测假红的镜像** ——
      // 少了弹题引导词，倍速那句「一支最多问三发」会被这一族抓成弹题承诺（反之亦然）
      name: '倍速那一族「一支最多问三发」不许被抓成弹题问价（跨族不许误报）', xfamily: true,
      files: {
        'README.md': '| **自动倍速** | 一支最多问三发，仍问不到就按原速播完这一支 |\n'
          + '- 同一道最多问 6 发，到顶之后本地选。\n',
        'HANDOVER.md': '倍速问不到连问三发才按原速播完。\n- 这一道最多 6 发，到顶本地选。\n'
      },
      problems: 0, claims: 2, allValue: 6
    },
    {
      name: '探针那一族「一轮最多问 40 门」与倍速那一族都不许被抓（与第 31 项互不越界）', xfamily: true,
      files: {
        'README.md': '- 换课前那一读一轮最多问 40 门、单页最多 12 秒。\n- 这一道最多问 3 次就放手。\n',
        'HANDOVER.md': '那一读最多问 40 门（第 31 项的账）。\n- 同一道最多 6 发，到顶之后本地选。\n'
      },
      problems: 0, claims: 2
    },
    {
      // 这一格钉的是"引导词 + 算符紧贴数字"**两半各自**挡掉的 41 处宽口径命中（实测 49 宽 / 8 窄）——
      // 最后那句「这一道问明白是 3 次」只有**算符不许隔字**那一半能排掉，前几句只有**引导词距离**那一半能排掉
      name: '量词与别的预算族「重问一次模型」「问了不止一遍」「付了两次」「最多三次」「问明白是 3 次」不许被读成数字承诺',
      files: {
        'README.md': '- 弹题请求没有去重，每 250ms 一轮就重问一次模型；同一道最多问 6 发，到顶之后本地选。\n',
        'HANDOVER.md': '问了不止一遍，钱付了两次；这一道最多问 3 次就放手。\n'
          + '还是救不回来才最多等 2 分钟放手，试过最多三次。\n'
          + '这一道问明白是 3 次就放手。\n'
      },
      problems: 0, claims: 2
    },
    {
      // 反向的另一半：**没有引导词**的那两句也不许抓 —— 这一格一旦红，说明尺被放宽成"什么都抓"的会误报的守卫
      name: '脱离弹题语境的「最多问 6 发」「最多问 3 次」不许被抓（引导词那一半单独承重）',
      files: { 'README.md': '- 最多问 6 发，到顶之后本地选。\n', 'HANDOVER.md': '- 最多问 3 次就放手。\n' },
      problems: 1, claims: 0, needle: '只在 0 个文件'
    }
  ];
  var qbad = [];
  QCASES.forEach(function (t) {
    var res;
    try {
      res = quiz.audit({
        docs: t.files,
        giveup: ('giveupOverride' in t) ? t.giveupOverride : quizA,
        multiplier: ('multOverride' in t) ? t.multOverride : quizMult
      });
    } catch (q3) {
      qbad.push(t.name + '：审计本身抛了 ' + String((q3 && q3.message) || q3));
      return;
    }
    if (res.problems.length !== t.problems) {
      qbad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.problems.length + ' 条 ' +
        JSON.stringify(res.problems.slice(0, 3)));
    } else if ('claims' in t && res.claims.length !== t.claims) {
      // 「0 条问题」有两种：都对上了，与**压根没扫到**；「没越界」也有两种：排掉了，与正则坏了
      qbad.push(t.name + '：问题 ' + t.problems + ' 条对得上，但命中 ' + res.claims.length +
        ' 处（期望 ' + t.claims + ' 处）—— 少了是扫描失效，多了是把别人的句式也抓进来了');
    } else if (t.allValue && !res.claims.every(function (c) { return c.value === t.allValue; })) {
      qbad.push(t.name + '：命中里混进了不是 ' + t.allValue + ' 的句子 —— 跨族那句被抓进来了：'
        + JSON.stringify(res.claims.map(function (c) { return c.text; })));
    } else if (t.needle && !res.problems.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      qbad.push(t.name + '：报了 ' + res.problems.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
  });
  checkMaskShape('弹题问价 - HTML 注释与 script',
    '<p>同一道最多问 3 次</p>\n<!-- 同一道最多问 8 次，就放手 -->\n'
    + '<script>a="这一道最多问 7 次，就放手";</script>\n', true, 0, qbad);
  if (qbad.length) {
    fail('弹题问价对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + qbad.join('\n      '));
    return;
  }
  var qdocs = {};
  var qmissing = [];
  quiz.DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) qdocs[f] = fs.readFileSync(p, 'utf8');
    else qmissing.push(f);
  });
  var qreal = quiz.audit({ docs: qdocs, giveup: quizA, multiplier: quizMult });
  if (qmissing.length) {
    fail('弹题问价对账有 ' + qmissing.length + ' 份文档没读进来：' + qmissing.join(' / ') +
      '\n      文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  if (qreal.problems.length) {
    fail('弹题问价对账有 ' + qreal.problems.length + ' 条要说：\n      ' + qreal.problems.join('\n      ') +
      '\n      改法：把文档那一处改成代码现在的数（放手 ' + quizA + ' 次、预算 ' + quizA * quizMult
      + ' 发），别改判据迁就现状；倍速那一族「一支最多问 N 发」是上面那把尺，真源不同，别合并');
    return;
  }
  var quizSelfCells = null;
  var quizSelfErr = null;
  for (var qattempt = 0; qattempt < 2; qattempt++) {
    var qr = spawnSync(process.execPath,
      [path.join(__dirname, 'audit-quiz-ask-claims.js'), '--selftest'],
      { encoding: 'utf8', timeout: 60000 });
    quizSelfErr = qr.error || null;
    if (!qr.error || qr.error.code === 'ETIMEDOUT') {   // 只有"起不来"值得重试
      if (qr.status !== 0) {
        quizSelfErr = new Error('退出码 ' + qr.status + '，末行=' +
          JSON.stringify(String(qr.stdout || '').trim().split(/\r?\n/).pop()));
      } else {
        var qmc = String(qr.stdout || '').match(/自证通过（共 (\d+) 格）/);
        if (!qmc) {
          quizSelfErr = new Error('没打印那句「自证通过（共 N 格）」，末行=' +
            JSON.stringify(String(qr.stdout || '').trim().split(/\r?\n/).pop()));
        } else quizSelfCells = Number(qmc[1]);
      }
      break;
    }
  }
  if (quizSelfErr) {
    fail('弹题问价的逐格对照没跑成或本身是红的：' + String(quizSelfErr) +
      '\n      读不出当失败，不许因为"文档那 8 处都对上了"就打印通过');
    return;
  }
  if (quizSelfCells < 14) {
    fail('弹题问价的逐格对照只报了 ' + quizSelfCells + ' 格（下限 14）—— ' +
      '有格被跳过或删掉时，"全绿"这两个字就没有内容；三格跨族阴性对照（倍速的「支…发」、探针的「问…门」、量词的「一次／两次」）' +
      '与两格"真源各读不出"尤其承重');
    return;
  }
  pass('弹题问价发数文档对账（代码放手 ' + quizA + ' 次 × 倍率 ' + quizMult + ' = 预算 ' + quizA * quizMult +
    ' 发；文档 ' + qreal.claims.length + ' 处逐个对上，分布在 ' +
    new Set(qreal.claims.map(function (c) { return c.file; })).size + ' 份，其中分不出档的 ' + qreal.unclassified +
    ' 处按两档之一核；含 ' + QCASES.length + ' 格夹具对照（其中 '
    + QCASES.filter(function (t) { return t.xfamily; }).length + ' 格是跨族不许误报）+ 1 格掩码形状自证；' +
    '工具自带 ' + quizSelfCells + ' 格逐格对照当场真跑过，格数由它自己打印的那一行读回来）');

  // ---- 第 30 项的**第四把尺**：夹具表那句「全表 N 页」（会话任务 #187）----
  //   同一族漂移第四次：批次 85/86 换课上限、批次 146/150 倍速问价、批次 157 弹题问价、这一族。
  //   本轮立尺当场量到两处真漂移：① `HANDOVER.md:1586` 还停在批次 48 那一刻的「71 页」（现 100），
  //   ② `MOCK_PAGES` 里 `/mycourse/studentstudy` **被写了两遍**（批次 89 那份空白页 vs 批次 9-A 那份讨论诱饵），
  //   对象字面量后写的静默覆盖先写的 —— 文本键数 100、运行时 99，而批次 89 那一场的前提断言在诱饵形状上
  //   恰好也成立，所以**一条测试都不红**：它自 11-17 起就没真被端上来过。这一格数的是这一族。
  //   **同样不新开项号**（口径同批次 148）：项数是 `tools/README.md` 与台账里手抄的数，多一项要动一串文档。
  // ⚠️ 下限写在常数里，**句子里那句「下限 N」也从同一个常数读** ——
  //    以前这里比较用 14、散文里也手写 14，抬下限时漏改散文就得到一句自相矛盾的红话。
  var FX_SELF_MIN_CELLS = 14;
  var fx, fxSrc;
  try {
    fx = require('./audit-fixture-pages.js');
  } catch (f1) {
    fail('夹具页数对账加载失败：' + String((f1 && f1.message) || f1) +
      '\n      真源是 tools/audit-fixture-pages.js —— 它被改名或删除时，这半把闸会**静默消失**');
    return;
  }
  if (fx.maskInvisible !== audit.maskInvisible || fx.maskInvisible !== rate.maskInvisible
    || fx.maskInvisible !== quiz.maskInvisible) {
    fail('夹具页数与前三把尺**各写了一份掩码**（判据同第 31 项）：\n      ' +
      '四处各一份，改一处另一处会静默过期 —— "围栏／注释／script 里用户看不见"这个口径只许有一个真源');
    return;
  }
  try {
    fxSrc = fx.pagesFromSource();
  } catch (f2) {
    fail('夹具页数对账读不出代码真源：' + String((f2 && f2.message) || f2) +
      '\n      真源是 ' + fx.SOURCE + ' 里顶格的 `var MOCK_PAGES = { … };` 那一段；那一段换名或缩进要连这条闸一起改');
    return;
  }
  var fclean = fx.cleanFixture();
  var FCASES = [
    { name: '干净夹具（四句真形状 + 说明书页数／N 页面／中文数字／场景数四族诱饵都不算）', files: fclean, problems: 0, claims: 4 },
    {
      name: '台账那句退成「71 页夹具」（本轮实测的真漂移）要红，并点名「不一致」',
      files: fx.mutate(fclean, '全表扫（99 页夹具，不起浏览器', '全表扫（71 页夹具，不起浏览器'),
      problems: 1, needle: '不一致'
    },
    {
      name: '另一形状「全表 120 页」要红 —— 两种句式各自承重',
      files: fx.mutate(fclean, '全表 99 页', '全表 120 页'),
      problems: 1, needle: '全表 120 页'
    },
    {
      name: '整套文档一句都不提时要响（不许当成没东西要核）',
      files: { 'README.md': '这里不提页数。\n', 'HANDOVER.md': '这里也不提。\n' },
      problems: 1, needle: '只在 0 个文件'
    },
    {
      name: '代码侧没读到页数要响，且不许"只比文档"',
      files: fclean, pagesOverride: 0, problems: 1, needle: '没读到'
    },
    {
      // 跨族阴性对照：说明书页数那一族真句子（README.md:712 实测形状）
      name: '说明书 PDF 的「40 页」「31 页」与「5 页面」「一页夹具」不许被抓成夹具页数', xfamily: true,
      files: {
        'README.md': '| `使用说明.pdf` | 40 页，含界面示意 |\n- 覆盖了 5 页面；两代各自一页夹具。\n',
        'HANDOVER.md': '本机已 `npm run manual` 重出（31 页，新表体里旧句 0 处）。\n'
      },
      problems: 1, claims: 0, needle: '只在 0 个文件'
    }
  ];
  var fbad = [];
  FCASES.forEach(function (t) {
    var res;
    try {
      res = fx.audit({
        docs: t.files,
        // 对照表用**夹具自己那份常数**（夹具句子与它自洽），真文档那一轮才用盘上的真读数 ——
        // 否则夹具涨一页，这张表会整张变成"预期红几条"对不上，而红的是尺自己。
        pages: ('pagesOverride' in t) ? t.pagesOverride : fx.CLEAN_PAGES
      });
    } catch (f3) {
      fbad.push(t.name + '：审计本身抛了 ' + String((f3 && f3.message) || f3));
      return;
    }
    if (res.problems.length !== t.problems) {
      fbad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.problems.length + ' 条 ' +
        JSON.stringify(res.problems.slice(0, 3)));
    } else if ('claims' in t && res.claims.length !== t.claims) {
      fbad.push(t.name + '：问题 ' + t.problems + ' 条对得上，但命中 ' + res.claims.length +
        ' 处（期望 ' + t.claims + ' 处）—— 少了是扫描失效，多了是把别人的句式也抓进来了');
    } else if (t.needle && !res.problems.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      fbad.push(t.name + '：报了 ' + res.problems.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
  });
  // 第 4 个实参是**允许留数字的那一行行号**（可见正文那一行），不是"预期几条"：
  // 这一段全在围栏里，所以传 -1 —— 一旦围栏没被挖干净，数字会当场把它点名。
  checkMaskShape('夹具页数 - 围栏代码块里的错数不算',
    '正文一句都不提。\n```\n全表 99 页\n99 页夹具\n```\n', false, -1, fbad);
  if (fbad.length) {
    fail('夹具页数对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + fbad.join('\n      '));
    return;
  }
  if (fxSrc.dups.length) {
    fail('夹具表里有被静默覆盖的重复键：\n      ' + fxSrc.dups.map(function (d) {
      return '「' + d.key + '」写了 ' + d.lines.length + ' 次（第 ' + d.lines.join(' / ') + ' 行）';
    }).join('\n      ') + '\n      文本键数 ' + fxSrc.textual + '、运行时只有 ' + fxSrc.pages +
      ' 页 —— 后一份盖掉前一份，改前一份的人会得到一句"夹具改了"而盘上一个字没变；' +
      '\n      两份形状都要能端上来时**给其中一份换一个路径名**（`_isStudyCourseHref` 认的是前缀，尾巴可以加），别共键');
    return;
  }
  var fdocs = {};
  var fmissing = [];
  fx.DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) fdocs[f] = fs.readFileSync(p, 'utf8');
    else fmissing.push(f);
  });
  if (fmissing.length) {
    fail('夹具页数对账有 ' + fmissing.length + ' 份文档没读进来：' + fmissing.join(' / ') +
      '\n      文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  var freal = fx.audit({ docs: fdocs, pages: fxSrc.pages });
  if (freal.problems.length) {
    fail('夹具页数对账有 ' + freal.problems.length + ' 条要说：\n      ' + freal.problems.join('\n      ') +
      '\n      改法：把文档那一处改成 MOCK_PAGES 现在的去重键数（' + fxSrc.pages + ' 页），别改判据迁就现状；' +
      '\n      历史那句要留就照「现数 + 当时是几页」写，引述旧数不带「页夹具／全表 N 页」的形状才出得了界');
    return;
  }
  var fxSelfCells = null;
  var fxSelfErr = null;
  for (var fattempt = 0; fattempt < 2; fattempt++) {
    var fr = spawnSync(process.execPath,
      [path.join(__dirname, 'audit-fixture-pages.js'), '--selftest'],
      { encoding: 'utf8', timeout: 60000 });
    fxSelfErr = fr.error || null;
    if (!fr.error || fr.error.code === 'ETIMEDOUT') {   // 只有"起不来"值得重试
      if (fr.status !== 0) {
        fxSelfErr = new Error('退出码 ' + fr.status + '，末行=' +
          JSON.stringify(String(fr.stdout || '').trim().split(/\r?\n/).pop()));
      } else {
        var fmc = String(fr.stdout || '').match(/自证通过（共 (\d+) 格）/);
        if (!fmc) {
          fxSelfErr = new Error('没打印那句「自证通过（共 N 格）」，末行=' +
            JSON.stringify(String(fr.stdout || '').trim().split(/\r?\n/).pop()));
        } else fxSelfCells = Number(fmc[1]);
      }
      break;
    }
  }
  if (fxSelfErr) {
    fail('夹具页数的逐格对照没跑成或本身是红的：' + String(fxSelfErr) +
      '\n      读不出当失败，不许因为"文档那 4 处都对上了"就打印通过');
    return;
  }
  if (fxSelfCells < FX_SELF_MIN_CELLS) {
    fail('夹具页数的逐格对照只报了 ' + fxSelfCells + ' 格（下限 ' + FX_SELF_MIN_CELLS + '）—— ' +
      '有格被跳过或删掉时，"全绿"这两个字就没有内容；四格里"解析器契约"（重复键点名、块读不到要抛、' +
      '自报接线断了两格）尤其承重 —— 真源读错时整套对账都是空的');
    return;
  }
  pass('夹具页数文档对账（代码 MOCK_PAGES 去重 ' + fxSrc.pages + ' 页、文本键数 ' + fxSrc.textual +
    ' 无重复；文档 ' + freal.claims.length + ' 处逐个对上，分布在 ' +
    new Set(freal.claims.map(function (c) { return c.file; })).size + ' 份；含 ' + FCASES.length +
    ' 格夹具对照（其中 ' + FCASES.filter(function (t) { return t.xfamily; }).length + ' 格是跨族不许误报）' +
    ' + 1 格掩码形状自证；工具自带 ' + fxSelfCells + ' 格逐格对照当场真跑过，格数由它自己打印的那一行读回来）');
}

// 31. 换课前"问一轮课程首页进度"承诺的那几个数字：文档写的必须就是代码里的那九个
//     批次 97 一轮加出九个常量（40 门 / 12 秒 / 20 秒 / 34 秒 / 36 秒 / 24 秒 / 8 秒 / 45 秒 / 30 分钟），
//     其中四个直接对用户承诺了"可能要等多久"。第 30 项管的是换课**上限**那一族，这一项管**这一读**那一族 ——
//     同一族教训：代码改了而用户看得见的页没改，判据、日志、沙盒全绿，只有被引到错方向的人知道。
function checkCourseProbeClaims() {
  var audit;
  try {
    audit = require('./audit-course-probe-claims.js');
  } catch (e) {
    fail('探针数字对账加载失败：' + String((e && e.message) || e));
    return;
  }
  var consts;
  try {
    consts = audit.constsFromSource();
  } catch (e2) {
    fail('探针数字对账读不出代码真源：' + ((e2 && e2.message) || e2) +
      '\n      真源是 ' + audit.SOURCES.join(' / ') + ' 里的 `COURSE_PROBE_*`；常量改名要连这条闸一起改');
    return;
  }
  // ⚠️ 掩码那一手**只许有一份**：探针这一族故意复用批次 94 的 `maskInvisible`。
  //    两处各写一份的话，改一处另一处静默过期 —— 正是本件要防的那类事，所以在这里钉住"是同一个函数"，
  //    形状自证（围栏 / HTML 注释 / script 挖空且行号列位不动）由第 30 项那一格承重。
  var budgetAudit = require('./audit-switch-budget.js');
  var bad = [];
  if (audit.maskInvisible !== budgetAudit.maskInvisible) {
    bad.push('探针对账自己另写了一份掩码 —— 第 30 项的掩码形状自证就此盖不住这一族，改一处另一处会静默过期');
  }

  // 下面这几格的期望条数**写在 check.js 里**，不吃审计自带的十三格自证：
  // 只改审计里的 `expect` 不能把这道闸蒙过去（口径同第 24 项自带九格期望表）。
  // ⚠️ 夹具与锚点的数字**一律从真源算**（`cleanFixture(consts)` + `rightValues(consts)`）——
  //    原先这里写死 24 / 34 / 40，于是批次 97 反向验证 E2 把代码里的 `COURSE_PROBE_ASK_MS`
  //    改成 35000 之后，**这几格自证先红**（"干净夹具"报了 2 条），而下面那句 `return`
  //    把真正该说的话「文档说 36 秒、真源是 35 秒」整个压在底下 —— 报的是**错的原因**：
  //    看起来像"守卫坏了"，真相是"守卫好好的、文档过期了"，而那正是这一项要抓的东西。
  var R = audit.rightValues(consts);
  var W = { defer: audit.wrongValue('defer', R), bridge: audit.wrongValue('bridge', R), limit: audit.wrongValue('limit', R) };
  var clean = audit.cleanFixture(consts);
  var CASES = [
    { name: '干净夹具（数字全对 + 围栏/注释/script 里的错数不算）', docs: clean, problems: 0, coverMin: 7 },
    {
      name: '「最多为它等」写成 ' + W.defer + ' 秒要红（夹具里三页各写了一次）',
      docs: audit.mutate(clean, '最多为它等 ' + R.defer + ' 秒', '最多为它等 ' + W.defer + ' 秒'),
      problems: 3, needle: 'defer'
    },
    {
      name: '桥那一头写成 ' + W.bridge + ' 秒要红并点名文件（说明书那一处；HANDOVER 那处带 ** 号，锚点照不到）',
      docs: audit.mutate(clean, '桥那一头 ' + R.bridge + ' 秒', '桥那一头 ' + W.bridge + ' 秒'),
      problems: 1, needle: 'docs/manual.html'
    },
    {
      name: '整套文档一句都不提时要响（不许当成没东西要核）',
      docs: { 'README.md': '这里不提数字。\n', 'HANDOVER.md': '这里也不提。\n' },
      problems: 3, needle: '只在 0 个文件'
    },
    {
      name: '句式被整体改写（把「最多问 ' + R.limit + ' 门」换成「最少 30 门」）要点名那句消失了',
      docs: audit.mutate(clean, '最多问 ' + R.limit + ' 门', '最少 30 门'),
      problems: 1, needle: '一句都没有'
    }
  ];
  CASES.forEach(function (t) {
    var res;
    try {
      res = audit.audit({ docs: t.docs, consts: consts });
    } catch (e3) {
      bad.push(t.name + '：审计本身抛了 ' + String((e3 && e3.message) || e3));
      return;
    }
    if (res.problems.length !== t.problems) {
      bad.push(t.name + '：应报 ' + t.problems + ' 条，实际 ' + res.problems.length + ' 条 ' +
        JSON.stringify(res.problems.slice(0, 2)));
    } else if (t.needle && !res.problems.some(function (x) { return x.indexOf(t.needle) !== -1; })) {
      bad.push(t.name + '：报了 ' + res.problems.length + ' 条，但没有一条点到「' + t.needle + '」');
    } else if (t.coverMin && res.claims.length < t.coverMin) {
      bad.push(t.name + '：只扫到 ' + res.claims.length + ' 处承诺（要 ≥' + t.coverMin +
        '）—— "0 问题"可能是空扫');
    }
  });
  // 代码侧少读一个常量不许降级成"那就不用核这一格"
  var halfConsts = {};
  Object.keys(consts).forEach(function (k) { if (k !== 'fresh') halfConsts[k] = consts[k]; });
  var halfRes = audit.audit({ docs: clean, consts: halfConsts });
  if (!halfRes.problems.some(function (p) { return p.indexOf('代码侧的探针常量有读不齐的') >= 0; })) {
    bad.push('把 fresh 那一格从真源里抽掉，审计没点名「常量有读不齐的」—— 读不出会被当成通过');
  }
  // 审计自带的十三格自证照跑（判据在审计里，期望另有一份在上面）；
  // ⚠️ 还要求**格数没被人删**：自证掉格只少打几行，谁都不会发现（AGENTS §5「名字里的清单要和谓词对应」）
  var sc = audit.selfCheck();
  if (!sc.ok) {
    bad.push('审计自带的自证有 ' + sc.bad.length + ' 格红：' + sc.bad.join('；').slice(0, 400));
  }
  if (Number(sc.total) !== 13) {
    bad.push('审计自带的自证是 ' + sc.total + ' 格，而文档（HANDOVER 批次 97 那一行 / 本件那句 [ok]）' +
      '承诺的是 13 格 —— 自证格子被删了要连文档一起改');
  }
  if (bad.length) {
    fail('探针数字对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }

  var docs = {};
  var missing = [];
  audit.DOCS.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) docs[f] = fs.readFileSync(p, 'utf8');
    else missing.push(f);
  });
  if (missing.length) {
    fail('探针数字对账有 ' + missing.length + ' 份文档没读进来：' + missing.join(' / ') +
      '\n      文件被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  var real = audit.audit({ docs: docs, consts: consts });
  if (real.problems.length) {
    fail('探针数字对账有 ' + real.problems.length + ' 条要说：\n      ' + real.problems.join('\n      ') +
      '\n      改法：把文档那一处改成真源现在的数（一轮 ' + consts.limit + ' 门 · 单页 ' + consts.fetch +
      ' 秒 · 整轮 ' + consts.budget + ' 秒 · 桥 ' + consts.bridge + ' 秒 · 页面 ' + consts.ask +
      ' 秒 · 为它等 ' + consts.defer + ' 秒 · ' + consts.fresh + ' 分钟不重问），别改判据迁就现状；' +
      '\n      CHANGELOG 里的历史条目**按史实不扫**，也不要顺手回改');
    return;
  }
  pass('探针数字文档对账（代码 ' + Object.keys(audit.CONSTANT_SPECS).length + ' 个常量：一轮 ' + consts.limit +
    ' 门 / 整轮 ' + consts.budget + ' 秒 / 桥 ' + consts.bridge + ' 秒 / 页面 ' + consts.ask + ' 秒 / 为它等 ' +
    consts.defer + ' 秒；文档 ' + real.claims.length + ' 处逐个相等，分布在 ' +
    new Set(real.claims.map(function (c) { return c.file; })).size + ' 份；含 6 格阴性对照 + 审计自带 ' +
    sc.total + ' 格自证）');
}

// 32. 说明书 §7「日志里的字样」那张表教的字样 == 代码真发得出来的那一句
//     第 27 项只管**界面字样**（面板徽标 / 弹窗顶部 / 任务种类词），那张日志名表以前没有任何东西对着。
//     批次 117 实测抓到 3 处过期，其中 `quiz skipped: text stays garbled` 正是用户照着根本找不到的那种
//     （代码发的是 `quiz paused: …`，而 `quiz skipped:` 这个前缀下面另有真句子 —— 按前缀比会绿，所以比整句）。
function checkManualLogNames() {
  var audit;
  try {
    audit = require('./audit-manual-log-names.js');
  } catch (e) {
    fail('手册日志名对账加载失败：' + String((e && e.message) || e) +
      '\n      真源是 tools/audit-manual-log-names.js —— 它被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  var bad = [];

  // ⚠️ 期望表写在 check.js 里，不吃审计自带的那 23 格 selftest（口径同第 24 / 31 项）：
  //    只把审计里的期望改掉不能把这道闸蒙过去。
  var NAMES = [
    { name: 'quiz paused: text stays garbled', where: 'x', via: 'panel' },
    { name: 'quiz skipped: no question could be filled', where: 'x', via: 'panel' },
    { name: 'llm prefix cache', where: 'x', via: 'panel' },
    { name: 'course switch declined: auto switch is off', where: 'x', via: 'panel' },
    { name: 'block quiz submit because answers are not ready', where: 'x', via: 'panel' },
    { name: 'quiz answers count', where: 'x', via: 'console' },
    { name: 'start', where: 'x', via: 'panel' }
  ];
  // 走**真管道**：手册格在 `manualCells()` 里就被 `cellText()` 摘过 `[Omitone] ` 前缀，这里照抄那一手
  function cell(t) { return { row: 1, line: 1, text: audit.cellText(t) }; }
  var CASES = [
    { name: '整句对着真源 → 过', cells: [cell('quiz paused: text stays garbled')], checked: 1, red: 0 },
    { name: '同前缀换整句 → 必须红（按前缀比就是在这里漏的）',
      cells: [cell('quiz skipped: text stays garbled')], checked: 1, red: 1, needle: 'quiz skipped: text stays garbled' },
    { name: '真名 + 中文原因 → 过', cells: [cell('llm prefix cache: 整份输入还凑不满一块')], checked: 1, red: 0 },
    { name: '省略号族：真名开头过、编的名字红',
      cells: [cell('course switch declined: …'), cell('course switch faked: …')], checked: 2, red: 1, needle: 'course switch faked' },
    { name: '手册摘掉真名尾巴（answers are not ready）→ 过',
      cells: [cell('answers are not ready')], checked: 1, red: 0 },
    { name: 'F12 那一面（控制台字样带中括号）也算真源 → 过',
      cells: [cell('[Omitone] quiz answers count: N')], checked: 1, red: 0 },
    { name: '中文散文格不核对（会误报的守卫和没有守卫一样害人）',
      cells: [cell('倒计时结束 / 视频或课件播完')], checked: 0, red: 0 },
    { name: '短标签整格等于真名要核对；拼错的长名要红',
      cells: [cell('start'), cell('couse switch picked next')], checked: 2, red: 1, needle: 'couse' }
  ];
  CASES.forEach(function (t) {
    var res;
    try {
      res = audit.evaluate(t.cells, NAMES);
    } catch (e2) {
      bad.push(t.name + '：核对本身抛了 ' + String((e2 && e2.message) || e2));
      return;
    }
    if (res.checked !== t.checked) {
      bad.push(t.name + '：核到 ' + res.checked + ' 条，期望 ' + t.checked + ' 条（跳过了本该核的格，或把散文拖进来了）');
    }
    if (res.bad.length !== t.red) {
      bad.push(t.name + '：红 ' + res.bad.length + ' 条，期望 ' + t.red + ' 条 ' +
        JSON.stringify(res.bad.map(function (b) { return b.text; })));
    } else if (t.needle && !res.bad.some(function (b) { return b.text.indexOf(t.needle) >= 0; })) {
      bad.push(t.name + '：红了 ' + res.bad.length + ' 条，但没有一条点到「' + t.needle + '」');
    }
  });

  // 表形那一族：找不到表 / 只圈出三格，都必须交回 error，**不许读成"0 条 = 通过"**
  function tableHtml(rows, headerInTh) {
    return '<table><tr><th>字样</th><th>' + (headerInTh ? '日志里的字样' : '什么意思') + '</th></tr>' +
      rows.map(function (r) { return '<tr><td><code>' + r + '</code></td><td>说明</td></tr>'; }).join('\n') +
      '</table>';
  }
  var shape = [
    { name: '整页没有那张表', html: '<p>这里什么都没有</p>', wantError: true },
    { name: '有表头字样但圈不出 <table>', html: '<p>日志里的字样</p>', wantError: true },
    { name: '表只剩 3 格（判据 5：形状不对就 FATAL）', html: tableHtml(['quiz paused: text stays garbled', 'start', 'llm prefix cache'], true), wantError: true },
    { name: '合成表 11 格要能逐格取回', html: tableHtml(['start', 'quiz paused: text stays garbled'].concat(
      ['a one', 'a two', 'a three', 'a four', 'a five', 'a six', 'a seven', 'a eight', 'a nine']), true),
      wantError: false, cells: 11 }
  ];
  shape.forEach(function (s) {
    var got;
    try {
      got = audit.manualCells(s.html, s.wantError ? undefined : 10);
    } catch (e3) {
      bad.push(s.name + '：取表抛了 ' + String((e3 && e3.message) || e3));
      return;
    }
    if (s.wantError) {
      if (!got || !got.error) bad.push(s.name + '：表形坏了却没交回 error —— 这张表不再被核对，而闸门会打印"全部通过"');
    } else if (got.error) {
      bad.push(s.name + '：好好的表被报成形不对（' + got.error + '）');
    } else if (got.cells.length !== s.cells) {
      bad.push(s.name + '：取到 ' + got.cells.length + ' 格，期望 ' + s.cells + ' 格');
    }
  });

  // 审计自带的那 23 格也要跑，且**格数不许被人删**（自证掉格只少打几行，没人会发现）
  var SELFTEST_LINES = 23;
  var stOut = '';
  var stStatus = null;
  var stErr = null;
  var script = path.join(__dirname, 'audit-manual-log-names.js');
  for (var attempt = 0; attempt < 2; attempt++) {
    var r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 60000 });
    stErr = r.error || null;
    stOut = String(r.stdout || '');
    stStatus = r.status;
    if (!r.error || r.error.code === 'ETIMEDOUT') break;   // 只有"起不来"值得重试
  }
  if (stErr) {
    bad.push('日志名审计自带的自证没跑成' + (stErr.code === 'ETIMEDOUT' ? '（60 秒没返回）' : '（已重试一次）') +
      '：' + String(stErr));
  } else {
    var last = stOut.trim().split('\n').pop();
    if (stStatus !== 0 || last !== '[ok] 自检 ' + SELFTEST_LINES + ' 格全对') {
      bad.push('日志名审计自带的自证不是那句「' + SELFTEST_LINES + ' 格全对」（status=' + stStatus +
        '，末行=' + JSON.stringify(last) + '）—— 期望格被改/被删，先回头核审计，别改这里的数');
    }
  }

  // ---- 真表：手册那一页对着代码跑一遍 ----
  var reg = audit.emittedNames();
  var got = audit.manualCells();
  if (got.error) {
    fail('手册日志名对账读不出那张表：' + got.error +
      '\n      先修表形或修本工具，别当通过（这张表不再被核对时，闸门打印的"通过"是空的）');
    return;
  }
  var res = audit.evaluate(got.cells, reg.names);
  if (bad.length) {
    fail('手册日志名对账的阴性对照不成立（守卫失效比没有守卫更糟）：\n      ' + bad.join('\n      '));
    return;
  }
  if (!res.checked) {
    fail('手册日志名对账一条都没核到 —— 措辞被整体改写时扫描会静默变成 0 命中，那是最坏的一种绿（AGENTS §2 #21）');
    return;
  }
  // 表被整族删格时 checked 会掉，但"掉到多少"是浮动的：这里只钉一个明显低于现状的下限，实际数照印
  if (res.checked < 20) {
    fail('手册日志名对账只核到 ' + res.checked + ' 条（下限 20）—— 那张表被整族删格或改形时，' +
      '这一族用户照着找不到的字样就没人管了。要改的是手册，不是这把尺');
    return;
  }
  if (res.bad.length) {
    fail('说明书教了代码里从来不发的日志字样 ' + res.bad.length + ' 处：\n      ' +
      res.bad.map(function (b) {
        return 'docs/manual.html:' + b.line + '（表内第 ' + b.row + ' 行）: ' + b.text +
          (b.near.length ? ' —— 代码里同前缀的真名: ' + b.near.join(' / ') : ' —— 代码里连同前缀都没有');
      }).join('\n      ') +
      '\n      要改的是手册那一行，不是这把尺（AGENTS §4「要改文档，不许改判据」）');
    return;
  }
  pass('说明书日志名对账（表内 ' + res.checked + ' 条逐个对着代码里真发过的那一句；' +
    '真源 ' + reg.names.length + ' 条 = 面板 ' +
    reg.names.filter(function (n) { return n.via === 'panel'; }).length + ' / 控制台 ' +
    reg.names.filter(function (n) { return n.via === 'console'; }).length +
    '，另有 ' + reg.dynamic + ' 处名字整个拼自变量静态核不到；含 ' + CASES.length + ' 格合成表 + ' +
    shape.length + ' 格表形 FATAL + 审计自带 ' + SELFTEST_LINES + ' 格自证）');
}

// ---------------------------------------------------------------------------
// 33. 临时测试浏览器的 profile 跑完就清（真源 tools/clean-e2e-profiles.js）
//     实测 %TEMP% 里攒了 106 枚 Edge 用户目录 / 10.2 GB，而 runner 只打印一句
//     「可手动删除」—— 那句话从来没有东西替人执行（AGENTS §7.8）。
//     四格各自承重，摘掉任意一格都要红：
//       a 工具自带的逐闸自证还在跑，而且对照格数没被人删
//       b runner 的收尾**真的调用**了清理，且那一发带 --apply（干跑等于没清理）
//       c npm 入口存在并指向这份真源（留在链外的工具会无声腐烂，口径同第 22 项）
//       d AGENTS.md 把「每次跑完都要清理」写成规矩并指到真源
//         —— 行为改了而文档没改，是这一族唯一的失败形状
// ---------------------------------------------------------------------------
function fnBodyAt(src, name) {
  var i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  var j = src.indexOf('\n}', i);          // 顶层函数的收尾花括号是唯一顶格的那个
  return j === -1 ? null : src.slice(i, j);
}

function checkProfileSweep() {
  var bad = [];
  var cells = null;

  // ---- a. 逐闸自证 ----
  // 本轮实测 8 格（闸 1 的两半各一格），只钉下限：有人删对照格就红，加格不会碍事
  var CELLS_MIN = 8;
  var script = path.join(__dirname, 'clean-e2e-profiles.js');
  if (!exists('tools/clean-e2e-profiles.js')) {
    fail('临时 profile 清理的真源不存在：tools/clean-e2e-profiles.js');
    return;
  }
  var stOut = '';
  var stStatus = null;
  var stErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 60000 });
    stErr = r.error || null;
    stOut = String(r.stdout || '') + String(r.stderr || '');
    stStatus = r.status;
    if (!r.error || r.error.code === 'ETIMEDOUT') break;   // 只有"起不来"值得重试
  }
  if (stErr) {
    bad.push('清理工具的逐闸自证没跑成' + (stErr.code === 'ETIMEDOUT' ? '（60 秒没返回）' : '（已重试一次）') +
      '：' + String(stErr));
  } else {
    var m = stOut.match(/自检：(\d+)\s*\/\s*(\d+)\s*格通过/);
    if (stStatus !== 0 || !m) {
      bad.push('逐闸自证退出码 ' + stStatus + '，或那句「自检：N / M 格通过」根本没打印（末行=' +
        JSON.stringify(stOut.trim().split(/\r?\n/).pop()) + '）—— 读不出当失败，不当通过');
    } else if (Number(m[1]) !== Number(m[2])) {
      bad.push('逐闸自证自己报了 ' + m[1] + ' / ' + m[2] + ' 两数不等，却退出 ' + stStatus +
        ' —— 有格没过还被当成通过');
    } else if (Number(m[2]) < CELLS_MIN) {
      bad.push('对照格数从下限 ' + CELLS_MIN + ' 掉到 ' + m[2] + ' —— 删掉的那格不会自己喊，' +
        '四道闸里少一格对照，闸坏了也照样绿');
    } else {
      cells = Number(m[2]);
    }
  }

  // ---- b. runner 真的收尾调它 ----
  // ⚠️ 先剥注释再比：runner 里大段说明写着「跑完自动清理」「sweepE2eProfiles」，
  //    拿原文数会把散文当调用（AGENTS §5 批次 98 同一族）。
  var e2eCode = stripComments(read('tools/browser-e2e.js'));
  var sweep = fnBodyAt(e2eCode, 'sweepE2eProfiles');
  if (!sweep) {
    bad.push('runner 里找不到 sweepE2eProfiles 的函数体 —— 清理这一发没接进 npm run e2e');
  } else {
    if (sweep.indexOf('--apply') === -1) {
      bad.push('runner 那一发没带 --apply：干跑一枚都不删，表现与没接清理完全一样（这一格就是那句"看起来在跑、就是不删"）');
    }
    if (!/setTimeout\s*\(/.test(sweep)) {
      bad.push('runner 那一发没有超时：清理挂住会把整轮 e2e 的收尾一起挂住（AGENTS §2 第 2 条）');
    }
  }
  if (!/await\s+sweepE2eProfiles\s*\(\s*\)/.test(e2eCode)) {
    bad.push('runner 里没有任何一处**调用** sweepE2eProfiles() —— 函数留着不叫，等于还是「可手动删除」');
  }

  // ---- c. npm 入口 ----
  var pkg;
  try { pkg = JSON.parse(read('package.json')); }
  catch (e) { pkg = null; bad.push('package.json 读不出 JSON：' + e.message); }
  var sc = (pkg && pkg.scripts) || {};
  ['clean:profiles', 'clean:profiles:selftest'].forEach(function (key) {
    var v = String(sc[key] || '');
    if (!v) { bad.push('package.json 少了脚本 ' + key + ' —— 现场想手工清理没有入口'); return; }
    if (v.indexOf('clean-e2e-profiles.js') === -1) {
      bad.push(key + ' 没指向真源 tools/clean-e2e-profiles.js（写的是 ' + v + '）');
    }
  });
  if (sc['clean:profiles'] && sc['clean:profiles'].indexOf('--apply') === -1) {
    bad.push('npm run clean:profiles 是干跑 —— 用户要的是"把盘子腾出来"，干跑要另开一个 key');
  }
  if (sc['clean:profiles:selftest'] && sc['clean:profiles:selftest'].indexOf('--selftest') === -1) {
    bad.push('npm run clean:profiles:selftest 没带 --selftest —— 那一格会去真删盘上的 profile');
  }

  // ---- d. AGENTS.md 的规矩 ----
  var agents = read('AGENTS.md');
  if (agents.indexOf('tools/clean-e2e-profiles.js') === -1) {
    bad.push('AGENTS.md §7.8 没把这份真源写进去 —— 下一轮接手的人只会照着"可手动删除"那句话办');
  }
  if (agents.indexOf('npm run clean:profiles') === -1) {
    bad.push('AGENTS.md 没写手工入口 npm run clean:profiles（规矩要能一条命令执行，不然还是没人跑）');
  }
  if (!/跑完.{0,12}清|每次跑完/.test(agents)) {
    bad.push('AGENTS.md 里没有"每次跑完都要清理"这一句 —— 这条规矩是用户点名要写进去的');
  }

  if (bad.length) {
    fail('临时 profile 自动清理没接牢（这族 bug 的表现是"C 盘又被堆满"，而一条测试都不会红）：\n      ' +
      bad.join('\n      '));
    return;
  }
  pass('临时 profile 跑完即清（逐闸自证 ' + cells + ' 格全对；runner 收尾带 --apply 那一发已接进 e2e，' +
    'npm 入口与 AGENTS §7.9 规矩同真源）');
}

// ---------------------------------------------------------------------------
// 34. 实验支线的发布闸（真源 tools/channel-gate.js）+ 门面的归属
//     用户口径累计四条，方向各不相同，都要落到命令或尺上：
//       2026-11-19「实验版要与稳定版隔离开」→ 支线不许跑 release / replace-asset
//         （⚠️ 当时被我缩成「不提供直接下载」当成作者原话，作者 11-20 更正过，见 CHANGELOG 1.3.1 段）；
//       2026-11-20「实验班也可以加入 readme 的正常下载的旁边，特别标明就行」
//                                       → 支线有自己的预览口，但发布线不许发预览；
//       2026-11-20「门面是我们的正常 main 啊…这不是舍本逐末嘛？」
//                                       → **给人看的那一页在 main**，支线只是工作台；
//                                         实验版入口是门面的固定组成部分，不再随通道同进同退。
//       2026-11-20「树枝那边的 readme…一切都是为了 AI 做事服务，不需要考虑人类阅读」
//                                       → 门面**只**在 main 养一份：支线那一份 README 改成工作笔记
//                                         + 指回 main 的一句话，两处都不许再多一份门面。
//     ⚠️ 这一族事故不报错：在实验支线上跑 `replace-asset`，它会按**当前工作树的版本号**
//     取 dist 里那个包（实验版那份），却挂到线上固定的附件名 `omitone.zip` 上 ——
//     每条命令都打印成功，而 README 那条永久直链从此给所有人发实验版。
//     反过来那一族更隐蔽：预览包若复用 `omitone.zip` 这个名字，或漏写 `prerelease:true`，
//     **线上没有任何东西会红**，只有几周后发现「同学装的一直是实验版」才看得见（1.2.9 那次同形）。
//     第三族是上一轮踩的：**门面那几格读的是工作树那份 README**，于是门面被写在支线工作树上时
//     通道两侧各自自洽、默认那一页一个字没有 —— 加 g 格直接从 git 读 main 才量得到（§2 #18 同一族）。
//     第四族是这一轮踩的、方向刚好相反：支线工作树里**留着完整的一份门面**，改人类向文案就改在草稿上，
//     而两份内容相同的 README 让上面那把尺读哪边都"对" —— 所以 e 现在**按通道分边取文本**：
//     支线上门面从 `git show main:README.md` 取、工作树那份只许是指针；稳定线上门面就是工作树那一份
//     （不许也改成读 HEAD，那会把未提交的门面改动量成看不见 —— 一条只会读旧账的尺）。
//     各格各自承重，摘掉任意一格都要红：
//       a 闸自己的逐格对照全绿，且格数没被人删（口径同第 33 项）
//       b release / replace-asset / preview 三条**真的问了闸**，且问在联网之前
//       c 只读的 verify 不许被挡（§3.7 要求发版必跑它，挡死=造一条恒红的守卫）
//       d 预览那一发不许借用稳定通道的附件名，且必须写 prerelease:true，且发完必须回读自证
//       e 门面按通道分边：**main 那一份**才给人看（预览入口、不撞稳定名字、旧口径两句都不许留）；
//         支线工作树那一份只许写「这页是工作笔记」的指针，**再抄一遍门面就红**
//         （两份门面必然分叉，并回 main 时互相覆盖 —— 用户 2026-11-20 第二次口径）；
//         说明书教预览版下载这一格落在**发预览包的那条线**（预览 pdf 由它构建）
//       f AGENTS §3.8 那条规矩还指着这份真源
//       g 支线上从 `git show main:README.md` 把门面取回来 —— **读不出单独占一格**，
//         且它与工作树那份逐字节相同时也红（两份一样就没法分清这一格读的是哪一边）
//       h 文档里手抄的「闸自带 N 格」必须等于 a 格从闸自己嘴里读回来的 N ——
//         断的方向是文档不是闸：a 格只比代码里的 CELLS_MIN 下限，量不到散文里那几处手抄的数，
//         于是 AGENTS 与 HANDOVER 一起停在「15 格」三个批次没人发现（批次 142 补的这把尺）；
//         0 命中单独报红，口径同 §2 #21：措辞被整体改写时扫描会静默变成 0 命中，那是最坏的一种绿
//       i 预览版**逐轮登记**：批次 140 起的口径是「预览版每做完一轮就往门面补一两句」，
//         而这一族以前**一条尺都没有** —— 门面停在上一轮时现场一片安静（批次 147 实测撞上：
//         146 那三条用户看得见的改动欠了一整天，没有任何东西替人记这笔账）。
//         判据落在每一轮往 CHANGELOG 自己那一节写下的 `**门面**：` 那一行，两种形状缺一不可：
//         引片段的（片段要能在用户看得见的那几页里取到）／写明「不用补（理由）」的；
//         一节都扫不到单独报红，口径同 h —— 那句要求被整段删掉时不许静默变成通过
//       j verify 的期望表**按通道**取（#203）：期望自测要跑绿且格数不掉，且 cmdVerify 的函数体
//         真的用那张表（名字那一族写死回 ASSETS 也单独红）—— 否则 `verify preview` 恒红三条
//         结构上不可能成立的断言，而每轮收口第 ⑥ 件都要跑它
// ---------------------------------------------------------------------------
function checkChannelGate() {
  var bad = [];
  var cells = null;

  // ---- a. 闸自带的逐格对照 ----
  var CELLS_MIN = 20;
  if (!exists('tools/channel-gate.js')) {
    fail('实验支线的发布闸真源不存在：tools/channel-gate.js（AGENTS §3.8 那条规矩落不到命令上）');
    return;
  }
  var gatePath = path.join(__dirname, 'channel-gate.js');
  var gOut = '';
  var gStatus = null;
  var gErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var gr = spawnSync(process.execPath, [gatePath, '--selftest'], { encoding: 'utf8', timeout: 30000 });
    gErr = gr.error || null;
    gOut = String(gr.stdout || '') + String(gr.stderr || '');
    gStatus = gr.status;
    if (!gr.error || gr.error.code === 'ETIMEDOUT') break;   // 只有"起不来"值得重试
  }
  if (gErr) {
    bad.push('通道闸的逐格自证没跑成' + (gErr.code === 'ETIMEDOUT' ? '（30 秒没返回）' : '（已重试一次）') +
      '：' + String(gErr));
  } else {
    var gm = gOut.match(/自检：(\d+)\s*\/\s*(\d+)\s*格通过/);
    if (gStatus !== 0 || !gm) {
      bad.push('通道闸自证退出码 ' + gStatus + '，或那句「自检：N / M 格通过」根本没打印（末行=' +
        JSON.stringify(gOut.trim().split(/\r?\n/).pop()) + '）—— 读不出当失败，不当通过');
    } else if (Number(gm[1]) !== Number(gm[2])) {
      bad.push('通道闸自证自己报了 ' + gm[1] + ' / ' + gm[2] + ' 两数不等，却退出 ' + gStatus +
        ' —— 有格没过还被当成通过');
    } else if (Number(gm[2]) < CELLS_MIN) {
      bad.push('通道闸对照格数从下限 ' + CELLS_MIN + ' 掉到 ' + gm[2] + ' —— 删掉的那格不会自己喊，' +
        '少一格「放行」的对照，闸把正式版一起挡死也照样绿');
    } else {
      cells = Number(gm[2]);
    }
  }

  // ---- b + c + d. 发版工具那几半（先剥注释：头部大段散文写着 release / replace-asset，拿原文数就是把散文当调用） ----
  var relCode = stripComments(read('tools/github-release.js'));
  if (relCode.indexOf("require('./channel-gate.js')") === -1) {
    bad.push("tools/github-release.js 没有 require 通道闸 —— 闸写着却没人问，等于还是那句「别跑这条命令」");
  }
  [['cmdRelease', 'release'], ['cmdReplaceAsset', 'replace-asset'], ['cmdPreview', 'preview']].forEach(function (pair) {
    var body = fnBodyAt(relCode, pair[0]);
    if (!body) { bad.push('发版工具里找不到 ' + pair[0] + ' 的函数体 —— 那一发没法确认它问了闸'); return; }
    var ask = body.indexOf("blockReasonForRepo('" + pair[1] + "')");
    if (ask === -1) {
      bad.push(pair[0] + ' 没问通道闸（' + pair[1] + '）—— 实验支线上这条命令会照样把包推上线');
    } else {
      var netAt = body.indexOf('await api(');
      if (netAt !== -1 && netAt < ask) {
        bad.push(pair[0] + ' 的闸问在**第一次联网之后** —— 前面的 GET 已经动过远端了，挡要挡在最前面');
      }
      if (body.indexOf('process.exitCode = 1') < ask) {
        bad.push(pair[0] + ' 挡下之后没有非零退出 —— 打印一句红字却回 0，链式命令会当成成功继续跑');
      }
    }
  });
  var verifyBody = fnBodyAt(relCode, 'cmdVerify');
  if (!verifyBody) {
    bad.push('发版工具里找不到 cmdVerify 的函数体 —— 「只读核验不许被挡」那一格没处可查');
  } else if (verifyBody.indexOf('blockReasonForRepo') !== -1) {
    bad.push('cmdVerify 被接进了通道闸 —— verify 是 §3.7 要求**发版必跑**的只读核验，' +
      '把它挡死就得到一条恒红的发版流程（会误报的守卫和没有守卫一样害人）');
  }
  // d. 预览那一发的三条命门（名字、prerelease、发完回读）—— 任何一条漏了，线上都不会红
  var prevBody = fnBodyAt(relCode, 'cmdPreview');
  if (!prevBody) {
    bad.push('发版工具里没有 cmdPreview —— 用户要的「预览版可以下载」落不到命令上');
  } else {
    if (prevBody.indexOf("'omitone-preview.zip'") === -1 && relCode.indexOf("name: 'omitone-preview.zip'") === -1) {
      bad.push("预览那一发的附件名不是 omitone-preview.zip —— 一旦它与稳定通道的 omitone.zip 同名，" +
        'README 那条按名字取件的永久直链就会被实验版顶掉');
    }
    if (!/prerelease:\s*true/.test(prevBody)) {
      bad.push('预览那一发没写 prerelease:true —— /releases/latest 只认「非预发布」那一版，' +
        '漏这一个字段等于把预览版推成同学下载的官方版，而命令照样返回 200');
    }
    if (prevBody.indexOf('assertStableChannelIntact') === -1) {
      bad.push('cmdPreview 发布完没有回读自证 —— 「prerelease 写没写对」不能靠我记得，得从线上读回来');
    }
  }
  var intactBody = fnBodyAt(relCode, 'assertStableChannelIntact');
  if (!intactBody) {
    bad.push('发版工具里找不到 assertStableChannelIntact 的函数体 —— 那一发「直链没被抢走」的自证没处可查');
  } else if (intactBody.indexOf('/releases/latest') === -1) {
    bad.push('assertStableChannelIntact 没有问 /releases/latest —— 预览口会不会顶掉正式版，只有读它才知道');
  } else if (intactBody.indexOf('STABLE_ONLY_NAMES') === -1) {
    bad.push('assertStableChannelIntact 没有比附件名交集（STABLE_ONLY_NAMES）—— 两个通道共用名字是最贵的那一种漏');
  }

  // ---- e. 门面只养一份，且养在 main ----
  //     用户口径 2026-11-20（原话「树枝那边的 readme 那些什么东西，一切都是为了 AI 做事服务，
  //     不需要考虑人类阅读之类的，稳定版是我们的门面，那边才需要考虑写好 readme 那些」）：
  //     **门面归 main，支线那一份是工作笔记。** 两侧各查各的形状，因为两种错法都不报错：
  //       · 稳定页缺预览入口 → 同学从默认页看不见预览口，只能靠人来问（上一轮的事故）；
  //       · 支线又抄一份门面 → 两份各自漂移，并回 main 时**这一份覆盖那一份**，
  //         改了半天人类向文案改在草稿上，默认页一个字没动（同一族的第二次，方向相反）。
  //     通道判定继续用闸那一把尺（不在这里再写一遍 /experimental/，AGENTS §2 #18）。
  var gate = require('./channel-gate.js');
  var isExp = gate.isExperimental(gate.readChannelNames().version_name);
  var readme = read('README.md');
  var manual = exists('docs/manual.html') ? read('docs/manual.html') : '';
  var PREVIEW_LINK = 'releases/download/preview/omitone-preview.zip';
  var BRANCH_ONLY = '只有切到这一条分支才看得见';
  var POINTER = '这一页是支线的工作笔记';
  var hasPreviewLink = readme.indexOf(PREVIEW_LINK) >= 0;
  if (isExp) {
    if (!readme || readme.indexOf(POINTER) === -1) {
      bad.push('支线那份 README 没有「' + POINTER + '」这句指针 —— 下一轮接手的人和 AI 都会以为' +
        '人类向文案改在这里，实际上门面在 main（用户 2026-11-20：这一支的文档只为做事服务）');
    }
    if (hasPreviewLink) {
      bad.push('支线那份 README 又抄了一遍门面的预览入口（' + PREVIEW_LINK + '）—— ' +
        '两份门面必然分叉，并回 main 时是这一份覆盖那一份；入口只写在 main 那一页');
    }
  }
  // ---- g. 先把门面那一页取回来（facadeReadme，与第 5c 项预览附件名那一格共用同一把尺）----
  //     ⚠️ 在支线上，工作树那份是工作笔记，**不是**给人看的那一页 —— 门面那几格若读工作树，
  //     在支线上测的是草稿本，main 缺入口照样绿（这一轮之前就是这样，用户报的正是这一族）。
  //     反过来在稳定线上，门面就是工作树这一份，**不许**改去读 `git show main:` 的 HEAD ——
  //     那样未提交的门面改动会量不到，是一条只会读旧账的尺。
  //     所以：facade 的来源按通道分边；支线上这一发读不出**单独占一格**（§2 #12）。
  var facadeRes = facadeReadme(isExp);
  var facade = facadeRes.text;                      // 支线上取不回来时是 null，下面整段跳过
  var facadeFrom = facadeRes.from;
  if (isExp && !facade) {
    bad.push('读不出门面那一页 main:README.md（' + facadeRes.why + '）—— 支线上门面那几格**读不出就是没落实**，' +
      '不许当成通过；也别去怀疑 main 上没有实验版入口，先修这一发的读取');
  } else if (isExp && facade === readme) {
    bad.push('门面（main:README.md）与支线工作树那份**逐字节相同** —— 这一格读的是工作树还是 main 就分不清了，' +
      '而两份一样意味着门面还没跟草稿分开（工作树那份顶部该是指针那一句，不是第二份门面）');
  }

  // e2a 门面必须真的带着预览入口 —— 这一格是整条链的落点：包发出去了、命令与闸都对，
  //     只有门面缺这一句时，同学看不见 = 预览口等于不存在，而且**没有任何别的东西会红**。
  if (facade && facade.indexOf(PREVIEW_LINK) === -1) {
    bad.push('门面（' + facadeFrom + '）里没有实验版入口 ' + PREVIEW_LINK + ' —— ' +
      '同学只会看默认那一页，缺了这句就是"预览包真发上去了但没人找得到"（不报错、不留日志）');
  }

  // e2 门面那几行里的**链接地址**不许撞稳定通道 —— 只比 URL，不比整行散文，
  //    否则「退回正式版就重装 omitone.zip」这种正常说明会被报成越界（会误报的守卫和没有守卫一样害人）
  var leaked = [];
  if (facade) {
    facade.split(/\r?\n/).forEach(function (l) {
      if (l.indexOf('预览') === -1) return;
      var urls = String(l).match(/https?:\/\/[^\s)\]]+/g) || [];
      urls.forEach(function (u) {
        if (u.indexOf('/releases/latest') >= 0 || /\/omitone\.zip$/.test(u)) leaked.push(u);
      });
    });
  }
  if (leaked.length) {
    bad.push('门面（' + facadeFrom + '）实验版那几行里出现了稳定通道的地址（' + leaked.length + ' 条，第一条=' +
      JSON.stringify(leaked[0]) + '）—— 两个通道共用名字，' +
      'README 那条按名字取件的永久直链迟早被预览包顶掉（1.2.9 那次同形）');
  }
  if (facade && facade.indexOf('不提供直接下载') >= 0) {
    bad.push('门面（' + facadeFrom + '）里还有那句「不提供直接下载」—— 那是 2026-11-19 的旧口径' +
      '（当时预览口还没有）。现在实验版有预览下载口，这句会把人挡在能下载的那一步外面');
  }
  if (facade && facade.indexOf(BRANCH_ONLY) >= 0) {
    bad.push('门面（' + facadeFrom + '）还写着「' + BRANCH_ONLY + '」—— 那正是把门面放到支线工作树上的那版说法。' +
      '门面归 main，这一支只是草稿；留着这句，读默认页的人会以为预览口压根不存在');
  }
  // e3 说明书那一格只在**发预览包的这条线**上承重：预览那份 pdf 由这条线构建。
  //    稳定线的 pdf 描述的是 1.3.0 正式版，等转正时这条线那份并回去，天然带上这一格 ——
  //    把它写成通道无关，就会在 main 上得到一条恒红、只能靠放宽判据消掉的守卫。
  if (isExp && (!manual || manual.indexOf('预览版下载') === -1)) {
    bad.push('支线说明书没教「预览版下载」这一格 —— 预览版的 pdf 就是从这条线出的，' +
      '照着那份 pdf 装机的人只看得到正式版那一步，实验版那一条他根本不知道能装');
  }

  // ---- f. AGENTS 那条规矩指着这份真源 ----
  var agents = read('AGENTS.md');
  if (agents.indexOf('tools/channel-gate.js') === -1) {
    bad.push('AGENTS.md §3.8 没把 tools/channel-gate.js 写成真源 —— 下一轮接手的人只会去找那句文字规矩');
  }

  // ---- h. 文档手抄的「闸自带 N 格」对着闸实测格数逐处比 ----
  //     尺的形状照 §2 #21：**只认「闸自带 …数字… 格」这一族写法**（数字必须紧跟在那三个字之后），
  //     于是 CHANGELOG 里那句「那个 **20 格**（闸自带对照格数）手抄在 AGENTS §3.8 与 HANDOVER」天然出界 ——
  //     数字写在前面就匹配不到，不用给历史句贴豁免标记，也不用把尺放宽（§3.7：CHANGELOG 的历史数按史实不回改）。
  //     每处命中都必须等于 a 格跑 selftest 读回来的 cells；一处都扫不到单独报红，别打印通过。
  var DOC_CELLS_FILES = ['AGENTS.md', 'HANDOVER.md', 'tools/README.md'];
  var docHits = [], docWrong = [];
  DOC_CELLS_FILES.forEach(function (f) {
    if (!exists(f)) { docWrong.push(f + ' 读不到文件'); return; }
    var re = /闸自带(?:的)?\s*\**\s*(\d+)\s*格/g;
    var m;
    while ((m = re.exec(read(f)))) {
      docHits.push(f + '(' + m[1] + ')');
      if (cells !== null && Number(m[1]) !== cells) docWrong.push(f + ' 写 ' + m[1] + ' 格');
    }
  });
  if (docHits.length === 0) {
    bad.push('AGENTS.md / HANDOVER.md / tools/README.md 三处里一处「闸自带 N 格」都没扫到（闸实测 ' + cells +
      ' 格）—— 命中 0 不是通过：那句手抄被整句改写掉，就等于从此没有任何东西要求人核这个数；' +
      '上一版 AGENTS 与 HANDOVER 一起停在「15 格」三个批次，正因为没人读过这两处');
  } else if (docWrong.length) {
    bad.push('文档手抄的闸格数与闸自己报回来的不等（闸实测 ' + cells + ' 格，扫到 ' + docHits.length +
      ' 处：' + docHits.join('、') + '）—— 断在：' + docWrong.join('；') +
      '。改的永远是文档那几处，不是 CELLS_MIN、也不是闸里的对照格数（AGENTS §3「行为改了而文档没改，' +
      '是这一族唯一的失败形状」）');
  }

  // ---- i. 预览版逐轮登记：每一轮都要在 CHANGELOG 自己那一节里对门面表态 ----
  //     ⚠️ 判据的形状照 §2 #21：断的是**这一轮自己写下的那一行**，不是门面里有没有某句话 ——
  //     门面是散文，"字样在不在"那种尺会在下一轮改写措辞时静默失效；而"每轮必须表态"没有豁免面：
  //     要么引用一段门面里真取得到的原话，要么写清为什么这轮不用补（批次 143 那种只改 README 账目的就是后者）。
  //     ⚠️ 三种"没跑到"各自单独占一格（§2 #12）：一节都扫不到／门面读不出／比对的三份全空。
  var FACADE_FROM = 141;   // 批次 140 定了「预览版每做完一轮就往门面补一两句」，从下一轮起要求逐轮表态
  function wsOf(s) { return String(s || '').replace(/\s+/g, ''); }   // 门面那一行是折行的，比之前两侧都去空白
  var ledgerCorpus = [];
  if (facade) ledgerCorpus.push({ name: facadeFrom, text: wsOf(facade) });
  var curVer = '';
  try { curVer = String(JSON.parse(read('manifest.json')).version || ''); } catch (eV) { curVer = ''; }
  ['release-notes-preview.md'].concat(curVer ? ['release-notes-' + curVer + '.md'] : []).forEach(function (f) {
    if (!exists(f)) return;
    var t = wsOf(read(f));
    if (t) ledgerCorpus.push({ name: f, text: t });
  });
  var ledger = { total: 0, cited: 0, waived: 0, missing: [], weak: [], notFound: [] };
  var sections = [];
  String(read('CHANGELOG.md') || '').split(/\r?\n/).forEach(function (ln) {
    var h = ln.match(/^### 批次\s+(\d+)/);
    if (h) sections.push({ no: Number(h[1]), mark: null });
    if (!sections.length) return;
    var s = sections[sections.length - 1];
    var m = ln.match(/^\s*[-*+]?\s*\*\*门面\*\*\s*[:：]\s*(.+)$/);
    if (m && s.mark === null) s.mark = m[1].trim();
  });
  var inRange = sections.filter(function (s) { return s.no >= FACADE_FROM; });
  ledger.total = inRange.length;
  inRange.forEach(function (s) {
    if (s.mark === null) { ledger.missing.push(s.no); return; }
    var q = s.mark.match(/^`([^`]+)`/);
    var w = s.mark.match(/^不用补[（(]([^）)]+)[）)]/);
    if (q) {
      var frag = wsOf(q[1]);
      if (frag.length < 8) {
        ledger.weak.push('批次 ' + s.no + '：引的片段去掉空白只有 ' + frag.length + ' 字 —— 太短的片段谁都能凑上，不算证据');
        return;
      }
      if (/[*_]/.test(q[1])) {
        ledger.weak.push('批次 ' + s.no + '：片段里带了 markdown 的 `*` 或 `_` —— 门面那句是加粗的，照抄星号必定取不到（要摘掉加粗再截一截）');
        return;
      }
      ledger.cited++;
      if (!facade) return;   // 门面读不出时这一格由下面单独说话，不拿"取不到"糊过去
      var where = ledgerCorpus.filter(function (c) { return c.text.indexOf(frag) >= 0; });
      if (!where.length) ledger.notFound.push('批次 ' + s.no + '「' + String(q[1]).slice(0, 26) + '」');
    } else if (w) {
      if (wsOf(w[1]).length < 6) {
        ledger.weak.push('批次 ' + s.no + '：「不用补」的理由去掉空白只有 ' + wsOf(w[1]).length + ' 字，等于没写');
        return;
      }
      ledger.waived++;
    } else {
      ledger.weak.push('批次 ' + s.no + '：那一行既不是 `反引号片段` 也不是「不用补（理由）」（读到：' +
        JSON.stringify(String(s.mark).slice(0, 30)) + '）');
    }
  });
  if (ledger.total === 0) {
    bad.push('CHANGELOG 里扫不到批次号 ≥ ' + FACADE_FROM + ' 的段落（读到 ' + sections.length +
      ' 段，全在范围外）—— 0 命中不是通过：那段标题的形状被改了，这把尺就从此扫不到任何东西（口径同 h）');
  } else if (facade && ledgerCorpus.length === 0) {
    bad.push('i 格三份比对文本全空（门面 + release-notes-preview.md + release-notes-' + curVer + '.md）—— ' +
      '拿不到比对面就没有任何片段能被判"取不到"，这是读不出，不是通过');
  } else {
    if (ledger.missing.length) {
      bad.push('批次 ' + ledger.missing.join('、') + ' 的 CHANGELOG 段里没有「**门面**：」那一行 —— ' +
        '预览版每做完一轮要在门面（' + facadeFrom + ' 的「预览版最近改了什么」）补一两句，这条口径以前**一条尺都没有**，' +
        '于是欠记录时现场一片安静（批次 147 实测：146 那三条用户看得见的改动欠了一整天）。' +
        '两种合法写法：`**门面**：` + 反引号包住门面里真有的那一段原话；或 `**门面**：不用补（一句说得出口的理由）`');
    }
    if (ledger.notFound.length) {
      bad.push(ledger.notFound.join('；') + ' 引的片段在用户看得见的那几页里取不到（比过：' +
        ledgerCorpus.map(function (c) { return c.name; }).join(' / ') + '）—— ' +
        '写了标记不等于补了门面：门面那句话被改写、被整段删掉、或当初根本没写，这一格都该红');
    }
    if (ledger.weak.length) bad.push('「**门面**：」那一行不承重：' + ledger.weak.join('；'));
    if (!facade && ledger.cited > 0) {
      bad.push('i 格没能比：门面那一页读不出（' + facadeRes.why + '），而这一轮有 ' + ledger.cited +
        ' 条片段要对着它比 —— g 那条已经为这句话红过一回，这里再记一笔是别让"少了一段比较"被读成通过');
    }
  }

  // ---- j. verify 的期望必须**按通道**取（#203）----
  //     这一族的形状与 c 格刚好配对：c 管"不许把只读核验挡死"，j 管"核验问的话得问在对的通道上"。
  //     批次 149–153 实测：`verify preview` 拿**正式通道**的期望问预览那一发
  //     （要 omitone.zip 与 Omitone-manual.pdf 这两个名字、要 latest/download/omitone.zip 那条直链、
  //     要 tag 不落后 main），三条**结构上不可能成立**，退出码恒 1 ——
  //     而六件套第 ⑥ 件每轮收口都要跑它，恒红的验收等于没有验收（人会开始跳过这一步）。
  //     所以两边都要钉：**(1)** 期望表自己的逐格自测要跑绿且格数不掉；
  //     **(2)** `cmdVerify` 的函数体真的从那张表取期望（否则自测绿而核验仍写死，是最坏的一种绿）。
  var VERIFY_EXPECT_MIN = 10;
  var veOut = '', veStatus = null, veErr = null;
  for (var veAttempt = 0; veAttempt < 2; veAttempt++) {
    var vres = spawnSync(process.execPath,
      [path.join(__dirname, 'github-release.js'), 'verify-expect'],
      { encoding: 'utf8', timeout: 30000 });
    veErr = vres.error || null;
    veOut = String(vres.stdout || '') + String(vres.stderr || '');
    veStatus = vres.status;
    if (!vres.error || vres.error.code === 'ETIMEDOUT') break;   // 只有"起不来"值得重试
  }
  var veGrid = veOut.match(/自测通过（共 (\d+) 格）/);
  if (veErr) {
    bad.push('verify 通道期望的逐格自证没跑成' + (veErr.code === 'ETIMEDOUT' ? '（30 秒没返回）' : '（已重试一次）') +
      '：' + String(veErr));
  } else if (veStatus !== 0 || !veGrid) {
    bad.push('verify 通道期望自测退出 ' + veStatus + '，或那句「自测通过（共 N 格）」根本没打印（末行=' +
      JSON.stringify(String(veOut).split(/\r?\n/).filter(Boolean).slice(-1)[0] || '') +
      '）—— 退出码 0 而读不出格数就是"没跑到"，不是通过（口径同 a 格）');
  } else if (Number(veGrid[1]) < VERIFY_EXPECT_MIN) {
    bad.push('verify 通道期望自测格数从下限 ' + VERIFY_EXPECT_MIN + ' 掉到 ' + veGrid[1] +
      ' —— 删掉的那一格不会自己喊，而这一族每一格各挡一种假绿（缺额／越界／prerelease／空清单／认不出的 tag）');
  }
  // (2) 真接线：cmdVerify 里不许再出现写死正式通道的那几处
  var veWire = [
    ['期望表按通道取（verifyExpectations(tag)）', /verifyExpectations\(\s*tag\s*\)/],
    ['缺额／直链／越界／prerelease 四格由 verifyChannelReadout 交回', /verifyChannelReadout\(\s*want\s*,\s*gotNames/],
    ['比对基准是 baseBranch 而不是写死的 main', /'\/git\/ref\/heads\/' \+ baseBranch/],
    ['基准分支读不出单独红（不许塌进"一致"）', /baseBranch\s*\|\|\s*String\(\s*rel\.target_commitish/],
    ['新增两格进退出码', /read\.foundForbidden\.length\s*\|\|\s*!read\.prereleaseOk/],
    ['按内容核对附件时用通道那张表（#203 的第四条：预览比到正式说明书）', /want\.assetTable\.filter/]
  ];
  if (!verifyBody) {
    bad.push('发版工具里找不到 cmdVerify 的函数体 —— j 格「期望表有没有真被用上」没处可查');
  } else {
    veWire.forEach(function (w) {
      if (!w[1].test(verifyBody)) {
        bad.push('cmdVerify 里没找到「' + w[0] + '」那一句 —— 期望表改了而核验没用它，自测照样绿（§2 #18 那一族）');
      }
    });
    if (/ASSETS\.map\(/.test(verifyBody)) {
      bad.push('cmdVerify 里还有 `ASSETS.map(` —— 期望附件名又回到写死正式通道，预览那一发的假红①回来');
    }
    if (/===\s*'omitone\.zip'/.test(verifyBody)) {
      bad.push('cmdVerify 里还有那句按 `omitone.zip` 判直链 —— 预览通道永远拿不到绿灯，假红②回来');
    }
  }

  if (bad.length) {
    fail('实验支线发布闸没接牢（这族事故的表现是「下载的人装到了实验版」，而每条命令都打印成功）：\n      ' +
      bad.join('\n      '));
    return;
  }
  pass('实验支线发布闸（通道 ' + (isExp ? 'exp' : 'stable') + '；闸自带 ' + cells + ' 格对照全对，' +
    'release / replace-asset / preview 问在联网之前，verify 照旧放行且期望按通道自测 ' +
    (veGrid ? veGrid[1] : '?') + ' 格全绿，' +
    '文档手抄 ' + docHits.length + ' 处逐处同闸的 ' + cells + ' 格（' + docHits.join('、') + '），' +
    '预览附件名与 prerelease 与发布后回读三格齐，' +
    '门面逐轮登记：批次 ≥' + FACADE_FROM + ' 共 ' + ledger.total + ' 节，引门面 ' + ledger.cited +
    ' 条、写明不用补 ' + ledger.waived + ' 条（比对面 ' + ledgerCorpus.length + ' 份），' +
    '门面按通道分边：工作树=' + (isExp ? '工作笔记（指针已带，未抄门面）' : '门面') +
    '、门面那一份（' + facadeFrom + '，' + facade.length + ' 字）带实验版入口且不撞稳定名字）');
}

// ---------------------------------------------------------------------------
// 35. 本地自愈「医生」的规则表，必须对着代码里真发出去过的那句日志
//     （真源 tools/audit-diagnose-needles.js，判断层在 libs/diagnose.js）
//
//     为什么要有这一条：规则靠 `message.indexOf(needle)` 命中日志环，needle 写错
//     **不抛、不红、不留日志** —— 只会让那一条规则一辈子不触发，用户点开「诊」
//     永远看到「这次没查出问题」。AGENTS §2 #22 记过同一族现场（按中文语义猜词表，
//     四格全 0 条），差别是那次是临时探针，**这一条是常驻功能**，猜错就一直错下去。
//     与第 32 项的分工：那条量**说明书教的字样**，这一条量**判断层自己吃的字样**。
//     a–f 各独立承重，摘掉任意一格都要红（本轮 reverse130 逐格验过）：
//       a 逐格对照的**名字清单**钉在这里 —— 只改审计里的期望不能蒙过这道闸（口径同 24/31/32）
//       b 审计 `--selftest` 退出 0，且那句「对照格数: N」不许掉到下限以下
//       c 第 32 项那把尺的 `keepShape` 不许被退回（形状筛会把**整句中文**的日志名一起丢掉，
//         于是 foreign-ext 那一条规则永远命中不了 —— 实测踩过）
//       d `libs/diagnose.js` 被 manifest 与 popup.html **两处**加载（少一处就是"点了没反应"）
//       e 判断层保持纯函数（代码里不许出现 `chrome.` / `document.` / `window.`），
//         否则这条闸在 node 里 `require` 不动，而 `selfCheck()` 也再没人跑得起来
//       f 「本地自愈」这句用户看得见的提示在 README 与说明书可见正文里都还在（#163 硬要求），
//         且两份工具索引指得到真源（找不到就会有人重写第二份，AGENTS §2 #4）
// ---------------------------------------------------------------------------
function checkDiagnoseRuleTable(manifest) {
  var audit;
  try {
    audit = require('./audit-diagnose-needles.js');
  } catch (e) {
    fail('医生规则表对账加载失败：' + String((e && e.message) || e) +
      '\n      真源是 tools/audit-diagnose-needles.js —— 它被改名或删除时，这条闸正在"少查一处还打印全绿"');
    return;
  }
  var bad = [];

  // ---- a. 对照格的名字清单 ----
  // ⚠️ 清单写死在这里，不吃审计自己的 CELLS：改了审计里的 pin 文案不能把某一格悄悄换掉。
  //    （AGENTS §5「断言名字里的清单要和谓词一一对应」——名字承诺了什么，就得要求什么。）
  var PINS = [
    'A 干净夹具 → 0 条',
    'B needle 代码里没有 → 点名那条规则',
    'C 只在注释里提到 → 两条 needle 都算没发过',
    'D 名字长在别的调用里（不是 emit 那一发）→ 不算',
    'E 同一条 needle 属于两条规则 → 点名两条',
    'F needles 为空 → 恒不触发要响',
    'G 动作弹窗不认 → 点名那个动作（顺带 reload 变白挂）',
    'H severity 越界 → 点名那一格',
    'I title 超上限 → 会被截断要响',
    'J 推进字样没发过 → 单独点名',
    'K 规则表空 → FATAL（不许打印通过）',
    'L 弹窗源码读不到而规则有动作 → FATAL',
    'M 弹窗白挂一枚没人发的动作 → 点名',
    'N selfCheck 没通过 → 转述它自己的话',
    'O 阴性对照：注释与真代码混在一处，真代码那一发必须算发过',
    'P 整句中文的日志名必须收进真源（承重：不许退回第 32 项那条 `[a-z]` 形状筛）'
  ];
  var gotPins = (audit.CELLS || []).map(function (c) { return c.pin; });
  PINS.forEach(function (p) {
    if (gotPins.indexOf(p) < 0) bad.push('审计里少了这一格：「' + p + '」—— 删掉的那格不会自己喊');
  });

  // ---- b. 审计自带的逐格对照真跑一遍（含真仓库那一格）----
  var CELLS_MIN = 16;
  var script = path.join(__dirname, 'audit-diagnose-needles.js');
  var stOut = '', stStatus = null, stErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 60000 });
    stErr = r.error || null;
    stOut = String(r.stdout || '') + String(r.stderr || '');
    stStatus = r.status;
    if (!r.error || r.error.code === 'ETIMEDOUT') break;   // 只有"起不来"值得重试
  }
  var stCells = null;
  if (stErr) {
    bad.push('医生的逐格对照没跑成' + (stErr.code === 'ETIMEDOUT' ? '（60 秒没返回）' : '（已重试一次）') +
      '：' + String(stErr));
  } else {
    var m = stOut.match(/对照格数:\s*(\d+)/);
    if (stStatus !== 0 || !m) {
      bad.push('医生的逐格对照退出码 ' + stStatus + '，或那句「对照格数: N」根本没打印（末行=' +
        JSON.stringify(stOut.trim().split(/\r?\n/).pop()) + '）—— 读不出当失败，不当通过');
    } else if (Number(m[1]) < CELLS_MIN || Number(m[1]) !== gotPins.length) {
      bad.push('逐格对照报 ' + m[1] + ' 格，与代码里的 ' + gotPins.length + ' 格对不上（下限 ' +
        CELLS_MIN + '）—— 有格被跳过或被删时，"全绿"这两个字就没有内容');
    } else stCells = Number(m[1]);
  }

  // ---- c. keepShape 那一手还在（两侧都要，少一边就等于没有）----
  var namesCode = stripComments(read('tools/audit-manual-log-names.js'));
  var needlesCode = stripComments(read('tools/audit-diagnose-needles.js'));
  if (namesCode.indexOf('keepShape ||') < 0) {
    bad.push('audit-manual-log-names.js 里那条 `/[a-z]/i` 形状筛又被无条件生效了（keepShape 那一格没了）' +
      ' —— 整句中文的日志名会被丢掉，医生那一条 foreign-ext 永远命中不了');
  }
  if (needlesCode.indexOf("spanLiterals(x.src, afterLevel, ',)', false, true)") < 0) {
    bad.push('audit-diagnose-needles.js 没把 keepShape 传成 true —— 形状筛照旧吃掉整句中文的日志名');
  }

  // ---- d. 判断层两处加载 ----
  var inManifest = false;
  ((manifest && manifest.content_scripts) || []).forEach(function (cs) {
    (cs.js || []).forEach(function (p) { if (/libs\/diagnose\.js$/.test(p)) inManifest = true; });
  });
  var popupHtml = read('popup/popup.html');
  var inPopup = /<script[^>]+src="\.\.\/libs\/diagnose\.js"/.test(popupHtml);
  if (!inManifest) bad.push('manifest.json 的 content_scripts 没注入 libs/diagnose.js —— 学习页上的医生没有脑子');
  if (!inPopup) bad.push('popup/popup.html 没加载 libs/diagnose.js —— 弹窗里点「诊」会当场报 diagnose 未定义');

  // ---- e. 判断层保持纯函数 ----
  // 剥注释后比：文件头那句「挂 self.OmitoneDiagnose」是散文，不是代码（AGENTS §5 批次 98 同一族）。
  var diagCode = stripComments(read('libs/diagnose.js'));
  var impure = ['chrome.', 'document.', 'window.'].filter(function (k) { return diagCode.indexOf(k) >= 0; });
  if (impure.length) {
    bad.push('libs/diagnose.js 的代码里出现了 ' + impure.join(' / ') +
      ' —— 判断层一旦依赖宿主环境，这条闸（和 selfCheck 那 25 格）在 node 里就跑不起来了');
  }

  // ---- f. 用户看得见的提示 + 工具索引指得到真源 ----
  var manualVisible = require('./audit-manual-ui-labels.js').visibleText(read('docs/manual.html'));
  if (read('README.md').indexOf('本地自愈') < 0) {
    bad.push('README 里没有「本地自愈」那一句 —— 用户要求过这条提示要放在显眼位置，' +
      '而第 27 项那把尺只量**界面字样**，量不到这句承诺');
  }
  if (manualVisible.indexOf('本地自愈') < 0) {
    bad.push('说明书的可见正文里没有「本地自愈」那一段（注释与 script 里的不算）—— 装了扩展的人不知道她有这本事');
  }
  if (read('tools/README.md').indexOf('audit-diagnose-needles.js') < 0) {
    bad.push('tools/README.md 没登记 audit-diagnose-needles.js —— 下一轮找不到真源就会重写第二份');
  }
  if (read('libs/README.md').indexOf('diagnose.js') < 0) {
    bad.push('libs/README.md 没登记 diagnose.js —— 同上（判断层与提示词一样，得先说清真源在哪）');
  }

  var stats = { rules: 0, needles: 0, progress: 0 };
  try {
    var real = audit.realInput();
    var ev = audit.evaluate(real);
    var s = ev.stats || {};
    stats.rules = s.rules || real.rules.length;
    stats.needles = s.needles || 0;
    stats.progress = s.progress || real.progress.length;
    if (ev.fatal || (ev.problems || []).length) {
      bad.push('真仓库这一格没过：' + (ev.problems || []).join('\n        '));
    }
  } catch (e2) {
    bad.push('真仓库那一格跑挂了：' + String((e2 && e2.message) || e2));
  }

  if (bad.length) {
    fail('医生的规则表没对着代码接牢（这一族坏了的表现是「点开诊断永远说没问题」，而一条日志都不留）：\n      ' +
      bad.join('\n      ') +
      '\n      改法：去 src/page/*.js、content.js、background.js 里 grep `emitRuntimeLog(` 把真名抄回规则表，' +
      '别改这把尺');
    return;
  }
  pass('医生规则表对账（' + stats.rules + ' 条规则 / ' + stats.needles + ' 条 needle / ' +
    stats.progress + ' 条推进字样，全部对着代码里真发过的那一句；逐格对照 ' + stCells + ' 格全对，' +
    'keepShape 两侧都在，判断层两处加载且保持纯函数，README 与说明书都教了「本地自愈」）');
}

// ---------------------------------------------------------------------------
// 第 36 项：联网搜索那枚「会花钱的开关」有没有接牢（会话任务 #183 / 批次 160）
//   为什么单独占一项：这一族坏了的表现是「用户没点开关、余额却在往下掉」，
//   而它一次日志都不会留 —— 与第 35 项（医生规则表）同一形状：行为断言在集成层 [33] 里，
//   静态那一半（登记、出厂状态、第二把尺、对用户说的那句话）历来零尺覆盖。
//   六格各独立承重（摘掉任何一格都要红，反向验证见 .workbuddy/reverse214.js）：
//     a 两处登记：manifest 的 content_scripts 逐字有 libs/web-search.js（上课页那一路），
//       popup.html 也 `<script src="../libs/web-search.js">`（弹窗那一路）—— 少一处就是
//       「那一处压根没问判定层」，而集成层 [33] ⑥ 只测行为，静态这一格要在拼接之前就响
//     b 官方域真源读得回来（`var OFFICIAL_HOST = '…'`）—— 读不出单独占一格，不许塌进通过
//     c 判定层「读不出」不许被当成开着：unknown 那一格必须 `on: false`，而且整个判定层
//       `on: true` 只许出现在 'on' 那一格（多一处放行 = 某一格被抬进"会花钱"那边）
//     d 界面出厂状态：那枚开关的 `aria-checked` 出厂必须是 false（默认开着就是把用户的余额
//       当默认值花，用户 2026-11-21 的硬口径「能用就配，但不能消耗我们的余额」）
//     e 花钱的每一处都问判定层，且不许在调用点自己写一份官方域（第二把尺，§2 #4 / #18）
//     f 对用户说话的那几页都教了它、并说了「默认关着」与「会花钱」；门面读不出单独一格；
//       三处都扫不到就红（措辞被整体改写时扫描会静默变成 0 命中，那是最坏的一种绿，§2 #21）
//   另带一格反误报卫生：**写在「联网搜索」那一句身边**出现「默认开着 / 自动开启 / 保证是最新 /
//   任何地址都能搜」这一族句子就红（整页扫会误报：别的开关真就是默认开着的）。
// ---------------------------------------------------------------------------
function checkWebSearchGate(manifest) {
  var bad = [];
  var LIB = 'libs/web-search.js';
  var POP_JS = 'popup/popup.js';
  var POP_HTML = 'popup/popup.html';
  var SWITCH_ID = 'petWebSearchEnabled';

  if (!exists(LIB)) {
    fail('联网搜索那把尺整个不见了：' + LIB + ' 读不到 —— 判定层（哪些格该带 tools、哪些不该）' +
      '没有真源了，三处花钱出口会各自退回本地猜，而且一条异常都不留');
    return;
  }
  var lib = read(LIB);
  var libCode = stripComments(lib);

  // ---- a. 两处登记 ----
  var inManifest = false;
  ((manifest && manifest.content_scripts) || []).forEach(function (cs) {
    (cs.js || []).forEach(function (p) { if (p === 'libs/web-search.js') inManifest = true; });
  });
  var popHtml = read(POP_HTML);
  var inPopup = /<script[^>]+src="\.\.\/libs\/web-search\.js"/.test(popHtml);
  if (!inManifest) {
    bad.push('manifest.json 的 content_scripts 没逐字列出 libs/web-search.js —— 上课页上的医生' +
      '拿不到判定层，只会说一句听起来像"你没开开关"的话（该红的是这一行，不是那句文案）');
  }
  if (!inPopup) {
    bad.push(POP_HTML + ' 没加载 libs/web-search.js —— 弹窗里「和她聊天」「让她解释」两条都问不到' +
      '该不该带搜索参数，灰条与请求体就此各说各的');
  }

  // ---- b. 官方域真源读得回来 ----
  var mHost = lib.match(/var OFFICIAL_HOST = ['"]([^'"]+)['"]/);
  if (!mHost) {
    bad.push('读不出官方域：' + LIB + ' 里那句 `var OFFICIAL_HOST = …` 不见了或改了写法 —— ' +
      '这一格单独说话，不许当成"没有这一族漂移"（读不出 ≠ 没问题）');
  }
  var officialHost = mHost ? mHost[1] : '(读不出)';

  // ---- c. 「读不出」不许塌成"开着"，放行格只许有一处 ----
  if (!/cell:\s*'unknown',\s*on:\s*false/.test(libCode)) {
    bad.push('判定层「还没读到开关真值」那一格不再是 `on: false` —— 存储里那两个键还没写过的人' +
      '会在不知情的情况下被服务端搜索扣费（AGENTS §2 #12：读不出必须单独占一格）');
  }
  var allowCells = (libCode.match(/cell:\s*'[a-z-]+',\s*on:\s*true/g) || []).length;
  if (allowCells !== 1) {
    bad.push('判定层里 `on: true` 有 ' + allowCells + ' 处（只许 1 处 = ' +
      JSON.stringify((libCode.match(/cell:\s*'([a-z-]+)',\s*on:\s*true/) || [])[1] || '(没有)') +
      ' 那一格）—— 多一处放行就是凭空把某一格抬进"会花钱"那边，少一处则搜索永远不会生效而界面照旧说"已生效"');
  }

  // ---- d. 界面出厂状态 ----
  var swLine = (popHtml.split(/\r?\n/).filter(function (l) {
    return l.indexOf('id="' + SWITCH_ID + '"') >= 0;
  })[0] || '');
  if (!swLine) {
    bad.push(POP_HTML + ' 里找不到那枚开关（id=' + SWITCH_ID + '）—— 出厂状态读不出，' +
      '这一格不许静默通过');
  } else if (/aria-checked="true"/.test(swLine)) {
    bad.push('「联网搜索」出厂就是开着的（' + SWITCH_ID + ' 那一行带 aria-checked="true"）—— ' +
      '这一枚是按量计费的，默认开着等于替用户决定要花他的余额');
  }
  var lblLine = (popHtml.split(/\r?\n/).filter(function (l) {
    return l.indexOf('for="' + SWITCH_ID + '"') >= 0;
  })[0] || '');
  var swLabel = ((lblLine.match(/>([^<]+)<\/label>/) || [])[1] || '').trim();
  if (!swLabel) {
    bad.push('读不出那枚开关在界面上的字样（label for=' + SWITCH_ID + '）—— 说明书要用的是界面真会显示的那几个字，' +
      '不是我们随手起的名（第 27 项那一族的根因就在这）');
  }

  // ---- e. 花钱的每一处都问判定层，且不许第二把尺 ----
  var popCode = stripComments(read(POP_JS));
  var conCode = stripComments(read('content.js'));
  var asks = {
    popupDecision: (popCode.match(/OmitoneWebSearch\.decisionOf\(/g) || []).length,
    popupTools: (popCode.match(/OmitoneWebSearch\.toolsFor\(/g) || []).length,
    pageDecision: (conCode.match(/\.decisionOf\(/g) || []).length,
    pageTools: (conCode.match(/\.toolsFor\(/g) || []).length
  };
  if (!asks.popupDecision || !asks.popupTools) {
    bad.push('弹窗那两条出口（和她聊天 / 让她解释）没有各自问到判定层：decisionOf ' +
      asks.popupDecision + ' 处、toolsFor ' + asks.popupTools + ' 处（两样都至少要 1 处）—— ' +
      '少 toolsFor 就是开关开着也不带搜索，白发一次钱；少 decisionOf 就是自己猜该不该带');
  }
  if (!asks.pageDecision || !asks.pageTools) {
    bad.push('上课页医生那条出口没问到判定层：decisionOf ' + asks.pageDecision + ' 处、toolsFor ' +
      asks.pageTools + ' 处 —— 只测弹窗那一处，这一族就是零覆盖（AGENTS §2 #18）');
  }
  var mMod = conCode.match(/function webSearchModule\(\)\s*\{[\s\S]{0,400}?\n\s{2,4}\}/);
  if (!mMod) {
    bad.push('读不出 content.js 里取判定层的那个函数（webSearchModule）—— 尺对它失效，不许当成"没有第二把尺"');
  } else if (mMod[0].indexOf('OFFICIAL_HOST') >= 0) {
    bad.push('content.js 取模块那一句自己写了一份官方域（' + officialHost + '）—— 同一件事两种口径，' +
      'lib 改了域名页面照旧按旧域名放行，症状与改之前一模一样');
  }

  // ---- f. 对用户说话的那几页 ----
  var visibleText;
  try {
    visibleText = require('./audit-manual-ui-labels.js').visibleText(read('docs/manual.html'));
  } catch (e2) {
    bad.push('说明书可见正文取不出来（' + String((e2 && e2.message) || e2) + '）—— 这一格读不出，不许通过');
    visibleText = '';
  }
  var gate = require('./channel-gate.js');
  var isExp = gate.isExperimental(gate.readChannelNames().version_name);
  var facadeRes = facadeReadme(isExp);
  var pages = [
    { 名: '说明书（可见正文）', 文: visibleText },
    { 名: '预览说明 release-notes-preview.md', 文: exists('release-notes-preview.md') ? read('release-notes-preview.md') : '' },
    { 名: '门面 README（' + facadeRes.from + '）', 文: facadeRes.text === null ? '' : facadeRes.text,
      原话: facadeRes.text === null ? facadeRes.why : '' }
  ];
  // ⚠️ **「说默认关着」「说会花钱」两格落在「联网搜索」那句话自己的邻接窗里，不许整页扫。**
  //    说明书整页有 5 处「默认关着」，其中三处说的**是别的开关**（docs/manual.html:753 聊天回复、
  //    :769 医生主动提醒、:1022 那枚按需的）—— 原先按整页 `indexOf` 扫时，P6 那一刀把讲这枚开关的
  //    两句摘干净，尺照样绿（实测「红 0 条」），因为别的开关那句话替它兜着。那就是
  //    「一条不会失败的检查」（AGENTS §5）。反误报那一族现在共用同一个窗与同一个半径，不写第二把尺。
  var WIN = 160;
  function windowsOf(text) {
    var out = [];
    if (!swLabel || !text) return out;
    var at = -1;
    while ((at = text.indexOf(swLabel, at + 1)) >= 0) {
      out.push(String(text).slice(Math.max(0, at - WIN), at + WIN));
    }
    return out;
  }
  var hits = { 教这枚: 0, 说默认关: 0, 说会花钱: 0, 撒谎词: 0 };
  pages.forEach(function (pg) {
    var t = pg.文;
    if (!t) {
      bad.push(pg.名 + ' 读不出内容' + (pg.原话 ? '（' + pg.原话 + '）' : '') +
        ' —— 这一格单独说话，不许塌进"不用核"，更不许塌进"这枚开关没承诺"（AGENTS §2 #12）');
      return;
    }
    var wins = windowsOf(t);
    if (!wins.length) {
      bad.push(pg.名 + ' 没教界面上那三个字「' + (swLabel || '(读不出)') + '」—— 装了的人只会靠猜');
      return;
    }
    hits.教这枚++;
    var off = wins.some(function (w) { return w.indexOf('默认关着') >= 0; });
    var cost = wins.some(function (w) { return /余额|按量/.test(w); });
    if (off) hits.说默认关++;
    if (cost) hits.说会花钱++;
    if (!off || !cost) {
      bad.push(pg.名 + ' 说这枚开关时没说清它' + (!off ? '默认关着' : '') +
        (!off && !cost ? '、而且' : '') + (!cost ? '是要花用户余额的' : '') +
        ' —— 只讲功能不讲代价，等于把它写成免费的（半径 ' + WIN + ' 字内没有这句话，就不算对它说的）');
    }
    // ---- 反误报：这几句话都被实测推翻过，写在「联网搜索」身边就红 ----
    // ⚠️ 只扫那一句话的邻接窗，不许扫整页：「默认开着」在这一族文档里还有**别的合法用途**
    //    （「刷课页显示吉祥物」默认开着 / 「刷完自动换下一门」默认开着 / 投票开关默认开着 —— 实测
    //    说明书:381 与 main:README 两处都这么写着）。整页扫会得到三条假红，而**会误报的守卫
    //    和没有守卫一样害人**（AGENTS §5）；窗口半径 160 字是照着那三页里最长的一句量出来的。
    var LIES = ['默认开着', '自动开启', '保证是最新', '任何地址都能搜'];
    wins.forEach(function (w) {
      LIES.forEach(function (s) {
        if (w.indexOf(s) >= 0) {
          hits.撒谎词++;
          bad.push(pg.名 + ' 讲「' + swLabel + '」那一句里出现了「' + s + '」—— 实测都不成立：' +
            '出厂是关的、开关不会自己开、查回来的日期几次都没对上、接别人的服务器时这一枚会灰掉');
        }
      });
    });
  });
  if (!hits.教这枚) {
    bad.push('三页里一处都没扫到「' + (swLabel || '(读不出)') + '」那三个字 —— 措辞被整体改写时这把尺会静默变成 0 命中，那是最坏的一种绿');
  }

  if (bad.length) {
    fail('联网搜索那把尺没接牢（这一族坏了的表现是"用户没点开关、余额却在掉"，而且一条日志都不留）：\n      ' +
      bad.join('\n      ') +
      '\n      改法：动 libs/web-search.js 与三处出口，别改这把尺；行为那一半在集成层 [33]');
    return;
  }
  pass('联网搜索开关对账（官方域 ' + officialHost + '，放行格 1 处，出厂 ' + SWITCH_ID +
    '=关，界面字样「' + swLabel + '」；出口命中 弹窗 ' + asks.popupDecision + '/' + asks.popupTools +
    ' · 页面 ' + asks.pageDecision + '/' + asks.pageTools + '，两处登记都在；三页里教这枚 ' +
    hits.教这枚 + ' 页、说默认关 ' + hits.说默认关 + ' 页、说会花钱 ' + hits.说会花钱 +
    ' 页（都按「' + swLabel + '」那一句的 ' + WIN + ' 字邻接窗读，不是整页扫），撒谎词 ' + hits.撒谎词 + ' 处）');
}

// ---------------------------------------------------------------------------
// 37. 现场桥的判定层（真源 tools/field-bridge.js）+ 日志环读取的出口分家
//     用户 2026-11-21 那句「为什么不能直接读标语，非要疯狂划到最后」之后，另一路更贵的现场
//     （notes/field-159-orphaned-bridge.md）：学习页的桥随旧 content.js 一起作废
//     （`Extension context invalidated.`），而 `npm run field-logs` 只会说一句
//     「可能是后台一直在睡（现场没打开任何学习通页面），也可能扩展真被禁用」——
//     **三种形状的处置完全不同：等 / 重载扩展+F5 / 重装**。一句话把三种压成一种，
//     于是那一夜把"只重载了扩展、页面没 F5"读成"扩展坏了"（AGENTS §2 第 12 条同一族）。
//     ⚠️ 这一族不报错、也没有任何一把尺量得到：环冻住时 field-logs 与技能
//     sw-eval.js --in=sw 同时瞎，盘上只有那句猜出来的话。所以本项要红的是：
//       ① 判定层或读取层的逐格对照掉了格；② 读取层又开始自己猜／自己写处置句（两份口径）；
//       ③ 现场那三份读数不再各占一格（桥断 / MV3 正常回收 / 来错页）；
//       ④ 默认路径开始动现场（createTarget 跑出 --open-popup 那一支）；
//       ⑤ 出口码、npm 入口、AGENTS §3.3 与 tools/README.md 那几句登记断了。
// ---------------------------------------------------------------------------
function checkBridgeVerdictGrids() {
  var bad = [];
  var cells = {};
  var fieldCells = 0;   // 现场读数那一栏实际有几格（pass 那句不许手抄）

  // ---- a. 两份逐格对照都真跑（只钉下限：加格不碍事，删格要响） ----
  var MIN = { bridge: 17, logs: 23 };
  [['bridge', 'tools/field-bridge.js'], ['logs', 'tools/field-logs.js']].forEach(function (pair) {
    var name = pair[0], file = pair[1];
    if (!exists(file)) { bad.push('判定层的真源不存在：' + file); return; }
    var r = spawnSync(process.execPath, [path.join(__dirname, path.basename(file)), '--selftest'],
      { encoding: 'utf8', timeout: 60000 });
    var out = String(r.stdout || '') + String(r.stderr || '');
    if (r.error) {
      bad.push(file + ' 的逐格对照没跑成：' + String(r.error.code || r.error) + ' —— 读不出当失败，不当通过');
      return;
    }
    var m = out.match(/自检：(\d+)\s*\/\s*(\d+)\s*格通过/);
    if (r.status !== 0 || !m) {
      bad.push(file + ' 的逐格对照退出码 ' + r.status + '，或那句「自检：N / M 格通过」根本没打印（末行=' +
        JSON.stringify(out.trim().split(/\r?\n/).pop()) + '）');
    } else if (Number(m[1]) !== Number(m[2])) {
      bad.push(file + ' 自己报了 ' + m[1] + ' / ' + m[2] + ' 两数不等却退出 0 —— 有格没过还被当成通过');
    } else if (Number(m[2]) < MIN[name]) {
      bad.push(file + ' 的对照格数从下限 ' + MIN[name] + ' 掉到 ' + m[2] +
        ' —— 删掉的那一格不会自己喊，桥判定少一格对照就回到"三种形状压成一句"');
    } else {
      cells[name] = Number(m[2]);
    }
  });

  // ---- b. 判定层只有一份，读取层不许再猜、也不许自己写处置句 ----
  var logsCode = stripComments(read('tools/field-logs.js'));
  var bridgeCode = stripComments(read('tools/field-bridge.js'));
  if (!/require\(['"]\.\/field-bridge\.js['"]\)/.test(logsCode)) {
    bad.push('tools/field-logs.js 没 require 判定层 —— "问不到 SW"那一格就又由读取层自己猜（两份口径必然各自漂移）');
  } else if (!/bridge\.probe\(/.test(logsCode)) {
    bad.push('tools/field-logs.js 里没有任何一处调用 bridge.probe() —— 判定层挂着不叫，等于还是那句猜话');
  }
  // 那句猜话现在只许活在注释里当历史；一旦回到代码，就是"把三种压成一种"复活
  if (logsCode.indexOf('可能是后台一直在睡') >= 0) {
    bad.push('tools/field-logs.js 的代码里又出现了那句「可能是后台一直在睡…」—— 这一句把"等 / F5 / 重装"三格压成一格（AGENTS §2 #12）');
  }
  var fixOwn = (bridgeCode.match(/out\.fix = '重载扩展之后必须 F5/g) || []).length;
  if (fixOwn !== 1) {
    bad.push('那句「重载扩展之后必须 F5 这一枚页面」在判定层里数到 ' + fixOwn + ' 处（要恰好 1 处赋值）—— ' +
      '0 处＝桥断那一格交不出处置；2 处＝同一句话两份真源');
  }
  if (logsCode.indexOf('重载扩展之后必须 F5') >= 0) {
    bad.push('tools/field-logs.js 里也写了一份「重载扩展之后必须 F5」—— 处置那句话只许由判定层交出去');
  }

  // ---- c. 三份现场读数各占一格（拿 notes/field-159 记回来的读数喂真判定层） ----
  // ⚠️ 判据不许 import 判定层的 CELLS 表来比它自己：那是一次自证。
  //     下面三份读数的出处写在每一格的 why 里，全部来自盘上台账。
  var bridgeMod = null;
  try { bridgeMod = require('./field-bridge.js'); }
  catch (e) { bad.push('判定层 require 不进来：' + e.message); }
  if (bridgeMod && typeof bridgeMod.classify === 'function') {
    var FIELD = [
      { why: '159 那一夜（notes/field-159-orphaned-bridge.md 第 8 条：8 枚世界、ping 当场抛）',
        raw: { portOk: 1, pageFound: 1, workerListed: 0, extensionPageListed: 0, worldCount: 8,
               worldsHaveFn: 8, worldsHaveId: 8, wakeAllowed: true, pingTried: 1, pingOk: 0,
               pingErr: 'Extension context invalidated.', workerListedAfter: 0 },
        verdict: 'invalidated', via: 'ping-throw', exit: 1, final: true, fixHas: 'F5' },
      { why: 'MV3 正常回收（约 30 秒空闲就把 SW 从列表里抹掉，桥却答得上来）—— 这一格最容易被读成桥断',
        raw: { portOk: 1, pageFound: 1, workerListed: 0, extensionPageListed: 1, worldCount: 1,
               worldsHaveFn: 1, worldsHaveId: 1, wakeAllowed: true, pingTried: 1, pingOk: 1,
               pingErr: '', workerListedAfter: 0 },
        verdict: 'alive-worker-unlisted', exit: 0, final: true, fixHas: '不用管 worker 列表' },
      { why: '纯只读轮（没加 --wake）撞上"id 全读回空串"—— 只许给嫌疑，final 必须是 false',
        raw: { portOk: 1, pageFound: 1, workerListed: 0, extensionPageListed: 0, worldCount: 3,
               worldsHaveFn: 1, worldsHaveId: 0, wakeAllowed: false },
        verdict: 'invalidated-suspect', via: 'id-empty', exit: 1, final: false, fixHas: 'F5' },
      { why: '来错页 / 压根没有学习通页面 —— 读不出单独一个码，不许和"坏了"共用出口',
        raw: { portOk: 1, pageFound: 0, workerListed: 0, extensionPageListed: 0, worldCount: 0,
               worldsHaveFn: 0, worldsHaveId: 0, wakeAllowed: false },
        verdict: 'no-page', exit: 2 }
    ];
    fieldCells = FIELD.length;
    FIELD.forEach(function (c) {
      var v = bridgeMod.classify(c.raw);
      if (v.verdict !== c.verdict) {
        bad.push('现场读数「' + c.why + '」被判成 ' + v.verdict + '（要 ' + c.verdict + '）—— ' +
          '三格压回一格的形状就是这么回到盘上的');
        return;
      }
      if (c.via && v.via !== c.via) bad.push('那一格走的路径是 ' + v.via + '（要 ' + c.via + '）');
      if (Number(v.exit) !== c.exit) {
        bad.push('现场读数「' + c.why + '」的出口码是 ' + v.exit + '（要 ' + c.exit + '）—— ' +
          '脚本调用方（技能 / 下一轮）分不开"等 / 动手 / 读不出"');
      }
      if (c.final !== undefined && !!v.final !== c.final) {
        bad.push('现场读数「' + c.why + '」的 final=' + v.final + '（要 ' + c.final + '）—— 纯只读轮不许下终审');
      }
      if (c.fixHas && String(v.fix || '').indexOf(c.fixHas) === -1) {
        bad.push('现场读数「' + c.why + '」没交出处置那句话（要含「' + c.fixHas + '」，实读 ' +
          JSON.stringify(String(v.fix || '').slice(0, 40)) + '）');
      }
    });
    var E = bridgeMod.EXIT || {};
    if (!(E.ok === 0 && E.action === 1 && E.unreadable === 2)) {
      bad.push('出口码三格没分开（读到 ' + JSON.stringify(E) + '，要 ok=0 / action=1 / unreadable=2）');
    }
    // 反向对照：worker 列表那一格单独**永不**给出"桥断"（第 3 项 b 格的同族：把"读不出"当故障）
    var onlyWorker = bridgeMod.classify({ portOk: 1, pageFound: 1, workerListed: 0, worldCount: 1,
      worldsHaveFn: 1, worldsHaveId: 1, wakeAllowed: false });
    if (String(onlyWorker.verdict).indexOf('invalidated') >= 0) {
      bad.push('只把"worker 不在列表"当证据就判成桥断（读到 ' + onlyWorker.verdict + '）—— ' +
        'MV3 每 30 秒空闲就回收，这一格会天天误报，代价是人去重装扩展');
    }
  }

  // ---- d. 默认路径仍然只读：开标签那一发必须钉在 --open-popup 那一支里 ----
  var opIdx = logsCode.indexOf('if (!hit && openIfMissing)');
  var createIdx = logsCode.indexOf('Target.createTarget');
  var closeIdx = logsCode.indexOf('Target.closeTarget');
  if (createIdx >= 0 && !(opIdx >= 0 && opIdx < createIdx && createIdx < closeIdx)) {
    bad.push('tools/field-logs.js 里 Target.createTarget 没夹在「if (!hit && openIfMissing)」与它的 ' +
      'Target.closeTarget 之间（守卫 @' + opIdx + '，开标签 @' + createIdx + '，关标签 @' + closeIdx + '）—— ' +
      '默认轮会自己去动现场（AGENTS §3.3：导航要先确认）');
  }
  if ((logsCode.match(/Target\.createTarget/g) || []).length !== 1) {
    bad.push('Target.createTarget 在读取层里数到 ' + (logsCode.match(/Target\.createTarget/g) || []).length +
      ' 处（要恰好 1 处）—— 第二处一定没带那道守卫');
  }

  // ---- e. 环像冻住那一格：阈值与"空环"各说各话 ----
  var logsMod = null;
  try { logsMod = require('./field-logs.js'); }
  catch (e) { bad.push('读取层 require 不进来：' + e.message); }
  if (logsMod && typeof logsMod.isRingStale === 'function') {
    var stale = [
      [200, false, true, '环 200 秒没新条目 —— 比地板那两发（120×2）还久，要报冻'],
      [100, false, false, '环 100 秒前还在写 —— 地板节流本来就允许这一档沉默'],
      [0, true, true, '空环 + forced —— 一条都没有是另一种话，不许靠阈值蒙']
    ];
    stale.forEach(function (c) {
      var got = logsMod.isRingStale(c[0], c[1]);
      if (!!got !== c[2]) bad.push('环那一格读数错了：' + c[3] + '（实得 ' + got + '，要 ' + c[2] + '）');
    });
    if (!logsMod.EXIT_BY_VERDICT || logsMod.EXIT_BY_VERDICT['no-page'] !== 2 ||
        logsMod.EXIT_BY_VERDICT['invalidated'] !== 1) {
      bad.push('field-logs 的出口码表没把"桥断（要动手）"与"读不出（别动手）"分开（读到 ' +
        JSON.stringify(logsMod.EXIT_BY_VERDICT || null) + '）—— 调用方只看退出码时三种形状又是一格');
    }
  }

  // ---- f. npm 入口 ----
  var pkg;
  try { pkg = JSON.parse(read('package.json')); }
  catch (e) { pkg = null; bad.push('package.json 读不出 JSON：' + e.message); }
  var sc = (pkg && pkg.scripts) || {};
  var ENTRIES = [
    ['field-bridge', 'tools/field-bridge.js', { ban: ['--wake', '--selftest'] }],
    ['field-bridge:selftest', 'tools/field-bridge.js', { need: ['--selftest'], ban: ['--wake'] }],
    ['field-logs:selftest', 'tools/field-logs.js', { need: ['--selftest'], ban: ['--wake'] }]
  ];
  ENTRIES.forEach(function (e) {
    var key = e[0], src = e[1], rule = e[2] || {};
    var v = String(sc[key] || '');
    if (!v) { bad.push('package.json 少了脚本 ' + key + ' —— 现场想问这一格没有入口，规矩就又落回"记得跑一下"'); return; }
    if (v.indexOf(src) === -1) bad.push(key + ' 没指向真源 ' + src + '（写的是 ' + v + '）');
    (rule.need || []).forEach(function (n) {
      if (v.indexOf(n) === -1) bad.push(key + ' 没带 ' + n + ' —— 那一格会去连现场浏览器，不是逐格对照');
    });
    (rule.ban || []).forEach(function (b) {
      if (v.indexOf(b) !== -1) bad.push(key + ' 带了 ' + b + ' —— 默认口径是多发一条 ping（动现场），要人另加参数才对');
    });
  });
  if (sc['field-logs'] && sc['field-logs'].indexOf('--open-popup') !== -1) {
    bad.push('npm run field-logs 默认就带 --open-popup —— 探针授权里"新开一枚标签"是要先确认的动作');
  }

  // ---- g. 文档：§3.3 第 3 步那句要能一条命令量回来；tools/README.md 要有这两份真源 ----
  var agents = read('AGENTS.md');
  var step3 = agents.indexOf('重新加载 + **刷新学习通页面（F5）**');
  if (step3 === -1) {
    bad.push('AGENTS.md §3.3 第 3 步那句「重新加载 + 刷新学习通页面（F5）」不见了 —— 桥断那一格的处置话没了底稿');
  } else if (agents.indexOf('npm run field-bridge', step3) === -1 ||
             agents.indexOf('npm run field-bridge', step3) - step3 > 1200) {
    bad.push('AGENTS.md §3.3 第 3 步没把「npm run field-bridge」写成这一步的验收命令 —— ' +
      '"重载后必须 F5"这条规矩只能靠人自觉（行为改了而文档没改，是这一族唯一的失败形状）');
  }
  var treadme = read('tools/README.md');
  // ⚠️ 「登记了真源」要问**两件事**，各占一格（§5「接线类判据的锚点要紧到会红」）。
  //    旧那一句只问 `treadme.indexOf('tools/field-bridge.js')`，而 K11 实测把它证伪了：
  //    只把专节标题里那句真源改名成 `tools/field-bridge-x.js` 时，下面 812 行那句
  //    `node tools/field-bridge.js --selftest` 照旧命中 —— 文件名在文档里出现过 ≠ 真源有人指过。
  ['field-logs.js', 'field-bridge.js'].forEach(function (n) {
    var row = new RegExp('^\\|\\s*`' + n.split('.').join('\\.') + '`\\s*\\|', 'm');
    if (!row.test(treadme)) {
      bad.push('tools/README.md 那张工具表里没有 `' + n + '` 那一行（行首竖线 + 反引号名字）—— ' +
        '下一轮接手的人找不到入口，只会重新发明那句猜话');
    }
  });
  if (treadme.indexOf('真源 `tools/field-bridge.js`') === -1) {
    bad.push('tools/README.md 的专节没把真源点名叫到 tools/field-bridge.js —— ' +
      '判定层写在哪一份文件里又变成要靠人猜（文件名在别处出现过不算登记）');
  }
  if (!/invalidated|桥断/.test(treadme) || !/F5/.test(treadme)) {
    bad.push('tools/README.md 里没说清"桥断那一格要 F5"—— 现场看到 verdict=invalidated 的人会去重装扩展');
  }

  if (bad.length) {
    fail('现场桥的判定没分成格（这族 bug 的表现是"整夜把没 F5 读成扩展坏了，日志环看着像死"）：\n      ' +
      bad.join('\n      '));
    return;
  }
  pass('现场"问不到后台"分成五格（桥判定 ' + cells.bridge + ' 格 + 读环 ' + cells.logs +
    ' 格逐格对照全对；' + fieldCells + ' 份现场读数各占一格、出口码 0/1/2 分家；处置那句 F5 只有一份真源，' +
    'AGENTS §3.3 第 3 步与 npm 入口同真源；默认路径仍只读）');
}

// ---------------------------------------------------------------------------
// 第 38 项 —— 「起手先问两道」这把闸自己有没有坏
//
// 为什么单独立一项：接手卡的第 2 步只问 `.workbuddy/main-active.stamp`，而 2026-11-22
// 现场量过（`notes/ledger-166-draft.md` §一）：12:14 那一次条子已经 57 分钟没续期，
// 窗口里却躺着 **5 份又脏又新的构建输入** —— 照旧口径判"安静"、直接 `npm run concat`，
// 就把别人的半成品烘进 `page.js`。**条子只能证明写过它的人在，不能证明没写过它的人不在。**
// 判据落成 `tools/check-concurrency.js` 之后，这一族必须有人守着：谁挡下的、
// 读不出算哪一格、格数有没有被人删掉一格 —— 缺一样，下一次就是"闸门在、但恒绿"。
// ---------------------------------------------------------------------------
function checkConcurrencyGate() {
  var bad = [];
  var SRC = 'tools/check-concurrency.js';
  var CELL_FLOOR = 20;   // 只钉下限：加格不碍事，删格要响（同第 37 项那一族）
  var mod = null;

  // ---- a. 逐格对照真跑，且打印的格数与代码里 CELLS 的真长度相等 ----
  //
  // ⚠️ 两个数各读各的、只比"打印够不够下限"是不够的：手抄的格数正是批次 142 那一族，
  //    而"打印那句与代码不符"是 selftest 自己被改坏时唯一的暴露口。
  if (!exists(SRC)) {
    bad.push('起手判据的真源不存在：' + SRC + ' —— 读不出当失败，不许当通过');
  } else {
    var r = spawnSync(process.execPath, [path.join(__dirname, path.basename(SRC)), '--selftest'],
      { encoding: 'utf8', timeout: 60000 });
    var out = String(r.stdout || '') + String(r.stderr || '');
    var m = out.match(/自检：(\d+)\s*\/\s*(\d+)\s*格通过/);
    if (r.error) {
      bad.push(SRC + ' 的逐格对照没跑成：' + String(r.error.code || r.error) + ' —— 读不出当失败，不许当通过');
    } else if (r.status !== 0 || !m) {
      bad.push(SRC + ' --selftest 退出码 ' + r.status + '，或那句「自检：N / M 格通过」根本没打印（末行=' +
        JSON.stringify(out.trim().split(/\r?\n/).pop()) + '）');
    } else if (Number(m[1]) !== Number(m[2])) {
      bad.push(SRC + ' 自己报了 ' + m[1] + ' / ' + m[2] + ' 两数不等却退出 0 —— 有格没过还被当成通过');
    } else if (Number(m[2]) < CELL_FLOOR) {
      bad.push(SRC + ' 的对照格数从下限 ' + CELL_FLOOR + ' 掉到 ' + m[2] +
        ' —— 被删掉的那一格不会自己喊，"腿 2 命中"与"读不出"就是这样静默没的');
    }
    try {
      mod = require(path.join(ROOT, SRC));
    } catch (e) {
      mod = null;
      bad.push('require 不回 ' + SRC + '（' + String(e.message || e).slice(0, 80) +
        '）—— 判定层已经不能被别人复用，第 38 项只能看它自己那张表');
    }
    if (mod && m) {
      var nCells = (mod.CELLS || []).length;
      if (!nCells) {
        bad.push(SRC + ' 导出的 CELLS 是空的 —— 打印那句有格数而代码里没有对照表，两处必然各自漂移');
      } else if (nCells !== Number(m[2])) {
        bad.push(SRC + ' 打印 ' + m[2] + ' 格，而代码里 CELLS 有 ' + nCells + ' 格 —— 自报的数与实际走的不是一回事');
      }
    }
  }

  // ---- b. 那张表必须覆盖五种 verdict 与三个出口码（新增一型忘了同步进来 = 那一型一步都走不到） ----
  //
  // AGENTS §2 #18 同族：声明覆盖的范围与实际走的分支之间的差，不会自己喊出来。
  if (mod && (mod.CELLS || []).length) {
    var verdicts = {};
    var exits = {};
    (mod.CELLS || []).forEach(function (c) {
      verdicts[c.verdict] = (verdicts[c.verdict] || 0) + 1;
      if (typeof c.exit === 'number') exits[c.exit] = (exits[c.exit] || 0) + 1;
    });
    ['quiet', 'writing', 'orphan-dirty', 'restored-not-writing', 'unreadable'].forEach(function (v) {
      if (!verdicts[v]) {
        bad.push('对照表里没有 verdict=' + v + ' 那一格 —— 这一型现在没有任何东西守着，改坏了不会红');
      }
    });
    [0, 1, 2].forEach(function (e) {
      if (!exits[e]) {
        bad.push('对照表里没有要求出口码 ' + e + ' 的格子 —— 三种码一旦压成两种，"读不出"就混进放行那一支');
      }
    });
    var viaWant = ['stamp-fresh', 'dirty-fresh-build', 'mtime-fresh-clean', 'dirty-stale', 'git-status', 'clean'];
    var haveVia = {};
    (mod.CELLS || []).forEach(function (c) { if (c.via) haveVia[c.via] = 1; });
    var viaMissing = viaWant.filter(function (w) { return !haveVia[w]; });
    if (viaMissing.length) {
      bad.push('对照表里点名不到的 via：' + viaMissing.join(' / ') +
        ' —— via 是"谁挡下的"那一格，少了它就只能报一句"本轮收窄"，等于没有取证');
    }
  }

  // ---- c. 合成读数真跑 classify()：读不出**必须**算阻塞，绝不许塌进放行 ----
  //
  // 这一格是整个工具最贵的一条性质（§2 #2 + §2 #12）：`git status` 跑不动时
  // 若被当成"干净"，下一轮就是拿着坏构建做验收。
  if (mod && typeof mod.classify === 'function') {
    var u = mod.classify({ gitErr: 'probe-only' });
    if (u.verdict !== 'unreadable') {
      bad.push('gitErr 的读数被判成 ' + u.verdict + '（该是 unreadable）—— 读不出被压进了某一格');
    }
    if (!u.blocked) {
      bad.push('unreadable 那一格的 blocked 是假 —— 读不出却放行，等于把"数不清"当成"确认没人写"');
    }
    if (typeof mod.EXIT === 'object' && u.exit !== mod.EXIT.unreadable) {
      bad.push('unreadable 的出口码是 ' + u.exit + '，而 EXIT.unreadable = ' + mod.EXIT.unreadable + ' —— 两把尺不一致');
    }
    var q = mod.classify({});
    if (q.verdict !== 'quiet' || q.blocked) {
      bad.push('什么都没有的那一格应该是 quiet 且放行，实读 verdict=' + q.verdict + ' blocked=' + q.blocked +
        ' —— 恒阻塞的闸和没有闸一样害人（会误报的守卫等于没有守卫）');
    }
    if (typeof mod.EXIT === 'object' &&
      !(mod.EXIT.open === 0 && mod.EXIT.blocked === 1 && mod.EXIT.unreadable === 2)) {
      bad.push('EXIT 不再是 0/1/2 分家（实读 ' + JSON.stringify(mod.EXIT) +
        '）—— 上一轮把放行／阻塞／读不出压成两种码，就是这么静默掉的');
    }
  } else if (mod) {
    bad.push(SRC + ' 没有导出 classify（只导出了那张表）—— 第 38 项只能读文本，判定层不能被人复用');
  }

  // ---- d. 四处登记都要取回（只在一处出现名字 ≠ 登记） ----
  //
  // ⚠️ 判据**分两半各承重**（第 37 项 K11 那条教训就在上面几十行）：
  //    表行那一格与「真源」那一句是两件事，工具名在别处出现过不算登记。
  var agents = read('AGENTS.md');
  var s10 = agents.indexOf('### 1.0');
  var s11 = agents.indexOf('### 1.1');
  if (s10 < 0 || s11 < 0 || s11 <= s10) {
    bad.push('AGENTS.md 里取不到 §1.0~§1.1 那一段（读到 ' + s10 + '/' + s11 +
      '）—— 读不出单独占一格，不许因为扫不到就当这条规矩没事');
  } else {
    var seg = agents.slice(s10, s11);
    if (seg.indexOf('main-active.stamp') < 0) {
      bad.push('AGENTS.md §1.0 里没有 `main-active.stamp` —— 腿 1 的落点没人指，下一轮还会只问那一张条子');
    }
    if (seg.indexOf('check-concurrency') < 0) {
      bad.push('AGENTS.md §1.0 里没有 `tools/check-concurrency.js` —— 两道一起问这条规矩只活在代码里');
    }
    if (!/腿\s*2/.test(seg)) {
      bad.push('AGENTS.md §1.0 没点名「腿 2」—— 只说"两道"不说第二道读什么，就会被读成"再看一遍同一张条子"');
    }
  }

  var hand = read('HANDOVER.md');
  var hAt = hand.indexOf('起手工序');
  if (hAt < 0) {
    bad.push('HANDOVER.md 里没有「起手工序」那节 —— 接手的人只会在 AGENTS 里读到规矩、不知道命令怎么敲');
  } else if (hand.slice(hAt, hAt + 4000).indexOf('check-concurrency') < 0) {
    bad.push('HANDOVER.md 的「起手工序」那一节里没写 `tools/check-concurrency.js` —— 节在了但没说用哪件');
  }

  var treadme = read('tools/README.md');
  var rowRe = new RegExp('^\\|\\s*`check-concurrency\\.js`\\s*\\|', 'm');
  if (!rowRe.test(treadme)) {
    bad.push('tools/README.md 那张工具表里没有 `check-concurrency.js` 那一行（行首竖线 + 反引号名字）—— ' +
      '下一轮接手的人找不到入口，只会重新发明那句猜话');
  }
  if (treadme.indexOf('真源 `tools/check-concurrency.js`') === -1) {
    bad.push('tools/README.md 的专节没把真源点名叫到 tools/check-concurrency.js —— ' +
      '文件名在别处出现过不算登记（同上面第 37 项 K11 那一格）');
  }

  // ---- e. npm 入口两条指向真源，且 selftest 那条真带 --selftest ----
  var pkg;
  try {
    pkg = JSON.parse(read('package.json'));
  } catch (e) {
    pkg = null;
    bad.push('package.json 读不成 JSON（' + String(e.message || e).slice(0, 60) + '）—— 读不出当失败');
  }
  if (pkg && pkg.scripts) {
    var wantScript = { 'concurrency': 'node ' + SRC, 'concurrency:selftest': 'node ' + SRC + ' --selftest' };
    Object.keys(wantScript).forEach(function (k) {
      if (!pkg.scripts[k]) {
        bad.push('package.json 的 scripts 里没有 `' + k + '` —— 规矩写成"要问两道"，可手上没有那一件工具');
      } else if (pkg.scripts[k].indexOf(SRC) < 0) {
        bad.push('npm 入口 `' + k + '` 不指向 ' + SRC + '（实读 ' + pkg.scripts[k] + '）');
      } else if (k === 'concurrency:selftest' && pkg.scripts[k].indexOf('--selftest') < 0) {
        bad.push('npm 入口 `concurrency:selftest` 没带 --selftest —— 手工入口与闸读的是两件事，那张表坏了没人知道');
      }
    });
  }

  if (bad.length) {
    fail('起手闸门还是只问那一张条子（这族 bug 的表现是"窗口明明被人占着却判安静，一次 concat 把别人的半成品烘进构建产物"）：\n      ' +
      bad.join('\n      '));
    return;
  }
  pass('起手先问两道（腿 1 自报条 + 腿 2 盘上 mtime∧脏 同时成立）：' + SRC + ' 对照表 ' +
    ((mod && mod.CELLS) || []).length + ' 格逐格全对、五种 verdict 与出口码 0/1/2 分家都有格守着；' +
    '读不出那一格真算阻塞（classify 合成读数实跑）；AGENTS §1.0、HANDOVER 起手工序、' +
    'tools/README 表行与专节四处登记齐、npm 两条入口同真源');
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
console.log('\nOmitone 工程自检\n');

var jsFiles = checkSyntax();
var manifest = checkManifest();
checkManifestFiles(manifest);
checkVersionConsistency(manifest);
checkSingleSources(manifest);
checkFontTable();
checkUserEntryPoints();
checkConfigDefaults();
checkTestCounts();
checkEncodingDamage(jsFiles);
checkUndefinedMethods(jsFiles);
checkDeadMethods(jsFiles);
checkDeadFiles(jsFiles, manifest);
checkPageConcat();
checkPagePartHeaders();
checkAwaitTimeouts();
checkSelectorCase();
checkSelectorTruthSource();
checkPetSpritePools();
checkBridgeMessageTypes();
checkPublicHygiene();
checkTestSuiteWiring();
checkFixtureParsable();
checkSafedocGuard();
checkMarkdownTables();
checkSliceStatsDoc();
checkManualUiLabels();
checkE2eExprParsable();
checkBrowserOnlyClaim();
checkSwitchBudgetClaim();
checkCourseProbeClaims();
checkManualLogNames();
checkProfileSweep();
checkChannelGate();
checkDiagnoseRuleTable(manifest);
checkWebSearchGate(manifest);
checkBridgeVerdictGrids();
checkConcurrencyGate();

passed.forEach(function (m) { console.log('  [ok]   ' + m); });
warnings.forEach(function (m) { console.log('  [warn] ' + m); });
problems.forEach(function (m) { console.log('  [FAIL] ' + m); });

console.log('');
if (problems.length) {
  console.log('自检未通过：' + problems.length + ' 项错误' + (warnings.length ? '，' + warnings.length + ' 项告警' : ''));
  console.log('');
  process.exitCode = 1;
} else {
  console.log('自检通过' + (warnings.length ? '（' + warnings.length + ' 项告警）' : ''));
  console.log('');
}
