/**
 * 状态字段审计（按需跑）：列出 `page.js` 里用到的私有字段，标出哪些**不在声明表里**。
 *
 * 为什么需要它：`src/page/README.md` 里有一句"找状态字段就来 10-config-state.js"。
 * 实测那句话**不完全成立** —— 声明表里有 119 个属性，另有约 30 个字段是"用到才建"的。
 * 这本身是刻意的写法（惰性初始化不会被"某处忘了复位"弄坏，比依赖声明初值更抗错），
 * 但**代价是找字段时不能只看一个文件**。这个脚本把全量列出来，省得下一个人重新数一遍。
 *
 * 用法：node tools/audit-fields.js
 *
 * ⚠️ 三种"未声明"要分清：
 *   1. **方法引用**（`addEventListener('ended', this._onVideoEnded)`）—— 不是字段，已排除
 *   2. **惰性初始化**（`if (!this._seekTriedKeys) this._seekTriedKeys = Object.create(null)`）
 *      —— 正常，且比声明初值更抗错
 *   3. **完全没有初值**（只在某处被赋值）—— 这一类才值得多看一眼
 *
 * ⚠️ **已知误报（别当成 bug）**：脚本看不出 `this` 到底指谁。
 *    例如 `XHR.prototype.open = function () { this.__omitoneUrl = … }` 里的 `this`
 *    是 **XHR 实例**，不是 app —— 所以 `__omitoneUrl` / `__omitoneMethod` 会被列出来。
 *    2026-09-21 那次全量核对里，最后剩下的 3 个"没看到兜底"全是这一类误报。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'page');
const STATE_FILE = '10-config-state.js';

const declared = Object.create(null);      // 声明表里的字段
const methods = Object.create(null);       // 方法名（要排除，它们不是字段）
const used = Object.create(null);          // 实际用到的字段 + 出现位置

for (const f of fs.readdirSync(DIR).filter(function (x) { return /\.js$/.test(x); }).sort()) {
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);

  lines.forEach(function (l) {
    // 方法定义：`    _foo: function (` / `    _foo: async function (`
    const fn = l.match(/^ {4}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/);
    if (fn) methods[fn[1]] = true;
    // 声明表（只认 10-config-state.js 里 4 空格缩进的 `名字:`）
    if (f === STATE_FILE) {
      const d = l.match(/^ {4}([A-Za-z_$][\w$]*)\s*:/);
      if (d) declared[d[1]] = true;
    }
  });

  lines.forEach(function (l, i) {
    const body = l.replace(/\/\/.*$/, '');        // 去掉行尾注释
    const re = /\b(?:this|self|app)\.(_[A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(body))) {
      // 后面紧跟左括号 = 方法调用，不是字段
      // ⚠️ 别用 `(?!\s*\()` 负向先行断言：正则回溯会把 `_withTimeout(` 截成 `_withTimeou`
      //    再判"后面不是左括号"，于是报出一堆截断的假名字（实测报过 360 个）。
      if (/^\s*\(/.test(body.slice(m.index + m[0].length))) continue;
      if (!used[m[1]]) used[m[1]] = [];
      if (used[m[1]].length < 4) used[m[1]].push(f + ':' + (i + 1));
    }
  });
}

const names = Object.keys(used).filter(function (n) { return !methods[n]; }).sort();
const missing = names.filter(function (n) { return !declared[n]; });
const lazy = missing.filter(function (n) {
  // 有显式惰性初始化，或读取处自带兜底。三种写法都要认：
  //   if (!this._x) this._x = …        （建的时候才建）
  //   if (this._x) el.removeEventListener(…)（用之前先确认存在）
  //   (this._x || 0) / this._x !== y   （读取处兜底）
  const re = new RegExp(
    '!this\\.' + n + '\\b' + '|' +
    'if\\s*\\(\\s*this\\.' + n + '\\b' + '|' +
    'this\\.' + n + '\\s*\\|\\|' + '|' +
    'this\\.' + n + '\\s*[!=]==' 
  );
  for (const f of fs.readdirSync(DIR).filter(function (x) { return /\.js$/.test(x); })) {
    if (re.test(fs.readFileSync(path.join(DIR, f), 'utf8'))) return true;
  }
  return false;
});

console.log('=== 私有字段全量：用到 ' + names.length + ' 个，' + STATE_FILE + ' 声明了 ' +
  Object.keys(declared).length + ' 个 ===');
console.log('');
console.log('--- 不在声明表里，但**自带惰性初始化/读取兜底**（正常，' + lazy.length + ' 个）---');
lazy.forEach(function (n) { console.log('  ' + n); });
console.log('');
const noGuard = missing.filter(function (n) { return lazy.indexOf(n) === -1; });
console.log('--- 不在声明表里、也**没看到兜底**（' + noGuard.length + ' 个，值得看一眼）---');
if (!noGuard.length) console.log('  （无）');
else noGuard.forEach(function (n) { console.log('  ' + n.padEnd(30) + used[n].join(', ')); });
console.log('');
console.log('注：本脚本只做"列出来"这件事，不判失败 —— 惰性初始化是本项目刻意的写法，');
console.log('    只要每个读取点都有兜底就没问题。');
