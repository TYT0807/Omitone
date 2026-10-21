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

// ── 四季主题 / 点击水纹 / 彩蛋小人 ──────────────────────────────────────────
//
// 纯取乐，与刷课逻辑**零耦合**：不读配置、不写存储、不碰 page.js。
// 外层包 try/catch —— 任何一步出错都静默放弃，绝不能让装饰拖垮弹窗。
// 四季是**每次打开重掷**，刻意不做持久化（用户要的就是"每次都不同"）。
(function omFancy() {
  try {
    // 精简模式下整套角色逻辑不启动 —— 不是"藏起来"，是**真不跑**
    if (document.documentElement.getAttribute("data-ui") !== "fancy") return;
    var SEASONS = ["spring", "summer", "autumn", "winter"];
    var season = SEASONS[Math.floor(Math.random() * SEASONS.length)];
    document.documentElement.setAttribute("data-season", season);

    var eco = document.documentElement.getAttribute("data-motion") === "eco";
    window.__omitoneSeason = season;

    function kick(el, frames, opts) {
      try {
        var a = el.animate(frames, opts);
        a.onfinish = function () { try { el.remove(); } catch (e) {} };
      } catch (e) { try { el.remove(); } catch (e2) {} }
    }

    // ---- 常驻粒子：纯 CSS 循环，数量固定，不进 rAF ----
    var layer = document.getElementById("fxLayer");
    if (layer) {
      var count = eco ? 5 : 10;
      for (var i = 0; i < count; i++) {
        var p = document.createElement("i");
        var size = 3 + Math.random() * 4;
        p.style.width = size + "px";
        p.style.height = size + "px";
        p.style.left = (Math.random() * 96) + "%";
        p.style.animationDuration = (6 + Math.random() * 5) + "s";
        p.style.animationDelay = (-Math.random() * 8) + "s";
        p.style.opacity = (0.32 + Math.random() * 0.38).toFixed(2);
        if (season === "autumn") p.style.borderRadius = "40% 60% 55% 45%";
        if (season === "winter") p.style.background = "rgba(255,255,255,.88)";
        layer.appendChild(p);
      }
    }

    // ---- 点击：水纹扩散 + 季节粒子炸开 ----
    function burst(x, y, small) {
      if (eco) return;
      var ring = document.createElement("span");
      ring.className = "fx-ripple";
      ring.style.left = x + "px";
      ring.style.top = y + "px";
      document.body.appendChild(ring);
      kick(ring, [{ transform: "scale(.4)", opacity: .85 }, { transform: "scale(6.5)", opacity: 0 }],
        { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" });

      var n = small ? 5 : 8;
      for (var k = 0; k < n; k++) {
        var s = document.createElement("span");
        s.className = "fx-spark";
        s.style.left = x + "px";
        s.style.top = y + "px";
        document.body.appendChild(s);
        var angle = (Math.PI * 2 * k) / n + Math.random() * 0.5;
        var dist = 18 + Math.random() * 16;
        kick(s, [
          { transform: "translate(0,0) scale(1)", opacity: .9 },
          { transform: "translate(" + Math.cos(angle) * dist + "px," + (Math.sin(angle) * dist + 10) + "px) scale(.3)", opacity: 0 }
        ], { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }

    var snowClicks = 0;
    var petReact = function () {};   // 由小人那段接管：点完按钮让它开心一下

    /** 冬天的"积雪整体塌落"：一整块雪从按钮顶面掉下去（不是碎末） */
    function snowSlab(btn) {
      var r = btn.getBoundingClientRect();
      var slab = document.createElement("span");
      slab.className = "fx-snow";
      slab.style.left = (r.left + r.width / 2 - 15) + "px";
      slab.style.top = (r.top + 1) + "px";
      slab.style.width = "30px";
      slab.style.height = "6px";
      slab.style.borderRadius = "3px";
      document.body.appendChild(slab);
      kick(slab, [
        { transform: "translateY(0) rotate(0deg)", opacity: 1 },
        { transform: "translateY(26px) rotate(9deg)", opacity: 0 }
      ], { duration: 520, easing: "cubic-bezier(.5,0,.75,1)" });
    }

    /** 冬天的"塌雪"：从按钮下沿掉一串雪，边掉边化 */
    function spillSnow(btn) {
      var r = btn.getBoundingClientRect();
      for (var i = 0; i < 7; i++) {
        var f = document.createElement("span");
        f.className = "fx-snow";
        f.style.left = (r.left + 10 + Math.random() * (r.width - 20)) + "px";
        f.style.top = (r.bottom - 2) + "px";
        document.body.appendChild(f);
        kick(f, [
          { transform: "translate(0,0) scale(1)", opacity: 1 },
          { transform: "translate(" + ((Math.random() - 0.5) * 26).toFixed(0) + "px," + (18 + Math.random() * 22).toFixed(0) + "px) scale(.45)", opacity: 0 }
        ], { duration: 700 + Math.random() * 500, easing: "cubic-bezier(.4,0,.7,1)" });
      }
    }

    /** 秋天：脚下踩出三片叶子 */
    function stepLeaves() {
      var m = document.getElementById("mascot");
      if (!m) return;
      var r = m.getBoundingClientRect();
      for (var i = 0; i < 3; i++) {
        var l = document.createElement("span");
        l.className = "fx-leaf";
        l.style.left = (r.left + 6 + Math.random() * 22) + "px";
        l.style.top = (r.bottom - 6) + "px";
        document.body.appendChild(l);
        kick(l, [
          { transform: "translate(0,-14px) rotate(0deg)", opacity: 0 },
          { transform: "translate(0,0) rotate(40deg)", opacity: .9, offset: .4 },
          { transform: "translate(6px,10px) rotate(90deg)", opacity: 0 }
        ], { duration: 900, easing: "ease-out" });
      }
    }
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var hit = t.closest(".btn, .minor button, .toggle, .link-btn");
      if (!hit) return;
      var box = hit.getBoundingClientRect();
      burst(ev.clientX || (box.left + box.width / 2), ev.clientY || (box.top + box.height / 2),
        !!t.closest(".toggle, .link-btn"));

      // 四个季节，四种"点下去之后发生什么"
      if (!hit.classList.contains("btn")) return;

      if (season === "winter") {
        snowClicks += 1;
        hit.classList.add("snow-hit");
        snowSlab(hit);      // 整块积雪骤然塌落
        spillSnow(hit);     // 再溅一把碎雪
        var m0 = document.getElementById("mascot");
        var b0 = document.getElementById("mascotBubble");
        if (m0) {
          m0.setAttribute("data-snow", String(Math.min(3, snowClicks)));
          if (snowClicks >= 3) {
            m0.setAttribute("data-pose", "happy");
            if (b0) { b0.textContent = "雪人堆好啦！"; b0.classList.add("show"); }
          }
        }
      } else if (season === "summer") {
        hit.classList.add("sunbaked");
        var m1 = document.getElementById("mascot");
        if (m1) {
          m1.setAttribute("data-eat", "1");
          setTimeout(function () { m1.removeAttribute("data-eat"); }, 1300);
        }
      } else if (season === "autumn") {
        stepLeaves();
      }
      try { petReact(); } catch (e) {}
    }, true);

    // ---- 彩蛋小人：滑下来挂边 → 挣扎攀爬 → 坐到更新栏旁 ----
    var mascot = document.getElementById("mascot");
    var bubble = document.getElementById("mascotBubble");
    if (!mascot) return;

    function pose(name) { mascot.setAttribute("data-pose", name); }

    // ── 出场：常规"淡入落座"；**1% 概率**才走"吊边 → 攀爬 → 落座"的彩蛋 ──
    // 每次打开独立重掷、不记忆 —— "再开一次"就是重新抽一次。
    var EASTER_RATE = 0.01;
    // ?egg=1 可以手动看一次彩蛋（调试/预览用），不影响 1% 的随机
    var isEgg = new URLSearchParams(location.search).get("egg") === "1" || Math.random() < EASTER_RATE;
    window.__omitoneEgg = isEgg;

    var poseTimer = null;
    function setPose(name, holdMs) {
      pose(name);
      clearTimeout(poseTimer);
      if (holdMs) poseTimer = setTimeout(function () { pose("sit"); }, holdMs);
    }
    petReact = function () { setPose("happy", 1200); };   // 点按钮 → 开心 1.2 秒 → 回坐姿

    if (isEgg) {
      setTimeout(function () {                        // 1.4s：被发现挂在边缘
        mascot.classList.add("show");
        mascot.style.transform = "translateY(-96px)";
        pose("hang");
      }, 1400);
      setTimeout(function () {                        // 3.0s：挣扎着往下爬
        mascot.style.transform = "translateY(-58px)";
        pose("climb");
      }, 3000);
      setTimeout(function () {                        // 4.2s：落座
        mascot.style.transform = "";
        pose("sit");
      }, 4200);
      setTimeout(function () {                        // 5.2s：指着更新栏
        pose("point");
        if (bubble) {
          bubble.textContent = isUpdateMuted() ? "今天也要好好学习" : "要检查更新吗？";
          bubble.classList.add("show");
        }
      }, 5200);
      setTimeout(function () {                        // 9.5s：收尾
        if (bubble) bubble.classList.remove("show");
        pose("happy");
        mascot.classList.add("show");            // 彩蛋收尾必须回到可见状态
        mascot.style.transform = "";
      }, 9500);
    } else {
      // 精美模式下 0.8 秒淡入。之前"默认不出现"是为了彩蛋的意外感，
      // 但结果是工具条和彩蛋都够不着 —— 可用性优先，改成默认现身。
      setTimeout(function () { mascot.classList.add("show"); pose("sit"); }, 800);
    }

    // 通用触发：悬停「检测更新」→ 指过去 1.8 秒
    var updLink = document.getElementById("checkUpdate");
    if (updLink) updLink.addEventListener("mouseenter", function () { setPose("point", 1800); });

    // ── 悬停工具条 / 双击收起 / 换装 ──────────────────────────────────────
    var OUT_KEY = "omitone.pet.outfit";
    var HIDE_KEY = "omitone.pet.hidden";
    // 「装」只走服装 —— 表情和动作是另一回事，混在一起用户会看不出规律
    var SKINS = ["pet.png",
      "pet-1.png", "pet-2.png", "pet-3.png", "pet-4.png",
      "pet-5.png", "pet-6.png", "pet-7.png", "pet-8.png",
      "pet-9.png", "pet-10.png",
      "pet-11.png", "pet-12.png", "pet-13.png", "pet-14.png"];   // 15 套服装
    // 「表」走表情 + 动作（都是默认装束下的另一张脸/另一个动作）
    var FACES = ["pet-e1.png", "pet-e2.png", "pet-e3.png", "pet-e4.png",
                 "pet-e5.png", "pet-e6.png",
                 "pet-i5.png", "pet-i6.png", "pet-i7.png", "pet-i8.png"];   // 10 张表情
    var POSES = ["pet.png", "pet-i1.png", "pet-i2.png", "pet-i3.png", "pet-i4.png",
                 "pet-e7.png", "pet-e8.png", "pet-e9.png", "pet-e10.png"];  // 9 个姿势
    var OUTFITS = SKINS.length;
    var POS_KEY = "omitone.pet.pos";
    var FACE_KEY = "omitone.pet.face";
    var faceIdx = -1;
    /** 换动作时的过渡：先缩一下、再弹回、带一点侧倾 —— 让"换图"看起来像"动了一下" */
    function playMotion(el) {
      try {
        el.animate([
          { transform: "scale(1) rotate(0deg)" },
          { transform: "scale(.92) rotate(-4deg)", offset: .35 },
          { transform: "scale(1.06) rotate(3deg)", offset: .72 },
          { transform: "scale(1) rotate(0deg)" }
        ], { duration: 460, easing: "cubic-bezier(.34,1.5,.64,1)" });
      } catch (e) {}
    }
    /** 换动作时的过渡：先缩一下、再弹回、带一点侧倾 —— 让"换图"看起来像"动了一下" */
    function playMotion(el) {
      try {
        el.animate([
          { transform: "scale(1) rotate(0deg)" },
          { transform: "scale(.92) rotate(-4deg)", offset: .35 },
          { transform: "scale(1.06) rotate(3deg)", offset: .72 },
          { transform: "scale(1) rotate(0deg)" }
        ], { duration: 460, easing: "cubic-bezier(.34,1.5,.64,1)" });
      } catch (e) {}
    }
    var poseIdx = 0;
    // 上次把她拖到哪儿了？就放回哪儿
    try {
      var savedPos = localStorage.getItem(POS_KEY);
      var xy = savedPos ? savedPos.split(",") : [String(window.innerWidth - 56), "2"];
      if (xy.length === 2) mascot.style.translate = xy[0] + "px " + xy[1] + "px";
    } catch (e) {}
    var outfitIdx = 0;
    function applyOutfit(i) {
      outfitIdx = ((i % OUTFITS) + OUTFITS) % OUTFITS;
      if (outfitIdx) mascot.setAttribute("data-outfit", String(outfitIdx));
      else mascot.removeAttribute("data-outfit");
      // 真的换图 —— 之前只加了 hue-rotate，而情绪也会写 filter，两家抢同一个属性，
      // 谁后写谁生效 → 看着就是"点了没反应"。改用换 src，彻底不碰 filter。
      var art = mascot.querySelector(".pet-art");
      if (art) art.setAttribute("src", SKINS[outfitIdx] || SKINS[0]); playMotion(art);
      try { localStorage.setItem(OUT_KEY, String(outfitIdx)); } catch (e) {}
      return outfitIdx;
    }
    // 预载另外两套，换的时候不闪
    // 预载全部立绘，切换时不闪
    SKINS.forEach(function (f) { try { var im = new Image(); im.src = f; } catch (e) {} });
    try { outfitIdx = applyOutfit(Number(localStorage.getItem(OUT_KEY) || 0)); } catch (e) {}

    // 上次按了"藏"就一直藏着，直到在弹窗底部点「显示小人」
    try {
      if (localStorage.getItem(HIDE_KEY) === "1") mascot.style.display = "none";
    } catch (e) {}

    var tools = document.getElementById("petTools");
    if (tools) {
      tools.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest("button[data-act]") : null;
        if (!b) return;
        ev.stopPropagation();
        ev.stopImmediatePropagation && ev.stopImmediatePropagation();
        var act = b.getAttribute("data-act");
        if (act === "pose") {
          // 姿势 = 换一张"动作立绘"，和表情分开
          poseIdx = (poseIdx + 1) % POSES.length;
          var pa = mascot.querySelector(".pet-art");
          if (pa) { pa.setAttribute("src", POSES[poseIdx]); playMotion(pa); }
          setPose("sit", 1200);
          addMood(2);
        } else if (act === "outfit") {
          applyOutfit(outfitIdx + 1);
          addMood(2);
        } else if (act === "face") {
          faceIdx = (faceIdx + 1) % FACES.length;
          var fa = mascot.querySelector(".pet-art");
          if (fa) { fa.setAttribute("src", FACES[faceIdx]); playMotion(fa); }
          try { localStorage.setItem("omitone.pet.face", String(faceIdx)); } catch (e) {}
          addMood(2);
        } else if (act === "hide") {
          try { localStorage.setItem(HIDE_KEY, "1"); } catch (e) {}
          mascot.style.display = "none";
        }
      });
    }

    // 双击：收成小头像 / 展开
    if (mascot) {
      mascot.addEventListener("dblclick", function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest("button")) return;
        ev.stopPropagation();
        ev.preventDefault();
        mascot.classList.toggle("collapsed");
      });
    }

    /** 彩蛋：从当前位置爬到「检测更新」旁边，拍拍它 —— 让她真的"指给你看" */
    function crawlToUpdate() {
      var link = document.getElementById("checkUpdate");
      if (!link || !mascot) return;
      var lr = link.getBoundingClientRect();
      var pr = mascot.getBoundingClientRect();
      var dx = Math.min(window.innerWidth - 44, lr.right + 4);
      var dy = Math.max(0, lr.top - 4);
      mascot.style.transition = "translate 3.2s cubic-bezier(.4,0,.2,1)";
      mascot.style.translate = Math.round(dx) + "px " + Math.round(dy) + "px";
      setTimeout(function () {
        mascot.style.transition = "";
        setPose("point", 6000);
        var pats = 0;
        var timer = setInterval(function () {
          try {
            link.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }],
              { duration: 340, easing: "ease-out" });
          } catch (e) {}
          if (++pats >= 3) clearInterval(timer);
        }, 1250);
      }, 3300);
    }

    // ── 闲置自动轮换：没人理她时，自己换姿态、偶尔换身衣服 ──────────────
    // 12~25 秒一次，运行中（data-busy）不打扰。
    // 只用 sit/happy/point：climb/hang 是彩蛋专用姿态，日常出现会很怪。
    (function idleLoop() {
      var wait = 12000 + Math.random() * 13000;
      setTimeout(function () {
        try {
          var hidden = !mascot || mascot.style.display === "none" || !mascot.classList.contains("show");
          if (!hidden && !mascot.getAttribute("data-busy")) {
            if (Math.random() < 0.45) applyOutfit(Math.floor(Math.random() * OUTFITS));
            var poses = ["sit", "happy", "point"];
            setPose(poses[Math.floor(Math.random() * poses.length)], 2800);
          }
        } catch (e) {}
        idleLoop();
      }, wait);
    })();

    // 底部「显示小人」：把藏起来的叫回来
    var btnPetShow = document.getElementById("btnPetShow");
    if (btnPetShow) {
      btnPetShow.addEventListener("click", function () {
        try { localStorage.removeItem(HIDE_KEY); } catch (e) {}
        mascot.style.display = "block";
        mascot.style.visibility = "visible";
        mascot.style.opacity = "1";
        mascot.style.translate = (window.innerWidth - 56) + "px 2px";
        try { localStorage.removeItem(POS_KEY); } catch (e) {}
        mascot.classList.add("show");
        mascot.classList.remove("collapsed");
        setPose("happy", 1400);
        try {
          var once = localStorage.getItem("omitone.pet.egged") !== "1";
          localStorage.setItem("omitone.pet.egged", "1");
          var t = document.getElementById("toast");
          if (!once) throw new Error("seen");
          if (t) {
            t.textContent = "恭喜触发彩蛋<(￣︶￣)↗ 请到最上面看看她";
            t.classList.add("prominent", "show");
            setTimeout(function () { t.classList.remove("prominent", "show"); }, 5200);
            setTimeout(function () { try { say("我在这儿～看上面", 2200); } catch (e) {} }, 600);
            setTimeout(crawlToUpdate, 1600);
          }
        } catch (e) {}
        try { toast("恭喜触发彩蛋<(￣︶￣)↗，请到最上面看看她"); } catch (e) {}
      });
    }



    // ── 会说话：连戳躲避 / 自己嘟囔 / 按季节打招呼 ─────────────────────
    var SEASON_LINES = {
      spring: ["花开的时候，最适合刷课了", "今天也要一点点进步"],
      summer: ["记得喝水，别中暑", "冰激凌化了就不好吃了"],
      autumn: ["落叶踩起来咯吱响", "天凉了，记得加件外套"],
      winter: ["手好冷，但还想陪你", "雪停了再走也不迟"]
    };
    var sayTimer = null;
    function say(text, ms) {
      if (!bubble) return;
      bubble.textContent = text;
      bubble.classList.add("show");
      clearTimeout(sayTimer);
      sayTimer = setTimeout(function () { bubble.classList.remove("show"); }, ms || 2600);
    }

    // 连戳三次（2 秒内）→ 躲到旁边，并说一句
    var pokeStamps = [];
    if (mascot) {
      mascot.addEventListener("click", function (ev) {
        // 工具条上的操作不算"戳她"：任何祖先里带 pet-tools 的直接忽略
        if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) { ev.stopPropagation(); return; }
        var now = Date.now();
        pokeStamps.push(now);
        pokeStamps = pokeStamps.filter(function (t) { return now - t < 2000; });
        if (pokeStamps.length >= 3) {
          pokeStamps = [];
          mascot.style.translate = "";
          mascot.classList.add("dodge");
          setTimeout(function () { mascot.classList.remove("dodge"); }, 1000);
          say("别戳啦，我去旁边站会儿", 2200);
          addMood(-2);
        }
      });
    }

    // 自己嘟囔：45~90 秒一次，正在忙（运行中）就不打扰
    var lines = SEASON_LINES[season] || SEASON_LINES.spring;
    (function chatLoop() {
      var wait = 45000 + Math.random() * 45000;
      setTimeout(function () {
        try {
          if (mascot && mascot.style.display !== "none" && !mascot.getAttribute("data-busy")) {
            say(lines[Math.floor(Math.random() * lines.length)], 3000);
          }
        } catch (e) {}
        chatLoop();
      }, wait);
    })();



    // ── 情绪 / 拖拽 / 运行状态联动 ──────────────────────────────────────
    //
    // 三条都是**只读或纯本地**的：
    //   · 情绪存在 localStorage，不参与任何答题/调度逻辑；
    //   · 拖拽只改自己的 translate；
    //   · 运行状态是"单向只读"——角色接收 `omitone:run` 事件，绝不反向影响运行。
    // 任何一步出错都被外层 try/catch 吞掉，不会波及刷课。
    var MOOD_KEY = "omitone.pet.mood";
    function getMood() { try { return Number(localStorage.getItem(MOOD_KEY) || 50); } catch (e) { return 50; } }
    function applyMood(v) {
      if (!mascot) return;
      var m = Math.max(0, Math.min(100, v));
      try { localStorage.setItem(MOOD_KEY, String(m)); } catch (e) {}
      if (m >= 80) mascot.setAttribute("data-mood", "high");
      else if (m <= 15) mascot.setAttribute("data-mood", "low");
      else mascot.removeAttribute("data-mood");
    }
    applyMood(getMood());

    function addMood(d) {
      var m = Math.max(0, Math.min(100, getMood() + d));
      applyMood(m);
      return m;
    }

    // 拖拽：按住就能拖着走，松手弹回去（不永久改变布局，免得下次打开位置乱了）
    var dragging = false, startX = 0, startY = 0, moveX = 0, moveY = 0;
    // 记住"按在人物的哪个点"：拖动时光标始终咬着这个点，人物不会跑到光标旁边
    var grabDX = 0, grabDY = 0, baseLeft = 0, baseBottomY = 0;
    if (mascot) {
      mascot.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        // ⚠️ 按在工具条上不算拖：pointer capture 会把后续 click 的目标改成 .pet，
        // 于是 closest(".pet-tools") 变 null，连点换装就被误判成"戳她"。
        if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) return;
        dragging = true;
        startX = ev.clientX; startY = ev.clientY; moveX = 0; moveY = 0;
        var rc = mascot.getBoundingClientRect();
        grabDX = ev.clientX - rc.left;      // 按在人物身上的哪个位置
        grabDY = ev.clientY - rc.top;
        baseLeft = rc.left;                  // 人物此刻的屏幕位置（含已有位移）
        baseBottomY = rc.top;
        mascot.classList.add("dragging");
        try { mascot.setPointerCapture(ev.pointerId); } catch (e) {}
      });
      mascot.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        // 绝对坐标：人物左上角 = 光标 - 抓手偏移。不需要任何基准换算。
        moveX = Math.max(0, Math.min(window.innerWidth - 44, ev.clientX - grabDX));
        moveY = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - grabDY));
        mascot.style.translate = moveX.toFixed(0) + "px " + moveY.toFixed(0) + "px";
      });
      mascot.addEventListener("pointerup", function () {
        if (!dragging) return;
        dragging = false;
        mascot.classList.remove("dragging");
        var dist = Math.sqrt(moveX * moveX + moveY * moveY);
        if (dist > 8) {
          // 松手就停在这儿并记住 —— 用户要能把她挪到不挡事的地方
          try { localStorage.setItem(POS_KEY, Math.round(moveX) + "," + Math.round(moveY)); } catch (e) {}
          setPose("happy", 900); addMood(3);
        }
      });
      mascot.addEventListener("pointercancel", function () {
        dragging = false;
        mascot.classList.remove("dragging");
        mascot.style.translate = "0px 0px";
      });
    }

    // 运行状态：跑起来时呼吸变快 + 说一句；停下来回到常态
    document.addEventListener("omitone:run", function (ev) {
      if (!mascot) return;
      if (ev.detail) {
        mascot.setAttribute("data-busy", "1");
        setPose("happy", 1600);
        if (bubble) { bubble.textContent = "开工啦，你忙你的"; bubble.classList.add("show");
          setTimeout(function () { bubble.classList.remove("show"); }, 2600); }
      } else {
        mascot.removeAttribute("data-busy");
        if (bubble) { bubble.textContent = "收工，歇会儿吧"; bubble.classList.add("show");
          setTimeout(function () { bubble.classList.remove("show"); }, 2600); }
      }
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

    // 戳一戳：只在沉浸式窗口里可点（弹窗里保持 pointer-events:none，绝不挡操作）
    var petEl = document.getElementById("mascot");
    var petBubble = document.getElementById("mascotBubble");
    var pokeIdx = 0;
    var POKES = ["别戳我啦", "在看书呢…", "再戳就跳走了", "好啦好啦，刷课要紧"];
    if (petEl) {   // 弹窗和沉浸式都能戳：只占角色自己那 40px，不挡别处

      petEl.addEventListener("click", function (ev) {
        ev.stopPropagation();
        pokeIdx = (pokeIdx + 1) % POKES.length;
        petEl.setAttribute("data-pose", pokeIdx % 2 === 0 ? "happy" : "sit");
        if (petBubble) {
          petBubble.textContent = POKES[pokeIdx];
          petBubble.classList.add("show");
          clearTimeout(petEl._pokeTimer);
          petEl._pokeTimer = setTimeout(function () { petBubble.classList.remove("show"); }, 2200);
        }
      });
    }

    // 视线跟随（带死区 + 120ms 节流）：只有角度明显变了才动，
    // 否则手抖一下它就疯狂转头 —— 那是"传感器"，不是"活的"。
    if (petEl) {
      var lastAngle = 0;
      var gazeTick = null;
      document.addEventListener("mousemove", function (ev) {
        if (gazeTick) return;
        gazeTick = setTimeout(function () { gazeTick = null; }, 120);
        var r = petEl.getBoundingClientRect();
        var ang = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2));
        if (Math.abs(ang - lastAngle) < 0.35) return;      // 死区约 20°
        lastAngle = ang;
        var inner = petEl.querySelector(".pet-inner");
        if (inner) inner.style.translate = (Math.cos(ang) * 1.6).toFixed(1) + "px " + (Math.sin(ang) * 1.2).toFixed(1) + "px";
      }, { passive: true });

      // 25 秒没搭理它 → 伸个懒腰（一次性，然后继续呼吸）
      var idleTimer = null;
      var resetIdle = function () {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          petEl.classList.add("yawn");
          setTimeout(function () { petEl.classList.remove("yawn"); }, 1000);
        }, 25000);
      };
      resetIdle();
      petEl.addEventListener("click", resetIdle);
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
