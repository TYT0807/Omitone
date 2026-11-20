/* ==========================================================================
 * Omitone page.js 片段 04/15 —— 媒体：视频 / 音频 / 倍速 / seek
 * 来源：原 page.js 中散布的 42 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 视频元素的查找与事件处理（播放 / 暂停 / 结束 / 出错修复）
 * 倍速探测、钳制与监控；seek 到结尾、90% 提前结束、防拖拽
 * 音频保活；PPT 内的音频等待
 *
 * ⚠️ `_waitSlideAudioDone` 的等待上限是 **600 秒**，远超看门狗的 150 秒（64-tasks-loop.js）——
 *    所以它每轮都调 `this._tickProgress(...)` 刷心跳。**改动这个循环时别把心跳删掉**，
 *    删了会让正常的长任务被误判成卡死的 tick，从而放锁并起第二个 tick 并行操作同一任务点。
 *
 * 本段的方法（52 个）：
 *   _clearMediaPendingState、_isActiveMediaPending、_pickMedia、_isVisibleMedia、
 *   _findMediaInDocument、_waitForMediaInDocument、_getMediaSeekKey、_noteSeekSkip、
 *   _trySeekToEnd、_deferSeekUntilSeekable、_seekableCovers、
 *   _playChaoxingMediaJob、_startSlideMedia、_waitSlideAudioDone、
 *   _ensurePlaybackRate、_getTargetPlaybackRate、_clampAutoRate、
 *   _resetRateDetection、_scheduleMaxRateDetection、_detectMaxPlaybackRate、
 *   _readRateMenuMax、_probeMaxPlaybackRate、_waitRateSettle、
 *   _startVideoMonitoring、_clearCheckInterval、_startAudioKeepalive、
 *   _stopAudioKeepalive、_syncAudioKeepalive、_checkVideoStatus、
 *   _finishCurrentMedia、_isRateLockedAtOne、_isNinetyPercentVideo、
 *   _shouldAdvanceAtNinetyPercent、_noteNinetyHeldBack、_mediaErrorCode、_reloadMediaInPlace、
 *   _tryResumePlayback、_siteStartControlOf、_nudgeSiteStartControl、_getVideoEl、
 *   _videoEventHandle、_handleMediaError、_guessMediaMime、
 *   _maybeRepairMediaSource、_handleVideoEnded、_handleVideoLoaded、
 *   _handleVideoPlay、_handleVideoPause、_handleVideoRateChange、
 *   _resumeVideoAfterOverlay、
 *   _scanForeignExtensionArtifacts、_noteForeignExtensionHint
 * ========================================================================== */
// @omitone-part-header-end

    _clearMediaPendingState: function (reason) {
      var hadPending = !!(this._activeMediaJobPending || this._isPlaying || this._videoEl || this._checkInterval);
      this._clearCheckInterval();
      this._videoEl = null;
      this._videoCount = 0;
      this._currentVideoIndex = 0;
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._activeMediaJobManaged = false;
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._mediaWaitLogAt = 0;
      this._mediaNoSourceSince = 0;
      this._mediaBrokenSince = 0;
      this._documentWaitLogAt = 0;
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      if (hadPending) {
        emitRuntimeLog('info', 'clear media pending', { reason: reason || '' });
      }
    },


    _isActiveMediaPending: function (reason) {
      // 有些播放器在切换清晰度/广告后会悄悄重置内部状态，把 _isPlaying 清掉，
      // 于是 tick 以为「没有任务」→ 每 5 秒搜一次 → `study no runnable job` 刷屏
      // （2026-10-26 日志：一个视频播放的 6 分钟里刷了 70 多条）。
      // 只要手里那个 video 元素还在播，就应当按「任务进行中」处理。
      var liveVideo = this._videoEl;
      var stillPlaying = !!(liveVideo && liveVideo.isConnected && !liveVideo.paused && !liveVideo.ended);
      if (!this._activeMediaJobPending && !this._isPlaying && !stillPlaying) return false;
      // ⚠️ **先解析元素，再问「这一节是不是该放行」**（批次 51）。
      //    旧写法把这两步反着来：放行判据读的是缓存字段 `this._videoEl`，元素要到下一行
      //    才 `|| this._getVideoEl()` 拿 —— 而 `_getVideoEl()` 自己会把缓存填回去。
      //    于是同一节里「还在播」与「任务框都显示已完成」逐拍轮流成立：
      //    放行那一拍 `_clearMediaPendingState` 把日志时钟和批次 40/50 的放手窗口一起清零，
      //    下一拍 OCS 循环用 `_getVideoEl()` 重新拿到元素 → 又变回占住 → 再被清零。
      //    现场实测（2026-11-13，用户挂着刷课，CDP 9334，12.4 小时那份日志）：
      //    这一对每秒两条，「media pending, delay completion」独占 20500 条 =
      //    整份 200 条环形日志的 **81%**（证据窗只剩约 100 秒，用户来问"刚才为什么跳过"时
      //    那一刻的记录早被挤没了）；更糟的是 `_mediaBrokenSince` 每次刚武装就被清零 ——
      //    **批次 50 那 120 秒的有界放手在这一格里一秒都攒不起来**，正是要它放手的形状。
      //    方向是**只放得更少**：元素还在播就不许因为"框都显示完成"而放行这一节。
      var media = liveVideo || this._getVideoEl();
      if (this._shouldReleaseMediaPendingForCurrentCompletion(reason || 'media-pending', media)) {
        // ⚠️ 批次 55-C：**只有真的武装过一笔媒体任务才走整份复位**。
        //   放行判据如今在"自报全假、元素还在播"那一格也会说放行（那是它对现场的正确回答：
        //   任务框都已完成、这一节没有媒体要等的了），而 `_clearMediaPendingState()` 会把
        //   `_videoEl` 缓存连同 `_mediaWaitLogAt`、批次 40/50 的两个有界放手窗口、
        //   以及**文档任务那一支**的 `_activeDocumentJobPending` 一起清零 ——
        //   不加这道闸就是每拍清一次：日志从"两条成对"变成"一条 clear 每拍一条"（照样刷屏），
        //   而同一节里正在等的文档任务点会被顺手抹掉，症状是"文档那一项悄悄不做"。
        if (this._activeMediaJobPending || this._isPlaying || this._activeMediaJobManaged || this._checkInterval) {
          this._clearMediaPendingState('completed-visible-task:' + (reason || ''));
        }
        return false;
      }

      if (!media) {
        if (!this._activeMediaJobPending) return false;
        var missingNow = Date.now();
        if (!this._mediaWaitLogAt || missingNow - this._mediaWaitLogAt > 5000) {
          this._mediaWaitLogAt = missingNow;
          emitRuntimeLog('info', 'media pending, waiting for element', { reason: reason || '' });
        }
        return true;
      }

      if (media.ended) {
        if (this._activeMediaJobManaged) {
          this._activeMediaJobPending = false;
          this._activeMediaJobManaged = false;
          this._isPlaying = false;
          this._videoEl = null;
          this._videoCount = 0;
          this._currentVideoIndex = 0;
          this._mediaWaitLogAt = 0;
          emitRuntimeLog('info', 'managed media job ended', { reason: reason || '', jobid: this._activeJobId || '' });
          return false;
        }
        if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
          this._currentVideoIndex++;
          this._videoEl = null;
          this._activeMediaJobPending = true;
          this._mediaWaitLogAt = 0;
          return true;
        }
        this._activeMediaJobPending = false;
        this._isPlaying = false;
        this._mediaWaitLogAt = 0;
        return false;
      }

      // 「拿到元素但源从来没挂上」必须**有界放手**（批次 40）。
      // 现场实测（2026-11-13，用户挂着刷课，CDP 9334）：这一节的播放器是
      // `<video id="video_html5_api" class="vjs-tech">`，readyState 0 / networkState 3（NETWORK_NO_SOURCE）
      // / duration null / currentTime 0 / error 空 / 0×0，`media.ended` 因此**永远是 false** ——
      // 上面那条分支救不了它，于是 `_activeMediaJobPending` 恒真、整节停摆 12 分钟，
      // 一条答题都没发出去，日志里 guard 时间戳每秒被刷新一次（= 一直在重试，但永不放手）。
      // 判据只认「既没有首帧也没有时长」这种**从来没有过源**的形状；窗口对齐
      // `documentSkipTimeoutMs`（默认 120 秒，62-tasks-run.js 里等文档资源用的就是它），
      // 正常视频哪怕首帧慢也会在窗口内变成 readyState>0 或拿到 duration，那时清零重新计。
      // ⚠️ 放手必须留 warn：静默跳过用户的任务点是这个项目不许的事（AGENTS §2.7），
      //    而且现场证据（readyState/networkState/src）要一起落进日志，
      //    否则「视频没播成」和「这一节压根没视频」两种情况在日志里长成一个样。
      var noSourceShape = Number(media.readyState) === 0 && !(Number(media.duration) > 0);
      if (!noSourceShape) {
        this._mediaNoSourceSince = 0;
      } else if (!this._mediaNoSourceSince) {
        this._mediaNoSourceSince = Date.now();
      } else if (Date.now() - this._mediaNoSourceSince >= (Number(this.configs.documentSkipTimeoutMs) || 120000)) {
        var stuckHeldMs = Date.now() - this._mediaNoSourceSince;
        var stuckSrc = '';
        try { stuckSrc = String(media.currentSrc || media.src || '').slice(0, 120); } catch (eSrc) {}
        // 任务 #157：放手这一刻顺手问一句「页面里有没有别的扩展注入的资源」——
        // 证据跟着放手日志走（foreign / foreignIds），found 时另出一句用户向提醒。
        var noSrcForeign = this._scanForeignExtensionArtifacts(media);
        this._mediaNoSourceSince = 0;
        emitRuntimeLog('warn', 'media has no source, release pending', {
          reason: reason || '', readyState: Number(media.readyState),
          networkState: Number(media.networkState), heldMs: stuckHeldMs, src: stuckSrc,
          foreign: noSrcForeign.state, foreignIds: String((noSrcForeign.ids || []).join(','))
        });
        this._noteForeignExtensionHint(noSrcForeign);
        this._clearMediaPendingState('media-no-source');
        return false;
      }

      // 「源挂上了、播到一半**解码器死了**」这一族上面那条看不见（批次 50）——
      // `noSourceShape` 要的是 readyState 0 且拿不到 duration，而现场那次是
      // readyState 4 / duration 1448 / `error.code=3`：
      // 2026-11-14 用户挂着刷课（CDP 9334），`currentTime` 从 628.771 起**将近一刻钟一格没动**，
      // `paused` 却是 false —— 于是播放中的每一道判据都说"在播"，只有 `error` 说真话。
      // 放手窗口沿用 `documentSkipTimeoutMs`（**不加新配置键**：加一个键要动三份默认值 +
      // 界面绑定 + 策略区间，那些都由自检第 12 项守着，能复用就别新开面）。
      // ⚠️ 放手**不等于标记完成** —— `_clearMediaPendingState` 只清状态、不上报完成，
      //    真正的"这一节做完没"仍由平台的 `#isFinished` 说话；反复重派由外层的
      //    `_countTaskIncomplete`（进度快照 `media:<秒>` 恒等 → 4 次就放弃 24 小时）收住。
      //    静默跳过用户的任务点是这个项目不许的事（AGENTS §2.7），所以这里必须留 warn，
      //    并把 code / message / 位置 / 是否重载过一起写进日志。
      var brokenCode = this._mediaErrorCode(media);
      if (!brokenCode) {
        this._mediaBrokenSince = 0;
      } else if (!this._mediaBrokenSince) {
        this._mediaBrokenSince = Date.now();
      } else if (Date.now() - this._mediaBrokenSince >= (Number(this.configs.documentSkipTimeoutMs) || 120000)) {
        var brokenHeldMs = Date.now() - this._mediaBrokenSince;
        var brokenMsg = '';
        try { brokenMsg = String((media.error && media.error.message) || '').slice(0, 140); } catch (eErr) {}
        var brokenKey = this._getMediaSeekKey(media);
        var deadForeign = this._scanForeignExtensionArtifacts(media);
        this._mediaBrokenSince = 0;
        emitRuntimeLog('warn', 'media pipeline dead, release pending', {
          code: brokenCode,
          message: brokenMsg,
          reason: reason || '',
          currentTime: Number(media.currentTime || 0),
          duration: Number(media.duration || 0),
          heldMs: brokenHeldMs,
          reloaded: !!(brokenKey && this._mediaReloadKeys && this._mediaReloadKeys[brokenKey]),
          reloadTimes: Number(brokenKey && this._mediaReloadKeys &&
            this._mediaReloadKeys[brokenKey] && this._mediaReloadKeys[brokenKey].n) || 0,
          foreign: deadForeign.state, foreignIds: String((deadForeign.ids || []).join(','))
        });
        this._noteForeignExtensionHint(deadForeign);
        this._clearMediaPendingState('media-pipeline-dead');
        return false;
      }

      this._activeMediaJobPending = true;
      this._ensurePlaybackRate(media, reason || 'pending');
      if (media.paused) {
        this._isPlaying = true;
        this._tryResumePlayback(reason || 'pending');
      }

      var now = Date.now();
      // 签名只放**播放状态**这一维（paused / playing），外加批次 50 的第三态 `broken<code>`。
      // ⚠️ reason 绝不能再进签名：reason 是「谁来问的」（'completion-check'、
      //    'ocs-runner-active-job' 等十几个调用方标识），同一个视频每秒被两个调用方
      //    一先一后地问，签名就每秒翻一次 —— 下面那道 30 秒闸被自己的签名绕过去。
      //    现场实测（2026-11-13，用户挂着刷课，CDP 9334 读 SW 那份 runtimeLogs）：
      //    200 条环形日志里 196 条是这一句，整个窗口只装得下约 100 秒；
      //    用户来问「刚才那节为什么跳过」时，那一刻的证据早被挤没了 ——
      //    而这条日志的本意恰恰是「让人看得见进度」，反过来把别的证据全冲掉。
      //    心跳本身留着（30 秒一条照样看得出 currentTime 在走），reason 仍在 payload 里。
      //    状态真变了（暂停↔播放）仍然立刻出，但受 5 秒下限约束：
      //    播放器自己抖动时不许把闸再冲开一次。
      var deadCode = this._mediaErrorCode(media);
      // ⚠️ 死流水线**不许**再报成 `playing`（批次 50）：现场那一节 `paused` 恒 false、
      //    时间恒 628.771，于是 200 条环里每一条都写着"playing" —— 而这句话的本意是
      //    「看得出进度在不在走」。**诊断工具骗人比没有诊断更糟**（AGENTS §5）：
      //    看日志的人会照着"在播"往别处查。
      var mediaSig = deadCode ? ('broken' + deadCode) : (media.paused ? 'paused' : 'playing');
      var waitPayload = {
        reason: reason || '',
        currentTime: Number(media.currentTime || 0),
        duration: Number(media.duration || 0)
      };
      if (deadCode) waitPayload.errCode = deadCode;
      var sinceWaitLog = now - (Number(this._mediaWaitLogAt) || 0);
      if (!this._mediaWaitLogAt || sinceWaitLog > 30000
        || (mediaSig !== this._mediaWaitLogSig && sinceWaitLog > 5000)) {
        this._mediaWaitLogAt = now;
        this._mediaWaitLogSig = mediaSig;
        emitRuntimeLog('info', 'media pending, delay completion', waitPayload);
      }
      return true;
    },


    // ---- 其他浏览器扩展的注入痕迹探针（用户现场：装了刷题酱等刷课/视频类扩展后，
    // 我们的视频经常直接卡住，用户不知道为什么 —— 卡住诊断里要能看见这一格）----
    // 扫顶层文档与媒体所在文档里带扩展资源地址（chrome-extension:// 一族）的 src/href 元素。
    // 自家 id 从本插件自己的注入标签里读（content.js 注入的 'xxt-page-script'，src 就是
    // chrome-extension://<id>/page.js —— 宠物图与 page.js 标签都用同一个 id，一次排除全干净；
    // 页面世界里没有 chrome.runtime，只能这样认自己）。
    // ⚠️ 诚实口径三格分开：found / none / unreadable。「none」只说明**没有 DOM 痕迹**——
    //    content script 可以不落任何元素就改 playbackRate / 暂停视频，所以 none 那一格
    //    绝不许写成「已排除其他插件」；认不出自家 id 就交 unreadable，绝不猜（AGENTS §2 #18 同族）。
    // ⚠️ 60 秒缓存：give-up 路径（_countTaskIncomplete）在卡住期间**每一拍**都会问，
    //    不许每拍全页扫。导航后由 _resetRuntimeState 清掉，旧页结论不带进新页。
    _scanForeignExtensionArtifacts: function (media) {
      var now = Date.now();
      var cached = this._foreignExtScan;
      if (cached && now - cached.at < 60000) return cached;
      var result = { state: 'unreadable', ids: [], count: 0, at: now };
      var ownId = '';
      try {
        var tag = document.getElementById('xxt-page-script');
        var mOwn = /^[a-z][a-z0-9-]*-extension:\/\/([^/]+)/i.exec(String((tag && tag.src) || ''));
        if (mOwn) ownId = mOwn[1];
      } catch (eOwn) {}
      if (ownId) {
        var docs = [];
        try { docs.push(document); } catch (eTop) {}
        try {
          var mdoc = media && media.ownerDocument;
          if (mdoc && docs.indexOf(mdoc) < 0) docs.push(mdoc);
        } catch (eMed) {}
        var seen = Object.create(null);
        for (var d = 0; d < docs.length; d++) {
          var nodes = null;
          try {
            nodes = docs[d].querySelectorAll(
              '[src^="chrome-extension://"],[src^="moz-extension://"],[src^="safari-web-extension://"],[src^="edge-extension://"],' +
              '[href^="chrome-extension://"],[href^="moz-extension://"],[href^="safari-web-extension://"],[href^="edge-extension://"]');
          } catch (eQ) { continue; }
          for (var i = 0; i < nodes.length; i++) {
            var u = '';
            try { u = String(nodes[i].getAttribute('src') || nodes[i].getAttribute('href') || ''); } catch (eA) { continue; }
            var mId = /^[a-z][a-z0-9-]*-extension:\/\/([^/]+)/i.exec(u);
            var eid = mId ? mId[1] : '';
            if (!eid || eid === ownId) continue;
            result.count++;
            if (!seen[eid]) { seen[eid] = 1; result.ids.push(eid); }
          }
        }
        result.state = result.ids.length ? 'found' : 'none';
        if (result.ids.length > 3) result.ids = result.ids.slice(0, 3);
      }
      this._foreignExtScan = result;
      return result;
    },

    // found 坐实时的**用户向提醒**：独立成句、限频 10 分钟 ——
    // 老的放手/放弃日志原样保留（AGENTS §2 #14：新增分格说话不许抢走地板日志）。
    // none / unreadable 一句不出：页面干净不代表没有隐形干预，说了「没事」反而是假话。
    _noteForeignExtensionHint: function (scan) {
      if (!scan || scan.state !== 'found' || !(scan.ids && scan.ids.length)) return;
      var now = Date.now();
      if (this._foreignExtHintAt && now - this._foreignExtHintAt < 600000) return;
      this._foreignExtHintAt = now;
      emitRuntimeLog('warn', '检测到其他浏览器扩展注入了页面资源，可能与视频卡住有关', {
        ids: String((scan.ids || []).join(',')),
        count: Number(scan.count) || 0,
        hint: '建议先禁用其他刷课/视频/脚本类扩展再重试；页面干净也不代表没有隐形干预'
      });
    },

    // 从候选媒体里挑一个：优先可见的（video 或 audio），其次隐藏的 audio。
    // 音频常被自定义播放器隐藏（无可见控件/零尺寸）但照样能播；
    // 隐藏的 video 不选，避免误选页面上无关的隐藏视频元素。
    _pickMedia: function (list) {
      var i;
      for (i = 0; i < list.length; i++) {
        var m = list[i];
        if (visible(m) || (m.getClientRects && m.getClientRects().length > 0)) return m;
      }
      for (i = 0; i < list.length; i++) {
        if (String(list[i].tagName || '').toLowerCase() === 'audio') return list[i];
      }
      return null;
    },


    _isVisibleMedia: function (media) {
      return !!media && (visible(media) || (media.getClientRects && media.getClientRects().length > 0));
    },


    _findMediaInDocument: function (doc, depth) {
      if (!doc || !doc.querySelectorAll) return null;
      var picked = this._pickMedia(Array.from(doc.querySelectorAll('video, audio')));
      if (picked) return picked;

      // 播放器可能被包在子 iframe 里（音频任务点常见），递归找一层
      var level = typeof depth === 'number' ? depth : 0;
      if (level >= 3) return null;
      var frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return null; }
      for (var i = 0; i < frames.length && i < 8; i++) {
        var subDoc = this._safeDocOf(frames[i]);
        if (!subDoc) continue;
        var sub = this._findMediaInDocument(subDoc, level + 1);
        if (sub) return sub;
      }
      return null;
    },


    _waitForMediaInDocument: function (doc, timeoutMs) {
      var self = this;
      return new Promise(function (resolve) {
        var deadline = Date.now() + (timeoutMs || 8000);
        var timer = setInterval(function () {
          var media = self._findMediaInDocument(doc);
          if (media) {
            clearInterval(timer);
            resolve(media);
            return;
          }
          if (Date.now() >= deadline) {
            clearInterval(timer);
            resolve(null);
          }
        }, 200);
      });
    },


    _getMediaSeekKey: function (media) {
      if (!media) return '';
      var src = '';
      try { src = media.currentSrc || media.src || ''; } catch (e) {}
      if (src) return src;
      if (this._activeJobId) return 'job:' + this._activeJobId;
      return '';
    },


    // 「这一支为什么一次都没试拖」以前在盘上是**零证据**：下面 `_trySeekToEnd` 里那些
    // 直接 `return false` 的出口既不写日志也不登记，于是"在等元数据""被验证码闸挡住"
    // 与"压根没走到这一发"长得一模一样（AGENTS §2 #12 那一族：读不出不许塌成结论）。
    // 所以每一格出口按**媒体钥匙**记一笔账：跨拍累积、**不许被 `_resetRuntimeState` 抹掉**
    // （§2 #13 实测踩过同族），探针 `media-state.expr` 拿当前那一枚的钥匙读回来。
    // 这里**不加日志** —— 这一发每 1500 毫秒就来一拍，说话会把 200 条的证据窗吃光（§2 #16(b)），
    // 而"没试拖"本身不是异常；只有现场问一句才需要它。
    _noteSeekSkip: function (reason, media, key) {
      try {
        if (!this._seekSkipLedger) this._seekSkipLedger = Object.create(null);
        var k = String(key || '');
        var st = this._seekSkipLedger[k];
        if (!st) {
          if (Object.keys(this._seekSkipLedger).length > 300) this._seekSkipLedger = Object.create(null);
          st = this._seekSkipLedger[k] = { n: 0, first: Date.now(), reasons: Object.create(null) };
        }
        st.n++;
        st.reasons[reason] = (st.reasons[reason] || 0) + 1;
        st.last = reason;
        st.at = Date.now();
        var dur = NaN;
        try { dur = Number(media && media.duration); } catch (e) { dur = NaN; }
        st.dur = isFinite(dur) ? Number(dur.toFixed(1)) : null;
        try { st.src = !!(media && (media.currentSrc || media.src)); } catch (e) { st.src = false; }
        return st;
      } catch (e) { return null; }
    },


    // 可拖动的视频/音频：直接拖到结尾。每个媒体只检查一次、最多只做一次拖动动作；
    // 网站有防拖拽把进度弹回时也不再重试，避免与播放器对抗。
    // 音频原先被排除（旧注释「只拖视频」），但实测有些音频任务同样能拖到底、平台照常计完成
    //（用户反馈）；拖不动的音频会在下面的「弹回检测」里被标记为不可拖，自动回落到正常播放。
    // 注意：PPT 逐页音频走的是 _runPptAudioJob，不设 _videoEl、不经这条路，所以不受影响。
    _trySeekToEnd: function (video, reason) {
      var mediaTag = video && String(video.tagName || '').toUpperCase();
      if (mediaTag !== 'VIDEO' && mediaTag !== 'AUDIO') return false; // 只拖视频/音频，其它元素不碰
      // 钥匙先算（纯读数，无副作用，判定顺序一格未动）：下面每一格"不试"都要归到这一支上
      var key = this._getMediaSeekKey(video);
      if (!this.configs.enableSeek) { this._noteSeekSkip('disabled', video, key); return false; }
      if (this._rateProbing) { this._noteSeekSkip('probing', video, key); return false; } // 倍速探测期间不动进度条，探测结束后的巡检会再进来
      if (this._captchaActive) { this._noteSeekSkip('captcha', video, key); return false; }
      if (!this._seekTriedKeys) this._seekTriedKeys = Object.create(null);
      if (!this._seekRevertedKeys) this._seekRevertedKeys = Object.create(null);
      if (!key) { this._noteSeekSkip('no-key', video, key); return false; }
      if (this._seekTriedKeys[key]) return false; // 本视频已检查过，只做一次（这是"试过了"，不进 skip 账）
      if (Object.keys(this._seekTriedKeys).length > 300) {
        this._seekTriedKeys = Object.create(null);
        this._seekRevertedKeys = Object.create(null);
        this._seekDeferKeys = Object.create(null);
      }

      var duration = Number(video.duration);
      if (!isFinite(duration) || duration <= 20) { this._noteSeekSkip('no-meta', video, key); return false; } // 元数据未就绪/时长太短：不标记，下次再检查

      var current = Number(video.currentTime || 0);
      if (current >= duration - 8) { this._noteSeekSkip('near-end', video, key); return false; } // 已在结尾附近，无需拖动

      var target = Math.max(0, duration - 3); // 留 3 秒自然播完，让 ended 事件与任务完成正常触发

      // ⚠️ 这一发"只做一次"的机会不许花在**区间还服务不了它**的时刻上，见下面两个新方法
      if (this._deferSeekUntilSeekable(video, key, target, duration, reason)) return false;

      this._seekTriedKeys[key] = true; // 检查完成：此后无论成败都不再动这个视频
      try {
        video.currentTime = target;
      } catch (e) {
        return false;
      }
      emitRuntimeLog('info', 'seekable video: seek to end', {
        reason: reason || '',
        from: Number(current.toFixed(1)),
        to: Number(target.toFixed(1)),
        duration: Number(duration.toFixed(1))
      });
      console.log('%c[Omitone] seekable video, seek to end: ' + current.toFixed(1) + 's -> ' + target.toFixed(1) + 's / ' + duration.toFixed(1) + 's', 'color:#4CAF50');

      // 1.5 秒后验证进度是否被网站弹回。
      //
      // ⚠️ 原来这里是「只记日志、不再重试」，实测量出一笔很贵的账：
      //    2026-10-26 的日志里，385 秒的视频 seek 到 382 秒后被播放器**静默吞掉**
      //    （currentTime 从 3 秒继续涨），插件以为拖过了，于是按 1 倍速完整看了 6 分半。
      //    播放器在 metadata 刚就绪时吞掉第一次 seek 很常见，所以这里允许再补两次；
      //    两次都弹回才认定「这个视频不可拖拽」，结论仍然给 _isNinetyPercentVideo 复用。
      var self = this;
      var verifySeek = function (attempt) {
        try {
          if (!video.isConnected) return;
          var now = Number(video.currentTime || 0);
          if (now >= duration - 12) {
            self._seekRevertedKeys[key] = false; // 拖成功 → 可拖拽，不走 90% 提前结束
            console.log('[Omitone] seek to end confirmed, now=' + now.toFixed(1) + 's');
            return;
          }
          if (attempt < 2) {
            try { video.currentTime = target; } catch (eRetry) { return; }
            emitRuntimeLog('info', 'seek reverted by site, retry', {
              attempt: attempt + 1,
              from: Number(now.toFixed(1)),
              to: Number(target.toFixed(1))
            });
            self._workerDelay(function () { verifySeek(attempt + 1); }, 1500);
            return;
          }
          self._seekRevertedKeys[key] = true;  // 两次都弹回 → 不可拖拽
          console.log('[Omitone] seek reverted by site player, continue normal playback');
          emitRuntimeLog('info', 'seek reverted by site, keep playing normally');
        } catch (e) {}
      };
      this._workerDelay(function () { verifySeek(0); }, 1500);
      return true;
    },


    /**
     * 现场实测（2026-11-17，一门鉴赏课里同一支 1401.4 秒的视频，章节号用合成夹具号 910000001 代）：
     *   +1100s  seekable video: seek to end {"from":0,"to":1398.4}
     *   +1099s / +1097s  seek reverted by site, retry —— 两次读回的都是 **1.1**
     *   +1096s  seek reverted by site, keep playing normally → 此后这一支按 1 倍速看完了 23 分钟
     *   而 12:26 只读量回来的是 seekable=[[0,1401.4]]、bufferedEnd=1400.86 —— **整支早就拖得动了**
     *
     * 那两次"弹回"根本不是站点防拖拽：规范里 seek 到 seekable 区间之外**就是被忽略、
     * currentTime 原地不动**（`to` 那里写着 1398.4，读回 1.1 —— 连"被按回原位"都不是，是从头播）。
     * 旧代码把这一刻的失败当结论，而且**一次性机会花在元数据刚就绪的那一拍**，
     * 于是"这一支不可拖"永久成立，`_isNinetyPercentVideo` 接着让它看到 90%（waitedMs=1256041）。
     *
     * 所以现在先问一句"目标位置在不在可拖区间里"：不在就**把这一发留给区间长出来之后**，
     * 有界重试（时间预算 + 次数预算双上限）；任一预算用掉就**照旧真拖一次**才收手 ——
     * "不可拖拽"这个结论只能来自"写进去被弹回"，不许来自"等区间没等到"。
     * 真在区间里还被弹回，才叫"不可拖拽"。判据口径与 AGENTS §2 #12 同一族：
     * **"现在还不行"不许被压成"不行"**。
     *
     * 返回 true = 这一拍不动进度条（还在等区间）；false = 照旧往下拖。
     */
    _deferSeekUntilSeekable: function (video, key, target, duration, reason) {
      var cover = this._seekableCovers(video, target);
      if (cover === 'yes') return false;

      if (!this._seekDeferKeys) this._seekDeferKeys = Object.create(null);
      var st = this._seekDeferKeys[key];
      if (!st) st = this._seekDeferKeys[key] = { tries: 0, until: Date.now() + 180000 };
      st.tries++;

      // 预算用掉：不再干等，**照旧往下拖一次**（登记与"不可拖"的结论都交给那一次的写入去拿）
      if (st.tries >= 120 || Date.now() > st.until) {
        emitRuntimeLog('info', 'seek target never became reachable, attempt once anyway', {
          tries: st.tries, cover: cover, reason: reason || '',
          to: Number(target.toFixed(1)), duration: Number(Number(duration).toFixed(1))
        });
        return false;
      }

      // 只说第一次，后面安静等（这一族每 1500 毫秒就来一拍，说两次就把证据窗挤满了）
      if (st.tries === 1) {
        emitRuntimeLog('info', 'seek target not in seekable range yet, waiting for it', {
          cover: cover, reason: reason || '', to: Number(target.toFixed(1)),
          duration: Number(Number(duration).toFixed(1)), windowMs: st.until - Date.now()
        });
      }
      return true;
    },


    // 'yes' = 目标落在某个 seekable 段里（可以真拖）；'empty' = 区间还没长出来；
    // 'outside' = 长出来了但不含尾部。**这两态都等** —— 规范里往区间外写就是被忽略，
    // 现场那一发失败（读回 1.1 而 to 写着 1398.4）正是元数据刚就绪、区间还没长齐的那一刻。
    // 读不到 seekable 一律当 'yes' —— 宁可照旧拖一次，也别把"能拖"的机会因为探针本身读不出
    // 而判成"不可拖"（那会把 23 分钟白送给旧行为）。
    _seekableCovers: function (video, target) {
      var r = null;
      try { r = video && video.seekable; } catch (e) { return 'yes'; }
      if (!r) return 'yes';
      var n = 0;
      try { n = Number(r.length) || 0; } catch (e2) { return 'yes'; }
      if (!n) return 'empty';
      for (var i = 0; i < n; i++) {
        var a = 0, b = 0;
        try { a = Number(r.start(i)); b = Number(r.end(i)); } catch (e3) { return 'yes'; }
        if (a <= target && target <= b) return 'yes';
      }
      return 'outside';
    },


    _playChaoxingMediaJob: async function (job) {
      if (!job || !job.doc) return false;
      if (!this.configs.enableMedia) {
        console.log('%c[Omitone] media learning disabled, skip: ' + job.name, 'color:#FF9800');
        return true;
      }

      var video = this._findMediaInDocument(job.doc);
      if (!video) {
        video = await this._waitForMediaInDocument(job.doc, 8000);
      }

      if (video) {
        this._videoEl = video;
        this._videoCount = 1;
        this._currentVideoIndex = 0;
      }

      if (!video) {
        this._activeMediaJobPending = false;
        console.warn('[Omitone] chaoxing media not ready:', job.name);
        return false;
      }

      var isAudioTask = String(video.tagName || '').toLowerCase() === 'audio';

      this._activeJobId = job.jobid || '';
      this._skipChainCount = 0;
      this._activeMediaJobPending = !video.ended;
      this._activeMediaJobManaged = true;
      this._mediaWaitLogAt = 0;
      this._isPlaying = true;
      // 每个任务点重新探测最大倍速：避免上一个视频的探测结果串到当前音频上
      this._resetRateDetection();
      this._ensurePlaybackRate(video, 'job-media');
      if (isAudioTask) {
        // 音频诊断：把格式/MIME/浏览器支持情况与最终倍速记进日志，方便确认 m4a 到底能不能播
        var audioSrc = String(video.currentSrc || video.src || '');
        var audioMime = this._guessMediaMime(audioSrc);
        var canPlay = 'unknown';
        try {
          var probe = document.createElement('audio');
          canPlay = probe.canPlayType(audioMime || 'audio/mp4') || 'no';
        } catch (eProbe) {}
        emitRuntimeLog('info', 'audio task started', {
          name: job.name,
          src: audioSrc.slice(-70),
          mime: audioMime || 'unknown',
          canPlay: canPlay,
          muted: !!video.muted,
          rate: Number(video.playbackRate || 1)
        });
      }
      this._trySeekToEnd(video, 'job-start');
      this._videoEventHandle();
      try {
        await this._withTimeout(video.play(), 12000);
        this._startVideoMonitoring();
      } catch (e) {
        try {
          video.muted = true;
          await this._withTimeout(video.play(), 12000);
          this._isPlaying = true;
          this._startVideoMonitoring();
          // play() 被拒后浏览器会把 currentTime 打回 0，站点也可能顺手把倍速重置成 1。
          // 不补这两下，日志里就是「seek 到 102/105 → 静音重试 → 从 0.8s 用 1x 重看一遍」。
          try { this._trySeekToEnd(video, 'after-muted-retry'); } catch (eSeek) {}
          try { this._ensurePlaybackRate(video, 'after-muted-retry'); } catch (eRate) {}
          emitRuntimeLog('warn', 'media autoplay blocked, muted retry ok', { name: job.name });
        } catch (e2) {
          // 静音重试仍失败：多半是音源格式/MIME 不支持（m4a 常见），尝试重新封装音源后播放
          var errText = String((e2 && e2.name) || '') + ' ' + String((e2 && e2.message) || '');
          if (/NotSupported/i.test(errText) || (video.error && video.error.code === 4)) {
            var repaired = await this._maybeRepairMediaSource(video);
            if (repaired) {
              this._isPlaying = true;
              this._startVideoMonitoring();
              emitRuntimeLog('info', 'media play recovered after source repair', { name: job.name });
              return true;
            }
          }
          this._isPlaying = false;
          // 站点的播放器自己在同一刻调 load()/pause() 时，这一发 play() 的 promise 会被它打断。
          // 这**不等于**"这个视频看不了"：下一拍会重新接上（现场实测：打完这两句 currentTime 照走）。
          // 状态面板把 error 级日志读成「异常运行」，所以只把这种自愈的中断降级；
          // 真读不到源的仍然留 error —— 那才是要人看一眼的那一种。
          var interruptedBySite = /interrupted by/i.test(errText);
          var errDetail = String((e2 && e2.message) || e2 || '').slice(0, 160);
          if (interruptedBySite) {
            emitRuntimeLog('warn', 'media play interrupted by site player', {
              name: job.name,
              error: errDetail,
              hint: '站点播放器自己动了 load/pause，这一下 play 被打断 —— 会重新接上，不用管'
            });
          } else {
            emitRuntimeLog('error', 'media play failed', {
              name: job.name,
              error: errDetail
            });
            console.error('[Omitone] chaoxing media play failed:', e2 && e2.message ? e2.message : e2);
          }
        }
      }
      return true;
    },


    _startSlideMedia: function (doc) {
      var medias = [];
      try {
        medias = Array.from(doc.querySelectorAll('audio, video'));
      } catch (e) {}
      var self = this;
      medias.forEach(function (media) {
        if (media.ended) return;
        try {
          media.muted = !!self.configs.muted;
        } catch (e1) {}
        if (media.paused) {
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') {
              p.catch(function () {
                try {
                  media.muted = true;
                  media.play().catch(function () {});
                } catch (e2) {}
              });
            }
          } catch (e3) {}
        }
      });
      return medias.length;
    },


    _waitSlideAudioDone: async function (doc) {
      var waited = 0;
      while (waited < 600000) {
        // ⚠️ 心跳：本循环上限 600 秒，远超看门狗的 150 秒 —— 不刷心跳会被误判成卡死，
        //    导致新一轮 tick 与这次并行操作同一个任务点（见 64-tasks-loop.js 的看门狗）。
        this._tickProgress('ppt-audio wait');
        var active = [];
        try {
          active = Array.from(doc.querySelectorAll('audio, video')).filter(function (media) {
            return !media.ended && (Number(media.currentTime || 0) > 0 || !media.paused);
          });
        } catch (e) {}
        if (!active.length) return true;

        active.forEach(function (media) {
          if (!media.paused) return;
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (e2) {}
        });

        var remaining = 0;
        for (var i = 0; i < active.length; i++) {
          var left = Number(active[i].duration || 0) - Number(active[i].currentTime || 0);
          if (!(left > 0)) left = 1;
          if (left > remaining) remaining = left;
        }
        var waitMs = Math.min(Math.ceil(remaining * 1000) + 800, 30000);
        await sleep(waitMs);
        waited += waitMs;
      }
      return false;
    },


    _ensurePlaybackRate: function (video, reason) {
      if (!video) return;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 音频不再由插件静音（旧的 audioMuted 开关已删）。
      // 它反复出现「录不上进度 / 声音忽大忽小」这类问题，而用户随手静音标签页就能解决。
      try {
        video.muted = !isAudio && !!this.configs.muted;
      } catch (e0) {}
      if (this.configs.autoMaxPlaybackRate !== false && this._rateDetectVideo !== video) {
        this._scheduleMaxRateDetection(video);
      }
      if (this._rateProbing) return;
      var target = this._getTargetPlaybackRate();
      try {
        if (video.defaultPlaybackRate !== target) video.defaultPlaybackRate = target;
      } catch (e) {}
      try {
        if (Math.abs(Number(video.playbackRate || 1) - target) > 0.01) {
          video.playbackRate = target;
          console.log('%c[Omitone] rate guard ' + reason + ': ' + target + 'x', 'color:#607D8B');
        }
      } catch (e2) {}
    },


    _getTargetPlaybackRate: function () {
      if (this.configs.autoMaxPlaybackRate !== false && Number(this._detectedMaxRate) > 0) {
        return this._clampAutoRate(this._detectedMaxRate);
      }
      var target = Number(this.configs.playbackRate || 1);
      return isFinite(target) && target > 0 ? target : 1;
    },


    _clampAutoRate: function (rate) {
      var value = Number(rate) || 1;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      if (value > cap) value = cap;
      if (value < 0.5) value = 0.5;
      return value;
    },


    _resetRateDetection: function () {
      this._detectedMaxRate = 0;
      this._rateDetectVideo = null;
    },


    _scheduleMaxRateDetection: function (video) {
      if (!video) return;
      this._rateDetectVideo = video;
      if (this._rateDetectBusy) return;
      var self = this;
      var epoch = this._rateEpoch || 0;
      this._rateDetectBusy = true;

      var runDetect = function () {
        self._detectMaxPlaybackRate(video).then(function (rate) {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return; // 任务已切换，探测结果作废
          if (Number(rate) > 0) {
            self._detectedMaxRate = rate;
            emitRuntimeLog('info', 'auto playback rate detected', { rate: rate });
            self._ensurePlaybackRate(self._getVideoEl() || video, 'auto-rate');
          } else {
            self._rateDetectVideo = null;
          }
        }).catch(function () {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return;
          self._rateDetectVideo = null;
        });
      };

      // 暂停状态下播放器可能不接管倍速，等播放开始后再探测
      if (!video.paused) {
        runDetect();
        return;
      }
      var tries = 0;
      var timer = setInterval(function () {
        if ((self._rateEpoch || 0) !== epoch) { // 任务已切换，放弃这次探测
          clearInterval(timer);
          self._rateDetectBusy = false;
          return;
        }
        tries++;
        if (!video.paused) {
          clearInterval(timer);
          runDetect();
          return;
        }
        if (tries >= 60) {
          clearInterval(timer);
          self._rateDetectBusy = false;
          self._rateDetectVideo = null;
        }
      }, 500);
    },


    _detectMaxPlaybackRate: async function (video) {
      if (!video) return 0;
      // 首选：播放器倍速菜单里暴露的档位（老师设置的上限会体现在菜单中）
      var menuMax = this._readRateMenuMax(video);
      if (menuMax > 0) {
        emitRuntimeLog('info', 'rate menu max found', { rate: menuMax });
        return this._clampAutoRate(menuMax);
      }
      // 备选：从高到低试设倍速，观察播放器是否把倍速压回
      var probed = await this._probeMaxPlaybackRate(video);
      // ⚠️ 探测不出来 ≠ 上限就是 1 倍。原来这里 `probed || 1` 会把「不知道」当成
      // 「只能 1 倍」，然后把用户自己设的播放速度也一起压回 1（日志里
      // `auto playback rate detected {"rate":1}` 之后就是全程 1 倍速）。
      // 返回 0 表示「没测出上限」，让 _getTargetPlaybackRate 回退到配置里的速度。
      if (!probed) return 0;
      return this._clampAutoRate(probed);
    },


    _readRateMenuMax: function (video) {
      var doc = video && (video.ownerDocument || document);
      if (!doc) return 0;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 优先在播放器容器内找倍速菜单；音频不做整文档扫描，避免读到页面上其他视频播放器的档位
      var scopes = [];
      try {
        var container = video.closest
          ? video.closest('.video-js, .vjs-player, [class*="player"], [class*="Player"]')
          : null;
        if (container) scopes.push(container);
      } catch (e0) {}
      if (!isAudio) scopes.push(doc);

      var selector = '.vjs-menu-item, .vjs-menu-content li, [class*="speed"] li, [class*="Speed"] li, [class*="rate"] li';
      var maxRate = 0;
      for (var s = 0; s < scopes.length; s++) {
        var nodes = [];
        try {
          nodes = Array.from(scopes[s].querySelectorAll(selector));
        } catch (e) {
          continue;
        }
        for (var i = 0; i < nodes.length; i++) {
          var text = textOf(nodes[i]);
          if (!text || text.length > 16) continue;
          var match = text.match(/(\d+(?:\.\d+)?)\s*(?:x|X|倍)/);
          if (!match) continue;
          var rate = parseFloat(match[1]);
          if (rate > 0 && rate < 32 && rate > maxRate) maxRate = rate;
        }
        if (maxRate > 0) break;
      }
      return maxRate;
    },


    _probeMaxPlaybackRate: async function (video) {
      var self = this;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      var candidates = [4, 3, 2.5, 2, 1.75, 1.5, 1.25, 1].filter(function (c) { return c <= cap; });
      var best = 0;
      this._rateProbing = true;
      try {
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          try { video.playbackRate = candidate; } catch (e) { continue; }
          var settled = await self._waitRateSettle(video, 700);
          if (settled > 0 && Math.abs(settled - candidate) <= 0.05) {
            best = candidate;
            break;
          }
          if (settled > best) best = settled;
        }
      } finally {
        this._rateProbing = false;
      }
      return best;
    },


    _waitRateSettle: async function (video, waitMs) {
      var last = -1;
      var stable = 0;
      var elapsed = 0;
      while (elapsed < (waitMs || 700)) {
        await sleep(150);
        elapsed += 150;
        var current = Number(video.playbackRate || 0);
        if (Math.abs(current - last) <= 0.001) {
          stable += 150;
          if (stable >= 300) return current;
        } else {
          stable = 0;
        }
        last = current;
      }
      return last > 0 ? last : 0;
    },


    _startVideoMonitoring: function () {
      this._clearCheckInterval();
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._ensureBackgroundWorker();
      this._bindVisibilityHandlers();
      this._syncAudioKeepalive();
      var self = this;
      this._checkInterval = setInterval(function () {
        self._checkVideoStatus();
      }, this.configs.videoCheckInterval || 1500);
    },


    _clearCheckInterval: function () {
      if (this._checkInterval) {
        clearInterval(this._checkInterval);
        this._checkInterval = null;
      }
      this._syncAudioKeepalive();
    },


    _startAudioKeepalive: function () {
      if (this._audioKeepalive) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        oscillator.frequency.value = 50;
        gain.gain.value = 0.003; // 近乎无声：人耳不可辨，但足以让浏览器将标签页视为正在播放音频
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        var app = this;
        var keep = { ctx: ctx, oscillator: oscillator, warned: false,
          because: this._isPlaying ? 'playing' : 'running' };
        this._audioKeepalive = keep;
        emitRuntimeLog('info', 'audio keepalive started (anti background throttling)',
          { state: ctx.state, because: keep.because });
        // 「起了」不等于「在响」：后台标签页没有用户手势时 resume() 会被拒，
        // 那时这条音轨根本没跑、豁免也就没有 —— 不点名出来就只能靠猜（一次起停只说一遍）。
        var afterResume = function () {
          try {
            if (app._audioKeepalive !== keep) return;
            if (keep.warned || ctx.state !== 'suspended') return;
            keep.warned = true;
            emitRuntimeLog('warn', 'audio keepalive stayed suspended: browser has no user gesture for it',
              { state: ctx.state, because: keep.because });
          } catch (eLog) {}
        };
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          try {
            var pResume = ctx.resume();
            if (pResume && typeof pResume.then === 'function') pResume.then(afterResume, afterResume);
            else afterResume();
          } catch (eResume) { afterResume(); }
        }
      } catch (e) {}
    },


    _stopAudioKeepalive: function () {
      if (!this._audioKeepalive) return;
      try { this._audioKeepalive.oscillator.stop(); } catch (e0) {}
      try { this._audioKeepalive.ctx.close(); } catch (e1) {}
      this._audioKeepalive = null;
    },


    _syncAudioKeepalive: function () {
      var hidden = !!(document.hidden || document.visibilityState === 'hidden');
      // 「在播」只是运行期里的一段：这一节播完正等翻页、文档 / PPT / 讨论 / 投票这些区间
      // 一条媒体都没有，可 tick 循环还在跑。旧判据在这段把音轨停掉，后台标签页就失去
      // 「正在播音频」的豁免 —— Edge 直接把定时器队列冻住（现场实测：面板冻在 20:45:08、
      // setInterval 25 秒不回调，而徽标还写着「正常运行」，连「改面板说自己停了」都做不到）。
      if ((this._isPlaying || this._tickLoopInterval) && hidden) this._startAudioKeepalive();
      else this._stopAudioKeepalive();
    },


    _checkVideoStatus: function () {
      try {
        var video = this._getVideoEl();
        if (!video) return;
        this._ensurePlaybackRate(video, 'guard');
        this._trySeekToEnd(video, 'guard');

        if (video.paused && this._isPlaying && !this._captchaActive) {
          this._tryResumePlayback('paused');
        } else if (this._isPlaying && !video.ended) {
          var now = Date.now();
          var current = Number(video.currentTime || 0);
          if (this._guardLastWallTs === 0) {
            this._guardLastWallTs = now;
            this._guardLastTime = current;
          } else {
            var stalled = Math.abs(current - this._guardLastTime) < 0.01;
            var stalledMs = now - this._guardLastWallTs;
            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
              this._tryResumePlayback('no-progress');
              this._guardLastWallTs = now;
              this._guardLastTime = Number(video.currentTime || 0);
            } else if (!stalled) {
              this._guardLastWallTs = now;
              this._guardLastTime = current;
            }
          }
        }

        // 防拖拽 + 倍速锁 1x 的视频：平台只要求 ≥90%，平台标记完成后就别再白等最后 10%
        if (!video.ended && this._isPlaying && this._shouldAdvanceAtNinetyPercent(video)) {
          this._finishCurrentMedia('ninety-percent');
          return;
        }

        if (video.ended && this._isPlaying) {
          this._finishCurrentMedia('guard');
        }
      } catch (e) {}
    },


    /**
     * 当前视频"播完了"的统一收尾。
     *
     * 两条路径共用：正常的 `ended`，以及「防拖拽 + 锁 1 倍速」的视频到 90% 且平台已标记完成。
     * 抽出来是为了不让两条路各写一份 —— 收尾漏掉一个字段（比如 `_activeMediaJobManaged`）
     * 会让状态机卡住，而症状是"这个任务点过了但下一个不动"，很难查。
     */
    _finishCurrentMedia: function (reason) {
      this._clearCheckInterval();
      if (this._activeMediaJobManaged) {
        this._isPlaying = false;
        this._activeMediaJobPending = false;
        this._activeMediaJobManaged = false;
        this._videoEl = null;
        this._videoCount = 0;
        this._currentVideoIndex = 0;
        this._mediaWaitLogAt = 0;
        emitRuntimeLog('info', 'managed media job ended', { reason: reason || 'guard', jobid: this._activeJobId || '' });
        return;
      }
      if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
        this._currentVideoIndex++;
        this._videoEl = null;
        this._activeMediaJobPending = true;
        this._mediaWaitLogAt = 0;
        return;
      }
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._mediaWaitLogAt = 0;
      this.nextUnit();
    },


    // 倍速是否被平台锁在 1 倍速。探测没结果（0）时一律当作"没锁定" ——
    // 宁可多播一会儿，也不要在没确认的情况下提前结束。
    _isRateLockedAtOne: function () {
      var rate = Number(this._detectedMaxRate);
      return isFinite(rate) && rate > 0 && rate <= 1.001;
    },


    /**
     * 「防拖拽 + 倍速锁 1x」的视频 —— 平台只要求观看时长 ≥ 总时长的 90%。
     *
     * 判据是两个"平台不让我们加速"的信号**同时**成立：
     *   1) 拖到结尾被播放器弹回（不可拖拽，见 _trySeekToEnd）
     *   2) 倍速探测结果就是 1x（老师把倍速也锁了）
     * 只满足一个都不算：能拖的视频早就拖到结尾了，能加速的视频也不该提前结束。
     */
    _isNinetyPercentVideo: function (video) {
      if (!video) return false;
      var mediaTag = String(video.tagName || '').toLowerCase();
      if (mediaTag !== 'video' && mediaTag !== 'audio') return false; // 视频/音频都适用（拖不动+锁1x 时到 90% 提前收尾）
      if (!this._isRateLockedAtOne()) return false;
      var key = this._getMediaSeekKey(video);
      if (!key) return false;
      return !!(this._seekRevertedKeys && this._seekRevertedKeys[key]);
    },


    /**
     * 「可拖动」关上时，90% 提前收尾这条路被放弃了 —— 每支媒体只点名一次。
     *
     * 为什么要有这一发：这一族以前**一条日志都不留**（AGENTS §2 #14：判据不许停在"决定不做"）。
     * 现场表现是"倍速锁在 1x、平台已标记完成、进度都过 90% 了还在原速播"，而弹窗里
     * 那枚「看到 90% 就进下一个」明明亮着 —— 人只能猜。说清是被上面那枚开关挡的，
     * 用户才知道该去开哪个（这一条的证据来自用户 2026-11-20 那句「用户可观看到界面不知道要成立」）。
     *
     * ⚠️ 判据取的是「除了拖拽证据，其余条件全都成立」，所以每 1500 毫秒进来一次的
     *    巡检在"还没到 90%""平台没确认完成"那几拍**一句都不说** —— 200 条的证据窗不会被吃光（§2 #16(b)）。
     *    账本 `_ninetyHeldBackKeys` 与 `_seekSkipLedger` 同一族：**不许被 `_resetRuntimeState` 抹掉**（§2 #13）。
     */
    _noteNinetyHeldBack: function (video) {
      try {
        if (!video) return false;
        var mediaTag = String(video.tagName || '').toLowerCase();
        if (mediaTag !== 'video' && mediaTag !== 'audio') return false;
        var duration = Number(video.duration);
        if (!isFinite(duration) || duration <= 0) return false;
        var ratio = Number(video.currentTime || 0) / duration;
        if (!(ratio >= 0.9) || ratio >= 0.995) return false;
        if (!this._isRateLockedAtOne()) return false;
        if (!this._isDocumentFrameFinished(video.ownerDocument)) return false;
        var key = this._getMediaSeekKey(video);
        if (!key) return false;
        if (!this._ninetyHeldBackKeys) this._ninetyHeldBackKeys = Object.create(null);
        if (this._ninetyHeldBackKeys[key]) return true;
        if (Object.keys(this._ninetyHeldBackKeys).length > 300) {
          this._ninetyHeldBackKeys = Object.create(null);
        }
        this._ninetyHeldBackKeys[key] = true;
        emitRuntimeLog('info', 'advance at 90% held back: seek disabled', {
          ratio: Number(ratio.toFixed(3)),
          duration: Number(duration.toFixed(1)),
          jobid: this._activeJobId || ''
        });
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * 该不该在播到 90% 时提前收尾。
     *
     * 最关键的一条：**必须由平台自己给出"任务点已完成"的标记**。
     * 只按"播够 90% 就当作完成"会误跳过任务点，比多花十分钟严重得多 ——
     * 这与本仓库对"拿不准"的一贯取舍一致（见 `_isJobCompleted` 的说明）。
     */
    _shouldAdvanceAtNinetyPercent: function (video) {
      try {
        if (this.configs.advanceAtNinetyPercent === false) return false;
        // 单向绑定（会话任务 #185）：这一条兜底吃的证据「拖到结尾两次都被弹回」只有
        // `_trySeekToEnd` 会写，而它第一行就被 `enableSeek` 挡下 —— 所以「可拖动」关上时
        // `_isNinetyPercentVideo` 恒为 false，这一条开关**结构上永远走不到**（死键）。
        // 与其让它悄悄失灵，不如在真会走到 90% 那一支上明说一次「这条路被放弃了」。
        if (!this.configs.enableSeek) {
          this._noteNinetyHeldBack(video);
          return false;
        }
        if (!this._isNinetyPercentVideo(video)) return false;

        var duration = Number(video.duration);
        if (!isFinite(duration) || duration <= 0) return false;
        var ratio = Number(video.currentTime || 0) / duration;
        if (!(ratio >= 0.9)) return false;  // 还没到 90%
        if (ratio >= 0.995) return false;   // 已到结尾，交给 ended 那条路，避免两条路抢

        if (!this._isDocumentFrameFinished(video.ownerDocument)) return false; // 平台没确认完成就不动

        emitRuntimeLog('info', 'advance at 90% (locked 1x + not seekable)', {
          ratio: Number(ratio.toFixed(3)),
          duration: Number(duration.toFixed(1)),
          jobid: this._activeJobId || ''
        });
        console.log('%c[Omitone] 防拖拽+锁1x：已到 ' + (ratio * 100).toFixed(0) +
          '%，平台已标记完成，直接进下一个', 'color:#4CAF50');
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * 媒体元素此刻是不是"流水线已死"—— 返回 `MediaError.code`
     * （1 中止 / 2 网络 / 3 解码失败 / 4 源不支持），没报错返回 0。
     *
     * 为什么要单独问它：现场实测（2026-11-14，用户挂着刷课，CDP 9334）那一节解码器抛了
     * `PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding`，而 `paused` 仍是 false、
     * `readyState` 仍是 4、`duration` 照样是 1448 —— 手上每一道"看 paused / 看有没有源"的判据
     * 都说"在播"，**只有 `error` 这一个字段说真话**。
     * ⚠️ 整个取值包 try：自定义播放器偶尔把 `error` 换成别的形状（字符串、没有 code 的对象），
     *    而这条判据在 guard 与 tick 上每秒都会被问一次 —— 它一抛就把整轮巡检打死。
     */
    _mediaErrorCode: function (media) {
      try {
        if (!media) return 0;
        var code = Number(media.error && media.error.code);
        return (code >= 1 && code <= 4) ? code : 0;
      } catch (e) {
        return 0;
      }
    },


    /**
     * 死流水线的**原地重载**：源不动，`load()` 让浏览器重建解码管线，播放位置等元数据回来再接回去。
     *
     * ⚠️ 为什么不用 `_maybeRepairMediaSource` 那条 blob 补救：那是**整个文件取回来重封 MIME**，
     *    治的是「格式 / MIME 不对」这一族，对「下载到一半坏包」没用；而且它靠 `fetch` ——
     *    2026-11-15 现场直接量到：那个源的 `fetch` 抛 `TypeError`（CDN `s2.cldisk.com` 不给 CORS 头），
     *    所以那条路对这一族**永久关闭**，还顺手把 src 记成「补救过了」。**一个补救只管自己那一族，别指望它顺带治解码。**
     * ⚠️ 这里**不等任何东西**（不调 `await`）：`load()` 之后由一次性 `loadedmetadata` 补 seek，
     *    下一轮 guard 看到 `error` 已被清掉就照常走。在这条链上加等待就得配超时，
     *    而等待本身没有收益（AGENTS §2.2）。
     *
     * 2026-11-15 现场（CDP 9334，用户挂着刷课）把原先「每个源只试一次」改成了**有界重试**，两条实测：
     *   ① `load()` 确实是对症的药 —— 那一节 `error.code=3`、`currentTime` 卡在 4.39 **两分多钟**，
     *      手工 `load()` 之后 `error` 归 0、`readyState` 回 4，再 `play()` 8 秒时间真的走了 7.95 秒。
     *   ② 但原先重载把位置**放回死掉那一秒**（日志里 `resumeAt=4.39`），而 `error.message` 明写着
     *      坏包在 `timestamp=4650667`（4.65 秒）—— 重载完立刻又撞同一个坏字节，第二次解码错误
     *      落在同一个位置，而那时「只试一次」的闸已经烧光，这一节只能干等到 120 秒兜底放手。
     *      **一次机会全花在同一个坑上。**
     * 所以现在：第一次仍回原位（纯网络抖动不需要跳，跳了白丢进度）；第二次起落到坏包时间戳之后。
     * ⚠️ 次数与间隔写死在这里，**不开新配置键** —— 加一个键要动三份默认值 + 界面绑定 +
     *    策略区间（自检第 12 项守着），而这两个数不是给用户调的。上限 3 次、间隔 20 秒，
     *    整体仍由 `_isActiveMediaPending` 那个 120 秒放手兜底 —— 不可能无限重载。
     */
    _reloadMediaInPlace: function (media, reason) {
      try {
        var code = this._mediaErrorCode(media);
        if (!code) return false;
        var key = this._getMediaSeekKey(media);
        if (!key) return false;
        if (!this._mediaReloadKeys) this._mediaReloadKeys = Object.create(null);
        var prevReload = this._mediaReloadKeys[key];
        var doneAttempts = Number(prevReload && prevReload.n) || 0;
        if (doneAttempts >= 3) return false;
        if (doneAttempts > 0 && Date.now() - (Number(prevReload.at) || 0) < 20000) return false;

        var diedAt = Number(media.currentTime || 0);
        // 坏包位置就写在 message 里（PIPELINE_ERROR_DECODE 带 {timestamp=<微秒> ...}）。
        // 解析失败就当没有（回原位 / 往前挪 12 秒），不许因为读不出时间戳而不救。
        var badSec = 0;
        try {
          var mBad = /timestamp=(\d+)/.exec(String((media.error && media.error.message) || ''));
          if (mBad) badSec = Number(mBad[1]) / 1000000;
        } catch (eMsg) {}
        var resumeAt = diedAt;
        if (doneAttempts > 0) {
          var jumpTo = Math.max(diedAt, (badSec > 0 ? badSec : diedAt) + 12);
          var dur = Number(media.duration || 0);
          // 不许跳到结尾之后（那等于直接判完）；离结尾太近就留在原位，让它自然播完。
          if (dur > 30) jumpTo = Math.min(jumpTo, Math.max(diedAt, dur - 10));
          resumeAt = jumpTo;
        }
        this._mediaReloadKeys[key] = { at: Date.now(), n: doneAttempts + 1, resumeAt: resumeAt };

        emitRuntimeLog('warn', 'media pipeline dead, reload in place', {
          code: code,
          attempt: doneAttempts + 1,
          diedAt: diedAt,
          resumeAt: resumeAt,
          badSec: Math.round(badSec * 100) / 100,
          reason: reason || ''
        });
        if (resumeAt > 0) {
          var self = this;
          media.addEventListener('loadedmetadata', function () {
            // `load()` 会把 currentTime 归零，位置必须等元数据回来再补 ——
            // 现在就设会被 readyState 0 的状态吞掉，症状是「重载过了，却从第一秒重新播」。
            try { media.currentTime = resumeAt; } catch (e0) {}
            self._ensurePlaybackRate(media, 'reload');
          }, { once: true });
        }
        media.load();
        var started = media.play();
        if (started && typeof started.catch === 'function') {
          started.catch(function () {
            // 自动播放策略挡住了就静音重试一次（与 _tryResumePlayback 同一个兜底）
            try {
              media.muted = true;
              var retry = media.play();
              if (retry && typeof retry.catch === 'function') retry.catch(function () {});
            } catch (e1) {}
          });
        }
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * 站点播放器自己的「开始」键 —— 只认现场量到的那两枚（批次 178，2026-11-19 只读实测）。
     *
     * 现场形状：视频在 `top>iframe>f0` 的 `/ananas/modules/video/index.html` 里，
     * 播放器是 video.js v7，根节点 `div.video-js` 用 `vjs-has-started` / `vjs-playing` 表态。
     *
     * ⚠️ 必须在**这一枚视频自己的** `.video-js` 容器里找，而且只用下面两个写死的类名：
     *    同一个容器里还躺着 `vjs-default-button`（「重启 恢复全部设定至预设值」）、
     *    `vjs-playback-rate`（倍速菜单）、`vjs-mute-control` —— 任何 `[class*=play]`
     *    式的模糊匹配都会把它们扫进来，而点到「重启」那枚等于把用户的播放器设定清掉。
     *  - `vjs-big-play-button`：未开播时的中央覆盖层，文字「播放视频」；在播时
     *    `display:none`（现场实测矩形 0×0），所以"看得见"就是"还没开始"。
     *  - `vjs-play-control`：控制条上的播放/暂停切换键，**在播时带 `vjs-playing` 类、
     *    文字是「暂停」** —— 那种状态下点它等于按停，所以必须反着认。
     */
    _siteStartControlOf: function (video) {
      var doc = video && (video.ownerDocument || document);
      if (!doc) return null;
      var scope = doc;
      try {
        if (video.closest) {
          var host = video.closest('.video-js, .vjs-player');
          if (host) scope = host;
        }
      } catch (e0) {}
      try {
        var big = scope.querySelector('.vjs-big-play-button');
        if (big && visible(big)) return { el: big, rung: 'big-play' };
        var toggle = scope.querySelector('.vjs-play-control');
        if (toggle && visible(toggle) && !/vjs-playing/i.test(String(toggle.className || ''))) {
          return { el: toggle, rung: 'play-toggle' };
        }
      } catch (e1) {}
      return null;
    },


    /**
     * 「开头一直卡住」的最后一档：去点站点自己的开始键。
     *
     * 用户口径是「点一下开始就正常了，否则一直黑屏不动或者抽搐」。上面 `_tryResumePlayback`
     * 直调 `video.play()` 那一族**绕过了站点播放器自己的状态机**：它拿不到 play 事件时
     * `_resumeAttemptCount` 每 15 秒换窗归零，于是整局都在原地重复同一发 play()，
     * 而那两枚按钮背后的 handler 一次都没被走到 —— 人工点一下走的恰恰是那条路。
     *
     * 有界：一节最多 2 发、间隔 45 秒，键同 `_getMediaSeekKey`（与 `_mediaReloadKeys`
     * 一样**不随换节清理**，清了就会在同一节里反复点）。点成功之后由站点自己派发的
     * play 事件复位整套计数（`_handleVideoPlay`）。烧完还没起来只说**一次**交回人 ——
     * 静默放手是不可接受的（AGENTS §2 #7），hint 里照用户的话告诉他亲手点一下。
     *
     * 只在「还停在开头」那一形状上动手：已经播出去一段的停滞交给 no-progress 与 90% 兜底，
     * 那种情况点开始键等于替人把看过的两分钟重播一遍。音频不做 —— 现场只量过视频那一族，
     * 音频播放器是另一个形状，没量过就不动手。
     */
    _nudgeSiteStartControl: function (video, reason) {
      try {
        if (!video || !this._isPlaying) return false;
        if (String(video.tagName || '').toLowerCase() !== 'video') return false;
        var key = this._getMediaSeekKey(video);
        if (!key) return false;
        var ct = Number(video.currentTime || 0);
        var dur = Number(video.duration || 0);
        if (ct > 2) return false;
        if (dur > 0 && ct > Math.min(30, dur * 0.02)) return false;

        if (!this._startNudgeKeys) this._startNudgeKeys = Object.create(null);
        var prev = this._startNudgeKeys[key];
        var done = Number(prev && prev.n) || 0;
        var now = Date.now();
        var detail = {
          ct: Math.round(ct * 100) / 100,
          dur: Math.round(dur * 100) / 100,
          ready: Number(video.readyState || 0),
          paused: !!video.paused,
          reason: reason || ''
        };

        if (done >= 2) {
          if (!prev.gaveUp) {
            prev.gaveUp = true;
            detail.nudges = done;
            detail.hint = '这一节从头就没起来，插件已经点过两回站点自己的开始键。' +
              '这一族人工点一下「开始」通常就好了 —— 请在这页上亲手点一次，或者刷新这一页（F5）再让它刷';
            emitRuntimeLog('warn', 'media start stuck, left to human', detail);
          }
          return false;
        }
        if (prev && now - (Number(prev.at) || 0) < 45000) return false;

        // 站点为弹题有意把视频按下时不许抢（与 `_handleVideoPause` 同一口径）。
        // 这个谓词会扫 DOM，本来只在 pause 事件里调；这里一次任务最多走到两回，
        // 不按拍调，所以不引缓存 —— 别把它挪回每拍都问的位置。
        if (this._popupQuizBlocksPlayback && this._popupQuizBlocksPlayback()) return false;

        var found = this._siteStartControlOf(video);
        if (Object.keys(this._startNudgeKeys).length > 300) this._startNudgeKeys = Object.create(null);
        if (!found) {
          // 「认不出开始键」单独占一格，不许塌成"点过了"（AGENTS §2 #12）。
          this._startNudgeKeys[key] = { n: done + 1, at: now, rung: 'none' };
          detail.rung = 'none';
          emitRuntimeLog('warn', 'media start stuck, no site start control', detail);
          return false;
        }
        this._startNudgeKeys[key] = { n: done + 1, at: now, rung: found.rung };
        detail.rung = found.rung;
        detail.attempt = done + 1;
        emitRuntimeLog('warn', 'media start stuck, clicked site start control', detail);
        try { found.el.click(); } catch (eClick) { return false; }
        return true;
      } catch (e) {
        return false;
      }
    },


    _tryResumePlayback: function (reason) {
      var now = Date.now();
      var video = this._getVideoEl();
      if (!video || !this._isPlaying) return;

      // ⚠️ 死流水线先走重载，而且**必须放在下面三道闸之前**：那三道闸烧完 5 次就永久 return，
      //    而计数器只在 `play` 事件里清零 —— 管线死了 `play` 事件永远不会来，
      //    于是重载一次也轮不到（现场那 5 发 play() 全白烧，之后一动不动）。
      if (this._mediaErrorCode(video)) {
        this._reloadMediaInPlace(video, reason || 'resume');
        return;
      }

      if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;

      if (!this._resumeWindowStart || now - this._resumeWindowStart > this.configs.guardMaxResumeWindow) {
        this._resumeWindowStart = now;
        this._resumeAttemptCount = 0;
      }
      if (this._resumeAttemptCount >= this.configs.guardMaxResumes) return;

      this._resumeAttemptCount++;
      this._guardLastResumeTs = now;

      // 第 3 发 play() 之后照旧起不来，就换成点站点自己的开始键（批次 178）。
      // 点着了我们这一拍就不再补一发 play() —— 让站点那条路先把状态机走起来。
      if (this._resumeAttemptCount >= 3 && this._nudgeSiteStartControl(video, reason || 'resume')) return;

      this._ensurePlaybackRate(video, reason || 'resume');
      video.play().catch(function () {
        video.muted = true;
        video.play().catch(function () {});
      });
    },


    _getVideoEl: function (index) {
      var idx = typeof index === 'number' ? index : this._currentVideoIndex;
      var self = this;
      if (!this._videoEl) {
        function findVideos(doc, depth) {
          if (!doc || depth > 4) return { visible: [], hiddenAudio: [] };
          var all = Array.from(doc.querySelectorAll('video, audio'));
          var vis = all.filter(self._isVisibleMedia);
          var hiddenAudio = all.filter(function (media) {
            return String(media.tagName || '').toLowerCase() === 'audio' && !self._isVisibleMedia(media);
          });
          var frames = Array.from(doc.querySelectorAll('iframe'));
          for (var i = 0; i < frames.length; i++) {
            try {
              var subDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
              var sub = findVideos(subDoc, depth + 1);
              vis = vis.concat(sub.visible);
              hiddenAudio = hiddenAudio.concat(sub.hiddenAudio);
            } catch (e) {}
          }
          return { visible: vis, hiddenAudio: hiddenAudio };
        }

        try {
          var doc = this._getMainDocument();
          var found = doc ? findVideos(doc, 0) : findVideos(document, 0);
          // 优先可见媒体，其次隐藏的音频（音频任务点常把 <audio> 藏起来）
          var allVideos = found.visible.length ? found.visible : found.hiddenAudio;
          if (allVideos.length === 0) return null;
          this._videoCount = allVideos.length;
          this._videoEl = allVideos[Math.min(idx, allVideos.length - 1)];
        } catch (e2) {
          return null;
        }
      }
      return this._videoEl;
    },


    _videoEventHandle: function () {
      var el = this._videoEl;
      if (!el) return;

      try {
        if (this._onVideoEnded) el.removeEventListener('ended', this._onVideoEnded);
        if (this._onVideoLoaded) el.removeEventListener('loadedmetadata', this._onVideoLoaded);
        if (this._onVideoPlay) el.removeEventListener('play', this._onVideoPlay);
        if (this._onVideoPause) el.removeEventListener('pause', this._onVideoPause);
        if (this._onVideoRateChange) el.removeEventListener('ratechange', this._onVideoRateChange);
        if (this._onVideoError) el.removeEventListener('error', this._onVideoError);
      } catch (e) {}

      this._onVideoEnded = this._handleVideoEnded.bind(this);
      this._onVideoLoaded = this._handleVideoLoaded.bind(this);
      this._onVideoPlay = this._handleVideoPlay.bind(this);
      this._onVideoPause = this._handleVideoPause.bind(this);
      this._onVideoRateChange = this._handleVideoRateChange.bind(this);
      this._onVideoError = this._handleMediaError.bind(this);

      el.addEventListener('ended', this._onVideoEnded);
      el.addEventListener('loadedmetadata', this._onVideoLoaded);
      el.addEventListener('play', this._onVideoPlay);
      el.addEventListener('pause', this._onVideoPause);
      el.addEventListener('ratechange', this._onVideoRateChange);
      el.addEventListener('error', this._onVideoError);
    },


    // 媒体元素报错（1 中止 / 2 网络 / 3 解码失败 / 4 格式或 MIME 不支持）
    // 之前完全没有这个监听，m4a 之类的格式问题永远不会被发现
    _handleMediaError: function (event) {
      var el = event && event.target ? event.target : this._getVideoEl();
      if (!el) return;
      var code = el.error ? el.error.code : 0;
      var message = el.error ? String(el.error.message || '') : '';
      var src = String(el.currentSrc || el.src || '');
      emitRuntimeLog('error', 'media error', {
        code: code,
        message: message.slice(0, 120),
        src: src.slice(-80),
        tag: String(el.tagName || '').toLowerCase()
      });

      // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED（m4a、服务器 MIME 不对最常见），3 = 解码失败
      if (code === 4 || code === 3) {
        var self = this;
        this._maybeRepairMediaSource(el).then(function (ok) {
          emitRuntimeLog(ok ? 'info' : 'error', ok ? 'media source repaired (m4a/mime fallback), replaying' : 'media source repair failed', {
            src: src.slice(-80)
          });
        }).catch(function () {});
      }
    },


    _guessMediaMime: function (url) {
      var u = String(url || '').toLowerCase().split('?')[0];
      if (/\.m3u8$/.test(u)) return '';
      if (/\.m4a$|\.aac$/.test(u)) return 'audio/mp4';
      if (/\.mp3$/.test(u)) return 'audio/mpeg';
      if (/\.ogg$|\.oga$/.test(u)) return 'audio/ogg';
      if (/\.wav$/.test(u)) return 'audio/wav';
      if (/\.webm$/.test(u)) return 'audio/webm';
      if (/\.mp4$|\.m4v$/.test(u)) return 'video/mp4';
      return 'audio/mp4'; // 学习通音频多为 m4a（AAC）
    },


    // 音源不受支持时的兜底：把音频文件取回来，用正确的 MIME 重新封装成 Blob 再播。
    // 全程在页面内完成（不经过扩展消息），避免大文件传输。
    _maybeRepairMediaSource: async function (media) {
      try {
        if (!media) return false;
        var src = String(media.currentSrc || media.src || '');
        if (!src || /^blob:/i.test(src)) return false;
        if (/\.m3u8/i.test(src)) return false; // HLS 由播放器自己处理，不能这样补救

        if (!this._mediaRepaired) this._mediaRepaired = Object.create(null);
        if (this._mediaRepaired[src]) return false;
        this._mediaRepaired[src] = true; // 每个源只补救一次，避免死循环

        // ⚠️ fetch 与读响应体都**必须**可超时。服务器接了连接却不回数据时（CDN 卡住、
        //    被门户/代理吞掉），await 会永久挂起 —— 而这条链在 _runTick 上，
        //    一挂就是整个调度停摆（验证码检测、播放巡检、任务点推进全停）。
        //    注意 try/catch 拦不住"挂起"，只有超时能。
        //    _withTimeout 超时是 resolve(undefined)，下面两处 `!response` / `!buf` 判断正好接得住。
        var response = await this._withTimeout(fetch(src, { credentials: 'include' }), 20000);
        if (!response || !response.ok) return false;
        var buf = await this._withTimeout(response.arrayBuffer(), 60000);
        if (!buf || buf.byteLength < 1024) return false;

        var type = this._guessMediaMime(src);
        var blob = new Blob([buf], { type: type });
        var objectUrl = URL.createObjectURL(blob);
        var resumeAt = Number(media.currentTime || 0);

        media.src = objectUrl;
        media.load();
        await new Promise(function (resolve) {
          var done = false;
          var finish = function () {
            if (!done) { done = true; resolve(); }
          };
          media.addEventListener('canplay', finish, { once: true });
          media.addEventListener('error', finish, { once: true });
          setTimeout(finish, 8000);
        });

        if (resumeAt > 0) {
          try { media.currentTime = resumeAt; } catch (e0) {}
        }
        this._ensurePlaybackRate(media, 'repair');
        await this._withTimeout(media.play(), 12000);
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * `ended` 事件的处理。收尾逻辑与 `_checkVideoStatus` 那条路**完全一致**，
     * 所以统一走 `_finishCurrentMedia`。
     *
     * 这里原本多清了三个字段（`_activeDocumentJobPending` / `_activeDocumentJobManaged` /
     * `_activeDocumentJobDoc`），已经确认那是**过界的**，理由有三条：
     *   1) `nextUnit()` 末尾会调 `_resetRuntimeState()`，那些字段本来就会被清掉 ——
     *      正常路径下多清一次是纯冗余；
     *   2) 只有在 `nextUnit()` **提前返回**时（典型是 `autoNext:false`）才有差别，
     *      而那时清掉它们等于**放弃一个可能正在进行的文档任务点** —— 正是本仓库
     *      最怕的"静默漏做"。不清才是对的；
     *   3) 对称：文档任务点完成时（约 2607 行）只清文档自己的状态，不去动媒体状态。
     *      媒体这边同理，只管媒体。
     * 万一真的残留了过期的文档状态，文档那条路自己有 `document stuck timeout` 会兜住。
     */
    _handleVideoEnded: function () {
      this._finishCurrentMedia('event');
    },


    _handleVideoLoaded: function (event) {
      this._resetRateDetection();
      var loadedVideo = event && event.target ? event.target : this._getVideoEl();
      this._ensurePlaybackRate(loadedVideo, 'loadedmetadata');
      this._trySeekToEnd(loadedVideo, 'loadedmetadata');
    },


    _handleVideoPlay: function () {
      this._isPlaying = true;
      this._stepSwitchPending = false;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      this._syncAudioKeepalive();
      var video = this._getVideoEl();
      this._ensurePlaybackRate(video, 'play');
      this._guardLastTime = Number((video && video.currentTime) || 0);
      this._guardLastWallTs = Date.now();
      if (this._delayedNextUnitTimer) {
        clearTimeout(this._delayedNextUnitTimer);
        this._delayedNextUnitTimer = null;
      }
    },


    _handleVideoPause: function (event) {
      // pause 事件的派发不受后台定时器节流影响：视频被网站/浏览器在后台暂停时立即安排恢复
      var video = event && event.target ? event.target : this._getVideoEl();
      if (!video || video.ended || !this._isPlaying) return;
      if (this._rateProbing) return;
      if (this._pauseResumePending) return;

      var self = this;
      this._pauseResumePending = true;
      this._workerDelay(function () {
        self._pauseResumePending = false;
        var current = self._getVideoEl() || video;
        if (!current || current.ended || !self._isPlaying || !current.paused) return;
        // 验证码/弹窗题/提交确认弹窗打开期间视频是被有意暂停的，不要抢恢复
        try {
          if (self._captchaActive || self._checkCaptchaDialog()) return;
          // ⚠️ 这里必须用 _popupQuizBlocksPlayback 而不是 _activePopupBlock：
          // 后者在"刚答完的静默期"里会返回 null（那是给"要不要再问模型"用的），
          // 但弹窗其实还挂在页面上、视频正是被它有意暂停的。用错就会去抢恢复播放、
          // 和站点对打 —— 现场表现是"答完弹题后视频不动，看着像卡死"。
          if (self._popupQuizBlocksPlayback && self._popupQuizBlocksPlayback()) return;
          if (self._checkSubmitConfirmDialog && self._checkSubmitConfirmDialog()) return;
        } catch (e) {}
        var duration = Number(current.duration || 0);
        if (duration && Number(current.currentTime || 0) >= duration - 0.5) return;

        // ── 后台对打的自限闸（批次 63）──────────────────────────────────
        // 站点在页面 hidden 时自己把视频按住，而我们 600 毫秒后又 play() 一次 ——
        // 两边一来一回，画面在播放/暂停之间闪（用户看到的是"疯狂暂停"），
        // 而**进度一分不涨**：2026-11-15 16:12 现场实测，标签页在后台那 15 秒里
        // currentTime 一直停在 241.24，日志里这条 warn 一分钟来两回。
        // 判据不看"有没有暂停事件"，看**恢复之后时间有没有往前走**（下面那发 6 秒回测）：
        // 连着三次没动才认定这一页在后台被按住了，转 5 分钟冷却；
        // 回到前台那一拍立刻作废冷却（见 20-dom.js `_bindVisibilityHandlers`）。
        // 能在后台照常播的那些站点因为"时间在动"会被清零，行为一点不变。
        if (document.hidden && Date.now() < (self._bgHoldUntil || 0)) return;
        if (!document.hidden) { self._bgHoldUntil = 0; self._bgStuckCount = 0; }

        // ⚠️ 这条 warn 要节流（批次 20-H，实测冲掉过别的现场证据）：
        // 标签页在后台时站点自己会把视频暂停，于是它**每秒一条**，把 runtimeLogs
        // 那个只有 200 条的缓冲区整个占满 —— 真正要看的「讨论为什么没发上」就被冲走了。
        var hiddenNow = !!(document.hidden || document.visibilityState === 'hidden');
        var now = Date.now();
        self._pauseResumeSuppressed = (self._pauseResumeSuppressed || 0) + 1;
        if (now - (self._pauseResumeLogAt || 0) >= 60000) {
          emitRuntimeLog('warn', 'video paused unexpectedly, resuming (anti background pause)', {
            hidden: hiddenNow,
            time: Math.round(Number(current.currentTime || 0)),
            suppressed: self._pauseResumeSuppressed - 1
          });
          self._pauseResumeLogAt = now;
          self._pauseResumeSuppressed = 0;
        }
        var resumed = current.play();
        if (resumed && typeof resumed.then === 'function') {
          resumed.then(function () {
            self._ensurePlaybackRate(current, 'pause-resume');
          }).catch(function () {
            try {
              current.muted = true;
              current.play().catch(function () {});
            } catch (e1) {}
          });
        }
        // 这一发恢复到底有没有让进度往前走 —— 6 秒后回测一次（只有 hidden 才记账，
        // 且必须比的是**同一只**元素：站点换源时 _getVideoEl() 会给出另一只，
        // 那种情况当作"没走到冷却"重新计数，不许拿别人的时间差定我的罪）。
        if (hiddenNow) {
          var t0 = Number(current.currentTime || 0);
          var watched = current;
          setTimeout(function () {
            try {
              if (!document.hidden) { self._bgHoldUntil = 0; self._bgStuckCount = 0; return; }
              if ((self._getVideoEl() || current) !== watched) { self._bgStuckCount = 0; return; }
              if (Number(watched.currentTime || 0) > t0 + 0.5) { self._bgStuckCount = 0; return; }
              self._bgStuckCount = (self._bgStuckCount || 0) + 1;
              if (self._bgStuckCount < 3) return;
              self._bgHoldUntil = Date.now() + 5 * 60 * 1000;
              emitRuntimeLog('warn', 'anti background pause held off', {
                hint: '这一页在后台，站点自己把视频按住了 —— 连着三次恢复都没让进度往前走，' +
                      '所以五分钟之内不再和它对打（对打只会让画面在播放/暂停之间闪，进度还是不动）。' +
                      '把这一页切回前台，下一拍就续播',
                stuck: self._bgStuckCount,
                time: Math.round(Number(watched.currentTime || 0)),
                holdMs: 5 * 60 * 1000
              });
            } catch (e) {}
          }, 6000);
        }
      }, 600);
    },


    _handleVideoRateChange: function (event) {
      this._ensurePlaybackRate(event && event.target ? event.target : this._getVideoEl(), 'ratechange');
    },


    /**
     * 找「继续学习」按钮。
     *
     * 学习通在几种情况下会在**播放器右下角**挂一个「继续学习」：弹题答完之后、
     * 视频被判定为挂机之后、或者从插题回到正常播放之前。**不点它进不去正常播放页**，
     * 于是一切照常跑、课程一动不动 —— 和弹题空转是同一类"看着在忙其实卡住"的故障。
     *
     * 这个按钮没有稳定的类名（不同课程模板不一样），只能靠文案 + 位置 + 形态打分：
     * 文案命中「继续学习/继续观看/继续播放」→ 只接受"按钮样"的小节点（避免点到大容器）
     * → 与视频同文档的加分、本身是 button/a 的加分。
     */
    /**
     * 处理完一个覆盖层（弹题 / 「继续学习」）之后把视频拉起来。
     *
     * 两个分支原本各写一份，逻辑稍有出入就会出现"弹题这条能恢复、继续学习那条不能"
     * 这种只在真机上才看得出的差别 —— 抽出来保证两条路走的是同一套动作。
     * 注意只在 `_isPlaying` 时恢复：用户没开刷课时不该替他播。
     */
    _resumeVideoAfterOverlay: function (reason) {
      if (!this._isPlaying) return;
      var video = this._getVideoEl();
      if (!video || !video.paused) return;
      this._ensurePlaybackRate(video, reason || 'overlay');
      try { video.play(); } catch (e) {}
    },
