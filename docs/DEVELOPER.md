# Omitone 开发者与维护者文档

> 本文件从 `README.md` 移出，给改代码 / 接手的人看；用户向的说明仍在 README。

---

## 给接手的人 / AI：先看这里

这份交接文档是**完整的维护说明**。按下面的顺序读，不要通读 `page.js`（**约 2 万行**）：

> ### ⚠️ `page.js` 已拆成 `src/page/` 下的 16 个**按域**片段
>
> 根目录的 `page.js` 现在是**构建产物**：由 [`src/page/`](src/page/README.md) 里的片段
> 按文件名排序拼成（`npm run concat`）。扩展加载的仍是根目录那一份，所以
> **路径、文件名、`manifest.json` / `content.js` / `build.js` 全都没动**。
>
> ⚠️ **改代码要改 `src/page/` 里的片段，然后跑 `npm run concat`。**
> 直接改根目录的 `page.js` 会「改完立刻生效、下次拼接全丢」——
> `npm test` 里那条 `page.js 与 src/page/ 一致` 就是拦它的。
>
> 拆分分三步：**阶段一按物理行切分（只切不改，验收标准是产物与拆分前逐字节相同，
> sha256 `fd20baa1…`）**；**阶段二按域重组**；**阶段三把两块最重的再细分**
> （`60-tasks` → `60/62/64`，`70-quiz-flow` → `70/72/74`）。后两步改了字节，
> 所以靠另外两条证据：**属性名完全一致（492 个）、app 体非空行一行不多不少（9055 行）**，
> 以及 `npm test` + `npm run e2e` 全绿。
>
> 一句话地图（「我要改倍速 → `40-media.js`」）见 [`src/page/README.md`](src/page/README.md)。

| 你要做的事 | 直接跳到 |
| --- | --- |
| 先跑起来看看现状 | [§1 功能与验证状态](#1-功能与验证状态) · [§10 开发命令](#10-开发命令) |
| 用户报了个 bug，要先定位 | [§3 诊断入口](#3-出问题时先跑这几句) · [§7 症状→病因](#7-调试手册症状--病因--查哪里) |
| **准备改代码**（必读） | [§4 运行机制](#4-运行机制三层环境与调度) · [**§5 代码易纠缠点**](#5-️-代码易纠缠点改之前必读) |
| 改的时候怕踩坑 | [**§6 易错点清单**](#6-️-易错点清单每条都真实踩过) |
| 想加一个配置开关 | [§9 新增配置项清单](#9-新增配置项的完整清单) |
| 想动提示词 / 省 token | [§11 提示词与 token](#11-提示词与-token) |

**三条最容易踩的硬规则**（违反会出事，详见 §5 §6）：

1. 改完必须**刷新学习通页面**（只重载扩展不刷新 → 旧 content script 断连，症状是「功能全停」）
2. 删方法前先 grep 全部调用点（`npm run check` 有幽灵调用检查兜底）
3. 跨域 iframe **永远不要裸读 `.document`**（抛 `SecurityError`，会静默打断整个调度循环）

### 文档地图

| 文件 | 内容 |
| --- | --- |
| **本文件** | **完整交接文档**：功能与验证状态、运行机制、**易错点**、**代码纠缠点**、调试手册、改哪里 |
| [`HANDOVER.md`](HANDOVER.md) | **接手索引**：当前状态、按症状找文件的速查表、常见任务的固定动作、待办清单 |
| [`docs/pagejs-拆分提示词.md`](docs/pagejs-拆分提示词.md) | **`page.js` 拆分任务的执行说明**（自包含，可直接交给另一个 AI）：现状勘明、分阶段方案、硬性约束、验收清单、已知陷阱。**三个阶段都已完成，别再重做** |
| [`src/page/README.md`](src/page/README.md) | **`page.js` 的模块地图**：16 个按域片段各自负责什么、拼接机制（`npm run concat`）、改片段的三条注意、这次拆分是怎么验证的 |
| **`使用说明.pdf`** | **给使用者的图文说明书 · PDF 版**（41 页，含界面示意图）。放在仓库根目录方便一眼找到；适合离线看、转发给同学。**在线看请直接用下面那份 HTML**（PDF 在 GitHub 上会「赌运气」渲染，见下方说明） |
| [`docs/manual.html`](docs/manual.html) | **给使用者的图文说明书 · 在线版**（README 顶部「在线看图解说明书」指向 GitHub Pages 上的它），同时也是上面那份 PDF 的**排版源文件**（内联 SVG、A4 打印 CSS，零外部依赖）。改内容改这个，再跑 `npm run manual` 重新出 PDF。**每个动手处都配一张四问表**（看到什么 / 点哪里 / 怎样才算对 / 不对怎么办），改版时这份「四问结构」要保持 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 更深的协议细节：**源码布局与构建产物**、消息协议全表、storage 键、index 语义、失败分类、各条链路的实现要点、已知限制 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 的做事守则（不重复技术细节，只规定流程与硬性约束） |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么、为什么这么改 |
| [`tools/README.md`](tools/README.md) | 开发脚本说明 + **测试脚手架的全部踩坑记录** |
| [`legacy/README.md`](legacy/README.md) | 为什么那些代码被停用、为什么不能接回去 |
| [`release-notes-1.3.0.md`](release-notes-1.3.0.md) | **当前这版 Release 说明的源文件**（GitHub 上那一页就是它，2026-11-12 合并了 11-10~11-12 那几轮补丁后重写）。改完用 `PATCH /releases/{id}` 同步过去，不必重发版本。⚠️ 这份以前只存在于 `.workbuddy/` 里（**gitignore 掉的暂存目录**），等于「线上那页说明没有源文件」 —— 已挪进仓库根目录 |
| [`release-notes-1.2.9.md`](release-notes-1.2.9.md) | 上一版（1.2.9）的 Release 说明存档，留着只为对照口径 |

> **源码目录里还有一份「就地说明」**：`src/` · `docs/` · `libs/` · `popup/` ·
> `resources/` · `icons/` · `tools/` · `legacy/` 各有一份 README，
> 在 GitHub 上点进目录就能看到。它们只写「这个目录是干什么的、改这里要注意什么」，
> **细节一律指回上面这张表里的文档** —— 同一件事不写第二遍。

---

## 1. 功能与验证状态

「自动化验证」列指 `npm run e2e`（真实 Edge + 152 个场景，1718 项断言）覆盖到哪一步。
**标 ⚠️ 的部分必须到真实课程页人工确认** —— mock 页面无法替代真实平台的编解码、加密字体与任务点结构。

| 功能 | 做什么 | 验证环节 | 自动化验证 |
| --- | --- | --- | --- |
| **视频 / 音频自动播放** | 自动开播；被暂停后自动抢回；播完自动翻节 | 媒体查找、播放控制 | ⚠️ 真实编解码需人工 |
| **自动最大倍速** | 读播放器倍速菜单取上限（读不到就逐档试探） | 倍速应用、上限约束 | ⚠️ 菜单读取需真实播放器 |
| **拖到结尾** | 可拖动的视频/音频直接 seek 到 `duration - 3s`，每一支只判断一次（最多 3 次写入） | 时机判断、开关生效 | ✅ |
| **防拖拽 90% 提前结束** | 拖不动 **且** 倍速锁 1x 的视频，平台标记完成后播到 90% 即进下一个 | 四个判据缺一不可、收尾状态清理 | ✅ 19 项（含 2 条反向验证） |
| **静音** | 视频静音；音频默认不静音 + 最高倍速 | 配置 → 元素属性 | ✅ |
| **PPT / 文档 / 图片** | 翻页、上报 `finishJob`、等页内音频播完 | — | ⚠️ 需真实任务点 |
| **AI 答题** | 单选 / 多选 / 判断 / 填空 / 简答 / 弹窗题（章节测验里的**多选首次走本地**、零 token；要求重做时交回模型） | 抠题 → 提示词 → 模型 → 回填 DOM | ✅ 5 种题型全链路（含「多选不进请求」的守卫） |
| **作业 / 考试页提交** | `.Cy_*` 结构：抠题 → 回填（含隐藏域 `#answer{qid}`）→ 调 `btnBlueSubmit` → 认判分结果页收尾 | 隐藏域真的被写上、提交后认得出已完成（不再重扫重答） | ✅ 含「旧判据对它认不出来」的守卫 |
| **答案缓存** | 交卷后记住正确答案，下次不再问模型 | 对错判定、写入与读回 | ✅ |
| **验证码（弹窗）** | 课程页弹窗验证码：抓图 → 视觉模型 → 填入提交 | 命中检测、结果清洗 | ✅ |
| **验证码（独立网址）** | 验证码是独立页面时同样处理，处理完自动返回 | 页面判定、抓图 | ✅ |
| **讨论任务点** | 解出话题章节页 → 跳转讨论区 → 发评论 → 返回继续刷课；两代模块形状都认，平台已记「完成」的不再重复发帖，发不出去时点名断在哪一环 | 页面识别、控件定位、两条解地址的路、四个出口各一个 `reason`、同一节不数两遍 | ✅ 定位仍需真实 DOM 复核 |
| **多讨论任务点** | 同一章节多张讨论卡片各自独立处理，互不顶掉 | 同文档多卡片、去重键唯一性、已完成标志归属 | ✅ |
| **投票任务点** | 点开平台自己的投票覆盖层 → 勾第一项 → 提交 | 认得出 `insertvote`、空覆盖层不算就绪、勾了才提交 | ✅ |
| **题库字体反爬** | 解析 `font-cxsecret` 自定义字体，按字形哈希还原题目文本；表过期自动发现并拦卷止损 | 解密统计、文档标记、整卷拦停 | ✅ 回归 F06-F08 |
| **报错按根因分类** | AI 请求失败给出【类别】与下一步（余额 / 密钥 / 限流 / 模型名 / 网络），弹窗常驻展示 | 分类器、请求链契约、弹窗状态行 | ✅ 含随机响应契约模糊 |
| **答题分批 ≤3 题** | 每批 ≤3 题、多选一题一请求（上下文保护，宁慢勿废） | 分批算术、跨批不串味 | ✅ 硬断言 |
| **小角色好感度养成** | 摸头 / 陪刷涨好感（10 分钟 1 点、每日 6 次摸头 + 15 点刷课封顶），10 级成长 + 15 枚成就；跟到上课页右下角**一张卡**（Shadow DOM 伴侣）：拖得动、鼠标移上去会回应、安静够久了自己说一句、**自己换衣服自己动一下**、气泡按卡片实际装得下的字数截断 | 存档共享、等级与水位、跨天水表归零与陈旧统计格、成就判定、收起唤回、拖动逐像素跟手与出屏 clamp、气泡不再是竖条、四道「不该插话」的门槛、悬停期摸头动画不被 CSS 吃掉 | ✅ 弹窗小游戏 + 上课页伴侣两个场景 · 含混沌猴暴力点击 |
| **「乱选」兜底填卷** | 没接 API Key 时把空着的填空与单选占位填上；**交卷前先留一个可设置的检查窗口**（默认 30 秒，填 0 = 完全不自动交卷） | 零模型请求、逐题有值、填空不是白框、窗口一份卷子只登记一次、到点自动交、设 0 一直按住 | ✅ 含「先留窗口再到点交卷」的整链路 |
| **mooc2 / PDF.js 适配** | mooc2 作业页（singleQuesId）与 PDF.js 页码文档的完整流程 | 抠题、题型、翻页推进到完成 | ✅ 真实结构场景 |
| **后台节流对抗** | Worker 心跳 + 音频保活 + `pause` 抢播，最小化后仍推进 | — | ⚠️ 需人工长时观察 |
| **跳过不必做的任务点** | 老师没设为任务点的内容（`job:false`）直接跳过；反复做不完的记录后放弃 | `job:false` 判据、进度快照、放弃名单 | ✅ |
| **设置弹窗** | 配置读写、接入方式预设、API 连通性检测 | 依赖加载、地址构造、初始化 | ✅ |
| **题目扫描诊断** | 扫不到题时输出可定位的诊断报告 | 报告内容与线索 | ✅ |

### 支持的学习通任务类型

任务点靠 `module` 字段区分。判定顺序**不能改**（见 [§5.7](#57-jobfalse--ispassed--字段缺失--必须保留的判断顺序)）：

| 任务点类型 | module | 处理方式 |
| --- | --- | --- |
| 视频 | `insertvideo` | 媒体流程（播放、倍速、静音、拖尾） |
| 音频 | `insertaudio` | 同一套媒体流程；播放器把 audio 藏起来时也能找到 |
| 文档 | `insertdoc`（pdf / ppt / docx / innerbook） | 阅读流程：翻页 / 滚动 / 上报完成 |
| 图片 | `insertimage` | 按阅读处理（打开即算） |
| 测验 · 作业 · 考试 | `work` / `exam` | 答题流程 |
| 讨论 | `insertbbs` | 独立模块：解出话题章节页 → 跳转发评论 → 返回。**模块名有两代写法**（`module` 属性上，或只写在 class 上）—— `_discussionModuleName()` 两代都认，只认 `insertbbs` / `bbscircle` / `bbs` 三个词 |
| 超链接 | `link` | 点开即可（`enableHyperlink`） |
| 投票 | `insertvote` | 点开平台自己的投票覆盖层 → 勾第一项 → 提交（`enableVote`，默认开）。⚠️ 识别要排在 `work` / `exam` / `quiz` **之前**：投票页渲染出来的就是「答题」样子，被 quiz 抢走会白烧 token |
| **直播** | `insertlive` | **不支持** —— 运行日志会留 `unsupported task point type` |

---

## 2. 安装与使用

```bash
npm run build        # 产物：dist/omitone-<版本>/
```

打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 `dist/omitone-<版本>/`。
也可以直接加载仓库根目录（跳过打包）。

> 扩展详情里会显示「在所有网站上运行」，这是**必需的**：验证码有时是与学习通无关的独立网址，
> 注入范围必须覆盖它。平时在无关网站上它立即静默退出，不做任何事。

1. 点扩展图标 → 填 API URL / Key / 模型名（或从「接入方式」选预设）
2. 点「检测 API 连接」确认通路
3. 要用验证码识别的话，**默认不用另配** —— 主模型自带视觉；只有把主模型换成纯文本模型时，才要另填一个支持图片输入的型号
4. 打开学习通课程页 → 点「开始运行」

**改完代码的固定动作**：`npm test` 全绿 → 同步版本号五处 → `edge://extensions` 重新加载 →
**刷新学习通页面（F5）**。

---

## 3. 出问题时先跑这几句

在学习通页面按 F12，控制台执行：

```js
xxtAI.probe()           // **一次给全**：插件此刻凭什么说这一节做完了、认出几个任务点、
                        // 页面上有几份卷子、真实题数与题型、刚才有没有为它等过（全只读，不答题不交卷）
xxtAI.diagnose()        // 题目扫描诊断：每个 iframe 命中了什么选择器、为什么没抠出题、下一步该查什么
xxtAI.scanQuiz()        // 只跑一次抠题并打印结果（不答题、不提交）
xxtAI.diagnosePopup()   // 弹窗题诊断：视频里弹出的题认没认出来、选项抠到几个、推断出的字母是什么
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
漏掉 `source` 会被静默丢弃，症状是「配置改了不生效」。

`libs/*.js` 由 `manifest.content_scripts.js` 数组按顺序在 `content.js` 之前注入；
popup 侧要单独写进 `popup/popup.html` 的 `<script>`。`npm run check` 会校验这两处。

### 4.2 主循环：单入口、有重入锁

`_startTickLoop` 每 250ms 调一次 `_runTick`，`_tickRunning` 保证上一轮跑完才开始下一轮，
150 秒的看门狗会强制释放卡死的锁。

推论：
- 任何 `await` 永久悬挂 = 整个循环死亡。**新增 `await` 必须可超时**
  （跨环境走 `bridgeSend`，自带 90 秒；`video.play()` 包 `this._withTimeout`）
- 别在 `_runTick` 里加「每次都要跑完」的重活，会拖慢整个心跳

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

**这一节是本项目历史上 bug 的主要来源**：绝大多数故障不是「某处写错了」，
而是**两条本来各自正确的代码路径互相抢**。改动前先搞清当前是谁在仲裁。

### 5.1 `_runTick` 的判定顺序就是仲裁顺序

具体为什么是这个顺序：

- **讨论页必须在最前**：否则它会被当成课程页，去「找任务点 → 跳章节」，把讨论标签页搞乱
- **验证码必须早于一切**：页面被验证码挡住时，检测到的 DOM 全是验证码的，继续跑会得到一堆错误判断
- **`_checkSubmitConfirmDialog` 必须在 `_checkPopupQuiz` 前面**：提交确认弹窗长得就像弹窗题
  （都用 `layui-layer`），顺序反了就会去「答」一个确认框
- **`_handleDiscussionWait` / `_tryDiscussionTask` 必须早于视频处理**：
  讨论任务点打开新标签页期间主循环要暂停推进，不能和正在播放的视频抢进度

**改 `_runTick` 顺序 = 高风险操作。**

除了判定顺序，还有两件事属于「改 `_runTick` 前必须懂」：

- **重入锁 `_tickRunning`**：保证同一时刻只有一个 tick 在跑。看门狗
  （`_startTickLoop` 里「挂起超 150 秒就强制放锁」）是**对的** —— 历史 bug 就靠它兜住。
  但要注意：被强制放锁的那次 tick **并没有真的结束**，它只是还在挂起。
- **代号 `_tickEpoch`**：正因如此，`finally` 里复位锁必须**先确认代号还是自己的**。
  否则旧 tick 过一会儿醒来时会把**新 tick 的锁**一起清掉 → 下一轮又起一个 tick →
  **两个 tick 并行推进**（可能重复提交、重复跳章）。
  ⚠️ **改 `_runTick` 的 `finally` 时别把这个代号判断删掉。**
  正常路径下代号必然相等，所以这段判断不影响任何正常行为。

### 5.2 已存在的「互斥开关」（别在不理解的情况下删）

| 字段 | 作用 |
| --- | --- |
| `_tickRunning` | tick 重入锁 |
| `_quizInProgress` | 答题进行中，防并发答题 |
| `_captchaBusy` / `_captchaActive` | **`_captchaActive` 期间抑制 `_checkVideoStatus` 与 pause 自动恢复** —— 验证码会让视频暂停，守护去「抢回播放」会跟验证码打架 |
| `_rateProbing` / `_rateDetectBusy` | 倍速探测期间**跳过倍速守护**，否则守护会把探测设的倍速立刻压回去；`_trySeekToEnd` 也在探测期间主动让路 |
| `_stepSwitchPending` | 翻节进行中，防重复翻节 |
| `_discussionPosted` | 保证每个讨论页只发一次评论 |
| `_pauseResumePending` | pause 抢播的防抖，避免「暂停↔恢复」无限战斗 |
| `_quizReadyToSubmit` / `_quizReadyWorkKey` | 表单填好待提交，避免重复走 LLM |
| `_activeMediaJobPending` / `_activeDocumentJobPending` | 阻断 `nextUnit`，等媒体/文档任务真正结束 |
| `_quizForceSkipUntil` / `_quizApiFailUntil` | **两个独立退避窗口**：前者是「解析失败，8 秒后重试」，后者是「API 不可用，45 秒后重试」。两者都 gate 答题，改一个记得看另一个 |
| `_discussionWindow` | 讨论标签页句柄；期间 `_handleDiscussionWait` 暂停推进 |

### 5.3 三个重载页面/清状态的地方会互相干扰

`_checkBlockedByCrossOrigin`（跨域卡住 → 刷新）、`_captchaReload`（验证码多次失败 → 刷新）、
`_refreshChapterAfterDiscussion`（讨论完成 → 刷新章节）都会重载或重建状态。
各自有冷却计时（180s / 计数器 / 讨论标记），**不要再加不相关的重载路径** ——
多个重载源叠加会变成「刷新风暴」，页面永远加载不完。

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

1. **`normalizeItem` 必须把数组归到「位置式」那一类**。数组的 `typeof` 是 `object`，
   若被当成 `{a:…}` 包装对象解析，**多选题答案会被整条丢掉**。这是这段代码最容易改错的地方。
2. **长度不符不会误提交**。`content.js` 记 `llm answer count mismatch` 日志后按位置尽力对齐；
   没对上的题保持未填 → `_areQuizAnswersFilled` 为假 → 不提交 → 下一轮 tick 重试。
   属于可自愈的降级，**不要改成「猜一个补上」**。
3. **分批大小牵动 token，别随手改小**。system 与格式示例是每批重发的固定开销（约 88 token/批），
   题目正文只发一次。改 `CHUNK_SIZE` 前先看 `npm run bench` 的对比数字。

旧协议（`{"i":n,"a":…}` 与 `{"index":…,"answer":…}`）仍然兼容 —— 保留它是为了让
用户自定义 `systemPrompt`、或模型自作主张换格式时不至于解析失败。

### 5.6 答案形态要按题型规整

`content.js` 的 `coerceAnswerForType` 处理位置式输出的常见偏差：
单选收到 `["A"]` 解包成 `"A"`、判断题收到 `"正确"`/`"T"` 归一成 `true`。
**多选数组必须原样保留，不能被解包。**

不做这层规整的后果：形态不对 → `_matchOptionItem` 匹配不上 → 该题静默不填 →
表单不满 → 永不提交。属于「看起来像模型没答对、实际是协议没对上」的坑。

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
  它和「字段缺失」是两件事。漏掉 ③ 就会去「完成」一个不需要完成的任务点，白耗时间。
  判据来自开源实现 `cxmooc-tools` 的 `CxTask`：
  `if (taskinfo.job) { done = false } else { done = true }`（没有 job 标记就当作已完成）。
- **④ 只列「确定是任务点」的模块**，不要把 `insertimage` 加进来 —— 图片大多是正文内容，
  推断成任务点会让插件去「处理」一堆纯展示图片。真正带 `job:true` 的图片任务点由
  `_buildAttachmentOnlyJob` 处理。

同一判据在 `_buildAttachmentOnlyJob` 与 `_classifyTaskFrame`（帧数据里的 `"job":false`）
都要挡一道。

### 5.8 「做不完就放弃」机制：三条铁律

`taskGiveUpAttempts`（默认 4）控制「连续几次卡住就放弃」。配套规则：

1. **`_isJobCompleted` 拿不准时必须返回 `true`**（当作已完成）。
   它的返回值会喂给放弃计数，误判成「没完成」会把**必做任务点**跳过 —— 比多跑一次严重得多。
2. **只有「两次进度快照完全一致」才算卡住**（`_taskProgressSnapshot`）。
   长视频一次本来就跑不完，若按「没完成」计数，必做任务点会被误跳过。
   探测不到进度（快照为空）时**一律不计**。
   快照只对「有媒体」或「确实可滚动」的文档有意义 —— 否则不可滚动的页面会给出恒定的
   `scroll:0`，把「测不到」误当成「没进展」。
3. **放弃名单必须能被用户清掉**（`xxtAI.clearTaskGiveUp()`，24 小时 TTL）。
   静默地永久跳过用户的任务点不可接受；跳过时必须留日志说明「为什么」和「怎么恢复」。

### 5.9 讨论任务点：七个容易踩的点

1. **`#isFinished` 必须按卡片范围查找**，不能 `doc.getElementById` ——
   同一文档多张卡片会共用同一个「已完成」标志，导致批量漏做或反复重开同一个。
2. **向上找标志时必须先数卡片数量再读**。顺序反了就会在「多卡片共用容器」上读到共用值，
   原 bug 原样复发。
3. **去重键必须用 `mtopicid`**，不能用 `url.slice(-70)` —— 短 URL 相同就碰撞，
   第二个任务被 `_isDiscussionDone` 判成「24 小时内已处理」而永久漏做。
4. **`_markDiscussionDone` 是先于打开动作写的**（防止重复打开）。
   若一个入口都没打开成功，必须 `_unmarkDiscussionDone` 撤回 ——
   否则这个任务点被静默跳过 24 小时，日志里毫无线索。
5. **模块名有两代写法**：一代写在 `module` 属性上，另一代 `[module]` 数出 0、名字只在 class 里。
   只按 `iframe[module]` 找 → 遇到后一代**一条都匹配不到**，在刷课页侧就成了「这一节没有讨论」，静默漏做。
   `_discussionModuleName()` 两代都认，但**只认讨论系三个词**（`insertbbs` / `bbscircle` / `bbs`）——
   拿 class 里任意一段当模块名会把 video、work 一起拖进来。
6. **找模块 iframe 必须按节点去重**：`_studyDocs()` 回的是 `[主帧文档, 顶层文档]`，
   而 `_walkDocs` 的 `seen` 是每次调用各自一份 —— 从顶层那一路再走进主帧文档时同一枚 iframe 会被收第二遍，
   于是同一份章节页发两遍请求（最坏 2×15 秒）。摘掉这道去重，夹具里 3 枚立刻数成 6 枚。
   另外四个 `return ''` 出口原先**一个字都不写**，现在各点名一个 `reason`（`no-chapter-url` / `fetch-failed` / `no-topic-card` / `server-says-finished`）。
7. **章节页的解析结果必须按「绝对地址」缓存，而且命中时仍要把 `serverFinished` 写回这一枚模块**。
   第 2 步（`_resolveDiscussionUrlFromModule`）被 `_tryDiscussionTask` **每 3 秒问一轮、一轮问遍这一节所有模块**，
   而「这一节的讨论全做完了」并不是出口 —— 三枚模块每轮都重新 `fetch` 一遍章节页，
   三个讨论的章节就是**每分钟约 60 发请求打在平台上、永不停**。
   两档有效期不一样是刻意的：解出地址 / 平台已记完成 = **10 分钟**（平台自己的说法，变得慢），
   断链（没回话 / 没有卡片）= **30 秒**（懒渲染与网络抖动会自己好，按 10 分钟冻住就成了悄悄跳过任务点）。
   ⚠️ 命中缓存时**不能只返回缓存里那份结论**：调用方每轮重新 `_findDiscussionModuleFrames()`，
   拿到的是**新的包装对象**，它读的是 `modules[i].serverFinished` —— 不写回去，
   一分钟后那句「这一节的讨论都处理完了」的依据就把平台已记完成那一格数成 0（注入实测红在这一条）。

---

## 6. ⚠️ 易错点清单（每条都真实踩过）

按「症状 → 根因 → 现在怎么防」整理，越靠前越贵。

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
| 10 | 多讨论任务点整批漏做 / 反复重开同一个 | `doc.getElementById('isFinished')` 让同文档的卡片共用「已完成」标志 | 按卡片范围查找，且**先数卡片再读标志** |
| 11 | 多讨论任务点第二个永远不做 | 去重键用 `url.slice(-70)`，短 URL 相同就碰撞 | 用 `mtopicid` 作键，取不到退回整站 URL 的哈希 |
| 12 | 不需要完成的任务点被白做一遍 | `job: false` 落到「按模块名推断」分支又变回 `job` | §5.7 的 ③ 必须排在 ④ 之前 |
| 13 | 已通过的任务点被重做一遍 | `isPassed` 排在 `job` 之后，返回 `'job'` 导致调用点直接开跑 | §5.7 的 ① 必须排在 ② 之前 |
| 14 | 多选题答案整条丢失 | 位置式数组 `["A","C"]` 的 `typeof` 是 `object`，被当成 `{a:…}` 包装对象解析 | `normalizeItem` 里 `Array.isArray(item)` 归到位置式那一类 |
| 15 | 必做任务点被静默跳过 | 按「没完成」计数放弃，而长视频一次本来就跑不完 | 只有「两次进度快照完全一致」才算卡住；`_isJobCompleted` 拿不准返回 `true` |
| 16 | 改了开关不生效 | `postMessage` 漏了 `source` 字段被过滤器丢弃；或只重载扩展没刷新页面 | 见 §4.1；改完必须 F5 |
| 17 | 某个开关「存了但读不到」 | 新增配置项只加了 `DEFAULT_CONFIG`，没加消费点 / content / popup | 按 [§9](#9-新增配置项的完整清单) 逐处补齐 |
| 18 | 抽了公共模块后功能全挂，报 `Cannot read properties of null` | 忘了把新 lib 加进 `manifest.content_scripts` 或 popup.html | `npm run check` 会校验注入清单；`content.js` 有 `missingModuleError()` 给出可操作提示 |
| 19 | 提示词/地址构造行为不一致（弹窗测试通过、页面失败） | 同一段逻辑被复制成两份并各自演化 | `libs/prompt.js` 与 `libs/api-url.js` 是唯一真源，`npm run check` 强制 |
| 20 | 任务点被判 `not-job` 直接漏掉 | 扩展名正则写成 `\.(ppt\|mp4)$`，而真实 `property.type` 是 `"ppt"` 不带点 | 正则改成 `(?:^\|\.)(?:ppt\|…)$` |
| 21 | manifest 无法解析，报错里有个看不见的字符 | 编辑器写回了 UTF-8 BOM | `npm run check` 检测 + `node tools/fix-bom.js --write` |
| 22 | 选项文本剥不掉「选项」前缀 | GBK 乱码残留（`选项` 被写成 `閫夐」`） | `npm run check` 的编码损坏探测（只查非注释行） |
| 23 | 版本号在扩展详情/浮窗里对不上 | 版本号有三处（manifest / popup.html / content.js 品牌位），漏改一处 | `npm run check` 强制三处一致 |
| 24 | 改了半天没生效，回头发现改动被覆盖 | **并行编辑同一个文件会互相覆盖**（工具都报成功，只有最后一个生效）；本项目还有过外部编辑器用旧快照覆盖文件的历史 | 改同一文件多处必须**串行**，每次改完 grep 回读；批量改动用 `git diff` 复核 |
| 25 | 连跑两次测试，第二次「所有注入都失败」 | 上一次的 Edge 被杀后调试端口未及时释放，新实例连到了正在退出的旧实例 | 收尾与启动前都会等端口释放（12 秒超时） |
| 26 | **章节卡住不动**，日志每 5 秒一轮 `study begin` + `quiz scan found 0 questions` | `_detectQuiz` 只看了章节标题：`if (title.indexOf('考试') !== -1) return true`，于是**名为「10.1 课程考试」的章节**（0 任务点、已完成）被判成「有测验」，`_isCurrentCompleted` 因此拒绝跳过 → 永久循环 | 判定必须有**证据**：标题命中之外，还要在 URL 链（`location.href` / 主 iframe src / 文档内所有 iframe src）里真的看到 `ananas/modules/work`、`exam/test`、`testpaper` 等作业/考试页特征 |
| 27 | **AI 完全不听题**，但密钥是填了的 | API 表单只有点「保存 API」按钮才落地，且 `apiType` 下拉**根本没有 change 监听** → 切了接入方式却不重填就没保存 → `apiKey` 为空 → `enableQuiz` 硬守卫跳过全部答题（症状是「读不到题」，很像扫描失败） | 输入类字段 800ms 防抖自动保存 + `apiType` 监听，并有 toast 提示 |
| 28 | 用 DeepSeek 时每道题先烧 ~200 个推理 token | DeepSeek V4 默认开启思考模式，而答题是纯模式化任务 | 请求体加 `thinking:{type:'disabled'}`（**只对 DeepSeek 加**，其他 OpenAI 兼容服务会对未知参数报 400）。实测 2 题从 361 → 133 token |
| 29 | 有一道题被**猜错**，然后整卷重答一遍 | 模型偶尔返回空答案，旧实现走 `_avoidKnownWrongAnswer` 的空答案兜底 —— 直接猜第一个选项。判断题猜错概率 50%，猜错就触发「整卷带 `禁:` 前缀重答」 | **空答案补问**：一轮跑完还有题没收答案时，把这些题打包成一次小请求重问（`llm refill unanswered`），把「猜」换成「问」 |
| 30 | `npm run e2e` **全线失败**：所有场景都报「page.js 在真实 Edge 中加载成功：失败」，页面里却一条异常都没有 | 测试脚本按 `SHA256(目录路径)` 猜扩展 ID，而**路径大小写敏感**：`D:\Omite` → `hdlemlcmf…`（真），`d:\Omite` → `locncobd…`（假）。从 Git Bash 风格 cwd 启动 node，`__dirname` 的盘符变小写，ID 就错开了 —— 扩展其实加载得好好的，是测试自己拿着错 ID 去注入 | 改为**运行时发现**真实 ID（content script 的 `Runtime.executionContextCreated` → `origin`），路径哈希降级为兜底；发现不一致时会打印一行警告。详见 [AGENTS §7.2](AGENTS.md) |
| 31 | **视频里弹出题后 AI 一直在扫描、但从不填空，课程永久空转** | 四层叠加：① 弹题请求**没有任何去重**，tick 每 250ms 一轮就重问一次模型；② `_matchOptionItem` 只在选项带 `.num_option` 徽标时才知道字母，原生 `li + input[value="A"]` 结构的字母恒为空 → 模型答裸字母 "A「 时一个都匹配不上；③ `_getOptionItems` 遇到无 `Zy_/Cy_`、无 `label` 的结构直接返回 `[]`；④ 题型靠**题干关键字**猜（含」正确「就判成判断题），」下列说法正确的是？「这类单选被误判。而弹窗分支在 `_runTick` 最前面 `return`、`_handleVideoPause` 又规定」有弹窗不恢复播放「 → 死锁 | ① 新增 `_inferOptionLetter`（徽标 → 属性 → `input.value` → 文本前缀 → 位置兜底）；② `_getOptionItems` 补原生结构兜底（只取最内层）；③ 新增 `_detectPopupQuizType`（控件优先 + 判断题需选项为」正确/错误"这类对立表述）；④ 新增 `_activePopupBlock()`（含放弃窗口与已答放行），`_runTick`/`_handleVideoPause` 全走它；⑤ 同一弹题最多问 3 次后 `_giveUpPopupQuiz`（日志带 DOM 快照 → 点跳过 → 60s 冷却）；⑥ `_fillPopupAnswer` 没选中就不点提交 |
| 32 | **弹题答对了，但视频右下角还挂着一个「继续学习」按钮，不点就进不去正常播放页，AI 照样空耗** | 代码里**根本没有这个按钮的处理**：它不属于弹窗题（没有选项），也不属于任何已有分支，于是 tick 每轮都跳过它，视频一直停在那儿 | 新增 `_findContinueStudyButton` + `_tryContinueStudyPrompt`：按文案（继续学习/继续观看/继续播放）+ 与视频同文档 + 形态打分定位，**叶子节点优先**（站点把 `onclick` 挂在按钮上，点到外层容器没反应）；挂在 `_runTick` 里弹题之后、播放之前。两道保险：同一按钮 3 秒内只点一次、连点 5 次没反应就停 60 秒并写日志 |
| 33 | **多选题只选一个就提交，然后一直卡住**（章节小测无视后续、视频弹题反复选不对） | 四条叠加：① **没有任何地方规定「多选题至少选 2 项」**，只选 1 项也算「填好了」 → 提交 → 判错 → 记为错答案 → ② 重试时 `preferredSize = canonical.length` 恰好是 **1**，于是 fallback 组合**优先挑「只选一项」的组合**，逐个字母试过去，每次都错 → 一直磨到 20 次交卷上限；③ 视频弹题那条路**自己另写了一份**选项填充，**没有** `"AC"` → `["A","C"]` 的拆分，模型回不带分隔符的连写字母时一个选项都匹配不上；④ `_clickOptionItem` 对复选框会点两次（`item.click()` + 内层徽标 click），**复选是开关，两次点击互相抵消** → 随机少选 | ① 新增唯一入口 `_applyChoiceAnswer`（章节小测与视频弹题共用），把重复的填充逻辑合成一份；② 连写字母按单字母拆开；③ 标着「多选」的题答案不足 2 项时**本地扩成相邻两项**（纯本地，**零 token**）；④ `_sortMultiFallbackCombos` 的目标规模**下限钉在 2**（低于下限的组合只排到最后、不删除 —— 「不定项选择题」单选也是正确答案）；⑤ `_clickOptionItem` 改成幂等：先点、再把终态写回，复选只加不减；⑥ 同题错够 `quizQuestionMaxMisses`(3) 次后 `_isQuizQuestionBestEffort` 判真 → 不再进 LLM 请求、不再扩错答列表，直接填本地猜测让整卷交得出去（**这才叫真的「不卡住」**：章节小测的提交前置是每题都有值） |
| 34 | 换了个模型就一直 **400**，看起来像插件坏了 | 思考参数**按厂商各写各的**（DeepSeek `thinking:{type}`、通义 `enable_thinking` + `thinking_budget`、Kimi `reasoning_effort`），各家对未知字段的反应不一致：有的忽略、有的直接 400。旧实现写死「只对 DeepSeek 加」，一改成表驱动就容易给不支持的渠道发参数 | ① 参数映射收进唯一真源 `libs/thinking.js`，**按渠道白名单**发；认不出的渠道在「关闭」档**一个参数都不发**（= 升级前的行为）；② 服务商拒收时 `content.js` **自动摘掉思考参数重试一次**并记 `llm rejected thinking params, retry without them`，不让整次答题判死；③ 集成测试同时断言「该带的带对了」与「**不该带的一个都没有**」，后一条更重要 |
| 35 | **作业 / 考试页点了选项却不生效**（日志写着「已点」，页面上一个都没选中） | 那套 `.Cy_*` 结构里，选项**文本**在 `.Cy_ulTop` 的 `<a>` 里、可点的 `input` 在**另一个** `.Cy_ulBottom` 里 —— 文本与控件是两个分开的 `ul`。`_getOptionItems` 抢先命中文本那一列 → `item.querySelector('input')` 恒为 null → 一下都没点到，但 `clicked++` 照样加，调用方当成功照样提交 → 空转 | 新增 `_pairOptionControls`：按索引把控件配到文本节点上；点击顺序改成**先点、再把终态写回**（反过来复选会被站点再切一次，反而变未选）。端到端新增作业页场景，断言「DOM 里真的有 1 个 radio / 2 个 checkbox 被选中」，**不是只看日志** |
| 36 | **Key 填错了，表现却是「插件每隔 45 秒卡一下」** | `content.js` 认得 401/403（不重试、不写 `apiConnectionFailed`），但 `page.js` 拿回 `{permanentError:true}` 后**根本没读这个字段**，一律走 `_markQuizApiConnectionFailed` → 45 秒退避，把「配置填错了」伪装成「网络连不上」，而服务商明明把 `Invalid API key` 原话返回来了 | 4xx 单独一支：跳过本轮（60 秒）、把服务商原话留在 `_quizApiLastError`，**不进退避窗口**；视频弹题改走 `_giveUpPopupQuiz`（关弹窗 + 60 秒冷却，不拿坏 Key 反复撞接口）。**500 仍然退避**由对照场景守着 —— 否则「凡是失败都不退避」也能蒙混过关 |
| 37 | **作业 / 考试页点了选项，但 `#answer{qid}` 一直是空**（点了却等于没填，整卷永不提交） | `_clickOptionItem` 写隐藏域的条件是 `qid && badge` **同时**成立：`qid` 只从选项 `<li>` 自身取（真实作业页把 qid 挂在容器 `.Cy_TItle[qid]` 上），`badge` 要求 `.num_option` 徽标（真实作业页**没有**这个徽标）。两个都不满足 → 点击照做、日志照打 `clicked option`、隐藏域却始终是空串 | qid 改**三级回退**（自身 → 最近的 `[qid]` 祖先 → `_getQuestionIdFromElement`）；把「写隐藏域」从「徽标那组操作」里**拆出来**，只要有 qid 就写；字母改用 `_inferOptionLetter`，并**以控件自身的 `value` 为权威**（判断题的 `true`/`false` 就是这么来的 —— 写 `A` 进去平台不认）。端到端断言隐藏域的值，**不是看日志** |
| 38 | **提交后认不出「已完成」，题目一直扫描、AI 重复提交**（整页重载 → 重扫 → 重答 → 重交，无限循环） | `_isQuizPassedOrFinished` 只认 `_isDocumentFrameFinished` 那一套标记（`.ans-job-finished / .job-color / .icon_Completed / .testTit_status_complete` + 父层「任务点已完成」）—— 那是**课程章节页**的标记。作业/考试提交后翻出的是**判分结果页**（每题多出「我的答案 / 正确答案 / 解析」，控件全部 `disabled`），这套标记一个都不命中 → `_monitorQuizSubmit` 一直 hold → 25 秒超时 → 整页重载 → 重扫重答重交 | 新增 `_isQuizResultPageFinished`：三条判据**同时**成立才算完成（出现判分痕迹 + 控件已不可交互或题目容器已消失 + 不含重做文案），宁可漏判也不误判（误判 = 把没交的卷当已完成，直接跳过该任务点）。端到端把 mock 结果页做成**真实判分页**，并断言**旧判据对它确实认不出来** |
| 39 | **一份测验里好几道多选，总有一道空着、整卷一遍遍重来**（日志里 `llm flat answers resegmented` / `llm answer count mismatch, batch discarded` 反复出现） | 多选答案最长，模型答它时容易把选项字母**摊平**、甚至混进嵌套数组：实测 5 题回成 8～13 项 → 那**一整批**长度对不上 → 整批作废 → 补问 → 再退化，于是「四个填上了、最后一个空着、然后不断重复」。而整卷的提交前置只有一条「每题都有值」，多选**本来不需要答对** | 非视频整卷（章节测验 / 作业 / 考试）的多选改为**本地作答、不进请求**：复用避开已知错答的本地兜底（判错一次下一轮换一组组合），并把「这一卷全是多选」也一并收尾提交；本地算不出的题（读不到选项字母/填不进 DOM）照旧交回模型，**绝不制造空题**；视频里的**多选弹题不受影响**（答错就不让继续播，仍然交给 AI）。⚠️ **2026-11-10 批次 7 已把这条反转** —— 多选现在照旧问模型，本地只剩没落地时的补填，见 #49 |
| 40 | **「只做多选题，其他的不做，疯狂提交」**（一份卷子交一次、没过、再交一次，反复刷提交） | ⚠️ 这是上一条第一版的**次生故障**，也是本项目最典型的一类：**取舍本身没错，错在没把「本地答案是猜的」当成环路前提推一遍**。链条是闭合的：本地答案是猜的 → 卷子基本过不了及格线 → 平台出现「未达到及格线 / 请重做」→ `_prepareQuizRedoIfNeeded` 清零状态重答重交 → 上限 20 次，而**每一次提交都是真的交上去**。用户看到「只做多选题」是因为每轮只有多选在变（其余题每轮从模型拿回同一批答案） | ① **本地作答只在这份卷子的第一次尝试里生效**：一旦本卷交过卷（提交计数 > 0，sessionStorage 里、换页也在）或这一轮之前已本地答过（`_quizLocalMultiplePapers`），就把多选**交回模型** —— 交过一次还没过，说明「只求填上」这个前提不成立；② **本地作答过的卷子交卷上限从 20 收到 2**（首发 + 一次认真重做），不拿平台的提交次数去赌一个猜出来的答案。代价：重做那一轮会为多选花 token（只求填上的常见情形依旧零 token）。⚠️ **批次 7 之后闸门整条删掉了**：多选默认就问模型，「第一次本地、第二次模型」这个分层不复存在，只剩「模型没落地才补填」；上限 2 现在按**是否真的补填过**计，见 #49 |
| 41 | **「上面是题目、下面是讨论」时只做讨论、跳过题目，然后卡住不动**（日志反复 `study begin` → 每帧都被拒 → `study finished on page {searchedCount:0}` → 点「下一节」→ 又 `study begin`，附件数一模一样） | ⚠️ 平台**自己的脚本**里有一句 `jobIconDiv.set({'aria-label': '任务点已完成'})`，而 `textOf()` 写的是 `innerText \|\| textContent` —— **可见文本为空时回落 `textContent`，连 `<script>` 源码都算成页面文字**。于是 `_isDocumentFrameFinished` 在脚本注释里读到「任务点已完成」，把整份卷子判成完成 → `workType` 由 `job` 改写成 `finished` → 静默跳过 → 搜不到任务点 → 判本页做完 → 点下一节（平台不让走）→ 空转 | 防线：① `textOf` 回落时跳过 `script/style/noscript/template` 源码；② 静默跳过必须写日志；③ 连续 3 轮「学习进度键」不变就停止点下一节并告警。⚠️ **判「完成」只能看真实可见文本，别吃 `textContent`** |
| 42 | **一页两个讨论，只发第一个、第二个被跳过**（发完第一个和题目就直接点下一节） | `_findDiscussionTask` 三条路径都只返回**第一个**候选，而调用方 `if (this._isDiscussionDone(task.key)) return false;` 一看「这个发过了」就**整体放弃** —— 排在后面的永远轮不到 | 防线：**在查找阶段就跳过已发过的**（三条路径各补一处），调用方那句只当兜底。⚠️ **「取一个候选」的函数遇到「这个不要」时，应该继续找下一个，而不是让调用方放弃整件事** |
| 43 | **换到下一份卷子时干等几十秒才开始答题**，且日志被同一对记录刷满 | `_quizRoundFilledCount` / `_quizRoundNoProgressAt` 是**全局**状态：上一份卷子最后一轮 `filled=0`，新卷子第一轮当然也是 0 → 被判成「没有进展」，这一轮一次都不答；那 60 秒里 OCS 每秒重匹配一次，`study matched job` + `quiz round skipped` 各一条，200 条日志缓冲被刷满 | 防线：状态按**卷子 key** 隔离 + 两条日志 10 秒节流。⚠️ **「没进展」这类跨轮比较的状态必须按「哪一份活」隔离**，否则上一份的结尾会污染下一份的开头 |
| 44 | **讨论帖下一条回复都没有，日志却写着「已提交、已确认」**（一页挂多个讨论时格外容易发生在第一个） | `_discussionSuccessHint` 第 3 条判据是「编辑区被清空」—— 而**内容压根没填进去**时编辑区本来就是空的（页面刚注入、受控组件把值吞了），一点提交就「确认成功」；同时 `_markDiscussionDone` 是**打开前**写的、失败路径**没有撤销** → 一次失败就静默跳过 24 小时 | 防线：填充**回读确认** + 失败撤标记重试 + 「编辑区被清空」必须以「确实填进去过」为前提。⚠️ 与第 42 条同一类：**判据只看「看起来完成了」，没确认「事情真的发生了」。写「成功/完成」判定时先问：这个信号，失败的时候会不会也成立？** |
| 45 | **交完卷之后一直卡着不动**（日志反复 `study matched job {"kind":"quiz"}`，既不答题也不往下走，能卡好几分钟） | 两条判据打架：`_handleQuiz` 因 `_quizAnswered` 为真**一字不做**，`_isQuizLearningPending` 又因「提交按钮还挂在页面上」说**还有题** → 调度器每秒把同一份卷子交给它一次，永远不前进 | 防线：`_isQuizLearningPending` 里**自己刚答过就不算 pending**（平台明确要求重做除外）。⚠️ **第三次同类**：两处各自维护「做完了没有」，定义却不同 —— **动这类判定前先找出另一个也在判断同一件事的地方** |
| 46 | **第一次遇到题目过了，第二次遇到题目不答题**（真实日志：`19:12:17 quiz submit finished` → **1 秒后** `skip completed` + 点「下一节」→ 此后整段没有任何答题记录） | `_isCurrentCompleted()` 把**页面级**文案「任务点已完成」排在**逐任务帧**完成状态之前，而一张卡片挂两份测验时，刚交完那一份就会把这句话渲染出来 —— 另一份一个字没答，整节却被判「做完了」。而 `_handleQuiz` 开头三个「这一轮不答」的原因（冷却 / 上一轮未完 / 已答完）共用一个**静默** return，日志一个字不写，现场只能靠猜 | 防线：① 判据顺序反过来 —— **未完成任务点的证据压过一句文案**，并把依据写进 `_completionEvidence`（`skip completed {by:…}`）；② `quiz held: nothing answered this round {reason:…}`（10 秒节流）；③ `_isQuizPaperChangedInDom()` 兜住 `_quizAnswered` 是页面级、换卷又要靠任务点 id 的那一族形状（新旧 qid **完全不重叠**才判换卷，有交集就保守不动）。⚠️ **第 41 条的亲戚**：「任务点已完成」这类**页面级文字**永远不能单独判「这一节做完了」；**跳过不可逆、多等一轮只是慢一点** |
| 47 | **进卷子先白等 8~12 秒「等解码」，而日志里解码层一条记录都没有**（用户原话「它连解码那个都没有」；真实日志：`quiz waiting font decrypt {fontMiss:false}` → 8.1s / 12.2s 后 `font decrypt pending over limit, answer anyway`，而那两份卷子的题面其实是好的） | 三处叠在一起：① 等不等的判据走的是**整页**扫描 —— 不相干装饰帧里**永远解不掉**的残留也算「还没解码」；② content.js 的扫描只有 300ms **尾部**防抖，而 page.js 自己每秒都在写 DOM —— 变动间隔长期小于 300ms 时扫描**永远排不到**；③ 解密层有三条「什么都不做也不吭声」的分支（无字体声明却带密文 / 映射表建不起来 / `computed===0`），跑没跑、为什么解不出，日志里看不出来 | 防线：① 新增 `_probeFontDecrypt(题目文档)` —— 只从题目那份文档往下走（含子帧），一次遍历把密文残留、`data-om-font-miss`、终局判据与扫描戳一起收；② `scheduleDecryptSweep()` 改成**有界**防抖（300ms 防抖 + 最长 2 秒必跑 + 两次至少隔 400ms），加 `decryptSweepRunning` 防并发全页重扫；③ 每份被扫描的文档落 `data-om-font-state` + `data-om-font-sweep`，非 clean 结论写 `font decrypt verdict`（每份文档每个状态 60 秒一条，带 `suppressed`）；④ `nodecl` / `nomap` 属终局判据 → **不等**（30 秒一条 `font decrypt verdict: answer as-is`）。⚠️ `_hasUndecryptedFontSecret` 已删（并进 `_probeFontDecrypt`）；判「要不要等」必须问**题目那份文档** —— 问整页就等于让最不相干的帧决定所有人的节奏 |
| 48 | **长题（填空/简答）的答题框完全空着，日志却写着「答案齐了」**（用户原话「长题不答，只答了部分题」；真实日志：`quiz fill audit ok {withValue:3,total:3}` → 交卷 → 回头一看只答对了一半，错的那一半全是长题） | **写和读看的不是同一个东西**：① 写侧 `_fillTextarea` 只往**题目容器之内**的 textarea / input / contenteditable 里塞，而学习通有些长题的可见框是容器**外面的兄弟节点**，或容器里干脆只剩一个隐藏域；② 读侧 `_getQuizQuestionFilledValue` **先看隐藏域**，有值就直接返回，从不看可见框；③ `_fillText` / `_fillTextarea` 又**无条件**写 `#answer{qid}` 隐藏域（平台真正收的那一份）—— 于是审计永远看得见值、看不见空框，一句「没答」都报不出来；④ 模型某一题只回了空答案时，`_fillAnswers` 那一支直接 return，日志一个字不写 | 防线：① 写侧加宽 —— 新增 `_collectAnswerEditableNodes`（容器内文本控件 → `#answer{qid}` 本体就是文本控件时 → 至多 3 层祖先；该层命中多于一题就停，避免写进隔壁题），`_writeAnswerText` 走原型 setter + `input`/`change` 事件，富文本 iframe 用 `_answerToHtml`（**转义后**再进 body，答案里的标签不会当成 HTML 注入）；② 读侧对称 —— 文本类题先 `_readVisibleAnswerText`，**且只对 `fill`/`short` 开**（给选择题开就会误报「已答」）；③ `_fillText` / `_fillTextarea` 现在返回**可见**写入个数，为 0 时 `_logMissingAnswerBox` 把那道题的结构写进日志（每元素只报一次，靠 `_omNoBoxDiagAt` 戳）；④ 交卷前体检从 `_maybeSubmitQuiz` 抽成 `_auditQuizFillBeforeSubmit`，文本题按 `text` / `textVisible` / `textHidden` 三档报，**只提醒、不拦交卷**；⑤ 空答案新增 `quiz answer empty, question left blank`。⚠️ 隐藏域照旧无条件写（不能省，它是平台收的那一份），但它**再也不能单独当作「这题答过了」的证据** —— 判「填上了」必须问眼睛看得见的那个框 |
| 49 | **一份卷子只答了多选题、看着像乱选的，单选反而一题没答**（用户原话「只回答的多选题，估计是乱选的，单选题一题也是空着的」） | #39 那条「多选本地作答、不进请求」省的是 token，**代价是答案必错**：整卷只要有一道多选就基本过不了及格线。而课后检测的提交上限实测只有 2 次（日志 `quiz submit attempt count {count:1,max:2}`），拿猜的答案去交等于**白烧一次真提交**。当时的 `max:2` 之所以没爆成「疯狂提交」，是因为第二趟把多选交回了模型 —— 可用户看到的就是「第一趟全是乱选的多选」 | 多选**与单选同等交给模型**（`_answerLocalMultiChoiceQuestions` 只剩「补填」一个身份，且**幂等**：模型已填好的绝不重填，复选重填会把自己切掉）。只有补填真的动过手，才把这份卷子记进 `_quizLocalMultiplePapers` 并把上限收到 2。`content.js` 的分批同步改：多选自己成批、**不打断正在攒的那一批**（旧写法会让一道多选拖着另外两题成一题一批，固定开销按批计，一份卷子多花十几批的钱）|
| 50 | **屏幕上单选题一题没勾，日志却写 `quiz fill audit ok`** | 与 #48 同族，只是这次栽在选择题上：审计读的是 `#answer{qid}` 与 **`aria-checked`** —— 而 `aria-checked` 是 `_clickOptionItem` **只要有 qid 就顺手给文本项加上的**，没有任何 CSS 认它。等于**自己给自己开的证明**：只要写过，就永远「看得见」 | `_hasVisibleChoiceSelection(el)` 是三档证据的唯一入口（站点 CSS 真会着色的 `check_answer*` / `cur` / `selected` / `active` + 可见的已勾选 radio/checkbox）；看不见时写 `quiz fill: no visible selection in question`（带 `radio`/`visibleRadio`/`markCls`），审计侧写 `quiz fill audit: value without visible selection`。选项控件与文本层分离的那套形状（`.Cy_*`）另有一步**补点文本项**（`radio-clickthrough`）。⚠️ **`aria-checked` 不许再算进证据** |
| 51 | **刚开始还会检测题目，之后直接翻到下一节、然后整页卡住**（用户原话如此；真实日志：`skip completed` → `dismiss popups: click {cls:"… prev_next next fr"}` → 地址变成 `i.chaoxing.com/base` → 只剩 `search job: no attachments…` 与一条 `study stuck` 后彻底静默） | `_dismissPopups()` 整页 `querySelectorAll('button, a, .btn …')` 按文案点，把课程页**常驻**的「下一节」导航当成了弹窗按钮。翻过去的那一页没有课程结构可认，任务点扫不到，而 `study stuck` 每个键只报一次 → 报完永久安静 | 弹窗容器（`.layui-layer` / `[role="dialog"]` / `#workpop` …）之外**一律不点**，带 `prev_next` 的双保险也不点；关不掉就 return，不许拿 `[class*="close"]` 抓整页右上角的关闭按钮。翻页只走自己的路（`_switchToNextLearningCard()` / `#prevNextFocusNext`）。`study stuck` 改为**每 2 分钟重播**并带上当前 `href`。交卷确认框仍**谁都不点** |
| 52 | **一份卷子两个键 → 「只许交 2 次」被绕开、疯狂提交**（真实日志：`quiz submit pending` 里那个键长成 `…123456%7C%7C%7C%7CK777`，中间三段全空；而 ready 那条按题目文档算的键五段齐全） | 交卷确认弹窗那一路传的是 `null`：`_resolveQuizSubmitDocument(null)` 退回**外层文档**，可题目挂在 iframe 里、五个 id 只在**题目那份文档**上。于是同一份卷子有两个键 —— 提交次数记在**外层那本账**，而 `_quizReadyWorkKey`、`_getQuizMaxSubmitAttempts`、`_shouldSkipQuizBySubmitAttempts`、按卷冷却全读**题目那份文档**那本账。上限那条永远读到 0，批次 7 定的「本地兜底过的卷子只交 2 次」形同不存在 | `_getQuizAccountDocument(preferredDoc)` = `preferredDoc \|\| 题目那份文档`（与 ready 那一路**同形**）成为**唯一判据**，写账（`_markQuizSubmitPending`）与读账（`_getQuizSubmitAttemptCount` / `_shouldSkipQuizBySubmitAttempts` / `_getQuizMaxSubmitAttempts` 经由 `_getQuizSubmitAttemptKey`）全部从它出发，调用点没机会各算各的。`_handleSubmitConfirmDialog` 仍显式取一次 `confDoc`（只为让本函数那两条 warn 里的 `currentKey` 就是账本键，**不许手抄第二份表达式**）。日志另加 `readyKey` 与 `accountFrom`，两键不等还会单独 warn `submit confirm key mismatch, continue because quiz is ready`。**只收口提交账**，没动 `_resolveQuizAnswerDocument` 的 `null` 兜底（它喂着十几条读路径）。⚠️ **只改写账端是一次半成品** —— 读账那三路仍是旧口径，症状一模一样。回归＝场景 40 `/submit-key`（14 项）。⚠️ **按文档算键的函数，写账端与读账端必须是同一个文档表达式** —— 与 #43、批次 8 之前那条按卷冷却的 HIGH-1 同族 |

| 53 | **插件在刷课页往课程讨论区真发了一条垃圾回帖**（真实日志 00:46:24 `quiz submit pending` → 00:46:26 `discussion page detected` + 内容「1」；用户看不到自己班群里多了什么） | 三处放宽**叠**起来才成立：① `omitone_return_url` 写完**永不清除** —— 「是我们自己刚从刷课页跳过来的」这条放宽一旦触发就**永久生效**；② 放宽只问正文里有没有「讨论」二字 —— 课程页导航常年挂着这个标签；③ 发帖按钮按文字满页找（含「提交」就行），编辑区取「页面上最大的可见输入区」，**两者互不相干也能凑成「是讨论页」**，而那个「提交」正是卷子刚要点的按钮。根因不是哪一条写错了，是**三条各自「通常没事」的放宽没有一条问「会不会伤到别人」** | 四道闸，缺一都可能复发：`_isStudyCourseHref()` 让刷课/章节/`ananas` 那族网址**永不**走正文放宽；`_discussionReturnFresh()` 把放宽收成**一次跳转的 120 秒**窗口、过期就把两个键一起删；`_findDiscussionSubmitButton(nearEditor)` 要求按钮与编辑区**共用一块不是 body 的容器**（编辑区往上最多 4 层 —— ⚠️ 反向走「谁 contains 谁」是空的，body 永远包含一切）；`_quizInFlightForDiscussion()` 让答题在飞时**根本不进讨论判据**（讨论判据挂在 `_runTick` 最前，OCS 是**另一条并行循环**，两条循环抢同一个按钮）。每一次拒绝都留话：`discussion page declined {reason: study-page / return-jump-expired / no-discussion-text / no-editor / no-co-located-submit}`（30 秒节流）。⚠️ **收紧判据必须配一条「正常页仍能认出」的对照断言**（场景 42），否则「不发帖」和「发不出去」在日志里长得一样 |
| 54 | **已经完成的界面要磨蹭很久才去下一个**（真实日志 00:46:41 `quiz waiting font decrypt {state:"(none)",sweepAgoMs:-1}` → 00:46:49 才发请求，每份卷子白等 8 秒） | `state:"(none)"` + `sweepAgoMs:-1` 不是「解得慢」，是 content.js 那次解密扫描**根本没跑到这一份文档** —— 等满窗口一个字也不会多解出来。批次 5 把「要不要等」收成问题目那份文档，但**没区分「在扫但没扫完」和「压根没扫」** | `sweepNotCovered` 时上限从配置值收窄到 `scaledMs(2500)`，超了就照答并 warn `font decrypt pending over limit, answer anyway`，那条日志同时带 `limitMs` 与 `configuredLimitMs`（本轮实际用了什么上限、用户配的是什么，一眼对得上）。⚠️ **有扫描戳的文档仍等满原窗口** —— 这道宽限只关「未覆盖」，不许改成「整体不等」（场景 43 有对照组钉住） |
| 55 | **整节被按住不动，日志里一直刷 `study hold quiz before finish`**（真实日志连着十几条，`pending:{total:0}`） | OCS 收尾循环问的是「还有没有题要做」，答话的却是另一句「判据说有」；而**具体数题**那一路一道容器都没收着（`total:0`）。于是「我自己没数出来」被当成「还有题要做」，为 0 道题按住整节 | 判据抽成 `_shouldHoldQuizBeforeFinish(pendingDesc)` 并**只留一份**：`pendingDesc` 拿不到、`total≠0`、`_quizInProgress`/`_quizSubmitPending` 在飞 —— **三条一律照旧 hold**（宁可慢，不能因为自己数漏就跳必做的题）；只有「`total:0` 且确实没有在飞的答题动作」才放行，并 warn `study quiz hold skipped: nothing pending to wait for`。为什么数不出来不再靠猜：`_diagnoseQuestionScan()` 在容器为 0 时给 `dropStages`（每个选择器 `matched/filtered/deduped/unparsable`） |
| 56 | **一份卷子做了、同一页的第二份不做**（真实日志 00:46:55 `frames:8`：4 个 `javascript:void(function(){document.open` + 3 个 `javascript:` 全被拒成「认不出任务类型」） | 旧日志只给帧的 `src` 前 40 字 —— **判不了那是空帧还是第二份卷子**，而这两件事的处理方向完全相反。没有证据就放宽类型准入，代价是别的帧跟着被误收 | `_frameRejectSignature()` 给「认不出类型」与「取不到 jobid」两条拒绝各带一份内容签名 `{text, qHit, video, answer, frames, pan, signals}`；题形命中数**走 `_questionSelectors` 真源**（手抄类名会被 check 的「题目选择器真源守卫」拦）。⚠️ **这一批只取证、不改判据** —— 等真实日志里的签名说话，下一批再决定放不放宽准入 |
| 57 | **视频弹题的「答案」到底是从哪儿被站点读走的**（批次 75 现场读回来的正典，改弹题链路前必读） | 现场那道判断题 A 与 B 先后都被判「回答错误」，而 DOM 里被点中的 radio 确实 `checked:true` —— 判断题必有一个正确项，两次都错只能说明**平台没收到我们选的那一项**。而我们的代码里从来没有一句话说明"站点按什么收答案"，全靠猜（猜过 `input.value`、猜过 `.tkTopic_con` 里的文本） | 站点自己 `videojs-ext.min.js` 里的 `checkResult` 才是真源，它做的事是：`Ext.query('input', this.el.dom)` 拿**它自己那份 el 里的 input**，逐个看 `input.checked`，命中的按**下标**去 `this.data.options[idx].name` 取值，`join(',')` 成 `answerContent` 提交。三条推论：① **`input.value` 全程不参与**（现场两个 value 都是空串，正常），所以按 value 匹配/改写都不承重；② 提交读的是**组件那一份 DOM** —— 我们点的那份 `.tkTopic` 只要不是 `cmp.el.dom`，`checked` 就是给旁观者看的；③ 站点每轮**整层重绘**弹窗（现场同一道题的内层 id 从 `ext-gen1066` 变成 `ext-gen1069`、`tabindex` 3→4），点击与提交之间隔着一次重绘就等于没点。⚠️ **这三条还没被正向证据钉死**：`Ext.ComponentQuery.query('*')` 里没找到持有 `.tkTopic` 的组件（可能是探针用错，也可能是弹窗真是静态 markup），所以下一批先用 XHR 记账本把那一发**真发出去的 `answerContent`** 抓出来 —— 空串=通道断了，带字母=回到答案质量那条线 |
| 58 | **连着几道判断题时，平台刚把 A 判成对的，我们的名单里 A 与 B 却都是错的**（批次 77） | 判断题的选项永远是「对 / 错」，而 `_popupQuizFingerprint` 只看 class 加选项文本 —— 同一节里连着几道判断题的指纹**完全相同**。钱那把尺（`asks` / `silent` / `gives`）共用一份本来就该（封顶按选项族算），但**拉黑**也按它记，就会把**上一道**被判错的字母算到这一道头上 | `_popupQuizRejectKey(key, stem)` 是第三把尺：只有 `rejected` 按它记账，其余四格仍留在粗指纹上，所以**收窄名单一分钱都不多花**。⚠️ 判"这一道有没有自己的题干"看的是 `_popupQuizStemMark` 剥完之后是否为**空串** —— 站点那句「回答错误，请重新作答」就长在题干那一块里，**标点也得剥**（上一版只剥空白，剩一个全角逗号就被当成"有题干"，于是名单按粗指纹走、日志却还说"只算这一道"）。`scoped` 那一格一律由 `_popupQuizScopedFlag(stem)` 读回来，五处日志与诊断共用这一处 |

---

## 7. 调试手册：症状 → 病因 → 查哪里

| 症状 | 先查 |
| --- | --- |
| AI 一直读不到题 | 三条线索依次排除：① 日志有没有 `quiz scan found 0 questions`（扫描失败，转 `xxtAI.diagnose()`）；② `enableQuiz` 是否被硬守卫跳过 —— 见 §6 #27（**表单没保存**是最常被忽略的原因）；③ 是否卡在某个标题含「作业/考试」的章节不动 —— 见 §6 #26 |
| **日志报 `font decrypt miss` / 同一卷反复不答** | 字体反爬两层守卫在工作：解密没完成时抽题先等（`quiz waiting font decrypt`）；映射表缺字形时这一卷被按住（`quiz text garbled by font decrypt` → 连续 3 轮后 `quiz paused: text stays garbled`，**这一卷暂停 90 秒再试，不翻走整节**）。⚠️ 缺字形的题面是**通顺但错误的中文**（肉眼难察觉），自动按住是止损，根因与解法见已知缺陷 #6 |
| **报错看不懂、不知道该查什么** | 报错已按根因分类（`libs/api-error.js` 统一出口）：【账户余额不足】→ 去充值、【API Key 无效或无权限】→ 重新生成整段复制、【触发限流】→ 等自动退避、【服务商服务端故障】→ 等恢复、【连接不上服务商】→ 才是真网络问题。每条都带服务商原话与 HTTP 状态码 —— 弹窗测试、页面日志、状态面板同一套口径 |
| **视频里弹出题后一直空转**（AI 在扫描但不填空） | 见 §6 #31。先跑 `xxtAI.diagnosePopup()` 看弹窗结构/选项/推断字母；日志里找 `popup quiz answer matched no option`（匹配失败）与 `popup quiz unanswerable, stop asking model`（已放弃） |
| **题答对了，但视频右下角还有个「继续学习」不点就卡着** | 见 §6 #32。日志里找 `click continue-study prompt`（点到了）与 `continue-study button did not respond`（点了没反应，已停手）。若你的模板文案不是「继续学习/继续观看/继续播放」，把 `xxtAI.diagnosePopup()` 的输出贴到 issue |
| 答案填了不提交 | `_areQuizAnswersFilled` 的判定；隐藏域 `#answer{qid}` 是否被写入 |
| **多选题只选一个就卡住 / 一直选不对** | 见 §6 #33。日志里找 `multiple choice answer expanded locally`（本地把单字母扩成两项）、`multiple choice combos exhausted, keep wrong history`、`quiz filled best-effort guesses for repeatedly-wrong questions`（已放弃折腾这道题、改填本地猜测让整卷交出去） |
| **一份测验里多选总有一道空着、整卷反复重来** | 见 §6 #39。日志里找 `multiple choice answered locally, not sent to llm`（正常 —— 说明多选没进请求、省了 token）；若是 `local multiple choice skipped, keep for llm`，说明这道题**读不到选项字母**，已照旧交回模型。想确认「多选真的没发出去」，看提示词里有没有 `｜m｜` 这一档题型代号 |
| **一份卷子交个没完（没过 → 重做 → 又交）** | 见 §6 #40 / #49。日志里找 `multiple choice filled locally as refill`（这一卷有靠猜补上的多选 —— 上限才会收到 2）；再找 `quiz submit attempt count` 的 `max`：补填过的卷子是 **2**，其余仍是配置值。若看到「未达到及格线 / 请重做」反复出现，就是这一条。⚠️ 旧那句 `local multiple choice only counts for the first attempt, hand back to llm` 已随批次 7 删除，日志里不会再有 |
| 换了模型就一直 400 | 见 §6 #34。日志里找 `llm rejected thinking params, retry without them`；把思考强度那一行的**上下限都收回「关闭」**即可（关闭档对认不出的渠道不发任何参数） |
| **Key 填错 / 模型名写错，却表现成「每隔 45 秒卡一下」** | 见 §6 #36。日志里找 `quiz llm rejected permanently, no retry`，后面跟着服务商原话（如 `Invalid API key`）。它**不会**再进 45 秒退避，改好配置后下一轮自动恢复 |
| **作业 / 考试页点了选项却一个都没选中** | 见 §6 #35。这类页面用的是 `.Cy_*` 结构（选项文本与可点控件在两个分开的 `ul` 里），日志会写 `clicked option` 但 DOM 里没有选中项 |
| **点了选项、日志也写了 `clicked option`，但隐藏域 `#answer{qid}` 是空的** | 见 §6 #37。控制台跑 `_xxtApp._getQuizQuestionFilledValue(null, _xxtApp._extractQuestions(null)[0])`：返回空串就是没写上。这类页面 qid 在容器上、且没有 `.num_option` 徽标 |
| **提交后一直停在 `waiting quiz submit result`，然后整页重载、重扫重答重交** | 见 §6 #38。先看结果页长什么样：`document.body.innerText` 里有「我的答案 / 正确答案」且 `document.querySelectorAll('.Py_answer').length > 0`，说明是判分结果页 —— 旧判据对它是瞎的。日志里找 `quiz submit wait timeout` |
| **刚交完一份卷子就 `skip completed` + 点「下一节」，同一页另一份卷子一个字没答** | 见 §6 #46。`skip completed` 现在带 `by:` —— `by:"text-marker"` 就是那句页面级文案赢过了未完成任务点的证据（本条已修，修前它什么都不会说）；`by:"all-tasks-finished"` / `"catalog-marker"` 才是真有依据。日志里同时找 `quiz held: nothing answered this round`，它的 `reason:` 说明这一轮凭什么没答：`force-skip`（这份卷子正在按卷冷却）/ `in-progress`（上一轮还没结束）/ `answered`（自认已答完 —— 若页面上是一批完全不认识的 qid，会紧跟一条 `quiz paper switched by question identity` 把它重置） |
| **每份卷子进来都先卡 8 秒左右才动**（日志 `font decrypt pending over limit, answer anyway`），或反过来反馈「它连解码都没有」 | 见 §6 #47。现在这条 warn 带着 `state:` 与 `sweepAgoMs:`，两种根因分得开：`state:"(none)"` / `sweepAgoMs:-1` = 解密扫描**没跑到**这一份文档；`state:"nodecl"` = 这份文档里没有字体声明（本来就没有可解的东西）；`state:"nomap"` = 表没加载或字形全部未命中。后两种是**终局判据**，1.3.0 批次 5 起不再白等（改写成 `font decrypt verdict: answer as-is`，30 秒一条）。范围也已收成题目那份文档，边上装饰帧的残留不再拖慢所有人 |
| **长题（填空/简答）页面框里一个字没有，日志却说「答案齐了」**（`quiz fill audit ok` 里 `withValue` 等于 `total`） | 见 §6 #48。三条日志分开看：`quiz fill: no visible answer box in question` = 插件**找不到看得见的那个框**（带 `tag`/`cls`/`textarea`/`editable`/`iframe`/`answerFieldIsVisibleBox`/`html`，`answerFieldIsVisibleBox:true` 说明 `#answer{qid}` 本身就是个文本框）；`quiz fill audit: text answer not in a visible box` = 隐藏域有值、可见框空着（审计那侧的同一件事）；`quiz answer empty, question left blank` = 模型这一题**只回了个空**，不是插件没写。控制台可直接跑 `_xxtApp._readVisibleAnswerText(_xxtApp._extractQuestions(null)[0]._element)` 看插件读到了什么 |
| **整卷只答了多选、像乱选的，单选反而空着** | 见 §6 #49。批次 7 之后多选与单选同等交给模型；日志里若还有 `multiple choice filled locally as refill`，说明这一卷确实靠猜补过题（`quiz submit attempt count` 的 `max` 会收到 2）。要确认那份改动进了浏览器，看 `start` 那行的 `build` 里有没有 `multi-llm-first` |
| **屏幕上单选没勾、日志写 `quiz fill audit ok`** | 见 §6 #50。日志找 `quiz fill: no visible selection in question`（带 `radio` / `visibleRadio` / `markCls`）与 `quiz fill audit: value without visible selection`；`visibleRadio:0` 而 `radio:>0` 就是「控件与文本层分离、补点没生效」 |
| **一开始还检测题目，之后直接翻到下一节、然后卡住** | 见 §6 #51。日志里找 `dismiss popups: click` —— 它的 `cls` 若带 `prev_next`，说明点的是常驻导航（批次 7 已禁止）；再看 `study stuck`（每 2 分钟重播，带 `href`）与 `search job: no attachments and no synthetic job` |
| **一份卷子没过就一遍遍重交，`max` 明明写着 2 却交不完** | 见 §6 #52。批次 8 之后 `quiz submit pending` 同时带 `key`、`readyKey` 与 `accountFrom` —— 两键**相等**就是记账与读账同一本账（正常），`accountFrom` 说明这次记账的文档是谁给的（`caller` / `questions` / `fallback-document`）；**不等**会另发一条 `submit confirm key mismatch, continue because quiz is ready`，那说明又有地方绕开了 `_getQuizAccountDocument`（比如弹窗出现后题目换了文档）。日志里那个形如 `…%7C%7C%7C%7C…`（中间三段全空）的键是**外层文档**算的，它不是卷子身份，只是旧写法留下的证据 |
| **班群里冒出内容「1」的垃圾回帖 / 卷子的「提交」被讨论链路点掉** | 见 §6 #53。批次 9-A 之后日志会写明是**哪一道闸**拒的：`discussion page declined {reason: study-page}`（刷课页网址，永不放宽）/ `return-jump-expired`（不是我们自己两分钟内的跳转）/ `no-discussion-text` / `no-editor` / `no-co-located-submit`（按钮与编辑区不同容器）。一条 `declined` 都没有、却在刷课页看到 `discussion page detected, posting reply` = 又有代码绕开了这四道闸 |
| **在已经完成的界面磨蹭很久才去下一个**（每份卷子进来先卡好几秒） | 见 §6 #54。日志里 `quiz waiting font decrypt` 现在带 `waitLimitMs`，`font decrypt pending over limit, answer anyway` 带 `limitMs` + `configuredLimitMs`：两个数**不一样**说明走了「扫描未覆盖」的短宽限（2.5 秒，批次 9-B）；两个数**一样**且仍等满，说明那份文档有扫描戳但确实解不出来 —— 那是字形表覆盖问题，不是等待窗口问题（另见 §6 #47） |
| **整节被按住不推进，日志反复刷 `study hold quiz before finish`** | 见 §6 #55。看它带的 `pending:{total:N}`：`N>0` 是真有题没答完（正常等待）；`N:0` 且没有在飞动作时批次 9-C 起会改写成 warn `study quiz hold skipped: nothing pending to wait for` 并继续收尾 —— 这一条还在刷，说明 `_quizInProgress` / `_quizSubmitPending` 卡住了（超 5 分钟会自愈并 warn `quiz in-progress state leaked, reset`）。为什么一道都数不出来，看上一条 `quiz scan found 0 questions` 的 `dropStages` |
| **一份卷子做了、同一页第二份不做**（`search job: every candidate frame was rejected`） | 批次 9-D 起，`rejects` 里每条带 `sig`：`sig.text` 是帧内正文前 60 字、`sig.qHit` 是各题形选择器命中数、另有 `video` / `answer` / `frames` / `pan`。**空帧**的签名 text 为空且命中全 0；**藏着第二份卷子**的帧会直接把题干文字打出来。判据本身这批没放宽 —— 拿着真实签名再决定下一步（见 §6 #56） |
| **页面每隔二十来秒自己整页刷新、下面的任务点（录音 / 音频）一直出不来** | 批次 35。这是**主内容帧读不到**那一族：日志里 `main frame unreadable`（批次 44 前叫 `main frame is cross-origin`，现场发现那个标题会在「两个地址一模一样」的格子上跟自己打架，已改名）带 `sameSite` / `sameOrigin` 两个字段，把三种情况分开 —— ① `sameSite:true` 且 `sameOrigin:false` = 帧还在课程站自己的另一台机器上（平台的验证 / 反爬中间页），刷新有机会解决，现在一轮最多刷 3 次、刷不动就停 30 分钟（旧写法把「刷过几次」记在页面内存里，而自己那一下刷新正好把它抹掉，于是**永远刷不完**）；② `sameSite:true` 且 `sameOrigin:true` = 属性上的地址与本页**完全相同**却读不到（`src` 属性只记「当初想让它去哪」，帧自己在里面导航走之后属性不更新，批次 44 现场实测到这一格）—— 同属①那一类处置；③ `sameSite:false` = 帧被换成**别家**地址（浏览器的跟踪防范 / 广告拦截扩展 / 网络代理，或登录被顶掉），刷完还是它，现在**一次都不刷**、只把这条建议打在同一行日志里。同一刻的 `study search skipped: main frame document unreadable` 说明「清单认到 N 个任务点、一个帧都没配上」到底是为什么 |
| **验证码弹窗刷了三轮还过不去，却还在一页页刷、识别费一直涨**（或「每章看图额度像每次都重新发满」） | 批次 36。与上一条同族：**账以前记在页面内存里，而刷新正好把内存抹掉**。现在两本账都在 sessionStorage —— `omitone:captcha-dialog-budget`（`{rounds, pauseUntil, href}`）与 `omitone:vision-budget`（`{chapter, used}`，按章）。日志按顺序读：`captcha unsolved, reload page {round:n}` → 到顶 `captcha dialog unsolved after 3 page reloads, stop spending`（带 `resumeInMs`，hint 说「亲手输一次 + 换会看图的模型」）→ 冷却期每轮只播一条 `captcha dialog paused, waiting for a human`。清账有三处：认对了、`href` 变了、弹窗**连续 60 秒**不再被检测到（`captcha dialog gone, retry budget reset`；只漏看 11 秒不算，检测抖动不许拆安全阀）。若这台浏览器存不住会话数据（无痕 / 禁用本站 Cookie / 嵌套页第三方存储限制），会有一条**只播一次**的 `session storage unavailable, retry budgets reset on every reload`：插件退回本页内存照样限额，但账随刷新清零，这时请手动关掉对应开关 |
| **某一节的视频从头到尾不动、整节不往下刷，也不报错** | 批次 40。这一族的形状是播放器元素**从来没有挂上源**（`readyState 0 / networkState 3`、拿不到 `duration`、`ended` 永远是 false），而旧的等待判据只在「播完了」那一路收口，于是「媒体还在等」恒真 —— 现场实测整节停摆 12 分钟、日志照常在打（它不是崩溃，恰恰是最看不出来的那一类）。现在这类等待**有界**：最多等 120 秒（和设置里文档等待上限同一把尺 `documentSkipTimeoutMs`），到点放手让这一节继续推进，并落一条 `media has no source, release pending` 的 warn，带 `readyState / networkState / heldMs / src`。看到这条只有两种处理：源地址过期 → 刷新这一页；这一节压根没有能播的视频 → 自己在页面上点一次播放看看 |
| **视频播到一半再也没声音、进度那一格一动不动，可日志每条都写着 `playing`** | 批次 50，自愈部分批次 62-B 加强。这一族与上一条**正好相反**：`readyState 4`、时长有、`paused` 是 false、`ended` 是 false —— 能播的迹象全在，唯一说真话的是 `error.code`（现场那次是 3，`PIPELINE_ERROR_DECODE`：解码管线死了），`currentTime` 从 628.771 起将近一刻钟一格没动。上一条的有界放手**看不见它**（那条要 `readyState 0`），巡检那 5 发 `play()` 也全白烧（管线死了不给 `play` 事件，配额就永不复位，烧光之后一动不动）。现在三件事：① 认出 `error.code` 就**原地重载**（真的 `load()` + `play()`，而且**排在** `play()` 配额那三道闸之前），按源记账做**有界重试**：最多 3 次、相邻两次间隔不低于 20 秒。第一次回到死掉那一秒（纯网络抖动不该白丢进度）；**第二次起跳过坏包** —— 那个位置就写在 `error.message` 里（`{timestamp=<微秒>}`，换算成秒后往前 12 秒，并按距离结尾 10 秒夹紧），因为现场实测「回到原位再撞同一个坏字节」正是第一次重载花掉唯一机会的方式；② 三次都用尽或压根没救回来 → 与上一条同款**有界放手**，同样最多等 `documentSkipTimeoutMs`，到点落一条 `media pipeline dead, release pending` 的 warn，带 `code / message / 位置 / heldMs / reloaded / reloadTimes`；③ 等待日志的签名多出第三态 `broken<code>`、正文带 `errCode` —— 诊断工具从此不许把死管线说成「在播」。⚠️ 另有一条实测：这一族的源站 `s2.cldisk.com` **不回 CORS 头**，所以「重新拉一份源」那条补救（`_maybeRepairMediaSource`）对它永久无效，只能原地重载 |
| **右下角写「异常运行 / 视频播放失败」，可视频下一拍照样往前跳** | 批次 44。站点自己的播放器在同一刻调了 `load()` / `pause()`，插件这一下 `play()` 被打断 —— 这**不是**「这个视频看不了」。现在这一族改发 warn `media play interrupted by site player`，面板写「等待中 / 站点播放器打断了一下，正在重新接上」；**真播不了的音源仍然发 error `media play failed`**、面板仍是「异常运行」。分不清就看这一条之后 `currentTime` 走不走：走就是被打断，不走才是真失败 |
| **日志被同一句 `media pending, delay completion` 刷满，回头查「那一节为什么被跳过」时前面的都没了** | 批次 37。扩展里那份日志是**最近 200 条**的环形缓冲，所以刷屏等于直接缩短证据窗：现场实测 12 分钟 1422 条里 1392 条、最近 200 条里 196 条都是这一句 —— 只留得住约 100 秒。原因是节流的「签名」里混进了**调用方标识**（`reason`），两个调用方交替问同一个视频时签名每秒都变，「签名变了就补一条」这道本意去重的闸被自己绕过。现在签名只剩播放状态（`paused` / `playing`，批次 50 起再加一档 `broken<code>`），`reason` 回到日志正文里当证据，另加 **5 秒下限**挡住平台把状态来回抖几格；30 秒心跳照旧 —— 「看得出 `currentTime` 在走」那只手留着 |

> **2026-09 复现：同一条又出现了。** 所以上面那套判据**和真实判分页仍然对不上**。
> 现在不用猜了 —— `quiz submit wait timeout` 那条日志会把**三道判据各自的结果**打出来
> （`_describeQuizResultPage`）：`redoText` / `gradeSelector` / `gradeText` /
> `containers` / `controls` / `controlsEnabled` / `keywords`。
> 拿它跟**真实判分页**比一比，缺哪一块一目了然：
>
> - `gradeText: false` 且 `gradeSelector: ''` → 判分痕迹的判据没覆盖真实页面
> - `controlsEnabled > 0` → 平台**没有**禁用控件，第三条判据太严
> - `redoText: true` → 平台真的在说「请重做」，那是**答案错**，不是判据问题
>
> 另外两条日志用于分清「谁写的隐藏域」：`submit payload`（含 `mapped`，
> 一眼看出我们认的题型与平台 `answertype` 是否一致）、`answer field written … ours=`。
| 答题报「API 不可用」但弹窗测试是通的 | 区分网络失败与 `parseError`（后者**不该**写 `apiConnectionFailed`，否则会陷入「跳过 → 不再请求 → 标志无法自愈」的死循环） |
| 验证码识别出来是空 | 日志写 `验证码识别返回空回复（结束原因 …）`，**结束原因就是说给谁的**：`length` = 思考把输出的预算占满了（把思考强度各行上下限收回「关闭」即可）；`无` 或其它 = 该模型不带视觉（`captchaModel` 填的型号换成带视觉的，留空会回退主模型） |
| 验证码一直失败 / 401 | **API 地址留空时插件一个请求都不发**，日志直接说「API 地址没填」（避免把你的密钥发给一个你没选过的厂商）。地址填了仍失败时，日志会点名是哪台主机拒的（`目标 api.deepseek.com`）——401 就该看那一家而不是怀疑插件 |
| 某个任务点一直做不完 / 一直在耗时间 | `xxtAI.taskGiveUpList()`；日志里 `task point stuck` / `task point given up` |
| 讨论任务点没做 / 重复发评论 | 日志 `discussion task opened in new tab`、`discussion page detected, posting reply`、`discussion task has no usable entry`。**整节一条都没发出去**时看这两句：`discussion topic url not resolved {reason}` 直接点名断在哪一环（`no-chapter-url` 读不到话题页 / `fetch-failed` 话题页没回话 / `no-topic-card` 回话里没有卡片 / `server-says-finished` 平台自己已记完成，这一条**不发帖是对的**）；`discussion nothing pending {total,serverFinished,believeLocal}` 里 `serverFinished` 那格就是平台判完的个数 |
| 日志停在某一条 | §6 的 #1 #2；搜 `tick watchdog` |
| 窗口最小化后几乎不动 | 后台节流四层防线（Worker 心跳 / 音频保活 / `pause` 事件直接恢复 / 回前台重校验）。1.3.0 起音频保活**只要插件在跑就顶着**（旧形状只管视频在播那一段，于是播完等翻页、文档 / PPT / 讨论 / 投票这些没有媒体的区间在后台会被整个冻住）。若仍停滞，检查 `edge://settings/system` 是否开了「睡眠标签页」——那是整页冻结，插件侧无法绕过；日志出 `audio keepalive stayed suspended` 则是浏览器没给这一页播放授权，这条音轨根本没响 |
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
| 日志写入/清空、队列、元数据规整 | 根目录 `runtime-log-store.js`；`background.js` 保留真实身份判定和带超时的存储能力 |
| 任务点类型识别（视频/音频/文档/图片/测验/投票） | `src/page/60-tasks-detect.js`：`_classifyTaskFrame` / `_getAttachmentWorkType` / `_buildAttachmentOnlyJob` |
| 任务点搜索（OCS / iframe / 附件列表） | `src/page/60-tasks-detect.js`：`_searchChaoxingJobOcs` / `_searchIFramesOcs` / `_getChaoxingAttachments` |
| 任务点执行（跑视频/阅读/PPT音频） | `src/page/62-tasks-run.js`：`_runChaoxingJob` / `_runChaoxingReadJob` / `_runPptAudioJob` / `_runOcsStyleStudy` |
| 文档类任务点（翻页 / 滚动） | `src/page/62-tasks-run.js`：`_locateDocumentTask` / `_buildPagedDocumentTask` / `_buildScrollDocumentTask` |
| 做不完的任务点跳过 | `src/page/64-tasks-loop.js`：`_taskProgressSnapshot` / `_countTaskIncomplete` / `_isJobCompleted` |
| 任务点调度（主循环） | `src/page/64-tasks-loop.js`：`_runTick` / `_tick`（⚠️ 判定顺序＝仲裁顺序） |
| 学习卡片（小节）切换 / 下一节 | `src/page/64-tasks-loop.js`：`_getLearningCards` / `_switchToNextLearningCard` / `nextUnit` |
| **「这一节做完了没有」** | `src/page/60-tasks-detect.js`：`_isCurrentCompleted` / `_getVisibleTaskCompletionState` / `_completionEvidence`（⚠️ **判据顺序**：未完成任务点的证据 > 「任务点已完成」那句页面级文案；判完必须留下 `by:`，见 §6 #46） |
| 题目抠取 | `src/page/75-quiz-dom.js`：`_collectQuestionContainers` / `_parseQuestionElement` / `_getOptionItems`（**选择器真源都在 `10-config-state.js`**：`_questionSelectors` / `_quizDetectorSelector` / `_questionTitleSelectors` / `_optionListSelectors` / `_quizContainerSelector` —— 真源之外手抄会被 `npm run check` 报红；改版应急走 storage 的 `questionSelectorOverrides`） |
| 答题与提交 | `src/page/70-quiz-flow.js`（`_handleQuiz` / `_extractQuestions`）+ `src/page/75-quiz-dom.js`（`_fillAnswers` / `_areQuizAnswersFilled` / `_maybeSubmitQuiz` / `_auditQuizFillBeforeSubmit`） |
| **往答题框里写字 / 读回写了没有** | `src/page/75-quiz-dom.js`：`_fillText` `_fillTextarea`（写，返回**可见**写入个数）→ `_collectAnswerEditableNodes`（找框：容器内文本控件 → `#answer{qid}` 本体 → 至多 3 层祖先）→ `_writeAnswerText` `_answerToHtml` `_isAnswerTextControl`；读回用 `_readVisibleAnswerText`，审计用 `_getQuizQuestionFilledValue` / `_auditQuizFillBeforeSubmit`，找不到框用 `_logMissingAnswerBox`。⚠️ 见 §6 #48（写和读必须看同一个东西，隐藏域不能单独当证据） |
| 提交监控 / 提交次数跳过 | `src/page/70-quiz-flow.js`：`_monitorQuizSubmit` / `_shouldHoldQuizBeforeNext` / `_shouldSkipQuizBySubmitAttempts` |
| 「页面上已经换了一份卷子」 | `src/page/70-quiz-flow.js`：`_syncQuizPaperRunState`（任务点 id 那条路）+ `_isQuizPaperChangedInDom`（**题目 qid 那条兜底**，新旧完全不重叠才 true）+ `_resetQuizStateForSkip` |
| 「等不等解码 / 解码为什么没成」 | 判据在 `src/page/70-quiz-flow.js`：`_probeFontDecrypt(题目文档)`（一次遍历收 `secret` / `miss` / `terminal` / `state` / `sweepAgoMs`）；**证据由解密层写**：`content.js` 的 `decryptSecretFontsInDocument` → 每份文档的 `data-om-font-state`（clean / plain / nodecl / nomap / partial / done）+ `data-om-font-sweep` 时间戳 + `font decrypt verdict` 日志。扫描节奏在 `content.js` 的 `scheduleDecryptSweep`（有界防抖：300ms 防抖 / 最长 2 秒必跑 / 至少隔 400ms）与 `runFontDecryptSweep`（`decryptSweepRunning` 防并发）。⚠️ 见 §6 #47 |
| 答案缓存（交卷后记答案） | `src/page/72-quiz-answers.js`：`_rememberCorrectQuizAnswers` / `_isQuizQuestionMarkedCorrect` / `_extractDisplayedCorrectAnswer` |
| 候选答案 / 避开已知错答 | `src/page/72-quiz-answers.js`：`_getChoiceCandidateAnswers` / `_generateChoiceCombinations` / `_avoidKnownWrongAnswer` |
| 视频、倍速、seek | `src/page/40-media.js`：`_playChaoxingMediaJob` / `_ensurePlaybackRate` / `_trySeekToEnd` |
| 验证码 | `src/page/50-captcha.js`：`_checkCaptchaDialog` / `_handleCaptchaDialog` / `_runStandaloneCaptchaMode`；弹窗刷新那一下单独抽成 `_reloadCaptchaDialogPage`（最贵的动作要能被测试盯住），轮次账在 `_readCaptchaDialogBudget` / `_writeCaptchaDialogBudget` / `_healCaptchaDialogBudget` |
| 讨论任务点 | `src/page/65-discussion.js`：`_discussionModuleName`（两代模块名）/ `_collectDiscussionTargets` / `_findDiscussionModuleFrames`（第 2 步找模块 iframe，按节点去重）/ `_findDiscussionTask` / `_logDiscussionResolveFail`（四个出口点名）/ `_tryDiscussionTask` / `_runDiscussionMode` |
| 弹题（视频内嵌题） | `src/page/80-popup-quiz.js`：`_checkPopupQuiz` / `_handlePopupQuiz` / `_fillPopupAnswer` |
| 读图（视觉） | `src/page/74-quiz-vision.js`：`_takeVisionBudget` / `_collectQuestionImages` / `_applyVisionToQuestions` |
| 日志与诊断文案 | `src/page/30-log.js`；日志出口 `emitRuntimeLog` 在 `src/page/00-shell-constants.js` |
| 跨域 iframe 安全访问 | `src/page/20-dom.js`：`_safeDocOf` / `_safeWinDoc` |
| 主内容帧读不到（整页反复自刷 / 任务点全被跳过） | `src/page/20-dom.js`：`_checkBlockedByCrossOrigin` / `_isFrameSameSiteAsTop` / `_readBlockedReloadBudget`（刷新账在 sessionStorage，键 `omitone:blocked-reload-budget`） |
| **「刷过几次」这笔账要活过一次刷新**（凡是自己刷自己的重试循环都用它） | `src/page/20-dom.js`：`_sessionLedgerUsable` / `_readSessionLedger` / `_writeSessionLedger` —— 一次**写-读探针**定档（只看写成功不算，有些环境写不报错、读回来是空），存不住就退回本页内存并只播一条 warn。四本账：`omitone:blocked-reload-budget`（批次 35）、`omitone:standalone-captcha-budget`（14-A）、`omitone:captcha-dialog-budget`（批次 36-A，读写封装在 `50-captcha.js`）、`omitone:vision-budget`（批次 36-B，按章，判据在 `74-quiz-vision.js` 的 `_takeVisionBudget`） |
| 状态字段、配置默认值 | `src/page/10-config-state.js`（**声明式的非方法属性都在这里**；另有约 30 个字段是惰性初始化的，用 `node tools/audit-fields.js` 列全量） |
| 设置界面 | `popup/popup.js` + `popup/popup.html`（**记得同步 `src/page/00-shell-constants.js` 的 `DEFAULT_CONFIG`**） |

> **改完记得跑 `npm run concat`** —— 根目录的 `page.js` 是拼出来的产物，
> 只改 `src/page/` 而不拼接，浏览器加载的还是旧的。
> 更细的「哪个文件负责什么」见 [`src/page/README.md`](src/page/README.md) 的模块地图。

### 从「我要改倍速」到 `40-media.js`，一步到位

这就是这次拆分要达到的效果 —— 上面那张表按**域**指，每个域一个文件：

| 文件 | 负责 |
| --- | --- |
| `00-shell-constants.js` | IIFE 外壳、常量、`DEFAULT_CONFIG`、日志出口、桥接与存储工具 |
| `10-config-state.js` | app 入口（`run` / `play` / 重置）+ 配置 + **全部状态字段** |
| `20-dom.js` | DOM / iframe 安全访问 / 通用工具 |
| `30-log.js` | 日志与诊断文案（所有 `_log*` / `_describe*` / `_diagnose*`） |
| `40-media.js` | 视频 / 音频 / 倍速 / seek |
| `50-captcha.js` | 验证码（弹窗 + 整页） |
| `60-tasks-detect.js` | 任务点**识别与搜索**（找这一章还有哪些没做） |
| `62-tasks-run.js` | 任务点**执行与等待**（含文档任务点翻页 / 滚动） |
| `64-tasks-loop.js` | **主循环** / 放弃名单 / 学习卡片切换 |
| `65-discussion.js` | 讨论任务点 |
| `70-quiz-flow.js` | 答题**整卷流程** / 抠题 / 提交监控 / 按次数跳过 |
| `72-quiz-answers.js` | **答案缓存** / 规范化 / 候选与避开错答 |
| `74-quiz-vision.js` | **读图（视觉）** / 预算闸门 |
| `75-quiz-dom.js` | 填答 / 提交确认弹窗 |
| `80-popup-quiz.js` | 视频内嵌弹题 / 「继续学习」提示 |
| `90-console-api-startup.js` | app 收尾、`window.xxtAI` 控制台入口、启动 |

> 任务点与答题各占三个文件，顺序就是 `识别 → 执行 → 循环` 与 `流程 → 答案 → 读图`。
> 剩下最大的三个是 `75-quiz-dom.js`（1365 行）、`40-media.js`（1095 行）、
> `70-quiz-flow.js`（1042 行）—— 还能再分，但收益已明显变小；
> 真要分就**一次只搬一个子域、搬完立刻跑 `npm run e2e`**。

需要方法清单时（不用通读）：

```bash
grep -nE '^    _?[A-Za-z][A-Za-z0-9_]*: (async )?function' src/page/*.js
```

---

## 9. 新增配置项的完整清单

缺任何一处都会出现「开关存了但读不到」。照抄 `enableDiscussion` 或 `enableCaptcha`：

- [ ] `src/page/00-shell-constants.js` → `DEFAULT_CONFIG`（**然后跑 `npm run concat`**）
- [ ] `src/page/` 里对应的片段 → 消费点（**要加开关硬守卫**，如 `if (!this.configs.enableXxx) return;`）
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
npm run concat   # 把 src/page/*.js 拼成根目录的 page.js（改了片段之后必须跑）
npm run concat:check  # 只校验产物与片段一致（npm test 里已含这一步）
npm run check    # 工程自检：语法 / manifest / 版本一致性 / 编码损坏 / 幽灵调用 / 死方法 / 死代码 / 唯一真源 / 产物与片段一致 / 片段头部一致 / await 可超时 / 选择器大小写一致 / 独立套件挂载
npm run bench    # 提示词 token 基准（三代对比 + 信息完整性自检）
npm run itest    # 集成测试：真实 content.js 的答题往返（400 项）
npm run bgtest   # worker 单测：作用域 / 配置投影 / 授权 / 抓图护栏（126 项）
npm test         # 上面四步 + 下面那些秒级独立套件（regression / pet-game / fuzz / log-store / popup-log / acceptance:test）
npm run e2e      # 真实 Edge 功能交叉检验（152 个场景 / 1718 项）
npm run test:all # npm test + e2e
npm run regression  # 1.3.0 字体/恢复/日志正确性闸门
npm run regression:self-test  # 检查闸门与内存故障注入
npm run log-store:test  # 独立日志模块、Worker 依赖及构建校验测试
npm run popup-log:test  # 前端日志视图、异步状态与 LF/CRLF 负控
npm run pet-game:test   # 角色小游戏纯规则：活跃计秒 / 好感度 / 等级与水位
npm run fuzz:test       # 暴力测试：错误分类全状态码扫 + 垃圾响应体 + 随机时钟/存档
npm run sandbox  # 临时源码副本：原基线 + 回归 + 模块测试 + 真实 Edge（约 5 分钟，不进 npm test）
npm run sandbox:built  # 临时构建：核验 ZIP/展开目录一致后，用真实 Edge 加载产物
npm run acceptance:test  # 记录器与验收规则自测（含真实子进程中止夹具）
npm run acceptance:built  # 完整产物验收：逐阶段落盘证据 + 独立退出/清理回执
npm run build    # 打包到 dist/
npm run audit:publish  # 发布前审查：扫描密钥 / 本机路径 / 邮箱 / 大文件是否误入公开仓库
```

全部零依赖，只用 Node 内置模块。`npm run e2e` 需要本机装有 Edge
（路径可用 `OMITONE_EDGE` 覆盖），细节与踩坑记录见 [`tools/README.md`](tools/README.md)。

> ⚠️ **`page.js` 是产物，不是源文件。** 它由 `src/page/*.js` 拼成，
> 而扩展加载的正是根目录那一份 —— 所以「直接改 `page.js`」会改完立刻生效、
> 下次拼接又全丢。`npm run check` 的最后一条就是拦这个漂移的。

### 三层测试的分工

| 层 | 手段 | 能测出什么 | 成本 |
| --- | --- | --- | --- |
| 静态自检 | `tools/check.js` | 语法、版本一致性、**幽灵调用**、死方法、编码损坏、唯一真源、**产物与片段一致**、**片段头部一致**、**await 可超时**、**选择器大小写一致** | 秒级 |
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

### ⚠️ 11.1 前缀缓存：**把提示词压得太短会更贵**（1.1.1 的重要一课）

这一节请务必读完再动 `libs/prompt.js`。

DeepSeek 的上下文缓存不是按「固定长度」命中的，而是要求**请求前缀完整匹配**某个
已持久化的「缓存前缀单元」；单元来源之一是**跨请求被识别出的公共前缀**
（官方 Context Caching 文档的 Example 2：同一 system + 变动 user，要等到**第二次**请求之后
才把这个公共前缀持久化成单元，第三次才命中）。命中部分按约 **1/10** 的价格计费。

我们曾经踩的坑是：前几轮一直在「压提示词」，把稳定内容压到只剩 3 行 system，
而且 user 消息的**第一行就是变化的题目**，`禁:`（历史错误答案）还插在每道题中间。
结果——

> 公共前缀既短又不干净 → 持久化不了 → **命中率恒为 0 → 全部输入按原价计费**

输入总量是降了，账单反而涨了。**这就是「提示词太短导致 token 消耗变多」的完整机制。**

1.1.1 的修法是把 user 消息固定成三段，**稳定在前、易变在后**：

```
[稳定头]  输出:["A",["A","C"],true,"填空1|||填空2"]        ← 所有请求逐字节相同
[题目块]  1|s|题干 / A.选项 / B.选项 …                     ← 同一批题内逐字节相同
[易变尾]  禁:1=A,C;5=B                                     ← 只有这里随"上次错了什么"变化
```

配套还改了一处 `page.js` 的行为：**同一份卷子重试时整批重发，而不是把已知正确的题从中间删掉**。
删掉会让前缀从删除处断掉，整段缓存全废；整批重发时重试的输入是上一次的
**超集且前缀一致**（官方 Example 1 的 `A+B` → `A+B+C`，命中 `A+B`），整段命中。

实测（`npm run bench`，10 题一批）：

| | 数值 |
| --- | --- |
| 稳定前缀（system + 消息头） | **84 token**（此前约 50，低于可识别粒度） |
| 同批重试的输入 | 477 token，其中前缀完整重合 **474 token（命中率 99%）** |
| 等价费用（命中按 1/10 价） | **降 89.4%** |

`tools/prompt-bench.js` 现在有一节「前缀缓存可命中性」专门盯这两个数，
`content.js` 也会把每次请求的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
写进运行日志（关键词 `llm prefix cache` / `llm prefix cache all missed`）——
**改动提示词后先看这两个地方，别只看输入变短了没有。**

⚠️ **`all missed` 只在输入够一整块（≥256 token）时才发**（批次 76）。
缓存按 256 token 一块起算，而视频弹题是「一题一发」，实测整份输入只有 146 / 197 token
（2026-11-17 现场日志环）—— 这种请求 `hit` 恒为 0 是**结构性的**，和提示词卫生无关。
以前它每门课都要挂几十条 warn 在日志里，把真正该看的那条（大请求全 miss）淹掉了。
够不上一块的那几条现在走 `info`，取证里带 `belowBlock:256` 说明为什么不是 warn。

### 压缩提示词的正确姿势

最大的风险是「把信息压掉」。改提示词时：

- `npm run bench` 会断言**题干与选项文本原样保留**
- `normalizeItem` 的 13 个用例必须全过（含位置式数组这一最易错项）
- 改完必须跑 `npm run e2e` —— 新的输出格式要在真实 Edge 里跑通 5 种题型的完整回填

---

## 12. 目录与体积构成

```
manifest.json           MV3 清单
background.js           service worker：跨域 fetch 代理 + 抓图转 dataURL
content.js              隔离世界桥接：注入 page.js、转发消息、字体解密、状态浮窗
page.js                 页面上下文运行时（主体，约 2 万行，全项目最值得小心对待的文件）
libs/prompt.js          LLM 提示词唯一真源
libs/api-url.js         API 地址构造与密钥清洗唯一真源（content.js 与 popup 共用）
libs/font-table.js      字形映射表的二进制格式唯一真源（编码/解码/明文包装）
libs/md5.min.js, Typr*.js   字体解析与哈希
resources/table.json    字形哈希 → 真实字符 映射表的可读源文件（347KB，不进扩展包）
resources/table.bin     由 json 生成的紧凑二进制表（122KB，运行时装的是它）
popup/                  设置界面
tools/                  开发脚本（自检 / 基准 / 测试 / 打包）
legacy/                 已停用代码，不会被加载（原因见 legacy/README.md）
```

> 体积账本已移到 `README.md` 的「体积账本」一节（机检要扫门面那一页）。

## 13. 边界

这个扩展操作用户的学习通账号数据。因此：

- **不要**代替用户输入账号、密码、验证码
- **不要**代替用户点击提交、发布内容（只读观察可以，代操作不行）
- **不要**把 `apiKey` 写进任何文件、日志或提交 —— 它只存在于 `chrome.storage.local`
- 探索浏览器时使用独立临时 profile，不碰用户的真实 profile 与 Cookies
- 跑 `npm run e2e` 会启动一个临时 Edge 实例并自动收尾；**不要**去操作用户正在使用的浏览器

## 许可

见 [LICENSE](LICENSE)。
