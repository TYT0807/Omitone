#!/usr/bin/env node
/* 定点清理「临时沙盒 / e2e 测试浏览器」留下的临时 profile。
 *
 * 背景：tools/browser-e2e.js 每跑一次就在 %LOCALAPPDATA%\Temp 里造一枚 `omitone-e2e-*`
 * 的 Edge 用户目录，runner 原先只打印一句「可手动删除」，从来没人删 ——
 * 2026-11-19 实测攒到 106 枚 / 10.2 GB（AGENTS §7.8）。这个工具把那句话换成一条能跑的命令，
 * 并已接进 e2e 收尾（tools/browser-e2e.js 的 sweepE2eProfiles）：跑完自己收。
 * 三枚前缀一起认：`omitone-e2e-*`（全量/定向 e2e）、`omitone-sandbox-*`（沙盒自己会收尾，
 * 中途崩了才留下）、`omitone-manual-*`（说明书生成，同上）。
 *
 * 四道闸（AGENTS §7.8，缺一条就不删）：
 *   1. 正在跑的浏览器整枚不许动（Cookies 库实测 EBUSY，硬删是在损坏中的档案上动刀）；
 *      读不到进程列表当 FATAL 退出，不许「当作没在跑」继续。
 *      沙盒把 --user-data-dir 指向孙层的 profile，所以「在我这枚里面」也算在跑。
 *   2. 候选必须是「临时目录的直接子目录」且名字匹配上面那一族前缀 ——
 *      这一条把 .workbuddy/real-edge-profile（学习通登录态 + 正在刷的那一门）死死挡在门外。
 *   3. 删之前先看它有没有登录态：Default/Network/Cookies 里搜得到 chaoxing 就留着并点名。
 *   4. 阴性对照：候选路径字符串本身不许含 Network/Cookies/Login Data/Local Storage/Session Storage ——
 *      命中就整轮不删（这条管的是"判据自己写歪时当场响"）。
 *
 * 用法：
 *   node tools/clean-e2e-profiles.js                    # 干跑，只报要删哪些、占多少
 *   node tools/clean-e2e-profiles.js --apply            # 真删
 *   node tools/clean-e2e-profiles.js --apply --quiet    # e2e 收尾用：只印一行结论
 *   node tools/clean-e2e-profiles.js --selftest         # 造四枚假 profile 逐闸自证（npm run check 会跑）
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var PREFIXES = ['omitone-e2e-', 'omitone-sandbox-', 'omitone-manual-'];
var LOGIN_SHAPE = /(Network|Cookies|Login Data|Local Storage|Session Storage)/i;
var MIN_LOGIN = Buffer.from('chaoxing', 'latin1');

function parseArgs(argv) {
  return {
    apply: argv.indexOf('--apply') !== -1,
    quiet: argv.indexOf('--quiet') !== -1,
    selftest: argv.indexOf('--selftest') !== -1,
    sizes: argv.indexOf('--sizes') !== -1 || argv.indexOf('--apply') === -1
  };
}

function fatal(msg) {
  console.log('FATAL ' + msg);
  process.exit(1);
}

function logLine(opts, text) {
  if (!opts.quiet) console.log(text);
}

function norm(p) {
  if (!p) return '';
  var out = String(p).replace(/"/g, '').replace(/[\\/]+$/, '');
  try { out = fs.realpathSync.native ? fs.realpathSync.native(out) : fs.realpathSync(out); } catch (e) {}
  return out.toLowerCase().replace(/\//g, '\\');
}

/** 这一族目录名是不是我们自己的测试台建的 */
function isOurs(name) {
  for (var i = 0; i < PREFIXES.length; i++) if (name.indexOf(PREFIXES[i]) === 0) return true;
  return false;
}

/**
 * 闸 1 的第二半：正在跑的那枚**在这枚目录里面**也要算「在跑」。
 * 沙盒的 --user-data-dir 是 `omitone-sandbox-XXXX\profile`（孙层），
 * 只比「等于」会漏掉它 —— 于是浏览器还在里面写，我们把整枚父目录删了。
 */
function runningUnder(realDir, running) {
  var want = realDir + '\\';
  for (var i = 0; i < running.length; i++) if (running[i].indexOf(want) === 0) return true;
  return false;
}

// —— 闸 1：哪几台浏览器正在跑 ——
function runningUserDataDirs() {
  var ps1 = path.join(__dirname, 'list-edge-user-data-dirs.ps1');
  if (!fs.existsSync(ps1)) fatal('找不到 ' + ps1 + ' —— 没有它就无法判断哪台在跑，本轮不删');
  var res = cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    encoding: 'utf8', timeout: 60000, windowsHide: true
  });
  if (res.error) fatal('PowerShell 起不来（' + res.error.message + '），读不到进程列表，本轮不删');
  if (res.status === 2) fatal('进程列表读不到（PowerShell 报错），「不知道哪台在跑」不等于「没在跑」，本轮不删');
  if (res.status !== 0) fatal('PowerShell 退出码 ' + res.status + '，本轮不删');
  return String(res.stdout || '').split(/\r?\n/).map(function (s) { return norm(s.trim()); }).filter(Boolean);
}

function dirSizeBytes(dir) {
  var total = 0;
  var stack = [dir];
  while (stack.length) {
    var cur = stack.pop();
    var entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(cur, entries[i].name);
      try {
        if (entries[i].isSymbolicLink()) continue;
        if (entries[i].isDirectory()) { stack.push(full); continue; }
        if (entries[i].isFile()) total += fs.statSync(full).size;
      } catch (e) {}
    }
  }
  return total;
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

// —— 闸 3：有没有登录态 ——
function holdsLoginState(dir, note) {
  var cookieFile = path.join(dir, 'Default', 'Network', 'Cookies');
  var buf;
  try {
    if (!fs.existsSync(cookieFile)) return false;
    buf = fs.readFileSync(cookieFile);
  } catch (e) {
    // 读不动就当它有登录态（多半是正被占用）：宁可留着，不可删错
    note('  保留（Cookies 读不动，可能正被占用）：' + dir + ' —— ' + e.code);
    return true;
  }
  if (buf.indexOf(MIN_LOGIN) !== -1) {
    note('  保留（Cookies 里搜得到 chaoxing，这一枚有学习通登录态）：' + dir);
    return true;
  }
  return false;
}

/**
 * 把「临时目录里的一堆名字」过四道闸，分成可删 / 在跑 / 带登录态 / 判据写歪。
 * 不碰盘、不退出 —— 所以 --selftest 能直接拿它逐闸对照。
 * 闸 4 只收集不裁决：命中多少条都由调用方决定怎么响（真跑要整轮不删）。
 */
function classify(tmpRoot, running, note) {
  var out = { deletable: [], inUse: 0, held: 0, violations: [], candidates: 0, candidateNames: [] };
  var parentWant = norm(tmpRoot);
  var names;
  try { names = fs.readdirSync(tmpRoot); } catch (e) { e.code = 'unreadable'; return out; }
  var candidates = [];
  for (var i = 0; i < names.length; i++) {
    if (!isOurs(names[i])) continue;
    var full = path.join(tmpRoot, names[i]);
    var st;
    try { st = fs.lstatSync(full); } catch (e) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    // 闸 2：必须是临时目录的「直接子目录」，realpath 后仍在临时目录之内
    var real = norm(full);
    if (real.indexOf(parentWant + '\\') !== 0 || real.slice(parentWant.length + 1).indexOf('\\') !== -1) {
      note('  跳过（不在临时目录直属层，形状不对）：' + full);
      continue;
    }
    // 闸 4：候选路径本身不许长成登录态的样子
    if (LOGIN_SHAPE.test(full)) { out.violations.push(full); continue; }
    // 闸 1：在跑的不碰
    if (running.indexOf(real) !== -1 || runningUnder(real, running)) { out.inUse++; note('  在跑，不动：' + full); continue; }
    candidates.push(full);
    out.candidateNames.push(names[i]);
  }
  out.candidates = candidates.length;
  for (var j = 0; j < candidates.length; j++) {
    if (holdsLoginState(candidates[j], note)) { out.held++; continue; }
    out.deletable.push(candidates[j]);
  }
  return out;
}

function driveAvail(p) {
  try {
    var s = fs.statfsSync ? fs.statfsSync(p) : null;
    if (!s) return null;
    return s.bavail * s.bsize;
  } catch (e) { return null; }
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) return selfTest();
  var tmpRoot = fs.realpathSync(os.tmpdir());
  var running = runningUserDataDirs();
  logLine(opts, '临时目录：' + tmpRoot);
  logLine(opts, '正在跑的浏览器用户目录 ' + running.length + ' 枚（这些一律不动）');

  var res = classify(tmpRoot, running, function (t) { console.log(t); });
  // 闸 4 命中 = 判据写歪（比如哪天有人把候选扩成整个 Default/），整轮不删
  if (res.violations.length) fatal('候选里混进了登录态路径（' + res.violations[0] + '），判据写歪了，本轮一枚都不删');

  var bytes = 0;
  if (opts.sizes) {
    for (var k = 0; k < res.deletable.length; k++) bytes += dirSizeBytes(res.deletable[k]);
  }

  var before = driveAvail(tmpRoot);
  if (!opts.apply) {
    logLine(opts, '');
    logLine(opts, '干跑（没删任何东西）：可删 ' + res.deletable.length + ' 枚' +
      (opts.sizes ? '，合计 ' + mb(bytes) + ' MB' : '') +
      '；在跑 ' + res.inUse + ' 枚；带登录态被留 ' + res.held + ' 枚');
    if (res.deletable.length) logLine(opts, '要真删就加 --apply');
    return;
  }

  var deleted = 0;
  var failed = 0;
  for (var m = 0; m < res.deletable.length; m++) {
    try {
      fs.rmSync(res.deletable[m], { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      deleted++;
    } catch (e) {
      failed++;
      console.log('  删除失败（保留）：' + res.deletable[m] + ' —— ' + e.code);
    }
  }
  var after = driveAvail(tmpRoot);
  console.log('临时 profile 清理：删 ' + deleted + ' 枚 / 失败 ' + failed + ' 枚 / 在跑没动 ' + res.inUse +
    ' 枚 / 带登录态留 ' + res.held + ' 枚' +
    (opts.sizes ? ' · 释放约 ' + mb(bytes) + ' MB' : '') +
    (before === null || after === null ? '' : '（盘上可用 ' + mb(before) + ' → ' + mb(after) + ' MB）'));
  if (failed) process.exit(1);
}

/**
 * 四道闸的对照表：造五枚假 profile，逐道要求「这一道拦住的那一枚必须被拦住、
 * 该放行的一枚不许被误拦」—— 否则这四条只是一段散文，没人知道它还灵不灵。
 * ⚠️ 每一枚只破一道闸：少任何一格对照，就说不清是哪道闸在承重（AGENTS §5）。
 */
function selfTest() {
  var scratchRaw = path.join(os.tmpdir(), 'omitone-selftest-' + process.pid);
  fs.mkdirSync(scratchRaw, { recursive: true });
  // realpath 要在建好之后：对不存在的目录调它会 ENOENT（而建它本来就是这一步的第一件事）
  var scratch = fs.realpathSync(scratchRaw);
  var notes = [];
  var note = function (t) { notes.push(t); };
  var results = [];
  var selfBad = false;

  function mkdirp(rel) { fs.mkdirSync(path.join(scratch, rel), { recursive: true }); }
  function touch(rel, text) {
    var full = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  try {
    // ① 干净的一枚：既不在跑也没登录态 —— 必须进可删
    mkdirp('omitone-e2e-clean');
    // ② 带登录态：Cookies 里有 chaoxing —— 必须被留（闸 3）
    touch('omitone-e2e-login/Default/Network/Cookies', 'x	chaoxing.com	abc');
    // ③ 名字不是我们这一族 —— 必须压根不进候选（闸 2 的前半）
    mkdirp('someone-elses-profile');
    // ④a 正在跑：--user-data-dir 指向孙层的 profile —— 父目录必须整枚不动（闸 1 后半）
    mkdirp('omitone-sandbox-running/profile');
    // ④b 正在跑：--user-data-dir 就是这一枚本身（e2e runner 的形状）—— 闸 1 前半
    mkdirp('omitone-e2e-running');
    // ⑤ 判据写歪的形状：目录名本身带着 Cookies —— 必须由 violations 接住（闸 4）
    mkdirp('omitone-e2e-Cookies');

    var running = [
      norm(path.join(scratch, 'omitone-sandbox-running', 'profile')),
      norm(path.join(scratch, 'omitone-e2e-running'))
    ];
    var res = classify(scratch, running, note);
    var names = res.deletable.map(function (p) { return path.basename(p); });

    function expect(label, ok, detail) {
      results.push({ label: label, ok: ok, detail: detail });
      console.log((ok ? '  [ok]   ' : '  [FAIL] ') + label + (ok ? '' : ' → ' + detail));
    }

    expect('①干净的一枚确实进了可删（不是四道闸把它一起挡了）',
      names.indexOf('omitone-e2e-clean') !== -1, '可删名单=' + JSON.stringify(names));
    expect('②Cookies 里搜得到 chaoxing 的那枚被留下（闸 3 承重）',
      names.indexOf('omitone-e2e-login') === -1 && res.held === 1,
      'held=' + res.held + ' 可删=' + JSON.stringify(names));
    // 候选按**名字**钉，不拍总数：我们这一族五枚进了闸，其中
    //   omitone-e2e-Cookies 被闸 4 摘走、omitone-sandbox-running 与 omitone-e2e-running 被闸 1 摘走，
    //   所以剩下的应当恰好是 clean + login 这两枚（③的判据与④⑤是同一批数据，互相咬合）。
    var expectedCandidates = ['omitone-e2e-clean', 'omitone-e2e-login'];
    var gotCandidates = res.candidateNames.slice().sort();
    expect('③不是我们这一族的一枚候选都没进，且进候选的恰好是 clean + login 这两枚（闸 2 承重）',
      gotCandidates.join() === expectedCandidates.join(),
      '应进候选=' + expectedCandidates.join() + ' 实进=' + gotCandidates.join());
    expect('④a 在跑的浏览器在孙层 profile 里，父目录整枚不动（闸 1 后半承重）',
      names.indexOf('omitone-sandbox-running') === -1,
      '可删=' + JSON.stringify(names) + ' inUse=' + res.inUse);
    expect('④b 在跑的浏览器就是这一枚本身，同样整枚不动（闸 1 前半承重，e2e runner 的形状）',
      names.indexOf('omitone-e2e-running') === -1,
      '可删=' + JSON.stringify(names) + ' inUse=' + res.inUse);
    // 两半各独立承重：只中一半会让 inUse 停在 1，所以总数也要钉住
    expect('④c 闸 1 的两半同时生效，在跑的总数恰好两枚（不是其中一半根本没跑到）',
      res.inUse === 2, 'inUse=' + res.inUse + ' 可删=' + JSON.stringify(names));
    expect('⑤候选路径自己带着 Cookies 字样时进 violations，而不是被当成可删（闸 4 承重）',
      res.violations.length === 1 && res.violations[0].indexOf('omitone-e2e-Cookies') !== -1,
      'violations=' + JSON.stringify(res.violations.map(function (p) { return path.basename(p); })));
    // violations 那一枚不许同时出现在可删里 —— 否则"整轮不删"那句没有内容，只是多印一行
    expect('⑥闸 4 命中时那一枚没被放进可删（violations 非空 → 调用方必须 FATAL，而不是"少删一枚"）',
      res.violations.length > 0 && res.deletable.indexOf(res.violations[0]) === -1,
      'violations=' + res.violations.length);

    var bad = results.filter(function (r) { return !r.ok; });
    console.log('自检：' + (results.length - bad.length) + ' / ' + results.length +
      ' 格通过（假 profile 六枚，逐闸对照，闸 1 的两半各一格）');
    if (bad.length) {
      bad.forEach(function (b) { console.log('  未通过：' + b.label + ' —— ' + b.detail); });
      selfBad = true;
    }
  } finally {
    // ⚠️ 退出码必须在清理**之后**才决定：process.exit 不会跑 finally（AGENTS §5 实测踩过），
    //    写在 try 里就会把 scratch 那五枚假 profile 永久留在临时目录 —— 这工具本来是省盘子的。
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }
    catch (e) { console.log('  ⚠️ 自检临时目录没删掉，手动可删：' + scratch + '（' + e.code + '）'); }
  }
  if (selfBad) process.exit(1);
}

if (require.main === module) main();
module.exports = { classify: classify, isOurs: isOurs, runningUnder: runningUnder, norm: norm };
