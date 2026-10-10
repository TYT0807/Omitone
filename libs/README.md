# libs/ —— 注入页面的库，以及三处「唯一真源」

| 文件 | 作用 |
| --- | --- |
| **`prompt.js`** | 提示词的**唯一真源**（`buildUserPrompt` / `normalizeItem`）。改提示词只改这里 |
| **`api-url.js`** | API 地址构造与**密钥清洗**的唯一真源（剥掉粘贴时带上的引号 / `Bearer `） |
| `font-table.js` | 字形哈希表（font-cxsecret 反爬映射）**紧凑二进制格式**的唯一真源；表本体在 [`resources/`](../resources/README.md) |
| `thinking.js` | 三档思考强度的参数拼装 —— 各渠道写法不同，差异全收在这里 |
| `Typr.js` / `Typr.U.js` | 字体解析（OpenType / TrueType）：题库字体反爬要靠它把字形读出来 |
| `md5.min.js` | MD5，`content.js` 算字形指纹时用 |

> `prompt.js` 与 `api-url.js` 受 `npm run check` 的**「唯一真源检查」**保护 ——
> 别在 `content.js` / `popup.js` 里再写一份同样的逻辑（历史上有过三份分叉，已合并）。
>
> `Typr.*` 与 `md5.min.js` 是**原样引入**的第三方库，不要在里头改逻辑；
> 要包装就在调用方做。
