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
 * 本段的方法（49 个）：
 *   _discussionDoneMap、_markDiscussionDone、_isDiscussionDone、
 *   _unmarkDiscussionDone、_discussionPendingKey、_getDiscussionTries、
 *   _bumpDiscussionTry、_migrateDiscussionDoneOnce、_bindDiscussionOutcome、
 *   _discussionNameOf、_isDiscussionAttachment、_logDiscussionHandoffOnce、
 *   _findDiscussionEntry、_isDiscussionContext、_discussionFinishedFlagOf、
 *   _scopedDiscussionFinishedFlag、_discussionBoxFinishedFlag、
 *   _discussionKeyOf、_collectDiscussionTargets、_findDiscussionModuleFrames、
 *   _currentStudyParams、_resolveDiscussionUrlFromModule、_discussionHealEligible、_findDiscussionTask、
 *   _logDiscussionAllSettled、
 *   _discussionPendingInfo、_shouldHoldDiscussionBeforeFinish、
 *   _tryDiscussionTask、_handleDiscussionWait、_refreshChapterAfterDiscussion、
 *   _findDiscussionEditor、_expandDiscussionEditor、_findDiscussionSubmitButton、
 *   _fillDiscussionEditor、_discussionBaseline、_discussionEvidence、_discussionSuccessHint、
 *   _computeDiscussionPage、_isStudyCourseHref、_discussionReturnFresh、
 *   _declineDiscussionPage、_quizInFlightForDiscussion、_isDiscussionPage、
 *   _waitDiscussionReady、_discussionStudyKeyOfName、_handleDiscussionFailure、
 *   _consumeDiscussionWindowName、_announceDiscussionOutcome、_runDiscussionMode
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
     * 一次性作废旧版本留下的"已发过"记录（schema 迁移）。
     *
     * 为什么需要：在 ⑯/⑲ 修好之前，**发失败也会被记成"已发"**，而标记 24 小时才过期 ——
     * 用户那边已经有一批页面被误标成已做，靠"等 24 小时"或"让用户手敲命令"都不合适。
     * 所以升到 schema 2 时**清空一次**，让这些页面重新扫一遍；
     * 之后写标记的都是新逻辑（失败会撤），不再需要这种清理。
     */
    _migrateDiscussionDoneOnce: function () {
      var SCHEMA = '2';
      try {
        if (String(localStorage.getItem(this._discussionStoreKey + '_schema') || '') === SCHEMA) return;
        var dropped = Object.keys(this._discussionDoneMap()).length;
        localStorage.removeItem(this._discussionStoreKey);
        localStorage.setItem(this._discussionStoreKey + '_schema', SCHEMA);
        if (dropped) {
          emitRuntimeLog('warn', 'discussion done list reset after upgrade', {
            dropped: dropped,
            hint: '旧版本会把"发失败"也记成已发，升级后统一作废一次，让这些页面重新扫'
          });
        }
      } catch (e) {}
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
          // 键优先取讨论页递回来的那一份；本内存里的 `_discussionLastOpenedKey`
          // 只是"同一个文档里重开"才有效，跳回来时它是空的
          self._handleDiscussionFailure(String(data.key || ''), 'postmessage');
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


    /**
     * 「这份附件是讨论任务点，但它不归建 job 那条链」的去重日志（批次 29）。
     *
     * 为什么单独写一条：`insertbbs` 在 `_kindFromAttachment` 里说不出类型（设计如此 ——
     * 讨论既不是视频也不是阅读/测验），于是 `_buildAttachmentOnlyJob` 落到
     * 「unsupported task point type, skipped」那句话上。可讨论**本来就归本域那条
     * 独立 tick 链管**，把"换了人做"报成"没人做"，排查时会顺着这条根本不存在的路找。
     * 判据只看附件自己说的 module/type（任务盒名字里有没有「讨论」二字都算），
     * 与 `_isDiscussionAttachment` 同一份，不再开第二处判据。
     *
     * ⚠️ 开关关掉时是**另一回事**：那时这条链整个不进，这一族才是真的没人做，
     * 必须用 warn 说明是开关挡的，否则用户只看到"讨论没做、日志说 skipped"。
     */
    _logDiscussionHandoffOnce: function (attachment) {
      var off = !!(this.configs && this.configs.enableDiscussion === false);
      var key = off ? 'off' : 'on';
      if (this._discussionHandoffLogged === key) return;
      this._discussionHandoffLogged = key;
      var property = (attachment && attachment.property) || {};
      emitRuntimeLog(off ? 'warn' : 'info', off
        ? 'discussion task point skipped by switch'
        : 'discussion task point handed to discussion link', {
        name: this._discussionNameOf(attachment).slice(0, 40),
        module: String(property.module || (attachment && attachment.module) || '(空)'),
        hint: off
          ? '「任务点类型」里讨论开关是关的 —— 这一类任务点既不发帖也不会记成做完，平台那边会一直挂着未完成'
          : '讨论任务点不走附件建 job 那条链，由讨论链路自己进话题页发一条'
      });
    },


    // 在课程页/同源 iframe 中找讨论任务点的可点击入口（优先带真实链接的 <a>）
    /**
     * ⚠️ 这条兜底路径**只会点它返回的那个节点**，所以它必须能拒绝"不像入口的东西"。
     * 实测翻车（批次 20-C）：日志留下 `discussion task entry clicked {name:"目录 讨论 笔记 标注"}`，
     * 那是课程页顶部那条**导航标签带** —— 它的文字里含「讨论」二字、且长度没超 40，
     * 于是被当成讨论入口点了，顺带把 `目录 讨论 笔记 标注|` 这个假键记成"24 小时内已发过"。
     * 现在要求：文字得**像单独一个入口**（不是几块导航拼在一起），
     * 且要么网址本身长成讨论区（topic / bbscircle / groupweb / discuss），
     * 要么正好命中 attachments 里那个讨论任务点的真名。宁缺毋滥 ——
     * 返回 null 时调用方只是"这一轮没打开"，点错导航却会把任务点记成做过。
     */
    _findDiscussionEntry: function (preferredName) {
      var KEY = /讨论|话题|回帖|发帖|参与讨论/;
      var NAV = /目录|笔记|标注|章节|任务点|排行|公告|作业|考试/;
      var NAV_ALL = new RegExp(NAV.source, 'g');
      var TOPIC_HREF = /topic|bbscircle|groupweb|discuss/i;
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
          // 一条文字里同时出现两块导航词（「目录 … 笔记 标注」）= 那不是入口，是标签带
          var navHits = (text.match(NAV_ALL) || []).length;
          if (navHits >= 2) continue;
          var link = node.tagName === 'A' ? node : node.querySelector('a[href]');
          var href = link ? String(link.getAttribute('href') || '') : String(node.getAttribute('href') || '');
          var nameHit = !!(preferredName && text.indexOf(preferredName) >= 0);
          var hrefHit = !!href && href !== '#' && !/^javascript:/i.test(href) && TOPIC_HREF.test(href);
          // 讨论区网址没有、真名也没对上 → 只剩"页面上随便一个写着讨论的节点"，拒绝
          if (!nameHit && !hrefHit) continue;
          var score = 0;
          if (nameHit) score += 2;
          if (hrefHit) score += 1;
          if (navHits === 0) score += 1;
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
     * 读一个 `#isFinished` 节点，返回**三态**：`true` 已完成 / `false` 未完成 / `null` 读不出结论。
     *
     * ⚠️ 为什么必须把"未完成"和"读不出"分开（批次 20-A，实测驱动）：
     * 现场那一节的三张讨论卡片里，`#isFinished` **存在但 value 是空串** —— 平台在
     * "这个任务点没有服务端完成标志"时就是这么渲染的。旧实现把空串当成 `false`（未完成），
     * 于是**已经发过回帖**的卡片会被自愈逻辑读成"本地说发过了、平台却说没做完，八成是发失败"，
     * 反复重开重发，直到 3 次重试预算烧光 —— 烧光后这一节既不再发也不推进，
     * 就是用户那句「又卡住了」。空串不代表"没做完"，它代表"平台没话说"，
     * 这时候**只有我们本地那份记录算数**。
     */
    _discussionFinishedFlagOf: function (node) {
      if (!node) return null;
      var raw = '';
      try { raw = String(node.value !== undefined && node.value !== null ? node.value : (node.getAttribute && node.getAttribute('value')) || ''); } catch (e0) { return null; }
      raw = raw.trim();
      if (/^true$/i.test(raw)) return true;
      if (/^false$/i.test(raw)) return false;
      return null;
    },


    /**
     * 某个讨论卡片自己的"已完成"标志。
     *
     * 学习通把 `#isFinished` 放在**每个讨论模块自己的页面**里，值来自服务端。
     * 旧实现直接用 `doc.getElementById('isFinished')` —— 一个章节里若有多个讨论任务点，
     * 它们可能落在同一个文档中，于是所有卡片共用同一个标志：
     * 第一个已完成，其余全被当作"已回复"而永久跳过；反之则会反复重开同一个。
     *
     * 返回 null 表示"读不出结论"（找不到节点，或节点值是空串），由调用方决定怎么兜底
     * （不要在这里返回 false —— 那会把"未知"当成"未完成"，见 `_discussionFinishedFlagOf`）。
     */
    _scopedDiscussionFinishedFlag: function (card) {
      if (!card) return null;
      var self = this;
      var readFlag = function (scope) {
        if (!scope || !scope.querySelector) return null;
        var flag = null;
        try {
          flag = scope.querySelector('#isFinished, input[name="isFinished"][value], input[name="isFinished"]');
        } catch (e) {}
        return self._discussionFinishedFlagOf(flag);
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
     * 平台自己怎么说**这一块讨论**做完没做完（批次 20-G）。
     *
     * 实测（2026-11-11 章节 9000049219，用户肉眼「只有一个没完成」逼出来的）：
     * 卡片里那个 `#isFinished` **值是空的**，三张讨论卡一张都读不出结论 ——
     * 于是「4 个任务盒里只有 1 个还没做完」这个平台明摆着的事实，
     * 被读成"三个都记过账 = 整节做完"，页面反复点「下一节」而平台不放行。
     *
     * 平台拦翻页用的就是这条判据（它自己的 `scroll2Job()` 源码）：
     * 任务盒 `.ans-attach-ct` 上没有 `ans-job-finished` = 未完成。
     * ⚠️ 别拿图标上的 `aria-label` 当回事：实测**连已完成的盒子也写着「任务点未完成」**，
     * 只有 class 才是真的。
     *
     * 卡片与盒子不同层，实测链路是三层：
     *   knowledge/cards 文档（4 个 `.ans-attach-ct`）
     *     └ iframe → ananas/modules/insertbbs 文档
     *          └ iframe → mooc-ans/bbscircle 文档（`#topicMainDiv[data]` 就在这里）
     * 所以从卡片出发，**沿 frame 链往上走**（最多 4 层），在哪一层碰到盒子就用哪一层。
     * 跨域时 `frameElement` 抛 SecurityError —— 接住返回 null，当"平台没说"。
     */
    _discussionBoxFinishedFlag: function (card) {
      var node = card;
      for (var hop = 0; hop < 4 && node; hop++) {
        var box = null;
        try { box = node.closest ? node.closest('.ans-attach-ct') : null; } catch (e0) { return null; }
        if (box) {
          if (String(box.className || '').indexOf('ans-job-finished') >= 0) return true;
          // 盒子里没有任务点图标 = 这一项压根不是任务点，别拿它当"未完成"
          var icon = null;
          try { icon = box.querySelector('.ans-job-icon'); } catch (e1) {}
          return icon ? false : null;
        }
        var win = null;
        try { win = node.ownerDocument ? node.ownerDocument.defaultView : null; } catch (e2) { return null; }
        if (!win) return null;
        try { node = win.frameElement || null; } catch (e3) { return null; }   // 跨域：读不到就当没说
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
      // 实测（2026-11-11 现场，章节 9000049219）同一批卡片**被收了两次**：
      // `_walkDocs` 有两条路径能走到同一份文档，于是三个讨论在 `targets` 里是六条，
      // 「这一节还剩几个讨论」的读数直接翻倍。行为上没出过事（只用第一条），
      // 但排查时它对不上肉眼可见的三张卡片，所以按稳定键去重。
      var seenKeys = {};
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
            var finishedKnown;
            if (scoped !== null) {
              finished = scoped;
              finishedKnown = true;
            } else {
              // 服务端标志读不出来时，改问平台自己的判据（批次 20-G）：
              // 这张卡所在的任务盒带不带 `ans-job-finished` —— 它就是「下一节」放不放行的那条。
              // 本课程实测 `#isFinished` 是**空值**，按标志读的两条路全部落空，于是
              // 「三张讨论卡里还有一张没做完」被读成了「这一节讨论都做完了」。
              // 按卡取盒（不是按文档取盒），多张卡挤在同一个文档里也不会串。
              var boxFlag = self._discussionBoxFinishedFlag(card);
              if (boxFlag !== null) {
                finished = boxFlag;
                finishedKnown = true;
              } else if (sameDoc <= 1) {
                // 只有一张卡片：文档级查找与卡片级等价，保留旧行为（最保守）
                var fin = null;
                try { fin = doc.getElementById('isFinished'); } catch (eF) {}
                var docFlag = self._discussionFinishedFlagOf(fin);
                finished = docFlag === true;
                finishedKnown = docFlag !== null;
              } else {
                // 多张卡片又找不到各自标志：按"未完成"处理。
                // 重复发评论由 _isDiscussionDone（24 小时）与提交前的二次确认兜住，
                // 而漏做是完全静默的 —— 两者相权取其轻。
                // ⚠️ finishedKnown 必须留 false：这是"我们没读到平台的说法"，不是"平台说没做完"，
                // 下游的自愈重试预算只许在前者成立时烧（批次 20-A）。
                finished = false;
                finishedKnown = false;
              }
            }

            var tKey = self._discussionKeyOf(url);
            if (seenKeys[tKey]) continue;
            seenKeys[tKey] = 1;

            targets.push({
              url: url,
              title: String(textOf(card) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
              key: tKey,
              finished: finished,
              finishedKnown: finishedKnown
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


    /**
     * 「这一节的讨论任务点都算处理完了」的**依据**（批次 20-D）。
     *
     * 为什么专门写一条：这个出口原本直接 `return null`，于是"三个话题真发过了"和
     * "三个话题全被重试预算挡在外面"（20-A 之前的实际现场）留下一模一样的空白 ——
     * 用户只看到讨论没做、日志里啥也没有。分类计数直接指出是哪一类。
     * 60 秒最多播一条：`_tryDiscussionTask` 每 3 秒就会走到这里一次。
     */
    _logDiscussionAllSettled: function (targets) {
      var self = this;
      var now = Date.now();
      if (now - (this._discussionSettledLogAt || 0) < 60000) return;
      this._discussionSettledLogAt = now;
      var out = { serverFinished: 0, believeLocal: 0, tryBudget: 0, unexplained: 0 };
      var list = targets || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.finished) out.serverFinished++;
        else if (!self._isDiscussionDone(t.key)) out.unexplained++;
        else if (t.finishedKnown === true) out.tryBudget++;
        else out.believeLocal++;
      }
      emitRuntimeLog('info', 'discussion nothing pending', {
        total: list.length,
        serverFinished: out.serverFinished,
        believeLocal: out.believeLocal,
        tryBudget: out.tryBudget,
        unexplained: out.unexplained,
        hint: out.tryBudget
          ? '有话题被重试预算挡住（平台确实说了"没完成"而我们连试 3 次）—— 需要人看一眼，或清掉本地 omitone_discussion_done'
          : 'believeLocal 指的是 #isFinished 读不出结论、只有我们本地记过"已发"，20-A 之后不再拿它当"未完成"重开'
      });
    },


    /**
     * 「本地记过已发、平台说没做完」这个话题**还能不能再试一次**（批次 20-G）。
     *
     * 抽出来是因为「要不要重开它」和「这一节能不能宣布做完」必须是同一个答案：
     * 前者在 `_findDiscussionTask` 里、后者在 `_discussionPendingInfo` 里，
     * 两处各写一遍迟早分叉 —— 分叉的表现就是"扩展一边说没任务、一边又去重开"，
     * 而平台在中间弹「还有任务点未完成」。（判据无副作用；烧额度由调用方 `_bumpDiscussionTry` 做。）
     */
    _discussionHealEligible: function (t) {
      if (!t || t.finishedKnown !== true) return false;      // 平台没表态：本地记录是唯一证据，不许重开
      if (!this._isDiscussionDone(t.key)) return false;      // 没记过账：它本来就是 pending
      var markedAt = Number(this._discussionDoneMap()[t.key] || 0);
      if (!markedAt || Date.now() - markedAt < 90000) return false;   // 刚发过，先给平台时间刷新
      return this._getDiscussionTries(t.key) < 3;                    // 最多三次，别把整节锁死
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
          if (t.finished) return false;
          if (!self1._isDiscussionDone(t.key)) return true;
          // ── 自愈：本地记过"已发"，但**平台说这个讨论还没完成** ──
          // 那多半是当时发失败了（跨域那会儿撤不掉标记，见 ⑲）。
          // 超过 90 秒平台仍是"未完成"，就允许重来一次（最多 3 次，靠 `try|` 计数兜底）。
          // ⚠️ 前提是平台**真的说了"还没完成"**（批次 20-A）：`#isFinished` 空串时
          // `finishedKnown` 不是 true，这条标志读不出结论 —— 此时本地那份记录是唯一证据，
          // 拿它去烧 3 次预算只会把这一节做成"既不再发帖、也永远不推进"（实测现场）。
          if (!self1._discussionHealEligible(t)) return false;
          self1._bumpDiscussionTry(t.key);
          return true;
        });
        if (!pending.length) {
          // 「本节讨论都做完了」这句话不能只写在返回里 —— 数不出为什么做完，
          // 下次出问题（比如 20-A 那种"标志读不出所以全被预算挡在外面"）和
          // "真的都发过了"在日志里长得一模一样。60 秒最多播一条。
          this._logDiscussionAllSettled(targets);
          return null; // 本节讨论任务点已完成（服务端已记录回复）
        }
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


    /**
     * 「这一页还有几个讨论任务点等着发帖」——给学习循环当"别说这一节做完了"的依据（批次 20-D）。
     *
     * 为什么学习循环需要这一句话：讨论任务点的模块是 `insertbbs`，
     * `_kindFromAttachment` 认不出它的类型（视频/阅读/测验/PPT/超链接/翻页文档都不是），
     * 于是 OCS 那条链把候选帧**全部拒掉**、`searchedCount` 读成 0，接着
     * `study finished on page` → `study next unit`，每二十秒翻一节而平台根本不认 ——
     * 因为讨论实际上归 `_tryDiscussionTask` 这条**独立的 tick 链**管，
     * 学习循环"我这边没活"推不出"这一节做完了"。
     *
     * 返回 `{pending, total, source, sig}`：
     *   source = 'cards' 卡片已渲染（最可靠，和 `_findDiscussionTask` 用的是同一批键）
     *   source = 'frame' 只有 `insertbbs` 模块、卡片还没渲染 —— 只该短暂按住
     *   source = 'none'  这一页压根没有讨论任务点（或用户关了讨论）
     * `sig` 是"待办那批话题的键"拼出来的签名，预算按它起算：做完一个、剩下一个时，
     * 剩下的那个应当重新享有一整个预算，而不是继承前一个已经烧掉的时间。
     * 全文档扫描不便宜，结果缓存 2 秒（tick 每 250 毫秒一轮）。
     */
    _discussionPendingInfo: function () {
      var self = this;
      var now = Date.now();
      if (this.configs.enableDiscussion === false) {
        return { pending: 0, total: 0, source: 'disabled', sig: '' };
      }
      var cache = this._discussionPendingCache;
      if (cache && now - Number(cache.at || 0) < 2000) return cache.value;

      var value = { pending: 0, total: 0, source: 'none', sig: '' };
      try {
        var targets = this._collectDiscussionTargets();
        if (targets.length) {
          value.total = targets.length;
          value.source = 'cards';
          var todo = targets.filter(function (t) {
            if (t.finished) return false;
            // 「本地已记过」= 已经发过（或已开过）这个讨论，成败由讨论页那边的回执决定，
            // 不该再让学习循环为它按住这一节 —— 否则发不出去的话题会把整节锁到永远。
            if (!self._isDiscussionDone(t.key)) return true;
            // 例外（批次 20-G）：本地记过账、但**平台仍说这个盒子没做完**，
            // 而且还在自愈额度内 —— 那就和 `_findDiscussionTask` 一样当作"没做完"，
            // 否则一边准备重开发帖、一边宣布整节完成去点「下一节」。
            return self._discussionHealEligible(t);
          });
          value.pending = todo.length;
          value.sig = todo.map(function (t) { return String(t.key || ''); }).join(',').slice(0, 200);
        }
      } catch (e0) {}
      if (value.source === 'none') {
        try {
          var frames = this._findDiscussionModuleFrames();
          if (frames.length) {
            value.total = frames.length;
            value.source = 'frame';
            // 本页从没开过讨论页时，给异步解析（模块 → 卡片）留一点时间；
            // 开过之后（`_discussionOpenedAt`）不再靠这个猜。
            value.pending = (this._discussionOpenedAt || 0) ? 0 : frames.length;
            value.sig = value.pending ? 'frame:' + frames.length : '';
          }
        } catch (e1) {}
      }
      this._discussionPendingCache = { at: now, value: value };
      return value;
    },


    /**
     * 学习循环在宣布"这一节做完了"之前该不该为讨论任务点按住（批次 20-D）。
     *
     * 预算分开是有意为之：卡片是真数出来的，给足 90 秒让 tick 链去开讨论页；
     * 只有 `insertbbs` 帧时"还有几个没做"是我们**猜**的，猜的东西最多按 20 秒。
     *
     * ⚠️ 超预算不等于"接着按下一轮"：`_discussionHoldSpent` 记的是**这一份文档里烧掉过
     * 几个预算**。最多两个，之后这一节照常用完就翻 —— 否则"标记写上又撤回"的抖动
     * 会让签名反复重置、整节课永远停在同一页（用户看到的还是卡住，只是换了个方向）。
     */
    _shouldHoldDiscussionBeforeFinish: function () {
      var info = this._discussionPendingInfo();
      var now = Date.now();
      // 讨论页正开着（新标签页）或刚由我们打开：这一节肯定还没做完
      var inflight = false;
      try {
        if (this._discussionWindow && !this._discussionWindow.closed) inflight = true;
      } catch (e0) { inflight = false; }
      var openedRecently = now - (this._discussionOpenedAt || 0) < 90000;
      if (inflight || openedRecently) {
        if (!this._discussionHoldSinceAt) this._discussionHoldSinceAt = now;
        return { hold: true, reason: inflight ? 'window-open' : 'just-opened', pending: 1, total: info.total, heldMs: now - this._discussionHoldSinceAt, budgetMs: 90000 };
      }
      if (!info.pending) {
        this._discussionHoldSinceAt = 0;
        this._discussionHoldKey = '';
        return { hold: false, reason: info.source === 'none' ? 'no-discussion-task' : (info.source === 'disabled' ? 'discussion-off' : 'all-recorded'), pending: 0, total: info.total, source: info.source, heldMs: 0, budgetMs: 0 };
      }
      var budgetMs = info.source === 'cards' ? 90000 : 20000;
      if (this._discussionHoldKey !== info.sig) {
        this._discussionHoldKey = info.sig;
        this._discussionHoldSinceAt = now;
      }
      var heldMs = now - (this._discussionHoldSinceAt || now);
      if (heldMs >= budgetMs) {
        this._discussionHoldSpent = Number(this._discussionHoldSpent || 0) + 1;
        this._discussionHoldSinceAt = 0;
        this._discussionHoldKey = '';
        return { hold: false, reason: 'budget-spent', pending: info.pending, total: info.total, source: info.source, heldMs: heldMs, budgetMs: budgetMs, spent: this._discussionHoldSpent };
      }
      if (Number(this._discussionHoldSpent || 0) >= 2) {
        return { hold: false, reason: 'budget-cap', pending: info.pending, total: info.total, source: info.source, heldMs: 0, budgetMs: budgetMs, spent: this._discussionHoldSpent };
      }
      return { hold: true, reason: info.source, pending: info.pending, total: info.total, source: info.source, heldMs: heldMs, budgetMs: budgetMs };
    },


    // 刷课页侧：发现讨论任务点就打开讨论页
    _tryDiscussionTask: async function () {
      if (this.configs.enableDiscussion === false) return false;
      // 首次调用时挂上"讨论页回首掏"的监听（跨域，只能靠 postMessage）
      this._bindDiscussionOutcome();
      // 同一标签页跳过去又跳回来时没有 opener，结果只写在 window.name 里（批次 20-F）
      this._consumeDiscussionWindowName();
      // 旧版本留下的"已发过"记录不可信，升级后自动作废一次（不需要用户敲命令）
      this._migrateDiscussionDoneOnce();
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
        // ⚠️ 同时写下**时间戳**（批次 9-A）：这条放宽原先永不过期，于是刷课页上
        // 只要正文里有「讨论」二字就能被认成回帖页 —— 代价是往班群里发垃圾帖。
        try {
          localStorage.setItem('omitone_return_url', String(location.href || ''));
          localStorage.setItem('omitone_return_url_at', String(Date.now()));
        } catch (e1) {}
        // 先标记再打开：即使后面刷新/超时，也不会重复打开同一个讨论页
        this._markDiscussionDone(task.key);
        // 记下"当前在打开哪一个"：讨论页发不出去时会 postMessage 让本页撤回标记
        this._discussionLastOpenedKey = String(task.key || '');
        // 同源时还能顺手存一份（跨域时这个 localStorage 是另一份，仅作兜底）
        try { localStorage.setItem('omitone_discussion_key', String(task.key || '')); } catch (eKey) {}
        /**
         * ⚠️ 把**本页的键**写进 `window.name`（批次 20-F）。
         * 弹窗被拦时接下来是 `location.href` 自己跳去 groupweb，
         * 讨论页既没有 opener、回来时本页又是一份全新文档 ——
         * `window.name` 是同标签跨域导航后仍然留着的少数通道之一，
         * 讨论页发完回帖会把它改写成 `omitoneX|<键>`（失败）或 `omitoneOK|<键>`（成功）。
         */
        try { window.name = 'omitoneD|' + String(task.key || ''); } catch (eName) {}
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


    /**
     * 讨论区的「发布」按钮。
     *
     * ⚠️ 传入 `nearEditor` 时，按钮**必须和这块编辑区共用一块不是 body 的容器**
     * （从编辑区往上最多 4 层）——
     * 批次 9-A 的现场就是"页面上随便一个文字含「提交」的按钮"被当成了发帖按钮，
     * 而那个按钮是**卷子刚要点的提交按钮**。兜底按文字认没问题，
     * 但必须限定在同一块讨论区内部，否则等于在整页里找按钮去点。
     */
    _findDiscussionSubmitButton: function (nearEditor) {
      // 从**编辑区**往上找一块「装着按钮的容器」，最多 4 层，**且不许是 body/html** ——
      // 整页任何两个节点都在 body 之下，把 body 当共同容器等于没这条判据。
      var sharesContainer = function (node) {
        if (!nearEditor || !node) return !nearEditor;
        var box = nearEditor;
        for (var depth = 0; depth <= 4 && box; depth++) {
          if (box === document.body || box === document.documentElement) return false;
          if (box.contains && box.contains(node)) return true;
          box = box.parentElement || box.parentNode || null;
        }
        return false;
      };
      // 精确优先：学习通讨论区的提交按钮（页面上还有别的"回复"，点错就发不出去）
      try {
        var exact = document.querySelector('.addReply, [class*="addReply"], .replyEditBtnGroup .jb_btn');
        if (exact && visible(exact) && sharesContainer(exact)) return exact;
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
        if (!sharesContainer(node)) continue;
        return node;
      }
      // 给了编辑区却找不到同容器的按钮：**不许**退回到"整页第一个含「提交」的按钮"
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
    /**
     * ⚠️ 除了条数，还要记下**列表容器当时在不在**（批次 20-B）：
     * 回帖页刚注入脚本时列表常常还没水合，读出来是 0 条；等我们填完、点完，
     * 列表渲染出 20 条 —— 这 0→20 是**页面自己加载**，不是"我们发出去了"。
     * 上一版就是把它当成"多了一条"，日志留下一条假的 `discussion reply confirmed`。
     */
    _discussionBaseline: function () {
      var info = { count: 0, text: '', listPresent: false };
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          info.listPresent = true;
          info.count = list.querySelectorAll('.topicDetail_replyItem').length;
          info.text = String(list.innerText || '');
        }
      } catch (e0) {}
      return info;
    },


    /**
     * 收集"这次到底发出去没有"的**证据**（只陈述事实，不做判断）。
     *
     * 为什么单独拆出来：判据只回一个真假值时，日志就没法解释"它凭什么是成功"。
     * 2026-10-17 三个讨论丢了一个，日志明明写着 `confirmed`，却完全看不出是靠哪条过的。
     */
    _discussionEvidence: function () {
      var content = String(this.configs.discussionReply || '1').trim();
      var before = this._discussionBefore || { count: 0, text: '', listPresent: false };
      var ev = {
        contentLen: content.length,
        filled: this._discussionFilledOk === true,
        listPresent: false,
        beforeListPresent: before.listPresent === true,
        items: -1,
        beforeItems: Number(before.count || 0),
        grew: false,
        hasContent: false,
        successText: false,
        rejectedText: false,
        editorEmpty: null,
        cleared: false
      };
      try {
        var list = document.querySelector('.topicDetail_replyList');
        if (list) {
          ev.listPresent = true;
          ev.items = list.querySelectorAll('.topicDetail_replyItem').length;
          // 「多了一条」只有在**基线本身可信**时才算数（批次 20-B）：
          // 提交前列表不存在或确实一条都没有 → 0 不是可信基线，0→N 无法区分水合与新增。
          ev.grew = ev.beforeItems > 0 && ev.items > ev.beforeItems;
          // ⚠️ 只有回复内容**够长**时才做文本匹配。
          // 默认回复就是 "1"，而 "1" 在页面上到处都是（日期 / 楼层 / 题号 / 计数）——
          // 拿它去 `indexOf` 近乎恒真，于是"发失败"也能被判成成功（本次的真因）。
          ev.hasContent = content.length >= 6 &&
            String(list.innerText || '').indexOf(content) !== -1 &&
            String(before.text || '').indexOf(content) < 0;
        }
      } catch (e1) {}
      try {
        var bodyText = String(document.body.innerText || '');
        ev.successText = /发布成功|发表成功|提交成功|回复成功|评论成功|操作成功/.test(bodyText);
        // 反向证据：平台明确说了没发出去。没有这一条，"页面弹了个错误"和"没来得及确认"
        // 在日志里长得一模一样，而前者重试是白费、后者重试才有意义。
        ev.rejectedText = /回复失败|发送失败|发布失败|发表失败|操作失败|内容不能为空|请输入内容|请输入回复|请登录|请先登录|操作太频繁|频繁请求|禁言|审核中/.test(bodyText);
      } catch (e2) {}
      // ⚠️ 必须量**我们填进去的那一个节点**（批次 20-B）：`_findDiscussionEditor()`
      // 会按可见面积重新挑，页面一改版就可能挑到另一块输入区，
      // 于是"编辑区已清空"量的根本不是刚才填过的那块。
      var editor = this._discussionEditorEl || null;
      if (!editor || !document.contains(editor)) editor = this._findDiscussionEditor();
      if (editor) {
        ev.editorEmpty = String(editor.value !== undefined ? editor.value : editor.textContent || '').trim() === '';
        ev.cleared = ev.filled && ev.editorEmpty === true;
      }
      return ev;
    },


    /**
     * 这次提交算不算成功。先否后肯：
     *   ⓪ 页面上有"失败 / 不能为空 / 请登录 / 太频繁"之类的拒绝文案 → 直接判失败（批次 20-B）
     *   ① 回复条目真的多了一条（**要求提交前就有可信基线**，水合的 0→N 不算）
     *   ② 回复列表里出现了我们那段文字（要求内容够长，避免 "1" 恒真）
     *   ③ 页面弹了「发布成功」之类的提示
     *   ④ 填进去过、**我们那块编辑区被平台清空了**、且列表里至少有一条 ——
     *      这条专门补 ① 的洞：话题原本零回复时基线是 0，发成功也只能靠"框被清空"证明
     *   ⑤ 页面上根本没有回复列表可对账时，才退而相信"填进去过 + 编辑区已清空"
     *
     * ⚠️ ④⑤ 都排在正向证据之后：编辑区为空本身是"发成功"和"发失败"**共有**的现象，
     * 单凭它下结论就是上一版假 `confirmed` 的来源；实测这个平台上发失败时
     * 文字**留在框里**（那条未确认的记录 `editorEmpty:false`），所以清空加上"列表非空"才是站得住的组合。
     */
    _discussionSuccessHint: function () {
      var ev = this._discussionEvidence();
      if (ev.rejectedText) return false;
      if (ev.grew || ev.hasContent || ev.successText) return true;
      if (ev.listPresent && ev.filled && ev.cleared && ev.items >= 1) return true;
      if (!ev.listPresent && ev.filled && ev.editorEmpty === true) return true;
      return false;
    },


    /**
     * 「这是不是讨论页」的唯一判据（2026-11-11 批次 9-A 收紧）。
     *
     * 真实日志里的现场（00:46:26）：插件在**刷课页**上报 `discussion page detected`，
     * 往平台真发了一条内容为「1」的回帖，而它点的按钮文字含「提交」—— 很可能就是
     * 那份卷子自己的提交按钮（那一刻 `quiz submit pending` 才刚打过两秒）。
     * 三处放宽叠在一起才会成这样：
     *   ① `omitone_return_url` **写完永不清除**，于是"从刷课页跳过去"这条放宽**永久生效**；
     *   ② 放宽只看正文有没有「讨论」二字 —— 课程页导航里常年有「讨论」标签；
     *   ③ 提交按钮兜底按文字认（含「提交」），编辑区兜底取页面上最大的可见输入区，
     *      两者**互不相干**也能凑成"是讨论页"。
     * 现在：放宽只在我们自己跳转后的两分钟内有效、刷课页网址一律不放宽、
     * 按钮必须与编辑区同容器，且答题在飞时时根本不进讨论判据。
     */
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
      var relaxed = false;
      if (!urlHit && !titleHit) {
        // 只有"是我们自己刚跳过去的讨论页"才允许靠正文文案认 —— 且**刷课页网址永远不算**：
        // 真讨论页有自己的网址形状（groupweb / course/topic / bbscircle），
        // 靠一句导航里的「讨论」就把课程页当成回帖页，代价是往用户班群里发垃圾帖。
        if (this._isStudyCourseHref(href)) return this._declineDiscussionPage('study-page', { href: href.slice(0, 90) });
        if (!this._discussionReturnFresh()) return this._declineDiscussionPage('return-jump-expired', { href: href.slice(0, 90) });
        if (!bodyHit) return this._declineDiscussionPage('no-discussion-text', { href: href.slice(0, 90) });
        relaxed = true;
      }
      // 必须是"同一块讨论区里既有输入框又有发布按钮"，避免在纯浏览的帖子列表页乱填
      var editor = this._findDiscussionEditor();
      if (!editor) return this._declineDiscussionPage('no-editor', { href: href.slice(0, 90), relaxed: relaxed });
      var button = this._findDiscussionSubmitButton(editor);
      if (!button) return this._declineDiscussionPage('no-co-located-submit', { href: href.slice(0, 90), relaxed: relaxed });
      this._discussionDeclineSignature = '';
      return true;
    },


    // 刷课页网址形状（批次 9-A）：这些页面上**永不**靠正文文案认讨论页
    _isStudyCourseHref: function (href) {
      return /\/mycourse\/studentstudy|\/mycourse\/student|\/course\/study|\/ananas\/|mooc-ans|\/knowledge\/|\/chapter|studentcourse/i.test(String(href || ''));
    },


    // 「从刷课页跳过去」的放宽只在**一次跳转的窗口**内成立（批次 9-A）
    _discussionReturnFresh: function () {
      var at = 0;
      try { at = Number(localStorage.getItem('omitone_return_url_at') || 0); } catch (e0) {}
      if (!(at > 0)) return false;
      if (Date.now() - at > 120000) {
        // 过期就顺手清掉：留着它，下一轮又会把别的页面认成讨论页
        try { localStorage.removeItem('omitone_return_url'); localStorage.removeItem('omitone_return_url_at'); } catch (e1) {}
        return false;
      }
      return true;
    },


    // 判据拒了也要留话 —— 否则"为什么这条讨论没发"和"页面不是讨论页"在日志里长得一样。
    // ⚠️ 节流从 30 秒放到 **120 秒**：刷课时这条每 tick 都会被 `study-page` 拒一次，
    //    30 秒等于一条都没挡住（现场实测约 31 秒一条，和 `media pending` 一起把
    //    200 条日志环刷满，真正要看的「为什么跳过这一节」几条分钟后就查不到了）。
    //    换了**别的**理由仍然立刻出日志 —— 节流只压同一条重复。
    _declineDiscussionPage: function (reason, info) {
      var now = Date.now();
      var signature = String(reason || '');
      if (!this._discussionDeclineLogAt || now - this._discussionDeclineLogAt > 120000 || signature !== this._discussionDeclineSignature) {
        this._discussionDeclineLogAt = now;
        this._discussionDeclineSignature = signature;
        var payload = { reason: reason };
        Object.keys(info || {}).forEach(function (k) { payload[k] = info[k]; });
        payload.hint = '讨论页判据拒了这一步 —— 批次 9-A 之后，刷课页/放宽过期/按钮与编辑区不同容器都不再进讨论链路（防止往课程讨论区发垃圾回帖）';
        emitRuntimeLog('info', 'discussion page declined', payload);
      }
      return false;
    },


    // 「这一页此刻正在答题」的判据（批次 9-A，只给讨论链路用）。
    // `_quizInProgress` 带 5 分钟时限：它若因异常没被复位，不能让讨论永远进不去。
    _quizInFlightForDiscussion: function () {
      if (this._quizSubmitPending || this._quizReadyToSubmit) return true;
      if (this._quizInProgress && Date.now() - (this._quizInProgressAt || 0) < 300000) return true;
      return false;
    },


    _isDiscussionPage: function () {
      if (this.configs.enableDiscussion === false) return false;
      // ⚠️ 答题在飞时**根本不进讨论判据**（批次 9-A）：讨论判据挂在 `_runTick` 最前面，
      // 而 OCS 学习循环是**另一个异步循环** —— 两者并行时，讨论链路会去点页面里含「提交」
      // 的按钮，而那正是卷子刚要点的按钮（真实日志 00:46:24 提交中、00:46:26 发帖）。
      if (this._quizInFlightForDiscussion()) {
        this._discussionPageResult = false;
        return false;
      }
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


    /**
     * 发帖前等页面"活过来"（批次 20-F）。
     *
     * 实测现场（2026-11-11 23:08）：话题页的回复列表是服务端先出 HTML、页面 JS 再用
     * XHR 水合的（`getTopReplyList` → `getReplyList`）。脚本注入太早时
     * 「回复」按钮**已经在 DOM 里、事件却还没绑上** ——
     * 于是填了、点了、一条请求都没发，日志只留下 `not confirmed`，
     * 而这条讨论实际一条都没发出去；紧接着刷课页把这一节判成"做完"翻过去。
     *
     * 判据用列表水合（已经有回复项，或页面写出了「共N条回复」），最长等 12 秒。
     * **等不到也照发** —— 真的一条回复都没有的话题是存在的，
     * 卡在这里不放行比重演一次"点了没反应"更糟。
     */
    _waitDiscussionReady: async function () {
      var deadline = Date.now() + 12000;
      var by = 'timeout';
      var waited = 0;
      while (Date.now() < deadline) {
        try {
          if (document.querySelector('.topicDetail_replyItem')) { by = 'list'; break; }
          if (String(document.readyState || '') === 'complete') {
            var em = document.querySelector('.classReplyCount');
            // 那个 <em> 默认带 `hide`，innerText 读不到东西 —— 只能按 textContent 数
            if (em && /\d+/.test(String(em.textContent || ''))) { by = 'count'; break; }
          }
        } catch (e0) { by = 'error'; break; }
        await sleep(500);
        waited += 500;
      }
      emitRuntimeLog('info', 'discussion page hydrated', {
        by: by, waitedMs: waited, items: this._discussionBaseline().count
      });
    },


    // 刷课页在同一个标签页跳过来时把它的键写在 window.name 里（见 _tryDiscussionTask）
    _discussionStudyKeyOfName: function () {
      var raw = '';
      try { raw = String(window.name || ''); } catch (e0) { return ''; }
      if (raw.indexOf('omitoneD|') !== 0) return '';
      return raw.slice(9).slice(0, 80);
    },


    /**
     * 「讨论页说这次没发出去」的统一收口。
     * 原先只有 postMessage 一条路能走到这里，同一标签页跳转那条路（弹窗被拦时的路径）
     * 根本没有 opener，失败信号就丢了 —— 刷课页的"已做"标记一直留着，
     * 24 小时内不再重试，用户只看到"这一节卡着"。
     */
    _handleDiscussionFailure: function (keyIn, source) {
      var key = String(keyIn || this._discussionLastOpenedKey || '');
      if (!key) return false;
      var tries = this._bumpDiscussionTry(key);
      var limit = 3;   // 最多重试 3 次：平台若压根发不出去，无限重开只会空转
      if (tries > limit) {
        emitRuntimeLog('warn', 'discussion reply keeps failing, give up for now', {
          key: key.slice(0, 40),
          tries: tries,
          source: source,
          hint: '已连续失败 ' + tries + ' 次，24 小时内不再尝试（可手动处理，或清掉 localStorage 里的 omitone_discussion_done）'
        });
        return true;
      }
      this._unmarkDiscussionDone(key);
      emitRuntimeLog('warn', 'discussion reply failed, will retry', {
        key: key.slice(0, 40),
        tries: tries,
        limit: limit,
        source: source
      });
      return true;
    },


    /**
     * 刷课页侧：读回讨论页用 `window.name` 递回来的结果（批次 20-F）。
     *
     * `window.name` 是**同一标签页跨域导航后仍然保留**的少数几个通道之一 ——
     * 弹窗被拦时刷课页自己 `location.href` 跳去 groupweb，回来是一份全新的文档，
     * `window.opener` 压根不存在，postMessage 那条路是死的。
     */
    _consumeDiscussionWindowName: function () {
      if (this._discussionNameRead) return;
      this._discussionNameRead = true;
      var raw = '';
      try { raw = String(window.name || ''); } catch (e0) { return; }
      if (raw.indexOf('omitoneX|') !== 0 && raw.indexOf('omitoneOK|') !== 0) return;
      var key = raw.slice(9);
      try { window.name = ''; } catch (e1) {}
      if (raw.indexOf('omitoneX|') === 0) {
        this._handleDiscussionFailure(key, 'window-name');
        return;
      }
      emitRuntimeLog('info', 'discussion reply landed', { key: key.slice(0, 40), source: 'window-name' });
    },


    /**
     * 把发帖结果递回刷课页（批次 20-F）。
     *
     * ⚠️ 两条通道都得走，因为打开方式有两种：
     *   · `window.open` 成功 → 讨论页有 opener → postMessage 能到
     *   · 弹窗被拦、刷课页自己 `location.href` 跳过来 → **根本没有 opener**，
     *     而且发完回帖跳回去时刷课页是一份全新文档，
     *     内存里那个 `_discussionLastOpenedKey` 早跟着旧文档没了 ——
     *     只有 `window.name` 能跨过这次同标签的跨域导航把话带到。
     * 在这里调 `_unmarkDiscussionDone` 撤的是 groupweb 自己那份存储，
     * 对刷课页（mooc1）毫无影响（2026-10-17 实测踩到）。
     */
    _announceDiscussionOutcome: function (ok, studyKey) {
      var key = String(studyKey || '');
      try {
        if (!ok && window.opener && !window.opener.closed) {
          window.opener.postMessage({ omitoneDiscussion: 'failed', key: key }, '*');
        }
      } catch (eNotify) {}
      try { window.name = (ok ? 'omitoneOK|' : 'omitoneX|') + key; } catch (eName) {}
    },


    _runDiscussionMode: async function () {
      if (this._discussionBusy) return;
      if (this._discussionPosted) return; // 每个页面只发一次，避免重复评论
      /**
       * ⚠️ 「每个页面只发一次」原先**只记在内存里**（批次 20-E）：
       * 实测同一个话题在 22:38:34 和 22:45:22 各发了一条内容「1」的回帖，
       * 中间那次是 `discussion done, waiting for reload` 之后页面自己重载
       * （`auto resume after reload`）→ 新的 document → `_discussionPosted` 又是 false
       * → 对着同一个话题再发一遍。讨论页在 `groupweb`、刷课页在 `mooc1`，
       * 两边的 localStorage 不是同一份，所以**本站也得记一份**按话题的账。
       */
      var pageKey = 'page|' + this._discussionKeyOf(location.href);
      if (this._isDiscussionDone(pageKey)) {
        this._discussionPosted = true;
        var nowDup = Date.now();
        if (!this._discussionDupLogAt || nowDup - this._discussionDupLogAt > 60000) {
          this._discussionDupLogAt = nowDup;
          emitRuntimeLog('info', 'discussion already posted on this topic, skip', {
            key: pageKey.slice(0, 48),
            url: String(location.href || '').slice(0, 110),
            hint: '本站记过这条回帖（24 小时内），不再重复发帖；要强制重发清掉 groupweb 这个源里的 omitone_discussion_done'
          });
        }
        return;
      }
      this._discussionBusy = true;
      emitRuntimeLog('info', 'discussion page detected, posting reply', { url: String(location.href || '').slice(0, 120) });
      try {
        // 先等页面水合，再找控件（批次 20-F）：按钮在 DOM 里但没有事件时点它没有任何反应
        await this._waitDiscussionReady();
        var editor = this._findDiscussionEditor();
        if (!editor) {
          await this._expandDiscussionEditor();
          editor = this._findDiscussionEditor();
        }
        // 按钮要在**编辑区展开之后**、且**与编辑区同容器**才找（批次 9-A）：
        // 原先在编辑区还没拿到时就找，取到的是整页第一个文字含「提交」的按钮
        var button = editor ? this._findDiscussionSubmitButton(editor) : null;
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
        // ⚠️ 存下**这一块**编辑区：提交后的证据要量"刚填过的那个节点现在空不空"，
        // 而不是"再找一次页面上最大的输入区"（批次 20-B，页面一改版就会挑到别处）。
        this._discussionEditorEl = editor;
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
          this._unmarkDiscussionDone(pageKey);
        }
        // 按话题的账在**点下去之前**写（批次 20-E）：点完立刻刷新也能被这份记录挡住，
        // 不会对着同一个话题发出第二条
        this._markDiscussionDone(pageKey);

        // 刷课页那一侧的键（同一标签页跳转时写在 window.name 里，弹窗路径拿不到就留空）
        var studyKey = this._discussionStudyKeyOfName();
        var confirmed = false;
        var ev = null;
        var attempts = 0;
        for (var attempt = 1; attempt <= 2 && !confirmed; attempt++) {
          attempts = attempt;
          /**
           * ⚠️ 基线必须**贴着点击这一刻**取（批次 20-F）。
           * 原先基线在填之前取，那会儿列表常常还没水合、读到 0 条；
           * 等点完再看，页面自己长出了 20 条 —— 于是两个方向都错：
           * 没发出去却"看着像长了"（上一版就是这条假 `confirmed`），
           * 真发出去了（20→21）又因为"基线 0"被别的判据盖过去。
           */
          this._discussionBefore = this._discussionBaseline();
          try { button.click(); } catch (eClick) {}
          emitRuntimeLog('info', 'discussion reply submitted', {
            content: content.slice(0, 40),
            editor: String(editor.tagName || '') + (editor.id ? '#' + editor.id : ''),
            button: String(button.className || '').slice(0, 60),
            attempt: attempt,
            beforeItems: Number(this._discussionBefore.count) || 0,
            url: String(location.href || '').slice(0, 100)
          });

          // 等待提交结果（每轮最多 8 秒）；未确认也继续返回——宁可少发一次，也不能卡住刷课
          for (var i = 0; i < 8; i++) {
            await sleep(1000);
            if (this._discussionSuccessHint()) {
              confirmed = true;
              // 把"凭什么算成功"一起记下来 —— 只写 confirmed 的话，下次还是查不出来
              emitRuntimeLog('info', 'discussion reply confirmed', {
                evidence: this._discussionEvidence(), attempt: attempt
              });
              break;
            }
          }
          if (confirmed) break;
          ev = this._discussionEvidence();
          // 只有「文字还好好待在框里、且平台没明说失败」才值得再点一次 ——
          // 实测那种情况下压根一个请求都没发（点击早于页面绑定事件），再点就出去了。
          // 平台已经报错（rejectedText）就不再点，避免对着同一话题连发多条。
          if (attempt >= 2 || ev.rejectedText === true || ev.filled !== true || ev.editorEmpty !== false) break;
          emitRuntimeLog('warn', 'discussion submit click had no effect, retrying', {
            attempt: attempt, items: ev.items, beforeItems: Number(this._discussionBefore.count) || 0
          });
          this._discussionEditorEl = this._findDiscussionEditor() || this._discussionEditorEl;
          button = this._findDiscussionSubmitButton(this._discussionEditorEl) || button;
          if (this._discussionEditorEl) this._fillDiscussionEditor(this._discussionEditorEl, content);
          await sleep(800);
        }
        if (!confirmed) {
          // ⚠️ 把三条判据各自的实况一起记下来 —— 只说"未确认"的话，
          // 下次还是得靠猜（这一轮就因为看不到细节多绕了两趟）。
          ev = ev || this._discussionEvidence();
          ev.content = String(content || '').slice(0, 20);
          ev.attempts = attempts;
          // 20-F：本站这份账在"**确实没发出去**"的三种情形撤回 ——
          // 没填上（filled=false）、平台明说失败（rejectedText=true）、
          // 或**文字还留在框里**（editorEmpty=false ⇒ 这一下压根没生效）。
          // 最后一种原先是留着不撤的，理由"大概率已发出" —— 实测恰恰相反：
          // 23:08 那条就是这么被记成"已发"、再也没重试过，整节卡在讨论任务点上。
          if (!ev.filled || ev.rejectedText === true || ev.editorEmpty === false) {
            this._unmarkDiscussionDone(pageKey);
            ev.pageKeyReleased = true;
          }
          emitRuntimeLog('warn', 'discussion reply not confirmed, resume anyway', ev);
        }
        // 把真实结果递回刷课页（成功/失败都要说，失败更要说）
        this._announceDiscussionOutcome(confirmed, studyKey);

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
