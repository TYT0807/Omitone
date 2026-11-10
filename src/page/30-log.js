/* ==========================================================================
 * Omitone page.js 片段 03/15 —— 运行日志与诊断文案
 * 来源：原 page.js 中散布的 8 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 把状态转成「给人看的一行字」的辅助方法 —— 规则：所有 `_log*` / `_describe*` / `_diagnose*` 都在这里
 * 真正的日志出口 emitRuntimeLog 在外壳 00-shell-constants.js
 *
 * 本段的方法（9 个）：
 *   _logUnsupportedJobOnce、_logTaskWait、_describeQuestionImages、
 *   _logRandomAnswers、_describeQuizResultPage、_logSubmitPayload、
 *   _diagnoseQuestionScan、_flattenDropStages、_describePopupQuiz
 * ========================================================================== */
// @omitone-part-header-end

    _logUnsupportedJobOnce: function (module, type) {
      if (!this._unsupportedJobLogged) this._unsupportedJobLogged = Object.create(null);
      var key = String(module || '') + '|' + String(type || '');
      if (this._unsupportedJobLogged[key]) return;
      this._unsupportedJobLogged[key] = true;
      emitRuntimeLog('warn', 'unsupported task point type, skipped', {
        module: String(module || '(空)'),
        type: String(type || '(空)')
      });
    },


    _logTaskWait: function (message, now) {
      var ts = now || Date.now();
      if (ts - this._taskWaitLogAt < 3000) return;
      this._taskWaitLogAt = ts;
      console.log('%c[Omitone] waiting task render: ' + message, 'color:#9C27B0');
    },


    /**
     * 把图片 URL 转成 dataURL 并做体积闸门，然后一次性交给视觉模型。
     *
     * 返回值：描述文字（string），拿不到就返回空串。
     * **永远不会抛异常** —— 视觉只是锦上添花，绝不能因为它把整条答题链打断。
     */
    _describeQuestionImages: async function (urls, chapterKey) {
      if (!urls || !urls.length) return '';
      if (!this.configs.visionEnabled) return '';

      var maxBytes = Number(this.configs.visionMaxImageBytes);
      if (!isFinite(maxBytes) || maxBytes <= 0) maxBytes = 400000;
      var maxPerReq = Number(this.configs.visionImagesPerRequest);
      if (!isFinite(maxPerReq) || maxPerReq < 1) maxPerReq = 2;

      // 先抓图（这一步不花钱）
      var dataUrls = [];
      for (var i = 0; i < urls.length && dataUrls.length < maxPerReq; i++) {
        var url = String(urls[i] || '');
        if (!url) continue;
        var dataUrl = '';
        if (url.indexOf('data:image/') === 0) {
          dataUrl = url;
        } else {
          try {
            var fetched = await bridgeSend('fetch_image', { url: url });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = String(fetched.dataUrl);
          } catch (eF) {}
        }
        if (!dataUrl) continue;
        // 体积闸门：base64 后约是原始字节的 4/3，这里用 dataURL 长度近似判断
        if (dataUrl.length > maxBytes * 1.4) {
          emitRuntimeLog('info', 'vision image too large, skipped', { bytes: Math.round(dataUrl.length * 0.75) });
          continue;
        }
        dataUrls.push(dataUrl);
      }
      if (!dataUrls.length) return '';

      // 抓完图才扣预算。反过来会出现「预算扣了但图没抓到」的冤枉账。
      if (!this._takeVisionBudget(chapterKey)) return '';

      try {
        var result = await bridgeSend('llm_vision', { images: dataUrls });
        if (!result || !result.success) {
          emitRuntimeLog('warn', 'vision request failed, continue without image text', {
            error: String((result && result.error) || 'no response').slice(0, 200)
          });
          return '';
        }
        var text = String(result.data || '').trim();
        // 模型说「无」时不要往题干里塞噪音 —— 那会让答题模型分心
        if (!text || text === '无' || text === '没有' || text === '无明显信息') return '';
        emitRuntimeLog('info', 'vision described images', { images: dataUrls.length, chars: text.length });
        return text;
      } catch (e) {
        emitRuntimeLog('warn', 'vision bridge failed', { message: e && e.message ? e.message : String(e) });
        return '';
      }
    },


    /** 乱选模式下的日志（每 3 秒最多一条，避免刷屏）。 */
    _logRandomAnswers: function (questions) {
      var now = Date.now();
      if (now - (this._randomAnswerLogAt || 0) < 3000) return;
      this._randomAnswerLogAt = now;
      emitRuntimeLog('info', 'random answer mode: generated locally, no ai request', {
        count: (questions || []).length
      });
    },


    /**
     * 诊断：**为什么没认出判分结果页**。
     *
     * `_isQuizResultPageFinished` 有三道条件 ——
     *   ① 没有「请重做」类文案（一票否决）
     *   ② 有判分痕迹（`.Py_answer` 那一族，或正文出现「我的答案/正确答案/本题得分/答案解析」）
     *   ③ 题目区已不可交互（没有容器，或所有 radio/checkbox/input/textarea 都 disabled）
     * 任何一道不满足都返回 false，但**不告诉你缺的是哪一道**。
     * 于是 25 秒超时之后只能靠猜 —— 现场报过「作业页反复重交」，卡的就是这一段。
     *
     * 这条日志把三道条件各自的结果都打出来，下次复现就能直接看出缺哪一块，不用再猜。
     */
    _describeQuizResultPage: function (preferredDoc) {
      var out = {};
      try {
        var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
        if (!doc || !doc.body) { out.doc = 'none'; return out; }
        var text = textOf(doc.body);
        out.textLen = text.length;
        // ① 一票否决
        out.redoText = /未达到及格线|未达到通过标准|请重做|很遗憾|未通过/.test(text);
        // ② 判分痕迹
        var hit = null;
        try { hit = doc.querySelector('.Py_answer, .Py_tk, .answerScore, .answerCon, .mark_answer'); } catch (eH) {}
        out.gradeSelector = hit ? String(hit.className || '').slice(0, 40) : '';
        out.gradeText = /我的答案|正确答案|本题得分|答案解析/.test(text);
        // ③ 可交互性。选择器读真源 `_quizContainerSelector` —— 这里原先手抄了一份，
        //    抄成 `.Cy_TITle`（大小写错），于是作业/考试页上 containers 恒为 0，
        //    而这条诊断唯一的作用就是告诉人"缺的是哪一道条件"。别再手抄。
        out.containers = doc.querySelectorAll(this._quizContainerSelector).length;
        var ctrls = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea');
        out.controls = ctrls.length;
        var enabled = 0;
        for (var i = 0; i < ctrls.length; i++) { if (!ctrls[i].disabled) enabled++; }
        out.controlsEnabled = enabled;
        // 正文里跟判分有关的词，便于对照
        var kw = text.match(/我的答案|正确答案|本题得分|答案解析|任务点已完成|已通过|请重做|未通过|不及格/g);
        out.keywords = kw ? Array.from(new Set(kw)).slice(0, 8) : [];
      } catch (e) { out.err = String(e.message || e).slice(0, 60); }
      return out;
    },

    _logSubmitPayload: function (questions, doc) {
      try {
        var list = (questions && questions.length ? questions : this._quizCurrentQuestions) || [];
        var out = [];
        for (var i = 0; i < list.length && i < 12; i++) {
          var q = list[i];
          var el = q && q._element;
          var qid = el ? this._getQuestionIdFromElement(el) : '';
          if (!qid) { out.push({ qid: '', answer: '(无 qid)' }); continue; }
          var a = doc && doc.getElementById ? doc.getElementById('answer' + qid) : null;
          var t = doc && doc.getElementById ? doc.getElementById('answertype' + qid) : null;
          // `mapped` 是我们**把 answertype 解读成了什么** —— 与 `type` 一列对比，
          // 就能立刻看出「我们认的题型」和「平台声明的题型」是否一致。
          // 不一致时服务端很可能拒收（比如我们当单选填、平台声明是多选）。
          var rawType = t ? String(t.value || '') : '';
          out.push({ qid: qid, type: q && q.type, mapped: this._mapQuizTypeValue(rawType),
            answer: a ? String(a.value || '') : '(无该字段)',
            answertype: t ? rawType : '(无该字段)' });
        }
        console.log('[Omitone] submit payload', JSON.stringify(out));
      } catch (e) {}
    },


    /**
     * 题目扫描诊断。
     *
     * 触发方式：
     *   1) _handleQuiz 扫到 0 题时自动写进运行日志
     *   2) 用户在页面控制台手动执行 `xxtAI.diagnose()`（同时 return，可直接看返回值）
     *
     * 目的：把"AI 扫不到题目"这种没法查的模糊反馈，变成能直接定位的具体信息 ——
     * 每个同源文档里有哪些选择器命中、命中几个、拿到的容器为什么被判定成无效题。
     */
    _diagnoseQuestionScan: function (preferredDoc) {
      var self = this;
      var report = {
        url: String((window.location && window.location.href) || '').slice(0, 180),
        title: this._getCurrentTitle(),
        quizByTitle: this._looksLikeQuizTitle(),
        docs: [],
        containers: 0,
        samples: []
      };

      // 诊断与收集用同一份清单（含 storage 里的改版应急 overrides）——
      // 诊断若只报内置选择器，用户配了 overrides 时会看到「命中 0」的假象
      var diagSelectors = this._questionSelectors;
      var diagOverrides = this.configs && this.configs.questionSelectorOverrides;
      if (Array.isArray(diagOverrides) && diagOverrides.length) {
        diagSelectors = diagSelectors.concat(diagOverrides.filter(function (s) { return typeof s === 'string' && s; }));
      }

      var hitDocs = [];
      var inspectDoc = function (doc, path) {
        if (!doc || !doc.querySelectorAll || report.docs.length >= 8) return false;
        var entry = { path: path, href: '', selectors: {}, inputs: 0, answerFields: 0 };
        try { entry.href = String((doc.location && doc.location.href) || '').slice(0, 120); } catch (e) {}

        diagSelectors.forEach(function (sel) {
          try {
            var count = doc.querySelectorAll(sel).length;
            if (count) entry.selectors[sel] = count;
          } catch (e) {}
        });
        try {
          entry.inputs = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea').length;
          entry.answerFields = doc.querySelectorAll('[id^="answer"]').length;
        } catch (e) {}

        // 批次 12-A：记下这份文档的最大单条命中数，并把文档本身留到旁路数组里 ——
        // 下面「容器从哪几份文档数」要用它。旁路（不进 report）是因为 report 会整个进日志。
        var maxHit = 0;
        Object.keys(entry.selectors).forEach(function (k) {
          var n = Number(entry.selectors[k]) || 0;
          if (n > maxHit) maxHit = n;
        });
        entry.maxHit = maxHit;
        if (maxHit > 0) hitDocs.push({ doc: doc, score: maxHit, href: entry.href });

        report.docs.push(entry);
        return false;
      };

      if (preferredDoc) this._walkDocuments(function (d) { return inspectDoc(d, 'preferredDoc'); }, preferredDoc, 0);
      this._walkDocuments(function (d) { return inspectDoc(d, 'top'); }, document, 0);

      // ⚠️ 批次 12-A：容器必须从**真正命中题目的那几份文档**里数，不能固定问 `_getMainDocument()`。
      // 真页面实测（`node tools/debug-live.js` + `node tools/debug-probe.js`，页面里调 `xxtAI.probe()`）：
      // 这一节的卷子挂在
      //   顶层 → #iframe(卡片页) → ananas/modules/work → #frame_content(doHomeWorkNew)
      // 里（顶层下面第三份文档），而 `_getMainDocument()` 给的是**卡片页** —— 那里只有 1 个无关的
      // `div[class*="question"]`。于是真卷子上 `containers` **永远是 0**（同一时刻 `.TiMu=24`、
      // `_extractQuestions` 正常返回 24 题），`hint` 就常年指着「容器全部被过滤」撒谎 ——
      // 而那一行正是用户日志里被当成结论读的唯一一句，也是批次 10-C 当初判断形状的出处。
      // 顺带：一份卡片里挂两份卷子时，这里按**每一份命中文档**分别数，两份都看得见。
      var containerHosts = [];
      if (preferredDoc) containerHosts = [preferredDoc];
      else if (hitDocs.length) containerHosts = hitDocs.map(function (h) { return h.doc; });
      else containerHosts = [this._getMainDocument() || document];

      var containers = [];
      containerHosts.forEach(function (host) {
        if (!host) return;
        try { containers = containers.concat(self._collectQuestionContainers(host) || []); } catch (e) {}
      });
      report.containers = containers.length;
      report.containerDocs = containerHosts.length;
      report.containerPaths = containerHosts.map(function (host) {
        try {
          return String((host && host.location && host.location.href) || '')
            .replace('https://mooc1.chaoxing.com', '').slice(0, 44);
        } catch (eP) { return ''; }
      }).join('|').slice(0, 150);

      // ⚠️ 「命中了却被吃掉」要说清死在哪一道（批次 9-C）。
      // 真实日志 00:46:04 只给了 `matchedSelectors:{"div[class*=\"question\"]":1}` 和 `inputs:9`，
      // 于是那句"容器全部被过滤"到底指**不可见且无文本**、**嵌套去重**还是**解析返回 null**，
      // 现场判不了 —— 而这三条各自对应完全不同的修法。
      if (!report.containers) {
        report.dropStages = diagSelectors.reduce(function (acc, sel) {
          containerHosts.forEach(function (host) {
            if (!host) return;
            try {
              var found = Array.prototype.slice.call(host.querySelectorAll(sel));
              if (!found.length) return;
              var usable = found.filter(function (node) { return visible(node) || textOf(node).length > 0; });
              var set = new Set(usable);
              var unique = usable.filter(function (item) {
                if (!item || !item.closest) return true;
                var parent = item.parentElement;
                while (parent) {
                  if (set.has(parent)) return false;
                  parent = parent.parentElement;
                }
                return true;
              });
              var parsable = unique.filter(function (node) { return !!self._parseQuestionElement(node, 0); }).length;
              var prev = acc[sel] || { matched: 0, filtered: 0, deduped: 0, unparsable: 0 };
              acc[sel] = {
                matched: prev.matched + found.length,
                filtered: prev.filtered + (found.length - usable.length),
                deduped: prev.deduped + (usable.length - unique.length),
                unparsable: prev.unparsable + (unique.length - parsable)
              };
            } catch (e) {}
          });
          return acc;
        }, {});
      }

      containers.slice(0, 5).forEach(function (node) {
        var parsed = self._parseQuestionElement(node, 0);
        report.samples.push({
          cls: String(node.className || '').slice(0, 50),
          head: textOf(node).slice(0, 48),
          title: parsed ? String(parsed.title || '').slice(0, 40) : '',
          options: parsed ? parsed.options.length : 0,
          parsed: !!parsed
        });
      });

      var totalMatched = report.docs.reduce(function (sum, d) {
        return sum + Object.keys(d.selectors).length;
      }, 0);
      if (!totalMatched) {
        report.hint = '任何文档都没有命中题目选择器：可能不是测验页，或题目在跨域 iframe 里（插件无法访问），或学习通改版换了类名';
      } else if (!report.containers) {
        report.hint = '选择器有命中但容器一个都没留下：看 dropStages 里哪一格非零 —— filtered=不可见且无文本、deduped=嵌套去重吃掉、unparsable=解析返回 null（批次 9-C 起这一格随日志一起出）';
      } else if (!report.samples.some(function (s) { return s.parsed; })) {
        report.hint = '容器找到了但 _parseQuestionElement 全部返回 null：题干与选项都没抠出来，需要补 titleSelectors / _getOptionItems';
      }

      return report;
    },


    /**
     * `dropStages` 压平成一句人话 —— 批次 12，**只读取证**。
     *
     * 真页面实测（`xxtAI.probe()`）给的是
     * `{ "div[class*=\"question\"]": {matched:1, filtered:1, deduped:0, unparsable:0} }`
     * —— **每条选择器对应一个对象**。而三处取证都按 `{选择器: 数字}` 读它：
     *   ① `_quizScanRetrySignal` / ② `_skipCompletedEvidence` 里 `Number(对象)` = **NaN**，
     *      落盘就成了 `div[class*="question"]:NaN`（探针当场抓到的就是这个）；
     *   ③ 这一族的日志本来就有「落盘字段一律标量」的规矩（批次 10-A），三处口径也该是同一句。
     *      ⚠️ 顺带更正一处**我自己写错的诊断**：批次 12 初版说"原样塞进 meta 会被第 4 层截成
     *      [truncated]"—— 实测不成立，`meta.dropStages` 只落在第 2、3 层，截不到它
     *      （`cleanLogMeta` 从第 4 层起才动手，10-A 那条 `rejects[].sig.qHit` 才是真的在第 4 层）。
     *      压平的理由是 NaN 与口径，不是截断 —— 集成测试 [15] 里那条反向对照把这个边界钉住了。
     *
     * 这一格本身很值钱：`filtered`（不可见且无文本）/ `deduped`（嵌套去重吃掉）/
     * `unparsable`（解析返回 null）三条各自对应完全不同的修法，只剩一个总数就回答不了"死在哪一道"。
     * 所以四格一起写死、顺序固定，且保证是**标量字符串**。
     */
    _flattenDropStages: function (stages) {
      var keys = [];
      try { keys = Object.keys(stages || {}); } catch (e) { return ''; }
      return keys.slice(0, 4).map(function (k) {
        var v = (stages && stages[k]) || {};
        return String(k).slice(0, 28) + ':matched' + (Number(v.matched) || 0) +
          '/filtered' + (Number(v.filtered) || 0) +
          '/deduped' + (Number(v.deduped) || 0) +
          '/unparsable' + (Number(v.unparsable) || 0);
      }).join(';').slice(0, 220);
    },


    _describePopupQuiz: function (popup, optionItems) {
      try {
        if (!optionItems) optionItems = this._getOptionItems(popup);
        return {
          cls: String(popup.className || '').slice(0, 120),
          text: textOf(popup).slice(0, 200),
          optionCount: optionItems.length,
          optionTexts: optionItems.slice(0, 6).map(this._extractOptionText.bind(this)),
          optionLetters: optionItems.slice(0, 6).map(this._inferOptionLetter.bind(this)),
          html: String(popup.outerHTML || '').replace(/\s+/g, ' ').slice(0, 900)
        };
      } catch (e) {
        return { cls: String(popup && popup.className || ''), error: String(e && e.message || e) };
      }
    },
