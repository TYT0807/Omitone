/* ==========================================================================
 * Omitone page.js 片段 10/15 —— 答题：整卷流程 / 状态 / 提交监控
 * 来源：原 page.js 中散布的 43 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 整卷主流程 _handleQuiz、抠出题目清单、识别是否在答题页
 * 提交前后：提交嗅探、提交监控、要不要在进入下一节前 hold 住
 * 按提交次数跳过、API 不可用时的退避与跳过、乱选模式
 * 这份卷子属于哪个场景（测试 / 考试）＋该场景的思考档下限（「不乱猜」闸的判据）
 * 重做（redo）弹窗的处理
 *
 * 本段的方法（73 个）：
 *   _isQuizResultCompletedPage、_shouldReleaseMediaPendingForCurrentCompletion、
 *   _isQuizResultPageFinished、_documentHasQuiz、_detectQuiz、_skipQuiz、_getQuizFieldValue、
 *   _getQuizWorkKey、_getQuizDocumentIdentity、_syncQuizPaperRunState、_getQuizPaperKeyFromJob、
 *   _getQuizPaperKeyFromTask、_isQuizPaperChangedInDom、_getQuizSubmitAttemptKey、
 *   _getQuizAccountDocument、_shouldHoldQuizBeforeFinish、_getQuizMaxSubmitAttempts、
 *   _getQuizApiUnavailableReason、_isRandomAnswerMode、_buildRandomQuizAnswers、
 *   _isQuizApiUnavailable、_isQuizBlockedByApi、_noteQuizBlockedByApi、_resetQuizStateForSkip、_markQuizApiConnectionFailed、
 *   _setQuizApiFailUntil、_restoreQuizApiFailUntil、
 *   _quizApiWhoForLog、
 *   _skipQuizForApiUnavailable、_getQuizSubmitAttemptCount、
 *   _setQuizSubmitAttemptCount、_clearQuizSubmitAttemptCount、
 *   _incrementQuizSubmitAttemptCount、_shouldSkipQuizBySubmitAttempts、
 *   _isQuizForceSkipping、_isQuizSkipWindowLive、_setQuizForceSkip、_forceSkipQuizAfterMaxAttempts、
 *   _getQuizQuestionRuntimeKey、_markQuizQuestionAnsweredThisRun、
 *   _wasQuizQuestionAnsweredThisRun、_unmarkQuizQuestionAnsweredThisRun、
 *   _isQuizPassedOrFinished、_hasActiveQuizSubmitForm、_markQuizSubmitPending、
 *   _isQuizAnswersCleared、_installSubmitSniffer、_monitorQuizSubmit、
 *   _noteQuizSubmitStall、_getQuizGiveUpJobId、_isQuizGivenUpInDom、_giveUpQuizSubmitAfterStalls、
 *   _setQuizSubmitOutcome、_quizSubmitRejectedBlocksRetry、_shouldHoldQuizBeforeNext、_isQuizLearningPending、_describePendingQuizQuestions、
 *   _handleQuiz、
 *   _extractQuestions、_getQuizDocumentFromQuestions、_getQuizDocumentsFromQuestions、
 *   _looksLikeQuizTitle、_paperTierFromTitle、_examThinkingMin、_isNoGuessPaper、_noteNoGuessPaperHold、
 *   _extractFromDocument、_findVisibleQuizRedoDialog、_isQuizRedoRequired、
 *   _prepareQuizRedoIfNeeded、
 *   _probeFontDecrypt、_hasFontDecryptMiss、_quizTextGarbledRatio
 * ========================================================================== */
// @omitone-part-header-end

    _isQuizResultCompletedPage: function () {
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      try {
        var text = doc.body ? textOf(doc.body) : '';
        if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text)) return false;
        if (doc.querySelector('.testTit_status_complete')) return true;
        if (/任务点已完成|已完成|已通过|恭喜/.test(text) &&
          doc.querySelector(this._quizContainerSelector + ', .answerCon, .answerScore')) {
          return true;
        }
      } catch (e) {}
      return false;
    },

    /**
     * 「这一节该不该为『任务框都显示已完成』而放手」—— 唯一调用方是 `_isActiveMediaPending`，
     * 它必须把**自己即将用来决定"还占不占着"的那枚元素**一起传进来（批次 51）。
     * ⚠️ 不许改回读 `this._videoEl` 缓存：那个缓存会被 `_getVideoEl()` 一拍一填、
     *    被 `_clearMediaPendingState()` 一拍一清，两个调用方因此逐拍各执一词。
     * `media` 为空 = 这一页压根没有媒体元素，此时"框都做完了"才算数。
     */
    _shouldReleaseMediaPendingForCurrentCompletion: function (reason, media) {
      // ⚠️ 批次 55-C：这一句原先**只查自报布尔**，而"放行"这件事自己就会把那两只布尔清零
      //   （调用方拿到 true 后立刻 `_clearMediaPendingState()`）。于是自报全假的那一拍
      //   这一句先拒绝放行 → 调用方只好走"还在等"那支，把 `_activeMediaJobPending`
      //   重新武装起来（那一支还会打一条 `media pending`，因为放行时日志时钟一起被清零）
      //   → 下一拍又满足放行 → 再清一次。两句话逐拍各执一词，**结构上不可能自己停下**。
      //   现场实测（2026-11-14，用户挂着刷课，CDP 9334，`.workbuddy/field-ring57-before.txt`）：
      //   `advance at 90% (locked 1x + not seekable)` 之后 `media pending` 与
      //   `clear media pending` **每 500 毫秒成对出现**（15 条 clear 挤在 7 秒里），
      //   两族合占 200 条环的 **41%** —— 证据窗只剩约 100 秒，而且
      //   `_mediaBrokenSince` / `_mediaNoSourceSince` 每次刚攒起来就被清零，
      //   批次 40 / 50 那两道有界放手在这一格里一秒都攒不起来。
      //   「元素自己还在播」与「武装过一笔媒体任务」是同一种"有媒体信号"，必须一起算进来 ——
      //   否则这一句就把自己刚清掉的状态当成了"没有媒体可管"的依据。
      var stillPlaying = !!(media && media.isConnected && !media.paused && !media.ended);
      if (!this._activeMediaJobPending && !this._isPlaying && !stillPlaying) return false;
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
        // 选择器读真源 `_quizContainerSelector`，别手抄（手抄的那份必然漂移）
        var containers = doc.querySelectorAll(this._quizContainerSelector);
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

    /**
     * 「这份文档到底是不是答题页」—— 任务类型仲裁的**唯一**判据（2026-11-10）。
     *
     * 为什么不能再拿 `_quizDetectorSelector` 命中当「这是测验任务」：那串并集里
     * 有 `.question-content`、`.answerOption`、`.tiBank`、`.topicItem` 这类**通用名字**，
     * 课件（轮盘 PPT）帧和文档帧里同样会出现。一个挂着 `.question-content` 的 PPT 帧
     * 因此被判成 quiz，`_runChaoxingReadJob` 再也轮不到 —— 用户看到的「刷 PPT 功能报废」
     * 正是这一条；同一份误判还让 `_isQuizLearningPending` 恒为真、
     * 把 `_tryAdvanceIdleSection` 的逃生门也锁死（两条腿一起接近瘫痪）。
     *
     * 判据换成「真的抠得出题，而且题里有能填的控件」，两条同时成立：
     *   1) `_collectQuestionContainers(doc)` 非空 —— 走有序真源 `_questionSelectors`，
     *      带可见性/文本过滤与嵌套去重，比一次性并集严格得多；
     *   2) 容器内存在答题控件（真源 `_quizAnswerControlSelector`）——
     *      课件里那些装饰性的 `.question-content` 一个都没有。
     *
     * ⚠️ 整文档的控件预筛必须放在收集容器**之前**，这是性能闸不是省事：
     *    OCS 调度每秒对每个帧调一次本方法，而 `_collectQuestionContainers` 要跑
     *    十几条选择器 + 逐个可见性判断。一道控件都答不了的页面必然不是答题页，
     *    先用一次 `querySelector` 挡掉，非答题页的开销与改前持平。
     */
    _documentHasQuiz: function (doc) {
      if (!doc || !doc.querySelectorAll) return false;
      var controlSelector = this._quizAnswerControlSelector;
      try {
        if (!doc.querySelector(controlSelector)) return false;
      } catch (ePre) {
        return false;
      }

      var containers = [];
      try {
        containers = this._collectQuestionContainers(doc);
      } catch (eCol) {
        return false;
      }
      for (var i = 0; i < containers.length; i++) {
        try {
          if (containers[i] && containers[i].querySelector(controlSelector)) return true;
        } catch (eCtl) {}
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
      var tasks = this._collectVisibleTaskFrames();
      if (tasks.some(function (task) { return task.type === 'quiz' && !task.finished; })) return true;

      // DOM 兜底的判据与任务类型仲裁**同一个**：「题目容器里真的有能作答的控件」。
      // 原来这里整页扫 `_quizDetectorSelector` 的通用类名，于是挂着一个
      // `.question-content` 的课件页/文档页也返回 true —— 那就是「接近瘫痪」的第二条腿：
      // `_isQuizLearningPending` 恒为真 → `_tryAdvanceIdleSection` 的逃生门被冻住，
      // 而 `_handleQuiz` 又抠不出题，什么都不做（2026-11-10）。
      // ⚠️ 容器清单读真源 `_quizContainerSelector`（这份清单曾被手抄在此且漏了 .Cy_TItle，
      //    作业/考试页的 DOM 兜底整体失效 —— 真源处有完整教训记录，别再抄回来），
      //    也不要换成 `_questionSelectors` 那份有序备选：两处用途不同，见 10-config-state.js 各自的注释。
      var containerSelector = this._quizContainerSelector;
      var controlSelector = this._quizAnswerControlSelector;
      return this._walkDocuments(function (doc2) {
        try {
          // 便宜的整页预筛：本方法在每轮 tick 里都会跑，绝不能每次都去遍历全部容器
          if (!doc2.querySelector(controlSelector)) return false;
          var nodes = Array.from(doc2.querySelectorAll(containerSelector));
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j]) || textOf(nodes[j]).length === 0) continue;
            if (nodes[j].querySelector(controlSelector)) return true;
          }
        } catch (eWalk) {}
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
      // 五个 id 字段全空时，键必须**至少细到「一帧一份卷子」**，否则同一张卡片里的
      // 两份卷子会被记成同一份：坏掉那一份的 90 秒暂停会连累另一份，两份卷子的
      // 提交次数与答案缓存也会互相顶掉（2026-11-10 批次 3）。
      if (!parts.replace(/\|/g, '')) parts = this._getQuizDocumentIdentity(doc);
      return 'omitone.quiz.correct.' + encodeURIComponent(parts).slice(0, 180);
    },

    /**
     * `_getQuizWorkKey` 在「五个 id 字段全空」时的兜底身份。
     *
     * 为什么不能再只写 `location.href`：顶层地址对同一张卡片里的两份卷子**是同一个值**，
     * 于是批次 1 拆掉的「按页冷却」在兜底分支里悄悄又回来了 —— 一份坏卷子照样能
     * 冻住它的邻居，而且这条路径只在认不出 id 的页面上走，日常测试碰不到。
     *
     * 分两级把它拆开：① **这份文档自己的 URL**（每个 iframe 各不相同）；
     * ② 宿主帧的身份（`jobid` / `id` / `name` / `data`）。`about:blank` / `about:srcdoc`
     * 这类帧的 URL 全都一样，分不开任何东西，所以那种 URL 直接当「没有信号」处理。
     *
     * ⚠️ 这个键同时被提交次数、答案缓存、`_quizReadyWorkKey` 复用，所以**稳定压倒一切**：
     *   同一个文档两次算出不同的键，等于冷却形同不存在、交卷上限每轮被重置
     *   （比按页合并更烧用户的提交次数）。因此帧在这一页里的序号只当**最后一层**兜底 ——
     *   页面重排时它会变，能不用就不用。
     */
    _getQuizDocumentIdentity: function (doc) {
      var url = '';
      try { url = String((doc && (doc.URL || (doc.location && doc.location.href))) || ''); } catch (eUrl) {}
      if (/^about:(?:blank|srcdoc)$/i.test(url)) url = '';
      var frame = null;
      try { frame = doc && doc.defaultView ? doc.defaultView.frameElement : null; } catch (eFrame) {}
      var frameId = '';
      if (frame) {
        try {
          frameId = String(frame.getAttribute('jobid') || frame.getAttribute('id') ||
            frame.getAttribute('name') || frame.getAttribute('data') || '');
        } catch (eAttr) {}
        if (!url && !frameId) {
          try {
            var host = frame.ownerDocument || document;
            frameId = 'idx' + Array.prototype.indexOf.call(host.querySelectorAll('iframe'), frame);
          } catch (eIdx) {}
        }
      }
      var bits = [url, frameId];
      if (!bits[0] && !bits[1]) bits[0] = String(location.href || '');
      bits.push(this._getCurrentChapterId());
      return bits.join('|');
    },

    /**
     * 「当前在答的是哪一份卷子」——**换了一份就把那一组答题状态重置掉**。
     *
     * 为什么必须有（现场故障）：同一张学习卡片里可以挂**两份**测验任务点
     * （实测：一张卡片里两个单元测试，URL 分别是
     * `/mooc-ans/work/doHomeWorkNew?...&oldWorkId=…`）。
     * 而 `_quizAnswered` / `_quizCurrentQuestions` 这一组是**页面级**的，
     * 只在 `_resetRuntimeState()` 里清，调用点只有
     * `run()` / 换章节 / `nextUnit()` / 换学习卡片 ——
     * **同一张卡片里从一份卷子切到另一份，一次都不经过**。
     * 于是交完第一份后 `_quizAnswered` 恒为 true，
     * `_handleQuiz` 第一行（`if (this._quizAnswered || this._quizInProgress) return;`）
     * 直接返回 —— 第二份**永远不答**。
     *
     * ⚠️ 三道保险，缺一不可：
     *   ① **拿不到身份键（空串）就什么都不做** —— 宁可沿用旧状态，
     *      也不要因为认不出身份而把已答状态清掉、去重答一遍
     *   ② **键没变就什么都不做** —— 同一份卷子的重试/重做必须保留状态，
     *      否则会绕过 `_quizReadyToSubmit` 等判定，造成重复提交
     *   ③ **换过去那份本来就已完成时，重新置回"已答"** —— 不然后续路径
     *      会把一份交过的卷子当新卷子处理
     *
     * @param {string} paperKey 任务点身份（jobid / workid 一类），由调用方给出
     * @param {Document} [paperDoc] 即将处理的那份卷子的文档，用于保险 ③
     * @returns {boolean} 是否真的发生了"换卷子"
     */
    _syncQuizPaperRunState: function (paperKey, paperDoc) {
      var key = String(paperKey || '').trim();
      if (!key) return false;                 // ① 认不出身份 → 不动
      if (this._quizRunPaperKey === key) return false;   // ② 还是同一份 → 不动
      var switched = !!this._quizRunPaperKey;
      this._quizRunPaperKey = key;
      if (!switched) return false;            // 第一次记录身份，谈不上"切换"

      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      // 换卷子 = 上一份的检查窗口作废（留着会让新卷子直接跳过窗口、填完就交）
      this._quizReviewPaperKey = '';
      this._quizReviewUntil = 0;
      emitRuntimeLog('info', 'quiz paper switched, reset per-paper state', { paper: key.slice(0, 90) });

      // ③ 换过去那份已经完成时，别把它当"没答过"
      if (paperDoc && this._isQuizPassedOrFinished(paperDoc)) {
        this._quizAnswered = true;
      }
      return true;
    },

    /**
     * 从任务点对象里推出"这是哪一份卷子"的身份键。
     *
     * 取值的优先顺序是**稳定 → 不稳定**：jobid（任务点自己的 id）→ attachment 的
     * jobid / mid → 名字兜底。拿不到就返回空串，`_syncQuizPaperRunState` 收到空串
     * 会**什么都不做**（宁可沿用旧状态，也不要因为认不出身份而重答一遍）。
     */
    _getQuizPaperKeyFromJob: function (job) {
      if (!job) return '';
      var attachment = job.attachment || null;
      var property = (attachment && attachment.property) || null;
      var candidates = [
        job.jobid,
        attachment && attachment.jobid,
        property && property._jobid,
        property && property.jobid,
        property && property.mid,
        job.mid,
        job.name
      ];
      for (var i = 0; i < candidates.length; i++) {
        var value = String(candidates[i] == null ? '' : candidates[i]).trim();
        if (value) return value;
      }
      return '';
    },

    /**
     * 从 `_classifyTaskFrame` 出来的任务点对象里推出卷子身份键。
     *
     * ⚠️ **不能用 `task.src` 当身份**：真实页面上两个任务点的外层帧 src
     * **完全相同**（都是 `/ananas/modules/work/index.html?v=…&castscreen=0`），
     * 身份只写在 `data` 属性里。用 src 会让两份卷子看起来是同一份，
     * 于是"换卷子重置"永远不触发 —— bug 原样复发。
     * 取不到就返回空串（调用方会什么都不做）。
     */
    _getQuizPaperKeyFromTask: function (task) {
      if (!task) return '';
      var data = null;
      try { data = this._safeJsonParse(task.dataText || '', null); } catch (e) { data = null; }
      var candidates = [
        data && data._jobid,
        data && data.jobid,
        data && data.workid,
        data && data.workId
      ];
      for (var i = 0; i < candidates.length; i++) {
        var value = String(candidates[i] == null ? '' : candidates[i]).trim();
        if (value) return value;
      }
      try {
        if (task.frame && task.frame.getAttribute) {
          var attr = String(task.frame.getAttribute('jobid') || task.frame.getAttribute('_jobid') || '').trim();
          if (attr) return attr;
        }
      } catch (e2) {}
      return '';
    },

    /**
     * 「页面上现在的题目」和「我们记着已经答过的那一份」是不是**两份不同的卷子**。
     *
     * 为什么需要它：换卷子本来由 `_syncQuizPaperRunState()` 负责，但它要的是
     * **任务点身份**（jobid / attachment.jobid / mid / name）。真实页面里同一份文档
     * 接着显示第二份卷子时，这几个 id 常常一个都拿不到（或两份给的是同一个），
     * 于是 `_quizAnswered` 一直是 true、`_handleQuiz` 第一行静默 return，
     * 第二份**永远不答**（2026-11-10 用户报的「第一次遇到题目过了，第二次不答题」）。
     *
     * 判据刻意做得很窄，只在**完全对不上**时才认换卷：
     *   - 两边都取得到题目身份（qid）才比；任何一边取不到 → false（认不出就当没换）
     *   - 有**任何一道**重叠 → false —— 同一份卷子的补填/重做必须保留状态，
     *     否则会把一份已交过的卷子当新卷子再交一次（那正是「疯狂提交」的形状）
     *   - 只有「出现若干道完全没见过的题，且旧题一道都不在」→ true
     *
     * @param {Document} doc 现在页面上这份卷子的文档
     * @returns {boolean} true = 页面上已经是另一份卷子的题目
     */
    _isQuizPaperChangedInDom: function (doc) {
      try {
        var remembered = this._quizCurrentQuestions;
        if (!doc || !remembered || !remembered.length) return false;
        var oldIds = {};
        var oldCount = 0;
        for (var i = 0; i < remembered.length; i++) {
          var q = remembered[i];
          var oldId = q && q._element ? String(this._getQuestionIdFromElement(q._element) || '').trim() : '';
          if (!oldId) continue;
          oldIds[oldId] = 1;
          oldCount++;
        }
        if (!oldCount) return false;

        var nodes = this._collectQuestionContainers(doc);
        var fresh = 0;
        var overlap = 0;
        var seenFresh = {};
        for (var j = 0; j < nodes.length; j++) {
          var newId = String(this._getQuestionIdFromElement(nodes[j]) || '').trim();
          if (!newId) continue;
          if (oldIds[newId]) { overlap++; break; }
          if (!seenFresh[newId]) { seenFresh[newId] = 1; fresh++; }
        }
        if (overlap) return false;
        return fresh > 0;
      } catch (e) {
        return false;
      }
    },

    /**
     * 「这份卷子的**提交账**记在哪个文档上」—— 只有一处答案（2026-11-10 批次 8）。
     *
     * 表达式与 ready 那一路**同形**（`preferredDoc || 题目所在文档`）：
     * 写账端与读账端错开时，症状不是报错，而是**上限永远读不到次数** ——
     * 「一次没过就再交一次、一直交」的疯狂提交就是这么来的
     * （`_handleSubmitConfirmDialog` 原先传 `null`，`null → 主文档` 那本粗账被写，
     * ready 键与 `_shouldSkipQuizBySubmitAttempts` 读的是**题目文档**那本细账）。
     *
     * ⚠️ 只管提交账：答案缓存与按卷冷却仍按调用点自己那份文档算键，
     * 动 `_resolveQuizAnswerDocument` 的 `null` 兜底会把十几条读路径一起卷进来。
     */
    _getQuizAccountDocument: function (preferredDoc) {
      return preferredDoc || this._getQuizDocumentFromQuestions(this._quizCurrentQuestions) || null;
    },

    _getQuizSubmitAttemptKey: function (preferredDoc) {
      return this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)) + '.submitAttempts';
    },

    /**
     * 这一份卷子允许多少次交卷。
     *
     * 默认取配置的 `quizMaxSubmitAttempts`（20）—— 卷子没过时重答重交，是既有设计。
     *
     * ⚠️ 但**本地兜底过多选的卷子只给 2 次**（首发 + 一次认真重做）。
     * 为什么：那一轮的多选答案是猜的，一份卷子只要有一道多选基本就过不了；
     * 若照旧允许 20 次，就会变成"交一次→没过→再交一次…"的**疯狂提交**，
     * 而每一次提交都是**真的交上去**（平台可能记次数，用户明确报过这个症状）。
     * 给一次重做的机会足够：批次 7 之后多选**默认就交给模型**，
     * 只有"模型那一份填不进 DOM、靠本地猜测补上的卷子"才会被记进 `_quizLocalMultiplePapers`
     * 并收到 2 次（见 `_answerLocalMultiChoiceQuestions` 的 refill 那一趟）。
     * 真能过就在这一次过；过不了就是这张卷子过不了，继续交只是拿用户的提交次数去赌。
     */
    _getQuizMaxSubmitAttempts: function (preferredDoc) {
      var max = Number(this.configs.quizMaxSubmitAttempts || 20);
      if (!(max > 0)) max = 20;
      var key = this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)) || this._quizRunPaperKey || '';
      if (key && (this._quizLocalMultiplePapers || {})[key]) return Math.min(max, 2);
      return max;
    },

    _getQuizApiUnavailableReason: function () {
      // 这条不是「API 不可用」，是「用户自己把答题关了」—— 两者后面走的路完全不同
      // （前者要按住等恢复，后者直接翻页），所以理由必须分开命名（批次 13-B）。
      if (!this.configs.enableQuiz) return 'quiz-toggle-off';
      // ⚠️ 乱选模式**不需要** API key，也不受连接失败影响 —— 答案在本地生成。
      // 少了这一句，乱选会走 _skipQuizForApiUnavailable 把整道题跳过，
      // 变成「什么都不答」而不是「乱选」。
      if (this._isRandomAnswerMode()) return '';
      if (!this.configs.hasApiKey) return 'api-key-missing';
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

    /**
     * 「这一节压着一张**因为链路不可用而做不了**的卷子」—— 批次 13-B 的核心判据。
     *
     * 为什么不能直接拿 `_isQuizApiUnavailable()` 当答案：那条判据里还混着
     * 「用户自己关掉答题」（`quiz-toggle-off`），那种情况翻页是对的（他就不想做题）；
     * 而 key 没填 / 网络退避 时翻页 = 把必做题扔掉。以前 `_isQuizLearningPending`
     * 对两者一视同仁返回 false，上层于是宣布「这一节已完成」并翻节 ——
     * 这正是用户那句「还没做就判已完成、无语了」。
     *
     * 三个条件缺一不可：
     *   1. 原因是**可恢复**的那两类；
     *   2. 本轮确实因为该原因拒过测验任务点（`_noteQuizBlockedByApi` 的标记还新）——
     *      没有这条证据就不许凭空按住整节；
     *   3. 按住的时间还没超过预算 —— 超了就退回「跳过并大声记日志」，
     *      否则一个永远不填 key 的用户会把整轮刷课冻在这一节上。
     */
    _isQuizBlockedByApi: function () {
      var reason = this._getQuizApiUnavailableReason();
      if (!reason || reason === 'quiz-toggle-off') return false;
      var now = Date.now();
      if (!this._quizBlockedByApiAt || now - this._quizBlockedByApiAt > 30000) return false;
      return now - (this._quizBlockedSinceAt || now) < 180000;
    },

    /** 记下「因为链路不可用而拒掉了一个测验任务点」—— 上面那条判据的唯一证据来源。 */
    _noteQuizBlockedByApi: function (reason) {
      if (!reason || reason === 'quiz-toggle-off') return;
      var now = Date.now();
      // 上一轮阻塞已经断了（超过 60 秒没再拒过），当成**新的一次**重新起算，
      // 否则「填过 key 又掉线」会继承第一次的时长、直接跳过而不按住。
      if (!this._quizBlockedSinceAt || now - (this._quizBlockedByApiAt || 0) > 60000) {
        this._quizBlockedSinceAt = now;
      }
      this._quizBlockedByApiAt = now;
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
      this._quizReviewPaperKey = '';
      this._quizReviewUntil = 0;
      // 换任务了，上一道弹题的失败记录不该带过来
      this._popupQuizKey = '';
      this._popupQuizAttempts = 0;
      this._popupQuizBlockedUntil = 0;
      // 换卷了，前缀缓存的"刚发过整批"记录也失效
      this._quizBatchSentKey = '';
      this._quizBatchSentAt = 0;
    },

    // #229 · 45 秒退避的**唯一写入口**：先设内存字段（判据 `_isQuizApiUnavailable` 读的就是它），
    // 再把同一个**绝对时刻**落进 sessionStorage —— 那是「同一标签页、活过 F5、关标签即清」的粒度；
    // `chrome.storage.local` 是用户的存档，一次事务性退避不许写脏（AGENTS §2 #25 同一口径）。
    // 键只在这一处定义、读写共用它：两侧各写一份字面量 = 「存进去 A、回来找 B」，
    // 表现为"退避永远活不过刷新"而一条日志都不打（§2 #18 同一族）。
    _QUIZ_API_FAIL_KEY: 'omitone:quiz-api-fail-until',

    _setQuizApiFailUntil: function (until) {
      var stamp = Number(until);
      if (!isFinite(stamp)) return;
      // `<= 0` 是**显式清账**而不是"传错了"：调用方说"现在没有退避"，内存与 sessionStorage 要一起清。
      // 只清内存的话，下一个文档的 `_restoreQuizApiFailUntil` 会把旧窗口原样捡回来 ——
      // 表现与"根本没修"逐字相同（e2e 那批 `app._quizApiFailUntil=0` 的场景卫生就吃这一格）。
      if (stamp <= 0) {
        this._quizApiFailUntil = 0;
        try {
          if (typeof sessionStorage !== 'undefined' && sessionStorage) sessionStorage.removeItem(this._QUIZ_API_FAIL_KEY);
        } catch (eClear) {}
        return;
      }
      // 取大不取新：两个入口（连接失败 / 弹窗里勾了「API 连接失败」）各说 45 秒，
      // 覆盖成后到的那份会把先到的窗口**缩短**，而存储里必须落**同一个数** ——
      // 落 `stamp` 而不是 `next`，刷新后就把还在生效的长窗口顶成短的。
      var next = Math.max(Number(this._quizApiFailUntil) || 0, stamp);
      this._quizApiFailUntil = next;
      // ⚠️ 存不住**不改变行为**：字段已经在内存里，这一轮照样退避，只是跨不了刷新。
      // 这里不像 20-dom.js 那对底座要保护"安全阀在最需要它的浏览器上失效"——
      // 退避本来就只挡 45 秒，降级成"只挡本次加载"是可接受的，所以不再另发一句 warn。
      try {
        if (typeof sessionStorage !== 'undefined' && sessionStorage) {
          sessionStorage.setItem(this._QUIZ_API_FAIL_KEY, String(next));
        }
      } catch (eStore) {}
    },

    /**
     * 刷新后把还没到点的退避捡回来。四格各占一格，谁都不许塌进谁（§2 #12）：
     * **未来值** → `Math.max` 合并（**只许延长已有窗口、不许由它凭空造一个窗口** ——
     * 覆盖成"存值"会把这一轮刚设的更长窗口顶短，覆盖成"now+45s"更是把恢复变成续期）；
     * **过期值** → 删键（留着只会让下一次读它的人多算一格）；
     * **读不出**（存储抛异常 / 值不是数）→ 什么都不做，**尤其不许删键**：
     * 把"读不出"实现成"清账"等于替用户宣布"刚才没失败过"；
     * **压根没有** → 不动内存字段（首次运行与"没退避过"同形，那是真话）。
     */
    _restoreQuizApiFailUntil: function () {
      var stored;
      try {
        if (typeof sessionStorage === 'undefined' || !sessionStorage) return;
        stored = sessionStorage.getItem(this._QUIZ_API_FAIL_KEY);
      } catch (eRead) { return; }
      if (stored === null || stored === undefined || stored === '') return;
      var stamp = Number(stored);
      if (!isFinite(stamp) || stamp <= 0) return;
      if (stamp <= Date.now()) {
        try { sessionStorage.removeItem(this._QUIZ_API_FAIL_KEY); } catch (eDel) {}
        return;
      }
      this._quizApiFailUntil = Math.max(Number(this._quizApiFailUntil) || 0, stamp);
    },

    _markQuizApiConnectionFailed: function (error, who) {
      var message = error && error.message ? error.message : String(error || 'LLM 请求失败');
      // 不再永久写入 storage：改为 45 秒退避，期间跳过答题，之后自动重试并自愈
      this._setQuizApiFailUntil(Date.now() + 45000);
      this._quizApiLastError = String(message).slice(0, 300);
      // 「哪家哪个模型」由扩展侧算好随回包带过来（页面那份配置投影里没有渠道字段）。
      // ⚠️ 拿不到时单独占一格，不许压成空串 —— 空串在日志里读起来像"没有渠道这回事"。
      this._quizApiLastWho = String(who || '(这一发没带渠道：请求没走到服务商，或异常在半路抛出)').slice(0, 200);
      emitRuntimeLog('warn', 'api connection failed, skip quiz', { error: message.slice(0, 200), retryInMs: 45000, who: this._quizApiLastWho });
    },

    /**
     * 读出「失败的是哪家哪个模型」，两处跳过日志共用这一把尺（写入口与读出口同形）。
     * 还没问过模型就没这一格 —— 单独说清楚，不许留空串（空串读起来像"渠道是空的"，
     * 而真相是"这一轮压根没发出请求"，两者修复方向完全相反）。
     */
    _quizApiWhoForLog: function () {
      return String(this._quizApiLastWho || '(这一轮还没问过模型，渠道没读过)').slice(0, 200);
    },

    _skipQuizForApiUnavailable: function (reason, preferredDoc) {
      var skipReason = reason || this._getQuizApiUnavailableReason() || 'api-unavailable';
      // ⚠️「答不了」不等于「没题做」（批次 13-B）。被可恢复的原因挡住、且这一轮确实
      // 因此拒过测验任务点时，这里**不许翻页**：翻过去就等于把必做题宣布成已完成。
      // 返回 false 让调用方回落到它自己的 hold 分支；超过按住预算后自动放行，
      // 所以一个永远不填 key 的用户也不会被冻在这一节。
      if (this._isQuizBlockedByApi()) {
        var heldMs = Date.now() - (this._quizBlockedSinceAt || Date.now());
        if (!this._quizBlockedHoldLogAt || Date.now() - this._quizBlockedHoldLogAt > 10000) {
          this._quizBlockedHoldLogAt = Date.now();
          emitRuntimeLog('warn', 'quiz blocked by api, holding unit', {
            reason: skipReason,
            heldMs: heldMs,
            who: this._quizApiWhoForLog(),
            hint: '这一节压着没做的题，但答题链路现在用不了 —— 已**停在本节不翻页**（不是已完成）。' +
              '填好 API Key 或等网络恢复就会自动继续；按住超过 3 分钟才会跳过这一节'
          });
        }
        return false;
      }
      // 按住预算用完（3 分钟）仍未恢复 → 放行跳过，但要把「这些题并没做过」说清楚。
      // ⚠️ 这里**不改** `_quizBlockedSinceAt`：清零会让 `_isQuizBlockedByApi()` 下一秒
      // 又算成新的一次阻塞、重新按住，于是永远翻不了页（自锁）。它由
      // `_resetRuntimeState()`（换节）与 `_noteQuizBlockedByApi()`（间隔 60 秒以上
      // 视为新事故）负责起算，所以每一节都拿到自己那份预算。
      var blockedSince = this._quizBlockedSinceAt || 0;
      if (blockedSince && skipReason !== 'quiz-toggle-off' && Date.now() - blockedSince >= 180000 &&
          (!this._quizBlockedGiveUpLogAt || Date.now() - this._quizBlockedGiveUpLogAt > 10000)) {
        this._quizBlockedGiveUpLogAt = Date.now();
        emitRuntimeLog('warn', 'quiz blocked too long, giving up unit', {
          reason: skipReason,
          heldMs: Date.now() - blockedSince,
          who: this._quizApiWhoForLog(),
          hint: '按住整节超过 3 分钟仍未恢复，改判跳过 —— 这些题**没做过**，配好链路后请开重学把这节补回来'
        });
      }
      this._setQuizForceSkip(15000);
      this._resetQuizStateForSkip();
      var now = Date.now();
      if (!this._quizApiSkipLogAt || now - this._quizApiSkipLogAt > 3000) {
        this._quizApiSkipLogAt = now;
        emitRuntimeLog('warn', 'skip quiz because api unavailable', {
          reason: skipReason,
          error: String(this._quizApiLastError || '').slice(0, 160),
          who: this._quizApiWhoForLog()
        });
      }
      if (this._switchToNextLearningCard(skipReason)) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          this._setQuizForceSkip(15000);
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
      emitRuntimeLog('info', 'quiz submit attempt count', { count: count, max: this._getQuizMaxSubmitAttempts(preferredDoc) });
      return count;
    },

    _shouldSkipQuizBySubmitAttempts: function (preferredDoc) {
      // 本地调试档（`quizRejectGiveUp=false`）：交卷次数到顶也不放手，继续重答重交。
      if (this.configs && this.configs.quizRejectGiveUp === false) return false;
      return this._getQuizSubmitAttemptCount(preferredDoc) >= this._getQuizMaxSubmitAttempts(preferredDoc);
    },

    /**
     * 写入「暂停这一卷」的冷却。**时间戳与卷子身份键必须成对写**，
     * 所以所有写入点一律走这里，不许再直接赋 `_quizForceSkipUntil`。
     *
     * @param {number} durationMs 冷却时长
     * @param {string} [paperKey] 卷子身份键；**不传 = 全局冷却**（老语义）——
     *   用于「Key/接口不可用」「真的交过卷之后」这类与具体卷子无关的场景。
     */
    _setQuizForceSkip: function (durationMs, paperKey) {
      this._quizForceSkipUntil = Date.now() + durationMs;
      this._quizForceSkipPaperKey = paperKey ? String(paperKey) : '';
      return this._quizForceSkipUntil;
    },

    /**
     * 「现在是不是在暂停这一卷」。
     *
     * ⚠️ **调用点必须把当前文档传进来**（`_handleQuiz` / `_isQuizLearningPending`）。
     * 卷子键是**按文档算**的：`_getQuizWorkKey(doc)` 里先 `_resolveQuizSubmitDocument(doc)`，
     * 传题目所在的内层 `#frame_content` 与不传（退到主文档 / document）
     * 读到的 `workRelationId` 可能不是同一个 —— 于是写入端记 A 键、判定端问 B 键，
     * 「暂停 90 秒」永远对不上：R1 已关掉跳过出口、R2 已删掉 `_skipQuiz()`，
     * 结果不是「没暂停」而是**该节点永久停摆**，日志却写着已暂停（错地图比没地图更糟）。
     * 判定端与写入端共用同一个文档表达式，是这条不复发的前提。
     *
     * @param {Document} [doc] 当前这份卷子的文档；不传时用「正在答的题」所在文档兜底。
     */
    _isQuizForceSkipping: function (doc) {
      if (!this._quizForceSkipUntil || Date.now() >= this._quizForceSkipUntil) return false;
      // 冷却还没过，但**只对写入时那一份卷子**生效（R3：一张坏卷子不该冻结整门课）。
      var paperKey = this._quizForceSkipPaperKey || '';
      if (!paperKey) return true;                 // 写入时没带卷子键 → 全局冷却，与今天一致
      // 与写入侧**同一个**文档表达式，别在这里另起一份。
      var keyDoc = doc || this._getQuizDocumentFromQuestions(this._quizCurrentQuestions) || null;
      var currentKey = '';
      try { currentKey = String(this._getQuizWorkKey(keyDoc) || ''); } catch (eKey) { currentKey = ''; }
      // ⚠️ 认不出当前卷子时**让冷却继续生效**（保守 = true），别写反成「认不出就放行」：
      //   那样 401 / 接口不可用这些既有退避会在取键失败的瞬间失效，插件立刻又开始白烧请求。
      if (!currentKey) return true;
      return currentKey === paperKey;
    },

    /**
     * 「现在是不是落在**任意一个**『暂停』窗口里」—— 不比卷子键。
     *
     * 只给两处拿不到卷子文档的调用点用：`nextUnit`（64-tasks-loop.js）与
     * `_shouldHoldQuizBeforeNext` 的第一行。它们问的不是「这一卷要不要暂停」，
     * 而是「我能不能离开这一节」：窗口还在 = 刚刚放弃过一份卷子 = 正该往前走，
     * 此时 `_shouldHoldQuizBeforeNext` 那道「交卷前别急着走」的闸门只会帮倒忙。
     *
     * ⚠️ 为什么这里不能沿用无参的 `_isQuizForceSkipping()`（HIGH-1 的同一家族、
     *   方向倒过来）：卷子键是**按文档**算的。无参时它读 `_quizCurrentQuestions`
     *   所在的文档，而那组状态在放弃时会被清掉 —— 清掉之后它退到主文档重算，
     *   算出来的是**另一个键**（两边都非空、就是不相等），于是返回 false，
     *   `nextUnit` 被 hold 拦住、`_handleQuiz` 又在冷却里不干活 = **该走的走不了**。
     *   认不出卷子时宁可放行离开：代价只是同一张卡片里另一份卷子这 90 秒内
     *   不被补做（下一轮 OCS 仍会按卷判它），远小于「该节点停摆」的后果。
     */
    _isQuizSkipWindowLive: function () {
      return !!(this._quizForceSkipUntil && Date.now() < this._quizForceSkipUntil);
    },

    _forceSkipQuizAfterMaxAttempts: function (preferredDoc) {
      var count = this._getQuizSubmitAttemptCount(preferredDoc);
      var max = this._getQuizMaxSubmitAttempts(preferredDoc);
      this._setQuizForceSkip(15000);
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
          this._setQuizForceSkip(15000);
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
        // ⚠️「这份文档的卷子已完成」只能对**真是一张卷子的文档**说（批次 13-A）。
        // 现场：`_resolveQuizSubmitDocument(null)` 落在知识卡片那份文档上，
        // 而卡片页每条任务点后面都写着「已完成」—— `_isDocumentFrameFinished` 当场为真，
        // 于是「还没做的题」被读成「这一节已完成」，直接翻下一节
        //（用户的原话：「这到底是在用什么东西看？怎么说已完成了？」）。
        // 「看不见题」不等于「题做完了」：卷子帧跨域、还没加载、或压根没找着时，
        // 宁可返回 false 让上层走 hold/告警，也不许在这里替平台宣布完成。
        if (doc && !this._docHasQuizPaperShape(doc)) return false;
        if (doc && this._isDocumentFrameFinished(doc)) return true;
        var text = doc && doc.body ? textOf(doc.body) : '';
        // 「通过标准：60 分」是卷面说明，不是平台宣布通过；把它当完成证据会跳过还没交的卷。
        // 正面证据只认平台明确的「任务点已完成 / 已通过 / 恭喜」。
        if (text && !/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text) && /任务点已完成|已通过|恭喜/.test(text)) return true;
      } catch (e) {}
      return false;
    },

    _hasActiveQuizSubmitForm: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      if (!doc) return false;
      try {
        var hasQuiz = !!doc.querySelector(this._quizContainerSelector + ', input[id^="answertype"]');
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
      // 一次提交可能连着几发（btnBlueSubmit → 确认弹窗），**只有进入新一轮时**才清账：
      // 在确认那一发上清零会把点击时已经发出的请求从证据里抹掉。
      if (!wasPending) {
        this._quizSubmitNet = { xhr: 0, fetch: 0, done: 0, failed: 0, statuses: [], words: [] };
      }
      var attemptCount = wasPending ? this._getQuizSubmitAttemptCount(preferredDoc) : this._incrementQuizSubmitAttemptCount(preferredDoc);
      var questionsDoc = this._getQuizDocumentFromQuestions(this._quizCurrentQuestions);
      // ⚠️ 三个键**必须同源**（批次 8）：`key` 是这次真正记账的槽位、`accountFrom` 是它的出处、
      // `readyKey` 是 ready 那一路的键。三者对不上就是"上限绕得开"那一族故障的现场证据，
      // 而它只能在这条日志里同时看到（批次 8 之前只能靠人肉复现）。
      emitRuntimeLog('info', 'quiz submit pending', {
        reason: reason || '',
        key: this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)),
        accountFrom: preferredDoc ? 'caller' : (questionsDoc ? 'questions' : 'fallback-document'),
        readyKey: this._quizReadyWorkKey || '',
        attemptCount: attemptCount,
        maxAttempts: this._getQuizMaxSubmitAttempts(preferredDoc)
      });
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
        // 旁路账：只记**计数、状态码、回包里跟判分有关的词** ——
        // 不记 URL / 请求体 / 回包原文：环会被导出、跨会话留存，而学习通地址里带着
        // enc/cpi 这类课程标识。原文仍留在 console（不落环）。
        var note = function (kind, url, status, text, failed, pendingAtSend) {
          try {
            var net = self._quizSubmitNet;
            if (!net) return;
            if (!net.statuses) net.statuses = [];
            if (!net.words) net.words = [];
            net[kind] = (net[kind] || 0) + 1;
            if (failed) net.failed = (net.failed || 0) + 1;
            if (status != null) {
              net.done = (net.done || 0) + 1;
              if (net.statuses.indexOf(status) < 0 && net.statuses.length < 6) net.statuses.push(status);
            }
            var words = String(text || '').match(/失败|成功|未能|不能|无法|重复|已提交|已交|请勿|错误|异常|超时|提交/g);
            if (words) {
              for (var i = 0; i < words.length && net.words.length < 8; i++) {
                if (net.words.indexOf(words[i]) < 0) net.words.push(words[i]);
              }
            }
            // 进环的时机：**发出去那一刻**正在等交卷结果，或它回来时还在等。
            // 这样超时之后才回来的响应也留得下证据；平时的 AJAX 不占 200 条环。
            if ((pendingAtSend || self._quizSubmitPending) && interesting.test(url)) {
              emitRuntimeLog('info', 'quiz submit network', {
                kind: kind,
                status: status == null ? -1 : status,
                ok: failed ? false : (status == null ? null : (status >= 200 && status < 400)),
                respLen: String(text || '').length,
                pendingAtSend: !!pendingAtSend,
                words: net.words.slice(0)
              });
            }
          } catch (eN) {}
        };
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
                var xhr = this;
                var pendingAtSend = !!self._quizSubmitPending;
                this.addEventListener('loadend', function () {
                  try {
                    console.log('[Omitone] submit sniffer ←', this.status,
                      String(this.responseText || '').slice(0, 800));
                    // status 0 = 网络层直接失败（断网 / 被拦 / 中止），单独算一种
                    note('xhr', xhr.__omitoneUrl, this.status || 0, this.responseText, this.status === 0, pendingAtSend);
                  } catch (e2) {}
                });
              }
            } catch (e3) {}
            return origSend.apply(this, arguments);
          };
        }
        if (typeof window.fetch === 'function') {
          var origFetch = window.fetch;
          window.fetch = function (input, init) {
            var url = '';
            var method = '';
            try {
              url = typeof input === 'string' ? input : String((input && input.url) || input || '');
              method = String((init && init.method) || (input && input.method) || 'GET');
            } catch (eF0) {}
            var matched = interesting.test(url);
            var pendingAtSend = !!self._quizSubmitPending;
            var p = origFetch.apply(this, arguments);
            if (!matched) return p;
            try { console.log('[Omitone] submit sniffer fetch →', method, url); } catch (eF3) {}
            // 完全穿透：只挂旁路回调，返回的仍是原 Promise（不改结果、不改异常）。
            p.then(function (res) {
              try {
                var status = res ? res.status : 0;
                try {
                  var clone = res && res.clone ? res.clone() : res;
                  clone.text().then(function (t) {
                    note('fetch', url, status, t, false, pendingAtSend);
                  }, function () {
                    note('fetch', url, status, '', false, pendingAtSend);
                  });
                } catch (eF4) { note('fetch', url, status, '', false, pendingAtSend); }
              } catch (eF5) {}
            }, function () {
              note('fetch', url, 0, '', true, pendingAtSend);
            });
            return p;
          };
          self._submitSnifferFetch = true;
        }
        self._submitSnifferCoverage = self._submitSnifferFetch ? 'xhr+fetch' : 'xhr';
        console.log('[Omitone] submit sniffer installed', self._submitSnifferCoverage);
      } catch (e) { console.warn('[Omitone] submit sniffer 安装失败（不影响功能）', e); }
    },

    /**
     * 提交结果只记一格：accepted / rejected / unknown / redo。
     * rejected 自带 30 秒窗口，挡住“平台刚说失败、下一拍原样再交”—— 这是 #52 审计 P0 的第二条。
     * 不在这里改 20/2 次预算与放弃名单：窗口只减少盲目重交，超过窗口仍交给原有停滞预算。
     */
    _setQuizSubmitOutcome: function (state, preferredDoc, extra) {
      var key = '';
      try { key = String(this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc || null)) || ''); } catch (eKey) {}
      var now = Date.now();
      var prev = this._quizSubmitOutcome || null;
      var next = {
        state: String(state || ''),
        key: key,
        at: now,
        rejectedUntil: state === 'rejected' ? now + 30000 : 0,
        text: String((extra && extra.text) || '').slice(0, 120)
      };
      this._quizSubmitOutcome = next;
      if (!prev || prev.state !== next.state || prev.key !== next.key ||
          (next.state === 'rejected' && prev.text !== next.text)) {
        emitRuntimeLog(next.state === 'rejected' || next.state === 'unknown' ? 'warn' : 'info',
          'quiz submit outcome', {
            state: next.state,
            key: key.slice(0, 60),
            text: next.text,
            rejectedUntil: next.rejectedUntil ? next.rejectedUntil - now : 0
          });
      }
      return next;
    },

    _quizSubmitRejectedBlocksRetry: function (now, preferredDoc) {
      var o = this._quizSubmitOutcome;
      if (!o || o.state !== 'rejected') return false;
      if (!(Number(o.rejectedUntil) > Number(now))) return false;
      var key = '';
      try { key = String(this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc || null)) || ''); } catch (eKey) { key = ''; }
      return !!key && key === o.key;
    },

    _monitorQuizSubmit: function (preferredDoc) {
      if (this._prepareQuizRedoIfNeeded(preferredDoc || null)) return true;
      if (!this._quizSubmitPending) return false;

      if (this._isQuizPassedOrFinished(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizAnswered = true;
        this._clearQuizSubmitAttemptCount(preferredDoc || null);
        if (typeof this._setQuizSubmitOutcome === 'function') this._setQuizSubmitOutcome('accepted', preferredDoc, {});
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
      if (now - (this._quizSubmitStartedAt || 0) > scaledMs(2000) && this._isQuizAnswersCleared(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizSubmitStartedAt = 0;
        emitRuntimeLog('warn', 'quiz answers cleared after submit', {
          note: '表单被清空了 —— 只是记录，不据此把答案判错（失败原因尚未查明）'
        });
        return false;
      }

      var waitMs = scaledMs(Number(this.configs.quizSubmitWaitMs || 25000));
      if (this._quizSubmitStartedAt && now - this._quizSubmitStartedAt > waitMs) {
        this._quizSubmitPending = false;
        if (typeof this._setQuizSubmitOutcome === 'function') this._setQuizSubmitOutcome('unknown', preferredDoc, {});
        // 超时时把「为什么没认出结果页」一并记下来 ——
        // 没有这段的话，日志里只剩一句「等超时了」，缺哪道条件完全靠猜。
        var diag = this._describeQuizResultPage(preferredDoc || null);
        diag.waitMs = waitMs;
        // 这一发超时记在哪一份卷子上，连攒几次由 `_shouldHoldQuizBeforeNext` 放手。
        diag.stalls = this._noteQuizSubmitStall(preferredDoc || null);
        // 旁路观测到的提交请求 —— 「平台静默拒收」与「我们根本没发出去」靠这一格分开。
        diag.observer = this._submitSnifferCoverage || 'none';
        var net = this._quizSubmitNet || null;
        diag.net = net ? {
          xhr: Number(net.xhr) || 0,
          fetch: Number(net.fetch) || 0,
          done: Number(net.done) || 0,
          failed: Number(net.failed) || 0,
          statuses: (net.statuses || []).slice(0, 8),
          words: (net.words || []).slice(0, 8)
        } : null;
        diag.netHint = (diag.net && (diag.net.xhr + diag.net.fetch) > 0)
          ? '看 net.statuses / net.words：平台拒收时状态码或回包文案与「没发出去」不同'
          : '这一页的 XHR/fetch 上没观察到提交请求 —— 0 条不等于没发（观测器只覆盖本页；跨域帧、表单直交、页面跳转都绕得开它）';
        emitRuntimeLog('warn', 'quiz submit wait timeout', diag);
        return false;
      }

      if (!this._quizSubmitLogAt || now - this._quizSubmitLogAt > 3000) {
        this._quizSubmitLogAt = now;
        console.log('%c[Omitone] waiting quiz submit result', 'color:#9C27B0');
      }
      return true;
    },

    /**
     * 「等结果页等超时」这件事记在哪一份卷子上 —— 返回连攒到第几次。
     *
     * ⚠️ 换了卷子就**重新起算**（键变了说明这是另一份卷子的账）；
     *    同一份卷子连续攒满 3 次没有一次到达结果页，才轮到 `_shouldHoldQuizBeforeNext` 放手。
     *    这与批次 86 / §2 #13 那条「跨拍记账不许被同一轮动作清零」是同一族：
     *    计数器只能由「真的换了一份卷子」重置，不能由一次重试清零。
     */
    _noteQuizSubmitStall: function (preferredDoc) {
      var key = '';
      try { key = String(this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc || null)) || ''); } catch (eKey) { key = ''; }
      if (!key) {
        // 五个 id 字段全空时退回「一帧一份卷子」的身份（同一份卷子的键跨拍稳定、换一帧就换键）——
        // 不用常量 `paper:unknown`，否则上一卷的停滞次数会算到下一卷头上（§2 #13 同一族）。
        try { key = String(this._getQuizDocumentIdentity(this._getQuizAccountDocument(preferredDoc || null)) || ''); } catch (eId) { key = ''; }
      }
      if (!key) key = 'paper:unknown';
      if (this._quizSubmitStallKey !== key) {
        this._quizSubmitStallKey = key;
        this._quizSubmitStallCount = 0;
      }
      this._quizSubmitStallCount = (Number(this._quizSubmitStallCount) || 0) + 1;
      this._quizSubmitStallAt = Date.now();
      return this._quizSubmitStallCount;
    },

    /**
     * 这一份卷子的任务点 id —— 放弃名单要按它记，才能跨轮次按住同一个任务点。
     *
     * 三级来源，前一级拿不到才看下一级：① 卷子文档的隐藏字段 `#jobid`；
     * ② 宿主帧的 `jobid` / `_jobid` 属性（`_classifyTaskFrame` 的 explicitJob 也认这一枚）；
     * ③ 卡片里**恰好一枚**未完成的 quiz 任务点（多于一枚时认不出是哪一份，宁可返回空串）。
     *
     * @param {Document} doc 卷子所在文档
     * @param {boolean} [allowTaskScan] 是否允许第 ③ 级（它要遍历全部帧，别放进热路径）
     */
    _getQuizGiveUpJobId: function (doc, allowTaskScan) {
      var id = this._getQuizFieldValue(doc || null, 'jobid');
      if (id) return id;
      try {
        var frame = doc && doc.defaultView ? doc.defaultView.frameElement : null;
        if (frame && frame.getAttribute) {
          var attr = String(frame.getAttribute('jobid') || frame.getAttribute('_jobid') || '').trim();
          if (attr) return attr;
        }
      } catch (eFrame) {}
      if (!allowTaskScan) return '';
      try {
        var quizTasks = (this._collectVisibleTaskFrames() || []).filter(function (task) {
          return task && !task.finished && task.type === 'quiz';
        });
        if (quizTasks.length === 1) {
          var taskId = String(this._getQuizPaperKeyFromTask(quizTasks[0]) || '').trim();
          if (taskId) return taskId;
        }
      } catch (eScan) {}
      return '';
    },

    /** 页面上这一份卷子的任务点是不是已经在 24 小时放弃名单里。 */
    _isQuizGivenUpInDom: function (preferredDoc) {
      try {
        var doc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
        var jobid = this._getQuizGiveUpJobId(doc || null, false);
        return !!(jobid && this._isTaskGivenUp('job:' + jobid));
      } catch (e) {
        return false;
      }
    },

    /**
     * 连续几次「等结果页都等不到」之后放手这一份卷子 —— 有界，但**不冒充平台完成**。
     *
     * 现场（2026-11-25，#232）：填答审计说题都填上了、提交流程也走完了，
     * 平台既不出判分页也不清空表单，于是 `_shouldHoldQuizBeforeNext` 的
     * 「还有可交互的提交表单」那一支每一轮都按住整节 —— 结构上没有次数上限、也没有时间上限，
     * 那一门课就永远停在这一节（现场三条 `quiz submit wait timeout` 间隔约 32 分钟）。
     *
     * 两件事一起做，缺一半都不算修好：
     *   ① 把这一枚任务点写进**现有**的 24 小时放弃名单（与视频那一族同一本账），
     *      于是换节之后调度器不会过一会儿又把它派回来；
     *   ② 放开这一节往前走（与「提交次数到顶」那条走同一条出口）。
     * ⚠️ 不写任何「任务点已完成」的标记 —— 平台没判过，这里也不许替它判。
     */
    _giveUpQuizSubmitAfterStalls: function (doc, reason) {
      var stalls = Number(this._quizSubmitStallCount) || 0;
      var attempts = this._getQuizSubmitAttemptCount(doc || null);
      var maxAttempts = this._getQuizMaxSubmitAttempts(doc || null);
      var paperKey = '';
      try { paperKey = String(this._getQuizWorkKey(this._getQuizAccountDocument(doc || null)) || ''); } catch (eKey) { paperKey = ''; }
      var jobid = this._getQuizGiveUpJobId(doc || null, true);
      var gaveUp = false;
      if (jobid) {
        this._markTaskGivenUp('job:' + jobid, {
          name: String(jobid).slice(0, 60),
          reason: 'quiz-submit-never-accepted',
          attempts: attempts
        });
        gaveUp = true;
      }
      var net = this._quizSubmitNet || {};
      emitRuntimeLog('warn', 'quiz submit never accepted, giving up unit', {
        reason: reason || '',
        stalls: stalls,
        attempts: attempts,
        maxAttempts: maxAttempts,
        paperKey: paperKey.slice(0, 90),
        jobid: String(jobid || '').slice(0, 60),
        gaveUp: gaveUp,
        observer: this._submitSnifferCoverage || 'none',
        xhr: Number(net.xhr) || 0,
        fetch: Number(net.fetch) || 0,
        failed: Number(net.failed) || 0,
        statuses: (net.statuses || []).slice(0, 8),
        words: (net.words || []).slice(0, 8),
        hint: gaveUp
          ? '已写进 24 小时任务点放弃名单；要让它再试，控制台执行 xxtAI.clearTaskGiveUp()'
          : '认不出这一枚任务点的 jobid，没写放弃名单 —— 下一轮可能还会派回来'
      });

      this._quizInProgress = false;
      this._quizAnswered = true;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizSubmitStallKey = '';
      this._quizSubmitStallCount = 0;
      this._quizSubmitStallAt = 0;

      this._setQuizForceSkip(90000, paperKey || undefined);
      if (this._switchToNextLearningCard('quiz-submit-given-up')) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          // `_resetRuntimeState` 会把暂停窗口一起清掉，点完之后必须重新写一次
          this._setQuizForceSkip(90000, paperKey || undefined);
          return true;
        }
      } catch (e) {}
      this.nextUnit();
      return true;
    },

    _shouldHoldQuizBeforeNext: function (reason) {
      // 这里不比卷子键，理由见 `_isQuizSkipWindowLive`（这一处无参调
      // `_isQuizForceSkipping()` 是 HIGH-1 倒过来的那个形态）。
      if (this._isQuizSkipWindowLive()) return false;
      // 被可恢复的原因挡住时**要**按住（批次 13-B）；用户自己关掉答题则照旧不 hold。
      if (this._isQuizApiUnavailable() && !this._isQuizBlockedByApi()) return false;
      if (this._monitorQuizSubmit()) return true;
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      if (!this._detectQuiz() && !this._hasActiveQuizSubmitForm(doc)) return false;
      if (this._isQuizPassedOrFinished(doc)) return false;
      var now = Date.now();
      var shouldLog = !this._quizHoldLogAt || now - this._quizHoldLogAt > 3000;
      if (this._isQuizRedoRequired(doc)) {
        if (typeof this._setQuizSubmitOutcome === 'function') this._setQuizSubmitOutcome('redo', doc, {});
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
        // 平台既不出判分页、也不清表单 —— 这一支原先**既没有次数上限也没有时间上限**，
        // 一按住就是整节停摆（#232：三条超时各自相隔约 32 分钟，课永远停在这一节）。
        // 攒满 3 次才放手：一次超时可能只是页面慢，连着三次都没有一次到达结果页就是死局。
        if ((Number(this._quizSubmitStallCount) || 0) >= 3) {
          if (this.configs && this.configs.quizRejectGiveUp === false) {
            if (shouldLog) {
              this._quizHoldLogAt = now;
              emitRuntimeLog('warn', 'quiz submit rejected, holding in debug mode', {
                reason: reason || '',
                stalls: Number(this._quizSubmitStallCount) || 0
              });
            }
            return true;
          }
          return this._giveUpQuizSubmitAfterStalls(doc, reason);
        }
        if (shouldLog) {
          this._quizHoldLogAt = now;
          emitRuntimeLog('warn', 'hold unsubmitted quiz before next', {
            reason: reason || '',
            stalls: Number(this._quizSubmitStallCount) || 0
          });
        }
        return true;
      }
      return false;
    },

    /**
     * 「卷子卡住」时到底卡在哪几题 —— 给 hold 类日志用的诊断切片。
     *
     * 为什么必须有：现场只有一句 `study hold quiz before finish`，**看不出是
     * "没答上"还是"答上了但填不进去"**。实测踩过：25 题只填上 23 题，
     * 每一轮的日志一模一样，只能靠人肉在页面上逐题数 —— 而这本来是日志一句话能说清的。
     * 它把未填的那几题的**题型、题干前缀、文本框数、富文本编辑器数、qid** 一起带上，
     * 一眼就能判断该去查哪条填答路径（`_fillText` / `_fillTextarea` / `_applyChoiceAnswer`）。
     */
    _describePendingQuizQuestions: function (preferredDoc) {
      try {
        var questions = this._quizCurrentQuestions || [];
        if (!questions.length) {
          var fallbackDoc = this._resolveQuizAnswerDocument(preferredDoc || null) || null;
          questions = fallbackDoc ? this._extractQuestions(fallbackDoc) : [];
        }
        if (!questions.length) return { total: 0 };
        var doc = this._resolveQuizAnswerDocument(preferredDoc || null) || this._getMainDocument() || document;
        var byType = {};
        var unfilled = [];
        var self = this;
        questions.forEach(function (question, index) {
          var type = String((question && question.type) || '?');
          byType[type] = (byType[type] || 0) + 1;
          var value = '';
          try { value = self._getQuizQuestionFilledValue(doc, question); } catch (e) { value = ''; }
          if (value) return;
          var el = question && question._element;
          var qid = '';
          try { qid = self._getQuestionIdFromElement(el) || ''; } catch (e2) { qid = ''; }
          unfilled.push({
            no: index + 1,
            type: type,
            title: String((question && question.title) || '').slice(0, 18),
            textInputs: el ? el.querySelectorAll('input[type="text"], input:not([type])').length : -1,
            richEditors: el ? el.querySelectorAll('iframe').length : -1,
            qid: String(qid).slice(0, 24)
          });
        });
        return {
          total: questions.length,
          unfilledCount: unfilled.length,
          byType: byType,
          unfilled: unfilled.slice(0, 6)
        };
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 120) };
      }
    },

    /**
     * 「为了这份卷子，这一节要不要按住不放手」—— 只有一处答案（2026-11-11 批次 9-C）。
     *
     * 现场：真实日志 00:45:59 → 00:46:16 连磨两轮 `study hold quiz before finish
     * {pending:{total:0}}`，最后是页面自己刷新才走通。用户报的"在已经做完的界面磨蹭很久"
     * 就是这两轮 —— hold 的是**0 道题**。
     *
     * 根因是两把判据不同源：`_isQuizLearningPending` 走的是「页面上有题的形状」那类宽判据
     * （`_hasActiveQuizSubmitForm` / `_detectQuiz`），而 `_describePendingQuizQuestions`
     * 要**数得出具体容器**。宽判据说有、具体数出来是 0 时，继续等不会等出任何东西。
     *
     * ⚠️ 三个保守分支不许放宽：数不出题但**答题动作正在飞**（`_quizInProgress` / `_quizSubmitPending`）
     * 时要 hold（正在填不该放手）；`pendingDesc` 是 `{error}` 这种**没数成**的形状时也 hold ——
     * 宁可慢，不能因为自己数漏了就整节放行。
     */
    _shouldHoldQuizBeforeFinish: function (pendingDesc) {
      if (!pendingDesc) return true;
      if (pendingDesc.total !== 0) return true;
      if (this._quizInProgress || this._quizSubmitPending) return true;
      return false;
    },

    _isQuizLearningPending: function (preferredDoc) {
      if (this._isQuizForceSkipping(preferredDoc || null)) return false;
      // ⚠️ 批次 13-B：以前这里无条件 `return false`，把「答题链路现在用不了」
      // 当成「这一页没有题要做」—— 上层随即宣布本节完成并翻节，
      // 用户看到的是「题一道没做就说已完成了」。
      // 现在可恢复的阻塞（key 没填 / 网络退避）继续算 pending，让调度器按住这一节。
      if (this._isQuizApiUnavailable()) return this._isQuizBlockedByApi();
      if (this._monitorQuizSubmit(preferredDoc || null)) return true;
      if (this._quizInProgress || this._quizSubmitPending) return true;

      // ⚠️ 放弃名单是**跨轮次**的：`_resetRuntimeState()` 会把 `_quizAnswered` 清掉、
      // 90 秒暂停窗口也早晚过期 —— 只剩这一格能在「不干活也不放手」的原地不复活
      // （#232：平台静默拒收之后，这一节会被每一轮重新按住）。
      // 放在在飞动作之后：提交/作答正飞着时不许被它截断。
      if (this._isQuizGivenUpInDom(preferredDoc || null)) return false;

      var doc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
      if (doc && this._isQuizPassedOrFinished(doc)) return false;

      // ⚠️ **自己刚答过这份卷子 → 这一轮不需要再答。**
      // 不加这一条会死锁（实测 2026-10-17，卡了整整 6 分钟）：
      //   刚交完卷 → `_quizAnswered` 仍为真 → `_handleQuiz` 第一行就直接 return（不干活）；
      //   而平台还没渲染出结果页、提交按钮还在 → `_hasActiveQuizSubmitForm` 又说"还有题" →
      //   调度器每秒把同一份卷子交给它、它每秒空转，永远不前进，日志里只有一行行的
      //   `study matched job`。
      // 只有"平台明确要求重做"时才继续算 pending —— 那条在下面有自己的分支。
      if (this._quizAnswered && !this._isQuizRedoRequired(doc || null)) return false;

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
      // "放弃这一卷"的冷却窗口内直接退出：否则跳过去之后任务点还在页面上，
      // 下一秒又被匹配回来、再问一次模型（白烧 token），看起来像"跳过根本没生效"。
      // _quizInProgress 一旦因为异常岔在 true 上，第一行就会挡住一切 —— 整页永久停摆，
      // 日志里只留一条 30 秒去重的 tick error。5 分钟没换过就当成泄漏，清掉并留 warn。
      if (this._quizInProgress && this._quizInProgressAt && Date.now() - this._quizInProgressAt > 300000) {
        emitRuntimeLog('warn', 'quiz in-progress state leaked, reset', { ageMs: Date.now() - this._quizInProgressAt });
        this._quizInProgress = false;
      }
      // ⚠️ 这里必须把 `preferredDoc` 传下去：冷却是按卷子键生效的，而键按文档算 ——
      //   不传 = 读侧算的是另一个文档的键 = 本 bug（见 `_isQuizForceSkipping` 上方注释）。
      var holdForceSkip = this._isQuizForceSkipping(preferredDoc || null);
      var holdBusy = !!this._quizInProgress;
      var holdAnswered = !!this._quizAnswered;
      if (holdForceSkip || holdBusy || holdAnswered) {
        if (holdAnswered && !holdForceSkip && !holdBusy) {
          var holdDoc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
          // 结果页/重做提示在的时候「已答」是有意义的中间态，后面自有分支处理；
          // 两者都没有、页面上却是一批完全没见过的题 = 同一份文档里的**第二份卷子**。
          if (!this._isQuizPassedOrFinished(holdDoc) && !this._isQuizRedoRequired(holdDoc) &&
              this._isQuizPaperChangedInDom(holdDoc)) {
            emitRuntimeLog('info', 'quiz paper switched by question identity', {
              hint: '页面上出现一批完全不认识的题目，按「换了一份卷子」重置答题状态后照常作答'
            });
            // 「换一份卷子要清的那一组状态」与「放弃这一卷」是同一组，复用同一份实现，
            // 不在这里手抄第二遍（手抄过少一个字段就会留下上一份卷子的答案状态）。
            this._resetQuizStateForSkip();
            holdAnswered = false;
          }
        }
        var holdReason = holdForceSkip ? 'force-skip' : (holdBusy ? 'in-progress' : (holdAnswered ? 'answered' : ''));
        // 「题目明明在页面上，却一个字都不答」是这一族最难查的现场：三个原因过去共用
        // 一个**静默**出口，日志里连一个字都没有。现在把命中的那一个写清楚（10 秒节流，
        // 与既有 warn 同频，不会冲掉环形缓冲）。
        if (holdReason) {
          var nowHold = Date.now();
          if (!this._quizHoldReasonLogAt || nowHold - this._quizHoldReasonLogAt > 10000) {
            this._quizHoldReasonLogAt = nowHold;
            emitRuntimeLog('warn', 'quiz held: nothing answered this round', {
              reason: holdReason,
              paper: String(this._quizRunPaperKey || '').slice(0, 60),
              hint: holdReason === 'force-skip'
                ? '这一卷在「暂停」冷却窗口内，窗口过了自己会重来（看上一条 quiz paused / skip quiz）'
                : (holdReason === 'in-progress'
                  ? '上一轮答题还没结束；超过 5 分钟会按状态泄漏自愈'
                  : '自认这份卷子已答完，但页面上既没有结果页也没有重做提示，题目身份也认不出变化')
            });
          }
          return;
        }
      }
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
      // 字体反爬解密在 content.js 里异步进行（MutationObserver + 有界防抖），抽题原本不等它 ——
      // 竞态窗口里抽到的是密文题干，直接发给模型必错还烧 token（README 已知缺陷 #6 的竞态面）。
      // 看到 .font-cxsecret 残留就等下一轮 tick（解密扫描通常 300ms~1s 内完成）；
      // 上限 8 秒：真解不出来就按现状继续，交给下面的题干乱码守卫接手，绝不死等成新的卡死点。
      //
      // ⚠️ 两条从日志里长出来的修正（2026-11-10 批次 5）：
      //   ① 探测范围收成**题目那一份文档及其子帧**。不相干的装饰帧里常年挂着解不掉的残留，
      //      整页扫描会把它们算成"这一卷还没解密"，于是每份卷子先白等满 8 秒再照答 ——
      //      实测两份题面本来就正常的卷子各白等 8.1s / 12.2s，用户看到的就是"卡住不答题"。
      //   ② 除了 data-om-font-miss，还认解密层的**终局判据**（nodecl / nomap，见 _probeFontDecrypt）：
      //      它已经明确说过"这一份解不了"，再等 8 秒也不会多出一个字形。
      var fontProbe = this._probeFontDecrypt(preferredDoc || null);
      if (fontProbe.secret) {
        var fontNoWait = fontProbe.miss || fontProbe.terminal;
        var fontWaitLimitMs = scaledMs(Number(this.configs.fontDecryptWaitMs || 8000));
        if (fontNoWait) {
          // 本轮不等：把等待窗口清掉，别留一个"等到一半"的戳给下一轮误读
          this._fontSecretWaitSince = 0;
          // 这条会被 OCS 循环每秒撞到，必须节流（30 秒一条，并报压掉了多少条）
          if (!this._fontNoWaitLogAt || Date.now() - this._fontNoWaitLogAt > 30000) {
            var noWaitSuppressed = this._fontNoWaitSuppressed || 0;
            this._fontNoWaitLogAt = Date.now();
            this._fontNoWaitSuppressed = 0;
            emitRuntimeLog('info', 'font decrypt verdict: answer as-is', {
              state: fontProbe.state,
              fontMiss: fontProbe.miss,
              terminal: fontProbe.terminal,
              scope: preferredDoc ? 'quiz-doc' : 'whole-page',
              suppressed: noWaitSuppressed,
              hint: fontProbe.miss
                ? '字形哈希在映射表里查不到（data-om-font-miss）—— 等也不会变好，按现状作答并交给乱码守卫'
                : '解密层已对这一份文档给出终局判据：nodecl=文档里没有字体声明，nomap=映射表建不起来'
            });
          } else {
            this._fontNoWaitSuppressed = (this._fontNoWaitSuppressed || 0) + 1;
          }
        } else {
          // ⚠️ 「解密扫描**没覆盖到这一份文档**」时等满 8 秒是纯白等（批次 9-B）。
          // 真实日志 00:46:41 → 00:46:49：`state:"(none)"`、`sweepAgoMs:-1` 等满上限，
          // 一个字也没多解出来 —— 而 content.js 那一次扫描若真会跑到这一份文档，
          // 两秒多的防抖窗口就足够落戳。**已经在扫的文档（有戳）仍等满原窗口**，
          // 别把这条宽限当成"整体不等"。
          var sweepNotCovered = fontProbe.sweepAgoMs < 0 || fontProbe.state === '(none)';
          var fontEffectiveLimitMs = sweepNotCovered ? Math.min(fontWaitLimitMs, scaledMs(2500)) : fontWaitLimitMs;
          var secretWaitSince = this._fontSecretWaitSince || 0;
          if (!secretWaitSince) {
            this._fontSecretWaitSince = Date.now();
            // state='(none)' / sweepAgoMs=-1 就说明 content.js 那一次扫描**没跑到这一份文档**
            // —— 这是"连解码都没有"这句话唯一能被证实的形式，也是下一轮排查的落点。
            emitRuntimeLog('info', 'quiz waiting font decrypt', {
              hint: '题目文字还在 font-cxsecret 密文态，等解密扫描完成（本条每轮等待窗口只打一次）',
              state: fontProbe.state,
              sweepAgoMs: fontProbe.sweepAgoMs,
              waitLimitMs: fontEffectiveLimitMs,
              scope: preferredDoc ? 'quiz-doc' : 'whole-page'
            });
            return;
          }
          if (Date.now() - secretWaitSince < fontEffectiveLimitMs) return;
          this._fontSecretWaitSince = 0;
          emitRuntimeLog('warn', 'font decrypt pending over limit, answer anyway', {
            waitedMs: Date.now() - secretWaitSince,
            limitMs: fontEffectiveLimitMs,
            configuredLimitMs: fontWaitLimitMs,
            slowFactor: perfFactor(),
            state: fontProbe.state,
            sweepAgoMs: fontProbe.sweepAgoMs,
            scope: preferredDoc ? 'quiz-doc' : 'whole-page',
            hint: sweepNotCovered
              ? '这一份文档上连扫描戳都没有 —— 是 content.js 的解密扫描没覆盖到它，不是解得慢；批次 9-B 之后不再为此白等满配置窗口'
              : '等满上限仍未解出，按现状作答'
          });
        }
      } else {
        this._fontSecretWaitSince = 0;
      }
      this._quizInProgress = true;
      this._quizInProgressAt = Date.now();
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
            // ⚠️ 批次 12：`dropStages` 是「选择器 → {matched,filtered,deduped,unparsable}」。
            // 旧写法把每条的值当**数字**读，落盘就成了 `div[class*="question"]:NaN`；
            // 这里统一压成标量串（口径与 `_quizScanRetrySignal`、`_skipCompletedEvidence` 同一份）。
            // 并把容器是从**哪几份文档**数的也一起落盘 ——
            // 真页面实测：`containers` 以前固定在卡片页上数，卷子那份文档永远数不到（恒为 0）。
            containers: Number(diag.containers) || 0,
            containerDocs: Number(diag.containerDocs) || 0,
            containerPaths: String(diag.containerPaths || '').slice(0, 150),
            dropStages: this._flattenDropStages(diag.dropStages),
            samples: diag.samples.slice(0, 3)
          });
        }
        this._quizInProgress = false;
        // ⚠️ 批次 11-A：这一族的「0 题」必须喂给完成判定，不能只写一句诊断就扔掉。
        // 真实日志 00:46:04 已经量到了正确形状（`inputs:9` + 题形命中 1 + 容器 0），
        // 那是平台还没把卷子写进子帧 —— 00:46:16 重新加载后同一份当场答成 3 题。
        // 当时没有任何判据读这份数字，1 秒后就是 `skip completed {by:"all-tasks-finished"}`，
        // 用户看到的正是「第二个不答」+「判定为已完成了」。
        // 窗口有界：每张卡片一次、≤12 秒，用完照旧推进（`_quizScanRetrySignal` 在预算已用掉
        // 或窗口已武装时直接返回 null，所以这里每节课最多多扫一次诊断）。
        var scanSig = this._quizScanRetrySignal(preferredDoc);
        if (scanSig) this._maybeHoldSkipForUnparsedQuiz(scanSig, 'quiz-scan');
        return;
      }
      this._quizCurrentQuestions = questions;
      // 先解析本文档：「有没有进展」的判断要用它（后面填答用的是同一个表达式，
      // 这份先算好，避免同一个表达式出现两份）。
      var quizDocForProgress = preferredDoc || this._getQuizDocumentFromQuestions(questions) || null;
      if (quizDocForProgress) {
        // 「没进展就别每 30 秒把整卷重问一遍」的闸。
        //
        // 现场实测（2026-10-10）：25 题只填上 23，之后每轮都是
        // `clear stale quiz answers {"count":23}` → 把 23 条抹掉 → 把 25 题**原样重问一遍**，
        // 日志一轮一轮一模一样（用户看到的"一直卡住、填的还是重复的答案"），
        // 既没有进展又白烧 token。
        // 判据：**页面上已填题数与上轮相同**（=这一轮不会有新进展）且距上轮不足 60 秒 → 跳过本轮。
        // 窗口只有 60 秒，之后照常重试 —— 不会把它永久卡死（本仓库对"拿不准"的一贯取舍）。
        // ⚠️ 这两个状态必须**按卷子隔离**。
        // 实测（2026-10-17）：上一份卷子最后一轮 filled=0，紧跟着换到新卷子，
        // 新卷子第一轮当然也是 filled=0 → 被误判成"没有进展" → **新卷子白等 60 秒才开答**。
        // 用户看到的就是"做完上一题之后卡顿一下才开始做这道"。
        var quizPaperKey = '';
        try { quizPaperKey = String(this._getQuizWorkKey(quizDocForProgress) || ''); } catch (ePaperKey) {}
        // ⚠️ 按卷冷却写入时必须用**这一个**键（`quizPaperKey`）。
        // 判定端 `_isQuizForceSkipping(doc)` 用的文档表达式是
        // `doc || _getQuizDocumentFromQuestions(_quizCurrentQuestions) || null`，
        // 而调用点传的 `doc` 就是这里的 `preferredDoc`，且 `_quizCurrentQuestions` 已被
        // 赋成这里的 `questions` —— 两侧算出的文档**同一个**，键才可能对得上。
        // 别在这里再算一份「兜底用无参 `_getQuizWorkKey(null)`」的键：那正是读写侧错开的方式。
        if (quizPaperKey !== this._quizRoundPaperKey) {
          this._quizRoundPaperKey = quizPaperKey;
          this._quizRoundFilledCount = -1;   // -1 与任何真实题数都不相等 → 新卷子必定放行
          this._quizRoundNoProgressAt = 0;
          this._quizNoProgressLogAt = 0;
          this._quizZeroFillRounds = 0;
          this._quizZeroFillAt = 0;
        }

        // ===== 题干乱码守卫（第二层保护）=====
        //
        // 第一层是上面那道「等解密」：.font-cxsecret 类名还在时不抽题。
        // 但解密扫描完成后、映射表里却没有那个字形哈希时（表快照落后于平台字符集），
        // 残留的 PUA 字符（U+E000~U+F8FF）会混进题干 —— 发给模型必错，还白烧 token 与提交次数。
        // README 的口径是「看到乱码请立刻停下」：这里把它变成机器判据 ——
        // 按卷子记轮数（⚠️ 必须按卷子隔离，同 #43 的教训），连续 3 轮仍有乱码就**暂停这一卷** 90 秒。
        // ⚠️ 必须放在「无进展闸」**之前**：乱码卷 filled 计数不变，会被 60 秒闸先拦下，
        // 轮次就永远数不满、乱码卷永远跳不出。
        var garbledCount = 0;
        for (var gi = 0; gi < questions.length; gi++) {
          if (questions[gi].garbled) garbledCount++;
        }
        // 主信号（文档级）：content.js 解密时统计「出现了自定义字形但查表未命中」——
        // font-cxsecret 的真实机制是**正常中文字符 + 自定义字形**，不是 PUA 私有区！
        // 表缺字形时题干是通顺但错误的中文，下面按字符占比的 PUA 检测（兜底层）根本
        // 看不出来 —— 解密层的 miss 标记才是可靠信号（真实机制由同类开源实现交叉证实）。
        // ⚠️ 探测文档**以题目所属文档为准**，不以调用方传进来的 `quizDocForProgress` 为准。
        // `quizDocForProgress` 优先取 preferredDoc，而 `_extractQuestions(preferredDoc)`
        // 会自己钻 `#frame_content` 到**内层文档**抠题 —— 于是出现「preferredDoc 是外层、
        // 题在内层」。content.js 的 `data-om-font-miss` 写在它**解密的那一个文档**上
        // （=有题的那一个），只查外层就等于把守卫**静默关掉**（失败方向还不保守：
        // 乱码题照样发给模型），真实嵌套页就是这样漏的。
        // 一份页面上的题还可能分属**多个**文档，所以这里去重后**逐个探**
        // （宁可多探，不可漏探）；只探出题文档，不探既不出题的装饰帧 ——
        // 后者会把守卫变成"页面上随便哪个帧残留个标记就整卷暂停"的误报源。
        // 一个出题文档都拿不到时才退回 quizDocForProgress（旧语义），**不走全书扫描**。
        var garbledProbeDocs = [];
        try { garbledProbeDocs = this._getQuizDocumentsFromQuestions(questions); } catch (eProbeDocs) { garbledProbeDocs = []; }
        if (!garbledProbeDocs.length && quizDocForProgress) garbledProbeDocs = [quizDocForProgress];
        var probeMiss = false;
        for (var gpi = 0; gpi < garbledProbeDocs.length; gpi++) {
          if (this._hasFontDecryptMiss(garbledProbeDocs[gpi])) { probeMiss = true; break; }
        }
        if (!garbledCount && probeMiss) {
          garbledCount = questions.length;
        }
        if (garbledCount) {
          if (quizPaperKey !== (this._quizGarbledPaperKey || '')) {
            this._quizGarbledPaperKey = quizPaperKey;
            this._quizGarbledRounds = 0;
            this._quizGarbledRoundAt = 0;   // 换了一份卷子 → 新一轮立刻可计
          }
          // ⚠️ 轮次按**时间窗**累加，绝不能按调用次数（真实现场 2026-11-10）：
          // 本函数被 OCS 循环**每秒**调一次，按次数累加时 3 秒就数满 3 轮，
          // "跳过"比"乱码"发生得还快；而且每一秒一条 warn，200 条的日志缓冲
          // 两个半分钟就被刷空，排查时连"发生过什么"都看不到。
          // 现在只有距上次计数 ≥10 秒才 +1，warn 也跟着只在计数时打（每 10 秒最多一条）。
          var garbledNow = Date.now();
          var garbledCounted = !this._quizGarbledRoundAt || garbledNow - this._quizGarbledRoundAt >= 10000;
          if (garbledCounted) {
            this._quizGarbledRoundAt = garbledNow;
            this._quizGarbledRounds = (this._quizGarbledRounds || 0) + 1;
            emitRuntimeLog('warn', 'quiz text garbled by font decrypt', {
              garbled: garbledCount,
              total: questions.length,
              rounds: this._quizGarbledRounds
            });
          }
          this._quizInProgress = false;
          if (this._quizGarbledRounds >= 3) {
            this._quizGarbledPaperKey = '';
            this._quizGarbledRounds = 0;
            this._quizGarbledRoundAt = 0;
            // 数满 3 轮**不再跳卷**。原来的 `_skipQuiz()` 会走 `nextUnit()` 把整节翻过去，
            // 可"乱码"只说明这份卷子的题面读不得，不表示这一节该放弃 ——
            // 而跳走的代价是**不可见**的（用户只会看到"所有题目都被跳过"）。
            // 改成给这一卷 90 秒按卷冷却：代价可见（这一节还停在这里）、且会自愈
            // （90 秒后同一份卷子再试一次，换了别的卷子完全不受影响）。
            // 本仓库的一贯取舍：拿不准就停住、留日志，别替用户翻页。
            this._setQuizForceSkip(90000, quizPaperKey);
            emitRuntimeLog('error', 'quiz paused: text stays garbled', {
              garbled: garbledCount,
              hint: '连续 3 轮题干仍含密文字符 —— 字体映射表（resources/table.json）可能缺少新字形，更新后重新构建即可恢复；这一卷暂停 90 秒，不跳走'
            });
            return;
          }
          return;
        }
        if (quizPaperKey && quizPaperKey === (this._quizGarbledPaperKey || '')) {
          this._quizGarbledPaperKey = '';
          this._quizGarbledRounds = 0;
        }

        var filledNow = 0;
        for (var fi = 0; fi < questions.length; fi++) {
          if (this._getQuizQuestionFilledValue(quizDocForProgress, questions[fi])) filledNow++;
        }
        var nowProgress = Date.now();
        var sinceLast = nowProgress - (this._quizRoundNoProgressAt || 0);
        if (this._quizRoundFilledCount === filledNow && sinceLast < 60000) {
          // ===== 零填充死循环的出口 =====
          //
          // `filledNow === 0` 不是"这轮没进展"，而是**这卷一道题都落不到页面上**
          //（选项认不出 / 点不上）。原来的闸只管"别重问"，于是变成：
          //   ？秒后放行 → 重问 → 还是 0 → 再闸 60 秒 → …
          // 现场（2026-11-10 14:00）：整整 5 轮 `quiz round skipped: no progress`，
          // 页面一步没动，后面的任务全部做不了 —— 用户看到的就是"卡死了"。
          // 任务点的"卡住就放弃"计数也接不住它：`_taskProgressSnapshot` 对卷子恒为空，
          // 按那条规则"测不到进度一律不计"。
          //
          // 所以这里按**分钟**计数（本函数每秒都会被调一次，不能按调用次数算），
          // 连续 3 轮零填充就明确跳过这一卷、**只让这一卷**暂停 90 秒 —— 让后面的任务先走。
          // 只是跳过，不删任何记录：下一轮课程还能重新答。
          if (filledNow === 0) {
            var zeroNow = Date.now();
            if (!this._quizZeroFillAt || zeroNow - this._quizZeroFillAt >= 55000) {
              this._quizZeroFillAt = zeroNow;
              this._quizZeroFillRounds = (this._quizZeroFillRounds || 0) + 1;
            }
            // ⚠️ 只有显式打开 `quizZeroFillSkip` 才允许跳过。
            // 默认关：跳过是**不可见**的（用户只会看到"所有答题都废了"），
            // 而卡住至少看得见、能手动做。这条教训是 2026-11-10 用真实课程换来的。
            if (this._quizZeroFillRounds >= 3 && this.configs.quizZeroFillSkip === true) {
              this._quizZeroFillRounds = 0;
              this._quizZeroFillAt = 0;
              this._quizInProgress = false;
              this._quizAnswered = false;
              this._quizCurrentQuestions = null;
              this._quizReadyToSubmit = false;
              this._quizReadyWorkKey = '';
              this._setQuizForceSkip(90000, quizPaperKey);
              emitRuntimeLog('error', 'quiz skipped: no question could be filled', {
                total: questions.length,
                rounds: 3,
                hint: '这一卷的题一个都落不到页面上（选项认不出或点不上），先跳过去做后面的任务；只有这一卷暂停 90 秒，别的卷子照常'
              });
              this.nextUnit();
              return;
            }
          } else {
            this._quizZeroFillRounds = 0;
            this._quizZeroFillAt = 0;
          }

          // ⚠️ 这条必须节流：本函数被 OCS 循环**每秒**调一次，60 秒窗口内会打出
          // 60 条一模一样的 warn —— 实测把 200 条的日志缓冲整段刷满，
          // 真正有用的记录全被挤掉，排查时连"发生过什么"都看不到。
          if (!this._quizNoProgressLogAt || nowProgress - this._quizNoProgressLogAt > 10000) {
            this._quizNoProgressLogAt = nowProgress;
            emitRuntimeLog('warn', 'quiz round skipped: no progress', {
              filled: filledNow,
              total: questions.length,
              retryInMs: 60000 - sinceLast,
              hint: '同一份卷子这一轮不会拿到新答案，先不重问（省 token）；60 秒后照常重试（本条日志每 10 秒最多一条）'
            });
          }
          this._quizInProgress = false;
          return;
        }
        this._quizRoundFilledCount = filledNow;
        this._quizRoundNoProgressAt = nowProgress;
      }
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
      // ===== 多选**照旧问模型**（批次 7 改回来的）=====
      //
      // 这里原本有一趟"多选本地作答"，用来省 token。它的前提被现场推翻了：
      //   · 本地答案是猜的 —— 一份卷子里只要有多选，基本就过不了及格线（该方法自己的注释就这么写）；
      //   · 而 2026-11-10 真实日志里 `quiz submit attempt count {count:1,max:2}` ——
      //     **课后检测只给两次机会**。第一趟拿猜的答案去交，等于白白烧掉一次真提交；
      //     第二趟交回模型时，已经用过的那次提交并不能把正确率换回来。
      // 用户 2026-11-10 的原话：「只回答的多选题，估计是乱选的」——看到的就是这一趟。
      // 现在多选与其他题一样进 payload；本地猜测只剩一个身份：
      // 模型那一份**填不进 DOM** 之后的补填（见本文件稍后那一趟 `_answerLocalMultiChoiceQuestions(questions, quizDoc)`，
      // 它只在"模型答案落地后仍然空着"时才动手，并把这份卷子记进 `_quizLocalMultiplePapers`）。
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
        // （批次 7 之前还有第三种"整卷都是多选、已本地作答"—— 多选现在照旧问模型，那一支没了。）
        emitRuntimeLog('warn', 'quiz payload empty after cache filter', {
          total: questions.length,
          bestEffort: skippedBestEffort
        });
        if (skippedBestEffort > 0) {
          // 「不乱猜」闸（批次 121，档位口径见批次 123-b）：考试档思考**下限=高**的
          // 作业/考试卷，本地猜测是对这份明确意愿的违背 —— 宁可停在这里等人，
          // 也不拿猜测占位交卷。区间放开（off-high）**不算**这个意愿：那是给了余地，
          // 不是要求每次都花到最高。没有这道闸的话，下面三步补填会瞬间把猜测糊满整卷、直接交出去。
          if (this._isNoGuessPaper()) {
            this._quizInProgress = false;
            this._noteNoGuessPaperHold(quizDoc, questions);
            return;
          }
          this._fillBestEffortQuizAnswers(questions, quizDoc);
          // 这条分支**不会再发请求**（payload 为空），所以它是这一卷最后一次机会：
          // 还空着的题若不补占位，`rescueReady` 永远 false → 不发不交 → 整节原地转圈。
          this._fillBlankQuizQuestions(questions, quizDoc);
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
          // `paperKind` 只带一个信息：这一卷算考试还是测试。
          // 后台/内容侧看不见卷面标题，三个场景的区间必须由知道标题的这一侧报过去 ——
          // 少了它，考试卷会一路降级成"测试"档，用户给考试单独放开的那点上限就白设了。
          result = await bridgeSend('llm_request', {
            questions: payload, kind: 'paper', paperKind: this._paperTierFromTitle()
          });
        }
        if (!result || !result.success) {
          console.error('quiz llm request failed:', result && result.error ? result.error : 'unknown');
          this._quizInProgress = false;
          if (result && result.parseError) {
            // API 连接正常，仅答案解析失败：保留测验稍后重试，不标记连接失败
            emitRuntimeLog('warn', 'quiz llm parse failed, keep quiz for retry', {
              error: String(result.error || '').slice(0, 160),
              who: String(result.who || '(这一发没带渠道)').slice(0, 200)
            });
            this._setQuizForceSkip(8000);
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
              skipMs: PERMANENT_LLM_ERROR_SKIP_MS,
              who: String(result.who || '(这一发没带渠道)').slice(0, 200)
            });
            this._quizApiLastError = String(result.error || '').slice(0, 300);
            this._quizApiLastWho = String(result.who || '').slice(0, 200);
            this._setQuizForceSkip(PERMANENT_LLM_ERROR_SKIP_MS);
            return;
          }
          this._markQuizApiConnectionFailed(result && result.error ? result.error : 'LLM 请求失败', result && result.who);
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
        // 「不乱猜」闸（批次 121）：闸生效时不补任何本地猜测 —— 三步补填全跳过。
        // 模型把整卷答上了就照常提交（formReady 为真，与闸无关）；
        // 只有真缺题时才停下等人。下一拍只把还空着的题重新问模型（已答的不重问），
        // 空转有既有的 noop 轮次与换课预算兜底，日志由 _noteNoGuessPaperHold 每卷只说一次。
        var noGuessHold = this._isNoGuessPaper();
        // 补填"放弃折腾"的题：它们没进这次请求，表单缺了它们就永远不提交。
        // 放在清理之后是有意的：先让 `_clearKnownWrongFilledQuizAnswers` 处理其他题，
        // 再补上这些题的本地猜测，本轮就不会被它误清。
        if (!noGuessHold) this._fillBestEffortQuizAnswers(questions, quizDoc);
        // 多选**补填**（批次 7 之后本地答案只剩这一个身份）：它是**幂等**的 ——
        //   上面 `_fillAnswers` 已经填好的题在入口第一道判断上就返回了（不重填，
        //   复选重填会把自己切掉），只有仍然空着的才被补上。
        // 少了这一步就有个窄缝：模型给的多选组合恰好落在"已知错答"里（组合试完那一种），
        // 会被上面那步抹掉、又没有别的答案可补 → 表单缺一题 → 整卷永不提交。
        if (!noGuessHold) this._answerLocalMultiChoiceQuestions(questions, quizDoc);
        // 交卷前的最后一道占位（批次 16）：模型那一份被整批丢弃、多选也补不上的题，
        // 不再留白 —— 留白就是稳丢的分，而且表单不满这一卷永远交不出去。
        if (!noGuessHold) this._fillBlankQuizQuestions(questions, quizDoc);
        var formReady = this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true });
        console.log('[Omitone] quiz form ready:', formReady);
        this._quizAnswered = formReady;
        this._quizReadyToSubmit = formReady;
        this._quizReadyWorkKey = formReady ? this._getQuizWorkKey(quizDoc) : '';
        this._quizInProgress = false;
        if (formReady) {
          this._maybeSubmitQuiz(quizDoc, questions);
        } else if (noGuessHold) {
          this._noteNoGuessPaperHold(quizDoc, questions);
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
     * 「这些题分别落在**哪几个**文档里」—— 上面那个单数版的复数版，按文档去重。
     *
     * 为什么要单独有它（HIGH-2）：一份页面上的题**可能分属多个文档**
     * （外层 + 内层 `#frame_content`，甚至两个平级 iframe）。
     * 只探「第一个出题文档」会漏掉后面的那些 —— 而漏探的失败方向是
     * **把乱码题放行给模型**（不保守），正是乱码守卫要防的事。
     * 判"这份卷子读不读得"这类守卫一律用它逐个探：**宁可多探，不可漏探**。
     *
     * @param {Array} questions 抠出来的题（带 `_element`）
     * @returns {Array} 去重后的出题文档，按首次出现顺序
     */
    _getQuizDocumentsFromQuestions: function (questions) {
      var docs = [];
      if (!questions || !questions.length) return docs;
      for (var i = 0; i < questions.length; i++) {
        try {
          var el = questions[i] && questions[i]._element;
          var doc = el && el.ownerDocument;
          if (doc && docs.indexOf(doc) === -1) docs.push(doc);
        } catch (e) {}
      }
      return docs;
    },

    _looksLikeQuizTitle: function () {
      var title = this._getCurrentTitle();
      return title.indexOf('章节测验') !== -1 || title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1;
    },

    /**
     * 这一卷算「考试」还是「测试」。
     *
     * 口径与批次 121 的不乱猜闸**同一句**：标题含「作业」或「考试」才是考试档，
     * 章节测验算测试档（平时分小卷，卡住一卷等人的代价比猜错几道高）。
     * 页面把这一格判出来，是为了让 content.js 那一侧能按场景取区间 ——
     * 只有这里知道卷面标题，后台只看见 `kind:'paper'` 那一个字。
     */
    _paperTierFromTitle: function () {
      var title = this._getCurrentTitle();
      return title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1 ? 'exam' : 'quiz';
    },

    /**
     * 考试档这次允许的思考**下限**。
     *
     * ⚠️ 这段字符串解析在页面世界里**没有 libs/thinking.js 可用**（page.js 跑在页面主世界，
     *    思考真源注入在隔离世界），所以只能在这里重抄一小口 —— 但它是**有闸的**：
     *    集成 [10] 拿一张配置表把这句与 `THINKING.rangeForTier(cfg,'exam').min` 逐个对齐，
     *    两处口径分叉当场红（含**倒着写**、**单值**、**半截认不出**三种形状）。
     *    认不出的形状一律落 `off`（最省那一格），不猜。
     */
    _examThinkingMin: function () {
      var cfg = this.configs || {};
      // 与 libs/thinking.js 的 LEVELS **同一顺序**（越靠前越省），所以区间取小 = 取下限。
      var ORDER = ['off', 'low', 'high'];
      var stored = String(cfg.thinkingRangeExam == null ? '' : cfg.thinkingRangeExam).trim().toLowerCase();
      if (stored) {
        var parts = stored.split('-');
        var first = ORDER.indexOf(parts[0]);
        // 单值形状（'high'）＝上下限相等，与真源 parseRange 同一读法
        if (parts.length === 1) return first === -1 ? 'off' : ORDER[first];
        var second = parts.length === 2 ? ORDER.indexOf(parts[1]) : -1;
        // 任何一格认不出来都落最省，**不许拿另一格猜**（真源此时交 ok:false → off-off）
        if (first === -1 || second === -1) return 'off';
        return ORDER[Math.min(first, second)];
      }
      // 新键没写过 → 由改造前的那两个键推导（与 libs/thinking.js 的 legacyRange 同一口径）
      var paper = String(cfg.thinkingPaperLevel == null ? '' : cfg.thinkingPaperLevel).trim().toLowerCase();
      if (paper === 'off' || paper === 'low' || paper === 'high') return paper;
      var global = String(cfg.thinkingLevel == null ? '' : cfg.thinkingLevel).trim().toLowerCase();
      return global === 'low' || global === 'high' ? global : 'off';
    },

    /**
     * 「不乱猜」闸（批次 121）对这一卷是否生效 —— 两个条件同时成立：
     *   ① 卷面是「作业」或「考试」（`_paperTierFromTitle`，章节测验不拦）；
     *   ② 考试档思考区间的**下限**就是 'high'。
     *
     * 为什么只认下限：'high' 是用户明确说「这一卷值得花大钱慢慢想」，
     * 拿本地猜测把表单糊满直接交出去，违背的正是这份明确意愿。
     * 而 `off-high` 那种**放开上限**的区间不算 —— 那是"允许它想"，
     * 不是"要求它想"，为它把整卷停下等人的理由不成立。
     * 下限 off / low 保持原行为：猜测填满是既有兜底，改它等于把所有用户都架上"等人"。
     */
    _isNoGuessPaper: function () {
      if (this._paperTierFromTitle() !== 'exam') return false;
      return this._examThinkingMin() === 'high';
    },

    /**
     * 「不乱猜」闸拦下之后的那句话 —— 同一份卷子只说一次。
     * 不按 workKey 记账的话，学习循环每一拍都会撞进这条 hold，
     * 200 条日志环会被它冲成复读机，现场再也翻不出别的证据。
     */
    _noteNoGuessPaperHold: function (quizDoc, questions) {
      var key = '';
      try { key = this._getQuizWorkKey(quizDoc); } catch (eKey) {}
      this._noGuessPaperNotified = this._noGuessPaperNotified || Object.create(null);
      if (key && this._noGuessPaperNotified[key]) return;
      if (key) this._noGuessPaperNotified[key] = true;
      var unfilled = 0;
      for (var i = 0; i < (questions || []).length; i++) {
        try {
          if (!this._isQuizQuestionFilled(quizDoc, questions[i])) unfilled += 1;
        } catch (eFill) {
          unfilled += 1;
        }
      }
      emitRuntimeLog('warn', 'quiz hold, waiting for model or manual answer', {
        title: String(this._getCurrentTitle() || '').slice(0, 60),
        total: (questions || []).length,
        unfilled: unfilled,
        // 把"哪一格在拦"读回来：现场只看这句分不清是用户设了高、还是我们算错了档
        thinkingMin: this._examThinkingMin(),
        reason: '考试档思考下限=高，不拿猜测占位交卷；缺的题下一拍重问模型，或你手动作答后自动提交'
      });
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
     * 「这一份文档（含它的子帧）里到底还有没有没解开的密文」+「解密层给出的结论」。
     *
     * 一次遍历同时收四件事，省掉 `_handleQuiz` 里三回重复的全页扫描：
     *   secret   —— 还有带文字的 .font-cxsecret（=「还没解开」）
     *   miss     —— 这些文档里有 data-om-font-miss（表缺字形的实锤）
     *   terminal —— 这些文档里有 content.js 的**终局判据**（nodecl / nomap）：
     *               扫描确实跑到过这一份、并且明确说了"再等也不会好"。
     *               以前闸门只认 miss，于是「文档里根本没有字体声明」这一族
     *               每份卷子都要白等满 8 秒才继续（实测 2026-11-10：8.1s / 12.2s 各一次，
     *               而这两份卷子的题面其实是好的）—— 这就是用户看到的"卡住"。
     *   state    —— 各文档的结论拼起来，写进日志。`state:'(none)'` 直接说明
     *               content.js 那一次扫描**没跑到这一份文档**（不是"跑过但解不开"），
     *               这是"连解码都没有"这句话唯一能被证实的形式。
     *   sweepAgoMs —— 最近一次扫描距今多久；-1 = 这些文档上从来没有过扫描戳。
     *
     * @param {Document} [startDoc] 传了就只从这一份文档往下走（含它的子帧）；
     *   不传 = 全书扫描（没有 preferredDoc 时的旧语义）。
     */
    _probeFontDecrypt: function (startDoc) {
      var out = { secret: false, miss: false, terminal: false, state: '', sweepAgoMs: -1 };
      var freshest = -1;
      var addState = function (st) {
        if (!st || out.state.indexOf(st) !== -1) return;
        out.state = out.state ? out.state + ',' + st : st;
      };
      var probe = function (doc) {
        if (!doc || !doc.querySelector) return false;
        var hit = false;
        try {
          var nodes = doc.querySelectorAll('.font-cxsecret');
          for (var i = 0; i < nodes.length; i++) {
            if (textOf(nodes[i]).length > 0) { hit = true; break; }
          }
        } catch (e) { return false; }
        if (!hit) return false;      // 没有残留的文档，它的结论对这道闸门没有意义
        out.secret = true;
        var st = '';
        var sw = 0;
        try {
          var el = doc.documentElement;
          if (el && el.getAttribute) {
            st = el.getAttribute('data-om-font-state') || '';
            sw = Number(el.getAttribute('data-om-font-sweep') || 0) || 0;
            if (el.getAttribute('data-om-font-miss')) out.miss = true;
          }
        } catch (e2) {}
        if (st === 'nodecl' || st === 'nomap') out.terminal = true;
        addState(st || '(none)');
        if (sw > 0) {
          var ago = Date.now() - sw;
          if (freshest < 0 || ago < freshest) freshest = ago;
        }
        return false;                // 不提前退出：要把每一份出题文档的结论收齐
      };
      if (startDoc) this._walkDocuments(probe, startDoc); else this._walkDocuments(probe);
      out.sweepAgoMs = freshest;
      return out;
    },


    /**
     * 「解密未命中」标记（content.js 解密后写在 documentElement 上）探测。
     *
     * 这是乱码守卫的**主信号**：font-cxsecret 的真实机制是正常中文字符 + 自定义字形
     * （不是 PUA），表缺字形时文本通顺但内容错误 —— 只有解密层自己知道哪些字形没查到。
     *
     * @param {Document} [targetDoc] 传了就**只查这一个文档**。
     *   乱码计数必须走这条：`_walkDocuments` 扫全书时，任何一个不相干的帧带标记
     *   就会把**这一页每一份卷子**都判成乱码 —— 而缺标记的那个帧可能只是课程首页的
     *   一个装饰性子帧。一道坏字形能把整门课的卷子全数暂停，就是"所有题目都被跳过"
     *   的另一条路径（2026-11-10）。题目所在文档自己没带标记，就不算它乱码。
     *   不传 = 全书扫描（排查用的宽口径：「这一页上到底有没有出现过缺字形标记」）。
     *   ⚠️ 「等不等解密」已经不看这里了 —— 那一处走 `_probeFontDecrypt`，
     *   它把密文残留、缺字形标记和解密层的终局判据（nodecl / nomap）一次收齐。
     */
    _hasFontDecryptMiss: function (targetDoc) {
      var probe = function (doc) {
        if (!doc || !doc.documentElement || !doc.documentElement.getAttribute) return false;
        try {
          if (doc.documentElement.getAttribute('data-om-font-miss')) return true;
        } catch (e) {}
        return false;
      };
      if (targetDoc) return probe(targetDoc);
      var found = false;
      this._walkDocuments(function (doc) {
        if (!probe(doc)) return false;
        found = true;
        return true;
      });
      return found;
    },


    /**
     * 一段文字里 PUA 密文字符（U+E000~U+F8FF）的占比 —— **兜底层**。
     *
     * ⚠️ 认知修正（2026-10-31，同类开源实现交叉证实）：font-cxsecret 的真实机制是
     * 「正常中文字符 + 自定义字形」——文本里放的是普通中文，字形却画成别的字。
     * 所以表缺字形时题干是**通顺但错误**的中文，这个 PUA 检测实际上抓不到它；
     * 抓它靠上面的 `_hasFontDecryptMiss`（解密层标记）。本检测保留作兜底：
     * 防其他平台/未来改版真的把密文放进私有区。
     * 占比阈值 0.3：个别未知字形不应拦下整卷，成片密文才判定为乱码。
     */
    _quizTextGarbledRatio: function (text) {
      var meaningful = String(text || '').replace(/\s/g, '');
      if (!meaningful.length) return 0;
      var hits = meaningful.match(/[\uE000-\uF8FF]/g);
      return (hits ? hits.length : 0) / meaningful.length;
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
