# popup/ —— 设置界面（点扩展图标弹出来的那个）

| 文件 | 作用 |
| --- | --- |
| `popup.html` | 界面结构 |
| `popup.js` | 交互与保存。**各渠道的 API 地址与模型名（`PROVIDER_PRESETS`）就在这里**，是渠道信息的唯一真源 |

> 界面上每个开关对应哪个配置键 —— 见根目录 `README.md` §9「新增配置项的完整清单」。
>
> AI 渠道的**核对清单**（地址 / 模型名 / 思考参数 / 怎么重核）在
> [`docs/channels.md`](../docs/channels.md)，改 `PROVIDER_PRESETS` 时顺手同步那一份。
