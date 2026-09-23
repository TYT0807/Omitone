/**
 * Content bridge for Omitone.
 * Injects the bundled page runtime and proxies extension APIs into page context.
 */
(function () {
  'use strict';

  const AUTO_START_ATTR = 'data-xxt-auto-start';
  const PAGE_SCRIPT_ID = 'xxt-page-script';
  const STATUS_PANEL_ID = 'omitone-status-panel-host';
  const RUNTIME_LOGS_KEY = 'runtimeLogs';
  const MAX_LOGS = 200;

  if (window.top !== window) {
    console.log('%c[Omitone] skip nested frame bridge', 'color:#999');
    return;
  }

  // 注入范围已扩展到所有网址（验证码可能是一个独立网址/弹出窗口），但只在两种情况下真正工作：
  // 1) 学习通页面；2) 正在刷课 + 疑似验证码页。其余网站立即静默退出，不做任何事、不注入脚本。
  const HREF = location.href || '';
  const IS_CHAOXING_PAGE = /^https?:\/\/[\w.-]*chaoxing\.com(:\d+)?\//i.test(HREF);
  const CAPTCHA_URL_RE = /(verif|captcha|checkcode|validate|seccode|yzm|\/code|captchaImage)/i;

  function isCaptchaLikePage() {
    if (CAPTCHA_URL_RE.test(location.href || '')) return true;
    try {
      const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 800);
      if (text && /验证码|校验码|captcha|verify|robot|人机|安全验证/i.test(text)) {
        return !!document.querySelector('img') && !!document.querySelector('input:not([type="hidden"])');
      }
    } catch (e) {}
    return false;
  }

  function readRunningFlag() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('xxtRunning', (result) => {
          resolve(!chrome.runtime.lastError && !!(result && result.xxtRunning));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  let configs = {
    playbackRate: 1.0,
    muted: false,
    autoNext: true,
    enableQuiz: true,
    randomAnswer: false,
    enableMedia: true,
    enablePPT: true,
    enableHyperlink: true,
    restudy: false,
    providerPreset: 'deepseek',
    apiType: 'openai',
    apiUrl: 'https://api.deepseek.com',
    apiKey: '',
    apiConnectionFailed: false,
    model: 'deepseek-v4-flash',
    systemPrompt: '',
    // 思考强度：'off'（默认）/ 'low' / 'high'。详见 libs/thinking.js。
    // 必须在这里也放一份：content.js 在配置还没加载完时靠它兜底，
    // 缺了会读成 undefined（`tools/check.js` 的「读了就必须有自己的默认值」守卫会报错）。
    thinkingLevel: 'off',
    retryInterval: 2000,
    maxRetries: 10,
    videoCheckInterval: 1500,
    guardNoProgressMs: 6000,
    // 单个任务点连续几次"派发了但没完成"就放弃（24 小时内不再尝试）。
    // 用于对付老师设成防拖拽/不可翻页、或本身不计分的任务点。
    taskGiveUpAttempts: 4,
    guardResumeCooldownMs: 2500,
    guardMaxResumeWindow: 15000,
    guardMaxResumes: 5
  };

  let decryptTablePromise = null;
  const decryptMapCache = new Map();
  let decryptSweepTimer = null;
  const observedDocs = new WeakSet();
  let statusPanel = null;
  let statusPanelActive = false;
  let statusLastSignature = '';
  let pageRuntimeActivityAt = 0;
  let pageInjectSeq = 0;
  let runtimeLogQueue = Promise.resolve();

  function appendRuntimeLog(level, message, meta) {
    const item = {
      time: Date.now(),
      level: level || 'info',
      message: String(message || ''),
      meta: meta || null
    };
    runtimeLogQueue = runtimeLogQueue.then(() => new Promise((resolve) => {
      chrome.storage.local.get(RUNTIME_LOGS_KEY, (result) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        const logs = result && Array.isArray(result[RUNTIME_LOGS_KEY]) ? result[RUNTIME_LOGS_KEY] : [];
        logs.push(item);
        const nextLogs = logs.slice(-MAX_LOGS);
        chrome.storage.local.set({ [RUNTIME_LOGS_KEY]: nextLogs }, resolve);
      });
    })).catch(() => {});
  }

  function sendRuntimeMessageWithTimeout(message, timeoutMs, timeoutError) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, error: timeoutError || '请求超时' });
      }, timeoutMs || 60000);

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
          resolve(response || { success: false, error: '后台无响应' });
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  // API 地址构造与密钥清洗的唯一真源是 libs/api-url.js（manifest 里排在 content.js 之前注入）。
  // 这几段原先在 content.js 与 popup/popup.js 里各写了一份，并且已经分叉 ——
  // 只有 popup 那份会剥掉用户粘贴时带上的引号，于是"弹窗测试通过、页面回答题失败"
  // 这类诡异现象就有了土壤。这里只做转发，调用点保持不变。
  const API_URL = (typeof self !== 'undefined' && self.OmitoneApiUrl) || null;

  // 字形哈希表的编解码唯一真源是 libs/font-table.js（同样排在 content.js 之前注入）
  const FONT_TABLE = (typeof self !== 'undefined' && self.OmitoneFontTable) || null;

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

  // 提示词唯一真源在 libs/prompt.js（manifest 里排在 content.js 之前注入）。
  // 两个文件来自同一次扩展加载，不会出现版本错配；若真缺失说明扩展资源损坏，
  // 此时宁可明确报错，也不要用一份悄悄分叉的兜底提示词继续答题。
  const PROMPT = (typeof self !== 'undefined' && self.OmitonePrompt) || null;

  // 思考参数的唯一真源是 libs/thinking.js（同样排在 content.js 之前注入）。
  // 原先这里写死成"只对 DeepSeek 加 thinking:{type:disabled}"，改为按渠道白名单：
  // 不认识的渠道在"关闭"档一个参数都不发 —— 与升级前的行为完全一致，
  // 所以不会把任何现有用户搞成 400。详见那个文件顶部的说明。
  const THINKING = (typeof self !== 'undefined' && self.OmitoneThinking) || null;

  /**
   * 扩展自带资源缺失时的统一报错。
   *
   * 这些模块（libs/prompt.js、libs/api-url.js）由 manifest 在 content.js 之前注入，
   * 正常情况下不可能缺。但真缺的时候，若不做检查，症状是
   * `Cannot read properties of null (reading 'buildOpenAICompatibleUrl')`
   * —— 完全看不出是"扩展没重新加载"，排查成本极高。
   * 统一返回一句可操作的提示，比抛原生 TypeError 有用得多。
   */
  function missingModuleError() {
    if (!API_URL) return 'api-url module missing (libs/api-url.js) — 请在 edge://extensions 重新加载扩展';
    if (!PROMPT) return 'prompt module missing (libs/prompt.js) — 请在 edge://extensions 重新加载扩展';
    if (!THINKING) return 'thinking module missing (libs/thinking.js) — 请在 edge://extensions 重新加载扩展';
    return '';
  }

  /**
   * 这次请求该带哪些思考参数（按渠道白名单，见 libs/thinking.js）。
   *
   * 返回一个**可安全合并进请求体**的对象：认不出的渠道返回空对象 ——
   * 每个厂商对未知参数的反应不一样，有的忽略、有的直接 400，
   * 所以"不发"永远是安全默认。
   */
  function buildThinkingParams(config) {
    if (!THINKING) return {};
    try {
      return THINKING.buildThinkingParams(config).params || {};
    } catch (e) {
      return {};
    }
  }

  function buildSystemPrompt(config) {
    return PROMPT.buildSystemPrompt(config);
  }

  /**
   * 按题型把答案规整成 page.js 能匹配的形态。
   *
   * 位置式输出（`["A",["A","C"],true,…]`）虽然短，但模型偶尔会：
   *   - 把单选答成单元素数组 `["A"]`
   *   - 把判断答成中文 "正确" / "错误"，或 "T"/"√"
   * 这两种形态原样交给 page.js，`_matchOptionItem` 匹配不上，
   * 结果是**这题静默不填** → 表单不满 → 永不提交，且要等下一轮 tick 才重试。
   * 在这里顺手规整，能把"静默不填"变回"正常作答"，代价几乎为零。
   *
   * 只做无歧义的转换：数组→首个非空元素仅用于单选/判断（多选必须保留整个数组）。
   */
  function coerceAnswerForType(answer, type) {
    if (!type) return answer;

    if ((type === 'single' || type === 'judge') && Array.isArray(answer)) {
      var first = answer.filter(function (item) {
        return item !== null && item !== undefined && String(item).trim() !== '';
      })[0];
      // 全部元素都为空时原样返回，交给下游按空答案丢弃
      return first === undefined ? answer : first;
    }

    if (type === 'judge' && typeof answer === 'string') {
      var text = answer.trim();
      if (/^(正确|对|是|√|true|t|yes|y)$/i.test(text)) return true;
      if (/^(错误|错|否|×|x|false|f|no|n)$/i.test(text)) return false;
    }

    return answer;
  }

  function parseLLMResponse(text) {
    const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    try {
      return { success: true, data: JSON.parse(cleaned) };
    } catch (e) {}
    const code = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (code) {
      try {
        return { success: true, data: JSON.parse(code[1].trim()) };
      } catch (e2) {}
    }
    const array = cleaned.match(/\[[\s\S]*\]/);
    if (array) {
      try {
        return { success: true, data: JSON.parse(array[0]) };
      } catch (e3) {}
    }
    if (/^\s*\{/.test(cleaned)) {
      try {
        const obj = JSON.parse(cleaned);
        if (obj && (obj.answer != null || obj.a != null)) return { success: true, data: [obj] };
      } catch (e4) {}
    }
    // 数组残缺时逐对象捞取。同时认新短键 a 与旧键 answer（见 libs/prompt.js 的兼容说明）
    const objects = cleaned.match(/\{[^{}]*(?:"answer"|"a")\s*:[^{}]*\}/g);
    if (objects && objects.length) {
      try {
        const arr = objects.map((s) => JSON.parse(s)).filter((o) => o && (o.answer != null || o.a != null));
        if (arr.length) return { success: true, data: arr };
      } catch (e5) {}
    }
    return { success: false, error: `Unable to parse AI response: ${cleaned.slice(0, 200)}` };
  }

  async function apiFetch(url, options, timeoutMs) {
    const timeout = timeoutMs || 60000;
    const proxy = await sendRuntimeMessageWithTimeout({
      type: 'api_fetch',
      payload: {
        url,
        method: (options && options.method) || 'POST',
        headers: (options && options.headers) || {},
        body: (options && options.body) || '',
        timeoutMs: timeout
      }
    }, timeout + 15000, 'background api fetch timeout');

    if (proxy && proxy.success && typeof proxy.text === 'string') {
      return proxy;
    }
    if (proxy && proxy.status && typeof proxy.text === 'string') {
      return proxy;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...(options || {}), signal: controller.signal });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {}
      return { success: response.ok, status: response.status, statusText: response.statusText, text, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function updateApiConnectionState(failed, reason) {
    const current = await loadConfig();
    const next = { ...current, apiConnectionFailed: !!failed };
    if (failed && reason) next.apiConnectionError = String(reason).slice(0, 300);
    if (!failed) delete next.apiConnectionError;
    configs = { ...configs, ...next };
    chrome.storage.local.set({ config: next });
  }

  /**
   * 记录前缀缓存命中情况。
   *
   * DeepSeek 在 usage 里给 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
   * （命中部分按约 1/10 价计费）。命中率是"省 token 改动"是否真的有效的唯一证据：
   * 只看输入总长度会得出完全相反的结论 —— 我们曾经把提示词压到极短，
   * 输入是短了，但公共前缀短到无法被识别成缓存单元，于是每一分输入都按原价计费。
   *
   * 命中为 0 时给一条 warn，因为那说明请求前缀被什么东西打脏了
   * （提示词里混进了每次都变的内容，或重试时题目被从中间删掉）。
   */
  function logCacheUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    const hit = Number(usage.prompt_cache_hit_tokens);
    const miss = Number(usage.prompt_cache_miss_tokens);
    if (!isFinite(hit) && !isFinite(miss)) return; // 非 DeepSeek 服务不报这两个字段
    const hitTokens = isFinite(hit) ? hit : 0;
    const missTokens = isFinite(miss) ? miss : 0;
    const total = hitTokens + missTokens;
    const meta = {
      hit: hitTokens,
      miss: missTokens,
      hitRate: total ? Math.round(hitTokens / total * 100) + '%' : 'n/a'
    };
    if (total && hitTokens === 0) {
      appendRuntimeLog('warn', 'llm prefix cache all missed', meta);
    } else {
      appendRuntimeLog('info', 'llm prefix cache', meta);
    }
  }

  /**
   * 记账：把一次请求的 token 消耗写进日志。
   *
   * 为什么必须做（尤其是视觉请求）：视觉请求的图占大头，而**图并不在提示词里** ——
   * logCacheUsage 只看 prompt_cache_* 字段，对图片 token 一无所知。
   * 于是出现了最糟的组合：用户在花钱、日志里一片安静、出了事也查不出原因。
   *
   * 这里把 input/output 总数记出来，带 tag 区分（text / captcha / vision），
   * 让用户在弹窗「查看日志」里就能看到每一类花了多少。
   */
  function logTokenUsage(usage, tag) {
    if (!usage || typeof usage !== 'object') return;
    const prompt = Number(usage.prompt_tokens);
    const completion = Number(usage.completion_tokens);
    if (!isFinite(prompt) && !isFinite(completion)) return; // 该服务不报用量
    const promptTokens = isFinite(prompt) ? prompt : 0;
    const completionTokens = isFinite(completion) ? completion : 0;
    appendRuntimeLog('info', 'llm usage', {
      tag: tag || 'text',
      in: promptTokens,
      out: completionTokens,
      total: promptTokens + completionTokens
    });
  }

  /**
   * 构造一个带 HTTP 状态码的错误。
   *
   * ⚠️ 带上 status 是为了让上层能分清「永久错误」和「可以重试的错误」——
   * 之前所有失败都走同一个 throw，上层一律当成网络故障，见 httpErrorIsPermanent 的说明。
   */
  function makeHttpError(prefix, response) {
    const status = response ? response.status : undefined;
    const err = new Error(
      prefix + ' request failed (' + (status || 'network') + '): ' +
      String((response && (response.text || response.error)) || '').slice(0, 300)
    );
    err.httpStatus = status;
    return err;
  }

  /**
   * 判断一个 HTTP 状态码是不是「重试也没用」的永久错误。
   *
   * 为什么必须区分（实测踩出来的，不是推断）：
   *   401 / 403 / 404 通常是「API Key 填错、没权限、模型名写错」，重试一万次也一样。
   *   而上层过去把它们一律当成网络故障 → 写 apiConnectionFailed →
   *   page.js 设 45 秒退避且每次续期。用户的真实体验是：
   *   **填错 Key 之后插件表现为"卡死、整卷跳过"，而不是告诉他 Key 错了。**
   *
   * 429（限流）除外 —— 等一会儿是真的能恢复，退避对它恰恰是正确的处理。
   * 5xx 是服务端自己的事，也可能恢复，同样归到可重试。
   */
  function httpErrorIsPermanent(status) {
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
  }

  async function callOpenAICompatibleAPI(config, questions) {
    const url = buildOpenAICompatibleUrl(config.apiUrl);
    const messages = [
      { role: 'system', content: buildSystemPrompt(config) },
      { role: 'user', content: PROMPT.buildUserPrompt(questions) }
    ];
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${normalizeApiKey(config.apiKey)}`
    };

    let maxTokens = Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 8192;
    let tokenField = 'max_tokens';

    // 思考参数：按渠道白名单算一次（见 libs/thinking.js）。
    // 升级前这段写死成"只对 DeepSeek 加 thinking:{type:disabled}"，
    // 所以旧行为 = 现在的 'off' 档，老用户升级后没有任何变化。
    let thinkingParams = buildThinkingParams(config);
    let thinkingStripped = false;
    const thinkingSummary = THINKING ? THINKING.describe(config) : 'thinking module missing';

    for (let attempt = 0; attempt < 4; attempt++) {
      const body = { model: config.model, messages, temperature: 0.1 };
      body[tokenField] = maxTokens;
      // 思考参数合并进来。
      // ⚠️ 只发白名单里的字段：其他 OpenAI 兼容服务商对未知参数的反应不一致，
      // 有的忽略、有的直接 400，所以"不发"是安全默认（见 buildThinkingParams）。
      Object.assign(body, thinkingParams);
      const response = await apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, 120000);

      if (response.success) {
        const choice = (((response.data || {}).choices || [])[0] || {}).message || {};
        // 把前缀缓存的命中情况记进日志。
        // 不记的话，"省 token 的改动是不是把缓存打没了"只能靠猜 ——
        // 我们真的这样翻过车：提示词压得太短，公共前缀无法被识别成缓存单元，
        // 命中率长期恒为 0，而界面上看不出任何异常。
        logCacheUsage((response.data || {}).usage);
        logTokenUsage((response.data || {}).usage, 'text');
        return parseLLMResponse(choice.content || '');
      }

      const errText = String(response.text || response.error || '').slice(0, 300);
      if (response.status === 400) {
        if (attempt === 0 && /max_tokens/i.test(errText) && /unsupported|not support|unknown|invalid|参数/i.test(errText)) {
          appendRuntimeLog('warn', 'llm max_tokens unsupported, retry with max_completion_tokens', {});
          tokenField = 'max_completion_tokens';
          continue;
        }
        if (/max_tokens|max_completion_tokens|token/i.test(errText) && /limit|exceed|too (large|big)|range|between|must be|参数/i.test(errText) && maxTokens > 1024) {
          appendRuntimeLog('warn', 'llm max_tokens out of range, retry lower', { maxTokens });
          maxTokens = Math.max(1024, Math.floor(maxTokens / 2));
          continue;
        }
        // 服务商不认这套思考参数（用户选了"低/高"档时最可能碰到）：
        // **摘掉它重试一次**，而不是把整次答题判死。
        // 不这么做的话，症状是"换了个模型就一直 400" —— 看起来像插件坏了。
        if (!thinkingStripped && Object.keys(thinkingParams).length &&
            /reasoning_effort|enable_thinking|thinking|unsupported|unknown|unexpected|extra|not support|invalid|参数|不支持/i.test(errText)) {
          thinkingStripped = true;
          thinkingParams = {};
          appendRuntimeLog('warn', 'llm rejected thinking params, retry without them', {
            error: errText.slice(0, 160),
            thinking: thinkingSummary
          });
          continue;
        }
      }
      throw makeHttpError('API', response);
    }
    throw new Error('API request failed after parameter retries');
  }

  async function callClaudeAPI(config, questions) {
    const url = buildClaudeApiUrl(config.apiUrl);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': normalizeApiKey(config.apiKey),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens || 8192,
        temperature: 0.1,
        system: buildSystemPrompt(config),
        messages: [{ role: 'user', content: PROMPT.buildUserPrompt(questions) }]
      })
    }, 120000);
    if (!response.success) throw makeHttpError('Claude', response);
    const content = (((response.data || {}).content || [])[0] || {}).text || '';
    return parseLLMResponse(content);
  }

  async function callGeminiAPI(config, questions) {
    const apiKey = normalizeApiKey(config.apiKey);
    const url = buildGeminiApiUrl(config.apiUrl, config.model, apiKey);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(config) }] },
        contents: [{ role: 'user', parts: [{ text: PROMPT.buildUserPrompt(questions) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: config.maxTokens || 8192 }
      })
    }, 120000);
    if (!response.success) throw makeHttpError('Gemini', response);
    const parts = ((((response.data || {}).candidates || [])[0] || {}).content || {}).parts || [];
    return parseLLMResponse(parts.map((part) => part && part.text ? part.text : '').join('\n').trim());
  }

  async function callLLMProvider(config, questions) {
    if (config.apiType === 'claude') return callClaudeAPI(config, questions);
    if (config.apiType === 'gemini') return callGeminiAPI(config, questions);
    return callOpenAICompatibleAPI(config, questions);
  }

  async function requestAnswersWithRetry(config, questions) {
    let lastError = '';
    let lastWasNetwork = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callLLMProvider(config, questions);
        if (result && result.success) return result;
        lastError = (result && result.error) || 'AI response parse failed';
        lastWasNetwork = false;
        appendRuntimeLog('warn', 'llm response parse failed' + (attempt === 0 ? ', retrying' : ''), { error: String(lastError).slice(0, 200) });
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);

        // 永久错误（401 Key 无效 / 403 无权限 / 404 模型名错）：**重试没有意义**，
        // 更不能写 apiConnectionFailed —— 那会让 page.js 进入 45 秒退避循环，
        // 把"配置填错了"伪装成"网络连不上、插件卡死"。
        // 这里直接跳出重试，原样把服务商的报错返回给用户去看。
        if (httpErrorIsPermanent(error && error.httpStatus)) {
          appendRuntimeLog('error', 'llm_request rejected (permanent)', {
            status: error.httpStatus,
            error: lastError.slice(0, 300)
          });
          return { success: false, error: lastError, permanentError: true };
        }

        lastWasNetwork = true;
        appendRuntimeLog('warn', 'llm request error' + (attempt === 0 ? ', retrying' : ''), { error: lastError.slice(0, 300) });
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (lastWasNetwork) {
      await updateApiConnectionState(true, lastError);
      appendRuntimeLog('error', 'llm_request direct failed', { error: lastError.slice(0, 300) });
      return { success: false, error: lastError };
    }
    return { success: false, error: lastError, parseError: true };
  }

  async function handleLLMRequestDirect(payload) {
    const questions = payload && payload.questions ? payload.questions : [];
    const config = await loadConfig();
    appendRuntimeLog('info', 'llm_request direct', {
      questionCount: questions.length,
      // 把"这次用的是哪家、什么思考强度、发了什么参数"记下来。
      // 换渠道出问题时，第一个要问的就是这个 —— 否则只能靠猜。
      thinking: THINKING ? THINKING.describe(config) : 'thinking module missing'
    });

    const missing = missingModuleError();
    if (missing) {
      appendRuntimeLog('error', 'llm_request aborted', { error: missing });
      return { success: false, error: missing };
    }
    if (!config.apiKey) return { success: false, error: 'Please configure API Key first' };
    if (!questions.length) return { success: false, error: 'no questions to answer' };

    // 分批请求。
    //
    // 批越大越省 token：system 提示词与输出格式示例是**每批都要重发**的固定开销
    // （约 85 token/批），而题目正文无论分成几批都只发一次。
    // 40 题的卷子：每批 5 题 → 8 批 680 token 固定开销；每批 10 题 → 4 批 340。
    //
    // 1.0.10 取 5 是怕整卷请求超时或输出被 max_tokens 截断。现在输出已改成
    // 位置式数组（每题约 5 token），10 题也只有约 50 token，截断风险基本消失；
    // 开源实现 cxmooc-tools 的题库接口一批就是 20 题，10 属于保守取法。
    // 上限受 requestAnswersWithRetry 的超时保护，单批失败也只影响这一批。
    const CHUNK_SIZE = 10;
    const chunks = [];
    for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
      chunks.push(questions.slice(i, i + CHUNK_SIZE).map((question, offset) => {
        const raw = Number(question && question.index);
        return {
          origin: Number.isFinite(raw) && raw >= 0 ? raw : i + offset,
          type: (question && question.type) || 'single',
          question: question
        };
      }));
    }

    const merged = [];
    const filled = new Set();
    let lastFailure = null;

    // 把一次成功请求的返回按位置对齐合并进 merged。
    // 主批与"空答案补问"共用这一段，两处的对齐规则必须完全一致，
    // 所以抽成局部函数而不是复制粘贴。
    const mergeAnswers = (entries, result, label) => {
      // 位置式输出的前提是"数组长度 = 题目数"。长度不符时必须留下线索 ——
      // 否则表现是"有一部分题没被作答"，而日志里什么都看不到。
      // 处理上仍按位置尽力对齐：对不上的题保持未填，page.js 会因为"未填写"而不提交，
      // 下一轮 tick 会重新问一次，属于可自愈的降级。
      if (result.data.length !== entries.length) {
        appendRuntimeLog('warn', 'llm answer count mismatch' + (label ? ' (' + label + ')' : ''), {
          expected: entries.length,
          received: result.data.length
        });
      }

      result.data.forEach((item, position) => {
        const normalized = PROMPT.normalizeItem(item);
        if (!normalized) return;

        // 位置式输出没有 index，一律按 position 对齐；
        // 若模型仍回传了 index（旧的包装格式），优先信任 index，越界时退回 position。
        let slot = null;
        if (normalized.index != null && normalized.index < entries.length) {
          slot = entries[normalized.index];
        } else if (position < entries.length) {
          slot = entries[position];
        }
        if (!slot || filled.has(slot.origin)) return;

        filled.add(slot.origin);
        // type 取题目本身的实测结果而非模型自报值：_detectQuestionType 读的是真实 DOM，
        // 比模型复述更可靠，因此输出侧不需要回传 type（见 libs/prompt.js 的说明）。
        merged.push({
          index: slot.origin,
          type: slot.type,
          answer: coerceAnswerForType(normalized.answer, slot.type)
        });
      });
    };

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      if (chunks.length > 1) {
        appendRuntimeLog('info', 'llm request chunk', { chunk: ci + 1, total: chunks.length, questions: chunk.length });
      }

      const result = await requestAnswersWithRetry(config, chunk.map((entry) => entry.question));

      if (!(result && result.success && Array.isArray(result.data))) {
        lastFailure = result;
        continue;
      }

      mergeAnswers(chunk, result);
    }

    // 空答案补问（token 优化的关键一环）：
    // 一轮跑完仍有题目没拿到答案（模型返回了空串/null、位置错位被丢弃）时，
    // 只把这些题打包成**一次**小请求重问，而不是放弃。
    //
    // 为什么值得：旧实现里这些题会落进 page.js `_avoidKnownWrongAnswer` 的
    // 空答案兜底（直接猜第一个选项）。判断题猜错概率 50%，一旦猜错，
    // 整卷会带着 `禁:` 前缀重答一遍——一次整卷重答约几百 token、
    // 还多一轮"填→提交→判错"的页面往返；而这里补问通常只有一两百 token，
    // 把"猜"换成"问"，正确率和成本同时改善。
    //
    // 只在**部分成功**时补问：全部失败说明 API/解析出了问题，
    // requestAnswersWithRetry 已经重试过两次，再问也是白烧，走原失败分支。
    if (merged.length && filled.size < questions.length) {
      const unfilled = [];
      chunks.forEach((chunk) => {
        chunk.forEach((entry) => {
          if (!filled.has(entry.origin)) unfilled.push(entry);
        });
      });
      if (unfilled.length) {
        appendRuntimeLog('info', 'llm refill unanswered', {
          count: unfilled.length,
          total: questions.length
        });
        const refill = await requestAnswersWithRetry(config, unfilled.map((entry) => entry.question));
        if (refill && refill.success && Array.isArray(refill.data)) {
          mergeAnswers(unfilled, refill, 'refill');
        } else {
          appendRuntimeLog('warn', 'llm refill failed, leave for next tick', {
            count: unfilled.length,
            error: String((refill && refill.error) || '').slice(0, 160)
          });
        }
      }
    }

    if (merged.length) {
      if (lastFailure) {
        appendRuntimeLog('warn', 'llm partial chunk failure', {
          answered: merged.length,
          error: String(lastFailure.error || '').slice(0, 160)
        });
      }
      await updateApiConnectionState(false);
      return { success: true, data: merged };
    }
    return lastFailure || { success: false, error: 'LLM request failed' };
  }

  // 验证码提示词：随图片一起发送，图片本身才是 token 大头，所以这段只要够明确即可。
  // 去掉"仔细识别""这是网页校验用的图片"这类不改变行为的铺垫（每次验证码都重发一遍）。
  const CAPTCHA_PROMPT = '识别图中的验证码,按原顺序原样输出。可能含汉字/字母/数字,有扭曲与干扰线。只输出字符本身,不要解释、空格、标点。';

  async function handleCaptchaRequestDirect(payload) {
    const imageDataUrl = payload && payload.image ? String(payload.image) : '';
    if (!imageDataUrl || !/^data:image\//i.test(imageDataUrl)) {
      return { success: false, error: 'invalid captcha image' };
    }
    const config = await loadConfig();
    const missing = missingModuleError();
    if (missing) {
      appendRuntimeLog('error', 'llm_captcha aborted', { error: missing });
      return { success: false, error: missing };
    }
    if (!config.apiKey) return { success: false, error: 'Please configure API Key first' };

    const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/);
    if (!match) return { success: false, error: 'unsupported image format' };
    const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    const base64 = match[2];
    const model = String(config.captchaModel || '').trim() || config.model;

    appendRuntimeLog('info', 'captcha llm request', { model });
    let captchaUsage = null;
    try {
      let text = '';

      if (config.apiType === 'claude') {
        const url = buildClaudeApiUrl(config.apiUrl);
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': normalizeApiKey(config.apiKey),
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1024,
            temperature: 0,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                { type: 'text', text: CAPTCHA_PROMPT }
              ]
            }]
          })
        }, 90000);
        if (!response.success) {
          throw new Error(`Claude captcha request failed (${response.status || 'network'}): ${String(response.text || response.error || '').slice(0, 200)}`);
        }
        captchaUsage = (response.data || {}).usage || null;
        text = (((response.data || {}).content || [])[0] || {}).text || '';
      } else if (config.apiType === 'gemini') {
        const url = buildGeminiApiUrl(config.apiUrl, model, normalizeApiKey(config.apiKey));
        const response = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: CAPTCHA_PROMPT },
                { inline_data: { mime_type: mediaType, data: base64 } }
              ]
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 1024 }
          })
        }, 90000);
        if (!response.success) {
          throw new Error(`Gemini captcha request failed (${response.status || 'network'}): ${String(response.text || response.error || '').slice(0, 200)}`);
        }
        captchaUsage = (response.data || {}).usageMetadata || null;
        const parts = ((((response.data || {}).candidates || [])[0] || {}).content || {}).parts || [];
        text = parts.map((part) => part && part.text ? part.text : '').join('\n').trim();
      } else {
        const url = buildOpenAICompatibleUrl(config.apiUrl);
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${normalizeApiKey(config.apiKey)}`
          },
          body: JSON.stringify({
            model: model,
            temperature: 0,
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: CAPTCHA_PROMPT },
                { type: 'image_url', image_url: { url: imageDataUrl } }
              ]
            }]
          })
        }, 90000);
        if (!response.success) {
          throw new Error(`API captcha request failed (${response.status || 'network'}): ${String(response.text || response.error || '').slice(0, 200)}`);
        }
        captchaUsage = (response.data || {}).usage || null;
        text = ((((response.data || {}).choices || [])[0] || {}).message || {}).content || '';
      }

      // 视觉请求的用量必须记账。图占大头，不记的话用户在花钱却什么都看不到。
      if (captchaUsage) {
        logTokenUsage({
          prompt_tokens: captchaUsage.prompt_tokens !== undefined ? captchaUsage.prompt_tokens : captchaUsage.input_tokens,
          completion_tokens: captchaUsage.completion_tokens !== undefined ? captchaUsage.completion_tokens : captchaUsage.output_tokens
        }, 'captcha');
      }

      text = String(text || '').trim();
      if (!text) return { success: false, error: 'empty captcha result (check model vision support)' };
      appendRuntimeLog('info', 'captcha recognized', { length: text.length });
      return { success: true, data: text };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      appendRuntimeLog('error', 'captcha request failed', { error: message.slice(0, 300) });
      return { success: false, error: message };
    }
  }

  // 视觉理解提示词：题目带图时用。
  //
  // ⚠️ 故意**不**要求模型看懂整张图，而是要求它把图里影响作答的关键信息转成文字。
  // 理由：我们真正要的是「这道题选什么」，中间那步描述越短越省钱，
  // 也让主答题链的提示词保持纯文本 —— 前缀缓存不会被图片打散。
  const VISION_PROMPT = '这是一道题目的配图。用最简文字说明图中影响作答的关键信息（图形/数值/标签/关系），不要解释、不要复述题面。若图中没有对作答有用的信息，只输出：无。';

  /**
   * 视觉请求：把图里的信息转成文字，交回页面侧使用。
   *
   * 与 handleCaptchaRequestDirect 的分工：那个是「输出答案」，这个是「输出描述」。
   * 三条多模态协议分支（Claude / Gemini / OpenAI 兼容）复用同一套写法，
   * 避免出现第三份各自演化的实现。
   *
   * 成本是这里的第一约束：
   *   - 只接受调用方已筛过的图（张数/体积由页面侧的预算闸门控制）
   *   - 每次调用都记账（logTokenUsage），让用户能看见花了多少
   *   - 失败立刻返回，**不做任何重试** —— 重试等于再花一次钱
   */
  async function handleVisionRequestDirect(payload) {
    const images = payload && Array.isArray(payload.images) ? payload.images : [];
    if (!images.length) return { success: false, error: 'no images' };

    const config = await loadConfig();
    const missing = missingModuleError();
    if (missing) {
      appendRuntimeLog('error', 'llm_vision aborted', { error: missing });
      return { success: false, error: missing };
    }
    if (!config.apiKey) return { success: false, error: 'Please configure API Key first' };

    // 模型挑选顺序：visionModel（专为看图标）→ captchaModel（老用户可能已配好）→ model。
    // 最后一档回落有风险（文本模型多半看不懂图），但**不在这里静默降级** ——
    // 页面侧会在开启视觉时提示用户单独指定一个支持图片的模型。
    const model = String(config.visionModel || config.captchaModel || '').trim() || config.model;

    // 逐张解析；任何一张格式不合法就整体拒绝。
    // 不做「跳过坏图继续发」：那会变成发 N-1 张却按 N 张计费，账对不上。
    const parsed = [];
    for (let i = 0; i < images.length; i++) {
      const dataUrl = String(images[i] || '');
      const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/);
      if (!m) {
        appendRuntimeLog('warn', 'vision image rejected (bad format)', { index: i });
        return { success: false, error: 'unsupported image format at index ' + i };
      }
      parsed.push({ mediaType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2] });
    }

    appendRuntimeLog('info', 'vision llm request', { model: model, images: parsed.length });
    try {
      let text = '';
      let usage = null;

      if (config.apiType === 'claude') {
        const url = buildClaudeApiUrl(config.apiUrl);
        const content = [{ type: 'text', text: VISION_PROMPT }];
        parsed.forEach(function (p) { content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': normalizeApiKey(config.apiKey),
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1024,
            temperature: 0,
            messages: [{ role: 'user', content: content }]
          })
        }, 90000);
        if (!response.success) throw new Error('Claude vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usage || null;
        text = (((response.data || {}).content || [])[0] || {}).text || '';
      } else if (config.apiType === 'gemini') {
        const url = buildGeminiApiUrl(config.apiUrl, model, normalizeApiKey(config.apiKey));
        const parts = [{ text: VISION_PROMPT }];
        parsed.forEach(function (p) { parts.push({ inline_data: { mime_type: p.mediaType, data: p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: parts }],
            generationConfig: { temperature: 0, maxOutputTokens: 1024 }
          })
        }, 90000);
        if (!response.success) throw new Error('Gemini vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usageMetadata || null;
        const respParts = ((((response.data || {}).candidates || [])[0] || {}).content || {}).parts || [];
        text = respParts.map(function (part) { return part && part.text ? part.text : ''; }).join('\n').trim();
      } else {
        const url = buildOpenAICompatibleUrl(config.apiUrl);
        const content = [{ type: 'text', text: VISION_PROMPT }];
        parsed.forEach(function (p) { content.push({ type: 'image_url', image_url: { url: 'data:' + p.mediaType + ';base64,' + p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + normalizeApiKey(config.apiKey)
          },
          body: JSON.stringify({
            model: model,
            temperature: 0,
            max_tokens: 1024,
            messages: [{ role: 'user', content: content }]
          })
        }, 90000);
        if (!response.success) throw new Error('API vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usage || null;
        text = ((((response.data || {}).choices || [])[0] || {}).message || {}).content || '';
      }

      // 无论成败都记账 —— 失败的请求同样产生费用（图已经传上去了）。
      if (usage) {
        logTokenUsage({
          prompt_tokens: usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens,
          completion_tokens: usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens
        }, 'vision');
      }

      text = String(text || '').trim();
      if (!text) return { success: false, error: 'empty vision result (check model vision support)' };
      return { success: true, data: text };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      appendRuntimeLog('error', 'vision request failed', { error: message.slice(0, 300) });
      return { success: false, error: message };
    }
  }

  function ensureStatusPanel() {
    if (statusPanel && statusPanel.host && statusPanel.host.isConnected) return statusPanel;
    if (!document.body) return null;

    const oldHost = document.getElementById(STATUS_PANEL_ID);
    if (oldHost) oldHost.remove();

    const host = document.createElement('div');
    host.id = STATUS_PANEL_ID;
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'width:280px',
      'max-width:calc(100vw - 36px)',
      'pointer-events:none'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.card{box-sizing:border-box;width:100%;border:1px solid rgba(15,23,42,.12);border-radius:16px;background:rgba(255,255,255,.96);box-shadow:0 18px 50px rgba(15,23,42,.22);color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:13px 14px;pointer-events:auto;backdrop-filter:blur(14px)}',
      '.head{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
      '.brand{font-size:13px;font-weight:800;letter-spacing:.2px}',
      '.dot{width:8px;height:8px;border-radius:999px;background:#16a34a;box-shadow:0 0 0 4px rgba(22,163,74,.14)}',
      '.badge{margin-left:auto;border-radius:999px;padding:3px 8px;background:#dcfce7;color:#166534;font-size:11px;font-weight:800;white-space:nowrap}',
      '.close{margin-left:2px;border:0;background:transparent;color:#94a3b8;cursor:pointer;font-size:16px;line-height:16px;padding:2px}',
      '.task{font-size:14px;font-weight:800;line-height:1.45;color:#0f172a}',
      '.detail{margin-top:4px;font-size:12px;line-height:1.45;color:#64748b;word-break:break-word}',
      '.time{margin-top:8px;font-size:10px;color:#94a3b8}',
      '.card[data-state="wait"] .dot{background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}',
      '.card[data-state="wait"] .badge{background:#dbeafe;color:#1d4ed8}',
      '.card[data-state="warn"] .dot{background:#d97706;box-shadow:0 0 0 4px rgba(217,119,6,.14)}',
      '.card[data-state="warn"] .badge{background:#fef3c7;color:#92400e}',
      '.card[data-state="error"] .dot{background:#dc2626;box-shadow:0 0 0 4px rgba(220,38,38,.14)}',
      '.card[data-state="error"] .badge{background:#fee2e2;color:#991b1b}',
      '@media (max-width:520px){.card{border-radius:14px}.task{font-size:13px}}',
      '</style>',
      '<div class="card" data-state="normal">',
      '  <div class="head">',
      '    <span class="dot"></span>',
      '    <span class="brand">Omitone 1.2.4</span>',
      '    <span class="badge" data-role="state">正常运行</span>',
      '    <button class="close" type="button" title="隐藏状态窗">×</button>',
      '  </div>',
      '  <div class="task" data-role="task">等待启动</div>',
      '  <div class="detail" data-role="detail">准备接收运行状态</div>',
      '  <div class="time" data-role="time">--:--:--</div>',
      '</div>'
    ].join('');

    document.body.appendChild(host);

    statusPanel = {
      host,
      card: shadow.querySelector('.card'),
      state: shadow.querySelector('[data-role="state"]'),
      task: shadow.querySelector('[data-role="task"]'),
      detail: shadow.querySelector('[data-role="detail"]'),
      time: shadow.querySelector('[data-role="time"]'),
      close: shadow.querySelector('.close')
    };

    statusPanel.close.addEventListener('click', () => {
      statusPanelActive = false;
      statusLastSignature = '';
      host.remove();
      statusPanel = null;
    });

    return statusPanel;
  }

  function formatStatusTime() {
    try {
      return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return new Date().toTimeString().slice(0, 8);
    }
  }

  function setStatusPanel(state, task, detail) {
    if (!statusPanelActive) return;
    const panel = ensureStatusPanel();
    if (!panel) return;

    const stateKey = state || 'normal';
    const labels = {
      normal: '正常运行',
      wait: '等待中',
      warn: '注意',
      error: '异常运行'
    };
    const taskText = String(task || '运行中').slice(0, 80);
    const detailText = String(detail || '').slice(0, 220);
    const signature = [stateKey, taskText, detailText].join('|');
    if (signature === statusLastSignature) return;
    statusLastSignature = signature;

    panel.card.setAttribute('data-state', stateKey);
    panel.state.textContent = labels[stateKey] || labels.normal;
    panel.task.textContent = taskText;
    panel.detail.textContent = detailText || '状态更新中';
    panel.time.textContent = '更新于 ' + formatStatusTime();
  }

  function showStatusPanel(state, task, detail) {
    statusPanelActive = true;
    setStatusPanel(state || 'normal', task || '运行中', detail || '');
  }

  function jobKindLabel(kind) {
    const labels = {
      video: '视频播放',
      quiz: '测验答题',
      read: '阅读任务',
      document: '文档/PPT',
      timereader: '定时阅读',
      'ppt-audio': 'PPT 音频',
      hyperlink: '链接任务',
      other: '其他任务'
    };
    return labels[kind] || kind || '任务';
  }

  function runtimeLogToStatus(level, message, meta) {
    const msg = String(message || '');
    const data = meta || {};
    let state = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'normal');
    let task = '运行中';
    let detail = '状态更新中';

    if (msg === 'start') {
      task = '已启动';
      detail = '正在检测当前章节任务';
    } else if (/chapter changed|learning card changed/.test(msg)) {
      state = 'wait';
      task = '章节/任务卡片切换中';
      detail = '正在重新识别任务点';
    } else if (/study begin/.test(msg)) {
      state = 'wait';
      task = '扫描任务点';
      detail = '附件数：' + (data.attachments == null ? '-' : data.attachments);
    } else if (/study matched job/.test(msg)) {
      task = '执行任务：' + jobKindLabel(data.kind);
      detail = '任务处理中';
    } else if (/media pending|waiting for element/.test(msg)) {
      state = 'wait';
      task = '视频播放中';
      detail = '等待视频播放完成';
    } else if (/managed media job ended/.test(msg)) {
      task = '视频任务完成';
      detail = '准备继续后续任务';
    } else if (/chaoxing read runner|document page|timereader/.test(msg)) {
      state = 'wait';
      task = '文档/PPT 处理中';
      detail = data.totalPages ? ('第 ' + data.currentPage + '/' + data.totalPages + ' 页') : '正在处理阅读任务';
    } else if (/document done|read finishJob/.test(msg)) {
      task = '文档/PPT 已完成';
      detail = '准备继续后续任务';
    } else if (/quiz submit pending/.test(msg)) {
      state = 'wait';
      task = '等待测验提交';
      detail = '等待提交结果';
    } else if (/quiz submit finished|quiz already finished|study quiz fallback completed/.test(msg)) {
      task = '测验任务完成';
      detail = '准备继续后续任务';
    } else if (/captcha detected, recognizing|captcha llm request/.test(msg)) {
      state = 'warn';
      task = '检测到验证码';
      detail = '正在通过 AI 识别图片字符';
    } else if (/captcha code filled/.test(msg)) {
      state = 'wait';
      task = '验证码识别完成';
      detail = '已填入并提交，等待校验结果';
    } else if (/captcha solved/.test(msg)) {
      task = '验证码已通过';
      detail = '继续学习流程';
    } else if (/captcha recognize failed|captcha image capture failed|captcha request failed|captcha code empty/.test(msg)) {
      state = 'error';
      task = '验证码识别失败';
      detail = (data.error || data.raw || '请检查模型是否支持图片输入');
    } else if (/captcha seems wrong, will retry/.test(msg)) {
      state = 'warn';
      task = '验证码校验未过';
      detail = '第 ' + (data.attempt || 1) + ' 次，将换图重试';
    } else if (/captcha unsolved, reload page|captcha wrong too many times/.test(msg)) {
      state = 'warn';
      task = '验证码多次未通过';
      detail = '正在刷新页面并自动继续';
    } else if (/api connection failed|api unavailable|skip quiz because api unavailable|skip popup quiz because api unavailable/.test(msg)) {
      state = 'warn';
      task = 'API 不可用，跳过答题';
      detail = (data.error || data.reason || '未填写 API 或连接失败');
    } else if (/llm request error|llm_request direct failed/.test(msg)) {
      state = 'warn';
      task = 'AI 请求出错';
      detail = (data.error || '请求失败，正在重试');
    } else if (/llm response parse failed/.test(msg)) {
      state = 'warn';
      task = 'AI 返回解析失败';
      detail = (data.error || '正在重试');
    } else if (/llm request chunk/.test(msg)) {
      state = 'wait';
      task = 'AI 分批答题中';
      detail = '第 ' + (data.chunk || '-') + '/' + (data.total || '-') + ' 批（' + (data.questions || 0) + ' 题）';
    } else if (/llm partial chunk failure/.test(msg)) {
      state = 'warn';
      task = '部分题目请求失败';
      detail = '已答 ' + (data.answered || 0) + ' 题：' + (data.error || '');
    } else if (/quiz llm parse failed|popup quiz llm parse failed/.test(msg)) {
      state = 'warn';
      task = '答案解析失败，稍后重试';
      detail = (data.error || '');
    } else if (/study no runnable job|no runnable job|waiting task|search job:/.test(msg)) {
      state = state === 'warn' ? 'warn' : 'wait';
      task = '等待任务识别';
      detail = '正在等待可执行任务';
    } else if (/study finished on page/.test(msg)) {
      task = '页面任务完成';
      detail = '准备进入下一节';
    } else if (/study next unit|switch learning card/.test(msg)) {
      task = '切换下一节/任务卡片';
      detail = '正在切换';
    } else if (/skip completed/.test(msg)) {
      task = '当前章节已完成';
      detail = '已跳过重复学习';
    } else if (level === 'error') {
      task = '异常运行';
      detail = data.message || '请在查看日志中确认详情';
    }

    return { state, task, detail };
  }

  function handleRuntimeStatus(level, message, meta) {
    if (String(message || '') === 'start') statusPanelActive = true;
    if (!statusPanelActive) return;
    const next = runtimeLogToStatus(level || 'info', message || '', meta || null);
    setStatusPanel(next.state, next.task, next.detail);
  }

  function getDecryptTable() {
    if (!decryptTablePromise) decryptTablePromise = loadDecryptTable();
    return decryptTablePromise;
  }

  /**
   * 加载字形映射表。
   *
   * 优先紧凑二进制 `resources/table.bin`（122KB，不需要解析 JSON，内存占用也小一个量级）；
   * 退化到明文 `resources/table.json`（347KB）—— 源码目录在没跑过 `npm run build` 时
   * 没有 .bin，这条退路保证"直接加载仓库根目录"仍然能用，只是慢一些、占得多一些。
   */
  async function loadDecryptTable() {
    if (!FONT_TABLE) {
      console.error('[Omitone] libs/font-table.js 未加载');
      return null;
    }
    try {
      const resp = await fetch(chrome.runtime.getURL('resources/table.bin'));
      if (resp.ok) {
        const table = FONT_TABLE.decode(await resp.arrayBuffer());
        if (table) return table;
        console.warn('[Omitone] table.bin 格式非法，回退到 table.json');
      }
    } catch (e) {}

    try {
      const resp = await fetch(chrome.runtime.getURL('resources/table.json'));
      if (!resp.ok) return null;
      const table = FONT_TABLE.fromObject(await resp.json());
      if (!table) return null;
      console.warn('[Omitone] 正在使用明文 table.json（347KB）—— 跑一次 npm run build 可生成 122KB 的 table.bin');
      return table;
    } catch (e2) {
      console.error('[Omitone] failed to load decrypt table', e2);
      return null;
    }
  }

  function decodeBase64ToUint8Array(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function extractSecretFontBase64(doc) {
    try {
      const styles = Array.from(doc.querySelectorAll('style'));
      for (const style of styles) {
        const text = String(style.textContent || '');
        if (text.indexOf('font-cxsecret') === -1) continue;
        const match = text.match(/base64,([A-Za-z0-9+/=]+)['")]/);
        if (match) return match[1];
      }
    } catch (e) {}
    return '';
  }

  function buildTyprFont(bytes) {
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const fonts = Typr.parse(buffer);
      return fonts && fonts[0] ? fonts[0] : null;
    } catch (e) {
      console.error('[Omitone] failed to parse secret font', e);
      return null;
    }
  }

  function collectUniqueSecretChars(elements) {
    const chars = new Set();
    const collect = (value) => {
      const text = String(value || '');
      for (const char of text) {
        if (!char.trim()) continue;
        if (char.codePointAt(0) <= 127) continue;
        chars.add(char);
      }
    };

    elements.forEach((el) => {
      collect(el.textContent || '');
      ['aria-label', 'title', 'value', 'placeholder'].forEach((attr) => {
        if (el.hasAttribute && el.hasAttribute(attr)) collect(el.getAttribute(attr));
      });
    });

    return Array.from(chars);
  }

  function buildDecryptMapForDoc(doc, base64, table, elements) {
    if (decryptMapCache.has(base64)) return decryptMapCache.get(base64);
    const font = buildTyprFont(decodeBase64ToUint8Array(base64));
    const map = new Map();
    if (!font || !table || typeof md5 !== 'function') {
      decryptMapCache.set(base64, map);
      return map;
    }

    const chars = collectUniqueSecretChars(elements);
    chars.forEach((char) => {
      try {
        const glyph = Typr.U.codeToGlyph(font, char.codePointAt(0));
        if (!glyph) return;
        const path = Typr.U.glyphToPath(font, glyph);
        const hash = md5(JSON.stringify(path)).slice(24);
        const decoded = table.get(hash);
        if (decoded) map.set(char, decoded);
      } catch (e) {}
    });

    decryptMapCache.set(base64, map);
    return map;
  }

  function decodeStringByMap(value, map) {
    let output = String(value || '');
    map.forEach((decoded, encoded) => {
      output = output.split(encoded).join(decoded);
    });
    return output;
  }

  function getOutermostSecretRoots(doc) {
    const all = Array.from(doc.querySelectorAll('.font-cxsecret'));
    return all.filter((node) => !node.parentElement || !node.parentElement.closest('.font-cxsecret'));
  }

  function decryptRootElement(root, map) {
    const doc = root.ownerDocument;
    const elementList = [root, ...Array.from(root.querySelectorAll('*'))];
    elementList.forEach((el) => {
      ['aria-label', 'title', 'value', 'placeholder'].forEach((attr) => {
        if (el.hasAttribute && el.hasAttribute(attr)) {
          el.setAttribute(attr, decodeStringByMap(el.getAttribute(attr), map));
        }
      });
      if (el.classList) el.classList.remove('font-cxsecret');
    });

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    textNodes.forEach((textNode) => {
      textNode.nodeValue = decodeStringByMap(textNode.nodeValue, map);
    });
  }

  async function decryptSecretFontsInDocument(doc) {
    if (!doc || !doc.querySelectorAll) return;
    const roots = getOutermostSecretRoots(doc);
    if (!roots.length) return;

    const base64 = extractSecretFontBase64(doc);
    if (!base64) return;

    const table = await getDecryptTable();
    const decodeMap = buildDecryptMapForDoc(doc, base64, table, roots);
    if (!decodeMap.size) return;

    roots.forEach((root) => decryptRootElement(root, decodeMap));
    console.log('[Omitone] font decrypted roots:', roots.length, 'mapped chars:', decodeMap.size);
  }

  function walkSameOriginDocuments(doc, visitor, depth = 0) {
    if (!doc || depth > 4) return;
    visitor(doc);
    let frames = [];
    try {
      frames = doc.querySelectorAll('iframe');
    } catch (e) {}
    frames.forEach((frame) => {
      try {
        const subDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        walkSameOriginDocuments(subDoc, visitor, depth + 1);
      } catch (e2) {}
    });
  }

  async function runFontDecryptSweep() {
    const jobs = [];
    walkSameOriginDocuments(document, (doc) => {
      if (!observedDocs.has(doc)) {
        observedDocs.add(doc);
        try {
          const observer = new MutationObserver(() => scheduleDecryptSweep());
          observer.observe(doc.documentElement || doc.body || doc, { childList: true, subtree: true, characterData: true });
        } catch (e) {}
      }
      jobs.push(decryptSecretFontsInDocument(doc));
    });
    await Promise.all(jobs);
  }

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('config', (result) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            appendRuntimeLog('warn', 'load config fallback to defaults', { error: lastError.message || String(lastError) });
            resolve(configs);
            return;
          }
          const nextConfig = { ...((result && result.config) || {}) };
          delete nextConfig.forceLearn;
          configs = { ...configs, ...nextConfig };
          resolve(configs);
        });
      } catch (e) {
        appendRuntimeLog('warn', 'load config failed, use defaults', { error: e && e.message ? e.message : String(e) });
        resolve(configs);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.config) return;
    const nextConfig = { ...(changes.config.newValue || {}) };
    delete nextConfig.forceLearn;
    configs = { ...configs, ...nextConfig };
    // 必须带 source: 'xxt_bridge'，否则 page.js 的消息过滤器会丢弃这条更新，
    // 运行中的页面永远收不到新配置（表现为“开关改了不生效、AI 答题关不掉”）
    window.postMessage({ source: 'xxt_bridge', type: 'XXT_CONFIG_UPDATED', data: configs }, '*');
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'xxt_app') return;

    if (msg.type === 'get_config') {
      window.postMessage({
        source: 'xxt_bridge',
        id: msg.id,
        type: 'config_response',
        data: configs
      }, '*');
      return;
    }

    if (msg.type === 'llm_request') {
      // 必须带 .catch 回传失败：page.js 的 bridgeSend 已有超时兜底，但正常路径下
      // 任何未捕获异常都会导致不回消息、主循环挂起 90 秒
      handleLLMRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_request internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'llm_vision') {
      handleVisionRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_vision internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'llm_captcha') {
      handleCaptchaRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_captcha internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'fetch_image') {
      // 跨域验证码图片：交由后台带 Cookie 抓取，避免画布污染
      try {
        chrome.runtime.sendMessage(
          { type: 'fetch_image_dataurl', payload: msg.payload || {} },
          (response) => {
            const lastError = chrome.runtime.lastError;
            window.postMessage({
              source: 'xxt_bridge',
              id: msg.id,
              type: 'llm_response',
              data: lastError
                ? { success: false, error: lastError.message || String(lastError) }
                : (response || { success: false, error: 'background no response' })
            }, '*');
          }
        );
      } catch (err) {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: err && err.message ? err.message : String(err) }
        }, '*');
      }
      return;
    }

    if (msg.type === 'storage_set') {
      chrome.storage.local.set(msg.payload);
      return;
    }

    if (msg.type === 'runtime_log') {
      pageRuntimeActivityAt = Date.now();
      appendRuntimeLog(msg.level || 'info', msg.message || '', msg.meta || null);
      handleRuntimeStatus(msg.level || 'info', msg.message || '', msg.meta || null);
    }
  });

  function getPageScriptUrl() {
    return chrome.runtime.getURL('page.js');
  }

  function removeInjectedScript() {
    const oldScript = document.getElementById(PAGE_SCRIPT_ID);
    if (oldScript) oldScript.remove();
  }

  function hasPageRuntimeEvidence() {
    if (document.getElementById('xxt-panel')) return true;
    return pageRuntimeActivityAt > 0 && Date.now() - pageRuntimeActivityAt < 4000;
  }

  function scheduleInjectionWatchdog(seq, reason) {
    setTimeout(() => {
      if (seq !== pageInjectSeq) return;
      if (hasPageRuntimeEvidence()) return;

      appendRuntimeLog('error', 'page script no response after tag injection', { reason: reason || '' });
      if (statusPanelActive) {
        setStatusPanel('error', '运行脚本未响应', '未检测到初始弹窗或启动日志，请刷新学习通页面后重试');
      }
    }, 1800);
  }

  function injectPageScript(reason = 'default') {
    removeInjectedScript();
    pageRuntimeActivityAt = 0;
    const seq = ++pageInjectSeq;

    const scriptUrl = getPageScriptUrl();
    const script = document.createElement('script');
    script.id = PAGE_SCRIPT_ID;
    script.src = scriptUrl;
    script.onload = () => {
      console.log('%c[Omitone] page runtime injected', 'color:#4CAF50');
    };
    script.onerror = () => {
      console.error('%c[Omitone] failed to inject page runtime', 'color:#F44336');
      appendRuntimeLog('warn', 'page script tag injection failed', { reason });
    };

    (document.head || document.documentElement).appendChild(script);
    scheduleInjectionWatchdog(seq, reason);
  }

  function scheduleDecryptSweep() {
    if (decryptSweepTimer) clearTimeout(decryptSweepTimer);
    decryptSweepTimer = setTimeout(() => {
      runFontDecryptSweep().catch((err) => {
        console.error('[Omitone] decrypt sweep failed', err);
      });
    }, 300);
  }

  async function maybeMarkAutoResume() {
    // 运行标记：验证码刷新/页面跳转后自动恢复运行
    try {
      await new Promise((resolve) => {
        chrome.storage.local.get('xxtRunning', (result) => {
          const lastError = chrome.runtime.lastError;
          if (!lastError && result && result.xxtRunning) {
            document.documentElement.setAttribute(AUTO_START_ATTR, '1');
            appendRuntimeLog('info', 'auto resume after reload', {});
          }
          resolve();
        });
      });
    } catch (e) {}
  }

  async function start() {
    await loadConfig();
    await maybeMarkAutoResume();

    if (!IS_CHAOXING_PAGE) {
      // 非学习通页面：只有"正在刷课 + 疑似验证码页"才注入运行脚本，避免在无关网站上空跑
      const running = await readRunningFlag();
      if (!running || !isCaptchaLikePage()) return;
      appendRuntimeLog('warn', 'standalone captcha page detected, auto solving', { url: (location.href || '').slice(0, 120) });
      injectPageScript('standalone-captcha');
      return;
    }

    scheduleDecryptSweep();
    injectPageScript('startup');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'xxt_start') {
      document.documentElement.setAttribute(AUTO_START_ATTR, '1');
      try { chrome.storage.local.set({ xxtRunning: true }); } catch (e0) {}
      const oldPanel = document.getElementById('xxt-panel');
      if (oldPanel) oldPanel.remove();
      showStatusPanel('wait', '启动中', '正在注入运行脚本');
      loadConfig().then(() => {
        scheduleDecryptSweep();
        injectPageScript('manual-start');
      });
      sendResponse({ success: true });
      return true;
    }
    return true;
  });

  let lastPageUrl = location.href;

  function onPageChanged() {
    if (location.href === lastPageUrl) return;
    lastPageUrl = location.href;
    const oldPanel = document.getElementById('xxt-panel');
    if (oldPanel) oldPanel.remove();
    if (statusPanelActive) setStatusPanel('wait', '页面切换中', '正在重新注入运行脚本');
    removeInjectedScript();
    loadConfig().then(() => {
      scheduleDecryptSweep();
      injectPageScript('page-change');
    });
  }

  const rawPushState = history.pushState;
  history.pushState = function () {
    rawPushState.apply(this, arguments);
    setTimeout(onPageChanged, 500);
  };

  const rawReplaceState = history.replaceState;
  history.replaceState = function () {
    rawReplaceState.apply(this, arguments);
    setTimeout(onPageChanged, 500);
  };

  window.addEventListener('popstate', () => setTimeout(onPageChanged, 500));
  window.addEventListener('hashchange', () => setTimeout(onPageChanged, 500));
  document.addEventListener('readystatechange', scheduleDecryptSweep);
  window.addEventListener('load', scheduleDecryptSweep);

  console.log('%c[Omitone] content bridge ready', 'color:#2196F3');
  appendRuntimeLog('info', 'content bridge ready');
})();
