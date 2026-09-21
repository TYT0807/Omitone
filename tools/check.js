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
function checkManifestFiles(manifest) {
  if (!manifest) return;

  var referenced = [];

  var background = manifest.background || {};
  if (background.service_worker) referenced.push(background.service_worker);

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

  var missing = referenced.filter(function (f) { return !exists(f); });
  if (missing.length) fail('manifest 引用了不存在的文件: ' + missing.join(', '));
  else pass(referenced.length + ' 个 manifest 引用文件全部存在');
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
    fail('字形映射表 bin/json 不同步:\n      ' +
      String(result.stderr || result.stdout || '').trim().split('\n').join('\n      '));
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

  if (problemsHere.length) fail('用户入口检查未通过:\n      ' + problemsHere.join('\n      '));
  else pass('用户入口完好（根目录 ' + MANUAL_FILE + ' + README 直链 ' + ZIP_ASSET + '）');
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

  var targets = [
    ['AGENTS.md', null],
    ['README.md', null],
    ['tools/README.md', null],
    ['HANDOVER.md', null],
    ['CHANGELOG.md', latest]
  ];

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

  // ---- 断言总数：e2e 跑完会落盘，有就拿来校验文档 ----
  // 静态数不出来（含每场景动态断言），所以只能由 e2e 自己交出来。
  // 没跑过 e2e 就跳过 —— 不能因为「文件不存在」就判失败。
  var countsFile = path.join(ROOT, '.workbuddy', 'e2e-counts.json');
  var assertionsChecked = false;
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
            var m2 = line.slice(km).match(/(\d+)\s*项/);
            if (!m2) return;
            var n2 = Number(m2[1]);
            if (n2 !== actualAssertions && n2 !== Number(counts.scenarios)) {
              problems.push(file + ' 写的是 ' + n2 + ' 项，e2e 实测是 ' + actualAssertions + ' 项');
            }
          });
        });
      }
    } catch (e) {}
  }

  var sceneNote = '场景数与代码一致: ' + actualScenes + ' 个' +
    (assertionsChecked ? '；断言总数与 e2e 实测一致' : '（断言总数未校验：还没跑过 e2e，跑一次即可）') +
    '（CHANGELOG 只查最新一段，历史记录不查）';

  if (problems.length) fail('测试数字检查未通过:\n      ' + problems.join('\n      '));
  else pass(sceneNote);
}

function checkConfigDefaults() {
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
    var missing = Object.keys(used).filter(function (k) { return !keys[k]; }).sort();
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
  } catch (e) {
    problems.push('开关接线检查自身出错: ' + e.message);
  }

  if (problems.length) fail('配置接线检查未通过:\n      ' + problems.join('\n      '));
  else pass('配置接线完整（默认值齐全 · 界面开关的绑定/读取/保存三件齐全）');
}

function checkDeadFiles(jsFiles, manifest) {
  var loaded = [];
  if (manifest) {
    (manifest.content_scripts || []).forEach(function (e) {
      (e.js || []).forEach(function (f) { loaded.push(f); });
    });
    if (manifest.background && manifest.background.service_worker) {
      loaded.push(manifest.background.service_worker);
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
// 14. page.js 与 src/page/ 片段一致
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
    return;
  }
  fail(
    'page.js 与 src/page/ 不一致（当前 ' + actual.length + ' 字节，按片段拼出来应是 ' + expected.length + ' 字节）\n' +
    '      扩展加载的是根目录那份，所以现在跑的东西和源码对不上。\n' +
    '      改的是片段 → 跑 `npm run concat`；改的是根目录 page.js → 那份会被下次拼接覆盖，请改到片段里。'
  );
}

// ---------------------------------------------------------------------------
// 15. 片段头部与实际内容一致（序号 + 方法清单）
//
// 拆分之后，"哪个域在哪个文件"完全靠每个片段头部那段注释传达 —— 它是模块地图的底稿。
// 头部长了、短了、方法搬走了却没改头部，读的人就会照着错的地图找代码，
// 那比没有地图更糟（没有地图时他会去 grep，有错地图时他会信）。
// 所以把头部当断言守住。
// ---------------------------------------------------------------------------
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

    // ② 头部「本段的方法」清单
    var declared = [];
    var inList = false;
    header.forEach(function (l) {
      if (l.indexOf('本段的方法') !== -1) { inList = true; return; }
      if (!inList) return;
      if (/^\s\* =+/.test(l)) { inList = false; return; }
      var m = l.match(/^\s\*\s+(.*)$/);
      if (m) m[1].split('、').forEach(function (s) { s = s.trim(); if (s) declared.push(s); });
    });

    // ③ 文件里真实的 app 方法。
    //    注意别把 window.xxtAI 上那 8 个也算进来 —— 它们在 app 对象闭合之后，
    //    是给用户手动调的入口，不是 app 的方法。
    var body = lines.slice(markerAt + 1);
    var inApp = !/^\s*\};/.test(body[0] || '');   // 以 `};` 开头的那个片段，开头还在 app 内
    var actual = [];
    body.forEach(function (l) {
      if (/^  var app = \{/.test(l)) { inApp = true; return; }
      if (/^  \};/.test(l)) { inApp = false; return; }
      if (!inApp) return;
      var m = l.match(/^ {4}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/);
      if (m) actual.push(m[1]);
    });

    if (new Set(declared).size !== declared.length) {
      issues.push(file + ' 头部方法清单里有重复项');
    }
    var declaredSet = new Set(declared);
    var actualSet = new Set(actual);
    var missing = actual.filter(function (n) { return !declaredSet.has(n); });
    var ghost = declared.filter(function (n) { return !actualSet.has(n); });
    if (missing.length) {
      issues.push(file + ' 头部漏了 ' + missing.length + ' 个方法：' + missing.slice(0, 6).join('、') +
        (missing.length > 6 ? ' …' : ''));
    }
    if (ghost.length) {
      issues.push(file + ' 头部写了 ' + ghost.length + ' 个本文件不存在的方法：' + ghost.slice(0, 6).join('、') +
        (ghost.length > 6 ? ' …' : ''));
    }
  });

  if (issues.length) {
    fail('片段头部与实际内容不一致（改完片段记得同步头部）:\n      ' + issues.join('\n      '));
    return;
  }
  pass('片段头部与实际一致（' + files.length + ' 个片段：序号 + 方法清单）');
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
// `_probeMaxPlaybackRate()`（内部自带超时）误报，误报多了守卫就没人信了。
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
