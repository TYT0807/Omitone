# AGENTS.md — 给 AI 的守则

**技术细节不在这份文件里** —— 全部集中在 [`README.md`](README.md)，那里是唯一真源。
这份文件只规定"怎么做事"，避免两份文档内容分叉。

---

## 0. 它会告诉你"别通读代码"

`page.js` 约 7600 行 / 290 个方法。通读一遍是巨大的浪费，而且读到的绝大多数内容与你的任务无关。

正确顺序：

1. 读 [`README.md`](README.md) 的**第一屏**（「给接手的人 / AI：先看这里」）
2. 按任务类型跳到 README 的对应章节 —— 尤其
   **§5 代码易纠缠点** 与 **§6 易错点清单**
3. 用 README **§8 的定位表** 找到文件，再 `grep -n "关键字" 文件` 缩小范围
4. `Read` 时用 `offset` + `limit` **只读目标函数附近**（定义行号从 `grep` 拿）
5. 先跑 `npm test` 建立基线，改完再跑一次 —— 比通读代码更能发现回归

提示词相关改动**不要**读 `page.js` —— 提示词只在 `libs/prompt.js`。

---

## 1. 动手前

```bash
npm test          # 自检 + 提示词基准 + 集成测试（52 项），必须全绿
```

改动可能影响真实浏览器行为时（答题链路、抠题、媒体、任务点调度）**先跑一次基线**：

```bash
npm run e2e       # 真实 Edge 功能交叉检验（19 个场景 / 185 项）
```

不要复用用户正在使用的浏览器实例。`npm run e2e` 自己会起一个独立临时 profile 并自动收尾。

---

## 2. 改代码时的硬性约束

这几条违反会出事，展开说明见 README §5 / §6：

1. **跨域 iframe 永远不要裸读 `.document`** —— 走 `_safeDocOf()` / `_safeWinDoc()`。
   裸读抛出的 `SecurityError` 会静默打断整个 tick 循环，是**最难查的一类 bug**。
   （README §6 #2）
2. **新增 `await` 必须可超时** —— 任何永久悬挂都会让主循环死亡。
3. **删方法前 grep 全部调用点** —— 本项目真的发生过"删了函数留着调用点"，
   4 处调用点里 3 处没有 try/catch，整条功能静默失灵。（README §6 #9）
4. **提示词与 API 地址构造都不许内联** —— 唯一真源是 `libs/prompt.js` 与 `libs/api-url.js`。
5. **`_getAttachmentWorkType` 的判断顺序不能动** ——
   `isPassed` → `job:true` → `job:false` → 模块名推断。（README §5.7）
6. **`_isJobCompleted` 拿不准时必须返回 `true`** —— 它喂给"放弃"计数，
   误判成"没完成"会把必做任务点跳过。（README §5.8）
7. **跳过用户的任务点必须留日志 + 可恢复** —— 静默永久跳过是不可接受的。
8. **改 `_runTick` 的判定顺序 = 高风险操作** —— 那顺序就是仲裁顺序。（README §5.1）

---

## 3. 改完的固定动作

1. `npm test` 全绿；动了答题链路 / 抠题 / 媒体 / 任务点调度再跑 `npm run e2e`
2. **同步版本号三处** —— `manifest.json`、`popup/popup.html`、`content.js` 状态面板品牌位。
   漏一处 `npm run check` 直接报错；这是本项目历史上最常犯的错
3. `edge://extensions` 重新加载 + **刷新学习通页面（F5）**。
   只重载扩展不刷新页面，旧 content script 与扩展断连，症状是"功能全停、日志不动"
4. `git diff` 通读一遍 —— **本项目有过外部编辑器用旧快照覆盖文件的历史**，
   而且**并行编辑同一个文件会互相覆盖**（工具都报成功，只有最后一个生效）。
   改同一文件的多个位置必须**串行**，每次改完 grep 回读确认落盘

---

## 4. 验证清单

- [ ] `npm test` 全绿
- [ ] 动了真实浏览器行为 → `npm run e2e` 全绿
- [ ] 版本号三处已同步（`npm run check` 会替你确认）
- [ ] 改动涉及的页面路径手动跑过（视频 / 答题 / 验证码 / 讨论）
- [ ] **新增的断言做过反向验证**：临时制造一个已知错误，确认它能被抓住。
      不会失败的检查等于没有检查
- [ ] 没有留下临时文件、探测脚本、调试 `console.log` 洪水

只改提示词：至少跑 `npm run bench` 确认 token 没反弹、题干选项没被压掉。
改了 `content.js` 答题链路：必须跑 `npm run itest` —— 分批 index 回填这个 bug
只在"只发部分题"的场景暴露，人工测试覆盖不到。

---

## 5. 加测试时的自问

- 这个断言**失败时会不会误报**？（先临时塞一个已知错误验证它能抓到）
- 断言的是**行为**还是**实现细节**？断言实现细节会把你绑死，
  也会因为你自己理解错了而失败（这坑真踩过：`_findMediaInDocument` 返回单个元素而非数组）
- 失败信息**够不够定位**？宁可多花几行输出细节，也不要只给一个 `false`
- 端到端发现的问题，**回归测试尽量下沉到集成层**（快、稳、无外部依赖）

---

## 6. 关于 `legacy/`

`legacy/background-core.js` 是**死代码**，不加载，也不要接回去
（原因见 `legacy/README.md`：缺 `alarms` 权限 + 会造出第三份提示词分叉）。
打包脚本会排除整个 `legacy/`。

---

## 7. 环境地雷（本仓库真实踩过，代价很高）

### 7.1 **不要用 `git stash`**

在这个工作环境里执行过一次 `git stash push`，结果是
`D:\Omite\.git` **整个目录消失**、stash 对象自身也报 `is not a valid object` ——
历史、分支、stash 全没了，只剩工作区源码。

- 需要对比基线时：用 `git diff` 读，或用 `git worktree` / 复制目录，不要用 stash
- 任何多发改动前先把当前状态**提交**或**整目录备份**（`robocopy` 一份），再动手
- 恢复手段只有：`git init` + 重新提交当前快照；**因此"勤提交"是唯一兜底**

### 7.2 换 shell 会让 `npm run e2e` 全线失败 —— 但错不在扩展

打包扩展 ID 的算法是 `SHA256(目录绝对路径, UTF-16LE)`，**路径大小写敏感**：

| 路径 | 算出的 ID |
| --- | --- |
| `D:\Omite` | `hdlemlcmf…`（真实） |
| `d:\Omite` | `locncobd…`（错） |

从 Git Bash / WSL 风格的 cwd（`/d/Omite`）启动 node，`__dirname` 的盘符会变成小写，
哈希整个错开。症状是 **所有场景都报「page.js 在真实 Edge 中加载成功：失败」、
页面里却一条异常都没有** —— 极具误导性，很容易误判成"扩展坏了"或"代码有回归"。

判断方法：跑 `npm run e2e`，看输出的 `扩展 ID:` 一行。
若它后面跟着「⚠️ 路径哈希给出的是 …」，说明测试脚本已经自动纠正过来了
（`discoverExtensionId` 会优先用运行时发现的真实 ID，路径哈希降级为兜底）。

**所以：看到 e2e 全线失败，先看这一行，再去怀疑代码。**

### 7.3 **`git push` 会永久挂起 —— 发版请走 REST API**

这台机器上 `git push origin main` **能连上却永远不返回**（实测挂满 5 分半仍在运行），
而同一条网络下：

| 操作 | 结果 |
| --- | --- |
| `git push origin main` | 挂起，不返回、不报错 |
| `git fetch origin main` | 几秒完成 ✅ |
| `GET https://api.github.com/rate_limit` | 约 1 秒 200 ✅ |
| `POST https://uploads.github.com/.../assets` | 正常 ✅ |

也就是 **push 通道单独不通**，不是梯子整体问题。所以：

- **提交走 REST API**：`GET /git/ref/heads/main` 拿 sha →
  `POST /git/blobs`（`encoding: 'utf-8'`）→ `POST /git/trees`（**必须带 `base_tree`**，否则整棵树被替换）→
  `POST /git/commits`（**必须带 `parents`**）→ `PATCH /git/refs/heads/main`（**必须带 `force: true`**，
  否则 `422 Update is not a fast forward`）
- **打完 tag 才知道 tag 该指向哪个 sha**：API 提交会被 GitHub 重新签名，
  远端 sha 必然 ≠ 本地 sha。要先提交、再看远端 sha、最后建 tag，
  顺序反了就会撞上 `422 Object does not exist`
- **本地对齐**：`git fetch origin main` + `git reset --hard <远端sha>`，**不要 push**
- **这整条链路已经脚本化了**：`tools/github-release.js`（`npm run release -- <子命令>`）
  - `push --message-file <文件> <文件...>` —— 提交改动到 main，并自动 fetch + reset 对齐本地
  - `release <tag> --notes-file <文件>` —— 打 tag + 建 Release + 传两个附件
  - `verify <tag>` —— **发完必须跑**，它会确认 tag 指向、附件 state、以及 README 那条下载直链是否可用
  - 令牌：环境变量 `GITHUB_TOKEN`，或 `.workbuddy/.ghtoken`

### 7.4 令牌要等整件事做完再删

本仓库栽过一次：tag 推上去了、main 推上去了，**唯独 Release 和附件没发出去** ——
因为清理时提前把 `.ghtoken` 删了。**顺序是"发版 → 核验远端 → 再删令牌"。**
（令牌本身按用户偏好应当是**一次性、最短有效期**，用完提醒他去 revoke。）

### 7.5 **发布附件名固定为 `omitone.zip`，不要改**

README 顶部的下载入口用的是 GitHub 的永久链接：

```
https://github.com/TYT0807/Omitone/releases/latest/download/omitone.zip
```

它按**附件名**去取"最新一版 Release"里的同名附件。所以：

- 附件名一旦带上版本号（`omitone-1.1.2.zip`），每发一版这条链接就失效一次
- 失效的表现是 **新用户点下载看到 404** —— 不报错、不留日志，
  而且**恰好是"不会用 GitHub、只会点这一个链接"的那批用户**受影响，他们不会来反馈
- `build.js` 的产物仍叫 `dist/omitone-<版本>.zip`（本地看版本方便），
  **上传时改名**即可 —— `tools/github-release.js` 已经把名字写死，不给人改错的机会

配套守卫：`tools/check.js` 的「用户入口守卫」会检查 README 里这条直链不许带版本号、
根目录必须有 `使用说明.pdf`、且 README 里所有相对链接都指向真实存在的文件。


