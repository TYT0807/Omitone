# AI 渠道核对清单

这份文件是**给以后的人（包括 AI）看的**：AI 服务商的地址、模型名、思考参数变化很快，
写死在代码里的快照**一定会过期**。过期本身不致命，致命的是"过期了没人知道"。

**最后核对日期：2026-10-22**（发布后按官方文档复核了一遍）

---

## 0. 2026-10-22 复核（只记"和上次不一样"的地方）

- 三家官方文档都还能打开：DeepSeek `/quick_start/pricing`、Kimi 快速开始、阿里云百炼「文本生成」。
- **型号未变**：`deepseek-flash`（V4.1 Flash，V4-Pro 仍在）、`kimi-k3`（旗舰，1M、视觉、`reasoning_effort` low/high/max，默认 max）、`qwen3.8-flash`（1M，支持思考）。
- **改了一处参数**：通义**主模型**的思考强度用 `thinking_budget`（1–32768，默认 4000），
  **不是** `reasoning_effort`（那个只在 Qwen3.8 **Omni** 系列出现）。
  `libs/thinking.js` 已从 `reasoning_effort: low|xhigh` 改成 `thinking_budget: 1024 | 16384`。

---

## 0.1 2026-10-19 核对结论（历史）

- **当前 DeepSeek 的 API 模型名是 `deepseek-flash`（= V4.1 Flash，2026-09-10 发布）。**
  552B MoE、**原生多模态**（文字和图片同一个模型）、1M 上下文。
  ⇒ 默认模型已改成 `deepseek-flash`；**看图题不再需要单独配一家**，留空即用主模型。
- **`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已下线** —— 旧名只是兼容路由
  （还能用、按 Flash 计费），但**新配置别再写它们**。
- `deepseek-chat` / `deepseek-reasoner` 早在 2026-07-24 就停了；`deepseek-v4-pro`
  仍是独立可用的 Pro 档（官方一度宣布下线，后来又保留了）。
- 思考模式：V4 系列**默认开**，要关必须显式发 `thinking:{type:"disabled"}`（本项目一直这么发）。
- `kimi-k3` 仍是 Kimi 旗舰（1M 上下文、恒思考，`reasoning_effort` 三档）；
  通义 `qwen3.8-flash` 仍是当前快照型号。两者**都没实测过**，结论不变。

---

## 1. 现在代码里用的是哪几家

唯一真源是 [`libs/thinking.js`](../libs/thinking.js)（思考参数）与
[`popup/popup.js`](../popup/popup.js) 的 `PROVIDER_PRESETS`（地址与模型名）。
下表只是**便于阅读的副本**，两边不一致时以代码为准。

| 渠道 | 协议 | base_url | 模型名（快照） | 思考参数 | 实测 |
| --- | --- | --- | --- | --- | --- |
| **DeepSeek** | OpenAI 兼容 | `https://api.deepseek.com` | `deepseek-flash`（= V4.1 Flash，**含看图**）/ `deepseek-v4-pro` | `thinking:{type:enabled\|disabled}`（默认 enabled）+ `reasoning_effort: low\|high\|max` | ✅ **关闭档实测通过** |
| Kimi / Moonshot | OpenAI 兼容 | `https://api.moonshot.ai/v1`（国内站 `.cn`） | `kimi-k3` | `reasoning_effort: low\|high\|max`；**K3 恒思考，关不掉** | ❌ 未实测 |
| 通义千问 / DashScope | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-flash` | `enable_thinking: true\|false` + `thinking_budget: 1..32768`（本项目低=1024 / 高=16384） | ❌ 未实测 |
| Claude | Anthropic | `https://api.anthropic.com` | 自己填 | 本项目的三档思考开关**不作用于它** | ❌ 未实测 |
| Gemini | Google | `https://generativelanguage.googleapis.com` | 自己填 | 同上 | ❌ 未实测 |
| 其他 / 自定义 | OpenAI 兼容 | 自己填 | 自己填 | 认不出的渠道：**关闭档一个参数都不发**；低/高才发通用 `reasoning_effort` | — |

官方文档入口（核对时从这里开始，别从第三方博客开始）：

- DeepSeek 思考模式：<https://api-docs.deepseek.com/guides/thinking_mode/>
- DeepSeek API 总览：<https://api-docs.deepseek.com/zh-cn/>
- Kimi 开放平台：<https://platform.moonshot.cn/docs>
- 阿里云百炼（DashScope）OpenAI 兼容：<https://help.aliyun.com/zh/model-studio/>

---

## 2. 怎么核对"这一家还活着"

最快的办法是**发一条最小请求**，看它是 200 还是报"模型不存在"：

```bash
# DeepSeek
curl -s https://api.deepseek.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'

# Kimi
curl -s https://api.moonshot.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"kimi-k3","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'

# 通义（注意地址里必须带 /compatible-mode/v1）
curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

看返回里的 `error.code`：

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| `200` + 正常补全 | 这家还能用 | 只更新本文件的日期 |
| `model_not_found` / `invalid model` | **模型名过期了** | 去官方模型列表抄新名字，改 `popup.js` 的 `PROVIDER_PRESETS` 与本文件 |
| `401` / `invalid api key` | 密钥问题，不是渠道问题 | 让用户重新生成密钥 |
| `400` 提到某个参数不认识 | **参数过期了** | 改 `libs/thinking.js` 里那一家的 `params` |
| 连接超时 / DNS 失败 | 网络或 base_url 变了 | 核对官方文档的 base_url |

> 本项目里"参数不被支持"还有一层兜底：`content.js` 收到 400 且错误里提到思考参数时，
> **会自动摘掉参数重试一次**并写日志（`llm rejected thinking params, retry without them`）。
> 所以参数过期不会让答题功能彻底死掉，但日志里会留下痕迹 —— 核对时先去看日志。

---

## 3. 更新时要改哪几个地方

一次渠道更新通常只动两处，但**必须同时改**，否则弹出界面显示的和实际发出去的不一致：

1. `libs/thinking.js` —— 思考参数（`PROVIDERS` 表里的 `params`）、是否需要改 `verifiedLevels`
2. `popup/popup.js` 的 `PROVIDER_PRESETS` —— base_url 与模型名
3. `docs/manual.html` —— 面向用户的渠道对照表（要重跑 `npm run manual` 出 PDF）
4. 本文件的表格与**最后核对日期**
5. README 的「支持的 AI 渠道」一节

改完跑：

```bash
npm test        # 含「思考参数按渠道白名单发参数」的集成断言
npm run e2e     # 真实 Edge，含多选题等场景
```

---

## 4. 已知坑（都是真踩过的）

1. **通义千问的地址必须带 `/compatible-mode/v1`**。少这一段会 404，
   而报错内容看起来像"密钥无效"，很容易误判成用户填错了 Key。
2. **Kimi K3 是恒思考模型**，没有"关闭"这一档。程序不会报错，但也不会真的关掉 ——
   `libs/thinking.js` 里 `canDisable: false` 就是记这件事，UI 上会明说。
3. **通义商业版默认关思考、开源版默认开**。所以"关闭"档要**显式**发
   `enable_thinking: false` 才稳；不发明细的话，同一份配置在两种模型上行为不同。
4. **DeepSeek 的 `deepseek-chat` / `deepseek-reasoner` 已在 2026-07-24 退役**。
   老配置里如果还写着这两个名字，会直接 404 —— 换成 `deepseek-flash` 即可。
   （2026-09-10 起 V4 Flash 也下线了，`deepseek-v4-flash` 现在只是兼容路由。）
5. **别给不认识的渠道发思考参数**。各家对未知字段的反应不一致：有的忽略、
   有的直接 400。所以 `unknown` 那一家在"关闭"档是**一个参数都不发**的 ——
   这也正是 1.1.5 之前的行为，保持它就不会把任何现有用户搞挂。
6. **测过的才算测过**。表格里"实测"那一列只有 DeepSeek 的"关闭"档为真：
   那是本项目一直以来的线上行为。其余都是照官方文档填的，
   **没有在真实题库里跑过**，所以 UI 上必须继续标"未实测"，不许美化。
