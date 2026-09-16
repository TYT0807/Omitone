# 架构

> 配套阅读：[`README.md`](README.md)（使用与开发流程）、[`AGENTS.md`](AGENTS.md)（改代码前必读的守则）。

## 三个执行环境

这个扩展的关键约束是：MV3 有**三个互相隔离的 JS 环境**，它们之间只能靠明确定义的通道通信。
搞错层是这类项目最常见的 bug 来源。

```
┌─────────────────────────────────────────────────────────────────────┐
│ 页面上下文 (page context)                                            │
│   page.js —— 通过 <script src="chrome-extension://..."> 注入          │
│   能读写学习通的 DOM / iframe / video 元素 / localStorage            │
│   拿不到 chrome.* API，拿不到跨域 iframe 的 document                 │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  window.postMessage  (source: 'xxt_app' / 'xxt_bridge')
┌───────────────────────────▼─────────────────────────────────────────┐
│ 隔离世界 (isolated world)                                            │
│   libs/prompt.js + content.js —— 由 manifest.content_scripts 注入     │
│   能拿到 chrome.* API，但与页面共享同一个 DOM                       │
│   负责：注入 page.js、转发消息、字体解密、状态浮窗                    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  chrome.runtime.sendMessage
┌───────────────────────────▼─────────────────────────────────────────┐
│ Service Worker                                                       │
│   background.js —— 极简，只有两个职责                                 │
│   ① api_fetch：跨域 POST 代理（content script 直连会被 CORS 拦）      │
│   ② fetch_image_dataurl：带 Cookie 抓验证码图并转 base64             │
└─────────────────────────────────────────────────────────────────────┘
                            ▲
                            │  chrome.runtime.sendMessage
                    popup/popup.js —— 设置界面，只读写下 storage + 发 xxt_start
```

**为什么 LLM 请求不放在 service worker 里？**
MV3 的 service worker 会被随时回收（大约 30 秒空闲即终止），长连接的大模型请求
（推理模型可能跑 1~2 分钟）非常容易被腰斩。所以请求由 `content.js` 发起、
经 `background.js` 只做一层 `fetch` 代理转发 —— 一旦 `api_fetch` 失败，
`content.js` 还会退回直连（`apiFetch` 里的 fallback 分支）。

## 消息协议

### page.js → content.js

全部经 `window.postMessage`，统一带 `source: 'xxt_app'` 和自增 `id`。
`page.js` 侧的 `bridgeSend(type, payload)` 返回 Promise，**默认 90 秒超时**
（`BRIDGE_TIMEOUT_MS`）——这个超时是必须的：早期版本没有它，
content 侧任何一次不回消息都会让 `_runTick` 的 `await` 永久挂起，整个刷课循环死亡。

| type | payload | 说明 |
| --- | --- | --- |
| `get_config` | — | 启动时拉一次配置 |
| `llm_request` | `{questions: [...]}` | 批量答题 |
| `llm_captcha` | `{image: dataURL}` | 验证码 OCR |
| `fetch_image` | `{url}` | 跨域验证码图，交给 SW 带 Cookie 抓 |
| `storage_set` | `{...}` | 直写 `chrome.storage.local` |
| `runtime_log` | `{level, message, meta}` | 日志上报（不等待回包） |

### content.js → page.js

统一带 `source: 'xxt_bridge'`，用 `id` 与请求配对。

| type | 说明 |
| --- | --- |
| `config_response` | `get_config` 的应答 |
| `llm_response` | `llm_request` / `llm_captcha` / `fetch_image` 的应答 |
| `XXT_CONFIG_UPDATED` | 配置热更新推送 |

> **踩坑点**：`XXT_CONFIG_UPDATED` **必须**带 `source: 'xxt_bridge'`，
> 否则会被 `page.js` 的过滤器直接丢弃。历史上漏过一次，症状是
> "popup 里改了开关但页面不生效，必须刷新才行"。

### content.js ↔ background.js

chrome.runtime 消息：`api_fetch`、`fetch_image_dataurl`、`ping`、
`check_update`（占位实现）。注意 `background.js` 只认这几个 type ——
`legacy/background-core.js` 里那套更丰富的 handler 从未被加载过。

### popup → 标签页

`{type: 'xxt_start'}`，由 `content.js` 的 `chrome.runtime.onMessage` 接收。

## storage 键

| 键 | 内容 |
| --- | --- |
| `config` | 全部配置项（扁平对象，多处以 spread 合并，**没有 schema 校验**） |
| `xxtRunning` | 布尔。为 true 时页面刷新后自动续跑（验证码刷新场景依赖它） |
| `runtimeLogs` | 最近 200 条日志，环形截断 |

## 自动续跑机制

1. 点「开始运行」时 `content.js` 写 `xxtRunning: true`
2. `content.js` 在每个顶层页面加载时读该标记，为真则给 `<html>` 打上
   `data-xxt-auto-start="1"`
3. `page.js` 启动时 `shouldAutoStart()` 读到该属性 → 直接 `app.run()`，
   且**读后即删**（避免同一标签页内二次触发）
4. 点「停止运行」清掉标记并刷新页面

⚠️ 讨论页 / 独立验证码页**只在 `shouldAutoStart()` 为真时**才自动运行。
没有续跑标记时进入讨论区是静默的（不显示面板、绝不自动发评论）——
这是刻意加的安全阀。

## tick 主循环

`page.js` 的心跳是 250ms 的 `setInterval`（`_startTickLoop`），
但 `_runTick` 用 `_tickRunning` 做重入锁，所以实际是"上一轮跑完才开始下一轮"。

**判定顺序是有讲究的**，顺序错会互相打架：

```
1. _isDiscussionContext()      ← 讨论页最优先，否则会被当成课程页去跳章节
2. _isStandaloneCaptchaPage()  ← 独立验证码页
3. _checkCaptchaDialog()       ← 验证码必须在最前，被挡住时其他动作都不该跑
4. _checkBlockedByCrossOrigin()
5. _handleDiscussionWait() / _tryDiscussionTask()
6. _detectPageChange() → _skipIfCompleted()
7. _checkSubmitConfirmDialog() / _monitorQuizSubmit() / _checkPopupQuiz()
8. _ensureOcsStudyRunner() → _runOcsStyleStudy()   ← 真正的刷课主体
9. 兜底：视频巡检 / 倍速守护 / 翻节
```

**看门狗**：interval 每次触发时检查 `_tickRunning` 是否已持续超过 150 秒，
是则强制释放锁并打 error 日志。这是防"任何未知挂起路径"的终极保险。

## 答题链路

```
page.js _extractQuestions()      从 DOM 抠题（题干 / 选项 / 题型）
   ↓ 过滤掉「确认正确 + 本轮已填 + DOM 有值」的题
page.js _handleQuiz()
   ↓ bridgeSend('llm_request')
content.js handleLLMRequestDirect()
   ↓ 每 5 题分批（CHUNK_SIZE），逐批调用并合并
   ↓ 保留调用方给的原始 index（不按数组位置反推）
background.js api_fetch          跨域代理
   ↓
模型接口
```

### 提示词与 token

提示词唯一真源是 [`libs/prompt.js`](libs/prompt.js)，`content.js` 不再内联任何提示词字面量
（`npm run check` 会强制这一点）。

相对 1.0.10 的三处压缩，实测（`npm run bench`，o200k 分词器）：

| | 1.0.10 | 1.0.11 | 节省 |
| --- | --- | --- | --- |
| system（每批重发） | 93 | 70 | 25% |
| user（5 题一批） | 357 | 256 | 28% |
| 整卷输入合计 | 862 | 620 | **28%** |
| 输出（10 题） | 186 | 94 | **49%** |

三处压缩手法：

1. **题型代号 + 一行图例**。旧版每题写 `Question 1 [single]:` + `Options:`，
   新版写 `1|s|题干`；题型含义由 system 里 `s"A" m["A","C"] j true|false f/t"文本"` 一行给出。
2. **输出格式示例压成一行**。旧版会按题目数量生成 JSON 样板（每题一行），
   在分批策略下这段纯样板文本随批次数线性重复。新版只有一行示例。
3. **答案对象用短键且不回传 `type`**。`{"i":0,"a":"A"}` 取代
   `{"index":0,"type":"single","answer":"A"}`。`type` 是冗余的 ——
   `page.js` 的 `_fillAnswers` 在 `answerItem.type` 缺失时回退到 `question.type`
   （`_detectQuestionType` 读真实 DOM 的结果，比模型复述更可靠）。

3a. **已有正确缓存的题不再发给模型**。`_handleQuiz` 里过滤三个条件同时成立的题
（`_getConfirmedCachedQuizAnswer` + `_wasQuizQuestionAnsweredThisRun` + `_isQuizQuestionFilled`）。
三个条件缺一不可：只看缓存会让"有缓存但填不进 DOM"的题永远无人作答，
导致表单填不满、无限重试。

### index 语义（容易搞错）

- `page.js` 发给 `content.js` 的 `questions[i].index` = 该题在**它自己那份 `questions[]` 数组**里的下标
- `content.js` 分批后，模型看到的是**批内序号**（0 基，由 `libs/prompt.js` 的题号和 `FORMAT_HINT` 共同确定）
- `content.js` 负责把批内序号**映射回原始 index** 再回传
- `page.js._fillAnswers` 用 `questions[answerItem.index]` 取题

因为 `page.js` 可能只发一部分题（见上面第 3a 条），
`content.js` **不能**用 `批号 × 5 + 批内序号` 反推 —— 那个算法隐含"发来的题就是全部题"的假设。

### 解析容错

`parseLLMResponse`（content.js）依次尝试：直接 `JSON.parse` → 抠 ```json 代码块 →
抠 `[...]` → 单对象 → 正则逐个捞 `{...}`。
`libs/prompt.js` 的 `normalizeItem` 同时认 `i`/`a` 与旧键名 `index`/`answer`，
所以模型偶尔退化成旧格式或被用户自定义的 systemPrompt 改变输出形状都不会解析失败。

### 失败分类（决定是否标记"API 不可用"）

- **网络/HTTP 错误** → 写 `apiConnectionFailed`，触发 45 秒退避
- **解析失败**（`parseError: true`）→ **不**标记连接失败，保留题目 8 秒后重试

这个区分是踩出来的：1.0.4 之前把解析失败也当成连接失败写进 storage，
形成"跳过 → 不再发请求 → 标志无法自愈"的死循环。

## 验证码链路

学习通有两种验证码形态，处理路径不同：

**A. 弹窗验证码**（在课程页内）
`_checkCaptchaDialog()` 三层识别：已知 id 选择器（`imgVerCode` / `chapterNumVerCode` 等）
→ 图片地址与尺寸特征 → 弹窗文本兜底（含"验证码/校验码"字样 + 图 + 输入框）。
命中后 `_handleCaptchaDialog()` 抓图 → 视觉模型 → 清洗 → 填入 → 提交 →
未消则点图刷新重试（最多 3 次）→ 仍失败整页刷新。

**B. 独立验证码网址**（新标签页 / 弹出窗口 / 页面被跳转到验证页）
这类是顶层页面，插件能完整访问 DOM。`_runStandaloneCaptchaMode()` 最多跑 4 轮。
处理完有 opener 就 `window.close()`，否则 `history.back()`。

抓图有两条路：优先在图片所在文档内建 canvas（同源才可行），
跨域污染时退回 `bridgeSend('fetch_image')` 由 service worker 带 Cookie 抓。

> `content.js` 的注入范围是 `*://*/*`，但**非学习通页面**只有在
> `xxtRunning` 为真 **且** `isCaptchaLikePage()` 命中时才注入 `page.js`。
> 其余网站立即静默退出，不建面板、不做字体解密。

## 讨论任务点

讨论任务点在课程页里是三层嵌套 iframe：
`#iframe` → `iframe[module="insertbbs"]` → `iframe#frame_content`。
最内层卡片 `#topicMainDiv` 的 `data` 属性就是讨论区真实地址
（`groupweb.chaoxing.com/...`，**独立跨域网址**）。

`_collectDiscussionTargets` 直接取卡片的 `data`，同文档的 `#isFinished`
表示服务端给出的"是否已回复"。已完成的一律跳过，**绝不重发**。

发评论时要注意两个同名陷阱（都是靠真实浏览器观察才发现的）：
- 编辑区是 `.replyEdit textarea[placeholder="回复话题"]`，折叠时要先点 `.replyBtn` 展开
- 提交按钮是 **`.addReply`**；页面上另有 `.replyBtn` / `.topicDetail_title_right`
  两个也叫"回复"的按钮，它们是**展开按钮**，点错就永远发不出去

防重复三处：打开前就写 `omitone_discussion_done` 标记（刷新后仍生效）、
`_discussionPosted` 保证每页只发一次、扫描/打开/等待各有节流与超时。

## 字体反爬

学习通把题目文本用自定义字体 `font-cxsecret` 渲染成乱码字符。
`content.js` 用 Typr 解析字体文件，对每个字符算字形轮廓哈希
（`md5(JSON.stringify(glyphPath)).slice(24)`），在 `resources/table.json` 里
查真实字符，然后就地替换 DOM 文本节点与 `aria-label`/`title`/`value`/`placeholder` 属性。

映射按字体 base64 缓存（`decryptMapCache`），并用 `MutationObserver` 在新文档出现时重新 sweep。

## 后台节流对抗

浏览器会对后台标签页狠命节流（`setTimeout` 最低降到 1 次/分钟）。
`page.js` 叠了四层：

1. **内联 Blob Worker 心跳** —— Worker 定时器不受标签页可见性节流，1.5 秒驱动一次巡检
2. **不可听音频保活** —— `AudioContext` + 50Hz / gain 0.003 的无声振荡器，
   让标签页被视为"正在播放音频"，豁免强节流与后台静音媒体限制
3. **`pause` 事件直接恢复** —— 事件派发不受定时器节流，pause 后 600ms 直接抢回播放
4. **`visibilitychange` 回前台立即校验** 视频状态与倍速

## 跨域安全铁律

**永远不要裸读跨域 iframe 的 `document`。**

```js
// ❌ 抛 SecurityError，且在 _runTick 里会静默打断整轮调度
var doc = frame.contentWindow.document;

// ✅ 一律走这两个助手，跨域时返回 null 而不是抛异常
var doc = app._safeDocOf(frame);
var winDoc = app._safeWinDoc(frame.contentWindow);
```

这条规则是用一个极难定位的 bug 换来的：验证码页会把主 `#iframe` 指向跨域地址，
裸读 `.document` 抛出的 `SecurityError` 冒泡进 tick 的 catch，
症状是"日志停在某一条、所有功能全停"，看起来完全不像跨域问题。

## 配置项

`page.js` 顶部 `DEFAULT_CONFIG` 是运行时的权威清单。
`content.js` 内也有一份 `configs` 默认值、`popup/popup.js` 有 `DEFAULTS` ——
三份是**各自独立维护**的（历史遗留），新增配置项时至少要改 `page.js` 与 `popup.js`。

配置项分三类：
- **行为开关**：`autoNext` / `enableQuiz` / `enableCaptcha` / `enableDiscussion` / `enableSeek` / `restudy` / `blockedReload`
- **数值参数**：`playbackRate` / `playbackRateCap` / 各类超时与节流（`stepSwitchGraceMs`、`quizSubmitWaitMs`、`pptFlipIntervalMs` …）
- **凭据**：`apiType` / `apiUrl` / `apiKey` / `model` / `captchaModel` / `systemPrompt`

> `systemPrompt` 留空时用 `libs/prompt.js` 的压缩版；填了则**完全覆盖**它。
> 覆盖后 `FORMAT_HINT` 仍然会附加在 user 消息末尾（模型仍需知道输出形状）。

## 已知限制

- **不支持交互题型**：连线、排序、拖拽题无法自动作答
- **`configs` 无 schema 校验**：三份默认值可能漂移，改配置时要手动对齐
- **`resources/table.json`（347KB）**：字体解密表，随扩展一起分发
- **service worker 无远程更新**：`background.js` 里 `check_update` 是空壳
  （旧实现见 `legacy/background-core.js`）
- **依赖页面 DOM 选择器**：学习通改版会导致识别失效，日志里能看到具体是哪个选择器没命中
