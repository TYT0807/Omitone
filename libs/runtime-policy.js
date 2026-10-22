/** Shared isolated-world / service-worker policy. Never expose fingerprints to pages. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitonePolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var own = Object.prototype.hasOwnProperty;
  var booleans = ['autoMaxPlaybackRate', 'muted', 'enableDiscussion', 'autoNext', 'enableQuiz',
    'randomAnswer', 'enableCaptcha', 'blockedReload', 'enableMedia', 'enableSeek',
    'advanceAtNinetyPercent', 'enablePPT', 'enableHyperlink', 'restudy', 'apiConnectionFailed', 'visionEnabled'];
  var numbers = {
    playbackRate: [0.25, 16], playbackRateCap: [1, 16], discussionTimeoutMs: [1000, 600000],
    visionMaxImagesPerQuestion: [1, 10], visionMaxImageBytes: [1024, 2097152],
    visionBudgetPerChapter: [0, 1000], visionImagesPerRequest: [1, 10],
    retryInterval: [100, 600000], maxRetries: [0, 100], videoCheckInterval: [100, 60000],
    stepSwitchGraceMs: [100, 600000], stepSwitchInitDelayMs: [100, 600000],
    taskDiscoverGraceMs: [100, 600000], taskPendingGraceMs: [100, 600000],
    quizSubmitWaitMs: [100, 600000], quizMaxSubmitAttempts: [1, 100],
    quizQuestionMaxMisses: [1, 100], popupQuizMaxAttempts: [1, 100],
    documentSkipTimeoutMs: [1000, 3600000], taskGiveUpAttempts: [1, 100],
    pptFlipIntervalMs: [100, 600000], guardNoProgressMs: [100, 600000],
    guardResumeCooldownMs: [100, 600000], guardMaxResumeWindow: [100, 600000], guardMaxResumes: [1, 100]
  };
  var strings = { discussionReply: 10000, systemPrompt: 50000, apiConnectionError: 300,
    providerPreset: 100, apiUrl: 4096, apiKey: 8192, model: 256, captchaModel: 256, visionModel: 256 };
  var runtimeFields = booleans.concat(Object.keys(numbers), ['discussionReply']);
  function httpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      var url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : null;
    } catch (e) { return null; }
  }
  function isChaoxingUrl(value) {
    var url = httpUrl(value);
    return !!url && (url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'));
  }
  function validField(key, value) {
    if (booleans.indexOf(key) !== -1) return typeof value === 'boolean';
    if (own.call(numbers, key)) {
      return typeof value === 'number' && Number.isFinite(value) && value >= numbers[key][0] && value <= numbers[key][1]
        && (key === 'playbackRate' || key === 'playbackRateCap' || Number.isInteger(value));
    }
    if (own.call(strings, key)) {
      return typeof value === 'string' && value.length <= strings[key]
        && (key !== 'apiUrl' || value === '' || !!httpUrl(value))
        && (key !== 'apiKey' || !/[\r\n\0]/.test(value));
    }
    if (key === 'apiType') return ['openai', 'claude', 'gemini'].indexOf(value) !== -1;
    if (key === 'thinkingLevel') return ['off', 'low', 'high'].indexOf(value) !== -1;
    return false;
  }
  function publicConfig(config, scope) {
    config = config || {};
    var result = {};
    var fields = scope === 'captcha' ? ['enableCaptcha'] : scope === 'none' ? [] : runtimeFields;
    fields.forEach(function (key) {
      if (own.call(config, key) && validField(key, config[key])) result[key] = config[key];
    });
    if (scope !== 'none') result.hasApiKey = typeof config.apiKey === 'string'
      ? !!config.apiKey.trim() : config.hasApiKey === true;
    return result;
  }
  function configFingerprint(config) {
    // Only API identity participates. Runtime status/toggle writes must not stale API tests.
    config = config || {};
    var result = {};
    ['apiType', 'apiUrl', 'apiKey', 'model', 'captchaModel', 'visionModel', 'thinkingLevel', 'systemPrompt']
      .sort().forEach(function (key) {
        result[key] = typeof config[key] === 'string' ? config[key] : '';
      });
    return JSON.stringify(result);
  }
  function validatePatch(patch, scope) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { success: false, code: 'invalid_patch' };
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (scope !== 'popup' && key !== 'apiConnectionFailed' && key !== 'apiConnectionError') {
        return { success: false, code: 'forbidden_patch' };
      }
      if (!validField(key, patch[key])) return { success: false, code: 'invalid_patch', field: key };
    }
    return { success: true };
  }
  return { isChaoxingUrl: isChaoxingUrl, httpUrl: httpUrl, publicConfig: publicConfig,
    configFingerprint: configFingerprint, validatePatch: validatePatch, runtimeFields: runtimeFields.slice() };
});
