#!/usr/bin/env node
/**
 * 发版工具：走 GitHub REST API 完成「提交 → 打 tag → 建 Release → 传附件 → 核验」。
 *
 * 为什么不用 `git push`：
 *   这台机器上 `git push` 能连上却永远不返回（实测挂满 5 分半），
 *   而同一条网络下 `git fetch` 几秒完成、api.github.com 与 uploads.github.com 都正常 ——
 *   push 通道单独不通。详见 AGENTS.md §7.3。
 *
 * 三个子命令：
 *   push    --message-file <文件> <文件...>   把改动提交到 main（走 API）
 *   release <tag> --notes-file <文件>         打 tag + 建 Release + 传两个附件
 *   verify  <tag>                             核验远端状态（**发完必须跑一次**）
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
 *   3) 这个文件是**用完就该删**的：发版结束请立刻 revoke 令牌并删掉它。
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

var ROOT = path.join(__dirname, '..');
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
  console.error('用完请立刻 revoke 并删除该文件 —— 它不该长期留在磁盘上。');
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
// verify：核验远端（**只看接口返 200 不算数**，要确认附件状态与 tag 指向）
// ---------------------------------------------------------------------------
async function cmdVerify(tag) {
  if (!tag) throw new Error('verify 需要 tag');

  var ref = await api('GET', base + '/git/ref/heads/' + BRANCH);
  var head = ref.object.sha;
  console.log('远端 ' + BRANCH + '   ' + head);

  var tagRef = await api('GET', base + '/git/ref/tags/' + tag);
  var tagObj = await api('GET', base + '/git/tags/' + tagRef.object.sha);
  var tagTarget = tagObj.object.sha;
  // tag 与 main 的关系用 compare 接口判定（见下方 compareAfterTag）
  console.log('tag ' + tag + '     ' + tagTarget);

  var rel = await api('GET', base + '/releases/tags/' + tag);
  console.log('release        ' + rel.html_url);
  console.log('draft          ' + rel.draft + ' / prerelease ' + rel.prerelease + ' / 说明 ' + rel.body.length + ' 字');

  var bad = [];
  rel.assets.forEach(function (a) {
    var ok = a.state === 'uploaded';
    if (!ok) bad.push(a.name);
    console.log('  附件 ' + a.name + '  ' + (a.size / 1024).toFixed(1) + ' KB  state=' + a.state);
  });

  // 附件名必须与 ASSETS 声明的**逐字一致**。
  // GitHub 会把非 ASCII 名字洗成 `default.pdf` 并照常返回 201 ——
  // 只看 state=uploaded 会放过这种"名字错了、其余全正常"的情况（v1.1.2 真踩过）。
  var wantNames = ASSETS.map(function (a) { return a.name; });
  var gotNames = rel.assets.map(function (a) { return a.name; });
  var wrongNames = wantNames.filter(function (n) { return gotNames.indexOf(n) === -1; });

  // README 依赖的永久直链必须真的能用（用 HEAD 探一下最终地址，不下载全文）
  var linkOk = rel.assets.some(function (a) { return a.name === 'omitone.zip'; });
  console.log('\n下载直链      https://github.com/' + OWNER + '/' + REPO + '/releases/latest/download/omitone.zip');
  console.log('               ' + (linkOk ? '✓ 该 Release 里有同名附件，链接可用' : '✗ 缺 omitone.zip，README 的下载入口是死链！'));

  if (bad.length) console.log('\n未上传完成的附件: ' + bad.join(', '));
  if (wrongNames.length) {
    console.log('\n附件名与 ASSETS 声明不符 —— 实际: ' + gotNames.join(', '));
    console.log('  缺少: ' + wrongNames.join(', '));
    console.log('  原因：非 ASCII 附件名会被 GitHub 洗成 default.pdf，附件名必须纯 ASCII');
  }
  // tag 之后有没有新提交？有的话**只允许是文档**。
  //
  // 为什么不能简单地要求 `tagTarget === head`：发布之后补一条文档提交是正常操作，
  // 而那条旧断言会把它误报成"tag 与 main 不一致"并 exit=1 ——
  // 属于 AGENTS.md §5 警告的"断言实现细节而不是行为"。
  var docOnly = true;
  if (tagTarget !== head) {
    var cmp = await api('GET', base + '/compare/' + tagTarget + '...' + head);
    var files = (cmp.files || []).map(function (f) { return f.filename; });
    var isDoc = function (p) { return /\.(md|txt)$/i.test(p) || /^docs\//.test(p); };
    var codeFiles = files.filter(function (p) { return !isDoc(p); });
    console.log('tag 之后 main 多了 ' + cmp.ahead_by + ' 个提交，改动 ' + files.length + ' 个文件：');
    files.forEach(function (p) { console.log('    ' + p + (isDoc(p) ? '  [文档]' : '  ← 代码！')); });
    if (cmp.behind_by > 0) {
      console.log('  ✗ tag 落后 main ' + cmp.behind_by + ' 个提交 —— tag 分叉了，发布点不对');
      docOnly = false;
    } else if (codeFiles.length) {
      console.log('  ✗ tag 之后有**代码**改动未进这一版：' + codeFiles.join(', '));
      console.log('    → 用户下载到的不是最新代码。要么重发这一版，要么准备下一版');
      docOnly = false;
    } else {
      console.log('  ✓ 只有文档改动，代码与 tag 一致 —— 用户下载到的东西是对的');
    }
  } else {
    console.log('tag 与 ' + BRANCH + ' 完全一致 ✓');
  }

  if (bad.length || wrongNames.length || !linkOk || !docOnly) process.exitCode = 1;
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
  else if (cmd === 'verify') await cmdVerify(rest.positional[0]);
  else if (cmd === 'check-msg') cmdCheckMsg(rest.positional[0]);
  else {
    console.log('用法:');
    console.log('  node tools/github-release.js push --message-file <文件> [--delete a,b] <文件...>');
    console.log('  node tools/github-release.js release <tag> --notes-file <文件>');
    console.log('  node tools/github-release.js verify <tag>');
    console.log('  node tools/github-release.js check-msg <文件>   # 只校验提交信息，不联网');
    process.exitCode = 1;
  }
})().catch(function (e) {
  console.error('\n失败：' + e.message);
  process.exitCode = 1;
});
