# `src/page/` —— `page.js` 的源文件

**根目录的 `page.js` 是构建产物。** 它由这个目录下的片段按文件名排序拼成，
扩展真正加载的仍是根目录那一份（`content.js` 用 `chrome.runtime.getURL('page.js')` 注入，
`manifest.json` 的 `web_accessible_resources` 也列着它）—— 所以**路径、文件名、产物位置都没变**。

```bash
npm run concat          # 把 src/page/*.js 拼成根目录的 page.js
npm run concat:check    # 只校验产物与片段是否一致（npm test 里已经带了这一步）
```

> ⚠️ **改代码请改片段，然后跑 `npm run concat`。**
> 直接改根目录的 `page.js` 会「看起来生效、下次拼接全丢」—— 因为浏览器加载的正是根目录那份，
> 你改完立刻测是通的，直到有人再拼一次。`npm test` 里那条 `page.js 与 src/page/ 一致` 就是拦它的。

---

## 一句话地图

| 你要改什么 | 去哪个文件 |
| --- | --- |
| 视频、音频、倍速、seek、防拖拽 | [`40-media.js`](#40-mediajs) |
| 验证码（弹窗 / 整页） | [`50-captcha.js`](#50-captchajs) |
| 任务点识别、调度、主循环 `_runTick`、放弃名单、学习卡片切换 | [`60-tasks.js`](#60-tasksjs) |
| 讨论任务点 | [`65-discussion.js`](#65-discussionjs) |
| 答题流程、答案缓存、候选/避开错答、读图 | [`70-quiz-flow.js`](#70-quiz-flowjs) |
| 抠题、填答、提交确认弹窗 | [`75-quiz-dom.js`](#75-quiz-domjs) |
| 视频内嵌弹题、「继续学习」提示 | [`80-popup-quiz.js`](#80-popup-quizjs) |
| **状态字段**（`configs`、所有 `_xxx`） | [`10-config-state.js`](#10-config-statejs) |
| 跨域 iframe 安全访问、DOM 工具 | [`20-dom.js`](#20-domjs) |
| 日志与诊断文案 | [`30-log.js`](#30-logjs) |
| 常量、配置默认值、日志出口、启动 | [`00-shell-constants.js`](#00-shell-constantsjs) · [`90-console-api-startup.js`](#90-console-api-startupjs) |

三条好记的规则：

- **所有非方法属性都在 `10-config-state.js`**（状态字段、`configs`、`_cellData`、`_questionSelectors`）
- **所有 `_log*` / `_describe*` / `_diagnose*` 都在 `30-log.js`**
- 抠题 / 填答 / 提交确认这一整块在 `75-quiz-dom.js`（`_questionSelectors` 起、`_handleSubmitConfirmDialog` 止）

要找方法定义，别通读：

```bash
grep -nE '^    _?[A-Za-z][A-Za-z0-9_]*: (async )?function' src/page/*.js
```

---

## 这 12 个片段各自负责什么

行数是片段文件的实际行数（含头部注释），方法数是脚本从片段里数出来的。

### `00-shell-constants.js`（244 行）

IIFE 外壳、全部常量（`INSTANCE_ID` / `APP_NAME` / `DEFAULT_CONFIG` / 各种超时阈值）、
**运行日志出口 `emitRuntimeLog` 与日志缓冲**、桥接消息（`bridgeSend` / `bridgeCallbacks` /
`BRIDGE_TIMEOUT_MS`）、storage 读写、`mergeConfig` 等工具函数。

**本文件以 `var app = {` 结尾** —— 后面各域的属性块被拼在它下面。

> 加配置项的第一步（`DEFAULT_CONFIG`）在这里改，改完记得 `npm run concat`。

### `10-config-state.js`（400 行 / 4 方法 + 112 状态字段）

app 的入口与生命周期：`run` / `play` / `_assertActive` / `_resetRuntimeState`。
**以及全部非方法属性** —— `configs`、所有 `_xxx` 运行期状态、`_cellData`、`_questionSelectors`。

这条规则是刻意设计的：**找状态字段就来这一个文件**，不用在十几个文件里猜。

### `20-dom.js`（380 行 / 21 方法）

跨域安全访问的**唯一入口**：`_safeDocOf` / `_safeWinDoc` / `_isFrameSameOrigin`
（⚠️ **永远不要裸读跨域 iframe 的 `.document`** —— 抛出的 `SecurityError` 会静默打断整个 tick 循环，
是本项目最难查的一类 bug）；主文档 / 主窗口、遍历 frame 与 document、超时包装 `_withTimeout`、
后台 Worker、可见性绑定。

### `30-log.js`（265 行 / 8 方法）

把状态转成「给人看的一行字」的辅助方法。规则：**所有 `_log*` / `_describe*` / `_diagnose*` 都在这里**。
真正的日志出口 `emitRuntimeLog` 在外壳文件。

### `40-media.js`（1095 行 / 42 方法）

视频元素查找与事件处理（播放 / 暂停 / 结束 / 出错修复 `_maybeRepairMediaSource`）、
倍速探测与钳制（`_ensurePlaybackRate` / `_probeMaxPlaybackRate`）、seek 到结尾 `_trySeekToEnd`、
90% 提前结束、防拖拽、音频保活、PPT 内音频等待。

### `50-captcha.js`（478 行 / 14 方法）

验证码弹窗的检测、取图与识别；整页验证码模式（`_runStandaloneCaptchaMode`）。

### `60-tasks.js`（2567 行 / 69 方法）

最重的一块：从页面里找出「这一章还有哪些任务点没做」（附件 / iframe / OCS 搜索）、
任务点执行与等待、文档类任务点（翻页 / 滚动）、**主 tick 循环 `_runTick` / `_tick`**
（⚠️ 判定顺序＝仲裁顺序，改它是高风险操作）、学习卡片（小节）切换、做不完的任务点放弃名单。

⚠️ `_getAttachmentWorkType` 的判断顺序不能动（`isPassed` → `job:true` → `job:false` → 模块名推断）；
`_isJobCompleted` 拿不准时必须返回 `true`（它喂给"放弃"计数，误判会把必做任务点跳过）。

### `65-discussion.js`（766 行 / 27 方法）

讨论任务点的查找、编辑、提交，以及「已做过」的本地去重。
讨论任务点不在课程 iframe 内，点开会跳到独立讨论页 —— 所以它有一整套自己的页面判定与流程。

### `70-quiz-flow.js`（2248 行 / 87 方法）

答题的流程与状态：`_handleQuiz`（整卷主流程）、提交前后监控、按提交次数跳过、
**答案缓存**（正确 / 错误 / 已提交答案的读写与规范化）、候选答案与组合排序、
避开已知错答、尽力而为的填充、乱选模式，以及**读图（视觉）**：取图、描述、并回题目、预算控制
（`_takeVisionBudget` 是烧钱的安全阀）。

### `75-quiz-dom.js`（1365 行 / 39 方法）

抠题与填答：从 DOM 里抠题干与选项、判定题型、单选 / 多选 / 判断 / 填空的填答实现、
提交按钮与站点确认弹窗（`#workpop` / `#popok`）的处理。

> `_questionSelectors`（选择器真源）在 `10-config-state.js` —— 因为所有非方法属性都在那儿。

### `80-popup-quiz.js`（568 行 / 11 方法）

视频内嵌弹题（弹窗题）的检测、填答、失败计数与放弃；
「继续学习」提示按钮（不点它进不去正常播放页）。

### `90-console-api-startup.js`（234 行）

**本文件以 `};` 开头**（闭合 app 对象字面量），随后是 `window.xxtAI` 控制台入口与启动逻辑。

⚠️ `window.xxtAI` 是**给用户的手动调试入口**（`skipQuiz` / `diagnosePopup` / `taskGiveUpList` /
`clearTaskGiveUp` / `scanQuiz` 等），**必须保留** —— 有些方法"看起来没人调用"，其实是被用户手动调的。

---

## 拼接机制（`tools/concat-page.js`）

1. 按**文件名排序**读 `src/page/*.js`（文件名前缀 `00` / `10` / … / `90` 就是顺序）。
2. 每段丢弃**头部注释**：从文件开头到标记行 `// @omitone-part-header-end`（含）全部丢掉。
   找不到标记就报错退出 —— 否则整份头部会被当成代码写进 `page.js`。
3. 各段正文接回去，写出根目录 `page.js`（换行符沿用片段里的实际值，本仓库是 `\r\n`）。

因为 `00-` 以 `var app = {` 结尾、各域文件是属性块、`90-` 以 `};` 开头，
拼出来就是一个完整的对象字面量。

改动片段时的三条注意：

- **别动头部结束标记那一行**，也别在头部之外再写一个（拼接脚本会报错）。
- **域文件的每一项都必须以逗号结尾** —— 否则把这一项挪到别处就会拼出语法错误。
- 片段**不是独立的 JS**，单独看必然语法错误。所以 `tools/check.js` 把 `src/` 排除在
  语法扫描之外；真正兜底的是 `npm test` 里的 `page.js 与 src/page/ 一致`。

---

## 这次拆分是怎么做的（以及为什么可以信）

拆分前：`page.js` 是 **9899 行 / 330 个方法**的一个大对象字面量，**没有按域排列**
（每个域都横跨全文，例如"答题"类方法分布在 586–9860 行），也**没有任何分段注释**。

分两步走，**先零风险、再有风险**：

**阶段一 —— 按物理行切分（只切不改）。**
验收标准是**拼接产物与拆分前逐字节相同**（`cmp` 无输出，sha256 `fd20baa1…`）。
这一步把"多文件 + 拼接"的机制建起来，而完全不触碰行为 —— 于是有了一条随时可回退的基线。

**阶段二 —— 按域重组（就是现在这个布局）。**
把 330 个方法按域重新分组。这一步**改不了字节相同那条基线**（方法换了位置，字节必然变），
所以它靠的是另外两条证据：

1. **属性与行级的多重集比对**：重组前后 app 对象里 **434 个属性名完全一致**
   （无缺失、无重复），且 app 体里 **8644 行有效行一行不多一行不少** —— 证明只是换了位置。
2. **测试兜底**：`npm test` 全绿 + `npm run e2e` **26 个场景 / 280 项全绿**（真实 Edge）。

重组用的是一次性脚本，已经删掉；**拼接脚本 `tools/concat-page.js` 是长期保留的**。

---

## 还没做的

- `60-tasks.js`（2567 行）和 `70-quiz-flow.js`（2248 行）仍然偏大 —— 它们各自还可以再分
  （例如 tasks 里的「文档任务点」、quiz 里的「答案缓存」）。要分就**一次只搬一个子域、
  搬完立刻跑 `npm run e2e`**。
- 原始执行说明见 [`docs/pagejs-拆分提示词.md`](../../docs/pagejs-拆分提示词.md)（阶段一那节已完成，别再重做）。

搬的时候记住 `AGENTS.md` §2 的硬性约束 —— 尤其：
`_getAttachmentWorkType` 的判断顺序不能动、`_isJobCompleted` 拿不准必须返回 `true`、
`_runTick` 的判定顺序就是仲裁顺序、`window.xxtAI` 是给用户的手动调试入口。
