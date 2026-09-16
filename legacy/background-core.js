// Loaded lazily by background.js after the service worker has registered.
const DEFAULT_CONFIG = {
  playbackRate: 1.0,
  muted: false,
  autoNext: true,
  enableQuiz: true,
  enableMedia: true,
  enablePPT: true,
  enableHyperlink: true,
  restudy: false,
  providerPreset: 'minimax',
  apiType: 'openai',
  apiUrl: 'https://api.minimaxi.com',
  apiKey: '',
  apiConnectionFailed: false,
  model: 'MiniMax-M2.7',
  systemPrompt: '',
  pageScriptUrl: '',
  remoteVersionUrl: '',
  maxTokens: 8192
};

const MAX_LOGS = 200;
let runtimeLogs = [];
let backgroundStartError = '';
const backgroundStartedAt = Date.now();

function pushRuntimeLog(level, message, meta) {
  runtimeLogs.push({
    time: Date.now(),
    level: level || 'info',
    message: String(message || ''),
    meta: meta || null
  });
  if (runtimeLogs.length > MAX_LOGS) {
    runtimeLogs = runtimeLogs.slice(-MAX_LOGS);
  }
}

function recordBackgroundError(scope, error) {
  const message = error && error.message ? error.message : String(error || '');
  backgroundStartError = `${scope}: ${message}`;
  try {
    pushRuntimeLog('error', 'background error', { scope, message });
  } catch (e) {}
}

function getLastErrorMessage() {
  try {
    const lastError = chrome.runtime && chrome.runtime.lastError;
    return lastError && (lastError.message || String(lastError));
  } catch (e) {
    return '';
  }
}

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (result) => {
        const error = getLastErrorMessage();
        if (error) {
          recordBackgroundError('storage.get', error);
          resolve({});
          return;
        }
        resolve(result || {});
      });
    } catch (error) {
      recordBackgroundError('storage.get', error);
      resolve({});
    }
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        const error = getLastErrorMessage();
        if (error) recordBackgroundError('storage.set', error);
        resolve();
      });
    } catch (error) {
      recordBackgroundError('storage.set', error);
      resolve();
    }
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const error = getLastErrorMessage();
        if (error) {
          recordBackgroundError('tabs.query', error);
          resolve([]);
          return;
        }
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    } catch (error) {
      recordBackgroundError('tabs.query', error);
      resolve([]);
    }
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, () => {
        getLastErrorMessage();
        resolve();
      });
    } catch (error) {
      recordBackgroundError('tabs.sendMessage', error);
      resolve();
    }
  });
}

function safeAddListener(event, handler, scope) {
  try {
    if (!event || typeof event.addListener !== 'function') {
      throw new Error('event unavailable');
    }
    event.addListener(handler);
  } catch (error) {
    recordBackgroundError(scope, error);
  }
}

async function loadConfig() {
  const result = await storageGet('config');
  const config = { ...(result.config || {}) };
  delete config.forceLearn;
  return { ...DEFAULT_CONFIG, ...config };
}

function normalizeApiKey(apiKey) {
  return String(apiKey || '').trim().replace(/^Bearer\s+/i, '');
}

async function updateApiConnectionFailed(failed, reason) {
  try {
    const result = await storageGet('config');
    const config = { ...(result.config || {}) };
    if (!!config.apiConnectionFailed === !!failed && (!reason || config.apiConnectionError === reason)) return;
    config.apiConnectionFailed = !!failed;
    if (failed && reason) config.apiConnectionError = String(reason).slice(0, 300);
    if (!failed) delete config.apiConnectionError;
    await storageSet({ config });
  } catch (e) {}
}

function buildOpenAICompatibleUrl(apiUrl) {
  const trimmed = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return `${DEFAULT_CONFIG.apiUrl}/v1/chat/completions`;
  if (/\/v1\/chat\/completions$/i.test(trimmed) || /\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function buildClaudeApiUrl(apiUrl) {
  const base = String(apiUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(base) || /\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function buildGeminiApiUrl(apiUrl, model, apiKey) {
  const base = String(apiUrl || 'https://generativelanguage.googleapis.com').trim().replace(/\/+$/, '');
  if (/\/models\/[^/]+:generateContent/i.test(base)) {
    if (/[?&]key=/.test(base)) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}key=${encodeURIComponent(apiKey)}`;
  }
  const root = /\/v1beta$/i.test(base) ? base : `${base}/v1beta`;
  return `${root}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function buildSystemPrompt(config) {
  if (config.systemPrompt) return config.systemPrompt;

  return [
    'Never return null, empty string, undefined, or omit answer.',
    'For choice questions, answer must be one or more option labels or valid true/false for judge questions.',
    'If previous wrong answers are listed, choose a different non-empty answer. If all choices look forbidden, still return your best non-empty answer.',
    '你是学习通答题助手。',
    '请根据题目和选项给出最可能正确的答案。',
    '只输出 JSON 数组，不要解释，不要思考过程，不要使用 <think>。',
    '单选题 answer 返回一个选项字母。',
    '多选题 answer 返回选项字母数组。',
    '判断题 answer 返回“正确”或“错误”。',
    '填空题和简答题 answer 返回文本。'
  ].join('\n');
}

function buildQuestionsText(questions) {
  const hardRule = 'Important: every JSON item must include a non-empty answer. Never return null, empty string, undefined, or omit answer. If uncertain, choose the best available option.';
  return `${hardRule}\n\n${questions.map((q, i) => {
    let text = `题目${i + 1} [类型: ${q.type}]: ${q.title}`;
    if (q.options && q.options.length > 0) {
      text += '\n选项:';
      q.options.forEach((opt, j) => {
        const label = String.fromCharCode(65 + j);
        text += `\n  ${label}. ${opt}`;
      });
    }
    if (q.previousWrongAnswers && q.previousWrongAnswers.length > 0) {
      text += `\nKnown wrong answers from previous submit, do not return these again: ${q.previousWrongAnswers.join(', ')}`;
      text += '\nTreat the known wrong answers as forbidden choices. Pick a different answer even if uncertain.';
    }
    return text;
  }).join('\n\n')}`;
}

function buildOutputFormat(questions) {
  const formats = questions.map((q, i) => {
    switch (q.type) {
      case 'single':
        return `  {"index": ${i}, "type": "single", "answer": "A"}`;
      case 'multiple':
        return `  {"index": ${i}, "type": "multiple", "answer": ["A", "C"]}`;
      case 'judge':
        return `  {"index": ${i}, "type": "judge", "answer": "正确"}`;
      case 'fill':
        return `  {"index": ${i}, "type": "fill", "answer": "答案文本"}`;
      case 'short':
        return `  {"index": ${i}, "type": "short", "answer": "答案文本"}`;
      default:
        return `  {"index": ${i}, "type": "${q.type}", "answer": "..."}`;
    }
  });
  return `[\n${formats.join(',\n')}\n]`;
}

function parseLLMResponse(text) {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  try {
    return { success: true, data: JSON.parse(cleaned) };
  } catch (e) {}

  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return { success: true, data: JSON.parse(jsonMatch[1].trim()) };
    } catch (e2) {}
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return { success: true, data: JSON.parse(arrayMatch[0]) };
    } catch (e3) {}
  }

  return { success: false, error: `无法解析 LLM 返回内容: ${cleaned.substring(0, 200)}` };
}

async function callOpenAICompatibleAPI(config, questions) {
  const url = buildOpenAICompatibleUrl(config.apiUrl);
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(config) },
      {
        role: 'user',
        content: `请回答以下题目。严格返回 JSON 数组。\n\n${buildQuestionsText(questions)}\n\n返回格式示例:\n${buildOutputFormat(questions)}`
      }
    ],
    max_tokens: config.maxTokens,
    temperature: 0.1
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${normalizeApiKey(config.apiKey)}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI 兼容请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  return parseLLMResponse(content);
}

async function callClaudeAPI(config, questions) {
  const url = buildClaudeApiUrl(config.apiUrl);
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: 0.1,
    system: buildSystemPrompt(config),
    messages: [
      {
        role: 'user',
        content: `请回答以下题目。严格返回 JSON 数组。\n\n${buildQuestionsText(questions)}\n\n返回格式示例:\n${buildOutputFormat(questions)}`
      }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': normalizeApiKey(config.apiKey),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  return parseLLMResponse(content);
}

async function callGeminiAPI(config, questions) {
  const apiKey = normalizeApiKey(config.apiKey);
  const url = buildGeminiApiUrl(config.apiUrl, config.model, apiKey);
  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(config) }]
    },
    contents: [
      {
        role: 'user',
        parts: [{
          text: `请回答以下题目。严格返回 JSON 数组。\n\n${buildQuestionsText(questions)}\n\n返回格式示例:\n${buildOutputFormat(questions)}`
        }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: config.maxTokens
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const content = parts.map((part) => part && part.text ? part.text : '').join('\n').trim();
  return parseLLMResponse(content);
}

async function handleLLMRequest(payload) {
  const { questions } = payload;
  const config = await loadConfig();

  pushRuntimeLog('info', 'llm_request', { questionCount: Array.isArray(questions) ? questions.length : 0 });

  if (!config.apiKey) {
    return { success: false, error: '请先在插件设置中配置 API Key' };
  }
  if (config.apiConnectionFailed) {
    return { success: false, error: config.apiConnectionError || 'API 连接失败，请重新保存 API 后再试' };
  }

  try {
    let result;
    if (config.apiType === 'claude') {
      result = await callClaudeAPI(config, questions);
    } else if (config.apiType === 'gemini') {
      result = await callGeminiAPI(config, questions);
    } else {
      result = await callOpenAICompatibleAPI(config, questions);
    }

    if (result && result.success) {
      await updateApiConnectionFailed(false);
    } else {
      await updateApiConnectionFailed(true, (result && result.error) || 'LLM 返回解析失败');
    }
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await updateApiConnectionFailed(true, message);
    return { success: false, error: message };
  }
}

async function testOpenAICompatibleConnection(config) {
  const url = buildOpenAICompatibleUrl(config.apiUrl);
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: 'You are a connectivity check. Reply with OK only.' },
      { role: 'user', content: 'Reply with OK' }
    ],
    max_tokens: 12,
    temperature: 0
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${normalizeApiKey(config.apiKey)}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: `连接失败 (${response.status}): ${errorText}` };
  }

  const data = await response.json();
  const message = (data.choices?.[0]?.message?.content || 'OK').trim().replace(/\s+/g, ' ');
  return { success: true, endpoint: url, message: message.substring(0, 80) || 'OK' };
}

async function testClaudeConnection(config) {
  const url = buildClaudeApiUrl(config.apiUrl);
  const body = {
    model: config.model,
    max_tokens: 12,
    temperature: 0,
    messages: [
      { role: 'user', content: 'Reply with OK' }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': normalizeApiKey(config.apiKey),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: `连接失败 (${response.status}): ${errorText}` };
  }

  const data = await response.json();
  const message = (data.content?.[0]?.text || 'OK').trim().replace(/\s+/g, ' ');
  return { success: true, endpoint: url, message: message.substring(0, 80) || 'OK' };
}

async function testGeminiConnection(config) {
  const apiKey = normalizeApiKey(config.apiKey);
  const url = buildGeminiApiUrl(config.apiUrl, config.model, apiKey);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Reply with OK' }]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 12
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: `连接失败 (${response.status}): ${errorText}` };
  }

  const data = await response.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const message = parts.map((part) => part && part.text ? part.text : '').join(' ').trim().replace(/\s+/g, ' ');
  return { success: true, endpoint: url, message: (message || 'OK').substring(0, 80) };
}

async function testAPIConnection(rawConfig) {
  const config = { ...(await loadConfig()), ...(rawConfig || {}) };
  config.apiKey = normalizeApiKey(config.apiKey);

  if (!config.apiKey) return { success: false, error: '请先填写 API Key' };
  if (!config.model) return { success: false, error: '请先填写模型名' };

  if (config.apiType === 'claude') return testClaudeConnection(config);
  if (config.apiType === 'gemini') return testGeminiConnection(config);
  if (!config.apiUrl) return { success: false, error: '请先填写接口地址' };

  return testOpenAICompatibleConnection(config);
}

async function checkForUpdate() {
  const config = await loadConfig();
  if (!config.remoteVersionUrl) return;

  try {
    const resp = await fetch(config.remoteVersionUrl, { cache: 'no-cache' });
    if (!resp.ok) return;
    const remote = await resp.json();
    const newUrl = remote.url || remote.pageScriptUrl;
    const newVersion = remote.version || '';

    if (newUrl && newUrl !== config.pageScriptUrl) {
      console.log('[Omitone] found remote update:', newVersion);
      pushRuntimeLog('info', 'found remote update', { version: newVersion, url: newUrl });
      config.pageScriptUrl = newUrl;
      await storageSet({ config });
      const tabs = await tabsQuery({ url: '*://*.chaoxing.com/*' });
      for (const tab of tabs) {
        tabsSendMessage(tab.id, { type: 'xxt_config_updated', config });
      }
    }
  } catch (e) {}
}

let backgroundJobsReady = false;

function ensureBackgroundJobs() {
  if (backgroundJobsReady) return;
  backgroundJobsReady = true;

  try {
    if (chrome.alarms && typeof chrome.alarms.create === 'function') {
      chrome.alarms.create('checkUpdate', { periodInMinutes: 1440 });
    }
  } catch (error) {
    recordBackgroundError('alarms.create', error);
  }
}

async function handleMessage(message, sender) {
  ensureBackgroundJobs();

  if (message.type === 'llm_request') {
    return handleLLMRequest(message.payload);
  }

  if (message.type === 'get_config') {
    return loadConfig();
  }

  if (message.type === 'check_update') {
    await checkForUpdate();
    return { success: true };
  }

  if (message.type === 'test_api_connection') {
    try {
      const result = await testAPIConnection(message.config);
      await updateApiConnectionFailed(!(result && result.success), result && result.error);
      return result;
    } catch (err) {
      const messageText = err && err.message ? err.message : String(err);
      await updateApiConnectionFailed(true, messageText);
      return { success: false, error: messageText };
    }
  }

  if (message.type === 'append_runtime_log') {
    pushRuntimeLog(message.level, message.message, message.meta);
    return { success: true };
  }

  if (message.type === 'get_runtime_logs') {
    return { success: true, logs: runtimeLogs };
  }

  if (message.type === 'clear_runtime_logs') {
    runtimeLogs = [];
    return { success: true };
  }

  return { success: false, error: 'unknown background message: ' + String(message.type || '') };
}

function onAlarm(alarm) {
  ensureBackgroundJobs();
  if (alarm && alarm.name === 'checkUpdate') return checkForUpdate();
}

function onInstalled() {
  ensureBackgroundJobs();
  return checkForUpdate();
}

function onStartup() {
  ensureBackgroundJobs();
  return checkForUpdate();
}

function onStorageChanged(changes, area) {
  ensureBackgroundJobs();
  if (area === 'local' && changes.config) {
    const config = { ...(changes.config.newValue || {}) };
    delete config.forceLearn;
    tabsQuery({ url: '*://*.chaoxing.com/*' }).then((tabs) => {
      for (const tab of tabs) {
        tabsSendMessage(tab.id, { type: 'xxt_config_updated', config });
      }
    });
  }
}

self.OmitoneBackgroundCore = {
  handleMessage,
  onAlarm,
  onInstalled,
  onStartup,
  onStorageChanged,
  getStatus() {
    return {
      success: true,
      backgroundStartedAt,
      backgroundStartError,
      backgroundJobsReady
    };
  }
};
