# tools/ — 开发脚本

全部零依赖，只用 Node 内置模块。Node >= 18。

| 脚本 | 命令 | 作用 |
| --- | --- | --- |
| `check.js` | `npm run check` | 工程自检 |
| `prompt-bench.js` | `npm run bench` | 提示词 token 基准 + 兼容性自检 |
| `integration-test.js` | `npm run itest` | 集成测试：真实 `content.js` 的答题往返链路 |
| `browser-e2e.js` | `npm run e2e` | 真实 Edge 端到端：加载扩展 + mock 测验页 + mock 模型 |
| `build.js` | `npm run build` | 打包到 `dist/` |
| `manual-pdf.js` | `npm run manual` | 从 `docs/manual.html` 生成 **`使用说明.pdf` 到仓库根目录**（版本号自动盖入） |
| `github-release.js` | `npm run release -- …` | 走 REST API 发版：提交 / 打 tag / 建 Release / 传附件 / 核验 |
| `audit-safedoc.js` | `node tools/audit-safedoc.js` | **按需跑**：审计"裸读跨域 `.document`"有没有被 `try` 包住（见下方专节） |
| `audit-fields.js` | `node tools/audit-fields.js` | **按需跑**：列出私有字段全量，标出哪些不在 `10-config-state.js` 的声明表里（见下方专节） |
| `fix-bom.js` | `node tools/fix-bom.js --write` | 清除被编辑器写回的 UTF-8 BOM |
| `ext-id.js` | `node tools/ext-id.js <目录> [已知ID]` | 反推未打包扩展的确定性 ID 编码 |

`npm test` = `check` + `bench` + `itest`；`npm run test:all` 再加上 `e2e`。

---

## check.js

不写文件、不发网络请求，可安全反复执行。检查项：

1. **JS 语法** —— 所有 `.js` 用 `vm.Script` 编译（会先剥掉 BOM，否则 `vm` 会当成非法 token）
2. **manifest 解析与 BOM** —— 带 BOM 时浏览器能加载，但 `JSON.parse` 会失败，这里直接拦
3. **引用文件存在性** —— manifest 里所有 `js` / `css` / `icons` / `popup` / `web_accessible_resources` / `service_worker`
4. **版本号一致（五处）** —— 与 `manifest.version` 比对 `name` / `default_title` /
   `popup.html`（`<title>` + `.ver`）/ `content.js` 状态面板品牌位
5. **唯一真源**（提示词 + API 地址构造）—— `content.js` 里若重新出现
   `buildQuestionsText` / `buildOutputFormat` / `Return format:` 字面量，
   或 `buildXxxApiUrl` 不再走 `API_URL.*`，即报错；
   同时校验 `manifest.content_scripts` 真的注入了 content.js 依赖的那两个 lib
6. **字形映射表同步** —— `resources/table.bin` 必须与唯一真源 `table.json` **逐条**一致
   （只比文件大小会把"内容错位"放过去）
7. **用户入口守卫** —— 守住**非技术用户唯一的入手路径**：根目录有 `使用说明.pdf`、
   README 含**不带版本号**的 `releases/latest/download/omitone.zip` 直链、
   README 里所有相对链接都指向真实存在的文件、说明书源文件没写死版本号压缩包名。
   这四项都做过**反向验证**（临时造 5 个错，确认逐一被抓住）
8. **编码损坏探测**（告警级）—— 非注释行里的 GBK 乱码残留字符，如 `閫夐」`
9. **幽灵调用** —— 调用了但没定义的方法（剥注释后比对 `this._x(` 与定义）
10. **死方法**（告警级）—— 定义了但全项目无人调用的下划线方法
11. **死代码探测** —— 认出四条加载途径（`content_scripts` / `service_worker` /
    `web_accessible_resources` / HTML 的 `<script src>`），都不沾的 `.js` 会告警
12. **配置接线守卫** —— 每个配置项必须"默认值 + 界面绑定 + 读取 + 保存"四件齐全，
    拦"开关做出来了但没接上"这种配好了却不生效的情况
13. **测试数字守卫** —— 文档里写的场景数 / 断言总数必须等于代码与 e2e 实测值
    （断言总数由 e2e 落盘到 `.workbuddy/e2e-counts.json`，没跑过就跳过不判错）
14. **`page.js` 与 `src/page/` 一致** —— 见上文「拼接机制」。拦的是"直接改根目录产物、
    下次拼接全丢"这种**跑起来是对的**的静默失效
15. **片段头部与实际一致** —— 每个片段的头部注释（`片段 NN/MM` 序号 + 「本段的方法」清单）
    必须与文件里真实的 `app` 方法一一对上。头部长了短了、方法搬走了没改头部，
    读的人就会照着错的地图找代码 —— **有错地图比没地图更糟**（没地图时他会 grep，有错地图时他会信）。
    `window.xxtAI` 上那 8 个入口不算 `app` 方法，判据里已排除。
    三种错法都做过**反向验证**：漏写一个方法、写一个不存在的方法、序号错位，各自都被抓住
16. **`await` 必须可超时** —— 见下方「为什么单独守这一条」

失败时退出码为 1，可直接用于 CI。

## 为什么单独守"await 必须可超时"

**"永久挂起"不是异常 —— `try/catch` 拦不住它，只有超时能。**
而 `page.js` 的 `_runTick` 是一条 `await` 链：任何一处永远不 resolve，整个调度就停摆
（验证码检测、播放巡检、任务点推进全停），并且**页面一条异常都不会有**，极难定位。

这条守卫只盯**已知会挂起的原生调用**：

| 盯什么 | 为什么 |
| --- | --- |
| `fetch(...)` | 服务器接了连接却不回数据时永远不 resolve（CDN 卡住、被代理吞掉） |
| `.text()` / `.json()` / `.arrayBuffer()` / `.blob()` | 读响应体同样可能永远读不完 |
| `.play()` / `.pause()` | 视频源停摆时 `play()` 的 Promise 会一直 pending（本仓库实测过） |

判据是"同一行里必须出现 `_withTimeout(`"。

> ⚠️ **刻意不写"名字里带 play/load 就算"那种宽泛规则。** 实测那样会把
> `_probeMaxPlaybackRate()`（内部自带超时）误报成危险 —— 误报多了守卫就没人信了，
> 最后会被人加白名单绕过去，等于没守。

超时的语义要注意：`_withTimeout` 超时是 **`resolve(undefined)` 而不是 reject**
（对媒体是"按成功放行，实际状态由后续巡检兜底"）。所以包在网络调用外面时，
**下面必须有一个 `undefined` 分支** —— 例如 `if (!response || !response.ok) return false;`。

## audit-safedoc.js

审计"裸读跨域 `.document`"这件事。`AGENTS.md` §2 第 1 条把它列为**最难查的一类 bug**
（抛出的 `SecurityError` 会静默打断整个 tick 循环），但"有没有裸读"不能只靠 grep ——
决定危不危险的是**它有没有被 `try` 包住**。这个脚本按行算大括号深度、
标记每行是否落在 `try/catch` 区间内，然后给出结论。

```bash
node tools/audit-safedoc.js     # 危险处 > 0 时退出码 1
```

**为什么不进 `npm test`**：它需要一个"判 `/` 是正则还是除号"的词法启发式。
第一版就栽在这里 —— `60-tasks-detect.js` 里一个**含引号的正则字面量**让它以为进了字符串，
从此整份文件后面的行全被剥成空，那个文件里 4 处裸读**一处都没报出来**，
而汇总行照样打印"没有保护 0 处"。现在脚本自带自校验（原文命中数 vs 剥注释后命中数对不上就报警），
但一个启发式词法器不适合当"每次都跑"的硬门禁。**改 iframe / 跨域相关代码后手动跑一次。**

**最近一次审计结论（2026-09-21）：16 处裸读全部在 `try` 块内，没有保护的 0 处。**

## audit-fields.js

列出 `page.js` 里用到的私有字段全量，标出哪些**不在 `10-config-state.js` 的声明表里**。

为什么需要它：`src/page/README.md` 里那句"找状态字段就来 `10-config-state.js`"
**不完全成立** —— 声明表里 119 个属性，另有 **32 个字段是"用到才建"** 的：

```js
if (!this._seekTriedKeys) this._seekTriedKeys = Object.create(null);   // 建的时候才建
if (this._onVideoEnded) el.removeEventListener('ended', this._onVideoEnded);  // 用前先确认
if (now - (this._blockedReloadAt || 0) > 180000) { … }                 // 读取处兜底
```

这是**刻意的写法** —— 惰性初始化不会被"某处忘了复位"弄坏，比依赖声明初值更抗错。
代价是**找字段时不能只看一个文件**。这个脚本把全量列出来，省得下一个人重新数一遍。

```bash
node tools/audit-fields.js      # 只列出来，不判失败
```

> ⚠️ **已知误报，别当成 bug**：脚本看不出 `this` 指谁。`XHR.prototype.open = function () {
> this.__omitoneUrl = … }` 里的 `this` 是 **XHR 实例**，不是 app —— 那两个会被列出来。
> 2026-09-21 全量核对时，最后剩下的 3 个"没看到兜底"**全是这类误报**，没有真 bug。

> ⚠️ 写这类脚本时踩过的一个正则坑：判断"后面不是左括号"**不能用** `(?!\s*\()` ——
> 回溯会把 `_withTimeout(` 截成 `_withTimeou` 再判"后面不是左括号"，于是报出一堆截断的假名字
> （实测报了 360 个）。要**先完整匹配标识符、再在代码里看后面是不是左括号**。

## prompt-bench.js

固定一份 10 题的模拟考卷（覆盖单选/多选/判断/单空填空/多空填空/简答），
**三代并列对比**：

- 1.0.10 的旧提示词（逐题 JSON 样板 + 英文 system，每批 5 题）
- v1：1.0.11 首版（题型代号 + 对象式输出 `{"i":0,"a":"A"}`，每批 5 题）
- v2：当前（位置式数组输出，每批 10 题）

输出内容：

- 单批请求的 system / user / 合计
- 整卷输入合计与节省比例
- **40 题整卷：三代真实配置对比（输入 + 输出 + 合计）** —— 这是最终用户能感知的数字
- 输出侧三代各写一遍同样 10 题的 token 数
- 单题均摊

外加两项自检，**失败会置退出码 1**：

- 题干与选项文本必须原样出现在新提示词里（防止压缩把信息压掉）
- `normalizeItem` 对三种输出形态的兼容性（13 个用例）。其中
  **位置式数组**是最容易写错的一例：数组的 `typeof` 是 object，
  若被当成 `{a:…}` 包装对象解析，多选题答案会被整条丢掉

保留 v1 与 1.0.10 两代实现是为了让"每一代各省了多少"有**可复算**的数字，
而不是凭记忆写文档。改提示词时顺手同步 `tools/prompt-bench.js` 的基准。

**token 计数**：优先用真实分词器 `gpt-tokenizer`（o200k）。找不到时退化为
启发式估算并**明确标注"估算 (启发式，非精确值)"** —— 不要把估算值当实测值引用。

安装真实分词器：

```bash
# 任意位置安装，然后让脚本能找到它
npm i -g gpt-tokenizer
NODE_PATH="$(npm root -g)" npm run bench

# 或者用环境变量直接指向其 node_modules
OMITONE_TOKENIZER_DIR=/path/to/node_modules npm run bench
```

改提示词后请重跑，确认 token 没有反弹。

## integration-test.js

把 **真实的 `content.js` 与 `libs/*.js`** 加载进一个 `vm` 隔离环境
（打桩 `chrome.*` / `document` / `window.postMessage`），然后通过它自己注册的
message 监听器驱动完整答题往返。当前 77 项断言：

1. **稀疏 index 透传** —— 20 题的卷子只发 12 道（模拟已有正确缓存的题被跳过），
   12 题刚好跨 2 批（CHUNK_SIZE=10），验证跨批次回填的 index 与原始下标完全一致。
   这是 1.0.11 改动里最容易错的地方
2. 旧 schema 兼容（`index`/`type`/`answer` + ` ```json ` 包裹）
3. **v1 对象协议兼容**（`{"i":n,"a":…}`）—— 协议升级后旧格式不能被破坏
4. **按题型规整答案形态** —— 单选收到 `["A"]` 解包成 `"A"`、判断收到 `"正确"` 归一成
   `true`、多选数组原样保留
5. 解析失败必须归类为 `parseError` 且**不**污染 `apiConnectionFailed`
6. 未配置 API Key 时明确拒绝且不发请求
7. Claude 协议适配（`/v1/messages`、顶层 `system`、`anthropic-version` 头）
8. Gemini 协议适配（`generateContent` + `key` 查询参数）
9. 历史错误答案以 `禁:` 标注进提示词
10. **空答案补问** —— 模型漏答一题（返回空串）时，必须只对漏掉的题补发一次请求，
    答案按原始 index 回填。这道防线防止 `page.js` 走到"猜第一个选项"的兜底，
    后者猜错会触发整卷重答

其中的"假模型"是一个**独立实现的提示词解析器**（不 import `libs/prompt.js`）——
如果提示词格式变得不可解析，它会直接答不上来，测试随即失败。
默认返回**位置式数组**（当前协议），另有 v1/v2 两种旧格式的专用 responder
用于兼容性用例。

> **vm 的坑**：`vm.createContext` 会把跨上下文对象包成代理，
> 宿主手里的 `sandbox` 与上下文内部的 `window` **不是同一个引用**。
> `content.js` 的监听器第一句是 `if (event.source !== window) return;`，
> 所以派发事件必须用 `vm.runInContext('window', sandbox)` 取出来的那个引用，
> 否则事件会被静默丢弃，表现为"测试收不到任何应答"。

## browser-e2e.js

在**独立临时 profile** 里启动 Edge（绝不碰用户正在使用的实例），加载本仓库扩展，
逐个访问本地 mock 页面，**逐功能交叉检验实际行为**。当前 28 个场景 / 305 项断言。

前置：本机装有 Edge。路径用 `OMITONE_EDGE` 覆盖；端口用 `OMITONE_E2E_PORT` /
`OMITONE_CDP_PORT` 覆盖；`OMITONE_E2E_DEBUG=1` 打印 target 列表与扩展 ID。

> **扩展 ID 不再靠"算"**。过去用 `SHA256(目录路径)` 猜 ID，而它对路径大小写敏感
> （`D:\Omite` 与 `d:\Omite` 会算出完全不同的 ID），一算错就是
> **所有场景全部失败、页面里一条异常都没有**。现在优先用运行时发现的真实 ID
> （content script 的执行上下文 origin），路径哈希降级为兜底，
> 两者不一致时会在输出里打印警告。详见 `discoverExtensionId` 的注释。

| 场景 | mock 页面 | 验什么 |
| --- | --- | --- |
| 抠题（5 种题型） | `/quiz` | 5 种题型识别、题干未被题号清空、选项文本干净 |
| 答题往返 + 回填 DOM | `/quiz` | 提示词新格式、模型往返、5 种题型答案真正写进 DOM 与隐藏域、`_areQuizAnswersFilled` |
| 记住正确答案 | `/quiz-result` | `.fr.dui` / `.fr.cuo` 对错判定（保守不误记）、从 `.Py_answer` 解析答案、写入缓存 |
| 任务类型识别 | `/blank` | 视频/音频/文档/图片/测验/投票的 module→处理方式映射、扩展名识别、不支持类型留日志 |
| 视频倍速 / 静音 / seek | `/media` | 配置 → 元素属性、seek 到 `duration-3s`、隐藏 audio 兜底、音频静音与倍速 |
| 验证码弹窗识别 | `/captcha-dialog` | `#imgVerCode` 命中、验证码结果清洗规则 |
| 独立验证码页识别 | `/captcha-verify` | 页面判定、抓图与输入框定位 |
| 弹窗题识别 | `/popup-quiz` | `.ans-pop-quiz` 命中与题目文本 |
| 讨论区识别 | `/discussion` | 页面判定、编辑框定位、提交按钮必须是 `.addReply`（不是同名的展开按钮） |
| 扫不到题的诊断 | `/weird` | 0 题 + 诊断报告给出定位线索 |
| 多讨论任务点 | `/discussion-multi` | 同文档 4 张卡片：去重键互不相同、不误用容器级已完成标志、挑出未完成的那个 |
| 做不完的任务点跳过 | `/blank` | 任务点键、放弃阈值、名单读写与清除、`_isJobCompleted` 保守性 |
| 设置弹窗 | `chrome-extension://…/popup/popup.html` | 依赖加载顺序、地址构造、密钥清洗、初始化、无未捕获异常 |

### 踩过的坑（改这个脚本前先看）

- **必须成对使用 `--disable-extensions-except` + `--load-extension`**。
  新版 Chromium 单独给 `--load-extension` 时常被静默忽略，扩展根本不加载，
  症状是 CDP target 里只有 Edge 自带的那几个扩展。
- **扩展 ID 要算，不要去 CDP 里等**。MV3 service worker 是懒启动的，
  不一定会出现在 target 列表里；"等它出现"会让测试随机失败。
  算法：`SHA256(扩展目录绝对路径)` 前 32 位十六进制，逐位映射 `0-f → a-p`，
  **Windows 上路径按 UTF-16LE 参与哈希**（不是 UTF-8 —— 这点是用 `ext-id.js`
  拿真实 ID 反推出来的）。
- **不能用 `fetch("chrome-extension://…")` 探测资源**。浏览器禁止网页脚本 fetch
  非 http(s) scheme 的 URL，永远返回 false（`<script src>` 才可以）。
- **收尾必须杀整个进程树**。Edge 会派生子进程，只 `kill()` 主进程杀不干净，
  残留实例继续占着 CDP 端口，下一次运行会连到**旧实例**上，
  症状是"所有候选扩展 ID 都注入失败"。脚本现在用 `taskkill /T /F`。
- **结束与启动都要等端口释放**。即使杀干净了，端口也未必立刻回收 ——
  **连续跑两次会假失败**（表现为"端口仍被占用"或"所有注入都失败"），
  看起来像随机抖动。现在收尾后与启动前都轮询等端口真正空出来（12 秒超时），
  连跑三次稳定通过。
- **跨域脚本的报错会被浏览器抹掉**。`page.js` 对 http 页面而言是跨域脚本，
  在页面里挂 `window.onerror` 只能拿到 `Script error.`，
  必须走 CDP 的 `Runtime.exceptionThrown`。
- **各场景共用同一个 `chrome.storage`，配置会互相泄漏**。
  例如答题场景写入 `enableCaptcha: false` 之后，后面的验证码场景
  `_checkCaptchaDialog` 会直接返回 null，"检测不到验证码"看起来像产品 bug，实际是测试污染。
  **每个场景都要显式声明自己需要的那几项配置。**
- **mock 验证码图不要用 1×1 PNG**。检测逻辑按 `img.naturalWidth` 过滤 40~400 的尺寸，
  1×1 的图即使 CSS 拉到 120×40，`naturalWidth` 仍是 1 → 被过滤掉。
  用带 `width`/`height` 的 SVG（`naturalWidth` 就是真实值）。
- **mock 视频要挂一个 `src`**。`_getMediaSeekKey` 取 `currentSrc || src`，
  两者都空时返回空字符串，`_trySeekToEnd` 会直接短路 —— 看起来像 seek 功能坏了。
- **调用 `_ensurePlaybackRate` 的自动倍速路径后要清 `_rateProbing`**：
  探测期间 `_trySeekToEnd` 会主动让路，紧接着测 seek 必然失败。
- 媒体元素的 `duration` / `currentTime` / `playbackRate` 用原型打桩伪造，
  这样测的是插件逻辑，不依赖真实编解码器。

## ext-id.js

反推"未打包扩展"确定性 ID 的输入编码。

```bash
node tools/ext-id.js "D:\Omite" <edge://extensions 里看到的 ID>
```

会打印各编码（utf8 / utf16le / 大小写 / 尾分隔符）算出的 ID，并标出命中的那个。
排查扩展加载问题时用得上。

## concat-page.js

把 `src/page/*.js` 按文件名排序拼回根目录的 `page.js`。

```bash
npm run concat         # 生成 page.js
npm run concat:check   # 只校验（不一致退出码 1）
```

`page.js` 原本是 9899 行 / 330 个方法的巨石，现在拆成 `src/page/` 下的 **16 个按域片段**
（`00-shell-constants` / `10-config-state` / `20-dom` / `30-log` / `40-media` / `50-captcha` /
`60-tasks-detect` / `62-tasks-run` / `64-tasks-loop` / `65-discussion` /
`70-quiz-flow` / `72-quiz-answers` / `74-quiz-vision` / `75-quiz-dom` / `80-popup-quiz` /
`90-console-api-startup`），**根目录的 `page.js` 变成构建产物** —— 而扩展真正加载的正是它
（`content.js` 用 `chrome.runtime.getURL('page.js')` 注入、`manifest.json` 的
`web_accessible_resources` 也列着它），所以产物位置和文件名都不能变。

拆分的模块地图见 [`../src/page/README.md`](../src/page/README.md)。

**拼接出来的结构**：`00-` 以 `var app = {` 结尾，中间各域文件是一个个属性块（**每项都必须以逗号结尾**，
否则挪到别处就会拼出语法错误），`90-` 以 `};` 开头闭合对象字面量。

**验证做到哪一步**：拆分分三步 —— ① 按物理行切分（只切不改），验收标准是**产物与拆分前逐字节相同**
（`cmp` 无输出，sha256 `fd20baa1…`）；② 按域重组、③ 把两块最重的再细分，这两步字节必然变，改用
**属性与行级的多重集比对**（②：434 个属性名、8644 行有效行；③：492 个属性名、9055 行非空行）
加 `npm test` / `npm run e2e` 全绿来兜。

每段片段以 `// @omitone-part-header-end` 收尾头部注释，拼接时**该行及之前全部丢弃** ——
头部写多少都不会漏进产物。缺这个标记会直接报错退出（否则整份头部会被当成代码写进 `page.js`）。

`tools/check.js` 的最后一项会调本模块的 `buildPageText()` 比对产物与片段，
拦住那种静默失效：**直接改根目录 `page.js`** —— 跑起来是对的（浏览器加载的就是改过那份），
但下次拼接全丢，且毫无声响。

> ⚠️ 改片段时的两个坑（都实测踩过）：
> **① 块注释**（`/** … */`）如果紧跟在某个属性后面、属于**下一个**属性，重组时要把整块一起挪走 ——
> 只认 `//` 的话会在 `*/` 后面补出逗号，写出 `*/,` 这种语法错误。
> **② 重建必须拿原始 `page.js` 当输入**：重排过的产物再喂给拆分脚本一次，注释与属性的对应关系
> 已经断了，会把上一次的错误固化下来。

> ⚠️ 再做"把大片段继续细分"这类重排时，另外两个坑（阶段三实测踩过）：
> **③ 新旧片段重名时，"删掉被拆掉的源文件"必须在生成新文件之前执行。** 阶段三把
> `70-quiz-flow.js` 拆成三个片段，其中一个**还叫 `70-quiz-flow.js`** —— 脚本先生成、后清理，
> 结果把刚写好的新文件一起删了。它照常打印"已生成 6 个片段"，只有比对时才发现少了 43 个属性。
> **④ 块与块之间的注释属于下面那个属性，不属于上面那个。** 若按"上一块一直延伸到下一个属性行之前"
> 来切，`_takeVisionBudget` 的 JSDoc 会留在上一块里、跟着别人搬去别的文件。切块时要把尾部的
> 空行与注释行**挪给下一块**；而空行本身在写文件时由"块间一个空行"的分隔符补回，别既留又补
> （否则每细分一次就凭空多出一批空行）。

## build.js

产物：

- `dist/omitone-<version>/` —— 可直接「加载已解压的扩展程序」
- `dist/omitone-<version>.zip` —— 可上传开发者后台

采用**白名单**收集文件（`manifest.json` / `background.js` / `content.js` / `page.js` /
`libs` / `icons` / `popup` / `resources` / `LICENSE`），
所以新增开发文件不会被误打包；但新增运行时文件时记得加进 `INCLUDE`。

ZIP 由脚本自己写（`zlib.deflateRawSync` + 自实现 crc32），
条目名以 UTF-8 写入（通用位标记 `0x0800`）。

## manual-pdf.js

```bash
npm run manual
```

- 源：`docs/manual.html`（排版真源，内联 SVG + A4 打印 CSS）
- 产物：**`使用说明.pdf`，落在仓库根目录** —— 这是刻意的，见下

为什么在根目录：这份 PDF 是给**完全不懂 GitHub 的同学**看的。
放 `docs/` 里他们找不到；而 README 顶部的下载入口直接指向它，
位置一改那条链接就是死链。`tools/check.js` 的第 7 项会守住这一点。

版本号**自动从 `manifest.json` 盖入**（`Omitone-1.1.1` / `版本 1.1.1` 这类形态），
并把压缩包名规范成固定的 `omitone.zip`。
以前是手工同步版本号，结果 1.1.1 发布时手册里还写着旧号 —— 现在人没有机会漏。

用系统已装的 Edge（找不到就退到 Chrome）无头模式打印，**不引入任何依赖**：

- 临时 `--user-data-dir` 放 `%TEMP%`，不去抢用户正在用的浏览器 profile
- PDF 先出到 ASCII 临时路径，再改名成中文名 —— 避免把中文路径交给浏览器命令行
- 打印完**校验产物**：页数、位图数（**必须为 0**，说明图都是矢量）、字体数。
  无头模式的 stdout 没有任何有用信息，"看产物"是唯一的成功判据
- 页数异常少（< 5）直接报错退出 —— 通常是 HTML 没渲染完就打印了

## github-release.js

```bash
npm run release -- push --message-file <提交信息文件> <改动文件...>
npm run release -- release <tag> --notes-file <Release说明文件>
npm run release -- verify  <tag>
npm run release -- replace-asset <tag>           # 附件过期时按同名替换，不必重发整版
npm run release -- check-msg <提交信息文件>      # 只校验提交信息形状，不联网、不需要令牌
```

**为什么会有 `replace-asset`**：tag 打完之后，main 上仍可能落**会影响安装包**的改动
（`page.js` / `content.js` / 说明书）。这时线上附件就是旧的 —— 用户点下载拿到的是修复前的版本，
而版本号和徽章看起来都是新的。`verify` 会按 **sha256 摘要**把这种情况报出来，
`replace-asset` 则按同名替换掉它（附件名不变 → 永久下载链接不受影响）。
两步是配套的：**verify 报 → replace-asset 修 → 再 verify 确认**。

⚠️ `verify` 曾经只按 `ASSETS[].src` 找对应附件，于是**打进 zip 的文件永远找不到附件**、
一律被判成过期 —— 自己建议"直接替换该附件"，自己却认不出已经换过了。现已改为
「直接附件源比它自己 / 打进包的文件比本地重新构建的 zip」，且优先比 sha256 而不是字节数。
```

**为什么不用 `git push`**：这台机器上 `git push` 能连上却永远不返回
（实测挂满 5 分半），而同一条网络下 `git fetch` 几秒完成、
`api.github.com` 与 `uploads.github.com` 都正常 —— push 通道单独不通。
详见 AGENTS.md §7.3。

**提交信息形状是硬性检查**（在发起任何请求**之前**拦下，不合格就一个字节都不发）。
规则：**一行中文主题、≤30 字、不加 `chore:` 之类英文前缀、不写正文**。

原因不是洁癖，是用户直接看得到的一处：

- GitHub 文件列表右侧那一列的提交信息**只放得下 30~40 字**，超了截断成"…"，一列全是省略号
- **鼠标悬停在那条提交信息上会弹出卡片，把整段正文显示出来**
- 实测接手时：最近 25 条提交主题平均 35 字、最长 60 字，**25 条全都带正文、平均 446 字**

详细说明写进 `CHANGELOG.md`（"为什么"的唯一真源）。`check-msg` 单独跑这条校验，
不联网也不需要令牌，所以能独立验证 —— 已用它验过 4 种情况（合格 / 主题超长 /
带正文 / 英文前缀），后三种都被拦下且给出了该怎么做。

三个子命令各自的关键点：

- `push`：`blobs → trees（**必须带 `base_tree`**）→ commits（**必须带 `parents`**）→
  PATCH refs（**必须带 `force: true`**）`。提交完自动 `git fetch` + `git reset --hard` 对齐本地 ——
  API 提交会被 GitHub 重新签名，远端 sha 必然 ≠ 本地 sha
- `release`：tag 指向**远端当前 sha**（不是本地 `git rev-parse HEAD`，否则 422）。
  已存在的 tag / Release 会被更新而不是报错
- `verify`：**发完必须跑**。确认 tag 指向 HEAD、每个附件 `state=uploaded`、
  以及 README 那条下载直链确实有同名附件 —— **接口返 200 不等于传完了**

⚠️ **附件名在脚本里写死**（`omitone.zip` / `使用说明.pdf`），不接受参数。
这是刻意的：README 的下载入口用的是 GitHub 永久链接
`/releases/latest/download/<附件名>`，它按**附件名**取最新一版的附件。
附件名一旦带上版本号，这条链接每发一版就失效一次，
而失效表现是"新用户点下载看到 404"——不报错、不留日志，
受影响又恰好是那批"只会点这一个链接、也不会来反馈"的用户。

令牌来源：环境变量 `GITHUB_TOKEN`，或 `.workbuddy/.ghtoken`（已 gitignore）。
用完记得删，并提醒提供者 revoke。

## fix-bom.js

默认只报告，`--write` 才落盘。

`manifest.json` 在这个项目里被编辑器写回 BOM 过多次。BOM 的麻烦在于报错信息里的那个字符
看不见，`Unexpected token '﻿'` 看起来像文件损坏，实际只是开头多了 3 个字节。
