# src/ —— 页面主世界（page context）的源码

这个目录只放**在页面主世界里跑的那份代码**：

| 目录 | 是什么 | 怎么改 |
| --- | --- | --- |
| [`page/`](page/README.md) | `page.js` 的**源文件** —— 16 个按域片段 | **改代码改这里**，然后 `npm run concat` |

> ⚠️ 根目录的 `page.js` 是上面这些片段**拼出来的构建产物**，扩展真正加载的是它。
> **别直接改它** —— 改完立刻测是通的，下次有人跑一次拼接就全丢了。
> `npm test` 里那条「`page.js` 与 `src/page/` 一致」就是拦这件事的。

另外三份源码**不在这个目录里**，别找错地方：

| 跑在哪 | 文件 |
| --- | --- |
| 扩展的隔离世界（`chrome.*` API 都在这里） | 根目录 [`content.js`](../content.js) |
| 后台 service worker（只转发网络请求） | 根目录 [`background.js`](../background.js) |
| 设置界面 / 第三方库 | [`popup/`](../popup/README.md) · [`libs/`](../libs/README.md) |
