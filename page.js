/**
 * Omitone page runtime for Chaoxing.
 * Runs in the page context and talks to the isolated content script bridge.
 */
(function () {
  'use strict';

  var INSTANCE_ID = (window._XXT_UID || 0) + 1;
  window._XXT_UID = INSTANCE_ID;

  function isActiveInstance() {
    return window._XXT_UID === INSTANCE_ID;
  }

  var APP_NAME = 'Omitone';
  var AUTO_START_ATTR = 'data-xxt-auto-start';

  var DEFAULT_CONFIG = {
    playbackRate: 1.0,
    autoMaxPlaybackRate: true,
    playbackRateCap: 4,
    muted: false,
    // 音频任务点只需进度不需要出声，默认静音播放（不干扰用户、也不受自动播放限制）
    audioMuted: true,
    // 讨论任务点：自动打开讨论页并发布评论（内容见 discussionReply），完成后自动返回继续刷课
    enableDiscussion: true,
    discussionReply: '1',
    discussionTimeoutMs: 90000,
    autoNext: true,
    enableQuiz: true,
    enableCaptcha: true,
    // 主内容区被换成跨域页面（验证码/反作弊）且持续 20 秒无法访问时自动刷新恢复（3 分钟冷却）
    blockedReload: true,
    enableMedia: true,
    enableSeek: true,
    // 防拖拽 + 倍速锁 1x 的视频：老师要求的只是「观看时长 ≥ 总时长的 90%」，
    // 拖不动、也加不了速，最后那 10% 纯粹是白等。
    // 这类视频在**平台自己标记任务点已完成**之后立刻进下一个（判据见 _isNinetyPercentVideo）。
    // 关键安全阀：只认平台给出的完成标记，不靠"播够 90% 就自己认定完成"。
    advanceAtNinetyPercent: true,
    enablePPT: true,
    enableHyperlink: true,
    restudy: false,
    apiType: 'openai',
    apiUrl: 'https://api.deepseek.com',
    apiKey: '',
    apiConnectionFailed: false,
    // 连通性检测失败时由 content.js / popup.js 写入的最近一次原因（只用于诊断展示）
    apiConnectionError: '',
    model: 'deepseek-v4-flash',
    captchaModel: '',
    systemPrompt: '',
    videoCheckInterval: 1500,
    stepSwitchGraceMs: 7000,
    stepSwitchInitDelayMs: 2200,
    taskDiscoverGraceMs: 8000,
    taskPendingGraceMs: 7000,
    quizSubmitWaitMs: 25000,
    quizMaxSubmitAttempts: 20,
    // 同一道弹题最多问模型几次，超过就放手并冷却（见 _giveUpPopupQuiz）。
    // 以前只靠 _getPopupQuizMaxAttempts 里的 `|| 3` 兜底，默认值表里查不到。
    popupQuizMaxAttempts: 3,
    documentSkipTimeoutMs: 120000,
    // 单个任务点连续多少次"派发了但没完成"就放弃（记入 24 小时跳过名单）。
    // 用于对付老师设成防拖拽/不可翻页、或本身不计分的任务点 —— 它们只会白耗时间。
    // 只在**确认没完成**时计数，拿不准一律当作完成，所以调小也相对安全。
    taskGiveUpAttempts: 4,
    pptFlipIntervalMs: 1000,
    guardNoProgressMs: 6000,
    guardResumeCooldownMs: 2500,
    guardMaxResumeWindow: 15000,
    guardMaxResumes: 5
  };

  function mergeConfig(config) {
    var nextConfig = Object.assign({}, config || {});
    delete nextConfig.forceLearn;
    return Object.assign({}, DEFAULT_CONFIG, nextConfig);
  }

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent) return true;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!(rect && rect.width > 0 && rect.height > 0);
  }

  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  var bridgeMsgId = 0;
  var bridgeCallbacks = Object.create(null);

  function emitRuntimeLog(level, message, meta) {
    try {
      window.postMessage({
        source: 'xxt_app',
        type: 'runtime_log',
        level: level || 'info',
        message: message,
        meta: meta || null
      }, '*');
    } catch (e) {}
  }

  var BRIDGE_TIMEOUT_MS = 90000; // content 侧异常不回消息时必须超时释放，否则 _runTick 的 await 永久挂起、整个循环死亡

  function bridgeSend(type, payload) {
    return new Promise(function (resolve) {
      var id = ++bridgeMsgId;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete bridgeCallbacks[id];
        resolve({ success: false, error: 'bridge timeout: ' + type + ' no response in ' + BRIDGE_TIMEOUT_MS + 'ms' });
      }, BRIDGE_TIMEOUT_MS);
      bridgeCallbacks[id] = function (data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data);
      };
      window.postMessage({ source: 'xxt_app', id: id, type: type, payload: payload }, '*');
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'xxt_bridge') return;

    if (msg.type === 'config_response' || msg.type === 'llm_response') {
      var cb = bridgeCallbacks[msg.id];
      if (cb) {
        cb(msg.data);
        delete bridgeCallbacks[msg.id];
      }
      return;
    }

    if (msg.type === 'XXT_CONFIG_UPDATED' && window._xxtApp) {
      window._xxtApp.configs = mergeConfig(Object.assign({}, window._xxtApp.configs || {}, msg.data || {}));
      if (window._xxtApp.configs.apiConnectionFailed) {
        window._xxtApp._quizApiFailUntil = Math.max(window._xxtApp._quizApiFailUntil || 0, Date.now() + 45000);
      }
      console.log('%c[Omitone] config updated', 'color:#2196F3');
    }
  });

  var app = {
    configs: mergeConfig({ apiKey: '', autoNext: true, enableQuiz: false }),

    _videoEl: null,
    _videoCount: 0,
    _currentVideoIndex: 0,
    _isPlaying: false,
    _checkInterval: null,
    _tickLoopInterval: null,
    _quizInProgress: false,
    _quizAnswered: false,
    _quizSubmitPending: false,
    _quizSubmitStartedAt: 0,
    _quizSubmitLogAt: 0,
    _quizLastSubmitAttemptAt: 0,
    _quizHoldLogAt: 0,
    _quizCorrectAnswerCache: null,
    _quizCurrentAnsweredKeys: null,
    _quizCurrentAnswerValues: null,
    _quizCurrentQuestions: null,
    _quizReadyToSubmit: false,
    _quizReadyWorkKey: '',
    _quizForceSkipUntil: 0,
    _quizApiSkipLogAt: 0,
    _quizScanDiagAt: 0,
    // 视频内嵌弹题（弹窗题）的失败计数。
    // 弹题答不上来时弹窗不会消失，而 tick 每 250ms 一轮 —— 没有下面这三个字段，
    // 同一道题会被反复发给模型：用户看到的就是"AI 一直在扫描、但从不填空、课程空转"。
    _popupQuizKey: '',
    _popupQuizAttempts: 0,
    _popupQuizBlockedUntil: 0,
    _popupQuizLogAt: 0,
    _popupQuizSolvedKey: '',
    _popupQuizSolvedAt: 0,
    // 本题已经填过、但没能让弹窗消失的答案（=错的）。重试时带给模型，
    // 由 libs/prompt.js 渲染成「禁:1=D;」前缀 —— 否则模型每轮都回同一个答案。
    _popupQuizWrongAnswers: [],
    _popupQuizLastFilled: '',
    _popupBlockCheckedAt: 0,
    _popupBlockCached: null,
    // 前缀缓存：记住"本卷最近一次发过请求"，用于决定重试时是否整批重发
    _quizBatchSentKey: '',
    _quizBatchSentAt: 0,
    // 「继续学习」提示：弹题答完 / 视频暂停后，播放器右下角会出现这个按钮，
    // 不点它进不去正常播放页 —— 不处理就又变成"AI 一直在跑但课程不动"。
    _continueStudyAt: 0,
    _continueStudyScanAt: 0,
    _continueStudyKey: '',
    _continueStudyClicks: 0,
    _continueStudyBlockedUntil: 0,
    _taskAttempts: null,
    _taskProgress: null,
    _detectedMaxRate: 0,
    _rateDetectVideo: null,
    _rateDetectBusy: false,
    _rateProbing: false,
    _bgWorker: null,
    _bgWorkerUrl: null,
    _workerDelayCallbacks: null,
    _workerDelaySeq: 0,
    _audioKeepalive: null,
    _mediaRepaired: null,
    _pauseResumePending: false,
    _visibilityBound: false,
    _captchaActive: false,
    _captchaBusy: false,
    _captchaAttempts: 0,
    _captchaFailCount: 0,
    _captchaLastCheckAt: 0,
    _captchaLastResult: null,
    _discussionWindow: null,
    _discussionOpenedAt: 0,
    _discussionScanAt: 0,
    _discussionBusy: false,
    _discussionPosted: false,
    _discussionExpanded: false,
    _discussionBefore: null,
    _discussionScrollAt: 0,
    _discussionCardOpened: false,
    _discussionPageUrl: '',
    _discussionPageAt: 0,
    _discussionPageResult: false,
    _quizApiFailUntil: 0,
    _quizApiLastError: '',
    _stepNavigationBound: false,
    _stepSwitchPending: false,
    _stepSwitchAt: 0,
    _skipChainCount: 0,
    _videoRetryCount: 0,
    _lastChapterKey: '',
    _delayedNextUnitTimer: null,
    _guardLastTime: 0,
    _guardLastWallTs: 0,
    _guardLastResumeTs: 0,
    _resumeWindowStart: 0,
    _resumeAttemptCount: 0,
    _activeMediaJobPending: false,
    _activeMediaJobManaged: false,
    _activeDocumentJobPending: false,
    _activeDocumentJobManaged: false,
    _activeDocumentJobDoc: null,
    _mediaWaitLogAt: 0,
    _documentWaitLogAt: 0,
    _lastLearningTabSwitchAt: 0,
    _lastLearningCardKey: '',
    _docTaskState: null,
    _treeContainerEl: null,
    _taskDiscoverStartedAt: 0,
    _taskWaitLogAt: 0,
    _pendingTaskKey: '',
    _pendingTaskStartedAt: 0,
    _pendingTaskLogAt: 0,
    _submitConfirmLastClickAt: 0,
    _activeJobId: '',

    _cellData: {
      cells: 0,
      nCells: 0,
      currentCellIndex: 0,
      currentNCellIndex: 0,
      currentVideoTitle: ''
    },

    _assertActive: function () {
      return isActiveInstance();
    },

    _getMainFrame: function () {
      return document.querySelector('#iframe');
    },

    _getMainDocument: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
      } catch (e) {
        return null;
      }
    },

    _getCurrentTitle: function () {
      var el = document.querySelector('.prev_title');
      return el ? textOf(el).slice(0, 60) : '';
    },

    _getCurrentChapterId: function () {
      if (this._lastChapterKey) return String(this._lastChapterKey);
      var frame = this._getMainFrame();
      var raw = frame ? (frame.src || '') : location.href;
      var match = raw.match(/(?:knowledgeid|chapterId)=([^&]+)/i);
      return match ? String(match[1]) : '';
    },

    run: function () {
      if (!this._assertActive()) return;
      this.configs = mergeConfig(this.configs);
      this._initCellData();
      this._resetRuntimeState();
      this._clearTickLoop();
      this._bindStepNavigation();
      console.log('%c[Omitone] start', 'color:#4CAF50;font-weight:bold');
      emitRuntimeLog('info', 'start');
      this._startTickLoop();
    },

    play: function () {
      if (!this._assertActive()) return;
      this._runTick();
    },

    _resetRuntimeState: function () {
      this._runtimeVersion = (this._runtimeVersion || 0) + 1;
      this._videoEl = null;
      this._videoCount = 0;
      this._currentVideoIndex = 0;
      this._isPlaying = false;
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizSubmitLogAt = 0;
      this._quizLastSubmitAttemptAt = 0;
      this._quizHoldLogAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._quizApiSkipLogAt = 0;
      this._skipChainCount = 0;
      this._videoRetryCount = 0;
      this._activeMediaJobPending = false;
      this._activeMediaJobManaged = false;
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._mediaWaitLogAt = 0;
      this._documentWaitLogAt = 0;
      this._lastLearningTabSwitchAt = 0;
      this._lastLearningCardKey = '';
      this._stepSwitchPending = false;
      this._docTaskState = null;
      this._taskDiscoverStartedAt = Date.now();
      this._taskWaitLogAt = 0;
      this._pendingTaskKey = '';
      this._pendingTaskStartedAt = 0;
      this._pendingTaskLogAt = 0;
      this._submitConfirmLastClickAt = 0;
      this._activeJobId = '';
      if (this._ocsStudyRunning) emitRuntimeLog('info', 'reset study running flag');
      this._ocsStudyRunning = false;
      this._ocsSearchedJobs = [];
      this._ocsSearchDeadline = 0;
      this._ocsLastNoJobLogAt = 0;
      this._jobTransitionUntil = 0;
      this._studyCompleteAt = 0;
      this._chapterChangedAt = Date.now();
      this._attachmentFingerprint = '';
      this._ocsStudyStarted = false;
      this._restudySkipNoticeAt = 0;
      this._clearCheckInterval();
    },

    _dismissPopups: function () {
      var texts = ['继续', '下一节', '跳过', '取消', '关闭', '知道了', '确定'];
      try {
        var buttons = document.querySelectorAll('button, a, .btn, [class*="btn"], .layui-layer-btn a, .layui-layer-btn0, .layui-layer-btn1');
        for (var i = 0; i < buttons.length; i++) {
          if (!visible(buttons[i])) continue;
          var t = textOf(buttons[i]);
          var parentText = '';
          try {
            var container = buttons[i].closest ? buttons[i].closest('.layui-layer, .el-message-box, .ant-modal, .dialog, .modal, [role="dialog"]') : null;
            parentText = container ? textOf(container) : '';
          } catch (e0) {}
          if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(parentText)) {
            return false;
          }
          if (/确认提交|确定提交|确认交卷|是否提交|交卷确认/.test(parentText) && t.indexOf('取消') !== -1) {
            continue;
          }
          for (var j = 0; j < texts.length; j++) {
            if (t.indexOf(texts[j]) !== -1) {
              buttons[i].click();
              return true;
            }
          }
        }
        var closeBtn = document.querySelector('.layui-layer-close, .pop-close, .dialog-close, .modal-close, [class*="close"]');
        if (closeBtn && visible(closeBtn)) {
          var closeContainer = closeBtn.closest ? closeBtn.closest('.layui-layer, .el-message-box, .ant-modal, .dialog, .modal, [role="dialog"]') : null;
          if (closeContainer && /确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(textOf(closeContainer))) {
            return false;
          }
          closeBtn.click();
          return true;
        }
      } catch (e) {}
      return false;
    },

    _detectPageChange: function () {
      var frame = this._getMainFrame();
      var raw = frame ? (frame.src || '') : location.href;
      var match = raw.match(/(?:knowledgeid|chapterId)=([^&]+)/i);
      var key = match ? match[1] : raw;
      if (this._lastChapterKey && this._lastChapterKey !== key) {
        this._resetRuntimeState();
        this._lastLearningCardKey = '';
        this._initCellData();
        console.log('%c[Omitone] chapter changed', 'color:#2196F3');
        emitRuntimeLog('info', 'chapter changed');
      }
      this._lastChapterKey = key;
      this._detectLearningCardChange();
    },

    _clearMediaPendingState: function (reason) {
      var hadPending = !!(this._activeMediaJobPending || this._isPlaying || this._videoEl || this._checkInterval);
      this._clearCheckInterval();
      this._videoEl = null;
      this._videoCount = 0;
      this._currentVideoIndex = 0;
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._activeMediaJobManaged = false;
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._mediaWaitLogAt = 0;
      this._documentWaitLogAt = 0;
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      if (hadPending) {
        emitRuntimeLog('info', 'clear media pending', { reason: reason || '' });
      }
    },

    _clearDocumentPendingState: function (reason) {
      var hadPending = !!(this._activeDocumentJobPending || this._activeDocumentJobManaged || this._activeDocumentJobDoc);
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._documentWaitLogAt = 0;
      this._docTaskState = null;
      if (hadPending) {
        emitRuntimeLog('info', 'clear document pending', { reason: reason || '' });
      }
    },

    _getExplicitActiveLearningCardKey: function () {
      var cards = this._getLearningCards();
      if (!cards.length) return '';

      for (var i = 0; i < cards.length; i++) {
        var cls = String(cards[i].className || '');
        var selected = /\bactive\b/.test(cls) ||
          (cards[i].getAttribute && String(cards[i].getAttribute('aria-selected') || '') === 'true') ||
          !!(cards[i].querySelector && cards[i].querySelector('.active, .on, .current, [aria-selected="true"]'));
        if (!selected) continue;

        var marker = cards[i].getAttribute ? [
          cards[i].getAttribute('cardid') || '',
          cards[i].id || '',
          cards[i].getAttribute('onclick') || '',
          this._getLearningCardText(cards[i])
        ].join('|') : this._getLearningCardText(cards[i]);
        return [i, marker].join('|').slice(0, 300);
      }
      return '';
    },

    _detectLearningCardChange: function () {
      var key = this._getExplicitActiveLearningCardKey();
      if (!key) return;
      if (this._lastLearningCardKey && this._lastLearningCardKey !== key) {
        this._resetRuntimeState();
        emitRuntimeLog('info', 'learning card changed, reset pending state');
      }
      this._lastLearningCardKey = key;
    },

    _isQuizResultCompletedPage: function () {
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      try {
        var text = doc.body ? textOf(doc.body) : '';
        if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text)) return false;
        if (doc.querySelector('.testTit_status_complete')) return true;
        if (/任务点已完成|已完成|已通过|恭喜/.test(text) &&
          doc.querySelector('.TiMu, .questionLi, .questionItem, .mark_item, .questionBox, .answerCon, .answerScore')) {
          return true;
        }
      } catch (e) {}
      return false;
    },

    _shouldReleaseMediaPendingForCurrentCompletion: function (reason) {
      if (!this._activeMediaJobPending && !this._isPlaying) return false;
      var media = this._videoEl;
      if (media && !media.ended && (this._activeMediaJobManaged || this._isPlaying)) return false;

      var state = this._getVisibleTaskCompletionState();
      if (state.hasTasks && state.allFinished) return true;

      if (this._isQuizResultCompletedPage()) return true;

      var mainDoc = this._getMainDocument();
      try {
        var bodyText = mainDoc && mainDoc.body ? textOf(mainDoc.body) : '';
        if (bodyText && /任务点已完成/.test(bodyText) && !/未完成|待完成/.test(bodyText)) return true;
      } catch (e) {}

      return false;
    },

    _isCurrentCompleted: function () {
      if (this._isActiveMediaPending('completion-check')) return false;

      var mainDoc = this._getMainDocument();
      try {
        if (mainDoc && /任务点已完成/.test(textOf(mainDoc.body))) {
          return true;
        }
      } catch (e0) {}

      var state = this._getVisibleTaskCompletionState();
      if (state.hasTasks) return state.allFinished;

      var active = document.querySelector('.posCatalog_select.posCatalog_active, .posCatalog_active');
      if (!active) return false;
      if (active.querySelector('.catalog_points_er, .catalog_points_san')) return false;
      if (!active.querySelector('.catalog_points_yi, .icon_Completed, .icon_completed')) return false;

      if (this._detectQuiz()) return false;

      var currentVideo = this._getVideoEl();
      if (currentVideo && !currentVideo.ended) return false;

      return !this._hasTaskPoint();
    },

    _skipIfCompleted: function () {
      if (this.configs.restudy) {
        var now = Date.now();
        if (!this._restudySkipNoticeAt || now - this._restudySkipNoticeAt > 5000) {
          this._restudySkipNoticeAt = now;
          emitRuntimeLog('info', 'restudy enabled, skip-completed disabled');
        }
        return false;
      }
      if (!this._isCurrentCompleted()) return false;
      if (this._switchToNextLearningCard('skip-completed')) return true;
      console.log('%c[Omitone] skip completed: ' + this._getCurrentTitle(), 'color:#FF9800');
      emitRuntimeLog('info', 'skip completed', { title: this._getCurrentTitle() });
      this._dismissPopups();
      this.nextUnit();
      return true;
    },

    _hasTaskPoint: function () {
      var doc = this._getMainDocument();
      if (!doc) return true;

      var active = document.querySelector('.posCatalog_select.posCatalog_active, .posCatalog_active');
      if (active && active.querySelector('.catalog_points_er, .catalog_points_san, .catalog_points_yi')) return true;
      if (doc.querySelector('.ans-job-icon, .ans-task-icon, .taskPoint, .ans-job-num, [class*="task"], [class*="job"]')) return true;
      if (textOf(doc.body).indexOf('任务点') !== -1) return true;
      return false;
    },

    _walkFrames: function (doc, visitor, depth) {
      if (!doc || depth > 4) return;
      var frames = [];
      try {
        frames = doc.querySelectorAll("iframe");
      } catch (e) {}

      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        visitor(frame);
        try {
          var subDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          this._walkFrames(subDoc, visitor, depth + 1);
        } catch (e2) {}
      }
    },

    _classifyTaskFrame: function (frame) {
      if (!frame) return null;
      var src = String(frame.getAttribute("src") || frame.src || "");
      var shadowSrc = String(frame.getAttribute("_src") || "");
      var dataText = String(frame.getAttribute("data") || "");
      var frameClass = String(frame.className || "");
      var wrap = frame.parentElement;
      var wrapClass = String((wrap && wrap.className) || "");

      // 显式 "job":false 表示这不是任务点（老师没把它设为任务点）——
      // 直接跳过，别再靠类名去推断。与 _getAttachmentWorkType 同一条判据，
      // 来自开源实现 cxmooc-tools 的 CxTask（`if (taskinfo.job) ... else 视为已完成`）。
      // 不加这一道，"不被要求完成的视频"仍会被当成任务点反复处理。
      if (/"job"\s*:\s*false/i.test(dataText)) return null;

      var hasTaskMarker = !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]'));
      var explicitJob = !!frame.getAttribute('jobid') || /"job"\s*:\s*true|"isPassed"\s*:\s*false/i.test(dataText);
      var isTask = frameClass.indexOf("ans-attach") !== -1 ||
        frameClass.indexOf("insertvideo") !== -1 ||
        frameClass.indexOf("insertaudio") !== -1 ||
        frameClass.indexOf("insertdoc") !== -1 ||
        wrapClass.indexOf("ans-attach-ct") !== -1 ||
        !!(wrap && wrap.querySelector(".ans-job-icon"));
      if (!isTask) return null;

      var type = "other";
      var taskHint = [src, shadowSrc, dataText].join(" ");
      if (/api\/work|work\/do(Home)?Work|exam\/test|reVersionTestStartNew|selectWorkQuestion|workid|worktype|jobid\":\"work-|jobid=work-/i.test(taskHint)) type = "quiz";
      // insertaudio 是独立的音频任务点模块，早期只认 insertvideo，音频帧会被判成 other 而跳过
      else if (frameClass.indexOf("insertvideo") !== -1 || frameClass.indexOf("insertaudio") !== -1 || /video|audio|ananas\/modules\/(?:video|audio)/i.test(src)) type = "video";
      else if (frameClass.indexOf("insertdoc") !== -1 || /modules\/(?:doc|docx|ppt|pptx|pdf|innerbook)/i.test(src)) type = "document";

      var finished = false;
      if (wrap) {
        finished = wrap.classList.contains("ans-job-finished") ||
          !!wrap.querySelector(".job-color, .ans-job-finished, .catalog_points_yi");
      }

      var doc = null;
      try {
        doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
        if (!finished && doc && doc.querySelector(".ans-job-finished, .job-color")) finished = true;
      } catch (e) {}

      return {
        frame: frame,
        wrap: wrap,
        doc: doc,
        src: src,
        shadowSrc: shadowSrc,
        dataText: dataText,
        type: type,
        finished: finished,
        hasTaskMarker: hasTaskMarker || explicitJob
      };
    },

    _collectVisibleTaskFrames: function () {
      var tasks = [];
      var doc = this._getMainDocument();
      if (!doc) return tasks;

      this._walkFrames(doc, function (frame) {
        var task = this._classifyTaskFrame(frame);
        if (!task) return;
        if (!visible(frame) && !(task.wrap && visible(task.wrap))) return;
        task.orderIndex = tasks.length;
        tasks.push(task);
      }.bind(this), 0);

      tasks.sort(function (a, b) {
        var markerDiff = Number(!!b.hasTaskMarker) - Number(!!a.hasTaskMarker);
        if (markerDiff) return markerDiff;
        return Number(a.orderIndex || 0) - Number(b.orderIndex || 0);
      });

      return tasks;
    },

    _safeJsonParse: function (value, fallback) {
      try {
        return JSON.parse(value);
      } catch (e) {
        return fallback;
      }
    },

    // 跨域窗口读 .document 会抛 SecurityError:
    // "Blocked a frame with origin X from accessing a cross-origin frame"
    // 该异常一旦冒泡到 _runTick，会打断整轮调度（验证码检测、播放巡检全部停摆）。
    // 所有 iframe/window -> document 的访问必须统一走下面三个助手。
    _safeDocOf: function (source) {
      try {
        if (!source) return null;
        if (source.contentDocument) return source.contentDocument;
        var win = source.contentWindow || source;
        if (win && win.document) return win.document;
      } catch (e) {}
      return null;
    },

    _safeWinDoc: function (win) {
      try { return (win && win.document) || null; } catch (e) { return null; }
    },

    // 帧是否同源可访问（跨域返回 false，绝不抛异常）
    _isFrameSameOrigin: function (frame) {
      try {
        var win = frame && frame.contentWindow;
        return !!(win && win.document);
      } catch (e) {
        return false;
      }
    },

    _getMainWindow: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentWindow || null;
      } catch (e) {
        return null;
      }
    },

    _getChaoxingAttachments: function () {
      var chapterId = this._getCurrentChapterId();
      var filterByChapter = function (attachments) {
        if (!attachments || !attachments.length || !chapterId) return attachments || [];
        var matched = attachments.filter(function (attachment) {
          var otherInfo = String((attachment && attachment.otherInfo) || '');
          var m = otherInfo.match(/nodeId_(\d+)/i);
          if (m && m[1]) return String(m[1]) === chapterId;
          return false;
        });
        return matched.length ? matched : attachments;
      };

      try {
        if (Array.isArray(window.attachments) && window.attachments.length) return filterByChapter(window.attachments);
      } catch (e) {}

      var mainWin = this._getMainWindow();
      try {
        if (mainWin && Array.isArray(mainWin.attachments) && mainWin.attachments.length) return filterByChapter(mainWin.attachments);
      } catch (e2) {}

      try {
        if (mainWin && mainWin.mArg && Array.isArray(mainWin.mArg.attachments) && mainWin.mArg.attachments.length) {
          return filterByChapter(mainWin.mArg.attachments);
        }
      } catch (e3) {}

      return [];
    },

    _getChaoxingFrameData: function (frame, win) {
      var direct = '';
      try { direct = frame ? (frame.getAttribute('data') || '') : ''; } catch (e) {}
      if (direct) return this._safeJsonParse(direct, {});

      try {
        var parentFrame = win && win.parent && win.parent.frameElement;
        if (parentFrame) {
          var parentData = parentFrame.getAttribute('data') || '';
          if (parentData) return this._safeJsonParse(parentData, {});
        }
      } catch (e2) {}

      return {};
    },

    _detectChaoxingJobElements: function (doc) {
      if (!doc || !doc.querySelector) return null;
      var videojs = doc.querySelector('#video, #audio, .video-js, #video_html5_api');
      var chapterTest = doc.querySelector('.TiMu, .questionLi, .mark_item, .questionItem, .answerOption');
      var read = doc.querySelector('#img.imglook, .imglook#img');
      var pptWithAudio = doc.querySelector('.swiper-container');
      var hyperlink = doc.querySelector('#hyperlink');
      var timereader = doc.querySelector('iframe[name="bookifame"][src*="timing"]');
      var documentJob = doc.querySelector('#panView, .fileBox, .pageNum, #docContainer, .docBox');

      if (!(videojs || chapterTest || read || pptWithAudio || hyperlink || timereader || documentJob)) return null;

      return {
        videojs: videojs,
        chapterTest: chapterTest,
        read: read,
        pptWithAudio: pptWithAudio,
        hyperlink: hyperlink,
        timereader: timereader,
        documentJob: documentJob
      };
    },

    _matchChaoxingAttachment: function (attachments, frameData) {
      if (!attachments || !attachments.length || !frameData) return null;
      var targetJobId = frameData.jobid || frameData._jobid;
      var targetObjectId = frameData.objectid || frameData.objectId;

      for (var i = 0; i < attachments.length; i++) {
        var attachment = attachments[i];
        if (!attachment) continue;
        var attachmentJobId = attachment.jobid || (attachment.property && attachment.property._jobid);
        if (targetJobId && attachmentJobId && String(targetJobId) === String(attachmentJobId)) {
          return attachment;
        }
        var attachmentObjectId = attachment.objectId || (attachment.property && attachment.property.objectid);
        if (!targetJobId && targetObjectId && attachmentObjectId && String(targetObjectId) === String(attachmentObjectId)) {
          return attachment;
        }
      }

      return null;
    },

    _getChaoxingJobName: function (attachment) {
      if (!attachment) return '未知任务点';
      var property = attachment.property || {};
      return property.name || property.title || (property.bookname ? property.bookname + (property.author || '') : '') || '未知任务点';
    },

    _getAttachmentWorkType: function (attachment) {
      if (!attachment) return 'not-job';

      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      // ⚠️ isPassed 必须排在 job 前面。
      // 两者同时为真（任务点已通过）时，如果先判 job 就会返回 'job'，
      // 调用点看到 'job' 就直接开跑 —— 于是**已经完成的任务点被重做一遍**，
      // 长视频尤其致命（等于白播一整遍）。返回 'finished' 才会被跳过，
      // 而"重学模式"（restudy）本来就会把 'finished' 也当作要重做。
      if (attachment.isPassed === true) return 'finished';
      if (attachment.job === true) return 'job';

      // ⚠️ 显式 job:false 必须在这里就返回，**不能**落到下面的"按模块名推断"。
      // 老师没把某个视频/文档设为任务点时，接口给的就是 job:false ——
      // 它和"字段缺失"是两件事，但我们旧代码一律继续往下推断成 job，
      // 结果就是去"完成"一个根本不需要完成的任务点，白白耗时间。
      //
      // 这条判据来自开源实现 cxmooc-tools（src/mooc/chaoxing/task.ts）：
      //   if (this.taskinfo.job) { this.done = false } else { this.done = true }
      // 即"没有 job 标记就当作已完成、不处理"。
      var jobFlag = attachment.job !== undefined ? attachment.job : property.job;
      if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
        return 'not-job';
      }

      // 到这里说明 job 字段缺失（超星部分接口确实不带），才允许按模块名推断。
      // 只列**确定是任务点**的模块，不要把 insertimage 加进来：
      // 图片大多是正文内容而非任务点，推断成任务点会让插件去"处理"一堆纯展示的图片。
      if (/insertdoc|insertvideo|insertaudio|work|exam|quiz|book|link/.test(module)) return 'job';
      // 扩展名要允许**不带前导点**：学习通的 property.type 常见写法是 "ppt"/"mp4" 而不是 ".ppt"，
      // 旧正则 `\.(ppt|…)$` 只认带点的写法，这两种任务点会被判成 not-job 直接漏掉。
      if (/(?:^|\.)(?:ppt|pptx|pdf|doc|docx|mp4|m3u8|avi|mp3|m4a|jpg|jpeg|png)$/.test(type)) return 'job';
      if (attachment.jobid || property.jobid || property._jobid || attachment.objectId || property.objectid) return 'job';

      return 'not-job';
    },

    /**
     * 对"确认是任务点但不支持的类型"做去重告警（每种模块只记一条）。
     *
     * 静默丢弃任务点是最难排查的一类问题：用户只看到"这个任务点没做"，
     * 完全无从判断是识别失败、还是压根不支持。留一条日志就能区分。
     */
    _unsupportedJobLogged: null,

    _logUnsupportedJobOnce: function (module, type) {
      if (!this._unsupportedJobLogged) this._unsupportedJobLogged = Object.create(null);
      var key = String(module || '') + '|' + String(type || '');
      if (this._unsupportedJobLogged[key]) return;
      this._unsupportedJobLogged[key] = true;
      emitRuntimeLog('warn', 'unsupported task point type, skipped', {
        module: String(module || '(空)'),
        type: String(type || '(空)')
      });
    },

    _buildAttachmentOnlyJob: function (attachment) {
      if (!attachment) return null;
      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();
      var kind = 'other';

      // 与 _getAttachmentWorkType 同一条判据：显式 job:false 表示老师没把它设为任务点。
      // 这里也必须挡一道 —— 否则调用方若没先过滤，仍然会造出一个"要去做"的任务。
      var jobFlag = attachment.job !== undefined ? attachment.job : property.job;
      if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
        return null;
      }

      if (/insertdoc/.test(module) || /(?:^|\.)(?:ppt|pptx|pdf|doc|docx)$/.test(type)) kind = 'read';
      // 音频任务点走的是同一套媒体流程（_playChaoxingMediaJob 本身已支持 audio 元素），
      // 早期只认 insertvideo，insertaudio 会掉到 other 然后被整条丢弃
      else if (/insertvideo|insertaudio/.test(module) || /(?:^|\.)(?:mp4|m3u8|avi|mp3|m4a)$/.test(type) || /video|audio/.test(type)) kind = 'video';
      else if (/work|exam|quiz/.test(module)) kind = 'quiz';
      // 图片任务点：打开看一眼即可，按"阅读"处理
      else if (/insertimage/.test(module) || /^(?:image|jpg|jpeg|png|gif|webp)/.test(type)) kind = 'read';

      if (kind === 'other') {
        // 不要静默丢弃：任务点被无声跳过时，用户只能看到"这个任务点没做"，
        // 完全无从判断是识别失败还是不支持的题型。这里留一条去重日志。
        this._logUnsupportedJobOnce(module, type);
        return null;
      }

      return {
        frame: null,
        win: null,
        doc: null,
        attachment: attachment,
        kind: kind,
        workType: this._getAttachmentWorkType(attachment),
        name: this._getChaoxingJobName(attachment),
        jobid: attachment.jobid || property._jobid || property.jobid || '',
        objectid: attachment.objectId || property.objectid || '',
        hasTaskMarker: !!attachment.job,
        visible: true,
        synthetic: 'attachment'
      };
    },

    _resolveJobFrame: function (job) {
      if (!job) return job;
      if (job.frame && job.win && job.doc) return job;

      var targetJobId = String(job.jobid || (job.attachment && (job.attachment.jobid || (job.attachment.property && job.attachment.property._jobid))) || '');
      var targetObjectId = String(job.objectid || (job.attachment && (job.attachment.objectId || (job.attachment.property && job.attachment.property.objectid))) || '');
      var found = null;

      this._walkFrames(document, function (frame) {
        if (found) return;
        var win = null;
        var doc = null;
        try {
          win = frame.contentWindow || null;
          doc = frame.contentDocument || (win && win.document) || null;
        } catch (e) {}
        var frameData = this._getChaoxingFrameData(frame, win);
        var frameJobId = String(frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || '');
        var frameObjectId = String(frameData.objectid || frameData.objectId || frame.getAttribute('objectid') || '');

        if (targetJobId && frameJobId && targetJobId === frameJobId) {
          found = { frame: frame, win: win, doc: doc };
          return;
        }
        if (!targetJobId && targetObjectId && frameObjectId && targetObjectId === frameObjectId) {
          found = { frame: frame, win: win, doc: doc };
        }
      }.bind(this), 0);

      if (found) {
        job.frame = found.frame;
        job.win = found.win;
        job.doc = found.doc;
      }
      return job;
    },

    _isJobAlreadySearched: function (job, searchedJobs) {
      if (!job || !searchedJobs || !searchedJobs.length) return false;
      var mid = (job.attachment && job.attachment.property && job.attachment.property.mid) || '';
      var fingerprint = String(mid || job.jobid || job.name || '');
      if (!fingerprint) return false;
      return searchedJobs.some(function (item) {
        return String(item.mid || item.jobid || item.name || '') === fingerprint;
      });
    },

    _getAttachmentFingerprint: function (attachments) {
      if (!attachments || !attachments.length) return '';
      return attachments.map(function (attachment) {
        if (!attachment) return '';
        var property = attachment.property || {};
        return [
          attachment.jobid || property._jobid || property.jobid || '',
          attachment.mid || property.mid || '',
          attachment.objectId || property.objectid || '',
          property.name || ''
        ].join(':');
      }).join('|');
    },

    _buildSyntheticChaoxingJob: function (frame, win, doc, elements) {
      if (!frame || !elements) return null;
      var frameData = this._getChaoxingFrameData(frame, win);
      var kind = 'other';
      if (elements.videojs) kind = 'video';
      else if (elements.chapterTest) kind = 'quiz';
      else if (elements.read) kind = 'read';
      else if (elements.documentJob) kind = 'document';
      else if (elements.timereader) kind = 'timereader';
      else if (elements.pptWithAudio) kind = 'ppt-audio';
      else if (elements.hyperlink) kind = 'hyperlink';

      var wrap = frame.parentElement;
      var finished = !!(wrap && wrap.querySelector('.job-color, .ans-job-finished, .catalog_points_yi'));
      var name = frameData.name || frame.getAttribute('title') || this._getCurrentTitle() || '未知任务点';
      return {
        frame: frame,
        win: win,
        doc: doc,
        attachment: null,
        kind: kind,
        workType: finished ? 'finished' : 'job',
        name: name,
        jobid: frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || frame.src || '',
        hasTaskMarker: !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]')),
        visible: true
      };
    },

    _buildFrameFallbackJob: function (frame) {
      if (!frame) return null;
      var className = String(frame.className || '');
      var src = String(frame.getAttribute('src') || frame.src || '');
      var data = String(frame.getAttribute('data') || '');
      var wrap = frame.parentElement;

      var kind = '';
      if (/ans-insertvideo-online|insertvideo/i.test(className) || /modules\/video|modules\/audio|video|audio/i.test(src)) {
        kind = 'video';
      } else if (/insertdoc/i.test(className) || /pagenum|objectid|\.ppt|\.pptx|\.pdf|\.doc|\.docx/i.test(data + ' ' + src)) {
        kind = 'read';
      }
      if (!kind) return null;

      var frameWin = null;
      var frameDoc = null;
      try {
        frameWin = frame.contentWindow || null;
        frameDoc = frameWin && frameWin.document ? frameWin.document : null;
      } catch (e0) {}
      var frameData = this._getChaoxingFrameData(frame, frameWin);
      var finished = !!(wrap && wrap.querySelector('.job-color, .ans-job-finished, .catalog_points_yi'));
      return {
        frame: frame,
        win: frameWin,
        doc: frameDoc,
        attachment: null,
        kind: kind,
        workType: finished ? 'finished' : 'job',
        name: frameData.name || frame.getAttribute('title') || this._getCurrentTitle() || '未知任务点',
        jobid: frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || src,
        hasTaskMarker: !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]')),
        visible: true
      };
    },

    _searchIFramesOcs: function (rootDoc) {
      var list = [];
      try {
        list = Array.from(rootDoc.querySelectorAll('iframe'));
      } catch (e) {
        return [];
      }
      var result = [];
      while (list.length) {
        var frame = list.shift();
        try {
          if (frame && frame.contentWindow && frame.contentWindow.document) {
            result.push(frame);
            var frames = frame.contentWindow.document.querySelectorAll('iframe');
            list = list.concat(Array.from(frames || []));
          }
        } catch (e2) {}
      }
      return result;
    },

    _searchChaoxingJobOcs: function (searchedJobs) {
      var knowCardWin = this._getMainWindow();
      if (!knowCardWin) return null;
      // 跨域窗口读 .document 会抛 SecurityError：验证码/反作弊页常把主 iframe 指向跨域地址，
      // 裸访问会每轮打断 tick（验证码永远轮不到处理）—— 必须走 _safeWinDoc
      var knowCardDoc = this._safeWinDoc(knowCardWin);
      if (!knowCardDoc) {
        this._markMainFrameCrossOrigin();
        return null;
      }
      this._mainFrameCrossOriginSince = 0;
      var appRef = this;
      var attachments = this._getChaoxingAttachments();
      var searchJobElement = function (frame) {
        var doc = appRef._safeDocOf(frame);
        if (!doc) return null;
        return {
          videojs: doc.querySelector('#video,#audio'),
          chapterTest: doc.querySelector('.TiMu'),
          read: doc.querySelector('#img.imglook'),
          pptWithAudio: doc.querySelector('.swiper-container'),
          hyperlink: doc.querySelector('#hyperlink'),
          timereader: doc.querySelector('iframe[name="bookifame"][src*="timing"]')
        };
      };

      var iframes = this._searchIFramesOcs(knowCardDoc);
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        try {
          var win = frame.contentWindow;
          var doc = appRef._safeWinDoc(win);
          var found = searchJobElement(frame);
          if (!win || !found || !(found.videojs || found.read || found.chapterTest || found.hyperlink || found.pptWithAudio || found.timereader)) {
            continue;
          }
          var frameDataStr = (win.frameElement && win.frameElement.getAttribute('data')) || (((win.frameElement && win.frameElement.contentWindow) && win.frameElement.contentWindow.parent && win.frameElement.contentWindow.parent.frameElement && win.frameElement.contentWindow.parent.frameElement.getAttribute('data'))) || '{}';
          var frameData = this._safeJsonParse(frameDataStr, {});
          var targetJobId = frameData.jobid || frameData._jobid;
          if (!targetJobId) continue;

          var attachment = attachments.find(function (attachmentItem) {
            var attachmentJobId = attachmentItem && (attachmentItem.jobid || (attachmentItem.property && attachmentItem.property._jobid));
            if (!attachmentJobId) return false;
            return String(attachmentJobId) === String(targetJobId);
          });
          if (!attachment) continue;
          if (searchedJobs && searchedJobs.find(function (job2) {
            return job2 && String(job2.mid || job2.jobid || '') === String((attachment.property && attachment.property.mid) || attachment.jobid || '');
          })) {
            continue;
          }

          var jobName = this._getChaoxingJobName(attachment);
          var jobKind = found.videojs ? 'video' : (found.chapterTest ? 'quiz' : (found.read ? 'read' : (found.timereader ? 'timereader' : (found.pptWithAudio ? 'ppt-audio' : 'hyperlink'))));
          var workType = this._getAttachmentWorkType(attachment);
          if (this._isDocumentFrameFinished(doc) || (jobKind === 'quiz' && this._isQuizPassedOrFinished(doc))) {
            workType = 'finished';
          }
          var func = null;
          if (found.videojs) {
            if (!this.configs.enableMedia) {
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (self, jobFrame, jobWin, jobDoc, name, att) {
                return function () {
                  return self._playChaoxingMediaJob({
                    frame: jobFrame,
                    win: jobWin,
                    doc: jobDoc,
                    attachment: att,
                    kind: 'video',
                    workType: workType,
                    name: name,
                    jobid: targetJobId
                  });
                };
              }(this, frame, win, doc, jobName, attachment);
            }
          } else if (found.chapterTest) {
            if (this._isQuizApiUnavailable()) {
              continue;
            }
            if (!(workType === 'job' || (workType === 'finished' && this.configs.restudy))) {
              continue;
            }
            func = function (self, jobDoc) {
              return async function () {
                await self._handleQuiz(jobDoc);
              };
            }(this, doc);
          } else if (found.read || found.pptWithAudio || found.timereader) {
            if (!this.configs.enablePPT) {
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (self, jobFrame, jobWin, jobDoc, name, att, jobKind) {
                return function () {
                  return self._runChaoxingReadJob({
                    frame: jobFrame,
                    win: jobWin,
                    doc: jobDoc,
                    attachment: att,
                    kind: jobKind,
                    workType: workType,
                    name: name,
                    jobid: targetJobId
                  });
                };
              }(this, frame, win, doc, jobName, attachment, found.read ? 'read' : (found.timereader ? 'timereader' : 'ppt-audio'));
            }
          } else if (found.hyperlink) {
            if (!this.configs.enableHyperlink) {
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (jobDoc) {
                return function () {
                  try {
                    var link = jobDoc.querySelector('#hyperlink, a[href]');
                    if (link) link.click();
                  } catch (e3) {}
                  return Promise.resolve();
                };
              }(doc);
            }
          }

          if (func) {
            // 已经在"放弃名单"里的任务点直接跳过：这类任务点多半被老师设成防拖拽/
            // 不可翻页，或者本身不计分。反复重试只会耗时间（尤其是反复回到同一章时）。
            // 名单 24 小时自动过期，控制台 xxtAI.clearTaskGiveUp() 也能立刻清掉。
            if (this._isTaskGivenUp(this._taskPointKey({ jobid: targetJobId, attachment: attachment, name: jobName }))) {
              if (!this._taskGiveUpLogged) this._taskGiveUpLogged = Object.create(null);
              var giveUpKey = String(targetJobId || jobName);
              if (!this._taskGiveUpLogged[giveUpKey]) {
                this._taskGiveUpLogged[giveUpKey] = true;
                emitRuntimeLog('info', 'skip task point in give-up list', {
                  name: String(jobName || '').slice(0, 40),
                  hint: '24 小时内不再尝试；xxtAI.clearTaskGiveUp() 可清除'
                });
              }
              continue;
            }
            return {
              mid: (attachment.property && attachment.property.mid) || attachment.jobid || targetJobId,
              jobid: targetJobId,
              attachment: attachment,
              kind: jobKind,
              name: jobName,
              workType: workType,
              frame: frame,
              win: win,
              doc: doc,
              func: func
            };
          }
        } catch (e4) {}
      }
      return null;
    },

    _ensureOcsStudyRunner: function () {
      if (this._ocsStudyStarted) return true;
      var knowCardWin = this._getMainWindow();
      if (!knowCardWin) return false;
      var knowCardDoc = this._safeWinDoc(knowCardWin); // 跨域窗口裸读 .document 会抛 SecurityError
      if (!knowCardDoc) {
        this._markMainFrameCrossOrigin();
        return false;
      }
      this._ocsStudyStarted = true;
      var version = this._runtimeVersion || 0;
      var self = this;
      (async function () {
        try {
          await sleep(3000);
          if (version !== self._runtimeVersion) return;

          var searchedJobs = [];
          var attachments = self._getChaoxingAttachments();
          var attachmentCount = attachments.length || 0;
          var searching = true;
          var waitTimeout = Math.min(3 + attachmentCount * 2, 10) * 1000;
          emitRuntimeLog('info', 'study begin', { attachments: attachmentCount });

          setTimeout(function () {
            if (version === self._runtimeVersion) searching = false;
          }, waitTimeout);

          while (version === self._runtimeVersion) {
            if (self._isActiveStudyJobPending('ocs-runner-active-job')) {
              await sleep(1000);
              continue;
            }
            var job = self._searchChaoxingJobOcs(searchedJobs);
            if (job && job.func) {
              var trackBeforeRun = job.kind !== 'quiz';
              if (trackBeforeRun) {
                searchedJobs.push({
                  mid: job.mid || '',
                  jobid: job.jobid || '',
                  name: job.name || ''
                });
              }
              emitRuntimeLog('info', 'study matched job', { kind: job.kind, name: job.name, workType: job.workType });
              await job.func();
              if (version !== self._runtimeVersion) return;

              // 只在**有证据**时才判定任务点卡住：
              //   - 已完成 → 清零计数，避免历史值影响后续判断
              //   - 未完成且**两次进度快照完全一致** → 认定卡住，计数
              //   - 未完成但探测不到进度（快照为空）→ 一律不计
              // 绝不能简单用"没完成"来计数：长视频一次本来就跑不完，
              // 那样会让必做任务点被误跳过。
              var jobKey = self._taskPointKey(job);
              if (self._isJobCompleted(job)) {
                if (jobKey) {
                  if (self._taskAttempts) delete self._taskAttempts[jobKey];
                  if (self._taskProgress) delete self._taskProgress[jobKey];
                }
              } else if (jobKey) {
                var snapshot = self._taskProgressSnapshot(job);
                if (!self._taskProgress) self._taskProgress = Object.create(null);
                var previous = self._taskProgress[jobKey];
                self._taskProgress[jobKey] = snapshot;
                if (snapshot && previous !== undefined && snapshot === previous) {
                  self._countTaskIncomplete(job, 'stuck-no-progress');
                }
              }

              if (job.kind === 'quiz' && self._isQuizLearningPending(job.doc || null)) {
                await sleep(1000);
                continue;
              }
              if (!trackBeforeRun) {
                searchedJobs.push({
                  mid: job.mid || '',
                  jobid: job.jobid || '',
                  name: job.name || ''
                });
              }
              await sleep(1000);
              continue;
            }
            if (attachmentCount > 0) {
              attachmentCount--;
              await sleep(1000);
              continue;
            }
            if (searching) {
              await sleep(1000);
              continue;
            }
            if (self._isActiveStudyJobPending('ocs-runner')) {
              await sleep(1000);
              continue;
            }
            break;
          }

          if (version !== self._runtimeVersion) return;
          if (self._isQuizLearningPending(null)) {
            if (self._isQuizApiUnavailable()) {
              self._skipQuizForApiUnavailable(null, null);
              if (version !== self._runtimeVersion) return;
            } else if (!self._quizInProgress && !self._quizAnswered) {
              emitRuntimeLog('info', 'study fallback quiz handler', { searchedCount: searchedJobs.length });
              await self._handleQuiz(null);
              if (version !== self._runtimeVersion) return;
            }
            if (!self._isQuizLearningPending(null)) {
              emitRuntimeLog('info', 'study quiz fallback completed', { searchedCount: searchedJobs.length });
            } else {
            emitRuntimeLog('info', 'study hold quiz before finish', { searchedCount: searchedJobs.length });
            self._ocsStudyStarted = false;
            return;
            }
          }
          if (self._isActiveStudyJobPending('ocs-finish-check')) {
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-finish-check')) {
              await sleep(1000);
            }
            if (version !== self._runtimeVersion) return;
          }
          if (self._isQuizLearningPending(null)) {
            if (self._isQuizApiUnavailable()) {
              self._skipQuizForApiUnavailable(null, null);
              if (version !== self._runtimeVersion) return;
            }
          }
          if (self._isQuizLearningPending(null)) {
            emitRuntimeLog('info', 'study hold quiz before next', { searchedCount: searchedJobs.length });
            self._ocsStudyStarted = false;
            return;
          }
          emitRuntimeLog('info', 'study finished on page', { searchedCount: searchedJobs.length });
          if (self.configs.autoNext) {
            await sleep(5000);
            if (version !== self._runtimeVersion) return;
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-next-check')) {
              await sleep(1000);
            }
            if (version !== self._runtimeVersion) return;
            if (self._isQuizLearningPending(null)) {
              if (self._isQuizApiUnavailable()) {
                self._skipQuizForApiUnavailable(null, null);
                if (version !== self._runtimeVersion) return;
              }
            }
            if (self._isQuizLearningPending(null)) {
              emitRuntimeLog('info', 'study hold quiz before delayed next', { searchedCount: searchedJobs.length });
              self._ocsStudyStarted = false;
              return;
            }
            emitRuntimeLog('info', 'study next unit', { searchedCount: searchedJobs.length });
            self.nextUnit();
          }
        } catch (e) {
          self._ocsStudyStarted = false;
          emitRuntimeLog('error', 'study runner error', { message: e && e.message ? e.message : String(e) });
          throw e;
        }
      })();
      return true;
    },

    _searchChaoxingJob: function (searchedJobs) {
      var attachments = this._getChaoxingAttachments();

      var jobs = [];
      var startDoc = document || this._getMainDocument();
      if (!startDoc) {
        emitRuntimeLog('warn', 'search job: no main document');
        return null;
      }

      try {
        var directFrames = startDoc.querySelectorAll('iframe.ans-attach-online, iframe.ans-insertvideo-online, iframe[class*="insertdoc"], iframe[class*="insertvideo"]');
        for (var df = 0; df < directFrames.length; df++) {
          var directFrame = directFrames[df];
          var directFallbackJob = this._buildFrameFallbackJob(directFrame);
          if (!directFallbackJob) continue;

          var directFrameData = this._getChaoxingFrameData(directFrame, directFrame.contentWindow || null);
          var directAttachment = this._matchChaoxingAttachment(attachments, directFrameData);
          if (directAttachment) {
            directFallbackJob.attachment = directAttachment;
            directFallbackJob.name = this._getChaoxingJobName(directAttachment);
            directFallbackJob.workType = this._getAttachmentWorkType(directAttachment);
            if (this._isDocumentFrameFinished(directFallbackJob.doc) ||
              (directFallbackJob.kind === 'quiz' && this._isQuizPassedOrFinished(directFallbackJob.doc))) {
              directFallbackJob.workType = 'finished';
            }
          }
          jobs.push(directFallbackJob);
        }
      } catch (eDirect) {}

      this._walkFrames(startDoc, function (frame) {
        try {
          var win = frame.contentWindow;
          var doc = win && win.document;
          var elements = this._detectChaoxingJobElements(doc);
          if (!elements) {
            var fallbackJob = this._buildFrameFallbackJob(frame);
            if (fallbackJob) jobs.push(fallbackJob);
            return;
          }

          var frameData = this._getChaoxingFrameData(frame, win);
          var attachment = this._matchChaoxingAttachment(attachments, frameData);
          if (!attachment) {
            var syntheticJob = this._buildSyntheticChaoxingJob(frame, win, doc, elements);
            if (syntheticJob) {
              emitRuntimeLog('info', 'synthetic job created', { kind: syntheticJob.kind, name: syntheticJob.name });
              jobs.push(syntheticJob);
            }
            return;
          }

          var kind = 'other';
          if (elements.videojs) kind = 'video';
          else if (elements.chapterTest) kind = 'quiz';
          else if (elements.read) kind = 'read';
          else if (elements.documentJob) kind = 'document';
          else if (elements.timereader) kind = 'timereader';
          else if (elements.pptWithAudio) kind = 'ppt-audio';
          else if (elements.hyperlink) kind = 'hyperlink';

          var workType = this._getAttachmentWorkType(attachment);
          if (this._isDocumentFrameFinished(doc) || (kind === 'quiz' && this._isQuizPassedOrFinished(doc))) {
            workType = 'finished';
          }
          var hasTaskMarker = !!(frame.parentElement && frame.parentElement.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]'));

          jobs.push({
            frame: frame,
            win: win,
            doc: doc,
            attachment: attachment,
            kind: kind,
            workType: workType,
            name: this._getChaoxingJobName(attachment),
            jobid: frameData.jobid || frameData._jobid || '',
            hasTaskMarker: hasTaskMarker,
            visible: visible(frame) || !!(frame.parentElement && visible(frame.parentElement))
          });
        } catch (e) {}
      }.bind(this), 0);

      var self = this;
      jobs = jobs.filter(function (job) {
        if (searchedJobs && searchedJobs.length) {
          var mid = (job.attachment && job.attachment.property && job.attachment.property.mid) || '';
          var fingerprint = mid || job.jobid || job.name;
          if (fingerprint && searchedJobs.some(function (item) {
            return String(item.mid || item.jobid || item.name || '') === String(fingerprint);
          })) return false;
        }
        if (job.workType === 'job') return true;
        if (job.workType === 'finished') return !!self.configs.restudy;
        return false;
      });

      if (!jobs.length && attachments.length) {
        for (var ai = 0; ai < attachments.length; ai++) {
          var attachmentJob = this._buildAttachmentOnlyJob(attachments[ai]);
          if (!attachmentJob) continue;
          if (this._isJobAlreadySearched(attachmentJob, searchedJobs)) continue;
          if (attachmentJob.workType === 'job' ||
            (attachmentJob.workType === 'finished' && !!this.configs.restudy)) {
            emitRuntimeLog('info', 'attachment-only job created', { kind: attachmentJob.kind, name: attachmentJob.name, workType: attachmentJob.workType });
            jobs.push(attachmentJob);
          }
        }
      }

      if (!jobs.length) {
        emitRuntimeLog('warn', attachments.length ? 'search job: attachments exist but no runnable job' : 'search job: no attachments and no synthetic job');
        return null;
      }

      var kindWeight = {
        video: 0,
        quiz: 1,
        read: 2,
        document: 2,
        timereader: 2,
        'ppt-audio': 2,
        hyperlink: 3,
        other: 4
      };

      jobs.sort(function (a, b) {
        var markerDiff = Number(!!b.hasTaskMarker) - Number(!!a.hasTaskMarker);
        if (markerDiff) return markerDiff;

        var workDiff = (a.workType === 'job' ? 0 : a.workType === 'not-job' ? 1 : 2) - (b.workType === 'job' ? 0 : b.workType === 'not-job' ? 1 : 2);
        if (workDiff) return workDiff;

        return (kindWeight[a.kind] || 99) - (kindWeight[b.kind] || 99);
      });

      emitRuntimeLog('info', 'search job matched candidates', { count: jobs.length, first: jobs[0] ? { kind: jobs[0].kind, name: jobs[0].name, workType: jobs[0].workType } : null });
      return jobs[0] || null;
    },

    _getVisibleTaskCompletionState: function () {
      var tasks = this._collectVisibleTaskFrames();
      return {
        hasTasks: tasks.length > 0,
        allFinished: tasks.length > 0 && tasks.every(function (task) { return !!task.finished; })
      };
    },

    _isActiveMediaPending: function (reason) {
      if (!this._activeMediaJobPending && !this._isPlaying) return false;
      if (this._shouldReleaseMediaPendingForCurrentCompletion(reason || 'media-pending')) {
        this._clearMediaPendingState('completed-visible-task:' + (reason || ''));
        return false;
      }

      var media = this._videoEl || this._getVideoEl();
      if (!media) {
        if (!this._activeMediaJobPending) return false;
        var missingNow = Date.now();
        if (!this._mediaWaitLogAt || missingNow - this._mediaWaitLogAt > 5000) {
          this._mediaWaitLogAt = missingNow;
          emitRuntimeLog('info', 'media pending, waiting for element', { reason: reason || '' });
        }
        return true;
      }

      if (media.ended) {
        if (this._activeMediaJobManaged) {
          this._activeMediaJobPending = false;
          this._activeMediaJobManaged = false;
          this._isPlaying = false;
          this._videoEl = null;
          this._videoCount = 0;
          this._currentVideoIndex = 0;
          this._mediaWaitLogAt = 0;
          emitRuntimeLog('info', 'managed media job ended', { reason: reason || '', jobid: this._activeJobId || '' });
          return false;
        }
        if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
          this._currentVideoIndex++;
          this._videoEl = null;
          this._activeMediaJobPending = true;
          this._mediaWaitLogAt = 0;
          return true;
        }
        this._activeMediaJobPending = false;
        this._isPlaying = false;
        this._mediaWaitLogAt = 0;
        return false;
      }

      this._activeMediaJobPending = true;
      this._ensurePlaybackRate(media, reason || 'pending');
      if (media.paused) {
        this._isPlaying = true;
        this._tryResumePlayback(reason || 'pending');
      }

      var now = Date.now();
      if (!this._mediaWaitLogAt || now - this._mediaWaitLogAt > 5000) {
        this._mediaWaitLogAt = now;
        emitRuntimeLog('info', 'media pending, delay completion', {
          reason: reason || '',
          currentTime: Number(media.currentTime || 0),
          duration: Number(media.duration || 0)
        });
      }
      return true;
    },

    _isActiveDocumentPending: function (reason) {
      if (!this._activeDocumentJobPending) return false;
      var handled = false;
      try {
        handled = this._handleDocumentTask(this._activeDocumentJobDoc || null);
      } catch (e) {
        emitRuntimeLog('warn', 'document pending check failed', { reason: reason || '', message: e && e.message ? e.message : String(e) });
      }
      if (!this._activeDocumentJobPending) return false;
      if (!handled) {
        this._activeDocumentJobPending = false;
        this._activeDocumentJobManaged = false;
        this._activeDocumentJobDoc = null;
        return false;
      }
      var now = Date.now();
      if (!this._documentWaitLogAt || now - this._documentWaitLogAt > 5000) {
        this._documentWaitLogAt = now;
        emitRuntimeLog('info', 'document pending, delay next job', { reason: reason || '' });
      }
      return true;
    },

    _isActiveStudyJobPending: function (reason) {
      if (this._isActiveMediaPending(reason || 'study-job')) return true;
      if (this._isActiveDocumentPending(reason || 'study-job')) return true;
      return false;
    },

    // 从候选媒体里挑一个：优先可见的（video 或 audio），其次隐藏的 audio。
    // 音频常被自定义播放器隐藏（无可见控件/零尺寸）但照样能播；
    // 隐藏的 video 不选，避免误选页面上无关的隐藏视频元素。
    _pickMedia: function (list) {
      var i;
      for (i = 0; i < list.length; i++) {
        var m = list[i];
        if (visible(m) || (m.getClientRects && m.getClientRects().length > 0)) return m;
      }
      for (i = 0; i < list.length; i++) {
        if (String(list[i].tagName || '').toLowerCase() === 'audio') return list[i];
      }
      return null;
    },

    _isVisibleMedia: function (media) {
      return !!media && (visible(media) || (media.getClientRects && media.getClientRects().length > 0));
    },

    _findMediaInDocument: function (doc, depth) {
      if (!doc || !doc.querySelectorAll) return null;
      var picked = this._pickMedia(Array.from(doc.querySelectorAll('video, audio')));
      if (picked) return picked;

      // 播放器可能被包在子 iframe 里（音频任务点常见），递归找一层
      var level = typeof depth === 'number' ? depth : 0;
      if (level >= 3) return null;
      var frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return null; }
      for (var i = 0; i < frames.length && i < 8; i++) {
        var subDoc = this._safeDocOf(frames[i]);
        if (!subDoc) continue;
        var sub = this._findMediaInDocument(subDoc, level + 1);
        if (sub) return sub;
      }
      return null;
    },

    _waitForMediaInDocument: function (doc, timeoutMs) {
      var self = this;
      return new Promise(function (resolve) {
        var deadline = Date.now() + (timeoutMs || 8000);
        var timer = setInterval(function () {
          var media = self._findMediaInDocument(doc);
          if (media) {
            clearInterval(timer);
            resolve(media);
            return;
          }
          if (Date.now() >= deadline) {
            clearInterval(timer);
            resolve(null);
          }
        }, 200);
      });
    },

    // 给可能永久 pending 的 Promise（如 video.play() 在视频源停摆时）加超时护栏，
    // 防止 _runTick 的 await 挂死导致整个循环停止
    _withTimeout: function (promise, ms) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(undefined); // 超时按成功放行，实际播放状态由后续巡检兜底
        }, ms || 10000);
        Promise.resolve(promise).then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });
    },

    _getMediaSeekKey: function (media) {
      if (!media) return '';
      var src = '';
      try { src = media.currentSrc || media.src || ''; } catch (e) {}
      if (src) return src;
      if (this._activeJobId) return 'job:' + this._activeJobId;
      return '';
    },

    // 可拖动视频：直接拖到结尾。每个视频只检查一次、最多只做一次拖动动作；
    // 网站有防拖拽把进度弹回时也不再重试，避免与播放器对抗。
    _trySeekToEnd: function (video, reason) {
      if (!video || video.tagName !== 'VIDEO') return false; // 只拖视频，音频任务保持正常播放
      if (!this.configs.enableSeek) return false;
      if (this._rateProbing) return false; // 倍速探测期间不动进度条，探测结束后的巡检会再进来
      if (this._captchaActive) return false;
      if (!this._seekTriedKeys) this._seekTriedKeys = Object.create(null);
      if (!this._seekRevertedKeys) this._seekRevertedKeys = Object.create(null);
      var key = this._getMediaSeekKey(video);
      if (!key) return false;
      if (this._seekTriedKeys[key]) return false; // 本视频已检查过，只做一次
      if (Object.keys(this._seekTriedKeys).length > 300) {
        this._seekTriedKeys = Object.create(null);
        this._seekRevertedKeys = Object.create(null);
      }

      var duration = Number(video.duration);
      if (!isFinite(duration) || duration <= 20) return false; // 元数据未就绪/时长太短：不标记，下次再检查
      this._seekTriedKeys[key] = true; // 检查完成：此后无论成败都不再动这个视频

      var current = Number(video.currentTime || 0);
      if (current >= duration - 8) return false; // 已在结尾附近，无需拖动

      var target = Math.max(0, duration - 3); // 留 3 秒自然播完，让 ended 事件与任务完成正常触发
      try {
        video.currentTime = target;
      } catch (e) {
        return false;
      }
      emitRuntimeLog('info', 'seekable video: seek to end', {
        reason: reason || '',
        from: Number(current.toFixed(1)),
        to: Number(target.toFixed(1)),
        duration: Number(duration.toFixed(1))
      });
      console.log('%c[Omitone] seekable video, seek to end: ' + current.toFixed(1) + 's -> ' + target.toFixed(1) + 's / ' + duration.toFixed(1) + 's', 'color:#4CAF50');

      // 1.5 秒后验证进度是否被网站弹回（仅记录日志，不再重试）
      //
      // 这个结论会被「防拖拽 + 锁 1 倍速 → 看到 90% 就够」的逻辑复用：
      // **被弹回 = 这个视频不可拖拽**（见 _isNinetyPercentVideo）。
      var self = this;
      this._workerDelay(function () {
        try {
          if (!video.isConnected) return;
          var now = Number(video.currentTime || 0);
          if (now >= duration - 12) {
            self._seekRevertedKeys[key] = false; // 拖成功 → 可拖拽，不走 90% 提前结束
            console.log('[Omitone] seek to end confirmed, now=' + now.toFixed(1) + 's');
          } else {
            self._seekRevertedKeys[key] = true;  // 被弹回 → 不可拖拽
            console.log('[Omitone] seek reverted by site player, continue normal playback');
            emitRuntimeLog('info', 'seek reverted by site, keep playing normally');
          }
        } catch (e) {}
      }, 1500);
      return true;
    },

    _playChaoxingMediaJob: async function (job) {
      if (!job || !job.doc) return false;
      if (!this.configs.enableMedia) {
        console.log('%c[Omitone] media learning disabled, skip: ' + job.name, 'color:#FF9800');
        return true;
      }

      var video = this._findMediaInDocument(job.doc);
      if (!video) {
        video = await this._waitForMediaInDocument(job.doc, 8000);
      }

      if (video) {
        this._videoEl = video;
        this._videoCount = 1;
        this._currentVideoIndex = 0;
      }

      if (!video) {
        this._activeMediaJobPending = false;
        console.warn('[Omitone] chaoxing media not ready:', job.name);
        return false;
      }

      var isAudioTask = String(video.tagName || '').toLowerCase() === 'audio';

      this._activeJobId = job.jobid || '';
      this._videoRetryCount = 0;
      this._skipChainCount = 0;
      this._activeMediaJobPending = !video.ended;
      this._activeMediaJobManaged = true;
      this._mediaWaitLogAt = 0;
      this._isPlaying = true;
      // 每个任务点重新探测最大倍速：避免上一个视频的探测结果串到当前音频上
      this._resetRateDetection();
      this._ensurePlaybackRate(video, 'job-media');
      if (isAudioTask) {
        // 音频诊断：把格式/MIME/浏览器支持情况与最终倍速记进日志，方便确认 m4a 到底能不能播
        var audioSrc = String(video.currentSrc || video.src || '');
        var audioMime = this._guessMediaMime(audioSrc);
        var canPlay = 'unknown';
        try {
          var probe = document.createElement('audio');
          canPlay = probe.canPlayType(audioMime || 'audio/mp4') || 'no';
        } catch (eProbe) {}
        emitRuntimeLog('info', 'audio task started', {
          name: job.name,
          src: audioSrc.slice(-70),
          mime: audioMime || 'unknown',
          canPlay: canPlay,
          muted: !!video.muted,
          rate: Number(video.playbackRate || 1)
        });
      }
      this._trySeekToEnd(video, 'job-start');
      this._videoEventHandle();
      try {
        await this._withTimeout(video.play(), 12000);
        this._startVideoMonitoring();
      } catch (e) {
        try {
          video.muted = true;
          await this._withTimeout(video.play(), 12000);
          this._isPlaying = true;
          this._startVideoMonitoring();
          emitRuntimeLog('warn', 'media autoplay blocked, muted retry ok', { name: job.name });
        } catch (e2) {
          // 静音重试仍失败：多半是音源格式/MIME 不支持（m4a 常见），尝试重新封装音源后播放
          var errText = String((e2 && e2.name) || '') + ' ' + String((e2 && e2.message) || '');
          if (/NotSupported/i.test(errText) || (video.error && video.error.code === 4)) {
            var repaired = await this._maybeRepairMediaSource(video);
            if (repaired) {
              this._isPlaying = true;
              this._startVideoMonitoring();
              emitRuntimeLog('info', 'media play recovered after source repair', { name: job.name });
              return true;
            }
          }
          this._isPlaying = false;
          emitRuntimeLog('error', 'media play failed', {
            name: job.name,
            error: String((e2 && e2.message) || e2 || '').slice(0, 160)
          });
          console.error('[Omitone] chaoxing media play failed:', e2 && e2.message ? e2.message : e2);
        }
      }
      return true;
    },

    _runChaoxingJob: async function (job) {
      if (!job) return false;
      this._resolveJobFrame(job);

      console.log('[Omitone] active chaoxing job:', job.kind, job.workType, job.name);

      if (job.kind === 'video') {
        return this._playChaoxingMediaJob(job);
      }

      if (job.kind === 'quiz') {
        if (this._isQuizApiUnavailable()) return this._skipQuizForApiUnavailable(null, job.doc || null);
        if (this._isQuizPassedOrFinished(job.doc || null)) {
          this._quizInProgress = false;
          this._quizSubmitPending = false;
          this._quizAnswered = true;
          emitRuntimeLog('info', 'quiz already finished');
          return true;
        }
        if (this._monitorQuizSubmit(job.doc || null)) return true;
        if (this._prepareQuizRedoIfNeeded(job.doc || null)) return true;
        if (this._quizInProgress) return true;
        if (!this._quizAnswered) {
          await this._handleQuiz(job.doc);
        } else {
          this._maybeSubmitQuiz(job.doc || null);
        }
        return true;
      }

      if (job.kind === 'read' || job.kind === 'document' || job.kind === 'timereader' || job.kind === 'ppt-audio') {
        if (!this.configs.enablePPT) {
          console.log('%c[Omitone] document learning disabled, skip: ' + job.name, 'color:#FF9800');
          return true;
        }
        return this._runChaoxingReadJob(job);
      }

      if (job.kind === 'hyperlink') {
        if (!this.configs.enableHyperlink) {
          console.log('%c[Omitone] hyperlink learning disabled, skip: ' + job.name, 'color:#FF9800');
          return true;
        }
        try {
          var link = job.doc.querySelector('#hyperlink, a[href]');
          if (link) link.click();
        } catch (e) {}
        return true;
      }

      return false;
    },

    _runChaoxingReadJob: async function (job) {
      if (!job) return false;

      try {
        if (!job.win && job.frame) {
          try { job.win = job.frame.contentWindow || null; } catch (eWin) {}
        }
        if (!job.doc && job.win) {
          try { job.doc = job.win.document || null; } catch (eDoc) {}
        }
        if (!job.win) return false;

        console.log('[Omitone] chaoxing read runner:', job.kind, job.name);
        emitRuntimeLog('info', 'chaoxing read runner', { kind: job.kind, name: job.name });
        this._activeDocumentJobPending = true;
        this._activeDocumentJobManaged = true;
        this._activeDocumentJobDoc = job.doc || null;
        this._documentWaitLogAt = 0;

        try {
          if (job.frame && typeof job.frame.scrollIntoView === 'function') {
            job.frame.scrollIntoView({ block: 'center' });
          } else if (job.frame && job.frame.parentElement && typeof job.frame.parentElement.scrollIntoView === 'function') {
            job.frame.parentElement.scrollIntoView({ block: 'center' });
          }
        } catch (eScroll) {}

        if (job.kind === 'read' && typeof job.win.finishJob === 'function') {
          job.win.finishJob();
          emitRuntimeLog('info', 'read finishJob called', { name: job.name });
          this._clearDocumentPendingState('read-finishJob');
          return true;
        }

        var panView = job.doc.getElementById && job.doc.getElementById('panView');
        var innerWin = panView && panView.contentWindow;
        var innerDoc = innerWin && innerWin.document;

        if (job.kind === 'ppt-audio') {
          return await this._runPptAudioJob(job);
        }

        if (job.kind === 'timereader') {
          try {
            var timerFrame = job.doc.querySelector('iframe[name="bookifame"][src*="timing"]') || null;
            var src = String(
              (timerFrame && (timerFrame.getAttribute('src') || timerFrame.src)) ||
              (job.doc.defaultView && job.doc.defaultView.frameElement && job.doc.defaultView.frameElement.getAttribute('src')) ||
              ''
            );
            var timingParam = src ? new URL(src, location.href).searchParams.get('timing') : null;
            var timing = timingParam !== null && timingParam !== '' ? parseInt(timingParam, 10) : 60;
            if (!Number.isFinite(timing) || timing < 0) timing = 60;
            var waitMs = (timing + 3) * 3 * 1000;
            emitRuntimeLog('info', 'timereader wait', { name: job.name, timing: timing, waitMs: waitMs });
            await sleep(waitMs);
            emitRuntimeLog('info', 'timereader wait complete', { name: job.name });
            var endPage = '';
            try {
              if (typeof job.win.getFrameAttr === 'function') {
                endPage = String(job.win.getFrameAttr('end') || '');
              }
            } catch (eEnd) {}
            if (!endPage) {
              try {
                var dataText = job.frame ? String(job.frame.getAttribute('data') || '') : '';
                var data = this._safeJsonParse(dataText, {});
                endPage = String(data.end || (data.property && data.property.end) || '');
              } catch (eData) {}
            }
            if (!endPage) endPage = '99999';
            try {
              if (typeof job.win.onchangepage === 'function') {
                job.win.onchangepage(endPage, 0);
                emitRuntimeLog('info', 'timereader onchangepage', { name: job.name, end: endPage });
              }
            } catch (eChange) {
              emitRuntimeLog('warn', 'timereader onchangepage failed', { message: eChange && eChange.message ? eChange.message : String(eChange) });
            }
            try {
              if (job.win.top && job.win.top !== job.win && typeof job.win.top.onchangepage === 'function') {
                job.win.top.onchangepage(endPage, 0);
                emitRuntimeLog('info', 'timereader top onchangepage', { name: job.name, end: endPage });
              }
            } catch (eTopChange) {}
            await sleep(5000);
            this._clearDocumentPendingState('timereader-complete');
            return true;
          } catch (e1) {
            emitRuntimeLog('error', 'timereader error', { message: e1 && e1.message ? e1.message : String(e1) });
            this._clearDocumentPendingState('timereader-error');
            return true;
          }
        }

        if (job.kind === 'document' && typeof job.win.finishJob === 'function') {
          job.win.finishJob();
          this._clearDocumentPendingState('document-finishJob');
          return true;
        }

        if (innerDoc && innerDoc.querySelector('.fileBox')) {
          var scrollRoot = innerDoc.scrollingElement || innerDoc.documentElement || innerDoc.body;
          if (!scrollRoot) return true;

          var maxScroll = Math.max(0, Number(scrollRoot.scrollHeight || 0) - Number(scrollRoot.clientHeight || 0));
          var pageHeight = Math.max(240, Number(scrollRoot.clientHeight || 0) - 60);
          var nextTop = Math.min(maxScroll, Number(scrollRoot.scrollTop || 0) + pageHeight);

          if (typeof innerWin.scrollTo === 'function') innerWin.scrollTo(0, nextTop);
          else scrollRoot.scrollTop = nextTop;
          return true;
        }

        if (typeof job.win.setScrollTop === 'function') {
          var pageNodes = job.doc.querySelectorAll('.pageNum02');
          var targetPage = Math.max(1, pageNodes.length || 1);
          job.win.setScrollTop(targetPage);
          return true;
        }

        return this._handleDocumentTask(job.doc);
      } catch (e) {
        return this._handleDocumentTask(job.doc);
      }
    },

    _runPptAudioJob: async function (job) {
      var win = job.win;
      var doc = job.doc || this._safeWinDoc(win) || null;
      if (!win || !doc) return false;

      var slides = doc.querySelectorAll('.swiper-container .swiper-slide').length ||
        doc.querySelectorAll('.swiper-slide').length || 0;
      var intervalMs = Math.max(300, Number(this.configs.pptFlipIntervalMs || 1000));

      function buildFlipper() {
        if (typeof win.swiperNext === 'function') {
          return function () { win.swiperNext(); return true; };
        }
        if (win.swiper && typeof win.swiper.slideNext === 'function') {
          return function () { win.swiper.slideNext(); return true; };
        }
        var nextBtn = doc.querySelector('.swiper-button-next');
        if (nextBtn) {
          return function () {
            var btn = doc.querySelector('.swiper-button-next');
            if (!btn || btn.classList.contains('swiper-button-disabled')) return false;
            btn.click();
            return true;
          };
        }
        var container = doc.querySelector('.swiper-container') || doc.body;
        if (container) {
          return function () {
            try {
              container.dispatchEvent(new (doc.defaultView || window).KeyboardEvent('keydown', {
                key: 'ArrowRight', keyCode: 39, which: 39, bubbles: true
              }));
            } catch (e) {}
            return true;
          };
        }
        return null;
      }

      var flipNext = buildFlipper();
      if (!flipNext) {
        emitRuntimeLog('warn', 'ppt-audio no flip method, use document fallback', { name: job.name });
        return this._handleDocumentTask(doc);
      }

      emitRuntimeLog('info', 'ppt-audio flip begin', { name: job.name, totalPages: slides, intervalMs: intervalMs });

      var total = slides > 0 ? slides + 1 : 60;
      for (var i = 0; i < total; i++) {
        if (!this._assertActive()) return false;
        this._startSlideMedia(doc);
        await this._waitSlideAudioDone(doc);
        emitRuntimeLog('info', 'document page', {
          currentPage: Math.min(i + 1, slides || i + 1),
          totalPages: slides,
          key: 'ppt-audio'
        });
        var flipped = false;
        try { flipped = flipNext(); } catch (eFlip) {}
        if (!flipped) break;
        await sleep(intervalMs);
        if (slides > 0 && i >= slides - 1) break;
      }

      try {
        if (typeof win.finishJob === 'function') {
          win.finishJob();
          emitRuntimeLog('info', 'ppt-audio finishJob called', { name: job.name });
        }
      } catch (eFinish) {}

      this._clearDocumentPendingState('ppt-audio-complete');
      return true;
    },

    _startSlideMedia: function (doc) {
      var medias = [];
      try {
        medias = Array.from(doc.querySelectorAll('audio, video'));
      } catch (e) {}
      var self = this;
      medias.forEach(function (media) {
        if (media.ended) return;
        try {
          media.muted = !!self.configs.muted;
        } catch (e1) {}
        if (media.paused) {
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') {
              p.catch(function () {
                try {
                  media.muted = true;
                  media.play().catch(function () {});
                } catch (e2) {}
              });
            }
          } catch (e3) {}
        }
      });
      return medias.length;
    },

    _waitSlideAudioDone: async function (doc) {
      var waited = 0;
      while (waited < 600000) {
        var active = [];
        try {
          active = Array.from(doc.querySelectorAll('audio, video')).filter(function (media) {
            return !media.ended && (Number(media.currentTime || 0) > 0 || !media.paused);
          });
        } catch (e) {}
        if (!active.length) return true;

        active.forEach(function (media) {
          if (!media.paused) return;
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (e2) {}
        });

        var remaining = 0;
        for (var i = 0; i < active.length; i++) {
          var left = Number(active[i].duration || 0) - Number(active[i].currentTime || 0);
          if (!(left > 0)) left = 1;
          if (left > remaining) remaining = left;
        }
        var waitMs = Math.min(Math.ceil(remaining * 1000) + 800, 30000);
        await sleep(waitMs);
        waited += waitMs;
      }
      return false;
    },

    _runOcsStyleStudy: async function (expectedVersion) {
      if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
        return true;
      }
      var now = Date.now();
      if (this._chapterChangedAt && now - this._chapterChangedAt < 3000) {
        return true;
      }
      if (this._jobTransitionUntil && now < this._jobTransitionUntil) {
        return true;
      }

      if (!this._ocsSearchedJobs) this._ocsSearchedJobs = [];

      var attachments = this._getChaoxingAttachments();
      var attachmentFingerprint = this._getAttachmentFingerprint(attachments);
      if (attachmentFingerprint && attachmentFingerprint !== this._attachmentFingerprint) {
        this._attachmentFingerprint = attachmentFingerprint;
        this._ocsSearchedJobs = [];
        this._ocsSearchDeadline = 0;
        this._studyCompleteAt = 0;
        this._jobTransitionUntil = 0;
        this._ocsLastNoJobLogAt = 0;
        emitRuntimeLog('info', 'attachment fingerprint changed', { count: attachments.length });
      }
      if (!this._ocsSearchDeadline) {
        var waitTimeout = Math.min(3 + (attachments.length || 0) * 2, 10) * 1000;
        this._ocsSearchDeadline = now + waitTimeout;
        emitRuntimeLog('info', 'study begin', { attachments: attachments.length });
      }

      if (this._isActiveStudyJobPending('ocs-style-active-job')) {
        this._studyCompleteAt = 0;
        return true;
      }

      var job = this._searchChaoxingJob(this._ocsSearchedJobs);
      if (job) {
        this._studyCompleteAt = 0;
        var trackBeforeRun = job.kind !== 'quiz';
        if (trackBeforeRun) {
          this._ocsSearchedJobs.push({
            mid: (job.attachment && job.attachment.property && job.attachment.property.mid) || '',
            jobid: job.jobid || '',
            name: job.name || ''
          });
        }
        emitRuntimeLog('info', 'study matched job', { kind: job.kind, name: job.name, workType: job.workType });
        await this._runChaoxingJob(job);
        if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
          return true;
        }
        if (job.kind === 'quiz' && this._isQuizLearningPending(job.doc || null)) {
          this._jobTransitionUntil = Date.now() + 1000;
          emitRuntimeLog('info', 'study hold quiz job', { name: job.name });
          return true;
        }
        if (!trackBeforeRun) {
          this._ocsSearchedJobs.push({
            mid: (job.attachment && job.attachment.property && job.attachment.property.mid) || '',
            jobid: job.jobid || '',
            name: job.name || ''
          });
        }
        this._jobTransitionUntil = Date.now() + 4000;
        emitRuntimeLog('info', 'job transition cooldown', { until: this._jobTransitionUntil, name: job.name });
        return true;
      }

      if (now < this._ocsSearchDeadline) {
        return true;
      }

      if (this._isActiveStudyJobPending('ocs-style-finish-check')) {
        this._studyCompleteAt = 0;
        return true;
      }

      if (this._isQuizLearningPending(null)) {
        if (this._isQuizApiUnavailable()) {
          this._skipQuizForApiUnavailable(null, null);
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
        } else if (!this._quizInProgress && !this._quizAnswered) {
          emitRuntimeLog('info', 'study fallback quiz handler', { searchedCount: this._ocsSearchedJobs.length, runner: 'style' });
          await this._handleQuiz(null);
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
          if (!this._isQuizLearningPending(null)) {
            emitRuntimeLog('info', 'study quiz fallback completed', { searchedCount: this._ocsSearchedJobs.length, runner: 'style' });
          } else {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold quiz before page complete', { searchedCount: this._ocsSearchedJobs.length });
            return true;
          }
        } else {
          this._studyCompleteAt = 0;
          emitRuntimeLog('info', 'study hold quiz before page complete', { searchedCount: this._ocsSearchedJobs.length });
          return true;
        }
      }

      if (this._ocsSearchedJobs.length > 0) {
        if (!this._studyCompleteAt) {
          this._studyCompleteAt = now;
          emitRuntimeLog('info', 'study finished on page', { searchedCount: this._ocsSearchedJobs.length });
          return true;
        }
        if (now - this._studyCompleteAt >= 3000) {
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
          if (this._isActiveStudyJobPending('ocs-style-next-check')) {
            this._studyCompleteAt = 0;
            return true;
          }
          if (this._isQuizLearningPending(null)) {
            if (this._isQuizApiUnavailable()) {
              this._skipQuizForApiUnavailable(null, null);
              return true;
            }
          }
          if (this._isQuizLearningPending(null)) {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold quiz before next unit', { searchedCount: this._ocsSearchedJobs.length });
            return true;
          }
          emitRuntimeLog('info', 'study next unit', { searchedCount: this._ocsSearchedJobs.length });
          if (this.configs.autoNext) {
            this.nextUnit();
          }
          return true;
        }
        return true;
      }

      if (!this._ocsLastNoJobLogAt || now - this._ocsLastNoJobLogAt > 5000) {
        this._ocsLastNoJobLogAt = now;
        emitRuntimeLog('warn', 'study no runnable job', { attachments: attachments.length, searchedCount: this._ocsSearchedJobs.length });
      }
      return false;
    },

    _logTaskWait: function (message, now) {
      var ts = now || Date.now();
      if (ts - this._taskWaitLogAt < 3000) return;
      this._taskWaitLogAt = ts;
      console.log('%c[Omitone] waiting task render: ' + message, 'color:#9C27B0');
    },

    _shouldWaitForTaskDiscovery: function (reason) {
      var now = Date.now();
      if (!this._taskDiscoverStartedAt) this._taskDiscoverStartedAt = now;
      var graceMs = Number(this.configs.taskDiscoverGraceMs || 8000);
      if (graceMs <= 0) return false;

      var doc = this._getMainDocument();
      var bodyText = '';
      try {
        bodyText = doc && doc.body ? textOf(doc.body) : '';
      } catch (e) {}

      var shouldHold = !doc ||
        !!(doc && doc.readyState && doc.readyState !== 'complete') ||
        bodyText.length < 20 ||
        this._hasTaskPoint();

      if (!shouldHold) return false;
      if (now - this._taskDiscoverStartedAt < graceMs) {
        this._logTaskWait((reason || 'discovery') + ' ' + (now - this._taskDiscoverStartedAt) + '/' + graceMs + 'ms', now);
        return true;
      }
      return false;
    },

    _getTaskIdentity: function (task) {
      if (!task) return '';
      var frameId = '';
      try { frameId = task.frame ? (task.frame.id || task.frame.name || '') : ''; } catch (e) {}
      return [task.type, task.src, task.shadowSrc, task.dataText, frameId].join('|').slice(0, 400);
    },

    _isTaskStillLoading: function (task) {
      if (!task) return false;
      var hint = [task.src, task.shadowSrc, task.dataText].join(' ').trim();
      if (!hint) return true;
      if (!task.doc) return true;
      try {
        if (task.doc.readyState && task.doc.readyState !== 'complete') return true;
      } catch (e) {}

      try {
        var bodyText = task.doc.body ? textOf(task.doc.body) : '';
        if (!bodyText) return true;
        if (/加载中|正在加载|请稍候|loading/i.test(bodyText)) return true;
      } catch (e2) {}

      if (task.type === 'other') {
        try {
          if (!task.doc.querySelector('video, audio, .ans-insertvideo-online, .fileBox, .pageNum, .TiMu, .questionLi, [qid], [role="radio"], [role="checkbox"]')) {
            return true;
          }
        } catch (e3) {
          return true;
        }
      }
      return false;
    },

    _handlePendingTask: function (task) {
      var now = Date.now();
      var key = this._getTaskIdentity(task);
      if (this._pendingTaskKey !== key) {
        this._pendingTaskKey = key;
        this._pendingTaskStartedAt = now;
        this._pendingTaskLogAt = 0;
      }

      var graceMs = Number(this.configs.taskPendingGraceMs || 7000);
      var stillLoading = this._isTaskStillLoading(task);
      if (stillLoading && (now - this._pendingTaskStartedAt < graceMs)) {
        if (now - this._pendingTaskLogAt >= 3000) {
          this._pendingTaskLogAt = now;
          console.log('%c[Omitone] waiting task ready: ' + (task.type || 'other') + ' ' + (now - this._pendingTaskStartedAt) + '/' + graceMs + 'ms', 'color:#9C27B0');
        }
        return true;
      }
      return false;
    },
    _locateDocumentTask: function (preferredDoc) {
      var self = this;
      var startDoc = this._getMainDocument() || document;

      function buildTask(doc) {
        if (!doc) return null;
        try {
          if (doc.getElementById && doc.getElementById('panView')) return self._buildPagedDocumentTask(doc);
          if ((doc.getElementById && doc.getElementById('markDataStr')) || doc.querySelector('.pageNum')) return self._buildScrollDocumentTask(doc);
        } catch (e) {}
        return null;
      }

      if (preferredDoc) {
        var preferredTask = buildTask(preferredDoc);
        if (preferredTask) return preferredTask;
      }

      var chaoxingJob = this._searchChaoxingJob();
      if (chaoxingJob && (chaoxingJob.kind === 'document' || chaoxingJob.kind === 'timereader' || chaoxingJob.kind === 'ppt-audio') && chaoxingJob.doc) {
        var jobTask = buildTask(chaoxingJob.doc);
        if (jobTask) return jobTask;
      }

      function walk(doc, depth) {
        if (!doc || depth > 4) return null;
        var currentTask = buildTask(doc);
        if (currentTask) return currentTask;

        var frames = [];
        try {
          frames = doc.querySelectorAll('iframe');
        } catch (e2) {}

        for (var i = 0; i < frames.length; i++) {
          try {
            var subDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
            var found = walk(subDoc, depth + 1);
            if (found) return found;
          } catch (e3) {}
        }
        return null;
      }

      return walk(startDoc, 0);
    },

    _extractFrameKey: function (doc, fallback) {
      try {
        var frame = doc && doc.defaultView && doc.defaultView.frameElement;
        if (frame) return frame.src || frame.getAttribute('src') || frame.id || fallback;
      } catch (e) {}
      return fallback;
    },

    _isDocumentFrameFinished: function (doc) {
      try {
        if (!doc) return false;
        if (doc.querySelector('.ans-job-finished, .job-color, .icon_Completed, .testTit_status_complete')) return true;
        var frame = doc.defaultView && doc.defaultView.frameElement;
        var wrap = frame && frame.parentElement;
        if (!wrap) return false;
        if (wrap.classList && wrap.classList.contains('ans-job-finished')) return true;
        if (wrap.querySelector && wrap.querySelector('.job-color, .ans-job-finished, .icon_Completed, .testTit_status_complete')) return true;
        if (textOf(wrap).indexOf('任务点已完成') !== -1) return true;
      } catch (e) {}
      return false;
    },

    _buildPagedDocumentTask: function (doc) {
      var win = doc.defaultView;
      var panView = doc.getElementById('panView');
      var innerDoc = null;
      try {
        innerDoc = panView && (panView.contentDocument || (panView.contentWindow && panView.contentWindow.document));
      } catch (e) {}

      var items = innerDoc ? Array.from(innerDoc.querySelectorAll('.fileBox li')) : [];
      var totalPages = items.length || (innerDoc ? innerDoc.querySelectorAll('.pageNum').length : 0) || doc.querySelectorAll('.pageNum').length || 1;
      var scrollRoot = innerDoc ? (innerDoc.scrollingElement || innerDoc.documentElement || innerDoc.body) : null;
      var scrollTop = scrollRoot ? Number(scrollRoot.scrollTop || 0) : 0;
      var scrollHeight = scrollRoot ? Number(scrollRoot.scrollHeight || 0) : 0;
      var clientHeight = scrollRoot ? Number(scrollRoot.clientHeight || 0) : 0;
      var maxScroll = Math.max(0, scrollHeight - clientHeight);
      var firstHeight = items[0] ? Math.max(1, Math.round(items[0].getBoundingClientRect().height + 16)) : 0;
      var currentPage = 1;
      if (items.length && innerDoc) {
        for (var i = 0; i < items.length; i++) {
          var itemTop = Number(items[i].offsetTop || 0);
          if (scrollTop + 40 >= itemTop) currentPage = i + 1;
        }
      } else if (firstHeight) {
        currentPage = Math.max(1, Math.min(totalPages, Math.floor(scrollTop / firstHeight) + 1));
      }

      return {
        key: this._extractFrameKey(doc, 'paged-doc'),
        finished: !!(win && win.finishFlag) || this._isDocumentFrameFinished(doc),
        currentPage: currentPage,
        totalPages: totalPages,
        atEnd: maxScroll <= 0 || scrollTop >= maxScroll - 40,
        scrollStep: function (targetPage) {
          var nextPage = targetPage || Math.min(totalPages, currentPage + 1);
          try {
            if (win && typeof win.setScrollTop === 'function') {
              win.setScrollTop(nextPage);
              return true;
            }
          } catch (e) {}
          try {
            if (scrollRoot && items.length && items[nextPage - 1]) {
              scrollRoot.scrollTop = Math.min(maxScroll, Number(items[nextPage - 1].offsetTop || 0));
              return true;
            }
            if (scrollRoot) {
              var stepTop = firstHeight ? Math.min(maxScroll, scrollTop + firstHeight) : maxScroll;
              scrollRoot.scrollTop = stepTop;
              return true;
            }
          } catch (e2) {}
          return false;
        }
      };
    },

    _buildScrollDocumentTask: function (doc) {
      var win = doc.defaultView;
      var scrollRoot = doc.scrollingElement || doc.documentElement || doc.body;
      var totalPages = doc.querySelectorAll('.pageNum').length || 1;
      var scrollTop = scrollRoot ? Number(scrollRoot.scrollTop || 0) : 0;
      var maxScroll = scrollRoot ? Math.max(0, Number(scrollRoot.scrollHeight || 0) - Number(scrollRoot.clientHeight || 0)) : 0;
      var currentPage = totalPages > 1 && maxScroll > 0 ? Math.max(1, Math.min(totalPages, Math.floor((scrollTop / maxScroll) * (totalPages - 1)) + 1)) : 1;

      return {
        key: this._extractFrameKey(doc, 'scroll-doc'),
        finished: this._isDocumentFrameFinished(doc),
        currentPage: currentPage,
        totalPages: totalPages,
        atEnd: maxScroll <= 0 || scrollTop >= maxScroll - 40,
        scrollStep: function () {
          try {
            if (scrollRoot) {
              var pageHeight = Math.max(200, Number(scrollRoot.clientHeight || 0) - 80);
              var nextTop = Math.min(maxScroll, scrollTop + pageHeight);
              if (win && typeof win.scrollTo === 'function') win.scrollTo(0, nextTop);
              else scrollRoot.scrollTop = nextTop;
              return true;
            }
          } catch (e) {}
          return false;
        }
      };
    },

    _handleDocumentTask: function (preferredDoc) {
      var now = Date.now();
      var task = this._locateDocumentTask(preferredDoc);
      if (!task) return false;

      if (!this._docTaskState || this._docTaskState.key !== task.key) {
        this._docTaskState = { key: task.key, lastActionAt: 0, settleAt: 0, lastPage: 0, stallAt: 0, lastProgressAt: now, startedAt: now };
      }

      var state = this._docTaskState;
      if (now - state.lastActionAt < 120) return true;
      state.lastActionAt = now;

      var skipTimeoutMs = Number(this.configs.documentSkipTimeoutMs || 120000);
      var progressAnchor = state.lastProgressAt || state.startedAt || now;
      if (skipTimeoutMs > 0 && now - progressAnchor >= skipTimeoutMs) {
        console.warn('[Omitone] document stuck timeout, skip current task after ' + skipTimeoutMs + 'ms');
        emitRuntimeLog('warn', 'document stuck timeout', { timeoutMs: skipTimeoutMs, key: task.key });
        if (this._activeDocumentJobManaged) {
          this._clearDocumentPendingState('document-timeout');
          return true;
        }
        this.nextUnit();
        return true;
      }

      if (task.finished) {
        state.settleAt = state.settleAt || now;
        if (now - state.settleAt > 150) {
          console.log('%c[Omitone] document done', 'color:#4CAF50');
          emitRuntimeLog('info', 'document done', { key: task.key });
          if (this._activeDocumentJobManaged) {
            this._clearDocumentPendingState('document-done');
            return true;
          }
          this.nextUnit();
        }
        return true;
      }

      state.settleAt = 0;
      if (task.currentPage !== state.lastPage) {
        state.lastPage = task.currentPage;
        state.lastProgressAt = now;
        state.stallAt = 0;
        console.log('%c[Omitone] document page ' + task.currentPage + '/' + task.totalPages, 'color:#2196F3');
        emitRuntimeLog('info', 'document page', { currentPage: task.currentPage, totalPages: task.totalPages, key: task.key });
      } else if (!task.atEnd) {
        if (!state.stallAt) state.stallAt = now;
        if (now - state.stallAt > 2200) {
          task.scrollStep(task.currentPage + 1);
          state.lastActionAt = now;
          state.stallAt = now;
          console.log('%c[Omitone] document stall recovery', 'color:#FF9800');
          emitRuntimeLog('warn', 'document stall recovery', { currentPage: task.currentPage, totalPages: task.totalPages, key: task.key });
          return true;
        }
      }

      if (task.atEnd) {
        task.scrollStep(task.totalPages);
        return true;
      }

      task.scrollStep(task.totalPages);
      return true;
    },

    _isTextOnly: function () {
      if (this._locateDocumentTask()) return false;
      var doc = this._getMainDocument();
      if (!doc || !doc.body) return true;
      var bodyText = textOf(doc.body);
      if (bodyText.length < 10 || bodyText === '暂无内容') return true;
      if (doc.querySelector('video, iframe[src*="video"], iframe[src*="ananas"], .ans-insertvideo-online')) return false;
      if (doc.querySelector('.questionLi, .mark_item, .questionItem, .tiBank, .exam_question, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return false;
      return true;
    },

    _startTickLoop: function () {
      if (this._tickLoopInterval) return;
      var self = this;
      this._tickLoopInterval = setInterval(function () {
        if (!self._assertActive()) {
          self._clearTickLoop();
          return;
        }
        // 看门狗：_runTick 内部某处永久挂起时强制释放锁，恢复循环
        // （历史 bug：bridgeSend 无超时 / video.play() 在视频源停摆时 pending，导致整个刷课停摆）
        if (self._tickRunning && self._tickStartedAt && Date.now() - self._tickStartedAt > 150000) {
          self._tickRunning = false;
          self._tickStartedAt = 0;
          emitRuntimeLog('error', 'tick watchdog: stuck tick force-released, loop resumed', {});
          console.error('[Omitone] tick watchdog: stuck tick force-released');
        }
        self._runTick();
      }, 250);
      this._runTick();
    },

    _clearTickLoop: function () {
      if (this._tickLoopInterval) {
        clearInterval(this._tickLoopInterval);
        this._tickLoopInterval = null;
      }
      this._clearCheckInterval();
    },

    _runTick: async function () {
      if (this._tickRunning) return;
      this._tickRunning = true;
      this._tickStartedAt = Date.now();
      try {
        // 讨论上下文（讨论区独立网址 / 讨论模块页）：发完评论自动返回，期间不做任何刷课动作。
        // 必须放在最前：讨论页不再被误判为课程页，否则会去"找任务点 → 跳章节"
        if (this._isDiscussionContext()) {
          await this._runDiscussionMode();
          return;
        }

        // 独立验证码页（验证码不在学习通界面内，而是独立网址 / 弹出窗口 / 被跳转到的验证页）：
        // 这类页面是顶层页面，插件能完整访问，直接识别填写，处理期间不做任何刷课动作
        if (this._isStandaloneCaptchaPage()) {
          await this._runStandaloneCaptchaMode();
          return;
        }

        // 验证码拦截检测放在最前：页面被验证码挡住时，其他一切（页面变更检测/跳过已完成/答题/播放）都不该继续
        var captchaDialog = null;
        try { captchaDialog = this._checkCaptchaDialog(); } catch (eCap) { captchaDialog = null; }
        if (captchaDialog) {
          if (!this._captchaBusy) await this._handleCaptchaDialog(captchaDialog);
          return;
        }

        // 主 iframe 被换成跨域页面（验证码/反作弊）：JS 完全无法访问，只能靠刷新恢复
        if (this._checkBlockedByCrossOrigin()) return;

        // 讨论页处理期间（已打开讨论标签）：刷课页完全暂停推进，等它关闭或超时再继续
        if (this._handleDiscussionWait()) return;

        // 讨论任务点：在本节其它任务（视频/题目）之前处理掉，处理完刷新章节再继续，
        // 避免和正在播放的视频抢进度
        if (await this._tryDiscussionTask()) return;

        try { this._detectPageChange(); } catch (ePage) {}
        var runtimeVersion = this._runtimeVersion || 0;

        if (this._skipIfCompleted()) {
          return;
        }

        var submitConfirm = this._checkSubmitConfirmDialog();
        if (submitConfirm) {
          this._handleSubmitConfirmDialog(submitConfirm);
          return;
        }

        if (this._monitorQuizSubmit()) {
          return;
        }

        // 必须走 _activePopupBlock 而不是 _checkPopupQuiz：
        // 弹题答不上来时弹窗不会消失，用 _checkPopupQuiz 会让这一支永远命中，
        // 后面的刷课逻辑（播放、跳章、放弃机制）一次都跑不到 —— 课程就此空转。
        var popup = this._activePopupBlock();
        if (popup) {
          await this._handlePopupQuiz(popup);
          this._resumeVideoAfterOverlay('popup');
          return;
        }

        // 弹题答完之后，播放器右下角会冒出「继续学习」，点了才回到正常播放页。
        // 必须放在弹题之后、播放逻辑之前 —— 顺序反了就会永远轮不到它。
        if (this._tryContinueStudyPrompt()) {
          this._resumeVideoAfterOverlay('continue-study');
          return;
        }

        if (this._ensureOcsStudyRunner()) {
          return;
        }

        var ocsStudyHandled = await this._runOcsStyleStudy(runtimeVersion);
        if (ocsStudyHandled) {
          return;
        }

        if (this._isPlaying) {
          var playingVideo = this._getVideoEl();
          if (playingVideo && !playingVideo.ended) {
            this._ensurePlaybackRate(playingVideo, "tick");
            return;
          }
          if (playingVideo && playingVideo.ended) {
            this._isPlaying = false;
            this._clearCheckInterval();
            this.nextUnit();
            return;
          }
          this._isPlaying = false;
          this._clearCheckInterval();
          this._videoEl = null;
        }

        var tasks = this._collectVisibleTaskFrames();
        if (tasks.length > 0) {
          this._taskDiscoverStartedAt = 0;
          this._taskWaitLogAt = 0;

          var unfinishedTasks = tasks.filter(function (task) { return !task.finished; });
          if (unfinishedTasks.length === 0) {
            if (this.configs.autoNext) this.nextUnit();
            return;
          }

          var activeTask = unfinishedTasks[0];
          console.log('[Omitone] active task type:', activeTask.type, activeTask.src || 'inline');

          if (activeTask.type === 'quiz') {
            if (this._handlePendingTask(activeTask)) return;
            this._pendingTaskKey = '';
            this._pendingTaskStartedAt = 0;
            this._pendingTaskLogAt = 0;
            if (this._isQuizApiUnavailable()) {
              this._skipQuizForApiUnavailable(null, activeTask.doc || null);
              return;
            }
            if (this._monitorQuizSubmit(activeTask.doc || null)) return;
            if (this._prepareQuizRedoIfNeeded(activeTask.doc || null)) return;
            if (this._quizInProgress) return;
            if (!this._quizAnswered) {
              await this._handleQuiz(activeTask.doc || null);
            } else {
              this._maybeSubmitQuiz(activeTask.doc || null);
            }
            return;
          }

          if (this._handlePendingTask(activeTask)) return;
          this._pendingTaskKey = '';
          this._pendingTaskStartedAt = 0;
          this._pendingTaskLogAt = 0;

          if (activeTask.type === 'document') {
            if (this._handleDocumentTask(activeTask.doc || null)) return;
          }

          if (activeTask.type === 'video') {
            var video = this._getVideoEl();
            if (video) {
              this._videoRetryCount = 0;
              this._skipChainCount = 0;
              this._isPlaying = true;
              this._ensurePlaybackRate(video, 'start');
              this._videoEventHandle();
              try {
                await this._withTimeout(video.play(), 12000);
                this._startVideoMonitoring();
              } catch (e2) {
                this._isPlaying = false;
                console.error('play failed:', e2 && e2.message ? e2.message : e2);
              }
              return;
            }
            return;
          }

          if (activeTask.type === 'other') {
            if (this._handleDocumentTask()) return;
            var fallbackVideo = this._getVideoEl();
            if (fallbackVideo) {
              this._videoRetryCount = 0;
              this._skipChainCount = 0;
              this._isPlaying = true;
              this._ensurePlaybackRate(fallbackVideo, 'fallback');
              this._videoEventHandle();
              try {
                await this._withTimeout(fallbackVideo.play(), 12000);
                this._startVideoMonitoring();
              } catch (fallbackErr) {
                this._isPlaying = false;
              }
              return;
            }
            if (!this._isQuizApiUnavailable() && !this._quizAnswered && !this._quizInProgress && this._detectQuiz()) {
              await this._handleQuiz(activeTask.doc || null);
            }
            return;
          }

          return;
        }

        if (this._advanceLearningStep()) return;

        if (this._shouldWaitForTaskDiscovery('no-task-frames')) return;

        if (this._isTextOnly() && !this._hasTaskPoint()) {
          this._skipChainCount++;
          this.nextUnit();
          return;
        }
      } catch (err) {
        var errMsg = String((err && err.message) || err || '');
        var errStack = String((err && err.stack) || '')
          .split('\n').slice(0, 3).join(' | ').slice(0, 300);
        // 同一条错误 30 秒内只记一次：否则每 250ms 一条，会刷爆日志并盖住真正有用的信息
        var nowErr = Date.now();
        if (errMsg !== this._lastTickErrMsg || nowErr - (this._lastTickErrAt || 0) > 30000) {
          this._lastTickErrMsg = errMsg;
          this._lastTickErrAt = nowErr;
          this._lastTickErrCount = 1;
          emitRuntimeLog('error', 'tick error', { message: errMsg.slice(0, 200), stack: errStack });
        } else {
          this._lastTickErrCount = (this._lastTickErrCount || 0) + 1;
        }
        console.error('tick error:', err);
      } finally {
        this._tickRunning = false;
        this._tickStartedAt = 0;
      }
    },
    _tick: async function () {
      return this._runTick();
    },

    _ensurePlaybackRate: function (video, reason) {
      if (!video) return;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 音频任务只要进度不需要出声：默认静音播放，避免多标签声音互相干扰
      try {
        video.muted = isAudio ? (this.configs.audioMuted !== false) : !!this.configs.muted;
      } catch (e0) {}
      if (this.configs.autoMaxPlaybackRate !== false && this._rateDetectVideo !== video) {
        this._scheduleMaxRateDetection(video);
      }
      if (this._rateProbing) return;
      var target = this._getTargetPlaybackRate();
      try {
        if (video.defaultPlaybackRate !== target) video.defaultPlaybackRate = target;
      } catch (e) {}
      try {
        if (Math.abs(Number(video.playbackRate || 1) - target) > 0.01) {
          video.playbackRate = target;
          console.log('%c[Omitone] rate guard ' + reason + ': ' + target + 'x', 'color:#607D8B');
        }
      } catch (e2) {}
    },

    _getTargetPlaybackRate: function () {
      if (this.configs.autoMaxPlaybackRate !== false && Number(this._detectedMaxRate) > 0) {
        return this._clampAutoRate(this._detectedMaxRate);
      }
      var target = Number(this.configs.playbackRate || 1);
      return isFinite(target) && target > 0 ? target : 1;
    },

    _clampAutoRate: function (rate) {
      var value = Number(rate) || 1;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      if (value > cap) value = cap;
      if (value < 0.5) value = 0.5;
      return value;
    },

    _resetRateDetection: function () {
      this._detectedMaxRate = 0;
      this._rateDetectVideo = null;
    },

    _scheduleMaxRateDetection: function (video) {
      if (!video) return;
      this._rateDetectVideo = video;
      if (this._rateDetectBusy) return;
      var self = this;
      var epoch = this._rateEpoch || 0;
      this._rateDetectBusy = true;

      var runDetect = function () {
        self._detectMaxPlaybackRate(video).then(function (rate) {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return; // 任务已切换，探测结果作废
          if (Number(rate) > 0) {
            self._detectedMaxRate = rate;
            emitRuntimeLog('info', 'auto playback rate detected', { rate: rate });
            self._ensurePlaybackRate(self._getVideoEl() || video, 'auto-rate');
          } else {
            self._rateDetectVideo = null;
          }
        }).catch(function () {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return;
          self._rateDetectVideo = null;
        });
      };

      // 暂停状态下播放器可能不接管倍速，等播放开始后再探测
      if (!video.paused) {
        runDetect();
        return;
      }
      var tries = 0;
      var timer = setInterval(function () {
        if ((self._rateEpoch || 0) !== epoch) { // 任务已切换，放弃这次探测
          clearInterval(timer);
          self._rateDetectBusy = false;
          return;
        }
        tries++;
        if (!video.paused) {
          clearInterval(timer);
          runDetect();
          return;
        }
        if (tries >= 60) {
          clearInterval(timer);
          self._rateDetectBusy = false;
          self._rateDetectVideo = null;
        }
      }, 500);
    },

    _detectMaxPlaybackRate: async function (video) {
      if (!video) return 0;
      // 首选：播放器倍速菜单里暴露的档位（老师设置的上限会体现在菜单中）
      var menuMax = this._readRateMenuMax(video);
      if (menuMax > 0) {
        emitRuntimeLog('info', 'rate menu max found', { rate: menuMax });
        return this._clampAutoRate(menuMax);
      }
      // 备选：从高到低试设倍速，观察播放器是否把倍速压回
      var probed = await this._probeMaxPlaybackRate(video);
      return this._clampAutoRate(probed || 1);
    },

    _readRateMenuMax: function (video) {
      var doc = video && (video.ownerDocument || document);
      if (!doc) return 0;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 优先在播放器容器内找倍速菜单；音频不做整文档扫描，避免读到页面上其他视频播放器的档位
      var scopes = [];
      try {
        var container = video.closest
          ? video.closest('.video-js, .vjs-player, [class*="player"], [class*="Player"]')
          : null;
        if (container) scopes.push(container);
      } catch (e0) {}
      if (!isAudio) scopes.push(doc);

      var selector = '.vjs-menu-item, .vjs-menu-content li, [class*="speed"] li, [class*="Speed"] li, [class*="rate"] li';
      var maxRate = 0;
      for (var s = 0; s < scopes.length; s++) {
        var nodes = [];
        try {
          nodes = Array.from(scopes[s].querySelectorAll(selector));
        } catch (e) {
          continue;
        }
        for (var i = 0; i < nodes.length; i++) {
          var text = textOf(nodes[i]);
          if (!text || text.length > 16) continue;
          var match = text.match(/(\d+(?:\.\d+)?)\s*(?:x|X|倍)/);
          if (!match) continue;
          var rate = parseFloat(match[1]);
          if (rate > 0 && rate < 32 && rate > maxRate) maxRate = rate;
        }
        if (maxRate > 0) break;
      }
      return maxRate;
    },

    _probeMaxPlaybackRate: async function (video) {
      var self = this;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      var candidates = [4, 3, 2.5, 2, 1.75, 1.5, 1.25, 1].filter(function (c) { return c <= cap; });
      var best = 0;
      this._rateProbing = true;
      try {
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          try { video.playbackRate = candidate; } catch (e) { continue; }
          var settled = await self._waitRateSettle(video, 700);
          if (settled > 0 && Math.abs(settled - candidate) <= 0.05) {
            best = candidate;
            break;
          }
          if (settled > best) best = settled;
        }
      } finally {
        this._rateProbing = false;
      }
      return best;
    },

    _waitRateSettle: async function (video, waitMs) {
      var last = -1;
      var stable = 0;
      var elapsed = 0;
      while (elapsed < (waitMs || 700)) {
        await sleep(150);
        elapsed += 150;
        var current = Number(video.playbackRate || 0);
        if (Math.abs(current - last) <= 0.001) {
          stable += 150;
          if (stable >= 300) return current;
        } else {
          stable = 0;
        }
        last = current;
      }
      return last > 0 ? last : 0;
    },

    _startVideoMonitoring: function () {
      this._clearCheckInterval();
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._ensureBackgroundWorker();
      this._bindVisibilityHandlers();
      this._syncAudioKeepalive();
      var self = this;
      this._checkInterval = setInterval(function () {
        self._checkVideoStatus();
      }, this.configs.videoCheckInterval || 1500);
    },

    _clearCheckInterval: function () {
      if (this._checkInterval) {
        clearInterval(this._checkInterval);
        this._checkInterval = null;
      }
      this._syncAudioKeepalive();
    },

    // ---- 后台/最小化防节流 ----
    // 浏览器对后台标签页的 setTimeout/setInterval 有强节流（最低 1 次/分钟），
    // 且静音（不可听）媒体在后台会被暂停/降速播放。以下三层防御保证最小化后视频继续推进：
    // 1. Worker 心跳：Web Worker 内的定时器不受标签页可见性节流，用它持续驱动视频守护
    // 2. pause 事件立即恢复：事件派发不受定时器节流，视频被网站/浏览器暂停后第一时间恢复
    // 3. 无声音频保活：让浏览器把标签页视为"正在播放音频"，豁免强节流与后台静音媒体限制
    _ensureBackgroundWorker: function () {
      if (this._bgWorker) return this._bgWorker;
      try {
        var code = [
          'var interval=null;',
          'onmessage=function(e){var d=e.data||{};',
          "if(d.op==='interval'){",
          '  if(interval)clearInterval(interval);',
          '  interval=setInterval(function(){postMessage({op:"tick"})},d.ms||1500);',
          '}else if(d.op==="delay"){',
          '  setTimeout(function(){postMessage({op:"fire",id:d.id})},d.ms||0);',
          '}else if(d.op==="stop"){',
          '  if(interval)clearInterval(interval);interval=null;',
          '}};'
        ].join('');
        var blob = new Blob([code], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);
        var worker = new Worker(url);
        var self = this;
        this._workerDelayCallbacks = {};
        worker.onmessage = function (e) {
          var d = e.data || {};
          if (d.op === 'tick') {
            if (document.hidden) {
              self._checkVideoStatus();
              if (typeof self._backgroundCaptchaTick === 'function') self._backgroundCaptchaTick();
            }
            return;
          }
          if (d.op === 'fire' && self._workerDelayCallbacks) {
            var fn = self._workerDelayCallbacks[d.id];
            delete self._workerDelayCallbacks[d.id];
            if (typeof fn === 'function') fn();
          }
        };
        worker.postMessage({ op: 'interval', ms: this.configs.videoCheckInterval || 1500 });
        this._bgWorker = worker;
        this._bgWorkerUrl = url;
        emitRuntimeLog('info', 'background worker heartbeat started');
      } catch (e) {
        this._bgWorker = null;
        emitRuntimeLog('warn', 'background worker unavailable, fallback to page timers', {
          error: String(e && e.message ? e.message : e).slice(0, 120)
        });
      }
      return this._bgWorker;
    },

    _workerDelay: function (fn, ms) {
      if (this._bgWorker && this._workerDelayCallbacks) {
        this._workerDelaySeq = (this._workerDelaySeq || 0) + 1;
        var id = 'wd' + this._workerDelaySeq;
        this._workerDelayCallbacks[id] = fn;
        try {
          this._bgWorker.postMessage({ op: 'delay', id: id, ms: ms || 0 });
          return;
        } catch (e) {}
      }
      setTimeout(fn, ms || 0);
    },

    _startAudioKeepalive: function () {
      if (this._audioKeepalive) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        oscillator.frequency.value = 50;
        gain.gain.value = 0.003; // 近乎无声：人耳不可辨，但足以让浏览器将标签页视为正在播放音频
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          ctx.resume().catch(function () {});
        }
        this._audioKeepalive = { ctx: ctx, oscillator: oscillator };
        emitRuntimeLog('info', 'audio keepalive started (anti background throttling)');
      } catch (e) {}
    },

    _stopAudioKeepalive: function () {
      if (!this._audioKeepalive) return;
      try { this._audioKeepalive.oscillator.stop(); } catch (e0) {}
      try { this._audioKeepalive.ctx.close(); } catch (e1) {}
      this._audioKeepalive = null;
    },

    _syncAudioKeepalive: function () {
      var hidden = !!(document.hidden || document.visibilityState === 'hidden');
      if (this._isPlaying && hidden) this._startAudioKeepalive();
      else this._stopAudioKeepalive();
    },

    _bindVisibilityHandlers: function () {
      if (this._visibilityBound) return;
      this._visibilityBound = true;
      var self = this;
      document.addEventListener('visibilitychange', function () {
        self._syncAudioKeepalive();
        if (!document.hidden) {
          // 回到前台：立即校验一次视频状态与倍速
          self._checkVideoStatus();
          var video = self._getVideoEl();
          if (video) self._ensurePlaybackRate(video, 'visibility-resume');
        }
      });
    },

    // ---- 验证码自动检测与识别 ----
    // 已知学习通结构（参考开源 cxmooc-tools）：#imgVerCode 图片 / #ucode 输入框 / #sub 提交按钮
    // 同时做通用兜底：任意"验证码图片 + 附近文本输入框"的可见弹层都识别
    _checkCaptchaDialog: function () {
      // 独立于 AI 答题开关：只要配了 API Key + 视觉模型，验证码识别始终可用
      if (!this.configs.enableCaptcha) {
        if (this._captchaActive) this._captchaActive = false;
        return null;
      }
      var now = Date.now();
      if (now - (this._captchaLastCheckAt || 0) < 1500) return this._captchaLastResult || null;
      this._captchaLastCheckAt = now;

      var result = null;

      function findInputNear(doc, img) {
        // 1) 沿祖先向上找最近的文本输入框
        var node = img;
        for (var level = 0; level < 6 && node && node !== doc.body; level++) {
          node = node.parentElement;
          if (!node) break;
          var inputs = node.querySelectorAll('input[type="text"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            if (!visible(input)) continue;
            if (input.offsetWidth < 24) continue;
            return input;
          }
        }
        // 2) 兜底：在图片所在的弹窗容器内全量找
        var box = null;
        try { box = img.closest('div, form, table, layer, .layui-layer'); } catch (e) {}
        if (box) {
          var boxInputs = box.querySelectorAll('input[type="text"], input:not([type]), input[id*="code" i], input[name*="code" i]');
          for (var j = 0; j < boxInputs.length; j++) {
            if (!visible(boxInputs[j])) continue;
            if (boxInputs[j].offsetWidth < 24) continue;
            return boxInputs[j];
          }
        }
        return null;
      }

      function hitImgSize(img) {
        var w = img.naturalWidth || img.clientWidth || 0;
        var h = img.naturalHeight || img.clientHeight || 0;
        if (w && (w < 40 || w > 400)) return false;
        if (h && (h < 16 || h > 200)) return false;
        return true;
      }

      function scanDoc(doc, depth) {
        if (!doc || depth > 3 || result) return;
        var imgs = [];
        try { imgs = Array.from(doc.querySelectorAll('img')); } catch (e0) { return; }
        for (var i = 0; i < imgs.length && !result; i++) {
          var img = imgs[i];
          if (!visible(img)) continue;
          var src = String(img.currentSrc || img.src || '');
          var idName = String(
            (img.id || '') + ' ' + (img.getAttribute('name') || '') + ' ' + (img.className || '')
          ).toLowerCase();
          // A. 已知学习通验证码元素（最高置信，不受尺寸/文案限制）
          var specific = /imgvercode|chapternumvercode|vercode|verifycode|captcha|imgcode/.test(idName);
          // B. 图片地址特征
          var srcMatch = /\/img\/code|captcha|verif|vercode|rand=|getcode|checkcode|\/code\?/i.test(src);
          if (!specific && !srcMatch) continue;
          if (!hitImgSize(img)) continue;
          var input = findInputNear(doc, img);
          if (!input) continue;
          var dialog = doc.body;
          try {
            dialog = input.closest('.layui-layer, [class*="dialog"], [class*="verif"], form, table') || input.parentElement || img.parentElement || doc.body;
          } catch (e1) {}
          result = { doc: doc, img: img, input: input, dialog: dialog, why: specific ? 'element-id' : 'img-src' };
        }

        // C. 弹窗文本兜底：可见弹窗含“验证码”字样 + 图片 + 输入框（应对学习通改版换 id）
        if (!result) {
          var layers = [];
          try { layers = Array.from(doc.querySelectorAll('.layui-layer, [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="verif"]')); } catch (e2) {}
          for (var m = 0; m < layers.length && !result; m++) {
            var box = layers[m];
            if (!visible(box)) continue;
            var boxText = textOf(box).slice(0, 300);
            if (!/验证码|请输入|校验码/.test(boxText)) continue;
            var boxImgs = [];
            try { boxImgs = Array.from(box.querySelectorAll('img')); } catch (e3) {}
            for (var n = 0; n < boxImgs.length && !result; n++) {
              var bimg = boxImgs[n];
              if (!visible(bimg)) continue;
              if (!hitImgSize(bimg)) continue;
              // 弹窗文案里已含“验证码”，直接信任该图片
              var binput = findInputNear(doc, bimg);
              if (!binput) continue;
              result = { doc: doc, img: bimg, input: binput, dialog: box, why: 'dialog-text' };
            }
          }
        }

        if (!result) {
          var frames = [];
          try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e4) {}
          for (var k = 0; k < frames.length && !result; k++) {
            try {
              var subDoc = frames[k].contentDocument || (frames[k].contentWindow && frames[k].contentWindow.document);
              scanDoc(subDoc, depth + 1);
            } catch (e5) {}
          }
        }
      }

      try {
        var startDoc = this._getMainDocument() || document;
        scanDoc(startDoc, 0);
        if (!result) scanDoc(document, 0);
      } catch (e) {}

      this._captchaLastResult = result;
      this._captchaActive = !!result;
      // ⚠️ 这里原本有一句 `if (!result) this._diagnoseBlockedPage();`。
      // 那个函数在早前一轮「清理调试代码」时被删掉了，但调用点留了下来，
      // 于是「没有验证码」这个最常见的情况下每次都会抛 TypeError ——
      // _runTick 里那处有 try/catch 兜住所以看不出来，但另外 3 处调用点
      // （_handleCaptchaDialog 复检、_backgroundCaptchaTick、_handleVideoPlay 守卫）
      // 没有兜底，会把整条链路打断。删掉调用即可；诊断能力现在由
      // _diagnoseQuestionScan / _checkBlockedByCrossOrigin 覆盖。
      // 这类"幽灵调用"由 tools/check.js 的未定义方法检查兜底。
      return result;
    },

    _captureCaptchaImage: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var canvas = doc.createElement('canvas');
        var w = img.naturalWidth || img.clientWidth || 120;
        var h = img.naturalHeight || img.clientHeight || 40;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL('image/png');
      } catch (e) {
        // 跨域图片会污染画布，交由后台带 Cookie 抓取兜底
        return '';
      }
    },

    _resolveImageUrl: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var base = doc.baseURI || window.location.href;
        return new URL(img.src || img.currentSrc || '', base).href;
      } catch (e) {
        return '';
      }
    },

    _cleanCaptchaCode: function (raw) {
      var text = String(raw || '');
      var quoted = text.match(/[「『“"]([^」』”"]{1,24})[」』”"]/);
      if (quoted && quoted[1]) text = quoted[1];
      var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length) text = lines[lines.length - 1];
      text = text.replace(/^.*?(?:答案|结果|验证码|code|result)\s*[:：]\s*/i, '');
      text = text.replace(/[\s"'`~!@#$%^&*()（）\-_=+\[\]【】{}\\|;:;,.，。、：；！？·…<>《》/?？]+/g, '');
      if (text.length > 12) text = text.slice(0, 12);
      return text;
    },

    _fillCaptchaInput: function (captcha, code) {
      var input = captcha.input;
      try { input.focus(); } catch (e0) {}
      var win = input.ownerDocument.defaultView || window;
      try {
        var descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, code);
        else input.value = code;
      } catch (e1) {
        input.value = code;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    },

    _clickCaptchaSubmit: function (captcha) {
      var doc = captcha.input.ownerDocument || document;
      var button = null;
      try { button = doc.querySelector('#sub'); } catch (e0) {}
      if (!button && captcha.dialog) {
        var candidates = captcha.dialog.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]');
        for (var i = 0; i < candidates.length; i++) {
          var label = textOf(candidates[i]);
          if (/^(确定|提交|验证|确认|OK)/.test(label)) { button = candidates[i]; break; }
        }
      }
      if (button) {
        try { button.click(); return; } catch (e1) {}
      }
      // 无按钮则模拟回车提交
      try {
        var win = doc.defaultView || window;
        captcha.input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        captcha.input.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (e2) {}
    },

    _captchaReload: function () {
      emitRuntimeLog('warn', 'captcha unsolved, reload page', {});
      try { window.location.reload(); } catch (e) {}
    },

    // 主 iframe 被换成跨域页面（验证码/反作弊拦截）：JS 完全无法访问其内部，
    // 既检测不到验证码也填不了，唯一恢复手段就是刷新页面（刷新后由自动续跑接管）
    _markMainFrameCrossOrigin: function () {
      if (!this._mainFrameCrossOriginSince) this._mainFrameCrossOriginSince = Date.now();
    },

    _checkBlockedByCrossOrigin: function () {
      var frame = this._getMainFrame();
      if (!frame) return false;
      if (this._isFrameSameOrigin(frame)) {
        this._mainFrameCrossOriginSince = 0;
        return false;
      }

      this._markMainFrameCrossOrigin();
      var held = Date.now() - (this._mainFrameCrossOriginSince || Date.now());
      var now = Date.now();

      // 页面还在加载时 iframe 归属可能未定，先不判定为被拦截，避免误刷新
      if (document.readyState !== 'complete') {
        this._mainFrameCrossOriginSince = 0;
        return false;
      }

      if (now - (this._crossOriginLogAt || 0) > 15000) {
        this._crossOriginLogAt = now;
        emitRuntimeLog('warn', 'main frame is cross-origin, page likely blocked by captcha/anti-bot', {
          heldSec: Math.round(held / 1000)
        });
      }

      if (held > 20000 && this.configs.blockedReload !== false) {
        if (now - (this._blockedReloadAt || 0) > 180000) {
          this._blockedReloadAt = now;
          emitRuntimeLog('warn', 'blocked page unreachable from JS, reload to recover', {
            heldSec: Math.round(held / 1000)
          });
          try { window.location.reload(); } catch (e) {}
        }
      }

      return true; // 主内容都拿不到，本轮没必要继续跑后面的逻辑
    },

    // ===== 独立验证码页：验证码不在学习通界面内，而是一个独立网址 / 弹出窗口 / 被跳转到的验证页 =====
    // 这类页面是顶层页面（不是跨域 iframe），插件可以完整访问 DOM，因此完全可以自动识别并填写。
    _recognizeCaptchaImage: async function (img) {
      var dataUrl = this._captureCaptchaImage(img);
      if (!dataUrl) {
        var absUrl = this._resolveImageUrl(img);
        if (absUrl) {
          try {
            var fetched = await bridgeSend('fetch_image', { url: absUrl });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = fetched.dataUrl;
          } catch (e0) {}
        }
      }
      if (!dataUrl) return { ok: false, error: 'captcha image capture failed' };

      var result = await bridgeSend('llm_captcha', { image: dataUrl });
      if (!result || !result.success) {
        return { ok: false, error: String((result && result.error) || 'no response').slice(0, 200) };
      }
      var code = this._cleanCaptchaCode(result.data);
      if (!code) return { ok: false, error: 'empty code after clean', raw: String(result.data || '').slice(0, 60) };
      return { ok: true, code: code };
    },

    // 独立验证页里定位「验证码图片 + 输入框」：整页就是一张验证表单，判定比弹窗场景宽
    _detectStandaloneCaptcha: function () {
      var doc = document;
      var imgs = [];
      try { imgs = Array.from(doc.querySelectorAll('img')); } catch (e) { return null; }
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (!visible(img)) continue;
        var w = img.naturalWidth || img.clientWidth || 0;
        var h = img.naturalHeight || img.clientHeight || 0;
        if (w && (w < 40 || w > 400)) continue;
        if (h && (h < 16 || h > 200)) continue;
        var area = (img.clientWidth || w) * (img.clientHeight || h);
        if (area > bestArea) { bestArea = area; best = img; }
      }
      if (!best) return null;

      var inputs = [];
      try { inputs = Array.from(doc.querySelectorAll('input')); } catch (e2) {}
      var input = null;
      for (var j = 0; j < inputs.length; j++) {
        var el = inputs[j];
        if (!visible(el)) continue;
        if (/^(hidden|checkbox|radio|button|submit|file|image)$/i.test(String(el.type || 'text'))) continue;
        input = el;
        break;
      }
      if (!input) return null;
      return { doc: doc, img: best, input: input, dialog: document.body, why: 'standalone-page' };
    },

    _computeStandaloneCaptchaPage: function () {
      try {
        if (this._getMainFrame()) return false; // 学习通课程页一定有 #iframe
        if (document.querySelector('#video, #audio, .TiMu, .questionLi, .swiper-container, .ans-attach')) return false;
        var bodyText = textOf(document.body || document.documentElement).slice(0, 800);
        var urlHit = /(verif|captcha|checkcode|validate|seccode|yzm|\/code|captchaImage)/i.test(String(location.href || ''));
        var textHit = /验证码|校验码|请输入|captcha|verify|robot|人机|安全验证/i.test(bodyText);
        if (!urlHit && !textHit) return false;
        return !!this._detectStandaloneCaptcha();
      } catch (e) {
        return false;
      }
    },

    // ===================== 讨论任务点 =====================
    // 讨论任务点不在课程 iframe 内：点击后会跳转到独立的讨论页（新标签页或当前标签页），
    // 必须在该页面发布评论才算完成。原识别逻辑只认 video/quiz/read/document 等类型，
    // 这类任务点会被判成 other 直接跳过，因此这里单独实现：
    //   刷课页：检测讨论任务点 → 打开讨论页 → 暂停推进等待
    //   讨论页：自动填内容 → 点发布 → 检测成功 → 关闭/返回
    //   回到刷课页：刷新章节继续运行（全程有超时兜底，绝不会卡住）

    _discussionStoreKey: 'omitone_discussion_done',

    _discussionDoneMap: function () {
      try {
        var raw = localStorage.getItem(this._discussionStoreKey);
        var parsed = raw ? this._safeJsonParse(raw, {}) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    },

    _markDiscussionDone: function (key) {
      try {
        var map = this._discussionDoneMap();
        map[key] = Date.now();
        localStorage.setItem(this._discussionStoreKey, JSON.stringify(map));
      } catch (e) {}
    },

    _isDiscussionDone: function (key) {
      var at = Number(this._discussionDoneMap()[key] || 0);
      return !!at && Date.now() - at < 24 * 3600 * 1000; // 24 小时内不重复处理
    },

    /**
     * 撤回"已完成"标记。
     *
     * _markDiscussionDone 是先于打开动作写的（防止重复打开同一个讨论页），
     * 所以一旦发现根本没能打开，必须把这条记录撤掉 ——
     * 否则该任务点会被静默跳过 24 小时，用户只看到"没做"，日志里毫无线索。
     */
    _unmarkDiscussionDone: function (key) {
      if (!key) return;
      try {
        var map = this._discussionDoneMap();
        if (map[key] === undefined) return;
        delete map[key];
        localStorage.setItem(this._discussionStoreKey, JSON.stringify(map));
      } catch (e) {}
    },

    // ===================== 做不完的任务点 =====================
    // 学习通允许老师把任务点配置成"锁住"的形态：视频开防拖拽（拖了会被弹回）、
    // 文档/PPT 不给翻页、或者任务点本身就是不计分的摆设。
    // 插件对这些只会一次次重试，白耗时间 —— 尤其是反复回到同一章时。
    //
    // 这里的策略是**只放弃"确实完成不了"的**：每派发一次任务点就检查它是否真的完成了，
    // 没完成才计数；连续 N 次都没完成就记入 localStorage（24 小时）并跳过，同时留日志。
    // 判定"是否完成"拿不准时一律当作完成（`_isJobCompleted` 返回 true），
    // 宁可多跑一次也不要误跳过必做任务点。

    _taskGiveUpStoreKey: 'omitone_task_giveup',

    _taskGiveUpMap: function () {
      try {
        var raw = localStorage.getItem(this._taskGiveUpStoreKey);
        var parsed = raw ? this._safeJsonParse(raw, {}) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    },

    /** 任务点的稳定标识：优先 jobid/objectid，兜底用 module + 名称 */
    _taskPointKey: function (job) {
      if (!job) return '';
      var att = job.attachment || {};
      var prop = att.property || {};
      var id = job.jobid || att.jobid || prop._jobid || prop.jobid ||
        job.objectid || att.objectId || prop.objectid;
      if (id) return 'job:' + String(id);
      var module = String(prop.module || att.module || '');
      var name = String(job.name || '').slice(0, 40);
      if (!module && !name) return '';
      return 'nm:' + module + '|' + name;
    },

    _isTaskGivenUp: function (key) {
      if (!key) return false;
      var record = this._taskGiveUpMap()[key];
      if (!record || !record.at) return false;
      return Date.now() - Number(record.at) < 24 * 3600 * 1000;
    },

    _markTaskGivenUp: function (key, info) {
      if (!key) return;
      try {
        var map = this._taskGiveUpMap();
        map[key] = {
          at: Date.now(),
          name: String((info && info.name) || '').slice(0, 60),
          reason: String((info && info.reason) || ''),
          attempts: Number((info && info.attempts) || 0)
        };
        localStorage.setItem(this._taskGiveUpStoreKey, JSON.stringify(map));
      } catch (e) {}
    },

    /** 用户在控制台里可以清掉放弃记录，让插件重新尝试这些任务点 */
    _clearTaskGiveUp: function () {
      try { localStorage.removeItem(this._taskGiveUpStoreKey); } catch (e) {}
      this._taskAttempts = {};
      this._taskProgress = null;
    },

    _taskGiveUpList: function () {
      var map = this._taskGiveUpMap();
      var now = Date.now();
      return Object.keys(map).map(function (key) {
        var record = map[key] || {};
        return {
          key: key,
          name: record.name || '',
          reason: record.reason || '',
          attempts: record.attempts || 0,
          ageMinutes: Math.round((now - Number(record.at || 0)) / 60000),
          expired: now - Number(record.at || 0) >= 24 * 3600 * 1000
        };
      });
    },

    /**
     * 任务点是否真的完成了。
     * **拿不准就返回 true** —— 这个函数的返回值会喂给"放弃计数"，
     * 误判成"没完成"会把必做任务点跳过，比多跑一次严重得多。
     */
    _isJobCompleted: function (job) {
      if (!job) return true;
      try {
        if (job.doc) {
          if (this._isDocumentFrameFinished(job.doc)) return true;
          if (this._isQuizPassedOrFinished(job.doc)) return true;
        }
        var frame = job.frame;
        var wrap = job.wrap || (frame && frame.parentElement);
        if (wrap && wrap.classList && wrap.classList.contains('ans-job-finished')) return true;
        if (wrap && wrap.querySelector && wrap.querySelector('.ans-job-finished, .job-color')) return true;
      } catch (e) {
        return true;
      }
      return false;
    },

    /**
     * 任务点的"进度快照"。
     *
     * 这个函数是"做不完就放弃"机制的**安全阀**：只有当同一个任务点连续两次
     * 快照**完全一致**时才认定它卡住了；探测不到进度就返回空串，调用方一律不计。
     *
     * 为什么不能简单地用"没完成"来计数：长视频一次本来就跑不完，
     * `_isJobCompleted` 会一直返回 false，按"没完成"计数会让**必做任务点被误跳过** ——
     * 那比多花点时间严重得多。
     */
    _taskProgressSnapshot: function (job) {
      if (!job) return '';
      try {
        var doc = job.doc;
        if (!doc || !doc.querySelector) return '';

        var media = doc.querySelector('video, audio');
        if (media) return 'media:' + Math.floor(Number(media.currentTime || 0));

        // 只有**确实可滚动**的文档才用 scrollTop 当进度。
        // 否则"不可滚动的页面"会给出恒定的 scroll:0，看起来和"卡住"一模一样，
        // 于是每一次重派都被计成一次卡住 —— 这是把"测不到"误当成"没进展"。
        var scroller = doc.scrollingElement || doc.documentElement;
        if (scroller) {
          var scrollable = Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0);
          if (scrollable > 20) return 'scroll:' + Math.floor(Number(scroller.scrollTop || 0));
        }
      } catch (e) {}
      return '';
    },

    /**
     * 记录一次"派发了但没完成"。
     *
     * ⚠️ 调用方必须已经确认"确实卡住"（见 _taskProgressSnapshot 的说明）。
     * 达到上限就记入放弃列表。
     */
    _countTaskIncomplete: function (job, reason) {
      var key = this._taskPointKey(job);
      if (!key) return;
      if (!this._taskAttempts) this._taskAttempts = Object.create(null);

      this._taskAttempts[key] = (this._taskAttempts[key] || 0) + 1;
      var attempts = this._taskAttempts[key];
      var limit = Math.max(1, Number(this.configs.taskGiveUpAttempts || 4));

      if (attempts < limit) {
        emitRuntimeLog('info', 'task point stuck, will retry', {
          name: String(job.name || '').slice(0, 40),
          attempts: attempts,
          limit: limit,
          reason: reason || ''
        });
        return;
      }

      this._markTaskGivenUp(key, { name: job.name, reason: reason || 'incomplete', attempts: attempts });
      emitRuntimeLog('warn', 'task point given up (stuck without progress)', {
        name: String(job.name || '').slice(0, 40),
        attempts: attempts,
        reason: reason || '',
        hint: '该任务点可能被设为防拖拽/不可翻页，或本身不计分。24 小时内不再尝试；控制台 xxtAI.clearTaskGiveUp() 可清除'
      });
    },

    _discussionNameOf: function (attachment) {
      if (!attachment) return '';
      var property = attachment.property || {};
      return String(property.name || property.title || attachment.name || attachment.title || '');
    },

    _isDiscussionAttachment: function (attachment) {
      if (!attachment) return false;
      var property = attachment.property || {};
      var meta = String(property.module || attachment.module || '') + ' ' +
        String(property.type || attachment.type || '');
      if (/discuss|discus|bbs|topic|forum|thread|talk/i.test(meta)) return true;
      return /讨论|话题|回帖|发帖/.test(this._discussionNameOf(attachment));
    },

    // 在课程页/同源 iframe 中找讨论任务点的可点击入口（优先带真实链接的 <a>）
    _findDiscussionEntry: function (preferredName) {
      var KEY = /讨论|话题|回帖|发帖|参与讨论/;
      var docs = [];
      try {
        var mainDoc = this._getMainDocument();
        if (mainDoc) docs.push(mainDoc);
        if (document !== mainDoc) docs.push(document);
      } catch (e0) {
        docs.push(document);
      }

      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (!doc || !doc.querySelectorAll) continue;
        var nodes = [];
        try { nodes = Array.from(doc.querySelectorAll('a[href], [onclick], li, div, span')); } catch (e1) { continue; }
        var best = null;
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!visible(node)) continue;
          var text = String(textOf(node) || '').trim();
          if (!text || text.length > 40) continue;
          if (!KEY.test(text)) continue;
          var link = node.tagName === 'A' ? node : node.querySelector('a[href]');
          var href = link ? String(link.getAttribute('href') || '') : String(node.getAttribute('href') || '');
          var score = 0;
          if (preferredName && text.indexOf(preferredName) >= 0) score += 2;
          if (href && href !== '#' && !/^javascript:/i.test(href)) score += 1;
          if (!best || score > best.score) best = { node: link || node, href: href, text: text, score: score };
        }
        if (best) return best;
      }
      return null;
    },

    // 当前是不是"讨论上下文"（讨论区页面 / 讨论模块页）。用网址快判，启动即可用，不依赖 DOM 渲染。
    _isDiscussionContext: function () {
      if (this.configs.enableDiscussion === false) return false;
      var href = '';
      try { href = String(location.href || ''); } catch (e0) { return false; }
      if (/groupweb\.chaoxing\.com|\/course\/topic\/|\/bbscircle\//i.test(href)) return true;
      return this._isDiscussionPage();
    },

    // 遍历文档树（含 iframe 递归，跨域自动跳过），对每个可访问文档执行 cb
    _walkDocs: function (root, cb) {
      var self = this;
      var seen = [];
      (function walk(doc, depth) {
        if (!doc || depth > 4) return;
        if (seen.indexOf(doc) >= 0) return;
        seen.push(doc);
        try { cb(doc); } catch (e0) {}
        var frames = [];
        try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e1) { return; }
        for (var i = 0; i < frames.length && i < 12; i++) walk(self._safeDocOf(frames[i]), depth + 1);
      })(root, 0);
    },

    _studyDocs: function () {
      var docs = [];
      var mainDoc = null;
      try { mainDoc = this._getMainDocument(); } catch (e0) {}
      if (mainDoc) docs.push(mainDoc);
      if (document !== mainDoc) docs.push(document);
      return docs;
    },

    // 讨论任务点在页面里是卡片 #topicMainDiv，其 data 属性就是讨论区地址（groupweb.chaoxing.com/course/topic/...）
    /**
     * 某个讨论卡片自己的"已完成"标志。
     *
     * 学习通把 `#isFinished` 放在**每个讨论模块自己的页面**里，值来自服务端。
     * 旧实现直接用 `doc.getElementById('isFinished')` —— 一个章节里若有多个讨论任务点，
     * 它们可能落在同一个文档中，于是所有卡片共用同一个标志：
     * 第一个已完成，其余全被当作"已回复"而永久跳过；反之则会反复重开同一个。
     *
     * 返回 null 表示"在卡片范围内找不到"，由调用方决定怎么兜底
     * （不要在这里返回 false —— 那会把"未知"当成"未完成"，可能重复发评论）。
     */
    _scopedDiscussionFinishedFlag: function (card) {
      if (!card) return null;
      var readFlag = function (scope) {
        if (!scope || !scope.querySelector) return null;
        var flag = null;
        try {
          flag = scope.querySelector('#isFinished, input[name="isFinished"][value], input[name="isFinished"]');
        } catch (e) {}
        if (!flag) return null;
        return /true/i.test(String(flag.value || flag.getAttribute('value') || ''));
      };

      // 1) 卡片内部
      var inside = readFlag(card);
      if (inside !== null) return inside;

      // 2) 逐层向上找，但只在"只包含本卡片"的祖先上读标志。
      //    ⚠️ 必须先判断祖先里有多少张卡片，再读标志 —— 顺序反了就会在
      //    多卡片共用的容器上读到共用值，原 bug 原样复发。
      var scope = card;
      for (var level = 0; level < 4 && scope; level++) {
        scope = scope.parentElement;
        if (!scope) break;

        var cardCount = 1;
        try { cardCount = scope.querySelectorAll('#topicMainDiv[data]').length; } catch (e2) {}
        if (cardCount > 1) break; // 共用容器：不许在这里读标志

        var found = readFlag(scope);
        if (found !== null) return found;
      }
      return null;
    },

    /**
     * 讨论任务点的稳定去重键。
     *
     * 旧实现用 `url.slice(-70)`：两个讨论任务的地址若只有前段不同、后 70 字符相同，
     * 就会算出同一个键 —— 第二个任务被 `_isDiscussionDone` 判成"24 小时内已处理"而
     * **永久跳过**。多讨论任务点场景下这是实打实的漏做。
     * 改为优先取真正唯一的 mtopicid，取不到再退回整条 URL 的哈希。
     */
    _discussionKeyOf: function (url) {
      var raw = String(url || '');
      if (!raw) return '';
      var m = raw.match(/[?&](?:mtopicid|mtopicId|topicid|topicId|topic_id|id)=([^&#]+)/i);
      if (m && m[1]) return 'topic:' + decodeURIComponent(m[1]).slice(0, 48);

      var hash = 5381;
      for (var i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
      return 'url:' + hash.toString(36);
    },

    _collectDiscussionTargets: function () {
      var self = this;
      var targets = [];
      var docs = this._studyDocs();
      for (var d = 0; d < docs.length; d++) {
        this._walkDocs(docs[d], function (doc) {
          var cards = [];
          try {
            cards = Array.from(doc.querySelectorAll('#topicMainDiv[data], [data*="groupweb.chaoxing.com/course/topic"]'));
          } catch (e1) { return; }

          // 该文档里一共有几张卡片：只有 1 张时才允许退回"文档级标志"
          // （此时两者等价），多张时宁可按"未完成"处理也不要漏做
          var sameDoc = cards.filter(function (node) {
            return /groupweb\.chaoxing\.com\/course\/topic/i.test(String(node.getAttribute('data') || ''));
          }).length;

          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var url = String(card.getAttribute('data') || '');
            if (!/groupweb\.chaoxing\.com\/course\/topic/i.test(url)) continue;

            // 同文档里的 #isFinished 是服务端给出的"本任务点是否已完成"。
            // ⚠️ 必须**按卡片范围**查找，不能无脑 doc.getElementById ——
            // 多张卡片落在一个文档里时会共用同一个标志，导致批量漏做或反复重开。
            var scoped = self._scopedDiscussionFinishedFlag(card);
            var finished;
            if (scoped !== null) {
              finished = scoped;
            } else if (sameDoc <= 1) {
              // 只有一张卡片：文档级查找与卡片级等价，保留旧行为（最保守）
              var fin = null;
              try { fin = doc.getElementById('isFinished'); } catch (eF) {}
              finished = !!fin && /true/i.test(String(fin.value || ''));
            } else {
              // 多张卡片又找不到各自标志：按"未完成"处理。
              // 重复发评论由 _isDiscussionDone（24 小时）与提交前的二次确认兜住，
              // 而漏做是完全静默的 —— 两者相权取其轻。
              finished = false;
            }

            targets.push({
              url: url,
              title: String(textOf(card) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
              key: self._discussionKeyOf(url),
              finished: finished
            });
          }
        });
      }
      return targets;
    },

    // 卡片还没渲染时的退路：找讨论模块 iframe（module=insertbbs），它带着 mid / jobid / 标题
    _findDiscussionModuleFrames: function () {
      var self = this;
      var out = [];
      var docs = this._studyDocs();
      for (var d = 0; d < docs.length; d++) {
        this._walkDocs(docs[d], function (doc) {
          var frames = [];
          try { frames = Array.from(doc.querySelectorAll('iframe[module]')); } catch (e1) { return; }
          for (var i = 0; i < frames.length; i++) {
            var module = String(frames[i].getAttribute('module') || '');
            if (!/insertbbs|bbs|discuss/i.test(module)) continue;
            out.push({
              frame: frames[i],
              data: self._safeJsonParse(String(frames[i].getAttribute('data') || ''), null) || {}
            });
          }
        });
      }
      return out;
    },

    _currentStudyParams: function () {
      var raw = '';
      try {
        var frame = this._getMainFrame();
        raw = String((frame && frame.src) || '') + ' ' + String(location.href || '');
      } catch (e0) { raw = String(location.href || ''); }
      var pick = function (name) {
        var m = raw.match(new RegExp('[?&]' + name + '=([^&]+)', 'i'));
        return m ? decodeURIComponent(m[1]) : '';
      };
      return {
        courseid: pick('courseid') || pick('courseId'),
        clazzid: pick('clazzid') || pick('clazzId'),
        knowledgeid: pick('knowledgeid') || pick('chapterId'),
        utenc: pick('utenc')
      };
    },

    // 从讨论模块 iframe → 内嵌 #frame_content → 取回页面 HTML → 解析出讨论区地址
    _resolveDiscussionUrlFromModule: async function (mod) {
      if (!mod || !mod.frame) return '';
      var chapterSrc = '';
      var doc = this._safeDocOf(mod.frame);
      if (doc) {
        try {
          var fc = doc.getElementById('frame_content') ||
            doc.querySelector('iframe[src*="bbscircle"], iframe[src*="/chapter"]');
          if (fc) chapterSrc = String(fc.getAttribute('src') || '');
        } catch (e0) {}
      }
      if (!chapterSrc) {
        var data = mod.data || {};
        var mid = data.mid || '';
        if (mid) {
          var p = this._currentStudyParams();
          chapterSrc = '/mooc-ans/bbscircle/chapter?mtopicid=' + encodeURIComponent(mid) +
            '&jobid=' + encodeURIComponent(data.jobid || data._jobid || '') +
            '&isPortal=false&knowledgeid=' + encodeURIComponent(p.knowledgeid) +
            '&ut=s&clazzId=' + encodeURIComponent(p.clazzid) +
            '&utenc=' + encodeURIComponent(p.utenc) +
            '&courseid=' + encodeURIComponent(p.courseid) + '&isJob=true';
        }
      }
      if (!chapterSrc) return '';
      var abs = chapterSrc;
      try { abs = new URL(chapterSrc, location.href).href; } catch (e1) {}
      try {
        var resp = await fetch(abs, { credentials: 'include' });
        var html = await resp.text();
        var m = html.match(/id=["']topicMainDiv["'][^>]*\bdata=["']([^"']+)["']/i) ||
          html.match(/\bdata=["'](https?:\/\/groupweb\.chaoxing\.com\/course\/topic[^"']+)["']/i);
        if (m) return String(m[1]).replace(/&amp;/g, '&');
      } catch (e2) {}
      return '';
    },

    _findDiscussionTask: async function () {
      // 1) 最可靠：页面里已有话题卡片，直接拿到讨论区地址
      var targets = [];
      try { targets = this._collectDiscussionTargets(); } catch (e0) { targets = []; }
      if (targets.length) {
        var pending = targets.filter(function (t) { return !t.finished; });
        if (!pending.length) return null; // 本节讨论任务点已完成（服务端已记录回复）
        var t0 = pending[0];
        return { key: t0.key, name: t0.title || '讨论', url: t0.url, el: null, href: t0.url };
      }

      // 2) 卡片还没渲染（懒加载）：从讨论模块 iframe 解析
      var modules = [];
      try { modules = this._findDiscussionModuleFrames(); } catch (e1) { modules = []; }
      for (var i = 0; i < modules.length; i++) {
        var url = await this._resolveDiscussionUrlFromModule(modules[i]);
        if (url) {
          return {
            // 同样必须用稳定键：多讨论任务点下 url.slice(-70) 会碰撞，导致漏做
            key: this._discussionKeyOf(url),
            name: String((modules[i].data && modules[i].data.title) || '讨论').slice(0, 60),
            url: url, el: null, href: url
          };
        }
      }
      // 让模块 iframe 进入视口，促使懒加载下一次渲染出卡片（10 秒内不重复滚动）
      if (modules.length) {
        if (Date.now() - (this._discussionScrollAt || 0) > 10000) {
          this._discussionScrollAt = Date.now();
          try { modules[0].frame.scrollIntoView({ block: 'center' }); } catch (e2) {}
        }
        return null;
      }

      // 3) 兜底：老办法（页面有"讨论/话题"字样的可点击入口）
      var name = '';
      try {
        var attachments = this._getChaoxingAttachments() || [];
        for (var k = 0; k < attachments.length; k++) {
          if (this._isDiscussionAttachment(attachments[k])) {
            name = this._discussionNameOf(attachments[k]);
            break;
          }
        }
      } catch (e3) {}
      var entry = this._findDiscussionEntry(name);
      if (!entry) return null;
      return {
        // 兜底路径没有讨论区地址，只能用"名称 + 链接"拼键；
        // 链接部分同样走哈希，避免 slice 截断造成的碰撞
        key: String(name || entry.text || '讨论').slice(0, 40) + '|' + this._discussionKeyOf(entry.href || ''),
        name: name || entry.text || '讨论',
        url: '', el: entry.node, href: entry.href
      };
    },

    // 刷课页侧：发现讨论任务点就打开讨论页
    _tryDiscussionTask: async function () {
      if (this.configs.enableDiscussion === false) return false;
      if (this._discussionBusy) return true;
      if (this._discussionWindow && !this._discussionWindow.closed) return true;
      if (Date.now() - (this._discussionOpenedAt || 0) < 15000) return false;
      // 全文档扫描开销大，最多 3 秒一次（tick 每 250ms 一轮）
      if (Date.now() - (this._discussionScanAt || 0) < 3000) return false;
      this._discussionScanAt = Date.now();

      var task = null;
      try { task = await this._findDiscussionTask(); } catch (e0) { task = null; }
      if (!task) return false;
      if (this._isDiscussionDone(task.key)) return false;

      this._discussionBusy = true;
      try {
        // 记录返回地址：讨论页发完评论后靠它回到刷课页（当前标签页打开时尤其必要）
        try { localStorage.setItem('omitone_return_url', String(location.href || '')); } catch (e1) {}
        // 先标记再打开：即使后面刷新/超时，也不会重复打开同一个讨论页
        this._markDiscussionDone(task.key);
        this._discussionOpenedAt = Date.now();

        var navigated = false;
        var href = String(task.url || task.href || '');
        if (href && href !== '#' && !/^javascript:/i.test(href)) {
          var absolute = href;
          try { absolute = new URL(href, location.href).href; } catch (e2) {}
          var opened = null;
          try { opened = window.open(absolute, '_blank'); } catch (e3) { opened = null; }
          if (opened) {
            this._discussionWindow = opened;
            navigated = true;
            emitRuntimeLog('info', 'discussion task opened in new tab', {
              name: String(task.name).slice(0, 40),
              url: String(absolute).slice(0, 120)
            });
          } else {
            // 弹窗被拦截：改成当前标签页打开，发完评论会自动返回
            emitRuntimeLog('info', 'discussion popup blocked, open in current tab', { name: String(task.name).slice(0, 40) });
            location.href = absolute;
            navigated = true;
          }
        } else if (task.el && typeof task.el.click === 'function') {
          emitRuntimeLog('info', 'discussion task entry clicked', { name: String(task.name).slice(0, 40) });
          task.el.click();
          navigated = true;
        }

        // ⚠️ 一个入口都没能打开时必须撤回"已完成"标记。
        // _markDiscussionDone 是**先于**打开动作写的（为了防止重复打开），
        // 但如果根本没有可用的入口，这条记录就把该任务点在 24 小时内静默跳过了 ——
        // 用户只会看到"这个讨论任务点没做"，而日志里什么异常都没有。
        if (!navigated) {
          this._unmarkDiscussionDone(task.key);
          this._discussionOpenedAt = 0;
          emitRuntimeLog('warn', 'discussion task has no usable entry, retry later', {
            name: String(task.name).slice(0, 40),
            hint: '未找到可点击入口或讨论区地址，已撤回完成标记，稍后会再试'
          });
          return false;
        }

        await sleep(1500);
        return true;
      } finally {
        this._discussionBusy = false;
      }
    },

    // 刷课页侧：讨论页处理期间暂停推进（避免跳到下一节），关闭或超时后恢复
    _handleDiscussionWait: function () {
      var win = this._discussionWindow;
      if (!win) return false;
      var closed = true;
      try { closed = !!win.closed; } catch (e0) { closed = true; }

      if (closed) {
        this._discussionWindow = null;
        this._discussionOpenedAt = 0;
        emitRuntimeLog('info', 'discussion finished, resuming study', {});
        this._refreshChapterAfterDiscussion();
        return true;
      }

      var waited = Date.now() - (this._discussionOpenedAt || 0);
      if (waited > (Number(this.configs.discussionTimeoutMs) || 90000)) {
        emitRuntimeLog('warn', 'discussion timeout, continue without waiting', { waitedSec: Math.round(waited / 1000) });
        try { win.close(); } catch (e1) {}
        this._discussionWindow = null;
        this._discussionOpenedAt = 0;
        return false;
      }
      return true; // 等待中：本轮不再做其它事
    },

    _refreshChapterAfterDiscussion: function () {
      var self = this;
      setTimeout(function () {
        try {
          var frame = self._getMainFrame();
          if (frame && frame.contentWindow) {
            frame.contentWindow.location.reload();
            return;
          }
        } catch (e0) {}
        try { location.reload(); } catch (e1) {}
      }, 2000);
    },

    // ---- 讨论页侧 ----

    _findDiscussionEditor: function () {
      // 精确优先：学习通讨论区（groupweb）的回复框
      try {
        var exact = document.querySelector(
          '.replyEdit textarea, textarea[placeholder*="回复"], .edit_main textarea, #subPageMain textarea'
        );
        if (exact && visible(exact) && (exact.clientHeight || 0) >= 20) return exact;
      } catch (eExact) {}

      var nodes = [];
      try { nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], iframe')); } catch (e0) { return null; }
      var best = null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.tagName === 'IFRAME') continue;
        if (!visible(el)) continue;
        var area = (el.clientWidth || 0) * (el.clientHeight || 0);
        if ((el.clientWidth || 0) < 80 || (el.clientHeight || 0) < 20) continue; // 太小的多为验证码/搜索框
        if (!best || area > best.area) best = { el: el, area: area };
      }
      if (best) return best.el;

      // 富文本编辑器（wangEditor 等）的真实输入区常藏在同源 iframe 里
      for (var k = 0; k < nodes.length; k++) {
        var frame = nodes[k];
        if (frame.tagName !== 'IFRAME') continue;
        var doc = this._safeDocOf(frame);
        if (!doc || !doc.body) continue;
        try {
          var editable = doc.body.getAttribute('contenteditable') === 'true'
            ? doc.body
            : doc.querySelector('[contenteditable="true"]');
          if (editable) return editable;
        } catch (e1) {}
      }
      return null;
    },

    // 回复框可能默认折叠，点"回复"把它展开（只点一次，避免反复触发）
    _expandDiscussionEditor: async function () {
      if (this._discussionExpanded) return;
      this._discussionExpanded = true;
      var opened = false;
      var sels = ['.replyBtn', '.topicDetail_title_right', '.edit_headTitle'];
      for (var i = 0; i < sels.length && !opened; i++) {
        var el = null;
        try { el = document.querySelector(sels[i]); } catch (e0) { continue; }
        if (!el || !visible(el)) continue;
        try { el.click(); opened = true; } catch (e1) {}
      }
      if (opened) {
        emitRuntimeLog('info', 'discussion editor collapsed, expanded it', {});
        await sleep(700);
      }
    },

    _findDiscussionSubmitButton: function () {
      // 精确优先：学习通讨论区的提交按钮（页面上还有别的"回复"，点错就发不出去）
      try {
        var exact = document.querySelector('.addReply, [class*="addReply"], .replyEditBtnGroup .jb_btn');
        if (exact && visible(exact)) return exact;
      } catch (eExact) {}

      var nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"], div[role="button"], span[role="button"]'
        ));
      } catch (e0) { return null; }
      var KEY = /发布|发表|提交|回复|发送|回帖/;
      var NEG = /取消|清空|重置|预览|表情|图片|附件|上传|草稿|保存/;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!visible(node)) continue;
        var text = String(textOf(node) || '').trim();
        if (!text || text.length > 12) continue;
        if (NEG.test(text)) continue;
        if (!KEY.test(text) && !KEY.test(String(node.getAttribute('value') || ''))) continue;
        return node;
      }
      return null;
    },

    _fillDiscussionEditor: function (editor, text) {
      var tag = String(editor.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') {
        var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(editor, text);
        else editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      try { editor.focus(); } catch (e0) {}
      editor.textContent = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    },

    // 记录提交前的回复状态，用于判断本次是否真的发出去了
    _discussionBaseline: function () {
      var info = { count: 0, text: '' };
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          info.count = list.querySelectorAll('.topicDetail_replyItem').length;
          info.text = String(list.innerText || '');
        }
      } catch (e0) {}
      return info;
    },

    _discussionSuccessHint: function () {
      var content = String(this.configs.discussionReply || '1').trim();
      var before = this._discussionBefore || { count: 0, text: '' };
      // 1) 回复列表里出现了新内容 / 新增了条目
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          var now = String(list.innerText || '');
          if (content && now.indexOf(content) >= 0 && String(before.text || '').indexOf(content) < 0) return true;
          if (list.querySelectorAll('.topicDetail_replyItem').length > Number(before.count || 0)) return true;
        }
      } catch (e1) {}
      // 2) 页面出现成功提示
      try {
        if (/发布成功|发表成功|提交成功|回复成功|评论成功|操作成功/.test(String(document.body.innerText || ''))) return true;
      } catch (e2) {}
      // 3) 编辑区被清空
      var editor = this._findDiscussionEditor();
      if (editor) {
        var value = String(editor.value !== undefined ? editor.value : editor.textContent || '').trim();
        if (value === '') return true;
      }
      return false;
    },

    _computeDiscussionPage: function () {
      var href = String(location.href || '').toLowerCase();
      var title = '';
      try { title = String(document.title || ''); } catch (e0) {}
      var urlHit = /discuss|discus|bbs|topic|thread|forum|reply|comment|talk|group/.test(href);
      var titleHit = /讨论|话题|回帖|发帖/.test(title);
      var bodyHit = false;
      try {
        bodyHit = /讨论|话题|回帖|发帖|发表回复|我的回复|发布话题/.test(String(document.body.innerText || '').slice(0, 3000));
      } catch (e1) {}
      // 从刷课页跳转过来的（留有返回地址）时放宽：页面文案命中即可，避免陌生网址结构认不出来
      var fromStudy = false;
      try { fromStudy = !!localStorage.getItem('omitone_return_url'); } catch (e2) {}
      if (!urlHit && !titleHit && !(fromStudy && bodyHit)) return false;
      // 必须是"有输入框 + 有发布按钮"的界面，避免在纯浏览的帖子列表页乱填
      return !!this._findDiscussionEditor() && !!this._findDiscussionSubmitButton();
    },

    _isDiscussionPage: function () {
      if (this.configs.enableDiscussion === false) return false;
      var now = Date.now();
      var href = String(location.href || '');
      if (this._discussionPageUrl !== href) {
        this._discussionPageUrl = href;
        this._discussionPageAt = 0;
        this._discussionPageResult = false;
      }
      if (now - (this._discussionPageAt || 0) < 2000) return this._discussionPageResult;
      this._discussionPageAt = now;
      this._discussionPageResult = !!this._computeDiscussionPage();
      return this._discussionPageResult;
    },

    _runDiscussionMode: async function () {
      if (this._discussionBusy) return;
      if (this._discussionPosted) return; // 每个页面只发一次，避免重复评论
      this._discussionBusy = true;
      emitRuntimeLog('info', 'discussion page detected, posting reply', { url: String(location.href || '').slice(0, 120) });
      try {
        var editor = this._findDiscussionEditor();
        if (!editor) {
          await this._expandDiscussionEditor();
          editor = this._findDiscussionEditor();
        }
        var button = this._findDiscussionSubmitButton();
        if (!editor || !button) {
          // 退路：本页只是"话题卡片"（需点卡片才进讨论区）→ 点开它
          if (!this._discussionCardOpened) {
            var card = null;
            try { card = document.querySelector('#topicMainDiv[data]'); } catch (eCard) {}
            if (card) {
              this._discussionCardOpened = true;
              emitRuntimeLog('info', 'discussion card found, opening topic page', {});
              try { card.click(); } catch (eCard2) {}
              await sleep(1500);
              return;
            }
          }
          emitRuntimeLog('warn', 'discussion editor or submit button missing', {
            hasEditor: !!editor, hasButton: !!button, url: String(location.href || '').slice(0, 110)
          });
          return; // 不锁定 _discussionPosted：下一轮再试，避免一次没找到就永久放弃
        }
        this._discussionPosted = true; // 找到控件后才锁定，确保每页只发一次
        this._discussionBefore = this._discussionBaseline();
        var content = String(this.configs.discussionReply || '1');
        this._fillDiscussionEditor(editor, content);
        await sleep(500);
        button.click();
        emitRuntimeLog('info', 'discussion reply submitted', {
          content: content.slice(0, 40),
          editor: String(editor.tagName || '') + (editor.id ? '#' + editor.id : ''),
          button: String(button.className || '').slice(0, 60),
          url: String(location.href || '').slice(0, 100)
        });

        // 等待提交结果（最多 10 秒）；未确认也继续返回——宁可少发一次，也不能卡住刷课
        var confirmed = false;
        for (var i = 0; i < 10; i++) {
          await sleep(1000);
          if (this._discussionSuccessHint()) {
            confirmed = true;
            emitRuntimeLog('info', 'discussion reply confirmed', {});
            break;
          }
        }
        if (!confirmed) emitRuntimeLog('warn', 'discussion reply not confirmed, resume anyway', {});

        await sleep(600);
        var returnUrl = '';
        try { returnUrl = localStorage.getItem('omitone_return_url') || ''; } catch (e0) {}

        try {
          if (window.opener && !window.opener.closed) {
            emitRuntimeLog('info', 'discussion done, closing this tab', {});
            window.close();
            return;
          }
        } catch (e1) {}

        if (history.length > 1) {
          emitRuntimeLog('info', 'discussion done, going back to study page', {});
          history.back();
          return;
        }
        if (returnUrl) {
          location.href = returnUrl;
          return;
        }
        emitRuntimeLog('info', 'discussion done, waiting for redirect', {});
      } catch (err) {
        emitRuntimeLog('error', 'discussion handling error', { message: String((err && err.message) || err).slice(0, 160) });
      } finally {
        this._discussionBusy = false;
      }
    },

    _isStandaloneCaptchaPage: function () {
      var now = Date.now();
      var href = String(location.href || '');
      if (this._standaloneCaptchaUrl !== href) {
        this._standaloneCaptchaUrl = href;
        this._standaloneCaptchaAt = 0;
        this._standaloneCaptchaResult = false;
      }
      if (now - (this._standaloneCaptchaAt || 0) < 1500) return this._standaloneCaptchaResult;
      this._standaloneCaptchaAt = now;
      this._standaloneCaptchaResult = this._computeStandaloneCaptchaPage();
      return this._standaloneCaptchaResult;
    },

    _runStandaloneCaptchaMode: async function () {
      if (this._captchaBusy) return;
      this._captchaBusy = true;
      emitRuntimeLog('warn', 'standalone captcha page detected, solving', { url: String(location.href || '').slice(0, 120) });
      try {
        if (this.configs.enableCaptcha === false) {
          emitRuntimeLog('info', 'captcha handling disabled by switch', {});
          return;
        }
        for (var attempt = 1; attempt <= 4; attempt++) {
          var captcha = this._detectStandaloneCaptcha();
          if (!captcha) {
            emitRuntimeLog('info', 'standalone captcha elements gone, nothing to solve', {});
            return;
          }
          var rec = await this._recognizeCaptchaImage(captcha.img);
          if (rec.ok) {
            this._fillCaptchaInput(captcha, rec.code);
            await sleep(300);
            this._clickCaptchaSubmit(captcha);
            emitRuntimeLog('info', 'standalone captcha code submitted', { attempt: attempt, length: rec.code.length });
          } else {
            emitRuntimeLog('error', 'captcha recognize failed', {
              attempt: attempt,
              error: String(rec.error || '').slice(0, 160)
            });
          }

          await sleep(2600);
          this._standaloneCaptchaAt = 0; // 强制重新判定，不受节流影响
          if (!this._isStandaloneCaptchaPage()) {
            emitRuntimeLog('info', 'standalone captcha solved', {});
            this._afterStandaloneCaptchaSolved();
            return;
          }
          try { captcha.img.click(); } catch (e2) {} // 识别错/过期就换一张
          await sleep(700);
        }
        emitRuntimeLog('warn', 'standalone captcha unsolved after retries, reload page', {});
        try { window.location.reload(); } catch (e3) {}
      } finally {
        this._captchaBusy = false;
      }
    },

    // 验证通过后：弹出窗口自动关闭；主标签页则回退，把位置让回学习通继续刷课
    _afterStandaloneCaptchaSolved: function () {
      try {
        if (window.opener && !window.opener.closed) {
          emitRuntimeLog('info', 'captcha popup solved, closing window', {});
          try { window.close(); return; } catch (e0) {}
        }
      } catch (e) {}
      try {
        if (history.length > 1) {
          emitRuntimeLog('info', 'captcha solved, going back to previous page', {});
          history.back();
          return;
        }
      } catch (e2) {}
      emitRuntimeLog('info', 'captcha solved, waiting for page redirect', {});
    },

    _handleCaptchaDialog: async function (captcha) {
      if (this._captchaBusy) return;
      this._captchaBusy = true;
      var attempts = this._captchaAttempts || 0;
      try {
        emitRuntimeLog('warn', 'captcha detected, recognizing', { attempt: attempts + 1, match: captcha.why || '' });
        console.log('%c[Omitone] captcha detected (' + (captcha.why || 'unknown') + '), recognizing...', 'color:#FF9800');

        var dataUrl = this._captureCaptchaImage(captcha.img);
        if (!dataUrl) {
          var absUrl = this._resolveImageUrl(captcha.img);
          if (absUrl) {
            var fetched = await bridgeSend('fetch_image', { url: absUrl });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = fetched.dataUrl;
          }
        }
        if (!dataUrl) {
          emitRuntimeLog('error', 'captcha image capture failed', {});
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        var result = await bridgeSend('llm_captcha', { image: dataUrl });
        if (!result || !result.success) {
          var errText = String((result && result.error) || '无响应').slice(0, 200);
          var hint = /API Key/i.test(errText) ? '（未配置 API Key：验证码识别独立于 AI 答题开关，只需在 popup 填好 API Key 和视觉模型）'
            : /image|multimodal|vision|not support|unsupported|400|415/i.test(errText) ? '（当前模型可能不支持图片输入：请在 popup 的"验证码识别模型"里填写视觉模型，如 gemini-2.5-flash / qwen-vl-max / gpt-4o-mini）'
            : '';
          emitRuntimeLog('error', 'captcha recognize failed', {
            error: errText,
            hint: hint
          });
          console.warn('[Omitone] captcha recognize failed:', errText, hint);
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        var code = this._cleanCaptchaCode(result.data);
        if (!code) {
          emitRuntimeLog('error', 'captcha code empty after clean', { raw: String(result.data || '').slice(0, 60) });
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        emitRuntimeLog('info', 'captcha code filled', { length: code.length });
        this._fillCaptchaInput(captcha, code);
        await sleep(400);
        this._clickCaptchaSubmit(captcha);

        await sleep(2500);
        var stillThere = this._checkCaptchaDialog();
        if (!stillThere) {
          emitRuntimeLog('info', 'captcha solved, continue', {});
          this._captchaAttempts = 0;
          this._captchaFailCount = 0;
          this._captchaActive = false;
          return;
        }
        this._captchaAttempts = attempts + 1;
        if (this._captchaAttempts >= 3) {
          this._captchaAttempts = 0;
          emitRuntimeLog('warn', 'captcha wrong too many times, reload page', {});
          this._captchaReload();
        } else {
          emitRuntimeLog('warn', 'captcha seems wrong, will retry with new image', { attempt: this._captchaAttempts });
          try { captcha.img.click(); } catch (e2) {}
        }
      } finally {
        this._captchaBusy = false;
      }
    },

    _backgroundCaptchaTick: function () {
      if (this._captchaBusy) return;
      var captcha = this._checkCaptchaDialog();
      if (captcha) {
        var self = this;
        this._handleCaptchaDialog(captcha).catch(function () {
          self._captchaBusy = false;
        });
      }
    },

    _checkVideoStatus: function () {
      try {
        var video = this._getVideoEl();
        if (!video) return;
        this._ensurePlaybackRate(video, 'guard');
        this._trySeekToEnd(video, 'guard');

        if (video.paused && this._isPlaying && !this._captchaActive) {
          this._tryResumePlayback('paused');
        } else if (this._isPlaying && !video.ended) {
          var now = Date.now();
          var current = Number(video.currentTime || 0);
          if (this._guardLastWallTs === 0) {
            this._guardLastWallTs = now;
            this._guardLastTime = current;
          } else {
            var stalled = Math.abs(current - this._guardLastTime) < 0.01;
            var stalledMs = now - this._guardLastWallTs;
            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
              this._tryResumePlayback('no-progress');
              this._guardLastWallTs = now;
              this._guardLastTime = Number(video.currentTime || 0);
            } else if (!stalled) {
              this._guardLastWallTs = now;
              this._guardLastTime = current;
            }
          }
        }

        // 防拖拽 + 倍速锁 1x 的视频：平台只要求 ≥90%，平台标记完成后就别再白等最后 10%
        if (!video.ended && this._isPlaying && this._shouldAdvanceAtNinetyPercent(video)) {
          this._finishCurrentMedia('ninety-percent');
          return;
        }

        if (video.ended && this._isPlaying) {
          this._finishCurrentMedia('guard');
        }
      } catch (e) {}
    },

    /**
     * 当前视频"播完了"的统一收尾。
     *
     * 两条路径共用：正常的 `ended`，以及「防拖拽 + 锁 1 倍速」的视频到 90% 且平台已标记完成。
     * 抽出来是为了不让两条路各写一份 —— 收尾漏掉一个字段（比如 `_activeMediaJobManaged`）
     * 会让状态机卡住，而症状是"这个任务点过了但下一个不动"，很难查。
     */
    _finishCurrentMedia: function (reason) {
      this._clearCheckInterval();
      if (this._activeMediaJobManaged) {
        this._isPlaying = false;
        this._activeMediaJobPending = false;
        this._activeMediaJobManaged = false;
        this._videoEl = null;
        this._videoCount = 0;
        this._currentVideoIndex = 0;
        this._mediaWaitLogAt = 0;
        emitRuntimeLog('info', 'managed media job ended', { reason: reason || 'guard', jobid: this._activeJobId || '' });
        return;
      }
      if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
        this._currentVideoIndex++;
        this._videoEl = null;
        this._activeMediaJobPending = true;
        this._mediaWaitLogAt = 0;
        return;
      }
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._mediaWaitLogAt = 0;
      this.nextUnit();
    },

    // 倍速是否被平台锁在 1 倍速。探测没结果（0）时一律当作"没锁定" ——
    // 宁可多播一会儿，也不要在没确认的情况下提前结束。
    _isRateLockedAtOne: function () {
      var rate = Number(this._detectedMaxRate);
      return isFinite(rate) && rate > 0 && rate <= 1.001;
    },

    /**
     * 「防拖拽 + 倍速锁 1x」的视频 —— 平台只要求观看时长 ≥ 总时长的 90%。
     *
     * 判据是两个"平台不让我们加速"的信号**同时**成立：
     *   1) 拖到结尾被播放器弹回（不可拖拽，见 _trySeekToEnd）
     *   2) 倍速探测结果就是 1x（老师把倍速也锁了）
     * 只满足一个都不算：能拖的视频早就拖到结尾了，能加速的视频也不该提前结束。
     */
    _isNinetyPercentVideo: function (video) {
      if (!video) return false;
      if (String(video.tagName || '').toLowerCase() !== 'video') return false; // 音频不适用
      if (!this._isRateLockedAtOne()) return false;
      var key = this._getMediaSeekKey(video);
      if (!key) return false;
      return !!(this._seekRevertedKeys && this._seekRevertedKeys[key]);
    },

    /**
     * 该不该在播到 90% 时提前收尾。
     *
     * 最关键的一条：**必须由平台自己给出"任务点已完成"的标记**。
     * 只按"播够 90% 就当作完成"会误跳过任务点，比多花十分钟严重得多 ——
     * 这与本仓库对"拿不准"的一贯取舍一致（见 `_isJobCompleted` 的说明）。
     */
    _shouldAdvanceAtNinetyPercent: function (video) {
      try {
        if (this.configs.advanceAtNinetyPercent === false) return false;
        if (!this._isNinetyPercentVideo(video)) return false;

        var duration = Number(video.duration);
        if (!isFinite(duration) || duration <= 0) return false;
        var ratio = Number(video.currentTime || 0) / duration;
        if (!(ratio >= 0.9)) return false;  // 还没到 90%
        if (ratio >= 0.995) return false;   // 已到结尾，交给 ended 那条路，避免两条路抢

        if (!this._isDocumentFrameFinished(video.ownerDocument)) return false; // 平台没确认完成就不动

        emitRuntimeLog('info', 'advance at 90% (locked 1x + not seekable)', {
          ratio: Number(ratio.toFixed(3)),
          duration: Number(duration.toFixed(1)),
          jobid: this._activeJobId || ''
        });
        console.log('%c[Omitone] 防拖拽+锁1x：已到 ' + (ratio * 100).toFixed(0) +
          '%，平台已标记完成，直接进下一个', 'color:#4CAF50');
        return true;
      } catch (e) {
        return false;
      }
    },

    _tryResumePlayback: function (reason) {
      var now = Date.now();
      if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;

      if (!this._resumeWindowStart || now - this._resumeWindowStart > this.configs.guardMaxResumeWindow) {
        this._resumeWindowStart = now;
        this._resumeAttemptCount = 0;
      }
      if (this._resumeAttemptCount >= this.configs.guardMaxResumes) return;

      this._resumeAttemptCount++;
      this._guardLastResumeTs = now;

      var video = this._getVideoEl();
      if (!video || !this._isPlaying) return;
      this._ensurePlaybackRate(video, reason || 'resume');
      video.play().catch(function () {
        video.muted = true;
        video.play().catch(function () {});
      });
    },

    _getLearningCards: function () {
      var cards = [];
      try {
        cards = Array.from(document.querySelectorAll([
          '#prev_tab .prev_ul li',
          '#prev_tab li[cardid]',
          '#prev_tab li[onclick*="changeDisplayContent"]',
          '.prev_list .prev_ul li',
          '.prev_list li[cardid]',
          '.prev_list li[onclick*="changeDisplayContent"]',
          '.prev_select_con li[cardid]',
          '.prev_select_con li[onclick*="changeDisplayContent"]',
          'li[id^="dct"][cardid]',
          'li[id^="dct"][onclick*="changeDisplayContent"]'
        ].join(',')));
      } catch (e) {}

      var seen = [];
      var self = this;
      return cards.filter(function (card) {
        if (!card || card.tagName !== 'LI') return false;
        if (seen.indexOf(card) !== -1) return false;
        seen.push(card);
        var marker = String((card.getAttribute && (card.getAttribute('cardid') || card.getAttribute('onclick') || card.id)) || '');
        var text = self._getLearningCardText(card);
        if (!marker && !/视频|测验|测试|作业|考试|答题|习题|讨论|资料|文档|阅读/.test(text)) return false;
        return true;
      });
    },

    _getLearningCardText: function (card) {
      if (!card) return '';
      return [
        textOf(card),
        card.getAttribute ? (card.getAttribute('title') || '') : '',
        card.getAttribute ? (card.getAttribute('aria-label') || '') : ''
      ].join(' ').replace(/\s+/g, '');
    },

    _getActiveLearningCardIndex: function (cards) {
      for (var i = 0; i < cards.length; i++) {
        var cls = String(cards[i].className || '');
        if (/\bactive\b/.test(cls)) return i;
        if (cards[i].getAttribute && String(cards[i].getAttribute('aria-selected') || '') === 'true') return i;
        if (cards[i].querySelector && cards[i].querySelector('.active, .on, .current, [aria-selected="true"]')) return i;
      }

      var currentType = this._getCurrentVisibleLearningTaskType();
      if (currentType) {
        for (var j = 0; j < cards.length; j++) {
          var text = this._getLearningCardText(cards[j]);
          if (currentType === 'video' && /视频|学习视频/.test(text)) return j;
          if (currentType === 'quiz' && this._isAssessmentLearningCard(cards[j])) return j;
        }
      }
      return -1;
    },

    _getCurrentVisibleLearningTaskType: function () {
      try {
        var tasks = this._collectVisibleTaskFrames();
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i] && !tasks[i].finished && tasks[i].type) return tasks[i].type;
        }
        for (var j = 0; j < tasks.length; j++) {
          if (tasks[j] && tasks[j].type) return tasks[j].type;
        }
      } catch (e) {}

      var video = this._getVideoEl();
      if (video) return 'video';
      if (this._detectQuiz()) return 'quiz';
      return '';
    },

    _isAssessmentLearningCard: function (card) {
      var text = this._getLearningCardText(card);
      return /测验|测试|作业|考试|答题|习题/.test(text);
    },

    _looksLikeVideoLearningCard: function (card) {
      return /视频|学习视频/.test(this._getLearningCardText(card));
    },

    _findFallbackNextLearningCardIndex: function (cards) {
      if (!cards || cards.length <= 1) return -1;

      var videoIndex = -1;
      for (var i = 0; i < cards.length; i++) {
        if (videoIndex < 0 && this._looksLikeVideoLearningCard(cards[i])) videoIndex = i;
        if (this._isAssessmentLearningCard(cards[i])) {
          if (videoIndex >= 0 && i > videoIndex) return i;
        }
      }

      var currentTitle = this._getCurrentTitle();
      if (!/测验|测试|作业|考试|答题|习题/.test(currentTitle)) {
        for (var j = 0; j < cards.length; j++) {
          if (this._isAssessmentLearningCard(cards[j])) return j;
        }
      }
      return -1;
    },

    _switchToNextLearningCard: function (reason) {
      var cards = this._getLearningCards();
      if (cards.length <= 1) return false;

      var activeIndex = this._getActiveLearningCardIndex(cards);
      var targetIndex = activeIndex >= 0 && activeIndex < cards.length - 1 ? activeIndex + 1 : this._findFallbackNextLearningCardIndex(cards);
      if (targetIndex < 0 || targetIndex >= cards.length) return false;
      if (activeIndex >= 0 && targetIndex === activeIndex) return false;

      var now = Date.now();
      if (this._lastLearningTabSwitchAt && now - this._lastLearningTabSwitchAt < Number(this.configs.stepSwitchGraceMs || 7000)) {
        return true;
      }

      var nextCard = cards[targetIndex];
      if (!nextCard) return false;

      this._lastLearningTabSwitchAt = now;
      this._clearMediaPendingState('switch-learning-card');

      try {
        var clickTarget = nextCard.querySelector ? (nextCard.querySelector('.prev_white, a, [role="option"], [role="button"]') || nextCard) : nextCard;
        try { clickTarget.click(); } catch (clickErr) { nextCard.click(); }
        emitRuntimeLog('info', 'switch learning card before next unit', {
          reason: reason || '',
          from: activeIndex + 1,
          to: targetIndex + 1,
          text: this._getLearningCardText(nextCard)
        });
      } catch (e) {
        return false;
      }

      this._resetRuntimeState();
      this._lastLearningTabSwitchAt = now;
      this._stepSwitchPending = true;
      this._stepSwitchAt = now;

      var self = this;
      setTimeout(function () {
        try {
          self._initCellData();
          self.play();
        } catch (e2) {}
      }, Number(this.configs.stepSwitchInitDelayMs || 2200));

      return true;
    },

    nextUnit: function () {
      if (!this._assertActive()) return;
      if (!this.configs.autoNext) return;
      if (this._isActiveMediaPending('next-unit')) return;
      if (!this._isQuizForceSkipping() && this._shouldHoldQuizBeforeNext('next-unit')) return;
      if (this._switchToNextLearningCard('next-unit')) return;
      this._dismissPopups();
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) nextButton.click();
      } catch (e) {}
      this._resetRuntimeState();
    },

    _advanceLearningStep: function () {
      if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < Number(this.configs.stepSwitchGraceMs || 7000)) return true;
      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1 || title === '视频') return false;
      var cards = this._getLearningCards();
      var activeIndex = this._getActiveLearningCardIndex(cards);
      if (activeIndex > 0) return false;
      if (activeIndex >= 0 && this._isAssessmentLearningCard(cards[activeIndex])) return false;
      var tabs = Array.from(document.querySelectorAll('.prev_white'));
      for (var i = 0; i < tabs.length; i++) {
        if (!visible(tabs[i])) continue;
        var tabText = textOf(tabs[i]).replace(/\s+/g, '');
        if (tabText === '2视频' || tabText === '视频') {
          this._stepSwitchPending = true;
          this._stepSwitchAt = Date.now();
          tabs[i].click();
          return true;
        }
      }
      return false;
    },

    _bindStepNavigation: function () {
      if (this._stepNavigationBound) return;
      this._stepNavigationBound = true;

      document.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target.closest([
          '.prev_white',
          '#prev_tab .prev_ul li',
          '#prev_tab li[cardid]',
          '.prev_list li[cardid]',
          '.prev_select_con li[cardid]',
          'li[id^="dct"][cardid]'
        ].join(',')) : null;
        if (!target) return;
        var text = textOf(target).replace(/\s+/g, '');
        if (!/视频|测验|测试|作业|考试|答题|习题|讨论|资料|文档|阅读/.test(text)) return;
        app._resetRuntimeState();
        app._stepSwitchPending = true;
        app._stepSwitchAt = Date.now();
        setTimeout(function () {
          try {
            app._initCellData();
          } catch (e) {}
          app.play();
        }, Number(app.configs.stepSwitchInitDelayMs || 2200));
      });
    },

    _initCellData: function () {
      var tree = this._getTreeContainer();
      var rootUl = tree ? (tree.querySelector(':scope > ul') || tree.querySelector('ul')) : null;
      var cells = rootUl ? Array.from(rootUl.children).filter(function (node) { return node.tagName === 'LI'; }) : [];
      this._cellData.cells = cells.length;
      this._cellData.nCells = 0;
      this._cellData.currentCellIndex = 0;
      this._cellData.currentNCellIndex = 0;
      this._cellData.currentVideoTitle = '';

      for (var i = 0; i < cells.length; i++) {
        var nCells = Array.from(cells[i].querySelectorAll('.posCatalog_select:not(.firstLayer)'));
        this._cellData.nCells += nCells.length;
        for (var j = 0; j < nCells.length; j++) {
          if (nCells[j].classList.contains('posCatalog_active')) {
            this._cellData.currentCellIndex = i;
            this._cellData.currentNCellIndex = j;
            var titleSpan = nCells[j].querySelector('.posCatalog_name');
            this._cellData.currentVideoTitle = titleSpan ? (titleSpan.getAttribute('title') || textOf(titleSpan)) : '';
          }
        }
      }
    },

    _getTreeContainer: function () {
      if (!this._treeContainerEl) {
        this._treeContainerEl = document.querySelector('#coursetree');
      }
      return this._treeContainerEl;
    },

    _getVideoEl: function (index) {
      var idx = typeof index === 'number' ? index : this._currentVideoIndex;
      var self = this;
      if (!this._videoEl) {
        function findVideos(doc, depth) {
          if (!doc || depth > 4) return { visible: [], hiddenAudio: [] };
          var all = Array.from(doc.querySelectorAll('video, audio'));
          var vis = all.filter(self._isVisibleMedia);
          var hiddenAudio = all.filter(function (media) {
            return String(media.tagName || '').toLowerCase() === 'audio' && !self._isVisibleMedia(media);
          });
          var frames = Array.from(doc.querySelectorAll('iframe'));
          for (var i = 0; i < frames.length; i++) {
            try {
              var subDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
              var sub = findVideos(subDoc, depth + 1);
              vis = vis.concat(sub.visible);
              hiddenAudio = hiddenAudio.concat(sub.hiddenAudio);
            } catch (e) {}
          }
          return { visible: vis, hiddenAudio: hiddenAudio };
        }

        try {
          var doc = this._getMainDocument();
          var found = doc ? findVideos(doc, 0) : findVideos(document, 0);
          // 优先可见媒体，其次隐藏的音频（音频任务点常把 <audio> 藏起来）
          var allVideos = found.visible.length ? found.visible : found.hiddenAudio;
          if (allVideos.length === 0) return null;
          this._videoCount = allVideos.length;
          this._videoEl = allVideos[Math.min(idx, allVideos.length - 1)];
        } catch (e2) {
          return null;
        }
      }
      return this._videoEl;
    },

    _videoEventHandle: function () {
      var el = this._videoEl;
      if (!el) return;

      try {
        if (this._onVideoEnded) el.removeEventListener('ended', this._onVideoEnded);
        if (this._onVideoLoaded) el.removeEventListener('loadedmetadata', this._onVideoLoaded);
        if (this._onVideoPlay) el.removeEventListener('play', this._onVideoPlay);
        if (this._onVideoPause) el.removeEventListener('pause', this._onVideoPause);
        if (this._onVideoRateChange) el.removeEventListener('ratechange', this._onVideoRateChange);
        if (this._onVideoError) el.removeEventListener('error', this._onVideoError);
      } catch (e) {}

      this._onVideoEnded = this._handleVideoEnded.bind(this);
      this._onVideoLoaded = this._handleVideoLoaded.bind(this);
      this._onVideoPlay = this._handleVideoPlay.bind(this);
      this._onVideoPause = this._handleVideoPause.bind(this);
      this._onVideoRateChange = this._handleVideoRateChange.bind(this);
      this._onVideoError = this._handleMediaError.bind(this);

      el.addEventListener('ended', this._onVideoEnded);
      el.addEventListener('loadedmetadata', this._onVideoLoaded);
      el.addEventListener('play', this._onVideoPlay);
      el.addEventListener('pause', this._onVideoPause);
      el.addEventListener('ratechange', this._onVideoRateChange);
      el.addEventListener('error', this._onVideoError);
    },

    // 媒体元素报错（1 中止 / 2 网络 / 3 解码失败 / 4 格式或 MIME 不支持）
    // 之前完全没有这个监听，m4a 之类的格式问题永远不会被发现
    _handleMediaError: function (event) {
      var el = event && event.target ? event.target : this._getVideoEl();
      if (!el) return;
      var code = el.error ? el.error.code : 0;
      var message = el.error ? String(el.error.message || '') : '';
      var src = String(el.currentSrc || el.src || '');
      emitRuntimeLog('error', 'media error', {
        code: code,
        message: message.slice(0, 120),
        src: src.slice(-80),
        tag: String(el.tagName || '').toLowerCase()
      });

      // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED（m4a、服务器 MIME 不对最常见），3 = 解码失败
      if (code === 4 || code === 3) {
        var self = this;
        this._maybeRepairMediaSource(el).then(function (ok) {
          emitRuntimeLog(ok ? 'info' : 'error', ok ? 'media source repaired (m4a/mime fallback), replaying' : 'media source repair failed', {
            src: src.slice(-80)
          });
        }).catch(function () {});
      }
    },

    _guessMediaMime: function (url) {
      var u = String(url || '').toLowerCase().split('?')[0];
      if (/\.m3u8$/.test(u)) return '';
      if (/\.m4a$|\.aac$/.test(u)) return 'audio/mp4';
      if (/\.mp3$/.test(u)) return 'audio/mpeg';
      if (/\.ogg$|\.oga$/.test(u)) return 'audio/ogg';
      if (/\.wav$/.test(u)) return 'audio/wav';
      if (/\.webm$/.test(u)) return 'audio/webm';
      if (/\.mp4$|\.m4v$/.test(u)) return 'video/mp4';
      return 'audio/mp4'; // 学习通音频多为 m4a（AAC）
    },

    // 音源不受支持时的兜底：把音频文件取回来，用正确的 MIME 重新封装成 Blob 再播。
    // 全程在页面内完成（不经过扩展消息），避免大文件传输。
    _maybeRepairMediaSource: async function (media) {
      try {
        if (!media) return false;
        var src = String(media.currentSrc || media.src || '');
        if (!src || /^blob:/i.test(src)) return false;
        if (/\.m3u8/i.test(src)) return false; // HLS 由播放器自己处理，不能这样补救

        if (!this._mediaRepaired) this._mediaRepaired = Object.create(null);
        if (this._mediaRepaired[src]) return false;
        this._mediaRepaired[src] = true; // 每个源只补救一次，避免死循环

        var response = await fetch(src, { credentials: 'include' });
        if (!response || !response.ok) return false;
        var buf = await response.arrayBuffer();
        if (!buf || buf.byteLength < 1024) return false;

        var type = this._guessMediaMime(src);
        var blob = new Blob([buf], { type: type });
        var objectUrl = URL.createObjectURL(blob);
        var resumeAt = Number(media.currentTime || 0);

        media.src = objectUrl;
        media.load();
        await new Promise(function (resolve) {
          var done = false;
          var finish = function () {
            if (!done) { done = true; resolve(); }
          };
          media.addEventListener('canplay', finish, { once: true });
          media.addEventListener('error', finish, { once: true });
          setTimeout(finish, 8000);
        });

        if (resumeAt > 0) {
          try { media.currentTime = resumeAt; } catch (e0) {}
        }
        this._ensurePlaybackRate(media, 'repair');
        await this._withTimeout(media.play(), 12000);
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * `ended` 事件的处理。收尾逻辑与 `_checkVideoStatus` 那条路**完全一致**，
     * 所以统一走 `_finishCurrentMedia`。
     *
     * 这里原本多清了三个字段（`_activeDocumentJobPending` / `_activeDocumentJobManaged` /
     * `_activeDocumentJobDoc`），已经确认那是**过界的**，理由有三条：
     *   1) `nextUnit()` 末尾会调 `_resetRuntimeState()`，那些字段本来就会被清掉 ——
     *      正常路径下多清一次是纯冗余；
     *   2) 只有在 `nextUnit()` **提前返回**时（典型是 `autoNext:false`）才有差别，
     *      而那时清掉它们等于**放弃一个可能正在进行的文档任务点** —— 正是本仓库
     *      最怕的"静默漏做"。不清才是对的；
     *   3) 对称：文档任务点完成时（约 2607 行）只清文档自己的状态，不去动媒体状态。
     *      媒体这边同理，只管媒体。
     * 万一真的残留了过期的文档状态，文档那条路自己有 `document stuck timeout` 会兜住。
     */
    _handleVideoEnded: function () {
      this._finishCurrentMedia('event');
    },

    _handleVideoLoaded: function (event) {
      this._resetRateDetection();
      var loadedVideo = event && event.target ? event.target : this._getVideoEl();
      this._ensurePlaybackRate(loadedVideo, 'loadedmetadata');
      this._trySeekToEnd(loadedVideo, 'loadedmetadata');
    },

    _handleVideoPlay: function () {
      this._isPlaying = true;
      this._stepSwitchPending = false;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      this._syncAudioKeepalive();
      var video = this._getVideoEl();
      this._ensurePlaybackRate(video, 'play');
      this._guardLastTime = Number((video && video.currentTime) || 0);
      this._guardLastWallTs = Date.now();
      if (this._delayedNextUnitTimer) {
        clearTimeout(this._delayedNextUnitTimer);
        this._delayedNextUnitTimer = null;
      }
    },

    _handleVideoPause: function (event) {
      // pause 事件的派发不受后台定时器节流影响：视频被网站/浏览器在后台暂停时立即安排恢复
      var video = event && event.target ? event.target : this._getVideoEl();
      if (!video || video.ended || !this._isPlaying) return;
      if (this._rateProbing) return;
      if (this._pauseResumePending) return;

      var self = this;
      this._pauseResumePending = true;
      this._workerDelay(function () {
        self._pauseResumePending = false;
        var current = self._getVideoEl() || video;
        if (!current || current.ended || !self._isPlaying || !current.paused) return;
        // 验证码/弹窗题/提交确认弹窗打开期间视频是被有意暂停的，不要抢恢复
        try {
          if (self._captchaActive || self._checkCaptchaDialog()) return;
          // 同理走 _activePopupBlock：弹题已经放弃过了就别再挡着恢复播放
          if (self._activePopupBlock && self._activePopupBlock()) return;
          if (self._checkSubmitConfirmDialog && self._checkSubmitConfirmDialog()) return;
        } catch (e) {}
        var duration = Number(current.duration || 0);
        if (duration && Number(current.currentTime || 0) >= duration - 0.5) return;

        emitRuntimeLog('warn', 'video paused unexpectedly, resuming (anti background pause)', {
          hidden: !!(document.hidden || document.visibilityState === 'hidden'),
          time: Math.round(Number(current.currentTime || 0))
        });
        var resumed = current.play();
        if (resumed && typeof resumed.then === 'function') {
          resumed.then(function () {
            self._ensurePlaybackRate(current, 'pause-resume');
          }).catch(function () {
            try {
              current.muted = true;
              current.play().catch(function () {});
            } catch (e1) {}
          });
        }
      }, 600);
    },

    _handleVideoRateChange: function (event) {
      this._ensurePlaybackRate(event && event.target ? event.target : this._getVideoEl(), 'ratechange');
    },

    _walkDocuments: function (visitor, startDoc, depth) {
      var doc = startDoc || document;
      var level = typeof depth === 'number' ? depth : 0;
      if (!doc || level > 4) return false;
      if (visitor(doc)) return true;

      var iframes = [];
      try {
        iframes = doc.querySelectorAll('iframe');
      } catch (e) {}

      for (var i = 0; i < iframes.length; i++) {
        try {
          var subDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
          if (this._walkDocuments(visitor, subDoc, level + 1)) return true;
        } catch (e2) {}
      }
      return false;
    },

    _detectQuiz: function () {
      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1 || title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1) {
        // 标题命中只是快路径，必须有「真的在测验页面」的佐证才能算数：
        // 顶层地址 / 主 iframe / 主 iframe 内嵌 iframe 的地址里存在 work/exam 页面。
        // 没有佐证就直接放过——否则课程目录里名为「课程考试」的章节（本身 0 任务点、
        // 树节点已标完成）会被误判成"有测验"：完成检查被否决 → 永不跳过 →
        // study 循环每 5 秒空转，反复报 "quiz scan found 0 questions"（真实页面实测的坑）。
        var hrefs = [String(location.href || '')];
        try { hrefs.push(String((this._getMainFrame() || {}).src || '')); } catch (eFrame) {}
        try {
          var mainDoc = this._getMainDocument();
          if (mainDoc) {
            Array.from(mainDoc.querySelectorAll('iframe')).forEach(function (fr) {
              hrefs.push(String(fr.getAttribute('src') || ''));
            });
          }
        } catch (eDoc) {}
        var onWorkPage = hrefs.some(function (u) {
          return /ananas\/modules\/work|api\/work|work\/do(Home)?Work|exam\/test|testpaper|reVersionTestStartNew|selectWorkQuestion/i.test(u);
        });
        if (onWorkPage) return true;
      }
      var selectors = ['.TiMu', '.questionLi', '.questionItem', '.tiBank', '.topicItem', '.exam_question', '.question-content', '.singleQues', '.mark_item', '.questionBox', '.answerOption'];
      var tasks = this._collectVisibleTaskFrames();
      if (tasks.some(function (task) { return task.type === 'quiz' && !task.finished; })) return true;

      return this._walkDocuments(function (doc2) {
        for (var i = 0; i < selectors.length; i++) {
          var nodes = Array.from(doc2.querySelectorAll(selectors[i]));
          for (var j = 0; j < nodes.length; j++) {
            if (visible(nodes[j]) && textOf(nodes[j]).length > 0) return true;
          }
        }
        return false;
      });
    },

    _skipQuiz: function () {
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this.nextUnit();
    },

    _getQuizFieldValue: function (doc, id) {
      try {
        var el = doc && doc.getElementById ? doc.getElementById(id) : null;
        return el ? String(el.value || el.getAttribute('value') || '').trim() : '';
      } catch (e) {
        return '';
      }
    },

    _getQuizWorkKey: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument() || document;
      var parts = [
        this._getQuizFieldValue(doc, 'courseId'),
        this._getQuizFieldValue(doc, 'classId'),
        this._getQuizFieldValue(doc, 'workRelationId') || this._getQuizFieldValue(doc, 'workId') || this._getQuizFieldValue(doc, 'oldWorkId'),
        this._getQuizFieldValue(doc, 'jobid'),
        this._getQuizFieldValue(doc, 'knowledgeid') || this._getCurrentChapterId()
      ].join('|');
      if (!parts.replace(/\|/g, '')) parts = location.href + '|' + this._getCurrentChapterId();
      return 'omitone.quiz.correct.' + encodeURIComponent(parts).slice(0, 180);
    },

    _getQuizSubmitAttemptKey: function (preferredDoc) {
      return this._getQuizWorkKey(preferredDoc) + '.submitAttempts';
    },

    _getQuizMaxSubmitAttempts: function () {
      var max = Number(this.configs.quizMaxSubmitAttempts || 20);
      return max > 0 ? max : 20;
    },

    _getQuizApiUnavailableReason: function () {
      if (!this.configs.enableQuiz) return 'api-disabled';
      if (!String(this.configs.apiKey || '').trim()) return 'api-key-missing';
      if (Date.now() < (this._quizApiFailUntil || 0)) return 'api-connection-failed';
      return '';
    },

    _isQuizApiUnavailable: function () {
      return !!this._getQuizApiUnavailableReason();
    },

    _resetQuizStateForSkip: function () {
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizSubmitLogAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      // 换任务了，上一道弹题的失败记录不该带过来
      this._popupQuizKey = '';
      this._popupQuizAttempts = 0;
      this._popupQuizBlockedUntil = 0;
      // 换卷了，前缀缓存的"刚发过整批"记录也失效
      this._quizBatchSentKey = '';
      this._quizBatchSentAt = 0;
    },

    _markQuizApiConnectionFailed: function (error) {
      var message = error && error.message ? error.message : String(error || 'LLM 请求失败');
      // 不再永久写入 storage：改为 45 秒退避，期间跳过答题，之后自动重试并自愈
      this._quizApiFailUntil = Date.now() + 45000;
      this._quizApiLastError = String(message).slice(0, 300);
      emitRuntimeLog('warn', 'api connection failed, skip quiz', { error: message.slice(0, 200), retryInMs: 45000 });
    },

    _skipQuizForApiUnavailable: function (reason, preferredDoc) {
      var skipReason = reason || this._getQuizApiUnavailableReason() || 'api-unavailable';
      this._quizForceSkipUntil = Date.now() + 15000;
      this._resetQuizStateForSkip();
      var now = Date.now();
      if (!this._quizApiSkipLogAt || now - this._quizApiSkipLogAt > 3000) {
        this._quizApiSkipLogAt = now;
        emitRuntimeLog('warn', 'skip quiz because api unavailable', {
          reason: skipReason,
          error: String(this._quizApiLastError || this.configs.apiConnectionError || '').slice(0, 160)
        });
      }
      if (this._switchToNextLearningCard(skipReason)) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          this._quizForceSkipUntil = Date.now() + 15000;
          return true;
        }
      } catch (e) {}
      if (this.configs.autoNext) this.nextUnit();
      return true;
    },

    _getQuizSubmitAttemptCount: function (preferredDoc) {
      try {
        return Number(sessionStorage.getItem(this._getQuizSubmitAttemptKey(preferredDoc)) || 0) || 0;
      } catch (e) {
        return 0;
      }
    },

    _setQuizSubmitAttemptCount: function (preferredDoc, count) {
      try {
        sessionStorage.setItem(this._getQuizSubmitAttemptKey(preferredDoc), String(Math.max(0, count || 0)));
      } catch (e) {}
    },

    _clearQuizSubmitAttemptCount: function (preferredDoc) {
      try {
        sessionStorage.removeItem(this._getQuizSubmitAttemptKey(preferredDoc));
      } catch (e) {}
    },

    _incrementQuizSubmitAttemptCount: function (preferredDoc) {
      var count = this._getQuizSubmitAttemptCount(preferredDoc) + 1;
      this._setQuizSubmitAttemptCount(preferredDoc, count);
      emitRuntimeLog('info', 'quiz submit attempt count', { count: count, max: this._getQuizMaxSubmitAttempts() });
      return count;
    },

    _shouldSkipQuizBySubmitAttempts: function (preferredDoc) {
      return this._getQuizSubmitAttemptCount(preferredDoc) >= this._getQuizMaxSubmitAttempts();
    },

    _isQuizForceSkipping: function () {
      return this._quizForceSkipUntil && Date.now() < this._quizForceSkipUntil;
    },

    _forceSkipQuizAfterMaxAttempts: function (preferredDoc) {
      var count = this._getQuizSubmitAttemptCount(preferredDoc);
      var max = this._getQuizMaxSubmitAttempts();
      this._quizForceSkipUntil = Date.now() + 15000;
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      emitRuntimeLog('warn', 'skip quiz after max submit attempts', { count: count, max: max });

      if (this._switchToNextLearningCard('quiz-max-submit-attempts')) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          this._quizForceSkipUntil = Date.now() + 15000;
          return true;
        }
      } catch (e) {}
      this.nextUnit();
      return true;
    },

    _loadQuizCorrectAnswerCache: function (preferredDoc) {
      var key = this._getQuizWorkKey(preferredDoc);
      if (!this._quizCorrectAnswerCache) this._quizCorrectAnswerCache = {};
      if (!this._quizCorrectAnswerCache[key]) {
        var cached = null;
        try {
          cached = JSON.parse(sessionStorage.getItem(key) || 'null');
        } catch (e) {}
        if (!cached || typeof cached !== 'object') cached = {};
        if (!cached.byId || typeof cached.byId !== 'object') cached.byId = {};
        if (!cached.byTitle || typeof cached.byTitle !== 'object') cached.byTitle = {};
        if (!cached.wrongById || typeof cached.wrongById !== 'object') cached.wrongById = {};
        if (!cached.wrongByTitle || typeof cached.wrongByTitle !== 'object') cached.wrongByTitle = {};
        if (!cached.submittedById || typeof cached.submittedById !== 'object') cached.submittedById = {};
        if (!cached.submittedByTitle || typeof cached.submittedByTitle !== 'object') cached.submittedByTitle = {};
        this._quizCorrectAnswerCache[key] = cached;
      }
      return { key: key, data: this._quizCorrectAnswerCache[key] };
    },

    _saveQuizCorrectAnswerCache: function (preferredDoc, data) {
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc);
      var cache = data || loaded.data;
      this._quizCorrectAnswerCache[loaded.key] = cache;
      try {
        sessionStorage.setItem(loaded.key, JSON.stringify(cache));
      } catch (e) {}
    },

    _findQuizAnswerInput: function (el, qid) {
      var doc = (el && el.ownerDocument) || document;
      if (qid && doc.getElementById) {
        var byId = doc.getElementById('answer' + qid);
        if (byId) return byId;
      }
      if (!el || !el.querySelectorAll) return null;
      var inputs = Array.from(el.querySelectorAll('input[type="hidden"], input[id^="answer"], textarea[id^="answer"]'));
      for (var i = 0; i < inputs.length; i++) {
        var id = String(inputs[i].id || inputs[i].name || '');
        if (/^answer\d+/.test(id) && id !== 'answerwqbid') return inputs[i];
      }
      return null;
    },

    _getQuestionIdFromElement: function (el) {
      if (!el) return '';
      try {
        var qid = String((el.getAttribute && (el.getAttribute('qid') || el.getAttribute('data-qid'))) || '').trim();
        if (qid) return qid;

        var wrapper = el.closest ? el.closest('.singleQuesId') : null;
        qid = wrapper && wrapper.getAttribute ? String(wrapper.getAttribute('data') || '').trim() : '';
        if (qid) return qid;

        var hidden = this._findQuizAnswerInput(el, '');
        var id = hidden ? String(hidden.id || hidden.name || '') : '';
        var match = id.match(/^answer(\d+)/);
        if (match) return match[1];

        var badge = el.querySelector ? el.querySelector('.num_option, .num_option_dx') : null;
        var name = badge ? String(badge.getAttribute('name') || '') : '';
        match = name.match(/answer(?:check)?(\d+)/);
        if (match) return match[1];
      } catch (e) {}
      return '';
    },

    _mapQuizTypeValue: function (value) {
      var type = String(value || '').trim();
      if (type === '1') return 'multiple';
      if (type === '3') return 'judge';
      if (type === '2' || type === '9' || type === '10' || type === '14') return 'fill';
      if (type === '4' || type === '5' || type === '6' || type === '7' || type === '8' || type === '17' || type === '18' || type === '26') return 'short';
      return 'single';
    },

    _getQuestionTypeFromElement: function (el, qid) {
      var doc = (el && el.ownerDocument) || document;
      try {
        var typeEl = qid && doc.getElementById ? doc.getElementById('answertype' + qid) : null;
        if (!typeEl && el && el.querySelector) typeEl = el.querySelector('input[id^="answertype"], input[name^="answertype"]');
        return this._mapQuizTypeValue(typeEl ? (typeEl.value || typeEl.getAttribute('value')) : '');
      } catch (e) {
        return 'single';
      }
    },

    _normalizeQuizTitleKey: function (text) {
      return String(text || '')
        .replace(/【[^】]*题】/g, '')
        .replace(/^\d+[.、．\s]+/, '')
        .replace(/\s+/g, '')
        .slice(0, 160);
    },

    _getQuizTitleKeyFromElement: function (el, fallbackTitle) {
      var title = fallbackTitle || '';
      if (!title && el && el.querySelector) {
        var titleEl = el.querySelector('.fontLabel, .mark_name, .question-title, .topicTitle, .question_content, .qContent, .mark_title, .question-name, .title, h3, h4, .stem');
        title = this._cleanQuestionTitle(titleEl ? textOf(titleEl) : '');
      }
      // 与 _parseQuestionElement 同源：只装题号的标题元素会清洗成空串，
      // 此时必须退回整块文本，否则缓存键退化成空、答案缓存全部失效
      if (!title) title = this._cleanQuestionTitle(textOf(el).slice(0, 220));
      return this._normalizeQuizTitleKey(title);
    },

    _getQuizAnswerValue: function (el, qid) {
      var input = this._findQuizAnswerInput(el, qid || this._getQuestionIdFromElement(el));
      return input ? String(input.value || input.getAttribute('value') || '').trim() : '';
    },

    _canonicalQuizAnswer: function (answer, type) {
      var value = this._normalizeAnswerValue(answer);
      if (Array.isArray(value)) value = value.join('');
      var raw = String(value || '').trim();
      if (!raw) return '';

      var judgeAny = this._normalizeJudgeAnswerValue(raw);
      if ((judgeAny === 'true' || judgeAny === 'false') && /^(true|false|yes|no|y|n|1|0|正确|對|对|是|错误|錯|错|否|不正确)/i.test(raw.replace(/\s+/g, ''))) {
        return judgeAny;
      }

      if (type === 'judge') {
        if (judgeAny === 'true' || judgeAny === 'false') return judgeAny;
      }

      if (type === 'multiple') {
        return raw
          .replace(/[，、;；\s]+/g, ',')
          .split(',')
          .join('')
          .toUpperCase()
          .split('')
          .filter(function (item, index, arr) { return /^[A-Z]$/.test(item) && arr.indexOf(item) === index; })
          .sort()
          .join('');
      }

      return raw.toUpperCase();
    },

    _getOptionStoredAnswerValue: function (item) {
      if (!item || !item.querySelector) return '';
      var badge = item.querySelector('.num_option, .num_option_dx');
      if (!badge) return '';
      return String(badge.getAttribute('data') || textOf(badge) || '').trim();
    },

    _canonicalQuizAnswerForQuestion: function (answer, type, question) {
      var canonical = this._canonicalQuizAnswer(answer, type);
      if (!canonical || type !== 'judge' || (canonical !== 'A' && canonical !== 'B')) return canonical;
      if (!question || !question._element) return canonical;

      var item = this._matchOptionItem(question._element, answer);
      var stored = this._getOptionStoredAnswerValue(item);
      var normalized = this._normalizeJudgeAnswerValue(stored || this._extractOptionText(item));
      if (normalized === 'true' || normalized === 'false') return normalized;
      return canonical;
    },

    _addWrongQuizAnswer: function (cache, item) {
      if (!cache || !item || !item.answer) return false;
      if (!cache.wrongById) cache.wrongById = {};
      if (!cache.wrongByTitle) cache.wrongByTitle = {};

      var canonical = item.canonical || this._canonicalQuizAnswer(item.answer, item.type);
      if (!canonical) return false;

      var stored = {
        qid: item.qid || '',
        answer: item.answer,
        canonical: canonical,
        type: item.type || 'single',
        titleKey: item.titleKey || '',
        at: Date.now()
      };
      var changed = false;

      function addToBucket(bucket, key) {
        if (!key) return;
        if (!bucket[key]) bucket[key] = [];
        var exists = bucket[key].some(function (entry) {
          return entry && entry.canonical === canonical;
        });
        if (!exists) {
          bucket[key].push(stored);
          changed = true;
        }
      }

      addToBucket(cache.wrongById, stored.qid);
      addToBucket(cache.wrongByTitle, stored.titleKey);
      return changed;
    },

    _removeWrongQuizAnswer: function (cache, item) {
      if (!cache || !item) return false;
      var canonical = item.canonical || this._canonicalQuizAnswer(item.answer, item.type);
      if (!canonical) return false;
      var changed = false;

      function removeFromBucket(bucket, key) {
        if (!bucket || !key || !bucket[key]) return;
        var before = bucket[key].length;
        bucket[key] = bucket[key].filter(function (entry) {
          return entry && entry.canonical !== canonical;
        });
        if (bucket[key].length !== before) changed = true;
        if (!bucket[key].length) delete bucket[key];
      }

      removeFromBucket(cache.wrongById, item.qid || '');
      removeFromBucket(cache.wrongByTitle, item.titleKey || '');
      return changed;
    },

    /**
     * 判断某题是否被批改为"正确"。
     *
     * 必须保守：宁可漏记，也不能把错题当成对题写进缓存 —— 缓存一旦被污染
     * 就会一直用错误答案，比不缓存更糟。
     *
     * 学习通的结果图标（对照 cxmooc-tools 的 question.ts）：
     *   .fr.dui 答对 / .fr.bandui 半对 / .fr.cuo 答错
     * 必须用 classList 精确比对 token —— `[class*="dui"]` 会把 bandui 也匹配上。
     * 旧的实现只认 marking_dui / correct-icon / right-icon，在学习通真实页面上
     * 一个都命中不了，于是"记住正确答案"这条链路从来没生效过，
     * 每次答题都得重新问一遍模型、白花 token。
     */
    _isQuizQuestionMarkedCorrect: function (node) {
      if (!node || !node.querySelectorAll) return false;

      var scope = node;
      try {
        var block = node.querySelector('.Py_answer, .Py_tk, [class*="Py_answer"], [class*="Py_tk"]');
        if (block) scope = block;
      } catch (e) {}

      var nodes = [];
      try { nodes = Array.from(scope.querySelectorAll('[class]')); } catch (e2) { return false; }
      if (nodes.length > 600) nodes = nodes.slice(0, 600);

      var sawPositive = false;
      for (var i = 0; i < nodes.length; i++) {
        var cls = nodes[i].classList;
        if (!cls) continue;
        if (cls.contains('bandui') || cls.contains('cuo')) return false; // 半对/答错：直接否决
        if (cls.contains('dui') || cls.contains('marking_dui')
          || cls.contains('correct-icon') || cls.contains('right-icon')) {
          sawPositive = true;
        }
      }
      return sawPositive;
    },

    /**
     * 从批改结果区抠出"正确答案"文本。
     *
     * 交卷后学习通把正确答案展示在 .Py_answer / .Py_tk 里，形如
     *   <div class="Py_answer clearfix"><span>正确答案：</span><span class="font14">A</span></div>
     * 各题型呈现细节不同，这里只做保守解析：定位"正确答案"之后的那一段，
     * 取到"我的答案/解析/结尾"为止。解析不出来就返回空串 ——
     * 宁可不缓存，也不缓存错的。
     */
    _extractDisplayedCorrectAnswer: function (node) {
      var block = null;
      try { block = node.querySelector('.Py_answer, .Py_tk, [class*="Py_answer"], [class*="Py_tk"]'); } catch (e) {}
      if (!block) return '';

      var text = textOf(block);
      var at = text.indexOf('正确答案');
      if (at === -1) return '';

      var segment = text.slice(at + 4)
        .replace(/^[：:\s]+/, '')
        .split(/我的答案|你的答案|本题解析|解析/)[0]
        .replace(/[\s\u3000]+/g, ' ')
        .trim();
      if (!segment) return '';

      // 纯选项字母（可能是 "A C" 或 "A,C"）→ 规整成 "AC"
      if (/^[A-F][A-F\s,，、]*$/.test(segment)) {
        var letters = segment.match(/[A-F]/g) || [];
        return Array.from(new Set(letters)).sort().join('');
      }
      return segment.slice(0, 200);
    },

    _rememberCorrectQuizAnswers: function (preferredDoc) {
      var scanned = [];
      var remembered = 0;
      var self = this;

      function scan(doc) {
        if (!doc || scanned.indexOf(doc) !== -1) return;
        scanned.push(doc);
        var loaded = self._loadQuizCorrectAnswerCache(doc);
        var cache = loaded.data;
        var changed = false;
        var nodes = [];
        try {
          // 加上 .Cy_TItle：作业与考试页用这套类名，缺了它就永远收集不到正确答案
          nodes = Array.from(doc.querySelectorAll('.TiMu, .Cy_TItle, .questionLi, .questionItem, .mark_item, .questionBox'));
        } catch (e) {}

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node || !node.querySelector) continue;
          if (!self._isQuizQuestionMarkedCorrect(node)) continue;

          var qid = self._getQuestionIdFromElement(node);
          // 优先读输入域里留存的作答；交卷后输入域可能被清空，则退回解析展示出来的正确答案
          var answer = self._getQuizAnswerValue(node, qid) || self._extractDisplayedCorrectAnswer(node);
          if (!answer) continue;

          var item = {
            qid: qid,
            answer: answer,
            type: self._getQuestionTypeFromElement(node, qid),
            titleKey: self._getQuizTitleKeyFromElement(node, '')
          };
          item.canonical = self._canonicalQuizAnswerForQuestion(answer, item.type, { _element: node });
          if (self._removeWrongQuizAnswer(cache, item)) {
            changed = true;
          }
          if (qid && (!cache.byId[qid] || cache.byId[qid].answer !== answer)) {
            cache.byId[qid] = item;
            changed = true;
            remembered++;
          }
          if (item.titleKey && (!cache.byTitle[item.titleKey] || cache.byTitle[item.titleKey].answer !== answer)) {
            cache.byTitle[item.titleKey] = item;
            changed = true;
          }
        }

        if (changed) self._saveQuizCorrectAnswerCache(doc, cache);
      }

      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      scan(submitDoc || preferredDoc || this._getMainDocument());
      if (preferredDoc && preferredDoc !== submitDoc) scan(preferredDoc);
      if (!preferredDoc) {
        this._walkDocuments(function (doc) {
          scan(doc);
          return false;
        });
      }

      if (remembered > 0) {
        console.log('[Omitone] remembered correct quiz answers:', remembered);
        emitRuntimeLog('info', 'remember correct quiz answers', { count: remembered });
      }
      return remembered;
    },

    _rememberWrongQuizAnswers: function (preferredDoc) {
      var scanned = [];
      var remembered = 0;
      var self = this;

      function scan(doc) {
        if (!doc || scanned.indexOf(doc) !== -1) return;
        scanned.push(doc);
        var loaded = self._loadQuizCorrectAnswerCache(doc);
        var cache = loaded.data;
        var changed = false;
        var nodes = [];
        try {
          nodes = Array.from(doc.querySelectorAll('.TiMu, .questionLi, .questionItem, .mark_item, .questionBox'));
        } catch (e) {}

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node || !node.querySelector) continue;
          var isWrong = !!node.querySelector('.marking_cuo, [class*="marking_cuo"], [class*="wrong-icon"], [class*="error-icon"]');
          if (!isWrong) continue;

          var qid = self._getQuestionIdFromElement(node);
          var type = self._getQuestionTypeFromElement(node, qid);
          var answer = self._getQuizAnswerValue(node, qid);
          var submitted = null;
          if (!answer) {
            submitted = self._getSubmittedQuizAnswerForQuestion({ _element: node, title: self._getQuizTitleKeyFromElement(node, '') });
            if (!submitted || !submitted.answer) {
              submitted = self._getLastSubmittedQuizAnswerForQuestion({ _element: node, title: self._getQuizTitleKeyFromElement(node, '') }, doc);
            }
            if (submitted && submitted.answer) {
              answer = submitted.answer;
              if (submitted.type) type = submitted.type;
            }
          }
          if (!answer) continue;

          var item = {
            qid: qid,
            answer: answer,
            type: type,
            titleKey: self._getQuizTitleKeyFromElement(node, ''),
            canonical: submitted && submitted.canonical ? submitted.canonical : self._canonicalQuizAnswerForQuestion(answer, type, { _element: node })
          };
          if (self._addWrongQuizAnswer(cache, item)) {
            changed = true;
            remembered++;
          }
        }

        if (changed) self._saveQuizCorrectAnswerCache(doc, cache);
      }

      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      scan(submitDoc || preferredDoc || this._getMainDocument());
      if (preferredDoc && preferredDoc !== submitDoc) scan(preferredDoc);
      if (!preferredDoc) {
        this._walkDocuments(function (doc) {
          scan(doc);
          return false;
        });
      }

      if (remembered > 0) {
        console.log('[Omitone] remembered wrong quiz answers:', remembered);
        emitRuntimeLog('info', 'remember wrong quiz answers', { count: remembered });
      }
      return remembered;
    },

    _getCachedQuizAnswer: function (question, preferredDoc) {
      if (!question || !question._element) return null;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid && loaded.data.byId[qid]) return loaded.data.byId[qid];
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey && loaded.data.byTitle[titleKey]) return loaded.data.byTitle[titleKey];
      return null;
    },

    _getKnownWrongQuizAnswers: function (question, preferredDoc) {
      if (!question || !question._element) return [];
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      var list = [];
      if (qid && loaded.data.wrongById && loaded.data.wrongById[qid]) list = list.concat(loaded.data.wrongById[qid]);
      if (titleKey && loaded.data.wrongByTitle && loaded.data.wrongByTitle[titleKey]) list = list.concat(loaded.data.wrongByTitle[titleKey]);

      var seen = [];
      return list.filter(function (item) {
        if (!item || !item.canonical || seen.indexOf(item.canonical) !== -1) return false;
        seen.push(item.canonical);
        return true;
      });
    },

    _getConfirmedCachedQuizAnswer: function (question, preferredDoc) {
      var cached = this._getCachedQuizAnswer(question, preferredDoc);
      if (!cached || !cached.answer) return null;

      var type = cached.type || (question && question.type) || 'single';
      var canonical = this._canonicalQuizAnswerForQuestion(cached.answer, type, question);
      if (!canonical) return null;

      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      if (wrongSet.indexOf(canonical) !== -1) {
        var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
        if (this._removeWrongQuizAnswer(loaded.data, {
          qid: cached.qid || this._getQuestionIdFromElement(question._element),
          titleKey: cached.titleKey || this._getQuizTitleKeyFromElement(question._element, question.title),
          answer: cached.answer,
          type: type,
          canonical: canonical
        })) {
          this._saveQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument, loaded.data);
        }
        emitRuntimeLog('warn', 'prefer confirmed correct answer over wrong cache', { qid: cached.qid || '', titleKey: cached.titleKey || '' });
      }
      return cached;
    },

    _getQuizQuestionRuntimeKey: function (question) {
      if (!question || !question._element) return '';
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid) return 'id:' + qid;
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey) return 'title:' + titleKey;
      return 'index:' + String(question.index != null ? question.index : '');
    },

    _markQuizQuestionAnsweredThisRun: function (question, source, answer, type) {
      var key = this._getQuizQuestionRuntimeKey(question);
      if (!key) return;
      if (!this._quizCurrentAnsweredKeys) this._quizCurrentAnsweredKeys = {};
      if (!this._quizCurrentAnswerValues) this._quizCurrentAnswerValues = {};
      this._quizCurrentAnsweredKeys[key] = source || 'unknown';
      if (answer !== undefined && answer !== null && String(answer).trim()) {
        var answerType = type || (question && question.type) || 'single';
        this._quizCurrentAnswerValues[key] = {
          answer: answer,
          canonical: this._canonicalQuizAnswerForQuestion(answer, answerType, question),
          type: answerType,
          source: source || 'unknown',
          at: Date.now()
        };
      }
    },

    _wasQuizQuestionAnsweredThisRun: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      return !!(key && this._quizCurrentAnsweredKeys && this._quizCurrentAnsweredKeys[key]);
    },

    _unmarkQuizQuestionAnsweredThisRun: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      if (!key) return;
      if (this._quizCurrentAnsweredKeys) delete this._quizCurrentAnsweredKeys[key];
      if (this._quizCurrentAnswerValues) delete this._quizCurrentAnswerValues[key];
    },

    _getSubmittedQuizAnswerForQuestion: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      return key && this._quizCurrentAnswerValues ? this._quizCurrentAnswerValues[key] : null;
    },

    _getLastSubmittedQuizAnswerForQuestion: function (question, preferredDoc) {
      if (!question || !question._element) return null;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid && loaded.data.submittedById && loaded.data.submittedById[qid]) return loaded.data.submittedById[qid];
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey && loaded.data.submittedByTitle && loaded.data.submittedByTitle[titleKey]) return loaded.data.submittedByTitle[titleKey];
      return null;
    },

    _rememberSubmittedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || (questions[0] && questions[0]._element && questions[0]._element.ownerDocument));
      var cache = loaded.data;
      if (!cache.submittedById) cache.submittedById = {};
      if (!cache.submittedByTitle) cache.submittedByTitle = {};
      var saved = 0;

      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        if (!question || !question._element) continue;
        var value = this._getQuizQuestionFilledValue(preferredDoc || null, question);
        if (!value) continue;
        var qid = this._getQuestionIdFromElement(question._element);
        var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
        var type = question.type || this._getQuestionTypeFromElement(question._element, qid);
        var item = {
          qid: qid,
          answer: value,
          canonical: this._canonicalQuizAnswerForQuestion(value, type, question),
          type: type,
          titleKey: titleKey,
          at: Date.now()
        };
        if (qid) cache.submittedById[qid] = item;
        if (titleKey) cache.submittedByTitle[titleKey] = item;
        saved++;
      }

      if (saved > 0) {
        this._saveQuizCorrectAnswerCache(preferredDoc || (questions[0] && questions[0]._element && questions[0]._element.ownerDocument), cache);
        emitRuntimeLog('info', 'remember submitted quiz answers', { count: saved });
      }
      return saved;
    },

    _areAllQuizQuestionsConfirmedCached: function (questions, preferredDoc) {
      if (!questions || !questions.length) return false;
      for (var i = 0; i < questions.length; i++) {
        if (!this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) return false;
      }
      return true;
    },

    _getKnownWrongCanonicalSet: function (question, type, preferredDoc) {
      var wrongs = this._getKnownWrongQuizAnswers(question, preferredDoc);
      var seen = [];
      for (var i = 0; i < wrongs.length; i++) {
        var item = wrongs[i];
        if (!item) continue;
        var variants = [
          item.canonical,
          this._canonicalQuizAnswer(item.answer, item.type || type),
          this._canonicalQuizAnswer(item.answer, type),
          this._canonicalQuizAnswerForQuestion(item.answer, type, question)
        ];
        for (var j = 0; j < variants.length; j++) {
          if (variants[j] && seen.indexOf(variants[j]) === -1) seen.push(variants[j]);
        }
      }
      return seen;
    },

    _getChoiceCandidateAnswers: function (question, type) {
      var candidates = [];
      var el = question && question._element;
      var items = el ? this._getOptionItems(el) : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var stored = this._getOptionStoredAnswerValue(item);
        var text = this._extractOptionText(item);
        var value = stored;
        if (type === 'judge') {
          var judge = this._normalizeJudgeAnswerValue(stored || text);
          if (judge === 'true' || judge === 'false') value = judge;
        }
        if (!value) value = String.fromCharCode(65 + i);
        value = String(value || '').trim();
        if (value && candidates.indexOf(value) === -1) candidates.push(value);
      }

      if (!candidates.length) {
        var letters = this._getQuestionOptionLetters(question);
        for (var j = 0; j < letters.length; j++) candidates.push(letters[j]);
      }
      return candidates;
    },

    _clearKnownWrongQuizAnswersForQuestion: function (question, preferredDoc, reason) {
      if (!question || !question._element) return false;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      var changed = false;

      if (qid && loaded.data.wrongById && loaded.data.wrongById[qid]) {
        delete loaded.data.wrongById[qid];
        changed = true;
      }
      if (titleKey && loaded.data.wrongByTitle && loaded.data.wrongByTitle[titleKey]) {
        delete loaded.data.wrongByTitle[titleKey];
        changed = true;
      }
      if (changed) {
        this._saveQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument, loaded.data);
        emitRuntimeLog('warn', 'clear exhausted wrong answer cache', { qid: qid || '', reason: reason || '' });
      }
      return changed;
    },

    _sortMultiFallbackCombos: function (combos, preferredSize) {
      if (!combos || !combos.length) return combos || [];
      var targetSize = preferredSize || 2;
      return combos.sort(function (a, b) {
        var da = Math.abs(a.length - targetSize);
        var db = Math.abs(b.length - targetSize);
        if (da !== db) return da - db;
        return a.length - b.length;
      });
    },

    _chooseFallbackQuizAnswer: function (type, question, preferredDoc, avoidCanonical, preferredSize) {
      if (type !== 'single' && type !== 'judge' && type !== 'multiple') return '';
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      var candidates = this._getChoiceCandidateAnswers(question, type);

      if (type === 'single' || type === 'judge') {
        for (var i = 0; i < candidates.length; i++) {
          var candidateCanonical = this._canonicalQuizAnswerForQuestion(candidates[i], type, question);
          if (candidateCanonical && wrongSet.indexOf(candidateCanonical) === -1) return candidates[i];
        }

        this._clearKnownWrongQuizAnswersForQuestion(question, preferredDoc, 'single-judge-exhausted');
        for (var j = 0; j < candidates.length; j++) {
          var fallbackCanonical = this._canonicalQuizAnswerForQuestion(candidates[j], type, question);
          if (fallbackCanonical && fallbackCanonical !== avoidCanonical) return candidates[j];
        }
        if (candidates.length) return candidates[0];
        if (type === 'judge') return avoidCanonical === 'true' ? 'false' : 'true';
        return 'A';
      }

      var combos = this._sortMultiFallbackCombos(this._generateChoiceCombinations(candidates), preferredSize);
      for (var k = 0; k < combos.length; k++) {
        var comboCanonical = this._canonicalQuizAnswerForQuestion(combos[k], type, question);
        if (comboCanonical && wrongSet.indexOf(comboCanonical) === -1) return combos[k].split('');
      }

      this._clearKnownWrongQuizAnswersForQuestion(question, preferredDoc, 'multiple-exhausted');
      for (var m = 0; m < combos.length; m++) {
        var fallbackComboCanonical = this._canonicalQuizAnswerForQuestion(combos[m], type, question);
        if (fallbackComboCanonical && fallbackComboCanonical !== avoidCanonical) return combos[m].split('');
      }
      return combos.length ? combos[0].split('') : [];
    },

    _getQuestionOptionLetters: function (question) {
      var count = question && Array.isArray(question.options) ? question.options.length : 0;
      if (!count && question && question._element) count = this._getOptionItems(question._element).length;
      count = Math.max(0, Math.min(count || 0, 6));
      var letters = [];
      for (var i = 0; i < count; i++) letters.push(String.fromCharCode(65 + i));
      return letters;
    },

    _generateChoiceCombinations: function (letters) {
      var combos = [];
      var count = letters ? letters.length : 0;
      if (!count) return combos;
      for (var size = 1; size <= count; size++) {
        var total = Math.pow(2, count);
        for (var mask = 1; mask < total; mask++) {
          var current = [];
          for (var i = 0; i < count; i++) {
            if (mask & (1 << i)) current.push(letters[i]);
          }
          if (current.length === size) combos.push(current.join(''));
        }
      }
      return combos;
    },

    _avoidKnownWrongAnswer: function (answer, type, question, preferredDoc) {
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      var canonical = this._canonicalQuizAnswerForQuestion(answer, type, question);

      if (!canonical && (type === 'single' || type === 'judge' || type === 'multiple')) {
        var fallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, '', type === 'multiple' ? 2 : 1);
        emitRuntimeLog('warn', 'llm empty answer fallback', { type: type, fallback: Array.isArray(fallback) ? fallback.join('') : fallback });
        return fallback;
      }

      if (!wrongSet.length) return answer;
      if (!canonical || wrongSet.indexOf(canonical) === -1) return answer;

      if (type === 'judge') {
        var replacement = canonical === 'true' ? 'false' : 'true';
        if (wrongSet.indexOf(replacement) !== -1) {
          this._clearKnownWrongQuizAnswersForQuestion(question, preferredDoc, 'judge-exhausted');
          emitRuntimeLog('warn', 'wrong answer cache exhausted, use judge fallback', { wrongs: wrongSet.join(','), fallback: replacement });
          return replacement;
        }
        console.warn('[Omitone] avoid repeated wrong judge answer', canonical, '->', replacement);
        emitRuntimeLog('warn', 'avoid repeated wrong judge answer', { from: canonical, to: replacement });
        return replacement;
      }

      if (type === 'single') {
        var candidates = this._getChoiceCandidateAnswers(question, type);
        for (var i = 0; i < candidates.length; i++) {
          var candidateCanonical = this._canonicalQuizAnswerForQuestion(candidates[i], type, question);
          if (candidateCanonical && wrongSet.indexOf(candidateCanonical) === -1) {
            console.warn('[Omitone] avoid repeated wrong single answer', canonical, '->', candidates[i]);
            emitRuntimeLog('warn', 'avoid repeated wrong single answer', { from: canonical, to: candidates[i] });
            return candidates[i];
          }
        }
        var singleFallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, canonical, 1);
        emitRuntimeLog('warn', 'wrong answer cache exhausted, use single fallback', { wrongs: wrongSet.join(','), fallback: singleFallback });
        return singleFallback || answer;
      }

      if (type === 'multiple') {
        var multiCandidates = this._getChoiceCandidateAnswers(question, type);
        var combos = this._generateChoiceCombinations(multiCandidates);
        var preferredSize = canonical ? canonical.length : 0;
        this._sortMultiFallbackCombos(combos, preferredSize || 2);
        for (var j = 0; j < combos.length; j++) {
          var comboCanonical = this._canonicalQuizAnswerForQuestion(combos[j], type, question);
          if (comboCanonical && wrongSet.indexOf(comboCanonical) === -1) {
            var replacementMulti = combos[j].split('');
            console.warn('[Omitone] avoid repeated wrong multiple answer', canonical, '->', replacementMulti.join(''));
            emitRuntimeLog('warn', 'avoid repeated wrong multiple answer', { from: canonical, to: replacementMulti.join('') });
            return replacementMulti;
          }
        }
        var multiFallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, canonical, preferredSize || 2);
        emitRuntimeLog('warn', 'wrong answer cache exhausted, use multiple fallback', { wrongs: wrongSet.join(','), fallback: Array.isArray(multiFallback) ? multiFallback.join('') : multiFallback });
        return multiFallback && multiFallback.length ? multiFallback : answer;
      }

      return answer;
    },

    _fillCachedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var restored = 0;
      for (var i = 0; i < questions.length; i++) {
        var cached = this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc);
        if (!cached || !cached.answer) continue;
        var type = cached.type || questions[i].type;
        console.log('[Omitone] restore cached correct answer', i, type, cached.answer);
        if (type === 'single' || type === 'judge') this._fillChoice(questions[i]._element, cached.answer, 'radio');
        else if (type === 'multiple') this._fillMultiChoice(questions[i]._element, cached.answer);
        else if (type === 'fill') this._fillText(questions[i]._element, cached.answer);
        else if (type === 'short') this._fillTextarea(questions[i]._element, cached.answer);
        var filledValue = this._getQuizQuestionFilledValue(preferredDoc || null, questions[i]);
        if (filledValue) {
          this._markQuizQuestionAnsweredThisRun(questions[i], 'confirmed-cache', filledValue, type);
          restored++;
        }
      }
      if (restored > 0) emitRuntimeLog('info', 'restore cached correct answers', { count: restored });
      return restored;
    },

    _dispatchQuizInputEvents: function (node) {
      if (!node) return;
      try {
        var win = (node.ownerDocument && node.ownerDocument.defaultView) || window;
        node.dispatchEvent(new win.Event('input', { bubbles: true }));
        node.dispatchEvent(new win.Event('change', { bubbles: true }));
      } catch (e) {}
    },

    _clearQuizQuestionAnswer: function (question) {
      var el = question && question._element;
      if (!el) return false;
      var doc = el.ownerDocument || document;
      var qid = this._getQuestionIdFromElement(el);
      var cleared = false;

      try {
        var hidden = qid && doc.getElementById ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = '';
          hidden.setAttribute('value', '');
          this._dispatchQuizInputEvents(hidden);
          cleared = true;
        }

        var optionNodes = [];
        if (qid && doc.querySelectorAll) optionNodes = optionNodes.concat(Array.from(doc.querySelectorAll('.choice' + qid)));
        if (el.querySelectorAll) {
          optionNodes = optionNodes.concat(Array.from(el.querySelectorAll('.num_option, .num_option_dx, [role="radio"], [role="checkbox"]')));
        }
        optionNodes.forEach(function (node) {
          node.classList.remove('check_answer');
          node.classList.remove('check_answer_dx');
          node.setAttribute('aria-checked', 'false');
          node.setAttribute('aria-pressed', 'false');
          var item = node.closest ? node.closest('li, label, [role="radio"], [role="checkbox"]') : null;
          if (item) {
            item.setAttribute('aria-checked', 'false');
            item.setAttribute('aria-pressed', 'false');
          }
        });

        Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]')).forEach(function (input) {
          input.checked = false;
          app._dispatchQuizInputEvents(input);
        });

        Array.from(el.querySelectorAll('input[type="text"], input:not([type])')).forEach(function (input) {
          input.value = '';
          input.setAttribute('value', '');
          app._dispatchQuizInputEvents(input);
        });

        Array.from(el.querySelectorAll('textarea')).forEach(function (textarea) {
          textarea.value = '';
          textarea.textContent = '';
          app._dispatchQuizInputEvents(textarea);
        });
      } catch (e) {}

      return cleared;
    },

    _clearUnconfirmedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var cleared = 0;
      for (var i = 0; i < questions.length; i++) {
        if (this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) continue;
        if (this._clearQuizQuestionAnswer(questions[i])) cleared++;
      }
      if (cleared > 0) emitRuntimeLog('info', 'clear stale quiz answers', { count: cleared });
      return cleared;
    },

    _findVisibleQuizRedoDialog: function () {
      var found = null;
      this._walkDocuments(function (doc) {
        var selectors = ['#workpop', '#submitBack', '.AlertCon02', '.layui-layer', '.dialog', '.modal', '[role="dialog"]', '[role="alertdialog"]'];
        for (var i = 0; i < selectors.length; i++) {
          var nodes = doc.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j])) continue;
            if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(textOf(nodes[j]))) {
              found = nodes[j];
              return true;
            }
          }
        }
        return false;
      });
      return found;
    },

    _isQuizRedoRequired: function (preferredDoc) {
      var matched = false;
      var docs = [];
      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      if (submitDoc) docs.push(submitDoc);
      if (preferredDoc && docs.indexOf(preferredDoc) === -1) docs.push(preferredDoc);
      if (!docs.length) {
        var mainDoc = this._getMainDocument();
        if (mainDoc) docs.push(mainDoc);
      }
      for (var i = 0; i < docs.length; i++) {
        try {
          var body = docs[i] && docs[i].body;
          if (body && /未达到及格线|未达到通过标准|请重做|很遗憾/.test(textOf(body))) {
            matched = true;
            break;
          }
        } catch (e) {}
      }
      return matched || !!this._findVisibleQuizRedoDialog();
    },

    _prepareQuizRedoIfNeeded: function (preferredDoc) {
      if (!this._isQuizRedoRequired(preferredDoc)) return false;
      if (this._shouldSkipQuizBySubmitAttempts(preferredDoc || null)) {
        return this._forceSkipQuizAfterMaxAttempts(preferredDoc || null);
      }
      this._rememberCorrectQuizAnswers(preferredDoc || null);
      this._rememberWrongQuizAnswers(preferredDoc || null);
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizAnswered = false;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';

      var dialog = this._findVisibleQuizRedoDialog();
      if (dialog) {
        emitRuntimeLog('warn', 'quiz redo required');
        return true;
      }
      return false;
    },

    _isQuizPassedOrFinished: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      try {
        if (doc && this._isDocumentFrameFinished(doc)) return true;
        var text = doc && doc.body ? textOf(doc.body) : '';
        if (text && !/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text) && /任务点已完成|已通过|通过标准|恭喜/.test(text)) return true;
      } catch (e) {}
      return false;
    },

    _hasActiveQuizSubmitForm: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      if (!doc) return false;
      try {
        var hasQuiz = !!doc.querySelector('.TiMu, .questionLi, .questionItem, .mark_item, .questionBox, input[id^="answertype"]');
        if (!hasQuiz) return false;
        var buttons = Array.from(doc.querySelectorAll('.btnSubmit, .workBtnIndex, .bluebtn, button, a, input[type="submit"], input[type="button"]'));
        return buttons.some(function (button) {
          if (!visible(button)) return false;
          var label = String(button.textContent || button.value || button.title || '').trim();
          return /提交|交卷|完成/.test(label) || /btnBlueSubmit|submitCheckTimes/.test(String(button.getAttribute('onclick') || ''));
        });
      } catch (e) {
        return false;
      }
    },

    _markQuizSubmitPending: function (preferredDoc, reason) {
      var now = Date.now();
      var wasPending = this._quizSubmitPending;
      this._quizSubmitPending = true;
      this._quizSubmitStartedAt = now;
      this._quizSubmitLogAt = 0;
      this._quizLastSubmitAttemptAt = now;
      var attemptCount = wasPending ? this._getQuizSubmitAttemptCount(preferredDoc) : this._incrementQuizSubmitAttemptCount(preferredDoc);
      emitRuntimeLog('info', 'quiz submit pending', { reason: reason || '', key: this._getQuizWorkKey(preferredDoc), attemptCount: attemptCount, maxAttempts: this._getQuizMaxSubmitAttempts() });
    },

    _monitorQuizSubmit: function (preferredDoc) {
      if (this._prepareQuizRedoIfNeeded(preferredDoc || null)) return true;
      if (!this._quizSubmitPending) return false;

      if (this._isQuizPassedOrFinished(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizAnswered = true;
        this._clearQuizSubmitAttemptCount(preferredDoc || null);
        emitRuntimeLog('info', 'quiz submit finished');
        return false;
      }

      var now = Date.now();
      var waitMs = Number(this.configs.quizSubmitWaitMs || 25000);
      if (this._quizSubmitStartedAt && now - this._quizSubmitStartedAt > waitMs) {
        this._quizSubmitPending = false;
        emitRuntimeLog('warn', 'quiz submit wait timeout', { waitMs: waitMs });
        return false;
      }

      if (!this._quizSubmitLogAt || now - this._quizSubmitLogAt > 3000) {
        this._quizSubmitLogAt = now;
        console.log('%c[Omitone] waiting quiz submit result', 'color:#9C27B0');
      }
      return true;
    },

    _shouldHoldQuizBeforeNext: function (reason) {
      if (this._isQuizForceSkipping()) return false;
      if (this._isQuizApiUnavailable()) return false;
      if (this._monitorQuizSubmit()) return true;
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      if (!this._detectQuiz() && !this._hasActiveQuizSubmitForm(doc)) return false;
      if (this._isQuizPassedOrFinished(doc)) return false;
      var now = Date.now();
      var shouldLog = !this._quizHoldLogAt || now - this._quizHoldLogAt > 3000;
      if (this._isQuizRedoRequired(doc)) {
        if (this._shouldSkipQuizBySubmitAttempts(doc)) {
          return this._forceSkipQuizAfterMaxAttempts(doc);
        }
        this._rememberCorrectQuizAnswers(doc);
        this._rememberWrongQuizAnswers(doc);
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        if (shouldLog) {
          this._quizHoldLogAt = now;
          emitRuntimeLog('warn', 'hold quiz redo before next', { reason: reason || '' });
        }
        return true;
      }
      if (this._hasActiveQuizSubmitForm(doc)) {
        if (shouldLog) {
          this._quizHoldLogAt = now;
          emitRuntimeLog('warn', 'hold unsubmitted quiz before next', { reason: reason || '' });
        }
        return true;
      }
      return false;
    },

    _isQuizLearningPending: function (preferredDoc) {
      if (this._isQuizForceSkipping()) return false;
      if (this._isQuizApiUnavailable()) return false;
      if (this._monitorQuizSubmit(preferredDoc || null)) return true;
      if (this._quizInProgress || this._quizSubmitPending) return true;

      var doc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
      if (doc && this._isQuizPassedOrFinished(doc)) return false;

      if (this._isQuizRedoRequired(doc || null)) {
        if (this._shouldSkipQuizBySubmitAttempts(doc || null)) {
          return this._forceSkipQuizAfterMaxAttempts(doc || null);
        }
        this._rememberCorrectQuizAnswers(doc || null);
        this._rememberWrongQuizAnswers(doc || null);
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return true;
      }

      if (doc && this._hasActiveQuizSubmitForm(doc)) return true;
      if (this._detectQuiz() && !(doc && this._isQuizPassedOrFinished(doc))) return true;
      return false;
    },

    _handleQuiz: async function (preferredDoc) {
      if (this._quizAnswered || this._quizInProgress) return;
      if (!this.configs.enableQuiz) { // 硬守卫：AI 答题开关关闭时只刷课，任何情况下都不取题、不调 API
        this._skipQuizForApiUnavailable(null, preferredDoc || null);
        return;
      }
      if (this._isQuizApiUnavailable()) {
        this._skipQuizForApiUnavailable(null, preferredDoc || null);
        return;
      }
      if (this._shouldSkipQuizBySubmitAttempts(preferredDoc || null)) {
        this._forceSkipQuizAfterMaxAttempts(preferredDoc || null);
        return;
      }
      this._quizInProgress = true;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._rememberCorrectQuizAnswers(preferredDoc || null);
      var questions = this._extractQuestions(preferredDoc);
      if (questions.length === 0) {
        console.warn('[Omitone] no questions extracted');
        // 扫不到题这件事必须留下可查的线索，否则用户只能反馈"AI 扫描不到题目"，
        // 而这句话后面藏着至少四种完全不同的原因（见 hint）。30 秒节流避免刷屏。
        if (Date.now() - (this._quizScanDiagAt || 0) > 30000) {
          this._quizScanDiagAt = Date.now();
          var diag = this._diagnoseQuestionScan(preferredDoc);
          emitRuntimeLog('error', 'quiz scan found 0 questions', {
            hint: diag.hint || '',
            docs: diag.docs.length,
            matchedSelectors: diag.docs.reduce(function (sum, d) {
              return Object.assign(sum, d.selectors);
            }, {}),
            inputs: diag.docs.reduce(function (sum, d) { return sum + d.inputs; }, 0),
            samples: diag.samples.slice(0, 3)
          });
        }
        this._quizInProgress = false;
        return;
      }
      this._quizCurrentQuestions = questions;
      var quizDoc = preferredDoc || this._getQuizDocumentFromQuestions(questions) || null;

      this._clearUnconfirmedQuizAnswers(questions, quizDoc);
      var allQuestionsConfirmedCached = this._areAllQuizQuestionsConfirmedCached(questions, quizDoc);
      this._fillCachedQuizAnswers(questions, quizDoc);
      this._clearKnownWrongFilledQuizAnswers(questions, quizDoc);
      if (allQuestionsConfirmedCached && this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true })) {
        console.log('[Omitone] quiz ready from cached correct answers');
        this._quizAnswered = true;
        this._quizReadyToSubmit = true;
        this._quizReadyWorkKey = this._getQuizWorkKey(quizDoc);
        this._quizInProgress = false;
        this._maybeSubmitQuiz(quizDoc, questions);
        return;
      }

      var self = this;
      var payload = [];
      var skippedConfirmed = 0;
      var batchWorkKey = this._getQuizWorkKey(quizDoc);
      // 这一轮是否**整批重发**（含已知正确答案的题）。
      //
      // 为什么要整批重发：DeepSeek 的前缀缓存要求请求前缀完整匹配某个已持久化的
      // 「缓存前缀单元」。第一次提问只发"需要的题"，重试若再从中间删掉几道，
      // 前缀就从删除处断掉 —— 命中率归零。
      // 整批重发时，重试的输入是上一次输入的**超集且前缀一致**（官方 Example 1 的
      // `A+B` → `A+B+C`），整段命中，按约 1/10 价计费。
      //
      // 但不能无条件整批重发：第一次提问时如果一个都没有发过，多带的题只会按原价
      // 计费。所以只在"本卷刚发过请求"（30 分钟内）时才整批重发。
      var batchRecent = batchWorkKey
        && batchWorkKey === this._quizBatchSentKey
        && (Date.now() - (this._quizBatchSentAt || 0) < 30 * 60 * 1000);

      questions.forEach(function (q, i) {
        // 已经"确认正确 + 本轮已填 + DOM 里确实有值"的题不再问模型：
        // _fillCachedQuizAnswers 已经把答案填回去了，重复提问纯属白花 token。
        // 三个条件必须同时成立 —— 只看缓存会让"缓存存在但填不进去"的题永远没人作答，
        // 导致表单填不满、反复重试。
        var alreadyCorrect = self._getConfirmedCachedQuizAnswer(q, quizDoc)
          && self._wasQuizQuestionAnsweredThisRun(q)
          && self._isQuizQuestionFilled(quizDoc, q);
        if (alreadyCorrect) {
          skippedConfirmed++;
          if (!batchRecent) return;
        }
        var wrongAnswers = self._getKnownWrongQuizAnswers(q, quizDoc).map(function (item) {
          return item.answer || item.canonical;
        });
        // index 必须是该题在 questions[] 中的位置：_fillAnswers 用 answerItem.index 取题。
        // content.js 会把这个值原样透传回来，不会因为分批而错位。
        payload.push({ index: i, type: q.type, title: q.title, options: q.options, previousWrongAnswers: wrongAnswers });
      });

      if (skippedConfirmed > 0) {
        emitRuntimeLog('info', batchRecent ? 'resend full batch for prefix cache' : 'skip llm for cached-correct questions',
          { skipped: skippedConfirmed, asked: payload.length });
      }
      if (payload.length) {
        // 记在"发出去"这一侧而不是"收到成功响应"那一侧：缓存单元是在请求到达时建立的，
        // 即便这次解析失败，前缀也已经进了缓存，下次仍可命中。
        this._quizBatchSentKey = batchWorkKey;
        this._quizBatchSentAt = Date.now();
      }
      if (payload.length === 0) {
        // 兜底：全部题目都靠缓存填好了，却没能走上面的提前提交分支，说明状态自相矛盾，
        // 此时发一次空请求只会白白消耗配额
        emitRuntimeLog('warn', 'quiz payload empty after cache filter', { total: questions.length });
        this._quizInProgress = false;
        return;
      }

      try {
        var result = await bridgeSend('llm_request', { questions: payload });
        if (!result || !result.success) {
          console.error('quiz llm request failed:', result && result.error ? result.error : 'unknown');
          this._quizInProgress = false;
          if (result && result.parseError) {
            // API 连接正常，仅答案解析失败：保留测验稍后重试，不标记连接失败
            emitRuntimeLog('warn', 'quiz llm parse failed, keep quiz for retry', {
              error: String(result.error || '').slice(0, 160)
            });
            this._quizForceSkipUntil = Date.now() + 8000;
            return;
          }
          this._markQuizApiConnectionFailed(result && result.error ? result.error : 'LLM 请求失败');
          this._skipQuizForApiUnavailable('llm-request-failed', quizDoc);
          return;
        }

        var answers = Array.isArray(result.data) ? result.data : (result.data && Array.isArray(result.data.answers) ? result.data.answers : []);
        console.log('[Omitone] quiz answers count:', answers.length, answers);
        if (!answers.length) {
          this._quizInProgress = false;
          return;
        }

        this._fillAnswers(answers, questions, quizDoc);
        this._fillCachedQuizAnswers(questions, quizDoc);
        this._clearKnownWrongFilledQuizAnswers(questions, quizDoc);
        var formReady = this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true });
        console.log('[Omitone] quiz form ready:', formReady);
        this._quizAnswered = formReady;
        this._quizReadyToSubmit = formReady;
        this._quizReadyWorkKey = formReady ? this._getQuizWorkKey(quizDoc) : '';
        this._quizInProgress = false;
        if (formReady) {
          this._maybeSubmitQuiz(quizDoc, questions);
        } else {
          console.warn('[Omitone] skip submit because some answers are still empty');
        }
      } catch (e) {
        this._quizInProgress = false;
        console.error('quiz llm error:', e);
        this._markQuizApiConnectionFailed(e);
        this._skipQuizForApiUnavailable('llm-request-error', quizDoc);
      }
    },

    _extractQuestions: function (preferredDoc) {
      var foundQuestions = [];
      if (preferredDoc) {
        try {
          var innerQuizFrame = preferredDoc.getElementById && preferredDoc.getElementById('frame_content');
          if (innerQuizFrame) {
            var innerQuizDoc = innerQuizFrame.contentDocument || (innerQuizFrame.contentWindow && innerQuizFrame.contentWindow.document);
            if (innerQuizDoc) {
              var innerQuestions = this._extractFromDocument(innerQuizDoc);
              console.log('[Omitone] inner quiz frame questions:', innerQuestions.length);
              if (innerQuestions.length > 0) {
                for (var iq = 0; iq < innerQuestions.length; iq++) {
                  innerQuestions[iq]._inIframe = true;
                  innerQuestions[iq]._iframe = innerQuizFrame;
                }
                return innerQuestions;
              }
            }
          }
        } catch (innerErr) {}

        var directQuestions = this._extractFromDocument(preferredDoc);
        console.log('[Omitone] preferred quiz doc questions:', directQuestions.length);
        if (directQuestions.length > 0) {
          var directFrame = null;
          try {
            directFrame = preferredDoc.defaultView && preferredDoc.defaultView.frameElement;
          } catch (e) {}
          for (var d = 0; d < directQuestions.length; d++) {
            directQuestions[d]._inIframe = !!directFrame;
            directQuestions[d]._iframe = directFrame;
          }
          return directQuestions;
        }
      }
      this._walkDocuments(function (doc) {
        var questions = this._extractFromDocument(doc);
        if (questions.length > 0) {
          var frame = null;
          try {
            frame = doc.defaultView && doc.defaultView.frameElement;
          } catch (e) {}
          for (var i = 0; i < questions.length; i++) {
            questions[i]._inIframe = !!frame;
            questions[i]._iframe = frame;
          }
          foundQuestions = questions;
          return true;
        }
        return false;
      }.bind(this));
      return foundQuestions;
    },

    _getQuizDocumentFromQuestions: function (questions) {
      if (!questions || !questions.length) return null;
      for (var i = 0; i < questions.length; i++) {
        try {
          var el = questions[i] && questions[i]._element;
          if (el && el.ownerDocument) return el.ownerDocument;
        } catch (e) {}
      }
      return null;
    },

    /**
     * 题目扫描诊断。
     *
     * 触发方式：
     *   1) _handleQuiz 扫到 0 题时自动写进运行日志
     *   2) 用户在页面控制台手动执行 `xxtAI.diagnose()`（同时 return，可直接看返回值）
     *
     * 目的：把"AI 扫不到题目"这种没法查的模糊反馈，变成能直接定位的具体信息 ——
     * 每个同源文档里有哪些选择器命中、命中几个、拿到的容器为什么被判定成无效题。
     */
    _diagnoseQuestionScan: function (preferredDoc) {
      var self = this;
      var report = {
        url: String((window.location && window.location.href) || '').slice(0, 180),
        title: this._getCurrentTitle(),
        quizByTitle: this._looksLikeQuizTitle(),
        docs: [],
        containers: 0,
        samples: []
      };

      var inspectDoc = function (doc, path) {
        if (!doc || !doc.querySelectorAll || report.docs.length >= 8) return false;
        var entry = { path: path, href: '', selectors: {}, inputs: 0, answerFields: 0 };
        try { entry.href = String((doc.location && doc.location.href) || '').slice(0, 120); } catch (e) {}

        self._questionSelectors.forEach(function (sel) {
          try {
            var count = doc.querySelectorAll(sel).length;
            if (count) entry.selectors[sel] = count;
          } catch (e) {}
        });
        try {
          entry.inputs = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea').length;
          entry.answerFields = doc.querySelectorAll('[id^="answer"]').length;
        } catch (e) {}

        report.docs.push(entry);
        return false;
      };

      if (preferredDoc) this._walkDocuments(function (d) { return inspectDoc(d, 'preferredDoc'); }, preferredDoc, 0);
      this._walkDocuments(function (d) { return inspectDoc(d, 'top'); }, document, 0);

      var containerHost = preferredDoc || this._getMainDocument() || document;
      var containers = [];
      try { containers = this._collectQuestionContainers(containerHost); } catch (e) {}
      report.containers = containers.length;

      containers.slice(0, 5).forEach(function (node) {
        var parsed = self._parseQuestionElement(node, 0);
        report.samples.push({
          cls: String(node.className || '').slice(0, 50),
          head: textOf(node).slice(0, 48),
          title: parsed ? String(parsed.title || '').slice(0, 40) : '',
          options: parsed ? parsed.options.length : 0,
          parsed: !!parsed
        });
      });

      var totalMatched = report.docs.reduce(function (sum, d) {
        return sum + Object.keys(d.selectors).length;
      }, 0);
      if (!totalMatched) {
        report.hint = '任何文档都没有命中题目选择器：可能不是测验页，或题目在跨域 iframe 里（插件无法访问），或学习通改版换了类名';
      } else if (!report.containers) {
        report.hint = '选择器有命中但容器全部被过滤（隐藏/无文本）：检查 _collectQuestionContainers 的过滤条件';
      } else if (!report.samples.some(function (s) { return s.parsed; })) {
        report.hint = '容器找到了但 _parseQuestionElement 全部返回 null：题干与选项都没抠出来，需要补 titleSelectors / _getOptionItems';
      }

      return report;
    },

    _looksLikeQuizTitle: function () {
      var title = this._getCurrentTitle();
      return title.indexOf('章节测验') !== -1 || title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1;
    },

    _extractFromDocument: function (doc) {
      var questions = [];
      if (!doc || !doc.querySelectorAll) return questions;

      var containers = this._collectQuestionContainers(doc);
      if (!containers.length) return questions;

      var self = this;
      containers.forEach(function (container, index) {
        var question = self._parseQuestionElement(container, index);
        if (question) questions.push(question);
      });
      return questions;
    },

    /**
     * 按选择器优先级收集题目容器。
     *
     * 注意这里**不能**在第一个"有命中"的选择器上无条件 break：
     * 用 `.TiMu` 之类的选择器命中一批节点后，还要过一遍可见性/文本过滤，
     * 过滤后可能一个都不剩（占位容器、被隐藏的模板节点）。
     * 1.0.11 之前是命中就 break，于是"某个宽泛选择器抢先命中但全是空壳"会让整次扫描
     * 直接返回 0 题 —— 表现就是用户看到的"AI 扫描不到题目"。
     * 现在改成：挨个选择器试，谁第一个给出**过滤后非空**的结果就用谁。
     */
    /**
     * 题目容器选择器，按优先级尝试。
     *
     * 命名来源：对照开源实现 cxmooc-tools 的 src/mooc/chaoxing/question.ts 校正过。
     * 学习通有**两套**题目标记，之前的清单只覆盖了课程页那一套：
     *   课程页：  容器 .TiMu         标题 .Zy_TItle > .clearfix   选项 .Zy_ulTop/.Zy_ulBottom > li
     *   作业/考试：容器 .Cy_TItle     标题 .Cy_TItle.clearfix      选项 .Cy_ulTop/.Cy_ulBottom li
     * 缺了 .Cy_TItle 这一族，作业与考试页会整体扫不到题 —— 而这正是"AI 扫描不到题目"的常见场景。
     */
    _questionSelectors: [
      '.TiMu', '.Cy_TItle', '.questionLi', '.questionItem', '.tiBank', '.topicItem',
      '.exam_question', '.question-content', '.singleQues', '.mark_item', '.questionBox',
      'li.quesLi', '.answerOption', 'div[class*="question"]', 'div[class*="topic"]',
      'div[class*="TiMu"]', 'div[class*="Cy_TItle"]'
    ],

    _collectQuestionContainers: function (doc) {
      if (!doc || !doc.querySelectorAll) return [];
      var selectors = this._questionSelectors;

      for (var i = 0; i < selectors.length; i++) {
        var found;
        try {
          found = doc.querySelectorAll(selectors[i]);
        } catch (e) {
          continue;
        }
        if (!found || !found.length) continue;

        var candidates = Array.from(found).filter(function (node) {
          return visible(node) || textOf(node).length > 0;
        });
        if (!candidates.length) continue; // 抢占成功但全是空壳 → 继续试下一个选择器

        // 去掉互相嵌套的重复项：若某候选的祖先也是候选，只保留最外层。
        // （原来的实现用 `item.querySelector('.questionLi, .TiMu')` 判断，会误杀
        //   "外层容器内确实包含题目子节点" 的合法结构，这里改为按候选集合自身判断。）
        var set = new Set(candidates);
        var unique = candidates.filter(function (item) {
          if (!item || !item.closest) return true;
          var parent = item.parentElement;
          while (parent) {
            if (set.has(parent)) return false; // 有祖先也是候选 → 交给祖先
            parent = parent.parentElement;
          }
          return true;
        });

        if (unique.length) return unique;
      }
      return [];
    },

    /**
     * 清洗题干文本：去掉题号、题型前缀等噪声。
     *
     * 学习通把题号单独放在 `.fontLabel` 之类的元素里（内容就是 "1."），
     * 把题型写成 `【单选题】` 前缀。这两段对模型都是冗余信息 ——
     * 题号由提示词里的序号给出，题型由题型代号（s/m/j/f/t）给出。
     */
    _cleanQuestionTitle: function (text) {
      return String(text || '')
        .replace(/^\d+[.、．)）\s]+/, '')
        .replace(/^【[^】]*】\s*/, '')
        .replace(/^(单选题|多选题|多项选择题|不定项选择题|判断题|填空题|简答题|问答题|论述题)\s*[.、．:：]?\s*/, '')
        .trim();
    },

    _parseQuestionElement: function (el, index) {
      if (!el) return null;

      var title = '';
      var titleSelectors = [
        '.fontLabel', '.mark_name',
        // 学习通真实结构：题号在 .fontLabel，题干与题号同处 .Pt1 / .Zy_TItle。
        // 注意属性选择器区分大小写，[class*="title"] 匹配不到 "Zy_TItle"，所以要显式列出。
        '.Pt1', '.Zy_TItle',
        '.question-title', '.topicTitle', '.question_content', '.qContent', '.mark_title',
        '.question-name', '.title', 'h3', 'h4', '.stem', '[class*="question"]', '[class*="title"]'
      ];
      for (var i = 0; i < titleSelectors.length; i++) {
        var titleEl = el.querySelector(titleSelectors[i]);
        if (!titleEl) continue;

        var candidate = this._cleanQuestionTitle(textOf(titleEl));
        // 关键：`.fontLabel` 常常只装了题号（"1."），剥掉序号后就是空串。
        // 旧实现拿到第一个命中的选择器就 break，于是题干最终是空的 ——
        // 模型只看到选项、看不到问题，只能瞎猜。所以这里要求候选足够长，
        // 不合格就继续试下一个选择器。
        if (candidate.length >= 4) {
          title = candidate;
          break;
        }
      }
      if (!title) {
        // 所有选择器都不合格时退回整块容器文本。容器里混着选项，
        // 所以先在第一个选项标记处截断，避免把 A/B/C/D 抄进题干。
        var raw = textOf(el).slice(0, 200);
        var firstOption = raw.search(/(?:^|\s)[A-F][.、．)）]\s/);
        if (firstOption > 0) raw = raw.slice(0, firstOption);
        title = this._cleanQuestionTitle(raw);
      }

      var options = [];
      var items = this._getOptionItems(el);
      for (var j = 0; j < items.length; j++) {
        var optionText = this._extractOptionText(items[j]);
        if (optionText && options.indexOf(optionText) === -1) options.push(optionText);
      }

      if (options.length < 2) {
        // 注意 textOf() 已经把换行压成了空格，所以旧写法 `/[A-F][.、．\s]+[^\n]+/g`
        // 里的 `[^\n]+` 会从第一个选项标记一路吞到字符串末尾 —— 结果是只匹配到一次，
        // 把 A~D 全部塞进同一个"选项"里。改为先定位所有选项标记，再按标记区间切分。
        var rawText = textOf(el);
        var marks = [];
        var marker = /[A-F][.、．)）]\s*/g;
        var hit;
        while ((hit = marker.exec(rawText))) {
          marks.push({ end: marker.lastIndex, index: hit.index });
        }
        for (var k = 0; k < marks.length; k++) {
          var stop = k + 1 < marks.length ? marks[k + 1].index : rawText.length;
          var cleaned = rawText.slice(marks[k].end, stop).trim();
          if (cleaned && options.indexOf(cleaned) === -1) options.push(cleaned);
        }
      }

      if (!title && !options.length) return null;
      return {
        index: index,
        type: this._detectQuestionType(el),
        title: title,
        options: options,
        _element: el
      };
    },

    _detectQuestionType: function (el) {
      var text = textOf(el);
      var typeName = String(el.getAttribute('typename') || el.getAttribute('typeName') || '').trim();
      if (!typeName) {
        var chapterTypeEl = el.querySelector('.newZy_TItle');
        if (chapterTypeEl) typeName = textOf(chapterTypeEl);
      }
      var radios = el.querySelectorAll('input[type="radio"], [role="radio"]');
      var checkboxes = el.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      var textInputs = el.querySelectorAll('input[type="text"], input:not([type])');
      var textareas = el.querySelectorAll('textarea');
      var richEditors = el.querySelectorAll('iframe');

      if (/多选|多项|不定项|多重/.test(typeName)) return 'multiple';
      if (typeName.indexOf('判断') !== -1) return 'judge';
      if (typeName.indexOf('填空') !== -1) return 'fill';
      if (/简答|问答|论述|名词解释|计算|分析|作文/.test(typeName)) return 'short';

      if (checkboxes.length >= 2) return 'multiple';
      if (textInputs.length >= 1 && !radios.length && !checkboxes.length) return 'fill';
      if ((textareas.length >= 1 || richEditors.length >= 1) && !radios.length && !checkboxes.length) return 'short';
      if (radios.length === 2 && /判断|对错|正确|错误|是|否/.test(text)) return 'judge';
      if (radios.length >= 2) return 'single';
      if (/多选|多项|不定项/.test(text)) return 'multiple';
      if (text.indexOf('判断') !== -1 || text.indexOf('对错') !== -1) return 'judge';
      if (text.indexOf('填空') !== -1) return 'fill';
      if (/简答|问答|论述|名词解释/.test(text)) return 'short';
      return 'single';
    },

    _getOptionItems: function (el) {
      if (!el || !el.querySelectorAll) return [];

      // 学习通的选项容器（两套命名，对照 cxmooc-tools 的 question.ts 校正）：
      //   课程页：   .Zy_ulTop > li.clearfix / .Zy_ulBottom > li / .Zy_ulTk > li
      //   作业考试： .Cy_ulTop li / .Cy_ulBottom li / .Cy_ulTk li
      //
      // ⚠️ 顺序上 <li> 必须排在 <label> 之前：
      // _clickOptionItem 要从**选项元素自身**读 qid（`item.getAttribute('qid')`）
      // 才能写隐藏答案域 #answer{qid}。学习通把 qid 挂在 <li> 上而不是内层 <label> 上，
      // 一旦返回 label，qid 取不到 → 隐藏域永远为空 →
      // _areQuizAnswersFilled 判定"未填写" → 答案填了也永远不提交。
      var listSelectors = [
        '.Zy_ulTop > li', '.Zy_ulBottom > li', '.Zy_ulTk > li',
        '.Cy_ulTop li', '.Cy_ulBottom li', '.Cy_ulTk li',
        '[class*="before-after"]', '.answerBg',
        'li.clearfix'
      ];
      for (var i = 0; i < listSelectors.length; i++) {
        var found;
        try { found = Array.from(el.querySelectorAll(listSelectors[i])); } catch (e) { continue; }
        var usable = found.filter(function (node) { return textOf(node).length > 0; });
        if (usable.length) return usable;
      }

      var labels = Array.from(el.querySelectorAll('label')).filter(function (n) { return textOf(n).length > 0; });
      if (labels.length) return labels;

      // 视频内嵌弹题 / 非学习通原生结构：选项就是普通 <li> 或 .xxx-option，
      // 既没有 qid 也没有 .num_option 徽标（字母只能从文本前缀或 input value 推）。
      // 走到这里说明上面的专用选择器全没命中，此时返回 [] 会让"扫到了题却抠不出选项"，
      // AI 拿到一道没有选项的题，答了也无处可填 —— 必须继续往下捞。
      // 只取最内层节点：否则整个选项容器会被当成一个选项。
      var looseSelectors = ['[class*="option"]', '[class*="choice"]', 'li'];
      for (var k = 0; k < looseSelectors.length; k++) {
        var loose = [];
        try { loose = Array.from(el.querySelectorAll(looseSelectors[k])); } catch (e) { continue; }
        var leaf = loose.filter(function (node) {
          if (textOf(node).length === 0) return false;
          return !node.querySelector('li, [class*="option"], [class*="choice"]');
        });
        if (leaf.length) return leaf;
      }

      var roles = Array.from(el.querySelectorAll('[role="radio"], [role="checkbox"]'));
      if (roles.length) return roles;

      return [];
    },

    _extractOptionText: function (node) {
      if (!node) return '';
      var text = '';

      if (node.querySelector) {
        var chapterAnswer = node.querySelector('.fl.after');
        if (chapterAnswer) text = textOf(chapterAnswer);
        var answer = node.querySelector('.answer_p');
        if (answer) text = textOf(answer);
        // 作业/考试页的选项文本包在 <a> 里（cxmooc-tools 用 `a.fl, a` 取）
        if (!text) {
          var link = node.querySelector('a.fl, a');
          if (link) text = textOf(link);
        }
      }
      if (!text) {
        text = String((node.getAttribute && node.getAttribute('aria-label')) || textOf(node) || '');
      }

      // 注意：这里原本写作 /^(选择|閫夐」)\s*/ —— 第二个分支是 "选项" 的 GBK 乱码残留
      // （UTF-8 字节被按 GBK 解码的结果），导致以"选项"开头的选项文本永远不会被剥掉前缀。
      text = text.replace(/^(选择|选项)\s*/, '');
      text = text.replace(/^[A-F][.、．\s]+/, '');
      text = text.replace(/(选择|选项)$/, '');
      return text.trim();
    },

    _normalizeAnswerValue: function (answer) {
      if (answer && typeof answer === 'object' && answer.answer !== undefined) return answer.answer;
      if (answer && typeof answer === 'object' && answer.text !== undefined) return answer.text;
      return answer;
    },

    _normalizeJudgeAnswerValue: function (answer) {
      var raw = String(this._normalizeAnswerValue(answer) || '').trim();
      if (!raw) return '';
      var compact = raw.replace(/\s+/g, '').toLowerCase();
      if (/^(true|yes|y|1|正确|對|对|是|答案[:：]?正确|答案[:：]?对|答案[:：]?是)/i.test(compact)) return 'true';
      if (/^(false|no|n|0|错误|錯|错|否|不正确|答案[:：]?错误|答案[:：]?错|答案[:：]?否)/i.test(compact)) return 'false';
      if (/^a$/i.test(compact)) return 'a';
      if (/^b$/i.test(compact)) return 'b';
      return '';
    },

    _isJudgeOptionMatch: function (item, answer, optionText, dataValue, letterValue) {
      var normalized = this._normalizeJudgeAnswerValue(answer);
      if (!normalized) return false;

      var data = String(dataValue || '').trim().toLowerCase();
      var letter = String(letterValue || '').trim().toLowerCase();
      var text = String(optionText || '').replace(/\s+/g, '').toLowerCase();

      if (normalized === 'a' || normalized === 'b') {
        return letter === normalized || data === normalized;
      }

      var optionBool = '';
      if (/^(true|1|yes|y)$/.test(data) || /^(正确|對|对|是)$/.test(text)) optionBool = 'true';
      if (/^(false|0|no|n)$/.test(data) || /^(错误|錯|错|否|不正确)$/.test(text)) optionBool = 'false';
      return optionBool === normalized;
    },

    _fillAnswers: function (answers, questions, preferredDoc) {
      var normalized = [];
      for (var i = 0; i < answers.length; i++) {
        var item = answers[i];
        if (item && typeof item === 'object' && item.answer !== undefined) {
          normalized.push({ index: item.index != null ? item.index : i, type: item.type, answer: item.answer });
        } else if (item && typeof item === 'object' && Array.isArray(item.answers)) {
          for (var j = 0; j < item.answers.length; j++) normalized.push(item.answers[j]);
        } else {
          normalized.push({ index: i, type: questions[i] ? questions[i].type : 'single', answer: this._normalizeAnswerValue(item) });
        }
      }

      var self = this;
      normalized.forEach(function (answerItem) {
        var question = questions[answerItem.index];
        if (!question || !question._element) return;

        var type = answerItem.type || question.type;
        if (self._wasQuizQuestionAnsweredThisRun(question) && self._getConfirmedCachedQuizAnswer(question, preferredDoc || null)) {
          emitRuntimeLog('info', 'skip llm answer for confirmed correct question', { index: answerItem.index });
          return;
        }
        var finalAnswer = self._avoidKnownWrongAnswer(answerItem.answer, type, question, preferredDoc || null);
        console.log('[Omitone] fill question', answerItem.index, 'type', type, 'answer', finalAnswer);
        if (finalAnswer === null || finalAnswer === undefined || String(finalAnswer).trim() === '') {
          self._clearQuizQuestionAnswer(question);
          self._unmarkQuizQuestionAnsweredThisRun(question);
          return;
        }
        if (type === 'single' || type === 'judge') self._fillChoice(question._element, finalAnswer, 'radio');
        else if (type === 'multiple') self._fillMultiChoice(question._element, finalAnswer);
        else if (type === 'fill') self._fillText(question._element, finalAnswer);
        else if (type === 'short') self._fillTextarea(question._element, finalAnswer);
        var questionDoc = question._element && question._element.ownerDocument ? question._element.ownerDocument : null;
        var filledValue = self._getQuizQuestionFilledValue(preferredDoc || questionDoc || null, question);
        if (filledValue) {
          self._markQuizQuestionAnsweredThisRun(question, 'llm', filledValue, type);
        }
      });
    },

    /**
     * 推断某个选项对应的字母（A/B/C…）。
     *
     * 学习通把字母放在 .num_option 徽标上，但**视频内嵌弹题没有这个徽标** ——
     * 字母只出现在 input 的 value 或选项文本前缀里。1.0.11 只认徽标，
     * 于是弹题场景下 letter 恒为空串，模型回答一个裸字母 "A" 时一个选项都匹配不上，
     * 表现为"AI 问了但从不填空"。这里按可靠度从高到低依次尝试。
     */
    _inferOptionLetter: function (item, index) {
      if (!item) return '';

      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      if (badge) {
        var badgeRaw = String(badge.getAttribute('data') || textOf(badge) || '').trim();
        if (/^[A-F]$/i.test(badgeRaw)) return badgeRaw.toUpperCase();
      }

      var attrs = ['aria-label', 'data', 'data-answer', 'data-value', 'value'];
      for (var a = 0; a < attrs.length; a++) {
        var attr = String((item.getAttribute && item.getAttribute(attrs[a])) || '').trim();
        if (!attr) continue;
        if (/^[A-F]$/i.test(attr)) return attr.toUpperCase();
        var attrMatch = attr.match(/^([A-F])\s*[.、．)）:：]/i);
        if (attrMatch) return attrMatch[1].toUpperCase();
      }

      // <input type="radio" value="A"> —— 原生表单（含弹题）最常见的字母来源
      var input = item.querySelector ? item.querySelector('input') : null;
      if (input) {
        var inputValue = String(input.value || input.getAttribute('value') || '').trim();
        if (/^[A-F]$/i.test(inputValue)) return inputValue.toUpperCase();
        if (/^[A-F]\s*[.、．)）]/.test(inputValue)) return inputValue.charAt(0).toUpperCase();
      }

      // 文本前缀 "A." / "A、" / "(A)"
      var rawText = textOf(item);
      var textMatch = rawText.match(/^\s*\(?\s*([A-F])\s*[.、．)）:：]/);
      if (textMatch) return textMatch[1].toUpperCase();

      return '';
    },

    _matchOptionItem: function (el, answer, forcedType) {
      var items = this._getOptionItems(el);
      if (!items.length) return null;

      var answerStr = String(this._normalizeAnswerValue(answer) || '').trim();
      var answerUpper = answerStr.toUpperCase();
      var isLetterOnly = /^[A-F]$/.test(answerUpper);
      // forcedType：弹窗题的题型由调用方按控件判定好了，
      // 这里再用 _detectQuestionType 重判一遍可能与它不一致（判断题匹配分支因此失效）
      var questionType = forcedType || this._detectQuestionType(el);
      // 位置兜底只在"所有选项都认不出字母"时启用：
      // 学习通的选项永远按 A,B,C… 顺序排列，此时第 n 个就是第 n 个字母。
      // 一旦有任何选项认出了字母，就以认出来的为准，绝不靠位置猜。
      var anyKnownLetter = false;
      for (var p = 0; p < items.length; p++) {
        if (this._inferOptionLetter(items[p], p)) { anyKnownLetter = true; break; }
      }
      var usePositionFallback = !anyKnownLetter && items.length >= 2 && items.length <= 6;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var letter = '';
        var badge = item.querySelector && item.querySelector('.num_option');
        var dataValue = '';
        var labelValue = '';
        if (badge) {
          dataValue = String(badge.getAttribute('data') || '').trim();
          labelValue = String(textOf(badge) || '').trim();
          letter = (/^[A-F]$/i.test(dataValue) ? dataValue : labelValue).toUpperCase();
        }
        if (!letter) letter = this._inferOptionLetter(item, i);
        if (!letter && usePositionFallback) letter = String.fromCharCode(65 + i);

        var optionText = this._extractOptionText(item);
        if (questionType === 'judge' && this._isJudgeOptionMatch(item, answer, optionText, dataValue, letter)) return item;
        if (isLetterOnly && letter === answerUpper) return item;
        if (!isLetterOnly && optionText && (optionText === answerStr || optionText.indexOf(answerStr) !== -1 || answerStr.indexOf(optionText) !== -1)) return item;
      }
      return null;
    },

    _clickOptionItem: function (item, inputType) {
      if (!item) return;
      var doc = item.ownerDocument || document;
      var qid = item.getAttribute && item.getAttribute('qid');
      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      var rawValue = badge ? String(badge.getAttribute('data') || textOf(badge)).trim() : '';
      var letter = /^[A-F]$/i.test(rawValue) ? rawValue.toUpperCase() : rawValue;

      if (qid && badge) {
        if (inputType === 'radio') {
          Array.from(doc.querySelectorAll('.choice' + qid)).forEach(function (node) {
            node.classList.remove('check_answer');
          });
          badge.classList.add('check_answer');
          item.setAttribute('aria-checked', 'true');
          item.setAttribute('aria-pressed', 'true');
          Array.from(item.parentElement ? item.parentElement.children : []).forEach(function (sibling) {
            if (sibling !== item) {
              sibling.setAttribute('aria-checked', 'false');
              sibling.setAttribute('aria-pressed', 'false');
            }
          });
          var hidden = doc.getElementById('answer' + qid);
          if (hidden) {
            hidden.value = letter;
            hidden.dispatchEvent(new Event('input', { bubbles: true }));
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else if (inputType === 'checkbox') {
          var isChecked = badge.classList.contains('check_answer_dx');
          if (isChecked) badge.classList.remove('check_answer_dx');
          else badge.classList.add('check_answer_dx');
          item.setAttribute('aria-checked', isChecked ? 'false' : 'true');
          item.setAttribute('aria-pressed', isChecked ? 'false' : 'true');
          var selected = '';
          Array.from(doc.querySelectorAll('.choice' + qid)).forEach(function (node) {
            if (node.classList.contains('check_answer_dx')) selected += String(node.getAttribute('data') || '').trim();
          });
          var hiddenMulti = doc.getElementById('answer' + qid);
          if (hiddenMulti) {
            hiddenMulti.value = selected;
            hiddenMulti.dispatchEvent(new Event('input', { bubbles: true }));
            hiddenMulti.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }

      var input = item.querySelector ? item.querySelector('input[type="' + inputType + '"]') : null;
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('click', { bubbles: true }));
      }
      try { item.click(); } catch (e) {}
      if (item.querySelector) {
        var clickTarget = item.querySelector('.num_option, .num_option_dx, label, .fl.after');
        if (clickTarget) {
          try { clickTarget.click(); } catch (e2) {}
        }
      }
      console.log('[Omitone] clicked option qid=', qid, 'letter=', letter, 'type=', inputType);
    },

    _fillChoice: function (el, answer, inputType) {
      var item = this._matchOptionItem(el, answer);
      if (item) this._clickOptionItem(item, inputType);
      else console.warn('[Omitone] no matching option for answer', answer, textOf(el).slice(0, 120));
    },

    _clearMultiChoiceSelection: function (el) {
      if (!el) return;
      var doc = el.ownerDocument || document;
      var qid = this._getQuestionIdFromElement(el);
      try {
        var badges = qid ? doc.querySelectorAll('.choice' + qid) : el.querySelectorAll('.num_option_dx, [role="checkbox"]');
        Array.from(badges).forEach(function (node) {
          node.classList.remove('check_answer_dx');
          var item = node.closest ? node.closest('li, label, [role="checkbox"]') : null;
          if (item) {
            item.setAttribute('aria-checked', 'false');
            item.setAttribute('aria-pressed', 'false');
          }
        });
        Array.from(el.querySelectorAll('input[type="checkbox"]')).forEach(function (input) {
          input.checked = false;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        var hidden = qid && doc.getElementById ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = '';
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },

    _fillMultiChoice: function (el, answers) {
      var values = [];
      if (Array.isArray(answers)) {
        values = answers.map(function (item) { return String(item).trim(); });
      } else {
        var raw = String(answers || '').trim();
        if (/^[A-F,，、\s]+$/i.test(raw)) {
          values = raw.replace(/，/g, ',').replace(/、/g, ',').split(',').map(function (item) { return item.trim(); }).filter(Boolean);
          if (values.length === 1 && values[0].length > 1) values = values[0].split('');
        } else {
          values = [raw];
        }
      }

      this._clearMultiChoiceSelection(el);
      for (var i = 0; i < values.length; i++) {
        var item = this._matchOptionItem(el, values[i]);
        if (item) this._clickOptionItem(item, 'checkbox');
      }
    },

    _fillText: function (el, answer) {
      var value = this._normalizeAnswerValue(answer);
      var inputs = Array.from(el.querySelectorAll('input[type="text"], input:not([type])'));
      if (!inputs.length) return;

      var values = [];
      if (Array.isArray(value)) {
        values = value.map(function (item) {
          return String(this._normalizeAnswerValue(item) == null ? '' : this._normalizeAnswerValue(item)).trim();
        }.bind(this));
      } else {
        var raw = String(value == null ? '' : value).trim();
        if (raw.indexOf('|||') !== -1) {
          values = raw.split('|||').map(function (part) { return part.trim(); });
        } else {
          values = [raw];
        }
      }

      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      inputs.forEach(function (input, i) {
        var text = '';
        if (values.length) {
          text = values[i] != null ? values[i] : values[values.length - 1];
        }
        if (setter && setter.set) setter.set.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // 部分页面靠 keyup/blur 监听把可见框内容同步到隐藏答案域
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      });

      // 关键：填空题同样要写隐藏答案域 #answer{qid}，否则插件判定"未填写"不会提交，
      // 提交时平台读隐藏域也会丢答案
      try {
        var doc = el.ownerDocument || document;
        var qid = this._getQuestionIdFromElement(el);
        var hidden = (qid && doc.getElementById) ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = values.join('');
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },

    _fillTextarea: function (el, answer) {
      var value = String(this._normalizeAnswerValue(answer) || '');
      var textareas = Array.from(el.querySelectorAll('textarea'));
      var textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      textareas.forEach(function (textarea) {
        if (textareaSetter && textareaSetter.set) textareaSetter.set.call(textarea, value);
        else textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      });

      var iframes = Array.from(el.querySelectorAll('iframe'));
      iframes.forEach(function (frame) {
        try {
          var body = frame.contentDocument && frame.contentDocument.body;
          if (body) {
            body.innerHTML = '<p>' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
          }
        } catch (e) {}
      });

      // 简答题同样要同步隐藏答案域：平台提交时读的是 #answer{qid}，
      // 只写 textarea/富文本编辑器的话，页面自身 JS 不一定会把内容回填进去。
      try {
        var doc = el.ownerDocument || document;
        var qid = this._getQuestionIdFromElement(el);
        var hidden = (qid && doc.getElementById) ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden && value) {
          hidden.value = value;
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },

    _resolveQuizAnswerDocument: function (preferredDoc) {
      // 最后一个兜底 `|| document` 不能省：题目可能就在顶层文档里（页面没有 #iframe，
      // 或者题目被 _walkDocuments 在更深的 iframe 中找到）。
      // 旧实现此时返回 null，_getQuizQuestionFilledValue 随即返回空串，
      // 于是"答案明明已经填进 DOM 却判定未填写"，_areQuizAnswersFilled 永远 false，
      // 提交被永久阻塞 —— 表现为答题跑完但从不交卷。
      var doc = preferredDoc || this._getMainDocument() || document;
      if (!doc) return null;
      try {
        var innerFrame = doc.getElementById && doc.getElementById('frame_content');
        if (innerFrame) {
          var innerDoc = innerFrame.contentDocument || (innerFrame.contentWindow && innerFrame.contentWindow.document);
          if (innerDoc) return innerDoc;
        }
      } catch (e) {}
      return doc;
    },

    _getQuizQuestionFilledValue: function (preferredDoc, question) {
      var doc = this._resolveQuizAnswerDocument(preferredDoc);
      if (!doc || !question || !question._element) return '';
      var qid = this._getQuestionIdFromElement(question._element);
      if (!qid) return '';
      var hidden = doc.getElementById ? doc.getElementById('answer' + qid) : null;
      var hiddenValue = hidden ? String(hidden.value || '').trim() : '';
      // 隐藏域优先（平台提交时读的就是它），但它为空时必须回退到可见控件：
      // 简答题走的是富文本编辑器，页面自身的 JS 未必把内容同步进隐藏域；
      // 只认隐藏域会导致"明明填了却判定未填写"，从而永远卡住不提交。
      if (hiddenValue) return hiddenValue;
      return this._getQuizAnswerValue(question._element, qid);
    },

    _isQuizQuestionFilled: function (preferredDoc, question) {
      return !!this._getQuizQuestionFilledValue(preferredDoc, question);
    },

    _isQuizQuestionFilledWithKnownWrong: function (preferredDoc, question) {
      if (!question || !question._element) return false;
      var value = this._getQuizQuestionFilledValue(preferredDoc, question);
      if (!value) return false;
      var type = question.type || this._getQuestionTypeFromElement(question._element, this._getQuestionIdFromElement(question._element));
      var canonical = this._canonicalQuizAnswerForQuestion(value, type, question);
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      return !!(canonical && wrongSet.indexOf(canonical) !== -1);
    },

    _clearKnownWrongFilledQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var cleared = 0;
      for (var i = 0; i < questions.length; i++) {
        if (this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) continue;
        if (!this._isQuizQuestionFilledWithKnownWrong(preferredDoc, questions[i])) continue;
        var qid = this._getQuestionIdFromElement(questions[i]._element);
        emitRuntimeLog('warn', 'clear known wrong filled answer', { qid: qid || '', index: questions[i].index });
        this._clearQuizQuestionAnswer(questions[i]);
        this._unmarkQuizQuestionAnsweredThisRun(questions[i]);
        cleared++;
      }
      return cleared;
    },

    _areQuizAnswersFilled: function (preferredDoc, questions, options) {
      var doc = this._resolveQuizAnswerDocument(preferredDoc);
      if (!doc) return false;
      var requireThisRun = !!(options && options.requireThisRun);
      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        var qid = question && question._element ? this._getQuestionIdFromElement(question._element) : '';
        if (!qid) return false;
        var value = this._getQuizQuestionFilledValue(preferredDoc, question);
        console.log('[Omitone] answer field', qid, 'value=', value);
        if (!value) return false;
        if (requireThisRun && !this._wasQuizQuestionAnsweredThisRun(question)) {
          emitRuntimeLog('warn', 'quiz answer value is stale, block submit', { qid: qid });
          return false;
        }
      }
      return true;
    },

    _findButtonByText: function (targets) {
      var texts = Array.isArray(targets) ? targets : [targets];
      var found = null;

      this._walkDocuments(function (doc) {
        var buttons = doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], .btn, [class*="submit"], [class*="confirm"]');
        for (var i = 0; i < buttons.length; i++) {
          var label = String((buttons[i].textContent || buttons[i].value || '')).trim();
          if (!label) continue;
          for (var j = 0; j < texts.length; j++) {
            if (label.indexOf(texts[j]) !== -1) {
              found = buttons[i];
              return true;
            }
          }
        }
        return false;
      });

      return found;
    },

    /**
     * 与 _resolveQuizAnswerDocument 完全相同 —— 答题域和提交域本来就是同一个文档。
     * 保留这个名字是因为调用点很多、语义更清楚；实现上只做转发，
     * 避免两处逻辑各自演化（历史上它们就因为重复实现而分别踩过同一个坑）。
     */
    _resolveQuizSubmitDocument: function (preferredDoc) {
      return this._resolveQuizAnswerDocument(preferredDoc);
    },

    _shouldAutoSubmitQuiz: function (preferredDoc) {
      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      if (!submitDoc) return false;

      try {
        var quizWindow = submitDoc.defaultView || submitDoc.parentWindow;
        if (quizWindow && (typeof quizWindow.btnBlueSubmit === 'function' || typeof quizWindow.submitCheckTimes === 'function')) {
          return true;
        }
      } catch (e) {}

      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1) return true;
      return !!submitDoc.querySelector('.btnSubmit, .bluebtn, .workBtnIndex, #form1');
    },

    _maybeSubmitQuiz: function (preferredDoc, questions) {
      var submitQuestions = questions || this._quizCurrentQuestions;
      var questionDoc = this._getQuizDocumentFromQuestions(submitQuestions);
      var effectiveDoc = preferredDoc || questionDoc || null;
      if (!this._shouldAutoSubmitQuiz(effectiveDoc)) {
        console.log('[Omitone] auto submit skipped');
        return false;
      }
      var submitDoc = this._resolveQuizSubmitDocument(effectiveDoc);
      var currentKey = this._getQuizWorkKey(effectiveDoc || submitDoc);
      if (this._shouldSkipQuizBySubmitAttempts(effectiveDoc || submitDoc)) {
        return this._forceSkipQuizAfterMaxAttempts(effectiveDoc || submitDoc);
      }
      if (submitQuestions && this._clearKnownWrongFilledQuizAnswers(submitQuestions, effectiveDoc || submitDoc) > 0) {
        emitRuntimeLog('warn', 'block quiz submit because known wrong answers were cleared');
        this._quizAnswered = false;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return false;
      }
      if (submitQuestions && !this._areQuizAnswersFilled(effectiveDoc || submitDoc, submitQuestions, { requireThisRun: true })) {
        emitRuntimeLog('warn', 'block quiz submit because answers are not ready');
        this._quizAnswered = false;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return false;
      }
      if (!this._quizReadyToSubmit || (this._quizReadyWorkKey && this._quizReadyWorkKey !== currentKey)) {
        emitRuntimeLog('warn', 'block quiz submit without ready state', { key: currentKey });
        this._quizAnswered = false;
        return false;
      }
      if (submitQuestions) {
        this._rememberSubmittedQuizAnswers(submitQuestions, effectiveDoc || submitDoc);
      }
      var now = Date.now();
      if (this._quizSubmitPending) return true;
      if (this._quizLastSubmitAttemptAt && now - this._quizLastSubmitAttemptAt < 3000) return true;

      var self = this;
      if (submitDoc) {
        try {
          var quizWindow = submitDoc.defaultView || submitDoc.parentWindow;
          if (quizWindow && typeof quizWindow.btnBlueSubmit === 'function') {
            console.log('[Omitone] call btnBlueSubmit()');
            this._markQuizSubmitPending(effectiveDoc || submitDoc, 'btnBlueSubmit');
            setTimeout(function () {
              try { quizWindow.btnBlueSubmit(); } catch (e) { console.error('[Omitone] btnBlueSubmit failed', e); }
            }, 300);

            setTimeout(function () {
              try {
                var maybePop = document.getElementById('workpop');
                if (maybePop && visible(maybePop)) {
                  var okBtn = maybePop.querySelector('#popok');
                  if (okBtn) {
                    console.log('[Omitone] confirm submit via #popok');
                    okBtn.click();
                  }
                }
              } catch (e2) {}
            }, 1200);
            return true;
          }
        } catch (directErr) {
          console.error('[Omitone] direct quiz submit failed', directErr);
        }
      }

      var submit = this._findButtonByText(['提交', '交卷', '完成']);
      if (!submit) return false;
      this._markQuizSubmitPending(effectiveDoc || submitDoc, 'submit-button');
      setTimeout(function () {
        try { submit.click(); } catch (e) {}
      }, 300);

      setTimeout(function () {
        var confirm = self._findButtonByText(['确认', '确定', '提交', '交卷']);
        if (confirm) {
          try { confirm.click(); } catch (e2) {}
        }
      }, 900);

      return true;
    },

    _isSubmitConfirmDialog: function (node) {
      if (!node || !visible(node)) return false;
      var dialogText = textOf(node);
      var id = String(node.id || '');
      var cls = String(node.className || '');
      if (id === 'confirmSubWin') return true;
      if (id === 'workpop' && node.querySelector('#popok') && node.querySelector('#popcontent')) return true;
      if (cls.indexOf('AlertCon02') !== -1) {
        if (node.querySelector('[onclick*="submitCheckTimes"], .bluebtn, .btnSubmit, .workBtnIndex')) return true;
      }
      if (node.querySelector && node.querySelector('#popok') && node.querySelector('#popcontent')) return true;
      if (node.getAttribute && node.getAttribute('role') === 'alertdialog') {
        if (node.querySelector('[onclick*="submitCheckTimes"], .bluebtn')) return true;
      }
      if (!dialogText) return false;
      return /确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(dialogText);
    },

    _findDialogButtonByText: function (root, targets) {
      if (!root) return null;
      var texts = Array.isArray(targets) ? targets : [targets];
      var buttons = root.querySelectorAll('button, a, input[type="button"], input[type="submit"], .btn, [class*="submit"], [class*="confirm"]');
      for (var i = 0; i < buttons.length; i++) {
        if (!visible(buttons[i])) continue;
        var label = String((buttons[i].textContent || buttons[i].value || '')).trim();
        if (!label) continue;
        for (var j = 0; j < texts.length; j++) {
          if (label.indexOf(texts[j]) !== -1) return buttons[i];
        }
      }
      var wantsSubmit = texts.some(function (text) {
        return /提交|确定|确认|交卷|完成/.test(text);
      });
      if (wantsSubmit) {
        var structural = root.querySelector('#popok, [onclick*="submitCheckTimes"], .bluebtn[role="button"], .bluebtn, .btnSubmit');
        if (structural && visible(structural)) return structural;
      }
      return null;
    },

    _checkSubmitConfirmDialog: function () {
      var selectors = [
        '#workpop',
        '#confirmSubWin',
        '.AlertCon02',
        '.layui-layer',
        '.el-message-box',
        '.ant-modal',
        '.dialog',
        '.modal',
        '[role="dialog"]',
        '[role="alertdialog"]'
      ];

      function searchAll(doc, depth) {
        if (!doc || depth > 3) return null;
        for (var i = 0; i < selectors.length; i++) {
          var nodes = doc.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            if (app._isSubmitConfirmDialog(nodes[j])) return nodes[j];
          }
        }

        var frames = doc.querySelectorAll('iframe');
        for (var k = 0; k < frames.length; k++) {
          try {
            var subDoc = frames[k].contentDocument || (frames[k].contentWindow && frames[k].contentWindow.document);
            var found = searchAll(subDoc, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
        return null;
      }

      try {
        var startDoc = this._getMainDocument() || document;
        return searchAll(startDoc, 0) || searchAll(document, 0);
      } catch (e2) {
        return null;
      }
    },

    _handleSubmitConfirmDialog: function (dialog) {
      if (!dialog) return false;
      var now = Date.now();
      if (now - this._submitConfirmLastClickAt < 400) return true;

      var submitBtn = this._findDialogButtonByText(dialog, ['提交', '确定', '确认', '交卷', '完成']);
      if (!submitBtn) return false;

      this._submitConfirmLastClickAt = now;
      console.log('[Omitone] confirm final submit');
      var dialogText = textOf(dialog);
      if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(dialogText)) {
        this._rememberCorrectQuizAnswers(null);
        this._rememberWrongQuizAnswers(null);
        this._quizSubmitPending = false;
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
      } else if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(dialogText) || this._hasActiveQuizSubmitForm(null)) {
        var currentKey = this._getQuizWorkKey(null);
        var readyForConfirm = this._quizReadyToSubmit || this._quizSubmitPending || this._quizAnswered;
        if (!readyForConfirm) {
          emitRuntimeLog('warn', 'wait submit confirm until quiz ready', { key: currentKey });
          this._submitConfirmLastClickAt = 0;
          return true;
        }
        if (this._quizReadyWorkKey && currentKey && this._quizReadyWorkKey !== currentKey) {
          // 良性：提交确认弹窗出现时 URL 可能已变化（如加了时间戳参数），
          // 但测验本身已就绪，按设计继续提交。降为 info 避免被当成故障线索。
          emitRuntimeLog('info', 'submit confirm key mismatch, continue because quiz is ready', { readyKey: this._quizReadyWorkKey, key: currentKey });
        }
        this._markQuizSubmitPending(null, 'confirm-dialog');
      }
      try { submitBtn.click(); } catch (e) {}
      return true;
    },

    /**
     * 找「继续学习」按钮。
     *
     * 学习通在几种情况下会在**播放器右下角**挂一个「继续学习」：弹题答完之后、
     * 视频被判定为挂机之后、或者从插题回到正常播放之前。**不点它进不去正常播放页**，
     * 于是一切照常跑、课程一动不动 —— 和弹题空转是同一类"看着在忙其实卡住"的故障。
     *
     * 这个按钮没有稳定的类名（不同课程模板不一样），只能靠文案 + 位置 + 形态打分：
     * 文案命中「继续学习/继续观看/继续播放」→ 只接受"按钮样"的小节点（避免点到大容器）
     * → 与视频同文档的加分、本身是 button/a 的加分。
     */
    /**
     * 处理完一个覆盖层（弹题 / 「继续学习」）之后把视频拉起来。
     *
     * 两个分支原本各写一份，逻辑稍有出入就会出现"弹题这条能恢复、继续学习那条不能"
     * 这种只在真机上才看得出的差别 —— 抽出来保证两条路走的是同一套动作。
     * 注意只在 `_isPlaying` 时恢复：用户没开刷课时不该替他播。
     */
    _resumeVideoAfterOverlay: function (reason) {
      if (!this._isPlaying) return;
      var video = this._getVideoEl();
      if (!video || !video.paused) return;
      this._ensurePlaybackRate(video, reason || 'overlay');
      try { video.play(); } catch (e) {}
    },

    _findContinueStudyButton: function (video) {
      if (video === undefined) {
        try { video = this._getVideoEl(); } catch (e) { video = null; }
      }
      var videoDoc = video && video.ownerDocument ? video.ownerDocument : null;

      var texts = ['继续学习', '继续观看', '继续播放'];
      var best = null;
      var bestScore = -1;

      this._walkDocuments(function (doc) {
        var nodes = [];
        try {
          nodes = Array.from(doc.querySelectorAll(
            'a, button, .btn, [class*="btn"], [class*="continue"], [class*="study"], span, div'
          ));
        } catch (e) { return false; }

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          // 先做便宜的文案比对，再判可见性：
          // visible() 会读 offsetParent / getBoundingClientRect，触发强制重排，
          // 对每个 div/span 都调一遍在真实页面上是很可观的一笔开销
          var label = String((node.textContent || node.value || '')).replace(/\s+/g, '').trim();
          if (!label) continue;

          var hit = -1;
          for (var t = 0; t < texts.length; t++) {
            if (label.indexOf(texts[t]) !== -1) { hit = t; break; }
          }
          if (hit === -1) continue;
          if (!visible(node)) continue;
          // 只接受文案很短的节点：整块浮层/面板的文字远不止这几个字，
          // 命中它说明这只是容器，点容器通常什么也不会发生
          if (label.length > 12) continue;

          var score = 0;
          if (videoDoc && doc === videoDoc) score += 4;
          var tag = String(node.tagName || '').toLowerCase();
          if (tag === 'button' || tag === 'a' || tag === 'input') score += 3;
          var cls = String(node.className || '');
          if (/btn|button|continue|study|resume/i.test(cls)) score += 2;
          if (node.getAttribute && (node.getAttribute('onclick') || node.getAttribute('role'))) score += 1;
          // 叶子节点优先：真正的按钮通常不含子元素，而外层容器带着标题/说明文字。
          // 站点把 onclick 挂在按钮上，点到容器是没反应的 —— 这一分决定了会不会白点。
          if (!node.children || node.children.length === 0) score += 2;
          score -= hit; // 「继续学习」优先于「继续观看/继续播放」

          if (score > bestScore) { bestScore = score; best = node; }
        }
        return false;
      });

      return bestScore >= 0 ? best : null;
    },

    /**
     * 看到「继续学习」就点一下。返回是否点过。
     *
     * 三道保险：① **扫描节流**（遍历所有文档的 div/span 不便宜，而 tick 每 250ms 一轮，
     * 视频正在正常播放时更是没必要，放到 6 秒一次）；② 同一按钮 3 秒内只点一次；
     * ③ 同一个按钮连点 5 次还在，说明点了没反应（不是我们要找的 / 页面另有机关），
     * 停 60 秒并写日志 —— 免得把"点不动的按钮"变成新的空转源。
     */
    _tryContinueStudyPrompt: function () {
      var now = Date.now();
      if (now < (this._continueStudyBlockedUntil || 0)) return false;

      var scanVideo = null;
      try { scanVideo = this._getVideoEl(); } catch (e) { scanVideo = null; }
      var scanInterval = (scanVideo && !scanVideo.paused) ? 6000 : 1200;
      if (now - (this._continueStudyScanAt || 0) < scanInterval) return false;
      this._continueStudyScanAt = now;

      if (now - (this._continueStudyAt || 0) < 3000) return false;

      // 把已经取到的 video 传下去，省掉 _findContinueStudyButton 里的第二次全文档查找
      var btn = this._findContinueStudyButton(scanVideo);
      if (!btn) {
        if (this._continueStudyKey) {
          this._continueStudyKey = '';
          this._continueStudyClicks = 0;
        }
        return false;
      }

      var key = String(btn.className || '') + '|' + textOf(btn).slice(0, 30);
      if (key === this._continueStudyKey) this._continueStudyClicks++;
      else {
        this._continueStudyKey = key;
        this._continueStudyClicks = 1;
      }

      if (this._continueStudyClicks > 5) {
        emitRuntimeLog('warn', 'continue-study button did not respond, stop clicking', {
          text: textOf(btn).slice(0, 30),
          clicks: this._continueStudyClicks
        });
        this._continueStudyBlockedUntil = now + 60000;
        this._continueStudyKey = '';
        this._continueStudyClicks = 0;
        return false;
      }

      emitRuntimeLog('info', 'click continue-study prompt', {
        text: textOf(btn).slice(0, 30),
        cls: String(btn.className || '').slice(0, 60)
      });
      try {
        if (typeof btn.click === 'function') btn.click();
        else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (e) {}
      this._continueStudyAt = now;
      return true;
    },

    /**
     * 取"应该拦住刷课流程"的弹窗题。
     *
     * 与 _checkPopupQuiz 的区别：多了"放弃窗口"。弹题一旦答不上来（结构不认识 /
     * 选项匹配不上），弹窗不会自动消失，而 tick 每 250ms 一轮 —— 没有这个窗口，
     * 同一道题会被无限次发给模型，同时把后面的刷课逻辑全挡住，课程就此空转。
     * 所有"有弹窗就别动"的判断都必须走这里，不能直接用 _checkPopupQuiz。
     */
    _activePopupBlock: function () {
      var now = Date.now();
      if (this._popupQuizBlockedUntil && now < this._popupQuizBlockedUntil) {
        // 放弃窗口一旦生效就立刻作废缓存：否则接下来几百毫秒还会拿到旧弹窗，
        // 已经清空的计数又会被重新累加，"放弃"形同虚设
        this._popupBlockCheckedAt = 0;
        this._popupBlockCached = null;
        return null;
      }
      // _checkPopupQuiz 要遍历所有文档，而 tick 每 250ms 一轮。
      // 400ms 内复用上一次的结果：弹窗不会在这个尺度上凭空出现又消失。
      // 缓存的是**经过下面两道判断之后**的结果，所以"已答放行"不会被缓存绕过。
      if (this._popupBlockCheckedAt && now - this._popupBlockCheckedAt < 400) {
        return this._popupBlockCached || null;
      }

      var node = null;
      try { node = this._checkPopupQuiz(); } catch (e) { node = null; }
      if (!node) {
        // 弹窗没了就清掉计数，下一次弹出的是新题，重新给满次数
        this._popupQuizKey = '';
        this._popupQuizAttempts = 0;
        this._popupQuizSolvedKey = '';
        this._popupQuizWrongAnswers = [];
        this._popupQuizLastFilled = '';
      } else {
        // 已经答过、但站点还没把弹窗收走：别再问第二遍模型，也别继续拦着刷课
        var key = this._popupQuizFingerprint(node);
        if (key === this._popupQuizSolvedKey && now - (this._popupQuizSolvedAt || 0) < 30000) {
          node = null;
        }
      }

      this._popupBlockCheckedAt = now;
      this._popupBlockCached = node;
      return node;
    },

    /**
     * 弹题的**稳定指纹** —— 判断"还是不是同一道题"。
     *
     * ⚠️ 不能用整段文本当指纹。站点答错后会在弹窗里**加一行反馈**
     * （"回答错误，请重新作答"），文本一变指纹就变，于是 `_popupQuizAttempts`
     * 被重置成 1 —— "最多问 3 次就放手"这个安全阀**永远不会触发**，
     * 表现就是：答错之后一直重问模型、弹窗关不掉、看着像卡死，而且**不会自己恢复**
     * （60 秒冷却是 `_giveUpPopupQuiz` 设的，它根本没被调用）。
     *
     * 所以指纹改取**选项文本**：答错反馈只会加在题干或底部，不会改选项。
     * 没有选项（填空题）时退回文本，但先剥掉常见反馈短语。
     *
     * 注意 `_activePopupBlock` 里的"已答放行"判断也用它，两边必须同一个函数，
     * 否则 `_popupQuizSolvedKey` 对不上，已答过的弹窗会被反复重问。
     */
    _popupQuizFingerprint: function (popup, optionItems) {
      var cls = String((popup && popup.className) || "");
      try {
        var opts = optionItems || this._getOptionItems(popup) || [];
        var texts = opts.map(this._extractOptionText.bind(this)).filter(Boolean).join(String.fromCharCode(1));
        if (texts) return cls + "|o|" + texts.slice(0, 240);
      } catch (e) {}
      var raw = "";
      try { raw = textOf(popup); } catch (e2) {}
      raw = raw.replace(/回答错误|答案错误|请重新作答|重新作答|再试一次|不正确|提交失败/g, "").replace(/\s+/g, "");
      return cls + "|t|" + raw.slice(0, 120);
    },

    _getPopupQuizMaxAttempts: function () {
      var max = Number(this.configs && this.configs.popupQuizMaxAttempts);
      return max > 0 ? max : 3;
    },

    _describePopupQuiz: function (popup, optionItems) {
      try {
        if (!optionItems) optionItems = this._getOptionItems(popup);
        return {
          cls: String(popup.className || '').slice(0, 120),
          text: textOf(popup).slice(0, 200),
          optionCount: optionItems.length,
          optionTexts: optionItems.slice(0, 6).map(this._extractOptionText.bind(this)),
          optionLetters: optionItems.slice(0, 6).map(this._inferOptionLetter.bind(this)),
          html: String(popup.outerHTML || '').replace(/\s+/g, ' ').slice(0, 900)
        };
      } catch (e) {
        return { cls: String(popup && popup.className || ''), error: String(e && e.message || e) };
      }
    },

    _checkPopupQuiz: function () {
      var selectors = [
        '.ans-pop-quiz',
        '.pop-quiz',
        '.video-quiz',
        '.ans-job-pop',
        '.ans-topic',
        '.vjs-overlay',
        '.ans-attach',
        '.popDiv',
        '.layui-layer',
        '[class*="pop"][class*="quiz"]',
        '[class*="question"][class*="pop"]'
      ];

      function searchAll(doc, depth) {
        if (!doc || depth > 3) return null;

        for (var i = 0; i < selectors.length; i++) {
          var node = doc.querySelector(selectors[i]);
          if (node && app._isSubmitConfirmDialog(node)) continue;
          // 播放器容器 / 含 video 的浮层（水印、广告、倍速提示）不是题。
          // .vjs-overlay 这类选择器极易命中视频浮层，误判后插件会把它当题反复问模型。
          if (node && node.querySelector && node.querySelector('video')) continue;
          if (node && visible(node) && textOf(node).length > 5) return node;
        }

        var sections = doc.querySelectorAll('div, section');
        for (var j = 0; j < sections.length; j++) {
          if (!visible(sections[j])) continue;
          if (sections[j].querySelector && sections[j].querySelector('video')) continue;
          var sectionText = textOf(sections[j]);
          if (sectionText.length > 20 && sectionText.length < 600 && /[A-F][.、．))]/.test(sectionText)) {
            var button = sections[j].querySelector('button, .btn, [class*="submit"], [class*="confirm"], [class*="ans-btn"]');
            // 宽泛兜底必须同时看到"可点的选项"：只有一段像题目的文字 + 一个按钮
            // 不足以证明这是道题，否则课程目录/知识点面板都会被当成弹窗题。
            var optionish = sections[j].querySelector(
              'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], li, label'
            );
            if (button && optionish) return sections[j];
          }
        }

        var frames = doc.querySelectorAll('iframe');
        for (var k = 0; k < frames.length; k++) {
          try {
            var subDoc = frames[k].contentDocument || (frames[k].contentWindow && frames[k].contentWindow.document);
            var found = searchAll(subDoc, depth + 1);
            if (found) return found;
          } catch (e) {}
        }

        return null;
      }

      try {
        var startDoc = this._getMainDocument() || document;
        var foundNode = searchAll(startDoc, 0) || searchAll(document, 0);
        if (foundNode) {
          // 验证码弹窗可能被误认成弹窗题（layui-layer 是两者的共同容器）：
          // 含"验证码/校验码"字样的一律不当题处理，交给验证码检测
          if (/验证码|校验码/.test(textOf(foundNode))) return null;
        }
        return foundNode;
      } catch (e) {
        return null;
      }
    },

    _handlePopupQuiz: async function (popup) {
      var popupText = textOf(popup);
      if (popupText === '知道了' || popupText === '关闭' || popupText === '确定') {
        popup.click();
        return;
      }

      // 同一道弹题的指纹：弹窗没关就一定是同一道。换题（文本变了）才重新计数。
      var key = this._popupQuizFingerprint(popup);
      if (key === this._popupQuizKey) {
        this._popupQuizAttempts++;
        // 走到这里说明：同一道题、弹窗还在 —— 上一轮填进去的答案没被平台接受，
        // 那就是错的。记下来，本轮带给模型让它换个答案。
        // （只在**确认没通过**时才记，所以不会把「其实答对了、只是弹窗关得慢」的答案误禁。）
        if (this._popupQuizLastFilled) {
          if (!this._popupQuizWrongAnswers) this._popupQuizWrongAnswers = [];
          if (this._popupQuizWrongAnswers.indexOf(this._popupQuizLastFilled) === -1) {
            this._popupQuizWrongAnswers.push(this._popupQuizLastFilled);
          }
          this._popupQuizLastFilled = '';
        }
      } else {
        this._popupQuizKey = key;
        this._popupQuizAttempts = 1;
        this._popupQuizWrongAnswers = [];
        this._popupQuizLastFilled = '';
      }

      var maxAttempts = this._getPopupQuizMaxAttempts();
      if (this._popupQuizAttempts > maxAttempts) {
        this._giveUpPopupQuiz(popup, 'attempts-exceeded');
        return;
      }

      if (!this._isQuizApiUnavailable()) {
        var optionItems = this._getOptionItems(popup);
        // 题型不能靠"题干里有没有'正确/判断'这几个字"来猜 ——
        // "下列说法正确的是？"是单选题，却因为含"正确"被判成判断题，
        // 模型随之收到错误的题型并回 true/正确，而选项里根本没有这个文本，
        // 于是一个都匹配不上（这就是"扫描了但从不填空"的另一种形态）。
        // 可靠依据只有两个：控件类型（复选=多选、文本框=填空）和选项文本。
        var type = this._detectPopupQuizType(popup, optionItems);

        var question = {
          index: 0,
          type: type,
          title: popupText.slice(0, 300),
          options: [],
          // ⚠️ 必须带：不带的话每轮重试都是**一模一样的请求**，模型自然每轮都回
          // 同一个答案（实测表现就是「答错之后一直选 D」），重试等于白问。
          // 普通答题路径一直带着它（见 _requestAnswers），弹题这条路原先漏了。
          previousWrongAnswers: (this._popupQuizWrongAnswers || []).slice()
        };

        question.options = optionItems.map(this._extractOptionText.bind(this)).filter(Boolean);

        try {
          var result = await bridgeSend('llm_request', { questions: [question] });
          if (result && result.success && result.data) {
            var answer = Array.isArray(result.data) ? result.data[0] : result.data;
            var filled = this._fillPopupAnswer(popup, answer, type);
            if (filled) {
              // 填进去了。此时弹窗多半还挂在 DOM 上（站点异步关闭），
              // 记下指纹让 _activePopupBlock 把它当"已处理"放行，
              // 否则下一轮 tick 会把同一道题再问一遍模型。
              this._popupQuizSolvedKey = key;
              this._popupQuizSolvedAt = Date.now();
              this._popupQuizAttempts = 0;
              this._popupQuizBlockedUntil = 0;
              // 把「模型答了什么 + 实际匹配到哪个选项 + 选项原文」打进日志。
              // 现场报过「四个选项的题正确答案是 A，却一直选 D」，光看代码猜不出来 ——
              // 这条日志就是为了下次复现时能直接看出是模型答错还是匹配错。
              emitRuntimeLog('info', 'popup quiz answered', {
                attempt: this._popupQuizAttempts,
                rawAnswer: String(this._normalizeAnswerValue(answer) || '').slice(0, 60),
                type: type,
                optionCount: question.options.length,
                options: question.options.slice(0, 6)
              });
              // 记下这轮填的答案。下一轮如果同一道题还在，就说明它没被接受。
              this._popupQuizLastFilled = String(this._normalizeAnswerValue(answer) || '');
              return;
            }
            // 模型答了但匹配不到任何选项：这是"空转"的真正成因，
            // 必须把选项结构打进日志，否则只能靠猜
            if (Date.now() - (this._popupQuizLogAt || 0) > 5000) {
              this._popupQuizLogAt = Date.now();
              emitRuntimeLog('error', 'popup quiz answer matched no option', {
                attempt: this._popupQuizAttempts,
                maxAttempts: maxAttempts,
                answer: String(this._normalizeAnswerValue(answer) || '').slice(0, 80),
                options: this._describePopupQuiz(popup, optionItems)
              });
            }
            return;
          }
          if (result && result.parseError) {
            emitRuntimeLog('warn', 'popup quiz llm parse failed, keep popup for retry', {
              error: String(result.error || '').slice(0, 160)
            });
            this._quizForceSkipUntil = Date.now() + 8000;
            return;
          }
          this._markQuizApiConnectionFailed(result && result.error ? result.error : '弹窗题 LLM 请求失败');
        } catch (e) {
          this._markQuizApiConnectionFailed(e);
        }
      }

      emitRuntimeLog('warn', 'skip popup quiz because api unavailable', { reason: this._getQuizApiUnavailableReason() || 'llm-request-failed' });
      var closeButton = this._findDialogButtonByText(popup, ['跳过', '关闭', '取消', '知道了']);
      if (closeButton) {
        try { closeButton.click(); } catch (e2) {}
        return;
      }
      this._skipQuizForApiUnavailable(null, null);
    },

    /**
     * 放弃这道弹题。
     *
     * 只能放弃"继续问模型"，不能放弃"让课程继续"—— 所以顺序是：
     * 先把弹窗本身关掉（跳过/关闭），关不掉就进入冷却期，让 tick 不再拦住播放与跳章。
     * 冷却是 60 秒而不是永久：万一弹窗其实是可答的（比如只是模型抽风），还能再试。
     */
    _giveUpPopupQuiz: function (popup, reason) {
      emitRuntimeLog('error', 'popup quiz unanswerable, stop asking model', {
        reason: reason || 'unknown',
        attempts: this._popupQuizAttempts,
        snapshot: this._describePopupQuiz(popup)
      });

      var closeButton = this._findDialogButtonByText(popup, ['跳过', '关闭', '取消', '知道了', '下次再说']);
      if (closeButton) {
        try { closeButton.click(); } catch (e) {}
      }

      this._popupQuizKey = '';
      this._popupQuizAttempts = 0;
      this._popupQuizWrongAnswers = [];
      this._popupQuizLastFilled = '';
      this._popupQuizBlockedUntil = Date.now() + 60000;
    },

    /**
     * 弹窗题的题型判定。
     * 先按控件形态走 _detectQuestionType，再对"判断题"做一次选项校验：
     * 真判断题的选项必然是"正确/错误"这类两两对立的表述，
     * 只看题干关键字（含"正确"二字）会把普通单选题误判成判断题。
     */
    _detectPopupQuizType: function (popup, optionItems) {
      var type = this._detectQuestionType(popup);
      if (type !== 'judge') return type;
      var texts = (optionItems || []).map(this._extractOptionText.bind(this));
      var looksJudge = texts.length === 2 && texts.every(function (t) {
        return /^(正确|错误|對|錯|错|对|是|否|true|false|t|f)$/i.test(String(t || '').trim());
      });
      return looksJudge ? 'judge' : 'single';
    },

    /** 返回是否真的选中了至少一个选项（没选中就不该点提交） */
    _fillPopupAnswer: function (popup, answer, type) {
      var value = this._normalizeAnswerValue(answer);
      var selected = 0;
      var inputType = type === 'multiple' ? 'checkbox' : 'radio';
      if (!type) {
        inputType = Array.from(popup.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).length ? 'checkbox' : 'radio';
      }

      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          var item = this._matchOptionItem(popup, value[i], type);
          if (item) {
            this._clickOptionItem(item, inputType);
            selected++;
          }
        }
      } else {
        var target = this._matchOptionItem(popup, value, type);
        if (target) {
          this._clickOptionItem(target, inputType);
          selected++;
        }
      }

      // 视频里弹出的也可能是填空题：没有选项可点，但一定有输入框。
      // 少了这一段，填空题会被当成"匹配不到选项"而反复重试直到放弃。
      if (!selected) {
        var hasTextInput = !!popup.querySelector('input[type="text"], input:not([type])');
        var hasTextarea = !!popup.querySelector('textarea');
        if (hasTextInput || hasTextarea) {
          if (hasTextInput) this._fillText(popup, value);
          if (hasTextarea) this._fillTextarea(popup, value);
          selected = 1;
        }
      }

      if (!selected) return false;

      // 空答点提交没有任何意义：站点只会回一句"请选择答案"，弹窗原地不动，
      // 于是下一轮再来一次 —— 空转就是这么来的。
      var submit = this._findDialogButtonByText(popup, ['提交', '确定', '确认', '交卷', '完成'])
        || popup.querySelector('button, .btn, [class*="submit"], [class*="confirm"]');
      if (submit) {
        try { submit.click(); } catch (e) {}
      }
      return true;
    }
  };

  function removeStartPanel() {
    var panel = document.getElementById('xxt-panel');
    if (panel) panel.remove();
  }

  function showStartPanel(config) {
    removeStartPanel();

    var currentConfig = mergeConfig(config);
    var hasApiKey = !!String(currentConfig.apiKey || '').trim();
    var playOn = currentConfig.autoNext !== false;
    var quizOn = !!(currentConfig.enableQuiz && hasApiKey);

    var panel = document.createElement('div');
    panel.id = 'xxt-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'z-index:999999',
      'background:#fff',
      'border:1px solid #ddd',
      'border-radius:10px',
      'padding:24px',
      'min-width:280px',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.12)',
      'color:#111'
    ].join(';');

    function renderToggle(on) {
      return '<span style="display:inline-flex;width:36px;height:20px;background:' + (on ? '#111' : '#ddd') + ';border-radius:20px;position:relative;">' +
        '<span style="position:absolute;top:2px;left:' + (on ? '18px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:#fff;"></span>' +
        '</span>';
    }

      panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">' +
        '<strong style="font-size:15px;">' + APP_NAME + '</strong>' +
        '<span style="font-size:11px;color:#999;">page runtime</span>' +
      '</div>' +
      '<div id="xxt-row-play" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;">' +
        '<span>自动连播</span>' +
        '<span id="xxt-toggle-play">' + renderToggle(playOn) + '</span>' +
      '</div>' +
      '<div id="xxt-row-quiz" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;' + (hasApiKey ? 'cursor:pointer;' : 'opacity:.45;') + '">' +
        '<span>自动答题</span>' +
        '<span id="xxt-toggle-quiz">' + (hasApiKey ? renderToggle(quizOn) : '<span style="font-size:11px;color:#999;">需 API Key</span>') + '</span>' +
      '</div>' +
      '<button id="xxt-btn-start" style="width:100%;margin-top:16px;padding:10px 0;border:none;border-radius:6px;background:#111;color:#fff;font-weight:600;cursor:pointer;">开始</button>' +
      '<button id="xxt-btn-close" style="width:100%;margin-top:8px;padding:9px 0;border:1px solid #e6e6e6;border-radius:6px;background:#fff;color:#666;cursor:pointer;">关闭</button>';

    document.body.appendChild(panel);

    function updatePlay() {
      var slot = document.getElementById('xxt-toggle-play');
      if (slot) slot.innerHTML = renderToggle(playOn);
    }

    function updateQuiz() {
      var slot = document.getElementById('xxt-toggle-quiz');
      if (slot && hasApiKey) slot.innerHTML = renderToggle(quizOn);
    }

    document.getElementById('xxt-row-play').addEventListener('click', function () {
      playOn = !playOn;
      updatePlay();
    });

    if (hasApiKey) {
      document.getElementById('xxt-row-quiz').addEventListener('click', function () {
        quizOn = !quizOn;
        updateQuiz();
      });
    }

    document.getElementById('xxt-btn-start').addEventListener('click', function () {
      panel.remove();
      app.configs = mergeConfig(Object.assign({}, currentConfig, { autoNext: playOn, enableQuiz: quizOn && hasApiKey }));
      app.run();
      window._xxtApp = app;
    });

    document.getElementById('xxt-btn-close').addEventListener('click', function () {
      panel.remove();
      window._xxtApp = app;
    });
  }

  function shouldAutoStart() {
    var root = document.documentElement;
    if (!root) return false;
    var flag = root.getAttribute(AUTO_START_ATTR) === '1';
    if (flag) root.removeAttribute(AUTO_START_ATTR);
    return flag;
  }

  var defaultConfig = mergeConfig({ apiKey: '', autoNext: true, enableQuiz: false });
  app.configs = defaultConfig;
  window._xxtApp = app;

  bridgeSend('get_config').then(function (config) {
    app.configs = mergeConfig(config || defaultConfig);
    // 只有"刷课进行中"（有续跑标记）时才自动开始——讨论页/验证码页也一样，
    // 避免没在刷课时打开讨论区就被自动发评论
    if (shouldAutoStart()) {
      app.run();
      return;
    }
    // 未刷课时进入讨论页/独立验证码页：保持静默，不显示面板、不做任何操作
    if (app._isDiscussionContext() || app._isStandaloneCaptchaPage()) return;
    if (app._getMainFrame()) showStartPanel(app.configs);
  }).catch(function () {
    if (shouldAutoStart()) {
      app.run();
      return;
    }
    if (app._isDiscussionContext() || app._isStandaloneCaptchaPage()) return;
    if (app._getMainFrame()) showStartPanel(defaultConfig);
  });

  var preventPause = function (event) {
    event.stopPropagation();
    event.preventDefault();
  };

  var resumeNow = function () {
    if (app && typeof app._tryResumePlayback === 'function') app._tryResumePlayback('page-event');
  };

  document.addEventListener('mouseleave', preventPause);
  window.addEventListener('mouseleave', preventPause);
  document.addEventListener('mouseout', preventPause);
  window.addEventListener('mouseout', preventPause);
  window.addEventListener('blur', resumeNow);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) resumeNow();
  });

  window.xxtAI = {
    reload: function () {
      bridgeSend('get_config').then(function (config) {
        app.configs = mergeConfig(config || defaultConfig);
        showStartPanel(app.configs);
      });
    },
    next: function () {
      if (app) app.nextUnit();
    },
    skipQuiz: function () {
      if (app) app._skipQuiz();
    },
    /**
     * 题目扫描诊断。扫不到题时在页面控制台执行 `xxtAI.diagnose()`，
     * 返回值会直接打印出来，同时写入运行日志（popup → 查看日志 可以看到）。
     * 把这段输出发出来就能定位是哪一环断了。
     */
    diagnose: function () {
      if (!app) return null;
      var report = app._diagnoseQuestionScan(null);
      emitRuntimeLog('info', 'quiz scan diagnosis (manual)', report);
      console.log('[Omitone] quiz scan diagnosis:', report);
      console.log(JSON.stringify(report, null, 2));
      return report;
    },
    /** 手动跑一次题目抽取，返回抽到的题目数组（不答题、不提交）。 */
    scanQuiz: function () {
      if (!app) return null;
      var questions = app._extractQuestions(null);
      console.log('[Omitone] scanned questions:', questions.length, questions);
      emitRuntimeLog('info', 'quiz scan (manual)', {
        count: questions.length,
        types: questions.map(function (q) { return q.type; })
      });
      return questions;
    },
    /**
     * 弹窗题诊断。视频里弹出的题"AI 扫描了但从不填空"时，在页面控制台执行
     * `xxtAI.diagnosePopup()`：它会把弹窗的真实结构、抠到的选项、推断出的字母
     * 以及放弃计数一起打出来，据此就能判断是结构不认识还是选项匹配不上。
     */
    diagnosePopup: function () {
      if (!app) return null;
      var node = null;
      try { node = app._checkPopupQuiz(); } catch (e) { node = null; }
      var report = {
        found: !!node,
        blocked: !!(app._popupQuizBlockedUntil && Date.now() < app._popupQuizBlockedUntil),
        attempts: app._popupQuizAttempts,
        maxAttempts: app._getPopupQuizMaxAttempts(),
        popup: node ? app._describePopupQuiz(node) : null
      };
      console.log('[Omitone] popup quiz diagnose:', report);
      emitRuntimeLog('info', 'popup quiz diagnose (manual)', report);
      return report;
    },
    /**
     * 查看/清除"做不完的任务点"名单。
     * 老师把任务点设成防拖拽或不可翻页时，插件连续几次做不完就会记入这个名单、
     * 24 小时内不再尝试。想让它再试一次就调 clearTaskGiveUp()。
     */
    taskGiveUpList: function () {
      if (!app) return null;
      var list = app._taskGiveUpList();
      console.log('[Omitone] task give-up list:', list);
      return list;
    },
    clearTaskGiveUp: function () {
      if (!app) return null;
      app._clearTaskGiveUp();
      emitRuntimeLog('info', 'task give-up list cleared (manual)', {});
      console.log('[Omitone] task give-up list cleared');
      return true;
    }
  };
})();



