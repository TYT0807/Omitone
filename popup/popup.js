const DEFAULTS = {
  playbackRate: 1.0,
  autoMaxPlaybackRate: true,
  playbackRateCap: 4,
  taskGiveUpAttempts: 4,
  enableSeek: true,
  advanceAtNinetyPercent: true,
  muted: false,
  audioMuted: true,
  autoNext: true,
  enableQuiz: true,
  enableCaptcha: true,
  enableDiscussion: true,
  discussionReply: "1",
  restudy: false,
  providerPreset: "deepseek",
  apiType: "openai",
  apiUrl: "https://api.deepseek.com",
  apiKey: "",
  apiConnectionFailed: false,
  model: "deepseek-v4-flash",
  captchaModel: ""
};

const RUNTIME_LOGS_KEY = "runtimeLogs";
const MAX_LOGS = 200;

// 服务商预设。
//
// ⚠️ 这里只放**真的在真实答题链路上跑通过**的，其余一律不预置 ——
// 曾经内置过 9 家（MiniMax / 通义 / 智谱 / Kimi / OpenRouter / SiliconFlow …），
// 全是"按官方文档配好但没实测"，模型名还是钉死的快照，厂商一发新版就失效，
// 用户照着填完发现用不了，反而比留空白更坑。
// 现在只保留 DeepSeek（真实章节测验里完整验证过：抠题 → 作答 → 回填 → 交卷 → 记分）。
//
// 用别家怎么办？选「自定义 OpenAI 兼容」，自己填 API URL 和模型名即可 ——
// 那两格填什么都能用，反而是预置的过期快照才容易不能用。
// Claude / Gemini 走的是独立协议（在「协议类型」里选），代码有集成测试覆盖，
// 但**没有在真实题库上跑过**，所以模型名留给你自己填。
const PROVIDER_PRESETS = {
  deepseek: { apiType: "openai", apiUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  claude: { apiType: "claude", apiUrl: "https://api.anthropic.com", model: "" },
  gemini: { apiType: "gemini", apiUrl: "https://generativelanguage.googleapis.com", model: "" },
  "custom-openai": { apiType: "openai", apiUrl: "", model: "" }
};

const $ = (id) => document.getElementById(id);
const els = {
  rate: $("rate"),
  rateVal: $("rateVal"),
  autoMaxRate: $("autoMaxRate"),
  enableSeek: $("enableSeek"),
  advanceAtNinetyPercent: $("advanceAtNinetyPercent"),
  muted: $("muted"),
  audioMuted: $("audioMuted"),
  autoNext: $("autoNext"),
  enableQuiz: $("enableQuiz"),
  enableCaptcha: $("enableCaptcha"),
  enableDiscussion: $("enableDiscussion"),
  discussionReply: $("discussionReply"),
  restudy: $("restudy"),
  providerPreset: $("providerPreset"),
  apiType: $("apiType"),
  apiUrl: $("apiUrl"),
  apiKey: $("apiKey"),
  model: $("model"),
  captchaModel: $("captchaModel"),
  reset: $("reset"),
  saveApi: $("saveApi"),
  testApi: $("testApi"),
  start: $("start"),
  stop: $("stop"),
  toggleLogs: $("toggleLogs"),
  clearLogs: $("clearLogs"),
  logPanel: $("logPanel"),
  toast: $("toast")
};

let config = { ...DEFAULTS };
let mutedVal = false;
let audioMutedVal = true;
let autoMaxRateVal = true;
let enableSeekVal = true;
let advanceAtNinetyPercentVal = true;
let autoNextVal = true;
let enableQuizVal = true;
let enableCaptchaVal = true;
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
    captchaModel: els.captchaModel.value.trim()
  };
}

async function saveToggleConfig(showToast = true) {
  const current = (await chrome.storage.local.get("config")).config || {};
  const merged = withoutRemovedConfigFields({
    ...current,
    playbackRate: parseFloat(els.rate.value),
    autoMaxPlaybackRate: autoMaxRateVal,
    enableSeek: enableSeekVal,
    advanceAtNinetyPercent: advanceAtNinetyPercentVal,
    muted: mutedVal,
    audioMuted: audioMutedVal,
    autoNext: autoNextVal,
    enableQuiz: enableQuizVal,
    enableCaptcha: enableCaptchaVal,
    enableDiscussion: enableDiscussionVal,
    discussionReply: els.discussionReply.value.trim() || "1",
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
  };
  el.addEventListener("click", async () => {
    const value = !getter();
    setter(value);
    update(value);
    await saveToggleConfig();
  });
  return update;
}

const updateMuted = bindToggle(els.muted, () => mutedVal, (value) => { mutedVal = value; });
const updateAudioMuted = bindToggle(els.audioMuted, () => audioMutedVal, (value) => { audioMutedVal = value; });
const updateAutoMaxRate = bindToggle(els.autoMaxRate, () => autoMaxRateVal, (value) => { autoMaxRateVal = value; });
const updateSeek = bindToggle(els.enableSeek, () => enableSeekVal, (value) => { enableSeekVal = value; });
const updateNinety = bindToggle(els.advanceAtNinetyPercent, () => advanceAtNinetyPercentVal, (value) => { advanceAtNinetyPercentVal = value; });
const updateAutoNext = bindToggle(els.autoNext, () => autoNextVal, (value) => { autoNextVal = value; });
const updateQuiz = bindToggle(els.enableQuiz, () => enableQuizVal, (value) => { enableQuizVal = value; });
const updateCaptcha = bindToggle(els.enableCaptcha, () => enableCaptchaVal, (value) => { enableCaptchaVal = value; });
const updateDiscussion = bindToggle(els.enableDiscussion, () => enableDiscussionVal, (value) => { enableDiscussionVal = value; });
const updateRestudy = bindToggle(els.restudy, () => restudyVal, (value) => { restudyVal = value; });

async function load() {
  const result = await chrome.storage.local.get("config");
  config = withoutRemovedConfigFields({ ...DEFAULTS, ...(result.config || {}) });

  els.rate.value = config.playbackRate;
  els.rateVal.textContent = config.playbackRate + "x";
  mutedVal = !!config.muted;
  audioMutedVal = config.audioMuted !== false;
  autoMaxRateVal = config.autoMaxPlaybackRate !== false;
  enableSeekVal = config.enableSeek !== false;
  advanceAtNinetyPercentVal = config.advanceAtNinetyPercent !== false;
  autoNextVal = config.autoNext !== false;
  enableQuizVal = config.enableQuiz !== false;
  enableCaptchaVal = config.enableCaptcha !== false;
  enableDiscussionVal = config.enableDiscussion !== false;
  restudyVal = !!config.restudy;
  updateMuted(mutedVal);
  updateAudioMuted(audioMutedVal);
  updateAutoMaxRate(autoMaxRateVal);
  updateSeek(enableSeekVal);
  updateNinety(advanceAtNinetyPercentVal);
  updateAutoNext(autoNextVal);
  updateQuiz(enableQuizVal);
  updateCaptcha(enableCaptchaVal);
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
  els.discussionReply.value = config.discussionReply || "1";
  if (!config.apiUrl || !config.model) {
    applyProviderPreset(els.providerPreset.value);
  }
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
    toast("Please enter API Key");
    return;
  }
  if (!cfg.model) {
    toast("Please enter model");
    return;
  }
  if ((cfg.apiType === "openai" || cfg.apiType === "gemini") && !cfg.apiUrl) {
    toast("Please enter API URL");
    return;
  }

  try {
    els.testApi.disabled = true;
    els.testApi.textContent = "Testing...";
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
      toast("API OK: " + (result.message || "connected"));
    } else {
      config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: true, apiConnectionError: (result && result.error) || "connection failed" });
      toast((result && result.error) || "connection failed");
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    config = withoutRemovedConfigFields({ ...config, apiConnectionFailed: true, apiConnectionError: message });
    await appendPopupLog("error", "api test direct failed", { error: message.slice(0, 300) });
    toast("API test failed");
  } finally {
    els.testApi.disabled = false;
    els.testApi.textContent = "Test API";
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
els.apiType.addEventListener("change", scheduleApiAutoSave);

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
