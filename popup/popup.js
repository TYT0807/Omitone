const DEFAULTS = {
  autoMaxPlaybackRate: true,
  // auto=按实测帧率自适应；on=强制 2 倍（弹窗开关打开时写入）
  slowMachineMode: "auto",
  playbackRateCap: 4,
  taskGiveUpAttempts: 4,
  enableMedia: true,
  enablePPT: true,
  enableHyperlink: true,
  blockedReload: true,
  autoNext: true,
  autoNextCourse: true,
  enableQuiz: true,
  randomAnswer: false,
  // 乱选填满整卷后、自动交卷前留给用户检查的秒数（0 = 不自动交卷）
  randomAnswerReviewSec: 30,
  enableCaptcha: true,
  enableDiscussion: true,
  enableVote: true,
  // API 连接状态行展示用：失败原因（分类后人话，libs/api-error.js 写入）
  apiConnectionError: "",
  discussionReply: "1",
  systemPrompt: "",
  restudy: false,
  providerPreset: "deepseek",
  apiType: "openai",
  apiUrl: "https://api.deepseek.com",
  apiKey: "",
  apiConnectionFailed: false,
  model: "deepseek-flash",
  captchaModel: "",
  // 视觉（题目配图）：默认全关。图片计费远高于文本，不能替用户默认花钱。
  visionEnabled: false,
  visionModel: "",
  visionBudgetPerChapter: 30,
  // 思考强度：参数映射与区间解析的唯一真源是 libs/thinking.js。
  // 三个场景各一格 `'min-max'`（下限 / 上限），上下限相等 = 固定档。
  // ⚠️ 出厂值必须是 `''`（"这一格从没写过"），和 content.js 一样 —— 理由不是风格：
  // load() 里 `config = {...DEFAULTS, ...存储}` 让这里写 anything 非空都**恒等于写过**，
  // `rangeForTier` 就永远走不到"由老键推导"那一支。存量用户把全局档调到"高"、
  // 存储里只有 thinkingLevel:'high' 而没有新键，弹窗会被这份默认值渲染成"关闭"，
  // 他动任何一个开关触发保存就把 off-off 写回盘 —— 症状是"答案变差了但一句报错都没有"。
  // 「恢复默认仍回到最省那一格」不靠这里：DEFAULTS 里 thinkingLevel:'off' 已经接管。
  thinkingRangeCourse: "",
  thinkingRangeQuiz: "",
  thinkingRangeExam: "",
  // 改造前的两个老键：新键一旦写过就不再看它们，但「恢复默认」仍要把它们按回出厂值，
  // 否则存量的 thinkingLevel:'high' 会让"恢复默认后再清掉新键"这条路回到旧档。
  thinkingLevel: "off",
  thinkingPaperLevel: ""
};

const RUNTIME_LOGS_KEY = "runtimeLogs";

// 服务商预设。
//
// ⚠️ 这里只放**真的在真实答题链路上跑通过**的，其余一律不预置 ——
// 曾经内置过 9 家（MiniMax / 通义 / 智谱 / Kimi / OpenRouter / SiliconFlow …），
// 全是"按官方文档配好但没实测"，模型名还是钉死的快照，厂商一发新版就失效，
// 用户照着填完发现用不了，反而比留空白更坑。
//
// 现在保留 DeepSeek（真实章节测验里完整验证过：抠题 → 作答 → 回填 → 交卷 → 记分），
// 并按用户要求补上 Kimi 与通义千问 —— 这两家的**地址与模型名是照 2026-09 的官方文档
// 填的快照，没有实测过**，所以标签里明写"未实测"。厂商改版后这里会过期：
// 过期了照样能用，只要用户把「模型名」改成新名字（地址与协议通常不变）。
// 找不到的服务商请选「自定义 OpenAI 兼容」自己填，那两格填什么都能用。
// 渠道的核对方法与最后核对日期见 docs/channels.md。
const PROVIDER_PRESETS = {
  deepseek: { apiType: "openai", apiUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  // Kimi / Moonshot：国际站 .ai、国内站 .cn，两者协议相同
  kimi: { apiType: "openai", apiUrl: "https://api.moonshot.ai/v1", model: "kimi-k3" },
  // 通义千问 DashScope 的 OpenAI 兼容入口。⭐ 注意地址里带 /compatible-mode/v1，
  // 这是它和普通 /v1 不同的地方：填错会 404，看起来像"密钥无效"。
  qwen: { apiType: "openai", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-flash" },
  claude: { apiType: "claude", apiUrl: "https://api.anthropic.com", model: "" },
  gemini: { apiType: "gemini", apiUrl: "https://generativelanguage.googleapis.com", model: "" },
  "custom-openai": { apiType: "openai", apiUrl: "", model: "" }
};

const $ = (id) => document.getElementById(id);
const els = {
  autoMaxRate: $("autoMaxRate"),
  slowMachineMode: $("slowMachineMode"),
  enableMedia: $("enableMedia"),
  enablePPT: $("enablePPT"),
  enableHyperlink: $("enableHyperlink"),
  blockedReload: $("blockedReload"),
  autoNext: $("autoNext"),
  autoNextCourse: $("autoNextCourse"),
  enableQuiz: $("enableQuiz"),
  randomAnswer: $("randomAnswer"),
  randomAnswerReviewSec: $("randomAnswerReviewSec"),
  enableCaptcha: $("enableCaptcha"),
  enableDiscussion: $("enableDiscussion"),
  enableVote: $("enableVote"),
  discussionReply: $("discussionReply"),
  systemPrompt: $("systemPrompt"),
  restudy: $("restudy"),
  pagePetEnabled: $("pagePetEnabled"),
  petChatEnabled: $("petChatEnabled"),
  petDoctorEnabled: $("petDoctorEnabled"),
  petWebSearchEnabled: $("petWebSearchEnabled"),
  petWebSearchHint: $("petWebSearchHint"),
  providerPreset: $("providerPreset"),
  apiType: $("apiType"),
  apiUrl: $("apiUrl"),
  apiKey: $("apiKey"),
  model: $("model"),
  captchaModel: $("captchaModel"),
  visionEnabled: $("visionEnabled"),
  visionModel: $("visionModel"),
  visionBudgetPerChapter: $("visionBudgetPerChapter"),
  thinkingHint: $("thinkingHint"),
  // 三行上下限（思考强度）。id 由场景名拼出来，所以这里点名写死 ——
  // 少写一行不会报错，只会拿到 undefined 元素、下面注册监听时当场抛（这正是想要的：宁可启动就响）。
  thinkingMinCourse: $("thinkingMinCourse"),
  thinkingMaxCourse: $("thinkingMaxCourse"),
  thinkingMinQuiz: $("thinkingMinQuiz"),
  thinkingMaxQuiz: $("thinkingMaxQuiz"),
  thinkingMinExam: $("thinkingMinExam"),
  thinkingMaxExam: $("thinkingMaxExam"),
  reset: $("reset"),
  saveApi: $("saveApi"),
  testApi: $("testApi"),
  listModels: $("listModels"),
  modelListState: $("modelListState"),
  modelOptions: $("modelOptions"),
  updateRow: $("updateRow"),
  updateMsg: $("updateMsg"),
  checkUpdate: $("checkUpdate"),
  doUpdate: $("doUpdate"),
  doLater: $("doLater"),
  previewMsg: $("previewMsg"),
  doPreview: $("doPreview"),
  updateMute: $("updateMute"),
  doUntil: $("doUntil"),
  start: $("start"),
  stop: $("stop"),
  toggleLogs: $("toggleLogs"),
  copyLogs: $("copyLogs"),
  clearLogs: $("clearLogs"),
  logPanel: $("logPanel"),
  toast: $("toast"),
  runDot: $("runDot"),
  runState: $("runState")
};

let config = { ...DEFAULTS };
// 存储里**原样**那一份（没有 DEFAULTS 兜底）。指纹必须拿它算 —— 后台与 content.js
// 指纹的都是"盘上存的那份"（见 content.js loadConfig 的注释），弹窗这里原先用
// `{...DEFAULTS, ...存储}` 兜过底的 config 算指纹，于是同一个键在两侧读成两个值：
// thinkingLevel 从没写过时，存储侧读出 `""`、弹窗侧被 DEFAULTS 顶成 `"off"`，
// `config_patch` 的 expectedFingerprint 永远对不上 → 后台回 `stale_config` →
// 用户点「检测 API 连接」只看见「配置已变化，请重新检测」，连接结果一句不给。
// 批次 123-b 把 thinkingLevel 从表单里撤掉之后这条才暴露，不是那时才坏的。
let storedConfig = {};
let autoMaxRateVal = true;
let slowMachineVal = false;
let enableMediaVal = true;
let enablePPTVal = true;
let enableHyperlinkVal = true;
let blockedReloadVal = true;
let autoNextVal = true;
let autoNextCourseVal = true;
let enableQuizVal = true;
let randomAnswerVal = false;
let enableCaptchaVal = true;
// 视觉（看图）默认关：图片计费远高于文本，不能替用户默认花钱
let visionEnabledVal = false;
let enableDiscussionVal = true;
let enableVoteVal = true;
let restudyVal = false;
let apiTestGeneration = 0;
let runOperation = 0;
let shownRunState = null;

const POLICY = self.OmitonePolicy;

function apiFormFingerprint() {
  return POLICY.configFingerprint({ ...storedConfig, ...getApiFormConfig() });
}

/**
 * 把后台返回的失败码翻成「下一步该做什么」。
 *
 * 真实原因原先在 sendRuntimeMessageWithTimeout 里就已经取到了（后台脚本没起来时
 * 就是 "Could not establish connection. Receiving end does not exist."），
 * 但界面只留「配置保存失败」四个字 —— 线上 issue #1（macOS Chrome）因此读成
 * 「按钮点了没反应、设置一直存不上」，谁都不知道该去重载扩展。
 */
function saveFailureText(result) {
  const code = result && result.code;
  const raw = String((result && (result.error || result.field)) || "");
  if (code === "stale_config") return "配置已变化，请重新检测";
  // 超时和"接不上"是同一件事：后台脚本没在跑（未打包目录缺文件是最常见成因）
  if (/Could not establish connection|Receiving end does not exist|message port closed|background unavailable|超时/i.test(raw)) {
    return "后台脚本没响应 —— 到扩展页点「重新加载」，再回学习通页按 F5";
  }
  // 后台带回来的 `popup-deny:…` / `page-deny:…` 说清缺的是哪一样（frameId、tab.url 还是 URL）。
  // 光说「没认出这是设置弹窗」等于把诊断又推回给用户：2026-11-12 同学机器就是这么卡住的，
  // 而这台机器与作者那台的差别只在「弹窗是怎么打开的」，从界面上一字都读不出来。
  if (code === "forbidden_sender") {
    const why = raw && raw !== "forbidden_sender" ? "（" + raw.slice(0, 60) + "）" : "";
    return "保存被拒：没认出这是设置弹窗" + why + " —— 关掉它，从浏览器右上角的图标重新点开再试";
  }
  if (code === "forbidden_patch") return "保存被拒：这一项不允许从这里改";
  if (code === "invalid_patch") return "保存被拒：" + ((result && result.field) || "某个设置项") + " 的值不合法";
  if (code === "unknown_message") return "后台脚本版本对不上 —— 重新加载扩展后再试";
  return "配置保存失败" + (raw ? "：" + raw.slice(0, 60) : "");
}

async function patchConfig(patch, expectedFingerprint) {
  const result = await sendRuntimeMessageWithTimeout({
    type: "config_patch", payload: { patch, expectedFingerprint }
  }, 8000, "配置保存超时");
  if (!result || !result.success) {
    const error = new Error(saveFailureText(result));
    error.code = result && result.code;
    error.detail = result && result.error;
    // 这是**本机弹窗与后台之间**的事，不是和 AI 服务商之间的事。
    // 打上标记，免得调用方把它当成 fetch 异常去分类成「连接不上服务商」（见检测 API 连接的 catch）。
    error.localBridge = true;
    // 只记形状，不记 patch 的内容（里面有密钥）。
    // 注意：这一跳本身也要经过后台，如果后台连"这是弹窗"都没认出来，日志同样写不进去 ——
    // 所以「为什么被拒」必须同时出现在**界面**上（见 saveFailureText 的括号），否则用户无从求助。
    try {
      await appendPopupLog("error", "config rejected by background", {
        code: String(error.code || ""), why: String(error.detail || "").slice(0, 120),
        page: String(location.href).split("#")[0].replace(/^chrome-extension:\/\/[^/]+/, ""),
        build: String((chrome.runtime.getManifest() || {}).version_name || "")
      });
    } catch (e) {}
    throw error;
  }
  storedConfig = withoutRemovedConfigFields(result.config || {});
  config = withoutRemovedConfigFields({ ...DEFAULTS, ...result.config });
  return config;
}

function reportSaveError(error) {
  toast(error && error.message ? error.message : "保存失败，请重试", 5000);
}

function toast(msg, ms) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._timer);
  // 失败的话原来 1.6 秒就消失，读不到字等于没反馈
  toast._timer = setTimeout(() => els.toast.classList.remove("show"), ms || 1600);
}

function withoutRemovedConfigFields(rawConfig) {
  const next = { ...(rawConfig || {}) };
  delete next.forceLearn;
  // 「播放速度」滑条在批次 146 删了，`libs/runtime-policy.js` 里也不再登记这个键。
  // 老用户存储里那条 `playbackRate` 得在**读回来的这一刻**摘掉：`validatePatch` 认不出
  // 任何一个键就顶回整张补丁，症状是「所有开关都存不住」（批次 34 那一族），不是「这一根滑条坏了」。
  delete next.playbackRate;
  return next;
}

// API 地址构造与密钥清洗的唯一真源是 libs/api-url.js（popup.html 里在 popup.js 之前加载）。
// 这几段原先在这里和 content.js 各写了一份、并且已经分叉：只有这里会剥掉引号，
// 结果同样的 Key 在弹窗里能连通、在页面上却失败。这里只做转发，调用点保持不变。
const API_URL = self.OmitoneApiUrl;

function normalizeApiKey(apiKey) {
  return API_URL.normalizeApiKey(apiKey);
}

function buildOpenAICompatibleUrl(apiUrl) {
  return API_URL.buildOpenAICompatibleUrl(apiUrl);
}

function buildClaudeApiUrl(apiUrl) {
  return API_URL.buildClaudeApiUrl(apiUrl);
}

function buildGeminiApiUrl(apiUrl, model, apiKey) {
  return API_URL.buildGeminiApiUrl(apiUrl, model, apiKey);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const method = (options && options.method) || "POST";
  // GET/HEAD 不许带 body：后台 apiFetch 那侧是 `body == null ? undefined : String(body)`，
  // 空串也算"有 body"，浏览器按 Fetch 规范对 GET 带 body 当场抛 TypeError。
  // 于是这一发**在本地就死了**，而下面那个 catch 把代理失败吞成"改走本地 fetch" ——
  // 症状只是慢半拍，不是错，等发现时已经查不到是这一行造成的（批次 154 加「获取模型列表」时量到）。
  const allowBody = !/^(get|head)$/i.test(method);
  try {
    const proxy = await sendRuntimeMessageWithTimeout({
      type: "api_fetch",
      payload: {
        url,
        method,
        headers: (options && options.headers) || {},
        body: allowBody ? ((options && options.body) || "") : null,
        timeoutMs: timeoutMs || 25000
      }
    }, timeoutMs || 25000, "background api fetch timeout");

    if (proxy && typeof proxy.text === "string" && (proxy.success || proxy.status)) {
      return {
        ok: !!proxy.success,
        status: proxy.status || 0,
        statusText: proxy.statusText || "",
        text: async () => proxy.text,
        json: async () => proxy.data != null ? proxy.data : JSON.parse(proxy.text || "null")
      };
    }
  } catch (e) {}

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testApiConnectionDirect(cfg) {
  const config = { ...cfg, apiKey: normalizeApiKey(cfg.apiKey) };
  if (config.apiType === "claude") {
    const url = buildClaudeApiUrl(config.apiUrl);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 12,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with OK" }]
      })
    }, 25000);
    if (!response.ok) {
      // 分类文案：余额不足 / Key 无效 / 限流 / 模型名不对 —— 不再把业务拒绝叫「连接失败」
      const bodyText = await response.text();
      const described = (typeof self !== "undefined" && self.OmitoneApiError)
        ? self.OmitoneApiError.describe(response.status, bodyText)
        : { category: "unknown", human: `连接失败 (${response.status}): ${String(bodyText || "").slice(0, 300)}` };
      return { success: false, error: described.human, category: described.category };
    }
    const data = await response.json();
    const message = (data.content?.[0]?.text || "OK").trim().replace(/\s+/g, " ");
    return { success: true, endpoint: url, message: message.substring(0, 80) || "OK" };
  }

  if (config.apiType === "gemini") {
    const url = buildGeminiApiUrl(config.apiUrl, config.model, config.apiKey);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 12 }
      })
    }, 25000);
    if (!response.ok) {
      // 分类文案：余额不足 / Key 无效 / 限流 / 模型名不对 —— 不再把业务拒绝叫「连接失败」
      const bodyText = await response.text();
      const described = (typeof self !== "undefined" && self.OmitoneApiError)
        ? self.OmitoneApiError.describe(response.status, bodyText)
        : { category: "unknown", human: `连接失败 (${response.status}): ${String(bodyText || "").slice(0, 300)}` };
      return { success: false, error: described.human, category: described.category };
    }
    const data = await response.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const message = parts.map((part) => part && part.text ? part.text : "").join(" ").trim().replace(/\s+/g, " ");
    return { success: true, endpoint: url, message: (message || "OK").substring(0, 80) };
  }

  const url = buildOpenAICompatibleUrl(config.apiUrl);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "You are a connectivity check. Reply with OK only." },
        { role: "user", content: "Reply with OK" }
      ],
      max_tokens: 12,
      temperature: 0
    })
  }, 25000);
  if (!response.ok) {
    // 分类文案：余额不足 / Key 无效 / 限流 / 模型名不对 —— 不再把业务拒绝叫「连接失败」
    // （⚠️ 这份与上面 Claude / Gemini 两份是三胞胎，改一处必须三处一起改）
    const bodyText = await response.text();
    const described = (typeof self !== "undefined" && self.OmitoneApiError)
      ? self.OmitoneApiError.describe(response.status, bodyText)
      : { category: "unknown", human: `连接失败 (${response.status}): ${String(bodyText || "").slice(0, 300)}` };
    return { success: false, error: described.human, category: described.category };
  }
  const data = await response.json();
  const message = (data.choices?.[0]?.message?.content || "OK").trim().replace(/\s+/g, " ");
  return { success: true, endpoint: url, message: message.substring(0, 80) || "OK" };
}

// ── 模型列表（批次 154，issue #2 第 3 条）────────────────────────────────────
// 存在的理由：三处模型名一直是**手抄**，抄错就是 400/404 那一族，而那句报错说的是
// 「模型不存在」，人会往网络方向查。这一条发一句「这家有哪些型号」（不花 token），
// 把型号名灌进三处模型名那几格的候选里。
// 三个 apiType 分支与 testApiConnectionDirect / petChatSend 同族的三胞胎规矩 ——
// 改一处必须三处一起改；新增一型也要同步进这里（AGENTS §2 #18）。
// 拆成纯函数是为了集成层能从本文件原样抽出来直接跑（AGENTS §5）。
const MODELS_FETCH_TIMEOUT_MS = 20000;

function buildModelsRequest(cfg) {
  const key = normalizeApiKey(cfg && cfg.apiKey);
  // 先问资格再拼地址：没 Key 就发请求，回包是 401，而界面会把「你没填 Key」翻译成
  // 「这家返回未授权」—— 用户会去重新生成一枚 Key，方向完全错。
  if (!key) return { ok: false, state: "nokey", why: "还没填 API Key" };
  const type = (cfg && cfg.apiType) || "openai";
  // claude 与 gemini 各有默认地址，只有这两型必须自己填（与 testApiConnectionNoBackground 同一口径）
  if ((type === "openai" || type === "gemini") && !String((cfg && cfg.apiUrl) || "").trim()) {
    return { ok: false, state: "noaddr", why: "还没填 API URL" };
  }
  // 地址只许从 libs/api-url.js 那一份拼（AGENTS §2 #4），这里不许内联字符串拼接
  let url = "";
  try {
    url = API_URL.buildModelsUrl(cfg && cfg.apiUrl, type);
  } catch (e) {
    return { ok: false, state: "unreadable", why: "地址构造那一跳抛了：" + String((e && e.message) || e).slice(0, 120) };
  }
  if (!url) return { ok: false, state: "noaddr", why: "API URL 没拼出可用的地址" };
  const headers = type === "claude"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : type === "gemini"
      // gemini 的 Key 走请求头，不学 chat 那条链拼进地址：地址会进日志（`api test result` 打印 endpoint），
      // 而日志是用户会「复制」出去的东西。这一条是只读列表，没必要再添一处 Key 落到导出面。
      ? { "x-goog-api-key": key }
      : { "Authorization": `Bearer ${key}` };
  return { ok: true, state: "ready", method: "GET", url, headers };
}

// 读响应体也要能超时（AGENTS §2 #2：`.text()` 同样可能永远不 resolve，try/catch 拦不住挂起）。
// 返回 null = 这一发**没读到**（单独一格），"" = 真读到一个空体 —— 两者不许合并。
function readTextWithTimeout(response, timeoutMs) {
  if (!response || typeof response.text !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), timeoutMs || MODELS_FETCH_TIMEOUT_MS);
    Promise.resolve()
      .then(() => response.text())
      .then((t) => finish(String(t || "")))
      // text() 自己抛 = 这一发**没读到**，和超时同一格；把它写成空串会让「连接断了」
      // 冒充「服务商回了个空体」，而这两句用户听完要做的事相反。
      .catch(() => finish(null));
  });
}

async function fetchModelIds(cfg) {
  const made = buildModelsRequest(cfg);
  if (!made.ok) return made;
  const response = await fetchWithTimeout(made.url, { method: "GET", headers: made.headers }, MODELS_FETCH_TIMEOUT_MS);
  const status = Number(response && response.status) || 0;
  if (!response || !response.ok) {
    const bodyText = await readTextWithTimeout(response, MODELS_FETCH_TIMEOUT_MS);
    const described = (typeof self !== "undefined" && self.OmitoneApiError)
      ? self.OmitoneApiError.describe(status, bodyText || "")
      : { category: "unknown", human: `问型号列表没成功（HTTP ${status}）` };
    return { ok: false, state: "http", status, category: described.category, why: described.human, ids: [] };
  }
  const text = await readTextWithTimeout(response, MODELS_FETCH_TIMEOUT_MS);
  if (text === null) {
    return { ok: false, state: "unreadable", why: "响应体没读到（超时或连接断了）", source: "", ids: [] };
  }
  const parsed = API_URL.parseModelIds(text);
  return {
    ok: parsed.state === "ok",
    state: parsed.state,
    ids: parsed.ids || [],
    why: parsed.why || "",
    source: parsed.source || ""
  };
}

// 六格各说各话，谁都不许压进谁（AGENTS §2 #12）：nokey / noaddr / http / unreadable / empty / ok。
// 压成「成功 / 失败」两格时，「回包形状认不出来」会被读成「这家没有型号」，
// 而用户接下来做的事（换 Key、充值、查网络）一件都不对。
function modelListSentence(out) {
  if (!out || !out.state) return "没读到结果，再点一次试试。";
  const ids = out.ids || [];
  if (out.state === "ok") {
    const head = ids.slice(0, 5).join("、");
    return `已拿到 ${ids.length} 个型号：${head}${ids.length > 5 ? " …" : ""} —— 点上面三处模型名那几格就能选，也可以继续手打。`;
  }
  if (out.state === "empty") return "这家说自己名下没有可用型号（回包是空的）—— 不是网络问题，也不等于 Key 没用。";
  if (out.state === "unreadable") return `回包读不出型号名（${out.why || "形状认不出来"}）—— 照旧手填模型名。`;
  if (out.state === "http") return out.why || "问型号列表没成功。";
  if (out.state === "nokey") return "还没填 API Key —— 这一步要用它。";
  if (out.state === "noaddr") return "还没填 API URL —— 补上再点。";
  return out.why || `没认出来的结果（${String(out.state)}）。`;
}

function renderModelOptions(ids) {
  const menu = els.modelOptions;
  if (!menu) return;
  // 先清空：append 会叠加，第二次点就会在候选里出现重复型号
  menu.textContent = "";
  menu.hidden = true;
  menu.classList.remove("show");
  (ids || []).forEach((id) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "model-option";
    opt.setAttribute("role", "option");
    opt.dataset.model = String(id);
    opt.value = String(id);
    opt.textContent = String(id);
    menu.appendChild(opt);
  });
}

let modelMenuInput = null;
function hideModelMenu() {
  const menu = els.modelOptions;
  if (menu) {
    menu.hidden = true;
    menu.classList.remove("show");
  }
  modelMenuInput = null;
}
function showModelMenu(input) {
  const menu = els.modelOptions;
  if (!menu || !input) return;
  const q = String(input.value || "").trim().toLowerCase();
  const options = Array.prototype.slice.call(menu.querySelectorAll(".model-option"));
  let visible = 0;
  options.forEach((opt) => {
    const hit = !q || String(opt.dataset.model || "").toLowerCase().indexOf(q) >= 0;
    opt.hidden = !hit;
    if (hit) visible++;
  });
  if (!visible) { hideModelMenu(); return; }
  modelMenuInput = input;
  menu.hidden = false;
  menu.classList.add("show");
  const rect = input.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 356;
  const vh = window.innerHeight || document.documentElement.clientHeight || 600;
  const width = Math.max(180, Math.min(rect.width || 240, vw - 16));
  menu.style.width = width + "px";
  menu.style.left = Math.max(8, Math.min(rect.left, vw - width - 8)) + "px";
  let top = rect.bottom + 6;
  const roomBelow = vh - top - 8;
  if (roomBelow < 100) top = Math.max(8, rect.top - Math.min(220, rect.top - 8) - 6);
  menu.style.top = top + "px";
  menu.style.maxHeight = Math.max(80, Math.min(220, vh - top - 8)) + "px";
}
function bindModelMenu(input) {
  if (!input) return;
  input.setAttribute("autocomplete", "off");
  const open = function () { showModelMenu(input); };
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", open);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideModelMenu();
  });
}
if (els.modelOptions && els.modelOptions.parentNode !== document.body) {
  // 候选层必须挂在 body 上：它祖先的玻璃分组带 backdrop-filter，会把 position:fixed
  // 的参照系改成那一组，弹层就会按组坐标画到屏幕外（2026-11-25 暗色实测）。
  document.body.appendChild(els.modelOptions);
}
[els.model, els.visionModel, els.captchaModel].forEach(bindModelMenu);
if (els.modelOptions) {
  els.modelOptions.addEventListener("click", function (event) {
    const target = event.target && event.target.closest ? event.target.closest(".model-option") : null;
    if (!target || !modelMenuInput) return;
    const picked = modelMenuInput;
    picked.value = String(target.dataset.model || target.textContent || "");
    picked.dispatchEvent(new Event("input", { bubbles: true }));
    picked.dispatchEvent(new Event("change", { bubbles: true }));
    picked.focus({ preventScroll: true });
    hideModelMenu();
  });
}
document.addEventListener("click", function (event) {
  if (!modelMenuInput || !els.modelOptions) return;
  if (els.modelOptions.contains(event.target) || modelMenuInput.contains(event.target)) return;
  hideModelMenu();
});
window.addEventListener("scroll", hideModelMenu, true);
window.addEventListener("resize", hideModelMenu);

function setModelListState(message) {
  const el = els.modelListState;
  if (!el) return;
  if (!message) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = message;
  el.hidden = false;
}

// 「这批发回来的型号还是不是刚才那一套配置要的」—— 只看真正决定结果的三处输入：
// apiType / apiUrl / apiKey。故意**不**用 apiFormFingerprint()：那一把尺含所有开关，
// 用户在等待期间动一下「讨论」开关就会得到一句「配置已变化，结果没采用」，
// 而型号清单跟开关毫无关系 —— 那是把保护写成误报（§5「会误报的守卫和没有守卫一样害人」）。
function modelsFormKey(cfg) {
  return [
    String((cfg && cfg.apiType) || ""),
    String((cfg && cfg.apiUrl) || "").trim(),
    normalizeApiKey(cfg && cfg.apiKey)
  ].join("|");
}

let modelsFetchGeneration = 0;

async function listModelsFromProvider() {
  const cfg = withoutRemovedConfigFields({ ...config, ...getApiFormConfig() });
  const generation = ++modelsFetchGeneration;
  const formKey = modelsFormKey(cfg);
  const isCurrent = () =>
    generation === modelsFetchGeneration &&
    modelsFormKey(withoutRemovedConfigFields({ ...config, ...getApiFormConfig() })) === formKey;
  const btn = els.listModels;
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "获取中…";
    }
    setModelListState("正在问这一家有哪些型号（这一步不花 token）…");
    await appendPopupLog("info", "models list begin", apiConfigSummary(cfg));

    const out = await fetchModelIds(cfg);
    if (!isCurrent()) {
      // 不采用，也不清空已有候选 —— 旧那一批同样是用户自己点出来的
      setModelListState("地址或 Key 在这期间改过了，这一批结果没有采用 —— 再点一次。");
      await appendPopupLog("warn", "models list discarded: form changed", apiConfigSummary(cfg));
      return;
    }
    if (out.ok) renderModelOptions(out.ids);
    setModelListState(modelListSentence(out));
    await appendPopupLog(out.ok ? "info" : "warn", "models list result", {
      state: out.state,
      count: (out.ids || []).length,
      source: out.source || "",
      why: String(out.why || "").slice(0, 300),
      category: out.category || "",
      config: apiConfigSummary(cfg)
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!isCurrent()) { setModelListState("地址或 Key 在这期间改过了，这一批结果没有采用 —— 再点一次。"); return; }
    // 走到这里才是请求真发不出去（fetch 抛异常）—— 也要翻译成人话，
    // "Failed to fetch" 对用户没有信息量（与 testApiConnectionNoBackground 同一口径）
    const described = (typeof self !== "undefined" && self.OmitoneApiError)
      ? self.OmitoneApiError.describe(0, message)
      : { category: "network", human: message };
    setModelListState(described.human);
    await appendPopupLog("error", "models list failed", { error: described.human.slice(0, 300), category: described.category });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "获取模型列表";
    }
  }
}

// ── 宠物聊天（批次 123）────────────────────────────────────────────────────
// 弹窗里「聊」那枚按钮的唯一请求出口。复用答题同一条 api_fetch 链路（后台代理 +
// 用户自己配置的 Key/模型），不接任何第三方中转。三个 apiType 分支与
// testApiConnectionDirect 的三胞胎同族 —— 改一处必须三处一起改的规矩在这里同样适用。
// 构造与发送分开：buildPetChatRequest 是纯函数（集成测试从本文件抽出来直接构造验证形状）。
// ⚠️ 第 5 个参数 webSearchOn 是**三态**：`null` / `undefined` = 还没从存储读回来。
// 不许写成 `!!webSearchOn` 把"还没读到"压成"用户没开" —— 那两句在界面上的表现相同（都不搜），
// 但说的话完全不同，而且压成一态之后「存储读得慢半拍」这一族会变成永久沉默（AGENTS §2 #12）。
// 「能不能带搜索工具」的判定不在这里，唯一真源是 libs/web-search.js 的 decisionOf ——
// 弹窗聊天、弹窗解释、上课页医生三处出口必须问同一把尺。
function buildPetChatRequest(cfg, history, sys, urls, webSearchOn) {
  const trimmed = (history || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") &&
      typeof m.text === "string" && m.text.trim() !== "")
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.text.trim().slice(0, 400) }));
  // 最后一发必须是用户说的话：界面忙乱时不会拿半截历史去发请求
  if (!trimmed.length || trimmed[trimmed.length - 1].role !== "user") return null;
  const h = urls || { openai: buildOpenAICompatibleUrl, claude: buildClaudeApiUrl, gemini: buildGeminiApiUrl };
  // 「这一发到底带不带搜索」只问 libs/web-search.js（三处出口同一把尺）。
  // 模块没加载是**单独一格**（no-lib）：那说明 manifest / popup.html 的登记漏了一处，
  // 症状与"用户没开"一模一样、一条异常都不留（AGENTS §2 #18）—— 所以不许塌进 off。
  const webSearch = (typeof OmitoneWebSearch !== "undefined" && OmitoneWebSearch.decisionOf)
    ? OmitoneWebSearch.decisionOf(cfg, webSearchOn)
    : { cell: "no-lib", on: false, why: "联网搜索模块没加载（登记漏了一处）", host: "" };
  // max_tokens **不因联网而变**：现网那一档 384 实测够（`.workbuddy/probe162` K 档：
  // flash + tools + max_tokens=384 → finish=stop、正文 63 字，completion 410 也没被截断）。
  // 会被推理吃空的是探针故意设的 48 那一档（probe160），不是现实这一档 ——
  // 照着它把上限抬高就是凭空多一个要对文档的数字（AGENTS §5「断言里的数要说得出从哪读回来」）。
  if (cfg.apiType === "claude") {
    return {
      apiType: "claude",
      url: h.claude(cfg.apiUrl),
      headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 384, temperature: 0.8, system: sys, messages: trimmed }),
      search: webSearch
    };
  }
  if (cfg.apiType === "gemini") {
    return {
      apiType: "gemini",
      url: h.gemini(cfg.apiUrl, cfg.model, cfg.apiKey),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: trimmed.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.8, maxOutputTokens: 384 }
      }),
      search: webSearch
    };
  }
  // 带搜索那一发**不发 temperature**：量过的那一发就是 `{model, messages, max_tokens, tools}` 四格
  // （探针 probe161 E / probe162 H–L，六发全 200 且真搜，没有一发带着 temperature）。
  // **"带 tools 时服务端怎么对待 temperature" 这一组合没测过** —— 没测过的参数不许照发，
  // 多一格就多一条没人验过的路径；带不动时回到改动前那个形状，一个键都不多。
  const openaiBody = {
    model: cfg.model,
    messages: [{ role: "system", content: sys }].concat(trimmed),
    max_tokens: 384
  };
  if (webSearch.on) {
    // 声明形状也从 libs 读：`webSearch.on` 只可能由那把尺判出来（no-lib 那一格 on 恒 false），
    // 所以这里必然拿得到模块 —— 抄一份字面量就是第二把尺，将来改字段只改一处会分叉（AGENTS §2 #18）。
    openaiBody.tools = OmitoneWebSearch.toolsFor(webSearch);
  } else {
    openaiBody.temperature = 0.8;
  }
  return {
    apiType: "openai",
    url: h.openai(cfg.apiUrl),
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(openaiBody),
    search: webSearch
  };
}

/**
 * 把"这一发到底搜没搜 / 搜了几次 / 花了多少 token"收成界面上那一行小字。
 *
 * ⚠️ 两句话都要说，缺一不可：
 *   - 开关**开着**却带不动（中转站、协议形状不对、模块没登记）必须当场说一句"没联网 + 为什么"，
 *     否则用户听到的那句模型回答就**听起来像**刚查过 —— 任务 #183 里用户明确要的那一格。
 *   - 开关没开时**一个字都不说**：那行小字出现只会让人以为刚才那句话是搜出来的。
 * @param {{cell:string,on:boolean,why:string}} decision
 * @param {object} data 回包（只在 decision.on 时读它的 usage）
 */
function petSearchMeta(decision, data) {
  const lib = (typeof OmitoneWebSearch !== "undefined") ? OmitoneWebSearch : null;
  if (!decision) return null;
  if (decision.on) {
    return { on: true, cell: decision.cell, sentence: lib ? lib.sentenceOf(lib.usageOf(data)) : "这一回没读到用量数据。" };
  }
  // 开关没开（off）与压根没这一枚开关的调用方 → 不出声。
  // 只有"用户明明开着"的那些格子才需要解释为什么没搜。
  if (decision.cell === "off") return null;
  return { on: false, cell: decision.cell, sentence: "这次没有联网：" + (decision.why || "原因读不出") };
}

async function petChatSend(history, opts) {
  const o = opts || {};
  const cfg = { ...config, apiKey: normalizeApiKey(config.apiKey) };
  if (!cfg.apiKey) return { ok: false, noKey: true };
  const promptLib = (typeof self !== "undefined" && self.OmitonePrompt) || {};
  // 提示词唯一真源在 libs/prompt.js（AGENTS §2 #4）；这里只按名字取，不许内联。
  const sys = o.sysKey ? promptLib[o.sysKey] || "" : promptLib.PET_CHAT_SYSTEM || "";
  // 三态原样交下去：还没从存储读回来时是 null，**不许在这里 !! 一下**（AGENTS §2 #12）
  const req = buildPetChatRequest(cfg, history, sys, null, petWebSearchVal);
  if (!req) return { ok: false, error: "" };
  let response;
  try {
    response = await fetchWithTimeout(req.url, { method: "POST", headers: req.headers, body: req.body }, 20000);
  } catch (e) {
    return { ok: false, error: "没连上（可能是网络，也可能是地址填错了）" };
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const described = (typeof self !== "undefined" && self.OmitoneApiError)
      ? self.OmitoneApiError.describe(response.status, bodyText)
      : { category: "unknown", human: `请求失败 (${response.status})` };
    return {
      ok: false,
      error: String(described.human || "").slice(0, 80),
      meta: petSearchMeta(req.search, null)
    };
  }
  let data = null;
  try { data = await response.json(); } catch (e) { return { ok: false, error: "回包读不懂", meta: petSearchMeta(req.search, null) }; }
  let text = "";
  if (req.apiType === "claude") {
    text = ((data.content || [])[0] || {}).text || "";
  } else if (req.apiType === "gemini") {
    const parts = ((((data.candidates || [])[0] || {}).content || {}).parts) || [];
    text = parts.map((part) => part && part.text ? part.text : "").join(" ");
  } else {
    text = (((data.choices || [])[0] || {}).message || {}).content || "";
  }
  text = String(text).trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "她只想了没说话 —— 换个普通对话模型试试", meta: petSearchMeta(req.search, data) };
  // 上限默认 160（聊天气泡那一格）；体检解释要长一点，但**天花板 400 写死在这里** ——
  // 面板装不下是判据层的责任，不能靠调用方自觉（AGENTS §2「输出必须有界」）。
  const want = Number(o.maxChars) > 0 ? Number(o.maxChars) : 160;
  return { ok: true, text: text.slice(0, Math.min(want, 400)), meta: petSearchMeta(req.search, data) };
}
// pet.js 只管界面；发请求统一走这个钩子（经典脚本按加载顺序共享全局作用域）
window.omitonePetChatSend = petChatSend;

/**
 * 联网搜索开关的真值（弹窗「聊」与弹窗「让她解释」两处出口共用这一格，
 * 上课页医生那一支在 content.js 里读同一个键）。
 * ⚠️ **null = 还没从存储读回来**，与 false（用户没开）是两格：压成 false 之后，
 * 首屏那一发会被界面说成「开关没开」—— 而那正是用户刚刚亲手打开的那一枚
 * （AGENTS §2 #12 在开关读取上的同族）。
 */
let petWebSearchVal = null;

// ── 本地体检「医生」（批次 130）────────────────────────────────────────────
// 判断层在 libs/diagnose.js（弹窗 / 上课页 / 集成测试三处共用同一份规则），
// 这里只补界面需要的三件事：**把日志交出去、把结论解释成人话、把动作接回现有按钮**。
// ⚠️ 全程只读 —— 不许在这里点任何东西、改任何配置；动作一律转交给弹窗里本来就有的入口。

/** 读出这台电脑上的运行日志环（200 条，键 runtimeLogs，与日志视图同一份真源）。 */
async function petDiagReadLogs() {
  try {
    const result = await chrome.storage.local.get(RUNTIME_LOGS_KEY);
    const arr = result && Array.isArray(result[RUNTIME_LOGS_KEY]) ? result[RUNTIME_LOGS_KEY] : [];
    return arr;
  } catch (e) {
    return { error: "日志读不出来（存储暂时不可用）" };
  }
}

/** 「让她解释」：把有界摘要交给模型说一句人话。复用 petChatSend 的整条链路 ——
 *  也就是 #161 那条 api_fetch + 用户自己配置的 Key，不接任何中转站。 */
async function petDiagExplain(digest) {
  const text = String(digest || "").slice(0, 900);
  if (!text) return { ok: false, error: "没有可解释的结论" };
  return await petChatSend(
    [{ role: "user", text: "下面是本地体检给出的结论，请用人话告诉主人下一步怎么办，别编造清单里没有的事：\n" + text }],
    { sysKey: "PET_DOCTOR_SYSTEM", maxChars: 280 }
  );
}

/** 卡片上那一枚按钮的唯一出口：只做「界面里本来就有的那两件事」。
 *  动作名与 libs/diagnose.js 规则表里的 `action` 一一对应 ——
 *  ⚠️ **规则新增一型 action 必须同步进这里那一族清单**，否则卡片上会出现
 *  一枚点了没反应的按钮（AGENTS §2 #18：声明覆盖的范围与实际走的分支之间的差，不会自己喊出来）。
 *  @param {string} kind 'reload' | 'open-settings'
 *  @returns {Promise<{ok:boolean, note:string}>} —— note 是要印在卡片上的那一句 */
async function petDiagAction(kind) {
  try {
    if (kind === "reload") {
      const [tab] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000, "读取标签页超时");
      if (!tab || !tab.id) return { ok: false, note: "没找到当前标签页" };
      if (/^chrome-extension:/i.test(tab.url || "")) return { ok: false, note: "这一页不是网页，重新加载请对学习通页面按 F5" };
      await withTimeout(chrome.tabs.reload(tab.id), 8000, "重新加载超时");
      return { ok: true, note: "已重新加载这一页" };
    }
    if (kind === "open-settings") {
      const key = document.getElementById("apiKey");
      const group = key ? key.closest("details") : null;
      if (group) group.open = true;
      if (key) { key.scrollIntoView({ block: "center" }); key.focus(); }
      return { ok: !!key, note: key ? "已跳到 API 那一栏，填好后按「检测连接」" : "没找到 API 那一栏，请在设置里手动打开" };
    }
    return { ok: false, note: "这个动作我不认识，只能照上面的话手动做" };
  } catch (error) {
    return { ok: false, note: "动作没做成：" + String(error && error.message ? error.message : error).slice(0, 40) };
  }
}
window.omitonePetDiagReadLogs = petDiagReadLogs;
window.omitonePetDiagExplain = petDiagExplain;
window.omitonePetDiagAction = petDiagAction;

async function appendPopupLog(level, message, meta) {
  try {
    await sendRuntimeMessageWithTimeout({ type: "runtime_log_append", payload: {
      time: Date.now(),
      level: level || "info",
      message: String(message || "").slice(0, 2000),
      meta: meta || null
    } }, 20000, "日志写入超时");
  } catch (e) {}
}

/**
 * API 连接状态行：apiConnectionError 是「检测 API 连接」与页面答题链路共写的
 * 分类后人话（libs/api-error.js）—— 此前只在 toast 与日志里出现，弹窗没有常驻展示位。
 * 失败时显示该文案（照着做即可），成功/清空后隐藏。
 *
 * 批次 166 在这一行下面补了两格：
 *  ① 「刚才问的是哪家哪个模型」—— 分类只说**哪一类错**，没说**是谁家的错**，
 *     而换一家是用户唯一的自救路径（issue #2 第 3 条）。
 *  ② 「这一轮改用乱选继续 / 变回问 AI」—— 用户裁的是**一键决定退不退**，
 *     ⚠️ 插件自己永远不许把「乱选」打开：它随机填满整卷就交卷，而交卷不可逆。
 *     这一发只由人点，且只在有失败记录时才出现（没坏就别劝人退）。
 */
function renderApiConnState(config) {
  const el = document.getElementById("apiConnState");
  if (!el) return;
  const whoEl = document.getElementById("apiConnWho");
  const retreatEl = document.getElementById("apiRetreat");
  const failed = !!(config && config.apiConnectionFailed);
  const message = failed ? String(config.apiConnectionError || "").trim() : "";
  if (!failed || !message) {
    el.hidden = true;
    el.textContent = "";
    if (whoEl) { whoEl.hidden = true; whoEl.textContent = ""; }
    if (retreatEl) retreatEl.hidden = true;
    return;
  }
  el.textContent = message;
  el.hidden = false;
  // 渠道身份**从整份配置算**，不掺进上面那句分类文案里：
  // - 页面那一侧拿不到 providerPreset / apiUrl / model（libs/runtime-policy.js 的
  //   runtimeFields 不投影这三格），所以「是谁家的错」只有扩展侧与弹窗说得出；
  // - 上面那句有 300 字的存储预算（apiConnectionError），前缀会把**服务商原话**挤掉，
  //   而原话才是排查的唯一线索 —— 所以它是独立的一行，不是那句话的开头。
  // ⚠️ 基准必须与「实际发出去那发用的那份」相同：content.js 的 loadConfig('study')
  //    算的是 `{ ...CONFIG_DEFAULTS, ...存储 }`，这里也得补默认值（新用户存储里
  //    providerPreset 压根没写过，不补就读出 (渠道读不出)）。与 §2 #23 那条**相反**
  //    的基准要求并存是有意的：竞争闸要比的是原始存档字节，展示要比的是渲染出来的值。
  const merged = Object.assign({}, DEFAULTS, config || {});
  const who = (typeof self !== "undefined" && self.OmitoneApiError)
    ? self.OmitoneApiError.channelOf(merged)
    : { text: "(渠道读不出) · (模型名没填)（libs/api-error.js 没加载）" };
  if (whoEl) {
    whoEl.textContent = "刚才问的是：" + String(who.text || "");
    whoEl.hidden = false;
  }
  if (retreatEl) {
    // 「现在是不是乱选」读**存储里那一份**（传进来的 config），不读内存里那枚开关镜像 ——
    // 保存被拒时内存已经翻了、盘上没翻，跟着内存说就成了谎话。
    renderApiRetreat(retreatEl, merged.randomAnswer === true);
    retreatEl.hidden = false;
  }
}

/** 那一发的按钮与说明：只说这一格现在是什么、点下去会变成什么。 */
function renderApiRetreat(row, randomOn) {
  const btn = row.querySelector("#apiRetreatBtn");
  const hint = row.querySelector("#apiRetreatHint");
  if (btn) btn.textContent = randomOn ? "变回问 AI（关掉乱选）" : "这一轮改用「乱选」继续";
  if (hint) {
    hint.innerHTML = randomOn
      ? "现在<b>不问模型</b>：题目随机填满后按「乱选交卷前留几秒检查」那一格交卷。"
      : "乱选 = 不问模型、<b>随机填满整卷再交卷</b>，交卷不可逆。<b>插件不会自己打开它</b>，这一发只由你点。<br>"
        + "⚠️ 不是每张卷子都会填满：作业 / 考试那档把下限调到「高」时仍然<b>不猜、停下来等</b>。";
  }
}

function apiConfigSummary(cfg) {
  const key = normalizeApiKey(cfg && cfg.apiKey);
  return {
    apiType: cfg && cfg.apiType,
    apiUrl: cfg && cfg.apiUrl,
    model: cfg && cfg.model,
    keyLength: key.length
  };
}

function sendRuntimeMessageWithTimeout(message, timeoutMs, timeoutError) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ success: false, error: timeoutError || "请求超时" });
    }, timeoutMs || 25000);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ success: false, error: lastError.message || String(lastError) });
          return;
        }
        resolve(response || { success: false, error: "后台无响应" });
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, error: error && error.message ? error.message : String(error) });
    }
  });
}

function getApiFormConfig() {
  return {
    providerPreset: els.providerPreset.value,
    apiType: els.apiType.value,
    apiUrl: els.apiUrl.value.trim(),
    apiKey: normalizeApiKey(els.apiKey.value),
    apiConnectionFailed: false,
    apiConnectionError: "",
    model: els.model.value.trim(),
    captchaModel: els.captchaModel.value.trim(),
    visionModel: els.visionModel.value.trim(),
    // 三格区间一次全发（不发老键）：老键留在盘上当史实，新键一旦写过就由它说话。
    // ⚠️ 一次全发是**故意的** —— 只发刚动过那一格，等于让另外两格继续靠老键推导，
    // 用户看到界面写着"下限=高"、页面算出来却是老键那一档，两边读出来的成本不一样。
    thinkingRangeCourse: rangeFromForm("course"),
    thinkingRangeQuiz: rangeFromForm("quiz"),
    thinkingRangeExam: rangeFromForm("exam")
  };
}

/**
 * 思考强度那一组：三行上下限 ↔ 三个配置键。
 *
 * 场景名、配置键、档位顺序**全部从 libs/thinking.js 现取**，不在这里抄一份词表 ——
 * 抄一份就是两处真源：真源加一档时这边不会变红，只会静默少一行可选值。
 */
const THINK_TIERS = (typeof OmitoneThinking !== "undefined" && OmitoneThinking.TIERS)
  ? OmitoneThinking.TIERS : ["course", "quiz", "exam"];

function thinkSel(tier, edge) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return els["thinking" + cap(edge) + cap(tier)];
}

/** 两个 select 拼成一格 `'min-max'`。万一选倒了（下限高于上限），按大小排好再发。 */
function rangeFromForm(tier) {
  const a = thinkSel(tier, "min").value;
  const b = thinkSel(tier, "max").value;
  if (typeof OmitoneThinking === "undefined") return a + "-" + b;
  return OmitoneThinking.levelRank(a) <= OmitoneThinking.levelRank(b) ? a + "-" + b : b + "-" + a;
}

/**
 * 用**解析之后**的区间回填两格，而不是直接读那一格新键。
 *
 * 新键从没写过（老用户）时，`rangeForTier` 会回落到 thinkingLevel / thinkingPaperLevel
 * 推出的那一档；照新键的出厂值填成"关闭"，下一次保存就把那位"整卷档=高"的用户
 * 悄悄按回关闭 —— 而且一句报错都没有，症状是"答案变差了"。
 */
function renderThinkingSelects(cfg) {
  THINK_TIERS.forEach((tier) => {
    const r = typeof OmitoneThinking !== "undefined"
      ? OmitoneThinking.rangeForTier(cfg || {}, tier) : { min: "off", max: "off" };
    thinkSel(tier, "min").value = r.min;
    thinkSel(tier, "max").value = r.max;
  });
}

// content.js 从回包的推理 token 反推"模型自己想到了哪一档"，按场景各存一格。
// 读不到就整段不说 —— 把"没读到"讲成"它从没思考过"是这句提示最贵的一种错。
const THINK_OBSERVE_KEY = "omitoneThinkingObserved";
let thinkingObserved = {};

async function loadThinkingObserved() {
  try {
    const got = await chrome.storage.local.get([THINK_OBSERVE_KEY]);
    thinkingObserved = (got && got[THINK_OBSERVE_KEY]) || {};
  } catch (e) {
    thinkingObserved = {};
  }
  updateThinkingHint();
}

/**
 * 刷新「思考强度」下面那三行说明。
 *
 * 为什么值得逐场景写：同一句"上限=高"，DeepSeek 是什么思考参数都不发（让它自己定）、
 * Kimi 关不掉思考、认不出的渠道一个字段都不发。用户看不到这层差别，
 * 就会把"我关了它却没关"当成 bug。文字由 libs/thinking.js 统一生成，UI 不另写一套措辞。
 */
function updateThinkingHint() {
  if (!els.thinkingHint) return;
  if (typeof OmitoneThinking === "undefined") {
    els.thinkingHint.textContent = "（缺少 libs/thinking.js，无法解析渠道）";
    return;
  }
  const base = { apiUrl: els.apiUrl.value.trim(), model: els.model.value.trim() };
  const lines = THINK_TIERS.map((tier) => {
    // 取**表单上此刻**选的那一档，不是盘上那份 —— 用户边改边看，说明要跟着手里的选择走。
    const cfg = Object.assign({}, base);
    cfg[OmitoneThinking.TIER_RANGE_KEYS[tier]] = rangeFromForm(tier);
    const obs = thinkingObserved[tier];
    const seen = obs && obs.tokens >= 0 && OmitoneThinking.LEVEL_LABEL[obs.approx]
      ? "｜上次它自己想到「" + OmitoneThinking.LEVEL_LABEL[obs.approx] + "」（约 " + obs.tokens + " 推理 token）"
      : "";
    return escapeHtml(OmitoneThinking.describe(cfg, { tier: tier })) + escapeHtml(seen);
  });
  els.thinkingHint.innerHTML =
    "下限 = 至少想到这一档；上限 = 最多花到这一档。<b>两格拉开，中间交给模型自己定</b>，"
    + "钱只按上限备（不替它决定每次都想满）。<br>"
    + "「测试」= 章节测验与弹题，「考试」= 作业 / 考试卷。<b>考试那行的下限选「高」</b>，"
    + "模型没答上的题会<b>停下来等</b>（下一拍重问，或你手动作答后自动提交），不拿猜测占位交卷。<br><br>"
    + "<b>当前实际发送：</b><br>" + lines.join("<br>");
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function saveToggleConfig(showToast = true) {
  const patch = withoutRemovedConfigFields({
    autoMaxPlaybackRate: autoMaxRateVal,
    slowMachineMode: slowMachineVal ? "on" : "auto",
    enableMedia: enableMediaVal,
    enablePPT: enablePPTVal,
    enableHyperlink: enableHyperlinkVal,
    blockedReload: blockedReloadVal,
    autoNext: autoNextVal,
    autoNextCourse: autoNextCourseVal,
    enableQuiz: enableQuizVal,
    randomAnswer: randomAnswerVal,
    randomAnswerReviewSec: (function () {
      // 空输入回落默认 30；非法值同样回落，绝不把 NaN 写进存储。0 是合法值（= 不自动交卷）。
      var raw = els.randomAnswerReviewSec.value.trim();
      if (!raw) return 30;
      var num = Number(raw);
      if (!isFinite(num) || num < 0) return 30;
      return Math.min(600, Math.floor(num));
    })(),
    enableCaptcha: enableCaptchaVal,
    visionEnabled: visionEnabledVal,
    visionBudgetPerChapter: (function () {
      // 空输入回落默认 30；非法值同样回落，绝不把 NaN 写进存储。
      var raw = els.visionBudgetPerChapter.value.trim();
      if (!raw) return 30;
      var num = Number(raw);
      if (!isFinite(num) || num < 0) return 30;
      return Math.min(500, Math.floor(num));
    })(),
    enableDiscussion: enableDiscussionVal,
    enableVote: enableVoteVal,
    discussionReply: els.discussionReply.value.trim() || "1",
    systemPrompt: els.systemPrompt.value.trim(),
    restudy: restudyVal
  });
  await patchConfig(patch);
  if (showToast) toast("已自动保存");
}

async function saveApiConfig(showToast = true) {
  await patchConfig({ ...getApiFormConfig(), apiConnectionFailed: false, apiConnectionError: "" });
  if (showToast) toast("API 已保存");
}

function bindToggle(el, getter, setter) {
  const update = (on) => {
    el.className = "toggle" + (on ? " on" : "");
    // 无障碍：role="switch" 靠 aria-checked 表达开/关，读屏才知道当前状态
    el.setAttribute("aria-checked", on ? "true" : "false");
  };
  const toggle = async () => {
    const value = !getter();
    setter(value);
    update(value);
    try { await saveToggleConfig(); } catch (error) { setter(!value); update(!value); reportSaveError(error); }
  };
  el.addEventListener("click", toggle);
  // 键盘可达性：div 默认既拿不到焦点、也不响应空格/回车。
  // Chrome 官方文档写得很明确：「只有 a / button / 表单控件能获得键盘焦点」，
  // 所以 role="switch" + tabindex="0" + 这里的键盘处理，缺一不可。
  el.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
      event.preventDefault();
      toggle();
    }
  });
  // <label for> 只对表单控件生效，指向 div 时点了没反应 —— 手动补上
  const label = document.querySelector("label[for=\"" + el.id + "\"]");
  if (label) {
    label.addEventListener("click", (event) => {
      event.preventDefault();
      toggle();
    });
  }
  return update;
}

const updateAutoMaxRate = bindToggle(els.autoMaxRate, () => autoMaxRateVal, (value) => { autoMaxRateVal = value; });
const updateSlowMachine = bindToggle(els.slowMachineMode, () => slowMachineVal, (value) => { slowMachineVal = value; });
const updateMedia = bindToggle(els.enableMedia, () => enableMediaVal, (value) => { enableMediaVal = value; });
const updatePpt = bindToggle(els.enablePPT, () => enablePPTVal, (value) => { enablePPTVal = value; });
const updateHyperlink = bindToggle(els.enableHyperlink, () => enableHyperlinkVal, (value) => { enableHyperlinkVal = value; });
const updateBlockedReload = bindToggle(els.blockedReload, () => blockedReloadVal, (value) => { blockedReloadVal = value; });
const updateAutoNext = bindToggle(els.autoNext, () => autoNextVal, (value) => { autoNextVal = value; });
const updateAutoNextCourse = bindToggle(els.autoNextCourse, () => autoNextCourseVal, (value) => { autoNextCourseVal = value; });
const updateRandomAnswer = bindToggle(els.randomAnswer, () => randomAnswerVal, (value) => { randomAnswerVal = value; });
const updateQuiz = bindToggle(els.enableQuiz, () => enableQuizVal, (value) => { enableQuizVal = value; });
const updateCaptcha = bindToggle(els.enableCaptcha, () => enableCaptchaVal, (value) => { enableCaptchaVal = value; });
const updateVision = bindToggle(els.visionEnabled, () => visionEnabledVal, (value) => { visionEnabledVal = value; });
const updateDiscussion = bindToggle(els.enableDiscussion, () => enableDiscussionVal, (value) => { enableDiscussionVal = value; });
const updateVote = bindToggle(els.enableVote, () => enableVoteVal, (value) => { enableVoteVal = value; });
const updateRestudy = bindToggle(els.restudy, () => restudyVal, (value) => { restudyVal = value; });

// 吉祥物开关不走 bindToggle：bindToggle 的每一拍都落主配置（saveToggleConfig），
// 而这个开关是**纯外观存档**，跟收起/位置/好感度同一族，真源在 storage.local 的
// omitonePagePetMinimal 独立键上（content.js 的监听器即时生效，与主配置零耦合）。
// 这里镜像 bindToggle 的交互形状（点击/键盘/label 三条路），只把落盘那一发换成她自己的键。
let pagePetEnabledVal = true;
const updatePagePetEnabled = (on) => {
  els.pagePetEnabled.className = "toggle" + (on ? " on" : "");
  els.pagePetEnabled.setAttribute("aria-checked", on ? "true" : "false");
};
const togglePagePetEnabled = async () => {
  const value = !pagePetEnabledVal;
  const prev = pagePetEnabledVal;
  pagePetEnabledVal = value;
  updatePagePetEnabled(value);
  try {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ omitonePagePetMinimal: value ? 0 : 1 }, () => { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  } catch (error) {
    pagePetEnabledVal = prev;
    updatePagePetEnabled(prev);
    reportSaveError(error);
  }
};
els.pagePetEnabled.addEventListener("click", togglePagePetEnabled);
els.pagePetEnabled.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
    event.preventDefault();
    togglePagePetEnabled();
  }
});
const pagePetEnabledLabel = document.querySelector("label[for=\"pagePetEnabled\"]");
if (pagePetEnabledLabel) {
  pagePetEnabledLabel.addEventListener("click", (event) => {
    event.preventDefault();
    togglePagePetEnabled();
  });
}

// 吉祥物聊天开关：与上面的吉祥物开关同一族（纯外观存档、独立键、不走主配置），
// 但语义相反——**默认关**：聊天要走用户自己的 Key 按量计费，不许"升级即默认花钱"。
// 它只决定弹窗里「聊」按钮要不要出现（pet.js 认 body 上的 pet-chat-on，键是 omitonePetChatOn）。
let petChatEnabledVal = false;
const updatePetChatEnabled = (on) => {
  els.petChatEnabled.className = "toggle" + (on ? " on" : "");
  els.petChatEnabled.setAttribute("aria-checked", on ? "true" : "false");
  document.body.classList.toggle("pet-chat-on", on);
};
const togglePetChatEnabled = async () => {
  const value = !petChatEnabledVal;
  const prev = petChatEnabledVal;
  petChatEnabledVal = value;
  updatePetChatEnabled(value);
  try {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ omitonePetChatOn: value ? 1 : 0 }, () => { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  } catch (error) {
    petChatEnabledVal = prev;
    updatePetChatEnabled(prev);
    reportSaveError(error);
  }
};
els.petChatEnabled.addEventListener("click", togglePetChatEnabled);
els.petChatEnabled.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
    event.preventDefault();
    togglePetChatEnabled();
  }
});
const petChatEnabledLabel = document.querySelector("label[for=\"petChatEnabled\"]");
if (petChatEnabledLabel) {
  petChatEnabledLabel.addEventListener("click", (event) => {
    event.preventDefault();
    togglePetChatEnabled();
  });
}

// 「医生主动提醒」开关：又是独立键、不走主配置（同批次 34 那条教训 —— 主配置里没登记的键
// 会让 validatePatch 把**整份**保存全部拒掉）。
// 与聊天那一枚的**默认相反**：聊天开口必花 Key，默认关；体检的结论由本地规则表算出，
// 只有"开口前让模型想一遍怎么说"那一步花 Key、且有 5 分钟冷却封顶，所以默认开
// （键缺席 = 开，判据与 content.js 那一支必须同一把尺）。
// 它只管"上课页上她要不要自己开口体检"，弹窗里那枚「诊」不受它约束 ——
// 关掉提醒之后用户仍然可以随时主动查一次。
let petDoctorEnabledVal = false;
const updatePetDoctorEnabled = (on) => {
  els.petDoctorEnabled.className = "toggle" + (on ? " on" : "");
  els.petDoctorEnabled.setAttribute("aria-checked", on ? "true" : "false");
};
const togglePetDoctorEnabled = async () => {
  const value = !petDoctorEnabledVal;
  const prev = petDoctorEnabledVal;
  petDoctorEnabledVal = value;
  updatePetDoctorEnabled(value);
  try {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ omitonePetDoctorOn: value ? 1 : 0 }, () => { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  } catch (error) {
    petDoctorEnabledVal = prev;
    updatePetDoctorEnabled(prev);
    reportSaveError(error);
  }
};
els.petDoctorEnabled.addEventListener("click", togglePetDoctorEnabled);
els.petDoctorEnabled.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
    event.preventDefault();
    togglePetDoctorEnabled();
  }
});
const petDoctorEnabledLabel = document.querySelector("label[for=\"petDoctorEnabled\"]");
if (petDoctorEnabledLabel) {
  petDoctorEnabledLabel.addEventListener("click", (event) => {
    event.preventDefault();
    togglePetDoctorEnabled();
  });
}

// 「联网搜索」开关（任务 #183）：独立键、默认关 —— 与聊天那一枚同一族规矩（批次 34 教训：
// 主配置里没登记的键会让 validatePatch 把整份保存拒掉；会花钱的功能不许默认开着）。
// ⚠️ 这一枚和上面两枚**多了一层**：它只在"接入的是 DeepSeek 官方域"时才可能生效，
// 所以地址/协议一改就要重新判一次灰不灰、并把**为什么不灰**写进那一行提示 ——
// 判定唯一真源是 libs/web-search.js（弹窗两处出口 + 上课页医生问的都是它），
// 界面上不许再写第二份"是不是 deepseek"的正则（AGENTS §2 #4 同一族）。
// ⚠️ 状态只有 **petWebSearchVal** 这一份（三态：null = 还没从存储读回来）。
// 再开一个 boolean 给界面用，就是§2 #23 那一族：写入口与读出口各有各的基准，
// 首屏那一发会被说成"你没开"，而用户刚刚才开过。
const PET_WEB_SEARCH_HINT_OFF = "默认关。目前只有 DeepSeek 官方接口支持（中转站不行）；开了她回答前先自己查一次网页，按量计费。";
/** 用当前表单里的地址/协议/Key 问一次资格 —— 用户改哪格都能当场看到灰不灰。 */
function petWebSearchDecision() {
  const lib = (typeof OmitoneWebSearch !== "undefined" && OmitoneWebSearch.decisionOf) ? OmitoneWebSearch : null;
  if (!lib) return { cell: "no-lib", on: false, why: "联网搜索模块没加载（登记漏了一处）", host: "" };
  const cfg = {
    apiType: els.apiType.value,
    apiUrl: els.apiUrl.value.trim(),
    apiKey: normalizeApiKey(els.apiKey.value),
    model: els.model.value.trim()
  };
  return lib.decisionOf(cfg, true);
}
function updatePetWebSearchEnabled(on) {
  els.petWebSearchEnabled.className = "toggle" + (on ? " on" : "");
  els.petWebSearchEnabled.setAttribute("aria-checked", on ? "true" : "false");
  refreshWebSearchGate();
}
/** 那一行提示的唯一写入口：灰不灰、说什么，都由 libs 那一格决定，界面只翻译。 */
function refreshWebSearchGate() {
  if (!els.petWebSearchHint) return;
  if (petWebSearchVal === null) {
    // 「还没读到」单独占一格（§2 #12）：这句既不许写成"你没开"，也不许写成"已生效"
    els.petWebSearchHint.textContent = "正在读你的设置…";
    els.petWebSearchHint.dataset.cell = "unknown";
    els.petWebSearchEnabled.removeAttribute("data-greyed");
    return;
  }
  if (petWebSearchVal !== true) {
    els.petWebSearchHint.textContent = PET_WEB_SEARCH_HINT_OFF;
    els.petWebSearchHint.dataset.cell = "off";
    els.petWebSearchEnabled.removeAttribute("data-greyed");
    return;
  }
  const d = petWebSearchDecision();
  els.petWebSearchHint.dataset.cell = d.cell;
  if (d.on) {
    els.petWebSearchEnabled.removeAttribute("data-greyed");
    els.petWebSearchHint.textContent = "已生效：她回答前先自己查一次网页（" + d.host + "）。搜回来的内容按输入 token 计费，比平时贵；查到的日期不一定准，别拿它当今天。";
  } else {
    // 灰掉 = 存储里的选择**保留**（用户换回官方域就自动接上），但界面当场说清为什么没生效
    els.petWebSearchEnabled.setAttribute("data-greyed", d.cell);
    els.petWebSearchHint.textContent = "这一枚暂时用不了：" + d.why + "（开关我留着，换回官方渠道就接上）";
  }
}
const togglePetWebSearchEnabled = async () => {
  const prev = petWebSearchVal;
  const value = prev !== true;
  petWebSearchVal = value;
  updatePetWebSearchEnabled(value);
  try {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ omitonePetWebSearchOn: value ? 1 : 0 }, () => { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  } catch (error) {
    petWebSearchVal = prev;
    updatePetWebSearchEnabled(prev === true);
    reportSaveError(error);
  }
};
els.petWebSearchEnabled.addEventListener("click", togglePetWebSearchEnabled);
els.petWebSearchEnabled.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
    event.preventDefault();
    togglePetWebSearchEnabled();
  }
});
const petWebSearchEnabledLabel = document.querySelector("label[for=\"petWebSearchEnabled\"]");
if (petWebSearchEnabledLabel) {
  petWebSearchEnabledLabel.addEventListener("click", (event) => {
    event.preventDefault();
    togglePetWebSearchEnabled();
  });
}

/** 更新顶部的运行状态指示：圆点 + 文字徽章。
 *  @param {boolean} [initial] 打开弹窗那一次**同步**现状（不是刚刚发生变化）——
 *    以前这次同步也广播，于是每次打开小窗她都要说一句「收工，歇会儿吧」，
 *    把同一刻刚报的「今天一起刷了多久」顶掉（批次 65 的日报断言实测撞在这条上）。
 *    状态照旧要跟（data-busy / 呼吸），只是**别把没发生过的事说成发生过**。 */
function updateRunState(running, initial) {
  if (!els.runDot || !els.runState) return;
  els.runDot.classList.toggle("on", !!running);
  els.runState.classList.toggle("on", !!running);
  // ⚠️ 措辞是「已开启」而不是「运行中」：xxtRunning 是个**持久标记**，
  // 它驱动的是「页面刷新后自动恢复运行」（见 content.js 的 maybeMarkAutoResume）。
  // 用户开启后切到别的网站，扩展并没有在跑，但这个标记仍然是 true ——
  // 写成「运行中」就是骗人。
  els.runState.textContent = running ? "已开启" : "未开启";
  if (shownRunState === !!running) return;
  shownRunState = !!running;
  // 广播给角色：它要知道"现在在不在跑"，但这条链路是**单向只读**的 ——
  // 角色只接收状态，绝不反过来影响运行逻辑。
  try {
    const runEvent = new CustomEvent("omitone:run", { detail: !!running });
    // ⚠️ 首屏同步的标记只能挂在事件对象上：CustomEvent 的 init 只认 detail / bubbles /
    //   cancelable / composed，多余字段会被**静默丢掉**（挂进 detail 又得改所有读它的地方）。
    runEvent.omitoneInitial = !!initial;
    document.dispatchEvent(runEvent);
  } catch (e) {}
}

async function load() {
  const result = await chrome.storage.local.get("config");
  // 运行状态：content.js 一直读 xxtRunning 决定要不要自动跑，但弹窗以前**从来不读** ——
  // 于是打开弹窗完全看不出是不是已开启。这里补上指示（语义见 updateRunState）。
  try {
    const runResult = await chrome.storage.local.get("xxtRunning");
    updateRunState(!!(runResult && runResult.xxtRunning), true);
  } catch (e) {
    updateRunState(false, true);
  }
  storedConfig = withoutRemovedConfigFields(result.config || {});
  config = withoutRemovedConfigFields({ ...DEFAULTS, ...(result.config || {}) });

  autoMaxRateVal = config.autoMaxPlaybackRate !== false;
  slowMachineVal = config.slowMachineMode === "on";
  enableMediaVal = config.enableMedia !== false;
  enablePPTVal = config.enablePPT !== false;
  enableHyperlinkVal = config.enableHyperlink !== false;
  blockedReloadVal = config.blockedReload !== false;
  autoNextVal = config.autoNext !== false;
  autoNextCourseVal = config.autoNextCourse !== false;
  enableQuizVal = config.enableQuiz !== false;
  randomAnswerVal = config.randomAnswer === true;
  enableCaptchaVal = config.enableCaptcha !== false;
  visionEnabledVal = config.visionEnabled === true;
  enableDiscussionVal = config.enableDiscussion !== false;
  enableVoteVal = config.enableVote !== false;
  restudyVal = !!config.restudy;
  updateAutoMaxRate(autoMaxRateVal);
  updateSlowMachine(slowMachineVal);
  updateMedia(enableMediaVal);
  updatePpt(enablePPTVal);
  updateHyperlink(enableHyperlinkVal);
  updateBlockedReload(blockedReloadVal);
  updateAutoNext(autoNextVal);
  updateAutoNextCourse(autoNextCourseVal);
  updateQuiz(enableQuizVal);
  updateRandomAnswer(randomAnswerVal);
  updateCaptcha(enableCaptchaVal);
  updateVision(visionEnabledVal);
  updateDiscussion(enableDiscussionVal);
  updateVote(enableVoteVal);
  updateRestudy(restudyVal);
  // 吉祥物开关不在主配置里，单独读她自己的键（键缺席 = 精致 = 开）
  try {
    chrome.storage.local.get("omitonePagePetMinimal", (r) => {
      if (chrome.runtime.lastError) return;
      pagePetEnabledVal = !(r && r.omitonePagePetMinimal);
      updatePagePetEnabled(pagePetEnabledVal);
    });
  } catch (e) { /* storage 不可用就当开着 */ }
  // 聊天开关也读她自己的键（键缺席 = 关 —— 默认不开，聊天要花 Key 的钱）
  try {
    chrome.storage.local.get("omitonePetChatOn", (r) => {
      if (chrome.runtime.lastError) return;
      petChatEnabledVal = !!(r && r.omitonePetChatOn === 1);
      updatePetChatEnabled(petChatEnabledVal);
    });
  } catch (e) { /* storage 不可用就当关着 */ }
  // 医生提醒开关：键缺席 = 关（要花 Key 的功能不许默认烧钱）。⚠️ 谓词必须与 content.js 那一支同一把尺
  // —— 只认 1 / true 算开，0、false、缺席都算关（AGENTS §2 #23：写入口与读出口两侧基准必须相同）。
  try {
    chrome.storage.local.get("omitonePetDoctorOn", (r) => {
      if (chrome.runtime.lastError) return;
      var raw = r && r.omitonePetDoctorOn;
      petDoctorEnabledVal = raw === 1 || raw === true;
      updatePetDoctorEnabled(petDoctorEnabledVal);
    });
  } catch (e) { /* storage 不可用就当关着 */ }
  // 联网搜索开关：键缺席 = 关（会花钱）。⚠️ 读失败时**保持 null**（还没读到），
  // 不许在这里写 false —— 那一格会让界面把"存储暂时不可用"说成"你没开这枚开关"（AGENTS §2 #12）。
  // 谓词与 content.js 那一支同一把尺：只认 1 / true 算开。
  try {
    chrome.storage.local.get("omitonePetWebSearchOn", (r) => {
      if (chrome.runtime.lastError) return;
      var raw = r && r.omitonePetWebSearchOn;
      petWebSearchVal = raw === 1 || raw === true;
      updatePetWebSearchEnabled(petWebSearchVal);
    });
  } catch (e) { /* 读不出就留在 null：提示那一行会说"正在读你的设置" */ }
  renderApiConnState(config);

  // 预置被删掉之后（老版本存的 minimax 等），这里必须归一化：
  // 把一个不存在的 value 赋给 <select> 只会得到空字符串，接着落盘就把无效值写进 storage，
  // 用户下次打开弹窗看到的是空白下拉框。
  // 判据：认识的预置照用；不认识但填过 API URL（说明是自己配的）→ 归到「自定义 OpenAI 兼容」；
  // 两者都不是（全新安装）→ 落到唯一实测过的 DeepSeek。
  var savedPreset = String(config.providerPreset || "");
  els.providerPreset.value = PROVIDER_PRESETS[savedPreset]
    ? savedPreset
    : (String(config.apiUrl || "").trim() ? "custom-openai" : "deepseek");
  els.apiType.value = config.apiType || "openai";
  els.apiUrl.value = config.apiUrl || "";
  els.apiKey.value = config.apiKey || "";
  els.model.value = config.model || "";
  els.captchaModel.value = config.captchaModel || "";
  els.visionModel.value = config.visionModel || "";
  els.visionBudgetPerChapter.value = config.visionBudgetPerChapter !== undefined ? String(config.visionBudgetPerChapter) : "30";
  // 乱选交卷前的检查秒数：老配置里没这个键时回落 30；**0 要原样显示**（0 = 不自动交卷，是用户的选择）。
  els.randomAnswerReviewSec.value = config.randomAnswerReviewSec !== undefined ? String(config.randomAnswerReviewSec) : "30";
  // 思考强度三行：回填走 rangeForTier（认新键、也认没写过新键的老用户），见那函数上的注释。
  renderThinkingSelects(config);
  els.discussionReply.value = config.discussionReply || "1";
  els.systemPrompt.value = config.systemPrompt || "";
  if (!config.apiUrl || !config.model) {
    applyProviderPreset(els.providerPreset.value);
  }
  // 放在最后：这句依赖 apiUrl / model / 三个场景的区间都已填好。
  // 再等一眼「模型上次自己想到哪一档」那本账 —— content.js 从回包 token 反推后按场景写进存储，
  // 不 await 的话首屏那三行少了后缀，要等用户动一下选择器才补齐（症状是"提示闪一下才全"）。
  await loadThinkingObserved();
  // 联网搜索那一行的灰条依赖刚填好的 apiUrl / apiType，而上面那次存储回调可能比这里先到 ——
  // 那时地址还是空的，会被判成「no-addr」那一格（AGENTS §2 #12：读不出与确实是空，两格）。
  refreshWebSearchGate();
}

function applyProviderPreset(presetId) {
  // 老版本存下来的 providerPreset 可能指向已删除的预置（比如 minimax）。
  // 不归一化的话会命中 custom-openai 那一支，而 `presetId !== "custom-openai"`
  // 仍成立 → 用空字符串覆盖用户已填好的 API URL 与模型名，等于把人家的配置清空。
  if (!PROVIDER_PRESETS[presetId]) presetId = "custom-openai";
  const preset = PROVIDER_PRESETS[presetId];
  els.providerPreset.value = presetId;
  els.apiType.value = preset.apiType;
  if (!els.apiUrl.value.trim() || presetId !== "custom-openai") els.apiUrl.value = preset.apiUrl;
  if (!els.model.value.trim() || presetId !== "custom-openai") els.model.value = preset.model;
  // 换渠道会改变"实际发送什么参数"（DeepSeek 发 thinking、Kimi 不发、自定义发别的），
  // 所以说明文字必须跟着刷新，否则用户会照着上一家的说明理解当前渠道。
  updateThinkingHint();
  // 同一族：联网搜索的资格也完全由这两格决定，切渠道时必须当场重判一次灰条
  refreshWebSearchGate();
}

async function resetDefault() {
  try {
    apiTestGeneration++;
    clearTimeout(apiAutoSaveTimer);
    await patchConfig({ ...DEFAULTS, apiConnectionError: "" });
    // 吉祥物开关也回默认（精致 = 出现）。她的好感度/位置/收起那几格是用户存档，不动。
    try { chrome.storage.local.set({ omitonePagePetMinimal: 0 }); } catch (e) {}
    // 聊天开关也回默认（默认关 —— 用户主动开的付费功能，恢复默认就该收回去）
    try { chrome.storage.local.set({ omitonePetChatOn: 0 }); } catch (e) {}
    // 医生提醒回默认（默认关：会花钱的功能不许默认开着）
    try { chrome.storage.local.set({ omitonePetDoctorOn: 0 }); } catch (e) {}
    // 联网搜索回默认（同样默认关 —— 它比聊天更贵：搜回来的正文按输入 token 计费）
    try { chrome.storage.local.set({ omitonePetWebSearchOn: 0 }); } catch (e) {}
    petWebSearchVal = false;
    await load();
    toast("已恢复默认");
  } catch (error) { reportSaveError(error); }
}

// 这里曾有一个 testApiConnection()：它走 sendMessage({type:'test_api_connection'})
// 交给后台测连通性。但该 handler 只存在于已停用的 legacy/background-core.js 里，
// 现役 background.js 会对它回 "unknown message"，即这条路早已不可用。
// 按钮实际绑定的是 testApiConnectionNoBackground()（它本身也会先尝试后台代理、
// 失败再直连），所以这里整段删除，避免留下一个看着能用实则失效的分支。

async function testApiConnectionNoBackground() {
  const cfg = withoutRemovedConfigFields({
    ...config,
    ...getApiFormConfig()
  });

  if (!cfg.apiKey) {
    toast("请先填写 API Key");
    return;
  }
  if (!cfg.model) {
    toast("请先填写模型名");
    return;
  }
  if ((cfg.apiType === "openai" || cfg.apiType === "gemini") && !cfg.apiUrl) {
    toast("请先填写 API URL");
    return;
  }

  const generation = ++apiTestGeneration;
  // 与 isCurrent / 后台 expectedFingerprint 同一把尺：盘上原样 + 表单，不掺 DEFAULTS 兜底
  const fingerprint = apiFormFingerprint();
  const isCurrent = () => generation === apiTestGeneration && apiFormFingerprint() === fingerprint;
  try {
    clearTimeout(apiAutoSaveTimer);
    await patchConfig(getApiFormConfig());
    els.testApi.disabled = true;
    els.testApi.textContent = "检测中…";
    await appendPopupLog("info", "api test begin from popup direct", apiConfigSummary(cfg));

    const ping = await sendRuntimeMessageWithTimeout({ type: "ping" }, 1500, "background unavailable");
    await appendPopupLog(ping && ping.success ? "info" : "warn", "background ping before api test", ping);

    const result = await testApiConnectionDirect(cfg);
    if (!isCurrent()) {
      toast("配置已变化，请重新检测");
      return;
    }
    await appendPopupLog(result && result.success ? "info" : "warn", "api test result", {
      success: !!(result && result.success),
      error: result && result.error ? String(result.error).slice(0, 300) : "",
      endpoint: result && result.endpoint ? result.endpoint : "",
      config: apiConfigSummary(cfg)
    });

    if (!isCurrent()) { toast("配置已变化，请重新检测"); return; }
    await patchConfig({
      apiConnectionFailed: !(result && result.success),
      apiConnectionError: result && result.success ? "" : String((result && result.error) || "connection failed").slice(0, 300)
    }, fingerprint);
    if (!isCurrent()) { toast("配置已变化，请重新检测"); return; }
    // result.error 已是分类后的人话（libs/api-error.js）—— 不再加「连接失败：」前缀，
    // 否则「连接失败：【账户余额不足】…」会让用户继续往网络方向查
    toast(result && result.success ? "连接正常" + (result.message ? "：" + result.message : "") :
      ((result && result.error) || "未知错误"));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!isCurrent() || error.code === "stale_config") { toast("配置已变化，请重新检测"); return; }
    // 本地这一跳就断了（保存被拒 / 后台没响应）—— 它**不是**服务商的错，不许进分类器。
    // 以前这里不分来源一律 describe(0, message)，于是同学机器上看到的是
    // 「【连接不上服务商】网络不通、被代理/防火墙拦截……服务商原话：保存被拒：没认出这是设置弹窗」：
    // 一句本机的权限判断被贴了「服务商原话」，人就跑去查校园网和代理，而网络这一层根本没参与。
    if (error && error.localBridge) {
      try {
        await appendPopupLog("error", "api test never sent: local bridge rejected", {
          error: message.slice(0, 300), code: String(error.code || ""), detail: String(error.detail || "")
        });
      } catch (e) {}
      toast(message);
      return;
    }
    // 走到这里才说明请求真的发不出去（fetch 抛异常）—— 这才是「连接失败」。
    // 也要翻译成人话：Failed to fetch / Timeout 对用户没有信息量
    const described = (typeof self !== "undefined" && self.OmitoneApiError)
      ? self.OmitoneApiError.describe(0, message)
      : { category: "network", human: message };
    try { await patchConfig({ apiConnectionFailed: true, apiConnectionError: described.human.slice(0, 300) }, fingerprint); } catch (e) {}
    await appendPopupLog("error", "api test direct failed", { error: described.human.slice(0, 300), category: described.category });
    toast(described.human);
  } finally {
    els.testApi.disabled = false;
    els.testApi.textContent = "检测 API 连接";
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

async function startRun() {
  const operation = ++runOperation;
  try {
    clearTimeout(apiAutoSaveTimer);
    await saveApiConfig(false);
    await saveToggleConfig(false);
    if (operation !== runOperation) return;
    const [tab] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000, "读取标签页超时");
    if (!tab) { toast("未找到当前标签页"); return; }
    const result = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "xxt_start" }), 10000, "启动请求超时");
    if (operation !== runOperation) return;
    if (!result || !result.success) {
      toast(result && result.code === "unsupported_page" ? "请在学习通页面使用；外站验证码需单独授权" : "启动未被接受，请刷新页面后重试");
      return;
    }
    updateRunState(true);
    toast("启动请求已接受");
  } catch (error) {
    if (operation === runOperation) toast("启动失败：" + (error && error.message ? error.message : "请刷新页面后重试"));
  }
}

async function authorizeCurrentCaptcha(revoke) {
  try {
    const [tab] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000, "读取标签页超时");
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) { toast("当前页不支持验证码授权"); return; }
    if (POLICY.isChaoxingUrl(tab.url)) { toast("学习通页面无需额外授权"); return; }
    if (!revoke && !window.confirm("仅为当前标签页临时开放验证码识别（10 分钟，换网址失效）？\n" + new URL(tab.url).origin)) return;
    const result = await sendRuntimeMessageWithTimeout({
      type: revoke ? "revoke_captcha" : "grant_captcha", payload: { tabId: tab.id, url: tab.url }
    }, 8000, "授权操作超时");
    if (!result || !result.success) { toast("操作失败，当前页面可能已变化"); return; }
    if (revoke) { toast("已撤销当前页授权"); return; }
    const started = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "xxt_start" }), 10000, "验证码启动超时");
    toast(started && started.success ? "当前页已临时授权，仅用于验证码" : "已授权，请刷新当前验证码页面");
  } catch (error) { reportSaveError(error); }
}

// 日志视图只接收所需能力，Chrome/剪贴板留在宿主；不与设置表单或运行状态共享生命周期。
const popupLogView = self.OmitonePopupLogView.create({
  document,
  panel: els.logPanel,
  toggleButton: els.toggleLogs,
  readLogs: () => chrome.storage.local.get(RUNTIME_LOGS_KEY).then((result) =>
    result && Array.isArray(result[RUNTIME_LOGS_KEY]) ? result[RUNTIME_LOGS_KEY] : []),
  clearLogs: () => sendRuntimeMessageWithTimeout({ type: "runtime_log_clear" }, 20000, "日志清空超时"),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  notify: toast,
  version: () => chrome.runtime.getManifest().version,
  now: Date.now,
  setTimeout,
  clearTimeout
});
window.addEventListener("pagehide", () => popupLogView.dispose());

[els.systemPrompt, els.discussionReply, els.visionBudgetPerChapter, els.randomAnswerReviewSec].forEach((el) => {
  el.addEventListener("change", () => { saveToggleConfig().catch(reportSaveError); });
});

els.providerPreset.addEventListener("change", async () => {
  apiTestGeneration++;
  clearTimeout(apiAutoSaveTimer);
  applyProviderPreset(els.providerPreset.value);
  try { await saveApiConfig(false); toast("已切换接入方式"); } catch (error) { reportSaveError(error); }
});

// API 表单自动保存（防抖 800ms）：输入即落盘。
// 此前只有点「保存 API」按钮才写 storage，直接关掉弹窗等于全部丢失——
// 用户以为配置过了，实际运行时 apiKey 还是空的，症状是「AI 答题不生效」却查不出原因。
// apiType 下拉此前甚至完全没有监听，单独切换协议类型永远不会保存。
let apiAutoSaveTimer = null;
function scheduleApiAutoSave() {
  apiTestGeneration++;
  clearTimeout(apiAutoSaveTimer);
  apiAutoSaveTimer = setTimeout(async () => {
    try { await saveApiConfig(false); toast("API 配置已自动保存"); } catch (error) { reportSaveError(error); }
  }, 800);
}
[els.apiUrl, els.apiKey, els.model, els.captchaModel, els.visionModel].forEach((el) => {
  el.addEventListener("input", scheduleApiAutoSave);
});
// 地址/模型名一改，渠道就可能变（自定义渠道尤其如此），说明文字要跟着变
[els.apiUrl, els.model].forEach((el) => {
  el.addEventListener("input", updateThinkingHint);
});
els.apiType.addEventListener("change", scheduleApiAutoSave);

// 联网搜索的灰条要跟着**这四格**动：地址、协议、Key（缺一格就是一格不同的原因）。
// ⚠️ 少监听任何一格，症状都是"用户改了地址、那一行还在说旧渠道的话" ——
// 不报错、不留日志（AGENTS §2 #18：声明覆盖的范围与实际走的分支之间的差，不会自己喊出来）。
[els.apiUrl, els.apiType, els.apiKey].forEach((el) => {
  el.addEventListener("input", refreshWebSearchGate);
  el.addEventListener("change", refreshWebSearchGate);
});

// 思考强度：六格上下限，任一格改动 = 同一行另一头不许越界（选倒时以刚动的这一头为准），
// 再整组落盘 + 刷新"当前实际发送"。
// ⚠️ 倒着写的组合 rangeFromForm 也会排好再发，但界面上留一个倒着的选框，
// 用户按看到的理解成本、系统按排好的花钱 —— 两边读出的不是同一件事。
THINK_TIERS.forEach((tier) => {
  const minEl = thinkSel(tier, "min");
  const maxEl = thinkSel(tier, "max");
  [minEl, maxEl].forEach((el) => {
    el.addEventListener("change", async () => {
      apiTestGeneration++;
      if (typeof OmitoneThinking !== "undefined"
        && OmitoneThinking.levelRank(minEl.value) > OmitoneThinking.levelRank(maxEl.value)) {
        (el === minEl ? maxEl : minEl).value = el.value;
      }
      updateThinkingHint();
      try { await saveApiConfig(false); toast("思考强度已保存"); } catch (error) { reportSaveError(error); }
    });
  });
});

els.reset.addEventListener("click", resetDefault);
els.saveApi.addEventListener("click", async () => {
  clearTimeout(apiAutoSaveTimer);
  try { await saveApiConfig(true); await saveToggleConfig(false); } catch (error) { reportSaveError(error); }
});
const grantCaptchaButton = $("grantCaptcha");
const revokeCaptchaButton = $("revokeCaptcha");
if (grantCaptchaButton) grantCaptchaButton.addEventListener("click", () => authorizeCurrentCaptcha(false));
if (revokeCaptchaButton) revokeCaptchaButton.addEventListener("click", () => authorizeCurrentCaptcha(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.xxtRunning) updateRunState(!!changes.xxtRunning.newValue);
  // 存到局部变量再取 newValue：配置接线守卫按 `config.键名` 字面量扫描读取点，
  // 这里的 changes.config 是 storage 变更包不是用户配置，不能让守卫误读
  const cfgChange = changes.config;
  if (cfgChange) renderApiConnState(cfgChange.newValue);
});
els.testApi.addEventListener("click", testApiConnectionNoBackground);
// 「这一轮退不退」那一发：把点击**转交给那枚真开关**，不在这里再写一份翻格 + 保存 + 失败回滚。
// 为什么走 click 而不是自己 patchConfig：那枚开关的链路（翻内存 → saveToggleConfig →
// 保存被拒就把内存翻回去并 reportSaveError）是盘上唯一一份、也是已经测过的那一份，
// 复制第二份就会各自漂移；更糟的是漏了回滚那一半时，界面说「在乱选」而盘上没写。
// ⚠️ 这一族**没有任何自动路径**：全仓库只有这里和那枚开关本身会翻 randomAnswer，
// 页面侧只读它（_isRandomAnswerMode），答题失败链路一条都不许写它。
(() => {
  const btn = document.getElementById("apiRetreatBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const sw = document.getElementById("randomAnswer");
    // 找不到开关时说明弹窗结构被改坏了：说一句就收，不许静默什么都不发生
    if (!sw) { toast("找不到「乱选」那枚开关，请重装扩展或到「答题」那一栏手动翻它"); return; }
    sw.click();
  });
})();
// 「获取模型列表」与「检测 API 连接」是两件事：那一发要花钱（发一条消息），这一发只问清单。
// 守卫：els 里这一枚取自 popup.html 的 #listModels —— 没有它启动就当场抛，
// 比"按钮存在但点了没反应"好查（与上面 testApi 同一口径）。
els.listModels.addEventListener("click", listModelsFromProvider);
els.start.addEventListener("click", startRun);
els.stop.addEventListener("click", async () => {
  ++runOperation;
  try {
    await withTimeout(chrome.storage.local.set({ xxtRunning: false }), 5000, "停止状态保存超时");
    updateRunState(false);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // 只刷新普通网页：扩展自己的页面（弹窗被当标签页打开时）刷新会把自己打断，
    // 而且那种场景下刷新没有任何意义。
    if (tab && !/^chrome-extension:\/\//i.test(tab.url || "")) {
      try { await chrome.tabs.reload(tab.id); } catch (reloadErr) {}
    }
    toast("已停止自动运行");
  } catch (error) {
    toast("停止失败，请手动刷新页面");
  }
});
els.toggleLogs.addEventListener("click", () => { popupLogView.toggle().catch(() => toast("日志读取失败")); });
els.clearLogs.addEventListener("click", () => { popupLogView.clear().catch(() => toast("日志清空失败，请稍后重试")); });

/**
 * 把运行日志拼成**纯文本**，供「复制日志」用。
 *
 * 单独抽成函数是为了**能被测**：剪贴板写入在无头环境里可能被拒（需要用户手势），
 * 拿它当断言会得到一条时好时坏的测试。格式化逻辑本身是纯函数，直接测它 ✓。
 */
function buildLogsText(logs, version) {
  return self.OmitonePopupLogView.buildLogsText(logs, version);
}

/**
 * 「复制日志」——把日志整段复制成**纯文本**，用户直接粘贴就能发出来。
 *
 * 为什么要有这个按钮：日志本身早就能看（「查看日志」），但**没法送出来** ——
 * 用户要么截 200 行长图，要么在弹窗里手工选中复制（弹窗一失焦还可能被关掉）。
 * 而"整章被跳过""某个任务点不做"这类问题**只能靠日志定位**，
 * 送不出来就等于查不了。所以这一步不是锦上添花，是**诊断链路的最后一环**。
 */
els.copyLogs.addEventListener("click", () => { popupLogView.copy().catch(() => toast("复制日志失败")); });

// ── 检测更新 ────────────────────────────────────────────────────────────────
//
// 判据两条，按可靠性排序：
//   ① 线上 tag_name 的版本号更高 → 一定有新版本；
//   ② 版本号相同、但线上 zip 的更新时间比**本机这份代码的构建时间**还新
//      → 同一个版本号里换过包（本项目「合并不升版本」的做法就会这样）。
// ② 靠的是 `version_name` 里的构建戳（形如 `1.2.8 b20261019-1400`，由 tools/build.js 写进产物）。
// **直接加载源码目录**的安装没有这个戳 —— 那就只比版本号，绝不瞎猜"要不要更新"。
const UPDATE_REPO = "TYT0807/Omitone";
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_ZIP = `https://github.com/${UPDATE_REPO}/releases/latest/download/omitone.zip`;

// 预览版（实验支线）那一格，2026-11-20 用户口径：「实验班也可以加入 readme 的正常下载的旁边，
// 特别标明就行」＋「更新提示那边也可以展示预览版，显示存在预览版，可以更新，但是需要多斟酌考虑」。
// ⚠️ 三条硬规矩，每条都对应一次「命令都打印成功、结果不对」的事故形状：
//   1) 查询走 `releases/tags/preview` 这条**独立地址**，绝不并进上面那条 ——
//      预览口还没发时它 404，而 404 必须只让这一格闭嘴，不许把正式版已经说出口的结论顶掉；
//   2) 下载走 `releases/download/preview/omitone-preview.zip` 这个**独立文件名**，
//      绝不复用 `UPDATE_ZIP` —— 那条按名字取件，复用等于把装预览的人悄悄退回正式版；
//   3) 这一格只在「预览号 > 本地号」时才说话；号读不出就**当作没有**，不猜（AGENTS §2 #1）。
const UPDATE_PREVIEW_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/preview`;
const UPDATE_PREVIEW_ZIP = `https://github.com/${UPDATE_REPO}/releases/download/preview/omitone-preview.zip`;
const UPDATE_PREVIEW_ASSET = "omitone-preview.zip";

// ⚠️ 限流是**功能**，不是防抖。
// 查询用的是 GitHub 的**匿名额度**（作者不放令牌，也不能放）。有人狂点就会把额度用光，
// 那时**所有人都查不了** —— "你查得勤"和"别人查不到"其实是同一件事的两面。
// 所以：手动 6 小时一次，自动 24 小时一次。
const UPDATE_AT = { manual: "omitone.update.manualAt", auto: "omitone.update.autoAt" };
// 静默期：用户嫌烦就让他选"多久之内别再提醒"。存天数，0 = 正常，-1 = 永久
const UPDATE_MUTE_KEY = "omitone.update.muteDays";
function getMuteDays() {
  try { return Number(localStorage.getItem(UPDATE_MUTE_KEY) || 0); } catch (e) { return 0; }
}
function isUpdateMuted() { return getMuteDays() !== 0; }
const UPDATE_GAP = { manual: 6 * 3600 * 1000, auto: 24 * 3600 * 1000 };

function updateSeenAt(kind) {
  try { return Number(localStorage.getItem(UPDATE_AT[kind]) || 0); } catch (e) { return 0; }
}
function markUpdateSeen(kind) {
  try { localStorage.setItem(UPDATE_AT[kind], String(Date.now())); } catch (e) {}
}
function fmtWait(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} 分钟` : `${Math.round((m / 60) * 10) / 10} 小时`;
}

function localBuildInfo() {
  let manifest = null;
  try { manifest = chrome.runtime.getManifest(); } catch (e) { manifest = null; }
  const version = String((manifest && manifest.version) || "");
  const name = String((manifest && manifest.version_name) || "");
  const m = name.match(/\bb(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\b/);
  const builtAt = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0;
  return { version, name, builtAt };
}

/** 只比较数字段，`1.3` 与 `1.3.0` 视为相同；返回 1 / 0 / -1 */
function cmpVersion(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 稳定通道那句话：六格各说各话，返回 `{ text, offer }`。
 *  `offer` 为真才摊开「是否更新」那两个键 —— 让"说话"与"给按钮"是同一个判定，
 *  不许调用方再写第二份版本比较（预览版与开发构建压成一句就是这么来的）。
 *  六格：有新版 / 同号换了包 / 本地是预览版 / 本地是开发构建 / 源码目录安装（无构建戳）/ 已是最新。 */
function stableUpdateMessage(versionOrder, remoteVersion, local, newerBuild, remoteAt) {
  const name = String((local && local.name) || "");
  const version = local && local.version;
  if (versionOrder > 0) {
    return { text: `有最新版 ${remoteVersion}（本地 ${version}）—— 可能相对现版本不够稳定，是否更新？`, offer: true };
  }
  if (newerBuild) {
    return { text: `线上的包比本地新（${fmtTime(remoteAt)}）—— 可能相对现版本不够稳定，是否更新？`, offer: true };
  }
  if (versionOrder < 0 && /experimental/i.test(name)) {
    return { text: `你在用预览版 ${version}（实验支线）；最新正式版是 ${remoteVersion}。普通用户请用正式版。`, offer: false };
  }
  if (versionOrder < 0) {
    return { text: `本地 ${version} 高于线上 ${remoteVersion} —— 这是开发构建；普通用户请用正式版。`, offer: false };
  }
  if (!(local && local.builtAt)) {
    // 源码目录安装：没有构建戳，只能确认版本号一致，别硬说"最新"
    return { text: `当前 ${version}（本地安装 · 版本号与线上最新一致）`, offer: false };
  }
  return { text: "你已经是最新版了", offer: false };
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function checkUpdate(opts) {
  const manual = !!(opts && opts.manual);
  const kind = manual ? "manual" : "auto";

  // 限流：手动 6 小时一次、自动 24 小时一次（理由见上面的注释）
  // 静默期内不做**自动**检测（手动点还是要让他查）
  if (!manual && isUpdateMuted()) return;

  const last = updateSeenAt(kind);
  if (last && Date.now() - last < UPDATE_GAP[kind]) {
    if (manual) {
      els.updateMsg.textContent =
        `刚查过，${fmtWait(UPDATE_GAP[kind] - (Date.now() - last))}后再来 —— 查太勤会把匿名名额用光，大家都用不了`;
    }
    return;
  }

  const local = localBuildInfo();
  els.doUpdate.style.display = "none";
  els.doLater.style.display = "none";
  els.doUntil.style.display = "none";
  els.updateRow.classList.remove("hot");
  // 预览那一格每轮先收掉再问：上一轮亮着的话，这一轮查不到却还挂着按钮，
  // 点下去就是一个已经不存在的预览包（AGENTS §2 #12 ——「没结论」不许借用「有结论」的界面）
  hidePreviewChannel();
  // 正式版号：预览那一格要拿它比一比，防止「转正之后预览口没撤」把同学引到一份旧实验包上
  let stableRemote = "";
  if (manual) {
    els.updateMsg.textContent = "正在检测…";
    els.checkUpdate.disabled = true;
  }

  // 限流要在这里落地：上面那道闸读的就是这个时间戳，而**以前从来没人写过它** ——
  // `markUpdateSeen` 全仓库只有定义、没有调用点，于是「手动 6 小时 / 自动 24 小时」
  // 一直是空的：每次开弹窗都真实打一次 api.github.com，用的是作者的匿名额度
  // （查得勤 = 大家都查不到）。
  // 写在**发请求之前**而不是成功之后：查失败同样把额度用掉了，
  // 而且「失败了就再点几下」正是最常见的那种刷法。
  markUpdateSeen(kind);

  try {
    const res = await fetch(UPDATE_API, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    try { localStorage.setItem(UPDATE_SEEN_KEY, String(Date.now())); } catch (e) {}

    const remoteVersion = String(rel.tag_name || "").replace(/^v/i, "");
    stableRemote = remoteVersion;
    const asset = (rel.assets || []).find((a) => a && a.name === "omitone.zip");
    const remoteAt = asset && asset.updated_at ? new Date(asset.updated_at).getTime() : 0;

    const versionOrder = cmpVersion(remoteVersion, local.version);
    // 同一版本号换了包。容差必须盖过「构建 → 上传」这段固有间隔，否则**每个从 zip 装的人
    // 都会永久看到「线上的包比本地新」**——包就是从那一次构建上传的，上传必然晚于构建：
    //   1.2.8 构建 22:52 / 上传 22:55（3 分钟）
    //   1.2.9 构建 16:38 / 上传 16:43（5 分钟）
    //   1.3.0 构建 20:37 / 上传 20:40（3 分钟）  ← 旧代码的容差只有 60 秒，所以同学一装上就报更新
    // 30 分钟既能盖住这条流水线，又拦得住真正的换包：重发一次附件意味着又一轮修复，
    // 中间隔着的是小时级、天级（实测 1.2.9 → 1.3.0 隔 21 天），不会是半小时。
    const newerBuild = versionOrder === 0 && local.builtAt > 0 && remoteAt > 0 &&
      remoteAt - local.builtAt > 30 * 60 * 1000;

    // 文案原则：一句话说清"是什么 / 要不要动"。判定只许有 `stableUpdateMessage` 那一份。
    const verdict = stableUpdateMessage(versionOrder, remoteVersion, local, newerBuild, remoteAt);
    els.updateMsg.textContent = verdict.text;
    if (verdict.offer) showUpdateChoices();
  } catch (error) {
    // 查不到就只说查不到：不猜原因、也不给"是不是最新"的结论。
    // 网络、代理、GitHub 匿名额度用光、本机时间偏差……都可能。
    els.updateMsg.textContent = "歪比八布，你的网络或者作者的匿名名额正在睡大觉（别连点，过一会儿再看）";
    showUpdateChoices();
  } finally {
    els.checkUpdate.disabled = false;
  }

  // 预览版那一格排在正式版之后，而且**自己一个 try**：
  // 预览口 404（没发过）与断网在这里是同一种表现 —— 都只许让这一格闭嘴。
  // 要是让它共享上面那个 catch，「预览口还没发」就会被说成「网络或名额在睡大觉」，
  // 那句假话还会顺手把刚说出口的正式版结论盖掉（AGENTS §2 #14：谁先说话是要紧事）。
  try {
    await checkPreviewChannel(local, stableRemote);
  } catch (e) {}
}

/** 有更新（或查不出来）时，把"是/否"两个选项亮出来 */
function showUpdateChoices() {
  els.doUpdate.style.display = "";
  els.doLater.style.display = "";
  els.updateRow.classList.add("hot");
}

/** 收掉预览那一格（每轮检测开头、以及所有「不说话」的分支） */
function hidePreviewChannel() {
  if (els.previewMsg) els.previewMsg.style.display = "none";
  if (els.doPreview) els.doPreview.style.display = "none";
}

/** 把「这一格该不该说话」判完，只回一个值，一个字 DOM 都不碰。
 *  分成这样是因为集成层能把真函数取出来直接喂形状（AGENTS §5「桩打在动作上」），
 *  `why` 那几格**谁都不许合并**：404、读不出号、不比本地新、和正式版同号，
 *  四格都说"闭嘴"，但只有分开写才测得出某一格坏了（AGENTS §2 #12）。 */
function previewPlan(rel, fetched, local, stableVersion) {
  if (!fetched || !rel) return { speak: false, why: "ask-failed" };
  const name = String(rel.name || "");
  const tag = String(rel.tag_name || "");
  // 号从 tag 里找，找不到再从标题里找 —— `preview` 那个 tag 本身没有版本号，
  // 号写在发布标题「预览版 1.3.1 experimental b…」上（tools/github-release.js 的 cmdPreview 写的就是它）
  const found = (tag.match(/\d+\.\d+(?:\.\d+)?/) || name.match(/\d+\.\d+(?:\.\d+)?/) || [])[0] || "";
  if (!found) return { speak: false, why: "no-version" };
  // 包必须真在（点了才下得到东西）。`assets` 不是数组或没这个名字 → 这一格不说话，
  // 也不许"照旧亮按钮"：那样点下去是 GitHub 的 404 页，而它看起来像"预览版没了"
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const asset = assets.find((a) => a && a.name === UPDATE_PREVIEW_ASSET);
  if (!asset) return { speak: false, why: "no-asset" };
  // 转正之后预览口若忘了撤：预览号已经不比正式版新 → 那是**一份旧实验包**，
  // 同学装上会一直被告知自己在用预览版；不说话，等维护者收口
  if (stableVersion && cmpVersion(found, stableVersion) <= 0) {
    return { speak: false, why: "same-as-stable" };
  }
  // 已经装了这一支（或更高）的人不用再告诉他"有预览版"
  if (local && local.version && cmpVersion(found, String(local.version)) <= 0) {
    return { speak: false, why: "not-newer" };
  }
  return { speak: true, why: "show", version: found, stamp: asset.updated_at || "" };
}

/** 问一次预览口并落地那一格。回 `previewPlan` 的值，测试与日志都要靠它归因。 */
async function checkPreviewChannel(local, stableVersion) {
  let rel = null;
  let fetched = false;
  try {
    // withTimeout 是这里唯一的悬挂防线：预览口挂在半空不许把整次检测拖死
    const res = await withTimeout(
      fetch(UPDATE_PREVIEW_API, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } }),
      12000, "预览版查询超时");
    fetched = !!(res && res.ok);            // 404 = 还没发预览口，这是常态，不是错误
    if (fetched) rel = await res.json();
  } catch (e) {
    rel = null;
    fetched = false;
  }
  const plan = previewPlan(rel, fetched, local, stableVersion);
  if (!plan.speak) {
    hidePreviewChannel();
    return plan;
  }
  if (els.previewMsg) {
    els.previewMsg.textContent =
      `🧪 另有预览版 ${plan.version}（实验支线，比正式版新 · 可选，不影响正式版）—— 它可能把你正在刷的课弄坏。` +
      `手上没有正在赶的课、出问题说得清症状（哪门课 · 哪一节 · 什么现象），再装；` +
      `想退回正式版：移除这一枚，重装 omitone.zip 就行。`;
    els.previewMsg.style.display = "";
  }
  if (els.doPreview) els.doPreview.style.display = "";
  return plan;
}

if (els.checkUpdate) {
  els.checkUpdate.addEventListener("click", () => checkUpdate({ manual: true }));
}

// 静默期下拉：选完立刻生效（下次打开也记得）
if (els.updateMute) {
  els.updateMute.value = String(getMuteDays());
  els.updateMute.addEventListener("change", () => {
    try { localStorage.setItem(UPDATE_MUTE_KEY, String(Number(els.updateMute.value) || 0)); } catch (e) {}
    const d = getMuteDays();
    els.updateMsg.textContent = d === 0 ? "已恢复更新提醒"
      : d === -1 ? "已设为不再提醒更新（随时可手动检测）"
      : `已静默 ${d} 天，期间不自动提醒（仍可手动检测）`;
  });
}

if (els.doUpdate) {
  els.doUpdate.addEventListener("click", () => {
    els.doUpdate.style.display = "none";
    els.doLater.style.display = "none";
    els.updateMsg.textContent = "正在下载…";

    // 下载完自动在资源管理器里**定位到那个 zip** —— 省掉"去下载文件夹里翻"这一步。
    // 再往下（解压覆盖、重新加载）浏览器不允许扩展代劳，只能给出动作。
    const fallback = () => {
      els.updateMsg.textContent = "下载没成功 —— 点这里手动下：omitone.zip";
      chrome.tabs.create({ url: UPDATE_ZIP });
    };
    try {
      chrome.downloads.download({ url: UPDATE_ZIP, saveAs: false, conflictAction: "overwrite" }, (id) => {
        if (chrome.runtime.lastError || !id) { fallback(); return; }
        const onChanged = (delta) => {
          if (!delta || delta.id !== id || !delta.state) return;
          if (delta.state.current !== "complete") return;
          chrome.downloads.onChanged.removeListener(onChanged);
          try { chrome.downloads.show(id); } catch (e) {}
          els.updateMsg.textContent = "已下载 —— 解压覆盖到扩展目录，再点「重新加载」，最后 F5";
          els.doUntil.style.display = "";
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });
    } catch (e) {
      fallback();
    }
  });
}

if (els.doLater) {
  els.doLater.addEventListener("click", () => {
    els.doUpdate.style.display = "none";
    els.doLater.style.display = "none";
    els.updateMsg.textContent = "好，先不更新";
  });
}

// 预览版那一枚按钮：**地址只用 UPDATE_PREVIEW_ZIP，一个字的 UPDATE_ZIP 都不许出现在这里**。
// 复用上面那个下载口 = 装预览的人在不知情下退回正式版，而两条通道各自的说法全乱了。
if (els.doPreview) {
  els.doPreview.addEventListener("click", () => {
    els.doPreview.style.display = "none";
    els.updateMsg.textContent = "正在下载预览包…";
    const fallback = () => {
      els.updateMsg.textContent = "下载没成功 —— 点这里手动下：omitone-preview.zip";
      chrome.tabs.create({ url: UPDATE_PREVIEW_ZIP });
    };
    try {
      chrome.downloads.download({
        url: UPDATE_PREVIEW_ZIP, saveAs: false, conflictAction: "uniquify"
      }, (id) => {
        if (chrome.runtime.lastError || !id) { fallback(); return; }
        els.updateMsg.textContent =
          "预览包已下载 —— 解压覆盖到扩展目录，再点「重新加载」，最后 F5。" +
          "想退回正式版：移除这一枚，重装 omitone.zip。";
        els.doUntil.style.display = "";
      });
    } catch (e) {
      fallback();
    }
  });
}

if (els.doUntil) {
  els.doUntil.addEventListener("click", () => {
    chrome.tabs.create({ url: "edge://extensions" });
  });
}

// 打开弹窗时静默检测一次（24 小时内不重复）——不打扰，发现问题才亮「是，覆盖更新」
document.addEventListener("DOMContentLoaded", () => {
  // 先把"我现在是哪一版"写清楚（含构建戳）——用户截图/报问题时能直接看到
  try {
    const local = localBuildInfo();
    if (els.updateMsg && local.version) {
      els.updateMsg.textContent = "当前版本 " + (local.name || local.version);
    }
  } catch (e) {}

  try {
    const last = updateSeenAt("auto");
    if (!last || Date.now() - last > UPDATE_GAP.auto) checkUpdate({ manual: false });
  } catch (e) {}
});

// ── 分组折叠状态记忆 ────────────────────────────────────────────────────────
//
// 想要的行为：把「播放」折叠起来、弹窗挂在旁边，下次打开**还是折叠着**；
// 但**浏览器大退**（或扩展重新加载）之后回到默认（播放展开、其余收起）。
// 正好是 `chrome.storage.session` 的语义：随浏览器会话存在，浏览器一关就清空。
const GROUP_STATE_KEY = "omitone.popup.groups";

function groupKeyOf(node, index) {
  const span = node.querySelector("summary span");
  const text = String((span && span.textContent) || "").trim();
  return text || ("#" + index);
}

async function restoreGroupState() {
  const groups = Array.from(document.querySelectorAll("details.group"));
  if (!groups.length) return;

  try {
    const saved = (await chrome.storage.session.get(GROUP_STATE_KEY))[GROUP_STATE_KEY];
    if (saved && typeof saved === "object") {
      groups.forEach((node, i) => {
        const want = saved[groupKeyOf(node, i)];
        if (typeof want === "boolean") node.open = want;
      });
    }
  } catch (e) {}

  // 任何一次手动开合都存一份完整快照 —— 比逐项记录更不容易出错
  const persist = () => {
    const map = {};
    groups.forEach((node, i) => { map[groupKeyOf(node, i)] = node.open; });
    try { chrome.storage.session.set({ [GROUP_STATE_KEY]: map }); } catch (e) {}
  };
  groups.forEach((node) => {
    node.addEventListener("toggle", () => {
      persist();
      if (!node.open) return;
      // 每次展开都重放"逐行浮起"：先摘类 → 强制一次布局 → 再挂上（否则第二次不触发）
      node.classList.remove("is-opening");
      void node.offsetWidth;
      node.classList.add("is-opening");
      clearTimeout(node._openTimer);
      node._openTimer = setTimeout(() => node.classList.remove("is-opening"), 700);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  restoreGroupState();
});

// ── 界面模式：精简（默认，1.2.8 那种素净样子）/ 精美（角色 + 粒子 + 玻璃） ──
// 切换会**重新加载**页面 —— 两套模式差别太大，热切换容易留下半截状态。
(function uiMode() {
  try {
    var UI_KEY = "omitone.ui.mode";
    var forced = new URLSearchParams(location.search).get("ui");
    var mode = forced || localStorage.getItem(UI_KEY) || "lite";
    var isFancy = mode === "fancy";
    document.documentElement.setAttribute("data-ui", isFancy ? "fancy" : "lite");
    var sw = document.getElementById("modeSwitch");
    if (!sw) return;
    sw.setAttribute("data-on", isFancy ? "1" : "0");
    sw.setAttribute("aria-checked", isFancy ? "true" : "false");
    sw.addEventListener("click", function () {
      var next = isFancy ? "lite" : "fancy";
      try { localStorage.setItem(UI_KEY, next); } catch (e) {}
      sw.setAttribute("data-on", next === "fancy" ? "1" : "0");
      sw.setAttribute("aria-checked", next === "fancy" ? "true" : "false");
      // 等滑块滑到位再重启，否则看不到那一下动画
      setTimeout(function () { location.reload(); }, 280);
    });
  } catch (e) {}
})();

// ── 沉浸式窗口 / 自定义背景 ────────────────────────────────────────────────
//
// 三个约束值得写下来：
//   ① 浏览器**不允许弹窗自己改尺寸**（resizeTo 对 extension popup 无效），
//      所以「展开」只能新开一个更大的窗口 —— 用 ?play=1 区分模式，不复用第二套页面。
//   ② chrome.windows.create 里的 width/height **会被忽略** —— Edge 记住了同一
//      URL 上一次的窗口位置（现场实测：请求 760x680，开出来 1400x900）。
//      认账的是新窗口自己补的那一发 chrome.windows.update，所以尺寸走 URL 传参。
//   ③ 自定义背景要落盘，但 storage.local 只有 10MB。
//      所以上传时先缩到最长边 1600px、JPEG 质量 0.72 —— 通常 150~350KB，够用且不撑爆。
(function omScene() {
  // 目标尺寸按**屏幕可用区**算，不许写死 —— 现场那台 1.5 倍缩放、可用区 1707x912 的
  // 机器上写死的 760x680 只是"能用"，换到 768 高的笔记本就顶出任务栏。
  function immersiveTarget() {
    var aw = Math.max(560, Number(screen.availWidth) || 1280);
    var ah = Math.max(520, Number(screen.availHeight) || 800);
    return {
      w: Math.max(560, Math.min(820, Math.round(aw * 0.52))),
      h: Math.max(440, Math.min(700, Math.round(ah * 0.8)))
    };
  }

  // 沉浸式窗口 onLoad 把自己拉到目标尺寸（见上面 ②）。
  // 只在 URL 带了 w/h 时才动手：测试台与任何"我就想按这个尺寸开"的调用方
  // 不带这两个参数，进来就别改 —— 否则会把别人刚设好的尺寸抢回去。
  function fitToQuerySize() {
    var q = new URLSearchParams(location.search);
    var w = Math.round(Number(q.get("w"))), h = Math.round(Number(q.get("h")));
    if (!(w >= 320 && w <= 4000 && h >= 320 && h <= 4000)) return;
    try {
      chrome.windows.getCurrent(function (win) {
        try {
          if (!win || win.id == null) return;
          if (Math.abs(win.width - w) < 24 && Math.abs(win.height - h) < 24) return;
          var aw = Number(screen.availWidth) || 1280, ah = Number(screen.availHeight) || 800;
          var al = Number(screen.availLeft) || 0, at = Number(screen.availTop) || 0;
          chrome.windows.update(win.id, {
            left: Math.max(al, Math.round(al + (aw - w) / 2)),
            top: Math.max(at, Math.round(at + (ah - h) / 2)),
            width: w, height: h
          });
        } catch (e) {}
      });
    } catch (e) {}
  }

  try {
    var params = new URLSearchParams(location.search);
    // 之前 ?play=1 只改了窗口尺寸、从来没加 .im —— 于是打开后就是一张放大的
    // 普通弹窗，右边一大片空白（用户说的"虚无"）。
    // html 也要加：`html{width:356px}` 那条给扩展弹窗定尺寸的规则得被覆盖掉，
    // 否则文档根只有 356px，而角色和控制条是 fixed、按视口排（现场量过）。
    if (params.get("play") === "1") {
      document.body.classList.add("im");
      document.documentElement.classList.add("im");
      fitToQuerySize();
    }

    // 「打开逗玩窗口」与吉祥物栏的三个入口共用同一发开窗：带 &open= 深链，
    // 让窗口里的她直接落到立绘册 / 聊天 / 体检（pet.js 读 open 参数开面板）。
    function openPlay(open) {
      var t = immersiveTarget();
      chrome.windows.create({
        url: chrome.runtime.getURL("popup/popup.html") + "?play=1" +
          (open ? "&open=" + open : "") + "&w=" + t.w + "&h=" + t.h,
        type: "popup", width: t.w, height: t.h
      });
      try { window.close(); } catch (e) {}
    }
    var btnExpand = document.getElementById("btnExpand");
    if (btnExpand) btnExpand.addEventListener("click", function () { openPlay(""); });

    // 「和她聊天」开关没开时，窗口里不会出现聊天 —— 别让人点了没反应：
    // 照样开窗（看得到她），但补一句去哪儿开。
    [["btnPetBook", "book"], ["btnPetDiag", "diag"]].forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (el) el.addEventListener("click", function () { openPlay(p[1]); });
    });
    var btnPetChat = document.getElementById("btnPetChat");
    if (btnPetChat) btnPetChat.addEventListener("click", function () {
      // 开关没开就不开窗：开窗会顺手关掉弹窗，那句提示就没人看得见了。
      if (!petChatEnabledVal) {
        toast("聊天还没打开：先在「吉祥物」里点亮「吉祥物聊天」", 4000);
        return;
      }
      openPlay("chat");
    });

    var fileInput = document.getElementById("bgFile");
    var btnBg = document.getElementById("btnBg");
    var btnClear = document.getElementById("btnBgClear");

    function applyBg(dataUrl) {
      if (dataUrl) {
        document.documentElement.style.setProperty("--bg-image", "url(" + dataUrl + ")");
        document.body.classList.add("has-bg");
      } else {
        document.body.classList.remove("has-bg");
        document.documentElement.style.removeProperty("--bg-image");
      }
    }

    function compress(fileObj) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var url = URL.createObjectURL(fileObj);
        img.onload = function () {
          try {
            URL.revokeObjectURL(url);
            var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
            var cv = document.createElement("canvas");
            cv.width = Math.round(img.width * scale);
            cv.height = Math.round(img.height * scale);
            cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
            resolve(cv.toDataURL("image/jpeg", 0.72));
          } catch (e) { reject(e); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
        img.src = url;
      });
    }

    chrome.storage.local.get("omitone.bg", function (res) {
      try { if (res && res["omitone.bg"]) applyBg(res["omitone.bg"]); } catch (e) {}
    });

    if (btnBg && fileInput) btnBg.addEventListener("click", function () { fileInput.click(); });

    if (fileInput) {
      fileInput.addEventListener("change", async function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        try {
          var dataUrl = await compress(f);
          applyBg(dataUrl);
          chrome.storage.local.set({ "omitone.bg": dataUrl });
          toast("背景已保存（已压缩到 " + Math.round(dataUrl.length / 1365) + " KB 左右）");
        } catch (e) {
          toast("这张图读不出来，换一张试试");
        }
        ev.target.value = "";
      });
    }

    if (btnClear) {
      btnClear.addEventListener("click", function () {
        chrome.storage.local.remove("omitone.bg");
        applyBg(null);
        toast("已恢复默认背景");
      });
    }
  } catch (e) {}
})();

// ── 帧率守则：实测决定动画档位 ─────────────────────────────────────────────
//
// 目标 60fps；掉到 45fps 以下就把 <html> 打成 data-motion="eco"，
// 由 CSS 把时长压到 ~200ms、去掉逐行交错与涟漪（视觉上变成约 24fps 的步进 ——
// 帧数少但均匀，比"60fps 名义上、实际掉帧"要顺）。
//
// 三条取舍：
//   ① 只在打开后测 700ms 一次，不常驻跑 rAF（那本身就是耗电大户）；
//   ② **单向降级**：本次会话不回升，避免在临界机器上反复横跳；
//   ③ 系统开了「减少动态效果」直接进 eco，连测都不测。
(function initMotionGovernor() {
  var root = document.documentElement;
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.setAttribute("data-motion", "eco");
      return;
    }
  } catch (e) {}

  var frames = 0;
  var startAt = 0;
  var lastAt = 0;
  var worst = 0;

  function tick(now) {
    if (!startAt) { startAt = now; lastAt = now; }
    frames += 1;
    var delta = now - lastAt;
    lastAt = now;
    if (delta > worst) worst = delta;

    if (now - startAt < 700) { requestAnimationFrame(tick); return; }

    var fps = frames / ((now - startAt) / 1000);
    window.__omitoneMotion = { fps: Math.round(fps), worstFrameMs: Math.round(worst) };
    if (fps < 45) {
      root.setAttribute("data-motion", "eco");
      console.log("[Omitone] motion -> eco (" + Math.round(fps) + "fps)");
    }
  }
  requestAnimationFrame(tick);
})();

document.addEventListener("DOMContentLoaded", load);
