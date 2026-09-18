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
  audioMuted: true,
  autoNext: true,
  enableQuiz: true,
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
  model: "deepseek-v4-flash",
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
  deepseek: { apiType: "openai", apiUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
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
  audioMuted: $("audioMuted"),
  autoNext: $("autoNext"),
  enableQuiz: $("enableQuiz"),
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
  start: $("start"),
  stop: $("stop"),
  toggleLogs: $("toggleLogs"),
  clearLogs: $("clearLogs"),
  logPanel: $("logPanel"),
  toast: $("toast"),
  runDot: $("runDot"),
  runState: $("runState")
};

let config = { ...DEFAULTS };
let mutedVal = false;
let audioMutedVal = true;
let autoMaxRateVal = true;
let enableMediaVal = true;
let enablePPTVal = true;
let enableHyperlinkVal = true;
let blockedReloadVal = true;
let enableSeekVal = true;
let advanceAtNinetyPercentVal = true;
let autoNextVal = true;
let enableQuizVal = true;
let enableCaptchaVal = true;
// 视觉（看图）默认关：图片计费远高于文本，不能替用户默认花钱
let visionEnabledVal = false;
let enableDiscussionVal = true;
let restudyVal = false;
let logPanelOpen = false;
let logRefreshTimer = null;

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
  const current = (await chrome.storage.local.get("config")).config || {};
  const merged = withoutRemovedConfigFields({
    ...current,
    playbackRate: parseFloat(els.rate.value),
    autoMaxPlaybackRate: autoMaxRateVal,
    enableMedia: enableMediaVal,
    enablePPT: enablePPTVal,
    enableHyperlink: enableHyperlinkVal,
    blockedReload: blockedReloadVal,
    enableSeek: enableSeekVal,
    advanceAtNinetyPercent: advanceAtNinetyPercentVal,
    muted: mutedVal,
    audioMuted: audioMutedVal,
    autoNext: autoNextVal,
    enableQuiz: enableQuizVal,
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
  await chrome.storage.local.set({ config: merged });
  config = withoutRemovedConfigFields({ ...config, ...merged });
  if (showToast) toast("已自动保存");
}

async function saveApiConfig(showToast = true) {
  const current = (await chrome.storage.local.get("config")).config || {};
  const merged = withoutRemovedConfigFields({
    ...current,
    ...getApiFormConfig()
  });
  await chrome.storage.local.set({ config: merged });
  config = withoutRemovedConfigFields({ ...config, ...merged });
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
    await saveToggleConfig();
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
const updateAudioMuted = bindToggle(els.audioMuted, () => audioMutedVal, (value) => { audioMutedVal = value; });
const updateAutoMaxRate = bindToggle(els.autoMaxRate, () => autoMaxRateVal, (value) => { autoMaxRateVal = value; });
const updateMedia = bindToggle(els.enableMedia, () => enableMediaVal, (value) => { enableMediaVal = value; });
const updatePpt = bindToggle(els.enablePPT, () => enablePPTVal, (value) => { enablePPTVal = value; });
const updateHyperlink = bindToggle(els.enableHyperlink, () => enableHyperlinkVal, (value) => { enableHyperlinkVal = value; });
const updateBlockedReload = bindToggle(els.blockedReload, () => blockedReloadVal, (value) => { blockedReloadVal = value; });
const updateSeek = bindToggle(els.enableSeek, () => enableSeekVal, (value) => { enableSeekVal = value; });
const updateNinety = bindToggle(els.advanceAtNinetyPercent, () => advanceAtNinetyPercentVal, (value) => { advanceAtNinetyPercentVal = value; });
const updateAutoNext = bindToggle(els.autoNext, () => autoNextVal, (value) => { autoNextVal = value; });
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
  audioMutedVal = config.audioMuted !== false;
  autoMaxRateVal = config.autoMaxPlaybackRate !== false;
  enableMediaVal = config.enableMedia !== false;
  enablePPTVal = config.enablePPT !== false;
  enableHyperlinkVal = config.enableHyperlink !== false;
  blockedReloadVal = config.blockedReload !== false;
  enableSeekVal = config.enableSeek !== false;
  advanceAtNinetyPercentVal = config.advanceAtNinetyPercent !== false;
  autoNextVal = config.autoNext !== false;
  enableQuizVal = config.enableQuiz !== false;
  enableCaptchaVal = config.enableCaptcha !== false;
  visionEnabledVal = config.visionEnabled === true;
  enableDiscussionVal = config.enableDiscussion !== false;
  restudyVal = !!config.restudy;
  updateMuted(mutedVal);
  updateAudioMuted(audioMutedVal);
  updateAutoMaxRate(autoMaxRateVal);
  updateMedia(enableMediaVal);
  updatePpt(enablePPTVal);
  updateHyperlink(enableHyperlinkVal);
  updateBlockedReload(blockedReloadVal);
  updateSeek(enableSeekVal);
  updateNinety(advanceAtNinetyPercentVal);
  updateAutoNext(autoNextVal);
  updateQuiz(enableQuizVal);
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
  const current = (await chrome.storage.local.get("config")).config || {};
  const merged = withoutRemovedConfigFields({ ...current, ...DEFAULTS });
  await chrome.storage.local.set({ config: merged });
  await load();
  toast("已恢复默认");
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

  try {
    els.testApi.disabled = true;
    els.testApi.textContent = "检测中…";
    await appendPopupLog("info", "api test begin from popup direct", apiConfigSummary(cfg));

    const ping = await sendRuntimeMessageWithTimeout({ type: "ping" }, 1500, "background unavailable");
    await appendPopupLog(ping && ping.success ? "info" : "warn", "background ping before api test", ping);

    const result = await testApiConnectionDirect(cfg);
    await appendPopupLog(result && result.success ? "info" : "warn", "api test result", {
      success: !!(result && result.success),
      error: result && result.error ? String(result.error).slice(0, 300) : "",
      endpoint: result && result.endpoint ? result.endpoint : "",
      config: apiConfigSummary(cfg)
    });

    if (result && result.success) {
      config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: false, apiConnectionError: "" });
      await saveApiConfig(false);
      toast("连接正常" + (result.message ? "：" + result.message : ""));
    } else {
      config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: true, apiConnectionError: (result && result.error) || "connection failed" });
      toast("连接失败：" + ((result && result.error) || "未知错误"));
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: true, apiConnectionError: message });
    await appendPopupLog("error", "api test direct failed", { error: message.slice(0, 300) });
    // 不把英文报错原文塞进提示条（多半是 Failed to fetch 之类），细节看日志
    toast("检测失败，原因见日志");
  } finally {
    els.testApi.disabled = false;
    els.testApi.textContent = "检测 API 连接";
  }
}

async function startRun() {
  await saveApiConfig(false);
  await saveToggleConfig(false);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      toast("未找到当前标签页");
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: "xxt_start" });
    updateRunState(true);
    toast("已发送启动指令");
  } catch (error) {
    toast("请在学习通课程页面中使用");
  }
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

els.systemPrompt.addEventListener("change", () => {
  saveToggleConfig();
});
els.discussionReply.addEventListener("change", () => {
  saveToggleConfig();
});

els.rate.addEventListener("input", () => {
  els.rateVal.textContent = els.rate.value + "x";
});

els.rate.addEventListener("change", async () => {
  await saveToggleConfig();
});

els.providerPreset.addEventListener("change", async () => {
  applyProviderPreset(els.providerPreset.value);
  // 选中即落盘。原实现只改表单不回写 storage，重新打开弹窗时下拉框会跳回旧值，
  // 用户以为已经切过去了，实际运行的还是旧服务商。
  await saveApiConfig(false);
  toast("已切换接入方式");
});

// API 表单自动保存（防抖 800ms）：输入即落盘。
// 此前只有点「保存 API」按钮才写 storage，直接关掉弹窗等于全部丢失——
// 用户以为配置过了，实际运行时 apiKey 还是空的，症状是「AI 答题不生效」却查不出原因。
// apiType 下拉此前甚至完全没有监听，单独切换协议类型永远不会保存。
let apiAutoSaveTimer = null;
function scheduleApiAutoSave() {
  clearTimeout(apiAutoSaveTimer);
  apiAutoSaveTimer = setTimeout(async () => {
    await saveApiConfig(false);
    toast("API 配置已自动保存");
  }, 800);
}
[els.apiUrl, els.apiKey, els.model, els.captchaModel].forEach((el) => {
  el.addEventListener("input", scheduleApiAutoSave);
});
// 地址/模型名一改，渠道就可能变（自定义渠道尤其如此），说明文字要跟着变
[els.apiUrl, els.model].forEach((el) => {
  el.addEventListener("input", updateThinkingHint);
});
els.apiType.addEventListener("change", scheduleApiAutoSave);

// 思考强度的选择器：切换即落盘，并刷新"当前实际发送"那句说明
els.thinkingLevel.addEventListener("change", async () => {
  updateThinkingHint();
  await saveApiConfig(false);
  toast("思考强度已保存");
});

els.reset.addEventListener("click", resetDefault);
els.saveApi.addEventListener("click", async () => {
  await saveApiConfig(true);
  config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: false, apiConnectionError: "" });
});
els.testApi.addEventListener("click", testApiConnectionNoBackground);
els.start.addEventListener("click", startRun);
els.stop.addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ xxtRunning: false });
    updateRunState(false);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
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

document.addEventListener("DOMContentLoaded", load);
