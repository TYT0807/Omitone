/* ==========================================================================
 * Omitone page.js 片段 06/15 —— 任务点：识别与搜索
 * 来源：原 page.js 中散布的 25 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 从页面里找出「这一章还有哪些任务点没做」：附件列表、iframe 探测、任务点分类
 * 把识别结果拼成可执行的 job（附件型 / 合成型 / frame 兜底）
 * OCS 风格的任务点搜索与「已完成」状态识别
 * ⚠️ _getAttachmentWorkType 的判断顺序不能动：isPassed → job:true → job:false → 模块名推断
 * ⚠️ `_ensureOcsStudyRunner` 里的几个 `while (version === _runtimeVersion)` 是**开放条件**循环
 *    （等页面版本号变化才退出），里面还可能有 `await job.func()`。它们都调了
 *    `this._tickProgress(...)` 刷心跳 —— **别删**，否则正常推进的一轮会被看门狗当成卡死。
 *
 * 本段的方法（37 个）：
 *   _detectPageChange、_isCurrentCompleted、_skipIfCompleted、_hasTaskPoint、
 *   _classifyTaskFrame、_collectVisibleTaskFrames、_getChaoxingAttachments、
 *   _getChaoxingFrameData、_findJobIdInAncestorFrames、_detectChaoxingJobElements、
 *   _matchChaoxingAttachment、_kindFromAttachment、_kindFromChaoxingElements、
 *   _getChaoxingJobName、_getAttachmentWorkType、_buildAttachmentOnlyJob、
 *   _resolveJobFrame、_isJobAlreadySearched、_getAttachmentFingerprint、
 *   _buildSyntheticChaoxingJob、_buildFrameFallbackJob、_frameRejectSignature、
 *   _maybeHoldSkipForUnparsedQuiz、_noteQuizParseRetryExhausted、_quizScanRetrySignal、
 *   _noteTaskFrameStillLoading、_skipCompletedEvidence、_searchIFramesOcs、
 *   _taskDiscoveryWindowMs、_noteOcsDiscoveryTick、
 *   _searchChaoxingJobOcs、_studyProgressKey、_ensureOcsStudyRunner、_searchChaoxingJob、
 *   _getVisibleTaskCompletionState、_isActiveDocumentPending、
 *   _isActiveStudyJobPending
 * ========================================================================== */
// @omitone-part-header-end

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
      this._completionEvidence = '';
      if (this._isActiveMediaPending('completion-check')) return false;
      // ⚠️ 批次 10-C：上一轮扫描里若有一帧「有作答框、命中题形容器、却一题没抠出来」，
      //   **这一刻不许宣称整节完成** —— 那一族形状就是真实日志里 00:46:04 的第二份卷子，
      //   重载之后它当场答成 3 题。窗口是有界的（每张卡片一个，见 `_maybeHoldSkipForUnparsedQuiz`），
      //   过期后照旧推进，所以这里买的不是"永久停摆"，是"别把还没长出来的卷子读成已经做完"。
      if (this._quizParseRetryUntil > Date.now()) return false;

      var mainDoc = this._getMainDocument();
      // ⚠️ 判据顺序：**先问「页面上还有没有没做完的可见任务点」，再认「任务点已完成」那句文案**。
      // 原先文案那条排在最前面，而它是**页面级**的：一张卡片里挂两份测验时，
      // 刚交完的那一份就会把这句话渲染出来，另一份还挂在页面上一个字没答。
      // 于是第一份交完 1 秒就 `skip completed` + 点「下一节」，第二份被整节翻过去
      //（2026-11-10 真实日志：19:12:17 `quiz submit finished` → 19:12:18 `skip completed`，
      //  此后整段再没有任何答题记录 = 用户报的「第一次遇到题目过了，第二次不答题」）。
      // 反过来「跳过」是不可逆的、而「多等一轮」只是慢一点，所以这里必须让
      // **未完成任务点的证据压过一句文案**。
      var state = this._getVisibleTaskCompletionState();
      if (state.hasTasks && !state.allFinished) return false;

      try {
        if (mainDoc && /任务点已完成/.test(textOf(mainDoc.body))) {
          this._completionEvidence = 'text-marker';
          return true;
        }
      } catch (e0) {}

      if (state.hasTasks) {
        this._completionEvidence = 'all-tasks-finished';
        return true;
      }

      var active = document.querySelector('.posCatalog_select.posCatalog_active, .posCatalog_active');
      if (!active) return false;
      if (active.querySelector('.catalog_points_er, .catalog_points_san')) return false;
      if (!active.querySelector('.catalog_points_yi, .icon_Completed, .icon_completed')) return false;

      if (this._detectQuiz()) return false;

      var currentVideo = this._getVideoEl();
      if (currentVideo && !currentVideo.ended) return false;

      if (!this._hasTaskPoint()) {
        this._completionEvidence = 'catalog-marker';
        return true;
      }
      return false;
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
      // ⚠️ 交卷结果还没回来时绝不跳章。实测（2026-11-10 日志）：
      // `skip completed` 与点「下一节」发生在同一秒，20 毫秒后才出现 `quiz submit finished`
      // —— 平台还没处理完提交，页面就被推走了，用户看到的就是「题没答/没交上」。
      // 等提交结束（或 quizSubmitWaitMs 超时）再走正常完成判定。
      if (this._quizSubmitPending) return false;
      if (this._switchToNextLearningCard('skip-completed')) return true;
      console.log('%c[Omitone] skip completed: ' + this._getCurrentTitle(), 'color:#FF9800');
      // 批次 11-B：这一句以前只有 `{title, by}` —— 用户问「怎么说已完成了？」时，
      // 日志本身答不上来。现在把**判成完成的当场依据**一起落盘（全部只读取证，判据没动）。
      emitRuntimeLog('info', 'skip completed', Object.assign(
        { title: this._getCurrentTitle(), by: this._completionEvidence || 'unknown' },
        this._skipCompletedEvidence()
      ));
      this._dismissPopups();
      this.nextUnit();
      return true;
    },

    _hasTaskPoint: function () {
      var frame = this._getMainFrame();
      if (!frame) {
        // 没有主帧（OCS / 移动端布局）：这一族的课程内容是直接挂在**顶层页**上的，
        // 所以把同一套判据改挂到 `document` 上探测，而不是"无脑 true / 无脑 false"。
        var bareHit = null;
        try {
          bareHit = document.querySelector(
            '.ans-job-icon, .ans-task-icon, .taskPoint, .ans-job-num, ' +
            '#panView, .fileBox, .pageNum, #pageNumber'
          );
        } catch (eBare) { bareHit = null; }
        if (bareHit) return true;

        var bareActive = document.querySelector('.posCatalog_select.posCatalog_active, .posCatalog_active');
        if (bareActive && bareActive.querySelector('.catalog_points_er, .catalog_points_san, .catalog_points_yi')) return true;

        var bareText = '';
        try { bareText = textOf(document.body); } catch (eBareText) { bareText = ''; }
        if (bareText.indexOf('任务点') !== -1) return true;
        // 三种探测都没命中时**保守返回 true**（=「认不出就当有任务点」）。
        //
        // 为什么必须保守：这个返回值同时喂三条跳过出口 ——
        //   ① `_isCurrentCompleted()` 末行的 `return !this._hasTaskPoint()`
        //      → `_skipIfCompleted()` → `nextUnit()`，整节直接翻过去；
        //   ② `_runTick` 尾部的 `_isTextOnly() && !_hasTaskPoint()` 跳过分支；
        //   ③ 62-tasks-run.js `_locateDocumentTask` 的 `worthHandling(doc)`
        //      —— 判 false 就不接管文档任务，PDF.js / 翻页文档整族没人管。
        // 返回 false 的含义是**肯定的**「这一页没有任务点」，可我们其实什么都没认出来
        // （`_getMainFrame()` 为空时，任务点 markup 常在读不到的子帧 / 延迟渲染的容器里）。
        // 把"判不出"写成"没有"，就是静默跳过 —— 用户看到的「所有题目都被跳过」（2026-11-10）。
        //
        // 那空节谁来推进？不能靠这里 —— **空节的前进只允许走 `_tryAdvanceIdleSection`**，
        // 那条自带时间窗（`_idleEmptySince` 要连续空够时长）和日志（`study no runnable job`
        // 有节流），是"能解释、可恢复"的出口；本方法没有"观察了几秒"的概念，
        // 每一帧都是当场判断，一旦判错就是立刻跳走、无窗、无声。
        // 宁可慢一点、空转几秒有日志，也不能听见什么都没说就翻页。
        return true;
      }

      var doc = this._getMainDocument();
      if (!doc) return true;   // 主帧在、但跨域读不到 —— 必须保守

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

    /**
     * 沿**祖先帧链**找这个帧所属任务点的 jobid。
     *
     * 为什么必须有（现场故障，实测日志）：真实页面上「带 jobid 的帧」和
     * 「带题目（`.TiMu`）的帧」**不是同一个帧**，而是分在三层：
     *
     *   /ananas/modules/work/index.html?…          ← 有 data（jobid / _jobid），没有 .TiMu
     *     └─ /mooc-ans/api/work?api=1&workId=…     ← data 为【空】，也没有 .TiMu
     *          └─ /mooc-ans/work/doHomeWorkNew?…   ← 有 .TiMu（整卷题目），data 也是空
     *
     * `_searchChaoxingJobOcs` 只认「本帧自己的 `data`」，
     * 于是带 jobid 的那层被"没有 .TiMu"挡掉、有 .TiMu 的那层被"没有 jobid"挡掉 ——
     * **每一层都被 continue，一个任务点都匹配不到**。
     * 后果不是"报错"，而是它认为"本页没有任务点"→ `nextUnit()` 直接跳过整章，
     * 用户看到的就是「两个单元测试只做了第一个，第二个连试都没试」。
     *
     * 所以取不到本层 jobid 时，往上找——jobid 挂在祖先帧的 `data` 上。
     */
    _findJobIdInAncestorFrames: function (win) {
      try {
        var cur = win;
        for (var depth = 0; depth < 6 && cur; depth++) {
          var el = null;
          try { el = cur.frameElement; } catch (eFrame) { el = null; }
          if (!el) break;

          var id = '';
          try {
            id = String(el.getAttribute('jobid') || el.getAttribute('_jobid') || '');
            if (!id) {
              var parsed = this._safeJsonParse(el.getAttribute('data') || '', null);
              id = String((parsed && (parsed.jobid || parsed._jobid)) || '');
            }
          } catch (eAttr) {}
          if (id) return id;

          // 同一层容器上还可能挂着 jobid（任务点外层 `.ans-attach-ct` 常把 jobid
          // 写在 **div 上**而不是 iframe 的 data 里）。
          //
          // ⚠️ **必须先看容器自己。** 原先这里只写 `wrap.querySelector('[jobid]')` ——
          // 而 **`querySelector` 只找后代、永远返回不了 `wrap` 自己**，
          // 于是下面那个 `holder === wrap` 条件**不可达**：「jobid 在容器 div 上」
          // 这条路径**完全没生效**。
          // 实测（e2e 的 `/two-quizzes-divjob` 变体场景）：`ancestorJobId` 恒为空串 →
          // `_searchChaoxingJobOcs` 返回 null → **整章被静默跳过** ——
          // 与用户报过的「两个大题目只做第一个」症状一模一样。
          //
          // ⚠️ 这里必须**确认这个 jobid 属于我们这一帧**：只接受
          //   「容器自己」或「包含本帧的元素」，否则会在一个容器里塞了两个任务点时
          //   把**兄弟任务点的 jobid** 当成本帧的身份 —— 那会让插件去跑错的任务点，
          //   比"匹配不到"严重得多（匹配不到只是漏做，绑错是**做错**）。
          try {
            var wrap = el.parentElement;
            var holder = null;

            // ① 容器**自己**身上的 jobid / _jobid / data.jobid
            if (wrap && wrap.getAttribute) {
              var ownId = String(wrap.getAttribute('jobid') || wrap.getAttribute('_jobid') || '');
              if (!ownId) {
                var wrapData = this._safeJsonParse(wrap.getAttribute('data') || '', null);
                ownId = String((wrapData && (wrapData.jobid || wrapData._jobid)) || '');
              }
              if (ownId) holder = wrap;
            }

            // ② 容器**后代**里的 jobid 承载元素（要它包着本帧才算数）
            if (!holder && wrap && wrap.querySelector) {
              holder = wrap.querySelector('[jobid], [data*="jobid"]');
            }

            var belongsToThisFrame = !!holder && (holder === wrap || (holder.contains && holder.contains(el)));
            if (holder && holder !== el && belongsToThisFrame) {
              var hid = String(holder.getAttribute('jobid') || holder.getAttribute('_jobid') || '');
              if (!hid) {
                var hp = this._safeJsonParse(holder.getAttribute('data') || '', null);
                hid = String((hp && (hp.jobid || hp._jobid)) || '');
              }
              if (hid) return hid;
            }
          } catch (eWrap) {}

          try { cur = cur.parent; } catch (eUp) { break; }
        }
      } catch (e) {}
      return '';
    },

    _detectChaoxingJobElements: function (doc) {
      if (!doc || !doc.querySelector) return null;
      var videojs = doc.querySelector('#video, #audio, .video-js, #video_html5_api');
      // ⚠️ 「像题即题」的老判据（`doc.querySelector(_quizDetectorSelector)`）已换掉：
      //    那串类名里的 `.question-content` / `.answerOption` 在课件帧与文档帧里同样出现，
      //    于是一个轮盘 PPT 帧被判成 quiz、阅读链路永远轮不到（2026-11-10「刷 PPT 报废」）。
      //    现在问的是「这页真抠得出题、且题里有能填的控件」吗 —— 见 `_documentHasQuiz`。
      var quiz = this._documentHasQuiz(doc);
      // ⚠️ `quiz` 与 `quizLike` 是**两个不同的问题**，别合并：
      //   `quiz` = 「这帧是什么任务」（判类型，走 `_kindFromChaoxingElements` 那一份顺序）；
      //   `quizLike` = 「这帧值不值得进 jobid 匹配」（准入闸的弱信号，整页扫通用类名）。
      //   只留 `quiz` 那一个信号当闸会把**认不出作答控件的真卷子整帧拒掉** ——
      //   三层嵌套的卷子（jobid 在外层、`.TiMu` 在内层）就是这么被静默漏掉的形状，
      //   实测把 2026-10-17 那份故障夹具全线改红过（2026-11-10 批次 2）。
      //   准入闸宁可宽：判错类型的代价是"多看一眼"，判不进门的代价是"整章跳过"。
      var quizLike = !!doc.querySelector(this._quizDetectorSelector);
      var read = doc.querySelector('#img.imglook, .imglook#img');
      var pptWithAudio = doc.querySelector('.swiper-container');
      var hyperlink = doc.querySelector('#hyperlink');
      var timereader = doc.querySelector('iframe[name="bookifame"][src*="timing"]');
      var documentJob = doc.querySelector('#panView, .fileBox, .pageNum, #docContainer, .docBox');

      if (!(videojs || quiz || quizLike || read || pptWithAudio || hyperlink || timereader || documentJob)) return null;

      return {
        videojs: videojs,
        quiz: quiz,
        quizLike: quizLike,
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
     * 附件元数据 → 任务类型。这份映射现在**只此一份**（`_buildAttachmentOnlyJob` 与
     * 任务类型仲裁 `_kindFromChaoxingElements` 共用）—— 以前它在附件构造里手写一遍、
     * 在 OCS 路由旁又各写一遍，改顺序时必然只改到其中一份。
     *
     * 返回空串 = 附件说不出这是什么任务，调用方据此回落到 DOM 判据。
     *
     * ⚠️ 这一族的粒度只到 `read`：`insertdoc` / ppt / pdf / doc / 图片在附件里都是
     *    「一个文档」，究竟是图片阅读、轮盘 PPT 还是翻页文档只有 DOM 知道 ——
     *    `_runChaoxingReadJob` 对这三种走**不同翻页器**，所以 read 家族的具体 flavour
     *    要留给 DOM 定（见 `_kindFromChaoxingElements` 的注释）。
     */
    _kindFromAttachment: function (attachment) {
      if (!attachment) return '';
      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      if (/insertdoc/.test(module) || /(?:^|\.)(?:ppt|pptx|pdf|doc|docx)$/.test(type)) return 'read';
      // 音频任务点走的是同一套媒体流程（_playChaoxingMediaJob 本身已支持 audio 元素），
      // 早期只认 insertvideo，insertaudio 会掉到「说不出」然后被整条丢弃
      if (/insertvideo|insertaudio/.test(module) || /(?:^|\.)(?:mp4|m3u8|avi|mp3|m4a)$/.test(type) || /video|audio/.test(type)) return 'video';
      if (/work|exam|quiz/.test(module)) return 'quiz';
      // 图片任务点：打开看一眼即可，按「阅读」处理
      if (/insertimage/.test(module) || /^(?:image|jpg|jpeg|png|gif|webp)/.test(type)) return 'read';
      return '';
    },

    /**
     * 任务类型仲裁的**唯一一处顺序**（2026-11-10）。调用方拿到 kind 之后按 kind 分派，
     * 不许再各自按 `found.xxx` / `elements.xxx` 布尔位重排一遍 ——
     * 仲裁与路由留两份顺序，下一次改顺序必然只改到其中一份。
     *
     * 顺序（固定）：
     *   ① 附件元数据 —— 「这个任务点是什么」的权威来源。卷子常常渲染在
     *      本帧抠不到题的那一层（三层嵌套的 jobid 场景），只有附件说得出 quiz；
     *   ②..⑧ DOM，从最具体到最兜底：
     *      videojs → quiz → read → ppt-audio → timereader → hyperlink → document。
     *      （`document` 是兜底，绝不能排在 ppt/timereader 之前 —— 它那些类名太通用。）
     *
     * 唯一的例外是 read 家族：附件那份映射只说得出 `read`，分不清图片阅读 /
     * 轮盘 PPT / 翻页文档，而这三种在 `_runChaoxingReadJob` 里走不同翻页器，
     * 所以 read 家族让 DOM 的具体 flavour 赢；跨家族（video / quiz）仍以附件为准。
     */
    _kindFromChaoxingElements: function (elements, attachment, doc) {
      var fromAttachment = this._kindFromAttachment(attachment);
      var fromDom = '';
      if (elements) {
        if (elements.videojs) fromDom = 'video';
        else if (elements.quiz) fromDom = 'quiz';
        else if (elements.read) fromDom = 'read';
        else if (elements.pptWithAudio) fromDom = 'ppt-audio';
        else if (elements.timereader) fromDom = 'timereader';
        else if (elements.hyperlink) fromDom = 'hyperlink';
        else if (elements.documentJob || elements.pagedDoc) fromDom = 'document';
      } else if (doc) {
        // 调用方只给了文档、没有探测包：用**同一个**判据现算一次。
        // 顺序只留一份、判据也只留一份，别在调用方再手抄一遍 DOM 探测。
        if (this._documentHasQuiz(doc)) fromDom = 'quiz';
      }

      if (fromAttachment && fromAttachment !== 'read') return fromAttachment;
      return fromDom || fromAttachment || '';
    },

    _buildAttachmentOnlyJob: function (attachment) {
      if (!attachment) return null;
      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      // 与 _getAttachmentWorkType 同一条判据：显式 job:false 表示老师没把它设为任务点。
      // 这里也必须挡一道 —— 否则调用方若没先过滤，仍然会造出一个"要去做"的任务。
      // ⚠️ 这道闸门留在本方法里，不进 `_kindFromAttachment`：映射只管「是什么」，
      //    「要不要做」不是它的职责（仲裁时 job:false 的附件同样要说得出类型）。
      var jobFlag = attachment.job !== undefined ? attachment.job : property.job;
      if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
        return null;
      }

      var kind = this._kindFromAttachment(attachment);
      if (!kind) {
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
        // ⚠️ 和 `_findJobIdInAncestorFrames` **保持一致**：jobid 可能挂在任务点外层容器
        //    （`.ans-attach-ct`）上，只在本帧的 `data` / 属性里找会漏。
        //    漏的后果不是"匹配不到"，而是**匹配上了却反查不回帧** ——
        //    `_runChaoxingJob` 靠这里拿 `job.doc`，拿不到就"跑不起来"（e2e 变体场景实测）。
        if (!frameJobId && win) {
          try { frameJobId = String(this._findJobIdInAncestorFrames(win) || ''); } catch (eAnc) {}
        }
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
      // 仲裁只走 `_kindFromChaoxingElements` 这一份顺序。这里没有附件可问 ——
      // 会落到「合成型任务」这条构造路径，正是因为附件清单里没匹配上它。
      var kind = this._kindFromChaoxingElements(elements, null, doc) || 'other';

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

    /**
     * 「这一帧为什么认不出类型」的紧凑签名 —— **批次 9-D 只取证，不改判据**。
     *
     * 为什么值得记：`javascript:` / `javascript:void(function(){document.open` 那一族帧
     * 在真实日志里每秒都被拒成同一句「认不出任务类型」，而它是「第一个做了、
     * 第二个又不做了」唯一可疑的现场。旧签名只有 src + 原因，**判不了那是空帧还是第二份卷子**，
     * 而凭这个去放宽类型判定，会连带把别的帧一起误收（正是用户警告过的"修一半、别的报废"）。
     *
     * 只在帧被拒时调用；整条 reject 日志本身有 30 秒 + 组合变化节流，允许多跑几次查询。
     * 每项都包异常 —— 跨域帧与 `document.open()` 写到一半的帧都可能直接抛。
     */
    // ⚠️ **这个对象要落进运行日志，所以里面只许出现字符串和数字。**
    // 真源：`runtime-log-store.js` 的 `cleanLogMeta` 从**第 4 层**起一律写成 `'[truncated]'`
    //   meta(0) → rejects(1) → 单条帧(2) → sig(3) → **sig 里的数组或对象 = 第 4 层** → 没了。
    // 批次 9 第一版把 `qHit` 写成「选择器 → 命中数」的**对象**，于是用户 2026-11-11 导出的
    // 真实日志里那条取证长这样：`"sig":{"answer":0,"frames":1,"qHit":"[truncated]","text":""}`
    // —— 取证字段自己不可读，等于白取证。**字符串只受 2000 字截断，数字原样保留**，
    // 所以前 5 个选择器的命中数按**位置**压成 `"1/0/0/3/0"`（`qHits`，用来定位是哪个类名命中的），
    // 总和 `qTotal` 则按**整份**清单的并集数（用来判"有没有题形"，见下面那段警告）。
    _frameRejectSignature: function (doc, found) {
      if (!doc) return { reach: 'no-doc' };
      var sig = {};
      var count = function (sel) {
        try { return doc.querySelectorAll(sel).length; } catch (e) { return -1; }
      };
      var fullText = '';
      try {
        fullText = String((doc.body && doc.body.innerText) || '').replace(/\s+/g, ' ').trim();
      } catch (eText) { fullText = ''; }
      // `text` 与 `textLen` 必须**两个都给**：只给片段时，「文本本来就空」和
      // 「片段被切没了」在日志里长得一模一样（`textLen` 才是判据，`text` 只是给人看的引子）。
      sig.textLen = fullText.length;
      sig.text = fullText.slice(0, 40);
      // 题形命中数**按真源清单逐个报**（批次 9-D）：这里手抄 `.TiMu` / `.questionLi`
      // 就等于给诊断开第二份选择器，改版时它比排查更容易骗人。
      // 前 5 条单独给位置串，是为了「哪个类名命中的」一眼能定位；
      // 它**不是**总数 —— 总数见下面 `qTotal`。
      var hits = [];
      try {
        (this._questionSelectors || []).slice(0, 5).forEach(function (sel) {
          hits.push(count(sel));
        });
      } catch (eSel) {}
      sig.qHits = hits.join('/');
      // ⚠️ `qTotal` 必须按**整份** `_questionSelectors` 的并集数，不能只数前 5 条。
      //   这条清单是**有序备选**，`_collectQuestionContainers`（抠题真源）是逐条试到底的，
      //   而真实日志里唯一命中的那条排在第 15：
      //     00:46:04 `quiz scan found 0 questions {docs:8,inputs:9,matchedSelectors:{"div[class*=\"question\"]":1}}`
      //   只数前 5 条 → `qTotal` 恒为 0 → 批次 10-C 的延时窗口**永远不会武装**，
      //   判据修对了、喂它的数取错了，等于没修（e2e 场景 45 的夹具就是照这个改的）。
      //   一次并集查询，不是 18 次：这一族帧每秒都可能重扫，取证也要算成本。
      sig.qTotal = 0;
      try {
        var allSelectors = this._questionSelectors || [];
        if (allSelectors.length) sig.qTotal = Math.max(0, count(allSelectors.join(',')));
      } catch (eUnion) {}
      sig.video = count('video');
      // 作答控件读**真源** `_quizAnswerControlSelector`（`li[qid]` / `#answer…` / `[role=radio|checkbox]`），
      // 不是只数 `[id^="answer"]`：新版前端有的卷子只有 `qid` 或 role，光看 id 会把真卷子读成"没有作答框"，
      // 于是 10-C 的延时窗口武装不上。准入闸问的就是这一串，取证必须和它同一个口径。
      sig.answer = count(this._quizAnswerControlSelector);
      sig.frames = count('iframe');
      try { sig.pan = doc.getElementById && doc.getElementById('panView') ? 1 : 0; } catch (ePan) { sig.pan = -1; }
      if (found) {
        try {
          sig.signals = Object.keys(found).filter(function (k) { return !!found[k]; }).join(',');
        } catch (eSig) {}
      }
      return sig;
    },

    /**
     * 「这一帧**有作答框、也命中了题形容器**，却一题都没抠出来」—— 批次 10-C。
     *
     * 为什么这一族不能当成「整节已完成」：真实日志 00:46:04
     *   `quiz scan found 0 questions {docs:8, inputs:9, matchedSelectors:{"div[class*=\"question\"]":1}}`
     *   → 1 秒后 `skip completed {by:"all-tasks-finished"}` → 点「下一节」；
     * 而 00:46:16 重新加载之后，**同一份卷子当场答成 3 题**。也就是说那一帧里坐着的就是一份
     * 还没渲染完的真卷子（有题形容器、有作答控件），只是抠题暂时为空 —— 平台把内容
     * `document.write` 进子帧需要时间，我们扫得太早，就把"还没长出来"读成了"已经做完"。
     * 这正是用户报的「第一个做了、第二个又不做了」和「判定为已完成了」。
     *
     * ⚠️ **代价必须封顶**：用户的另一条抱怨是「在已经完成的界面磨蹭很久」。所以这里不是
     * 「一直等」，而是**每个作用域（章节+卡片）只给一个窗口**，用完就照旧推进 ——
     * 与「判不准时停在原地、代价可见、会自愈」那条规矩一致，但不许把磨蹭换成另一种磨蹭。
     */
    _maybeHoldSkipForUnparsedQuiz: function (sig, src) {
      if (!sig) return false;
      if (!(Number(sig.qTotal) >= 1) || !(Number(sig.answer) >= 1)) return false;
      var now = Date.now();
      if (this._quizParseRetryUntil > now) return true;               // 同一窗口内不续期，否则永不超时
      var scope = '';
      try { scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || ''))); } catch (eScope) {}
      if (scope && scope === this._quizParseRetryScope) {
        // 本张卡片已经用过窗口，且**这一轮没再给出新证据**：不再续期，让它推进。
        this._noteQuizParseRetryExhausted(now, sig, src);
        return false;
      }
      this._quizParseRetryScope = scope;
      this._quizParseRetryUntil = now + Math.min(12000, scaledMs(8000));
      emitRuntimeLog('warn', 'quiz frame has answer controls but no parsable questions, delay skip', {
        src: String(src || '').slice(0, 40),
        qHits: String(sig.qHits || ''), qTotal: sig.qTotal, answer: sig.answer,
        // 批次 11-A：`src:"quiz-scan"` 这一路给的是**页面级**数字，没有单帧文本可报，
        // 于是 `containers`（收着的题容器数）就是"命中了却被过滤掉 / 压根没容器"的分界。
        textLen: Number(sig.textLen) || 0, containers: Number(sig.containers) || 0,
        drop: String(sig.drop || ''),
        hint: '题形容器命中≥1 且作答框≥1、却一题都没抠出来 —— 多半是平台还没把卷子渲染进这一帧。' +
          '本卡片只给一个延时窗口，过期后照旧推进（不再空等）',
        holdMs: this._quizParseRetryUntil - now
      });
      return true;
    },

    _noteQuizParseRetryExhausted: function (now, sig, src) {
      if (this._quizParseRetryWarnAt && now - this._quizParseRetryWarnAt < 60000) return;
      this._quizParseRetryWarnAt = now;
      emitRuntimeLog('warn', 'quiz parse retry spent, allow skip', {
        src: String(src || '').slice(0, 40),
        qTotal: sig.qTotal, answer: sig.answer,
        containers: Number(sig.containers) || 0,
        hint: '延时窗口已经用掉：这一帧仍然抠不出题，放行完成判定 —— 下一份日志里这条与上一条' +
          ' `delay skip` 相隔多久，就是这一族卷子渲染实际需要的时间'
      });
    },

    /**
     * 页面级「有作答框 + 命中题形、却一题没抠出来」信号 —— 批次 11-A。
     *
     * ⚠️ 这一条补的是 10-C 接错的那根线。10-C 的窗口只挂在**「帧被拒」**那条路上，
     * 而真实日志 01:49:17 那一帧的签名是 `answer:0`、`text:""`（卷子压根还没被
     * `document.write` 进那一帧），闸门条件 `qTotal>=1 && answer>=1` 当场不成立 ——
     * 于是"修好了"的延时窗口在真实页面**一次都没武装过**，用户看到的还是同一句
     * `skip completed {by:"all-tasks-finished"}`。
     * 同一时刻真正量到正确形状的，是 `_handleQuiz` 那句 0 题诊断（00:46:04：
     * `inputs:9` + `matchedSelectors:{"div[class*=\"question\"]":1}` + 容器 0 个），
     * 但它说完就扔，没有任何判据读它。这里把**同一份数字**接进**同一个有界窗口**。
     *
     * 一次诊断要遍历 ≤8 个文档 × 18 条选择器，所以只在「这张卡片还可能拿到窗口」时才算：
     * 窗口已经武装（`_isCurrentCompleted` 正在拦）或本卡片预算已用掉 → 直接 null。
     * 落盘字段全部标量（批次 10-A 的规矩）。批次 12：`dropStages` 真实形状是
     * 「选择器 → {matched,filtered,deduped,unparsable}」，旧写法按数字读它 → `:NaN`，
     * 现在统一走 `_flattenDropStages`；`qTotal` 改成**逐文档取最大值再相加**，
     * 因为真页面同一批 24 道题被三族选择器各数一遍，相加给出页面里根本没有的 73。
     */
    _quizScanRetrySignal: function (preferredDoc) {
      var now = Date.now();
      if (this._quizParseRetryUntil > now) return null;
      var scope = '';
      try {
        scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || '')));
      } catch (eScope) {}
      if (scope && scope === this._quizParseRetryScope) return null;

      var diag = null;
      try { diag = this._diagnoseQuestionScan(preferredDoc || null); } catch (eDiag) { return null; }
      if (!diag || !Array.isArray(diag.docs)) return null;

      var answer = 0;
      var qTotal = 0;
      diag.docs.forEach(function (d) {
        if (!d) return;
        answer += Number(d.inputs) || 0;
        var hitMap = d.selectors || {};
        // ⚠️ 批次 12：这里取**每条选择器命中的最大值**，不是全部相加。
        // 真页面实测：同一批 24 道题被 `.TiMu` / `.singleQuesId` / `div[class*="TiMu"]`
        // 各数了一遍，相加给出 `qTotal:73` —— 一个页面里根本没有的数字。
        // 三条选择器的各自数量本来就在 `matchedSelectors` 里，这里只要"大概有几道题"，
        // 而判据是 `>=1`：取最大值一样能开门（真页面那条 `div[class*="question"]:1` 仍然算 1）。
        var docMax = 0;
        Object.keys(hitMap).forEach(function (k) {
          var n = Number(hitMap[k]) || 0;
          if (n > docMax) docMax = n;
        });
        qTotal += docMax;
      });
      if (!(qTotal >= 1) || !(answer >= 1)) return null;

      return {
        qTotal: qTotal, qHits: '', answer: answer,
        containers: Number(diag.containers) || 0,
        docs: diag.docs.length, drop: this._flattenDropStages(diag.dropStages),
        textLen: 0, text: ''
      };
    },

    /**
     * 「凭什么说这一节做完了」—— 批次 11-B，**只取证、不改判据**。
     *
     * 用户四轮反馈里最要命的一句是「怎么说已完成了？」，而 `skip completed` 整条日志只有
     * `{title, by}` 两个字段：既看不出那一刻任务点清单长什么样，也看不出页面上还剩几个
     * 作答框、延时窗口是用掉了还是根本没武装。下一份导出必须能自己回答这个问题。
     *
     * 全部走只读判据：`_isQuizLearningPending` 会重置答题状态（有副作用），**不许**调。
     */
    _skipCompletedEvidence: function () {
      var ev = {
        by: this._completionEvidence || 'unknown',
        tasks: 0, unfinished: 0, taskTypes: '', unfinishedTypes: '',
        inputs: 0, qTotal: 0, containers: 0, drop: '',
        retryLeftMs: 0, retrySpent: false
      };
      try {
        var tasks = this._collectVisibleTaskFrames();
        ev.tasks = tasks.length;
        // `_classifyTaskFrame` 给的是 `type`（work/video/read/…），不是 `kind` ——
        // 「看见了哪几个任务点、各自完成没有」必须按这一族名字落盘，否则又是一句自证的空话。
        var allTypes = {};
        var openTypes = {};
        tasks.forEach(function (t) {
          var k = String((t && t.type) || 'other');
          allTypes[k] = (allTypes[k] || 0) + 1;
          if (!t || !t.finished) openTypes[k] = (openTypes[k] || 0) + 1;
        });
        var joinTypes = function (map) {
          return Object.keys(map).map(function (k) { return k + ':' + map[k]; }).join('/');
        };
        ev.unfinished = tasks.filter(function (t) { return !t || !t.finished; }).length;
        ev.taskTypes = joinTypes(allTypes).slice(0, 90);
        ev.unfinishedTypes = joinTypes(openTypes).slice(0, 90);
      } catch (eTasks) {}
      try {
        var diag = this._diagnoseQuestionScan(null);
        if (diag && Array.isArray(diag.docs)) {
          ev.inputs = diag.docs.reduce(function (sum, d) { return sum + (Number(d && d.inputs) || 0); }, 0);
          // 与 `_quizScanRetrySignal` 同一个口径（批次 12）：每份文档取最大命中数再相加，
          // 求和会把同一批题按族名数三遍（真页面 24 题报成 73）。
          ev.qTotal = diag.docs.reduce(function (sum, d) {
            var hitMap = (d && d.selectors) || {};
            var docMax = 0;
            Object.keys(hitMap).forEach(function (k) {
              var n = Number(hitMap[k]) || 0;
              if (n > docMax) docMax = n;
            });
            return sum + docMax;
          }, 0);
          ev.containers = Number(diag.containers) || 0;
          ev.drop = this._flattenDropStages(diag.dropStages);
        }
      } catch (eDiag) {}
      try {
        ev.retryLeftMs = Math.max(0, (Number(this._quizParseRetryUntil) || 0) - Date.now());
        var scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || '')));
        ev.retrySpent = !!(scope && scope === this._quizParseRetryScope);
      } catch (eRetry) {}
      return ev;
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
          // 与 `_detectChaoxingJobElements` 同一个判据：问「抠不抠得出题」，
          // 不再问「像不像题」（`.question-content` 一类通用类名在课件帧里也有）。
          quiz: appRef._documentHasQuiz(doc),
          // 准入闸专用的弱信号，见 `_detectChaoxingJobElements` 里同名字段的注释。
          // 判类型**不许**读它 —— 那正是「像题即题」把课件判成测验的那条路。
          quizLike: !!doc.querySelector(appRef._quizDetectorSelector),
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
      // 每个被跳过的帧**为什么**被跳过 —— 一个都没匹配上时打出来。
      //
      // 为什么值得记：这个函数的失败**没有任何报错**，只是返回 null，
      // 然后整章被 `nextUnit()` 推过去。现场日志里只有一句
      // `search finished on page {"searchedCount":0}` —— 知道"没匹配上"，
      // 但**不知道卡在哪一条**（帧认不出？取不到 jobid？jobid 不在附件清单里？），
      // 只能靠人猜。用户报过的「两个大题目只做第一个」当初就是这么查的。
      //
      // 只记前 8 条，避免日志洪水。
      var rejects = [];
      var noteReject = function (frame, reason, sig) {
        if (rejects.length >= 8) return;
        var src = '';
        try { src = String(frame && frame.getAttribute && frame.getAttribute('src') || '').slice(0, 40); } catch (eSrc) {}
        var item = { src: src, reason: reason };
        // ⚠️ 「认不出类型」这一族必须带**帧里到底有什么**（批次 9-D，只取证不改判据）。
        // 真实日志 00:46:55 的 `frames:8` 里有 4 个 `javascript:void(function(){document.open`
        // 和 3 个 `javascript:` 帧全落在这一条 —— 这正是用户报的「第一个做了、第二个又不做了」
        // 唯一的可疑现场，但旧日志只报 src 前 40 字，**判不了那是空帧还是第二份卷子**。
        // 没有证据就动类型判定，代价是别的帧跟着一起被误收（用户明确警告过的"修一半报废一堆"）。
        if (sig) {
          item.sig = sig;
          // 批次 10-C：**这一条不改准入判据**（那是 9-D 刻意留着的），只在
          // 「有作答框 + 命中题形容器 + 一题没抠出」时给完成判定加一个有界延时。
          if (appRef._maybeHoldSkipForUnparsedQuiz(sig, src)) item.delay = 'quiz-parse';
          // 批次 19-B：帧**自己说还没加载好**（「正在为您加载文件…」或整张白纸）时，
          // 给发现窗口加一个有界延时。同样不改准入判据，只把"这一节做完了"往后推。
          if (appRef._noteTaskFrameStillLoading(sig, src, (attachments || []).length > 0)) item.loading = 'frame-loading';
        }
        rejects.push(item);
      };
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        try {
          var win = frame.contentWindow;
          var doc = appRef._safeWinDoc(win);
          var found = searchJobElement(frame);
          // 类型仲裁只有一份顺序 —— `_kindFromChaoxingElements`。
          // 这一关先只问 DOM（附件要到下面匹配 jobid 时才拿到），因为
          // 「帧里什么信号都没有」必须在匹配 jobid 之前就被拒掉并留下原因。
          var domKind = this._kindFromChaoxingElements(found, null, doc);
          // ⚠️ 准入闸问的是「这帧有没有**任何**任务信号」，不是「这帧是什么任务」——
          //   后者只许由 `_kindFromChaoxingElements` 一处回答。两个问题合并成一个
          //  （只用 `!domKind` 当闸）会把「认不出作答控件的真卷子」整帧拒掉：
          //   三层嵌套里 `.TiMu` 只挂在内层、且那份卷子的选项没有 `qid` 时，
          //   `domKind` 为空 → 连 jobid 匹配都不做 → 整章静默跳过。
          //   实测这样改把 3 条 2026-10-17 真实故障夹具全线改红（2026-11-10 批次 2）。
          //   弱信号 `quizLike` 只放它**进门**，类型仍然由「附件 + 窄判据」定，
          //   所以课件页该走阅读链路还是走阅读链路（见「任务类型仲裁」场景）。
          if (!win || !found || (!domKind && !found.quizLike)) {
            noteReject(frame, '帧里认不出任务类型（视频/阅读/测验/PPT/超链接/翻页文档都没有）',
              this._frameRejectSignature(doc, found));
            continue;
          }
          // 纯文档帧还有一道闸：外层容器必须真的带任务点。
          // 否则它只是页面上的说明性/预览性文档，接管它会白白占住调度。
          if (domKind === 'document') {
            if (!appRef._frameHasTaskPoint(doc)) {
              noteReject(frame, '纯文档帧，但外层容器没有任务点标记');
              continue;
            }
          }
          var frameDataStr = (win.frameElement && win.frameElement.getAttribute('data')) || (((win.frameElement && win.frameElement.contentWindow) && win.frameElement.contentWindow.parent && win.frameElement.contentWindow.parent.frameElement && win.frameElement.contentWindow.parent.frameElement.getAttribute('data'))) || '{}';
          var frameData = this._safeJsonParse(frameDataStr, {});
          var targetJobId = frameData.jobid || frameData._jobid || this._findJobIdInAncestorFrames(win);
          if (!targetJobId) {
            // 签名在这一支同样要带：「第二份卷子在哪一层」的取证不区分它死在准入闸还是死在 jobid
            noteReject(frame, '取不到 jobid（本层 data 为空，往上找祖先帧也没有）',
              this._frameRejectSignature(doc, found));
            continue;
          }

          var attachment = attachments.find(function (attachmentItem) {
            var attachmentJobId = attachmentItem && (attachmentItem.jobid || (attachmentItem.property && attachmentItem.property._jobid));
            if (!attachmentJobId) return false;
            return String(attachmentJobId) === String(targetJobId);
          });
          if (!attachment) {
            noteReject(frame, 'jobid=' + String(targetJobId).slice(0, 20) + ' 在附件清单里找不到');
            continue;
          }
          if (searchedJobs && searchedJobs.find(function (job2) {
            return job2 && String(job2.mid || job2.jobid || '') === String((attachment.property && attachment.property.mid) || attachment.jobid || '');
          })) {
            noteReject(frame, '这个任务点本轮已经搜过');
            continue;
          }

          var jobName = this._getChaoxingJobName(attachment);
          var jobKind = this._kindFromChaoxingElements(found, attachment, doc);
          var workType = this._getAttachmentWorkType(attachment);
          if (this._isDocumentFrameFinished(doc) || (jobKind === 'quiz' && this._isQuizPassedOrFinished(doc))) {
            workType = 'finished';
          }
          // 同一份卷子我们**自己刚答过**，这一轮也不必再做。
          // 平台有时交完卷不马上渲染结果页（提交按钮还挂着），于是"页面看着没做完"，
          // 而 `_handleQuiz` 因为有 `_quizAnswered` 又直接返回 —— 两边一夹就是死循环
          //（实测 2026-10-17：同一份卷子被反复匹配 6 分钟，一次都没真做）。
          if (jobKind === 'quiz' && workType === 'job' && this._quizAnswered &&
              this._quizRunPaperKey && String(targetJobId) === String(this._quizRunPaperKey)) {
            workType = 'finished';
          }
          var func = null;
          // ⚠️ 路由**只按上面仲裁出来的 jobKind 分派**，不许再看 `found.xxx` 布尔位：
          //   仲裁与路由各留一份顺序的话，下一次改顺序必然只改到其中一份
          //   （原来这两份已经不一致：这里 `timereader` 排在 `ppt-audio` 前，
          //   `_buildSyntheticChaoxingJob` 那份却把 `documentJob` 排在两者之前）。
          if (jobKind === 'video') {
            if (!this.configs.enableMedia) {
              noteReject(frame, '是视频任务，但「媒体」开关是关的');
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
          } else if (jobKind === 'quiz') {
            if (this._isQuizApiUnavailable()) {
              // ⚠️ 这两条以前都是**静默** continue —— 现场日志里一个字都没有，
              // 用户只看到「本页没有可做的任务点」，然后整章被推过去，还反复空转。
              // 与 AGENTS §2.7「跳过用户的任务点必须留日志 + 可恢复」冲突，补上原因。
              // 只在 `workType === 'job'`（平台说这份卷子**还必做**）时记 13-B 的按住标记：
              // 已经做完的卷子不该因为没填 key 就把整节按住。
              if (workType === 'job') this._noteQuizBlockedByApi(this._getQuizApiUnavailableReason());
              noteReject(frame, '是测验任务，但答题链路当前不可用（' + (this._getQuizApiUnavailableReason() || '原因未知') + '）');
              continue;
            }
            if (!(workType === 'job' || (workType === 'finished' && this.configs.restudy))) {
              noteReject(frame, '是测验任务，但被判定为「' + workType + '」——重学模式没开时不再重做');
              continue;
            }
            func = function (self, jobDoc, jobKey) {
              return async function () {
                // ⚠️ 必须先切"在答哪一份卷子"：同一张学习卡片里有两份试卷时，
                //    第一份交完 `_quizAnswered` 会一直为 true，
                //    而 `_handleQuiz` 第一行就会因此直接 return —— 第二份永远不答。
                self._syncQuizPaperRunState(jobKey, jobDoc);
                await self._handleQuiz(jobDoc);
              };
            }(this, doc, targetJobId);
          } else if (jobKind === 'read' || jobKind === 'ppt-audio' || jobKind === 'timereader' || jobKind === 'document') {
            if (!this.configs.enablePPT) {
              noteReject(frame, '是阅读/文档任务，但「文档」开关是关的');
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
              }(this, frame, win, doc, jobName, attachment, jobKind);
            }
          } else if (jobKind === 'hyperlink') {
            if (!this.configs.enableHyperlink) {
              noteReject(frame, '是超链接任务，但「超链接」开关是关的');
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
              noteReject(frame, '这个任务点在"放弃名单"里（24 小时内不再尝试）');
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

          // 走到这里：帧认得出类型、jobid 也对上了，但**这一轮轮不到它做** ——
          // workType 不是 job（已判完成 / 不是任务点），或对应的开关是关的。
          // 以前这里一句话都不说，于是「任务点被跳过」在日志里完全不可见（本次排查
          // 就卡在这上面：日志只有 frames:8 和 7 条「认不出类型」，看不出第 8 个帧去哪了）。
          noteReject(frame, '帧认出来了但本轮不需要执行（workType=' + workType + '）');
          continue;
        } catch (e4) {}
      }
      // 一个都没匹配上 —— 把每个帧**被哪一条挡下来**打出来。
      // 这条日志是"整章被跳过"这类问题唯一能自证的线索：没有它，
      // 现场只剩一句 `searchedCount: 0`，得靠人猜是哪一层出的问题。
      if (rejects.length) {
        // ⚠️ 必须节流：本方法被 OCS 循环**每秒**调一次，而"一个任务点都没匹配上"
        // 这个状态**可能持续好几分钟**（典型：整页的题都在一个认不出的帧里）。
        // 不节流的话日志缓冲会被这一条刷爆、把真正有用的条目全挤掉 ——
        // 实测用户导出的 200 条里，大半就是同一句的重复。
        // 判据：拒绝原因的组合变了（页面结构变了）或距上次已超过 30 秒，才再记一条。
        var rejectSignature = rejects.map(function (item) {
          return String(item.reason || '');
        }).join('|');
        var nowReject = Date.now();
        if (rejectSignature !== this._jobRejectSignature || nowReject - (this._jobRejectLogAt || 0) > 30000) {
          this._jobRejectSignature = rejectSignature;
          this._jobRejectLogAt = nowReject;
          emitRuntimeLog('warn', 'search job: every candidate frame was rejected', {
            frames: iframes.length,
            attachments: attachments.length,
            rejects: rejects
          });
        }
      }
      return null;
    },

    /**
     * 「学习进度键」= 章节 id + 当前学习卡片 + 附件指纹。
     *
     * 用来判断 `nextUnit()` 到底有没有让页面往前走：三者都没变，就是**点了等于没点**。
     * 全空时返回空串（调用方据此关闭这道闸，避免在识别不出章节的页面上误判）。
     */
    _studyProgressKey: function () {
      var chapterId = '';
      try { chapterId = String(this._getCurrentChapterId() || ''); } catch (e) {}
      var cardKey = '';
      try { cardKey = String(this._getExplicitActiveLearningCardKey() || ''); } catch (e2) {}
      var fingerprint = '';
      try { fingerprint = String(this._getAttachmentFingerprint(this._getChaoxingAttachments()) || ''); } catch (e3) {}
      if (!chapterId && !cardKey && !fingerprint) return '';
      return chapterId + '|' + cardKey + '|' + fingerprint;
    },

    /**
     * 「这一节的附件清单可能还没渲染完」给多长的发现窗口 —— 两条 runner 共用一份口径。
     *
     * ⚠️ 0 个附件**反而要等最久**。真实日志（2026-11-11，3.1 那一节 8 秒被翻过去）：
     *   13:15:33 `study begin {attachments:0}`
     *   13:15:36 `search job: every candidate frame was rejected {attachments:6,frames:1,…}`
     * 同一个 getter 三秒后读到 6 个 —— 也就是说"0"几乎从来不是"这一节没任务点"，
     * 而是"平台还没把卡片列表画出来"。旧公式 `min(3 + n*2, 10)` 在 n=0 时只给 **3 秒**：
     * 越是什么都没看见，就越快断定没活干，判据和事实正好相反。
     * 空窗的代价是多等 7 秒，翻过去的代价是整节的视频/测验一个字没动 —— 用户看到的
     * 就是「7.3的就直接跳过了」。
     */
    _taskDiscoveryWindowMs: function (attachmentCount) {
      // ⚠️ 必须夹住下界：负数会让 `3 + n*2` 变成负的，窗口终点落在过去 ——
      //   等于"立刻放弃"，比原来的 3 秒还糟（这条是集成测试 [18] ② 抓出来的）。
      var n = Math.max(0, Number(attachmentCount) || 0);
      return scaledMs((n === 0 ? 10 : Math.min(3 + n * 2, 10)) * 1000);
    },

    /**
     * 「这一帧自己说还没加载好」—— 批次 19-B。
     *
     * 同一天真页面两笔账，两种形状、同一个后果（整节被 `nextUnit` 翻过去）：
     *   13:15:36 `{attachments:6, sig.textLen:0}` —— 帧还是一张白纸
     *   13:41:33 `{attachments:6, sig.text:"正在为您加载文件..."}` —— 平台自己写着在加载
     * 13:41:33 那一轮**已经等满了 10 秒**（本批次前半段刚修的发现窗口）还是没等到，
     * 所以固定的秒数不够，必须认这个**正面证据**：帧里写着"正在加载"就不等于"这一节没任务点"。
     *
     * 成本封顶与 `_maybeHoldSkipForUnparsedQuiz` 同一套纪律：每张卡片只给一个窗口、
     * 同一窗口内不续期、用完放行 —— 不许把「跳过」换成另一种「磨蹭」。
     * 返回窗口终点（0 = 这一族不算还在加载，或本卡片的窗口已经用掉）。
     */
    _noteTaskFrameStillLoading: function (sig, src, hasInventory) {
      if (!sig) return 0;
      var text = String(sig.text || '');
      var saysLoading = /正在[^。\n]{0,8}加载|加载中|loading/i.test(text);
      var blank = !text.replace(/\s+/g, '') && !(Number(sig.qTotal) || 0) &&
        !(Number(sig.video) || 0) && !(Number(sig.answer) || 0) && !(Number(sig.pan) || 0);
      if (!saysLoading && !(blank && hasInventory)) return 0;
      var now = Date.now();
      if (this._taskFrameLoadingUntil > now) return this._taskFrameLoadingUntil;
      var scope = '';
      try { scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || ''))); } catch (eScope) {}
      if (scope && scope === this._taskFrameLoadingScope) return 0;
      this._taskFrameLoadingScope = scope;
      this._taskFrameLoadingUntil = now + Math.min(20000, scaledMs(15000));
      emitRuntimeLog('warn', 'task frame still loading, search window extended', {
        src: String(src || '').slice(0, 40),
        why: saysLoading ? 'loading-text' : 'blank-frame-with-attachments',
        text: text.slice(0, 24),
        holdMs: this._taskFrameLoadingUntil - now,
        hint: '帧里还写着「正在加载」（或整张白纸、可清单上明明有任务点）—— 这不叫"这一节做完了"。' +
          '本张卡片只给这一个窗口，过期后照旧推进'
      });
      return this._taskFrameLoadingUntil;
    },

    /**
     * 发现窗口的一轮续期判定 —— **就地**改 `state`（`{startedAt, until, seen, budget}`），
     * 返回这一轮窗口终点**有没有被推后**（不是"有没有看到新附件"）。
     *
     * 抽出来只因为它必须能被测：「开跑读一次、三秒后断定这节没活」就是 3.1 整节
     * 被 `nextUnit` 翻过去的直接原因，而这段算术埋在 200 行的循环里没法断言。
     * 规矩：数量**只增不减**（少了不许缩窗，否则一个抖动就把窗口清零）、
     * 每多认一个任务点补一秒搜索预算（沿用原来的 `attachmentCount--` 语义）、
     * 窗口取「按数量续的窗」与「帧还在加载窗 `loadingUntil`」的**较大者**，
     * 再被 `startedAt + scaledMs(45000)` 硬顶夹住 —— 没有顶，清单抖动就等于这条
     * 循环永不超时，而一个永不超时的悬挂会杀死整个 tick 主循环。
     */
    _noteOcsDiscoveryTick: function (state, liveCount, now, loadingUntil) {
      var seen = Number(state.seen) || 0;
      var grew = (Number(liveCount) || 0) - seen;
      var want = Number(state.until) || 0;
      if (grew > 0) {
        state.seen = Number(liveCount) || 0;
        state.budget = (Number(state.budget) || 0) + grew;
        want = Math.max(want, now + this._taskDiscoveryWindowMs(state.seen));
      }
      var lu = Number(loadingUntil) || 0;
      if (lu > want) want = lu;
      if (want > (Number(state.startedAt) || 0) + scaledMs(45000)) {
        want = (Number(state.startedAt) || 0) + scaledMs(45000);
      }
      if (!(want > (Number(state.until) || 0))) return false;
      state.until = want;
      return true;
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
          var seenInventory = (self._getChaoxingAttachments() || []).length;
          // 发现窗口的状态收在一个对象里，续期算术交给 `_noteOcsDiscoveryTick`（能断言）。
          var discovery = {
            startedAt: Date.now(),
            until: 0,
            seen: seenInventory,
            budget: seenInventory
          };
          discovery.until = discovery.startedAt + self._taskDiscoveryWindowMs(seenInventory);
          emitRuntimeLog('info', 'study begin', {
            attachments: seenInventory,
            windowMs: discovery.until - discovery.startedAt
          });

          while (version === self._runtimeVersion) {
            // ⚠️ 心跳：这是个**开放条件**的循环（等页面版本号变化才退出），
            //    里面还有 await job.func()（可能是一次完整的答题/文档任务）。
            //    不刷心跳会让"正常在推进的一轮"被看门狗当成卡死。
            self._tickProgress('ocs study loop');
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
              // 有活干 = 有进展，把"点下一节没反应"的计数清零
              self._nextUnitNoopCount = 0;
              self._nextUnitBlockedKey = '';
              // 同一份任务点被**每秒**重复匹配时不再刷屏。
              // 实测（2026-10-17）：答题链路的"无进展"窗口是 60 秒，期间每秒都会重新匹配一次，
              // 于是「study matched job」也每秒一条，把 200 条的日志缓冲刷满。
              var matchedLogKey = String(job.jobid || job.name || '');
              var matchedLogNow = Date.now();
              if (matchedLogKey !== self._matchedJobLogKey || matchedLogNow - (self._matchedJobLogAt || 0) > 10000) {
                self._matchedJobLogKey = matchedLogKey;
                self._matchedJobLogAt = matchedLogNow;
                emitRuntimeLog('info', 'study matched job', { kind: job.kind, name: job.name, workType: job.workType });
              }
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
            if (discovery.budget > 0) {
              discovery.budget--;
              await sleep(1000);
              continue;
            }
            // ⚠️ 每一轮重新问一次附件清单：**看到新的就续窗**。
            //   只在开跑那一刻读一次，就是 13:15:33 那次「读 0 → 3 秒后断定这节没活 →
            //   整节被 nextUnit 翻过去」的直接原因（同一刻 `_searchChaoxingJobOcs`
            //   自己读到的是 6 个 —— 一个函数两个口径，慢的那一个说了算）。
            var liveInventory = 0;
            try { liveInventory = (self._getChaoxingAttachments() || []).length; } catch (eInv) {}
            var grewFrom = discovery.seen;
            if (self._noteOcsDiscoveryTick(discovery, liveInventory, Date.now(), self._taskFrameLoadingUntil)) {
              if (discovery.seen > grewFrom) {
                emitRuntimeLog('info', 'study inventory grew', {
                  from: grewFrom, to: discovery.seen,
                  waitedMs: Date.now() - discovery.startedAt,
                  windowMs: discovery.until - Date.now(),
                  hint: '开跑时清单还是空的，中途才渲染出来 —— 发现窗口按新数量续期，' +
                    '别把「还没画出来」读成「没任务点」。这一轮真正多等了多久，看 windowMs'
                });
              }
            }
            if (Date.now() < discovery.until) {
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
            // 把"卡在哪几题"一起带上：只有 searchedCount 的话，看不出是
            // "模型没答上"还是"答上了但填不进 DOM"（实测 25 题只填 23 题，
            // 两种日志一模一样，只能靠人肉数题）。
            var pendingDesc = self._describePendingQuizQuestions(null);
            // ⚠️ **数不出具体待答题时不许 hold**（批次 9-C）。
            // 现场：真实日志 00:45:59 → 00:46:16 连磨两轮 `study hold quiz before finish
            // {pending:{total:0}}`，最后是页面自己刷新才走通 —— 用户看到的"在已经做完的
            // 界面磨蹭很久"就是这两轮。`_isQuizLearningPending` 走的是「页面上有题的形状」
            // 那类宽判据（`_hasActiveQuizSubmitForm` / `_detectQuiz`），而 `_extractQuestions`
            // 一道容器都没收着，于是**为 0 道题按住整节**。
            // 「该不该 hold」抽成判据 `_shouldHoldQuizBeforeFinish`（批次 9-C）——
            // 留在这一大坨循环里它没法直接测，而它恰好是"卡住整节"与"照常推进"的分岔口。
            if (self._shouldHoldQuizBeforeFinish(pendingDesc)) {
              emitRuntimeLog('info', 'study hold quiz before finish', {
                searchedCount: searchedJobs.length,
                pending: pendingDesc
              });
              self._ocsStudyStarted = false;
              return;
            }
            emitRuntimeLog('warn', 'study quiz hold skipped: nothing pending to wait for', {
              searchedCount: searchedJobs.length,
              pending: pendingDesc,
              hint: '判据说还有题要做、但一道具体的待答容器都数不出来 —— 继续 hold 只会按住这一节；为什么数不出来见上一条 quiz scan 诊断的 dropStages'
            });
            }
          }
          if (self._isActiveStudyJobPending('ocs-finish-check')) {
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-finish-check')) {
              self._tickProgress('ocs wait finish-check');
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
          // `searchedCount:0` 单独一句没法回答「凭什么说这一节做完了」——
          // 把窗口读数一起落下：这一轮到底等过几个附件、等了多久，一眼分得开
          // "真的空章节"与"清单压根没渲染出来"（2026-11-11 的 3.1 是后者）。
          emitRuntimeLog('info', 'study finished on page', {
            searchedCount: searchedJobs.length,
            attachments: discovery.seen,
            waitedMs: Date.now() - discovery.startedAt
          });
          if (self.configs.autoNext) {
            await sleep(5000);
            if (version !== self._runtimeVersion) return;
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-next-check')) {
              self._tickProgress('ocs wait next-check');
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
            // ⚠️ 防「点了下一节、页面却根本没动」的空转。
            //
            // 现场（2026-10-17 实测）：本卡片还压着一个没做完的任务点（题目），
            // 平台就不让往下走 —— `nextUnit()` 点了等于没点，于是 15 秒一轮无限循环，
            // 而日志里只有反复的 `study begin` / `study finished on page`，
            // 完全看不出"其实一步都没走"。用户看到的就是「跳过题目卡住」。
            //
            // 判据：连续 3 轮准备点下一节时，「学习进度键」**完全相同**
            //（章节 + 学习卡片 + 附件指纹三者都没变 = 前一次点击没起作用）。
            // 真的往前走了，键必然变，所以不会误伤。
            var progressKey = self._studyProgressKey();
            if (progressKey && progressKey === self._nextUnitNoopKey) {
              self._nextUnitNoopCount = (self._nextUnitNoopCount || 0) + 1;
            } else {
              self._nextUnitNoopCount = 0;
              self._nextUnitBlockedKey = '';
            }
            self._nextUnitNoopKey = progressKey;
            if (self._nextUnitNoopCount >= 3) {
              if (self._nextUnitBlockedKey !== progressKey) {
                self._nextUnitBlockedKey = progressKey;
                emitRuntimeLog('error', 'study stuck: 下一节点了没反应，已停止空转', {
                  rounds: self._nextUnitNoopCount,
                  attachments: discovery.seen,
                  hint: '本学习卡片上还有没做完的任务点，平台因此不让往下走。请手动处理它（例如把这道题做完交卷）；' +
                        '处理完会自动继续，也可在控制台执行 xxtAI.next() 手动推进'
                });
              }
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

          // 仲裁走唯一那一份顺序（原来这里手抄的链把 documentJob 排在 timereader /
          // pptWithAudio **之前** —— 与 OCS 路由那份顺序已经不一致，正是"两份顺序必漂移"的现场）
          var kind = this._kindFromChaoxingElements(elements, attachment, doc) || 'other';

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
        // 空章节时这个方法一次 tick 会被调好几次，原来每条都写日志 ——
        // 实测 5 秒能刷 8 条 warn，把 200 条环形缓冲冲掉一大截。
        var nowEmpty = Date.now();
        if (!this._lastSearchEmptyLogAt || nowEmpty - this._lastSearchEmptyLogAt > 5000) {
          this._lastSearchEmptyLogAt = nowEmpty;
          emitRuntimeLog('warn', attachments.length ? 'search job: attachments exist but no runnable job' : 'search job: no attachments and no synthetic job');
        }
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
