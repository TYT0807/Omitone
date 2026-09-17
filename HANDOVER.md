# HANDOVER.md — 接手这份代码要看的唯一一页

写给**下一个接手的人，以及帮人干活的 AI**。

> ⚠️ 本文**故意不写技术细节**。技术细节的唯一真源是 [README.md](README.md) 与
> [ARCHITECTURE.md](ARCHITECTURE.md)。这里只讲：**当前状态、文档分工、按症状找文件的索引、
> 常见任务的固定动作、以及那些"不看就会踩"的地雷**。重复写一遍细节，只会多出一份会过期的副本。

---

## 1. 三十秒速览

| | |
| --- | --- |
| 项目 | 学习通（超星）网页版学习辅助浏览器扩展，Manifest V3，零依赖、无构建步骤、无后端 |
| 当前版本 | **1.1.1**（功能收官，进入 bug 修复期） |
| 代码规模 | `page.js` 约 8.4k 行 / 300 个方法；`content.js` 约 1.4k 行；`libs/` 合计约 1.2k 行 |
| 扩展体积 | 解压后约 **751 KB**（其中 `page.js` 350KB、`resources/table.bin` 122KB） |
| 测试基线 | 自检 10 项 · 集成 52 项 · 真实 Edge 端到端 **162 项** · 提示词基准 1 份报告，**全绿** |
| 运行方式 | 加载解压缩目录；用户密钥存 `chrome.storage.local`，无任何自有服务器 |
| 许可 | GPL-3.0（上游作者意愿优先，见 README 末尾致谢与侵权处理） |

---

## 2. 文档分工（别写重复内容）

| 文件 | 负责什么 | 不要往这里写 |
| --- | --- | --- |
| **README.md** | 面向**用户**：怎么装、怎么用、已知缺陷、密钥安全、边界 | 内部实现细节 |
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
| 抠题（题干 / 选项 / 题型） | `page.js` | `_extractQuestions` / `_collectQuestionContainers` / `_getOptionItems` |
| 答题回填与交卷 | `page.js` | `_handleQuiz` / `_fillAnswers` / `_areQuizAnswersFilled` / `_maybeSubmitQuiz` |
| 视频内弹题、播放器右下角「继续学习」 | `page.js` | `_activePopupBlock` / `_handlePopupQuiz` / `_tryContinueStudyPrompt` |
| 提示词（**唯一真源**） | `libs/prompt.js` | `buildUserPrompt` / `normalizeItem` |
| API 地址与密钥清洗（**唯一真源**） | `libs/api-url.js` | `buildOpenAICompatibleUrl` 等 |
| 字形哈希表格式（**唯一真源**） | `libs/font-table.js` | `encode` / `decode` / `fromObject` |
| 字体反爬解密流程 | `content.js` | `getDecryptTable` / `buildDecryptMapForDoc` |
| 跨域请求代理、抓图转 dataURL | `background.js` | `apiFetch` |
| 设置界面 | `popup/popup.html` + `popup/popup.js` | `PROVIDER_PRESETS` / `applyProviderPreset` |
| 打包与发版 | `tools/build.js` / `tools/table-pack.js` | `INCLUDE` / `EXCLUDE` |
| 自检与测试 | `tools/check.js` · `integration-test.js` · `browser-e2e.js` · `prompt-bench.js` | 见 tools/README.md |

---

## 4. 上手三步

```bash
git clone <repo> && cd Omitone
node tools/check.js          # 秒级：语法 / manifest / 版本一致性 / 幽灵调用 / 死方法 / 唯一真源 / 映射表同步
node tools/integration-test.js   # 秒级：真实 content.js + libs，打桩 chrome.*
node tools/browser-e2e.js    # 约 1~2 分钟：起一个独立 Edge 临时 profile，162 项交叉检验
```

`npm test` = 自检 + 基准 + 集成；`npm run e2e` = 上面第三条。
**改完必须两边都跑**（见 AGENTS.md §3）。

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
node tools/prompt-bench.js
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

---

## 6. 发版流程

1. `node tools/check.js && node tools/integration-test.js && node tools/browser-e2e.js` 全绿
2. **同步版本号四处**：`manifest.json`（`name` 与 `version`、`default_title`）、
   `popup/popup.html`（`<title>` 与 `.title`、`.ver`）、`content.js` 品牌位、`package.json`。
   漏一处 `check.js` 会直接报错
3. 写 `CHANGELOG.md`（写**为什么**，不只写做了什么）
4. `node tools/build.js` → `dist/omitone-<version>/` 与 `.zip`（`dist/` 不入版本库）
5. `git push` + 打 tag + 建 Release，Release 说明单独写：讲清**这一版修了什么、怎么升级、有什么取舍**
6. **旧版本的 Release 一律保留**，方便回退

`tools/publish-audit.js` 是发布前审查（扫密钥 / 本机路径 / 邮箱 / 大文件是否误入公开仓库）。

---

## 7. 环境地雷（真踩过，代价很高）

### 7.1 不要用 `git stash`

在本项目的工作环境里执行过一次 `git stash push`，结果 `D:\Omite\.git` **整个目录消失**，
stash 对象自身也报 `is not a valid object` —— 历史、分支、stash 全没了。
需要对比基线时用 `git diff` / 复制目录。**多发改动前先提交或整目录备份（`robocopy`）。**

### 7.2 换 shell 会让 e2e 全线失败 —— 但错不在扩展

扩展 ID 的算法是 `SHA256(目录绝对路径, UTF-16LE)`，**路径大小写敏感**。
从 Git Bash / WSL 风格 cwd（`/d/Omite`）启动 node，盘符变小写 → ID 错开 →
14 个场景全报"page.js 加载失败"而页面里没有任何异常。
**看到 e2e 全线失败，先看输出的「扩展 ID:」那一行。** 详见 AGENTS.md §7.2。

### 7.3 并行编辑同一个文件会互相覆盖

工具都报成功，只有最后一个生效。**改同一文件多处必须串行**，每次改完 grep 回读确认落盘。

### 7.4 提示词压得太短反而更贵（本轮新增的地雷）

DeepSeek 靠"请求前缀完整匹配已持久化的缓存单元"命中。把提示词压到极短会让
**跨请求的公共前缀短到无法被识别成缓存单元** → 命中率恒为 0 → 全部输入按原价计费。
所以 `libs/prompt.js` 现在固定成「稳定头 → 题目块 → 易变尾」三段，
`tools/prompt-bench.js` 有专门的指标守着这条。**别再把 `禁:` 之类的易变内容插回题目中间。**

### 7.5 清理临时产物

临时文件放 `.workbuddy/`（已 gitignore）。**`git add -A` 之前先看 `git status`** ——
本项目发生过把自检输出（`.c1.txt` 之流）一起提交并推上 GitHub 的事故（commit `00202a6` 修的）。

---

## 8. 当前已知未解决 / 建议下一步

| 项 | 说明 | 建议 |
| --- | --- | --- |
| **README 有两节同名的「已知缺陷与重要限制」** | 一节约在 68 行、一节约在 167 行，内容高度重叠，有长期漂移风险 | 合并成一节，把另一处改成链接 |
| **`configs` 三份默认值无 schema 校验** | `content.js` / `page.js` / `popup.js` 各一份，靠人手工对齐 | 抽成 `libs/config-defaults.js` 单一真源 |
| **`page.js` 体量（350KB / 8.4k 行）** | 它是主体但也是唯一的巨石；分割收益大、风险更高 | 先补测试再动，按"预览 / 答题 / 媒体 / 调度"切 |
| **密钥只在 `chrome.storage.local`** | 已经足够安全（无自有服务器），但没有加密 | 不必改；文档里已给出可自验方法 |
| **验证码识别依赖视觉模型** | 留空会回退主模型并大概率失败 | 在弹窗里加一句更明确的提示 |
| **图标 128px 占 28.6KB** | 偏大，可无损重压到 ~10KB | 低优先级 |
| **不支持连线 / 排序 / 拖拽题** | 平台交互题无法自动作答 | 保持现状，明确写在 README |

---

## 9. 给接手 AI 的三句话

1. **先读 `AGENTS.md`** —— 里面有硬性约束（跨域 iframe 不许裸读 `.document`、新增 `await`
   必须可超时、删方法前 grep 全部调用点），违反会静默打死主循环。
2. **别通读 `page.js`** —— 8.4k 行里绝大多数与你的任务无关。用本文第 3 节的索引 +
   `grep -n` 定位，`Read` 只读目标函数附近。
3. **先跑一遍测试建立基线，改完再跑一遍** —— 比通读代码更能发现回归。测试全绿才提交。
