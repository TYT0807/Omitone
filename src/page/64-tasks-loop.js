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
 * 本段的方法（29 个）：
 *   _tickProgress、_startTickLoop、_clearTickLoop、_runTick、_tick、_taskGiveUpMap、_taskPointKey、
 *   _isTaskGivenUp、_markTaskGivenUp、_clearTaskGiveUp、_taskGiveUpList、
 *   _isJobCompleted、_taskProgressSnapshot、_countTaskIncomplete、
 *   _getExplicitActiveLearningCardKey、_detectLearningCardChange、
 *   _getLearningCards、_getLearningCardText、_getActiveLearningCardIndex、
 *   _getCurrentVisibleLearningTaskType、_isAssessmentLearningCard、
 *   _looksLikeVideoLearningCard、_findFallbackNextLearningCardIndex、
 *   _switchToNextLearningCard、nextUnit、_advanceLearningStep、
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
