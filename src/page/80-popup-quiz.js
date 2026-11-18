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
 * 本段的方法（46 个）：
 *   _findContinueStudyButton、_tryContinueStudyPrompt、_activePopupBlock、
 *   _popupQuizBlocksPlayback、_popupQuizFingerprint、_getPopupQuizMaxAttempts、
 *   _checkPopupQuiz、_popupQuizSiteVerdict、_popupQuizSpanVisible、_clickPopupContinue、
 *   _handlePopupQuiz、_giveUpPopupQuiz、_detectPopupQuizType、
 *   _looksLikeMatchingQuiz、_fillPopupAnswer、_popupQuestionBlock、_popupQuizStem、
 *   _stemIsOnlyOptions、_popupQuizSpendBucket、_notePopupQuizGiveUp、_popupQuizAskBudget、
 *   _takePopupQuizAsk、_popupQuizStemMark、_popupQuizRejectKey、_popupQuizScopedFlag、
 *   _popupQuizRejectKeyBound、_popupQuizBindIfFresh、_popupQuizScopedFlagBound、
 *   _popupQuizEmptyShellPass、
 *   _popupQuizInstallNetLedger、_popupQuizUrlParam、_popupQuizSiteRightNote、
 *   _popupQuizSiteRightPeek、_popupQuizSiteRightKnown、_popupQuizSiteRightUse、
 *   _popupQuizTrySiteRightAnswer、
 *   _notePopupQuizRejected、_popupQuizRejectBySite、_popupQuizLetterGroup、
 *   _popupQuizFilledLetter、
 *   _notePopupQuizFilled、_notePopupQuizPaid、_popupQuizPaidAnswer、
 *   _popupQuizRecheckRejected、_answerPopupQuizLocally、_popupQuizLocalCombo
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
        this._popupQuizSpend = {
          job: job, gives: Object.create(null), silent: Object.create(null),
          asks: Object.create(null), rejected: Object.create(null),
          // 批次 83：`rejected` 是**两种证据混在一起**的那本账 —— 站点判决当场说「回答错误」
          // 是一类，「弹窗被收走又带同一指纹回来」由我们推断是另一类（`_popupQuizRecheckRejected`）。
          // 后者可以推断出"这一发没过去"，但**不够格免掉一次付费询问**：推断错了只是少花一发，
          // 判对方向错了就是把正确答案永久点不回去。所以要另存一本只收前者那类的账，
          // 「候选削到一个就不问了」那一步只读它（见 `_popupQuizRejectBySite`）。
          rejectedSite: Object.create(null),
          filled: Object.create(null),
          // 批次 78：站点**自己回包说「这个字母是对的」**的那一格。
          // 它存在的理由：判决槽（#spanHas）在站点每答一次就重绘的那一族里根本读不到，
          // 而"这一道平台已经判对了"这件事必须有地方活过那一拍，否则
          // 「弹窗收走又带同一指纹回来」只能被读成"被拒"，把正确字母永久拉黑。
          siteRight: Object.create(null),
          paid: Object.create(null),
          // 批次 81：「容器还在、里面一道选项都没有」这一拍**第一次**看见的时刻。
          // 用它把"等一拍拍 DOM 重绘回来"做成**有尽头**的等待（见 `_popupQuizEmptyShellPass`），
          // 而不是旧写法那样第一眼就当"这道不可答"放弃 + 冷却 60 秒。
          // 记在账本上（按任务点作废），不新开一个全局状态字段。
          emptyShell: null,
          // 批次 155：「站点已收下、放行」那条 info 同一道题只说一次 —— 弹窗一直挂着时
          // 静默期（8 秒）一过这一拍就会原样再进来一遍，账本（filled / siteRight）都在，
          // 同一句话每 8 秒刷一条，把 200 条日志环刷空。只圈住说话那一发，
          // 放行动作（清冷却 / 开静默 / 点「继续」）照旧每拍都做。
          releaseSaid: Object.create(null)
        };
      }
      return this._popupQuizSpend;
    },


    /**
     * 记一笔「这一道又放弃了一次」，并回答**还要不要为它花钱**。
     * 第二次放弃起进入静音名单：之后一律本地作答，一条请求都不发。
     *
     * ⚠️ 批次 83：这一格按**哪一道题**记（调用方给的是 `_popupQuizRejectKey` 那把尺），
     * 不按「对/错」这一族选项记。理由是批次 77 已经验证过的那一件事：
     * 判断题的选项指纹永远是同一串，名单按族记会把上一道判错的字母算到这一道头上 ——
     * 而「这道放弃过两次」同样是**这一道题**的账：把上一道考砸了的事实静音掉后面那些
     * 真能答的判断题，省的是钱，赔的是一整节的正确率。
     * ⚠️ 只有 `asks`（发请求的总数封顶）留在粗指纹上：那是批次 72 立的**每节每族**预算，
     *    它管的是"这一族选项在本节最多花 2×上限 发"，与"具体哪道题考砸了"无关。
     *
     * `scoped` 只用来把"这一格按哪把尺记的"打进日志（现场要能分开这两件事）。
     */
    _notePopupQuizGiveUp: function (rkey, scoped) {
      var bucket = this._popupQuizSpendBucket();
      var gives = Number(bucket.gives[rkey]) || 0;
      // ⚠️ 批次 83：进了静音名单之后**不再往上加**。这一格只服务一个判断 —— 到 2 次就静音，
      // 之后每拍仍然会走到「放弃」（弹窗挂着、冷却一过就重来），继续加只会把它读成
      // 「这道已经放弃 42 次」（批次 83 定向实测），而那句话没有任何下一层含义，
      // 现场还会据此以为仍在一次次重试、花钱没停。
      if (bucket.silent[rkey]) return { gives: gives, silent: true };
      gives++;
      bucket.gives[rkey] = gives;
      var wasSilent = !!bucket.silent[rkey];
      if (gives >= 2) bucket.silent[rkey] = 'gave-up-twice';
      if (!wasSilent && bucket.silent[rkey]) {
        emitRuntimeLog('warn', 'popup quiz stops asking the model for this one', {
          reason: 'gave-up-twice',
          gives: gives,
          // ⚠️ 名单那一格是批次 77 才收窄的，钱那一格没有 —— 日志必须说清这一格记在哪个键上，
          // 否则「上一道的放弃会不会管到这一道」这件事在现场读起来又是一次猜。
          scoped: Number(scoped) || 0,
          fingerprint: String(rkey).slice(0, 80),
          hint: '这一道（按选项指纹 + 题干认）在本节已经放弃两次 —— 从现在起本地选一个不花钱的答案，' +
            '不再问模型。代价是它可能选错；好处是钱停在 2×上限 次以内，而不是每 8 秒一次'
        });
      }
      return { gives: gives, silent: !!bucket.silent[rkey] };
    },


    /**
     * 这一道（按选项指纹认）在本节**还能不能再发请求** —— 封顶记在账本上，不记在弹窗上。
     *
     * ⚠️ 为什么上一批那把 `attempts` 的尺不够（读代码就能定死，不靠现场猜）：
     * `_activePopupBlock` 在 `_checkPopupQuiz()` 拿不到弹窗时把 `_popupQuizKey`
     * 与 `_popupQuizAttempts` **一起清空** —— 那一句的本意是"这道过去了，下一道重新给满次数"。
     * 可站点有一族形状是**答完就把弹窗收走、下一拍带着同一道题再弹回来**：
     * 收走 = 清空，弹回 = 走"当作新题"那一支（`attempts` 重新从 1 数），
     * 于是 `attempts > 上限` 依旧永远不成立，`_notePopupQuizGiveUp` 一次都不会被调用。
     * 上一批摘掉"填成功就归零"只堵了**另一条**清零路，这一条是站点自己的形状，堵不掉。
     *
     * （现场 2026-11-15 15:14 那串 `answered {attempt:0}` ↔ `rejected by site {attempt:1}`
     *  轮流出现的读数**不能**当这族的证据 —— 事后核对，那台浏览器跑的仍是上一批之前的构建，
     *  那正是上一批已经修掉的归零 bug。这一族的证据只有上面那段代码路径。）
     *
     * 判据换成**发过几发**：每发请求前从账本里取一格，取满（默认 2×上限 = 6 发）
     * 就进静音名单，之后这一道一律本地作答。账本按 `_activeJobId` 分桶，
     * **不随弹窗生命周期走** —— 弹窗消失、重开、甚至整节重进都还在。
     *
     * 为什么正好是 2×上限：`attempts` 那把尺**能用**的形状里，第一次放弃花掉上限次请求、
     * 第二次放弃再花掉上限次，`gives>=2` 进静音名单 —— 总数本来就是 2×上限。
     * 这一格只是把同一个预算搬到**尺失效**的那一族形状上，没有多给一分钱。
     */
    _popupQuizAskBudget: function (key) {
      var bucket = this._popupQuizSpendBucket();
      var cap = Math.max(1, this._getPopupQuizMaxAttempts()) * 2;
      var asks = Number(bucket.asks[key]) || 0;
      if (asks < cap) return { allowed: true, asks: asks, cap: cap };
      var wasSilent = !!bucket.silent[key];
      // 静音名单里存的是**进名单的原因**（不是 1）—— 本地作答那条日志要点名到底是
      // "放弃过两次"还是"这一节发满了"，靠调用顺序猜会猜错：71 那一族里先由放弃进名单、
      // 之后每一拍都已经过预算，顺序判据会把它们全说成 ask-cap。
      // 已有原因时**不覆盖**：先到的那个才是这道真正放手的那一刻。
      if (!wasSilent) bucket.silent[key] = 'ask-cap';
      if (!wasSilent) {
        emitRuntimeLog('warn', 'popup quiz stops asking the model for this one', {
          reason: 'ask-cap',
          asks: asks,
          cap: cap,
          fingerprint: String(key).slice(0, 80),
          hint: '这一道（按选项指纹认）在本节已经发过 ' + asks + ' 发请求 —— 到顶了，' +
            '之后本地选一个不花钱的答案，不再问模型。弹窗每轮被站点收走又弹回来，' +
            '所以这笔账记在任务点上、不记在弹窗上'
        });
      }
      return { allowed: false, asks: asks, cap: cap };
    },


    /**
     * 取一格额度（**真的发请求之前**调用）。与 `_popupQuizAskBudget` 分开写，
     * 是为了让"乱选模式不发请求"那一支不许消耗额度 —— 它在下面自己 return。
     */
    _takePopupQuizAsk: function (key) {
      var bucket = this._popupQuizSpendBucket();
      var asks = (Number(bucket.asks[key]) || 0) + 1;
      bucket.asks[key] = asks;
      return asks;
    },


    /**
     * 题干的**可比对形态** —— 剥掉站点在答错后追加的反馈短语、所有空白与标点。
     *
     * ⚠️ 为什么必须有它：站点的反馈（「回答错误，请重新作答」）就长在题干那一块里，
     *    拿原文比会每轮都不相等，"是不是同一道题"这个问题就只能靠猜。
     *    与 `_popupQuizFingerprint` 里那份短语表是同一族，两处要改一起改。
     * ⚠️ **标点也必须剥，只剥空白不够**：站点那句反馈中间那个「，」不是空白。
     *    上一版留下的就是这一个字符 —— 纯反馈短语因此 mark 非空，被当成"有题干"，
     *    于是 `scoped` 那格说「只算这一道题」，实际名单却按粗指纹那一尺在走（钱也按那一尺封顶）。
     *    判据要的是**有没有题目本身的文字**，不是一个孤零零的逗号。
     */
    _popupQuizStemMark: function (stem) {
      return String(stem || '')
        .replace(/回答错误|答案错误|请重新作答|重新作答|再试一次|不正确|提交失败/g, '')
        .replace(/[\s　.,;:!?\u3001\u3002\u300C\u300D\u300E\u300F\u00B7\u2026\u2014\u201C\u201D\u2018\u2019"'()\uFF08\uFF09\[\]\u3010\u3011<>\u300A\u300B\/\\+\-*_=^%$#@&|~\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\uFF0E]/g, '')
        .slice(0, 120);
    },


    /**
     * **拉黑专用的键**（批次 77）：粗指纹 + 题干可比对形态。
     *
     * 为什么必须有它（现场 2026-11-16 10:33，两道题一起给的证据）：
     *   · `_popupQuizFingerprint` 只看**选项文本**，而一个视频里判断题的选项永远是「对 / 错」；
     *   · net 抓包：`eventid=2055152 …answerContent=A` → 站点回 `"isRight":true`（A 是对的），
     *     而日志 `popup quiz unanswerable {banned:["A","B"],reason:"attempts-exceeded"}`
     *     的快照题干是「西方炼金术认为金属都是活的有机体…」—— **另一道**判断题；
     *   · 于是 A 是被**上一道**拉黑的，这一道连一次都没答过就已经「每个选项都被判错过了」，
     *     本地作答无可选 → `all-options-rejected` → 60 秒冷却 → 视频永远停在它上面。
     *   · 同一族里更狠的一格：`{banned:["A","B"]}` 还被当作 `previousWrongAnswers` 发给模型，
     *     两个字母都"错"、只有两个字母，它只能回同一个 B，**每发一次钱都被平台判错一次**。
     *
     * ⚠️ **花钱的尺一把没动**：`asks` / `silent` / `gives` / `filled` / `paid` 全部留在
     *    粗指纹上。批次 72 那条让步（「宁可少答，也不能每 8 秒问一次」）依赖的正是
     *    "选项相同就共用一份额度"；只收窄黑名单不会多花一分钱，这一点由 e2e 的
     *    「收窄后仍零请求」那条断言钉着。
     *
     * 题干读不到时（现场那种容器里只有题型名）**退回粗指纹** —— 那一族本来就只能本地瞎选，
     * 没有更细的身份可用，行为与批次 72 完全一致。
     */
    _popupQuizRejectKey: function (key, stem) {
      var mark = this._popupQuizStemMark(stem);
      return mark ? (String(key || '') + '|s|' + mark) : String(key || '');
    },


    /**
     * 日志里那一格 `scoped` 到底在说什么 —— 批次 77 的取证的**归因通道**，必须与
     * 记账用的那把尺同一个来源，不许各读各的。
     *
     * ⚠️ 判据是 `_popupQuizStemMark(stem)` 非空，**不是** `stem` 非空。
     * 现场答错之后站点把那一句「回答错误，请重新作答」接在选项同一块里，
     * 于是 `stem` 读回来是一串非空、可 `_popupQuizStemMark` 把这句剥掉之后什么都不剩 ——
     * 那种时候名单落在**粗指纹**上（`_popupQuizRejectKey` 走的就是没有 `|s|` 的那一支），
     * 而按 `stem` 打出来的日志会说 scoped:1「只算这一道题」，现场就被这条日志带偏了。
     */
    _popupQuizScopedFlag: function (stem) {
      return this._popupQuizStemMark(stem) ? 1 : 0;
    },


    /**
     * **题干那一格被站点摘掉时，从我们自己那张便条把细键拿回来** —— 批次 81。
     *
     * 为什么必须有它（现场 2026-11-16 17:0x，eventid 2055185 / 2055186 / 2055187 三轮同形）：
     *   · 站点把答案收下那一刻会把装题干与选项的那一层整个摘掉，容器里只剩题型名 ——
     *     现场读回来的 html 是 `<div class="tkTopic"><div class="tkTopic_title">判断题</div></div>`；
     *   · 于是下一拍 `_popupQuizStem()` 拿到空串 → `_popupQuizRejectKey` 退回**粗指纹** →
     *     而「平台判对了哪个字母」记在**细键**那一格上 → 读回来是 `siteRight:""`、`banned:[]`；
     *   · 表现就是同三秒里两句话互相打脸：上一拍 `reused site-confirmed answer`（scoped:1，
     *     明明白白知道 A 是平台判对的），下一拍 `unanswerable`（scoped:0，说什么都不知道），
     *     然后**记一笔放弃 + 60 秒静音** —— 平台已经判对的那一道白占住视频一分钟。
     *
     * 依据用 `_popupQuizFilledBind`（批次 78 就在填答那一刻留下的那张**原始题干**便条），
     * 而不是账本里存好的 mark：这一把尺必须与 `_popupQuizSiteRightNote` **写入时**算的那一把
     * 同源（它用的就是 `bind.key` + `bind.stem`），两边各读一份就会互漂。
     *
     * ⚠️ 三个条件缺一个就退回粗指纹，行为与批次 77 完全一致：
     *   1. 便条上的粗指纹与这一拍的粗指纹**同一个**（否则这是另一道选项相同的题 ——
     *      而"选项被摘掉的那一拍"根本对不上，见下面 `_popupQuizBindIfFresh` 头上那段，
     *      那一族由 `_popupQuizEmptyShellPass` 直接问便条）；
     *   2. 便条还新鲜（与 `_popupQuizSiteRightNote` 的 3 分钟同一把尺）；
     *   3. 便条那道题干的 mark 非空（否则压根没有更细的身份可用）。
     * ⚠️ **花钱的那把尺一把没动**：`asks` 仍按粗指纹封顶 2×上限；`gives` / `silent`
     *    按题记本来就是批次 83 立的口径，这里只是让"题干被摘掉的那一拍"也认得是哪一道。
     */
    _popupQuizRejectKeyBound: function (key, stem) {
      if (this._popupQuizStemMark(stem)) return this._popupQuizRejectKey(key, stem);
      var b = this._popupQuizBindIfFresh();
      if (b && b.key === String(key || '')) return b.rkey;
      return String(key || '');
    },


    /**
     * 「最近一次填答」那张便条还**能不能当身份用** —— 批次 81 的唯一读取口。
     *
     * 为什么必须有它，而不直接在调用方读 `_popupQuizFilledBind`：这张便条是**全局一格**，
     * 而它的有效期是站点回包那条链定的（`_popupQuizSiteRightNote`：`Date.now() - bind.at > 180000`
     * 就不认）。读取口只有一处，两边才不会一把尺松、一把尺紧。
     *
     * ⚠️ 关键一点：**弹窗塌成空壳的那一拍，粗指纹自己也变了**。
     * `_popupQuizFingerprint` 有选项时走 `cls|o|<选项文本>`、一个选项都没有时退回
     * `cls|t|<整块文本剥掉反馈语>`（现场就是 `tkTopic|o|对\u0001错` → `tkTopic|t|判断题`）。
     * 所以"这一拍的空壳是不是便条上那一道"**不能用粗指纹相等来问** —— 只能问便条自己，
     * 再用能读回来的那一格（题型）做反证。这就是本函数把 `rkey` 与 `type` 一起交出去的原因。
     */
    _popupQuizBindIfFresh: function () {
      var b = this._popupQuizFilledBind;
      if (!b || !b.key) return null;
      var at = Number(b.at) || 0;
      if (!at || Date.now() - at > 180000) return null;
      var mark = this._popupQuizStemMark(b.stem);
      if (!mark) return null;
      return {
        key: String(b.key),
        rkey: this._popupQuizRejectKey(b.key, b.stem),
        letter: String(b.letter || ''),
        cls: String(b.key || '').split('|')[0],
        at: at
      };
    },


    /**
     * 与 `_popupQuizRejectKeyBound` **同一把尺**的归因通道：`scoped` 说的是
     * 「名单/这一格记在哪把尺上」，所以它必须由那把尺自己回答，不许再看题干串非空。
     * 细键真的生效了才报 1 —— 这样现场读到的 scoped 与账本落点不会分家（批次 77 立的规矩）。
     */
    _popupQuizScopedFlagBound: function (key, stem) {
      return this._popupQuizRejectKeyBound(key, stem) !== String(key || '') ? 1 : 0;
    },


    /**
     * 装上「**读站点自己的交卷回包**」这本账 —— 批次 78。
     *
     * 为什么判决槽（`#spanHas`）不够用（现场 2026-11-16 用网络记账本量出来的）：
     *   · 站点每答一次就把弹窗**收走/重绘**，下一拍我们再看那三句话全是 `display:none`，
     *     于是 `_popupQuizSiteVerdict()` 只能报 `''`（读不准）→ 走旧推断「弹窗还在 = 被拒」；
     *   · 而站点自己那一发 `GET /mooc-ans/question/quiz-validation?…&eventid=…&answerContent=A`
     *     的回包写得清清楚楚：`{"msg":"通过","isRight":true}` —— 同一个字母，现场读数
     *     `eventid=2055152 …answerContent=A isRight=true`，紧跟着 `eventid` 同一发的 B 是 `false`。
     *   · 于是「平台刚判对的那个字母」被我们记进已拒名单，A、B 一先一后全进去 →
     *     `all-options-rejected` → 60 秒冷却 → **视频永久停在这道判断题上**。
     *   · ⚠️ 弹窗 DOM 上**根本没有 eventid**（`.workbuddy/b78-eid-probe.expr` 递归走遍同域帧、
     *     `Ext.ComponentQuery`、window 全局、隐藏 input 五路都摘不到），只有网络那一发带着它。
     *     所以"这一发回包属于哪一道题"必须**在我们自己填答案那一刻**绑定（见 `_notePopupQuizFilled`
     *     打的 `_popupQuizFilledBind`），不能指望从回包或 DOM 里现读。
     *
     * 只挂钩子、不改站点的那一发：`open`/`send`/`fetch` 全部原样转发，回包只**旁听**。
     *
     * ⚠️ 挂在**哪一层**是批次 79 修的第二个 bug，别改回只挂顶层。
     * 现场 2026-11-16 用 `.workbuddy/b79-who.cjs` 逐帧量出来：
     *   `发在 [/0/0] /ananas/modules/video/index.html  批次78钩子在这一层=没有  记录器钩子=有
     *    eventid=2616437  站点收到=B  isRight=false  这一层.tkTopic=1`
     * 也就是**弹窗、站点那一发 XHR、我们该记的那本账全在视频帧里**，而顶层是刷课壳页。
     * 钩子挂在顶层 window 上 = 现场一条回包都旁听不到 → `siteRight` 永远是空的 →
     * 批次 78 那本账在沙盒里全绿（弹窗与 XHR 同在一个 document），在真站上等于没装。
     * 所以 `win` 传的是**弹窗自己那一帧**的 window（`popup.ownerDocument.defaultView`）；
     * 弹题在顶层文档的那一族，`defaultView` 就是 `window`，同一支代码两边都覆盖。
     *
     * 幂等**按窗口**判，不按"本 app 装过一次"判：一节课里视频帧会被重建成好几个 window，
     * 每一层各挂一次（同层重复调用被 `__omitoneQuizNet` 标记挡住）。
     * 仍然只在真的处理过弹题的帧里挂 —— 没弹过题的页面一条钩子都不装。
     */
    _popupQuizInstallNetLedger: function (win) {
      var target = null;
      try { target = (win && win.XMLHttpRequest) ? win : null; } catch (eW) { target = null; }
      if (!target) { try { target = window; } catch (eT) { target = null; } }
      if (!target) return;
      var self = this;
      var MARK = 'quiz-validation';
      // 「至少有一层的钩子真的在位」—— 诊断与 e2e 读这一格；它不许在什么都没挂时被写成 1。
      var hooked = 0;

      // 回包只旁听：任何一步抛错都不许影响到站点那一发本身
      var listen = function (url, pack) {
        try { self._popupQuizSiteRightNote(url, pack); } catch (e) {}
      };
      var bindOf = function () {
        try { return self._popupQuizFilledBind || null; } catch (e) { return null; }
      };

      try {
        var proto = target.XMLHttpRequest && target.XMLHttpRequest.prototype;
        if (proto) {
          if (proto.__omitoneQuizNet) hooked = 1;
          else {
            proto.__omitoneQuizNet = 1;
            hooked = 1;
            var oOpen = proto.open;
            var oSend = proto.send;
            proto.open = function (method, url) {
              try { this.__omitoneQuizUrl = String(url == null ? '' : url); } catch (eU) {}
              return oOpen.apply(this, arguments);
            };
            proto.send = function () {
              try {
                var u = String(this.__omitoneQuizUrl || '');
                if (u.indexOf(MARK) !== -1) {
                  var xhr = this;
                  // 绑定在 **load 那一刻**取，不在 send 那一刻：填答案 → 点提交 → send 是同一拍里
                  // 同步发生的，而 `_popupQuizFilledBind` 要等 `_fillPopupAnswer` 返回之后才打上
                  // （差几微秒）。在 send 那刻读到的是**上一发**的绑定，第一发则是 null ——
                  // 整本账永远记不上，而这一步没有任何报错。
                  // 站点回包最快也几十毫秒，下一拍是 8 秒之后，所以 load 时刻读到的就是这一发；
                  // ⚠️ 剩下的错位在 `_popupQuizSiteRightNote` 里按**内容**对齐（URL 的 answerContent
                  //    必须等于绑定里我们刚点中的那个字母），不靠猜时间。
                  xhr.addEventListener('load', function () {
                    listen(u, { bind: bindOf(), text: xhr.responseText });
                  });
                }
              } catch (eS) {}
              return oSend.apply(this, arguments);
            };
          }
        }
      } catch (eX) {}

      try {
        var oFetch = target.fetch;
        if (typeof oFetch === 'function') {
          if (oFetch.__omitoneQuizNet) hooked = 1;
          else {
            var wrapped = function (input) {
              var u = '';
              try { u = String((input && input.url) || input || ''); } catch (eU) {}
              var p = oFetch.apply(this, arguments);
              try {
                if (u.indexOf(MARK) !== -1) {
                  // clone() 才能读体：原响应还要交回站点自己用。
                  // 绑定同样在**回包到**那一刻取（理由见上面 XMLHttpRequest 那一段）。
                  p.then(function (res) {
                    try {
                      var b = bindOf();
                      var t = res && typeof res.clone === 'function' ? res.clone().text() : null;
                      if (t && typeof t.then === 'function') {
                        t.then(function (txt) { listen(u, { bind: b, text: txt }); }, function () {});
                      }
                    } catch (eR) {}
                  }, function () {});
                }
              } catch (eP) {}
              return p;
            };
            wrapped.__omitoneQuizNet = 1;
            target.fetch = wrapped;
            hooked = 1;
          }
        }
      } catch (eF) {}

      if (hooked) this._popupQuizNetLedgerOn = 1;
    },


    /**
     * 从 URL 里摘一个查询参数（**不用 `URL`**：跨帧的 base 传错会直接抛，
     * 而这发只是旁听，不值得为它冒任何抛错的险）。
     */
    _popupQuizUrlParam: function (url, name) {
      try {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(url || ''));
        if (!m) return '';
        var v = String(m[1] || '');
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (eD) {}
        return v;
      } catch (e) {
        return '';
      }
    },


    /**
     * 站点回包说「这一发答对了」→ 把**这一发答对的那一组字母**记进 `siteRight` 那一格。
     *
     * ⚠️ 批次 84：单选/判断题那一格是一个字母，多选题是**一组**（站点自己发
     * `answerContent=A,B`）。这一格存的必须是**当时交出去的那一整个组合**，
     * 不能只留第一个字母 —— 否则下一道多选题看见"A 平台判对过"就把 A 单独点上去，
     * 而平台说的从来不是"A 单独算对"，是"A 和它那一组算对"。
     *
     * 三道闸，缺一道都会把"上一道判对的字母"填给下一道题：
     *   1. `isRight` 必须是**真** `true`（`"true"`、缺字段、false 一律不记）；
     *   2. 提交那一刻的绑定必须在（`_popupQuizFilledBind.at` 起 3 分钟内）——
     *      过期绑定属于**上一道**，认了就是跨题串台；
     *   3. 题干必须可比对（`_popupQuizScopedFlag`）—— 读不到题干时身份只剩「对/错」这一族选项，
     *      这一道判对的字母会被当成下一道的答案。那一族本来就只能本地瞎选，
     *      批次 72/77 立的让步在这里同样成立，**不记**。
     *
     * ⚠️ 这一格被两个地方读，各管各的（同一份事实，两把不同的尺）：
     *   · `_popupQuizSiteRightPeek` —— 还能不能**免费**把那个字母填回去（用满 3 次就停）；
     *   · `_popupQuizSiteRightKnown` —— 拉黑那一路的闸，**不看额度**（详那一段的理由）。
     * 站点判 `isRight:false` 的那一发**不记**：那一族的证据已经由判决槽 + "弹窗还在"推断覆盖，
     * 再叠一层拉黑只会把"我们以为被拒"升级成"我们主动拉黑"，那是另一件事，不混在这批。
     */
    _popupQuizSiteRightNote: function (url, pack) {
      var text = pack && pack.text ? String(pack.text) : '';
      if (!text || text.indexOf('isRight') === -1) return;
      var data = null;
      try { data = JSON.parse(text); } catch (eP) { data = null; }
      if (!data || data.isRight !== true) return;
      var b = pack.bind;
      if (!b || !b.key) return;
      var at = Number(b.at) || 0;
      if (!at || Date.now() - at > 180000) return;
      var stem = String(b.stem || '');
      if (!this._popupQuizScopedFlag(stem)) return;
      var rkey = this._popupQuizRejectKey(b.key, stem);
      // 站点 answerContent 发的不一定是一个字母（有的课程发选项原文，多选发的是**一组**
      // 逗号连接的字母）—— 对不上就退回我们自己**实际点中**的那些
      // （`_popupQuizFilledBind.letter` 记的就是它，批次 84 起它同样是规范形的组合）。
      var sent = String(this._popupQuizUrlParam(url, 'answerContent') || '').trim();
      var sentLetter = this._popupQuizLetterGroup(sent);
      var bindLetter = this._popupQuizLetterGroup(b.letter);
      // ⚠️ 内容对齐：回包读到的这一发，URL 上那一组字母必须等于绑定里我们刚点中的那一组。
      //    不等就是**别人**交的这一发（用户自己点提交、上一道的回包晚到、绑定是上一道），
      //    认了等于把"平台判对"安到一道没答过的题上 —— 宁可不记。
      //    （组合两侧都先过 `_popupQuizLetterGroup`，所以"C,A"与"A,C"是同一组 ——
      //     按原序比会把我们刚交出去的那一发读成"别人的"，多选题就永远救不回来。）
      //    （绑定取不到字母、或站点发的是选项原文那一族，只能退回我们自己点中的那一组。）
      if (sentLetter && bindLetter && sentLetter !== bindLetter) return;
      var letter = sentLetter || bindLetter;
      if (!letter) return;
      var bucket = this._popupQuizSpendBucket();
      var prev = bucket.siteRight[rkey];
      emitRuntimeLog('info', 'popup quiz site-confirmed answer recorded', {
        letter: letter,
        eventid: this._popupQuizUrlParam(url, 'eventid').slice(0, 32),
        msg: String(data.msg || '').slice(0, 20),
        // 同一个字母被站点**反复**判对（我们每重填一次它就再回一发）时，那笔「用了几次」
        // 必须累计 —— 否则这条记录被自己刷新成 0，快路就永远用不完、视频可能原地打转。
        uses: (prev && prev.letter === letter) ? (Number(prev.uses) || 0) : 0,
        repeat: prev && prev.letter === letter ? 1 : 0,
        scoped: 1
      });
      bucket.siteRight[rkey] = {
        letter: letter,
        at: Date.now(),
        eid: this._popupQuizUrlParam(url, 'eventid').slice(0, 32),
        uses: (prev && prev.letter === letter) ? (Number(prev.uses) || 0) : 0
      };
    },


    /**
     * 这一道平台判对过哪个字母（纯读，日志归因也用它 —— 不许读一次就少一次额度）。
     *
     * ⚠️ `uses >= 3` 就**当没有**：与 `_popupQuizPaidAnswer` 的「用满 3 次作废」同一把尺。
     * 判对了却还挡在这儿反复重填，说明重填这一步没让它过去 —— **免费重填**这一条路必须停下，
     * 否则视频原地打转（那正是本批要消灭的症状）。停下之后交回老流程，老流程该花钱花钱。
     */
    _popupQuizSiteRightPeek: function (rkey) {
      var rec = this._popupQuizSpendBucket().siteRight[rkey];
      if (!rec || !rec.letter) return '';
      if ((Number(rec.uses) || 0) >= 3) return '';
      return String(rec.letter);
    },


    /**
     * 这个字母**是不是平台判对过的那一个** —— 拉黑那一路唯一的闸（内存名单与账本都读它）。
     *
     * ⚠️ 与 `_popupQuizSiteRightPeek` 差一格，而且是**故意**差的：peek 管"还能不能免费重填"
     *    （用满 3 次就停），这一格管"平台有没有说过它对"。后者是个**事实**，不因额度用满而失效。
     *    把它也套上额度就是批次 78 第一版留的那个口子：额度一到，A 被拉黑 → 本地/付费改点 B →
     *    B 真被判错 → A、B 全在名单里 → `all-options-rejected` → 60 秒冷却 → 视频原地转。
     *    那道口子的代价不是一发钱，是**把平台亲口说对的那个字母永久删出候选**。
     * 唯一的例外由调用方给：站点判决槽当场明说「回答错误」（`verdict==='wrong'`）时照旧拉黑 ——
     * 那是**比这条记录更新、更直接**的证据（回包可能属于晚到的上一发），不能让旧事实挡住新证据。
     */
    _popupQuizSiteRightKnown: function (rkey, letter) {
      var rec = this._popupQuizSpendBucket().siteRight[rkey];
      if (!rec || !rec.letter) return false;
      // 两侧都用 `_popupQuizLetterGroup` 的规范形比（批次 84）：这一格存的是组合，
      // 而调用方递来的字母顺序不一定相同 —— "C,A" 与 "A,C" 是同一发答案，
      // 按原串比就会把平台亲口说对的那一组读成"没说过"，闸门等于没有。
      var mine = this._popupQuizLetterGroup(letter);
      return !!mine && String(rec.letter) === mine;
    },


    /**
     * 靠这条记录**免费填回过一次**就记一次，用满 3 次后 peek 不再给（见 `_popupQuizSiteRightPeek`）。
     *
     * 为什么必须有限：站点判对了而弹窗还留着，说明**填回去这一步没让它过去**
     * （可能压根没点到、可能这一格等的不是这个字母）。无限重刷同一字母 = 视频原地打转。
     *
     * ⚠️ 用满**不删这条记录**：删掉就把"平台说过 A 对"这个事实一起抹了，
     *    于是下一拍拉黑闸门失效（见 `_popupQuizSiteRightKnown` 那段），正是批次 78 第一版的口子。
     *    作废的是"还能不能白拿"，不是"这件事有没有发生过"。
     */
    _popupQuizSiteRightUse: function (rkey) {
      var rec = this._popupQuizSpendBucket().siteRight[rkey];
      if (!rec) return;
      rec.uses = (Number(rec.uses) || 0) + 1;
    },


    /**
     * **不花钱**把平台判对的那个字母填回去。
     *
     * 返回 true = 这一拍已经处理完（填进去了），调用方直接 return。
     * 填不进去（这一族的选项里没这个字母 / `_fillPopupAnswer` 拒了）返回 false，
     * 交回老流程 —— 那一支先看拉黑那道闸（平台判对过的字母不会被拉黑），
     * 所以这里**不**消耗额度：没做到的事不该记账。
     */
    _popupQuizTrySiteRightAnswer: function (popup, optionItems, type, rkey, stem) {
      var letter = this._popupQuizSiteRightPeek(rkey);
      if (!letter) return false;
      var filled = false;
      try { filled = !!this._fillPopupAnswer(popup, letter, type); } catch (eF) { filled = false; }
      if (!filled) return false;
      this._popupQuizSiteRightUse(rkey);
      var key = this._popupQuizFingerprint(popup, optionItems);
      this._popupQuizLastFilled = String(letter);
      this._notePopupQuizFilled(key, letter, stem, type);
      emitRuntimeLog('info', 'popup quiz reused site-confirmed answer, no request', {
        letter: letter,
        // 这一次是这条记录的**第几回**使用（1..3）—— 现场要看得出"还在救"还是"快作废了"
        uses: Number((this._popupQuizSpendBucket().siteRight[rkey] || {}).uses) || 0,
        verdict: this._popupQuizSiteVerdict(popup) || 'unknown',
        scoped: this._popupQuizScopedFlag(stem),
        options: (optionItems || []).slice(0, 6).map(this._extractOptionText.bind(this))
      });
      return true;
    },


    /**
     * 记一笔「这个字母被平台拒了」，记在**不随弹窗消失**的账本上。
     *
     * ⚠️ `rkey` 传的是 `_popupQuizRejectKey()` 那一把**按题收窄**的尺，不是粗指纹：
     *    黑名单跨题串台就是现场「选项相同的两道题里，后一道连答都没答过就已经
     *    A/B 全被判错过」的成因（见 `_popupQuizRejectKey` 那段）。
     *
     * 两个来源（缺一不可，各自对应站点的一种形状）：
     *   1. 弹窗还挂在原地、指纹又走回来 —— 上面那段"同一道题"分支直接看见它被拒；
     *   2. 站点**把弹窗收走了**、下一拍带着同一道题弹回来 —— 那一支走的是"当作新题"，
     *      `_popupQuizLastFilled` 已经被 `_activePopupBlock` 清空，光看弹窗什么也判不出来。
     *      这一族由下面的 `_popupQuizRecheckRejected` 补。
     *
     * ⚠️ 批次 78：**平台自己回包判对过的字母不拉黑**（`_popupQuizSiteRightKnown`）。
     *    现场那一条把视频永久卡死的链就是「站点刚回 `isRight:true`，下一拍弹窗被收走重绘、
     *    判决槽读不出唯一一句 → 我们按推断把它记成被拒」。这一格是**唯一的闸**：
     *    两条来源（原地那一支、recheck 那一支）都从这儿过，各写一份就会互漂。
     *    ⚠️ 这道闸**不跟"免费重填的额度"走**：额度用满只该停掉"白拿"，
     *       不该把平台亲口说对的字母变成候选之外 —— 那正是第一版留的口子（详 `Known` 那段）。
     *    唯一让步：调用方把站点判决当场读成 `wrong` 传进来时照旧拉黑 —— 平台最新那句直接说的话，
     *       比一条旧回包更有资格定性这一发。
     */
    _notePopupQuizRejected: function (rkey, letter, verdict) {
      var bucket = this._popupQuizSpendBucket();
      var list = bucket.rejected[rkey] || (bucket.rejected[rkey] = []);
      var v = String(letter || '');
      if (!v) return list;
      // 批次 84：字母那一族一律先写成**规范形**再入账（`"C,A"` → `"A,C"`）。
      // 这一格是唯一的写入口（原地那一支、账本补记、复用/新发那两道闸都读它），
      // 三个来源各按自己的顺序存，组合比对就永远对不上 —— 与 `_popupQuizSiteRightKnown` 同一理由。
      // 不是字母组合的那一族（选项原文）原样存，让"这一格压根比不中字母"保持可见。
      var grouped = this._popupQuizLetterGroup(v);
      if (grouped) v = grouped;
      // 批次 83：这一笔是**平台当场说的**还是**我们推断的**，两边要分得开。
      // 推断那一类（弹窗被收走又带同一指纹回来）只进 `rejected`；平台判决槽明说
      // 「回答错误」的那一类才同时进 `rejectedSite` —— 后面"候选削到一个就不花钱问模型"
      // 那一步只读后者（理由见 `_popupQuizSpendBucket` 那一格与 `_popupQuizRejectBySite`）。
      var bySite = verdict === 'wrong'
        ? (bucket.rejectedSite[rkey] || (bucket.rejectedSite[rkey] = []))
        : null;
      if (verdict !== 'wrong' && this._popupQuizSiteRightKnown(rkey, v)) {
        emitRuntimeLog('info', 'popup quiz not banning site-confirmed letter', {
          letter: v.slice(0, 8),
          // 名单没变长 —— 现场拿这条与 'retrying with a different one' 对照，
          // 就能分清「平台真判错」与「平台刚判对、我们差点误拉黑」。
          banned: list.slice(0, 6),
          // 站点那一发的题号，从回包账本里读回来的（DOM 上没有这个字段，批次 78 量过）
          eventid: String((bucket.siteRight[rkey] || {}).eid || ''),
          // 这一格名单是**只算这一道题**(1)还是与同选项的别的题共用(0) —— 三条 78 日志都要带，
          // 少一条现场就分不清这条"救回来"的到底算在哪道题上。
          // 这里只有 rkey 没有 stem，而 `|s|` 正是 `_popupQuizRejectKey` 按
          // `_popupQuizStemMark(stem)` 非空才加的标记 —— 同一把尺，不必再读一遍题干。
          scoped: String(rkey || '').indexOf('|s|') !== -1 ? 1 : 0,
          // 这条记录已经被免费重填用过几次 —— 现场要分得开「还在免费救」与「已经改回花钱那一支」
          uses: Number((bucket.siteRight[rkey] || {}).uses) || 0
        });
        return list;
      }
      if (list.indexOf(v) === -1) list.push(v);
      if (bySite && bySite.indexOf(v) === -1) bySite.push(v);
      return list;
    },


    /**
     * 这一道题**被平台当场判错**的字母（纯读）—— 与 `rejected` 的差别只有一件事：
     * 这一本只收站点自己说出口的证据，不收"弹窗被收走又弹回来"那一类推断。
     *
     * ⚠️ 为什么这一格必须单独存在（批次 83，全量 e2e 实测 14 条红顶出来的）：
     * 批次 79-B 那一步「候选削到一个 → 不花钱问模型」读的是**混在一起的** `rejected`。
     * 在真站上那一条读的确实是平台原话（现场四拍里 attempt1/2 都带 `verdict:"wrong"`），
     * 可在"弹窗每轮被站点收走"那一族里，名单里那一格从头到尾只是我们的推断 ——
     * 于是批次 72 立的**付费封顶安全阀**（发满 2×上限才收手）被一道推断提前绕开了：
     * 推断错一次，就把"还能花钱问"变成"免费点掉并且从此不再问"，而日志看着都像省了钱。
     * 省钱的让步要建立在平台说出口的事实上；推断只够用来**挑一个不重复的字母填**
     * （那一步本来就不花钱），不够格免掉一次询问。
     */
    _popupQuizRejectBySite: function (rkey) {
      try {
        var list = this._popupQuizSpendBucket().rejectedSite[rkey];
        return Array.isArray(list) ? list : [];
      } catch (e) {
        return [];
      }
    },


    /**
     * 把「一组选项字母」写成**唯一那一种形状**：大写、去重、按字母序、逗号连接。
     * `"C,A"` → `"A,C"`，`"a"` → `"A"`，`"A,A"` → `"A"`。
     *
     * ⚠️ 为什么必须有它（批次 84）：多选题这一发交出去的是**一个组合**，而组合的
     * 书写顺序有三处各不相同的来源 —— 站点回包按**目录顺序**拼（`checkResult` 自己
     * 就是遍历选项得出的）、模型按**它想到的顺序**给（`["D","B","A"]`）、
     * 我们点选前还会再排一次序（`_normalizeChoiceAnswerValues` 末尾那个 `.sort()`，
     * 因为点选顺序决定隐藏域 `#answer{qid}` 的内容）。三把顺序各自都对，
     * 可一旦拿原串互比，"我们刚交的那一发"就永远不等于"回包里那一发"，
     * 于是批次 78 那道「平台说对的字母不拉黑」闸门形同虚设。
     *
     * 认不出来就交空串，**不猜**：`"TRUE"`（选项原文）拆成字母会变成 E/R/T/U 五个
     * 假选项，所以这里只认「逗号分隔、每格正好一个字母」那一族形状。
     * 拿空串的那一路调用方一律退回旧行为（按我们点中的那一格记账）。
     */
    _popupQuizLetterGroup: function (raw) {
      var parts = String(raw == null ? '' : raw).toUpperCase().split(',');
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var one = parts[i].trim();
        if (!/^[A-Z]$/.test(one)) return '';
        if (out.indexOf(one) === -1) out.push(one);
      }
      if (!out.length) return '';
      return out.sort().join(',');
    },


    /**
     * 这一轮**实际点到了哪些选项**（字母，多选就是规范形的组合 `"A,C"`）。
     *
     * ⚠️ 为什么不能直接记模型的原话：判断题的模型答案是 `true`（或「正确」），
     *    而本地作答的已拒名单比的是 A/B 这种字母 —— 记原话的话这条证据永远对不上，
     *    表现就是"同一道判断题永远选 对、平台每次都拒、还一直付费"。
     *    普通题也一样：模型回「甲」而点到的是 B 时，拉黑「甲」拉不到任何东西。
     *
     * 取字母走的是 `_applyChoiceAnswer` 自己那两步（`_normalizeChoiceAnswerValues`
     * → `_matchOptionItem`），**不在这里另写一份匹配规则**（AGENTS §2 说的"两份规则互漂"），
     * 所以补选（多选低于最少项数）之后的那几项也算得进来。
     *
     * ⚠️ 批次 84：多选题这里**原先只交回第一个字母**，代价不是"少记一个字母"，是
     *    把整组的答案记成了单个字母 —— 于是那一格被当成"平台判对了 A"（`A` 单独算对），
     *    免费重填把 A 一个人点上去、拉黑闸门也只保护 A 一个字母。
     *    现在交回整组：**只匹配得上的那些**，一个都对不上才交空串（调用方自有兜底）。
     */
    _popupQuizFilledLetter: function (popup, optionItems, answer, type) {
      var values = [];
      try { values = this._normalizeChoiceAnswerValues(answer, type || '', popup) || []; } catch (eV) { values = []; }
      if (!values.length) return '';
      var letters = [];
      for (var v = 0; v < values.length; v++) {
        var item = null;
        try { item = this._matchOptionItem(popup, values[v], type); } catch (eM) { item = null; }
        if (!item) continue;
        for (var i = 0; i < optionItems.length; i++) {
          if (optionItems[i] !== item) continue;
          var one = String(this._inferOptionLetter(item, i) || String.fromCharCode(65 + i));
          if (letters.indexOf(one) === -1) letters.push(one);
          break;
        }
      }
      return this._popupQuizLetterGroup(letters.join(','));
    },


    /**
     * 记下「这一道刚填进去的是什么、题干长什么样」—— 记在账本上。
     *
     * 为什么当场不记在 `_popupQuizLastFilled` 上就够了：那一格是**弹窗的生命周期**，
     * 站点把弹窗收走的那一刻 `_activePopupBlock` 就把它清空（那是它对"这道过去了"的理解）。
     * 而"收走又弹回来"恰恰是**没过去**，于是这条证据在需要它的那一刻已经没了 ——
     * 表现是"同一道判断题永远选 A、平台每次都拒、还一直付费"。
     */
    _notePopupQuizFilled: function (key, letter, stem) {
      var bucket = this._popupQuizSpendBucket();
      bucket.filled[key] = {
        letter: String(letter || ''),
        stem: this._popupQuizStemMark(stem)
      };
      // 批次 78：**提交那一刻的"这是哪一道"只有我们自己知道**。
      // 站点回包里带着 eventid，但弹窗 DOM 上没有它（五路探针都摘不到，见 `_popupQuizInstallNetLedger`），
      // 而回包到达时弹窗往往已被收走 —— 所以在这里（每一发填答都过这一格，两个模型填答点
      // 与本地作答点共用）留一张**原始题干**的便条，旁听到回包时拿它算 rkey。
      // ⚠️ 存**未剥过**的 stem，让 `_popupQuizRejectKey` 自己再算一遍 mark：
      //    两处各算一次 mark 就是"两份尺互漂"，而 `_popupQuizSiteRightNote` 与这里
      //    必须算出**同一个** rkey，否则判对的字母会记到另一格上。
      this._popupQuizFilledBind = {
        key: String(key || ''),
        stem: String(stem || ''),
        letter: String(letter || ''),
        cls: String(key || '').split('|')[0],
        at: Date.now()
      };
    },


    /**
     * 记下「这一道**已经花过钱了**、模型回的是什么」—— 记在账本上，不记在弹窗上。
     *
     * ⚠️ 为什么必须有它（现场 2026-11-15 16:55:05 那条自相矛盾的日志逼出来的）：
     * 那一族弹题的外层 `.tkTopic` **一直挂在原地**，而里面装着题干与选项的
     * `.tkTopic_con` 在模型往返的那几秒里被站点**摘掉**、过一会儿再拼回来。
     * 现场读数：`html` 只剩 `<div class="tkTopic"><div class="tkTopic_title">判断题</div></div>`
     * （那是**回包那一刻**现场读的），而 `optionCount:2`、`optionTexts:["对","错"]`
     * （那是**发请求之前**快照的）—— 两半不是同一份 DOM，才会同时出现。
     * 后果不只是日志难看：`_fillPopupAnswer` 每次都从弹窗节点**现场重扫**选项
     * （见 75 片段的 `_matchOptionItem`），那一刻扫到 0 个 → 填不进去 →
     * **这一发的钱已经花了，答案却丢了**；下一拍选项拼回来，同一道题再问一发。
     *
     * 所以：买到的答案先存进账本，等选项真的回来了**直接用它**，不再发第二发。
     * `value` 传空 = 清掉这一格（复用成功、或发现它正是平台已判错的那个字母时走这条）。
     */
    _notePopupQuizPaid: function (key, value, stem) {
      var bucket = this._popupQuizSpendBucket();
      var v = String(value == null ? '' : value).trim().slice(0, 40);
      if (!v) {
        try { delete bucket.paid[key]; } catch (e) { bucket.paid[key] = null; }
        return '';
      }
      var rec = bucket.paid[key] || (bucket.paid[key] = { value: v, stem: '', uses: 0 });
      rec.value = v;
      rec.stem = this._popupQuizStemMark(stem);
      return v;
    },


    /**
     * 取「这一道上一发买到的答案」，**读一次算一次**；题干对不上就不给。
     *
     * ⚠️ 为什么不能只按指纹给：判断题的选项永远是「对 / 错」，同一个视频里连着三道
     * 判断题的指纹**完全相同**（见 `_popupQuizFingerprint` 那段⚠️与 `_popupQuizSpendBucket`
     * 的分桶说明）。只按指纹复用 = 把上一道买来的答案填给下一道 —— 那是拿钱买错题。
     * 两边题干都读不到时两串都是空 → 相等 → 认成同一道，与 `_popupQuizRecheckRejected` 同口径。
     *
     * **用满 3 次还没填进去就作废**（选项一直没拼回来）：不复用作废的话，
     * 每一拍都停在"复用→还是空→失败"里打转，永远走不到本地作答那一步，
     * 弹窗就变成不花钱但**也过不去**的死循环。作废后下一拍回到正常流程，
     * 由 `_popupQuizAskBudget` / 静音名单照常管钱。
     */
    _popupQuizPaidAnswer: function (key, stem) {
      var bucket = this._popupQuizSpendBucket();
      var rec = bucket.paid[key];
      if (!rec || !rec.value) return '';
      // 题干对不上 = 这是**另一道题**（判断题的选项永远是 对/错，指纹分不开它们）。
      // 这一格属于上一道，直接作废 —— 留着只会把上一道的答案填给这一道。
      if (this._popupQuizStemMark(stem) !== String(rec.stem || '')) {
        try { delete bucket.paid[key]; } catch (e) { bucket.paid[key] = null; }
        return '';
      }
      var uses = (Number(rec.uses) || 0) + 1;
      rec.uses = uses;
      if (uses > 3) {
        try { delete bucket.paid[key]; } catch (e) { bucket.paid[key] = null; }
        return '';
      }
      return String(rec.value);
    },


    /**
     * 弹窗带着**同一指纹**回来时，判断它是不是上一道没过去的那题，是就把上一轮填的
     * 字母记成被拒（来源 2，见 `_notePopupQuizRejected`）。
     *
     * 为什么要比题干：指纹只看选项文本，而**判断题的选项永远是「对 / 错」** —— 
     * 一个视频里连着三道判断题，指纹完全相同。不比题干就会把"上一道答对了、
     * 弹窗正常关掉、这是新的一道"误记成"答错了"，于是把正确的那个字母永久拉黑。
     * 题干两边都读不到（现场那种容器里只有题型名）时两串都是空 → 相等 → 认成同一道，
     * 那一族本来就只能本地瞎选，拉黑是对的。
     *
     * ⚠️ 批次 77：`filled` 仍按**粗指纹**取（它是批次 74「认判决」的前提，收窄会让
     *    题干漂动的题失去保护），但补记进去的是 `rkey` 那一格 —— 拉黑的尺按题走。
     *    `stem` 由调用方把它已经算好的题干传进来，这里不再重读一遍（两处读法若漂，
     *    "是不是同一道题"就判不准，与 `_answerPopupQuizLocally` 的 `stem` 同一个理由）。
     */
    _popupQuizRecheckRejected: function (key, rkey, popup, stem) {
      var bucket = this._popupQuizSpendBucket();
      var rec = bucket.filled[key];
      if (!rec || !rec.letter) return;
      // ⚠️ 批次 74：这一支把"弹窗收走又带同一指纹回来"当成被拒的证据。
      // 但站点答对后也可能收走弹窗（尤其 errorContinue 类只显「继续」）——
      // 所以在补记之前先读站点判决，判对就**不拉黑**，与 _handlePopupQuiz 里那条同一口径。
      // ⚠️ 判决只读**一次**，读完把同一串既当 return 的判据、又当拉黑那道的闸（批次 75 立的规矩：
      //    取证的尺与记账的尺不许各读各的）。
      var verdictNow = this._popupQuizSiteVerdict(popup);
      if (verdictNow === 'right') return;
      if (this._popupQuizStemMark(stem) !== String(rec.stem || '')) return;
      this._notePopupQuizRejected(rkey, rec.letter, verdictNow);
    },


    /**
     * 「容器还挂在原地、里面一道选项都没有」这一拍到底该怎么办 —— 批次 81。
     *
     * 旧写法只有一句话：`_giveUpPopupQuiz(popup, 'no-options-' + reason)` —— 记一笔放弃、
     * 打一条 **error**、静音 60 秒。可现场量出来的那一族里，**上一拍**刚刚打出
     * `reused site-confirmed answer` + 站点回包 `"msg":"通过"`（见 `_popupQuizRejectKeyBound`
     * 头上那三轮 eventid）。于是同一道题被我们自己说了两句相反的话，而代价是
     * **平台已经判对的那一道再占住视频一分钟** —— 这正是用户报的「视频界面的答题」。
     *
     * 所以这一拍分三种形状，各自的动作不一样（返回 true = 这一拍已经处理完，调用方别再放手）：
     *   ① 便条还新鲜、而**回包说我们填的那个字母对** → 这是「已经过去了」，做与
     *      `_popupQuizSiteVerdict()==='right'` 那一支同一套收尾（放行 + 静默），
     *      区别只在判决槽那三句话此刻一句都不显，依据只能来自回包那本账；
     *   ② 没填过 / 依据不够 → **有尽头地等**一拍：站点摘掉那一层是为了重绘，
     *      下一拍多半就拼回来。只说一条 info，不填、不花钱、不记放弃；
     *   ③ 等过 20 秒仍然空 → 才按旧路「答不了」放手（error + 冷却），
     *      并把这一道登记进放弃账 —— 那才是真的不可答。
     * ⚠️ 判据不许靠「睡了多久猜」：`emptyShell.at` 记的是**第一次看见空壳的时刻**，
     *    20 秒是从这里量的，与 AGENTS §5 那条「读她登记的截止时刻，别猜毫秒」同一口径。
     *
     * ⚠️ ① 的依据**只能来自便条**，这里有两条看着能用、实际错的路（都是本批次写的时候踩出来的）：
     *   · 问「账本 `filled` 里这一格有没有字母」：塌壳那一拍的**粗指纹自己也变了**
     *     （`_popupQuizFingerprint` 有选项走 `cls|o|…`、没选项退回 `cls|t|…`，现场就是
     *     `tkTopic|o|对\u0001错` → `tkTopic|t|判断题`），拿新的 key 去查旧 key 那一格永远查不到 ——
     *     这正是本批次要修的病，用它当依据等于把病写进判据；
     *   · 问「题型对不对得上」：`type` 走 `_detectPopupQuizType`，它**没有选项时把判断题判成
     *     `single`**（`looksJudge` 要求恰好两个「对/错」文本），填答那一拍是 `judge`、
     *     塌壳这一拍是 `single` —— 拿它当闸会把放行整个挡死，修复等于没做。
     *   所以强度与站点自己说「通过」那一支**一致**：「我们刚亲手填进去一个字母」+
     *   「它自己的回包说那个字母对」，中间不掺猜。`clsSame` 只写进日志当取证，**不作闸**。
     */
    _popupQuizEmptyShellPass: function (popup, key, stem, reason) {
      var bucket = this._popupQuizSpendBucket();
      var rkey = this._popupQuizRejectKeyBound(key, stem);
      var scoped = this._popupQuizScopedFlagBound(key, stem);
      var bind = this._popupQuizBindIfFresh();
      var filledLetter = bind ? bind.letter : '';
      var rightKey = bind ? bind.rkey : rkey;

      if (filledLetter && this._popupQuizSiteRightKnown(rightKey, filledLetter)) {
        var siteRec = (bucket.siteRight || {})[rightKey] || {};
        bucket.emptyShell = null;
        this._popupQuizSolvedKey = key;
        this._popupQuizSolvedAt = Date.now();
        this._popupQuizQuietUntil = Date.now() + scaledMs(POPUP_QUIZ_QUIET_MS);
        this._popupQuizBlockedUntil = 0;
        this._popupQuizLastFilled = '';
        this._popupQuizAttempts = 0;
        // 批次 155：这一发同页只说一次（releaseSaid 见 `_popupQuizSpendBucket`）。
        var saidKey = 'shell|' + String(rightKey);
        if (!bucket.releaseSaid[saidKey]) {
          bucket.releaseSaid[saidKey] = 1;
          emitRuntimeLog('info', 'popup quiz already accepted by site, releasing block', {
            letter: filledLetter.slice(0, 20),
            eventid: String(siteRec.eid || '').slice(0, 32),
            uses: Number(siteRec.uses) || 0,
            scoped: scoped,
            reason: reason,
            // 「便条那个容器」与「这一拍这个容器」的 class 是否同一个 —— 只当取证，不当闸
            // （换 class 就把放行挡死，等于把本批次修的病留在判据里，见头上那条⚠️）。
            clsSame: bind && bind.cls === String(key || '').split('|')[0] ? 1 : 0,
            waitedMs: bind ? Date.now() - bind.at : 0,
            hint: '容器里一个选项都没有（站点收下答案那一刻把那一层摘掉了），而它自己的回包写着「通过」—— ' +
              '这一道是**过去了**，不是答不了。旧写法在这里记放弃并静音 60 秒，' +
              '等于平台判对了我们还替它按住视频一分钟'
          });
        }
        return true;
      }

      var now = Date.now();
      var seen = bucket.emptyShell;
      if (!seen || String(seen.key) !== String(key) || !(Number(seen.at) > 0)) {
        bucket.emptyShell = { key: String(key), at: now };
        emitRuntimeLog('info', 'popup quiz has no options yet, waiting a beat', {
          reason: reason, scoped: scoped, waitedMs: 0,
          // 为什么没走放行那一支：`bound`=便条在不在（新鲜且有题干），`right`=回包认不认那个字母。
          // 现场只看这两个数就分得开「这一道压根没填过」与「填过但回包说错」。
          bound: bind ? 1 : 0, right: bind && this._popupQuizSiteRightKnown(bind.rkey, bind.letter) ? 1 : 0,
          hint: '弹窗容器在、里面还没有选项（站点正在重绘）。这一拍不填、不花钱、不记放弃；' +
            '20 秒后还是这样才按「答不了」放手'
        });
        return true;
      }
      var waited = now - Number(seen.at);
      if (waited < 20000) return true;
      bucket.emptyShell = null;
      emitRuntimeLog('warn', 'popup quiz shell stayed empty', {
        reason: reason, scoped: scoped, waitedMs: waited,
        filled: filledLetter ? 1 : 0,
        bound: bind ? 1 : 0,
        hint: '20 秒内容器里仍然一个选项都没有 —— 这一道按「答不了」放手并冷却'
      });
      return false;
    },


    /**
     * **不花钱**地把弹窗点掉：挑一个还没被平台判错的选项，走与模型答案同一条填答路。
     *
     * 两个调用场景（都不该花请求）：
     *   1. 题干是空的 —— 只有题型名（「判断题」）这种容器现场就是这样，
     *      模型看不到问题，问了也是瞎猜，每一发都是白花钱；
     *   2. 这一道在本节已经放弃两次，或本节已经发满 2×上限
     *      （`_notePopupQuizGiveUp` / `_popupQuizAskBudget` 的静音名单）。
     * 填答与交卷**仍然走 `_fillPopupAnswer`** —— 不在这里另写一份选项匹配，
     * 那正是 AGENTS §2 说的"两份规则互漂"。
     *
     * `stem` 由调用方把它已经读到的题干原样传进来（只用来记账，见 `_notePopupQuizFilled`），
     * 这里不再重算一遍 —— 两处算出来的题干若漂了，"是不是同一道题"就判不准。
     */
    _answerPopupQuizLocally: function (popup, optionItems, type, reason, stem) {
      var items = optionItems || [];
      var key = this._popupQuizFingerprint(popup, items);
      if (!items.length) {
        // 一个选项都没有 → 没有"点一下就能过"的形状，别硬点。
        // ⚠️ 但"没选项"在现场有两件不同的事（批次 81）：站点收下答案后把装题干与选项的
        //    那一层摘掉（这一道**过去了**），与它压根长不出选项（这一道**答不了**）。
        //    旧写法把它们并成一句 `no-options-*` 的 error + 60 秒静音 —— 于是平台刚判对
        //    的那一道也被按住一分钟。分开判的那一格里有现场读数。
        if (this._popupQuizEmptyShellPass(popup, key, stem, reason)) return false;
        this._giveUpPopupQuiz(popup, 'no-options-' + reason);
        return false;
      }
      // 批次 83：这一道题的**收窄键**（粗指纹 + 题干可比对形态）在本函数里算一次，
      // 记账、点名原因、日志三处共用 —— 两处各算一份就是"两份尺互漂"。
      // ⚠️ 批次 81：题干那一格被站点摘掉时不能就此退回粗指纹 —— 账本上的名单与
      //    「平台判对了哪个字母」都记在细键那一格，退回去就等于**现场看着像"没依据"**。
      var rkey = this._popupQuizRejectKeyBound(key, stem);
      var banned = [];
      try {
        banned = (this._popupQuizWrongAnswers || []).map(function (v) {
          return String(v || '').toUpperCase();
        });
      } catch (eB) {}
      // ⚠️ 批次 79-B：名单还要**并上账本**里这一道题那一格（`_popupQuizRejectKey` 那把尺）。
      // 内存那份（`_popupQuizWrongAnswers`）跟着弹窗的生命周期走 —— 站点把弹窗收走的那一刻
      // `_activePopupBlock` 就把它清了；账本那份才留得住"平台判错过哪些字母"。
      // 只读内存，上面新加的那道闸就可能把**已经被判错**的字母免费点回去：不花钱，
      // 但同一道判断题还是在 对/错 之间来回点，视频照样过不去。
      try {
        var ledgerBanned = (this._popupQuizSpendBucket().rejected || {})[rkey] || [];
        for (var lb = 0; lb < ledgerBanned.length; lb++) {
          var lu = String(ledgerBanned[lb] || '').toUpperCase();
          if (lu && banned.indexOf(lu) === -1) banned.push(lu);
        }
      } catch (eL) {}
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
        // ⚠️ 批次 83：**这一笔必须记账**（`_notePopupQuizGiveUp`）。这一步是批次 83
        // 那条「答案空间已经空了，一发都不发」的**后果**，如果不记账，站点那一族里
        // 每一拍（冷却一过）都会重新走到这里 —— 而账上「放弃过几次」永远是 0，
        // 批次 71/72 立的静音名单与封顶那一格就再也轮不到（实测：三个字母三发就用尽，
        // 之后每 60 秒重来一轮，静音/只说一次那两条事件从来不发）。
        // 记账之后：第二次「一个都不剩」起进静音名单，原因写 `gave-up-twice`，
        // 后面每拍都走名单那一支（照旧一条请求都不发，但不再反复登记放弃）。
        emitRuntimeLog('warn', 'popup quiz every option already rejected', {
          reason: reason, banned: banned.slice(0, 6), optionCount: items.length,
          verdict: this._popupQuizSiteVerdict(popup) || 'unknown',
          // 批次 77：这份名单是**只算这一道题**的(1)，还是与同选项的别的题共用的(0)。
          // 现场要一眼分开「这道真的两个字母都判错过」与「上一道把名单污染了」。
          // ⚠️ 读的是「名单实际落在哪把尺上」（`_popupQuizScopedFlagBound` 就是问上面那把
          //    `rkey` 收没收窄），不是"题干串非空" —— 批次 81 之后细键还能从填答便条拿回来，
          //    再看题干会把明明按题记的那一格说成按族记。
          scoped: this._popupQuizScopedFlagBound(key, stem)
        });
        this._notePopupQuizGiveUp(rkey, this._popupQuizScopedFlagBound(key, stem));
        this._giveUpPopupQuiz(popup, 'all-options-rejected');
        return false;
      }
      var filled = false;
      // 批次 99：上面那一圈只挑得出**一枚**字母，而真多选题（站点最少要选 2 项）勾一格必然判错 ——
      // 更贵的是那一枚会被单独记进已判错名单（`_notePopupQuizRejected` 记的就是 `_popupQuizLastFilled`），
      // 于是每一轮换一枚、永远凑不出站点要的那一组（任务 #145 的现场表现：这道多选弹题一直在转）。
      // 不接手时（不定项 / 凑出来的组合全被判过 / 含填不动的字母）照旧用那一枚，行为不后退。
      var comboTry = type === 'multiple' ? this._popupQuizLocalCombo(popup, items, banned, picked) : null;
      if (comboTry && comboTry.group) picked = comboTry.group;
      try { filled = !!this._fillPopupAnswer(popup, picked, type); } catch (eF) { filled = false; }
      if (filled) {
        this._popupQuizSolvedKey = key;
        this._popupQuizSolvedAt = Date.now();
        this._popupQuizBlockedUntil = 0;
        this._popupQuizQuietUntil = Date.now() + scaledMs(POPUP_QUIZ_QUIET_MS);
        this._popupQuizLastFilled = String(picked);
        this._notePopupQuizFilled(key, picked, stem, type);
      }
      emitRuntimeLog('warn', 'popup quiz answered locally, no request', {
        reason: reason, picked: picked, filled: filled ? 1 : 0,
        // 批次 99：多选这一族「有没有凑成组」与「没凑的哪一种原因」要读得回来 ——
        // 现场靠这一格分得开「这题本来就该单枚」与「该凑却全被判过了」。
        combo: comboTry ? comboTry.why : 'not-multiple',
        attempt: this._popupQuizAttempts,
        banned: banned.slice(0, 6),
        // 批次 83：这份名单里**平台当场说过错的**有几个 —— 现场拿它和 `banned.length` 一比，
        // 就分得开「站点自己判的」与「我们因为弹窗被收走而推断的」。
        // （推断那一类只用来挑字母，不够格免掉一次付费询问，见 `_popupQuizRejectBySite`。）
        bySite: this._popupQuizRejectBySite(rkey).length,
        // 站点自己此刻判成了什么 —— 现场日志要能分清「我们以为被拒」与「平台真判错」。
        verdict: this._popupQuizSiteVerdict(popup) || 'unknown',
        scoped: this._popupQuizScopedFlagBound(key, stem),
        options: items.slice(0, 6).map(this._extractOptionText.bind(this)),
        hint: reason === 'no-stem' ?
          '这个弹窗的容器里只有题型名（例如「判断题」），题干是空的 —— 问了模型也只能瞎猜，' +
          '所以本地自己挑答案（多选题挑一整组，看 picked 与 combo），不花钱' :
          (reason === 'ask-cap' ?
            '这一道在本节已经发满 2×上限 次请求（弹窗被站点每轮收走，所以按任务点记账）—— ' +
            '之后本地自己挑答案（多选题挑一整组，看 picked 与 combo），不再花钱' :
            (reason === 'only-one-never-rejected' ?
              '平台已经把这一道除这一个以外的选项全判错过 —— 答案不用再花钱问模型，' +
              '直接免费点剩下的那一个（它也可能错，但一发都不花）' :
              (reason === 'model-repeated-rejected' ?
                '模型这一发回的是平台**已经判错过**的那个字母 —— 不再为它填第二遍，' +
                '改免费点没被判过的那一个（多选题凑成一组，看 picked 与 combo）' :
                (reason === 'all-banned-before-ask' ?
                  '这一道的每个选项都已被判错过（平台亲口说的有几个、推断的有几个，看上面 bySite 与 ' +
                  'banned 两格）—— 单选/判断题只有一个字母算对，再问模型也只能问出这些已知错的，' +
                  '所以一发都不发，直接放弃并冷却' :
                  '这一道在本节已经放弃两次，之后只本地作答，不再发请求'))))
      });
      return filled;
    },


    /**
     * 多选题的本地兜底该点**哪一组**（批次 99，任务 #145）。
     *
     * 为什么要单独有这一格：`_answerPopupQuizLocally` 挑的是"第一枚没被判过的字母"，
     * 对真多选题（站点最少要 2 项）那一格**结构上不可能对**；而它交出去的那一枚随后会被
     * `_notePopupQuizRejected` 按单字母记进名单 —— 于是名单越记越碎，组合却一次都没试过。
     * 补组合的手法不另写一份，直接用章节小测那一条 `_expandMultiChoiceLetters`（相邻项优先），
     * 免得两份规则互漂（AGENTS §2）。
     *
     * 三条不许（每条都对应一种实测过的坏形状）：
     *   1. **不定项与认不出题型的不凑** —— `_getMultiChoiceMinSelections` 给 1 就交回空串。
     *      凭空多补一项＝造一个没人给的答案，那正是 `75-quiz-dom.js` 里写明的那个判错来源；
     *   2. **两把尺先收敛** —— 本文件的名单是 `_popupQuizLetterGroup` 的带逗号形 `"A,C"`，
     *      而 `_expandMultiChoiceLetters` 内部比的是 `_canonicalQuizAnswer` 的不带逗号形 `"AC"`。
     *      原样喂进去，「避开已判错组合」这句承诺就永久为空、不报错也不留日志（AGENTS §2 #18）；
     *      认不出来的那些（选项原文）不进名单 —— 它本来就比不中字母组合；
     *   3. **不交回填不动的字母** —— `_normalizeChoiceAnswerValues` 只把 `[A-F]` 当字母，
     *      组合里混进 G 会让整串退化成"选项原文"而一个都点不上，那种组合直接跳过。
     *
     * 返回 `{ group, why }`：`group` 用**本文件那一把尺**（`"A,C"`，空串＝不接手），
     * `why` 是给日志的归因：`ok` / `min-1` / `no-seed` / `all-banned`。
     */
    _popupQuizLocalCombo: function (popup, items, banned, seedLetter) {
      var out = { group: '', why: 'min-1' };
      var min = 1;
      try { min = Number(this._getMultiChoiceMinSelections(popup)) || 1; } catch (eM) { min = 1; }
      if (min < 2) return out;
      var bannedCombo = [];
      for (var b = 0; b < (banned || []).length; b++) {
        var oneBan = '';
        try { oneBan = this._canonicalQuizAnswer(banned[b], 'multiple'); } catch (eC) { oneBan = ''; }
        if (oneBan && bannedCombo.indexOf(oneBan) === -1) bannedCombo.push(oneBan);
      }
      out.why = 'no-seed';
      var seeds = [];
      var pushSeed = function (ch) {
        var up = String(ch || '').toUpperCase();
        if (!/^[A-F]$/.test(up) || seeds.indexOf(up) !== -1) return;
        seeds.push(up);
      };
      pushSeed(seedLetter);
      for (var i = 0; i < (items || []).length; i++) {
        pushSeed(this._inferOptionLetter(items[i], i) || String.fromCharCode(65 + i));
      }
      if (!seeds.length) return out;
      out.why = 'all-banned';
      for (var s = 0; s < seeds.length; s++) {
        var combo = [];
        try { combo = this._expandMultiChoiceLetters([seeds[s]], min, popup, bannedCombo) || []; } catch (eE) { combo = []; }
        if (combo.length < 2) continue;
        var letters = [];
        for (var c = 0; c < combo.length; c++) {
          var cu = String(combo[c] || '').toUpperCase();
          if (!/^[A-F]$/.test(cu)) { letters = []; break; }
          if (letters.indexOf(cu) === -1) letters.push(cu);
        }
        if (letters.length < 2) continue;
        letters.sort();
        out.group = this._popupQuizLetterGroup(letters.join(','));
        out.why = 'ok';
        return out;
      }
      return out;
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


    /**
     * 读站点**自己的**判分结果 —— 视频弹题（ans.videojs.VideoQuiz）交卷后，
     * 站点把「回答正确」写进 #spanHas、把「回答错误」写进 #spanNot / #spanNotBack，
     * 三者在站点 CSS 里默认 display:none，只有命中对应结果才显出来（已从正典核实）。
     *
     * 为什么要读它：以前判定"答没答对"的唯一依据是推断 ——
     * 「同一道弹题、弹窗还在 = 上一轮填的没被接受，那就是错的」。
     * 可是有一类课程（errorContinue=1 / dtype=InteractiveQuiz）**答对之后弹窗并不会自己关**，
     * 它只是把 #videoquiz-continue 显出来等人点「继续」。
     * 于是正确的那个字母被误判成"被平台拒了"、永久拉黑；换的那个才是真错，也拉黑；
     * 两个一拉黑就 all-options-rejected，而「继续」既不在我们的按钮文本表里、也没人点 ——
     * 视频永远卡在这道其实已经答对的题上。这就是现场「视频界面的答题还没修复」的根因。
     *
     * ⚠️ 只有读到**明确的一个**时才下结论：两者都显或都不显 → 返回 ''（读不准），
     * 交回旧的"弹窗还在就算被拒"推断，这样文档题/PPT 题那些不叫 spanHas 的弹窗族不被改坏。
     */
    _popupQuizSiteVerdict: function (popup) {
      var has = this._popupQuizSpanVisible(popup, 'spanHas');
      var not = this._popupQuizSpanVisible(popup, 'spanNot') ||
                this._popupQuizSpanVisible(popup, 'spanNotBack');
      if (has && !not) return 'right';
      if (not && !has) return 'wrong';
      return '';
    },


    /**
     * 判一个 verdict 槽（spanHas / spanNot / spanNotBack）此刻是否**可见**。
     * 优先读 computed display（站点就是直接切这个属性）；读不到才退回几何尺寸。
     * 全部包在 try 内：跨帧读不到就当不可见，绝不让它抛出打断整条判分。
     */
    _popupQuizSpanVisible: function (root, id) {
      try {
        var node = null;
        if (root && typeof root.querySelector === 'function') {
          node = root.querySelector('#' + id);
        }
        if (!node && root && root.ownerDocument && typeof root.ownerDocument.getElementById === 'function') {
          node = root.ownerDocument.getElementById(id);
        }
        if (!node) return false;
        var disp = '';
        try {
          var view = node.ownerDocument && node.ownerDocument.defaultView;
          if (view && view.getComputedStyle) {
            disp = String(view.getComputedStyle(node).display || '');
          }
        } catch (eCs) { disp = ''; }
        if (disp) return disp !== 'none';
        return !!(node.offsetWidth || node.offsetHeight ||
          (node.getClientRects && node.getClientRects().length));
      } catch (e) {
        return false;
      }
    },


    /**
     * 点视频弹题答对后显出来的「继续」键（#videoquiz-continue / .ans-videoquiz-continue）。
     *
     * 站点答对后**不一定**自动恢复播放：源码里只有当 #videoquiz-continue 仍是 display:none 时
     * 才 fireEvent('continue')。有一类课程把这枚键显出来等人点 —— 不点，视频就一直停在这道弹题上。
     * 以前我们的按钮文本表里根本没有「继续」，只找 跳过/关闭/取消/知道了/下次再说，
     * 于是答对了也走不掉。只在可见时才点；不可见说明这一发站点自己续播，返回 false 告诉调用方没点到。
     */
    _clickPopupContinue: function (popup) {
      var btn = null;
      try {
        if (popup && typeof popup.querySelector === 'function') {
          btn = popup.querySelector('#videoquiz-continue') ||
                popup.querySelector('.ans-videoquiz-continue');
        }
        if (!btn && popup && popup.ownerDocument && typeof popup.ownerDocument.getElementById === 'function') {
          btn = popup.ownerDocument.getElementById('videoquiz-continue');
        }
      } catch (e) { btn = null; }
      if (!btn || !visible(btn)) return false;
      try { btn.click(); return true; } catch (e2) { return false; }
    },


    _handlePopupQuiz: async function (popup) {
      // 批次 78：到**真的在处理弹题**的这一帧才挂钩子（没弹过题的页面一条钩子都不装）。
      // 批次 79：挂的是**这个弹窗自己那一帧**的 window —— 现场那一发 `quiz-validation`
      // 由视频帧发出（`.workbuddy/b79-who.log`：「批次78钩子在这一层=没有」），
      // 挂在顶层等于旁听不到任何回包。取不到 defaultView 时函数自己退回顶层窗口。
      var popupWin = null;
      try { popupWin = popup && popup.ownerDocument && popup.ownerDocument.defaultView; } catch (eW) { popupWin = null; }
      this._popupQuizInstallNetLedger(popupWin);
      var popupText = textOf(popup);
      if (popupText === '知道了' || popupText === '关闭' || popupText === '确定') {
        popup.click();
        return;
      }

      // 同一道弹题的指纹：弹窗没关就一定是同一道。换题（文本变了）才重新计数。
      var key = this._popupQuizFingerprint(popup);

      // ⚠️ 先问站点自己判成了什么 —— 这是本批次（74）修复的核心。
      // 旧判定把「弹窗还在 / 收走又带同一指纹回来」当成上一轮**答错**的证据，
      // 于是把其实答对了（站点只是没自动关弹窗、把「继续」显出来等你点）的字母永久拉黑。
      // 现在改读站点自己的判决：判对就放行、绝不拉黑，并顺手点掉那枚「继续」。
      // 认判决的前提是「这一道我们确实填过」—— _popupQuizLastFilled（这一拍刚填）
      // 或账本里这一指纹有 filled 记录（弹窗被收走又弹回来的那一族）。两者都没有就别认，
      // 免得把上一节残留的 #spanHas 当成这一道的结果。
      var bucket = this._popupQuizSpendBucket();
      var filledRec = (bucket.filled || {})[key];
      var weAnsweredThisKey = !!this._popupQuizLastFilled || !!(filledRec && filledRec.letter);
      if (weAnsweredThisKey && this._popupQuizSiteVerdict(popup) === 'right') {
        // 批次 155：「继续」要点、静默期照开 —— 记忆键只圈住说话那一发，动作每拍都做
        //（点「继续」原先藏在日志载荷里，跟着闭嘴就把续播那一下也吞了）。
        var clickedContinue = this._clickPopupContinue(popup);
        var saidKey = 'site|' + String(key);
        if (!bucket.releaseSaid[saidKey]) {
          bucket.releaseSaid[saidKey] = 1;
          emitRuntimeLog('info', 'popup quiz accepted by site, releasing block', {
            letter: String(this._popupQuizLastFilled || (filledRec && filledRec.letter) || '').slice(0, 20),
            clickedContinue: clickedContinue
          });
        }
        this._popupQuizSolvedKey = key;
        this._popupQuizSolvedAt = Date.now();
        this._popupQuizQuietUntil = Date.now() + scaledMs(POPUP_QUIZ_QUIET_MS);
        this._popupQuizBlockedUntil = 0;
        this._popupQuizLastFilled = '';
        this._popupQuizAttempts = 0;
        return;
      }

      // ── 批次 77：拉黑这一族改按**这一道题**记账 ─────────────────────────────
      // 选项相同、题干不同的两道题共用一份已拒名单，就是现场「平台刚刚把 A 判成对的，
      // 而我们的名单上 A/B 全错」的成因（证据与推理见 `_popupQuizRejectKey`）。
      // ⚠️ 只有 `rejected` 这一格换尺：asks / silent / gives / filled / paid 全留在粗指纹上，
      //    所以**每节每族选项的封顶仍是 2×上限 发**，收窄黑名单一分钱都不多花。
      //
      // ⚠️ 题干必须从**选项所在的那一层**读，不能读 `textOf(popup)`。
      // 现场 2026-11-15 14:17 那一发就是读错了层：容器 `.tkTopic` 里只有
      // 「判断题」这个题型名，选项在兄弟节点，于是发给模型的问题是「判断题」三个字
      // —— 它只能瞎猜，猜错就被平台拒，弹窗留着再问，**每 8 秒一次**。
      var optionItems = this._getOptionItems(popup);
      var stem = this._popupQuizStem(popup, optionItems);
      // ⚠️ 批次 81：题干那一格被站点摘走的那一拍（`_popupQuizEmptyShellPass` 现场那一族），
      //    这里不许退回粗指纹 —— 回包记的「平台判对了哪个字母」落在细键上，
      //    退回来就读成"没依据"，于是把已经判对的那一道放弃掉再静音 60 秒。
      var rkey = this._popupQuizRejectKeyBound(key, stem);

      // 题型在这里算一次就够了 —— 批次 78 的快路（免费填回判对的字母）与下面发请求那一段
      // 都要用它。同一个纯函数读同一份 DOM 读两遍就是"两份尺互漂"。
      // 题型不能靠"题干里有没有'正确/判断'这几个字"来猜 ——
      // "下列说法正确的是？"是单选题，却因为含"正确"被判成判断题，
      // 模型随之收到错误的题型并回 true/正确，而选项里根本没有这个文本，
      // 于是一个都匹配不上（这就是"扫描了但从不填空"的另一种形态）。
      // 可靠依据只有两个：控件类型（复选=多选、文本框=填空）和选项文本。
      var type = this._detectPopupQuizType(popup, optionItems);

      // ── 批次 78：平台**回包已经判对**的那个字母，免费填回去，不花钱也不再拉黑 ──────
      // 现场那一族：站点答完就把弹窗收走、重绘，判决槽一句都读不出（verdict=''），
      // 老推断只能说"这一发被拒了"；而网络那一发明明白白写着 `"isRight":true`
      // —— 于是正确字母被拉黑、另一个也被拉黑、`all-options-rejected`、视频永久停住。
      // 填不进去（现场选项里压根没这个字母）时返回 false，交回下面老流程 —— 那一支照常拉黑。
      if (this._popupQuizTrySiteRightAnswer(popup, optionItems, type, rkey, stem)) return;

      if (key === this._popupQuizKey) {
        this._popupQuizAttempts++;
        // 走到这里说明：同一道题、弹窗还在 —— 上一轮填进去的答案没被平台接受，
        // 那就是错的。记下来，本轮带给模型让它换个答案。
        // （只在**确认没通过**时才记，所以不会把「其实答对了、只是弹窗关得慢」的答案误禁。）
        if (this._popupQuizLastFilled) {
          // ⚠️ 判决在这里**只读一次**，然后三处共用同一个串：内存名单那一格、账本那一格
          //    （`_notePopupQuizRejected` 里那道闸）、下面日志的 `verdict`。
          //    两处各读一次就会互漂 —— 账本挡住了、内存名单还把它发给模型，
          //    模型便永远避开正确的那个字母（现场「A/B 全被判错」的另一半成因）。
          var verdictNow = this._popupQuizSiteVerdict(popup);
          var keptSiteRight = verdictNow !== 'wrong' &&
            this._popupQuizSiteRightKnown(rkey, this._popupQuizLastFilled);
          // 同一笔账记进**不随弹窗消失**的账本：站点答完就把弹窗收走，下面那段
          // "换题就清空 wrong"会把它抹掉，于是本地作答又挑回同一个已被拒的字母 ——
          // 表现是"同一道判断题在 对/错 之间来回点，视频一直过不去"。
          this._notePopupQuizRejected(rkey, this._popupQuizLastFilled, verdictNow);
          if (!keptSiteRight) {
            if (!this._popupQuizWrongAnswers) this._popupQuizWrongAnswers = [];
            if (this._popupQuizWrongAnswers.indexOf(this._popupQuizLastFilled) === -1) {
              this._popupQuizWrongAnswers.push(this._popupQuizLastFilled);
            }
            // 特意留一条日志：用户报过"答完弹题就卡住、不知道会不会自己好"，
            // 这条能直接说明"不是卡住，是上一个答案被平台拒了、正在换一个重试"。
            emitRuntimeLog('info', 'popup quiz answer rejected by site, retrying with a different one', {
              attempt: this._popupQuizAttempts,
              rejected: String(this._popupQuizLastFilled).slice(0, 40),
              banned: (this._popupQuizWrongAnswers || []).slice(0, 6),
              // 拉黑这个字母的**依据**是站点判了错，还是仅仅"弹窗还在" —— 现场必须分得开。
              // 'wrong' = 平台自己说的；'unknown' = 那三句话一句都没显，走的还是旧推断。
              // ⚠️ 复用上面那一次读数（同一个 popup 读两遍就是两份尺互漂）。
              verdict: verdictNow || 'unknown',
              // 批次 77：这一格的已拒名单是**只算这一道题**(scoped:1)，还是和同选项的
              // 别的题共用一份(scoped:0 —— 题干读不到、填答便条也对不上，只能退回粗指纹)。
              // ⚠️ 批次 81：用 `_popupQuizScopedFlagBound`（它问的就是"上面那把尺真收窄了吗"），
              //    不许再看题干串非空 —— 取证的那格与记账的那格必须同一个来源。
              scoped: this._popupQuizScopedFlagBound(key, stem)
            });
          }
          this._popupQuizLastFilled = '';
        }
      } else {
        // 站点每答一次就把弹窗收走，下一拍它带着**同一指纹**回来 —— 上面那句"弹窗没了
        // 就清零"和这里都属于"当作新题"。已判错的字母不能跟着一起丢，否则
        //   · 发给模型的 previousWrongAnswers 变空 → 它回同一个已被拒的答案；
        //   · 本地作答又挑回那个字母 → 同一道判断题在 对/错 之间来回点，视频一直过不去。
        // 而"这一轮被收走又弹回来"本身就是**被拒的证据**（答对了站点就不会再弹），
        // 所以先按账本补记上一轮那个字母，再把它当作本题的已拒名单发下去。
        // ⚠️ 补记要比题干（批次 72 立的规矩），读回来的名单则是**这一道题**自己的（批次 77）：
        //    上一道判断题拉黑的字母不能出现在这一道的名单里。
        this._popupQuizRecheckRejected(key, rkey, popup, stem);
        this._popupQuizKey = key;
        this._popupQuizAttempts = 1;
        this._popupQuizLastFilled = '';
        this._popupQuizWrongAnswers = (this._popupQuizSpendBucket().rejected[rkey] || []).slice();
      }

      var maxAttempts = this._getPopupQuizMaxAttempts();
      if (this._popupQuizAttempts > maxAttempts) {
        // 记一笔账：这**一道题**在本节第二次放弃起，后面只本地作答、不再发请求。
        // ⚠️ 批次 83：记在 `rkey`（按题）而不是 `key`（按选项那一族）—— 判断题的选项
        // 指纹永远是「对/错」，按族记会让上一道考砸的放弃把这一节后面那些真能答的
        // 判断题一起静音掉（省的是一整节的正确率，不是钱）。
        this._notePopupQuizGiveUp(rkey, this._popupQuizScopedFlagBound(key, stem));
        this._giveUpPopupQuiz(popup, 'attempts-exceeded');
        return;
      }

      if (!this._isQuizApiUnavailable()) {
        // 连线/匹配题：左右两列被一起抓成了「6 个选项」，文本成对重复
        // （日志实测：Color / Transparency / Color / Transparency / …）。
        // 这种题选择题的作答方式永远对不上，旧逻辑会连着问 6 次模型、每次都被判错 ——
        // 用户看到的就是「弹题卡住，刷新后重来还是它」。这里直接判定不可答并跳过。
        var optionTexts = optionItems.map(this._extractOptionText.bind(this));
        if (this._looksLikeMatchingQuiz(optionTexts)) {
          this._giveUpPopupQuiz(popup, 'matching-or-duplicate-options');
          return;
        }

        // 题干在上面批次 77 那一格里已经算好了（`stem`）—— 同一个函数里读两遍就是
        // "两份尺互漂"，比题干、记账、发请求必须用**同一串**。
        var spend = this._popupQuizSpendBucket();
        // 查预算：到顶时 `_popupQuizAskBudget` 自己会把这一道写进静音名单（并只说一次），
        // 名单里存的就是"为什么不再问了"，下面那一格直接拿它当原因点名。
        this._popupQuizAskBudget(key);

        // 两种情况一律**不发请求**，本地自己挑答案（多选题挑的是一整组）把弹窗点掉：
        //   · 题干是空的（只有题型名）—— 问了也只能瞎猜，那一发是纯浪费；
        //   · 这一道已经放弃两次、或本节已发满 2×上限 —— 继续问就是"每 8 秒再来一发"，永不收敛。
        // 让步的是**正确率**，不是**钱**：本地选也可能选错，但一条请求都不花。
        // ⚠️ 静音名单现在有**两把尺**（批次 83）：放弃是按题记的（`rkey`），封顶预算
        //    是按选项那一族记的（`key`，批次 72 的每节每族预算）。按题那一格先读 ——
        //    它是"这一道考砸了"，比"这一族在本节花满了"更具体，原因点名也要点它。
        if (!stem) {
          this._answerPopupQuizLocally(popup, optionItems, type, 'no-stem', stem);
          return;
        }
        var silentWhy = spend.silent[rkey] || spend.silent[key] || '';
        if (silentWhy) {
          this._answerPopupQuizLocally(popup, optionItems, type, String(silentWhy), stem);
          return;
        }

        // ── 批次 79-B / 83：已被判错的字母，**不该再花钱问模型** ────────────────
        // 现场 2026-11-16 同一道判断题连着四拍（`.workbuddy/b79-who.log` + 面板日志）：
        //   attempt1 填 A → `verdict:"wrong"`；attempt2 填 B → `verdict:"wrong"`；
        //   attempt3 `banned:["A","B"]` 之后**还在花第三发**（`fromPaidCache:false letter:"B"`）；
        //   attempt4 才 `attempts-exceeded` 放弃。三道请求买的是同一个「这两个都不对」。
        // ⚠️ 只在 `scoped:1`（名单按**这一道题**记）时成立：题干读不到时名单是
        //    同选项别的题共用的粗指纹，"削到一个"根本不是这一道的证据（那一走上面 `!stem` 已经挡了）。
        if (this._popupQuizScopedFlag(stem) && (type === 'judge' || type === 'single')) {
          // 两种让步要的**证据硬度不一样**，所以分两本账读（批次 83 立的口径）：
          //   · 「一个都不剩」→ 读混在一起的那本（`rejected`，含推断）。
          //     理由是结构性的，不是证据性的：判断题/单选题只有**一个**字母算对，
          //     而模型的回包只能落在这几个字母之一 —— 每个都被判错过，这一发买回来的
          //     必然是我们已经知道错的那个。钱花下去连"让步正确率"都换不到，
          //     所以这一格不需要平台亲口说过。（实测成因：站点答完就把弹窗收走，
          //     判决槽一句都不显，只有"收走又弹回"这一条推断 —— 那一族原先把 2×上限
          //     六发全花光，而两个字母在前两发就已经用尽了。）
          //   · 「只剩一个」→ 只读**平台当场判错**那一本（`rejectedSite`）。
          //     这一支是在**断言剩下那个就是答案**，而"弹窗被收走"没有说过这句话；
          //     拿推断当答案，等于把批次 72 立的付费封顶安全阀绕开
          //     （详 `_popupQuizRejectBySite` 那段与那 14 条红）。
          var bannedAny = (spend.rejected || {})[rkey] || [];
          var bannedSite = this._popupQuizRejectBySite(rkey);
          var leftAny = 0;
          var leftSite = 0;
          for (var bi = 0; bi < optionItems.length; bi++) {
            var bl = this._inferOptionLetter(optionItems[bi], bi) || String.fromCharCode(65 + bi);
            var bu = String(bl).toUpperCase();
            if (bannedAny.indexOf(bu) === -1) leftAny++;
            if (bannedSite.indexOf(bu) === -1) leftSite++;
          }
          if (leftAny === 0) {
            this._answerPopupQuizLocally(popup, optionItems, type, 'all-banned-before-ask', stem);
            return;
          }
          if (bannedSite.length && leftSite === 1) {
            this._answerPopupQuizLocally(popup, optionItems, type, 'only-one-never-rejected', stem);
            return;
          }
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
          var reusedPaid = '';
          if (this._isRandomAnswerMode()) {
            this._logRandomAnswers([question]);
            result = { success: true, data: [this._buildRandomQuizAnswers([question])[0]] };
          } else {
            // ⚠️ 先问账本：这一道**上一发是不是已经买过答案了**。
            // 站点把 `.tkTopic_con`（题干 + 选项那一块）摘掉的那几秒里，回包时现场扫不到
            // 任何选项，于是钱花了、答案填不进去（见 `_notePopupQuizPaid` 那段现场读数）。
            // 等选项拼回来的下一拍直接用它 —— **不取额度、不发第二发**。
            reusedPaid = this._popupQuizPaidAnswer(key, stem);
            if (reusedPaid) {
              // 复用前先看它是不是**平台已经判错的那个字母**：是的话这一格已经不值钱了，
              // 丢掉、带已拒名单照常重新问 —— 否则会把同一个错答案反复填三遍。
              // ⚠️ 批次 77：读 `rkey` 那一格 —— 别的题判错过的字母不影响这一道值不值钱
              //    （`_popupQuizPaidAnswer` 上面那道题干比对已经保证这格是**这一道**买的）。
              var paidLetter = this._popupQuizFilledLetter(popup, optionItems, reusedPaid, type);
              if (paidLetter && (spend.rejected[rkey] || []).indexOf(paidLetter) !== -1) {
                this._notePopupQuizPaid(key, '');
                reusedPaid = '';
              }
            }
            if (reusedPaid) {
              result = { success: true, data: [reusedPaid] };
            } else {
              // 只有**真要发请求**这一支才取额度 —— 乱选模式与上面那条复用一条都不发。
              this._takePopupQuizAsk(key);
              result = await bridgeSend('llm_request', { questions: [question] });
            }
          }
          if (result && result.success && result.data) {
            var answer = Array.isArray(result.data) ? result.data[0] : result.data;
            // ⚠️ 批次 79-B：**现问的这一支原先没有闸** —— 上面那道闸（复用付费缓存那一支）
            // 管的是"上一发买的答案还值不值钱"，而模型**这一发**回一个已被平台判错的字母时，
            // 老代码照样无条件 `_fillPopupAnswer`，于是同一道判断题在 对/错 之间来回点、
            // 每一拍再花一发。现场 2026-11-16 读数（面板 + `.workbuddy/b79-who.log`）：
            //   `attempt:2 banned:["A","B"] verdict:"wrong"` → 紧跟着 `attempt:2 fromPaidCache:false letter:"B"`
            // 钱已经花了，但**这一发对这一道已经一文不值**：不再填它、也不留在付费缓存里
            // （留着下一拍复用那道闸照样会丢它，却会让诊断读到一个"还能用"的假格），
            // 改走免费那一支把没被判过的字母点掉；全都判过就放弃 + 冷却。
            // ⚠️ 批次 84 起**多选也过这道闸**。以前它故意只管单选那一族，理由是
            //    "多选题的答案是**一组**字母，其中一个被判错不代表整组不值钱" ——
            //    那个理由当时是对的，因为 `_popupQuizFilledLetter` 只看第一个字母，
            //    名单里那一格根本分不清"判错的是 A 还是 A,C"。
            //    现在两侧记的都是**整组**（规范形 `"A,C"`），比的是组合对组合：
            //    模型这一发回的正是平台判错过的那一组 → 一文不值，不再填第二遍；
            //    回的是一组没试过的（哪怕里面有个字母出现在别组里）→ 照旧填。
            if ((type === 'judge' || type === 'single' || type === 'multiple') && this._popupQuizScopedFlag(stem)) {
              var freshLetter = this._popupQuizFilledLetter(popup, optionItems, answer, type);
              if (freshLetter && (spend.rejected[rkey] || []).indexOf(freshLetter) !== -1) {
                this._notePopupQuizPaid(key, '');
                emitRuntimeLog('warn', 'popup quiz model answer already rejected, not re-filling', {
                  letter: String(freshLetter).slice(0, 8),
                  attempt: this._popupQuizAttempts,
                  banned: (spend.rejected[rkey] || []).slice(0, 6),
                  scoped: 1,
                  // 这一发确实花了钱（请求已经发出去了）；这条日志说的是"不再为它填第二遍"。
                  // 下一拍该免费的那一支接手，本节的封顶由 `_popupQuizAskBudget` 兜住。
                  paid: 1,
                  type: type
                });
                this._answerPopupQuizLocally(popup, optionItems, type, 'model-repeated-rejected', stem);
                return;
              }
            }
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
              // 记下这轮填的答案。下一轮如果同一道题还在，就说明它没被接受。
              // ⚠️ 记的是**实际点到的那个字母**，不是模型原话（判断题原话是 true/正确，
              // 拿它去比已拒名单永远比不中 —— 见 `_popupQuizFilledLetter`）。
              this._popupQuizLastFilled = this._popupQuizFilledLetter(popup, optionItems, answer, type) ||
                String(this._normalizeAnswerValue(answer) || '');
              // 复用成功 → 这一格已经落地，从账本里摘掉（留着会把上一道的答案填给下一道同指纹的题）。
              if (reusedPaid) this._notePopupQuizPaid(key, '');
              // 把「模型答了什么 + 实际匹配到哪个选项 + 选项原文」打进日志。
              // 现场报过「四个选项的题正确答案是 A，却一直选 D」，光看代码猜不出来 ——
              // 这条日志就是为了下次复现时能直接看出是模型答错还是匹配错。
              emitRuntimeLog('info', 'popup quiz answered', {
                attempt: this._popupQuizAttempts,
                rawAnswer: String(this._normalizeAnswerValue(answer) || '').slice(0, 60),
                letter: String(this._popupQuizLastFilled).slice(0, 60),
                // 说清这一发**有没有再扣一次钱**：true = 用的是上一发已经买到的答案，
                // 这一拍一条请求都没发（站点那几秒把选项摘走、现在拼回来了）。
                fromPaidCache: !!reusedPaid,
                type: type,
                optionCount: question.options.length,
                options: question.options.slice(0, 6),
                // 告诉看日志的人"接下来会静一会儿，不是卡死"
                waitMs: scaledMs(POPUP_QUIZ_QUIET_MS)
              });
              // 同一笔账再记进账本 —— 站点「答完就把弹窗收走」那一族里，上面那一格
              // 会在收走的那一刻被清空，只有账本留得住"上一轮填的是哪个字母"。
              this._notePopupQuizFilled(key, this._popupQuizLastFilled, stem, type);
              // 静默 8 秒：给站点足够时间收走弹窗。这段时间内哪怕指纹变了也不碰它，
              // 否则站点重绘 → 指纹变 → 重问重填 → 选项闪烁，就是这么来的。
              this._popupQuizQuietUntil = Date.now() + 8000;
              return;
            }
            // 模型答了但匹配不到任何选项：这是"空转"的真正成因，
            // 必须把选项结构打进日志，否则只能靠猜。
            // ⚠️ 但在打日志之前，先把**这一发买到的答案存进账本**（钱已经花了）。
            // 这一支最常见的成因不是模型答得离谱，而是站点此刻正把选项那一块摘在外面
            // （见 `_notePopupQuizPaid` 那段现场读数）—— 下一拍选项拼回来时直接复用，
            // 不再为同一道题付第二发。存账本这件事**不许跟着日志一起被 5 秒节流挡掉**，
            // 否则节流窗口里那一发就真丢了。
            this._notePopupQuizPaid(key, String(this._normalizeAnswerValue(answer) || ''), stem);
            if (Date.now() - (this._popupQuizLogAt || 0) > 5000) {
              this._popupQuizLogAt = Date.now();
              emitRuntimeLog('error', 'popup quiz answer matched no option', {
                attempt: this._popupQuizAttempts,
                maxAttempts: maxAttempts,
                answer: String(this._normalizeAnswerValue(answer) || '').slice(0, 80),
                // true = 这一发没白花钱，选项回来后会免费复用；
                // false = 模型回的是空答案，账本里没东西可复用。
                storedForReuse: !!(this._popupQuizSpendBucket().paid || {})[key],
                reusedThisRound: !!reusedPaid,
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
      // 放手这一刻的名单是「只算这一道题」的还是与同选项的别的题共用的 —— 现场只有
      // reason + banned 时这两件事长得一模一样（批次 75 的那条 all-options-rejected 就卡在这）。
      var gStem = this._popupQuizStem(popup, this._getOptionItems(popup));
      // 批次 78：放手这一刻，这一道在站点回包里**判对过**哪个字母（'' = 账上没这一格）。
      // 现场那条「A/B 全被判错」要是同时带着一个非空值，那就是闸没挡住，不是平台真判错。
      // ⚠️ 批次 81：这一格**以前只会读成空串**，而空串在这条日志里同时意味着
      //    「平台没说过」与「题干被摘掉、细键退化成粗指纹所以读不到那一格」—— 现场正是被
      //    这句话带偏过一次（上一拍才打完 `reused site-confirmed answer`）。
      //    现在用与记账同一把尺（`_popupQuizRejectKeyBound`）读，退化那一拍也认得自己的账。
      var gKey = this._popupQuizFingerprint(popup);
      var gRkey = this._popupQuizRejectKeyBound(gKey, gStem);
      var gRight = this._popupQuizSiteRightPeek(gRkey);
      emitRuntimeLog('error', 'popup quiz unanswerable, stop asking model', {
        reason: reason || 'unknown',
        attempts: this._popupQuizAttempts,
        // 放手这一刻站点判成了什么 —— 现场那条 all-options-rejected 只有 reason 时，
        // 分不清「平台真把每个选项都判过错」还是「我们的已拒名单自己漂了」。
        verdict: this._popupQuizSiteVerdict(popup) || 'unknown',
        scoped: this._popupQuizScopedFlagBound(gKey, gStem),
        siteRight: gRight,
        banned: (this._popupQuizWrongAnswers || []).slice(0, 6),
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
