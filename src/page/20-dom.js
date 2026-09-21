/* ==========================================================================
 * Omitone page.js 片段 02/11 —— DOM / iframe 安全访问 / 通用工具
 * 来源：原 page.js 中散布的 21 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 跨域安全访问的唯一入口：_safeDocOf / _safeWinDoc / _isFrameSameOrigin（**永远不要裸读 `.document`**）
 * 主文档 / 主窗口 / 遍历 frame 与 document 的工具
 * 后台 Worker、超时包装、可见性绑定等基础设施
 *
 * 本段的方法（21 个）：
 *   _getMainFrame、_getMainDocument、_getCurrentTitle、_getCurrentChapterId、
 *   _dismissPopups、_walkFrames、_safeJsonParse、_safeDocOf、_safeWinDoc、
 *   _isFrameSameOrigin、_getMainWindow、_withTimeout、_ensureBackgroundWorker、
 *   _workerDelay、_bindVisibilityHandlers、_resolveImageUrl、
 *   _markMainFrameCrossOrigin、_checkBlockedByCrossOrigin、_walkDocs、_studyDocs、
 *   _walkDocuments
 * ========================================================================== */
// @omitone-part-header-end

    _getMainFrame: function () {
      return document.querySelector('#iframe');
    },


    _getMainDocument: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
      } catch (e) {
        return null;
      }
    },


    _getCurrentTitle: function () {
      var el = document.querySelector('.prev_title');
      return el ? textOf(el).slice(0, 60) : '';
    },


    _getCurrentChapterId: function () {
      if (this._lastChapterKey) return String(this._lastChapterKey);
      var frame = this._getMainFrame();
      var raw = frame ? (frame.src || '') : location.href;
      var match = raw.match(/(?:knowledgeid|chapterId)=([^&]+)/i);
      return match ? String(match[1]) : '';
    },


    _dismissPopups: function () {
      var texts = ['继续', '下一节', '跳过', '取消', '关闭', '知道了', '确定'];
      try {
        var buttons = document.querySelectorAll('button, a, .btn, [class*="btn"], .layui-layer-btn a, .layui-layer-btn0, .layui-layer-btn1');
        for (var i = 0; i < buttons.length; i++) {
          if (!visible(buttons[i])) continue;
          var t = textOf(buttons[i]);
          var parentText = '';
          try {
            var container = buttons[i].closest ? buttons[i].closest('.layui-layer, .el-message-box, .ant-modal, .dialog, .modal, [role="dialog"]') : null;
            parentText = container ? textOf(container) : '';
          } catch (e0) {}
          if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(parentText)) {
            return false;
          }
          if (/确认提交|确定提交|确认交卷|是否提交|交卷确认/.test(parentText) && t.indexOf('取消') !== -1) {
            continue;
          }
          for (var j = 0; j < texts.length; j++) {
            if (t.indexOf(texts[j]) !== -1) {
              // 记下到底点了什么。这个函数**只按文案匹配、点完就返回**，
              // 现场报过「答对后选项一直闪」，但看不出是谁在点 —— 补上日志才能定位。
              emitRuntimeLog('info', 'dismiss popups: click', {
                text: String(t).slice(0, 30),
                cls: String(buttons[i].className || '').slice(0, 60),
                matched: texts[j]
              });
              buttons[i].click();
              return true;
            }
          }
        }
        var closeBtn = document.querySelector('.layui-layer-close, .pop-close, .dialog-close, .modal-close, [class*="close"]');
        if (closeBtn && visible(closeBtn)) {
          var closeContainer = closeBtn.closest ? closeBtn.closest('.layui-layer, .el-message-box, .ant-modal, .dialog, .modal, [role="dialog"]') : null;
          if (closeContainer && /确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(textOf(closeContainer))) {
            return false;
          }
          closeBtn.click();
          return true;
        }
      } catch (e) {}
      return false;
    },


    _walkFrames: function (doc, visitor, depth) {
      if (!doc || depth > 4) return;
      var frames = [];
      try {
        frames = doc.querySelectorAll("iframe");
      } catch (e) {}

      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        visitor(frame);
        try {
          var subDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          this._walkFrames(subDoc, visitor, depth + 1);
        } catch (e2) {}
      }
    },


    _safeJsonParse: function (value, fallback) {
      try {
        return JSON.parse(value);
      } catch (e) {
        return fallback;
      }
    },


    // 跨域窗口读 .document 会抛 SecurityError:
    // "Blocked a frame with origin X from accessing a cross-origin frame"
    // 该异常一旦冒泡到 _runTick，会打断整轮调度（验证码检测、播放巡检全部停摆）。
    // 所有 iframe/window -> document 的访问必须统一走下面三个助手。
    _safeDocOf: function (source) {
      try {
        if (!source) return null;
        if (source.contentDocument) return source.contentDocument;
        var win = source.contentWindow || source;
        if (win && win.document) return win.document;
      } catch (e) {}
      return null;
    },


    _safeWinDoc: function (win) {
      try { return (win && win.document) || null; } catch (e) { return null; }
    },


    // 帧是否同源可访问（跨域返回 false，绝不抛异常）
    _isFrameSameOrigin: function (frame) {
      try {
        var win = frame && frame.contentWindow;
        return !!(win && win.document);
      } catch (e) {
        return false;
      }
    },


    _getMainWindow: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentWindow || null;
      } catch (e) {
        return null;
      }
    },


    // 给可能永久 pending 的 Promise（如 video.play() 在视频源停摆时）加超时护栏，
    // 防止 _runTick 的 await 挂死导致整个循环停止
    _withTimeout: function (promise, ms) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(undefined); // 超时按成功放行，实际播放状态由后续巡检兜底
        }, ms || 10000);
        Promise.resolve(promise).then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });
    },


    // ---- 后台/最小化防节流 ----
    // 浏览器对后台标签页的 setTimeout/setInterval 有强节流（最低 1 次/分钟），
    // 且静音（不可听）媒体在后台会被暂停/降速播放。以下三层防御保证最小化后视频继续推进：
    // 1. Worker 心跳：Web Worker 内的定时器不受标签页可见性节流，用它持续驱动视频守护
    // 2. pause 事件立即恢复：事件派发不受定时器节流，视频被网站/浏览器暂停后第一时间恢复
    // 3. 无声音频保活：让浏览器把标签页视为"正在播放音频"，豁免强节流与后台静音媒体限制
    _ensureBackgroundWorker: function () {
      if (this._bgWorker) return this._bgWorker;
      try {
        var code = [
          'var interval=null;',
          'onmessage=function(e){var d=e.data||{};',
          "if(d.op==='interval'){",
          '  if(interval)clearInterval(interval);',
          '  interval=setInterval(function(){postMessage({op:"tick"})},d.ms||1500);',
          '}else if(d.op==="delay"){',
          '  setTimeout(function(){postMessage({op:"fire",id:d.id})},d.ms||0);',
          '}else if(d.op==="stop"){',
          '  if(interval)clearInterval(interval);interval=null;',
          '}};'
        ].join('');
        var blob = new Blob([code], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);
        var worker = new Worker(url);
        var self = this;
        this._workerDelayCallbacks = {};
        worker.onmessage = function (e) {
          var d = e.data || {};
          if (d.op === 'tick') {
            if (document.hidden) {
              self._checkVideoStatus();
              if (typeof self._backgroundCaptchaTick === 'function') self._backgroundCaptchaTick();
            }
            return;
          }
          if (d.op === 'fire' && self._workerDelayCallbacks) {
            var fn = self._workerDelayCallbacks[d.id];
            delete self._workerDelayCallbacks[d.id];
            if (typeof fn === 'function') fn();
          }
        };
        worker.postMessage({ op: 'interval', ms: this.configs.videoCheckInterval || 1500 });
        this._bgWorker = worker;
        this._bgWorkerUrl = url;
        emitRuntimeLog('info', 'background worker heartbeat started');
      } catch (e) {
        this._bgWorker = null;
        emitRuntimeLog('warn', 'background worker unavailable, fallback to page timers', {
          error: String(e && e.message ? e.message : e).slice(0, 120)
        });
      }
      return this._bgWorker;
    },


    _workerDelay: function (fn, ms) {
      if (this._bgWorker && this._workerDelayCallbacks) {
        this._workerDelaySeq = (this._workerDelaySeq || 0) + 1;
        var id = 'wd' + this._workerDelaySeq;
        this._workerDelayCallbacks[id] = fn;
        try {
          this._bgWorker.postMessage({ op: 'delay', id: id, ms: ms || 0 });
          return;
        } catch (e) {}
      }
      setTimeout(fn, ms || 0);
    },


    _bindVisibilityHandlers: function () {
      if (this._visibilityBound) return;
      this._visibilityBound = true;
      var self = this;
      document.addEventListener('visibilitychange', function () {
        self._syncAudioKeepalive();
        if (!document.hidden) {
          // 回到前台：立即校验一次视频状态与倍速
          self._checkVideoStatus();
          var video = self._getVideoEl();
          if (video) self._ensurePlaybackRate(video, 'visibility-resume');
        }
      });
    },


    _resolveImageUrl: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var base = doc.baseURI || window.location.href;
        return new URL(img.src || img.currentSrc || '', base).href;
      } catch (e) {
        return '';
      }
    },


    // 主 iframe 被换成跨域页面（验证码/反作弊拦截）：JS 完全无法访问其内部，
    // 既检测不到验证码也填不了，唯一恢复手段就是刷新页面（刷新后由自动续跑接管）
    _markMainFrameCrossOrigin: function () {
      if (!this._mainFrameCrossOriginSince) this._mainFrameCrossOriginSince = Date.now();
    },


    _checkBlockedByCrossOrigin: function () {
      var frame = this._getMainFrame();
      if (!frame) return false;
      if (this._isFrameSameOrigin(frame)) {
        this._mainFrameCrossOriginSince = 0;
        return false;
      }

      this._markMainFrameCrossOrigin();
      var held = Date.now() - (this._mainFrameCrossOriginSince || Date.now());
      var now = Date.now();

      // 页面还在加载时 iframe 归属可能未定，先不判定为被拦截，避免误刷新
      if (document.readyState !== 'complete') {
        this._mainFrameCrossOriginSince = 0;
        return false;
      }

      if (now - (this._crossOriginLogAt || 0) > 15000) {
        this._crossOriginLogAt = now;
        emitRuntimeLog('warn', 'main frame is cross-origin, page likely blocked by captcha/anti-bot', {
          heldSec: Math.round(held / 1000)
        });
      }

      if (held > 20000 && this.configs.blockedReload !== false) {
        if (now - (this._blockedReloadAt || 0) > 180000) {
          this._blockedReloadAt = now;
          emitRuntimeLog('warn', 'blocked page unreachable from JS, reload to recover', {
            heldSec: Math.round(held / 1000)
          });
          try { window.location.reload(); } catch (e) {}
        }
      }

      return true; // 主内容都拿不到，本轮没必要继续跑后面的逻辑
    },


    // 遍历文档树（含 iframe 递归，跨域自动跳过），对每个可访问文档执行 cb
    _walkDocs: function (root, cb) {
      var self = this;
      var seen = [];
      (function walk(doc, depth) {
        if (!doc || depth > 4) return;
        if (seen.indexOf(doc) >= 0) return;
        seen.push(doc);
        try { cb(doc); } catch (e0) {}
        var frames = [];
        try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e1) { return; }
        for (var i = 0; i < frames.length && i < 12; i++) walk(self._safeDocOf(frames[i]), depth + 1);
      })(root, 0);
    },


    _studyDocs: function () {
      var docs = [];
      var mainDoc = null;
      try { mainDoc = this._getMainDocument(); } catch (e0) {}
      if (mainDoc) docs.push(mainDoc);
      if (document !== mainDoc) docs.push(document);
      return docs;
    },


    _walkDocuments: function (visitor, startDoc, depth) {
      var doc = startDoc || document;
      var level = typeof depth === 'number' ? depth : 0;
      if (!doc || level > 4) return false;
      if (visitor(doc)) return true;

      var iframes = [];
      try {
        iframes = doc.querySelectorAll('iframe');
      } catch (e) {}

      for (var i = 0; i < iframes.length; i++) {
        try {
          var subDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
          if (this._walkDocuments(visitor, subDoc, level + 1)) return true;
        } catch (e2) {}
      }
      return false;
    },
