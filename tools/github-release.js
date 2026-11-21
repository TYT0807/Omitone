#!/usr/bin/env node
/**
 * 发版工具：走 GitHub REST API 完成「提交 → 打 tag → 建 Release → 传附件 → 核验」。
 *
 * ⚠️ **推送首选 `git push`，不是本工具的 `push` 子命令。**
 *   这里原先写着"本机 `git push` 挂起不返回"，**2026-09-21 已更正**：真正的报错是
 *   `fatal: could not read Username for 'https://github.com': terminal prompts disabled`
 *   —— 远端是 HTTPS 而本机没有凭据助手，**根本没发起认证**，不是网络问题。
 *   把令牌放进 URL 就能推，而且**比走 REST API 好**：API 那条路会把多个提交压成一个，
 *   `git push` 保留完整历史（实测 8 个提交一次推上去、历史完整）。见 AGENTS.md §7.3：
 *
 *     TOKEN=$(cat ~/.omitone-release.ghtoken | tr -d '\r\n')
 *     git -c credential.helper= push "https://x-access-token:${TOKEN}@github.com/TYT0807/Omitone.git" main
 *
 *   本工具的 `push` 子命令**保留作备选**（push 通道万一真不通时还能用），
 *   但打完 tag 要知道 tag 该指向哪个 sha —— API 提交会被 GitHub 重新签名，
 *   远端 sha 必然 ≠ 本地 sha，顺序反了会撞 `422 Object does not exist`。
 *
 * 子命令：
 *   push    --message-file <文件> <文件...>   把改动提交到 main（走 API；备选方案，见上）
 *   release <tag> --notes-file <文件>         打 tag + 建 Release + 传两个附件
 *   preview                                   把**实验支线**那份构建发到独立的预览口（见下方通道闸）
 *   notes   <tag> --notes-file <文件>         **只改 Release 那一页的说明**，不动 tag、不动附件
 *   verify  <tag>                             核验远端状态（**发完必须跑一次**）
 *   replace-asset <tag>                       附件过期时按同名替换，不必重发整版
 *   check-msg <文件>                          只校验提交信息，不联网
 *   verify-expect                             只核对 verify 的**通道期望表**，不联网（#203）
 *
 * ⚠️ **`verify` 的期望按通道取**（`verifyExpectations()`）：预览那一发的附件名、下载直链、
 *   "tag 落后于哪一条分支"都不是正式通道那一套。以前写死按正式通道问，于是
 *   `verify preview` **恒红三条结构上不可能成立的断言**（要 `omitone.zip` 与
 *   `Omitone-manual.pdf` 这两个正式名字、要 `latest/download/omitone.zip` 能用、
 *   要 tag 不落后 `main`）—— 而六件套第 ⑥ 件每轮都要跑它，恒红的验收等于没有验收。
 *   判据全在 `verify-expect` 那 10 格里离线跑，改期望表不必真发一次版才测得到。
 *
 * ⚠️ `notes` 这个子命令是**为了堵一类漂移**才加的：以前"合并说明"都是临时 curl 直接
 *   PATCH 线上那一页，**从没回写 `release-notes-<版本>.md`**（2026-11-14 实测两边各缺半 ——
 *   线上少了批次 38/40/44 的三段，源文件少了批次 33/34 的四段，而且都没人报警）。
 *   规矩：**说明只改源文件，然后 `notes` 把源文件推上去**；`verify` 会逐字比那两份。
 *
 * ⚠️ **通道闸（`tools/channel-gate.js`）**：`release` 与 `replace-asset` 这两条会改
 *   「同学点下载拿到的那一份字节」，所以它们先看 `manifest.version_name` ——
 *   带 `experimental`（当前工作树是 1.3.1 实验支线）就当场挡下并给出口，**不联网、不读令牌**。
 *   这一条不是装饰：`replace-asset` 取的本地包是按**当前工作树的版本号**推的，
 *   在实验支线上跑它，上传的就是实验版那份，而附件名仍是线上的 `omitone.zip` ——
 *   命令照样打印成功，README 那条永久直链却从此给所有人发实验版（AGENTS §3.8）。
 *   `verify` / `notes` / `push` 不受影响（只读核验是发版流程**必跑**的一发，挡死它就是造一条恒红的守卫）。
 *
 * 令牌：优先读环境变量 GITHUB_TOKEN，其次读**用户主目录**下的
 *   `~/.omitone-release.ghtoken` —— 用户主目录下的一个文件。
 *
 * ⚠️ 令牌路径**刻意放在仓库之外**，原因是安全，不是随手：
 *   1) 仓库内的文件哪怕 .gitignore 挡住了，也随时可能被 `git add -f`、
 *      被别的工具打包、或被 AI 自己误读进上下文；用户在 Windows 下还有 OneDrive 同步
 *      （主目录下的一部分会被同步到云端）等意外扩散途径。
 *   2) 放在用户主目录 + 收紧 ACL（只允许本账户读写）二者叠加，
 *      仓库怎么折腾都不会碰到它。
 *   3) 这个文件按**有效期内复用**来用：当前那枚 PAT 的有效期由用户自己定（2026-11-21 起是一个月），
 *      每轮发预览包都直接读它 —— **不要**催用户 revoke，也不要主动删它（口径见 AGENTS.md §7.5）。
 *
 *   为什么以"文件"为准而不是环境变量：本机实测让令牌经环境变量传入
 *   连续 3 次都是空值（见 AGENTS.md §7.6），只有写文件这条通路是可靠的。
 *   所以设计成"把文件放对地方"，而不是去赌环境变量。
 *
 * ⚠️ 附件名由本脚本**写死**，不接受参数 —— 这是刻意的：
 *   README 顶部的下载入口用的是 GitHub 的永久链接
 *   `https://github.com/<owner>/<repo>/releases/latest/download/omitone.zip`，
 *   它按**附件名**取最新一版的附件。一旦附件改名或带上版本号，这个链接立刻失效，
 *   而失效的表现是"新用户点下载看到 404"——不会报错、不会留日志，只有人默默走掉。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var channelGate = require('./channel-gate.js');
var OWNER = 'TYT0807';
var REPO = 'Omitone';
var API = 'https://api.github.com';
var BRANCH = 'main';

/**
 * 固定附件名 —— 改这里等于改 README 的下载直链，别改。
 *
 * ⚠️ 附件名**必须是纯 ASCII**。GitHub 的上传接口会把非 ASCII 名字**悄悄洗掉**：
 * 实测传 `使用说明.pdf` 会返回 **201 成功**，但落在 Release 上的名字变成 `default.pdf`；
 * 而且从此**任何**非 ASCII 名字都返回 `422 already_exists`（它们被映射到同一个 `default.pdf`）。
 * 这个坑不改内容、不改状态码、只改名字 —— 不逐个核对附件名根本发现不了，
 * 而用户看到的就是 Release 页面上一个叫 `default.pdf` 的附件。
 *
 * 所以：仓库里的文件仍叫 `使用说明.pdf`（面向用户），**上传时的名字用 ASCII**。
 * `verify` 会逐个核对附件名，`check.js` 也会拦下非 ASCII 的附件名。
 */
var ASSETS = [
  { src: null, name: 'omitone.zip' },                 // src 在运行时按 manifest.version 推出
  { src: '使用说明.pdf', name: 'Omitone-manual.pdf' } // name 必须 ASCII（见上）
];

/**
 * 按扩展名判定二进制文件。
 *
 * 二进制必须走 base64 —— 当成 utf8 读会**静默损坏**内容：
 * PDF 会变成打不开的文件，而提交信息、接口返回码全都是成功的，看不出任何异常。
 * （这个坑在写本脚本时差点踩到：`使用说明.pdf` 正是要走这条路进仓库的）
 */
var BINARY_EXT = /\.(pdf|png|jpe?g|gif|webp|ico|zip|bin|woff2?|ttf|otf|mp4|mp3)$/i;

/**
 * 文本文件统一转成 LF 再上传。
 *
 * 为什么必须做：`git commit` 会按 `core.autocrlf` 与 `.editorconfig` 归一化换行符，
 * 而**走 API 提交是直接把磁盘字节塞进 blob，绕过了 git 的这一层**。
 *
 * 本仓库 `.editorconfig` 要求 `end_of_line = lf`，仓库里存的也确实是 LF，
 * 但工作区的 `.md` 是 CRLF（`core.autocrlf=true` 检出时转换的结果）。
 * 不归一化的话，提交上去的 README 会变成 CRLF —— 之后任何人
 * `git reset --hard` 再 `git diff`，都会看到**整个文件每一行都被改了**，
 * 真正的改动彻底淹没在里面。这类"看起来全变了"的 diff 最容易让人改错东西。
 */
function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------
function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  var file = tokenPath();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  console.error('没有找到令牌。');
  console.error('请把令牌写进 ' + file);
  console.error('（文件里只放令牌本身，不要引号、不要换行）');
  console.error('（那份文件按有效期内复用来用，不必每次重发；只有在用户说了之后才删 —— 见 AGENTS.md §7.5）');
  process.exit(1);
}

/** 令牌文件路径：用户主目录，刻意在仓库之外（原因见文件头注释）。 */
function tokenPath() {
  return path.join(require('os').homedir(), '.omitone-release.ghtoken');
}

/**
 * 请求头**延迟构造** —— 不要把 `token()` 放在模块顶层。
 * 因为 `check-msg` 子命令只做本地校验、根本不需要令牌，
 * 顶层读令牌会让它在没令牌的机器上直接退出（那是没必要的失败）。
 */
var _headers = null;
function headers() {
  if (!_headers) {
    _headers = {
      'Authorization': 'Bearer ' + token(),
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'omitone-release',
      'Content-Type': 'application/json'
    };
  }
  return _headers;
}

async function api(method, urlPath, body) {
  var opts = { method: method, headers: headers() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  var res = await fetch(API + urlPath, opts);
  var text = await res.text();
  var json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error(method + ' ' + urlPath + ' → ' + res.status + ' ' + text.slice(0, 400));
  return json;
}

var base = '/repos/' + OWNER + '/' + REPO;

function git(args, quiet) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024,
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit']
  });
}

function manifestVersion() {
  var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  return m.version;
}

/**
 * 某一版 Release 说明的**源文件**（`release-notes-<版本>.md`，版本号不带 v 前缀）。
 *
 * ⚠️ 找不到就返回 null，**不猜**："取目录里最新的那份"会在新版本刚建目录、
 * 说明还没落地时，把上一版的说明当成这一版的真源去比 —— 那是一条**恒红**的守卫，
 * 而恒红的守卫和没有守卫一样害人（AGENTS.md §5）。
 */
function notesPathFor(tag) {
  var version = String(tag || '').replace(/^v/, '');
  var file = path.join(ROOT, 'release-notes-' + version + '.md');
  return fs.existsSync(file) ? file : null;
}

/**
 * 说明里的**段标题**（每段开头 `**…**` 那一句），只用来在漂移时**点名是哪几段对不上**。
 *
 * ⚠️ 它**不是**判据 —— 判据是上面那次逐字比对。标题两边都可能改写
 * （同一件事换一种说法），拿它当判据会误报；只当"红的时候先告诉你往哪儿看"。
 */
function paraTitles(text) {
  var out = [];
  String(text).split(/\r?\n/).forEach(function (line) {
    var m = /^\*\*(.+?)\*\*/.exec(line.trim());
    if (m) out.push(m[1].replace(/\s+/g, ' ').slice(0, 24));
  });
  return out;
}

/**
 * 本地构建产物 `dist/omitone-<版本>.zip` 是不是**比要打进包的那批源文件还旧**。
 *
 * 为什么问这个：verify 原来只把**线上附件**跟**本地 dist** 比。可 dist 自己会过期 ——
 * 忘了 `npm run build` 时，两边都是旧包、逐字节一致，于是它打印
 * 「✓ 改动涉及的附件都已换成最新内容，用户下载到的东西是对的」，
 * 而工作区里的 `page.js` 早就是新的一份（2026-11-14 实测就撞在这条上：
 * 批次 51 已经拼进 page.js，verify 仍说包是对的）。
 * **那是假绿，比不查更糟** —— 它替你确认了一件没确认的事。
 *
 * 判据用 mtime，不比 zip 内容：比较的对象是"构建之后源码有没有再动过"，
 * 而 mtime 误判的方向是**多报一次红**（提示你重跑 build，无害），不会漏报。
 */
function distFreshness(version) {
  var zip = path.join(ROOT, 'dist', 'omitone-' + version + '.zip');
  if (!fs.existsSync(zip)) return { zip: null };
  var zipMtime = fs.statSync(zip).mtimeMs;
  var INCLUDE = (function () {
    try {
      var bs = fs.readFileSync(path.join(ROOT, 'tools', 'build.js'), 'utf8');
      var m = bs.match(/var INCLUDE\s*=\s*\[([\s\S]*?)\]/);
      if (!m) return null;
      return m[1].split(',').map(function (s) {
        return s.trim().replace(/^['"]|['"]$/g, '');
      }).filter(Boolean);
    } catch (e) { return null; }
  })();
  if (!INCLUDE) return { zip: zip, includeBroken: true };
  var newest = null;
  var walk = function (p, depth) {
    var st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      if (depth > 2) return;
      fs.readdirSync(p).forEach(function (name) { walk(path.join(p, name), depth + 1); });
      return;
    }
    if (!newest || st.mtimeMs > newest.mtimeMs) {
      newest = { file: path.relative(ROOT, p).replace(/\\/g, '/'), mtimeMs: st.mtimeMs };
    }
  };
  INCLUDE.forEach(function (entry) { walk(path.join(ROOT, entry), 0); });
  if (!newest) return { zip: zip, newest: null };
  return { zip: zip, newest: newest, stale: newest.mtimeMs > zipMtime };
}

/**
 * 提交信息主题的字数上限。
 *
 * GitHub 文件列表右侧那一列的提交信息只放得下 30~40 字，超了就截断成"…"，
 * 一列下来全是省略号。取 30 留点余量。
 */
var MSG_SUBJECT_MAX = 30;

/**
 * 提交信息的形状检查。
 *
 * 为什么在**提交这一端**拦，而不是只写进文档：
 * 文档只能提醒，而"顺手把整段说明写进提交正文"是非常自然的动作。
 * 而提交正文会**原样出现在 GitHub 文件列表的悬停卡片里** ——
 * 用户反馈过"把光标放过去会出现一大堆东西，看起来很不干净"。
 *
 * 实测接手时的情况：最近 25 条提交，主题平均 35 字、最长 60 字；
 * **25 条全都带正文**，正文平均 446 字、最长 834 字 —— 悬停出来就是一大块字。
 *
 * 详细说明请写进 `CHANGELOG.md`（它本来就是"为什么"的唯一真源），别在这儿重复一遍。
 */
function checkMessageShape(message) {
  var lines = String(message).split('\n');
  var subject = lines[0];
  var body = lines.slice(1).join('\n').trim();
  var problems = [];

  if (!subject.trim()) problems.push('主题是空的');
  if (subject.length > MSG_SUBJECT_MAX) {
    problems.push('主题 ' + subject.length + ' 字，超过 ' + MSG_SUBJECT_MAX +
      ' 字（文件列表那一列放不下，会被截断成"…"）');
  }
  if (body) {
    problems.push('带了 ' + body.length + ' 字正文 —— GitHub 悬停那张卡片会把正文整段显示出来；' +
      '详细说明请写进 CHANGELOG.md');
  }
  var prefix = subject.match(/^([A-Za-z]+)(\(.+?\))?!?:/);
  if (prefix) {
    problems.push('用了英文类型前缀「' + prefix[1] + ':」—— 本项目统一不用前缀，' +
      '和中文主题混排在一起很显脏');
  }
  return problems;
}

/** 只校验提交信息，不碰网络、不需要令牌。用法：check-msg <文件> */
function cmdCheckMsg(file) {
  if (!file) throw new Error('check-msg 需要一个提交信息文件');
  var message = fs.readFileSync(path.resolve(ROOT, file), 'utf8').replace(/\s+$/, '');
  var problems = checkMessageShape(message);
  if (problems.length) {
    console.error('提交信息不合格：');
    problems.forEach(function (p) { console.error('  · ' + p); });
    console.error('\n现在第一行: ' + String(message).split('\n')[0]);
    process.exitCode = 1;
    return;
  }
  var subject = String(message).split('\n')[0];
  console.log('提交信息合格：「' + subject + '」（' + subject.length + ' 字，无正文）');
}

function parseArgs(argv) {
  var flags = {};
  var positional = [];
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].slice(0, 2) === '--') {
      flags[argv[i].slice(2)] = argv[i + 1] && argv[i + 1].slice(0, 2) !== '--' ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags: flags, positional: positional };
}

// ---------------------------------------------------------------------------
// push：把工作区的改动提交到 main
//
// API 提交会被 GitHub 重新签名（页面上显示 Verified），远端 sha 必然 ≠ 本地 sha，
// 所以提交完必须 fetch + reset --hard 把本地对齐过去 —— 否则下一次提交的
// parent 会对不上，越走越乱。
// ---------------------------------------------------------------------------
async function cmdPush(files, messageFile, deletions) {
  if (!files.length && !deletions.length) throw new Error('push 需要至少一个文件路径或 --delete');
  if (!messageFile) throw new Error('push 需要 --message-file');

  var message = fs.readFileSync(path.resolve(ROOT, messageFile), 'utf8').replace(/\s+$/, '');

  // ⚠️ 形状检查放在**任何网络请求之前**：不合格就一个字节都不发出去，
  //    避免"提交了一半才发现信息不合格"
  var shapeProblems = checkMessageShape(message);
  if (shapeProblems.length) {
    console.error('提交信息不合格，已在发起任何请求之前拦下：');
    shapeProblems.forEach(function (p) { console.error('  · ' + p); });
    console.error('\n现在第一行: ' + String(message).split('\n')[0]);
    console.error('规则与原因见 AGENTS.md §3 第 5 条。');
    throw new Error('提交信息不合格，本次没有提交任何东西');
  }

  var ref = await api('GET', base + '/git/ref/heads/' + BRANCH);
  var parentSha = ref.object.sha;
  var parent = await api('GET', base + '/git/commits/' + parentSha);
  console.log('远端 ' + BRANCH + ' = ' + parentSha.slice(0, 7));

  var tree = [];
  for (var i = 0; i < files.length; i++) {
    var relPath = files[i].replace(/\\/g, '/');
    var abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + relPath);

    var buf = fs.readFileSync(abs);
    var isBinary = BINARY_EXT.test(relPath) || buf.indexOf(0) !== -1;
    // 二进制走 base64；判错的话文件会被静默写坏，所以扩展名与 0 字节双重判断。
    // 文本一律归一化成 LF —— 见 toLf() 的说明，不归一会污染整个仓库的 diff。
    var blob = await api('POST', base + '/git/blobs', isBinary
      ? { content: buf.toString('base64'), encoding: 'base64' }
      : { content: toLf(buf.toString('utf8')), encoding: 'utf-8' });
    tree.push({ path: relPath, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob ' + relPath + ' → ' + blob.sha.slice(0, 7) +
      (isBinary ? '  [' + (buf.length / 1024).toFixed(1) + ' KB 二进制/base64]' : ''));
  }

  // 删除：tree 里把 sha 置为 null 即可
  deletions.forEach(function (relPath) {
    relPath = relPath.replace(/\\/g, '/');
    tree.push({ path: relPath, mode: '100644', type: 'blob', sha: null });
    console.log('  删除 ' + relPath);
  });

  // base_tree 必须带：不带的话整棵树会被替换成只有这几个文件
  var newTree = await api('POST', base + '/git/trees', { base_tree: parent.tree.sha, tree: tree });
  var commit = await api('POST', base + '/git/commits', {
    message: message, tree: newTree.sha, parents: [parentSha]
  });
  console.log('  提交 → ' + commit.sha.slice(0, 7) + '  ' + commit.message.split('\n')[0]);

  // force 必须带：本地与远端的历史已经分叉，不加会 422 not a fast forward
  var upd = await api('PATCH', base + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: true });
  console.log('  ' + BRANCH + ' → ' + upd.object.sha.slice(0, 7));

  console.log('\n对齐本地（不要 push，代价见 AGENTS.md §7.3）...');
  git(['fetch', 'origin', BRANCH], true);
  git(['reset', '--hard', commit.sha], true);
  console.log('  本地已重置到 ' + commit.sha.slice(0, 7));
}

// ---------------------------------------------------------------------------
// release：打 tag + 建 Release + 传附件
// ---------------------------------------------------------------------------
async function cmdRelease(tag, notesFile) {
  if (!tag) throw new Error('release 需要 tag，例如 v1.1.2');
  // 通道闸：实验版支线不许公开建 Release（AGENTS §3.8）—— 挡在联网与读说明之前
  var gate = channelGate.blockReasonForRepo('release');
  if (gate) { console.log(gate); process.exitCode = 1; return; }
  if (!notesFile) throw new Error('release 需要 --notes-file');
  var body = fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8').replace(/\s+$/, '');

  var ref = await api('GET', base + '/git/ref/heads/' + BRANCH);
  var head = ref.object.sha;
  console.log('远端 ' + BRANCH + ' = ' + head.slice(0, 7));

  // 1) tag 指向**远端当前 sha**，不是本地 `git rev-parse HEAD`
  var tagObj = await api('POST', base + '/git/tags', {
    tag: tag, message: tag + ' — ' + manifestVersion(), object: head, type: 'commit'
  });
  var existing = null;
  try {
    existing = await api('GET', base + '/git/ref/tags/' + tag);
  } catch (e) { /* 不存在，正常 */ }

  if (existing) {
    await api('PATCH', base + '/git/refs/tags/' + tag, { sha: tagObj.sha, force: true });
    console.log('  tag ' + tag + ' 已存在 → 已更新到 ' + head.slice(0, 7));
  } else {
    await api('POST', base + '/git/refs', { ref: 'refs/tags/' + tag, sha: tagObj.sha });
    console.log('  tag ' + tag + ' 已创建 → ' + head.slice(0, 7));
  }

  // 2) Release
  var payload = { tag_name: tag, name: tag, body: body, draft: false, prerelease: false, target_commitish: BRANCH };
  var rel;
  try {
    rel = await api('POST', base + '/releases', payload);
    console.log('  release 已创建：' + rel.html_url);
  } catch (e) {
    if (!/already_exists/i.test(e.message)) throw e;
    var found = await api('GET', base + '/releases/tags/' + tag);
    rel = await api('PATCH', base + '/releases/' + found.id, payload);
    console.log('  release 已存在 → 已更新：' + rel.html_url);
  }

  // 3) 附件（名字写死，不接受参数）
  var version = manifestVersion();
  var wanted = ASSETS.map(function (a) {
    return { file: a.src || path.join('dist', 'omitone-' + version + '.zip'), name: a.name };
  });

  wanted.forEach(function (w) {
    if (!fs.existsSync(path.join(ROOT, w.file))) {
      throw new Error('缺附件源文件 ' + w.file +
        '（跑 `npm run build` 或 `npm run manual` 生成）');
    }
  });

  var current = await api('GET', base + '/releases/' + rel.id + '/assets');
  for (var i = 0; i < wanted.length; i++) {
    var w = wanted[i];
    var old = current.filter(function (a) { return a.name === w.name; })[0];
    if (old) {
      await api('DELETE', base + '/releases/assets/' + old.id);
      console.log('  删除同名旧附件 ' + w.name);
    }
    var data = fs.readFileSync(path.join(ROOT, w.file));
    var res = await fetch('https://uploads.github.com' + base + '/releases/' + rel.id +
      '/assets?name=' + encodeURIComponent(w.name), {
      method: 'POST',
      headers: Object.assign({}, headers(), { 'Content-Type': 'application/octet-stream' }),
      body: data
    });
    var text = await res.text();
    if (!res.ok) throw new Error('附件上传失败 ' + res.status + ' ' + text.slice(0, 300));
    console.log('  附件 ' + w.name + ' (' + (data.length / 1024).toFixed(1) + ' KB)');
  }

  console.log('\n下一步必须核验：node tools/github-release.js verify ' + tag);
}

// ---------------------------------------------------------------------------
// notes：**只改** Release 那一页的说明 —— 不动 tag、不动附件、不重发版本。
//
// 为什么要有这条命令（2026-11-14 加）：AGENTS.md §3.7 要求"小修复并进当前版本的说明"，
// 而以前这一步每次都是**临时 curl 直接 PATCH 线上**，从没把改后的文字回写
// `release-notes-<版本>.md`。两边各写各的，最后真的漂移到互缺半段（实测：
// 线上少了批次 38/40/44，源文件少了批次 33/34），而且**没有任何一条守卫响过**。
// 规矩从此是：**说明只改源文件**，再跑 `notes` 把源文件推上去；`verify` 逐字比那两份。
// ---------------------------------------------------------------------------
async function cmdNotes(tag, notesFile) {
  if (!tag) throw new Error('notes 需要 tag，例如 v1.3.0');
  var file = notesFile ? path.resolve(ROOT, notesFile) : notesPathFor(tag);
  if (!fs.existsSync(file)) throw new Error('说明源文件不存在：' + file);
  var body = fs.readFileSync(file, 'utf8').replace(/\s+$/, '');

  var rel = await api('GET', base + '/releases/tags/' + tag);
  var before = rel.body.length;
  if (body === rel.body.replace(/\s+$/, '')) {
    console.log('线上说明与 ' + path.relative(ROOT, file) + ' 已一致（' + before + ' 字），无需改动');
    return;
  }
  var updated = await api('PATCH', base + '/releases/' + rel.id, { body: body });
  console.log('说明已更新：' + updated.html_url);
  console.log('  ' + before + ' 字 → ' + updated.body.length + ' 字（源文件 ' + path.relative(ROOT, file) + '）');
  console.log('  updated_at ' + updated.updated_at);
}

// ---------------------------------------------------------------------------
// replace-asset：把某个 Release 的附件换成当前本地构建的**同名**附件
//
// 为什么需要它：tag 打完之后，如果 main 上又落了**会影响安装包**的改动
// （page.js / content.js / 使用说明.pdf 之类），线上那个附件就是旧的了 ——
// 用户点下载拿到的是修复前的版本，而版本号和徽章看起来都是新的。
// `verify` 会把这个情况报出来，并提示「直接替换该附件即可（删旧 assets → 重传同名），
// 不必重发整版」。这条命令就是把那句提示变成可执行的一步，免得每次手工调接口。
//
// ⚠️ 附件名必须与 ASSETS 声明**逐字一致**：README 那条永久下载链接按附件名取，
// 改了名字链接立刻 404，而且受影响的是"只会点这一个链接"的那批用户（AGENTS.md §7.5）。
//
// 判重按 **sha256 摘要**比（接口没给摘要时才退回字节数，并把这条说出来）——
// 与 `verify` 用同一把尺，否则这里"跳过"、那里"过期"，两条命令互相打脸。
// ---------------------------------------------------------------------------
async function cmdReplaceAsset(tag) {
  if (!tag) throw new Error('replace-asset 需要 tag，例如 v1.1.6');
  // 通道闸：这一份会按**当前工作树的版本号**取 dist 里的包，却挂到线上那个固定附件名上 ——
  // 在实验支线上跑它，等于把实验版发成同学下载的官方版（AGENTS §3.8）
  var gateAsset = channelGate.blockReasonForRepo('replace-asset');
  if (gateAsset) { console.log(gateAsset); process.exitCode = 1; return; }

  var version = manifestVersion();
  var wanted = ASSETS.map(function (a) {
    return { file: a.src || path.join('dist', 'omitone-' + version + '.zip'), name: a.name };
  });
  wanted.forEach(function (w) {
    if (!fs.existsSync(path.join(ROOT, w.file))) {
      throw new Error('缺附件源文件 ' + w.file + '（先跑 npm run build 或 npm run manual）');
    }
  });

  var rel = await api('GET', base + '/releases/tags/' + tag);
  console.log('release ' + tag + ' → ' + rel.html_url);

  var current = await api('GET', base + '/releases/' + rel.id + '/assets');
  var changed = 0;

  for (var i = 0; i < wanted.length; i++) {
    var w = wanted[i];
    var localPath = path.join(ROOT, w.file);
    var localSize = fs.statSync(localPath).size;
    var localSha = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
    var old = current.filter(function (a) { return a.name === w.name; })[0];

    // ⚠️ 判重按 **sha256 摘要**，与 `verify` 同一把尺（`verify` 那段注释已经写明：
    // 字节数相等不等于内容相等）。实测踩过：本命令原先只比字节数，
    // 一批只改文档的构建把**构建戳**换掉了（zip 大小一位没变），于是这里打印
    // 「omitone.zip 已是最新 —— 跳过」，紧接着 `verify` 按摘要报「本地 a612… ≠ 线上 ab5c…」，
    // 同一件事两个命令互相打脸。**跳过判据比核验判据松，就等于每次都靠 verify 兜底。**
    // 接口没给摘要（附件刚上传完 digest 可能为 null）时才退回比大小，并把这条明说出来。
    if (old && old.digest) {
      if (String(old.digest).replace(/^sha256:/, '') === localSha) {
        console.log('  ' + w.name + ' 已是最新（sha256 ' + localSha.slice(0, 12) + '…）—— 跳过');
        continue;
      }
      console.log('  ' + w.name + ' 摘要不一致（本地 ' + localSha.slice(0, 12) + '… ≠ 线上 ' +
        String(old.digest).replace(/^sha256:/, '').slice(0, 12) + '…）—— 替换');
    } else if (old && old.size === localSize) {
      console.log('  ' + w.name + ' 已是最新（' + (localSize / 1024).toFixed(1) +
        ' KB，接口未给摘要，只比了字节数）—— 跳过');
      continue;
    }
    if (old) {
      await api('DELETE', base + '/releases/assets/' + old.id);
      console.log('  删除旧附件 ' + w.name + '（' + (old.size / 1024).toFixed(1) + ' KB）');
    } else {
      console.log('  线上没有 ' + w.name + '，新增');
    }

    var data = fs.readFileSync(path.join(ROOT, w.file));
    var res = await fetch('https://uploads.github.com' + base + '/releases/' + rel.id +
      '/assets?name=' + encodeURIComponent(w.name), {
      method: 'POST',
      headers: Object.assign({}, headers(), { 'Content-Type': 'application/octet-stream' }),
      body: data
    });
    var text = await res.text();
    if (!res.ok) throw new Error('附件上传失败 ' + res.status + ' ' + text.slice(0, 300));
    console.log('  上传 ' + w.name + ' (' + (data.length / 1024).toFixed(1) + ' KB)');
    changed++;
  }

  if (!changed) console.log('\n没有需要替换的附件。');
  else console.log('\n下一步必须核验：node tools/github-release.js verify ' + tag);
}

// ---------------------------------------------------------------------------
// preview：把**当前实验支线**那份构建挂到一条独立的预览口上
//
// 用户口径（2026-11-20）：「实验班也可以加入 readme 的正常下载的旁边，特别标明就行」
// 「更新提示那边也可以展示预览版……需要多斟酌考虑」。所以实验版不再是"没有下载口"，
// 而是**有口，但和正式版是两个东西**。这一条命令就是把那一格实现出来。
//
// ⚠️ 三条不许越过的线（每条都有实测的事故形状垫着）：
//   1) **附件名不与稳定版共用**。`releases/latest/download/omitone.zip` 是按**名字**取件的，
//      预览包要是也叫 `omitone.zip`，README 那条永久直链就会给所有人发实验版 ——
//      而命令照样打印成功（1.2.9 那次「下载到的其实是 1.2.8」就是同一族的形状）。
//   2) **`prerelease: true`**。GitHub 的 `/releases/latest` 只认「最近创建的、非草稿、非预发布」那一版，
//      这一个字段就是预览口抢不走正式直链的**唯一**保证；漏写一次，直链当场换人。
//      所以发布后**必须**回读一次并把它当判据（见 assertStableChannelIntact）。
//   3) **tag `preview` 指在远端已有的那个提交上**，不指本地没推的 HEAD ——
//      否则线上包与仓库里的源码对不上，事后没人能复现同学装的是哪一份字节。
//
// 用法：node tools/github-release.js preview
// ---------------------------------------------------------------------------
var PREVIEW_TAG = 'preview';
var PREVIEW_NOTES = 'release-notes-preview.md';
var PREVIEW_ASSETS = [
  { src: null, name: 'omitone-preview.zip' },                 // src 在运行时按 manifest.version 推出
  { src: '使用说明.pdf', name: 'Omitone-manual-preview.pdf' }
];
// 稳定通道那两个名字 —— 预览这一发**一个都不许碰**
var STABLE_ONLY_NAMES = ['omitone.zip', 'Omitone-manual.pdf'];
// 「工作树脏不脏」只按**进包的那批**判：dist/ 与 notes/ 里的残留不该挡发版
var PACKAGED_FOR_DIRTY_CHECK = ['manifest.json', 'page.js', 'content.js', 'background.js',
  'libs', 'popup', 'resources', 'src'];

async function cmdPreview() {
  // 通道闸：预览口只给实验支线用（问在联网与读令牌之前，§3.8）
  var gatePreview = channelGate.blockReasonForRepo('preview');
  if (gatePreview) { console.log(gatePreview); process.exitCode = 1; return; }

  var version = manifestVersion();
  var names = channelGate.readChannelNames();

  // ---- 本地四道前置（全部联网之前，一道不过就一个字都不动）----
  var notesFile = path.join(ROOT, PREVIEW_NOTES);
  if (!fs.existsSync(notesFile)) {
    throw new Error('缺预览说明源文件 ' + PREVIEW_NOTES +
      '（正文只从它读，不接受手写 —— 与 notes 子命令同一规矩）');
  }
  var body = fs.readFileSync(notesFile, 'utf8').replace(/\s+$/, '');
  if (body.indexOf(version) === -1) {
    throw new Error(PREVIEW_NOTES + ' 里没出现当前版本号 ' + version +
      ' —— 说明还停在上一版，发出去就是「包是新的、那一页写的是旧的」');
  }

  var wanted = PREVIEW_ASSETS.map(function (a) {
    return { file: a.src || path.join('dist', 'omitone-' + version + '.zip'), name: a.name };
  });
  wanted.forEach(function (w) {
    if (!fs.existsSync(path.join(ROOT, w.file))) {
      throw new Error('缺附件源文件 ' + w.file + '（跑 `npm run build` 或 `npm run manual` 生成）');
    }
  });

  var fresh = distFreshness(version);
  if (fresh.includeBroken) {
    throw new Error('读不出 tools/build.js 的 INCLUDE 清单 —— 「包是不是新的」这一格判不了就别发');
  }
  if (fresh.stale) {
    throw new Error('dist/omitone-' + version + '.zip 比 ' + fresh.newest.file + ' 还旧 —— 先 npm run build，' +
      '否则预览口给的是改动之前的字节');
  }

  var branch = String(git(['rev-parse', '--abbrev-ref', 'HEAD'], true)).trim();
  var localHead = String(git(['rev-parse', 'HEAD'], true)).trim();
  var dirty = String(git(['status', '--porcelain', '--'].concat(PACKAGED_FOR_DIRTY_CHECK), true)).trim();
  if (dirty) {
    throw new Error('进包的那批文件里有未提交的改动：\n      ' + dirty.split(/\r?\n/).join('\n      ') +
      '\n  → 预览包会带着仓库里查不到的字节上线；先提交（或还原）再发');
  }

  // ---- 远端必须已经有这一支的同一个提交 ----
  var ref;
  try {
    ref = await api('GET', base + '/git/ref/heads/' + branch);
  } catch (e) {
    throw new Error('远端没有分支 ' + branch + '（' + e.message.slice(0, 120) +
      '）—— 预览包的源码要能在仓库里找到，先把这一支推上去');
  }
  var remoteHead = ref.object.sha;
  if (remoteHead !== localHead) {
    throw new Error('本地 HEAD ' + localHead.slice(0, 7) + ' ≠ 远端 ' + branch + ' ' + remoteHead.slice(0, 7) +
      ' —— 先把这一支 push 上去（tag 只能指在推上去的那份代码上）');
  }
  console.log('通道         预览（' + names.version_name + '）');
  console.log('远端 ' + branch + ' = ' + remoteHead.slice(0, 7));

  // ---- tag preview 指向远端当前 head（移动 tag，不是版本 tag）----
  var tagObj = await api('POST', base + '/git/tags', {
    tag: PREVIEW_TAG, message: 'preview — ' + names.version_name, object: remoteHead, type: 'commit'
  });
  var existing = null;
  try {
    existing = await api('GET', base + '/git/ref/tags/' + PREVIEW_TAG);
  } catch (e) { /* 第一次发，正常 */ }
  if (existing) {
    await api('PATCH', base + '/git/refs/tags/' + PREVIEW_TAG, { sha: tagObj.sha, force: true });
    console.log('  tag ' + PREVIEW_TAG + ' 已移动 → ' + remoteHead.slice(0, 7));
  } else {
    await api('POST', base + '/git/refs', { ref: 'refs/tags/' + PREVIEW_TAG, sha: tagObj.sha });
    console.log('  tag ' + PREVIEW_TAG + ' 已创建 → ' + remoteHead.slice(0, 7));
  }

  // ---- Release（prerelease:true 是不抢 /releases/latest 的唯一保证）----
  var payload = {
    tag_name: PREVIEW_TAG, name: '预览版 ' + names.version_name, body: body,
    draft: false, prerelease: true, target_commitish: branch
  };
  var rel;
  try {
    rel = await api('POST', base + '/releases', payload);
    console.log('  预览 Release 已创建：' + rel.html_url);
  } catch (e) {
    if (!/already_exists/i.test(e.message)) throw e;
    var found = await api('GET', base + '/releases/tags/' + PREVIEW_TAG);
    rel = await api('PATCH', base + '/releases/' + found.id, payload);
    console.log('  预览 Release 已存在 → 已更新：' + rel.html_url);
  }

  // ---- 附件（按 sha256 判重，与 replace-asset 同一把尺）----
  for (var i = 0; i < wanted.length; i++) {
    var w = wanted[i];
    var localPath = path.join(ROOT, w.file);
    var data = fs.readFileSync(localPath);
    var localSha = crypto.createHash('sha256').update(data).digest('hex');
    var current = await api('GET', base + '/releases/' + rel.id + '/assets');
    var old = current.filter(function (a) { return a.name === w.name; })[0];
    if (old && old.digest && String(old.digest).replace(/^sha256:/, '') === localSha) {
      console.log('  ' + w.name + ' 已是最新（sha256 ' + localSha.slice(0, 12) + '…）—— 跳过');
      continue;
    }
    if (old) {
      await api('DELETE', base + '/releases/assets/' + old.id);
      console.log('  删除旧预览附件 ' + w.name + '（' + (old.size / 1024).toFixed(1) + ' KB）');
    }
    var res = await fetch('https://uploads.github.com' + base + '/releases/' + rel.id +
      '/assets?name=' + encodeURIComponent(w.name), {
      method: 'POST',
      headers: Object.assign({}, headers(), { 'Content-Type': 'application/octet-stream' }),
      body: data
    });
    var text = await res.text();
    if (!res.ok) throw new Error('附件上传失败 ' + res.status + ' ' + text.slice(0, 300));
    console.log('  上传 ' + w.name + ' (' + (data.length / 1024).toFixed(1) + ' KB) sha256 ' + localSha.slice(0, 12) + '…');
  }

  // ---- 发布后自证：稳定通道那一条直链没有被这一发顶掉 ----
  var okIntact = await assertStableChannelIntact(rel.id, wanted);
  console.log('\n预览入口：https://github.com/' + OWNER + '/' + REPO +
    '/releases/download/' + PREVIEW_TAG + '/' + PREVIEW_ASSETS[0].name);
  if (!okIntact) process.exitCode = 1;
}

/**
 * **这一发预览有没有把正式版直链抢走** —— 回读，不靠"我记得写了 prerelease"。
 *
 * 为什么单独成一格：`releases/latest` 的行为由 `prerelease` / `draft` 两个字段决定，
 * 而这两个字段**写错了接口照样返回 200**，README 那条永久直链却当场换人。
 * 判据全部从线上读回来（本地不猜）：任何一条不成立就退出非零并说清怎么手工处置。
 */
async function assertStableChannelIntact(previewRelId, wanted) {
  var problems = [];
  var latest = await api('GET', base + '/releases/latest');
  var latestAssets = await api('GET', base + '/releases/' + latest.id + '/assets');
  var latestNames = latestAssets.map(function (a) { return a.name; });
  console.log('\n线上正式通道 /releases/latest → ' + latest.tag_name +
    '（prerelease=' + latest.prerelease + '，附件 ' + latestNames.join(' / ') + '）');

  if (latest.tag_name === PREVIEW_TAG) {
    problems.push('/releases/latest 指向了 preview —— 同学点「下载插件」拿到的会是实验版');
  }
  if (latest.prerelease) problems.push('/releases/latest 那一版 prerelease=true，它不是稳定版');
  if (latestNames.indexOf(STABLE_ONLY_NAMES[0]) < 0) {
    problems.push('/releases/latest 里没有 ' + STABLE_ONLY_NAMES[0] + ' —— README 那条永久直链是死链');
  }

  var prevAssets = await api('GET', base + '/releases/' + previewRelId + '/assets');
  var prevNames = prevAssets.map(function (a) { return a.name; });
  console.log('预览通道 /releases/tags/preview → 附件 ' + prevNames.join(' / '));
  wanted.forEach(function (w) {
    var a = prevAssets.filter(function (x) { return x.name === w.name; })[0];
    if (!a) { problems.push('预览 Release 里没有 ' + w.name); return; }
    if (a.state && a.state !== 'uploaded') problems.push(w.name + ' 的 state=' + a.state + '（不是 uploaded）');
    var localSize = fs.statSync(path.join(ROOT, w.file)).size;
    if (a.size !== localSize) {
      problems.push(w.name + ' 线上 ' + a.size + ' 字节 ≠ 本地 ' + localSize + ' 字节 —— 传坏了或没传完');
    }
  });
  // 最硬的一格：两个通道的附件名不许有任何交集
  var shared = prevNames.filter(function (n) { return STABLE_ONLY_NAMES.indexOf(n) >= 0; });
  if (shared.length) {
    problems.push('预览 Release 里混进了稳定通道的附件名 ' + shared.join(' / ') +
      ' —— 按名字取件的那条永久直链会被实验版顶掉');
  }

  if (problems.length) {
    console.error('\n✗ 预览发布后自证没通过：\n      ' + problems.join('\n      '));
    console.error('  → 这一族不是"少个附件"，是**同学下载到的那一份变了**。请立刻到 ' +
      'https://github.com/' + OWNER + '/' + REPO + '/releases 上人工确认，必要时删掉那一版 Release。');
    return false;
  }
  console.log('  ✓ 两条通道没有交集：正式版直链照旧给 ' + latest.tag_name + ' 的 ' + STABLE_ONLY_NAMES[0]);
  return true;
}

// ---------------------------------------------------------------------------
// verify：核验远端（**只看接口返 200 不算数**，要确认附件状态与 tag 指向）
// ---------------------------------------------------------------------------

/**
 * verify 的**通道期望表** —— #203 的落点。
 *
 * 为什么必须有这一张表：`verify preview` 原先把**正式通道**的期望（要 `omitone.zip`
 * 与 `Omitone-manual.pdf` 这两个名字、要那条 `latest/download/omitone.zip` 直链能用、
 * 要 tag 不落后 `main`）套在预览那一发上问。预览天生不带那两个名字、也不该带
 * （带上了就等于抢走 `/releases/latest`，见 `assertStableChannelIntact`），
 * 于是**每轮发完预览包都必须跑的那条验收命令恒红**，红的还是三条结构上不可能成立的断言 ——
 * 「不会失败的检查等于没有检查」（AGENTS §5），而反过来「恒红的检查等于没有检查」同样成立：
 * 人会开始跳过这一步，六件套的第 ⑥ 件就没人真在验收。
 *
 * ⚠️ 这一族有**第四条**同一根因的缺陷，比那三条更隐蔽：下面按内容核对附件是否过期时，
 *   原先拿 `ASSETS` 找"改了 使用说明.pdf 该比哪一个附件"，在预览通道上它比的是
 *   **正式说明书** `Omitone-manual.pdf`，而不是 `Omitone-manual-preview.pdf` ——
 *   症状与"附件已经换过"同形，而且报的是**另一个通道的字节**。
 *   所以 `assetTable` / `zipName` / `permalink` / `forbiddenNames` 必须一起从这张表取，
 *   不许只把名字那一处改对。
 *
 * ⚠️ 稳定通道那一支的期望**一位都没松**（`wantNames` 仍是 `ASSETS`、直链仍查 `omitone.zip`、
 *   比对基准仍是 `main`）。判据不许为了预览那一发变绿而放宽正式版（AGENTS §2 #23 同一族）。
 */
function verifyExpectations(tag) {
  var isPreview = String(tag) === PREVIEW_TAG;
  var table = isPreview ? PREVIEW_ASSETS : ASSETS;
  var zipName = pickZipAssetName(table);
  return {
    channel: isPreview ? 'preview' : 'stable',
    assetTable: table,
    wantNames: table.map(function (a) { return a.name; }),
    zipName: zipName,
    // 预览入口是固定 tag 那一族的永久直链（与 latest 互不顶替，见 cmdPreview 末尾打印的那一条）
    permalink: 'https://github.com/' + OWNER + '/' + REPO + '/releases/' +
      (isPreview ? 'download/' + PREVIEW_TAG + '/' : 'latest/download/') + zipName,
    forbiddenNames: isPreview ? STABLE_ONLY_NAMES.slice() : [],
    requirePrerelease: isPreview,
    // 比对基准：稳定通道写死 main；预览通道的"有没有落后"要对着**这一发自己发布到的那一条分支**
    baseBranch: isPreview ? '' : BRANCH
  };
}

/** 从附件表里挑 zip —— 按下标 0 取会在表换序时把 pdf 当成包，按结尾认则不会。 */
function pickZipAssetName(table) {
  var z = (table || []).filter(function (a) { return /\.zip$/i.test(String(a.name)); })[0];
  return z ? z.name : '';
}

/**
 * 纯判定：线上读回来的附件名 + `prerelease` ↔ 通道期望。
 *
 * 抽成不联网的函数是为了**离线自测**（`verify-expect`，与 `check-msg` 同一先例）——
 * 这一族的判定要能对着假读数跑，否则每次改期望表都要真发一次版才测得到。
 */
function verifyChannelReadout(want, gotNames, prerelease) {
  var out = { wrongNames: [], foundForbidden: [], linkOk: false, prereleaseOk: true };
  out.wrongNames = want.wantNames.filter(function (n) { return gotNames.indexOf(n) === -1; });
  out.foundForbidden = (want.forbiddenNames || []).filter(function (n) {
    return gotNames.indexOf(n) >= 0;
  });
  out.linkOk = String(want.zipName || '') !== '' && gotNames.indexOf(want.zipName) >= 0;
  if (want.requirePrerelease && prerelease !== true) out.prereleaseOk = false;
  return out;
}

/**
 * 离线自测：`node tools/github-release.js verify-expect`
 * —— 不发请求、不要令牌，把上面两个函数对着已知读数跑一遍。
 * 每一格都要**独立承重**：既有"预览该绿"，也要有"预览拿正式名字必须红"那几格。
 */
function cmdVerifyExpect() {
  var prev = verifyExpectations(PREVIEW_TAG);
  var stable = verifyExpectations('v1.3.0');
  var prevNames = prev.wantNames.slice();
  var stableNames = stable.wantNames.slice();
  var readPrevOk = verifyChannelReadout(prev, prevNames, true);
  var readPrevWithStableNames = verifyChannelReadout(prev, stableNames, true);
  var readStableOk = verifyChannelReadout(stable, stableNames, true);
  var readPrevNotPrerelease = verifyChannelReadout(prev, prevNames, false);
  var readEmptyPrev = verifyChannelReadout(prev, [], true);
  var readEmptyStable = verifyChannelReadout(stable, [], true);
  var readUnknownTag = verifyChannelReadout(verifyExpectations('v9.9.9'), stableNames, true);
  var zipReordered = pickZipAssetName([
    { src: '使用说明.pdf', name: 'Omitone-manual-preview.pdf' },
    { src: null, name: 'omitone-preview.zip' }
  ]);

  var cells = [
    {
      name: '预览通道的期望附件名取自 PREVIEW_ASSETS，不写死',
      ok: prev.channel === 'preview' && prevNames.join(',') === PREVIEW_ASSETS.map(function (a) { return a.name; }).join(','),
      detail: 'channel=' + prev.channel + ' names=' + prevNames.join(',')
    },
    {
      name: '预览的 zip 名与直链走 download/preview 那一族（不查 latest）',
      ok: prev.zipName === 'omitone-preview.zip' &&
        prev.permalink.indexOf('/releases/download/preview/omitone-preview.zip') >= 0 &&
        prev.permalink.indexOf('latest') === -1,
      detail: prev.permalink
    },
    {
      name: '预览线上只有预览那两个名字 → 三条假红全消（#203 的正格）',
      ok: !readPrevOk.wrongNames.length && readPrevOk.linkOk &&
        !readPrevOk.foundForbidden.length && readPrevOk.prereleaseOk,
      detail: JSON.stringify(readPrevOk)
    },
    {
      name: '预览线上摆着正式那两个名字 → 缺额与越界各自都红（反向对照，尺不是恒绿）',
      ok: readPrevWithStableNames.wrongNames.length === prevNames.length &&
        readPrevWithStableNames.foundForbidden.length === STABLE_ONLY_NAMES.length &&
        readPrevWithStableNames.linkOk === false,
      detail: JSON.stringify(readPrevWithStableNames)
    },
    {
      name: '稳定通道期望一位没松：仍要正式那两个名字与 omitone.zip 直链',
      ok: stable.channel === 'stable' &&
        stableNames.join(',') === ASSETS.map(function (a) { return a.name; }).join(',') &&
        stable.zipName === 'omitone.zip' &&
        stable.permalink.indexOf('/releases/latest/download/omitone.zip') >= 0 &&
        stable.baseBranch === BRANCH && !stable.forbiddenNames.length &&
        !readStableOk.wrongNames.length && readStableOk.linkOk && readStableOk.prereleaseOk,
      detail: 'names=' + stableNames.join(',') + ' base=' + stable.baseBranch
    },
    {
      name: '预览那一发没标 prerelease 单独红（它一抢 latest 就顶掉正式直链）',
      ok: readPrevNotPrerelease.prereleaseOk === false &&
        verifyChannelReadout(stable, stableNames, false).prereleaseOk === true,
      detail: '预览 prerelease=false → ' + readPrevNotPrerelease.prereleaseOk
    },
    {
      name: '空附件清单两个通道都报缺额，不许读成「没什么问题」',
      ok: readEmptyPrev.wrongNames.length === prevNames.length && !readEmptyPrev.linkOk &&
        readEmptyStable.wrongNames.length === stableNames.length && !readEmptyStable.linkOk,
      detail: '预览缺 ' + readEmptyPrev.wrongNames.length + ' / 正式缺 ' + readEmptyStable.wrongNames.length
    },
    {
      name: '认不出的 tag 按稳定通道走，不许猜成预览（猜错就把正式直链的核验跳过）',
      ok: verifyExpectations('v9.9.9').channel === 'stable' && !readUnknownTag.wrongNames.length &&
        verifyExpectations('').channel === 'stable' &&
        verifyExpectations(PREVIEW_TAG + '-x').channel === 'stable',
      detail: 'v9.9.9 → ' + verifyExpectations('v9.9.9').channel
    },
    {
      name: '附件表换序后 zip 仍按 .zip 结尾认出（按下标取会把 pdf 当成包）',
      ok: zipReordered === 'omitone-preview.zip' && pickZipAssetName([]) === '',
      detail: '换序 → ' + zipReordered
    },
    {
      name: '预览的禁止名就是 STABLE_ONLY_NAMES 那份引用（改表就跟着改，不另写一份）',
      ok: prev.forbiddenNames.join(',') === STABLE_ONLY_NAMES.join(',') &&
        prev.assetTable === PREVIEW_ASSETS && stable.assetTable === ASSETS,
      detail: 'forbidden=' + prev.forbiddenNames.join(',')
    }
  ];

  var fails = cells.filter(function (c) { return !c.ok; });
  fails.forEach(function (c) { console.log('  [FAIL] ' + c.name + ' → ' + c.detail); });
  if (fails.length) {
    console.log('\nverify 通道期望自测未通过：' + fails.length + ' / ' + cells.length + ' 格红');
    process.exitCode = 1;
    return;
  }
  console.log('自测通过（共 ' + cells.length + ' 格）—— 通道期望不联网即可核对');
}

async function cmdVerify(tag) {
  if (!tag) throw new Error('verify 需要 tag');

  // ⚠️ 期望按通道取（#203）—— 预览那一发的附件名、直链、"落后于哪一条分支"都不是正式通道那套
  var want = verifyExpectations(tag);

  var tagRef = await api('GET', base + '/git/ref/tags/' + tag);
  var tagObj = await api('GET', base + '/git/tags/' + tagRef.object.sha);
  var tagTarget = tagObj.object.sha;
  // tag 与基准分支的关系用 compare 接口判定（见下方 compareAfterTag）
  console.log('tag ' + tag + '     ' + tagTarget);

  var rel = await api('GET', base + '/releases/tags/' + tag);
  console.log('release        ' + rel.html_url);
  console.log('通道           ' + want.channel + '（期望附件 ' + want.wantNames.join(' / ') + '）');
  console.log('draft          ' + rel.draft + ' / prerelease ' + rel.prerelease + ' / 说明 ' + rel.body.length + ' 字');

  // 基准分支：稳定通道照旧是 main；预览通道要比的是**这一发自己发布到的那一条**（读线上，不猜）。
  // 读不到就单独红 —— 不许把"比不了"实现成"跳过比较然后打印一致"（§2 #12/#14 同一族）。
  var baseBranch = want.baseBranch || String(rel.target_commitish || '').trim();
  var head = '';
  if (!baseBranch) {
    console.log('\n  ✗ 这一发预览的 release 没写 target_commitish —— 无法判断 tag 有没有落后于分支，' +
      '不能拿"没比"当"比过且一致"');
  } else {
    try {
      var ref = await api('GET', base + '/git/ref/heads/' + baseBranch);
      head = ref.object.sha;
      console.log('远端 ' + baseBranch + '   ' + head);
    } catch (eBranch) {
      console.log('\n  ✗ 远端读不到基准分支 ' + baseBranch + '（' + eBranch.message.slice(0, 120) +
        '）—— 「tag 有没有落后」这一格判不了');
    }
  }

  // ⚠️ 附件列表必须走 `/releases/{id}/assets` 这个**子端点**，
  //    不能读 release 响应里内嵌的 `assets` 字段 —— **那个字段可能是空的**。
  //
  //    实测（2026-09-23，v1.2.8）：内嵌 `assets` 是 `[]`，
  //    而同一时刻子端点正常返回 2 个附件（`state=uploaded`，大小也对），
  //    下载直链拿回来的字节与本地构建**逐字节一致**。
  //    读内嵌字段的后果是：把一个**完好的 Release 判成"附件缺失、下载入口是死链"**，
  //    还退出码 1 —— 让人以为发版坏了，实际什么都没坏。
  //    （`replace-asset` 那两条路早就用的是子端点，只有 verify 读错了地方。）
  var relAssets = await api('GET', base + '/releases/' + rel.id + '/assets');
  if (!Array.isArray(relAssets)) relAssets = [];

  var bad = [];
  relAssets.forEach(function (a) {
    var ok = a.state === 'uploaded';
    if (!ok) bad.push(a.name);
    console.log('  附件 ' + a.name + '  ' + (a.size / 1024).toFixed(1) + ' KB  state=' + a.state);
  });

  // 附件名必须与**这一通道**声明的逐字一致（表见 verifyExpectations）。
  // GitHub 会把非 ASCII 名字洗成 `default.pdf` 并照常返回 201 ——
  // 只看 state=uploaded 会放过这种"名字错了、其余全正常"的情况（v1.1.2 真踩过）。
  var gotNames = relAssets.map(function (a) { return a.name; });
  var read = verifyChannelReadout(want, gotNames, rel.prerelease);
  var wrongNames = read.wrongNames;

  // 这一通道依赖的那条永久直链必须真的能用（用 HEAD 探一下最终地址，不下载全文）
  var linkOk = read.linkOk;
  console.log('\n下载直链      ' + want.permalink);
  console.log('               ' + (linkOk
    ? '✓ 该 Release 里有 ' + want.zipName + '，这一通道的下载入口可用'
    : '✗ 缺 ' + want.zipName + '，' + want.channel + ' 通道的下载入口是死链！'));

  if (bad.length) console.log('\n未上传完成的附件: ' + bad.join(', '));
  if (wrongNames.length) {
    console.log('\n' + want.channel + ' 通道的附件名与声明不符 —— 实际: ' + gotNames.join(', '));
    console.log('  缺少: ' + wrongNames.join(', '));
    console.log('  原因：非 ASCII 附件名会被 GitHub 洗成 default.pdf，附件名必须纯 ASCII');
  }
  // 预览那一发摆着正式通道的名字 = 它把 `/releases/latest` 抢走了（与 cmdPreview 末尾
  // 那条 assertStableChannelIntact 同一个判据，只是这里是**核验时**再说一遍）。
  if (read.foundForbidden.length) {
    console.log('\n  ✗ 预览这一发带着正式通道的附件名: ' + read.foundForbidden.join(' / ') +
      ' —— 两条通道必须互不顶替（AGENTS §3.8）');
  }
  if (!read.prereleaseOk) {
    console.log('\n  ✗ 预览这一发的 prerelease 不是 true —— /releases/latest 会被它抢走');
  }
  // tag 之后有没有新提交？有的话**必须都不能影响用户下载到的东西**。
  //
  // 为什么不能简单地要求 `tagTarget === head`：发布之后补一条文档提交是正常操作，
  // 而那条旧断言会把它误报成"tag 与 main 不一致"并 exit=1 ——
  // 属于 AGENTS.md §5 警告的"断言实现细节而不是行为"。
  //
  // 这里要断的是**行为**，而"用户下载到的东西"其实有**两路**：
  //   (a) omitone.zip  —— 内容由 tools/build.js 的 INCLUDE 白名单决定
  //   (b) Release 附件 —— 使用说明.pdf 走这一路，**不在 zip 里**
  //
  // ⚠️ 这段改过两次，两次都是"判定漏了一类"：
  //   第一次：把"所有非 .md/.txt 文件"当成会进包的代码 —— 于是改 tools/ 下的
  //           发版脚本也报红（而 tools/ 不在白名单，用户永远拿不到）。
  //   第二次：改成按目录前缀放行后，**根目录的 使用说明.pdf 仍被误判成"进包"** ——
  //           它压根不在 INCLUDE 里，是 Release 的另一个附件。
  //           （这次是 verify 报红时发现的：它说"进包"，其实 zip 里没有。）
  //
  // 所以现在**不猜**：直接读 build.js 的 INCLUDE 白名单，
  // 再叠加"Release 附件清单"作为第二类合法目标。
  var INCLUDE = (function () {
    try {
      var bs = fs.readFileSync(path.join(ROOT, 'tools', 'build.js'), 'utf8');
      var m = bs.match(/var INCLUDE\s*=\s*\[([\s\S]*?)\]/);
      if (!m) return null;
      return m[1].split(',').map(function (s) {
        return s.trim().replace(/^['"]|['"]$/g, '');
      }).filter(Boolean).map(function (s) { return s.replace(/\/+$/, ''); });
    } catch (e) { return null; }
  })();
  // ⚠️ 读不到白名单**不能让整段判定被跳过**。
  //    这里的 `INCLUDE` 一旦是 null，下面 `if (tagTarget !== head && INCLUDE)` 的
  //    后半截就是假 —— 不管 tag 之后改了多少东西，都会掉进最后一个 else 打印
  //    「tag 与 main 完全一致 ✓」。**那不是"跳过"，那是"假装没问题"**，
  //    比报红危险得多（本项目踩过：注入一处必错改动后 verify 依然退出 0）。
  //    所以：读不到白名单 = 校验器自己坏了 = 必须报红。
  var includeBroken = !INCLUDE;
  if (includeBroken) {
    console.log('\n  ✗ 读不到 tools/build.js 的 INCLUDE 白名单 —— 校验器失效，无法判断改动会不会进包。');
    console.log('    （这一刻的绿灯是假的：不再往下打印"完全一致"，请先修 tools/build.js 或本文件）');
  }
  // 附件名也来自**这一通道的表**，不写死
  var assetSrcs = want.assetTable.map(function (a) { return a.src || want.zipName; });
  var affectsUser = function (p) {
    if (!INCLUDE) return false;
    if (assetSrcs.indexOf(p) !== -1) return true;          // 直接就是附件源文件
    var top = p.split('/')[0].replace(/\/+$/, '');
    return INCLUDE.indexOf(top) !== -1;                     // 落在白名单目录/文件里
  };
  var clean = true;
  if (includeBroken || !head) {
    clean = false;
  } else if (tagTarget !== head) {
    var cmp = await api('GET', base + '/compare/' + tagTarget + '...' + head);
    var files = (cmp.files || []).map(function (f) { return f.filename; });
    var shipped = files.filter(affectsUser);
    console.log('tag 之后 ' + baseBranch + ' 多了 ' + cmp.ahead_by + ' 个提交，改动 ' + files.length + ' 个文件：');
    files.forEach(function (p) { console.log('    ' + p + (affectsUser(p) ? '  ← 影响用户下载' : '  [不影响]')); });
    if (cmp.behind_by > 0) {
      console.log('  ✗ tag 落后 main ' + cmp.behind_by + ' 个提交 —— tag 分叉了，发布点不对');
      clean = false;
    } else if (shipped.length) {
      // 有"影响用户下载"的改动。但**改了文件 ≠ 用户拿到的还是旧的** ——
      // 附件是可以在不重发版的情况下单独替换的（本项目就常这么做：
      // 只改了说明书就只换 Omitone-manual.pdf，扩展代码一行没动）。
      //
      // 所以这里再补一刀**按内容核对**。这里有两路，必须分开映射：
      //   - 直接就是附件源文件的（如 使用说明.pdf）→ 拿**它自己**跟线上附件比
      //   - 打进 zip 的（page.js / content.js / libs/…）→ 拿**本地重新构建出来的
      //     dist/omitone-<版本>.zip** 跟线上的 omitone.zip 比
      //
      // ⚠️ 原先只按 `ASSETS[].src` 找对应附件，于是**打进 zip 的文件永远找不到附件**，
      //    一律被判成「Release 上没有对应附件」→ 报红。而校验器自己又建议
      //    「直接替换该附件即可」—— 自己给的建议自己认不出来。
      //    （实测踩过：用 replace-asset 换完 zip，verify 仍然报旧包。）
      //    ⚠️ #203 的第四条：这一处原先也写死 `ASSETS`，于是在预览通道上改了 使用说明.pdf
      //    会比到**正式说明书** `Omitone-manual.pdf` 的字节上去 —— 报的是另一个通道的内容。
      //    现在两边都从 `want.assetTable` 取（`ZIP_ASSET` 同理走 `want.zipName`）。
      //
      // 比对优先用 **sha256 摘要**（GitHub 附件接口会给 digest），拿不到再退回比字节数。
      // 字节数相等不等于内容相等 —— 能比摘要就别只比大小。
      var ZIP_ASSET = want.zipName;
      var localZip = path.join(ROOT, 'dist', 'omitone-' + manifestVersion() + '.zip');
      var sha256 = function (p) {
        return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      };
      var stale = [];
      var seenAsset = {};
      for (var i2 = 0; i2 < shipped.length; i2++) {
        var p2 = shipped[i2].replace(/\\/g, '/');
        var localPath = path.join(ROOT, p2);
        var direct = want.assetTable.filter(function (d) { return d.src === p2; })[0];
        var assetName = direct ? direct.name : ZIP_ASSET;
        // zip 这一路：所有打进包的文件共用同一个附件，核对一次就够
        if (seenAsset[assetName]) continue;
        seenAsset[assetName] = true;

        // ⚠️ 同样走子端点拿到的 `relAssets`，别读内嵌的 `rel.assets`（可能是空的）
        var asset = relAssets.filter(function (a) { return a.name === assetName; })[0];
        if (!asset) {
          stale.push(assetName + '（Release 上没有这个附件）');
          continue;
        }
        var comparePath = direct ? localPath : localZip;
        if (!fs.existsSync(comparePath)) {
          stale.push(assetName + '（本地没有可比对的文件 ' + path.relative(ROOT, comparePath) +
            '，先跑 npm run build / npm run manual）');
          continue;
        }
        var localSha = sha256(comparePath);
        var remoteSha = String(asset.digest || '').replace(/^sha256:/, '');
        if (remoteSha) {
          if (localSha !== remoteSha) {
            stale.push(assetName + '（内容不一致：本地 ' + localSha.slice(0, 12) +
              '… ≠ 线上 ' + remoteSha.slice(0, 12) + '…）');
          } else {
            console.log('    ' + assetName + ' 已与本地构建逐字节一致（sha256 ' +
              localSha.slice(0, 12) + '…）—— 已换过，不算过期');
          }
        } else {
          var lk = fs.statSync(comparePath).size;
          if (lk !== asset.size) {
            stale.push(assetName + '（本地 ' + (lk / 1024).toFixed(1) + ' KB ≠ 线上 ' +
              (asset.size / 1024).toFixed(1) + ' KB）');
          } else {
            console.log('    ' + assetName + ' 已与线上附件等大（' + (lk / 1024).toFixed(1) +
              ' KB，接口未给摘要）—— 视为已换过');
          }
        }
      }
      if (stale.length) {
        console.log('  ✗ tag 之后有会**影响用户下载**的改动，且线上附件还是旧的：');
        stale.forEach(function (s2) { console.log('      ' + s2); });
        console.log('    → 先 npm run build（或 npm run manual）重出产物，再跑：');
        // ⚠️ 建议的修法也要按通道：预览那一条支线上 `replace-asset` 会被通道闸当场挡下
        //     （AGENTS §3.8 —— 那条命令会把实验版字节挂到线上的 omitone.zip 上），
        //     预览包的更新口是 `preview` 自己。给一条被挡死的建议等于没给。
        if (want.channel === 'preview') {
          console.log('        node tools/github-release.js preview');
          console.log('        （预览附件走 preview 那一发；这条支线上 replace-asset 是被挡的）');
        } else {
          console.log('        node tools/github-release.js replace-asset ' + tag);
          console.log('        （按同名替换附件，不必重发整版；附件名绝不能改，见 AGENTS.md §7.5）');
        }
        clean = false;
      } else {
        console.log('  ✓ 改动涉及的附件都已换成最新内容，用户下载到的东西是对的');
      }
    } else {
      console.log('  ✓ 改动都不进包（文档 / 开发期文件），用户下载到的东西与 tag 一致');
    }
  } else {
    console.log('tag 与 ' + baseBranch + ' 完全一致 ✓');
  }

  // ---- 本地构建产物有没有过期 ----
  // 放在**最外面**：这条与"tag 之后有没有新提交"无关 —— 工作区改了源码但还没提交时，
  // 上面那段 compare 根本不跑，忘了 build 就没人拦（AGENTS.md §3.7 的⚠️正是这一条）。
  var fresh = distFreshness(manifestVersion());
  if (fresh.includeBroken) {
    console.log('\n  ✗ 读不到 tools/build.js 的 INCLUDE 白名单 —— 无法判断本地构建是否过期');
    clean = false;
  } else if (!fresh.zip) {
    console.log('\n  ⚠ 本地没有 dist/omitone-' + manifestVersion() + '.zip —— 先 npm run build，否则上面那条"附件已换过"没有本地依据');
  } else if (fresh.stale) {
    console.log('\n  ✗ 本地构建产物**比源码旧**：dist 打包之后 `' + fresh.newest.file + '` 又改过 ——');
    console.log('    线上附件与这个旧 dist 一致也没用，用户拿到的还是修复前的代码。先 npm run build，再' +
      (want.channel === 'preview' ? '跑 preview（这条支线上 replace-asset 被通道闸挡着）' : ' replace-asset ' + tag));
    clean = false;
  } else {
    console.log('\n  ✓ 本地 dist 不早于任何进包源文件（最新的是 ' + fresh.newest.file + '）');
  }

  // ---- Release 说明 vs 源文件 ----
  //
  // 为什么单独比这一条：附件有 sha256 可对，**说明那一页以前没有任何东西对它**。
  // 结果就是"合并说明"每次都直接 PATCH 线上、不回写 `release-notes-<版本>.md`，
  // 两边漂移到互缺半段（2026-11-14 实测：线上缺批次 38/40/44，源文件缺批次 33/34）。
  // 这条守卫报的是**行为**（用户在那一页看到的，是不是仓库里那份说明），不是文件名。
  var notesFile = notesPathFor(tag);
  if (!notesFile) {
    console.log('\n  ⚠ 本地没有 release-notes-' + String(tag).replace(/^v/, '') +
      '.md —— 线上那一页**没有源文件可对**，改了说明无法回写，漂移会无声积累');
  } else {
    var localBody = fs.readFileSync(notesFile, 'utf8').replace(/\s+$/, '');
    var remoteBody = String(rel.body || '').replace(/\s+$/, '');
    if (localBody === remoteBody) {
      console.log('\n  ✓ Release 说明与 ' + path.basename(notesFile) + ' 逐字一致（' +
        remoteBody.length + ' 字）');
    } else {
      var onlyRemote = paraTitles(remoteBody).filter(function (t) {
        return paraTitles(localBody).indexOf(t) === -1;
      });
      var onlyLocal = paraTitles(localBody).filter(function (t) {
        return paraTitles(remoteBody).indexOf(t) === -1;
      });
      console.log('\n  ✗ Release 说明与源文件已漂移（线上 ' + remoteBody.length +
        ' 字 / ' + path.basename(notesFile) + ' ' + localBody.length + ' 字）');
      if (onlyRemote.length) console.log('      只有线上有：' + onlyRemote.join(' / '));
      if (onlyLocal.length) console.log('      只有源文件有：' + onlyLocal.join(' / '));
      console.log('    → 先手工把两边并成一份**完整的**（谁漏的那半边补回源文件），');
      console.log('      然后**只推源文件**：node tools/github-release.js notes ' + tag);
      console.log('      （别再直接 PATCH 线上 —— 那正是这次漂移的来源）');
      clean = false;
    }
  }

  if (bad.length || wrongNames.length || read.foundForbidden.length || !read.prereleaseOk ||
      !linkOk || !clean) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
(async function () {
  var cmd = process.argv[2];
  var rest = parseArgs(process.argv.slice(3));

  if (cmd === 'push') {
    // --delete 收逗号分隔的路径列表
    var dels = rest.flags['delete'] && rest.flags['delete'] !== true
      ? String(rest.flags['delete']).split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    await cmdPush(rest.positional, rest.flags['message-file'], dels);
  }
  else if (cmd === 'release') await cmdRelease(rest.positional[0], rest.flags['notes-file']);
  else if (cmd === 'preview') await cmdPreview();
  else if (cmd === 'notes') await cmdNotes(rest.positional[0], rest.flags['notes-file']);
  else if (cmd === 'verify') await cmdVerify(rest.positional[0]);
  else if (cmd === 'replace-asset') await cmdReplaceAsset(rest.positional[0]);
  else if (cmd === 'check-msg') cmdCheckMsg(rest.positional[0]);
  else if (cmd === 'verify-expect') cmdVerifyExpect();
  else {
    console.log('用法:');
    console.log('  node tools/github-release.js push --message-file <文件> [--delete a,b] <文件...>');
    console.log('  node tools/github-release.js release <tag> --notes-file <文件>');
    console.log('  node tools/github-release.js preview             # 实验支线发预览包（只动 tag preview / omitone-preview.zip）');
    console.log('  node tools/github-release.js notes <tag> [--notes-file <文件>]   # 只改那一页的说明（默认读 release-notes-<版本>.md）');
    console.log('  node tools/github-release.js verify <tag>');
    console.log('  node tools/github-release.js replace-asset <tag>   # 附件过期时按同名替换，不必重发整版');
    console.log('  node tools/github-release.js check-msg <文件>   # 只校验提交信息，不联网');
    console.log('  node tools/github-release.js verify-expect      # 只核对 verify 的通道期望表（不联网、不要令牌，#203）');
    console.log('  （通道闸 tools/channel-gate.js：实验支线上 release / replace-asset 被挡，发布线上 preview 被挡 —— 见 AGENTS §3.8）');
    process.exitCode = 1;
  }
})().catch(function (e) {
  console.error('\n失败：' + e.message);
  process.exitCode = 1;
});
