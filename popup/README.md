# Popup 吉祥物模块

吉祥物由 `pet.js` 与 `pet.css` 独立承载，`popup.html` 只保留角色 DOM、背景入口和脚本接线。

## 加载顺序

```text
../libs/api-url.js
../libs/thinking.js
popup.js
pet.js
```

这些脚本都在 `DOMContentLoaded` 之前同步加载。`pet.js` 只依赖弹窗页面已经提供的 DOM、`isUpdateMuted`、`toast` 与 `omitone:run` 事件，不参与刷课业务。

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
