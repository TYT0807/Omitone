/**
 * 起一台「装了本仓库扩展 + 登着真实学习通」的 Edge，用来做现场排查与挂刷课。
 *
 * 与 `npm run e2e` 的区别只有一个，但是决定性的：e2e 把 mooc1.chaoxing.com
 * 映射到本机 mock；这里**不做任何域名映射**，跑的是真页面、真账号、真 DOM。
 * profile 固定放在 `.workbuddy/real-edge-profile`（沿用现场排查一直用的那一份，
 * 里面存着学习通登录态 —— 换目录等于要用户重新扫码），登录一次之后可以反复复现。
 *
 *   npm run field-browser                      # 开在用户中心（换课由扩展自己挑下一门）
 *   npm run field-browser -- https://...        # 开在指定页
 *
 * 已经在跑（CDP 端口 9334 应答）就复用那一台，不重复起 —— 重复起会开新窗口抢同一个
 * profile，而**同一账号一次只许有一枚学习页**（AGENTS §2 #15：开第二枚会被站点把前一枚顶下线）。
 *
 * ⚠️ 本脚本只负责启动与探活，**不会自动关闭**那个窗口。收尾请自己关，
 * 或者用技能 `omitone-chaoxing-field-triage` 的 `scripts/tab-nav.js --close=` 关掉指定标签。
 */
'use strict';

var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PROFILE = path.join(ROOT, '.workbuddy', 'real-edge-profile');
var PORT = Number(process.env.OMITONE_FIELD_PORT || 9334);
var EDGE = process.env.OMITONE_EDGE ||
  (fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
var START_URL = process.argv[2] || 'https://i.mooc.chaoxing.com/space/index';

function getJson(p) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, function (res) {
      var s = '';
      res.on('data', function (d) { s += d; });
      res.on('end', function () { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(EDGE)) { console.log('找不到 Edge: ' + EDGE); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });

  var alive = null;
  try { alive = await getJson('/json/version'); } catch (e) { alive = null; }
  if (alive) {
    console.log('复用已在跑的现场窗口（端口 ' + PORT + '）');
  } else {
    // detached + unref：这台窗口要活过启动它的那条命令（挂刷课要跑几小时），
    // 不能因为 shell 退出被一起带走。
    cp.spawn(EDGE, [
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + PORT,
      // 必须成对：新版 Chromium 单独给 --load-extension 常被忽略
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      START_URL
    ], { stdio: 'ignore', detached: true }).unref();
    for (var i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 700); });
      try { alive = await getJson('/json/version'); break; } catch (e) { alive = null; }
    }
  }
  if (!alive) { console.log('CDP 没起来（端口 ' + PORT + '）'); process.exit(1); }

  var targets = await getJson('/json/list');
  var pages = targets.filter(function (t) { return t.type === 'page'; }).map(function (t) { return t.url; });
  var study = pages.filter(function (u) { return /\/mycourse\/studentstudy/.test(u); });
  var ext = targets.filter(function (t) { return t.url && t.url.indexOf('chrome-extension://') === 0; });
  console.log('CDP 就绪: http://127.0.0.1:' + PORT);
  console.log('  页面目标: ' + (pages.map(function (u) { return u.slice(0, 66); }).join(' | ') || '（无）'));
  console.log('  扩展目标: ' + (ext.length ? ext.map(function (t) { return t.url.split('/')[2]; }).join(' | ') : '（没出现 —— 扩展没加载）'));
  console.log('  学习页枚数: ' + study.length + (study.length > 1 ? '  ⚠️ 大于 1 就是错的（会被站点顶下线）' : ''));
  console.log('  量现场：技能 omitone-chaoxing-field-triage 的 scripts/sw-eval.js --targets（只读）');
}

main();
