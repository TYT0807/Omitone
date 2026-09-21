/* ==========================================================================
 * Omitone page.js 片段 13/15 —— 抠题 / 填答 / 提交确认
 * 来源：原 page.js 中散布的 39 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * **`_questionSelectors` 是选择器真源**（它在 10-config-state.js —— 所有非方法属性都在那儿）
 * 从 DOM 里抠题干与选项、判定题型
 * 单选 / 多选 / 判断 / 填空的填答实现
 * 提交按钮与站点确认弹窗（#workpop / #popok）的处理
 *
 * 本段的方法（39 个）：
 *   _collectQuestionContainers、_cleanQuestionTitle、_parseQuestionElement、
 *   _detectQuestionType、_getOptionItems、_pairOptionControls、_extractOptionText、
 *   _normalizeAnswerValue、_normalizeJudgeAnswerValue、_isJudgeOptionMatch、
 *   _fillAnswers、_inferOptionLetter、_matchOptionItem、_clickOptionItem、
 *   _isChoiceValueSelected、_choiceInputTypeFor、_getMultiChoiceMinSelections、
 *   _expandMultiChoiceLetters、_normalizeChoiceAnswerValues、_applyChoiceAnswer、
 *   _fillChoice、_clearMultiChoiceSelection、_fillMultiChoice、_fillText、
 *   _fillTextarea、_resolveQuizAnswerDocument、_getQuizQuestionFilledValue、
 *   _isQuizQuestionFilled、_isQuizQuestionFilledWithKnownWrong、
 *   _clearKnownWrongFilledQuizAnswers、_areQuizAnswersFilled、_findButtonByText、
 *   _resolveQuizSubmitDocument、_shouldAutoSubmitQuiz、_maybeSubmitQuiz、
 *   _isSubmitConfirmDialog、_findDialogButtonByText、_checkSubmitConfirmDialog、
 *   _handleSubmitConfirmDialog
 * ========================================================================== */
// @omitone-part-header-end

    _collectQuestionContainers: function (doc) {
      if (!doc || !doc.querySelectorAll) return [];
      var selectors = this._questionSelectors;

      for (var i = 0; i < selectors.length; i++) {
        var found;
        try {
          found = doc.querySelectorAll(selectors[i]);
        } catch (e) {
          continue;
        }
        if (!found || !found.length) continue;

        var candidates = Array.from(found).filter(function (node) {
          return visible(node) || textOf(node).length > 0;
        });
        if (!candidates.length) continue; // 抢占成功但全是空壳 → 继续试下一个选择器

        // 去掉互相嵌套的重复项：若某候选的祖先也是候选，只保留最外层。
        // （原来的实现用 `item.querySelector('.questionLi, .TiMu')` 判断，会误杀
        //   "外层容器内确实包含题目子节点" 的合法结构，这里改为按候选集合自身判断。）
        var set = new Set(candidates);
        var unique = candidates.filter(function (item) {
          if (!item || !item.closest) return true;
          var parent = item.parentElement;
          while (parent) {
            if (set.has(parent)) return false; // 有祖先也是候选 → 交给祖先
            parent = parent.parentElement;
          }
          return true;
        });

        if (unique.length) return unique;
      }
      return [];
    },


    /**
     * 清洗题干文本：去掉题号、题型前缀等噪声。
     *
     * 学习通把题号单独放在 `.fontLabel` 之类的元素里（内容就是 "1."），
     * 把题型写成 `【单选题】` 前缀。这两段对模型都是冗余信息 ——
     * 题号由提示词里的序号给出，题型由题型代号（s/m/j/f/t）给出。
     */
    _cleanQuestionTitle: function (text) {
      return String(text || '')
        .replace(/^\d+[.、．)）\s]+/, '')
        .replace(/^【[^】]*】\s*/, '')
        .replace(/^(单选题|多选题|多项选择题|不定项选择题|判断题|填空题|简答题|问答题|论述题)\s*[.、．:：]?\s*/, '')
        .trim();
    },


    _parseQuestionElement: function (el, index) {
      if (!el) return null;

      var title = '';
      var titleSelectors = [
        '.fontLabel', '.mark_name',
        // 学习通真实结构：题号在 .fontLabel，题干与题号同处 .Pt1 / .Zy_TItle。
        // 注意属性选择器区分大小写，[class*="title"] 匹配不到 "Zy_TItle"，所以要显式列出。
        '.Pt1', '.Zy_TItle',
        '.question-title', '.topicTitle', '.question_content', '.qContent', '.mark_title',
        '.question-name', '.title', 'h3', 'h4', '.stem', '[class*="question"]', '[class*="title"]'
      ];
      for (var i = 0; i < titleSelectors.length; i++) {
        var titleEl = el.querySelector(titleSelectors[i]);
        if (!titleEl) continue;

        var candidate = this._cleanQuestionTitle(textOf(titleEl));
        // 关键：`.fontLabel` 常常只装了题号（"1."），剥掉序号后就是空串。
        // 旧实现拿到第一个命中的选择器就 break，于是题干最终是空的 ——
        // 模型只看到选项、看不到问题，只能瞎猜。所以这里要求候选足够长，
        // 不合格就继续试下一个选择器。
        if (candidate.length >= 4) {
          title = candidate;
          break;
        }
      }
      if (!title) {
        // 所有选择器都不合格时退回整块容器文本。容器里混着选项，
        // 所以先在第一个选项标记处截断，避免把 A/B/C/D 抄进题干。
        var raw = textOf(el).slice(0, 200);
        var firstOption = raw.search(/(?:^|\s)[A-F][.、．)）]\s/);
        if (firstOption > 0) raw = raw.slice(0, firstOption);
        title = this._cleanQuestionTitle(raw);
      }

      var options = [];
      var items = this._getOptionItems(el);
      for (var j = 0; j < items.length; j++) {
        var optionText = this._extractOptionText(items[j]);
        if (optionText && options.indexOf(optionText) === -1) options.push(optionText);
      }

      if (options.length < 2) {
        // 注意 textOf() 已经把换行压成了空格，所以旧写法 `/[A-F][.、．\s]+[^\n]+/g`
        // 里的 `[^\n]+` 会从第一个选项标记一路吞到字符串末尾 —— 结果是只匹配到一次，
        // 把 A~D 全部塞进同一个"选项"里。改为先定位所有选项标记，再按标记区间切分。
        var rawText = textOf(el);
        var marks = [];
        var marker = /[A-F][.、．)）]\s*/g;
        var hit;
        while ((hit = marker.exec(rawText))) {
          marks.push({ end: marker.lastIndex, index: hit.index });
        }
        for (var k = 0; k < marks.length; k++) {
          var stop = k + 1 < marks.length ? marks[k + 1].index : rawText.length;
          var cleaned = rawText.slice(marks[k].end, stop).trim();
          if (cleaned && options.indexOf(cleaned) === -1) options.push(cleaned);
        }
      }

      if (!title && !options.length) return null;
      return {
        index: index,
        type: this._detectQuestionType(el),
        title: title,
        options: options,
        _element: el
      };
    },


    _detectQuestionType: function (el) {
      var text = textOf(el);
      var typeName = String(el.getAttribute('typename') || el.getAttribute('typeName') || '').trim();
      if (!typeName) {
        var chapterTypeEl = el.querySelector('.newZy_TItle');
        if (chapterTypeEl) typeName = textOf(chapterTypeEl);
      }
      var radios = el.querySelectorAll('input[type="radio"], [role="radio"]');
      var checkboxes = el.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      var textInputs = el.querySelectorAll('input[type="text"], input:not([type])');
      var textareas = el.querySelectorAll('textarea');
      var richEditors = el.querySelectorAll('iframe');

      if (/多选|多项|不定项|多重/.test(typeName)) return 'multiple';
      if (typeName.indexOf('判断') !== -1) return 'judge';
      if (typeName.indexOf('填空') !== -1) return 'fill';
      if (/简答|问答|论述|名词解释|计算|分析|作文/.test(typeName)) return 'short';

      if (checkboxes.length >= 2) return 'multiple';
      if (textInputs.length >= 1 && !radios.length && !checkboxes.length) return 'fill';
      if ((textareas.length >= 1 || richEditors.length >= 1) && !radios.length && !checkboxes.length) return 'short';
      if (radios.length === 2 && /判断|对错|正确|错误|是|否/.test(text)) return 'judge';
      if (radios.length >= 2) return 'single';
      if (/多选|多项|不定项/.test(text)) return 'multiple';
      if (text.indexOf('判断') !== -1 || text.indexOf('对错') !== -1) return 'judge';
      if (text.indexOf('填空') !== -1) return 'fill';
      if (/简答|问答|论述|名词解释/.test(text)) return 'short';
      return 'single';
    },


    _getOptionItems: function (el) {
      if (!el || !el.querySelectorAll) return [];

      // 学习通的选项容器（两套命名，对照 cxmooc-tools 的 question.ts 校正）：
      //   课程页：   .Zy_ulTop > li.clearfix / .Zy_ulBottom > li / .Zy_ulTk > li
      //   作业考试： .Cy_ulTop li / .Cy_ulBottom li / .Cy_ulTk li
      //
      // ⚠️ 顺序上 <li> 必须排在 <label> 之前：
      // _clickOptionItem 要从**选项元素自身**读 qid（`item.getAttribute('qid')`）
      // 才能写隐藏答案域 #answer{qid}。学习通把 qid 挂在 <li> 上而不是内层 <label> 上，
      // 一旦返回 label，qid 取不到 → 隐藏域永远为空 →
      // _areQuizAnswersFilled 判定"未填写" → 答案填了也永远不提交。
      var listSelectors = [
        '.Zy_ulTop > li', '.Zy_ulBottom > li', '.Zy_ulTk > li',
        '.Cy_ulTop li', '.Cy_ulBottom li', '.Cy_ulTk li',
        '[class*="before-after"]', '.answerBg',
        'li.clearfix'
      ];
      for (var i = 0; i < listSelectors.length; i++) {
        var found;
        try { found = Array.from(el.querySelectorAll(listSelectors[i])); } catch (e) { continue; }
        var usable = found.filter(function (node) { return textOf(node).length > 0; });
        if (usable.length) return this._pairOptionControls(el, usable);
      }

      var labels = Array.from(el.querySelectorAll('label')).filter(function (n) { return textOf(n).length > 0; });
      if (labels.length) return labels;

      // 视频内嵌弹题 / 非学习通原生结构：选项就是普通 <li> 或 .xxx-option，
      // 既没有 qid 也没有 .num_option 徽标（字母只能从文本前缀或 input value 推）。
      // 走到这里说明上面的专用选择器全没命中，此时返回 [] 会让"扫到了题却抠不出选项"，
      // AI 拿到一道没有选项的题，答了也无处可填 —— 必须继续往下捞。
      // 只取最内层节点：否则整个选项容器会被当成一个选项。
      var looseSelectors = ['[class*="option"]', '[class*="choice"]', 'li'];
      for (var k = 0; k < looseSelectors.length; k++) {
        var loose = [];
        try { loose = Array.from(el.querySelectorAll(looseSelectors[k])); } catch (e) { continue; }
        var leaf = loose.filter(function (node) {
          if (textOf(node).length === 0) return false;
          return !node.querySelector('li, [class*="option"], [class*="choice"]');
        });
        if (leaf.length) return leaf;
      }

      var roles = Array.from(el.querySelectorAll('[role="radio"], [role="checkbox"]'));
      if (roles.length) return roles;

      return [];
    },


    /**
     * 作业/考试页「文本与控件分离」的补偿。
     *
     * 结构上：选项**文本**在 `.Cy_ulTop` 的 li 里，可点的 **input 在 `.Cy_ulBottom` 的 li**，
     * 是**两个分开的 ul**。而 `_clickOptionItem` 靠 `item.querySelector('input')` 找控件，
     * 拿到文本那一列时 input 恒为 null —— 一下都没点到，站点一个答案都收不到。
     * 表现是"题抠对了、日志也打了 clicked option，但一道都没答上"，然后空转。
     *
     * 参考实现（cxmooc-tools 的 `cxExamSelectQuestion`）干脆把 input 直接当选项节点、
     * 文本另按位置取。这里不动整体结构，只把控件**按索引**配对挂到文本节点上：
     * 文本 / qid / 徽标继续从文本节点读，点击时改用配到的 input。
     *
     * 只在「本列一个控件都没有」且「另一列数量刚好对得上」时才配 ——
     * 对不上宁可不配，免得错位把答案点到别的选项上（那比不答更糟）。
     */
    _pairOptionControls: function (el, items) {
      if (!el || !items || !items.length) return items;

      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].querySelector && items[i].querySelector('input')) return items;
      }

      var controls = [];
      try {
        controls = Array.from(el.querySelectorAll('li')).filter(function (n) {
          return n.querySelector && n.querySelector('input[type="radio"], input[type="checkbox"]');
        });
      } catch (e) { return items; }
      if (controls.length !== items.length) return items;

      for (var k = 0; k < items.length; k++) {
        if (!items[k]) continue;
        try {
          items[k]._optionInput = controls[k].querySelector('input[type="radio"], input[type="checkbox"]');
        } catch (e2) {}
      }
      return items;
    },


    _extractOptionText: function (node) {
      if (!node) return '';
      var text = '';

      if (node.querySelector) {
        var chapterAnswer = node.querySelector('.fl.after');
        if (chapterAnswer) text = textOf(chapterAnswer);
        var answer = node.querySelector('.answer_p');
        if (answer) text = textOf(answer);
        // 作业/考试页的选项文本包在 <a> 里（cxmooc-tools 用 `a.fl, a` 取）
        if (!text) {
          var link = node.querySelector('a.fl, a');
          if (link) text = textOf(link);
        }
      }
      if (!text) {
        text = String((node.getAttribute && node.getAttribute('aria-label')) || textOf(node) || '');
      }

      // 注意：这里原本写作 /^(选择|閫夐」)\s*/ —— 第二个分支是 "选项" 的 GBK 乱码残留
      // （UTF-8 字节被按 GBK 解码的结果），导致以"选项"开头的选项文本永远不会被剥掉前缀。
      text = text.replace(/^(选择|选项)\s*/, '');
      text = text.replace(/^[A-F][.、．\s]+/, '');
      text = text.replace(/(选择|选项)$/, '');
      return text.trim();
    },


    _normalizeAnswerValue: function (answer) {
      if (answer && typeof answer === 'object' && answer.answer !== undefined) return answer.answer;
      if (answer && typeof answer === 'object' && answer.text !== undefined) return answer.text;
      return answer;
    },


    _normalizeJudgeAnswerValue: function (answer) {
      var raw = String(this._normalizeAnswerValue(answer) || '').trim();
      if (!raw) return '';
      var compact = raw.replace(/\s+/g, '').toLowerCase();
      if (/^(true|yes|y|1|正确|對|对|是|答案[:：]?正确|答案[:：]?对|答案[:：]?是)/i.test(compact)) return 'true';
      if (/^(false|no|n|0|错误|錯|错|否|不正确|答案[:：]?错误|答案[:：]?错|答案[:：]?否)/i.test(compact)) return 'false';
      if (/^a$/i.test(compact)) return 'a';
      if (/^b$/i.test(compact)) return 'b';
      return '';
    },


    _isJudgeOptionMatch: function (item, answer, optionText, dataValue, letterValue) {
      var normalized = this._normalizeJudgeAnswerValue(answer);
      if (!normalized) return false;

      var data = String(dataValue || '').trim().toLowerCase();
      var letter = String(letterValue || '').trim().toLowerCase();
      var text = String(optionText || '').replace(/\s+/g, '').toLowerCase();

      if (normalized === 'a' || normalized === 'b') {
        return letter === normalized || data === normalized;
      }

      var optionBool = '';
      if (/^(true|1|yes|y)$/.test(data) || /^(正确|對|对|是)$/.test(text)) optionBool = 'true';
      if (/^(false|0|no|n)$/.test(data) || /^(错误|錯|错|否|不正确)$/.test(text)) optionBool = 'false';
      return optionBool === normalized;
    },


    _fillAnswers: function (answers, questions, preferredDoc) {
      var normalized = [];
      for (var i = 0; i < answers.length; i++) {
        var item = answers[i];
        if (item && typeof item === 'object' && item.answer !== undefined) {
          normalized.push({ index: item.index != null ? item.index : i, type: item.type, answer: item.answer });
        } else if (item && typeof item === 'object' && Array.isArray(item.answers)) {
          for (var j = 0; j < item.answers.length; j++) normalized.push(item.answers[j]);
        } else {
          normalized.push({ index: i, type: questions[i] ? questions[i].type : 'single', answer: this._normalizeAnswerValue(item) });
        }
      }

      var self = this;
      normalized.forEach(function (answerItem) {
        var question = questions[answerItem.index];
        if (!question || !question._element) return;

        var type = answerItem.type || question.type;
        if (self._wasQuizQuestionAnsweredThisRun(question) && self._getConfirmedCachedQuizAnswer(question, preferredDoc || null)) {
          emitRuntimeLog('info', 'skip llm answer for confirmed correct question', { index: answerItem.index });
          return;
        }
        var finalAnswer = self._avoidKnownWrongAnswer(answerItem.answer, type, question, preferredDoc || null);
        console.log('[Omitone] fill question', answerItem.index, 'type', type, 'answer', finalAnswer);
        if (finalAnswer === null || finalAnswer === undefined || String(finalAnswer).trim() === '') {
          self._clearQuizQuestionAnswer(question);
          self._unmarkQuizQuestionAnsweredThisRun(question);
          return;
        }
        if (type === 'single' || type === 'judge') self._fillChoice(question._element, finalAnswer, 'radio');
        else if (type === 'multiple') self._fillMultiChoice(question._element, finalAnswer);
        else if (type === 'fill') self._fillText(question._element, finalAnswer);
        else if (type === 'short') self._fillTextarea(question._element, finalAnswer);
        var questionDoc = question._element && question._element.ownerDocument ? question._element.ownerDocument : null;
        var filledValue = self._getQuizQuestionFilledValue(preferredDoc || questionDoc || null, question);
        if (filledValue) {
          self._markQuizQuestionAnsweredThisRun(question, 'llm', filledValue, type);
        }
      });
    },


    /**
     * 推断某个选项对应的字母（A/B/C…）。
     *
     * 学习通把字母放在 .num_option 徽标上，但**视频内嵌弹题没有这个徽标** ——
     * 字母只出现在 input 的 value 或选项文本前缀里。1.0.11 只认徽标，
     * 于是弹题场景下 letter 恒为空串，模型回答一个裸字母 "A" 时一个选项都匹配不上，
     * 表现为"AI 问了但从不填空"。这里按可靠度从高到低依次尝试。
     */
    _inferOptionLetter: function (item, index) {
      if (!item) return '';

      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      if (badge) {
        var badgeRaw = String(badge.getAttribute('data') || textOf(badge) || '').trim();
        if (/^[A-F]$/i.test(badgeRaw)) return badgeRaw.toUpperCase();
      }

      var attrs = ['aria-label', 'data', 'data-answer', 'data-value', 'value'];
      for (var a = 0; a < attrs.length; a++) {
        var attr = String((item.getAttribute && item.getAttribute(attrs[a])) || '').trim();
        if (!attr) continue;
        if (/^[A-F]$/i.test(attr)) return attr.toUpperCase();
        var attrMatch = attr.match(/^([A-F])\s*[.、．)）:：]/i);
        if (attrMatch) return attrMatch[1].toUpperCase();
      }

      // <input type="radio" value="A"> —— 原生表单（含弹题）最常见的字母来源
      var input = item.querySelector ? item.querySelector('input') : null;
      if (input) {
        var inputValue = String(input.value || input.getAttribute('value') || '').trim();
        if (/^[A-F]$/i.test(inputValue)) return inputValue.toUpperCase();
        if (/^[A-F]\s*[.、．)）]/.test(inputValue)) return inputValue.charAt(0).toUpperCase();
      }

      // 文本前缀 "A." / "A、" / "(A)"
      var rawText = textOf(item);
      var textMatch = rawText.match(/^\s*\(?\s*([A-F])\s*[.、．)）:：]/);
      if (textMatch) return textMatch[1].toUpperCase();

      return '';
    },


    _matchOptionItem: function (el, answer, forcedType) {
      var items = this._getOptionItems(el);
      if (!items.length) return null;

      var answerStr = String(this._normalizeAnswerValue(answer) || '').trim();
      var answerUpper = answerStr.toUpperCase();
      var isLetterOnly = /^[A-F]$/.test(answerUpper);
      // forcedType：弹窗题的题型由调用方按控件判定好了，
      // 这里再用 _detectQuestionType 重判一遍可能与它不一致（判断题匹配分支因此失效）
      var questionType = forcedType || this._detectQuestionType(el);
      // 位置兜底只在"所有选项都认不出字母"时启用：
      // 学习通的选项永远按 A,B,C… 顺序排列，此时第 n 个就是第 n 个字母。
      // 一旦有任何选项认出了字母，就以认出来的为准，绝不靠位置猜。
      var anyKnownLetter = false;
      for (var p = 0; p < items.length; p++) {
        if (this._inferOptionLetter(items[p], p)) { anyKnownLetter = true; break; }
      }
      var usePositionFallback = !anyKnownLetter && items.length >= 2 && items.length <= 6;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var letter = '';
        var badge = item.querySelector && item.querySelector('.num_option');
        var dataValue = '';
        var labelValue = '';
        if (badge) {
          dataValue = String(badge.getAttribute('data') || '').trim();
          labelValue = String(textOf(badge) || '').trim();
          letter = (/^[A-F]$/i.test(dataValue) ? dataValue : labelValue).toUpperCase();
        }
        if (!letter) letter = this._inferOptionLetter(item, i);
        if (!letter && usePositionFallback) letter = String.fromCharCode(65 + i);

        var optionText = this._extractOptionText(item);
        if (questionType === 'judge' && this._isJudgeOptionMatch(item, answer, optionText, dataValue, letter)) return item;
        if (isLetterOnly && letter === answerUpper) return item;
        if (!isLetterOnly && optionText && (optionText === answerStr || optionText.indexOf(answerStr) !== -1 || answerStr.indexOf(optionText) !== -1)) return item;
      }
      return null;
    },


    /**
     * 点选一个选项 —— 调用返回后，这个选项**一定**处于"已选中"状态（幂等）。
     *
     * 为什么必须幂等（踩过的坑）：原来的顺序是"先按当前状态取反写 class，
     * 再 item.click() + 内层徽标 click()"。单选无所谓，但**复选是开关** ——
     * 站点自己的 click 处理会再切换一次，以及"点 li + 点徽标"本身就是两次，
     * 偶数次点击等于没点。表现是多选**随机少选一项**（用户报的"只选一个"），
     * 接着被判错，再进入"重试还是只选一个"的死循环。
     *
     * 现在的顺序：① 先点击，让站点自己的处理跑起来（它可能在点击时重绘、写隐藏域）；
     * ② 再把**终态**强制写回（class / aria / input.checked / #answer{qid}）。
     * 这样站点那边怎么切都不影响最终状态。
     */
    _clickOptionItem: function (item, inputType) {
      if (!item) return;
      var doc = item.ownerDocument || document;
      // qid 的**三级回退**（历史上只认第一级，于是作业页永远写不进隐藏域）。
      //
      //   ① 选项自身带 qid —— 章节测验的 <li qid="..."> 走这条
      //   ② 向上找最近的 [qid] 祖先 —— 作业/考试页把 qid 挂在容器
      //      `.Cy_TItle[qid]` 上，选项 <li> 自己是干净的
      //   ③ `_getQuestionIdFromElement` —— 它还会试 `.singleQuesId[data]`、
      //      `#answer{qid}` 的 id、以及 `.num_option` 徽标的 name
      //
      // 为什么必须回退：写隐藏域那一段原本要求 `qid && badge` **同时**成立，
      // 而真实作业页两样都没有（无徽标、<li> 无 qid）。于是点击动作照做、
      // 日志照打 "clicked option"，但 #answer{qid} 一直是空串 ——
      // `_getQuizQuestionFilledValue` 返回 ''，`_areQuizAnswersFilled` 判 false，
      // 整卷永不提交。表现就是"AI 扫到题、点了选项、然后什么都不发生"。
      var qid = String((item.getAttribute && item.getAttribute('qid')) || '').trim();
      if (!qid && item.closest) {
        var qidHost = item.closest('[qid], [data-qid]');
        qid = String((qidHost && qidHost.getAttribute && (qidHost.getAttribute('qid') || qidHost.getAttribute('data-qid'))) || '').trim();
      }
      if (!qid) qid = String(this._getQuestionIdFromElement(item) || '').trim();

      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      var rawValue = badge ? String(badge.getAttribute('data') || textOf(badge)).trim() : '';
      var letter = /^[A-F]$/i.test(rawValue) ? rawValue.toUpperCase() : rawValue;
      // 没有徽标时（作业/考试页的常态）用 _inferOptionLetter 取字母：
      // 它已经支持 input.value / aria-label / 文本前缀 "A." 等来源。
      // 拿不到就留空 —— 宁可让上层判"未填写"，也不要往隐藏域写错答案。
      if (!letter) {
        var idx = -1;
        try {
          var siblings = item.parentElement ? Array.from(item.parentElement.children) : [];
          idx = siblings.indexOf(item);
        } catch (eIdx) {}
        letter = String(this._inferOptionLetter(item, idx < 0 ? 0 : idx) || '');
      }

      // 控件自身的 value 才是隐藏域的**权威值**，字母只是"认选项"用的。
      //
      // 判断题就是典型：选项文本是 `A. 正确` / `B. 错误`，字母能推出 A/B，
      // 但站点在隐藏域里要的是 `true` / `false`（radio 的 value），
      // 写字母进去会让平台收到一个它不认识的答案 —— 判分必然错。
      // 所以：控件 value 是 `true/false` 这种非字母语义值时，以它为准。
      var controlValue = '';
      try {
        var ctrl = item.querySelector ? item.querySelector('input[type="radio"], input[type="checkbox"], input[type="hidden"]') : null;
        if (!ctrl && item._optionInput) ctrl = item._optionInput;
        if (ctrl) controlValue = String(ctrl.value || ctrl.getAttribute('value') || '').trim();
      } catch (eCtrl) {}
      if (controlValue && !/^[A-F]$/i.test(controlValue)) {
        letter = controlValue;
      }

      // ① 点击：先让站点自己的 handler 跑完
      var input = item.querySelector ? item.querySelector('input[type="' + inputType + '"]') : null;
      if (!input && item._optionInput) {
        var pairedType = String((item._optionInput.getAttribute && item._optionInput.getAttribute('type')) || '').toLowerCase();
        if (pairedType === inputType) input = item._optionInput;
      }

      if (item._optionInput) {
        // 文本与控件分离（作业/考试页）：文本节点上没有任何可点的东西，
        // 直接点配对到的 input —— 事件从 input 冒泡，
        // 站点把 handler 挂在 input / label / li 上都收得到。
        // 必须**先点再置 checked**：复选上"先置 true 再 click"会被再切一次，反而变未选。
        try { item._optionInput.click(); } catch (ePair) {}
      }

      if (input) {
        try { input.checked = true; } catch (e0) {}
        this._dispatchQuizInputEvents(input);
      }

      if (!item._optionInput) {
        try { item.click(); } catch (e) {}
        if (item.querySelector) {
          var clickTarget = item.querySelector('.num_option, .num_option_dx, label, .fl.after');
          // 徽标可能就在 item 自身这一层，重复点同一个元素只会多点一次（复选上就是再取消）
          if (clickTarget && clickTarget !== item) {
            try { clickTarget.click(); } catch (e2) {}
          }
        }
      }

      // ② 写回终态
      //
      // 拆成两段的原因（原本 `qid && badge` 一个大 if 把两件事焊死了）：
      //   - 徽标那组操作（.choice{qid} 的 class、aria）**只在有 badge 时**做，
      //     因为它就是给徽标用的；
      //   - 写隐藏域 #answer{qid} **只要有 qid 就必须做** —— 那是平台提交时读的字段，
      //     也是插件自己判"填没填"的依据。作业/考试页没有徽标，
      //     焊在一起就等于"点了选项但隐藏域永远空着"，整卷永不提交。
      if (qid && badge) {
        var group = '.choice' + qid;
        if (inputType === 'radio') {
          Array.from(doc.querySelectorAll(group)).forEach(function (node) {
            node.classList.remove('check_answer');
          });
          badge.classList.add('check_answer');
          Array.from(item.parentElement ? item.parentElement.children : []).forEach(function (sibling) {
            if (sibling !== item) {
              sibling.setAttribute('aria-checked', 'false');
              sibling.setAttribute('aria-pressed', 'false');
            }
          });
        } else {
          // 复选**只加不减**：取消是 _clearMultiChoiceSelection 的职责。
          badge.classList.add('check_answer_dx');
        }
      }
      if (qid) {
        item.setAttribute('aria-checked', 'true');
        item.setAttribute('aria-pressed', 'true');

        var hidden = doc.getElementById('answer' + qid);
        if (hidden) {
          var value = letter;
          if (inputType !== 'radio') {
            // 隐藏域必须是**全部已选项**的并集，而不是刚点的那一个字母 ——
            // 否则多选提交上去永远只有最后一项。
            value = '';
            if (badge) {
              Array.from(doc.querySelectorAll('.choice' + qid)).forEach(function (node) {
                if (node.classList.contains('check_answer_dx')) {
                  value += String(node.getAttribute('data') || '').trim();
                }
              });
            } else {
              // 无徽标（作业/考试页）：只能按"本组当前勾选的 input"汇总。
              // 先清空再按勾选态重算，避免把上一轮遗留的字母一起带上。
              var picked = [];
              try {
                var ipts = Array.from(doc.querySelectorAll('input[type="' + inputType + '"][name="answer' + qid + '"]'));
                ipts.forEach(function (ip, order) {
                  if (!ip.checked) return;
                  var l = String(ip.value || ip.getAttribute('value') || '').trim();
                  if (!/^[A-F]$/i.test(l)) l = String.fromCharCode(65 + order);
                  picked.push(l.toUpperCase());
                });
              } catch (ePick) {}
              picked.sort();
              value = picked.join('');
            }
          }
          if (value) {
            hidden.value = value;
            this._dispatchQuizInputEvents(hidden);
            // 记下**我们写进去的值**。站点自己的 handler 可能在这之后又改一遍 ——
            // 现场实测：我们按 A→B→C→D 点，最终字段却是 DBAC（既非点击序也非字母序），
            // 说明有人在我们之后重写了它。把 ours 与提交前那条 answer field 日志一比，
            // 就能立刻分辨「我们的值生效了」还是「被平台覆盖了」。
            console.log('[Omitone] answer field written qid=', qid, 'ours=', value);
          }
        }
      }

      if (input) {
        try { input.checked = true; } catch (e3) {}
      }
      console.log('[Omitone] clicked option qid=', qid, 'letter=', letter, 'type=', inputType);
    },


    /**
     * 某个答案（字母或选项文本）对应的选项**当前是否已选中**。
     *
     * 只给"点完之后校验"用（多选重灾区）。**认不出来时返回 true** ——
     * 宁可少修一次，也不要对已经选中的复选项再点一下：复选上多点一次就是取消，
     * 那正是要修掉的病。
     */
    _isChoiceValueSelected: function (root, value, type) {
      if (!root) return true;
      var item = this._matchOptionItem(root, value, type);
      if (!item) return false;
      var badge = item.querySelector ? item.querySelector('.num_option, .num_option_dx') : null;
      if (badge && badge.classList) {
        if (badge.classList.contains('check_answer_dx') || badge.classList.contains('check_answer')) return true;
      }
      var aria = item.getAttribute ? String(item.getAttribute('aria-checked') || '') : '';
      if (aria === 'true') return true;
      var input = item.querySelector ? item.querySelector('input[type="checkbox"], input[type="radio"]') : null;
      if (!input && item._optionInput) input = item._optionInput; // 文本与控件分离时控件挂在配对节点上
      if (input) return !!input.checked;
      return true;
    },


    /**
     * 该用哪种控件去点：'radio' / 'checkbox'。
     *
     * 题型明确时照题型走；题型未知（弹题那条路）时按**控件形态**判 ——
     * 页面里有复选就按复选填，这与原 `_fillPopupAnswer` 的行为一致。
     */
    _choiceInputTypeFor: function (root, type) {
      if (type === 'multiple') return 'checkbox';
      if (type === 'single' || type === 'judge') return 'radio';
      var checkboxes = 0;
      if (root && root.querySelectorAll) {
        try { checkboxes = root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length; } catch (e) {}
      }
      return checkboxes ? 'checkbox' : 'radio';
    },


    /**
     * 多选题"最少该选几项"。
     *
     * ⚠️ **不能一律钉成 2**：学习通的"不定项选择题"允许多选也允许单选，
     * 钉成 2 会把本来正确的单答案判成无效，反而更卡。所以按题型名区分，
     * 认不出来时取 1（保守，宁可维持旧行为）。
     */
    _getMultiChoiceMinSelections: function (root) {
      var name = '';
      if (root && root.getAttribute) {
        name = String(root.getAttribute('typename') || root.getAttribute('typeName') || '').trim();
        if (!name && root.querySelector) {
          var titleEl = root.querySelector('.newZy_TItle');
          if (titleEl) name = textOf(titleEl);
        }
      }
      if (!name && root) name = textOf(root).slice(0, 80);
      if (/不定项/.test(name)) return 1;
      if (/多选|多项|多重/.test(name)) return 2;
      return 1;
    },


    /**
     * 把一个字母扩成"含它的相邻组合"，用于模型只给了一个字母的多选题。
     *
     * 这是**纯本地**补救：不发新请求，因此不产生任何 token。
     * 依据是"复选题两项答案远比一项常见"。
     *
     * ⚠️ `banned` 是**必须**传的：本函数是确定性的（答 "A" 永远补成 "AB"），
     * 如果不避开已经判错的组合，"换别的组合"这句承诺就是空的 —— 实测会无限重交。
     */
    _expandMultiChoiceLetters: function (letters, min, root, banned) {
      var out = (letters || []).slice();
      var target = Math.max(2, min || 2);
      var total = this._getOptionItems(root).length;
      if (total < 2 || total > 8) total = 6;
      var pool = [];
      for (var i = 0; i < total; i++) pool.push(String.fromCharCode(65 + i));

      // 已经判错的组合绝不再补出来 —— 否则会陷入
      //「补成 AB → 判错 → AB 进禁选 → 又补成 AB」的死循环（现场表现是反复重交）。
      var bannedSet = banned || [];
      var isBanned = function (combo) {
        if (!bannedSet.length) return false;
        var sorted = combo.slice().sort();
        var canonical = null;
        try { canonical = this._canonicalQuizAnswerForQuestion(sorted, 'multiple', { _element: root }); } catch (e) {}
        if (!canonical) canonical = sorted.join('');
        return bannedSet.indexOf(canonical) !== -1;
      }.bind(this);

      for (var j = 0; j < out.length && out.length < target; j++) {
        var idx = pool.indexOf(out[j]);
        if (idx < 0) continue;
        // 优先"紧邻的下一个"，其次上一个，最后再往后挑 —— 相邻组合最常见
        var candidates = [pool[idx + 1], pool[idx - 1], pool[idx + 2], pool[idx + 3]];
        for (var c = 0; c < candidates.length && out.length < target; c++) {
          var cand = candidates[c];
          if (!cand || out.indexOf(cand) !== -1) continue;
          if (isBanned(out.concat([cand]))) continue;   // ← 这个组合判错过，换下一个候选
          out.push(cand);
        }
      }
      return out.sort();
    },


    /**
     * 把一个答案规整成"要点的选项列表"。
     *
     * 兼容模型的各种写法：数组 `["A","C"]`、带分隔符 `"A,C"`/`"A、C"`、
     * **不带分隔符的连写** `"AC"`、以及整段选项文本。
     * 最后一种在弹题里很常见（模型不认字母表，直接抄选项文字）。
     */
    _normalizeChoiceAnswerValues: function (answer, type, root) {
      var value = this._normalizeAnswerValue(answer);
      var values = [];
      if (Array.isArray(value)) {
        values = value.map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean);
      } else {
        var raw = String(value == null ? '' : value).trim();
        if (!raw) return [];
        if (/^[A-F,，、;；\s]+$/i.test(raw)) {
          values = raw.replace(/[，、;；\s]+/g, ',').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          // "AC" 这种连写：长度 > 1 的单个 token 按单字母拆开
          if (values.length === 1 && values[0].length > 1) values = values[0].split('');
        } else {
          values = [raw];
        }
      }

      // 去重：多选里同一个字母点两次 = 取消（复选是开关）
      var seen = {};
      values = values.filter(function (v) {
        var key = String(v).toUpperCase();
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });

      if (type === 'multiple') {
        var letters = values.filter(function (v) { return /^[A-F]$/i.test(v); }).map(function (v) { return v.toUpperCase(); });
        // ⚠️ 必须**排序**，不能沿用模型给的顺序。
        // 本文件对多选答案的"规范形式"是排过序的（见 `_canonicalQuizAnswer` 末尾的 `.sort()`），
        // 而**点选顺序决定平台隐藏域 `#answer{qid}` 的内容** ——
        // 模型回 ["D","B","A","C"] 时我们按原序点，隐藏域就成了 "DBAC"，
        // 而规范形式是 "ABCD"。现场实测：顺序碰巧对时能过、不对就判错重交（用户报"时灵时不灵"）。
        if (letters.length > 1) letters = letters.slice().sort();
        var min = this._getMultiChoiceMinSelections(root);
        if (letters.length >= 1 && letters.length < min) {
          // ⚠️ 补选前**必须**先拿禁选集合。_expandMultiChoiceLetters 是确定性的
          //（答 "A" 永远补成 "AB"），而补选发生在 _avoidKnownWrongAnswer **之后** ——
          // 于是「补成 AB → 判错 → AB 进禁选 → 模型仍答 A → 又补成 AB」无限循环。
          // 现场表现：作业页反复重交（用户报「重复刷」）。
          var bannedSet = [];
          try {
            bannedSet = this._getKnownWrongCanonicalSet({ _element: root }, 'multiple', root.ownerDocument) || [];
          } catch (eB) { bannedSet = []; }
          // ⚠️ **只在模型给的组合已经试过且失败时**才补选。
          //
          // 1.1.5 加这个补选的目的，看它自己的记录是「让重试别总在"只选一项"里打转」——
          // 是个**分散重试**的启发式，**不是**平台约束。
          // 而用户实测推翻了那个隐含前提：**多选只选一个照样能提交成功**。
          // 所以第一次就凭空补一项 = 造一个模型没给的答案 —— 那正是判错的一个来源。
          // 现在只在"这个组合已经判错过"时才补（那种情况下不补就只会原地打转）。
          var mineCanonical = letters.slice().sort().join('');
          var alreadyFailed = bannedSet.indexOf(mineCanonical) !== -1;
          var expanded = alreadyFailed
            ? this._expandMultiChoiceLetters(letters, min, root, bannedSet)
            : letters;
          if (expanded.length > letters.length) {
            emitRuntimeLog('warn', 'multiple choice answer expanded locally', {
              from: letters.join(''), to: expanded.join(''), minSelections: min,
              avoidedWrong: bannedSet.length ? bannedSet.join(',') : ''
            });
          } else if (bannedSet.length) {
            emitRuntimeLog('warn', 'multiple choice expansion blocked by wrong-answer cache', {
              letters: letters.join(''), minSelections: min, wrongs: bannedSet.join(',')
            });
          }
          var texts = values.filter(function (v) { return !/^[A-F]$/i.test(v); });
          return expanded.concat(texts);
        }
        // 不需要补选时，也按**排序后**的字母返回 ——
        // 与 `_canonicalQuizAnswer` 的规范形式保持一致，否则隐藏域又变成乱序。
        if (letters.length) {
          return letters.concat(values.filter(function (v) { return !/^[A-F]$/i.test(v); }));
        }
      }
      return values;
    },


    /**
     * 选项答案填充的**唯一入口**（单选 / 判断 / 多选共用，章节小测与视频弹题共用）。
     *
     * 参数：
     *   root      题目元素或弹窗元素
     *   answer    模型给的答案（数组 / 字母 / 连写字母 / 选项文本都行）
     *   type      题型；传空串表示"交给 _matchOptionItem 自己判"（判断题要靠它）
     *   inputType 强制控件类型（'radio' / 'checkbox'）；不传则按题型或控件形态推
     *
     * 返回**成功点上的选项数**；0 表示一个都没匹配上（调用方不该点提交）。
     */
    _applyChoiceAnswer: function (root, answer, type, inputType) {
      if (!root) return 0;
      var kind = inputType || this._choiceInputTypeFor(root, type);
      var values = this._normalizeChoiceAnswerValues(answer, type, root);
      if (!values.length) return 0;

      // 复选先清空：上一轮留下的选择会让"这轮点了几项"完全失真
      if (kind === 'checkbox') this._clearMultiChoiceSelection(root);

      var clicked = 0;
      for (var i = 0; i < values.length; i++) {
        var item = this._matchOptionItem(root, values[i], type);
        if (!item) continue;
        this._clickOptionItem(item, kind);
        clicked++;
      }

      // 校验 + 修补：站点自己的 handler 可能把刚点上的又切掉了（复选重灾区）。
      // 只补"该选却没选中"的 —— 绝不碰已经选中的，避免把复选又切回去。
      if (kind === 'checkbox' && clicked > 1) {
        for (var j = 0; j < values.length; j++) {
          if (this._isChoiceValueSelected(root, values[j], type)) continue;
          var again = this._matchOptionItem(root, values[j], type);
          if (!again) continue;
          this._clickOptionItem(again, kind);
        }
      }
      return clicked;
    },


    _fillChoice: function (el, answer, inputType) {
      // type 传空串：让 _matchOptionItem 自己判题型 —— 判断题的匹配分支靠它，
      // 硬编码成 'single' 会让"正确/错误"这类答案匹配不上（老实现就是这样绕开的）。
      var clicked = this._applyChoiceAnswer(el, answer, '', inputType);
      if (!clicked) console.warn('[Omitone] no matching option for answer', answer, textOf(el).slice(0, 120));
    },


    _clearMultiChoiceSelection: function (el) {
      if (!el) return;
      var doc = el.ownerDocument || document;
      var qid = this._getQuestionIdFromElement(el);
      try {
        var badges = qid ? doc.querySelectorAll('.choice' + qid) : el.querySelectorAll('.num_option_dx, [role="checkbox"]');
        Array.from(badges).forEach(function (node) {
          node.classList.remove('check_answer_dx');
          var item = node.closest ? node.closest('li, label, [role="checkbox"]') : null;
          if (item) {
            item.setAttribute('aria-checked', 'false');
            item.setAttribute('aria-pressed', 'false');
          }
        });
        Array.from(el.querySelectorAll('input[type="checkbox"]')).forEach(function (input) {
          input.checked = false;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        var hidden = qid && doc.getElementById ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = '';
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },


    _fillMultiChoice: function (el, answers) {
      this._applyChoiceAnswer(el, answers, 'multiple', 'checkbox');
    },


    _fillText: function (el, answer) {
      var value = this._normalizeAnswerValue(answer);
      var inputs = Array.from(el.querySelectorAll('input[type="text"], input:not([type])'));
      if (!inputs.length) return;

      var values = [];
      if (Array.isArray(value)) {
        values = value.map(function (item) {
          return String(this._normalizeAnswerValue(item) == null ? '' : this._normalizeAnswerValue(item)).trim();
        }.bind(this));
      } else {
        var raw = String(value == null ? '' : value).trim();
        if (raw.indexOf('|||') !== -1) {
          values = raw.split('|||').map(function (part) { return part.trim(); });
        } else {
          values = [raw];
        }
      }

      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      inputs.forEach(function (input, i) {
        var text = '';
        if (values.length) {
          text = values[i] != null ? values[i] : values[values.length - 1];
        }
        if (setter && setter.set) setter.set.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // 部分页面靠 keyup/blur 监听把可见框内容同步到隐藏答案域
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      });

      // 关键：填空题同样要写隐藏答案域 #answer{qid}，否则插件判定"未填写"不会提交，
      // 提交时平台读隐藏域也会丢答案
      try {
        var doc = el.ownerDocument || document;
        var qid = this._getQuestionIdFromElement(el);
        var hidden = (qid && doc.getElementById) ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden) {
          hidden.value = values.join('');
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },


    _fillTextarea: function (el, answer) {
      var value = String(this._normalizeAnswerValue(answer) || '');
      var textareas = Array.from(el.querySelectorAll('textarea'));
      var textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      textareas.forEach(function (textarea) {
        if (textareaSetter && textareaSetter.set) textareaSetter.set.call(textarea, value);
        else textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      });

      var iframes = Array.from(el.querySelectorAll('iframe'));
      iframes.forEach(function (frame) {
        try {
          var body = frame.contentDocument && frame.contentDocument.body;
          if (body) {
            body.innerHTML = '<p>' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
          }
        } catch (e) {}
      });

      // 简答题同样要同步隐藏答案域：平台提交时读的是 #answer{qid}，
      // 只写 textarea/富文本编辑器的话，页面自身 JS 不一定会把内容回填进去。
      try {
        var doc = el.ownerDocument || document;
        var qid = this._getQuestionIdFromElement(el);
        var hidden = (qid && doc.getElementById) ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden && value) {
          hidden.value = value;
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    },


    _resolveQuizAnswerDocument: function (preferredDoc) {
      // 最后一个兜底 `|| document` 不能省：题目可能就在顶层文档里（页面没有 #iframe，
      // 或者题目被 _walkDocuments 在更深的 iframe 中找到）。
      // 旧实现此时返回 null，_getQuizQuestionFilledValue 随即返回空串，
      // 于是"答案明明已经填进 DOM 却判定未填写"，_areQuizAnswersFilled 永远 false，
      // 提交被永久阻塞 —— 表现为答题跑完但从不交卷。
      var doc = preferredDoc || this._getMainDocument() || document;
      if (!doc) return null;
      try {
        var innerFrame = doc.getElementById && doc.getElementById('frame_content');
        if (innerFrame) {
          var innerDoc = innerFrame.contentDocument || (innerFrame.contentWindow && innerFrame.contentWindow.document);
          if (innerDoc) return innerDoc;
        }
      } catch (e) {}
      return doc;
    },


    _getQuizQuestionFilledValue: function (preferredDoc, question) {
      var doc = this._resolveQuizAnswerDocument(preferredDoc);
      if (!doc || !question || !question._element) return '';
      var qid = this._getQuestionIdFromElement(question._element);
      if (!qid) return '';
      var hidden = doc.getElementById ? doc.getElementById('answer' + qid) : null;
      var hiddenValue = hidden ? String(hidden.value || '').trim() : '';
      // 隐藏域优先（平台提交时读的就是它），但它为空时必须回退到可见控件：
      // 简答题走的是富文本编辑器，页面自身的 JS 未必把内容同步进隐藏域；
      // 只认隐藏域会导致"明明填了却判定未填写"，从而永远卡住不提交。
      if (hiddenValue) return hiddenValue;
      return this._getQuizAnswerValue(question._element, qid);
    },


    _isQuizQuestionFilled: function (preferredDoc, question) {
      return !!this._getQuizQuestionFilledValue(preferredDoc, question);
    },


    _isQuizQuestionFilledWithKnownWrong: function (preferredDoc, question) {
      if (!question || !question._element) return false;
      var value = this._getQuizQuestionFilledValue(preferredDoc, question);
      if (!value) return false;
      var type = question.type || this._getQuestionTypeFromElement(question._element, this._getQuestionIdFromElement(question._element));
      var canonical = this._canonicalQuizAnswerForQuestion(value, type, question);
      var wrongSet = this._getKnownWrongCanonicalSet(question, type, preferredDoc);
      return !!(canonical && wrongSet.indexOf(canonical) !== -1);
    },


    _clearKnownWrongFilledQuizAnswers: function (questions, preferredDoc) {
      if (!questions || !questions.length) return 0;
      var cleared = 0;
      for (var i = 0; i < questions.length; i++) {
        if (this._getConfirmedCachedQuizAnswer(questions[i], preferredDoc)) continue;
        // "放弃折腾"的题例外：它填的就是本地猜的答案，很可能仍在错答记录里。
        // 把它清掉 = 表单缺一道 = `_areQuizAnswersFilled` 为假 = 永远不提交，
        // 那就正好回到了我们要消除的"卡住"。
        if (this._isQuizQuestionBestEffort(questions[i], preferredDoc)) continue;
        if (!this._isQuizQuestionFilledWithKnownWrong(preferredDoc, questions[i])) continue;
        var qid = this._getQuestionIdFromElement(questions[i]._element);
        emitRuntimeLog('warn', 'clear known wrong filled answer', { qid: qid || '', index: questions[i].index });
        this._clearQuizQuestionAnswer(questions[i]);
        this._unmarkQuizQuestionAnsweredThisRun(questions[i]);
        cleared++;
      }
      return cleared;
    },


    _areQuizAnswersFilled: function (preferredDoc, questions, options) {
      var doc = this._resolveQuizAnswerDocument(preferredDoc);
      if (!doc) return false;
      var requireThisRun = !!(options && options.requireThisRun);
      for (var i = 0; i < questions.length; i++) {
        var question = questions[i];
        var qid = question && question._element ? this._getQuestionIdFromElement(question._element) : '';
        if (!qid) return false;
        var value = this._getQuizQuestionFilledValue(preferredDoc, question);
        console.log('[Omitone] answer field', qid, 'value=', value);
        if (!value) return false;
        if (requireThisRun && !this._wasQuizQuestionAnsweredThisRun(question)) {
          emitRuntimeLog('warn', 'quiz answer value is stale, block submit', { qid: qid });
          return false;
        }
      }
      return true;
    },


    _findButtonByText: function (targets) {
      var texts = Array.isArray(targets) ? targets : [targets];
      var found = null;

      this._walkDocuments(function (doc) {
        var buttons = doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], .btn, [class*="submit"], [class*="confirm"]');
        for (var i = 0; i < buttons.length; i++) {
          var label = String((buttons[i].textContent || buttons[i].value || '')).trim();
          if (!label) continue;
          for (var j = 0; j < texts.length; j++) {
            if (label.indexOf(texts[j]) !== -1) {
              found = buttons[i];
              return true;
            }
          }
        }
        return false;
      });

      return found;
    },


    /**
     * 与 _resolveQuizAnswerDocument 完全相同 —— 答题域和提交域本来就是同一个文档。
     * 保留这个名字是因为调用点很多、语义更清楚；实现上只做转发，
     * 避免两处逻辑各自演化（历史上它们就因为重复实现而分别踩过同一个坑）。
     */
    _resolveQuizSubmitDocument: function (preferredDoc) {
      return this._resolveQuizAnswerDocument(preferredDoc);
    },


    _shouldAutoSubmitQuiz: function (preferredDoc) {
      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      if (!submitDoc) return false;

      try {
        var quizWindow = submitDoc.defaultView || submitDoc.parentWindow;
        if (quizWindow && (typeof quizWindow.btnBlueSubmit === 'function' || typeof quizWindow.submitCheckTimes === 'function')) {
          return true;
        }
      } catch (e) {}

      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1) return true;
      return !!submitDoc.querySelector('.btnSubmit, .bluebtn, .workBtnIndex, #form1');
    },


    _maybeSubmitQuiz: function (preferredDoc, questions) {
      var submitQuestions = questions || this._quizCurrentQuestions;
      var questionDoc = this._getQuizDocumentFromQuestions(submitQuestions);
      var effectiveDoc = preferredDoc || questionDoc || null;
      if (!this._shouldAutoSubmitQuiz(effectiveDoc)) {
        console.log('[Omitone] auto submit skipped');
        return false;
      }
      var submitDoc = this._resolveQuizSubmitDocument(effectiveDoc);
      var currentKey = this._getQuizWorkKey(effectiveDoc || submitDoc);
      if (this._shouldSkipQuizBySubmitAttempts(effectiveDoc || submitDoc)) {
        return this._forceSkipQuizAfterMaxAttempts(effectiveDoc || submitDoc);
      }
      if (submitQuestions && this._clearKnownWrongFilledQuizAnswers(submitQuestions, effectiveDoc || submitDoc) > 0) {
        emitRuntimeLog('warn', 'block quiz submit because known wrong answers were cleared');
        this._quizAnswered = false;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return false;
      }
      if (submitQuestions && !this._areQuizAnswersFilled(effectiveDoc || submitDoc, submitQuestions, { requireThisRun: true })) {
        emitRuntimeLog('warn', 'block quiz submit because answers are not ready');
        this._quizAnswered = false;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return false;
      }
      if (!this._quizReadyToSubmit || (this._quizReadyWorkKey && this._quizReadyWorkKey !== currentKey)) {
        emitRuntimeLog('warn', 'block quiz submit without ready state', { key: currentKey });
        this._quizAnswered = false;
        return false;
      }
      if (submitQuestions) {
        this._rememberSubmittedQuizAnswers(submitQuestions, effectiveDoc || submitDoc);
      }
      var now = Date.now();
      if (this._quizSubmitPending) return true;
      if (this._quizLastSubmitAttemptAt && now - this._quizLastSubmitAttemptAt < 3000) return true;

      var self = this;
      if (submitDoc) {
        try {
          var quizWindow = submitDoc.defaultView || submitDoc.parentWindow;
          if (quizWindow && typeof quizWindow.btnBlueSubmit === 'function') {
            console.log('[Omitone] call btnBlueSubmit()');
            // 先把「平台会提交什么」打出来 —— 失败原因排查全靠它
            this._logSubmitPayload(submitQuestions, effectiveDoc || submitDoc);
            this._markQuizSubmitPending(effectiveDoc || submitDoc, 'btnBlueSubmit');
            setTimeout(function () {
              try { quizWindow.btnBlueSubmit(); } catch (e) { console.error('[Omitone] btnBlueSubmit failed', e); }
            }, 300);

            setTimeout(function () {
              try {
                var maybePop = document.getElementById('workpop');
                if (maybePop && visible(maybePop)) {
                  var okBtn = maybePop.querySelector('#popok');
                  if (okBtn) {
                    console.log('[Omitone] confirm submit via #popok');
                    okBtn.click();
                  }
                }
              } catch (e2) {}
            }, 1200);
            return true;
          }
        } catch (directErr) {
          console.error('[Omitone] direct quiz submit failed', directErr);
        }
      }

      var submit = this._findButtonByText(['提交', '交卷', '完成']);
      if (!submit) return false;
      this._markQuizSubmitPending(effectiveDoc || submitDoc, 'submit-button');
      setTimeout(function () {
        try { submit.click(); } catch (e) {}
      }, 300);

      setTimeout(function () {
        var confirm = self._findButtonByText(['确认', '确定', '提交', '交卷']);
        if (confirm) {
          try { confirm.click(); } catch (e2) {}
        }
      }, 900);

      return true;
    },


    _isSubmitConfirmDialog: function (node) {
      if (!node || !visible(node)) return false;
      var dialogText = textOf(node);
      var id = String(node.id || '');
      var cls = String(node.className || '');
      if (id === 'confirmSubWin') return true;
      if (id === 'workpop' && node.querySelector('#popok') && node.querySelector('#popcontent')) return true;
      if (cls.indexOf('AlertCon02') !== -1) {
        if (node.querySelector('[onclick*="submitCheckTimes"], .bluebtn, .btnSubmit, .workBtnIndex')) return true;
      }
      if (node.querySelector && node.querySelector('#popok') && node.querySelector('#popcontent')) return true;
      if (node.getAttribute && node.getAttribute('role') === 'alertdialog') {
        if (node.querySelector('[onclick*="submitCheckTimes"], .bluebtn')) return true;
      }
      if (!dialogText) return false;
      return /确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(dialogText);
    },


    _findDialogButtonByText: function (root, targets) {
      if (!root) return null;
      var texts = Array.isArray(targets) ? targets : [targets];
      var buttons = root.querySelectorAll('button, a, input[type="button"], input[type="submit"], .btn, [class*="submit"], [class*="confirm"]');
      for (var i = 0; i < buttons.length; i++) {
        if (!visible(buttons[i])) continue;
        var label = String((buttons[i].textContent || buttons[i].value || '')).trim();
        if (!label) continue;
        for (var j = 0; j < texts.length; j++) {
          if (label.indexOf(texts[j]) !== -1) return buttons[i];
        }
      }
      var wantsSubmit = texts.some(function (text) {
        return /提交|确定|确认|交卷|完成/.test(text);
      });
      if (wantsSubmit) {
        var structural = root.querySelector('#popok, [onclick*="submitCheckTimes"], .bluebtn[role="button"], .bluebtn, .btnSubmit');
        if (structural && visible(structural)) return structural;
      }
      return null;
    },


    _checkSubmitConfirmDialog: function () {
      var selectors = [
        '#workpop',
        '#confirmSubWin',
        '.AlertCon02',
        '.layui-layer',
        '.el-message-box',
        '.ant-modal',
        '.dialog',
        '.modal',
        '[role="dialog"]',
        '[role="alertdialog"]'
      ];

      function searchAll(doc, depth) {
        if (!doc || depth > 3) return null;
        for (var i = 0; i < selectors.length; i++) {
          var nodes = doc.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            if (app._isSubmitConfirmDialog(nodes[j])) return nodes[j];
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
        return searchAll(startDoc, 0) || searchAll(document, 0);
      } catch (e2) {
        return null;
      }
    },


    _handleSubmitConfirmDialog: function (dialog) {
      if (!dialog) return false;
      var now = Date.now();
      if (now - this._submitConfirmLastClickAt < 400) return true;

      var submitBtn = this._findDialogButtonByText(dialog, ['提交', '确定', '确认', '交卷', '完成']);
      if (!submitBtn) return false;

      this._submitConfirmLastClickAt = now;
      console.log('[Omitone] confirm final submit');
      var dialogText = textOf(dialog);
      if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(dialogText)) {
        this._rememberCorrectQuizAnswers(null);
        this._rememberWrongQuizAnswers(null);
        this._quizSubmitPending = false;
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
      } else if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(dialogText) || this._hasActiveQuizSubmitForm(null)) {
        var currentKey = this._getQuizWorkKey(null);
        var readyForConfirm = this._quizReadyToSubmit || this._quizSubmitPending || this._quizAnswered;
        if (!readyForConfirm) {
          emitRuntimeLog('warn', 'wait submit confirm until quiz ready', { key: currentKey });
          this._submitConfirmLastClickAt = 0;
          return true;
        }
        if (this._quizReadyWorkKey && currentKey && this._quizReadyWorkKey !== currentKey) {
          // 良性：提交确认弹窗出现时 URL 可能已变化（如加了时间戳参数），
          // 但测验本身已就绪，按设计继续提交。降为 info 避免被当成故障线索。
          emitRuntimeLog('info', 'submit confirm key mismatch, continue because quiz is ready', { readyKey: this._quizReadyWorkKey, key: currentKey });
        }
        this._markQuizSubmitPending(null, 'confirm-dialog');
      }
      try { submitBtn.click(); } catch (e) {}
      return true;
    },
