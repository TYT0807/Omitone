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

/**
 * 要加载哪个目录当扩展。
 *
 * 默认是**仓库根目录**（开发态）。给 `OMITONE_EXT_DIR` 可以改成加载**打包产物**：
 *
 *   OMITONE_EXT_DIR=dist/omitone-1.2.9 npm run e2e
 *
 * 为什么需要这个开关：默认这条路测的是仓库根目录，**不是用户下载到的那个包**。
 * 而 `tools/build.js` 用的是**白名单 `INCLUDE`** —— 万一漏登记一个文件，
 * 包在用户机器上跑不起来，可 e2e 照样全绿（因为它读的是根目录那份）。
 * 发版前拿这个开关跑一遍，才算真的验过"用户下载到的东西能跑"。
 *
 * ⚠️ 扩展 ID 是**按绝对路径哈希**算出来的，所以换目录会换 ID ——
 * 场景里用 `{EXT}` 的地方会跟着变，`discoverExtensionId` 负责在运行时找到真实 ID。
 */
var EXT_DIR = process.env.OMITONE_EXT_DIR
  ? path.resolve(process.cwd(), process.env.OMITONE_EXT_DIR)
  : ROOT;
var PORT = Number(process.env.OMITONE_E2E_PORT || 8899);
var CDP_PORT = Number(process.env.OMITONE_CDP_PORT || 9222);
var DEBUG = !!process.env.OMITONE_E2E_DEBUG;
// 名称子串筛选；定向反向验证不能覆盖全套断言计数文件。
var E2E_FILTER = String(process.env.OMITONE_E2E_FILTER || '').trim();

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

/**
 * 章节测验页的**现场形状**（批次 23/24，2026-11-12 量出来的，不是拍的）。
 *
 * 为什么 `/quiz` 那份不够用：`.TiMu` 那一族题目它都有，唯独**提交这一层是空的** ——
 * 没有 `window.btnBlueSubmit`、没有 `.btnSubmit`、没有 `#form1`，而 `/quiz` 自己就是顶层文档，
 * `_getCurrentTitle()` 读的是外层刷课页的 `.prev_title`，在这里恒为空串。三条全落空 →
 * `_shouldAutoSubmitQuiz()` 直接返回 false → `auto submit skipped` →
 * 于是「填满了、ready 也过了，可提交键一次都没被点」。**现场不是这样**：
 * 2026-09-18 的真实日志就是 `quiz form ready: true` → `call btnBlueSubmit()`，
 * 站点的提交入口是页面上同名函数 + `.btnSubmit`/`#form1` 那一族标记
 * （`/exam-work` 那份作业夹具早就照这个补过了，注释里写着「原先三样都没有 → 插件永不提交」）。
 * 所以这里给章节测验补同一套形状，而不是去改那条闸。
 *
 * 题目部分直接复用 `buildQuizHtml()`（含填空题两个空），只换提交层 —— 两份夹具不会各长各的。
 */
function buildQuizRealHtml() {
  return buildQuizHtml().replace(
    '<div class="subBtn"><button id="submitBtn" type="button">提交</button></div>',
    '<form id="form1" name="form1" onsubmit="return false;">' +
    '<div class="subBtn"><button id="submitBtn" type="button" class="btnSubmit">提交</button></div>' +
    '</form>' +
    '<script>' +
    'window.__omBlueCalls = 0; window.__omOkCalls = 0; window.__submitted = false;' +
    // 站点自己的提交函数：先弹自己的确认框（#workpop + #popok），点确定才真的交卷。
    'window.btnBlueSubmit = function(){' +
    '  window.__omBlueCalls++;' +
    '  if (window.__submitted || document.getElementById("workpop")) return;' +
    '  var pop = document.createElement("div");' +
    '  pop.id = "workpop"; pop.style.display = "block";' +
    '  pop.innerHTML = \'<div id="popcontent">请完成所有题目，确认提交？</div><a id="popok">确定</a>\';' +
    '  document.body.appendChild(pop);' +
    '  document.getElementById("popok").addEventListener("click", function(){' +
    '    window.__omOkCalls++; window.__submitted = true;' +
    '    Array.from(document.querySelectorAll("input,textarea")).forEach(function(i){ i.disabled = true; });' +
    '    Array.from(document.querySelectorAll(".TiMu")).forEach(function(q){' +
    '      var d = document.createElement("div"); d.className = "status"; d.textContent = "已完成"; q.appendChild(d);' +
    '    });' +
    '    if (pop.parentNode) pop.parentNode.removeChild(pop);' +
    '  });' +
    '};' +
    'document.getElementById("submitBtn").addEventListener("click", function(){ window.btnBlueSubmit(); });' +
    '</script>'
  );
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

/**
 * 「一张学习卡片里挂着两份测验任务点」——复现"第二个任务点永远不做"。
 *
 * 结构与**实测的真实页面**逐层对齐（三层）：
 *
 *   学习卡片（本场景的 #iframe 内容）
 *     └ 任务点外层  /wq-outer-x   ← `data` 属性里有 jobid（**身份在这一层**）
 *          └ /wq-mid-x            ← data 为空，也没有题目
 *               └ /wq-inner-x     ← 有 .TiMu（整卷题目），data **也是空**
 *
 * 要害是：**带 jobid 的帧和带题目的帧不是同一个**。
 * 旧实现只认"本帧自己的 data" → 三层里没有一层能同时满足
 * 「有 jobid」和「有 .TiMu」→ 一个任务点都匹配不到 →
 * 误判"本页没有任务点" → `nextUnit()` 把整个任务点**静默漏掉**。
 *
 * 另外 A 份是**已完成**（内层带 .ans-job-finished）、B 份未完成：
 * 正确行为是"跳过 A、选中 B"，而不是"随便挑一个"。
 */
function buildTwoQuizTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="/wq-card" style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    // 任务点清单挂在顶层 window 上（page.js 也跑在顶层）
    '<script>window.attachments=[' +
    '{jobid:"work-A",property:{_jobid:"work-A",jobid:"work-A",mid:"mid-A",name:"第一份单元测试",module:"work",type:"work"}},' +
    '{jobid:"work-B",property:{_jobid:"work-B",jobid:"work-B",mid:"mid-B",name:"第二份单元测试",module:"work",type:"work"}}' +
    '];</script>' +
    '</body></html>';
}

function buildTwoQuizCardHtml() {
  function task(id, label) {
    // data 属性里的 JSON 用 &quot; 转义后放进双引号属性里，浏览器取出来还是合法 JSON
    var payload = { jobid: 'work-' + id, _jobid: 'work-' + id, workid: id, name: label };
    var dataAttr = JSON.stringify(payload).replace(/"/g, '&quot;');
    return '<div class="ans-attach-ct" id="tp-' + id.toLowerCase() + '">' +
      '<div class="ans-job-icon" aria-label="任务点"></div>' +
      '<div class="ans-attach-title">' + label + '</div>' +
      '<iframe jobid="work-' + id + '" data="' + dataAttr + '" ' +
      'src="/wq-outer-' + id + '" style="width:100%;height:260px;border:0"></iframe>' +
      '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="card">' + task('A', '第一份单元测试') + task('B', '第二份单元测试') + '</div>' +
    '</body></html>';
}

/**
 * 同一个卡片，但 **jobid 只在容器 div 上、iframe 上什么都不写**。
 *
 * 为什么要单独搭这一版：`_findJobIdInAncestorFrames` 里有一段专门处理
 * 「jobid 挂在任务点外层容器上」（注释说这在真实页面上**很常见**），
 * 但它的判据写成 `wrap.querySelector('[jobid]')` —— 而 **`querySelector` 只找后代、
 * 永远返回不了 `wrap` 自己**，于是 `holder === wrap` 这个条件**不可达**：
 * jobid 写在容器 div 上时**一个都找不到**。
 *
 * 症状与用户报过的那个一模一样：任务点匹配不到 → 整章被静默跳过。
 */
function buildTwoQuizCardDivJobIdHtml() {
  function task(id, label) {
    var payload = { jobid: 'work-' + id, _jobid: 'work-' + id, workid: id, name: label };
    var dataAttr = JSON.stringify(payload).replace(/"/g, '&quot;');
    // ⚠️ 与 buildTwoQuizCardHtml 的**唯一区别**：jobid / data 写在 div 上，iframe 上一个都不写
    return '<div class="ans-attach-ct" id="tp-' + id.toLowerCase() + '" jobid="work-' + id + '" data="' + dataAttr + '">' +
      '<div class="ans-job-icon" aria-label="任务点"></div>' +
      '<div class="ans-attach-title">' + label + '</div>' +
      '<iframe src="/wq-outer-' + id + '" style="width:100%;height:260px;border:0"></iframe>' +
      '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="card">' + task('A', '第一份单元测试') + task('B', '第二份单元测试') + '</div>' +
    '</body></html>';
}

function buildTwoQuizzesDivJobIdTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="/wq-card-divjob" style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    '<script>window.attachments=[' +
    '{jobid:"work-A",property:{_jobid:"work-A",jobid:"work-A",mid:"mid-A",name:"第一份单元测试",module:"work",type:"work"}},' +
    '{jobid:"work-B",property:{_jobid:"work-B",jobid:"work-B",mid:"mid-B",name:"第二份单元测试",module:"work",type:"work"}}' +
    '];</script>' +
    '</body></html>';
}

/** 任务点外层模块页：**jobid 在它的 iframe 属性上**，它自己一题都没有 */
function buildTwoQuizOuterHtml(id) {  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>' +
    '<div class="work-module">' +
    '<iframe id="frame_content" src="/wq-mid-' + id + '" style="width:100%;height:200px;border:0"></iframe>' +
    '</div></body></html>';
}

/** 中间层：data 为空、也没有题目（真实页面里是 /mooc-ans/api/work?api=1） */
function buildTwoQuizMidHtml(id) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>' +
    '<div class="x-body">' +
    '<iframe id="inner" src="/wq-inner-' + id + '" style="width:100%;height:160px;border:0"></iframe>' +
    '</div></body></html>';
}

/** 最内层：真正的试卷（有 .TiMu）；finished=true 的那份带"任务点已完成"标记 */
function buildTwoQuizInnerHtml(id, finished) {
  function timu(no, stem) {
    return '<div class="TiMu">' +
      '<div class="Zy_TItle clearfix"><span class="fontLabel">' + no + '.</span>【单选题】' + stem + '</div>' +
      '<ul class="Zy_ulTop"><li><a href="javascript:void(0)">A. 甲</a></li><li><a href="javascript:void(0)">B. 乙</a></li></ul>' +
      '<ul class="Zy_ulBottom"><li><input type="radio" name="ans' + no + '" value="A"></li>' +
      '<li><input type="radio" name="ans' + no + '" value="B"></li></ul>' +
      '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' + (finished ? '已完成的试卷' : '待作答的试卷') + '</title></head><body>' +
    (finished ? '<div class="ans-job-finished">任务点已完成</div>' : '') +
    timu(1, '第 ' + id + ' 份卷子的第一题') +
    timu(2, '第 ' + id + ' 份卷子的第二题') +
    '<div class="subBtn"><button id="submitBtn" type="button" class="btnSubmit">提交</button></div>' +
    '</body></html>';
}

/**
 * ★ 2026-10-17 真实故障复刻：模块页的 `<script>` 里含**「任务点已完成」**这句字符串。
 *
 * 平台自己有一段无障碍支持代码，原文就是：
 *     jobIconDiv.set({'aria-label': '任务点已完成'});
 * 而 `textOf()` 原先写的是 `innerText || textContent` —— 可见文本为空时回落
 * `textContent`，**把脚本源码也算成页面文字**，于是整份卷子被判成「已完成」：
 * 静默跳过 → 搜不到任务点 → 判「本页做完」→ 点下一节（页面推不动）→ 空转死循环。
 *
 * 这一页只要还能"认得出卷子"，就说明修好了。
 */
function buildDecoyScriptOuterHtml() {
  // ⚠️ 卷子必须挂成它的**直接子帧** —— 真实页面就是这样
  //（`work/index.html` 的下一层就是带 `.TiMu` 的 `/mooc-ans/api/work`）。
  // 一开始照抄了"三层"的写法，结果 `_isDocumentFrameFinished` 看的是**中间层**的 body、
  // 根本碰不到脚本 —— 场景会因为错误的原因通过（幸好那条前置条件断言抓住了）。
  // ⚠️ iframe 必须**直接挂在 `<body>` 下**，脚本也在 body 里 —— 真实页面就是这样：
  // 题目帧的 `frameElement.parentElement` 就是那个**带脚本的 body**。
  // 中间套一层 `<div>` 会让脚本落到 wrap 之外，场景就又测不到东西了（这里来回踩了两次）。
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>' +
    '<iframe id="frame_content" src="/wq-inner-B" style="width:100%;height:400px;border:0"></iframe>' +
    "<script>var jobIconDiv={set:function(o){}};jobIconDiv.set({'aria-label': '任务点已完成'});</script>" +
    '</body></html>';
}

/** 卡片层：一份卷子，jobid 在容器的 div 上，iframe 指向"脚本被污染"的模块页 */
function buildDecoyCardHtml() {
  var payload = { jobid: 'work-D', _jobid: 'work-D', workid: 'D', name: '被脚本污染的卷子' };
  var dataAttr = JSON.stringify(payload).replace(/"/g, '&quot;');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="card">' +
    '<div class="ans-attach-ct" id="tp-d" jobid="work-D" data="' + dataAttr + '">' +
    '<div class="ans-job-icon" aria-label="任务点"></div>' +
    '<div class="ans-attach-title">被脚本污染的卷子</div>' +
    '<iframe src="/decoy-outer" style="width:100%;height:260px;border:0"></iframe>' +
    '</div>' +
    '</div></body></html>';
}

function buildDecoyTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试 - 学习通</title></head><body>' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="/decoy-card" style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    '<script>window.attachments=[' +
    '{jobid:"work-D",property:{_jobid:"work-D",jobid:"work-D",mid:"mid-D",name:"被脚本污染的卷子",module:"work",type:"work"}}' +
    '];</script>' +
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

/**
 * 两个讨论任务点挂在同一页（两张卡片都**不带**可用的 isFinished）——
 * 用于验证「第一个做完之后，第二个还能不能被找到」与「旧"已发过"标记作废后能重扫」。
 *
 * ⚠️ 批次 20-G 之后，每张卡必须各自套一个任务盒 `.ans-attach-ct`（不带 `ans-job-finished`
 *    = 平台的说法是"这个还没做完"），盒里那份 `#isFinished` 是**空值** —— 这是真页面量出来的形状。
 *    原先这里只是两张光秃秃的卡片：读不出任何平台表态，于是自愈那条断言的前提
 *    （「平台说没完成 + 本地记过已发」）**根本不存在**，批次 20-A 把"读不出"和"未完成"分开之后，
 *    它就变成一条永远不会成立的断言（实测红：`healed:false`）。
 */
function buildDiscussionTwoHtml() {
  function card(id, title) {
    return '<div id="topicMainDiv" data="https://groupweb.chaoxing.com/course/topic' +
      '?clazzid=1&courseid=2&mtopicid=' + id + '&ut=s">' + title + '</div>';
  }
  function box(id, title) {
    return '<div class="ans-attach-ct"><i class="ans-job-icon" aria-label="任务点未完成"></i>' +
      '<input type="hidden" id="isFinished" value="">' + card(id, title) + '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div id="iframe">' +
    box(777, '讨论一：联系实际谈坚持党的全面领导') +
    box(888, '讨论二：说说你身边的变化') +
    '</div></body></html>';
}

/**
 * 批次 20-G 的现场形状（2026-11-11 章节 9000049219 一层一层量出来的）：
 *   顶层 studentstudy → iframe#iframe（knowledge/cards，4 个 `.ans-attach-ct` 任务盒）
 *     └ 盒里 iframe（ananas/modules/insertbbs）
 *          └ 再一层 iframe（mooc-ans/bbscircle）—— `#topicMainDiv[data]` 住在这里
 *   平台的说法写在**盒子**的 class 上（`ans-job-finished`）；卡片自己那份 `#isFinished` 是**空值**。
 *   ⚠️ 图标上的 `aria-label` 是坏的：实测连已完成的盒子也写着「任务点未完成」，夹具照抄这个坏值，
 *      这样断言才证明我们读的是 class、不是 aria。
 */
function buildDiscBoxTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body><div class="prev_title">章节</div>' +
    '<iframe id="iframe" src="/disc-box-cards"></iframe></body></html>';
}

/** cards 文档：3 个讨论盒（第 1 个未完成）+ 1 个作业盒 */
function buildDiscBoxCardsHtml() {
  function boxCls(finished) { return 'ans-attach-ct' + (finished ? ' ans-job-finished' : ''); }
  function jobBox(label) { return '<i class="ans-job-icon" aria-label="' + label + '"></i>'; }
  function discussBox(tag, finished) {
    // 三个盒子的 aria 一律写「任务点未完成」—— 真页面就是这样，只有 class 说了真话
    return '<div class="' + boxCls(finished) + '" job="' + (finished ? 'true' : 'false') + '">' +
      jobBox('任务点未完成') +
      '<div class="attach-name">讨论任务点 ' + tag + '</div>' +
      '<iframe src="/disc-box-mod-' + tag + '"></iframe>' +
      '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程卡片</title></head><body>' +
    '<div class="' + boxCls(true) + '" job="true">' + jobBox('任务点已完成') +
    '<div class="attach-name">作业（已完成，不是话题卡）</div>' +
    '<iframe src="/blank"></iframe></div>' +
    discussBox('A', false) + discussBox('B', true) + discussBox('C', true) +
    '</body></html>';
}

/** insertbbs 模块文档：只是再套一层，真页面就是这一层把话题页塞进来的 */
function buildDiscBoxModHtml(tag, id, title) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>讨论</title></head><body>' +
    '<iframe src="/disc-box-topic-' + tag + '"></iframe></body></html>';
}

/** bbscircle 文档：一张话题卡片 + 一个**空值**的 #isFinished（实测就是这样读不出结论） */
function buildDiscBoxTopicHtml(id, title) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>话题</title></head><body><div class="PublicCardBox">' +
    '<div id="topicMainDiv" data="https://groupweb.chaoxing.com/course/topic/view/x' +
    '?clazzid=1&courseid=2&mtopicid=' + id + '">' + title + '</div>' +
    '<input type="hidden" id="isFinished" value="">' +
    '</div></body></html>';
}

/**
 * 批次 20-I「目录标记说的是这一节做没做完吗」的夹具。
 *
 * ⚠️ 逐字抄自用户正在刷的那门课（2026-11-12 实地 `npm run field-shape` 一族探针量出来的）：
 *   `<div class="posCatalog_select posCatalog_active" id="cur9000049293">`
 *     `<span class="posCatalog_name" title="…" onclick="getTeacherAjax('900000001','900000002','9000049293');">13.2.1 …</span>`
 *     `<span class="icon_Completed prevTips"><span class="prevHoverTips">已完成<i></i></span></span>`
 *   `</div>`
 *   待完成那一节多一个 `<input type="hidden" value="1" class="jobUnfinishCount">`，
 *   图标换成 `<span class="catalog_points_yi prevTips"><span class="prevHoverTips">1个待完成任务点<i></i></span>`
 *   `<span class="orangeNew">1</span></span>`。
 * 全书只有这两种标记（`icon_Completed` 83 项 / `catalog_points_yi` 57 项），
 * **`.catalog_points_er` / `.catalog_points_san` 一个都没有** ——
 * 旧判据把 yi 当"已完成"、把 er/san 当"未完成"，方向整个是反的。
 * 这里刻意把 `posCatalog_active` 挂在**上一节（已完成）**、把主帧指向**新章节**，
 * 这就是真日志里 `chapter changed` 与 `skip completed {by:"catalog-marker",tasks:0}`
 * 同一秒的那个形状：目录上那一闪而过的 active 还属于上一节。
 */
function buildCatalogTopHtml() {
  function item(cid, name, no, tail) {
    return '<div class="posCatalog_select' + (cid === '9000049293' ? ' posCatalog_active' : '') +
      '" id="cur' + cid + '">' +
      '<span class="posCatalog_name" title="' + name + '" onclick="getTeacherAjax(\'900000001\',\'900000002\',\'' + cid + '\');">' +
      no + ' ' + name + ' </span>' + tail + '</div>';
  }
  var done = '<span class="icon_Completed prevTips"><span class="prevHoverTips">已完成<i></i></span></span>';
  var pending = '<input type="hidden" value="1" class="jobUnfinishCount">' +
    '<span class="catalog_points_yi prevTips"><span class="prevHoverTips">1个待完成任务点<i></i></span>' +
    '<span class="orangeNew">1</span></span>';
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div class="prev_title">问题二 这一节还没做完</div>' +
    '<div id="curCatalog"><div id="con1">' +
    item('9000049293', '问题一 这一节做完了', '13.2.1', done) +
    item('9000049294', '问题二 这一节还没做完', '13.2.2', pending) +
    '</div></div>' +
    '<iframe id="iframe" src="/catalog-cards?chapterId=9000049294&courseId=900000001"></iframe>' +
    '</body></html>';
}

/** 卡片层：**一个任务点都没有**（真页面里这种节只有正文），
 *  所以完成判定只能靠目录 —— 而这正是本批次要钉住的那条出口。
 *  ⚠️ 类名里不许出现 task / job、正文里不许出现「任务点」三个字，
 *     否则 `_hasTaskPoint()` 会被这三处撞灯，场景就测不到目录那条支。 */
function buildCatalogCardsHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程卡片</title></head><body>' +
    '<div class="content"><p>这一段只有正文，什么点都没有。</p></div>' +
    '</body></html>';
}

/** 没有主帧、没有正文那一份：`/no-course` 用来钉「非刷课页不许点前进」 */
function buildNoCourseHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>个人中心</title></head><body>' +
    '<div class="ui-avatar">这里没有课程结构</div>' +
    '</body></html>';
}

/**
 * 投票任务点（批次 21，2026-11-11 真页实测章节 9000049220 —— 那一节只剩这一个未完成盒）。
 *
 * 真页面是「点封面才长出覆盖层」这条链，四层逐一照抄：
 *   /vote        顶层：只有 #iframe + `window.attachments`（module=insertvote、job=true）
 *   /vote-cards  卡片层：一个**未完成**的 `.ans-attach-ct` 盒，里面挂投票封面帧
 *   /vote-cover  封面帧：只有图标与标题（`.ans-cmp-icon.ans-cmp-iconVote#cover`）
 *                加一个可点的 `#render`。**关键形状**：真页面的内联脚本在点击那一刻
 *                才往**顶层文档**写 `#voteIframe` 并 show `.voteContainer`；
 *                直接导航那个地址是 403（enc/ktoken 由服务端算），所以覆盖层
 *                只能由平台脚本自己拼出来 —— 夹具也必须在这一跳里拼
 *   /vote-inner  覆盖层里那份投票：`ul.topic-options > li.topic-option-list >
 *                div.optionRadio > input[type=radio][name=answer…]` +
 *                `a.btn.jb_btn_92.btn-submit`「提交」+ 一个「已到截止时间」提示框
 */
/**
 * 顶层学习页。
 *
 * ⚠️ `.voteContainer` 与 `#voteIframe` 是**平台出厂就带**的（2026-11-11 实地逐字量出来的）：
 *   `<body class="popOverflow" id="body-content">` 下挂着
 *   `<div class="voteContainer"><iframe width="100%" height="100%" src="" id="voteIframe" frameborder="0">`，
 *   收起状态由**样式表**决定（`getComputedStyle().display === 'none'`，标签上没有 style），
 *   里面那份文档是 `about:blank`（readyState=complete、0 个字、0 个 radio）。
 *   原先这份夹具是"点了封面才把覆盖层拼出来"的形状 —— 那正好是本次实测的缺陷**测不出来**的形状：
 *   代码第一眼看到的 `#voteIframe` 必须来自出厂 DOM，不然"复用了一份空壳"这件事永远只能靠手工种。
 */
function buildVoteTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>投票 - 学习通</title>' +
    '<style>.voteContainer{display:none;position:fixed;left:0;top:0;width:560px;height:440px;background:#fff}</style>' +
    '</head><body class="popOverflow" id="body-content">' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="/vote-cards" style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    '<div class="voteContainer">\n\t' +
    '<iframe width="100%" height="100%" src="" id="voteIframe" frameborder="0"></iframe>' +
    '</div>' +
    '<script>window.__coverClicks=0;window.__backClicks=0;window.__dialogDismissed=0;' +
    'window.attachments=[' +
    '{jobid:"vote-1",name:"made in china 是让你自豪的标签吗？",' +
    'property:{_jobid:"vote-1",jobid:"vote-1",name:"投票",module:"insertvote",type:"vote",job:true},' +
    'job:true}]</script>' +
    '</body></html>';
}

function buildVoteCardsHtml() {
  var payload = { jobid: 'vote-1', _jobid: 'vote-1', workid: '9001', name: '投票' };
  var dataAttr = JSON.stringify(payload).replace(/"/g, '&quot;');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节</title></head><body>' +
    '<div class="ans-attach-ct" id="tp-vote">' +
    '<i class="ans-job-icon" aria-label="任务点未完成"></i>' +
    '<div class="attach-name">投票：made in china 是让你自豪的标签吗？</div>' +
    '<iframe jobid="vote-1" data="' + dataAttr + '" ' +
    'src="/ananas/modules/zt/vote/index-pc-new.html?jobid=vote-1" ' +
    'style="width:100%;height:120px;border:0"></iframe>' +
    '</div></body></html>';
}

/**
 * 封面帧：只有图标 + 标题，点 `#render` 才由平台的脚本把卷子挂进**顶层那份出厂覆盖层**。
 *
 * ⚠️ 实地形状：顶层的 `.voteContainer` / `#voteIframe` **本来就在那儿**（见 buildVoteTopHtml），
 *    平台这段脚本只做两件事 —— 写 `src`、把容器放出来。夹具以前是"没有就现造一个"，
 *    那等于把要验的那个前提（第一眼就有一份空壳摆在顶层）抹掉了。
 *
 * `__coverClicks` 记在**顶层** window 上，因为「覆盖层被点了几次」正是本场景
 *    要盯的行为：一份空文档被当成"就绪"时，runner 会跳过这一跳，于是永远拿不到卷子
 *    （2026-11-11 实测的第一轮就是这么红的 —— `vote has nothing to submit {text:""}`）。
 */
function buildVoteCoverHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>投票</title><style>.ans-cmp-icon{width:40px;height:40px;display:inline-block}</style>' +
    '</head><body>' +
    '<div id="render" style="width:220px;height:80px">' +
    '<i class="ans-cmp-icon ans-cmp-iconVote" id="cover"></i>' +
    '<div class="ans-cmp-title">made in china 是让你自豪的标签吗？</div>' +
    '</div>' +
    '<script>' +
    'document.getElementById("render").addEventListener("click", function () {' +
    '  var top = window.top;' +
    '  top.__coverClicks = (top.__coverClicks || 0) + 1;' +
    '  var box = top.document.querySelector(".voteContainer");' +
    '  var f = top.document.getElementById("voteIframe");' +
    '  if (!box || !f) return;' +
    '  box.style.display = "block";' +
    '  f.src = "/mooc2/work/vote?jobid=vote-1&type=vote&ktoken=KT&enc=ENC";' +
    '});' +
    '</script></body></html>';
}

/**
 * 覆盖层里那份投票：两个 radio + 一个「提交」。
 *
 * 提交后做两件真页面会做的事：① 把**顶层**那个任务盒加上 `ans-job-finished`
 * （平台改的就是这个 class，完成判定只认它）；② 弹出「已到截止时间，作答内容
 * 已自动提交」提示框 —— 插件要点掉「知道了」，而且**不许**点成「提交」（会二次提交）。
 * 勾选与提交都记在本帧 window 上，供断言取**勾选证据**。
 */
function buildVoteInnerHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>投票</title></head><body>' +
    '<div class="ans-qt-list">' +
    '<div class="qt-title">made in china 是让你自豪的标签吗？</div>' +
    '<ul class="topic-options">' +
    '<li class="topic-option-list"><div class="optionRadio">' +
    '<input type="radio" name="answer8000083064" value="A" /><span>A. 是</span></div></li>' +
    '<li class="topic-option-list"><div class="optionRadio">' +
    '<input type="radio" name="answer8000083064" value="B" /><span>B. 否</span></div></li>' +
    '</ul>' +
    '<a href="javascript:void(0)" class="btn jb_btn_92 btn-submit color-white">提交</a>' +
    '<a href="javascript:void(0)" class="icon-back">返回</a>' +
    '</div>' +
    '<div class="maskDiv" id="endTimeDialog" style="display:none">' +
    '<div class="popDiv wid440 height212" style="width:440px;height:212px">' +
    '<div class="popTop">提示</div>' +
    '<div class="popCenter">已到截止时间，作答内容已自动提交</div>' +
    '<a href="javascript:void(0)" class="btn" id="knowBtn">知道了</a>' +
    '</div></div>' +
    '<script>' +
    // 任务盒在**卡片层文档**里（真页面也是这样：覆盖层挂顶层、盒子留在 article 帧），
    // 所以这里必须穿过 #iframe 去改 class，不能在外层文档里找。
    'var voteBoxOfTop=function(){' +
    '  try {' +
    '    var d=window.top.document.getElementById("iframe");' +
    '    var cd=d&&(d.contentDocument||(d.contentWindow&&d.contentWindow.document));' +
    '    return cd?cd.querySelector(".ans-attach-ct"):null;' +
    '  } catch (e) { return null; }' +
    '};' +
    'window.__submitted=0;window.__picked="";' +
    'document.querySelector(".btn-submit").addEventListener("click", function () {' +
    '  window.__submitted++;' +
    '  var on=[];' +
    '  var ins=document.querySelectorAll("input[type=radio]");' +
    '  for(var i=0;i<ins.length;i++){ if(ins[i].checked) on.push(ins[i].value); }' +
    '  window.__picked=on.join(",");' +
    '  var box=voteBoxOfTop();' +
    '  if(box && String(box.className).indexOf("ans-job-finished")<0){ box.className+=" ans-job-finished"; }' +
    '  document.getElementById("endTimeDialog").style.display="block";' +
    '});' +
    'document.getElementById("knowBtn").addEventListener("click", function () {' +
    '  window.top.__dialogDismissed=(window.top.__dialogDismissed||0)+1;' +
    '  document.getElementById("endTimeDialog").style.display="none";' +
    '});' +
    'document.querySelector(".icon-back").addEventListener("click", function () {' +
    '  window.top.__backClicks=(window.top.__backClicks||0)+1;' +
    '  window.top.document.querySelector(".voteContainer").style.display="none";' +
    '});' +
    '</script></body></html>';
}

/**
 * 「当前章节还有任务点未完成，是否去完成？」这道门（批次 20-G 实测到的两种形状）。
 * ⚠️ onclick 逐字照抄真页面（`scroll2Job` / `PCount.next('1','9000049219',…)` / `WAY.box.hide()`），
 *    只在前面加一句计数 —— 因为旧代码在这里点到的是「下一节」，而真页面的「下一节」
 *    正是靠这段 onclick 走的；夹具若换成一个不带这些字样的干净按钮，`/scroll2Job/` 那半优先级
 *    根本没被走到（AGENTS §5「夹具要长得像现场，不像实现」）。
 *    平台那几个函数在这里打桩，点了不报错。
 */
function buildUnfinishedPromptHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title><style>' +
    '.maskDiv{position:fixed;left:20px;top:20px;width:440px;height:180px;background:#fff}' +
    '</style></head><body>' +
    '<div id="iframe"></div>' +
    '<div class="maskDiv jobFinishTip"><div class="popDiv wid440">' +
    '<div class="popTop">提示</div>' +
    '<div class="popCenter">当前章节还有任务点未完成，是否去完成？</div>' +
    '<div class="popBottom">' +
    '<a class="jb_btn jb_btn_92 fr fs14 preChapter" href="javascript:void(0)" ' +
    'onclick="window.__pre=(window.__pre||0)+1">上一节</a>' +
    '<a class="jb_btn jb_btn_92 fr fs14 nextChapter" href="javascript:void(0)" ' +
    'onclick="window.__next=(window.__next||0)+1;closeDeleteWindow();PCount.next(\'1\',\'9000049219\',\'900000001\',\'\')">下一节</a>' +
    '<a class="btnBlue btn_92_cancel fr fs14 popMoveDel" href="javascript:void(0)" ' +
    'onclick="window.__job=(window.__job||0)+1;scroll2Job()">去学习</a>' +
    '<a class="popClose fr" href="javascript:void(0)" ' +
    'onclick="window.__close=(window.__close||0)+1"></a>' +
    '</div></div></div>' +
    '<div id="jobFinishTip" class="AlertCon02" style="display:none">' +
    '<div class="con03 marTop30">当前章节还有任务点未完成，是否去完成？</div>' +
    '<a class="bluebtn02 prebutton nextChapter" href="javascript:void(0)" ' +
    'onclick="window.__next2=(window.__next2||0)+1;WAY.box.hide();PCount.next(\'1\',\'9000049219\',\'900000001\',\'\')">下一节</a>' +
    '<a class="graybtn02 marleft10 nextbutton" href="javascript:void(0)" ' +
    'onclick="window.__job2=(window.__job2||0)+1;WAY.box.hide();scroll2Job()">去学习</a>' +
    '</div>' +
    '<script>window.__pre=0;window.__next=0;window.__job=0;window.__close=0;' +
    'window.__next2=0;window.__job2=0;' +
    'window.scroll2Job=function(){window.__scroll2JobCalls=(window.__scroll2JobCalls||0)+1;};' +
    'window.closeDeleteWindow=function(){};' +
    'window.PCount={next:function(){window.__nextReal=(window.__nextReal||0)+1;}};' +
    'window.WAY={box:{hide:function(){}}};</script>' +
    '</body></html>';
}

/** 空白页：只用来跑纯逻辑断言，不需要任何特定 DOM */
function buildBlankHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body><div id="iframe"></div></body></html>';
}

/**
 * ---- 批次 35：主内容帧被换成跨域地址时的那两页 ----
 *
 * 现场形状（同学那边「看不到下面那个录音，然后卡死了」）：顶层还是课程页，
 * `#iframe` 的 src 被平台换走了 → JS 读不到里面 → page.js 什么都做不了，
 * 只能整页刷新。刷新本身会**抹掉页面内存**，所以这一族的全部风险都在"账记在哪儿"。
 *
 * 两种跨域必须分开测，因为修法完全不同：
 *   同站（mooc2 ≠ mooc1，站点相同、origin 不同）→ 多半是验证/反爬中间页，刷新有机会解决 → 有预算地刷
 *   别家（localhost）                       → 刷完还是它                        → 一次都不刷
 * ⚠️ 别用"同 host 换端口"造跨域：那一族在某些引擎里会留在可读的 about:blank 上，
 *    判据会直接变成空测。换 host 才是真的读不到。
 */
function buildBlockedInnerHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>内容帧</title></head><body><div class="content">这里是被换走的内容帧</div></body></html>';
}

function buildBlockedFrameTopHtml(frameHost) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="' + frameHost + PORT + '/blocked-inner" ' +
    'style="width:100%;height:700px;border:0"></iframe>' +
    '</div></body></html>';
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

/**
 * 独立验证码网址：顶层页面、没有课程结构、URL 与文案都命中验证码特征
 *
 * ⚠️ 那两样「像题」的装饰不是随手加的：`_computeStandaloneCaptchaPage` 以前把
 * `_quizDetectorSelector` 命中当作「这不是验证码页」的凭据之一 —— 于是页面上挂一个
 * `.question-content` 就永远轮不到验证码处理（批次 2 的 D 项换成 `_documentHasQuiz`）。
 * 留在这里，上面那条断言才真的钉住这次替换：谁退回旧判据，它就红。
 */
function buildStandaloneCaptchaHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>安全验证</title></head><body>' +
    '<h2>安全验证</h2>' +
    '<p>请输入验证码以继续访问</p>' +
    // 像题、但题里没有能填的控件（`#inputCode` 不匹配 `_quizAnswerControlSelector`）
    '<div class="question-content">为继续学习请完成下方安全验证</div>' +
    '<div class="answerOption"><span>我是人类</span></div>' +
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

/**
 * 视频内嵌**多选题**弹窗。
 *
 * ⚠️ 口径已变（README §6 #49）：以前这里写的是「非视频整卷的多选改成本地作答、
 * 不进请求，所以只剩弹题这条路会把多选交给模型」—— 那句话已经不成立。
 * 现在多选**默认就问模型**（本地只剩幂等补填与判错后的兜底），
 * 于是"模型把多选答案摊平成一串字母"这种退化形状**两条路都会出现**。
 * 这个夹具仍然要留着，但理由换成：`resegmentFlatAnswers` 守的是**弹题**这条链，
 * 它和整卷走的是两套填题代码（`80-popup-quiz.js` / `75-quiz-dom.js`），
 * 只测整卷那条，弹题这条坏了不会有人报警。
 */
function buildPopupQuizMultiHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>视频学习 - 学习通</title></head><body>' +
    '<video id="v"></video>' +
    '<div class="ans-pop-quiz" style="position:fixed;left:60px;top:60px;width:460px;height:240px;background:#fff;border:2px solid #333;z-index:9999;padding:16px">' +
    '  <div class="pop-quiz-title">1. 下列说法正确的有哪几项？（多选）</div>' +
    '  <ul class="pop-quiz-options">' +
    '    <li class="pop-quiz-option"><input type="checkbox" name="pqm" value="A"><span>A. 说法甲</span></li>' +
    '    <li class="pop-quiz-option"><input type="checkbox" name="pqm" value="B"><span>B. 说法乙</span></li>' +
    '    <li class="pop-quiz-option"><input type="checkbox" name="pqm" value="C"><span>C. 说法丙</span></li>' +
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

/**
 * 「确认交卷弹窗把提交次数记到另一个键上」（2026-11-10 批次 8）。
 *
 * 形状照着真实 mooc2 卡片搭：**外层文档的 id 是残缺的**（只有 courseId + knowledgeid），
 * 题目挂在另一个 iframe 里、那份文档五个 id 齐全。于是
 * `_getQuizWorkKey(null)`（经 `_resolveQuizSubmitDocument` 退回外层）算出的键
 * 与 `_getQuizWorkKey(题目文档)` 的键**不是同一个** ——
 * 提交次数记在 A 本账、交卷上限读 B 本账，「按卷最多 2 次」形同不存在。
 * 用户日志里那个 `courseId||||knowledgeid`（中间三段全空）就是 A 本账的样子。
 */
function buildSubmitKeyShellHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验 - 学习通</title></head><body>' +
    '<input type="hidden" id="courseId" value="123456">' +
    '<input type="hidden" id="knowledgeid" value="K777">' +
    '<iframe id="quizFrame" src="/submit-key-inner" style="width:100%;height:640px;border:0"></iframe>' +
    // 交卷确认框：**外层**文档里（真实页面就长这样 —— 弹窗在外、题目在帧里）
    '<div id="omConfirmLayer" class="layui-layer" ' +
    '  style="position:fixed;left:24px;top:24px;width:320px;height:170px;background:#fff;border:2px solid #333;z-index:9999">' +
    '  <div class="layui-layer-content" id="popcontent">请完成所有题目，确认提交？</div>' +
    '  <a id="omConfirmOk" class="layui-layer-btn0">确定</a>' +
    '  <a id="omConfirmClose" class="layui-layer-close2">×</a>' +
    // 真实平台的「很遗憾，未达到及格线，请重做」也是这一族弹窗：它**没有**「确认提交」字样，
    // 靠的是 `#popcontent` + `#popok` 这组结构才被 `_isSubmitConfirmDialog` 收下。
    // 少了它，下面 redo 那一节连"弹窗被找到"这一步都进不去，等于测了个空。
    // 藏在视口外：它是结构凭证，不该抢走「确定」那一次真实点击。
    '  <a id="popok" style="position:absolute;left:-9999px;top:0">确定</a>' +
    '</div>' +
    '<script>' +
    'window.__omOkClicks = 0; window.__omCloseClicks = 0;' +
    'document.getElementById("omConfirmOk").addEventListener("click", function () { window.__omOkClicks++; }, false);' +
    'document.getElementById("omConfirmClose").addEventListener("click", function () { window.__omCloseClicks++; }, false);' +
    '</script>' +
    '</body></html>';
}

/** 确认框夹具的内层：题目 + 五个 id 齐全（与外层那份残缺文档**故意**不是同一个键） */
function buildSubmitKeyInnerHtml() {
  return buildQuizHtml().replace(
    '<h1 class="mark_title">',
    '<input type="hidden" id="jobid" value="J4242">' +
    '<input type="hidden" id="knowledgeid" value="K777">' +
    '<h1 class="mark_title">'
  );
}

var MOCK_PAGES = {
  '/quiz': buildQuizHtml,
  // 章节测验的现场形状（题同 `/quiz`，补上真实提交入口那一层：btnBlueSubmit + .btnSubmit + #form1）
  '/quiz-real': buildQuizRealHtml,
  '/chapter-quiz': buildChapterQuizShellHtml,
  '/quiz-inner': buildChapterQuizInnerHtml,
  '/exam-work': buildExamWorkHtml,
  '/quiz-result': buildQuizResultHtml,
  '/weird': buildWeirdHtml,
  '/media': buildMediaHtml,
  '/media-90': buildNinetyPercentHtml,
  '/blank': buildBlankHtml,
  // 批次 35：主内容帧跨域的三页（两种跨域 + 被换走的那一页本身）
  '/blocked-inner': buildBlockedInnerHtml,
  '/blocked-same-site': function () { return buildBlockedFrameTopHtml('http://mooc2.chaoxing.com:'); },
  '/blocked-off-site': function () { return buildBlockedFrameTopHtml('http://localhost:'); },
  '/captcha-dialog': buildCaptchaDialogHtml,
  '/captcha-verify': buildStandaloneCaptchaHtml,
  '/discussion': buildDiscussionHtml,
  '/discussion-multi': buildDiscussionMultiHtml,
  '/discussion-two': buildDiscussionTwoHtml,
  // ── 批次 20-G：真页面一层一层量出来的形状（完成与否写在**盒子**的 class 上，卡片里那份 #isFinished 是空值）──
  '/disc-box': buildDiscBoxTopHtml,
  '/disc-box-cards': buildDiscBoxCardsHtml,
  '/disc-box-mod-A': function () { return buildDiscBoxModHtml('A', '9001', '阐述你对美好生活有什么样的期待'); },
  '/disc-box-mod-B': function () { return buildDiscBoxModHtml('B', '9002', '结合专业谈谈怎么创造美好生活'); },
  '/disc-box-mod-C': function () { return buildDiscBoxModHtml('C', '9003', '说说你身边的变化'); },
  '/disc-box-topic-A': function () { return buildDiscBoxTopicHtml('9001', '阐述你对美好生活有什么样的期待'); },
  '/disc-box-topic-B': function () { return buildDiscBoxTopicHtml('9002', '结合专业谈谈怎么创造美好生活'); },
  '/disc-box-topic-C': function () { return buildDiscBoxTopicHtml('9003', '说说你身边的变化'); },
  // ── 批次 20-I：目录标记的现场形状（`id="cur<chapterId>"` + icon_Completed「已完成」
  //    / catalog_points_yi「N个待完成任务点」+ input.jobUnfinishCount）；
  //    /no-course 是"页面被推到没有课程结构的地方"那一族 ──
  '/catalog': buildCatalogTopHtml,
  '/catalog-cards': buildCatalogCardsHtml,
  '/no-course': buildNoCourseHtml,
  '/vote': buildVoteTopHtml,
  '/vote-cards': buildVoteCardsHtml,
  '/ananas/modules/zt/vote/index-pc-new.html': buildVoteCoverHtml,
  '/mooc2/work/vote': buildVoteInnerHtml,
  '/vote-empty-inner': function () { return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>空白</title></head><body></body></html>'; },
  '/unfinished-prompt': buildUnfinishedPromptHtml,
  '/two-quizzes': buildTwoQuizTopHtml,
  '/two-quizzes-divjob': buildTwoQuizzesDivJobIdTopHtml,
  '/wq-card-divjob': buildTwoQuizCardDivJobIdHtml,
  '/decoy-top': buildDecoyTopHtml,
  '/decoy-card': buildDecoyCardHtml,
  '/decoy-outer': buildDecoyScriptOuterHtml,
  '/wq-card': buildTwoQuizCardHtml,
  // ⚠️ 这几条的路径必须与 builder 里拼出来的 src **大小写完全一致**
  //    （jobid 用 'work-A' / 'work-B'，URL 里就是 /wq-outer-A …）
  '/wq-outer-A': function () { return buildTwoQuizOuterHtml('A'); },
  '/wq-outer-B': function () { return buildTwoQuizOuterHtml('B'); },
  '/wq-mid-A': function () { return buildTwoQuizMidHtml('A'); },
  '/wq-mid-B': function () { return buildTwoQuizMidHtml('B'); },
  '/wq-inner-A': function () { return buildTwoQuizInnerHtml('A', true); },
  '/wq-inner-B': function () { return buildTwoQuizInnerHtml('B', false); },
  '/popup-quiz': buildPopupQuizHtml,
  '/popup-quiz-native': buildPopupQuizNativeHtml,
  '/popup-quiz-multi': buildPopupQuizMultiHtml,
  '/popup-quiz-blank': buildPopupQuizBlankHtml,
  '/video-continue': buildVideoContinueHtml,
  '/mooc2-work': buildMooc2WorkHtml,
  '/font-residue': buildFontResidueHtml,
  '/doc-pdfjs': buildPdfJsDocHtml,
  '/doc-ppt': buildPptAudioHtml,
  '/ppt-decoy': buildPptDecoyTopHtml,
  '/ppt-decoy-card': buildPptDecoyCardHtml,
  '/ppt-decoy-inner': buildPptDecoyInnerHtml,
  '/submit-key': buildSubmitKeyShellHtml,
  '/submit-key-inner': buildSubmitKeyInnerHtml,
  '/mycourse/studentstudy': buildStudyDiscussionDecoyHtml,
  '/course/topic/discuss': buildRealDiscussionHtml,
  '/frame-sig': buildFrameSigHtml,
  '/frame-sig-inner': buildFrameSigInnerHtml,
  '/frame-sig-first': buildFrameSigFirstHtml,
  '/nested-paper': buildNestedPaperTopHtml,
  '/nested-paper-cards': buildNestedPaperCardsHtml,
  '/nested-paper-work': buildNestedPaperWorkHtml,
  '/nested-paper-quiz': buildNestedPaperQuizHtml
};

/**
 * 批次 9-A 的现场夹具：**刷课页**长得像讨论页。
 * 真实日志 00:46:26 —— 卷子刚 `quiz submit pending`，插件却报 `discussion page detected`，
 * 往平台真发了一条内容「1」的回帖，点的还是文字含「提交」的按钮（很可能就是那份卷子的提交按钮）。
 * 三个放宽叠起来才会成这样，所以夹具把三个都摆上：
 *   ① `omitone_return_url` 刚写过（连"新鲜度"这道闸都要靠批次 9-A 的刷课页网址硬拦）；
 *   ② 正文导航里有「讨论」二字（bodyHit）；
 *   ③ 页面有一个可见 contenteditable 大块 + 一个**不同容器里**的「提交」按钮。
 */
function buildStudyDiscussionDecoyHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>第三章 社会主义建设道路初步探索 - 学习通</title></head><body>' +
    '<div id="courseTabs"><a>章节</a><a>讨论</a><a>作业</a><a>考试</a></div>' +
    '<div id="knowledgeColumn"><div>本节目录：课后检测、讨论、视频资料</div>' +
    // 编辑区：课程页右侧常年挂着的一块可见可输入区域（真实页面上它是笔记/留言小工具）
    '<div id="notePad" contenteditable="true" style="width:420px;height:120px;border:1px solid #ccc"></div>' +
    '</div>' +
    // 「提交」按钮在**另一个容器**里 —— 它就是那份卷子要点的按钮
    '<div id="quizBar"><button id="quizSubmit" style="width:90px;height:32px">提交</button></div>' +
    '<script>window.__submitClicks=0;' +
    'document.getElementById("quizSubmit").addEventListener("click",function(){window.__submitClicks++;});' +
    // 故意把放宽的两条都写成"刚刚发生"，证明刷课页这一关是**硬拦**
    'try{localStorage.setItem("omitone_return_url",location.href);' +
    'localStorage.setItem("omitone_return_url_at",String(Date.now()));}catch(e){}' +
    '</script></body></html>';
}

/** 批次 9-A 的对照组：真讨论页（编辑区与发布按钮同容器），收紧判据后**仍要**认得出来 */
function buildRealDiscussionHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程讨论</title></head><body>' +
    '<div id="subPageMain"><div class="replyEdit">' +
    '<textarea placeholder="回复" style="width:520px;height:120px"></textarea>' +
    '<div class="replyEditBtnGroup"><a class="jb_btn" id="doReply" style="width:80px;height:30px">回复</a></div>' +
    '</div></div></body></html>';
}

/**
 * 批次 9-D 的取证夹具：两份卷子，第二份藏在 `javascript:` 那族帧里。
 * 真实日志 00:46:55 的 `frames:8` 里有 4 个 `javascript:void(function(){document.open`
 * 和 3 个 `javascript:` 全被拒成「认不出任务类型」—— 旧日志看不出那是空帧还是第二份卷子。
 * 结构照真实页面：外层只有 `#iframe`，任务点数据与那些帧都在主帧文档里。
 *
 * ⚠️ 第二份卷子的容器故意用 `question_item`：它只被 `_questionSelectors` 里
 *    **第 15 条** `div[class*="question"]` 命中，不在准入闸用的 `_quizDetectorSelector`
 *    （精确类名）里 —— 这正是真实日志 00:46:04 的形状（`matchedSelectors:{"div[class*=\"question\"]":1}`
 *    却 `found 0 questions`、整帧被拒）。夹具若只用 `.TiMu`，`qTotal` 数前 5 条也能过，
 *    就再也抓不到"总数只数了前几条"这类取数错误（批次 10-A 实测就是这样暴露的）。
 */
function buildFrameSigHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>学习通</title></head><body>' +
    '<iframe id="iframe" src="/frame-sig-inner" style="width:100%;height:720px;border:0"></iframe>' +
    '</body></html>';
}

function buildFrameSigInnerHtml() {
  // 写内容一律用 DOM API（createElement / className / textContent），
  // 避免 document.write 里再套一层引号 —— 那种转义在本仓库已静默吃过好几次亏。
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试</title></head><body>' +
    '<div id="curKpointId" style="display:none">9000049549</div>' +
    '<iframe id="fFirst" src="/frame-sig-first" data="{&quot;jobid&quot;:&quot;job-first&quot;}" style="width:100%;height:420px;border:0"></iframe>' +
    // 第二份卷子：藏在 javascript: 帧里，这一层没有 jobid
    '<iframe id="fPaper" src="javascript:;" style="width:620px;height:400px;border:0"></iframe>' +
    // 真·空帧，作对照：签名应当全是 0
    '<iframe id="fEmpty" src="javascript:void(function(){document.open" style="width:620px;height:400px;border:0"></iframe>' +
    '<script>' +
    'window.attachments=[{jobid:"job-first",name:"单元测试",property:{job:"true"},otherInfo:"nodeId_9000049549"}];' +
    'function seed(id,blocks){var f=document.getElementById(id);var d=f&&f.contentDocument;' +
    'if(!d)return false;d.open();d.write("<div></div>");d.close();' +
    'blocks.forEach(function(b){var e=d.createElement("div");e.className=b[0];e.textContent=b[1];d.body.appendChild(e);});' +
    'var inp=d.createElement("input");inp.type="radio";inp.name="q2";inp.value="A";d.body.appendChild(inp);' +
    'var hd=d.createElement("input");hd.type="hidden";hd.id="answer2";d.body.appendChild(hd);' +
    'return d.body.children.length>0;}' +
    'window.__paperReady=seed("fPaper",[["question_item"," "],["QType","[单选题]"],' +
    '["qt","第二份卷子：下列哪一项是社会主义改造的对象？"],["ot","A 资本主义工商业"],["ot","B 个体农业"]]);' +
    'window.__emptyReady=seed("fEmpty",[]);' +
    '</script></body></html>';
}

/** 第一份卷子（带 jobid 的那一帧）：让"第一个做了"在现场里是真做得成的 */
function buildFrameSigFirstHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>单元测试</title></head><body>' +
    '<div class="TiMu"><div class="questionLi">' +
    '<div class="QType">[单选题]</div>' +
    '<div class="qt">第一份卷子：社会主义改造的对象包括哪一项？</div>' +
    '<div class="ot"><label>A 资本主义工商业</label><input type="radio" name="q1" value="A"></div>' +
    '<div class="ot"><label>B 官僚资本</label><input type="radio" name="q1" value="B"></div>' +
    '<div class="answer"><input type="hidden" id="answer1" value=""></div>' +
    '</div></div></body></html>';
}

/**
 * 批次 13-A 的现场夹具：卷子埋在**第三层**文档里。
 * 这是 2026-11-11 用真实页面量出来的形状，不是编的：
 *   top(/mycourse/studentstudy) → #iframe(/mooc-ans/knowledge/cards)
 *     → iframe.ans-attach-…(/ananas/modules/work/index.html)
 *       → #frame_content(/mooc2-ans/work/doHomeWorkNew)   ← 题目在这一份里
 * 旧 `_resolveQuizAnswerDocument` 只会从当前文档找**一层** id=`frame_content`：
 * 卡片文档里没有这个 id，于是原样返回卡片文档。而卡片页每条任务点后面都写着
 * 「任务点已完成」/带 `.ans-job-finished` —— `_isDocumentFrameFinished` 当场为真，
 * `_extractQuestions(null)` 又数出 0 道题，于是「题还没做」被宣布成「这一节已完成」。
 * 夹具因此故意把「已完成」放在**卡片页**、把题放在**第三层**。
 */
function buildNestedPaperTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>刷课</title></head><body>' +
    '<iframe id="iframe" src="/nested-paper-cards" style="width:100%;height:720px;border:0"></iframe>' +
    '</body></html>';
}

function buildNestedPaperCardsHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>知识卡片</title></head><body>' +
    '<div id="curKpointId" style="display:none">9000049001</div>' +
    // 已完成的那条任务点（PPT）：卡片页满屏都是这种字，正是旧判据上当的地方
    '<div class="ans-line-height"><span class="ans-job-finished">任务点已完成</span><span>PPT课件</span></div>' +
    '<div class="ans-job-insert-online"><iframe class="ans-attach-online ans-attach-oc" ' +
    'src="/nested-paper-work" data="{&quot;jobid&quot;:&quot;job-nested&quot;}" ' +
    'style="width:100%;height:520px;border:0"></iframe></div>' +
    '<script>window.attachments=[{jobid:"job-nested",name:"单元测试",property:{job:"true"},' +
    'otherInfo:"nodeId_9000049001"}];</script></body></html>';
}

function buildNestedPaperWorkHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>作业</title></head><body>' +
    '<iframe id="frame_content" src="/nested-paper-quiz" style="width:100%;height:500px;border:0"></iframe>' +
    '</body></html>';
}

function buildNestedPaperQuizHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>做题</title></head><body>' +
    '<div class="TiMu"><div class="questionLi">' +
    '<div class="QType">[单选题]</div>' +
    '<div class="qt">（埋了三层的那份卷子）下列哪一项是社会主义改造的对象？</div>' +
    '<div class="ot"><label>A 资本主义工商业</label><input type="radio" name="qN" value="A"></div>' +
    '<div class="ot"><label>B 官僚资本</label><input type="radio" name="qN" value="B"></div>' +
    '<div class="answer"><input type="hidden" id="answerN" value=""></div>' +
    '</div></div>' +
    '<button class="btnSubmit" id="btnBlueSubmit">提交</button>' +
    '</body></html>';
}

/**
 * PPT 带音频任务（真实结构）：swiper 幻灯片 + 官方翻页按钮，翻到末页后按钮禁用。
 * 音频由场景内接管（真实页面上等的是音频播完），翻页器契约是本场景的验证对象。
 */
function buildPptAudioHtml() {
  var slides = ['第 1 页', '第 2 页', '第 3 页', '第 4 页'].map(function (t, i) {
    return '<div class="swiper-slide"' + (i ? ' style="display:none"' : '') + '>' + t + '</div>';
  }).join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>PPT - 学习通</title></head><body>' +
    '<div class="ans-job-icon" style="display:none"></div>' +
    '<div class="swiper-container"><div class="swiper-wrapper">' + slides + '</div></div>' +
    '<div class="swiper-button-next"></div>' +
    '<script>' +
    'var idx = 1, total = 4;' +
    'function syncPpt() { var s = document.querySelectorAll(".swiper-slide");' +
    '  s.forEach(function (el, i) { el.style.display = i < idx ? "" : "none"; });' +
    '  var b = document.querySelector(".swiper-button-next");' +
    '  if (idx >= total) b.classList.add("swiper-button-disabled"); }' +
    'document.querySelector(".swiper-button-next").addEventListener("click", function () {' +
    '  if (idx < total) { idx++; syncPpt(); } });' +
    'window.finishJob = function () { window.__pptFinished = true; };' +
    'syncPpt();' +
    '</script></body></html>';
}

/**
 * ---- 「课件帧挂着题面样式类名」三件套（2026-11-10 批次 2「刷 PPT 报废」）----
 *
 * 现场形状：轮盘 PPT 的帧里带 `.question-content` / `.answerOption` 这类
 * **通用装饰类名**，而旧判据是「`_quizDetectorSelector` 命中 = 这是测验」，
 * 于是这一帧被仲裁成 quiz —— 阅读链路（`_runChaoxingReadJob`）永远轮不到，
 * 同时 `_detectQuiz()` 恒为真把 `_tryAdvanceIdleSection` 的逃生门也冻住：两条腿一起瘫。
 *
 * 三层结构与真实页面一致：顶层 `#iframe` → 学习卡片 → 任务点帧（jobid 在 data 上）。
 */
function buildPptDecoyTopHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课件学习 - 学习通</title></head><body>' +
    '<div class="course_main">' +
    '<iframe id="iframe" src="/ppt-decoy-card" style="width:100%;height:700px;border:0"></iframe>' +
    '</div>' +
    // 附件只说得出「read 家族」这一个粒度，具体是图片阅读 / 轮盘 PPT / 翻页文档由 DOM 定
    '<script>window.attachments=[' +
    '{jobid:"ppt-9002",property:{_jobid:"ppt-9002",jobid:"ppt-9002",mid:"mid-ppt-9002",' +
    'name:"轮盘课件",module:"ppt",type:"ppt",job:true}}' +
    '];</script>' +
    '</body></html>';
}

/**
 * 卡片层：一个任务点容器，jobid 同时挂在 iframe 的 jobid 属性与 data 上
 *
 * ⚠️ 卡片层也挂一样「像题」的装饰，和课件层那两样是**不同**的用途：
 * `_isTextOnly()`（视觉预算与「本页没任务就跳过」分支的开关）读的是**主文档**，
 * 也就是这一层；它以前同样拿 `_quizDetectorSelector` 判「这页有没有题」
 * （批次 2 的 D 项换成 `_documentHasQuiz`）。这一行既让它走到那道判断
 * （没有它，body 文字不足 10 字会在上一行就返回 true），也让 `_isTextOnly()`
 * **必须**返回 true —— 谁退回旧判据，那条断言就红。
 */
function buildPptDecoyCardHtml() {
  var payload = { jobid: 'ppt-9002', _jobid: 'ppt-9002', mid: 'mid-ppt-9002', name: '轮盘课件' };
  var dataAttr = JSON.stringify(payload).replace(/"/g, '&quot;');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课件学习 - 学习通</title></head><body>' +
    '<div class="card">' +
    '<div class="ans-attach-ct" id="tp-ppt">' +
    '<div class="ans-job-icon" aria-label="任务点"></div>' +
    '<div class="ans-attach-title">轮盘课件</div>' +
    '<div class="question-content">本卡片只有一份任务类型顺序</div>' +
    '<iframe jobid="ppt-9002" data="' + dataAttr + '" src="/ppt-decoy-inner" ' +
    'style="width:100%;height:420px;border:0"></iframe>' +
    '</div>' +
    '</div></body></html>';
}

/**
 * 课件层：真 swiper 结构 + 两样「像题」的装饰。
 *
 * ⚠️ 装饰里**没有**作答控件（`[qid]` / `#answer…` / `[role=radio]`…）——
 *    新判据要区分的正是这个形状：容器命中、控件缺失 ⇒ 不是测验。
 *    末尾那行 `#answerTotal` 是刻意造的**近失样本**（文档级有答案域，但不在任何题目容器里），
 *    用来证明「控件必须在容器**里面**」这半边条件真在起作用，
 *    而不是因为整页一个控件都没有才返回 false。
 */
function buildPptDecoyInnerHtml() {
  var slides = ['第 1 页', '第 2 页', '第 3 页'].map(function (t, i) {
    return '<div class="swiper-slide"' + (i ? ' style="display:none"' : '') + '>' + t + '</div>';
  }).join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>轮盘课件 - 学习通</title></head><body>' +
    '<div class="swiper-container"><div class="swiper-wrapper">' + slides + '</div></div>' +
    '<div class="swiper-button-next"></div>' +
    '<div class="question-content">本讲要点：任务类型只有一份顺序</div>' +
    '<div class="answerOption"><span>A. 仲裁</span><span>B. 路由</span></div>' +
    '<input type="hidden" id="answerTotal" value="3">' +
    '</body></html>';
}

/**
 * 原生 PDF.js 风格文档（真实平台结构，2026-10-31 从同类开源实现补入）：
 * 页码计数器 + aria 标签翻页按钮。翻到末页时平台标记完成（finishFlag）、按钮禁用。
 * 此前文档任务只认 #panView（超星私有查看器）与 .pageNum 两族。
 */
function buildPdfJsDocHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>文档 - 学习通</title></head><body>' +
    '<div class="ans-job-icon" style="display:none"></div>' +
    '<div id="viewer"><div class="page">第 1 页内容</div></div>' +
    '<input id="pageNumber" value="1" aria-label="页码">' +
    '<span id="numPages">5</span>' +
    '<button id="prev" aria-label="上一页">上一页</button>' +
    '<button id="next" aria-label="下一页">下一页</button>' +
    '<button id="lastPage" aria-label="末页">末页</button>' +
    '<script>' +
    'var cur = 1, total = 5;' +
    'function syncDoc() { document.getElementById("pageNumber").value = cur;' +
    '  document.getElementById("next").disabled = cur >= total;' +
    '  document.getElementById("lastPage").disabled = cur >= total; }' +
    'document.getElementById("next").addEventListener("click", function () {' +
    '  if (cur < total) { cur++; syncDoc(); if (cur >= total) { try { window.finishFlag = true; } catch (e) {} } } });' +
    'document.getElementById("lastPage").addEventListener("click", function () {' +
    '  cur = total; syncDoc(); try { window.finishFlag = true; } catch (e) {} });' +
    'syncDoc();' +
    '</script></body></html>';
}

/**
 * mooc2 新版作业页（真实结构，2026-10-31 从同类开源实现的真实页面知识交叉补入）：
 * 容器 `.questionLi.singleQuesId`（带 id="questionN" / data="N" / typename 属性）、
 * 题干 `.question-stem`、选项 `.stem_answer > li.answerBg`。
 * 此前夹具只覆盖 .TiMu 与 .Cy_TItle 两族 —— mooc2 这一族此前零覆盖。
 */
function buildMooc2WorkHtml() {
  function q(id, no, typename, stem, opts, multi) {
    var lis = opts.map(function (t, i) {
      var letter = String.fromCharCode(65 + i);
      return '<li class="answerBg" qid="' + id + '" data="' + letter + '">' +
        '<span class="num_option' + (multi ? '_dx' : '') + ' choice' + id + '" data="' + letter + '">' + letter + '</span>' +
        '<span class="fl after">' + t + '</span>' +
        '<input type="' + (multi ? 'checkbox' : 'radio') + '" name="answer' + id + '" value="' + letter + '"></li>';
    }).join('');
    return '<div class="questionLi singleQuesId" id="question' + id + '" data="' + id + '" typename="' + typename + '">' +
      '<div class="Zy_TItle clearfix"><div class="question-stem"><span class="fontLabel">' + no +
      '.</span>【' + typename + '】' + stem + '</div></div>' +
      '<ul class="stem_answer">' + lis + '</ul>' +
      '<input type="hidden" id="answer' + id + '" value="">' +
      '<input type="hidden" id="answertype' + id + '" value="' + (multi ? '1' : '0') + '">' +
      '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>作业 - 学习通</title></head><body>' +
    '<input type="hidden" id="courseId" value="777">' +
    '<input type="hidden" id="classId" value="888">' +
    '<input type="hidden" id="workId" value="999">' +
    q(6001, 1, '单选题', 'mooc2 结构的题干识别测试', ['选项一', '选项二', '选项三', '选项四'], false) + '\n' +
    q(6002, 2, '多选题', 'mooc2 结构的多选识别测试', ['红', '绿', '蓝', '黄'], true) + '\n' +
    '<div class="subBtn"><button id="submitBtn" type="button">提交</button></div>' +
    '</body></html>';
}

/**
 * 字体残留类名（真实平台行为）：已批改结果页给**明文**题干挂着 font-cxsecret 类、
 * 却不再提供字体声明。旧逻辑会把它当"未解密"每轮白等 8 秒；
 * 现在解密扫描发现无字体可用且无 PUA 密文 → 摘掉残留类名放行。
 */
function buildFontResidueHtml() {
  function opt(letter, text) {
    return '<li class="before-after" qid="7001" data="' + letter + '">' +
      '<label><input type="radio" name="answer7001" value="' + letter + '">' +
      '<span class="num_option choice7001" data="' + letter + '">' + letter + '</span>' +
      '<span class="fl after">' + text + '</span></label></li>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>章节测验 - 学习通</title></head><body>' +
    '<div class="TiMu" qid="7001" typename="判断题">' +
    '<div class="Zy_TItle clearfix"><div class="fontLabel">1.</div>' +
    '<span class="font-cxsecret">对称加密算法的加密密钥与解密密钥相同。</span></div>' +
    '<ul class="Zy_ulTop">' + opt('A', '正确') + opt('B', '错误') + '</ul>' +
    '<input type="hidden" id="answer7001" value="">' +
    '<input type="hidden" id="answertype7001" value="3">' +
    '</div></body></html>';
}

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
  // 场景用它切换**应答形状**（见下面 truncate-big / line-format 两处）。
  // 不改它时就是"标准的一整个 JSON 数组"，与升级前完全一致。
  var responseMode = '';

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
          // 模拟服务商拒绝：401 = Key 无效（永久错误），402 = 账户欠费（"没钱"的真实报法），
          // 500 = 服务端抽风（可重试）。
          // body 必须是 OpenAI 的报错形状 —— content.js 靠它取出 httpStatus 之外的原话。
          var errText = forcedStatus === 401 ? 'Invalid API key'
            : forcedStatus === 402 ? 'Insufficient Balance'
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
        var questionCount = answers.length;

        var content = JSON.stringify(answers);
        var finishReason = 'stop';

        if (responseMode === 'flat-multi') {
          // 现场实测的形状：模型答多选时**把选项字母摊平**成一项一个字母。
          // 5 题（3 多选 + 2 填空）会回成 13 项：
          //   ["A","B","C","D","A","B","C","D","A","B","C","人工智能通识","人工智能"]
          // 答案其实全在，只是长度对不上 → 旧实现会整批丢弃 → 补问 → 又摊平 → 每轮空转。
          var flat = [];
          answers.forEach(function (a) {
            if (Array.isArray(a)) a.forEach(function (part) { flat.push(part); });
            else flat.push(a);
          });
          content = JSON.stringify(flat);
        } else if (responseMode === 'line-format') {          // 现场实测的退化形状：**一行一个 JSON 值**，每行正好是一题的答案。
          // 升级前解析器用贪婪的 `/\[[\s\S]*\]/` 去抓，跨行拼出来不是合法 JSON →
          // 一律判失败，于是"模型明明答了"却一道题都没落地。
          content = answers.map(function (a) { return JSON.stringify(a); }).join('\n');
        } else if (responseMode === 'pipe-format') {
          // 现场实测的**第二种**形状：模型把答案用 `|||` 串起来
          // —— 它把提示词里"填空题多个空用 ||| 分隔"那条约定当成了答案之间的分隔符。
          // 原样长这样：`["A","B","C"]|||["A","B","C"]|||["A","B","C","D"]|||…`
          //
          // ⚠️ 这一档刻意**不含内部分隔符**：多空填空题的答案本身自带 `|||`，
          // 那与"段分隔符"是**本质歧义**（段数会多出来），解析器会安全地拒绝。
          // 这里把多空填空换成单空（`甲|||乙` → `甲`），只测"段分隔符"这一件事。
          var safeAnswers = answers.map(function (a) {
            if (typeof a === 'string' && a.indexOf('|||') !== -1) return a.split('|||')[0];
            return a;
          });
          content = safeAnswers.map(function (a) { return JSON.stringify(a); }).join('|||');
        } else if (responseMode === 'truncate-big') {
          // 现场实测的另一种退化：一批题一多，模型就输出长篇重复内容、
          // 顶到 max_tokens 被截断。2026-10-31 批次上限定版 3 之后，
          // 阈值同步降到 **≥3 题**（能触发的最大批）—— 拆成两半后正常作答。
          if (questionCount >= 3) {
            var junk = [];
            for (var j = 0; j < 400; j++) junk.push('"A","B","C","D"');
            content = '[' + junk.join(',') + ',';
            finishReason = 'length';
          }
        }

        var payload = {
          id: 'mock', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: finishReason }]
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
        setStatus: function (code) { forcedStatus = code || 0; },
        setResponseMode: function (mode) { responseMode = mode || ''; }
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
    var timer = setTimeout(function () {
      try { self.ws.close(); } catch (e) {}
      reject(new Error('CDP 连接超时'));
    }, 10000);
    var ws = new WebSocket(self.wsUrl);
    self.ws = ws;
    ws.addEventListener('open', function () { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', function (e) {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败: ' + (e.message || '')));
    });
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
    req.setTimeout(10000, function () { req.destroy(new Error('HTTP 请求超时: ' + url)); });
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
 * 开一条**浏览器级** CDP 连接跑一段调用，跑完就关。
 *
 * ⚠️ `Browser.*` 和全局 `Target.*` 只挂在 `/json/version` 那条 ws 上，
 * 用页面级的 `tab.webSocketDebuggerUrl` 调会直接 not found（踩过）。
 * ⚠️ 现开现关、不常驻：浏览器级连接会把整轮的 target 事件堆进 `CdpClient.events`（没有上限）。
 *
 * @returns {Promise<any>} `fn` 的返回值；连不上时返回 null —— 调用方把它当证据打出来，别在这里替它猜成功
 */
async function withBrowserClient(fn) {
  var ver = null;
  try { ver = await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) { return null; }
  if (!ver || !ver.webSocketDebuggerUrl) return null;
  var c = new CdpClient(ver.webSocketDebuggerUrl);
  try {
    await c.connect();
    return await fn(c);
  } catch (e) {
    if (DEBUG) console.log('  [debug] 浏览器级调用失败: ' + e.message);
    return null;
  } finally {
    c.close();
  }
}

/**
 * 把某个标签页切成**它所在那个窗口**的活动标签。
 *
 * `document.hidden` 判的是「这个标签是它所在窗口的活动标签，且那扇窗口可见」，
 * 所以把同窗口的另一个标签端上去，这一页就真的下后台了（实测 0~2 毫秒翻）。
 * ⚠️ 「另开一个新标签再激活」在**只有一扇窗口**时同样管用，但全量跑不管用：
 *    新标签会开去别的窗口（实测 tabs 3→4、flipMs -1）—— 所以必须先核对 windowId。
 *
 * 这个端点回的是**纯文本**（`Target is activated`），不能走 `requestJson`
 * —— 它会因为「非 JSON 响应」而 reject，于是「激活成功」永远读成失败。
 * @returns {Promise<boolean>} 只表示「请求发出去了且 HTTP 成功」，真实效果由调用方轮询自证。
 */
function activateTab(tabId) {
  return new Promise(function (resolve) {
    var req = http.request('http://127.0.0.1:' + CDP_PORT + '/json/activate/' + tabId, { method: 'PUT' }, function (res) {
      res.on('data', function () {});
      res.on('end', function () { resolve(res.statusCode >= 200 && res.statusCode < 300); });
    });
    req.setTimeout(6000, function () { req.destroy(); resolve(false); });
    req.on('error', function () { resolve(false); });
    req.end();
  });
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

// ── 配置写入器 ──────────────────────────────────────────────────────────
// 新版权限模型里页面**不能**写配置（content.js 的 storage_set 只接受 xxtRunning），
// 所以测试必须从扩展上下文写 chrome.storage。这里开一个隐藏的扩展页面当写入器，
// 整轮只开一次，之后场景页照常抢焦点，不影响可见性相关的断言。
var cfgClient = null;
async function initConfigWriter(extensionId) {
  if (cfgClient) return cfgClient;
  var tab = await openTab('chrome-extension://' + extensionId + '/popup/popup.html?ui=lite');
  await sleep(700);
  var c = new CdpClient(tab.webSocketDebuggerUrl);
  await c.connect();
  cfgClient = c;
  return c;
}
// 扩展页面的 localStorage 是同一个源：清掉它，场景之间才不会互相污染
// （典型：前一个场景点了「藏」，后一个场景的角色就一直是 display:none）。
async function clearExtLocalStorage() {
  if (!cfgClient) return;
  try { await cfgClient.evaluate('try { localStorage.clear(); true; } catch (e) { false; }'); } catch (e) {}
}

async function writeConfig(extensionId, cfg) {
  var c = await initConfigWriter(extensionId);
  await c.evaluate('new Promise(function (res) { chrome.storage.local.set({ config: ' +
    JSON.stringify(cfg) + ' }, function () { res(true); }); })');
  await sleep(150);
}

async function openScenarioPage(extensionId, scenario) {
  var target = String(scenario.url || scenario.path).replace('{EXT}', extensionId);
  // 场景页必须挂在 chaoxing.com 域下：新版 content.js 只认「后台按标签页 URL 判定为学习通」
  // 的作用域，127.0.0.1 属于外站，拿不到 study 作用域，配置读不下来、请求全被拒。
  var url = /^[a-z-]+:\/\//i.test(target) ? target : 'http://mooc1.chaoxing.com:' + PORT + target;

  var tab = await openTab(url);
  var client = new CdpClient(tab.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await sleep(scenario.inject === false ? 900 : 1200);

  var ctx = {
    client: client,
    // 场景页自己的 target id —— 要用**浏览器级** CDP 改这扇窗口的状态（见 setWindowState）
    targetId: tab.id,
    url: url,
    close: async function () {
      client.close();
      await closeTab(tab.id);
    }
  };

  if (scenario.inject === false) return ctx;

  // 新版 content.js 在 chaoxing 域下会**自己**注入 page.js，而且要先等配置加载完 ——
  // 夹具里 1.2 秒就手动注入，会跑起**两个** page.js，配置与请求互相踩，
  // 表现就是"一条请求都没发出去"。所以先让它自己来，超时了才兜底。
  async function appReady() {
    return !!(await client.evaluate('!!(window._xxtApp && window._xxtApp._extractQuestions)'));
  }
  var deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(await appReady())) await sleep(300);

  if (!(await appReady())) {
    await client.evaluate(
      '(function(){var s=document.createElement("script");' +
      's.src="chrome-extension://' + extensionId + '/page.js";' +
      'document.documentElement.appendChild(s);return true;})()'
    );
    deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(await appReady())) await sleep(300);
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

/**
 * 每个请求实际问了**哪几道题**，按请求顺序返回（每题一个字符串，集合内已排序）。
 *
 * ⚠️ 题号不能当身份：`libs/prompt.js` 那行的前缀数字是**这一批内的序号**
 * （`(i + 1)`，从 1 开始），任何一批的第一题都是 `1|s|`。
 * 拿它判"同一批有没有重发"会把两个完全不同的批看成同一个（实测：多选单独成批后
 * 它的 `1` 和末尾那道简答题的 `1` 撞在一起，断言直接假红）。
 * 所以这里取的是**题干** —— 它才是那道题本身的身份。
 *
 * 为什么按"题集合"而不是"第几条是最大批"来断言：批的形状本来就会随实现变
 * （多选单独成批、截断后对半拆、缓存过滤掉几道）。写死形状的几条断言
 * 在批次 7 之后一起红了 —— 红的不是行为坏了，是断言把实现细节当成了事实。
 * 而这几个场景真正要守的只有一句话：**同一组题不许原样再问一遍**
 * （旧实现解析/截断失败会拿同一整批重发，白花一整批的钱）。
 *
 * @param {Array} requests  mock 收到的请求
 */
function requestQuestionSets(requests) {
  return (requests || []).map(function (r) {
    var lines = String(r && r.prompt || '').match(/^\d+\|[a-z]\|.*$/gm) || [];
    return lines.map(function (line) {
      return line.replace(/^\d+\|[a-z]\|/, '').trim();
    }).filter(Boolean).sort().join('\n');
  });
}

/** 题集合有没有重复：返回**第一组重复**的集合，没有重复返回 null。 */
function duplicateQuestionSet(sets) {
  var seen = {};
  for (var i = 0; i < (sets || []).length; i++) {
    var key = String(sets[i] || '');
    if (!key) continue;
    if (seen[key]) return key;
    seen[key] = 1;
  }
  return null;
}

// ===========================================================================
// 角色专项脚手架：只在 CDP 新文档里改浏览器原语，不给产品暴露任何测试 API。
// JS timer/Date.now 可推进；CSS/WAAPI 仍用真实浏览器时钟，不能用假时间猜动画帧。
// ===========================================================================
function installPetClock(tag, options) {
  options = options || {};
  var now = Date.now(), serial = 0, runs = 0, scheduled = 0, randomReads = 0;
  var timers = new Map(), randomValue = options.random === undefined ? 0.5 : options.random;
  Date.now = function () { return now; };
  Math.random = function () { randomReads++; return randomValue; };
  function add(fn, delay, args, interval) {
    if (typeof fn !== 'function') throw new Error('E2E 时钟只接受函数 timer');
    var id = ++serial, ms = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn: fn, at: now + ms, args: args, every: interval ? Math.max(1, ms) : 0 });
    scheduled++;
    return id;
  }
  window.setTimeout = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  window.setInterval = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };
  // 隔离其它 popup 场景留下的隐藏/拖动/心情；不伪造角色的 DOM 状态。
  ['hidden', 'pos', 'outfit', 'face', 'src'].forEach(function (key) { localStorage.removeItem('omitone.pet.' + key); });
  localStorage.setItem('omitone.pet.mood', String(options.mood === undefined ? 50 : options.mood));
  localStorage.setItem('omitone.pet.night', String(now));
  window.__omE2EClock = {
    tag: tag,
    random: function (value) {
      if (!(value >= 0 && value < 1)) throw new Error('random 必须在 [0,1) 内');
      randomValue = value;
    },
    stats: function () { return { now: now, runs: runs, scheduled: scheduled, pending: timers.size, randomReads: randomReads }; },
    advance: function (ms) {
      if (!(ms >= 0 && ms <= 120000)) throw new Error('E2E 单次推进最多 120 秒');
      var end = now + ms, steps = 0;
      for (;;) {
        var nextId = 0, next = null;
        timers.forEach(function (timer, id) {
          if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
            nextId = id; next = timer;
          }
        });
        if (!next) break;
        if (++steps > 20000) throw new Error('E2E timer 超过执行上限');
        now = next.at;
        if (next.every) next.at += next.every;
        else timers.delete(nextId);
        runs++;
        next.fn.apply(window, next.args);
      }
      now = end;
      return this.stats();
    }
  };
}

function petEval(client, fn) {
  var args = Array.prototype.slice.call(arguments, 2);
  return client.evaluate('(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')');
}

var petReloadSerial = 0;
async function reloadPet(ctx, options) {
  options = options || {};
  var client = ctx.client, tag = 'pet-' + (++petReloadSerial);
  // 新建标签有时留在后台，rAF 会被节流到 1fps，必须先让独立测试页可见。
  await client.send('Page.bringToFront');
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: options.width || 900, height: options.height || 760, deviceScaleFactor: 1, mobile: false
  });
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: options.reduce ? 'reduce' : 'no-preference' }]
  });
  var script = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + installPetClock.toString() + ')(' + JSON.stringify(tag) + ',' + JSON.stringify(options) + ');'
  });
  try {
    if (options.egg !== undefined) {
      var url = new URL(ctx.url);
      if (options.egg) url.searchParams.set('egg', '1');
      else url.searchParams.delete('egg');
      await client.send('Page.navigate', { url: url.href });
    } else await client.send('Page.reload', { ignoreCache: true });
    var ready = await waitFor(client,
      'document.readyState === "complete" && !!window.__omE2EClock && window.__omE2EClock.tag === ' + JSON.stringify(tag), 10000);
    if (!ready) throw new Error('角色专项 reload / 新文档时钟未就绪');
    if (options.entryOnly) {
      check('前置：egg=1 新文档真实进入彩蛋入场路径',
        await client.evaluate('window.__omitoneEgg === true && window.__omE2EClock.stats().scheduled > 0') === true);
      return;
    }
    if (!options.reduce) {
      // 等真实 rAF 帧率探测结束，再显式选择正常档，避免低速 CI 把正向动画基线自动降级。
      var governed = await waitFor(client, '!!window.__omitoneMotion', 5000);
      if (!governed) throw new Error('真实帧率探测未运行，不能开始动画断言: ' +
        JSON.stringify(await client.evaluate('({visibility:document.visibilityState,reduce:matchMedia("(prefers-reduced-motion: reduce)").matches,mode:document.documentElement.getAttribute("data-motion"),clock:window.__omE2EClock.stats()})')));
      await client.evaluate('document.documentElement.removeAttribute("data-motion")');
    }
    var initial = await petEval(client, function () {
      var c = window.__omE2EClock, before = c.stats();
      c.advance(1600);
      var pet = document.getElementById('mascot');
      return { before: before, after: c.stats(), shown: !!pet && pet.classList.contains('show'),
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, egg: window.__omitoneEgg };
    });
    check('前置：新文档 timer / 随机确已接管，正常出场回调实际执行',
      initial.before.scheduled > 0 && initial.after.runs > initial.before.runs &&
      initial.after.randomReads > 0 && initial.shown && initial.egg === false && initial.reduce === !!options.reduce,
      JSON.stringify(initial));
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
  }
}

async function advancePet(client, ms) {
  return petEval(client, function (delta) { return window.__omE2EClock.advance(delta); }, ms);
}

async function openPetBook(client) {
  var opened = await petEval(client, function () {
    var button = document.querySelector('#petTools [data-act="book"]');
    if (!button) return false;
    button.click();
    return document.getElementById('petBook').getAttribute('aria-hidden') === 'false';
  });
  check('前置：通过「册」按钮打开面板（非直接改 DOM）', opened === true);
}

async function petAction(client, key) {
  return petEval(client, function (name) {
    var button = document.querySelector('#petBookBody [data-anim="' + name + '"]');
    if (!button) throw new Error('动作按钮不存在: ' + name);
    button.click();
    var pet = document.getElementById('mascot'), art = pet.querySelector('.pet-art');
    var style = getComputedStyle(art), pseudo = getComputedStyle(pet.querySelector('.pet-inner'), '::after');
    return { pose: pet.getAttribute('data-pose'), animation: style.animationName, transform: style.transform,
      active: art.getAnimations().filter(function (a) { return a.playState === 'running' || a.playState === 'pending'; })
        .map(function (a) { return a.animationName || 'WAAPI'; }), symbol: pseudo.content };
  }, key);
}

function petMotionSnapshot() {
  var pet = document.getElementById('mascot');
  function active(a) { return a.playState === 'running' || a.playState === 'pending'; }
  var role = pet.getAnimations({ subtree: true }).filter(active);
  // 淡入淡出 / 心情条宽度不属于角色动作；位置、transform 过渡仍然禁止。
  var forbidden = role.filter(function (a) {
    if (!(a instanceof CSSTransition)) return true;
    var target = a.effect && a.effect.target;
    return a.transitionProperty !== 'opacity' &&
      !(a.transitionProperty === 'width' && target && target.closest('#petMood'));
  });
  var ambient = document.getElementById('fxLayer');
  return { mode: document.documentElement.getAttribute('data-motion'),
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    pose: pet.getAttribute('data-pose'), transition: pet.style.transition,
    role: forbidden.map(function (a) { return a.animationName || a.transitionProperty || 'WAAPI'; }),
    waapi: role.filter(function (a) { return !(a instanceof CSSAnimation) && !(a instanceof CSSTransition); }).length,
    ambient: ambient ? ambient.getAnimations({ subtree: true }).filter(active).length : 0,
    particles: document.querySelectorAll('.fx-heart,.fx-ripple,.fx-spark,.fx-snow,.fx-leaf').length };
}

// ===========================================================================
// 场景
// ===========================================================================
var SCENARIOS = [];

// 动作书：真实按钮 / 真实 CSSAnimation，逻辑到期由可控 JS 时钟验证。
SCENARIOS.push({
  name: '角色动作专项：88 张立绘与 11 动作完整覆盖',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var client = ctx.client;
    await reloadPet(ctx);
    await openPetBook(client);
    var book = await petEval(client, function () {
      var body = document.getElementById('petBookBody'), groups = {}, group = '';
      Array.from(body.children).forEach(function (el) {
        if (el.classList.contains('pet-book-sep')) { group = el.textContent.split(' · ')[0]; groups[group] = []; }
        else if (el.hasAttribute('data-src')) groups[group].push(el.getAttribute('data-src'));
      });
      var sources = Array.from(body.querySelectorAll('[data-src]')).map(function (el) { return el.getAttribute('data-src'); });
      return { groups: groups, sources: sources, meta: document.getElementById('petBookMeta').textContent,
        keys: Array.from(body.querySelectorAll('[data-anim]')).map(function (el) { return el.getAttribute('data-anim'); }) };
    });
    check('立绘去重后 88 张，默认 pet.png 只出现一次', book.sources.length === 88 &&
      new Set(book.sources).size === 88 && book.sources.filter(function (src) { return src === 'pet.png'; }).length === 1,
      JSON.stringify(book));
    // 2026-10-31 逐张看图重分类：e2~e6 是服装（原误归表情）→ 服装 44 / 表情 21；
    // pet.png 双身份（服装+姿势基座）在册内去重 → 去重姿势 23
    check('分组为 44 服装 / 21 表情 / 23 去重姿势，汇总显示 88',
      book.groups['服装'].length === 44 && book.groups['表情'].length === 21 &&
      book.groups['姿势（默认装束）'].length === 23 && /88\s*张/.test(book.meta), JSON.stringify(book.groups));
    var actions = [ ['spin', 950], ['jump', 760], ['shake', 1000], ['bow', 1000], ['peek', 1150],
      ['dizzy', 1400], ['sleep', 2300], ['cheer', 1200], ['surprise', 700], ['think', 2000], ['sing', 1900] ];
    // 第 12 个按钮是「随机动作」，它不是动作本身，单独断言
    var animKeys = book.keys.filter(function (k) { return k !== 'random'; });
    check('11 动作 key 完整且无重复', animKeys.length === 11 &&
      actions.every(function (a) { return animKeys.indexOf(a[0]) !== -1; }) && new Set(animKeys).size === 11,
      JSON.stringify(book.keys));
    check('「随机动作」入口存在', book.keys.indexOf('random') !== -1, JSON.stringify(book.keys));
    for (var i = 0; i < actions.length; i++) {
      var key = actions[i][0], duration = actions[i][1];
      var state = await petAction(client, key);
      check(key + '：按钮触发对应 data-pose', state.pose === key, JSON.stringify(state));
      if (key === 'think') {
        check('think：保留静态思考姿态（不冒充 CSS 动画）', state.transform !== 'none' && state.animation === 'none', JSON.stringify(state));
      } else {
        check(key + '：真实 CSSAnimation 正在运行', state.animation !== 'none' &&
          state.active.indexOf(state.animation) !== -1, JSON.stringify(state));
      }
      if (key === 'surprise' || key === 'think' || key === 'sing') {
        var symbol = { surprise: '!', think: '?', sing: '♪' }[key];
        check(key + '：头顶显示 ' + symbol, state.symbol === '"' + symbol + '"', JSON.stringify(state));
      }
      // 最后 1ms 前不能提前坐下；到期后确实回坐，不能只断言 timer 存在。
      await advancePet(client, duration - 1);
      check(key + '：停留结束前不提前回坐',
        await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === key);
      await advancePet(client, 2);
      check(key + '：到期回 sit',
        await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sit');
    }
    // 默认落点 y=2 不应靠整个人下移来躲裁切；检查符号最终绘制盒，而非只看 content。
    for (var glyphKey of ['surprise', 'think', 'sing']) {
      await petAction(client, glyphKey);
      var glyph = await petEval(client, function () {
        var pet = document.getElementById('mascot'), inner = pet.querySelector('.pet-inner');
        inner.getAnimations().forEach(function (a) {
          if (a.animationName === 'pet-glyph') a.finish();
        });
        var p = getComputedStyle(inner, '::after'), r = inner.getBoundingClientRect();
        var matrix = new DOMMatrix(p.transform === 'none' ? undefined : p.transform);
        var x = r.left + parseFloat(p.left) + matrix.e, y = r.top + parseFloat(p.top) + matrix.f;
        return { translateY: parseFloat(getComputedStyle(pet).translate.split(' ')[1]),
          top: y, bottom: y + parseFloat(p.height), left: x, right: x + parseFloat(p.width),
          pseudoTop: p.top, pseudoLeft: p.left, content: p.content, viewport: [innerWidth, innerHeight] };
      });
      check(glyphKey + '：默认顶边落点不变，符号绘制盒仍完整在视口内',
        glyph.translateY === 2 && glyph.top >= -1 && glyph.left >= -1 &&
        glyph.bottom <= glyph.viewport[1] + 1 && glyph.right <= glyph.viewport[0] + 1,
        JSON.stringify(glyph));
    }
    check('动作执行全程无未捕获异常', client.errors().length === 0, client.errors().join(' | '));
  }
});

SCENARIOS.push({
  name: '角色动作专项：连续动作令牌 / 同动作重播',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var client = ctx.client;
    await reloadPet(ctx);
    await openPetBook(client);
    await petAction(client, 'spin');
    await advancePet(client, 600);
    var second = await petAction(client, 'sleep');
    check('前置：短动作未结束时已切换成长动作', second.pose === 'sleep' && second.active.length > 0, JSON.stringify(second));
    await advancePet(client, 351);
    check('旧 spin timer 到期不会盖掉新 sleep',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sleep');
    await advancePet(client, 1948);
    check('新 sleep 自己的期限未到仍保留',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sleep');
    await advancePet(client, 2);
    check('新 sleep 自己到期才回 sit',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sit');
    await petAction(client, 'spin');
    var replay = await petEval(client, function () {
      var art = document.querySelector('#mascot .pet-art');
      var old = art.getAnimations().find(function (a) { return a.animationName === 'pet-spin'; });
      if (!old) return { old: false };
      // CSS 时钟不随 JS 假时钟推进：直接推进真实 Animation 对象，证明第二次从头播。
      old.currentTime = 450;
      var before = old.currentTime;
      document.querySelector('#petBookBody [data-anim="spin"]').click();
      var next = art.getAnimations().find(function (a) { return a.animationName === 'pet-spin'; });
      return { old: true, before: before, distinct: !!next && next !== old,
        restarted: !!next && Number(next.currentTime) < 100, state: next && next.playState };
    });
    check('同动作再次点击创建新的 CSS 动画并从头播放', replay.old && replay.before >= 400 &&
      replay.distinct && replay.restarted && replay.state === 'running', JSON.stringify(replay));
    await advancePet(client, 600);
    await petAction(client, 'spin');
    await advancePet(client, 351);
    check('同动作重播后旧回坐 timer 也不抢戏',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'spin');
    await advancePet(client, 600);
    check('重播后的新期限仍能回坐',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sit');
    await petAction(client, 'jump');
    var sharedName = await petEval(client, function () {
      var art = document.querySelector('#mascot .pet-art');
      var old = art.getAnimations().find(function (a) { return a.animationName === 'pet-jump'; });
      if (!old) return { old: false };
      old.currentTime = 400;
      var before = old.currentTime;
      document.querySelector('#petBookBody [data-anim="surprise"]').click();
      var next = art.getAnimations().find(function (a) { return a.animationName === 'pet-jump'; });
      return { old: true, before: before, pose: document.getElementById('mascot').getAttribute('data-pose'),
        distinct: !!next && next !== old, time: next && next.currentTime, state: next && next.playState };
    });
    check('jump 切 surprise 共用 animationName 也会创建新动画从头播放',
      sharedName.old && sharedName.before >= 350 && sharedName.pose === 'surprise' && sharedName.distinct &&
      Number(sharedName.time) < 100 && sharedName.state === 'running', JSON.stringify(sharedName));
  }
});

SCENARIOS.push({
  name: '角色动作专项：显示小人 crawl 取消 / 图册让闲置让位',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var client = ctx.client;
    await reloadPet(ctx);
    await client.evaluate('document.getElementById("btnPetShow").click()');
    await advancePet(client, 901);
    check('前置：显示小人的延迟 crawl 真实进入 crouch',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'crouch');
    await advancePet(client, 1501);
    var crawl = await petEval(client, function () {
      var pet = document.getElementById('mascot');
      return { pose: pet.getAttribute('data-pose'), transition: pet.style.transition, translate: pet.style.translate };
    });
    check('前置：已进入 crawl 且真实启动 translate 移动', crawl.pose === 'crawl' &&
      /translate/.test(crawl.transition) && !!crawl.translate, JSON.stringify(crawl));
    // 打开册本身会取消，因此先开册再点击「显示小人」重开 crawl，测试动作按钮的取消能力。
    await openPetBook(client);
    await client.evaluate('document.getElementById("btnPetShow").click()');
    await advancePet(client, 2401);
    check('前置：图册已打开时第二次显示仍能真正开始 crawl',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'crawl');
    await petAction(client, 'sleep');
    var frozen = await client.evaluate('document.getElementById("mascot").style.translate');
    check('手动动作取消已开始 crawl 的空间过渡',
      await client.evaluate('document.getElementById("mascot").style.transition') === '');
    await advancePet(client, 2301);
    await advancePet(client, 15000);
    var cancelled = await petEval(client, function () {
      var pet = document.getElementById('mascot');
      return { pose: pet.getAttribute('data-pose'), translate: pet.style.translate, transition: pet.style.transition };
    });
    check('旧 crawl 后续 point / 回家 timer 均失效', cancelled.pose === 'sit' &&
      cancelled.translate === frozen && cancelled.transition === '', JSON.stringify(cancelled));
    await client.evaluate('document.getElementById("btnPetShow").click()');
    await advancePet(client, 300);
    var pending = await petAction(client, 'sleep');
    check('前置：显示后的 900ms 延迟内已手动切 sleep', pending.pose === 'sleep');
    await advancePet(client, 601);
    check('手动动作取消尚未开始的延迟 crawl',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sleep');
    await advancePet(client, 1700);
    await advancePet(client, 17000);
    check('被取消的延迟 crawl 不会在后续阶段复活',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sit');

    // 先证明 idle 分支实际能驱动角色，再 reload 验证开册让位；不能靠「没变化」猜前置。
    await reloadPet(ctx);
    await advancePet(client, 16901);
    var idle = await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")');
    check('前置：可控随机与时钟确实触发正常 idle 动作', idle === 'happy', String(idle));
    await advancePet(client, 6500);
    check('前置：不开册时 25 秒打哈欠回调确实会运行',
      await client.evaluate('document.getElementById("mascot").classList.contains("yawn")') === true);
    await reloadPet(ctx);
    await openPetBook(client);
    await petEval(client, function () { window.__omE2EClock.random(0.99); });
    await advancePet(client, 23401);
    check('图册打开时 25 秒打哈欠也让位',
      await client.evaluate('!document.getElementById("mascot").classList.contains("yawn")') === true);
    await advancePet(client, 40000);
    var idleBlocked = await petEval(client, function () {
      return { pose: document.getElementById('mascot').getAttribute('data-pose'),
        open: document.getElementById('petBook').getAttribute('aria-hidden'), stats: window.__omE2EClock.stats() };
    });
    check('开册持续超过两轮 idle 仍不抢姿态', idleBlocked.pose === 'sit' && idleBlocked.open === 'false', JSON.stringify(idleBlocked));

    // 抢占发生在挂边 callback 之前也必须把人显出来，不能只取消原入场序列。
    await reloadPet(ctx, { egg: true, entryOnly: true });
    var eggBefore = await client.evaluate('!document.getElementById("mascot").classList.contains("show")');
    check('前置：egg 入场首拍前角色确实尚未显示', eggBefore === true);
    await client.evaluate('document.dispatchEvent(new CustomEvent("omitone:run",{detail:true}))');
    await advancePet(client, 11001);
    var eggRun = await petEval(client, function () {
      var pet = document.getElementById('mascot');
      return { show: pet.classList.contains('show'), transform: pet.style.transform,
        busy: pet.getAttribute('data-busy'), display: getComputedStyle(pet).display };
    });
    check('run 抢占 egg 入场后角色可见，过期入场回调不把它移出视口', eggRun.show &&
      eggRun.transform === '' && eggRun.busy === '1' && eggRun.display !== 'none', JSON.stringify(eggRun));
    await reloadPet(ctx, { egg: true, entryOnly: true });
    await advancePet(client, 1401);
    var hanging = await client.evaluate('({pose:document.getElementById("mascot").getAttribute("data-pose"),transform:document.getElementById("mascot").style.transform})');
    check('前置：第二次 egg 真实进入带负向位移的挂边首拍', hanging.pose === 'hang' &&
      /-96px/.test(hanging.transform), JSON.stringify(hanging));
    await client.evaluate('document.dispatchEvent(new CustomEvent("omitone:run",{detail:true}))');
    check('run 抢占已挂边的 egg 会清除旧入场 transform 并保持 show',
      await client.evaluate('document.getElementById("mascot").classList.contains("show") && document.getElementById("mascot").style.transform === ""') === true);

    await reloadPet(ctx, { egg: false, random: 0.3 });
    var eating = await petEval(client, function () {
      // 停止按钮仍走完整真实 click 冒泡链，但不启动刷课，避免和后续场景串存储。
      document.getElementById('stop').click();
      var pet = document.getElementById('mascot'), art = pet.querySelector('.pet-art');
      return { season: document.documentElement.getAttribute('data-season'), eat: pet.getAttribute('data-eat'),
        animation: getComputedStyle(art).animationName,
        active: art.getAnimations().some(function (a) { return a.animationName === 'pet-lick' && a.playState === 'running'; }) };
    });
    check('前置：可控随机真实抽到夏季', eating.season === 'summer', JSON.stringify(eating));
    check('夏季按钮点击不会被 petReact 立即抹掉吃冰激凌动作',
      eating.eat === '1' && eating.animation === 'pet-lick' && eating.active, JSON.stringify(eating));
    await advancePet(client, 1301);
    check('夏季吃动作期限结束后清掉 data-eat',
      await client.evaluate('!document.getElementById("mascot").hasAttribute("data-eat")') === true);

    await reloadPet(ctx, { egg: false, mood: 79 });
    var moodBefore = await client.evaluate('localStorage.getItem("omitone.pet.mood")');
    check('夹具自证：reloadPet 确实把心情写成了 79（这一步只证明存档落盘，"79 属于高档"由下一条断）',
      moodBefore === '79', String(moodBefore));
    await client.evaluate('document.getElementById("mascot").click()');
    var moodTouched = await petEval(client, function () {
      var pet = document.getElementById('mascot');
      return { mood: localStorage.getItem('omitone.pet.mood'), band: pet.getAttribute('data-mood'),
        pose: pet.getAttribute('data-pose'), busy: Number(pet._busyUntil) - Date.now() };
    });
    check('摸头 79→80 先完成当前 happy，跨档演出不抢占手动动作', moodTouched.mood === '80' &&
      moodTouched.band === 'high' && moodTouched.pose === 'happy' && moodTouched.busy > 800,
      JSON.stringify(moodTouched));
    await advancePet(client, 799);
    check('摸头 happy 在 800ms 前仍保留',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'happy');
    await advancePet(client, 253);
    var moodPlayed = await petEval(client, function () {
      var pet = document.getElementById('mascot'), bubble = document.getElementById('mascotBubble');
      return { pose: pet.getAttribute('data-pose'), line: bubble.textContent, speaking: bubble.classList.contains('show'),
        animation: getComputedStyle(pet.querySelector('.pet-art')).animationName };
    });
    check('手动 busy 结束后补播高心情 cheer 及台词', moodPlayed.pose === 'cheer' &&
      moodPlayed.animation === 'pet-cheer' && moodPlayed.speaking && /心情不错/.test(moodPlayed.line), JSON.stringify(moodPlayed));
    await advancePet(client, 1201);
    check('补播 cheer 到期正常回坐',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sit');
  }
});

SCENARIOS.push({
  name: '角色动作专项：380x240 立绘册面板内滚动命中',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var client = ctx.client;
    await reloadPet(ctx, { width: 380, height: 240 });
    await openPetBook(client);
    // 只等面板真实 CSS 打开过渡，不用 JS 假时钟猜几何位置。
    await sleep(300);
    var geometry = await petEval(client, function () {
      var panel = document.getElementById('petBook'), body = document.getElementById('petBookBody');
      var rect = panel.getBoundingClientRect();
      var out = { width: innerWidth, height: innerHeight, top: rect.top, bottom: rect.bottom,
        left: rect.left, right: rect.right, overflow: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight > body.clientHeight, pageY: scrollY };
      // 滚到「最后一个动作按钮」而不是滚动容器的最底 —— 面板末尾现在是成就区
      // （1.3.0 起立绘册末尾挂成就列表），滚到底看到的是成就，不再是动作按钮。
      var last = body.querySelector('[data-anim="sing"]');
      var r0 = last.getBoundingClientRect(), b0 = body.getBoundingClientRect();
      // 用 rect.height（DOMRect 没有 clientHeight —— 实测踩过：undefined 混进 delta
      // 变 NaN，scrollTop += NaN 按规范静默跳过，滚动纹丝不动）
      body.scrollTop += (r0.top + r0.height / 2) - (b0.top + b0.height / 2);
      return out;
    });
    check('前置：CDP 确实模拟 380x240 视口', geometry.width === 380 && geometry.height === 240, JSON.stringify(geometry));
    check('短视口整块图册仍在视口内', geometry.top >= -1 && geometry.bottom <= 241 &&
      geometry.left >= -1 && geometry.right <= 381, JSON.stringify(geometry));
    check('内容在面板内部滚动，不靠整页撑高', geometry.scrollable && /auto|scroll/.test(geometry.overflow), JSON.stringify(geometry));
    var hit = await petEval(client, function () {
      var body = document.getElementById('petBookBody');
      var last = body.querySelector('[data-anim="sing"]'), r = last.getBoundingClientRect();
      var br = body.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      var target = document.elementFromPoint(x, y);
      return { key: last.getAttribute('data-anim'), x: x, y: y, scrollTop: body.scrollTop,
        pageY: scrollY, within: r.top >= br.top - 1 && r.bottom <= br.bottom + 1,
        hit: !!target && (target === last || last.contains(target)) };
    });
    check('最后一个哼歌按钮滚入面板后中心点真实命中', hit.key === 'sing' && hit.scrollTop > 0 &&
      hit.within && hit.hit && hit.y >= 0 && hit.y < 240 && hit.pageY === geometry.pageY, JSON.stringify(hit));
    // 不用 DOM click 掩盖遮挡：由 CDP 在真实命中点发鼠标事件。
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
    check('短视口最后按钮真实鼠标点击触发 sing',
      await client.evaluate('document.getElementById("mascot").getAttribute("data-pose")') === 'sing');
  }
});

SCENARIOS.push({
  name: '角色动作专项：动态 eco / 系统减少动态效果',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var client = ctx.client;
    await reloadPet(ctx);
    await client.evaluate('document.querySelector("#petTools [data-act=outfit]").click()');
    var outfitBaseline = await petEval(client, petMotionSnapshot);
    check('前置：正常换装确实启动 WAAPI', outfitBaseline.mode !== 'eco' && outfitBaseline.waapi > 0,
      JSON.stringify(outfitBaseline));
    // 新序列会取消旧 WAAPI，先摸头再换装，令降档时 CSS / WAAPI / 粒子同时在场。
    await petEval(client, function () {
      document.getElementById('mascot').click();
      document.querySelector('#petTools [data-act="outfit"]').click();
    });
    var baseline = await petEval(client, petMotionSnapshot);
    check('前置：正常模式确有角色 CSS 动画、换装 WAAPI 和摸头粒子', baseline.mode !== 'eco' &&
      baseline.role.some(function (name) { return name !== 'WAAPI'; }) && baseline.waapi > 0 && baseline.particles >= 3,
      JSON.stringify(baseline));
    // 不只在 eco 下创建新动作：先启动真实动画，再动态降档，必须清掉旧 WAAPI。
    await client.evaluate('document.documentElement.setAttribute("data-motion","eco")');
    var downgraded = await petEval(client, petMotionSnapshot);
    check('动态降到 eco 会取消已有角色 CSS / WAAPI 动画', downgraded.mode === 'eco' &&
      downgraded.role.length === 0 && downgraded.waapi === 0, JSON.stringify(downgraded));
    check('动态降到 eco 会收掉已有瞬时粒子', downgraded.particles === 0, JSON.stringify(downgraded));

    for (var pass = 0; pass < 2; pass++) {
      if (pass) await reloadPet(ctx, { reduce: true });
      var label = pass ? '系统 reduce' : '动态 eco';
      await openPetBook(client);
      var reduced = await petEval(client, function () {
        var pet = document.getElementById('mascot'), body = document.getElementById('petBookBody');
        var seen = [], violations = [], additions = [];
        var observer = new MutationObserver(function () {});
        observer.observe(document.body, { subtree: true, childList: true });
        function record(name) {
          var bad = pet.getAnimations({ subtree: true }).filter(function (a) {
            if (a.playState !== 'running' && a.playState !== 'pending') return false;
            if (!(a instanceof CSSTransition)) return true;
            var target = a.effect && a.effect.target;
            return a.transitionProperty !== 'opacity' &&
              !(a.transitionProperty === 'width' && target && target.closest('#petMood'));
          });
          if (bad.length) violations.push(name + ':' + bad.map(function (a) {
            var target = a.effect && a.effect.target;
            return (a.animationName || a.transitionProperty || 'WAAPI') + '@' +
              (target && (target.id || target.className) || '?');
          }).join(','));
        }
        // 「随机动作」抽到哪个不确定，放进逐项等值断言里必然误报，单独跳过
        Array.from(body.querySelectorAll('[data-anim]')).filter(function (button) {
          return button.getAttribute('data-anim') !== 'random';
        }).forEach(function (button) {
          button.click();
          seen.push([button.getAttribute('data-anim'), pet.getAttribute('data-pose')]);
          record(button.getAttribute('data-anim'));
        });
        ['outfit', 'face', 'pose'].forEach(function (act) {
          document.querySelector('#petTools [data-act="' + act + '"]').click(); record(act);
        });
        pet.click(); record('pet');
        // 底部显示按钮还会走 crawl；低动态模式下只允许静态提示，不允许空间移动。
        document.getElementById('btnPetShow').click();
        window.__omE2EClock.advance(2401);
        record('show');
        observer.takeRecords().forEach(function (mutation) {
          Array.from(mutation.addedNodes).forEach(function (node) {
            if (node.nodeType === 1 && (node.matches('.fx-heart,.fx-ripple,.fx-spark,.fx-snow,.fx-leaf') ||
              node.querySelector('.fx-heart,.fx-ripple,.fx-spark,.fx-snow,.fx-leaf'))) additions.push(node.className);
          });
        });
        observer.disconnect();
        return { seen: seen, violations: violations, additions: additions,
          reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
          mode: document.documentElement.getAttribute('data-motion'), transition: pet.style.transition,
          particles: document.querySelectorAll('.fx-heart,.fx-ripple,.fx-spark,.fx-snow,.fx-leaf').length };
      });
      check(label + '：设置真实生效且 11 动作按钮仍然能切换静态姿态', reduced.mode === 'eco' &&
        reduced.reduce === !!pass && reduced.seen.length === 11 &&
        reduced.seen.every(function (pair) { return pair[0] === pair[1]; }), JSON.stringify(reduced));
      check(label + '：动作 / 换装 / 摸头 / 显示均无角色 CSS 或 WAAPI 动画',
        reduced.violations.length === 0 && !/translate|transform/.test(reduced.transition), JSON.stringify(reduced));
      check(label + '：同套点击不生成瞬时粒子（包含创建后立即移除）',
        reduced.additions.length === 0 && reduced.particles === 0, JSON.stringify(reduced));
      var quiet = await petEval(client, petMotionSnapshot);
      check(label + '：常驻季节粒子也没有运行中的动画', quiet.ambient === 0, JSON.stringify(quiet));
    }
    check('低动态专项全程无未捕获异常', client.errors().length === 0, client.errors().join(' | '));
  }
});

// 交互回归：连点换装不能误判为"戳她"；「藏」与「显示小人」必须闭环。
SCENARIOS.push({
  name: '弹窗前端：连点换装不误判 / 显示小人闭环',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(async function(){' +
      'await new Promise(function(r){setTimeout(r,1600);});' +
      'var pet=document.getElementById("mascot");' +
      'if(!pet) return {ok:false};' +
      'pet.classList.add("show");' +
      'var out={ok:true};' +
      'var b=document.querySelector("#petTools button[data-act=\\"outfit\\"]");' +
      'if(b){b.click();b.click();b.click();}' +
      'await new Promise(function(r){setTimeout(r,200);});' +
      'out.dodged=pet.classList.contains("dodge");' +
      'if(b){b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:2,button:0,isPrimary:true,clientX:b.getBoundingClientRect().left+5,clientY:b.getBoundingClientRect().top+5}));}' +
      'out.dragFromTools=pet.classList.contains("dragging");' +
      'var h=document.querySelector("#petTools button[data-act=\\"hide\\"]");' +
      'if(h)h.click();' +
      'await new Promise(function(r){setTimeout(r,150);});' +
      'out.hidden=pet.style.display==="none";' +
      // 「藏」的**持久化**没人守过：以前这条断言写的是 `r.hidAfterHide || r.hidden`，
      // 而 `hidAfterHide` 这个字段探针从来没写过 —— 左半边是死的，等于只断了"这一下收起来了"。
      // 「下次打开弹窗还藏着」靠的是 localStorage 那个键（popup/pet.js:350 HIDE_KEY）。
      'out.hideStored=localStorage.getItem("omitone.pet.hidden");' +
      'var sp=document.getElementById("btnPetShow");' +
      'out.hasShowBtn=!!sp;' +
      'if(sp)sp.click();' +
      'await new Promise(function(r){setTimeout(r,200);});' +
      'out.shown=pet.style.display!=="none"&&pet.classList.contains("show");' +
      'out.hideCleared=localStorage.getItem("omitone.pet.hidden");' +
      'return out;})()'
    );
    check('连点「装」三次不会被当成戳（不躲）', !!r && r.ok && r.dodged === false, JSON.stringify(r));
    check('「藏」能把人收起来，并把"藏着"写进存档（下次打开弹窗还在藏着的状态）',
      !!r && r.hidden === true && r.hideStored === '1', JSON.stringify(r));
    check('点「显示小人」能重新出现，并清掉存档里的"藏着"',
      !!r && r.shown === true && (r.hideCleared === null || r.hideCleared === '0'), JSON.stringify(r));
    check('按在工具条上不会启动拖动（否则 click 被重定向成"戳"）', !!r && r.dragFromTools === false, JSON.stringify(r));
  }
});


// ══════════════════════════════════════════════════════════════════════
// 前端专项（一）：弹窗全功能自检
// 上一版只"点了按钮"，没验证"按钮点不点得到" —— 所以"被遮住/看不见"
// 这类问题全漏了。这里用 elementFromPoint 做**命中测试**：命中点必须是
// 按钮自己，才算真的可点。
// ══════════════════════════════════════════════════════════════════════
SCENARIOS.push({
  name: '弹窗前端：全功能自检（含命中测试）',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(async function(){' +
      'var out={errs:[]};window.addEventListener("error",function(e){out.errs.push(String(e.message));});' +
      'await new Promise(function(r){setTimeout(r,1500);});' +
      'var pet=document.getElementById("mascot");' +
      'out.petShown=!!(pet&&pet.classList.contains("show"));' +
      'out.ui=document.documentElement.getAttribute("data-ui");' +
      // —— 命中测试：三个按钮的中心点，elementFromPoint 必须命中按钮自己 ——
      'var hits={};["pose","outfit","hide"].forEach(function(a){' +
      '  var b=document.querySelector("#petTools button[data-act=\\""+a+"\\"]");' +
      '  if(!b){hits[a]="missing";return;}' +
      '  var rc=b.getBoundingClientRect();' +
      '  var el=document.elementFromPoint(rc.left+rc.width/2, rc.top+rc.height/2);' +
      '  hits[a]=(el===b||(el&&b.contains(el)));' +
      '});' +
      'out.hits=hits;' +
      // —— 拖动（放在点击之前，避免姿态/换装干扰位置）——
      'function ev(t,x,y){return new PointerEvent(t,{bubbles:true,pointerId:1,button:0,isPrimary:true,clientX:x,clientY:y});}' +
      'var d0=pet.getBoundingClientRect();' +
      'pet.dispatchEvent(ev("pointerdown",d0.left+12,d0.top+12));' +
      'pet.dispatchEvent(ev("pointermove",d0.left-70,d0.top+40));' +
      'pet.dispatchEvent(ev("pointerup",d0.left-70,d0.top+40));' +
      'await new Promise(function(r){setTimeout(r,350);});' +
      'var d1=pet.getBoundingClientRect();' +
      'out.dragDx=Math.round(d1.left-d0.left);' +
      'out.inView=d1.left>=-1&&d1.right<=innerWidth+1&&d1.top>=-1;' +
      // —— 换装：这次点击是下面「姿」那条的前提（穿着非默认衣服），
      //    换装本身的行为断言在「角色控件点一遍都要有反应」那一场 ——
      'var img=pet.querySelector(".pet-art");' +
      'var bo=document.querySelector("#petTools button[data-act=\\"outfit\\"]");' +
      'if(bo)bo.click();await new Promise(function(r){setTimeout(r,200);});' +
      // —— 换姿势：当前穿着非默认衣服，只能换身体姿态，不能把衣服换掉 ——
      'out.pose0=img?img.getAttribute("src"):"";' +
      'out.poseAttr0=pet?pet.getAttribute("data-pose"):"";' +
      'var bp=document.querySelector("#petTools button[data-act=\\"pose\\"]");' +
      'if(bp)bp.click();await new Promise(function(r){setTimeout(r,200);});' +
      'out.pose1=img?img.getAttribute("src"):"";' +
      'out.poseAttr1=pet?pet.getAttribute("data-pose"):"";' +
      // —— 隐藏（放最后）：这一次点击只为「全程无未捕获异常」走一遍那条路径 ——
      'var bh=document.querySelector("#petTools button[data-act=\\"hide\\"]");' +
      'if(bh)bh.click();await new Promise(function(r){setTimeout(r,150);});' +
      'out.errCount=out.errs.length;out.errText=out.errs.join(" | ");' +
      'return out;})()'
    );
    check('角色在精美模式下自动出现', !!r && r.petShown === true, JSON.stringify({shown: r && r.petShown, ui: r && r.ui}));
    check('「姿」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.pose === true, JSON.stringify(r && r.hits));
    check('「装」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.outfit === true, JSON.stringify(r && r.hits));
    check('「藏」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.hide === true, JSON.stringify(r && r.hits));
    // 这一场只测**命中测试 + 拖动 + 装束不被「姿」覆盖**这一层；
    // 「点「装」换立绘」「点「藏」收起」两条与「弹窗前端：角色控件点一遍都要有反应」
    // 是同分支、同层、同夹具的重复（谓词逐字相同），行为那一条留在那场里，摘掉这里。
    // 上面那两次点击仍然保留：它们分别是「姿」那条的前提与「全程无未捕获异常」走过的路径。
    check('穿着别的衣服时点「姿」不会把衣服换掉', !!r && r.pose0 === r.pose1, r ? r.pose0 + ' → ' + r.pose1 : '');
    check('「姿」仍然换了身体姿态', !!r && r.poseAttr0 !== r.poseAttr1, r ? r.poseAttr0 + ' → ' + r.poseAttr1 : '');
    check('拖动位移 > 30px', !!r && Math.abs(r.dragDx) > 30, r ? String(r.dragDx) : '');
    check('拖完仍在视口内', !!r && r.inView === true, '');
    check('全程无未捕获异常', !!r && r.errCount === 0, r ? r.errText : '');
  }
});

// ══════════════════════════════════════════════════════════════════════
// 前端专项（二）：沉浸式窗口应当只剩吉祥物
// 之前 ?play=1 只改了窗口尺寸、从没加 .im 类，打开就是放大版设置面板。
// ══════════════════════════════════════════════════════════════════════
SCENARIOS.push({
  name: '沉浸式窗口：只剩吉祥物',
  url: 'chrome-extension://{EXT}/popup/popup.html?play=1&ui=fancy',
  inject: false,
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(async function(){' +
      'await new Promise(function(r){setTimeout(r,1200);});' +
      'var out={};' +
      'out.imClass=document.body.classList.contains("im");' +
      'var top=document.querySelector(".top");' +
      'out.topHidden=top?getComputedStyle(top).display==="none":null;' +
      'var pet=document.getElementById("mascot");' +
      'out.petVisible=pet?getComputedStyle(pet).display!=="none":null;' +
      'return out;})()'
    );
    check('body 带上了 .im 类', !!r && r.imClass === true, JSON.stringify(r));
    check('设置面板被隐藏', !!r && r.topHidden === true, JSON.stringify(r));
    check('吉祥物仍然显示', !!r && r.petVisible === true, JSON.stringify(r));
  }
});




// ── 前端专项：角色控件"点了要有反应" ──────────────────────────────────────
// 这类 bug（点了没反应、装扮没换）**不会抛异常**，只能靠"点完之后状态变了没有"来抓。
// 以后新增任何角色控件，都在这里补一条断言。
SCENARIOS.push({
  name: '弹窗前端：角色控件点一遍都要有反应',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(async function(){' +
      'var out={errs:[]};' +
      'window.addEventListener("error",function(e){out.errs.push(String(e.message));});' +
      'await new Promise(function(r){setTimeout(r,1200);});' +
      'var pet=document.getElementById("mascot");' +
      'var img=pet&&pet.querySelector(".pet-art");' +
      'out.hasPet=!!pet;out.src0=img?img.getAttribute("src"):"";' +
      'var b=document.querySelector("#petTools button[data-act=\\"outfit\\"]");' +
      'if(b){b.click();await new Promise(function(r){setTimeout(r,180);});}' +
      'out.src1=img?img.getAttribute("src"):"";' +
      'out.pose0=img?img.getAttribute("src"):"";' +
      'out.poseAttr0=pet?pet.getAttribute("data-pose"):"";' +
      'var pb=document.querySelector("#petTools button[data-act=\\"pose\\"]");' +
      'if(pb){pb.click();await new Promise(function(r){setTimeout(r,180);});}' +
      // 旧写法断 `pose0 !== pose1`，可 pose0 取的是 **img 的 src**、pose1 取的是 **pet 的
      // data-pose** —— 两个值域（"pet.png" 与 "sit"）永远不相等，「姿」整个坏掉它照样绿。
      // 「姿」有两条分支（popup/pet.js:605）：默认装束下换**姿势立绘**（改 src），
      // 穿着别的衣服时只换 **CSS 姿态**（改 data-pose，不换图，免得把用户刚挑的衣服换掉）。
      // 上面点过一次「装」，所以现在走的是第二条 —— 断言写成"两者之一真的变了"，
      // 不认死某一条，否则以后默认装束的顺序一变就误红。
      'out.pose1=img?img.getAttribute("src"):"";' +
      'out.poseAttr=pet?pet.getAttribute("data-pose"):"";' +
      'var h=document.querySelector("#petTools button[data-act=\\"hide\\"]");' +
      'if(h){h.click();await new Promise(function(r){setTimeout(r,140);});}' +
      'out.hidden=pet?pet.style.display==="none":null;' +
      'var sp=document.getElementById("btnPetShow");' +
      'if(sp){sp.click();await new Promise(function(r){setTimeout(r,140);});}' +
      'out.shown=pet?pet.style.display!=="none":null;' +
      'document.querySelectorAll(".toggle").forEach(function(t){t.click();t.click();});' +
      'await new Promise(function(r){setTimeout(r,220);});' +
      'out.errCount=out.errs.length;out.errText=out.errs.join(" | ");' +
      'return out;})()'
    );
    check('前置：弹窗里有角色元件', !!r && r.hasPet === true, JSON.stringify(r));
    check('点「装」真的换图（不是只变色）', !!r && r.src0 !== r.src1, r ? r.src0 + ' → ' + r.src1 : '');
    check('点「姿」确有换动作：换姿势立绘或换 CSS 姿态，两者至少变一个（旧写法拿 src 和 data-pose 比，恒不相等）',
      !!r && (r.pose0 !== r.pose1 || r.poseAttr0 !== r.poseAttr) &&
      ['sit', 'happy', 'point', 'sad'].indexOf(r.poseAttr) !== -1,
      r ? r.pose0 + ' → ' + r.pose1 + ' / ' + r.poseAttr0 + ' → ' + r.poseAttr : '');
    check('点「藏」会收起来', !!r && r.hidden === true, '');
    check('「显示小人」能叫回来', !!r && r.shown === true, '');
    check('点完全部开关（来回各一次）没有未捕获异常', !!r && r.errCount === 0, r ? r.errText : '');
  }
});

// ── 前端专项：弹窗「检测 API 连接」的报错要能一眼定位 ────────────────────────
// 现场故障：用户 API 没钱（服务商 402 Insufficient Balance），旧实现显示
// 「连接失败 (402): {JSON}」—— 用户去查网络、重装插件，唯独没想到充值。
// 现在报错经 libs/api-error.js 分类：人看到「【账户余额不足】…去充值」。
// 注意这条场景**必须把 forcedStatus 还原**，否则后面所有答题场景一起挂。
SCENARIOS.push({
  name: '弹窗测试连接：没钱（402）显示「余额不足」而不是「连接失败」',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    ctx.mock.setStatus(402);
    try {
      // ⚠️ 「检测 API」读的是**表单**（getApiFormConfig），不是 storage ——
      // 表单也不随 storage.onChanged 刷新（那个监听只管运行状态）。
      // 所以必须直接填表单字段；写 storage 不仅没用，还会让请求打到真实服务商。
      await ctx.client.evaluate(
        '(function(){' +
        'document.getElementById("apiUrl").value = "http://127.0.0.1:' + PORT + '";' +
        'document.getElementById("apiKey").value = "sk-e2e-classification";' +
        'document.getElementById("model").value = "mock-model";' +
        'return true;})()'
      );
      await sleep(150);
      await ctx.client.evaluate('document.getElementById("testApi").click()');
      // 处理链：ping（≤1.5s）→ 请求 mock → patch 配置 → toast；轮询等 toast 落定
      var toast = '';
      for (var i = 0; i < 40; i++) {
        await sleep(150);
        toast = await ctx.client.evaluate('String(document.getElementById("toast").textContent || "")');
        if (/余额不足|连接失败/.test(toast)) break;
      }
      check('402 的 toast 说出「余额不足」并给出下一步（不再叫连接失败）',
        /余额不足/.test(toast) && /充值/.test(toast) && !/连接失败/.test(toast),
        toast.slice(0, 140));

      var stored = await ctx.client.evaluate(
        'new Promise(function (res) { chrome.storage.local.get("config", function (r) {' +
        'res({ failed: !!(r.config || {}).apiConnectionFailed,' +
        'err: String((r.config || {}).apiConnectionError || "") }); }); })'
      );
      check('写进配置的 apiConnectionError 也是分类后的人话（弹窗横幅同源）',
        /余额不足/.test(stored.err) && !/^\s*连接失败 \(\d+\)/.test(stored.err),
        JSON.stringify(stored).slice(0, 160));
      var shown = await ctx.client.evaluate(
        '(function(){var el=document.getElementById("apiConnState");' +
        'return {hidden:!!(el&&el.hidden),text:String((el||{}).textContent||"")};})()'
      );
      check('弹窗状态行常驻显示分类后的人话（storage.onChanged 同步）',
        !!shown && shown.hidden === false && /余额不足/.test(shown.text),
        JSON.stringify(shown));
    } finally {
      ctx.mock.setStatus(0);
    }
  }
});

// ── 前端专项：成长小游戏（好感度 / 等级 / 刷课时长）─────────────────────────
// 断言的是**行为**：摸头之后共享存档（chrome.storage 的 omitonePetBond）里好感真的涨了、
// 徽章真的换了字、刷课时长真的按水位折算 —— 不是查内部函数是否存在。
// ⚠️ 摸头三连（2 秒内 3 次）会触发"躲开"，不涨好感 —— 每次点击之间要拉开间隔。
// ⚠️ 存档真源是 chrome.storage（与上课页伴侣共享）：改完要等 onChanged 传回弹窗内存
//    再点（直接改完立刻点，摸的还是旧内存态）。
SCENARIOS.push({
  name: '小游戏：摸头涨好感、跨级换徽章、刷课时长折算',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var ui = await ctx.client.evaluate(
      '(function(){return {game:!!self.OmitonePetGame,' +
      'bond:!!document.getElementById("petBond"),badge:!!document.getElementById("petLevel")};})()'
    );
    check('前提：pet-game 已加载，好感条与等级徽章都在',
      !!ui && ui.game === true && ui.bond === true && ui.badge === true, JSON.stringify(ui));

    // 从零开始：把共享存档**拨零**（必须用 set 不能用 remove ——
    // remove 的 changes.newValue 为空、弹窗内存里的旧档会存活下来，
    // 后续摸头全从旧值续；set 会触发 onChanged 把内存一起归零。实测踩过）
    await ctx.client.evaluate(
      'new Promise(function (res) {' +
      'try { localStorage.removeItem("omitone.pet.bond"); } catch (e) {}' +
      'var game = self.OmitonePetGame;' +
      'var fresh = {affection: 0, day: game.dayKeyOf(Date.now()), patsToday: 0, studyPointsToday: 0, countedSeconds: 0};' +
      'chrome.storage.local.set({ omitonePetBond: fresh }, function () { res(true); }); })'
    );
    await sleep(400);   // onChanged → 弹窗内存归零

    // 摸头一下 → 好感 +1 入共享存档
    await ctx.client.evaluate('document.getElementById("mascot").click()');
    await sleep(300);
    var afterPat = await ctx.client.evaluate(
      'new Promise(function (res) { chrome.storage.local.get("omitonePetBond", function (r) {' +
      'res(r && r.omitonePetBond ? r.omitonePetBond : null); }); })'
    );
    check('摸头一次 → 好感 +1 入共享存档', !!afterPat && afterPat.affection === 1, JSON.stringify(afterPat));

    // 刷课时长折算：写 1 小时统计、清零水位 → 等 onChanged 传回 → 摸头触发结算 → +2
    await ctx.client.evaluate(
      'new Promise(function (res) {' +
      'var game = self.OmitonePetGame;' +
      'var st = {date: game.dayKeyOf(Date.now()), activeSeconds: 3600, lastActiveAt: Date.now(), lastFlushAt: Date.now()};' +
      'chrome.storage.local.set({ omitoneStudyStats: st }, function () {' +
      'chrome.storage.local.get("omitonePetBond", function (r) {' +
      'var bond = r.omitonePetBond; bond.countedSeconds = 0;' +
      'chrome.storage.local.set({ omitonePetBond: bond }, function () { res(true); }); }); }); })'
    );
    await sleep(400);   // onChanged → 弹窗内存
    await sleep(2200);  // 与上一次摸头拉开 2 秒，避免触发"三连戳躲开"
    await ctx.client.evaluate('document.getElementById("mascot").click()');
    await sleep(300);
    var afterStudy = await ctx.client.evaluate(
      'new Promise(function (res) { chrome.storage.local.get("omitonePetBond", function (r) {' +
      'res(r && r.omitonePetBond ? r.omitonePetBond : null); }); })'
    );
    check('1 小时刷课折 2 点好感（触发结算的那次摸头本身也 +1 → 1+2+1=4；水位停在 3600 秒）',
      !!afterStudy && afterStudy.affection === 4 && afterStudy.countedSeconds === 3600 && afterStudy.patsToday === 2,
      JSON.stringify(afterStudy));

    // 跨级：把好感拨到 14 → 等 onChanged → 再摸一下 → 15 → 徽章换「打过招呼」
    await ctx.client.evaluate(
      'new Promise(function (res) { chrome.storage.local.get("omitonePetBond", function (r) {' +
      'var bond = r.omitonePetBond; bond.affection = 14; bond.patsToday = 0;' +
      'chrome.storage.local.set({ omitonePetBond: bond }, function () { res(true); }); }); })'
    );
    await sleep(400);
    // 拨 14 → 等 onChanged 传回弹窗内存 → 摸头 → 跨级。时序经过实测：
    // set 之后 400ms 点击（探针验证过的路径）；更长的等待反而会撞上闲置演出，不划算
    var leveled = await ctx.client.evaluate(
      'new Promise(function (res) {' +
      'var errs = [];' +
      'window.addEventListener("error", function (e) { errs.push(String(e.message || e)); });' +
      'function readBond(done) {' +
      '  chrome.storage.local.get("omitonePetBond", function (r) { done(r && r.omitonePetBond || null); });' +
      '}' +
      'readBond(function (bond) {' +
      '  bond.affection = 14; bond.patsToday = 0;' +
      '  chrome.storage.local.set({ omitonePetBond: bond }, function () {' +
      '    setTimeout(function () {' +
      '      document.getElementById("mascot").click();' +
      '      setTimeout(function () {' +
      '        readBond(function (bond2) {' +
      '          res({badge: String(document.getElementById("petLevel").textContent || ""),' +
      '              aff: bond2 ? bond2.affection : null,' +
      '              errs: errs});' +
      '        });' +
      '      }, 400);' +
      '    });' +
      '  });' +
      '});' +
      '});'
    );
    check('好感到 15 → 徽章换成「打过招呼」（无页面异常）',
      !!leveled && leveled.badge === '打过招呼' && leveled.aff === 15 && leveled.errs.length === 0,
      JSON.stringify(leveled));
  }
});

// ── 前端专项：上课页角色伴侣 ────────────────────────────────────────────────
// 弹窗合上角色就没了 —— 现在她跟到学习页（Shadow DOM 注入）。
// 主世界读不到 chrome.storage，所以断言全落在 Shadow DOM 的 UI 表现上：
// 立绘真的加载了（web_accessible 生效）、摸头后好感条真的动了、收起/唤回真的切状态。
SCENARIOS.push({
  name: '上课页角色伴侣：出现在学习页、摸头涨好感、收起与唤回',
  path: '/quiz',
  run: async function (ctx) {
    var mounted = null;
    for (var i = 0; i < 24; i++) {
      await sleep(250);
      mounted = await ctx.client.evaluate(
        '(function(){var h=document.getElementById("omitone-page-pet-host");' +
        'if(!h||!h.shadowRoot)return null;' +
        'var img=h.shadowRoot.getElementById("petImg");' +
        'var lv=h.shadowRoot.getElementById("level");' +
        'return {img:!!img,loaded:!!img&&img.naturalWidth>0,' +
        'level:String(lv.textContent||""),title:String(lv.getAttribute("title")||"")};})()'
      );
      if (mounted && mounted.img) break;
    }
    check('伴侣出现在学习页，且立绘真的加载了（web_accessible_resources 生效）',
      !!mounted && mounted.img === true && mounted.loaded === true, JSON.stringify(mounted));
    // 徽章那条旧断言是 `level.length > 0` —— 而模板里 `<div class="level" id="level">初识</div>`
    // 出厂就带字（content.js:1895），渲染整段坏掉它照样绿。真判据是**渲染出来的那一档**：
    // `title` 只有 `renderPagePet` 跑过才会有（content.js:1701），
    // 再从里面读回好感度，按 LEVELS 阈值算出该显示哪一档名字。
    // 存档是异步读的，元素先出现、渲染后落，所以这里要再等一拍（最多 3 秒），不能拿首次采样当结论。
    for (var tw = 0; tw < 12; tw++) {
      if (mounted && /^好感度/.test(mounted.title)) break;
      await sleep(250);
      mounted = await ctx.client.evaluate(
        '(function(){var h=document.getElementById("omitone-page-pet-host");' +
        'if(!h||!h.shadowRoot)return null;' +
        'var lv=h.shadowRoot.getElementById("level");' +
        'return {level:String(lv.textContent||""),title:String(lv.getAttribute("title")||"")};})()'
      );
    }
    var lvMin = [0, 15, 30, 50, 70, 90, 140, 200];
    var lvName = ['初识', '打过招呼', '熟络', '亲近', '挚友', '形影不离', '心有灵犀', '岁月同行'];
    var affMatch = /好感度\s*(\d+)/.exec((mounted && mounted.title) || '');
    var aff = affMatch ? Number(affMatch[1]) : -1;
    var expectName = null;
    for (var li = lvMin.length - 1; li >= 0; li--) { if (aff >= lvMin[li]) { expectName = lvName[li]; break; } }
    check('等级徽章按存档渲染（不是模板里那句出厂文案）：' +
      'title 里的「好感度 ' + aff + '」对应「' + expectName + '」',
      !!mounted && aff >= 0 && expectName === mounted.level, JSON.stringify(mounted));

    // 摸头：好感条宽度发生变化（存档在 storage，主世界读不到 —— 断 UI 表现）
    var before = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'return h.shadowRoot.getElementById("bondBar").style.width||"";})()'
    );
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'h.shadowRoot.getElementById("petImg").click();return true;})()'
    );
    await sleep(350);
    var after = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'return {w:h.shadowRoot.getElementById("bondBar").style.width||"",' +
      'bubbleCls:String(h.shadowRoot.getElementById("bubble").className||"")};})()'
    );
    check('摸头后好感条动了、气泡给了反馈',
      !!after && after.w !== before && /show/.test(after.bubbleCls),
      JSON.stringify({ before: before, after: after }));

    // 收起 → 只剩小入口；点入口 → 唤回
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'h.shadowRoot.getElementById("hideBtn").click();return true;})()'
    );
    await sleep(250);
    var hidden = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'return String(h.shadowRoot.getElementById("wrap").className||"");})()'
    );
    check('「收」后进入隐藏模式（角色藏起、留小入口）', /mode-hidden/.test(hidden), hidden);
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'h.shadowRoot.getElementById("pillBtn").click();return true;})()'
    );
    await sleep(250);
    var restored = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'return String(h.shadowRoot.getElementById("wrap").className||"");})()'
    );
    check('点「宠」唤回（隐藏模式解除）', !/mode-hidden/.test(restored), restored);

    // ── 2026-11-12 现场补的三条 ────────────────────────────────────────────
    // 上面那四条（挂载/摸头/收起/唤回）在拖动整个坏掉的那几天**全是绿的** ——
    // 因为它们一条都没碰"她往哪儿摆、说话是什么形状、拖得动吗"。用户看到的正是这三样。
    // ① 气泡形状：旧 CSS 是 `left:66px` 挂在 92px 宽的 wrap 里，可用宽度只剩 26px，
    //    `max-width:200px` 只是上限不会把盒子撑开 → 每行一个字，现场量到 31×215 的竖排。
    var bubbleShape = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var b=h.shadowRoot.getElementById("bubble");' +
      'b.textContent="\u6210\u5c31\u70b9\u4eae\u300c\u4e09\u65e5\u6253\u9c7c\u300d\u2014\u2014 \u8fd9\u4e00\u5468\u4f60\u90fd\u5728\u8ba4\u771f\u5237\u8bfe\uff0c\u597d\u611f\u5ea6\u53c8\u8fd1\u4e86\u4e00\u6b65\uff1b\u518d\u591a\u6765\u51e0\u5929\u5c31\u80fd\u5347\u5230\u300c\u8001\u670b\u53cb\u300d\u3002";' +
      'b.classList.add("show");var r=b.getBoundingClientRect();' +
      'return {w:Math.round(r.width),h:Math.round(r.height),left:Math.round(r.left),right:Math.round(r.right),vw:window.innerWidth};})()'
    );
    check('气泡是横排的一小块，不再每行一个字（旧形状 31×215）',
      !!bubbleShape && bubbleShape.w >= 120 && bubbleShape.h <= 110 &&
      bubbleShape.w >= bubbleShape.h * 1.2 && bubbleShape.left >= 0 && bubbleShape.right <= bubbleShape.vw,
      JSON.stringify(bubbleShape));
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var b=h.shadowRoot.getElementById("bubble");b.textContent="";b.classList.remove("show");return true;})()'
    );

    // ② 拖动：pointerdown 要挂上 dragging、move 之后 host 真的跟着走。
    //    ⚠️ 这条是本轮真正的回归闸：拖动 handler 里曾引用了块级作用域外的裸 `host`
    //    （`const host` 只在构建那个 try 块里存在），ReferenceError 被 handler 自己的
    //    catch 吞掉 → 现场表现为"拖不动、日志一条没有"，而沙盒四条全绿。
    //    收尾用 pointercancel（不写存档），再把 inline 位置清回默认锚点。
    var drag = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var c=h.shadowRoot.getElementById("card");var errs=[];' +
      'window.addEventListener("error",function(e){errs.push(String(e.message||e));});' +
      'var r0=h.getBoundingClientRect();var x=r0.left+20,y=r0.top+20;' +
      'function pe(t,px,py){c.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,composed:true,' +
      'pointerId:3,pointerType:"mouse",isPrimary:true,button:0,buttons:(t==="pointercancel"||t==="pointerup")?0:1,clientX:px,clientY:py}));}' +
      // 往左上拖：这个方向在沙盒视口里不会撞边界，位移必须**逐像素等于**手指位移
      'pe("pointerdown",x,y);var clsDown=String(c.className);' +
      'pe("pointermove",x-120,y+90);var r1=h.getBoundingClientRect();' +
      'pe("pointercancel",x-120,y+90);var clsEnd=String(c.className);' +
      // 再往右外拖：越界必须被 clamp 拉回屏内（留 8px 边），不许拖出窗口再也点不到
      'var r2=h.getBoundingClientRect();var ax=r2.left+20,ay=r2.top+20;' +
      'pe("pointerdown",ax,ay);pe("pointermove",ax+900,ay);var r3=h.getBoundingClientRect();' +
      'pe("pointercancel",ax+900,ay);' +
      'var w=Math.round(r3.width);' +
      'h.style.left="";h.style.top="";h.style.right="84px";h.style.bottom="176px";' +
      'return {clsDown:clsDown,clsEnd:clsEnd,dx:Math.round(r1.left-r0.left),dy:Math.round(r1.top-r0.top),' +
      'clampedLeft:Math.round(r3.left),clampExpect:Math.round(window.innerWidth)-w-8,errs:errs};})()'
    );
    check('拖得动：按住挂 dragging、位移逐像素跟着手指、松手类清掉、拖出右缘被 clamp 回屏内',
      !!drag && /dragging/.test(drag.clsDown) && !/dragging/.test(drag.clsEnd) &&
      drag.dx === -120 && drag.dy === 90 && drag.clampedLeft === drag.clampExpect && drag.errs.length === 0,
      JSON.stringify(drag).slice(0, 220));

    // ③ 她不再压在右下角那两块东西上。沙盒里状态面板**不会出现**（它只在点了「开始刷课」
    //    之后挂），所以这里断的是现场量出来的两条"让位带"，而不是去比一个不存在的矩形：
    //      · 状态面板 bottom:18 + 高约 120 → 视口底部 138px 是它的带子
    //      · 学习通自己的右侧竖条 .iconBox 宽 40、左边缘在 vw-70
    //    实测默认锚点 right:84 / bottom:176 → 右边缘留 84、底边留 176，两条都过。
    var geo = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var c=h.shadowRoot.getElementById("card");var b=c.getBoundingClientRect();' +
      'return {rightGap:Math.round(window.innerWidth-b.right),bottomGap:Math.round(window.innerHeight-b.bottom),' +
      'vw:window.innerWidth,vh:window.innerHeight,w:Math.round(b.width),h:Math.round(b.height),' +
      'l:Math.round(b.left),t:Math.round(b.top)};})()'
    );
    check('默认锚点让开右下角两块地：右侧 ≥70px（站点竖条）、底部 ≥140px（状态面板带）',
      !!geo && geo.rightGap >= 70 && geo.bottomGap >= 140 &&
      geo.l >= 0 && geo.t >= 0 && geo.l + geo.w <= geo.vw && geo.t + geo.h <= geo.vh,
      JSON.stringify(geo).slice(0, 220));

    // ④ 心形的落点。这一条以前**根本没有**，所以"把视口坐标当 wrap 内坐标"那个 bug
    //    （1699 宽的屏上把她扔到屏外一千多像素）改坏了也没人报警 —— 反向验证注入它，红 0 条。
    //    判据用**相对 wrap 原点**的期望值比：合成 click 的 clientX=0，
    //    处理器会退回"立绘中心"，所以期望值算得出来，且与随机抖动（±13/±5）留了余量。
    var hearts = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var sr=h.shadowRoot;var img=sr.getElementById("petImg");' +
      'Array.prototype.forEach.call(sr.querySelectorAll(".heart"),function(x){x.remove();});' +
      'img.click();' +
      'var list=Array.prototype.slice.call(sr.querySelectorAll(".heart"));' +
      'var wr=sr.getElementById("wrap").getBoundingClientRect();' +
      'var ir=img.getBoundingClientRect();' +
      'var got=list.map(function(x){return {l:Math.round(parseFloat(x.style.left)||0),t:Math.round(parseFloat(x.style.top)||0)};});' +
      'var wantL=Math.round(ir.left+ir.width/2-wr.left),wantT=Math.round(ir.top+8-wr.top);' +
      'var bad=got.filter(function(p){return Math.abs(p.l-wantL)>18||Math.abs(p.t-wantT)>18;});' +
      'return {n:got.length,wantL:wantL,wantT:wantT,bad:bad.length,sample:got.slice(0,2),offscreen:got.filter(function(p){return p.l>window.innerWidth||p.t>window.innerHeight;}).length};})()'
    );
    check('摸头的心形长在她身上：4 颗、按 wrap 原点定位、没有一颗被扔到视口外',
      !!hearts && hearts.n === 4 && hearts.bad === 0 && hearts.offscreen === 0,
      JSON.stringify(hearts).slice(0, 220));

    // ⑤ 悬停反应（用户原话"交互也基本上不会动"）。走 pointerenter 而不是 CSS :hover：
    //    Runtime.evaluate 派发不出真·悬停态，纯 CSS 写法等于没测试。
    var hover = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var c=h.shadowRoot.getElementById("card");' +
      'function pe(t){c.dispatchEvent(new PointerEvent(t,{bubbles:false,cancelable:true,composed:true,' +
      'pointerId:7,pointerType:"mouse",clientX:0,clientY:0}));}' +
      'var base=getComputedStyle(c).boxShadow;' +
      'pe("pointerenter");var on=c.classList.contains("peek");' +
      'var shadowOn=getComputedStyle(c).boxShadow,borderOn=getComputedStyle(c).borderColor;' +
      'pe("pointerleave");var off=c.classList.contains("peek");' +
      'return {on:on,off:off,changed:shadowOn!==base,back:getComputedStyle(c).boxShadow===base,' +
      'borderOn:borderOn,base:base,on2:shadowOn};})()'
    );
    check('鼠标移上去她真的有反应（peek 挂上、阴影/边框换了色），移开就收回',
      !!hover && hover.on === true && hover.off === false && hover.changed === true && hover.back === true,
      JSON.stringify(hover).slice(0, 240));

    // ⑥ 她自己偶尔开口：四条"别说"各挡各的（第四条「标签页在后台」只能切真后台，见 ⑥-b）。
    //    ⚠️ 每个"闭嘴"断言前都要先把**别的**门槛拨到"该说话"（quiet() 把上次开口推到 200 秒前），
    //    否则"她没说"可能只是时间没到 —— 那就是把已知缺陷改坏了也照样绿的假绿。
    await ctx.client.send('Page.bringToFront');   // document.hidden 必须为 false，否则正例永远不成立
    var idle = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var sr=h.shadowRoot;var wrap=sr.getElementById("wrap");var c=sr.getElementById("card");' +
      'var b=sr.getElementById("bubble");' +
      // 把手是"拍一拍"的事件，**回执读气泡本身** —— 内容脚本与页面是两个 JS 世界，' +
      // 函数与数据都传不过来（只有 DOM 与属性共用）。
      'function tick(){b.textContent="";b.classList.remove("show");' +
      'h.dispatchEvent(new Event("omitone:pet-idle-tick"));' +
      'return {sp:/show/.test(String(b.className)),txt:String(b.textContent||"")};}' +
      'function quiet(){h.dataset.saidAt=String(Date.now()-200000);}' +
      // 自证：把"上次开口"拨到 200 秒前拍一下，气泡必须亮。不亮 = 监听器压根没挂上，
      // 下面每一条"她闭嘴"都会因此假绿 —— 先把它单独钉成一条前提断言。
      'var saved=String(h.dataset.saidAt||"");quiet();var probe=tick();' +
      'if(saved){h.dataset.saidAt=saved;}else{h.removeAttribute("data-said-at");}' +
      'if(probe.sp!==true)return {hook:false};' +
      'var o={hook:true,hidden:document.hidden};' +
      // 时间门槛：刚说过话（上面那一下就是"刚说过"）→ 不许插话。此时其它条件都允许说话。
      'o.freshQuiet=!tick().sp;' +
      // 被收起：拨到该说了，也必须闭嘴
      'quiet();wrap.classList.add("mode-hidden");o.hiddenQuiet=!tick().sp;' +
      'wrap.classList.remove("mode-hidden");' +
      // 正被拖着走：同上
      'quiet();c.classList.add("dragging");o.dragQuiet=!tick().sp;c.classList.remove("dragging");' +
      // 标签页在后台这一档**不在这个探针里**：内容脚本与页面是两个 JS world，
      // 在页面世界里给 `document` 挂 own `hidden` 属性，内容脚本那边读到的仍是原型上的 false
      // （实测：桩打上后"她照样说话"）。真把它翻成 hidden 只有一条路 —— 把**这一页所在的窗口**
      // 最小化（切另一个标签页不够，实测见下面 ⑥-b），自证 hidden 后单独一段跑。
      // 正例：安静够了 → 说一句，气泡真的亮，形状是一小块
      'quiet();var t=tick();var r=b.getBoundingClientRect();' +
      'o.line=t.txt;o.spoke=t.sp&&t.txt.length>0;' +
      'o.shape={w:Math.round(r.width),h:Math.round(r.height)};' +
      // 一句之后立刻又不说（否则 15 秒一拍 = 话痨）
      'o.onceOnly=!tick().sp;' +
      'o.saidRefreshed=(Number(h.dataset.saidAt)>Date.now()-3000);' +
      'b.classList.remove("show");return o;})()'
    );
    check('前提：自动台词的把手真的通（拨旧时间戳拍一下，气泡必须亮）',
      !!idle && idle.hook === true && idle.hidden === false, JSON.stringify(idle).slice(0, 160));
    check('她自己开口只在该开口时：刚说过/被收起/正拖着 → 三种都闭嘴；安静够了 → 说一句且只一句',
      !!idle && idle.freshQuiet === true && idle.hiddenQuiet === true && idle.dragQuiet === true &&
      idle.spoke === true && idle.onceOnly === true && idle.saidRefreshed === true,
      JSON.stringify(idle).slice(0, 300));
    check('自动台词那口气的形状也是一小块横排（不是竖条）',
      !!idle && !!idle.shape && idle.shape.w >= 88 && idle.shape.h <= 62 && idle.shape.w > idle.shape.h,
      JSON.stringify(idle && idle.shape));

    // ⑥-b 「标签页在后台」这一档 —— 只能切**真**后台（批次 39，全量跑改法见批次 41）。
    //     页面世界与内容脚本是两个 JS world：在页面世界里给 `document` 挂 own `hidden`
    //     属性，内容脚本读到的仍是原型上的 false（实测打桩后"她照样说话"，那条断言恒绿）。
    //     真翻 hidden 只有一条路：把**同一扇窗口的另一个标签**端成活动标签（`activateTab`，
    //     实测 0~19 毫秒翻）。批次 39 是「随手开一个新标签再激活」—— 只有一扇窗口时管用，
    //     全量跑却不翻（实测 tabs 3→4、flipMs -1）：那一发新标签开去了**别的窗口**，
    //     这一页仍是自己窗口的活动标签。所以这里先查窗口、再动作，两头都自证。
    //     ⚠️ 试过的两条死路：① `Browser.setWindowBounds {state:'minimized'}` 在这台 Edge 上
    //        回 `result:{}` 却纹丝不动（读回 windowState 仍是 normal，hidden 也不翻）；
    //        ② 在页面世界里改 `document.hidden` —— 内容脚本压根读不到。
    //     ⚠️ **可见性要在排拍子之前就位，读完再核一次**：批次 41 第一版是"先排拍子再切窗口"，
    //        前台对照那趟读到 `hidden=true`（这扇窗口会被别的东西压住，OS 层遮挡同样算 hidden）——
    //        "她没说话"和"这趟压根不在要求的那一档里"就同形了。所以每一趟先站好位、再拍一次、
    //        读回来不对就整趟重来（最多三趟）；三趟都稳不住才判失败。
    //     ⚠️ 后台标签页的 setTimeout 被节流到最小 1 秒 → 排程 1600ms、节点侧等到 3400ms。
    //     ⚠️ **必须配对跑一个同样排程、但不切后台的对照**：少了它，"气泡没亮"可能只是
    //        定时器压根没跑。而且两趟都在页面世界里数拍子有没有真落地（`__pkTicks`），
    //        `tickFired < 1` 一样整趟重来 —— 否则"她闭嘴"和"定时器被节流到没跑"同形。
    //     读结果在**仍是后台时**用 CDP 读（evaluate 不抢焦点）：唤回前台再读的话，
    //     她自己那条 15 秒 interval 可能正好插进来点亮气泡，把"该闭嘴"验成"说话了"。
    var bgPlan = null;
    var readHidden = async function () {
      return await ctx.client.evaluate('(function(){return document.hidden;})()');
    };
    /** 轮询到要求的那一档为止；返回耗时（毫秒），没等到返回 -1 —— 只报实测，不报自认为的成功。 */
    var untilHidden = async function (want, rounds) {
      var t0 = Date.now();
      var n = rounds || 14;
      for (var i = 0; i < n; i++) {
        if ((await readHidden()) === want) return Date.now() - t0;
        await sleep(150);
      }
      return -1;
    };
    // 找「和这一页同一扇窗口」的接管标签，**全部收下来**（批次 45：以前只留第一枚）。
    // 只有一枚候选时够用；全量跑里那一枚（配置写入器 popup）实测端不动这一页，
    // 于是整场恒红 —— 而"哪一枚能动"事先并不知道，只能逐枚试、每枚自证。
    var findStandIn = async function () {
      var plan = { win: null, cands: [], opened: null };
      return (await withBrowserClient(async function (bc) {
        var infos = ((await bc.send('Target.getTargets')) || {}).targetInfos || [];
        var pages = infos.filter(function (x) { return x.type === 'page'; });
        var wa = await bc.send('Browser.getWindowForTarget', { targetId: ctx.targetId });
        plan.win = (wa && wa.windowId) || null;
        var sameWin = async function (tid) {
          var w = await bc.send('Browser.getWindowForTarget', { targetId: tid });
          return !!w && w.windowId === plan.win;
        };
        for (var i = 0; i < pages.length && plan.cands.length < 4 && i < 16; i++) {
          if (pages[i].targetId === ctx.targetId) continue;
          if (await sameWin(pages[i].targetId)) {
            plan.cands.push({ id: pages[i].targetId, url: String(pages[i].url || '').replace(/^https?:\/\//, '').slice(0, 34) });
          }
        }
        return plan;
      })) || plan;
    };
    /**
     * 把这一页挤下后台 = 把同窗口另一枚标签端成活动标签，并轮询到 hidden===true 为止。
     * ⚠️ 每一枚都要**实测** hidden 翻没翻：activateTab 回 true 只说明 HTTP 成功，
     *    不说明这一页真的下后台（批次 45 全量跑就是这个：候选找到了、请求发出去了，hidden 不动）。
     *    现成的四枚都端不动才新开一枚 —— 新开之前必须先把这一页端到最前，
     *    否则新标签会开去别的窗口（批次 39 的恒红就是这么来的）。
     */
    var pushBehind = async function () {
      if (!bgPlan) bgPlan = await findStandIn();
      var tried = [];
      var list = (bgPlan.cands || []).slice(0, 4);
      for (var i = 0; i < list.length; i++) {
        var ok = await activateTab(list[i].id);
        var ms = await untilHidden(true, 6);
        tried.push({ k: '现成', u: list[i].url, ok: ok, ms: ms });
        if (ms >= 0) return { win: bgPlan.win, cand: list[i].id, opened: bgPlan.opened, flipMs: ms, tried: tried };
      }
      await ctx.client.send('Page.bringToFront').catch(function () {});
      // 上一趟新开的那枚还挂着就先关掉（整轮只留一枚，否则三趟重试会攒出三枚空白标签抢焦点）
      if (bgPlan.opened) {
        await closeTab(bgPlan.opened).catch(function () {});
        bgPlan.opened = null;
      }
      var fresh = await withBrowserClient(async function (bc) {
        var r = await bc.send('Target.createTarget', { url: 'about:blank' });
        var tid = r && r.targetId;
        if (!tid) return null;
        var w = await bc.send('Browser.getWindowForTarget', { targetId: tid });
        return w && w.windowId === bgPlan.win ? tid : null;
      });
      if (!fresh) {
        tried.push({ k: '新开', u: '(开去了别的窗口)', ok: false, ms: -1 });
        return { win: bgPlan.win, cand: null, opened: bgPlan.opened, flipMs: -1, tried: tried };
      }
      bgPlan.opened = fresh;
      var ok2 = await activateTab(fresh);
      var ms2 = await untilHidden(true, 10);
      tried.push({ k: '新开', u: 'about:blank', ok: ok2, ms: ms2 });
      return { win: bgPlan.win, cand: fresh, opened: fresh, flipMs: ms2, tried: tried };
    };
    /** 唤回：先把这趟新开的接管标签关掉（留着会继续抢焦点），再端到最前，轮询到 hidden===false 为止。 */
    var wakeUp = async function () {
      if (bgPlan && bgPlan.opened) {
        await closeTab(bgPlan.opened);
        bgPlan.opened = null;
      }
      await ctx.client.send('Page.bringToFront').catch(function () {});
      return await untilHidden(false) >= 0;
    };

    var readPet = async function () {
      return await ctx.client.evaluate(
        '(function(){var h=document.getElementById("omitone-page-pet-host");' +
        'var b=h.shadowRoot.getElementById("bubble");' +
        'var spoke=/show/.test(String(b.className));var txt=String(b.textContent||"");' +
        'b.classList.remove("show");' +
        'return {hidden:document.hidden,spoke:spoke,txt:txt,ticks:window.__pkTicks};})()'
      );
    };
    var petIdleOnce = async function (toBackground) {
      var want = !!toBackground;
      var run = async function () {
        var beforeSwitch = await readHidden();
        var how = toBackground ? await pushBehind() : { woke: await wakeUp() };
        var at = await ctx.client.evaluate(
          '(function(){var h=document.getElementById("omitone-page-pet-host");' +
          'var b=h.shadowRoot.getElementById("bubble");' +
          'b.textContent="";b.classList.remove("show");' +
          // 拍子计数器：主世界也挂一个监听，只数"这一记拍子真的派发到 host 上了"
          'if(typeof window.__pkTicks!=="number")window.__pkTicks=0;' +
          'if(!window.__pkTickHooked){window.__pkTickHooked=1;' +
          ' h.addEventListener("omitone:pet-idle-tick",function(){window.__pkTicks++;});}' +
          'var fired=window.__pkTicks;' +
          // 时间门槛拨到"该说话"（200 秒没开口），只剩这一档（后台/前台）在起作用
          'h.dataset.saidAt=String(Date.now()-200000);' +
          'setTimeout(function(){h.dispatchEvent(new Event("omitone:pet-idle-tick"));},1600);' +
          'return {hidden:document.hidden,fired:fired};})()'
        );
        var t0 = Date.now();
        await sleep(Math.max(700, 3400 - (Date.now() - t0)));
        var out = await readPet();
        out.beforeSwitch = beforeSwitch;
        out.atSchedule = at && at.hidden;
        out.how = how;
        out.tickFired = (typeof out.ticks === 'number' ? out.ticks : 0) - (Number(at && at.fired) || 0);
        return out;
      };
      var out = null, attempts = 0;
      while (attempts < 3) {
        attempts++;
        out = await run();
        // 这一趟算不算数：拍子真落地了 + 排的时候和读的时候都在要求的那一档可见性上
        if (out.tickFired >= 1 && out.atSchedule === want && out.hidden === want) break;
      }
      out.attempts = attempts;
      out.flipMs = out.how && typeof out.how.flipMs === 'number' ? out.how.flipMs : -1;
      // 后台那趟测完就唤回 —— ⑦ 真鼠标和后面的场景都要求这一页在前台，
      // 唤没唤回由下面「独立回读」那条前提验收，不由这里自报。
      if (want) out.back = await wakeUp();
      return out;
    };
    var bgIdle = await petIdleOnce(true);
    // 唤回这件事**独立回读一次**再看：`wakeUp` 自己报的布尔只说明"它轮询到了"，
    // 而这一页后来可能被别的东西压回去 —— ⑦ 真鼠标与前台对照都建立在"已经回到前台"上。
    var hiddenAfterBg = await readHidden();
    var fgIdle = await petIdleOnce(false);
    check('前提：这一页真的被挤到后台了（切之前 hidden=false、排拍子时与读完时都还是 hidden=true）' +
      '—— 没这一步，"她闭嘴"等于没测',
      !!bgIdle && bgIdle.beforeSwitch === false && bgIdle.atSchedule === true &&
      bgIdle.hidden === true && bgIdle.flipMs >= 0,
      JSON.stringify(bgIdle && {
        before: bgIdle.beforeSwitch, at: bgIdle.atSchedule, after: bgIdle.hidden,
        flipMs: bgIdle.flipMs, attempts: bgIdle.attempts,
        win: bgIdle.how && bgIdle.how.win,
        cand: !!(bgIdle.how && bgIdle.how.cand),
        tried: bgIdle.how && bgIdle.how.tried
      }).slice(0, 220));
    check('前提收尾：这一页真的唤回前台了（**独立回读** document.hidden，不信任唤回函数自己报的那个数）' +
      '—— 回不去的话 ⑦ 真鼠标与前台对照全建在"还在后台"上',
      hiddenAfterBg === false && !!bgIdle && bgIdle.back === true,
      JSON.stringify({ hiddenNow: hiddenAfterBg, back: bgIdle && bgIdle.back, how: bgIdle && bgIdle.how }).slice(0, 620));
    check('标签页在后台时她不插话，回到前台同一拍就说（旧写法在页面世界打桩 document.hidden，内容脚本读不到，恒绿）' +
      '—— 两趟都自证那一拍真的派发到 host 上，且可见性全程站在要求的那一档（不稳就整趟重来，最多三趟）',
      !!bgIdle && !!fgIdle && bgIdle.spoke === false && bgIdle.txt === '' &&
      fgIdle.atSchedule === false && fgIdle.hidden === false && fgIdle.spoke === true && fgIdle.txt.length > 0,
      JSON.stringify({ bg: bgIdle, fg: fgIdle }).slice(0, 300));

    // ⑦ 真鼠标点得动（2026-11-12 现场）。①–⑥ 全是 dispatchEvent / .click()，
    //    而 pointerdown 里那句 setPointerCapture 会把兼容的 mousedown/mouseup/click
    //    **一起改派给捕获目标（card）** —— 挂在立绘上的摸头监听收不到真点击，
    //    合成事件却照样全绿。用户报的「刷课页吉祥物不能互动了」就是这么来的：
    //    悬停、拖动都真在动，只有"摸她一下"死的。只有 CDP Input 域能测到这一条。
    //    ⚠️ 数 .pat 用观察器计数，不用"读当下 class"：那一个 class 只活 480ms，
    //    比的是几个 CDP 往返的快慢，不是行为 —— 现场踩过一次假阴性。
    var patPt = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var i=h.shadowRoot.getElementById("petImg");var r=i.getBoundingClientRect();' +
      'window.__pat=0;' +
      'if(!window.__patObs){window.__patObs=new MutationObserver(function(){' +
      'if(i.classList.contains("pat"))window.__pat++;});' +
      'window.__patObs.observe(i,{attributes:true,attributeFilter:["class"]});}' +
      'Array.prototype.forEach.call(h.shadowRoot.querySelectorAll(".heart"),function(x){x.remove();});' +
      'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),pat:window.__pat,' +
      'hostLeft:Math.round(h.getBoundingClientRect().left)};})()'
    );
    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: patPt.x, y: patPt.y, button: 'left', buttons: 1, clickCount: 1 });
    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: patPt.x, y: patPt.y, button: 'left', buttons: 0, clickCount: 1 });
    var trusted = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");var sr=h.shadowRoot;' +
      'var b=sr.getElementById("bubble");' +
      'return {patSeen:window.__pat,hearts:sr.querySelectorAll(".heart").length,' +
      'spoke:/show/.test(String(b.className||"")),txt:String(b.textContent||"").slice(0,20)};})()'
    );
    check('真鼠标（CDP Input 域）点她也摸头：pat 挂上过、心形冒出、气泡有回执 —— 合成事件测不到这一条',
      !!trusted && trusted.patSeen > patPt.pat && trusted.hearts > 0 && trusted.spoke === true,
      JSON.stringify(trusted) + ' @' + JSON.stringify(patPt));

    // ⑧ 配对：改成"越过 6px 才捕获"之后，真·拖动那一下仍然不许摸头 ——
    //    否则拖她一次就白涨一次好感，等于把"放哪儿"变成了"刷好感"。
    //    拖出去再原路拖回（净位移 0），并把 inline 位置清回默认锚点。
    async function dragPt(pt, ddx) {
      await ctx.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
      for (var s = 1; s <= 4; s++) {
        await ctx.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + Math.round(ddx * s / 4), y: pt.y, button: 'left', buttons: 1, clickCount: 0 });
      }
      await ctx.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x + ddx, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'Array.prototype.forEach.call(h.shadowRoot.querySelectorAll(".heart"),function(x){x.remove();});return true;})()'
    );
    var patBeforeDrag = await ctx.client.evaluate('window.__pat|0');
    await dragPt(patPt, 60);
    var dragged = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");var sr=h.shadowRoot;' +
      'var c=sr.getElementById("card"),i=sr.getElementById("petImg"),b=sr.getElementById("bubble");' +
      'var r=h.getBoundingClientRect();' +
      'return {patAdded:window.__pat,hearts:sr.querySelectorAll(".heart").length,' +
      'dragClass:c.classList.contains("dragging"),movedX:Math.round(r.left-' + patPt.hostLeft + '),' +
      'txt:String(b.textContent||"").slice(0,20)};})()'
    );
    check('真·拖动仍然不摸头（拖一次不许白涨一次好感），拖完 dragging 已摘、她确实跟着走',
      !!dragged && dragged.patAdded === patBeforeDrag && dragged.hearts === 0 &&
      dragged.dragClass === false && dragged.movedX === 60,
      JSON.stringify(dragged) + ' 拖前 pat 计数=' + patBeforeDrag);
    // 原路拖回 + 清回默认锚点，别把位置脏留给后面的场景
    await dragPt({ x: patPt.x + 60, y: patPt.y }, -60);
    await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'h.style.left="";h.style.top="";h.style.right="84px";h.style.bottom="176px";' +
      'Array.prototype.forEach.call(h.shadowRoot.querySelectorAll(".heart"),function(x){x.remove();});return true;})()'
    );
  }
});

// ── 前端混沌猴：暴力点击找崩点 ──────────────────────────────────────────────
// 单测喂的是"想得到"的操作；真实用户是乱点的。种子化 LCG 保证失败可复现。
// ⚠️ 目标集刻意排除 #modeSwitch（会重载页面杀掉 CDP 会话）与 #start/#stop（会启动刷课流）。
SCENARIOS.push({
  name: '前端混沌猴：随机点击 400 次零未捕获异常、角色仍响应',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var chaos = await ctx.client.evaluate(
      '(function(){' +
      'var errs = [];' +
      'window.addEventListener("error", function (e) { errs.push(String(e.message || e)); });' +
      'var seed = 20261031;' +
      'function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }' +
      'var targets = [document.getElementById("mascot")];' +
      'Array.prototype.forEach.call(document.querySelectorAll("#petTools button"), function (b) { targets.push(b); });' +
      'Array.prototype.forEach.call(document.querySelectorAll(".toggle"), function (b) { targets.push(b); });' +
      'targets.push(document.getElementById("petBookClose"));' +
      'targets.push(document.getElementById("btnPetShow"));' +
      'var clicks = 0;' +
      'for (var i = 0; i < 400; i++) {' +
      '  var t = targets[Math.floor(rand() * targets.length)];' +
      '  if (t && t.click) { try { t.click(); clicks++; } catch (e) { errs.push("click: " + e.message); } }' +
      '}' +
      'return {clicks: clicks, errs: errs, mascotAlive: !!document.getElementById("mascot")};})()'
    );
    check('混沌猴 400 次随机点击（角色/工具条/立绘册/折叠）：零未捕获异常、角色仍在',
      !!chaos && chaos.clicks >= 380 && chaos.errs.length === 0 && chaos.mascotAlive === true,
      JSON.stringify(chaos).slice(0, 200));
    // 收尾：混沌之后角色还能正常响应摸头
    var still = await ctx.client.evaluate(
      '(function(){var errs=[];var onerr=function(e){errs.push(String(e.message||e));};' +
      'window.addEventListener("error",onerr);' +
      'var m=document.getElementById("mascot");if(m)m.click();' +
      'window.removeEventListener("error",onerr);' +
      'return {errs:errs,alive:!!m};})()'
    );
    check('混沌之后摸头仍无异常', !!still && still.alive === true && still.errs.length === 0, JSON.stringify(still));
  }
});

SCENARIOS.push({
  name: '上课页伴侣暴力：连点 30 次不崩、收起唤回仍正常',
  path: '/quiz',
  run: async function (ctx) {
    var mounted = null;
    for (var i = 0; i < 24; i++) {
      await sleep(250);
      mounted = await ctx.client.evaluate(
        '(function(){var h=document.getElementById("omitone-page-pet-host");' +
        'return !!(h&&h.shadowRoot&&h.shadowRoot.getElementById("petImg"));})()'
      );
      if (mounted) break;
    }
    check('前提：伴侣已挂载', mounted === true, String(mounted));
    var brute = await ctx.client.evaluate(
      '(function(){var h=document.getElementById("omitone-page-pet-host");' +
      'var img=h.shadowRoot.getElementById("petImg");' +
      'var errs=[];window.addEventListener("error",function(e){errs.push(String(e.message||e));});' +
      'for(var i=0;i<30;i++) img.click();' +
      'var bar=h.shadowRoot.getElementById("bondBar").style.width;' +
      'var wrap=h.shadowRoot.getElementById("wrap");' +
      'h.shadowRoot.getElementById("hideBtn").click();' +
      'var hid=/mode-hidden/.test(wrap.className);' +
      'h.shadowRoot.getElementById("pillBtn").click();' +
      'var back=!/mode-hidden/.test(wrap.className);' +
      'return {bar:String(bar||""),hid:hid,back:back,errs:errs,alive:!!h.shadowRoot.getElementById("petImg")};})()'
    );
    check('伴侣连点 30 次：好感条有值、零异常、收起唤回正常',
      !!brute && brute.alive === true && brute.bar !== '' && brute.hid === true && brute.back === true && brute.errs.length === 0,
      JSON.stringify(brute));
  }
});

/** ---- 1.9 真实平台结构（从同类开源实现的真实页面知识交叉补入）---- */
/**
 * mooc2 新版作业页：容器 .questionLi.singleQuesId（id/data/typename 属性）、
 * 题干 .question-stem、选项 .stem_answer > li.answerBg —— 这一族此前零覆盖。
 */
SCENARIOS.push({
  name: 'mooc2 作业页（真实结构）：抠题 / 题型 / 填答',
  path: '/mooc2-work',
  run: async function (ctx) {
    var scan = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var qs=a._extractQuestions(null);' +
      'return {n:qs.length,titles:qs.map(function(q){return String(q.title).slice(0,30);}),' +
      'types:qs.map(function(q){return q.type;})};})()'
    );
    check('mooc2 容器抠到 2 道题（singleQuesId 此前零覆盖）',
      !!scan && scan.n === 2, JSON.stringify(scan));
    check('题干干净（question-stem + 题号/题型前缀清洗）',
      !!scan && scan.titles[0] === 'mooc2 结构的题干识别测试' && scan.titles[1] === 'mooc2 结构的多选识别测试',
      JSON.stringify(scan && scan.titles));
    check('typename 属性 → 单选/多选',
      !!scan && scan.types[0] === 'single' && scan.types[1] === 'multiple', JSON.stringify(scan && scan.types));
    var fill = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var qs=a._extractQuestions(null);' +
      'a._applyChoiceAnswer(qs[0]._element,"B","single");' +
      'var h=document.getElementById("answer6001");' +
      'return {hidden:h?h.value:null,filled:a._getQuizQuestionFilledValue(null,qs[0])};})()'
    );
    check('mooc2 结构下点 B → 隐藏域写入 B（qid 在 li 上、徽标在）',
      !!fill && fill.hidden === 'B' && fill.filled === 'B', JSON.stringify(fill));
  }
});

SCENARIOS.push({
  name: '字体残留类名（已批改页明文）：不等待、正常抠题',
  path: '/font-residue',
  run: async function (ctx) {
    // content.js 解密扫描（MutationObserver + 300ms 防抖）发现：无字体声明且无 PUA 密文
    // → 明文残留 → 摘掉类名。断言等它完成（至多几秒），且题干正常抠出。
    var cleared = null;
    for (var i = 0; i < 20; i++) {
      await sleep(300);
      cleared = await ctx.client.evaluate(
        '(function(){var a=window._xxtApp;var qs=a._extractQuestions(null);' +
        'return {secret:a._probeFontDecrypt().secret,n:qs.length,' +
        'title:qs.length?String(qs[0].title).slice(0,20):""};})()'
      );
      if (cleared && cleared.secret === false && cleared.n >= 1) break;
    }
    check('明文残留类名被解密扫描摘除（不再每轮白等 8 秒）',
      !!cleared && cleared.secret === false, JSON.stringify(cleared));
    check('明文题干正常抠出（可读中文，非密文）',
      !!cleared && cleared.n >= 1 && /对称加密/.test(cleared.title), JSON.stringify(cleared));
  }
});

/** ---- 1.10 PDF.js 文档（aria 页码，真实结构）：翻页推进与完成 ---- */
SCENARIOS.push({
  name: 'PDF.js 文档（aria 页码）：翻页推进到末页并完成',
  path: '/doc-pdfjs',
  run: async function (ctx) {
    // 驱动 _handleDocumentTask（与真实 tick 同一入口），断言任务对象与推进行为
    var progress = null;
    for (var i = 0; i < 80; i++) {
      await sleep(250);
      progress = await ctx.client.evaluate(
        '(function(){var a=window._xxtApp;' +
        'try { a._handleDocumentTask(null); } catch (e) {}' +
        'var t=a._locateDocumentTask(null);' +
        'return t?{page:t.currentPage,total:t.totalPages,atEnd:!!t.atEnd,done:!!t.finished}:null;})()'
      );
      if (progress && progress.done) break;
    }
    check('PDF.js 文档被识别为翻页任务（aria 页码族此前零覆盖，总页数读自 #numPages）',
      !!progress && progress.total === 5, JSON.stringify(progress));
    check('翻页推进到末页（页码 5）且平台完成标记生效',
      !!progress && progress.done === true && progress.page === 5, JSON.stringify(progress));

    // 文档页同样不许被算成「还有测验没做」—— 与后面轮盘 C 那两条是同一个不变量。
    // 这一页刻意**不带**题面样式类名：它是「原本就没坏」的那一半，
    // 万一哪天 `_detectQuiz` 又改回整页扫通用类名，这一页也会一起变红。
    var idle = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,hasApiKey:true,randomAnswer:false});' +
      'app._quizApiFailUntil=0; app._quizForceSkipUntil=0; app._quizForceSkipPaperKey="";' +
      'app._quizInProgress=false; app._quizSubmitPending=false; app._quizAnswered=false;' +
      'var doc=app._resolveQuizSubmitDocument(null);' +
      'return {detect:app._detectQuiz(),pending:app._isQuizLearningPending(),' +
      '  apiReason:app._getQuizApiUnavailableReason(),skipping:app._isQuizForceSkipping(null),' +
      '  monitor:!!app._monitorQuizSubmit(null),passed:!!app._isQuizPassedOrFinished(doc),' +
      '  redo:!!app._isQuizRedoRequired(doc),submitForm:!!app._hasActiveQuizSubmitForm(doc)};})()'
    );
    check('文档页 `_detectQuiz()` 为 false', !!idle && idle.detect === false, JSON.stringify(idle));
    check('文档页 `_isQuizLearningPending()` 为 false，且不是靠早退分支蒙出来的',
      !!idle && idle.pending === false && idle.apiReason === '' && idle.skipping === false &&
      idle.monitor === false && idle.passed === false && idle.redo === false && idle.submitForm === false,
      JSON.stringify(idle));
  }
});


// ── 实战轮盘：三族卷子走完整真实流（请求 → 回填 → 可提交）─────────────────
// 单特性场景各自验证"能不能"；轮盘验证"连起来跑" —— 与真实刷课同构：
// writeConfig 双侧注入 → 真实 _handleQuiz → mock 模型 → 回填 → 提交判定。
SCENARIOS.push({
  name: '实战轮盘 A：Cy 作业页完整真实流',
  path: '/exam-work',
  run: async function (ctx) {
    var before = ctx.mock.requests.length;
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      enableQuiz: true, enableCaptcha: false, enableDiscussion: false, autoNext: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);
    await ctx.client.evaluate('window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true');
    await ctx.client.evaluate('window._xxtApp._handleQuiz(null); true');
    var got = false;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (ctx.mock.requests.length > before) { got = true; break; }
      await sleep(300);
    }
    check('轮盘 A：真实流发出模型请求', got, '+' + (ctx.mock.requests.length - before));
    if (!got) return;
    var filled = await waitFor(ctx.client, 'document.getElementById("answer5001").value !== ""', 15000);
    check('轮盘 A：答案已回填（等待隐藏域被写入）', filled);
    var state = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var g=function(id){var e=document.getElementById(id);return e?String(e.value):null;};' +
      'var qs=a._extractQuestions(null);' +
      'return {a1:g("answer5001"),a2:g("answer5002"),a3:g("answer5003"),a4:g("answer5004"),' +
      'ready:!!a._quizReadyToSubmit,filledAll:!!a._areQuizAnswersFilled(null,qs,{requireThisRun:false})};})()'
    );
    check('轮盘 A：四题全部有值（文本/控件分离结构没有吞题），整卷判定可提交',
      !!state && state.a1 && state.a2 && state.a3 && state.a4 && state.filledAll === true && state.ready === true,
      JSON.stringify(state));
  }
});

SCENARIOS.push({
  name: '实战轮盘 B：mooc2 作业页完整真实流',
  path: '/mooc2-work',
  run: async function (ctx) {
    var before = ctx.mock.requests.length;
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      enableQuiz: true, enableCaptcha: false, enableDiscussion: false, autoNext: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);
    await ctx.client.evaluate('window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true');
    await ctx.client.evaluate('window._xxtApp._handleQuiz(null); true');
    var got = false;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (ctx.mock.requests.length > before) { got = true; break; }
      await sleep(300);
    }
    check('轮盘 B：mooc2 结构真实流发出模型请求', got, '+' + (ctx.mock.requests.length - before));
    if (!got) return;
    var filled = await waitFor(ctx.client, 'document.getElementById("answer6001").value !== ""', 15000);
    check('轮盘 B：答案已回填', filled);
    var state = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var g=function(id){var e=document.getElementById(id);return e?String(e.value):null;};' +
      'var qs=a._extractQuestions(null);' +
      'return {a1:g("answer6001"),a2:g("answer6002"),' +
      'ready:!!a._quizReadyToSubmit,filledAll:!!a._areQuizAnswersFilled(null,qs,{requireThisRun:false})};})()'
    );
    check('轮盘 B：两题全部有值、整卷判定可提交',
      !!state && state.a1 && state.a2 && state.filledAll === true && state.ready === true,
      JSON.stringify(state));
  }
});

SCENARIOS.push({
  name: '实战轮盘 C：PPT 带音频任务翻页器完整真实流',
  path: '/doc-ppt',
  run: async function (ctx) {
    // 音频等待与媒体启动在测试里接管（真实页面上等的是音频播完）；
    // 翻页器契约（swiper 官方按钮 → 禁用态收尾 → finishJob）是本场景的验证对象
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'a._waitSlideAudioDone = async function () { return true; };' +
      'a._startSlideMedia = function () {};' +
      'a._assertActive = function () { return true; };' +
      'return true;})()'
    );
    var result = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'var job = { win: window, doc: document, name: "轮盘PPT" };' +
      'return a._runPptAudioJob(job).then(function (ok) {' +
      '  return {ok: !!ok,' +
      '    visible: Array.prototype.map.call(document.querySelectorAll(".swiper-slide"),' +
      '      function (el) { return el.style.display !== "none"; }).filter(Boolean).length,' +
      '    finished: !!window.__pptFinished};});})()'
    );
    check('轮盘 C：翻页器逐页推进（4 页全部走过）',
      !!result && result.ok === true && result.visible === 4, JSON.stringify(result));
    check('轮盘 C：翻到末页后 finishJob 被调用（平台完成上报路径）',
      !!result && result.finished === true, JSON.stringify(result));

    // ---- 课件页的**类型**不变量 ----
    // 翻页器能跑，不代表这一页没被顺手判成测验：`_detectQuiz()` 一旦为真，
    // `_isQuizLearningPending()` 恒真 → `_tryAdvanceIdleSection` 的逃生门被冻住，
    // 而 `_handleQuiz` 又抠不出题 —— 整页既不刷课件也不翻页（2026-11-10「接近瘫痪」）。
    // ⚠️ pending=false 有两种来源：真的没测验 / 被别的早退分支挡住的。
    //    所以下面把每一条早退原因都取出来，**必须全是「没触发」**，这个 false 才算数。
    var idle = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,hasApiKey:true,randomAnswer:false});' +
      'app._quizApiFailUntil=0; app._quizForceSkipUntil=0; app._quizForceSkipPaperKey="";' +
      'app._quizInProgress=false; app._quizSubmitPending=false; app._quizAnswered=false;' +
      'var doc=app._resolveQuizSubmitDocument(null);' +
      'return {detect:app._detectQuiz(),pending:app._isQuizLearningPending(),' +
      '  apiReason:app._getQuizApiUnavailableReason(),skipping:app._isQuizForceSkipping(null),' +
      '  monitor:!!app._monitorQuizSubmit(null),passed:!!app._isQuizPassedOrFinished(doc),' +
      '  redo:!!app._isQuizRedoRequired(doc),submitForm:!!app._hasActiveQuizSubmitForm(doc)};})()'
    );
    check('课件页（真 swiper，无题面样式）`_detectQuiz()` 为 false',
      !!idle && idle.detect === false, JSON.stringify(idle));
    check('课件页 `_isQuizLearningPending()` 为 false，且不是靠其它早退分支蒙出来的',
      !!idle && idle.pending === false && idle.apiReason === '' && idle.skipping === false &&
      idle.monitor === false && idle.passed === false && idle.redo === false && idle.submitForm === false,
      JSON.stringify(idle));
  }
});

/**
 * ---- 任务类型仲裁：课件帧挂着题面样式类名，也必须走阅读链路 ----
 *
 * 用户报「刷 PPT 的功能也报废了」（2026-11-10）。根因不在翻页器，在**判类型**：
 * `.question-content` / `.answerOption` 这些通用类名在课件帧里同样出现，
 * 旧判据「`_quizDetectorSelector` 命中 = 测验」于是把 PPT 帧仲裁成 quiz，
 * `_runChaoxingReadJob` 一次都轮不到。
 *
 * ⚠️ 上面那个 `/doc-ppt` 场景直接调 `_runPptAudioJob`，**绕过了仲裁**抓不到这类回归；
 *    所以这里必须从 `_searchChaoxingJobOcs` / `_searchChaoxingJob` 的**产出**断言。
 */
SCENARIOS.push({
  name: '任务类型仲裁：课件帧带题面样式类名仍走阅读链路',
  path: '/ppt-decoy',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      hasApiKey: true, enableQuiz: true, enablePPT: true,
      randomAnswer: false, autoNext: false, restudy: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(500);

    var first = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizApiFailUntil=0; app._quizForceSkipUntil=0; app._quizForceSkipPaperKey="";' +
      'app._quizInProgress=false; app._quizInProgressAt=0; app._quizSubmitPending=false;' +
      'app._quizAnswered=false; app._quizRunPaperKey=""; app._quizCurrentQuestions=null;' +
      'app._isTaskGivenUp=function(){return false;};' +
      // 两条链路各挂一个探针：谁被调用了、带的是什么 kind，一目了然
      //（真实翻页/答题流程由各自的场景覆盖，这里只验**路由**）
      'window.__spy={read:[],quiz:0};' +
      'app._runChaoxingReadJob=function(job){window.__spy.read.push(String(job.kind)+"#"+String(job.jobid));return Promise.resolve(true);};' +
      'app._handleQuiz=function(){window.__spy.quiz++;return Promise.resolve(true);};' +
      'var inner=null;' +
      'try{inner=app._getMainDocument().querySelector("#tp-ppt iframe").contentDocument;}catch(e){inner=null;}' +
      'var out={apiReason:app._getQuizApiUnavailableReason(),hasInner:!!inner};' +
      'if(inner){' +
      '  out.oldProbe=inner.querySelectorAll(app._quizDetectorSelector).length;' +
      '  out.containers=app._collectQuestionContainers(inner).length;' +
      '  out.controlAnywhere=!!inner.querySelector(app._quizAnswerControlSelector);' +
      '  out.hasQuizNow=app._documentHasQuiz(inner);' +
      '}' +
      'var j=app._searchChaoxingJobOcs([]);' +
      'out.matched=j?{kind:String(j.kind),jobid:String(j.jobid),workType:String(j.workType),hasFunc:typeof j.func==="function"}:null;' +
      'if(j&&typeof j.func==="function"){await j.func();}' +
      'out.spyRead=window.__spy.read.slice(); out.spyQuiz=window.__spy.quiz;' +
      'var j2=app._searchChaoxingJob([]);' +
      'out.matched2=j2?{kind:String(j2.kind),jobid:String(j2.jobid)}:null;' +
      'return out;})()'
    );

    check('仲裁夹具：答题 API 可用（否则测验分支会被退避守卫跳过，反证测不到）',
      !!first && first.apiReason === '', JSON.stringify(first && first.apiReason));
    check('仲裁夹具自证：这一帧在**旧判据**下一定像题（两样题面样式类名都在）',
      !!first && first.hasInner === true && first.oldProbe >= 2 && first.containers >= 1,
      JSON.stringify(first));
    check('新判据认不出题：文档级有作答控件，但它不在题目容器里',
      !!first && first.controlAnywhere === true && first.hasQuizNow === false,
      JSON.stringify(first));

    var matched = first && first.matched;
    check('OCS 搜出来的任务是 ppt-audio 而不是 quiz',
      !!matched && matched.kind === 'ppt-audio' && matched.jobid === 'ppt-9002' && matched.hasFunc === true,
      JSON.stringify(matched));
    check('执行它走的是阅读链路，kind 一路带到 `_runChaoxingReadJob`',
      !!first && first.spyRead.length === 1 && first.spyRead[0] === 'ppt-audio#ppt-9002',
      JSON.stringify(first && first.spyRead));
    check('整条链路一次都没进 `_handleQuiz`（答题不再压过课件）',
      !!first && first.spyQuiz === 0, JSON.stringify(first && first.spyQuiz));
    check('另一条搜索入口 `_searchChaoxingJob` 也仲裁成 ppt-audio（两份顺序已经并成一份）',
      !!first && !!first.matched2 && first.matched2.kind === 'ppt-audio' && first.matched2.jobid === 'ppt-9002',
      JSON.stringify(first && first.matched2));

    // ---- 反证优先级 ①：跨家族时附件说了算 ----
    // 附件改口说「这是一份卷子」，DOM 依旧只有 swiper。
    // 卷子常常渲染在本帧抠不到题的那一层（三层嵌套的 jobid 场景就是这么修的），
    // 所以这种时候**必须**听附件的 —— 否则测验会被课件样式类名挤掉，是反向的事故。
    var cross = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'window.__spy.read.length=0; window.__spy.quiz=0;' +
      'window.attachments=[{jobid:"ppt-9002",property:{_jobid:"ppt-9002",jobid:"ppt-9002",' +
      'mid:"mid-ppt-9002",name:"轮盘课件",module:"work",type:"work",job:true}}];' +
      'var j=app._searchChaoxingJobOcs([]);' +
      'var out={kind:j?String(j.kind):null,hasFunc:!!j&&typeof j.func==="function"};' +
      'if(j&&typeof j.func==="function"){await j.func();}' +
      'out.quiz=window.__spy.quiz; out.read=window.__spy.read.slice();' +
      'return out;})()'
    );
    check('反证优先级：附件声明 work、DOM 只有 swiper ⇒ kind 必须是 quiz',
      !!cross && cross.kind === 'quiz' && cross.hasFunc === true, JSON.stringify(cross));
    check('反证优先级：路由也跟着走 `_handleQuiz`，阅读链路零调用',
      !!cross && cross.quiz === 1 && cross.read.length === 0, JSON.stringify(cross));

    // ---- 夹具页（带题面样式类名的课件）也必须不被判成测验 ----
    var idle = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'window.attachments=[{jobid:"ppt-9002",property:{_jobid:"ppt-9002",jobid:"ppt-9002",' +
      'mid:"mid-ppt-9002",name:"轮盘课件",module:"ppt",type:"ppt",job:true}}];' +
      'app._quizApiFailUntil=0; app._quizForceSkipUntil=0; app._quizForceSkipPaperKey="";' +
      'app._quizInProgress=false; app._quizSubmitPending=false; app._quizAnswered=false;' +
      'var doc=app._resolveQuizSubmitDocument(null);' +
      'var mainDoc=app._getMainDocument();' +
      'return {detect:app._detectQuiz(),pending:app._isQuizLearningPending(),' +
      '  apiReason:app._getQuizApiUnavailableReason(),skipping:app._isQuizForceSkipping(null),' +
      '  monitor:!!app._monitorQuizSubmit(null),passed:!!app._isQuizPassedOrFinished(doc),' +
      '  redo:!!app._isQuizRedoRequired(doc),submitForm:!!app._hasActiveQuizSubmitForm(doc),' +
      '  cardOld:!!(mainDoc&&mainDoc.querySelector(app._quizDetectorSelector)),' +
      '  cardQuiz:app._documentHasQuiz(mainDoc),docTask:!!app._locateDocumentTask(),' +
      '  textOnly:app._isTextOnly()};})()'
    );
    check('挂着题面样式类名的课件页 `_detectQuiz()` 必须为 false（旧实现恒为 true）',
      !!idle && idle.detect === false, JSON.stringify(idle));
    check('挂着题面样式类名的课件页 `_isQuizLearningPending()` 为 false，且不是靠早退分支蒙出来的',
      !!idle && idle.pending === false && idle.apiReason === '' && idle.skipping === false &&
      idle.monitor === false && idle.passed === false && idle.redo === false && idle.submitForm === false,
      JSON.stringify(idle));

    // `_isTextOnly()`（视觉预算 + 「本页没任务就跳过」的开关）读的是**主文档 = 卡片层**，
    // 那里同样挂着 `.question-content` 装饰：旧判据会在这里判成「页面上有题」→ 不是纯文本页
    // → 既白烧视觉预算，也让跳过分支永远不成立。前置条件一并断言，防止"因为早退而蒙对"。
    check('挂着题面样式类名的课件页 `_isTextOnly()` 仍为 true（卡片层像题、抠不出题）',
      !!idle && idle.cardOld === true && idle.cardQuiz === false && idle.docTask === false &&
      idle.textOnly === true, JSON.stringify(idle));
  }
});

/**
 * ---- 任务类型仲裁：判定顺序逐条钉住 ----
 *
 * 为什么要单独钉这一条：仲裁顺序以前散在**三处**手抄的 || 链里（OCS 路由、
 * `_searchChaoxingJob`、`_buildSyntheticChaoxingJob`），三份彼此已经不一致 ——
 * 光测端到端会"碰巧绿"，改一处坏一处却看不出来。现在顺序只剩
 * `_kindFromChaoxingElements` 一份，这里把每一对相邻优先级钉死，
 * 谁再在调用点抄一份，这条就会红。
 */
SCENARIOS.push({
  name: '任务类型仲裁：kind 判定顺序逐条钉住',
  path: '/quiz',
  run: async function (ctx) {
    var pins = await ctx.client.evaluate(
      '(function(){' +
      'var app=window._xxtApp;' +
      // 探测包里只填「这一族在不在」，值本身没有含义 —— 仲裁看形状，不看元素
      'var rows=[' +
      '  {n:"视频压过一切",e:{videojs:{},quiz:{},read:{},pptWithAudio:{},documentJob:{}},w:"video"},' +
      '  {n:"测验压过阅读",e:{quiz:{},read:{},pptWithAudio:{}},w:"quiz"},' +
      '  {n:"图片阅读压过轮盘",e:{read:{},pptWithAudio:{},timereader:{}},w:"read"},' +
      '  {n:"轮盘压过计时阅读",e:{pptWithAudio:{},timereader:{},pagedDoc:{}},w:"ppt-audio"},' +
      '  {n:"计时阅读压过超链接",e:{timereader:{},hyperlink:{},documentJob:{}},w:"timereader"},' +
      '  {n:"超链接压过兜底文档",e:{hyperlink:{},documentJob:{},pagedDoc:{}},w:"hyperlink"},' +
      '  {n:"文档是兜底",e:{documentJob:{}},w:"document"},' +
      '  {n:"什么信号都没有时必须返回空串",e:{},w:""},' +
      // read 家族：附件只说得出「一个文档」，具体 flavour 归 DOM；跨家族仍以附件为准
      '  {n:"附件说 read 家族 + DOM 是轮盘 ⇒ 轮盘",e:{pptWithAudio:{}},a:{property:{module:"ppt",type:"ppt"}},w:"ppt-audio"},' +
      '  {n:"附件说 work + DOM 是轮盘 ⇒ 测验",e:{pptWithAudio:{}},a:{property:{module:"work",type:"work"}},w:"quiz"},' +
      '  {n:"附件说视频 + DOM 是图片阅读 ⇒ 视频",e:{read:{}},a:{property:{module:"insertvideo"}},w:"video"},' +
      '  {n:"附件说文档 + DOM 抠得出题 ⇒ 测验",e:{quiz:{}},a:{property:{module:"insertdoc"}},w:"quiz"}' +
      '];' +
      'var bad=[];' +
      'rows.forEach(function(r){' +
      '  var got=app._kindFromChaoxingElements(r.e||null,r.a||null,null);' +
      '  if(got!==r.w) bad.push(r.n+"：期望「"+r.w+"」实得「"+got+"」");' +
      '});' +
      'var attBad=[];' +
      '[[{module:"insertdoc"},"read"],[{module:"insertvideo"},"video"],[{module:"work"},"quiz"],' +
      ' [{module:"insertimage"},"read"],[{module:"unknown",type:"xyz"},""],' +
      ' [{module:"book",type:".pdf"},"read"]].forEach(function(p){' +
      '  var got=app._kindFromAttachment({property:p[0]});' +
      '  if(got!==p[1]) attBad.push(p[0].module+"→「"+got+"」期望「"+p[1]+"」");' +
      '});' +
      'return {rows:rows.length,bad:bad,attBad:attBad,' +
      '  byDoc:app._kindFromChaoxingElements(null,null,document),' +
      '  hasQuiz:app._documentHasQuiz(document)};})()'
    );
    // ⚠️ 拆成两条：`rows === 12` 数的是**这张表自己写了几行**（夹具里的字面量），
    //    和生产有没有算错无关 —— 它只保证"有人删行 = 少测一族"会被看见。
    //    行为判定是 `bad.length === 0` 那一条，两者不许再挤在同一句名字里。
    check('夹具自证：优先级表确实摊开了 12 行（有人删行就等于下面那条少测一族）',
      !!pins && pins.rows === 12, JSON.stringify(pins && pins.rows));
    check('相邻优先级全部按唯一那份顺序走（有人再手抄 || 链就会在这里红）',
      !!pins && pins.bad.length === 0, JSON.stringify(pins && pins.bad));
    check('附件映射也只此一份（_kindFromAttachment 的六个口径）',
      !!pins && pins.attBad.length === 0, JSON.stringify(pins && pins.attBad));
    check('没有探测包时按文档现算，用的是同一个判据（真题页 ⇒ quiz）',
      !!pins && pins.hasQuiz === true && pins.byDoc === 'quiz', JSON.stringify(pins));
  }
});

/**
 * ---- 批次 3：卷子身份键的**粒度**（2026-11-10）----
 *
 * `_getQuizWorkKey` 主路径读五个 id 字段；全空时过去写的是
 * `location.href + '|' + 章节 id` —— 顶层地址对同一张卡片里的两份卷子**是同一个值**，
 * 于是批次 1 拆掉的「按页冷却」在兜底分支里悄悄活着：一份坏卷子的 90 秒暂停
 * 会连累它的邻居，两份卷子的提交次数与答案缓存也互相顶掉。
 *
 * 夹具形状：两个 `about:blank` 帧（URL 完全相同，故意把「按 URL 分开」这一半排除掉），
 * 各自带一个 jobid 属性 —— 只有「宿主帧的身份」那一半能把它们分开。
 * 另外再造两个**连 jobid 都没有**的帧，验最后一层序号兜底。
 *
 * ⚠️ 键的**稳定性**和粒度同等重要：同一个文档两次算出不同的键，
 *   表现不是"多暂停一份"而是冷却形同不存在、交卷上限每轮被重置
 *   （比合并更烧用户的提交次数），所以这里也钉一条。
 */
SCENARIOS.push({
  name: '卷子身份键的粒度：认不出 id 字段的页面也按帧分开，且键稳定',
  path: '/quiz',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){' +
      'var a=window._xxtApp;' +
      'function mk(jobid){var f=document.createElement("iframe");f.style.display="none";' +
      'if(jobid){f.setAttribute("jobid",jobid);}f.src="about:blank";' +
      'document.body.appendChild(f);return f;}' +
      'var fa=mk("k-probe-A"),fb=mk("k-probe-B"),fc=mk(""),fd=mk("");' +
      'var da=fa.contentDocument,db=fb.contentDocument,dc=fc.contentDocument,dd=fd.contentDocument;' +
      // 夹具自证：这一批帧的五个 id 字段真的全空、URL 真的相同 ——
      // 否则测的是主路径，兜底分支根本没被走到
      'var out={urlA:String(da.URL),urlB:String(db.URL),' +
      '  fields:[da.getElementById("courseId"),da.getElementById("classId"),' +
      '    da.getElementById("workRelationId"),da.getElementById("jobid"),' +
      '    da.getElementById("knowledgeid")].filter(Boolean).length};' +
      'out.kA=a._getQuizWorkKey(da);out.kB=a._getQuizWorkKey(db);' +
      'out.stable=(a._getQuizWorkKey(da)===out.kA)&&a._getQuizWorkKey(da)===a._getQuizWorkKey(da);' +
      'out.kC=a._getQuizWorkKey(dc);out.kD=a._getQuizWorkKey(dd);' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'a._setQuizForceSkip(90000,out.kA);' +
      'out.pauseA=a._isQuizForceSkipping(da);out.pauseB=a._isQuizForceSkipping(db);' +
      'out.windowLive=a._isQuizSkipWindowLive();' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      '[fa,fb,fc,fd].forEach(function(f){f.parentNode.removeChild(f);});' +
      'return out;})()'
    );
    check('夹具自证：两个帧的 URL 同为 about:blank，且五个 id 字段一个都读不到（真走兜底分支）',
      !!probe && probe.urlA === 'about:blank' && probe.urlB === 'about:blank' && probe.fields === 0,
      JSON.stringify(probe));
    check('兜底键按帧分开：同一页两份卷子不再被记成同一份（否则坏一份冻住邻居）',
      !!probe && !!probe.kA && !!probe.kB && probe.kA !== probe.kB,
      JSON.stringify(probe && { kA: probe.kA, kB: probe.kB }));
    check('键稳定：同一个文档两次算出的键必须一致（键漂移 = 冷却失效 + 交卷上限被重置）',
      !!probe && probe.stable === true, JSON.stringify(probe && probe.stable));
    check('按 A 写冷却 ⇒ 判 A 为暂停、判 B 为不暂停，但「能不能离开这一节」仍看窗口（不比键）',
      !!probe && probe.pauseA === true && probe.pauseB === false && probe.windowLive === true,
      JSON.stringify(probe && { pauseA: probe.pauseA, pauseB: probe.pauseB, windowLive: probe.windowLive }));
    check('最后一层兜底：帧上连 jobid 都没有时，序号也能把两份卷子分开',
      !!probe && !!probe.kC && !!probe.kD && probe.kC !== probe.kD,
      JSON.stringify(probe && { kC: probe.kC, kD: probe.kD }));
  }
});

/** ---- 批次 4：一份卷子交完 ≠ 整节交完；同页第二份卷子要接得上 ----
 * 现场（2026-11-10 真实日志，导出时用户的话是「第一次遇到题目过了，第二次遇到题目不答题了」）：
 *   19:12:16 第一份卷子 5 题全填上 → 19:12:17 `quiz submit finished`
 *   → **1 秒后** `skip completed` + 点「下一节」→ 此后再没有任何答题记录。
 * `_isCurrentCompleted()` 当时把**页面级**的文案「任务点已完成」排在逐任务帧的完成状态
 * 之前，而一张卡片里挂两份测验时，刚交完的那一份就会把这句话渲染出来。
 * 另一半：`_handleQuiz` 开头三个「这一轮不答题」的原因共用一个**静默**出口，
 * 日志里一个字都没有 —— 现场只能靠猜。
 */
SCENARIOS.push({
  name: '一份卷子交完不判整节完成，同页第二份卷子按题目身份接手',
  path: '/two-quizzes-divjob',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var a=window._xxtApp;' +
      'var out={};' +
      // ---- ① 整节完成判定 ----
      'var tasks=a._collectVisibleTaskFrames();' +
      'out.frames=tasks.length;' +
      // 现场形状由本场景自己搭：刚交完的那一份任务点被平台标成完成，另一份没有
      'if(tasks[0]&&tasks[0].wrap)tasks[0].wrap.classList.add("ans-job-finished");' +
      'out.finished=a._collectVisibleTaskFrames().map(function(t){return !!t.finished;});' +
      'var mainDoc=a._getMainDocument();' +
      'out.baseline=a._isCurrentCompleted();' +
      // 模拟平台：刚交完的那一份把「任务点已完成」渲染进主文档
      'var marker=document.createElement("div");marker.id="om-marker";marker.textContent="任务点已完成";' +
      'mainDoc.body.appendChild(marker);' +
      'out.hasMarkerText=/任务点已完成/.test(String(mainDoc.body.innerText||""));' +
      'out.stateWithMarker=a._getVisibleTaskCompletionState();' +
      'out.withMarker=a._isCurrentCompleted();out.evWithMarker=a._completionEvidence;' +
      // 对照一：两份都标完成 + 文案在场 → 文案那条出口必须仍然能用（不许把门堵死）
      'tasks.forEach(function(t){if(t.wrap)t.wrap.classList.add("ans-job-finished");});' +
      'out.bothFinished=a._isCurrentCompleted();out.evBoth=a._completionEvidence;' +
      // 对照二：文案删掉、两份都完成 → 由逐任务帧证据判完成
      'mainDoc.body.removeChild(marker);' +
      'out.noTextBoth=a._isCurrentCompleted();out.evNoTextBoth=a._completionEvidence;' +
      'tasks.forEach(function(t){if(t.wrap)t.wrap.classList.remove("ans-job-finished");});' +
      // ---- ② 题目身份：换没换卷子 ----
      'function mkDoc(ids){var f=document.createElement("iframe");f.style.display="none";' +
      'document.body.appendChild(f);var d=f.contentDocument;' +
      'd.body.innerHTML="";' +
      'ids.forEach(function(id){var w=d.createElement("div");w.className="TiMu";' +
      'if(id!=null)w.setAttribute("qid",String(id));' +
      'var t=d.createElement("div");t.className="Zy_TItle clearfix";' +
      't.textContent="【单选题】题目"+id;w.appendChild(t);' +
      'var u=d.createElement("ul");u.className="Zy_ulTop";var li=d.createElement("li");' +
      'var l=d.createElement("a");l.textContent="A. 甲";li.appendChild(l);u.appendChild(li);w.appendChild(u);' +
      'var r=d.createElement("input");r.type="radio";r.name="answer"+id;r.value="A";w.appendChild(r);' +
      'd.body.appendChild(w);});' +
      'return {f:f,d:d};}' +
      'var A=mkDoc([9001,9002]),B=mkDoc([9101,9102]),C=mkDoc([null,null]),D=mkDoc([9001,9101]);' +
      'var qa=a._extractQuestions(A.d);' +
      'out.qCountA=qa.length;' +
      'out.idsA=qa.map(function(q){return String(a._getQuestionIdFromElement(q._element)||"");});' +
      'a._quizCurrentQuestions=qa;a._quizAnswered=true;' +
      'out.changedB=a._isQuizPaperChangedInDom(B.d);' +
      'out.sameA=a._isQuizPaperChangedInDom(A.d);' +
      'out.overlapD=a._isQuizPaperChangedInDom(D.d);' +
      'out.noIdC=a._isQuizPaperChangedInDom(C.d);' +
      // ---- ③ 三个「这一轮不答题」的出口都要留日志 ----
      'var logs=[];' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      'if(m&&m.source==="xxt_app"&&m.type==="runtime_log")logs.push(m);});' +
      'function pick(name){var hit=null;logs.forEach(function(m){if(m.message===name)hit=m;});return hit;}' +
      'var cfg=a.configs;var savedKey=cfg.hasApiKey;var savedNext=cfg.autoNext;' +
      'a._quizAnswered=false;a._quizInProgress=false;a._quizSubmitPending=false;' +
      // ③-1 冷却窗口内
      'a._setQuizForceSkip(15000,String(a._getQuizWorkKey(D.d)||""));' +
      'a._quizHoldReasonLogAt=0;' +
      'Promise.resolve(a._handleQuiz(D.d)).then(function(){' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      // ③-2 自认已答完、页面上题目与记着的那份有交集
      'a._quizAnswered=true;a._quizCurrentQuestions=qa;a._quizHoldReasonLogAt=0;' +
      'return Promise.resolve(a._handleQuiz(D.d));' +
      '}).then(function(){' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      // ③-3 自认已答完、页面上是一批完全不认识的题 → 认成换卷并留日志
      //   （下游用 hasApiKey=false 掐住，绝不真调模型；autoNext=false 防翻页）
      'a._quizAnswered=true;a._quizCurrentQuestions=qa;a._quizHoldReasonLogAt=0;' +
      'cfg.hasApiKey=false;cfg.autoNext=false;' +
      'return Promise.resolve(a._handleQuiz(B.d)).then(function(){' +
      'cfg.hasApiKey=savedKey;cfg.autoNext=savedNext;' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'a._quizAnswered=false;a._quizCurrentQuestions=null;a._quizSubmitPending=false;' +
      'a._quizInProgress=false;' +
      '[A,B,C,D].forEach(function(x){if(x.f.parentNode)x.f.parentNode.removeChild(x.f);});' +
      'setTimeout(function(){out.hold=pick("quiz held: nothing answered this round");' +
      'out.switched=pick("quiz paper switched by question identity");res(out);},150);' +
      '});' +
      '}).catch(function(err){cfg.hasApiKey=savedKey;cfg.autoNext=savedNext;res({error:String(err&&err.message||err)});});' +
      '});})()'
    );

    check('夹具自证：这一页真的有两个可见任务帧，一个判完成、一个没判（否则测的不是两份卷子的形状）',
      !!probe && probe.frames === 2 && JSON.stringify(probe.finished) === JSON.stringify([true, false]),
      JSON.stringify(probe && { frames: probe.frames, finished: probe.finished }));

    check('夹具自证：「任务点已完成」这句文案确实出现在主文档里（否则测的是别的分支）',
      !!probe && probe.hasMarkerText === true && !!probe.stateWithMarker &&
      probe.stateWithMarker.hasTasks === true && probe.stateWithMarker.allFinished === false,
      JSON.stringify(probe && { hasMarkerText: probe.hasMarkerText, state: probe.stateWithMarker }));

    check('交完一份不能判整节完成：还有未完成任务帧时，那句文案不再说了算',
      !!probe && probe.withMarker === false && probe.evWithMarker === '',
      JSON.stringify(probe && { withMarker: probe.withMarker, ev: probe.evWithMarker }));

    check('对照：两份任务点都完成 + 文案在场 → 仍判完成，且证据是文案那条出口（门没被堵死）',
      !!probe && probe.bothFinished === true && probe.evBoth === 'text-marker',
      JSON.stringify(probe && { bothFinished: probe.bothFinished, evBoth: probe.evBoth }));

    check('对照：没有文案、两份任务点都完成 → 仍判完成，证据换成逐任务帧',
      !!probe && probe.noTextBoth === true && probe.evNoTextBoth === 'all-tasks-finished',
      JSON.stringify(probe && { noTextBoth: probe.noTextBoth, evNoTextBoth: probe.evNoTextBoth }));

    check('夹具自证：A 那份的 2 道题都取得到题目身份 qid（身份取不到时下面几条全是假绿）',
      !!probe && probe.qCountA === 2 && JSON.stringify(probe.idsA) === JSON.stringify(['9001', '9002']),
      JSON.stringify(probe && { qCountA: probe.qCountA, idsA: probe.idsA }));

    check('换卷识别：页面上是一批完全不重叠的题 → 认成「换了一份卷子」',
      !!probe && probe.changedB === true, JSON.stringify(probe && probe.changedB));

    check('不换卷：还是刚才那批题 → 绝不重置（重置=同一份卷子再交一次）',
      !!probe && probe.sameA === false, JSON.stringify(probe && probe.sameA));

    check('不换卷：新旧题混着（有任何交集）→ 保守判不换卷',
      !!probe && probe.overlapD === false, JSON.stringify(probe && probe.overlapD));

    check('不换卷：页面根本认不出题目身份 → 不动状态（宁可沿用旧状态，也不重答一遍）',
      !!probe && probe.noIdC === false, JSON.stringify(probe && probe.noIdC));

    var held = probe && probe.hold;
    check('「这一轮没答题」不再是静默出口：能说出是哪个原因（冷却 / 已答 / 上一轮未完）',
      !!held && held.level === 'warn' &&
      (held.meta && held.meta.reason === 'answered' || held.meta && held.meta.reason === 'force-skip'),
      JSON.stringify(held && held.meta).slice(0, 200));

    var switched = probe && probe.switched;
    check('按题目身份换了卷子要留日志（这是第二份卷子唯一能被认出来的时刻）',
      !!switched && !!switched.meta && !!switched.meta.hint,
      JSON.stringify(switched && switched.meta).slice(0, 200));
  }
});

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

    // ---- R2a/R3 嵌套帧回归（2026-11-10「所有题目都被跳过」）----
    // 这一族的题在 `#frame_content` **内层文档**里，而调用方传进来的 preferredDoc 是外层。
    //   · content.js 的 `data-om-font-miss` 写在它解密的那一个文档上（=内层）——
    //     乱码探测若跟着 preferredDoc 走，就永远看不见它，整条守卫静默失效；
    //   · 按卷冷却的键若写入端与判定端各算各的（`_getQuizWorkKey(题目文档)` vs
    //     `_getQuizWorkKey(null)` 解析出的可能不是同一个 doc），90 秒暂停形同不存在。
    var nested = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'var qs=a._extractQuestions(document);' +
      'var owner=a._getQuizDocumentFromQuestions(qs);' +
      'var out={n:qs.length,ownerIsInner:!!owner&&owner!==document};' +
      'if(!out.ownerIsInner)return out;' +
      'owner.documentElement.setAttribute("data-om-font-miss","1");' +
      'out.globalMiss=a._hasFontDecryptMiss();' +
      'out.outerMiss=a._hasFontDecryptMiss(document);' +
      'out.ownerMiss=a._hasFontDecryptMiss(owner);' +
      'a.configs=Object.assign({},a.configs,{enableQuiz:true,hasApiKey:true,randomAnswer:false});' +
      'a._quizApiFailUntil=0;a._quizAnswered=false;a._quizInProgress=false;' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'a._quizGarbledRounds=0;a._quizGarbledRoundAt=0;a._quizGarbledPaperKey="";' +
      'a._quizCurrentQuestions=null;a._fontSecretWaitSince=0;' +
      'a._handleQuiz(document);' +
      'out.rounds=a._quizGarbledRounds;out.inProgress=a._quizInProgress;' +
      // 顶到第 3 轮，让**生产代码**自己写按卷冷却，再验判定端认不认这个键。
      // HIGH-1：判定端必须拿**同一个文档**去算键（`_isQuizForceSkipping(doc)`）。
      // 原来它无参调用 `_getQuizWorkKey(null)`，解析出来的是另一个文档的身份，
      // 于是「暂停 90 秒」写在 A 键、问的是 B 键 —— 表现为**永久停摆**而不是"没暂停"：
      // R1 关掉了跳过出口、R2 删了 `_skipQuiz()`，`_tryAdvanceIdleSection` 又被
      // `_isQuizLearningPending` 挡住，日志却写着已经暂停。
      'a._quizGarbledRounds=2;a._quizGarbledRoundAt=Date.now()-11000;a._handleQuiz(document);' +
      'out.cooldown=a._quizForceSkipUntil>Date.now();' +
      'out.pauseKey=String(a._quizForceSkipPaperKey||"");' +
      'out.readerKey=String(a._getQuizWorkKey(document));' +
      'out.pauseApplies=a._isQuizForceSkipping(document);' +
      'return out;})()'
    );
    check('R2a 嵌套帧前置：题在 #frame_content 内层，与外层 preferredDoc 不是同一个文档',
      !!nested && nested.n === 4 && nested.ownerIsInner === true, JSON.stringify(nested));
    check('R2a 内层才有解密标记时，外层单独探测必然看不见（守卫必须跟着题目走）',
      !!nested && nested.outerMiss === false && nested.ownerMiss === true && nested.globalMiss === true,
      JSON.stringify(nested));
    check('R2a 标记在内层时 _handleQuiz(外层) 仍数进乱码轮次、且不岔住 _quizInProgress',
      !!nested && nested.rounds === 1 && nested.inProgress === false, JSON.stringify(nested));
    check('R3+HIGH-1 嵌套帧页面：第 3 轮写的是按卷冷却，且写入端的键就是判定端在同一文档上算出的那一个',
      !!nested && nested.cooldown === true && nested.pauseKey === nested.readerKey &&
      nested.pauseApplies === true, JSON.stringify(nested));

    // ---- HIGH-1 的行为层证据 + HIGH-2 的反向用例（都必须是真调用，不许探内部状态）----
    // 冷却还在窗口内时再调 `_handleQuiz(外层)`：必须**停在第一行** ——
    // 乱码轮次不再累加（说明压根没重新走守卫），也不会把 `_quizInProgress` 岔住。
    // 读写两侧的键一旦错开，这里会看到 rounds=1（"日志说暂停了、其实一秒都没停"）。
    var paused = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var out={};' +
      'out.stillHot=a._quizForceSkipUntil>Date.now();' +
      'a._handleQuiz(document);a._handleQuiz(document);' +
      'out.rounds=a._quizGarbledRounds;out.inProgress=a._quizInProgress;' +
      // 反向（HIGH-2）：标记只挂在一个**既不出题也不包题**的装饰帧上 → 不得判乱码。
      // 同时留证据：标记确实挂在页面上（decorMiss/globalMiss 都为真），
      // 所以"不算乱码"是因为探测范围对了，不是因为标记没写上去。
      'var owner=a._getQuizDocumentFromQuestions(a._quizCurrentQuestions);' +
      'if(owner)owner.documentElement.removeAttribute("data-om-font-miss");' +
      'var fr=document.createElement("iframe");fr.style.display="none";document.body.appendChild(fr);' +
      'var fd=fr.contentDocument;fd.documentElement.setAttribute("data-om-font-miss","1");' +
      'out.decorMiss=a._hasFontDecryptMiss(fd);out.globalMiss=a._hasFontDecryptMiss();' +
      'a._quizGarbledRounds=0;a._quizGarbledRoundAt=0;a._quizGarbledPaperKey="";' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";a._quizInProgress=false;' +
      // 反向这一步的题是干净的 → 守卫放行后流程会继续走向问模型。
      // 地址必须钉在本地 mock 上：回归测试不许去打真实服务商接口（花钱且不可复现）。
      'a.configs=Object.assign({},a.configs,{apiUrl:"http://127.0.0.1:' + PORT + '",apiKey:"e2e-key"});' +
      'a._handleQuiz(document);' +
      'out.roundsDecor=a._quizGarbledRounds;out.skipDecor=a._quizForceSkipUntil>Date.now();' +
      'var docs=a._getQuizDocumentsFromQuestions(a._extractQuestions(document));' +
      'out.probeCount=docs.length;' +
      'out.probeMissAny=docs.some(function(d){return a._hasFontDecryptMiss(d);});' +
      'fr.parentNode.removeChild(fr);' +
      'a._quizGarbledRounds=0;a._quizGarbledRoundAt=0;a._quizGarbledPaperKey="";' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'a._quizInProgress=false;a._quizCurrentQuestions=null;a._fontSecretWaitSince=0;' +
      'return out;})()'
    );
    check('HIGH-1 嵌套帧：暂停窗口内再调 _handleQuiz 停在第一行（乱码轮次不累加、没岔住 inProgress）',
      !!paused && paused.stillHot === true && paused.rounds === 0 && paused.inProgress === false,
      JSON.stringify(paused));
    check('HIGH-2 反向：标记只挂装饰帧（既不出题也不包题）时不得判乱码，且标记确实还在页面上',
      !!paused && paused.decorMiss === true && paused.globalMiss === true &&
      paused.roundsDecor === 0 && paused.skipDecor === false &&
      paused.probeCount >= 1 && paused.probeMissAny === false, JSON.stringify(paused));
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

    // 诊断里的容器计数必须能数到 `.Cy_TItle`。
    // 这一处曾经写成 `.Cy_TITle`（大小写错），而 **CSS 类名大小写敏感** ——
    // 于是 containers 在这类页面上恒为 0，且不报错、不留日志。
    // 后果不轻：`_describeQuizResultPage` 的输出就是「提交后认不出结果页 → 25 秒超时」
    // 那条日志的全部内容，而它唯一的用途是告诉人**缺的是哪一道条件**
    //（这个函数的注释原话："于是 25 秒超时之后只能靠猜"）。
    // 数成 0 会让人以为"页面上没有题目容器"，直接往错的方向查。
    //
    // 断言落在 `containers > 0`：只要选择器写错大小写，这里必然是 0。
    // （对照：`/quiz` 那套 mock 用的是 `.TiMu`，所以那条路径察觉不到这个笔误 ——
    //  必须在**只用 `.Cy_TItle` 的作业/考试页**上断言才有意义。）
    var diagCy = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var d=app._describeQuizResultPage(null);' +
      'return {containers:d.containers,controls:d.controls,doc:d.doc||null,err:d.err||null};})()'
    );
    check('作业页诊断能数到 .Cy_TItle 容器（大小写写错会数成 0）',
      diagCy && diagCy.containers > 0, JSON.stringify(diagCy));
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

/** ---- 1.5 字体密文两层守卫：未解密时等、解不开时判乱码 ---- */
/**
 * 学习通的反爬（font-cxsecret）：文字被换成自定义字形的 PUA 密文字符。
 * content.js 的解密扫描是异步的，与 page.js 的抽题之间存在竞态；而映射表
 * （resources/table.json）落后于平台字符集时，部分字符会**永久**保持密文。
 *
 * 两层守卫（都断言**行为**，不查内部状态）：
 *   第一层 `_probeFontDecrypt().secret` —— 类名还在 → `_handleQuiz` 等一轮，不发请求；
 *   第二层 `_quizTextGarbledRatio` / `garbled` 标记 —— 密文已混进题干（类名被摘掉
 *   也检测得到）→ 连续 3 轮后放弃该卷，绝不把乱码发给模型白烧 token。
 *
 * 这里测的是两个守卫的判据本身；完整 tick 流程（等 8 秒、三轮放弃）在真实
 * 课程页上代价太高，由判据正确性 + `_handleQuiz` 的插入位置共同保证。
 */
SCENARIOS.push({
  name: '字体密文两层守卫：未解密时等、解不开时判乱码',
  path: '/exam-work',
  run: async function (ctx) {
    var app = 'window._xxtApp';

    // ① 比率函数：正常文字 0、纯密文接近 1、空串 0
    var ratio = await ctx.client.evaluate(
      '(function(){var a=' + app + ';' +
      'var pua="";for(var i=0;i<10;i++)pua+=String.fromCharCode(0xE000+i);' +
      'return {clean:a._quizTextGarbledRatio("数据库的主键是唯一标识abc123"),' +
      'allPua:a._quizTextGarbledRatio(pua+"x"),' +
      'empty:a._quizTextGarbledRatio("")};})()'
    );
    check('乱码比率：正常文字为 0、密文 >0.9、空串为 0',
      !!ratio && ratio.clean === 0 && ratio.allPua > 0.9 && ratio.empty === 0,
      JSON.stringify(ratio));

    // ② 第一层：.font-cxsecret 在场 → 判「未解密」；摘掉 → 判「已解密」
    var secret = await ctx.client.evaluate(
      '(function(){var a=' + app + ';' +
      'var d=document.createElement("div");d.className="font-cxsecret";d.textContent="密文";' +
      'document.body.appendChild(d);' +
      'var withSecret=a._probeFontDecrypt().secret;' +
      'd.parentNode.removeChild(d);' +
      'var without=a._probeFontDecrypt().secret;' +
      'return {withSecret:withSecret,without:without};})()'
    );
    check('第一层：.font-cxsecret 在场判「未解密」，摘掉后判「已解密」',
      !!secret && secret.withSecret === true && secret.without === false,
      JSON.stringify(secret));

    // ③ 第二层：题干几乎全密文（类名已摘掉 —— 模拟"解密扫描完成但表缺字形"）→ garbled=true
    var garbledFlag = await ctx.client.evaluate(
      '(function(){var a=' + app + ';' +
      'var w=document.createElement("div");w.className="TiMu";' +
      'var t=document.createElement("div");t.className="Zy_TItle";' +
      'var p=document.createElement("div");p.className="Pt1";' +
      'var s=document.createElement("span");s.className="fontLabel";s.textContent="1.";' +
      'var pua="";for(var i=0;i<12;i++)pua+=String.fromCharCode(0xE100+i);' +
      'p.appendChild(s);p.appendChild(document.createTextNode(pua));' +
      't.appendChild(p);w.appendChild(t);' +
      'var ul=document.createElement("ul");ul.className="Zy_ulTop";' +
      '["甲","乙"].forEach(function(txt){' +
      '  var li=document.createElement("li");li.textContent=txt;ul.appendChild(li);});' +
      'w.appendChild(ul);document.body.appendChild(w);' +
      'var q=a._parseQuestionElement(w,0);' +
      'var r={garbled:q?q.garbled:null,titleLen:q?q.title.length:0};' +
      'w.parentNode.removeChild(w);return r;})()'
    );
    check('第二层：题干全密文 → _parseQuestionElement 标 garbled=true',
      !!garbledFlag && garbledFlag.garbled === true && garbledFlag.titleLen > 0,
      JSON.stringify(garbledFlag));

    // ④ 反向守卫：作业页自带四道正常题，绝不能被误判乱码（误判 = 好卷被白白拦下）
    var clean = await ctx.client.evaluate(
      '(function(){var a=' + app + ';var qs=a._extractQuestions(null);' +
      'return {n:qs.length,garbledAny:qs.some(function(q){return q.garbled;})};})()'
    );
    check('作业页四道正常题 garbled 全为 false（好卷不误拦）',
      !!clean && clean.n >= 4 && clean.garbledAny === false,
      JSON.stringify(clean));

    // ---- R2（2026-11-10「所有题目都被跳过」第二条路径）----
    //   a) 解密漏字标记原来用 `_walkDocuments` 扫全书 —— 任何一个不相干的帧带标记，
    //      就会把这一页**每一份**卷子判成乱码。现在乱码计数只认题目所在文档。
    //   b) 轮次原来按 `_handleQuiz` 的调用次数累加，而它每秒被调一次 → 3 秒数满 3 轮。
    //      现在只有距上次计数 ≥10 秒才 +1。
    //   c) 数满 3 轮原来 `_skipQuiz()` → `nextUnit()` 跳整卷；现在只给这一卷 90 秒冷却。
    var r2 = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var out={};' +
      // ===== a) 只认题目所在文档 =====
      'var fr=document.createElement("iframe");document.body.appendChild(fr);' +
      'var fd=fr.contentDocument;' +
      'fd.documentElement.setAttribute("data-om-font-miss","1");' +
      'out.globalMiss=a._hasFontDecryptMiss();' +
      'out.paperDocMiss=a._hasFontDecryptMiss(document);' +
      'out.decorMiss=a._hasFontDecryptMiss(fd);' +
      // HIGH-2：探测集合只认「出题文档」（去重后的全部出题文档）。
      // 装饰帧既不出题也不包题，不许进集合 —— 否则守卫退化成
      // 「页面上随便哪个帧残留一个标记，就整卷暂停 90 秒」的误报源。
      // 这里同时留下证据：标记**确实挂在页面上**（globalMiss/decorMiss 都为真），
      // 所以「不算乱码」是因为探测范围对了，不是因为标记没写上去。
      'var pdocs=a._getQuizDocumentsFromQuestions(a._extractQuestions(null));' +
      'out.probeCount=pdocs.length;' +
      'out.probeHasDecor=pdocs.some(function(d){return d===fd;});' +
      'out.probeMissAny=pdocs.some(function(d){return a._hasFontDecryptMiss(d);});' +
      'fr.parentNode.removeChild(fr);' +
      // ===== b)/c) 题目所在文档真的带标记时，整段乱码守卫的行为 =====
      'document.documentElement.setAttribute("data-om-font-miss","1");' +
      'a.configs=Object.assign({},a.configs,{enableQuiz:true,hasApiKey:true,randomAnswer:false});' +
      'a._quizApiFailUntil=0;a._quizAnswered=false;a._quizInProgress=false;' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'a._quizGarbledRounds=0;a._quizGarbledRoundAt=0;a._quizGarbledPaperKey="";' +
      'a._quizCurrentQuestions=null;' +
      // 只桩 `nextUnit`：R2 已删掉运行期对 `_skipQuiz()` 的调用（现在只剩 `xxtAI.skipQuiz`
      // 这个手动入口），桩它数出来恒为 0 —— 一条永远不会红的半句比没有更坏。
      'var unitCalls=0;' +
      'var oldUnit=a.nextUnit;' +
      'a.nextUnit=function(){unitCalls++;};' +
      // 模拟 OCS 循环每秒调一次，连调 6 次（= 6 秒）
      'for(var i=0;i<6;i++){a._handleQuiz(null);}' +
      'out.roundsAfter6=a._quizGarbledRounds;' +
      'out.skipUntilAfter6=a._quizForceSkipUntil;' +
      'out.unitCallsAfter6=unitCalls;' +
      // 把时间窗倒回 11 秒，模拟真的过了第 2、第 3 轮（e2e 不真等 20 秒）
      'a._quizGarbledRoundAt=Date.now()-11000;a._handleQuiz(null);' +
      'out.roundsAfterWindow2=a._quizGarbledRounds;' +
      'out.skipUntilAfterWindow2=a._quizForceSkipUntil;' +
      'a._quizGarbledRoundAt=Date.now()-11000;a._handleQuiz(null);' +
      'out.cooldown=a._quizForceSkipUntil;' +
      'out.hasPaperKey=String(a._quizForceSkipPaperKey||"").length>0;' +
      'out.isSkipping=a._isQuizForceSkipping();' +
      // HIGH-1 的核心断言：**写入端记的键 == 读取端在同一文档上算出的键**。
      // 读取端原来用无参 `_getQuizWorkKey(null)`（解析到主帧/document），嵌套帧页面上
      // 与写入端的题目文档不是同一个 → 键不等 → 「暂停 90 秒」形同不存在，
      // 而 R1 已关掉跳过出口、R2 已删掉 `_skipQuiz()` → 该节点永久停摆。
      'out.writerKey=String(a._quizForceSkipPaperKey||"");' +
      'out.readerSameDocKey=String(a._getQuizWorkKey(document));' +
      'out.isSkippingDoc=a._isQuizForceSkipping(document);' +
      'out.unitCallsFinal=unitCalls;' +
      'out.inProgress=a._quizInProgress;' +
      // ===== 还原：别的断言不能看见一个被污染的页面 =====
      'a.nextUnit=oldUnit;' +
      'document.documentElement.removeAttribute("data-om-font-miss");' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";a._quizGarbledRounds=0;' +
      'a._quizGarbledRoundAt=0;a._quizGarbledPaperKey="";a._quizInProgress=false;' +
      'a._quizCurrentQuestions=null;a._fontSecretWaitSince=0;' +
      'return out;})()'
    );
    check('R2a 不相干帧的解密标记：全书扫描仍然看得见（等解密那处的语义没被改坏）',
      !!r2 && r2.globalMiss === true, JSON.stringify(r2));
    check('R2a 乱码计数只认题目所在文档：别的帧带标记不算这份卷子乱码',
      !!r2 && r2.paperDocMiss === false, JSON.stringify(r2));
    check('HIGH-2 探测集合=去重后的出题文档，不含装饰帧（标记确实在页面上，只是不算这份卷子）',
      !!r2 && r2.decorMiss === true && r2.globalMiss === true && r2.probeHasDecor === false &&
      r2.probeMissAny === false && r2.probeCount >= 1, JSON.stringify(r2));
    check('R2b 每秒调一次 _handleQuiz，6 次只数进 1 轮（守卫确实开火了，不再 3 秒数满 3 轮）',
      !!r2 && r2.roundsAfter6 === 1, JSON.stringify(r2));
    check('R2c 头 6 秒内既不跳卷也不进冷却（nextUnit 零调用）',
      !!r2 && r2.skipUntilAfter6 === 0 && r2.unitCallsAfter6 === 0,
      JSON.stringify(r2));
    check('R2b 过了 10 秒时间窗才数第 2 轮',
      !!r2 && r2.roundsAfterWindow2 === 2 && r2.skipUntilAfterWindow2 === 0, JSON.stringify(r2));
    var r2Cool = !!r2 && r2.cooldown > Date.now();
    check('R2c 数满 3 轮改为「这一卷暂停 90 秒」：按卷冷却已写入且带卷子身份键',
      r2Cool && !!r2 && r2.hasPaperKey === true && r2.isSkipping === true, JSON.stringify(r2));
    check('HIGH-1 写入端的键就是读取端在同一文档上算出的键（同一文档 → 冷却真的生效）',
      !!r2 && r2.writerKey === r2.readerSameDocKey && r2.isSkippingDoc === true, JSON.stringify(r2));
    check('R2c 数满 3 轮**不跳卷**：nextUnit 全程零调用、没岔住 _quizInProgress',
      !!r2 && r2.unitCallsFinal === 0 && r2.inProgress === false,
      JSON.stringify(r2));
  }
});

/** ---- 1.5b 解密层结论闸门（2026-11-10 批次 5：用户那句「连解码那个都没有」）---- */
/**
 * 用户看到的「第二次遇到题目不答题」有两半：
 *   · 闸门整页扫描 —— 不相干帧里常年挂着解不掉的 .font-cxsecret 残留，
 *     于是每份卷子先白等满 8 秒（实测日志 8.1s / 12.2s 各一次，而那两份题面其实是好的）；
 *   · 解密层是黑盒 —— 「解不出来」和「根本没去解」在日志里长得一模一样（三条静默分支）。
 * 现在 content.js 给每份文档写结论（data-om-font-state / data-om-font-sweep），
 * page.js 的闸门只问题目那份文档及其子帧，认出终局判据（nodecl / nomap）时**不白等**。
 *
 * 用 /blank 而不是 /exam-work：这里一份题都抠不到，闸门放行后 `_handleQuiz`
 * 走到「0 道题」就同步返回 —— 加上把 `_extractQuestions` 换成计数桩，
 * 回归测试绝不会真的去打服务商（花钱且不可复现）。
 * ⚠️ 整段 evaluate 是**同步**的：content.js 的扫描插不进来，
 *    所以中途手工写的结论属性不会被解密层悄悄改回去。
 */
SCENARIOS.push({
  name: '解密结论闸门：终局判据不白等、没结论才等、范围只问题目那份文档',
  path: '/blank',
  run: async function (ctx) {
    var g = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var out={};' +
      'a.configs=Object.assign({},a.configs,{enableQuiz:true,hasApiKey:true,randomAnswer:false});' +
      'a._quizApiFailUntil=0;a._quizAnswered=false;a._quizInProgress=false;' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";a._fontSecretWaitSince=0;' +
      // 抠题换成计数桩：闸门放没放行看它被调几次，比读内部状态直接
      'var exCalls=0,oldEx=a._extractQuestions;' +
      'a._extractQuestions=function(){exCalls++;return [];};' +
      'var de=document.createElement("div");de.className="font-cxsecret";de.textContent="密文题干";' +
      'document.body.appendChild(de);' +
      // content.js 可能已经先跑过一轮、在这份文档上留下 clean 结论与扫描戳。
      // ① 断言的是「什么都没有」那一种，所以先把两个属性擦掉，判据才确定。
      'var el=document.documentElement;' +
      'el.removeAttribute("data-om-font-state");el.removeAttribute("data-om-font-sweep");' +
      // 每步都自带基准：抠题计数用**增量**、等待戳每步先清 0。
      // 这样某一步坏了不会把后面的步骤一起拖红（一处注入只该对应一条断言）。
      // ===== ① 只有残留、解密层还没结论 → 判「还在解」，本轮真的等住 =====
      'var ex1=exCalls;' +
      'var p1=a._probeFontDecrypt();' +
      'out.secret1=p1.secret;out.state1=p1.state;out.sweep1=p1.sweepAgoMs;out.terminal1=p1.terminal;' +
      'a._handleQuiz(document);' +
      'out.waited={since:a._fontSecretWaitSince>0,ex:exCalls-ex1};' +
      // ===== ② 同一份残留，解密层说「这一份解不了」(nodecl) → 不白等，直接往下走 =====
      'el.setAttribute("data-om-font-state","nodecl");' +
      'el.setAttribute("data-om-font-sweep",String(Date.now()-50));' +
      'var p2=a._probeFontDecrypt();' +
      'out.terminal2=p2.terminal;out.state2=p2.state;out.sweepFresh=p2.sweepAgoMs>=0&&p2.sweepAgoMs<5000;' +
      'var ex2=exCalls;a._fontSecretWaitSince=0;a._quizInProgress=false;' +
      'a._handleQuiz(document);' +
      'out.noWait={since:a._fontSecretWaitSince,ex:exCalls-ex2};' +
      // ===== ③ 范围：残留只挂在外层，题目在内层帧 → 从内层探不到外层 =====
      'el.removeAttribute("data-om-font-state");el.removeAttribute("data-om-font-sweep");' +
      'var fr=document.createElement("iframe");document.body.appendChild(fr);' +
      'var fd=fr.contentDocument;' +
      'out.innerSecret=a._probeFontDecrypt(fd).secret;' +
      'out.outerSecret=a._probeFontDecrypt().secret;' +
      'var ex3=exCalls;a._fontSecretWaitSince=0;a._quizInProgress=false;' +
      'a._handleQuiz(fd);' +
      'out.scoped={since:a._fontSecretWaitSince,ex:exCalls-ex3};' +
      // ===== ④ 内层自己的残留仍然算数：范围收成子帧不等于把闸门关掉 =====
      'var din=fd.createElement("div");din.className="font-cxsecret";din.textContent="内层密文";' +
      'fd.body.appendChild(din);' +
      'out.innerOwnSecret=a._probeFontDecrypt(fd).secret;' +
      'fr.parentNode.removeChild(fr);de.parentNode.removeChild(de);' +
      'out.afterClean=a._probeFontDecrypt().secret;' +
      'a._extractQuestions=oldEx;' +
      'a._fontSecretWaitSince=0;a._quizInProgress=false;a._quizAnswered=false;' +
      'a._quizCurrentQuestions=null;' +
      'return out;})()'
    );
    check('① 只有残留、没有结论：判「还在解」，state=(none)、sweepAgo=-1，本轮等住（没抠题）',
      !!g && g.secret1 === true && g.state1 === '(none)' && g.sweep1 === -1 &&
      g.terminal1 === false && g.waited.since === true && g.waited.ex === 0, JSON.stringify(g));
    check('② 解密层的终局判据 nodecl：闸门认出 terminal 且扫描戳是新的，不白等、直接抠题',
      !!g && g.terminal2 === true && g.state2 === 'nodecl' && g.sweepFresh === true &&
      g.noWait.since === 0 && g.noWait.ex === 1, JSON.stringify(g));
    check('③ 残留只在外层时不算这份卷子的账：从题目文档探不到、整页仍探得到（旧语义没被改坏），' +
      '所以 _handleQuiz(内层) 不等',
      !!g && g.innerSecret === false && g.outerSecret === true &&
      g.scoped.since === 0 && g.scoped.ex === 1, JSON.stringify(g));
    check('④ 内层文档自己的残留仍然看得见（收窄范围没有顺带把守卫关掉）',
      !!g && g.innerOwnSecret === true, JSON.stringify(g));
    check('⑤ 收尾：残留摘干净后整页不再判「有密文」，页面没被这个场景污染',
      !!g && g.afterClean === false, JSON.stringify(g));

    // ===== ⑥ 另外一半：content.js 确实给每份文档写了结论与扫描戳 =====
    // 这条断言的是**解密层自己**留下的证据，不是 page.js 怎么读它 ——
    // 没有它，「连解码都没有」和「解开了」在这里看起来一样。
    var cv = null;
    for (var i = 0; i < 20; i++) {
      await sleep(300);
      cv = await ctx.client.evaluate(
        '(function(){var el=document.documentElement;' +
        'return {state:el.getAttribute("data-om-font-state"),' +
        'sweep:Number(el.getAttribute("data-om-font-sweep")||0)};})()'
      );
      if (cv && cv.state === 'clean' && cv.sweep > 0) break;
    }
    check('⑥ content.js 给每份文档写了结论与扫描戳（data-om-font-state=clean + 时间戳）',
      !!cv && cv.state === 'clean' && cv.sweep > 0 && Date.now() - cv.sweep < 60000,
      JSON.stringify(cv));

    // ===== ⑦ 扫描真的排得到（有界防抖）=====
    // 只有 300ms 尾部防抖时，**每一次** DOM 变动都重新计时：页面每 50ms 动一次就永远
    // 排不到扫描 —— 这正是"连解码都没有"里最难发现的那一半（跑没跑，日志里看不出来）。
    // 判据用扫描戳：它每轮必然换新值，所以"戳前进了"= 这 2.6 秒里确实扫过。
    var churn = await ctx.client.evaluate(
      '(function(){var el=document.documentElement;' +
      'window.__b5start=function(){' +
      '  var n=document.createElement("div");document.body.appendChild(n);window.__b5n=n;' +
      '  window.__b5t=setInterval(function(){n.textContent=String(Math.random());},50);};' +
      'window.__b5stop=function(){if(window.__b5t){clearInterval(window.__b5t);window.__b5t=0;}' +
      '  if(window.__b5n&&window.__b5n.parentNode)window.__b5n.parentNode.removeChild(window.__b5n);};' +
      'window.__b5stop();window.__b5start();' +
      'return {before:Number(el.getAttribute("data-om-font-sweep")||0)};})()'
    );
    await sleep(2600);
    var churnAfter = await ctx.client.evaluate(
      '(function(){return {after:Number(document.documentElement.getAttribute(' +
      '"data-om-font-sweep")||0), stillChurning: !!window.__b5t};})()'
    );
    await ctx.client.evaluate('(function(){window.__b5stop();return true;})()');
    check('⑦ 每 50ms 动一次 DOM（比 300ms 防抖还密）时扫描仍排得到：2.6 秒内扫描戳前进了',
      !!churn && churn.before > 0 && !!churnAfter && churnAfter.stillChurning === true &&
      churnAfter.after > churn.before,
      JSON.stringify(churn) + ' → ' + JSON.stringify(churnAfter));
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
    await writeConfig(ctx.extensionId, cfg);
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

    // 2026-10-31 批次定版 3 之后一卷发多个请求 —— 断言扫描全部请求的并集，
    // 别只看最后一条（末批可能只有填空/简答，没有单选题干）
    var prompt = ctx.mock.requests.slice(before).map(function (r) { return r.prompt; }).join('\n');
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
    // ⚠️ 旧口径（1.2.9 那阵）写过「多选本地作答、不进请求，这里只守它有值」——
    //    README §6 #49 已经把它反转了：多选**默认问模型**，本地只剩"模型那份没填上"时的补填。
    //    所以这条现在钉的是**模型给的答案原样落地**（宽松正则等于什么都没断：
    //    本地兜底随便凑一组也是 A-D 字母串，坏了照样绿）。
    check('多选题回填模型给的 A,C → #answer1002 = "AC"',
      result.a1002 === 'AC', JSON.stringify(result.a1002));
    // 原来这里还有一段「直接调 _fillAnswers 再验一次 AC」—— 上面那条严格断言落地后它就成了
    // 重叠（同一分支、同一夹具形状、同一答案），按 AGENTS §5「一个注入只破一个行为」删掉。
    // 「重复填同一答案不会把已选项切掉（幂等）」在多选本地作答那条场景里单独守着。
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
    await writeConfig(ctx.extensionId, cfg);
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

    // ---- R3 + HIGH-1（2026-11-10「所有题目都被跳过」第三条路径）----
    // 冷却要按卷子、不能按页面：`_isQuizForceSkipping()` 一为真，
    // `_isQuizLearningPending()` 第一行就 return false —— 调度据此认为
    // 「这一页所有答题任务点都不用做」，一张坏卷子能把整门课冻结到冷却结束。
    // ⚠️ 这里**不许桩掉 `_getQuizWorkKey`**：桩掉之后验证的只是"键能对上"，
    //   而本批要修的正是「读写两侧算的是不同文档的键」。
    //   所以造两份**真实**卷子文档（两个隐藏 iframe，各自 `workRelationId` 不同），
    //   让生产函数自己算键、自己对键 —— 真函数往返。
    var r3 = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var out={};' +
      'function paper(relId){' +
      '  var f=document.createElement("iframe");f.style.display="none";' +
      '  document.body.appendChild(f);' +
      '  var d=f.contentDocument;var form=d.createElement("form");' +
      '  [["courseId","c-e2e"],["classId","k-e2e"],["workRelationId",String(relId)],["jobid","j"+relId]].forEach(function(kv){' +
      '    var i=d.createElement("input");i.type="hidden";i.id=kv[0];i.value=kv[1];form.appendChild(i);});' +
      '  d.body.appendChild(form);return {frame:f,doc:d};}' +
      'var A=paper(111),B=paper(222);' +
      'out.keyA=String(a._getQuizWorkKey(A.doc));' +
      'out.keyB=String(a._getQuizWorkKey(B.doc));' +
      'out.keysDiffer=out.keyA!==out.keyB;' +
      // 401 这一支写的是**全局**冷却（不带卷子键）：语义与本批修复前保持一致
      'out.globalWriteKey=String(a._quizForceSkipPaperKey||"");' +
      'a._setQuizForceSkip(60000,"");' +
      'out.globalAppliesToA=a._isQuizForceSkipping(A.doc);' +
      'out.globalAppliesToB=a._isQuizForceSkipping(B.doc);' +
      // A 卷写按卷冷却 → 拿两份真实文档分别问：A 该被冻住，B 不该
      'a._setQuizForceSkip(60000,out.keyA);' +
      'out.aSkips=a._isQuizForceSkipping(A.doc);' +
      'out.bSkips=a._isQuizForceSkipping(B.doc);' +
      // ⚠️ 这里原来还有一条「写入侧与读取侧在同一个文档上算出同一个键」，可它上一行刚把
      // `out.keyA`（= `_getQuizWorkKey(A.doc)` 算出来的）写进 `_quizForceSkipPaperKey`，
      // 再拿同一个表达式比回来 —— 自写自算，永远为真。同一份卷子确实被冻住那半边
      // 已经由 `aSkips` 断到了；「读写必须同一个文档表达式」这条真不变式由 /submit-key 那一族守（README §6 #52）。
      // 认不出当前卷子时**保守**：冷却继续生效。
      // 这条要的是「抛异常」那种认不出 —— `_getQuizWorkKey` 永远带
      // `omitone.quiz.correct.` 前缀且有 location 兜底，**不可能返回空串**，
      // 桩成空串是在测一个生产里不存在的世界。
      'var oldKey=a._getQuizWorkKey;' +
      'a._getQuizWorkKey=function(){throw new Error("e2e unknown paper");};' +
      'out.unknownPaperSkips=a._isQuizForceSkipping(A.doc);' +
      'a._getQuizWorkKey=oldKey;' +
      // 窗口过去之后，任何卷子都不该再被挡
      'a._quizForceSkipUntil=Date.now()-1;' +
      'out.expiredSkipsA=a._isQuizForceSkipping(A.doc);' +
      'out.expiredSkipsB=a._isQuizForceSkipping(B.doc);' +
      'A.frame.parentNode.removeChild(A.frame);B.frame.parentNode.removeChild(B.frame);' +
      'a._quizForceSkipUntil=0;a._quizForceSkipPaperKey="";' +
      'return out;})()'
    );
    check('R3 两份 workRelationId 不同的真实卷子文档算出的键确实不同（真函数往返，不是桩）',
      !!r3 && !!r3.keyA && !!r3.keyB && r3.keysDiffer === true, JSON.stringify(r3));
    check('R3 401 仍是全局冷却（写入不带卷子键，本批没改它的语义）',
      !!r3 && r3.globalWriteKey === '' && r3.globalAppliesToA === true && r3.globalAppliesToB === true,
      JSON.stringify(r3));
    check('R3 A 卷的冷却不再冻结 B 卷（同一时刻 A 仍被拦住）',
      !!r3 && r3.bSkips === false && r3.aSkips === true, JSON.stringify(r3));
    check('R3 认不出当前卷子时保守：冷却继续生效',
      !!r3 && r3.unknownPaperSkips === true, JSON.stringify(r3));
    check('R3 冷却过期后不再拦住任何卷子',
      !!r3 && r3.expiredSkipsA === false && r3.expiredSkipsB === false, JSON.stringify(r3));
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
    // 现场实测（用户日志）：`answer field 905907427 value= DBAC`（点选是 A→B→C→D），
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
    // 改成监听 `_loadQuizCorrectAnswerCache`：带守卫时三个函数**全部短路**、一次都不读。
    //
    // 第三个（`_rememberSubmittedQuizAnswers`）是**审计后补上的** ——
    // 一开始我以为它不能守（怕"不记已提交"导致重复提交），那是错的：
    // `submittedById` 全代码只有一个读取点，用途是"题目被判错、答案域为空时回退用上次提交的答案
    // 来记录错误"，**不驱动提交流程**。所以乱选写的随机答案同样只会起污染作用。
    var r7b = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var reads=0; var orig=app._loadQuizCorrectAnswerCache;' +
      'app._loadQuizCorrectAnswerCache=function(){reads++;return orig.apply(app,arguments);};' +
      'app._rememberWrongQuizAnswers(null);' +
      'app._rememberCorrectQuizAnswers(null);' +
      'app._rememberSubmittedQuizAnswers(app._extractQuestions(null));' +
      'app._loadQuizCorrectAnswerCache=orig;' +
      'return {reads:reads};})()'
    );
    check('乱选模式完全不碰答案缓存（三个函数都短路，一次都不读）',
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
      r7f && r7f.isRandom === false && r7f.reason === 'quiz-toggle-off', JSON.stringify(r7f));

    // ⑦e 乱选的答案必须**真的填得进 DOM** —— 形状对不等于填得上。
    // 这是"能不能交卷"的最后一道关：填不进去 → 章节小测的提交前置（每题都有值）永远不满足
    // → 整卷永不提交 → 用户看到的是"什么都不发生"。
    // 前面几条只验了形状（数量、类型、非空），**没验过端到端填得进去**，这里补上。
    var r7g = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:true, apiKey:""});' +
      'var qs=app._extractQuestions(null);' +
      'var ans=app._buildRandomQuizAnswers(qs);' +
      'var filled=0, err=[];' +
      'for(var i=0;i<qs.length;i++){' +
      '  var q=qs[i];' +
      '  try{' +
      '    if(q.type==="multiple") app._fillMultiChoice(q._element, ans[i]);' +
      '    else if(q.type==="fill") app._fillText(q._element, ans[i]);' +
      '    else if(q.type==="short") app._fillTextarea(q._element, ans[i]);' +
      '    else app._fillChoice(q._element, ans[i], "radio");' +
      '  }catch(e){ err.push(String(e && e.message).slice(0,40)); }' +
      '  if(app._getQuizQuestionFilledValue(null, q)) filled++;' +
      '}' +
      'return {filled:filled, total:qs.length, types:qs.map(function(q){return q.type;}), err:err};})()'
    );
    check('乱选的答案真的填得进 DOM（能交卷的最后一道关）',
      r7g && r7g.total > 0 && r7g.filled === r7g.total, JSON.stringify(r7g));

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
      { module: 'insertvote', expect: 'vote', label: '投票任务点 → vote（认不出就当没任务，整节会死循环）' }
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
    // ⚠️ 用例以前用的是 insertvote —— 2026-11-11 真页实测后投票**已支持**（kind=vote），
    //    再拿它当"不支持"就是测一件不存在的事。换成真正没有判型的一条：insertcard。
    var logged = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;app._unsupportedJobLogged=null;' +
      'app._buildAttachmentOnlyJob({job:true,property:{module:"insertcard"}});' +
      'return app._unsupportedJobLogged;})(window._xxtApp)'
    ).catch(function () { return null; });
    check('真认不出类型的那一族（insertcard）会被记进「不支持」日志（便于排查"任务点没做"）',
      !!(logged && logged['insertcard|']), JSON.stringify(logged));

    // ---- 批次 29：「只有附件、任务盒名字里没有『讨论』二字」那一族的口径 ----
    // 现场形状（批次 20 复述）：附件 `module:"insertbbs"`，名字里没有讨论字样。
    // 讨论**本来就归讨论域那条独立 tick 链**（`_isDiscussionAttachment` 只看 module/type，
    // 与名字无关），可 `_buildAttachmentOnlyJob` 说不出 kind 时把它和"真认不出类型"
    // 共用一句 `unsupported task point type, skipped` —— 把"换了人做"写成"没人做"，
    // 排查会顺着这条根本不存在的放弃路径找。反过来，用户把讨论开关关掉才是**真的**
    // 没人发帖，那一句必须单独说得出来（warn，不是 info）。
    var b29 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'window.__b29=[];' +
      'if(!window.__b29Hook){window.__b29Hook=1;' +
      '  window.addEventListener("message",function(e){var m=e.data;' +
      '    if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b29.push(m);});}' +
      // 两道去重计数与共享配置都由本场景自己钉住（扩展存储整轮共用，别依赖上一个场景跑过）
      'app._unsupportedJobLogged=Object.create(null);' +
      'app._discussionHandoffLogged=null;' +
      'var prevDisc=app.configs.enableDiscussion;' +
      'app.configs.enableDiscussion=true;' +
      'var att={job:true,name:"第一章 第二节",property:{module:"insertbbs"}};' +
      'var card={job:true,name:"卡片任务",property:{module:"insertcard"}};' +
      'var r={nameBacked:app._discussionNameOf(att),isDisc:app._isDiscussionAttachment(att)};' +
      'r.built=app._buildAttachmentOnlyJob(att)?1:0;' +
      'r.builtTwice=app._buildAttachmentOnlyJob(att)?1:0;' +
      'r.cardBuilt=app._buildAttachmentOnlyJob(card)?1:0;' +   // 对照件也不建 job，但走的是另一句日志
      'app._discussionHandoffLogged=null;' +
      'app.configs.enableDiscussion=false;' +
      'r.offBuilt=app._buildAttachmentOnlyJob(att)?1:0;' +
      'app.configs.enableDiscussion=prevDisc;' +
      'r.discEntry=String(prevDisc);' +
      'r.discRestored=String(app.configs.enableDiscussion);' +
      'return r;})()'
    );
    // 日志走 postMessage，异步送达 —— 不等一拍就读，"没发"与"没等到"长得一模一样
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
    var b29Log = await ctx.client.evaluate(
      '(function(){var logs=window.__b29||[];var rows=[];' +
      'logs.forEach(function(m){rows.push({level:String(m.level||""),message:String(m.message||""),' +
      'module:m.meta&&m.meta.module,name:m.meta&&m.meta.name,hint:m.meta&&m.meta.hint||""});});' +
      'window.__b29=[];return {seen:logs.length,rows:rows};})()'
    );
    function b29Rows(message) {
      return (b29Log.rows || []).filter(function (r) { return r.message === message; });
    }
    check('夹具自证：这一族的附件名字里确实没有「讨论」二字，而判据仍认得出它是讨论',
      b29.nameBacked === '第一章 第二节' && !/讨论|话题|回帖|发帖/.test(b29.nameBacked) &&
      b29.isDisc === true, JSON.stringify(b29));
    check('讨论附件不在这条链建 job（两次调用与关掉开关时都不建）',
      b29.built === 0 && b29.builtTwice === 0 && b29.offBuilt === 0, JSON.stringify(b29));
    check('它不再被记成「unsupported task point type, skipped」——那句里不许出现 insertbbs',
      b29Rows('unsupported task point type, skipped').every(function (r) { return r.module !== 'insertbbs'; }),
      JSON.stringify(b29Rows('unsupported task point type, skipped')));
    check('改记成「交给讨论链路」的一条（info，带附件自己说的 module 与名字）',
      b29Rows('discussion task point handed to discussion link').length === 1 &&
      b29Rows('discussion task point handed to discussion link')[0].level === 'info' &&
      b29Rows('discussion task point handed to discussion link')[0].module === 'insertbbs',
      JSON.stringify(b29Rows('discussion task point handed to discussion link')));
    check('同一状态连问两次只播一条（去重，别把日志刷成洪水）',
      b29Log.seen > 0 && b29Rows('discussion task point handed to discussion link').length === 1,
      JSON.stringify({ seen: b29Log.seen, rows: b29Log.rows }));
    check('对照仍然有效：真认不出类型的 insertcard 照样留下可查的 skipped 记录',
      b29Rows('unsupported task point type, skipped').some(function (r) { return r.module === 'insertcard'; }),
      JSON.stringify(b29Rows('unsupported task point type, skipped')));
    check('讨论开关关掉时另报一条 warn，明说是开关挡的（那才是真的没人发帖）',
      b29Rows('discussion task point skipped by switch').length === 1 &&
      b29Rows('discussion task point skipped by switch')[0].level === 'warn' &&
      /开关/.test(b29Rows('discussion task point skipped by switch')[0].hint),
      JSON.stringify(b29Rows('discussion task point skipped by switch')));
    check('本场景把进门前读到的 enableDiscussion 原样还回去（自己钉状态、不把临时的 false 留给后面）',
      b29.discRestored === b29.discEntry, JSON.stringify(b29));

    // ---- R1（2026-11-10「所有题目都被跳过」）：无主帧 + 顶层页认不出任何标记 ----
    // `_hasTaskPoint()` 的返回值同时喂三条跳过出口（`_isCurrentCompleted` →
    // `_skipIfCompleted` → nextUnit、`_runTick` 尾部跳过分支、`_locateDocumentTask`
    // 的 worthHandling）。判不出却返回 false = 肯定地告诉调用方「这一页没有任务点」，
    // 于是**静默跳题**。保守返回 true 之后，空节只能靠 `_tryAdvanceIdleSection`
    //（自带时间窗与日志）推进，不许从这条出口翻页。
    // 下面这几条断言是**行为**断言：先自证前置条件成立，再验跳过出口没动。
    var noFrame = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var f=document.getElementById("iframe");if(f)f.parentNode.removeChild(f);' +
      'var markerSel=".ans-job-icon, .ans-task-icon, .taskPoint, .ans-job-num, #panView, .fileBox, .pageNum, #pageNumber";' +
      'var out={noMainFrame:!document.getElementById("iframe"),' +
      'noMarker:!document.querySelector(markerSel),' +
      'noTaskText:(document.body.textContent||"").indexOf("任务点")===-1};' +
      'out.hasTaskPoint=app._hasTaskPoint();' +
      // 只带 .icon_Completed（不带 catalog_points_*）：让 _isCurrentCompleted 一路走到
      // 最后一行 `return !this._hasTaskPoint()`，同时 _hasTaskPoint 三个探测仍全落空
      'var cat=document.createElement("div");cat.className="posCatalog_select posCatalog_active";' +
      'var ok=document.createElement("i");ok.className="icon_Completed";cat.appendChild(ok);' +
      'document.body.appendChild(cat);' +
      'out.isCurrentCompleted=app._isCurrentCompleted();' +
      'var unitCalls=0,cardCalls=0;' +
      'var oldUnit=app.nextUnit,oldCard=app._switchToNextLearningCard;' +
      'app.nextUnit=function(){unitCalls++;};' +
      'app._switchToNextLearningCard=function(){cardCalls++;return false;};' +
      'app.configs.restudy=false;app._quizSubmitPending=false;' +
      'out.skipped=app._skipIfCompleted();' +
      'out.unitCalls=unitCalls;out.cardCalls=cardCalls;' +
      'app.nextUnit=oldUnit;app._switchToNextLearningCard=oldCard;' +
      'cat.parentNode.removeChild(cat);' +
      'return out;})()'
    );
    check('R1 前置条件成立：无主帧、顶层页没有任何任务点标记与文字',
      !!noFrame && noFrame.noMainFrame === true && noFrame.noMarker === true && noFrame.noTaskText === true,
      JSON.stringify(noFrame));
    check('R1 认不出标记时 _hasTaskPoint() 保守返回 true（不许判成「没有任务点」）',
      !!noFrame && noFrame.hasTaskPoint === true, JSON.stringify(noFrame));
    check('R1 有任务点 → _isCurrentCompleted() 为 false（跳过判据不成立）',
      !!noFrame && noFrame.isCurrentCompleted === false, JSON.stringify(noFrame));
    check('R1 跳过出口不推进：_skipIfCompleted() 不调 nextUnit、不换学习卡片',
      !!noFrame && noFrame.skipped === false && noFrame.unitCalls === 0 && noFrame.cardCalls === 0,
      JSON.stringify(noFrame));
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
      'app.configs=Object.assign({},app.configs,{playbackRate:1.5,autoMaxPlaybackRate:false,muted:true,enableSeek:true});' +
      'var v=document.getElementById("omitone-video");' +
      'app._ensurePlaybackRate(v,"e2e");' +
      'return {rateApplied:v.playbackRate, muted:v.muted};})()'
    );
    check('倍速按配置应用（1.5x）', rate.rateApplied === 1.5, JSON.stringify(rate));
    check('静音按配置应用', rate.muted === true, JSON.stringify(rate.muted));

    // 自动最大倍速的**夹紧**这一支以前是零覆盖：打桩播放器探测不到倍速菜单，
    // `_getTargetPlaybackRate` 里 `Number(_detectedMaxRate) > 0` 不成立，于是永远走"回落到配置值"，
    // 而那句 `capped: r <= 2` 对着 1.5 恒为真 —— `_clampAutoRate` 的上限与 0.5 下限没有一条断言碰过。
    // 现在把探测结果直接钉成 6x / 0.2x，逼它走进夹紧那一支。
    var autoResult = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{autoMaxPlaybackRate:true,playbackRateCap:2,playbackRate:1.5});' +
      'var v=document.getElementById("omitone-video");' +
      // 钉住"已经探测过这台播放器"，否则这里会再排一次异步探测、把刚设的值改回去
      'app._rateProbing=false; app._rateDetectVideo=v;' +
      'app._detectedMaxRate=6; var over=app._getTargetPlaybackRate();' +
      'app._ensurePlaybackRate(v,"e2e-auto"); var applied=v.playbackRate;' +
      'app._detectedMaxRate=0.2; var floor=app._getTargetPlaybackRate();' +
      'app._detectedMaxRate=0; var fallback=app._getTargetPlaybackRate();' +
      'return {over:over, applied:applied, floor:floor, fallback:fallback};})()'
    );
    check('自动倍速：探测到 6x、上限设 2x → 夹紧到 2x 并按下去（旧写法这条走不到，_clampAutoRate 全仓零覆盖）',
      autoResult && autoResult.over === 2 && autoResult.applied === 2, JSON.stringify(autoResult));
    check('自动倍速：夹紧的下限也在 —— 探测出 0.2x 这种荒值不许真按 0.2x 播',
      autoResult && autoResult.floor === 0.5, String(autoResult && autoResult.floor));
    check('探测不到倍速时回落到配置值（不是 0、不是 NaN）',
      autoResult && autoResult.fallback === 1.5, String(autoResult && autoResult.fallback));

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

    // ---- 1.2.5：可拖动的**音频**也拖到结尾（与视频一视同仁）----
    // 原先 _trySeekToEnd 第一行硬门槛 tagName!=='VIDEO' 把音频挡掉；用户反馈有些音频任务
    // 同样可拖到底、平台照常计完成。这里断言音频也被 seek 到 duration-3。
    var audioSeek = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableSeek:true,autoMaxPlaybackRate:false,playbackRate:1});' +
      'app._rateProbing=false; app._rateDetectBusy=false; app._captchaActive=false;' +
      'app._seekTriedKeys=null; app._seekRevertedKeys=null; app._activeJobId="e2e-audio";' +
      'var a=document.getElementById("omitone-audio");' +
      'a.__ct=0;' +
      'var ok=app._trySeekToEnd(a,"e2e-audio");' +
      'return {ok:ok, ct:a.__ct||0, tag:String(a.tagName)};})()'
    );
    check('音频也能拖到结尾（AUDIO，100 → 97）', audioSeek.ok === true && audioSeek.ct === 97, JSON.stringify(audioSeek));

    // ---- 1.2.5：拖不动 + 锁 1x 的音频也纳入「90% 提前收尾」（_isNinetyPercentVideo 放开音频）----
    var audioNinety = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var a=document.getElementById("omitone-audio");' +
      'app._detectedMaxRate=1;' +               // 锁 1x
      'app._activeJobId="e2e-audio";' +
      'var key=app._getMediaSeekKey(a);' +
      'app._seekRevertedKeys={}; app._seekRevertedKeys[key]=true;' +  // 拖不动（被弹回）
      'return {eligible:app._isNinetyPercentVideo(a), key:String(key||"")};})()'
    );
    check('拖不动+锁1x 的音频也纳入 90% 提前收尾（与视频一致）', audioNinety.eligible === true, JSON.stringify(audioNinety));

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

    // 音频任务点应走配置倍速（不看自动最大倍速菜单）；
    // 静音开关已删：插件不再替用户静音音频，要静音直接静音标签页。
    // ⚠️ 这条以前把 `muted:false` 写进配置再去断 `audio.muted===false` —— 那个判据在
    // `_ensurePlaybackRate` 里是 `video.muted = !isAudio && !!configs.muted`，把 `!isAudio` 整段删掉
    // 它也照样绿。**要钉住"音频不被插件静音"，必须先把用户的静音开关打开。**
    var audioRate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{playbackRate:2,autoMaxPlaybackRate:false,muted:true});' +
      'app._rateProbing=false;' +
      'var a=document.getElementById("omitone-audio");' +
      'var v=document.getElementById("omitone-video");' +
      'app._ensurePlaybackRate(a,"e2e-audio");' +
      'app._ensurePlaybackRate(v,"e2e-video");' +
      'return {rate:a.playbackRate, audioMuted:a.muted, videoMuted:v.muted};})()'
    );
    check('音频应用配置倍速（2x）', audioRate.rate === 2, JSON.stringify(audioRate));
    check('用户开了静音时：音频仍不归插件管（只有视频被静音）—— 旧写法把 muted 设成 false，这条恒真',
      audioRate.audioMuted === false && audioRate.videoMuted === true, JSON.stringify(audioRate));

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
      'long:app._cleanCaptchaCode("abcdefghijklmnopqrstuvwxyz"),' +
      'prose:app._cleanCaptchaCode("图中没有可识别的验证码字符。"),' +
      'han:app._cleanCaptchaCode("德玛西亚"),' +
      'four:app._cleanCaptchaCode("QXKS")};})()'
    );
    check('验证码清洗：去掉引号', cleaned.quoted === 'aB3d', JSON.stringify(cleaned.quoted));
    check('验证码清洗：取最后一行并去空白', cleaned.multiLine === 'X7k2', JSON.stringify(cleaned.multiLine));
    check('验证码清洗：去标点', cleaned.punct === 'ABCD', JSON.stringify(cleaned.punct));
    check('验证码清洗：超长串一律不收（旧写法截断到 12 再交上去，交的是半句人话）',
      cleaned.long === '', JSON.stringify(cleaned.long));
    // 实测真墙：deepseek-flash 没看清图时回「图中没有可识别的验证码字符。」，
    // 旧清洗剥掉句号后正好剩 12 个汉字、卡在「截断到 12」以内 —— 那句人话被填进输入框
    // 并按了提交。判据用**形状**（超过 8 位就不是验证码），不用「只认字母数字」：
    // libs/prompt.js 的 CAPTCHA_PROMPT 明写「可能含汉字」，后者会把汉字验证码一整族判死。
    check('14-B：模型回一句人话时不许当成答案（真墙实测「图中没有可识别的验证码字符。」被填进输入框）',
      cleaned.prose === '', JSON.stringify(cleaned.prose));
    check('14-B 反向对照：汉字验证码仍然认（清洗不许改成「只认字母数字」，那是另一族的答案）',
      cleaned.han === '德玛西亚' && cleaned.four === 'QXKS', JSON.stringify({ han: cleaned.han, four: cleaned.four }));
  }
});

/** ---- 4.5 验证码：独立墙上那一下「提交」真的按下去了吗 ----
 *
 * 真墙实测（2026-11-11，【9010】那面）：码认对了、也填进 #ucode 了、日志写着
 * `standalone captcha code submitted`，可墙就是不过、任务点一直 captcha-not-cleared。
 * 抓回来的现场是：页面上只有一个 `input[type=submit][value=提交]`，
 * 而读按钮文本用的 `textOf()` 对 `<input>` 永远返回空串（input 没有子节点），
 * 于是 `/^提交/` 判不上、退成「派发一个合成 Enter」—— 合成 KeyboardEvent 不激活原生提交。
 * 旧夹具为什么看不见这件事：`buildStandaloneCaptchaHtml` 放的是 `<button type="button">提交</button>`，
 * 那种形状 textOf 读得到。**夹具长得像实现，不像现场，就等于没测。**
 */
SCENARIOS.push({
  name: '独立验证码墙真的按下提交',
  path: '/captcha-verify',
  run: async function (ctx) {
    var r = await ctx.client.evaluate(
      '(async function(){var app=window._xxtApp;var out={};' +
      // 先把插件自己的验证码循环关掉：本场景要数的是「我这一下调用点没点中」，
      // 而不是插件后台顺手又点了一次（那会让计数对不上），更不能让它拿真配置去花真钱。
      'app._checkCaptchaDialog=function(){return null;};' +
      'app._isStandaloneCaptchaPage=function(){return false;};' +
      'app._backgroundCaptchaTick=function(){return false;};' +
      // 把夹具自带的 <button>提交</button> 藏掉：本场景要测的是真墙那个形状，
      // 两者同时在页面上就分不清点的是哪一个
      'Array.prototype.forEach.call(document.querySelectorAll("button"),function(b){b.style.display="none";});' +
      'function mk(html){var d=document.createElement("div");d.innerHTML=html;' +
      '  d.style.cssText="position:fixed;left:10px;top:10px;z-index:99999";document.body.appendChild(d);return d;}' +
      // ① 真墙形状：只有 input[type=submit]，外加一个会把人带沟里去的「换一张」
      'var box=mk("<img id=\\"wImg\\" src=\\""+(document.getElementById("verifyImg").src)+"\\" width=120 height=40 style=\\"width:120px;height:40px\\">"' +
      '  +"<input id=\\"wIn\\" type=\\"text\\" style=\\"width:140px;height:26px\\">"' +
      '  +"<input id=\\"wSub\\" type=\\"submit\\" value=\\"提交\\" style=\\"width:120px;height:32px\\">"' +
      '  +"<button id=\\"wRe\\" type=\\"button\\" style=\\"width:60px;height:24px\\">换一张</button>");' +
      'var img=box.querySelector("#wImg"),inp=box.querySelector("#wIn"),sub=box.querySelector("#wSub"),re=box.querySelector("#wRe");' +
      'var nSub=0,nRe=0;nEnter=0;' +
      'sub.addEventListener("click",function(){nSub++});re.addEventListener("click",function(){nRe++});' +
      // 夹具自证：这枚控件的标签**只活在 value 里**（input 没有子节点、innerText 恒空）。
      // 旧代码只用 textOf 读标签，所以它对着真墙永远读不出「提交」两个字 ——
      // 先把这件事钉成 DOM 事实，下面几条才不会是空测。
      'out.labelOnlyInValue=sub.value==="提交" && String(sub.innerText||"")==="" && String(sub.textContent||"")==="";' +
      // ① 真墙检测出来的形状：dialog 就是 document.body（见 _detectStandaloneCaptcha）
      'out.viaWall=String(app._clickCaptchaSubmit({doc:document,img:img,input:inp,dialog:document.body}));' +
      'out.nSub=nSub;out.nRe=nRe;' +
      // ② 同一枚控件，走「独立页没有弹层容器」那条更窄的扫描（只认显式声明的提交控件）
      'out.viaNoDialog=String(app._clickCaptchaSubmit({doc:document,img:img,input:inp,dialog:null}));' +
      'out.nSub2=nSub;' +
      // ③ 一枚提交控件都没有：必须承认「只发了回车」，不许报成功
      'sub.parentNode.removeChild(sub);' +
      'inp.addEventListener("keydown",function(){nEnter++});' +
      'out.viaNone=String(app._clickCaptchaSubmit({doc:document,img:img,input:inp,dialog:document.body}));' +
      'out.nEnter=nEnter;' +
      'try{box.parentNode.removeChild(box);}catch(e){}' +
      // ③ 识别链路的钱闸：图没解码完不许问模型
      'var sent={llm:0,fetch:0};' +
      'window.__reply="QX4K";' +
      'var on=function(e){var m=e.data;if(!m||m.source!=="xxt_app")return;' +
      '  if(m.type==="llm_captcha"){sent.llm++;window.postMessage({source:"xxt_bridge",type:"llm_response",id:m.id,' +
      '    data:{success:true,data:window.__reply}},"*");}' +
      '  else if(m.type==="fetch_image"){sent.fetch++;window.postMessage({source:"xxt_bridge",type:"llm_response",id:m.id,' +
      '    data:{success:false,error:"测试里不放行取图"}},"*");}};' +
      'window.addEventListener("message",on,true);' +
      'var fresh=document.createElement("img");' +
      'fresh.style.cssText="position:fixed;left:10px;top:60px;width:120px;height:40px";document.body.appendChild(fresh);' +
      'Object.defineProperty(fresh,"naturalWidth",{value:0,configurable:true});' +
      'Object.defineProperty(fresh,"naturalHeight",{value:0,configurable:true});' +
      'var t0=Date.now();var notReady=await app._recognizeCaptchaImage(fresh);' +
      'out.notReady={ok:!!notReady.ok,err:String(notReady.error||"").slice(0,40),ms:Date.now()-t0,sent:JSON.parse(JSON.stringify(sent))};' +
      // ④ 图解码完了：恰好花一次，且拿到码
      'var good=document.getElementById("verifyImg");' +
      'sent.llm=0;sent.fetch=0;' +
      'var okRec=await app._recognizeCaptchaImage(good);' +
      'out.okRec={ok:!!okRec.ok,code:okRec.code||""};' +
      'out.okRecLlm=sent.llm;out.okRecFetch=sent.fetch;' +
      // ⑤ 模型回一句人话：不许当成答案，也不许被误判成「这个模型没有看图能力」
      'window.__reply="图中没有可识别的验证码字符。";' +
      'var prose=await app._recognizeCaptchaImage(good);' +
      'out.prose={ok:!!prose.ok,err:String(prose.error||"").slice(0,40),llm:sent.llm};' +
      'window.removeEventListener("message",on,true);' +
      'return JSON.stringify(out);})()'
    );
    var o;
    try { o = JSON.parse(String(r)); } catch (e) { o = null; }
    check('夹具自证：墙上那枚控件的标签只在 value 里、innerText/textContent 都是空（旧代码就是瞎在这一处）',
      !!o && o.labelOnlyInValue === true, JSON.stringify(o && o.labelOnlyInValue));
    check('14-B：真墙形态（dialog=body）下那枚 input[type=submit] 会被真点下去' +
          '（旧写法读不到标签，退成合成回车，一次都没提交过）',
      !!o && o.viaWall === 'dialog-button' && o.nSub === 1,
      JSON.stringify(o && { via: o.viaWall, nSub: o.nSub }));
    check('14-B：没有弹层容器那条更窄的扫描也认得它（改成只认 input/button[type=submit] 后不许把它漏掉）',
      !!o && o.viaNoDialog === 'submit-input' && o.nSub2 === 2,
      JSON.stringify(o && { viaNoDialog: o.viaNoDialog, nSub2: o.nSub2 }));
    check('14-B：「换一张」这种刷新键不许被当成提交（点它会白白换一张图、再花一次钱）',
      !!o && o.nRe === 0, JSON.stringify(o && o.nRe));
    check('14-B：没有提交控件时如实说「只发了回车」，不报成功',
      !!o && o.viaNone === 'enter-key' && o.nEnter >= 1, JSON.stringify(o && { viaNone: o.viaNone, nEnter: o.nEnter }));
    check('14-B：图还没解码完就不问模型（一条 llm_captcha 都不发 —— 空白图那一发是白花钱）',
      !!o && o.notReady && o.notReady.sent && o.notReady.ok === false && o.notReady.sent.llm === 0 &&
      /还没加载完|取不到/.test(o.notReady.err), JSON.stringify(o && o.notReady));
    check('14-B 反向对照：图解码完了照样只花一次、并且拿得到码（上面那条不是把链路一起关掉）',
      !!o && o.okRec && o.okRec.ok === true && o.okRec.code === 'QX4K' && o.okRecLlm === 1,
      JSON.stringify(o && { okRec: o.okRec, llm: o.okRecLlm, fetch: o.okRecFetch }));
    check('14-B：模型回一句人话时不当答案，且失败原因不落在「没有看图模型」那一类',
      !!o && o.prose && o.prose.ok === false && /形状/.test(o.prose.err) &&
      !/vision|not support|unsupported|multimodal|不支持|空回复|看图/i.test(o.prose.err),
      JSON.stringify(o && o.prose));
  }
});

/** ---- 5. 验证码：独立网址形态识别 ---- */
SCENARIOS.push({
  name: '独立验证码页识别',
  path: '/captcha-verify',
  run: async function (ctx) {
    var isCaptcha = await ctx.client.evaluate('!!window._xxtApp._isStandaloneCaptchaPage()');
    check('_isStandaloneCaptchaPage 判定为验证码页', isCaptcha === true, String(isCaptcha));

    // 上面那条为什么不会"因为别的原因"通过：这一页确实**像题**（旧判据会把它
    // 当成测验页而直接放过验证码），但抠不出一道有作答控件的题。
    var decoy = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return {oldLike:!!document.querySelector(app._quizDetectorSelector),' +
      '  containers:app._collectQuestionContainers(document).length,' +
      '  hasQuiz:app._documentHasQuiz(document),' +
      '  mainFrame:!!app._getMainFrame()};})()'
    );
    check('验证码页夹具自证：旧判据「像题即题」会把它判成测验页（像题、抠不出题）',
      !!decoy && decoy.oldLike === true && decoy.containers >= 1 &&
      decoy.hasQuiz === false && decoy.mainFrame === false,
      JSON.stringify(decoy));

    var detected = await ctx.client.evaluate(
      '(function(){var c=window._xxtApp._detectStandaloneCaptcha();' +
      'return c ? {hasImg:!!c.img, hasInput:!!c.input} : null;})()'
    );
    check('能抓到验证码图片与输入框', !!(detected && detected.hasImg && detected.hasInput),
      JSON.stringify(detected));

    // ---- 14-A：这一面墙不许无限刷新重试 ----
    // 现场（2026-11-11 在用户浏览器里当场量的）：账号被站方挂到 `antispiderShowVerify.ac`
    // （【9010】操作异常，请输入图片中的验证码）之后，旧实现每轮都是
    // 「识别 4 次 → 无条件 `location.reload()`」，而"已经失败几次"这个数字记在**页面内存**里，
    // 页面一刷新它就归零 —— 于是这是真的无限：实测约每半分钟整页刷新一次、每次连发 4 次识别，
    // 模型看不懂图时一路这样跑下去。刷新本身又是一次请求，正是把这面墙越坐越实的原因。
    //
    // ⚠️ 这一段**不能**写成"一次 evaluate 等它跑完"：真实等待是 2.6s + 0.7s 一档，
    //   两轮无进展就是 26 秒，而 harness 的 `Runtime.evaluate` 有 30 秒硬超时 ——
    //   基线贴着线过，反向验证一注入（去掉当场收手）就超时，报的是「场景执行未抛异常」，
    //   看起来像"断言抓不住"，其实是**验证根本没跑完**。
    //   所以每步只"点火"，回读交给后面的短 evaluate。
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var KEY="omitone:standalone-captcha-budget";' +
      'var w={rec:0,reloads:0,clicks:0,got:[],fail:"",running:false,finished:false};' +
      'window.__wall=w;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")w.got.push(m);});' +
      'w.seed=function(cycles,pauseUntil){try{sessionStorage.setItem(KEY,JSON.stringify(' +
      '  {cycles:cycles,pauseUntil:pauseUntil,href:String(location.href||"")}));}catch(e){}};' +
      'w.read=function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}")||{};}catch(e){return {};}};' +
      'w.metas=function(name){return w.got.filter(function(m){return m.message===name;})' +
      '  .map(function(m){return m.meta||{};});};' +
      // 刷新与识别全部换成计数器：真刷一次整页会打断后面四步，而这个动作本身就是被测的东西
      'w.orig={reload:app._reloadForStandaloneCaptcha,rec:app._recognizeCaptchaImage,' +
      '  fill:app._fillCaptchaInput,click:app._clickCaptchaSubmit,page:app._isStandaloneCaptchaPage};' +
      'app._reloadForStandaloneCaptcha=function(){w.reloads++;};' +
      'app._recognizeCaptchaImage=function(){w.rec++;var f=w.fail;' +
      '  return Promise.resolve({ok:f==="ok",code:"ab12",' +
      '    error:f==="ok"?"":(f==="vision"?"验证码识别返回空回复（结束原因 无）"' +
      '      :(f==="thinking"?"验证码识别返回空回复（结束原因 length） —— 思考把输出的预算占满了，把「思考强度」调到关闭即可"' +
      '      :(f==="notReady"?"验证码的图还没加载完，或画布被跨域挡住（这次没有请求模型）":"提交被拒，识别不对")))});};' +
      // click 的桩必须**返回一个 via**：真实实现现在就是这么回话的，桩返回 undefined
      // 就等于把「日志里到底有没有凭据」这件事测成了空值
      'app._fillCaptchaInput=function(){};' +
      'app._clickCaptchaSubmit=function(){w.clicks++;return "submit-input";};' +
      'w.start=function(fail,pageGone){w.fail=fail;w.finished=false;w.running=true;' +
      // 每一步都把「这一页还是不是验证码页」拨回它该是的样子：
      // st5 为了让「过了」这条走通，把它改成了恒 false；不拨回来，下一步的循环会在
      // 第一次识别后就当成功收场，第 6 步要量的「跑满 4 次」根本不会出现。
      '  app._isStandaloneCaptchaPage=pageGone?function(){return false;}:w.orig.page;' +
      // ⚠️ 共享状态要自己钉：整轮共用同一个 app，前一个场景（如「模型 401」）写过
      //   enableCaptcha:false，这一关就会在循环之前被开关短路 —— rec 恒 0，看着像夹具坏了
      '  app.configs=Object.assign({},app.configs,{enableCaptcha:true});' +
      '  app._captchaBusy=false;app._standaloneCaptchaPauseLogged=false;' +
      '  app._runStandaloneCaptchaMode().then(function(){w.running=false;w.finished=true;});' +
      '  return "started";};' +
      'w.tick=function(){return JSON.stringify({running:w.running,finished:w.finished,' +
      '  rec:w.rec,reloads:w.reloads,budget:w.read()});};' +
      'w.counts=function(){var app=window._xxtApp;return JSON.stringify({' +
      '  seen:w.got.length, rec:w.rec, reloads:w.reloads, clicks:w.clicks,' +
      '  stillDetectable:!!app._detectStandaloneCaptcha(),' +
      '  stop:w.metas("standalone captcha stopped, needs a human"),' +
      '  pause:w.metas("standalone captcha paused, waiting for a human"),' +
      '  resume:w.metas("standalone captcha resume retry"),' +
      '  solved:w.metas("standalone captcha solved"),' +
      '  failed:w.metas("captcha recognize failed"),' +
      '  reloadLog:w.metas("standalone captcha unsolved after retries, reload page"),' +
      '  submitted:w.metas("standalone captcha code submitted")});};' +
      'w.finish=function(){var k;for(k in w.orig){app[k]=w.orig[k];}' +
      '  w.seed(0,0);return w.counts();};' +
      'return JSON.stringify({ready:!!app._runStandaloneCaptchaMode&&!!app._readStandaloneCaptchaBudget,' +
      '  detect:!!app._detectStandaloneCaptcha()});})()'
    );
    var setupObj = JSON.parse(setup);

    async function wallStep(seedExpr, fail, maxMs, pageGone) {
      await ctx.client.evaluate('(function(){var w=window.__wall;' +
        (seedExpr ? 'w.seed(' + seedExpr + ');' : '') +
        'return w.start("' + fail + '",' + (pageGone ? 'true' : 'false') + ');})()');
      var startedAt = Date.now();
      for (;;) {
        var t = JSON.parse(await ctx.client.evaluate('window.__wall.tick()'));
        if (!t.running && t.finished) return t;
        if (Date.now() - startedAt > (maxMs || 20000)) return t;
        await new Promise(function (r) { setTimeout(r, 400); });
      }
    }

    var st1 = await wallStep('0,0', 'vision', 20000);
    var st2 = await wallStep(null, 'vision', 20000);
    var st3 = await wallStep('1,Date.now()-1', 'wrong', 25000);
    var st4 = await wallStep('1,0', 'wrong', 25000);
    var st5 = await wallStep('3,0', 'ok', 22000, true);
    await new Promise(function (r) { setTimeout(r, 700); });
    // 前五步的账先钉死：第 6 步还会往同一批日志里追加，end 若留到最后才读，
    // 「恰好 1 条」那几条会被它顶歪。
    var end = JSON.parse(await ctx.client.evaluate('window.__wall.counts()'));
    var st6 = await wallStep('0,0', 'notReady', 25000);
    await new Promise(function (r) { setTimeout(r, 700); });
    var c6 = JSON.parse(await ctx.client.evaluate('window.__wall.counts()'));
    // 第 7 步：另一种结构性失败 —— 「空回复，但结束原因是 length」
    var st7 = await wallStep('0,0', 'thinking', 22000);
    await new Promise(function (r) { setTimeout(r, 700); });
    var c7 = JSON.parse(await ctx.client.evaluate('window.__wall.counts()'));
    await ctx.client.evaluate('window.__wall.finish()');

    check('14-A 夹具自证：这一页真的挂得上验证码墙的桩、跑完七步后仍是抓得到图片与输入框的验证码页' +
      '（否则后面那几条是空测）',
      setupObj.ready === true && setupObj.detect === true && end.stillDetectable === true && end.seen > 0,
      JSON.stringify({ setup: setupObj, stillDetectable: end.stillDetectable, seen: end.seen }));
    check('14-A：模型看不懂图时一轮**只发 1 次**识别（旧写法每次烧满 4 次，钱花完也永远不可能对）',
      st1.rec === 1, JSON.stringify({ rec: st1.rec, reloads: st1.reloads }));
    check('14-A：看不懂图这一轮当场停手 —— 一次都不刷新，且预算里写下暂停时间',
      st1.reloads === 0 && Number(st1.budget.pauseUntil) > Date.now() - 60000,
      JSON.stringify({ reloads: st1.reloads, budget: st1.budget }));
    check('14-A：停手期间一个请求都不发（识别次数与刷新次数都不许再涨）',
      st2.rec === st1.rec && st2.reloads === 0 &&
      !!(end.pause[0] && Number(end.pause[0].resumeInMs) > 0),
      JSON.stringify({ st2: st2, pause: end.pause[0] }));
    check('14-A：停手那条要说清怎么办（亲手输一次 + 换会看图的模型），不是又一句"失败"',
      !!(end.stop[0] && /亲手/.test(String(end.stop[0].hint || '')) &&
      /看图模型|验证码识别模型/.test(String(end.stop[0].hint || '')) &&
      end.stop[0].reason === 'noVisionModel'), JSON.stringify(end.stop[0]));
    check('14-A 反向对照：冷却到点确实再给一轮（停手不是永久放弃），且第一轮无进展仍刷一次',
      end.resume.length === 1 && st3.rec === st2.rec + 4 && st3.reloads === 1 &&
      end.reloadLog.length === 1,
      JSON.stringify({ resume: end.resume.length, st3: st3, reloadLog: end.reloadLog.length }));
    check('14-A：连吃两轮无进展就彻底停手、**不再刷新**（刷新的次数停在第一轮那一次）',
      st4.reloads === st3.reloads && end.reloadLog.length === 1 &&
      !!(end.stop[1] && end.stop[1].reason === 'twoCyclesUnsolved'),
      JSON.stringify({ st4: st4, reasons: end.stop.map(function (m) { return m.reason; }) }));
    check('14-A：真过了就把预算清零（停手这笔账不许带进下一面墙）',
      st5.budget.cycles === 0 && !st5.budget.pauseUntil && end.solved.length === 1,
      JSON.stringify({ budget: st5.budget, solved: end.solved.length }));
    // ---- 14-B：日志要带「这一下到底是怎么提交的」 ----
    // 真墙被埋的那几轮就埋在这里：日志写着 code submitted，可 `_clickCaptchaSubmit`
    // 什么都没点着（它退成了合成 Enter）。没有 via，「点了提交」与「压根没按钮可点」
    // 在日志里长得一模一样，用户报上来、我们从日志里看不出任何异常。
    check('14-B：提交那条日志自带 via（是哪个控件按下去的），不是只写一句「已提交」',
      end.submitted.length === 1 && end.submitted[0].via === 'submit-input' &&
      end.submitted[0].attempt === 1 && end.submitted[0].length === 4 && c6.clicks === end.clicks,
      JSON.stringify({ submitted: end.submitted, clicks: c6.clicks }));
    // ---- 14-B：自己那一侧的失败串不许撞「结构性失败」判据 ----
    // 实测：判据里混着 `image`、`empty`，而我们自己的报错就叫
    // 'captcha image capture failed' / 'empty code after clean' —— 于是「图还没加载完」
    // 被读成「这个模型没有看图能力」，当场停手 15 分钟，还让用户去设置里换看图模型
    // （那是完全无关的一条路）。判据现在只认厂商侧的英文说法，自己的串说中文。
    check('14-B：「图没加载完」不算「模型没有看图能力」—— 仍跑满 4 次、走刷新那一条，而不是当场停手',
      st6.rec === end.rec + 4 && st6.reloads === end.reloads + 1 &&
      c6.stop.length === end.stop.length && c6.failed.length === end.failed.length + 4 &&
      c6.reloadLog.length === end.reloadLog.length + 1,
      JSON.stringify({ dRec: st6.rec - end.rec, dReloads: st6.reloads - end.reloads,
        dStop: c6.stop.length - end.stop.length, dFailed: c6.failed.length - end.failed.length,
        lastError: c6.failed[c6.failed.length - 1] }));
    // ---- 批次 15：同为「空回复」，出路是两件不同的事 ----
    // 「结束原因 length」= 厂商确实看见了图，是思考 token 把 max_tokens 吃光。
    // 这时候仍叫用户去换「看图模型」，就是 14-B④ 那个坑换了个方向再犯一次：
    // 把人支到一条不相干的路上（而真正要调的开关就在同一页设置里）。
    check('批次 15：思考占满预算也算结构性失败（一轮只发 1 次、不刷新），但 reason 不许冒充 noVisionModel',
      st7.rec === c6.rec + 1 && st7.reloads === c6.reloads &&
      c7.stop.length === c6.stop.length + 1 &&
      c7.stop[c7.stop.length - 1].reason === 'thinkingBudgetFull',
      JSON.stringify({ dRec: st7.rec - c6.rec, dReloads: st7.reloads - c6.reloads,
        reasons: c7.stop.map(function (m) { return m.reason; }) }));
    check('批次 15：那条给的出路是「把思考强度调到关闭」，不是又叫人换看图模型',
      /思考强度/.test(String(c7.stop[c7.stop.length - 1].hint || '')) &&
      !/看图模型|验证码识别模型/.test(String(c7.stop[c7.stop.length - 1].hint || '')) &&
      /亲手/.test(String(c7.stop[c7.stop.length - 1].hint || '')),
      JSON.stringify(c7.stop[c7.stop.length - 1]));
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

    // ---- 批次 42 补的零覆盖分支：连线/匹配题（选项文本成对重复）----
    // 现场日志的形状：左右两列被一起抓成「6 个选项」，文本两两重复
    //（Color / Transparency / Color / Transparency / …）。这种题拿选择题的作答方式
    // 永远对不上，旧逻辑连着问 6 次模型、每次都被判错 —— 用户看到的就是「弹题卡住，
    // 刷新后重来还是它」。判据是 `_looksLikeMatchingQuiz`（≥4 项且重复≥2），放弃原因
    // `matching-or-duplicate-options` 把静默窗口拉到 30 分钟（其余原因 1 分钟）。
    var shape = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var n=app._checkPopupQuiz();' +
      'if(!n) return {noPopup:true};' +
      'var texts=app._getOptionItems(n).map(function(i){return app._extractOptionText(i);});' +
      'var out={nativeTexts:texts,nativeMatch:app._looksLikeMatchingQuiz(texts)};' +
      // 阈值那道闸不能松：只重复一次、只有两项都还是普通选择题
      'out.oneDupIsNot=app._looksLikeMatchingQuiz(["甲","乙","丙","甲"]);' +
      'out.shortIsNot=app._looksLikeMatchingQuiz(["Color","Transparency"]);' +
      'var ul=document.querySelector(".pop-quiz-options");' +
      'while(ul.firstChild)ul.removeChild(ul.firstChild);' +
      'var pair=["Color","Transparency","Color","Transparency","Color","Transparency"];' +
      'pair.forEach(function(t,k){' +
      '  var li=document.createElement("li");li.className="pop-quiz-option";' +
      '  var inp=document.createElement("input");inp.type="radio";inp.setAttribute("name","pq");' +
      '  inp.value=String.fromCharCode(65+k);' +
      '  var sp=document.createElement("span");sp.textContent=String.fromCharCode(65+k)+". "+t;' +
      '  li.appendChild(inp);li.appendChild(sp);ul.appendChild(li);});' +
      'var items2=app._getOptionItems(n);' +
      'out.builtCount=items2.length;' +
      'out.builtTexts=items2.map(function(i){return app._extractOptionText(i);});' +
      'out.builtMatch=app._looksLikeMatchingQuiz(out.builtTexts);' +
      'return out;})()'
    );
    check('夹具自证：原生弹题那 3 项文本互不重复，判据不误报成匹配题',
      !shape.noPopup &&
      JSON.stringify(shape.nativeTexts) === JSON.stringify(['说法甲', '说法乙', '说法丙']) &&
      shape.nativeMatch === false, JSON.stringify(shape));
    check('只重复一次 / 只有两项都不算匹配题（阈值是 ≥4 项且重复 ≥2）',
      shape.oneDupIsNot === false && shape.shortIsNot === false, JSON.stringify(shape));
    check('现场那种形状：左右两列被抓成 6 项、文本成对重复时认成匹配题',
      shape.builtCount === 6 && shape.builtMatch === true &&
      JSON.stringify(shape.builtTexts) === JSON.stringify(
        ['Color', 'Transparency', 'Color', 'Transparency', 'Color', 'Transparency']),
      JSON.stringify(shape));

    // 放弃那一支：必须在**发请求之前**就 return，并把这一族的静默窗口拉到 30 分钟。
    // 配置自己钉一遍（存储是整轮共用的，别依赖上一个场景写过什么）。
    var mcfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key',
      model: 'e2e-model', enableQuiz: true, enableCaptcha: false,
      enableDiscussion: false, autoNext: false
    };
    await writeConfig(ctx.extensionId, mcfg);
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(mcfg) + '); true'
    );
    var mBefore = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'window.__b42=[];window.addEventListener("message",function(ev){' +
      '  var d=ev&&ev.data;' +
      '  if(d&&d.source==="xxt_app"&&d.type==="runtime_log")' +
      '  window.__b42.push({level:String(d.level||""),msg:String(d.message||""),' +
      '    reason:String((d.meta&&d.meta.reason)||"")});});' +
      'app._popupQuizBlockedUntil=0;app._popupQuizAttempts=0;app._popupQuizKey="";' +
      'window.__b42t0=Date.now();' +
      'var n=app._checkPopupQuiz();if(n)app._handlePopupQuiz(n);' +
      'return {hasPopup:!!n};})()'
    );
    // ⚠️ `emitRuntimeLog` 走 postMessage，**异步送达**；判据跑完立刻读缓冲一定读到空，
    //    "该发的没发"和"没送到"长得一模一样 —— 等一拍，并把 seen 一起报出来。
    await sleep(400);
    var giveUp = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var ls=window.__b42||[];' +
      'return {seen:ls.length,logs:ls.slice(-6),' +
      'holdMs:Math.round((app._popupQuizBlockedUntil||0)-(window.__b42t0||0)),' +
      'attempts:app._popupQuizAttempts};})()'
    );
    check('匹配题一次模型都不问（旧逻辑连着问 6 次、每次都被判错 = 「弹题卡住」）',
      ctx.mock.requests.length === mBefore, '请求数 +' + (ctx.mock.requests.length - mBefore));
    check('放弃原因点名 matching-or-duplicate-options（说不清是哪一种就没法定位）',
      giveUp.logs.some(function (l) {
        return l.msg === 'popup quiz unanswerable, stop asking model' &&
          l.reason === 'matching-or-duplicate-options';
      }), JSON.stringify({seen: giveUp.seen, logs: giveUp.logs}));
    check('这一族的静默窗口是 30 分钟，不是其余原因的 1 分钟',
      // 带上下留 2 分钟容差：`holdMs` 拿的是**生产写进字段的那个时刻**减去我调用前
      // 记的基准，中间隔着 1~2 毫秒（实测 1800001）—— 卡死整点数只会误红。
      // 判据要区分的是「30 分钟档 vs 1 分钟档」，不是毫秒。
      giveUp.holdMs > 29 * 60000 && giveUp.holdMs < 31 * 60000, JSON.stringify(giveUp));
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
    await writeConfig(ctx.extensionId, cfg);
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

    // ---- 乱选模式下的弹题：本地生成、**不发任何请求** ----
    // 主流程的乱选已经端到端测过（逐题填 + 查隐藏域），但弹题是**独立的一份代码**
    //（`_handlePopupQuiz` 里另有一个请求点），必须单独测 —— 否则那条路出问题没人知道。
    var beforeRandom = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {enableQuiz:true, randomAnswer:true, apiKey:""});' +
      // 清掉"已答放行"与静默期，让同一道弹题能被再处理一次
      'app._popupQuizSolvedKey=""; app._popupQuizSolvedAt=0; app._popupQuizBlockedUntil=0;' +
      'app._popupQuizQuietUntil=0; app._popupQuizAttempts=0;' +
      'var ins=document.querySelectorAll(".ans-pop-quiz input");' +
      'for(var i=0;i<ins.length;i++){ins[i].checked=false;}' +
      'var n=app._checkPopupQuiz(); if(!n) return false;' +
      'return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);
    check('乱选模式下弹题**不发任何模型请求**',
      ctx.mock.requests.length === beforeRandom,
      '多发了 ' + (ctx.mock.requests.length - beforeRandom) + ' 次');

    var rqFilled = await ctx.client.evaluate(
      '(function(){var ins=document.querySelectorAll(".ans-pop-quiz input");' +
      'var checked=[];for(var i=0;i<ins.length;i++){if(ins[i].checked) checked.push(ins[i].value);}' +
      'return {checked:checked, count:ins.length};})()'
    );
    check('乱选模式下弹题真的被选上了（不是空转）',
      rqFilled && rqFilled.checked.length >= 1, JSON.stringify(rqFilled));

    // 恢复，避免影响后续断言
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs = Object.assign({}, app.configs, {randomAnswer:false}); return true;})()'
    );

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
    await writeConfig(ctx.extensionId, cfg);
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
      'document.getElementById("model").value="deepseek-flash";' +
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

    // 开关**清单**守卫：上面那条 `>= 8` 是弱下限，抓不住"某个开关被误删"。
    // 这里逐个点名 —— 少一个就红。**新增开关时要同步加进这个列表。**
    var wantToggleIds = ['enableQuiz', 'randomAnswer', 'enableCaptcha', 'enableDiscussion',
                         'autoNext', 'restudy', 'muted', 'enableSeek'];
    var uiToggles = await ctx.client.evaluate(
      '(function(){var ids=' + JSON.stringify(wantToggleIds) + ';var miss=[];' +
      'for(var i=0;i<ids.length;i++){if(!document.getElementById(ids[i])) miss.push(ids[i]);}' +
      'return {missing:miss};})()'
    );
    check('关键开关按 id 逐个都在（抓"误删某个开关"）',
      uiToggles && uiToggles.missing.length === 0, JSON.stringify(uiToggles));

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

    // 「复制日志」：把日志拼成**纯文本**给用户粘贴。
    // ⚠️ 测的是 `buildLogsText` 这个**纯函数**，不是"点按钮看剪贴板" ——
    //    无头环境里 `navigator.clipboard.writeText` 可能因缺少用户手势而被拒，
    //    拿它当断言会得到一条时好时坏的测试。
    var copied = await ctx.client.evaluate(
      '(function(){' +
      'if(typeof buildLogsText!=="function")return {missing:true};' +
      'var logs=[' +
      '{level:"info",time:1700000000000,message:"study begin",meta:{attachments:2}},' +
      '{level:"warn",time:1700000001000,message:"search job: every candidate frame was rejected",' +
      'meta:{frames:6,rejects:[{src:"/wq-outer-A",reason:"取不到 jobid"}]}}' +
      '];' +
      'return {text:buildLogsText(logs,"9.9.9")};})()'
    );
    check('「复制日志」把日志拼成纯文本（带版本与条数）',
      !!copied && !copied.missing &&
      copied.text.indexOf('Omitone 诊断日志（版本 9.9.9）') !== -1 &&
      copied.text.indexOf('共 2 条') !== -1 &&
      copied.text.indexOf('study begin') !== -1 &&
      copied.text.indexOf('[warn]') !== -1,
      JSON.stringify(copied).slice(0, 200));
    check('「复制日志」把 meta 也带上（诊断信息就在 meta 里）',
      !!copied && copied.text.indexOf('every candidate frame was rejected') !== -1 &&
      copied.text.indexOf('/wq-outer-A') !== -1,
      JSON.stringify(copied && copied.text).slice(0, 200));
    check('「复制日志」按钮真的在界面上（不是只有函数）',
      (await ctx.client.evaluate('!!document.getElementById("copyLogs")')) === true);

    // ---- 批次 31：保存失败要说清为什么（线上 issue #1）----
    // 症状：macOS 上后台脚本起不来时，弹窗一直只弹一句「无法保存配置」，日志面板同时是空的。
    // 原因是后台已经把 "Could not establish connection…" 带回来了，但界面把它丢掉，
    // 只剩四个字 —— 用户据此只能猜「是不是我操作不对」，猜不到「去扩展页点重新加载」。
    // 这里钉三层：文案逐码点名 / 真链路能把原因送到界面 / 长句完整可读且停留够久。
    var mapText = await ctx.client.evaluate(
      '(function(){var f=self.saveFailureText;' +
      'if(typeof f!=="function")return {missing:true};' +
      'return {missing:false,' +
      'swDead:f({success:false,error:"Could not establish connection. Receiving end does not exist."}),' +
      'port:f({success:false,error:"Message port closed before a response was received."}),' +
      'timeout:f({success:false,error:"配置保存超时"}),' +
      'sender:f({success:false,code:"forbidden_sender"}),' +
      'senderWhy:f({success:false,code:"forbidden_sender",error:"popup-deny:frame:4"}),' +
      'patched:f({success:false,code:"forbidden_patch"}),' +
      'invalid:f({success:false,code:"invalid_patch",field:"model"}),' +
      'unknown:f({success:false,code:"unknown_message"}),' +
      'stale:f({success:false,code:"stale_config"})};})()'
    );
    check('前提：saveFailureText 在弹窗里可调用', !mapText.missing, JSON.stringify(mapText));
    check('后台没起来 / 端口关闭 / 保存超时都翻成「后台脚本没响应」并给出重载+F5',
      ['swDead', 'port', 'timeout'].every(function (k) {
        return /后台脚本没响应/.test(mapText[k]) && /重新加载/.test(mapText[k]) && /F5/.test(mapText[k]);
      }), JSON.stringify(mapText));
    check('五个失败码逐个点名原因（不许再共用一句「配置保存失败」）',
      /没认出这是设置弹窗/.test(mapText.sender) && /不允许从这里改/.test(mapText.patched) &&
      /值不合法/.test(mapText.invalid) && /model/.test(mapText.invalid) &&
      /版本对不上/.test(mapText.unknown) && /配置已变化/.test(mapText.stale), JSON.stringify(mapText));
    // 同学机器那次「保存全被拒」最难的不是修，是**看不见**：界面只说"没认出来"，
    // 到底缺 frameId、tab.url 还是 URL 对不上，一个字都没有，只能来回猜。
    // 现在后台把形状一起带回来，界面原样钉在括号里，用户复制日志就能发出来。
    check('「没认出这是设置弹窗」把缺的那一样说出来，并指到图标那条路',
      /popup-deny:frame:4/.test(mapText.senderWhy) && /没认出这是设置弹窗/.test(mapText.senderWhy) &&
      /右上角的图标/.test(mapText.senderWhy), JSON.stringify(mapText));
    check('后台没给形状时不硬凑空括号',
      mapText.sender.indexOf('（') === -1 && /右上角的图标/.test(mapText.sender), JSON.stringify(mapText));

    // 真链路 ①：不合法的值由**真后台**拒掉，断言它给的 code 与字段名真的走进了界面文案。
    var realInvalid = await ctx.client.evaluate(
      '(function(){return patchConfig({__e2e_bogus_field:1}).then(' +
      'function(){return {ok:true};},' +
      'function(e){return {ok:false,msg:String(e&&e.message||""),code:String((e&&e.code)||"")};});})()'
    );
    check('真后台拒绝不合法设置项时，抛出的那句点名「保存被拒」和具体字段',
      realInvalid.ok === false && realInvalid.code === 'invalid_patch' &&
      /保存被拒/.test(realInvalid.msg) && /__e2e_bogus_field/.test(realInvalid.msg),
      JSON.stringify(realInvalid));

    // 真链路 ②：把「和后台说话」那一层换成现场那种 lastError 形状（后台脚本没注册），
    // 验的是 patchConfig 的接线而不是文案函数本身 —— 否则改坏转发也照样绿。
    var swDead = await ctx.client.evaluate(
      '(function(){var orig=self.sendRuntimeMessageWithTimeout;' +
      'self.sendRuntimeMessageWithTimeout=function(){' +
      'return Promise.resolve({success:false,error:"Could not establish connection. Receiving end does not exist."});};' +
      'return patchConfig({enableQuiz:true}).then(function(){' +
      'self.sendRuntimeMessageWithTimeout=orig;return {ok:true};},' +
      'function(e){self.sendRuntimeMessageWithTimeout=orig;' +
      'return {ok:false,msg:String(e&&e.message||""),code:String((e&&e.code)||"")};});})()'
    );
    check('后台无连接时 patchConfig 抛出的就是那句可执行的下一步（不是「配置保存失败」）',
      swDead.ok === false && /后台脚本没响应/.test(swDead.msg) && !/配置保存失败/.test(swDead.msg),
      JSON.stringify(swDead));

    var toastState = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var el=document.getElementById("toast");var cs=self.getComputedStyle(el);' +
      'reportSaveError(new Error("后台脚本没响应 —— 到扩展页点「重新加载」，再回学习通页按 F5"));' +
      'var shownNow=el.classList.contains("show");' +
      'setTimeout(function(){res({shownNow:shownNow,stillShown:el.classList.contains("show"),' +
      'text:el.textContent,whiteSpace:cs.whiteSpace,overflow:cs.overflow,' +
      'radius:cs.borderRadius,height:Math.round(el.getBoundingClientRect().height)});},2400);});})()'
    );
    check('失败提示至少停留 2.4 秒（原来 1.6 秒就消失，读不到字等于没反馈）',
      !!toastState && toastState.shownNow === true && toastState.stillShown === true,
      JSON.stringify(toastState));
    check('长句完整可读：不换行、不省略、也不再挤成一颗胶囊',
      !!toastState && toastState.text.indexOf('后台脚本没响应') !== -1 &&
      toastState.whiteSpace === 'normal' && toastState.overflow !== 'hidden' &&
      toastState.radius.indexOf('999') === -1, JSON.stringify(toastState));

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
    await writeConfig(ctx.extensionId, cfg);
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
    await writeConfig(ctx.extensionId, cfg);
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
// 看门狗的判据：要判「**多久没有进展**」，不能判「tick 活了多久」
//
// 为什么单独立一个场景：看门狗原先判 `now - _tickStartedAt > 150000`，而
// PPT 音频任务的单页等待上限是 **600 秒**（40-media.js 的 _waitSlideAudioDone）——
// 正常干活的长任务会被误判成卡死，强行放锁后**新旧两个 tick 并行操作同一个任务点**。
//
// 两条断言必须**成对**：少了「有进展 → 不放锁」那条，"永不触发"这种改法也能通过
// 「无进展 → 放锁」；少了后者，把看门狗整个删掉也能通过前者。
// ===========================================================================
SCENARIOS.push({
  name: '看门狗：按“无进展”而非“总时长”判卡死',
  path: '/quiz',
  run: async function (ctx) {
    // ⚠️ 必须先停掉页面里**真实的** tick 循环再注入状态。
    //    否则它每 250ms 跑一次 _runTick，而 _runTick 开头会把 _tickProgressAt 重置成
    //    "现在" —— 我们拨回去的时间戳会被立刻覆盖，于是"真挂起"那条断言假失败。
    //    （第一版就栽在这里：断言报 running:true / progress=当前时间，看起来像产品 bug，
    //      其实是注入被真实循环冲掉了。）
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'if(a._tickLoopInterval){clearInterval(a._tickLoopInterval);a._tickLoopInterval=null;}' +
      'if(a._checkInterval){clearInterval(a._checkInterval);a._checkInterval=null;}' +
      'a._tickRunning=false;a._assertActive=function(){return true;};' +
      'return true;})()'
    );
    await sleep(300);

    // 把 tick 装成"已经跑了很久"的样子 —— 旧的判据只看这个就会立刻放锁
    var setup = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'if(!a._startTickLoop) return {noMethod:true};' +
      'a._tickRunning=true;' +
      'a._tickStartedAt=Date.now()-200000;' +          // 已跑 200 秒（> 150 秒看门狗线）
      'a._tickProgressAt=Date.now();' +                // 但刚刚才刷过心跳
      'a._tickEpoch=100;' +
      'return {epoch:a._tickEpoch,running:a._tickRunning};})()'
    );
    check('场景装配成功（造出“跑了 200 秒但刚有心跳”的 tick）',
      setup && setup.epoch === 100 && setup.running === true, JSON.stringify(setup));

    // 只重启**看门狗本身**（setInterval 那段），不让 _runTick 参与 ——
    // 这样测的是纯判据，不受真实调度干扰。
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'a._runTick=function(){return Promise.resolve();};' +   // 空 tick：不重置心跳
      'a._startTickLoop();' +
      'return !!a._tickLoopInterval;})()'
    );

    // ---- ① 有进展 → 不该放锁 ----
    // 心跳持续刷新（模拟长任务在正常推进）。等过看门狗的检查周期（250ms × 数轮）。
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;var n=0;' +
      'a.__hbTimer=setInterval(function(){a._tickProgressAt=Date.now();n++;},100);' +
      'a.__hbCount=function(){return n;};return true;})()'
    );
    await sleep(1500);
    var alive = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;return {running:a._tickRunning,epoch:a._tickEpoch,hb:a.__hbCount()};})()'
    );
    check('长任务持续有进展时，看门狗**不**放锁（否则正常任务被误杀）',
      alive && alive.epoch === 100 && alive.hb > 0, JSON.stringify(alive));

    // ---- ② 无进展 → 必须放锁 ----
    // 停掉心跳，把「进度」和「开始时间」都拨回 200 秒前（模拟真挂起）。
    // ⚠️ 两个都拨：判据是 `_tickProgressAt || _tickStartedAt`，只拨一个会被另一个兜住。
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;clearInterval(a.__hbTimer);' +
      'a._tickProgressAt=Date.now()-200000;' +
      'a._tickStartedAt=Date.now()-200000;' +
      'a._tickRunning=true;' +
      'return {progress:a._tickProgressAt,started:a._tickStartedAt};})()'
    );
    var tripped = await waitFor(ctx.client, 'window._xxtApp._tickEpoch > 100', 5000);
    var after = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;return {running:a._tickRunning,epoch:a._tickEpoch,started:a._tickStartedAt,progress:a._tickProgressAt};})()'
    );    check('真挂起（心跳停 > 150 秒）时看门狗仍然放锁（防线没有被放松）',
      tripped === true && after.epoch > 100, JSON.stringify(after));
    check('放锁时同时清掉 _tickRunning（循环才能恢复）',
      after && after.running === false, JSON.stringify(after));

    // ---- ③ 心跳被清空时，必须回落到 _tickStartedAt 兜底 ----
    // 为什么需要这条：①② 只覆盖"心跳新鲜"与"心跳陈旧"，
    // **判据里那个 `|| _tickStartedAt` 兜底没有任何断言守着** —— 把它删掉
    // （写成 `self._tickProgressAt > ...`）会让"心跳字段还没初始化"的 tick
    // 永久逃过看门狗。这条专门锁这个兜底。
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'a._tickProgressAt=0;' +                    // 心跳字段为空（未初始化 / 被清掉）
      'a._tickStartedAt=Date.now()-400000;' +     // 开始时间也很久（远超 150 秒）
      'a._tickRunning=true;a._tickEpoch=200;' +
      'return true;})()'
    );
    var fallback = await waitFor(ctx.client, 'window._xxtApp._tickEpoch > 200', 5000);
    check('心跳字段为空时仍按 _tickStartedAt 兜底放锁（兜底分支不能删）',
      fallback === true, 'tickEpoch 未超过 200 → 兜底分支失效');

    // ---- ④ 唯一的判据分界点：跑很久 + 心跳新 → 必须**不**放锁 ----
    // 这条与 ② 组合起来，才能唯一确定"判的是心跳而不是总时长"：
    //   旧判据（只看 _tickStartedAt）→ 这条会红
    //   看门狗整个失效              → ② 会红
    // 所以两条缺一不可。（实测：把判据改回 `_tickStartedAt` 时，只有这条会红。）
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;' +
      'a._tickStartedAt=Date.now()-400000;' +     // 已经跑了 400 秒（远超 150 秒）
      'a._tickProgressAt=Date.now();' +           // 但"刚刚"才有进展
      'a._tickRunning=true;a._tickEpoch=300;' +
      'return true;})()'
    );
    await sleep(1500);   // 熬过看门狗好几个检查周期
    var notKilled = await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;return {epoch:a._tickEpoch,running:a._tickRunning};})()'
    );
    check('“跑了很久但一直在推进”的 tick 不被误杀（判据确实是心跳，不是总时长）',
      notKilled && notKilled.epoch === 300, JSON.stringify(notKilled));

    // 收尾：恢复被改掉的 _runTick / 停掉看门狗，别影响后面的场景
    await ctx.client.evaluate(
      '(function(){var a=window._xxtApp;clearInterval(a.__hbTimer);' +
      'if(a._tickLoopInterval){clearInterval(a._tickLoopInterval);a._tickLoopInterval=null;}' +
      'a._tickRunning=false;a._tickStartedAt=0;a._tickProgressAt=0;a._tickEpoch=0;' +
      'return true;})()'
    );
  }
});

/** ---- 28. 一张卡片两份测验：第二份也要被匹配到并答 ---- */
SCENARIOS.push({
  name: '一张卡片两份测验：第二份也要被匹配到并答',
  path: '/two-quizzes',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      autoNext: false,
      restudy: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(400);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    // ---- ① 装配 ----
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var card=app._getMainDocument();' +
      'return {hasMainDoc:!!card,' +
      'wraps:card?card.querySelectorAll(".ans-attach-ct").length:-1,' +
      'attachments:app._getChaoxingAttachments().length};})()'
    );
    check('场景装配：卡片页 + 两个任务点外层容器就位',
      setup && setup.hasMainDoc === true && setup.wraps === 2, JSON.stringify(setup));
    check('两个任务点都在附件清单里（否则后面的匹配无从谈起）',
      setup && setup.attachments === 2, JSON.stringify(setup.attachments));

    // ---- ② 核心：跨层找 jobid ----
    // 三层里**没有一层**同时具备「有 jobid」和「有 .TiMu」。
    // 只认本层 data 的实现会把三层全部 continue 掉 → 返回 null → 整章被静默跳过。
    //
    // ⚠️ 配置与判定必须在**同一次 evaluate 里**做完：
    //    前面场景留下的 `_quizApiFailUntil`（45 秒退避）或页面重新注入换掉的
    //    app 实例，都会让"答题 API 可用"这个前置条件在两次调用之间翻转 ——
    //    实测踩过：分开写时它返回 true，于是整个匹配分支被硬守卫跳过。
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'var reason=app._getQuizApiUnavailableReason();' +
      'var cardDoc=app._safeWinDoc(app._getMainWindow());' +
      'var frames=app._searchIFramesOcs(cardDoc).map(function(f){' +
      '  var d=app._safeDocOf(f);' +
      '  var aid="";try{aid=app._findJobIdInAncestorFrames(f.contentWindow);}catch(e){aid="(抛错)";}' +
      '  return {src:String(f.getAttribute("src")||"").slice(0,26),' +
      '    tiMu:d?d.querySelectorAll(".TiMu").length:-1,ancestorJobId:aid,' +
      '    ownData:String(f.getAttribute("data")||"").slice(0,24)};' +
      '});' +
      'var j=app._searchChaoxingJobOcs([]);' +
      'var out={apiReason:reason,apiUnavailable:!!reason,frames:frames,matched:null};' +
      'if(j){' +
      '  var ownData="";' +
      '  try{ownData=String(j.win.frameElement.getAttribute("data")||"");}catch(e){ownData="(取不到)";}' +
      '  out.matched={jobid:j.jobid,name:j.name,kind:j.kind,workType:j.workType,' +
      '    hasFunc:typeof j.func==="function",ownDataEmpty:ownData==="",' +
      '    timuCount:j.doc?j.doc.querySelectorAll(".TiMu").length:-1};' +
      '}' +
      'return out;})()'
    );
    check('前置条件：答题 API 可用（否则匹配分支会被硬守卫跳过）',
      probe && probe.apiUnavailable === false, JSON.stringify(probe && probe.apiReason));

    var matched = (probe && probe.matched) || null;
    check('三层嵌套下仍能匹配到任务点（旧实现返回 null → 整个任务点被静默漏掉）',
      !!matched, JSON.stringify(probe));
    if (!matched) return;

    check('跳过已完成的第一份、挑中未完成的第二份',
      matched.jobid === 'work-B', JSON.stringify(matched));
    check('命中的是**有题目的那一层**（.TiMu 在它这里）',
      matched.timuCount === 2, JSON.stringify(matched.timuCount));
    check('这一层自己的 data 是空的 —— jobid 确实取自祖先帧而不是本层',
      matched.ownDataEmpty === true, JSON.stringify(matched));
    check('匹配结果带可执行的 func（能被调度真正跑起来）',
      matched.hasFunc === true, JSON.stringify(matched.hasFunc));

    // 对照：一条祖先链上都没有 jobid 时必须返回空串，不能瞎猜一个
    var noId = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var w=app._getMainDocument().defaultView;' +
      'return String(app._findJobIdInAncestorFrames(w));})()'
    );
    check('找不到 jobid 时返回空串（不能瞎猜一个身份）',
      noId === '', JSON.stringify(noId));

    // ---- ③ 按份数状态：同一张卡片里换卷子必须把"已答"清掉 ----
    var switched = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'app._quizAnswered=true; app._quizRunPaperKey="work-A";' +
      'app._quizCurrentQuestions=[{title:"上一份卷子的题"}];' +
      'var jobB=app._searchChaoxingJobOcs([]);' +
      'var docB=jobB?jobB.doc:null;' +
      'var ret=app._syncQuizPaperRunState("work-B", docB);' +
      'return {ret:ret, answered:app._quizAnswered, key:app._quizRunPaperKey,' +
      'questions:app._quizCurrentQuestions, hasDocB:!!docB};})()'
    );
    check('换到第二份卷子时"已答"被清掉（否则 _handleQuiz 第一行就 return）',
      switched && switched.hasDocB === true && switched.ret === true &&
      switched.answered === false && switched.key === 'work-B',
      JSON.stringify(switched));
    check('换卷子时同时清掉上一份"手里的题"（防止拿 A 卷的题去填 B 卷）',
      switched && switched.questions === null, JSON.stringify(switched && switched.questions));

    // ---- ④ 同一份卷子重复调用 = 空操作（防重复提交）----
    var again = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizAnswered=true; app._quizRunPaperKey="work-B";' +
      'var ret=app._syncQuizPaperRunState("work-B", null);' +
      'return {ret:ret, answered:app._quizAnswered};})()'
    );
    check('同一份卷子内部重复调用不重置（否则会绕过"已答"判定、重复提交）',
      again && again.ret === false && again.answered === true, JSON.stringify(again));

    // ---- ⑤ 认不出身份时什么都不做 ----
    var unknown = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizAnswered=true; app._quizRunPaperKey="work-B";' +
      'var ret=app._syncQuizPaperRunState("", null);' +
      'return {ret:ret, answered:app._quizAnswered, key:app._quizRunPaperKey};})()'
    );
    check('拿不到身份键时什么都不做（宁可沿用，也不能因此把已答状态清掉重答一遍）',
      unknown && unknown.ret === false && unknown.answered === true && unknown.key === 'work-B',
      JSON.stringify(unknown));

    // ---- ⑥ 保险：换过去那份本来就已完成时，重新置回"已答" ----
    var toFinished = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizAnswered=false; app._quizRunPaperKey="work-B";' +
      'var docA=null;' +
      'try{var fr=app._getMainDocument().querySelector("#tp-a iframe");' +
      'var midDoc=fr.contentDocument.querySelector("iframe").contentDocument;' +
      'docA=midDoc.querySelector("iframe").contentDocument;}catch(e){docA=null;}' +
      'var ret=app._syncQuizPaperRunState("work-A", docA);' +
      'return {ret:ret, answered:app._quizAnswered, hasDoc:!!docA};})()'
    );
    check('换到一份"本来就已完成"的卷子时重新置回已答（不把交过的卷子当新卷子重答）',
      toFinished && toFinished.hasDoc === true && toFinished.ret === true && toFinished.answered === true,
      JSON.stringify(toFinished));

    // ---- ⑦ 身份键不能来自 src ----
    // 真实页面上两个任务点的外层帧 src **完全相同**（身份只在 data 里），
    // 用 src 当键会让两份卷子看起来是同一份 → "换卷子重置"永远不触发 → bug 复发。
    var keys = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var sameSrc="/ananas/modules/work/index.html?v=2025-1028-1629&castscreen=0";' +
      'var a=app._getQuizPaperKeyFromTask({src:sameSrc,dataText:JSON.stringify({_jobid:"work-A"})});' +
      'var b=app._getQuizPaperKeyFromTask({src:sameSrc,dataText:JSON.stringify({_jobid:"work-B"})});' +
      'var c=app._getQuizPaperKeyFromTask({src:sameSrc,dataText:""});' +
      'return {a:a,b:b,c:c};})()'
    );
    check('身份键取自 data 而不是 src（两个任务点 src 相同 → 用 src 会认成同一份）',
      keys && keys.a === 'work-A' && keys.b === 'work-B' && keys.a !== keys.b, JSON.stringify(keys));
    check('取不到身份时返回空串（交给 _syncQuizPaperRunState 做"什么都不做"）',
      keys && keys.c === '', JSON.stringify(keys && keys.c));

    // ---- ⑧ 容器里的 jobid 必须**属于本帧**，不能拿走兄弟任务点的 ----
    // 为什么单列这条：`_findJobIdInAncestorFrames` 在"本层没有 jobid"时会去看外层容器，
    // 而容器里可能有**两个**帧。把兄弟帧的 jobid 当成本帧身份 = 去跑**错的任务点**，
    // 比"匹配不到"严重得多（匹配不到只是漏做，绑错是做错）。
    // 这里动态造一个"一个容器里两个帧"的结构：兄弟帧带 jobid，本帧没有 → 必须返回空串。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var card=app._getMainDocument();' +
      'var wrap=card.createElement("div");wrap.className="ans-attach-ct";wrap.id="tp-decoy";' +
      'var sib=card.createElement("iframe");sib.setAttribute("jobid","work-DECOY");sib.src="/wq-mid-B";' +
      'var mine=card.createElement("iframe");mine.id="decoy-inner";mine.src="/wq-inner-B";' +
      'wrap.appendChild(sib);wrap.appendChild(mine);card.body.appendChild(wrap);' +
      'return true;})()'
    );
    await waitFor(ctx.client, '!!(document.querySelector("#decoy-inner") && document.querySelector("#decoy-inner").contentDocument && document.querySelector("#decoy-inner").contentDocument.querySelector(".TiMu"))', 8000);
    var decoy = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var mine=app._getMainDocument().querySelector("#decoy-inner");' +
      'var loaded=!!(mine&&mine.contentDocument&&mine.contentDocument.querySelector(".TiMu"));' +
      'var got="";try{got=String(app._findJobIdInAncestorFrames(mine.contentWindow));}catch(e){got="(抛错)";}' +
      'var sib=app._getMainDocument().querySelector("#tp-decoy iframe[jobid]");' +
      'return {loaded:loaded, got:got, siblingJobId:sib?sib.getAttribute("jobid"):""};})()'
    );
    check('容器里的 jobid 属于兄弟帧时**不能**当成本帧身份（否则会去跑错的任务点）',
      decoy && decoy.loaded === true && decoy.siblingJobId === 'work-DECOY' && decoy.got === '',
      JSON.stringify(decoy));

    // 收尾：把这份卷子的状态还原，并拆掉上面临时造的结构，别影响后面的场景
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizAnswered=false; app._quizRunPaperKey=""; app._quizCurrentQuestions=null;' +
      'var d=app._getMainDocument().querySelector("#tp-decoy"); if(d&&d.parentNode) d.parentNode.removeChild(d);' +
      'return true;})()'
    );
  }
});

/**
 * ---- 一张卡片两份测验（**变体**）：jobid 挂在容器 div 上、iframe 上什么都不写 ----
 *
 * 这条盯的是 `_findJobIdInAncestorFrames` 里那段"jobid 在任务点外层容器上"的处理。
 * 注释说这在真实页面上**很常见**，但判据写成 `wrap.querySelector('[jobid]')` ——
 * 而 **`querySelector` 只找后代、永远返回不了 `wrap` 自己**，
 * 于是 `holder === wrap` 这个条件**不可达**：jobid 写在容器 div 上时一个都找不到。
 *
 * 症状与用户报过的那个**一模一样**：匹配不到任务点 → 整章被静默跳过。
 */
SCENARIOS.push({
  name: 'jobid 挂在容器 div 上也要能找到',
  path: '/two-quizzes-divjob',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      autoNext: false,
      restudy: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(400);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    // 配置与判定必须在**同一次 evaluate 里**做完（理由见上一条场景的注释：
    // 分开写时 `_quizApiFailUntil` 会在两次调用之间翻转，匹配分支被硬守卫跳过）
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'var cardDoc=app._safeWinDoc(app._getMainWindow());' +
      'var frames=app._searchIFramesOcs(cardDoc).map(function(f){' +
      '  var aid="";try{aid=app._findJobIdInAncestorFrames(f.contentWindow);}catch(e){aid="(抛错)";}' +
      '  return {src:String(f.getAttribute("src")||"").slice(0,22),' +
      '    iframeJobId:String(f.getAttribute("jobid")||""),' +
      '    wrapJobId:String((f.parentElement&&f.parentElement.getAttribute("jobid"))||""),' +
      '    ancestorJobId:aid};' +
      '});' +
      'var j=app._searchChaoxingJobOcs([]);' +
      'var out={frames:frames,matched:null};' +
      'if(j){out.matched={jobid:j.jobid,name:j.name,kind:j.kind};}' +
      'return out;})()'
    );

    // 前置条件：这一版 mock 必须**真的是**"jobid 只在 div 上、iframe 干净" ——
    // 否则这条场景就退化成和上一条一样的结构，测不到想测的东西
    var outer = ((probe && probe.frames) || []).filter(function (f) { return f.wrapJobId; });
    check('前置条件：jobid 只在容器 div 上、iframe 上没有（本变体的全部意义所在）',
      outer.length === 2 && outer.every(function (f) { return !f.iframeJobId; }),
      JSON.stringify(probe && probe.frames));

    check('容器 div 上的 jobid 能被 _findJobIdInAncestorFrames 认出来',
      outer.length === 2 && outer.every(function (f) { return f.ancestorJobId === f.wrapJobId; }),
      JSON.stringify(outer));

    var matched = (probe && probe.matched) || null;
    check('整条链路仍能匹配到任务点（认不出 → 返回 null → 整章被静默跳过）',
      !!matched, JSON.stringify(probe));
    if (!matched) return;
    check('跳过已完成的第一份、挑中未完成的第二份（work-B）',
      matched.jobid === 'work-B', JSON.stringify(matched));

    // ⚠️ 光"匹配上"还不够：任务真正开跑时还要**从 job 反查回它的帧**
    //    （`_runChaoxingJob` → `_resolveJobFrame`）。这条路径读 jobid 的方式
    //    如果和上面那个查找函数不一致，就会出现"匹配得上、却跑不起来"。
    var resolved = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var atts=app._getChaoxingAttachments();' +
      'var att=null;' +
      'atts.forEach(function(a){if(!att&&String(a.jobid||"")==="work-B")att=a;});' +
      'if(!att)return {noAttachment:true};' +
      'var job=app._buildAttachmentOnlyJob(att);' +
      'var before=!!(job.frame&&job.doc);' +
      'app._resolveJobFrame(job);' +
      'return {jobid:String(job.jobid||""),before:before,hasFrame:!!job.frame,hasDoc:!!job.doc};})()'
    );
    check('前置条件：这个 job 一开始确实没有帧（否则测不到反查那一步）',
      !!resolved && resolved.before === false, JSON.stringify(resolved));
    check('jobid 挂在容器 div 上时，_resolveJobFrame 也能把任务反查回帧（否则匹配上了却跑不起来）',
      !!resolved && resolved.hasFrame === true && resolved.hasDoc === true,
      JSON.stringify(resolved));
  }
});

/**
 * ---- 模块页 <script> 里含「任务点已完成」时，卷子不能被误判成已完成 ----
 *
 * 复刻 2026-10-17 用户现场：`work` 模块页的平台无障碍代码里写着
 *     jobIconDiv.set({'aria-label': '任务点已完成'});
 * 而 `textOf()` 原先写的是 `innerText || textContent` —— **可见文本为空**时回落
 * `textContent`，**把脚本源码也算成页面文字**。于是整份卷子被判成「已完成」：
 *   静默跳过 → 搜不到任务点 → 判「本页做完」→ 点下一节（页面推不动）→ 空转死循环。
 *
 * 报告的症状就是用户的「跳过题目卡住」。反向验证：把 `textOf` 的回落改回
 * `textContent`，本场景必须变红。
 */
SCENARIOS.push({
  name: '模块页脚本里的「任务点已完成」不能把卷子判成已完成',
  path: '/decoy-top',
  run: async function (ctx) {
    var cfg = {
      apiType: 'openai',
      apiUrl: 'http://127.0.0.1:' + PORT,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      enableQuiz: true,
      autoNext: false,
      restudy: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(400);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'var cardDoc=app._safeWinDoc(app._getMainWindow());' +
      'var frames=app._searchIFramesOcs(cardDoc);' +
      'var paper=null;' +
      'frames.forEach(function(f){try{if(!paper&&f.contentWindow.document.querySelectorAll(".TiMu").length)paper=f.contentWindow.document;}catch(e){}});' +
      'var out={frameCount:frames.length,hasPaper:!!paper};' +
      'if(paper){' +
      '  out.isDocumentFrameFinished=app._isDocumentFrameFinished(paper);' +
      '  out.isQuizPassedOrFinished=app._isQuizPassedOrFinished(paper);' +
      '  var wrap=paper.defaultView.frameElement.parentElement;' +
      '  out.wrapInnerTextLen=String(wrap.innerText||"").length;' +
      '  out.wrapTextContentHasKeyword=(String(wrap.textContent||"")).indexOf("任务点已完成")!==-1;' +
      '}' +
      'var j=app._searchChaoxingJobOcs([]);' +
      'out.matched=j?{jobid:j.jobid,kind:j.kind,name:String(j.name||"").slice(0,20)}:null;' +
      'return out;})()'
    );

    check('前置条件：mock 里确实有卷子（否则这条测的不是这件事）',
      !!probe && probe.hasPaper === true, JSON.stringify(probe));

    // 这两个是"复刻是否忠实"的自证：可见文本为空 → 一定会走回落分支 → 而脚本里确实有那句
    check('前置条件：模块页可见文本为空、但 textContent 里含「任务点已完成」（正是踩坑的形状）',
      !!probe && probe.wrapInnerTextLen === 0 && probe.wrapTextContentHasKeyword === true,
      JSON.stringify(probe));

    check('卷子没有被判成「已完成」（脚本源码不算页面文字）',
      !!probe && probe.isDocumentFrameFinished === false && probe.isQuizPassedOrFinished === false,
      JSON.stringify(probe));

    check('任务点仍能被搜出来并指向 work-D（而不是静默跳过 → 整章被推过去）',
      !!probe && !!probe.matched && probe.matched.jobid === 'work-D' && probe.matched.kind === 'quiz',
      JSON.stringify(probe && probe.matched));
  }
});

/**
 * ---- 同一页挂两个讨论时，不能因为"第一个已经做过"就把第二个也放弃 ----
 *
 * 现场（2026-10-17）：一页 1 个题目 + 2 个讨论。做完第一个讨论和题目之后，
 * **第二个讨论被晾着**，直接点下一节走了。
 *
 * 根因：`_findDiscussionTask` 三条路径都只返回"第一个"候选，而调用方写的是
 *     if (this._isDiscussionDone(task.key)) return false;
 * —— 一看"这个做过了"就**整体放弃**，第二个永远轮不到。
 * 修法：在**查找阶段**就跳过已经发过的（三条路径各补一处），
 * 调用方那句保留当兜底。
 */
SCENARIOS.push({
  name: '第一个讨论做过之后，第二个讨论还能被找到',
  path: '/discussion-two',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'var targets=app._collectDiscussionTargets();' +
      'if(!targets.length) return {targets:0};' +
      // 把"第一个"标成已发过 —— 等价于上一次真的把评论发出去了
      'app._markDiscussionDone(targets[0].key);' +
      'var task=await app._findDiscussionTask();' +
      'return {' +
      '  targets:targets.length,' +
      '  firstDone:app._isDiscussionDone(targets[0].key),' +
      '  gotKey:task?String(task.key).slice(0,28):null,' +
      '  sameAsFirst:!!task&&String(task.key)===String(targets[0].key)' +
      '};})()'
    );

    check('前置条件：这一页有多个讨论候选（否则这条测的不是这件事）',
      !!probe && probe.targets >= 2, JSON.stringify(probe));
    check('第一个讨论确实被标成"已发过"',
      !!probe && probe.firstDone === true, JSON.stringify(probe));
    check('第二个讨论仍能被找到（旧实现返回同一个 → 调用方直接放弃 → 整页只剩它没做）',
      !!probe && !!probe.gotKey && probe.sameAsFirst === false, JSON.stringify(probe));
  }
});

/**
 * ---- 讨论页报"发失败"时，刷课页必须把"已做"标记撤掉 ----
 *
 * 现场（2026-10-17）：讨论页在 `groupweb.chaoxing.com`、刷课页在 `mooc1.chaoxing.com` ——
 * **两个不同的 localStorage**。所以"在讨论页里撤销标记"撤的是它自己那份空存储，
 * 对刷课页毫无作用：发失败一次，这个讨论就被静默跳过 24 小时。
 * 修法：讨论页用 `postMessage` 告诉刷课页，由刷课页撤标记（最多重试 3 次）。
 */
SCENARIOS.push({
  name: '讨论发失败时刷课页要撤销"已做"标记',
  path: '/discussion-two',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'var targets=app._collectDiscussionTargets();' +
      'if(!targets.length) return {targets:0};' +
      'var key=String(targets[0].key);' +
      'app._markDiscussionDone(key);' +
      'app._discussionLastOpenedKey=key;' +
      'app._bindDiscussionOutcome();' +
      'var before=app._isDiscussionDone(key);' +
      // 模拟讨论页跨域发来的"没发成"消息
      'window.postMessage({omitoneDiscussion:"failed"}, "*");' +
      'await new Promise(function(r){setTimeout(r,80);});' +
      'return {targets:targets.length, before:before, after:app._isDiscussionDone(key)};' +
      '})()'
    );
    check('前置条件：这一页有讨论候选', !!probe && probe.targets >= 1, JSON.stringify(probe));
    check('前置条件：标记确实写进去了', !!probe && probe.before === true, JSON.stringify(probe));
    check('收到"发失败"消息后标记被撤销（否则这个讨论会被静默跳过 24 小时）',
      !!probe && probe.after === false, JSON.stringify(probe));
  }
});

/**
 * ---- 任务盒的 class 才是平台的说法：三张讨论卡里那张没做完的必须被认出来 ----
 *
 * 现场（2026-11-11，章节 9000049219）：用户肉眼看到"这一节只剩一个讨论没完成"，
 * 插件却宣布"本节讨论都做完了"→ 点下一节 → 平台回一句「当前章节还有任务点未完成」→ 原地转圈。
 *
 * 量出来的根因：这一族讨论卡所在文档里 `#isFinished` 是**空值**（`finishedKnown` 读不出结论），
 * 而平台真正的判据写在**任务盒** `.ans-attach-ct` 的 class 上（带 `ans-job-finished` = 已完成）。
 * 更阴的是图标 `aria-label`：实测连已完成的盒子也写着「任务点未完成」——所以夹具把这三份坏 aria
 * 照抄下来，下面那条"读 aria 会把三张全读成没做完"的自证一断言，谁改用 aria 就会红。
 * 盒子在卡片的**上两层 frame**，因此 `_discussionBoxFinishedFlag` 要沿 frameElement 往上爬。
 */
SCENARIOS.push({
  name: '讨论完成与否以任务盒 class 为准（#isFinished 空值时不再宣布全做完）',
  path: '/disc-box',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      // 夹具自己钉住它依赖的共享状态：上一个场景往扩展 storage 写过 enableDiscussion:false，
      // `_discussionPendingInfo` 会在生产判据第一行就短路成 {pending:0,source:"disabled"}，
      // 表现成"一条日志都没有、断言全红"（AGENTS §5）。
      'app.configs=app.configs||{};app.configs.enableDiscussion=true;' +
      'function reset(){app._discussionPendingCache=null;app._discussionOpenedAt=0;app._discussionWindow=null;' +
      '  app._discussionHoldSinceAt=0;app._discussionHoldKey="";app._discussionHoldSpent=0;}' +
      'try{localStorage.removeItem(app._discussionStoreKey);}catch(e){}' +
      // 夹具自证：三个讨论盒的 aria 全写「任务点未完成」，只有 class 说了真话
      'var aria=[];' +
      'function walk(doc,d){if(!doc||d>4)return;' +
      '  try{Array.prototype.forEach.call(doc.querySelectorAll(".ans-attach-ct"),function(b){' +
      // 只数讨论盒的 aria —— 作业盒不在这次实测结论里，混进来这条自证就说不了它想说的话
      '    if(!/讨论/.test(String(b.innerText||"")))return;' +
      '    var i=null;try{i=b.querySelector(".ans-job-icon");}catch(e){}' +
      '    aria.push(String((i&&i.getAttribute("aria-label"))||""));});}catch(e){}' +
      '  try{Array.prototype.forEach.call(doc.querySelectorAll("iframe"),function(f){' +
      '    try{walk(f.contentDocument,d+1);}catch(e){}});}catch(e){}}' +
      'walk(document,0);' +
      'var targets=app._collectDiscussionTargets();' +
      'var keys={};targets.forEach(function(t){keys[String(t.key)]=1;});' +
      'var todo=targets.filter(function(t){return !t.finished;})[0]||null;' +
      'var r={' +
      '  n:targets.length, unique:Object.keys(keys).length,' +
      '  flags:targets.map(function(t){return (t.finished?"D":"U")+(t.finishedKnown?"k":"?");}),' +
      '  ariaBad:aria.filter(function(s){return /未完成/.test(s);}).length,' +
      '  ariaGood:aria.filter(function(s){return /已完成/.test(s);}).length,' +
      '  todoKey:todo?String(todo.key):null,' +
      '  flagOfNonBox:(function(){try{return String(app._discussionBoxFinishedFlag(document.body));}catch(e){return "ERR";}})()' +
      '};' +
      // ① 一张都没记过账：pending 必须是 1（旧实现读不出标志 → 这里是 0，整节被放走）
      'reset();r.p1=app._discussionPendingInfo();r.h1=app._shouldHoldDiscussionBeforeFinish();' +
      // ② 刚记过账（<90 秒）：不烧自愈额度，也先不锁整节 —— 给平台时间刷新
      'if(todo){app._markDiscussionDone(todo.key);}' +
      'r.healFresh=todo?app._discussionHealEligible(todo):null;' +
      'reset();r.p2=app._discussionPendingInfo();' +
      // ③ 记过账但 3 分钟后平台仍说没做完 → 允许重来，且"重开发帖"与"宣布完成"必须同口径
      'if(todo){try{var m=app._discussionDoneMap();m[todo.key]=Date.now()-180000;' +
      '  localStorage.setItem(app._discussionStoreKey,JSON.stringify(m));}catch(e){}}' +
      'r.healOld=todo?app._discussionHealEligible(todo):null;' +
      'reset();r.p3=app._discussionPendingInfo();r.h3=app._shouldHoldDiscussionBeforeFinish();' +
      'var task=await app._findDiscussionTask();' +
      'r.taskKey=task?String(task.key):null;' +
      // ④ 额度烧尽（3 次）后不再无限自愈：这时才允许放走，且理由要说得出口
      'if(todo){try{var mm=app._discussionDoneMap();mm[todo.key]=Date.now()-180000;' +
      '  localStorage.setItem(app._discussionStoreKey,JSON.stringify(mm));}catch(e){}' +
      '  for(var q=0;q<3;q++){app._bumpDiscussionTry(todo.key);}}' +
      'r.healSpent=todo?app._discussionHealEligible(todo):null;' +
      'reset();r.p4=app._discussionPendingInfo();' +
      'return r;})()'
    );

    check('前置条件：三层 frame 走到底，收到 3 张讨论卡且键互不重复',
      !!probe && probe.n === 3 && probe.unique === 3, JSON.stringify(probe));
    check('夹具自证：三个盒子的 aria 全写「任务点未完成」（读 aria 会把已完成的两张也读成没做完）',
      !!probe && probe.ariaBad >= 3 && probe.ariaGood === 0, JSON.stringify(probe && probe.ariaBad) + '/' + JSON.stringify(probe && probe.ariaGood));
    check('三张卡各自的答案都读得出来（finishedKnown=true），且只有一张未完成',
      !!probe && probe.flags.length === 3 && probe.flags.filter(function (s) { return s === 'Uk'; }).length === 1 &&
      probe.flags.filter(function (s) { return s === 'Dk'; }).length === 2, JSON.stringify(probe && probe.flags));
    check('没记过账时这一节按住不放（旧实现此处 pending=0 → 直接点下一节 → 平台拒）',
      !!probe && probe.p1 && probe.p1.pending === 1 && probe.p1.source === 'cards' &&
      probe.h1 && probe.h1.hold === true, JSON.stringify(probe && [probe.p1, probe.h1]));
    check('卡片所在文档的 #isFinished 是空值时改读任务盒：非任务盒元素返回 null（读不出＝没说，不是"没做完"）',
      !!probe && probe.flagOfNonBox === 'null', JSON.stringify(probe && probe.flagOfNonBox));
    check('刚发过（<90 秒）不烧自愈额度', !!probe && probe.healFresh === false, JSON.stringify(probe && probe.healFresh));
    check('平台仍说没做完 + 已超时 → 允许重来一次', !!probe && probe.healOld === true, JSON.stringify(probe && probe.healOld));
    check('"重开发帖"与"按住这一节"同口径：pending=1、hold=true、找到的就是那张卡',
      !!probe && probe.p3 && probe.p3.pending === 1 && probe.h3 && probe.h3.hold === true &&
      probe.taskKey === probe.todoKey, JSON.stringify(probe && [probe.p3, probe.h3, probe.taskKey, probe.todoKey]));
    check('额度烧尽（3 次）后不再无限自愈，放走时 pending 归 0',
      !!probe && probe.healSpent === false && probe.p4 && probe.p4.pending === 0, JSON.stringify(probe && [probe.healSpent, probe.p4]));
  }
});

/**
 * ---- 「当前章节还有任务点未完成，是否去完成？」只能点「去学习」----
 *
 * 现场（2026-11-11，同一章节）：这道门弹出时，旧的通用弹窗清理按文案点了「下一节」——
 * 平台当场把同一句话再弹一次，页面就在原地转圈（用户看到的"卡住"）。
 * 修法两处：这道门由 `_handleUnfinishedTaskPrompt` 单独管（优先 onclick 里的 `scroll2Job`），
 * 通用循环遇到它整块跳过；**认出门但找不到「去学习」也返回 true**，宁可原地等也不点「下一节」。
 * 夹具把两种形状都放进去：可见的 `.maskDiv.jobFinishTip`（真页面那种）与隐藏的 `#jobFinishTip.AlertCon02`
 * （通用循环本来会在这里点到「下一节」的那族），onclick 逐字照抄真页面。
 */
SCENARIOS.push({
  name: '「还有任务点未完成」这道门只点「去学习」，绝不点「下一节」',
  path: '/unfinished-prompt',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'function C(){return {pre:window.__pre||0,next:window.__next||0,job:window.__job||0,' +
      '  next2:window.__next2||0,job2:window.__job2||0,scroll:window.__scroll2JobCalls||0,' +
      '  nextReal:window.__nextReal||0};}' +
      // 计数器是累计的，断言要的是"这一步点没点" —— 每步都取增量，否则下一步的 0 其实是上一步的 1
      'function D(a,b){var o={};for(var k in b)o[k]=b[k]-a[k];return o;}' +
      'function show(which){' +
      '  var m=document.querySelector(".maskDiv.jobFinishTip");var h=document.getElementById("jobFinishTip");' +
      '  if(m)m.style.display=(which==="mask")?"":"none";' +
      '  if(h)h.style.display=(which==="alert")?"":"none";}' +
      'var r={};' +
      'show("mask");app._unfinishedPromptClickedAt=0;var b0=C();' +
      'r.handled=app._dismissPopups();r.dMask=D(b0,C());' +
      // 冷却：这道门每 3 秒扫一次，20 秒内不许把页面来回滚
      'var b1=C();r.handledAgain=app._dismissPopups();r.dCool=D(b1,C());' +
      // 另一种形状（隐藏的 #jobFinishTip.AlertCon02）——通用循环以前正是在这里点到「下一节」
      'show("alert");app._unfinishedPromptClickedAt=0;var b2=C();' +
      'r.handledAlert=app._dismissPopups();r.dAlert=D(b2,C());' +
      // 门还在、但「去学习」这一族没有：必须认出门并返回 true，且一个键都不许点
      'Array.prototype.forEach.call(document.querySelectorAll("a"),function(a){' +
      '  if(/去学习|去完成/.test(a.textContent||"")){if(a.parentNode)a.parentNode.removeChild(a);}});' +
      'show("mask");app._unfinishedPromptClickedAt=0;var b3=C();' +
      'r.handledNoJob=app._dismissPopups();r.dNoJob=D(b3,C());' +
      'show("alert");app._unfinishedPromptClickedAt=0;var b4=C();' +
      'r.handledNoJobAlert=app._dismissPopups();r.dNoJobAlert=D(b4,C());' +
      // 夹具自证：这两道门确实长得像现场（文案 + 「下一节」在容器内可见）
      'r.promptVisible=!!(function(){var b=document.querySelector(".maskDiv.jobFinishTip");' +
      '  return b&&/还有任务点未完成/.test(b.innerText||"");})();' +
      'return r;})()'
    );

    check('可见那道门走「去学习」（onclick 里的 scroll2Job 优先于文案）',
      !!probe && probe.handled === true && probe.dMask.job === 1 && probe.dMask.scroll === 1,
      JSON.stringify(probe && [probe.handled, probe.dMask]));
    check('「下一节」一次都没被点（真页面这里点一次＝平台再弹同一段话，原地转圈）',
      !!probe && probe.dMask.next === 0 && probe.dMask.pre === 0 && probe.dMask.nextReal === 0 &&
      probe.dAlert.next2 === 0 && probe.dNoJob.next === 0 && probe.dNoJobAlert.next2 === 0,
      JSON.stringify(probe && [probe.dMask, probe.dAlert, probe.dNoJob, probe.dNoJobAlert]));
    check('隐藏的 #jobFinishTip.AlertCon02 那种形状也只点「去学习」',
      !!probe && probe.dAlert.job2 === 1 && probe.dAlert.next2 === 0, JSON.stringify(probe && probe.dAlert));
    check('20 秒冷却：第二次扫到这道门不再点第二下',
      !!probe && probe.dCool.job === 0 && probe.handledAgain === true,
      JSON.stringify(probe && [probe.dCool, probe.handledAgain]));
    check('门里没有任何「去学习」时仍然认得出这道门（返回 true），且一个键都不点',
      !!probe && probe.handledNoJob === true && probe.handledNoJobAlert === true &&
      probe.dNoJob.next === 0 && probe.dNoJob.pre === 0 &&
      probe.dNoJobAlert.next2 === 0, JSON.stringify(probe && [probe.handledNoJob, probe.dNoJob, probe.dNoJobAlert]));
    check('夹具自证：这道门的文案与形状就是现场那种', !!probe && probe.promptVisible === true, JSON.stringify(probe));
  }
});

/**
 * ---- 弹窗的「检查更新」----
 *
 * 判断"要不要更新"靠两条：版本号更高，或**同一版本号里换过包**
 * （后者依赖 `version_name` 里的构建戳，形如 `1.2.8 b20261019-1400`）。
 * 这里把 `fetch` 换掉，把两条路都走一遍：
 *   ① 线上版本更高 → 提示「有新版本」并亮出「去下载」
 *   ② 网络失败 → 不下结论（不瞎说"已是最新"），但也要把下载入口亮出来
 */
SCENARIOS.push({
  name: '弹窗检查更新：有新版本要提示，网络失败也要给下载入口',
  url: 'chrome-extension://{EXT}/popup/popup.html',
  inject: false,
  run: async function (ctx) {
    // 弹窗一打开自己就会真实请求一次 api.github.com（24 小时一次的自动检测）。
    // 这条真实请求什么时候落地不可控 —— 挂了梯子、或全套跑里机器正忙，它拖到几秒后，
    // 回调就会把 mock 点出来的「有最新版 9.9.9」盖成「与线上一致」：
    // 表现成「单独跑永远绿、只有全套里闪一下红」（实测 2026-11-11，开梯子后必现）。
    // 上一版改成「等文案自己稳定下来」，赌的还是那个不可控的时间。
    // 现在直接掐掉源头：限流时间戳是唯一的开关 —— 把 autoAt 写成「刚刚查过」再重载弹窗，
    // 自动检测这一轮整跳过，断言不再和真实网络抢时间（也不再白烧匿名额度）。
    await ctx.client.evaluate(
      'try{localStorage.setItem("omitone.update.autoAt",String(Date.now()));' +
      'localStorage.setItem("omitone.update.manualAt","0");}catch(e){};1');
    await ctx.client.evaluate('location.reload()').catch(function () {});
    // 等**脚本执行完**，不是等元素出现：popup.html 的 #checkUpdate 在第 558 行、
    // popup.js 挂在第 804 行（body 末尾）。按解析顺序，元素先有、监听器后挂 ——
    // 只轮询 `getElementById` 就正好落在这个缝里：点击送到按钮（自己挂的监听数得到），
    // 但应用那个 handler 还没挂上，第①步 6 秒毫无变化、第②步却又好了。
    // readyState==="complete" 一定在所有同步脚本执行完之后，这条判据把缝关掉。
    var readyBy = Date.now() + 8000;
    while (Date.now() < readyBy && !(await ctx.client.evaluate(
      'document.readyState==="complete" && !!document.getElementById("checkUpdate")'))) await sleep(200);
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var out={hasBtn:!!document.getElementById("checkUpdate"),hasMsg:!!document.getElementById("updateMsg")};' +
      'if(!out.hasBtn) return out;' +
      'var readMsg=function(){return String((document.getElementById("updateMsg")||{}).textContent||"");};' +
      'var nap=function(ms){return new Promise(function(r){setTimeout(r,ms);});};' +
      'var setAt=function(k,v){try{localStorage.setItem(k,String(v));}catch(e){}};' +
      // 每一步都「记下点之前的文案 → 点 → 等文案变（最多 6 秒）→ 再取快照」，
      // 不赌固定时长：上一请求的回调什么时候插进来是不可预期的。
      'var clickAndWait=async function(){var before=readMsg();' +
      '  document.getElementById("checkUpdate").click();' +
      '  for(var i=0;i<60;i++){await nap(100);if(readMsg()!==before)break;}' +
      '  await nap(150);return readMsg();};' +
      // ① 线上版本更高
      'var calls=0;' +
      // 现场自证：这一步红的时候，光看 higherMsg 分不开「按钮被禁用、点击没进函数」
      // 与「进了函数但被限流闸挡住」与「mock 压根没接上」—— 先把三样都记下来。
      'out.before={msg:readMsg(),disabled:!!document.getElementById("checkUpdate").disabled,' +
      '  manualAt:String(localStorage.getItem("omitone.update.manualAt")||""),' +
      '  autoAt:String(localStorage.getItem("omitone.update.autoAt")||"")};' +
      // 点击到底有没有送到那个按钮？自己挂一个监听，让下面第①步的那一次真实点击来触发它：
      // 若自己也数到了、而应用毫无反应，说明应用那个 handler 根本没挂上（或挂在别的节点上）
      'var btn=document.getElementById("checkUpdate");var mine=0;' +
      'btn.addEventListener("click",function(){mine++});' +
      'window.fetch=function(){calls++;return Promise.resolve({ok:true,json:function(){' +
      'return Promise.resolve({tag_name:"v9.9.9",assets:[{name:"omitone.zip",updated_at:new Date().toISOString()}]});}});};' +
      'out.higherMsg=await clickAndWait();' +
      'out.probe={mine:mine,calls1:calls,disabledAfter:btn.disabled};' +
      'out.btnLabel=String((document.getElementById("doUpdate")||{}).textContent||"");' +
      'out.higherBtn=getComputedStyle(document.getElementById("doUpdate")).display!=="none";' +
      // ② 网络失败 —— 刚才那次成功已经把限流计时了，先手动放行，否则测的是闸、不是失败文案
      'setAt("omitone.update.manualAt",0);' +
      'window.fetch=function(){calls++;return Promise.reject(new Error("offline"));};' +
      'out.failMsg=await clickAndWait();' +
      'out.failBtn=getComputedStyle(document.getElementById("doUpdate")).display!=="none";' +
      // ③ 限流真的在挡：刚查过的 6 小时里再点，一个请求都不发，只说什么时候再来
      'out.callsBefore=calls;' +
      'out.gatedMsg=await clickAndWait();' +
      'await nap(200);out.callsAfter=calls;' +
      'return out;})()'
    );
    check('前置条件：弹窗里有「检测更新」和结果文字',
      !!probe && probe.hasBtn === true && probe.hasMsg === true, JSON.stringify(probe));
    // 夹具自证：第①步那次点击要真的走进应用（自己的监听数到、且 mock 的 fetch 被调用）。
    // 没有这条，「按钮点了没反应」和「限流挡住」和「响应文案不对」三种红长得一模一样 ——
    // 上一轮红就红在这儿：readyState 还没到 complete 就开点，handler 根本没挂上。
    check('夹具自证：那一次点击真的走进了应用（不是点了个还没挂监听的空按钮）',
      !!probe && probe.probe && probe.probe.mine >= 1 && probe.probe.calls1 >= 1,
      JSON.stringify(probe && probe.probe));
    check('线上版本更高 → 说清有最新版并问「是否更新」（不是直接替人下结论）',
      !!probe && /有最新版\s*9\.9\.9/.test(String(probe.higherMsg)) &&
      /是否更新/.test(String(probe.higherMsg)) && probe.higherBtn === true,
      JSON.stringify(probe));
    check('按钮是「是，覆盖更新」（更新是覆盖，不是装个新的）',
      !!probe && /覆盖/.test(String(probe.btnLabel)), JSON.stringify(probe));
    check('查不出来 → 文案里**不能**出现「最新版」这类结论；下载入口仍保留',
      !!probe && String(probe.failMsg).indexOf('最新') === -1 && probe.failBtn === true,
      JSON.stringify(probe));
    check('限流是功能不是摆设：刚查过再点，一个请求都不发，且说清什么时候再来',
      !!probe && /刚查过/.test(String(probe.gatedMsg)) && /后再来/.test(String(probe.gatedMsg)) &&
      probe.callsBefore === probe.callsAfter, JSON.stringify(probe));
  }
});

/**
 * ---- 同一个版本号里换过包：容差必须盖住「构建 → 上传」那几分钟 ----
 *
 * 现场（2026-11-12，同学机器）：他从下载页的 zip 装的，装完就提示「线上的包比本地新 —— 是否更新？」，
 * 而那个"更新"就是他手上这一份。判据本身没错（同版本号换包要能发现），
 * 错在容差：旧代码只留 60 秒，而**上传永远晚于构建** ——
 * 实测三次 1.2.8 差 3 分钟、1.2.9 差 5 分钟、1.3.0 差 3 分钟。
 * 作者这台机器看不出来，是因为他直接加载源码目录，`version_name` 里没有构建戳，
 * 那条判据压根不走 —— 又一个"只有装出来的用户才会撞上"的形状。
 *
 * 这里把 `chrome.runtime.getManifest` 换成带戳的现场形状（e2e 装的是源码目录，真戳不存在），
 * 然后用真按钮、真限流闸跑两条：差 3 分钟不算更新，差 2 天算更新。
 */
SCENARIOS.push({
  name: '同版本号换包：构建到上传的几分钟不算更新，隔两天才算',
  url: 'chrome-extension://{EXT}/popup/popup.html',
  inject: false,
  run: async function (ctx) {
    // 自动检测会真打 api.github.com，回调落点不可控 —— 先掐掉源头（上一场景同一手法）
    await ctx.client.evaluate(
      'try{localStorage.setItem("omitone.update.autoAt",String(Date.now()));' +
      'localStorage.setItem("omitone.update.manualAt","0");}catch(e){};1');
    var out = await ctx.client.evaluate(
      '(async function(){' +
      'var nap=function(ms){return new Promise(function(r){setTimeout(r,ms);});};' +
      'for(var i=0;i<40;i++){if(document.readyState==="complete"&&typeof self.checkUpdate==="function")break;await nap(100);}' +
      'var o={ready:document.readyState,fn:typeof self.checkUpdate};' +
      'if(o.fn!=="function")return o;' +
      // 现场形状：本机这份是 1.3.0、构建于 2026-11-12 20:37（本地时间）
      'var real=chrome.runtime.getManifest;' +
      'chrome.runtime.getManifest=function(){return {version:"1.3.0",version_name:"1.3.0 b20261112-2037"};};' +
      'var read=function(){return String((document.getElementById("updateMsg")||{}).textContent||"");};' +
      'var btnShown=function(){var b=document.getElementById("doUpdate");' +
      '  return !!b&&getComputedStyle(b).display!=="none";};' +
      'var mockAt=function(minutesLater){' +
      '  var t=new Date(2026,10,12,20,37,0).getTime()+minutesLater*60000;' +
      '  window.fetch=function(){return Promise.resolve({ok:true,json:function(){' +
      '    return Promise.resolve({tag_name:"v1.3.0",assets:[{name:"omitone.zip",updated_at:new Date(t).toISOString()}]});}});};' +
      '};' +
      // ① 构建后 3 分钟上传 —— 就是他下的那个包，不能报更新
      'mockAt(3);' +
      'try{await self.checkUpdate({manual:true});}catch(e){o.err1=String(e);}' +
      'o.gap3=read();o.gap3Btn=btnShown();' +
      // ② 两天后重新换过包 —— 这次必须报，容差不能把真更新也吞掉
      // （第一次调用已经把 manualAt 写成"刚刚"，不限流闸放开就直接撞进「刚查过」那条文案）
      'try{localStorage.setItem("omitone.update.manualAt","0");}catch(e){}' +
      'chrome.runtime.getManifest=function(){return {version:"1.3.0",version_name:"1.3.0 b20261110-0900"};};' +
      'mockAt(3);' +
      'try{await self.checkUpdate({manual:true});}catch(e){o.err2=String(e);}' +
      'o.gap2d=read();o.gap2dBtn=btnShown();' +
      'chrome.runtime.getManifest=real;' +
      'return o;})()'
    );
    check('前提：弹窗脚本已接管（checkUpdate 可调）',
      !!out && out.fn === 'function' && out.ready === 'complete', JSON.stringify(out));
    check('同版本号、线上包只比本地构建晚 3 分钟 → 说「已是最新版」，不亮更新按钮',
      !!out && /已经是最新版/.test(String(out.gap3)) && out.gap3Btn === false, JSON.stringify(out));
    check('同版本号、线上包晚两天 → 仍然报「线上的包比本地新」并亮出按钮（容差没把真更新吞掉）',
      !!out && /线上的包比本地新/.test(String(out.gap2d)) && out.gap2dBtn === true, JSON.stringify(out));
  }
});

/**
 * ---- 旧版本留下的"已发过"标记，不能把讨论永久挡住 ----
 *
 * 现场（2026-10-17）：旧逻辑发失败也记"已发"，标记 24 小时才过期，
 * 用户那几页讨论就再也扫不到了。不能指望用户去敲 `xxtAI.clearDiscussionDone()`，
 * 所以加了两层自愈：
 *   ① 平台仍说"这个讨论没完成"、且标记超过 90 秒 → 允许重试（最多 3 次）；
 *   ② 升级到 schema 2 时把旧名单**整体作废一次**。
 */
SCENARIOS.push({
  name: '讨论"已发过"标记作废后能重扫（升级自愈）',
  path: '/discussion-two',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'var targets=app._collectDiscussionTargets();' +
      'if(!targets.length) return {targets:0};' +
      'var key=String(targets[0].key);' +
      // 模拟"旧版本留下的标记"：2 分钟前记成已发，而平台（mock）仍说未完成
      'var map=app._discussionDoneMap(); map[key]=Date.now()-120000;' +
      'localStorage.setItem(app._discussionStoreKey, JSON.stringify(map));' +
      'var before=app._isDiscussionDone(key);' +
      'var task=await app._findDiscussionTask();' +
      'var healed=!!task && String(task.key)===key;' +
      // 升级迁移：schema 没记录过 → 旧名单整体作废
      'app._migrateDiscussionDoneOnce();' +
      'var afterMigrate=Object.keys(app._discussionDoneMap()).length;' +
      'return {targets:targets.length, before:before, healed:healed, afterMigrate:afterMigrate};' +
      '})()'
    );
    check('前置条件：这一页有讨论候选', !!probe && probe.targets >= 1, JSON.stringify(probe));
    check('前置条件：那条"已发过"标记确实还在', !!probe && probe.before === true, JSON.stringify(probe));
    check('平台说没完成 + 标记已过期 → 仍能重新排进待做（旧实现会被它永久挡住）',
      !!probe && probe.healed === true, JSON.stringify(probe));
    check('升级后旧名单被整体作废一次（不需要用户手敲命令）',
      !!probe && probe.afterMigrate === 0, JSON.stringify(probe));
  }
});

/**
 * ---- 编辑区"没填进去"时，不能把空编辑区当成"提交成功" ----
 *
 * 现场（2026-10-17）：一页 3 个讨论，**第一个的回复从没发出去**却记成已做，
 * 后面两个正常。根因：`_discussionSuccessHint` 的第 3 条判据是"编辑区被清空" ——
 * 而内容**压根没填进去**时编辑区本来就是空的，一点提交就"确认成功"。
 * 修法：这条判据必须以"确认填进去过"（`_discussionFilledOk`）为前提。
 *
 * 本场景直接钉住这个误报：
 *   ① 编辑区为空 + 没确认填充 → 必须**不**算成功（旧实现算成功）
 *   ② 编辑区为空 + 确认填充过 → 仍算成功（这条判据本身不能被废掉）
 */
SCENARIOS.push({
  name: '编辑区没填进去时不能误判成提交成功',
  path: '/discussion',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var ed=app._findDiscussionEditor();' +
      'if(!ed) return {noEditor:true};' +
      'ed.value="";' +
      'app._discussionBefore=app._discussionBaseline();' +
      'app._discussionFilledOk=false;' +          // 模拟"填不进去"
      'var withoutFill=app._discussionSuccessHint();' +
      'app._discussionFilledOk=true;' +           // 正常路径：确认填过
      'var withFill=app._discussionSuccessHint();' +
      'return {noEditor:false, withoutFill:withoutFill, withFill:withFill};})()'
    );
    check('前置条件：讨论页找得到回复编辑器', !!probe && probe.noEditor !== true, JSON.stringify(probe));
    check('内容没填进去过 → 空编辑区**不能**算成功（旧实现会误判 → 这条讨论被记成已做却从没发出）',
      !!probe && probe.withoutFill === false, JSON.stringify(probe));
    // 这条是本次的真因：页面有回复列表、条目却没多出来，而只是"编辑区空了" ——
    // 旧实现会判成功（默认回复是 "1"，文本匹配也近乎恒真），于是发失败也被记成已做。
    check('有回复列表但条目没多 → 即使填过、编辑区也空了，仍**不能**算成功（旧实现会误判）',
      !!probe && probe.withFill === false, JSON.stringify(probe));
  }
});

/**
 * ---- 交完卷之后不能一直卡在"还有题要做" ----
 *
 * 现场（2026-10-17）：某章的卷子交完（日志有 `quiz submit finished`）之后，
 * 调度器在**整整 6 分钟**里反复打印 `study matched job {kind:"quiz"}`，
 * 一次都没再答题、也不往下走 —— 用户看到的就是"答题一直卡住"。
 *
 * 根因：`_handleQuiz` 第一行 `if (_quizAnswered || _quizInProgress) return;` 直接不干活，
 * 而 `_isQuizLearningPending` 因为"提交按钮还挂在页面上"仍说"还有题要做"。
 * 两个判据互相矛盾 → 调度器每秒把同一份卷子交给它、它每秒空转，永远不前进。
 *
 * 修法：`_isQuizLearningPending` 里**自己刚答过就直接说"没有了"**（除非平台明确要求重做）。
 */
SCENARIOS.push({
  name: '交完卷之后不能一直卡在"还有题要做"',
  path: '/quiz',
  run: async function (ctx) {
    // ⚠️ 必须**真的写一次配置**，不能只在页面里改 `app.configs.apiKey`：
    //   `_getQuizApiUnavailableReason()` 看的是 `configs.hasApiKey`，那个字段只有走
    //   `writeConfig` 这条路才会被置上。原先这条场景靠**别的场景留在存储里的配置**才通过 ——
    //   单独定向跑它就变成 apiDown:true → 前置条件红（2026-11-10 批次 7 就踩到了）。
    //   场景之间不许共享存储状态，否则顺序一动就满屏假警。
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key',
      model: 'e2e-model', enableQuiz: true, enableCaptcha: false,
      enableDiscussion: false, autoNext: false
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);

    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'var doc=app._resolveQuizSubmitDocument(null)||app._getMainDocument();' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizSubmitPending=false;' +
      'var before=app._isQuizLearningPending(doc);' +
      'var dbg={forceSkip:app._isQuizForceSkipping(doc),apiDown:app._isQuizApiUnavailable(),' +
      'monitor:app._monitorQuizSubmit(doc),passed:app._isQuizPassedOrFinished(doc),' +
      'redo:app._isQuizRedoRequired(doc),form:app._hasActiveQuizSubmitForm(doc),' +
      'detect:app._detectQuiz(),docTag:doc?String(doc.title||""):"(null)"};' +
      'app._quizAnswered=true;' +                 // 模拟"刚交完卷"
      'var after=app._isQuizLearningPending(doc);' +
      'return {before:before, after:after, dbg:dbg};})()'
    );
    check('前置条件：这一页确实"还有题要做"（否则测的不是这件事）',
      !!probe && probe.before === true, JSON.stringify(probe));
    check('刚交完卷（_quizAnswered=true）→ 不能再算"还有题要做"（否则调度器会一直空转，实测卡过 6 分钟）',
      !!probe && probe.after === false, JSON.stringify(probe));
  }
});

/**
 * ---- 任务点全被拒时，日志必须说明"卡在哪一条" ----
 *
 * 这个查找函数的失败**没有任何报错**：返回 null，然后整章被 `nextUnit()` 推过去。
 * 现场日志原先只有一句 `searchedCount: 0` —— 知道"没匹配上"，
 * 但**不知道卡在哪一条**（帧认不出？取不到 jobid？jobid 不在附件清单里？），只能靠人猜。
 * 用户报过的「两个大题目只做第一个」当初就是这么查的。
 *
 * 做法：把 `window.attachments` 换成**对不上的 jobid**，
 * 于是每一帧都会在"jobid 不在附件清单里"那一条被拒 —— 然后检查日志有没有说清楚。
 */
SCENARIOS.push({
  name: '任务点全被拒时日志要说明原因',
  path: '/two-quizzes-divjob',
  run: async function (ctx) {
    var probe = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var got=[];' +
      'window.addEventListener("message",function(e){' +
      '  var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log") got.push(m);});' +
      // 换成对不上的 jobid → 每一帧都会在"jobid 不在附件清单里"被拒
      'window.attachments=[{jobid:"other-1",property:{_jobid:"other-1",jobid:"other-1",mid:"m1",name:"无关任务点",module:"work",type:"work"}}];' +
      'var app=window._xxtApp;' +
      'var r="(未调用)";try{r=app._searchChaoxingJobOcs([]);}catch(e){r="(抛错)";}' +
      'setTimeout(function(){' +
      '  var hit=null;' +
      '  got.forEach(function(m){if(m.message==="search job: every candidate frame was rejected")hit=m;});' +
      '  res({result:r,hit:hit,logCount:got.length});' +
      '},300);});})()'
    );

    check('前置条件：一个任务点都匹配不到（返回 null）',
      probe && probe.result === null, JSON.stringify(probe && probe.result));

    var hit = probe && probe.hit;
    check('日志里出现了「每一帧都被拒」并带上逐帧原因（否则现场只能靠猜）',
      !!hit && Array.isArray(hit.meta && hit.meta.rejects) && hit.meta.rejects.length > 0,
      JSON.stringify(hit && hit.meta).slice(0, 300));

    var reasons = ((hit && hit.meta && hit.meta.rejects) || [])
      .map(function (x) { return String(x.reason || ''); }).join(' | ');
    check('原因具体到「jobid 在附件清单里找不到」，而不是一句笼统的"没匹配到"',
      reasons.indexOf('在附件清单里找不到') !== -1, reasons.slice(0, 200));

    var srcs = ((hit && hit.meta && hit.meta.rejects) || [])
      .map(function (x) { return String(x.src || ''); }).join(' | ');
    check('原因里带上了是哪一帧（src），便于对着页面定位',
      srcs.indexOf('/wq-outer-') !== -1, srcs.slice(0, 200));
  }
});

/**
 * ---- 批次 35 ①：主内容帧跨域（同站墙）时，整页刷新必须有预算 ----
 *
 * 现场（同学那边「看不到下面那个录音，然后卡死了，我们的又能刷」）：顶层还是课程页，
 * `#iframe` 被平台换成**同站另一台机器**，JS 读不到里面。旧实现这时每 20 秒 `location.reload()`
 * 一次、**永远刷不完** —— 因为"已经刷过几次"记在页面内存里，而自己那一下刷新正好把它抹掉。
 * 页面下方那些任务点永远来不及渲染出来，看上去就是"插件在发呆、页面一直在跳"。
 *
 * ⚠️ 这里的"一页的一生"是**手工造**的（内存计数归零 + 墙已挂 21 秒），不是真刷 6 次：
 *   真刷一次整页会打断后面的步骤，而最贵的动作本身就是被测对象 —— 与 14-A 验证码墙同一做法。
 *   "预算确实活得过一次真刷新"由**另一条场景**单独证（见下面 ③），两条合起来才闭合。
 */
SCENARIOS.push({
  name: '主内容帧跨域时整页刷新有预算（同站墙）',
  path: '/blocked-same-site',
  run: async function (ctx) {
    // 必须等帧真的导航到跨域地址上：没导航完时它还是可读的 about:blank，判据会空测
    var unreadable = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a&&a._getMainFrame();' +
      'return !!f&&!a._isFrameSameOrigin(f);})()', 12000);

    var setup = JSON.parse(await ctx.client.evaluate(
      '(function(){' +
      'var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var KEY="omitone:blocked-reload-budget";' +
      'var w={lives:0,reloads:0,got:[]};' +
      'window.__blockedWall=w;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")w.got.push(m);});' +
      'w.read=function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}")||{};}catch(e){return {};}};' +
      'w.seed=function(reloads,resumeAt){try{sessionStorage.setItem(KEY,JSON.stringify(' +
      '  {reloads:reloads,resumeAt:resumeAt,href:String(location.href||"")}));}catch(e){}};' +
      'w.metas=function(name){return w.got.filter(function(m){return m.message===name;})' +
      '  .map(function(m){return m.meta||{};});};' +
      // 刷新换成计数器盯住（它与 14-A 的 `_reloadForStandaloneCaptcha` 是同一个理由）
      'app._reloadBlockedPage=function(){w.reloads++;};' +
      'w.life=function(cfg){w.lives++;app._crossOriginLogAt=0;' +
      '  app.configs=Object.assign({},app.configs,cfg||{});' +
      '  app._mainFrameCrossOriginSince=Date.now()-21000;' +
      '  var blocked=app._checkBlockedByCrossOrigin();' +
      '  return JSON.stringify({blocked:blocked,reloads:w.reloads,budget:w.read()});};' +
      'var f=app._getMainFrame(),o=app._frameOriginOf(f);' +
      'return JSON.stringify({seam:typeof app._reloadBlockedPage==="function",' +
      '  loopStopped:!app._tickLoopInterval&&!app._tickRunning, ' +
      '  readable:app._isFrameSameOrigin(f),srcOrigin:o,sameSite:app._isFrameSameSiteAsTop(o),' +
      '  topHost:String(location.hostname||""),ready:String(document.readyState)});})()'
    ));

    check('夹具自证：#iframe 是**同站不同源**、JS 真的读不到它（否则整条场景是空测）',
      unreadable === true && setup.readable === false && setup.sameSite === true &&
      setup.seam === true && setup.ready === 'complete' &&
      setup.loopStopped === true &&
      setup.topHost === 'mooc1.chaoxing.com' &&
      /^http:\/\/mooc2\.chaoxing\.com:\d+$/.test(String(setup.srcOrigin)),
      JSON.stringify(setup));

    var lives = [];
    for (var k = 0; k < 6; k++) {
      lives.push(JSON.parse(await ctx.client.evaluate('window.__blockedWall.life()')));
    }
    // 关掉暂停、只把开关拨到"不刷新"，再走一轮 —— 否则这一轮会被上一轮的暂停挡着，
    // 测的就不是开关，而是预算（AGENTS §5：一条断言只破一件事）
    await ctx.client.evaluate('window.__blockedWall.seed(0,0)');
    var switchOff = JSON.parse(
      await ctx.client.evaluate('window.__blockedWall.life({blockedReload:false})'));
    await sleep(400);   // 日志走 postMessage，不等一拍读到的是空缓冲
    var ledger = JSON.parse(await ctx.client.evaluate(
      '(function(){var w=window.__blockedWall;return JSON.stringify({' +
      'blocked:w.metas("blocked page unreachable from JS, reload to recover"),' +
      'spent:w.metas("blocked page reload round spent, pausing reloads"),' +
      'every:w.metas("main frame unreadable")});})()'
    ));

    check('每一轮都判「这一页被挡住、本轮不继续跑」（返回 true = tick 提前收手）',
      lives.every(function (l) { return l.blocked === true; }) && switchOff.blocked === true,
      JSON.stringify(lives.map(function (l) { return l.blocked; })));

    check('一轮 3 次刷完就收手：第 4 轮起一次都不再刷（旧写法是每 20 秒刷一次、永远刷不完）',
      lives[0].reloads === 1 && lives[1].reloads === 2 && lives[2].reloads === 3 &&
      lives[3].reloads === 3 && lives[4].reloads === 3 && lives[5].reloads === 3,
      JSON.stringify(lives.map(function (l) { return l.reloads; })));

    check('刷新账本按页累加：第 1 / 2 / 3 轮各写下一次（不是每次都从 0 开始）',
      Number(lives[0].budget.reloads) === 1 && Number(lives[1].budget.reloads) === 2 &&
      Number(lives[2].budget.reloads) === 3,
      JSON.stringify(lives.slice(0, 3).map(function (l) { return l.budget; })));

    check('刷满一轮写下 30 分钟暂停，并把次数清零准备下一轮',
      (ledger.spent || []).length === 1 && Number(lives[3].budget.reloads) === 0 &&
      Number(lives[3].budget.resumeAt) > Date.now() + 29 * 60000,
      JSON.stringify({ spent: ledger.spent, budget: lives[3].budget }));

    check('暂停期间即使内存计数归零、墙照挂 21 秒，也一次都不刷',
      lives[4].reloads === 3 && lives[5].reloads === 3 &&
      Number(lives[5].budget.resumeAt) === Number(lives[3].budget.resumeAt),
      JSON.stringify({ reloads: [lives[4].reloads, lives[5].reloads], budget: lives[5].budget }));

    check('设置里关掉「被挡住时刷新页面」后一次都不刷',
      switchOff.reloads === 3 && Number(switchOff.budget.reloads) === 0 &&
      Number(switchOff.budget.resumeAt) === 0,
      JSON.stringify(switchOff));

    check('刷新日志逐条点名第几次、上限 3 次',
      (ledger.blocked || []).length === 3 &&
      ledger.blocked.map(function (m) { return m.reload; }).join(',') === '1,2,3' &&
      ledger.blocked.every(function (m) { return m.of === 3; }),
      JSON.stringify(ledger.blocked));

    var everyCross = ledger.every || [];
    check('跨域日志每一轮都有一条，且写明这是同站的墙、刷新有机会解决',
      everyCross.length === 7 && everyCross.every(function (m) { return m.sameSite === true; }) &&
      String((everyCross[0] || {}).hint || '').indexOf('刷新有机会解决') !== -1,
      JSON.stringify({ n: everyCross.length, first: everyCross[0] }));

    check('暂停期间日志要说清还剩多久（否则用户只看到一直在卡）',
      everyCross.slice(4).some(function (m) { return Number(m.resumeInMs) > 28 * 60000; }),
      JSON.stringify(everyCross.map(function (m) { return m.resumeInMs; })));

    check('日志只带 origin、不带路径（学习通的地址里全是 clazzid / 章节号，日志会被复制发出去）',
      everyCross.length > 0 && everyCross.every(function (m) {
        var o = String(m.srcOrigin || '');
        return o.indexOf('blocked-inner') === -1 && /^http:\/\/mooc2\.chaoxing\.com:\d+$/.test(o);
      }),
      JSON.stringify(everyCross.slice(0, 2).map(function (m) { return m.srcOrigin; })));

    // ---- 同一刻的"一个帧都没配上"必须自己说出原因（现场那格 searchedCount:0 就是这么查的）----
    await ctx.client.evaluate('(function(){window._xxtApp._frameUnreadableLogAt=0;})()');
    var searched = JSON.parse(await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,r;try{r=app._searchChaoxingJobOcs([]);}catch(e){}' +
      'return JSON.stringify({nullReturned:r===null});})()'
    ));
    await sleep(400);
    var unread = JSON.parse(await ctx.client.evaluate(
      '(function(){var w=window.__blockedWall;' +
      'return JSON.stringify(w.metas("study search skipped: main frame document unreadable"));})()'
    ));
    check('主帧读不到时，任务点查找除了返回"没活干"，还要打出是哪一站（同站 / 别家）',
      searched.nullReturned === true && unread.length >= 1 && unread[0].sameSite === true &&
      /^http:\/\/mooc2\.chaoxing\.com:\d+$/.test(String(unread[0].srcOrigin || '')),
      JSON.stringify({ searched: searched, unread: unread }));

    // ---- 批次 44-③：src 属性写着顶层自己的地址、帧却读不到 —— 这一格现场真的出现过 ----
    // 现场日志里抓到 `srcOrigin` 与 `topOrigin` **完全相同**、`sameSite:true`，而帧就是读不到：
    // `src` 属性只记"当初想让它去哪"，帧自己在里面导航走之后属性不会跟着更新。
    // 旧标题 `main frame is cross-origin` 在这种格子上是自己在跟自己打架。
    // 夹具照现场做，不靠桩：① 把属性换成顶层自己的地址（真的导航过去、读得通）
    // ② 再从帧**里面**把自己 replace 到墙那一边 → 属性留在同源、文档变成读不到。
    // 属性用带查询串的写法，好让后面"墙过了"那一步的 `f.src="/blocked-inner"` 仍然算一次真导航。
    await ctx.client.evaluate('(function(){var f=window._xxtApp._getMainFrame();' +
      'window.__blockedWall.wallUrl=String(f.getAttribute("src"));' +
      'f.setAttribute("src","/blocked-inner?b44=1");})()');
    var innerReadable = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a._getMainFrame();' +
      'if(!f||!a._isFrameSameOrigin(f))return false;' +
      'var d=null;try{d=f.contentDocument;}catch(e){return false;}' +
      'return !!(d&&d.body&&String(d.body.innerText||"").indexOf("被换走")!==-1);})()', 12000);
    var walkedAway = await ctx.client.evaluate(
      '(function(){var f=window._xxtApp._getMainFrame();' +
      'try{f.contentWindow.location.replace(window.__blockedWall.wallUrl);return "sent";}' +
      'catch(e){return String((e&&e.message)||e).slice(0,60);}})()');
    var unreadableAgain = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a._getMainFrame();' +
      'return !!f&&!a._isFrameSameOrigin(f);})()', 12000);
    var staleBefore = Number(await ctx.client.evaluate(
      '(function(){return window.__blockedWall.metas("main frame unreadable").length;})()'));
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;app._crossOriginLogAt=0;' +
      'app._mainFrameCrossOriginSince=Date.now()-21000;app._checkBlockedByCrossOrigin();})()');
    await sleep(400);   // 日志走 postMessage，不等一拍读到的是空缓冲
    var staleAttr = JSON.parse(await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,w=window.__blockedWall;' +
      'var f=app._getMainFrame(),o=app._frameOriginOf(f);' +
      'var all=w.metas("main frame unreadable");' +
      'return JSON.stringify({readable:app._isFrameSameOrigin(f),' +
      '  attrIsTop:(o===String(location.origin)),nAfter:all.length,' +
      '  last:all[all.length-1]||null,' +
      '  oldName:w.metas("main frame is cross-origin").length});})()'
    ));

    check('夹具自证：src 属性 = 顶层 origin，帧却**真的**读不到（否则这一格是空测）',
      innerReadable === true && walkedAway === 'sent' && unreadableAgain === true &&
      staleAttr.readable === false && staleAttr.attrIsTop === true,
      JSON.stringify({ inner: innerReadable, walkedAway: walkedAway,
        unreadableAgain: unreadableAgain, stale: staleAttr }));

    check('两个 origin 相同时那条日志改说「地址一模一样却读不到、属性可能是旧的」，全场不再有旧标题',
      staleAttr.nAfter === staleBefore + 1 && !!staleAttr.last &&
      staleAttr.last.sameOrigin === true && staleAttr.last.sameSite === true &&
      /一模一样/.test(String(staleAttr.last.hint || '')) &&
      /旧/.test(String(staleAttr.last.hint || '')) && staleAttr.oldName === 0,
      JSON.stringify({ before: staleBefore, after: staleAttr.nAfter, last: staleAttr.last,
        oldName: staleAttr.oldName }));

    // ---- 墙过了（帧重新读得通）：那笔刷新账必须作废 ----
    await ctx.client.evaluate(
      '(function(){var w=window.__blockedWall;w.seed(2,Date.now()+30*60000);' +
      'var f=window._xxtApp._getMainFrame();f.src="/blocked-inner";})()'
    );
    var readableAgain = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a._getMainFrame();' +
      'if(!f||!a._isFrameSameOrigin(f))return false;' +
      'var d=null;try{d=f.contentDocument;}catch(e){return false;}' +
      'return !!(d&&d.body&&String(d.body.innerText||"").indexOf("被换走")!==-1);})()', 12000);
    var healed = JSON.parse(await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return JSON.stringify({blocked:app._checkBlockedByCrossOrigin(),' +
      '  budget:window.__blockedWall.read()});})()'
    ));
    check('帧重新读得通 = 墙过了：不再判被挡住，且把上一面墙的刷新账整个作废',
      readableAgain === true && healed.blocked === false &&
      Number(healed.budget.reloads) === 0 && Number(healed.budget.resumeAt) === 0,
      JSON.stringify({ readableAgain: readableAgain, healed: healed }));
  }
});

/**
 * ---- 批次 35 ②：内容帧被换成**别家**地址时，一次都不许刷 ----
 *
 * 另一半根因：刷新对这一族是白刷（刷完还是那一家的页面），却每 20 秒把整页推倒一次。
 * 现场最常见的来源是浏览器自己的跟踪防范 / 广告拦截扩展 / 网络代理把内容帧换掉了 ——
 * 这些都不是插件能修的，所以这里要的是**停在原地、把话说清楚**，不是反复刷。
 */
SCENARIOS.push({
  name: '内容帧被换成别家地址时一次都不刷',
  path: '/blocked-off-site',
  run: async function (ctx) {
    var unreadable = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a&&a._getMainFrame();' +
      'return !!f&&!a._isFrameSameOrigin(f);})()', 12000);

    var setup = JSON.parse(await ctx.client.evaluate(
      '(function(){' +
      'var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var KEY="omitone:blocked-reload-budget";' +
      'var w={reloads:0,got:[]};' +
      'window.__blockedWall=w;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")w.got.push(m);});' +
      'w.read=function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}")||{};}catch(e){return {};}};' +
      'w.metas=function(name){return w.got.filter(function(m){return m.message===name;})' +
      '  .map(function(m){return m.meta||{};});};' +
      'app._reloadBlockedPage=function(){w.reloads++;};' +
      'w.life=function(){app._crossOriginLogAt=0;' +
      '  app.configs=Object.assign({},app.configs,{blockedReload:true});' +
      '  app._mainFrameCrossOriginSince=Date.now()-21000;' +
      '  return JSON.stringify({blocked:app._checkBlockedByCrossOrigin(),' +
      '    reloads:w.reloads,budget:w.read()});};' +
      'var f=app._getMainFrame(),o=app._frameOriginOf(f);' +
      'return JSON.stringify({loopStopped:!app._tickLoopInterval&&!app._tickRunning,' +
      '  readable:app._isFrameSameOrigin(f),srcOrigin:o,' +
      '  sameSite:app._isFrameSameSiteAsTop(o),topHost:String(location.hostname||"")});})()'
    ));

    check('夹具自证：内容帧确实被换成了**别家**（localhost），与顶层不同站、JS 读不到',
      unreadable === true && setup.readable === false && setup.sameSite === false &&
      setup.loopStopped === true &&
      setup.topHost === 'mooc1.chaoxing.com' &&
      /^http:\/\/localhost:\d+$/.test(String(setup.srcOrigin)),
      JSON.stringify(setup));

    var lives = [];
    for (var k = 0; k < 3; k++) {
      lives.push(JSON.parse(await ctx.client.evaluate('window.__blockedWall.life()')));
    }
    await sleep(400);
    var ledger = JSON.parse(await ctx.client.evaluate(
      '(function(){var w=window.__blockedWall;return JSON.stringify({' +
      'blocked:w.metas("blocked page unreachable from JS, reload to recover"),' +
      'spent:w.metas("blocked page reload round spent, pausing reloads"),' +
      'every:w.metas("main frame unreadable")});})()'
    ));

    check('别家占着内容帧时依然判「本轮不继续跑」（不能装作没事继续往下刷）',
      lives.every(function (l) { return l.blocked === true; }),
      JSON.stringify(lives.map(function (l) { return l.blocked; })));

    check('别家的墙一次都不刷：刷新计数与刷新日志、刷新账本全是空的',
      lives[2].reloads === 0 && (ledger.blocked || []).length === 0 &&
      (ledger.spent || []).length === 0 && Number(lives[2].budget.reloads || 0) === 0 &&
      Number(lives[2].budget.resumeAt || 0) === 0,
      JSON.stringify({ reloads: lives[2].reloads, ledger: ledger, budget: lives[2].budget }));

    var hints = (ledger.every || []).map(function (m) { return String(m.hint || ''); }).join(' | ');
    check('日志要说清这是别家（既不同站也不同源）、并把下一步指到插件管不着的地方（拦截扩展 / 代理 / 重新登录）',
      (ledger.every || []).length === 3 &&
      ledger.every.every(function (m) { return m.sameSite === false && m.sameOrigin === false; }) &&
      /拦截|代理|重新登录/.test(hints) && hints.indexOf('刷新解决不了') !== -1,
      JSON.stringify({ n: (ledger.every || []).length, hints: hints.slice(0, 220) }));
  }
});

/**
 * ---- 批次 35 ③：刷新预算必须活得过一次**真**刷新 ----
 *
 * 上面两条把刷新换成了计数器，所以它们测的是"账怎么用"；这一条不桩任何东西，
 * 真的让整页刷一次，回来只看一件事：**那笔账还在不在**。
 * 旧写法记在页面内存里，刷完直接归零 —— 于是"刷 3 次收手"从来没成立过，
 * 现场表现就是整夜每 20 秒刷一次。这条断言红了，就等于根因回来了。
 */
SCENARIOS.push({
  name: '跨域墙的刷新预算活得过一次真刷新',
  path: '/blocked-same-site',
  run: async function (ctx) {
    var unreadable = await waitFor(ctx.client,
      '(function(){var a=window._xxtApp,f=a&&a._getMainFrame();' +
      'return !!f&&!a._isFrameSameOrigin(f);})()', 12000);
    var pageUrl = await ctx.client.evaluate('String(location.href)');

    // 不桩 `_reloadBlockedPage`：让它真刷一次。evaluate 的上下文会被这次导航打掉，所以吞掉异常。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;try{app._clearTickLoop();}catch(e){}' +
      'window.__xxtWallMark="before-reload";' +
      'try{sessionStorage.setItem("omitone:blocked-reload-budget",JSON.stringify(' +
      '  {reloads:2,resumeAt:0,href:String(location.href||"")}));}catch(e){}' +
      'app._mainFrameCrossOriginSince=Date.now()-21000;' +
      'app._checkBlockedByCrossOrigin();return "called";})()'
    ).catch(function () {});

    var backUp = await waitFor(ctx.client,
      '(function(){return document.readyState==="complete"&&!!window._xxtApp' +
      '&&!window.__xxtWallMark;})()', 20000);

    var after = JSON.parse(await ctx.client.evaluate(
      '(function(){var raw="";try{raw=String(sessionStorage.getItem("omitone:blocked-reload-budget")||"");}catch(e){}' +
      'var o={};try{o=JSON.parse(raw)||{};}catch(e){}' +
      'return JSON.stringify({mark:String(typeof window.__xxtWallMark),' +
      '  reloads:Number(o.reloads)||0,resumeAt:Number(o.resumeAt)||0,' +
      '  href:String(o.href||""),samePage:String(o.href||"")===String(location.href)});})()'
    ));

    check('夹具自证：这一页真的被整页刷过一次（刷新前那个内存标记已经不在了）',
      unreadable === true && backUp === true && after.mark === 'undefined',
      JSON.stringify({ unreadable: unreadable, backUp: backUp, mark: after.mark }));

    check('刷新预算跨过真刷新活下来：第 3 次记在账上（旧写法一刷就归零，于是永远刷不完）',
      after.reloads === 3, JSON.stringify(after));

    check('这笔账仍属于这一页（换页 / 翻章不作废它，但也不许算到下一页头上）',
      after.samePage === true && String(after.href) === String(pageUrl),
      JSON.stringify({ after: after, pageUrl: pageUrl }));
  }
});

/**
 * ---- 批次 44-②：站点播放器抢方向盘，不再报成「播放失败」----
 *
 * 现场（真实课程挂着跑）抓到两条 error 级的 `media play failed`，文案分别是
 * `interrupted by a new load request` 与 `interrupted by a call to pause()` ——
 * 都是站点自己的播放器在同一刻动了 load/pause，下一拍 currentTime 照走（现场实测自愈：
 * 同一条视频报错后从 26s 一路走到 629s）。而 `content.js` 把 error 级日志读成「异常运行」，
 * 右下角状态面板因此谎报过一次故障。
 * 这条钉住**分界**：只有那种中断降级成 warn，真不支持的音源必须还是 error ——
 * 只降级不吞掉（否则批次 40 那族"视频根本没有源"就再没人报警了）。
 */
SCENARIOS.push({
  name: '播放被打断与真播放失败分等级（自愈的中断不再报成故障）',
  path: '/blank',
  run: async function (ctx) {
    var res = JSON.parse(await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp,seen=[];' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")seen.push({level:m.level,message:m.message,meta:m.meta||{}});});' +
      'function snap(){var s=seen.slice();seen.length=0;return s;}' +
      'function pick(s,msg){return s.filter(function(x){return x.message===msg;});}' +
      // ⚠️ 日志走 postMessage = **宏任务**；一串快速 resolve 的 await 会让它永远排不到，
      //    于是"读了个空缓冲"看起来和"生产没发日志"一模一样。每次调用之后先让出一拍。
      'function tick(){return new Promise(function(r){setTimeout(r,260);});}' +
      'app.configs=Object.assign({},app.configs,{enableMedia:true});' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var v=document.createElement("video");' +
      // 只把"外围动作"桩掉（盯音源的这些动作各自有别的场景在测），被测面只有 play 的失败分类
      'app._findMediaInDocument=function(){return v;};' +
      'app._startVideoMonitoring=function(){};' +
      'app._ensurePlaybackRate=function(){};' +
      'app._trySeekToEnd=function(){return false;};' +
      'app._videoEventHandle=function(){};' +
      'app._maybeRepairMediaSource=async function(){return false;};' +
      'var job={name:"3.6 sample.mp4",doc:document,jobid:"j1"};' +
      'function rejectWith(msg,name){v.play=function(){return Promise.reject(new DOMException(msg,name));};}' +
      'rejectWith("The play() request was interrupted by a new load request.","AbortError");' +
      'var r1=await app._playChaoxingMediaJob(job);await tick();var p1=app._isPlaying;var s1=snap();' +
      'rejectWith("The play() request was interrupted by a call to pause().","AbortError");' +
      'var r2=await app._playChaoxingMediaJob(job);await tick();var s2=snap();' +
      'rejectWith("The requested resource is not supported.","NotSupportedError");' +
      'var r3=await app._playChaoxingMediaJob(job);await tick();var p3=app._isPlaying;var s3=snap();' +
      'app._activeMediaJobPending=false;app._videoEl=null;' +
      'return JSON.stringify({r:[r1,r2,r3],p1:p1,p3:p3,' +
      '  i1:pick(s1,"media play interrupted by site player"),e1:pick(s1,"media play failed"),' +
      '  i2:pick(s2,"media play interrupted by site player"),e2:pick(s2,"media play failed"),' +
      '  i3:pick(s3,"media play interrupted by site player"),e3:pick(s3,"media play failed")});})()'
    ));

    check('夹具自证：三次都真的走进了播放分支（返回值全为 true，否则一条日志都不会有）',
      res.r[0] === true && res.r[1] === true && res.r[2] === true, JSON.stringify(res.r));

    check('两种「被打断」（新 load / 调用 pause）各记一条 warn，且一条 error 都不记',
      res.i1.length === 1 && res.i1[0].level === 'warn' && res.e1.length === 0 &&
      res.i2.length === 1 && res.i2[0].level === 'warn' && res.e2.length === 0,
      JSON.stringify({ i1: res.i1, e1: res.e1, i2: res.i2, e2: res.e2 }));

    check('warn 那条自带下一步（说清会自己重新接上，不用人管）',
      res.i1.length === 1 && /重新接上/.test(String((res.i1[0].meta || {}).hint || '')),
      JSON.stringify(res.i1));

    check('真不支持的音源仍然记 error 级 media play failed（降级没有把这一族一起吞掉）',
      res.e3.length === 1 && res.e3[0].level === 'error' && res.i3.length === 0,
      JSON.stringify({ e3: res.e3, i3: res.i3 }));

    check('两种都仍然把 _isPlaying 打回 false（不会因为改了日志等级就假装还在播）',
      res.p1 === false && res.p3 === false, JSON.stringify({ p1: res.p1, p3: res.p3 }));

    // ---- 面板这一头：日志等级最后会变成右下角那几个字（现场就是这里谎报过一次故障）----
    // content.js 把 error 级读成「异常运行」，所以降级必须一路管到用户眼睛看得见的那一层。
    // 这里不重跑播放，只把生产实际会发的那两条消息喂给面板（等级/名字/字段都照生产写）。
    var panel = JSON.parse(await ctx.client.evaluate(
      '(async function(){' +
      'function say(level,message,meta){window.postMessage({source:"xxt_app",type:"runtime_log",' +
      '  level:level,message:message,meta:meta||null},"*");}' +
      'function wait300(){return new Promise(function(r){setTimeout(r,300);});}' +
      'function read(){var h=document.getElementById("omitone-status-panel-host");' +
      '  if(!h||!h.shadowRoot)return null;' +
      '  var q=function(r){var e=h.shadowRoot.querySelector("[data-role="+r+"]");' +
      '    return e?String(e.textContent||""):"(无)";};' +
      '  return {state:q("state"),task:q("task"),detail:q("detail")};}' +
      'say("info","start",null);await wait300();var started=read();' +
      'say("warn","media play interrupted by site player",' +
      '  {name:"3.6 sample.mp4",error:"The play() request was interrupted by a new load request.",' +
      '   hint:"站点播放器自己动了 load/pause，这一下 play 被打断 —— 会重新接上，不用管"});' +
      'await wait300();var warn=read();' +
      'say("error","media play failed",{name:"3.6 sample.mp4",' +
      '  error:"The requested resource is not supported."});' +
      'await wait300();var err=read();' +
      'return JSON.stringify({started:started,warn:warn,err:err});})()'
    ));

    check('前提：状态面板真的被 start 激活了（没激活，下面两条就是空测）',
      !!panel.started && panel.started.task !== '(无)' && !!panel.warn && !!panel.err,
      JSON.stringify(panel.started));

    check('自愈的中断在面板上写「正在重新接上」，不再写「异常运行」',
      panel.warn.state === '等待中' && panel.warn.task === '视频播放中' &&
      /重新接上/.test(String(panel.warn.detail || '')), JSON.stringify(panel.warn));

    check('真不支持的音源在面板上仍然是「异常运行」，且把那句话说给用户',
      panel.err.state === '异常运行' && panel.err.task === '视频播放失败' &&
      /not supported/.test(String(panel.err.detail || '')), JSON.stringify(panel.err));
  }
});


/** ---- 批次 44 ⑤：状态面板要把「没点名的 warn」也接住 ----
 * 为什么单列这场：面板把每条运行日志翻译成三个字段（点色 / 那行任务 / 那句详情），
 * 而 content.js 的翻译层只有 26 条按消息点名（外加一条 start、一条 error 兜底）。
 * 修复前量到 **warn 级 110 个日志名里只有 13 个被点名**，剩下 97 个会把点色打成「注意」、
 * 同时把任务与详情留成出厂值「运行中 / 状态更新中」——
 * 一张卡片自己跟自己抵消：红点说有事，字却说一切正常。
 * error 那一族有末分支兜底（「异常运行」），warn 没有，所以窟窿只在 warn 这一侧。
 * ⚠️ 这里**不重跑生产链路**，只把生产实际会发的那几条消息按原等级、原名喂给面板 ——
 * 断的是 content.js 的翻译层，不是 page.js 的判据层（判据层由上面那场负责）。 */
SCENARIOS.push({
  name: '没点名的 warn 不再被面板说成「正常运行」（注意点不许配上运行中）',
  path: '/blank',
  run: async function (ctx) {
    var panel = JSON.parse(await ctx.client.evaluate(
      '(async function(){' +
      'function say(level,message,meta){window.postMessage({source:"xxt_app",type:"runtime_log",' +
      '  level:level,message:message,meta:meta||null},"*");}' +
      'function wait300(){return new Promise(function(r){setTimeout(r,300);});}' +
      'function read(){var h=document.getElementById("omitone-status-panel-host");' +
      '  if(!h||!h.shadowRoot)return null;' +
      '  var q=function(r){var e=h.shadowRoot.querySelector("[data-role="+r+"]");' +
      '    return e?String(e.textContent||""):"(无)";};' +
      '  return {state:q("state"),task:q("task"),detail:q("detail")};}' +
      'var out={};' +
      'say("info","start",null);await wait300();out.started=read();' +
      'say("warn","media has no source, release pending",{heldMs:120000});' +
      'await wait300();out.noSource=read();' +
      'say("warn","main frame unreadable",{sameSite:true,sameOrigin:true});' +
      'await wait300();out.unreadable=read();' +
      'say("warn","study search skipped: main frame document unreadable",{sameSite:true});' +
      'await wait300();out.unreadableSearch=read();' +
      'say("warn","catalog veto window spent, allow skip",{waitedMs:20000});' +
      'await wait300();out.vetoSpent=read();' +
      'say("warn","task point given up (stuck without progress)",{kind:"quiz"});' +
      'await wait300();out.givenUp=read();' +
      'say("warn","vision bridge failed",{error:"bridge timeout"});' +
      'await wait300();out.unnamed=read();' +
      'say("info","study begin",{attachments:3});await wait300();out.infoCtl=read();' +
      'say("error","tick error",{message:"boom"});await wait300();out.errCtl=read();' +
      'say("info","media play recovered after source repair",{heldMs:1});await wait300();out.unnamedInfo=read();' +
      'return JSON.stringify(out);})()'
    ));

    check('前提：面板已被 start 激活，且这九次都读回了字（读不到就是空测）',
      !!panel.started && panel.started.task !== '(无)' &&
      ['noSource', 'unreadable', 'unreadableSearch', 'vetoSpent', 'givenUp', 'unnamed', 'infoCtl', 'errCtl', 'unnamedInfo']
        .every(function (k) { return panel[k] && panel[k].state !== '(无)'; }),
      JSON.stringify(panel.started));

    check('视频始终没源那一条点名成「视频没能播放」，不再留出厂值',
      panel.noSource.state === '注意' && panel.noSource.task === '视频没能播放' &&
      /没拿到地址/.test(String(panel.noSource.detail || '')), JSON.stringify(panel.noSource));

    check('「页面内容读不到」两种写法都接得住（同一族、日志名不同）',
      panel.unreadable.state === '注意' && panel.unreadable.task === '页面内容读不到' &&
      panel.unreadableSearch.task === '页面内容读不到',
      JSON.stringify({ a: panel.unreadable, b: panel.unreadableSearch }));

    check('放弃等待那一族点名成「放弃等待，继续往下」（上限用尽与真放弃都算）',
      panel.vetoSpent.task === '放弃等待，继续往下' && panel.givenUp.task === '放弃等待，继续往下' &&
      panel.vetoSpent.state === '注意' && panel.givenUp.state === '注意',
      JSON.stringify({ veto: panel.vetoSpent, givenUp: panel.givenUp }));

    check('★ 没点名的 warn：点色仍是「注意」，但那两行不再是「运行中 / 状态更新中」',
      panel.unnamed.state === '注意' && panel.unnamed.task !== '运行中' &&
      panel.unnamed.detail !== '状态更新中' && /查看日志/.test(String(panel.unnamed.detail || '')),
      JSON.stringify(panel.unnamed));

    check('对照一：点过名的 info 仍走自己那一句（兜底没有把 study begin 抢走）',
      panel.infoCtl.task === '扫描任务点' && panel.infoCtl.state !== '注意',
      JSON.stringify(panel.infoCtl));

    check('对照二：error 兜底没被新分支抢走（仍是「异常运行」）',
      panel.errCtl.state === '异常运行', JSON.stringify(panel.errCtl));
    // ⚠️ 上面那条对照一压根走不到尾部兜底（study begin 在链路前段就被点名接走了），
    //    把 `level === warn` 写成无条件它也不会红 —— 只有没点名的 info 才走得到这一层。
    check('对照三：没点名的 info 仍走出厂值「运行中」（warn 兜底没有吃宽到 info 这一层）',
      panel.unnamedInfo.state === '正常运行' && panel.unnamedInfo.task === '运行中' &&
      panel.unnamedInfo.detail === '状态更新中',
      JSON.stringify(panel.unnamedInfo));
  }
});/** ---- 29. run() 落「续跑标记」：讨论任务 window.open 新开的窗口才会自动跑 ----
 * 为什么单列这条：页面中间那个面板点【开始】只调 app.run()，历史上**不写** xxtRunning，
 * 于是 content.js 的 maybeMarkAutoResume 读不到标记 → 新标签页 shouldAutoStart() 恒为假 →
 * 讨论任务 window.open 出来的窗口里插件静默不跑（用户报的「讨论新窗口默认关闭、插件失灵」）。
 * 修法是让 run()（所有启动入口的汇合点）落一次 storage_set{xxtRunning:true}。 */
SCENARIOS.push({
  name: 'run() 落续跑标记（讨论新窗口才会自动跑）',
  path: '/blank',
  run: async function (ctx) {
    var res = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'var seen=[];' +
      'var onMsg=function(e){if(e.source===window&&e.data&&e.data.source==="xxt_app"&&e.data.type==="storage_set"&&e.data.payload)seen.push(e.data.payload);};' +
      'window.addEventListener("message",onMsg);' +
      'var before=(app._runtimeVersion||0);' +
      'app.run();' +
      'await new Promise(function(r){setTimeout(r,40);});' +
      'window.removeEventListener("message",onMsg);' +
      'try{app._clearTickLoop();}catch(e){}' +
      'return {ran:(app._runtimeVersion||0)>before,' +
      ' persisted:seen.some(function(p){return p.xxtRunning===true;}),' +
      ' cleanKey:seen.some(function(p){return Object.keys(p).length===1 && p.xxtRunning===true;})};' +
      '})()'
    );
    check('run() 确实启动了（_runtimeVersion 前进，前置条件）', res.ran === true, JSON.stringify(res));
    check('run() 落一次 xxtRunning=true（否则讨论新窗口静默不跑）', res.persisted === true, JSON.stringify(res));
    check('续跑标记只写 xxtRunning 一个键（不顺手污染别的存储）', res.cleanKey === true, JSON.stringify(res));
  }
});

/** ---- 32. 模型输出被截断：拆批重问，且不重问同一批 ---- */
SCENARIOS.push({
  name: '模型输出被截断时拆批重问（不重问同一批）',
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
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);

    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      // ⚠️ 这里**不再**按「多选不进请求」扣题数（那是 1.2.9 的旧口径，README §6 #49 已反转：
      //    多选默认就问模型，本地只是补填）。假模型的截断条件是"这条 prompt 里有 ≥3 行题"，
      //    行数就是发出去的题数，所以前提直接按全卷题数算 —— 与下面注释里"批的形状"一致。
      'var asked=qs.length;' +
      'return {total:qs.length,asked:asked};})()'
    );
    check('装配：本卷实际要问模型的题数 ≥ 3（这样"整批"才会触发退化）',
      setup && setup.asked >= 3, JSON.stringify(setup));
    if (!setup || setup.asked < 3) return;

    // 让假模型"一批 ≥ 3 题就吐长篇重复内容、顶到 max_tokens 被截断"。
    // 拆成两半后它才正常作答 —— 正好验证"拆批能救回来"。
    // （2026-10-31 批次上限定版 3：首发批本身就是 3 题，截断后对半拆）
    ctx.mock.setResponseMode('truncate-big');
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var allFilled = await waitFor(ctx.client,
      '(function(){var app=window._xxtApp;var qs=app._quizCurrentQuestions||[];' +
      'if(!qs.length) return false;' +
      'var d=app._resolveQuizAnswerDocument(null);' +
      'for(var i=0;i<qs.length;i++){ if(!app._getQuizQuestionFilledValue(d,qs[i])) return false; }' +
      'return true;})()', 40000);

    var sent = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });
    var sets = requestQuestionSets(ctx.mock.requests.slice(before));
    // 失败信息按"题数:题干前 8 字"展开（题干之间用 + 分隔）—— 集合本身按换行拼，
    // 直接 JSON 出来是一堆 \n，看不出到底哪两批撞了。
    var readable = sets.map(function (s) {
      var parts = s.split('\n');
      return parts.length + ':[' + parts.map(function (t) { return t.slice(0, 8); }).join('+') + ']';
    }).join(' ');

    // 批次 7 之后多选**也进请求**，批的形状跟着变了（多选单独成批、其余题照样凑满 3）。
    // 所以这里不再写死"[3,1,2,1]"，改守三条与形状无关的事实：
    //   ① 没有任何一组题被原样重问（旧实现截断后拿同一整批再发一次）；
    //   ② 截断的那一批确实被拆成了**更小的真子集**重问；
    //   ③ 请求总数不超过"每题各问一次"的上界 —— 超出就说明有浪费。
    check('没有任何一组题被原样重问（旧实现截断后会把同一整批再发一次）',
      duplicateQuestionSet(sets) === null, readable);
    check('确实按"对半拆"重问了（能看到比被截断那批更小、且是它真子集的批）',
      (function () {
        var bigIdx = -1;
        for (var i = 0; i < sent.length; i++) { if (sent[i] >= 3) { bigIdx = i; break; } }
        if (bigIdx < 0) return false;
        var big = String(sets[bigIdx] || '').split('\n');
        return sets.some(function (s, j) {
          if (j === bigIdx || !s) return false;
          var part = s.split('\n');
          if (part.length >= big.length) return false;
          return part.every(function (title) { return big.indexOf(title) !== -1; });
        });
      })(), readable);
    check('拆批之后所有题都答上了（旧实现这一批一道都落不了地）',
      allFilled === true, 'filled=' + allFilled + ' sent=' + JSON.stringify(sent));
    check('请求数没有超出"每题最多各问一次"的上界（没有补问式的浪费）',
      sent.length > 0 && sent.length <= setup.total + 1,
      'requests=' + sent.length + ' total=' + setup.total + ' ' + readable);

    ctx.mock.setResponseMode('');
  }
});

/** ---- 33. 一行一个 JSON 值（实测的另一种退化形状）也要能解析 ---- */
SCENARIOS.push({
  name: '一行一个答案也要能解析',
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
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);

    // ⚠️ 以前这里按「多选不进请求」扣掉多选题数（1.2.9 旧口径，README §6 #49 已反转）。
    //    现在多选照样进请求，发出去的题数就是全卷题数，扣了反而和假模型的行对不上。
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      'return {total:qs.length};})()'
    );
    check('装配：本卷要问模型的题数 ≥ 1', setup && setup.total >= 1, JSON.stringify(setup));

    // 假模型改成"一行一个 JSON 值"（每行正好一题的答案）——
    // 升级前解析器的贪婪匹配会把多行从第一个 `[` 抓到最后一个 `]`，
    // 跨行拼出来不是合法 JSON → 一律判失败 → 模型答了也白答。
    ctx.mock.setResponseMode('line-format');
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var allFilled = await waitFor(ctx.client,
      '(function(){var app=window._xxtApp;var qs=app._quizCurrentQuestions||[];' +
      'if(!qs.length) return false;' +
      'var d=app._resolveQuizAnswerDocument(null);' +
      'for(var i=0;i<qs.length;i++){ if(!app._getQuizQuestionFilledValue(d,qs[i])) return false; }' +
      'return true;})()', 40000);
    var sentCount = ctx.mock.requests.length - before;
    var sentCounts = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });
    var sets33 = requestQuestionSets(ctx.mock.requests.slice(before));

    check('一行一个 JSON 值的应答能被解析，题目全部答上（旧实现一道都答不上）',
      allFilled === true, 'filled=' + allFilled + ' sent=' + JSON.stringify(sentCounts) +
      ' detail=' + JSON.stringify(await ctx.client.evaluate(
        '(function(){var a=window._xxtApp;var d=a._resolveQuizAnswerDocument(null);' +
        'return {vals:a._quizCurrentQuestions.map(function(q){return {i:q.index,t:q.type,v:a._getQuizQuestionFilledValue(d,q)};}),' +
        'ans:a._quizCurrentAnswerValues};})()'
      )));
    // 守的是"解析失败不许重问同一批"：升级前解析失败 → `requestAnswersWithRetry`
    // 会**拿同一整批再问一次**。断言按**题号集合**判，不按批的大小判 ——
    // 批的形状会随实现变（批次 7 之后多选也进请求、单独成批），
    // "同一组题有没有被问两遍"才是这件事真正的事实。
    check('没有任何一组题被原样重问（旧实现解析失败会把同一批再发一次）',
      sets33.length > 0 && duplicateQuestionSet(sets33) === null, JSON.stringify(sets33));

    ctx.mock.setResponseMode('');
  }
});

/** ---- 34. 用 `|||` 串起来的答案也要能解析（实测的第二种退化形状） ---- */
SCENARIOS.push({
  name: '用 ||| 串起来的答案也要能解析',
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
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);

    // ⚠️ 同上一条：多选题也进请求，发出去的题数就是全卷题数（旧口径「多选不进请求」已作废）
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      'return {total:qs.length};})()'
    );
    check('装配：本卷要问模型的题数 ≥ 1', setup && setup.total >= 1, JSON.stringify(setup));

    // 假模型用 `|||` 把每题的答案串成一条（现场原样）：
    // 升级前：贪婪 `[...]` 匹配跨段拼出来不是合法 JSON → 判失败 → 一道题都答不上。
    ctx.mock.setResponseMode('pipe-format');
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var allFilled = await waitFor(ctx.client,
      '(function(){var app=window._xxtApp;var qs=app._quizCurrentQuestions||[];' +
      'if(!qs.length) return false;' +
      'var d=app._resolveQuizAnswerDocument(null);' +
      'for(var i=0;i<qs.length;i++){ if(!app._getQuizQuestionFilledValue(d,qs[i])) return false; }' +
      'return true;})()', 40000);
    var sentCounts = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });

    check('`|||` 串起来的应答能被解析，题目全部答上（旧实现一道都答不上）',
      allFilled === true, 'filled=' + allFilled + ' counts=' + JSON.stringify(sentCounts));
    // 同第 33 条：按**题号集合**判"有没有把同一批原样重问"，不按批的形状判。
    var sets34 = requestQuestionSets(ctx.mock.requests.slice(before));
    check('没有任何一组题被原样重问（旧实现解析失败会把同一批再发一次）',
      sets34.length > 0 && duplicateQuestionSet(sets34) === null, JSON.stringify(sets34));

    ctx.mock.setResponseMode('');
  }
});

/** ---- 35. 填空题的答题框是富文本编辑器时也要能填 ---- */
SCENARIOS.push({
  name: '填空题的答题框是富文本编辑器时也要能填',
  path: '/quiz',
  run: async function (ctx) {
    // 现场实测形态（诊断日志 2026-10-10）：25 题里有 2 道填空题的答题框
    // **一个 input 都没有**（`textInputs: 0, richEditors: 1`）—— 它是 UEditor 的 iframe。
    // 题型判定按 typename（"填空题"）给了 'fill'，而填答路径只认 input →
    // 那两题**永远填不上** → 表单永远不满 → 永不提交 → 整卷每 30 秒重来一轮。
    var setup = await ctx.client.evaluate(
      '(function(){' +
      'var box=document.createElement("div");' +
      'box.className="TiMu"; box.setAttribute("qid","9001");' +
      // ⚠️ 刻意**不给隐藏答案域**：现场那两道填空题就是这样（有富文本 iframe、没有 input、
      //    也没有能读到的 `#answer{qid}`）—— 只有在这种形状下，
      //    "判定要不要读富文本正文"这条断言才有区分力。
      'box.innerHTML=\'<div class="Zy_TItle"><span class="fontLabel">26.</span>【填空题】测试用富文本填空</div>' +
      '<div id="richHolder"></div>\';' +
      'var holder=document.getElementById("Zyapl")||document.body; holder.appendChild(box);' +
      'var f=document.createElement("iframe"); document.getElementById("richHolder").appendChild(f);' +
      'f.contentDocument.body.innerHTML="<p></p>";' +
      'var app=window._xxtApp;' +
      'var el=box;' +
      'return {textInputs: el.querySelectorAll("input[type=\\"text\\"], input:not([type])").length,' +
      '  richEditors: el.querySelectorAll("iframe").length,' +
      '  hiddenFields: document.querySelectorAll("#answer9001").length,' +
      '  qid: (function(){try{return app._getQuestionIdFromElement(el)||"";}catch(e){return "(抛错)";}})()};})()'
    );
    check('装配：这道填空题没有文本框、没有隐藏域、只有一个富文本编辑器（与现场一致）',
      setup && setup.textInputs === 0 && setup.richEditors === 1 && setup.hiddenFields === 0,
      JSON.stringify(setup));

    var filled = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var el=document.querySelector(".TiMu[qid=\\"9001\\"]");' +
      'app._fillText(el, "标准答案");' +   // 题型派发到 fill 时走的就是这个入口
      'var f=el.querySelector("iframe");' +
      'var q={_element:el,type:"fill"};' +
      'var judged="";try{judged=String(app._getQuizQuestionFilledValue(null,q)||"").trim();}catch(e){judged="(抛错)";}' +
      'return {editorText:String((f.contentDocument&&f.contentDocument.body)?f.contentDocument.body.textContent:"").trim(),' +
      '  judged:judged};})()'
    );
    check('富文本正文被写入了答案（旧实现直接 return，一个字符都不写）',
      filled && filled.editorText.indexOf('标准答案') !== -1, JSON.stringify(filled));
    // ★ 填答与判定必须**对称**：写进去了，判定也得读得出来 —— 否则表单永远不满、永不提交
    //   （现场实测：`fill fallback: rich editor {"emptyAnswer":false}` 已跑到，可 `unfilledCount` 仍是 2）。
    check('判定也认这份答案（这里是唯一能证明"填答与判定对称"的断言）',
      filled && filled.judged.indexOf('标准答案') !== -1, JSON.stringify(filled));
  }
});

/**
 * ---- 36. 多选答案被"摊平"时也要能重新分段（视频弹题那条路） ----
 *
 * ⚠️ 这一条**原来挂在章节测验页（/quiz）上**，当时搬过来的理由是"整卷的多选改成本地作答、
 *    不进请求了"（1.2.9 旧口径）。那句话已经被 README §6 #49 推翻 —— 整卷的多选照样问模型，
 *    摊平形状**两条路都会出现**。
 *    但这条**不搬回去也不删**：弹题和整卷是两套填题代码（`80-popup-quiz.js` / `75-quiz-dom.js`），
 *    `resegmentFlatAnswers` 在弹题这条链上坏掉时，整卷那条断言不会报警。
 *
 * 现场实测形状：一道多选回成 `["A","C"]`（**2 项对 1 题**）。
 * 升级前这一批长度不符 → 整批丢弃 → 弹题一个选项都点不上 → 反复重试直到放弃，
 * 视频也就卡在这里播不下去。
 */
SCENARIOS.push({
  name: '弹题的多选答案被摊平时要能重新分段',
  path: '/popup-quiz-multi',
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
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);
    await ctx.client.evaluate(
      'window._xxtApp.configs = Object.assign({}, window._xxtApp.configs, ' + JSON.stringify(cfg) + '); true'
    );

    // 前提：这确实是一道"复选控件"的多选弹题（题型判错就测不到这条路）
    var shape = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var p=document.querySelector(".ans-pop-quiz");' +
      'var n=app._checkPopupQuiz();' +
      'return {node:!!n,type:app._detectPopupQuizType(p,app._getOptionItems(p)),' +
      'boxes:p.querySelectorAll("input[type=checkbox]").length};})()'
    );
    check('前提：弹窗被判成"多选"（复选控件）',
      shape && shape.node === true && shape.type === 'multiple' && shape.boxes === 3,
      JSON.stringify(shape));

    // 假模型把多选的答案摊平成两项（现场实测形状）
    ctx.mock.setResponseMode('flat-multi');
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var n=app._checkPopupQuiz();return app._handlePopupQuiz(n);})()'
    );
    await sleep(2500);

    check('弹题已发到模型接口', ctx.mock.requests.length > before,
      '请求数 +' + (ctx.mock.requests.length - before));

    var prompt = ctx.mock.requests.length > before
      ? ctx.mock.requests[ctx.mock.requests.length - 1].prompt : '';
    check('弹题这条路的提示词里**有**多选题（弹题自己拼提示词，不走整卷那套）',
      /\d+\|m\|/.test(prompt), prompt.slice(0, 140));

    var filled = await ctx.client.evaluate(
      '(function(){var ins=document.querySelectorAll(".ans-pop-quiz input[type=checkbox]");' +
      'var checked=[];for(var i=0;i<ins.length;i++){if(ins[i].checked) checked.push(ins[i].value);}' +
      'return {checked:checked.sort().join("")};})()'
    );
    check('摊平的 `["A","C"]` 被重新分段成一道多选，两项都点上了（旧实现整批丢弃、一个都点不上）',
      filled && filled.checked === 'AC', JSON.stringify(filled));

    check('同一道弹题没有被重复问（整批只问了一次）',
      ctx.mock.requests.length - before === 1,
      '发了 ' + (ctx.mock.requests.length - before) + ' 次');

    ctx.mock.setResponseMode('');
  }
});

/**
 * ---- 21. 非视频整卷的多选：**问模型**，本地只在它没落地时补填 ----
 *
 * 这一条在 2026-10-10 是反着测的（那时多选**不进 payload**，本地乱答省 token）。
 * 现场把那个前提推翻了，两条独立证据都写在 `_answerLocalMultiChoiceQuestions` 的说明里：
 *   ① 本地答案是猜的 —— 一份卷子只要有一道多选，基本就过不了及格线；
 *   ② 2026-11-10 真实日志：`quiz submit attempt count {count:1,max:2}` ——
 *      课后检测只给两次机会，第一趟拿猜的交等于白烧一次真提交。
 * 用户当时的原话：「只回答的多选题，估计是乱选的，单选题一题也是空着的」。
 *
 * 所以现在三条主线换了两个方向：
 *   ① 提示词里**有**多选题（与单选同等对待）—— 这才是"卷子有机会答对"的证据
 *   ② 多选填的是**模型给的那一份**，不是本地猜的组合
 *   ③ 只有模型那一份**没落地**时，本地补填才出手 —— 并且只有那时才收紧交卷上限
 *      （上限从 20 收到 2：拿猜的答案交，交一次就该停，不能拿用户的提交次数去赌）
 *
 * ⚠️ 兜底纪律仍然要守：本地**算不出**答案的多选（读不到选项字母）
 * 不许占用"已处理"名额、也不许给卷子记账 —— 否则表单缺一题、永不提交。
 */
SCENARIOS.push({
  name: '多选交回模型，本地只在没落地时补填',
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

    // 两处配置都要喂（原因见「答题往返 + 回填 DOM」那一段的注释）
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);

    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      'var mq=-1;' +
      'for(var i=0;i<qs.length;i++){ if(qs[i].type==="multiple") mq=i; }' +
      'return {total:qs.length,multipleIndex:mq};})()'
    );
    check('前提：本卷有多选题（否则这条测的是别的路）',
      setup && setup.multipleIndex >= 0, JSON.stringify(setup));
    if (!setup || setup.multipleIndex < 0) return;

    // 反向守卫：**读不到选项**的多选不能被算作"已处理"，也不能给卷子记账。
    // 漏了它就等于"本地没填上、又被当成已经答过" → 表单缺一题 → 永不提交，
    // 而那一份记录还会把上限收到 2 —— 一道我们根本没答上的题，凭什么只交两次。
    // 顺序很重要：上面还没跑过任何本地补填，`papers===0` 才是有意义的对照。
    var noOptions = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var box=document.createElement("div");' +
      'box.innerHTML="<div class=\'TiMu\' qid=\'99201\'><span>这道题读不到选项</span></div>";' +
      'document.body.appendChild(box);' +
      'var q={index:97,type:"multiple",title:"这道题读不到选项",options:[],_element:box.firstChild};' +
      'var handled=app._answerLocalMultiChoiceQuestions([q],null);' +
      'var r={handled:Object.keys(handled).length,answered:app._wasQuizQuestionAnsweredThisRun(q),' +
      'papers:Object.keys(app._quizLocalMultiplePapers||{}).length};' +
      'document.body.removeChild(box);' +
      'return r;})()'
    );
    check('读不到选项的多选**不占用**"已本地处理"名额（照旧留给模型），也不给卷子留记录',
      noOptions && noOptions.handled === 0 && noOptions.answered === false && noOptions.papers === 0,
      JSON.stringify(noOptions));

    // 补填那一趟**接在真实流程里**的探针：包一层计数再原样转给实现。
    // ⚠️ 这条补的是一个真实的覆盖缺口 —— 反向验证时把调用点整个 `if (false)` 掉，
    //   本场景其余 23 条**照样全绿**（它们都直接调那个方法，测的是方法、不是接线）。
    //   「模型给的多选被清理步骤抹掉、只能靠补填补回来」这条窄缝只有真流程才走得到。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'window._omRefillCalls=0;' +
      'var orig=app._answerLocalMultiChoiceQuestions;' +
      'app._answerLocalMultiChoiceQuestions=function(qs,doc){' +
      '  window._omRefillCalls++; return orig.call(app,qs,doc);' +
      '}; return true;})()'
    );

    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var sent = false;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (ctx.mock.requests.length > before) { sent = true; break; }
      await sleep(300);
    }
    check('整卷（含多选）发到模型接口', sent, '请求数 +' + (ctx.mock.requests.length - before));
    if (!sent) return;

    // 2026-10-31 批次定版 3：一卷发多个请求，断言扫描全部请求的并集
    var prompt = ctx.mock.requests.slice(before).map(function (r) { return r.prompt; }).join('\n');
    check('提示词里**有**多选题题干（批次 7 之后它与单选同等对待，不再本地乱答）',
      prompt.indexOf('以下属于操作系统核心功能的有') !== -1, prompt.slice(0, 160));
    check('提示词里带多选题的选项原文（模型要看到选项才可能答对）',
      prompt.indexOf('进程管理') !== -1 && prompt.indexOf('编译源代码') !== -1);
    check('提示词里**有**单选题题干（没有把别的题漏掉）',
      prompt.indexOf('中国特色社会主义最本质的特征') !== -1);
    check('提示词里**有**填空题与简答题题干（整题清单齐全）',
      prompt.indexOf('一个完整的 IP 地址由') !== -1 && prompt.indexOf('简述数据库事务') !== -1);
    check('多选题型代号 "|m|" 出现了（没被从清单里剔掉）',
      /\d+\|m\|/.test(prompt), prompt.slice(0, 160));

    var filled = await waitFor(ctx.client,
      '(function(){var e=document.getElementById("answer1002");return !!e && e.value !== "";})()', 15000);
    check('多选在 DOM 里被填上了（空着就永远不会提交）', filled === true);
    var refillWired = await ctx.client.evaluate('(function(){return window._omRefillCalls||0;})()');
    check('真实答题流程里确实调到了「多选补填」那一趟（不是只有测试在直接调方法）',
      refillWired >= 1, '调用次数=' + refillWired);

    var multi = await ctx.client.evaluate(
      '(function(){var e=document.getElementById("answer1002");' +
      'var checked=[];var ins=document.querySelectorAll("input[name=\'answer1002\']");' +
      'for(var i=0;i<ins.length;i++){if(ins[i].checked)checked.push(ins[i].value);}' +
      'return {value:e?e.value:null,checked:checked.sort().join("")};})()'
    );
    check('多选填的就是**模型给的那一份**（A,C）—— 不是本地猜的组合' +
      '（旧的宽松正则等于没断：本地兜底随便凑一组也是 A-D 字母串）',
      !!multi && multi.value === 'AC', JSON.stringify(multi));
    check('答案确实被勾到了选项上（隐藏域与勾选态一致，不是只写了个字段）',
      !!multi && multi.checked === 'AC', JSON.stringify(multi));

    // 模型那条路没被影响：单选还是"问出来的"A
    var a1001 = await ctx.client.evaluate('document.getElementById("answer1001").value');
    check('单选仍然由模型作答（这一路一直如此）', a1001 === 'A', String(a1001));

    var ready = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'return app._areQuizAnswersFilled(null,qs,{requireThisRun:true});})()'
    );
    check('整卷判定"每题都有值"→ 可以提交（多选没有破坏提交前置）',
      ready === true, String(ready));

    // ===== 补填那一趟：模型已经答上的题，一个字母都不许改 =====
    // 幂等是这条路的硬要求：`_fillAnswers` 之后流程还会再走一遍同一个入口
    // （那一趟只负责补"仍然空着"的题）。重填 = 把刚点上的复选**再点一次 = 取消**。
    var beforeAgain = ctx.mock.requests.length;
    var again = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var e=document.getElementById("answer1002");' +
      'var was=e?e.value:null;' +
      'var qs=app._extractQuestions(null);' +
      'var handled=app._answerLocalMultiChoiceQuestions(qs,null);' +
      'var now=document.getElementById("answer1002");' +
      'return {was:was,now:now?now.value:null,keys:Object.keys(handled).join(","),' +
      'papers:Object.keys(app._quizLocalMultiplePapers||{}).length};})()'
    );
    check('补填那一趟是幂等的：模型填好的答案一个字母都没被改（复选重填会把自己切掉）',
      again && again.was === again.now && again.was === 'AC', JSON.stringify(again));
    check('补填那一趟没有多花任何模型请求',
      ctx.mock.requests.length === beforeAgain,
      '多发了 ' + (ctx.mock.requests.length - beforeAgain) + ' 次');
    check('"已处理"的下标表里正好有多选题那一位（已填好的直接采信，不再问模型）',
      !!again && again.keys.split(',').indexOf(String(setup.multipleIndex)) !== -1,
      JSON.stringify(again));

    // ===== 认真答过的卷子：不记本地账、不收紧上限 =====
    // 旧版在这里会记 `localPapers===1 / max===2` —— 因为多选**本来就是**本地答的。
    // 现在只有"本地真的补填过"才记账，模型答对的卷子照旧拿满配置的尝试次数。
    var paper = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return {key:String(app._getQuizWorkKey(null)).slice(0,24),' +
      'max:app._getQuizMaxSubmitAttempts(null),' +
      'localPapers:Object.keys(app._quizLocalMultiplePapers||{}).length};})()'
    );
    check('模型答上的多选不会被记成「本地乱答过」（交卷上限仍是配置的那个）',
      paper && paper.localPapers === 0 && paper.max === 20 &&
      paper.key.indexOf('omitone.quiz.correct.') === 0, JSON.stringify(paper));

    // ===== 反过来：模型那一份**没落地**时，补填必须出手 =====
    // 现场窄缝（见方法说明）：模型给的多选组合正好落在"已知错答"里，
    // 被 `_clearKnownWrongFilledQuizAnswers` 抹掉 → 表单缺一题 → 整卷永不提交。
    // 这里直接把那一位清空 + 取消勾选 + 撤掉本轮已答标记，造出那个状态。
    var rescue = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var got=[];' +
      'window.addEventListener("message",function(e){' +
      '  var m=e.data; if(m&&m.source==="xxt_app"&&m.type==="runtime_log") got.push(m);});' +
      'var app=window._xxtApp;' +
      'var hidden=document.getElementById("answer1002"); hidden.value="";' +
      'var ins=document.querySelectorAll("input[name=\\"answer1002\\"]");' +
      'for(var i=0;i<ins.length;i++){ ins[i].checked=false; }' +
      'var qs=app._extractQuestions(null);' +
      'var mq=-1; for(var k=0;k<qs.length;k++){ if(qs[k].type==="multiple") mq=k; }' +
      'app._unmarkQuizQuestionAnsweredThisRun(qs[mq]);' +
      'var beforeReady=app._areQuizAnswersFilled(null,qs,{requireThisRun:true});' +
      'var handled=app._answerLocalMultiChoiceQuestions(qs,null);' +
      'setTimeout(function(){' +
      '  var log=null;' +
      '  got.forEach(function(m){ if(m.message==="multiple choice filled locally as refill") log=m; });' +
      '  var checked=[];var list=document.querySelectorAll("input[name=\\"answer1002\\"]");' +
      '  for(var j=0;j<list.length;j++){ if(list[j].checked) checked.push(list[j].value); }' +
      '  res({beforeReady:beforeReady,' +
      '    keys:Object.keys(handled).join(","),' +
      '    value:hidden.value, checked:checked.sort().join(""),' +
      '    ready:app._areQuizAnswersFilled(null,qs,{requireThisRun:true}),' +
      '    papers:Object.keys(app._quizLocalMultiplePapers||{}).length,' +
      '    max:app._getQuizMaxSubmitAttempts(null),' +
      '    logLevel:log?log.level:"", logMeta:log?log.meta:null});' +
      '},300);});})()'
    );
    check('没落地时整卷判定为「还没答完」（这就是旧版最怕的永不提交）',
      rescue && rescue.beforeReady === false, JSON.stringify(rescue && rescue.beforeReady));
    check('补填把这一题真的勾上了选项（不是只写一个字段）',
      rescue && rescue.value !== '' && rescue.checked === rescue.value,
      JSON.stringify(rescue && { value: rescue.value, checked: rescue.checked }));
    check('补填之后整卷"每题都有值"，提交前置恢复',
      rescue && rescue.ready === true, String(rescue && rescue.ready));
    check('本地真的补填过才记账，并把交卷上限从 20 收到 2（拿猜的答案不许多交）',
      rescue && rescue.papers === 1 && rescue.max === 2,
      JSON.stringify(rescue && { papers: rescue.papers, max: rescue.max }));
    check('补填那条日志是 warn 级、说的是「补填」而不是旧那句「not sent to llm」',
      rescue && rescue.logLevel === 'warn' && !!rescue.logMeta &&
      rescue.logMeta.count >= 1 && String(rescue.logMeta.paperKey) === 'set',
      JSON.stringify(rescue && { level: rescue.logLevel, meta: rescue.logMeta }));
  }
});

/** ---- 37. 长题（简答/填空）只写进隐藏域 = 用户看到的「答题框空着却交了卷」 ---- */
SCENARIOS.push({
  name: '长题只写进隐藏域要报成没答',
  path: '/quiz',
  run: async function (ctx) {
    // 现场（2026-11-10，用户一次性复制的 200 条日志）：一份 3 题卷子 ——
    //   quiz fill audit ok {total:3, withValue:3, choice:2, checkedInDom:2, missing:[]}
    // 审计写着 ok、卷子直接交出去，可用户眼睛看到的是**那道长题的答题框完全空着**。
    // 差的就是这一层：判定读的是隐藏域，填答也只写到了隐藏域，两边都"对"，页面却是空的。
    // 三种"框不在容器里"的形状分开测：A 框在容器外（要能写进去）· B 形状完全不认（要报出来）·
    // C 只有隐藏域（提交前置照旧满足，但审计必须说"框里没字"）；
    // 再加 D 作对照：多空填空的正常形状（三个可见空）本来就一直能填，用它钉住计数语义。
    var setup = await ctx.client.evaluate(
      '(function(){' +
      'var host=document.getElementById("Zyapl")||document.body;' +
      'function box(html){var d=document.createElement("div"); d.innerHTML=html; return d.firstChild;}' +
      // A：容器只圈到题干，答题框是**它后面**的 contenteditable
      'var a=box(\'<div id="omWrapA"><div class="TiMu" qid="9101">' +
        '<div class="Zy_TItle"><span class="fontLabel">21.</span>【简答题】容器外的答题框</div></div>' +
        '<div class="answerArea"><div id="omBoxA" contenteditable="true"></div></div></div>\');' +
      // B：完全不认的形状 —— 容器里没有任何能打字的东西，也没有 #answer{qid}
      'var b=box(\'<div id="omWrapB"><div class="TiMu" qid="9102">' +
        '<div class="Zy_TItle"><span class="fontLabel">22.</span>【简答题】认不出的形状</div></div>' +
        '<div class="answerArea"><span id="omGhostB">（这里是个我们没认出来的编辑器壳）</span></div></div>\');' +
      // C：只有隐藏答案域（就是现场那份卷子的形状）
      'var c=box(\'<div id="omWrapC"><div class="TiMu" qid="9103">' +
        '<div class="Zy_TItle"><span class="fontLabel">23.</span>【简答题】只有隐藏域</div>' +
        '<input type="hidden" id="answer9103" value=""></div></div>\');' +
      'host.appendChild(a); host.appendChild(b); host.appendChild(c);' +
      'var app=window._xxtApp;' +
      'var elA=document.querySelector(".TiMu[qid=\\"9101\\"]");' +
      'var elB=document.querySelector(".TiMu[qid=\\"9102\\"]");' +
      'var elC=document.querySelector(".TiMu[qid=\\"9103\\"]");' +
      'var countIn=function(el,sel){try{return el.querySelectorAll(sel).length;}catch(e){return -1;}};' +
      // 现场形状的关键是「容器里**能打字的**控件为 0」—— C 里面那个 input 是隐藏提交域，
      // 按形状数它存在，但它不是答题框（`_isAnswerTextControl` 必须把它排除掉）。
      'var textIn=function(el){' +
      '  var list=countIn(el,"input, textarea, [contenteditable]");' +
      '  if(list<0) return -1;' +
      '  var n=0;var nodes=el.querySelectorAll("input, textarea, [contenteditable]");' +
      '  for(var i=0;i<nodes.length;i++){ if(app._isAnswerTextControl(nodes[i])) n++; }' +
      '  return n;' +
      '};' +
      'return {' +
      '  aInnerControls:textIn(elA),' +
      '  bInnerControls:textIn(elB),' +
      '  cInnerControls:textIn(elC),' +
      '  aOutsideBox:!!document.getElementById("omBoxA"),' +
      '  cHiddenField:!!document.getElementById("answer9103"),' +
      '  detectedAsText:!!(app._isAnswerTextControl(document.getElementById("omBoxA"))' +
      '    && !app._isAnswerTextControl(document.getElementById("answer9103")))' +
      '};})()'
    );
    // ⚠️ 这条是"形状与现场一致"的闸门：它红了说明 fixture 被改过，
    //    后面几条就变成在测一个不存在的形状（绿的，但守的东西没了）。
    check('装配：三道长题的容器内部都没有可打字控件（与现场一致）',
      setup && setup.aInnerControls === 0 && setup.bInnerControls === 0 && setup.cInnerControls === 0 &&
      setup.aOutsideBox === true && setup.cHiddenField === true && setup.detectedAsText === true,
      JSON.stringify(setup));

    var wrote = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var elA=document.querySelector(".TiMu[qid=\\"9101\\"]");' +
      'var elB=document.querySelector(".TiMu[qid=\\"9102\\"]");' +
      'var elC=document.querySelector(".TiMu[qid=\\"9103\\"]");' +
      'var rA=app._fillTextarea(elA,"容器外答案");' +
      'var rB=app._fillTextarea(elB,"认不出的形状也要记账");' +
      'var rC=app._fillTextarea(elC,"只有隐藏域");' +
      'var box=document.getElementById("omBoxA");' +
      'var qA={_element:elA,type:"short"}; var qC={_element:elC,type:"short"};' +
      'return {writtenA:rA, writtenB:rB, writtenC:rC,' +
      '  boxText:(box?box.textContent:"").trim(),' +
      '  judgedA:String(app._getQuizQuestionFilledValue(null,qA)||"").trim(),' +
      '  visibleC:String(app._readVisibleAnswerText(elC)||""),' +
      '  judgedC:String(app._getQuizQuestionFilledValue(null,qC)||"").trim(),' +
      '  hiddenValueC:document.getElementById("answer9103").value};})()'
    );
    check('答题框在容器外也写进去了（旧实现在这里一个字符都不写）',
      wrote && wrote.writtenA >= 1 && wrote.boxText === '容器外答案', JSON.stringify(wrote));
    check('判定也认这份答案（填答与判定必须对称，否则表单永远不满、永不提交）',
      wrote && wrote.judgedA.indexOf('容器外答案') !== -1, String(wrote && wrote.judgedA));
    check('只有隐藏域的形状：可见写入计数为 0 ——「答题框空着」从此有数可看',
      wrote && wrote.writtenC === 0 && wrote.hiddenValueC === '只有隐藏域' &&
      wrote.judgedC === '只有隐藏域' && wrote.visibleC === '', JSON.stringify(wrote));
    check('形状完全不认时同样是 0 个可见写入',
      wrote && wrote.writtenB === 0, JSON.stringify(wrote));

    // `_fillAnswers` 才是真实派发入口：0 个可见写入时它必须把结构快照那条日志记下去
    // （上面直接调 `_fillTextarea` 不该记 —— 记账归派发层，不是归填答层）。
    // 顺带把提交前审计一起跑真路：日志是 window message，在页面里挂个监听就能收到，
    // 不用猜"审计那五个数到底算出来没有"。
    var viaFlow = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var got=[];' +
      'window.addEventListener("message",function(e){' +
      '  var m=e.data; if(m&&m.source==="xxt_app"&&m.type==="runtime_log") got.push(m);});' +
      'var app=window._xxtApp;' +
      'var qs=[' +
      '  {_element:document.querySelector(".TiMu[qid=\\"9101\\"]"),type:"short",index:0},' +
      '  {_element:document.querySelector(".TiMu[qid=\\"9102\\"]"),type:"short",index:1},' +
      '  {_element:document.querySelector(".TiMu[qid=\\"9103\\"]"),type:"short",index:2}];' +
      'var before=[qs[0]._element,qs[1]._element,qs[2]._element].map(function(e){return e._omNoBoxDiagAt||0;});' +
      'app._fillAnswers([' +
      '  {index:0,type:"short",answer:"走派发层"},' +
      '  {index:1,type:"short",answer:"形状认不出"},' +
      '  {index:2,type:"short",answer:"隐藏域"}], qs, null);' +
      'var after=[qs[0]._element,qs[1]._element,qs[2]._element].map(function(e){return e._omNoBoxDiagAt||0;});' +
      // 同一个元素再来一次：闸必须还在（记一次就够，重复只会被自己刷成刷屏）。
      // ⚠️ 拿**哨兵值**比，不能比两次 Date.now() —— 这两次调用在同一个同步块里，
      //    毫秒级常常撞成同一个数，去掉闸也不会红（实测假绿过一次）。
      'qs[1]._element._omNoBoxDiagAt=12345;' +
      'app._fillAnswers([{index:1,type:"short",answer:"形状认不出第二次"}], qs, null);' +
      'var kept=qs[1]._element._omNoBoxDiagAt;' +
      // 提交前审计直接驱动（它在 `_maybeSubmitQuiz` 的一串闸后面，闸不开就轮不到它）
      'var auditRet=null;' +
      'try{auditRet=app._auditQuizFillBeforeSubmit([qs[0],qs[2]],null);}catch(err){auditRet={label:"(抛错)"+err.message};}' +
      'setTimeout(function(){' +
      '  var noBox=null, audit=null;' +
      '  got.forEach(function(m){' +
      '    if(m.message==="quiz fill: no visible answer box in question"&&!noBox) noBox=m;' +
      '    if(String(m.message||"").indexOf("quiz fill audit")===0) audit=m;});' +
      '  res({before:before, after:after, kept:kept, auditRet:auditRet,' +
      '    noBoxLevel:noBox?noBox.level:"", noBoxMeta:noBox?noBox.meta:null,' +
      '    auditLevel:audit?audit.level:"", auditMsg:audit?audit.message:"", auditMeta:audit?audit.meta:null,' +
      '    boxText:document.getElementById("omBoxA").textContent.trim()});' +
      '},300);});})()'
    );
    check('走 `_fillAnswers` 时长题的答案真的落到可见框里',
      viaFlow && viaFlow.boxText === '走派发层', JSON.stringify(viaFlow));
    check('派发层为「一个可见框都没写到」的题记下结构快照（写到了框的那题不受影响）',
      viaFlow && viaFlow.before[1] === 0 && viaFlow.after[1] > 0 &&
      viaFlow.after[2] > 0 && viaFlow.after[0] === 0, JSON.stringify(viaFlow));
    check('快照每个元素只记一次，不会每轮填答都刷屏',
      viaFlow && viaFlow.after[1] > 0 && viaFlow.kept === 12345, JSON.stringify(viaFlow));
    check('快照日志是 warn 级、带 qid 与各形状计数、且答案非空（answerLen>0 才说明是"找不到框"而不是"没答案"）',
      viaFlow && viaFlow.noBoxLevel === 'warn' && !!viaFlow.noBoxMeta &&
      String(viaFlow.noBoxMeta.qid) === '9102' && viaFlow.noBoxMeta.answerLen > 0 &&
      viaFlow.noBoxMeta.textInput === 0, JSON.stringify(viaFlow.noBoxMeta));
    check('审计方法返回的就是日志里那一条（拆成独立方法后两处仍然同源）',
      viaFlow && !!viaFlow.auditRet && viaFlow.auditRet.label === viaFlow.auditMsg &&
      viaFlow.auditRet.level === viaFlow.auditLevel,
      JSON.stringify(viaFlow && { ret: viaFlow.auditRet && viaFlow.auditRet.label, msg: viaFlow.auditMsg }));
    check('提交前审计发的是 warn：「有值」的题里有字的少了一题',
      viaFlow && viaFlow.auditLevel === 'warn' &&
      viaFlow.auditMsg === 'quiz fill audit: text answer not in a visible box',
      JSON.stringify(viaFlow && { level: viaFlow.auditLevel, msg: viaFlow.auditMsg }));
    check('审计把题号也交出来（textHidden 里就是那道"框里没字"的题）',
      viaFlow && !!viaFlow.auditMeta && viaFlow.auditMeta.text === 2 &&
      viaFlow.auditMeta.textVisible === 1 && String(viaFlow.auditMeta.textHidden) === '2',
      JSON.stringify(viaFlow && viaFlow.auditMeta));

    // 审计那条链：只看 A（可见框有字）与 C（只有隐藏域）这两题。
    // 这里刻意不真的交卷 —— 要证的只是「text 与 textVisible 这两个数会分开」，
    // 而分开之后仍然**不拦提交**（拦下来就回到"整卷卡死"那个老 bug 了）。
    var audit = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var qs=[{_element:document.querySelector(".TiMu[qid=\\"9101\\"]"),type:"short",index:0},' +
      '        {_element:document.querySelector(".TiMu[qid=\\"9103\\"]"),type:"short",index:2}];' +
      'var withValue=0, text=0, visible=0;' +
      'for(var i=0;i<qs.length;i++){' +
      '  if(!app._getQuizQuestionFilledValue(null,qs[i])) continue;' +
      '  withValue++; text++;' +
      '  if(String(app._readVisibleAnswerText(qs[i]._element)||"").trim()) visible++;' +
      '}' +
      'return {withValue:withValue, text:text, visible:visible,' +
      '  filledAll:app._areQuizAnswersFilled(null,qs,{})};})()'
    );
    check('审计会报「有值 2 题、框里真有字 1 题」（旧审计对这个差完全瞎）',
      audit && audit.withValue === 2 && audit.text === 2 && audit.visible === 1, JSON.stringify(audit));
    check('提交前置没被这次改动收紧（文字题仍按"读得到值"放行，不会因为框空着就卡死整卷）',
      audit && audit.filledAll === true, JSON.stringify(audit));

    var safety = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var elA=document.querySelector(".TiMu[qid=\\"9101\\"]");' +
      'app._fillTextarea(elA,"<img src=x onerror=alert(1)>");' +
      'var box=document.getElementById("omBoxA");' +
      // D：多空填空题 —— 三个可见空 + 一个隐藏提交域
      'var host=document.getElementById("Zyapl")||document.body;' +
      'var shell=document.createElement("div");' +
      'shell.innerHTML=\'<div id="omWrapD"><div class="TiMu" qid="9104">' +
        '<div class="Zy_TItle"><span class="fontLabel">24.</span>【填空题】三个空的填空题</div>' +
        '<input type="text" id="omBlankD1"><input type="text" id="omBlankD2"><input type="text" id="omBlankD3">' +
        '<input type="hidden" id="answer9104" value=""></div></div>\';' +
      'host.appendChild(shell);' +
      'var elD=document.querySelector(".TiMu[qid=\\"9104\\"]");' +
      'var n=app._fillText(elD,"甲|||乙|||丙");' +
      'return {html:box?box.innerHTML:"", tags:box?box.querySelectorAll("img").length:-1,' +
      '  fillCount:n,' +
      '  b1:document.getElementById("omBlankD1").value,' +
      '  b2:document.getElementById("omBlankD2").value,' +
      '  b3:document.getElementById("omBlankD3").value,' +
      '  hiddenD:document.getElementById("answer9104").value,' +
      '  visibleD:String(app._readVisibleAnswerText(elD)||"")};})()'
    );
    check('答案里的标签不会被当成 HTML 注进页面',
      safety && safety.tags === 0 && safety.html.indexOf('<img') === -1,
      String(safety && safety.html).slice(0, 120));
    check('_fillText 返回可见文本框的个数，多空按序各填一格（计数不能是"有没有"）',
      safety && safety.fillCount === 3 && safety.b1 === '甲' && safety.b2 === '乙' && safety.b3 === '丙',
      JSON.stringify(safety));
    check('隐藏提交域照旧拼成一串，可见读回来是分段的那三格（两边各有各的形状）',
      safety && safety.hiddenD === '甲乙丙' && safety.visibleD === '甲|||乙|||丙',
      JSON.stringify(safety));
  }
});

/** ---- 38. 单选「看得见」：分离控件那一族必须点穿文本层 ---- */
SCENARIOS.push({
  name: '单选看不见选中时要报出来',
  path: '/quiz',
  run: async function (ctx) {
    // 现场（2026-11-10 22:22 那份课后检测，用户原话）：
    //   「第二次到达，只回答的多选题，估计是乱选的，单选题一题也是空着的」
    // 而同一条卷子的日志是 `quiz fill audit ok {"checkedInDom":5,"choice":5,"missing":[]}`
    // —— 审计自证清白，用户眼睛看到的是白卷。差的正是这一层：
    //   ① 填答侧：作业/考试页「选项文本一列、radio 另一列」，代码只点了配到的那个 radio，
    //      站点挂在 `<a>` 上的选中态样式从没被触发 → 值有、页面空白；
    //   ② 审计侧：`input:checked` 命中一个 `display:none` 的原生控件也算"选中"。
    // 三个形状分开钉：A 有站点 handler（补点之后必须真的看得见）· B 没有 handler
    // （必须报出来，但仍然放行交卷 —— 与批次 6 同一取舍）· C 徽标形状（旧的那条路不能改坏）·
    // D 多选分离控件（**不许**走补点那一支：复选点第二次就是取消）。
    var setup = await ctx.client.evaluate(
      '(function(){' +
      'var host=document.getElementById("Zyapl")||document.body;' +
      'function box(html){var d=document.createElement("div"); d.innerHTML=html; return d.firstChild;}' +
      // A：文本列的 <a> 上有站点自己的选中态（模拟真机：点 <a> 才加 cur 类）
      'var a=box(\'<div class="Cy_TItle" qid="9201" typename="单选题">' +
        '<div class="Cy_TItle clearfix"><span class="fontLabel">31.</span>【单选题】分离控件带站点选中态</div>' +
        '<ul class="Cy_ulTop w-top">' +
          '<li><div class="clearfix"><a id="omLinkA" href="javascript:void(0)" ' +
            'onclick="document.getElementById(\\\'omLinkA\\\').classList.add(\\\'cur\\\')">B. 选项乙</a></div></li>' +
          '<li><div class="clearfix"><a href="javascript:void(0)">A. 选项甲</a></div></li>' +
        '</ul>' +
        '<ul class="Cy_ulBottom clearfix w-buttom">' +
          '<li><input type="radio" name="answer9201" value="B" style="display:none"></li>' +
          '<li><input type="radio" name="answer9201" value="A" style="display:none"></li>' +
        '</ul>' +
        '<input type="hidden" id="answer9201" value=""></div>\');' +
      // B：同样的形状，但 <a> 上没有 handler —— 值写得进、页面永远空白
      'var b=box(\'<div class="Cy_TItle" qid="9202" typename="单选题">' +
        '<div class="Cy_TItle clearfix"><span class="fontLabel">32.</span>【单选题】分离控件没有选中态</div>' +
        '<ul class="Cy_ulTop w-top">' +
          '<li><div class="clearfix"><a href="javascript:void(0)">A. 选项甲</a></div></li>' +
          '<li><div class="clearfix"><a href="javascript:void(0)">B. 选项乙</a></div></li>' +
        '</ul>' +
        '<ul class="Cy_ulBottom clearfix w-buttom">' +
          '<li><input type="radio" name="answer9202" value="A" style="display:none"></li>' +
          '<li><input type="radio" name="answer9202" value="B" style="display:none"></li>' +
        '</ul>' +
        '<input type="hidden" id="answer9202" value=""></div>\');' +
      // C：章节测验的徽标形状（.num_option + 可见 radio）—— 我们自己加 check_answer 的那一族
      'var c=box(\'<div class="TiMu" qid="9203" typename="单选题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">33.</span>【单选题】徽标形状</div></div>' +
        '<ul class="Zy_ulTop">' +
          '<li class="before-after" qid="9203" data="A"><label>' +
            '<input type="radio" name="answer9203" value="A">' +
            '<span class="num_option choice9203" data="A">A</span>' +
            '<span class="fl after">选项甲</span></label></li>' +
          '<li class="before-after" qid="9203" data="B"><label>' +
            '<input type="radio" name="answer9203" value="B">' +
            '<span class="num_option choice9203" data="B">B</span>' +
            '<span class="fl after">选项乙</span></label></li>' +
        '</ul>' +
        '<input type="hidden" id="answer9203" value=""></div>\');' +
      // D：多选分离控件 —— 补点会让"点两次=取消"重现，必须验证这条路**没**被牵连
      'var d=box(\'<div class="Cy_TItle" qid="9204" typename="多选题">' +
        '<div class="Cy_TItle clearfix"><span class="fontLabel">34.</span>【多选题】分离控件多选</div>' +
        '<ul class="Cy_ulTop w-top">' +
          '<li><div class="clearfix"><a href="javascript:void(0)">A. 甲</a></div></li>' +
          '<li><div class="clearfix"><a href="javascript:void(0)">B. 乙</a></div></li>' +
          '<li><div class="clearfix"><a href="javascript:void(0)">C. 丙</a></div></li>' +
        '</ul>' +
        '<ul class="Cy_ulBottom clearfix w-buttom">' +
          '<li><input type="checkbox" name="answer9204" value="A" style="display:none"></li>' +
          '<li><input type="checkbox" name="answer9204" value="B" style="display:none"></li>' +
          '<li><input type="checkbox" name="answer9204" value="C" style="display:none"></li>' +
        '</ul>' +
        '<input type="hidden" id="answer9204" value=""></div>\');' +
      'host.appendChild(a); host.appendChild(b); host.appendChild(c); host.appendChild(d);' +
      'var app=window._xxtApp;' +
      'var g=function(q){return document.querySelector(\'[qid="\'+q+\'"].Cy_TItle\')||document.querySelector(\'.TiMu[qid="\'+q+\'"]\');};' +
      'var elA=g("9201"), elB=g("9202"), elC=g("9203"), elD=g("9204");' +
      'var hid=function(q){return document.getElementById("answer"+q);};' +
      // 形状闸门：radio 必须**真的不可见**，否则 A/B 两条断言测的不是现场那一族
      'var vis=function(el){return !!el && ( !!el.offsetParent || (function(r){return !!r&&r.width>0&&r.height>0;})(el.getBoundingClientRect?el.getBoundingClientRect():null) );};' +
      'var radioA=elA.querySelectorAll("input[type=radio]");' +
      'var radioC=elC.querySelectorAll("input[type=radio]");' +
      'return {' +
      '  aFound:!!elA, bFound:!!elB, cFound:!!elC, dFound:!!elD,' +
      '  aRadioHidden:radioA.length===2 && !vis(radioA[0]),' +
      '  aTextItems:elA.querySelectorAll(".Cy_ulTop li").length,' +
      '  cRadioVisible:radioC.length===2 && vis(radioC[0]),' +
      '  pairingWorks:!!(function(){' +
      '    var items=app._getOptionItems(elA);' +
      '    return items.length===2 && !!(items[0]._optionInput||items[1]._optionInput);' +
      '  })(),' +
      '  detectedMultiple:(function(){var t=app._detectQuestionType(elD); return String(t);})(),' +
      '  hiddenIds:[hid(9201)?1:0,hid(9202)?1:0,hid(9203)?1:0,hid(9204)?1:0].join("")' +
      '};})()'
    );
    // ⚠️ 这条是"形状与现场一致"的闸门：红了说明 fixture 被改过，
    //    后面几条就变成在测一个不存在的形状（绿的，但守的东西没了）。
    check('装配：A/B 的 radio 确实不可见、C 的 radio 可见、文本列与控件列按索引配对成功',
      setup && setup.aFound && setup.bFound && setup.cFound && setup.dFound &&
      setup.aRadioHidden === true && setup.cRadioVisible === true &&
      setup.pairingWorks === true && setup.aTextItems === 2 && setup.hiddenIds === '1111',
      JSON.stringify(setup));

    var filled = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var g=function(q){return document.querySelector(\'[qid="\'+q+\'"].Cy_TItle\')||document.querySelector(\'.TiMu[qid="\'+q+\'"]\');};' +
      'var elA=g("9201"), elB=g("9202"), elC=g("9203"), elD=g("9204");' +
      // 走真实派发入口：_fillChoice / _fillMultiChoice（与 _fillAnswers 同一层）
      'app._fillChoice(elA,"B","radio");' +
      'app._fillChoice(elB,"A","radio");' +
      'app._fillChoice(elC,"A","radio");' +
      'app._fillMultiChoice(elD,["A","C"]);' +
      'var ck=function(el){return app._hasVisibleChoiceSelection(el);};' +
      'var dChecked=[];var di=elD.querySelectorAll("input[type=checkbox]");' +
      'for(var i=0;i<di.length;i++){ if(di[i].checked) dChecked.push(di[i].value); }' +
      'var bHidden=[];var bi=elB.querySelectorAll("input[type=radio]");' +
      'for(var j=0;j<bi.length;j++){ if(bi[j].checked) bHidden.push(bi[j].value); }' +
      'return {' +
      '  hiddenA:document.getElementById("answer9201").value,' +
      '  curA:document.getElementById("omLinkA").className.indexOf("cur")!==-1,' +
      '  visibleA:ck(elA),' +
      '  hiddenB:document.getElementById("answer9202").value,' +
      '  checkedB:bHidden.join(""),' +
      '  visibleB:ck(elB),' +
      '  visibleC:ck(elC),' +
      '  badgeC:(function(){var n=elC.querySelectorAll(".check_answer");return n.length;})(),' +
      '  hiddenD:document.getElementById("answer9204").value,' +
      '  checkedD:dChecked.sort().join("")' +
      '};})()'
    );
    check('A：点穿文本层把站点自己的选中态带起来了（旧实现只点隐藏 radio，页面一片空白）',
      filled && filled.curA === true && filled.hiddenA === 'B' && filled.visibleA === true,
      JSON.stringify(filled && { hiddenA: filled.hiddenA, curA: filled.curA, visibleA: filled.visibleA }));
    check('B：值写进去了但看不见选中 —— 判定必须说"看不见"（这就是用户眼里那道空着的单选）',
      filled && filled.hiddenB === 'A' && filled.checkedB === 'A' && filled.visibleB === false,
      JSON.stringify(filled && { hiddenB: filled.hiddenB, checkedB: filled.checkedB, visibleB: filled.visibleB }));
    check('C：徽标形状仍然算看得见（旧那条路不能被这次改动改坏）',
      filled && filled.visibleC === true && filled.badgeC === 1,
      JSON.stringify(filled && { visibleC: filled.visibleC, badgeC: filled.badgeC }));
    check('D：多选分离控件**没有**被补点牵连 —— 该选两项就选两项（点两次会切成一项）',
      filled && filled.hiddenD === 'AC' && filled.checkedD === 'AC',
      JSON.stringify(filled && { hiddenD: filled.hiddenD, checkedD: filled.checkedD }));

    // 审计 + 结构快照走真路：`_fillAnswers` 派发层记账 + `_auditQuizFillBeforeSubmit` 计数。
    var viaAudit = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){' +
      'var got=[];' +
      'window.addEventListener("message",function(e){' +
      '  var m=e.data; if(m&&m.source==="xxt_app"&&m.type==="runtime_log") got.push(m);});' +
      'var app=window._xxtApp;' +
      'var g=function(q){return document.querySelector(\'[qid="\'+q+\'"].Cy_TItle\')||document.querySelector(\'.TiMu[qid="\'+q+\'"]\');};' +
      'var elA=g("9201"), elB=g("9202");' +
      // 把两道题重走一遍派发层（派发层才会记结构快照，直接调 _fillChoice 不会）
      'var qs=[{_element:elA,type:"single",index:0},{_element:elB,type:"single",index:1}];' +
      'app._fillAnswers([{index:0,type:"single",answer:"B"},{index:1,type:"single",answer:"A"}], qs, null);' +
      // 快照每个元素只记一次：拿哨兵值比，不能比两次 Date.now()（同批同步块里会撞成同一个数）
      'var keptBefore=(elB._omNoCheckDiagAt||0)>0;' +
      'elB._omNoCheckDiagAt=23456;' +
      'app._fillAnswers([{index:1,type:"single",answer:"A"}], qs, null);' +
      'var kept=elB._omNoCheckDiagAt;' +
      'var auditRet=null;' +
      'try{auditRet=app._auditQuizFillBeforeSubmit(qs,null);}catch(err){auditRet={label:"(抛错)"+err.message};}' +
      'setTimeout(function(){' +
      '  var snap=null, audit=null;' +
      '  got.forEach(function(m){' +
      '    if(m.message==="quiz fill: no visible selection in question"&&!snap) snap=m;' +
      '    if(String(m.message||"").indexOf("quiz fill audit")===0) audit=m;});' +
      '  res({keptBefore:keptBefore, kept:kept, auditRet:auditRet,' +
      '    snapLevel:snap?snap.level:"", snapMeta:snap?snap.meta:null,' +
      '    auditLevel:audit?audit.level:"", auditMsg:audit?audit.message:"", auditMeta:audit?audit.meta:null,' +
      '    ready:app._areQuizAnswersFilled(null,qs,{})});' +
      '},300);});})()'
    );
    check('派发层为「有值却看不见选中」的题记下选项结构快照（看得见的那题不记）',
      viaAudit && viaAudit.snapLevel === 'warn' && !!viaAudit.snapMeta &&
      String(viaAudit.snapMeta.qid) === '9202' && viaAudit.snapMeta.badge === 0 &&
      viaAudit.snapMeta.radio === 2, JSON.stringify(viaAudit && viaAudit.snapMeta));
    check('快照每个元素只记一次，不会每轮填答都刷屏',
      viaAudit && viaAudit.keptBefore === true && viaAudit.kept === 23456,
      JSON.stringify(viaAudit && { keptBefore: viaAudit.keptBefore, kept: viaAudit.kept }));
    check('审计不再自证清白：choice=2 而 checkedInDom=1，发的是 warn',
      viaAudit && viaAudit.auditLevel === 'warn' &&
      viaAudit.auditMsg === 'quiz fill audit: value without visible selection' &&
      !!viaAudit.auditMeta && viaAudit.auditMeta.choice === 2 &&
      viaAudit.auditMeta.checkedInDom === 1 && String(viaAudit.auditMeta.missing) === '1',
      JSON.stringify(viaAudit && { msg: viaAudit.auditMsg, meta: viaAudit.auditMeta }));
    check('审计方法返回的就是日志里那一条（两处同源）',
      viaAudit && !!viaAudit.auditRet && viaAudit.auditRet.label === viaAudit.auditMsg &&
      viaAudit.auditRet.level === viaAudit.auditLevel,
      JSON.stringify(viaAudit && { ret: viaAudit.auditRet && viaAudit.auditRet.label, msg: viaAudit.auditMsg }));
    // ⚠️ 这条钉住那个**取舍**：看得见与否只提醒，不拦交卷。
    // 升级成拦住就会回到「整卷永远不交」那个老 bug（批次 6 同一件事）。
    check('提交前置没被这次改动收紧（看不见选中仍然可以交，只是日志会喊）',
      viaAudit && viaAudit.ready === true, String(viaAudit && viaAudit.ready));
  }
});

/** ---- 39. 「直接下一页、然后卡住」：_dismissPopups 不许点页面常驻的导航 ---- */
SCENARIOS.push({
  name: '关弹窗不点常驻的下一节',
  path: '/quiz',
  run: async function (ctx) {
    // 现场（2026-11-10 19:12~19:13 日志，用户描述「检测题目→之后不检测→直接下一页→卡住」）：
    //   `skip completed` → `dismiss popups: click {"cls":"jb_btn jb_btn_92 fs14 prev_next next fr …","matched":"下一节"}`
    //   → 页面被带去 `https://i.chaoxing.com/base?…`（那里没有课程结构可认）
    //   → 只剩 `search job: no attachments and no synthetic job` 每分钟一条
    //   → `study stuck` 打一条之后彻底静默。
    // 根因是 `_dismissPopups` **整页**按文案扫按钮：章节页**常驻**的「下一节」导航
    // 和弹窗里那个「下一节」文案一模一样，光看文字分不出来。翻页有它自己的路
    // （`_switchToNextLearningCard()` 与 `nextUnit()` 的 `#prevNextFocusNext`），不归这个函数管。
    var setup = await ctx.client.evaluate(
      '(function(){' +
      'var host=document.body;' +
      'function box(html){var d=document.createElement("div"); d.innerHTML=html; return d.firstChild;}' +
      // ① 章节页常驻的上一节/下一节（就是日志里那两个 class）
      'var nav=box(\'<div id="omNavZone"><div class="prevNext_wrapper clearfix">' +
        '<a id="omNavNext" href="javascript:void(0)" class="jb_btn jb_btn_92 fs14 prev_next next fr btnWidAuto">下一节</a>' +
        '</div></div>\');' +
      'host.appendChild(nav);' +
      'var clicks={};' +
      '["omNavNext"].forEach(function(id){' +
      '  var el=document.getElementById(id);' +
      '  el.addEventListener("click",function(){ clicks[id]=(clicks[id]||0)+1; },false);});' +
      'return {navFound:!!document.getElementById("omNavNext"),' +
      '  navVisible:!!(function(){var e=document.getElementById("omNavNext");return !!e.offsetParent;})()};})()'
    );
    check('装配：常驻的「下一节」导航在页面上可见（它才是旧实现抓走的那个）',
      setup && setup.navFound === true && setup.navVisible === true, JSON.stringify(setup));

    // ① 只有常驻导航时：什么都不许点
    var navOnly = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var el=document.getElementById("omNavNext");' +
      // 计数器先落在属性上，**没点**才能读出 "0"；否则读回 null，
      // 断言会把"一次都没点"误报成失败（实测踩过：返回 false 是对的，n 却是 null）。
      'el.setAttribute("data-n","0");' +
      'el.onclick=function(){' +
      '  el.setAttribute("data-n", String((parseInt(el.getAttribute("data-n"),10)||0)+1));' +
      '};' +
      'var ret=app._dismissPopups();' +
      'return {ret:ret, n:el.getAttribute("data-n")};})()'
    );
    check('只有常驻「下一节」时 _dismissPopups 返回 false 且一次都不点（旧实现在这里就翻页了）',
      navOnly && navOnly.ret === false && navOnly.n === '0', JSON.stringify(navOnly));

    // ② 弹窗里确实有按钮：仍然要点（旧行为不能改坏 —— 关掉弹窗是它的本职）
    var withDialog = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var d=document.createElement("div");' +
      'd.innerHTML=\'<div id="omLayer" class="layui-layer" style="position:fixed;left:0;top:0;width:300px;height:200px">' +
        '<div class="layui-layer-content">检测到有新的微课，是否继续学习？</div>' +
        '<a id="omLayerGo" class="layui-layer-btn0">继续</a></div>\';' +
      'document.body.appendChild(d);' +
      'var hit=0; var btn=document.getElementById("omLayerGo");' +
      'btn.onclick=function(){ hit++; btn.parentNode.style.display="none"; };' +
      'var ret=app._dismissPopups();' +
      'var nav=document.getElementById("omNavNext");' +
      'var r={ret:ret, hit:hit, navN:nav.getAttribute("data-n"), layerClosed:btn.parentNode.style.display==="none"};' +
      'd.remove(); if(window._omDialogs) window._omDialogs={}; return r;})()'
    );
    check('弹窗里的「继续」照旧点得掉（收紧范围不能把本职改成失灵）',
      withDialog && withDialog.ret === true && withDialog.hit === 1,
      JSON.stringify(withDialog));

    // ③ 交卷确认框：不许代答（点了"确定"就是替用户交卷）
    var submitDialog = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var d=document.createElement("div");' +
      'd.innerHTML=\'<div id="omWorkpop" class="layui-layer" style="position:fixed;left:0;top:0;width:300px;height:200px">' +
        '<div class="layui-layer-content">请完成所有题目，确认提交？</div>' +
        '<a id="omOkSubmit" class="layui-layer-btn0">确定</a>' +
        '<a id="omCloseSubmit" class="layui-layer-close2">×</a></div>\';' +
      'document.body.appendChild(d);' +
      'var ok=0, cl=0;' +
      'document.getElementById("omOkSubmit").onclick=function(){ok++;};' +
      'document.getElementById("omCloseSubmit").onclick=function(){cl++;};' +
      'var r=app._dismissPopups();' +
      'var r2={ret:r, ok:ok, cl:cl};' +
      'd.remove(); return r2;})()'
    );
    check('交卷确认框谁都不点（确定=替用户交卷，关闭也会丢掉那道提示）',
      submitDialog && submitDialog.ret === false && submitDialog.ok === 0 && submitDialog.cl === 0,
      JSON.stringify(submitDialog));

    // ④ 双保险：导航就算被裹进一个"看起来像弹窗"的壳里，带 prev_next 的仍然不许点
    var wrapped = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var d=document.createElement("div");' +
      'd.innerHTML=\'<div id="omModalShell" class="layui-layer" style="position:fixed;left:0;top:0;width:300px;height:200px">' +
        '<a id="omNavInShell" class="jb_btn prev_next next fr">下一节</a></div>\';' +
      'document.body.appendChild(d);' +
      'var n=0; document.getElementById("omNavInShell").onclick=function(){n++;};' +
      'var r=app._dismissPopups();' +
      'var out={ret:r, n:n}; d.remove(); return out;})()'
    );
    check('带 prev_next 的导航即使被裹进弹窗壳里也不点（第二道保险）',
      wrapped && wrapped.ret === false && wrapped.n === 0, JSON.stringify(wrapped));

    // ⑤ `[class*="close"]` 这一族最宽，页面上常驻的关闭/退出按钮都会被它抓到
    var closeOnly = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var d=document.createElement("div");' +
      'd.innerHTML=\'<div id="omPageTop"><a id="omPageClose" class="closeBtn">退出课程</a></div>\';' +
      'document.body.appendChild(d);' +
      'var n=0; document.getElementById("omPageClose").onclick=function(){n++;};' +
      'var r=app._dismissPopups();' +
      'var out={ret:r, n:n}; d.remove(); return out;})()'
    );
    check('页面常驻的「关闭/退出」不被当成弹窗关闭按钮（容器外就不归它管）',
      closeOnly && closeOnly.ret === false && closeOnly.n === 0, JSON.stringify(closeOnly));
  }
});

/** ---- 40. 确认交卷弹窗不许把提交次数记到另一本账上 ---- */
SCENARIOS.push({
  name: '确认框交卷要记在同一份卷子的账上',
  path: '/submit-key',
  run: async function (ctx) {
    // 现场（用户日志里那句「一份卷子两个键」，批次 8 立案）：
    //   交卷确认弹窗那一路调的是 `_getQuizWorkKey(null)` / `_markQuizSubmitPending(null, …)`，
    //   `null` 经 `_resolveQuizSubmitDocument` 退回**外层文档**；可题目挂在另一个 iframe 里，
    //   ready 键、交卷上限、按卷冷却用的全是**题目那份文档**的键。
    //   于是提交次数记在 A 本账、`_shouldSkipQuizBySubmitAttempts` 读 B 本账永远读到 0 ——
    //   「靠猜补过题的卷子只许交 2 次」这条上限形同不存在，表现成用户报过的**疯狂提交**。
    var innerReady = await waitFor(ctx.client,
      '(function(){var f=document.getElementById("quizFrame");' +
      'if(!f||!f.contentDocument)return false;' +
      'return f.contentDocument.querySelectorAll(".TiMu").length===5;})()', 15000);
    check('装配：题目确实在子 iframe 里（外层那份文档一道题都没有）', innerReady === true);
    if (!innerReady) return;

    var shape = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      // 主循环每秒也会走到确认框那一路，先停掉 —— 下面的计数才只属于这一次驱动
      'try{app._clearTickLoop();}catch(e){}' +
      // ⚠️ 批次 13-A 之后，「null 退回外层算出另一本粗账」这条前提被**两层**保护同时兜住了：
      //   ① 深走 `_findQuizPaperDocumentBelow` 让 null 直接落到题目那份文档（键从根上就归一了）
      //   ② 批次 8 的槽位归一 `_getQuizSubmitAttemptKey`（手里有题目文档时改道到 ready 键）
      // 把①留着，下面这批"归一"断言就永远绿 —— ②坏了也不会响（AGENTS §5 说的就是这种）。
      // 所以这一段**先把①关掉**（深走返回 null = 回到 13-A 之前的一层跳转行为），
      // 让夹具重新造出"两本账"，后面测的就只剩②；再用一条对照断言证明①本身也在归一。
      'app._realFindPaperBelow=app._findQuizPaperDocumentBelow;' +
      'app._findQuizPaperDocumentBelow=function(){return null;};' +
      'var qs=app._extractQuestions(document);' +
      'var owner=app._getQuizDocumentFromQuestions(qs);' +
      'var keyOf=function(d){return String(app._getQuizWorkKey(d)||"");};' +
      'var ids=function(d){var out=[];' +
      '  ["courseId","classId","workId","jobid","knowledgeid"].forEach(function(k){' +
      '    if(d.getElementById(k))out.push(k);});return out.join(",");};' +
      'var splitOff=keyOf(null)!==keyOf(owner), coarseOff=keyOf(null);' +
      'app._findQuizPaperDocumentBelow=app._realFindPaperBelow;' +
      'var splitOn=keyOf(null)!==keyOf(owner);' +
      'app._findQuizPaperDocumentBelow=function(){return null;};' +
      'return {n:qs.length, ownerIsInner:!!owner&&owner!==document,' +
      '  outerIds:ids(document), innerIds:owner?ids(owner):"", ' +
      '  splitOff:splitOff, splitOn:splitOn, coarseOff:coarseOff, ' +
      '  outerKey:keyOf(null), ownerKey:keyOf(owner)};})()'
    );
    check('装配：外层只有 courseId + knowledgeid，题目那份文档五个 id 齐全（与残缺现场一致）',
      shape && shape.outerIds === 'courseId,knowledgeid' &&
      shape.innerIds === 'courseId,classId,workId,jobid,knowledgeid',
      JSON.stringify(shape && { outerIds: shape.outerIds, innerIds: shape.innerIds }));
    check('闸门分两层：关掉 13-A 的深走后 null 仍算出**另一本粗账**（后面几条测的是批次 8 的归一，不是空测）',
      shape && shape.n === 5 && shape.ownerIsInner === true && shape.splitOff === true,
      JSON.stringify(shape && { n: shape.n, ownerIsInner: shape.ownerIsInner, outerKey: shape.outerKey, ownerKey: shape.ownerKey }));
    check('13-A 的深走自己也把粗账归一了：开着它时 null 与题目文档同键（两层都在兜，缺一不可）',
      shape && shape.splitOn === false,
      JSON.stringify(shape && { splitOff: shape.splitOff, splitOn: shape.splitOn }));

    // 真跑一遍答题：ready 键要由生产代码自己写下，手抄一个键等于测自己的夹具。
    // ⚠️ 必须走 writeConfig 把配置写进扩展存储：`hasApiKey` 只留在页面里，
    // 真实模型那一趟不会跑，`_quizReadyToSubmit` 永远不成立，
    // `_handleSubmitConfirmDialog` 会在 readyForConfirm 闸门上短路 —— 于是整场空测。
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      enableQuiz: true, enableCaptcha: false, enableDiscussion: false, autoNext: false,
      randomAnswer: false, quizMaxSubmitAttempts: 2
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app.configs.hasApiKey=true;' +
      'app._quizApiFailUntil=0;app._quizForceSkipUntil=0;app._quizForceSkipPaperKey="";' +
      'app._quizAnswered=false;app._quizInProgress=false;app._quizSubmitPending=false;' +
      'app._quizCurrentQuestions=null;app._quizReadyWorkKey="";app._quizReadyToSubmit=false;' +
      'app._handleQuiz(null);return true;})()'
    );
    var ready = await waitFor(ctx.client,
      '(function(){return window._xxtApp._quizReadyToSubmit===true;})()', 25000);
    var readyKey = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var owner=app._getQuizDocumentFromQuestions(app._quizCurrentQuestions);' +
      'return {readyKey:String(app._quizReadyWorkKey||""),ownerKey:String(app._getQuizWorkKey(owner)||""),' +
      '  nullKey:String(app._getQuizWorkKey(null)||"")};})()'
    );
    check('整卷答完后 ready 键按**题目那份文档**写下（生产代码自己算的，不是夹具喂的）',
      ready === true && !!readyKey && readyKey.readyKey !== '' &&
      readyKey.readyKey === readyKey.ownerKey && readyKey.ownerKey !== readyKey.nullKey,
      JSON.stringify(readyKey));

    var drive1 = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'var owner=app._getQuizDocumentFromQuestions(app._quizCurrentQuestions);' +
      // 旧写法**唯一写过**的那本粗账（`null` → 主文档算出的键）：现在归一之后它不该再被写，' +
      // 清它只能直接动 sessionStorage —— `_clearQuizSubmitAttemptCount(null)` 已经会归到细账上了。' +
      'var coarseSlot=String(app._getQuizWorkKey(null)||"")+".submitAttempts";' +
      'try{sessionStorage.removeItem(coarseSlot);}catch(e){}' +
      'app._clearQuizSubmitAttemptCount(owner);' +
      'app._quizSubmitPending=false;app._submitConfirmLastClickAt=0;' +
      'var got=[];window.addEventListener("message",function(e){' +
      '  var m=e.data;if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'var dlg=app._checkSubmitConfirmDialog();' +
      'var before=window.__omOkClicks;' +
      'var ret=app._handleSubmitConfirmDialog(dlg);' +
      'setTimeout(function(){' +
      '  var pend=null;got.forEach(function(m){if(m.message==="quiz submit pending")pend=m;});' +
      '  res({dlgFound:!!dlg,ret:ret,okClicks:window.__omOkClicks-before,' +
      '    countOwner:app._getQuizSubmitAttemptCount(owner),countNull:app._getQuizSubmitAttemptCount(null),' +
      '    sameSlot:String(app._getQuizSubmitAttemptKey(null))===String(app._getQuizSubmitAttemptKey(owner)),' +
      '    coarseRaw:(function(){try{return Number(sessionStorage.getItem(coarseSlot)||0);}catch(e){return -1;}})(),' +
      '    pendHasLog:!!pend,pendKey:pend?String(pend.meta&&pend.meta.key||""):"", ' +
      '    pendFrom:pend?String(pend.meta&&pend.meta.accountFrom||""):"", ' +
      '    pendReady:pend?String(pend.meta&&pend.meta.readyKey||""):""});' +
      '},300);});})()'
    );
    check('确认框找得到、也真的点了「确定」（收紧键的口径不能把交卷这一步做没）',
      drive1 && drive1.dlgFound === true && drive1.ret === true && drive1.okClicks === 1,
      JSON.stringify(drive1));
    check('提交次数记在**题目那份文档**的账上（旧写法记到另一个键，这一条就是 0）',
      drive1 && drive1.countOwner === 1, 'countOwner=' + (drive1 && drive1.countOwner));
    check('读账端**拿不到文档**时问的也是同一本账：槽位归一，旧那本粗账一个字节都没落下',
      drive1 && drive1.sameSlot === true && drive1.countNull === 1 && drive1.coarseRaw === 0,
      JSON.stringify(drive1 && { sameSlot: drive1.sameSlot, countNull: drive1.countNull, coarseRaw: drive1.coarseRaw }));
    check('日志里 key 与 readyKey 相等、且写明键出自哪里 ——「一份卷子两个键」从此能自证（本批新加的两格）',
      drive1 && drive1.pendHasLog === true && drive1.pendKey !== '' &&
      drive1.pendKey === drive1.pendReady && drive1.pendFrom === 'caller',
      JSON.stringify(drive1 && { key: drive1.pendKey, readyKey: drive1.pendReady, accountFrom: drive1.pendFrom }));

    var drive2 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var owner=app._getQuizDocumentFromQuestions(app._quizCurrentQuestions);' +
      'app._quizSubmitPending=false;app._submitConfirmLastClickAt=0;' +
      'app._handleSubmitConfirmDialog(app._checkSubmitConfirmDialog());' +
      'return {countOwner:app._getQuizSubmitAttemptCount(owner),' +
      '  countNull:app._getQuizSubmitAttemptCount(null),' +
      '  skipOwner:app._shouldSkipQuizBySubmitAttempts(owner),' +
      '  skipNull:app._shouldSkipQuizBySubmitAttempts(null)};})()'
    );
    check('连交两次就到顶：上限读到的是**同一本账**（旧写法这里永远 false）',
      drive2 && drive2.countOwner === 2 && drive2.skipOwner === true, JSON.stringify(drive2));
    check('调用点没有文档时上限**照样生效** —— 疯狂提交真被拦住（旧写法这里是 false，等于没上限）',
      drive2 && drive2.countNull === 2 && drive2.skipNull === true, JSON.stringify(drive2));

    var redo = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var owner=app._getQuizDocumentFromQuestions(app._quizCurrentQuestions);' +
      'document.querySelector("#omConfirmLayer .layui-layer-content").textContent="很遗憾，未达到及格线，请重做";' +
      'app._quizAnswered=true;app._quizReadyToSubmit=true;app._quizSubmitPending=false;' +
      'app._submitConfirmLastClickAt=0;' +
      'var before=app._getQuizSubmitAttemptCount(owner);' +
      'app._handleSubmitConfirmDialog(app._checkSubmitConfirmDialog());' +
      'return {answered:app._quizAnswered,ready:app._quizReadyToSubmit,readyKey:app._quizReadyWorkKey,' +
      '  before:before,countOwner:app._getQuizSubmitAttemptCount(owner)};})()'
    );
    check('「没过请重做」那一路照旧清空答题状态、且**不记**提交次数（重做不该消耗交卷次数）',
      redo && redo.answered === false && redo.ready === false &&
      redo.countOwner === redo.before, JSON.stringify(redo));

    var fallback = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'document.querySelector("#omConfirmLayer .layui-layer-content").textContent="请完成所有题目，确认提交？";' +
      'app._quizCurrentQuestions=null;' +
      'app._quizAnswered=true;app._quizReadyToSubmit=true;app._quizSubmitPending=false;' +
      'app._submitConfirmLastClickAt=0;' +
      'var coarseSlot=String(app._getQuizWorkKey(null)||"")+".submitAttempts";' +
      'try{sessionStorage.removeItem(coarseSlot);}catch(e){}' +
      'var before=app._getQuizSubmitAttemptCount(null);' +
      'var ret=app._handleSubmitConfirmDialog(app._checkSubmitConfirmDialog());' +
      'var raw=(function(){try{return Number(sessionStorage.getItem(coarseSlot)||0);}catch(e){return -1;}})();' +
      'return {ret:ret,before:before,delta:app._getQuizSubmitAttemptCount(null)-before,coarseRaw:raw};})()'
    );
    check('认不出题目文档时退回旧行为：仍能交卷、仍记一次（不能因为拿不到文档就吞掉提交）',
      fallback && fallback.ret === true && fallback.delta === 1, JSON.stringify(fallback));
    check('这一趟记的是**那本粗账**（归一只在手里有题目文档时才改道，退化路径没被改坏）',
      fallback && fallback.before === 0 && fallback.coarseRaw === 1, JSON.stringify(fallback));

    // 关掉深走是给上面这一批用的；场景结束必须还原（下一个场景会重新导航，
    // 但夹具与生产判据的差集不该靠"反正会刷新"来收尾）。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'if(app._realFindPaperBelow)app._findQuizPaperDocumentBelow=app._realFindPaperBelow;' +
      'return !!app._realFindPaperBelow;})()');
  }
});

/** ---- 41. 刷课页不许被当成讨论页发帖（批次 9-A，真实日志 00:46:26） ---- */
SCENARIOS.push({
  name: '刷课页不许被当成讨论页发帖',
  path: '/mycourse/studentstudy',
  run: async function (ctx) {
    // 现场：卷子刚 `quiz submit pending` 两秒，插件就报 `discussion page detected`，
    // 往平台真发了一条内容「1」的回帖，而它点的按钮文字含「提交」（很可能正是那份卷子的）。
    // 三条放宽叠起来才会成立：return_url 永不过期 + 正文有「讨论」二字 + 按钮按文字满页找。
    var shape = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;try{app._clearTickLoop();}catch(e){}' +
      'var ed=app._findDiscussionEditor();' +
      'var btn=document.getElementById("quizSubmit");' +
      'var bodyHit=/讨论|话题|回帖|发帖|发表回复|我的回复|发布话题/.test(String(document.body.innerText||"").slice(0,3000));' +
      'var at=0;try{at=Number(localStorage.getItem("omitone_return_url_at")||0);}catch(e){}' +
      'return {editor:!!ed,btn:!!btn&&btn.offsetHeight>0,bodyHit:bodyHit,' +
      '  relaxFresh:at>0&&Date.now()-at<120000,studyUrl:/\\/mycourse\\/studentstudy/.test(location.href)};})()'
    );
    check('装配闸门：这一页真的长得像出事那天（可见编辑区 + 含「提交」的按钮 + 正文有「讨论」+ 放宽是新鲜的）',
      shape && shape.editor === true && shape.btn === true && shape.bodyHit === true &&
      shape.relaxFresh === true && shape.studyUrl === true, JSON.stringify(shape));
    if (!shape || !shape.editor || !shape.btn) return;

    var judge = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      // 页面加载时 tick 已经自己判过一轮，那条拒绝日志可能早发过了（30 秒节流）——
      // 先清节流，才能断言"**这一声**是生产判据自己喊出来的"
      'app._discussionDeclineLogAt=0;app._discussionDeclineSignature="";' +
      'var page=app._computeDiscussionPage();' +
      'var context=app._isDiscussionContext();' +
      'app._discussionPageAt=0;' +
      'var gate=app._isDiscussionPage();' +
      // 日志是 postMessage 异步送达的：不等一拍就去读 got，读到的是空（假阴性）
      'setTimeout(function(){' +
      'var decl=null;got.forEach(function(m){if(m.message==="discussion page declined")decl=m;});' +
      'res({page:page,context:context,gate:gate,seen:got.length,' +
      '  reason:decl?String(decl.meta&&decl.meta.reason||""):"(无)"});},300);});})()'
    );
    check('生产判据自己说这不是讨论页（`_computeDiscussionPage()` 为 false）',
      judge && judge.page === false, JSON.stringify(judge));
    check('整条讨论链路都不进（`_isDiscussionContext` 与 `_isDiscussionPage` 双 false）',
      judge && judge.context === false && judge.gate === false, JSON.stringify(judge));
    check('拒绝必须留话且指认到闸：reason=study-page（静默拒绝等于下次还得靠猜）',
      judge && judge.reason === 'study-page', 'reason=' + (judge && judge.reason));

    var live = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'app._discussionPosted=false;app._discussionBusy=false;app._discussionExpanded=false;' +
      'var before=window.__submitClicks;' +
      'Promise.resolve(app._runTick()).then(function(){' +
      '  setTimeout(function(){' +
      '    var talk=0;got.forEach(function(m){' +
      '      if(m.message==="discussion reply submitted"||m.message==="discussion page detected, posting reply")talk++;});' +
      '    res({clicks:window.__submitClicks-before,talkLogs:talk});' +
      '  },600);' +
      '}).catch(function(err){res({error:String(err&&err.message||err)});});});})()'
    );
    check('真跑一轮 tick：卷子的「提交」按钮一次都没被点（旧写法会把它当发帖按钮点掉）',
      live && live.clicks === 0, JSON.stringify(live));
    check('真跑一轮 tick：也没有任何"检测到讨论页 / 已发回帖"的动作',
      live && live.talkLogs === 0, JSON.stringify(live));
  }
});

/** ---- 42. 真讨论页仍要认得出，且三道闸各自都关得上（批次 9-A 对照组） ---- */
SCENARIOS.push({
  name: '真讨论页仍认得出且按钮必须同容器',
  path: '/course/topic/discuss',
  run: async function (ctx) {
    var ok = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;try{app._clearTickLoop();}catch(e){}' +
      // 讨论链路的总开关必须由夹具钉住：扩展存储是**整轮共用**的，前一个场景写的
      // `enableDiscussion:false` 会让"仍能认出讨论页"这几条永远读到 false（定向跑才看不出来）
      'app.configs.enableDiscussion=true;' +
      'var ed=app._findDiscussionEditor();' +
      'var btn=ed?app._findDiscussionSubmitButton(ed):null;' +
      // 「同一块容器」按生产判据的口径量：从编辑区往上最多 4 层，第一块装着按钮的祖先；
      // 一路走到 body 就是"整页随便找个按钮"，那正是要拦的形状
      'var nca="(none)";var box=ed;' +
      'for(var i=0;i<=4&&box;i++){' +
      '  if(box===document.body||box===document.documentElement){nca="(body)";break;}' +
      '  if(btn&&box.contains&&box.contains(btn)){nca=String(box.id||box.className||"box");break;}' +
      '  box=box.parentElement||null;}' +
      'return {editor:!!ed,btnId:btn?String(btn.id||""):"(无)",nca:nca,' +
      '  sameBox:nca!=="(none)"&&nca!=="(body)",page:app._computeDiscussionPage()};})()'
    );
    check('装配闸门：真讨论页的编辑区与「回复」按钮在同一块容器里',
      ok && ok.editor === true && ok.sameBox === true, JSON.stringify(ok));
    // ⚠️ 这一条是"收紧判据没把功能做没"的唯一证明：批次 9-A 只准关掉误判，不准关掉发帖
    check('真讨论页**仍然**被认出可发帖（收紧后没把正常链路做没）',
      ok && ok.page === true, JSON.stringify(ok));
    check('按钮取到的是编辑区里那个「回复」（id=doReply），不是满页找到的别的按钮',
      ok && ok.btnId === 'doReply', 'btnId=' + (ok && ok.btnId));

    var moved = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'var btn=document.getElementById("doReply");' +
      'document.body.appendChild(btn);' +   // 把发布按钮搬出编辑区容器
      'app._discussionDeclineLogAt=0;app._discussionDeclineSignature="";' +
      'var page=app._computeDiscussionPage();' +
      'setTimeout(function(){' +
      'var decl=null;got.forEach(function(m){if(m.message==="discussion page declined")decl=m;});' +
      'res({page:page,seen:got.length,reason:decl?String(decl.meta&&decl.meta.reason||""):"(无)"});},300);});})()'
    );
    check('按钮与编辑区**不同容器**时判据关得上门（这一路不再满页找「提交」去点）',
      moved && moved.page === false && moved.reason === 'no-co-located-submit', JSON.stringify(moved));

    var flight = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'document.querySelector(".replyEditBtnGroup").appendChild(document.getElementById("doReply"));' +
      'app.configs.enableDiscussion=true;' +
      // 页面加载期跑过的 tick 可能留下答题状态（那本身就是"在飞"的一种），先归零再逐条造
      'var leak={inProgress:!!app._quizInProgress,submitPending:!!app._quizSubmitPending,readyToSubmit:!!app._quizReadyToSubmit};' +
      'app._quizInProgress=false;app._quizInProgressAt=0;app._quizSubmitPending=false;app._quizReadyToSubmit=false;' +
      'app._discussionPageAt=0;app._quizSubmitPending=true;' +
      'var duringGate=app._isDiscussionPage();' +
      'app._quizSubmitPending=false;app._quizReadyToSubmit=true;app._discussionPageAt=0;' +
      'var duringReady=app._isDiscussionPage();' +
      'app._quizReadyToSubmit=false;app._discussionPageAt=0;' +
      'var after=app._isDiscussionPage();' +
      'return {duringGate:duringGate,duringReady:duringReady,after:after,leak:leak,' +
      '  btnOk:!!app._findDiscussionSubmitButton(app._findDiscussionEditor()),' +
      '  pageJudge:app._computeDiscussionPage()};})()'
    );
    check('答题在飞时（提交中 / 已就绪待提交）讨论链路一律不进 —— 讨论与交卷不再同时抢页面',
      flight && flight.duringGate === false && flight.duringReady === false, JSON.stringify(flight));
    check('答题状态一清，同一页立刻又认得出是讨论页（守卫不是永久关掉功能）',
      flight && flight.after === true && flight.pageJudge === true, JSON.stringify(flight));

    var stale = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'try{localStorage.setItem("omitone_return_url","http://x/mycourse/studentstudy");' +
      'localStorage.setItem("omitone_return_url_at",String(Date.now()-200000));}catch(e){}' +
      'var before=app._discussionReturnFresh();' +
      'var cleared="";try{cleared=String(localStorage.getItem("omitone_return_url"))+"/"+' +
      '  String(localStorage.getItem("omitone_return_url_at"));}catch(e){}' +
      'var fresh=app._discussionReturnFresh();' +
      'return {before:before,after:fresh,cleared:cleared};})()'
    );
    check('「从刷课页跳过去」的放宽**两分钟就作废**（旧写法永不过期，是误判的第一道来源）',
      stale && stale.before === false && stale.after === false, JSON.stringify(stale));
    check('过期时把两个键一起清掉（留着它们，下一轮还会去放宽别的页面）',
      stale && stale.cleared === 'null/null', JSON.stringify(stale));
  }
});

/** ---- 43. 解密扫描没覆盖这一份文档时不白等 8 秒（批次 9-B） ---- */
SCENARIOS.push({
  name: '扫描未覆盖时不白等解密窗口',
  path: '/submit-key',
  run: async function (ctx) {
    // 现场：00:46:41 `quiz waiting font decrypt {state:"(none)",sweepAgoMs:-1}` → 00:46:49 才发请求。
    // 扫描戳都没有 = content.js 那一次扫描**没跑到这一份文档**，等满 8 秒一个字也不会多解出来。
    // ⚠️ 夹具必须自带可用模型配置：`hasApiKey` 只由配置写入流程点亮，
    //   没配到位 `_handleQuiz` 第一句就 `skip quiz because api unavailable`，
    //   压根走不到解密闸门 —— 定向单跑这个场景时最先炸的就是这里（实测踩过）。
    var cfg = {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      enableQuiz: true, enableCaptcha: false, enableDiscussion: false, autoNext: false,
      randomAnswer: false, fontDecryptWaitMs: 8000
    };
    await writeConfig(ctx.extensionId, cfg);
    await sleep(600);
    var first = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app.configs.hasApiKey=true;' +
      'app._quizApiFailUntil=0;app._quizForceSkipUntil=0;app._quizForceSkipPaperKey="";' +
      // 同一台 mock 服务器上，前面场景写下的按卷计数会让 `_shouldSkipQuizBySubmitAttempts`
      // 在解密闸门**之前**就把这一卷跳掉 —— 夹具先把这些账清干净
      'var drop=[];for(var qi=0;qi<sessionStorage.length;qi++){var qk=sessionStorage.key(qi);' +
      '  if(qk&&qk.indexOf("omitone.")===0)drop.push(qk);}' +
      'drop.forEach(function(k){sessionStorage.removeItem(k);});' +
      'app._quizAnswered=false;app._quizInProgress=false;app._quizSubmitPending=false;app._quizReadyToSubmit=false;' +
      'app._realProbe=app._probeFontDecrypt;app._realExtract=app._extractQuestions;' +
      'app._extractQuestions=function(){return [];};' +
      'app._probeFontDecrypt=function(){return {secret:true,miss:false,terminal:false,state:"(none)",sweepAgoMs:-1};};' +
      'app.configs.fontDecryptWaitMs=8000;app._fontSecretWaitSince=0;app._quizScanDiagAt=Date.now();' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'Promise.resolve(app._handleQuiz(null)).then(function(){' +
      '  setTimeout(function(){' +   // 日志异步送达，不等一拍读到的是空
      '  var w=null;got.forEach(function(m){if(m.message==="quiz waiting font decrypt")w=m;});' +
      '  res({waited:!!w,limit:w?Number(w.meta&&w.meta.waitLimitMs):-1,' +
      '    sweep:w?Number(w.meta&&w.meta.sweepAgoMs):-99,inFlight:app._quizInProgress,' +
      '    msgs:got.map(function(m){return m.message;}).slice(0,8),started:Date.now()});},300);' +
      '});});})()'
    );
    check('装配闸门：这一轮**确实进了等待**（有 waiting 日志、且没往下答题）',
      first && first.waited === true && first.inFlight === false, JSON.stringify(first));
    check('等待窗口按"扫描未覆盖"收窄（日志里就带着本轮实际上限，可自证）',
      first && first.limit > 0 && first.limit < 8000, 'waitLimitMs=' + (first && first.limit));

    var over = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'app._fontSecretWaitSince=Date.now()-3000;app._quizScanDiagAt=Date.now();' +
      'var t0=Date.now();' +
      'Promise.resolve(app._handleQuiz(null)).then(function(){' +
      '  setTimeout(function(){' +
      '  var o=null;got.forEach(function(m){if(m.message==="font decrypt pending over limit, answer anyway")o=m;});' +
      '  res({hit:!!o,limit:o?Number(o.meta&&o.meta.limitMs):-1,' +
      '    configured:o?Number(o.meta&&o.meta.configuredLimitMs):-1,' +
      '    waited:o?Number(o.meta&&o.meta.waitedMs):-1,wall:Date.now()-t0});},300);' +
      '});});})()'
    );
    check('戳都没有的文档：过了短宽限就放行，不再烧完整配置窗口（真实页面每份卷子省 5 秒以上）',
      over && over.hit === true && over.limit > 0 && over.limit < over.configured &&
      over.waited >= 0 && over.waited < over.configured, JSON.stringify(over));
    check('放行是立刻发生的（不是又等了 8 秒）—— 墙钟时间做上界校验',
      over && over.wall < 4000, 'wall=' + (over && over.wall) + 'ms');

    var kept = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'app._probeFontDecrypt=function(){return {secret:true,miss:false,terminal:false,state:"decrypting",sweepAgoMs:1500};};' +
      'var stamp=Date.now()-3000;app._fontSecretWaitSince=stamp;' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'var n0=got.length;' +
      'Promise.resolve(app._handleQuiz(null)).then(function(){' +
      // 对照组要断言"**没有**新日志"，那更得等足送达窗口 —— 立刻读 got 永远读到空，
      // 这条断言就会假绿（不会失败的检查等于没有检查）
      '  setTimeout(function(){' +
      '  res({sameStamp:app._fontSecretWaitSince===stamp,noNewLog:got.length===n0,' +
      '    notStarted:app._quizInProgress===false});},300);' +
      '});});})()'
    );
    check('对照组：**真有扫描戳**的密文档仍等满原窗口（批次 9-B 只关"未覆盖"，没把等待做没）',
      kept && kept.sameStamp === true && kept.noNewLog === true && kept.notStarted === true,
      JSON.stringify(kept));

    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'if(app._realProbe)app._probeFontDecrypt=app._realProbe;' +
      'if(app._realExtract)app._extractQuestions=app._realExtract;' +
      'app._fontSecretWaitSince=0;return true;})()');
  }
});

/** ---- 44. 数不出待答容器时不许按住整节（批次 9-C） ---- */
SCENARIOS.push({
  name: '没有待答题时空转 hold 不再按住整节',
  path: '/submit-key',
  run: async function (ctx) {
    // 现场：00:45:59 → 00:46:16 连磨两轮 `study hold quiz before finish {pending:{total:0}}`，
    // 最后是页面自己刷新才走通 —— hold 的是 **0 道题**，用户看到的"在已完成的界面磨蹭很久"。
    var judge = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizInProgress=false;app._quizSubmitPending=false;' +
      'var empty=app._shouldHoldQuizBeforeFinish({total:0});' +
      'var some=app._shouldHoldQuizBeforeFinish({total:3,unfilledCount:1});' +
      'app._quizInProgress=true;' +
      'var busy=app._shouldHoldQuizBeforeFinish({total:0});' +
      'app._quizInProgress=false;app._quizSubmitPending=true;' +
      'var pendingSubmit=app._shouldHoldQuizBeforeFinish({total:0});' +
      'app._quizSubmitPending=false;' +
      'var err=app._shouldHoldQuizBeforeFinish({error:"boom"});' +
      'var nul=app._shouldHoldQuizBeforeFinish(null);' +
      'return {empty:empty,some:some,busy:busy,pendingSubmit:pendingSubmit,err:err,nul:nul};})()'
    );
    check('数不出**任何**待答容器、且没有在飞动作 → 不 hold（旧写法为 0 道题按住整节）',
      judge && judge.empty === false, JSON.stringify(judge));
    check('数得出待答题 → 照旧 hold（守卫没被做没，这是配对的一条）',
      judge && judge.some === true, JSON.stringify(judge));
    check('正在答题 / 正在提交时即使数出来是 0 也照旧 hold（别把填答中间态放行）',
      judge && judge.busy === true && judge.pendingSubmit === true, JSON.stringify(judge));
    check('数失败了（error 形状）或压根没数到 → 一律 hold：宁可慢，不能因为自己数漏就整节放行',
      judge && judge.err === true && judge.nul === true, JSON.stringify(judge));

    // 「命中了却被吃掉」要说清死在哪一道：旧日志只有 matchedSelectors + inputs，
    // 于是"容器全部被过滤"到底指不可见、嵌套去重还是解析返回 null，现场判不了。
    //
    // ⚠️ 写法换过一版：旧探针从 `dropStages` 里**挑 filtered 最大的那条**再断它
    //   `matched > 0` —— 那是拿被测字段筛出条目、再断这个字段，`matched > 0` 由筛选条件
    //   自己保证，永远红不了；真坏了（比如四格全 0 或死在 deduped）也只有一句"best 为 null"。
    //   现在按**选择器名**直接取那一格，四格逐一钉：种下去的是"不可见且无文本"，
    //   就必须落在 `filtered`，`deduped` / `unparsable` 得是 0。
    var ghostSel = 'div[class*="question"]';
    var drop = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var ghost=document.createElement("div");ghost.className="questionGhostBoard";' +
      'ghost.style.display="none";document.body.appendChild(ghost);' +
      'var rep=app._diagnoseQuestionScan(document);' +
      'var stages=rep.dropStages||{};' +
      'var s=stages[' + JSON.stringify(ghostSel) + ']||null;' +
      'ghost.remove();' +
      'return {stage:s,keys:Object.keys(stages).join(","),containers:rep.containers,' +
      'hint:String(rep.hint||"").slice(0,60)};})()'
    );
    check('0 题诊断按选择器给出四格：种下的不可见节点死在 filtered，不是 deduped / unparsable',
      !!drop && !!drop.stage && drop.stage.matched >= 1 &&
      drop.stage.filtered === drop.stage.matched &&
      drop.stage.deduped === 0 && drop.stage.unparsable === 0,
      JSON.stringify(drop));
    check('容器确实一个都没留下（否则这条取证压根走不到 dropStages 那一支）',
      drop && drop.containers === 0, JSON.stringify(drop && drop.containers));
    check('hint 指得住：命中却被吃掉时那句要指向 dropStages（现场只有这一行会被当结论读）',
      !!drop && drop.hint.indexOf('dropStages') !== -1, drop && drop.hint);
  }
});

/** ---- 45. javascript: 那族帧必须自证「里面有没有第二份卷子」（批次 9-D 取证 + 批次 10-A 可读性） ---- */
SCENARIOS.push({
  name: '被拒的帧带内容签名取证',
  path: '/frame-sig',
  run: async function (ctx) {
    // 现场：00:46:55 `frames:8` 里 4 个 `javascript:void(function(){document.open` + 3 个 `javascript:`
    // 全被拒成「认不出任务类型」。旧日志只有 src + 原因 —— 判不了那是空帧还是**第二份卷子**，
    // 而这正是用户报的「第一个做了、第二个又不做了」唯一可疑的现场。本场景只锁取证，不改判据。
    var ready = await waitFor(ctx.client,
      '(function(){var f=document.getElementById("iframe");' +
      'var d=f&&f.contentDocument;var p=d&&d.getElementById("fPaper");' +
      'return !!(p&&p.contentDocument&&p.contentDocument.body&&' +
      '  p.contentDocument.body.textContent.indexOf("第二份卷子")>=0);})()', 15000);
    check('装配闸门：第二份卷子真的写进了 javascript: 那一族帧（外层写不进去就等于空测）',
      ready === true);
    if (!ready) return;

    var out = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;try{app._clearTickLoop();}catch(e){}' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'app._jobRejectSignature="";app._jobRejectLogAt=0;' +
      // 第一份卷子按"本轮已经搜过"让路 —— 这正是用户现场「第一个做了、第二个又不做了」的那一轮：
      // 第一份已收，剩下的帧全落在拒绝清单里，签名才有机会被看到
      'var job=app._searchChaoxingJobOcs([{jobid:"job-first"}]);' +
      'setTimeout(function(){' +   // 拒绝清单是随日志送达的，不等一拍读到的是空
      'var rej=null;got.forEach(function(m){if(m.message==="search job: every candidate frame was rejected")rej=m;});' +
      'var list=rej&&rej.meta?rej.meta.rejects:[];' +
      'function hasPaper(r){return r&&r.sig&&r.sig.text&&r.sig.text.indexOf("第二份卷子")>=0;}' +
      // 批次 10-A：签名里**不许再有对象**。`qHit` 是对象时它会落在日志存储的第 4 层，
      // 被 `cleanLogMeta` 写成 "[truncated]" —— 取证字段自己不可读（真实日志 01:49:17）。
      'function zero(r){return r&&r.sig&&!r.sig.text&&r.sig.qTotal===0&&typeof r.sig.qHits==="string";}' +
      'function flat(r){return r&&r.sig&&typeof r.sig.qHits==="string"&&typeof r.sig.qTotal==="number"' +
      '  &&typeof r.sig.textLen==="number"&&typeof r.sig.qHits!=="object"&&typeof r.sig.answer==="number";}' +
      'var paper=(list||[]).filter(hasPaper)[0]||null;' +
      'var empty=(list||[]).filter(function(r){return r&&r.sig&&!hasPaper(r)&&zero(r);})[0]||null;' +
      'res({job:!!job,entries:(list||[]).length,paper:paper,empty:empty,seen:got.length,' +
      '  flat:(list||[]).filter(flat).length,withSig:(list||[]).filter(function(r){return !!(r&&r.sig);}).length,' +
      '  msgs:got.map(function(m){return m.message;}).slice(0,6)});},400);});})()'
    );
    check('拒绝清单里**带签名的条目**至少有一条（旧写法只有 src + 原因，取证无从谈起）',
      out && out.withSig > 0, JSON.stringify(out && { withSig: out.withSig, entries: out.entries }));
    check('批次 10-A：每一条签名都是**扁平的**（字符串/数字）—— 对象会被日志存储第 4 层截成 [truncated]',
      out && out.withSig > 0 && out.flat === out.withSig,
      JSON.stringify(out && { flat: out.flat, withSig: out.withSig }));
    check('批次 10-A：命中数用位置串 qHits 表达（顺序是 _questionSelectors 的前 5 条，用来定位类名）',
      out && !!out.paper && /^[\d/]+$/.test(String(out.paper.sig.qHits)),
      JSON.stringify(out && out.paper && out.paper.sig));
    check('批次 10-A：qTotal 按**整份**清单的并集数，不是前 5 条之和 —— 夹具命中的是第 15 条 ' +
      '（真实日志 00:46:04 就是这一条：只数前 5 会让批次 10-C 的延时窗口永远不武装）',
      out && !!out.paper && out.paper.sig.qHits === '0/0/0/0/0' && out.paper.sig.qTotal >= 1,
      JSON.stringify(out && out.paper && out.paper.sig));
    check('批次 10-A：textLen 与 text 同时给 —— 「本来就没有文本」和「片段被切掉」分得开',
      out && !!out.paper && typeof out.paper.sig.textLen === 'number' &&
      out.paper.sig.textLen >= out.paper.sig.text.length &&
      !!out.empty && out.empty.sig.textLen === 0,
      JSON.stringify(out && { paper: out.paper && out.paper.sig, empty: out.empty && out.empty.sig }));
    check('第二份卷子所在的那一帧：签名把题干文字与题形命中数带了出来 ——「在不在这个帧里」从此可判',
      out && !!out.paper && out.paper.sig.text.indexOf('第二份卷子') >= 0,
      JSON.stringify(out && out.paper));
    check('空帧与有题帧分得开：另一条签名 text 为空且题形命中全 0',
      out && !!out.empty, JSON.stringify(out && out.empty));
    check('取证不改变调度结果：这一轮仍然没有任务点被误收（放宽判据留到有签名证据的下一批）',
      out && out.job === false, 'job=' + JSON.stringify(out && out.job));
  }
});

/** ---- 46. 有作答框却抠不出题的帧，不许被当成「整节已完成」（批次 10-C） ---- */
SCENARIOS.push({
  name: '抠不出题的卷子帧延时放行完成判定',
  path: '/frame-sig',
  run: async function (ctx) {
    // 现场（用户 2026-11-11 日志 00:46:04）：`quiz scan found 0 questions {inputs:9,
    // matchedSelectors:{"div[class*=\"question\"]":1}}` → **1 秒后**就
    // `skip completed {by:"all-tasks-finished"}` 点了「下一节」；重新加载之后同一份卷子
    // 当场答成 3 题。也就是"平台还没把卷子渲染进这一帧"被读成了"这一节已经做完"，
    // 用户看到的就是「第一个做了、第二个又不做」+「判定为已完成了」。
    // 本场景钉三件事：① 这一族形状会把完成判定按下来；② 空帧/没有作答框的帧**不许**按；
    // ③ 停留是**有预算的** —— 一张卡片只给一个窗口，用完照旧推进（否则就成了另一种磨蹭）。
    var out = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      // 完成判定的其它输入全部让路：只留「可见任务点全已完成」这一条真判据在跑，
      // 于是"延时有没有把 skip 按住"是**这条钩子自己**决定的，不是别的分支碰巧挡的。
      'var origState=app._getVisibleTaskCompletionState, origKey=app._studyProgressKey;' +
      'app._getVisibleTaskCompletionState=function(){return {hasTasks:true,allFinished:true};};' +
      'app._studyProgressKey=function(){return window.__retryScopeKey||"card-1";};' +
      'app._isActiveMediaPending=function(){return false;};' +
      'function reset(){app._quizParseRetryUntil=0;app._quizParseRetryScope="";app._quizParseRetryWarnAt=0;}' +
      'var paper={qTotal:1,qHits:"1/0/0/0/0",answer:9,textLen:210,text:"第二份卷子"};' +
      'var empty={qTotal:0,qHits:"0/0/0/0/0",answer:0,textLen:0,text:""};' +
      'var noBox={qTotal:2,qHits:"2/0/0/0/0",answer:0,textLen:80,text:"课件"};' +
      'reset();var rEmpty=app._maybeHoldSkipForUnparsedQuiz(empty,"javascript:");' +
      'var cEmpty=app._isCurrentCompleted();' +
      'reset();var rNoBox=app._maybeHoldSkipForUnparsedQuiz(noBox,"/ananas/modules/work");' +
      'reset();var rPaper=app._maybeHoldSkipForUnparsedQuiz(paper,"javascript:");' +
      'var heldWhile=app._isCurrentCompleted();var until=app._quizParseRetryUntil;' +
      // 同一张卡片：窗口用掉之后**不再续期**，让推进发生（预算封顶，不是无限停留）
      'app._quizParseRetryUntil=Date.now()-1;window.__retryScopeKey="card-1";' +
      'var rSpent=app._maybeHoldSkipForUnparsedQuiz(paper,"javascript:");' +
      'var doneAfter=app._isCurrentCompleted();' +
      // 换一张卡片：预算重新给一次（下一节的真卷子不该被上一节用掉的窗口冤枉）
      'window.__retryScopeKey="card-2";' +
      'var rNextCard=app._maybeHoldSkipForUnparsedQuiz(paper,"javascript:");' +
      'app._getVisibleTaskCompletionState=origState;app._studyProgressKey=origKey;' +
      'setTimeout(function(){' +
      'function metaOf(name){for(var i=0;i<got.length;i++){if(got[i].message===name)return got[i].meta||{};}' +
      '  return null;}' +
      'res({rEmpty:rEmpty,cEmpty:cEmpty,rNoBox:rNoBox,rPaper:rPaper,heldWhile:heldWhile,' +
      '  untilDelta:until-Date.now(),rSpent:rSpent,doneAfter:doneAfter,rNextCard:rNextCard,' +
      '  delay:metaOf("quiz frame has answer controls but no parsable questions, delay skip"),' +
      '  spent:metaOf("quiz parse retry spent, allow skip"),seen:got.length});},400);});})()'
    );
    check('空帧（题形命中 0、作答框 0）不按完成判定 —— 否则每个空壳帧都能把整节拖住',
      out && out.rEmpty === false && out.cEmpty === true,
      JSON.stringify(out && { rEmpty: out.rEmpty, cEmpty: out.cEmpty }));
    check('命中题形但**没有作答框**（课件那一族）不按判定 —— 只认真卷子的形状',
      out && out.rNoBox === false, JSON.stringify(out && { rNoBox: out.rNoBox }));
    check('有作答框 + 命中题形 + 一题没抠出 → 延时武装，且**当刻 _isCurrentCompleted() 为假**',
      out && out.rPaper === true && out.heldWhile === false && out.untilDelta > 0,
      JSON.stringify(out && { rPaper: out.rPaper, heldWhile: out.heldWhile, untilDelta: out.untilDelta }));
    check('延时是**有界**的：窗口落在 12 秒以内（不是"等它长出来为止"）',
      out && out.untilDelta > 0 && out.untilDelta <= 12000, 'untilDelta=' + JSON.stringify(out && out.untilDelta));
    check('预算封顶：同一张卡片的窗口用掉后放行完成判定（把「跳过」换成另一种「磨蹭」是这次要避免的）',
      out && out.rSpent === false && out.doneAfter === true,
      JSON.stringify(out && { rSpent: out.rSpent, doneAfter: out.doneAfter }));
    check('换一张卡片预算重新给一次（上一节用掉的窗口不该冤枉下一节的真卷子）',
      out && out.rNextCard === true, JSON.stringify(out && { rNextCard: out.rNextCard }));
    check('delay skip 那条 warn 带取证字段（qHits/qTotal/answer/textLen/holdMs），不只是"我按住了"',
      out && !!out.delay && out.delay.qTotal === 1 && out.delay.answer === 9 &&
      out.delay.textLen === 210 && out.delay.qHits === '1/0/0/0/0' && out.delay.holdMs > 0,
      JSON.stringify(out && out.delay));
    check('窗口用掉也要留话（quiz parse retry spent），否则日志里只剩"它为什么不跳"没人答',
      out && !!out.spent && out.spent.answer === 9, JSON.stringify(out && { spent: out.spent, seen: out.seen }));
  }
});

/** ---- 47. 0 题诊断接进延时窗口 + skip completed 自带依据（批次 11-A / 11-B） ---- */
SCENARIOS.push({
  name: '0题诊断接线延时窗口与完成依据取证',
  path: '/frame-sig',
  run: async function (ctx) {
    // 批次 10-C 的窗口在真实页面**一次都没武装过**：它挂在「帧被拒」那条路上，而真实日志
    // 01:49:17 那一帧的签名是 `answer:0`、`text:""`（卷子还没被写进子帧），闸门当场不成立。
    // 真正量到正确形状的是 `_handleQuiz` 的 0 题诊断（00:46:04：inputs:9 + 题形命中 1）。
    // 本场景钉四件事：① 这个形状现在能武装窗口（用**真实夹具**的 `_diagnoseQuestionScan`，不是编的数字）；
    // ② 武装后/预算用完后**不再重复扫**（一次诊断要遍历 ≤8 文档 × 18 选择器，成本必须封顶）；
    // ③ 没有作答框或没有题形命中时**不许**武装；④ `skip completed` 自己把依据落盘。
    var out = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      'var origDiag=app._diagnoseQuestionScan, origState=app._getVisibleTaskCompletionState,' +
      '  origKey=app._studyProgressKey, origMedia=app._isActiveMediaPending;' +
      'var calls=0;' +
      'app._diagnoseQuestionScan=function(d){calls++;return origDiag.call(this,d);};' +
      'app._getVisibleTaskCompletionState=function(){return {hasTasks:true,allFinished:true};};' +
      'app._studyProgressKey=function(){return window.__scanScopeKey||"card-A";};' +
      'app._isActiveMediaPending=function(){return false;};' +
      'app.configs.restudy=false;app._quizSubmitPending=false;' +
      'var origNext=app.nextUnit, origSwitch=app._switchToNextLearningCard, origPopups=app._dismissPopups;' +
      'app._switchToNextLearningCard=function(){return false;};' +
      'app.nextUnit=function(){window.__nextCalls=(window.__nextCalls||0)+1;};' +
      'app._dismissPopups=function(){};' +
      'function reset(){app._quizParseRetryUntil=0;app._quizParseRetryScope="";app._quizParseRetryWarnAt=0;}' +
      // ① 真实夹具（fFirst 有 .TiMu + radio，fPaper 只有 div[class*="question"] + radio）
      'reset();window.__scanScopeKey="card-A";calls=0;' +
      'var sig=app._quizScanRetrySignal(null);' +
      'var armed=sig?app._maybeHoldSkipForUnparsedQuiz(sig,"quiz-scan"):false;' +
      'var until=app._quizParseRetryUntil;var doneWhileHeld=app._isCurrentCompleted();' +
      // ② 窗口已武装 → 不再扫（calls 不许涨）
      'var callsAfterArm=calls;var sigHeld=app._quizScanRetrySignal(null);var cHeld=calls;' +
      // ③ 预算用掉 → 也不再扫（否则每张空转的卡片每秒一次全页遍历）
      'app._quizParseRetryUntil=Date.now()-1;' +
      'var callsAfterSpent=calls;var sigSpent=app._quizScanRetrySignal(null);var cSpent=calls;' +
      'var doneAfterSpent=app._isCurrentCompleted();' +
      // ⚠️ 两条成本闸**互不替代**（批次 11 实测：删掉「窗口未过期」那条，「预算用掉」那条
      //   照样返回 null，整组断言全绿）。这里造只有第一条起作用的那一态：窗口还开着、
      //   作用域已换到另一张卡片（卡片推进快过窗口过期时会真的发生）。
      'app._quizParseRetryUntil=Date.now()+9000;window.__scanScopeKey="card-Z";' +
      'var cBeforeOverlap=calls;var sigOverlap=app._quizScanRetrySignal(null);var cOverlap=calls;' +
      'app._quizParseRetryUntil=Date.now()-1;' +
      // 换一张卡片：重新量一次（上一节用掉的窗口不冤枉下一节）
      'window.__scanScopeKey="card-B";var sigNextCard=app._quizScanRetrySignal(null);' +
      'var callsForCardB=calls;' +
      // ③ 反例：只 stub 诊断的返回值，验闸门条件本身
      'reset();app._diagnoseQuestionScan=function(){return {docs:[{inputs:5,selectors:{}}],containers:0};};' +
      'var sigNoShape=app._quizScanRetrySignal(null);' +
      'app._diagnoseQuestionScan=function(){return {docs:[{inputs:0,selectors:{".TiMu":2}}],containers:0};};' +
      'var sigNoControls=app._quizScanRetrySignal(null);' +
      'reset();app._diagnoseQuestionScan=function(){return {docs:[{inputs:9,' +
      '  selectors:{"div[class*=\\"question\\"]":1}}],containers:0,dropStages:{filtered:1}};};' +
      'var sigReal=app._quizScanRetrySignal(null);' +
      // ④ skip completed 的依据：用真实夹具（此时诊断已被 stub，先恢复）
      'app._diagnoseQuestionScan=function(d){calls++;return origDiag.call(this,d);};' +
      'reset();var skipped=app._skipIfCompleted();' +
      'app._diagnoseQuestionScan=origDiag;app._getVisibleTaskCompletionState=origState;' +
      'app._studyProgressKey=origKey;app._isActiveMediaPending=origMedia;' +
      'app.nextUnit=origNext;app._switchToNextLearningCard=origSwitch;app._dismissPopups=origPopups;' +
      'setTimeout(function(){' +
      'function metaOf(name){for(var i=got.length-1;i>=0;i--){if(got[i].message===name)return got[i].meta||{};}' +
      '  return null;}' +
      'var delay=metaOf("quiz frame has answer controls but no parsable questions, delay skip");' +
      'var skipMeta=metaOf("skip completed");' +
      'var flat=skipMeta?Object.keys(skipMeta).every(function(k){var v=skipMeta[k];' +
      '  return v===null||typeof v!=="object";}):false;' +
      'reset();res({sig:!!sig,qTotal:sig&&sig.qTotal,answer:sig&&sig.answer,' +
      '  containers:sig&&sig.containers,drop:sig&&sig.drop,armed:armed,delay:delay,' +
      '  untilDelta:until-Date.now(),doneWhileHeld:doneWhileHeld,sigHeld:sigHeld,' +
      '  callsAfterArm:callsAfterArm,cHeld:cHeld,cSpent:cSpent,calls:calls,' +
      '  sigOverlap:sigOverlap,cOverlap:cOverlap,cBeforeOverlap:cBeforeOverlap,' +
      '  sigSpent:sigSpent,doneAfterSpent:doneAfterSpent,' +
      '  sigNextCard:!!sigNextCard,callsForCardB:callsForCardB,' +
      '  sigNoShape:sigNoShape,sigNoControls:sigNoControls,sigReal:!!sigReal,' +
      '  skipped:skipped,nextCalls:window.__nextCalls||0,skipMeta:skipMeta,flat:flat,' +
      '  seen:got.length});},400);});})()'
    );
    // ⚠️ `containers` 这里**必须是 ≥1，不是 0**（实测 2）—— 本夹具是「有题形容器、但抠不出题」
    //   那一族，而 `dropStages` 只在 `!report.containers` 时才计算（`src/page/30-log.js:273`）。
    //   所以这一族的取证走 hint（下面那条 delay skip 断言钉它），"命中却被吃掉 → filtered"
    //   那一支由 /submit-key 场景按选择器名钉着。两条渠道互斥，别把它们并成一条。
    check('11-A：真实夹具的页面级诊断给出 sig（qTotal 含第 15 条那族、answer 含 radio），不再是只有日志',
      out && out.sig === true && out.qTotal >= 1 && out.answer >= 1 && out.containers >= 1 &&
      typeof out.drop === 'string',
      JSON.stringify(out && { qTotal: out.qTotal, answer: out.answer, containers: out.containers, drop: out.drop }));
    check('11-A：这个形状把延时窗口武装（armed=true、窗口 ≤12 秒）且**当刻不再宣称整节完成**',
      out && out.armed === true && out.doneWhileHeld === false &&
      out.untilDelta > 0 && out.untilDelta <= 12000,
      JSON.stringify(out && { armed: out.armed, doneWhileHeld: out.doneWhileHeld, untilDelta: out.untilDelta }));
    check('11-A：delay skip 那条带 `src:"quiz-scan"` 与 containers —— 与「帧被拒」那条分得开',
      out && !!out.delay && out.delay.src === 'quiz-scan' && out.delay.qTotal >= 1 &&
      out.delay.answer >= 1 && out.delay.containers >= 1,
      JSON.stringify(out && out.delay));
    check('成本封顶：窗口已武装时**不再重复全页诊断**（calls 不涨，返回 null）',
      out && out.sigHeld === null && out.cHeld === out.callsAfterArm,
      JSON.stringify(out && { sigHeld: out.sigHeld, cHeld: out.cHeld, callsAfterArm: out.callsAfterArm }));
    check('成本封顶：本卡片预算用掉后也不再诊断，且完成判定照常放行（不磨蹭）',
      out && out.sigSpent === null && out.doneAfterSpent === true && out.cSpent === out.callsAfterArm,
      JSON.stringify(out && { sigSpent: out.sigSpent, doneAfterSpent: out.doneAfterSpent, cSpent: out.cSpent, callsAfterArm: out.callsAfterArm }));
    check('两条成本闸各自独立：窗口未过期 + 作用域已换卡片时**仍然不扫**（删掉第一条闸，上面两条断言照样绿）',
      out && out.sigOverlap === null && out.cOverlap === out.cBeforeOverlap,
      JSON.stringify(out && { sigOverlap: out.sigOverlap, cBeforeOverlap: out.cBeforeOverlap, cOverlap: out.cOverlap }));
    check('换一张卡片重新量一次、且**只量一次**（下一节的真卷子不该被上一节用掉的窗口冤枉）',
      out && !!out.sigNextCard && out.callsForCardB === out.cSpent + 1,
      JSON.stringify(out && { sigNextCard: out.sigNextCard, callsForCardB: out.callsForCardB, cSpent: out.cSpent }));
    check('反例：有作答框但**没命中题形** → 不武装（否则每个纯输入页都能拖住整节）',
      out && out.sigNoShape === null, JSON.stringify(out && { sigNoShape: out.sigNoShape }));
    check('反例：命中题形但**没有作答框** → 不武装（课件那一族照旧推进）',
      out && out.sigNoControls === null, JSON.stringify(out && { sigNoControls: out.sigNoControls }));
    check('00:46:04 那一行的形状（inputs:9 + div[class*="question"]:1 + 容器 0）确实被接住',
      out && out.sigReal === true, JSON.stringify(out && { sigReal: out.sigReal }));
    check('11-B：`skip completed` 自带依据（by/tasks/taskTypes/inputs/qTotal/containers/retrySpent）且全扁平',
      out && out.skipped === true && out.nextCalls === 1 && !!out.skipMeta && out.flat === true &&
      out.skipMeta.by === 'all-tasks-finished' && typeof out.skipMeta.tasks === 'number' &&
      typeof out.skipMeta.taskTypes === 'string' && typeof out.skipMeta.inputs === 'number' &&
      out.skipMeta.qTotal >= 1 && out.skipMeta.retrySpent === false,
      JSON.stringify(out && { skipped: out.skipped, nextCalls: out.nextCalls, skipMeta: out.skipMeta, flat: out.flat }));
  }
});

// ===========================================================================
// 主流程
/** ---- 48. 取证要在「卷子那份文档」上数，不是在外层卡片页（批次 12） ---- */
SCENARIOS.push({
  name: '诊断的容器与压平取证跨文档',
  path: '/frame-sig',
  run: async function (ctx) {
    // 真实页面实测（rig + `xxtAI.probe()`）抓到四处取证毛病，其中最坑的一条是：
    // `_diagnoseQuestionScan` 的 containers / samples / dropStages 全部在
    // `_getMainDocument()`（外层卡片页）上算，而卷子在第 3 层文档里 ——
    // 于是 `containers` **恒为 0**，`hint` 那句「选择器有命中但容器一个都没留下」当着用户的面说谎。
    // 这一族页面的结构（top → /frame-sig-inner → fFirst / fPaper / fEmpty）就是照真页面搭的。
    var out = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var rep=app._diagnoseQuestionScan(null);' +
      'var flat=app._flattenDropStages(rep.dropStages);' +
      // 外层那份文档单独数一次：批次 12 之前的 containers 就是这个数
      'var topOnly=app._collectQuestionContainers(document).length;' +
      'var ev=app._skipCompletedEvidence();' +
      'return {containers:rep.containers,containerDocs:rep.containerDocs,' +
      '  containerPaths:String(rep.containerPaths||""),topOnly:topOnly,flat:flat,' +
      '  docs:rep.docs.length,samples:(rep.samples||[]).length,' +
      '  parsedTitle:(rep.samples||[]).some(function(s){return String(s.title||"").length>0;}),' +
      '  evDrop:String(ev.drop||""),evQTotal:ev.qTotal,evContainers:ev.containers,' +
      '  nan:(String(rep.containers)+flat+ev.drop).indexOf("NaN")>=0};})()'
    );
    check('12：容器是在**有题的那几份文档**上数的（外层文档自己数必然是 0，否则这条是空测）',
      out && out.topOnly === 0 && out.containers >= 2,
      JSON.stringify(out && { containers: out.containers, topOnly: out.topOnly }));
    check('12：containerDocs / containerPaths 说出「是在哪几份文档上数的」，日志才能自证',
      out && typeof out.containerDocs === 'number' && out.containerDocs >= 1 &&
      /frame-sig/.test(out.containerPaths),
      JSON.stringify(out && { containerDocs: out.containerDocs, containerPaths: out.containerPaths }));
    check('12：samples 取自卷子那份文档（题干解得开才有 title，外层数出来永远是空数组）',
      out && out.samples >= 1 && out.parsedTitle === true,
      JSON.stringify(out && { samples: out.samples, parsedTitle: out.parsedTitle }));
    check('12：skip completed 的依据同一口径（qTotal 是数字、drop 是串、containers 跨文档）',
      out && typeof out.evQTotal === 'number' && out.evContainers >= 2 &&
      (out.evDrop === '' || /matched\d+\/filtered\d+/.test(out.evDrop)),
      JSON.stringify(out && { evQTotal: out.evQTotal, evContainers: out.evContainers, evDrop: out.evDrop }));

    // 第二步：把两份卷子的容器全部遮成「不可见且无文本」—— 此时 `containers` 归零，
    // `_diagnoseQuestionScan` 才会算 dropStages。这一步是为了拿到**真实的两层结构**，
    // 而不是自己造一个漂亮形状：批次 12 的 NaN 正是在真结构上读出来的。
    var ghost = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var inner=document.getElementById("iframe").contentDocument;' +
      'var docs=[document,inner];' +
      '["fFirst","fPaper","fEmpty"].forEach(function(id){' +
      '  var f=inner.getElementById(id);if(f&&f.contentDocument)docs.push(f.contentDocument);});' +
      // 遮没的对象**由插件自己报**：清空文本 + display:none，让它同时满足「不可见」与「无文本」。
      // 只改显示不够 —— `usable` 的判据是「可见**或**有文本」，光藏起来题还在。
      'var hid=0;' +
      'docs.forEach(function(d){var cs=[];try{cs=app._collectQuestionContainers(d)||[];}catch(e){}' +
      '  cs.forEach(function(n){n.textContent="";n.style.display="none";hid++;});});' +
      'var rep=app._diagnoseQuestionScan(null);' +
      'var flat=app._flattenDropStages(rep.dropStages);' +
      // 旧写法（把每条选择器的值当数字读）在**同一份真实结构**上会写成什么样
      'var old=Object.keys(rep.dropStages||{}).map(function(k){' +
      '  return k + ":" + Number((rep.dropStages||{})[k]);}).join("/");' +
      'return {hid:hid,containers:rep.containers,flat:flat,old:old,' +
      '  keys:Object.keys(rep.dropStages||{}).length,' +
      '  hint:String(rep.hint||"").slice(0,20)};})()'
    );
    check('12：容器全被遮没时 containers 归零、dropStages 才出场（先确认夹具真的走到了那条分支）',
      ghost && ghost.hid >= 2 && ghost.containers === 0 && ghost.keys >= 1,
      JSON.stringify(ghost && { hid: ghost.hid, containers: ghost.containers, keys: ghost.keys }));
    check('12：真结构压成四格定序串，且 filtered 报出「遮没」这一道（这就是那格取证的用处）',
      ghost && /matched\d+\/filtered\d+\/deduped\d+\/unparsable\d+/.test(ghost.flat) &&
      /filtered[1-9]/.test(ghost.flat),
      JSON.stringify(ghost && { flat: ghost.flat }));
    check('12：反向对照 —— 旧写法在同一份结构上确实写出 NaN（证明上面那条不是空测）',
      ghost && ghost.old.indexOf('NaN') >= 0 && ghost.flat.indexOf('NaN') < 0,
      JSON.stringify(ghost && { old: ghost.old, flat: ghost.flat }));
  }
});

/** ---- 49. 卷子埋三层：取题文档要走到那份，「答不了」不许读成「没题做」（批次 13-A / 13-B） ---- */
SCENARIOS.push({
  name: '三层卷子文档与被API挡住的答题链路',
  path: '/nested-paper',
  run: async function (ctx) {
    // 现场（2026-11-11 直接进用户浏览器量的）：两张 24 题的卷子**一道没做**，
    // 日志却打 `skip completed` / `study finished on page` 然后翻节。三件事叠出来的：
    //   ① 卷子在第 3 层文档里，而 `_resolveQuizAnswerDocument` 只会找一层 `#frame_content`，
    //      于是所有 null 参数的判据落在**知识卡片页**上；
    //   ② 卡片页每条任务点后面都写着「任务点已完成」，`_isDocumentFrameFinished` 当场为真，
    //      `_isQuizPassedOrFinished` 就据此宣布「这一节做完」；
    //   ③ 没填 API Key 时 `_isQuizLearningPending` 直接返回 false —— 把「答不了」读成「没题做」。
    // 本场景把三条分别钉住，并留**夹具自证**（外层确实写着已完成、确实没有题形），
    // 免得断言靠一个空夹具假绿。
    var out = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      // 翻页动作全部换成计数器：这一场景要证明的是**不许翻页**，真翻了会打断整轮 e2e
      'var nav={card:0,unit:0,btn:0};' +
      'var origCard=app._switchToNextLearningCard, origUnit=app.nextUnit;' +
      'app._switchToNextLearningCard=function(){nav.card++;return true;};' +
      'app.nextUnit=function(){nav.unit++;};' +
      'var cards=document.getElementById("iframe").contentDocument;' +
      // ---- 夹具自证 ----
      'var fixture={topShape:app._docHasQuizPaperShape(document),cardsShape:app._docHasQuizPaperShape(cards),' +
      '  cardsLie:app._isDocumentFrameFinished(cards)};' +
      // ---- 13-A：解析到的必须是**真有题那一份** ----
      'var resolved=app._resolveQuizAnswerDocument(null);' +
      'var resolvedUrl=resolved&&resolved.location?String(resolved.location.href||""):"";' +
      'var resolvedContainers=resolved?app._collectQuestionContainers(resolved).length:-1;' +
      'var qExtracted=app._extractQuestions(null).length;' +
      'var passedNow=app._isQuizPassedOrFinished(null);' +
      // ---- 13-A 的闸：一份写着「已完成」但全书没题的文档，不许被说成做完 ----
      'var ghost=document.createElement("iframe");document.body.appendChild(ghost);' +
      'var gd=ghost.contentDocument;' +
      'var gDiv=gd.createElement("div");gDiv.className="ans-job-finished";' +
      'gDiv.textContent="任务点已完成";gd.body.appendChild(gDiv);' +
      'var ghostLie=app._isDocumentFrameFinished(gd);' +
      'var ghostPassed=app._isQuizPassedOrFinished(gd);' +
      'var ghostShape=app._docHasQuizPaperShape(gd);' +
      // ---- 13-B：没配 key 时「答不了」必须继续算「有题要做」 ----
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,randomAnswer:false,apiKey:"",hasApiKey:false});' +
      'app._resetRuntimeState();' +
      'var reasonNoKey=app._getQuizApiUnavailableReason();' +
      'var blockedBefore=app._isQuizBlockedByApi();' +
      'var pendingBefore=app._isQuizLearningPending(null);' +
      // 真走一遍**OCS 那条**扫帧：拒帧那一支（`_searchChaoxingJobOcs` 里
      // `jobKind==='quiz' && _isQuizApiUnavailable()`）必须自己把「本节被链路挡住」记下来。
      // ⚠️ 不是 `_searchChaoxingJob` —— 那条链路根本没有这个分支，调它等于测了个空。
      //   （实测踩过：写错函数名时 notedFresh 恒为 false，而"接线断了"与"调错了门"长得一模一样。）
      // 把拒帧取证的两把闸也一起清掉，否则 30 秒节流会让 rejects 是空的、读不到原因。
      'app._quizBlockedByApiAt=0;app._jobRejectLogAt=0;app._jobRejectSignature="";' +
      'var jobOcs=null;try{jobOcs=app._searchChaoxingJobOcs([]);}catch(e){jobOcs="throw:"+e.message;}' +
      'var notedAt=app._quizBlockedByApiAt||0;' +
      'var ocsKind=jobOcs?(jobOcs==="throw"||typeof jobOcs==="string"?String(jobOcs):String(jobOcs.kind||"?")):"(null)";' +
      'app._noteQuizBlockedByApi("api-key-missing");' +
      'var blockedNow=app._isQuizBlockedByApi();' +
      'var pendingNow=app._isQuizLearningPending(null);' +
      'var skipRet=app._skipQuizForApiUnavailable(null,null);' +
      'var navWhileBlocked=nav.card+nav.unit+nav.btn;' +
      // ---- 预算用完：必须放行翻页，否则不填 key 的用户会被永久冻在这一节 ----
      'app._quizBlockedSinceAt=Date.now()-181000;' +
      'var blockedExpired=app._isQuizBlockedByApi();' +
      'var skipExpired=app._skipQuizForApiUnavailable(null,null);' +
      'var navAfterBudget=nav.card+nav.unit+nav.btn;' +
      // ---- 用户自己关掉答题：照旧翻页，且**不**按住（那是他的选择，不是故障） ----
      'app._resetRuntimeState();' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:false});' +
      'var reasonToggle=app._getQuizApiUnavailableReason();' +
      'app._noteQuizBlockedByApi(reasonToggle);' +
      'var blockedToggle=app._isQuizBlockedByApi();' +
      'app._switchToNextLearningCard=function(){nav.card++;return true;};' +
      'var skipToggle=app._skipQuizForApiUnavailable(null,null);' +
      'var navToggle=nav.card;' +
      'app._switchToNextLearningCard=origCard;app.nextUnit=origUnit;' +
      'function metaOf(name){for(var i=0;i<got.length;i++){if(got[i].message===name)return got[i].meta||{};}' +
      '  return null;}' +
      'setTimeout(function(){var rej=metaOf("search job: every candidate frame was rejected");' +
      'res({fixture:fixture,resolvedUrl:resolvedUrl,' +
      '  resolvedContainers:resolvedContainers,qExtracted:qExtracted,passedNow:passedNow,' +
      '  ghostLie:ghostLie,ghostPassed:ghostPassed,ghostShape:ghostShape,' +
      '  reasonNoKey:reasonNoKey,blockedBefore:blockedBefore,pendingBefore:pendingBefore,' +
      '  ocsKind:ocsKind,' +
      '  rejects:rej?String((rej.rejects||[]).map(function(r){return r.reason;}).join(" ||| ")):"(无拒帧日志)",' +
      '  notedFresh:(Date.now()-notedAt)<60000,' +
      '  blockedNow:blockedNow,pendingNow:pendingNow,skipRet:skipRet,navWhileBlocked:navWhileBlocked,' +
      '  blockedExpired:blockedExpired,skipExpired:skipExpired,navAfterBudget:navAfterBudget,' +
      '  reasonToggle:reasonToggle,blockedToggle:blockedToggle,skipToggle:skipToggle,navToggle:navToggle,' +
      '  hold:metaOf("quiz blocked by api, holding unit"),' +
      '  giveup:metaOf("quiz blocked too long, giving up unit"),seen:got.length});},400);});})()'
    );
    check('13-A 夹具自证：外层与卡片页都没有题形，而卡片页确实写着「已完成」（否则下面几条是空测）',
      out && out.fixture && out.fixture.topShape === false && out.fixture.cardsShape === false &&
      out.fixture.cardsLie === true, JSON.stringify(out && out.fixture));
    check('13-A：`_resolveQuizAnswerDocument(null)` 走到**真有题那一份**（旧实现停在卡片页，容器数必然是 0）',
      out && out.resolvedContainers >= 1 && /nested-paper-quiz/.test(out.resolvedUrl),
      JSON.stringify(out && { resolvedContainers: out.resolvedContainers, resolvedUrl: out.resolvedUrl }));
    // ⚠️ 这条**不是 13-A 的隔离**：`_extractQuestions` 自己带一套帧遍历，
    //   把上面 resolver 的深走退回一层，它照样能自己摸到卷子（实测反向验证 E1 就是这么露出来的）。
    //   所以它钉的是用户看得见的那个行为「空手回来时当场抠得出题」；
    //   要单独证明 13-A 那半改动，看上面 `_resolveQuizAnswerDocument` 那条。
    check('13-A：`_extractQuestions(null)` 当场抠得出一道题 —— 这才是「答不了」的第一现场',
      out && out.qExtracted >= 1, JSON.stringify(out && out.qExtracted));
    check('13-A：卷子没做时 `_isQuizPassedOrFinished(null)` 为假（旧实现在这里被卡片页的「已完成」骗了）',
      out && out.passedNow === false, JSON.stringify(out && out.passedNow));
    check('13-A 的闸：一份只有「已完成」、全书没题形的文档**不许**被说成做完（帧标记确实为真，闸才不是空转）',
      out && out.ghostShape === false && out.ghostLie === true && out.ghostPassed === false,
      JSON.stringify(out && { ghostShape: out.ghostShape, ghostLie: out.ghostLie, ghostPassed: out.ghostPassed }));
    check('13-B：没填 key 的理由改名成 api-key-missing（关掉答题另有 quiz-toggle-off）',
      out && out.reasonNoKey === 'api-key-missing', JSON.stringify(out && out.reasonNoKey));
    check('13-B：还没记过「被挡住」时不凭空按住整节（既不算 blocked 也不算 pending）',
      out && out.blockedBefore === false && out.pendingBefore === false,
      JSON.stringify(out && { blockedBefore: out.blockedBefore, pendingBefore: out.pendingBefore }));
    check('13-B：OCS 扫帧拒掉必做测验帧时**自己**把按住标记记上（接线真通，不是测试替它调的）',
      out && out.notedFresh === true && out.ocsKind !== 'quiz',
      JSON.stringify(out && { ocsKind: out.ocsKind, notedFresh: out.notedFresh, rejects: out.rejects }));
    check('13-B：被链路挡住时 `_isQuizLearningPending` 仍然为真 —— 「答不了」不再等于「没题做」',
      out && out.blockedNow === true && out.pendingNow === true,
      JSON.stringify(out && { blockedNow: out.blockedNow, pendingNow: out.pendingNow }));
    check('13-B：这时 `_skipQuizForApiUnavailable` 返回 false 且**一次页都不翻**（旧实现直接翻下一节）',
      out && out.skipRet === false && out.navWhileBlocked === 0,
      JSON.stringify(out && { skipRet: out.skipRet, navWhileBlocked: out.navWhileBlocked }));
    check('13-B 的日志说清「停在本节、不是已完成」',
      out && !!out.hold && out.hold.reason === 'api-key-missing' && out.hold.heldMs >= 0,
      JSON.stringify(out && { hold: out.hold, seen: out.seen }));
    check('13-B：按住超过预算后**放行翻页**（不填 key 的用户不能被永久冻在这一节）',
      out && out.blockedExpired === false && out.skipExpired === true && out.navAfterBudget >= 1,
      JSON.stringify(out && { blockedExpired: out.blockedExpired, skipExpired: out.skipExpired, navAfterBudget: out.navAfterBudget }));
    check('13-B：放弃这一节时日志明说「题没做过、请重学补回来」',
      out && !!out.giveup && out.giveup.heldMs >= 180000,
      JSON.stringify(out && { giveup: out.giveup, seen: out.seen }));
    check('13-B：用户自己关掉答题 = 照旧翻页、但不算「被挡住」（那是选择，不是故障）',
      out && out.reasonToggle === 'quiz-toggle-off' && out.blockedToggle === false &&
      out.skipToggle === true && out.navToggle >= 1,
      JSON.stringify(out && { reasonToggle: out.reasonToggle, blockedToggle: out.blockedToggle,
        skipToggle: out.skipToggle, navToggle: out.navToggle }));
  }
});

// ===========================================================================
/** ---- 48. 空答案不再留白（批次 16：交卷前把还空着的题补上占位） ---- */
SCENARIOS.push({
  name: '空答案不再留白：交卷前补占位且不牵连多选',
  path: '/quiz',
  run: async function (ctx) {
    // 现场（2026-11-11 用户那份 20 题的卷子：单选 5 / 多选 5 / 填空 5 / 判断 5）：
    //   `llm answer count mismatch, batch discarded` 主批 5 次 + 补问 5 次，
    //   `quiz round skipped: no progress` 13 次，正确答案缓存 byId/byTitle 全空。
    //   用户原话：「页面停留那边填空题空的，单选题欠了几个」，
    //   裁定：「填空题我觉得不用动脑子，随便填个 1 也行，大部分情况下这个错误没人管的」。
    // 七个形状分开钉：单选（要避开已知错答）· 判断 · 填空（多空各给一格）·
    // 多选（**不许**被牵连：复选点第二次就是取消）· 只剩隐藏域（值进的是平台提交那一栏）·
    // 已经填好的题（幂等，不重填、不占"本轮补了几题"的名额）·
    // 连隐藏域都没有的题（真填不进去，必须留痕、不许冒充已答）。
    var out = await ctx.client.evaluate(
      '(function(){' +
      'var app=window._xxtApp;' +
      'var logs=window.__b16=(window.__b16||[]);' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")logs.push(m);});' +
      'var f=document.createElement("iframe");f.style.width="900px";f.style.height="700px";' +
      'document.body.appendChild(f);' +
      'var d=f.contentDocument;' +
      'd.body.innerHTML=' + JSON.stringify(
        '<div class="TiMu" qid="9301" typename="单选题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">31.</span>【单选题】模型没答上的单选</div></div>' +
        '<ul class="Zy_ulTop">' +
        '<li class="before-after" qid="9301" data="A"><label><input type="radio" name="answer9301" value="A">' +
        '<span class="num_option choice9301" data="A">A</span><span class="fl after">选项甲</span></label></li>' +
        '<li class="before-after" qid="9301" data="B"><label><input type="radio" name="answer9301" value="B">' +
        '<span class="num_option choice9301" data="B">B</span><span class="fl after">选项乙</span></label></li>' +
        '</ul><input type="hidden" id="answer9301" value=""></div>' +
        '<div class="TiMu" qid="9302" typename="判断题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">32.</span>【判断题】模型没答上的判断</div></div>' +
        '<ul class="Zy_ulTop">' +
        '<li class="before-after" qid="9302" data="A"><label><input type="radio" name="answer9302" value="A">' +
        '<span class="num_option choice9302" data="A">A</span><span class="fl after">正确</span></label></li>' +
        '<li class="before-after" qid="9302" data="B"><label><input type="radio" name="answer9302" value="B">' +
        '<span class="num_option choice9302" data="B">B</span><span class="fl after">错误</span></label></li>' +
        '</ul><input type="hidden" id="answer9302" value=""></div>' +
        '<div class="TiMu" qid="9303" typename="填空题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">33.</span>【填空题】两格的填空</div></div>' +
        '<div class="Ty_sort_text">第一格<input type="text" class="answerText" id="blank1">，' +
        '第二格<input type="text" class="answerText" id="blank2">。</div>' +
        '<input type="hidden" id="answer9303" value=""></div>' +
        '<div class="TiMu" qid="9304" typename="多选题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">34.</span>【多选题】不许被牵连的多选</div></div>' +
        '<ul class="Zy_ulTop">' +
        '<li class="before-after" qid="9304" data="A"><label><input type="checkbox" name="answer9304" value="A">' +
        '<span class="num_option choice9304" data="A">A</span><span class="fl after">选项甲</span></label></li>' +
        '<li class="before-after" qid="9304" data="B"><label><input type="checkbox" name="answer9304" value="B">' +
        '<span class="num_option choice9304" data="B">B</span><span class="fl after">选项乙</span></label></li>' +
        '</ul><input type="hidden" id="answer9304" value=""></div>' +
        '<div class="TiMu" id="q9305" qid="9305" typename="填空题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">35.</span>【填空题】压根没有答题框</div></div>' +
        '<div class="Ty_sort_text"><span>这里一个可写的控件都没有</span></div>' +
        '<input type="hidden" id="answer9305" value=""></div>' +
        '<div class="TiMu" qid="9306" typename="单选题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">36.</span>【单选题】模型已经答上的单选</div></div>' +
        '<ul class="Zy_ulTop">' +
        '<li class="before-after" qid="9306" data="A"><label><input type="radio" name="answer9306" value="A" checked="checked">' +
        '<span class="num_option choice9306" data="A">A</span><span class="fl after">选项甲</span></label></li>' +
        '<li class="before-after" qid="9306" data="B"><label><input type="radio" name="answer9306" value="B">' +
        '<span class="num_option choice9306" data="B">B</span><span class="fl after">选项乙</span></label></li>' +
        '</ul><input type="hidden" id="answer9306" value="A"></div>' +
        '<div class="TiMu" id="q9307" qid="9307" typename="填空题">' +
        '<div class="Zy_TItle clearfix"><div class="Pt1"><span class="fontLabel">37.</span>【填空题】连隐藏答案域都没有</div></div>' +
        '<div class="Ty_sort_text"><span>这一题可写的控件一个都没有，也没有 #answer9307</span></div></div>') + ';' +
      'var qs=app._extractFromDocument(d);' +
      // 夹具自证：七个形状必须都被真实解析器认成预期题型 —— 红了说明夹具被改过，
      // 后面的断言就变成在测一个不存在的形状。
      'var types=qs.map(function(q){return String(q.type);});' +
      'var k=app._getQuizWorkKey(d);' +
      'if(!app._quizCorrectAnswerCache)app._quizCorrectAnswerCache={};' +
      'if(!app._quizCorrectAnswerCache[k])app._quizCorrectAnswerCache[k]={byId:{},byTitle:{},wrongById:{},wrongByTitle:{},submittedById:{},submittedByTitle:{}};' +
      // 单选那一题**上一次被判错过 A** —— 占位不许再压回同一个错答
      'app._addWrongQuizAnswer(app._quizCorrectAnswerCache[k],{qid:"9301",answer:"A",type:"single"});' +
      'app._quizCurrentAnsweredKeys={};app._quizCurrentAnswerValues={};' +
      // 36 题模型**已经答上了**（现场就是这种混合卷）：占位不许重填、也不许盖掉它的来源
      'app._markQuizQuestionAnsweredThisRun(qs[5],"llm","A","single");' +
      'var hid=function(q){var el=d.getElementById("answer"+q);return el?String(el.value):"<无>";};' +
      'var picked=function(q){var els=d.getElementsByName("answer"+q);' +
      '  for(var i=0;i<els.length;i++){if(els[i].checked)return String(els[i].value);}' +
      '  return "";};' +
      'var checkedCount=function(q){var els=d.getElementsByName("answer"+q),n=0;' +
      '  for(var i=0;i<els.length;i++){if(els[i].checked)n++;}return n;};' +
      'var src=function(q){var v=app._quizCurrentAnswerValues["id:"+q];return v?v.source:"(没有)";};' +
      'var readyBefore=app._areQuizAnswersFilled(d,qs,{requireThisRun:true});' +
      // ↓↓ 交卷闸门前的那两步，顺序照抄 70-quiz-flow.js：先本地补多选，再补占位
      'app._answerLocalMultiChoiceQuestions(qs,d);' +
      'var multiBefore=checkedCount("9304");' +
      'var filled=app._fillBlankQuizQuestions(qs,d);' +
      'var multiAfter=checkedCount("9304");' +
      'var b1=String(d.getElementById("blank1").value),b2=String(d.getElementById("blank2").value);' +
      'var blankLeft=[];' +
      'qs.forEach(function(q){' +
      '  if(!app._getQuizQuestionFilledValue(d,q))blankLeft.push(app._getQuestionIdFromElement(q._element));});' +
      'var normalPaper=qs.filter(function(q){return app._getQuestionIdFromElement(q._element)!=="9307";});' +
      'var readyAll=app._areQuizAnswersFilled(d,qs,{requireThisRun:true});' +
      'var readyPaper=app._areQuizAnswersFilled(d,normalPaper,{requireThisRun:true});' +
      'var res={n:qs.length,types:types.join(","),readyBefore:readyBefore,readyAll:readyAll,readyPaper:readyPaper,' +
      '  blankLeft:blankLeft.join(","),' +
      '  filledKeys:Object.keys(filled).sort(function(a,b){return a-b;}).join(","),' +
      '  singlePicked:picked("9301"),singleHidden:hid("9301"),' +
      '  judgePicked:picked("9302"),judgeHidden:hid("9302"),' +
      '  fillB1:b1,fillB2:b2,fillHidden:hid("9303"),' +
      '  multiBefore:multiBefore,multiAfter:multiAfter,multiSrc:src("9304"),multiHidden:hid("9304"),' +
      '  noBoxHidden:hid("9305"),noBoxSrc:src("9305"),' +
      '  noBoxVisible:d.getElementById("q9305").querySelectorAll("input[type=text]").length,' +
      '  keptPicked:picked("9306"),keptHidden:hid("9306"),' +
      '  noBox9307:(d.getElementById("answer9307")?"<有>":"<无>"),' +
      '  src9301:src("9301"),src9306:src("9306"),seen:logs.length,' +
      '  cacheHas9301:!!(app._quizCorrectAnswerCache[k].byId&&app._quizCorrectAnswerCache[k].byId["9301"])};' +
      'window.__b16Frame=f;' +
      'return res;})()'
    );
    check('夹具自证：七道题全被真解析器认出（单选/判断/填空/多选/填空/单选/填空）',
      out && out.n === 7 && out.types === 'single,judge,fill,multiple,fill,single,fill',
      JSON.stringify(out && { n: out.n, types: out.types }));
    check('补占位之前 `_areQuizAnswersFilled` 必须是 false（这就是那份卷子交不出去的那道闸）',
      out && out.readyBefore === false, JSON.stringify(out && out.readyBefore));
    check('单选补上了一个真选项字母，且**不是**上次被判错的 A',
      out && out.singlePicked === 'B' && out.singleHidden === 'B',
      JSON.stringify(out && { singlePicked: out.singlePicked, singleHidden: out.singleHidden }));
    check('判断题也补上了（值与选中态两处都要有）',
      out && !!out.judgePicked && out.judgeHidden === out.judgePicked,
      JSON.stringify(out && { judgePicked: out.judgePicked, judgeHidden: out.judgeHidden }));
    check('填空两格各写一个「1」、隐藏域拼成「11」（只给一串 1 时第二格等于没填）',
      out && out.fillB1 === '1' && out.fillB2 === '1' && out.fillHidden === '11',
      JSON.stringify(out && { fillB1: out.fillB1, fillB2: out.fillB2, fillHidden: out.fillHidden }));
    check('多选由前一步本地补上 2 项，占位这一步**一个复选框都没再点**（复选点第二次就是取消）',
      out && out.multiBefore === 2 && out.multiAfter === 2 && out.multiSrc === 'local-multiple',
      JSON.stringify(out && { multiBefore: out.multiBefore, multiAfter: out.multiAfter, multiSrc: out.multiSrc }));
    check('只剩隐藏域的那题：占位写进平台真正提交的 #answer9305（页面上仍没框，这条要如实记着）',
      out && out.noBoxVisible === 0 && out.noBoxHidden === '1' && out.noBoxSrc === 'blank-fallback',
      JSON.stringify(out && { noBoxVisible: out.noBoxVisible, noBoxHidden: out.noBoxHidden, noBoxSrc: out.noBoxSrc }));
    check('模型已经答上的那题没被重填、来源仍是 llm，也不占"本轮补了几题"的名额（幂等）',
      out && out.keptPicked === 'A' && out.keptHidden === 'A' && out.src9306 === 'llm' &&
      out.filledKeys.indexOf('5') < 0,
      JSON.stringify(out && { keptPicked: out.keptPicked, keptHidden: out.keptHidden, src9306: out.src9306, filledKeys: out.filledKeys }));
    check('连隐藏答案域都没有的那题**保持未答**、不许冒充填上（夹具自证：确实没有 #answer9307）',
      out && out.noBox9307 === '<无>' && out.blankLeft === '9307',
      JSON.stringify(out && { noBox9307: out.noBox9307, blankLeft: out.blankLeft }));
    check('除它之外整卷都满了 —— 去掉这一题的卷子 ready 为 true（本批修复的目的）',
      out && out.readyPaper === true && out.readyAll === false,
      JSON.stringify(out && { readyPaper: out.readyPaper, readyAll: out.readyAll, blankLeft: out.blankLeft }));
    check('占位记的 source 是 blank-fallback，不冒充 llm / confirmed-cache',
      out && out.src9301 === 'blank-fallback', JSON.stringify(out && { src9301: out.src9301 }));
    check('占位不进"已确认正确"的答案缓存（否则下一轮会把猜的当对的跳过模型）',
      out && out.cacheHas9301 === false, JSON.stringify(out && out.cacheHas9301));
    check('补上占位的下标正好是 0,1,2,4（单选/判断/填空/只剩隐藏域那题）',
      out && out.filledKeys === '0,1,2,4', JSON.stringify(out && out.filledKeys));

    // 日志要等一拍再读（emitRuntimeLog 走 postMessage，异步送达；
    // 判据一跑完就读必然读到空，于是"没发"和"没等到"同形 —— 本仓库踩过 3 次）
    var late = await new Promise(function (resolve) { setTimeout(resolve, 400); });
    void late;
    var logged = await ctx.client.evaluate(
      '(function(){var logs=window.__b16||[];' +
      'var names=logs.map(function(m){return String(m.message||"");});' +
      'function hit(n){var out=null;logs.forEach(function(m){if(m.message===n)out=m;});return out;}' +
      'var ph=hit("blank questions filled with placeholder before submit");' +
      'var nf=hit("blank questions could not be filled even with placeholder");' +
      'var f=window.__b16Frame;if(f&&f.parentNode)f.parentNode.removeChild(f);' +
      'window.__b16=[];' +
      'return {seen:logs.length,ph:ph,nf:nf};})()'
    );
    check('两条都落了日志：补了几题的计数、以及连占位也填不进去的那一题（中间量带 seen）',
      logged && logged.seen > 0 && !!logged.ph && !!logged.nf,
      JSON.stringify(logged && { seen: logged.seen, ph: !!logged.ph, nf: !!logged.nf }));
    check('那条计数与实际补上的题数一致（4 题：单选/判断/填空/只剩隐藏域），且点名 1 题填不进去',
      logged && logged.ph && logged.ph.meta && logged.ph.meta.count === 4 &&
      logged.ph.meta.unfillable === 1 && logged.nf && logged.nf.meta &&
      logged.nf.meta.indices.join(',') === '6',
      JSON.stringify(logged && { ph: logged.ph && logged.ph.meta, nf: logged.nf && logged.nf.meta }));
  }
});

/**
 * ---- 批次 21：投票任务点（insertvote）----
 *
 * 现场（2026-11-11 真页实测，章节 9000049220）：那一节只剩一个未完成的任务盒，
 * 附件是 `module:"insertvote" / type:"vote" / job:true`。旧实现说不出它的类型 ——
 * 不建 job → 这一节带着一个永不完成的盒子 →「下一节」被平台拦下 → 去学习 →
 * 回到同一章。用户报的「又遇到同一个问题了」就是这一条。
 *
 * 本场景按**真页面的四层形状**跑完整条链，并钉住四件事：
 *   ① 认得出（准入闸不再在 jobid 匹配之前把它拒掉）；
 *   ② 开关关着时**不建 job**，且不因为"存储里没有这一项"而误关（`=== false`）；
 *   ③ 空白的 `#voteIframe` 不算"就绪" —— 必须真的点封面把卷子取回来（第一轮实测
 *      就红在这里：`vote has nothing to submit {text:""}`）；
 *   ④ 勾选要读回 `checked`、提交只点一次、完成判定只认任务盒 class；
 *      这份覆盖层**归投票链路独占**，弹题扫描器不许再来抢（实测两边抢过同一份卷子）。
 */
SCENARIOS.push({
  name: '投票任务点：认得出、空覆盖层不算就绪、勾了才提交',
  path: '/vote',
  run: async function (ctx) {
    var nap = '(new Promise(function(r){setTimeout(r,300)}))';

    // ---- ① / ②：识别与开关 ----
    var gate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._voteTryMap={};' +
      'var on=null, off=null, offAgain=null;' +
      'app.configs.enableVote=true;' +
      'try{on=app._searchChaoxingJobOcs([]);}catch(e){on="throw:"+e.message;}' +
      'app.configs.enableVote=false;' +
      'try{off=app._searchChaoxingJobOcs([]);}catch(e2){off="throw:"+e2.message;}' +
      // 升级前存下来的配置里**没有** enableVote 这一项 —— 必须当成"开着"
      // 升级前存下来的配置里**没有** enableVote 这一项 —— 必须当成"开着"。
      // ⚠️ 整体换掉 configs，不是 delete 属性：`delete` 在这个对象上不生效
      //    （实测 stillThere 仍为 true），拿它模拟"老配置"会做成空测。
      'var savedCfg=app.configs;' +
      'var noKeyObj=Object.assign({}, savedCfg); delete noKeyObj.enableVote;' +
      'app.configs=noKeyObj;' +
      'try{offAgain=app._searchChaoxingJobOcs([]);}catch(e3){offAgain="throw:"+e3.message;}' +
      'app.configs=savedCfg;' +
      'app.configs.enableVote=true;' +
      'function shape(j){return j&&typeof j==="object"?' +
      '  {kind:String(j.kind),jobid:String(j.jobid),workType:String(j.workType),' +
      '   hasFunc:typeof j.func==="function"}:String(j);}' +
      'return {on:shape(on), off:shape(off), noKey:shape(offAgain),' +
      // 中间量：那份"老配置"里确实没有这一项（否则上面那条就是空测）
      ' keyGone:("enableVote" in noKeyObj), restored:("enableVote" in app.configs)};})()'
    );
    check('夹具自证：这份 insertvote 附件被认成 vote 任务点（jobid 对上、带可执行 func）',
      !!gate && !!gate.on && gate.on.kind === 'vote' && gate.on.jobid === 'vote-1' &&
      gate.on.workType === 'job' && gate.on.hasFunc === true,
      JSON.stringify(gate));
    check('「自动投票」关着时不建 job（这一份留给用户自己投）',
      !!gate && gate.off === 'null', JSON.stringify(gate && gate.off));
    check('配置里压根没有 enableVote 这一项（升级前的老配置）时**不能**当成关',
      !!gate && !!gate.noKey && gate.noKey.kind === 'vote',
      JSON.stringify(gate && { noKey: gate.noKey, stillThere: gate.stillThere, typeNow: gate.typeNow }));

    // ---- ③：出厂那份空壳覆盖层不算就绪，必须真点一次封面 ----
    // 实地形状：顶层带着 `.voteContainer`（样式表收着）+ `#voteIframe`（src="" → about:blank、0 字）。
    // 这里**不预先种任何东西**，让第一眼看到的覆盖层就是出厂那一份 —— 种出来的形状测不到真缺陷。
    var stale = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'window.__coverClicks=0;' +
      'var shipped=document.getElementById("voteIframe");' +
      'var vc=document.querySelector(".voteContainer");' +
      'var out={shipped:!!shipped, srcAttr:shipped?String(shipped.getAttribute("src")):"(无)",' +
      '  hidden:!!vc&&getComputedStyle(vc).display==="none"};' +
      'var job=app._searchChaoxingJobOcs([]);' +
      'var doc=job?await app._openVoteOverlay(job):null;' +
      'out.hasJob=!!job; out.coverClicks=Number(window.__coverClicks||0); out.ready=!!doc;' +
      'if(doc){' +
      '  out.text=String(app._voteOverlayText(doc)||"").slice(0,60);' +
      '  var form=app._voteOverlayForm(doc);' +
      '  out.firsts=(form.firsts||[]).length; out.hasSubmit=!!form.submit;' +
      '  out.submitBy=form.submitBy;' +
      '}' +
      'return out;})()'
    );
    check('夹具自证：顶层那份覆盖层是**出厂形状**（#voteIframe 已在、src 是空串、容器收着）',
      !!stale && stale.shipped === true && stale.srcAttr === '' && stale.hidden === true,
      JSON.stringify(stale));
    check('空白覆盖层**不算**就绪：真的点了一次封面去取卷子',
      !!stale && stale.hasJob === true && stale.coverClicks >= 1,
      JSON.stringify(stale));
    check('点完拿到的是真有内容的那份：正文非空、认得出 1 组选项和提交键',
      !!stale && stale.ready === true && !!stale.text && stale.text.length > 0 &&
      stale.firsts === 1 && stale.hasSubmit === true,
      JSON.stringify(stale));

    // ---- ③-b：src 已经写上、卷子却还没填进来的那段空档（真页日志就是这么红的）----
    // 实地证据：`vote has nothing to submit {"jobid":"9000000000000001","text":""}` ——
    // 平台把带 jobid 的地址写进顶层 `#voteIframe` 与卷子真正渲染出来之间有一段路，
    // 这一眼读到的是"src 对得上、正文是空的"。旧代码在这里当就绪，直接拿空卷子去判"没得提交"。
    var racing = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'window.__coverClicks=0;' +
      'var f=document.getElementById("voteIframe");' +
      'f.src="/vote-empty-inner?jobid=vote-1";' +
      'await ' + nap + ';' +
      'var job=app._searchChaoxingJobOcs([]);' +
      'var doc=job?await app._openVoteOverlay(job):null;' +
      'var out={coverClicks:Number(window.__coverClicks||0), ready:!!doc, srcHasJobid:/jobid=vote-1/.test(String(f.src))};' +
      'if(doc){ var form=app._voteOverlayForm(doc); out.firsts=(form.firsts||[]).length; out.hasSubmit=!!form.submit; }' +
      'return out;})()'
    );
    check('src 写上了但正文还空着 → 仍**不算**就绪：会再点一次封面，最后拿到有内容的那份',
      !!racing && racing.srcHasJobid === true && racing.coverClicks >= 1 &&
      racing.ready === true && racing.firsts === 1 && racing.hasSubmit === true,
      JSON.stringify(racing));

    // ---- ④-a：这份覆盖层归投票独占，弹题扫描器不许认领 ----
    var ownership = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var fr=document.getElementById("voteIframe");' +
      'var inner=null;try{inner=fr&&fr.contentDocument;}catch(e){}' +
      // 夹具自证：它对"旧判据"来说**就是**一道弹题（有 A./B. 字样 + 按钮 + 可点选项）
      'var selfProof=false;' +
      'if(inner){var secs=inner.querySelectorAll("div, section");' +
      ' for(var i=0;i<secs.length;i++){' +
      '   var t=String(secs[i].innerText||"");' +
      '   if(t.length>20&&t.length<600&&/[A-F][.、．))]/.test(t)&&' +
      '      secs[i].querySelector("button, .btn, [class*=\\"submit\\"]")&&' +
      '      secs[i].querySelector("input[type=radio], li, label")){selfProof=true;break;}' +
      ' }}' +
      'var claimed=app._checkPopupQuiz();' +
      'var claimedInVote=false;' +
      'try{ var d=claimed&&claimed.ownerDocument;' +
      '   var fe=d&&d.defaultView&&d.defaultView.frameElement;' +
      '   claimedInVote=!!fe&&fe.id==="voteIframe"; }catch(e2){}' +
      // 阳性对照：扫描器本身**没坏** —— 挂一个真的弹题进去，它必须认出来
      'var decoy=document.createElement("div");decoy.className="layui-layer";' +
      'decoy.style.cssText="position:fixed;left:40px;top:40px;width:320px;height:220px;background:#fff";' +
      'decoy.innerHTML="<div>这道视频弹题选什么？</div><div>A. 苹果 B. 香蕉</div>" +' +
      '"<label><input type=\\"radio\\" name=\\"dq\\">苹果</label><button>提交</button>";' +
      'document.body.appendChild(decoy);' +
      'var found=app._checkPopupQuiz();' +
      'var foundText=String((found&&found.innerText)||"").slice(0,40);' +
      'decoy.parentNode.removeChild(decoy);' +
      'return {selfProof:selfProof, claimed:!!claimed, claimedInVote:claimedInVote,' +
      ' decoyFound:!!found, decoyText:foundText};})()'
    );
    check('夹具自证：这份投票在**旧判据**眼里就是一道弹题（不然下面那条是空测）',
      !!ownership && ownership.selfProof === true, JSON.stringify(ownership));
    check('覆盖层摊开时，弹题扫描器不认领它（投票归投票链路独占）',
      !!ownership && ownership.claimed === false, JSON.stringify(ownership));
    check('阳性对照：扫描器没坏 —— 真弹题照样认得出（排除"整条链一起哑"）',
      !!ownership && ownership.decoyFound === true && /苹果/.test(String(ownership.decoyText)),
      JSON.stringify(ownership));

    // ---- ④-b：真跑一遍 job：勾选读回、只提交一次、盒子 class 翻转 ----
    var done = await ctx.client.evaluate(
      '(async function(){' +
      'var app=window._xxtApp;' +
      'var job=app._searchChaoxingJobOcs([]);' +
      'var out={hasFunc:!!job&&typeof job.func==="function"};' +
      'if(!job||typeof job.func!=="function") return out;' +
      'out.ran=await job.func();' +
      'var fr=document.getElementById("voteIframe");' +
      'var w=null;try{w=fr&&fr.contentWindow;}catch(e){}' +
      'out.submitted=Number((w&&w.__submitted)||0);' +
      'out.picked=String((w&&w.__picked)||"");' +
      'var cd=document.getElementById("iframe").contentDocument;' +
      'var box=cd.querySelector(".ans-attach-ct");' +
      'out.boxCls=String(box&&box.className);' +
      'out.backClicks=Number(window.__backClicks||0);' +
      'out.tryMap=JSON.stringify(app._voteTryMap||{});' +
      // 再做一次：已经完成就不许再排进待办（否则同一份票被反复提交）
      'var again=app._searchChaoxingJobOcs([]);' +
      'out.again=again?String(again.kind)+"/"+String(again.workType):null;' +
      'return out;})()'
    );
    check('前置条件：任务点带着可执行的 func 交出来', !!done && done.hasFunc === true, JSON.stringify(done));
    check('勾选项**读回**了 checked（有勾选证据，不是空点一次提交）',
      !!done && done.picked === 'A', JSON.stringify(done && done.picked));
    check('只提交一次', !!done && done.submitted === 1, JSON.stringify(done && done.submitted));
    check('完成判定以任务盒 class 为准：ans-job-finished 真写上了',
      !!done && /ans-job-finished/.test(String(done.boxCls)), JSON.stringify(done && done.boxCls));
    check('跑完收起覆盖层（点平台的「返回」，不是自己 hide 掉）',
      !!done && done.backClicks >= 1, JSON.stringify(done && done.backClicks));
    check('成功这一轮把重试计数清零', !!done && done.tryMap === '{}', JSON.stringify(done && done.tryMap));
    check('已经完成的任务点不再被排进待办（不会反复提交同一份票）',
      !!done && (done.again === null || /finished/.test(String(done.again))),
      JSON.stringify(done && done.again));
  }
});

/** ---- 51. 目录标记只说「这一节」的话（批次 20-I） ---- */
//
// 现场量的三条，逐条钉住（用户正在刷的那门课，163 个目录项）：
//   ① `.catalog_points_yi` 的文案是「**N个待完成任务点**」，`icon_Completed` 才是「已完成」；
//      `.catalog_points_er/san` 全书**一个都没有** —— 旧判据把 yi 当成完成证据，方向是反的。
//   ② 目录项的 id 是 `cur<chapterId>`，稳态下与 `.posCatalog_active` 同一个元素，
//      但 active 由平台脚本挪、主帧 `src` 当场就变 → 切章节那一秒读 active 会拿到**上一节**
//      的「已完成」，替刚切过来的这一节发证（真日志：`chapter changed` 与
//      `skip completed {by:"catalog-marker",tasks:0}` 同一秒）。
//   ③ `input.jobUnfinishCount` 是平台留的机器可读否决（现场 57 项，值 1~6）。
// ①②③ 合起来是下面 `completedRaced` 那一组：旧代码在这里**必然为 true 并点掉一节**。
SCENARIOS.push({
  name: '目录标记：待完成任务点不算已完成、切章节不借上一节的章',
  path: '/catalog',
  run: async function (ctx) {
    // 换标记用**现场那套 markup**（span/prevHoverTips/orangeNew/input 四件齐全），
    // 不是随手拼一个 class —— 判据读的就是这几层。
    var swap =
      'function swap(cid,kind){var n=document.getElementById("cur"+cid);if(!n)return "no-item";' +
      'var old=n.querySelectorAll("input.jobUnfinishCount,[class*=catalog_points],[class*=icon_]");' +
      'for(var i=0;i<old.length;i++){old[i].parentNode.removeChild(old[i]);}' +
      'if(kind==="done"){var s=document.createElement("span");s.className="icon_Completed prevTips";' +
      'var t=document.createElement("span");t.className="prevHoverTips";t.textContent="已完成";' +
      's.appendChild(t);n.appendChild(s);return "done";}' +
      'var u=document.createElement("input");u.type="hidden";u.value="1";u.className="jobUnfinishCount";' +
      'n.appendChild(u);' +
      'var s2=document.createElement("span");s2.className="catalog_points_yi prevTips";' +
      'var t2=document.createElement("span");t2.className="prevHoverTips";t2.textContent="1个待完成任务点";' +
      's2.appendChild(t2);n.appendChild(s2);return "pending";}'

    var r = await ctx.client.evaluate(
      '(function(){' + swap +
      'var app=window._xxtApp;var out={};' +
      'var pend=document.getElementById("cur9000049294"),done=document.getElementById("cur9000049293");' +
      // ---- 夹具自证：形状与现场一致 ----
      'out.activeIsOld=String((document.querySelector(".posCatalog_active")||{}).id||"");' +
      'out.pendTip=String((pend.querySelector(".prevHoverTips")||{}).textContent||"");' +
      'out.doneTip=String((done.querySelector(".prevHoverTips")||{}).textContent||"");' +
      'out.erSanAnywhere=document.querySelectorAll(".catalog_points_er,.catalog_points_san").length;' +
      'out.pendingCountIsInput=(function(){var u=pend.querySelector("input.jobUnfinishCount");' +
      '  return u?String(u.value):"(无)";})();' +
      'out.itemsAreFlat=pend.querySelectorAll(".posCatalog_select").length===0;' +
      'out.hasMainFrame=!!document.getElementById("iframe");' +
      'out.visibleBoxes=document.querySelectorAll(".ans-attach-ct").length;' +
      // ---- 判据实跑：认章节号，不认 active ----
      'out.itemForChapter=String((app._catalogItemForChapter()||{}).id||"");' +
      'out.uncPend=String(app._catalogUnfinishedCount(pend));' +
      'out.uncDone=String(app._catalogUnfinishedCount(done));' +
      'out.hasTaskPoint=app._hasTaskPoint();' +
      'var st=app._getVisibleTaskCompletionState();' +
      'out.noVisibleTasks=!!st&&st.hasTasks===false;' +
      // ---- ① 现场那一秒：active 还挂着上一节的「已完成」，这一节写着「1个待完成任务点」 ----
      'app._chapterChangedAt=Date.now()-60000;app._taskFrameLoadingUntil=0;app._quizParseRetryUntil=0;' +
      'app._quizSubmitPending=false;app.configs.restudy=false;app.configs.autoNext=true;' +
      'out.completedRaced=app._isCurrentCompleted();' +
      'out.evidenceRaced=String(app._completionEvidence||"");' +
      'var unitCalls=0,cardCalls=0;var oldU=app.nextUnit,oldC=app._switchToNextLearningCard;' +
      'app.nextUnit=function(){unitCalls++;};app._switchToNextLearningCard=function(){cardCalls++;return false;};' +
      'out.skippedRaced=app._skipIfCompleted();' +
      // ⚠️ 计数器必须**当场取样后清零**再往下做阳性对照 —— 对照那一跳真的会调
      //    `_switchToNextLearningCard` + `nextUnit` 各一次，最后统一读就会把它们记到 race 头上。
      'out.unitCallsRaced=unitCalls;out.cardCallsRaced=cardCalls;unitCalls=0;cardCalls=0;' +
      // ---- ② 这一节自己也变成「已完成」+ 发现窗口已过 → 目录这条出口照常推进 ----
      'out.swapDone=swap("9000049294","done");' +
      'out.completedAfterWindow=app._isCurrentCompleted();' +
      'out.evidenceAfter=String(app._completionEvidence||"");' +
      'out.skippedAfter=app._skipIfCompleted();' +
      'out.unitCallsAfter=unitCalls;out.cardCallsAfter=cardCalls;unitCalls=0;cardCalls=0;' +
      // ---- ③ 同一份「已完成」，但章节号**刚刚**认出来（窗口内）→ 目录不许发证 ----
      'app._chapterChangedAt=Date.now();app._idleEmptySince=0;' +
      'out.completedInsideWindow=app._isCurrentCompleted();' +
      'out.evidenceInside=String(app._completionEvidence||"");' +
      // ---- ④ 换回「待完成」时 `_hasTaskPoint()` 必须重新变 true（yi 与"有任务点"同一口径） ----
      'out.swapPending=swap("9000049294","pending");' +
      'out.hasTaskPointAgain=app._hasTaskPoint();' +
      'app.nextUnit=oldU;app._switchToNextLearningCard=oldC;' +
      'return out;})()'
    );

    check('夹具自证：目录项 id 是 cur<chapterId>、active 停在上一节、' +
      '待完成那节的 tip 写「1个待完成任务点」且计数是可读的 input（与实地同一形状）',
      !!r && r.activeIsOld === 'cur9000049293' && r.pendTip === '1个待完成任务点' &&
      r.doneTip === '已完成' && r.pendingCountIsInput === '1' && r.itemsAreFlat === true &&
      r.erSanAnywhere === 0 && r.hasMainFrame === true && r.visibleBoxes === 0,
      JSON.stringify(r && { activeIsOld: r.activeIsOld, pendTip: r.pendTip, doneTip: r.doneTip,
        pendingCountIsInput: r.pendingCountIsInput, erSanAnywhere: r.erSanAnywhere,
        itemsAreFlat: r.itemsAreFlat, visibleBoxes: r.visibleBoxes }));
    check('前置：这一节页面里确实**一个可见任务点都没有**（否则测不到目录那条支）',
      !!r && r.noVisibleTasks === true, JSON.stringify(r && r.noVisibleTasks));
    check('按章节号认目录项（拿到的是这一节 cur9000049294，不是 active 的上一节）',
      !!r && r.itemForChapter === 'cur9000049294', JSON.stringify(r && r.itemForChapter));
    check('jobUnfinishCount 读成数字 1；已完成那节没有这个 input → NaN（不冒充否决）',
      !!r && r.uncPend === '1' && r.uncDone === 'NaN', JSON.stringify(r && { uncPend: r.uncPend, uncDone: r.uncDone }));
    check('「N个待完成任务点」= 这一节**有**任务点：_hasTaskPoint() 为 true（旧判据在这条上方向相反）',
      !!r && r.hasTaskPoint === true && r.hasTaskPointAgain === true,
      JSON.stringify(r && { hasTaskPoint: r.hasTaskPoint, again: r.hasTaskPointAgain }));
    check('★ 切章节那一秒不再被当成做完：上一节的「已完成」不给这一节发证，跳过出口一次都不点',
      !!r && r.completedRaced === false && r.evidenceRaced === '' &&
      r.skippedRaced === false && r.unitCallsRaced === 0 && r.cardCallsRaced === 0,
      JSON.stringify(r && { completedRaced: r.completedRaced, evidenceRaced: r.evidenceRaced,
        skippedRaced: r.skippedRaced, unitCallsRaced: r.unitCallsRaced, cardCallsRaced: r.cardCallsRaced }));
    check('阳性对照：这一节自己显示「已完成」且窗口已过 → 目录这条出口照常推进（by=catalog-marker）',
      !!r && r.swapDone === 'done' && r.completedAfterWindow === true &&
      r.evidenceAfter === 'catalog-marker' && r.skippedAfter === true &&
      r.unitCallsAfter === 1 && r.cardCallsAfter === 1,
      JSON.stringify(r && { swapDone: r.swapDone, completedAfterWindow: r.completedAfterWindow,
        evidenceAfter: r.evidenceAfter, skippedAfter: r.skippedAfter,
        unitCallsAfter: r.unitCallsAfter, cardCallsAfter: r.cardCallsAfter }));
    check('发现窗口内目录图标不许发证（章节号刚认出来，帧可能还没渲染任务点）',
      !!r && r.completedInsideWindow === false && r.evidenceInside === '',
      JSON.stringify(r && { completedInsideWindow: r.completedInsideWindow, evidenceInside: r.evidenceInside }));
  }
});

/** ---- 52. 页面被推到没有课程结构的地方，空转逃生门不许再点「下一节」（批次 20-I） ---- */
//
// 现场那条链（2026-11-10 19:12:18 → 19:13:23）：`skip completed` → `_dismissPopups()`
// 误点常驻的「下一节」→ 页面到了 `https://i.chaoxing.com/base?…`，那里没有课程结构，
// 而 `_tryAdvanceIdleSection` 照样往下走（附件 0、任务帧 0、没视频、readyState complete）→
// 30 秒后拿 `location.href + 标题` 当键**又点一次** → 在陌生页面上 `study stuck`。
// 现在这道门要求页面至少认出一个课程标记；认不出就**只出日志、不点前进**。
// 阳性对照在同一页做：临时挂一个 `.prev_title` 进去，同一条门必须放行并点一次 ——
// 否则"整条链一次都没走到那层"也会让上面那组断言全绿（AGENTS §5 那条假绿）。
SCENARIOS.push({
  name: '非刷课页：空转逃生门不点前进，且日志说清为什么',
  path: '/no-course',
  run: async function (ctx) {
    var probe =
      '(function(){var app=window._xxtApp;' +
      'window.__b20i=window.__b20i||[];' +
      'if(!window.__b20iBound){window.__b20iBound=true;window.addEventListener("message",function(e){' +
      '  var m=e.data;if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b20i.push(m);});}' +
      'var out={noMainFrame:!document.getElementById("iframe"),' +
      '  noCourseShape:!document.querySelector(".ans-attach-ct, .ans-job-icon, [id^=cur], .posCatalog_select, .prev_title"),' +
      '  readyState:String(document.readyState)};' +
      'function run(){' +
      '  var unitCalls=0,cardCalls=0;var oldU=app.nextUnit,oldC=app._switchToNextLearningCard;' +
      '  app.nextUnit=function(){unitCalls++;};app._switchToNextLearningCard=function(){cardCalls++;return false;};' +
      // ⚠️ 必须自己钉住 `autoNext`：推进那一段最后一步是 `if (!this.configs.autoNext) return true;`
      //    —— 它**返回 true 却一次都不点**，和"被课程形状挡下"在断言里长得一模一样。
      //    全套跑时前面某个场景把 storage 里的 autoNext 写成 false（整轮共用一份扩展存储），
      //    定向跑就复现不出来（AGENTS §5「夹具必须自己钉住它依赖的共享状态」）。
      '  var oldAuto=app.configs.autoNext;app.configs.autoNext=true;' +
      '  app._idleEmptySince=Date.now()-40000;app._idleAdvanceKey="";app._idleDeclineLogAt=0;' +
      '  var handled=app._tryAdvanceIdleSection([]);' +
      '  app.nextUnit=oldU;app._switchToNextLearningCard=oldC;app.configs.autoNext=oldAuto;' +
      '  return {handled:handled,unitCalls:unitCalls,cardCalls:cardCalls,emptySince:app._idleEmptySince};}' +
      'out.declined=run();' +
      // 阳性对照：这一页只要多一个课程标记，同一条门就该放行
      'var t=document.createElement("div");t.className="prev_title";t.textContent="某一节";' +
      'document.body.appendChild(t);' +
      'out.control=run();' +
      't.parentNode.removeChild(t);' +
      'return out;})()';

    var r = await ctx.client.evaluate(probe);
    // 日志走 postMessage，异步送达 —— 不等一拍就读，"没发"和"没等到"长得一模一样
    await new Promise(function (res) { setTimeout(res, 400); });
    var logs = await ctx.client.evaluate(
      '(function(){var out={names:[],declined:null};' +
      '(window.__b20i||[]).forEach(function(m){var n=String(m.message||"");' +
      '  out.names.push(n);if(n.indexOf("study idle declined")===0)out.declined=m;});' +
      'window.__b20i=[];return out;})()'
    );

    check('夹具自证：这一页没有主帧、也没有任何一个课程标记，readyState 已 complete',
      !!r && r.noMainFrame === true && r.noCourseShape === true && r.readyState === 'complete',
      JSON.stringify(r));
    check('认不出课程结构 → 这道门接管（handled=true），**一次前进都不点**',
      !!r && !!r.declined && r.declined.handled === true &&
      r.declined.unitCalls === 0 && r.declined.cardCalls === 0,
      JSON.stringify(r && r.declined));
    check('接管之后把"空够 30 秒"的计时清零（不会下一轮又攒出一个可点窗口）',
      !!r && !!r.declined && r.declined.emptySince === 0,
      JSON.stringify(r && r.declined && r.declined.emptySince));
    check('阳性对照：同一条链、同一页，多一个 .prev_title 就放行并点一次（说明挡住的是这道门，不是别处）',
      !!r && !!r.control && r.control.handled === true && r.control.unitCalls === 1,
      JSON.stringify(r && r.control));
    check('被挡下一定出日志（静默跳过用户的进度是不可接受的）',
      !!logs && !!logs.declined && /study idle declined/.test(String(logs.declined.message)) &&
      !!logs.declined.meta && /i\.mooc|no-course|\.html|https?:/.test(String(logs.declined.meta.href || '')) === true,
      JSON.stringify(logs && { names: logs.names.slice(-6), declined: logs.declined }));
  }
});

/** ---- 41. 乱选一次真交卷：零模型请求、填满整卷、先留可设置的检查窗口、到点真的交出去 ----
 *
 * 为什么要这一条（2026-11-12，用户两句直接问出来的）：
 *   ①「沙盒里面的题目根本没有填空然后就过去了？如果不接 API 省钱，
 *      为啥不用『乱答』真乱答一次，好歹确定确实可以答？」
 *   ②「关于乱答最好留一个可设置的窗口，别直接默认『不会』然后就提交还不能修改啊，这太诡异了」
 *   查完现状，两个直觉都对、但落点不一样：
 *     · 填空题**有**断言 —— 「答题往返 + 回填 DOM」逐题断 `#answer1004==="甲乙"` 与
 *       `.fillBox` 两个输入框分别是 甲/乙；而且那条走的本来就是**本地假服务器**
 *       （127.0.0.1 + e2e-key），一分钱不花。所以"沙盒没填空"是错觉。
 *     · 乱选也有一组断言（「多选题」场景里的 ⑦⑦b⑦c⑦d⑦e），可 ⑦e 是**手工逐题调 `_fill*` 原语**，
 *       绕过了 `_handleQuiz` 的接线。真缝有两条：
 *         - **提交门在沙盒里从来没开过**：`/quiz` 那份夹具没有现场那层提交入口
 *           （`window.btnBlueSubmit` / `.btnSubmit` / `#form1` 三样全空，而 `_getCurrentTitle()`
 *           只读外层刷课页的 `.prev_title`，在这里恒为空串）→ `auto submit skipped` →
 *           「填满了却一次都没交」，与用户看到的现象一模一样。
 *           修法按 AGENTS §5：**改夹具**（新 `/quiz-real`，形状量自现场真日志
 *           `quiz form ready: true` → `call btnBlueSubmit()`），不去动那道闸。
 *         - **交卷不可逆**：乱选的答案是猜的，填完立刻交 = 用户连改的机会都没有。
 *           现在按配置 `randomAnswerReviewSec` 先停一个窗口（批次 24）。
 *   所以这条把整串跑完：抠题 → 本地随机答案 → 回填 → 满卷判定 → **窗口内一次都不交** →
 *   到点自动交（`btnBlueSubmit()` + 站点确认框 `#popok`），全程零模型请求；
 *   最后把窗口设成 0，验「停在原地等用户自己交，而且不会把刚填/刚改的答案再随机冲掉」。
 */
SCENARIOS.push({
  name: '乱选一次真交卷：零模型请求、逐题有值、填空不是白框、先留检查窗口再到点交卷',
  path: '/quiz-real',
  run: async function (ctx) {
    var before = ctx.mock.requests.length;

    // 夹具自证（AGENTS §5：夹具要长得像现场，否则测的是"代码和自己一致"）：
    // 现场那三样提交入口 + 填空题两个可见输入框，缺一样这条测的就不是这件事。
    var shape = await ctx.client.evaluate(
      '(function(){var btn=document.getElementById("submitBtn");' +
      'return {blanks:document.querySelectorAll(".fillBox input").length,' +
      'form1:document.querySelectorAll("#form1").length,' +
      'btnSubmit:document.querySelectorAll(".btnSubmit").length,' +
      'blue:typeof window.btnBlueSubmit,tiMu:document.querySelectorAll(".TiMu").length,' +
      'tag:btn?String(btn.tagName):"(none)",text:btn?String(btn.innerText||btn.value||""):""};})()'
    );
    check('前提：夹具照现场补齐提交入口（btnBlueSubmit + .btnSubmit + #form1）与填空题两个可见空',
      !!shape && shape.blanks === 2 && shape.form1 === 1 && shape.btnSubmit === 1 &&
      shape.blue === 'function' && shape.tiMu === 5 &&
      shape.tag === 'BUTTON' && /提交/.test(shape.text),
      JSON.stringify(shape));

    // 日志缓冲：runtime_log 走 postMessage **异步**送达，每一段读之前都要等一拍
    await ctx.client.evaluate(
      '(function(){window.__b24=[];if(!window.__b24Bound){window.__b24Bound=true;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      'if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b24.push(m);});}})()'
    );
    var drainLogs = async function () {
      await new Promise(function (res) { setTimeout(res, 400); });
      var out = await ctx.client.evaluate(
        '(function(){var names=(window.__b24||[]).map(function(m){return String(m.message||"")});' +
        'var held=0,armed=0;(window.__b24||[]).forEach(function(m){var n=String(m.message||"");' +
        '  if(n==="quiz held for manual review")held++;if(n==="quiz review window armed before submit")armed++;});' +
        'window.__b24=[];return {names:names.slice(-8),held:held,armed:armed};})()'
      );
      return out;
    };

    // ⚠️ 刻意**不** writeConfig：用户开「乱选」时本来就没有凭据，留空 apiKey 才对得上那条路
    // （`_getQuizApiUnavailableReason` 在乱选下第一行就返回空串；否则 `_skipQuizForApiUnavailable`
    // 会把整道题跳过 —— 变成"什么都不答"而不是"乱答"）。
    // 这一段代替 OCS 循环：真实循环**每秒**调到 `_maybeSubmitQuiz`，这里就按同样的节奏调，
    // 才能同时验到「窗口内不交」「窗口没被重数」与「到点才交」。
    var sim = await ctx.client.evaluate(
      '(async function(){var app=window._xxtApp;' +
      'var nap=function(ms){return new Promise(function(r){setTimeout(r,ms);});};' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,randomAnswer:true,apiKey:"",hasApiKey:false,' +
      'autoNext:false,enableCaptcha:false,enableDiscussion:false,randomAnswerReviewSec:10});' +
      'app._quizApiFailUntil=0;app._quizAnswered=false;app._quizInProgress=false;app._quizSubmitPending=false;' +
      'app._quizReadyToSubmit=false;app._quizReadyWorkKey="";app._quizCurrentQuestions=null;' +
      'app._quizReviewPaperKey="";app._quizReviewUntil=0;' +
      'window.__b24=[];' +
      'var out={isRandom:app._isRandomAnswerMode(),reason:app._getQuizApiUnavailableReason()};' +
      // ① 跑完整一轮：抠题 → 随机答案 → 回填 → 满卷判定
      'await app._handleQuiz(null);' +
      'var ready=false;' +
      'for(var i=0;i<40;i++){if(app._quizReadyToSubmit===true){ready=true;break;}await nap(300);}' +
      'out.ready=ready;' +
      'out.readyAt=Date.now();out.armedLeftMs=(app._quizReviewUntil||0)-Date.now();' +
      'out.armedKey=String(app._quizReviewPaperKey||"");' +
      // ② 窗口内连调四次：一次都不许交，且窗口不能被重数（leftMs 必须单调往下）。
      //    ⚠️ 窗口设 10 秒，比采样循环**明显长** —— 实测这一页每次 nap(500) 实际跨到 ~1.5 秒
      //    （回填审计那些活还在跑），3 秒的窗口在第四次调用前就走完了，
      //    于是"窗口内不交"测的其实是"脚本跑多快"（2026-11-12 三条一起红就是这个）。
      'out.during=[];' +
      'for(var k=0;k<4;k++){app._maybeSubmitQuiz(null);' +
      '  out.during.push({blue:window.__omBlueCalls||0,left:(app._quizReviewUntil||0)-Date.now(),' +
      '    key:String(app._quizReviewPaperKey||"").slice(-6)});await nap(500);}' +
      // ③ 等到窗口真的过（最多 16 秒），再调一次 → 该调站点的 btnBlueSubmit()
      'var w=0;while((app._quizReviewUntil||0)-Date.now()>0&&w<40){await nap(400);w++;}' +
      'out.waited=w;' +
      'app._maybeSubmitQuiz(null);' +
      'await nap(500);' +
      'out.afterWindow={blue:window.__omBlueCalls||0,key:String(app._quizReviewPaperKey||""),' +
      '  pending:!!app._quizSubmitPending};' +
      // ④ page.js 在 +1200ms 自己去点站点确认框里的 #popok
      'await nap(1600);' +
      'out.done={blue:window.__omBlueCalls||0,ok:window.__omOkCalls||0,submitted:window.__submitted===true};' +
      // 逐题取证（失败时要一眼看出是哪题、什么题型、填成什么）
      'var qs=app._extractQuestions(null)||[];' +
      'out.per=qs.map(function(q){var v="";try{v=String(app._getQuizQuestionFilledValue(null,q)||"");}catch(e){v="(err)";}' +
      '  return {qid:String(q.qid||""),type:String(q.type||""),v:v};});' +
      'out.blanks=Array.prototype.map.call(document.querySelectorAll(".fillBox input"),function(i){return i.value;});' +
      'var audit=app._auditQuizFillBeforeSubmit(qs,null)||{};var m=audit.meta||{};' +
      'out.audit={total:m.total,withValue:m.withValue,text:m.text,textVisible:m.textVisible,textHidden:m.textHidden};' +
      'return out;})()'
    );

    check('乱选开关真的开着，且没有"API 不可用"那条理由（有理由=整题被跳过，什么都不答）',
      !!sim && sim.isRandom === true && sim.reason === '',
      JSON.stringify(sim && { isRandom: sim.isRandom, reason: sim.reason }));
    check('整卷一个模型请求都没发（这就是不花钱的那条路）',
      ctx.mock.requests.length === before,
      '多发了 ' + (ctx.mock.requests.length - before) + ' 次');
    check('逐题都有值：单选/多选/判断/填空/简答 一题都没留白',
      !!sim && sim.ready === true && sim.per.length >= 5 && sim.per.every(function (p) { return p.v !== ''; }),
      JSON.stringify(sim && { ready: sim.ready, per: sim.per }));
    check('填空题不是白框：两个空都写进了**可见的输入框**（用户说的"根本没填空"就断在这）',
      !!sim && sim.blanks.length === 2 &&
      sim.blanks.every(function (b) { return String(b).length > 0; }) &&
      sim.audit.text >= 1 && sim.audit.textVisible === sim.audit.text,
      JSON.stringify(sim && { blanks: sim.blanks, audit: sim.audit }));
    check('★ 交卷前真的停了一个可设置的窗口：窗口内四次调用一次都没提交，倒计时逐次变小（没被重数）',
      !!sim && sim.armedLeftMs > 0 && sim.armedKey !== '' &&
      sim.during.length === 4 && sim.during.every(function (d) { return d.blue === 0; }) &&
      sim.during[3].left > 0 && sim.during[3].left < sim.during[0].left &&
      sim.during.every(function (d) { return d.key === sim.armedKey.slice(-6); }),
      JSON.stringify(sim && { armedLeftMs: sim.armedLeftMs, during: sim.during }));
    check('★ 到点自动交出去：站点的 btnBlueSubmit() 被调了、窗口标记清掉了（否则永远是"填了但交不出去"）',
      !!sim && !!sim.afterWindow && sim.afterWindow.blue >= 1 && sim.afterWindow.key === '',
      JSON.stringify(sim && { afterWindow: sim.afterWindow, done: sim.done }));
    var armedLogs = await drainLogs();
    check('窗口只登记一次、且这条链有日志（每秒重数 = 窗口永远走不完；静默 = 用户不知道插件在等什么）',
      !!armedLogs && armedLogs.armed === 1,
      JSON.stringify(armedLogs));
    check('站点自己的确认框也被点了（#popok），卷子真的进入已提交状态',
      !!sim && !!sim.done && sim.done.blue >= 1 && sim.done.ok >= 1 && sim.done.submitted === true,
      JSON.stringify(sim && sim.done));

    // ===== ⑤ 窗口设成 0：完全不自动交卷，且不许把用户的答案反复随机冲掉 =====
    await ctx.client.evaluate('location.reload()').catch(function () {});
    var readyBy = Date.now() + 10000;
    while (Date.now() < readyBy && !(await ctx.client.evaluate(
      'document.readyState==="complete" && !!window._xxtApp && !!document.getElementById("submitBtn")'))) await sleep(200);
    await ctx.client.evaluate(
      '(function(){window.__b24=[];if(!window.__b24Bound){window.__b24Bound=true;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      'if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b24.push(m);});}})()'
    );

    var manual = await ctx.client.evaluate(
      '(async function(){var app=window._xxtApp;' +
      'var nap=function(ms){return new Promise(function(r){setTimeout(r,ms);});};' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,randomAnswer:true,apiKey:"",hasApiKey:false,' +
      'autoNext:false,enableCaptcha:false,enableDiscussion:false,randomAnswerReviewSec:0});' +
      'app._quizApiFailUntil=0;app._quizAnswered=false;app._quizInProgress=false;app._quizSubmitPending=false;' +
      'app._quizReadyToSubmit=false;app._quizReadyWorkKey="";app._quizCurrentQuestions=null;' +
      'app._quizReviewPaperKey="";app._quizReviewUntil=0;window.__b24=[];' +
      'var out={};' +
      'await app._handleQuiz(null);' +
      'for(var i=0;i<40&&app._quizReadyToSubmit!==true;i++)await nap(300);' +
      'out.ready=app._quizReadyToSubmit===true;' +
      // 用户改一笔（模拟"检查时自己动手改填空"），后面必须一个字都不变
      'var box=document.querySelector(".fillBox input");if(box)box.value="我自己改的";' +
      'var beforeVals=Array.prototype.map.call(document.querySelectorAll(".fillBox input"),function(i){return i.value;}).join("|");' +
      'out.beforeVals=beforeVals;' +
      // 窗口=0：连调六次提交都不许交
      'out.blueEach=[];' +
      'for(var k=0;k<6;k++){app._maybeSubmitQuiz(null);out.blueEach.push(window.__omBlueCalls||0);await nap(400);}' +
      // 而且这一份卷子还在"等用户"的状态：再跑一轮 _handleQuiz 不许重新随机（会盖掉手改的答案）
      'out.answered=app._quizAnswered===true;' +
      'await app._handleQuiz(null);await nap(600);' +
      'out.afterVals=Array.prototype.map.call(document.querySelectorAll(".fillBox input"),function(i){return i.value;}).join("|");' +
      'out.blue=window.__omBlueCalls||0;out.ok=window.__omOkCalls||0;' +
      'out.submitted=window.__submitted===true;out.state={key:String(app._quizReviewPaperKey||""),until:app._quizReviewUntil||0};' +
      // ⑥ 用户检查完想让它自己交：把设置从 0 调回 3 秒 —— 必须**重新给一个窗口**，
      //    而不是「一升设置就立刻交卷」（那正好把刚改完的卷子秒交出去，回到用户抱怨的那个行为）
      'app.configs=Object.assign({},app.configs,{randomAnswerReviewSec:3});' +
      'app._maybeSubmitQuiz(null);' +
      'out.raised={blue:window.__omBlueCalls||0,left:(app._quizReviewUntil||0)-Date.now(),' +
      '  key:String(app._quizReviewPaperKey||"").slice(-6)};' +
      'app._maybeSubmitQuiz(null);await nap(400);app._maybeSubmitQuiz(null);' +
      'out.raised2Blue=window.__omBlueCalls||0;' +
      'out.raisedKey=String(app._quizReviewPaperKey||"").slice(-6);' +
      'return out;})()'
    );
    var manualLogs = await drainLogs();

    check('★ 窗口设 0 = 不自动交卷：六次提交调用一次都没点，卷子还停在原地等用户',
      !!manual && manual.ready === true && manual.blue === 0 && manual.ok === 0 &&
      manual.submitted === false &&
      Array.isArray(manual.blueEach) && manual.blueEach.length === 6 &&
      manual.blueEach.every(function (n) { return n === 0; }),
      JSON.stringify(manual && { ready: manual.ready, blueEach: manual.blueEach, submitted: manual.submitted }));
    check('停在等用户这件事出日志，而且**一份卷子只出一条**（静默=不知道插件在等什么，每秒一条=刷屏）',
      !!manualLogs && manualLogs.held === 1 && manualLogs.armed === 1,
      JSON.stringify(manualLogs));
    check('★ 设置从 0 调回大于 0 = 重新给一个检查窗口，而不是「一升设置就立刻交卷」',
      !!manual && !!manual.raised && manual.raised.blue === 0 && manual.raised.left > 0 &&
      manual.raised2Blue === 0 && manual.raisedKey === manual.raised.key,
      JSON.stringify(manual && { raised: manual.raised, raised2Blue: manual.raised2Blue, raisedKey: manual.raisedKey }));
    check('等用户期间再跑一轮答题不会重新随机：用户手改的那一笔原样还在',
      !!manual && manual.afterVals === manual.beforeVals && manual.answered === true &&
      /我自己改的/.test(String(manual.afterVals || '')),
      JSON.stringify(manual && { beforeVals: manual.beforeVals, afterVals: manual.afterVals, answered: manual.answered }));

    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{randomAnswer:false});return true;})()'
    );
  }
});

// ── 前端专项：弹窗点开关，整张补丁要存得下去（同学机器的第二道墙）────────────
// 现场（2026-11-12）：同学那边**点任何一个开关都保存失败**，报错是
// 「保存被拒：slowMachineMode 的值不合法」。锅不在那个开关 ——
// 弹窗一次保存发的是**一整张补丁**（saveToggleConfig 把所有开关一起发），
// 而后台策略 libs/runtime-policy.js 里压根没登记 `slowMachineMode`，
// `validatePatch` 遇到没登记的键就整张拒 → 同批次的其它改动一起被吞，
// 用户看到的就是"设置全存不住"。
// ⚠️ 这里必须用**真鼠标**（Input.dispatchMouseEvent）：DOM 合成 click 不走命中测试，
//    「沙盒全绿、现场点不动」就是这么漏过去的（AGENTS §5 夹具自证）。
SCENARIOS.push({
  name: '弹窗点开关整张补丁要存进去（慢机开关不再连坐）',
  url: 'chrome-extension://{EXT}/popup/popup.html?ui=fancy',
  inject: false,
  run: async function (ctx) {
    var PROBE = '(function(){var el=document.getElementById("slowMachineMode");' +
      'if(!el) return {err:"no-el"};' +
      'var r=el.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2;' +
      'var hit=document.elementFromPoint(x,y);' +
      'return {x:x,y:y,w:r.width,on:el.classList.contains("on"),' +
      'aria:el.getAttribute("aria-checked"),hitSelf:hit===el,hitChild:!!hit&&el.contains(hit)};})()';
    await sleep(500);   // 等 load() 把存储里的状态读回界面，否则基线读的是出厂 HTML
    var s0 = await ctx.client.evaluate(PROBE);
    check('前提：兼容慢机开关可见、且中心点真实命中它自己（不是被别的元素挡住）',
      !!s0 && !s0.err && s0.w > 0 && (s0.hitSelf === true || s0.hitChild === true) &&
      (s0.aria === 'true' || s0.aria === 'false'), JSON.stringify(s0));

    var wasOn = s0.on === true;

    // 哨兵法（原来这条断的是「其它开关是 number / boolean」—— 那是**出厂默认**的形状，
    // 整张补丁被后台拒掉时它照样绿，等于什么都没守）。
    // 做法：先把存储里另一个键钉成 41，再只改**界面上**那个控件为 17（不派发 change，
    // 所以它自己不会触发保存），然后真鼠标点开关。弹窗发的是**一整张补丁**，
    // 存储要是没变成 17，就说明这张补丁整体被拒 —— 正是同学机器上那道墙的形状。
    var READ_REVIEW = 'new Promise(function(res){chrome.storage.local.get("config",function(r){' +
      'res(((r&&r.config)||{}).randomAnswerReviewSec);});})';
    await ctx.client.evaluate(
      'new Promise(function(res){chrome.storage.local.get("config",function(r){' +
      'var c=(r&&r.config)||{};c.randomAnswerReviewSec=41;' +
      'chrome.storage.local.set({config:c},function(){res(true);});});})');
    await ctx.client.evaluate(
      '(function(){var el=document.getElementById("randomAnswerReviewSec");' +
      'if(!el) return false; el.value="17"; return true;})()');
    var reviewDom = await ctx.client.evaluate(
      'String((document.getElementById("randomAnswerReviewSec")||{}).value)');
    var reviewBefore = await ctx.client.evaluate(READ_REVIEW);
    check('前提：哨兵只写在界面上（17），存储里还是钉进去的旧值（41）—— ' +
      '两边不同，才分得开「补丁落盘」与「本来就存过了」',
      reviewDom === '17' && reviewBefore === 41,
      'dom=' + JSON.stringify(reviewDom) + ' storage=' + JSON.stringify(reviewBefore));

    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s0.x, y: s0.y, button: 'left', buttons: 1, clickCount: 1 });
    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s0.x, y: s0.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(900);   // 保存是 await 的：失败会 rollback 界面并弹「保存被拒」

    var s1 = await ctx.client.evaluate(PROBE);
    var toast = await ctx.client.evaluate(
      'String((document.getElementById("toast")||{}).textContent||"")');
    var stored = await ctx.client.evaluate(
      'new Promise(function(res){chrome.storage.local.get("config",function(r){' +
      'var c=(r&&r.config)||{};res({slow:String(c.slowMachineMode),' +
      'reviewSec:c.randomAnswerReviewSec,rate:c.playbackRate,muted:c.muted});});})');
    check('点一下开关：界面翻过去且**没被回滚**（回滚就等于保存被拒）',
      !!s1 && s1.on === !wasOn && s1.aria === String(!wasOn),
      JSON.stringify({ wasOn: wasOn, now: s1 && s1.on, toast: toast.slice(0, 80) }));
    check('toast 说的是「已自动保存」，不是「保存被拒 / 值不合法」',
      /已自动保存/.test(toast) && !/被拒|无法保存|不合法/.test(toast), toast.slice(0, 120));
    check('存储里落的是那一族真值（on / auto，不是布尔）',
      !!stored && stored.slow === String(wasOn ? 'auto' : 'on'), JSON.stringify(stored));
    check('同一次保存里的**其它控件的值一起落盘**（哨兵 17 进了存储 = 整张补丁没被连坐拒掉）',
      !!stored && stored.reviewSec === 17, JSON.stringify(stored));

    var logHit = await ctx.client.evaluate(
      'new Promise(function(res){chrome.storage.local.get("runtimeLogs",function(r){' +
      'var a=(r&&r.runtimeLogs)||[],out=[];' +
      'for(var i=Math.max(0,a.length-40);i<a.length;i++){var m=String(a[i].message||"");' +
      'if(/slowMachineMode|值不合法|invalid_patch|保存被拒/.test(m))out.push(String(a[i].level)+"|"+m.slice(0,80));}' +
      'res(out.slice(0,4));});})');
    check('最近 40 条日志里没有「保存被拒 / 值不合法」那一条',
      Array.isArray(logHit) && logHit.length === 0, JSON.stringify(logHit));

    // 再点回去：OFF 方向写的是 'auto'（不是 'off'），两个方向都得存得住
    var s2 = await ctx.client.evaluate(PROBE);
    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s2.x, y: s2.y, button: 'left', buttons: 1, clickCount: 1 });
    await ctx.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s2.x, y: s2.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(900);
    var back = await ctx.client.evaluate(
      'new Promise(function(res){chrome.storage.local.get("config",function(r){' +
      'res(String(((r&&r.config)||{}).slowMachineMode));});})');
    var s3 = await ctx.client.evaluate(PROBE);
    check('关掉开关存回 "auto"（关掉=自适应，不是 "off"），且界面停在关的位置',
      back === 'auto' && !!s3 && s3.on === false, JSON.stringify({ stored: back, on: s3 && s3.on }));
  }
});

// ── 配置 handoff：存得住 ≠ 生效，值要真送到刷课页 ────────────────────────────
// check.js 的 C 只证明后台认这张补丁；页面那份 configs 装得下的**只是投影结果**，
// 没进 runtimeFields 的键页面读到的永远是它自己的默认值 —— 表现还是"打开了也没用"。
// 实测过两层都要挂：slowMachineMode 先是不被登记（全存不住），
// 修完登记又发现没投影（存得住也不生效），所以这条单独钉 handoff。
SCENARIOS.push({
  name: '慢机开关存进去要真投影到刷课页（存得住不等于生效）',
  path: '/blank',
  run: async function (ctx) {
    var readSlow = '(function(){var a=window._xxtApp;' +
      'return {slow:String(a.configs.slowMachineMode),' +
      'has:Object.prototype.hasOwnProperty.call(a.configs,"slowMachineMode")};})()';

    await writeConfig(ctx.extensionId, {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      slowMachineMode: 'auto', enableQuiz: false, autoNext: false
    });
    await sleep(800);   // storage.onChanged → content.js 重新投影 → 页面 mergeConfig
    var first = await ctx.client.evaluate(readSlow);
    await writeConfig(ctx.extensionId, {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      slowMachineMode: 'on', enableQuiz: false, autoNext: false
    });
    await sleep(800);
    var second = await ctx.client.evaluate(readSlow);
    check('开关值两次 handoff 都到页面（auto → on，不是只存在扩展里）',
      !!first && !!second && first.has === true && first.slow === 'auto' && second.slow === 'on',
      JSON.stringify({ first: first, second: second }));

    // 反面对照：带服务商原话的失败原因**故意不投影**（postMessage 页面脚本看得见），
    // 页面侧也不许再去读它 —— 以前那处 `|| this.configs.apiConnectionError` 是死的。
    // ⚠️ 写存储必须走扩展页（writeConfig 用的那个隐藏 popup）——
    //    刷课页的主世界里压根没有 `chrome`，直接 evaluate 会炸在 `chrome.storage` 上。
    await writeConfig(ctx.extensionId, {
      apiType: 'openai', apiUrl: 'http://127.0.0.1:' + PORT, apiKey: 'e2e-key', model: 'e2e-model',
      slowMachineMode: 'on', enableQuiz: false, autoNext: false,
      apiConnectionError: 'e2e-should-not-reach-page'
    });
    await sleep(800);
    var inPage = await ctx.client.evaluate(
      'Object.prototype.hasOwnProperty.call(window._xxtApp.configs,"apiConnectionError")');
    check('apiConnectionError 留在扩展侧，不投影给页面（页面读不到才不会被页面脚本读到）',
      inPage === false, JSON.stringify({ inPage: inPage }));
  }
});

/** ---- 54. 页面内验证码弹窗：刷不动要停手，而不是「3 发付费识别 → 刷新 → 再来 3 发」（批次 36-A / 36-C）
 * 批次 14-A 只修了**整页**验证码那面墙；弹窗形态这条路（`_handleCaptchaDialog`）一直还是
 * 「内存里数到 3 就 `location.reload()`」，而那一次刷新恰好把内存里的数清掉 ——
 * 于是模型看不懂图、或压根没配视觉模型时，这条链路是**每 3 发付费识别刷一次页、永远刷不完**。
 *
 * 同一轮还查出旁边一处更安静的：这些预算的读写全包在 `try { } catch { 当没账 }` 里，
 * 而这台浏览器存不住 sessionStorage（无痕 / 禁用本站 Cookie / 嵌套页的第三方存储限制）
 * 时抛的正是这个异常 —— 于是「安全阀没装」与「还没花过钱」在代码里同形。
 */
SCENARIOS.push({
  name: '页面内验证码弹窗刷不动会停手，不再无限刷',
  path: '/captcha-dialog',
  run: async function (ctx) {
    /**
     * ⚠️ 批次 37 复验时抓到的竞态（全量跑红、定向跑绿）：
     * page.js 一注入，夹具的 setup 还没落地，它自己的心跳就已经拿**真桥**去识别这个弹窗了 ——
     * 连错 3 次走 `_captchaReload()` → 真的 `location.reload()`，把整个 window 换掉。
     * 于是 setup 里 `window._xxtApp` 是 undefined，报出来的是
     * `Cannot set properties of undefined (setting '_captchaFailCount')`，
     * 看着像夹具坏了，其实是**页面在夹具之前自己刷了一次**。
     *
     * 所以「停车」必须做成**轮询**、而且排在最前面：`_xxtApp` 一出现就
     *   - park 住 `_captchaBusy`（`_handleCaptchaDialog` 第一行就 return，连识别都不发），
     *   - 停 tick、拆掉心跳 worker，
     *   - 把刷新换成计数桩（计数记 sessionStorage —— 它要活得过那一次刷新）。
     * `parks` / `prereloads` 两本账都记 sessionStorage：parks>1 说明中途真刷过一次，
     * prereloads>0 说明刷新发生在桩子落地之前。
     */
    var parkExpr = '(function(){' +
      'var a=window._xxtApp;if(!a)return false;' +
      'var PK="omitone:captcha-dialog-parks",PR="omitone:captcha-dialog-prereloads";' +
      'function bump(k){try{sessionStorage.setItem(k,String((Number(sessionStorage.getItem(k))||0)+1));}catch(e){}}' +
      'bump(PK);' +
      'try{a._clearTickLoop();}catch(e){}' +
      'try{if(a._bgWorker){a._bgWorker.postMessage({op:"stop"});a._bgWorker.terminate();a._bgWorker=null;}}catch(e){}' +
      'a._captchaBusy=true;' +
      // ⚠️ 停车要**连入口一起挡**：光把 `_captchaBusy` 置 true，护不住"已经在飞的那一发"，
      //   更护不住停车之后新起的一轮 —— 现场实测（2026-11-13 全量跑）就是这一族：
      //   定向跑快、全量跑慢，慢出来的那 1 发把 `prereloads` 顶成 1。
      //   所以这里把 `_checkCaptchaDialog` 包成「盲」的（`__pkBlind` 为真时返回 null），
      //   `_handleCaptchaDialog` / `_backgroundCaptchaTick` 找不到弹窗就一条请求都发不出去；
      //   它由 setup **同步**解开（同一个 evaluate 里先解盲再算 detect），不给宏任务留缝。
      'if(!window.__pkBlind){window.__pkBlind=true;' +
      '  var origCheck=a._checkCaptchaDialog;' +
      '  a._checkCaptchaDialog=function(){return window.__pkBlind?null:origCheck.call(a,arguments[0]);};}' +
      'if(!window.__pkOrig)window.__pkOrig=a._reloadCaptchaDialogPage;' +
      'a._reloadCaptchaDialogPage=function(){bump(PR);};' +
      'return true;})()';
    var parked = await waitFor(ctx.client, parkExpr, 10000);
    await new Promise(function (r) { setTimeout(r, 900); });

    await waitFor(ctx.client,
      '(function(){var i=document.getElementById("imgVerCode");return !!(i&&i.complete&&i.naturalWidth>0);})()', 8000);

    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      // 旧夹具在这里没有兜底：`_xxtApp` 一空，抛出来就是那句看不懂的
      // `Cannot set properties of undefined` —— 让它把话说清楚
            'if(!app)return JSON.stringify({missingApp:true});' +
      // ⚠️ 解盲之前先**自证盲真的罩住了**：`blindBefore` 必须是 0（停车期间 `_checkCaptchaDialog`
      //   被包成返回 null），`blindAfter` 必须是 1（解盲后同一个方法又认得出弹窗了 —— 弹窗就在那儿）。
      //   没有这两下，「停车」这个前置就是个只写不读的标志位：包失败了后面照样全绿。
      //   解盲与挂假桥在同一个同步块里完成，中间不会有宏任务插进来让停车又漏一发出去。
      'var blindBefore=(function(){try{return app._checkCaptchaDialog()?1:0;}catch(e){return -1;}})();' +
      'window.__pkBlind=false;' +
      // 解盲后这一次必须**绕过 `_checkCaptchaDialog` 自带的 1500ms 防抖**（它返回缓存的
      // `_captchaLastResult`，而停车期间那份缓存可能正好是 null —— 不清就会把"盲掉了"误报成"没盲掉"）。
      'app._captchaLastCheckAt=0;app._captchaLastResult=null;' +
      'var blindAfter=(function(){try{return app._checkCaptchaDialog()?1:0;}catch(e){return -1;}})();' +
      'try{app._clearTickLoop();}catch(e){}' +
      // ⚠️ 光停 tick loop 不够：page.js 启动时另开了一个 Web Worker 心跳（1500ms），
      //   页面隐藏时它直接调 `_backgroundCaptchaTick` → `_handleCaptchaDialog`，
      //   走的是**真桥**（此时假桥还没挂上），于是 `enableCaptcha` 一开着，
      //   在这段 setup 落地前就已经白烧 1~2 发，`_captchaFailCount` 带着脏值进来。
      //   定向跑快、全量跑慢 —— 差的就是这几发，「第 1 轮刷页」会被挪到第 2 步。
      'try{if(app._bgWorker){app._bgWorker.postMessage({op:"stop"});app._bgWorker.terminate();app._bgWorker=null;}}catch(e){}' +
      'app._captchaFailCount=0;app._captchaAttempts=0;' +
      'var KEY="omitone:captcha-dialog-budget";' +
      'var w={llm:0,fetch:0,reloads:0,got:[],replyFail:true};' +
      'window.__dlg=w;' +
      'window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")w.got.push(m);});' +
      // 付费的那一步换成假桥：识别失败=每一发都是白花钱；成功=能走「过了」那一条
      'w.on=function(e){var m=e.data;if(!m||m.source!=="xxt_app")return;' +
      '  if(m.type==="llm_captcha"){w.llm++;window.postMessage({source:"xxt_bridge",type:"llm_response",id:m.id,' +
      '    data:w.replyFail?{success:false,error:"测试里故意识别失败"}:{success:true,data:"QXKS"}},"*");}' +
      '  else if(m.type==="fetch_image"){w.fetch++;window.postMessage({source:"xxt_bridge",type:"llm_response",id:m.id,' +
      '    data:{success:false,error:"测试里不放行取图"}},"*");}};' +
      'window.addEventListener("message",w.on,true);' +
      'w.seed=function(rounds,pauseUntil){var a=window._xxtApp;' +
      'if(!a)throw new Error("夹具：这一步 page.js 不在这页上（这一页在夹具之前被真刷新过一次）");' +
      // 轮次边界：账本清零时，内存里的「本轮第几发」也必须一起清零，
      // 否则上一段剩的 1~2 发会把下一段的刷新时点整体前移（全量跑就是这么飘的）
      'a._captchaFailCount=0;a._captchaAttempts=0;' +
      'try{sessionStorage.setItem(KEY,JSON.stringify(' +
      '  {rounds:rounds,pauseUntil:pauseUntil,href:String(location.href||"")}));}catch(e){}};' +
      'w.read=function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}")||{};}catch(e){return {};}};' +
      'w.metas=function(name){return w.got.filter(function(m){return m.message===name;})' +
      '  .map(function(m){return m.meta||{};});};' +
      // 刷新单独桩掉：真刷一次整页会打断后面几步，而这个动作本身就是被测的东西
      'w.orig={reload:window.__pkOrig||app._reloadCaptchaDialogPage,open:app._captchaStillOpen};' +
      'app._reloadCaptchaDialogPage=function(){w.reloads++;};' +
      'w.step=function(fail,solve){var a=window._xxtApp;' +
      'if(!a)throw new Error("夹具：这一步 page.js 不在这页上（这一页在夹具之后又被真刷新过一次）");' +
      // ⚠️ 共享状态自己钉：整轮共用同一个 app，前一个场景写过 enableCaptcha:false 就会短路，
      //   表现是"一条请求都没发"，看着像夹具坏了
      '  a.configs=Object.assign({},a.configs,{enableCaptcha:true});' +
      '  a._captchaLastCheckAt=0;a._captchaLastResult=null;a._captchaBusy=false;' +
      '  w.replyFail=fail!=="ok";' +
      '  a._captchaStillOpen=solve==="gone"?function(){return false;}:w.orig.open;' +
      '  var c=a._checkCaptchaDialog();' +
      '  if(!c)return Promise.resolve("no-dialog");' +
      '  return a._handleCaptchaDialog(c).then(function(){return "done";});};' +
      'w.counts=function(){var a=window._xxtApp;return JSON.stringify({' +
      '  seen:w.got.length,llm:w.llm,fetch:w.fetch,reloads:w.reloads,budget:w.read(),' +
      '  active:!!a._captchaActive,fails:Number(a._captchaFailCount)||0,' +
      '  stop:w.metas("captcha dialog unsolved after 3 page reloads, stop spending"),' +
      '  pause:w.metas("captcha dialog paused, waiting for a human"),' +
      '  resume:w.metas("captcha dialog resume retry").length,' +
      '  reloadLog:w.metas("captcha unsolved, reload page").length});};' +
      'return JSON.stringify({ready:!!w.orig.reload&&!!app._readCaptchaDialogBudget&&!!app._readSessionLedger,' +
      '  blind:[blindBefore,blindAfter],' +
      '  detect:!!app._checkCaptchaDialog(),parked:!!window.__pkOrig,' +
      '  parks:(function(){try{return Number(sessionStorage.getItem("omitone:captcha-dialog-parks"))||0;}catch(e){return -1;}})(),' +
      '  prereloads:(function(){try{return Number(sessionStorage.getItem("omitone:captcha-dialog-prereloads"))||0;}catch(e){return -1;}})()});})()'
    );
    var setupObj = JSON.parse(setup);

    check('36-A 夹具前置：page.js 一注入就被停车（连识别入口一起盲掉），setup 落地时它还在、这一页也没被真刷新过' +
      '（旧写法在这里撞上 _xxtApp 为空，报出来是看不懂的 TypeError，看着像夹具坏了）；' +
      'prereloads 只当证据不当闸 —— 停车前那发已经在飞的识别救不掉，刷不了真页、也不影响后面每一步自己 seed',
      parked === true && setupObj.missingApp !== true && setupObj.parked === true &&
      Number(setupObj.parks) === 1 &&
      Array.isArray(setupObj.blind) && Number(setupObj.blind[0]) === 0 && Number(setupObj.blind[1]) === 1,
      JSON.stringify({ parked: parked, setup: setupObj }));

    async function failTimes(n) {
      for (var i = 0; i < n; i++) {
        await ctx.client.evaluate('(async function(){return await window.__dlg.step("fail");})()');
      }
      await new Promise(function (r) { setTimeout(r, 350); });
      return JSON.parse(await ctx.client.evaluate('window.__dlg.counts()'));
    }

    await ctx.client.evaluate('(function(){window.__dlg.seed(0,0);return "ok";})()');
    var r1 = await failTimes(3);
    var r2 = await failTimes(3);
    var r3 = await failTimes(3);
    var r4 = await failTimes(3);
    // 冷却到点：再给一轮机会（停手不是永久放弃）
    await ctx.client.evaluate('(function(){window.__dlg.seed(3,Date.now()-1000);return "ok";})()');
    var before5 = JSON.parse(await ctx.client.evaluate('window.__dlg.counts()'));
    await ctx.client.evaluate('(async function(){return await window.__dlg.step("fail");})()');
    await new Promise(function (r) { setTimeout(r, 350); });
    var r5 = JSON.parse(await ctx.client.evaluate('window.__dlg.counts()'));

    check('36-A 夹具自证：弹窗真的抓得到、假桥真的收到识别请求、刷新的桩也真的挂上了' +
      '（否则下面几条是空测）',
      setupObj.ready === true && setupObj.detect === true && r1.llm === 3 && r1.fetch === 0 &&
      r1.reloads === 1 && r1.seen > 0,
      JSON.stringify({ setup: setupObj, r1: { llm: r1.llm, fetch: r1.fetch, reloads: r1.reloads, seen: r1.seen } }));

    check('36-A：第 1 轮 3 次识别失败刷一次页，且**这一轮记在账上**（旧写法刷了但没记，一刷全归零）',
      r1.budget && Number(r1.budget.rounds) === 1 && r1.reloads === 1 && r1.fails === 0,
      JSON.stringify({ budget: r1.budget, reloads: r1.reloads, fails: r1.fails }));

    check('36-A：第 2 轮同样只刷一次，账上累计 2 轮',
      Number(r2.budget && r2.budget.rounds) === 2 && r2.reloads === 2 && r2.llm === 6,
      JSON.stringify({ budget: r2.budget, reloads: r2.reloads, llm: r2.llm }));

    check('36-A：第 3 轮到顶就**不再刷新**，落一个暂停时间，并说清下一步怎么办（亲手输一次 + 换会看图的模型）',
      r3.reloads === 2 && Number(r3.budget && r3.budget.pauseUntil) > Date.now() - 60000 &&
      r3.stop.length === 1 && /亲手/.test(String((r3.stop[0] || {}).hint || '')) &&
      /验证码识别模型|看图/.test(String((r3.stop[0] || {}).hint || '')),
      JSON.stringify({ reloads: r3.reloads, budget: r3.budget, stop: r3.stop[0] }));

    check('36-A：停手期间一条付费请求都不发、也不刷页（旧写法这里是**无限**的）',
      r4.llm === r3.llm && r4.fetch === r3.fetch && r4.reloads === r3.reloads &&
      r4.pause.length === 1 && r4.active === false,
      JSON.stringify({ dLlm: r4.llm - r3.llm, dFetch: r4.fetch - r3.fetch, dReloads: r4.reloads - r3.reloads,
        pause: r4.pause.length, active: r4.active }));

    check('36-A：那条停手提醒只发一次（每 250ms 一轮的 tick 不许把日志淹掉）',
      r4.pause.length === 1 && Number(r4.pause[0] && r4.pause[0].resumeInMs) > 0,
      JSON.stringify({ pause: r4.pause }));

    check('36-A：冷却到点确实再给一轮（请求重新开始发、旧账同时清零）',
      r5.llm === before5.llm + 1 && r5.resume === 1 && Number(r5.budget && r5.budget.rounds) === 0,
      JSON.stringify({ before: before5.llm, after: r5.llm, resume: r5.resume, budget: r5.budget }));

    // ---- 过了 / 弹窗自己消失了，账都要清零（不许把上一面墙的账带到下一面墙）----
    // ⚠️ `emitRuntimeLog` 走 postMessage，**异步送达**：动作和读日志必须分两次 evaluate，
    // 中间等一拍。写在同一次里读到的是空数组，看着像"该发的没发"。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,w=window.__dlg;' +
      'if(!app)throw new Error("夹具：这一段跑的时候 page.js 不在这页上（这一页被真刷新过一次）");' +
      'w.seed(2,0);w.replyFail=false;' +
      'app.configs=Object.assign({},app.configs,{enableCaptcha:true});' +
      'app._captchaLastCheckAt=0;app._captchaLastResult=null;app._captchaBusy=false;' +
      'app._captchaStillOpen=function(){return false;};' +
      'var c=app._checkCaptchaDialog();' +
      'window.__dlgSolved=c?1:0;' +
      'if(c){app._handleCaptchaDialog(c);}return "ok";})()'
    );
    await new Promise(function (r) { setTimeout(r, 6000); });
    var solved = JSON.parse(await ctx.client.evaluate(
      '(function(){var w=window.__dlg;return JSON.stringify({budget:w.read(),' +
      'detected:window.__dlgSolved,solvedCount:w.metas("captcha solved, continue").length,' +
      'reloads:w.reloads});})()'
    ));
    check('36-A：真过了就把刷新轮次清零（停手这笔账不许带进下一面墙）',
      solved.detected === 1 && Number(solved.budget && solved.budget.rounds) === 0 &&
      !Number(solved.budget && solved.budget.pauseUntil) && solved.solvedCount >= 1,
      JSON.stringify(solved));

    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,w=window.__dlg;var box=document.querySelector(".layui-layer");' +
      'window.__heal={hadBox:!!box};if(!box)return "none";' +
      // ① 弹窗真的不在了、而且已经离开 60 秒以上 —— 条件愈合，账要清零
      'box.style.display="none";app._captchaLastCheckAt=0;app._captchaLastResult=null;' +
      'w.seed(2,Date.now()+30*60000);app._captchaDialogAbsentAt=Date.now()-61000;' +
      'app._checkCaptchaDialog();' +
      'window.__heal.after={budget:w.read(),pauseLogged:!!app._captchaDialogPauseLogged};' +
      // ② 反向对照：只离开 11 秒不清账（检测抖一下就清账等于把安全阀拆了）
      'w.seed(2,Date.now()+30*60000);app._captchaDialogAbsentAt=Date.now()-11000;' +
      'app._captchaLastCheckAt=0;app._captchaLastResult=null;app._checkCaptchaDialog();' +
      'window.__heal.short={rounds:Number(w.read().rounds)||0};' +
      'box.style.display="";app._captchaDialogAbsentAt=0;return "ok";})()'
    );
    await new Promise(function (r) { setTimeout(r, 400); });
    var heal = JSON.parse(await ctx.client.evaluate(
      '(function(){var h=window.__heal;h.gone=window.__dlg.metas("captcha dialog gone, retry budget reset").length;' +
      'return JSON.stringify(h);})()'
    ));
    check('36-A：弹窗被人手动关掉（连续 60 秒不再检测到）就把账清零，连停手提醒的开关一起复位',
      heal.hadBox === true && heal.after && Number(heal.after.budget.rounds) === 0 &&
      !Number(heal.after.budget.pauseUntil) && heal.gone === 1 && heal.after.pauseLogged === false,
      JSON.stringify({ after: heal.after, gone: heal.gone }));
    check('36-A 反向对照：只漏看 11 秒不清账（检测抖动不许把安全阀拆了）',
      heal.short && heal.short.rounds === 2 && heal.gone === 1, JSON.stringify(heal.short));

    // ---- 36-C：这台浏览器存不住 sessionStorage 时，账退回内存 + 只提醒一次 ----
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,w=window.__dlg;' +
      'if(!app)throw new Error("夹具：这一段跑的时候 page.js 不在这页上（这一页被真刷新过一次）");' +
      'window.__noStore={};' +
      'window.__noStore.realSet=Object.getOwnPropertyDescriptor(sessionStorage,"setItem");' +
      'app._ledgerSessionOk=null;app._ledgerMemory=null;' +
      'var patched=false;' +
      'try{Object.defineProperty(sessionStorage,"setItem",{configurable:true,writable:true,value:function(){' +
      '  throw new Error("测试里这台浏览器存不住会话数据");}});patched=true;}catch(e){}' +
      'window.__noStore.patched=patched;' +
      'if(!patched)return "no-patch";' +
      'app._writeCaptchaDialogBudget(1,0,String(location.href));' +
      'window.__noStore.back1=app._readCaptchaDialogBudget();' +
      'app._writeCaptchaDialogBudget(2,Date.now()+60000,String(location.href));' +
      'window.__noStore.back2=app._readCaptchaDialogBudget();' +
      'var m=window.__noStore.realSet;' +
      'if(m){Object.defineProperty(sessionStorage,"setItem",m);}' +
      'app._ledgerSessionOk=null;app._ledgerMemory=null;w.seed(0,0);return "ok";})()'
    );
    await new Promise(function (r) { setTimeout(r, 400); });
    var noStore = JSON.parse(await ctx.client.evaluate(
      '(function(){var n=window.__noStore;' +
      'var warn=n.patched?window.__dlg.metas("session storage unavailable, retry budgets reset on every reload"):[];' +
      'n.warn=warn.length;n.hint=String((warn[0]||{}).hint||"").slice(0,40);return JSON.stringify(n);})()'
    ));
    check('36-C：sessionStorage 抛异常时账**不是**当成没账 —— 退回本页内存，安全阀仍然挡住同一份文档里的死循环',
      noStore.patched === true && Number(noStore.back1 && noStore.back1.rounds) === 1 &&
      Number(noStore.back2 && noStore.back2.rounds) === 2 && Number(noStore.back2 && noStore.back2.pauseUntil) > 0,
      JSON.stringify(noStore));
    check('36-C：这台浏览器存不住会话数据要**说一次**（只一条，别刷屏），并给出可执行的出路',
      noStore.warn === 1 && /无痕|禁用了本站|存储/.test(String(noStore.hint || '')),
      JSON.stringify({ warn: noStore.warn, hint: noStore.hint }));

    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp,w=window.__dlg;' +
      'if(!app)throw new Error("夹具：这一段跑的时候 page.js 不在这页上（这一页被真刷新过一次）");' +
      'try{window.removeEventListener("message",w.on,true);}catch(e){}' +
      'app._reloadCaptchaDialogPage=w.orig.reload;app._captchaStillOpen=w.orig.open;' +
      'app._captchaDialogAbsentAt=0;app._captchaDialogPauseLogged=false;' +
      'try{sessionStorage.removeItem("omitone:captcha-dialog-budget");}catch(e){}' +
      'return "cleaned";})()'
    );
  }
});

/** ---- 55. 每章看图预算：刷新不会重新发满（批次 36-B）
 * `_takeVisionBudget` 自己的注释写着「无论配置写错、页面版式异常、还是某道题反复触发，
 * 都不可能无限发请求」。可它记在页面内存里，而刷课链路里跳章 / 验证码墙 / 跨域中间页
 * 那几步是**自己刷新自己** —— 一刷就归零，"每章 N 次"实际是"每刷一次再来 N 次"。
 */
SCENARIOS.push({
  name: '每章看图预算刷新后不会重新发满',
  path: '/blank',
  run: async function (ctx) {
    // ⚠️ `emitRuntimeLog` 是 postMessage 异步送达，所以「花了没」与「日志几条」
    // 分两次 evaluate 读：写在同一次里读到的日志恒空，会把"该响的没响"读成"没响"。
    var g = JSON.parse(await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'window.__vSeen=[];' +
      'var on=function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log"&&/vision budget/.test(String(m.message||"")))' +
      '    window.__vSeen.push(m);};' +
      'window.addEventListener("message",on);' +
      'var KEY="omitone:vision-budget",out={};' +
      // 上一场景可能在这同一个标签页里留过账（sessionStorage 跨导航还在）—— 自己钉死起点
      'try{sessionStorage.removeItem(KEY);}catch(e){}' +
      'window.removeEventListener("message",on);window.__vSeen=[];window.addEventListener("message",on);' +
      // 这里原来还读了一次「起点账本是不是空」—— 上面刚 removeItem，它恒真，删了；
      // 读写是否真的通，由下面那条 used=2 负责（写不上去就读不到 2）。
      // 这一路的入口配置由场景自己钉死，别依赖上一个场景留下的状态
      'app.configs=Object.assign({},app.configs,{visionEnabled:true,visionBudgetPerChapter:2});' +
      'out.g1=app._takeVisionBudget("ch-36a");' +
      'out.g2=app._takeVisionBudget("ch-36a");' +
      // 账落在 sessionStorage 才算数：这一条就是"刷新之后还剩什么"
      'out.rawUsed=(function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}").used;}catch(e){return -1;}})();' +
      'out.g3=app._takeVisionBudget("ch-36a");' +
      // 内存里"提醒过没有"那个键抹掉（等价于页面刚刷新完）：额度仍然不许放行
      'app._visionBudgetWarnedKey="";' +
      'out.g4=app._takeVisionBudget("ch-36a");' +
      'out.otherChapter=app._takeVisionBudget("ch-36b");' +
      'out.rawChapter=(function(){try{return JSON.parse(sessionStorage.getItem(KEY)||"{}").chapter;}catch(e){return "";}})();' +
      // 额度写成 0：一进门就该停，而不是先把图抓完再发现没预算
      'app.configs=Object.assign({},app.configs,{visionBudgetPerChapter:0});' +
      'out.zero=app._takeVisionBudget("ch-36c");' +
      'app.configs=Object.assign({},app.configs,{visionEnabled:false});' +
      'out.disabled=app._takeVisionBudget("ch-36d");' +
      'try{sessionStorage.removeItem(KEY);}catch(e){}' +
      'return JSON.stringify(out);})()'
    ));
    await new Promise(function (r) { setTimeout(r, 400); });
    var warn = JSON.parse(await ctx.client.evaluate(
      '(function(){var s=window.__vSeen||[];' +
      'return JSON.stringify({total:s.length,' +
      '  used:s.map(function(m){return (m.meta||{}).used;}),' +
      '  chapters:s.map(function(m){return (m.meta||{}).chapter;})});})()'
    ));

    check('36-B 夹具自证：这一页真的读得到也写得上 sessionStorage（读不到就是这台浏览器存不住，' +
      '那要按 36-C 那条路看，不是夹具坏了）—— 账本里能读到 used=2 就是读写都通的证据',
      Number(g.rawUsed) === 2, JSON.stringify({ rawUsed: g.rawUsed }));
    check('36-B：每章 2 次就是 2 次 —— 第 3 次拒绝并写 warn（旧写法在这里已经被刷新归零）',
      g.g1 === true && g.g2 === true && g.g3 === false, JSON.stringify(g));
    check('36-B：耗尽那条日志带 used 与章号，且判据只看账本 —— 把内存里"提醒过没有"的键抹掉' +
      '（等价于刷新过一次）也不放行',
      warn.used[0] === 2 && warn.chapters[0] === 'ch-36a' && g.g4 === false &&
      warn.chapters[1] === 'ch-36a',
      JSON.stringify({ warn: warn, g4: g.g4 }));
    check('36-B：换章即重置的语义仍在（新章第一次照样放行，账本跟着换成新章）',
      g.otherChapter === true && g.rawChapter === 'ch-36b',
      JSON.stringify({ otherChapter: g.otherChapter, rawChapter: g.rawChapter }));
    check('36-B：额度 0 与关了看图都要当场停手（0 额度仍要写一条 warn，不能静默）',
      g.zero === false && g.disabled === false && warn.total === 3 && warn.chapters[2] === 'ch-36c',
      JSON.stringify({ zero: g.zero, disabled: g.disabled, chapters: warn.chapters }));
  }
});

/** ---- 42. 批次 37：视频等待日志把整份证据窗挤空 ----
 *
 * 为什么要这一条（2026-11-13，用户一句「现场我就一直挂着了，遇到问题你就去看看」当场撞上的）：
 *   刷课几分钟后再去读日志，**读到的只剩视频心跳** —— SW 那份 runtimeLogs 是 200 条环形，
 *   实测里面 **196 条**是同一句「media pending, delay completion」（每秒两条），
 *   整个窗口只装得下约 100 秒。
 *   也就是说「等一会儿再去看这一节为什么跳过」这件事**结构上做不到**：
 *   出事那一刻的证据在用户开口之前就已经被挤没了。
 *   根因不在「30 秒一条」这道闸（它是批次 22 为同一件事加的），在**签名怎么算**：
 *   `mediaSig` 把 `reason` 拼了进去，而 reason 是**调用方标识**
 *   （'completion-check' 来自完成判定、'ocs-runner-active-job' 来自 OCS 循环），
 *   同一个视频每秒被这两个调用方一先一后地问 → 签名每秒翻一次 →
 *   `mediaSig !== this._mediaWaitLogSig` 恒真 → 那道 30 秒闸被自己的签名完全绕过。
 *   旧注释里写的本意（「200 条环十几分钟就被刷满」）恰恰是被它自己破掉的那件事。
 *
 * 夹具要点：reason 必须**交替**喂两个值 —— 只喂一个的话旧写法也只出一条，
 * 这条断言就变成空测（AGENTS §5「夹具要长得像现场」）。
 */
SCENARIOS.push({
  name: '视频播放中的等待日志不许把证据窗挤空',
  path: '/media',
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
      '  HTMLMediaElement.prototype.play = function(){ this.__played = (this.__played||0)+1; return Promise.resolve(); };',
      '  HTMLMediaElement.prototype.load = function(){};',
      '  window.__b37Patched = true;',
      '})()'
    ].join('\n');
  },
  run: async function (ctx) {
    var patched = await ctx.client.evaluate('window.__b37Patched === true');
    check('37 夹具自证：媒体元素原型打桩生效（不依赖真实编解码器）', patched === true, String(patched));

    function countMediaLogs() {
      return ctx.client.evaluate(
        '(function(){var n=0;(window.__b37i||[]).forEach(function(m){' +
        'if(String(m.message||"").indexOf("media pending, delay completion")===0)n++;});' +
        'window.__b37i=[];return n;})()');
    }

    // 阶段一：两个调用方标识**交替**喂 8 次，播放状态一直是 playing
    var phase1 = await ctx.client.evaluate(
      '(function(){' +
      'var app=window._xxtApp;' +
      'window.__b37i=[];' +
      'if(!window.__b37Bound){window.__b37Bound=true;window.addEventListener("message",function(e){' +
      '  var m=e.data;if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b37i.push(m);});}' +
      'var v=document.getElementById("omitone-video");' +
      'if(!v) return {noVideo:true};' +
      'app._videoEl=v; app._activeMediaJobPending=true; app._isPlaying=true;' +
      'app._mediaWaitLogAt=0; app._mediaWaitLogSig="";' +
      'var seq=[];' +
      'for(var i=0;i<8;i++) seq.push(i%2?"ocs-runner-active-job":"completion-check");' +
      'var pending=seq.map(function(r){ try { return app._isActiveMediaPending(r)===true; } catch(e){ return "ERR "+e.message; } });' +
      'return {noVideo:false,pending:pending,sig:String(app._mediaWaitLogSig)};' +
      '})()'
    );
    // 日志走 postMessage，异步送达 —— 不等一拍就读，"没发"和"没等到"长得一模一样
    await sleep(400);
    var after1 = await ctx.client.evaluate(
      '(function(){var out={count:0,first:null};' +
      '(window.__b37i||[]).forEach(function(m){' +
      '  if(String(m.message||"").indexOf("media pending, delay completion")===0){' +
      '    out.count++; if(!out.first) out.first=m; }});' +
      'window.__b37i=[]; return out;})()'
    );
    check('37-A 夹具自证：8 次交替调用**每次都真的走进等待分支**（返回 true；' +
      '否则"只出一条"很可能是压根没走到那一步的空测）',
      !!phase1 && phase1.noVideo === false && Array.isArray(phase1.pending) &&
      phase1.pending.length === 8 && phase1.pending.every(function (p) { return p === true; }),
      JSON.stringify(phase1 && phase1.pending));
    check('37-A：两个调用方交替问同一个视频，8 次只出 **1 条**' +
      '（旧写法这里是 8 条：reason 进了签名 → 签名每秒翻 → 30 秒闸被自己绕过 → ' +
      '现场 200 条环里 196 条是这一句，证据窗只剩约 100 秒）',
      !!after1 && after1.count === 1, JSON.stringify(after1 && after1.count));
    check('37-A：签名里**不许有调用方标识**（reason 一进去，两个调用方交替就能把 30 秒闸绕开）' +
      '—— 断"不含 reason"，不钉它具体拼成什么字（拼法是实现细节，改写法不该让这条变红）',
      !!phase1 && phase1.sig.length > 0 &&
      phase1.sig.indexOf('completion-check') === -1 && phase1.sig.indexOf('ocs-runner') === -1,
      JSON.stringify(phase1 && phase1.sig));
    check('37-A：留下的那一条仍带得出证据（reason / currentTime / duration 一个不许少）',
      !!after1 && !!after1.first && !!after1.first.meta &&
      /^(completion-check|ocs-runner-active-job)$/.test(String(after1.first.meta.reason)) &&
      after1.first.meta.duration === 100 && typeof after1.first.meta.currentTime === 'number',
      JSON.stringify(after1 && after1.first));

    // 阶段二：心跳那一维不能丢 —— 31 秒前发过，现在还得再出一条
    var phase2 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._mediaWaitLogAt=Date.now()-31000;' +
      'var pending=app._isActiveMediaPending("completion-check")===true;' +
      'pending=app._isActiveMediaPending("ocs-runner-active-job")===true&&pending;' +
      'return {pending:pending};})()'
    );
    await sleep(400);
    var after2 = await countMediaLogs();
    check('37-A：30 秒心跳本身留着（隔 31 秒再问，两个调用方交替也只补一条 —— ' +
      '"看得出 currentTime 在走"的那只手不能砍）',
      !!phase2 && phase2.pending === true && after2 === 1,
      JSON.stringify({ phase2: phase2, count: after2 }));

    // 阶段三：播放状态**真**变了要立刻说（这才是签名该保留的那一维）
    var phase3 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=app._videoEl;' +
      'app._mediaWaitLogAt=Date.now()-6000;' +
      'Object.defineProperty(v,"paused",{configurable:true,get:function(){return true;}});' +
      'var first=app._isActiveMediaPending("completion-check")===true;' +
      'return {first:first,sig:String(app._mediaWaitLogSig)};})()'
    );
    await sleep(400);
    var after3 = await countMediaLogs();
    check('37-A：暂停↔播放这种**真状态变化**不等 30 秒就出（这里离上一条只过了 6 秒），' +
      '且签名确实跟着状态变了（只断"与播放时不同"，不钉字面）',
      !!phase3 && phase3.first === true && phase3.sig !== phase1.sig && after3 === 1,
      JSON.stringify({ phase3: phase3, playingSig: phase1 && phase1.sig, count: after3 }));

    // 阶段四：状态来回抖（播放器自己抖 paused/playing）不许把闸再冲开
    var phase4 = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=app._videoEl;' +
      'app._mediaWaitLogAt=Date.now()-1000;' +
      'function setPaused(p){Object.defineProperty(v,"paused",{configurable:true,get:function(){return p;}});}' +
      'for(var i=0;i<6;i++){ setPaused(i%2===0); app._isActiveMediaPending(i%2?"ocs-runner-active-job":"completion-check"); }' +
      'return {stillPending:app._activeMediaJobPending===true,waitLogAt:app._mediaWaitLogAt};})()'
    );
    await sleep(400);
    var after4 = await countMediaLogs();
    check('37-A：状态 1 秒内来回抖 6 次**一条都不出**（5 秒下限；' +
      '没有这道下限，"真状态变化立刻出"会变成新的刷屏源）',
      !!phase4 && phase4.stillPending === true && after4 === 0,
      JSON.stringify({ phase4: phase4, count: after4 }));

    // 阶段五：**收摊/换视频之后**，下一段等待必须立刻重新开口（批次 36 家族的"跨复位不静默"）
    //   签名这道闸只在「同一段等待里」有意义。`_clearMediaPendingState()`（换任务点、
    //   完成判定放行、守卫收摊都走它）把 `_mediaWaitLogAt` 归零，于是新的一段即使
    //   播放状态**一模一样**也要出第一条 —— 否则就是"换了个视频，日志却继续沉默 30 秒"，
    //   用户看到的又是一个什么都不说的插件。
    //   ⚠️ 这一段特意让两次的签名相同（都按 playing 播）：不同签名会走"状态变了"那一支，
    //   那样测不到复位（测了也是白测）。
    var phase5a = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'if(!v) return {noVideo:true};' +
      'Object.defineProperty(v,"paused",{configurable:true,get:function(){return false;}});' +
      'app._videoEl=v; app._activeMediaJobPending=true; app._isPlaying=true;' +
      'app._mediaWaitLogAt=0; app._mediaWaitLogSig="";' +
      'var p=app._isActiveMediaPending("completion-check")===true;' +
      'return {pending:p,sig:String(app._mediaWaitLogSig)};})()'
    );
    await sleep(400);
    var after5a = await countMediaLogs();
    var phase5b = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'if(!v) return {noVideo:true};' +
      // ① 收摊：这一段等待结束（内部把 _mediaWaitLogAt 归零、状态全清）
      'app._clearMediaPendingState("e2e-phase5");' +
      'var cleared={at:app._mediaWaitLogAt,pending:app._activeMediaJobPending};' +
      // ② 马上开下一段：播放状态与上一段**完全同形**（都是 playing）
      'app._videoEl=v; app._activeMediaJobPending=true; app._isPlaying=true;' +
      'var p=app._isActiveMediaPending("completion-check")===true;' +
      'return {cleared:cleared,pending:p,sig:String(app._mediaWaitLogSig)};})()'
    );
    await sleep(400);
    var after5b = await countMediaLogs();
    check('37-A 阶段五前提：收摊前那一段确实出过一条（否则后面"又出了一条"没有对照）',
      !!phase5a && phase5a.pending === true && after5a === 1,
      JSON.stringify({ phase5a: phase5a, count: after5a }));
    check('37-A：换一段等待（收摊后重新开播）**即使播放状态一模一样也立刻出一条**' +
      '—— 靠的是复位把 at 归零；签名相同还不说话，就是"插件又变成哑巴 30 秒"',
      !!phase5b && phase5b.cleared && phase5b.cleared.at === 0 &&
      phase5b.pending === true && phase5b.sig === phase5a.sig && after5b === 1,
      JSON.stringify({ phase5b: phase5b, count: after5b, sigA: phase5a && phase5a.sig }));
  }
});

/** ---- 55. 视频「从来没有过源」不再把整节永远占住（批次 40）
 * 现场（2026-11-13，用户挂着刷课，CDP 9334）：某一节拿到的是
 * `<video id="video_html5_api" class="vjs-tech">`，`readyState 0 / networkState 3`（NETWORK_NO_SOURCE）
 * `/ duration null / currentTime 0 / ended false`，源地址在 `src` 上但播放器一次都没挂上 ——
 * `media.ended` 永远是 false，`_isActiveMediaPending` 因此恒真，整节停摆 **12 分钟**，
 * 一条答题都没发出去，日志里 guard 时间戳每秒刷新（= 一直在重试，但永不放手）。
 *
 * 修法口径：**有界**放手。窗口对齐 `documentSkipTimeoutMs`（和 62-tasks-run.js 等文档资源同一把尺），
 * 到点清 pending 并落一条 warn（AGENTS §2.7：跳过用户的任务点必须可见、可恢复）；
 * 源一旦真的挂上，计数立刻清零 —— 正常慢首帧不受影响。
 *
 * 夹具要点（AGENTS §5「夹具要长得像现场」）：形状必须自己钉住 `readyState 0 + duration 拿不到 +
 * networkState 3 + ended false` 这四样，并且**自证走到了新分支**（不是 `!media` 那一支、也不是 `ended` 那一支），
 * 否则「放手了」和「压根没占住」同形。
 */
SCENARIOS.push({
  name: '视频一直没有源时不再永远占住这一节',
  path: '/media',
  beforeInject: function () {
    return [
      '(function(){',
      // 四把可调的"形状旋钮"默认就是现场那副死样子；阶段四把它们翻成"源挂上了"。
      '  Object.defineProperty(HTMLMediaElement.prototype, "readyState",',
      '    { configurable: true, get: function(){ return window.__b40Ready == null ? 0 : window.__b40Ready; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "duration",',
      '    { configurable: true, get: function(){ return window.__b40Dur == null ? NaN : window.__b40Dur; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "networkState",',
      '    { configurable: true, get: function(){ return window.__b40Net == null ? 3 : window.__b40Net; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get: function(){ return 0; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: function(){ return false; } });',
      '  Object.defineProperty(HTMLMediaElement.prototype, "ended", { configurable: true, get: function(){ return false; } });',
      '  HTMLMediaElement.prototype.play = function(){ this.__played = (this.__played||0)+1; return Promise.resolve(); };',
      '  HTMLMediaElement.prototype.load = function(){};',
      '  window.__b40Patched = true;',
      '})()'
    ].join('\n');
  },
  run: async function (ctx) {
    var patched = await ctx.client.evaluate('window.__b40Patched === true');
    check('40 夹具自证：媒体原型打桩生效，且形状就是现场那副死样子' +
      '（readyState 0 / networkState 3 / 拿不到 duration / ended false —— 少一样，下面的"放手"就是空测）',
      patched === true, String(patched));

    var shape = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var v=document.getElementById("omitone-video");' +
      'window.__b40i=[];' +
      'if(!window.__b40Bound){window.__b40Bound=true;window.addEventListener("message",function(e){' +
      '  var m=e.data;if(m&&m.source==="xxt_app"&&m.type==="runtime_log")window.__b40i.push(m);});}' +
      'var found=null;try{found=app._getVideoEl();}catch(e){found=null;}' +
      'function num(x){try{return Number(x);}catch(e){return -1;}}' +
      'return {hasEl:!!v,found:!!found,' +
      '  ready:found?num(found.readyState):-1,net:found?num(found.networkState):-1,' +
      '  durOk:found?(num(found.duration)>0):true,ended:found?!!found.ended:null};})()'
    );
    check('40 夹具自证：这一节的视频元素真的抓得到，而且四把旋钮在页面上读出来就是死的' +
      '（打桩生效 ≠ 判据读得到；这条钉的是后者）',
      !!shape && shape.hasEl === true && shape.found === true && shape.ready === 0 &&
      shape.net === 3 && shape.durOk === false && shape.ended === false,
      JSON.stringify(shape));

    var arm = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'app.configs=Object.assign({},app.configs,{documentSkipTimeoutMs:1000});' +
      'app._videoEl=v;app._activeMediaJobPending=true;app._isPlaying=true;' +
      'app._mediaNoSourceSince=0;app._mediaWaitLogAt=0;window.__b40i=[];' +
      'var p1=app._isActiveMediaPending("completion-check")===true;' +
      'var armed=Number(app._mediaNoSourceSince)||0;' +
      'var p2=app._isActiveMediaPending("ocs-runner-active-job")===true;' +
      'return {p1:p1,p2:p2,armed:armed,armedFresh:armed>0&&(Date.now()-armed)<5000,' +
      '  stillPending:!!app._activeMediaJobPending,holds:app._videoEl===v};})()'
    );
    await sleep(400);
    var earlyLogs = await ctx.client.evaluate(
      '(function(){var n=0;(window.__b40i||[]).forEach(function(m){' +
      'if(String(m.message||"").indexOf("media has no source")===0)n++;});' +
      'window.__b40i=[];return n;})()');
    check('40-A：窗口没到就**仍然占住**（首帧慢的视频不能被当成死源扔掉）—— ' +
      '第 1 次调用把计时武装起来，第 2 次还在窗口内，两条都返回 true、一条放手日志都不许有',
      !!arm && arm.p1 === true && arm.p2 === true && arm.armedFresh === true &&
      arm.stillPending === true && arm.holds === true && earlyLogs === 0,
      JSON.stringify({ arm: arm, earlyLogs: earlyLogs }));

    var release = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'app._videoEl=v;app._activeMediaJobPending=true;app._isPlaying=true;' +
      'app._mediaNoSourceSince=Date.now()-1500;window.__b40i=[];' +
      'var p=app._isActiveMediaPending("completion-check");' +
      'return {p:p,pending:!!app._activeMediaJobPending,playing:!!app._isPlaying,' +
      '  el:!!app._videoEl,counter:Number(app._mediaNoSourceSince)||0};})()'
    );
    await sleep(400);
    var relLog = await ctx.client.evaluate(
      '(function(){var out={n:0,first:null,levels:{}};' +
      '(window.__b40i||[]).forEach(function(m){' +
      '  if(String(m.message||"").indexOf("media has no source")===0){' +
      '    out.n++;out.levels[m.level]=(out.levels[m.level]||0)+1;if(!out.first)out.first=m;}});' +
      'window.__b40i=[];return out;})()');
    check('40-A：超过窗口就**有界放手**（返回 false、pending / 播放标志 / 抓着的元素全部复位，' +
      '计时清零好让下一轮重新计 —— 不清就等于这一节此后永远不再试）',
      !!release && release.p === false && release.pending === false &&
      release.playing === false && release.el === false && release.counter === 0,
      JSON.stringify(release));
    check('40-A：放手必须留话（warn 一条，带 readyState / networkState / heldMs / src 和 reason）—— ' +
      '静默跳过用户的任务点是这个项目不许的事，而且"视频没播成"和"这节压根没视频"得分得开',
      !!relLog && relLog.n === 1 && relLog.levels && relLog.levels.warn === 1 &&
      !!relLog.first && !!relLog.first.meta &&
      Number(relLog.first.meta.readyState) === 0 && Number(relLog.first.meta.networkState) === 3 &&
      Number(relLog.first.meta.heldMs) >= 1500 && typeof relLog.first.meta.src === 'string' &&
      String(relLog.first.meta.reason) === 'completion-check',
      JSON.stringify(relLog && relLog.first));

    var recover = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var v=document.getElementById("omitone-video");' +
      'window.__b40Ready=4;window.__b40Dur=100;window.__b40Net=1;' +
      'app._videoEl=v;app._activeMediaJobPending=true;app._isPlaying=true;' +
      'app._mediaNoSourceSince=Date.now()-99999;' +
      'var p=app._isActiveMediaPending("completion-check")===true;' +
      'var counter=Number(app._mediaNoSourceSince)||0;' +
      'window.__b40Ready=0;window.__b40Dur=NaN;window.__b40Net=3;' +
      'return {p:p,counter:counter,pending:!!app._activeMediaJobPending};})()'
    );
    check('40-A 可恢复：源真的挂上了（readyState 4 + 拿到 duration）就把计时清零、继续占住 —— ' +
      '哪怕它之前已经"该放手"了 99 秒；这条钉的是"有界"不是"到点就放弃"',
      !!recover && recover.p === true && recover.counter === 0 && recover.pending === true,
      JSON.stringify(recover));

    var repeat = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._videoEl=null;app._activeMediaJobPending=false;app._isPlaying=false;' +
      'app._mediaNoSourceSince=Date.now()-99999;' +
      'var p=app._isActiveMediaPending("completion-check");' +
      'return {p:p,counter:Number(app._mediaNoSourceSince)||0};})()'
    );
    check('40-A：放手后这个判据**自己不会重新占住** —— 要再占住必须有人重新登记媒体任务；' +
      '计时留着旧值也不许让它直接返回 true（否则只是把停摆往后推 120 秒，这一节照样翻不过去）',
      !!repeat && repeat.p === false, JSON.stringify(repeat));
  }
});

/** ---- 56. 目录说「还有 N 个待完成」时，「框都做完了」要有界否决（批次 38） ---- */
//
// 现场（2026-11-13 真页面）：`_isCurrentCompleted` 落到 `all-tasks-finished` 靠的是一份
//   **absence 证据** —— "这一页此刻没认出没做完的任务框"。同一时刻目录那一行挂着
//   `catalog_points_yi`「N个待完成任务点」+ `input.jobUnfinishCount`（值 >0），
//   那是平台留的**正面证据**：这一节还有任务框没挂载出来。
//   两者一撞，节就被翻过去 —— 用户看到的是「这一节点一下就跳了，里面还有题/视频没做」。
// 本场景钉六件事：
//   ① 目录带否决时，这一轮 `_isCurrentCompleted()` 为假、依据**不落** all-tasks-finished，
//      并且「下一节」一次都没点（症状级，不只是谓词返回 false）；
//   ② 否决读的是**目录那份 markup**（现场四件套），数字从 DOM 读回，不是我们自己编的；
//   ③ 窗口内**不续期**（否则页面每几秒抖一下就永不超时）；
//   ④ 预算用掉后**真的推进一次** + 留一条 warn（AGENTS §2.7：跳过要有解释、要可恢复）；
//   ⑤ 换一张卡片重新给一次预算（上一节用掉的窗口不许冤枉下一节）；
//   ⑥ 目录说「已完成」时照常推进、目录项认不出/抛出时不许按住（阳性对照 + 畸形页不停摆）。
SCENARIOS.push({
  name: '目录说还有N个待完成时不再一句框都做完了就翻页',
  path: '/catalog',
  run: async function (ctx) {
    var out = await ctx.client.evaluate(
      '(function(){return new Promise(function(res){var app=window._xxtApp;' +
      'try{app._clearTickLoop();}catch(e){}' +
      'var got=[];window.addEventListener("message",function(e){var m=e.data;' +
      '  if(m&&m.source==="xxt_app"&&m.type==="runtime_log")got.push(m);});' +
      // 完成判定的其它输入全部让路：只留「可见任务框全部已完成」这一条真判据在跑，
      // 于是"翻页有没有被按住"完全由目录否决这一条决定，不是别的分支碰巧挡的。
      'var origState=app._getVisibleTaskCompletionState, origKey=app._studyProgressKey;' +
      'var origItem=app._catalogItemForChapter, origNext=app.nextUnit, origCard=app._switchToNextLearningCard;' +
      'app._getVisibleTaskCompletionState=function(){return {hasTasks:true,allFinished:true};};' +
      'app._studyProgressKey=function(){return window.__vetoScope||"card-1";};' +
      'app._isActiveMediaPending=function(){return false;};' +
      'app._quizParseRetryUntil=0;app._quizSubmitPending=false;app.configs.restudy=false;app.configs.autoNext=true;' +
      'var unitCalls=0,cardCalls=0;app.nextUnit=function(){unitCalls++;};' +
      'app._switchToNextLearningCard=function(){cardCalls++;return false;};' +
      'function reset(){app._catalogVetoUntil=0;app._catalogVetoScope="";app._catalogVetoWarnAt=0;' +
      '  unitCalls=0;cardCalls=0;window.__vetoScope="card-1";}' +
      // 换标记一律用**现场那套 markup**（input + span/catalog_points_yi + prevHoverTips + orangeNew），
      // 判据读的就是这几层；随手拼一个 class 名会把场景测成"代码和自己一致"。
      'function clearMarks(n){var old=n.querySelectorAll("input.jobUnfinishCount,[class*=catalog_points],[class*=icon_]");' +
      '  for(var i=0;i<old.length;i++){old[i].parentNode.removeChild(old[i]);}}' +
      'function addPending(n,val,useInput,useSpan){' +
      '  if(useInput){var u=document.createElement("input");u.type="hidden";u.value=String(val);' +
      '    u.className="jobUnfinishCount";n.appendChild(u);}' +
      '  if(useSpan){var s=document.createElement("span");s.className="catalog_points_yi prevTips";' +
      '    var t=document.createElement("span");t.className="prevHoverTips";' +
      '    t.textContent=String(val)+"个待完成任务点";s.appendChild(t);' +
      '    var or=document.createElement("span");or.className="orangeNew";or.textContent=String(val);' +
      '    s.appendChild(or);n.appendChild(s);}}' +
      'function addDone(n){var s=document.createElement("span");s.className="icon_Completed prevTips";' +
      '  var t=document.createElement("span");t.className="prevHoverTips";t.textContent="已完成";' +
      '  s.appendChild(t);n.appendChild(s);}' +
      'var o={};' +
      'var item=app._catalogItemForChapter();' +
      // ---- 夹具自证：形状与实地一致，且 N 是从 DOM 上那颗 input 读回来的 ----
      'o.itemId=String((item||{}).id||"");' +
      'o.tip=String(((item&&item.querySelector(".prevHoverTips"))||{}).textContent||"");' +
      'o.rawCount=String(((item&&item.querySelector("input.jobUnfinishCount"))||{}).value||"(无)");' +
      'o.markerClass=String(((item&&item.querySelector("[class*=catalog_points]"))||{}).className||"(无)");' +
      'o.noDoneMark=!(item&&item.querySelector(".icon_Completed"));' +
      // ---- ① 否决武装：不判完成、依据不落 all-tasks-finished、一次下一节都不点 ----
      'reset();' +
      'o.arm=app._maybeHoldSkipForCatalog();' +
      'o.held=app._isCurrentCompleted();' +
      'o.evidence=String(app._completionEvidence||"");' +
      'o.untilInside=app._catalogVetoUntil-Date.now();' +
      'o.notClicked=app._skipIfCompleted();' +
      'o.unitCallsHeld=unitCalls;o.cardCallsHeld=cardCalls;' +
      // ---- ③ 窗口内再问一次：仍然按住，但**窗口终点没被推后**（不续期） ----
      'var untilBefore=app._catalogVetoUntil;' +
      'o.again=app._maybeHoldSkipForCatalog();' +
      'o.notRenewed=app._catalogVetoUntil===untilBefore;' +
      // ---- ④ 预算用掉：放行，而且这一轮**真的推进了一次** ----
      'app._catalogVetoUntil=Date.now()-1;' +
      'o.spent=app._maybeHoldSkipForCatalog();' +
      'o.doneAfterSpent=app._isCurrentCompleted();' +
      'o.evidenceAfterSpent=String(app._completionEvidence||"");' +
      'o.skippedAfterSpent=app._skipIfCompleted();' +
      'o.unitCallsAfterSpent=unitCalls;' +
      'o.scopeStamped=String(app._catalogVetoScope||"");' +
      // ---- ⑤ 换一张卡片：预算重新给一次 ----
      'window.__vetoScope="card-2";' +
      'o.nextCard=app._maybeHoldSkipForCatalog();' +
      // ---- ② 只有 span（没有机器可读的 input）也要否决 ----
      'reset();clearMarks(item);addPending(item,1,false,true);' +
      'o.spanOnlyNoInput=item.querySelectorAll("input.jobUnfinishCount").length===0;' +
      'o.spanOnly=app._maybeHoldSkipForCatalog();' +
      // ---- ② 只有 input（没有 span）也要否决，claimed 用的就是 DOM 上那个值 ----
      'clearMarks(item);addPending(item,2,true,false);' +
      'o.countOnlyNoSpan=item.querySelectorAll("[class*=catalog_points]").length===0;' +
      'o.countOnlyRaw=String(item.querySelector("input.jobUnfinishCount").value);' +
      'o.countOnlyRead=app._catalogUnfinishedCount(item);' +
      'reset();o.countOnly=app._maybeHoldSkipForCatalog();' +
      // ---- ⑥ 目录说「已完成」= 阳性对照：出口照常推进 ----
      'clearMarks(item);addDone(item);' +
      'o.doneTip=String(item.querySelector(".prevHoverTips").textContent);' +
      'reset();o.doneVeto=app._maybeHoldSkipForCatalog();' +
      'o.doneCompleted=app._isCurrentCompleted();' +
      'o.doneEvidence=String(app._completionEvidence||"");' +
      'o.doneSkipped=app._skipIfCompleted();' +
      'o.unitCallsDone=unitCalls;' +
      // ---- ⑥ 目录项认不出 / 判据抛出：不许按住（畸形页面不能变成停摆） ----
      'clearMarks(item);addPending(item,1,true,true);' +
      'reset();app._catalogItemForChapter=function(){return null;};' +
      'o.nullVeto=app._maybeHoldSkipForCatalog();' +
      'o.nullCompleted=app._isCurrentCompleted();' +
      'app._catalogItemForChapter=function(){throw new Error("boom");};' +
      'o.throwVeto=app._maybeHoldSkipForCatalog();' +
      'app._catalogItemForChapter=origItem;' +
      'app._getVisibleTaskCompletionState=origState;app._studyProgressKey=origKey;' +
      'app.nextUnit=origNext;app._switchToNextLearningCard=origCard;' +
      'setTimeout(function(){' +
      'function metaOf(name){for(var i=0;i<got.length;i++){if(got[i].message===name)return got[i].meta||{};}' +
      '  return null;}' +
      // ⚠️ 这里只读**第一条** delay / spent：武装过多次（①④⑤⑥），但 ①③④⑤ 阶段目录形状没变，' +
      // 它们的 meta 本来就相同。绝不用 `claimed===N` 去筛条目再断 claimed（自筛自证）。
      'o.delay=metaOf("catalog still lists unfinished task points, delay skip");' +
      'o.spentLog=metaOf("catalog veto window spent, allow skip");' +
      'o.seen=got.length;' +
      'res(o);},400);});})()'
    );
    check('夹具自证：这一节的目录项是 cur<chapterId>、tip 写「1个待完成任务点」、' +
      '计数是那颗可读的 input（值 1）、class 里带 catalog_points_、且没有 icon_Completed',
      !!out && out.itemId === 'cur9000049294' && out.tip === '1个待完成任务点' &&
      out.rawCount === '1' && /^catalog_points_/.test(out.markerClass) && out.noDoneMark === true,
      JSON.stringify(out && { itemId: out.itemId, tip: out.tip, rawCount: out.rawCount,
        markerClass: out.markerClass, noDoneMark: out.noDoneMark }));
    check('★ 目录还写着「N个待完成任务点」时，「框都做完了」不再单独发证：' +
      '这一轮 _isCurrentCompleted 为假、依据不落 all-tasks-finished、下一节一次都没点',
      out && out.arm === true && out.held === false && out.evidence === '' &&
      out.notClicked === false && out.unitCallsHeld === 0 && out.cardCallsHeld === 0,
      JSON.stringify(out && { arm: out.arm, held: out.held, evidence: out.evidence,
        notClicked: out.notClicked, unitCallsHeld: out.unitCallsHeld, cardCallsHeld: out.cardCallsHeld }));
    check('延时是有界的：窗口落在 20 秒以内（等整帧挂载，但不是"等它长出来为止"）',
      out && out.untilInside > 0 && out.untilInside <= 20000, 'untilInside=' + JSON.stringify(out && out.untilInside));
    check('窗口内不续期：再问一次仍然按住，但窗口终点没被推后（否则页面抖一下就是永不超时）',
      out && out.again === true && out.notRenewed === true,
      JSON.stringify(out && { again: out.again, notRenewed: out.notRenewed }));
    check('预算用掉后放行，且**真的推进一次**（把「跳过」换成另一种「磨蹭」是这次要避免的）',
      out && out.spent === false && out.doneAfterSpent === true &&
      out.evidenceAfterSpent === 'all-tasks-finished' && out.skippedAfterSpent === true &&
      out.unitCallsAfterSpent === 1 && out.scopeStamped === 'card-1',
      JSON.stringify(out && { spent: out.spent, doneAfterSpent: out.doneAfterSpent,
        evidenceAfterSpent: out.evidenceAfterSpent, skippedAfterSpent: out.skippedAfterSpent,
        unitCallsAfterSpent: out.unitCallsAfterSpent, scopeStamped: out.scopeStamped }));
    check('换一张卡片预算重新给一次（上一节用掉的窗口不该冤枉下一节还没挂载的任务框）',
      out && out.nextCard === true, JSON.stringify(out && { nextCard: out.nextCard }));
    check('两种现场形状都算否决：只有 catalog_points_yi 那个 span（input 缺席）、' +
      '以及只有 input.jobUnfinishCount（span 缺席，值从 DOM 读回是 2）',
      out && out.spanOnlyNoInput === true && out.spanOnly === true &&
      out.countOnlyNoSpan === true && out.countOnly === true &&
      out.countOnlyRaw === '2' && Number(out.countOnlyRead) === 2,
      JSON.stringify(out && { spanOnlyNoInput: out.spanOnlyNoInput, spanOnly: out.spanOnly,
        countOnlyNoSpan: out.countOnlyNoSpan, countOnly: out.countOnly,
        countOnlyRaw: out.countOnlyRaw, countOnlyRead: out.countOnlyRead }));
    check('阳性对照：目录自己显示「已完成」时出口照常推进（by=all-tasks-finished、下一节点一次）—— ' +
      '否决不是把出口焊死',
      out && out.doneTip === '已完成' && out.doneVeto === false && out.doneCompleted === true &&
      out.doneEvidence === 'all-tasks-finished' && out.doneSkipped === true && out.unitCallsDone === 1,
      JSON.stringify(out && { doneTip: out.doneTip, doneVeto: out.doneVeto, doneCompleted: out.doneCompleted,
        doneEvidence: out.doneEvidence, doneSkipped: out.doneSkipped, unitCallsDone: out.unitCallsDone }));
    check('目录项认不出（null）或读目录抛出时不许按住，也不许把这一节判成没做完',
      out && out.nullVeto === false && out.nullCompleted === true && out.throwVeto === false,
      JSON.stringify(out && { nullVeto: out.nullVeto, nullCompleted: out.nullCompleted, throwVeto: out.throwVeto }));
    check('delay skip 那条 warn 带取证字段，且 claimed 就是 DOM 上那颗 input 的值（不是夹具字面量）',
      !!out && !!out.delay && String(out.delay.claimed) === out.rawCount && out.delay.marker === true &&
      Number(out.delay.holdMs) > 0,
      JSON.stringify(out && { delay: out.delay, rawCount: out.rawCount }));
    check('窗口用掉也要留话（catalog veto window spent），否则日志里只剩"它为什么不跳"没人答',
      !!out && !!out.spentLog && String(out.spentLog.claimed) === out.rawCount && out.spentLog.marker === true,
      JSON.stringify(out && { spentLog: out.spentLog, seen: out.seen }));
  }
});

// ===========================================================================
async function main() {
  // 筛选词支持多个（逗号 / 分号 / 竖线分隔）—— 调试同一批新场景时，
  // 一次定向跑比来回跑整套快得多；写全套计数的规则不变（带筛选就不写）。
  var filters = E2E_FILTER ? E2E_FILTER.split(/[,;|]/).map(function (s) {
    return s.trim().toLowerCase();
  }).filter(Boolean) : [];
  var selected = filters.length ? SCENARIOS.filter(function (scenario) {
    var name = scenario.name.toLowerCase();
    return filters.some(function (needle) { return name.indexOf(needle) !== -1; });
  }) : SCENARIOS;
  if (!selected.length) throw new Error('OMITONE_E2E_FILTER 未匹配任何场景: ' + E2E_FILTER);
  if (E2E_FILTER) console.log('  定向筛选: ' + E2E_FILTER + '（' + selected.length + ' 场景；不写全套计数）');
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
      '--disable-extensions-except=' + EXT_DIR,
      '--load-extension=' + EXT_DIR,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      // 让场景页的 chaoxing.com 落到本地 mock 服务上（只在本机调试用）
      // mooc2 是给批次 35 的「同站跨源内容帧」夹具用的：站点相同（chaoxing.com）、origin 不同，
      // 这才是现场那种"帧被换成平台另一台机器"的形状。
      '--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1, MAP mooc2.chaoxing.com 127.0.0.1',
      '--disable-background-networking',
      'about:blank'
    ], { stdio: 'ignore', detached: process.platform !== 'win32' });

    await waitForCdp(30000);

    console.log('  加载的扩展目录: ' + EXT_DIR + (EXT_DIR === ROOT ? '（仓库根目录）' : '（打包产物）'));

    var computedId = computeExtensionId(EXT_DIR);
    // 真实 ID 以运行时发现为准（路径哈希会因盘符大小写算错，见 discoverExtensionId 的说明）
    var extensionId = await discoverExtensionId(computedId);
    console.log('  扩展 ID: ' + extensionId);
    if (extensionId !== computedId) {
      console.log('  ⚠️ 路径哈希给出的是 ' + computedId + '（盘符大小写不一致所致），已改用运行时发现的 ID。');
    }

    await initConfigWriter(extensionId);

    for (var i = 0; i < selected.length; i++) {
      var scenario = selected[i];
      var targetLabel = String(scenario.url || scenario.path).replace('{EXT}', extensionId);
      section(scenario.name + '  (' + targetLabel + ')');

      var ctx = null;
      try {
        if (scenario.inject === false) await clearExtLocalStorage();
        ctx = await openScenarioPage(extensionId, scenario);
        ctx.mock = mock;
        ctx.extensionId = extensionId;

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
    if (!E2E_FILTER) fs.writeFileSync(path.join(ROOT, '.workbuddy', 'e2e-counts.json'), JSON.stringify({
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
