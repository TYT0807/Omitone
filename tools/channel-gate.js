#!/usr/bin/env node
/**
 * 通道闸：实验版支线不许动「同学点下载拿到的那一份字节」。
 *
 * 背景（用户口径，2026-11-19）：1.3.1 从稳定版切出来作实验支线，
 * **「实验版不提供直接下载」**，要等现场把课刷完、进度复账没被收回，才考虑转正。
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
 */
function blockReason(versionName, cmd) {
  if (DOWNLOAD_CMDS.indexOf(cmd) < 0) return null;
  if (!isExperimental(versionName)) return null;
  var lines = [
    '✗ ' + cmd + ' 被通道闸挡下：这一份工作树是实验版（version_name「' + versionName + '」）。',
    '  本闸只管一件事：**实验版不公开发布、不提供直接下载**（AGENTS §3.8）。',
    '  被挡的是「改同学点下载拿到的那一份字节」那两条 ——',
    '    · release        会新建一版公开 Release，直链立刻指向它；',
    '    · replace-asset  会把 dist 里按当前版本号构建出的**实验版那份**覆盖到线上稳定版的同名附件上。',
    '  两种都**不报错、每条命令都打印成功**，只有几周后发现「下载的人装的是实验版」才看得见。',
    '→ 要发稳定版：切回发布线（那一份 manifest 的 version_name 不带 experimental），再跑同一条命令。',
    '→ 要转正这一支：先满足转正条件（现场串行把课刷完 + 同口径复账确认进度没被事后收回），',
    '   再去掉 version_name 里的 experimental、把 README 与说明书那三处实验口径改回正式，最后发版。',
    '  只读核验 verify、改说明 notes、提交 push 三条不受本闸影响，照旧能跑。'
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
      want: 'consistent', got: liveCheck() }
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

function liveCheck() {
  try {
    var names = readChannelNames();
    var ch = channelOf(names.version_name);
    var exp = ch === 'exp';
    // 自证：实验通道的工作树，release 一定挡得住（这是这一闸存在的理由）
    if (exp && !blockReason(names.version_name, 'release')) return 'exp-not-blocked';
    if (!exp && blockReason(names.version_name, 'release')) return 'stable-blocked';
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
  isExperimental: isExperimental,
  channelOf: channelOf,
  readChannelNames: readChannelNames,
  blockReason: blockReason,
  blockReasonForRepo: blockReasonForRepo,
  selfTest: selfTest
};
