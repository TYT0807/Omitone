/* ==========================================================================
 * Omitone page.js 片段 09/15 —— 讨论任务点
 * 来源：原 page.js 中散布的 27 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 讨论任务点的查找、编辑、提交，以及「已做过」的本地去重
 *
 * 本段的方法（31 个）：
 *   _discussionDoneMap、_markDiscussionDone、_isDiscussionDone、
 *   _unmarkDiscussionDone、_discussionPendingKey、_getDiscussionTries、
 *   _bumpDiscussionTry、_bindDiscussionOutcome、_discussionNameOf、_isDiscussionAttachment、
 *   _findDiscussionEntry、_isDiscussionContext、_scopedDiscussionFinishedFlag、
 *   _discussionKeyOf、_collectDiscussionTargets、_findDiscussionModuleFrames、
 *   _currentStudyParams、_resolveDiscussionUrlFromModule、_findDiscussionTask、
 *   _tryDiscussionTask、_handleDiscussionWait、_refreshChapterAfterDiscussion、
 *   _findDiscussionEditor、_expandDiscussionEditor、_findDiscussionSubmitButton、
 *   _fillDiscussionEditor、_discussionBaseline、_discussionSuccessHint、
 *   _computeDiscussionPage、_isDiscussionPage、_runDiscussionMode
 * ========================================================================== */
// @omitone-part-header-end

    _discussionDoneMap: function () {
      try {
        var raw = localStorage.getItem(this._discussionStoreKey);
        var parsed = raw ? this._safeJsonParse(raw, {}) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    },


    _markDiscussionDone: function (key) {
      try {
        var map = this._discussionDoneMap();
        map[key] = Date.now();
        localStorage.setItem(this._discussionStoreKey, JSON.stringify(map));
      } catch (e) {}
    },


    _isDiscussionDone: function (key) {
      var at = Number(this._discussionDoneMap()[key] || 0);
      return !!at && Date.now() - at < 24 * 3600 * 1000; // 24 小时内不重复处理
    },


    /**
     * 撤回"已完成"标记。
     *
     * _markDiscussionDone 是先于打开动作写的（防止重复打开同一个讨论页），
     * 所以一旦发现根本没能打开，必须把这条记录撤掉 ——
     * 否则该任务点会被静默跳过 24 小时，用户只看到"没做"，日志里毫无线索。
     */
    _unmarkDiscussionDone: function (key) {
      if (!key) return;
      try {
        var map = this._discussionDoneMap();
        if (map[key] === undefined) return;
        delete map[key];
        localStorage.setItem(this._discussionStoreKey, JSON.stringify(map));
      } catch (e) {}
    },


    /**
     * 讨论页里取回"当前正在做哪个讨论"的键 —— 打开讨论页之前由主页写进 localStorage。
     * 有了它，讨论页发现"内容没填进去 / 没确认成功"时才能**撤回标记**，让主页面重开重试。
     */
    _discussionPendingKey: function () {
      try { return String(localStorage.getItem('omitone_discussion_key') || ''); } catch (e) {
        return '';
      }
    },


    /**
     * 某个讨论"已经重试过几次"。
     *
     * ⚠️ 为什么要计数：发失败时要把"已做"标记撤掉让它重试，但**不能无限重试** ——
     * 平台的讨论可能压根发不出去（禁言、字数下限、频率限制），无限重开只会空转。
     * 用独立的 `try|` 前缀键，不去动 `_isDiscussionDone` 读的那套格式。
     */
    _getDiscussionTries: function (key) {
      if (!key) return 0;
      try { return Number(this._discussionDoneMap()['try|' + key] || 0); } catch (e) { return 0; }
    },


    _bumpDiscussionTry: function (key) {
      if (!key) return 0;
      try {
        var map = this._discussionDoneMap();
        var k = 'try|' + key;
        map[k] = Number(map[k] || 0) + 1;
        localStorage.setItem(this._discussionStoreKey, JSON.stringify(map));
        return Number(map[k]);
      } catch (e) { return 0; }
    },


    /**
     * 听讨论页那边的**真实结果**。
     *
     * 为什么必须走 `postMessage` 而不是 localStorage：
     * 刷课页在 `mooc1.chaoxing.com`、讨论页在 `groupweb.chaoxing.com` ——
     * **两个不同的 localStorage**。讨论页里"撤销标记"撤的是它自己那份空存储，
     * 对刷课页毫无影响（2026-10-17 实测踩到：撤标记那段代码等于没写）。
     */
    _bindDiscussionOutcome: function () {
      if (this._discussionOutcomeBound) return;
      this._discussionOutcomeBound = true;
      var self = this;
      try {
        window.addEventListener('message', function (ev) {
          var data = ev && ev.data;
          if (!data || typeof data !== 'object' || data.omitoneDiscussion !== 'failed') return;
          var key = String(self._discussionLastOpenedKey || '');
          if (!key) return;
          var tries = self._bumpDiscussionTry(key);
          var limit = 3;   // 最多重试 3 次：平台若压根发不出去，无限重开只会空转
          if (tries > limit) {
            emitRuntimeLog('warn', 'discussion reply keeps failing, give up for now', {
              key: key.slice(0, 40),
              tries: tries,
              hint: '已连续失败 ' + tries + ' 次，24 小时内不再尝试（可手动处理，或清掉 localStorage 里的 omitone_discussion_done）'
            });
            return;
          }
          self._unmarkDiscussionDone(key);
          emitRuntimeLog('warn', 'discussion reply failed, will retry', {
            key: key.slice(0, 40),
            tries: tries,
            limit: limit
          });
        });
      } catch (e) {}
    },


    _discussionNameOf: function (attachment) {
      if (!attachment) return '';
      var property = attachment.property || {};
      return String(property.name || property.title || attachment.name || attachment.title || '');
    },


    _isDiscussionAttachment: function (attachment) {
      if (!attachment) return false;
      var property = attachment.property || {};
      var meta = String(property.module || attachment.module || '') + ' ' +
        String(property.type || attachment.type || '');
      if (/discuss|discus|bbs|topic|forum|thread|talk/i.test(meta)) return true;
      return /讨论|话题|回帖|发帖/.test(this._discussionNameOf(attachment));
    },


    // 在课程页/同源 iframe 中找讨论任务点的可点击入口（优先带真实链接的 <a>）
    _findDiscussionEntry: function (preferredName) {
      var KEY = /讨论|话题|回帖|发帖|参与讨论/;
      var docs = [];
      try {
        var mainDoc = this._getMainDocument();
        if (mainDoc) docs.push(mainDoc);
        if (document !== mainDoc) docs.push(document);
      } catch (e0) {
        docs.push(document);
      }

      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (!doc || !doc.querySelectorAll) continue;
        var nodes = [];
        try { nodes = Array.from(doc.querySelectorAll('a[href], [onclick], li, div, span')); } catch (e1) { continue; }
        var best = null;
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!visible(node)) continue;
          var text = String(textOf(node) || '').trim();
          if (!text || text.length > 40) continue;
          if (!KEY.test(text)) continue;
          var link = node.tagName === 'A' ? node : node.querySelector('a[href]');
          var href = link ? String(link.getAttribute('href') || '') : String(node.getAttribute('href') || '');
          var score = 0;
          if (preferredName && text.indexOf(preferredName) >= 0) score += 2;
          if (href && href !== '#' && !/^javascript:/i.test(href)) score += 1;
          if (!best || score > best.score) best = { node: link || node, href: href, text: text, score: score };
        }
        if (best) return best;
      }
      return null;
    },


    // 当前是不是"讨论上下文"（讨论区页面 / 讨论模块页）。用网址快判，启动即可用，不依赖 DOM 渲染。
    _isDiscussionContext: function () {
      if (this.configs.enableDiscussion === false) return false;
      var href = '';
      try { href = String(location.href || ''); } catch (e0) { return false; }
      if (/groupweb\.chaoxing\.com|\/course\/topic\/|\/bbscircle\//i.test(href)) return true;
      return this._isDiscussionPage();
    },


    // 讨论任务点在页面里是卡片 #topicMainDiv，其 data 属性就是讨论区地址（groupweb.chaoxing.com/course/topic/...）
    /**
     * 某个讨论卡片自己的"已完成"标志。
     *
     * 学习通把 `#isFinished` 放在**每个讨论模块自己的页面**里，值来自服务端。
     * 旧实现直接用 `doc.getElementById('isFinished')` —— 一个章节里若有多个讨论任务点，
     * 它们可能落在同一个文档中，于是所有卡片共用同一个标志：
     * 第一个已完成，其余全被当作"已回复"而永久跳过；反之则会反复重开同一个。
     *
     * 返回 null 表示"在卡片范围内找不到"，由调用方决定怎么兜底
     * （不要在这里返回 false —— 那会把"未知"当成"未完成"，可能重复发评论）。
     */
    _scopedDiscussionFinishedFlag: function (card) {
      if (!card) return null;
      var readFlag = function (scope) {
        if (!scope || !scope.querySelector) return null;
        var flag = null;
        try {
          flag = scope.querySelector('#isFinished, input[name="isFinished"][value], input[name="isFinished"]');
        } catch (e) {}
        if (!flag) return null;
        return /true/i.test(String(flag.value || flag.getAttribute('value') || ''));
      };

      // 1) 卡片内部
      var inside = readFlag(card);
      if (inside !== null) return inside;

      // 2) 逐层向上找，但只在"只包含本卡片"的祖先上读标志。
      //    ⚠️ 必须先判断祖先里有多少张卡片，再读标志 —— 顺序反了就会在
      //    多卡片共用的容器上读到共用值，原 bug 原样复发。
      var scope = card;
      for (var level = 0; level < 4 && scope; level++) {
        scope = scope.parentElement;
        if (!scope) break;

        var cardCount = 1;
        try { cardCount = scope.querySelectorAll('#topicMainDiv[data]').length; } catch (e2) {}
        if (cardCount > 1) break; // 共用容器：不许在这里读标志

        var found = readFlag(scope);
        if (found !== null) return found;
      }
      return null;
    },


    /**
     * 讨论任务点的稳定去重键。
     *
     * 旧实现用 `url.slice(-70)`：两个讨论任务的地址若只有前段不同、后 70 字符相同，
     * 就会算出同一个键 —— 第二个任务被 `_isDiscussionDone` 判成"24 小时内已处理"而
     * **永久跳过**。多讨论任务点场景下这是实打实的漏做。
     * 改为优先取真正唯一的 mtopicid，取不到再退回整条 URL 的哈希。
     */
    _discussionKeyOf: function (url) {
      var raw = String(url || '');
      if (!raw) return '';
      var m = raw.match(/[?&](?:mtopicid|mtopicId|topicid|topicId|topic_id|id)=([^&#]+)/i);
      if (m && m[1]) return 'topic:' + decodeURIComponent(m[1]).slice(0, 48);

      var hash = 5381;
      for (var i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
      return 'url:' + hash.toString(36);
    },


    _collectDiscussionTargets: function () {
      var self = this;
      var targets = [];
      var docs = this._studyDocs();
      for (var d = 0; d < docs.length; d++) {
        this._walkDocs(docs[d], function (doc) {
          var cards = [];
          try {
            cards = Array.from(doc.querySelectorAll('#topicMainDiv[data], [data*="groupweb.chaoxing.com/course/topic"]'));
          } catch (e1) { return; }

          // 该文档里一共有几张卡片：只有 1 张时才允许退回"文档级标志"
          // （此时两者等价），多张时宁可按"未完成"处理也不要漏做
          var sameDoc = cards.filter(function (node) {
            return /groupweb\.chaoxing\.com\/course\/topic/i.test(String(node.getAttribute('data') || ''));
          }).length;

          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var url = String(card.getAttribute('data') || '');
            if (!/groupweb\.chaoxing\.com\/course\/topic/i.test(url)) continue;

            // 同文档里的 #isFinished 是服务端给出的"本任务点是否已完成"。
            // ⚠️ 必须**按卡片范围**查找，不能无脑 doc.getElementById ——
            // 多张卡片落在一个文档里时会共用同一个标志，导致批量漏做或反复重开。
            var scoped = self._scopedDiscussionFinishedFlag(card);
            var finished;
            if (scoped !== null) {
              finished = scoped;
            } else if (sameDoc <= 1) {
              // 只有一张卡片：文档级查找与卡片级等价，保留旧行为（最保守）
              var fin = null;
              try { fin = doc.getElementById('isFinished'); } catch (eF) {}
              finished = !!fin && /true/i.test(String(fin.value || ''));
            } else {
              // 多张卡片又找不到各自标志：按"未完成"处理。
              // 重复发评论由 _isDiscussionDone（24 小时）与提交前的二次确认兜住，
              // 而漏做是完全静默的 —— 两者相权取其轻。
              finished = false;
            }

            targets.push({
              url: url,
              title: String(textOf(card) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
              key: self._discussionKeyOf(url),
              finished: finished
            });
          }
        });
      }
      return targets;
    },


    // 卡片还没渲染时的退路：找讨论模块 iframe（module=insertbbs），它带着 mid / jobid / 标题
    _findDiscussionModuleFrames: function () {
      var self = this;
      var out = [];
      var docs = this._studyDocs();
      for (var d = 0; d < docs.length; d++) {
        this._walkDocs(docs[d], function (doc) {
          var frames = [];
          try { frames = Array.from(doc.querySelectorAll('iframe[module]')); } catch (e1) { return; }
          for (var i = 0; i < frames.length; i++) {
            var module = String(frames[i].getAttribute('module') || '');
            if (!/insertbbs|bbs|discuss/i.test(module)) continue;
            out.push({
              frame: frames[i],
              data: self._safeJsonParse(String(frames[i].getAttribute('data') || ''), null) || {}
            });
          }
        });
      }
      return out;
    },


    _currentStudyParams: function () {
      var raw = '';
      try {
        var frame = this._getMainFrame();
        raw = String((frame && frame.src) || '') + ' ' + String(location.href || '');
      } catch (e0) { raw = String(location.href || ''); }
      var pick = function (name) {
        var m = raw.match(new RegExp('[?&]' + name + '=([^&]+)', 'i'));
        return m ? decodeURIComponent(m[1]) : '';
      };
      return {
        courseid: pick('courseid') || pick('courseId'),
        clazzid: pick('clazzid') || pick('clazzId'),
        knowledgeid: pick('knowledgeid') || pick('chapterId'),
        utenc: pick('utenc')
      };
    },


    // 从讨论模块 iframe → 内嵌 #frame_content → 取回页面 HTML → 解析出讨论区地址
    _resolveDiscussionUrlFromModule: async function (mod) {
      if (!mod || !mod.frame) return '';
      var chapterSrc = '';
      var doc = this._safeDocOf(mod.frame);
      if (doc) {
        try {
          var fc = doc.getElementById('frame_content') ||
            doc.querySelector('iframe[src*="bbscircle"], iframe[src*="/chapter"]');
          if (fc) chapterSrc = String(fc.getAttribute('src') || '');
        } catch (e0) {}
      }
      if (!chapterSrc) {
        var data = mod.data || {};
        var mid = data.mid || '';
        if (mid) {
          var p = this._currentStudyParams();
          chapterSrc = '/mooc-ans/bbscircle/chapter?mtopicid=' + encodeURIComponent(mid) +
            '&jobid=' + encodeURIComponent(data.jobid || data._jobid || '') +
            '&isPortal=false&knowledgeid=' + encodeURIComponent(p.knowledgeid) +
            '&ut=s&clazzId=' + encodeURIComponent(p.clazzid) +
            '&utenc=' + encodeURIComponent(p.utenc) +
            '&courseid=' + encodeURIComponent(p.courseid) + '&isJob=true';
        }
      }
      if (!chapterSrc) return '';
      var abs = chapterSrc;
      try { abs = new URL(chapterSrc, location.href).href; } catch (e1) {}
      try {
        // ⚠️ 同样必须可超时：本函数在 _runTick 的讨论任务点链路上（`await _tryDiscussionTask()`），
        //    服务端不回数据时 await 会永久挂起。外层的 try/catch **拦不住挂起** —— 只有超时能。
        var resp = await this._withTimeout(fetch(abs, { credentials: 'include' }), 15000);
        if (!resp) return '';
        var html = await this._withTimeout(resp.text(), 15000);
        if (typeof html !== 'string') return '';
        var m = html.match(/id=["']topicMainDiv["'][^>]*\bdata=["']([^"']+)["']/i) ||
          html.match(/\bdata=["'](https?:\/\/groupweb\.chaoxing\.com\/course\/topic[^"']+)["']/i);
        if (m) return String(m[1]).replace(/&amp;/g, '&');
      } catch (e2) {}
      return '';
    },


    _findDiscussionTask: async function () {
      // 1) 最可靠：页面里已有话题卡片，直接拿到讨论区地址
      var targets = [];
      try { targets = this._collectDiscussionTargets(); } catch (e0) { targets = []; }
      if (targets.length) {
        // ⚠️ 除了服务端的 finished 标志，还必须排除**我们本地已经发过**的。
        // 否则"服务端还没刷新成已完成"的那个会被一直选中，而调用方一看
        // `_isDiscussionDone` 就直接 return false —— **同一页上的第二个讨论永远轮不到**。
        var self1 = this;
        var pending = targets.filter(function (t) {
          return !t.finished && !self1._isDiscussionDone(t.key);
        });
        if (!pending.length) return null; // 本节讨论任务点已完成（服务端已记录回复）
        var t0 = pending[0];
        return { key: t0.key, name: t0.title || '讨论', url: t0.url, el: null, href: t0.url };
      }

      // 2) 卡片还没渲染（懒加载）：从讨论模块 iframe 解析
      var modules = [];
      try { modules = this._findDiscussionModuleFrames(); } catch (e1) { modules = []; }
      for (var i = 0; i < modules.length; i++) {
        var url = await this._resolveDiscussionUrlFromModule(modules[i]);
        if (!url) continue;
        // 同样必须用稳定键：多讨论任务点下 url.slice(-70) 会碰撞，导致漏做
        var moduleKey = this._discussionKeyOf(url);
        // ⚠️ 必须跳过"已经发过"的那个。原先这里是无条件 `return`：
        // 第一个讨论做完之后，本函数每次都返回同一个，而调用方
        // `if (this._isDiscussionDone(task.key)) return false;` 于是直接放弃 ——
        // **同一页挂两个讨论时，第二个永远没机会**（2026-10-17 现场）。
        if (this._isDiscussionDone(moduleKey)) continue;
        return {
          key: moduleKey,
          name: String((modules[i].data && modules[i].data.title) || '讨论').slice(0, 60),
          url: url, el: null, href: url
        };
      }
      // 让模块 iframe 进入视口，促使懒加载下一次渲染出卡片（10 秒内不重复滚动）
      if (modules.length) {
        if (Date.now() - (this._discussionScrollAt || 0) > 10000) {
          this._discussionScrollAt = Date.now();
          try { modules[0].frame.scrollIntoView({ block: 'center' }); } catch (e2) {}
        }
        return null;
      }

      // 3) 兜底：老办法（页面有"讨论/话题"字样的可点击入口）
      // 同样要能把同一页的**多个**讨论都过一遍：按名称逐个试，跳过已发过的。
      var names = [];
      try {
        var attachments = this._getChaoxingAttachments() || [];
        for (var k = 0; k < attachments.length; k++) {
          if (!this._isDiscussionAttachment(attachments[k])) continue;
          var nm = this._discussionNameOf(attachments[k]);
          if (nm && names.indexOf(nm) === -1) names.push(nm);
        }
      } catch (e3) {}
      if (!names.length) names.push('');
      for (var n = 0; n < names.length; n++) {
        var entry = this._findDiscussionEntry(names[n]);
        if (!entry) continue;
        // 兜底路径没有讨论区地址，只能用"名称 + 链接"拼键；
        // 链接部分同样走哈希，避免 slice 截断造成的碰撞
        var fallbackKey = String(names[n] || entry.text || '讨论').slice(0, 40) + '|' + this._discussionKeyOf(entry.href || '');
        if (this._isDiscussionDone(fallbackKey)) continue;
        return {
          key: fallbackKey,
          name: names[n] || entry.text || '讨论',
          url: '', el: entry.node, href: entry.href
        };
      }
      return null;
    },


    // 刷课页侧：发现讨论任务点就打开讨论页
    _tryDiscussionTask: async function () {
      if (this.configs.enableDiscussion === false) return false;
      // 首次调用时挂上"讨论页回首掏"的监听（跨域，只能靠 postMessage）
      this._bindDiscussionOutcome();
      if (this._discussionBusy) return true;
      if (this._discussionWindow && !this._discussionWindow.closed) return true;
      if (Date.now() - (this._discussionOpenedAt || 0) < 15000) return false;
      // 全文档扫描开销大，最多 3 秒一次（tick 每 250ms 一轮）
      if (Date.now() - (this._discussionScanAt || 0) < 3000) return false;
      this._discussionScanAt = Date.now();

      var task = null;
      try { task = await this._findDiscussionTask(); } catch (e0) { task = null; }
      if (!task) return false;
      if (this._isDiscussionDone(task.key)) return false;

      this._discussionBusy = true;
      try {
        // 记录返回地址：讨论页发完评论后靠它回到刷课页（当前标签页打开时尤其必要）
        try { localStorage.setItem('omitone_return_url', String(location.href || '')); } catch (e1) {}
        // 先标记再打开：即使后面刷新/超时，也不会重复打开同一个讨论页
        this._markDiscussionDone(task.key);
        // 记下"当前在打开哪一个"：讨论页发不出去时会 postMessage 让本页撤回标记
        this._discussionLastOpenedKey = String(task.key || '');
        // 同源时还能顺手存一份（跨域时这个 localStorage 是另一份，仅作兜底）
        try { localStorage.setItem('omitone_discussion_key', String(task.key || '')); } catch (eKey) {}
        this._discussionOpenedAt = Date.now();

        var navigated = false;
        var href = String(task.url || task.href || '');
        if (href && href !== '#' && !/^javascript:/i.test(href)) {
          var absolute = href;
          try { absolute = new URL(href, location.href).href; } catch (e2) {}
          var opened = null;
          try { opened = window.open(absolute, '_blank'); } catch (e3) { opened = null; }
          if (opened) {
            this._discussionWindow = opened;
            navigated = true;
            emitRuntimeLog('info', 'discussion task opened in new tab', {
              name: String(task.name).slice(0, 40),
              url: String(absolute).slice(0, 120)
            });
          } else {
            // 弹窗被拦截：改成当前标签页打开，发完评论会自动返回
            emitRuntimeLog('info', 'discussion popup blocked, open in current tab', { name: String(task.name).slice(0, 40) });
            location.href = absolute;
            navigated = true;
          }
        } else if (task.el && typeof task.el.click === 'function') {
          emitRuntimeLog('info', 'discussion task entry clicked', { name: String(task.name).slice(0, 40) });
          task.el.click();
          navigated = true;
        }

        // ⚠️ 一个入口都没能打开时必须撤回"已完成"标记。
        // _markDiscussionDone 是**先于**打开动作写的（为了防止重复打开），
        // 但如果根本没有可用的入口，这条记录就把该任务点在 24 小时内静默跳过了 ——
        // 用户只会看到"这个讨论任务点没做"，而日志里什么异常都没有。
        if (!navigated) {
          this._unmarkDiscussionDone(task.key);
          this._discussionOpenedAt = 0;
          emitRuntimeLog('warn', 'discussion task has no usable entry, retry later', {
            name: String(task.name).slice(0, 40),
            hint: '未找到可点击入口或讨论区地址，已撤回完成标记，稍后会再试'
          });
          return false;
        }

        await sleep(1500);
        return true;
      } finally {
        this._discussionBusy = false;
      }
    },


    // 刷课页侧：讨论页处理期间暂停推进（避免跳到下一节），关闭或超时后恢复
    _handleDiscussionWait: function () {
      var win = this._discussionWindow;
      if (!win) return false;
      var closed = true;
      try { closed = !!win.closed; } catch (e0) { closed = true; }

      if (closed) {
        this._discussionWindow = null;
        this._discussionOpenedAt = 0;
        emitRuntimeLog('info', 'discussion finished, resuming study', {});
        this._refreshChapterAfterDiscussion();
        return true;
      }

      var waited = Date.now() - (this._discussionOpenedAt || 0);
      if (waited > (Number(this.configs.discussionTimeoutMs) || 90000)) {
        emitRuntimeLog('warn', 'discussion timeout, continue without waiting', { waitedSec: Math.round(waited / 1000) });
        try { win.close(); } catch (e1) {}
        this._discussionWindow = null;
        this._discussionOpenedAt = 0;
        return false;
      }
      return true; // 等待中：本轮不再做其它事
    },


    _refreshChapterAfterDiscussion: function () {
      var self = this;
      setTimeout(function () {
        try {
          var frame = self._getMainFrame();
          if (frame && frame.contentWindow) {
            frame.contentWindow.location.reload();
            return;
          }
        } catch (e0) {}
        try { location.reload(); } catch (e1) {}
      }, 2000);
    },


    // ---- 讨论页侧 ----

    _findDiscussionEditor: function () {
      // 精确优先：学习通讨论区（groupweb）的回复框
      try {
        var exact = document.querySelector(
          '.replyEdit textarea, textarea[placeholder*="回复"], .edit_main textarea, #subPageMain textarea'
        );
        if (exact && visible(exact) && (exact.clientHeight || 0) >= 20) return exact;
      } catch (eExact) {}

      var nodes = [];
      try { nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], iframe')); } catch (e0) { return null; }
      var best = null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.tagName === 'IFRAME') continue;
        if (!visible(el)) continue;
        var area = (el.clientWidth || 0) * (el.clientHeight || 0);
        if ((el.clientWidth || 0) < 80 || (el.clientHeight || 0) < 20) continue; // 太小的多为验证码/搜索框
        if (!best || area > best.area) best = { el: el, area: area };
      }
      if (best) return best.el;

      // 富文本编辑器（wangEditor 等）的真实输入区常藏在同源 iframe 里
      for (var k = 0; k < nodes.length; k++) {
        var frame = nodes[k];
        if (frame.tagName !== 'IFRAME') continue;
        var doc = this._safeDocOf(frame);
        if (!doc || !doc.body) continue;
        try {
          var editable = doc.body.getAttribute('contenteditable') === 'true'
            ? doc.body
            : doc.querySelector('[contenteditable="true"]');
          if (editable) return editable;
        } catch (e1) {}
      }
      return null;
    },


    // 回复框可能默认折叠，点"回复"把它展开（只点一次，避免反复触发）
    _expandDiscussionEditor: async function () {
      if (this._discussionExpanded) return;
      this._discussionExpanded = true;
      var opened = false;
      var sels = ['.replyBtn', '.topicDetail_title_right', '.edit_headTitle'];
      for (var i = 0; i < sels.length && !opened; i++) {
        var el = null;
        try { el = document.querySelector(sels[i]); } catch (e0) { continue; }
        if (!el || !visible(el)) continue;
        try { el.click(); opened = true; } catch (e1) {}
      }
      if (opened) {
        emitRuntimeLog('info', 'discussion editor collapsed, expanded it', {});
        await sleep(700);
      }
    },


    _findDiscussionSubmitButton: function () {
      // 精确优先：学习通讨论区的提交按钮（页面上还有别的"回复"，点错就发不出去）
      try {
        var exact = document.querySelector('.addReply, [class*="addReply"], .replyEditBtnGroup .jb_btn');
        if (exact && visible(exact)) return exact;
      } catch (eExact) {}

      var nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"], div[role="button"], span[role="button"]'
        ));
      } catch (e0) { return null; }
      var KEY = /发布|发表|提交|回复|发送|回帖/;
      var NEG = /取消|清空|重置|预览|表情|图片|附件|上传|草稿|保存/;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!visible(node)) continue;
        var text = String(textOf(node) || '').trim();
        if (!text || text.length > 12) continue;
        if (NEG.test(text)) continue;
        if (!KEY.test(text) && !KEY.test(String(node.getAttribute('value') || ''))) continue;
        return node;
      }
      return null;
    },


    _fillDiscussionEditor: function (editor, text) {
      var tag = String(editor.tagName || '').toLowerCase();
      // ⚠️ 必须**回读确认**：受控组件（React/Vue）可能把值吞回去，
      // 只写不查等于没写。而"编辑区为空"又会被 `_discussionSuccessHint`
      // 当成"提交后被清空"= 成功 —— 于是这条讨论被标成已做，却一条都没发出去
      //（2026-10-17 现场：三个讨论里第一个就是这么丢的）。
      var probe = String(text || '').slice(0, 20);
      if (tag === 'textarea' || tag === 'input') {
        var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(editor, text);
        else editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return String(editor.value || '').indexOf(probe) !== -1;
      }
      try { editor.focus(); } catch (e0) {}
      editor.textContent = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return String(editor.textContent || '').indexOf(probe) !== -1;
    },


    // 记录提交前的回复状态，用于判断本次是否真的发出去了
    _discussionBaseline: function () {
      var info = { count: 0, text: '' };
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          info.count = list.querySelectorAll('.topicDetail_replyItem').length;
          info.text = String(list.innerText || '');
        }
      } catch (e0) {}
      return info;
    },


    _discussionSuccessHint: function () {
      var content = String(this.configs.discussionReply || '1').trim();
      var before = this._discussionBefore || { count: 0, text: '' };
      // 1) 回复列表里出现了新内容 / 新增了条目
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          var now = String(list.innerText || '');
          if (content && now.indexOf(content) >= 0 && String(before.text || '').indexOf(content) < 0) return true;
          if (list.querySelectorAll('.topicDetail_replyItem').length > Number(before.count || 0)) return true;
        }
      } catch (e1) {}
      // 2) 页面出现成功提示
      try {
        if (/发布成功|发表成功|提交成功|回复成功|评论成功|操作成功/.test(String(document.body.innerText || ''))) return true;
      } catch (e2) {}
      // 3) 编辑区被清空 —— **只有"确认填进去过"才算数**。
      // ⚠️ 否则会误报：内容压根没填进去时编辑区本来就是空的，一点提交就"确认成功"，
      // 任务点被标成已做却从没发出（2026-10-17 现场：三个讨论里第一个丢了）。
      if (!this._discussionFilledOk) return false;
      var editor = this._findDiscussionEditor();
      if (editor) {
        var value = String(editor.value !== undefined ? editor.value : editor.textContent || '').trim();
        if (value === '') return true;
      }
      return false;
    },


    _computeDiscussionPage: function () {
      var href = String(location.href || '').toLowerCase();
      var title = '';
      try { title = String(document.title || ''); } catch (e0) {}
      var urlHit = /discuss|discus|bbs|topic|thread|forum|reply|comment|talk|group/.test(href);
      var titleHit = /讨论|话题|回帖|发帖/.test(title);
      var bodyHit = false;
      try {
        bodyHit = /讨论|话题|回帖|发帖|发表回复|我的回复|发布话题/.test(String(document.body.innerText || '').slice(0, 3000));
      } catch (e1) {}
      // 从刷课页跳转过来的（留有返回地址）时放宽：页面文案命中即可，避免陌生网址结构认不出来
      var fromStudy = false;
      try { fromStudy = !!localStorage.getItem('omitone_return_url'); } catch (e2) {}
      if (!urlHit && !titleHit && !(fromStudy && bodyHit)) return false;
      // 必须是"有输入框 + 有发布按钮"的界面，避免在纯浏览的帖子列表页乱填
      return !!this._findDiscussionEditor() && !!this._findDiscussionSubmitButton();
    },


    _isDiscussionPage: function () {
      if (this.configs.enableDiscussion === false) return false;
      var now = Date.now();
      var href = String(location.href || '');
      if (this._discussionPageUrl !== href) {
        this._discussionPageUrl = href;
        this._discussionPageAt = 0;
        this._discussionPageResult = false;
      }
      if (now - (this._discussionPageAt || 0) < 2000) return this._discussionPageResult;
      this._discussionPageAt = now;
      this._discussionPageResult = !!this._computeDiscussionPage();
      return this._discussionPageResult;
    },


    _runDiscussionMode: async function () {
      if (this._discussionBusy) return;
      if (this._discussionPosted) return; // 每个页面只发一次，避免重复评论
      this._discussionBusy = true;
      emitRuntimeLog('info', 'discussion page detected, posting reply', { url: String(location.href || '').slice(0, 120) });
      try {
        var editor = this._findDiscussionEditor();
        if (!editor) {
          await this._expandDiscussionEditor();
          editor = this._findDiscussionEditor();
        }
        var button = this._findDiscussionSubmitButton();
        if (!editor || !button) {
          // 退路：本页只是"话题卡片"（需点卡片才进讨论区）→ 点开它
          if (!this._discussionCardOpened) {
            var card = null;
            try { card = document.querySelector('#topicMainDiv[data]'); } catch (eCard) {}
            if (card) {
              this._discussionCardOpened = true;
              emitRuntimeLog('info', 'discussion card found, opening topic page', {});
              try { card.click(); } catch (eCard2) {}
              await sleep(1500);
              return;
            }
          }
          emitRuntimeLog('warn', 'discussion editor or submit button missing', {
            hasEditor: !!editor, hasButton: !!button, url: String(location.href || '').slice(0, 110)
          });
          return; // 不锁定 _discussionPosted：下一轮再试，避免一次没找到就永久放弃
        }
        this._discussionPosted = true; // 找到控件后才锁定，确保每页只发一次
        this._discussionBefore = this._discussionBaseline();
        var content = String(this.configs.discussionReply || '1');
        var filledOk = this._fillDiscussionEditor(editor, content) === true;
        if (!filledOk) {
          // 页面可能还没就绪（脚本刚注入），等一拍再试一次
          await sleep(1200);
          filledOk = this._fillDiscussionEditor(editor, content) === true;
        }
        this._discussionFilledOk = filledOk;
        await sleep(500);
        if (!filledOk) {
          // 填不进去：照样点一下（空提交无害，不点页面可能一直停在"未提交"），
          // 但要把"已做"标记撤掉 —— 否则这个讨论会静默跳过 24 小时，
          // 用户只看到"没做"，日志里也看不出所以然。
          emitRuntimeLog('warn', 'discussion editor did not take the text, will retry', {
            content: content.slice(0, 40),
            editor: String(editor.tagName || '') + (editor.id ? '#' + editor.id : '')
          });
          this._unmarkDiscussionDone(this._discussionPendingKey());
        }
        button.click();
        emitRuntimeLog('info', 'discussion reply submitted', {
          content: content.slice(0, 40),
          editor: String(editor.tagName || '') + (editor.id ? '#' + editor.id : ''),
          button: String(button.className || '').slice(0, 60),
          url: String(location.href || '').slice(0, 100)
        });

        // 等待提交结果（最多 10 秒）；未确认也继续返回——宁可少发一次，也不能卡住刷课
        var confirmed = false;
        for (var i = 0; i < 10; i++) {
          await sleep(1000);
          if (this._discussionSuccessHint()) {
            confirmed = true;
            emitRuntimeLog('info', 'discussion reply confirmed', {});
            break;
          }
        }
        if (!confirmed) {
          // 没看到成功提示有两种情况：
          //   ① 内容压根没填进去（fill 已报过 warn 并撤了标记）→ 会重试
          //   ② 填进去了但页面没给提示 → 大概率已经发出去，**不再重发**（避免两条一样的回复）
          //
          // ⚠️ 把三条判据各自的实况一起记下来 —— 只说"未确认"的话，
          // 下次还是得靠猜（这一轮就因为看不到细节多绕了一趟）。
          var diagHint = { filled: this._discussionFilledOk === true, content: String(content || '').slice(0, 20) };
          try {
            var hitList = document.querySelector('.topicDetail_replyList');
            diagHint.hasList = !!hitList;
            diagHint.listItems = hitList ? hitList.querySelectorAll('.topicDetail_replyItem').length : -1;
            diagHint.beforeItems = Number((this._discussionBefore || {}).count || 0);
            diagHint.listHasContent = hitList ? String(hitList.innerText || '').indexOf(String(content || '')) !== -1 : false;
            diagHint.successText = /发布成功|发表成功|提交成功|回复成功|评论成功|操作成功/.test(String(document.body.innerText || ''));
            var edAfter = this._findDiscussionEditor();
            diagHint.editorEmpty = edAfter
              ? String(edAfter.value !== undefined ? edAfter.value : edAfter.textContent || '').trim() === ''
              : null;
          } catch (eDiag) {}
          emitRuntimeLog('warn', 'discussion reply not confirmed, resume anyway', diagHint);

          // ⚠️ 必须告诉刷课页"这次没成"，让它撤掉"已做"标记并重试。
          // **只能走 postMessage**：讨论页在 groupweb.chaoxing.com、刷课页在
          // mooc1.chaoxing.com，两边的 localStorage 根本不是同一份 ——
          // 在这里调 `_unmarkDiscussionDone` 撤的是本地空存储，等于没撤
          //（2026-10-17 实测踩到，所以上一版"失败可重试"完全没生效）。
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ omitoneDiscussion: 'failed' }, '*');
            }
          } catch (eNotify) {}
        }

        await sleep(600);
        var returnUrl = '';
        try { returnUrl = localStorage.getItem('omitone_return_url') || ''; } catch (e0) {}

        try {
          if (window.opener && !window.opener.closed) {
            emitRuntimeLog('info', 'discussion done, closing this tab', {});
            window.close();
            return;
          }
        } catch (e1) {}

        if (history.length > 1) {
          emitRuntimeLog('info', 'discussion done, going back to study page', {});
          history.back();
          return;
        }
        if (returnUrl) {
          location.href = returnUrl;
          return;
        }
        emitRuntimeLog('info', 'discussion done, waiting for redirect', {});
      } catch (err) {
        emitRuntimeLog('error', 'discussion handling error', { message: String((err && err.message) || err).slice(0, 160) });
      } finally {
        this._discussionBusy = false;
      }
    },
