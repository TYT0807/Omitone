#!/usr/bin/env node
/**
 * 字形哈希表的打包 / 校验 / 还原。
 *
 * 为什么需要它：`resources/table.json` 是 20902 条「32 位哈希 → 码点」映射，
 * 347 KB 的文本全是十六进制与十进制数字，占扩展体积的 36%。
 * 打包成 `resources/table.bin` 后是 122 KB，且加载时不需要解析 JSON。
 *
 * 用法：
 *   node tools/table-pack.js --pack      # table.json → table.bin
 *   node tools/table-pack.js --verify    # 校验两者一致（npm run check 会调它，不一致即失败）
 *   node tools/table-pack.js --unpack    # table.bin → table.json（还原成可读文本，用于维护）
 *   node tools/table-pack.js --stats     # 只打印统计
 *
 * ⚠️ `table.json` 是**唯一真源**，`table.bin` 是生成物。
 * 更新映射表请改 JSON 再 `--pack`，不要直接改 bin。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var FONT_TABLE = require('../libs/font-table.js');

var ROOT = path.join(__dirname, '..');
var JSON_PATH = path.join(ROOT, 'resources', 'table.json');
var BIN_PATH = path.join(ROOT, 'resources', 'table.bin');

/** 明文表里的元信息键，不是哈希，打包时跳过 */
var META_KEYS = ['author', 'namespace', 'license', 'version'];

function readJson() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

/** 从明文表里拆出 { 哈希 → 码点 } 与元信息 */
function splitTable(table) {
  var pairs = {};
  var meta = {};
  Object.keys(table).forEach(function (key) {
    if (META_KEYS.indexOf(key) !== -1) { meta[key] = table[key]; return; }
    if (FONT_TABLE.hashCodePoint(key) < 0) {
      console.warn('[table-pack] 跳过非哈希键: ' + JSON.stringify(key));
      return;
    }
    pairs[key] = table[key];
  });
  return { pairs: pairs, meta: meta };
}

function loadBin() {
  if (!fs.existsSync(BIN_PATH)) return null;
  var buf = fs.readFileSync(BIN_PATH);
  return FONT_TABLE.decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function pack() {
  var raw = readJson();
  var split = splitTable(raw);
  var buffer = FONT_TABLE.encode(split.pairs);
  fs.writeFileSync(BIN_PATH, Buffer.from(buffer));
  var lookup = FONT_TABLE.decode(buffer);
  console.log('table.json → table.bin');
  console.log('  条目  ' + lookup.size + '（JSON 里 ' + Object.keys(split.pairs).length + ' 条）');
  console.log('  体积  ' + Math.round(fs.statSync(JSON_PATH).size / 1024) + ' KB → ' +
    Math.round(buffer.byteLength / 1024) + ' KB');
  console.log('  体积再省 ' + (100 - buffer.byteLength / fs.statSync(JSON_PATH).size * 100).toFixed(0) + '%');
  return 0;
}

/**
 * 校验 bin 与 json 完全一致。
 * 逐条比对而不是比大小 —— 大小对得上但内容错位是最难查的一类故障。
 */
function verify(verbose) {
  var lookup = loadBin();
  if (!lookup) {
    console.error('[table-pack] resources/table.bin 缺失或格式非法 —— 跑 `node tools/table-pack.js --pack` 重新生成');
    return 1;
  }
  var split = splitTable(readJson());
  var expected = Object.keys(split.pairs);
  var problems = [];

  if (lookup.size !== expected.length) {
    problems.push('条目数不一致：bin ' + lookup.size + ' / json ' + expected.length);
  }
  var mismatched = 0;
  var sample = [];
  expected.forEach(function (hash) {
    var want = String.fromCharCode(Number(split.pairs[hash]));
    var got = lookup.get(hash);
    if (got !== want) {
      mismatched++;
      if (sample.length < 5) sample.push(hash + ': bin=' + JSON.stringify(got) + ' json=' + JSON.stringify(want));
    }
  });
  if (mismatched) problems.push('内容不一致 ' + mismatched + ' 条，样本 ' + sample.join(' | '));

  if (problems.length) {
    problems.forEach(function (p) { console.error('[table-pack] ' + p); });
    console.error('[table-pack] bin 与 json 不同步 —— 跑 `node tools/table-pack.js --pack`');
    return 1;
  }
  if (verbose) {
    console.log('table.bin 与 table.json 一致（' + lookup.size + ' 条，' +
      Math.round(fs.statSync(BIN_PATH).size / 1024) + ' KB）');
  }
  return 0;
}

function unpack() {
  var lookup = loadBin();
  if (!lookup) {
    console.error('[table-pack] 读不出 table.bin');
    return 1;
  }
  // 反查：遍历哈希需要原始数据，这里直接读 bin 重建
  var buf = fs.readFileSync(BIN_PATH);
  var view = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  var count = view.getUint32(4, true);
  var table = {};
  for (var i = 0; i < count; i++) {
    var hash = view.getUint32(8 + i * 4, true).toString(16).padStart(8, '0');
    table[hash] = view.getUint16(8 + count * 4 + i * 2, true);
  }
  var original = readJson();
  META_KEYS.forEach(function (key) {
    if (original[key] !== undefined) table[key] = original[key];
  });
  fs.writeFileSync(JSON_PATH, JSON.stringify(table), 'utf8');
  console.log('table.bin → table.json（' + count + ' 条，已保留元信息）');
  return 0;
}

function stats() {
  var raw = readJson();
  var split = splitTable(raw);
  var count = Object.keys(split.pairs).length;
  var jsonSize = fs.statSync(JSON_PATH).size;
  var binSize = fs.existsSync(BIN_PATH) ? fs.statSync(BIN_PATH).size : 0;
  console.log('明文档位:    ' + count);
  console.log('元信息:      ' + JSON.stringify(split.meta));
  console.log('table.json:  ' + Math.round(jsonSize / 1024) + ' KB');
  console.log('table.bin:   ' + (binSize ? Math.round(binSize / 1024) + ' KB' : '（尚未生成）'));
  console.log('理论体积:    ' + Math.round((8 + count * 6) / 1024) + ' KB（8 字节头 + 每条 6 字节）');
  return 0;
}

var arg = process.argv[2] || '--stats';
if (arg === '--pack') process.exit(pack());
else if (arg === '--verify') process.exit(verify(true));
else if (arg === '--unpack') process.exit(unpack());
else if (arg === '--stats') process.exit(stats());
else {
  console.error('未知参数: ' + arg + '（可用 --pack / --verify / --unpack / --stats）');
  process.exit(2);
}
