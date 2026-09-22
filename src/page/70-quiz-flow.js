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
 * 重做（redo）弹窗的处理
 *
 * 本段的方法（46 个）：
 *   _isQuizResultCompletedPage、_shouldReleaseMediaPendingForCurrentCompletion、
 *   _isQuizResultPageFinished、_detectQuiz、_skipQuiz、_getQuizFieldValue、
 *   _getQuizWorkKey、_syncQuizPaperRunState、_getQuizPaperKeyFromJob、
 *   _getQuizPaperKeyFromTask、_getQuizSubmitAttemptKey、
 *   _getQuizMaxSubmitAttempts、
 *   _getQuizApiUnavailableReason、_isRandomAnswerMode、_buildRandomQuizAnswers、
 *   _isQuizApiUnavailable、_resetQuizStateForSkip、_markQuizApiConnectionFailed、
 *   _skipQuizForApiUnavailable、_getQuizSubmitAttemptCount、
 *   _setQuizSubmitAttemptCount、_clearQuizSubmitAttemptCount、
 *   _incrementQuizSubmitAttemptCount、_shouldSkipQuizBySubmitAttempts、
 *   _isQuizForceSkipping、_forceSkipQuizAfterMaxAttempts、
 *   _getQuizQuestionRuntimeKey、_markQuizQuestionAnsweredThisRun、
 *   _wasQuizQuestionAnsweredThisRun、_unmarkQuizQuestionAnsweredThisRun、
 *   _isQuizPassedOrFinished、_hasActiveQuizSubmitForm、_markQuizSubmitPending、
 *   _isQuizAnswersCleared、_installSubmitSniffer、_monitorQuizSubmit、
 *   _shouldHoldQuizBeforeNext、_isQuizLearningPending、_handleQuiz、
 *   _extractQuestions、_getQuizDocumentFromQuestions、_looksLikeQuizTitle、
 *   _extractFromDocument、_findVisibleQuizRedoDialog、_isQuizRedoRequired、
 *   _prepareQuizRedoIfNeeded
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
