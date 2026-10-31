# Popup 设置、日志视图与吉祥物模块

吉祥物由 `pet.js` 与 `pet.css` 独立承载，`popup.html` 只保留角色 DOM、背景入口和脚本接线。

## 加载顺序

```text
../libs/api-url.js
../libs/thinking.js
../libs/runtime-policy.js
../popup-log-view.js
popup.js
pet.js
```

这些脚本都在 `DOMContentLoaded` 之前同步加载。`pet.js` 只依赖弹窗页面已经提供的 DOM、`isUpdateMuted`、`toast` 与 `omitone:run` 事件，不参与刷课业务。

## 日志视图

根目录 `popup-log-view.js` 只由扩展弹窗加载，不注入学习页面。宿主 `popup.js` 提供 DOM、
日志读取、Worker 清空请求、剪贴板、通知、版本、时钟与计时器能力；模块不直接访问 `chrome.*`。

- 面板节点为 `#logPanel`，按钮为 `#toggleLogs` / `#copyLogs` / `#clearLogs`。
- 日志正文、详情与错误一律通过文本节点显示；级别样式走白名单，不解释日志里的 HTML。
- 每次读取结束后 1500ms 才预约下次刷新；关闭/销毁作废读取代号并取消等待，旧结果不回填。
- 读取与剪贴板有 5 秒期限，清空有 20 秒期限；剪贴板拒绝时显示可手动选中的日志。
- pagehide 调用 `dispose()` 释放模块自己的定时器与等待；不影响设置或角色的独立生命周期。
- `buildLogsText(logs, version)` 在宿主保留兼容转发，格式仍为纯文本、旧记录在前。

`npm run popup-log:test` 运行模块测试及 LF/CRLF 负控；它已加入统一沙盒与可靠产物验收的基线。
浏览器专项使用真实视图与按钮，延迟读取/剪贴板拒绝在独立测试页受控模拟，不写用户剪贴板。

## DOM 契约

角色区域使用以下固定节点：

- `#mascot`、`.pet-inner`、`.pet-art`
- `#mascotBubble`、`#petMood`
- `#petTools`、`#petBook`、`#petBookBody`、`#petBookClose`
- `#btnPetShow`、`#checkUpdate`

沉浸式窗口通过 `?play=1` 和 `body.im` 定位角色；角色实际挂在 `body > #mascot`，立绘册在角色外部，避免 fixed 定位受 transform 影响。

## 本地状态

角色只使用下列 localStorage 键：

- `omitone.pet.pos`：拖动后的坐标
- `omitone.pet.src`、`omitone.pet.outfit`、`omitone.pet.face`：当前立绘与索引
- `omitone.pet.mood`：0–100 心情值
- `omitone.pet.hidden`：用户主动隐藏
- `omitone.pet.night`：深夜台词冷却

`omitone:run` 是单向通知：事件 detail 为布尔值，角色只更新展示状态，不反向改变运行状态。

## 修改边界

角色动作、季节特效、立绘册、拖拽、气泡、视线跟随与 yawn 改 `pet.js` / `pet.css`；设置表单和运行状态业务改 `popup.js`。不在 `popup.js` 重新实现角色逻辑。
日志格式化、文本渲染和开关/刷新/复制/清空状态改根目录 `popup-log-view.js`；真实存储与剪贴板接口留在 `popup.js`。不要把 Worker 权限判断搬入前端。
