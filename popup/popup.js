const DEFAULTS = {
  playbackRate: 1.0,
  autoMaxPlaybackRate: true,
  playbackRateCap: 4,
  taskGiveUpAttempts: 4,
  enableMedia: true,
  enablePPT: true,
  enableHyperlink: true,
  blockedReload: true,
  enableSeek: true,
  advanceAtNinetyPercent: true,
  muted: false,
  autoNext: true,
  enableQuiz: true,
  randomAnswer: false,
  enableCaptcha: true,
  enableDiscussion: true,
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
  // 思考强度：'off'（默认）/ 'low' / 'high'。参数映射的唯一真源是 libs/thinking.js。
  thinkingLevel: "off"
};

const RUNTIME_LOGS_KEY = "runtimeLogs";
const MAX_LOGS = 200;

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
  rate: $("rate"),
  rateVal: $("rateVal"),
  autoMaxRate: $("autoMaxRate"),
  enableMedia: $("enableMedia"),
  enablePPT: $("enablePPT"),
  enableHyperlink: $("enableHyperlink"),
  blockedReload: $("blockedReload"),
  enableSeek: $("enableSeek"),
  advanceAtNinetyPercent: $("advanceAtNinetyPercent"),
  muted: $("muted"),
  autoNext: $("autoNext"),
  enableQuiz: $("enableQuiz"),
  randomAnswer: $("randomAnswer"),
  enableCaptcha: $("enableCaptcha"),
  enableDiscussion: $("enableDiscussion"),
  discussionReply: $("discussionReply"),
  systemPrompt: $("systemPrompt"),
  restudy: $("restudy"),
  providerPreset: $("providerPreset"),
  apiType: $("apiType"),
  apiUrl: $("apiUrl"),
  apiKey: $("apiKey"),
  model: $("model"),
  captchaModel: $("captchaModel"),
  visionEnabled: $("visionEnabled"),
  visionModel: $("visionModel"),
  visionBudgetPerChapter: $("visionBudgetPerChapter"),
  thinkingLevel: $("thinkingLevel"),
  thinkingHint: $("thinkingHint"),
  reset: $("reset"),
  saveApi: $("saveApi"),
  testApi: $("testApi"),
  updateRow: $("updateRow"),
  updateMsg: $("updateMsg"),
  checkUpdate: $("checkUpdate"),
  doUpdate: $("doUpdate"),
  doLater: $("doLater"),
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
let mutedVal = false;
let autoMaxRateVal = true;
let enableMediaVal = true;
let enablePPTVal = true;
let enableHyperlinkVal = true;
let blockedReloadVal = true;
let enableSeekVal = true;
let advanceAtNinetyPercentVal = true;
let autoNextVal = true;
let enableQuizVal = true;
let randomAnswerVal = false;
let enableCaptchaVal = true;
// 视觉（看图）默认关：图片计费远高于文本，不能替用户默认花钱
let visionEnabledVal = false;
let enableDiscussionVal = true;
let restudyVal = false;
let logPanelOpen = false;
let logRefreshTimer = null;
let apiTestGeneration = 0;
let runOperation = 0;
let shownRunState = null;

const POLICY = self.OmitonePolicy;

function apiFormFingerprint() {
  return POLICY.configFingerprint({ ...config, ...getApiFormConfig() });
}

async function patchConfig(patch, expectedFingerprint) {
  const result = await sendRuntimeMessageWithTimeout({
    type: "config_patch", payload: { patch, expectedFingerprint }
  }, 8000, "配置保存超时");
  if (!result || !result.success) {
    const error = new Error(result && result.code === "stale_config" ? "配置已变化，请重新检测" : "配置保存失败");
    error.code = result && result.code;
    throw error;
  }
  config = withoutRemovedConfigFields({ ...DEFAULTS, ...result.config });
  return config;
}

function reportSaveError(error) {
  toast(error && error.message ? error.message : "保存失败，请重试");
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function withoutRemovedConfigFields(rawConfig) {
  const next = { ...(rawConfig || {}) };
  delete next.forceLearn;
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
  try {
    const proxy = await sendRuntimeMessageWithTimeout({
      type: "api_fetch",
      payload: {
        url,
        method: (options && options.method) || "POST",
        headers: (options && options.headers) || {},
        body: (options && options.body) || "",
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
    if (!response.ok) return { success: false, error: `连接失败 (${response.status}): ${await response.text()}` };
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
    if (!response.ok) return { success: false, error: `连接失败 (${response.status}): ${await response.text()}` };
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
  if (!response.ok) return { success: false, error: `连接失败 (${response.status}): ${await response.text()}` };
  const data = await response.json();
  const message = (data.choices?.[0]?.message?.content || "OK").trim().replace(/\s+/g, " ");
  return { success: true, endpoint: url, message: message.substring(0, 80) || "OK" };
}

async function appendPopupLog(level, message, meta) {
  try {
    const result = await chrome.storage.local.get(RUNTIME_LOGS_KEY);
    const logs = (result && Array.isArray(result[RUNTIME_LOGS_KEY])) ? result[RUNTIME_LOGS_KEY] : [];
    logs.push({
      time: Date.now(),
      level: level || "info",
      message: String(message || ""),
      meta: meta || null
    });
    await chrome.storage.local.set({ [RUNTIME_LOGS_KEY]: logs.slice(-MAX_LOGS) });
  } catch (e) {}
}

function apiConfigSummary(cfg) {
  const key = normalizeApiKey(cfg && cfg.apiKey);
  return {
    apiType: cfg && cfg.apiType,
    apiUrl: cfg && cfg.apiUrl,
    model: cfg && cfg.model,
    keyLength: key.length,
    keyTail: key ? key.slice(-4) : ""
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
    thinkingLevel: els.thinkingLevel.value
  };
}

/**
 * 刷新「思考强度」下面那句说明。
 *
 * 为什么值得单独做：这张表是**按渠道**决定的 —— 同一个"关闭"，DeepSeek 会发
 * `thinking:{type:disabled}`、Kimi 什么参数都不发（K3 关不掉），认不出的渠道
 * 一个参数都不发。用户看不到这层差别，就会以为"我关了思考它却没关"是 bug。
 * 这里把**实际会发出去的参数**摊开给他看。
 * 说明文字由 libs/thinking.js 统一生成，避免 UI 与代码两处措辞分叉。
 */
function updateThinkingHint() {
  if (!els.thinkingHint) return;
  const desc = typeof OmitoneThinking !== "undefined"
    ? OmitoneThinking.describe({
        apiUrl: els.apiUrl.value.trim(),
        model: els.model.value.trim(),
        thinkingLevel: els.thinkingLevel.value
      })
    : "（缺少 libs/thinking.js，无法解析渠道）";
  const base = "「关闭」是唯一实测过的档位，也是本项目一直以来的行为 —— 答题是模式化任务，"
    + "实测关掉后一次请求从 361 token 降到 133。另外两档照厂商文档填写，未在真实题库验证；"
    + "个别服务商会直接拒绝，程序会自动摘掉参数重试一次并把原因写进日志，不会把整次答题判死。";
  els.thinkingHint.innerHTML = base + "<br><br><b>当前实际发送：</b>" + escapeHtml(desc);
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function saveToggleConfig(showToast = true) {
  const patch = withoutRemovedConfigFields({
    playbackRate: parseFloat(els.rate.value),
    autoMaxPlaybackRate: autoMaxRateVal,
    enableMedia: enableMediaVal,
    enablePPT: enablePPTVal,
    enableHyperlink: enableHyperlinkVal,
    blockedReload: blockedReloadVal,
    enableSeek: enableSeekVal,
    advanceAtNinetyPercent: advanceAtNinetyPercentVal,
    muted: mutedVal,
    autoNext: autoNextVal,
    enableQuiz: enableQuizVal,
    randomAnswer: randomAnswerVal,
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

const updateMuted = bindToggle(els.muted, () => mutedVal, (value) => { mutedVal = value; });
const updateAutoMaxRate = bindToggle(els.autoMaxRate, () => autoMaxRateVal, (value) => { autoMaxRateVal = value; });
const updateMedia = bindToggle(els.enableMedia, () => enableMediaVal, (value) => { enableMediaVal = value; });
const updatePpt = bindToggle(els.enablePPT, () => enablePPTVal, (value) => { enablePPTVal = value; });
const updateHyperlink = bindToggle(els.enableHyperlink, () => enableHyperlinkVal, (value) => { enableHyperlinkVal = value; });
const updateBlockedReload = bindToggle(els.blockedReload, () => blockedReloadVal, (value) => { blockedReloadVal = value; });
const updateSeek = bindToggle(els.enableSeek, () => enableSeekVal, (value) => { enableSeekVal = value; });
const updateNinety = bindToggle(els.advanceAtNinetyPercent, () => advanceAtNinetyPercentVal, (value) => { advanceAtNinetyPercentVal = value; });
const updateAutoNext = bindToggle(els.autoNext, () => autoNextVal, (value) => { autoNextVal = value; });
const updateRandomAnswer = bindToggle(els.randomAnswer, () => randomAnswerVal, (value) => { randomAnswerVal = value; });
const updateQuiz = bindToggle(els.enableQuiz, () => enableQuizVal, (value) => { enableQuizVal = value; });
const updateCaptcha = bindToggle(els.enableCaptcha, () => enableCaptchaVal, (value) => { enableCaptchaVal = value; });
const updateVision = bindToggle(els.visionEnabled, () => visionEnabledVal, (value) => { visionEnabledVal = value; });
const updateDiscussion = bindToggle(els.enableDiscussion, () => enableDiscussionVal, (value) => { enableDiscussionVal = value; });
const updateRestudy = bindToggle(els.restudy, () => restudyVal, (value) => { restudyVal = value; });

/** 更新顶部的运行状态指示：圆点 + 文字徽章。 */
function updateRunState(running) {
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
  try { document.dispatchEvent(new CustomEvent("omitone:run", { detail: !!running })); } catch (e) {}
}

async function load() {
  const result = await chrome.storage.local.get("config");
  // 运行状态：content.js 一直读 xxtRunning 决定要不要自动跑，但弹窗以前**从来不读** ——
  // 于是打开弹窗完全看不出是不是已开启。这里补上指示（语义见 updateRunState）。
  try {
    const runResult = await chrome.storage.local.get("xxtRunning");
    updateRunState(!!(runResult && runResult.xxtRunning));
  } catch (e) {
    updateRunState(false);
  }
  config = withoutRemovedConfigFields({ ...DEFAULTS, ...(result.config || {}) });

  els.rate.value = config.playbackRate;
  els.rateVal.textContent = config.playbackRate + "x";
  mutedVal = !!config.muted;
  autoMaxRateVal = config.autoMaxPlaybackRate !== false;
  enableMediaVal = config.enableMedia !== false;
  enablePPTVal = config.enablePPT !== false;
  enableHyperlinkVal = config.enableHyperlink !== false;
  blockedReloadVal = config.blockedReload !== false;
  enableSeekVal = config.enableSeek !== false;
  advanceAtNinetyPercentVal = config.advanceAtNinetyPercent !== false;
  autoNextVal = config.autoNext !== false;
  enableQuizVal = config.enableQuiz !== false;
  randomAnswerVal = config.randomAnswer === true;
  enableCaptchaVal = config.enableCaptcha !== false;
  visionEnabledVal = config.visionEnabled === true;
  enableDiscussionVal = config.enableDiscussion !== false;
  restudyVal = !!config.restudy;
  updateMuted(mutedVal);
  updateAutoMaxRate(autoMaxRateVal);
  updateMedia(enableMediaVal);
  updatePpt(enablePPTVal);
  updateHyperlink(enableHyperlinkVal);
  updateBlockedReload(blockedReloadVal);
  updateSeek(enableSeekVal);
  updateNinety(advanceAtNinetyPercentVal);
  updateAutoNext(autoNextVal);
  updateQuiz(enableQuizVal);
  updateRandomAnswer(randomAnswerVal);
  updateCaptcha(enableCaptchaVal);
  updateVision(visionEnabledVal);
  updateDiscussion(enableDiscussionVal);
  updateRestudy(restudyVal);

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
  // 思考强度：老配置里没有这个键，回落 'off' —— 也就是升级前的行为，不会突变。
  els.thinkingLevel.value = typeof OmitoneThinking !== "undefined"
    ? OmitoneThinking.normalizeLevel(config.thinkingLevel)
    : "off";
  els.discussionReply.value = config.discussionReply || "1";
  els.systemPrompt.value = config.systemPrompt || "";
  if (!config.apiUrl || !config.model) {
    applyProviderPreset(els.providerPreset.value);
  }
  // 放在最后：这句依赖 apiUrl / model / thinkingLevel 三个字段都已填好
  updateThinkingHint();
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
}

async function resetDefault() {
  try {
    apiTestGeneration++;
    clearTimeout(apiAutoSaveTimer);
    await patchConfig({ ...DEFAULTS, apiConnectionError: "" });
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
  const fingerprint = POLICY.configFingerprint(cfg);
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
    toast(result && result.success ? "连接正常" + (result.message ? "：" + result.message : "") :
      "连接失败：" + ((result && result.error) || "未知错误"));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!isCurrent() || error.code === "stale_config") { toast("配置已变化，请重新检测"); return; }
    try { await patchConfig({ apiConnectionFailed: true, apiConnectionError: message.slice(0, 300) }, fingerprint); } catch (e) {}
    await appendPopupLog("error", "api test direct failed", { error: message.slice(0, 300) });
    // 不把英文报错原文塞进提示条（多半是 Failed to fetch 之类），细节看日志
    toast("检测失败，原因见日志");
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

function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function refreshLogs() {
  try {
    const result = await chrome.storage.local.get(RUNTIME_LOGS_KEY);
    const logs = (result && Array.isArray(result[RUNTIME_LOGS_KEY])) ? result[RUNTIME_LOGS_KEY] : [];
    if (!logs.length) {
      els.logPanel.innerHTML = '<div class="log-item">暂无日志</div>';
      return;
    }
    els.logPanel.innerHTML = logs.slice().reverse().map((item) => {
      const level = item.level || "info";
      const meta = item.meta ? ` ${JSON.stringify(item.meta)}` : "";
      return `<div class="log-item"><span class="log-time">${formatTime(item.time)}</span><span class="log-level ${level}">[${level}]</span> ${item.message}${meta}</div>`;
    }).join("");
  } catch (error) {
    els.logPanel.innerHTML = `<div class="log-item">日志读取失败：${error && error.message ? error.message : error}</div>`;
  }
}

[els.systemPrompt, els.discussionReply, els.visionBudgetPerChapter].forEach((el) => {
  el.addEventListener("change", () => { saveToggleConfig().catch(reportSaveError); });
});

els.rate.addEventListener("input", () => {
  els.rateVal.textContent = els.rate.value + "x";
});

els.rate.addEventListener("change", () => { saveToggleConfig().catch(reportSaveError); });

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

// 思考强度的选择器：切换即落盘，并刷新"当前实际发送"那句说明
els.thinkingLevel.addEventListener("change", async () => {
  apiTestGeneration++;
  updateThinkingHint();
  try { await saveApiConfig(false); toast("思考强度已保存"); } catch (error) { reportSaveError(error); }
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
  if (area === "local" && changes.xxtRunning) updateRunState(!!changes.xxtRunning.newValue);
});
els.testApi.addEventListener("click", testApiConnectionNoBackground);
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
els.toggleLogs.addEventListener("click", async () => {
  logPanelOpen = !logPanelOpen;
  els.logPanel.classList.toggle("show", logPanelOpen);
  els.toggleLogs.textContent = logPanelOpen ? "隐藏日志" : "查看日志";
  if (logPanelOpen) {
    await refreshLogs();
    clearInterval(logRefreshTimer);
    logRefreshTimer = setInterval(refreshLogs, 1500);
  } else {
    clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
});
els.clearLogs.addEventListener("click", async () => {
  await chrome.storage.local.set({ [RUNTIME_LOGS_KEY]: [] });
  await refreshLogs();
  toast("日志已清空");
});

/**
 * 把运行日志拼成**纯文本**，供「复制日志」用。
 *
 * 单独抽成函数是为了**能被测**：剪贴板写入在无头环境里可能被拒（需要用户手势），
 * 拿它当断言会得到一条时好时坏的测试。格式化逻辑本身是纯函数，直接测它 ✓。
 */
function buildLogsText(logs, version) {
  const list = Array.isArray(logs) ? logs : [];
  const lines = list.map((item) => {
    const level = item.level || "info";
    const meta = item.meta ? ` ${JSON.stringify(item.meta)}` : "";
    return `[${level}] ${formatTime(item.time)} ${item.message || ""}${meta}`;
  });
  return [
    `Omitone 诊断日志${version ? "（版本 " + version + "）" : ""}`,
    `导出时间：${formatTime(Date.now())}`,
    `共 ${list.length} 条（新的在后）`,
    "---",
    ...lines
  ].join("\n");
}

/**
 * 「复制日志」——把日志整段复制成**纯文本**，用户直接粘贴就能发出来。
 *
 * 为什么要有这个按钮：日志本身早就能看（「查看日志」），但**没法送出来** ——
 * 用户要么截 200 行长图，要么在弹窗里手工选中复制（弹窗一失焦还可能被关掉）。
 * 而"整章被跳过""某个任务点不做"这类问题**只能靠日志定位**，
 * 送不出来就等于查不了。所以这一步不是锦上添花，是**诊断链路的最后一环**。
 */
els.copyLogs.addEventListener("click", async () => {
  let logs = [];
  try {
    const result = await chrome.storage.local.get(RUNTIME_LOGS_KEY);
    logs = (result && Array.isArray(result[RUNTIME_LOGS_KEY])) ? result[RUNTIME_LOGS_KEY] : [];
  } catch (error) {
    toast("日志读取失败");
    return;
  }
  if (!logs.length) {
    toast("暂无日志");
    return;
  }

  let version = "";
  try { version = chrome.runtime.getManifest().version; } catch (eVer) {}

  try {
    await navigator.clipboard.writeText(buildLogsText(logs, version));
    toast(`已复制 ${logs.length} 条日志`);
  } catch (error) {
    // 剪贴板被拒时别静默失败 —— 把日志铺到面板里，让用户能手工选中
    logPanelOpen = true;
    els.logPanel.classList.add("show");
    els.toggleLogs.textContent = "隐藏日志";
    await refreshLogs();
    toast("复制失败，请在上方日志里手动选中");
  }
});

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
  if (manual) {
    els.updateMsg.textContent = "正在检测…";
    els.checkUpdate.disabled = true;
  }

  try {
    const res = await fetch(UPDATE_API, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    try { localStorage.setItem(UPDATE_SEEN_KEY, String(Date.now())); } catch (e) {}

    const remoteVersion = String(rel.tag_name || "").replace(/^v/i, "");
    const asset = (rel.assets || []).find((a) => a && a.name === "omitone.zip");
    const remoteAt = asset && asset.updated_at ? new Date(asset.updated_at).getTime() : 0;

    const newerVersion = cmpVersion(remoteVersion, local.version) > 0;
    // 同一版本号换了包：给 1 分钟容差，避免本机时钟略快就误报"有更新"
    const newerBuild = !newerVersion && local.builtAt > 0 && remoteAt > 0 &&
      remoteAt - local.builtAt > 60000;

    // 文案原则：一句话说清"是什么 / 要不要动"。三种结果，三种说法，不多解释。
    if (newerVersion) {
      els.updateMsg.textContent =
        `有最新版 ${remoteVersion}（本地 ${local.version}）—— 可能相对现版本不够稳定，是否更新？`;
      showUpdateChoices();
    } else if (newerBuild) {
      els.updateMsg.textContent =
        `线上的包比本地新（${fmtTime(remoteAt)}）—— 可能相对现版本不够稳定，是否更新？`;
      showUpdateChoices();
    } else if (!local.builtAt) {
      // 源码目录安装：没有构建戳，只能确认版本号一致，别硬说"最新"
      els.updateMsg.textContent = `当前 ${local.version}（源码目录安装，只比版本号，与线上一致）`;
    } else {
      els.updateMsg.textContent = "你已经是最新版了";
    }
  } catch (error) {
    // 查不到就只说查不到：不猜原因、也不给"是不是最新"的结论。
    // 网络、代理、GitHub 匿名额度用光、本机时间偏差……都可能。
    els.updateMsg.textContent = "歪比八布，你的网络或者作者的匿名名额正在睡大觉（别连点，过一会儿再看）";
    showUpdateChoices();
  } finally {
    els.checkUpdate.disabled = false;
  }
}

/** 有更新（或查不出来）时，把"是/否"两个选项亮出来 */
function showUpdateChoices() {
  els.doUpdate.style.display = "";
  els.doLater.style.display = "";
  els.updateRow.classList.add("hot");
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

// ── 沉浸式窗口（?play=1）：只留吉祥物 ──────────────────────────────
// 之前这个参数**只改了窗口尺寸**，从来没给 body 加 .im —— 于是打开后
// 就是一张放大的普通弹窗，右边一大片空白（用户说的"虚无"）。
try {
  if (new URLSearchParams(location.search).get("play") === "1") document.body.classList.add("im");
} catch (e) {}

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
// 两个约束值得写下来：
//   ① 浏览器**不允许弹窗自己改尺寸**（resizeTo 对 extension popup 无效），
//      所以「展开」只能新开一个更大的窗口 —— 用 ?play=1 区分模式，不复用第二套页面。
//   ② 自定义背景要落盘，但 storage.local 只有 10MB。
//      所以上传时先缩到最长边 1600px、JPEG 质量 0.72 —— 通常 150~350KB，够用且不撑爆。
(function omScene() {
  try {
    if (new URLSearchParams(location.search).get("play") === "1") document.body.classList.add("im");

    var btnExpand = document.getElementById("btnExpand");
    if (btnExpand) {
      btnExpand.addEventListener("click", function () {
        chrome.windows.create({
          url: chrome.runtime.getURL("popup/popup.html") + "?play=1",
          type: "popup", width: 760, height: 680
        });
        try { window.close(); } catch (e) {}
      });
    }

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
