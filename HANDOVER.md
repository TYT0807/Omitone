# HANDOVER.md — 接手这份代码，先读这一页

写给**下一个接手的人，尤其是接手这份代码的 AI**。

> ⚠️ 本文**故意不写技术细节**。技术细节的唯一真源是 [README.md](README.md) 与
> [ARCHITECTURE.md](ARCHITECTURE.md)。这里只讲：**开工前必须知道的状态、绝对不要做的事、
> 备份与发布流程、按症状找文件的索引、以及那些"不看就会踩"的地雷**。
> 重复写一遍细节，只会多出一份会过期的副本。
>
> 阅读顺序建议：**本文 §0（约 5 分钟）→ `AGENTS.md`（硬性约束）→ 需要用哪块再翻 README。**

---

## 0. 给接手的 AI：开工前必读

### 0.1 你的任务边界：**不引入新 bug，比多修一个 bug 更重要**

这不是客套。这个项目的故障形态几乎全都是**静默失败** —— 不报错、不留日志、功能就是不动。
用户看到的只是"这东西坏了"，然后走掉，**你不会收到任何反馈**。
所以一个引入的 bug 可能几个月都没人发现，而它造成的信任损失是不可逆的。

本仓库因此立了三条规矩，请当成硬约束：

1. **能不改就不改。** 修 A 的时候顺手"优化"B，是本项目历史上大多数事故的来源。
2. **要改就小步改。** 一次只动一件事，改完立刻跑测试；不要攒一大坨再一起验证。
3. **每步都要有测试兜着。** 先跑一遍建立基线 → 改 → 再跑一遍。
   **"跑起来没报错"不算通过**，要看断言和日志。

### 0.2 交接时的工作区状态（快照：2026-09-17）

> 这一段是**时间点快照**，会过期。先跑 `git log --oneline -3` 和 `git status --short`
> 自己对一下；如果工作区干净、远端 main 已经跟上，这整节可以跳过。

- **1.1.2 已发布并核验过**（Release + 两个附件都在，下载直链可用）。
- **1.1.3 的改动也已全部推送**：防拖拽视频 90%、弹题答错卡死修复、弹窗重做与无障碍、
  三个新守卫、图标瘦身。版本号已同步五处。

- ⚠️ **1.1.3 故意还没发 Release**（用户决定：等前端美化做完再一起发）。
  后果要说清楚：README 那条永久下载链接按**附件名**取「最新一版 Release」里的同名附件，
  所以**现在点下载拿到的仍然是 1.1.2**，而版本徽章已经显示 1.1.3。
  **这不是故障，是待办** —— 前端做完后按下面两步收尾即可。
- Release 说明**已经写好**，在 `.workbuddy/release-notes-1.1.3.md`，发的时候直接用，不用重写。
- 工作区**应当是干净的**。如果看到一堆未提交改动，先确认是不是别人的在制品，
  **不要直接 `git checkout .` 丢掉**。
- 发新版（**先读 §0.5 的令牌规矩**）：

  ```bash
  npm run release -- push --message-file <提交信息文件> <文件...>
  npm run release -- release v1.1.3 --notes-file .workbuddy/release-notes-1.1.3.md
  npm run release -- verify v1.1.3        # 必须跑，确认附件 state 与下载直链
  ```

  注意 `push` 子命令**没有** `git add -A` 那种"全都提交"的用法 —— 文件必须一个个列出来。
  这是刻意的：本项目误提交过自检产物（见 §7.5）。

- 交接前的整目录备份在 **`D:\Omite-backup-20260917-1846`**（含 `.git`，289 个文件 / 6.19 MB）。
  出事了从那儿恢复。

### 0.3 绝对不要做的事

按"违反了会出什么事"分组。前两组的代价是不可逆的。

**A. 会毁掉数据的**

| 不要做 | 原因 |
| --- | --- |
| **不要用 `git stash`** | 本项目执行过一次，`D:\Omite\.git` **整个目录消失**，历史全没了。要对比基线用 `git diff` 或复制目录 |
| **不要 `git add -A`** | 先看 `git status`。本项目误提交过 7 个自检产物并推上了 GitHub（commit `00202a6` 才清掉） |
| **多文件改动前不要跳过备份** | 见 §0.4。`.git` 都靠不住过一次，本地提交不是唯一保险 |

**B. 会把发布搞坏的**

| 不要做 | 原因 |
| --- | --- |
| **不要 `git push`** | 这台机器上它**能连上却永远不返回**（实测挂满 5 分半）。用 `npm run release -- push`（REST API） |
| **不要改发布附件名** | README 的下载入口是永久链接 `/releases/latest/download/omitone.zip`，**按附件名取件**。改名 = 所有新用户点下载看到 404，且不会有人来反馈 |
| **不要提前删令牌** | 顺序永远是「发版 → `verify` 核验 → 才删」。本项目栽过一次：tag 和 main 都推上去了，唯独 Release 没发出去 |
| **不要把说明书挪出仓库根目录** | `使用说明.pdf` 在根目录是刻意设计 —— 它是给不懂 GitHub 的人看的，埋进 `docs/` 就没人找得到 |

**C. 会静默打死功能的**（展开见 `AGENTS.md` §2 与 README §5 / §6）

| 不要做 | 会怎样 |
| --- | --- |
| **跨域 iframe 裸读 `.document`** | 抛 `SecurityError` 静默打断整个 tick 循环。必须走 `_safeDocOf()` / `_safeWinDoc()`。**这是最难查的一类 bug** |
| **新增没有超时的 `await`** | 任何永久悬挂都会让主循环死亡 |
| **删方法前不 grep 全部调用点** | 本项目发生过"删了函数留着调用点"，4 处里 3 处没 try/catch，整条功能静默失灵 |
| **把提示词 / API 地址构造内联** | 唯一真源是 `libs/prompt.js` 与 `libs/api-url.js`，历史上分叉过，症状是"弹窗测试通过、页面答题失败" |
| **改 `_runTick` 的判定顺序** | 那个顺序就是任务点的仲裁顺序，动它等于动心脏 |
| **让 `_isJobCompleted` 在拿不准时返回 `false`** | 它喂给"放弃"计数，误判会把必做任务点跳过。**拿不准必须返回 `true`** |
| **把 `禁:` 之类的易变内容插回题目中间** | 会破坏提示词前缀，DeepSeek 缓存命中率归零 → 用户账单翻十倍（§7.4） |

**D. 会让工作白费的**

| 不要做 | 原因 |
| --- | --- |
| **不要重构 `page.js`** | 8000+ 行 / 300 多个方法的巨石，分割收益大但风险更高。真要做，先补测试再动（§9） |
| **不要并行编辑同一个文件** | 工具都报成功，只有最后一个生效。改同一文件多处必须**串行**，每次改完 grep 回读确认落盘 |

### 0.4 做任何多文件改动之前：先备份

```powershell
# 备份到仓库外层的同级目录（不要放进仓库里，避免被提交）
$dest = "D:\Omite-backup-" + (Get-Date -Format 'yyyyMMdd-HHmm')
robocopy "D:\Omite" $dest /E /R:1 /W:1
```

**至少在这些动作之前做一次**：批量改文件、动 `page.js`、动 `resources/`、
大范围重命名、切分支、以及任何你自己也没把握的操作。

三条纪律：

- **备份放在仓库外**（`D:\Omite-backup-<时间戳>`）。放进仓库里会被 git 跟踪、被提交。
- **备份不等于提交。** 本地 commit 也重要（"勤提交"是这个仓库唯一的兜底，
  因为 `.git` 真的整个消失过一次），但它不能替代整目录备份 —— 两者一起坏。
- **不要删别人的备份**，除非使用者明确要求。

### 0.5 GitHub 令牌与发布

**令牌怎么要**（向使用者要的时候照这个说）：

- 必须是 **fine-grained PAT**（细粒度），**不是** classic token
- 生成页：`https://github.com/settings/personal-access-tokens/new`
- **只勾一个仓库**（Only select repositories → `Omitone`）
- 权限只给 **Contents: Read and write**
  （提交 / tag / **Release** 都归它管；fine-grained 没有单独的 Releases 权限）
- **有效期选 1 天** —— 使用者明确要求过"只给一次机会、令牌最好一天过期"
- 用完**主动提醒他去 revoke**：`https://github.com/settings/tokens`

**令牌存哪**：

- 推荐 `.workbuddy/.ghtoken`（该目录已 gitignore），或环境变量 `GITHUB_TOKEN`
- ⚠️ **绝不要**写进源码、日志、提交、README、issue、聊天记录
- ⚠️ **不要**为了省一次往返就去 `git credential fill` 把使用者存在凭证管理器里的令牌掏出来用 ——
  他给令牌是一次明确的授权动作，绕过它等于替他做决定

**发布的固定顺序（不能颠倒）**：

```
发版（push → release） → verify 核验 → 才删令牌
```

- `verify` 会确认三件事：tag 指向 HEAD、每个附件 `state=uploaded`、
  以及 README 那条下载直链确实有同名附件。
  **接口返 200 不等于传完了** —— 必须看 `assets[].state`。
- **旧版本的 Release 一律保留**，方便用户回退。

### 0.6 怎么知道自己改坏了

| 你动了什么 | 必须跑什么 | 判据 |
| --- | --- | --- |
| 任何东西 | `npm test` | **全绿**（自检 13 项 + 提示词基准 + 集成 52 项） |
| 答题链路 / 抠题 / 媒体 / 任务点调度 / `content.js` | `npm run e2e` | **187 / 187**（约 1~2 分钟，会起一个独立 Edge 临时 profile，不碰你正在用的浏览器） |
| 提示词（`libs/prompt.js`） | `npm run bench` | 总 token **不反弹**，且「前缀缓存可命中性」那一节**不能变差** |
| 发版前 | `node tools/publish-audit.js` | 无密钥 / 本机路径 / 邮箱 / 大文件误入公开仓库 |
| 新增了任何断言 | 手动反向验证 | **临时制造一个已知错误，确认它能被抓住**。不会失败的检查等于没有检查 |

几个容易误判的信号：

- **e2e 全线失败、页面里却一条异常都没有** → 先看输出的 `扩展 ID:` 那一行（§7.2），
  很可能是 shell 把盘符变成了小写，**不是你的代码坏了**。
- **`ls` / `sed` / `grep` 报 `command not found`** → 这台机器的 PATH 坏了，
  不是你把系统搞坏了。改用专用工具（读文件 / 搜索各有工具），或全路径调 `node`。
- **`git diff` 显示"整个文件每一行都改了"** → 很可能只是换行符（CRLF/LF）差异。
  本仓库 `.editorconfig` 要求 LF；走 API 提交时脚本会自动归一化（见 `tools/github-release.js` 的 `toLf`）。
  **不要**在这种情况下提交，先把换行符搞清楚。
- **诊断换行符不要用 shell 管道** → 在这台机器上它会给你**相反**的答案：
  `grep -c $'\r' <文件>` 在**真正的 CRLF 文件**上返回 `0`；
  而放进 `$( … )` 里跑，**纯 LF 的 3 行输入也会返回 3**（两者都实测过）。
  判据只有两个：`git ls-files --eol <文件>`（看 `i/lf` 与 `w/crlf`），
  或直接用 node 数字节。**用错方法会让你把 LF 仓库"修"成 CRLF** —— 正是 §0.3-B 要避免的事。

---

## 1. 三十秒速览

| | |
| --- | --- |
| 项目 | 学习通（超星）网页版学习辅助浏览器扩展，Manifest V3，零依赖、无构建步骤、无后端 |
| 当前版本 | **1.1.3**（功能收官，进入 bug 修复期） |
| 代码规模 | `page.js` 约 8.6k 行 / 300 多个方法；`content.js` 约 1.4k 行；`libs/` 合计约 3.6k 行 |
| 扩展体积 | 解压后约 **770 KB**（其中 `page.js` 365KB、`resources/table.bin` 122KB） |
| 测试基线 | 自检 13 项 · 集成 52 项 · 真实 Edge 端到端 **187 项** · 提示词基准 1 份报告，**全绿** |
| 运行方式 | 加载解压缩目录；用户密钥存 `chrome.storage.local`，无任何自有服务器 |
| 用户是谁 | 两拨人：**不懂 GitHub 的同学**（只点 README 顶部那个下载链接）、**会写代码的接手者**。文档要分开写 |
| 许可 | GPL-3.0（上游作者意愿优先，见 README 末尾致谢与侵权处理） |

---

## 2. 文档分工（别写重复内容）

| 文件 | 负责什么 | 不要往这里写 |
| --- | --- | --- |
| **README.md** | 面向**用户**：怎么装、怎么用、已知缺陷、密钥安全、边界 | 内部实现细节 |
| **`使用说明.pdf`**（源 `docs/manual.html`） | 面向**完全不懂技术的使用者**：图文步骤、界面截图、常见问题。**按"从没用过 GitHub"来写** | 开发相关内容（他们不看） |
| **ARCHITECTURE.md** | 面向**开发者**：模块关系、数据流、设计取舍 | 操作步骤 |
| **AGENTS.md** | 面向**AI**：硬性约束、改动禁区、环境地雷 | 技术细节（它只写"怎么做事"） |
| **HANDOVER.md**（本文） | 接手索引：状态 / 导航 / 任务动作 / 待办 | 与上面两份重复的细节 |
| **CHANGELOG.md** | 每版改了什么、**为什么**这么改 | 使用说明 |
| **tools/README.md** | 开发脚本怎么用、每个测试覆盖什么 | 产品说明 |

改文档时的规则：**同一件事只写一处，别处只放链接。** 这个仓库已经因为"同一份逻辑写两遍"
吃过亏（见 AGENTS.md §2 与 README §6 的多条记录）。

---

## 3. 按症状找文件（最高频的入口）

| 你想改…… | 去这里 | 关键入口 |
| --- | --- | --- |
| 刷课调度 / 任务点仲裁顺序 | `page.js` | `_runTick`（**判定顺序就是仲裁顺序，动它等于动心脏**） |
| 视频播放、倍速、静音、拖到结尾 | `page.js` | `_ensurePlaybackRate` / `_trySeekToEnd` / `_getVideoEl` |
| 防拖拽+锁1x 的视频「看到 90% 就进下一个」 | `page.js` | `_shouldAdvanceAtNinetyPercent` / `_isNinetyPercentVideo` / `_finishCurrentMedia`（**改前先读 §9 那条分叉**） |
| 抠题（题干 / 选项 / 题型） | `page.js` | `_extractQuestions` / `_collectQuestionContainers` / `_getOptionItems` |
| 答题回填与交卷 | `page.js` | `_handleQuiz` / `_fillAnswers` / `_areQuizAnswersFilled` / `_maybeSubmitQuiz` |
| 视频内弹题、播放器右下角「继续学习」 | `page.js` | `_activePopupBlock` / `_handlePopupQuiz` / `_tryContinueStudyPrompt` |
| 提示词（**唯一真源**） | `libs/prompt.js` | `buildUserPrompt` / `normalizeItem` |
| API 地址与密钥清洗（**唯一真源**） | `libs/api-url.js` | `buildOpenAICompatibleUrl` 等 |
| 字形哈希表格式（**唯一真源**） | `libs/font-table.js` | `encode` / `decode` / `fromObject` |
| 字体反爬解密流程 | `content.js` | `getDecryptTable` / `buildDecryptMapForDoc` |
| 跨域请求代理、抓图转 dataURL | `background.js` | `apiFetch` |
| 设置界面 | `popup/popup.html` + `popup/popup.js` | `PROVIDER_PRESETS` / `applyProviderPreset` |
| 打包与发版 | `tools/build.js` / `tools/github-release.js` | `INCLUDE` / `EXCLUDE` / `ASSETS` |
| 用户下载入口（改前先读 §0.3-B） | `README.md` 顶部 / `tools/check.js` | 第 7 项「用户入口守卫」 |
| 自检与测试 | `tools/check.js` · `integration-test.js` · `browser-e2e.js` · `prompt-bench.js` | 见 tools/README.md |

---

## 4. 上手三步

```bash
git clone <repo> && cd Omitone
npm test                      # 秒级：自检 + 提示词基准 + 集成测试
npm run e2e                   # 约 1~2 分钟：起一个独立 Edge 临时 profile，187 项交叉检验
```

**两条都要绿才算建立好基线**，之后每次改动都用它们对比（见 §0.6）。

加载调试：`edge://extensions` → 开发者模式 → 加载解压缩的扩展程序 → 选仓库根目录
（`manifest.json` 就在根目录，不需要先 build）。**改完代码要「重新加载」+ 刷新学习通页面（F5）**，
只重载扩展不刷新页面会让旧 content script 与扩展断连，症状是"功能全停、日志不动"。

---

## 5. 常见任务的固定动作

### 加一个配置项

按 README §9 的清单逐处补齐（`DEFAULT_CONFIG` 三份 + 消费点 + content + popup）。
**三份默认值没有 schema 校验，漏一处不会报错，只会表现成"开关不起作用"。**

### 改提示词

只改 `libs/prompt.js`，然后：

```bash
npm run bench
```

必须盯住两个数：**总 token 不能反弹**，以及**「前缀缓存可命中性」那一节不能变差**
（详见 `libs/prompt.js` 文件头 v3 说明）。改完跑一次 e2e —— 提示词形状变了，
`browser-e2e.js` 里的假模型解析器会立刻报错，那是有意的设计。

### 加一个平台适配（新选择器 / 新模板）

1. 先加**诊断**再改逻辑：让 `xxtAI.diagnose()` / `xxtAI.diagnosePopup()` 能把现场打出来
2. 选择器清单只写一处，别在多个分支里各抄一份
3. 加一条 e2e 场景（`tools/browser-e2e.js` 里加 mock 页面 + SCENARIOS），并做**反向验证**：
   临时制造一个已知错误，确认断言能抓住它。不会失败的断言等于没有断言

### 更新字形映射表（字体反爬）

```bash
# 1) 改 resources/table.json（唯一真源，可读文本）
# 2) 重新生成紧凑表
node tools/table-pack.js --pack
# 3) 自检会逐条比对 bin 与 json，不同步直接失败
node tools/check.js
```

`--unpack` 可以把 bin 还原成 json；`--verify` 单独校验。

### 改说明书（图文 PDF）

```bash
# 改内容改 docs/manual.html（排版真源，内联 SVG + A4 打印 CSS）
npm run manual        # → 仓库根目录 使用说明.pdf
```

- **版本号不用手工改** —— 脚本从 `manifest.json` 取当前版本盖进 PDF。
  （以前是手工同步，结果 1.1.1 发布时手册里还写着旧号）
- 脚本会校验产物：**位图数必须是 0**（说明图都是矢量，缩放印刷不糊）、页数不能异常少
- **PDF 放仓库根目录，不放 `docs/`** —— 它是给"完全不懂 GitHub 的同学"看的，
  放 `docs/` 里他们找不到。README 顶部的下载入口直接指向它
- 改了手册内容**页数会变**，README 文档地图里写了页数（现在是 13 页），记得同步

---

## 6. 发版流程

1. `npm test` + `npm run e2e` 全绿（§0.6）
2. **同步版本号五处**（含 `package.json` 与 README 顶部的「版本」徽章）：`manifest.json`（`name` 与 `version`、`default_title`）、
   `popup/popup.html`（`<title>` 与 `.title`、`.ver`）、`content.js` 品牌位、`package.json`。
   漏一处 `check.js` 会直接报错。
   （`docs/manual.html` 里的版本号由 `npm run manual` 自动盖入，不用手工管）
3. 写 `CHANGELOG.md`（写**为什么**，不只写做了什么）
4. `npm run build` → `dist/omitone-<version>/` 与 `.zip`（`dist/` 不入版本库）；
   这一版动过手册的话再 `npm run manual`
5. `node tools/publish-audit.js` 扫一遍（密钥 / 本机路径 / 邮箱 / 大文件是否误入公开仓库）
6. **发版（别用 `git push` —— 会永久挂起，见 §7.6）**：

   ```bash
   npm run release -- push --message-file <提交信息文件> [--delete <被删文件>] <改动文件...>
   npm run release -- release v<版本> --notes-file <Release说明文件>
   npm run release -- verify v<版本>      # 必须跑
   ```

   Release 说明讲清**这一版修了什么、怎么升级、有什么取舍**
7. **附件名固定为 `omitone.zip`** —— 脚本已经写死，不用你操心；
   想改名前先读 §0.3-B（README 的下载入口是永久链接，改名即失效）
8. **旧版本的 Release 一律保留**，方便回退

---

## 7. 环境地雷（真踩过，代价很高）

### 7.1 不要用 `git stash`

在本项目的工作环境里执行过一次 `git stash push`，结果 `D:\Omite\.git` **整个目录消失**，
stash 对象自身也报 `is not a valid object` —— 历史、分支、stash 全没了。
需要对比基线时用 `git diff` / 复制目录。**多发改动前先提交或整目录备份（见 §0.4）。**

### 7.2 换 shell 会让 e2e 全线失败 —— 但错不在扩展

扩展 ID 的算法是 `SHA256(目录绝对路径, UTF-16LE)`，**路径大小写敏感**：
`D:\Omite` → 正确 ID；`d:\Omite` → 完全不同的 ID。
从 Git Bash / WSL 风格的 cwd（`/d/Omite`）启动 node，盘符会变小写，哈希整个错开。
症状是 **全部场景都报"page.js 加载失败"，而页面里一条异常都没有** ——
极具误导性，很容易误判成"扩展坏了"或"代码有回归"。

**判断方法**：跑 `npm run e2e`，看输出的 `扩展 ID:` 那一行。正常是 `hdlemlcmf…`。

### 7.3 并行编辑同一个文件会互相覆盖

工具都报成功，只有最后一个生效。**改同一文件多处必须串行**，每次改完 grep 回读确认落盘。

### 7.4 提示词压得太短反而更贵

DeepSeek 靠"请求前缀完整匹配已持久化的缓存单元"命中。把提示词压到极短会让
**跨请求的公共前缀短到无法被识别成缓存单元** → 命中率恒为 0 → 全部输入按原价计费。
用户看到的是账单翻十倍，而代码"看起来更省了"。

所以 `libs/prompt.js` 现在固定成「稳定头 → 题目块 → 易变尾」三段，
`tools/prompt-bench.js` 有专门的指标守着这条。**别再把 `禁:` 之类的易变内容插回题目中间。**

另外，**也别为了「凑缓存长度」去加长稳定前缀**。实测（DS V4 Flash）：当前稳定前缀
system 70 + 消息头 14 = **84 token**，现场命中率**仍然是 0**。加长到 256 的账是：
真命中省 12%，但若仍不命中就**多花 36%** —— 赢面还是无证据的。
完整推导写在 `libs/prompt.js` 文件头的 v3.1 段，改提示词前先读那段。

### 7.5 清理临时产物

临时文件放 `.workbuddy/`（已 gitignore）。**`git add -A` 之前先看 `git status`** ——
本项目发生过把自检输出（`.c1.txt` 之流）一起提交并推上 GitHub 的事故（commit `00202a6` 修的）。

### 7.6 `git push` 会挂起，但 `git fetch` 正常

本机网络下 `git push origin main` **能连上却永远不返回**（跑了 5 分半仍在挂），
而 `git fetch` 只用几秒、GitHub REST API 也是 1 秒内 200 —— 说明是 **push 通道单独不通**，
不是网络整体故障、也不是凭证问题。

**别用连通性探测去判断这种情形** —— 探测全绿，push 依然挂。
要么直接用本仓库脚本（§6 第 6 步），要么给 `git push` 加硬超时：
`timeout 45 git push origin main`（退出码 124 即判定不可用）。

走 API 提交要注意三件事（脚本已经处理好，改脚本时别删）：

- `POST /git/trees` **必须带 `base_tree`**，否则整棵树被替换成只剩这几个文件
- `POST /git/commits` **必须带 `parents`**，否则历史断掉
- `PATCH /git/refs/heads/main` **必须带 `force: true`**，否则 422 `Update is not a fast forward`
- **文本文件要归一化成 LF 再上传** —— API 提交绕过了 git 的换行符转换，
  不归一会让仓库里的文件变成 CRLF，之后任何人 `git diff` 都会看到"整个文件全改了"
- 提交后本地会与远端分叉（API 提交会被 GitHub 重新签名），
  用 `git fetch origin main` + `git reset --hard <远端sha>` 对齐，**不要再 push**

**核对「到底推上去了没」时注意三点：**

1. 本仓库的 `origin/main` **时有时无**，而**这不是仓库配置问题** —— 实测 `remote.origin.fetch`
   配着 `+refs/heads/*:refs/remotes/origin/*`，好好的。真实原因是：**这台机器的 git 通道会间歇性
   报 `CONNECT tunnel failed, response 502`，fetch 一直失败，引用自然就建不出来**。
   实测证据：某次 `git fetch origin main` 成功时，输出里出现了
   `* [new branch]  main -> origin/main`，引用立刻就补上了。
   所以 `git rev-parse origin/main` 报 `unknown revision` **不代表没推上去**。
2. ⚠️ **不要吞掉 fetch 的错误**（`-q 2>/dev/null`），也不要把「没有 origin/main」当成仓库配置问题。
3. `git fetch` 失败时还会**把 `FETCH_HEAD` 清掉**，别拿它当长期引用。

> 这条说明我前后写错过**两版**（先说「仓库没有 refspec」、后说「显式 ref 不更新远端跟踪分支」），
> 两版都是凭一次观察就下结论。**上面这一版只写实测到的现象**，不再给没验证过的机制解释。

**对齐本地最稳的办法是直接用远端 sha**：`git reset --hard <sha>` ——
fetch 成功过一次之后，那个 commit 对象就已经在本地库里了（实测可行，`git cat-file -t <sha>` 返回 `commit`）。
远端 sha 用 REST API 取：`GET /repos/<owner>/<repo>/git/ref/heads/main`，
与本地 `git rev-parse HEAD` 对比。实测 git 通道 502 的同时，API 一直是 200。

**为什么「API 一直好、git 间歇性 502」**：这台机器设了**本地代理环境变量**
（`http_proxy` / `https_proxy` 指向 `127.0.0.1:<端口>`，是梯子客户端开的）。
**git 会读这些变量**，所以 git 走代理；**Node 的内置 `fetch` 默认不读**，
所以脚本里的 REST API 调用是直连 —— 这就是两条路表现不同的原因。
那句 `CONNECT tunnel failed, response 502` 是**代理回给你的，不是 GitHub 回的**。

实测（2026-09-17）：直连 `curl --noproxy '*'` 到 api.github.com 只要 **0.30s**，
走代理反而要 **1.25s**；`env -u http_proxy -u https_proxy git fetch origin main` 也能成功。
所以 **git 卡住时先试绕过代理**（或换个梯子节点），不要急着怀疑仓库或代码。

### 7.7 `npm run release -- push` 报「失败」**不等于没推上去**

`push` 子命令最后一步是 `git fetch origin main` + `git reset --hard`（把本地对齐到远端）。
这一步走的是 **git 协议通道**，会间歇性 502；而**提交本身走 REST API**（一直可用）。
所以会出现这种极易误判的输出：

```
  提交 → b069a08   ← 已经推到 GitHub 了
  main → b069a08
对齐本地（不要 push，代价见 AGENTS.md §7.3）...
失败：Command failed: git fetch origin main
fatal: unable to access ...: CONNECT tunnel failed, response 502
```

**看到这个「失败」不要重推** —— 重推会多一个内容重复的提交。正确做法：

1. 先核对远端是否已经是那个 commit：`GET /repos/<owner>/<repo>/git/ref/heads/main`
2. 确认推上去了，再补一次本地对齐：`git fetch origin main && git reset --hard origin/main`
   （fetch 继续 502 就等网络恢复再试；本地文件内容不会因此丢失）

判断依据很简单：**输出里出现过 `main → <sha>`，就说明提交成功了**，后面那个「失败」
只是收尾没做完。

### 7.8 令牌要等整件事做完再删

本项目在这一条上栽过一次：Release 还没建就把 `.ghtoken` 删了，导致 tag 推上去了、
main 也推上去了，**唯独 Release 和附件没发出去**，只能再向使用者要一次令牌。
**清理顺序是"发版 → verify 核验 → 再删令牌"。** 详见 §0.5。

---

## 8. 已经修过、别再"修"一遍

这一节是为了防止"好心重做一遍"——修 A 的时候顺手把已修好的 B 又改坏，是本项目真实发生过的事。
遇到下面这些现象，先确认是不是已经被处理过。

| 现象 | 状态 |
| --- | --- |
| 视频弹题"一直问模型却填不进去"、课程原地空转 | **1.0.12 已修**：补了通用结构识别（原生 `li + input`）、同题最多问 3 次、失败后 60 秒冷却并留 DOM 快照 |
| 只发部分题时答案 index 错位回填 | **已修**，`npm run itest` 守着这条（人工测试覆盖不到，必须靠集成测试） |
| 提示词输入几乎全未命中缓存、账单偏高 | **1.1.1 已修**：提示词重排为「稳定头 → 题目块 → 易变尾」+ 重试整批重发（见 §7.4） |
| 扩展解压后 963 KB 太臃肿 | **1.1.1 已修**：映射表改紧凑二进制 `table.bin`（347→122 KB），**1.1.1 当时**降到 751 KB（此后 page.js 增长，当前约 773 KB）|
| 弹窗里一堆服务商预设都不能用 | **1.1.0 已修**：删掉 6 家未实测的预设，只留 DeepSeek / Claude / Gemini / 自定义 |
| README 里同一份「已知缺陷」写了两遍且互相冲突 | **1.1.1 已合并**为一节 |
| 说明书版本号滞后、藏在 `docs/` 里找不到 | **1.1.2 已修**：搬到仓库根目录 + `npm run manual` 自动盖版本号 |
| 不懂 GitHub 的人装不上 | **1.1.2 已修**：README 顶部直链下载 + 「三步装好」 |
| 发布附件改名导致下载直链失效 | **1.1.2 已加固**：附件名在 `tools/github-release.js` 里写死，`check.js` 有守卫 |
| issue 模板里写着过期版本号 | **1.1.2 已修**：改成不写死版本，从扩展卡片上抄 |
| 防拖拽视频白等最后 10% | **已做**：`advanceAtNinetyPercent`（默认开）。判据是「拖不动 **且** 倍速锁 1x」，**并且必须由平台自己给出完成标记**才提前结束。别把它改成「播够 90% 就算完成」—— 那会在平台还没认可时误跳过任务点 |
| 三份「managed media job ended」收尾各写一遍 | **已统一**：`_handleVideoEnded` 现在走 `_finishCurrentMedia`。它原本多清 `_activeDocumentJob*`，**那三行是过界的**（`nextUnit()` 提前返回时会放弃正在进行的文档任务点）。别再把它加回去，e2e 有断言锁着 |

---

## 9. 当前已知未解决 / 建议下一步

| 项 | 说明 | 建议 |
| --- | --- | --- |
| **`configs` 没有 schema 校验** | 三份默认值服务的目的不同（page 全部开关 / popup 界面上的 / content 兜底），**本就不该一样**。真正会出事的「读了却没默认值」已由自检第 12 项守住，一上线就抓出 2 个 | 剩下只是「没有类型/范围校验」，收益不高，**暂不做** |
| **`page.js` 体量（365KB / 8600 行）** | 它是主体但也是唯一的巨石；分割收益大、风险更高 | **先补测试再动**，按"预览 / 答题 / 媒体 / 调度"切 |
| **密钥只在 `chrome.storage.local`** | 已经足够安全（无自有服务器），但没有加密 | 不必改；文档里已给出可自验方法 |

---

## 10. 最后三句

1. **先读 `AGENTS.md`** —— 硬性约束在那里（跨域 iframe 不许裸读 `.document`、新增 `await`
   必须可超时、删方法前 grep 全部调用点），违反会**静默**打死主循环。
2. **别通读 `page.js`** —— 8000+ 行里绝大多数与你的任务无关。用本文 §3 的索引 +
   搜索定位，读文件时只读目标函数附近。
3. **先跑测试建立基线，改完再跑一遍，全绿才提交** —— 这比通读代码更能发现回归。
   新增断言一定要做反向验证：**不会失败的检查等于没有检查。**
