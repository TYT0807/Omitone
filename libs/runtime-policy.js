/** Shared isolated-world / service-worker policy. Never expose fingerprints to pages. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitonePolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var own = Object.prototype.hasOwnProperty;
  var booleans = ['autoMaxPlaybackRate', 'muted', 'enableDiscussion', 'autoNext', 'autoNextCourse', 'enableQuiz',
    'enableVote',
    'randomAnswer', 'enableCaptcha', 'blockedReload', 'enableMedia', 'enableSeek',
    'advanceAtNinetyPercent', 'enablePPT', 'enableHyperlink', 'restudy', 'apiConnectionFailed', 'visionEnabled',
    'quizZeroFillSkip'];
  var numbers = {
    // ⚠️ `playbackRate`（弹窗那根「播放速度」滑条）在批次 146 整条删掉了 —— 站点按不住倍速的视频
    // 被我们硬按上去会抽搐加黑屏。现在倍速只有一个来源：量到的播放器上限（`playbackRateCap` 只做封顶）。
    // 删配置键必须**连写入方一起删**：`validatePatch` 认不出任何一个键就顶回**整张补丁**，
    // 症状是「所有开关都存不住」（批次 34 那一族），不是「这一根滑条坏了」。
    playbackRateCap: [1, 16], discussionTimeoutMs: [1000, 600000],
    visionMaxImagesPerQuestion: [1, 10], visionMaxImageBytes: [1024, 2097152],
    visionBudgetPerChapter: [0, 1000], visionImagesPerRequest: [1, 10],
    retryInterval: [100, 600000], maxRetries: [0, 100], videoCheckInterval: [100, 60000],
    stepSwitchGraceMs: [100, 600000], stepSwitchInitDelayMs: [100, 600000],
    taskDiscoverGraceMs: [100, 600000], taskPendingGraceMs: [100, 600000],
    quizSubmitWaitMs: [100, 600000], quizMaxSubmitAttempts: [1, 100],
    // 乱选填满整卷后、点提交**之前**留给用户检查的秒数；0 = 不自动交卷（见 75-quiz-dom.js 的交卷闸）。
    randomAnswerReviewSec: [0, 600],
    quizQuestionMaxMisses: [1, 100], popupQuizMaxAttempts: [1, 100],
    documentSkipTimeoutMs: [1000, 3600000], taskGiveUpAttempts: [1, 100],
    pptFlipIntervalMs: [100, 600000], guardNoProgressMs: [100, 600000],
    guardResumeCooldownMs: [100, 600000], guardMaxResumeWindow: [100, 600000], guardMaxResumes: [1, 100]
  };
  var strings = { discussionReply: 10000, systemPrompt: 50000, apiConnectionError: 300,
    providerPreset: 100, apiUrl: 4096, apiKey: 8192, model: 256, captchaModel: 256, visionModel: 256 };
  // 枚举型配置：值只许是列出来的那几串。
  // ⚠️ **必须和界面真正发出去的形状对上** —— 2026-11-12 同学机器现场：
  // 弹窗每次都带上 `slowMachineMode:"auto"`，而这个真源里压根没有这一项，
  // `validatePatch` 于是拒掉**整张补丁**，症状是「任何一个开关都存不住」
  // （不是某一个开关坏了 —— 一个没登记的键会把同一次保存里的其它改动一起吞掉）。
  var enums = { slowMachineMode: ['auto', 'on', 'off'] };
  // 三个场景各自的思考区间（批次 123-b）：`'min-max'`，也认单值 `'high'`（上下限相等），
  // `''` = 这一格从没写过，交给老键（thinkingLevel / thinkingPaperLevel）推导。
  // 顺序不管（`'high-low'` 与 `'low-high'` 同义）—— 真源 libs/thinking.js 取小的一格当下限，
  // 这里若比它严，就会把界面发得出、真源读得懂的串顶成 invalid_patch，
  // 而 invalid_patch 拒的是**整张补丁**（用户在界面上动任何一项都存不住）。
  var rangeKeys = ['thinkingRangeCourse', 'thinkingRangeQuiz', 'thinkingRangeExam'];
  var rangeWords = ['off', 'low', 'high'];
  function validRange(value) {
    if (value === '') return true;
    if (typeof value !== 'string' || value.length > 16) return false;
    var parts = value.split('-');
    if (parts.length > 2) return false;
    for (var i = 0; i < parts.length; i++) {
      if (rangeWords.indexOf(parts[i]) === -1) return false;
    }
    return true;
  }
  var runtimeFields = booleans.concat(Object.keys(numbers), Object.keys(enums), rangeKeys,
    ['discussionReply', 'questionSelectorOverrides',
      // 思考档位要投给页面：整卷「不乱猜」闸在页面侧读三个新区间键，
      // 兜底才读 thinkingPaperLevel / thinkingLevel（70-quiz-flow.js _examThinkingMin / _isNoGuessPaper）。
      // 不投影就是「弹窗改了、页面读不到」—— 一句报错都没有，用户只看见答案变差。
      'thinkingLevel', 'thinkingPaperLevel']);
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
        && (key === 'playbackRateCap' || Number.isInteger(value));
    }
    if (own.call(strings, key)) {
      return typeof value === 'string' && value.length <= strings[key]
        && (key !== 'apiUrl' || value === '' || !!httpUrl(value))
        && (key !== 'apiKey' || !/[\r\n\0]/.test(value));
    }
    if (own.call(enums, key)) return enums[key].indexOf(value) !== -1;
    if (key === 'apiType') return ['openai', 'claude', 'gemini'].indexOf(value) !== -1;
    if (key === 'thinkingLevel') return ['off', 'low', 'high'].indexOf(value) !== -1;
    // 整卷思考档位：'' = 跟随全局，是合法值；其余只许三档。
    if (key === 'thinkingPaperLevel') return ['', 'off', 'low', 'high'].indexOf(value) !== -1;
    if (rangeKeys.indexOf(key) !== -1) return validRange(value);
    if (key === 'questionSelectorOverrides') {
      // 追加的题目容器选择器（学习通改版应急）：字符串数组，条数与单条长度都有上界 ——
      // 选择器最终会进 querySelectorAll，无界输入既慢又可能抛异常
      if (!Array.isArray(value) || value.length > 12) return false;
      for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || !value[i] || value[i].length > 200) return false;
      }
      return true;
    }
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
    ['apiType', 'apiUrl', 'apiKey', 'model', 'captchaModel', 'visionModel', 'thinkingLevel', 'thinkingPaperLevel',
      // 区间换了 = 发给服务商的思考参数换了（off-off 发 thinking.disabled，off-high 什么都不发），
      // 所以"这一家收不收这个参数"的旧结论对它不再成立 —— 与 thinkingLevel 同一族理由。
      'systemPrompt'].concat(rangeKeys)
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
