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
 * 本段的状态字段（152 个）：configs、_videoEl、_videoCount、_currentVideoIndex、_isPlaying、_checkInterval、_tickLoopInterval、_tickRunning、_tickStartedAt、_tickEpoch、_tickProgressAt、_tickProgressNote、_tickProgressLogAt、_quizInProgress、_quizInProgressAt、_quizAnswered、_quizSubmitPending、_quizSubmitStartedAt、_quizSubmitLogAt、_quizLastSubmitAttemptAt、_quizHoldLogAt、_quizCorrectAnswerCache、_quizCurrentAnsweredKeys、_quizCurrentAnswerValues、_quizCurrentQuestions、_quizReadyToSubmit、_quizReadyWorkKey、_quizForceSkipUntil、_quizForceSkipPaperKey、_quizReviewPaperKey、_quizReviewUntil、_quizGarbledRoundAt、_quizApiSkipLogAt、_quizBlockedByApiAt、_quizBlockedSinceAt、_quizBlockedHoldLogAt、_quizBlockedGiveUpLogAt、_quizHoldReasonLogAt、_quizLocalMultiplePapers、_quizScanDiagAt、_popupQuizKey、_popupQuizAttempts、_popupQuizBlockedUntil、_popupQuizLogAt、_popupQuizSolvedKey、_popupQuizSolvedAt、_popupQuizWrongAnswers、_popupQuizLastFilled、_popupQuizQuietUntil、_popupBlockCheckedAt、_popupBlockCached、_quizBatchSentKey、_quizBatchSentAt、_continueStudyAt、_continueStudyScanAt、_continueStudyKey、_continueStudyClicks、_continueStudyBlockedUntil、_taskAttempts、_taskProgress、_detectedMaxRate、_rateDetectVideo、_rateDetectBusy、_rateProbing、_bgWorker、_bgWorkerUrl、_workerDelayCallbacks、_workerDelaySeq、_audioKeepalive、_mediaRepaired、_pauseResumePending、_pauseResumeLogAt、_pauseResumeSuppressed、_visibilityBound、_captchaActive、_captchaBusy、_captchaAttempts、_captchaFailCount、_captchaLastCheckAt、_captchaLastResult、_discussionWindow、_discussionOpenedAt、_discussionScanAt、_discussionBusy、_discussionPosted、_discussionExpanded、_discussionBefore、_discussionScrollAt、_discussionCardOpened、_discussionPageUrl、_discussionPageAt、_discussionPageResult、_discussionEditorEl、_discussionNameRead、_discussionPendingCache、_discussionHoldSinceAt、_discussionHoldKey、_discussionHoldSpent、_discussionDupLogAt、_discussionSettledLogAt、_unfinishedPromptClickedAt、_voteTryMap、_quizApiFailUntil、_quizApiLastError、_stepNavigationBound、_stepSwitchPending、_stepSwitchAt、_skipChainCount、_videoRetryCount、_lastChapterKey、_delayedNextUnitTimer、_guardLastTime、_guardLastWallTs、_guardLastResumeTs、_resumeWindowStart、_resumeAttemptCount、_activeMediaJobPending、_activeMediaJobManaged、_activeDocumentJobPending、_activeDocumentJobManaged、_activeDocumentJobDoc、_mediaWaitLogAt、_documentWaitLogAt、_lastLearningTabSwitchAt、_lastLearningCardKey、_docTaskState、_treeContainerEl、_taskDiscoverStartedAt、_taskWaitLogAt、_pendingTaskKey、_pendingTaskStartedAt、_pendingTaskLogAt、_submitConfirmLastClickAt、_activeJobId、_cellData、_unsupportedJobLogged、_visionUsedInChapter、_visionBudgetChapterKey、_discussionStoreKey、_taskGiveUpStoreKey、_quizContainerSelector、_questionSelectors、_quizDetectorSelector、_quizAnswerControlSelector、_questionTitleSelectors、_optionListSelectors、_quizRunPaperKey、_quizParseRetryUntil、_quizParseRetryScope、_quizParseRetryWarnAt、_taskFrameLoadingUntil、_taskFrameLoadingScope
 *
 * 本段的方法（4 个）：
 *   _assertActive、run、play、_resetRuntimeState
 * ========================================================================== */
// @omitone-part-header-end
    configs: mergeConfig({ hasApiKey: false, autoNext: true, enableQuiz: false }),


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

    // `_quizInProgress` 置真的时刻 —— 专给「泄漏自愈」用（70-quiz-flow.js `_handleQuiz`）。
    // 没有它，异常岔路留下的 true 就是永久的：第一行挡住一切、整页停摆，
    // 日志里只有一条 30 秒去重的 tick error。声明在这儿而不是就地赋值，
    // 是为了让它进片段头清单（`npm run check` 第 15 项核对状态字段与计数）。
    _quizInProgressAt: 0,

    _quizAnswered: false,

    _quizSubmitPending: false,

    _quizSubmitStartedAt: 0,

    _quizSubmitLogAt: 0,

    _quizLastSubmitAttemptAt: 0,

    _quizHoldLogAt: 0,

    // 批次 10-C：「有作答框 + 命中题形容器、却一题没抠出来」的帧 —— 完成判定的**有界**延时。
    // `_quizParseRetryUntil` 是窗口终点，`_quizParseRetryScope` 记住这个窗口已经给过哪张卡片
    // （同一张卡片只给一次，用完就放行，避免把「跳过」换成另一种「磨蹭」），
    // `_quizParseRetryWarnAt` 只给「窗口已用掉」那条 warn 去重。声明在此见本段头注。
    _quizParseRetryUntil: 0,
    _quizParseRetryScope: '',
    _quizParseRetryWarnAt: 0,

    // 批次 19-B：任务帧**自己说还在加载**（「正在为您加载文件…」）或整张白纸时的有界搜索窗。
    // 现场（2026-11-11 真页面）：13:41:20 `study begin {attachments:6}` →
    //   13:41:33 `every candidate frame was rejected {sig.text:"正在为您加载文件..."}` →
    //   `study finished on page {searchedCount:0}` → 整节 6 个任务点被翻过去。
    // 与 `_quizParseRetry*` 同一套纪律：每张卡片只给一个窗口，用完放行，不许把「跳过」换成「磨蹭」。
    _taskFrameLoadingUntil: 0,
    _taskFrameLoadingScope: '',

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

    // 「这一份卷子」的暂停键 —— 与 `_quizForceSkipUntil` 成对写入（走 `_setQuizForceSkip`）。
    //
    // 为什么必须有它：`_quizForceSkipUntil` 单独一个时间戳是**页面级**的，
    // 而 `_isQuizLearningPending()` 第一行就 `if (this._isQuizForceSkipping(preferredDoc || null)) return false;`
    // —— 于是「A 卷子坏了」会被调度理解成「这一页所有答题任务点都不用做」，
    // 一张坏卷子能把整门课冻结到冷却结束。写入时带上卷子身份键，
    // 判定时只对同一份卷子生效（键为空 = 老的全局语义，见 `_isQuizForceSkipping`）。
    // ⚠️ 键是**按文档**算的（`_getQuizWorkKey(doc)` 会先解析提交文档），
    //   所以写入端与读取端必须用同一个文档表达式 —— 判定端要拿到当前文档，
    //   两侧错开时表现不是「没暂停」而是「这一节永久停摆」（日志却写着已暂停）。
    _quizForceSkipPaperKey: '',

    // 「乱选填完了，先别交，给用户留几秒改」的窗口（判据见 75-quiz-dom.js `_maybeSubmitQuiz`，
    // 秒数来自配置 `randomAnswerReviewSec`；用户 2026-11-12：交完就不能改了，这太诡异）。
    //   _quizReviewPaperKey   窗口是为**哪一份卷子**arm 的（键变了 = 换卷子，旧窗口作废）
    //   _quizReviewUntil      窗口到点时刻；到点那一次才真的点提交。
    //                         0 = 「这份卷子正停在等用户自己交」（设置填 0 时走这条）
    // 两个字段合起来就是「按卷子键只打一条日志」的去重位 —— 这条每秒被调到，
    // 只按时间节流仍会把日志刷满（用户 2026-11-12 抱怨过刷屏）。
    _quizReviewPaperKey: '',
    _quizReviewUntil: 0,

    // 上一次给「题干乱码」计轮的时刻。
    //
    // `_handleQuiz` 被 OCS 循环**每秒**调一次，所以乱码轮次绝不能按调用次数累加
    // —— 那样 3 秒就数满 3 轮。只有间隔够久（≥10 秒）才 +1，见 `_handleQuiz` 的乱码守卫。
    _quizGarbledRoundAt: 0,

    _quizApiSkipLogAt: 0,

    // 「这一节被答题链路挡住了」的三个时刻（判据见 `_isQuizBlockedByApi`，批次 13-B）。
    //   _quizBlockedByApiAt   最近一次「因链路不可用拒掉必做测验帧」——30 秒内不算新鲜
    //   _quizBlockedSinceAt   本轮阻塞的起点，用来算已按住多久（预算 3 分钟）
    //   两个日志节流位各自独立：按住与放弃是两条不同含义的日志，共用会互相顶掉。
    _quizBlockedByApiAt: 0,
    _quizBlockedSinceAt: 0,
    _quizBlockedHoldLogAt: 0,
    _quizBlockedGiveUpLogAt: 0,

    // 「这一轮没答题、原因是哪个」那条 warn 的节流时刻（判据见 `_handleQuiz` 开头的三道闸门）。
    // 与 `_quizHoldLogAt`（`_shouldHoldQuizBeforeNext` 用）**分开**：共用一个时间戳会让两条
    // 不同含义的日志互相顶掉，谁先打谁后打全看运气。
    _quizHoldReasonLogAt: 0,

    // 「这份卷子已经用本地答案答过多选了」的卷子键集合。
    //
    // 为什么需要它（现场实测 2026-10-10，多选本地作答刚上线就炸出来的）：
    //   多选的本地答案是**猜的** —— 一份卷子只要有一道多选，基本就过不了及格线；
    //   而平台"没过"之后的流程是 **重做 → 重答 → 重交**（上限 20 次）。
    //   于是线上表现从"填不满、卡着不动"变成了「只做多选题、其他的不做、**疯狂提交**」，
    //   而每一次提交都是**真的交上去**。
    //   判据放在这里而不是只用提交计数：提交计数在**同一轮内**还没 +1 时可以漏判。
    _quizLocalMultiplePapers: {},

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

    // 批次 20-H：后台暂停恢复这条日志原本一次 pause 就写一条，实测 200 格缓冲里占了 97 条，
    // 把讨论那半的证据全冲掉了。现在 60 秒最多一条，并带上被抑制掉的条数。
    _pauseResumeLogAt: 0,

    _pauseResumeSuppressed: 0,

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

    _discussionEditorEl: null,

    // 批次 20-F：刷课页读过讨论页递回来的 window.name 没有（每份文档只读一次）
    _discussionNameRead: false,

    _discussionPendingCache: null,

    _discussionHoldSinceAt: 0,

    _discussionHoldKey: '',

    _discussionHoldSpent: 0,

    _discussionDupLogAt: 0,

    _discussionSettledLogAt: 0,

    _unfinishedPromptClickedAt: 0,

    // 批次 21：投票任务点的尝试台账（键 = jobid）。**只在内存里** ——
    // 刷新页面就该重新观察一次，写进 localStorage 反而会把"这一轮没投出去"
    // 拖成"这一章永远不投"。
    _voteTryMap: {},

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
      // Authorized external captcha pages run only the OCR loop, never study scheduling.
      if (this.configs.pageScope === 'captcha') {
        this._clearTickLoop();
        var captchaApp = this;
        var captchaTick = function () {
          if (!captchaApp._assertActive() || captchaApp.configs.pageScope !== 'captcha') return;
          captchaApp._runStandaloneCaptchaMode().catch(function (error) {
            emitRuntimeLog('error', 'captcha loop failed', { error: String(error && error.message || error).slice(0, 200) });
          });
        };
        this._tickLoopInterval = setInterval(captchaTick, 1500);
        captchaTick();
        return;
      }
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
      // 只在启动时测一次帧率（700ms rAF），慢机据此放宽下面所有等待上限。
      // 测不出来时 perfFactor() 恒为 1，行为与改动前一致。
      startPerfProbe();
      console.log('%c[Omitone] start', 'color:#4CAF50;font-weight:bold');
      try { this._installSubmitSniffer(); } catch (eSniff) {}
      // ⚠️ 把**当前这份运行代码带哪些修复**写进日志。
      // 为什么必须有：这一整轮排查里最贵的开销就是"修复到底装上了没有"——
      // 实测两次被它坑：用户 reload 的时间点早于改动落盘、以及浏览器缓存了
      // 旧的 content.js/page.js，于是**日志里看不到效果**，两边都以为修好了。
      // 有了这行，一眼就能对照：日志里缺哪个标记 = 那份改动还没被加载。
      emitRuntimeLog('info', 'start', {
        build: ['truncate-split', 'sep-parse', 'quiz-pending', 'mismatch-discard', 'rich-fill',
          'chunk-5', 'quiz-no-progress-skip', 'multi-llm-first',
          // 2026-10-17 这一轮加的：缺哪个标记，就说明那份改动没被加载
          'text-skip-script', 'noop-guard', 'discussion-outcome', 'quiz-hold-guard',
          // 2026-11-10 批次 7 加的（缺哪个就说明那一半还没进浏览器）：
          // popup-scope=只在弹窗容器里点按钮 / radio-clickthrough=分离控件补点文本项 /
          // choice-visible=审计按"看得见的选中"计数 / idle-stuck-repeat=空转每 2 分钟重播
          // 2026-11-11 批次 20 加的：flag-3state=#isFinished 空值不再当"未完成" /
          // post-evidence=回帖确认要真证据 / page-dedup=同一话题本站只发一次 /
          // study-hold-discuss=还有讨论没做完时不许宣布整节完成
          // 20-F 加的：post-hydrate-wait=回帖先等页面水合、基线贴着点击取、
          // 点了没反应再点一次，结果用 window.name 递回刷课页
          // 20-G 加的：box-finished=#isFinished 是空的时改读任务盒的 ans-job-finished /
          // go-to-job=「还有任务点未完成」那道门点去学习、不再点下一节
          // 2026-11-11 批次 21 加的：vote-job=投票任务点（insertvote）认得出类型、
          // 走平台自己那一次点击真投出去（缺这个标记就说明新 page.js 没被加载）
          'popup-scope', 'radio-clickthrough', 'choice-visible', 'idle-stuck-repeat',
          'flag-3state', 'post-evidence', 'page-dedup', 'study-hold-discuss',
          'post-hydrate-wait', 'box-finished', 'go-to-job', 'vote-job'],
        // 代码内容指纹（由 `tools/concat-page.js` 按片段内容算出，拼在 page.js 第一行）。
        // 装 dist 的人看 `content bridge ready` 里的 build；**直接加载源码目录**的人看这个 ——
        // 它一变就说明代码换了，改完没重新加载一眼就能看出来。
        code: (typeof OMITONE_CODE_REV === 'string' ? OMITONE_CODE_REV : '')
      });
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
      this._quizHoldReasonLogAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      // 换章节/换卡片时连"在答哪一份卷子"的身份一起清掉：
      // 回到同一份卷子时视为全新一轮（与 `_quizAnswered = false` 配套，语义一致）
      this._quizRunPaperKey = '';
      this._quizApiSkipLogAt = 0;
      // 换节 / 换卡片 = 新的一节：按住阻塞的预算重新起算（判据见 `_isQuizBlockedByApi`）。
      // ⚠️ 这四个必须在同一个地方清 —— 少清 `_quizBlockedSinceAt` 的话，
      // 上一节按住满 3 分钟的记录会让下一节**一被挡住就直接翻页**。
      this._quizBlockedByApiAt = 0;
      this._quizBlockedSinceAt = 0;
      this._quizBlockedHoldLogAt = 0;
      this._quizBlockedGiveUpLogAt = 0;
      // 「本地答过多选」的卷子集合跟着卷子身份一起清：
      // 换章节 / 换卡片之后回到同一份卷子，应当重新享有"第一次尝试"的待遇。
      this._quizLocalMultiplePapers = {};
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
      this._lastSearchEmptyLogAt = 0;
      // 「这一节判成已完成」是**凭哪个证据**判的（`_isCurrentCompleted` 写入，
      // `_skipIfCompleted` 打进 `skip completed` 日志）—— 空串 = 没判成完成。
      this._completionEvidence = '';
      this._jobTransitionUntil = 0;
      this._studyCompleteAt = 0;
      // 「点了下一节但页面没动」的防空转计数（判据见 _studyProgressKey）
      this._nextUnitNoopCount = 0;
      this._nextUnitNoopKey = '';
      this._nextUnitBlockedKey = '';
      this._chapterChangedAt = Date.now();
      this._attachmentFingerprint = '';
      this._ocsStudyStarted = false;
      this._restudySkipNoticeAt = 0;
      // 「为讨论任务点按住这一节」的预算按**新一轮**起算（批次 20-D）：
      // 上一节烧掉的 90 秒不该让下一节一发现讨论就直接翻页。
      this._discussionHoldSinceAt = 0;
      this._discussionHoldKey = '';
      this._discussionHoldSpent = 0;
      this._discussionPendingCache = null;
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
      '.TiMu', '.Cy_TItle', '.questionLi', '.singleQuesId', '.questionItem', '.tiBank', '.topicItem',
      '.exam_question', '.question-content', '.singleQues', '.mark_item', '.questionBox',
      'li.quesLi', '.answerOption', 'div[class*="question"]', 'div[class*="topic"]',
      'div[class*="TiMu"]', 'div[class*="Cy_TItle"]'
    ],

    /**
     * 「这份文档有没有题目容器」的并集选择器 —— `_detectQuiz` 的 DOM 兜底、
     * 视觉闸门（_isTextOnly）、独立验证码页判定共用。
     *
     * ⚠️ 这份清单曾经手抄在 `_detectQuiz` 里，抄的时候漏了 `.Cy_TItle` ——
     * 作业/考试页的 DOM 兜底整体失效（与下面 `_quizContainerSelector` 注释里那次
     * 是同一类事故，且不报错、不留日志）。现在**只准改这里**；
     * `tools/check.js` 的「选择器真源守卫」会把真源之外的手抄直接报红。
     */
    _quizDetectorSelector: '.TiMu, .Cy_TItle, .questionLi, .singleQuesId, .questionItem, .tiBank, .topicItem, .exam_question, .question-content, .singleQues, .mark_item, .questionBox, .answerOption',

    /**
     * 题干候选选择器，按优先级逐个试；候选清洗后长度 ≥ 4 才算数（`_parseQuestionElement`）。
     * ⚠️ 属性选择器区分大小写，[class*="title"] 匹配不到 "Zy_TItle" / "Cy_TItle" —— 必须显式列出。
     */
    _questionTitleSelectors: [
      '.fontLabel', '.mark_name',
      // 学习通真实结构：题号在 .fontLabel，题干与题号同处 .Pt1 / .Zy_TItle。
      // .question-stem / [data-question-text] 是 mooc2 新版前端的题干标记
      // （2026-10-31 从同类开源实现的真实页面知识补入）。
      '.Pt1', '.Zy_TItle', '.question-stem', '[data-question-text]',
      '.question-title', '.topicTitle', '.question_content', '.qContent', '.mark_title',
      '.question-name', '.title', 'h3', 'h4', '.stem', '[class*="question"]', '[class*="title"]'
    ],

    /**
     * 选项 <li> 的候选容器，按优先级逐个试（`_getOptionItems`）。
     * 课程页 Zy_ 族在前、作业/考试页 Cy_ 族紧随 —— 顺序有含义：
     * ⚠️ `<li>` 必须排在 `<label>` 之前（qid 挂在 li 上；返回 label 会让
     * 隐藏答案域永远写不上 → 答案填了也永不提交，见 _getOptionItems 处的说明）。
     */
    _optionListSelectors: [
      '.Zy_ulTop > li', '.Zy_ulBottom > li', '.Zy_ulTk > li',
      '.Cy_ulTop li', '.Cy_ulBottom li', '.Cy_ulTk li',
      '[class*="before-after"]', '.answerBg',
      'li.clearfix'
    ],

    /**
     * "这一页有没有题目容器"用的**并集选择器**（一串，不是数组）。
     *
     * ⚠️ 它和上面的 `_questionSelectors` **不是一回事，别合并**：
     *   - `_questionSelectors` 是**有序的备选列表**，`_collectQuestionContainers` 逐个试、
     *     命中一个就用它（还带嵌套去重），目的是"尽量抠到题"；
     *   - 这一串是**一次性并集**，只回答"页面上有没有题目容器 / 有几个"，
     *     用于判分结果页的可交互性判断与诊断计数。
     *
     * ⚠️ **这个字符串曾经被手抄在三处**（`30-log.js` 的诊断、`70-quiz-flow.js` 的结果页判断、
     * `72-quiz-answers.js` 的正确答案收集），其中一处抄成了 `.Cy_TITle`（大小写错），
     * 于是那个诊断在作业/考试页上把容器数报成 0 —— 而且**不报错、不留日志**。
     * 现在三处统一读这里：**改选择器只改这一行** —— 手抄的那份必然漂移，别再抄第四份。
     */
    _quizContainerSelector: '.TiMu, .Cy_TItle, .questionLi, .singleQuesId, .questionItem, .mark_item, .questionBox',

    /**
     * 「题目容器里有没有能作答的控件」—— 判「这是不是答题页」的**必要条件**真源。
     *
     * 为什么必须有这一条：`_quizDetectorSelector` 那串类名里有 `.question-content`
     * `.answerOption` `.tiBank` `.topicItem` 这类**通用名字**，课件（轮盘 PPT）帧和
     * 文档帧里同样会出现。拿「选择器命中」当「这是测验任务」，一个带 `.question-content`
     * 的 PPT 帧就被判成 quiz，于是 `_runChaoxingReadJob` 永远轮不到 ——
     * 用户报的「刷 PPT 报废」正是这条（2026-11-10）。
     *
     * 真实题面必带下面之一：选项 `li[qid]`（填答案全靠它）、隐藏答案域 `#answer…`、
     * 填空/简答的 `textarea[id^="answer"]`、新版前端的 `[role="radio"/"checkbox"]`。
     * 课件里的装饰性 `.question-content` 一个都没有。
     *
     * ⚠️ 只准用在「判类型」这一处；不收窄 `_quizDetectorSelector` 本身
     *    （72-quiz-answers / 74-quiz-vision / 30-log 还靠它做 closest 与包装查找）。
     */
    _quizAnswerControlSelector: '[qid], input[id^="answer"], textarea[id^="answer"], [role="radio"], [role="checkbox"]',
