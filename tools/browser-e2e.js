#!/usr/bin/env node
/**
 * 真实浏览器功能交叉检验：`npm run e2e`
 *
 * 在**独立临时 profile** 里启动 Edge（绝不碰用户正在使用的实例与数据），
 * 加载本仓库扩展，逐个访问本地 mock 页面，验证每项核心功能的实际行为。
 *
 * 它与 tools/integration-test.js 的分工：
 *   - integration-test 用打桩 DOM 验证 content.js 的协议与链路（快、无浏览器）
 *   - browser-e2e 用真实浏览器 + 真实 DOM 验证 page.js 的**行为**
 *     （抠题、回填 DOM、倍速/静音/seek、页面类型判定）
 * 打桩测不出 DOM 结构问题 —— 本轮发现的三处抠题缺陷全是这里暴露的。
 *
 * 依赖：只用到 Node 内置模块 + Node 22 自带的全局 WebSocket（CDP 走它）。
 * 前置：本机装有 Edge。路径可用 OMITONE_EDGE 覆盖。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var { spawn } = require('child_process');

var ROOT = path.join(__dirname, '..');
var PORT = Number(process.env.OMITONE_E2E_PORT || 8899);
var CDP_PORT = Number(process.env.OMITONE_CDP_PORT || 9222);
var DEBUG = !!process.env.OMITONE_E2E_DEBUG;

var DEFAULT_EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge'
];

/**
 * 验证码示意图。
 *
 * 用 SVG 而不是 1×1 PNG：page.js 的 _detectStandaloneCaptcha 会用
 * `img.naturalWidth || img.clientWidth` 过滤尺寸（40~400 × 16~200），
 * 1×1 的 PNG 虽然 CSS 拉到 120×40，但 naturalWidth 仍是 1 → 被过滤掉。
 * SVG 带 width/height，naturalWidth 就是真实值。
 */
var CAPTCHA_SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">' +
  '<rect width="120" height="40" fill="#f0f0f0"/>' +
  '<text x="12" y="28" font-family="monospace" font-size="20" fill="#333">aB3d</text>' +
  '</svg>', 'utf8'
).toString('base64');

var failures = [];
var checks = 0;
/** 当前场景名，用于给断言加前缀 */
var currentScenario = '';

function check(name, ok, detail) {
  checks++;
  var label = currentScenario ? currentScenario + ' · ' + name : name;
  if (ok) console.log('  [ok]   ' + label);
  else {
    failures.push(label + (detail ? ' → ' + detail : ''));
    console.log('  [FAIL] ' + label + (detail ? ' → ' + detail : ''));
  }
}

function section(title) {
  currentScenario = title;
  console.log('\n[' + title + ']');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function findEdge() {
  if (process.env.OMITONE_EDGE) return process.env.OMITONE_EDGE;
  for (var i = 0; i < DEFAULT_EDGE.length; i++) {
    if (fs.existsSync(DEFAULT_EDGE[i])) return DEFAULT_EDGE[i];
  }
  return null;
}

/**
 * 算出"未打包扩展"的 ID —— **只作为兜底**，真值一律由 `discoverExtensionId` 在运行时发现。
 *
 * 算法：SHA256(扩展目录绝对路径 UTF-16LE) 的前 32 位，逐位映射 0-f → a-p
 * （Windows 上按 UTF-16LE 参与哈希，不是 UTF-8 —— 靠 tools/ext-id.js 反推出来的）。
 *
 * ⚠️ 这个算法对**路径大小写**极度敏感，别信它：
 *
 *   D:\Omite → hdlemlcmf…（真实）
 *   d:\Omite → locncobd…（算出来是错的）
 *
 * 在 Git Bash / WSL / 某些 CI shell 里启动 node 时，cwd 会带成 `/d/Omite`
 * 这种小写盘符形式，`__dirname` 随之变成小写，哈希就整个错开了。
 *
 * 错开之后的症状极具误导性：**扩展其实加载得好好的**
 * （`[Omitone] content bridge ready` 照常出现在页面里），
 * 但测试拿着错误的 ID 去注入 `chrome-extension://<错ID>/page.js` → 404，
 * 打开 `chrome-extension://<错ID>/popup/popup.html` → 错误页，
 * 于是 14 个场景全部报"page.js 在真实 Edge 中加载成功：失败"，
 * 页面里却一条异常都没有，看起来就像"扩展坏了"。
 *
 * 为什么要算而不是去 CDP 里找：MV3 的 service worker 是懒启动的，
 * 不一定会出现在 target 列表里。靠"等它出现"会让测试随机失败。
 * （这句话只对了一半 —— 真正可靠的是 content script 的执行上下文，见下。）
 */
function computeExtensionId(dir) {
  var normalized = path.resolve(dir).replace(/[\\/]+$/, '');
  var hex = crypto.createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest('hex').slice(0, 32);
  return hex.split('').map(function (c) {
    return String.fromCharCode(97 + parseInt(c, 16));
  }).join('');
}

/**
 * 结束整个进程树。
 *
 * 只调用 child.kill() 不够：Edge 会派生独立子进程，主进程死了它们照样活着
 * 并继续占用 CDP 端口。下次运行会连到**上一次那个旧实例**上 ——
 * 表现为"所有候选扩展 ID 都注入失败"，非常难查。
 */
function killTree(proc) {
  return new Promise(function (resolve) {
    if (!proc || proc.exitCode !== null) return resolve();
    if (process.platform === 'win32') {
      var killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('close', function () { resolve(); });
      killer.on('error', function () { try { proc.kill(); } catch (e) {} resolve(); });
      setTimeout(resolve, 8000);
      return;
    }
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
    resolve();
  });
}

// ===========================================================================
// Mock 页面
//
// DOM 结构严格照着 page.js 的选择器约定搭，注释里标明每个约定对应哪段代码。
// ===========================================================================

/**
 * 学习通风格的测验页：5 种题型各一道。
 *
 * 关键约定（每一条都是 page.js 里读死的）：
 *   - 容器 `.TiMu` + `qid` 属性          → _collectQuestionContainers / _getQuestionIdFromElement
 *   - `typename` 属性给出题型             → _detectQuestionType
 *   - 题号单独放在 `.fontLabel`（只有 "1."）→ 这是会让旧实现题干变空的坑
 *   - 题干与题号同处 `.Pt1`               → _parseQuestionElement 的 titleSelectors
 *   - 选项 `<li class="before-after" qid=…>` → _getOptionItems 的首选选择器
 *   - 选项徽标 `.num_option[data]` 且带 `choice{qid}` → _matchOptionItem / _clickOptionItem
 *   - 隐藏域 `#answer{qid}` + `#answertype{qid}`     → _getQuizQuestionFilledValue
 */
function buildQuizHtml() {
  function options(qid, list, multi) {
    return list.map(function (text, i) {
      var letter = String.fromCharCode(65 + i);
      var badgeClass = multi ? 'num_option num_option_dx choice' + qid : 'num_option choice' + qid;
      return '    <li class="before-after" qid="' + qid + '" data="' + letter + '">\n' +
        '      <label>\n' +
        '        <input type="' + (multi ? 'checkbox' : 'radio') + '" name="answer' + qid + '" value="' + letter + '">\n' +
        '        <span class="' + badgeClass + '" data="' + letter + '">' + letter + '</span>\n' +
        '        <span class="fl after">' + text + '</span>\n' +
        '      </label>\n' +
        '    </li>';
    }).join('\n');
  }

  function judgeOptions(qid) {
    return [
      { letter: 'A', data: 'true', text: '正确' },
      { letter: 'B', data: 'false', text: '错误' }
    ].map(function (o) {
      return '    <li class="before-after" qid="' + qid + '" data="' + o.letter + '">\n' +
        '      <label>\n' +
        '        <input type="radio" name="answer' + qid + '" value="' + o.letter + '">\n' +
        '        <span class="num_option choice' + qid + '" data="' + o.data + '">' + o.letter + '</span>\n' +
        '        <span class="fl after">' + o.text + '</span>\n' +
        '      </label>\n' +
        '    </li>';
    }).join('\n');
  }

  function wrap(qid, no, typename, stem, inner, typeValue) {
    return '  <div class="TiMu" qid="' + qid + '" typename="' + typename + '">\n' +
      '    <div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">' + no + '.</span>【' + typename + '】' + stem + '</div></div>\n' +
      inner + '\n' +
      '    <input type="hidden" id="answer' + qid + '" value="">\n' +
      '    <input type="hidden" id="answertype' + qid + '" value="' + typeValue + '">\n' +
      '  </div>';
  }

  var q1 = wrap(1001, 1, '单选题', '中国特色社会主义最本质的特征是什么？',
    '  <ul class="Zy_ulTop">\n' + options(1001, ['中国共产党的领导', '共同富裕', '人民当家作主', '依法治国'], false) + '\n  </ul>', '0');
  var q2 = wrap(1002, 2, '多选题', '以下属于操作系统核心功能的有：',
    '  <ul class="Zy_ulTop">\n' + options(1002, ['进程管理', '内存管理', '文件系统管理', '编译源代码'], true) + '\n  </ul>', '1');
  var q3 = wrap(1003, 3, '判断题', '对称加密算法的加密密钥与解密密钥相同。',
    '  <ul class="Zy_ulTop">\n' + judgeOptions(1003) + '\n  </ul>', '3');
  // 填空题必须避开 A-F + 标点的组合，否则会被选项兜底正则误切成假选项
  var q4 = wrap(1004, 4, '填空题', '一个完整的 IP 地址由______和______两部分组成。',
    '  <div class="fillBox"><input type="text" name="blank1"><input type="text" name="blank2"></div>', '2');
  var q5 = wrap(1005, 5, '简答题', '简述数据库事务的 ACID 特性及其含义。',
    '  <div class="editorBox"><textarea name="editor1005"></textarea></div>', '4');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验 - 学习通</title></head><body>' +
    '<h1 class="mark_title">章节测验</h1>' +
    '<input type="hidden" id="courseId" value="123456">' +
    '<input type="hidden" id="classId" value="654321">' +
    '<input type="hidden" id="workId" value="999">' +
    '<div id="Zyapl">\n' + [q1, q2, q3, q4, q5].join('\n') + '\n</div>' +
    '<div class="subBtn"><button id="submitBtn" type="button">提交</button></div>' +
    '</body></html>';
}

/**
 * 批改结果页：一道答对、一道答错。
 *
 * 用来验证两件容易出错的事：
 *   1. 对错判定必须保守 —— `.fr.dui` 才是对，`.fr.bandui`（半对）/`.fr.cuo`（错）都不能当对，
 *      否则把错题记进"正确答案缓存"，后续答题会一直用错误答案。
 *      （注意 `[class*="dui"]` 会把 bandui 也匹配上，所以代码里用 classList 精确比对 token。）
 *   2. 交卷后输入域会被清空，正确答案只存在于 .Py_answer 的展示文本里，
 *      必须能从"正确答案：A 我的答案：B"里解析出 A。
 */
function buildQuizResultHtml() {
  function block(qid, no, correctLetter, myLetter, iconClass, iconText) {
    return '  <div class="TiMu" qid="' + qid + '" typename="单选题">\n' +
      '    <div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">' + no + '.</span>【单选题】批改结果题' + no + '</div></div>\n' +
      '    <ul class="Zy_ulTop">\n' +
      '      <li class="before-after" qid="' + qid + '" data="A"><label>' +
      '<input type="radio" name="answer' + qid + '" value="A">' +
      '<span class="num_option choice' + qid + '" data="A">A</span>' +
      '<span class="fl after">选项甲</span></label></li>\n' +
      '      <li class="before-after" qid="' + qid + '" data="B"><label>' +
      '<input type="radio" name="answer' + qid + '" value="B">' +
      '<span class="num_option choice' + qid + '" data="B">B</span>' +
      '<span class="fl after">选项乙</span></label></li>\n' +
      '    </ul>\n' +
      '    <input type="hidden" id="answer' + qid + '" value="">\n' +
      '    <input type="hidden" id="answertype' + qid + '" value="0">\n' +
      '    <div class="Py_answer clearfix">\n' +
      '      <span>正确答案：</span><span class="font14">' + correctLetter + '</span>\n' +
      '      <span class="fr ' + iconClass + '" title="' + iconText + '"></span>\n' +
      '      <span>我的答案：</span><span>' + myLetter + '</span>\n' +
      '    </div>\n' +
      '  </div>';
  }

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验 - 学习通</title></head><body>' +
    '<h1 class="mark_title">章节测验（已批改）</h1>' +
    block(2001, 1, 'A', 'A', 'dui', '答对') + '\n' +
    block(2002, 2, 'A', 'B', 'cuo', '答错') +
    '</body></html>';
}

/**
 * 过关测试：题目在 iframe 里（学习通的真实结构）。
 *
 * 为什么必须单独有一个场景：学习通章节测验的题目根本不在顶层文档里，
 * 而在 `#frame_content` 这个 iframe 内。_extractQuestions 为此专门准备了
 * "先扒 preferredDoc 里的 frame_content，再 _walkDocuments 递归" 的路径，
 * 但这条路径此前是**零覆盖** —— 全部用例都跑在"题就在顶层文档"的页面上，
 * 于是 iframe 这条真实路径对不对，测试一句都没说过话。
 *
 * 题型照用户实测那一份配置：单选(4 选项) × 1 + 多选(4 选项) × 2 + 判断 × 1。
 */
function buildChapterQuizInnerHtml() {
  function options(qid, list, multi) {
    return list.map(function (text, i) {
      var letter = String.fromCharCode(65 + i);
      var badgeClass = multi ? 'num_option num_option_dx choice' + qid : 'num_option choice' + qid;
      return '    <li class="before-after" qid="' + qid + '" data="' + letter + '">\n' +
        '      <label>\n' +
        '        <input type="' + (multi ? 'checkbox' : 'radio') + '" name="answer' + qid + '" value="' + letter + '">\n' +
        '        <span class="' + badgeClass + '" data="' + letter + '">' + letter + '</span>\n' +
        '        <span class="fl after">' + text + '</span>\n' +
        '      </label>\n' +
        '    </li>';
    }).join('\n');
  }

  function judgeOptions(qid) {
    return [
      { letter: 'A', data: 'true', text: '正确' },
      { letter: 'B', data: 'false', text: '错误' }
    ].map(function (o) {
      return '    <li class="before-after" qid="' + qid + '" data="' + o.letter + '">\n' +
        '      <label>\n' +
        '        <input type="radio" name="answer' + qid + '" value="' + o.letter + '">\n' +
        '        <span class="num_option choice' + qid + '" data="' + o.data + '">' + o.letter + '</span>\n' +
        '        <span class="fl after">' + o.text + '</span>\n' +
        '      </label>\n' +
        '    </li>';
    }).join('\n');
  }

  function wrap(qid, no, typename, stem, inner, typeValue) {
    return '  <div class="TiMu" qid="' + qid + '" typename="' + typename + '">\n' +
      '    <div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">' + no + '.</span>【' + typename + '】' + stem + '</div></div>\n' +
      inner + '\n' +
      '    <input type="hidden" id="answer' + qid + '" value="">\n' +
      '    <input type="hidden" id="answertype' + qid + '" value="' + typeValue + '">\n' +
      '  </div>';
  }

  var q1 = wrap(3001, 1, '单选题', '在关系数据库中，用于唯一标识一条记录的是：',
    '  <ul class="Zy_ulTop">\n' + options(3001, ['主键', '外键', '索引', '视图'], false) + '\n  </ul>', '0');
  var q2 = wrap(3002, 2, '多选题', '以下属于操作系统核心功能的有：',
    '  <ul class="Zy_ulTop">\n' + options(3002, ['进程管理', '内存管理', '文件系统管理', '编译源代码'], true) + '\n  </ul>', '1');
  var q3 = wrap(3003, 3, '多选题', '下列哪些协议工作在传输层：',
    '  <ul class="Zy_ulTop">\n' + options(3003, ['TCP', 'UDP', 'IP', 'HTTP'], true) + '\n  </ul>', '1');
  var q4 = wrap(3004, 4, '判断题', '对称加密算法的加密密钥与解密密钥相同。',
    '  <ul class="Zy_ulTop">\n' + judgeOptions(3004) + '\n  </ul>', '3');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验</title></head><body>' +
    '<h1 class="mark_title">章节测验</h1>' +
    '<input type="hidden" id="courseId" value="123456">' +
    '<input type="hidden" id="classId" value="654321">' +
    '<input type="hidden" id="workId" value="999">' +
    '<div id="Zyapl">\n' + [q1, q2, q3, q4].join('\n') + '\n</div>' +
    '<div class="subBtn"><button id="submitBtn" type="button">提交</button></div>' +
    '</body></html>';
}

/**
 * 作业 / 考试页（`.Cy_*` 那一族结构）。
 *
 * 为什么必须单独有一个场景：学习通有**两套**题目标记，
 *   章节测验：.TiMu + .Zy_ulTop        ← 此前全部场景用的都是这一套
 *   作业考试：.Cy_TItle + .Cy_ulTop    ← 用户实际卡住的是这一套
 * 在补这个场景之前，仓库里 Cy_TItle / Cy_ulTop / questionLi 的出现次数都是 0，
 * 也就是说"作业考试页能不能抠到题"这件事，测试一句都没说过话。
 *
 * 结构照 cxmooc-tools 的 `cxExamSelectQuestion` 写：
 *   - 选项**文本**在 `.Cy_ulTop li` 的 `<a>` 里
 *   - 可点的 **input 在 `.Cy_ulBottom li`** 里 —— 两者是分开的两个 <ul>
 * 这个"文本和控件分离"正是要验证的风险点：若 `_getOptionItems` 抢先命中
 * `.Cy_ulTop li`（只有文本、没有 input），点下去就是空点，站点什么也收不到。
 *
 * 题型照用户实测：单选(4 选项) × 1 + 多选(4 选项) × 2 + 判断 × 1。
 *
 * ⚠️ **选项 <li> 上故意不带 qid、不带 .num_option 徽标** —— 这是真实作业页的样子，
 * 也正是 e2e 用来守住的两个风险点：
 *   ① qid 只在容器 `.Cy_TItle[qid]` 上。`_clickOptionItem` 若只认
 *      `item.getAttribute('qid')`，就拿不到 qid → 不写 `#answer{qid}` →
 *      插件判"未填写" → 整卷永不提交（现场症状：AI 点了选项然后什么都不发生）。
 *   ② 判断字母只能从文本前缀 `A. ` 或 `input.value` 推（真实页没有徽标）。
 *      对照 cxmooc-tools：考试选择题的字母就是从 `li` 文本前缀取的。
 */
function buildExamWorkHtml() {
  function textList(list) {
    return list.map(function (t, i) {
      return '    <li><div class="clearfix"><a href="javascript:void(0)">' +
        String.fromCharCode(65 + i) + '. ' + t + '</a></div></li>';
    }).join('\n');
  }

  function inputList(qid, count, multi) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push('    <li><input type="' + (multi ? 'checkbox' : 'radio') +
        '" name="answer' + qid + '" value="' + String.fromCharCode(65 + i) + '"></li>');
    }
    return out.join('\n');
  }

  function judgeInputs(qid) {
    return '    <li><input type="radio" name="answer' + qid + '" value="true"></li>\n' +
      '    <li><input type="radio" name="answer' + qid + '" value="false"></li>';
  }

  function wrap(qid, no, typename, stem, texts, inputs, typeValue) {
    return '  <div class="Cy_TItle" qid="' + qid + '">\n' +
      '    <div class="Cy_TItle clearfix"><span class="fontLabel">' + no + '.</span>【' + typename + '】' + stem + '</div>\n' +
      '    <ul class="Cy_ulTop w-top">\n' + texts + '\n    </ul>\n' +
      '    <ul class="Cy_ulBottom clearfix w-buttom">\n' + inputs + '\n    </ul>\n' +
      '    <input type="hidden" id="answer' + qid + '" value="">\n' +
      '    <input type="hidden" id="answertype' + qid + '" value="' + typeValue + '">\n' +
      '  </div>';
  }

  var q1 = wrap(5001, 1, '单选题', '在关系数据库中，用于唯一标识一条记录的是：',
    textList(['主键', '外键', '索引', '视图']), inputList(5001, 4, false), '0');
  var q2 = wrap(5002, 2, '多选题', '以下属于操作系统核心功能的有：',
    textList(['进程管理', '内存管理', '文件系统管理', '编译源代码']), inputList(5002, 4, true), '1');
  var q3 = wrap(5003, 3, '多选题', '下列哪些协议工作在传输层：',
    textList(['TCP', 'UDP', 'IP', 'HTTP']), inputList(5003, 4, true), '1');
  var q4 = wrap(5004, 4, '判断题', '对称加密算法的加密密钥与解密密钥相同。',
    textList(['正确', '错误']), judgeInputs(5004), '3');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>作业 - 学习通</title></head><body>' +
    '<div class="Cy_TItle1">一、题目</div>' +
    '<div id="Zyapl">\n' + [q1, q2, q3, q4].join('\n') + '\n</div>' +
    '<div class="subBtn"><button id="submitBtn" type="button" class="btnSubmit">提交</button></div>' +
    // ⚠️ 这两段此前**完全缺失**，于是"提交 → 判定完成"整条链在 e2e 里从没被走过。
    //
    // 补齐的原因（现场现象：AI 反复扫描题目、重复提交）：
    //   ① `_shouldAutoSubmitQuiz` 认提交入口只看三样 ——
    //      `window.btnBlueSubmit` / 标题含「章节测验」/ `.btnSubmit,.bluebtn,.workBtnIndex,#form1`。
    //      真实作业页（`/mooc-ans/work/`）走的是**第一样**：站点在自己页面上挂了同名函数。
    //      mock 页原先三样都没有 → `auto submit skipped` → 插件永不提交，只会重扫重答。
    //   ② 真实站点提交时会弹自己的确认框（`#workpop` + `#popok`），
    //      page.js 有一段专门的"1.2 秒后点 #popok"逻辑，同样从没被覆盖过。
    //
    // 所以这里照真实结构补齐：`window.btnBlueSubmit` 弹确认框，点 `#popok` 才真正提交。
    //
    // 提交后换成**判分结果页**（不是简单的「任务点已完成」横幅）：
    // 真实结果页每道题下面多出「我的答案 / 正确答案 / 解析」，并且题目控件全部 disabled。
    // 它既不命中 `.testTit_status_complete`，也不命中父层 wrapper 的「任务点已完成」——
    // 这正是 `_isQuizResultPageFinished` 要守的场景。
    // 若这里偷懒只放一条「任务点已完成」横幅，那条新判据就永远测不到。
    '<script>' +
    'window.btnBlueSubmit = function(){' +
    '  if (window.__submitted) return;' +
    '  var pop = document.createElement("div");' +
    '  pop.id = "workpop"; pop.style.display = "block";' +
    '  pop.innerHTML = \'<div id="popcontent">确认提交本次作业？</div>\' +' +
    '    \'<a id="popok" href="javascript:void(0)">确定</a>\';' +
    '  document.body.appendChild(pop);' +
    '  document.getElementById("popok").addEventListener("click", function(){' +
    '    window.__submitted = true;' +
    // 判分结果页：容器还在（.Cy_TItle 仍在，走到"控件是否 disabled"那一条），
    // 每题补 .Py_answer，所有控件 disabled。
    '    Array.from(document.querySelectorAll("input[type=radio],input[type=checkbox]"))' +
    '      .forEach(function(i){ i.disabled = true; });' +
    '    Array.from(document.querySelectorAll(".Cy_TItle[qid]")).forEach(function(q,i){' +
    '      var d = document.createElement("div");' +
    '      d.className = "Py_answer clearfix";' +
    '      d.innerHTML = \'<span class="fl">我的答案：A</span>\' +' +
    '        \'<span class="fr">正确答案：A</span>\';' +
    '      q.appendChild(d);' +
    '    });' +
    '    var s = document.createElement("div");' +
    '    s.className = "answerScore";' +
    '    s.textContent = "本次作业得分 100 分";' +
    '    document.body.appendChild(s);' +
    '    if (pop.parentNode) pop.parentNode.removeChild(pop);' +
    '  });' +
    '};' +
    // 直接点"提交"按钮也走同一条路（覆盖 _findButtonByText 那条兜底分支）
    'document.getElementById("submitBtn").addEventListener("click", function(){ window.btnBlueSubmit(); });' +
    '</script>' +
    '</body></html>';
}

/** 学习通学生端外壳：题目内容整体装在 #frame_content 里 */
function buildChapterQuizShellHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>学生学习 - 学习通</title></head><body>' +
    '<div class="root">' +
    '<iframe id="frame_content" name="frame_content" src="/quiz-inner" ' +
    'style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    '</body></html>';
}

/** 插件完全不认识的 DOM 结构，用来验证"扫不到题"的诊断输出 */
function buildWeirdHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验 - 学习通</title></head><body>' +
    '<h1 class="mark_title">章节测验</h1>' +
    '<div class="brand-new-wrapper"><p>这道题的容器类名插件完全不认识</p>' +
    '<div><input type="radio" name="x" value="A">甲</div>' +
    '<div><input type="radio" name="x" value="B">乙</div></div>' +
    '</body></html>';
}

/** 媒体页：video 元素的 duration/currentTime/playbackRate 由测试脚本打桩，摆脱真实编解码器 */
function buildMediaHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<div id="iframe">' +
    '  <div class="video-js vjs-player">' +
    '    <video id="omitone-video" preload="auto" src="mock-video.mp4"></video>' +
    '  </div>' +
    '  <!-- 音频任务点的播放器常把 audio 藏起来（零尺寸/无控件），' +
    '       必须验证"无可见媒体时回退到隐藏 audio"这条兜底仍然有效 -->' +
    '  <audio id="omitone-audio" src="mock-audio.m4a" style="display:none"></audio>' +
    '</div>' +
    '</body></html>';
}

/**
 * 「防拖拽 + 倍速锁 1x」视频页 —— 复现"平台只要求看 90%"这一类视频。
 *
 * 三个特征都靠打桩模拟（不依赖真实编解码器）：
 *   1) 拖不动：currentTime 的 setter 忽略写入，进度停在原处（真站点由播放器弹回）
 *   2) 倍速锁 1x：playbackRate 的 setter 把值压回 1
 *   3) 完成标记：`.ans-job-finished` **只在进度 ≥ 90% 时被插入**（低于 90% 就移除）
 *      —— 这是"平台自己说完成了"的唯一来源，插件必须靠它，不能自己认定。
 *      注意是**插入/移除**而不是 display:none —— querySelector 不理会可见性，
 *      用隐藏元素会让"平台还没完成"也判定为已完成，安全阀就测不出来了。
 */
function buildNinetyPercentHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<div id="iframe">' +
    '  <div class="chapter-module" id="module">' +
    '    <div class="video-js vjs-player">' +
    '      <video id="omitone-video" preload="auto" src="mock-video.mp4"></video>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '</body></html>';
}

/**
 * 多讨论任务点页面 —— 复现"多沟通任务"的坑。
 *
 * A 组：3 张讨论卡片挤在**同一个共用容器**里，容器内只有**一个** #isFinished。
 *   旧实现用 doc.getElementById('isFinished') 会让三张卡片共用这一个值 →
 *   第一个已完成则全部被跳过（静默漏做）。
 *   修复后必须：三张卡片各自 finished=false（宁可按未完成处理），
 *   且三者的去重 key 互不相同（旧实现用 url.slice(-70) 会碰撞）。
 *
 * B 组：单独一张卡片、自己的容器里带 #isFinished=true —— 常规路径不能被改坏。
 *
 * 两组的关键区别：mtopicid 之外还有各不相同的尾串，这样 url.slice(-70)
 * 更容易暴露碰撞（把差异放在 70 字符之前）。
 */
function buildDiscussionMultiHtml() {
  var pad = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  function card(id, title) {
    return '    <div id="topicMainDiv" data="https://groupweb.chaoxing.com/course/topic' +
      '?clazzid=1&courseid=2&mtopicid=' + id + '&ut=s&a=' + pad + '">' + title + '</div>';
  }

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div id="iframe">' +
    '  <div class="chapter-module-shared">\n' +
    card(111, '讨论一：为什么说中国特色社会主义道路是历史的选择') + '\n' +
    card(222, '讨论二：谈谈你对共同富裕的理解') + '\n' +
    card(333, '讨论三：如何理解新时代的主要矛盾') + '\n' +
    '    <input type="hidden" id="isFinished" value="true">\n' +
    '  </div>' +
    '  <div class="chapter-module-single">\n' +
    card(444, '讨论四：单独一张卡片，自己带已完成标志') + '\n' +
    '    <input type="hidden" id="isFinished" value="true">\n' +
    '  </div>' +
    '</div>' +
    '</body></html>';
}

/** 空白页：只用来跑纯逻辑断言，不需要任何特定 DOM */
function buildBlankHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body><div id="iframe"></div></body></html>';
}

/** 学习通风格弹窗验证码 */
function buildCaptchaDialogHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div id="iframe"><div class="TiMu" qid="1" typename="单选题">' +
    '  <div class="Pt1"><span class="fontLabel">1.</span>占位题目</div>' +
    '</div></div>' +
    '<div class="layui-layer layui-layer-page" style="position:fixed;left:80px;top:80px;width:360px;height:220px;background:#fff;border:1px solid #ccc;z-index:9999">' +
    '  <div class="layui-layer-title">请输入验证码</div>' +
    '  <div class="layui-layer-content" style="padding:20px">' +
    '    <img id="imgVerCode" name="chapterNumVerCode" src="' + CAPTCHA_SVG + '" width="120" height="40" style="width:120px;height:40px">' +
    '    <input id="ucode" type="text" style="width:120px;height:24px">' +
    '    <button id="sub" type="button">确定</button>' +
    '  </div>' +
    '</div>' +
    '</body></html>';
}

/** 独立验证码网址：顶层页面、没有课程结构、URL 与文案都命中验证码特征 */
function buildStandaloneCaptchaHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>安全验证</title></head><body>' +
    '<h2>安全验证</h2>' +
    '<p>请输入验证码以继续访问</p>' +
    '<img id="verifyImg" src="' + CAPTCHA_SVG + '" width="120" height="40" style="width:120px;height:40px">' +
    '<input id="inputCode" type="text" style="width:140px;height:26px">' +
    '<button type="button">提交</button>' +
    '</body></html>';
}

/** 讨论区页面（仿 groupweb 结构） */
function buildDiscussionHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程讨论区 - 回复话题</title></head><body>' +
    '<div class="topicDetail_title"><h3>为什么说中国特色社会主义道路是历史的选择</h3></div>' +
    '<div class="replyEdit">' +
    '  <div class="textareawrap"><textarea placeholder="回复话题" style="width:520px;height:90px"></textarea></div>' +
    '  <div class="replyEditBtnGroup">' +
    '    <a class="replyBtn" href="javascript:void(0)">回复</a>' +
    '    <button class="jb_btn jb_btn_92 fr fs14 addReply" type="button">回复</button>' +
    '  </div>' +
    '</div>' +
    '<div class="topicDetail_replyList"></div>' +
    '</body></html>';
}

/** 视频弹窗题（课程视频中途弹出的选择题） */
function buildPopupQuizHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<video id="v"></video>' +
    '<div class="ans-pop-quiz" style="position:fixed;left:60px;top:60px;width:460px;height:240px;background:#fff;border:2px solid #333;z-index:9999;padding:16px">' +
    '  <p>1. 下列说法正确的是哪一项？</p>' +
    '  <ul>' +
    '    <li><label><input type="radio" name="pq" value="A"> A. 说法甲</label></li>' +
    '    <li><label><input type="radio" name="pq" value="B"> B. 说法乙</label></li>' +
    '    <li><label><input type="radio" name="pq" value="C"> C. 说法丙</label></li>' +
    '  </ul>' +
    '  <button type="button" class="pq-submit">提交</button>' +
    '</div>' +
    '</body></html>';
}

/**
 * 视频内嵌弹题（原生表单结构，无 qid / 无 .num_option 徽标）。
 *
 * 这是真实站点上最常见的"视频里弹出来的题"：选项就是普通 li + input，
 * 字母只在 input 的 value 和文本前缀里出现。1.0.11 的匹配逻辑认不出它，
 * 于是"AI 问了但一个选项都没选中"，弹窗不关、视频不播、tick 空转。
 */
function buildPopupQuizNativeHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<div id="player"><video id="v"></video></div>' +
    '<div class="ans-pop-quiz" style="position:fixed;left:60px;top:60px;width:460px;height:240px;background:#fff;border:2px solid #333;z-index:9999;padding:16px">' +
    '  <div class="pop-quiz-title">1. 下列说法正确的是哪一项？</div>' +
    '  <ul class="pop-quiz-options">' +
    '    <li class="pop-quiz-option"><input type="radio" name="pq" value="A"><span>A. 说法甲</span></li>' +
    '    <li class="pop-quiz-option"><input type="radio" name="pq" value="B"><span>B. 说法乙</span></li>' +
    '    <li class="pop-quiz-option"><input type="radio" name="pq" value="C"><span>C. 说法丙</span></li>' +
    '  </ul>' +
    '  <div class="pop-quiz-footer"><span class="pop-quiz-submit">提交</span></div>' +
    '</div>' +
    '</body></html>';
}

/** 视频内嵌填空题弹窗（无选项，只有输入框） */
function buildPopupQuizBlankHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<video id="v"></video>' +
    '<div class="ans-pop-quiz" style="position:fixed;left:60px;top:60px;width:460px;height:200px;background:#fff;border:2px solid #333;z-index:9999;padding:16px">' +
    '  <div class="pop-quiz-title">1. 请填写本讲提到的两个关键词。</div>' +
    '  <div class="pop-quiz-body">' +
    '    <input type="text" class="pop-blank" id="blank1">' +
    '    <input type="text" class="pop-blank" id="blank2">' +
    '  </div>' +
    '  <div class="pop-quiz-footer"><span class="pop-quiz-submit">提交</span></div>' +
    '</div>' +
    '</body></html>';
}

/**
 * 播放器右下角的「继续学习」提示。
 * 外层是带长文案的浮层（不该被点中），内层才是真正的按钮。
 */
function buildVideoContinueHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<video id="v"></video>' +
    '<div class="ans-video-tip" style="position:fixed;right:24px;bottom:24px;width:280px;height:110px;background:#fff;border:2px solid #333;padding:12px;z-index:9999">' +
    '  <p>本节视频还有知识点需要确认，请点击下方按钮回到播放器继续本节内容的学习进度</p>' +
    '  <span class="btn-continue" onclick="window.__clicked=(window.__clicked||0)+1">继续学习</span>' +
    '</div>' +
    '</body></html>';
}

var MOCK_PAGES = {
  '/quiz': buildQuizHtml,
  '/chapter-quiz': buildChapterQuizShellHtml,
  '/quiz-inner': buildChapterQuizInnerHtml,
  '/exam-work': buildExamWorkHtml,
  '/quiz-result': buildQuizResultHtml,
  '/weird': buildWeirdHtml,
  '/media': buildMediaHtml,
  '/media-90': buildNinetyPercentHtml,
  '/blank': buildBlankHtml,
  '/captcha-dialog': buildCaptchaDialogHtml,
  '/captcha-verify': buildStandaloneCaptchaHtml,
  '/discussion': buildDiscussionHtml,
  '/discussion-multi': buildDiscussionMultiHtml,
  '/popup-quiz': buildPopupQuizHtml,
  '/popup-quiz-native': buildPopupQuizNativeHtml,
  '/popup-quiz-blank': buildPopupQuizBlankHtml,
  '/video-continue': buildVideoContinueHtml
};

// ===========================================================================
// Mock 模型接口（OpenAI 兼容）
//
// 它内置一个**独立的提示词解析器**（不 import libs/prompt.js）：
// 如果提示词格式变得不可解析，它会直接答不上来，测试随即失败。
// ===========================================================================
function startMockServer() {
  var requests = [];
  // 场景用它让接口返回指定状态码（401 / 403 / 500 …）。
  // 不改它时一律 200 —— 否则所有"正常答题"场景会一起挂掉。
  var forcedStatus = 0;

  var server = http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
      });
      return res.end();
    }

    var urlPath = (req.url || '/').split('?')[0];
    if (MOCK_PAGES[urlPath]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(MOCK_PAGES[urlPath]());
    }

    if (urlPath === '/v1/chat/completions' && req.method === 'POST') {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        var body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}

        var prompt = '';
        if (body.messages) prompt = body.messages.map(function (m) { return m.content; }).join('\n');
        else if (body.contents) prompt = body.contents[0].parts.map(function (p) { return p.text || ''; }).join('\n');

        requests.push({ prompt: prompt });

        if (forcedStatus) {
          // 模拟服务商拒绝：401 = Key 无效（永久错误），500 = 服务端抽风（可重试）。
          // body 必须是 OpenAI 的报错形状 —— content.js 靠它取出 httpStatus 之外的原话。
          var errText = forcedStatus === 401 ? 'Invalid API key'
            : forcedStatus === 403 ? 'Forbidden'
            : 'internal server error';
          res.writeHead(forcedStatus, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ error: { message: errText } }));
        }

        // 独立解析提示词并按 libs/prompt.js 约定的**位置式数组**作答。
        // 这里刻意不 import libs/prompt.js：假模型就是一版独立实现，
        // 如果提示词格式变得不可解析，它会直接答不上来，测试随即失败。
        var answers = [];
        var re = /^(\d+)\|([a-z])\|(.*)$/gm;
        var m;
        while ((m = re.exec(prompt))) {
          var code = m[2];
          if (code === 'm') answers.push(['A', 'C']);
          else if (code === 'j') answers.push(true);
          else if (code === 'f') answers.push('甲|||乙');
          else if (code === 't') answers.push('简答文本');
          else answers.push('A');
        }

        var payload = {
          id: 'mock', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answers) }, finish_reason: 'stop' }]
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(payload));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(function (resolve) {
    server.listen(PORT, '127.0.0.1', function () {
      resolve({
        server: server,
        requests: requests,
        setStatus: function (code) { forcedStatus = code || 0; }
      });
    });
  });
}

// ===========================================================================
// 极简 CDP 客户端
// ===========================================================================
function CdpClient(wsUrl) {
  this.seq = 0;
  this.pending = new Map();
  this.events = [];
  this.ws = null;
  this.wsUrl = wsUrl;
}

CdpClient.prototype.connect = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(self.wsUrl);
    self.ws = ws;
    ws.addEventListener('open', function () { resolve(); });
    ws.addEventListener('error', function (e) { reject(new Error('CDP 连接失败: ' + (e.message || ''))); });
    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && self.pending.has(msg.id)) {
        var entry = self.pending.get(msg.id);
        self.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) self.events.push(msg);
    });
  });
};

CdpClient.prototype.send = function (method, params) {
  var self = this;
  var id = ++this.seq;
  return new Promise(function (resolve, reject) {
    self.pending.set(id, { resolve: resolve, reject: reject });
    self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    setTimeout(function () {
      if (self.pending.has(id)) {
        self.pending.delete(id);
        reject(new Error('CDP 超时: ' + method));
      }
    }, 30000);
  });
};

CdpClient.prototype.evaluate = function (expression) {
  return this.send('Runtime.evaluate', {
    expression: expression,
    awaitPromise: true,
    returnByValue: true
  }).then(function (r) {
    if (r.exceptionDetails) {
      var d = r.exceptionDetails;
      throw new Error('页面抛异常: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  });
};

/**
 * 取出运行时异常。
 *
 * 必须走 CDP 的 Runtime.exceptionThrown，不能在页面里挂 window.onerror ——
 * page.js 是 chrome-extension:// 资源，对 http 页面属于跨域脚本，
 * 浏览器会把错误抹成 "Script error."，拿不到任何有用信息。
 */
CdpClient.prototype.errors = function () {
  return this.events
    .filter(function (e) { return e.method === 'Runtime.exceptionThrown'; })
    .map(function (e) {
      var d = (e.params && e.params.exceptionDetails) || {};
      var ex = d.exception || {};
      return String(ex.description || ex.value || d.text || '').split('\n').slice(0, 2).join(' | ');
    })
    .filter(Boolean);
};

CdpClient.prototype.close = function () {
  try { this.ws.close(); } catch (e) {}
};

// ===========================================================================
function requestJson(url, method) {
  return new Promise(function (resolve, reject) {
    var req = http.request(url, { method: method || 'GET' }, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('非 JSON 响应: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetJson(url) { return requestJson(url, 'GET'); }

async function waitForCdp(timeoutMs) {
  var started = Date.now();
  for (;;) {
    try { return await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) {
      if (Date.now() - started > timeoutMs) throw new Error('CDP 端口 ' + CDP_PORT + ' 在 ' + timeoutMs + 'ms 内未就绪');
      await sleep(300);
    }
  }
}

/**
 * 等调试端口彻底释放。
 *
 * 连续跑两次测试时，上一次的 Edge 进程被杀掉后端口未必立刻回收，
 * 于是下一次启动会连到**上一次那个正在退出的实例**上 ——
 * 症状是"所有注入都失败"或"端口已被占用"，看起来像随机的偶发失败。
 * 所以收尾要等，启动前的占用检查也要等。
 */
async function waitForPortFree(timeoutMs) {
  var started = Date.now();
  for (;;) {
    var busy = null;
    try { busy = await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) { busy = null; }
    if (!busy) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(400);
  }
}

/** 打开新标签（CDP 的 /json/new 只接受 PUT） */
function openTab(url) {
  return requestJson('http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(url), 'PUT');
}

function closeTab(tabId) {
  return requestJson('http://127.0.0.1:' + CDP_PORT + '/json/close/' + tabId, 'GET').catch(function () {});
}

/**
 * 打开一个场景页面并等它就绪。
 *
 * target 可以是 mock 路径（`/quiz`）或完整 URL（`chrome-extension://<id>/popup/popup.html`）。
 * `inject: false` 时跳过 page.js 注入 —— 扩展自己的页面（popup）不需要、
 * 而且它用的是 chrome.* 而不是 postMessage 桥接。
 */
async function discoverExtensionId(fallbackId) {
  // 第一选择：content script 的执行上下文。
  // content_scripts 的 matches 是 `*://*/*`，mock 页一打开它就跑，
  // 于是 Runtime.enable 之后必定能收到一条 origin 为 chrome-extension://<真实ID>
  // 且 name 是扩展名的 executionContextCreated —— 这是唯一拿不错的信息源。
  try {
    var tab = await openTab('http://127.0.0.1:' + PORT + '/blank');
    var client = new CdpClient(tab.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');

    var deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      var hit = client.events.filter(function (e) {
        if (!e.params || !e.params.context) return false;
        var ctx = e.params.context;
        return /^chrome-extension:\/\/[a-p]{32}$/.test(String(ctx.origin || ''))
          && /Omitone/i.test(String(ctx.name || ''));
      })[0];
      if (hit) {
        client.close();
        await closeTab(tab.id);
        return String(hit.params.context.origin).replace('chrome-extension://', '').replace('/', '');
      }
      await sleep(300);
    }
    client.close();
    await closeTab(tab.id);
  } catch (e) {
    if (DEBUG) console.log('  [debug] 上下文探测失败: ' + e.message);
  }

  // 第二选择：target 列表（service worker / background page），按扩展名过滤
  try {
    var targets = await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    var ours = targets.filter(function (t) {
      return /^chrome-extension:\/\//.test(String(t.url || '')) && /Omitone/i.test(String(t.title || ''));
    })[0];
    if (ours) {
      return String(ours.url).replace(/^chrome-extension:\/\/([a-z]+)\/.*$/, '$1');
    }
  } catch (e) {}

  return fallbackId;
}

async function openScenarioPage(extensionId, scenario) {
  var target = String(scenario.url || scenario.path).replace('{EXT}', extensionId);
  var url = /^[a-z-]+:\/\//i.test(target) ? target : 'http://127.0.0.1:' + PORT + target;

  var tab = await openTab(url);
  var client = new CdpClient(tab.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await sleep(scenario.inject === false ? 900 : 1200);

  var ctx = {
    client: client,
    url: url,
    close: async function () {
      client.close();
      await closeTab(tab.id);
    }
  };

  if (scenario.inject === false) return ctx;

  // mock 页不是 chaoxing.com，content.js 的静默守卫不会自动注入 page.js；
  // 但桥接层 content.js 本身已经在页面上跑着，所以 page.js 一注入就能拿到 chrome.* 能力。
  await client.evaluate(
    '(function(){var s=document.createElement("script");' +
    's.src="chrome-extension://' + extensionId + '/page.js";' +
    'document.documentElement.appendChild(s);return true;})()'
  );

  var deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    var ready = await client.evaluate('!!(window._xxtApp && window._xxtApp._extractQuestions)');
    if (ready) break;
    await sleep(400);
  }

  return ctx;
}

/** 轮询直到表达式返回真值 */
async function waitFor(client, expression, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 15000);
  for (;;) {
    if (await client.evaluate(expression)) return true;
    if (Date.now() > deadline) return false;
    await sleep(300);
  }
}

// ===========================================================================
// 场景
// ===========================================================================
var SCENARIOS = [];

/** ---- 1. 抠题：5 种题型 + 题干/选项清洗 ---- */
SCENARIOS.push({
  name: '抠题（5 种题型）',
  path: '/quiz',
  run: async function (ctx) {
    var scanned = await ctx.client.evaluate(
      '(function(){return window._xxtApp._extractQuestions(null).map(function(q){' +
      'return {type:q.type,title:q.title,options:q.options};});})()'
    );

    check('抠到 5 道题', Array.isArray(scanned) && scanned.length === 5,
      '实际 ' + (scanned ? scanned.length : 'n/a'));
    if (!Array.isArray(scanned) || scanned.length !== 5) return;

    check('题型依次识别为 单选/多选/判断/填空/简答',
      scanned.map(function (q) { return q.type; }).join(',') === 'single,multiple,judge,fill,short',
      scanned.map(function (q) { return q.type; }).join(','));

    check('题干解析正确（未被题号清空）',
      scanned[0].title === '中国特色社会主义最本质的特征是什么？',
      JSON.stringify(scanned[0].title));

    check('选项文本干净（无"选项"前缀、"A."残留）',
      JSON.stringify(scanned[0].options) === JSON.stringify(['中国共产党的领导', '共同富裕', '人民当家作主', '依法治国']),
      JSON.stringify(scanned[0].options));

    check('多选题 4 个选项',
      scanned[1].options.length === 4, '实际 ' + scanned[1].options.length);

    check('判断题选项为 正确/错误',
      JSON.stringify(scanned[2].options) === JSON.stringify(['正确', '错误']),
      JSON.stringify(scanned[2].options));

    check('填空题题干保留空位描述',
      scanned[3].title.indexOf('IP 地址由') !== -1, JSON.stringify(scanned[3].title));

    check('简答题题干正确',
      scanned[4].title.indexOf('ACID 特性') !== -1, JSON.stringify(scanned[4].title));
  }
});

/** ---- 1b. 过关测试：题目装在 #frame_content iframe 里 ---- */
SCENARIOS.push({
  name: '抠题（题在 frame_content iframe 里）',
  path: '/chapter-quiz',
  run: async function (ctx) {
    var scanned = await ctx.client.evaluate(
      '(function(){return window._xxtApp._extractQuestions(null).map(function(q){' +
      'return {type:q.type,title:q.title,options:q.options,inIframe:!!q._inIframe};});})()'
    );

    check('_detectQuiz 在 iframe 结构下也认得出这是测验',
      await ctx.client.evaluate('!!window._xxtApp._detectQuiz()'));

    check('iframe 里的 4 道题全部抠到', Array.isArray(scanned) && scanned.length === 4,
      '实际 ' + (Array.isArray(scanned) ? scanned.length : 'n/a'));
    if (!Array.isArray(scanned) || scanned.length !== 4) return;

    check('题型识别为 单选/多选/多选/判断',
      scanned.map(function (q) { return q.type; }).join(',') === 'single,multiple,multiple,judge',
      scanned.map(function (q) { return q.type; }).join(','));

    check('4 道题都被标记为来自 iframe',
      scanned.every(function (q) { return q.inIframe; }),
      JSON.stringify(scanned.map(function (q) { return q.inIframe; })));

    check('两道多选题各 4 个选项',
      scanned[1].options.length === 4 && scanned[2].options.length === 4,
      scanned[1].options.length + '/' + scanned[2].options.length);

    check('判断题选项为 正确/错误',
      JSON.stringify(scanned[3].options) === JSON.stringify(['正确', '错误']),
      JSON.stringify(scanned[3].options));
  }
});

/** ---- 1c. 作业/考试页：`.Cy_*` 结构，选项文本与可点 input 分处两个 ul ---- */
SCENARIOS.push({
  name: '抠题（作业考试页 Cy_* 结构）',
  path: '/exam-work',
  run: async function (ctx) {
    var scanned = await ctx.client.evaluate(
      '(function(){return window._xxtApp._extractQuestions(null).map(function(q){' +
      'var items=window._xxtApp._getOptionItems(q._element);' +
      'return {type:q.type,title:q.title,options:q.options,' +
      'itemTag:items[0]?items[0].tagName:null,' +
      'itemsWithInput:items.filter(function(i){return i.querySelector("input")||i._optionInput;}).length,' +
      'itemsTotal:items.length};});})()'
    );

    check('作业页 4 道题全部抠到', Array.isArray(scanned) && scanned.length === 4,
      '实际 ' + (Array.isArray(scanned) ? scanned.length : 'n/a'));
    if (!Array.isArray(scanned) || scanned.length !== 4) return;

    check('题型识别为 单选/多选/多选/判断',
      scanned.map(function (q) { return q.type; }).join(',') === 'single,multiple,multiple,judge',
      scanned.map(function (q) { return q.type; }).join(','));

    check('每题的 4 个选项文本都抠到了',
      scanned[0].options.length === 4 && scanned[3].options.length === 2,
      scanned.map(function (q) { return q.options.length; }).join('/'));

    // 这条是本题的命门：抠出来的选项节点必须带可点的 input，
    // 否则 _clickOptionItem 里的 input 为 null，点了等于没点，站点一个答案都收不到。
    check('抠到的选项节点全部能找到可点控件（自身带 input，或经配对拿到 _optionInput）',
      scanned.every(function (q) { return q.itemsTotal > 0 && q.itemsWithInput === q.itemsTotal; }),
      JSON.stringify(scanned.map(function (q) {
        return q.itemTag + ' ' + q.itemsWithInput + '/' + q.itemsTotal;
      })));

    // 光"带着控件"还不够，得真的点中。这条直接验证控件状态变了 ——
    // 之前的表现正是"日志打了 clicked option，但 input 一个都没 checked"。
    var single = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=app._extractQuestions(null)[0];' +
      'var n=app._applyChoiceAnswer(q._element,"A","single");' +
      'var ipt=q._element.querySelectorAll("input[type=radio]");' +
      'return {clicked:n,checked:Array.from(ipt).filter(function(i){return i.checked;}).length};})()'
    );
    check('单选点 A：确实有 1 个 radio 被选中（不是只打日志）',
      single.clicked === 1 && single.checked === 1, JSON.stringify(single));

    var multi = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=app._extractQuestions(null)[1];' +
      'var n=app._applyChoiceAnswer(q._element,["A","C"],"multiple");' +
      'var ipt=q._element.querySelectorAll("input[type=checkbox]");' +
      'return {clicked:n,checked:Array.from(ipt).filter(function(i){return i.checked;}).length};})()'
    );
    check('多选点 A、C：确实有 2 个 checkbox 被选中',
      multi.clicked === 2 && multi.checked === 2, JSON.stringify(multi));
  }
});

/**
 * ---- 1d. 作业/考试页：点完选项后 `#answer{qid}` **必须**被写上 ----
 *
 * 这一条盯的是一个曾经静默的洞（现场症状：AI 扫到题、点了选项，然后什么都不发生）：
 * `_clickOptionItem` 写隐藏域那一段原本要求 `qid && badge` 同时成立，
 * 而真实作业页（以及这个 mock）两样都没有 ——
 * qid 只在容器 `.Cy_TItle[qid]` 上，选项 `<li>` 是干净的；也没有 `.num_option` 徽标。
 * 于是点击照做、日志照打 "clicked option"，但 `#answer{qid}` 一直是空串，
 * `_areQuizAnswersFilled` 判 false，整卷永不提交。
 *
 * 断言的是**行为**（隐藏域的值），不是实现细节（不查 `_optionInput` 之类的内部字段）。
 */
SCENARIOS.push({
  name: '作业页选项写入隐藏答案域',
  path: '/exam-work',
  run: async function (ctx) {
    var app = 'window._xxtApp';

    // 前提：mock 页必须是"不友好"的那种（qid 在容器上、无徽标）——
    // 否则这条断言测的是"好走的那条路"，等于没测。
    var shape = await ctx.client.evaluate(
      '(function(){var li=document.querySelector(".Cy_ulTop li");' +
      'return {liQid:li?li.getAttribute("qid"):null,' +
      'hostQid:(function(){var h=li?li.closest("[qid]"):null;return h?h.getAttribute("qid"):null;})(),' +
      'badges:document.querySelectorAll(".num_option, .num_option_dx").length};})()'
    );
    check('前提：选项 <li> 上不带 qid（qid 只在容器上），且无 .num_option 徽标',
      !shape.liQid && !!shape.hostQid && shape.badges === 0, JSON.stringify(shape));

    // 单选：点 A → #answer5001 必须是 "A"
    var single = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var q=a._extractQuestions(null)[0];' +
      'var n=a._applyChoiceAnswer(q._element,"A","single");' +
      'var h=document.getElementById("answer5001");' +
      'return {clicked:n,hidden:h?h.value:null,' +
      'filled:a._getQuizQuestionFilledValue(null,q)};})()'
    );
    check('单选点 A：隐藏域 #answer5001 被写成 A（不是点了却留空）',
      single.clicked === 1 && single.hidden === 'A', JSON.stringify(single));
    check('单选点 A：插件自己读出来的填写值也是 A',
      single.filled === 'A', JSON.stringify(single));

    // 多选：点 C、D → #answer5002 必须是 "CD"（并集、升序）
    var multi = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var q=a._extractQuestions(null)[1];' +
      'var n=a._applyChoiceAnswer(q._element,["C","D"],"multiple");' +
      'var h=document.getElementById("answer5002");' +
      'return {clicked:n,hidden:h?h.value:null,' +
      'filled:a._getQuizQuestionFilledValue(null,q)};})()'
    );
    check('多选点 C、D：隐藏域 #answer5002 被写成 CD（并集，不是只留最后一项）',
      multi.clicked === 2 && multi.hidden === 'CD', JSON.stringify(multi));

    // 判断：点"正确" → #answer5004 必须是 "true"
    var judge = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var q=a._extractQuestions(null)[3];' +
      'var n=a._applyChoiceAnswer(q._element,"正确","judge");' +
      'var h=document.getElementById("answer5004");' +
      'return {clicked:n,hidden:h?h.value:null,' +
      'filled:a._getQuizQuestionFilledValue(null,q)};})()'
    );
    check('判断题点"正确"：隐藏域 #answer5004 被写成 true',
      judge.clicked === 1 && judge.hidden === 'true', JSON.stringify(judge));

    // 把第 3 题（index 2，第二个多选）也点上 —— 上面只点了 0/1/3，
    // 漏填一题会让下面那条"整卷填满"的守卫失败，那是测试自己的锅，不是产品。
    var q3 = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var q=a._extractQuestions(null)[2];' +
      'var n=a._applyChoiceAnswer(q._element,["A","B"],"multiple");' +
      'var h=document.getElementById("answer5003");' +
      'return {clicked:n,hidden:h?h.value:null};})()'
    );
    check('再点第 3 题：隐藏域 #answer5003 被写成 AB',
      q3.clicked === 2 && q3.hidden === 'AB', JSON.stringify(q3));

    // 反向守卫：整卷四题都填过之后，_areQuizAnswersFilled 必须为真 ——
    // 它正是 _quizReadyToSubmit 的来源；它恒 false 就是"永不提交"。
    var allFilled = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var qs=a._extractQuestions(null);' +
      'return {filled:qs.length?qs.map(function(q){return a._getQuizQuestionFilledValue(null,q);}):[],' +
      'ok:a._areQuizAnswersFilled(null,qs,{requireThisRun:false})};})()'
    );
    check('四题都点过之后，_areQuizAnswersFilled 为真（否则整卷永不提交）',
      allFilled.ok === true && allFilled.filled.every(function (v) { return !!v; }),
      JSON.stringify(allFilled));
  }
});

/** ---- 2. 完整答题往返：抠题 → 提示词 → 模型 → 回填 DOM ---- */
SCENARIOS.push({
  name: '答题往返 + 回填 DOM',
  path: '/quiz',
  run: async function (ctx) {
    var before = ctx.mock.requests.length;

    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };

    // 必须同时喂两处配置：
    //   - page.js 的 configs 决定"要不要发请求"
    //   - chrome.storage 的 config 才是 content.js 真正拿去发请求的凭据
    // 只改前者的话，content.js 会因为 storage 里没有 apiKey 而直接拒绝，一个 HTTP 请求都不会发。
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );
    await ctx.client.evaluate('window._xxtApp._handleQuiz(null); true');

    var gotRequest = false;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (ctx.mock.requests.length > before) { gotRequest = true; break; }
      await sleep(300);
    }
    check('提示词已发到模型接口', gotRequest, '请求数 +' + (ctx.mock.requests.length - before));
    if (!gotRequest) return;

    var prompt = ctx.mock.requests[ctx.mock.requests.length - 1].prompt;
    check('提示词含紧凑题型代号（形如 1|s|）', /\d+\|s\|/.test(prompt), prompt.slice(0, 140));
    check('提示词含题干原文', prompt.indexOf('中国特色社会主义最本质的特征') !== -1);
    check('提示词不含旧版 "Question 1 [" 样板', prompt.indexOf('Question 1 [') === -1);
    check('提示词不含旧版逐题 JSON 示例', prompt.indexOf('"type": "single"') === -1);
    check('提示词使用位置式输出示例（不含 "i":/键名样板）',
      /输出:\["A"/.test(prompt) && prompt.indexOf('"i":0') === -1, prompt.slice(-80));

    var filled = await waitFor(ctx.client,
      'document.getElementById("answer1001").value !== ""', 15000);
    check('答案已回填（等待隐藏域被写入）', filled);

    var result = await ctx.client.evaluate(
      '(function(){var g=function(id){var e=document.getElementById(id);return e?String(e.value):null;};' +
      'var ta=document.querySelector("textarea[name=\'editor1005\']");' +
      'var blanks=Array.prototype.map.call(document.querySelectorAll(".fillBox input"),function(i){return i.value;});' +
      'return {a1001:g("answer1001"),a1002:g("answer1002"),a1003:g("answer1003"),' +
      'a1004:g("answer1004"),a1005:g("answer1005"),blanks:blanks,textarea:ta?ta.value:null};})()'
    );

    check('单选题回填 A → #answer1001', result.a1001 === 'A', JSON.stringify(result.a1001));
    check('多选题回填 A,C → #answer1002 = "AC"', result.a1002 === 'AC', JSON.stringify(result.a1002));
    check('判断题回填 true → #answer1003', result.a1003 === 'true', JSON.stringify(result.a1003));
    check('填空题多空拆分并拼接 → #answer1004 = "甲乙"', result.a1004 === '甲乙', JSON.stringify(result.a1004));
    check('填空两个输入框分别填 甲 / 乙',
      JSON.stringify(result.blanks) === JSON.stringify(['甲', '乙']), JSON.stringify(result.blanks));
    check('简答题写入 textarea', result.textarea === '简答文本', JSON.stringify(result.textarea));
    check('简答题同步写隐藏域 #answer1005', result.a1005 === '简答文本', JSON.stringify(result.a1005));

    // 逐题报告 qid 与判定值，失败时能直接看出卡在哪一题，而不是只拿到一个 false
    var detail = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'return {docOk: !!app._resolveQuizAnswerDocument(null),' +
      'items: qs.map(function(q){return {type:q.type, qid:app._getQuestionIdFromElement(q._element),' +
      'value:app._getQuizQuestionFilledValue(null, q)};})};})()'
    );
    var allItemsOk = detail && detail.docOk && detail.items.every(function (i) { return i.qid && i.value; });
    check('每题都能取到 qid 与已填值', allItemsOk, JSON.stringify(detail));

    var allFilled = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'return app._areQuizAnswersFilled(null, qs, {});})()'
    );
    check('_areQuizAnswersFilled 判定全部已填', allFilled === true, String(allFilled));
  }
});

/**
 * ---- 2a. 模型返回 401：跳过本轮，但不进 45 秒退避 ----
 *
 * 这条补的是"看代码得出的结论"和"真实行为"之间的那道缝：
 * content.js 早就认得 401（不重试、不写 apiConnectionFailed），
 * 但 page.js 拿回 `{permanentError:true}` 之后**根本没读这个字段**，
 * 一律走 `_markQuizApiConnectionFailed` → 45 秒退避。
 * 于是"Key 填错了"在用户眼里变成"网络连不上、插件每隔 45 秒卡一下"，
 * 而服务商明明把 "Invalid API key" 原话返回来了。
 */
SCENARIOS.push({
  name: '模型 401：不退避、不当成网络故障',
  path: '/quiz',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };
    // 两处配置都要喂：storage 是 content.js 发请求用的凭据，configs 是 page.js 的开关
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    var before = ctx.mock.requests.length;
    ctx.mock.setStatus(401);
    await ctx.client.evaluate(
      'window._xxtApp._quizApiFailUntil = 0; window._xxtApp._quizApiLastError = "";' +
      'window._xxtApp._quizForceSkipUntil = 0; window._xxtApp._handleQuiz(null); true'
    );

    // 两个条件都等到：只看请求数会在页面状态落地前就断言，只看状态会在请求还没发出时就断言
    var asked = 0;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      asked = ctx.mock.requests.length - before;
      var settled = await ctx.client.evaluate(
        'String(window._xxtApp._quizApiLastError || "").length > 0 || window._xxtApp._quizApiFailUntil > 0'
      );
      if (asked >= 1 && settled) break;
      await sleep(300);
    }

    check('401 确实发了请求（配置是通的，是接口拒绝了）', asked >= 1, '请求数 +' + asked);
    check('401 只发 1 次（永久错误不该重试）', asked === 1, '实际 ' + asked + ' 次');

    var st = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;return {' +
      'unavailable:a._isQuizApiUnavailable(), failUntil:a._quizApiFailUntil,' +
      'lastError:String(a._quizApiLastError||"").slice(0,160),' +
      'skipUntil:a._quizForceSkipUntil, inProgress:a._quizInProgress};})()'
    );
    // 这条是本次修复的核心：**没有** 45 秒退避窗口
    check('401 不进 45 秒退避（不再被当成"网络连不上"）',
      st.unavailable === false && !st.failUntil, JSON.stringify(st));
    check('服务商原话留在页面上（用户能看出是 Key 错了）',
      /401|Invalid API key/i.test(st.lastError), st.lastError);
    check('本轮答题被跳过，且没卡在 _quizInProgress',
      st.inProgress === false && st.skipUntil > Date.now(), JSON.stringify(st));

    ctx.mock.setStatus(0);
  }
});

/** ---- 2b. 多选题：连写字母 / 单字母 / 重试下限 / 幂等点击 ---- */
SCENARIOS.push({
  name: '多选题：连写字母 / 单字母 / 重试下限',
  path: '/quiz',
  run: async function (ctx) {
    // 用户报的「多选题有时只选一个、然后卡住」有三条根因，这里逐条锁住：
    //   ① 弹题那条路没有 "AC" → ["A","C"] 的拆分 → 一个选项都匹配不上（"一直选不对"）
    //   ② 重试排序的目标规模被 canonical.length 带成 1 → 永远只试"选一项"的组合
    //   ③ 复选被点两次 = 开关两次 = 抵消 → 少选一项
    // 断言全部盯**最终 DOM 里真的选了几项**，不看中间调用了什么 ——
    // 断言实现细节会把自己绑死，而且实现一改就误报。
    var info = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'var mq=null;for(var i=0;i<qs.length;i++){if(qs[i].type==="multiple"){mq=qs[i];}}' +
      'if(!mq) return {found:false};window.__mq=mq;' +
      'var qid=app._getQuestionIdFromElement(mq._element);' +
      'return {found:true,qid:qid,options:mq.options.length,min:app._getMultiChoiceMinSelections(mq._element)};})()'
    );
    check('fixture 里找得到多选题', info && info.found === true, JSON.stringify(info));
    if (!info || !info.found) return;
    check('题干标着「多选题」→ 最少选 2 项', info.min === 2, JSON.stringify(info));

    // ① + ③ 连写 "AC" 必须拆开填进去，而且最终真的选中两项
    var r1 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var el=window.__mq._element;' +
      'var qid=app._getQuestionIdFromElement(el);' +
      'var clicked=app._applyChoiceAnswer(el,"AC","multiple");' +
      'var hidden=document.getElementById("answer"+qid);' +
      'var marked=[];var badges=document.querySelectorAll(".choice"+qid);' +
      'for(var i=0;i<badges.length;i++){if(badges[i].classList.contains("check_answer_dx"))marked.push(String(badges[i].getAttribute("data")));}' +
      'var checked=[];var ins=el.querySelectorAll("input[type=checkbox]");' +
      'for(var j=0;j<ins.length;j++){if(ins[j].checked)checked.push(ins[j].value);}' +
      'return {clicked:clicked,hidden:hidden?hidden.value:null,marked:marked.sort(),checked:checked.sort()};})()'
    );
    check('连写答案 "AC" 被拆成两项并全部点上',
      r1 && r1.clicked === 2 && JSON.stringify(r1.checked) === '["A","C"]', JSON.stringify(r1));
    check('隐藏域写的是两项的并集（不是只剩最后一项）',
      r1 && r1.hidden === 'AC', JSON.stringify(r1 && r1.hidden));
    check('两个选项徽标都带勾选态（复选没有被点两次抵消）',
      r1 && JSON.stringify(r1.marked) === '["A","C"]', JSON.stringify(r1 && r1.marked));

    // 幂等：同样的答案再填一遍，结果不能反过来变成"取消"
    var r2 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var el=window.__mq._element;' +
      'var qid=app._getQuestionIdFromElement(el);' +
      'app._fillMultiChoice(el,["A","C"]);' +
      'app._fillMultiChoice(el,["A","C"]);' +
      'var hidden=document.getElementById("answer"+qid);' +
      'return {hidden:hidden?hidden.value:null};})()'
    );
    check('重复填同一答案不会把已选项切掉（幂等）', r2 && r2.hidden === 'AC', JSON.stringify(r2));

    // ② 模型只给一个字母时：**先按原答案填，不凭空补一项**。
    // 用户实测：多选**只选一个照样能提交成功** —— 说明补选不是平台约束。
    // 1.1.5 加它是为了"分散重试"（见 CHANGELOG 1.1.5 成因 2），
    // 但第一次就补 = 造一个模型没给的答案，那正是判错的一个来源。
    var beforeReq = ctx.mock.requests.length;
    var r3 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var el=window.__mq._element;' +
      'var qid=app._getQuestionIdFromElement(el);' +
      'app._clearMultiChoiceSelection(el);' +
      'var values=app._normalizeChoiceAnswerValues("B","multiple",el);' +
      'app._fillMultiChoice(el,"B");' +
      'var hidden=document.getElementById("answer"+qid);' +
      'return {values:values,hidden:hidden?hidden.value:null};})()'
    );
    check('新鲜的单个字母答案 → **原样使用**（不凭空补第二项）',
      r3 && r3.values.length === 1 && r3.values[0] === 'B', JSON.stringify(r3));
    check('原样填进 DOM（只填一项，不造答案）',
      r3 && r3.hidden === 'B', JSON.stringify(r3));
    check('本地处理不发任何模型请求（零 token）', ctx.mock.requests.length === beforeReq,
      '多发了 ' + (ctx.mock.requests.length - beforeReq) + ' 次');

    // ②b 只有**已经判错过**的单项组合才补选 —— 否则重试只会原地打转（1.1.5 要治的就是这个）
    // ⚠️ 用**自己的合成题**（qid 99101），不要把错误缓存写进 window.__mq ——
    // 上一版就是那么写的，结果污染了后面共用 __mq 的 ⑥「错够阈值」测试（实测撞坏过）。
    var r3b = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var box=document.createElement("div");' +
      'box.innerHTML="<div class=\'TiMu\'><span class=\'newZy_TItle\'>多选题</span>" +' +
      '"<ul class=\'Zy_ulTop\'>" +' +
      '["A","B","C","D"].map(function(L,i){var t=["甲","乙","丙","丁"][i];' +
      'return "<li class=\'before-after\' qid=\'99101\' data=\'"+L+"\'><label>" +' +
      '"<input type=\'checkbox\' value=\'"+L+"\'>" +' +
      '"<span class=\'num_option num_option_dx choice99101\' data=\'"+L+"\'>"+L+"</span>" +' +
      '"<span class=\'fl after\'>"+t+"</span></label></li>";}).join("") +' +
      '"</ul><input type=\'hidden\' id=\'answer99101\' value=\'\'></div>";' +
      'document.body.appendChild(box);' +
      'var el=box.firstChild;' +
      'var q={index:98,type:"multiple",title:"多选题",options:["甲","乙","丙","丁"],_element:el};' +
      'var loaded=app._loadQuizCorrectAnswerCache(null);' +
      'app._addWrongQuizAnswer(loaded.data,{qid:"99101",' +
      'titleKey:app._getQuizTitleKeyFromElement(el,q.title),answer:"B",type:"multiple",canonical:"B"});' +
      'app._saveQuizCorrectAnswerCache(null,loaded.data);' +
      'var v=app._normalizeChoiceAnswerValues("B","multiple",el);' +
      'return {min:app._getMultiChoiceMinSelections(el),join:Array.isArray(v)?v.join(""):String(v)};})()'
    );
    check('已判错的单项组合 → 才补成两项（让重试换组合）',
      r3b && r3b.min === 2 && r3b.join.length >= 2 && r3b.join.indexOf('B') !== -1, JSON.stringify(r3b));

    // ④ 重试下限：已知 "C" 是错的，下一个候选不能又是"只选一项"
    var r4 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=window.__mq;var el=q._element;' +
      'var loaded=app._loadQuizCorrectAnswerCache(null);' +
      'app._addWrongQuizAnswer(loaded.data,{qid:app._getQuestionIdFromElement(el),' +
      'titleKey:app._getQuizTitleKeyFromElement(el,q.title),answer:"C",type:"multiple",canonical:"C"});' +
      'app._saveQuizCorrectAnswerCache(null,loaded.data);' +
      'var next=app._avoidKnownWrongAnswer("C","multiple",q,null);' +
      'return {join:Array.isArray(next)?next.join(""):String(next)};})()'
    );
    check('多选题重试不会再给"只选一项"的组合',
      r4 && r4.join.length >= 2 && r4.join !== 'C', JSON.stringify(r4));

    // ④b 上面那条还不足以锁住"目标规模下限" —— 它同时被"低于最少项数的组合排最后"兜着，
    // 所以把下限改回 preferredSize||2 也可能照样通过（实测过：改回去那条仍然绿）。
    // 这里造一个**没有题型名**的复选题：此时 min=1，排序不再帮忙，
    // 唯一挡住"退回只选一项"的就是目标规模下限本身。
    var r4b = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var box=document.createElement("div");' +
      'box.innerHTML="<div class=\'TiMu\'>" +' +
      '"<span>下列说法正确的有</span>" +' +
      '"<ul class=\'Zy_ulTop\'>" +' +
      '["A","B","C","D"].map(function(L,i){var t=["甲","乙","丙","丁"][i];' +
      'return "<li class=\'before-after\' qid=\'99001\' data=\'"+L+"\'><label>" +' +
      '"<input type=\'checkbox\' value=\'"+L+"\'>" +' +
      '"<span class=\'num_option num_option_dx choice99001\' data=\'"+L+"\'>"+L+"</span>" +' +
      '"<span class=\'fl after\'>"+t+"</span></label></li>";}).join("") +' +
      '"</ul><input type=\'hidden\' id=\'answer99001\' value=\'\'></div>";' +
      'document.body.appendChild(box);' +
      'var el=box.firstChild;' +
      'var q={index:9,type:"multiple",title:"下列说法正确的有",options:["甲","乙","丙","丁"],_element:el};' +
      'var loaded=app._loadQuizCorrectAnswerCache(null);' +
      'app._addWrongQuizAnswer(loaded.data,{qid:"99001",' +
      'titleKey:app._getQuizTitleKeyFromElement(el,q.title),answer:"C",type:"multiple",canonical:"C"});' +
      'app._saveQuizCorrectAnswerCache(null,loaded.data);' +
      'var next=app._avoidKnownWrongAnswer("C","multiple",q,null);' +
      'return {min:app._getMultiChoiceMinSelections(el),' +
      'join:Array.isArray(next)?next.join(""):String(next)};})()'
    );
    check('没有题型名时 min 回落 1（不硬套"最少两项"，免得误伤不定项）',
      r4b && r4b.min === 1, JSON.stringify(r4b));
    check('即便 min=1，重试也不会退回"只选一项"（靠的是目标规模下限 2）',
      r4b && r4b.join.length >= 2 && r4b.join !== 'C', JSON.stringify(r4b));

    // ④c 补选必须避开**已判错的组合**。
    // 现场真实故障（用户报「作业页反复重交」）：模型答 "A" —— "A" 本身没判错过，
    // 本地把它补成 "AB"，而 "AB" **已经判错过**。补选原先不看禁选列表，
    // 于是每轮都补出同一个错答案：补成 AB → 判错 → AB 进禁选 → 模型仍答 A → 又补成 AB …
    // 无限循环。这里只把 "AB" 记成错的，"A" 保持干净，专门锁这一条。
    var r4c = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=window.__mq;var el=q._element;' +
      'var loaded=app._loadQuizCorrectAnswerCache(null);' +
      'app._addWrongQuizAnswer(loaded.data,{qid:app._getQuestionIdFromElement(el),' +
      'titleKey:app._getQuizTitleKeyFromElement(el,q.title),answer:"AB",type:"multiple",canonical:"AB"});' +
      'app._saveQuizCorrectAnswerCache(null,loaded.data);' +
      'var v=app._normalizeChoiceAnswerValues("A","multiple",el);' +
      'return {join:Array.isArray(v)?v.join(""):String(v)};})()'
    );
    check('补选会避开已判错的组合（否则会反复补出同一个错答案 → 反复重交）',
      r4c && r4c.join !== 'AB' && r4c.join.indexOf('A') !== -1, JSON.stringify(r4c));

    // ④d 提交超时诊断：必须能**区分**「还没判分」和「已判分」两种页面。
    // 否则超时日志只会说一句"等超时了"，到底缺哪道条件（重做文案 / 判分痕迹 / 控件已禁用）
    // 还得靠猜 —— 现场「作业页反复重交」就是卡在这一段、而当时查不出原因。
    var diag = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var d=app._describeQuizResultPage(null);' +
      'return {controls:d.controls,enabled:d.controlsEnabled,grade:d.gradeSelector,gradeText:d.gradeText};})()'
    );
    check('提交超时诊断能报出「还有可交互控件」= 尚未判分',
      diag && diag.controls > 0 && diag.enabled > 0, JSON.stringify(diag));

    // ④e 多选必须按**字母序**点选。
    // 点选顺序决定平台隐藏域 #answer{qid} 的内容，而本文件对多选答案的规范形式
    //（`_canonicalQuizAnswer`）是排序过的。模型给乱序时若按原序点，
    // 隐藏域会写成 "CA" 而不是 "AC" —— 平台按字符串比对就判错。
    // 现场实测（用户日志）：`answer field 405907427 value= DBAC`（点选是 A→B→C→D），
    // 表现是"顺序碰巧对时能过、不对就判错重交"，也就是用户说的"时灵时不灵"。
    var r4e = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=window.__mq;var el=q._element;' +
      'app._clearMultiChoiceSelection(el);' +
      'var v=app._normalizeChoiceAnswerValues(["C","A"],"multiple",el);' +
      'app._applyChoiceAnswer(el,["C","A"],"multiple","checkbox");' +
      'var hidden=document.getElementById("answer"+app._getQuestionIdFromElement(el));' +
      'return {values:Array.isArray(v)?v.join(""):String(v),hidden:hidden?hidden.value:null};})()'
    );
    check('多选答案按字母序返回（乱序输入 ["C","A"] → "AC"）',
      r4e && r4e.values === 'AC', JSON.stringify(r4e));

    // ④f 静默拒绝：提交后表单被**清空**（不带「请重做」那类文案）也要认出来并把答案记错。
    // 现场：用户看到"提交闪了一下框、回到题目、选项全没了、反复重交"。
    // 四个 _rememberWrongQuizAnswers 调用点原先全都挂在文案条件上 —— 静默拒绝一个都不命中，
    // 于是答案不进错误缓存，下一轮原样再填，死循环。
    var r4f = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var el=document.querySelector(".TiMu");' +
      'var qid=app._getQuestionIdFromElement(el);' +
      'var h=document.getElementById("answer"+qid);' +
      'if(!h) return {skip:"这道题没有隐藏域"};' +
      'var q={index:0,type:"single",title:"",options:[],_element:el};' +
      // 自带前置：先写上（模拟我们填过），再清空（模拟平台重置）——
      // 不依赖前面测试留下的状态，否则前置一变这条就成了"假跳过"。
      'h.value="A";' +
      'app._quizCurrentQuestions=[q];' +
      'h.value="";' +
      'Array.from(el.querySelectorAll("input")).forEach(function(ip){ip.checked=false;});' +
      'app._quizSubmitPending=true;' +
      'app._quizSubmitStartedAt=Date.now()-5000;' +   // 已过 2 秒判定门槛
      'var held=app._monitorQuizSubmit(null);' +
      'return {held:held,pending:app._quizSubmitPending,' +
      '  wrongs:app._getKnownWrongQuizAnswers(q,null).length};})()'
    );
    check('提交后被清空 → 结束等待（不再当成"还在等结果"）',
      r4f && r4f.held === false && r4f.pending === false, JSON.stringify(r4f));

    // ④g 提交抓包必须**完全穿透**：钩子装上之后，普通 XHR 仍要能正常跑完。
    // 钩子在这里抛一个错会废掉整页 AJAX —— 比原 bug 严重得多，所以这条必须守住。
    var r4g = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var app=window._xxtApp;' +
      'try{app._installSubmitSniffer();}catch(e){}' +
      'var x=new XMLHttpRequest();' +
      // ⚠️ URL 必须**命中钩子的关键词**（work/submit/exam/homework/answer）——
      // 第一版用的是 /__sniffer_probe__，不含关键词，钩子那条分支压根没跑到，
      // 等于没测到真正有风险的路（反向验证也抓不住：注入的抛错根本不会触发）。
      'x.open("GET","/__work_probe__");' +   // mock 对未知路径回 404，重点是**能跑完**
      'x.onloadend=function(){res({status:x.status,done:true});};' +
      'x.onerror=function(){res({status:-1,done:false});};' +
      'try{x.send();}catch(e2){res({threw:String(e2&&e2.message)});}' +
      '});})()'
    );
    check('装了提交抓包之后普通 XHR 仍能跑完（钩子完全穿透，不废页面）',
      r4g && r4g.done === true, JSON.stringify(r4g));

    // ⑦ 乱选模式：不接 AI、本地随机作答。
    // 这是给「不想配 API Key」的用户用的，所以三条性质必须守住：
    //   ① 不再判定「API 不可用」—— 否则会走 _skipQuizForApiUnavailable 把整道题跳过，
    //      变成「什么都不答」而不是「乱选」；
    //   ② 生成的答案形状要能被下游直接使用（数量对齐、判断题是 true/false）；
    //   ③ **绝不写答案记忆** —— 随机答案不是结论，写进去会污染将来的 AI 模式。
    var r7 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:true, apiKey:""});' +
      'var qs=app._extractQuestions(null);' +
      'var ans=app._buildRandomQuizAnswers(qs);' +
      'return {reason:app._getQuizApiUnavailableReason(), isRandom:app._isRandomAnswerMode(),' +
      '  qCount:qs.length, count:ans.length, types:qs.map(function(q){return q.type;}),' +
      '  ans:ans.map(function(a){return Array.isArray(a)?a.join(""):String(a);})};})()'
    );
    check('乱选模式下不再判定「API 不可用」（否则会跳过整道题而不是乱选）',
      r7 && r7.reason === '' && r7.isRandom === true, JSON.stringify(r7));
    check('乱选生成的答案数量与题数一致', r7 && r7.count === r7.qCount && r7.qCount > 0, JSON.stringify(r7));
    check('乱选答案形状合法（判断题 true/false，其余非空）',
      r7 && r7.ans.every(function (a) { return a === 'true' || a === 'false' || (a && a !== 'undefined'); }),
      JSON.stringify(r7 && r7.ans));

    // ⚠️ 这里断言的是**「连缓存都不读」**，不是「返回 0」。
    // 第一版写的是 `_rememberWrongQuizAnswers(null) === 0` —— 反向验证发现它分辨不了：
    // 测试环境里本来就没有"可记的错误答案"，加不加守卫都返回 0。
    // 改成监听 `_loadQuizCorrectAnswerCache`：带守卫时函数**直接短路**、一次都不读。
    var r7b = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var reads=0; var orig=app._loadQuizCorrectAnswerCache;' +
      'app._loadQuizCorrectAnswerCache=function(){reads++;return orig.apply(app,arguments);};' +
      'app._rememberWrongQuizAnswers(null);' +
      'app._rememberCorrectQuizAnswers(null);' +
      'app._loadQuizCorrectAnswerCache=orig;' +
      'return {reads:reads};})()'
    );
    check('乱选模式完全不碰答案缓存（两个函数都短路，一次都不读）',
      r7b && r7b.reads === 0, JSON.stringify(r7b));

    // 恢复默认，避免影响后面的断言（测试之间共用 configs 这个可变状态）
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {randomAnswer:false}); return true;})()'
    );
    var r7c = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {isRandom:app._isRandomAnswerMode()};})()'
    );
    check('关掉乱选后恢复 AI 路径（回归：不能把开关粘住）',
      r7c && r7c.isRandom === false, JSON.stringify(r7c));

    // ⑦b 乱选必须**真的随机**，不能永远同一个答案。
    // 这条不是洁癖：本项目现场就踩过「一直选 D」，用户报了好几轮。
    // 一个叫"乱选"却永远选 A 的功能，等于把那个 bug 原样搬过来。
    var r7d = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:true, apiKey:""});' +
      'var qs=[{index:0,type:"single",title:"",options:["甲","乙","丙","丁"]}];' +
      'var seen={}; for(var i=0;i<60;i++){seen[app._buildRandomQuizAnswers(qs)[0]]=1;}' +
      'return {distinct:Object.keys(seen).length, keys:Object.keys(seen).sort().join("")};})()'
    );
    check('乱选真的随机（60 次至少出现 2 种不同答案）',
      r7d && r7d.distinct >= 2, JSON.stringify(r7d));

    // ⑦c 乱选**优先于 AI**：即使配了 key 也走本地生成、不发请求
    var r7e = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:true, apiKey:"sk-假的"});' +
      'return {reason:app._getQuizApiUnavailableReason(), isRandom:app._isRandomAnswerMode()};})()'
    );
    check('乱选优先于 AI：配了 key 也走本地生成',
      r7e && r7e.reason === '' && r7e.isRandom === true, JSON.stringify(r7e));

    // ⑦d enableQuiz 关掉时乱选也不生效 —— 语义上「关掉答题」= 完全不答题，
    //     不能被乱选绕过（否则用户关了答题却发现还在交卷，会很困惑）。
    var r7f = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:false, randomAnswer:true, apiKey:""});' +
      'return {isRandom:app._isRandomAnswerMode(), reason:app._getQuizApiUnavailableReason()};})()'
    );
    check('enableQuiz 关掉时乱选也不生效（关掉答题 = 完全不答题）',
      r7f && r7f.isRandom === false && r7f.reason === 'api-disabled', JSON.stringify(r7f));

    // 收尾：把 configs 恢复成进来时的样子（enableQuiz 也要还原，别只还原 randomAnswer）
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:false}); return true;})()'
    );
    // ⚠️ 这里**故意不**再断言「不把答案记错」。写过一条，反向验证发现它不可能失败：
    // 表单被清空时本来就**没有已填答案可记**，那次 `_rememberWrongQuizAnswers` 是空操作，
    // 加不加它 `wrongs` 都是 0 —— 断言分辨不了，留着就是假的检查。
    // （真要判「被拒绝」，得先证明失败与答案有关 —— 而用户实测恰恰证明无关。）
    // ⚠️ 这里**故意不**断言隐藏域的值。`_clickOptionItem` 写隐藏域时两条路都排过序
    //（有徽标按 .choice{qid} 的 DOM 顺序累加、无徽标显式 picked.sort()），
    // 所以「乱序输入 → 隐藏域是字母序」永远为真 —— 加了就是一条不可能失败的检查。
    // 真实平台上那个 DBAC 既不是点击顺序也不是字母序，说明**有人在我们之后重写了它**，
    // 那是平台自己的 handler，不是这条断言能覆盖的。要查它得看那条写入日志。

    // ⑤ 不定项：允许单选，别被上面的规则误伤（题型名判定必须区分这两者）
    var r5 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var box=document.createElement("div");' +
      'box.innerHTML="<span class=\'newZy_TItle\'>不定项选择题</span>";' +
      'var v=app._normalizeChoiceAnswerValues("B","multiple",box);' +
      'return {min:app._getMultiChoiceMinSelections(box),values:v};})()'
    );
    check('不定项选择题不扩成两项（单选也是正确答案）',
      r5 && r5.min === 1 && JSON.stringify(r5.values) === '["B"]', JSON.stringify(r5));

    // ⑥ 连续答错到阈值 → 放弃继续折腾，但**必须把题填上**：
    //    章节小测的提交前置是"每题都有值"，空着就永远交不出去 —— 那才是真正的卡住。
    var r6 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var q=window.__mq;var el=q._element;' +
      'var before=app._isQuizQuestionBestEffort(q,null);' +
      'var loaded=app._loadQuizCorrectAnswerCache(null);' +
      '["AB","AC","AD"].forEach(function(a){' +
      'app._addWrongQuizAnswer(loaded.data,{qid:app._getQuestionIdFromElement(el),' +
      'titleKey:app._getQuizTitleKeyFromElement(el,q.title),answer:a,type:"multiple",canonical:a});});' +
      'app._saveQuizCorrectAnswerCache(null,loaded.data);' +
      'var after=app._isQuizQuestionBestEffort(q,null);' +
      'var filled=app._fillBestEffortQuizAnswers(app._extractQuestions(null),null);' +
      'return {before:before,after:after,filled:filled,' +
      'value:app._getQuizQuestionFilledValue(null,q)};})()'
    );
    check('错够阈值前不放弃', r6 && r6.before === false, JSON.stringify(r6));
    check('错够阈值后判定为"放弃继续折腾"', r6 && r6.after === true, JSON.stringify(r6));
    check('放弃后仍把题填上（表单不满就永远交不出去）', r6 && !!r6.value, JSON.stringify(r6));
  }
});

/** ---- 3. 记住正确答案（批改结果页） ---- */
SCENARIOS.push({
  name: '记住正确答案（批改结果页）',
  path: '/quiz-result',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var n=document.querySelectorAll(".TiMu");' +
      'return {count:n.length,' +
      'rightMarked:app._isQuizQuestionMarkedCorrect(n[0]),' +
      'wrongMarked:app._isQuizQuestionMarkedCorrect(n[1]),' +
      'rightAnswer:app._extractDisplayedCorrectAnswer(n[0])};})()'
    );
    check('识别到 2 道批改结果题', probe.count === 2, JSON.stringify(probe));
    check('答对题判定为正确（.fr.dui）', probe.rightMarked === true, JSON.stringify(probe));
    check('答错题判定为不正确（.fr.cuo，保守不误记）', probe.wrongMarked === false, JSON.stringify(probe));
    check('从 .Py_answer 解析出正确答案 A', probe.rightAnswer === 'A', JSON.stringify(probe.rightAnswer));

    var cached = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._rememberCorrectQuizAnswers(null);' +
      'var qs=app._extractQuestions(null);' +
      'var c=app._getCachedQuizAnswer(qs[0], null);' +
      'var w=app._getCachedQuizAnswer(qs[1], null);' +
      'return {right:c?{answer:c.answer,type:c.type}:null, wrong:c?!!w:false};})()'
    );
    check('正确题写入答案缓存并可读回', !!(cached && cached.right && cached.right.answer === 'A'),
      JSON.stringify(cached));
    check('答错题未被写入缓存', cached && cached.wrong === false, JSON.stringify(cached));
  }
});

/** ---- 10. 学习通任务类型识别（视频 / 音频 / 文档 / 图片 / 测验 / 投票） ---- */
SCENARIOS.push({
  name: '任务类型识别',
  path: '/blank',
  run: async function (ctx) {
    // 真实模块名取自一次全课程扫描的任务点统计：
    // insertimage / insertvideo / insertdoc / insertaudio / work / insertbbs / insertvote
    var cases = [
      { module: 'insertvideo', expect: 'video', label: '视频任务点 → video' },
      { module: 'insertaudio', expect: 'video', label: '音频任务点 → video（复用媒体流程）' },
      { module: 'insertdoc', expect: 'read', label: '文档任务点 → read' },
      { module: 'insertimage', expect: 'read', label: '图片任务点 → read' },
      { module: 'work', expect: 'quiz', label: '测验任务点 → quiz' },
      { module: '', type: 'ppt', expect: 'read', label: '按扩展名 ppt → read' },
      { module: '', type: 'mp3', expect: 'video', label: '按扩展名 mp3 → video' },
      { module: 'insertvote', expect: null, label: '投票（不支持，须返回 null 而不是乱猜）' }
    ];

    var results = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var cases=' +
      JSON.stringify(cases.map(function (c) { return { module: c.module, type: c.type }; })) + ';' +
      'return cases.map(function(c){' +
      'var att={job:true,name:"测试任务点",property:{module:c.module,type:c.type}};' +
      'var job=app._buildAttachmentOnlyJob(att);' +
      'return {kind: job?job.kind:null, isJob: app._getAttachmentWorkType(att)};});})()'
    );

    cases.forEach(function (c, i) {
      var got = results[i];
      check(c.label, got && got.kind === c.expect, JSON.stringify(got));
    });

    // 图片在没有 job 标记时不应被"推断"成任务点（否则会去处理一堆纯展示图片）
    var inferred = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {' +
      'image: app._getAttachmentWorkType({property:{module:"insertimage"}}),' +
      'audio: app._getAttachmentWorkType({property:{module:"insertaudio"}}),' +
      'video: app._getAttachmentWorkType({property:{module:"insertvideo"}})};})()'
    );
    check('图片无 job 标记时不推断为任务点（避免处理展示图）',
      inferred.image === 'not-job', JSON.stringify(inferred));
    check('音频无 job 标记时推断为任务点', inferred.audio === 'job', JSON.stringify(inferred));
    check('视频无 job 标记时推断为任务点', inferred.video === 'job', JSON.stringify(inferred));

    // ---- 显式 job:false = 老师没把它设为任务点 → 必须跳过，且**不能**落到模块名推断
    // 判据来自 cxmooc-tools 的 CxTask：`if (taskinfo.job) done=false; else done=true;`
    var notJob = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return ["insertvideo","insertdoc","insertaudio","work","insertimage"].map(function(m){' +
      'var att={job:false, name:"非任务点", property:{module:m}};' +
      'return {module:m, workType:app._getAttachmentWorkType(att),' +
      'built: app._buildAttachmentOnlyJob(att)?1:0};});})()'
    );
    notJob.forEach(function (row) {
      check('job:false 的 ' + row.module + ' 视为非任务点',
        row.workType === 'not-job', JSON.stringify(row));
      check('job:false 的 ' + row.module + ' 不会被构造成待办任务',
        row.built === 0, JSON.stringify(row));
    });

    var stringFalse = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return {workType: app._getAttachmentWorkType({job:"false", property:{module:"insertvideo"}}),' +
      'built: app._buildAttachmentOnlyJob({job:"false", property:{module:"insertvideo"}})?1:0};})()'
    );
    check('job 写成字符串 "false" 同样跳过',
      stringFalse.workType === 'not-job' && stringFalse.built === 0, JSON.stringify(stringFalse));

    // 反向：job:true 必须仍然是任务点（别把正常判据改坏）
    var explicitTrue = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var att={job:true, name:"任务点", property:{module:"insertvideo"}};' +
      'return {workType:app._getAttachmentWorkType(att), kind:(app._buildAttachmentOnlyJob(att)||{}).kind};})()'
    );
    check('job:true 的附件仍是任务点且能构造出待办',
      explicitTrue.workType === 'job' && explicitTrue.kind === 'video', JSON.stringify(explicitTrue));

    // 已通过的任务点：job 与 isPassed 同时为真时必须优先返回 finished，
    // 否则调用点看到 'job' 就直接开跑 —— 已经完成的任务点被重做一遍（长视频尤其致命）
    var passed = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {' +
      'video: app._getAttachmentWorkType({job:true, isPassed:true, property:{module:"insertvideo"}}),' +
      'doc: app._getAttachmentWorkType({job:true, isPassed:true, property:{module:"insertdoc"}})};})()'
    );
    check('已通过的任务点优先判为 finished（不会被重做一遍）',
      passed.video === 'finished' && passed.doc === 'finished', JSON.stringify(passed));

    // 不支持的类型必须留下可查的日志，而不是静默丢弃
    var logged = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;app._unsupportedJobLogged=null;' +
      'app._buildAttachmentOnlyJob({job:true,property:{module:"insertvote"}});' +
      'return app._unsupportedJobLogged;})(window._xxtApp)'
    ).catch(function () { return null; });
    check('不支持的 task point 会被记录（便于排查"任务点没做"）',
      !!(logged && logged['insertvote|']), JSON.stringify(logged));
  }
});

/** ---- 11. 视频：倍速 / 静音 / seek 到结尾 ---- */
SCENARIOS.push({
  name: '视频倍速 / 静音 / seek',
  path: '/media',
  // 用原型打桩让 video 元素"像"一个有 100 秒时长的可播放视频，
  // 这样就不依赖真实编解码器，测的是插件的逻辑而不是浏览器的解码能力
  beforeInject: function () {
    return [
      '(function(){',
      '  Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: function(){ return 100; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: function(){ return false; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: function(){ return 4; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {',
      '    configurable: true, get: function(){ return this.__ct || 0; }, set: function(v){ this.__ct = v; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "playbackRate", {',
      '    configurable: true, get: function(){ return this.__rate == null ? 1 : this.__rate; },',
      '    set: function(v){ this.__rate = v; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "muted", {',
      '    configurable: true, get: function(){ return !!this.__muted; }, set: function(v){ this.__muted = v; } });',
      '  HTMLMediaElement.prototype.play = function(){ this.__played = (this.__played||0)+1; return Promise.resolve(); };',
      '  HTMLMediaElement.prototype.load = function(){};',
      '  window.__patched = true;',
      '})()'
    ].join('\n');
  },
  run: async function (ctx) {
    var patched = await ctx.client.evaluate('window.__patched === true');
    check('媒体元素打桩生效', patched === true);

    var rate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{playbackRate:1.5,autoMaxPlaybackRate:false,muted:true,audioMuted:true,enableSeek:true});' +
      'var v=document.getElementById("omitone-video");' +
      'app._ensurePlaybackRate(v,"e2e");' +
      'return {rateApplied:v.playbackRate, muted:v.muted, target:app._getTargetPlaybackRate()};})()'
    );
    check('倍速按配置应用（1.5x）', rate.rateApplied === 1.5, JSON.stringify(rate));
    check('静音按配置应用', rate.muted === true, JSON.stringify(rate.muted));
    check('_getTargetPlaybackRate 返回配置值', rate.target === 1.5, String(rate.target));

    // 自动最大倍速：打桩的播放器没有倍速菜单，探测路径会回落到配置值，不应抛异常
    var autoResult = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{autoMaxPlaybackRate:true,playbackRateCap:2});' +
      'var v=document.getElementById("omitone-video");' +
      'app._ensurePlaybackRate(v,"e2e-auto");' +
      'var r=v.playbackRate;' +
      'return {rate:r, capped:r<=2};})()'
    );
    check('自动倍速路径不抛异常且不超过上限', autoResult && autoResult.capped === true, JSON.stringify(autoResult));

    var seek = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableSeek:true,autoMaxPlaybackRate:false,playbackRate:1});' +
      // 上一步的自动倍速测试可能把倍速探测置为进行中，而 _trySeekToEnd 在探测期间会主动让路
      'app._rateProbing=false; app._rateDetectBusy=false; app._captchaActive=false;' +
      'app._seekTriedKeys=null;' +
      'var v=document.getElementById("omitone-video");' +
      'v.__ct=0;' +
      'var ok=app._trySeekToEnd(v,"e2e");' +
      'return {ok:ok, ct:v.__ct||0, key:app._getMediaSeekKey(v), probing:app._rateProbing};})()'
    );
    check('seek 到 duration-3s（100 → 97）', seek.ct === 97, JSON.stringify(seek));

    var seekOff = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableSeek:false});' +
      'app._seekTriedKeys=null;' +
      'var v=document.getElementById("omitone-video");' +
      'v.__ct=0;' +
      'app._trySeekToEnd(v,"e2e-off");' +
      'return {ct:v.__ct||0};})()'
    );
    check('关闭 enableSeek 后不再 seek', seekOff.ct === 0, JSON.stringify(seekOff));

    // ---- 音频任务点：隐藏的 <audio> 也要能被找到
    // （1.0.7 的根因就是可见性过滤把隐藏 audio 全滤掉了，音频任务点直接判 media not ready）
    var audio = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var v=document.getElementById("omitone-video");' +
      'var a=document.getElementById("omitone-audio");' +
      'var onlyAudio=app._pickMedia([a]);' +
      'var both=app._pickMedia([v,a]);' +
      // 注意 _findMediaInDocument 返回的是**单个元素**（找不到为 null），不是数组
      'var found=app._findMediaInDocument(document,0);' +
      'return {audioHidden: !app._isVisibleMedia(a),' +
      'pickedFromAudioOnly: onlyAudio?onlyAudio.id:null,' +
      'pickedFromBoth: both?both.id:null,' +
      'foundInDoc: found?found.id:null};})()'
    );
    check('隐藏的 audio 被判定为不可见', audio.audioHidden === true, JSON.stringify(audio));
    check('只有隐藏 audio 时能回退选中它（音频任务点关键路径）',
      audio.pickedFromAudioOnly === 'omitone-audio', JSON.stringify(audio));
    check('同时存在可见视频时优先选视频', audio.pickedFromBoth === 'omitone-video', JSON.stringify(audio));
    check('_findMediaInDocument 能在文档里找到媒体元素（返回单个元素）',
      audio.foundInDoc === 'omitone-video', JSON.stringify(audio));

    // 音频任务点应走静音 + 配置倍速（不看自动最大倍速菜单）
    var audioRate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{audioMuted:true,playbackRate:2,autoMaxPlaybackRate:false,muted:false});' +
      'var a=document.getElementById("omitone-audio");' +
      'app._ensurePlaybackRate(a,"e2e-audio");' +
      'return {rate:a.playbackRate, muted:a.muted};})()'
    );
    check('音频应用配置倍速（2x）', audioRate.rate === 2, JSON.stringify(audioRate));
    check('音频按 audioMuted 静音播放', audioRate.muted === true, JSON.stringify(audioRate));

    // ---- 进度快照：整个"做不完就放弃"机制的安全阀
    // 静止的媒体 → 快照恒定 → 才允许判"卡住"；推进中的媒体 → 快照变化 → 绝不判卡住
    var snap = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var v=document.getElementById("omitone-video");' +
      'var keep=v.__ct;' +
      'v.__ct=0; var s1=app._taskProgressSnapshot({doc: document});' +
      'v.__ct=42; var s2=app._taskProgressSnapshot({doc: document});' +
      'v.__ct=42.7; var s3=app._taskProgressSnapshot({doc: document});' +
      'v.__ct=keep;' +
      'return {s1:s1, s2:s2, s3:s3};})()'
    );
    check('有媒体时快照反映播放进度（静止与推进可区分）',
      snap.s1 === 'media:0' && snap.s2 === 'media:42', JSON.stringify(snap));
    check('快照只看整秒（亚秒抖动不会被误当成"有进展"）',
      snap.s3 === 'media:42', JSON.stringify(snap.s3));

    // ---- ended 事件 与 _finishCurrentMedia 必须完全等价。
    // 这两处原来各写了一份收尾逻辑，并且**已经分叉**：_handleVideoEnded 会顺手清掉
    // 文档任务点的状态。现在统一走 _finishCurrentMedia，下面两条断言就是"别再分叉"的锁。
    var viaEnded = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'function snap(){return {playing:app._isPlaying, managed:app._activeMediaJobManaged,' +
      'pending:app._activeMediaJobPending, videoEl:!!app._videoEl};}' +
      'var v=document.getElementById("omitone-video");' +
      'app._isPlaying=true; app._activeMediaJobManaged=true; app._activeMediaJobPending=true;' +
      'app._videoEl=v;' +
      'app._finishCurrentMedia("test"); var a=snap();' +
      'app._isPlaying=true; app._activeMediaJobManaged=true; app._activeMediaJobPending=true;' +
      'app._videoEl=v;' +
      'app._handleVideoEnded(); var b=snap();' +
      'return {viaFinish:a, viaEnded:b};})()'
    );
    check('ended 事件与 _finishCurrentMedia 收尾结果一致（两条路不许再分叉）',
      JSON.stringify(viaEnded.viaFinish) === JSON.stringify(viaEnded.viaEnded),
      JSON.stringify(viaEnded));

    // 非托管路径 + 关掉 autoNext：nextUnit() 会**提前返回**、不做全量 reset，
    // 这正是两条路唯一会分叉的场景。旧实现在这里会把文档任务点状态一起清掉，
    // 等于放弃一个可能正在进行的文档任务点（静默漏做）—— 必须锁住"不动文档状态"。
    var unmanaged = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var saved=app.configs.autoNext;' +
      'function snap(){return {docManaged:app._activeDocumentJobManaged,' +
      'docPending:app._activeDocumentJobPending, docDoc:!!app._activeDocumentJobDoc,' +
      'playing:app._isPlaying, pending:app._activeMediaJobPending};}' +
      'function setup(){app.configs=Object.assign({},app.configs,{autoNext:false});' +
      'app._isPlaying=true; app._activeMediaJobManaged=false; app._activeMediaJobPending=true;' +
      'app._activeDocumentJobManaged=true; app._activeDocumentJobPending=true;' +
      'app._activeDocumentJobDoc=document;}' +
      'setup(); app._finishCurrentMedia("test"); var a=snap();' +
      'setup(); app._handleVideoEnded(); var b=snap();' +
      'app.configs=Object.assign({},app.configs,{autoNext:saved});' +
      'return {viaFinish:a, viaEnded:b};})()'
    );
    check('非托管路径两条路结果一致',
      JSON.stringify(unmanaged.viaFinish) === JSON.stringify(unmanaged.viaEnded),
      JSON.stringify(unmanaged));
    check('关掉 autoNext 时不清文档任务点状态（避免静默漏做）',
      unmanaged.viaEnded.docManaged === true && unmanaged.viaEnded.pending === false,
      JSON.stringify(unmanaged.viaEnded));
  }
});

/** ---- 4. 验证码：弹窗形态识别 ---- */
SCENARIOS.push({
  name: '验证码弹窗识别',
  path: '/captcha-dialog',
  run: async function (ctx) {
    // ⚠️ 各场景共用同一个 chrome.storage，上一个场景写进去的 config 会泄漏到这里。
    // 所以每个场景都要显式声明自己需要的那几项配置。
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, {enableCaptcha: true}); true'
    );

    // 先等验证码图解码完成：检测逻辑会看图片尺寸，data-URI 图片解码是异步的，
    // 上一步就绪就调用会因为拿到 0 尺寸而漏判（而且结果会被节流缓存 1.5 秒）。
    await waitFor(ctx.client,
      '(function(){var i=document.getElementById("imgVerCode");return !!(i&&i.complete&&i.naturalWidth>0);})()', 8000);
    // 清掉节流缓存，确保这一次是真实检测而不是复用上一轮结果
    await ctx.client.evaluate(
      'window._xxtApp._captchaLastCheckAt=0; window._xxtApp._captchaLastResult=null; true'
    );

    var found = await ctx.client.evaluate('!!window._xxtApp._checkCaptchaDialog()');
    check('_checkCaptchaDialog 命中 #imgVerCode + #ucode 弹窗', found === true, String(found));

    var cleaned = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {' +
      'quoted:app._cleanCaptchaCode(\'"aB3d"\'),' +
      'multiLine:app._cleanCaptchaCode("识别结果：\\n  X7k2  \\n"),' +
      'punct:app._cleanCaptchaCode("A,B.C-D"),' +
      'long:app._cleanCaptchaCode("abcdefghijklmnopqrstuvwxyz")};})()'
    );
    check('验证码清洗：去掉引号', cleaned.quoted === 'aB3d', JSON.stringify(cleaned.quoted));
    check('验证码清洗：取最后一行并去空白', cleaned.multiLine === 'X7k2', JSON.stringify(cleaned.multiLine));
    check('验证码清洗：去标点', cleaned.punct === 'ABCD', JSON.stringify(cleaned.punct));
    check('验证码清洗：截断到 12 字符', cleaned.long.length <= 12, JSON.stringify(cleaned.long));
  }
});

/** ---- 5. 验证码：独立网址形态识别 ---- */
SCENARIOS.push({
  name: '独立验证码页识别',
  path: '/captcha-verify',
  run: async function (ctx) {
    var isCaptcha = await ctx.client.evaluate('!!window._xxtApp._isStandaloneCaptchaPage()');
    check('_isStandaloneCaptchaPage 判定为验证码页', isCaptcha === true, String(isCaptcha));

    var detected = await ctx.client.evaluate(
      '(function(){var c=window._xxtApp._detectStandaloneCaptcha();' +
      'return c ? {hasImg:!!c.img, hasInput:!!c.input} : null;})()'
    );
    check('能抓到验证码图片与输入框', !!(detected && detected.hasImg && detected.hasInput),
      JSON.stringify(detected));
  }
});

/** ---- 6. 弹窗题识别 ---- */
SCENARIOS.push({
  name: '弹窗题识别',
  path: '/popup-quiz',
  run: async function (ctx) {
    var node = await ctx.client.evaluate(
      '(function(){var n=window._xxtApp._checkPopupQuiz();' +
      'return n ? {cls:String(n.className||""), text:String(n.innerText||"").slice(0,60)} : null;})()'
    );
    check('_checkPopupQuiz 命中 .ans-pop-quiz', !!node, JSON.stringify(node));
    check('识别到的弹窗含题目文本', !!(node && node.text.indexOf('说法') !== -1), JSON.stringify(node));
  }
});

/** ---- 6b. 视频弹题：原生结构能抠到选项 ---- */
SCENARIOS.push({
  name: '视频弹题选项识别（原生结构）',
  path: '/popup-quiz-native',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var n=app._checkPopupQuiz();' +
      'if(!n) return {found:false};' +
      'var items=app._getOptionItems(n);' +
      'return {found:true,' +
      'count:items.length,' +
      'texts:items.map(function(i){return app._extractOptionText(i);}),' +
      'letters:items.map(function(i,k){return app._inferOptionLetter(i,k);})};})()'
    );
    check('原生结构弹题能被识别为弹窗', probe.found === true, JSON.stringify(probe));
    check('抠到 3 个选项', probe.count === 3, JSON.stringify(probe));
    check('选项文本已剥掉 A./B./C. 前缀',
      JSON.stringify(probe.texts) === JSON.stringify(['说法甲', '说法乙', '说法丙']),
      JSON.stringify(probe.texts));
    check('每个选项都能推断出字母 A/B/C',
      JSON.stringify(probe.letters) === JSON.stringify(['A', 'B', 'C']),
      JSON.stringify(probe.letters));
  }
});

/** ---- 6c. 视频弹题：完整往返（模型答题 → 选中选项） ---- */
SCENARIOS.push({
  name: '视频弹题答题往返',
  path: '/popup-quiz-native',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    var before = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var n=window._xxtApp._checkPopupQuiz();' +
      'window.__pqNode = n; return window._xxtApp._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    check('弹题已发到模型接口', ctx.mock.requests.length > before,
      '请求数 +' + (ctx.mock.requests.length - before));

    var filled = await ctx.client.evaluate(
      '(function(){var ins=document.querySelectorAll(\'.ans-pop-quiz input[type="radio"]\');' +
      'var checked=[];for(var i=0;i<ins.length;i++){if(ins[i].checked) checked.push(ins[i].value);}' +
      'return {checked:checked};})()'
    );
    check('模型答 A → A 选项真的被选中',
      JSON.stringify(filled.checked) === JSON.stringify(['A']), JSON.stringify(filled));

    // 站点往往是异步收走弹窗的：这段时间里 tick 还会再看到它，
    // 不能因为"还在"就把同一道题再问一遍模型（不然弹题就是个烧钱循环）
    var after = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var n=window._xxtApp._activePopupBlock();' +
      'if(n){window._xxtApp._handlePopupQuiz(n);} return !n;})()'
    );
    await sleep(1500);
    check('已答过的弹窗不再重复问模型',
      ctx.mock.requests.length === after, '又发了 ' + (ctx.mock.requests.length - after) + ' 次');

    // ---- 答错重试必须告诉模型「上次那个是错的」 ----
    // 不带禁选列表的话，每轮重试都是**一模一样的请求**，模型自然每轮都回同一个答案 ——
    // 真实表现就是「答错之后一直选 D」，重试等于白问。
    // 这里模拟「填了、但弹窗没被平台收走」，再问一次，看提示词里有没有禁选段。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._popupQuizSolvedKey="";app._popupQuizSolvedAt=0;' +
      'app._popupQuizBlockedUntil=0;app._popupQuizAttempts=1;' +
      'return true;})()'
    );
    var beforeRetry = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var n=app._checkPopupQuiz()||window.__pqNode;' +
      'return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    var retryPrompt = ctx.mock.requests.length > beforeRetry
      ? ctx.mock.requests[ctx.mock.requests.length - 1].prompt : '';
    check('答错重试时提示词带上禁选项（否则模型每轮都回同一个答案）',
      /禁:1=/.test(retryPrompt),
      '重试请求数 +' + (ctx.mock.requests.length - beforeRetry) + ' · 提示词尾部: ' + retryPrompt.slice(-100));

    // ---- 四个选项的弹题 ----
    // 现场报过「四个选项的题一直选 D，三个选项的正常」，而现有 mock 只有 3 个选项 ——
    // 这个盲区正好盖住那个问题。这里往同一个弹窗补第 4 个选项，验证选项数不影响匹配：
    // 选项必须按 A/B/C/D **完整且不错位**地出现在提示词里，否则模型给的字母就会对到错的选项。
    await ctx.client.evaluate(
      '(function(){var ul=document.querySelector(".ans-pop-quiz .pop-quiz-options");' +
      'var li=document.createElement("li");li.className="pop-quiz-option";' +
      'li.innerHTML=\'<input type="radio" name="pq" value="D"><span>D. 说法丁</span>\';' +
      'ul.appendChild(li);' +
      'var ins=document.querySelectorAll(".ans-pop-quiz input[type=radio]");' +
      'for(var i=0;i<ins.length;i++){ins[i].checked=false;}' +
      'return ul.children.length;})()'
    );
    await sleep(300);

    var beforeFour = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._popupQuizSolvedKey="";app._popupQuizSolvedAt=0;app._popupQuizBlockedUntil=0;' +
      'app._popupQuizAttempts=0;app._popupQuizWrongAnswers=[];app._popupQuizLastFilled="";' +
      'var n=app._checkPopupQuiz();return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    var fourPrompt = ctx.mock.requests.length > beforeFour
      ? ctx.mock.requests[ctx.mock.requests.length - 1].prompt : '';
    var iA = fourPrompt.indexOf('\nA.');
    var iB = fourPrompt.indexOf('\nB.');
    var iC = fourPrompt.indexOf('\nC.');
    var iD = fourPrompt.indexOf('\nD.');
    check('四选项弹题：提示词按 A/B/C/D 完整且按序列出（错位会选错选项）',
      iA !== -1 && iB > iA && iC > iB && iD > iC,
      'A=' + iA + ' B=' + iB + ' C=' + iC + ' D=' + iD);

    var fourFilled = await ctx.client.evaluate(
      '(function(){var ins=document.querySelectorAll(".ans-pop-quiz input[type=radio]");' +
      'var checked=[];for(var i=0;i<ins.length;i++){if(ins[i].checked) checked.push(ins[i].value);}' +
      'return {checked:checked, count:ins.length};})()'
    );
    check('四选项弹题：模型答 A → 选中的就是 A（不是最后一个 D）',
      JSON.stringify(fourFilled.checked) === JSON.stringify(['A']), JSON.stringify(fourFilled));

    // ---- 站点重绘不该导致「重问-重填」死循环（现场表现：选项一直闪）----
    // 指纹取的是**选项文本**，而站点答完会重绘弹窗（给正确项打勾 / 加提示 / 重排）——
    // 文本一变指纹就变，「已答放行」立刻失效，弹窗被当成新题 → 再问模型 → 再点一次选项
    // → 站点再重绘 …… 死循环。而且指纹一变 attempts 就重置，安全阀永远触发不了。
    // 这里先正常答一次（建立已答状态 + 静默期），再模拟一次站点重绘，断言不会重问。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._popupQuizQuietUntil=0;app._popupQuizBlockedUntil=0;app._popupQuizAttempts=0;' +
      'var n=app._checkPopupQuiz();' +
      'if(!n) return false;' +
      'return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    // 模拟站点重绘：往第一个选项的文字前面插一个勾
    await ctx.client.evaluate(
      '(function(){var s=document.querySelector(".ans-pop-quiz .pop-quiz-options span");' +
      'if(s) s.textContent = "✓ " + s.textContent;' +
      'return s ? s.textContent.slice(0, 20) : null;})()'
    );
    await sleep(200);

    var beforeRedraw = ctx.mock.requests.length;
    var redrawBlock = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      // ⚠️ 必须走**完整路径**：_activePopupBlock 只是"要不要拦"的判断，
      // 真正去问模型的是 _handlePopupQuiz。只调前者的话，断言永远不可能失败
      // —— 第一版就是这么写的，反向验证直接抓出来了。
      'var n=app._activePopupBlock();' +
      'if(n){app._handlePopupQuiz(n);}' +
      'return !!n;})()'
    );
    await sleep(2500);
    check('站点重绘弹窗后不会立刻重问模型（否则选项会一直闪）',
      ctx.mock.requests.length === beforeRedraw,
      '重绘后又发了 ' + (ctx.mock.requests.length - beforeRedraw) + ' 次请求 · 仍被当成活动弹窗=' + redrawBlock);

    // ---- 五个选项的【多选题】 ----
    // 现场报过「遇到五个选项的多选题」。多选与单选不只是选项数不同：
    // 控件是 checkbox、答案是**多个字母**（模型回 ["A","C"]），走的是另一条填充分支。
    await ctx.client.evaluate(
      '(function(){' +
      'var box=document.querySelector(".ans-pop-quiz");' +
      'var ul=box.querySelector(".pop-quiz-options");' +
      'ul.innerHTML="";' +
      'var texts=["A. 说法甲","B. 说法乙","C. 说法丙","D. 说法丁","E. 说法戊"];' +
      'for(var i=0;i<texts.length;i++){' +
      '  var li=document.createElement("li");li.className="pop-quiz-option";' +
      '  var inp=document.createElement("input");inp.type="checkbox";inp.name="pq";' +
      '  inp.value=String.fromCharCode(65+i);' +
      '  var sp=document.createElement("span");sp.textContent=texts[i];' +
      '  li.appendChild(inp);li.appendChild(sp);ul.appendChild(li);}' +
      'var t=box.querySelector(".pop-quiz-title");if(t)t.textContent="1. 下列哪些说法正确？（多选）";' +
      'return ul.children.length;})()'
    );
    await sleep(300);

    var beforeMulti = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._popupQuizQuietUntil=0;app._popupQuizBlockedUntil=0;app._popupQuizAttempts=0;' +
      'app._popupQuizSolvedKey="";app._popupQuizSolvedAt=0;' +
      'var n=app._checkPopupQuiz(); if(!n) return false; return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    var multiPrompt = ctx.mock.requests.length > beforeMulti
      ? ctx.mock.requests[ctx.mock.requests.length - 1].prompt : '';
    var multiType = (multiPrompt.match(/\|\s*([a-z])\s*\|/) || [])[1];
    check('五选项多选题：题型代号是 m，且 5 个选项都进了提示词',
      multiType === 'm' && multiPrompt.indexOf('\nE.') !== -1,
      '题型=' + multiType + ' · 尾部: ' + multiPrompt.slice(-90));

    var multiFilled = await ctx.client.evaluate(
      '(function(){var ins=document.querySelectorAll(".ans-pop-quiz input[type=checkbox]");' +
      'var checked=[];for(var i=0;i<ins.length;i++){if(ins[i].checked) checked.push(ins[i].value);}' +
      'return {checked:checked, count:ins.length};})()'
    );
    check('五选项多选题：模型回 ["A","C"] → 勾中的就是 A 和 C',
      JSON.stringify(multiFilled.checked) === JSON.stringify(['A', 'C']), JSON.stringify(multiFilled));

    // ---- 答错之后必须能自己恢复（现场报的「视频里的题答完就卡住、等几秒没后续」）----
    // 根因：填完答案后设了**两个**窗口 —— 静默期 8 秒 + 「已答放行」30 秒。
    // `_activePopupBlock()` 在后者内一直返回 null，于是答错之后有 22 秒处于
    // "静默期已过、却仍被当成已答"的没人管空档，弹窗挂着没人重试。
    // 更隐蔽的一处：`_handleVideoPause` 也用同一个函数判断"有没有弹窗"，
    // 于是那 22 秒还会去抢恢复被站点**有意暂停**的视频，两边对打。
    // 这里不真等，直接把时间戳往回拨来模拟"静默期已经过去"。
    const retryState = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var n=app._checkPopupQuiz(); if(!n) return {noPopup:true};' +
      'function seed(){' +
      '  app._popupQuizBlockedUntil=0;' +
      '  var k=app._popupQuizFingerprint(n);' +
      // 模拟"刚答完这道题、平台还没接受"
      '  app._popupQuizKey=k; app._popupQuizAttempts=1; app._popupQuizLastFilled="A";' +
      '  app._popupQuizSolvedKey=k; app._popupQuizSolvedAt=Date.now();' +
      // 8000 与 page.js 的 POPUP_QUIZ_QUIET_MS 对应
      '  app._popupQuizQuietUntil=Date.now()+8000;' +
      '  app._popupBlockCheckedAt=0; app._popupBlockCached=null;}' +
      'function snap(){return {active:!!app._activePopupBlock(), blocks:!!app._popupQuizBlocksPlayback()};}' +
      'seed(); var duringQuiet=snap();' +
      // 把静默期推到过去：弹窗仍在，说明平台没接受上一个答案 → 必须重新可处理
      'app._popupQuizQuietUntil=Date.now()-1; app._popupQuizSolvedAt=Date.now()-8002;' +
      'app._popupBlockCheckedAt=0; app._popupBlockCached=null;' +
      'var afterQuiet=snap();' +
      // 进入放弃窗口：这道题已经决定不管了，就不该再拦着恢复播放
      'app._popupQuizBlockedUntil=Date.now()+60000;' +
      'var afterGiveUp=snap(); app._popupQuizBlockedUntil=0;' +
      'return {duringQuiet:duringQuiet, afterQuiet:afterQuiet, afterGiveUp:afterGiveUp};})()'
    );
    check('静默期内不重复处理弹题，但仍算「挡着播放」（否则会去抢恢复被站点暂停的视频）',
      !retryState.noPopup && retryState.duringQuiet.active === false && retryState.duringQuiet.blocks === true,
      JSON.stringify(retryState));
    check('静默期一过必须重新可处理同一道题（否则就是「答完弹窗卡住、再也不重试」）',
      !retryState.noPopup && retryState.afterQuiet.active === true,
      JSON.stringify(retryState));
    check('进入放弃窗口后不再拦住恢复播放',
      !retryState.noPopup && retryState.afterGiveUp.blocks === false,
      JSON.stringify(retryState));
  }
});

/** ---- 6c-2. 视频里的填空题弹窗（没有选项，只有输入框） ---- */
SCENARIOS.push({
  name: '视频填空题弹窗',
  path: '/popup-quiz-blank',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    var type = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var n=app._checkPopupQuiz();' +
      'if(!n) return null;' +
      'return {type:app._detectPopupQuizType(n, app._getOptionItems(n))};})()'
    );
    check('无选项的输入框弹窗判为填空题', type && type.type === 'fill', JSON.stringify(type));

    await ctx.client.evaluate(
      '(function(){var n=window._xxtApp._activePopupBlock();' +
      'if(n) return window._xxtApp._handlePopupQuiz(n); return false;})()'
    );
    await sleep(2500);

    var vals = await ctx.client.evaluate(
      '(function(){var g=function(id){var e=document.getElementById(id);return e?e.value:null;};' +
      'return {b1:g("blank1"), b2:g("blank2")};})()'
    );
    check('填空弹窗两个空分别填 甲 / 乙',
      vals.b1 === '甲' && vals.b2 === '乙', JSON.stringify(vals));
  }
});

/** ---- 6d. 弹题答不上来时不无限空转 ---- */
SCENARIOS.push({
  name: '弹题反复失败会放弃而不是死循环',
  path: '/popup-quiz-native',
  run: async function (ctx) {
    // 制造"选项一个都匹配不上"的极端情况：让 _matchOptionItem 恒定返回 null。
    // 这正是真实站点上的失败形态 —— 弹窗结构不认识，AI 答了但填不进去。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._popupQuizKey="";app._popupQuizAttempts=0;app._popupQuizBlockedUntil=0;' +
      'app._popupQuizSolvedKey="";app._popupQuizSolvedAt=0;' +
      'app._matchOptionItem=function(){return null;};' +
      'var ins=document.querySelectorAll(\'.ans-pop-quiz input[type="radio"]\');' +
      'for(var j=0;j<ins.length;j++){ins[j].checked=false;}' +
      'return true;})()'
    );

    var before = ctx.mock.requests.length;
    for (var round = 0; round < 8; round++) {
      await ctx.client.evaluate(
        '(function(){var n=window._xxtApp._activePopupBlock();' +
        'if(!n) return false; return window._xxtApp._handlePopupQuiz(n);})()'
      );
      // ⚠️ 复现真实站点的形态：答错后弹窗里会**多出一行反馈文本**。
      // 原来的 mock 弹窗文本恒定不变，所以"指纹随反馈变化 → 尝试计数被重置成 1
      // → 永远到不了放弃阈值"这个 bug **测不出来**（真实站点会一直重问模型）。
      // 这行就是让 mock 跟上真实平台的关键。
      await ctx.client.evaluate(
        '(function(){var d=document.createElement("div");d.className="pop-quiz-feedback";' +
        'd.textContent="回答错误，请重新作答";' +
        'document.querySelector(".ans-pop-quiz").appendChild(d);return true;})()'
      );
      await sleep(300);
    }
    var asked = ctx.mock.requests.length - before;

    var state = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {attempts:app._popupQuizAttempts,' +
      'blocked: Date.now() < (app._popupQuizBlockedUntil||0)};})()'
    );
    check('失败后不再无限发请求（<=3 次）', asked <= 3, '实际发起了 ' + asked + ' 次');
    check('放弃后 _activePopupBlock 不再拦截后续刷课', state.blocked === true, JSON.stringify(state));
  }
});

/** ---- 6e. 播放器右下角的「继续学习」必须被点掉 ---- */
SCENARIOS.push({
  name: '继续学习提示',
  path: '/video-continue',
  run: async function (ctx) {
    var hit = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var b=app._findContinueStudyButton();' +
      'return b ? {cls:String(b.className||""), text:String(b.textContent||"").trim(),' +
      'tag:String(b.tagName||"").toLowerCase()} : null;})()'
    );
    check('定位到「继续学习」按钮', !!(hit && hit.text === '继续学习'), JSON.stringify(hit));
    check('命中的是按钮本身而不是外层浮层',
      !!(hit && hit.cls === 'btn-continue'), JSON.stringify(hit));

    // 反向验证：按钮不带任何"像按钮"的类名时也必须命中它，而不是命中包着它的浮层
    // （站点把 onclick 挂在按钮上，点到外层容器是没反应的）
    var plain = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var s=document.querySelector(".btn-continue");' +
      'var keep=s.className; s.className="";' +
      'var b=app._findContinueStudyButton();' +
      'var r={cls:String(b&&b.className||""), tag:String(b&&b.tagName||"").toLowerCase(),' +
      'text:String(b&&b.textContent||"").trim()};' +
      's.className=keep; return r;})()'
    );
    check('按钮去掉类名后仍命中的是按钮（不是外层浮层）',
      plain.text === '继续学习' && plain.tag === 'span', JSON.stringify(plain));

    var clickInfo = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._continueStudyAt=0;app._continueStudyScanAt=0;app._continueStudyBlockedUntil=0;' +
      'app._continueStudyKey="";app._continueStudyClicks=0;' +
      'var first=app._tryContinueStudyPrompt();' +
      'var second=app._tryContinueStudyPrompt();' + // 3 秒节流，紧接着的这一次必须被挡住
      'return {first:first, second:second, clicked:window.__clicked||0};})()'
    );
    check('点了一次「继续学习」', clickInfo.clicked === 1, JSON.stringify(clickInfo));
    check('同一按钮 3 秒内不重复点', clickInfo.first === true && clickInfo.second === false,
      JSON.stringify(clickInfo));

    // 点了没反应（按钮还在）→ 连点到上限后必须停手，不能变成新的空转源
    var guard = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var r=[];' +
      'for(var i=0;i<8;i++){app._continueStudyAt=0;app._continueStudyScanAt=0;' +
      'r.push(app._tryContinueStudyPrompt());}' +
      'return {results:r, clicked:window.__clicked||0,' +
      'blocked: Date.now() < (app._continueStudyBlockedUntil||0)};})()'
    );
    check('点不动的按钮连点到上限后会停手',
      guard.blocked === true && guard.clicked <= 6, JSON.stringify(guard));

    // 扫描节流：全文档遍历不能每 250ms 一轮地跑
    var throttled = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;app._continueStudyBlockedUntil=0;' +
      'app._continueStudyAt=0;app._continueStudyScanAt=Date.now();' +
      'var again=app._tryContinueStudyPrompt();' +
      'var scanAt=app._continueStudyScanAt;return {again:again, kept:scanAt>0};})()'
    );
    check('扫描有节流（刚扫过就不再重复遍历全文档）',
      throttled.again === false, JSON.stringify(throttled));
  }
});

/** ---- 7. 讨论区识别与控件定位 ---- */
SCENARIOS.push({
  name: '讨论区识别',
  path: '/discussion',
  run: async function (ctx) {
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, {enableDiscussion:true}); true'
    );

    var ctxInfo = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;return {' +
      'isPage:!!app._isDiscussionPage(),' +
      'hasEditor:!!app._findDiscussionEditor(),' +
      'hasSubmit:!!app._findDiscussionSubmitButton()};})()'
    );
    check('_isDiscussionPage 判定为讨论页', ctxInfo.isPage === true, JSON.stringify(ctxInfo));
    check('定位到回复编辑框（.replyEdit textarea）', ctxInfo.hasEditor === true, JSON.stringify(ctxInfo));

    var submit = await ctx.client.evaluate(
      '(function(){var b=window._xxtApp._findDiscussionSubmitButton();' +
      'return b?String(b.className||""):null;})()'
    );
    check('定位到提交按钮且不是同名"展开"按钮（须为 .addReply）',
      !!submit && submit.indexOf('addReply') !== -1, JSON.stringify(submit));

    var offInfo = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableDiscussion:false});' +
      'app._discussionPageAt=0; app._discussionPageResult=false;' +
      'return {isPage:!!app._isDiscussionPage()};})()'
    );
    check('关闭 enableDiscussion 后不再识别为讨论页', offInfo.isPage === false, JSON.stringify(offInfo));
  }
});

/** ---- 8. 扫不到题时的诊断 ---- */
SCENARIOS.push({
  name: '扫不到题的诊断',
  path: '/weird',
  run: async function (ctx) {
    var count = await ctx.client.evaluate('window._xxtApp._extractQuestions(null).length');
    check('陌生结构抠到 0 题', count === 0, '实际 ' + count);

    var diag = await ctx.client.evaluate('JSON.stringify(window._xxtApp._diagnoseQuestionScan(null))');
    var parsed = null;
    try { parsed = JSON.parse(diag); } catch (e) {}
    check('诊断报告可序列化', !!parsed, String(diag).slice(0, 150));
    if (!parsed) return;

    check('诊断报告给出定位线索（hint 非空）', !!parsed.hint, JSON.stringify(parsed.hint));
    check('诊断报告记录了扫描过的文档', Array.isArray(parsed.docs) && parsed.docs.length > 0,
      'docs=' + (parsed.docs ? parsed.docs.length : 'n/a'));
    check('诊断报告记录了可见输入框数量', parsed.docs.some(function (d) { return d.inputs > 0; }),
      JSON.stringify(parsed.docs.map(function (d) { return d.inputs; })));

    var scan = await ctx.client.evaluate('!!(window.xxtAI && typeof window.xxtAI.scanQuiz === "function" && typeof window.xxtAI.diagnose === "function")');
    check('xxtAI.scanQuiz / xxtAI.diagnose 可用', scan === true);
  }
});

/** ---- 12. 设置弹窗（扩展自身页面，零依赖加载 + 纯逻辑） ---- */
SCENARIOS.push({
  name: '设置弹窗',
  url: 'chrome-extension://{EXT}/popup/popup.html',
  inject: false,
  run: async function (ctx) {
    var apiLoaded = await ctx.client.evaluate('!!(window.OmitoneApiUrl || (self && self.OmitoneApiUrl))');
    check('libs/api-url.js 加载成功（popup.html 的 script 顺序正确）', apiLoaded === true);

    var urls = await ctx.client.evaluate(
      '(function(){var A=self.OmitoneApiUrl;return {' +
      'openaiDefault: A.buildOpenAICompatibleUrl(""),' +
      'openaiCustom: A.buildOpenAICompatibleUrl("https://api.deepseek.com"),' +
      'openaiAlreadyFull: A.buildOpenAICompatibleUrl("https://api.x.com/v1/chat/completions"),' +
      'claude: A.buildClaudeApiUrl("https://api.anthropic.com"),' +
      'gemini: A.buildGeminiApiUrl("https://generativelanguage.googleapis.com","gemini-2.5-flash","K1")};})()'
    );
    check('OpenAI 兼容地址：空值回落默认',
      urls.openaiDefault === 'https://api.minimaxi.com/v1/chat/completions', JSON.stringify(urls.openaiDefault));
    check('OpenAI 兼容地址：自动补 /v1/chat/completions',
      urls.openaiCustom === 'https://api.deepseek.com/v1/chat/completions', JSON.stringify(urls.openaiCustom));
    check('OpenAI 兼容地址：已是完整路径则不重复拼接',
      urls.openaiAlreadyFull === 'https://api.x.com/v1/chat/completions', JSON.stringify(urls.openaiAlreadyFull));
    check('Claude 地址：补 /v1/messages',
      urls.claude === 'https://api.anthropic.com/v1/messages', JSON.stringify(urls.claude));
    check('Gemini 地址：带 model 与 key',
      urls.gemini.indexOf('generateContent') !== -1 && urls.gemini.indexOf('key=K1') !== -1,
      JSON.stringify(urls.gemini));

    // 密钥清洗必须剥掉 Bearer 前缀与粘贴时带的引号 —— 这正是两个实现分叉过的地方
    var keys = await ctx.client.evaluate(
      '(function(){var A=self.OmitoneApiUrl;return {' +
      'bearer: A.normalizeApiKey("Bearer sk-abc"),' +
      'quoted: A.normalizeApiKey("\\"sk-abc\\""),' +
      'spaced: A.normalizeApiKey("  sk-abc  "),' +
      'both: A.normalizeApiKey("Bearer \\"sk-abc\\"")};})()'
    );
    check('密钥清洗：剥 Bearer 前缀', keys.bearer === 'sk-abc', JSON.stringify(keys.bearer));
    check('密钥清洗：剥粘贴引号（分叉过的行为，现在两边一致）',
      keys.quoted === 'sk-abc', JSON.stringify(keys.quoted));
    check('密钥清洗：去首尾空白', keys.spaced === 'sk-abc', JSON.stringify(keys.spaced));
    check('密钥清洗：Bearer + 引号同时剥掉', keys.both === 'sk-abc', JSON.stringify(keys.both));

    // popup 自身的初始化（load()）必须跑完并把表单填上
    var ui = await ctx.client.evaluate(
      '(function(){return {' +
      'rateVal: document.getElementById("rateVal") ? document.getElementById("rateVal").textContent : null,' +
      'presetValues: Array.prototype.map.call(document.getElementById("providerPreset").options, function(o){return o.value;}),' +
      'presetLabels: Array.prototype.map.call(document.getElementById("providerPreset").options, function(o){return String(o.textContent);}),' +
      'presetSelected: document.getElementById("providerPreset").value,' +
      'thinkingValues: Array.prototype.map.call(document.getElementById("thinkingLevel").options, function(o){return o.value;}),' +
      'thinkingSelected: document.getElementById("thinkingLevel").value,' +
      'thinkingHint: document.getElementById("thinkingHint") ? document.getElementById("thinkingHint").textContent : null,' +
      'apiUrl: document.getElementById("apiUrl").value,' +
      'model: document.getElementById("model").value,' +
      'toggleCount: document.querySelectorAll(".toggle").length,' +
      'hasStart: !!document.getElementById("start")};})()'
    );
    check('弹窗初始化完成（速度档显示已填充）', !!(ui.rateVal && ui.rateVal.indexOf('x') !== -1), JSON.stringify(ui.rateVal));
    // 预置清单：1.1.5 起按需求加了 Kimi 与通义，所以这里不再要求"只剩 4 个"，
    // 改成钉住**这一份确定的白名单** —— 目的是防止以后又悄悄塞回一堆没实测的厂商
    // （历史上内置过 9 家，模型名全是钉死的快照，用户照着填完发现用不了）。
    check('接入方式就是这份白名单（不许再悄悄加没实测的厂商）',
      JSON.stringify(ui.presetValues) === JSON.stringify(['deepseek', 'kimi', 'qwen', 'claude', 'gemini', 'custom-openai']),
      JSON.stringify(ui.presetValues));
    // 未实测的厂商必须在界面上**如实标注**，否则用户会以为它们和 DeepSeek 一样验证过
    check('只有 DeepSeek 标"实测"，其余明标"未实测"',
      ui.presetLabels[0].indexOf('实测') !== -1 && ui.presetLabels[0].indexOf('未实测') === -1 &&
      ['kimi', 'qwen', 'claude', 'gemini'].every(function (v) {
        var i = ui.presetValues.indexOf(v);
        return i !== -1 && ui.presetLabels[i].indexOf('未实测') !== -1;
      }),
      JSON.stringify(ui.presetLabels));

    // ---- 思考强度：三档 + 默认关闭 + 说明跟着渠道变 ----
    // 这一段盯的是"用户看到的"和"实际发出去的"必须一致：
    // 同一个"关闭"，DeepSeek 会发 thinking:{type:disabled}、Kimi 什么都不发（K3 关不掉）。
    // 不把这个差别摊开给用户看，他会以为"我关了思考它却没关"是 bug。
    check('思考强度只有三档，顺序是 关闭/低/高',
      JSON.stringify(ui.thinkingValues) === JSON.stringify(['off', 'low', 'high']),
      JSON.stringify(ui.thinkingValues));
    check('思考强度默认是「关闭」（升级前的行为）', ui.thinkingSelected === 'off', String(ui.thinkingSelected));
    // ⚠️ 不能直接断言"说明里是 DeepSeek 的参数"：这个场景与其它场景共用 chrome.storage，
    // 前面答过题的场景已经把 apiUrl 写成 mock 地址了，那时渠道是"认不出"→ 说明是"不发参数"。
    // 所以这里**显式**把表单设成 DeepSeek 再刷新说明（只改表单、不派发 input，
    // 免得多写一次 storage 影响后面的场景）。
    var deepseekHint = await ctx.client.evaluate(
      '(function(){' +
      'document.getElementById("apiUrl").value="https://api.deepseek.com";' +
      'document.getElementById("model").value="deepseek-v4-flash";' +
      'var tl=document.getElementById("thinkingLevel");tl.value="off";' +
      'updateThinkingHint();' +
      'var h=document.getElementById("thinkingHint").textContent;' +
      'tl.value="low";updateThinkingHint();' +
      'var h2=document.getElementById("thinkingHint").textContent;' +
      'tl.value="off";updateThinkingHint();' +
      'return {off:h,low:h2};})()'
    );
    check('说明里摊开了 DeepSeek 关闭档**实际会发**的参数（不是只说"关了"）',
      !!deepseekHint.off && deepseekHint.off.indexOf('当前实际发送') !== -1 &&
      deepseekHint.off.indexOf('"type":"disabled"') !== -1 &&
      deepseekHint.off.indexOf('已实测') !== -1,
      String(deepseekHint.off).slice(-140));
    check('切到"低"档后说明随之变化（含 reasoning_effort，且标为未验证）',
      !!deepseekHint.low && deepseekHint.low.indexOf('reasoning_effort') !== -1 &&
      deepseekHint.low.indexOf('未验证') !== -1,
      String(deepseekHint.low).slice(-140));

    // 换渠道 → 说明必须跟着换（Kimi 关闭档"不发参数"）
    var kimi = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var sel=document.getElementById("providerPreset");sel.value="kimi";' +
      'sel.dispatchEvent(new Event("change"));' +
      'setTimeout(function(){' +
      'var h=document.getElementById("thinkingHint");' +
      'res({hint:h?h.textContent:null,url:document.getElementById("apiUrl").value,' +
      'model:document.getElementById("model").value});},400);});})()'
    );
    check('切到 Kimi 后预设地址/模型名被填入',
      kimi.url.indexOf('moonshot') !== -1 && kimi.model === 'kimi-k3', JSON.stringify(kimi));
    check('切到 Kimi 后说明变成"不发参数"（渠道表真的联动了）',
      !!kimi.hint && kimi.hint.indexOf('不发参数') !== -1, String(kimi.hint).slice(-160));

    // 切换必须落盘，否则下次打开弹窗又跳回默认值
    var persisted = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var sel=document.getElementById("providerPreset");sel.value="deepseek";' +
      'sel.dispatchEvent(new Event("change"));' +
      'var tl=document.getElementById("thinkingLevel");tl.value="high";' +
      'tl.dispatchEvent(new Event("change"));' +
      'setTimeout(function(){chrome.storage.local.get("config",function(r){' +
      'var c=(r&&r.config)||{};' +
      'res({level:c.thinkingLevel,preset:c.providerPreset,' +
      'hint:document.getElementById("thinkingHint").textContent});});},600);});})()'
    );
    check('思考强度切换后落盘', persisted.level === 'high', JSON.stringify(persisted.level));
    check('切换后说明跟着更新为高（含 reasoning_effort）',
      !!persisted.hint && persisted.hint.indexOf('reasoning_effort') !== -1,
      String(persisted.hint).slice(-160));
    // 收尾：把思考强度改回默认，避免影响后面的场景读到 high
    await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var tl=document.getElementById("thinkingLevel");tl.value="off";' +
      'tl.dispatchEvent(new Event("change"));setTimeout(res,300);});})()'
    );
    check('开关控件已渲染', ui.toggleCount >= 8, 'toggles=' + ui.toggleCount);

    // 无障碍：每个开关都必须能被键盘聚焦、且状态可被读屏播报。
    // Chrome 官方文档写得很明确：「只有 a / button / 表单控件能获得键盘焦点」，
    // 而这些开关是 div —— 所以 role="switch" + tabindex + aria-checked 缺一不可。
    // （改之前这三样一个都没有，等于整个设置面板键盘用户完全用不了。）
    var a11y = await ctx.client.evaluate(
      '(function(){var ts=document.querySelectorAll(".toggle");var bad=[];' +
      'for(var i=0;i<ts.length;i++){var t=ts[i];var on=t.className.indexOf("on")!==-1;' +
      'if(t.getAttribute("role")!=="switch") bad.push((t.id||"?")+":role");' +
      'if(t.getAttribute("tabindex")!=="0") bad.push((t.id||"?")+":tabindex");' +
      'if(t.getAttribute("aria-checked")!==(on?"true":"false")) bad.push((t.id||"?")+":aria-checked");}' +
      'return {count:ts.length, bad:bad};})()'
    );
    check('每个开关都能被键盘聚焦且状态可播报（role/tabindex/aria-checked）',
      a11y.count >= 8 && a11y.bad.length === 0, JSON.stringify(a11y));

    // 运行状态指示：content.js 一直读 xxtRunning 决定要不要自动跑，但弹窗以前**从来不读** ——
    // 打开后完全看不出是不是已开启。这里不只查「有没有这个元素」，
    // 还要查它**跟着 xxtRunning 变**（否则就是个摆设）。
    // ⚠️ 期望值是「已开启」不是「运行中」：这个标记是持久的（驱动刷新后自动恢复），
    // 不代表此刻正在跑。
    var runUi = await ctx.client.evaluate(
      '(function(){var d=document.getElementById("runDot"),s=document.getElementById("runState");' +
      'return {hasDot:!!d,hasState:!!s,text:s?s.textContent:null,dotOn:!!(d&&d.className.indexOf("on")!==-1)};})()'
    );
    check('顶部有运行状态指示（圆点 + 文字）', runUi.hasDot && runUi.hasState, JSON.stringify(runUi));

    var runSync = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'chrome.storage.local.set({xxtRunning:true},function(){' +
      'Promise.resolve(load()).then(function(){' +
      'var s=document.getElementById("runState"),d=document.getElementById("runDot");' +
      'var out={text:s.textContent,dotOn:d.className.indexOf("on")!==-1};' +
      'chrome.storage.local.set({xxtRunning:false},function(){res(out);});' +
      '});});});})()'
    );
    check('xxtRunning=true 时显示「已开启」且圆点点亮',
      runSync.text === '已开启' && runSync.dotOn === true, JSON.stringify(runSync));

    check('「开始运行」按钮存在', ui.hasStart === true);

    // ---- 全新安装的默认值 ----
    // ⚠️ 各场景共用同一个 chrome.storage，前面答过题的场景会把 apiUrl 写成 mock 地址，
    // 直接读表单只会读到那份残留。所以先清空 config 再重新加载弹窗，
    // 这样验的才是真实用户第一次装上时的路径。
    await ctx.client.evaluate('(function(){return chrome.storage.local.set({config:{}});})()');
    await ctx.client.send('Page.navigate', { url: ctx.url });
    await sleep(1800);
    var fresh = await ctx.client.evaluate(
      '(function(){return {' +
      'selected: document.getElementById("providerPreset").value,' +
      'apiType: document.getElementById("apiType").value,' +
      'apiUrl: document.getElementById("apiUrl").value,' +
      'model: document.getElementById("model").value};})()'
    );
    check('全新安装默认落在 DeepSeek（唯一实测通过的服务商）',
      fresh.selected === 'deepseek', JSON.stringify(fresh));
    check('全新安装默认 API URL 是 DeepSeek 官方域名',
      fresh.apiUrl === 'https://api.deepseek.com', String(fresh.apiUrl));
    check('全新安装默认模型名已填充', !!fresh.model, String(fresh.model));

    // 反向验证：切到「自定义」不能把用户已经填好的 URL / 模型名清空。
    // 老版本存下的已删除预置（minimax）走的正是这条归一化路径。
    var kept = await ctx.client.evaluate(
      '(function(){var sel=document.getElementById("providerPreset");' +
      'var url=document.getElementById("apiUrl"), md=document.getElementById("model");' +
      'url.value="https://api.minimaxi.com"; md.value="MiniMax-M3";' +
      'sel.value="custom-openai"; sel.dispatchEvent(new Event("change"));' +
      'var r={url:url.value, model:md.value, selected:sel.value};' +
      'return r;})()'
    );
    await sleep(400);
    check('切到「自定义」不清空已填的 API URL 与模型名',
      kept.url === 'https://api.minimaxi.com' && kept.model === 'MiniMax-M3',
      JSON.stringify(kept));

    var errs = ctx.client.errors();
    check('弹窗无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  }
});

/** ---- 13. 多讨论任务点（同文档多卡片） ---- */
SCENARIOS.push({
  name: '多讨论任务点',
  path: '/discussion-multi',
  run: async function (ctx) {
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, {enableDiscussion: true}); true'
    );

    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'window._xxtApp._clearTaskGiveUp();' +
      'var targets = app._collectDiscussionTargets();' +
      'return {' +
      'count: targets.length,' +
      'keys: targets.map(function(t){return t.key;}),' +
      'finished: targets.map(function(t){return t.finished;}),' +
      'titles: targets.map(function(t){return t.title.slice(0,6);})' +
      '};})()'
    );

    check('收集到 4 个讨论任务点', probe.count === 4, JSON.stringify(probe.count));
    if (probe.count !== 4) return;

    // 关键断言 1：去重键必须互不相同（旧实现 url.slice(-70) 在尾串相同时会碰撞 → 永久漏做）
    var uniq = Array.from(new Set(probe.keys));
    check('4 个任务的去重键互不相同（不会互相顶掉）', uniq.length === 4, JSON.stringify(probe.keys));
    check('键取自 mtopicid',
      probe.keys.indexOf('topic:111') !== -1 && probe.keys.indexOf('topic:444') !== -1,
      JSON.stringify(probe.keys));

    // 关键断言 2：共用一个容器的那 3 张卡片，绝不能共用容器里的那一个 #isFinished=true
    var sharedGroupFinished = probe.finished.slice(0, 3);
    check('共用容器里的 3 张卡片没有误用容器级的 #isFinished（旧实现会全判已完成而漏做）',
      sharedGroupFinished.every(function (v) { return v === false; }),
      JSON.stringify(sharedGroupFinished));
    check('自带标志的独立卡片仍正确判定为已完成',
      probe.finished[3] === true, JSON.stringify(probe.finished[3]));

    // 关键断言 3：应当挑一个**未完成**的任务去做。
    // 注意 _findDiscussionTask 是 async：必须把 Promise 交给 CDP 的 awaitPromise，
    // 直接在同步 IIFE 里取 t.key 只会拿到 undefined。
    var task = await ctx.client.evaluate(
      '(function(){return window._xxtApp._findDiscussionTask().then(function(t){' +
      'return t?{key:t.key,name:t.name,url:t.url}:null;});})()'
    ).catch(function (e) { return { error: String(e && e.message || e) }; });

    check('挑出的是未完成的任务（不是已完成的那个）',
      !!(task && task.key && task.key !== 'topic:444'), JSON.stringify(task));

    // 完成标记必须可撤回：_markDiscussionDone 是先于打开动作写的，
    // 万一根本没有可点入口，那条记录会把任务点静默跳过 24 小时
    var rollback = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._markDiscussionDone("e2e-key-1"); var marked=app._isDiscussionDone("e2e-key-1");' +
      'app._unmarkDiscussionDone("e2e-key-1"); var cleared=app._isDiscussionDone("e2e-key-1");' +
      'app._unmarkDiscussionDone("never-marked-key"); var safe=app._isDiscussionDone("never-marked-key");' +
      'return {marked:marked, cleared:cleared, safe:safe};})()'
    );
    check('完成标记可撤回（打不开入口时不会被静默跳过 24 小时）',
      rollback.marked === true && rollback.cleared === false, JSON.stringify(rollback));
    check('撤回未标记的键是安全的（不抛异常）', rollback.safe === false, JSON.stringify(rollback.safe));
  }
});

/** ---- 14. 做不完的任务点跳过 ---- */
SCENARIOS.push({
  name: '做不完的任务点跳过',
  path: '/blank',
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._clearTaskGiveUp();' +
      'app.configs=Object.assign({},app.configs,{taskGiveUpAttempts:3});' +
      'var job={jobid:"JOB-E2E-1",name:"防拖拽视频",attachment:{property:{module:"insertvideo"}}};' +
      'var key=app._taskPointKey(job);' +
      'var before=app._isTaskGivenUp(key);' +
      'app._countTaskIncomplete(job,"e2e"); var a1=app._isTaskGivenUp(key);' +
      'app._countTaskIncomplete(job,"e2e"); var a2=app._isTaskGivenUp(key);' +
      'app._countTaskIncomplete(job,"e2e"); var a3=app._isTaskGivenUp(key);' +
      'var list=app._taskGiveUpList();' +
      'var keyNoId=app._taskPointKey({name:"无名任务",attachment:{property:{module:"insertdoc"}}});' +
      'var completedNull=app._isJobCompleted(null);' +
      'app._clearTaskGiveUp();' +
      'var cleared=app._isTaskGivenUp(key);' +
      'delete app.configs.taskGiveUpAttempts;' +
      'return {key:key, before:before, a1:a1, a2:a2, a3:a3,' +
      'listLen:list.length, listName:list.length?list[0].name:null,' +
      'listReason:list.length?list[0].reason:null,' +
      'cleared:cleared, keyNoId:keyNoId, completedNull:completedNull};})()'
    );

    check('任务点键优先取 jobid', r.key === 'job:JOB-E2E-1', JSON.stringify(r.key));
    check('首次未完成不放弃', r.before === false && r.a1 === false, JSON.stringify([r.before, r.a1]));
    check('未达上限（3 次）前不放弃', r.a2 === false, JSON.stringify(r.a2));
    check('连续 3 次未完成后记入放弃名单', r.a3 === true, JSON.stringify(r.a3));
    check('放弃名单记录了任务名与原因',
      r.listLen === 1 && r.listName === '防拖拽视频' && r.listReason === 'e2e',
      JSON.stringify([r.listLen, r.listName, r.listReason]));
    check('clearTaskGiveUp 能清除记录（用户可让它重试）', r.cleared === false, JSON.stringify(r.cleared));
    check('无 jobid 时回退用 module+名称 作键',
      r.keyNoId === 'nm:insertdoc|无名任务', JSON.stringify(r.keyNoId));
    check('_isJobCompleted(null) 保守返回 true（不误跳过）', r.completedNull === true, JSON.stringify(r.completedNull));

    // ---- 安全阀：进度快照。这是整个"放弃"机制里最容易被改错的地方 ——
    // 长视频一次本来就跑不完，若按"没完成"计数，必做任务点会被误跳过。
    var snap = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return {' +
      'nullJob: app._taskProgressSnapshot(null),' +
      'blankDoc: app._taskProgressSnapshot({doc: document}),' +
      'noQuery: app._taskProgressSnapshot({doc: {}})};})()'
    );
    check('不可测量的任务点快照为空（因而永远不会被判"卡住"）',
      snap.nullJob === '' && snap.blankDoc === '' && snap.noQuery === '',
      JSON.stringify(snap));

    var api = await ctx.client.evaluate(
      '!!(window.xxtAI && typeof window.xxtAI.taskGiveUpList === "function" && typeof window.xxtAI.clearTaskGiveUp === "function")'
    );
    check('xxtAI.taskGiveUpList / clearTaskGiveUp 可用', api === true);
  }
});

/**
 * 防拖拽 + 倍速锁 1x 的视频：平台只要求观看时长 ≥ 总时长的 90%。
 *
 * 这条路径最危险的地方是"自己认定完成" —— 一旦按"播够 90% 就收工"，
 * 而平台并未认可，就会**误跳过任务点**，比多花十分钟严重得多。
 * 所以断言分两层：
 *   1) 判据层：四个条件缺一不可（不可拖拽 / 锁 1x / ≥90% / 平台已标记完成）
 *   2) 收尾层：状态必须被清干净（漏一个字段会让状态机卡住，下一个任务点不动）
 */
SCENARIOS.push({
  name: '防拖拽+锁1x 视频到 90% 提前结束',
  path: '/media-90',
  beforeInject: function () {
    return [
      '(function(){',
      '  Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: function(){ return 100; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: function(){ return false; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: function(){ return 4; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "ended", { configurable: true, get: function(){ return (this.__ct || 0) >= 100; } });',
      // 不可拖拽：写入 currentTime 被忽略（真站点上是播放器把进度弹回去）
      '  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {',
      '    configurable: true, get: function(){ return this.__ct || 0; },',
      '    set: function(v){ /* 拖拽被播放器弹回：不采纳 */ } });',
      // 倍速锁 1x：写入 playbackRate 被压回 1
      '  Object.defineProperty(HTMLMediaElement.prototype, "playbackRate", {',
      '    configurable: true, get: function(){ return 1; }, set: function(v){ /* 被压回 1x */ } });',
      '  HTMLMediaElement.prototype.play = function(){ return Promise.resolve(); };',
      '  HTMLMediaElement.prototype.load = function(){};',
      // 平台自己的完成标记：默认 ≥90% 才插入、低于 90% 就移除。
      // 第二个参数可以**强行不插标记**，用来复现"进度已过 90%、平台还没认可"这种
      // 最危险的情况 —— 那时插件必须按未完成处理。
      '  window.__setProgress = function(ratio, withMarker){',
      '    var v = document.getElementById("omitone-video");',
      '    v.__ct = 100 * ratio;',
      '    var want = (withMarker === undefined) ? (ratio >= 0.9) : !!withMarker;',
      '    var marker = document.getElementById("finish-marker");',
      '    if (want) {',
      '      if (!marker) { var m = document.createElement("span"); m.id = "finish-marker";',
      '        m.className = "ans-job-finished"; m.textContent = "任务点已完成";',
      '        document.getElementById("module").appendChild(m); }',
      '    } else if (marker) { marker.parentNode.removeChild(marker); }',
      '    return v.__ct;',
      '  };',
      '  window.__patched = true;',
      '})()'
    ].join('\n');
  },
  run: async function (ctx) {
    var patched = await ctx.client.evaluate('window.__patched === true');
    check('媒体打桩生效（不可拖拽 + 锁 1x）', patched === true);

    // ---- 判据一：倍速是否被锁在 1x
    var lock = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var r={};' +
      'app._detectedMaxRate=0; r.unknown=app._isRateLockedAtOne();' +
      'app._detectedMaxRate=1; r.one=app._isRateLockedAtOne();' +
      'app._detectedMaxRate=2; r.two=app._isRateLockedAtOne();' +
      'return r;})()'
    );
    check('倍速探测无结果时不算"锁 1x"（宁可多播）', lock.unknown === false, JSON.stringify(lock));
    check('探测结果为 1x 时判定为锁定', lock.one === true, JSON.stringify(lock));
    check('探测结果为 2x 时不算锁定', lock.two === false, JSON.stringify(lock));

    // ---- 判据二：拖拽被弹回，且这个结论被记录下来
    var seek = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableSeek:true,advanceAtNinetyPercent:true});' +
      'app._rateProbing=false; app._rateDetectBusy=false; app._captchaActive=false;' +
      'app._seekTriedKeys=null; app._seekRevertedKeys=null;' +
      'var v=document.getElementById("omitone-video"); v.__ct=0;' +
      'var ok=app._trySeekToEnd(v,"e2e-90");' +
      'return {ok:ok, ct:v.__ct, key:app._getMediaSeekKey(v)};})()'
    );
    check('对不可拖拽视频仍会尝试 seek 一次', seek.ok === true, JSON.stringify(seek));
    check('拖拽被弹回（进度未被改动）', seek.ct === 0, JSON.stringify(seek));

    // 等 _trySeekToEnd 的 1.5s 回弹判定落地。
    //
    // ⚠️ 必须**轮询**，不能用固定 sleep：那个 1.5s 走的是 `_workerDelay`，
    // 而它优先投给后台 Web Worker（postMessage → 定时器 → 再回一条消息），
    // 首次启动 + 消息往返 + 后台标签页的定时器节流，都让实际耗时明显超过 1500ms。
    // 实测固定等 1700ms 会偶发失败（同一个提交跑三次失败一次）——
    // 一条偶发失败的断言比没有断言更糟：它会训练人忽略红色。
    var reverted = { flag: false };
    for (var wait = 0; wait < 30; wait++) {
      reverted = await ctx.client.evaluate(
        '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
        'var k=app._getMediaSeekKey(v);' +
        'return {flag:!!(app._seekRevertedKeys && app._seekRevertedKeys[k])};})()'
      );
      if (reverted.flag) break;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
    check('回弹判定被记下来（= 不可拖拽）', reverted.flag === true, JSON.stringify(reverted));

    // ---- 四个条件缺一不可
    var gate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");var r={};' +
      'var k=app._getMediaSeekKey(v);' +
      'app._detectedMaxRate=1; app._seekRevertedKeys={}; app._seekRevertedKeys[k]=true;' +
      'window.__setProgress(0.5); r.half=app._shouldAdvanceAtNinetyPercent(v);' +
      'window.__setProgress(0.9); r.ninety=app._shouldAdvanceAtNinetyPercent(v);' +
      'window.__setProgress(0.999); r.nearEnd=app._shouldAdvanceAtNinetyPercent(v);' +
      'app._detectedMaxRate=2; window.__setProgress(0.9); r.notLocked=app._shouldAdvanceAtNinetyPercent(v);' +
      'app._detectedMaxRate=1; app._seekRevertedKeys={}; window.__setProgress(0.9); r.seekable=app._shouldAdvanceAtNinetyPercent(v);' +
      'return r;})()'
    );
    check('不到 90% 不提前结束', gate.half === false, JSON.stringify(gate));
    check('到 90% 且平台已标记完成 → 提前结束', gate.ninety === true, JSON.stringify(gate));
    check('接近结尾时让给 ended 路径（两条路不抢）', gate.nearEnd === false, JSON.stringify(gate));
    check('能加速的视频不提前结束', gate.notLocked === false, JSON.stringify(gate));
    check('可拖拽的视频不提前结束', gate.seekable === false, JSON.stringify(gate));

    // ---- 最重要的安全阀：进度已经过了 90%，但**平台还没认可**时，绝不能提前结束。
    //
    // 这一条必须把进度放在 90% 以上：如果只在 50% 上断言，它会因为"不到 90%"而通过，
    // 根本测不到"平台完成标记"这个条件 —— 反向验证时就是这样漏掉的。
    var safety = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'var k=app._getMediaSeekKey(v);' +
      'app._detectedMaxRate=1; app._seekRevertedKeys={}; app._seekRevertedKeys[k]=true;' +
      'window.__setProgress(0.95, false);' + // 95% 进度，但平台没标记完成
      'return {gate:app._shouldAdvanceAtNinetyPercent(v),' +
      'marker:!!document.getElementById("finish-marker"),' +
      'finished:app._isDocumentFrameFinished(v.ownerDocument)};})()'
    );
    check('进度过 90% 但平台没标记完成 → 不提前结束（安全阀）',
      safety.gate === false && safety.marker === false && safety.finished === false,
      JSON.stringify(safety));

    // ---- 收尾：状态必须被清干净（漏一个字段会让状态机卡住，下一个任务点不动）
    var finish = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._isPlaying=true; app._activeMediaJobManaged=true; app._activeMediaJobPending=true;' +
      'app._videoEl=document.getElementById("omitone-video"); app._videoCount=1; app._currentVideoIndex=0;' +
      'app._finishCurrentMedia("ninety-percent");' +
      'return {playing:app._isPlaying, managed:app._activeMediaJobManaged,' +
      'pending:app._activeMediaJobPending, videoEl:!!app._videoEl, count:app._videoCount};})()'
    );
    check('收尾清掉 _isPlaying', finish.playing === false, JSON.stringify(finish));
    check('收尾清掉 _activeMediaJobManaged（漏了会卡住）', finish.managed === false, JSON.stringify(finish));
    check('收尾清掉 _activeMediaJobPending', finish.pending === false, JSON.stringify(finish));
    check('收尾清掉 _videoEl / _videoCount', finish.videoEl === false && finish.count === 0, JSON.stringify(finish));

    // ---- 开关
    var off = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'var k=app._getMediaSeekKey(v);' +
      'app._detectedMaxRate=1; app._seekRevertedKeys={}; app._seekRevertedKeys[k]=true;' +
      'window.__setProgress(0.9);' +
      'app.configs=Object.assign({},app.configs,{advanceAtNinetyPercent:false});' +
      'return {gate:app._shouldAdvanceAtNinetyPercent(v)};})()'
    );
    check('开关关闭后不提前结束', off.gate === false, JSON.stringify(off));
  }
});

/** ---- 1d. 作业页提交：提交后必须认出"已完成"，不能一直等下去 ---- */
SCENARIOS.push({
  name: '作业页提交后认出已完成',
  path: '/exam-work',
  run: async function (ctx) {
    var app = 'window._xxtApp';

    // 走**完整的真实链路**，不手填绕过前置闸门。
    // `_maybeSubmitQuiz` 在找提交按钮之前有四道闸门（总开关 / 无已知错答 / 答案填全 /
    // `_quizReadyToSubmit` 且 workKey 匹配），手填 DOM 只能满足第一道，
    // 于是在 8466 行就返回 false —— 那样测到的是"没走通"，不是"提交判定坏了"。
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      app + '.configs = Object.assign({}, ' + app + '.configs, ' + JSON.stringify(cfg) + '); true'
    );

    // 提交前必须判为"未完成" —— 否则这个守卫恒真，等于没测
    var beforeSubmit = await ctx.client.evaluate(
      '(function(){return {finished:' + app + '._isQuizPassedOrFinished(null),' +
      'auto:' + app + '._shouldAutoSubmitQuiz(null)};})()'
    );
    check('提交前不算已完成（守卫不是恒真）', beforeSubmit.finished === false,
      JSON.stringify(beforeSubmit));
    // 这一条盯的是"插件认不认得出这个页面的提交入口" ——
    // 作业页原先三样判据都不满足，`auto submit skipped`，永远不提交、只重扫。
    check('作业页被认出"可以自动提交"（btnBlueSubmit / .btnSubmit / #form1 任一）',
      beforeSubmit.auto === true, JSON.stringify(beforeSubmit));

    // 跑真实答题链：抠题 → 问模型 → 回填 → 自动提交
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate(app + '._handleQuiz(null); true');
    var gotRequest = await waitFor(ctx.client,
      'window._xxtApp._quizReadyToSubmit === true', 20000);
    check('作业页答题链真的问到了模型并填好（前置条件成立）',
      gotRequest === true && ctx.mock.requests.length > before,
      'readyToSubmit=' + gotRequest + ' 请求数 +' + (ctx.mock.requests.length - before));

    // 提交确认框（#workpop + #popok）要被点到。真实站点/现场就是卡在这一步 ——
    // 点不到就永远停在 `waiting quiz submit result`，然后整页重扫、重复答题。
    var confirmed = await waitFor(ctx.client,
      'window.__submitted === true', 15000);
    check('站点确认框（#workpop/#popok）被点到，页面真的提交了', confirmed === true);

    var afterSubmit = await ctx.client.evaluate(
      '(function(){var a=' + app + ';return {' +
      'finished:a._isQuizPassedOrFinished(null),' +
      'docFinished:a._isDocumentFrameFinished(document),' +
      'resultPage:a._isQuizResultPageFinished(document),' +
      // 关键：结果页**不**走 .testTit_status_complete / 「任务点已完成」那条老路 ——
      // 它只有 .Py_answer 那一族 + 控件 disabled。所以 docFinished 应当为 false，
      // 而新判据 resultPage 为 true。这两条一起证明"新判据确实在干活"。
      'legacyMark:!!document.querySelector(".testTit_status_complete")||/任务点已完成/.test(document.body.innerText||""),' +
      'pyAnswer:document.querySelectorAll(".Py_answer").length,' +
      'disabled:Array.from(document.querySelectorAll("input[type=radio],input[type=checkbox]")).every(function(i){return i.disabled;}),' +
      'text:(document.body.innerText||"").slice(0,120)};})()'
    );
    check('提交后页面确实是"判分结果页"（.Py_answer 出现 + 控件全 disabled），且不带旧标记',
      afterSubmit.pyAnswer > 0 && afterSubmit.disabled === true && afterSubmit.legacyMark === false,
      JSON.stringify(afterSubmit));
    check('旧判据（_isDocumentFrameFinished）对结果页确实认不出来 —— 所以新判据不是多余的',
      afterSubmit.docFinished === false, JSON.stringify({ docFinished: afterSubmit.docFinished }));
    check('提交后判定为已完成（不再无限等待）', afterSubmit.finished === true,
      JSON.stringify(afterSubmit));

    // 这条是"不再重复提交"的核心：monitor 应当在认出完成后立刻收尾。
    // 没修之前这里会返回 true（一直 hold），页面上就表现为"重扫 → 重答 → 重交"。
    var monitored = await ctx.client.evaluate(
      '(function(){var a=' + app + ';a._quizSubmitPending=true;a._quizSubmitStartedAt=Date.now();' +
      'var holding=a._monitorQuizSubmit(null);' +
      'return {holding:holding,pending:a._quizSubmitPending,answered:a._quizAnswered};})()'
    );
    check('认出已完成之后不再继续 hold（否则会重扫重答）',
      monitored.holding === false && monitored.pending === false && monitored.answered === true,
      JSON.stringify(monitored));
  }
});


/**
 * ---- 对照：500 仍然要进 45 秒退避 ----
 *
 * ⚠️ 必须放在**最后一个**场景：它会把 apiConnectionFailed 写进 chrome.storage，
 * 而这个临时 profile 是全程共用的 —— 放在前面，后面每个场景都会被它连坐
 * （page.js 收到配置更新就设 45 秒退避，答题场景会集体失败）。
 *
 * 为什么需要这条对照：没有它，"只要是失败就一律不退避"这种改法
 * 也能通过 401 那组断言 —— 那等于把可重试的服务端错误也一起放过了。
 */
SCENARIOS.push({
  name: '对照：500 仍然进 45 秒退避',
  path: '/quiz',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      enableCaptcha: false,
      enableDiscussion: false,
      autoNext: false
    };
    await ctx.client.evaluate(
      'window.postMessage({source:"xxt_app",type:"storage_set",payload:{config:' + JSON.stringify(cfg) + '}}, "*"); true'
    );
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    var before = ctx.mock.requests.length;
    ctx.mock.setStatus(500);
    await ctx.client.evaluate(
      'window._xxtApp._quizApiFailUntil = 0; window._xxtApp._quizApiLastError = "";' +
      'window._xxtApp._handleQuiz(null); true'
    );

    var marked = await waitFor(ctx.client, 'window._xxtApp._quizApiFailUntil > Date.now()', 25000);
    var st = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;return {failUntil:a._quizApiFailUntil,now:Date.now()};})()'
    );
    check('500（可重试的服务端错误）仍然进 45 秒退避', marked === true && st.failUntil > st.now,
      JSON.stringify(st));
    check('500 至少重试了一次（不是一次失败就放弃）',
      ctx.mock.requests.length - before >= 2, '请求数 +' + (ctx.mock.requests.length - before));

    ctx.mock.setStatus(0);
  }
});

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  var edge = findEdge();
  if (!edge) {
    console.log('\n未找到 Edge，已跳过浏览器端到端测试。');
    console.log('可用 OMITONE_EDGE 环境变量指定路径。\n');
    return;
  }

  console.log('\nOmitone 真实浏览器功能交叉检验');
  console.log('  Edge: ' + edge);
  console.log('  临时 profile + 远程调试端口 ' + CDP_PORT + '（不触碰你正在使用的浏览器）');

  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omitone-e2e-'));
  var profileDir = path.join(tmpRoot, 'profile');

  // 端口必须是干净的。若已有实例占着它，我们会连到那个旧实例上，
  // 于是"所有扩展 ID 都注入失败" —— 这个症状极具误导性，所以先明确拦下来。
  // 但**要等一等**：连续跑两次时，上一次的 Edge 被杀掉后端口未必立刻回收，
  // 立刻报错会让"连跑三轮"这种正常场景出现假失败。
  if (!(await waitForPortFree(12000))) {
    var stale = null;
    try { stale = await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) {}
    console.log('\n  端口 ' + CDP_PORT + ' 在等待 12 秒后仍被占用（' + ((stale && stale.Browser) || '未知浏览器') + '）。');
    console.log('  通常是上一次测试的 Edge 没退干净。请先结束它，或用 OMITONE_CDP_PORT 换端口。\n');
    process.exitCode = 1;
    return;
  }

  var mock = await startMockServer();
  var edgeProc = null;

  try {
    edgeProc = spawn(edge, [
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + CDP_PORT,
      // 必须成对出现：新版 Chromium 单独给 --load-extension 时常被忽略，
      // 加上 --disable-extensions-except 才会真正只加载这一个扩展。
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      'about:blank'
    ], { stdio: 'ignore', detached: process.platform !== 'win32' });

    await waitForCdp(30000);

    var computedId = computeExtensionId(ROOT);
    // 真实 ID 以运行时发现为准（路径哈希会因盘符大小写算错，见 discoverExtensionId 的说明）
    var extensionId = await discoverExtensionId(computedId);
    console.log('  扩展 ID: ' + extensionId);
    if (extensionId !== computedId) {
      console.log('  ⚠️ 路径哈希给出的是 ' + computedId + '（盘符大小写不一致所致），已改用运行时发现的 ID。');
    }

    for (var i = 0; i < SCENARIOS.length; i++) {
      var scenario = SCENARIOS[i];
      var targetLabel = String(scenario.url || scenario.path).replace('{EXT}', extensionId);
      section(scenario.name + '  (' + targetLabel + ')');

      var ctx = null;
      try {
        ctx = await openScenarioPage(extensionId, scenario);
        ctx.mock = mock;

        if (scenario.beforeInject) {
          await ctx.client.evaluate(scenario.beforeInject());
          await sleep(200);
        }

        if (scenario.inject === false) {
          // 扩展自身页面（popup）：断言由场景自己提供，只先确认没有加载期异常
          var loadErrors = ctx.client.errors();
          check('页面加载无未捕获异常', loadErrors.length === 0,
            loadErrors.slice(0, 2).join(' | '));
        } else {
          var appReady = await ctx.client.evaluate('!!window._xxtApp');
          check('page.js 在真实 Edge 中加载成功', appReady === true);
          if (!appReady) {
            ctx.client.errors().slice(0, 3).forEach(function (e) { console.log('        异常: ' + e); });
            await ctx.close();
            continue;
          }
        }

        await scenario.run(ctx, mock);
      } catch (error) {
        check('场景执行未抛异常', false, error && error.message ? error.message : String(error));
      } finally {
        if (ctx) await ctx.close();
      }
    }
  } finally {
    await killTree(edgeProc);
    // 等端口真正释放再退出，否则紧接着的下一次运行会连到正在退出的旧实例上
    await waitForPortFree(12000);
    try { mock.server.close(); } catch (e) {}
    console.log('\n  临时 profile: ' + tmpRoot + '（可手动删除）');
  }

  // 把本次真实项数落盘，供 tools/check.js 校验文档里的数字。
  // 断言总数是**运行期**才算出来的（含每场景动态断言），静态数不出来 ——
  // 所以只能由 e2e 自己交出来，否则文档里的数字永远靠人肉同步（已经漏过两次）。
  // 落在 .workbuddy/ 下（已在 .gitignore），不入版本库。
  try {
    fs.writeFileSync(path.join(ROOT, '.workbuddy', 'e2e-counts.json'), JSON.stringify({
      scenarios: SCENARIOS.length,
      assertions: checks,
      passed: failures.length === 0,
      at: new Date().toISOString()
    }, null, 2));
  } catch (e) {}

  console.log('');
  if (failures.length) {
    console.log('功能交叉检验未通过：' + failures.length + ' / ' + checks + ' 项失败');
    failures.forEach(function (f) { console.log('  - ' + f); });
    console.log('');
    process.exitCode = 1;
  } else {
    console.log('功能交叉检验全部通过：' + checks + ' / ' + checks + ' 项');
    console.log('');
  }
}

main().catch(function (err) {
  console.error('\n测试异常终止: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
