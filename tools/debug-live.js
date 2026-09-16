/**
 * 启动一个"可调试的真实浏览器实例"：
 *   - 独立 profile（.debug-profile，持久保存，下次不用重新扫码登录）
 *   - 远程调试端口 9333（OMITONE_DEBUG_PORT 可覆盖）
 *   - 加载本仓库扩展（与 e2e 相同的加载方式）
 *   - 打开学习通登录页，等用户扫码
 *
 * 与 e2e 的关键区别：**不会自动关闭浏览器**。Ctrl+C 时才杀掉进程树。
 *
 * 用法：node tools/debug-live.js [起始URL]
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var { spawn } = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.OMITONE_DEBUG_PORT || 9333);
var PROFILE = path.join(ROOT, '.debug-profile');
var START_URL = process.argv[2] || 'https://passport2.chaoxing.com/login';

var DEFAULT_EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findEdge() {
  if (process.env.OMITONE_EDGE) return process.env.OMITONE_EDGE;
  for (var i = 0; i < DEFAULT_EDGE.length; i++) {
    if (fs.existsSync(DEFAULT_EDGE[i])) return DEFAULT_EDGE[i];
  }
  return null;
}

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitForCdp(timeoutMs) {
  var started = Date.now();
  for (;;) {
    try { return await getJson('http://127.0.0.1:' + PORT + '/json/version'); }
    catch (e) {
      if (Date.now() - started > timeoutMs) throw e;
      await sleep(300);
    }
  }
}

async function main() {
  var edge = findEdge();
  if (!edge) {
    console.error('未找到 Edge。用 OMITONE_EDGE 指定路径。');
    process.exit(1);
  }

  // 端口若已被占用，说明已有一个调试实例在跑 —— 直接复用，不再开新的
  try {
    var existing = await getJson('http://127.0.0.1:' + PORT + '/json/version');
    console.log('调试实例已在运行（' + (existing.Browser || '未知') + '），直接复用。');
    console.log('如需重启：先关闭那个 Edge 窗口，或删掉 ' + PROFILE + ' 再跑本脚本。');
    return;
  } catch (e) {}

  if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE, { recursive: true });

  console.log('启动 Edge 调试实例...');
  console.log('  profile: ' + PROFILE + '（持久保存，扫码登录一次即可）');
  console.log('  CDP 端口: ' + PORT);
  console.log('  扩展: ' + ROOT);

  var proc = spawn(edge, [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--disable-extensions-except=' + ROOT,
    '--load-extension=' + ROOT,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--window-size=1400,900',
    START_URL
  ], { stdio: 'ignore', detached: false });

  try {
    var ver = await waitForCdp(30000);
    console.log('\n✅ 调试实例就绪：' + (ver.Browser || 'Edge'));
  } catch (e) {
    console.error('CDP 端口 30 秒内未就绪，启动可能失败。');
    process.exit(1);
  }

  console.log('\n下一步：');
  console.log('  1. 在弹出的 Edge 窗口里用手机学习通 App 扫码登录');
  console.log('  2. 打开扫不到题的那个课程/作业页面');
  console.log('  3. 回到这里告诉我就行，我直接连上去看');
  console.log('\n保持本窗口运行；Ctrl+C 结束并关闭调试浏览器。');

  // 保活 + 监听退出
  var stopped = false;
  function shutdown() {
    if (stopped) return;
    stopped = true;
    console.log('\n关闭调试浏览器...');
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    } else {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }
    setTimeout(function () { process.exit(0); }, 1500);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  proc.on('exit', function () {
    if (!stopped) { console.log('\n调试浏览器已被手动关闭，本脚本退出。'); process.exit(0); }
  });

  setInterval(function () {}, 60000); // 保活
}

main().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
