# tools/ — 开发脚本

全部零依赖，只用 Node 内置模块。Node >= 18。

| 脚本 | 命令 | 作用 |
| --- | --- | --- |
| `check.js` | `npm run check` | 工程自检 |
| `prompt-bench.js` | `npm run bench` | 提示词 token 基准 + 兼容性自检 |
| `integration-test.js` | `npm run itest` | 集成测试：真实 `content.js` 的答题往返链路 |
| `browser-e2e.js` | `npm run e2e` | 真实 Edge 端到端：加载扩展 + mock 测验页 + mock 模型 |
| `build.js` | `npm run build` | 打包到 `dist/` |
| `fix-bom.js` | `node tools/fix-bom.js --write` | 清除被编辑器写回的 UTF-8 BOM |
| `ext-id.js` | `node tools/ext-id.js <目录> [已知ID]` | 反推未打包扩展的确定性 ID 编码 |

`npm test` = `check` + `bench` + `itest`；`npm run test:all` 再加上 `e2e`。

---

## check.js

不写文件、不发网络请求，可安全反复执行。检查项：

1. **JS 语法** —— 所有 `.js` 用 `vm.Script` 编译（会先剥掉 BOM，否则 `vm` 会当成非法 token）
2. **manifest 解析与 BOM** —— 带 BOM 时浏览器能加载，但 `JSON.parse` 会失败，这里直接拦
3. **引用文件存在性** —— manifest 里所有 `js` / `css` / `icons` / `popup` / `web_accessible_resources` / `service_worker`
4. **版本号三处一致** —— 与 `manifest.version` 比对 `name` / `default_title` /
   `popup.html`（`<title>` + `.ver`）/ `content.js` 状态面板品牌位
5. **唯一真源**（提示词 + API 地址构造）—— `content.js` 里若重新出现
   `buildQuestionsText` / `buildOutputFormat` / `Return format:` 字面量，
   或 `buildXxxApiUrl` 不再走 `API_URL.*`，即报错；
   同时校验 `manifest.content_scripts` 真的注入了 content.js 依赖的那两个 lib
6. **编码损坏探测**（告警级）—— 非注释行里的 GBK 乱码残留字符，如 `閫夐」`
7. **幽灵调用** —— 调用了但没定义的方法（剥注释后比对 `this._x(` 与定义）
8. **死方法**（告警级）—— 定义了但全项目无人调用的下划线方法
9. **死代码探测** —— 认出四条加载途径（`content_scripts` / `service_worker` /
   `web_accessible_resources` / HTML 的 `<script src>`），都不沾的 `.js` 会告警

失败时退出码为 1，可直接用于 CI。

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
message 监听器驱动完整答题往返。当前 35 项断言：

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
逐个访问本地 mock 页面，**逐功能交叉检验实际行为**。当前 14 个场景 / 129 项断言。

前置：本机装有 Edge。路径用 `OMITONE_EDGE` 覆盖；端口用 `OMITONE_E2E_PORT` /
`OMITONE_CDP_PORT` 覆盖；`OMITONE_E2E_DEBUG=1` 打印 target 列表与扩展 ID。

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

## build.js

产物：

- `dist/omitone-<version>/` —— 可直接「加载已解压的扩展程序」
- `dist/omitone-<version>.zip` —— 可上传开发者后台

采用**白名单**收集文件（`manifest.json` / `background.js` / `content.js` / `page.js` /
`libs` / `icons` / `popup` / `resources` / `LICENSE`），
所以新增开发文件不会被误打包；但新增运行时文件时记得加进 `INCLUDE`。

ZIP 由脚本自己写（`zlib.deflateRawSync` + 自实现 crc32），
条目名以 UTF-8 写入（通用位标记 `0x0800`）。

## fix-bom.js

默认只报告，`--write` 才落盘。

`manifest.json` 在这个项目里被编辑器写回 BOM 过多次。BOM 的麻烦在于报错信息里的那个字符
看不见，`Unexpected token '﻿'` 看起来像文件损坏，实际只是开头多了 3 个字节。
