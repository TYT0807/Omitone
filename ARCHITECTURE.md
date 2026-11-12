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
│   background.js —— 消息路由、真实身份/授权、配置与网络代理            │
│   runtime-log-store.js —— 日志校验、脱敏、串行追加与清空             │
│   日志模块不直接访问 chrome；只接收宿主注入的四项能力                 │
└─────────────────────────────────────────────────────────────────────┘
                            ▲
                            │  chrome.runtime.sendMessage
                    popup/popup.js —— 设置界面、配置/日志请求与 xxt_start
```

**LLM 业务编排与网络权限分开。** 分批/解析/重试在 `content.js`，网络请求由 Worker 代理，
请求及响应体受期限约束。当前 content 不会在 Worker 拒绝后退回直连，避免绕过权限门禁。
MV3 Worker 可能被浏览器终止；日志队列仅在当前 Worker 实例内串行，不承诺跨重启恰好一次。

## 源码布局与构建产物

上面那张图说的是**运行时**；仓库里这些文件是这么组织的：

| 位置 | 是什么 | 能不能直接改 |
| --- | --- | --- |
| `src/page/*.js` | `page.js` 的**源文件**，按域切成 16 个片段（`00-shell-constants` … `90-console-api-startup`） | ✅ **要改就改这里** |
| `page.js`（根目录） | 由上面 16 个片段**拼接**出来的产物 —— 扩展实际加载的是它 | ❌ 直接改会在下次拼接时被覆盖 |
| `content.js` / `background.js` / `popup/` | 各自独立，不参与拼接 | ✅ |
| `libs/api-url.js` / `libs/prompt.js` / `libs/thinking.js` / `libs/captcha.js` | API 地址构造 / 提示词唯一真源 / 思考参数白名单 / 验证码请求构建 | ✅（改协议相关只改这里） |
| `libs/api-error.js` | 服务商报错**分类器**（错误文案唯一真源）：402 与 429+quota → 余额、401/403 → 密钥、429 → 限流、404 → 模型名、5xx → 服务端、无状态码 → 网络 | ✅ |
| `libs/study-stats.js` | 刷课活跃时长统计（纯函数）：`runtime_log` 消息流为信号源，连续计秒 / 跨天清零 / 落盘节流 | ✅ |
| `libs/runtime-policy.js` | 隔离世界 / Worker 共用的策略：配置字段白名单与校验、页面作用域 | ✅ |
| `libs/font-table.js` | 字形哈希表的紧凑二进制编解码（唯一真源，`tools/table-pack.js` 与运行时共用） | ✅ |
| `popup/pet-game.js` | 角色成长小游戏的**纯规则**（等级表 / 摸头台词 / 好感折算），Node 可直接 require；存取与演出在 `popup/pet.js` | ✅ |
| `runtime-log-store.js`（根目录） | Worker 通过 `importScripts` 加载的独立日志工厂，Node 可直接 require；不注入网页 | ✅ |
| `omitone-*.cjs`（根目录） | 独立测试入口：行为回归（含故障注入）/ 日志模块 / 日志视图 / 小游戏规则 / 暴力测试 / 沙盒与产物验收；`npm run sandbox` 在临时副本里逐个执行 | ✅ |
| `resources/table.bin` | 由 `resources/table.json` 打包出的运行时字体表（json 是源、bin 是产物） | ❌ 走 `node tools/table-pack.js --pack` |
| `dist/` | `npm run build` 的产物（解压目录 + `omitone.zip`），已 gitignore | — |

```bash
npm run concat        # 改完 src/page/ 必须跑：重新拼出根目录 page.js
npm run concat:check  # 校验两者一致（npm test 里会自动跑一次）
```

`page.js` 曾经是一个 9899 行的单文件，拆分的来龙去脉见
[`docs/pagejs-拆分提示词.md`](docs/pagejs-拆分提示词.md)（**三个阶段都已完成，别再重做**）。

**几道守卫拦的都是同一件事：改了一半就以为改完了。** 片段与产物不一致、片段头部的方法/状态字段
清单与实际不符、幽灵调用与死方法、`await` 缺超时护栏 —— 都由 `npm test` 报出来。
它们失败时的正确反应是**补齐同步**，不是改守卫。

### Worker 日志模块的能力边界

`runtime-log-store.js` 导出 `create({ read, write, authorize, now })`，每个实例只暴露
`handle(message, sender)`。`background.js` 在启动时创建唯一实例，向它注入：

| 能力 | 宿主职责 |
| --- | --- |
| `read()` | 从 `runtimeLogs` 读取数组，Chrome 操作由现有超时包装执行 |
| `write(logs)` | 写回同一键；模块不持有完整 storage/Chrome 对象 |
| `authorize(sender, clear)` | 按真实标签/扩展页面状态判断；必须明确返回 true 才能执行 |
| `now()` | 提供时间，便于确定性验证时间戳和排队过期 |

模块负责负载校验、元数据规整、200 条截断、队列容量与 15 秒排队期限；宿主保证注入的异步能力
有界结束。模块不新建另一个超时体系，不读 DOM、不联网。多实例只用于隔离测试/独立存储域，
生产不能为同一存储键创建多个实例，否则会破坏单写入保证。

加载关系：`manifest.background.service_worker` → `background.js` → `runtime-log-store.js`。
不增加 manifest 的 content_scripts 或 web_accessible_resources 权限。`tools/check.js` 递归验证
本地字面量 `importScripts` 依赖和 build 白名单；动态路径不在支持范围内，必须改成显式引用。

验证入口：`npm run log-store:test`；`npm run sandbox` 在临时源码副本验证；
`npm run sandbox:built` 额外在临时副本构建，核对 ZIP/展开目录逐文件一致后加载产物。
两种沙盒都不会覆盖原工作区 `dist`，正常或可捕获失败时自动清理临时产物；外部强制中止可能留下本次临时目录，须核对进程及精确路径再清理。

### Popup 日志视图边界

`popup-log-view.js` 是根目录下的扩展页面模块，由 `popup/popup.html` 在宿主脚本之前加载。
工厂 `create` 接收日志面板 DOM、readLogs / clearLogs / writeClipboard / notify / version / now
及显式计时器，返回 open / close / refresh / clear / copy / dispose / toggle 操作。
`popup.js` 只接真实浏览器能力与按钮，不再维护第二份日志面板状态。

显示使用文本节点和 `textContent`；导出纯文本格式保持兼容。读取代号与生命周期代号共同
拒绝迟到结果；关闭面板不会等待旧读取结束后再启动定时刷新；销毁取消模块创建的全部等待。
读与写剪贴板的期限为 5 秒，清空为 20 秒。取消本地等待不意味着能撤销已开始的底层写操作。

测试入口 `npm run popup-log:test` 已纳入统一基线。完整产物验收额外验证真实 DOM 中的
无 HTML 解释、关闭后定时器不复活、刷新/清空拒绝旧结果、复制失败回退和 pagehide 清理。
受控读取与剪贴板故障仅在测试页注入；清空仍走真实 Worker，原消息协议与权限不变。

### 产物验收证据

`npm run acceptance:built` 使用前台监督进程运行 `omitone-sandbox.cjs` 的完整 built 模式，
并在工作区 `tmp/acceptance/`（不入库）新建 `omitone-acceptance-<UTC时间-UUID>.jsonl`。基线、构建、浏览器身份、
每个场景开始/完成与收尾同步追加并 fsync；内容只包含验证状态、数量、路径和摘要，
不收集课程内容、模型请求体或真实凭据。终端输出不作为通过证据。

测试进程正常结束后，监督进程记录真实退出码、复核临时目录不存在和调试端口可用，再新建
同名 `.json` 回执，绑定 JSONL 的 SHA-256。`node omitone-acceptance.cjs --verify <绝对证据路径>`
同时复核证据链、场景计划、计数和回执。源码模式不能冒充产物模式；缺阶段、失败、
截断或中止均不通过。证据文件为本地交付记录保留，按精确命名排除于源码指纹和临时副本。

哈希链只用于检测意外损坏和记录错配，不是抗恶意篡改的签名；双进程也无法抵抗操作系统
同时强杀或断电。此时已落盘阶段可供定位，但不补造成功回执、不接着未完成运行拼出通过结论。

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
| `storage_set` | `{xxtRunning: boolean}` | **只允许写运行标记**。页面不再能改配置（旧实现可以塞整份 config，已移除） |
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

chrome.runtime 消息（**每一条都先判作用域**）：

| type | 谁能用 | 说明 |
| --- | --- | --- |
| `get_page_scope` | 所有 content | 页面问「我属于哪类场景」，返回 study / captcha / none |
| `get_config` | popup / study / captcha | popup 与 study 隔离世界可读原配置；captcha 只取公开投影；content 发给 page 的配置另做去密钥投影 |
| `config_patch` | popup / study | 带指纹的增量写；字段与区间走白名单 |
| `api_fetch` | popup / study | 跨域 POST 代理（AI 请求） |
| `fetch_image_dataurl` | study / captcha | 抓图转 dataURL；captcha 只能抓同源 |
| `captcha_fetch` | study / captcha | 验证码 OCR 专用窄通道，密钥不出后台 |
| `storage_set` | study | 只接受 `{xxtRunning:boolean}` |
| `grant_captcha` / `revoke_captcha` | 仅 popup | 手动授权外站验证码页 |
| `ping` | 所有 | 连通性检查，不回配置 |
| `check_update` | 仅 popup | 占位实现 |
| `runtime_log_append` | popup / study / captcha | `{time, level, message, meta}`；执行前核验权限后进入唯一日志队列 |
| `runtime_log_clear` | 仅 popup | 不带 payload；与追加走同一队列 |

**作用域判定**：`background.js` 按**标签页真实 URL** 判，不信页面自报（`sender.url`）。

- `study`：学习通域。`api_fetch`、抓图、运行标记都放行。
- `captcha`：外站验证码页，**必须授权** —— popup 按钮，或「从学习通页面打开且网址像验证码页」自动授权；
  授权绑定该 URL、10 分钟过期、换页即撤销。
- `popup`：扩展自己的页面（含 `?play=1` / 带查询串），可改配置。
- `none`：其余一律拒绝。

`legacy/background-core.js` 从未被加载，别再接回去。

### popup → 标签页

`{type: 'xxt_start'}`，由 `content.js` 的 `chrome.runtime.onMessage` 接收。

## storage 键

| 键 | 内容 |
| --- | --- |
| `config` | 配置项；`config_patch` 按 `libs/runtime-policy.js` 白名单与数值区间校验 |
| `xxtRunning` | 布尔。为 true 时页面刷新后自动续跑（验证码刷新场景依赖它） |
| `runtimeLogs` | 最近 200 条日志；由 Worker 的唯一日志模块实例追加/清空，前端只读展示 |
| `omitoneStudyStats` | 当日刷课活跃秒数（content.js 从 runtime_log 流统计，20 秒节流落盘）—— 角色小游戏的数据源 |
| `omitonePetBond` | 角色好感度存档（弹窗与上课页伴侣**共享真源**；旧版弹窗 localStorage 档首次加载自动迁移） |
| `omitonePagePetHidden` | 上课页角色伴侣的收起状态（收起后留「宠」字小入口） |

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
   ↓ 多选：本卷第一次尝试时**本地作答、不进请求**（见下）
page.js _handleQuiz()
   ↓ bridgeSend('llm_request')
content.js handleLLMRequestDirect()
   ↓ 每 5 题分批（CHUNK_SIZE），逐批调用并合并
   ↓ 保留调用方给的原始 index（不按数组位置反推）
   ↓ 长度不符：先按段解析 / 贪心重分段，分不出来才整批丢弃
   ↓ 被截断（finish_reason=length）→ 该批对半拆开重问
   ↓ 还有题没答上 → 只把漏掉的那几题补问一次
background.js api_fetch          跨域代理
   ↓
模型接口
```

两条与"题型/提交"有关的硬规矩（都是踩过坑才有的）：

- **多选在整卷里只享受一次"乱答"**：章节测验 / 作业的多选首次不进请求（省 token 与上下文），
  但这份卷子**一旦交过卷、平台又要求重做**，多选就交回模型 —— 猜的答案过不了的卷子，
  重做多少遍都过不了，只会把用户的提交次数烧光
  （`_answerLocalMultiChoiceQuestions`；视频内弹题不受影响，始终交给模型）。
- **提交前置是"每题都有值"，不是"答对"**（`_areQuizAnswersFilled`）：
  所以整卷最后剩一道空题比答错严重得多 —— 本地兜底填充（`_fillBestEffortQuizAnswers`）
  就是不让一道题把整卷钉死在原地。

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

三支，分类文案的唯一真源是 `libs/api-error.js`（`errorCategory` 标签随响应带给 page.js）：

- **永久拒绝**（4xx 且 ≠429，以及**余额类**：402 与 429+`insufficient_quota`）→
  **不重试、不写 `apiConnectionFailed`**，错误原文以【类别】人话交给用户
  （`quiz llm rejected permanently`）；改好配置自动恢复。
  「没钱」按永久处理：给它做退避只会重复撞墙，还把欠费伪装成网络故障。
- **可重试**（网络失败、超时、5xx、429 限流）→ 写 `apiConnectionFailed`，触发 45 秒退避
- **解析失败**（`parseError: true`）→ **不**标记连接失败，保留题目 8 秒后重试

前两支的区分是踩出来的：1.0.4 之前把解析失败也当成连接失败写进 storage，
形成"跳过 → 不再发请求 → 标志无法自愈"的死循环；1.2.8 又把 4xx 从网络故障里
拆出来（填错 Key 的表现是"卡死"而不是"Key 错了"）。

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

⚠️ **真实机制（2026-10-31 与同类开源实现交叉证实）**：`font-cxsecret` 文本里放的是
**正常中文字符**，字体却把它们画成别的字 —— **不是 PUA 私有区**。表缺字形时
题干是**通顺但内容错误**的中文，肉眼难察觉。

`content.js` 的解密层：Typr 解析页面注入的字体，对每个出现的非 ASCII 字符算
字形轮廓哈希（`md5(JSON.stringify(glyphPath)).slice(24)`），在 `resources/table.json`
查真实字符，就地替换 DOM 文本节点与 `aria-label`/`title`/`value`/`placeholder` 属性。
映射按字体 base64 缓存（`decryptMapCache`），`MutationObserver` 在新文档出现时重新 sweep。

四道防线（对应 page.js 的两层 + 解密层自诊断 + 结论可见）：

1. **等待**：page.js `_probeFontDecrypt(题目文档)` 看到 `.font-cxsecret` 残留就不抽题
   （类名被解密后摘除，"类名还在" = "还没解完"）；上限 8 秒，绝不死等。
   ⚠️ 范围是**题目那一份文档及其子帧**，不是整页 —— 不相干帧里解不掉的残留会把
   每份卷子都拖成"先白等 8 秒"（实测 2026-11-10）。同一次遍历还收 `data-om-font-miss`
   与解密层的**终局判据**（`nodecl` / `nomap`），有结论就直接按现状答，不等。
2. **miss 标记（主信号）**：解密统计「字形已计算但查表未命中」的字符数 —— >0 时在
   该文档 `documentElement` 落 `data-om-font-miss` 标记并写 warn 日志；
   page.js `_hasFontDecryptMiss()` 感知后整卷按乱码处理（连续 3 轮 → 这一卷暂停 90 秒）。
   **为什么必须由解密层报**：缺字形时文本是正常中文，文本侧检测抓不到。
2b. **结论可见（批次 5）**：每份被扫描的文档都带 `data-om-font-state`
   （clean / plain / nodecl / nomap / partial / done）与 `data-om-font-sweep` 时间戳，
   非 clean 的结论另写一条 `font decrypt verdict` 日志。
   没有它，「表里没这个字形」和「扫描根本没跑到这一份文档」在日志里长得一模一样。
3. **PUA 兜底**：`_quizTextGarbledRatio` 检测私有区字符占比 —— 真实超星不走这条路，
   保留防其他平台 / 未来改版。

另有两处边界处理：**无字体声明的残留类名**（已批改结果页给明文挂 `font-cxsecret`
却不提供字体 → 无 PUA 即视为明文、摘除类名放行，避免每轮白等）；
表请求失败有 10 秒期限与冷却重试，**不永久缓存空映射**（回归 F06-F08 钉住）。

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
