/**
 * 一次性审计脚本（跑完即删）：找出"裸读跨域 document"的位置，并判断它是否在 try 块里。
 *
 * 为什么值得单独写一个脚本：`AGENTS.md` §2 第 1 条把"裸读跨域 .document"列为
 * **最难查的一类 bug** —— 抛出的 SecurityError 会静默打断整个 tick 循环。
 * 但"有没有裸读"不能只靠 grep：真正决定危不危险的是**它有没有被 try 包住**。
 * 所以这里做一次结构分析：按行算出大括号深度，并标记每行是否落在 try/catch 区间内。
 *
 * 用法：node tools/_audit-safedoc.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'page');

/**
 * 把一行的字符串/注释/正则剥掉，只留会影响括号计数的代码。跨行状态用 state 传递。
 *
 * ⚠️ **正则字面量必须单独处理。** 第一版漏了它，于是 `60-tasks-detect.js:125`
 * 那个含引号的 `/…("[^"]*")…/` 被当成"进了一个字符串"，从此整份文件后面的行
 * 全被剥成空 —— 那个文件里 4 处裸读**一处都没报出来**，而汇总行照样打印
 * "没有保护 0 处"。这正是 `AGENTS.md` 反复强调的"检查本身没生效"。
 * 所以：判 `/` 是正则还是除号，看它前面那个有效字符/关键字。
 */
function stripLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];
    if (state.block) {
      if (c === '*' && next === '/') { state.block = false; i += 2; } else i++;
      continue;
    }
    if (state.str) {
      if (c === '\\') { i += 2; continue; }
      if (c === state.str) state.str = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') break;                 // 行注释：本行到此为止
    if (c === '/' && next === '*') { state.block = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { state.str = c; i++; continue; }
    if (c === '/') {
      // 正则还是除号？看前面最后一个有效字符 / 关键字
      const before = out.replace(/\s+$/, '');
      const last = before.slice(-1);
      const lastWord = (before.match(/[A-Za-z_$][\w$]*$/) || [''])[0];
      const regexOk = last === '' ||
        /[({[;,=:!&|?+\-*%~^<>]/.test(last) ||
        ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
          'instanceof', 'do', 'else', 'yield', 'await'].indexOf(lastWord) !== -1;
      if (regexOk) {
        i++;                                              // 跳过开头的 /
        let inClass = false;
        while (i < line.length) {
          const d = line[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < line.length && /[a-z]/i.test(line[i])) i++;   // 修饰符
        continue;
      }
      out += c; i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 逐行算出 { 深度，并标记该行是否处于某个 try/catch 区间内。 */
function structure(text) {
  const lines = text.split(/\r?\n/);
  const state = { block: false, str: null };
  const tryStack = [];        // 每个元素 = 进入 try 体之前的深度
  const info = [];
  let depth = 0;
  lines.forEach(function (raw, idx) {
    const code = stripLine(raw, state);
    const depthBefore = depth;
    // 本行是否在 try 区间内：存在一个 try 帧，其起始深度 < 本行起始深度
    const inTry = tryStack.some(function (d) { return d < depthBefore; });
    // 该行（或紧邻的后续行）里出现 `try` 且后面跟着 `{`
    if (/\btry\b/.test(code)) {
      // `try` 后面可能换行才出现 `{`；这里先记一个"待定"帧，遇到 { 时补正
      tryStack.push(depthBefore);
    }
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    // 已经退出该 try 区间的帧丢掉
    while (tryStack.length && depth <= tryStack[tryStack.length - 1]) tryStack.pop();
    info.push({ line: idx + 1, text: raw, code: code, depthBefore: depthBefore, inTry: inTry });
  });
  return info;
}

/** 找出这一行所属的函数名（向上找最近的 `xxx: function` 或 `function xxx`） */
function ownerFn(info, at) {
  for (let i = at; i >= 0; i--) {
    const m = info[i].code.match(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/) ||
              info[i].code.match(/function\s+([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return '(文件顶层)';
}

// 裸读跨域 document 的形态：直接摸 contentDocument，或 contentWindow.document
const BARE = /\.contentDocument|\.contentWindow\s*\.\s*document/;

// 这三个助手**本身就是**做安全读取的地方，它们内部的访问是合法的
const ALLOWED_FNS = ['_safeDocOf', '_safeWinDoc', '_isFrameSameOrigin', '_getMainWindow'];

let risky = 0, guarded = 0;
const files = fs.readdirSync(DIR).filter(function (f) { return /\.js$/.test(f); }).sort();

let rawHits = 0, strippedHits = 0;   // 自校验用
files.forEach(function (file) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const info = structure(raw);
  info.forEach(function (row) {
    if (BARE.test(row.text)) rawHits++;
    if (!BARE.test(row.code)) return;
    strippedHits++;
    const fn = ownerFn(info, info.indexOf(row));
    if (ALLOWED_FNS.indexOf(fn) !== -1) return;          // 助手自身，跳过
    const tag = row.inTry ? 'OK  ' : '危险';
    if (row.inTry) guarded++; else risky++;
    console.log(tag + '  ' + file + ':' + row.line + '  [' + fn + ']');
    console.log('        ' + row.text.trim().slice(0, 110));
  });
});

console.log('');
console.log('裸读处共 ' + (risky + guarded) + ' 处：被 try 包住 ' + guarded + ' 处，**没有保护 ' + risky + ' 处**');

// ---- 自校验：剥注释后的命中数不该少于原文命中数（少了说明词法器又漏了）----
console.log('');
console.log('自校验：原文命中 ' + rawHits + ' 行，剥注释后命中 ' + strippedHits + ' 行');
if (strippedHits < rawHits) {
  console.log('  ⚠️ 剥注释后反而变少 —— 词法器可能又把某些行吞了，上面的结论不可信');
  console.log('     （差值 ' + (rawHits - strippedHits) + ' 行；若这些确实落在注释/字符串里则属正常）');
  process.exit(2);
}
console.log('  ✅ 没有整段被吞（差值只可能来自注释/字符串里的字样）');

if (risky) {
  console.log('');
  console.log('⚠️ 没有保护的这些，一旦命中跨域 iframe 就会抛 SecurityError。');
  console.log('   看它们会不会冒泡到 _runTick：若调用链上没有 try/catch，整轮调度会停摆。');
}
process.exit(risky ? 1 : 0);
