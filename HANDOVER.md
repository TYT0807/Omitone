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

### 0.2 交接时的工作区状态（快照：2026-09-19 凌晨）

> 这一段是**时间点快照**，会过期。先跑 `git log --oneline -3` 和 `git status --short`
> 自己对一下；如果工作区干净、远端 main 已经跟上，这整节可以跳过。
>
> **本次交接后已推进到**：`1.1.6` 已发布并核验，**说明书已重写成「担架级」**（见下）。

#### ✅ 最新快照（2026-09-21 傍晚）—— 已全部推送上远端

**本地与远端已完全同步，线上附件也已换成含「乱选」的新包。**
（快照写于 2026-09-21 傍晚；之后又加了 `a070e24`「备好 page.js 拆分说明」与
`dcc44fe`「page.js 拆成 12 个按域片段，行为不变」两个提交 —— 见 §0.2.2，
**这两个还没推上远端**。**以 `git log --oneline -3` 和 `git status --short` 为准**。）

| | |
| --- | --- |
| 本地 / 远端 | 远端 main 是 **`bd7b166`**；本地领先 **2 个提交**（`a070e24`、`dcc44fe`），**尚未推送** |
| 工作区 | 干净 |
| 测试 | 自检 14 项 · 集成 77 项 · e2e **26 场景 / 280 项**（落盘 `通过=true`） |
| 线上 Release | v1.1.6 · `omitone.zip` 360.9 KB（sha256 `7cab586768fd…`）· `Omitone-manual.pdf` 1360.6 KB（sha256 `a73ff8877e07…`），均与本地构建逐字节一致 |
| 备份 | `D:/Omite-backup-20260921-160904`（41 个文件，基线 `1dd22d8`） |

**本次推上去的 8 个提交**：

```
bd7b166  交接稿加快照：本地领先远端七个提交
757c9f0  弹窗开关按 id 逐个点名，抓误删
14fb358  守则补两条假信心陷阱：node -e 内联中文、&& 链静默断掉
ed279ab  补弹题路径的乱选测试：不发请求且真选上
a1b70e7  乱选自审：补 submittedById 守卫与端到端填充断言
0d82202  说明书补乱选：没 Key 也能把卷交出去
b7419dc  乱选模式补边界测试：随机性、与 key 无关、enableQuiz 语义
846c4f9  新增乱选模式：不接 AI 本地随机作答
```

**本次新增的功能：「乱选」模式** —— 不接 AI、本地随机作答，给不想配 API Key 的用户用。
弹窗「答题」组里的开关 `randomAnswer`。与既有功能的冲突逐条查过并处理：
`_getQuizApiUnavailableReason`（不乱跳题）、三个 `_remember*` 答案缓存（全部短路）、
视觉读题（跳过）、`enableQuiz`（仍要开着，关掉=完全不答题）。
细节见 CHANGELOG 的「新增乱选模式」「乱选模式自审」两节。

**下次要推送时**：

```bash
# 1) 要一枚细粒度 PAT，写进 ~/.omitone-release.ghtoken（见 §0.5）
# 2) 直接推 —— **令牌放进 URL 即可，保留完整提交历史**（见 AGENTS §7.3）
TOKEN=$(cat ~/.omitone-release.ghtoken | tr -d '\r\n')
git -c credential.helper= push "https://x-access-token:${TOKEN}@github.com/TYT0807/Omitone.git" main
# 3) 若 tag 之后有影响安装包的改动，换附件
npm run build && npm run release -- replace-asset v1.1.6 && npm run release -- verify v1.1.6
```

- **最新一次提交是 `1742b9f 修作业页回填与提交后判定`**（远端 `main` 已跟上，9 个文件逐个比对字节一致）。
  这是给「题目一直扫描、不做事、AI 重复提交」那台真实现场修的最后一刀，细节全在下方
  §0.2 第 4 段与 CHANGELOG「发版后补的第四、五个修复」。**两个新洞都在 `page.js`，
  修了回填隐藏域（`_clickOptionItem` 的 qid 三级回退 + 判别题以控件 `value` 为权威）
  与提交后完成判定（新增 `_isQuizResultPageFinished`）。**
  端到端现在是 **26 个场景 / 280 项**，新增「作业页选项写入隐藏答案域」（8 项）
  与「作业页提交后认出已完成」（9 项）。
- **测试基线：自检 14 项 · 集成 77 项 · 真实 Edge e2e 280 项（26 个场景）· 提示词基准通过**。
  `npm run check` 的数字守卫已对上 `.workbuddy/e2e-counts.json`。
- **`dist/` 已按新代码重新打包**：`dist/omitone-1.1.6.zip` 353.4 KB（18 个文件），
  `dist/omitone-1.1.6/content.js` 含 4xx 代码、`page.js` 含本轮修复。
  ✅ **线上 Release 附件已换成新包**（`replace-asset v1.1.6`，同名替换、没重发整版）。
  换过两次：先是作业页修复那批，之后又多选补选修复那批（`839c12e`）——
  每推一次**会影响安装包**的代码，线上 zip 就旧一次，所以每次都要重跑一遍。
  `verify` 已按 **sha256 逐字节**确认两个附件都与本地构建一致：
  `omitone.zip` f868f65f… / `Omitone-manual.pdf` 56899378…。用户点下载拿到的就是修好的版本。
- **令牌状态**：`~/.omitone-release.ghtoken` 还在（93 字符细粒度 PAT，本快照时 `GET /user` 仍 200，
  但按 §0.5 的规矩它只有 1 天有效期，**到你看到这段时很可能已过期** —— 过期就按 §0.5 重新要，
  别在"为什么是 401"上排查。若仍有效且不再发版，提醒用户去 revoke）。
- **工作区现在是干净的**；若你看到脏工作区，先跑 `git status` 对一下再动手。

- **1.1.2 / 1.1.3 / 1.1.4 / 1.1.5 均已发布并核验过**。
  下载链接按**附件名**取「最新一版 Release」（当前 latest 是 v1.1.6，但其附件是 `1742b9f` 修复前的打包，见 §9 第一行）。
- **1.1.6 已发布并核验过**（`main` 已跟上，tag `v1.1.6` 指向发布提交，
  两个附件 `state=uploaded`）。内容五块：
  ① 修「没有任务点的微课 PDF/WPS 文档卡住不动」；
  ② 弹窗字体放大（宽 400px、基准 14px、**全库最小字号 12px**）；
  ③ 视觉模型从「只认验证码」放开到「也能看题」，**默认关闭 + 四道成本闸门**；
  ④ **修好说明书入口**（原来是 `blob` 代码视图，对 PDF 是"赌运气"渲染，
     用户实测报 `Unable to render code block`）—— 改成「Pages 在线真网页 + Release 附件下载」双入口；
  ⑤ **说明书内容重写成「担架级」**：每个动手处都配一张四问表
     （看到什么 / 点哪里 / **怎样才算对** / 不对怎么办），14 页 → 20 页。
  发版后又补过两个提交（都在 tag 之后，**不影响用户下载**，verify 判为绿灯）：
  `274f1a1` 发布校验器读不到打包白名单时改为报红（原来会"跳过判断 = 假装没问题"）、
  `892e6d0` 说明书封面补两个下载直链（说明书会被单独转发，正文里没有可点链接就是空话）。
  后者使 PDF 从 1349.2 KB 变 1354.3 KB，**附件已单独替换**（删旧 → 重传同名，未重发整版）。
  再往后又补了四个提交（同样在 tag 之后，**不影响用户下载**）：
  `8ce8dae` 修「HTTP 4xx 被当成网络故障」的第一半 —— `content.js` 认了 401/403
  （不重试、不写 `apiConnectionFailed`），并补上集成测试
  （`401` 只发 1 次 / 带 `permanentError` / 不污染连接状态，`500` 行为不变）；
  `8709dd3` 补上「题目在 `#frame_content` iframe 里」的端到端场景
  —— 这条路径此前**零覆盖**，222/222 全绿并不代表它是对的；
  `c9cfb7b` 修「作业/考试页点了选项却不生效」：那套 `.Cy_*` 结构里
  选项**文本**在 `.Cy_ulTop`、**可点的 input 在 `.Cy_ulBottom`**，是两个分开的 ul；
  `_getOptionItems` 抢先命中文本那一列 → `item.querySelector('input')` 恒为 null
  → 一下都没点到，但 `clicked++` 照样加，调用方当成功照样提交 → 空转。
  改法是按索引把控件配对挂到文本节点上（`_pairOptionControls`），参考 cxmooc-tools
  的 `cxExamSelectQuestion`（它直接拿 input 当选项节点、文本另按位置取）；
  `0f345a2` 修「4xx 仍然走 45 秒退避」的第二半，见下一段。
- ⚠️ **`0f345a2` 修的是上面 `8ce8dae` 没修透的那一半**，值得单列一条：
  `content.js` 确实已经把 4xx 标成 `permanentError` 了，但 `page.js`
  **从来没读过这个字段** —— 拿回 `{success:false, permanentError:true}` 之后
  一律走 `_markQuizApiConnectionFailed`，照样设 45 秒退避。
  于是「Key 填错了」在用户眼里仍然是「插件每隔 45 秒卡一下」，
  而服务商明明把 `Invalid API key` 原话返回来了。
  现在 4xx 单独一支：跳过本轮 60 秒（`PERMANENT_LLM_ERROR_SKIP_MS`）、
  把服务商原话留在 `_quizApiLastError`、**不进退避窗口**；
  视频弹题同源修法改走 `_giveUpPopupQuiz`（关弹窗 + 60 秒冷却，不拿坏 Key 反复撞接口）。
  端到端新增两个场景：**401 不退避**，外加**「500 仍然退避」的对照** ——
  少了对照，"凡是失败都不退避"这种改法也能通过前一组断言。
  两条断言都做过**反向验证**：把新分支废掉（`if (false && …)`）重跑，
  「401 不进 45 秒退避」立刻变红并打印出被设成 `+45s` 的 `_quizApiFailUntil`，
  而 500 对照仍绿；恢复后全绿。
  紧接着用户又报「**题目一直扫描，但是不做事，AI 重复提交**」并贴了实测控制台日志，
  查下来是另外两个各管一段的洞（都在 `page.js`）：
  `_clickOptionItem` 写隐藏域的条件是 `qid && badge` **同时**成立，
  而真实作业页两样都没有（qid 挂在容器 `.Cy_TItle[qid]` 上、也没有 `.num_option` 徽标）
  —— 点击照做、日志照打 `clicked option`，`#answer{qid}` 却一直是空串，
  `_areQuizAnswersFilled` 判 false，整卷永不提交；
  `_isQuizPassedOrFinished` 只认课程章节页那套完成标记，
  作业/考试提交后翻出的是**判分结果页**（`.Py_answer` 一族 + 控件全 `disabled`），
  一个都不命中 → `_monitorQuizSubmit` 一直 hold → 25 秒超时 → 整页重载 → 重扫重答重交。
  修法：qid 三级回退 + 把"写隐藏域"从徽标那组操作里拆出来 + 判别题以控件 `value` 为权威；
  新增 `_isQuizResultPageFinished`（三条判据同时成立才算完成，宁可漏判不误判）。
  端到端新增「作业页选项写入隐藏答案域」与「作业页提交后认出已完成」两个场景，
  后者特意把 mock 结果页做成真实判分页，并断言**旧判据对它确实认不出来**。
  测试基线：自检 13 项 · 集成 **77** 项 · 真实 Edge e2e **280 项**（26 个场景）。
- 工作区现在应当是**干净的**；若你看到脏工作区，先跑 `git status` 对一下再动手。
- 工作区**应当干净**（发布与说明书重写都已提交）。若你看到脏工作区，
  先跑 `git status --short` 与 `git log --oneline -3` 对一下再动手 ——
  上一个交接稿这里写"待提交的文件清单"，结果那份清单在推送后就过期了，
  反而误导人。**别再往这里抄文件清单**。
- 发新版（**先读 §0.5 的令牌规矩**）—— 下面是本轮实际用过的流程，留作下次照抄：

  ```bash
  npm run release -- check-msg .workbuddy/commit-msg.txt   # 先校验提交信息形状（不联网）
  npm run release -- push --message-file <提交信息文件> <要提交的文件...>
  npm run release -- release v<版本> --notes-file <Release说明文件>
  npm run release -- verify v<版本>       # 必须跑，确认附件 state 与下载直链
  ```

  注意 `push` 子命令**没有** `git add -A` 那种"全都提交"的用法 —— 文件必须一个个列出来。
  这是刻意的：本项目误提交过自检产物（见 §7.5）。

- 改完说明书**必须重出 PDF**（`npm run manual`），否则根目录那份会停在旧版本与旧页数。
  自检会核对 README 写的页数与 PDF 实际页数是否一致，不一致会直接报错。
- 交接前的整目录备份在 **`D:\Omite-backup-20260918-2325`**。
  出事了从那儿恢复。**做多文件改动之前先照 §0.4 再备份一次** ——
  并且按 §0.4 的规矩，**同时只保留最新那一份**（旧的确认无用后主动删掉）。

#### 第二批：说明书入口的真相与修法（1.1.6 已随本版一并处理）

用户报「README 里的说明书链接点开显示 `Unable to render code block`」。
**根因经核实后与最初的判断不同，这里写清楚，免得下一个人重新猜一遍：**

- **不是**"GitHub 不支持 PDF"（它支持，官方文档有 Rendering PDF documents）
- **不是**"文件太大超时"（1.02 MB 离 100 MB 上限差得远）
- **是**：README 里用的是 `[](使用说明.pdf)` 相对链接，在 GitHub 上会落到
  `blob/main/使用说明.pdf` —— **代码视图**。PDF 走这条路是**赌运气**：
  社区里该报错的头号成因是**浏览器扩展**（暗色模式 / 翻译 / 广告拦截 ——
  有人逐个关掉扩展才发现是暗色模式扩展），其次是代理与渲染器约 5 秒的超时。

**修法（本版已落地）**：把"在线查看"与"下载"分开，两条都不赌渲染器 ——

| 入口 | 指向 | 为什么不赌 |
| --- | --- | --- |
| **在线看图解说明书** | `docs/manual.html` | 纯 HTML、零 `<script>`、零外部依赖；GitHub 渲染文本/源码是稳的 |
| **下载 PDF 版** | `releases/latest/download/Omitone-manual.pdf` | 走**下载通道**，与渲染器完全无关；附件名纯 ASCII |

`使用说明.pdf` **仍然留在仓库根目录** —— 但它的角色从"在线入口"降为
"离线 / 转发"入口。README 顶部与文档地图都已按新角色改写。

**`check.js` 新增两条守卫（都做过反向验证，注入错误确认能抓住）：**

1. **双入口守卫** —— README 必须同时有 `docs/manual.html` 与
   `releases/latest/download/Omitone-manual.pdf` 两条链接，缺任一条即失败。
   为什么单列：若将来有人图省事删掉在线入口、只留 PDF，故障会**原样复发且不报错**。
2. **说明书源文件版本号守卫** —— `docs/manual.html` 里的
   `版本 x.y.z` / `Omitone-x.y.z` 必须等于当前版本。
   实测这一版修之前，源文件里同时躺着 `1.1.1`（三处）与 `1.1.5`（两处）——
   因为 `stamp()` 只盖**临时副本**，源文件不会被改回去。
   带历史措辞的引用（「1.1.0 专门修过」）**允许保留**，守卫会跳过。

**说明书重写（"担架级"教程）已在 1.1.6 完成** —— 12 处四问表 + 第 0 章五分钟快速装，
记录见下方 §8「说明书"信息很全但新手看不懂"」一行。这条 TODO 已闭环，别再当待办。
### 0.2.1 接手后请定期做的一件事：核对 AI 渠道

`docs/channels.md` 记着各家 AI 的 base_url、模型名与思考参数，**并标着最后核对日期**。
厂商改版很勤（本项目已经见过 `deepseek-chat` 退役、模型名换代），写死的快照一定会过期。

**每隔一两个月，或收到"某个渠道用不了"的反馈时**，按那份文件第 2 节的 curl 逐家打一遍，
把过期的模型名/参数改掉（改 `libs/thinking.js` 与 `popup/popup.js` 两处），并更新核对日期。
这件事**不是可选项** —— 它是"用户照着预置填完却发现用不了"的唯一防线。

### 0.2.2 `page.js` 拆分：**已完成**（按域切成 12 个片段）

**`page.js` 原本是一个 9899 行的巨石** —— 一个 IIFE 里的一个大对象字面量，330 个方法，
**没有按域排列**（每个域都横跨全文，例如"答题"类方法分布在 586–9860 行），
而且**全文没有任何分段注释**。改一个域要在近万行里翻找，这是当时最大的维护成本。

**现状：拆完了，行为不变。**

- 源码在 [`src/page/`](src/page/README.md) 下的 **12 个按域片段**里
  （`00-shell-constants` / `10-config-state` / `20-dom` / `30-log` / `40-media` / `50-captcha` /
  `60-tasks` / `65-discussion` / `70-quiz-flow` / `75-quiz-dom` / `80-popup-quiz` /
  `90-console-api-startup`，按文件名排序拼接）
- **根目录的 `page.js` 现在是构建产物** —— 扩展加载的仍是它，
  所以 `manifest.json` / `content.js` / `web_accessible_resources` / `build.js` 的 `INCLUDE` 一个都没动
- 新增 `npm run concat` / `npm run concat:check`；`npm run check` 会比对产物与片段，
  拦住"直接改根目录 page.js、下次拼接全丢"这种静默失效
- 验收：阶段一（按行切分）产物与拆分前**逐字节相同**（sha256 `fd20baa1…`）；
  阶段二（按域重组）**434 个属性名完全一致、app 体 8644 行有效行一行不多不少**，
  外加 `npm test` 与 `npm run e2e` 全绿

> ⚠️ **接手后改 `page.js` 相关代码，请改 `src/page/` 里的片段，然后跑 `npm run concat`。**
> 一句话地图（"我要改倍速 → `40-media.js`"）见 [`src/page/README.md`](src/page/README.md)。

**还没做的：继续细分。** `60-tasks.js`（2567 行）与 `70-quiz-flow.js`（2248 行）仍偏大，
各自还能再分（例如 tasks 里的「文档任务点」、quiz 里的「答案缓存」）。
**一次只搬一个子域、搬完立刻跑 `npm run e2e`** —— 不要一次搬完再测。

执行说明（自包含，可直接整份复制给另一个 AI）：

> 📄 [`docs/pagejs-拆分提示词.md`](docs/pagejs-拆分提示词.md)
>
> 里面写全了：现状勘明、两阶段方案、九条硬性约束、验收清单、
> 以及本仓库实测过的"假成功"陷阱。

**⚠️ 三条最容易踩的**：

- **e2e 从仓库根目录加载扩展**（不是 `dist/`）—— 所以根目录必须始终有一个可用的 `page.js`
- `tools/build.js` 用**白名单 `INCLUDE`** —— 新增源文件若需进包，必须登记
- `window.xxtAI` 是**给用户的手动调试入口**（`skipQuiz` / `diagnosePopup` / `taskGiveUpList` 等），
  **有些方法"看起来没人调用"，其实是被用户手动调的 —— 别当死代码删掉**

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
| **不要直接改根目录的 `page.js`** | 它现在是 `src/page/*.js` 的**拼接产物**（§0.2.2）。改它「立刻生效、下次拼接全丢」，`npm run check` 会报 `page.js 与 src/page/ 不一致`。改片段 + `npm run concat` |
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
- **同一时间只保留最近一份备份**（使用者 2026-09-18 明确要求）。
  新建备份成功之后，**主动删掉旧的**，别让 `D:\Omite-backup-*` 堆成一排 ——
  一份就够用，堆多了既占地方又让人分不清该从哪份恢复。

  ```powershell
  # 保留最新一份，删掉其余（先看清楚要删哪些，再执行）
  Get-ChildItem 'D:\' -Directory -Filter 'Omite-backup-*' |
    Sort-Object Name -Descending | Select-Object -Skip 1 |
    ForEach-Object { Write-Output ("将删除: " + $_.FullName); Remove-Item $_.FullName -Recurse -Force }
  ```

  ⚠️ 两条前提：① **新备份必须先确认成功再删旧的**（顺序反了就没有退路）；
  ② 删之前先 `Write-Output` 列出来看一眼 —— 本环境**回收站不可用**，
  `Remove-Item -Recurse -Force` 是**真·永久删除，不可恢复**。
  （**不要再在交接稿里写死备份目录名** —— 这一行曾经写成 `…-1755`，
  而磁盘上实际是 `…-1905`，等于给接手的人指了个不存在的目录。
  需要时直接用上面那条 PowerShell 列一下即可。）

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

- **推荐 `~/.omitone-release.ghtoken`** —— 用户主目录下的一个文件。
  刻意放在**仓库之外**：仓库内的文件哪怕 gitignore 挡住了，也随时可能被 `git add -f`、
  被别的工具打包、或被 AI 误读进上下文。放在主目录 + 收紧 ACL（只允许本账户读写）二者叠加，
  仓库怎么折腾都碰不到它。`tools/github-release.js` 的 `tokenPath()` 已按此路径读。
- 环境变量 `GITHUB_TOKEN` 仍然优先，但 ⚠️ 见 §7.9：
  **在接手者的机器上，让令牌经环境变量传入连续 3 次都是空值**，别在这上面浪费时间
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
| 任何东西 | `npm test` | **全绿**（自检 13 项 + 提示词基准 + 集成 77 项） |
| 答题链路 / 抠题 / 媒体 / 任务点调度 / `content.js` | `npm run e2e` | **全绿**（约 1~2 分钟，会起一个独立 Edge 临时 profile，不碰你正在用的浏览器）。**别在这里写死项数** —— 精确数字由 `npm run check` 对着 `.workbuddy/e2e-counts.json` 核，写死一份就会漂 |
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
| 当前版本 | **1.1.6**（功能收官，进入 bug 修复期） |
| 代码规模 | `page.js` 约 9.6k 行 / 320 多个方法；`content.js` 约 1.7k 行；`libs/` 合计约 3.8k 行 |
| 扩展体积 | 解压后约 **860 KB**（其中 `page.js` 420KB、`resources/table.bin` 122KB） |
| 测试基线 | 自检 13 项 · 集成 77 项 · 真实 Edge 端到端 **全绿**（项数见 `.workbuddy/e2e-counts.json`，由 `npm run check` 核） · 提示词基准 1 份报告 |
| 运行方式 | 加载解压缩目录；用户密钥存 `chrome.storage.local`，无任何自有服务器 |
| 用户是谁 | 两拨人：**不懂 GitHub 的同学**（只点 README 顶部那个下载链接）、**会写代码的接手者**。文档要分开写 |
| 许可 | GPL-3.0（上游作者意愿优先，见 README 末尾致谢与侵权处理） |

---

## 2. 文档分工（别写重复内容）

| 文件 | 负责什么 | 不要往这里写 |
| --- | --- | --- |
| **README.md** | 面向**用户**：怎么装、怎么用、已知缺陷、密钥安全、边界 | 内部实现细节 |
| **`使用说明.pdf`**（源 `docs/manual.html`） | 面向**完全不懂技术的使用者**：每一步都配**四问表**（看到什么 / 点哪里 / 怎样才算对 / 不对怎么办）、常见问题、日志英文对照。**按"从没用过 GitHub"来写**。配图**只用内联 SVG 示意图，不用真实截图**（截图会带用户的课程名/姓名/学号） | 开发相关内容（他们不看） |
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
npm run e2e                   # 约 1~2 分钟：起一个独立 Edge 临时 profile，逐功能交叉检验
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
（1.1.5 加的 `thinkingLevel` 与 `quizQuestionMaxMisses` 就是这么补的 ——
注意 `thinkingLevel` 只在 content.js 消费，`quizQuestionMaxMisses` 只在 page.js 消费，
所以不是每个配置项都要三处都加，但**读取它的那个文件必须有自己的默认值**。）

### 加 / 改一个 AI 渠道

按 `docs/channels.md` 第 3 节走：改 `libs/thinking.js`（思考参数）
+ `popup/popup.js` 的 `PROVIDER_PRESETS`（地址与模型名）+ 说明书 + README，
再更新那份文件的**最后核对日期**。改完必须跑 `npm test`（有渠道白名单断言）
与 `npm run e2e`（设置弹窗那一段会核对预设清单与"未实测"标签）。

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

- **版本号不用手工改**（PDF 那份）—— 脚本从 `manifest.json` 取当前版本盖进 PDF。
  （以前是手工同步，结果 1.1.1 发布时手册里还写着旧号）
  ⚠️ 但 `stamp()` **只盖临时副本，不写回源文件** ——
  所以 `docs/manual.html` 里那 5 处版本号要**自己手工同步**，
  否则 Pages 上那份网页会一直显示旧版本（这个坑 1.1.6 才被发现，源文件当时还写着 1.1.1）。
  `tools/check.js` 现在会核对源文件里的版本号，改了忘了会报错。
- 脚本会校验产物：**位图数必须是 0**（说明图都是矢量，缩放印刷不糊）、页数不能异常少
- **PDF 放仓库根目录，不放 `docs/`** —— 它是给"完全不懂 GitHub 的同学"看的，
  放 `docs/` 里他们找不到。README 顶部的下载入口直接指向它
- 改了手册内容**页数会变**，README 文档地图里写了页数（现在是 20 页）。
  ⚠️ **不用你手工记** —— `tools/check.js` 会拿 README 写的页数与 PDF 实际页数核对，
  不一致直接报错。（这个数字以前靠人记，漂移过两次：13→14、14→20）
- **改版时要守住「四问结构」**：每个动手处那张表必须有齐
  看到什么 / 点哪里 / **怎样才算对** / 不对怎么办 四行。
  这是这份说明书的核心价值 —— 读者卡住从来不是"不知道该装扩展"，
  而是"不知道自己看到的那一屏算不算对"。`check.js` 会逐张表检查，漏一行就报错。
- **不要往说明书里塞真实截图**。截图会带上课程名 / 姓名 / 学号，
  而这份文档是公开给所有人看的。示意图能说明"位置和含义"就够了
- **说明书封面必须留着两个下载直链**（下插件 `omitone.zip` / 下这份 PDF）。
  理由：说明书是会被**单独转发**的 —— 有人把 PDF 或在线链接发给同学，
  对方手里只有这一份，若正文里没有可点的链接，那句"打开项目首页"就是空话。
  `check.js` 会盯着这两条链接，删了报错（放哪儿不限，封面只是最显眼的位置）

---

## 6. 发版流程

1. `npm test` + `npm run e2e` 全绿（§0.6）
2. **同步版本号五处**（含 `package.json` 与 README 顶部的「版本」徽章）：`manifest.json`（`name` 与 `version`、`default_title`）、
   `popup/popup.html`（`<title>` 与 `.title`、`.ver`）、`content.js` 品牌位、`package.json`。
   漏一处 `check.js` 会直接报错。
   ⚠️ `docs/manual.html` 里那 5 处是**第六处，要手工同步** ——
   尽管 `npm run manual` 会产生带新版本的 PDF，但它只盖临时副本，
   **源文件里的版本号不会被写回**。`check.js` 会核对，漏了会报错。
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

   ⚠️ **提交信息只写一行主题**（≤30 字、不加 `chore:` 之类英文前缀、**不写正文**）。
   原因：GitHub 文件列表那一列的提交信息**悬停会弹出卡片显示整段正文**，长了很脏；
   而且列宽只放得下 30~40 字，超了就是一片"…"。详细规则与实测数字见 AGENTS.md §3 第 5 条。

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

工具都报成功，只有最后一个生效。**改同一文件多处必须串行**，每次改完回读确认落盘。

2026-09-18 又踩了一次，而且更隐蔽：**同一轮里连发多个 Edit，有的生效、有的没生效**
（报告全是成功）。当时改 `popup/popup.html` 的字号，回读发现 5 处仍是旧值。

**可靠做法：同一文件的多处小改，写成一次性 node 脚本做「读 → 串行 replace → 写回」，
一次性完成**，比连发 Edit 稳得多。改完必须回读核对 ——
把「本该消失的旧值」再搜一遍，计数应当是 0。

⚠️ 写脚本时注意换行符：**工作区是 CRLF、仓库里存 LF**
（`.editorconfig` 要求 `end_of_line = lf`，`core.autocrlf=true` 在检出时才转成 CRLF）。
脚本里拼的字符串若用 `\n`，会在同一个文件里混出两种换行符，
而且**后续所有用 `\n` 拼的 replace 都会匹配不上** —— 表现为「锚点怎么都找不到」。
要么统一拼 `\r\n`，要么改完把整个文件归一化一遍（本项目是 CRLF 工作区）。

⚠️ 还有一层：**别用 heredoc 写含中文与反引号的脚本**（`cat > x.js << EOF`）。
bash 会把反引号当命令替换去执行，中文引号也会被吞掉 —— 生成出来的脚本必然是坏的。
用编辑工具直接写文件，不要绕 shell。

⚠️ 大小写一个坑：`statSync().size` 是**字节数**，`String.length` 是**字符数**。
本仓库中文注释极多，UTF-8 下一个汉字 3 字节，两者能差出 20%。
核对「文件是不是被截断了」必须用同一个口径比较，否则会误判成丢内容。

### 7.4 提示词压得太短反而更贵

DeepSeek 靠"请求前缀完整匹配已持久化的缓存单元"命中。把提示词压到极短会让
**跨请求的公共前缀短到无法被识别成缓存单元** → 命中率恒为 0 → 全部输入按原价计费。
用户看到的是账单翻十倍，而代码"看起来更省了"。

所以 `libs/prompt.js` 现在固定成「稳定头 → 题目块 → 易变尾」三段，
`tools/prompt-bench.js` 有专门的指标守着这条。**别再把 `禁:` 之类的易变内容插回题目中间。**

另外，**也别为了「凑缓存长度」去加长稳定前缀**。实测（DS V4 Flash）：当前稳定前缀
system 70 + 消息头 14 = **84 token**（**当时**的值；后来加了多选说明
变成 78，以 `npm run bench` 为准），现场命中率**仍然是 0**。加长到 256 的账是：
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

⚠️ **2026-09-18 实测：上面这条"直连更快"的结论已经不成立了，别照抄。**
本轮遇到的情形恰好相反：

| 通道 | 本轮实测 |
| --- | --- |
| Node 内置 `fetch` **直连** api.github.com | ❌ `Connect Timeout`（10s） |
| 显式走代理（`127.0.0.1:23478` CONNECT） | ❌ TLS 握手前断开 |
| TCP 层探测（代理端口 / api.github.com:443） | ✅ 都能连 |
| `fetch` 后再试 | ❌ `getaddrinfo ENOENT`（DNS 瞬时失败，3ms 返回） |
| **再过一会儿重试** | **✅ 成功**（提交与发布一次跑通） |

**结论：这是"间歇性、会自愈"的网络抖动，不是配置问题。**
遇到 `fetch failed` / `Connect Timeout` / `getaddrinfo ENOENT` 时：

1. **先确认提交到底成没成**（§7.7 的规矩：输出里出现过 `main → <sha>` 就是成了）
2. 没成的话，**等一下再试**，别去改代码、别去动代理配置
3. 这台机器的 `http_proxy` / `https_proxy` 都指着 `127.0.0.1:23478`（梯子客户端开的），
   而 **Node 内置 `fetch` 默认不读这两个变量** —— 所以脚本走的是直连

不要去 `git push` 试（§7.3：它会永久挂起）。走 `npm run release -- push`。

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

### 7.9 令牌经**环境变量**传入在本机不可靠 —— 请走文件

实测（2026-09-18，本轮接手）：让使用者把令牌经对话传入环境变量，
**连续 3 次拿到的都是空值** —— `GITHUB_TOKEN` / `GH_TOKEN` / `PAT` 全是 `0` 长度。
而同一时刻**把令牌写进文件**立刻可用（93 字符，`GET /user` 返回 200）。

所以：

- **别在"环境变量为什么是空的"上浪费时间** —— 这是本机环境的特性，不是你的操作错了
- 直接让使用者把令牌写进 `~/.omitone-release.ghtoken`（见 §0.5）
- 顺手量一下长度：细粒度 PAT 是 **93 字符 / 3 个下划线**。
  ⚠️ 但**不要一上来就说"你给的令牌不完整"** —— 对话记录里显示的令牌会被截断到约 30 字符，
  那只是**显示**截断，实际传进来的往往是完整的。先量长度、再看 401 与否，再下结论。

---

## 8. 已经修过、别再"修"一遍

这一节是为了防止"好心重做一遍"——修 A 的时候顺手把已修好的 B 又改坏，是本项目真实发生过的事。
遇到下面这些现象，先确认是不是已经被处理过。

| 现象 | 状态 |
| --- | --- |
| 视频弹题"一直问模型却填不进去"、课程原地空转 | **1.0.12 已修**：补了通用结构识别（原生 `li + input`）、同题最多问 3 次、失败后 60 秒冷却并留 DOM 快照 |
| 只发部分题时答案 index 错位回填 | **已修**，`npm run itest` 守着这条（人工测试覆盖不到，必须靠集成测试） |
| 提示词输入几乎全未命中缓存、账单偏高 | **1.1.1 已修**：提示词重排为「稳定头 → 题目块 → 易变尾」+ 重试整批重发（见 §7.4） |
| 扩展解压后 963 KB 太臃肿 | **1.1.1 已修**：映射表改紧凑二进制 `table.bin`（347→122 KB），**1.1.1 当时**降到 751 KB（此后 `page.js` 随功能增长，1.1.4 时约 784 KB）|
| 弹窗里一堆服务商预设都不能用 | **1.1.0 已修**：删掉 6 家未实测的预设，只留 DeepSeek / Claude / Gemini / 自定义 |
| README 里同一份「已知缺陷」写了两遍且互相冲突 | **1.1.1 已合并**为一节 |
| 说明书版本号滞后、藏在 `docs/` 里找不到 | **1.1.2 已修**：搬到仓库根目录 + `npm run manual` 自动盖版本号 |
| 不懂 GitHub 的人装不上 | **1.1.2 已修**：README 顶部直链下载 + 「三步装好」 |
| 发布附件改名导致下载直链失效 | **1.1.2 已加固**：附件名在 `tools/github-release.js` 里写死，`check.js` 有守卫 |
| issue 模板里写着过期版本号 | **1.1.2 已修**：改成不写死版本，从扩展卡片上抄 |
| 想把发布附件改成中文名（`使用说明.pdf`） | **别改**。实测上传非 ASCII 名时 GitHub 返回 **201 成功**，但落在 Release 上会**静默变成 `default.pdf`** —— 又一个"接口说成功、结果不对"的坑。所以仓库里的文件照旧叫 `使用说明.pdf`（面向用户），**上传时用 ASCII 名 `Omitone-manual.pdf`**（`tools/github-release.js` 的 `ASSETS` 里写死）。README 链接的是**仓库文件**而不是 Release 附件，所以不受影响 |
| 弹题**答错后每轮仍选同一个答案** | **1.1.3 已修**：接上了 `previousWrongAnswers`（提示词里渲染成「禁:1=D;」）。弹题这条路原先从来没传过，于是每轮重试都是逐字节相同的请求 |
| 弹题**答对之后选项一直闪** | **1.1.3 已修**：填完答案后有静默期，站点重绘导致指纹变化也不重问。**别把静默期缩短** —— 缩了就会退回"重问→重填→重绘"死循环 |
| 弹题**答错之后卡住**、等几秒也没后续 | **1.1.4 已修**，两个成因：①「已答放行」窗口写死 30 秒，比 8 秒静默期长 **22 秒**，那段时间 `_activePopupBlock()` 一直返回 null、**弹窗没人管也没人重试**；② `_handleVideoPause` 用同一个函数判断"有没有弹窗"，于是还会去抢恢复**被站点有意暂停**的视频。现在两个窗口共用 `POPUP_QUIZ_QUIET_MS`，恢复播放改用 `_popupQuizBlocksPlayback()`（静默期也算挡着）。⚠️ **别让这两个窗口时长不一致，也别把恢复播放的守卫改回 `_activePopupBlock()`** —— e2e 有 3 条断言锁着 |
| 防拖拽视频白等最后 10% | **已做**：`advanceAtNinetyPercent`（默认开）。判据是「拖不动 **且** 倍速锁 1x」，**并且必须由平台自己给出完成标记**才提前结束。别把它改成「播够 90% 就算完成」—— 那会在平台还没认可时误跳过任务点 |
| 三份「managed media job ended」收尾各写一遍 | **已统一**（1.1.3，**1.1.4 复核确认正确**）：`_handleVideoEnded` 现在走 `_finishCurrentMedia`。它原本多清 `_activeDocumentJob*`，**那三行是过界的**（`nextUnit()` 在 `autoNext:false` 时提前返回，会放弃正在进行的文档任务点）。别再把它加回去，e2e 有断言锁着 |
| 设置弹窗"太潦草"（主操作在底部、控件一长条） | **1.1.4 已重做**：吸顶主操作 + `<details>` 分组折叠 + 蓝色强调。改版前的结构问题见 CHANGELOG 1.1.4。⚠️ 每个开关的 `role="switch"` / `tabindex="0"` / `aria-checked` 与 `<label for>` 都不能少，e2e 有断言 |
| **多选题只选一个、然后卡住**（章节小测不往下走、视频弹题反复选不对） | **1.1.5 已修**，四个成因见 README §6 #33。要点：① 选项填充原来有**三份**（章节小测 / 弹题各一份 + 各自的小工具），已合并为唯一入口 `_applyChoiceAnswer`；② `_sortMultiFallbackCombos` 的目标规模**下限必须≥2** —— 改回 `preferredSize \|\| 2` 会让"只选一项"的组合排到最前，重试就变成逐个字母试错；③ 低于下限的组合**只排最后、不删除**（"不定项选择题"单选也是正确答案，删了就永远答不对）；④ `_clickOptionItem` 顺序是"**先点、再写回终态**"，复选只加不减 —— 别改成"按当前状态取反"（复选被点两次会互相抵消，就是"随机少选"的来源）。e2e 新增一个场景（15 条断言）锁着 |
| 换了个模型就一直 **400** | **1.1.5 已加固**：思考参数收进 `libs/thinking.js` 按渠道白名单发；服务商拒收时自动摘掉参数重试一次。⚠️ **别把 `unknown` 渠道的"关闭"档改成会发参数** —— 那正是升级前的行为，改了就会把用自定义渠道的用户搞成 400 |
| 「只有 DeepSeek 实测过」这句话 | **1.1.5 起仍然成立**，只是预置里多了 Kimi / 通义（界面明确标"未实测"）。**不要把"未实测"的标签去掉**，e2e 有断言守着标签文字 —— 那是用户判断"能不能信"的唯一依据 |
| 说明书"信息很全但新手看不懂" | **1.1.6 已重写成「担架级」**：12 处四问表（看到什么 / 点哪里 / **怎样才算对** / 不对怎么办）+ 第 0 章五分钟快速装 + 第 7.1 节日志英文对照。⚠️ **别把四问表压成一段文字** —— 这份说明书的全部价值就在"怎样才算对"那一行：读者卡住从来不是不知道该装扩展，而是**不知道自己看到的那一屏算不算对**。`check.js` 会逐张表核对，漏一行就报错。<br>⚠️ **也别往里加真实截图** —— 截图带课程名/姓名/学号，而这份文档是公开的。全部用内联 SVG 示意图（这也是 PDF 位图数必须为 0 的原因） |
| 调用 LLM 返回 **401/403 后，插件仍每 45 秒卡一下**（Key 填错了看起来像网络抽风） | **发版后已修**（`8ce8dae` 认状态码 + `0f345a2` 页面侧分流）：4xx 标 `permanentError`，跳过本轮 60 秒（`PERMANENT_LLM_ERROR_SKIP_MS`）、把服务商原话留在 `_quizApiLastError`、**不进 45 秒退避**；视频弹题同源走 `_giveUpPopupQuiz`。⚠️ **别把 4xx 分支并回普通失败处理** —— e2e 有「401 不退避」与「500 仍退避」的**对照**场景，少了对照，"凡是失败都不退避"也能蒙混过关 |
| 作业/考试页（`.Cy_*` 结构）**点了选项却不生效**、日志照样 `clicked option` | **发版后已修**（`c9cfb7b`）：那套结构里选项**文本**在 `.Cy_ulTop`、**可点 input** 在 `.Cy_ulBottom`，是两个分开的 ul；`_getOptionItems` 抢先命中文本列 → `querySelector('input')` 恒 null → 空点。改法是 `_pairOptionControls` 按索引把控件挂到文本节点上。⚠️ 别改回"拿文本节点找 input"，e2e 有场景锁着 |
| 作业/考试页**隐藏域 `#answer{qid}` 一直是空串**、提交后**无限重扫重答重交** | **发版后已修**（`1742b9f`，两个洞）：① `_clickOptionItem` 写隐藏域原来要 `qid && badge` **同时**成立，而真实作业页 li 上**两样都没有**（qid 在容器 `.Cy_TItle[qid]`、无 `.num_option` 徽标）—— 现为 qid 三级回退（li → `closest('[qid]')` → `_getQuestionIdFromElement`）+ 写隐藏域与徽标操作拆开 + **判断题以控件 `value`（true/false）为权威**，不是字母；② 完成判定只认章节页标记，对**判分结果页**（`.Py_answer` 一族 + 控件全 disabled）是瞎的 —— 新增 `_isQuizResultPageFinished`（三判据同立才算完成，**宁漏判不误判**）。⚠️ 别把写隐藏域的条件改回 `qid && badge` 同立。e2e 两个场景（8+9 条断言）锁着，含「旧判据对判分页确实认不出来」的守卫 |

---

## 9. 当前已知未解决 / 建议下一步

| 项 | 说明 | 建议 |
| --- | --- | --- |
| **本轮修复还没在真实平台验证过** | 「作业页回填隐藏域」「提交后认判分结果页」两个修复只过了 mock e2e（280 项全绿 + 反向验证），真实学习通作业/考试页**用户尚未回归实测** | 等用户跑一次真实作业页。若仍有异常，先按 README §7 调试手册新增的两行（`#answer{qid}` 空串 / 停在 `waiting quiz submit result`）定位，别直接改代码 |
| **`configs` 没有 schema 校验** | 三份默认值服务的目的不同（page 全部开关 / popup 界面上的 / content 兜底），**本就不该一样**。真正会出事的「读了却没默认值」已由自检第 12 项守住，一上线就抓出 2 个 | 剩下只是「没有类型/范围校验」，收益不高，**暂不做** |
| **`page.js` 体量（420KB / 9570 行）** | 它是主体但也是唯一的巨石；分割收益大、风险更高 | **先补测试再动**，按"预览 / 答题 / 媒体 / 调度"切 |
| **密钥只在 `chrome.storage.local`** | 已经足够安全（无自有服务器），但没有加密 | 不必改；文档里已给出可自验方法 |

---

## 10. 最后三句

1. **先读 `AGENTS.md`** —— 硬性约束在那里（跨域 iframe 不许裸读 `.document`、新增 `await`
   必须可超时、删方法前 grep 全部调用点），违反会**静默**打死主循环。
2. **别通读 `page.js`** —— 9899 行里绝大多数与你的任务无关。它已经是 `src/page/` 下 12 个
   按域片段的拼接产物（§0.2.2），先看 [`src/page/README.md`](src/page/README.md) 的模块地图
   直接跳到对应文件，再用本文 §3 的索引 + 搜索定位，读文件时只读目标函数附近。
3. **先跑测试建立基线，改完再跑一遍，全绿才提交** —— 这比通读代码更能发现回归。
   新增断言一定要做反向验证：**不会失败的检查等于没有检查。**
