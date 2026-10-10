# icons/ —— 扩展图标（三个尺寸）

| 文件 | 用在哪 |
| --- | --- |
| `icon-16.png` | 地址栏、扩展管理页的小图标 |
| `icon-48.png` | 扩展管理页 |
| `icon-128.png` | 安装时、商店页面 |

三个都由 `manifest.json` 的 `icons` 与 `action.default_icon` 引用。
`npm run check` 会校验「19 个 manifest 引用文件全部存在」—— 少一个就红。

换图标：**同名同尺寸覆盖即可**，不用改任何代码。
