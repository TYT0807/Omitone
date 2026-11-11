/** OCR request construction shared by extension contexts; prompts live only in prompt.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./api-url'), require('./prompt'), require('./thinking'));
  } else root.OmitoneCaptcha = factory(root.OmitoneApiUrl, root.OmitonePrompt, root.OmitoneThinking);
})(typeof self !== 'undefined' ? self : this, function (urls, prompts, thinking) {
  'use strict';
  // 验证码只输出几个字符，但思考型模型会先烧掉成百上千个推理 token
  // （实测 deepseek-flash 每次 out=93~937）。预算写死 1024 时正文直接被截成空串，
  // 于是「识别失败 → 换图重试」无限循环。留出余量只对截断有意义，不额外花钱。
  var MAX_TOKENS = 2048;

  function buildRequest(config, image) {
    var match = typeof image === 'string' && image.length <= 2796240
      && image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length % 4 !== 0 || (match[2].length / 4 * 3 - (match[2].match(/=+$/) || [''])[0].length) > 2097152) {
      throw new Error('invalid captcha image');
    }
    if (!config || !urls.normalizeApiKey(config.apiKey)) throw new Error('Please configure API Key first');
    var model = String(config.captchaModel || config.model || '').trim();
    if (!model || !prompts.CAPTCHA_PROMPT) throw new Error('captcha model or prompt unavailable');
    var mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    var text = prompts.CAPTCHA_PROMPT;
    var headers = { 'Content-Type': 'application/json' };
    var url, body;
    if (config.apiType === 'claude') {
      url = urls.buildClaudeApiUrl(config.apiUrl);
      headers['x-api-key'] = urls.normalizeApiKey(config.apiKey);
      headers['anthropic-version'] = '2023-06-01';
      body = { model: model, max_tokens: MAX_TOKENS, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: match[2] } },
        { type: 'text', text: text }
      ] }] };
    } else if (config.apiType === 'gemini') {
      url = urls.buildGeminiApiUrl(config.apiUrl, model, urls.normalizeApiKey(config.apiKey));
      body = { contents: [{ role: 'user', parts: [
        { text: text }, { inline_data: { mime_type: mime, data: match[2] } }
      ] }], generationConfig: { temperature: 0, maxOutputTokens: MAX_TOKENS } };
    } else if (config.apiType === 'openai' || !config.apiType) {
      // 地址留空时 buildOpenAICompatibleUrl 会兜底到 DEFAULT_OPENAI_BASE（minimax）。
      // 验证码读的是 background 的**原始 storage 配置**（不合并 content.js 那套默认值），
      // 所以「填了 key、地址从没落过盘」是真实状态 —— 兜底等于把用户的密钥
      // 发去一个他压根没选过的厂商（实测 401，而旧日志不报目标主机，查不出原因）。
      // claude / gemini 两档不拦：那两种类型下厂商是用户显式选定的，兜底地址没有歧义。
      if (!String(config.apiUrl || '').trim()) {
        throw new Error('API 地址没填 —— 为了不把密钥发给没选过的厂商，这次验证码识别没有发出请求（在设置里选服务商或填一次地址即可）');
      }
      url = urls.buildOpenAICompatibleUrl(config.apiUrl);
      headers.Authorization = 'Bearer ' + urls.normalizeApiKey(config.apiKey);
      body = { model: model, temperature: 0, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: [
        { type: 'text', text: text }, { type: 'image_url', image_url: { url: image } }
      ] }] };
      // 思考参数只有一个真源（libs/thinking.js）。这条链路以前**一个都不带**，
      // 于是「把思考强度关成 off」这个用户开关对验证码无效 —— 默认开思考的模型
      // 每次先推理一轮，正文被预算截空（就是上面那串 out=93~937 的实测）。
      Object.assign(body, thinking.buildThinkingParams({
        apiUrl: config.apiUrl, model: model, thinkingLevel: config.thinkingLevel
      }).params);
    } else throw new Error('unsupported api type');
    return { url: url, method: 'POST', headers: headers, body: JSON.stringify(body), timeoutMs: 90000 };
  }
  function parseResponse(config, data) {
    data = data || {};
    var text = '', usage = data.usage || data.usageMetadata || null, reason = '';
    if (config.apiType === 'claude') {
      reason = String(data.stop_reason || '');
      text = (data.content || []).filter(function (part) { return part && part.type === 'text'; })
        .map(function (part) { return part.text || ''; }).join('\n');
    } else if (config.apiType === 'gemini') {
      var candidate = ((data.candidates || [])[0] || {});
      reason = String(candidate.finishReason || '');
      var parts = (candidate.content || {}).parts || [];
      text = parts.filter(function (part) { return !part.thought; }).map(function (part) { return part.text || ''; }).join('\n');
    } else {
      var choice = ((data.choices || [])[0] || {});
      reason = String(choice.finish_reason || '');
      text = (choice.message || {}).content || '';
    }
    text = typeof text === 'string' ? text.trim() : '';
    if (!text) {
      // 「空」有两种，之前只报一种，而实测里占多数的是被截断那一种：
      // finish_reason=length = 思考 token 把预算吃光了（调思考强度 / 抬预算能解），
      // 没有结束原因或非 length = 更可能是模型压根不带视觉。
      return { success: false, error: '验证码识别返回空回复（结束原因 ' + (reason || '无') + '）' +
        (reason === 'length' ? ' —— 思考把输出的预算占满了，把「思考强度」调到关闭即可' : ' —— 请确认该模型支持看图') };
    }
    var result = { success: true, data: text };
    if (usage) result.usage = { prompt_tokens: Number(usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens || usage.promptTokenCount || 0),
      completion_tokens: Number(usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens || usage.candidatesTokenCount || 0) };
    return result;
  }
  return { buildRequest: buildRequest, parseResponse: parseResponse };
});
