#!/usr/bin/env node
/**
 * BOM 修复工具：`node tools/fix-bom.js`
 *
 * 背景：这个项目里 manifest.json 反复被外部编辑器写回 UTF-8 BOM。
 * Chrome/Edge 能正常加载带 BOM 的 manifest（已实测），但任何用 JSON.parse
 * 读它的 Node 工具链都会直接抛 "Unexpected token '﻿'"，
 * 而且报错信息里的那个字符看不出来，非常容易误判成文件损坏。
 *
 * 默认只报告不修改；加 --write 才真正落盘。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var WRITE = process.argv.indexOf('--write') !== -1;

var TARGETS = [
  'manifest.json',
  'background.js',
  'content.js',
  'page.js',
  'popup/popup.html',
  'popup/popup.js',
  'libs/prompt.js'
];

var BOM = 0xfeff;
var found = 0;

console.log('\nBOM 检查' + (WRITE ? '（--write：将直接修改文件）' : '（仅报告，加 --write 才会修改）') + '\n');

TARGETS.forEach(function (file) {
  var full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return;

  var text = fs.readFileSync(full, 'utf8');
  if (text.charCodeAt(0) !== BOM) {
    console.log('  [ok]   ' + file);
    return;
  }

  found++;
  if (WRITE) {
    fs.writeFileSync(full, text.slice(1), 'utf8');
    console.log('  [固定] ' + file + ' —— 已移除 BOM');
  } else {
    console.log('  [BOM]  ' + file + ' —— 建议执行 node tools/fix-bom.js --write');
  }
});

console.log('');
if (!found) {
  console.log('全部文件均无 BOM');
} else if (!WRITE) {
  console.log('发现 ' + found + ' 个带 BOM 的文件');
  process.exitCode = 1;
} else {
  console.log('已修复 ' + found + ' 个文件');
}
console.log('');
