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

  /**
   * 弹题填完答案后的「静默期」。
   *
   * 为什么需要它：站点在答完之后会**重绘弹窗**（给正确项打勾 / 加提示 / 重排），
   * 而防重问的指纹取的是**选项文本** —— 文本一变指纹就变、"已答放行"立刻失效，
   * 弹窗被当成新题 → 再问模型 → 再点一次选项 → 站点再重绘 …… 死循环。
   * 现场表现就是"选项一直闪"，而且指纹一变 `_popupQuizAttempts` 就被重置，
   * "最多问 3 次就放手"这个安全阀**永远触发不了**。
   * 所以填完之后统一静默一段时间，无论指纹怎么变都不碰它。
   *
   * ⚠️ 「已答放行」的窗口**必须与它相等，绝不能更长** ——
   * 详见 `_handlePopupQuiz` 里填答成功那一段（曾经写成 30 秒，
   * 于是答错后有 22 秒处于"静默期已过、却仍被当成已答"的没人管空档）。
   */
  var POPUP_QUIZ_QUIET_MS = 8000;

  /**
   * 模型接口返回 4xx（Key 无效 / 无权限 / 模型名不存在）之后，跳过答题的窗口。
   *
   * ⚠️ 它**不是退避**，绝不能和 `_markQuizApiConnectionFailed` 的 45 秒混为一谈：
   * 4xx 是配置问题，重试一万次也还是 4xx，退避只会把"配置填错了"伪装成
   * "网络连不上、插件卡死"（用户根本看不到服务商给的 "Invalid API key"）。
   * 这里给 60 秒只是留出改配置的时间，改完下一轮自动恢复。
   */
  var PERMANENT_LLM_ERROR_SKIP_MS = 60000;

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
    // 「乱选」：不接 AI，本地随机生成答案。给不想配 API key 的用户用，
    // 只求把卷交出去，不求对。默认关。
    randomAnswer: false,
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
    // ===== 视觉模型（图片理解）=====
    //
    // 背景：题干和选项里经常带图片（数学图形、化学结构、电路图、表格截图、
    // "看图选择"），而题目解析只读文本 —— 图片被静默丢掉，模型只能瞎猜。
    //
    // ⚠️ 但这东西**默认必须是关的**。原因不是技术风险，是钱：
    // 一张 1000×800 的 PNG 编码成 base64 后约 200~400KB，按视觉模型计费
    // 往往是纯文本的几十倍，而一道题可能带好几张图。
    // 用户能接受"刷不了课"，不能接受"花了钱还是不行" ——
    // 所以没明确开启、没设预算之前，一张图都不发。
    visionEnabled: false,
    // 发图时用哪个模型。留空则回落 captchaModel，再回落 model。
    //
    // 单独一个字段是必要的：主模型往往是为"便宜快"挑的文本模型（deepseek-chat
    // 这类），它**不支持图片**，塞图进去要么 400 要么被忽略掉、
    // 用户只会看到"开了却没用，但钱扣了"。所以这里必须能单独指定。
    visionModel: '',
    // 单题最多带几张图。默认 2 —— 超过这个数的题通常是"资料题"，
    // 图多得离谱、收益却很低，不如直接放弃。
    visionMaxImagesPerQuestion: 2,
    // 单张图最大字节数（base64 之前的原始大小）。超过就**跳过不缩放**：
    // 缩放需要 canvas 重编码，在页面上下文里既慢又容易踩跨域污染，
    // 而且缩放后的图模型未必看得清。跳过并写日志，比偷偷发一张大图省钱。
    visionMaxImageBytes: 400000,
    // 每章视觉调用预算（次）。用完就停，直到进入下一章。
    // 这是最重要的那道闸：即使配置写错、或者页面版式异常导致重复抓图，
    // 也不可能无限发请求。用完时**必定**写一条 warn 日志，
    // 绝不静默 —— "钱花了但不知道花在哪"是最不能接受的失败方式。
    visionBudgetPerChapter: 30,
    // 一次请求里最多打包几张图（把同一题的图合到一次请求，而不是一题一请求）。
    // 合包能显著省钱：省掉重复的系统提示词与题干。
    visionImagesPerRequest: 2,
    // 思考强度：'off'（默认，最省最快）/ 'low' / 'high'。
    //
    // ⚠️ 只有 'off' 是实测过的 —— 它就是本项目原来一直用的行为（DeepSeek 关思考）。
    // 'low' / 'high' 会多发推理参数：支持的厂商没问题，不支持的厂商可能直接 400。
    // 因此 content.js 里是**按渠道白名单**发参数的，未知渠道一个参数都不发
    // （见 libs/thinking.js 的说明）。默认值选 'off' 也意味着老用户升级后行为不变。
    thinkingLevel: 'off',
    systemPrompt: '',
    videoCheckInterval: 1500,
    stepSwitchGraceMs: 7000,
    stepSwitchInitDelayMs: 2200,
    taskDiscoverGraceMs: 8000,
    taskPendingGraceMs: 7000,
    quizSubmitWaitMs: 25000,
    quizMaxSubmitAttempts: 20,
    // 同一道选择题连续这么多次没被平台接受后，就"放弃继续折腾"：
    // 不再为它扩错答列表、不再进 LLM 请求，直接填本地最优猜测，让整卷交得出去。
    // 不设这条的后果是"一道多选把整卷钉在原地"——用户报的"章节小测一直卡住"。
    quizQuestionMaxMisses: 3,
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

    // 主循环的重入锁与看门狗时间戳。
    // ⚠️ 这两个原先**从未声明**，全靠 `this._tickRunning = true` 现建 —— 值上没坏
    //    （undefined 是假值），但破坏了"状态字段全在这一个文件里"这条规矩：
    //    想找主循环的状态，在 10-config-state.js 里 grep 不到。
    _tickRunning: false,

    _tickStartedAt: 0,

    // 主循环的"代"号：看门狗强制释放锁时 +1，用来作废旧 tick 的复位权（见 _runTick 的 finally）
    _tickEpoch: 0,

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
              // 记下到底点了什么。这个函数**只按文案匹配、点完就返回**，
              // 现场报过「答对后选项一直闪」，但看不出是谁在点 —— 补上日志才能定位。
              emitRuntimeLog('info', 'dismiss popups: click', {
                text: String(t).slice(0, 30),
                cls: String(buttons[i].className || '').slice(0, 60),
                matched: texts[j]
              });
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


    _resolveImageUrl: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var base = doc.baseURI || window.location.href;
        return new URL(img.src || img.currentSrc || '', base).href;
      } catch (e) {
        return '';
      }
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


    _logTaskWait: function (message, now) {
      var ts = now || Date.now();
      if (ts - this._taskWaitLogAt < 3000) return;
      this._taskWaitLogAt = ts;
      console.log('%c[Omitone] waiting task render: ' + message, 'color:#9C27B0');
    },


    /**
     * 把图片 URL 转成 dataURL 并做体积闸门，然后一次性交给视觉模型。
     *
     * 返回值：描述文字（string），拿不到就返回空串。
     * **永远不会抛异常** —— 视觉只是锦上添花，绝不能因为它把整条答题链打断。
     */
    _describeQuestionImages: async function (urls, chapterKey) {
      if (!urls || !urls.length) return '';
      if (!this.configs.visionEnabled) return '';

      var maxBytes = Number(this.configs.visionMaxImageBytes);
      if (!isFinite(maxBytes) || maxBytes <= 0) maxBytes = 400000;
      var maxPerReq = Number(this.configs.visionImagesPerRequest);
      if (!isFinite(maxPerReq) || maxPerReq < 1) maxPerReq = 2;

      // 先抓图（这一步不花钱）
      var dataUrls = [];
      for (var i = 0; i < urls.length && dataUrls.length < maxPerReq; i++) {
        var url = String(urls[i] || '');
        if (!url) continue;
        var dataUrl = '';
        if (url.indexOf('data:image/') === 0) {
          dataUrl = url;
        } else {
          try {
            var fetched = await bridgeSend('fetch_image', { url: url });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = String(fetched.dataUrl);
          } catch (eF) {}
        }
        if (!dataUrl) continue;
        // 体积闸门：base64 后约是原始字节的 4/3，这里用 dataURL 长度近似判断
        if (dataUrl.length > maxBytes * 1.4) {
          emitRuntimeLog('info', 'vision image too large, skipped', { bytes: Math.round(dataUrl.length * 0.75) });
          continue;
        }
        dataUrls.push(dataUrl);
      }
      if (!dataUrls.length) return '';

      // 抓完图才扣预算。反过来会出现「预算扣了但图没抓到」的冤枉账。
      if (!this._takeVisionBudget(chapterKey)) return '';

      try {
        var result = await bridgeSend('llm_vision', { images: dataUrls });
        if (!result || !result.success) {
          emitRuntimeLog('warn', 'vision request failed, continue without image text', {
            error: String((result && result.error) || 'no response').slice(0, 200)
          });
          return '';
        }
        var text = String(result.data || '').trim();
        // 模型说「无」时不要往题干里塞噪音 —— 那会让答题模型分心
        if (!text || text === '无' || text === '没有' || text === '无明显信息') return '';
        emitRuntimeLog('info', 'vision described images', { images: dataUrls.length, chars: text.length });
        return text;
      } catch (e) {
        emitRuntimeLog('warn', 'vision bridge failed', { message: e && e.message ? e.message : String(e) });
        return '';
      }
    },


    /** 乱选模式下的日志（每 3 秒最多一条，避免刷屏）。 */
    _logRandomAnswers: function (questions) {
      var now = Date.now();
      if (now - (this._randomAnswerLogAt || 0) < 3000) return;
      this._randomAnswerLogAt = now;
      emitRuntimeLog('info', 'random answer mode: generated locally, no ai request', {
        count: (questions || []).length
      });
    },


    /**
     * 诊断：**为什么没认出判分结果页**。
     *
     * `_isQuizResultPageFinished` 有三道条件 ——
     *   ① 没有「请重做」类文案（一票否决）
     *   ② 有判分痕迹（`.Py_answer` 那一族，或正文出现「我的答案/正确答案/本题得分/答案解析」）
     *   ③ 题目区已不可交互（没有容器，或所有 radio/checkbox/input/textarea 都 disabled）
     * 任何一道不满足都返回 false，但**不告诉你缺的是哪一道**。
     * 于是 25 秒超时之后只能靠猜 —— 现场报过「作业页反复重交」，卡的就是这一段。
     *
     * 这条日志把三道条件各自的结果都打出来，下次复现就能直接看出缺哪一块，不用再猜。
     */
    _describeQuizResultPage: function (preferredDoc) {
      var out = {};
      try {
        var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
        if (!doc || !doc.body) { out.doc = 'none'; return out; }
        var text = textOf(doc.body);
        out.textLen = text.length;
        // ① 一票否决
        out.redoText = /未达到及格线|未达到通过标准|请重做|很遗憾|未通过/.test(text);
        // ② 判分痕迹
        var hit = null;
        try { hit = doc.querySelector('.Py_answer, .Py_tk, .answerScore, .answerCon, .mark_answer'); } catch (eH) {}
        out.gradeSelector = hit ? String(hit.className || '').slice(0, 40) : '';
        out.gradeText = /我的答案|正确答案|本题得分|答案解析/.test(text);
        // ③ 可交互性
        out.containers = doc.querySelectorAll('.TiMu, .Cy_TITle, .questionLi, .questionItem, .mark_item, .questionBox').length;
        var ctrls = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea');
        out.controls = ctrls.length;
        var enabled = 0;
        for (var i = 0; i < ctrls.length; i++) { if (!ctrls[i].disabled) enabled++; }
        out.controlsEnabled = enabled;
        // 正文里跟判分有关的词，便于对照
        var kw = text.match(/我的答案|正确答案|本题得分|答案解析|任务点已完成|已通过|请重做|未通过|不及格/g);
        out.keywords = kw ? Array.from(new Set(kw)).slice(0, 8) : [];
      } catch (e) { out.err = String(e.message || e).slice(0, 60); }
      return out;
    },

    _logSubmitPayload: function (questions, doc) {
      try {
        var list = (questions && questions.length ? questions : this._quizCurrentQuestions) || [];
        var out = [];
        for (var i = 0; i < list.length && i < 12; i++) {
          var q = list[i];
          var el = q && q._element;
          var qid = el ? this._getQuestionIdFromElement(el) : '';
          if (!qid) { out.push({ qid: '', answer: '(无 qid)' }); continue; }
          var a = doc && doc.getElementById ? doc.getElementById('answer' + qid) : null;
          var t = doc && doc.getElementById ? doc.getElementById('answertype' + qid) : null;
          // `mapped` 是我们**把 answertype 解读成了什么** —— 与 `type` 一列对比，
          // 就能立刻看出「我们认的题型」和「平台声明的题型」是否一致。
          // 不一致时服务端很可能拒收（比如我们当单选填、平台声明是多选）。
          var rawType = t ? String(t.value || '') : '';
          out.push({ qid: qid, type: q && q.type, mapped: this._mapQuizTypeValue(rawType),
            answer: a ? String(a.value || '') : '(无该字段)',
            answertype: t ? rawType : '(无该字段)' });
        }
        console.log('[Omitone] submit payload', JSON.stringify(out));
      } catch (e) {}
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

        // ⚠️ fetch 与读响应体都**必须**可超时。服务器接了连接却不回数据时（CDN 卡住、
        //    被门户/代理吞掉），await 会永久挂起 —— 而这条链在 _runTick 上，
        //    一挂就是整个调度停摆（验证码检测、播放巡检、任务点推进全停）。
        //    注意 try/catch 拦不住"挂起"，只有超时能。
        //    _withTimeout 超时是 resolve(undefined)，下面两处 `!response` / `!buf` 判断正好接得住。
        var response = await this._withTimeout(fetch(src, { credentials: 'include' }), 20000);
        if (!response || !response.ok) return false;
        var buf = await this._withTimeout(response.arrayBuffer(), 60000);
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
          // ⚠️ 这里必须用 _popupQuizBlocksPlayback 而不是 _activePopupBlock：
          // 后者在"刚答完的静默期"里会返回 null（那是给"要不要再问模型"用的），
          // 但弹窗其实还挂在页面上、视频正是被它有意暂停的。用错就会去抢恢复播放、
          // 和站点对打 —— 现场表现是"答完弹题后视频不动，看着像卡死"。
          if (self._popupQuizBlocksPlayback && self._popupQuizBlocksPlayback()) return;
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
          timereader: doc.querySelector('iframe[name="bookifame"][src*="timing"]'),
          // 纯 PDF / WPS 文档帧：既没有 #img.imglook（那不是图片型阅读），
          // 也没有 swiper（那不是带音频的 PPT），只有 #panView / .pageNum。
          //
          // 以前这里没有这一项，于是这类帧在下面那行 `!(found.xxx || ...)` 里
          // 直接 `continue` —— **永远不进入 OCS 调度**。
          // 「有些微课 PDF/WPS 文档卡住没有任何动作」正是由此而来。
          // 注意这一项必须放在 || 链的**最后**：它是兜底，不能抢走上面更明确的类型。
          pagedDoc: (doc.getElementById && doc.getElementById('panView')) || doc.querySelector('.pageNum')
        };
      };

      var iframes = this._searchIFramesOcs(knowCardDoc);
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        try {
          var win = frame.contentWindow;
          var doc = appRef._safeWinDoc(win);
          var found = searchJobElement(frame);
          if (!win || !found || !(found.videojs || found.read || found.chapterTest || found.hyperlink || found.pptWithAudio || found.timereader || found.pagedDoc)) {
            continue;
          }
          // 纯文档帧还有一道闸：外层容器必须真的带任务点。
          // 否则它只是页面上的说明性/预览性文档，接管它会白白占住调度。
          if (!found.videojs && !found.read && !found.chapterTest && !found.hyperlink && !found.pptWithAudio && !found.timereader) {
            if (!appRef._frameHasTaskPoint(doc)) continue;
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
          var jobKind = found.videojs ? 'video' : (found.chapterTest ? 'quiz' : (found.read ? 'read' : (found.timereader ? 'timereader' : (found.pptWithAudio ? 'ppt-audio' : (found.hyperlink ? 'hyperlink' : 'document')))));
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
          } else if (found.read || found.pptWithAudio || found.timereader || found.pagedDoc) {
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
              }(this, frame, win, doc, jobName, attachment,
                found.read ? 'read'
                  : (found.timereader ? 'timereader'
                    : (found.pptWithAudio ? 'ppt-audio' : 'document')));
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

    // 文档帧自己身上有没有「任务点」证据。
    //
    // 为什么不能只看 _hasTaskPoint()：那个方法只扫主文档 + 左侧章节目录，
    // 而文档任务点在真实页面里是**挂在 iframe 外层包裹容器上**的
    // （`<div class="ans-attach-ct ans-job-...">` 里再套 iframe），
    // 主文档里往往只剩一个类名被改写过、或干脆没有标记。
    //
    // 这里沿 frameElement 往上找 4 层，看包裹容器上有没有任务点痕迹。
    // 找不到就返回 false —— 调用方按「没有任务点」处理，让它走跳过逻辑，
    // 而不是把它当成一个永远做不完的任务接管住。
    _frameHasTaskPoint: function (doc) {
      try {
        if (!doc || !doc.defaultView) return false;
        var node = doc.defaultView.frameElement;
        for (var i = 0; i < 4 && node; i++) {
          var cls = String(node.className || '');
          if (/(^|\s)(ans-job-icon|ans-job-finished|ans-job-num|taskPoint)(\s|$)/.test(cls)) return true;
          if (/(^|\s)ans-job-/.test(cls)) return true;
          if (node.getAttribute && (node.getAttribute('jobid') || node.getAttribute('_jobid'))) return true;
          var dataText = String(node.getAttribute ? (node.getAttribute('data') || '') : '');
          if (dataText && /"job"\s*:\s*true/i.test(dataText)) return true;
          if (textOf(node).indexOf('任务点') !== -1) return true;
          node = node.parentElement;
        }
      } catch (e) {}
      return false;
    },

    _locateDocumentTask: function (preferredDoc) {
      var self = this;
      var startDoc = this._getMainDocument() || document;

      // 没有任务点的文档不值得开一条长任务。
      //
      // 这是「有些微课 PDF/WPS 文档没有任务点时会卡住」的正解：
      // 以前只要 DOM 结构像文档（有 #panView / .pageNum），就无条件接管，
      // 于是 tick 每轮都在这里 `return true`，永远轮不到 tail 的
      // `_isTextOnly() && !_hasTaskPoint() → nextUnit()` 跳过分支。
      // 页面表现就是「一动不动，日志也不更新」。
      //
      // 判定顺序有讲究：
      //   1. 外层容器明确写了任务点 → 接管（正常路径，绝不能误伤）
      //   2. 主文档/章节目录有任务点   → 接管（老逻辑）
      //   3. 两者都没有               → 不接管，交回 tick 走跳过
      function worthHandling(doc) {
        if (self._frameHasTaskPoint(doc)) return true;
        if (self._hasTaskPoint()) return true;
        return false;
      }

      function buildTask(doc) {
        if (!doc) return null;
        try {
          if (doc.getElementById && doc.getElementById('panView')) {
            return worthHandling(doc) ? self._buildPagedDocumentTask(doc) : null;
          }
          if ((doc.getElementById && doc.getElementById('markDataStr')) || doc.querySelector('.pageNum')) {
            return worthHandling(doc) ? self._buildScrollDocumentTask(doc) : null;
          }
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
            // ⚠️ 这里以前只 clear 状态就 return true。
            //
            // 后果：_runChaoxingReadJob 的 document 分支只在**页面自己出现
            // finishJob** 时才 clear（见 'document-finishJob'），而大多数
            // PDF/WPS 文档页根本没有这个函数；于是任务真的读完了、
            // task.finished 也变真了，这个分支却只是把状态抹掉，
            // **永远不推进下一节** —— 表现就是「文档显示已完成，但卡在这一章不动」。
            //
            // 正确做法：清完状态后，跟非托管路径一样推进。
            this._clearDocumentPendingState('document-done');
            if (this.configs.autoNext) {
              this._skipChainCount++;
              this.nextUnit();
            }
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
          // ⚠️ 必须先"作废"这次 tick 的复位权：它可能过一会儿才醒过来，
          //    醒来后无条件复位会把**新 tick 的锁**清掉 —— 于是下一轮又起一个 tick，
          //    两个 tick 并行推进（可能重复提交、重复跳章）。
          self._tickEpoch = (self._tickEpoch || 0) + 1;
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
      var myEpoch = this._tickEpoch = (this._tickEpoch || 0) + 1;
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
        // ⚠️ 只有**仍然持有锁**的那一次才允许复位。
        // 看门狗可能在 150 秒后把锁强制释放并交给新的 tick；若这次（旧的）此刻才醒来，
        // 无条件复位会清掉新 tick 的锁 → 下一轮再起一个 tick → 两个 tick 并行。
        // 正常路径下 epoch 必然相等，行为与改动前完全一致。
        if (this._tickEpoch === myEpoch) {
          this._tickRunning = false;
          this._tickStartedAt = 0;
        }
      }
    },

    _tick: async function () {
      return this._runTick();
    },

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
        // ⚠️ 同样必须可超时：本函数在 _runTick 的讨论任务点链路上（`await _tryDiscussionTask()`），
        //    服务端不回数据时 await 会永久挂起。外层的 try/catch **拦不住挂起** —— 只有超时能。
        var resp = await this._withTimeout(fetch(abs, { credentials: 'include' }), 15000);
        if (!resp) return '';
        var html = await this._withTimeout(resp.text(), 15000);
        if (typeof html !== 'string') return '';
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

    /**
     * 作业/考试提交之后，页面会翻成一张**判分结果页**：
     * 每道题下面多出「我的答案 / 正确答案 / 本题得分」。
     *
     * 为什么单列一条判据（现场故障）：`_isDocumentFrameFinished` 认的是
     * `.ans-job-finished / .job-color / .icon_Completed / .testTit_status_complete`
     * 和父层 wrapper 的「任务点已完成」文本 —— 这套标记是**课程章节页**的。
     * 作业结果页往往只有 `.Py_answer` 那一族，于是四条都不命中，
     * `_isQuizPassedOrFinished` 恒为 false → `_monitorQuizSubmit` 一直 hold →
     * 25 秒后超时、整页重载、重新扫描、重新答题、重新提交。
     * 用户看到的就是"题目一直扫描，AI 重复提交"。
     *
     * 三条判据**同时**成立才算完成，宁可漏判也不要误判
     * （误判 = 把没交的卷当已完成，直接跳过这个任务点）：
     *   ① 出现判分痕迹（我的答案/正确答案/得分/解析）
     *   ② 题目控件已不可交互（input 全 disabled）或题目容器已消失
     *   ③ 不含重做文案
     */
    _isQuizResultPageFinished: function (doc) {
      try {
        if (!doc || !doc.body) return false;
        var text = textOf(doc.body);
        if (!text) return false;
        // ③ 重做文案一票否决：这是"没通过、要重做"，绝不能算完成
        if (/未达到及格线|未达到通过标准|请重做|很遗憾|未通过/.test(text)) return false;

        // ① 判分痕迹：学习通结果页的标志性结构
        var hasGradeMark = false;
        if (doc.querySelector('.Py_answer, .Py_tk, .answerScore, .answerCon, .mark_answer')) {
          hasGradeMark = true;
        } else if (/我的答案|正确答案|本题得分|答案解析/.test(text)) {
          hasGradeMark = true;
        }
        if (!hasGradeMark) return false;

        // ② 已不可交互：题目区被结果区替换，或所有控件都 disabled
        var containers = doc.querySelectorAll('.TiMu, .Cy_TItle, .questionLi, .questionItem, .mark_item, .questionBox');
        if (!containers.length) return true;

        var controls = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea');
        if (!controls.length) return true;
        for (var i = 0; i < controls.length; i++) {
          if (!controls[i].disabled) return false; // 还有能点的 → 结果页尚未落地
        }
        return true;
      } catch (e) {
        return false;
      }
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
      // ⚠️ 乱选模式**不需要** API key，也不受连接失败影响 —— 答案在本地生成。
      // 少了这一句，乱选会走 _skipQuizForApiUnavailable 把整道题跳过，
      // 变成「什么都不答」而不是「乱选」。
      if (this._isRandomAnswerMode()) return '';
      if (!String(this.configs.apiKey || '').trim()) return 'api-key-missing';
      if (Date.now() < (this._quizApiFailUntil || 0)) return 'api-connection-failed';
      return '';
    },

    /** 乱选模式是否生效。`enableQuiz` 仍要开 —— 关掉它是「完全不答题」的意思。 */
    _isRandomAnswerMode: function () {
      return !!(this.configs && this.configs.enableQuiz && this.configs.randomAnswer);
    },

    /**
     * 本地生成随机答案，**形状与 AI 返回的完全一致**（位置式数组）。
     *
     * 之所以刻意对齐形状：下游的填充 / 提交 / 判分识别因此**一行都不用改**，
     * 只换「答案从哪来」这一个源头 —— 改动面越小，越不容易碰坏别的功能。
     *
     * 各题型：单选 → 随机一个字母；判断 → 随机 true/false；
     * 多选 → 随机 1~2 项（用户实测：平台**接受**只选一项）；
     * 填空 / 简答 → 固定占位文本（乱选模式下不求对，只求把卷交出去）。
     */
    _buildRandomQuizAnswers: function (questions) {
      var list = questions || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var q = list[i] || {};
        var type = q.type || 'single';
        var count = (q.options || []).length;
        // 只有"读不到选项"（0 或 1 个）时才兜底成 4 —— 让字母至少有可能匹配上。
        // 选项多的时候**按真实数量**取（原先 >8 会硬压成 4，没必要，而且浪费了正确匹配的机会）。
        if (count < 2) count = 4;
        if (count > 26) count = 26;
        if (type === 'judge') {
          out.push(Math.random() < 0.5);
        } else if (type === 'multiple') {
          var pool = [];
          for (var k = 0; k < count; k++) pool.push(String.fromCharCode(65 + k));
          var picked = [];
          var want = Math.random() < 0.5 ? 1 : 2;
          while (pool.length && picked.length < want) {
            picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
          }
          out.push(picked.sort());
        } else if (type === 'fill' || type === 'short') {
          out.push('不会');
        } else {
          out.push(String.fromCharCode(65 + Math.floor(Math.random() * count)));
        }
      }
      return out;
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

    _isQuizPassedOrFinished: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      try {
        // 判分结果页优先于 frame 标记判断：作业/考试结果页两套标记都没有，
        // 只有 .Py_answer 那一族（见 _isQuizResultPageFinished 的说明）。
        if (doc && this._isQuizResultPageFinished(doc)) return true;
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

    /**
     * 提交之后，这一轮填的答案是不是**被清空了**。
     *
     * 判据：`_quizCurrentQuestions` 里**一道题都不再"已填写"**。
     * 平台判错重置、或静默丢弃提交时就是这样 —— 选项全没了。
     *
     * 为什么需要它：`_isQuizRedoRequired` 只认「未达到及格线 / 请重做 / 很遗憾」
     * 这类**文案**（或可见的重做弹窗）。而现场遇到过**不带这些文案的静默拒绝** ——
     * 用户描述是「提交闪了一下框、回到题目、选项全没了」。
     * 那种情况下四个 `_rememberWrongQuizAnswers` 调用点**一个都不会命中**，
     * 于是填过的答案不被记成错的，下一轮**原样再填一遍**，形成死循环。
     * 这里用"表单被清空"这个**不依赖文案**的信号兜住它。
     */
    _isQuizAnswersCleared: function (preferredDoc) {
      try {
        var qs = this._quizCurrentQuestions;
        if (!qs || !qs.length) return false;
        for (var i = 0; i < qs.length; i++) {
          if (this._getQuizQuestionFilledValue(preferredDoc, qs[i])) return false;
        }
        return true;
      } catch (e) { return false; }
    },

    /**
     * 提交前把平台**真正会提交的字段**打出来（`#answer{qid}` + `#answertype{qid}`）。
     *
     * 为什么需要：现场报「作业提交失败」，但用户**手动随便选**（多选只选一个）却能提交成功 ——
     * 说明失败与答案对错无关，是**我们生成的提交状态**平台不认。
     * 把这份快照与手动提交时同名字段一比，就能看出差在哪（题型值？格式？空值？）。
     */
    /**
     * 只读抓包：把平台**提交作业**的请求体与响应打出来。
     *
     * 为什么需要：现场报「作业提交失败」，而用户**手动随便选**却能提交成功 ——
     * 失败与答案对错无关，是提交状态平台不认。`btnBlueSubmit()` 本身没抛异常
     *（抛了我们会打印 `btnBlueSubmit failed`，日志里没有），所以拒绝发生在**服务端**。
     * 那唯一能说明原因的就是这次请求的**响应体** —— 平台自己的错误文案在里面。
     *
     * ⚠️ 铁律：**完全穿透**。钩子自身出任何问题都必须原样走原方法 ——
     * 在这里抛一个错，整个页面的 AJAX 都会废掉，比原 bug 严重得多。
     * 所以每一层都 try/catch，且只**读**不**改**（不碰参数、不碰返回值）。
     *
     * 只记跟作业/提交相关的 URL，避免把整页的请求都刷进日志。
     */
    _installSubmitSniffer: function () {
      if (this._submitSnifferInstalled) return;
      this._submitSnifferInstalled = true;
      try {
        var self = this;
        var interesting = /work|submit|exam|homework|answer/i;
        var XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype && XHR.prototype.open && XHR.prototype.send) {
          var origOpen = XHR.prototype.open;
          var origSend = XHR.prototype.send;
          XHR.prototype.open = function (method, url) {
            try {
              this.__omitoneUrl = String(url || '');
              this.__omitoneMethod = String(method || '');
              if (interesting.test(this.__omitoneUrl)) {
                console.log('[Omitone] submit sniffer →', this.__omitoneMethod, this.__omitoneUrl);
              }
            } catch (e0) {}
            return origOpen.apply(this, arguments);
          };
          XHR.prototype.send = function (body) {
            try {
              if (this.__omitoneUrl && interesting.test(this.__omitoneUrl)) {
                var b = body;
                if (b && typeof b !== 'string') {
                  try { b = JSON.stringify(b); } catch (e1) { b = String(b); }
                }
                console.log('[Omitone] submit sniffer body', String(b || '').slice(0, 800));
                this.addEventListener('loadend', function () {
                  try {
                    console.log('[Omitone] submit sniffer ←', this.status,
                      String(this.responseText || '').slice(0, 800));
                  } catch (e2) {}
                });
              }
            } catch (e3) {}
            return origSend.apply(this, arguments);
          };
          console.log('[Omitone] submit sniffer installed');
        }
      } catch (e) { console.warn('[Omitone] submit sniffer 安装失败（不影响功能）', e); }
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

      // 提交后**表单被清空** = 平台没接受这次提交（判错重置 / 静默丢弃）。
      // 这种拒绝不带「请重做」那类文案，`_isQuizRedoRequired` 认不出来 ——
      // 不补这一支，填过的答案就不会进错误缓存，下一轮原样再填，死循环。
      // 给平台 2 秒渲染时间再判，避免"刚提交、DOM 还没更新"时误判。
      // ⚠️ 这里**只记日志，绝不把答案记成错的**。
      //
      // 第一版写成了「静默清空 → 判为被拒绝 → 把答案记进错误缓存」，依据是「平台判错重置」。
      // 但用户实测推翻了它：**显示的是「作业提交失败」，而他随便乱选（多选只选一个）
      // 反而能提交成功** —— 说明失败与答案对错无关，是**我们生成的提交状态**平台不认。
      // 这种前提下把答案记成错的，会**误禁正确答案**，下一轮只会更错。
      //
      // 所以只留一条日志作为信号。真要判「被拒绝」，得先证明失败与答案有关。
      if (now - (this._quizSubmitStartedAt || 0) > 2000 && this._isQuizAnswersCleared(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizSubmitStartedAt = 0;
        emitRuntimeLog('warn', 'quiz answers cleared after submit', {
          note: '表单被清空了 —— 只是记录，不据此把答案判错（失败原因尚未查明）'
        });
        return false;
      }

      var waitMs = Number(this.configs.quizSubmitWaitMs || 25000);
      if (this._quizSubmitStartedAt && now - this._quizSubmitStartedAt > waitMs) {
        this._quizSubmitPending = false;
        // 超时时把「为什么没认出结果页」一并记下来 ——
        // 没有这段的话，日志里只剩一句「等超时了」，缺哪道条件完全靠猜。
        var diag = this._describeQuizResultPage(preferredDoc || null);
        diag.waitMs = waitMs;
        emitRuntimeLog('warn', 'quiz submit wait timeout', diag);
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
      // ===== 题目配图 → 文字（可选，默认关闭）=====
      //
      // 放在这里的原因：题目已经解析完、还没发请求。此时：
      //   - 题干与选项都在手里，能准确判断哪道题真的带图（省掉无图题的冤枉请求）
      //   - 一次只处理**这一卷**的题，开销天然有上界
      //   - 失败也无所谓，往下走就是"和没开视觉时完全一样"
      //
      // 它是 async 的，会 await 一段时间。但预算与张数都有硬上限，
      // 最坏情况就是这一卷慢一点，不会失控。
      // 乱选模式跳过配图识别：既然答案是随机的，把图读成文字纯属白花 token。
      if (!this._isRandomAnswerMode()) {
        await this._applyVisionToQuestions(questions, preferredDoc || null);
      }

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
      var skippedBestEffort = 0;
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
        // 已进入"放弃折腾"的题**不再问模型**：它已经试过好几轮都没被接受，
        // 再问只会把整卷拖在同一个地方（用户报的"一直卡住"），而且白花 token。
        // 这一类题的答案由 _fillBestEffortQuizAnswers 在本地补齐，有日志、可恢复。
        if (self._isQuizQuestionBestEffort(q, quizDoc)) {
          skippedBestEffort++;
          return;
        }
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

      if (skippedConfirmed > 0 || skippedBestEffort > 0) {
        emitRuntimeLog('info', batchRecent ? 'resend full batch for prefix cache' : 'skip llm for cached-correct questions',
          { skipped: skippedConfirmed, bestEffort: skippedBestEffort, asked: payload.length });
      }
      if (payload.length) {
        // 记在"发出去"这一侧而不是"收到成功响应"那一侧：缓存单元是在请求到达时建立的，
        // 即便这次解析失败，前缀也已经进了缓存，下次仍可命中。
        this._quizBatchSentKey = batchWorkKey;
        this._quizBatchSentAt = Date.now();
      }
      if (payload.length === 0) {
        // 两种情况：
        //   ① 全部题目都靠缓存填好了，却没能走上面的提前提交分支 —— 状态自相矛盾，
        //      此时发一次空请求只会白白消耗配额；
        //   ② **全部题目都进了"放弃折腾"**。这种必须自己收尾：本地填猜测、能交就交，
        //      否则这一卷会永远停在"不发请求、也不提交"的状态 —— 又是一种卡住。
        emitRuntimeLog('warn', 'quiz payload empty after cache filter', {
          total: questions.length,
          bestEffort: skippedBestEffort
        });
        if (skippedBestEffort > 0) {
          this._fillBestEffortQuizAnswers(questions, quizDoc);
          var rescueReady = this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true });
          this._quizAnswered = rescueReady;
          this._quizReadyToSubmit = rescueReady;
          this._quizReadyWorkKey = rescueReady ? this._getQuizWorkKey(quizDoc) : '';
          this._quizInProgress = false;
          if (rescueReady) this._maybeSubmitQuiz(quizDoc, questions);
          return;
        }
        this._quizInProgress = false;
        return;
      }

      try {
        // 乱选模式：**不发任何请求**，本地生成同形状的 result，直接走后面的填充。
        // 下游（填充 / 提交 / 判分识别）因此一行都不用改 —— 只换「答案从哪来」。
        var result;
        if (this._isRandomAnswerMode()) {
          this._logRandomAnswers(questions);
          result = { success: true, data: this._buildRandomQuizAnswers(questions) };
        } else {
          result = await bridgeSend('llm_request', { questions: payload });
        }
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
          if (result && result.permanentError) {
            // 服务商返回 4xx：配置问题（Key 无效 / 无权限 / 模型名不存在）。
            //
            // 这一支必须**早于** `_markQuizApiConnectionFailed`：
            // 那会设一个 45 秒的 `_quizApiFailUntil` 退避窗口，于是"填错 Key"
            // 在用户眼里变成"网络连不上、插件每隔 45 秒卡一下"，
            // 而服务商明明把 "Invalid API key" 原话返回来了。
            // 所以这里只跳过本轮、把原话留给用户，改好配置后自动恢复。
            emitRuntimeLog('error', 'quiz llm rejected permanently, no retry', {
              error: String(result.error || '').slice(0, 200),
              skipMs: PERMANENT_LLM_ERROR_SKIP_MS
            });
            this._quizApiLastError = String(result.error || '').slice(0, 300);
            this._quizForceSkipUntil = Date.now() + PERMANENT_LLM_ERROR_SKIP_MS;
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
        // 补填"放弃折腾"的题：它们没进这次请求，表单缺了它们就永远不提交。
        // 放在清理之后是有意的：先让 `_clearKnownWrongFilledQuizAnswers` 处理其他题，
        // 再补上这些题的本地猜测，本轮就不会被它误清。
        this._fillBestEffortQuizAnswers(questions, quizDoc);
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
      // ⚠️ 乱选模式**绝不**写答案缓存。随机答案不是"算出来的结论"，
      // 记进去会污染 AI 模式 —— 用户哪天打开 AI 答题，会被这批垃圾缓存误导。
      if (this._isRandomAnswerMode()) return 0;
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
      // 同上：乱选的"错"没有信息量，记进错误缓存只会让 AI 模式避错避到沟里。
      if (this._isRandomAnswerMode()) return 0;
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
      // ⚠️ 乱选模式同样不写。
      //
      // 一开始我以为这条不能守 —— 怕"不记已提交"会导致重复提交。**那是错的**：
      // `submittedById` 全代码只有一个读取点（`_getLastSubmittedQuizAnswerForQuestion`），
      // 用途是「题目被判错、而答案域为空时，回退用上次提交的答案来记录错误」——
      // 它**不驱动提交流程**。乱选写的随机答案一旦被当成"错答案"记下来，
      // 将来用户换成 AI 答题会被这些无信息量的记录误导。
      if (this._isRandomAnswerMode()) return 0;
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

    /**
     * 这道题是否该"放弃继续折腾"（best-effort）。
     *
     * 触发条件：同一道题已经在错答记录里攒够了失败次数 —— 模型与本地兜底
     * 试过多轮都没被平台接受。继续换答案只会让整卷永远提交不出去
     * （章节小测的提交前置是"每题都有值"），用户看到的就是"一直卡住"。
     *
     * 达到阈值后：不再为它扩错答列表、也不再进 LLM 请求，直接给本地最优猜测，
     * 让整卷能提交、章节能往下走。
     * **一定有日志**（见 _fillBestEffortQuizAnswers 与 _avoidKnownWrongAnswer），
     * 也一定是可恢复的：阈值只影响本次作答，换卷 / 重做会重新计数。
     */
    _isQuizQuestionBestEffort: function (question, preferredDoc) {
      if (!question) return false;
      var max = Number(this.configs.quizQuestionMaxMisses || 3);
      if (!(max > 0)) max = 3;
      var known = this._getKnownWrongQuizAnswers(question, preferredDoc || null);
      return known.length >= max;
    },

    /**
     * 给"已放弃继续折腾"的题补上本地最优猜测。
     *
     * 为什么必须补：章节小测的提交前置条件是**每道题都有值**
     * （_areQuizAnswersFilled），少一道就永远不提交 —— 那才是真正的"卡住"。
     * 这些题已经不进 LLM 请求（见 _handleQuiz），所以必须在这里填，
     * 否则表单不满、整卷原地打转。
     *
     * 代价说明（不藏着）：这道题会被填上一个**本地猜的**答案，
     * 可能仍然不对。这是"跳过该题继续"换来的：整卷能交出去，
     * 而不是被一道题钉死在原地。
     */
    _fillBestEffortQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var filledCount = 0;
      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        if (!question || !question._element) continue;
        if (!this._isQuizQuestionBestEffort(question, preferredDoc)) continue;
        if (this._wasQuizQuestionAnsweredThisRun(question)) continue;
        var type = question.type || this._getQuestionTypeFromElement(question._element, this._getQuestionIdFromElement(question._element));
        if (type !== 'multiple' && type !== 'single' && type !== 'judge') continue;
        var guess = this._chooseFallbackQuizAnswer(type, question, preferredDoc || null, '', type === 'multiple' ? 2 : 1);
        if (type === 'multiple') this._fillMultiChoice(question._element, guess);
        else this._fillChoice(question._element, guess, 'radio');
        var value = this._getQuizQuestionFilledValue(preferredDoc || null, question);
        if (value) {
          this._markQuizQuestionAnsweredThisRun(question, 'best-effort', value, type);
          filledCount++;
        }
      }
      if (filledCount) {
        emitRuntimeLog('warn', 'quiz filled best-effort guesses for repeatedly-wrong questions', { count: filledCount });
      }
      return filledCount;
    },

    /**
     * 多选 fallback 组合的排序：决定"上一个组合（被判错）之后，下一个先试哪个"。
     *
     * 两个必须守住的点（都是踩过的坑）：
     *
     * 1. **目标规模至少 2**。原来 `targetSize = preferredSize || 2`，
     *    而 preferredSize 常常是 `canonical.length` —— 模型只选了一个字母时就是 1，
     *    于是排序把**所有"只选一项"的组合排在前面**：逐个 A、B、C、D 试过去，
     *    每次都只选一个、每次都被判错。用户看到的"多选一直选不对"就是这么来的。
     * 2. **低于最少项数的组合排到最后，但保留**。直接过滤掉它们会出事：
     *    题型名带"不定项"时单选是正确答案，删掉就永远答不对。
     *    排序偏好即可，不必硬删。
     */
    _sortMultiFallbackCombos: function (combos, preferredSize, minSelections) {
      if (!combos || !combos.length) return combos || [];
      var min = Math.max(1, minSelections || 1);
      var targetSize = Math.min(Math.max(2, preferredSize || 2), 6);
      return combos.sort(function (a, b) {
        var belowA = a.length < min ? 1 : 0;
        var belowB = b.length < min ? 1 : 0;
        if (belowA !== belowB) return belowA - belowB;
        var da = Math.abs(a.length - targetSize);
        var db = Math.abs(b.length - targetSize);
        if (da !== db) return da - db;
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : (a > b ? 1 : 0);
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

      var combos = this._sortMultiFallbackCombos(
        this._generateChoiceCombinations(candidates),
        preferredSize,
        this._getMultiChoiceMinSelections(question && question._element)
      );
      for (var k = 0; k < combos.length; k++) {
        var comboCanonical = this._canonicalQuizAnswerForQuestion(combos[k], type, question);
        if (comboCanonical && wrongSet.indexOf(comboCanonical) === -1) return combos[k].split('');
      }

      // ⚠️ 这里**故意不清**已知错答记录（旧实现在这里 clear 了）。
      // 清掉等于把"这卷已经试过哪些答案"整段忘掉：下一轮 `禁:` 为空，
      // 模型很可能又给出同一个错答案 → 判错 → 再清 → 无限打转，
      // 而且 _isQuizQuestionBestEffort 的计数也被抹平，跳过机制永远触发不了。
      // 记着它反而有用：`禁:` 会继续推着模型换答案；换无可换时日志说清楚。
      emitRuntimeLog('warn', 'multiple choice combos exhausted, keep wrong history', {
        wrongs: wrongSet.join(',').slice(0, 120),
        combos: combos.length
      });
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
        // 已连续答错到"放弃折腾"的题：直接给本地最优猜测，不再扩 `禁:` 列表。
        // 见 _isQuizQuestionBestEffort —— 这是"跳过该题继续"的落点，
        // 目的是让整卷能提交出去，而不是让一道题把整卷钉死在原地。
        if (this._isQuizQuestionBestEffort(question, preferredDoc)) {
          var bestEffort = this._chooseFallbackQuizAnswer(type, question, preferredDoc, '', 2);
          emitRuntimeLog('warn', 'multiple choice best-effort answer, stop retrying', {
            index: (question && question.index != null) ? question.index : '',
            fallback: Array.isArray(bestEffort) ? bestEffort.join('') : bestEffort
          });
          return bestEffort;
        }
        var multiCandidates = this._getChoiceCandidateAnswers(question, type);
        var combos = this._generateChoiceCombinations(multiCandidates);
        var preferredSize = canonical ? canonical.length : 0;
        this._sortMultiFallbackCombos(combos, preferredSize || 2, this._getMultiChoiceMinSelections(question && question._element));
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

    /**
     * 视觉预算闸门 —— 这是整个视觉功能里**最重要的安全阀**。
     *
     * 用户能接受「刷不了课」，不能接受「花了钱还是不行」。所以要保证：
     * 无论配置写错、页面版式异常、还是某道题反复触发，都不可能无限发请求。
     *
     * 返回 true = 允许再发一次；false = 预算耗尽，必须停。
     * 耗尽时**必定写一条 warn 日志**，绝不静默 —— 静默烧钱是最糟的失败方式。
     */
    _takeVisionBudget: function (chapterKey) {
      if (!this.configs.visionEnabled) return false;
      var key = String(chapterKey || 'unknown');
      if (this._visionBudgetChapterKey !== key) {
        // 换章即重置。不清零的话，一学期下来后面所有章节都用不了视觉。
        this._visionBudgetChapterKey = key;
        this._visionUsedInChapter = 0;
      }
      var cap = Number(this.configs.visionBudgetPerChapter);
      if (!isFinite(cap) || cap < 0) cap = 0;
      if (this._visionUsedInChapter >= cap) {
        // 同一章只提醒一次，否则每道题刷一条，日志会被淹掉
        if (this._visionBudgetWarnedKey !== key) {
          this._visionBudgetWarnedKey = key;
          emitRuntimeLog('warn', 'vision budget exhausted for this chapter, images will be ignored', {
            used: this._visionUsedInChapter,
            cap: cap,
            chapter: key
          });
        }
        return false;
      }
      this._visionUsedInChapter++;
      return true;
    },

    /**
     * 从题目容器里挑出「值得发给视觉模型」的图。
     *
     * 全部判据都是为了让每一张发出的图都可能真的值一次钱：
     *   - 忽略小图：图标 / 分隔线 / 表情（通常 < 64px，模型看了也说不出东西）
     *   - 忽略透明/空白图：装饰性资源
     *   - 超过体积上限的直接跳过（配置项 visionMaxImageBytes）
     *   - 张数上限 visionMaxImagesPerQuestion
     *   - 去重：同一张图在题干和选项里各出现一次时只发一次
     *
     * 返回 dataURL 数组（可能为空数组，调用方必须处理空的情况）。
     */
    _collectQuestionImages: function (el) {
      var out = [];
      if (!el || !this.configs.visionEnabled) return out;
      var maxImages = Number(this.configs.visionMaxImagesPerQuestion);
      if (!isFinite(maxImages) || maxImages < 1) return out;
      var maxBytes = Number(this.configs.visionMaxImageBytes);
      if (!isFinite(maxBytes) || maxBytes <= 0) maxBytes = 400000;

      var imgs = [];
      try { imgs = Array.from(el.querySelectorAll('img')) } catch (e) { return out; }

      var seen = {};
      for (var i = 0; i < imgs.length && out.length < maxImages; i++) {
        var img = imgs[i];
        try {
          // 尺寸闸门：未加载完的图 naturalWidth 为 0，直接跳过（发出去也是浪费）
          var w = Number(img.naturalWidth || 0);
          var h = Number(img.naturalHeight || 0);
          if (w < 64 || h < 64) continue;
          if (w * h > 4000000) continue; // 超过 400 万像素的图多半是整页扫描件，不划算

          var src = String(img.currentSrc || img.src || '');
          if (!src || src.indexOf('data:') === 0) {
            // 已经是 dataURL（平台用 base64 内联时常见）—— 直接量长度判断体积
            if (src.indexOf('data:image/') === 0) {
              if (src.length > maxBytes * 1.4) continue;
              if (!seen[src]) { seen[src] = 1; out.push(src); }
            }
            continue;
          }
          var abs = this._resolveImageUrl(img);
          if (!abs || seen[abs]) continue;
          seen[abs] = 1;
          out.push(abs);
        } catch (e2) {}
      }
      return out;
    },

    /**
     * 给一批题目补上「配图转述」。
     *
     * 设计要点：
     *   - **只处理真的有图、且过得了尺寸闸门的题**：没有图的题一次请求都不发。
     *     这既省钱，也避免把「无图」退化成一次白花的调用。
     *   - 逐题串行、限量处理。并发发图很容易瞬间打满预算，
     *     而限额是这套功能里唯一的硬保险，不能被并发绕过。
     *   - 单题失败不影响其他题，也绝不影响整卷作答。
     *
     * 全程受 visionEnabled / visionMaxImagesPerQuestion / visionBudgetPerChapter 三道闸门约束。
     */
    _applyVisionToQuestions: async function (questions, preferredDoc) {
      if (!this.configs.visionEnabled) return;
      if (!questions || !questions.length) return;

      var chapterKey = this._getCurrentChapterId() || this._extractFrameKey('vision', 'chapter') || 'chapter';
      var maxPerQuestion = Number(this.configs.visionMaxImagesPerQuestion);
      if (!isFinite(maxPerQuestion) || maxPerQuestion < 1) return;

      var touched = 0;
      for (var i = 0; i < questions.length; i++) {
        var q = questions[i];
        if (!q || !q._element) continue;

        var urls = this._collectQuestionImages(q._element);
        if (!urls.length) continue;

        // 扣预算前先确认这一章还有额度。额度用完时 _describeQuestionImages 会自己写日志，
        // 这里就不再重复遍历后面的题 —— 直接整体退出，省掉剩下的抓图开销。
        if (this._visionUsedInChapter >= Number(this.configs.visionBudgetPerChapter || 0) &&
            this._visionBudgetChapterKey === chapterKey) {
          this._takeVisionBudget(chapterKey); // 触发一次「预算耗尽」日志
          emitRuntimeLog('info', 'vision skipped remaining questions', { from: i, total: questions.length });
          break;
        }

        var described = await this._describeQuestionImages(urls, chapterKey);
        if (described) {
          q.title = this._mergeVisionIntoTitle(q.title, described);
          touched++;
        }
      }

      if (touched > 0) {
        emitRuntimeLog('info', 'vision applied to quiz', {
          questions: questions.length,
          withImage: touched,
          usedBudget: this._visionUsedInChapter
        });
      }
    },

    /** 把视觉描述拼进题干。格式固定，便于模型区分「题面」与「图的转述」。 */
    _mergeVisionIntoTitle: function (title, visionText) {
      var base = String(title || '');
      var extra = String(visionText || '').trim();
      if (!extra) return base;
      return base + ' [配图: ' + extra + ']';
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
        if (usable.length) return this._pairOptionControls(el, usable);
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


    /**
     * 作业/考试页「文本与控件分离」的补偿。
     *
     * 结构上：选项**文本**在 `.Cy_ulTop` 的 li 里，可点的 **input 在 `.Cy_ulBottom` 的 li**，
     * 是**两个分开的 ul**。而 `_clickOptionItem` 靠 `item.querySelector('input')` 找控件，
     * 拿到文本那一列时 input 恒为 null —— 一下都没点到，站点一个答案都收不到。
     * 表现是"题抠对了、日志也打了 clicked option，但一道都没答上"，然后空转。
     *
     * 参考实现（cxmooc-tools 的 `cxExamSelectQuestion`）干脆把 input 直接当选项节点、
     * 文本另按位置取。这里不动整体结构，只把控件**按索引**配对挂到文本节点上：
     * 文本 / qid / 徽标继续从文本节点读，点击时改用配到的 input。
     *
     * 只在「本列一个控件都没有」且「另一列数量刚好对得上」时才配 ——
     * 对不上宁可不配，免得错位把答案点到别的选项上（那比不答更糟）。
     */
    _pairOptionControls: function (el, items) {
      if (!el || !items || !items.length) return items;

      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].querySelector && items[i].querySelector('input')) return items;
      }

      var controls = [];
      try {
        controls = Array.from(el.querySelectorAll('li')).filter(function (n) {
          return n.querySelector && n.querySelector('input[type="radio"], input[type="checkbox"]');
        });
      } catch (e) { return items; }
      if (controls.length !== items.length) return items;

      for (var k = 0; k < items.length; k++) {
        if (!items[k]) continue;
        try {
          items[k]._optionInput = controls[k].querySelector('input[type="radio"], input[type="checkbox"]');
        } catch (e2) {}
      }
      return items;
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


    /**
     * 点选一个选项 —— 调用返回后，这个选项**一定**处于"已选中"状态（幂等）。
     *
     * 为什么必须幂等（踩过的坑）：原来的顺序是"先按当前状态取反写 class，
     * 再 item.click() + 内层徽标 click()"。单选无所谓，但**复选是开关** ——
     * 站点自己的 click 处理会再切换一次，以及"点 li + 点徽标"本身就是两次，
     * 偶数次点击等于没点。表现是多选**随机少选一项**（用户报的"只选一个"），
     * 接着被判错，再进入"重试还是只选一个"的死循环。
     *
     * 现在的顺序：① 先点击，让站点自己的处理跑起来（它可能在点击时重绘、写隐藏域）；
     * ② 再把**终态**强制写回（class / aria / input.checked / #answer{qid}）。
     * 这样站点那边怎么切都不影响最终状态。
     */
    _clickOptionItem: function (item, inputType) {
      if (!item) return;
      var doc = item.ownerDocument || document;
      // qid 的**三级回退**（历史上只认第一级，于是作业页永远写不进隐藏域）。
      //
      //   ① 选项自身带 qid —— 章节测验的 <li qid="..."> 走这条
      //   ② 向上找最近的 [qid] 祖先 —— 作业/考试页把 qid 挂在容器
      //      `.Cy_TItle[qid]` 上，选项 <li> 自己是干净的
      //   ③ `_getQuestionIdFromElement` —— 它还会试 `.singleQuesId[data]`、
      //      `#answer{qid}` 的 id、以及 `.num_option` 徽标的 name
      //
      // 为什么必须回退：写隐藏域那一段原本要求 `qid && badge` **同时**成立，
      // 而真实作业页两样都没有（无徽标、<li> 无 qid）。于是点击动作照做、
      // 日志照打 "clicked option"，但 #answer{qid} 一直是空串 ——
      // `_getQuizQuestionFilledValue` 返回 ''，`_areQuizAnswersFilled` 判 false，
      // 整卷永不提交。表现就是"AI 扫到题、点了选项、然后什么都不发生"。
      var qid = String((item.getAttribute && item.getAttribute('qid')) || '').trim();
      if (!qid && item.closest) {
        var qidHost = item.closest('[qid], [data-qid]');
        qid = String((qidHost && qidHost.getAttribute && (qidHost.getAttribute('qid') || qidHost.getAttribute('data-qid'))) || '').trim();
      }
      if (!qid) qid = String(this._getQuestionIdFromElement(item) || '').trim();

      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      var rawValue = badge ? String(badge.getAttribute('data') || textOf(badge)).trim() : '';
      var letter = /^[A-F]$/i.test(rawValue) ? rawValue.toUpperCase() : rawValue;
      // 没有徽标时（作业/考试页的常态）用 _inferOptionLetter 取字母：
      // 它已经支持 input.value / aria-label / 文本前缀 "A." 等来源。
      // 拿不到就留空 —— 宁可让上层判"未填写"，也不要往隐藏域写错答案。
      if (!letter) {
        var idx = -1;
        try {
          var siblings = item.parentElement ? Array.from(item.parentElement.children) : [];
          idx = siblings.indexOf(item);
        } catch (eIdx) {}
        letter = String(this._inferOptionLetter(item, idx < 0 ? 0 : idx) || '');
      }

      // 控件自身的 value 才是隐藏域的**权威值**，字母只是"认选项"用的。
      //
      // 判断题就是典型：选项文本是 `A. 正确` / `B. 错误`，字母能推出 A/B，
      // 但站点在隐藏域里要的是 `true` / `false`（radio 的 value），
      // 写字母进去会让平台收到一个它不认识的答案 —— 判分必然错。
      // 所以：控件 value 是 `true/false` 这种非字母语义值时，以它为准。
      var controlValue = '';
      try {
        var ctrl = item.querySelector ? item.querySelector('input[type="radio"], input[type="checkbox"], input[type="hidden"]') : null;
        if (!ctrl && item._optionInput) ctrl = item._optionInput;
        if (ctrl) controlValue = String(ctrl.value || ctrl.getAttribute('value') || '').trim();
      } catch (eCtrl) {}
      if (controlValue && !/^[A-F]$/i.test(controlValue)) {
        letter = controlValue;
      }

      // ① 点击：先让站点自己的 handler 跑完
      var input = item.querySelector ? item.querySelector('input[type="' + inputType + '"]') : null;
      if (!input && item._optionInput) {
        var pairedType = String((item._optionInput.getAttribute && item._optionInput.getAttribute('type')) || '').toLowerCase();
        if (pairedType === inputType) input = item._optionInput;
      }

      if (item._optionInput) {
        // 文本与控件分离（作业/考试页）：文本节点上没有任何可点的东西，
        // 直接点配对到的 input —— 事件从 input 冒泡，
        // 站点把 handler 挂在 input / label / li 上都收得到。
        // 必须**先点再置 checked**：复选上"先置 true 再 click"会被再切一次，反而变未选。
        try { item._optionInput.click(); } catch (ePair) {}
      }

      if (input) {
        try { input.checked = true; } catch (e0) {}
        this._dispatchQuizInputEvents(input);
      }

      if (!item._optionInput) {
        try { item.click(); } catch (e) {}
        if (item.querySelector) {
          var clickTarget = item.querySelector('.num_option, .num_option_dx, label, .fl.after');
          // 徽标可能就在 item 自身这一层，重复点同一个元素只会多点一次（复选上就是再取消）
          if (clickTarget && clickTarget !== item) {
            try { clickTarget.click(); } catch (e2) {}
          }
        }
      }

      // ② 写回终态
      //
      // 拆成两段的原因（原本 `qid && badge` 一个大 if 把两件事焊死了）：
      //   - 徽标那组操作（.choice{qid} 的 class、aria）**只在有 badge 时**做，
      //     因为它就是给徽标用的；
      //   - 写隐藏域 #answer{qid} **只要有 qid 就必须做** —— 那是平台提交时读的字段，
      //     也是插件自己判"填没填"的依据。作业/考试页没有徽标，
      //     焊在一起就等于"点了选项但隐藏域永远空着"，整卷永不提交。
      if (qid && badge) {
        var group = '.choice' + qid;
        if (inputType === 'radio') {
          Array.from(doc.querySelectorAll(group)).forEach(function (node) {
            node.classList.remove('check_answer');
          });
          badge.classList.add('check_answer');
          Array.from(item.parentElement ? item.parentElement.children : []).forEach(function (sibling) {
            if (sibling !== item) {
              sibling.setAttribute('aria-checked', 'false');
              sibling.setAttribute('aria-pressed', 'false');
            }
          });
        } else {
          // 复选**只加不减**：取消是 _clearMultiChoiceSelection 的职责。
          badge.classList.add('check_answer_dx');
        }
      }
      if (qid) {
        item.setAttribute('aria-checked', 'true');
        item.setAttribute('aria-pressed', 'true');

        var hidden = doc.getElementById('answer' + qid);
        if (hidden) {
          var value = letter;
          if (inputType !== 'radio') {
            // 隐藏域必须是**全部已选项**的并集，而不是刚点的那一个字母 ——
            // 否则多选提交上去永远只有最后一项。
            value = '';
            if (badge) {
              Array.from(doc.querySelectorAll('.choice' + qid)).forEach(function (node) {
                if (node.classList.contains('check_answer_dx')) {
                  value += String(node.getAttribute('data') || '').trim();
                }
              });
            } else {
              // 无徽标（作业/考试页）：只能按"本组当前勾选的 input"汇总。
              // 先清空再按勾选态重算，避免把上一轮遗留的字母一起带上。
              var picked = [];
              try {
                var ipts = Array.from(doc.querySelectorAll('input[type="' + inputType + '"][name="answer' + qid + '"]'));
                ipts.forEach(function (ip, order) {
                  if (!ip.checked) return;
                  var l = String(ip.value || ip.getAttribute('value') || '').trim();
                  if (!/^[A-F]$/i.test(l)) l = String.fromCharCode(65 + order);
                  picked.push(l.toUpperCase());
                });
              } catch (ePick) {}
              picked.sort();
              value = picked.join('');
            }
          }
          if (value) {
            hidden.value = value;
            this._dispatchQuizInputEvents(hidden);
            // 记下**我们写进去的值**。站点自己的 handler 可能在这之后又改一遍 ——
            // 现场实测：我们按 A→B→C→D 点，最终字段却是 DBAC（既非点击序也非字母序），
            // 说明有人在我们之后重写了它。把 ours 与提交前那条 answer field 日志一比，
            // 就能立刻分辨「我们的值生效了」还是「被平台覆盖了」。
            console.log('[Omitone] answer field written qid=', qid, 'ours=', value);
          }
        }
      }

      if (input) {
        try { input.checked = true; } catch (e3) {}
      }
      console.log('[Omitone] clicked option qid=', qid, 'letter=', letter, 'type=', inputType);
    },


    /**
     * 某个答案（字母或选项文本）对应的选项**当前是否已选中**。
     *
     * 只给"点完之后校验"用（多选重灾区）。**认不出来时返回 true** ——
     * 宁可少修一次，也不要对已经选中的复选项再点一下：复选上多点一次就是取消，
     * 那正是要修掉的病。
     */
    _isChoiceValueSelected: function (root, value, type) {
      if (!root) return true;
      var item = this._matchOptionItem(root, value, type);
      if (!item) return false;
      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      if (badge && badge.classList) {
        if (badge.classList.contains('check_answer_dx') || badge.classList.contains('check_answer')) return true;
      }
      var aria = item.getAttribute ? String(item.getAttribute('aria-checked') || '') : '';
      if (aria === 'true') return true;
      var input = item.querySelector ? item.querySelector('input[type="checkbox"], input[type="radio"]') : null;
      if (!input && item._optionInput) input = item._optionInput; // 文本与控件分离时控件挂在配对节点上
      if (input) return !!input.checked;
      return true;
    },


    /**
     * 该用哪种控件去点：'radio' / 'checkbox'。
     *
     * 题型明确时照题型走；题型未知（弹题那条路）时按**控件形态**判 ——
     * 页面里有复选就按复选填，这与原 `_fillPopupAnswer` 的行为一致。
     */
    _choiceInputTypeFor: function (root, type) {
      if (type === 'multiple') return 'checkbox';
      if (type === 'single' || type === 'judge') return 'radio';
      var checkboxes = 0;
      if (root && root.querySelectorAll) {
        try { checkboxes = root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length; } catch (e) {}
      }
      return checkboxes ? 'checkbox' : 'radio';
    },


    /**
     * 多选题"最少该选几项"。
     *
     * ⚠️ **不能一律钉成 2**：学习通的"不定项选择题"允许多选也允许单选，
     * 钉成 2 会把本来正确的单答案判成无效，反而更卡。所以按题型名区分，
     * 认不出来时取 1（保守，宁可维持旧行为）。
     */
    _getMultiChoiceMinSelections: function (root) {
      var name = '';
      if (root && root.getAttribute) {
        name = String(root.getAttribute('typename') || root.getAttribute('typeName') || '').trim();
        if (!name && root.querySelector) {
          var titleEl = root.querySelector('.newZy_TItle');
          if (titleEl) name = textOf(titleEl);
        }
      }
      if (!name && root) name = textOf(root).slice(0, 80);
      if (/不定项/.test(name)) return 1;
      if (/多选|多项|多重/.test(name)) return 2;
      return 1;
    },


    /**
     * 把一个字母扩成"含它的相邻组合"，用于模型只给了一个字母的多选题。
     *
     * 这是**纯本地**补救：不发新请求，因此不产生任何 token。
     * 依据是"复选题两项答案远比一项常见"。
     *
     * ⚠️ `banned` 是**必须**传的：本函数是确定性的（答 "A" 永远补成 "AB"），
     * 如果不避开已经判错的组合，"换别的组合"这句承诺就是空的 —— 实测会无限重交。
     */
    _expandMultiChoiceLetters: function (letters, min, root, banned) {
      var out = (letters || []).slice();
      var target = Math.max(2, min || 2);
      var total = this._getOptionItems(root).length;
      if (total < 2 || total > 8) total = 6;
      var pool = [];
      for (var i = 0; i < total; i++) pool.push(String.fromCharCode(65 + i));

      // 已经判错的组合绝不再补出来 —— 否则会陷入
      //「补成 AB → 判错 → AB 进禁选 → 又补成 AB」的死循环（现场表现是反复重交）。
      var bannedSet = banned || [];
      var isBanned = function (combo) {
        if (!bannedSet.length) return false;
        var sorted = combo.slice().sort();
        var canonical = null;
        try { canonical = this._canonicalQuizAnswerForQuestion(sorted, 'multiple', { _element: root }); } catch (e) {}
        if (!canonical) canonical = sorted.join('');
        return bannedSet.indexOf(canonical) !== -1;
      }.bind(this);

      for (var j = 0; j < out.length && out.length < target; j++) {
        var idx = pool.indexOf(out[j]);
        if (idx < 0) continue;
        // 优先"紧邻的下一个"，其次上一个，最后再往后挑 —— 相邻组合最常见
        var candidates = [pool[idx + 1], pool[idx - 1], pool[idx + 2], pool[idx + 3]];
        for (var c = 0; c < candidates.length && out.length < target; c++) {
          var cand = candidates[c];
          if (!cand || out.indexOf(cand) !== -1) continue;
          if (isBanned(out.concat([cand]))) continue;   // ← 这个组合判错过，换下一个候选
          out.push(cand);
        }
      }
      return out.sort();
    },


    /**
     * 把一个答案规整成"要点的选项列表"。
     *
     * 兼容模型的各种写法：数组 `["A","C"]`、带分隔符 `"A,C"`/`"A、C"`、
     * **不带分隔符的连写** `"AC"`、以及整段选项文本。
     * 最后一种在弹题里很常见（模型不认字母表，直接抄选项文字）。
     */
    _normalizeChoiceAnswerValues: function (answer, type, root) {
      var value = this._normalizeAnswerValue(answer);
      var values = [];
      if (Array.isArray(value)) {
        values = value.map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean);
      } else {
        var raw = String(value == null ? '' : value).trim();
        if (!raw) return [];
        if (/^[A-F,，、;；\s]+$/i.test(raw)) {
          values = raw.replace(/[，、;；\s]+/g, ',').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          // "AC" 这种连写：长度 > 1 的单个 token 按单字母拆开
          if (values.length === 1 && values[0].length > 1) values = values[0].split('');
        } else {
          values = [raw];
        }
      }

      // 去重：多选里同一个字母点两次 = 取消（复选是开关）
      var seen = {};
      values = values.filter(function (v) {
        var key = String(v).toUpperCase();
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });

      if (type === 'multiple') {
        var letters = values.filter(function (v) { return /^[A-F]$/i.test(v); }).map(function (v) { return v.toUpperCase(); });
        // ⚠️ 必须**排序**，不能沿用模型给的顺序。
        // 本文件对多选答案的"规范形式"是排过序的（见 `_canonicalQuizAnswer` 末尾的 `.sort()`），
        // 而**点选顺序决定平台隐藏域 `#answer{qid}` 的内容** ——
        // 模型回 ["D","B","A","C"] 时我们按原序点，隐藏域就成了 "DBAC"，
        // 而规范形式是 "ABCD"。现场实测：顺序碰巧对时能过、不对就判错重交（用户报"时灵时不灵"）。
        if (letters.length > 1) letters = letters.slice().sort();
        var min = this._getMultiChoiceMinSelections(root);
        if (letters.length >= 1 && letters.length < min) {
          // ⚠️ 补选前**必须**先拿禁选集合。_expandMultiChoiceLetters 是确定性的
          //（答 "A" 永远补成 "AB"），而补选发生在 _avoidKnownWrongAnswer **之后** ——
          // 于是「补成 AB → 判错 → AB 进禁选 → 模型仍答 A → 又补成 AB」无限循环。
          // 现场表现：作业页反复重交（用户报「重复刷」）。
          var bannedSet = [];
          try {
            bannedSet = this._getKnownWrongCanonicalSet({ _element: root }, 'multiple', root.ownerDocument) || [];
          } catch (eB) { bannedSet = []; }
          // ⚠️ **只在模型给的组合已经试过且失败时**才补选。
          //
          // 1.1.5 加这个补选的目的，看它自己的记录是「让重试别总在"只选一项"里打转」——
          // 是个**分散重试**的启发式，**不是**平台约束。
          // 而用户实测推翻了那个隐含前提：**多选只选一个照样能提交成功**。
          // 所以第一次就凭空补一项 = 造一个模型没给的答案 —— 那正是判错的一个来源。
          // 现在只在"这个组合已经判错过"时才补（那种情况下不补就只会原地打转）。
          var mineCanonical = letters.slice().sort().join('');
          var alreadyFailed = bannedSet.indexOf(mineCanonical) !== -1;
          var expanded = alreadyFailed
            ? this._expandMultiChoiceLetters(letters, min, root, bannedSet)
            : letters;
          if (expanded.length > letters.length) {
            emitRuntimeLog('warn', 'multiple choice answer expanded locally', {
              from: letters.join(''), to: expanded.join(''), minSelections: min,
              avoidedWrong: bannedSet.length ? bannedSet.join(',') : ''
            });
          } else if (bannedSet.length) {
            emitRuntimeLog('warn', 'multiple choice expansion blocked by wrong-answer cache', {
              letters: letters.join(''), minSelections: min, wrongs: bannedSet.join(',')
            });
          }
          var texts = values.filter(function (v) { return !/^[A-F]$/i.test(v); });
          return expanded.concat(texts);
        }
        // 不需要补选时，也按**排序后**的字母返回 ——
        // 与 `_canonicalQuizAnswer` 的规范形式保持一致，否则隐藏域又变成乱序。
        if (letters.length) {
          return letters.concat(values.filter(function (v) { return !/^[A-F]$/i.test(v); }));
        }
      }
      return values;
    },


    /**
     * 选项答案填充的**唯一入口**（单选 / 判断 / 多选共用，章节小测与视频弹题共用）。
     *
     * 参数：
     *   root      题目元素或弹窗元素
     *   answer    模型给的答案（数组 / 字母 / 连写字母 / 选项文本都行）
     *   type      题型；传空串表示"交给 _matchOptionItem 自己判"（判断题要靠它）
     *   inputType 强制控件类型（'radio' / 'checkbox'）；不传则按题型或控件形态推
     *
     * 返回**成功点上的选项数**；0 表示一个都没匹配上（调用方不该点提交）。
     */
    _applyChoiceAnswer: function (root, answer, type, inputType) {
      if (!root) return 0;
      var kind = inputType || this._choiceInputTypeFor(root, type);
      var values = this._normalizeChoiceAnswerValues(answer, type, root);
      if (!values.length) return 0;

      // 复选先清空：上一轮留下的选择会让"这轮点了几项"完全失真
      if (kind === 'checkbox') this._clearMultiChoiceSelection(root);

      var clicked = 0;
      for (var i = 0; i < values.length; i++) {
        var item = this._matchOptionItem(root, values[i], type);
        if (!item) continue;
        this._clickOptionItem(item, kind);
        clicked++;
      }

      // 校验 + 修补：站点自己的 handler 可能把刚点上的又切掉了（复选重灾区）。
      // 只补"该选却没选中"的 —— 绝不碰已经选中的，避免把复选又切回去。
      if (kind === 'checkbox' && clicked > 1) {
        for (var j = 0; j < values.length; j++) {
          if (this._isChoiceValueSelected(root, values[j], type)) continue;
          var again = this._matchOptionItem(root, values[j], type);
          if (!again) continue;
          this._clickOptionItem(again, kind);
        }
      }
      return clicked;
    },


    _fillChoice: function (el, answer, inputType) {
      // type 传空串：让 _matchOptionItem 自己判题型 —— 判断题的匹配分支靠它，
      // 硬编码成 'single' 会让"正确/错误"这类答案匹配不上（老实现就是这样绕开的）。
      var clicked = this._applyChoiceAnswer(el, answer, '', inputType);
      if (!clicked) console.warn('[Omitone] no matching option for answer', answer, textOf(el).slice(0, 120));
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
      this._applyChoiceAnswer(el, answers, 'multiple', 'checkbox');
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
        // "放弃折腾"的题例外：它填的就是本地猜的答案，很可能仍在错答记录里。
        // 把它清掉 = 表单缺一道 = `_areQuizAnswersFilled` 为假 = 永远不提交，
        // 那就正好回到了我们要消除的"卡住"。
        if (this._isQuizQuestionBestEffort(questions[i], preferredDoc)) continue;
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
            // 先把「平台会提交什么」打出来 —— 失败原因排查全靠它
            this._logSubmitPayload(submitQuestions, effectiveDoc || submitDoc);
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
      // ⚠️ 填完答案后的静默期：**站点会重绘弹窗**（给正确项打勾 / 加提示 / 重排），
      // 而指纹取的是选项文本 —— 文本一变指纹就变，「已答放行」立刻失效，
      // 弹窗被当成新题 → 再问模型 → 再点一次选项 → 站点再重绘 …… 死循环。
      // 现场表现就是「选项一直闪」，而且因为指纹一变 attempts 就重置，
      // 「最多问 3 次就放手」的安全阀**永远触发不了**。
      // 所以填完之后先静默一段时间，无论指纹怎么变都不碰它。
      if (now < (this._popupQuizQuietUntil || 0)) {
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
        this._popupQuizQuietUntil = 0;
      } else {
        // 已经答过、但站点还没把弹窗收走：这段时间别再问第二遍模型，也别继续拦着刷课。
        //
        // 与上面那段静默期的分工：静默期管的是"刚填完、站点可能正在重绘"，
        // 这一段管的是"弹窗消失又冒出来、指纹一模一样"（站点重开同一道题）——
        // 那时静默期可能已经被上面"弹窗没了"的分支清掉，靠这个标记继续压住。
        //
        // ⚠️ 窗口必须与静默期**相等**，绝不能更长。曾经写死 30 秒，比 8 秒静默期长 22 秒，
        // 于是答错之后有整整 22 秒处于"静默期已过、却仍被当成已答"的没人管空档：
        // 弹窗挂在那儿没人重试，恢复播放那条路也以为"没有弹窗"去抢恢复被站点有意暂停的视频。
        // 用户看到的就是"答完就卡住、等半天没反应"。现在两者共用同一个常量。
        var key = this._popupQuizFingerprint(node);
        if (key === this._popupQuizSolvedKey && now - (this._popupQuizSolvedAt || 0) < POPUP_QUIZ_QUIET_MS) {
          node = null;
        }
      }

      this._popupBlockCheckedAt = now;
      this._popupBlockCached = node;
      return node;
    },


    /**
     * 弹题是否正在**挡着播放**。
     *
     * 与 `_activePopupBlock()` 的关键区别：**静默期也算挡着**。
     *
     * 这两个其实是不同的问题，以前共用一个函数才出的事：
     *   · "现在该不该去处理这道弹题？" —— 静默期里的答案是"不"（怕站点重绘导致选项闪烁）
     *   · "现在能不能恢复播放？"     —— 静默期里的答案必须是"不能"
     * 静默期里 `_activePopupBlock()` 返回 null 只回答了前者，**不代表弹窗已经没了**。
     * 而站点是为弹题**有意暂停**了视频；如果据此就去抢恢复播放，就会和站点对打，
     * 现场表现就是"答完之后视频不动、看着像卡死"。
     *
     * 这里直接看 DOM 里还有没有弹窗。不做 400ms 缓存 —— 它只在 pause 事件里被调用，
     * 频率远低于 tick，没必要为它维护一份可能与上面缓存语义冲突的状态。
     * 放弃窗口内返回 false：那道题已经决定不管了，就别再拦着恢复播放。
     */
    _popupQuizBlocksPlayback: function () {
      var now = Date.now();
      if (this._popupQuizBlockedUntil && now < this._popupQuizBlockedUntil) return false;
      try {
        return !!this._checkPopupQuiz();
      } catch (e) {
        return false;
      }
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
          // 特意留一条日志：用户报过"答完弹题就卡住、不知道会不会自己好"，
          // 这条能直接说明"不是卡住，是上一个答案被平台拒了、正在换一个重试"。
          emitRuntimeLog('info', 'popup quiz answer rejected by site, retrying with a different one', {
            attempt: this._popupQuizAttempts,
            rejected: String(this._popupQuizLastFilled).slice(0, 40),
            banned: (this._popupQuizWrongAnswers || []).slice(0, 6)
          });
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
          // 乱选模式：弹题同样本地生成，**不发请求**（与主流程同源）。
          var result;
          if (this._isRandomAnswerMode()) {
            this._logRandomAnswers([question]);
            result = { success: true, data: [this._buildRandomQuizAnswers([question])[0]] };
          } else {
            result = await bridgeSend('llm_request', { questions: [question] });
          }
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
                options: question.options.slice(0, 6),
                // 告诉看日志的人"接下来会静一会儿，不是卡死"
                waitMs: POPUP_QUIZ_QUIET_MS
              });
              // 记下这轮填的答案。下一轮如果同一道题还在，就说明它没被接受。
              this._popupQuizLastFilled = String(this._normalizeAnswerValue(answer) || '');
              // 静默 8 秒：给站点足够时间收走弹窗。这段时间内哪怕指纹变了也不碰它，
              // 否则站点重绘 → 指纹变 → 重问重填 → 选项闪烁，就是这么来的。
              this._popupQuizQuietUntil = Date.now() + 8000;
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
          if (result && result.permanentError) {
            // 与 _handleQuiz 同源：4xx 是配置问题，不是网络问题。
            // 标记"连接失败"会让弹题也挤进 45 秒退避，用户同样只看到插件卡住。
            // 这里改走"放弃这道弹题"：关掉弹窗 + 冷却 60 秒，
            // 既不会拿坏 Key 反复去撞接口，也不把课程卡在这里。
            emitRuntimeLog('error', 'popup quiz llm rejected permanently, no retry', {
              error: String(result.error || '').slice(0, 200)
            });
            this._quizApiLastError = String(result.error || '').slice(0, 300);
            this._giveUpPopupQuiz(popup, 'llm-permanent-error');
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
      this._popupQuizQuietUntil = 0;
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


    /**
     * 返回是否真的选中了至少一个选项（没选中就不该点提交）。
     *
     * ⚠️ 选项的匹配与点选一律走 `_applyChoiceAnswer`，**不要再在这里写一份**。
     * 原先这里自己写了一套，与章节小测的 `_fillMultiChoice` 规则不同 ——
     * 它没有 "AC" → ["A","C"] 的拆分，模型只要回一个不带分隔符的连写字母，
     * 就一个选项都匹配不上（"扫到了题却从不填"），或者只中第一个字母
     * （多选只选一个 → 站点判错 → 反复重试 → 用户看到的"一直选不对"）。
     */
    _fillPopupAnswer: function (popup, answer, type) {
      var value = this._normalizeAnswerValue(answer);
      var selected = this._applyChoiceAnswer(popup, value, type || '');

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
    },
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


