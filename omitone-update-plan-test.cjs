#!/usr/bin/env node
'use strict';
/*
 * 更新提示的判定表（零依赖，`node omitone-update-plan-test.cjs`）。
 *
 * 为什么在根目录单开一套：`checkUpdate` 里那五格话以前只有真实浏览器量得到，
 * 而这一轮要改的正是「预览版用户」与「开发构建」被压成同一句 —— 那属于
 * 纯判定，不该靠起浏览器来证明。做法是从 `popup/popup.js` **原文**里切出函数本体，
 * 用 `new Function` 重组后单独喂数据：不跑整个 popup.js，不碰 DOM 与 chrome。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'popup', 'popup.js');
const text = fs.readFileSync(SRC, 'utf8');

/** 从「function 名字(」切到与之配对的那个右花括号。 */
function sliceFn(name) {
  const head = 'function ' + name + '(';
  const at = text.indexOf(head);
  assert.ok(at >= 0, `popup/popup.js 里找不到 ${head}`);
  assert.ok(at === 0 || /[\r\n]/.test(text[at - 1]), `${name} 的定义不在行首，切到的可能是引用而不是本体`);
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const body = text.slice(at, i + 1);
        // 数错括号最常见的下场是「把下一个函数一起带走」—— 当场响，别静默交出一份多出来的本体
        assert.ok(!/\nfunction /.test(body), `${name} 的切片里含另一个函数定义，花括号没配对`);
        return body;
      }
    }
  }
  throw new Error(`${name} 的花括号没有闭合`);
}

// 注入的常量要从源码读回来，不许在测试里另抄一份「我以为的名字」：
// 名字改了而这里写死，no-asset / show 两格会一起变成空转的对照
const assetFromSrc = (text.match(/const UPDATE_PREVIEW_ASSET = "([^"]+)";/) || [])[1] || '';
assert.strictEqual(assetFromSrc, 'omitone-preview.zip',
  'popup/popup.js 里预览附件名的真源与这套件注入的值不是同一串');

const assembled = new Function([
  '"use strict";',
  `var UPDATE_PREVIEW_ASSET = ${JSON.stringify(assetFromSrc)};`,
  sliceFn('fmtTime'),
  sliceFn('cmpVersion'),
  sliceFn('previewPlan'),
  sliceFn('stableUpdateMessage'),
  'return { fmtTime: fmtTime, cmpVersion: cmpVersion, previewPlan: previewPlan, stableUpdateMessage: stableUpdateMessage };',
].join('\n'))();

const cmpVersion = assembled.cmpVersion;
const previewPlan = assembled.previewPlan;
const stableUpdateMessage = assembled.stableUpdateMessage;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name} —— ${err && err.message}`);
    process.exitCode = 1;
  }
}

/* ---------- cmpVersion：只认数字段 ---------- */

check('cmpVersion 线上更高时返回 1', () => {
  assert.strictEqual(cmpVersion('1.3.1', '1.3.0'), 1, `读回 ${cmpVersion('1.3.1', '1.3.0')}`);
});

check('cmpVersion 段数不齐时按补零算相同', () => {
  assert.strictEqual(cmpVersion('1.3', '1.3.0'), 0, `读回 ${cmpVersion('1.3', '1.3.0')}`);
});

check('cmpVersion 线上更低时返回 -1', () => {
  assert.strictEqual(cmpVersion('1.2.9', '1.3.0'), -1, `读回 ${cmpVersion('1.2.9', '1.3.0')}`);
});

/* ---------- previewPlan：六格各占一格，谁都不许合并 ---------- */

const ZIP = assetFromSrc;
const relWith = (version, extra) => Object.assign({
  name: `预览版 ${version} experimental b20261125-1730`,
  tag_name: 'preview',
  assets: [{ name: ZIP, updated_at: '2026-11-25T09:00:00Z' }],
}, extra || {});
const LOCAL_131 = { version: '1.3.1', name: '1.3.1', builtAt: 1730000000000 };

check('previewPlan 没问到那一格交 ask-failed（404 与断网同形，不许说话）', () => {
  assert.deepStrictEqual(previewPlan(null, false, LOCAL_131, '1.3.1'), { speak: false, why: 'ask-failed' });
  assert.strictEqual(previewPlan(relWith('1.3.2'), false, LOCAL_131, '1.3.1').why, 'ask-failed');
});

check('previewPlan 读不出号那一格交 no-version', () => {
  const noNum = { name: '预览版（还没写号）', tag_name: 'preview', assets: [{ name: ZIP }] };
  assert.strictEqual(previewPlan(noNum, true, LOCAL_131, '1.3.1').why, 'no-version');
});

check('previewPlan 没有预览包那一格交 no-asset（点了会下到 404 页）', () => {
  const wrongName = { name: '预览版 1.3.2', tag_name: 'preview', assets: [{ name: 'omitone.zip' }] };
  assert.strictEqual(previewPlan(wrongName, true, LOCAL_131, '1.3.1').why, 'no-asset');
  assert.strictEqual(previewPlan({ name: '预览版 1.3.2', tag_name: 'preview' }, true, LOCAL_131, '1.3.1').why, 'no-asset');
});

check('previewPlan 与正式版同号那一格交 same-as-stable（旧实验包不许再劝人装）', () => {
  assert.strictEqual(previewPlan(relWith('1.3.1'), true, LOCAL_131, '1.3.1').why, 'same-as-stable');
  assert.strictEqual(previewPlan(relWith('1.3.0'), true, { version: '1.2.9', name: '1.2.9', builtAt: 1 }, '1.3.1').why, 'same-as-stable');
});

check('previewPlan 不比本地新那一格交 not-newer（已经装了这一支的人不再被告知）', () => {
  assert.strictEqual(previewPlan(relWith('1.3.2'), true, { version: '1.3.2', name: '1.3.2', builtAt: 1 }, '1.3.1').why, 'not-newer');
});

check('previewPlan 该说话那一格交 show 并把号与包时间带出来', () => {
  const plan = previewPlan(relWith('1.3.2'), true, LOCAL_131, '1.3.1');
  assert.deepStrictEqual(plan, { speak: true, why: 'show', version: '1.3.2', stamp: '2026-11-25T09:00:00Z' });
});

/* ---------- stableUpdateMessage：五格各说各话 ---------- */

const PREVIEW_LOCAL = { version: '1.3.2', name: '1.3.2 experimental b20261125-1730', builtAt: 1730000000000 };
const DEV_LOCAL = { version: '1.3.2', name: '1.3.2', builtAt: 1730000000000 };
const STABLE_LOCAL = { version: '1.3.1', name: '1.3.1', builtAt: 1730000000000 };

check('stableUpdateMessage 线上有新版：说出两个号并给出更新选择', () => {
  const r = stableUpdateMessage(1, '1.3.2', STABLE_LOCAL, false, 0);
  assert.strictEqual(r.offer, true, '有新版本却不给选择，那一格等于把话说了但不办事');
  assert.ok(r.text.includes('有最新版 1.3.2') && r.text.includes('本地 1.3.1'), `原话：${r.text}`);
});

check('stableUpdateMessage 同号但线上换了包：offer 为真且说出包时间', () => {
  const remoteAt = Date.UTC(2026, 10, 25, 1, 0, 0);
  const r = stableUpdateMessage(0, '1.3.1', STABLE_LOCAL, true, remoteAt);
  assert.strictEqual(r.offer, true, `同号换包不该静音，读回 offer=${r.offer}`);
  assert.ok(r.text.includes('线上的包比本地新'), `原话：${r.text}`);
  assert.ok(r.text.includes(fmtTimeOf(remoteAt)), `句子没带包时间（应当是 ${fmtTimeOf(remoteAt)}）：${r.text}`);
});

/** 这里自己算一遍时间，是为了证明那句话里的时间是**读回来的**，不是写死在断言里的字符串。 */
function fmtTimeOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

check('stableUpdateMessage 本地是预览版：说实验支线，不许说成开发构建', () => {
  const r = stableUpdateMessage(-1, '1.3.1', PREVIEW_LOCAL, false, 0);
  assert.strictEqual(r.offer, false, '预览版那一格不许顺手劝人更新');
  assert.ok(r.text.includes('预览版') && r.text.includes('实验支线'), `原话：${r.text}`);
  assert.ok(r.text.includes('1.3.2') && r.text.includes('1.3.1'), `两个号都要在：${r.text}`);
  assert.ok(!r.text.includes('开发构建'), `预览版用户被说成开发构建了：${r.text}`);
});

check('stableUpdateMessage 本地是开发构建：说出高于线上，不许认成预览版', () => {
  const r = stableUpdateMessage(-1, '1.2.9', { version: '1.3.2', name: '1.3.2', builtAt: 1730000000000 }, false, 0);
  assert.strictEqual(r.offer, false);
  assert.ok(r.text.includes('高于线上 1.2.9'), `沙盒按「高于线上 + 线上号」认这一格，原话：${r.text}`);
  assert.ok(r.text.includes('开发构建'), `原话：${r.text}`);
  assert.ok(!r.text.includes('预览版'), `开发构建被说成预览版了：${r.text}`);
});

check('stableUpdateMessage 源码目录安装（无构建戳）：说本地安装，不许硬讲已是最新', () => {
  const r = stableUpdateMessage(0, '1.3.1', { version: '1.3.1', name: '1.3.1', builtAt: 0 }, false, 0);
  assert.strictEqual(r.offer, false);
  assert.ok(r.text.includes('本地安装') && r.text.includes('版本号与线上最新一致'), `原话：${r.text}`);
  assert.ok(!r.text.includes('你已经是最新版了'), `没有构建戳却宣布最新：${r.text}`);
});

check('stableUpdateMessage 同号且包没换：你已经是最新版了', () => {
  const r = stableUpdateMessage(0, '1.3.1', STABLE_LOCAL, false, 0);
  assert.strictEqual(r.offer, false);
  assert.strictEqual(r.text, '你已经是最新版了');
});

/* ---------- 卫生：判定只许有一份 ---------- */

check('旧那句把预览版与开发构建压成一体的话已退役，不再出现在 popup.js', () => {
  assert.ok(!text.includes('可能是实验版'), 'popup/popup.js 里还留着旧文案');
});

check('checkUpdate 只调一次 stableUpdateMessage，判定没有第二份', () => {
  const defs = (text.match(/function stableUpdateMessage\(/g) || []).length;
  const calls = (text.match(/=\s*stableUpdateMessage\(/g) || []).length;
  assert.strictEqual(defs, 1, `定义数 ${defs}`);
  assert.strictEqual(calls, 1, `调用数 ${calls}（写第二份判定就是这一格要拦的）`);
});

if (process.exitCode) {
  console.error(`更新提示判定表：${passed} 条通过，其余见上面的 [FAIL]`);
} else {
  console.log(`更新提示判定表：${passed} 项全绿（cmpVersion 3 / previewPlan 6 / stableUpdateMessage 6 / 卫生 2）`);
}
