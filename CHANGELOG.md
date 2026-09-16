# 变更记录

版本号三处同步规则见 [`AGENTS.md#24-改完必须同步版本号三处`](AGENTS.md)。
1.0.2 之前的记录未留存。

---

## 1.0.11 — 提示词收敛与工程化

**逻辑审计：修掉三处判断错误（其中两处是本次新引入的）**

对"任务点该不该做 / 做不完要不要放弃"这条链路做了完整复查：

- **`isPassed` 排在 `job` 之后 → 已通过的任务点被重做一遍**。
  两者同时为真时先判 `job` 就返回 `'job'`，调用点看到 `'job'` 直接开跑。
  长视频尤其致命（等于白播一整遍）。现在 `isPassed` 优先返回 `'finished'`，
  而"重学模式"本来就会把 `'finished'` 也当作要重做。
- **"没完成"就计数 → 必做任务点会被误跳过**。这是上一轮引入的判断错误：
  长视频一次本来就跑不完，`_isJobCompleted` 会一直返回 false，
  连续几次就会被记入放弃名单。现在改为**只有"两次进度快照完全一致"才认定卡住**，
  并新增 `_taskProgressSnapshot`。
- **不可滚动的页面快照恒为 `scroll:0`** —— 把"测不到"误当成"没进展"。
  现在只有**确实可滚动**（`scrollHeight - clientHeight > 20`）的文档才用 `scrollTop` 当进度，
  否则返回空串，调用方一律不计。
- **讨论任务打不开也先把"已完成"标记写死了**。`_markDiscussionDone` 先于打开动作写入
  （为防止重复打开），但若一个入口都没打开成功，该任务点会被静默跳过 24 小时、
  日志里毫无线索。现在新增 `_unmarkDiscussionDone` 撤回，并留一条 warn 日志。

**测试脚手架：连跑会假失败**

连续跑两次 `npm run e2e` 时，上一次的 Edge 被杀掉后调试端口未必立刻回收，
下一次会连到**正在退出的旧实例**上，症状是"所有注入都失败"或"端口仍被占用" ——
看起来像随机偶发失败。现在收尾与启动前都会等端口真正释放（12 秒超时），
连跑三次稳定通过。

**文档：README 重写为完整交接文档**

用户明确要求"便于下一个 AI 修复和 debug"，因此把 README 从「功能清单」扩成**交接文档**：

- 第一屏给出「按任务跳到哪一节」的索引与三条硬规则
- **§5 代码易纠缠点**：`_runTick` 仲裁顺序为什么不能动、互斥开关全表、
  两个重载源、配置三份默认值、位置式输出协议、答案形态规整、
  任务点判据顺序、放弃机制三条铁律、讨论任务四个易踩点
- **§6 易错点清单（25 条）**：每条都是"症状 → 根因 → 现在怎么防"，
  全部来自真实踩过的坑，越靠前越贵
- §7 症状→病因对照表；§8 改哪里定位表；§9 新增配置项完整清单
- `AGENTS.md` 收缩为「守则 + 索引」，技术细节全部交给 README，避免两份文档分叉

**修复：多个讨论任务点会互相顶掉 / 整批漏做**

用户反馈"遇到多个讨论任务可能会出现 bug"，定位到三处：

- **`#isFinished` 用了文档级查找**。`_collectDiscussionTargets` 在卡片循环里调
  `doc.getElementById('isFinished')` —— 一个章节里多张讨论卡片若落在同一个文档中，
  它们会**共用同一个"已完成"标志**：第一张已完成，其余全被当成"已回复"而**永久跳过**
  （反之则是反复重开同一个）。现在按卡片范围查找：先看卡片自身，
  再逐层向上，且**只在"只包含本卡片"的祖先上读标志** ——
  共用容器必须先判断卡片数量再读，顺序反了就等于原 bug 复发。
- **去重键用 `url.slice(-70)`**。两个任务的地址若只有前段不同、后 70 字符相同，
  会算出同一个键 → 第二个被 `_isDiscussionDone` 判成"24 小时内已处理"而**永久漏做**。
  改为优先取真正唯一的 `mtopicid`，取不到再退回整条 URL 的哈希（djb2）。
- **兜底路径的键是 `名称 + href.slice(-40)`**，同样会碰撞，一并改为哈希。

安全性权衡：卡片范围找不到标志、且同文档有多张卡片时，按**未完成**处理
（宁可按未完成也不漏做）；文档里只有一张卡片时保留旧的文档级查找，行为不变。

**修复 + 新增：跳过不必做 / 做不完的任务点**

用户反馈"有些任务不需要完成，老师会安排不可滑动来挡住插件，浪费时间"。对照开源实现
`cxmooc-tools` 的 `CxTask` 找到了两条判据：

```js
if (this.taskinfo.job) { this.done = false }   // 是任务点 → 要做
else { this.done = true }                       // 不是任务点 → 直接跳过
```

- **`job: false` 被误当成任务点**（真 bug）。`_getAttachmentWorkType` 里
  `job === true` 有专门分支，但 `job === false` 会**直接落到"按模块名推断"**那段 ——
  于是"老师没设为任务点的视频/文档"又被推断成 `job`，插件去白做一遍。
  现在显式 `job: false`（含字符串 `"false"`）在此处直接返回 `not-job`，
  `_buildAttachmentOnlyJob` 也会返回 null；`_classifyTaskFrame` 同样识别
  帧数据里的 `"job":false`。判据与参考实现对齐。
- **新增"做不完就放弃"机制**。防拖拽视频、不可翻页的文档、不计分的摆设，
  插件对这些只会一次次重试。现在每派发一次任务点就检查是否真的完成，
  没完成才计数；连续 `taskGiveUpAttempts` 次（默认 4）未完成则记入 localStorage
  （24 小时）并跳过，同时留一条 warn 日志说明原因与如何清除。
  安全点在于「拿不准就当完成」：`_isJobCompleted` 判断不了时一律返回 `true`，
  **正在推进的长视频不会被误放弃**。
- 新增 `xxtAI.taskGiveUpList()` / `xxtAI.clearTaskGiveUp()`，
  用户可查看与清除这份名单。

**提示词 v2：位置式输出 + 加大分批量（token 再降 27%）**

在 v1 基础上继续压缩，**40 题整卷 token 合计 2856 → 2076**（相对 1.0.10 累计省 50.5%）：

- **输出改成纯位置式数组** `["A",["A","C"],true,"x|||y"]`，不再回传 `i`/`a` 键名。
  答案与题目按位置对应 —— 这本来就是 content.js 在 index 缺失时的兜底行为，
  现在把它提升为唯一协议。每题输出约 11 token → 约 5 token，
  格式示例本身也短了一半。
- **分批从 5 题提到 10 题**。system 提示词与格式示例是每批都要重发的固定开销
  （约 88 token/批），题目正文无论分几批都只发一次。40 题从 8 批降到 4 批。
  开源实现 `cxmooc-tools` 的题库接口一批是 20 题，10 属于保守取法。
  `tools/prompt-bench.js` 现在会打印 5/10/20 三档的固定开销对比，便于将来调整。
- 验证码提示词去掉"这是网页校验用的图片""仔细识别"等不改变行为的铺垫。
- 三次完整复查（自检 / 基准 / 集成 / 真实浏览器）全部通过且稳定。

**为保证"压缩不压掉正确性"新增的防线**

- `normalizeItem` 的三种输入形态各有一条断言（位置式 / `{i,a}` / 旧键名），
  其中**位置式数组** `["A","C"]` 是最容易写错的一例 ——
  数组的 `typeof` 是 object，若被当成 `{a:…}` 包装对象解析，多选答案会被整条丢掉。
- `content.js` 新增 `coerceAnswerForType`：单选收到 `["A"]` 解包成 `"A"`，
  判断题收到 `"正确"`/`"T"` 归一成 `true`；多选数组**必须原样保留**。
  这类偏差若原样交给 page.js，匹配不上 → 静默不填 → 永不提交。
- 位置式输出长度与题目数不符时记 `llm answer count mismatch` 日志，
  按位置尽力对齐；没对上的题保持未填，因此**不会误提交**，下一轮 tick 重试。
- `tools/integration-test.js` 的假模型默认改为返回位置式数组（真实协议），
  同时保留 v1 对象协议与旧键名的兼容性用例；`tools/browser-e2e.js` 的假模型
  也改为位置式，并用真实 Edge 跑通 5 种题型的完整回填。

**提示词 / token（v1）**
- 新增 `libs/prompt.js` 作为提示词唯一真源（同时可在 Node 中被 `require`，便于测试）。
  `content.js` 里原有的 `buildSystemPrompt` / `buildQuestionsText` / `buildOutputFormat` 全部移出。
- 用「题型代号 + 一行图例」取代逐题 `Question N [type]:` + `Options:` 前缀，
  用单行格式示例取代按题生成的 JSON 样板，答案对象改用短键 `{"i":0,"a":"A"}` 且不再回传 `type`。
- 实测（`npm run bench`，o200k 分词器）：整卷输入 **862 → 620 tokens（-28%）**，
  输出 **186 → 94 tokens（-49%）**。
- `page.js` 只把「确实还需要模型作答」的题发出去：已确认正确、本轮已填且 DOM 有值的题直接跳过。

**修复：题目扫描（"AI 扫描不到题目"的真正成因）**

在真实 Edge 的端到端测试里暴露出来的三处抠题缺陷：

- **题干被清成空字符串**。学习通把题号单独放在 `.fontLabel`（内容就是 `"1."`），
  旧实现拿到第一个命中的标题选择器就 `break`，剥掉序号后题干变成空串 ——
  模型只看到选项、看不到问题，只能瞎猜。现在要求候选清洗后长度 ≥ 4，
  不合格继续试下一个选择器，最后退回容器文本并在第一个选项标记处截断。
- **容器的选择器循环无条件 break**。命中一批节点后还要过可见性/文本过滤，
  过滤后可能一个不剩（占位容器、隐藏模板节点），旧实现此时直接返回 0 题。
  现在改成挨个选择器试，谁第一个给出**过滤后非空**的结果就用谁。
- **选项切分的正则写错**。`textOf()` 已把换行压成空格，`[A-F][.、．\s]+[^\n]+`
  会从第一个选项标记一路吞到字符串末尾，把 A~D 全塞进同一个"选项"里。
  改为先定位所有选项标记再按区间切分。

新增题目扫描诊断：扫到 0 题时自动写进运行日志，也可在页面控制台手动执行
`xxtAI.diagnose()`（完整报告）或 `xxtAI.scanQuiz()`（只抠题）。
报告会指出断在哪一环：没命中选择器 / 容器被过滤 / 容器找到了但解析全失败。

**修复（其他）**

- `page.js._extractOptionText` 的正则里 `閫夐」` 是 `选项` 的 GBK 乱码残留
  （UTF-8 字节被按 GBK 解码），导致以「选项」开头的选项文本永远剥不掉前缀。
- `_getQuizTitleKeyFromElement` 同样会因为只拿到题号而产生退化缓存键。
- `popup.js` 切换「接入方式」时只改表单不回写 storage，重新打开弹窗会跳回旧值 —— 改为选中即保存。
- `content.js.apiFetch` 直连兜底分支误用 `timeoutMs` 而非归一化后的 `timeout`。
- `content.js` 的分批映射不再用 `批号 × 5` 反推全局题号（该算法隐含"发来的题就是全部题"的假设），
  改为原样透传调用方给的 `index`；模型回传序号越界或缺失时按数组位置兜底，并按 index 去重。
- 解析容错同时接受新旧两套键名（`i`/`a` 与 `index`/`answer`）。
- `manifest.json` 与 `page.js` 中遗留的 UTF-8 BOM 已清除。

**工程化**

- 建立 git 仓库（此前无版本控制），并保留 1.0.10 基线提交。
- 新增 `npm run check`：JS 语法、manifest 解析与 BOM、引用文件存在性、
  **版本号三处一致性**、提示词单一真源、**编码损坏探测**、死代码探测。
- 新增 `npm run itest`：把真实 `content.js` 加载进 vm 隔离环境（打桩 chrome.*），
  覆盖稀疏 index 透传、旧 schema 兼容、解析失败分类、三种模型协议（27 项）。
- 新增 `npm run e2e`：独立临时 profile 启动真实 Edge 加载扩展，配合本地 mock 测验页
  与 mock 模型接口，跑通「注入 → 抠题 → 提示词 → 模型 → 回填」（15 项）。
- 新增 `npm run bench`（提示词 token 基准，含兼容性与信息完整性自检）、
  `npm run build`（零依赖打包，产出可加载目录与 zip）、`tools/fix-bom.js`、`tools/ext-id.js`。
- 新增 `.gitignore` / `.editorconfig` / `package.json`。
- 文档：`README.md`、`ARCHITECTURE.md`、`AGENTS.md`（含"哪里会代码打架"仲裁说明）、
  `CHANGELOG.md`、`tools/README.md`。
- 死代码处置：19KB 的 `background-core.js` 移入 `legacy/`（从未被加载，且含第三份提示词实现）；
  删除 `popup.js` 中已失效的 `testApiConnection()`（它依赖的 handler 只存在于 legacy 文件里）。

---

**修复：真实浏览器交叉检验挖出的产品缺陷**

新增 `npm run e2e`（真实 Edge + 9 个 mock 页面 + mock 模型，65 项断言）后，
又暴露出四个用打桩测试根本测不到的缺陷：

- **幽灵调用导致验证码链路整体失灵（最严重）**。`_checkCaptchaDialog` 末尾调用了
  `this._diagnoseBlockedPage()`，而那个函数在早前一轮"清理调试代码"时就被删掉了 ——
  于是「没有验证码」这个最常见的情况下每次都会抛 `TypeError`。
  4 处调用点里只有 `_runTick` 那处包了 `try/catch`，另外 3 处
  （`_handleCaptchaDialog` 复检、`_backgroundCaptchaTick`、`_handleVideoPlay` 守卫）
  直接把链路打断。`tools/check.js` 新增**幽灵调用检查**，这类问题以后会被自检拦住。
- **文档解析缺兜底，导致永不交卷**。`_resolveQuizAnswerDocument` 与
  `_resolveQuizSubmitDocument` 在页面没有 `#iframe` 时直接返回 `null`，
  连锁后果是 `_getQuizQuestionFilledValue` 返回空串 →
  `_areQuizAnswersFilled` 永远 false → 答案填好了也**永远不提交**，
  同时 `_shouldAutoSubmitQuiz` 被永久禁用。两者都补上 `|| document` 兜底。
- **简答题判定"未填写"**。隐藏答案域存在但为空时不再直接返回空串，改为回退到可见控件
  （简答走富文本编辑器，页面自身 JS 未必把内容同步进隐藏域）；
  `_fillTextarea` 也补上写隐藏域，与 `_fillText` 行为对齐。
- **`textOf()` 压平换行导致选项切分错误**（见上）。

**对照开源实现校正 DOM 选择器**

以 `cxmooc-tools`（`src/mooc/chaoxing/question.ts` / `vcode.ts`）为参照校正，
补上了之前只覆盖课程页、漏掉作业/考试页的整套标记：

- 新增作业/考试页的题目容器 `.Cy_TItle` 及其变体选择器
- `_getOptionItems` 补上 `.Zy_ulTop/.Zy_ulBottom/.Zy_ulTk`、`.Cy_ulTop/.Cy_ulBottom/.Cy_ulTk`
  —— 并且**让 `<li>` 排在 `<label>` 之前**：`qid` 挂在 `<li>` 上，
  返回 label 会导致隐藏答案域永远为空、判定未填写、永不提交
- `_extractOptionText` 补上 `<a>` 分支（作业页选项文本包在 `<a>` 里）
- **「记住正确答案」链路修正**：批改结果在 `.Py_answer` / `.Py_tk`，
  对错图标是 `.fr.dui` / `.fr.bandui` / `.fr.cuo`。旧实现只认
  `marking_dui` / `correct-icon` / `right-icon`，在真实页面上一个都命中不了，
  于是答案缓存从未生效、每次答题都要重新问模型（白花 token）。
  新增 `_isQuizQuestionMarkedCorrect`（用 `classList` 精确比对 token，
  保守判定：宁可漏记也不把错题写进缓存）与 `_extractDisplayedCorrectAnswer`
  （交卷后输入域被清空，从展示文本里解析正确答案）。

**任务类型覆盖补全（三轮复查产出）**

按学习通真实的任务点 `module` 逐一核对后，补齐了此前会被**静默丢弃**的类型：

- **音频任务点 `insertaudio`**：`_classifyTaskFrame` 与 `_getAttachmentWorkType` 此前只认
  `insertvideo`，音频帧与音频附件会掉进 `other` 然后被整条丢弃。
  现在音频复用同一套媒体流程（`_playChaoxingMediaJob` 本就支持 `audio` 元素）。
- **图片任务点 `insertimage`**：此前同样被丢弃，现在按"阅读"处理（打开即算）。
  注意只在附件带 `job: true` 时生效 —— 推断路径**不**把图片当任务点，
  否则会去处理一堆纯展示图。
- **不支持的类型不再静默丢弃**：投票 `insertvote`、直播 `insertlive` 等
  会留一条 `unsupported task point type` 运行日志。此前用户只能看到"这个任务点没做"，
  完全无从判断是识别失败还是压根不支持。
- **扩展名匹配允许不带前导点**：学习通的 `property.type` 常见写法是 `"ppt"` / `"mp4"`，
  而旧正则 `\.(ppt|…)$` 只认 `".ppt"`，这类任务点会被判成 `not-job` 直接漏掉。

**代码精简**

- 抽出 `libs/api-url.js`，消掉 `content.js` 与 `popup/popup.js` 里各一份的
  API 地址构造与密钥清洗（约 40 行重复）。这两份**已经分叉**：只有 popup 那份会剥掉
  用户粘贴时带的引号，正是"弹窗测试连接通过、页面上答题却失败"这类现象的土壤。
- `_resolveQuizSubmitDocument` 与 `_resolveQuizAnswerDocument` 实现完全相同
  （解题域本来就是同一个文档），改为前者转发后者，消除两处各自演化的风险。
- `content.js` 新增 `missingModuleError()`：依赖模块缺失时返回
  "请在 edge://extensions 重新加载扩展"，而不是抛 `Cannot read properties of null`。

**测试与自检加固**

- `tools/check.js` 新增两项：**幽灵调用检查**（调用了但没定义）与
  **死方法检查**（定义了但无人调用，告警级）；唯一真源检查扩展到 API 地址构造，
  并校验 `manifest.content_scripts` 真的注入了 `content.js` 依赖的 lib。
- `tools/integration-test.js` 改为按 manifest 顺序加载全部隔离世界脚本
  （此前只加载 `prompt.js` + `content.js`，抽走 API 构造函数后立刻暴露）。
- `tools/browser-e2e.js` 扩到 12 个场景 / 100 项断言：新增**任务类型识别**
  （视频/音频/文档/图片/测验/投票的映射表 + 推断策略 + 不支持类型留日志）、
  **隐藏 audio 兜底**、**设置弹窗冒烟测试**（依赖加载顺序、地址构造、密钥清洗、
  初始化、无未捕获异常）—— popup 此前零测试覆盖。
- Chromium 的 `--disable-extensions-except` 与 `--load-extension` 必须成对使用，
  且扩展 ID 需按 `SHA256(路径 UTF-16LE) → a-p` 直接算出，不能等 CDP 报出来。

**文档**

- README 增加「功能与验证状态」表，逐项标注自动化验证覆盖到哪一步、
  哪些必须到真实课程页人工确认（真实编解码、加密字体、任务点结构）。
- `AGENTS.md` 新增：幽灵调用教训、学习通两套题目标记对照表、
  `_getOptionItems` 顺序约束、文档解析兜底、真实验证码选择器。
- `tools/README.md` 记录 browser-e2e 的 9 个场景与全部踩坑。

## 1.0.10 — 讨论任务点按真实浏览器观察重写

- 用独立临时 profile + CDP 只读观察真实讨论任务点，推翻此前所有猜测：
  讨论点在课程页里是三层嵌套 iframe，最内层卡片 `#topicMainDiv` 的 `data` 属性才藏着真实讨论地址
  （`groupweb.chaoxing.com`，独立跨域网址）；课程里共 18 处，模块名是 `insertbbs`。
- 之前靠"页面上有讨论字样的可点击元素"匹配 —— 而卡片文本是**题目内容**，
  既不含"讨论"也不在 attachments 名称里，所以永远找不到、被判为 other 跳过。
- `_findDiscussionTask` 改为三级策略（卡片直取 → 模块解析 → 文字匹配），并过滤 `#isFinished`，已完成绝不重发。
- 精确定位控件：编辑区 `.replyEdit textarea[placeholder="回复话题"]`，
  提交按钮 **`.addReply`**；页面上另有 `.replyBtn` / `.topicDetail_title_right`
  两个同名"回复"按钮其实是展开按钮，点错就永远发不出去。
- 成功判据改为「回复列表新增条目」为主，兼容成功文案与编辑区清空。
- 安全修正：讨论页/验证码页改为**只有 `shouldAutoStart()` 为真才自动运行** ——
  没在刷课时进入讨论区一律静默，绝不自动发评论。

## 1.0.9 — 讨论任务点自动完成

- 新增讨论任务：检测到后自动跳转、发布评论（内容可配）、完成后返回刷课页继续，带 90 秒超时防卡。
- 防重复三处：打开前即写 `omitone_discussion_done` 标记、`_discussionPosted` 保证每页只发一次、扫描/打开各自节流。
- popup 新增开关与「讨论回复内容」输入框。

## 1.0.8 — 音频自动最大倍速 + 静音播放 + 清理

- `_readRateMenuMax` 改为优先查播放器容器，音频不做整文档扫描（避免读到别的播放器的档位而误判）。
- 新增倍速探测任务纪元 `_rateEpoch`，修复"切换任务时旧视频探测结果串到音频上"与"探测中切任务后新任务永不探测"。
- 新增 `audioMuted` 配置（音频默认静音播放）。
- 删除调试期诊断转储函数与 2 处调用。

## 1.0.7 — 音频无法播放

- 根因不是 m4a 格式，而是**可见性过滤把隐藏 `<audio>` 全滤掉了**（自定义播放器常把 audio 隐藏，零尺寸）。
- 新增 `_pickMedia`：优先可见媒体，无可见媒体时回退隐藏的 audio。
- `_findMediaInDocument` 增加子 iframe 递归（深度 ≤3，走 `_safeDocOf` 防跨域抛错）。
- `_videoEventHandle` 补绑 `error` 事件 —— 此前格式不支持（code 4）与解码失败（code 3）永远静默。
- 新增 `_maybeRepairMediaSource`：m4a/MIME 兜底，页面内 fetch → Blob → objectURL 重设 src → 恢复进度。

## 1.0.6 — 支持独立验证码网址

- 验证码可能不在学习通界面里，而是独立网址。此前 manifest 注入范围只匹配学习通路径，那些页面**根本不会被注入**。
- `content_scripts.matches` 扩为 `*://*.chaoxing.com/*` + `*://*/*`，
  `web_accessible_resources.matches` 同步放宽。
- `content.js` 增加静默守卫：非学习通页面只有「正在刷课 + 疑似验证码页」才注入，其余立即退出、零行为。
- 新增独立验证码页模式（5 个方法，最多 4 轮，处理完 `window.close()` / `history.back()`）。

## 1.0.5 — 跨域帧异常打挂主循环

- 根因：`_searchChaoxingJobOcs` 与 `_ensureOcsStudyRunner` 裸读跨域窗口的 `document`。
  验证码/反作弊页常把主 `#iframe` 指向跨域地址，`SecurityError` 冒泡进 tick 的 catch，
  每 250ms 一次 → 日志被同一条错误刷满、后续所有逻辑不执行。
- 新增 `_safeDocOf` / `_safeWinDoc` / `_isFrameSameOrigin`，跨域一律返回 null 不抛异常。
- `_runTick` 重排：验证码检测提到最前并各自包 try/catch，任何单点异常不再打断整轮。
- 新增 `_checkBlockedByCrossOrigin()`：主 iframe 跨域持续 >20 秒则刷新页面恢复（180 秒冷却）。
- tick 错误日志 30 秒去重并附 `err.stack` 前 3 行。

## 1.0.4 — 验证码与 AI 答题彻底分离

- 拆出独立开关 `enableCaptcha`（验证码链路此前从不检查 `enableQuiz`，但用户以为被联动挡住）。
- `_checkCaptchaDialog` 重写为三层识别，并挪到 `_runTick` 最前。
- 新增 `captchaModel` 配置（验证码走独立的视觉模型）。

## 1.0.3 — 拖尾 / 填空 / 音频 / 配置同步

- 新增"可拖动视频直接拖到结尾"（`_trySeekToEnd`，每个视频只尝试一次）。
- **修复 AI 答题开关关不掉**：`content.js` 转发配置更新时漏了 `source: 'xxt_bridge'`，
  被 `page.js` 的过滤器丢弃 —— 症状是"改了开关必须刷新才生效"。
- **修复 manifest 缺 `background` 段**：service worker 从未注册，`api_fetch` 代理一直不可用，
  content script 的跨域 fetch 受 CORS 约束（历史上"API 连接错误"的隐患之一）。
- 修复填空题不提交（`_fillText` 只写可见 input，而读取走隐藏域 `#answer{qid}`）。
- 修复音频不自动播放（`_getVideoEl` 由 `video` 改为 `video, audio`）。

## 1.0.2 — 基线（1.0.2 之前的记录未留存）

已具备：视频自动播放/倍速/防暂停、单选/多选/判断/填空/简答/弹窗题、
文档与 PPT 翻页、字体反爬解密。
