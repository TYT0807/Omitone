<div align="center">

# Omitone

**学习通（超星 / Chaoxing）网页版的学习辅助浏览器扩展**

![Edge / Chrome 扩展](https://img.shields.io/badge/扩展-Edge%20%2F%20Chrome-0078d4?logo=microsoftedge&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange)
![版本](https://img.shields.io/badge/版本-1.0.11-blue)
![许可](https://img.shields.io/badge/License-GPL--3.0-green)
![公益](https://img.shields.io/badge/公益-免费%20·%20不盈利%20·%20不引流-brightgreen)

**免费 · 公益 · 本地运行 · AI 由你自己接入**

</div>

---

## ⚠️ 先花一分钟读完这四件事

**1. 这是公益项目：完全免费，永远不会有收费版、会员群、付费解答。**

没有赞助链接，没有打赏二维码，不卖 Key，不引流到任何地方。
如果有人拿着它向你收费 —— 那是骗子，与本仓库无关。

**2. AI 功能要你自己接 API Key，本工具不带任何 AI 能力。**

视频播放、刷课、阅读这些**不需要 Key**，装上就能用。
只有「AI 答题」和「验证码识别」需要你自己填 API Key ——
去任意一家大模型厂商申请即可（多数有免费额度，几块钱能用很久）。
**没有 Key 也不会影响刷课功能本身**，只是遇到测验会跳过不答。

**3. 你的密钥偷不走 —— 因为外面根本没有接收方。**

见 [密钥安全这一节](#密钥安全为什么说它偷不走) —— 里面给了你可以自己验证的命令，
不需要相信我这边的任何一句话。

**4. ⚠️ 用途限定：仅供学习与技术交流。用于"作弊"的一切风险，由你自己承担。**

先把话说在前面，不含糊：

- **本工具的定位是"学习辅助"，不是"替你完成学业"。**
  它适合的是那种"看了三遍还是这几句话、纯粹在消耗时间"的部分 ——
  把这段时间还给你，去做真正需要动脑的事。
- **如果你用它来完成本应独立完成、且计入考核的作业或考试，那就是作弊。**
  这是你的选择，**不是我的建议**。
- **由此产生的一切后果 —— 成绩作废、课程挂科、纪律处分、学籍影响 ——
  全部由使用者本人承担，与本项目、与原始作者无关。**
- 请遵守你所在学校的规章制度与学习通的用户协议。
  不同学校、不同课程对自动化工具的容忍度差别很大，**你比我更清楚边界在哪**。

它不会代替你输入账号密码，也不会代替你发布任何内容（见 §13 边界）。

**另外，请顺手读完 [已知缺陷与重要限制](#-已知缺陷与重要限制)**
—— 里面写清了"只有 DeepSeek 是真跑通过的"、"正确率没有保障，考试请别用"这类实情。
把它读完，比读完剩下的部分都重要。

> 下一节是**已知缺陷清单**，比上面任何一句话都具体。
> 里面写了"只有 DeepSeek 是验证过的"以及"默认最多尝试交卷 20 次"这类真相 ——
> **如果你打算用在考试或有次数限制的任务上，请务必先读完它。**

---

## 已知缺陷与重要限制

这一节不是免责套话，是逐条核对过代码的实情。请把它当作"能不能用"的判断依据。

### 1. 只有 DeepSeek 是真正在真实答题中跑通过的

顺带解释原因：为了省 token，代码里给 DeepSeek 关掉了**思考模式**
（`thinking: { type: 'disabled' }`）——答题是模式化任务，开着思考每道题要先烧约 200 个
推理 token，关掉后 2 题从 361 token 降到 133 token。
**这个参数是只对 DeepSeek 加的**，因为其他 OpenAI 兼容服务遇到未知参数会直接报 400。

但这也意味着：

- **DeepSeek = 在真实章节测验里完整验证过**（抠题 → 作答 → 回填 → 交卷 → 记分）
- **其他厂商 = 只按官方文档配好了预设，未在真实答题中逐一验证**
- 换别的厂商时请先用「检测 API 连接」跑通，
  再找一节**不重要**的测验试一遍手感，确认没问题再上正课

### 2. 关掉思考模式＝牺牲推理深度，正确率必然下降

同一款模型，"带思考"答推理题就是比"不带思考"准。
我们选了**便宜 + 快**，代价是碰到需要绕几个弯的题目更容易答错。
哲学类、思修类这种偏语义理解的还好；涉及计算、因果链条判断的题，请自己复核。

### 3. 正确率没有保障 —— 考试 / 有次数限制的任务请勿使用

说白了：**AI 答题大概率不是满分，而且它在遇到不会的题时会猜。**

机制是这样的：

- 提示词硬性要求"不确定也要给最可能的答案"，所以**它宁可猜也不会留空**
- 答错后会带着「禁:」前缀重试（告诉模型"这几个答案已经被证明是错的"）
- **默认最多尝试交卷 `quizMaxSubmitAttempts` = 20 次**
- 即使这样仍然填不满/答不对时，它会放弃并跳过

**结论很直接：**

| 场景 | 建议 |
| --- | --- |
| 章节测验（通常可多次提交） | 可以用，但仍建议扫一眼它给的答案 |
| **考试、期末测验、只能提交一次的作业** | **不要开 AI 答题**，把 `enableQuiz` 关掉 |
| 成绩直接计入总评的任务 | 不要依赖它，自己看完自答 |
| 想要高正确率 | 目前做不到，不要在这一点上抱期望 |

顺带提醒：**这 20 次交卷是真的会提交上去的。**
如果你的课程本身限定了提交次数（很多考试只允许 1~2 次），
请先确认规则，或者干脆别在这一科上开答题。

### 4. 讨论任务点会代替你发言

默认开启：跳转到讨论区 → 发一条评论 → 自动返回继续刷课。

- 不想让它发言：弹窗里关掉「讨论任务点自动发评论」
- **默认回复内容是 `"1"`** —— 请务必改成正常的话。
  `"1"` 这种回复在老师看来就是灌水，被记一笔不值得
- 回复内容在弹窗「讨论回复内容」里自定义

### 5. 题库字体反爬可能失效

学习通用自定义字体（`font-cxsecret`）把部分题目文字加密成不可选的字形，
项目靠 `resources/table.json` 的**字形哈希 → 真实字符**映射还原。

这份表是一个**快照**。一旦学习通更新了字符集，映射表里没有的字形就还原不出来，
题干会变成乱码 —— 此时 AI 收到的也是乱码，**结果必错**。

**看到题干乱码请立刻停下**：继续跑下去既答不对，还白耗 token。

### 6. 其它已知限制

- **不支持的任务点**：投票、直播会直接跳过（并留一条日志说明原因）
- **窗口最小化后会变慢**：已有后台节流对抗（Worker 心跳 + 音频保活），
  但浏览器自己的「睡眠标签页」是整页冻结，插件侧无法绕过
- **验证码识别并不稳**：必须填视觉模型；识别失败会重试，
  也可能识别错 —— 错了就是白跑一轮
- **只在 Edge 上做过完整验证**：Chrome 同内核但没系统测过；Firefox 不支持
- 验证码一旦出现，说明平台已经在关注自动化行为 ——
  这时候最稳妥的做法其实是**停一会儿，手动做几题**

---

## ⚠️ 已知缺陷与重要限制

这一节不是免责套话，是**逐条对着代码和真机实测写的**。会不定期更新。

**1. 目前真正跑通过的只有 DeepSeek，其他厂商是"按文档配好"但没实测**

弹窗里内置了 9 家预设（MiniMax / DeepSeek / Gemini / Claude / 通义 / 智谱 / Kimi / OpenRouter / 硅基流动），
其中**只有 DeepSeek 在真实答题链路上完整验证过**（抠题 → 作答 → 回填 → 交卷 → 记分）。
其余的是按各家 2026-09 官方文档核对过的**配置**，没有逐一实测 —— 地址、参数、模型名都可能有出入。

换厂商时请先用「检测 API 连接」跑通，再拿一节不重要的测验试手感。

顺带说明为什么 DeepSeek 表现最稳：代码里**只对 DeepSeek 关掉了"思考模式"**
（`thinking: { type: 'disabled' }`）—— 答题是模式化任务，开着思考每道题要多烧约 200 个
推理 token。其他 OpenAI 兼容服务不认这个参数（遇到未知字段会直接 400），所以没加。

**2. 正确率没有保障 —— 考试、或要求高正确率的场景，请不要用**

- **AI 答题做不到全对。** 提示词要求"不确定也要给最可能的答案"，
  所以模型遇到不会的题**会猜**，猜错就是真错。
- 答错后会自动带着「已排除的错误答案」重试，但**默认最多重试 20 次**
  （`quizMaxSubmitAttempts`），到顶就跳过。
- **如果你的测验只有一次提交机会，或者成绩很重要 —— 请在弹窗里关掉「AI 答题」自己答。**
  这一点说三遍都不多：本工具的价值在于省下刷视频的时间，**不在于替你拿分**。
- 判断题、多选题的出错概率明显高于单选题。

**3. 题库字体反爬一旦失效，题干会变成乱码 —— 那时它必错**

学习通用自定义字体把部分题目文字加密成不可选的字形，项目靠 `resources/table.json`
（随扩展分发的**快照**，347KB）做「字形哈希 → 真实字符」还原。
学习通一旦更新字符集，表里查不到的字形就**原样保留**，于是：

> 题干是乱码 → AI 收到的也是乱码 → **答案必错，还会白烧 token**

**看到题干乱码请立刻停手**，不要再跑了。

**4. 讨论任务点会代替你发评论**

默认开启：跳转到讨论区 → 发一条评论 → 自动返回继续刷课。

- 不想让它发言 → 弹窗关掉「讨论任务点自动发评论」即可
- **默认的回复内容是 `"1"`** —— 请务必改成正常的话，
  一串 `"1"` 在老师眼里就是灌水，被记一笔不值得

**5. 不支持的任务点：投票、直播**

目前**不做**投票（`insertvote`）和直播（`insertlive`），遇到会跳过并留一条日志说明原因。
另外音频、图片类任务点在真实页面上仍需人工确认（自动化验证覆盖不到编解码与真实任务点结构）。

**6. 窗口最小化后会变慢，这个只能缓解不能根治**

已有四层对抗（Worker 心跳 / 音频保活 / `pause` 事件直接恢复 / 回前台重校验），
但浏览器自己的「睡眠标签页」是**整页冻结**，插件侧无法绕过。
若你在 `edge://settings/system` 开了睡眠标签页，请关掉它。

**7. 平台一改版就可能失效**

本工具依赖学习通的 DOM 结构与内部接口。**学习通随时可能改版**，
届时症状通常是"扫不到题"或"任务点识别不出来"，请先跑 `xxtAI.diagnose()` 看断在哪一环。

同理，验证码是平台的风控信号：它一旦频繁出现，说明平台已经在关注自动化行为 ——
这时候最该做的是**停一停**，而不是继续硬刚。

**8. 视频中途弹出的题（弹题）：模板多，认不出来就会放弃**

视频播放到一半弹出的题**没有统一模板**，可能是原生 `li + input`、可能是自定义浮层，
也可能根本不在主文档里。1.0.11 只能认带 `.num_option` 徽标的学习通标准结构，
遇到别的模板就会**反复问模型却一个选项都填不进去**（典型表现：AI 日志一直在跑，课程原地空转）。

现在的行为是：**同一道弹题最多问 3 次模型**，仍然填不进去就写一条 error 日志
（含弹窗的真实 DOM 快照）→ 尝试点「跳过/关闭」→ 进入 60 秒冷却，不再拦着播放和跳章。

也就是说：**它不会帮你把这类题答对，但也不会把整节课卡死。**
如果你经常遇到弹题答不上来，在卡住的页面控制台跑 `xxtAI.diagnosePopup()`，
把输出贴到 issue 里 —— 有了弹窗的真实结构才好加模板。

---

## 它能做什么

| 功能 | 说明 | 需要 API Key |
| --- | --- | --- |
| **视频 / 音频自动播放** | 自动开播、被暂停自动抢回、播完自动翻节 | ❌ |
| **自动最大倍速** | 读播放器菜单取速度上限（读不到就逐档试探） | ❌ |
| **拖到结尾** | 可拖动视频直接 seek 到片尾，每个视频只试一次 | ❌ |
| **PPT / 文档 / 图片** | 翻页、上报完成、等页内音频播完 | ❌ |
| **讨论任务点** | 跳转讨论区 → 发评论 → 返回继续 | ❌ |
| **多讨论任务点** | 同章节多张卡片各自独立处理、互不顶掉 | ❌ |
| **跳过不必做的点** | 老师没设为任务点的内容直接跳过；反复做不完的记录后放弃 | ❌ |
| **题库字体反爬** | 解析 `font-cxsecret` 自定义字体还原题目文本 | ❌ |
| **AI 答题** | 单选 / 多选 / 判断 / 填空 / 简答 / 弹窗题（正确率有限，见上一节） | ✅ 自己接 |
| **答案缓存** | 交卷后记住正确答案，下次不再问模型，省 token | ✅ 自己接 |
| **验证码识别** | 弹窗验证码与独立验证码页：抓图 → 视觉模型 → 填入 | ✅ 自己接（需视觉模型） |
| **后台节流对抗** | Worker 心跳 + 音频保活，窗口最小化后仍推进 | ❌ |
| **题目扫描诊断** | 扫不到题时输出可定位的诊断报告 | ❌ |

一句话概括：**不需要 AI 的部分全部免费可用，需要 AI 的部分你自己接、自己付费、自己承担用量。**

---

## 快速开始

**方式一：直接加载源码（推荐，便于更新）**

1. 下载本仓库 → 解压到本地任意位置（记住这个路径）
2. Edge 打开 `edge://extensions`（Chrome 对应 `chrome://extensions`）
3. 打开右上角「开发人员模式」→「加载解压缩的扩展」→ 选**解压后的整个目录**
4. 打开学习通课程页 → 点扩展图标 → 点「开始运行」

**方式二：加载打包产物**

```bash
npm run build        # 产物：dist/omitone-1.0.11/
```

再按上面第 2~3 步加载 `dist/omitone-1.0.11/`。

> 扩展详情会显示「在所有网站上运行」，这是**必需的**：验证码有时是与学习通无关的独立网址。
> 在其它网站上它检测到不是目标页面会立即静默退出，什么事都不做。

**想用 AI 答题的话**，在弹窗里：

1. 从「接入方式」选一家厂商（已内置 MiniMax / DeepSeek / Gemini / Claude / 通义 / 智谱 / Kimi 等预设）
2. 填入你的 API URL、Key、模型名 —— **输入即自动保存**
3. 点「检测 API 连接」确认通路
4. 要用验证码识别，**必须**另填「验证码识别模型」，且必须是带视觉能力的模型

改完代码要生效：在扩展管理页点「重新加载」，然后**务必刷新学习通页面（F5）**。

---

## 密钥安全：为什么说它偷不走

这是做这种工具最该被追问的一句话。所以把结论和**验证方法**都摆在这里：

**结论**：密钥只写进你自己浏览器的 `chrome.storage.local`，**永远不会被发送到本项目的任何地方 ——
因为根本不存在这个地方。**

几条可以逐条核对的事实：

| | 事实 | 怎么验证 |
| --- | --- | --- |
| 无自有服务器 | 项目**没有后端**，没有一个字节是你自己处理不了的 | 全仓库没有作者名下任何域名 |
| 请求直达厂商 | AI 请求由 `background.js` 直接 `fetch` 你在弹窗填的那个地址 —— 填谁的门牌就走谁的网关 | `libs/api-url.js` 全程只做字符串拼接，**唯一的地址来源是你填的配置**（或厂商官方默认地址） |
| 无遥测 | 不发统计、不发埋点、不上报日志、不检查更新 | 「更新检查」消息直接返回 `skipped`，从不联网 |
| 默认域名全是厂商官方 | `api.minimaxi.com` / `api.deepseek.com` / `api.anthropic.com` / `generativelanguage.googleapis.com` … | 见 `popup/popup.js` 的 `PROVIDER_PRESETS` |
| 日志不带密钥 | 请求失败时日志截断**错误信息**，不记录密钥，也不记录请求头 | `content.js` 里所有 `slice(0, 300)` 的报错分支 |

**你可以自己复核**，在仓库根目录执行这条命令，看它列出来的每一个域名：

```bash
# 列出代码里出现的全部外网地址 —— 应该只有各家 AI 厂商的官方接口
grep -rhoE "https?://[a-zA-Z0-9.-]+" --include="*.js" --include="*.html" . | sort -u
```

（输出里若出现非厂商域名，请务必先提 issue 问清楚，再考虑要不要用。
安全边界本来就应该是可验证的，而不是靠一句"我保证"。）

另外提醒一句：**这份保证只对从本仓库拿到的代码成立。**
别人改过的版本、来路不明的"绿色版"，不要输入你的密钥。

---

## 项目来源与致谢

这个项目**最初来自哔哩哔哩 UP 主「不要过拟合」**，不是我从零写起的。

> 🔗 **作者主页**：[space.bilibili.com/1598603072](https://space.bilibili.com/1598603072)
> （原始教程视频已下架，主页还在 —— 想看这位 UP 主现在在做什么，去这里）

后来这位 UP 主的视频已经下架、网站也不再更新，工具在学习通改版后逐渐不能用了。
我是在这个基础上**继续维护起来的** —— 修 bug、补功能、重做题库适配、补齐密钥安全说明。

**所以本项目的原创部分归 UP 主「不要过拟合」，后续维护归本仓库。**
如果这位 UP 主本人看到并提出任何要求 —— 下架、改名、调整署名方式 ——
**都以他的意愿为准，我会照做。**

同时参考并致谢开源社区：

- **[CodFrm/cxmooc-tools](https://github.com/CodFrm/cxmooc-tools)** ——
  任务点判据（`job` 字段）、题目选择器、验证码处理都对照过它，本项目的很多设计思路来自这里
- 字形哈希还原参考 `Typr.js`；`resources/table.json` 是字形 → 字符映射表

**侵权处理**：如果你认为这个仓库侵犯了你的权益 —— 无论是原始作者、厂商还是平台 ——
请**直接提 issue 或发邮件联系我，我会立即删除**。

---

## 关于联系我

先说一句可能不太体面的实话：**我基本不看 GitHub。**

纯公益项目，没有收益，平时也不会挂着通知。
所以如果你提了 issue 或私信，我**大概率会很久才看到**，
这不是故意不回，真的不是 —— 请你一定不要往心里去。

因此：

- **紧急的事情（尤其是侵权删除）优先用邮件**联系我：见 GitHub 个人主页公开邮箱
- 一般的 bug 反馈欢迎提 issue，附上：`xxtAI.diagnose()` 的输出、页面 URL、扩展版本
  （**弹题答不上来**请另外附 `xxtAI.diagnosePopup()` 的输出 —— 里面带的 DOM 快照是加模板的唯一依据）
- 看到了一定会处理，只是慢

如果你愿意**参与维护**（PR 非常欢迎），那就更好了 ——
这份 README 的下半部分就是给下一个维护者写的交接文档。

---

## 免责声明

> 用大白话说：**这个工具是给你省时间的，不是给你骗分数的。
> 你拿它去做什么，后果是你自己的。**

1. **本仓库仅供学习与技术交流。** 代码全部开源，目的是让人看懂"浏览器扩展怎么和网页打交道"，
   也方便有同样需求的人自己搭一个。
2. **不得用于任何违反法律法规、校纪校规或平台用户协议的用途。**
   包括但不限于：代刷学时、代答计入考核的作业与考试、批量刷课牟利。
3. **使用者自负全责。** 因使用、修改、传播本仓库代码而产生的任何直接或间接后果 ——
   账号封禁、成绩作废、纪律处分、数据损失等 —— **均由使用者本人承担，
   与本项目维护者、贡献者及原始作者无关。**
4. **不提供任何担保。** 代码按"原样"提供，不保证功能完整、不保证正确率、
   不保证在你所在学校的环境下可用，也不保证持续维护。
5. **不代替真人判断。** AI 答题的结果仅供参考，**请自行核对后再提交**；
   尤其不要把成绩重要的任务交给它（见[已知缺陷](#-已知缺陷与重要限制)第 2 条）。
6. **若本仓库内容侵犯了你的合法权益**，请通过 issue 或邮件联系我，核实后**立即删除**。

---

## 许可

本项目采用 **[GPL-3.0](LICENSE)** 许可。

选 GPL 的原因很直接：**它是公益项目，那就让它在法律上保持公益 ——
任何人都可以用、可以改，但改过之后同样必须开源。** 谁也没法把它拿去闭源转售。

> 提醒后来者：GPL 是强 copyleft。
> 如果你要往里合入其它许可（如 MIT）的代码，请先确认许可兼容性；
> 若上游原始版本的许可与此不一致，请以原始作者的意愿为准，并第一时间替换本仓库的 LICENSE。

---

## 交流渠道

暂无 QQ 群 / 微信群 / Discord。

公益项目维持一个群所花费的精力，往往远超写代码本身；
而且群一旦热闹起来，"答疑"会迅速变成第二份没有报酬的全职工作。
所以这里只保留 GitHub Issues：**慢，但每一条都会被看到，且在公开处沉淀。**

---

> **以下上半部分是使用者文档，下半部分是维护者文档。**
> 只想用这个扩展的话，读到这里就够了。

---

## 给接手的人 / AI：先看这里

这份 README 是**完整交接文档**。按下面的顺序读，不要通读 `page.js`（约 7600 行 / 290 个方法）：

| 你要做的事 | 直接跳到 |
| --- | --- |
| 先跑起来看看现状 | [§1 功能与验证状态](#1-功能与验证状态) · [§10 开发命令](#10-开发命令) |
| 用户报了个 bug，要先定位 | [§3 诊断入口](#3-出问题时先跑这几句) · [§7 症状→病因](#7-调试手册症状--病因--查哪里) |
| **准备改代码**（必读） | [§4 运行机制](#4-运行机制三层环境与调度) · [**§5 代码易纠缠点**](#5-️-代码易纠缠点改之前必读) |
| 改的时候怕踩坑 | [**§6 易错点清单**](#6-️-易错点清单每条都真实踩过) |
| 想加一个配置开关 | [§9 新增配置项清单](#9-新增配置项的完整清单) |
| 想动提示词 / 省 token | [§11 提示词与 token](#11-提示词与-token) |

**三条最容易踩的硬规则**（违反会出事，详见 §5 §6）：

1. 改完必须**刷新学习通页面**（只重载扩展不刷新 → 旧 content script 断连，症状是"功能全停"）
2. 删方法前先 grep 全部调用点（`npm run check` 有幽灵调用检查兜底）
3. 跨域 iframe **永远不要裸读 `.document`**（抛 `SecurityError`，会静默打断整个调度循环）

### 文档地图

| 文件 | 内容 |
| --- | --- |
| **本文件** | **完整交接文档**：功能与验证状态、运行机制、**易错点**、**代码纠缠点**、调试手册、改哪里 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 更深的协议细节：消息协议全表、storage 键、index 语义、失败分类、各条链路的实现要点、已知限制 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 的做事守则（不重复技术细节，只规定流程与硬性约束） |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么、为什么这么改 |
| [`tools/README.md`](tools/README.md) | 开发脚本说明 + **测试脚手架的全部踩坑记录** |
| [`legacy/README.md`](legacy/README.md) | 为什么那些代码被停用、为什么不能接回去 |

---

## 1. 功能与验证状态

「自动化验证」列指 `npm run e2e`（真实 Edge + 14 个场景，135 项断言）覆盖到哪一步。
**标 ⚠️ 的部分必须到真实课程页人工确认** —— mock 页面无法替代真实平台的编解码、加密字体与任务点结构。

| 功能 | 做什么 | 验证环节 | 自动化验证 |
| --- | --- | --- | --- |
| **视频 / 音频自动播放** | 自动开播；被暂停后自动抢回；播完自动翻节 | 媒体查找、播放控制 | ⚠️ 真实编解码需人工 |
| **自动最大倍速** | 读播放器倍速菜单取上限（读不到就逐档试探） | 倍速应用、上限约束 | ⚠️ 菜单读取需真实播放器 |
| **拖到结尾** | 可拖动视频直接 seek 到 `duration - 3s`，每个视频只试一次 | 时机判断、开关生效 | ✅ |
| **静音播放** | 视频静音；音频默认静音 + 最高倍速 | 配置 → 元素属性 | ✅ |
| **PPT / 文档 / 图片** | 翻页、上报 `finishJob`、等页内音频播完 | — | ⚠️ 需真实任务点 |
| **AI 答题** | 单选 / 多选 / 判断 / 填空 / 简答 / 弹窗题 | 抠题 → 提示词 → 模型 → 回填 DOM | ✅ 5 种题型全链路 |
| **答案缓存** | 交卷后记住正确答案，下次不再问模型 | 对错判定、写入与读回 | ✅ |
| **验证码（弹窗）** | 课程页弹窗验证码：抓图 → 视觉模型 → 填入提交 | 命中检测、结果清洗 | ✅ |
| **验证码（独立网址）** | 验证码是独立页面时同样处理，处理完自动返回 | 页面判定、抓图 | ✅ |
| **讨论任务点** | 跳转讨论区 → 发评论 → 返回继续刷课 | 页面识别、控件定位 | ✅ 定位需真实 DOM 复核 |
| **多讨论任务点** | 同一章节多张讨论卡片各自独立处理，互不顶掉 | 同文档多卡片、去重键唯一性、已完成标志归属 | ✅ |
| **题库字体反爬** | 解析 `font-cxsecret` 自定义字体，按字形哈希还原题目文本 | — | ⚠️ 需真实加密字体 |
| **后台节流对抗** | Worker 心跳 + 音频保活 + `pause` 抢播，最小化后仍推进 | — | ⚠️ 需人工长时观察 |
| **跳过不必做的任务点** | 老师没设为任务点的内容（`job:false`）直接跳过；反复做不完的记录后放弃 | `job:false` 判据、进度快照、放弃名单 | ✅ |
| **设置弹窗** | 配置读写、接入方式预设、API 连通性检测 | 依赖加载、地址构造、初始化 | ✅ |
| **题目扫描诊断** | 扫不到题时输出可定位的诊断报告 | 报告内容与线索 | ✅ |

### 支持的学习通任务类型

任务点靠 `module` 字段区分。判定顺序**不能改**（见 [§5.7](#57-jobfalse--isPassed--字段缺失--必须保留的判断顺序)）：

| 任务点类型 | module | 处理方式 |
| --- | --- | --- |
| 视频 | `insertvideo` | 媒体流程（播放、倍速、静音、拖尾） |
| 音频 | `insertaudio` | 同一套媒体流程；播放器把 audio 藏起来时也能找到 |
| 文档 | `insertdoc`（pdf / ppt / docx / innerbook） | 阅读流程：翻页 / 滚动 / 上报完成 |
| 图片 | `insertimage` | 按阅读处理（打开即算） |
| 测验 · 作业 · 考试 | `work` / `exam` | 答题流程 |
| 讨论 | `insertbbs` | 独立模块：跳转发评论再返回 |
| 超链接 | `link` | 点开即可（`enableHyperlink`） |
| **投票** | `insertvote` | **不支持** —— 运行日志会留 `unsupported task point type` |
| **直播** | `insertlive` | **不支持**，同上 |

---

## 2. 安装与使用

```bash
npm run build        # 产物：dist/omitone-1.0.11/
```

打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 `dist/omitone-1.0.11/`。
也可以直接加载仓库根目录（跳过打包）。

> 扩展详情里会显示「在所有网站上运行」，这是**必需的**：验证码有时是与学习通无关的独立网址，
> 注入范围必须覆盖它。平时在无关网站上它立即静默退出，不做任何事。

1. 点扩展图标 → 填 API URL / Key / 模型名（或从「接入方式」选预设）
2. 点「检测 API 连接」确认通路
3. 要用验证码识别的话，**必须**另填「验证码识别模型」，且必须是支持图片输入的视觉模型
4. 打开学习通课程页 → 点「开始运行」

**改完代码的固定动作**：`npm test` 全绿 → 同步版本号三处 → `edge://extensions` 重新加载 →
**刷新学习通页面（F5）**。

---

## 3. 出问题时先跑这几句

在学习通页面按 F12，控制台执行：

```js
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
漏掉 `source` 会被静默丢弃，症状是"配置改了不生效"。

`libs/*.js` 由 `manifest.content_scripts.js` 数组按顺序在 `content.js` 之前注入；
popup 侧要单独写进 `popup/popup.html` 的 `<script>`。`npm run check` 会校验这两处。

### 4.2 主循环：单入口、有重入锁

`_startTickLoop` 每 250ms 调一次 `_runTick`，`_tickRunning` 保证上一轮跑完才开始下一轮，
150 秒的看门狗会强制释放卡死的锁。

推论：
- 任何 `await` 永久悬挂 = 整个循环死亡。**新增 `await` 必须可超时**
  （跨环境走 `bridgeSend`，自带 90 秒；`video.play()` 包 `this._withTimeout`）
- 别在 `_runTick` 里加"每次都要跑完"的重活，会拖慢整个心跳

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

**这一节是本项目历史上 bug 的主要来源**：绝大多数故障不是"某处写错了"，
而是**两条本来各自正确的代码路径互相抢**。改动前先搞清当前是谁在仲裁。

### 5.1 `_runTick` 的判定顺序就是仲裁顺序

具体为什么是这个顺序：

- **讨论页必须在最前**：否则它会被当成课程页，去"找任务点 → 跳章节"，把讨论标签页搞乱
- **验证码必须早于一切**：页面被验证码挡住时，检测到的 DOM 全是验证码的，继续跑会得到一堆错误判断
- **`_checkSubmitConfirmDialog` 必须在 `_checkPopupQuiz` 前面**：提交确认弹窗长得就像弹窗题
  （都用 `layui-layer`），顺序反了就会去"答"一个确认框
- **`_handleDiscussionWait` / `_tryDiscussionTask` 必须早于视频处理**：
  讨论任务点打开新标签页期间主循环要暂停推进，不能和正在播放的视频抢进度

**改 `_runTick` 顺序 = 高风险操作。**

### 5.2 已存在的"互斥开关"（别在不理解的情况下删）

| 字段 | 作用 |
| --- | --- |
| `_tickRunning` | tick 重入锁 |
| `_quizInProgress` | 答题进行中，防并发答题 |
| `_captchaBusy` / `_captchaActive` | **`_captchaActive` 期间抑制 `_checkVideoStatus` 与 pause 自动恢复** —— 验证码会让视频暂停，守护去"抢回播放"会跟验证码打架 |
| `_rateProbing` / `_rateDetectBusy` | 倍速探测期间**跳过倍速守护**，否则守护会把探测设的倍速立刻压回去；`_trySeekToEnd` 也在探测期间主动让路 |
| `_stepSwitchPending` | 翻节进行中，防重复翻节 |
| `_discussionPosted` | 保证每个讨论页只发一次评论 |
| `_pauseResumePending` | pause 抢播的防抖，避免"暂停↔恢复"无限战斗 |
| `_quizReadyToSubmit` / `_quizReadyWorkKey` | 表单填好待提交，避免重复走 LLM |
| `_activeMediaJobPending` / `_activeDocumentJobPending` | 阻断 `nextUnit`，等媒体/文档任务真正结束 |
| `_quizForceSkipUntil` / `_quizApiFailUntil` | **两个独立退避窗口**：前者是"解析失败，8 秒后重试"，后者是"API 不可用，45 秒后重试"。两者都 gate 答题，改一个记得看另一个 |
| `_discussionWindow` | 讨论标签页句柄；期间 `_handleDiscussionWait` 暂停推进 |

### 5.3 三个重载页面/清状态的地方会互相干扰

`_checkBlockedByCrossOrigin`（跨域卡住 → 刷新）、`_captchaReload`（验证码多次失败 → 刷新）、
`_refreshChapterAfterDiscussion`（讨论完成 → 刷新章节）都会重载或重建状态。
各自有冷却计时（180s / 计数器 / 讨论标记），**不要再加不相关的重载路径** ——
多个重载源叠加会变成"刷新风暴"，页面永远加载不完。

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

1. **`normalizeItem` 必须把数组归到"位置式"那一类**。数组的 `typeof` 是 `object`，
   若被当成 `{a:…}` 包装对象解析，**多选题答案会被整条丢掉**。这是这段代码最容易改错的地方。
2. **长度不符不会误提交**。`content.js` 记 `llm answer count mismatch` 日志后按位置尽力对齐；
   没对上的题保持未填 → `_areQuizAnswersFilled` 为假 → 不提交 → 下一轮 tick 重试。
   属于可自愈的降级，**不要改成"猜一个补上"**。
3. **分批大小牵动 token，别随手改小**。system 与格式示例是每批重发的固定开销（约 88 token/批），
   题目正文只发一次。改 `CHUNK_SIZE` 前先看 `npm run bench` 的对比数字。

旧协议（`{"i":n,"a":…}` 与 `{"index":…,"answer":…}`）仍然兼容 —— 保留它是为了让
用户自定义 `systemPrompt`、或模型自作主张换格式时不至于解析失败。

### 5.6 答案形态要按题型规整

`content.js` 的 `coerceAnswerForType` 处理位置式输出的常见偏差：
单选收到 `["A"]` 解包成 `"A"`、判断题收到 `"正确"`/`"T"` 归一成 `true`。
**多选数组必须原样保留，不能被解包。**

不做这层规整的后果：形态不对 → `_matchOptionItem` 匹配不上 → 该题静默不填 →
表单不满 → 永不提交。属于"看起来像模型没答对、实际是协议没对上"的坑。

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
  它和"字段缺失"是两件事。漏掉 ③ 就会去"完成"一个不需要完成的任务点，白耗时间。
  判据来自开源实现 `cxmooc-tools` 的 `CxTask`：
  `if (taskinfo.job) { done = false } else { done = true }`（没有 job 标记就当作已完成）。
- **④ 只列"确定是任务点"的模块**，不要把 `insertimage` 加进来 —— 图片大多是正文内容，
  推断成任务点会让插件去"处理"一堆纯展示图片。真正带 `job:true` 的图片任务点由
  `_buildAttachmentOnlyJob` 处理。

同一判据在 `_buildAttachmentOnlyJob` 与 `_classifyTaskFrame`（帧数据里的 `"job":false`）
都要挡一道。

### 5.8 "做不完就放弃"机制：三条铁律

`taskGiveUpAttempts`（默认 4）控制"连续几次卡住就放弃"。配套规则：

1. **`_isJobCompleted` 拿不准时必须返回 `true`**（当作已完成）。
   它的返回值会喂给放弃计数，误判成"没完成"会把**必做任务点**跳过 —— 比多跑一次严重得多。
2. **只有"两次进度快照完全一致"才算卡住**（`_taskProgressSnapshot`）。
   长视频一次本来就跑不完，若按"没完成"计数，必做任务点会被误跳过。
   探测不到进度（快照为空）时**一律不计**。
   快照只对"有媒体"或"确实可滚动"的文档有意义 —— 否则不可滚动的页面会给出恒定的
   `scroll:0`，把"测不到"误当成"没进展"。
3. **放弃名单必须能被用户清掉**（`xxtAI.clearTaskGiveUp()`，24 小时 TTL）。
   静默地永久跳过用户的任务点不可接受；跳过时必须留日志说明"为什么"和"怎么恢复"。

### 5.9 讨论任务点：四个容易踩的点

1. **`#isFinished` 必须按卡片范围查找**，不能 `doc.getElementById` ——
   同一文档多张卡片会共用同一个"已完成"标志，导致批量漏做或反复重开同一个。
2. **向上找标志时必须先数卡片数量再读**。顺序反了就会在"多卡片共用容器"上读到共用值，
   原 bug 原样复发。
3. **去重键必须用 `mtopicid`**，不能用 `url.slice(-70)` —— 短 URL 相同就碰撞，
   第二个任务被 `_isDiscussionDone` 判成"24 小时内已处理"而永久漏做。
4. **`_markDiscussionDone` 是先于打开动作写的**（防止重复打开）。
   若一个入口都没打开成功，必须 `_unmarkDiscussionDone` 撤回 ——
   否则这个任务点被静默跳过 24 小时，日志里毫无线索。

---

## 6. ⚠️ 易错点清单（每条都真实踩过）

按"症状 → 根因 → 现在怎么防"整理，越靠前越贵。

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
| 10 | 多讨论任务点整批漏做 / 反复重开同一个 | `doc.getElementById('isFinished')` 让同文档的卡片共用"已完成"标志 | 按卡片范围查找，且**先数卡片再读标志** |
| 11 | 多讨论任务点第二个永远不做 | 去重键用 `url.slice(-70)`，短 URL 相同就碰撞 | 用 `mtopicid` 作键，取不到退回整站 URL 的哈希 |
| 12 | 不需要完成的任务点被白做一遍 | `job: false` 落到"按模块名推断"分支又变回 `job` | §5.7 的 ③ 必须排在 ④ 之前 |
| 13 | 已通过的任务点被重做一遍 | `isPassed` 排在 `job` 之后，返回 `'job'` 导致调用点直接开跑 | §5.7 的 ① 必须排在 ② 之前 |
| 14 | 多选题答案整条丢失 | 位置式数组 `["A","C"]` 的 `typeof` 是 `object`，被当成 `{a:…}` 包装对象解析 | `normalizeItem` 里 `Array.isArray(item)` 归到位置式那一类 |
| 15 | 必做任务点被静默跳过 | 按"没完成"计数放弃，而长视频一次本来就跑不完 | 只有"两次进度快照完全一致"才算卡住；`_isJobCompleted` 拿不准返回 `true` |
| 16 | 改了开关不生效 | `postMessage` 漏了 `source` 字段被过滤器丢弃；或只重载扩展没刷新页面 | 见 §4.1；改完必须 F5 |
| 17 | 某个开关"存了但读不到" | 新增配置项只加了 `DEFAULT_CONFIG`，没加消费点 / content / popup | 按 [§9](#9-新增配置项的完整清单) 逐处补齐 |
| 18 | 抽了公共模块后功能全挂，报 `Cannot read properties of null` | 忘了把新 lib 加进 `manifest.content_scripts` 或 popup.html | `npm run check` 会校验注入清单；`content.js` 有 `missingModuleError()` 给出可操作提示 |
| 19 | 提示词/地址构造行为不一致（弹窗测试通过、页面失败） | 同一段逻辑被复制成两份并各自演化 | `libs/prompt.js` 与 `libs/api-url.js` 是唯一真源，`npm run check` 强制 |
| 20 | 任务点被判 `not-job` 直接漏掉 | 扩展名正则写成 `\.(ppt\|mp4)$`，而真实 `property.type` 是 `"ppt"` 不带点 | 正则改成 `(?:^\|\.)(?:ppt\|…)$` |
| 21 | manifest 无法解析，报错里有个看不见的字符 | 编辑器写回了 UTF-8 BOM | `npm run check` 检测 + `node tools/fix-bom.js --write` |
| 22 | 选项文本剥不掉"选项"前缀 | GBK 乱码残留（`选项` 被写成 `閫夐」`） | `npm run check` 的编码损坏探测（只查非注释行） |
| 23 | 版本号在扩展详情/浮窗里对不上 | 版本号有三处（manifest / popup.html / content.js 品牌位），漏改一处 | `npm run check` 强制三处一致 |
| 24 | 改了半天没生效，回头发现改动被覆盖 | **并行编辑同一个文件会互相覆盖**（工具都报成功，只有最后一个生效）；本项目还有过外部编辑器用旧快照覆盖文件的历史 | 改同一文件多处必须**串行**，每次改完 grep 回读；批量改动用 `git diff` 复核 |
| 25 | 连跑两次测试，第二次"所有注入都失败" | 上一次的 Edge 被杀后调试端口未及时释放，新实例连到了正在退出的旧实例 | 收尾与启动前都会等端口释放（12 秒超时） |
| 26 | **章节卡住不动**，日志每 5 秒一轮 `study begin` + `quiz scan found 0 questions` | `_detectQuiz` 只看了章节标题：`if (title.indexOf('考试') !== -1) return true`，于是**名为「10.1 课程考试」的章节**（0 任务点、已完成）被判成"有测验"，`_isCurrentCompleted` 因此拒绝跳过 → 永久循环 | 判定必须有**证据**：标题命中之外，还要在 URL 链（`location.href` / 主 iframe src / 文档内所有 iframe src）里真的看到 `ananas/modules/work`、`exam/test`、`testpaper` 等作业/考试页特征 |
| 27 | **AI 完全不听题**，但密钥是填了的 | API 表单只有点「保存 API」按钮才落地，且 `apiType` 下拉**根本没有 change 监听** → 切了接入方式却不重填就没保存 → `apiKey` 为空 → `enableQuiz` 硬守卫跳过全部答题（症状是"读不到题"，很像扫描失败） | 输入类字段 800ms 防抖自动保存 + `apiType` 监听，并有 toast 提示 |
| 28 | 用 DeepSeek 时每道题先烧 ~200 个推理 token | DeepSeek V4 默认开启思考模式，而答题是纯模式化任务 | 请求体加 `thinking:{type:'disabled'}`（**只对 DeepSeek 加**，其他 OpenAI 兼容服务会对未知参数报 400）。实测 2 题从 361 → 133 token |
| 29 | 有一道题被**猜错**，然后整卷重答一遍 | 模型偶尔返回空答案，旧实现走 `_avoidKnownWrongAnswer` 的空答案兜底 —— 直接猜第一个选项。判断题猜错概率 50%，猜错就触发"整卷带 `禁:` 前缀重答" | **空答案补问**：一轮跑完还有题没收答案时，把这些题打包成一次小请求重问（`llm refill unanswered`），把"猜"换成"问" |
| 30 | `npm run e2e` **全线失败**：14 个场景都报「page.js 在真实 Edge 中加载成功：失败」，页面里却一条异常都没有 | 测试脚本按 `SHA256(目录路径)` 猜扩展 ID，而**路径大小写敏感**：`D:\Omite` → `hdlemlcmf…`（真），`d:\Omite` → `locncobd…`（假）。从 Git Bash 风格 cwd 启动 node，`__dirname` 的盘符变小写，ID 就错开了 —— 扩展其实加载得好好的，是测试自己拿着错 ID 去注入 | 改为**运行时发现**真实 ID（content script 的 `Runtime.executionContextCreated` → `origin`），路径哈希降级为兜底；发现不一致时会打印一行警告。详见 [AGENTS §7.2](AGENTS.md) |
| 31 | **视频里弹出题后 AI 一直在扫描、但从不填空，课程永久空转** | 四层叠加：① 弹题请求**没有任何去重**，tick 每 250ms 一轮就重问一次模型；② `_matchOptionItem` 只在选项带 `.num_option` 徽标时才知道字母，原生 `li + input[value="A"]` 结构的字母恒为空 → 模型答裸字母 "A" 时一个都匹配不上；③ `_getOptionItems` 遇到无 `Zy_/Cy_`、无 `label` 的结构直接返回 `[]`；④ 题型靠**题干关键字**猜（含"正确"就判成判断题），"下列说法正确的是？"这类单选被误判。而弹窗分支在 `_runTick` 最前面 `return`、`_handleVideoPause` 又规定"有弹窗不恢复播放" → 死锁 | ① 新增 `_inferOptionLetter`（徽标 → 属性 → `input.value` → 文本前缀 → 位置兜底）；② `_getOptionItems` 补原生结构兜底（只取最内层）；③ 新增 `_detectPopupQuizType`（控件优先 + 判断题需选项为"正确/错误"这类对立表述）；④ 新增 `_activePopupBlock()`（含放弃窗口与已答放行），`_runTick`/`_handleVideoPause` 全走它；⑤ 同一弹题最多问 3 次后 `_giveUpPopupQuiz`（日志带 DOM 快照 → 点跳过 → 60s 冷却）；⑥ `_fillPopupAnswer` 没选中就不点提交 |

---

## 7. 调试手册：症状 → 病因 → 查哪里

| 症状 | 先查 |
| --- | --- |
| AI 一直读不到题 | 三条线索依次排除：① 日志有没有 `quiz scan found 0 questions`（扫描失败，转 `xxtAI.diagnose()`）；② `enableQuiz` 是否被硬守卫跳过 —— 见 §6 #27（**表单没保存**是最常被忽略的原因）；③ 是否卡在某个标题含「作业/考试」的章节不动 —— 见 §6 #26 |
| **视频里弹出题后一直空转**（AI 在扫描但不填空） | 见 §6 #31。先跑 `xxtAI.diagnosePopup()` 看弹窗结构/选项/推断字母；日志里找 `popup quiz answer matched no option`（匹配失败）与 `popup quiz unanswerable, stop asking model`（已放弃） |
| 答案填了不提交 | `_areQuizAnswersFilled` 的判定；隐藏域 `#answer{qid}` 是否被写入 |
| 答题报「API 不可用」但弹窗测试是通的 | 区分网络失败与 `parseError`（后者**不该**写 `apiConnectionFailed`，否则会陷入"跳过 → 不再请求 → 标志无法自愈"的死循环） |
| 验证码识别出来是空 | `captchaModel` 必须填视觉模型；留空会回退主模型，日志里会看到 `empty captcha result` |
| 某个任务点一直做不完 / 一直在耗时间 | `xxtAI.taskGiveUpList()`；日志里 `task point stuck` / `task point given up` |
| 讨论任务点没做 / 重复发评论 | 日志 `discussion task opened in new tab`、`discussion page detected, posting reply`、`discussion task has no usable entry` |
| 日志停在某一条 | §6 的 #1 #2；搜 `tick watchdog` |
| 窗口最小化后几乎不动 | 后台节流四层防线（Worker 心跳 / 音频保活 / `pause` 事件直接恢复 / 回前台重校验）。若仍停滞，检查 `edge://settings/system` 是否开了「睡眠标签页」——那是整页冻结，插件侧无法绕过 |
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
| 任务点类型识别（视频/音频/文档/图片/测验/投票） | `page.js`：`_classifyTaskFrame` / `_getAttachmentWorkType` / `_buildAttachmentOnlyJob` |
| 做不完的任务点跳过 | `page.js`：`_taskProgressSnapshot` / `_countTaskIncomplete` / `_isJobCompleted` |
| 题目抠取 | `page.js`：`_questionSelectors` / `_collectQuestionContainers` / `_parseQuestionElement` / `_getOptionItems` |
| 答题与提交 | `page.js`：`_handleQuiz` / `_fillAnswers` / `_areQuizAnswersFilled` / `_maybeSubmitQuiz` |
| 答案缓存（交卷后记答案） | `page.js`：`_rememberCorrectQuizAnswers` / `_isQuizQuestionMarkedCorrect` / `_extractDisplayedCorrectAnswer` |
| 视频、倍速、seek | `page.js`：`_playChaoxingMediaJob` / `_ensurePlaybackRate` / `_trySeekToEnd` |
| 验证码 | `page.js`：`_checkCaptchaDialog` / `_handleCaptchaDialog` / `_runStandaloneCaptchaMode` |
| 讨论任务点 | `page.js`：`_collectDiscussionTargets` / `_findDiscussionTask` / `_tryDiscussionTask` / `_runDiscussionMode` |
| 任务点调度 | `page.js`：`_runTick` / `_runOcsStyleStudy` / `_ensureOcsStudyRunner` / `_searchChaoxingJobOcs` |
| 设置界面 | `popup/popup.js` + `popup/popup.html`（**记得同步 `page.js` 的 `DEFAULT_CONFIG`**） |

需要方法清单时：

```bash
grep -nE '^    _?[A-Za-z][A-Za-z0-9_]*: (async )?function' page.js
```

---

## 9. 新增配置项的完整清单

缺任何一处都会出现"开关存了但读不到"。照抄 `enableDiscussion` 或 `enableCaptcha`：

- [ ] `page.js` → `DEFAULT_CONFIG`
- [ ] `page.js` → 消费点（**要加开关硬守卫**，如 `if (!this.configs.enableXxx) return;`）
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
npm run check    # 工程自检：语法 / manifest / 版本一致性 / 编码损坏 / 幽灵调用 / 死方法 / 死代码 / 唯一真源
npm run bench    # 提示词 token 基准（三代对比 + 信息完整性自检）
npm run itest    # 集成测试：真实 content.js 的答题往返（41 项）
npm test         # 上面三个
npm run e2e      # 真实 Edge 功能交叉检验（135 项）
npm run test:all # npm test + e2e
npm run build    # 打包到 dist/
npm run audit:publish  # 发布前审查：扫描密钥 / 本机路径 / 邮箱 / 大文件是否误入公开仓库
```

全部零依赖，只用 Node 内置模块。`npm run e2e` 需要本机装有 Edge
（路径可用 `OMITONE_EDGE` 覆盖），细节与踩坑记录见 [`tools/README.md`](tools/README.md)。

### 三层测试的分工

| 层 | 手段 | 能测出什么 | 成本 |
| --- | --- | --- | --- |
| 静态自检 | `tools/check.js` | 语法、版本一致性、**幽灵调用**、死方法、编码损坏、唯一真源 | 秒级 |
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

### 压缩提示词的正确姿势

最大的风险是"把信息压掉"。改提示词时：

- `npm run bench` 会断言**题干与选项文本原样保留**
- `normalizeItem` 的 13 个用例必须全过（含位置式数组这一最易错项）
- 改完必须跑 `npm run e2e` —— 新的输出格式要在真实 Edge 里跑通 5 种题型的完整回填

---

## 12. 目录

```
manifest.json           MV3 清单
background.js           service worker：跨域 fetch 代理 + 抓图转 dataURL
content.js              隔离世界桥接：注入 page.js、转发消息、字体解密、状态浮窗
page.js                 页面上下文运行时（主体，约 7600 行 / 290 个方法）
libs/prompt.js          LLM 提示词唯一真源
libs/api-url.js         API 地址构造与密钥清洗唯一真源（content.js 与 popup 共用）
libs/md5.min.js, Typr*.js   字体解析与哈希
resources/table.json    字形哈希 → 真实字符 映射表（347KB）
popup/                  设置界面
tools/                  开发脚本（自检 / 基准 / 测试 / 打包）
legacy/                 已停用代码，不会被加载（原因见 legacy/README.md）
```

## 13. 边界

这个扩展操作用户的学习通账号数据。因此：

- **不要**代替用户输入账号、密码、验证码
- **不要**代替用户点击提交、发布内容（只读观察可以，代操作不行）
- **不要**把 `apiKey` 写进任何文件、日志或提交 —— 它只存在于 `chrome.storage.local`
- 探索浏览器时使用独立临时 profile，不碰用户的真实 profile 与 Cookies
- 跑 `npm run e2e` 会启动一个临时 Edge 实例并自动收尾；**不要**去操作用户正在使用的浏览器

## 许可

见 [LICENSE](LICENSE)。
