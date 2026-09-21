/* ==========================================================================
 * Omitone page.js 片段 07/15 —— 任务点：执行与等待（含文档任务点）
 * 来源：原 page.js 中散布的 16 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 把识别出的任务点真正跑起来：视频 / 阅读 / PPT 音频 / OCS 式学习
 * 任务点等待与 pending 处理（等它加载完、等它出成绩）
 * 文档类任务点：翻页式 / 滚动式的推进与完成判定
 *
 * ⚠️ `_runPptAudioJob` 的逐页循环可能远超看门狗的 150 秒（每页还要等音频放完），
 *    所以每翻一页都调 `this._tickProgress(...)` 刷心跳。**别删这个心跳**（理由同上一条）。
 *
 * 本段的方法（16 个）：
 *   _clearDocumentPendingState、_runChaoxingJob、_runChaoxingReadJob、
 *   _runPptAudioJob、_runOcsStyleStudy、_shouldWaitForTaskDiscovery、
 *   _getTaskIdentity、_isTaskStillLoading、_handlePendingTask、_frameHasTaskPoint、
 *   _locateDocumentTask、_extractFrameKey、_isDocumentFrameFinished、
 *   _buildPagedDocumentTask、_buildScrollDocumentTask、_handleDocumentTask
 * ========================================================================== */
// @omitone-part-header-end

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
        // ⚠️ 心跳：整轮翻页可能远超看门狗的 150 秒（每页还要等音频放完）。
        //    不刷心跳会被误判成"卡死的 tick"，从而放锁并起第二个 tick 并行翻页。
        //    note 里带页号，日志节流后正好成了这个长任务耗时的观测点。
        this._tickProgress('ppt-audio page ' + (i + 1) + '/' + (slides || '?'));
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
