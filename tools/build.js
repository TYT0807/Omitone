#!/usr/bin/env node
/**
 * 打包扩展：`npm run build`
 *
 * 产物：
 *   dist/omitone-<version>/        —— 可直接"加载已解压的扩展程序"的目录
 *   dist/omitone-<version>.zip     —— 可上传到 Edge/Chrome 开发者后台的压缩包
 *
 * 只用 Node 内置模块（zlib + 自实现 crc32），不引入任何依赖，
 * 避免为了打一个包而给这个零依赖项目加 node_modules。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var execFileSync = require('child_process').execFileSync;

var ROOT = path.join(__dirname, '..');
var DIST = path.join(ROOT, 'dist');

/** 打进扩展包的路径（白名单，而不是黑名单 —— 新增开发文件时不会被误打包）。 */
var INCLUDE = [
  'manifest.json',
  'background.js',
  'content.js',
  'page.js',
  'libs',
  'icons',
  'popup',
  'resources',
  'LICENSE'
];

/**
 * 不打进扩展包的文件。
 *
 * `resources/table.json` 是字形映射表的**可读源文件**（347KB）；
 * 运行时读的是由它生成的 `resources/table.bin`（122KB）。
 * 两个都塞进去等于白白多背 347KB —— 源文件留在仓库里就够维护用了。
 */
var EXCLUDE = ['resources/table.json'];

// ---------------------------------------------------------------------------
// crc32（ZIP 每个条目都要带）
// ---------------------------------------------------------------------------
var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  var c = 0 ^ -1;
  for (var i = 0; i < buffer.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// 最小 ZIP writer
// ---------------------------------------------------------------------------
function dosDateTime(date) {
  var time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  var day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time: time, date: day };
}

function createZip(entries) {
  var chunks = [];
  var central = [];
  var offset = 0;
  var stamp = dosDateTime(new Date());

  entries.forEach(function (entry) {
    var nameBytes = Buffer.from(entry.name, 'utf8');
    var isDir = entry.name.slice(-1) === '/';
    var raw = isDir ? Buffer.alloc(0) : entry.data;
    var compressed = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
    var crc = isDir ? 0 : crc32(raw);

    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flag: 文件名按 UTF-8 解释
    local.writeUInt16LE(isDir ? 0 : 8, 8);   // 0=store 8=deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);              // extra length

    chunks.push(local, nameBytes, compressed);

    var cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                 // version made by
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(isDir ? 0 : 8, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);                 // extra
    cd.writeUInt16LE(0, 32);                 // comment
    cd.writeUInt16LE(0, 34);                 // disk start
    cd.writeUInt16LE(0, 36);                 // internal attrs
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38);  // external attrs
    cd.writeUInt32LE(offset, 42);

    central.push(cd, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  });

  var centralBuffer = Buffer.concat(central);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), centralBuffer, end]);
}

// ---------------------------------------------------------------------------
// 收集文件
// ---------------------------------------------------------------------------
function collect(target, prefix) {
  var full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return [];

  var stat = fs.statSync(full);
  if (stat.isFile()) {
    return [{ name: prefix, abs: full }];
  }

  var files = [];
  fs.readdirSync(full, { withFileTypes: true }).forEach(function (entry) {
    var nextRel = prefix + '/' + entry.name;
    if (entry.isDirectory()) files = files.concat(collect(path.join(target, entry.name), nextRel));
    else files.push({ name: nextRel, abs: path.join(full, entry.name) });
  });
  return files;
}

function copyRecursive(from, to) {
  var stat = fs.statSync(from);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }
  var count = 0;
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function (entry) {
    count += copyRecursive(path.join(from, entry.name), path.join(to, entry.name));
  });
  return count;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  var version = manifest.version;
  var stageName = 'omitone-' + version;
  var stageDir = path.join(DIST, stageName);
  var zipPath = path.join(DIST, stageName + '.zip');

  if (!/^[\d.]+$/.test(version)) {
    console.error('版本号含非法字符: ' + version);
    process.exitCode = 1;
    return;
  }

  // 0) 先把字形映射表按源文件重新生成一遍。
  //    不这样做的话，改了 table.json 却忘了 pack，就会打出一份过期的 bin ——
  //    这种错不会报错，只会让部分题干继续显示乱码，非常难查。
  try {
    var packOut = execFileSync(process.execPath, [path.join(__dirname, 'table-pack.js'), '--pack'],
      { encoding: 'utf8' });
    packOut.trim().split('\n').forEach(function (line) { if (line.trim()) console.log('  ' + line.trim()); });
  } catch (e) {
    console.error('生成 resources/table.bin 失败：' + (e.stdout || e.message));
    process.exitCode = 1;
    return;
  }

  // 清空上一次的产物
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 1) 收集
  var entries = [];
  INCLUDE.forEach(function (target) {
    collect(target, target).forEach(function (file) { entries.push(file); });
  });
  entries = entries.filter(function (file) { return EXCLUDE.indexOf(file.name) === -1; });

  if (!entries.length) {
    console.error('没有收集到任何文件，检查 INCLUDE 列表');
    process.exitCode = 1;
    return;
  }

  // 2) 展开到 dist/<name>/ 供"加载已解压的扩展程序"使用
  var copied = 0;
  INCLUDE.forEach(function (target) {
    var from = path.join(ROOT, target);
    if (!fs.existsSync(from)) return;
    copied += copyRecursive(from, path.join(stageDir, target));
  });

  // 展开目录也要剔掉 EXCLUDE（zip 那一边在收集时已经滤掉了，两边必须一致）
  EXCLUDE.forEach(function (rel) {
    fs.rmSync(path.join(stageDir, rel), { force: true });
  });

  // 3) 打包 zip
  var zipEntries = [];
  var seenDirs = Object.create(null);
  entries.forEach(function (file) {
    var parts = file.name.split('/');
    for (var i = 1; i < parts.length; i++) {
      var dir = parts.slice(0, i).join('/') + '/';
      if (!seenDirs[dir]) {
        seenDirs[dir] = true;
        zipEntries.push({ name: dir, data: null });
      }
    }
    zipEntries.push({ name: file.name, data: fs.readFileSync(file.abs) });
  });

  var zipBuffer = createZip(zipEntries);
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(zipPath, zipBuffer);

  var rawSize = entries.reduce(function (sum, f) { return sum + fs.statSync(f.abs).size; }, 0);

  console.log('\nOmitone 打包完成\n');
  console.log('  版本       ' + version);
  console.log('  文件数     ' + entries.length + '（解压目录共 ' + copied + ' 个）');
  console.log('  原始大小   ' + (rawSize / 1024).toFixed(1) + ' KB');
  console.log('  zip 大小   ' + (zipBuffer.length / 1024).toFixed(1) + ' KB'
    + (rawSize ? '（压缩率 ' + (100 - (zipBuffer.length / rawSize) * 100).toFixed(0) + '%）' : ''));
  console.log('');
  console.log('  解压目录   ' + path.relative(ROOT, stageDir).replace(/\\/g, '/'));
  console.log('  zip 包     ' + path.relative(ROOT, zipPath).replace(/\\/g, '/'));
  console.log('');
  console.log('已排除: tools/ legacy/ .workbuddy/ dist/ node_modules/ 以及全部 .md 与工程配置文件');
  console.log('');
}

main();
