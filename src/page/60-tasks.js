/* ==========================================================================
 * Omitone page.js 片段 06/11 —— 任务点：识别 / 搜索 / 执行 / 调度 / 放弃名单
 * 来源：原 page.js 中散布的 69 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 从页面里找出「这一章还有哪些任务点没做」：附件、iframe 探测、OCS 搜索
 * 任务点执行与等待、文档类任务点（翻页 / 滚动）
 * **主 tick 循环** _runTick / _tick（判定顺序＝仲裁顺序，改它是高风险操作）
 * 学习卡片（小节）切换；做不完的任务点放弃名单
 *
 * 本段的方法（69 个）：
 *   _detectPageChange、_clearDocumentPendingState、
 *   _getExplicitActiveLearningCardKey、_detectLearningCardChange、
 *   _isCurrentCompleted、_skipIfCompleted、_hasTaskPoint、_classifyTaskFrame、
 *   _collectVisibleTaskFrames、_getChaoxingAttachments、_getChaoxingFrameData、
 *   _detectChaoxingJobElements、_matchChaoxingAttachment、_getChaoxingJobName、
 *   _getAttachmentWorkType、_buildAttachmentOnlyJob、_resolveJobFrame、
 *   _isJobAlreadySearched、_getAttachmentFingerprint、_buildSyntheticChaoxingJob、
 *   _buildFrameFallbackJob、_searchIFramesOcs、_searchChaoxingJobOcs、
 *   _ensureOcsStudyRunner、_searchChaoxingJob、_getVisibleTaskCompletionState、
 *   _isActiveDocumentPending、_isActiveStudyJobPending、_runChaoxingJob、
 *   _runChaoxingReadJob、_runPptAudioJob、_runOcsStyleStudy、
 *   _shouldWaitForTaskDiscovery、_getTaskIdentity、_isTaskStillLoading、
 *   _handlePendingTask、_frameHasTaskPoint、_locateDocumentTask、_extractFrameKey、
 *   _isDocumentFrameFinished、_buildPagedDocumentTask、_buildScrollDocumentTask、
 *   _handleDocumentTask、_startTickLoop、_clearTickLoop、_runTick、_tick、
 *   _taskGiveUpMap、_taskPointKey、_isTaskGivenUp、_markTaskGivenUp、
 *   _clearTaskGiveUp、_taskGiveUpList、_isJobCompleted、_taskProgressSnapshot、
 *   _countTaskIncomplete、_getLearningCards、_getLearningCardText、
 *   _getActiveLearningCardIndex、_getCurrentVisibleLearningTaskType、
 *   _isAssessmentLearningCard、_looksLikeVideoLearningCard、
 *   _findFallbackNextLearningCardIndex、_switchToNextLearningCard、nextUnit、
 *   _advanceLearningStep、_bindStepNavigation、_initCellData、_getTreeContainer
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
