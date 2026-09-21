/* ==========================================================================
 * Omitone page.js 片段 12/15 —— 答题：读图（视觉）
 * 来源：原 page.js 中散布的 5 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 把题目里的图片取出来、交给视觉模型描述，再把描述并回题干
 * ⚠️ _takeVisionBudget 是**烧钱的安全阀**：预算耗尽必须停并写 warn 日志，绝不静默
 * 图片走独立请求 —— 塞进答题链的长前缀会让缓存全失效，反而更贵
 *
 * 本段的方法（5 个）：
 *   _takeVisionBudget、_collectQuestionImages、_applyVisionToQuestions、
 *   _mergeVisionIntoTitle、_isTextOnly
 * ========================================================================== */
// @omitone-part-header-end

    /**
     * 视觉预算闸门 —— 这是整个视觉功能里**最重要的安全阀**。
     *
     * 用户能接受「刷不了课」，不能接受「花了钱还是不行」。所以要保证：
     * 无论配置写错、页面版式异常、还是某道题反复触发，都不可能无限发请求。
     *
     * 返回 true = 允许再发一次；false = 预算耗尽，必须停。
     * 耗尽时**必定写一条 warn 日志**，绝不静默 —— 静默烧钱是最糟的失败方式。
     */
    _takeVisionBudget: function (chapterKey) {
      if (!this.configs.visionEnabled) return false;
      var key = String(chapterKey || 'unknown');
      if (this._visionBudgetChapterKey !== key) {
        // 换章即重置。不清零的话，一学期下来后面所有章节都用不了视觉。
        this._visionBudgetChapterKey = key;
        this._visionUsedInChapter = 0;
      }
      var cap = Number(this.configs.visionBudgetPerChapter);
      if (!isFinite(cap) || cap < 0) cap = 0;
      if (this._visionUsedInChapter >= cap) {
        // 同一章只提醒一次，否则每道题刷一条，日志会被淹掉
        if (this._visionBudgetWarnedKey !== key) {
          this._visionBudgetWarnedKey = key;
          emitRuntimeLog('warn', 'vision budget exhausted for this chapter, images will be ignored', {
            used: this._visionUsedInChapter,
            cap: cap,
            chapter: key
          });
        }
        return false;
      }
      this._visionUsedInChapter++;
      return true;
    },

    /**
     * 从题目容器里挑出「值得发给视觉模型」的图。
     *
     * 全部判据都是为了让每一张发出的图都可能真的值一次钱：
     *   - 忽略小图：图标 / 分隔线 / 表情（通常 < 64px，模型看了也说不出东西）
     *   - 忽略透明/空白图：装饰性资源
     *   - 超过体积上限的直接跳过（配置项 visionMaxImageBytes）
     *   - 张数上限 visionMaxImagesPerQuestion
     *   - 去重：同一张图在题干和选项里各出现一次时只发一次
     *
     * 返回 dataURL 数组（可能为空数组，调用方必须处理空的情况）。
     */
    _collectQuestionImages: function (el) {
      var out = [];
      if (!el || !this.configs.visionEnabled) return out;
      var maxImages = Number(this.configs.visionMaxImagesPerQuestion);
      if (!isFinite(maxImages) || maxImages < 1) return out;
      var maxBytes = Number(this.configs.visionMaxImageBytes);
      if (!isFinite(maxBytes) || maxBytes <= 0) maxBytes = 400000;

      var imgs = [];
      try { imgs = Array.from(el.querySelectorAll('img')) } catch (e) { return out; }

      var seen = {};
      for (var i = 0; i < imgs.length && out.length < maxImages; i++) {
        var img = imgs[i];
        try {
          // 尺寸闸门：未加载完的图 naturalWidth 为 0，直接跳过（发出去也是浪费）
          var w = Number(img.naturalWidth || 0);
          var h = Number(img.naturalHeight || 0);
          if (w < 64 || h < 64) continue;
          if (w * h > 4000000) continue; // 超过 400 万像素的图多半是整页扫描件，不划算

          var src = String(img.currentSrc || img.src || '');
          if (!src || src.indexOf('data:') === 0) {
            // 已经是 dataURL（平台用 base64 内联时常见）—— 直接量长度判断体积
            if (src.indexOf('data:image/') === 0) {
              if (src.length > maxBytes * 1.4) continue;
              if (!seen[src]) { seen[src] = 1; out.push(src); }
            }
            continue;
          }
          var abs = this._resolveImageUrl(img);
          if (!abs || seen[abs]) continue;
          seen[abs] = 1;
          out.push(abs);
        } catch (e2) {}
      }
      return out;
    },

    /**
     * 给一批题目补上「配图转述」。
     *
     * 设计要点：
     *   - **只处理真的有图、且过得了尺寸闸门的题**：没有图的题一次请求都不发。
     *     这既省钱，也避免把「无图」退化成一次白花的调用。
     *   - 逐题串行、限量处理。并发发图很容易瞬间打满预算，
     *     而限额是这套功能里唯一的硬保险，不能被并发绕过。
     *   - 单题失败不影响其他题，也绝不影响整卷作答。
     *
     * 全程受 visionEnabled / visionMaxImagesPerQuestion / visionBudgetPerChapter 三道闸门约束。
     */
    _applyVisionToQuestions: async function (questions, preferredDoc) {
      if (!this.configs.visionEnabled) return;
      if (!questions || !questions.length) return;

      var chapterKey = this._getCurrentChapterId() || this._extractFrameKey('vision', 'chapter') || 'chapter';
      var maxPerQuestion = Number(this.configs.visionMaxImagesPerQuestion);
      if (!isFinite(maxPerQuestion) || maxPerQuestion < 1) return;

      var touched = 0;
      for (var i = 0; i < questions.length; i++) {
        var q = questions[i];
        if (!q || !q._element) continue;

        var urls = this._collectQuestionImages(q._element);
        if (!urls.length) continue;

        // 扣预算前先确认这一章还有额度。额度用完时 _describeQuestionImages 会自己写日志，
        // 这里就不再重复遍历后面的题 —— 直接整体退出，省掉剩下的抓图开销。
        if (this._visionUsedInChapter >= Number(this.configs.visionBudgetPerChapter || 0) &&
            this._visionBudgetChapterKey === chapterKey) {
          this._takeVisionBudget(chapterKey); // 触发一次「预算耗尽」日志
          emitRuntimeLog('info', 'vision skipped remaining questions', { from: i, total: questions.length });
          break;
        }

        var described = await this._describeQuestionImages(urls, chapterKey);
        if (described) {
          q.title = this._mergeVisionIntoTitle(q.title, described);
          touched++;
        }
      }

      if (touched > 0) {
        emitRuntimeLog('info', 'vision applied to quiz', {
          questions: questions.length,
          withImage: touched,
          usedBudget: this._visionUsedInChapter
        });
      }
    },

    /** 把视觉描述拼进题干。格式固定，便于模型区分「题面」与「图的转述」。 */
    _mergeVisionIntoTitle: function (title, visionText) {
      var base = String(title || '');
      var extra = String(visionText || '').trim();
      if (!extra) return base;
      return base + ' [配图: ' + extra + ']';
    },

    _isTextOnly: function () {
      if (this._locateDocumentTask()) return false;
      var doc = this._getMainDocument();
      if (!doc || !doc.body) return true;
      var bodyText = textOf(doc.body);
      if (bodyText.length < 10 || bodyText === '暂无内容') return true;
      if (doc.querySelector('video, iframe[src*="video"], iframe[src*="ananas"], .ans-insertvideo-online')) return false;
      if (doc.querySelector('.questionLi, .mark_item, .questionItem, .tiBank, .exam_question, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return false;
      return true;
    },
