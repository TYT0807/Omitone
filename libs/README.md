# libs/ —— 注入页面的库，以及四处「唯一真源」

| 文件 | 作用 |
| --- | --- |
| **`prompt.js`** | 提示词的**唯一真源**（`buildUserPrompt` / `normalizeItem`）。改提示词只改这里 |
| **`api-url.js`** | API 地址构造与**密钥清洗**的唯一真源（剥掉粘贴时带上的引号 / `Bearer `） |
| `font-table.js` | 字形哈希表（font-cxsecret 反爬映射）**紧凑二进制格式**的唯一真源；表本体在 [`resources/`](../resources/README.md) |
| `thinking.js` | 三档思考强度的参数拼装 —— 各渠道写法不同，差异全收在这里 |
| **`runtime-policy.js`** | **配置权限的唯一真源**：字段白名单 / 数值区间 / 按作用域投影（验证码页只给 `enableCaptcha`）/ patch 校验 / API 指纹 |
| `captcha.js` | 验证码 OCR 请求的构造与解析（提示词仍然只在 `prompt.js`，这里不复制一份） |
| `api-error.js` | AI 服务商报错的**分类器**（错误文案的唯一真源）：把 402 / 429 / 网络断开分成「没钱 / 限流 / 真连不上」，让人和 AI 都一眼定位下一步 —— 现场踩过"请求到了服务商却被说成连接失败，用户去重装插件" |
| `study-stats.js` | 刷课活跃时长统计（小游戏好感度的数据源）：**纯读侧**，只消费已经发生的 `runtime_log` 事件，绝不向调度 / 答题链路注入任何东西 |
| `diagnose.js` | 本地自愈「医生」的**判断层**：读运行日志环 → 规则判断 → 输出**有界**的结论与建议。三处共用同一份（弹窗「诊」/ 上课页她自己开口 / 集成测试在 Node 里 `require`），抄三份必然分叉。**只读** —— 不点任何东西、不改配置、不发请求，动手的按钮由界面层挂现有动作。⚠️ 每一条 needle 必须是代码里真发出去过的那句日志，机检是 `npm run check` 第 35 项（真源 [`tools/audit-diagnose-needles.js`](../tools/audit-diagnose-needles.js)） |
| `Typr.js` / `Typr.U.js` | 字体解析（OpenType / TrueType）：题库字体反爬要靠它把字形读出来 |
| `md5.min.js` | MD5，`content.js` 算字形指纹时用 |

> `prompt.js` 与 `api-url.js` 受 `npm run check` 的**「唯一真源检查」**保护 ——
> 别在 `content.js` / `popup.js` 里再写一份同样的逻辑（历史上有过三份分叉，已合并）。
>
> `Typr.*` 与 `md5.min.js` 是**原样引入**的第三方库，不要在里头改逻辑；
> 要包装就在调用方做。
