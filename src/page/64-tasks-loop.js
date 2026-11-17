/* ==========================================================================
 * Omitone page.js 片段 08/15 —— 主循环 / 完成度与放弃名单 / 学习卡片推进
 * 来源：原 page.js 中散布的 28 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * ⚠️ **主 tick 循环** _runTick / _tick —— 它的判定顺序就是仲裁顺序，改它是高风险操作
 * 任务点完成度快照与「做不完就放弃」名单
 * ⚠️ _isJobCompleted 拿不准时必须返回 true（它喂给放弃计数，误判会把必做任务点跳过）
 * 章节内学习卡片（小节）的定位与切换、下一步推进
 *
 * 本段的方法（48 个）：
 *   _tickProgress、_startTickLoop、_clearTickLoop、_runTick、_tick、_taskGiveUpMap、_taskPointKey、
 *   _isTaskGivenUp、_markTaskGivenUp、_clearTaskGiveUp、_taskGiveUpList、
 *   _isJobCompleted、_taskProgressSnapshot、_countTaskIncomplete、
 *   _getExplicitActiveLearningCardKey、_detectLearningCardChange、
 *   _getLearningCards、_getLearningCardText、_getActiveLearningCardIndex、
 *   _getCurrentVisibleLearningTaskType、_isAssessmentLearningCard、
 *   _looksLikeVideoLearningCard、_findFallbackNextLearningCardIndex、
 *   _switchToNextLearningCard、nextUnit、_codeRev、_gotoUrl、_isCourseAtEnd、_courseSwitchBudget、_leaveFinishedCourse、
 *   _coursePickRequested、_courseHomeUrl、_readCourseCards、_pickNextCourseFromUserCenter、
 *   _askStudyTabState、_courseProbeCounts、_courseProbeWeight、_orderBlindByProbe、
 *   _askCourseProbe、_courseProbeDeferred、_displacedStudyPagePlan、_speakDisplacedStudyPage、
 *   _enterChapterFromCourseHome、_enterCourseHomeChapter、
 *   _advanceLearningStep、
 *   _bindStepNavigation、_initCellData、_getTreeContainer
 * ========================================================================== */
// @omitone-part-header-end

    /**
     * 进度心跳：**长任务的循环必须定期调它**。
     *
     * 看门狗原先判的是「tick 活了多久 > 150 秒」，那会误杀正常的长任务 ——
     * PPT 音频任务单页等待上限 600 秒（`_waitSlideAudioDone`），远超 150 秒。
     * 误杀的后果不是"少干点活"，而是**放锁后新一轮 tick 与仍在推进的旧 tick 并行**，
     * 同时操作同一个任务点（重复翻页 / 重复提交）。
     *
     * 改成「多久没有进展」之后语义才对：
     *   - 真挂起 → 循环不再推进 → 心跳不再刷新 → 150 秒后照旧放锁（防线没有放松）
     *   - 正常长任务 → 一直在推进 → 心跳持续刷新 → 不会被误杀
     *
     * 日志做 30 秒去重：这个函数会被每秒调用多次，不加节流会刷爆控制台。
     */
    _tickProgress: function (note) {
      try {
        var now = Date.now();
        this._tickProgressAt = now;
        var label = String(note || '');
        // 只在"换了阶段"或"距上次日志超过 30 秒"时打一条，兼作长任务耗时的观测点
        if (label !== this._tickProgressNote || now - (this._tickProgressLogAt || 0) > 30000) {
          this._tickProgressNote = label;
          this._tickProgressLogAt = now;
          var tickMs = this._tickStartedAt ? (now - this._tickStartedAt) : 0;
          emitRuntimeLog('info', 'tick progress', { note: label, tickMs: tickMs });
        }
      } catch (e) {}
    },

    _startTickLoop: function () {
      if (this._tickLoopInterval) return;
      var self = this;
      this._tickLoopInterval = setInterval(function () {
        if (!self._assertActive()) {
          self._clearTickLoop();
          return;
        }
        // 看门狗：判定「**多久没有进展**」而不是「tick 跑了多久」。
        //
        // 为什么是"无进展"：正常的长任务（PPT 音频逐页等待，上限 600 秒）会被
        // "总时长"判据误杀 —— 强行放锁后，新旧两个 tick 同时操作同一个任务点。
        // 心跳由长任务的循环主动刷新（见 _tickProgress），所以：
        //   有进展 → 不触发（这是本次修正的行为）
        //   真挂起 → 心跳停 → 150 秒后照旧触发（防线不变）
        // 兜底用 _tickStartedAt：兼容心跳尚未打过一次（字段为 0）的边界。
        var lastProgress = self._tickProgressAt || self._tickStartedAt;
        if (self._tickRunning && lastProgress && Date.now() - lastProgress > 150000) {
          // ⚠️ 必须先"作废"这次 tick 的复位权：它可能过一会儿才醒过来，
          //    醒来后无条件复位会把**新 tick 的锁**清掉 —— 于是下一轮又起一个 tick，
          //    两个 tick 并行推进（可能重复提交、重复跳章）。
          self._tickEpoch = (self._tickEpoch || 0) + 1;
          self._tickRunning = false;
          self._tickStartedAt = 0;
          self._tickProgressAt = 0;
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
      // 每拍量一次保活音轨：这一族页面里可能再也没有任何播放事件来触发它 ——
      // 尤其文档 / PPT 这类从没起过 _startVideoMonitoring 的页。
      this._syncAudioKeepalive();
      if (this._tickRunning) return;
      this._tickRunning = true;
      var myEpoch = this._tickEpoch = (this._tickEpoch || 0) + 1;
      this._tickStartedAt = Date.now();
      // 心跳与 tick 同起点：看门狗判"无进展"，所以开始那一刻必须先刷一次，
      // 否则字段为 0 会走 _tickStartedAt 兜底（也能工作，但语义上应该显式初始化）
      this._tickProgressAt = this._tickStartedAt;
      // ⚠️ 这里**不要**复位 `_tickProgressNote`。
      // 它是日志节流用的"上次打了哪个阶段"；而 `_ensureOcsStudyRunner` 那个
      // **脱离 tick 的异步循环**每 1 秒就调一次 `_tickProgress('ocs study loop')`，
      // 而 `_runTick` 每 250ms 就复位一次 —— 于是"note 变了"这个条件永远成立，
      // 心跳日志变成每秒一条，把日志缓冲刷爆、盖住真正有用的条目（实测踩过）。
      // 只保留 30 秒时间窗节流，阶段真的变了（note 不同）时照样立刻打一条。
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

        // 批次 87：这一页是**换课时我们自己导航来的课程首页** → 让站点自己那一发「进章」把顶层帧送进章节。
        // 必须排在任务点/播放那一族**之前**：首页上压根没有任务点，往下走会被
        // `looksLikeCourse`（章节节点也带 `id^="cur…"`）认成"像课程页"，空转 30 秒后去打一个
        // 首页上根本不存在的「下一节」，最后说一句误导性的 `study stuck` —— 症状正是「换了课，可刷课没开始」。
        // 判据三条都不齐时它第一行就返回 false，其它任何页面（含用户中心）一步都不受它影响。
        if (this._enterChapterFromCourseHome()) return;

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
            // ⚠️ 同一张学习卡片里可能挂着**两份**测验任务点（实测：
            //    「专题五…单元测试」+「7.4…单元测试」）。这是页面级 `_quizAnswered`
            //    的已知盲区：交完第一份后它一直是 true，`_handleQuiz` 第一行就直接
            //    return —— 第二份永远不答。这里先按"这份卷子的身份"切一次状态；
            //    同一份卷子重复调用是空操作（键不变直接返回）。
            this._syncQuizPaperRunState(this._getQuizPaperKeyFromTask(activeTask), activeTask.doc || null);
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
          // 心跳也要一起清：留着旧值会让下一轮 tick 一开始就"看起来很久没进展"
          this._tickProgressAt = 0;
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
      if (this._lastLearningTabSwitchAt && now - this._lastLearningTabSwitchAt < scaledMs(Number(this.configs.stepSwitchGraceMs || 7000))) {
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
      // 冷却窗口内**放行离开**：这里问的是「能不能走」，不是「这一卷要不要暂停」，
      // 所以不比卷子键（`_isQuizForceSkipping()` 无参调用算出来的是另一个文档的键，
      // 会把 nextUnit 拦在 hold 上 —— 见 `_isQuizSkipWindowLive` 的注释）。
      if (!this._isQuizSkipWindowLive() && this._shouldHoldQuizBeforeNext('next-unit')) return;
      if (this._switchToNextLearningCard('next-unit')) return;
      this._dismissPopups();
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) nextButton.click();
      } catch (e) {}
      this._resetRuntimeState();
    },

    /**
     * 这一页跑的到底是哪一版 page.js —— `OMITONE_CODE_REV` 是 `tools/concat-page.js`
     * 盖在产物第一行的**内容指纹**（只由片段内容决定，不掺时间戳，所以拼接可复现）。
     *
     * 为什么换课这一族非要把它写进日志（2026-11-16 现场实测）：同一台浏览器里
     * 三页可以是三个指纹 —— 磁盘 `0f0f7a2485`、刷课页 `0c68ddd917`、用户中心 `783cfdeddf`，
     * 而**只有 82 之前那一版没有选课代码**。症状是「说了『这一门刷完了，回用户中心』
     * 之后一句 picked / declined 都没有」，看着像判据坏了，其实是那个标签页重载之前
     * 的旧 page.js 还在跑（AGENTS §3.3 那一步没做）。两端的指纹都打在行上，一眼分得开。
     */
    _codeRev: function () {
      try { return String(typeof OMITONE_CODE_REV !== 'undefined' ? OMITONE_CODE_REV : 'none'); } catch (e) { return 'none'; }
    },

    // 换课这一族唯一的"离开这一页"的出口。写成方法而不是直接 `location.href=`，
    // 是为了让 e2e 能把**这一个动作**桩掉、读回"它到底想跳去哪"，
    // 而判据本身（尽头判定 / 卡片选课）照样真跑（AGENTS §5「桩要打在动作上」）。
    _gotoUrl: function (url) {
      location.href = String(url || '');
    },

    /**
     * 批次 82-A：这一门课**到尽头**了没有。三条同时成立才算，少一条就退回原来的"卡住了"分支。
     * 只在"想点下一节却点不动"的那一刻被问到 —— 我们从不因为目录说"没剩"就主动跳走。
     */
    _isCourseAtEnd: function (scan) {
      var s = scan || this._catalogCourseScan();
      return !!(s && s.ready && s.leaves > 0 && s.unfinished === 0 && !(Number(s.activeLeft) > 0));
    },

    // 用户中心（课程卡片列表）的地址。现场实测域名是 `i.mooc.chaoxing.com`（2026-11-16，
    // 那一页 `ws=2` 是「课程」那一栏）；换课整条链路只有这一个外部地址，写死在这里好查。
    _COURSE_PICKER_BASE: 'https://i.mooc.chaoxing.com/space/index?ws=2',

    /**
     * 批次 87：换课要落的是**课程首页**，不是卡片自己那条 `stucoursemiddle` 链接。
     *
     * 现场实测（2026-11-16，38 门里 36 门）：卡片那条 href 的 302 链是
     * `visit/stucoursemiddle?courseid=&clazzid=` → `mooc1/mooc-ans/mycourse/studentcourse?…&fromMiddle=1`
     * （一张 JS 中转壳：`chapter_item` 0 个、`toOld` 0 次）→ 最后停在
     * `mooc2-ans/mycourse/stu?courseid=&clazzid=` —— 那里少一个 `ut=s`，
     * 站点回的是 **781 字节的「无效的参数」**。于是"课是换了"，可顶层帧既没目录也没任务点，
     * 日志只会说一句"这一页认不出课程结构"，而**刷课根本没开始**。
     * 同一对号换到下面这一族：108824 字节、61 个 `chapter_item`、站点自己的 `toOld(...)`
     * 就挂在第一个章节点上（顶层帧实测 `typeof window.toOld === "function"`、`isToOldLink` 为 false）。
     */
    _COURSE_HOME_BASE: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse',

    /**
     * 拼课程首页地址。两个号都必须**纯数字**（它们只从同一张卡片上成对读出来，
     * 拿别班的 `clazzid` 必 403 —— AGENTS §2 #12），拼不出来就交空串给调用方定性。
     * `omitonePick=1` 是"这一页是我们自己导航来的"那一族标记：跨站导航时 sessionStorage
     * 是两块地方，只有地址能带话（批次 82-B 的口径）。
     */
    _courseHomeUrl: function (courseId, clazzId) {
      var c = String(courseId || '');
      var k = String(clazzId || '');
      if (!/^\d+$/.test(c) || !/^\d+$/.test(k)) return '';
      return this._COURSE_HOME_BASE + '?courseid=' + c + '&clazzid=' + k + '&ut=s&omitonePick=1';
    },

    // 一次登录会话里最多连着换几门课的**下限**。**真正防乒乓的是 `tried` 名单**（同一门六小时内只进一次），
    // 这一格只是给"这一轮最多点开多少扇门"封个底。批次 85 从 8 提到 30 —— 因为现在读不到进度的
    // 卡片也会进去问一次目录，课多的人（现场 38 张卡）不该被 8 门挡在"请手动"上。
    _COURSE_SWITCH_LIMIT: 30,

    /**
     * 批次 86：换课预算按**用户中心里实际有多少门可进的课**来给，取它和 `_COURSE_SWITCH_LIMIT` 的较大值。
     *
     * 为什么不能写死：同一门六小时内只进一次是 `tried` 名单管的，所以"把整张课表走完"这件事
     * 结构上不可能乒乓 —— 一个数字卡在那儿，唯一的作用是让课多的人**刷不完自己的课**
     *（现场 38 张卡片、上限 30，剩 8 门会被一句"到上限了"拦下）。
     */
    _courseSwitchBudget: function (cards) {
      var c = cards || { picked: [], unknown: [] };
      var navigable = (c.picked || []).length + (c.unknown || []).length;
      return Math.max(this._COURSE_SWITCH_LIMIT, navigable);
    },

    /**
     * 批次 82-B：这门课刷完了 → 回用户中心挑下一门。
     *
     * ⚠️ **状态只能挂在地址上**：刷课页在 `mooc1.chaoxing.com`，用户中心在 `i.mooc.chaoxing.com`，
     *    不同源的 sessionStorage 在同一个标签页里是**两块地方**，
     *    在刷课页写的账到了用户中心读不回来（反之也一样）。所以"是谁让我来挑课的"用
     *    `omitonePick=1` 这个查询参数带过去；**换了几门**的账则整个记在用户中心自己那一块
     *    sessionStorage 里（换课永远要经过这一页，账就写在这页，天然不会丢）。
     * @returns {boolean} true = 这一拍我认领了（要么已经走人，要么明确决定留下），别再打"卡住"那条 error
     */
    _leaveFinishedCourse: function (reason) {
      var scan = this._catalogCourseScan();
      if (!this._isCourseAtEnd(scan)) return false;
      if (this._courseSwitchAt && Date.now() - this._courseSwitchAt < 60000) return true;
      this._courseSwitchAt = Date.now();
      var ev = {
        reason: String(reason || ''),
        sections: scan.leaves,
        unfinished: scan.unfinished,
        rev: this._codeRev(),
        activeLeft: Number(scan.activeLeft) > 0 ? scan.activeLeft : 0
      };
      if (!this.configs.autoNextCourse) {
        emitRuntimeLog('warn', 'course finished, auto switch is off', Object.assign({
          hint: '目录里 ' + scan.leaves + ' 个小节全打了完成勾、站点的「下一节」也点不动 —— 这一门**刷完了**。' +
            '自动换下一门的开关（任务点 → 刷完自动换下一门）现在是关的，所以停在这里。' +
            '想让它自己接着挑下一门，去面板里打开它',
          everyMs: 0
        }, ev));
        return true;
      }
      var url = '';
      try {
        url = this._COURSE_PICKER_BASE + '&omitonePick=1' +
          (scan.courseId ? '&omitoneDone=' + encodeURIComponent(scan.courseId) : '');
      } catch (eU) { url = ''; }
      if (!url) return false;
      emitRuntimeLog('warn', 'course finished, back to user center', Object.assign({
        hint: '这一门课目录里已经没有没做完的小节了，插件现在回用户中心挑一门接着刷：' +
          '先挑卡片上写着「任务点进度 a/b 且 a<b」里进度最远的那门，一门都没有就进那些' +
          '没写进度行的卡片**让目录判** —— 到那边之后还会有一条 picked / declined 说明挑没挑上',
        href: url.slice(0, 120),
        everyMs: 0
      }, ev));
      try { this._gotoUrl(url); } catch (eNav) { return false; }
      return true;
    },

    // 我们自己导航到用户中心时留在地址上的标记。用户自己打开用户中心时它不存在，
    // `_pickNextCourseFromUserCenter` 第一行就返回 false —— 绝不因为"顺便路过的这一页"去动他的浏览器。
    // ⚠️ 两侧都认大小写：我们**自己种进去**的参数经站点中转后会被改写（现场读回 `omitonepick`），
    //    写死小写、读的时候不分大小写（AGENTS §2 #12）。
    _coursePickRequested: function () {
      try { return /[?&]omitonepick=1/i.test(String(location.search || '')); } catch (e) { return false; }
    },

    /**
     * 批次 93：问后台两件事 ——「这一枚标签页刚才是不是学习页」「现在有几枚学习页」。
     *
     * ⚠️ **这条不许 await**。它的调用点 `_tryAdvanceIdleSection` 是同步的，返回值就是
     *    「这一拍我认领了没有」；把它改成 async 会让调用点拿到一个恒真值的 Promise，
     *    等于把整条空转逃生门的判定顺序换掉（AGENTS §2 #8 那一族）。
     *    所以这里只负责把答案放进缓存，判定读缓存；缓存还没答案 = 「还在问」那一格，
     *    那一格由调用方说**老地板**（`study idle declined`：这一页认不出课程结构）——
     *    问到之前那句话本来就是真话，而"在问"绝不许变成"这一拍什么都不说"。
     */
    _askStudyTabState: function (now) {
      var cache = this._studyTabStateCache;
      // 「还在问」与「问过、答案没用」是两格，各用各的地板；两格都不许**永久**哑掉。
      // ⚠️ 问出来的失败答案也必须有个地板：停在门户页时每拍（2 秒）都会走到这里，
      //    没有地板就等于每 2 秒敲一次后台，而下一拍判出来的还是同一格（批次 37/51 那一族的查询版）。
      if (cache && !cache.answered && cache.pendingAt && now - cache.pendingAt < DISPLACED_ASK_PENDING_MS) return;
      if (cache && cache.answered && now - cache.at < DISPLACED_ASK_FRESH_MS) return;
      this._studyTabStateCache = {
        pendingAt: now, at: 0, answered: false, ok: false, reason: '', studyHref: '',
        studyAgeMs: -1, awayMs: 0, otherStudyTabs: -1, rescues: -1, mayRescue: false
      };
      var self = this;
      // ⚠️ `_withTimeout` 超时是 `resolve(undefined)`（AGENTS §2 #2），所以下面必须先认 `!data`
      Promise.resolve(this._withTimeout(bridgeSend('study_tab_state'), 8000)).then(function (data) {
        var ok = !!(data && data.success === true && typeof data.reason === 'string' && data.reason);
        // ⚠️ 枚数只在**答案可用**时读：`Number(undefined)` 是 0，而桥超时交的正是 `undefined` ——
        //    那样会把「问不到」记成「确认账号里没有别的学习页」，取证里就成了一个凭空的断言
        //    （AGENTS §2 #12：读不出必须单独占一格，不许被压进任何一格）。
        var others = ok ? Number(data.otherStudyTabs) : NaN;
        if (!Number.isFinite(others) || others < 0) others = -1;
        self._studyTabStateCache = {
          pendingAt: 0,
          at: Date.now(),
          answered: true,
          ok: ok,
          reason: ok ? String(data.reason) : 'unreadable',
          why: ok ? '' : String((data && data.error) || '后台没给答案').slice(0, 80),
          studyHref: ok ? String(data.studyHref || '') : '',
          studyAgeMs: ok ? Number(data.studyAgeMs) : -1,
          awayMs: ok ? Number(data.awayMs) || 0 : 0,
          otherStudyTabs: others,
          rescues: ok ? Number(data.rescues) : -1,
          mayRescue: ok ? data.mayRescue === true : false
        };
      }).catch(function () {
        self._studyTabStateCache = {
          pendingAt: 0, at: Date.now(), answered: true, ok: false, reason: 'unreadable', why: '问后台这条路本身抛了',
          studyHref: '', studyAgeMs: -1, awayMs: 0, otherStudyTabs: -1, rescues: -1, mayRescue: false
        };
      });
    },

    /**
     * 批次 93：四态判定（纯函数，`tools/integration-test.js` 把它取出来真跑）。
     *
     * 为什么非要分四格：现场那一枚停在用户中心的标签页，过去只会说一句
     * 「这一页认不出课程结构…请手动回到章节页」（AGENTS §2 #12 压成两态的那一族），
     * 而底下有四种完全不同的真相 —— 我们能自己回去 / 另一门占着账号不能抢（#15）/
     * 回去过两次还被顶下来（该交给人的）/ 这页压根是用户自己开的（不欠他一句"回章节页"）。
     * 压成一句时，"不用管"和"这一门一直没刷"在用户眼里长得一模一样。
     *
     * @returns {string} 'asking' 还没问到答案（交回调用方说老话）· 'silent' 答案有了但这条刚说过
     *                   'go-back' · 'another-page' · 'gave-up' · 'not-ours' · 'unknown'
     */
    _displacedStudyPagePlan: function (cache, now, lastAct, lastAt) {
      if (!cache) return 'asking';
      if (!cache.ok) {
        // ⚠️ 只有「还没问到答案」才允许不说话；「问到过、但答案没用」必须**立刻**落进读不出那一格，
        //    否则后台一直答非所问时这一族就永久哑掉（AGENTS §2 #7：静默永久跳过不可接受）。
        if (!cache.answered && cache.pendingAt && now - cache.pendingAt < DISPLACED_ASK_PENDING_MS) return 'asking';
        return 'unknown';                       // 问了没答案 = 读不出，单独占一格
      }
      var act = cache.mayRescue === true ? 'go-back'
        : cache.reason === 'another-study-tab' ? 'another-page'
        : cache.reason === 'rescue-cap' ? 'gave-up'
        : (cache.reason === 'never-study' || cache.reason === 'study-too-long-ago') ? 'not-ours'
        : 'unknown';       // others-unknown（数不出几枚学习页，后台因此不许导航）与后台给了个没见过的都落这一格
      // 重复的口径：不是插件带来的那一格**每份页面只说一次**（批次 54-D / 89 同族）；
      // 其余三格 5 分钟内同一条不重播，但**不许永久哑掉** —— 换态了就立刻再说。
      if (lastAct === act) {
        if (act === 'not-ours') return 'silent';
        if (act !== 'unknown' && now - (Number(lastAt) || 0) < DISPLACED_SILENCE_MS) return 'silent';
      }
      return act;
    },

    /**
     * 批次 93：把上面那一格落成日志与（只在安全时的）导航。
     * @returns {boolean} true = 这一拍已经处理过，调用方不必再走「卡住了」那条 error；
     *                    false = 「还在问」与「读不出」两格，交回调用方按老口径说话
     *                    （**既不导航也不闭嘴** —— AGENTS §2 #7：静默跳过不可接受）
     */
    _speakDisplacedStudyPage: function (now) {
      this._askStudyTabState(now);
      var cache = this._studyTabStateCache;
      var act = this._displacedStudyPagePlan(cache, now, this._displacedSpokeAct, this._displacedSpokeAt);
      // ⚠️ 「还在问」与「问不出」两格都必须**交回调用方说老话**，不许这一拍认领却一句话都不说。
      //    以前这里让「还在问」也认领（return true 不说话），全量 e2e 当场红两条：
      //    批次 20-I「被挡下一定出日志」与批次 89 C「被顶下线现场只剩 `study idle declined` 能认」。
      //    沙盒里桥永远答不上来 = 永远停在「还在问」= 这一族彻底哑掉，正是 AGENTS §2 #7 禁止的那一格；
      //    而「认不出课程结构」这句话在问到答案之前本来就是**真话**，当下唯一该说的就是它。
      if (act === 'unknown' || act === 'asking') return false;
      var c = cache || {};
      var ev = {
        reason: String(c.reason || ''),
        studyAgeMs: Number(c.studyAgeMs),
        awayMs: Number(c.awayMs) || 0,
        otherStudyTabs: Number(c.otherStudyTabs),
        rescues: Number(c.rescues),
        href: String(location.href || '').slice(0, 90),
        everyMs: act === 'not-ours' ? 0 : DISPLACED_SILENCE_MS
      };
      if (act === 'silent') return true;
      if (act === 'go-back' && c.studyHref) {
        emitRuntimeLog('warn', 'study displaced, going back', Object.assign({
          hint: '这一枚标签页刚才还在刷课，被站点推到了没有课程结构的地址。' +
            '现在账号下没有别的学习页占着，插件就把它自己送回去 —— 是同一枚标签页内导航，' +
            '绝不新开一枚（新开等于把另一门顶下线）',
          target: String(c.studyHref).slice(0, 90)
        }, ev));
        this._displacedSpokeAt = now;
        this._displacedSpokeAct = act;
        try { this._gotoUrl(c.studyHref); } catch (eNav) { return true; }
        return true;
      }
      if (act === 'another-page') {
        emitRuntimeLog('warn', 'study displaced, held back', Object.assign({
          hint: '这一枚标签页刚才也在刷课，被站点顶了回来。但账号下还有 ' + (Number(c.otherStudyTabs) || 1) +
            ' 枚学习页活着 —— 同一账号一次只许有一枚，这时候把它送回去就会把那一枚顶下线，' +
            '所以这一枚先不动，等那门刷完再排它',
          willRetryInMs: DISPLACED_SILENCE_MS
        }, ev));
      } else if (act === 'gave-up') {
        emitRuntimeLog('warn', 'study displaced, gave up', Object.assign({
          hint: '这一枚已经自己回过 ' + (Number(c.rescues) || 0) + ' 次学习页，每次都被站点顶回来 —— ' +
            '再打转只会把进度越带越偏。这一门请手动打开一次章节页，或者去面板里把它排到队首'
        }, ev));
      } else {
        emitRuntimeLog('info', 'study idle: not our page', Object.assign({
          hint: '这一页不是插件带来的，插件也没在这页刷过课（' +
            (c.reason === 'study-too-long-ago' ? '上一次刷课是 ' +
              Math.round((Number(c.studyAgeMs) || 0) / 60000) + ' 分钟前' : '这页从没当过学习页') +
            '），所以这里不点「下一节」、也不催你回章节页 —— 每份页面只说这一次'
        }, ev));
      }
      this._displacedSpokeAt = now;
      this._displacedSpokeAct = act;
      return true;
    },

    /**
     * 批次 82-C：读用户中心的课程卡片。两类分开交 ——
     *   `picked`  卡片上写得到「任务点进度: 已完成/总数」，可以按比率排序挑最远的先收尾
     *   `unknown` 卡片上**没有**那一行（同班次的其它课常常是这个形状），但链接是学习通自己的
     *
     * 现场实测（2026-11-16，38 张卡）：16 张读得到这一行（8 张 a<b、8 张 a===b），
     * 另外 **22 张压根没有这一行**（卡片形状与链接跟前面那 16 张一模一样）。
     * ⚠️ 批次 85 改过口径：以前那 22 张直接**不碰**、只在 decline 里报个数让人手动。
     *    那是把"预筛"当成了"判据" —— 一门课到底做没做完，**权威判据是目录那本账**
     *    （`_catalogCourseScan`：每节都带 `.icon_Completed` 才算刷完），卡片上那一行只是
     *    省一次导航的便宜筛子。读不到数就甩回手动，等于把"我没证据"的活儿推回给用户。
     *    现在 `unknown` 排在 `picked` 之后当兜底：真跳进一门早就刷完的课，代价是
     *    「进去 → 目录说全打勾 → 原路回来换下一门」，**一个任务点都不做、一次 API 都不发**，
     *    而且 `tried` 名单保证同一门六小时内只进一次 —— 不会空转一整晚。
     *
     * ⚠️ 卡片**不在用户中心那一页的顶层文档里**（2026-11-16 实地量：顶层 `.course` = 0，
     *    38 张全在 `#frame_content` = `mooc2-ans.chaoxing.com/visit/interaction` 里面）。
     *    那个帧**读得到**，因为站点两边都写了 `document.domain='chaoxing.com'`（跨子域脚本互访的老机制），
     *    所以 `contentDocument` 不抛 —— 只查顶层的话这一条恒为"没有候选"，换课永远停在那句 decline 上。
     *    反过来讲：万一哪天站点不写 `document.domain` 了，`contentDocument` 抛 SecurityError，
     *    这里必须**跳过那一帧**继续走（裸读会当场打断整拍），结果退化成 decline 而不是崩 —— 与
     *    README §6 #2 是同一条规矩。e2e 的夹具因此刻意把卡片只放在子帧里，顶层一枚都不放。
     */
    _readCourseCards: function () {
      var res = { picked: [], unknown: [], noProg: 0, noClazz: 0, docs: 0 };
      var docs = [];
      try { docs.push(document); } catch (eTop) { docs = []; }
      try {
        var fr = document.querySelectorAll('iframe');
        for (var i = 0; i < fr.length; i++) {
          var d = null;
          try { d = fr[i].contentDocument; } catch (eCross) { d = null; }   // 跨域帧读不到就跳过，不裸读
          if (d && docs.indexOf(d) === -1) docs.push(d);
        }
      } catch (eFr) {}
      for (var k = 0; k < docs.length; k++) {
        var list = null;
        res.docs++;
        try { list = docs[k].querySelectorAll('.course'); } catch (eQ) { continue; }
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          var txt = '';
          try { txt = String(list[j].innerText || '').replace(/\s+/g, ' '); } catch (eT) { txt = ''; }
          var href = '';
          try {
            var a = list[j].querySelector('a[href*="stucoursemiddle"]');
            href = a ? String(a.getAttribute('href') || '') : '';
          } catch (eA) { href = ''; }
          // 只走学习通自己的域名：卡片链接由页面提供，不收来路不明的地址（防被改成外站跳转）
          var navigable = /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com\//i.test(href);
          // ⚠️ 批次 87：候选必须**同时**读得到 `courseid` 与 `clazzid` —— 进课地址是
          //   `mooc2-ans/mycourse/studentcourse?courseid=&clazzid=&ut=s`，这两个号**成对**来自同一张卡片，
          //   少一个或拿错（拿别班的 clazzid）站点直接回 403 /「无效的参数」（AGENTS §2 #12）。
          //   读不到 clazzid 的卡片单独占一格（`noClazz`）报给用户，不许悄悄当成"没有下一门"。
          var cidM = href.match(/courseid=(\d+)/i);
          var clazzM = href.match(/clazzid=(\d+)/i);
          var cid = cidM ? String(cidM[1]) : '';
          var clazz = clazzM ? String(clazzM[1]) : '';
          var homeUrl = this._courseHomeUrl(cid, clazz);
          if (navigable && !homeUrl) res.noClazz++;
          var enterable = navigable && !!homeUrl;
          var m = txt.match(/任务点进度[:：]?\s*(\d+)\s*\/\s*(\d+)/);
          if (!m) {
            if (/course/.test(String(list[j].className || ''))) res.noProg++;
            if (enterable) {
              res.unknown.push({
                href: href,
                homeUrl: homeUrl,
                courseId: cid, clazzId: clazz,
                name: txt.replace(/\s+/g, ' ').trim().slice(0, 24)
              });
            }
            continue;
          }
          if (!enterable) continue;
          res.picked.push({
            done: Number(m[1]), total: Number(m[2]), href: href,
            homeUrl: homeUrl,
            courseId: cid, clazzId: clazz,
            name: txt.replace(/任务点进度[:：]?\s*\d+\s*\/\s*\d+/, '').replace(/\s+/g, ' ').trim().slice(0, 24)
          });
        }
      }
      return res;
    },

    /**
     * 批次 97：探针回答按判法计数（AGENTS §2 #12：四态报数，「读不出」单独占一格）。
     *
     * ⚠️ 没答案时每一格都是 **-1，不是 0**。`0` 在日志里读起来就是「确认没有还要刷的门」，
     *    而真相是「还没问到」—— 批次 93 实测踩过这条（`Number(undefined)` 读出 0，凭空多出一条
     *    方向是放行的断言）。`pAsk` 写的是字符串，读的人一眼分得开没问 / 还在问 / 问了问不出 / 问到了。
     * @returns {object} 平铺的取证字段，调用方 Object.assign 进日志 meta
     */
    _courseProbeCounts: function () {
      var cache = this._courseProbeCache;
      var out = { pAsk: 'no', pRows: -1, pNeed: -1, pDone: -1, pNoPts: -1, pUnread: -1, pBlocked: -1, pEmpty: -1, pSkip: -1, pMs: -1 };
      if (!cache) return out;
      if (!cache.answered) { out.pAsk = 'pending'; return out; }
      if (!cache.ok) { out.pAsk = 'fail'; out.pWhy = String(cache.why || '').slice(0, 80); return out; }
      out.pAsk = 'ok';
      var rows = cache.rows || {};
      var keys = Object.keys(rows);
      out.pRows = keys.length;
      out.pMs = Number(cache.ms) >= 0 ? Number(cache.ms) : -1;
      for (var i = 0; i < keys.length; i++) {
        var v = String(rows[keys[i]].verdict || '');
        if (v === 'need') out.pNeed++;
        else if (v === 'done') out.pDone++;
        else if (v === 'nopoints') out.pNoPts++;
        else if (v === 'blocked') out.pBlocked++;
        else if (v === 'empty') out.pEmpty++;
        else if (v === 'skip') out.pSkip++;
        else out.pUnread++;   // 包括后台给了个不认识的判法 —— 一律算「读不出」，不许并进已完成
      }
      return out;
    },

    // 判法 → 对用户说的那句话（日志 hint 读这一份，别在句子处再抄一遍英文原词）
    _COURSE_PROBE_SAY: {
      need: '还有任务点没完成',
      done: '站点说这一门已经刷完',
      nopoints: '站点说这一门没有任务点要刷',
      empty: '站点说这一门暂无章节内容',
      blocked: '这一门现在问不出进不进得去（进不去 ≠ 刷完了）',
      unreadable: '站点没给出读得出的进度（进去让目录判）',
      skip: '这一轮没来得及问它'
    },
    // 判法 → 挑选优先级（小的先挑）。`skip` 与 `unreadable` 同格：都没答案，都照旧许进门。
    _COURSE_PROBE_RANK: { need: 0, unreadable: 1, skip: 1, nopoints: 2, done: 3, blocked: 4, empty: 5 },

    /**
     * 批次 97：把「这一门在挑选里排第几」算成一个数（小的先挑）。
     *
     * ⚠️ 判法**只用来排队，不用来筛掉候选**：把「站点说已完成」当成"不用进门"，就等于拿一个
     *    会过期的首页读数永久关掉这门课的门（AGENTS §2 #12 的反面；批次 85 的出口必须留着）。
     *    没问过 / 没答上 / 后台给了个不认识的判法 → 一律落在「读不出」那一格，照旧允许进门。
     * 同一格内按站点自己报的「还差多少任务点」从多到少，让差得最多的那门先被推。
     */
    _courseProbeWeight: function (row) {
      var rank = this._COURSE_PROBE_RANK;
      var unknown = rank.unreadable * 1000;
      if (!row) return unknown;
      var bucket = rank[row.verdict];
      if (typeof bucket !== 'number') bucket = rank.unreadable;
      var left = Number(row.jobsAll) - Number(row.jobsDone);
      if (!(left > 0)) left = Number(row.yi) > 0 ? Number(row.yi) : 0;
      return bucket * 1000 - Math.min(999, left);
    },

    /** 按判法给「卡片没写进度」那一族排队；权重相同的门靠排序稳定性保住卡片顺序。 */
    _orderBlindByProbe: function (list) {
      var cache = this._courseProbeCache;
      var rows = cache && cache.ok ? cache.rows : null;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var card = list[i];
        var row = rows ? rows[String(card.courseId) + ':' + String(card.clazzId)] : null;
        out.push({ card: card, row: row || null, weight: this._courseProbeWeight(row) });
      }
      out.sort(function (a, b) { return a.weight - b.weight; });
      return out;
    },

    /**
     * 批次 97：问后台「这些门的课程首页还剩多少任务点」—— **只放进缓存，绝不在这里 await**。
     *
     * 调用点 `_pickNextCourseFromUserCenter` 的返回值就是「这一拍我认领了没有」，把它改成 async
     * 等于换掉整条换课的仲裁顺序（AGENTS §2 #8）。所以判定那一拍读缓存，缓存没答案 = 「还在问」
     * 那一格，由 `_courseProbeDeferred` 说话并认领，到预算点再用手里有的往下走（批次 93 同族手法）。
     * @param {number} now 本次判定的时间基准
     * @param {Array} blind 卡片上没写「任务点进度」的那一族候选
     */
    _askCourseProbe: function (now, blind) {
      var cache = this._courseProbeCache;
      if (cache && !cache.answered && cache.pendingAt && now - cache.pendingAt < COURSE_PROBE_PENDING_MS) return;
      if (cache && cache.answered && now - cache.at < COURSE_PROBE_FRESH_MS) return;
      var list = [];
      for (var i = 0; i < (blind || []).length; i++) {
        var card = blind[i];
        if (!card || !card.courseId || !card.clazzId) continue;
        list.push({ cid: String(card.courseId), clazz: String(card.clazzId) });
      }
      if (!list.length) return;   // 没有盲候选就别敲后台
      this._courseProbeCache = { pendingAt: now, at: 0, answered: false, ok: false, rows: {}, asked: 0, ms: -1, why: '' };
      var self = this;
      // ⚠️ `_withTimeout` 超时交回的是 `undefined`（AGENTS §2 #2），所以下面先认 `!data`
      Promise.resolve(this._withTimeout(bridgeSend('course_home_probe', { list: list }), COURSE_PROBE_ASK_MS)).then(function (data) {
        var ok = !!(data && data.success === true && Array.isArray(data.rows));
        var map = {};
        if (ok) {
          for (var j = 0; j < data.rows.length; j++) {
            var r = data.rows[j];
            if (r && r.cid) map[String(r.cid) + ':' + String(r.clazz || '')] = r;
          }
        }
        self._courseProbeCache = {
          pendingAt: 0,
          at: Date.now(),
          answered: true,
          ok: ok,
          rows: map,
          asked: ok ? Number(data.asked) : -1,
          ms: ok ? Number(data.ms) : -1,
          why: ok ? '' : String((data && (data.error || data.code)) || '后台没给答案').slice(0, 80)
        };
      }).catch(function () {
        self._courseProbeCache = {
          pendingAt: 0, at: Date.now(), answered: true, ok: false, rows: {}, asked: -1, ms: -1,
          why: '问后台这条路本身抛了'
        };
      });
    },

    /**
     * 批次 97：「还在问」那一格 —— 认领这一拍，但**不**置 `_coursePickDone`（下一拍还要再来读答案）。
     *
     * ⚠️ 这一格必须说话（AGENTS §2 #14：「还不知道」不许实现成"这一拍什么都不说，还顺手把这一拍认领走"）。
     * ⚠️ 也必须**有界**：预算一到就照手里有的答案挑，探针再慢也不许把换课钉死在这一页上。
     * @returns {boolean} true = 这一拍先等着，调用方直接认领、不要再另起一句 decline
     */
    _courseProbeDeferred: function (now, count) {
      var cache = this._courseProbeCache;
      if (!cache || cache.answered) return false;
      if (!(now - Number(cache.pendingAt) < COURSE_PROBE_DEFER_MS)) return false;
      if (!this._courseProbeSpokeAt || now - this._courseProbeSpokeAt >= COURSE_PROBE_SPOKE_MS) {
        this._courseProbeSpokeAt = now;
        emitRuntimeLog('info', 'course switch probing course homes', {
          hint: '上一门刷完了，可用户中心里有 ' + count + ' 门课的卡片上没写「任务点进度」。' +
            '插件先在后台挨门读一遍站点自己的课程首页（只读 HTML，不动那枚正在播的学习页，也不新开标签），' +
            '最多等 ' + Math.round(COURSE_PROBE_DEFER_MS / 1000) + ' 秒；到点没问完就照卡片顺序进一门，让目录判。' +
            '问出来的先后是「还要刷 → 读不出 → 没有任务点 → 已完成 → 进不去 → 目录为空」，' +
            '只改挑谁的顺序，不把任何一门从名单里删掉',
          everyMs: 0
        });
      }
      return true;
    },

    /**
     * 批次 82-B/C + 85：在**我们自己导航来的**用户中心页上挑一门接着刷的课。
     *
     * 挑法：先接着学「已经开了头但没学完」的那门（比率最大），比率相同按卡片顺序 ——
     * 免得每门都开个头、38 门全停在半路。这一族空了再退到「卡片没写进度行」的那一族，
     * 按卡片顺序进一门**让目录判**（批次 85：读不到 ≠ 叫用户手动）。
     * 两族都在 `tried` 里（本轮进过）→ 才停下来说话。
     * @returns {boolean} true = 这一页归我管了（调用方别再打「认不出课程结构」那条 warn）
     */
    _pickNextCourseFromUserCenter: function () {
      if (!this._coursePickRequested()) return false;
      if (this._coursePickDone) return true;
      // 批次 97：这一行原来在这里无条件置位。现在「还在问探针」那一格要先等几拍，
      // 所以「这一页不再重看」改到真要做决定之前才置（下面四处），等答案的那一拍不设。
      var pickNow = Date.now();
      var ledger = null;
      try { ledger = this._readSessionLedger('omitone:course-switch'); } catch (eL) { ledger = null; }
      if (!ledger || typeof ledger !== 'object') ledger = { sw: 0, tried: [], at: Date.now() };
      if (!(ledger.sw >= 0) || !Array.isArray(ledger.tried)) ledger = { sw: 0, tried: [], at: Date.now() };
      if (Date.now() - Number(ledger.at || 0) > 6 * 3600 * 1000) { ledger.sw = 0; ledger.tried = []; ledger.at = Date.now(); }
      var justDone = '';
      try { justDone = String((String(location.search || '').match(/[?&]omitoneDone=(\d+)/) || [])[1] || ''); } catch (eD) { justDone = ''; }
      if (justDone && ledger.tried.indexOf(justDone) === -1) ledger.tried.push(justDone);
      var cards = this._readCourseCards();
      var budget = this._courseSwitchBudget(cards);
      var ev = { sw: ledger.sw, limit: budget, tried: ledger.tried.length, cards: cards.picked.length, noProg: cards.noProg, unknown: cards.unknown.length, noClazz: cards.noClazz, rev: this._codeRev() };
      if (!this.configs.autoNextCourse) {
        this._coursePickDone = true;
        emitRuntimeLog('warn', 'course switch declined: auto switch is off', Object.assign({
          hint: '这一页是插件自己为了换课导航过来的，但「刷完自动换下一门」已经关掉了，' +
            '所以这里一步都不做 —— 请自己挑一门进去，或者把那个开关打开',
          everyMs: 0
        }, ev));
        return true;
      }
      if (ledger.sw >= budget) {
        this._coursePickDone = true;
        emitRuntimeLog('warn', 'course switch declined: switch budget used up', Object.assign({
          hint: '这一次已经连续换了 ' + ledger.sw + ' 门课，到上限了（上限 = 这一页能进的课的数量，' +
            '最少 30 —— 不是拍脑袋的数，是真的换完了才会碰到）。' +
            '插件停在这里不再自动换课 —— 想继续就手动进下一门，或者关掉再打开刷课让它重新起账',
          everyMs: 0
        }, ev));
        return true;
      }
      var best = null;
      for (var i = 0; i < cards.picked.length; i++) {
        var c = cards.picked[i];
        if (!(c.total > 0) || !(c.done < c.total)) continue;
        if (c.courseId && ledger.tried.indexOf(c.courseId) !== -1) continue;
        var ratio = c.total > 0 ? c.done / c.total : 0;
        if (!best || ratio > best.ratio) best = { card: c, ratio: ratio, blind: false };
      }
      // 批次 85：读得到进度的候选一个都不剩时，退到「卡片上没写进度那一行」的那一族 ——
      // **进去问目录**，别把活儿推回给用户。已进过的（`tried`）跳过，所以这一支每门只走一次。
      if (!best) {
        // 批次 97：卡片没写进度那一族，先在后台读一遍站点自己的课程首页（只读、串行、有预算），
        // 判法只改挑选顺序、绝不删候选；问不出时照旧走批次 85 那条「进去让目录判」。
        this._askCourseProbe(pickNow, cards.unknown);
        if (this._courseProbeDeferred(pickNow, cards.unknown.length)) return true;
        var ordered = this._orderBlindByProbe(cards.unknown);
        for (var u = 0; u < ordered.length; u++) {
          var uc = ordered[u].card;
          if (uc.courseId && ledger.tried.indexOf(uc.courseId) !== -1) continue;
          best = { card: uc, ratio: NaN, blind: true, probe: ordered[u].row };
          break;
        }
      }
      this._coursePickDone = true;
      Object.assign(ev, this._courseProbeCounts());
      if (!best) {
        emitRuntimeLog('warn', 'course switch declined: no course with unfinished task points', Object.assign({
          hint: '用户中心里的卡片这一轮**都进过了**：写得到「任务点进度 a/b」的要么学完、要么进过，' +
            '读不到那一行的 ' + cards.unknown.length + ' 张也都进去让目录判过一遍了（判据是目录的完成勾，不是卡片那一行）。' +
            (cards.noClazz ? '另有 ' + cards.noClazz + ' 张卡片上「课程号 + 班号」配不齐 —— 那一族是**进不去**，不是刷完了。' : '') +
            '所以这一次没有下一门 —— 要么真的全刷完了，要么等六小时换课名单重新起账再试',
          everyMs: 0
        }, ev));
        return true;
      }
      ledger.sw = Number(ledger.sw || 0) + 1;
      ledger.at = Date.now();
      try { this._writeSessionLedger('omitone:course-switch', ledger); } catch (eW) {}
      emitRuntimeLog('warn', 'course switch picked next', Object.assign({
        hint: best.blind
          ? '上一门已经刷完。这一门卡片上没写「任务点进度」' +
            (best.probe
              ? '，站点自己的课程首页说：' + (this._COURSE_PROBE_SAY[String(best.probe.verdict)] || '判法不认识，按读不出办') + '。'
              : '，插件在后台也没问出它的进度。') +
            '插件**先当它没刷完进去看一眼**：' +
            '目录里每节都打了勾就原样回来换下一门（一个任务点都不做、一次 API 都不发），' +
            '有没勾的小节就从站点落的那一节开始推'
          : '上一门已经刷完，现在进这一门继续（进度 ' + best.card.done + '/' + best.card.total + '）。' +
            '落点是这门课的课程首页（卡片那条 `stucoursemiddle` 链接落在一张错误页上，批次 87），' +
            '首页之后还有一条「course home …」说明有没有真进进章节',
        blind: best.blind ? 1 : 0,
        probeVerdict: best.probe ? String(best.probe.verdict || '') : '',
        probeJobs: best.probe ? String(best.probe.jobs || '') : '',
        probeWhy: best.probe ? String(best.probe.why || '') : '',
        unreadable: cards.unknown.length,
        href: String(best.card.homeUrl || '').slice(0, 120),
        everyMs: 0
      }, ev));
      try { this._gotoUrl(best.card.homeUrl); } catch (eNav) {}
      return true;
    },

    /**
     * 批次 87：**我们自己导航来的那张课程首页**上，用站点自己的 `toOld(...)` 进第一章。
     *
     * 为什么非得由我们开口点这一下：顶层帧落在首页时既没有任务点也没有目录（现场实测
     * `.posCatalog_select` = 0、`.ans-attach-ct` = 0），能点的只有章节本身 ——
     * `div.chapter_item[id^="cur"][onclick="toOld('课号','章号','班号',0)"]`。
     * 调它，站点自己拼 `mooc1/mycourse/transfer?…&refer=<带 enc 的 studentstudy>` 并把**顶层帧**换过去；
     * 我们一行地址都不猜（AGENTS §2 #10「地址只许照抄站点自己的那一串」的最强形式 = 让站点自己拼）。
     * 三条路都堵着，只剩这一条：
     *   · `manifest.json` 没有 `all_frames` → "在学习帧里点一下"那一族天生无效；
     *   · `enc` 是服务端按课算的，只有落到这一页才读得到（用户中心那一页没有它）；
     *   · 从 `i.mooc` 跨站 fetch `mooc2-ans` 的目录 HTML 会被 CORS 挡（页面世界里没有权限）。
     *
     * ⚠️ 判据故意做窄，为的是绝不因为"用户自己点开的一页"去动他的浏览器 —— 三条不齐一律返回
     *    false（**不认领**，换课那条链照旧走）：① 地址上有我们自己种的标记；② 路径确实是
     *    `mycourse/studentcourse`（用户中心带着同一个标记，靠这一条分开）；③ 顶层文档里真有一个
     *    `onclick` 调 `toOld(` 的章节点。认领之后的每一步失败都出日志，不静默（AGENTS §2 #7）。
     * @returns {boolean} true = 这一拍归换课流程管（已经跳走 / 明确决定不再跳）
     */
    _enterChapterFromCourseHome: function () {
      if (!this._coursePickRequested()) return false;
      var pathname = '';
      try { pathname = String(location.pathname || ''); } catch (eP) { pathname = ''; }
      if (!/\/mycourse\/studentcourse\b/i.test(pathname)) return false;
      var node = null;
      try { node = document.querySelector('div.chapter_item[onclick*="toOld("]'); } catch (eQ) { node = null; }
      if (!node) return false;
      var onclick = '';
      try { onclick = String(node.getAttribute('onclick') || ''); } catch (eA) { onclick = ''; }
      var chapter = '';
      try { chapter = String(node.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 24); } catch (eT) {}
      var m = /toOld\(\s*'(\d+)'\s*,\s*'(\d+)'\s*,\s*'(\d+)'/.exec(onclick);
      var courseId = m ? m[1] : '';
      var ev = {
        href: String(location.href || '').slice(0, 110),
        chapter: chapter,
        onclick: onclick.slice(0, 90),
        rev: this._codeRev()
      };
      var said = this._homeEnterSaid || (this._homeEnterSaid = {});
      function decline(reason, hint) {
        // 一份文档里同一条理由只说一次：这一页不会因为我们重试就变样，每拍重播只会把日志环刷满
        if (!said[reason]) {
          said[reason] = 1;
          emitRuntimeLog('warn', 'course home declined: ' + reason, Object.assign({ hint: hint, everyMs: 0 }, ev));
        }
        return true;
      }
      if (!this.configs.autoNextCourse) {
        return decline('auto switch is off', '这一页是插件自己为了换课导航来的课程首页，但「刷完自动换下一门」' +
          '已经关掉了，所以不替你点章节 —— 自己点一下左边那一章，或者把那个开关打开');
      }
      if (!m) {
        return decline('enter handler args unparsable', '章节点上写着站点自己的 toOld(...)，可是那三个号（课号 / 章号 / 班号）' +
          '按老形状读不出来 —— 站点改了它自己的进章写法，插件不猜地址（猜错就是拿别班的班号发请求，必 403）。' +
          '这一门请手动点一下章节，剩下的照常跑');
      }
      if (typeof window.toOld !== 'function') {
        return decline('site enter handler missing', '章节节点在，可这一页已经没有站点自己的 toOld 函数了（页面形状变了）。' +
          '插件不自己拼那条带 enc 的地址 —— enc 是服务端按课算的，猜出来就是 404。这一门请手动点一下章节');
      }
      // 有界尝试：`toOld` 那一跳万一没走成（被站点按住 / 又弹回这一页），不许每拍再叫一次。
      // 记在**这一页自己那一族的 sessionStorage**里（换页不换源就还在），所以整份文档重载也挡得住；
      // 跨 30 分钟或换了课就重新起账。
      var now = Date.now();
      var led = null;
      try { led = this._readSessionLedger('omitone:home-enter'); } catch (eL) { led = null; }
      if (!led || typeof led !== 'object' || String(led.cid || '') !== courseId ||
          !(Number(led.tries) > 0) || now - Number(led.at || 0) > 30 * 60 * 1000) {
        led = { cid: courseId, tries: 0, at: 0 };
      }
      if (now - Number(led.at || 0) < 5000) return true;
      if (Number(led.tries) >= 3) {
        return decline('still not in after 3 tries', '在这一页上叫了 3 次站点自己的「进章」，顶层帧都没能落到章节里 —— ' +
          '插件停手，不再刷这一页（继续跳只会把这一页来回重载）。' +
          '请自己点一下左边任意一节，或者关掉再打开刷课让它重新起账');
      }
      led.tries = Number(led.tries || 0) + 1;
      led.at = now;
      try { this._writeSessionLedger('omitone:home-enter', led); } catch (eW) {}
      emitRuntimeLog('warn', 'course home enter chapter', Object.assign({
        hint: '这一页是换课时插件自己导航来的课程首页：顶层文档里那个章节点带着站点自己的 ' +
          'toOld(课号, 章号, 班号)，现在叫它 —— 由站点自己拼 transfer + 带 enc 的章节地址，' +
          '换到章节页之后原来的那套管线照常跑（具体刷哪一节交给学习页的目录扫描，首页只管进门）。' +
          '这一跳没落成的话，下面还会有一条 course home declined 说明是第几次、卡在哪',
        courseId: courseId,
        chapterId: m[2],
        clazzId: m[3],
        tries: led.tries,
        everyMs: 0
      }, ev));
      try {
        this._enterCourseHomeChapter(m[1], m[2], m[3]);
      } catch (eNav) {
        decline('enter handler threw', '调站点自己的 toOld(...) 时抛了异常，原因写在这一格：' +
          String((eNav && eNav.message) || eNav || '').slice(0, 120));
      }
      return true;
    },

    // 单独一个方法 = e2e 能把**这一个动作**桩掉、读回它想进哪一章，而判据（标记 / 路径 /
    // 章节点 / 有界尝试）照样真跑（AGENTS §5「桩要打在动作上」）。
    _enterCourseHomeChapter: function (courseId, chapterId, clazzId) {
      window.toOld(courseId, chapterId, clazzId, 0);
    },

    _advanceLearningStep: function () {
      if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < scaledMs(Number(this.configs.stepSwitchGraceMs || 7000))) return true;
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
          // 慢机上切换学习卡片是异步渲染：固定 2.2 秒后 DOM 可能还是空的，
          // _initCellData 抓到空树，之后就一直 attachments:0、后面的题全不做。
          // 先等「文档加载完 + 章节树容器出现」，等不到按超时兜底继续，绝不死等。
          waitForReady(function () {
            try { return document.readyState === 'complete' && !!app._getTreeContainer(); }
            catch (eTree) { return false; }
          }, Number(app.configs.taskDiscoverGraceMs || 8000)).then(function () {
            try { app._initCellData(); } catch (eInit) {}
            app.play();
          });
        }, scaledMs(Number(app.configs.stepSwitchInitDelayMs || 2200)));
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
