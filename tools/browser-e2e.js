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
 *   OMITONE_EXT_DIR=dist/omitone-1.2.6 npm run e2e
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
 * 两个讨论任务点挂在同一页（两张卡片都**不带** isFinished）——
 * 用于验证「第一个做完之后，第二个还能不能被找到」。
 */
function buildDiscussionTwoHtml() {
  function card(id, title) {
    return '<div id="topicMainDiv" data="https://groupweb.chaoxing.com/course/topic' +
      '?clazzid=1&courseid=2&mtopicid=' + id + '&ut=s">' + title + '</div>';
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>课程学习 - 学习通</title></head><body>' +
    '<div id="iframe">' +
    card(777, '讨论一：联系实际谈坚持党的全面领导') +
    card(888, '讨论二：说说你身边的变化') +
    '</div></body></html>';
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

/**
 * 视频内嵌**多选题**弹窗。
 *
 * 为什么必须单独有一个：非视频整卷里的多选已经改成**本地作答、不进请求**
 * （见第 21 条场景），于是"模型把多选答案摊平成一串字母"这种退化形状
 * **在整卷那条路上不会再出现**了。但视频弹题那条路仍然把多选交给模型
 * （答错就不让继续播，不能乱答），所以 `resegmentFlatAnswers` 依旧要守，
 * 只是必须换到**还活着的那条路**上来测 —— 否则测试还是绿的，它守的东西没了。
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
  '/discussion-two': buildDiscussionTwoHtml,
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
          // 顶到 max_tokens 被截断。**只有"批 ≥ 4 题"时才这样** ——
          // 拆成两半（≤3 题）就能正常作答，正好验证"拆批能救回来"。
          if (questionCount >= 4) {
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
  name: '角色动作专项：39 张立绘与 11 动作完整覆盖',
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
    check('立绘去重后 39 张，默认 pet.png 只出现一次', book.sources.length === 39 &&
      new Set(book.sources).size === 39 && book.sources.filter(function (src) { return src === 'pet.png'; }).length === 1,
      JSON.stringify(book));
    check('分组为 17 服装 / 12 表情 / 10 去重姿势，汇总显示 39',
      book.groups['服装'].length === 17 && book.groups['表情'].length === 12 &&
      book.groups['姿势'].length === 10 && /39\s*张/.test(book.meta), JSON.stringify(book.groups));
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
    check('前置：79 分心情确实在高档阈值下', moodBefore === '79', String(moodBefore));
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
      body.scrollTop = body.scrollHeight;
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
      'var sp=document.getElementById("btnPetShow");' +
      'out.hasShowBtn=!!sp;' +
      'if(sp)sp.click();' +
      'await new Promise(function(r){setTimeout(r,200);});' +
      'out.shown=pet.style.display!=="none"&&pet.classList.contains("show");' +
      'return out;})()'
    );
    check('连点「装」三次不会被当成戳（不躲）', !!r && r.ok && r.dodged === false, JSON.stringify(r));
    check('「藏」能把人收起来', !!r && r.hidAfterHide === true || (!!r && r.hidden === true), JSON.stringify(r));
    check('「显示小人」按钮存在', !!r && r.hasShowBtn === true, JSON.stringify(r));
    check('点「显示小人」能重新出现', !!r && r.shown === true, JSON.stringify(r));
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
      // —— 换装 ——
      'var img=pet.querySelector(".pet-art");out.src0=img?img.getAttribute("src"):"";' +
      'var bo=document.querySelector("#petTools button[data-act=\\"outfit\\"]");' +
      'if(bo)bo.click();await new Promise(function(r){setTimeout(r,200);});' +
      'out.src1=img?img.getAttribute("src"):"";' +
      // —— 换姿势 ——
      'out.pose0=img?img.getAttribute("src"):"";' +
      'var bp=document.querySelector("#petTools button[data-act=\\"pose\\"]");' +
      'if(bp)bp.click();await new Promise(function(r){setTimeout(r,200);});' +
      'out.pose1=img?img.getAttribute("src"):"";' +
      // —— 隐藏（放最后）——
      'var bh=document.querySelector("#petTools button[data-act=\\"hide\\"]");' +
      'if(bh)bh.click();await new Promise(function(r){setTimeout(r,150);});' +
      'out.hidden=pet?pet.style.display==="none":null;' +
      'out.errCount=out.errs.length;out.errText=out.errs.join(" | ");' +
      'return out;})()'
    );
    check('角色在精美模式下自动出现', !!r && r.petShown === true, JSON.stringify({shown: r && r.petShown, ui: r && r.ui}));
    check('「姿」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.pose === true, JSON.stringify(r && r.hits));
    check('「装」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.outfit === true, JSON.stringify(r && r.hits));
    check('「藏」按钮真的点得到（命中测试）', !!r && r.hits && r.hits.hide === true, JSON.stringify(r && r.hits));
    check('点「装」换立绘', !!r && r.src0 !== r.src1, r ? r.src0 + ' → ' + r.src1 : '');
    check('点「姿」换姿态', !!r && r.pose0 !== r.pose1, r ? r.pose0 + ' → ' + r.pose1 : '');
    check('拖动位移 > 30px', !!r && Math.abs(r.dragDx) > 30, r ? String(r.dragDx) : '');
    check('拖完仍在视口内', !!r && r.inView === true, '');
    check('点「藏」收起', !!r && r.hidden === true, '');
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
      'var pb=document.querySelector("#petTools button[data-act=\\"pose\\"]");' +
      'if(pb){pb.click();await new Promise(function(r){setTimeout(r,180);});}' +
      'out.pose1=pet?pet.getAttribute("data-pose"):"";' +
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
    check('点「姿」会换姿势立绘', !!r && r.pose0 !== r.pose1, r ? r.pose0 + ' → ' + r.pose1 : '');
    check('点「藏」会收起来', !!r && r.hidden === true, '');
    check('「显示小人」能叫回来', !!r && r.shown === true, '');
    check('点完全部开关（来回各一次）没有未捕获异常', !!r && r.errCount === 0, r ? r.errText : '');
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
    // ⚠️ 多选不再是"模型给的 A,C"了：1.2.9 起非视频整卷的多选由**本地作答**、
    //    压根不进请求（见第 21 条场景）。这里只守"它有值"——
    //    "模型给多选答案时要能填成 AC" 由下面那段直接调 _fillAnswers 来锁。
    check('多选题已填上（本地作答，不再是模型给的 A,C）',
      /^[A-D]+$/.test(result.a1002 || ''), JSON.stringify(result.a1002));
    var multiFromLlm = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'var qs=app._extractQuestions(null);var idx=-1;' +
      'for(var i=0;i<qs.length;i++){ if(qs[i].type==="multiple") idx=i; }' +
      'if(idx<0) return {missing:true};' +
      'app._fillAnswers([{index:idx,type:"multiple",answer:["A","C"]}],qs,null);' +
      'var h=document.getElementById("answer1002");' +
      'return {hidden:h?h.value:null};})()'
    );
    check('模型给出多选答案时，回填仍然是 A,C → #answer1002 = "AC"' +
      '（弹题那条路与"本地算不出、交回模型"的题都走这里）',
      multiFromLlm && multiFromLlm.hidden === 'AC', JSON.stringify(multiFromLlm));
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
      r7f && r7f.isRandom === false && r7f.reason === 'api-disabled', JSON.stringify(r7f));

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
    // 静音开关已删：插件不再替用户静音音频，要静音直接静音标签页
    var audioRate = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{playbackRate:2,autoMaxPlaybackRate:false,muted:false});' +
      'var a=document.getElementById("omitone-audio");' +
      'app._ensurePlaybackRate(a,"e2e-audio");' +
      'return {rate:a.playbackRate, muted:a.muted};})()'
    );
    check('音频应用配置倍速（2x）', audioRate.rate === 2, JSON.stringify(audioRate));
    check('音频不再被插件静音（交给标签页静音，旧开关已删）', audioRate.muted === false, JSON.stringify(audioRate));

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
    var probe = await ctx.client.evaluate(
      '(async function(){' +
      'var out={hasBtn:!!document.getElementById("checkUpdate"),hasMsg:!!document.getElementById("updateMsg")};' +
      'if(!out.hasBtn) return out;' +
      // ⚠️ 先等弹窗打开时那次**自动检测**落地：它自己会真实请求一次，
      // 如果不等，它会在下面 mock 出结果之后再写一遍「与线上一致」，把断言要的结果盖掉。
      'await new Promise(function(r){setTimeout(r,900);});' +
      // ① 线上版本更高
      'window.fetch=function(){return Promise.resolve({ok:true,json:function(){' +
      'return Promise.resolve({tag_name:"v9.9.9",assets:[{name:"omitone.zip",updated_at:new Date().toISOString()}]});}});};' +
      'document.getElementById("checkUpdate").click();' +
      'await new Promise(function(r){setTimeout(r,150);});' +
      'out.btnLabel=String((document.getElementById("doUpdate")||{}).textContent||"");' +
      'out.higherMsg=String(document.getElementById("updateMsg").textContent||"");' +
      'out.higherBtn=getComputedStyle(document.getElementById("doUpdate")).display!=="none";' +
      // ② 网络失败
      'window.fetch=function(){return Promise.reject(new Error("offline"));};' +
      'document.getElementById("checkUpdate").click();' +
      'await new Promise(function(r){setTimeout(r,150);});' +
      'out.failMsg=String(document.getElementById("updateMsg").textContent||"");' +
      'out.failBtn=getComputedStyle(document.getElementById("doUpdate")).display!=="none";' +
      'return out;})()'
    );
    check('前置条件：弹窗里有「检测更新」和结果文字',
      !!probe && probe.hasBtn === true && probe.hasMsg === true, JSON.stringify(probe));
    check('线上版本更高 → 说清有最新版并问「是否更新」（不是直接替人下结论）',
      !!probe && /有最新版\s*9\.9\.9/.test(String(probe.higherMsg)) &&
      /是否更新/.test(String(probe.higherMsg)) && probe.higherBtn === true,
      JSON.stringify(probe));
    check('按钮是「是，覆盖更新」（更新是覆盖，不是装个新的）',
      !!probe && /覆盖/.test(String(probe.btnLabel)), JSON.stringify(probe));
    check('查不出来 → 文案里**不能**出现「最新版」这类结论；下载入口仍保留',
      !!probe && String(probe.failMsg).indexOf('最新') === -1 && probe.failBtn === true,
      JSON.stringify(probe));
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
    var probe = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,{enableQuiz:true,apiKey:"e2e-key",randomAnswer:false});' +
      'app._quizApiFailUntil=0;' +
      'var doc=app._resolveQuizSubmitDocument(null)||app._getMainDocument();' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizSubmitPending=false;' +
      'var before=app._isQuizLearningPending(doc);' +
      'app._quizAnswered=true;' +                 // 模拟"刚交完卷"
      'var after=app._isQuizLearningPending(doc);' +
      'return {before:before, after:after};})()'
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

/** ---- 29. run() 落「续跑标记」：讨论任务 window.open 新开的窗口才会自动跑 ----
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
      // ⚠️ "整批"的大小**不是全卷题数**：多选题从 1.2.9 起由本地作答、不进请求
      //    （见「非视频整卷的多选本地作答」那条场景），所以这里必须按
      //    "实际会发给模型的题数"来算，否则断言会跟着实现一起漂。
      'var asked=qs.filter(function(q){return q.type!=="multiple";}).length;' +
      'return {total:qs.length,asked:asked};})()'
    );
    check('装配：本卷实际要问模型的题数 ≥ 4（这样"整批"才会触发退化）',
      setup && setup.asked >= 4, JSON.stringify(setup));
    if (!setup || setup.asked < 4) return;

    // 让假模型"一批 ≥ 4 题就吐长篇重复内容、顶到 max_tokens 被截断"。
    // 拆成两半（≤3 题）后它才正常作答 —— 正好验证"拆批能救回来"。
    ctx.mock.setResponseMode('truncate-big');
    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var allFilled = await waitFor(ctx.client,
      '(function(){var app=window._xxtApp;var qs=app._quizCurrentQuestions||[];' +
      'if(!qs.length) return false;' +
      'var d=app._resolveQuizAnswerDocument(null);' +
      'for(var i=0;i<qs.length;i++){ if(!app._getQuizQuestionFilledValue(d,qs[i])) return false; }' +
      'return true;})()', 25000);

    var sent = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });

    check('被截断的那一批**只发一次**（旧实现要拿同一批重问两次、再补问两次）',
      sent.filter(function (n) { return n === setup.asked; }).length === 1, JSON.stringify(sent));
    check('确实按"对半拆"重问了（能看到比整批更小的批）',
      sent.some(function (n) { return n > 0 && n < setup.asked; }), JSON.stringify(sent));
    check('拆批之后所有题都答上了（旧实现这一批一道都落不了地）',
      allFilled === true, 'filled=' + allFilled + ' sent=' + JSON.stringify(sent));
    check('整卷只用了 3 次请求（1 次整批 + 2 次拆半），没有补问式的浪费',
      sent.length === 3, JSON.stringify(sent));

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

    // ⚠️ "整批"的大小不是全卷题数：多选题由本地作答、不进请求（见第 21 条场景），
    //    所以按"实际会发给模型的题数"来数，否则断言会跟着实现一起漂。
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      'return {total:qs.length,asked:qs.filter(function(q){return q.type!=="multiple";}).length};})()'
    );
    check('装配：本卷要问模型的题数 ≥ 1', setup && setup.asked >= 1, JSON.stringify(setup));

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
      'return true;})()', 25000);
    var sentCount = ctx.mock.requests.length - before;
    var sentCounts = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });

    check('一行一个 JSON 值的应答能被解析，题目全部答上（旧实现一道都答不上）',
      allFilled === true, 'filled=' + allFilled + ' sent=' + JSON.stringify(sentCounts));
    // 守的是"整批不许被重复问"：升级前解析失败 → `requestAnswersWithRetry`
    // 会**拿同一整批再问一次**，所以 counts 里会出现两次整批。
    // （补问是另一套机制、本来就该发生，所以这里只数"整批"的次数。）
    check('整批只问了一次（旧实现解析失败会把整批重问一次）',
      sentCounts.filter(function (n) { return n === setup.asked; }).length === 1,
      'counts=' + JSON.stringify(sentCounts));

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

    // ⚠️ 同第 33 条：整批大小按"实际会发给模型的题数"算（多选不进请求）
    var setup = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app.configs=Object.assign({},app.configs,' + JSON.stringify(cfg) + ');' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizCurrentQuestions=null;' +
      'var qs=app._extractQuestions(null);' +
      'return {total:qs.length,asked:qs.filter(function(q){return q.type!=="multiple";}).length};})()'
    );
    check('装配：本卷要问模型的题数 ≥ 1', setup && setup.asked >= 1, JSON.stringify(setup));

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
      'return true;})()', 25000);
    var sentCounts = ctx.mock.requests.slice(before).map(function (r) {
      var m = r.prompt.match(/^\d+\|[a-z]\|/gm);
      return m ? m.length : 0;
    });

    check('`|||` 串起来的应答能被解析，题目全部答上（旧实现一道都答不上）',
      allFilled === true, 'filled=' + allFilled + ' counts=' + JSON.stringify(sentCounts));
    check('整批只问了一次（旧实现解析失败会把整批重问一次）',
      sentCounts.filter(function (n) { return n === setup.asked; }).length === 1,
      'counts=' + JSON.stringify(sentCounts));

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
 * ⚠️ 这一条**原来挂在章节测验页（/quiz）上**，1.2.9 起必须换到弹题页：
 *    非视频整卷的多选已经改成"本地作答、不进请求"（见第 21 条场景），
 *    那条路上**再也不可能**出现"模型把多选答案摊平成一串"的形状了。
 *    留在原地的话，测的会是一条永远不会发生的退化 —— 绿的，但守的东西没了。
 *
 * 还活着的场景：视频里的多选弹题（答错就不让继续播，不能乱答）仍然交给模型。
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
    check('弹题这条路的提示词里**有**多选题（本地化没波及到它）',
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
 * ---- 21. 非视频整卷的多选：本地作答，压根不发给模型 ----
 *
 * 用户 2026-10-10 的反馈：
 *   「多选题只要填了就行的情况下，就不要倾斜太多的 token 和上下文等等的东西过去，
 *     刚好我们有一套成熟的识别多选题的系统，不如识别到这种答题用非视频里的直接乱答就行」
 *
 * 它要治的现场症状：一批 5 题（3 多选 + 2 填空）时模型答多选会把选项字母**摊平**成一串
 * （`["A","B","C","D","A","B","C","D","A","B","C","填空","填空"]`，13 项对 5 题）
 * → 整批长度不符被丢弃 → 补问 → 又摊平，用户看到的"5 个多选只做了 4 个、
 * 最后一个空着、然后不断重复"。
 *
 * 三条主线断言，全都不是实现细节：
 *   ① 提示词里**没有**多选题 —— 这才是"少烧 token/上下文"的直接证据
 *   ② 提示词里**有**其他题 —— 证明不是把整卷一起漏掉了
 *   ③ 多选题在 DOM 里**真的被填上并勾选** —— 表单少一处就永远不提交（本仓库最怕的静默失败）
 *
 * ⚠️ 还要守住第二版才加的那道闸：**本地作答只在这份卷子的第一次尝试里生效**。
 *    没有它，本地猜的多选让卷子永远过不了 → 平台「请重做」→ 重答重交 → 最多 20 次
 *    （用户报的「只做多选题、其他的不做、疯狂提交」）。所以后半段专门验"第二轮交回模型"。
 */
SCENARIOS.push({
  name: '非视频整卷的多选本地作答（不问模型）',
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

    // 反向守卫（**放在最前面做**）：本地**读不到选项**的多选不能被算作"已处理"。
    // 漏了它就等于"本地没填上、模型又没问" → 空题 → 永不提交（比省下的 token 贵得多）。
    // 顺序很重要：上面还没跑过任何本地作答，闸门不会替它"背锅"把这条断言变成空测。
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

    var before = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');

    var sent = false;
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (ctx.mock.requests.length > before) { sent = true; break; }
      await sleep(300);
    }
    check('其余题目仍然发到模型接口', sent, '请求数 +' + (ctx.mock.requests.length - before));
    if (!sent) return;

    var prompt = ctx.mock.requests[ctx.mock.requests.length - 1].prompt;
    check('提示词里**没有**多选题（省下的就是这一块 token / 上下文）',
      prompt.indexOf('以下属于操作系统核心功能的有') === -1, prompt.slice(0, 160));
    check('提示词里不含多选题的选项原文',
      prompt.indexOf('进程管理') === -1 && prompt.indexOf('编译源代码') === -1);
    check('提示词里**有**单选题题干（没有把整卷一起漏掉）',
      prompt.indexOf('中国特色社会主义最本质的特征') !== -1);
    check('提示词里**有**填空题与简答题题干（只有多选走本地）',
      prompt.indexOf('一个完整的 IP 地址由') !== -1 && prompt.indexOf('简述数据库事务') !== -1);
    check('多选题型代号 "|m|" 一次都没出现',
      !/\d+\|m\|/.test(prompt), prompt.slice(0, 160));

    var filled = await waitFor(ctx.client,
      '(function(){var e=document.getElementById("answer1002");return !!e && e.value !== "";})()', 15000);
    check('多选在 DOM 里被本地填上了（空着就永远不会提交）', filled === true);

    var multi = await ctx.client.evaluate(
      '(function(){var e=document.getElementById("answer1002");' +
      'var checked=[];var ins=document.querySelectorAll("input[name=\'answer1002\']");' +
      'for(var i=0;i<ins.length;i++){if(ins[i].checked)checked.push(ins[i].value);}' +
      'return {value:e?e.value:null,checked:checked.sort().join("")};})()'
    );
    check('多选答案形状合法（≥1 项、字母不越界）',
      !!multi && /^[A-D]+$/.test(multi.value || ''), JSON.stringify(multi));
    check('答案确实被勾到了选项上（隐藏域与勾选态一致，不是只写了个字段）',
      !!multi && multi.checked === multi.value, JSON.stringify(multi));

    // 模型那条路没被影响：单选还是"问出来的"A
    var a1001 = await ctx.client.evaluate('document.getElementById("answer1001").value');
    check('单选仍然由模型作答（本地化只针对多选）', a1001 === 'A', String(a1001));

    var ready = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'return app._areQuizAnswersFilled(null,qs,{requireThisRun:true});})()'
    );
    check('整卷判定"每题都有值"→ 可以提交（本地作答的题没有破坏提交前置）',
      ready === true, String(ready));

    // 幂等：模型回来后流程还会再走一遍**同一个入口**（那一趟的职责是补被误清的题）。
    // 它必须**不重填、不重问** —— 否则刚填好的答案会被自己覆盖掉。
    // ⚠️ 必须带 `{refill:true}`：不带就等于"新一轮"的第一趟，
    //    会撞上下面那道"只在这份卷子的第一次尝试里本地作答"的闸 —— 那是另一条断言要测的。
    var beforeAgain = ctx.mock.requests.length;
    var again = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var e=document.getElementById("answer1002");' +
      'var was=e?e.value:null;' +
      'var qs=app._extractQuestions(null);' +
      'var handled=app._answerLocalMultiChoiceQuestions(qs,null,{refill:true});' +
      'var now=document.getElementById("answer1002");' +
      'return {was:was,now:now?now.value:null,keys:Object.keys(handled).join(",")};})()'
    );
    check('补填那一趟是幂等的：答案不变（只会补被清掉的那几题）',
      again && again.was === again.now && !!again.was, JSON.stringify(again));
    check('补填那一趟没有多花任何模型请求',
      ctx.mock.requests.length === beforeAgain,
      '多发了 ' + (ctx.mock.requests.length - beforeAgain) + ' 次');
    check('"已本地处理"的下标表里正好有多选题那一位',
      !!again && again.keys.split(',').indexOf(String(setup.multipleIndex)) !== -1,
      JSON.stringify(again));

    // ================= 这一份卷子的"第二次尝试" =================
    //
    // 现场实测（2026-10-10）：第一版**没有**这道闸，多选永远本地乱答 →
    //   卷子永远过不了及格线 → 平台「请重做」→ 重答重交 → 最多 20 次，
    //   而每一次提交都是**真的交上去**。用户看到的就是
    //   「只做多选题、其他的不做、**疯狂提交**」。
    // 所以本卷交过手之后必须把多选交回模型 —— 猜答案过不了的卷子，重做多少遍都过不了。
    var paper = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'return {key:String(app._getQuizWorkKey(null)).slice(0,24),' +
      'max:app._getQuizMaxSubmitAttempts(null),' +
      'localPapers:Object.keys(app._quizLocalMultiplePapers||{}).length};})()'
    );
    check('本卷被记上"已本地作答过"（第二轮才认得出这份卷子交过手）',
      paper && paper.localPapers === 1 && paper.key.indexOf('omitone.quiz.correct.') === 0,
      JSON.stringify(paper));
    check('本地作答过的卷子，交卷上限从 20 收到 2（不拿用户的提交次数去赌）',
      paper && paper.max === 2, JSON.stringify(paper));

    // 模拟平台"请重做"：真机上这一步由 `_prepareQuizRedoIfNeeded` 完成 ——
    // 它把这一组状态清零，下一轮 tick 才会重新答题。
    // 「没进展」的闸也要一起放掉：真机上重做会换一茬页面，填答数不会再和上轮相同。
    await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;' +
      'app._quizAnswered=false; app._quizInProgress=false; app._quizReadyToSubmit=false;' +
      'app._quizReadyWorkKey=""; app._quizCurrentAnsweredKeys={}; app._quizCurrentAnswerValues={};' +
      'app._quizCurrentQuestions=null; app._quizRoundNoProgressAt=0; app._quizRoundFilledCount=-1;' +
      'return true;})()'
    );
    var beforeRedo = ctx.mock.requests.length;
    await ctx.client.evaluate('(function(){window._xxtApp._handleQuiz(null); return true;})()');
    var redoSent = false;
    var redoDeadline = Date.now() + 20000;
    while (Date.now() < redoDeadline) {
      if (ctx.mock.requests.length > beforeRedo) { redoSent = true; break; }
      await sleep(300);
    }
    var redoPrompts = ctx.mock.requests.slice(beforeRedo).map(function (r) { return r.prompt; });
    check('第二轮（重做）多选交回模型：提示词里重新出现多选题',
      redoSent && redoPrompts.some(function (p) { return /\d+\|m\|/.test(p); }),
      '请求数 +' + (ctx.mock.requests.length - beforeRedo) + ' · ' +
      String(redoPrompts[0] || '').slice(0, 120));

    var redoMulti = await waitFor(ctx.client,
      '(function(){var e=document.getElementById("answer1002");return !!e && e.value === "AC";})()', 15000);
    check('第二轮多选填的是**模型给的那份**（A,C），不再是本地猜的',
      redoMulti === true,
      await ctx.client.evaluate('String(document.getElementById("answer1002").value)'));

    var redoReady = await ctx.client.evaluate(
      '(function(){var app=window._xxtApp;var qs=app._extractQuestions(null);' +
      'return app._areQuizAnswersFilled(null,qs,{requireThisRun:true});})()'
    );
    check('第二轮的整卷仍然"每题都有值"（交回模型没有把提交前置弄丢）',
      redoReady === true, String(redoReady));
  }
});

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  var selected = E2E_FILTER ? SCENARIOS.filter(function (scenario) {
    return scenario.name.toLowerCase().indexOf(E2E_FILTER.toLowerCase()) !== -1;
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
      '--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1',
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
