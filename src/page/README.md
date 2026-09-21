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
| **任务点识别**（找这一章还有哪些没做、附件/iframe/OCS 搜索） | [`60-tasks-detect.js`](#60-tasks-detectjs) |
| **任务点执行**（跑视频/阅读/PPT音频、文档类任务点翻页/滚动） | [`62-tasks-run.js`](#62-tasks-runjs) |
| **主循环 `_runTick`**、放弃名单、学习卡片切换 | [`64-tasks-loop.js`](#64-tasks-loopjs) |
| 讨论任务点 | [`65-discussion.js`](#65-discussionjs) |
| **答题整卷流程**、抠题、提交监控、按提交次数跳过 | [`70-quiz-flow.js`](#70-quiz-flowjs) |
| **答案缓存**、规范化、候选/避开错答 | [`72-quiz-answers.js`](#72-quiz-answersjs) |
| **读图（视觉）**、`_takeVisionBudget` 预算闸门 | [`74-quiz-vision.js`](#74-quiz-visionjs) |
| 填答（单选/多选/判断/填空）、提交确认弹窗 | [`75-quiz-dom.js`](#75-quiz-domjs) |
| 视频内嵌弹题、「继续学习」提示 | [`80-popup-quiz.js`](#80-popup-quizjs) |
| **状态字段**（`configs`、所有 `_xxx`） | [`10-config-state.js`](#10-config-statejs) |
| 跨域 iframe 安全访问、DOM 工具 | [`20-dom.js`](#20-domjs) |
| 日志与诊断文案 | [`30-log.js`](#30-logjs) |
| 常量、配置默认值、日志出口、启动 | [`00-shell-constants.js`](#00-shell-constantsjs) · [`90-console-api-startup.js`](#90-console-api-startupjs) |

三条好记的规则：

- **非方法属性基本都在 `10-config-state.js`**（`configs`、`_cellData`、`_questionSelectors`、
  以及 115 个运行期状态字段）—— 但有约 30 个字段是**惰性初始化**的，不在那个声明表里，见下方说明
- **所有 `_log*` / `_describe*` / `_diagnose*` 都在 `30-log.js`**
- 抠题 / 填答 / 提交确认这一整块在 `75-quiz-dom.js`（`_questionSelectors` 起、`_handleSubmitConfirmDialog` 止）

> ⚠️ **关于"状态字段都在一个文件里"这句 —— 别当成字面承诺。**
> 实测（`node tools/audit-fields.js`）：`10-config-state.js` 声明了 **119** 个属性，
> 另有约 **30** 个字段是**用到才建**的，两种写法：
> - `if (!this._x) this._x = Object.create(null);`（`_seekTriedKeys` / `_taskGiveUpLogged` / `_mainFrameCrossOriginSince`）
> - 读取处自带 `|| 0` 兜底（`if (now - (this._blockedReloadAt || 0) > 180000)`）
>
> 这是**刻意的**：惰性初始化不会被"某处忘了复位"弄坏，比依赖声明初值更抗错。
> 代价是**找字段时不能只看 `10-config-state.js`** —— 用 `tools/audit-fields.js` 可以列出全量，
> 或直接 `grep -rn "this\._字段名" src/page/`。
> （本次审计已把主循环的 `_tickRunning` / `_tickStartedAt` / `_tickEpoch` 三个补进声明表 ——
> 它们是主循环的控制状态，值得一眼可见。）

任务点与答题各自有三个文件，按**「识别 → 执行 → 循环」**和**「流程 → 答案 → 读图」**分，
顺序就是文件名前缀：**要改调度看 `60/62/64`，要改答题看 `70/72/74`。**

要找方法定义，别通读：

```bash
grep -nE '^    _?[A-Za-z][A-Za-z0-9_]*: (async )?function' src/page/*.js
```

---

## 这 16 个片段各自负责什么

行数是片段文件的实际行数（含头部注释），属性/方法数是脚本从片段里数出来的
（全仓合计 **492 个属性 = 330 个方法 + 162 个状态/配置字段**）。

### `00-shell-constants.js`（244 行）

IIFE 外壳、全部常量（`INSTANCE_ID` / `APP_NAME` / `DEFAULT_CONFIG` / 各种超时阈值）、
**运行日志出口 `emitRuntimeLog` 与日志缓冲**、桥接消息（`bridgeSend` / `bridgeCallbacks` /
`BRIDGE_TIMEOUT_MS`）、storage 读写、`mergeConfig` 等工具函数。

**本文件以 `var app = {` 结尾** —— 后面各域的属性块被拼在它下面。

> 加配置项的第一步（`DEFAULT_CONFIG`）在这里改，改完记得 `npm run concat`。

### `10-config-state.js`（400 行 / 4 方法 + 115 状态字段）

app 的入口与生命周期：`run` / `play` / `_assertActive` / `_resetRuntimeState`。
**以及绝大部分非方法属性** —— `configs`、115 个 `_xxx` 运行期状态、`_cellData`、`_questionSelectors`。

**但不是全部**：另有约 30 个字段是"用到才建"的（`if (!this._x) …` 或读取处 `|| 0` 兜底），
详见文件顶部「三条好记的规则」下面那段说明。要列全量用 `node tools/audit-fields.js`。

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

### `60-tasks-detect.js`（1027 行 / 25 方法）

任务点的**识别与搜索**：从页面里找出「这一章还有哪些任务点没做」—— 附件列表、iframe 探测、
任务点分类（`_classifyTaskFrame`）、把识别结果拼成可执行的 job
（`_buildAttachmentOnlyJob` / `_buildSyntheticChaoxingJob` / `_buildFrameFallbackJob`）、
OCS 风格的任务点搜索（`_searchChaoxingJobOcs` / `_ensureOcsStudyRunner`）、「已完成」状态识别。

⚠️ `_getAttachmentWorkType` 的判断顺序不能动：`isPassed` → `job:true` → `job:false` → 模块名推断。

### `62-tasks-run.js`（797 行 / 16 方法）

任务点的**执行与等待**：把识别出的 job 真正跑起来（视频 / 阅读 / PPT 音频 / OCS 式学习
`_runChaoxingJob` / `_runChaoxingReadJob` / `_runPptAudioJob` / `_runOcsStyleStudy`）、
任务点等待与 pending 处理（等它加载完 `_isTaskStillLoading`、等它出成绩 `_handlePendingTask`）、
**文档类任务点**：翻页式 / 滚动式的定位与完成判定
（`_locateDocumentTask` / `_buildPagedDocumentTask` / `_buildScrollDocumentTask` / `_handleDocumentTask`）。

### `64-tasks-loop.js`（709 行 / 28 方法）

**主 tick 循环 `_runTick` / `_tick`**（⚠️ 它的判定顺序就是仲裁顺序，改它是高风险操作）、
任务点完成度快照与「做不完就放弃」名单（`_taskGiveUpMap` / `_markTaskGivenUp` / `_countTaskIncomplete`）、
章节内学习卡片（小节）的定位与切换、下一步推进（`nextUnit` / `_advanceLearningStep`）。

⚠️ `_isJobCompleted` 拿不准时必须返回 `true` —— 它喂给"放弃"计数，误判成"没完成"会把必做任务点跳过。

### `65-discussion.js`（766 行 / 27 方法）

讨论任务点的查找、编辑、提交，以及「已做过」的本地去重。
讨论任务点不在课程 iframe 内，点开会跳到独立讨论页 —— 所以它有一整套自己的页面判定与流程。

### `70-quiz-flow.js`（1042 行 / 43 方法）

答题的**整卷流程与状态**：`_handleQuiz`（整卷主流程）、抠出题目清单（`_extractQuestions` /
`_extractFromDocument`）、识别是否在答题页（`_detectQuiz`）、
提交前后：提交嗅探与提交监控（`_installSubmitSniffer` / `_monitorQuizSubmit`）、
要不要在进入下一节前 hold 住（`_shouldHoldQuizBeforeNext`）、
按提交次数跳过（`_shouldSkipQuizBySubmitAttempts` / `_forceSkipQuizAfterMaxAttempts`）、
API 不可用时的退避与跳过、乱选模式（`_isRandomAnswerMode` / `_buildRandomQuizAnswers`）、
重做（redo）弹窗的处理（`_prepareQuizRedoIfNeeded`）。

### `72-quiz-answers.js`（978 行 / 39 方法）

**答案本身**的处理（与"流程"分开）：答案缓存的读写（正确答案 / 已知错答 / 已提交答案
`_loadQuizCorrectAnswerCache` / `_rememberCorrectQuizAnswers` / `_addWrongQuizAnswer`）、
答案的规范化与比对（`_canonicalQuizAnswer` / `_getQuizTitleKeyFromElement`）、
候选答案与组合排序（`_getChoiceCandidateAnswers` / `_generateChoiceCombinations` / `_sortMultiFallbackCombos`）、
避开已知错答（`_avoidKnownWrongAnswer`）、尽力而为的填充（`_fillBestEffortQuizAnswers`）、
按缓存填充（`_fillCachedQuizAnswers`）。

> 想知道"这题为什么选了这个答案"，从这里入手；想知道"这一卷为什么还没提交"，去 `70-quiz-flow.js`。

### `74-quiz-vision.js`（175 行 / 5 方法）

**读图（视觉）**：把题目里的图片取出来（`_collectQuestionImages`）、交给视觉模型描述、
再把描述并回题干（`_applyVisionToQuestions` / `_mergeVisionIntoTitle`）。

⚠️ `_takeVisionBudget` 是**烧钱的安全阀**：预算耗尽必须停并写 warn 日志，绝不静默。
图片走独立请求 —— 塞进答题链的长前缀会让缓存全失效，反而更贵。

### `75-quiz-dom.js`（1365 行 / 39 方法）

抠题与填答：从 DOM 里抠题干与选项、判定题型、单选 / 多选 / 判断 / 填空的填答实现、
提交按钮与站点确认弹窗（`#workpop` / `#popok`）的处理。

> `_questionSelectors`（选择器真源）在 `10-config-state.js` —— 它是"声明式"的非方法属性，都在那儿。

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

**阶段二 —— 按域重组。**
把 330 个方法按域重新分组，得到 12 个域片段。这一步**改不了字节相同那条基线**
（方法换了位置，字节必然变），所以它靠的是另外两条证据：

1. **属性与行级的多重集比对**：重组前后 app 对象里 **434 个属性名完全一致**
   （无缺失、无重复），且 app 体里 **8644 行有效行一行不多一行不少** —— 证明只是换了位置。
2. **测试兜底**：`npm test` 全绿 + `npm run e2e` **26 个场景 / 280 项全绿**（真实 Edge）。

**阶段三 —— 把两块最重的再细分（就是现在这 16 个）。**
`60-tasks.js`（2567 行）拆成 `60/62/64`，`70-quiz-flow.js`（2248 行）拆成 `70/72/74`，
判据仍是同一套，只是比对对象换成"细分前的片段"：

1. **属性名 492 个完全一致**，且 app 体**非空行 9055 行完全一致**（多重集比对）。
2. **测试兜底**：`npm test` 全绿 + `npm run e2e` **26 个场景 / 280 项全绿**（真实 Edge）。

重组与细分用的都是一次性脚本，已经删掉；**拼接脚本 `tools/concat-page.js` 是长期保留的**。

> 细分顺带把 `60/62/64/70/72/74` 六个文件的块间空行从两个收敛成一个
> （其余 10 个片段仍是两个）—— 纯排版差异，非空行一行没动。看着不一致是正常的。

---

## 还没做的

- 剩下最大的三个片段是 `75-quiz-dom.js`（1365 行）、`40-media.js`（1095 行）、
  `70-quiz-flow.js`（1042 行）。还能再分，但收益已经明显变小 ——
  真正"一个域横跨上千行"的问题已经解决了。
  真要分就**一次只搬一个子域、搬完立刻跑 `npm run e2e`**。
- 原始执行说明见 [`docs/pagejs-拆分提示词.md`](../../docs/pagejs-拆分提示词.md)（三个阶段都已完成，别再重做）。

搬的时候记住 `AGENTS.md` §2 的硬性约束 —— 尤其：
`_getAttachmentWorkType` 的判断顺序不能动、`_isJobCompleted` 拿不准必须返回 `true`、
`_runTick` 的判定顺序就是仲裁顺序、`window.xxtAI` 是给用户的手动调试入口。
