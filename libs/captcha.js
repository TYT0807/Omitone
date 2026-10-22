/** OCR request construction shared by extension contexts; prompts live only in prompt.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./api-url'), require('./prompt'));
  } else root.OmitoneCaptcha = factory(root.OmitoneApiUrl, root.OmitonePrompt);
})(typeof self !== 'undefined' ? self : this, function (urls, prompts) {
  'use strict';
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
      body = { model: model, max_tokens: 1024, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: match[2] } },
        { type: 'text', text: text }
      ] }] };
    } else if (config.apiType === 'gemini') {
      url = urls.buildGeminiApiUrl(config.apiUrl, model, urls.normalizeApiKey(config.apiKey));
      body = { contents: [{ role: 'user', parts: [
        { text: text }, { inline_data: { mime_type: mime, data: match[2] } }
      ] }], generationConfig: { temperature: 0, maxOutputTokens: 1024 } };
    } else if (config.apiType === 'openai' || !config.apiType) {
      url = urls.buildOpenAICompatibleUrl(config.apiUrl);
      headers.Authorization = 'Bearer ' + urls.normalizeApiKey(config.apiKey);
      body = { model: model, temperature: 0, max_tokens: 1024, messages: [{ role: 'user', content: [
        { type: 'text', text: text }, { type: 'image_url', image_url: { url: image } }
      ] }] };
    } else throw new Error('unsupported api type');
    return { url: url, method: 'POST', headers: headers, body: JSON.stringify(body), timeoutMs: 90000 };
  }
  function parseResponse(config, data) {
    data = data || {};
    var text = '', usage = data.usage || data.usageMetadata || null;
    if (config.apiType === 'claude') {
      text = (data.content || []).filter(function (part) { return part && part.type === 'text'; })
        .map(function (part) { return part.text || ''; }).join('\n');
    } else if (config.apiType === 'gemini') {
      var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      text = parts.filter(function (part) { return !part.thought; }).map(function (part) { return part.text || ''; }).join('\n');
    } else text = (((data.choices || [])[0] || {}).message || {}).content || '';
    text = typeof text === 'string' ? text.trim() : '';
    if (!text) return { success: false, error: 'empty captcha result (check model vision support)' };
    var result = { success: true, data: text };
    if (usage) result.usage = { prompt_tokens: Number(usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens || usage.promptTokenCount || 0),
      completion_tokens: Number(usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens || usage.candidatesTokenCount || 0) };
    return result;
  }
  return { buildRequest: buildRequest, parseResponse: parseResponse };
});
