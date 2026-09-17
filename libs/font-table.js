/**
 * 字形哈希表（font-cxsecret 反爬映射）的紧凑二进制格式 —— 唯一真源。
 *
 * 背景：`resources/table.json` 是 20902 条「32 位哈希 → Unicode 码点」映射，
 * 但键是 8 位十六进制字符串、值是十进制码点，**347 KB 全是数字字符**，
 * 占整个扩展体积的 36% —— 这就是"软件怎么这么大"的答案。
 *
 * 编码后每条只占 4 + 2 = 6 字节，整表 122 KB；加载后还能零解析地做二分查找。
 * 顺带解决一个隐性开销：原先 `resp.json()` 会造出两万多个字符串键的字典对象
 * （V8 下约 1.5~2 MB），现在只需要一块 122 KB 的 ArrayBuffer。
 *
 * 格式（全部小端）：
 *
 *   偏移 0   magic  "OMT1"            4 字节
 *   偏移 4   count  uint32            条目数
 *   偏移 8   hashes uint32 × count    哈希，**升序**（二分查找的前提）
 *   偏移 8+4N codes uint16 × count    码点（全部落在 BMP 内）
 *
 * 同时兼容 content script 隔离世界（挂 self.OmitoneFontTable）与 Node（module.exports），
 * 于是 `tools/table-pack.js` 与运行时用的是同一份编码/解码实现。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OmitoneFontTable = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAGIC = [0x4f, 0x4d, 0x54, 0x31]; // "OMT1"
  var HEADER = 8;
  var MAX_CODE = 0xffff;               // 码点必须是 BMP 内，否则 uint16 存不下

  /** 把 8 位十六进制哈希串转成 uint32；不合法返回 -1 */
  function hashCodePoint(hash) {
    var s = String(hash || '');
    if (!/^[0-9a-fA-F]{1,8}$/.test(s)) return -1;
    return parseInt(s, 16) >>> 0;
  }

  /**
   * 编码：接受 `{ 哈希串: 码点 }` 对象或 `[[哈希串, 码点], ...]` 数组，
   * 返回 ArrayBuffer。非法条目会被跳过（元信息键 author/license/... 由调用方先行剔除）。
   */
  function encode(entries) {
    var pairs = [];
    if (Array.isArray(entries)) {
      entries.forEach(function (pair) {
        var h = hashCodePoint(pair[0]);
        var c = Number(pair[1]);
        if (h < 0 || !isFinite(c) || c <= 0 || c > MAX_CODE) return;
        pairs.push([h, c]);
      });
    } else if (entries && typeof entries === 'object') {
      Object.keys(entries).forEach(function (key) {
        var h = hashCodePoint(key);
        var c = Number(entries[key]);
        if (h < 0 || !isFinite(c) || c <= 0 || c > MAX_CODE) return;
        pairs.push([h, c]);
      });
    }
    // 按哈希升序，且去掉重复哈希（后写的覆盖不了先写的，直接去重更省空间）
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    var unique = [];
    for (var i = 0; i < pairs.length; i++) {
      if (i > 0 && pairs[i][0] === pairs[i - 1][0]) { unique[unique.length - 1] = pairs[i]; continue; }
      unique.push(pairs[i]);
    }

    var buffer = new ArrayBuffer(HEADER + unique.length * 6);
    var view = new DataView(buffer);
    view.setUint8(0, MAGIC[0]);
    view.setUint8(1, MAGIC[1]);
    view.setUint8(2, MAGIC[2]);
    view.setUint8(3, MAGIC[3]);
    view.setUint32(4, unique.length, true);
    unique.forEach(function (pair, index) {
      view.setUint32(HEADER + index * 4, pair[0], true);
      view.setUint16(HEADER + unique.length * 4 + index * 2, pair[1], true);
    });
    return buffer;
  }

  /**
   * 解码成查找器。返回 null 表示这不是一张合法的表（调用方据此回退到 JSON）。
   *
   * 刻意用 DataView 逐条读而不是直接 `new Uint32Array(buffer, 8, n)` 零拷贝：
   * 后者依赖平台字节序，也没有任何自检机会。这里多花不到 1ms，
   * 换来"格式不对就明确返回 null"和大小端无关。
   */
  function decode(buffer) {
    try {
      if (!buffer || buffer.byteLength < HEADER) return null;
      var view = new DataView(buffer);
      for (var m = 0; m < 4; m++) if (view.getUint8(m) !== MAGIC[m]) return null;

      var count = view.getUint32(4, true);
      if (count <= 0) return null;
      if (buffer.byteLength < HEADER + count * 6) return null;

      var hashes = new Uint32Array(count);
      var codes = new Uint16Array(count);
      var prev = -1;
      for (var i = 0; i < count; i++) {
        var hash = view.getUint32(HEADER + i * 4, true);
        if (hash <= prev) return null; // 必须严格升序，否则说明文件坏了（或字节序不对）
        prev = hash;
        hashes[i] = hash;
        codes[i] = view.getUint16(HEADER + count * 4 + i * 2, true);
      }
      return makeLookup(hashes, codes);
    } catch (e) {
      return null;
    }
  }

  function makeLookup(hashes, codes) {
    return {
      size: hashes.length,
      /** 传 8 位十六进制哈希串，命中返回字符（可能为空串），未命中返回 '' */
      get: function (hexHash) {
        var target = hashCodePoint(hexHash);
        if (target < 0) return '';
        var lo = 0;
        var hi = hashes.length - 1;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          var value = hashes[mid];
          if (value === target) return String.fromCharCode(codes[mid]);
          if (value < target) lo = mid + 1;
          else hi = mid - 1;
        }
        return '';
      }
    };
  }

  /**
   * 把明文 JSON 表包成同一套 `{ size, get(hex) }` 接口。
   * 用途：源码目录（未执行 `npm run build`）下没有 table.bin 时仍能工作 ——
   * 行为一致，只是慢一点、占内存多一点。
   */
  function fromObject(table) {
    if (!table || typeof table !== 'object') return null;
    var keys = Object.keys(table);
    var count = 0;
    for (var i = 0; i < keys.length; i++) if (hashCodePoint(keys[i]) >= 0) count++;
    return {
      size: count,
      get: function (hexHash) {
        var hit = table[String(hexHash || '')];
        return hit ? String.fromCharCode(Number(hit)) : '';
      }
    };
  }

  return {
    MAGIC: 'OMT1',
    /** 供打包脚本报告用 */
    BYTES_PER_ENTRY: 6,
    hashCodePoint: hashCodePoint,
    encode: encode,
    decode: decode,
    fromObject: fromObject
  };
});
