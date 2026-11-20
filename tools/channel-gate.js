#!/usr/bin/env node
/**
 * 通道闸：实验版支线与发布线各自只能碰自己那一条下载口。
 *
 * 用户口径的变化（四条，方向各不相同，都要守住）：
 *   2026-11-19「实验版**要**与稳定版隔离开」→ `release` / `replace-asset` 在支线上挡下。
 *     ⚠️ 这一条当时被我缩成了「实验版不提供直接下载」并当成作者原话写进文档 ——
 *     作者 2026-11-20 更正：「我没有说不提供直接下载啊，就是提供直接下载，
 *     只不过放在正常（下载入口）的下面一点而已」。挡下载口这件事本身没错（正式版那两个附件不许换），
 *     但**它不等于预览口不许存在**，见下面第二条。
 *   2026-11-20「实验班也可以加入 readme 的正常下载的旁边，特别标明就行」
 *            → 开一条**只给支线用**的 `preview` 口（移动 tag `preview` + `omitone-preview.zip`），
 *              它永远碰不到 `releases/latest/download/omitone.zip` 那条稳定直链。
 *   2026-11-20「门面是我们的正常 main 啊…这不是舍本逐末嘛？」
 *            → **给人看的那一页（README / 说明书 / Release 说明）归 `main`**，支线只是频繁更新的草稿本；
 *              本闸只管「哪条命令能改哪一条通道的字节」，**不管门面写在哪个分支上** ——
 *              门面归属那条尺在 `tools/check.js` 第 34 项的 e / g 两格（g 直接从 git 读 `main` 那一份）。
 *   2026-11-20「树枝那边的 readme…一切都是为了 AI 做事服务，不需要考虑人类阅读之类的」
 *            → 门面**只养一份**：支线工作树那份 README 是指针 + 工作笔记，不许再抄一份门面。
 *              同样归第 34 项判，本闸不掺和。
 *
 * ⚠️ 为什么要有这个闸，而不是只在 AGENTS §3.8 写一句「别跑那条命令」：
 *   这一族事故的形状不是报错，是**发版命令自己会把实验版推成用户下载的官方版** ——
 *   `replace-asset` 取的本地包是按 `manifest.version` 推出来的（`dist/omitone-<版本>.zip`），
 *   在实验支线上跑它，上传的就是**实验版那一份**，而附件名仍是线上稳定版的 `omitone.zip`。
 *   一句话：README 那条永久直链从此给同学发实验版，而**每一条命令都打印成功**。
 *   文字规矩挡不住这一发（它要靠人记得），闸可以。
 *
 * 挡的范围刻意做窄：只挡改「下载到的字节」那两条（`release` / `replace-asset`）。
 * `verify` 是 AGENTS §3.7 要求**必跑**的只读核验，`notes` 只改说明那一页，
 * `push` 是提交代码 —— 把它们一起挡死，就得到一条恒红的发版流程，
 * 而**会误报的守卫和没有守卫一样害人**（AGENTS §5）。
 *
 * 用法：
 *   node tools/channel-gate.js --selftest     # 逐格对照（check.js 第 34 项钉这个）
 *   node tools/channel-gate.js check <cmd>    # 拿当前工作树的 manifest 判一条命令该不该挡
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

// 实验版标记的两种写法都要认：`version_name` 里那个英文 token 是构建脚本自己保留的
// （tools/build.js 认出 `experimental` 才会把它**留在**新的 version_name 前面），
// 中文「实验版」是人手写的。识别不分大小写。
var EXP_RE = /experimental|实验/i;

// 只有这两条会改「同学点下载拿到的东西」
var DOWNLOAD_CMDS = ['release', 'replace-asset'];

// 预览通道：只动移动的 tag `preview` 与 `omitone-preview.zip`，永远碰不到
// `releases/latest/download/omitone.zip` 那条稳定直链（用户口径 2026-11-20：
// 「实验班也可以加入 readme 的正常下载的旁边，特别标明就行」）。
// ⚠️ 这一枚**不许并进 DOWNLOAD_CMDS**：那一族是「实验版不许动」，预览恰恰相反 ——
//    它就是给实验版用的口。并进同一张表，这一支自己就发不出预览了。
var PREVIEW_CMDS = ['preview'];

function isExperimental(versionName) {
  return EXP_RE.test(String(versionName || ''));
}

function channelOf(versionName) {
  return isExperimental(versionName) ? 'exp' : 'stable';
}

/**
 * 读当前工作树的 `manifest.json` 里那两个版本字段。
 *
 * ⚠️ 判据的**唯一来源是 version_name**，不是 version：版本号那五位有闸要逐字比
 * （checkVersionConsistency），写成 `1.3.1-exp` 会当场把弹窗与面板品牌位顶红，
 * 而通道这件事本来就不该由版本号表达。
 */
function readChannelNames(rootDir) {
  var file = path.join(rootDir || ROOT, 'manifest.json');
  var raw = fs.readFileSync(file, 'utf8');
  // manifest 带着 BOM 时 JSON.parse 会当场抛 —— 那副表现是「闸读不出」，不是「没配 manifest」
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  var m = JSON.parse(raw);
  return { version: m.version, version_name: m.version_name };
}

/**
 * 这一发命令在当前通道下该不该被挡下。返回 null 表示放行。
 *
 * 纯函数（只吃 version_name 与 cmd）—— 这样逐格自证不必碰磁盘，
 * 也给「认不出来就放行」留了一格可测的位置。
 *
 * 两个方向各自的事故形状不一样，别混成一句：
 *   · 实验支线 + `release` / `replace-asset` → **同学下载的正式版被换成实验版**（旧那一族，仍挡）；
 *   · 发布线 + `preview` → 线上多出一个和正式版一模一样的「预览包」，
 *     而它对应的版本号已经是稳定版 —— 装了它的人会一直被告知自己在用预览版。
 */
function blockReason(versionName, cmd) {
  var exp = isExperimental(versionName);
  if (DOWNLOAD_CMDS.indexOf(cmd) >= 0) return exp ? reasonForStableCmd(versionName, cmd) : null;
  if (PREVIEW_CMDS.indexOf(cmd) >= 0) return exp ? null : reasonForPreviewCmd(versionName, cmd);
  return null;
}

function reasonForStableCmd(versionName, cmd) {
  var lines = [
    '✗ ' + cmd + ' 被通道闸挡下：这一份工作树是实验版（version_name「' + versionName + '」）。',
    '  本闸只管一件事：**实验版不进稳定通道**（AGENTS §3.8）。',
    '  被挡的是「改同学点下载拿到的那一份字节」那两条 ——',
    '    · release        会新建一版公开 Release，直链立刻指向它；',
    '    · replace-asset  会把 dist 里按当前版本号构建出的**实验版那份**覆盖到线上稳定版的同名附件上。',
    '  两种都**不报错、每条命令都打印成功**，只有几周后发现「下载的人装的是实验版」才看得见。',
    '→ 要发稳定版：切回发布线（那一份 manifest 的 version_name 不带 experimental），再跑同一条命令。',
    '→ 要让同学装上这一支：跑 `preview` —— 它只动移动的 tag `preview` 与 `omitone-preview.zip`，',
    '   不碰 `releases/latest/download/omitone.zip` 那条永久直链。',
    '→ 要转正这一支：先满足转正条件（现场串行把课刷完 + 同口径复账确认进度没被事后收回），',
    '   再去掉 version_name 里的 experimental、把 README 与说明书里写着这一支的那几处改回正式，最后发版。',
    '   门面里那条 🧪 预览入口**不撤**（它写在 main 上，转正后换新支线的版本号就行）。',
    '  只读核验 verify、改说明 notes、提交 push 三条不受本闸影响，照旧能跑。'
  ];
  return lines.join('\n');
}

function reasonForPreviewCmd(versionName, cmd) {
  var lines = [
    '✗ ' + cmd + ' 被通道闸挡下：这一份工作树是**发布线**（version_name「' + versionName + '」，不带 experimental）。',
    '  预览口只给实验支线用。在发布线上发预览，线上会多出一份与正式版同字节的「预览包」，',
    '  而装了它的人从此一直看到「你在用预览版」—— 这一族不报错，只有人去对照版本号才发现不对。',
    '→ 要发这一支的预览：切到 exp/x.y.z 支线（manifest 的 version_name 带 experimental），再跑 `preview`。',
    '→ 这一支已经转正：走 release 那条正路（切回发布线 → 去掉 experimental → 发版 →' +
    '把门面里那条 🧪 预览入口换成新支线的版本号），不要在发布线上补一发 preview。'
  ];
  return lines.join('\n');
}

/** 拿当前工作树的 manifest 判 —— 给 tools/github-release.js 用。 */
function blockReasonForRepo(cmd, rootDir) {
  return blockReason(readChannelNames(rootDir).version_name, cmd);
}

// ---------------------------------------------------------------------------
// 逐格自证
//
// ⚠️ 每一格都要**只在自己身上红**：摘掉「DOWNLOAD_CMDS 里那一枚」只红对应那格，
// 摘掉「认不出就放行」那一格只红第 8 格。写在 check.js 里的判据是「格数不许掉」。
// ---------------------------------------------------------------------------
function selfTest() {
  var cases = [
    { name: '实验版 + release 挡下', want: 'blocked', got: verdict(blockReason('1.3.1 experimental', 'release')) },
    { name: '实验版 + replace-asset 挡下（这一条最贵：它会把实验版覆盖到稳定版的附件名上）',
      want: 'blocked', got: verdict(blockReason('1.3.1 experimental', 'replace-asset')) },
    { name: '实验版 + verify 放行（只读核验是 §3.7 要求必跑的）',
      want: 'open', got: verdict(blockReason('1.3.1 experimental', 'verify')) },
    { name: '实验版 + notes 放行（只改说明那一页，不动下载）',
      want: 'open', got: verdict(blockReason('1.3.1 experimental', 'notes')) },
    { name: '实验版 + push 放行（提交代码不属于「提供下载」）',
      want: 'open', got: verdict(blockReason('1.3.1 experimental', 'push')) },
    { name: '发布线 + release 放行（闸不许把正式版一起挡死）',
      want: 'open', got: verdict(blockReason('1.3.0', 'release')) },
    { name: '发布线 + replace-asset 放行',
      want: 'open', got: verdict(blockReason('1.3.0', 'replace-asset')) },
    { name: 'version_name 读不出（没这个字段）时按发布线处理，不猜成实验版',
      want: 'open', got: verdict(blockReason(undefined, 'release')) },
    { name: '标记大小写不敏感：EXPERIMENTAL 照样挡',
      want: 'blocked', got: verdict(blockReason('1.3.1 EXPERIMENTAL', 'release')) },
    { name: '中文标记「实验版」也算实验通道',
      want: 'blocked', got: verdict(blockReason('1.3.1 实验版', 'replace-asset')) },
    { name: '没给命令名时不动（别把内部调用误判成发版）',
      want: 'open', got: verdict(blockReason('1.3.1 experimental', undefined)) },
    { name: '挡下的那句话点名这条命令',
      want: 'named', got: namedCheck(blockReason('1.3.1 experimental', 'replace-asset'), 'replace-asset') },
    { name: '挡下的那句话给出出口（提到转正与切回发布线）',
      want: 'has-exit', got: exitCheck(blockReason('1.3.1 experimental', 'release')) },
    { name: '放行时真的交回 null，不是一句空话',
      want: 'null', got: nullCheck(blockReason('1.3.0', 'release')) },
    { name: '当前工作树读回的 channel 与 version_name 自己一致',
      want: 'consistent', got: liveCheck() },
    // ---- 预览通道（用户口径 2026-11-20：实验版可以在 README 旁边开一个标明的下载口）----
    { name: '实验版 + preview 放行（预览口就是给这一支用的）',
      want: 'open', got: verdict(blockReason('1.3.1 experimental', 'preview')) },
    { name: '发布线 + preview 挡下（正式版不该多出一份同字节的「预览包」）',
      want: 'blocked', got: verdict(blockReason('1.3.0', 'preview')) },
    { name: '挡下 preview 的那句话也点名命令、也给出口',
      want: 'has-exit', got: namedExit(blockReason('1.3.0', 'preview'), 'preview') },
    { name: 'preview 没被并进稳定通道那张表（并进去，这一支就发不出预览了）',
      want: 'separate', got: tableCheck() },
    { name: '开了预览口之后，实验版跑 release / replace-asset 照样挡（新口不豁旧口）',
      want: 'both-blocked', got: stableStillBlocked() }
  ];
  var bad = 0;
  cases.forEach(function (c, i) {
    var ok = c.got === c.want;
    if (!ok) bad++;
    console.log((ok ? '  [ok]   ' : '  [FAIL] ') + (i + 1) + '. ' + c.name +
      (ok ? '' : '（want=' + c.want + ' got=' + c.got + '）'));
  });
  console.log('自检：' + (cases.length - bad) + ' / ' + cases.length + ' 格通过');
  return bad ? 1 : 0;
}

function verdict(reason) { return reason ? 'blocked' : 'open'; }

function namedCheck(reason, cmd) {
  return reason && reason.indexOf(cmd) >= 0 ? 'named' : 'missing-name';
}

function exitCheck(reason) {
  if (!reason) return 'not-blocked';
  return /转正/.test(reason) && /发布线/.test(reason) ? 'has-exit' : 'no-exit';
}

function nullCheck(reason) { return reason === null ? 'null' : 'not-null'; }

function namedExit(reason, cmd) {
  if (!reason) return 'not-blocked';
  if (reason.indexOf(cmd) < 0) return 'missing-name';
  return /转正|正路/.test(reason) && /支线|发布线/.test(reason) ? 'has-exit' : 'no-exit';
}

function tableCheck() {
  if (DOWNLOAD_CMDS.indexOf('preview') >= 0) return 'merged';
  return PREVIEW_CMDS.indexOf('preview') >= 0 ? 'separate' : 'missing';
}

function stableStillBlocked() {
  var both = blockReason('1.3.1 experimental', 'release') && blockReason('1.3.1 experimental', 'replace-asset');
  return both ? 'both-blocked' : 'leaked';
}

function liveCheck() {
  try {
    var names = readChannelNames();
    var ch = channelOf(names.version_name);
    var exp = ch === 'exp';
    // 自证：实验通道的工作树，release 一定挡得住（这是这一闸存在的理由）
    if (exp && !blockReason(names.version_name, 'release')) return 'exp-not-blocked';
    if (!exp && blockReason(names.version_name, 'release')) return 'stable-blocked';
    // 另一半：预览口只在这条线上打得开
    if (exp && blockReason(names.version_name, 'preview')) return 'exp-preview-blocked';
    if (!exp && !blockReason(names.version_name, 'preview')) return 'stable-preview-open';
    return 'consistent';
  } catch (e) {
    // manifest 读不出时**不许**报成一致：那是"闸自己失效"，与"没配 manifest"同形
    return 'unreadable:' + e.message;
  }
}

if (require.main === module) {
  var arg = process.argv[2];
  if (arg === '--selftest') {
    process.exitCode = selfTest();
  } else if (arg === 'check') {
    var why = blockReasonForRepo(process.argv[3]);
    if (why) { console.log(why); process.exitCode = 1; }
    else console.log('[ok] ' + process.argv[3] + ' 不被通道闸挡下（当前通道：' + channelOf(readChannelNames().version_name) + '）');
  } else {
    console.log('用法: node tools/channel-gate.js --selftest | check <cmd>');
    process.exitCode = 1;
  }
}

module.exports = {
  EXP_RE: EXP_RE,
  DOWNLOAD_CMDS: DOWNLOAD_CMDS,
  PREVIEW_CMDS: PREVIEW_CMDS,
  isExperimental: isExperimental,
  channelOf: channelOf,
  readChannelNames: readChannelNames,
  blockReason: blockReason,
  blockReasonForRepo: blockReasonForRepo,
  selfTest: selfTest
};
