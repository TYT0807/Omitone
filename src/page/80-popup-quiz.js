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
 * 本段的方法（11 个）：
 *   _findContinueStudyButton、_tryContinueStudyPrompt、_activePopupBlock、
 *   _popupQuizBlocksPlayback、_popupQuizFingerprint、_getPopupQuizMaxAttempts、
 *   _checkPopupQuiz、_handlePopupQuiz、_giveUpPopupQuiz、_detectPopupQuizType、
 *   _fillPopupAnswer
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
        if (key === this._popupQuizSolvedKey && now - (this._popupQuizSolvedAt || 0) < POPUP_QUIZ_QUIET_MS) {
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


    _getPopupQuizMaxAttempts: function () {
      var max = Number(this.configs && this.configs.popupQuizMaxAttempts);
      return max > 0 ? max : 3;
    },


    _checkPopupQuiz: function () {
      var selectors = [
        '.ans-pop-quiz',
        '.pop-quiz',
        '.video-quiz',
        '.ans-job-pop',
        '.ans-topic',
        '.vjs-overlay',
        '.ans-attach',
        '.popDiv',
        '.layui-layer',
        '[class*="pop"][class*="quiz"]',
        '[class*="question"][class*="pop"]'
      ];

      function searchAll(doc, depth) {
        if (!doc || depth > 3) return null;

        for (var i = 0; i < selectors.length; i++) {
          var node = doc.querySelector(selectors[i]);
          if (node && app._isSubmitConfirmDialog(node)) continue;
          // 播放器容器 / 含 video 的浮层（水印、广告、倍速提示）不是题。
          // .vjs-overlay 这类选择器极易命中视频浮层，误判后插件会把它当题反复问模型。
          if (node && node.querySelector && node.querySelector('video')) continue;
          if (node && visible(node) && textOf(node).length > 5) return node;
        }

        var sections = doc.querySelectorAll('div, section');
        for (var j = 0; j < sections.length; j++) {
          if (!visible(sections[j])) continue;
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

        var question = {
          index: 0,
          type: type,
          title: popupText.slice(0, 300),
          options: [],
          // ⚠️ 必须带：不带的话每轮重试都是**一模一样的请求**，模型自然每轮都回
          // 同一个答案（实测表现就是「答错之后一直选 D」），重试等于白问。
          // 普通答题路径一直带着它（见 _requestAnswers），弹题这条路原先漏了。
          previousWrongAnswers: (this._popupQuizWrongAnswers || []).slice()
        };

        question.options = optionItems.map(this._extractOptionText.bind(this)).filter(Boolean);

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
              this._popupQuizAttempts = 0;
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
                waitMs: POPUP_QUIZ_QUIET_MS
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
            this._quizForceSkipUntil = Date.now() + 8000;
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
      this._popupQuizBlockedUntil = Date.now() + 60000;
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
