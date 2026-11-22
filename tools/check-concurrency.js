#!/usr/bin/env node
/**
 * 起手先问这一件：「现在有没有另一个会话正在写同一批文件」—— 判据来自**盘上证据**，不是自报。
 *
 *   node tools/check-concurrency.js                     只读探针：这一轮能不能改文件
 *   node tools/check-concurrency.js --session=abc       我自己的会话号（stamp 里那个 session 与我相同就不算证据）
 *   node tools/check-concurrency.js --stamp-mine        声明那条没有 session 字段的 stamp 就是我写的
 *   node tools/check-concurrency.js --window=600        换窗口（秒），默认 720（=12 分钟）
 *   node tools/check-concurrency.js --json              机器读的那份
 *   node tools/check-concurrency.js --selftest          逐格对照，不碰盘
 *
 * ## 为什么仓库里要有这一件（2026-11-22 现场，`notes/ledger-165-draft.md`）
 *
 * 接手卡的第 2 步把「`.workbuddy/main-active.stamp` 在 12 分钟内」当成**唯一**闸门。
 * 2026-11-22 00:35~00:43 实测过它的两种错法，方向相反、代价一样高：
 *
 * 1. **报错人**：那一枚新鲜 stamp 的内容是 `2026-11-22T00:35:40+08:00`，那是**我自己**写的；
 *    真正在写的窗口（`src/page/62-tasks-run.js` mtime 00:40:14，比 stamp 还晚 4.5 分钟）**从没登记过**。
 *    于是 stamp 那一格指着我，动手的是别人。
 * 2. **永远判不出安静**：反过来只看「12 分钟内有没有文件被动过」也会锁死人 ——
 *    01:20:43 那一次 `page.js` / `62-tasks-run.js` / `60-tasks-detect.js` 三份同戳，
 *    而 `git status` 里 `60-tasks-detect.js` **是干净的**（它最后一次提交还停在 20:45 的 `a82505d`）。
 *    那是**注入 → 逐字节还原**留下的时间戳：有人刚跑完一轮反向验证并收干净了尾，**不是此刻在写**。
 *    只看 mtime 会把已经收尾的轮次读成活跃写入者，接手会话就永久停在只读轮 ——
 *    会误报的守卫和没有守卫一样害人（AGENTS §5）。
 *
 * ## 所以判据是两条一起问，缺一不算「有人在写」
 *
 *   腿 1  自报层（`main-active.stamp`）：新鲜**且归因得到是别人**才阻塞。
 *         stamp 陈旧**永远不能**用来证明没人写 —— 它只记录"谁最后自觉登记过一次"。
 *   腿 2  盘上层：**mtime 落在窗口内** 与 **`git status` 里带改动** 两条同时成立才算活跃写入者。
 *         只有 mtime 新（树干净）= 刚有人还原过 → `restored-not-writing`，明说"可以动"。
 *         只有脏（mtime 陈旧）= 未提交的半成品 → `orphan-dirty`，不锁死整轮，但那几份不许 `git add`。
 *   两条都读不出（`git status` 跑不出来 / `stat` 拿不到）→ `unreadable` 单独占一格，
 *         **不许塌进「安静」**（AGENTS §2 #12），出口码 2 与阻塞的 1 分家。
 *
 * 构建产物 `page.js` 的 mtime 只说「跑过一次 concat」，**不单独当写者证据** ——
 * 要问的是它的输入：`src/page/*.js` 与 `manifest.content_scripts[0].js` 那 15 份。
 *
 * ⚠️ 这一件**一个字都不写**：只 `stat` 与跑 `git status` / `git log` 两条只读命令，
 * 带超时。登记活跃度（touch stamp）是调用方的事，用 Write 落，不在这把尺里。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');
var STAMP = path.join(ROOT, '.workbuddy', 'main-active.stamp');
var DEFAULT_WINDOW_MS = 12 * 60 * 1000;
var GIT_TIMEOUT_MS = 15000;

// 0 = 可以动；1 = 有人在写 / 有未提交的别人改动（本轮收窄处置）；2 = 读不出（**不许读成"没事"**）
var EXIT = { open: 0, blocked: 1, unreadable: 2 };

function argNum(name, dflt) {
  var pre = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return Number(process.argv[i].slice(pre.length));
  }
  return dflt;
}
function argStr(name, dflt) {
  var pre = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  return dflt;
}
function hasFlag(name) {
  return process.argv.indexOf('--' + name) !== -1;
}

// ---------------------------------------------------------------------------
// 判定层：纯函数，读数进、格子出。真跑与 --selftest 的合成读数走的是同一把尺。
// ---------------------------------------------------------------------------

/**
 * g = {
 *   windowMs,
 *   stampState:  'fresh' | 'stale' | 'absent' | 'unparsed' | 'unreadable',
 *   stampAgeMs,  stampSession, stampMine (bool：调用方声明那条无 session 的 stamp 是自己写的),
 *   gitErr,                  // 字符串 = `git status` 没跑出来
 *   statErr,                 // 字符串 = 有要问的文件连"在不在"都答不上来
 *   dirty: [{ path, isBuild, isDoc, ageMs|null }],   // git status 里的跟踪改动（未跟踪不算）
 *   freshCleanBuild,         // mtime 新但 git 干净的构建输入枚数（还原形状）
 *   commitAgeMs|null,        // 最近一次提交距今（只作参考，永不单独阻塞）
 *   concatAgeMs|null         // page.js 的 mtime 距今（只作参考，见文件头那条口径）
 * }
 */
function classify(g) {
  if (!g) return out('unreadable', 'no-input', EXIT.unreadable, '没有读数进来（调用方连 `probe()` 都没跑到）—— 这一格是读不出，不许读成"安静"。', true);

  var windowMs = Number(g.windowMs) > 0 ? Number(g.windowMs) : DEFAULT_WINDOW_MS;
  var stamp = String(g.stampState || 'absent');
  var dirty = Array.isArray(g.dirty) ? g.dirty : [];
  var freshDirty = dirty.filter(function (d) { return typeof d.ageMs === 'number' && d.ageMs <= windowMs; });

  // ---- 腿 1：自报层。只有"新鲜 + 归因得到是别人"才阻塞 ----
  // 顺序要紧：这一发在 git 能不能读之前判（§selftest 第 16 格）—— 别人自报在写的时候，
  // 不管我们量不量得动盘都要先把这一轮收窄，两条证据不存在"谁读不到就当没有"。
  var stampForeign = stamp === 'fresh' && g.stampMine !== true &&
    (!g.stampSession || !g.selfSession || g.stampSession !== g.selfSession);
  if (stampForeign) {
    var noSess = !g.stampSession;
    return out('writing', noSess ? 'stamp-fresh-nosession' : 'stamp-fresh', EXIT.blocked,
      '腿 1 命中：`main-active.stamp` 距今 ' + mins(g.stampAgeMs) + '，' +
      (noSess ? '**里面没写 `session=`，归因不到是谁登记的**' : '登记的是 `session=' + g.stampSession + '`，不是本会话（' + (g.selfSession || '(未带 --session)') + '）') +
      ' —— 保守按"有人在写"处置。',
      true,
      noSess
        ? '如果那一行就是本会话自己写的，带 `--stamp-mine` 再问一次；否则按只读轮走。往后进 stamp 要写成 `<ISO 带时区>  session=<会话号>`，归因就不用猜。'
        : '等它过期（窗口 ' + Math.round(windowMs / 60000) + ' 分钟），或确认那一轮已经收尾。');
  }

  // ---- 两条盘上证据都读不出 → 单独占一格 ----
  if (g.gitErr || g.statErr) {
    return out('unreadable', g.gitErr ? 'git-status' : 'stat', EXIT.unreadable,
      '腿 2 量不到：' + (g.gitErr
        ? '`git status --porcelain` 没跑出来（' + String(g.gitErr).slice(0, 120) + '）'
        : '有文件的 mtime 读不出来（' + String(g.statErr).slice(0, 120) + '）') +
      ' —— 这一格既不等于"有人在写"，**更不等于"安静"**（AGENTS §2 #12）。' +
      (stamp === 'stale' ? ' stamp 那条旧读数（距今 ' + mins(g.stampAgeMs) + '）不能替它说话 —— stamp 陈旧从来证明不了没人写。' : '') +
      ' 按最保守那一格处置：读不出就当有人在写（AGENTS §1.05）。',
      true,
      '先问通不通：`git status --porcelain` 手跑一次。读不出就多问一轮，别改判据、也别把这一轮当成安静。');
  }

  // ---- 腿 2 前半：脏 且 新 = 活跃写入者 ----
  if (freshDirty.length) {
    var buildN = freshDirty.filter(function (d) { return d.isBuild; });
    var docN = freshDirty.filter(function (d) { return d.isDoc; });
    var fix = [];
    if (buildN.length) fix.push('不许 `npm run concat`（会把别人的半成品烘进 `page.js`，或把他们刚还原的字节顶掉）');
    if (docN.length) fix.push('两本台账与门面那一页别动（同一次提交会把别人的散文并进你这一个提交，AGENTS §3.4）');
    fix.push('要留证据就写进 `notes/` 草稿本（gitignore 区，不算交付）');
    return out('writing', buildN.length ? 'dirty-fresh-build' : 'dirty-fresh', EXIT.blocked,
      '腿 2 命中：' + freshDirty.length + ' 份文件**既带未提交改动、mtime 又落在 ' +
      Math.round(windowMs / 60000) + ' 分钟内**（构建输入 ' + buildN.length + ' 份、文档 ' + docN.length + ' 份）—— ' +
      '有人正在写。最近动的：' + names(freshDirty, 4) + '。' +
      (stamp === 'fresh' ? ' 另：腿 1 也新鲜，但 ' +
        (g.stampMine ? '调用方声明那一行是本会话自己写的（`--stamp-mine`）'
                    : 'stamp 里 `session=' + g.stampSession + '` 与本会话（' + (g.selfSession || '(未带)') + '）逐字相同') +
        '，所以那一格不算"别人在写"。' : ''),
      true, fix.join('；'));
  }

  // ---- 只有脏、mtime 陈旧 = 未提交的半成品，不是活跃写入者 ----
  if (dirty.length) {
    var dBuild = dirty.filter(function (d) { return d.isBuild; });
    var dDoc = dirty.filter(function (d) { return d.isDoc; });
    var unknown = dirty.filter(function (d) { return typeof d.ageMs !== 'number'; });
    return out('orphan-dirty', dBuild.length ? 'dirty-stale-build' : 'dirty-stale', EXIT.blocked,
      dirty.length + ' 份未提交的改动，但 mtime 都在窗口之外（最老 ' + mins(oldest(dirty)) + '）—— ' +
      '**这不是活跃写入者**：那是一轮没收尾（或被中断）留下的半成品。' +
      (dBuild.length ? ' 其中构建输入 ' + dBuild.length + ' 份：' + names(dBuild, 4) : '') +
      (dDoc.length ? '；文档 ' + dDoc.length + ' 份：' + names(dDoc, 4) : '') +
      (unknown.length ? '；另有 ' + unknown.length + ' 份拿不到 mtime（多半是被删掉的那一类），拿不到就不算"新"。' : ''),
      true,
      '可以改文件，但**只许 `git add` 自己本轮那几份**，别人的改动一个字都不许提交（AGENTS §3.4「`git status` 里混进别人的改动」那一族）；' +
      (dBuild.length ? '构建输入脏着 → 别跑 `npm run concat`，那会把别人的改动一起烘进 `page.js`；' : '') +
      '先按 AGENTS §1.0 把这条排进队列并记下证据，别拿"没人认领"当"没有"。');
  }

  // ---- 只有 mtime 新、树干净 = 刚有人还原过（可以动）----
  if (Number(g.freshCleanBuild) > 0) {
    return out('restored-not-writing', 'mtime-fresh-clean', EXIT.open,
      g.freshCleanBuild + ' 份构建输入 mtime 落在 ' + Math.round(windowMs / 60000) + ' 分钟内，但 `git status` 里**一份都不脏** —— ' +
      '那是"注入 → 逐字节还原"或"重跑一次拼接"留下的时间戳，**不是此刻在写**。可以动。' +
      (typeof g.concatAgeMs === 'number' ? ' `page.js` 距今 ' + mins(g.concatAgeMs) + '，它只说"跑过一次 concat"，不单独当写者证据。' : ''),
      false,
      '照常干活；开工前把 stamp 写成 `<ISO 带时区>  session=<会话号>`。');
  }

  // ---- 安静 ----
  var quiet = out('quiet', 'clean', EXIT.open,
    '腿 2 干净：树里没有未提交的跟踪改动，构建输入 mtime 都在窗口之外。' +
    (stamp === 'stale' ? ' 腿 1 那条 stamp 距今 ' + mins(g.stampAgeMs) + ' —— **注意这句话不是"没人写"的证据**，只是"最近没人在这一格里登记过"；放行靠的是腿 2。' : '') +
    (stamp === 'absent' ? ' 腿 1 没有 stamp 文件（同样的：不构成任何一边的证据）。' : '') +
    (stamp === 'unparsed' || stamp === 'unreadable' ? ' 腿 1 读不出（' + stamp + '）：既不算有人在写，也不算安静，放行是腿 2 给的。' : '') +
    (typeof g.commitAgeMs === 'number' && g.commitAgeMs <= windowMs
      ? ' 参考：最近一次提交距今 ' + mins(g.commitAgeMs) + ' —— 上一轮刚交过卷，这本身**不阻塞**（否则任何一轮自己的提交都会锁死下一轮）。'
      : ''),
    false);
  return quiet;
}

function out(verdict, via, exit, note, blocked, fix) {
  var v = { verdict: verdict, via: via, exit: exit, note: note, blocked: blocked === true };
  if (fix) v.fix = fix;
  return v;
}
function mins(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '(读不出)';
  var m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? m + ' 分钟' : (m / 60).toFixed(1) + ' 小时';
}
function names(list, n) {
  return list.slice(0, n).map(function (d) { return d.path + '（' + mins(d.ageMs) + '）'; }).join(' / ') +
    (list.length > n ? ' 等 ' + list.length + ' 份' : '');
}
function oldest(list) {
  var ages = list.map(function (d) { return d.ageMs; }).filter(function (a) { return typeof a === 'number'; });
  return ages.length ? Math.max.apply(null, ages) : null;
}

// ---------------------------------------------------------------------------
// 读数层：真的去问盘。任何一条读不出都落成明确的"读不出"，不猜。
// ---------------------------------------------------------------------------

var BUILD_DOC_SET = { 'AGENTS.md': 1, 'CHANGELOG.md': 1, 'HANDOVER.md': 1, 'README.md': 1, 'tools/README.md': 1 };
var BUILD_DOC_RE = /^docs\/.+\.md$/;

/** 构建输入：`src/page/*.js` + `manifest.content_scripts[0].js` 那 15 份（page.js 自己不算，见文件头） */
function buildInputs() {
  var set = {};
  try {
    fs.readdirSync(path.join(ROOT, 'src', 'page')).forEach(function (n) {
      if (/\.js$/.test(n)) set['src/page/' + n] = 1;
    });
  } catch (e) {}
  try {
    var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    var listed = ((m.content_scripts || [])[0] || {}).js || [];
    listed.forEach(function (p) { set[String(p).replace(/\\/g, '/')] = 1; });
  } catch (e) {}
  return set;
}

function readStamp() {
  var raw;
  try {
    raw = fs.readFileSync(STAMP, 'utf8');
  } catch (e) {
    return { state: e && e.code === 'ENOENT' ? 'absent' : 'unreadable', err: String((e && e.message) || e) };
  }
  var line = String(raw).split(/\r?\n/).filter(function (s) { return s.trim(); })[0] || '';
  var m = line.match(/^\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return { state: 'unparsed', line: line.slice(0, 120) };
  var iso = m[1] + 'T' + m[2] + (m[3] || '') + (m[4] || '');
  var t = Date.parse(m[4] ? iso : iso + 'Z');   // 没带时区的按 UTC 读（宁可判旧，也不凭空判新）
  if (!isFinite(t)) return { state: 'unparsed', line: line.slice(0, 120) };
  var sess = line.match(/session=([^\s]+)/);
  return { state: 'parsed', atMs: t, session: sess ? sess[1] : '', line: line.slice(0, 160) };
}

function gitJsonish(args) {
  var r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
  if (r.error) return { err: String((r.error && r.error.message) || r.error) };
  if (r.status !== 0) return { err: 'exit ' + r.status + ': ' + String(r.stderr || '').trim().slice(0, 120) };
  return { out: String(r.stdout || '') };
}

/** 把 `git status --porcelain` 切成 [{path, code}]，未跟踪（??）不计 —— 它不是被跟踪文件的写入目标 */
function parsePorcelain(text) {
  var rows = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    if (!line.trim()) return;
    var xy = line.slice(0, 2);
    if (xy === '??') return;
    var p = line.slice(2).replace(/\\/g, '/').trim();
    var arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (!p) return;
    rows.push({ path: p.replace(/^"|"$/g, ''), code: xy });
  });
  return rows;
}

function probe(opts) {
  opts = opts || {};
  var now = Number(opts.now) || Date.now();
  var windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : DEFAULT_WINDOW_MS;
  var g = { windowMs: windowMs, stampState: 'absent', dirty: [], freshCleanBuild: 0 };

  var s = readStamp();
  g.stampSession = s.session || '';
  g.stampLine = s.line || '';
  g.stampMine = opts.stampMine === true;
  g.selfSession = opts.session ? String(opts.session) : (process.env.OMITONE_SESSION ? String(process.env.OMITONE_SESSION) : '');
  if (s.state === 'absent') g.stampState = 'absent';
  else if (s.state === 'unreadable' || s.state === 'unparsed') g.stampState = s.state;
  else {
    g.stampAgeMs = now - s.atMs;
    // 未来的时间戳（时钟跳了 / 抄错）单独按 unparsed 说话：它既不该当"新鲜"阻塞，也不该当"陈旧"放行
    g.stampState = g.stampAgeMs < -windowMs ? 'unparsed' : (g.stampAgeMs <= windowMs ? 'fresh' : 'stale');
    if (g.stampState === 'unparsed') g.stampNote = 'stamp 里的时间在未来';
  }

  var st = gitJsonish(['status', '--porcelain']);
  if (st.err) g.gitErr = st.err;
  else {
    var inputs = buildInputs();
    var statErr = null;
    g.dirty = parsePorcelain(st.out).map(function (r) {
      var ageMs = null;
      try {
        ageMs = Math.max(0, now - fs.statSync(path.join(ROOT, r.path)).mtimeMs);
      } catch (e) {
        if (e && e.code !== 'ENOENT') statErr = r.path + ': ' + String(e.message || e);
        ageMs = null;   // 文件不在了（被删）→ 算脏但不算新，不许猜
      }
      return { path: r.path, code: r.code, isBuild: !!inputs[r.path], isDoc: !!BUILD_DOC_SET[r.path] || BUILD_DOC_RE.test(r.path), ageMs: ageMs };
    });
    if (statErr) g.statErr = statErr;
    g.freshCleanBuild = Object.keys(inputs).filter(function (p) {
      try {
        var age = now - fs.statSync(path.join(ROOT, p)).mtimeMs;
        return age >= 0 && age <= windowMs;
      } catch (e) { return false; }
    }).length - g.dirty.filter(function (d) { return d.isBuild && typeof d.ageMs === 'number' && d.ageMs <= windowMs; }).length;
    if (g.freshCleanBuild < 0) g.freshCleanBuild = 0;
  }

  var lg = gitJsonish(['log', '-1', '--format=%ct']);
  if (!lg.err) {
    var sec = Number(String(lg.out || '').trim());
    if (isFinite(sec) && sec > 0) g.commitAgeMs = Math.max(0, now - sec * 1000);
  }
  try {
    g.concatAgeMs = Math.max(0, now - fs.statSync(path.join(ROOT, 'page.js')).mtimeMs);
  } catch (e) {}

  var v = classify(g);
  v.raw = g;
  return v;
}

// ---------------------------------------------------------------------------
// 逐格对照：每格只在它自己身上红（AGENTS §2 #9 / 第 33、37 项的手法）
// ---------------------------------------------------------------------------

var CELLS = [
  {
    tag: '01干净树 + 陈旧 stamp → 放行，而且不许把放行记在 stamp 头上',
    g: { windowMs: 720000, stampState: 'stale', stampAgeMs: 40 * 60000, dirty: [], freshCleanBuild: 0 },
    verdict: 'quiet', exit: 0, noteHas: '放行靠的是腿 2'
  },
  {
    tag: '02没有 stamp → 放行（不构成任何一边的证据）',
    g: { windowMs: 720000, stampState: 'absent', dirty: [], freshCleanBuild: 0 },
    verdict: 'quiet', exit: 0, noteBan: ['有人在写']
  },
  {
    tag: '03stamp 新鲜 + 别人登记的 → 阻塞（腿 1 单独就够）',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 3 * 60000, stampSession: 'other-1', selfSession: 'me-1', dirty: [] },
    verdict: 'writing', via: 'stamp-fresh', exit: 1
  },
  {
    tag: '04stamp 新鲜但 session 与本会话相同 → 放行（这一格治的就是"报错人"）',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 3 * 60000, stampSession: 'me-1', selfSession: 'me-1', dirty: [] },
    verdict: 'quiet', exit: 0, ban: ['writing']
  },
  {
    tag: '05stamp 新鲜但没写 session → 保守阻塞，且处置交出 --stamp-mine 那句话',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 3 * 60000, stampSession: '', dirty: [] },
    verdict: 'writing', via: 'stamp-fresh-nosession', exit: 1, fixHas: '--stamp-mine', noteHas: '归因不到'
  },
  {
    tag: '06同上一条，但调用方声明 stamp 是自己写的 → 放行',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 3 * 60000, stampSession: '', stampMine: true, dirty: [] },
    verdict: 'quiet', exit: 0, blocked: false
  },
  {
    tag: '07stamp 内容解析不出 → 不算有人在写，也不算安静，放行由腿 2 给',
    g: { windowMs: 720000, stampState: 'unparsed', dirty: [], freshCleanBuild: 0 },
    verdict: 'quiet', via: 'clean', exit: 0, blocked: false, noteHas: '既不算有人在写'
  },
  {
    tag: '08构建输入脏 + mtime 新 → 阻塞，处置点名不许 concat',
    g: {
      windowMs: 720000, stampState: 'stale', dirty: [
        { path: 'src/page/62-tasks-run.js', isBuild: true, isDoc: false, ageMs: 60000 },
        { path: 'page.js', isBuild: false, isDoc: false, ageMs: 60000 }
      ]
    },
    verdict: 'writing', via: 'dirty-fresh-build', exit: 1, fixHas: 'npm run concat'
  },
  {
    tag: '09只有台账脏 + mtime 新 → 阻塞，处置点名两本台账，且不扯 concat',
    g: { windowMs: 720000, stampState: 'stale', dirty: [{ path: 'CHANGELOG.md', isBuild: false, isDoc: true, ageMs: 90000 }] },
    verdict: 'writing', via: 'dirty-fresh', exit: 1, fixHas: '两本台账', fixBan: ['npm run concat']
  },
  {
    tag: '10脏但 mtime 陈旧 → orphan-dirty（不是活跃写入者，但那几份不许提交）',
    g: { windowMs: 720000, stampState: 'stale', dirty: [{ path: 'src/page/60-tasks-detect.js', isBuild: true, isDoc: false, ageMs: 50 * 60000 }] },
    verdict: 'orphan-dirty', via: 'dirty-stale-build', exit: 1, noteHas: '不是活跃写入者', fixHas: 'git add'
  },
  {
    tag: '11mtime 新但树干净（还原形状）→ restored-not-writing，明说可以动',
    g: { windowMs: 720000, stampState: 'stale', dirty: [], freshCleanBuild: 3, concatAgeMs: 4 * 60000 },
    verdict: 'restored-not-writing', via: 'mtime-fresh-clean', exit: 0, blocked: false, noteHas: '可以动', noteBan: ['有人正在写']
  },
  {
    tag: '12只有 page.js 新鲜、输入全干净 → quiet（构建产物不单独当写者证据）',
    g: { windowMs: 720000, stampState: 'absent', dirty: [], freshCleanBuild: 0, concatAgeMs: 60000 },
    verdict: 'quiet', via: 'clean', exit: 0, blocked: false
  },
  {
    tag: '13git status 跑不出来 → unreadable，出口码 2 与阻塞的 1 分家',
    g: { windowMs: 720000, stampState: 'absent', gitErr: 'spawnSync git ETIMEDOUT' },
    verdict: 'unreadable', via: 'git-status', exit: 2, blocked: true, noteBan: ['可以动'], ban: ['quiet', 'writing', 'restored'], fixHas: '多问一轮'
  },
  {
    tag: '14mtime 读不出 → unreadable（单独占一格）',
    g: { windowMs: 720000, stampState: 'absent', dirty: [], gitErr: '', statErr: 'src/page/40-media.js: EACCES' },
    verdict: 'unreadable', via: 'stat', exit: 2, blocked: true, noteBan: ['可以动'], ban: ['quiet', 'writing']
  },
  {
    tag: '15stamp 陈旧 + 树干净，但刚刚有人提交过 → 照旧放行（自己上一轮的提交不许锁死下一轮）',
    g: { windowMs: 720000, stampState: 'stale', stampAgeMs: 40 * 60000, dirty: [], freshCleanBuild: 0, commitAgeMs: 60000 },
    verdict: 'quiet', exit: 0, noteHas: '不阻塞'
  },
  {
    tag: '16仲裁顺序：别人自报在写 + git 同时读不出 → 说话的是"有人在写"，不是"读不出"',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'other-2', selfSession: 'me-2', gitErr: 'exit 128: not a repo' },
    verdict: 'writing', via: 'stamp-fresh', exit: 1
  },
  {
    tag: '17脏文件已被删（拿不到 mtime）+ 其余干净 → orphan-dirty，不许把"拿不到"读成"新"',
    g: { windowMs: 720000, stampState: 'absent', dirty: [{ path: 'docs/notes-x.md', isBuild: false, isDoc: false, ageMs: null }] },
    verdict: 'orphan-dirty', via: 'dirty-stale', exit: 1, noteHas: '拿不到 mtime'
  },
  {
    tag: '18窗口换算：脏 + mtime 9 分钟，窗口给 5 分钟 → 落 orphan-dirty（窗口不许写死在判定里）',
    g: { windowMs: 5 * 60000, stampState: 'absent', dirty: [{ path: 'README.md', isBuild: false, isDoc: true, ageMs: 9 * 60000 }] },
    verdict: 'orphan-dirty', via: 'dirty-stale', exit: 1
  },
  {
    // 这一格钉的是**句子对不对**，不是判据：12:14:31 真跑时这句话把 `--stamp-mine` 说成了
    // 「session 与本会话相同」—— 两条出口机制完全不同，说错了下一轮就照着错的那条找。
    tag: '19脏且新 + stamp 新鲜但声明是自己写的 → 那句话必须点名 --stamp-mine，不许冒认 session',
    g: {
      windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: '', stampMine: true,
      dirty: [{ path: 'src/page/70-quiz-flow.js', isBuild: true, isDoc: false, ageMs: 30000 }]
    },
    verdict: 'writing', via: 'dirty-fresh-build', exit: 1, noteHas: '--stamp-mine', noteBan: ['逐字相同']
  },
  {
    tag: '20同一形状靠 session 逐字相同放行 → 那句话必须把两个号都印出来',
    g: {
      windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'takeover-7', selfSession: 'takeover-7',
      dirty: [{ path: 'src/page/70-quiz-flow.js', isBuild: true, isDoc: false, ageMs: 30000 }]
    },
    verdict: 'writing', via: 'dirty-fresh-build', exit: 1, noteHas: 'takeover-7', noteBan: ['--stamp-mine']
  }
];

function selftest() {
  var bad = [];
  CELLS.forEach(function (c, i) {
    var v = classify(c.g);
    var tag = '第 ' + (i + 1) + ' 格[' + c.tag + ']';
    if (v.verdict !== c.verdict) bad.push(tag + ' 期望 verdict=' + c.verdict + '，实际 ' + v.verdict + '（via=' + v.via + '）');
    if (c.via && v.via !== c.via) bad.push(tag + ' 期望 via=' + c.via + '，实际 ' + v.via);
    if (typeof c.exit === 'number' && v.exit !== c.exit) bad.push(tag + ' 期望出口码 ' + c.exit + '，实际 ' + v.exit);
    if (typeof c.blocked === 'boolean' && v.blocked !== c.blocked) bad.push(tag + ' 期望 blocked=' + c.blocked + '，实际 ' + v.blocked +
      '（blocked 是"这一轮能不能改文件"那一格 —— 调用方 require 它的人不看 exit，两边不同向就是其中一边永久失明）');
    if (c.noteHas && String(v.note || '').indexOf(c.noteHas) === -1) bad.push(tag + ' note 里找不到「' + c.noteHas + '」');
    if (c.noteBan) {
      var hitN = c.noteBan.filter(function (s) { return String(v.note || '').indexOf(s) >= 0; });
      if (hitN.length) bad.push(tag + ' note 里出现了不许说的话：' + hitN.join(' / '));
    }
    if (c.fixHas && String(v.fix || '').indexOf(c.fixHas) === -1) bad.push(tag + ' 处置里找不到「' + c.fixHas + '」');
    if (c.fixBan) {
      var hitB = c.fixBan.filter(function (s) { return String(v.fix || '').indexOf(s) >= 0; });
      if (hitB.length) bad.push(tag + ' 处置里说了不属于这一格的话：' + hitB.join(' / ') + '（那是别的格的形状）');
    }
    if (c.ban) {
      var hit = c.ban.filter(function (s) { return String(v.verdict || '').indexOf(s) === 0; });
      if (hit.length) bad.push(tag + ' 不许报成 ' + hit.join(' / ') + '（实际 ' + v.verdict + '）—— 那一族又压回一格了');
    }
  });
  // 通用卫生
  var seen = {};
  CELLS.forEach(function (c) {
    var v = classify(c.g);
    seen[v.verdict] = 1;
    if (typeof v.exit !== 'number') bad.push('verdict=' + v.verdict + ' 没有出口码');
    // exit 与 blocked 必须同向：CLI 按 exit 拦、被 require 的调用方按 blocked 拦，
    // 两边不同向时其中一边永远不响（这一族在批次 167 第一版真发生过：unreadable 退 2 却写 blocked:false）。
    if (v.exit !== 0 && v.blocked !== true) bad.push('verdict=' + v.verdict + ' 出口码 ' + v.exit + '（非 0）却把 blocked 写成 ' + v.blocked +
      ' —— 走 CLI 的人被拦住、读返回值的人被放行');
    if (v.exit === 0 && v.blocked === true) bad.push('verdict=' + v.verdict + ' 是放行（exit 0）却把 blocked 立成 true —— 同一格两种说法，调用方不知道听哪一边');
    if (v.verdict === 'writing' && !v.fix) bad.push('verdict=writing 的某一格没交出处置那句话');
    if (v.verdict === 'unreadable' && !v.fix) bad.push('verdict=unreadable 的某一格没交出"下一步怎么问"那句话');
  });
  ['quiet', 'writing', 'orphan-dirty', 'restored-not-writing', 'unreadable'].forEach(function (k) {
    if (!seen[k]) bad.push('verdict ' + k + ' 在对照表里一格都没有 —— 那一格坏了也不会有人知道');
  });
  if (bad.length) {
    var failed = {};
    bad.forEach(function (b) { failed[b.split(' 格[')[0]] = 1; });
    console.log('自检：' + (CELLS.length - Object.keys(failed).length) + ' / ' + CELLS.length + ' 格通过 —— 以下 ' + bad.length + ' 条：');
    bad.forEach(function (b) { console.log('  [FAIL] ' + b); });
    return 1;
  }
  console.log('并发判定逐格对照：' + CELLS.length + ' 格，覆盖 verdict 5 种（quiet / writing / orphan-dirty / restored-not-writing / unreadable），出口码 0/1/2 分家');
  console.log('对照格数: ' + CELLS.length);
  console.log('自检：' + CELLS.length + ' / ' + CELLS.length + ' 格通过');
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (process.argv.indexOf('--selftest') !== -1) {
    process.exitCode = selftest();
  } else {
    var v = probe({
      windowMs: argNum('window', 0) ? argNum('window', 0) * 1000 : DEFAULT_WINDOW_MS,
      session: argStr('session', ''),
      stampMine: hasFlag('stamp-mine')
    });
    var raw = v.raw || {};
    if (process.argv.indexOf('--json') !== -1) {
      console.log(JSON.stringify({
        verdict: v.verdict, via: v.via, exit: v.exit, blocked: v.blocked, note: v.note, fix: v.fix || '',
        windowMs: raw.windowMs, stampState: raw.stampState, stampAgeMs: raw.stampAgeMs,
        stampSession: raw.stampSession, dirty: raw.dirty, freshCleanBuild: raw.freshCleanBuild,
        commitAgeMs: raw.commitAgeMs, concatAgeMs: raw.concatAgeMs, gitErr: raw.gitErr || '', statErr: raw.statErr || ''
      }, null, 1));
    } else {
      console.log('verdict=' + v.verdict + '  via=' + v.via + (v.blocked ? '  （本轮收窄）' : '  （可以动）'));
      console.log('  ' + v.note);
      if (v.fix) console.log('  处置：' + v.fix);
      console.log('  读数：stamp ' + raw.stampState + (typeof raw.stampAgeMs === 'number' ? '（距今 ' + mins(raw.stampAgeMs) + '）' : '') +
        ' session=' + (raw.stampSession || '(无)') + ' / 脏 ' + ((raw.dirty || []).length) + ' 份 / ' +
        '窗口内新且脏 ' + ((raw.dirty || []).filter(function (d) { return typeof d.ageMs === 'number' && d.ageMs <= (raw.windowMs || DEFAULT_WINDOW_MS); }).length) + ' 份 / ' +
        '干净但新鲜 ' + (raw.freshCleanBuild || 0) + ' 份 / 最近提交 ' + mins(raw.commitAgeMs) +
        ' / page.js ' + mins(raw.concatAgeMs));
      console.log('  窗口 ' + Math.round((raw.windowMs || DEFAULT_WINDOW_MS) / 60000) + ' 分钟（--window=<秒> 可换）；这一件只读，一个字节都没写。');
    }
    process.exitCode = v.exit;
  }
}

module.exports = {
  classify: classify, probe: probe, selftest: selftest, readStamp: readStamp, parsePorcelain: parsePorcelain,
  buildInputs: buildInputs, DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS, EXIT: EXIT, CELLS: CELLS
};
