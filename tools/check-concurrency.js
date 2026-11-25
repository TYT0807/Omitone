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
 *   node tools/check-concurrency.js --done --session=abc 收尾交回：**只删自己那一发**认领条子
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
 *         条子里 `mode=read`（协议补丁 #224）→ 语义是"这一轮只读"，放行由腿 2 给，落 `other-reading` 单独说话；
 *         `mode=write` 或没有这一枚照旧阻塞（向后兼容），认不出的值按最保守的 write 处置。
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
 * ⚠️ 除 `--done` 那一发之外**一个字都不写**：只 `stat` 与跑 `git status` / `git log` 两条只读命令，
 * 带超时。`--done` 是全场唯一的动盘出口，而它删的只可能是**本会话自己写的那一发条子**
 * （归因不到、是别人的、读不出的，一律不删并单独说话）；往后进 stamp 用 Write 落，不在这把尺里。
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
  if (!g) return out('unreadable', 'no-input', EXIT.unreadable, '没有读数进来（调用方连 `probe()` 都没跑到）—— 这一格是读不出，不许读成"安静"。', true,
    '先问通不通：`node tools/check-concurrency.js --session=<本会话号>` 手跑一次；require 进来的调用方检查它喂 classify 的读数不是空的。');

  var windowMs = Number(g.windowMs) > 0 ? Number(g.windowMs) : DEFAULT_WINDOW_MS;
  var stamp = String(g.stampState || 'absent');
  var dirty = Array.isArray(g.dirty) ? g.dirty : [];
  var freshDirty = dirty.filter(function (d) { return typeof d.ageMs === 'number' && d.ageMs <= windowMs; });

  // ---- 腿 1：自报层。只有"新鲜 + 归因得到是别人"才阻塞 ----
  // 顺序要紧：这一发在 git 能不能读之前判（§selftest 第 16 格）—— 别人自报在写的时候，
  // 不管我们量不量得动盘都要先把这一轮收窄，两条证据不存在"谁读不到就当没有"。
  // mode= 一枚（协议补丁 #224，对端会话 1fd1c8df 2026-11-22 提）：条子的语义是"我要写"，
  // 只读轮拿它当"告知"会把 12 分钟窗口对全场重开。`mode=read` 不阻塞、只登记"有人在只读"；
  // `mode=write` 或**没有这一枚**照旧阻塞（向后兼容旧格式）；认不出的值按最保守的 write 处置 ——
  // 不许把"读不出"塌进放行那一格（AGENTS §2 #12）。
  var stampForeign = stamp === 'fresh' && g.stampMine !== true &&
    (!g.stampSession || !g.selfSession || g.stampSession !== g.selfSession);
  var stampReadAnnounce = false;
  if (stampForeign) {
    var sMode = String(g.stampMode || 'write');
    if (sMode === 'read') {
      stampReadAnnounce = true;   // 放行由腿 2 给；活跃写入者照样被 dirty-fresh 逮住
    } else {
      var noSess = !g.stampSession;
      return out('writing', noSess ? 'stamp-fresh-nosession' : 'stamp-fresh', EXIT.blocked,
        '腿 1 命中：`main-active.stamp` 距今 ' + mins(g.stampAgeMs) + '，' +
        (noSess ? '**里面没写 `session=`，归因不到是谁登记的**' : '登记的是 `session=' + g.stampSession + '`，不是本会话（' + (g.selfSession || '(未带 --session)') + '）') +
        ' —— 保守按"有人在写"处置。' +
        (sMode !== 'write' ? ' 另：条子里 `mode=' + sMode + '` 这一枚认不出来（只认 `read` / `write` / 无字段），按最保守的 `write` 算。' : ''),
        true,
        noSess
          ? '如果那一行就是本会话自己写的，带 `--stamp-mine` 再问一次；否则按只读轮走。往后进 stamp 要写成 `<ISO 带时区>  session=<会话号>  mode=write`，归因就不用猜。'
          : '等它过期（窗口 ' + Math.round(windowMs / 60000) + ' 分钟），或确认那一轮已经收尾。');
    }
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
    return out('orphan-dirty', dBuild.length ? 'dirty-stale-build' : 'dirty-stale', EXIT.open,
      dirty.length + ' 份未提交的改动，但 mtime 都在窗口之外（最老 ' + mins(oldest(dirty)) + '）—— ' +
      '**这不是活跃写入者**：那是一轮没收尾（或被中断）留下的半成品。' +
      (dBuild.length ? ' 其中构建输入 ' + dBuild.length + ' 份：' + names(dBuild, 4) : '') +
      (dDoc.length ? '；文档 ' + dDoc.length + ' 份：' + names(dDoc, 4) : '') +
      (unknown.length ? '；另有 ' + unknown.length + ' 份拿不到 mtime（多半是被删掉的那一类），拿不到就不算"新"。' : ''),
      false,
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

  // ---- 别人只登记了一条 mode=read 的条子，腿 2 又干净 → 放行，但那一格单独说话 ----
  if (stampReadAnnounce) {
    return out('other-reading', 'stamp-fresh-read', EXIT.open,
      '腿 1 有一条新鲜的外部条子写着 `mode=read`（距今 ' + mins(g.stampAgeMs) + '，`session=' + g.stampSession + '`）—— ' +
      '语义是"这一轮只读"，**不阻塞**；放行由腿 2 给（树里没改动、构建输入都在窗口之外）。',
      false,
      '可以动、可以跑套件；自己这一轮要写，照旧先认领条子（`mode=write`），并给对方发一句「已认领，预计 N 分钟内推提交」。');
  }

  // ---- 安静 ----
  var quiet = out('quiet', 'clean', EXIT.open,
    '腿 2 干净：树里没有未提交的跟踪改动，构建输入 mtime 都在窗口之外。' +
    (stamp === 'stale' ? ' 腿 1 那条 stamp 距今 ' + mins(g.stampAgeMs) + ' —— **注意这句话不是"没人写"的证据**，只是"最近没人在这一格里登记过"；放行靠的是腿 2。' : '') +
    (stamp === 'absent' ? ' 腿 1 没有 stamp 文件（同样的：不构成任何一边的证据）。' : '') +
    (stamp === 'blank' ? ' 腿 1 那**个文件在、里面是空的**（`blank`）：谁碰过条子却没写内容，这既不算有人在写也不算安静，放行只能由腿 2 给。' : '') +
    (stamp === 'unparsed' || stamp === 'unreadable' ? ' 腿 1 读不出（' + stamp + '，' + (g.stampNote || '格式不认／文件读不出') + '）：既不算有人在写，也不算安静，放行是腿 2 给的。' : '') +
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

// ---------------------------------------------------------------------------
// 收尾交回层（`--done`，批次 175）
//
// 这一发回答的**不是**「现在能不能改文件」（那是 classify() 那六格），而是
// 「我能不能把手上那一发认领交回」。两件事不许共用一张判定表：同一个盘上状态，
// 起手要"保守当有人在写"，交回却只认"是不是我自己的条子"。
// 唯一允许动盘的那一格是 `release`，而且它删完必须读回来证明**没了**（releaseRun）。
// 保守方向写死：**归因不到是谁的一律不删** —— 删掉别人正认领的条子 = 替对方把门打开，
// 那比"条子多躺一会儿"贵得多（AGENTS §1.05 腿 1 的语义：这张条子证明的是"我要写"）。
// ---------------------------------------------------------------------------

function plan(action, via, exit, blocked, note, fix) {
  var p = { action: action, via: via, exit: exit, blocked: blocked === true, note: note };
  if (fix) p.fix = fix;
  return p;
}

/** g = classify() 吃的同一份读数（stampState / stampSession / selfSession / stampMine）—— 纯函数，不碰盘 */
function releasePlan(g) {
  if (!g) {
    return plan('keep', 'no-reading', EXIT.unreadable, true,
      '没有读数进来 —— 交回这一发在没有读数时**不动盘**，这一格是读不出，不许读成"没有条子"。',
      '带 `--session=<本会话号>` 重跑 `--done`；跑不动就照 §1.05 手工 Write 那行条子。');
  }
  var stamp = String(g.stampState || 'absent');
  var sess = String(g.selfSession || '');

  // 幂等那一格：盘上本来没有条子，交回无事可做 —— 这既不阻塞也不证明什么。
  if (stamp === 'absent') {
    return plan('noop', 'stamp-absent', EXIT.open, false,
      '盘上没有认领条子 —— 无事可交回（多半已经交过一回，或这一轮压根没认领）。');
  }
  if (stamp === 'unreadable' || stamp === 'unparsed' || stamp === 'blank') {
    return plan('keep', 'stamp-' + stamp, EXIT.unreadable, true,
      '条子读不出这一发是谁认领的（stampState=' + stamp + '）—— **归因不到就不删**：那可能是别人正认领着的一条。' +
      (stamp === 'blank' ? ' 文件在、里面没内容 —— 谁 touch 过却没登记，这一格谁都不该替谁收尾。' : ''),
      '要交回自己那一发，先用 Write 把整行补全（`<ISO 带时区>  session=<会话号>  mode=write  note=…`）再跑 `--done --session=`；不是自己的就等它过期。');
  }
  // fresh / stale：先问"我"是谁。没带 --session 时，自己的条子与别人的条子在盘上长得一模一样。
  if (!sess) {
    return plan('keep', 'no-session', EXIT.blocked, true,
      '`--done` 没带 `--session=<本会话号>` —— 分不出这一发是不是我认领的那一发，不动盘。',
      '重跑：`node tools/check-concurrency.js --done --session=<本会话号>`。');
  }
  var mine = g.stampMine === true || (!!g.stampSession && String(g.stampSession) === sess);
  if (!mine) {
    return plan('keep', 'stamp-foreign', EXIT.blocked, true,
      '这一发认领登记的是 `session=' + (g.stampSession || '(没写，也没带 --stamp-mine)') + '`，不是本会话（' + sess + '）—— **只交回自己的**，替别人删条子等于替别人开门。',
      g.stampSession ? '等对方交回或条子过期；起手照旧问不带 --done 的那一发。'
                     : '如果那一行就是本会话自己写的（旧格式没带 session=），加 `--stamp-mine` 再交回。');
  }
  return plan('release', 'stamp-' + stamp, EXIT.open, false,
    '条子归本会话（`session=' + sess + '`，状态 ' + stamp + '）—— 可以交回；删完会读回来确认盘上真没了。');
}

/** 唯一动盘的出口：releasePlan 判成 `release` 才碰文件，删完**读回来**验没了才算交回。 */
function releaseRun(opts) {
  opts = opts || {};
  var p = releasePlan(opts.g);
  if (p.action !== 'release') {
    return { action: p.action, exit: p.exit, lines: ['交回：' + p.note].concat(p.fix ? ['  处置：' + p.fix] : []),
      json: { action: p.action, exit: p.exit, blocked: p.blocked, via: p.via, note: p.note, fix: p.fix || '', removed: false, verified: false } };
  }
  var rmErr = '';
  try {
    fs.rmSync(STAMP, { force: true });
  } catch (e) {
    rmErr = String((e && e.code) || '') + ': ' + String((e && e.message) || e);
  }
  var after = readStamp().state;
  var verified = after === 'absent';
  var lines = ['交回：' + p.note, '  删除：' + (rmErr ? '报错 ' + rmErr.slice(0, 100) : '已执行') +
    ' / 复查：' + (verified ? '盘上已经没有那一发认领 ✅' : '条子还在（stampState=' + after + '）❌')];
  var exit = verified ? EXIT.open : EXIT.unreadable;
  if (!verified) {
    lines.push('  处置：这一发**没有**当成收口证据 —— 读不回"没了"就当交回没发生（AGENTS §2 #12：读不出单独占一格），先看是不是别人刚认领过。');
  }
  return { action: 'release', exit: exit, lines: lines,
    json: { action: 'release', exit: exit, blocked: !verified, via: p.via, note: p.note, removed: !rmErr || verified, verified: verified, rmErr: rmErr } };
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

/**
 * 把条子那一行解析成读数 —— 纯函数，`--selftest` 喂合成文本走的就是这一发（批次 170）。
 *
 * ⚠️ 毫秒必须带小数点拼回去。上一版把捕到的 `563` 直接接在秒后面，拼出
 *   `16:30:43563+08:00` 这种没人写得出的格式，`Date.parse` 回 NaN，于是**任何带毫秒的条子**
 *   都判成 unparsed、归因印成 `session=(无)`：腿 1 那天正好是瞎的，而 verdict 照旧打印。
 */
function parseStamp(rawText) {
  var text = String(rawText === undefined || rawText === null ? '' : rawText);
  // blank 的成因是「整个文件没有一处非空白」—— 谁 touch 出来却没写内容。
  // 有字但对不上日期（英文速记、只剩注释）那是 unparsed，两格不许混：混了就把
  // 「碰过条子却没登记」读成「格式不认」，而放行/dispatch 说的根本不是同一件事。
  if (!text.trim()) return { state: 'blank', line: '' };
  var line = text.split(/\r?\n/).filter(function (s) { return s.trim(); })[0] || '';
  if (!line) return { state: 'blank', line: '' };
  var m = line.match(/^\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return { state: 'unparsed', line: line.slice(0, 120) };
  var iso = m[1] + 'T' + m[2] + (m[3] ? '.' + m[3] : '') + (m[4] || '');
  var t = Date.parse(m[4] ? iso : iso + 'Z');   // 没带时区的按 UTC 读（宁可判旧，也不凭空判新）
  if (!isFinite(t)) return { state: 'unparsed', line: line.slice(0, 120) };
  var sess = line.match(/session=([^\s]+)/);
  var mode = line.match(/mode=([^\s]+)/);
  return {
    state: 'parsed', atMs: t, session: sess ? sess[1] : '',
    mode: mode ? mode[1] : '', line: line.slice(0, 160), iso: iso
  };
}

function readStamp() {
  var raw;
  try {
    raw = fs.readFileSync(STAMP, 'utf8');
  } catch (e) {
    return { state: e && e.code === 'ENOENT' ? 'absent' : 'unreadable', err: String((e && e.message) || e) };
  }
  return parseStamp(raw);
}

/**
 * 解析结果 → 判定层那一格 stampState。**probe() 与 selftest() 共用这一发**，
 * 否则对照表测的是另一条路径、真盘那一条坏了没人知道（批次 170 立的口径）。
 * 'blank'（文件在、里面没内容）单独占一格：它既不是「没有条子」，也不是「读不出格式」。
 */
function applyStamp(g, s, now) {
  g.stampSession = s.session || '';
  g.stampLine = s.line || '';
  g.stampMode = s.mode || '';
  if (s.state === 'absent') g.stampState = 'absent';
  else if (s.state === 'unreadable' || s.state === 'unparsed') g.stampState = s.state;
  else if (s.state === 'blank') g.stampState = 'blank';
  else {
    g.stampAgeMs = now - s.atMs;
    // 未来的时间戳（时钟跳了 / 抄错）单独按 unparsed 说话：它既不该当"新鲜"阻塞，也不该当"陈旧"放行
    g.stampState = g.stampAgeMs < -g.windowMs ? 'unparsed' : (g.stampAgeMs <= g.windowMs ? 'fresh' : 'stale');
    if (g.stampState === 'unparsed') g.stampNote = 'stamp 里的时间在未来';
  }
  return g;
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
  g.stampMine = opts.stampMine === true;
  g.selfSession = opts.session ? String(opts.session) : (process.env.OMITONE_SESSION ? String(process.env.OMITONE_SESSION) : '');
  applyStamp(g, s, now);

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
    verdict: 'orphan-dirty', via: 'dirty-stale-build', exit: 0, blocked: false, noteHas: '不是活跃写入者', fixHas: 'git add'
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
    verdict: 'orphan-dirty', via: 'dirty-stale', exit: 0, blocked: false, noteHas: '拿不到 mtime'
  },
  {
    tag: '18窗口换算：脏 + mtime 9 分钟，窗口给 5 分钟 → 落 orphan-dirty（窗口不许写死在判定里）',
    g: { windowMs: 5 * 60000, stampState: 'absent', dirty: [{ path: 'README.md', isBuild: false, isDoc: true, ageMs: 9 * 60000 }] },
    verdict: 'orphan-dirty', via: 'dirty-stale', exit: 0, blocked: false
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
  },
  // ---- 批次 170：下面五格喂**条子原文**，第一次把 parseStamp 这一层拉进对照表 ----
  //      旧 20 格全喂合成 g，读盘那一层坏了也照样 20 / 20 通过（AGENTS §5「根本没走到那一层」）。
  {
    tag: '21带毫秒的真条子（现场形状）→ 解析得出、session 认得出，腿 1 单独就阻塞',
    raw: '2026-11-22T16:30:43.563+08:00  session=other-9  note=probe  window=12',
    nowMs: Date.parse('2026-11-22T08:30:43.563Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'writing', via: 'stamp-fresh', exit: 1, expectStamp: 'fresh', expectSession: 'other-9',
  },
  {
    tag: '22同一条不带毫秒 → 与上一格同判（治的就是拼 ISO 时把小数点丢了那一族）',
    raw: '2026-11-22T16:30:43+08:00  session=other-9  note=probe  window=12',
    nowMs: Date.parse('2026-11-22T08:30:43.000Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'writing', via: 'stamp-fresh', exit: 1, expectStamp: 'fresh', expectSession: 'other-9',
  },
  {
    tag: '23带 Z 的条子 → 按 UTC 读出来仍算新鲜（毫秒与 Z 两处都要过）',
    raw: '2026-11-22T08:30:43.500Z  session=zeta  window=12',
    nowMs: Date.parse('2026-11-22T08:35:00Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'writing', via: 'stamp-fresh', exit: 1, expectStamp: 'fresh', expectSession: 'zeta',
  },
  {
    tag: '24条子时间在未来 20 分钟 → 落 unparsed 那一格，不许当新鲜阻塞、也不许当陈旧放行',
    raw: '2026-11-22T16:50:00.000+08:00  session=early-bird',
    nowMs: Date.parse('2026-11-22T08:30:00Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'quiet', via: 'clean', exit: 0, expectStamp: 'unparsed', noteHas: '在未来'
  },
  {
    tag: '25文件在、里面只有空白（谁 touch 出来却没写内容）→ blank 单独占一格，不许塌进「没有条子」那句话',
    raw: '   ' + String.fromCharCode(10) + '        ',
    nowMs: Date.parse('2026-11-22T08:30:00Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'quiet', via: 'clean', exit: 0, expectStamp: 'blank', noteHas: '里面是空的', noteBan: ['没有 stamp 文件', '格式不认']
  },
  {
    tag: '26条子里是一句英文速记（不是日期）→ 读盘这一层落 unparsed，既不许读成「没有条子」也不许读成 blank',
    raw: 'idle, shell only' + String.fromCharCode(10) + '   session=who-knows',
    nowMs: Date.parse('2026-11-22T08:30:00Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-9' },
    verdict: 'quiet', via: 'clean', exit: 0, expectStamp: 'unparsed', noteHas: '格式不认',
    noteBan: ['没有 stamp 文件', '里面是空的'],
  },
  // ---- 协议补丁 #224（批次 172）：mode= 一枚把「只读轮不许拿条子当告知」从约定升成尺 ----
  {
    tag: '27真条子写 mode=read → 只读放行：verdict=other-reading、exit 0，句子必须说出"只读"，不许说成有人在写',
    raw: '2026-11-22T19:10:00.000+08:00  session=other-r  mode=read  note=只读分析  window=12',
    nowMs: Date.parse('2026-11-22T11:12:00Z'),
    base: { windowMs: 720000, dirty: [], freshCleanBuild: 0, selfSession: 'me-r' },
    verdict: 'other-reading', via: 'stamp-fresh-read', exit: 0, blocked: false,
    expectStamp: 'fresh', expectSession: 'other-r', noteHas: 'mode=read', noteBan: ['有人在写'],
  },
  {
    tag: '28mode=read 但腿 2 抓到脏且新 → 照旧 writing（只读条子不许把活跃写入者也放掉）',
    g: {
      windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'other-r', selfSession: 'me-r', stampMode: 'read',
      dirty: [{ path: 'src/page/40-media.js', isBuild: true, isDoc: false, ageMs: 30000 }]
    },
    verdict: 'writing', via: 'dirty-fresh-build', exit: 1
  },
  {
    tag: '29外部条子明写 mode=write → 与无字段同判（向后兼容不许反过来）',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'other-r', selfSession: 'me-r', stampMode: 'write', dirty: [] },
    verdict: 'writing', via: 'stamp-fresh', exit: 1
  },
  {
    tag: '30mode= 是认不出的自造词（idle 这种）→ 按最保守的 write 阻塞，句子里必须点名那枚值',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'other-r', selfSession: 'me-r', stampMode: 'idle', dirty: [] },
    verdict: 'writing', via: 'stamp-fresh', exit: 1, noteHas: 'mode=idle'
  },
  // ---- 批次 175：收尾交回（`--done`）那族格子。kind:'plan' 走 releasePlan，不是 classify ----
  // 判据只有一句：**归因不到是谁的一律不删**。删掉别人正认领的条子 = 替对方开门，
  // 比"条子多躺 12 分钟"贵；所以 absent 之外每一格 keep 都必须非 0 出口且单独说话。
  {
    kind: 'plan',
    tag: '31盘上没有条子 → noop 放行退出 0，幂等（交回第二回不许报错）',
    g: { windowMs: 720000, stampState: 'absent', dirty: [], freshCleanBuild: 0 },
    action: 'noop', via: 'stamp-absent', exit: 0, blocked: false, noteHas: '无事可交回', noteBan: ['已删除', '有人在写']
  },
  {
    kind: 'plan',
    tag: '32条子是自己认领的且新鲜 → release，唯一允许动盘的那一格',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'me-7', selfSession: 'me-7', dirty: [] },
    action: 'release', exit: 0, blocked: false, noteHas: '归本会话'
  },
  {
    kind: 'plan',
    tag: '33条子是自己的但早过期 → 照旧 release（自清理不受新鲜度门管，留着反而继续挡别人）',
    g: { windowMs: 720000, stampState: 'stale', stampAgeMs: 40 * 60000, stampSession: 'me-7', selfSession: 'me-7', dirty: [] },
    action: 'release', exit: 0, noteHas: 'stale'
  },
  {
    kind: 'plan',
    tag: '34条子是别人正认领的 → keep、阻塞，句子点名那枚 session，**绝不许出现"已删除"字样**',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'other-9', selfSession: 'me-7', dirty: [] },
    action: 'keep', via: 'stamp-foreign', exit: 1, blocked: true, noteHas: '只交回自己的', noteBan: ['已删除', '无事可交回']
  },
  {
    kind: 'plan',
    tag: '35旧格式条子（没写 session=）但调用方声明 --stamp-mine → release（与起手第 06 格同一条归因通道）',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: '', stampMine: true, selfSession: 'me-7', dirty: [] },
    action: 'release', exit: 0, noteHas: '归本会话'
  },
  {
    kind: 'plan',
    tag: '36没带 --session 就 --done → keep 阻塞：自己的与别人的条子在盘上长得一模一样，不许猜',
    g: { windowMs: 720000, stampState: 'fresh', stampAgeMs: 60000, stampSession: 'me-7', selfSession: '', dirty: [] },
    action: 'keep', via: 'no-session', exit: 1, blocked: true, noteHas: '--session=<本会话号>'
  },
  {
    kind: 'plan',
    tag: '37条子格式认不出（unparsed）→ 出口码 2 单独占一格，不许塌进"没有条子"更不许删',
    g: { windowMs: 720000, stampState: 'unparsed', dirty: [], freshCleanBuild: 0 },
    action: 'keep', exit: 2, blocked: true, noteHas: '归因不到就不删', noteBan: ['无事可交回', '已删除']
  },
  {
    kind: 'plan',
    tag: '38条子是 blank（touch 过没登记内容）→ 同样不删，并说出"谁都不该替谁收尾"',
    g: { windowMs: 720000, stampState: 'blank', dirty: [], freshCleanBuild: 0 },
    action: 'keep', exit: 2, blocked: true, noteHas: '里面没内容'
  },
  {
    kind: 'plan',
    tag: '39连读数都没有（调用方 probe 之前就 --done）→ 读不出当不删，不许读成"没有条子"（§2 #12）',
    g: null,
    action: 'keep', via: 'no-reading', exit: 2, blocked: true, noteHas: '没有读数进来'
  },
  {
    kind: 'out',
    tag: '40默认出口那四行逐字节钉住：--done 是接在同一 CLI 上的旁路，它不许动任何人起手看到的字',
    g: { windowMs: 720000, stampState: 'absent', dirty: [], freshCleanBuild: 0 },
    wantLines: [
      'verdict=quiet  via=clean  （可以动）',
      '  腿 2 干净：树里没有未提交的跟踪改动，构建输入 mtime 都在窗口之外。 腿 1 没有 stamp 文件（同样的：不构成任何一边的证据）。',
      '  读数：stamp undefined session=(无) mode=(无) / 脏 0 份 / 窗口内新且脏 0 份 / 干净但新鲜 0 份 / 最近提交 (读不出) / page.js (读不出)',
      '  窗口 12 分钟（--window=<秒> 可换）；这一件只读，一个字节都没写。'
    ]
  }
];

/**
 * 对照表的一格 → 判定层那个读数。**主循环与通用卫生循环共用这一发**：
 * 真文本格（`raw`）在这里过 parseStamp → applyStamp，与 probe() 走同一把映射，
 * 读盘那一层的两条期望（stampState / session）也在这里点名；合成格（`g`）原样交回。
 * 卫生那一趟若自己去 `classify(c.g)`，真文本格拿到的是 `undefined` —— 于是「调用方
 * 连读数都没给」那一格被当成对照表里的真形状，报出一批根本不存在的红（批次 170 实测：
 * 新增 5 个真文本格 → 5 句「verdict=unreadable 的某一格没交出下一步怎么问」）。
 */
function cellG(c, i, bad) {
  var sink = Array.isArray(bad) ? bad : [];
  if (c.g !== undefined) return c.g;
  if (typeof c.raw !== 'string') return c.g;
  var g = applyStamp(Object.assign({ windowMs: 720000 }, c.base || {}), parseStamp(c.raw), c.nowMs || Date.now());
  var tag = '第 ' + (typeof i === 'number' && i >= 0 ? i + 1 : '?') + ' 格[' + c.tag + ']';
  if (c.expectStamp && g.stampState !== c.expectStamp) {
    sink.push(tag + ' 解析读出 stampState=' + g.stampState + '，期望 ' + c.expectStamp +
      '（条子首行=' + JSON.stringify(String(g.stampLine).slice(0, 48)) + '）—— 读盘这一层坏了，判定层再怎么对也不叫覆盖');
  }
  if (c.expectSession && g.stampSession !== c.expectSession) {
    sink.push(tag + ' session 归因成 ' + JSON.stringify(g.stampSession) + '，期望 ' + JSON.stringify(c.expectSession) +
      ' —— 归因读不出时腿 1 就是瞎的');
  }
  return g;
}

function checkPlan(c, g, tag, bad) {
  var p = releasePlan(g);
  var why = [];
  if (c.action && p.action !== c.action) why.push('期望 action=' + c.action + '，实际 ' + p.action);
  if (typeof c.exit === 'number' && p.exit !== c.exit) why.push('期望出口码 ' + c.exit + '，实际 ' + p.exit);
  if (c.via && p.via !== c.via) why.push('期望 via=' + c.via + '，实际 ' + p.via);
  if (typeof c.blocked === 'boolean' && p.blocked !== c.blocked) why.push('期望 blocked=' + c.blocked + '，实际 ' + p.blocked);
  if (p.exit !== 0 && p.blocked !== true) why.push('出口码非 0 却把 blocked 写成 ' + p.blocked +
    ' —— CLI 按 exit 拦、调用方按 blocked 拦，两边不同向其中一边永远不响');
  if (p.exit === 0 && p.action === 'keep') why.push('keep（一个字都没动盘）却退出 0 —— 调用方会把"没交回"读成"已收口"');
  if (c.noteHas && String(p.note || '').indexOf(c.noteHas) === -1) why.push('话里找不到「' + c.noteHas + '」');
  if (c.noteBan) {
    var hb = c.noteBan.filter(function (s) { return String(p.note || '').indexOf(s) >= 0; });
    if (hb.length) why.push('说了不该说的话：' + hb.join(' / ') + '（那是别的格的形状——"删了别人的条子"就藏在这种句子里）');
  }
  if (why.length) bad.push(tag + ' 交回格走岔：' + why.join('；'));
}

function checkOut(c, tag, bad) {
  var got = reportLines(classify(cellG(c, -1, [])), c.opts || {});
  if (JSON.stringify(got) !== JSON.stringify(c.wantLines)) {
    bad.push(tag + ' 默认出口的句子变了：期望 ' + JSON.stringify(c.wantLines) + '，实际 ' + JSON.stringify(got) +
      ' —— 起手那一发对每一轮都是这几行字；若这是**有意**改口径，就来这一格同步钉句，别改判据迁就红项');
  }
}

function selftest() {
  var bad = [];
  CELLS.forEach(function (c, i) {
    var g = cellG(c, i, bad);
    var tag = '第 ' + (i + 1) + ' 格[' + c.tag + ']';
    if (c.kind === 'plan') { checkPlan(c, g, tag, bad); return; }
    if (c.kind === 'out') { checkOut(c, tag, bad); return; }
    var v = classify(g);
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
    if (c.kind === 'plan' || c.kind === 'out') return;   // 交回格与出口钉格各自有自己的卫生（checkPlan / checkOut），classify 的尺量不到它们的判据
    var v = classify(cellG(c, -1, []));
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
  ['quiet', 'writing', 'orphan-dirty', 'restored-not-writing', 'unreadable', 'other-reading'].forEach(function (k) {
    if (!seen[k]) bad.push('verdict ' + k + ' 在对照表里一格都没有 —— 那一格坏了也不会有人知道');
  });
  // 「--quiet 只看退出码」这句承诺（AGENTS §1.05）以前没有任何东西执行它 —— 下面四格分别钉
  // 打印函数的三格形状 + CLI 那一发接线，缺一格就回到"文档里有、盘上没有"。
  var sampleQ = classify(cellG(CELLS[0], -1, []));
  if (reportLines(sampleQ, { quiet: true }).length !== 0) {
    bad.push('--quiet 那一路打印了 ' + reportLines(sampleQ, { quiet: true }).length +
      ' 行 —— §1.05 说的是「只看退出码」，打印了就等于这一族从来没有 --quiet');
  }
  var plain = reportLines(sampleQ, {});
  if (plain.length < 4 || plain[0].indexOf('verdict=') !== 0 || plain.join('\n').indexOf('读数') < 0) {
    bad.push('不加 --quiet 时打印 ' + plain.length + ' 行（要 ≥4 且首行 verdict=、含「读数」）—— ' +
      '这一格是 --quiet 那一格的对照：没有它，"少打印"与"没打印"分不开');
  }
  var asJson = reportLines(sampleQ, { json: true });
  var parsedJson = null;
  try { parsedJson = asJson.length === 1 ? JSON.parse(asJson[0]) : null; } catch (e) { parsedJson = null; }
  if (!parsedJson || parsedJson.verdict !== sampleQ.verdict || parsedJson.exit !== sampleQ.exit) {
    bad.push('--json 那一路要交出**一行**能 parse 回 verdict / exit 的 json（实际行数 ' + asJson.length + '）');
  }
  // 接线：格式化函数自己正确没用，CLI 必须真把 --quiet 传进去（锚点紧到只认那一发赋值）
  var src = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).filter(function (l) {
    return l.replace(/^\s+/, '').indexOf('//') !== 0;
  }).join('\n');
  if (src.indexOf('quiet: hasFlag(\'quiet\')') < 0) {
    bad.push('CLI 里没有 `quiet: hasFlag(\'quiet\')` 那一发接线 —— 打印函数支持 --quiet 而调用方不传，' +
      '等于文档承诺了一条谁都不执行的开关（剥注释后比，注释里本来就写着这句话）');
  }
  if (bad.length) {
    var failed = {};
    bad.forEach(function (b) { failed[b.split(' 格[')[0]] = 1; });
    console.log('自检：' + (CELLS.length - Object.keys(failed).length) + ' / ' + CELLS.length + ' 格通过 —— 以下 ' + bad.length + ' 条：');
    bad.forEach(function (b) { console.log('  [FAIL] ' + b); });
    return 1;
  }
  console.log('并发判定逐格对照：' + CELLS.filter(function (c) { return !c.kind || c.kind === 'classify'; }).length + ' 格（classify） + ' +
    CELLS.filter(function (c) { return c.kind === 'plan'; }).length + ' 格（收尾交回 --done） + ' +
    CELLS.filter(function (c) { return c.kind === 'out'; }).length + ' 格（默认出口逐字节），覆盖 verdict 6 种（quiet / other-reading / writing / orphan-dirty / restored-not-writing / unreadable），出口码 0/1/2 分家');
  console.log('对照格数: ' + CELLS.length);
  console.log('自检：' + CELLS.length + ' / ' + CELLS.length + ' 格通过');
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// 打印单独折成一个函数，是因为 AGENTS §1.05 那句「加 --quiet 只看退出码」以前**没有任何东西执行它** ——
// 写在 console.log 串里的话没法被自检问一次，"承诺了却没实现"与"根本没承诺"在盘上长得一模一样。
function reportLines(v, opts) {
  opts = opts || {};
  var raw = v.raw || {};
  if (opts.quiet) return [];
  if (opts.json) {
    return [JSON.stringify({
      verdict: v.verdict, via: v.via, exit: v.exit, blocked: v.blocked, note: v.note, fix: v.fix || '',
      windowMs: raw.windowMs, stampState: raw.stampState, stampAgeMs: raw.stampAgeMs,
      stampSession: raw.stampSession, stampMode: raw.stampMode || '', dirty: raw.dirty, freshCleanBuild: raw.freshCleanBuild,
      commitAgeMs: raw.commitAgeMs, concatAgeMs: raw.concatAgeMs, gitErr: raw.gitErr || '', statErr: raw.statErr || ''
    }, null, 1)];
  }
  return [
    'verdict=' + v.verdict + '  via=' + v.via + (v.blocked ? '  （本轮收窄）' : '  （可以动）'),
    '  ' + v.note,
    v.fix ? '  处置：' + v.fix : '',
    '  读数：stamp ' + raw.stampState + (typeof raw.stampAgeMs === 'number' ? '（距今 ' + mins(raw.stampAgeMs) + '）' : '') +
      ' session=' + (raw.stampSession || '(无)') + ' mode=' + (raw.stampMode || '(无)') + ' / 脏 ' + ((raw.dirty || []).length) + ' 份 / ' +
      '窗口内新且脏 ' + ((raw.dirty || []).filter(function (d) { return typeof d.ageMs === 'number' && d.ageMs <= (raw.windowMs || DEFAULT_WINDOW_MS); }).length) + ' 份 / ' +
      '干净但新鲜 ' + (raw.freshCleanBuild || 0) + ' 份 / 最近提交 ' + mins(raw.commitAgeMs) +
      ' / page.js ' + mins(raw.concatAgeMs),
    '  窗口 ' + Math.round((raw.windowMs || DEFAULT_WINDOW_MS) / 60000) + ' 分钟（--window=<秒> 可换）；这一件只读，一个字节都没写。'
  ].filter(function (l) { return l !== ''; });
}

if (require.main === module) {
  if (process.argv.indexOf('--selftest') !== -1) {
    process.exitCode = selftest();
  } else if (hasFlag('done')) {
    // 收尾交回（批次 175）：全场唯一动盘的出口。读数走的是 probe() 同一把尺，判据全在 releasePlan 那张表里。
    var pv = probe({
      windowMs: argNum('window', 0) ? argNum('window', 0) * 1000 : DEFAULT_WINDOW_MS,
      session: argStr('session', ''),
      stampMine: hasFlag('stamp-mine')
    });
    var rr = releaseRun({ g: pv.raw });
    if (hasFlag('json')) console.log(JSON.stringify(rr.json));
    else if (!hasFlag('quiet')) rr.lines.forEach(function (l) { console.log(l); });
    process.exitCode = rr.exit;
  } else {
    var v = probe({
      windowMs: argNum('window', 0) ? argNum('window', 0) * 1000 : DEFAULT_WINDOW_MS,
      session: argStr('session', ''),
      stampMine: hasFlag('stamp-mine')
    });
    reportLines(v, { json: hasFlag('json'), quiet: hasFlag('quiet') }).forEach(function (l) { console.log(l); });
    process.exitCode = v.exit;
  }
}

module.exports = {
  classify: classify, probe: probe, selftest: selftest, readStamp: readStamp, parseStamp: parseStamp,
  applyStamp: applyStamp, parsePorcelain: parsePorcelain, reportLines: reportLines,
  releasePlan: releasePlan, releaseRun: releaseRun,
  buildInputs: buildInputs, DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS, EXIT: EXIT, CELLS: CELLS
};
