/* ==========================================================================
 * Omitone page.js 片段 01/15 —— app 入口 / 配置 / 运行期状态
 * 来源：原 page.js 中散布的 116 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * app 的入口与生命周期：run / play / _assertActive / _resetRuntimeState
 * **全部非方法属性都在这里**（configs、所有 `_xxx` 状态字段、_cellData、_questionSelectors 等）——
 * 这条规则很好记：找状态字段就来这个文件，不用在别处翻
 *
 * 本段的状态字段（118 个）：configs、_videoEl、_videoCount、_currentVideoIndex、_isPlaying、_checkInterval、_tickLoopInterval、_tickRunning、_tickStartedAt、_tickEpoch、_tickProgressAt、_tickProgressNote、_tickProgressLogAt、_quizInProgress、_quizAnswered、_quizSubmitPending、_quizSubmitStartedAt、_quizSubmitLogAt、_quizLastSubmitAttemptAt、_quizHoldLogAt、_quizCorrectAnswerCache、_quizCurrentAnsweredKeys、_quizCurrentAnswerValues、_quizCurrentQuestions、_quizReadyToSubmit、_quizReadyWorkKey、_quizForceSkipUntil、_quizApiSkipLogAt、_quizScanDiagAt、_popupQuizKey、_popupQuizAttempts、_popupQuizBlockedUntil、_popupQuizLogAt、_popupQuizSolvedKey、_popupQuizSolvedAt、_popupQuizWrongAnswers、_popupQuizLastFilled、_popupQuizQuietUntil、_popupBlockCheckedAt、_popupBlockCached、_quizBatchSentKey、_quizBatchSentAt、_continueStudyAt、_continueStudyScanAt、_continueStudyKey、_continueStudyClicks、_continueStudyBlockedUntil、_taskAttempts、_taskProgress、_detectedMaxRate、_rateDetectVideo、_rateDetectBusy、_rateProbing、_bgWorker、_bgWorkerUrl、_workerDelayCallbacks、_workerDelaySeq、_audioKeepalive、_mediaRepaired、_pauseResumePending、_visibilityBound、_captchaActive、_captchaBusy、_captchaAttempts、_captchaFailCount、_captchaLastCheckAt、_captchaLastResult、_discussionWindow、_discussionOpenedAt、_discussionScanAt、_discussionBusy、_discussionPosted、_discussionExpanded、_discussionBefore、_discussionScrollAt、_discussionCardOpened、_discussionPageUrl、_discussionPageAt、_discussionPageResult、_quizApiFailUntil、_quizApiLastError、_stepNavigationBound、_stepSwitchPending、_stepSwitchAt、_skipChainCount、_videoRetryCount、_lastChapterKey、_delayedNextUnitTimer、_guardLastTime、_guardLastWallTs、_guardLastResumeTs、_resumeWindowStart、_resumeAttemptCount、_activeMediaJobPending、_activeMediaJobManaged、_activeDocumentJobPending、_activeDocumentJobManaged、_activeDocumentJobDoc、_mediaWaitLogAt、_documentWaitLogAt、_lastLearningTabSwitchAt、_lastLearningCardKey、_docTaskState、_treeContainerEl、_taskDiscoverStartedAt、_taskWaitLogAt、_pendingTaskKey、_pendingTaskStartedAt、_pendingTaskLogAt、_submitConfirmLastClickAt、_activeJobId、_cellData、_unsupportedJobLogged、_visionUsedInChapter、_visionBudgetChapterKey、_discussionStoreKey、_taskGiveUpStoreKey、_questionSelectors
 *
 * 本段的方法（4 个）：
 *   _assertActive、run、play、_resetRuntimeState
 * ========================================================================== */
// @omitone-part-header-end
    configs: mergeConfig({ apiKey: '', autoNext: true, enableQuiz: false }),


    _videoEl: null,

    _videoCount: 0,

    _currentVideoIndex: 0,

    _isPlaying: false,

    _checkInterval: null,

    _tickLoopInterval: null,

    // 主循环的重入锁与看门狗时间戳。
    // ⚠️ 这两个原先**从未声明**，全靠 `this._tickRunning = true` 现建 —— 值上没坏
    //    （undefined 是假值），但破坏了"状态字段全在这一个文件里"这条规矩：
    //    想找主循环的状态，在 10-config-state.js 里 grep 不到。
    _tickRunning: false,

    _tickStartedAt: 0,

    // 主循环的"代"号：看门狗强制释放锁时 +1，用来作废旧 tick 的复位权（见 _runTick 的 finally）
    _tickEpoch: 0,

    // 「进度心跳」时间戳：**由长任务的循环主动刷新**，用来把看门狗的判据从
    // 「tick 活了多久」改成「多久没有进展」（见 _startTickLoop 的看门狗与 _tickProgress）。
    // 为什么需要它：PPT 音频任务的单页等待上限是 600 秒（40-media.js 的 _waitSlideAudioDone），
    // 远超看门狗的 150 秒 —— 没有心跳时，**正常干活的长任务会被误判成卡死并强制放锁**，
    // 于是新一轮 tick 与仍在推进的旧 tick 同时操作同一个任务点。
    _tickProgressAt: 0,

    // 心跳日志节流：只在 note 变化或距上次日志超过 30 秒时才打，避免刷爆日志
    _tickProgressNote: '',
    _tickProgressLogAt: 0,

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

    // 「当前在答的是哪一份卷子」的身份键（jobid / workid 一类）。
    //
    // 为什么必须有它：`_quizAnswered` / `_quizCurrentQuestions` 这一组字段是
    // **页面级**的，只在 `_resetRuntimeState()` 里清 —— 而那个函数的调用点只有
    // `run()` / 换章节 / `nextUnit()` / 换学习卡片。**同一张学习卡片里挂着两份试卷时，
    // 交完第一份不会经过任何一个调用点**，于是 `_quizAnswered` 一直是 true，
    // `_handleQuiz` 第一行就直接 return，第二份**永远不答**（实测症状：
    // 两个单元测试任务点只做了第一个）。
    // 有了这个键，换一份卷子就 `_syncQuizPaperRunState()` 把那一组状态重置，
    // 同时不影响同一份卷子内部的重试/重做（键不变就不重置）。
    _quizRunPaperKey: '',

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

    // 填完答案后的一段静默期：期间**完全不去碰弹题**，见 _activePopupBlock 的说明。
    _popupQuizQuietUntil: 0,

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


    run: function () {
      if (!this._assertActive()) return;
      // 「已开启」持久化到 chrome.storage（经 content 桥接）。run() 是所有启动入口的汇合点
      //（页面中间面板【开始】/ 弹窗【开始】/ 刷新后自动续跑都会走到这里），在这里落一次标记，
      // 才能保证页面跳转、以及讨论任务 window.open 新开的标签页里，content.js 的
      // maybeMarkAutoResume 读到 xxtRunning → shouldAutoStart() 为真 → 自动续跑。
      // 否则从页面面板点【开始】时 xxtRunning 恒为 false，新开的讨论窗口 shouldAutoStart() 为假、
      // 命中「是讨论页且没开启 → 静默 return」→ 插件在新窗口里一动不动（用户报的「讨论新窗口失灵」）。
      // storage_set 桥接不回消息，直接投递、不 await，避免 bridgeSend 的 promise 空挂到超时。
      try { window.postMessage({ source: 'xxt_app', type: 'storage_set', payload: { xxtRunning: true } }, '*'); } catch (ePersist) {}
      this.configs = mergeConfig(this.configs);
      this._initCellData();
      this._resetRuntimeState();
      this._clearTickLoop();
      this._bindStepNavigation();
      console.log('%c[Omitone] start', 'color:#4CAF50;font-weight:bold');
      try { this._installSubmitSniffer(); } catch (eSniff) {}
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
      // 换章节/换卡片时连"在答哪一份卷子"的身份一起清掉：
      // 回到同一份卷子时视为全新一轮（与 `_quizAnswered = false` 配套，语义一致）
      this._quizRunPaperKey = '';
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


    /**
     * 对"确认是任务点但不支持的类型"做去重告警（每种模块只记一条）。
     *
     * 静默丢弃任务点是最难排查的一类问题：用户只看到"这个任务点没做"，
     * 完全无从判断是识别失败、还是压根不支持。留一条日志就能区分。
     */
    _unsupportedJobLogged: null,


    // ===== 视觉理解：把题目配图转成文字 =====
    //
    // 为什么只转文字、不直接把图交给答题模型：
    //   答题链的系统提示词 + 题目文本是一个**每次都一样的长前缀**，DeepSeek 会把它
    //   当作缓存单元按约 1/10 价计费（见 content.js logCacheUsage 的说明）。
    //   一旦把每次都不同的图片塞进这个前缀，缓存立刻全部失效 ——
    //   省下的那点「模型看图」的钱，会乘以十倍从输入侧漏出去。
    //   所以图片走独立请求，只把结果文字拼进题干。

    // 每章视觉调用计数（进了新章就清零，见 _resetVisionBudget）。
    _visionUsedInChapter: 0,

    _visionBudgetChapterKey: '',


    // ===================== 讨论任务点 =====================
    // 讨论任务点不在课程 iframe 内：点击后会跳转到独立的讨论页（新标签页或当前标签页），
    // 必须在该页面发布评论才算完成。原识别逻辑只认 video/quiz/read/document 等类型，
    // 这类任务点会被判成 other 直接跳过，因此这里单独实现：
    //   刷课页：检测讨论任务点 → 打开讨论页 → 暂停推进等待
    //   讨论页：自动填内容 → 点发布 → 检测成功 → 关闭/返回
    //   回到刷课页：刷新章节继续运行（全程有超时兜底，绝不会卡住）

    _discussionStoreKey: 'omitone_discussion_done',


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
