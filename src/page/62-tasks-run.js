/* ==========================================================================
 * Omitone page.js 片段 07/15 —— 任务点：执行与等待（含文档任务点）
 * 来源：原 page.js 中散布的 16 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 把识别出的任务点真正跑起来：视频 / 阅读 / PPT 音频 / 投票 / OCS 式学习
 * 任务点等待与 pending 处理（等它加载完、等它出成绩）
 * 文档类任务点：翻页式 / 滚动式的推进与完成判定
 *
 * ⚠️ `_runPptAudioJob` 的逐页循环可能远超看门狗的 150 秒（每页还要等音频放完），
 *    所以每翻一页都调 `this._tickProgress(...)` 刷心跳。**别删这个心跳**（理由同上一条）。
 *    `_runChaoxingVoteJob` 的两段等待同样带心跳与超时。
 *
 * 本段的方法（33 个）：
 *   _clearDocumentPendingState、_runChaoxingJob、_runChaoxingReadJob、
 *   _runPptAudioJob、_tryAdvanceIdleSection、_runOcsStyleStudy、_shouldWaitForTaskDiscovery、
 *   _getTaskIdentity、_isTaskStillLoading、_handlePendingTask、_frameHasTaskPoint、
 *   _locateDocumentTask、_extractFrameKey、_isDocumentFrameFinished、
 *   _buildAriaPagedDocumentTask、
 *   _buildPagedDocumentTask、_buildScrollDocumentTask、_handleDocumentTask、
 *   _runChaoxingVoteJob、_openVoteOverlay、_voteOverlayDocReady、_voteOverlayHasContent、
 *   _voteOverlayForm、_voteOverlayText、_pickVoteOptions、_waitVoteBoxFinished、
 *   _voteBoxFinished、
 *   _dismissVoteDialog、_closeVoteOverlay、_voteTryKeyOf、_noteVoteTry、
 *   _clearVoteTry、_voteTryCooledDown
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
        // ⚠️ 先把"在答哪一份卷子"切过去。同一张学习卡片里挂着两份试卷时，
        //    交完第一份 `_quizAnswered` 会一直为 true，而下面几行都吃这个标志 ——
        //    不切的话第二份会被当成"已经答过了"直接跳过（实测症状）。
        this._syncQuizPaperRunState(this._getQuizPaperKeyFromJob(job), job.doc || null);
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

      if (job.kind === 'vote') {
        return this._runChaoxingVoteJob(job);
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

    /**
     * 空转逃生：这一节确实没有可做的任务时，把页面往前推一步，而不是原地刷日志。
     *
     * 现场（2026-11-10 日志，整整 14 分钟）：交完卷、点掉平台弹的「下一节」之后，
     * 日志每 6 秒一条 `study no runnable job {attachments:0,searchedCount:0}`，
     * 页面一直停在原来那张卡片上，直到重启页面才继续 —— 而重启后第一件事就是
     * `switch learning card before next unit`，说明**本该走的就是这一步**。
     *
     * 为什么原来的兜底接不住：`_skipIfCompleted()` 要能判出"这一节完成了"
     * （附件 0、任务帧 0、目录里也没有已完成标记时它判不出），而下面
     * `_ocsSearchedJobs.length > 0` 那一段只覆盖"搜到过任务点"的页面。
     * 两边都不管"空页面"，于是页面永远停在那里。
     *
     * 判据（全部成立才动，宁可多等也不误跳）：
     *   - 平台附件数为 0，且**一个可见任务帧都没有**（真没活干）
     *   - 主文档加载完成（判据只有 `readyState === 'complete'` 一条：这里用的是**外层页**，
     *     它永远带着导航与目录，正文长度判不出「还在渲染」，原先那条「正文不是空壳」
     *     的长度守卫已经把整道逃生门锁死过，删得对；渲染没完成由 readyState 兜住）
     *   - 没有在答的卷子、没有在等结果的任务点
     *   - 已经连续空了 30 秒
     *   - 同一个「学习进度键」只推一次：点了页面没动就停手，不连点（连点是刷课插件的经典事故）
     *
     * @returns {boolean} true = 已经处理（调用方直接 return），false = 继续正常流程
     */
    _tryAdvanceIdleSection: function (attachments) {
      if (attachments && attachments.length) {
        this._idleEmptySince = 0;
        return false;
      }
      var frames = [];
      try { frames = this._collectVisibleTaskFrames() || []; } catch (eFrames) { return false; }
      if (frames.length) {
        this._idleEmptySince = 0;
        return false;
      }
      if (this._isQuizLearningPending(null) || this._isActiveStudyJobPending('idle-section')) {
        this._idleEmptySince = 0;
        return false;
      }
      // 页面里还在放的视频，绝不算"空" —— 平台偶尔会先渲染内容、后出附件列表。
      // ⚠️ 这里**故意不用 `_detectQuiz()`**：交完卷之后标题还是「章节测验」、地址还带着
      //    `api/work`，它会一直返回 true —— 那正是本节要修的那个场景，用它当护栏
      //    等于把逃生门从里面锁上。题目这一侧由 `_collectVisibleTaskFrames()`（任务帧）
      //    与 `_isQuizLearningPending()`（待答/待交）两道判据守着。
      try {
        var idleVideo = this._getVideoEl();
        if (idleVideo && idleVideo.isConnected !== false && !idleVideo.ended) {
          this._idleEmptySince = 0;
          return false;
        }
      } catch (eVideo) { return false; }

      // ⚠️ 这里必须退到**外层页**，不能只看主帧。
      //   `_tryAdvanceIdleSection` 唯一的调用点（本文件 `_runOcsStyleStudy`）只在
      //   `_ensureOcsStudyRunner()` 返回 false 时才会被走到，而那只发生在
      //   「没有 #iframe」或「主帧跨域读不到」两种情况下 —— 这两种情况下
      //   `_getMainDocument()` **必然是 null**，写成 `var doc = this._getMainDocument()`
      //   就等于 `return false`，整道逃生门是死的（2026-11-10 那个 14 分钟卡死会原样复现）。
      // 空转判定本来就该问"外层页渲染完了没有"。
      var doc = this._getMainDocument() || document;
      if (!doc || !doc.body || String(doc.readyState || '') !== 'complete') return false;

      // ⚠️ 批次 20-I：**这页压根不是刷课页时，一步都不许推。**
      // 现场那条链（2026-11-10 19:12:18 之后）：`skip completed` → `_dismissPopups()` 误点了
      // 常驻的「下一节」→ 页面被带去 `https://i.chaoxing.com/base?…`，那里没有课程结构，
      // 而这条逃生门照样往下走：附件 0、任务帧 0、没视频、readyState complete →
      // 30 秒后拿 `location.href + 标题` 当键**又点一次**，然后在陌生页面上 `study stuck`。
      // 后果不是"白点一下"，是**学习进度停在原地而日志看着像在推进**。
      // 这道门只挡"整页连一个课程标记都认不出"的形状，正常刷课页 / OCS 页都有其中一样，
      // 挡不住它们；被挡下时**一定出日志**，不静默。
      var looksLikeCourse = false;
      try {
        looksLikeCourse = !!(doc.querySelector('.ans-attach-ct, .ans-job-icon, [id^="cur"], .posCatalog_select, .prev_title') ||
          document.querySelector('.ans-attach-ct, .ans-job-icon, [id^="cur"], .posCatalog_select, .prev_title'));
      } catch (eShape) { looksLikeCourse = true; }   // 读不动就当"像"，不许在这里静默跳走
      if (!looksLikeCourse) {
        var declineNow = Date.now();
        if (!this._idleDeclineLogAt || declineNow - this._idleDeclineLogAt >= 120000) {
          this._idleDeclineLogAt = declineNow;
          emitRuntimeLog('warn', 'study idle declined: 这一页认不出课程结构，不点前进', {
            href: String(location.href || '').slice(0, 110),
            everyMs: 120000,
            hint: '页面被推到了没有课程目录/任务点的地方（刷课页之外的地址）。' +
              '这里不点「下一节」，是因为在陌生页面上点它只会把进度越带越偏 —— 请手动回到章节页'
          });
        }
        this._idleEmptySince = 0;
        return true;
      }

      var now = Date.now();
      if (!this._idleEmptySince) {
        this._idleEmptySince = now;
        return false;
      }
      var idleMs = scaledMs(30000);
      if (now - this._idleEmptySince < idleMs) return false;

      // 进度键：章节 + 当前卡片 + 附件指纹。拿不到时退回地址 + 标题，
      // 保证"每次都会有一个键"，否则空串会让下面的去重失效、变成每 30 秒点一次。
      var key = '';
      try { key = String(this._studyProgressKey() || ''); } catch (eKey) {}
      if (!key) key = String(location.href || '') + '|' + String(this._getCurrentTitle() || '');

      if (key === this._idleAdvanceKey) {
        // 上一次已经推过了、页面还是原样：不再点，但**不能只说一次**。
        // 现场（2026-11-10 19:13:23）这里打了一条就永久静默，而后面只剩
        // `search job: no attachments and no synthetic job` 每分钟一条 —— 用户分不清
        // "还在慢慢跑"和"一步都没动"。静默空转是最糟的结局。
        // 现在每 2 分钟重播一次，并把**当前地址**带上：那条键尾巴上的 `||` 加上
        // `https://i.chaoxing.com/base?…` 直接说明"页面被推到没有课程结构的地方了"。
        var stuckNow = Date.now();
        if (this._idleStuckLoggedKey !== key || stuckNow - (this._idleStuckLoggedAt || 0) >= 120000) {
          this._idleStuckLoggedKey = key;
          this._idleStuckLoggedAt = stuckNow;
          emitRuntimeLog('error', 'study stuck: 本节没有可识别的任务，点了前进也没反应', {
            title: String(this._getCurrentTitle() || '').slice(0, 40),
            key: key.slice(0, 80),
            href: String(location.href || '').slice(0, 120),
            everyMs: 120000,
            hint: '这一页已经推过前进、仍认不出任务点，插件停在这里不再乱点 —— 每 2 分钟重复一次，这条日志还在动说明还在等，不是跑了'
          });
        }
        return true;
      }
      this._idleAdvanceKey = key;
      this._idleEmptySince = 0;

      emitRuntimeLog('warn', 'study idle: no task in this section, advance', {
        idleMs: idleMs,
        title: String(this._getCurrentTitle() || '').slice(0, 40)
      });
      if (!this.configs.autoNext) return true;
      if (this._switchToNextLearningCard('idle-section')) return true;
      this.nextUnit();
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
        // 窗口口径与 `_ensureOcsStudyRunner` 共用 `_taskDiscoveryWindowMs`（0 个附件给满窗，
        // 不是给最短）—— 两份公式各写一处，早晚会漂回「读 0 就 3 秒断定没活干」。
        var waitTimeout = this._taskDiscoveryWindowMs(attachments.length || 0);
        this._ocsSearchDeadline = now + waitTimeout;
        emitRuntimeLog('info', 'study begin', { attachments: attachments.length, runner: 'style' });
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
          // ⚠️ 讨论任务点不建 job，`searchedCount` 数不到它（批次 20-D，与 60 片段同一判据）。
          // 这一支翻的是「这一页的 job 都跑完了」，而讨论还在等 tick 链去开回帖页。
          var discHoldStyle = this._shouldHoldDiscussionBeforeFinish();
          if (discHoldStyle.hold) {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold discussion before next unit', {
              searchedCount: this._ocsSearchedJobs.length,
              pending: discHoldStyle.pending,
              total: discHoldStyle.total,
              reason: discHoldStyle.reason,
              heldMs: discHoldStyle.heldMs,
              budgetMs: discHoldStyle.budgetMs
            });
            return true;
          }
          if (discHoldStyle.pending > 0) {
            emitRuntimeLog('warn', 'study discussion hold spent, advance anyway', {
              searchedCount: this._ocsSearchedJobs.length,
              pending: discHoldStyle.pending,
              total: discHoldStyle.total,
              reason: discHoldStyle.reason,
              spent: discHoldStyle.spent,
              runner: 'style'
            });
          }
          emitRuntimeLog('info', 'study next unit', { searchedCount: this._ocsSearchedJobs.length });
          if (this.configs.autoNext) {
            this.nextUnit();
          }
          return true;
        }
        return true;
      }

      // 空页面逃生：真的没活干就往前走一步。没有这一条，日志里就是
      // 「study no runnable job」每 5 秒一条、连刷 14 分钟（见 _tryAdvanceIdleSection 的说明）。
      if (this._tryAdvanceIdleSection(attachments)) return true;

      // 节流从 5 秒放宽到 20 秒：200 条环形缓冲经不起一条 warn 每 5 秒刷一次，
      // 真错误会被冲走（这次日志里 40 条是同一句话）。
      if (!this._ocsLastNoJobLogAt || now - this._ocsLastNoJobLogAt > 20000) {
        this._ocsLastNoJobLogAt = now;
        emitRuntimeLog('warn', 'study no runnable job', { attachments: attachments.length, searchedCount: this._ocsSearchedJobs.length });
      }
      return false;
    },

    _shouldWaitForTaskDiscovery: function (reason) {
      var now = Date.now();
      if (!this._taskDiscoverStartedAt) this._taskDiscoverStartedAt = now;
      var graceMs = scaledMs(Number(this.configs.taskDiscoverGraceMs || 8000));
      if (graceMs <= 0) return false;

      var doc = this._getMainDocument();
      var bodyText = '';
      try {
        bodyText = doc && doc.body ? textOf(doc.body) : '';
      } catch (e) {}

      // 刚切过章节时「附件数为 0」不等于这一章没任务：轻薄本上平台异步渲染
      // 要好几秒，原来的判据会立刻放行 → nextUnit 推过去 → 后面的题全不做。
      // 只在「刚切换」这个窗口内等附件，普通空章节仍按原逻辑快速跳过。
      var hasAttachments = false;
      try { hasAttachments = this._getChaoxingAttachments().length > 0; } catch (eAttach) {}
      var recentlySwitched = !!this._stepSwitchPending ||
        !!(this._stepSwitchAt && now - this._stepSwitchAt < graceMs);

      var shouldHold = !doc ||
        !!(doc && doc.readyState && doc.readyState !== 'complete') ||
        bodyText.length < 20 ||
        (recentlySwitched && !hasAttachments) ||
        this._hasTaskPoint();

      if (!shouldHold) return false;
      if (now - this._taskDiscoverStartedAt < graceMs) {
        this._logTaskWait((reason || 'discovery') + ' ' + (now - this._taskDiscoverStartedAt) + '/' + graceMs + 'ms' +
          ' factor=' + perfFactor() + ' attachments=' + (hasAttachments ? 'yes' : 'no'), now);
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
          if (!task.doc.querySelector('video, audio, .ans-insertvideo-online, .fileBox, .pageNum, ' + this._quizContainerSelector + ', [qid], [role="radio"], [role="checkbox"]')) {
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

      var graceMs = scaledMs(Number(this.configs.taskPendingGraceMs || 7000));
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
          // 原生 PDF.js / aria 页码文档（真实平台结构，2026-10-31 从同类开源实现补入）：
          // 计数器 #pageNumber / input[aria-label="页码"]，下一页 #next / button[aria-label="下一页"]。
          // 与 #panView（超星私有查看器）是两族 —— 此前这一族零覆盖，
          // 文档只能靠滚动兜底慢慢磨、翻页完成判定也接不上。
          if (doc.querySelector('#pageNumber, input[aria-label="页码"], input[aria-label="Page"]') &&
              doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]')) {
            return worthHandling(doc) ? self._buildAriaPagedDocumentTask(doc) : null;
          }
        } catch (e) {}
        return null;
      }

      if (preferredDoc) {
        var preferredTask = buildTask(preferredDoc);
        if (preferredTask) return preferredTask;
      }

      // ⚠️ 批次 55-B：`{query:true}` = **我只是来问一句**，不是来判决"这一节有没有活干"的。
      // 这一路每一拍都会被 `_isTextOnly()` 走到，以前它替调度器打了一整条 warn 链
      // （现场量到一节 896 秒里 62 条、占 200 条日志环的 31%，而那时候视频正在正常播）。
      // "确实没活干"由 `_runOcsStudyStyleLoop` 尾部的 `study no runnable job` 说，那才是决策点。
      var chaoxingJob = this._searchChaoxingJob(null, { query: true });
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

    /**
     * 原生 PDF.js / aria 页码文档任务（真实平台结构，2026-10-31 从同类开源实现补入）。
     *
     * 结构：页码计数器 `#pageNumber` / `input[aria-label="页码"]`（PDF.js 标准，
     * 总页数在 `#numPages`），翻页按钮 `#next` / `button[aria-label="下一页"]`、
     * `#lastPage` / `button[aria-label="末页"]`。
     *
     * 完成语义与滚动任务一致：翻到末页（atEnd）≠ 完成，等平台自己的完成标记
     * （finishFlag / 帧完成标记）；迟迟不来由 documentSkipTimeoutMs 兜底跳过。
     */
    _buildAriaPagedDocumentTask: function (doc) {
      var counter = doc.querySelector('#pageNumber, input[aria-label="页码"], input[aria-label="Page"]');
      var nextBtn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
      if (!counter && !nextBtn) return null;

      var numPagesEl = doc.querySelector('#numPages');
      var total = 0;
      try {
        total = parseInt(numPagesEl && numPagesEl.textContent, 10) ||
          parseInt(counter && counter.getAttribute && (counter.getAttribute('max') || counter.getAttribute('aria-valuemax')), 10) || 0;
      } catch (e) {}
      if (!(total > 0)) total = 0; // 未知总页数：靠「下一页禁用」判定到尾

      var self = this;
      function readPage() {
        try {
          var v = parseInt(counter && counter.value, 10);
          if (v > 0) return v;
          var cur = doc.querySelector('[data-slide-current]');
          v = parseInt(cur && (cur.getAttribute('data-slide-current') || cur.textContent), 10);
          return v > 0 ? v : 1;
        } catch (e) { return 1; }
      }
      function nextDisabled() {
        try {
          var btn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
          if (!btn) return true;
          return btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true';
        } catch (e) { return false; }
      }

      return {
        key: self._extractFrameKey(doc, 'aria-paged-doc'),
        finished: !!(doc.defaultView && doc.defaultView.finishFlag) || self._isDocumentFrameFinished(doc),
        currentPage: readPage(),
        totalPages: total,
        atEnd: nextDisabled() || (total > 0 && readPage() >= total),
        scrollStep: function () {
          try {
            var btn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
            if (!btn || btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true') return false;
            btn.click();
            return true;
          } catch (e) { return false; }
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

    /**
     * 投票任务点（附件 `module:"insertvote"` + `type:"vote"`）。
     *
     * ⚠️ 只能走平台自己的那一次点击。封面帧 `ananas/modules/zt/vote/index-pc-new.html`
     * 的内联脚本会现算出 `mooc-ans/api/work?...&type=vote&ktoken=…&enc=…`，把它写进
     * **顶层文档**的 `#voteIframe` 并 show `.voteContainer`（2026-11-11 真页实测）。
     * 直接访问那个地址是 403 —— enc 是服务端按 jobid 算的，抄不来也不该抄。
     *
     * 所以这里做的就是把用户那几下点出来：点封面 → 等覆盖层长出选项 →
     * 每组（按 input[name] 分）勾第一项 → 点提交 → 等平台把任务盒翻成
     * `ans-job-finished`（就是「下一节」放不放行那条判据，与 20-G 同源）。
     * 投票不计分，随手投一项就是完成任务点的全部要求。
     *
     * 每一步都可超时、都留证据；连续 VOTE_MAX_TRIES 次没翻旗就进 VOTE_COOLDOWN_MS
     * 冷却（到期自动再试，是"能解释、可恢复"的出口，不是永久跳过），
     * 免得把同一个投票的提交打成刷屏。
     */
    _runChaoxingVoteJob: async function (job) {
      if (!job) return false;
      // 与准入闸同一句写法：`=== false` 才是"用户关了"，
      // 老配置里**没有这一项**（undefined）必须照常投。
      if (this.configs.enableVote === false) {
        emitRuntimeLog('info', 'vote disabled, skip', { jobid: job.jobid, name: job.name });
        return true;
      }

      var boxBefore = this._voteBoxFinished(job);
      if (boxBefore === true) {
        emitRuntimeLog('info', 'vote already finished', { jobid: job.jobid, by: 'box-flag' });
        return true;
      }

      var cooled = this._voteTryCooledDown(job);
      if (cooled) {
        emitRuntimeLog('warn', 'vote cooling down', {
          jobid: job.jobid, tries: cooled.tries, retryInMs: cooled.retryInMs, last: cooled.last
        });
        return true;
      }

      var voteDoc = await this._openVoteOverlay(job);
      if (!voteDoc) {
        this._noteVoteTry(job, 'overlay');
        emitRuntimeLog('warn', 'vote overlay not ready', {
          jobid: job.jobid, hasCoverFrame: !!job.frame, hasCoverDoc: !!job.doc
        });
        return true;
      }

      var form = this._voteOverlayForm(voteDoc);
      if (!form.firsts.length && !form.submit) {
        // 覆盖层里既没有选项也没有提交键：多半是「已参与」或压根没有这道投票
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-form');
        emitRuntimeLog('warn', 'vote has nothing to submit', { jobid: job.jobid, text: form.text });
        return true;
      }

      var picked = this._pickVoteOptions(form);
      if (!picked.checked) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-check');
        emitRuntimeLog('warn', 'vote option not selectable', {
          jobid: job.jobid, groups: picked.groups, inputs: form.inputCount
        });
        return true;
      }

      if (!form.submit) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-submit');
        emitRuntimeLog('warn', 'vote submit button missing', {
          jobid: job.jobid, picked: picked.values.join(','), text: form.text
        });
        return true;
      }
      try {
        form.submit.click();
      } catch (eClick) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'submit-throw');
        emitRuntimeLog('warn', 'vote submit click threw', { jobid: job.jobid, err: String(eClick && eClick.message || eClick).slice(0, 60) });
        return true;
      }

      var wait = await this._waitVoteBoxFinished(job, voteDoc);
      var boxAfter = this._voteBoxFinished(job);
      var ok = wait.by === 'box' || boxAfter === true;
      this._closeVoteOverlay(voteDoc);
      emitRuntimeLog(ok ? 'info' : 'warn', ok ? 'vote submitted' : 'vote submitted but box not finished', {
        jobid: job.jobid, picked: picked.values.join(','), groups: picked.checked,
        submitBy: form.submitBy, by: wait.by, waitedMs: wait.waitedMs, dismissed: wait.dismissed,
        boxBefore: boxBefore, boxAfter: boxAfter
      });
      if (ok) this._clearVoteTry(job); else this._noteVoteTry(job, 'not-finished');
      return true;
    },

    /**
     * 展开投票覆盖层并拿到它的文档；拿不到返回 null。
     *
     * 已经在顶层展开且就是这一份投票 → 直接复用，不再重复点封面。
     */
    _openVoteOverlay: async function (job) {
      var jobid = String(job && job.jobid || '');
      var ready = this._voteOverlayDocReady(jobid);
      if (ready) return ready;

      var cover = null;
      try {
        var d = job && job.doc;
        if (d) {
          cover = d.querySelector('#render') || d.querySelector('#cover') ||
            d.querySelector('.ans-cmp-icon') || d.querySelector('.ans-attach-cmp');
        }
      } catch (eFind) {}
      if (!cover) return null;
      try {
        cover.click();
      } catch (eClick) {
        return null;
      }

      var deadline = Date.now() + VOTE_OVERLAY_WAIT_MS;
      var waited = 0;
      while (Date.now() < deadline) {
        var doc = this._voteOverlayDocReady(jobid);
        if (doc) {
          this._tickProgress('vote overlay');
          return doc;
        }
        await sleep(500);
        waited += 500;
      }
      emitRuntimeLog('debug', 'vote overlay wait exhausted', { jobid: jobid, waitedMs: waited });
      return null;
    },

    /**
     * 顶层那份投票覆盖层现在能不能读。
     *
     * 四个条件缺一不可：`#voteIframe` 在、`.voteContainer` **可见**、文档已开出来、
     * **body 里真有字**。
     *
     * 可见这条不是洁癖 —— 收起状态里所有 `offsetParent` 都是 null，
     * 于是选项与提交键会一起被读成"不存在"，然后每轮都白点一次封面。
     *
     * 「有字」这条是 2026-11-11 真页实测补的：平台把 `#voteIframe` 的 src 写进顶层
     * 之后还要一段时间才把卷子填进去。上一轮这里只看到"框架在、可见、文档开着"
     * 就当就绪直接复用，跳过了点封面，于是
     * `vote has nothing to submit {"jobid":"9000000000000001","text":""}` ——
     * 正文明明是空的。空档期算"没就绪"，让上面那个轮询继续等／再点一次封面，
     * 比拿一份空卷子去判"这道题没得提交"准得多。
     */
    _voteOverlayDocReady: function (jobid) {
      var frame = null;
      try { frame = document.getElementById('voteIframe'); } catch (e0) { return null; }
      if (!frame) return null;
      try {
        var container = document.querySelector('.voteContainer');
        if (container && !container.offsetParent) {
          var display = '';
          try { display = String(window.getComputedStyle(container).display || ''); } catch (eCs) { display = ''; }
          if (display === 'none') return null;
        }
      } catch (e1) {}
      var doc = null;
      try { doc = frame.contentDocument; } catch (eCross) { return null; }
      if (!doc || !doc.body) return null;
      if (String(doc.readyState || '') === 'loading') return null;
      if (jobid && String(frame.src || '').indexOf(jobid) < 0) return null;
      if (!this._voteOverlayHasContent(doc)) return null;
      return doc;
    },

    /**
     * 投票覆盖层里是不是真写出了东西。
     *
     * 判据用"文字或选项任一存在"，不用"文字够长"：有些投票只有图标和两个
     * radio，正文文字短；反过来一份刚开出来的空文档两者都没有。
     */
    _voteOverlayHasContent: function (doc) {
      try {
        var text = '';
        try { text = String(doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ''); } catch (eTxt) { text = ''; }
        if (text.length > 0) return true;
        return !!(doc.querySelector && doc.querySelector(
          '.topic-option-list, .topic-options, input[type=radio], input[type=checkbox]'
        ));
      } catch (e) {
        return false;
      }
    },

    /**
     * 投票覆盖层的一份快照：选项按 name 分组取第一项、提交键、正文摘要。
     *
     * 选项只认两种形状（真页实测：`input[name=answer8000083064]` +
     * `.topic-option-list` 里一个 radio），别的 input 一律不当选项 ——
     * 覆盖层里还挂着「本地上传 / 从云盘选择」那些隐藏弹窗，里面也有 input。
     */
    _voteOverlayForm: function (voteDoc) {
      var out = { firsts: [], inputs: [], inputCount: 0, submit: null, submitBy: '', text: '' };
      var self = this;
      var all = [];
      try { all = [].slice.call(voteDoc.querySelectorAll('input[type=radio], input[type=checkbox]')); } catch (e0) {}
      out.inputs = all.filter(function (i) {
        if (!i || i.disabled) return false;
        var inTopic = false;
        try { inTopic = !!(i.closest && i.closest('.topic-option-list, .topic-options, .ans-qt-list')); } catch (e1) { inTopic = false; }
        return inTopic || /^answer/i.test(String(i.name || ''));
      });
      out.inputCount = out.inputs.length;
      var seen = {};
      out.inputs.forEach(function (i) {
        var key = String(i.name || i.type || 'q');
        if (seen[key]) return;
        seen[key] = true;
        out.firsts.push(i);
      });
      try {
        var cands = [].slice.call(voteDoc.querySelectorAll('a.btn-submit, a.jb_btn_92, button, a, input[type=button], input[type=submit]'));
        for (var c = 0; c < cands.length; c++) {
          var el = cands[c];
          var label = String((el.innerText || el.textContent || el.value) || '').replace(/\s+/g, '').slice(0, 12);
          var isSubmitClass = false;
          try { isSubmitClass = /btn-submit/.test(String(el.className || '')); } catch (e2) { isSubmitClass = false; }
          if (!isSubmitClass && !/^(提交|确定|投票|立即投票)$/.test(label)) continue;
          if (/^(取消|返回|关闭)$/.test(label)) continue;
          out.submit = el;
          out.submitBy = isSubmitClass ? 'class' : 'text';
          break;
        }
      } catch (e3) {}
      out.text = self._voteOverlayText(voteDoc);
      return out;
    },

    _voteOverlayText: function (voteDoc) {
      try {
        return String((voteDoc.body && (voteDoc.body.innerText || voteDoc.body.textContent)) || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch (e) {
        return '';
      }
    },

    /**
     * 每组勾第一项，勾完**读回 checked** 才算数。
     *
     * 「勾选证据」这条不是多余：真页实测 `.click()` 之后 `checked` 由 false 变 true，
     * 而沙盒里出过"根本没选就交上去"的症状（批次 19-A 记的那件事）。
     * 读不回来就当作没投出去，交给上层重试，绝不报"提交成功"。
     */
    _pickVoteOptions: function (form) {
      var values = [];
      var checked = 0;
      (form.firsts || []).forEach(function (input) {
        try { input.click(); } catch (eClick) {}
        if (!input.checked) {
          try { input.checked = true; } catch (eSet) {}
        }
        if (input.checked) {
          checked++;
          values.push(String(input.value || input.name || '').slice(0, 16));
        }
      });
      return { groups: (form.firsts || []).length, checked: checked, values: values };
    },

    _waitVoteBoxFinished: async function (job, voteDoc) {
      var deadline = Date.now() + VOTE_BOX_WAIT_MS;
      var waited = 0;
      var dismissed = 0;
      while (Date.now() < deadline) {
        if (this._voteBoxFinished(job) === true) return { by: 'box', waitedMs: waited, dismissed: dismissed };
        if (this._dismissVoteDialog(voteDoc)) dismissed++;
        await sleep(600);
        waited += 600;
        this._tickProgress('vote wait box');
      }
      return { by: 'timeout', waitedMs: waited, dismissed: dismissed };
    },

    /**
     * 「这个投票做完了没有」= 它所在任务盒带不带 `ans-job-finished`。
     *
     * 复用 20-G 那份判据（`_discussionBoxFinishedFlag`），不再抄第二份 ——
     * 平台「下一节」放不放行用的就是这条，图标 aria-label 是滞后的、不可信。
     * 返回 null = 读不到盒子（跨域 / 结构不同），调用方按"没确认"处理。
     */
    _voteBoxFinished: function (job) {
      try {
        var node = job && job.frame ? job.frame : null;
        if (!node && job && job.doc) {
          var w = null;
          try { w = job.doc.defaultView; } catch (eWin) { w = null; }
          try { node = w && w.frameElement; } catch (eFe) { node = null; }
        }
        return this._discussionBoxFinishedFlag(node);
      } catch (e) {
        return null;
      }
    },

    /**
     * 提交后可能弹出「已到截止时间，作答内容已自动提交」这类提示
     * （真页实测就在覆盖层里，默认隐藏，触发时才可见）。只点可见盒子里的
     * 「知道了 / 确定」，**不点提交** —— 那是重复交卷。
     */
    _dismissVoteDialog: function (voteDoc) {
      try {
        if (!voteDoc) return '';
        var boxes = [].slice.call(voteDoc.querySelectorAll('.popDiv, .maskDiv, .layui-layer'));
        for (var i = 0; i < boxes.length; i++) {
          var box = boxes[i];
          var visible = false;
          try { visible = !!box.offsetParent; } catch (eVis) { visible = false; }
          if (!visible) continue;
          var btn = null;
          [].forEach.call(box.querySelectorAll('a, button'), function (x) {
            var label = String((x.innerText || x.value) || '').replace(/\s+/g, '').slice(0, 10);
            if (!btn && /^(知道了|确定|确认)$/.test(label)) btn = x;
          });
          if (btn) {
            btn.click();
            return String(btn.innerText || btn.value || '').replace(/\s+/g, '').slice(0, 10);
          }
        }
      } catch (e) {}
      return '';
    },

    /**
     * 收起覆盖层。优先按平台自己的「返回」，它会把 `.voteContainer` 关回去；
     * 按不到才直接收起容器 —— 覆盖层一直挡着刷课页，后面的视频/讨论都点不着。
     */
    _closeVoteOverlay: function (voteDoc) {
      try {
        if (voteDoc) {
          var back = null;
          [].forEach.call(voteDoc.querySelectorAll('a, button'), function (x) {
            var label = String((x.innerText || x.textContent) || '').replace(/\s+/g, '');
            if (!back && /^返回$/.test(label)) back = x;
          });
          if (back) { back.click(); return 'back'; }
        }
      } catch (e) {}
      try {
        var container = document.querySelector('.voteContainer');
        if (container) { container.style.display = 'none'; return 'hide'; }
      } catch (e2) {}
      return 'none';
    },

    _voteTryKeyOf: function (job) {
      return String((job && (job.jobid || job.objectid)) || (job && job.name) || 'vote');
    },

    /** 记一次没成功的尝试；键是 jobid，同一章里多个投票各算各的。 */
    _noteVoteTry: function (job, reason) {
      if (!this._voteTryMap || typeof this._voteTryMap !== 'object') this._voteTryMap = {};
      var key = this._voteTryKeyOf(job);
      var prev = this._voteTryMap[key] || { n: 0, at: 0 };
      this._voteTryMap[key] = { n: Number(prev.n || 0) + 1, at: Date.now(), last: String(reason || '') };
    },

    _clearVoteTry: function (job) {
      try {
        if (this._voteTryMap) delete this._voteTryMap[this._voteTryKeyOf(job)];
      } catch (e) {}
    },

    /** 够次数就冷却，冷却到期自动放行 —— 返回 null 表示"可以再试"。 */
    _voteTryCooledDown: function (job) {
      var key = this._voteTryKeyOf(job);
      var rec = this._voteTryMap && this._voteTryMap[key];
      if (!rec) return null;
      var tries = Number(rec.n || 0);
      if (tries < VOTE_MAX_TRIES) return null;
      var age = Date.now() - Number(rec.at || 0);
      if (age >= VOTE_COOLDOWN_MS) {
        this._clearVoteTry(job);
        return null;
      }
      return { tries: tries, retryInMs: VOTE_COOLDOWN_MS - age, last: String(rec.last || '') };
    },

