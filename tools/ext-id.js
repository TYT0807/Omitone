/**
 * 反推 Chrome/Edge 对"未打包扩展"生成确定性 ID 的确切输入编码。
 *
 * 已知：算法是 SHA256(扩展目录路径) 的前 32 个十六进制位，逐位映射 0-f → a-p。
 * 不确定：Windows 上路径以什么编码参与哈希（UTF-8 / UTF-16LE / 是否带 BOM / 大小写 / 尾分隔符）。
 *
 * 用法：node tools/ext-id.js <目录绝对路径> [已知ID]
 * 例：  node tools/ext-id.js D:\Omite hdlemlcmfldkknipeccjhamkgomfgmhf
 * 不传已知 ID 时只打印各编码的结果，方便拿去和 edge://extensions 里看到的对照。
 */
'use strict';

var crypto = require('crypto');
var path = require('path');

function toId(hex32) {
  return hex32.split('').map(function (c) {
    return String.fromCharCode(97 + parseInt(c, 16));
  }).join('');
}

function idFromBuffer(buf) {
  return toId(crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32));
}

function variants(target) {
  var BS = String.fromCharCode(92);
  var base = path.resolve(target);
  var noTrailing = base.replace(/[\\/]+$/, '');
  var list = [];
  [noTrailing, noTrailing + BS].forEach(function (p) {
    list.push({ label: 'utf8      ' + JSON.stringify(p), buf: Buffer.from(p, 'utf8') });
    list.push({ label: 'utf16le   ' + JSON.stringify(p), buf: Buffer.from(p, 'utf16le') });
    list.push({ label: 'latin1    ' + JSON.stringify(p), buf: Buffer.from(p, 'latin1') });
    list.push({ label: 'utf16le+BOM ' + JSON.stringify(p), buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(p, 'utf16le')]) });
    var lower = p.toLowerCase();
    list.push({ label: 'utf16le(lower) ' + JSON.stringify(lower), buf: Buffer.from(lower, 'utf16le') });
    list.push({ label: 'utf8(lower)    ' + JSON.stringify(lower), buf: Buffer.from(lower, 'utf8') });
  });
  return list;
}

var target = process.argv[2] || process.cwd();
var known = (process.argv[3] || '').toLowerCase();

console.log('\n目标目录: ' + path.resolve(target));
console.log('已知 ID : ' + (known || '(未提供，仅列出候选)\n'));

var hit = null;
variants(target).forEach(function (v) {
  var id = idFromBuffer(v.buf);
  var mark = known && id === known ? '   <<< 命中' : '';
  console.log('  ' + id + '   ' + v.label + mark);
  if (known && id === known && !hit) hit = v.label;
});

console.log('');
if (known) {
  console.log(hit ? ('命中编码: ' + hit) : '未命中 —— 需要换别的编码假设再试');
} else {
  console.log('把 edge://extensions 里看到的 ID 作为第二个参数传进来即可确认编码。');
}
console.log('');
