#!/usr/bin/env node
/**
 * 发布前审查：检查即将 push 到公开仓库的内容里有没有夹带私有信息。
 *
 * 为什么需要它：把私有信息推到 GitHub 上，**删了提交历史也不算彻底删除**
 * （GH Archive、fork、搜索引擎缓存都可能留着）。所以宁可在 push 之前扫一遍。
 *
 * 检查项：
 *   1. 疑似密钥 —— sk-xxx、写死的 apiKey/password 赋值
 *   2. 本机绝对路径 —— C:/Users/<用户名> 这类会把用户名带出去
 *   3. 邮箱、手机号、QQ 号
 *   4. 大文件（> 1MB，通常是误提交的资源）
 *
 * 用法：
 *   node tools/publish-audit.js          # 扫 git 已跟踪的文件
 *   node tools/publish-audit.js --all    # 连未跟踪文件一起扫
 *
 * 退出码非 0 表示有问题需要人工确认。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var ROOT = path.join(__dirname, '..');
var ONLY_TRACKED = process.argv.indexOf('--all') === -1;

// 这些是第三方库/资源，误报率太高且内容公开，跳过
var SKIP_FILE = [
  /^libs\/md5\.min\.js$/,
  /^libs\/Typr/i,
  /\.png$/i,
  // 字形映射表：json 是两万条十六进制/十进制数字，bin 是紧凑二进制。
  // 拿正则去扫它们必然产出假邮箱之类的噪音 —— 而"审查结果里总有三条固定的噪音"
  // 会训练人忽略这个工具，真正的命中就淹没了。宁可在这里明确跳过。
  /^resources\/table\.(json|bin)$/,
  // 本工具自身：文件里**必然**写着它要找的那些模式（本机路径、密钥样例），
  // 不跳过就每次固定报两条。
  /^tools\/publish-audit\.js$/
];

/**
 * 明显的测试夹具 / 占位符 —— 不该让它们把审查结果搅成噪音。
 * （真的有密钥混在测试里时，它通常不会长得像 sk-abc 这种样子）
 */
var FAKE_TOKEN = /\bsk-(?:abc|test|xxx|fake|dummy|example|1234|0000)\b|test-key|e2e-key|YOUR_?KEY|your[_-]?api[_-]?key|changeme/i;

var CHECKS = [
  {
    // \b 很关键：真实密钥是独立 token；没有它的话 `.task-condition`
    // 这种 CSS 类名会被当成 sk- 密钥（`task-` 的尾部 + `condition`）
    name: '疑似密钥',
    re: /\bsk-[A-Za-z0-9_\-]{20,}\b|Bearer\s+sk-|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']|password\s*[:=]\s*["'][^"'$\s]{4,}["']/i
  },
  {
    name: '本机绝对路径',
    re: /[a-zA-Z]:[\\/]+Users[\\/]+|HOME[\\/]+|\/home\/[a-z]+\//i
  },
  {
    name: '邮箱',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  },
  {
    name: '手机号/QQ',
    re: /(^|[^0-9])(1[3-9][0-9]{9})([^0-9]|$)/
  }
];

function listFiles() {
  var out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (ONLY_TRACKED) return out;

  var all = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(function (entry) {
      if (['node_modules', '.git', 'dist', '.debug-profile', '.workbuddy'].indexOf(entry.name) !== -1) return;
      var rel = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) return walk(rel);
      all.push(rel);
    });
  })('');
  return out.concat(all.filter(function (f) { return out.indexOf(f) === -1; }));
}

function main() {
  var files = listFiles();
  var hits = [];
  var bigFiles = [];

  files.forEach(function (file) {
    if (SKIP_FILE.some(function (re) { return re.test(file); })) return;

    var abs = path.join(ROOT, file);
    var stat = null;
    try { stat = fs.statSync(abs); } catch (e) { return; }
    if (stat.size > 1024 * 1024) bigFiles.push(file + '  (' + (stat.size / 1024 / 1024).toFixed(1) + ' MB)');

    var text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }

    text.split('\n').forEach(function (line, idx) {
      if (FAKE_TOKEN.test(line)) return;

      CHECKS.forEach(function (check) {
        var m = line.match(check.re);
        if (!m) return;
        hits.push(check.name + ' | ' + file + ':' + (idx + 1) + ' | ' + String(m[0]).trim().slice(0, 60));
      });
    });
  });

  console.log('\n发布前审查（扫描 ' + files.length + ' 个文件）\n');

  if (hits.length) {
    console.log('需要人工确认的命中项：');
    hits.forEach(function (h) { console.log('  ' + h); });
    console.log('');
  } else {
    console.log('  [ok] 未发现密钥 / 本机路径 / 邮箱 / 手机号');
  }

  if (bigFiles.length) {
    console.log('  [warn] 超过 1MB 的文件（确认是否需要提交）：');
    bigFiles.forEach(function (f) { console.log('    ' + f); });
  } else {
    console.log('  [ok] 无大于 1MB 的文件');
  }

  console.log('');
  if (hits.length) {
    console.log('以上命中项请逐条确认：有意公开的可放行，其余请删除或加入 .gitignore。');
    process.exitCode = 1;
  } else {
    console.log('审查通过 —— 可以发布。');
  }
}

main();
