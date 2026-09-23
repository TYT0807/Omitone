/* ==========================================================================
 * Omitone page.js 片段 11/15 —— 答题：答案缓存 / 规范化 / 候选与避开错答
 * 来源：原 page.js 中散布的 39 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 答案缓存的读写：正确答案、已知错答、已提交答案
 * 答案的规范化与比对（按题型把答案规整成可比形态）
 * 候选答案与组合排序、避开已知错答、尽力而为的填充
 *
 * 本段的方法（39 个）：
 *   _loadQuizCorrectAnswerCache、_saveQuizCorrectAnswerCache、
 *   _findQuizAnswerInput、_getQuestionIdFromElement、_mapQuizTypeValue、
 *   _getQuestionTypeFromElement、_normalizeQuizTitleKey、
 *   _getQuizTitleKeyFromElement、_getQuizAnswerValue、_canonicalQuizAnswer、
 *   _getOptionStoredAnswerValue、_canonicalQuizAnswerForQuestion、
 *   _addWrongQuizAnswer、_removeWrongQuizAnswer、_isQuizQuestionMarkedCorrect、
 *   _extractDisplayedCorrectAnswer、_rememberCorrectQuizAnswers、
 *   _rememberWrongQuizAnswers、_getCachedQuizAnswer、_getKnownWrongQuizAnswers、
 *   _getConfirmedCachedQuizAnswer、_getSubmittedQuizAnswerForQuestion、
 *   _getLastSubmittedQuizAnswerForQuestion、_rememberSubmittedQuizAnswers、
 *   _areAllQuizQuestionsConfirmedCached、_getKnownWrongCanonicalSet、
 *   _getChoiceCandidateAnswers、_clearKnownWrongQuizAnswersForQuestion、
 *   _isQuizQuestionBestEffort、_fillBestEffortQuizAnswers、
 *   _sortMultiFallbackCombos、_chooseFallbackQuizAnswer、
 *   _getQuestionOptionLetters、_generateChoiceCombinations、
 *   _avoidKnownWrongAnswer、_fillCachedQuizAnswers、_dispatchQuizInputEvents、
 *   _clearQuizQuestionAnswer、_clearUnconfirmedQuizAnswers
 * ========================================================================== */
// @omitone-part-header-end

    _loadQuizCorrectAnswerCache: function (preferredDoc) {
      var key = this._getQuizWorkKey(preferredDoc);
      if (!this._quizCorrectAnswerCache) this._quizCorrectAnswerCache = {};
      if (!this._quizCorrectAnswerCache[key]) {
        var cached = null;
        try {
          cached = JSON.parse(sessionStorage.getItem(key) || 'null');
        } catch (e) {}
        if (!cached || typeof cached !== 'object') cached = {};
        if (!cached.byId || typeof cached.byId !== 'object') cached.byId = {};
        if (!cached.byTitle || typeof cached.byTitle !== 'object') cached.byTitle = {};
        if (!cached.wrongById || typeof cached.wrongById !== 'object') cached.wrongById = {};
        if (!cached.wrongByTitle || typeof cached.wrongByTitle !== 'object') cached.wrongByTitle = {};
        if (!cached.submittedById || typeof cached.submittedById !== 'object') cached.submittedById = {};
        if (!cached.submittedByTitle || typeof cached.submittedByTitle !== 'object') cached.submittedByTitle = {};
        this._quizCorrectAnswerCache[key] = cached;
      }
      return { key: key, data: this._quizCorrectAnswerCache[key] };
    },

    _saveQuizCorrectAnswerCache: function (preferredDoc, data) {
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc);
      var cache = data || loaded.data;
      this._quizCorrectAnswerCache[loaded.key] = cache;
      try {
        sessionStorage.setItem(loaded.key, JSON.stringify(cache));
      } catch (e) {}
    },

    _findQuizAnswerInput: function (el, qid) {
      var doc = (el && el.ownerDocument) || document;
      if (qid && doc.getElementById) {
        var byId = doc.getElementById('answer' + qid);
        if (byId) return byId;
      }
      if (!el || !el.querySelectorAll) return null;
      var inputs = Array.from(el.querySelectorAll('input[type="hidden"], input[id^="answer"], textarea[id^="answer"]'));
      for (var i = 0; i < inputs.length; i++) {
        var id = String(inputs[i].id || inputs[i].name || '');
        if (/^answer\d+/.test(id) && id !== 'answerwqbid') return inputs[i];
      }
      return null;
    },

    _getQuestionIdFromElement: function (el) {
      if (!el) return '';
      try {
        var qid = String((el.getAttribute && (el.getAttribute('qid') || el.getAttribute('data-qid'))) || '').trim();
        if (qid) return qid;

        var wrapper = el.closest ? el.closest('.singleQuesId') : null;
        qid = wrapper && wrapper.getAttribute ? String(wrapper.getAttribute('data') || '').trim() : '';
        if (qid) return qid;

        var hidden = this._findQuizAnswerInput(el, '');
        var id = hidden ? String(hidden.id || hidden.name || '') : '';
        var match = id.match(/^answer(\d+)/);
        if (match) return match[1];

        var badge = el.querySelector ? el.querySelector('.num_option, .num_option_dx') : null;
        var name = badge ? String(badge.getAttribute('name') || '') : '';
        match = name.match(/answer(?:check)?(\d+)/);
        if (match) return match[1];
      } catch (e) {}
      return '';
    },

    _mapQuizTypeValue: function (value) {
      var type = String(value || '').trim();
      if (type === '1') return 'multiple';
      if (type === '3') return 'judge';
      if (type === '2' || type === '9' || type === '10' || type === '14') return 'fill';
      if (type === '4' || type === '5' || type === '6' || type === '7' || type === '8' || type === '17' || type === '18' || type === '26') return 'short';
      return 'single';
    },

    _getQuestionTypeFromElement: function (el, qid) {
      var doc = (el && el.ownerDocument) || document;
      try {
        var typeEl = qid && doc.getElementById ? doc.getElementById('answertype' + qid) : null;
        if (!typeEl && el && el.querySelector) typeEl = el.querySelector('input[id^="answertype"], input[name^="answertype"]');
        return this._mapQuizTypeValue(typeEl ? (typeEl.value || typeEl.getAttribute('value')) : '');
      } catch (e) {
        return 'single';
      }
    },

    _normalizeQuizTitleKey: function (text) {
      return String(text || '')
        .replace(/【[^】]*题】/g, '')
        .replace(/^\d+[.、．\s]+/, '')
        .replace(/\s+/g, '')
        .slice(0, 160);
    },

    _getQuizTitleKeyFromElement: function (el, fallbackTitle) {
      var title = fallbackTitle || '';
      if (!title && el && el.querySelector) {
        var titleEl = el.querySelector('.fontLabel, .mark_name, .question-title, .topicTitle, .question_content, .qContent, .mark_title, .question-name, .title, h3, h4, .stem');
        title = this._cleanQuestionTitle(titleEl ? textOf(titleEl) : '');
      }
      // 与 _parseQuestionElement 同源：只装题号的标题元素会清洗成空串，
      // 此时必须退回整块文本，否则缓存键退化成空、答案缓存全部失效
      if (!title) title = this._cleanQuestionTitle(textOf(el).slice(0, 220));
      return this._normalizeQuizTitleKey(title);
    },

    _getQuizAnswerValue: function (el, qid) {
      var input = this._findQuizAnswerInput(el, qid || this._getQuestionIdFromElement(el));
      return input ? String(input.value || input.getAttribute('value') || '').trim() : '';
    },

    _canonicalQuizAnswer: function (answer, type) {
      var value = this._normalizeAnswerValue(answer);
      if (Array.isArray(value)) value = value.join('');
      var raw = String(value || '').trim();
      if (!raw) return '';

      var judgeAny = this._normalizeJudgeAnswerValue(raw);
      if ((judgeAny === 'true' || judgeAny === 'false') && /^(true|false|yes|no|y|n|1|0|正确|對|对|是|错误|錯|错|否|不正确)/i.test(raw.replace(/\s+/g, ''))) {
        return judgeAny;
      }

      if (type === 'judge') {
        if (judgeAny === 'true' || judgeAny === 'false') return judgeAny;
      }

      if (type === 'multiple') {
        return raw
          .replace(/[，、;；\s]+/g, ',')
          .split(',')
          .join('')
          .toUpperCase()
          .split('')
          .filter(function (item, index, arr) { return /^[A-Z]$/.test(item) && arr.indexOf(item) === index; })
          .sort()
          .join('');
      }

      return raw.toUpperCase();
    },

    _getOptionStoredAnswerValue: function (item) {
      if (!item || !item.querySelector) return '';
      var badge = item.querySelector('.num_option, .num_option_dx');
      if (!badge) return '';
      return String(badge.getAttribute('data') || textOf(badge) || '').trim();
    },

    _canonicalQuizAnswerForQuestion: function (answer, type, question) {
      var canonical = this._canonicalQuizAnswer(answer, type);
      if (!canonical || type !== 'judge' || (canonical !== 'A' && canonical !== 'B')) return canonical;
      if (!question || !question._element) return canonical;

      var item = this._matchOptionItem(question._element, answer);
      var stored = this._getOptionStoredAnswerValue(item);
      var normalized = this._normalizeJudgeAnswerValue(stored || this._extractOptionText(item));
      if (normalized === 'true' || normalized === 'false') return normalized;
      return canonical;
    },

    _addWrongQuizAnswer: function (cache, item) {
      if (!cache || !item || !item.answer) return false;
      if (!cache.wrongById) cache.wrongById = {};
      if (!cache.wrongByTitle) cache.wrongByTitle = {};

      var canonical = item.canonical || this._canonicalQuizAnswer(item.answer, item.type);
      if (!canonical) return false;

      var stored = {
        qid: item.qid || '',
        answer: item.answer,
        canonical: canonical,
        type: item.type || 'single',
        titleKey: item.titleKey || '',
        at: Date.now()
      };
      var changed = false;

      function addToBucket(bucket, key) {
        if (!key) return;
        if (!bucket[key]) bucket[key] = [];
        var exists = bucket[key].some(function (entry) {
          return entry && entry.canonical === canonical;
        });
        if (!exists) {
          bucket[key].push(stored);
          changed = true;
        }
      }

      addToBucket(cache.wrongById, stored.qid);
      addToBucket(cache.wrongByTitle, stored.titleKey);
      return changed;
    },

    _removeWrongQuizAnswer: function (cache, item) {
      if (!cache || !item) return false;
      var canonical = item.canonical || this._canonicalQuizAnswer(item.answer, item.type);
      if (!canonical) return false;
      var changed = false;

      function removeFromBucket(bucket, key) {
        if (!bucket || !key || !bucket[key]) return;
        var before = bucket[key].length;
        bucket[key] = bucket[key].filter(function (entry) {
          return entry && entry.canonical !== canonical;
        });
        if (bucket[key].length !== before) changed = true;
        if (!bucket[key].length) delete bucket[key];
      }

      removeFromBucket(cache.wrongById, item.qid || '');
      removeFromBucket(cache.wrongByTitle, item.titleKey || '');
      return changed;
    },

    /**
     * 判断某题是否被批改为"正确"。
     *
     * 必须保守：宁可漏记，也不能把错题当成对题写进缓存 —— 缓存一旦被污染
     * 就会一直用错误答案，比不缓存更糟。
     *
     * 学习通的结果图标（对照 cxmooc-tools 的 question.ts）：
     *   .fr.dui 答对 / .fr.bandui 半对 / .fr.cuo 答错
     * 必须用 classList 精确比对 token —— `[class*="dui"]` 会把 bandui 也匹配上。
     * 旧的实现只认 marking_dui / correct-icon / right-icon，在学习通真实页面上
     * 一个都命中不了，于是"记住正确答案"这条链路从来没生效过，
     * 每次答题都得重新问一遍模型、白花 token。
     */
    _isQuizQuestionMarkedCorrect: function (node) {
      if (!node || !node.querySelectorAll) return false;

      var scope = node;
      try {
        var block = node.querySelector('.Py_answer, .Py_tk, [class*="Py_answer"], [class*="Py_tk"]');
        if (block) scope = block;
      } catch (e) {}

      var nodes = [];
      try { nodes = Array.from(scope.querySelectorAll('[class]')); } catch (e2) { return false; }
      if (nodes.length > 600) nodes = nodes.slice(0, 600);

      var sawPositive = false;
      for (var i = 0; i < nodes.length; i++) {
        var cls = nodes[i].classList;
        if (!cls) continue;
        if (cls.contains('bandui') || cls.contains('cuo')) return false; // 半对/答错：直接否决
        if (cls.contains('dui') || cls.contains('marking_dui')
          || cls.contains('correct-icon') || cls.contains('right-icon')) {
          sawPositive = true;
        }
      }
      return sawPositive;
    },

    /**
     * 从批改结果区抠出"正确答案"文本。
     *
     * 交卷后学习通把正确答案展示在 .Py_answer / .Py_tk 里，形如
     *   <div class="Py_answer clearfix"><span>正确答案：</span><span class="font14">A</span></div>
     * 各题型呈现细节不同，这里只做保守解析：定位"正确答案"之后的那一段，
     * 取到"我的答案/解析/结尾"为止。解析不出来就返回空串 ——
     * 宁可不缓存，也不缓存错的。
     */
    _extractDisplayedCorrectAnswer: function (node) {
      var block = null;
      try { block = node.querySelector('.Py_answer, .Py_tk, [class*="Py_answer"], [class*="Py_tk"]'); } catch (e) {}
      if (!block) return '';

      var text = textOf(block);
      var at = text.indexOf('正确答案');
      if (at === -1) return '';

      var segment = text.slice(at + 4)
        .replace(/^[：:\s]+/, '')
        .split(/我的答案|你的答案|本题解析|解析/)[0]
        .replace(/[\s\u3000]+/g, ' ')
        .trim();
      if (!segment) return '';

      // 纯选项字母（可能是 "A C" 或 "A,C"）→ 规整成 "AC"
      if (/^[A-F][A-F\s,，、]*$/.test(segment)) {
        var letters = segment.match(/[A-F]/g) || [];
        return Array.from(new Set(letters)).sort().join('');
      }
      return segment.slice(0, 200);
    },

    _rememberCorrectQuizAnswers: function (preferredDoc) {
      // ⚠️ 乱选模式**绝不**写答案缓存。随机答案不是"算出来的结论"，
      // 记进去会污染 AI 模式 —— 用户哪天打开 AI 答题，会被这批垃圾缓存误导。
      if (this._isRandomAnswerMode()) return 0;
      var scanned = [];
      var remembered = 0;
      var self = this;

      function scan(doc) {
        if (!doc || scanned.indexOf(doc) !== -1) return;
        scanned.push(doc);
        var loaded = self._loadQuizCorrectAnswerCache(doc);
        var cache = loaded.data;
        var changed = false;
        var nodes = [];
        try {
          // 选择器读真源 `_quizContainerSelector`（含 `.Cy_TItle`：作业与考试页用这套类名，
          // 缺了它就永远收集不到正确答案）。别手抄 —— 手抄的那份必然漂移。
          nodes = Array.from(doc.querySelectorAll(self._quizContainerSelector));
        } catch (e) {}

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node || !node.querySelector) continue;
          if (!self._isQuizQuestionMarkedCorrect(node)) continue;

          var qid = self._getQuestionIdFromElement(node);
          // 优先读输入域里留存的作答；交卷后输入域可能被清空，则退回解析展示出来的正确答案
          var answer = self._getQuizAnswerValue(node, qid) || self._extractDisplayedCorrectAnswer(node);
          if (!answer) continue;

          var item = {
            qid: qid,
            answer: answer,
            type: self._getQuestionTypeFromElement(node, qid),
            titleKey: self._getQuizTitleKeyFromElement(node, '')
          };
          item.canonical = self._canonicalQuizAnswerForQuestion(answer, item.type, { _element: node });
          if (self._removeWrongQuizAnswer(cache, item)) {
            changed = true;
          }
          if (qid && (!cache.byId[qid] || cache.byId[qid].answer !== answer)) {
            cache.byId[qid] = item;
            changed = true;
            remembered++;
          }
          if (item.titleKey && (!cache.byTitle[item.titleKey] || cache.byTitle[item.titleKey].answer !== answer)) {
            cache.byTitle[item.titleKey] = item;
            changed = true;
          }
        }

        if (changed) self._saveQuizCorrectAnswerCache(doc, cache);
      }

      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      scan(submitDoc || preferredDoc || this._getMainDocument());
      if (preferredDoc && preferredDoc !== submitDoc) scan(preferredDoc);
      if (!preferredDoc) {
        this._walkDocuments(function (doc) {
          scan(doc);
          return false;
        });
      }

      if (remembered > 0) {
        console.log('[Omitone] remembered correct quiz answers:', remembered);
        emitRuntimeLog('info', 'remember correct quiz answers', { count: remembered });
      }
      return remembered;
    },

    _rememberWrongQuizAnswers: function (preferredDoc) {
      // 同上：乱选的"错"没有信息量，记进错误缓存只会让 AI 模式避错避到沟里。
      if (this._isRandomAnswerMode()) return 0;
      var scanned = [];
      var remembered = 0;
      var self = this;

      function scan(doc) {
        if (!doc || scanned.indexOf(doc) !== -1) return;
        scanned.push(doc);
        var loaded = self._loadQuizCorrectAnswerCache(doc);
        var cache = loaded.data;
        var changed = false;
        var nodes = [];
        try {
          nodes = Array.from(doc.querySelectorAll('.TiMu, .questionLi, .questionItem, .mark_item, .questionBox'));
        } catch (e) {}

        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node || !node.querySelector) continue;
          var isWrong = !!node.querySelector('.marking_cuo, [class*="marking_cuo"], [class*="wrong-icon"], [class*="error-icon"]');
          if (!isWrong) continue;

          var qid = self._getQuestionIdFromElement(node);
          var type = self._getQuestionTypeFromElement(node, qid);
          var answer = self._getQuizAnswerValue(node, qid);
          var submitted = null;
          if (!answer) {
            submitted = self._getSubmittedQuizAnswerForQuestion({ _element: node, title: self._getQuizTitleKeyFromElement(node, '') });
            if (!submitted || !submitted.answer) {
              submitted = self._getLastSubmittedQuizAnswerForQuestion({ _element: node, title: self._getQuizTitleKeyFromElement(node, '') }, doc);
            }
            if (submitted && submitted.answer) {
              answer = submitted.answer;
              if (submitted.type) type = submitted.type;
            }
          }
          if (!answer) continue;

          var item = {
            qid: qid,
            answer: answer,
            type: type,
            titleKey: self._getQuizTitleKeyFromElement(node, ''),
            canonical: submitted && submitted.canonical ? submitted.canonical : self._canonicalQuizAnswerForQuestion(answer, type, { _element: node })
          };
          if (self._addWrongQuizAnswer(cache, item)) {
            changed = true;
            remembered++;
          }
        }

        if (changed) self._saveQuizCorrectAnswerCache(doc, cache);
      }

      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      scan(submitDoc || preferredDoc || this._getMainDocument());
      if (preferredDoc && preferredDoc !== submitDoc) scan(preferredDoc);
      if (!preferredDoc) {
        this._walkDocuments(function (doc) {
          scan(doc);
          return false;
        });
      }

      if (remembered > 0) {
        console.log('[Omitone] remembered wrong quiz answers:', remembered);
        emitRuntimeLog('info', 'remember wrong quiz answers', { count: remembered });
      }
      return remembered;
    },

    _getCachedQuizAnswer: function (question, preferredDoc) {
      if (!question || !question._element) return null;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid && loaded.data.byId[qid]) return loaded.data.byId[qid];
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey && loaded.data.byTitle[titleKey]) return loaded.data.byTitle[titleKey];
      return null;
    },

    _getKnownWrongQuizAnswers: function (question, preferredDoc) {
      if (!question || !question._element) return [];
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      var list = [];
      if (qid && loaded.data.wrongById && loaded.data.wrongById[qid]) list = list.concat(loaded.data.wrongById[qid]);
      if (titleKey && loaded.data.wrongByTitle && loaded.data.wrongByTitle[titleKey]) list = list.concat(loaded.data.wrongByTitle[titleKey]);

      var seen = [];
      return list.filter(function (item) {
        if (!item || !item.canonical || seen.indexOf(item.canonical) !== -1) return false;
        seen.push(item.canonical);
        return true;
      });
    },

    _getConfirmedCachedQuizAnswer: function (question, preferredDoc) {
      var cached = this._getCachedQuizAnswer(question, preferredDoc);
      if (!cached || !cached.answer) return null;

      var type = cached.type || (question && question.type) || 'single';
      var canonical = this._canonicalQuizAnswerForQuestion(cached.answer, type, question);
      if (!canonical) return null;

      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      if (wrongSet.indexOf(canonical) !== -1) {
        var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
        if (this._removeWrongQuizAnswer(loaded.data, {
          qid: cached.qid || this._getQuestionIdFromElement(question._element),
          titleKey: cached.titleKey || this._getQuizTitleKeyFromElement(question._element, question.title),
          answer: cached.answer,
          type: type,
          canonical: canonical
        })) {
          this._saveQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument, loaded.data);
        }
        emitRuntimeLog('warn', 'prefer confirmed correct answer over wrong cache', { qid: cached.qid || '', titleKey: cached.titleKey || '' });
      }
      return cached;
    },

    _getSubmittedQuizAnswerForQuestion: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      return key && this._quizCurrentAnswerValues ? this._quizCurrentAnswerValues[key] : null;
    },

    _getLastSubmittedQuizAnswerForQuestion: function (question, preferredDoc) {
      if (!question || !question._element) return null;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid && loaded.data.submittedById && loaded.data.submittedById[qid]) return loaded.data.submittedById[qid];
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey && loaded.data.submittedByTitle && loaded.data.submittedByTitle[titleKey]) return loaded.data.submittedByTitle[titleKey];
      return null;
    },

    _rememberSubmittedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      // ⚠️ 乱选模式同样不写。
      //
      // 一开始我以为这条不能守 —— 怕"不记已提交"会导致重复提交。**那是错的**：
      // `submittedById` 全代码只有一个读取点（`_getLastSubmittedQuizAnswerForQuestion`），
      // 用途是「题目被判错、而答案域为空时，回退用上次提交的答案来记录错误」——
      // 它**不驱动提交流程**。乱选写的随机答案一旦被当成"错答案"记下来，
      // 将来用户换成 AI 答题会被这些无信息量的记录误导。
      if (this._isRandomAnswerMode()) return 0;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || (questions[0] && questions[0]._element && questions[0]._element.ownerDocument));
      var cache = loaded.data;
      if (!cache.submittedById) cache.submittedById = {};
      if (!cache.submittedByTitle) cache.submittedByTitle = {};
      var saved = 0;

      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        if (!question || !question._element) continue;
        var value = this._getQuizQuestionFilledValue(preferredDoc || null, question);
        if (!value) continue;
        var qid = this._getQuestionIdFromElement(question._element);
        var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
        var type = question.type || this._getQuestionTypeFromElement(question._element, qid);
        var item = {
          qid: qid,
          answer: value,
          canonical: this._canonicalQuizAnswerForQuestion(value, type, question),
          type: type,
          titleKey: titleKey,
          at: Date.now()
        };
        if (qid) cache.submittedById[qid] = item;
        if (titleKey) cache.submittedByTitle[titleKey] = item;
        saved++;
      }

      if (saved > 0) {
        this._saveQuizCorrectAnswerCache(preferredDoc || (questions[0] && questions[0]._element && questions[0]._element.ownerDocument), cache);
        emitRuntimeLog('info', 'remember submitted quiz answers', { count: saved });
      }
      return saved;
    },

    _areAllQuizQuestionsConfirmedCached: function (questions, preferredDoc) {
      if (!questions || !questions.length) return false;
      for (var i = 0; i < questions.length; i++) {
        if (!this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) return false;
      }
      return true;
    },

    _getKnownWrongCanonicalSet: function (question, type, preferredDoc) {
      var wrongs = this._getKnownWrongQuizAnswers(question, preferredDoc);
      var seen = [];
      for (var i = 0; i < wrongs.length; i++) {
        var item = wrongs[i];
        if (!item) continue;
        var variants = [
          item.canonical,
          this._canonicalQuizAnswer(item.answer, item.type || type),
          this._canonicalQuizAnswer(item.answer, type),
          this._canonicalQuizAnswerForQuestion(item.answer, type, question)
        ];
        for (var j = 0; j < variants.length; j++) {
          if (variants[j] && seen.indexOf(variants[j]) === -1) seen.push(variants[j]);
        }
      }
      return seen;
    },

    _getChoiceCandidateAnswers: function (question, type) {
      var candidates = [];
      var el = question && question._element;
      var items = el ? this._getOptionItems(el) : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var stored = this._getOptionStoredAnswerValue(item);
        var text = this._extractOptionText(item);
        var value = stored;
        if (type === 'judge') {
          var judge = this._normalizeJudgeAnswerValue(stored || text);
          if (judge === 'true' || judge === 'false') value = judge;
        }
        if (!value) value = String.fromCharCode(65 + i);
        value = String(value || '').trim();
        if (value && candidates.indexOf(value) === -1) candidates.push(value);
      }

      if (!candidates.length) {
        var letters = this._getQuestionOptionLetters(question);
        for (var j = 0; j < letters.length; j++) candidates.push(letters[j]);
      }
      return candidates;
    },

    _clearKnownWrongQuizAnswersForQuestion: function (question, preferredDoc, reason) {
      if (!question || !question._element) return false;
      var loaded = this._loadQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument);
      var qid = this._getQuestionIdFromElement(question._element);
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      var changed = false;

      if (qid && loaded.data.wrongById && loaded.data.wrongById[qid]) {
        delete loaded.data.wrongById[qid];
        changed = true;
      }
      if (titleKey && loaded.data.wrongByTitle && loaded.data.wrongByTitle[titleKey]) {
        delete loaded.data.wrongByTitle[titleKey];
        changed = true;
      }
      if (changed) {
        this._saveQuizCorrectAnswerCache(preferredDoc || question._element.ownerDocument, loaded.data);
        emitRuntimeLog('warn', 'clear exhausted wrong answer cache', { qid: qid || '', reason: reason || '' });
      }
      return changed;
    },

    /**
     * 这道题是否该"放弃继续折腾"（best-effort）。
     *
     * 触发条件：同一道题已经在错答记录里攒够了失败次数 —— 模型与本地兜底
     * 试过多轮都没被平台接受。继续换答案只会让整卷永远提交不出去
     * （章节小测的提交前置是"每题都有值"），用户看到的就是"一直卡住"。
     *
     * 达到阈值后：不再为它扩错答列表、也不再进 LLM 请求，直接给本地最优猜测，
     * 让整卷能提交、章节能往下走。
     * **一定有日志**（见 _fillBestEffortQuizAnswers 与 _avoidKnownWrongAnswer），
     * 也一定是可恢复的：阈值只影响本次作答，换卷 / 重做会重新计数。
     */
    _isQuizQuestionBestEffort: function (question, preferredDoc) {
      if (!question) return false;
      var max = Number(this.configs.quizQuestionMaxMisses || 3);
      if (!(max > 0)) max = 3;
      var known = this._getKnownWrongQuizAnswers(question, preferredDoc || null);
      return known.length >= max;
    },

    /**
     * 给"已放弃继续折腾"的题补上本地最优猜测。
     *
     * 为什么必须补：章节小测的提交前置条件是**每道题都有值**
     * （_areQuizAnswersFilled），少一道就永远不提交 —— 那才是真正的"卡住"。
     * 这些题已经不进 LLM 请求（见 _handleQuiz），所以必须在这里填，
     * 否则表单不满、整卷原地打转。
     *
     * 代价说明（不藏着）：这道题会被填上一个**本地猜的**答案，
     * 可能仍然不对。这是"跳过该题继续"换来的：整卷能交出去，
     * 而不是被一道题钉死在原地。
     */
    _fillBestEffortQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var filledCount = 0;
      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        if (!question || !question._element) continue;
        if (!this._isQuizQuestionBestEffort(question, preferredDoc)) continue;
        if (this._wasQuizQuestionAnsweredThisRun(question)) continue;
        var type = question.type || this._getQuestionTypeFromElement(question._element, this._getQuestionIdFromElement(question._element));
        if (type !== 'multiple' && type !== 'single' && type !== 'judge') continue;
        var guess = this._chooseFallbackQuizAnswer(type, question, preferredDoc || null, '', type === 'multiple' ? 2 : 1);
        if (type === 'multiple') this._fillMultiChoice(question._element, guess);
        else this._fillChoice(question._element, guess, 'radio');
        var value = this._getQuizQuestionFilledValue(preferredDoc || null, question);
        if (value) {
          this._markQuizQuestionAnsweredThisRun(question, 'best-effort', value, type);
          filledCount++;
        }
      }
      if (filledCount) {
        emitRuntimeLog('warn', 'quiz filled best-effort guesses for repeatedly-wrong questions', { count: filledCount });
      }
      return filledCount;
    },

    /**
     * 多选 fallback 组合的排序：决定"上一个组合（被判错）之后，下一个先试哪个"。
     *
     * 两个必须守住的点（都是踩过的坑）：
     *
     * 1. **目标规模至少 2**。原来 `targetSize = preferredSize || 2`，
     *    而 preferredSize 常常是 `canonical.length` —— 模型只选了一个字母时就是 1，
     *    于是排序把**所有"只选一项"的组合排在前面**：逐个 A、B、C、D 试过去，
     *    每次都只选一个、每次都被判错。用户看到的"多选一直选不对"就是这么来的。
     * 2. **低于最少项数的组合排到最后，但保留**。直接过滤掉它们会出事：
     *    题型名带"不定项"时单选是正确答案，删掉就永远答不对。
     *    排序偏好即可，不必硬删。
     */
    _sortMultiFallbackCombos: function (combos, preferredSize, minSelections) {
      if (!combos || !combos.length) return combos || [];
      var min = Math.max(1, minSelections || 1);
      var targetSize = Math.min(Math.max(2, preferredSize || 2), 6);
      return combos.sort(function (a, b) {
        var belowA = a.length < min ? 1 : 0;
        var belowB = b.length < min ? 1 : 0;
        if (belowA !== belowB) return belowA - belowB;
        var da = Math.abs(a.length - targetSize);
        var db = Math.abs(b.length - targetSize);
        if (da !== db) return da - db;
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
    },

    _chooseFallbackQuizAnswer: function (type, question, preferredDoc, avoidCanonical, preferredSize) {
      if (type !== 'single' && type !== 'judge' && type !== 'multiple') return '';
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      var candidates = this._getChoiceCandidateAnswers(question, type);

      if (type === 'single' || type === 'judge') {
        for (var i = 0; i < candidates.length; i++) {
          var candidateCanonical = this._canonicalQuizAnswerForQuestion(candidates[i], type, question);
          if (candidateCanonical && wrongSet.indexOf(candidateCanonical) === -1) return candidates[i];
        }

        this._clearKnownWrongQuizAnswersForQuestion(question, preferredDoc, 'single-judge-exhausted');
        for (var j = 0; j < candidates.length; j++) {
          var fallbackCanonical = this._canonicalQuizAnswerForQuestion(candidates[j], type, question);
          if (fallbackCanonical && fallbackCanonical !== avoidCanonical) return candidates[j];
        }
        if (candidates.length) return candidates[0];
        if (type === 'judge') return avoidCanonical === 'true' ? 'false' : 'true';
        return 'A';
      }

      var combos = this._sortMultiFallbackCombos(
        this._generateChoiceCombinations(candidates),
        preferredSize,
        this._getMultiChoiceMinSelections(question && question._element)
      );
      for (var k = 0; k < combos.length; k++) {
        var comboCanonical = this._canonicalQuizAnswerForQuestion(combos[k], type, question);
        if (comboCanonical && wrongSet.indexOf(comboCanonical) === -1) return combos[k].split('');
      }

      // ⚠️ 这里**故意不清**已知错答记录（旧实现在这里 clear 了）。
      // 清掉等于把"这卷已经试过哪些答案"整段忘掉：下一轮 `禁:` 为空，
      // 模型很可能又给出同一个错答案 → 判错 → 再清 → 无限打转，
      // 而且 _isQuizQuestionBestEffort 的计数也被抹平，跳过机制永远触发不了。
      // 记着它反而有用：`禁:` 会继续推着模型换答案；换无可换时日志说清楚。
      emitRuntimeLog('warn', 'multiple choice combos exhausted, keep wrong history', {
        wrongs: wrongSet.join(',').slice(0, 120),
        combos: combos.length
      });
      for (var m = 0; m < combos.length; m++) {
        var fallbackComboCanonical = this._canonicalQuizAnswerForQuestion(combos[m], type, question);
        if (fallbackComboCanonical && fallbackComboCanonical !== avoidCanonical) return combos[m].split('');
      }
      return combos.length ? combos[0].split('') : [];
    },

    _getQuestionOptionLetters: function (question) {
      var count = question && Array.isArray(question.options) ? question.options.length : 0;
      if (!count && question && question._element) count = this._getOptionItems(question._element).length;
      count = Math.max(0, Math.min(count || 0, 6));
      var letters = [];
      for (var i = 0; i < count; i++) letters.push(String.fromCharCode(65 + i));
      return letters;
    },

    _generateChoiceCombinations: function (letters) {
      var combos = [];
      var count = letters ? letters.length : 0;
      if (!count) return combos;
      for (var size = 1; size <= count; size++) {
        var total = Math.pow(2, count);
        for (var mask = 1; mask < total; mask++) {
          var current = [];
          for (var i = 0; i < count; i++) {
            if (mask & (1 << i)) current.push(letters[i]);
          }
          if (current.length === size) combos.push(current.join(''));
        }
      }
      return combos;
    },

    _avoidKnownWrongAnswer: function (answer, type, question, preferredDoc) {
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      var canonical = this._canonicalQuizAnswerForQuestion(answer, type, question);

      if (!canonical && (type === 'single' || type === 'judge' || type === 'multiple')) {
        var fallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, '', type === 'multiple' ? 2 : 1);
        emitRuntimeLog('warn', 'llm empty answer fallback', { type: type, fallback: Array.isArray(fallback) ? fallback.join('') : fallback });
        return fallback;
      }

      if (!wrongSet.length) return answer;
      if (!canonical || wrongSet.indexOf(canonical) === -1) return answer;

      if (type === 'judge') {
        var replacement = canonical === 'true' ? 'false' : 'true';
        if (wrongSet.indexOf(replacement) !== -1) {
          this._clearKnownWrongQuizAnswersForQuestion(question, preferredDoc, 'judge-exhausted');
          emitRuntimeLog('warn', 'wrong answer cache exhausted, use judge fallback', { wrongs: wrongSet.join(','), fallback: replacement });
          return replacement;
        }
        console.warn('[Omitone] avoid repeated wrong judge answer', canonical, '->', replacement);
        emitRuntimeLog('warn', 'avoid repeated wrong judge answer', { from: canonical, to: replacement });
        return replacement;
      }

      if (type === 'single') {
        var candidates = this._getChoiceCandidateAnswers(question, type);
        for (var i = 0; i < candidates.length; i++) {
          var candidateCanonical = this._canonicalQuizAnswerForQuestion(candidates[i], type, question);
          if (candidateCanonical && wrongSet.indexOf(candidateCanonical) === -1) {
            console.warn('[Omitone] avoid repeated wrong single answer', canonical, '->', candidates[i]);
            emitRuntimeLog('warn', 'avoid repeated wrong single answer', { from: canonical, to: candidates[i] });
            return candidates[i];
          }
        }
        var singleFallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, canonical, 1);
        emitRuntimeLog('warn', 'wrong answer cache exhausted, use single fallback', { wrongs: wrongSet.join(','), fallback: singleFallback });
        return singleFallback || answer;
      }

      if (type === 'multiple') {
        // 已连续答错到"放弃折腾"的题：直接给本地最优猜测，不再扩 `禁:` 列表。
        // 见 _isQuizQuestionBestEffort —— 这是"跳过该题继续"的落点，
        // 目的是让整卷能提交出去，而不是让一道题把整卷钉死在原地。
        if (this._isQuizQuestionBestEffort(question, preferredDoc)) {
          var bestEffort = this._chooseFallbackQuizAnswer(type, question, preferredDoc, '', 2);
          emitRuntimeLog('warn', 'multiple choice best-effort answer, stop retrying', {
            index: (question && question.index != null) ? question.index : '',
            fallback: Array.isArray(bestEffort) ? bestEffort.join('') : bestEffort
          });
          return bestEffort;
        }
        var multiCandidates = this._getChoiceCandidateAnswers(question, type);
        var combos = this._generateChoiceCombinations(multiCandidates);
        var preferredSize = canonical ? canonical.length : 0;
        this._sortMultiFallbackCombos(combos, preferredSize || 2, this._getMultiChoiceMinSelections(question && question._element));
        for (var j = 0; j < combos.length; j++) {
          var comboCanonical = this._canonicalQuizAnswerForQuestion(combos[j], type, question);
          if (comboCanonical && wrongSet.indexOf(comboCanonical) === -1) {
            var replacementMulti = combos[j].split('');
            console.warn('[Omitone] avoid repeated wrong multiple answer', canonical, '->', replacementMulti.join(''));
            emitRuntimeLog('warn', 'avoid repeated wrong multiple answer', { from: canonical, to: replacementMulti.join('') });
            return replacementMulti;
          }
        }
        var multiFallback = this._chooseFallbackQuizAnswer(type, question, preferredDoc, canonical, preferredSize || 2);
        emitRuntimeLog('warn', 'wrong answer cache exhausted, use multiple fallback', { wrongs: wrongSet.join(','), fallback: Array.isArray(multiFallback) ? multiFallback.join('') : multiFallback });
        return multiFallback && multiFallback.length ? multiFallback : answer;
      }

      return answer;
    },

    _fillCachedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var restored = 0;
      for (var i = 0; i < questions.length; i++) {
        var cached = this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc);
        if (!cached || !cached.answer) continue;
        var type = cached.type || questions[i].type;
        console.log('[Omitone] restore cached correct answer', i, type, cached.answer);
        if (type === 'single' || type === 'judge') this._fillChoice(questions[i]._element, cached.answer, 'radio');
        else if (type === 'multiple') this._fillMultiChoice(questions[i]._element, cached.answer);
        else if (type === 'fill') this._fillText(questions[i]._element, cached.answer);
        else if (type === 'short') this._fillTextarea(questions[i]._element, cached.answer);
        var filledValue = this._getQuizQuestionFilledValue(preferredDoc || null, questions[i]);
        if (filledValue) {
          this._markQuizQuestionAnsweredThisRun(questions[i], 'confirmed-cache', filledValue, type);
          restored++;
        }
      }
      if (restored > 0) emitRuntimeLog('info', 'restore cached correct answers', { count: restored });
      return restored;
    },

    _dispatchQuizInputEvents: function (node) {
      if (!node) return;
      try {
        var win = (node.ownerDocument && node.ownerDocument.defaultView) || window;
        node.dispatchEvent(new win.Event('input', { bubbles: true }));
        node.dispatchEvent(new win.Event('change', { bubbles: true }));
      } catch (e) {}
    },

    _clearQuizQuestionAnswer: function (question) {
      var el = question && question._element;
      if (!el) return false;
      var doc = el.ownerDocument || document;
      var qid = this._getQuestionIdFromElement(el);
      var cleared = false;

      try {
        var hidden = qid && doc.getElementById ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = '';
          hidden.setAttribute('value', '');
          this._dispatchQuizInputEvents(hidden);
          cleared = true;
        }

        var optionNodes = [];
        if (qid && doc.querySelectorAll) optionNodes = optionNodes.concat(Array.from(doc.querySelectorAll('.choice' + qid)));
        if (el.querySelectorAll) {
          optionNodes = optionNodes.concat(Array.from(el.querySelectorAll('.num_option, .num_option_dx, [role="radio"], [role="checkbox"]')));
        }
        optionNodes.forEach(function (node) {
          node.classList.remove('check_answer');
          node.classList.remove('check_answer_dx');
          node.setAttribute('aria-checked', 'false');
          node.setAttribute('aria-pressed', 'false');
          var item = node.closest ? node.closest('li, label, [role="radio"], [role="checkbox"]') : null;
          if (item) {
            item.setAttribute('aria-checked', 'false');
            item.setAttribute('aria-pressed', 'false');
          }
        });

        Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]')).forEach(function (input) {
          input.checked = false;
          app._dispatchQuizInputEvents(input);
        });

        Array.from(el.querySelectorAll('input[type="text"], input:not([type])')).forEach(function (input) {
          input.value = '';
          input.setAttribute('value', '');
          app._dispatchQuizInputEvents(input);
        });

        Array.from(el.querySelectorAll('textarea')).forEach(function (textarea) {
          textarea.value = '';
          textarea.textContent = '';
          app._dispatchQuizInputEvents(textarea);
        });
      } catch (e) {}

      return cleared;
    },

    _clearUnconfirmedQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var cleared = 0;
      for (var i = 0; i < questions.length; i++) {
        if (this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) continue;
        if (this._clearQuizQuestionAnswer(questions[i])) cleared++;
      }
      if (cleared > 0) emitRuntimeLog('info', 'clear stale quiz answers', { count: cleared });
      return cleared;
    },
