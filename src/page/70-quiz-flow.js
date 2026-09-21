/* ==========================================================================
 * Omitone page.js 片段 08/11 —— 答题：流程 / 状态 / 答案缓存 / 读图
 * 来源：原 page.js 中散布的 87 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 整卷流程：_handleQuiz、提交前后的监控、按提交次数跳过
 * 答案缓存：正确 / 错误 / 已提交答案的读写与规范化
 * 候选答案与组合排序、避开已知错答、尽力而为的填充
 * **读图（视觉）**：取图、描述、把结果并回题目、预算控制
 *
 * 本段的方法（87 个）：
 *   _isQuizResultCompletedPage、_shouldReleaseMediaPendingForCurrentCompletion、
 *   _isQuizResultPageFinished、_takeVisionBudget、_collectQuestionImages、
 *   _applyVisionToQuestions、_mergeVisionIntoTitle、_isTextOnly、_detectQuiz、
 *   _skipQuiz、_getQuizFieldValue、_getQuizWorkKey、_getQuizSubmitAttemptKey、
 *   _getQuizMaxSubmitAttempts、_getQuizApiUnavailableReason、_isRandomAnswerMode、
 *   _buildRandomQuizAnswers、_isQuizApiUnavailable、_resetQuizStateForSkip、
 *   _markQuizApiConnectionFailed、_skipQuizForApiUnavailable、
 *   _getQuizSubmitAttemptCount、_setQuizSubmitAttemptCount、
 *   _clearQuizSubmitAttemptCount、_incrementQuizSubmitAttemptCount、
 *   _shouldSkipQuizBySubmitAttempts、_isQuizForceSkipping、
 *   _forceSkipQuizAfterMaxAttempts、_loadQuizCorrectAnswerCache、
 *   _saveQuizCorrectAnswerCache、_findQuizAnswerInput、_getQuestionIdFromElement、
 *   _mapQuizTypeValue、_getQuestionTypeFromElement、_normalizeQuizTitleKey、
 *   _getQuizTitleKeyFromElement、_getQuizAnswerValue、_canonicalQuizAnswer、
 *   _getOptionStoredAnswerValue、_canonicalQuizAnswerForQuestion、
 *   _addWrongQuizAnswer、_removeWrongQuizAnswer、_isQuizQuestionMarkedCorrect、
 *   _extractDisplayedCorrectAnswer、_rememberCorrectQuizAnswers、
 *   _rememberWrongQuizAnswers、_getCachedQuizAnswer、_getKnownWrongQuizAnswers、
 *   _getConfirmedCachedQuizAnswer、_getQuizQuestionRuntimeKey、
 *   _markQuizQuestionAnsweredThisRun、_wasQuizQuestionAnsweredThisRun、
 *   _unmarkQuizQuestionAnsweredThisRun、_getSubmittedQuizAnswerForQuestion、
 *   _getLastSubmittedQuizAnswerForQuestion、_rememberSubmittedQuizAnswers、
 *   _areAllQuizQuestionsConfirmedCached、_getKnownWrongCanonicalSet、
 *   _getChoiceCandidateAnswers、_clearKnownWrongQuizAnswersForQuestion、
 *   _isQuizQuestionBestEffort、_fillBestEffortQuizAnswers、
 *   _sortMultiFallbackCombos、_chooseFallbackQuizAnswer、
 *   _getQuestionOptionLetters、_generateChoiceCombinations、
 *   _avoidKnownWrongAnswer、_fillCachedQuizAnswers、_dispatchQuizInputEvents、
 *   _clearQuizQuestionAnswer、_clearUnconfirmedQuizAnswers、
 *   _findVisibleQuizRedoDialog、_isQuizRedoRequired、_prepareQuizRedoIfNeeded、
 *   _isQuizPassedOrFinished、_hasActiveQuizSubmitForm、_markQuizSubmitPending、
 *   _isQuizAnswersCleared、_installSubmitSniffer、_monitorQuizSubmit、
 *   _shouldHoldQuizBeforeNext、_isQuizLearningPending、_handleQuiz、
 *   _extractQuestions、_getQuizDocumentFromQuestions、_looksLikeQuizTitle、
 *   _extractFromDocument
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
