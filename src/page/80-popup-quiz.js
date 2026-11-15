/* ==========================================================================
 * Omitone page.js 片段 14/15 —— 视频内嵌弹题 / 继续学习提示
 * 来源：原 page.js 中散布的 11 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 弹题（弹窗题）的检测、填答、失败计数与放弃
 * 「继续学习」提示按钮的处理（不点它进不去正常播放页）
 *
 * 本段的方法（18 个）：
 *   _findContinueStudyButton、_tryContinueStudyPrompt、_activePopupBlock、
 *   _popupQuizBlocksPlayback、_popupQuizFingerprint、_getPopupQuizMaxAttempts、
 *   _checkPopupQuiz、_handlePopupQuiz、_giveUpPopupQuiz、_detectPopupQuizType、
 *   _looksLikeMatchingQuiz、_fillPopupAnswer、_popupQuestionBlock、_popupQuizStem、
 *   _stemIsOnlyOptions、_popupQuizSpendBucket、_notePopupQuizGiveUp、_answerPopupQuizLocally
 * ========================================================================== */
// @omitone-part-header-end

    _findContinueStudyButton: function (video) {
      if (video === undefined) {
        try { video = this._getVideoEl(); } catch (e) { video = null; }
      }
      var videoDoc = video && video.ownerDocument ? video.ownerDocument : null;

      var texts = ['继续学习', '继续观看', '继续播放'];
      var best = null;
      var bestScore = -1;

      this._walkDocuments(function (doc) {
        var nodes = [];
        try {
          nodes = Array.from(doc.querySelectorAll(
            'a, button, .btn, [class*="btn"], [class*="continue"], [class*="study"], span, div'
          ));
        } catch (e) { return false; }

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          // 先做便宜的文案比对，再判可见性：
          // visible() 会读 offsetParent / getBoundingClientRect，触发强制重排，
          // 对每个 div/span 都调一遍在真实页面上是很可观的一笔开销
          var label = String((node.textContent || node.value || '')).replace(/\s+/g, '').trim();
          if (!label) continue;

          var hit = -1;
          for (var t = 0; t < texts.length; t++) {
            if (label.indexOf(texts[t]) !== -1) { hit = t; break; }
          }
          if (hit === -1) continue;
          if (!visible(node)) continue;
          // 只接受文案很短的节点：整块浮层/面板的文字远不止这几个字，
          // 命中它说明这只是容器，点容器通常什么也不会发生
          if (label.length > 12) continue;

          var score = 0;
          if (videoDoc && doc === videoDoc) score += 4;
          var tag = String(node.tagName || '').toLowerCase();
          if (tag === 'button' || tag === 'a' || tag === 'input') score += 3;
          var cls = String(node.className || '');
          if (/btn|button|continue|study|resume/i.test(cls)) score += 2;
          if (node.getAttribute && (node.getAttribute('onclick') || node.getAttribute('role'))) score += 1;
          // 叶子节点优先：真正的按钮通常不含子元素，而外层容器带着标题/说明文字。
          // 站点把 onclick 挂在按钮上，点到容器是没反应的 —— 这一分决定了会不会白点。
          if (!node.children || node.children.length === 0) score += 2;
          score -= hit; // 「继续学习」优先于「继续观看/继续播放」

          if (score > bestScore) { bestScore = score; best = node; }
        }
        return false;
      });

      return bestScore >= 0 ? best : null;
    },


    /**
     * 看到「继续学习」就点一下。返回是否点过。
     *
     * 三道保险：① **扫描节流**（遍历所有文档的 div/span 不便宜，而 tick 每 250ms 一轮，
     * 视频正在正常播放时更是没必要，放到 6 秒一次）；② 同一按钮 3 秒内只点一次；
     * ③ 同一个按钮连点 5 次还在，说明点了没反应（不是我们要找的 / 页面另有机关），
     * 停 60 秒并写日志 —— 免得把"点不动的按钮"变成新的空转源。
     */
    _tryContinueStudyPrompt: function () {
      var now = Date.now();
      if (now < (this._continueStudyBlockedUntil || 0)) return false;

      var scanVideo = null;
      try { scanVideo = this._getVideoEl(); } catch (e) { scanVideo = null; }
      var scanInterval = (scanVideo && !scanVideo.paused) ? 6000 : 1200;
      if (now - (this._continueStudyScanAt || 0) < scanInterval) return false;
      this._continueStudyScanAt = now;

      if (now - (this._continueStudyAt || 0) < 3000) return false;

      // 把已经取到的 video 传下去，省掉 _findContinueStudyButton 里的第二次全文档查找
      var btn = this._findContinueStudyButton(scanVideo);
      if (!btn) {
        if (this._continueStudyKey) {
          this._continueStudyKey = '';
          this._continueStudyClicks = 0;
        }
        return false;
      }

      var key = String(btn.className || '') + '|' + textOf(btn).slice(0, 30);
      if (key === this._continueStudyKey) this._continueStudyClicks++;
      else {
        this._continueStudyKey = key;
        this._continueStudyClicks = 1;
      }

      if (this._continueStudyClicks > 5) {
        emitRuntimeLog('warn', 'continue-study button did not respond, stop clicking', {
          text: textOf(btn).slice(0, 30),
          clicks: this._continueStudyClicks
        });
        this._continueStudyBlockedUntil = now + 60000;
        this._continueStudyKey = '';
        this._continueStudyClicks = 0;
        return false;
      }

      emitRuntimeLog('info', 'click continue-study prompt', {
        text: textOf(btn).slice(0, 30),
        cls: String(btn.className || '').slice(0, 60)
      });
      try {
        if (typeof btn.click === 'function') btn.click();
        else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (e) {}
      this._continueStudyAt = now;
      return true;
    },


    /**
     * 取"应该拦住刷课流程"的弹窗题。
     *
     * 与 _checkPopupQuiz 的区别：多了"放弃窗口"。弹题一旦答不上来（结构不认识 /
     * 选项匹配不上），弹窗不会自动消失，而 tick 每 250ms 一轮 —— 没有这个窗口，
     * 同一道题会被无限次发给模型，同时把后面的刷课逻辑全挡住，课程就此空转。
     * 所有"有弹窗就别动"的判断都必须走这里，不能直接用 _checkPopupQuiz。
     */
    _activePopupBlock: function () {
      var now = Date.now();
      if (this._popupQuizBlockedUntil && now < this._popupQuizBlockedUntil) {
        // 放弃窗口一旦生效就立刻作废缓存：否则接下来几百毫秒还会拿到旧弹窗，
        // 已经清空的计数又会被重新累加，"放弃"形同虚设
        this._popupBlockCheckedAt = 0;
        this._popupBlockCached = null;
        return null;
      }
      // ⚠️ 填完答案后的静默期：**站点会重绘弹窗**（给正确项打勾 / 加提示 / 重排），
      // 而指纹取的是选项文本 —— 文本一变指纹就变，「已答放行」立刻失效，
      // 弹窗被当成新题 → 再问模型 → 再点一次选项 → 站点再重绘 …… 死循环。
      // 现场表现就是「选项一直闪」，而且因为指纹一变 attempts 就重置，
      // 「最多问 3 次就放手」的安全阀**永远触发不了**。
      // 所以填完之后先静默一段时间，无论指纹怎么变都不碰它。
      if (now < (this._popupQuizQuietUntil || 0)) {
        this._popupBlockCheckedAt = 0;
        this._popupBlockCached = null;
        return null;
      }
      // _checkPopupQuiz 要遍历所有文档，而 tick 每 250ms 一轮。
      // 400ms 内复用上一次的结果：弹窗不会在这个尺度上凭空出现又消失。
      // 缓存的是**经过下面两道判断之后**的结果，所以"已答放行"不会被缓存绕过。
      if (this._popupBlockCheckedAt && now - this._popupBlockCheckedAt < 400) {
        return this._popupBlockCached || null;
      }

      var node = null;
      try { node = this._checkPopupQuiz(); } catch (e) { node = null; }
      if (!node) {
        // 弹窗没了就清掉计数，下一次弹出的是新题，重新给满次数
        this._popupQuizKey = '';
        this._popupQuizAttempts = 0;
        this._popupQuizSolvedKey = '';
        this._popupQuizWrongAnswers = [];
        this._popupQuizLastFilled = '';
        this._popupQuizQuietUntil = 0;
      } else {
        // 已经答过、但站点还没把弹窗收走：这段时间别再问第二遍模型，也别继续拦着刷课。
        //
        // 与上面那段静默期的分工：静默期管的是"刚填完、站点可能正在重绘"，
        // 这一段管的是"弹窗消失又冒出来、指纹一模一样"（站点重开同一道题）——
        // 那时静默期可能已经被上面"弹窗没了"的分支清掉，靠这个标记继续压住。
        //
        // ⚠️ 窗口必须与静默期**相等**，绝不能更长。曾经写死 30 秒，比 8 秒静默期长 22 秒，
        // 于是答错之后有整整 22 秒处于"静默期已过、却仍被当成已答"的没人管空档：
        // 弹窗挂在那儿没人重试，恢复播放那条路也以为"没有弹窗"去抢恢复被站点有意暂停的视频。
        // 用户看到的就是"答完就卡住、等半天没反应"。现在两者共用同一个常量。
        var key = this._popupQuizFingerprint(node);
        if (key === this._popupQuizSolvedKey && now - (this._popupQuizSolvedAt || 0) < scaledMs(POPUP_QUIZ_QUIET_MS)) {
          node = null;
        }
      }

      this._popupBlockCheckedAt = now;
      this._popupBlockCached = node;
      return node;
    },


    /**
     * 弹题是否正在**挡着播放**。
     *
     * 与 `_activePopupBlock()` 的关键区别：**静默期也算挡着**。
     *
     * 这两个其实是不同的问题，以前共用一个函数才出的事：
     *   · "现在该不该去处理这道弹题？" —— 静默期里的答案是"不"（怕站点重绘导致选项闪烁）
     *   · "现在能不能恢复播放？"     —— 静默期里的答案必须是"不能"
     * 静默期里 `_activePopupBlock()` 返回 null 只回答了前者，**不代表弹窗已经没了**。
     * 而站点是为弹题**有意暂停**了视频；如果据此就去抢恢复播放，就会和站点对打，
     * 现场表现就是"答完之后视频不动、看着像卡死"。
     *
     * 这里直接看 DOM 里还有没有弹窗。不做 400ms 缓存 —— 它只在 pause 事件里被调用，
     * 频率远低于 tick，没必要为它维护一份可能与上面缓存语义冲突的状态。
     * 放弃窗口内返回 false：那道题已经决定不管了，就别再拦着恢复播放。
     */
    _popupQuizBlocksPlayback: function () {
      var now = Date.now();
      if (this._popupQuizBlockedUntil && now < this._popupQuizBlockedUntil) return false;
      try {
        return !!this._checkPopupQuiz();
      } catch (e) {
        return false;
      }
    },


    /**
     * 弹题的**稳定指纹** —— 判断"还是不是同一道题"。
     *
     * ⚠️ 不能用整段文本当指纹。站点答错后会在弹窗里**加一行反馈**
     * （"回答错误，请重新作答"），文本一变指纹就变，于是 `_popupQuizAttempts`
     * 被重置成 1 —— "最多问 3 次就放手"这个安全阀**永远不会触发**，
     * 表现就是：答错之后一直重问模型、弹窗关不掉、看着像卡死，而且**不会自己恢复**
     * （60 秒冷却是 `_giveUpPopupQuiz` 设的，它根本没被调用）。
     *
     * 所以指纹改取**选项文本**：答错反馈只会加在题干或底部，不会改选项。
     * 没有选项（填空题）时退回文本，但先剥掉常见反馈短语。
     *
     * 注意 `_activePopupBlock` 里的"已答放行"判断也用它，两边必须同一个函数，
     * 否则 `_popupQuizSolvedKey` 对不上，已答过的弹窗会被反复重问。
     */
    _popupQuizFingerprint: function (popup, optionItems) {
      var cls = String((popup && popup.className) || "");
      try {
        var opts = optionItems || this._getOptionItems(popup) || [];
        var texts = opts.map(this._extractOptionText.bind(this)).filter(Boolean).join(String.fromCharCode(1));
        if (texts) return cls + "|o|" + texts.slice(0, 240);
      } catch (e) {}
      var raw = "";
      try { raw = textOf(popup); } catch (e2) {}
      raw = raw.replace(/回答错误|答案错误|请重新作答|重新作答|再试一次|不正确|提交失败/g, "").replace(/\s+/g, "");
      return cls + "|t|" + raw.slice(0, 120);
    },


    /**
     * 弹题的**题干该从哪一层读**。
     *
     * 现场（2026-11-15 14:17 日志）：插件抓到的容器是
     * `<div class="tkTopic"><div class="tkTopic_title">判断题</div></div>` ——
     * 里面只有题型名，一个选项都没有；而选项 ["对","错"] 是 `_getOptionItems`
     * 走 `_getOptionsFromAncestor` **从兄弟节点**捞回来的。
     * 于是 `question.title = textOf(popup)` 送给模型的就是「判断题」三个字：
     * 模型看不到问题，只能瞎猜，猜错就被平台拒，弹窗留着 → 再问 → 再猜 ……
     * 每 8 秒烧一次请求，**这一族的钱就是这么烧掉的**。
     *
     * 判据：选项在容器里 → 容器自己就是题块；选项在外面 → 从第一个选项往上走，
     * 走到**第一个能把容器一起包住**的那一层（最多三层，与 `_getOptionsFromAncestor`
     * 的"两层"对齐并留一层余量）。走不到就退回原容器 —— 宁可题干为空（下面
     * `_popupQuizStem` 那条判据会因此**不发请求**），也不要拿整页文字当题干。
     */
    _popupQuestionBlock: function (popup, optionItems) {
      if (!popup) return null;
      var items = optionItems || [];
      if (!items.length) return popup;
      try {
        if (popup.contains && popup.contains(items[0])) return popup;
      } catch (e1) { return popup; }
      var cur = items[0].parentElement;
      for (var hop = 0; hop < 3 && cur; hop++) {
        try {
          if (cur.contains && cur.contains(popup)) return cur;
        } catch (e2) { return popup; }
        cur = cur.parentElement;
      }
      return popup;
    },


    /**
     * 弹题的题干 —— **走抠题那条唯一真源**，不在这里另写一套。
     *
     * `_parseQuestionElement` 的题干规则（`_questionTitleSelectors` 逐个试、
     * 都不合格就退回整块文本并在第一个选项标记处截断、再 `_cleanQuestionTitle`
     * 剥题号与题型名）与章节小测同源，改一处两边都受益。
     * 关键收益：`_cleanQuestionTitle` 会把「判断题」这种**题型名剥掉**，
     * 所以现场那种"容器里只有类型名"的题，这里拿回来的是**空串** ——
     * 空串就是"这道题压根没有可答的内容"，调用方据此**不发请求**。
     * 原来这条路把 `textOf(popup)` 原样当题干，剥不掉的「判断题」就这么送出去了。
     */
    _popupQuizStem: function (popup, optionItems) {
      var block = this._popupQuestionBlock(popup, optionItems);
      // 两块都试：加宽后的整块（题干在弹窗外面时只有那里读得到）、弹窗本身。
      // 挑**第一块不是"纯选项串"的** —— 整块的兜底题干会把选项一起抄进来，
      // 那种题干不为空，会绕过"没题干就不花钱"，模型照样答不了（见 _stemIsOnlyOptions）。
      var cands = [];
      if (block && block !== popup) cands.push(block);
      if (popup) cands.push(popup);
      for (var c = 0; c < cands.length; c++) {
        var t = '';
        try {
          var parsed = this._parseQuestionElement(cands[c], 0);
          t = parsed && parsed.title ? String(parsed.title) : '';
        } catch (e) { t = ''; }
        if (!t) continue;
        if (this._stemIsOnlyOptions(t, optionItems)) continue;
        return t;
      }
      return '';
    },


    /**
     * 这一串"题干"其实只是选项 —— 判据：把每个选项的原文从里面挖掉、再压掉空白，
     * 剩下的不足 4 个字（现场 2026-11-15 14:36 那道判断题重绘后，
     * 整块兜底读回来的是 `A、对 B、错 确定`）。
     *
     * ⚠️ 要求**至少两个选项**能在串里找到，否则单一短选项（如「对」）
     *    会碰巧嵌在真题干里被误判成"没有题干"，把好端端的题降级成本地作答。
     *    降级方向是安全的：宁可少花一次钱，也不要拿"选项清单"当问题去问模型。
     */
    _stemIsOnlyOptions: function (stem, optionItems) {
      if (!stem || !optionItems || !optionItems.length) return false;
      var rest = ' ' + String(stem) + ' ';
      var hit = 0;
      for (var i = 0; i < optionItems.length; i++) {
        var t = textOf(optionItems[i]);
        if (!t) continue;
        if (rest.indexOf(t) === -1) continue;
        hit++;
        rest = rest.split(t).join(' ');
      }
      if (hit < 2) return false;
      return rest.replace(/[\s\u3000]+/g, '').length < 4;
    },


    _getPopupQuizMaxAttempts: function () {
      var max = Number(this.configs && this.configs.popupQuizMaxAttempts);
      return max > 0 ? max : 3;
    },


    /**
     * **按这道视频任务点的付费账本**。
     *
     * 为什么按 `_activeJobId` 分桶：指纹取的是选项文本，而**判断题的选项永远是
     * 「对 / 错」**（现场 14:17 那条 `optionTexts:["对","错"]`）—— 指纹根本分不开
     * 不同判断题。所以账本不能跨任务点累积，否则这一节放弃两次之后，
     * 后面每一道真能答的判断题都只能瞎选。按任务点分桶 = 「这一道题在这个视频里
     * 值几次请求」，换视频重新给额度。
     *
     * ⚠️ 这是**有意的让步**：同一视频里两道选项相同的判断题，会被算成同一道。
     * 用户 2026-11-15 的原话是「弹题答对答错可以让步，但不能一直付费」，
     * 所以宁可少答，也不能每 8 秒问一次。
     */
    _popupQuizSpendBucket: function () {
      var job = String(this._activeJobId || '') || 'job:none';
      if (!this._popupQuizSpend || this._popupQuizSpend.job !== job) {
        this._popupQuizSpend = { job: job, gives: Object.create(null), silent: Object.create(null) };
      }
      return this._popupQuizSpend;
    },


    /**
     * 记一笔「这一道又放弃了一次」，并回答**还要不要为它花钱**。
     * 第二次放弃起进入静音名单：之后一律本地作答，一条请求都不发。
     */
    _notePopupQuizGiveUp: function (key) {
      var bucket = this._popupQuizSpendBucket();
      var gives = Number(bucket.gives[key]) || 0;
      gives++;
      bucket.gives[key] = gives;
      var wasSilent = !!bucket.silent[key];
      if (gives >= 2) bucket.silent[key] = 1;
      if (!wasSilent && bucket.silent[key]) {
        emitRuntimeLog('warn', 'popup quiz stops asking the model for this one', {
          reason: 'gave-up-twice',
          gives: gives,
          fingerprint: String(key).slice(0, 80),
          hint: '这一道（按选项指纹认）在本节已经放弃两次 —— 从现在起本地选一个不花钱的答案，' +
            '不再问模型。代价是它可能选错；好处是钱停在 8 次以内，而不是每 8 秒一次'
        });
      }
      return { gives: gives, silent: !!bucket.silent[key] };
    },


    /**
     * **不花钱**地把弹窗点掉：挑一个还没被平台判错的选项，走与模型答案同一条填答路。
     *
     * 两个调用场景（都不该花请求）：
     *   1. 题干是空的 —— 只有题型名（「判断题」）这种容器现场就是这样，
     *      模型看不到问题，问了也是瞎猜，每一发都是白花钱；
     *   2. 这一道在本节已经放弃两次（`_notePopupQuizGiveUp` 的静音名单）。
     * 填答与交卷**仍然走 `_fillPopupAnswer`** —— 不在这里另写一份选项匹配，
     * 那正是 AGENTS §2 说的"两份规则互漂"。
     */
    _answerPopupQuizLocally: function (popup, optionItems, type, reason) {
      var items = optionItems || [];
      if (!items.length) {
        // 一个选项都没有 → 没有"点一下就能过"的形状，别硬点。
        this._giveUpPopupQuiz(popup, 'no-options-' + reason);
        return false;
      }
      var banned = [];
      try {
        banned = (this._popupQuizWrongAnswers || []).map(function (v) {
          return String(v || '').toUpperCase();
        });
      } catch (eB) {}
      var picked = '';
      var allBanned = true;
      for (var i = 0; i < items.length; i++) {
        var letter = this._inferOptionLetter(items[i], i) || String.fromCharCode(65 + i);
        if (banned.indexOf(String(letter).toUpperCase()) !== -1) continue;
        allBanned = false;
        picked = String(letter);
        break;
      }
      if (!picked) {
        // 每个选项都被判错过了：再点下去只是重复，直接放弃并冷却。
        emitRuntimeLog('warn', 'popup quiz every option already rejected', {
          reason: reason, banned: banned.slice(0, 6), optionCount: items.length
        });
        this._giveUpPopupQuiz(popup, 'all-options-rejected');
        return false;
      }
      var filled = false;
      try { filled = !!this._fillPopupAnswer(popup, picked, type); } catch (eF) { filled = false; }
      var key = this._popupQuizFingerprint(popup, items);
      if (filled) {
        this._popupQuizSolvedKey = key;
        this._popupQuizSolvedAt = Date.now();
        this._popupQuizBlockedUntil = 0;
        this._popupQuizQuietUntil = Date.now() + scaledMs(POPUP_QUIZ_QUIET_MS);
        this._popupQuizLastFilled = String(picked);
      }
      emitRuntimeLog('warn', 'popup quiz answered locally, no request', {
        reason: reason, picked: picked, filled: filled ? 1 : 0,
        attempt: this._popupQuizAttempts,
        options: items.slice(0, 6).map(this._extractOptionText.bind(this)),
        hint: reason === 'no-stem' ?
          '这个弹窗的容器里只有题型名（例如「判断题」），题干是空的 —— 问了模型也只能瞎猜，' +
          '所以本地选一项，不花钱' : '这一道在本节已经放弃两次，之后只本地作答，不再发请求'
      });
      return filled;
    },


    _checkPopupQuiz: function () {
      var selectors = [
        '.ans-pop-quiz',
        '.pop-quiz',
        '.video-quiz',
        '.ans-job-pop',
        '.ans-topic',
        // .tkTopic / .tkItem：真实视频弹题容器（2026-10-31 从同类开源实现的真实页面知识补入）
        '.tkTopic',
        '.tkItem',
        '.vjs-overlay',
        '.ans-attach',
        '.popDiv',
        '.layui-layer',
        '[class*="pop"][class*="quiz"]',
        '[class*="question"][class*="pop"]'
      ];

      // 投票覆盖层归 `_runChaoxingVoteJob` 独占，弹题扫描不许碰它。
      // 它的形状和弹题一模一样（一段题干 + A/B 两个 radio + 一个「提交」键），
      // 2026-11-11 真页实测两边抢过同一份卷子：日志里
      // `tick progress {note:"vote overlay"}` 紧跟着
      // `popup quiz answered {options:["是","否"], rawAnswer:"A", type:"single"}` ——
      // 投票被弹题链路顺手投掉，投票 runner 只能干等到超时，
      // 完成证据也就落在错的那条链上。
      function isVoteOverlay(node) {
        var hops = 0;
        while (node && node.nodeType === 1 && hops < 4) {
          hops++;
          try {
            if (node.id === 'voteIframe') return true;
            if (node.closest && node.closest('.voteContainer')) return true;
            var owner = node.ownerDocument;
            node = owner && owner.defaultView ? owner.defaultView.frameElement : null;
          } catch (e) {
            return false;
          }
        }
        return false;
      }

      function searchAll(doc, depth) {
        if (!doc || depth > 3) return null;

        for (var i = 0; i < selectors.length; i++) {
          var node = doc.querySelector(selectors[i]);
          if (node && (app._isSubmitConfirmDialog(node) || isVoteOverlay(node))) continue;
          // 播放器容器 / 含 video 的浮层（水印、广告、倍速提示）不是题。
          // .vjs-overlay 这类选择器极易命中视频浮层，误判后插件会把它当题反复问模型。
          if (node && node.querySelector && node.querySelector('video')) continue;
          if (node && visible(node) && textOf(node).length > 5) return node;
        }

        var sections = doc.querySelectorAll('div, section');
        for (var j = 0; j < sections.length; j++) {
          if (!visible(sections[j])) continue;
          if (isVoteOverlay(sections[j])) continue;
          if (sections[j].querySelector && sections[j].querySelector('video')) continue;
          var sectionText = textOf(sections[j]);
          if (sectionText.length > 20 && sectionText.length < 600 && /[A-F][.、．))]/.test(sectionText)) {
            var button = sections[j].querySelector('button, .btn, [class*="submit"], [class*="confirm"], [class*="ans-btn"]');
            // 宽泛兜底必须同时看到"可点的选项"：只有一段像题目的文字 + 一个按钮
            // 不足以证明这是道题，否则课程目录/知识点面板都会被当成弹窗题。
            var optionish = sections[j].querySelector(
              'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], li, label'
            );
            if (button && optionish) return sections[j];
          }
        }

        var frames = doc.querySelectorAll('iframe');
        for (var k = 0; k < frames.length; k++) {
          if (isVoteOverlay(frames[k])) continue;
          try {
            var subDoc = frames[k].contentDocument || (frames[k].contentWindow && frames[k].contentWindow.document);
            var found = searchAll(subDoc, depth + 1);
            if (found) return found;
          } catch (e) {}
        }

        return null;
      }

      try {
        var startDoc = this._getMainDocument() || document;
        var foundNode = searchAll(startDoc, 0) || searchAll(document, 0);
        if (foundNode) {
          // 验证码弹窗可能被误认成弹窗题（layui-layer 是两者的共同容器）：
          // 含"验证码/校验码"字样的一律不当题处理，交给验证码检测
          if (/验证码|校验码/.test(textOf(foundNode))) return null;
        }
        return foundNode;
      } catch (e) {
        return null;
      }
    },


    _handlePopupQuiz: async function (popup) {
      var popupText = textOf(popup);
      if (popupText === '知道了' || popupText === '关闭' || popupText === '确定') {
        popup.click();
        return;
      }

      // 同一道弹题的指纹：弹窗没关就一定是同一道。换题（文本变了）才重新计数。
      var key = this._popupQuizFingerprint(popup);
      if (key === this._popupQuizKey) {
        this._popupQuizAttempts++;
        // 走到这里说明：同一道题、弹窗还在 —— 上一轮填进去的答案没被平台接受，
        // 那就是错的。记下来，本轮带给模型让它换个答案。
        // （只在**确认没通过**时才记，所以不会把「其实答对了、只是弹窗关得慢」的答案误禁。）
        if (this._popupQuizLastFilled) {
          if (!this._popupQuizWrongAnswers) this._popupQuizWrongAnswers = [];
          if (this._popupQuizWrongAnswers.indexOf(this._popupQuizLastFilled) === -1) {
            this._popupQuizWrongAnswers.push(this._popupQuizLastFilled);
          }
          // 特意留一条日志：用户报过"答完弹题就卡住、不知道会不会自己好"，
          // 这条能直接说明"不是卡住，是上一个答案被平台拒了、正在换一个重试"。
          emitRuntimeLog('info', 'popup quiz answer rejected by site, retrying with a different one', {
            attempt: this._popupQuizAttempts,
            rejected: String(this._popupQuizLastFilled).slice(0, 40),
            banned: (this._popupQuizWrongAnswers || []).slice(0, 6)
          });
          this._popupQuizLastFilled = '';
        }
      } else {
        this._popupQuizKey = key;
        this._popupQuizAttempts = 1;
        this._popupQuizWrongAnswers = [];
        this._popupQuizLastFilled = '';
      }

      var maxAttempts = this._getPopupQuizMaxAttempts();
      if (this._popupQuizAttempts > maxAttempts) {
        // 记一笔账：同一道（按选项指纹认）在本节第二次放弃起，后面只本地作答、不再发请求。
        this._notePopupQuizGiveUp(key);
        this._giveUpPopupQuiz(popup, 'attempts-exceeded');
        return;
      }

      if (!this._isQuizApiUnavailable()) {
        var optionItems = this._getOptionItems(popup);
        // 题型不能靠"题干里有没有'正确/判断'这几个字"来猜 ——
        // "下列说法正确的是？"是单选题，却因为含"正确"被判成判断题，
        // 模型随之收到错误的题型并回 true/正确，而选项里根本没有这个文本，
        // 于是一个都匹配不上（这就是"扫描了但从不填空"的另一种形态）。
        // 可靠依据只有两个：控件类型（复选=多选、文本框=填空）和选项文本。
        var type = this._detectPopupQuizType(popup, optionItems);

        // 连线/匹配题：左右两列被一起抓成了「6 个选项」，文本成对重复
        // （日志实测：Color / Transparency / Color / Transparency / …）。
        // 这种题选择题的作答方式永远对不上，旧逻辑会连着问 6 次模型、每次都被判错 ——
        // 用户看到的就是「弹题卡住，刷新后重来还是它」。这里直接判定不可答并跳过。
        var optionTexts = optionItems.map(this._extractOptionText.bind(this));
        if (this._looksLikeMatchingQuiz(optionTexts)) {
          this._giveUpPopupQuiz(popup, 'matching-or-duplicate-options');
          return;
        }

        // ⚠️ 题干必须从**选项所在的那一层**读，不能读 `textOf(popup)`。
        // 现场 2026-11-15 14:17 那一发就是读错了层：容器 `.tkTopic` 里只有
        // 「判断题」这个题型名，选项在兄弟节点，于是发给模型的问题是「判断题」三个字
        // —— 它只能瞎猜，猜错就被平台拒，弹窗留着再问，**每 8 秒一次**。
        var stem = this._popupQuizStem(popup, optionItems);
        var spend = this._popupQuizSpendBucket();

        // 两种情况一律**不发请求**，本地选一项把弹窗点掉：
        //   · 题干是空的（只有题型名）—— 问了也只能瞎猜，那一发是纯浪费；
        //   · 这一道在本节已经放弃两次 —— 继续问就是"每 60 秒再来 4 发"，永不收敛。
        // 让步的是**正确率**，不是**钱**：本地选也可能选错，但一条请求都不花。
        if (!stem) {
          this._answerPopupQuizLocally(popup, optionItems, type, 'no-stem');
          return;
        }
        if (spend.silent[key]) {
          this._answerPopupQuizLocally(popup, optionItems, type, 'gave-up-twice');
          return;
        }

        var question = {
          index: 0,
          type: type,
          title: stem.slice(0, 300),
          options: [],
          // ⚠️ 必须带：不带的话每轮重试都是**一模一样的请求**，模型自然每轮都回
          // 同一个答案（实测表现就是「答错之后一直选 D」），重试等于白问。
          // 普通答题路径一直带着它（见 _requestAnswers），弹题这条路原先漏了。
          previousWrongAnswers: (this._popupQuizWrongAnswers || []).slice()
        };

        question.options = optionTexts.filter(Boolean);

        try {
          // 乱选模式：弹题同样本地生成，**不发请求**（与主流程同源）。
          var result;
          if (this._isRandomAnswerMode()) {
            this._logRandomAnswers([question]);
            result = { success: true, data: [this._buildRandomQuizAnswers([question])[0]] };
          } else {
            result = await bridgeSend('llm_request', { questions: [question] });
          }
          if (result && result.success && result.data) {
            var answer = Array.isArray(result.data) ? result.data[0] : result.data;
            var filled = this._fillPopupAnswer(popup, answer, type);
            if (filled) {
              // 填进去了。此时弹窗多半还挂在 DOM 上（站点异步关闭），
              // 记下指纹让 _activePopupBlock 把它当"已处理"放行，
              // 否则下一轮 tick 会把同一道题再问一遍模型。
              this._popupQuizSolvedKey = key;
              this._popupQuizSolvedAt = Date.now();
              // ⚠️ 这里**原先还归零过 `_popupQuizAttempts`**，那一句话把安全阀整个拆了：
              // 填进去 ≠ 平台接受了。平台拒了的话下一拍走的是「同一指纹」那条支路，
              // 从 0 加到 1 —— 于是计数永远在 0/1 之间跳，`attempts > 3` 永不成立，
              // `_giveUpPopupQuiz`（以及它设的 60 秒冷却）从来没被调用过。
              // 现场读数就是铁证：`attempt` 恒为 1、`banned` 已涨到 ["A","B"]、
              // 每 8~9 秒一问（那个 8 秒正是静默期），2026-11-15 连量到二十多轮。
              // 计数只在**弹窗真的没了**时由 `_activePopupBlock` 清零，那才是"这道过去了"。
              this._popupQuizBlockedUntil = 0;
              // 把「模型答了什么 + 实际匹配到哪个选项 + 选项原文」打进日志。
              // 现场报过「四个选项的题正确答案是 A，却一直选 D」，光看代码猜不出来 ——
              // 这条日志就是为了下次复现时能直接看出是模型答错还是匹配错。
              emitRuntimeLog('info', 'popup quiz answered', {
                attempt: this._popupQuizAttempts,
                rawAnswer: String(this._normalizeAnswerValue(answer) || '').slice(0, 60),
                type: type,
                optionCount: question.options.length,
                options: question.options.slice(0, 6),
                // 告诉看日志的人"接下来会静一会儿，不是卡死"
                waitMs: scaledMs(POPUP_QUIZ_QUIET_MS)
              });
              // 记下这轮填的答案。下一轮如果同一道题还在，就说明它没被接受。
              this._popupQuizLastFilled = String(this._normalizeAnswerValue(answer) || '');
              // 静默 8 秒：给站点足够时间收走弹窗。这段时间内哪怕指纹变了也不碰它，
              // 否则站点重绘 → 指纹变 → 重问重填 → 选项闪烁，就是这么来的。
              this._popupQuizQuietUntil = Date.now() + 8000;
              return;
            }
            // 模型答了但匹配不到任何选项：这是"空转"的真正成因，
            // 必须把选项结构打进日志，否则只能靠猜
            if (Date.now() - (this._popupQuizLogAt || 0) > 5000) {
              this._popupQuizLogAt = Date.now();
              emitRuntimeLog('error', 'popup quiz answer matched no option', {
                attempt: this._popupQuizAttempts,
                maxAttempts: maxAttempts,
                answer: String(this._normalizeAnswerValue(answer) || '').slice(0, 80),
                options: this._describePopupQuiz(popup, optionItems)
              });
            }
            return;
          }
          if (result && result.parseError) {
            emitRuntimeLog('warn', 'popup quiz llm parse failed, keep popup for retry', {
              error: String(result.error || '').slice(0, 160)
            });
            this._setQuizForceSkip(8000);
            return;
          }
          if (result && result.permanentError) {
            // 与 _handleQuiz 同源：4xx 是配置问题，不是网络问题。
            // 标记"连接失败"会让弹题也挤进 45 秒退避，用户同样只看到插件卡住。
            // 这里改走"放弃这道弹题"：关掉弹窗 + 冷却 60 秒，
            // 既不会拿坏 Key 反复去撞接口，也不把课程卡在这里。
            emitRuntimeLog('error', 'popup quiz llm rejected permanently, no retry', {
              error: String(result.error || '').slice(0, 200)
            });
            this._quizApiLastError = String(result.error || '').slice(0, 300);
            this._giveUpPopupQuiz(popup, 'llm-permanent-error');
            return;
          }
          this._markQuizApiConnectionFailed(result && result.error ? result.error : '弹窗题 LLM 请求失败');
        } catch (e) {
          this._markQuizApiConnectionFailed(e);
        }
      }

      emitRuntimeLog('warn', 'skip popup quiz because api unavailable', { reason: this._getQuizApiUnavailableReason() || 'llm-request-failed' });
      var closeButton = this._findDialogButtonByText(popup, ['跳过', '关闭', '取消', '知道了']);
      if (closeButton) {
        try { closeButton.click(); } catch (e2) {}
        return;
      }
      this._skipQuizForApiUnavailable(null, null);
    },


    /**
     * 放弃这道弹题。
     *
     * 只能放弃"继续问模型"，不能放弃"让课程继续"—— 所以顺序是：
     * 先把弹窗本身关掉（跳过/关闭），关不掉就进入冷却期，让 tick 不再拦住播放与跳章。
     * 冷却是 60 秒而不是永久：万一弹窗其实是可答的（比如只是模型抽风），还能再试。
     */
    _giveUpPopupQuiz: function (popup, reason) {
      emitRuntimeLog('error', 'popup quiz unanswerable, stop asking model', {
        reason: reason || 'unknown',
        attempts: this._popupQuizAttempts,
        snapshot: this._describePopupQuiz(popup)
      });

      var closeButton = this._findDialogButtonByText(popup, ['跳过', '关闭', '取消', '知道了', '下次再说']);
      if (closeButton) {
        try { closeButton.click(); } catch (e) {}
      }

      this._popupQuizKey = '';
      this._popupQuizAttempts = 0;
      this._popupQuizWrongAnswers = [];
      this._popupQuizLastFilled = '';
      this._popupQuizQuietUntil = 0;
      // 连线/匹配题不是「这轮运气不好」，下次遇到还是同一套，静默久一点（30 分钟），
      // 别让它在同一个视频里每 60 秒重问一遍模型。其余原因维持 1 分钟。
      this._popupQuizBlockedUntil = Date.now() +
        (reason === 'matching-or-duplicate-options' ? 30 * 60000 : 60000);
    },


    /**
     * 判断是不是「连线/匹配题被拆成了普通选项」。
     * 依据：选项文本成对重复（至少两组）。单选题不会给出两个一模一样的选项，
     * 出现重复基本只有一种可能 —— 左右两列被同一个选择器一起抓了。
     */
    _looksLikeMatchingQuiz: function (texts) {
      if (!texts || texts.length < 4) return false;
      var seen = Object.create(null);
      var dup = 0;
      for (var i = 0; i < texts.length; i++) {
        var key = String(texts[i] == null ? '' : texts[i]).trim().toLowerCase();
        if (!key) continue;
        if (seen[key]) dup++;
        else seen[key] = 1;
      }
      return dup >= 2;
    },


    /**
     * 弹窗题的题型判定。
     * 先按控件形态走 _detectQuestionType，再对"判断题"做一次选项校验：
     * 真判断题的选项必然是"正确/错误"这类两两对立的表述，
     * 只看题干关键字（含"正确"二字）会把普通单选题误判成判断题。
     */
    _detectPopupQuizType: function (popup, optionItems) {
      var type = this._detectQuestionType(popup);
      if (type !== 'judge') return type;
      var texts = (optionItems || []).map(this._extractOptionText.bind(this));
      var looksJudge = texts.length === 2 && texts.every(function (t) {
        return /^(正确|错误|對|錯|错|对|是|否|true|false|t|f)$/i.test(String(t || '').trim());
      });
      return looksJudge ? 'judge' : 'single';
    },


    /**
     * 返回是否真的选中了至少一个选项（没选中就不该点提交）。
     *
     * ⚠️ 选项的匹配与点选一律走 `_applyChoiceAnswer`，**不要再在这里写一份**。
     * 原先这里自己写了一套，与章节小测的 `_fillMultiChoice` 规则不同 ——
     * 它没有 "AC" → ["A","C"] 的拆分，模型只要回一个不带分隔符的连写字母，
     * 就一个选项都匹配不上（"扫到了题却从不填"），或者只中第一个字母
     * （多选只选一个 → 站点判错 → 反复重试 → 用户看到的"一直选不对"）。
     */
    _fillPopupAnswer: function (popup, answer, type) {
      var value = this._normalizeAnswerValue(answer);
      var selected = this._applyChoiceAnswer(popup, value, type || '');

      // 视频里弹出的也可能是填空题：没有选项可点，但一定有输入框。
      // 少了这一段，填空题会被当成"匹配不到选项"而反复重试直到放弃。
      if (!selected) {
        var hasTextInput = !!popup.querySelector('input[type="text"], input:not([type])');
        var hasTextarea = !!popup.querySelector('textarea');
        if (hasTextInput || hasTextarea) {
          if (hasTextInput) this._fillText(popup, value);
          if (hasTextarea) this._fillTextarea(popup, value);
          selected = 1;
        }
      }

      if (!selected) return false;

      // 空答点提交没有任何意义：站点只会回一句"请选择答案"，弹窗原地不动，
      // 于是下一轮再来一次 —— 空转就是这么来的。
      var submit = this._findDialogButtonByText(popup, ['提交', '确定', '确认', '交卷', '完成'])
        || popup.querySelector('button, .btn, [class*="submit"], [class*="confirm"]');
      if (submit) {
        try { submit.click(); } catch (e) {}
      }
      return true;
    },
