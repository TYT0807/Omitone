# legacy/ — 已停用代码

这里的文件**不会被扩展加载**，留档仅为了在需要时能找回实现思路。
打包发布（`npm run build`）会排除整个 `legacy/` 目录。

---

## background-core.js

- **来源**：2025-06-07 的早期版本，比当前 `background.js` 更完整的一版 service worker。
- **为何停用**：它从未被任何东西加载。设计意图是让 `background.js` 用
  `importScripts('background-core.js')` 懒加载，但后来 `background.js` 被改写成一个
  114 行的极简实现（注释里明确写着 "no imports, no startup storage/tabs work"），
  `importScripts` 那一步始终没有落地，于是这个文件成了纯死代码。
- **为什么不能直接接回去**：
  1. 它调用 `chrome.alarms.create(...)`，而 `manifest.json` 没有 `"alarms"` 权限，
     接回去会立刻报权限错误。
  2. 它包含**第三份** LLM 调用实现（`buildSystemPrompt` / `buildQuestionsText` /
     `buildOutputFormat` / `callOpenAICompatibleAPI` / `callClaudeAPI` / `callGeminiAPI`）。
     当前真正生效的路径是 `content.js → api_fetch(background.js) → 模型接口`，
     提示词唯一真源已收敛到 `libs/prompt.js`。把这份旧的再挂上去只会制造第四份分叉。
- **仍可能有用的部分**：`handleLLMRequestDirect` 之外的 `checkForUpdate()` /
  `ensureBackgroundJobs()` 远程更新逻辑，目前 `background.js` 里只留了一个
  `{ success: true, skipped: true }` 的占位实现。如果以后要做自动更新，从这里抄思路。
- **恢复方式**：`git log --oneline` 找到基线提交，或直接 `git show <commit>:background-core.js`。
