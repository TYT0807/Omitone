# Omitone

学习通（chaoxing）课程页面的浏览器自动化扩展。Manifest V3，面向 Edge / Chrome。
**零依赖、零构建** —— 改完源码在 `edge://extensions` 点一次「重新加载」即可生效。

版本 **1.0.11** · 变更记录 [`CHANGELOG.md`](CHANGELOG.md)

---

## 给接手的人 / AI：先看这里

这份 README 是**完整交接文档**。按下面的顺序读，不要通读 `page.js`（约 7600 行 / 290 个方法）：

| 你要做的事 | 直接跳到 |
| --- | --- |
| 先跑起来看看现状 | [§1 功能与验证状态](#1-功能与验证状态) · [§10 开发命令](#10-开发命令) |
| 用户报了个 bug，要先定位 | [§3 诊断入口](#3-出问题时先跑这几句) · [§7 症状→病因](#7-调试手册症状--病因--查哪里) |
| **准备改代码**（必读） | [§4 运行机制](#4-运行机制三层环境与调度) · [**§5 代码易纠缠点**](#5-️-代码易纠缠点改之前必读) |
| 改的时候怕踩坑 | [**§6 易错点清单**](#6-️-易错点清单每条都真实踩过) |
| 想加一个配置开关 | [§9 新增配置项清单](#9-新增配置项的完整清单) |
| 想动提示词 / 省 token | [§11 提示词与 token](#11-提示词与-token) |

**三条最容易踩的硬规则**（违反会出事，详见 §5 §6）：

1. 改完必须**刷新学习通页面**（只重载扩展不刷新 → 旧 content script 断连，症状是"功能全停"）
2. 删方法前先 grep 全部调用点（`npm run check` 有幽灵调用检查兜底）
3. 跨域 iframe **永远不要裸读 `.document`**（抛 `SecurityError`，会静默打断整个调度循环）

### 文档地图

| 文件 | 内容 |
| --- | --- |
| **本文件** | **完整交接文档**：功能与验证状态、运行机制、**易错点**、**代码纠缠点**、调试手册、改哪里 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 更深的协议细节：消息协议全表、storage 键、index 语义、失败分类、各条链路的实现要点、已知限制 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 的做事守则（不重复技术细节，只规定流程与硬性约束） |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么、为什么这么改 |
| [`tools/README.md`](tools/README.md) | 开发脚本说明 + **测试脚手架的全部踩坑记录** |
| [`legacy/README.md`](legacy/README.md) | 为什么那些代码被停用、为什么不能接回去 |

---

## 1. 功能与验证状态

「自动化验证」列指 `npm run e2e`（真实 Edge + 14 个场景，135 项断言）覆盖到哪一步。
**标 ⚠️ 的部分必须到真实课程页人工确认** —— mock 页面无法替代真实平台的编解码、加密字体与任务点结构。

| 功能 | 做什么 | 验证环节 | 自动化验证 |
| --- | --- | --- | --- |
| **视频 / 音频自动播放** | 自动开播；被暂停后自动抢回；播完自动翻节 | 媒体查找、播放控制 | ⚠️ 真实编解码需人工 |
| **自动最大倍速** | 读播放器倍速菜单取上限（读不到就逐档试探） | 倍速应用、上限约束 | ⚠️ 菜单读取需真实播放器 |
| **拖到结尾** | 可拖动视频直接 seek 到 `duration - 3s`，每个视频只试一次 | 时机判断、开关生效 | ✅ |
| **静音播放** | 视频静音；音频默认静音 + 最高倍速 | 配置 → 元素属性 | ✅ |
| **PPT / 文档 / 图片** | 翻页、上报 `finishJob`、等页内音频播完 | — | ⚠️ 需真实任务点 |
| **AI 答题** | 单选 / 多选 / 判断 / 填空 / 简答 / 弹窗题 | 抠题 → 提示词 → 模型 → 回填 DOM | ✅ 5 种题型全链路 |
| **答案缓存** | 交卷后记住正确答案，下次不再问模型 | 对错判定、写入与读回 | ✅ |
| **验证码（弹窗）** | 课程页弹窗验证码：抓图 → 视觉模型 → 填入提交 | 命中检测、结果清洗 | ✅ |
| **验证码（独立网址）** | 验证码是独立页面时同样处理，处理完自动返回 | 页面判定、抓图 | ✅ |
| **讨论任务点** | 跳转讨论区 → 发评论 → 返回继续刷课 | 页面识别、控件定位 | ✅ 定位需真实 DOM 复核 |
| **多讨论任务点** | 同一章节多张讨论卡片各自独立处理，互不顶掉 | 同文档多卡片、去重键唯一性、已完成标志归属 | ✅ |
| **题库字体反爬** | 解析 `font-cxsecret` 自定义字体，按字形哈希还原题目文本 | — | ⚠️ 需真实加密字体 |
| **后台节流对抗** | Worker 心跳 + 音频保活 + `pause` 抢播，最小化后仍推进 | — | ⚠️ 需人工长时观察 |
| **跳过不必做的任务点** | 老师没设为任务点的内容（`job:false`）直接跳过；反复做不完的记录后放弃 | `job:false` 判据、进度快照、放弃名单 | ✅ |
| **设置弹窗** | 配置读写、接入方式预设、API 连通性检测 | 依赖加载、地址构造、初始化 | ✅ |
| **题目扫描诊断** | 扫不到题时输出可定位的诊断报告 | 报告内容与线索 | ✅ |

### 支持的学习通任务类型

任务点靠 `module` 字段区分。判定顺序**不能改**（见 [§5.7](#57-jobfalse--isPassed--字段缺失--必须保留的判断顺序)）：

| 任务点类型 | module | 处理方式 |
| --- | --- | --- |
| 视频 | `insertvideo` | 媒体流程（播放、倍速、静音、拖尾） |
| 音频 | `insertaudio` | 同一套媒体流程；播放器把 audio 藏起来时也能找到 |
| 文档 | `insertdoc`（pdf / ppt / docx / innerbook） | 阅读流程：翻页 / 滚动 / 上报完成 |
| 图片 | `insertimage` | 按阅读处理（打开即算） |
| 测验 · 作业 · 考试 | `work` / `exam` | 答题流程 |
| 讨论 | `insertbbs` | 独立模块：跳转发评论再返回 |
| 超链接 | `link` | 点开即可（`enableHyperlink`） |
| **投票** | `insertvote` | **不支持** —— 运行日志会留 `unsupported task point type` |
| **直播** | `insertlive` | **不支持**，同上 |

---

## 2. 安装与使用

```bash
npm run build        # 产物：dist/omitone-1.0.11/
```

打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 `dist/omitone-1.0.11/`。
也可以直接加载仓库根目录（跳过打包）。

> 扩展详情里会显示「在所有网站上运行」，这是**必需的**：验证码有时是与学习通无关的独立网址，
> 注入范围必须覆盖它。平时在无关网站上它立即静默退出，不做任何事。

1. 点扩展图标 → 填 API URL / Key / 模型名（或从「接入方式」选预设）
2. 点「检测 API 连接」确认通路
3. 要用验证码识别的话，**必须**另填「验证码识别模型」，且必须是支持图片输入的视觉模型
4. 打开学习通课程页 → 点「开始运行」

**改完代码的固定动作**：`npm test` 全绿 → 同步版本号三处 → `edge://extensions` 重新加载 →
**刷新学习通页面（F5）**。

---

## 3. 出问题时先跑这几句

在学习通页面按 F12，控制台执行：

```js
xxtAI.diagnose()        // 题目扫描诊断：每个 iframe 命中了什么选择器、为什么没抠出题、下一步该查什么
xxtAI.scanQuiz()        // 只跑一次抠题并打印结果（不答题、不提交）
xxtAI.taskGiveUpList()  // 哪些任务点被判定"做不完"而放弃了（含原因、次数、加入时间）
xxtAI.clearTaskGiveUp() // 清空放弃名单，让插件重新尝试这些任务点
xxtAI.next()            // 手动跳到下一节
xxtAI.skipQuiz()        // 手动跳过当前答题
xxtAI.reload()          // 重新从 storage 拉配置并显示面板
```

`diagnose()` 的 `hint` 字段直接告诉你断在哪一环：

| hint | 含义 | 下一步 |
| --- | --- | --- |
| 没命中任何题目选择器 | 不是测验页 / 题目在跨域 iframe / 改版换了类名 | 要用户提供该页 URL 与诊断输出 |
| 选择器有命中但容器全被过滤 | `_collectQuestionContainers` 的可见性/文本过滤过严 | 看 `samples[].cls` 实际是什么 |
| 容器找到了但 `_parseQuestionElement` 全返回 null | 题干与选项都没抠出来 | 补 `titleSelectors` / `_getOptionItems` |

**完整日志**在 popup →「查看日志」（`chrome.storage.local.runtimeLogs`，最近 200 条）；
页面右下角状态浮窗只有约 220 字符摘要，想让它显示新关键字要去 `content.js`
的 `runtimeLogToStatus` 加映射，否则只进不显。

---

## 4. 运行机制：三层环境与调度

### 4.1 三个执行环境

| 环境 | 文件 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| **隔离世界**（content script） | `content.js` + `libs/*` | 用 `chrome.*`、读 `localStorage`、注入脚本 | 拿不到页面自己的 `window` 对象 |
| **页面上下文**（page script） | `page.js` | 操作播放器、DOM、页面内 JS 变量 | **不能用 `chrome.*`** |
| **service worker** | `background.js` | 跨域 `fetch`、抓图转 dataURL | 不能碰页面 |

`page.js` 与扩展的通信全靠 `postMessage` 桥接：

```
page.js    --postMessage({source:'xxt_app',    type:'llm_request',  id})--> content.js
content.js --postMessage({source:'xxt_bridge', type:'llm_response', id})--> page.js
```

**两个方向都带 `source` 字段，是硬性要求** —— 过滤器靠它区分消息来源。
漏掉 `source` 会被静默丢弃，症状是"配置改了不生效"。

`libs/*.js` 由 `manifest.content_scripts.js` 数组按顺序在 `content.js` 之前注入；
popup 侧要单独写进 `popup/popup.html` 的 `<script>`。`npm run check` 会校验这两处。

### 4.2 主循环：单入口、有重入锁

`_startTickLoop` 每 250ms 调一次 `_runTick`，`_tickRunning` 保证上一轮跑完才开始下一轮，
150 秒的看门狗会强制释放卡死的锁。

推论：
- 任何 `await` 永久悬挂 = 整个循环死亡。**新增 `await` 必须可超时**
  （跨环境走 `bridgeSend`，自带 90 秒；`video.play()` 包 `this._withTimeout`）
- 别在 `_runTick` 里加"每次都要跑完"的重活，会拖慢整个心跳

`_runTick` 的判定顺序：

```
1. _isDiscussionContext()        ← 讨论页最优先
2. _isStandaloneCaptchaPage()    ← 独立验证码页
3. _checkCaptchaDialog()         ← 验证码：被挡住时其他动作都不该跑
4. _checkBlockedByCrossOrigin()
5. _handleDiscussionWait() / _tryDiscussionTask()   ← 必须早于视频，否则抢进度
6. _detectPageChange() → _skipIfCompleted()
7. _checkSubmitConfirmDialog() → _monitorQuizSubmit() → _checkPopupQuiz()
8. _ensureOcsStudyRunner() → _runOcsStyleStudy()    ← 刷课主体
9. 兜底：视频巡检 / 倍速守护 / 翻节
```

---

## 5. ⚠️ 代码易纠缠点（改之前必读）

**这一节是本项目历史上 bug 的主要来源**：绝大多数故障不是"某处写错了"，
而是**两条本来各自正确的代码路径互相抢**。改动前先搞清当前是谁在仲裁。

### 5.1 `_runTick` 的判定顺序就是仲裁顺序

具体为什么是这个顺序：

- **讨论页必须在最前**：否则它会被当成课程页，去"找任务点 → 跳章节"，把讨论标签页搞乱
- **验证码必须早于一切**：页面被验证码挡住时，检测到的 DOM 全是验证码的，继续跑会得到一堆错误判断
- **`_checkSubmitConfirmDialog` 必须在 `_checkPopupQuiz` 前面**：提交确认弹窗长得就像弹窗题
  （都用 `layui-layer`），顺序反了就会去"答"一个确认框
- **`_handleDiscussionWait` / `_tryDiscussionTask` 必须早于视频处理**：
  讨论任务点打开新标签页期间主循环要暂停推进，不能和正在播放的视频抢进度

**改 `_runTick` 顺序 = 高风险操作。**

### 5.2 已存在的"互斥开关"（别在不理解的情况下删）

| 字段 | 作用 |
| --- | --- |
| `_tickRunning` | tick 重入锁 |
| `_quizInProgress` | 答题进行中，防并发答题 |
| `_captchaBusy` / `_captchaActive` | **`_captchaActive` 期间抑制 `_checkVideoStatus` 与 pause 自动恢复** —— 验证码会让视频暂停，守护去"抢回播放"会跟验证码打架 |
| `_rateProbing` / `_rateDetectBusy` | 倍速探测期间**跳过倍速守护**，否则守护会把探测设的倍速立刻压回去；`_trySeekToEnd` 也在探测期间主动让路 |
| `_stepSwitchPending` | 翻节进行中，防重复翻节 |
| `_discussionPosted` | 保证每个讨论页只发一次评论 |
| `_pauseResumePending` | pause 抢播的防抖，避免"暂停↔恢复"无限战斗 |
| `_quizReadyToSubmit` / `_quizReadyWorkKey` | 表单填好待提交，避免重复走 LLM |
| `_activeMediaJobPending` / `_activeDocumentJobPending` | 阻断 `nextUnit`，等媒体/文档任务真正结束 |
| `_quizForceSkipUntil` / `_quizApiFailUntil` | **两个独立退避窗口**：前者是"解析失败，8 秒后重试"，后者是"API 不可用，45 秒后重试"。两者都 gate 答题，改一个记得看另一个 |
| `_discussionWindow` | 讨论标签页句柄；期间 `_handleDiscussionWait` 暂停推进 |

### 5.3 三个重载页面/清状态的地方会互相干扰

`_checkBlockedByCrossOrigin`（跨域卡住 → 刷新）、`_captchaReload`（验证码多次失败 → 刷新）、
`_refreshChapterAfterDiscussion`（讨论完成 → 刷新章节）都会重载或重建状态。
各自有冷却计时（180s / 计数器 / 讨论标记），**不要再加不相关的重载路径** ——
多个重载源叠加会变成"刷新风暴"，页面永远加载不完。

### 5.4 配置有三份默认值

| 位置 | 角色 |
| --- | --- |
| `page.js` `DEFAULT_CONFIG` | **运行时权威**（`mergeConfig` 以它为底） |
| `content.js` `configs` | 桥接层初始值，也会被 storage 覆盖 |
| `popup/popup.js` `DEFAULTS` | 设置界面初始值 |

配置下发是**推 + 拉两条路**：启动时 `bridgeSend('get_config')` 拉一次，
之后 storage 变化由 `content.js` 推 `XXT_CONFIG_UPDATED`。两边都会 merge，
新增配置项必须按 [§9](#9-新增配置项的完整清单) 逐处补齐。

### 5.5 答题输出协议：位置式数组

当前协议是**位置式数组** —— 第 n 个元素就是第 n 题的答案，没有 index、没有键名：

```
system: 答题。只输出JSON数组,长度=题目数,顺序一致,不解释不思考。
        s"A" m["A","C"] j true|false f/t"文本"(多空用|||按序连)
user:   1|s|题干\nA.选项\nB.选项\n\n输出:["A",["A","C"],true,"填空1|||填空2"]
```

三条不可动摇的约束：

1. **`normalizeItem` 必须把数组归到"位置式"那一类**。数组的 `typeof` 是 `object`，
   若被当成 `{a:…}` 包装对象解析，**多选题答案会被整条丢掉**。这是这段代码最容易改错的地方。
2. **长度不符不会误提交**。`content.js` 记 `llm answer count mismatch` 日志后按位置尽力对齐；
   没对上的题保持未填 → `_areQuizAnswersFilled` 为假 → 不提交 → 下一轮 tick 重试。
   属于可自愈的降级，**不要改成"猜一个补上"**。
3. **分批大小牵动 token，别随手改小**。system 与格式示例是每批重发的固定开销（约 88 token/批），
   题目正文只发一次。改 `CHUNK_SIZE` 前先看 `npm run bench` 的对比数字。

旧协议（`{"i":n,"a":…}` 与 `{"index":…,"answer":…}`）仍然兼容 —— 保留它是为了让
用户自定义 `systemPrompt`、或模型自作主张换格式时不至于解析失败。

### 5.6 答案形态要按题型规整

`content.js` 的 `coerceAnswerForType` 处理位置式输出的常见偏差：
单选收到 `["A"]` 解包成 `"A"`、判断题收到 `"正确"`/`"T"` 归一成 `true`。
**多选数组必须原样保留，不能被解包。**

不做这层规整的后果：形态不对 → `_matchOptionItem` 匹配不上 → 该题静默不填 →
表单不满 → 永不提交。属于"看起来像模型没答对、实际是协议没对上"的坑。

### 5.7 `job:false` / `isPassed` / 字段缺失 —— 必须保留的判断顺序

```js
// page.js: _getAttachmentWorkType
if (attachment.isPassed === true) return 'finished';   // ① 已通过优先于"是任务点"
if (attachment.job === true) return 'job';             // ② 显式是任务点
if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
  return 'not-job';                                    // ③ 显式不是任务点 → 跳过
}
if (/insertdoc|insertvideo|…/.test(module)) return 'job';  // ④ 只有字段缺失时才按模块名推断
```

三个顺序陷阱：

- **① 必须在 ② 之前**。`job:true` + `isPassed:true`（任务点已通过）时若先判 `job`，
  调用点看到 `'job'` 就直接开跑 —— **已经完成的任务点被重做一遍**，长视频尤其致命。
- **③ 必须在 ④ 之前**。老师没把视频设为任务点时接口给的是 `job: false`，
  它和"字段缺失"是两件事。漏掉 ③ 就会去"完成"一个不需要完成的任务点，白耗时间。
  判据来自开源实现 `cxmooc-tools` 的 `CxTask`：
  `if (taskinfo.job) { done = false } else { done = true }`（没有 job 标记就当作已完成）。
- **④ 只列"确定是任务点"的模块**，不要把 `insertimage` 加进来 —— 图片大多是正文内容，
  推断成任务点会让插件去"处理"一堆纯展示图片。真正带 `job:true` 的图片任务点由
  `_buildAttachmentOnlyJob` 处理。

同一判据在 `_buildAttachmentOnlyJob` 与 `_classifyTaskFrame`（帧数据里的 `"job":false`）
都要挡一道。

### 5.8 "做不完就放弃"机制：三条铁律

`taskGiveUpAttempts`（默认 4）控制"连续几次卡住就放弃"。配套规则：

1. **`_isJobCompleted` 拿不准时必须返回 `true`**（当作已完成）。
   它的返回值会喂给放弃计数，误判成"没完成"会把**必做任务点**跳过 —— 比多跑一次严重得多。
2. **只有"两次进度快照完全一致"才算卡住**（`_taskProgressSnapshot`）。
   长视频一次本来就跑不完，若按"没完成"计数，必做任务点会被误跳过。
   探测不到进度（快照为空）时**一律不计**。
   快照只对"有媒体"或"确实可滚动"的文档有意义 —— 否则不可滚动的页面会给出恒定的
   `scroll:0`，把"测不到"误当成"没进展"。
3. **放弃名单必须能被用户清掉**（`xxtAI.clearTaskGiveUp()`，24 小时 TTL）。
   静默地永久跳过用户的任务点不可接受；跳过时必须留日志说明"为什么"和"怎么恢复"。

### 5.9 讨论任务点：四个容易踩的点

1. **`#isFinished` 必须按卡片范围查找**，不能 `doc.getElementById` ——
   同一文档多张卡片会共用同一个"已完成"标志，导致批量漏做或反复重开同一个。
2. **向上找标志时必须先数卡片数量再读**。顺序反了就会在"多卡片共用容器"上读到共用值，
   原 bug 原样复发。
3. **去重键必须用 `mtopicid`**，不能用 `url.slice(-70)` —— 短 URL 相同就碰撞，
   第二个任务被 `_isDiscussionDone` 判成"24 小时内已处理"而永久漏做。
4. **`_markDiscussionDone` 是先于打开动作写的**（防止重复打开）。
   若一个入口都没打开成功，必须 `_unmarkDiscussionDone` 撤回 ——
   否则这个任务点被静默跳过 24 小时，日志里毫无线索。

---

## 6. ⚠️ 易错点清单（每条都真实踩过）

按"症状 → 根因 → 现在怎么防"整理，越靠前越贵。

| # | 症状 | 根因 | 现在的防线 |
| --- | --- | --- | --- |
| 1 | 日志停在某一条不再更新，但页面没卡 | tick 里某个 `await` 永久悬挂 | 看门狗（150s 强制解锁）；跨环境走带超时的 `bridgeSend`；`video.play()` 包 `_withTimeout` |
| 2 | 同上，但日志里什么都没有 | **裸读跨域 `iframe.contentWindow.document` 抛 `SecurityError`**，冒泡打断 `_runTick` | 一律走 `_safeDocOf(frame)` / `_safeWinDoc(win)`，内部 try/catch 返回 null |
| 3 | 答完题但**从不交卷** | `_resolveQuizAnswerDocument` / `_resolveQuizSubmitDocument` 在没有 `#iframe` 时返回 `null` → 填好的答案被判为空 | 两个函数末尾都有 `\|\| document` 兜底；`_resolveQuizSubmitDocument` 直接转发 `_resolveQuizAnswerDocument` |
| 4 | 扫不到题 / 题干是空的 | `.fontLabel` 里只有题号（`"1."`），旧实现拿到第一个命中的标题选择器就 `break`，剥掉序号后题干变空串 | 要求候选清洗后长度 ≥ 4，不合格继续试下一个选择器；退回容器文本并在第一个选项标记处截断 |
| 5 | 扫不到题（整页 0 题） | `_collectQuestionContainers` 命中即 `break`，过滤后为空则直接返回 0 题 | 挨个选择器试，谁第一个给出**过滤后非空**的结果就用谁 |
| 6 | 整个作业/考试页扫不到题 | 只认课程页的 `.TiMu`，漏了作业/考试的 `.Cy_TItle` 族 | 两套选择器都列在 `_questionSelectors` 与 `_titleSelectors` 里 |
| 7 | 选项文本混在一起 / 只有第一个选项 | 选项切分用 `[^\n]+`，而 `textOf()` 已把换行压成空格，于是从第一个选项标记一路吞到末尾 | 先定位所有选项标记，再按标记区间切分 |
| 8 | 答案填了却不提交 | `_getOptionItems` 返回内层 `<label>`，而 `qid` 挂在 `<li>` 上 → `_clickOptionItem` 取不到 qid → 隐藏域永远为空 | `<li>` 必须排在 `<label>` 之前；`_getQuizQuestionFilledValue` 在隐藏域为空时回退到可见控件 |
| 9 | 验证码功能整体失灵，日志无异常 | **删了 `_diagnoseBlockedPage` 但调用点留着** → `_checkCaptchaDialog` 每次抛 `TypeError`，4 处调用点只有 1 处包了 try/catch | `npm run check` 的**幽灵调用检查**（剥注释后比对 `this._x(` 与定义） |
| 10 | 多讨论任务点整批漏做 / 反复重开同一个 | `doc.getElementById('isFinished')` 让同文档的卡片共用"已完成"标志 | 按卡片范围查找，且**先数卡片再读标志** |
| 11 | 多讨论任务点第二个永远不做 | 去重键用 `url.slice(-70)`，短 URL 相同就碰撞 | 用 `mtopicid` 作键，取不到退回整站 URL 的哈希 |
| 12 | 不需要完成的任务点被白做一遍 | `job: false` 落到"按模块名推断"分支又变回 `job` | §5.7 的 ③ 必须排在 ④ 之前 |
| 13 | 已通过的任务点被重做一遍 | `isPassed` 排在 `job` 之后，返回 `'job'` 导致调用点直接开跑 | §5.7 的 ① 必须排在 ② 之前 |
| 14 | 多选题答案整条丢失 | 位置式数组 `["A","C"]` 的 `typeof` 是 `object`，被当成 `{a:…}` 包装对象解析 | `normalizeItem` 里 `Array.isArray(item)` 归到位置式那一类 |
| 15 | 必做任务点被静默跳过 | 按"没完成"计数放弃，而长视频一次本来就跑不完 | 只有"两次进度快照完全一致"才算卡住；`_isJobCompleted` 拿不准返回 `true` |
| 16 | 改了开关不生效 | `postMessage` 漏了 `source` 字段被过滤器丢弃；或只重载扩展没刷新页面 | 见 §4.1；改完必须 F5 |
| 17 | 某个开关"存了但读不到" | 新增配置项只加了 `DEFAULT_CONFIG`，没加消费点 / content / popup | 按 [§9](#9-新增配置项的完整清单) 逐处补齐 |
| 18 | 抽了公共模块后功能全挂，报 `Cannot read properties of null` | 忘了把新 lib 加进 `manifest.content_scripts` 或 popup.html | `npm run check` 会校验注入清单；`content.js` 有 `missingModuleError()` 给出可操作提示 |
| 19 | 提示词/地址构造行为不一致（弹窗测试通过、页面失败） | 同一段逻辑被复制成两份并各自演化 | `libs/prompt.js` 与 `libs/api-url.js` 是唯一真源，`npm run check` 强制 |
| 20 | 任务点被判 `not-job` 直接漏掉 | 扩展名正则写成 `\.(ppt\|mp4)$`，而真实 `property.type` 是 `"ppt"` 不带点 | 正则改成 `(?:^\|\.)(?:ppt\|…)$` |
| 21 | manifest 无法解析，报错里有个看不见的字符 | 编辑器写回了 UTF-8 BOM | `npm run check` 检测 + `node tools/fix-bom.js --write` |
| 22 | 选项文本剥不掉"选项"前缀 | GBK 乱码残留（`选项` 被写成 `閫夐」`） | `npm run check` 的编码损坏探测（只查非注释行） |
| 23 | 版本号在扩展详情/浮窗里对不上 | 版本号有三处（manifest / popup.html / content.js 品牌位），漏改一处 | `npm run check` 强制三处一致 |
| 24 | 改了半天没生效，回头发现改动被覆盖 | **并行编辑同一个文件会互相覆盖**（工具都报成功，只有最后一个生效）；本项目还有过外部编辑器用旧快照覆盖文件的历史 | 改同一文件多处必须**串行**，每次改完 grep 回读；批量改动用 `git diff` 复核 |
| 25 | 连跑两次测试，第二次"所有注入都失败" | 上一次的 Edge 被杀后调试端口未及时释放，新实例连到了正在退出的旧实例 | 收尾与启动前都会等端口释放（12 秒超时） |
| 26 | **章节卡住不动**，日志每 5 秒一轮 `study begin` + `quiz scan found 0 questions` | `_detectQuiz` 只看了章节标题：`if (title.indexOf('考试') !== -1) return true`，于是**名为「10.1 课程考试」的章节**（0 任务点、已完成）被判成"有测验"，`_isCurrentCompleted` 因此拒绝跳过 → 永久循环 | 判定必须有**证据**：标题命中之外，还要在 URL 链（`location.href` / 主 iframe src / 文档内所有 iframe src）里真的看到 `ananas/modules/work`、`exam/test`、`testpaper` 等作业/考试页特征 |
| 27 | **AI 完全不听题**，但密钥是填了的 | API 表单只有点「保存 API」按钮才落地，且 `apiType` 下拉**根本没有 change 监听** → 切了接入方式却不重填就没保存 → `apiKey` 为空 → `enableQuiz` 硬守卫跳过全部答题（症状是"读不到题"，很像扫描失败） | 输入类字段 800ms 防抖自动保存 + `apiType` 监听，并有 toast 提示 |
| 28 | 用 DeepSeek 时每道题先烧 ~200 个推理 token | DeepSeek V4 默认开启思考模式，而答题是纯模式化任务 | 请求体加 `thinking:{type:'disabled'}`（**只对 DeepSeek 加**，其他 OpenAI 兼容服务会对未知参数报 400）。实测 2 题从 361 → 133 token |
| 29 | 有一道题被**猜错**，然后整卷重答一遍 | 模型偶尔返回空答案，旧实现走 `_avoidKnownWrongAnswer` 的空答案兜底 —— 直接猜第一个选项。判断题猜错概率 50%，猜错就触发"整卷带 `禁:` 前缀重答" | **空答案补问**：一轮跑完还有题没收答案时，把这些题打包成一次小请求重问（`llm refill unanswered`），把"猜"换成"问" |
| 30 | `npm run e2e` **全线失败**：14 个场景都报「page.js 在真实 Edge 中加载成功：失败」，页面里却一条异常都没有 | 测试脚本按 `SHA256(目录路径)` 猜扩展 ID，而**路径大小写敏感**：`D:\Omite` → `hdlemlcmf…`（真），`d:\Omite` → `locncobd…`（假）。从 Git Bash 风格 cwd 启动 node，`__dirname` 的盘符变小写，ID 就错开了 —— 扩展其实加载得好好的，是测试自己拿着错 ID 去注入 | 改为**运行时发现**真实 ID（content script 的 `Runtime.executionContextCreated` → `origin`），路径哈希降级为兜底；发现不一致时会打印一行警告。详见 [AGENTS §7.2](AGENTS.md) |

---

## 7. 调试手册：症状 → 病因 → 查哪里

| 症状 | 先查 |
| --- | --- |
| AI 一直读不到题 | 三条线索依次排除：① 日志有没有 `quiz scan found 0 questions`（扫描失败，转 `xxtAI.diagnose()`）；② `enableQuiz` 是否被硬守卫跳过 —— 见 §6 #27（**表单没保存**是最常被忽略的原因）；③ 是否卡在某个标题含「作业/考试」的章节不动 —— 见 §6 #26 |
| 答案填了不提交 | `_areQuizAnswersFilled` 的判定；隐藏域 `#answer{qid}` 是否被写入 |
| 答题报「API 不可用」但弹窗测试是通的 | 区分网络失败与 `parseError`（后者**不该**写 `apiConnectionFailed`，否则会陷入"跳过 → 不再请求 → 标志无法自愈"的死循环） |
| 验证码识别出来是空 | `captchaModel` 必须填视觉模型；留空会回退主模型，日志里会看到 `empty captcha result` |
| 某个任务点一直做不完 / 一直在耗时间 | `xxtAI.taskGiveUpList()`；日志里 `task point stuck` / `task point given up` |
| 讨论任务点没做 / 重复发评论 | 日志 `discussion task opened in new tab`、`discussion page detected, posting reply`、`discussion task has no usable entry` |
| 日志停在某一条 | §6 的 #1 #2；搜 `tick watchdog` |
| 窗口最小化后几乎不动 | 后台节流四层防线（Worker 心跳 / 音频保活 / `pause` 事件直接恢复 / 回前台重校验）。若仍停滞，检查 `edge://settings/system` 是否开了「睡眠标签页」——那是整页冻结，插件侧无法绕过 |
| 音频任务点被跳过 | 媒体搜索的可见性过滤把隐藏 `<audio>` 滤掉了（`_pickMedia` 有隐藏音频兜底，别改坏） |
| 讨论区刷屏式重复评论 | `_discussionPosted` / `omitone_discussion_done` 标记失效 |

**想观察真实 DOM**：不要复用用户正在用的浏览器 profile（Cookies 被进程独占锁死，复制不出来）。
正确做法见 [`tools/README.md`](tools/README.md)：**独立临时 profile + 远程调试端口 + 请用户自己登录**，
然后只读观察。全程不要改页面、不要代替用户操作。

CDP `Runtime.evaluate` 里包 async 脚本必须写成 `return (async function(){ … })()`，否则拿不到值。

---

## 8. 改哪里（先查这张表，别通读代码）

| 你的目标 | 改这个文件 |
| --- | --- |
| 提示词、题型代号、输出格式、token 优化 | **只改 `libs/prompt.js`** |
| API 地址构造、密钥清洗 | **只改 `libs/api-url.js`** |
| LLM 协议适配 / 分批 / 解析容错 | `content.js`：`handleLLMRequestDirect`、`callXxxAPI`、`parseLLMResponse`、`coerceAnswerForType` |
| 跨域代理、抓图 | `background.js` |
| 任务点类型识别（视频/音频/文档/图片/测验/投票） | `page.js`：`_classifyTaskFrame` / `_getAttachmentWorkType` / `_buildAttachmentOnlyJob` |
| 做不完的任务点跳过 | `page.js`：`_taskProgressSnapshot` / `_countTaskIncomplete` / `_isJobCompleted` |
| 题目抠取 | `page.js`：`_questionSelectors` / `_collectQuestionContainers` / `_parseQuestionElement` / `_getOptionItems` |
| 答题与提交 | `page.js`：`_handleQuiz` / `_fillAnswers` / `_areQuizAnswersFilled` / `_maybeSubmitQuiz` |
| 答案缓存（交卷后记答案） | `page.js`：`_rememberCorrectQuizAnswers` / `_isQuizQuestionMarkedCorrect` / `_extractDisplayedCorrectAnswer` |
| 视频、倍速、seek | `page.js`：`_playChaoxingMediaJob` / `_ensurePlaybackRate` / `_trySeekToEnd` |
| 验证码 | `page.js`：`_checkCaptchaDialog` / `_handleCaptchaDialog` / `_runStandaloneCaptchaMode` |
| 讨论任务点 | `page.js`：`_collectDiscussionTargets` / `_findDiscussionTask` / `_tryDiscussionTask` / `_runDiscussionMode` |
| 任务点调度 | `page.js`：`_runTick` / `_runOcsStyleStudy` / `_ensureOcsStudyRunner` / `_searchChaoxingJobOcs` |
| 设置界面 | `popup/popup.js` + `popup/popup.html`（**记得同步 `page.js` 的 `DEFAULT_CONFIG`**） |

需要方法清单时：

```bash
grep -nE '^    _?[A-Za-z][A-Za-z0-9_]*: (async )?function' page.js
```

---

## 9. 新增配置项的完整清单

缺任何一处都会出现"开关存了但读不到"。照抄 `enableDiscussion` 或 `enableCaptcha`：

- [ ] `page.js` → `DEFAULT_CONFIG`
- [ ] `page.js` → 消费点（**要加开关硬守卫**，如 `if (!this.configs.enableXxx) return;`）
- [ ] `content.js` → `configs`
- [ ] `popup/popup.js` → `DEFAULTS`
- [ ] `popup/popup.js` → `els` 映射
- [ ] 若为开关：`xxxVal` 变量 + `bindToggle` + `load()` 读取 + `saveToggleConfig()` 写入
- [ ] `popup/popup.html` → 表单控件

> 纯阈值类配置可以只在 `DEFAULT_CONFIG` + `popup/popup.js` `DEFAULTS` + `content.js`
> 三处声明、不做 UI 控件（先例：`playbackRateCap`、`taskGiveUpAttempts`），
> 用户通过 `xxtAI` 或直接改 storage 调整。

---

## 10. 开发命令

```bash
npm run check    # 工程自检：语法 / manifest / 版本一致性 / 编码损坏 / 幽灵调用 / 死方法 / 死代码 / 唯一真源
npm run bench    # 提示词 token 基准（三代对比 + 信息完整性自检）
npm run itest    # 集成测试：真实 content.js 的答题往返（41 项）
npm test         # 上面三个
npm run e2e      # 真实 Edge 功能交叉检验（135 项）
npm run test:all # npm test + e2e
npm run build    # 打包到 dist/
```

全部零依赖，只用 Node 内置模块。`npm run e2e` 需要本机装有 Edge
（路径可用 `OMITONE_EDGE` 覆盖），细节与踩坑记录见 [`tools/README.md`](tools/README.md)。

### 三层测试的分工

| 层 | 手段 | 能测出什么 | 成本 |
| --- | --- | --- | --- |
| 静态自检 | `tools/check.js` | 语法、版本一致性、**幽灵调用**、死方法、编码损坏、唯一真源 | 秒级 |
| 集成测试 | `vm` + 打桩 `chrome.*` | content.js 的协议、解析、分批 index、答案形态 | 秒级 |
| 端到端 | CDP 驱动真实 Edge | 扩展加载、DOM 行为、注入顺序、脚本异常 | 分钟级 |

**端到端发现问题后，尽量把回归下沉到集成层**（快、稳、无外部依赖），
只在真浏览器才成立的断言留在 e2e。

---

## 11. 提示词与 token

提示词唯一真源是 [`libs/prompt.js`](libs/prompt.js)。全部数字由 `npm run bench` 实测（o200k 分词器）。

### 40 题整卷：三代真实配置对比

| 版本 | 分批 | 输入 | 输出 | 合计 | 相对 1.0.10 |
| --- | --- | --- | --- | --- | --- |
| 1.0.10（旧实现） | 5 题/批 | 3448 | 744 | 4192 | — |
| 1.0.11 首版 | 5 题/批 | 2480 | 376 | 2856 | **省 31.9%** |
| **1.0.11 当前** | **10 题/批** | **1904** | **172** | **2076** | **省 50.5%** |

### 是怎么省下来的

1. **一行图例代替逐题 JSON 样板**。旧实现每次请求按题目数量生成样板行，
   分批策略下随批次数线性重复。
2. **题目用 `序号|题型代号|题干`** 代替 `Question 1 [single]: …` + `Options:`。
3. **不回传 `type`** —— `page.js` 用 DOM 实测的题型，模型自报是冗余字段。
4. **输出改成纯位置式数组**，连 `i`/`a` 键名都省掉。每题输出约 11 token → 约 5 token。
5. **分批 5 → 10 题**。system 与格式示例是每批重发的固定开销（约 88 token/批），
   40 题从 8 批降到 4 批。（开源实现 `cxmooc-tools` 的题库接口一批是 20 题，10 是保守取法。）
6. **关掉 DeepSeek 的思考模式**。V4 默认 thinking，答一道选择题要先烧 ~200 个推理 token。
   只对 DeepSeek 加 `thinking:{type:'disabled'}`（其他 OpenAI 兼容服务不认这个参数，会 400）。

### 还有几条链路在减少**实际调用次数**

- 已有**确认正确**缓存、且本轮已填进 DOM 的题，不再发给模型
- 交卷后的正确答案会被记入缓存，后续重做同题不再问模型
- **空答案补问**（`content.js`）：模型漏答的题会被**单独**再问一次，而不是让 `page.js`
  去猜第一个选项。猜错会触发整卷重答（几百 token + 一轮页面往返），补问通常只要一两百 token ——
  这道防线同时省 token 和提正确率。日志关键词：`llm refill unanswered` / `llm refill failed`

### 压缩提示词的正确姿势

最大的风险是"把信息压掉"。改提示词时：

- `npm run bench` 会断言**题干与选项文本原样保留**
- `normalizeItem` 的 13 个用例必须全过（含位置式数组这一最易错项）
- 改完必须跑 `npm run e2e` —— 新的输出格式要在真实 Edge 里跑通 5 种题型的完整回填

---

## 12. 目录

```
manifest.json           MV3 清单
background.js           service worker：跨域 fetch 代理 + 抓图转 dataURL
content.js              隔离世界桥接：注入 page.js、转发消息、字体解密、状态浮窗
page.js                 页面上下文运行时（主体，约 7600 行 / 290 个方法）
libs/prompt.js          LLM 提示词唯一真源
libs/api-url.js         API 地址构造与密钥清洗唯一真源（content.js 与 popup 共用）
libs/md5.min.js, Typr*.js   字体解析与哈希
resources/table.json    字形哈希 → 真实字符 映射表（347KB）
popup/                  设置界面
tools/                  开发脚本（自检 / 基准 / 测试 / 打包）
legacy/                 已停用代码，不会被加载（原因见 legacy/README.md）
```

## 13. 边界

这个扩展操作用户的学习通账号数据。因此：

- **不要**代替用户输入账号、密码、验证码
- **不要**代替用户点击提交、发布内容（只读观察可以，代操作不行）
- **不要**把 `apiKey` 写进任何文件、日志或提交 —— 它只存在于 `chrome.storage.local`
- 探索浏览器时使用独立临时 profile，不碰用户的真实 profile 与 Cookies
- 跑 `npm run e2e` 会启动一个临时 Edge 实例并自动收尾；**不要**去操作用户正在使用的浏览器

## 许可

见 [LICENSE](LICENSE)。
