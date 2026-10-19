/* ==========================================================================
 * Omitone page.js 片段 05/15 —— 验证码（弹窗 + 整页）
 * 来源：原 page.js 中散布的 14 处属性（按域重组，原行号已不适用）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * 验证码弹窗的检测、取图与识别；整页验证码模式的处理
 *
 * 本段的方法（19 个）：
 *   _checkCaptchaDialog、_captureCaptchaImage、_cleanCaptchaCode、
 *   _fillCaptchaInput、_clickCaptchaSubmit、_captchaSubmitStrategies、
 *   _captchaStillOpen、_captchaSuccessShown、_submitCaptchaWithStrategies、
 *   _clickCaptchaConfirm、_captchaReload、
 *   _recognizeCaptchaImage、_detectStandaloneCaptcha、
 *   _computeStandaloneCaptchaPage、_isStandaloneCaptchaPage、
 *   _runStandaloneCaptchaMode、_afterStandaloneCaptchaSolved、
 *   _handleCaptchaDialog、_backgroundCaptchaTick
 * ========================================================================== */
// @omitone-part-header-end

    // ---- 验证码自动检测与识别 ----
    // 已知学习通结构（参考开源 cxmooc-tools）：#imgVerCode 图片 / #ucode 输入框 / #sub 提交按钮
    // 同时做通用兜底：任意"验证码图片 + 附近文本输入框"的可见弹层都识别
    _checkCaptchaDialog: function () {
      // 独立于 AI 答题开关：只要配了 API Key + 视觉模型，验证码识别始终可用
      if (!this.configs.enableCaptcha) {
        if (this._captchaActive) this._captchaActive = false;
        return null;
      }
      var now = Date.now();
      if (now - (this._captchaLastCheckAt || 0) < 1500) return this._captchaLastResult || null;
      this._captchaLastCheckAt = now;

      var result = null;

      function findInputNear(doc, img) {
        // 1) 沿祖先向上找最近的文本输入框
        var node = img;
        for (var level = 0; level < 6 && node && node !== doc.body; level++) {
          node = node.parentElement;
          if (!node) break;
          var inputs = node.querySelectorAll('input[type="text"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            if (!visible(input)) continue;
            if (input.offsetWidth < 24) continue;
            return input;
          }
        }
        // 2) 兜底：在图片所在的弹窗容器内全量找
        var box = null;
        try { box = img.closest('div, form, table, layer, .layui-layer'); } catch (e) {}
        if (box) {
          var boxInputs = box.querySelectorAll('input[type="text"], input:not([type]), input[id*="code" i], input[name*="code" i]');
          for (var j = 0; j < boxInputs.length; j++) {
            if (!visible(boxInputs[j])) continue;
            if (boxInputs[j].offsetWidth < 24) continue;
            return boxInputs[j];
          }
        }
        return null;
      }

      function hitImgSize(img) {
        var w = img.naturalWidth || img.clientWidth || 0;
        var h = img.naturalHeight || img.clientHeight || 0;
        if (w && (w < 40 || w > 400)) return false;
        if (h && (h < 16 || h > 200)) return false;
        return true;
      }

      function scanDoc(doc, depth) {
        if (!doc || depth > 3 || result) return;
        var imgs = [];
        try { imgs = Array.from(doc.querySelectorAll('img')); } catch (e0) { return; }
        for (var i = 0; i < imgs.length && !result; i++) {
          var img = imgs[i];
          if (!visible(img)) continue;
          var src = String(img.currentSrc || img.src || '');
          var idName = String(
            (img.id || '') + ' ' + (img.getAttribute('name') || '') + ' ' + (img.className || '')
          ).toLowerCase();
          // A. 已知学习通验证码元素（最高置信，不受尺寸/文案限制）
          var specific = /imgvercode|chapternumvercode|vercode|verifycode|captcha|imgcode/.test(idName);
          // B. 图片地址特征
          var srcMatch = /\/img\/code|captcha|verif|vercode|rand=|getcode|checkcode|\/code\?/i.test(src);
          if (!specific && !srcMatch) continue;
          if (!hitImgSize(img)) continue;
          var input = findInputNear(doc, img);
          if (!input) continue;
          var dialog = doc.body;
          try {
            dialog = input.closest('.layui-layer, [class*="dialog"], [class*="verif"], form, table') || input.parentElement || img.parentElement || doc.body;
          } catch (e1) {}
          result = { doc: doc, img: img, input: input, dialog: dialog, why: specific ? 'element-id' : 'img-src' };
        }

        // C. 弹窗文本兜底：可见弹窗含“验证码”字样 + 图片 + 输入框（应对学习通改版换 id）
        if (!result) {
          var layers = [];
          try { layers = Array.from(doc.querySelectorAll('.layui-layer, [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="verif"]')); } catch (e2) {}
          for (var m = 0; m < layers.length && !result; m++) {
            var box = layers[m];
            if (!visible(box)) continue;
            var boxText = textOf(box).slice(0, 300);
            if (!/验证码|请输入|校验码/.test(boxText)) continue;
            var boxImgs = [];
            try { boxImgs = Array.from(box.querySelectorAll('img')); } catch (e3) {}
            for (var n = 0; n < boxImgs.length && !result; n++) {
              var bimg = boxImgs[n];
              if (!visible(bimg)) continue;
              if (!hitImgSize(bimg)) continue;
              // 弹窗文案里已含“验证码”，直接信任该图片
              var binput = findInputNear(doc, bimg);
              if (!binput) continue;
              result = { doc: doc, img: bimg, input: binput, dialog: box, why: 'dialog-text' };
            }
          }
        }

        if (!result) {
          var frames = [];
          try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e4) {}
          for (var k = 0; k < frames.length && !result; k++) {
            try {
              var subDoc = frames[k].contentDocument || (frames[k].contentWindow && frames[k].contentWindow.document);
              scanDoc(subDoc, depth + 1);
            } catch (e5) {}
          }
        }
      }

      try {
        var startDoc = this._getMainDocument() || document;
        scanDoc(startDoc, 0);
        if (!result) scanDoc(document, 0);
      } catch (e) {}

      this._captchaLastResult = result;
      this._captchaActive = !!result;
      // ⚠️ 这里原本有一句 `if (!result) this._diagnoseBlockedPage();`。
      // 那个函数在早前一轮「清理调试代码」时被删掉了，但调用点留了下来，
      // 于是「没有验证码」这个最常见的情况下每次都会抛 TypeError ——
      // _runTick 里那处有 try/catch 兜住所以看不出来，但另外 3 处调用点
      // （_handleCaptchaDialog 复检、_backgroundCaptchaTick、_handleVideoPlay 守卫）
      // 没有兜底，会把整条链路打断。删掉调用即可；诊断能力现在由
      // _diagnoseQuestionScan / _checkBlockedByCrossOrigin 覆盖。
      // 这类"幽灵调用"由 tools/check.js 的未定义方法检查兜底。
      return result;
    },


    _captureCaptchaImage: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var canvas = doc.createElement('canvas');
        var w = img.naturalWidth || img.clientWidth || 120;
        var h = img.naturalHeight || img.clientHeight || 40;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL('image/png');
      } catch (e) {
        // 跨域图片会污染画布，交由后台带 Cookie 抓取兜底
        return '';
      }
    },


    _cleanCaptchaCode: function (raw) {
      var text = String(raw || '');
      var quoted = text.match(/[「『“"]([^」』”"]{1,24})[」』”"]/);
      if (quoted && quoted[1]) text = quoted[1];
      var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length) text = lines[lines.length - 1];
      text = text.replace(/^.*?(?:答案|结果|验证码|code|result)\s*[:：]\s*/i, '');
      text = text.replace(/[\s"'`~!@#$%^&*()（）\-_=+\[\]【】{}\\|;:;,.，。、：；！？·…<>《》/?？]+/g, '');
      if (text.length > 12) text = text.slice(0, 12);
      return text;
    },


    _fillCaptchaInput: function (captcha, code) {
      var input = captcha.input;
      try { input.focus(); } catch (e0) {}
      var win = input.ownerDocument.defaultView || window;
      try {
        var descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, code);
        else input.value = code;
      } catch (e1) {
        input.value = code;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    },


    _clickCaptchaSubmit: function (captcha) {
      var doc = captcha.input.ownerDocument || document;
      var button = null;
      try { button = doc.querySelector('#sub'); } catch (e0) {}
      if (!button && captcha.dialog) {
        var candidates = captcha.dialog.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]');
        for (var i = 0; i < candidates.length; i++) {
          var label = textOf(candidates[i]);
          if (/^(确定|提交|验证|确认|OK)/.test(label)) { button = candidates[i]; break; }
        }
      }
      if (button) {
        try { button.click(); return; } catch (e1) {}
      }
      // 无按钮则模拟回车提交
      try {
        var win = doc.defaultView || window;
        captcha.input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        captcha.input.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (e2) {}
    },


    /**
     * 验证码「填对了却不确认」的多策略提交。
     *
     * 现场症状：码填进去了、肉眼看着就是对的，但页面停在验证码/确认界面不动，
     * 于是整条刷课链停在这里。用户的日志里看不出任何报错 —— 因为**提交那一下没生效**，
     * 而我们旧实现只试了一种办法（点 `#sub`，找不到就发一个回车）。
     *
     * 所以这里改成**逐个策略试 + 每个策略都回读结果**：
     *   ① #sub（课程页弹窗的老按钮）
     *   ② input[type=submit] / input[type=button]
     *   ③ 可见的小按钮/链接/div/span，文本以 确定|提交|验证|确认 开头
     *   ④ 常见类名（.verify-btn / .sub-btn / .btn-submit …）
     *   ⑤ 最近的 <form> 直接提交
     *   ⑥ 输入框上派发 Enter（keydown + keypress + keyup，少了 keypress 有些老页面不认）
     * 每个策略之后等一会再看一次；**弹窗没了 / 出现成功字样**才算这一步过了。
     * 全都不行时，还会再找一次「二次确认框」（页面上新冒出来的"确定"）点掉。
     */
    _captchaSubmitStrategies: function (captcha) {
      var self = this;
      var list = [];
      var input = captcha.input;
      var doc = (input && input.ownerDocument) || document;

      function visible(el) {
        try {
          if (!el || !el.getBoundingClientRect) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch (e) { return false; }
      }

      function clickIfVisible(el, name) {
        if (!el || !visible(el)) return false;
        try { el.click(); return true; } catch (e) { return false; }
      }

      // ① 课程页老按钮
      list.push({ name: 'sub-id', run: function () { return clickIfVisible(doc.querySelector('#sub')); } });

      // ② 表单型提交按钮
      list.push({
        name: 'submit-input',
        run: function () {
          var els = doc.querySelectorAll('input[type="submit"], input[type="button"], button[type="submit"]');
          for (var i = 0; i < els.length; i++) {
            if (visible(els[i]) && !/取消|关闭|重填|换一张|刷新/.test(textOf(els[i]))) {
              try { els[i].click(); return true; } catch (e) {}
            }
          }
          return false;
        }
      });

      // ③ 文本按钮：注意**不止 button/a** —— 学习通有些确认键是 div/span
      list.push({
        name: 'text-button',
        run: function () {
          var scope = (captcha.dialog && captcha.dialog.querySelectorAll) ? captcha.dialog : doc;
          var els = scope.querySelectorAll('button, a, [role="button"], .btn, .button, div, span');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!visible(el)) continue;
            var t = String(textOf(el) || '').trim();
            if (!t || t.length > 6) continue;                       // 太长的一定不是按钮
            if (/取消|关闭|重填|换一张|刷新|看不清/.test(t)) continue;
            if (/^(确定|提交|确认|验证|立即验证|OK|ok)/.test(t)) {
              // 选最内层的那个，避免点到包着整块的容器
              if (el.querySelector && el.querySelector('button, a, [role="button"], .btn')) continue;
              try { el.click(); return true; } catch (e) {}
            }
          }
          return false;
        }
      });

      // ④ 常见类名兜底
      list.push({
        name: 'known-class',
        run: function () {
          var sel = ['.verify-btn', '.sub-btn', '.btn-submit', '.captcha-submit', '.submit-btn', '.confirm-btn', '#submit', '#btnSubmit'];
          for (var i = 0; i < sel.length; i++) {
            if (clickIfVisible(doc.querySelector(sel[i]))) return true;
          }
          return false;
        }
      });

      // ⑤ 最近的 form 直接提交
      list.push({
        name: 'form-submit',
        run: function () {
          var form = input && input.closest ? input.closest('form') : null;
          if (!form) return false;
          try {
            if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
            form.submit(); return true;
          } catch (e) { return false; }
        }
      });

      // ⑥ 回车：keydown + keypress + keyup 三个都发
      list.push({
        name: 'enter-key',
        run: function () {
          if (!input) return false;
          var win = input.ownerDocument.defaultView || window;
          try {
            ['keydown', 'keypress', 'keyup'].forEach(function (type) {
              input.dispatchEvent(new win.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            });
            return true;
          } catch (e) { return false; }
        }
      });

      return list;
    },

    /** 验证码界面还在不在（跳过 1.5s 的结果缓存，按"现在"判断） */
    _captchaStillOpen: function () {
      this._captchaLastCheckAt = 0;
      var c = this._checkCaptchaDialog();
      this._captchaLastCheckAt = 0;
      return !!c;
    },

    /** 页面里有没有"成功"字样（有些站点不关弹窗，只把文字改成验证成功） */
    _captchaSuccessShown: function (captcha) {
      try {
        var doc = (captcha.input && captcha.input.ownerDocument) || document;
        var text = String(textOf(doc.body) || '');
        return /验证成功|验证通过|校验通过|验证码正确/.test(text);
      } catch (e) { return false; }
    },

    /**
     * 逐个策略试，每个都回读结果。返回命中的策略名（失败返回空串）。
     * ⚠️ 每步之间要**真的等一下**：有些站点的提交是异步的，点完立刻查必定"还在"。
     */
    _submitCaptchaWithStrategies: async function (captcha, code) {
      var doc = (captcha.input && captcha.input.ownerDocument) || document;
      var strategies = this._captchaSubmitStrategies(captcha);
      var tried = [];
      for (var i = 0; i < strategies.length; i++) {
        var st = strategies[i];
        var fired = false;
        try { fired = !!st.run(); } catch (e) { fired = false; }
        tried.push(st.name + (fired ? '' : '(no-target)'));
        if (!fired) continue;

        await sleep(600);
        if (!this._captchaStillOpen() || this._captchaSuccessShown(captcha)) {
          emitRuntimeLog('info', 'captcha submit ok', { strategy: st.name, tried: tried.join(',') });
          return st.name;
        }

        // 有些站点点完会弹「二次确认」——顺手点掉，再判断一次
        var confirmClicked = this._clickCaptchaConfirm();
        if (confirmClicked) {
          tried.push('confirm');
          await sleep(600);
          if (!this._captchaStillOpen() || this._captchaSuccessShown(captcha)) {
            emitRuntimeLog('info', 'captcha submit ok', { strategy: st.name + '+confirm', tried: tried.join(',') });
            return st.name + '+confirm';
          }
        }
      }
      // 全都失败：把现场"能点的东西"打进日志。
      // 下次再有人报"填对了却不确认"，一眼就能看出那个页面到底长什么样 ——
      // 这比"回来猜"有用得多。
      var inventory = [];
      try {
        var scope0 = (captcha.dialog && captcha.dialog.querySelectorAll) ? captcha.dialog : doc;
        var els0 = scope0.querySelectorAll('button, a, [role="button"], .btn, input[type="button"], input[type="submit"], div, span');
        for (var k = 0; k < els0.length && inventory.length < 8; k++) {
          var el0 = els0[k];
          var r0 = el0.getBoundingClientRect ? el0.getBoundingClientRect() : null;
          if (!r0 || r0.width < 8 || r0.height < 8) continue;
          var t0 = String(textOf(el0) || '').trim();
          if (!t0 || t0.length > 10) continue;
          if (el0.querySelector && el0.querySelector('button, a, [role="button"]')) continue;
          inventory.push(t0 + '<' + (el0.tagName || '') + (el0.id ? '#' + el0.id : '') + '>');
        }
      } catch (e2) {}
      var landedNow = '';
      try { landedNow = String((captcha.input && captcha.input.value) || ''); } catch (e3) {}
      emitRuntimeLog('warn', 'captcha submit: no strategy worked', {
        tried: tried.join(','),
        codeLength: code.length,
        landed: landedNow,
        inIframe: !!(captcha.input && captcha.input.ownerDocument && captcha.input.ownerDocument !== document),
        candidates: inventory.join(' | ') || '(none)'
      });
      return '';
    },

    /** 点掉"二次确认"框（新冒出来的那个"确定"） */
    _clickCaptchaConfirm: function () {
      try {
        var docs = [document];
        // 也看看同源的兄弟 iframe —— 确认框常常挂在外层页面
        try {
          var frames = document.querySelectorAll('iframe');
          for (var f = 0; f < frames.length; f++) {
            var d = this._safeDocOf && this._safeDocOf(frames[f]);
            if (d) docs.push(d);
          }
        } catch (e0) {}
        for (var i = 0; i < docs.length; i++) {
          var els = docs[i].querySelectorAll('button, a, [role="button"], .btn, .dialog-btn, div, span');
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || r.width < 8 || r.height < 8) continue;
            var t = String(textOf(el) || '').trim();
            if (t !== '确定' && t !== '确认' && t !== '是' && t !== 'OK') continue;
            if (el.querySelector && el.querySelector('button, a, [role="button"]')) continue;
            try { el.click(); return true; } catch (e) {}
          }
        }
      } catch (e) {}
      return false;
    },

    _captchaReload: function () {
      emitRuntimeLog('warn', 'captcha unsolved, reload page', {});
      try { window.location.reload(); } catch (e) {}
    },


    // ===== 独立验证码页：验证码不在学习通界面内，而是一个独立网址 / 弹出窗口 / 被跳转到的验证页 =====
    // 这类页面是顶层页面（不是跨域 iframe），插件可以完整访问 DOM，因此完全可以自动识别并填写。
    _recognizeCaptchaImage: async function (img) {
      var dataUrl = this._captureCaptchaImage(img);
      if (!dataUrl) {
        var absUrl = this._resolveImageUrl(img);
        if (absUrl) {
          try {
            var fetched = await bridgeSend('fetch_image', { url: absUrl });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = fetched.dataUrl;
          } catch (e0) {}
        }
      }
      if (!dataUrl) return { ok: false, error: 'captcha image capture failed' };

      var result = await bridgeSend('llm_captcha', { image: dataUrl });
      if (!result || !result.success) {
        return { ok: false, error: String((result && result.error) || 'no response').slice(0, 200) };
      }
      var code = this._cleanCaptchaCode(result.data);
      if (!code) return { ok: false, error: 'empty code after clean', raw: String(result.data || '').slice(0, 60) };
      return { ok: true, code: code };
    },


    // 独立验证页里定位「验证码图片 + 输入框」：整页就是一张验证表单，判定比弹窗场景宽
    _detectStandaloneCaptcha: function () {
      var doc = document;
      var imgs = [];
      try { imgs = Array.from(doc.querySelectorAll('img')); } catch (e) { return null; }
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (!visible(img)) continue;
        var w = img.naturalWidth || img.clientWidth || 0;
        var h = img.naturalHeight || img.clientHeight || 0;
        if (w && (w < 40 || w > 400)) continue;
        if (h && (h < 16 || h > 200)) continue;
        var area = (img.clientWidth || w) * (img.clientHeight || h);
        if (area > bestArea) { bestArea = area; best = img; }
      }
      if (!best) return null;

      var inputs = [];
      try { inputs = Array.from(doc.querySelectorAll('input')); } catch (e2) {}
      var input = null;
      for (var j = 0; j < inputs.length; j++) {
        var el = inputs[j];
        if (!visible(el)) continue;
        if (/^(hidden|checkbox|radio|button|submit|file|image)$/i.test(String(el.type || 'text'))) continue;
        input = el;
        break;
      }
      if (!input) return null;
      return { doc: doc, img: best, input: input, dialog: document.body, why: 'standalone-page' };
    },


    _computeStandaloneCaptchaPage: function () {
      try {
        if (this._getMainFrame()) return false; // 学习通课程页一定有 #iframe
        if (document.querySelector('#video, #audio, .TiMu, .questionLi, .swiper-container, .ans-attach')) return false;
        var bodyText = textOf(document.body || document.documentElement).slice(0, 800);
        var urlHit = /(verif|captcha|checkcode|validate|seccode|yzm|\/code|captchaImage)/i.test(String(location.href || ''));
        var textHit = /验证码|校验码|请输入|captcha|verify|robot|人机|安全验证/i.test(bodyText);
        if (!urlHit && !textHit) return false;
        return !!this._detectStandaloneCaptcha();
      } catch (e) {
        return false;
      }
    },


    _isStandaloneCaptchaPage: function () {
      var now = Date.now();
      var href = String(location.href || '');
      if (this._standaloneCaptchaUrl !== href) {
        this._standaloneCaptchaUrl = href;
        this._standaloneCaptchaAt = 0;
        this._standaloneCaptchaResult = false;
      }
      if (now - (this._standaloneCaptchaAt || 0) < 1500) return this._standaloneCaptchaResult;
      this._standaloneCaptchaAt = now;
      this._standaloneCaptchaResult = this._computeStandaloneCaptchaPage();
      return this._standaloneCaptchaResult;
    },


    _runStandaloneCaptchaMode: async function () {
      if (this._captchaBusy) return;
      this._captchaBusy = true;
      emitRuntimeLog('warn', 'standalone captcha page detected, solving', { url: String(location.href || '').slice(0, 120) });
      try {
        if (this.configs.enableCaptcha === false) {
          emitRuntimeLog('info', 'captcha handling disabled by switch', {});
          return;
        }
        for (var attempt = 1; attempt <= 4; attempt++) {
          var captcha = this._detectStandaloneCaptcha();
          if (!captcha) {
            emitRuntimeLog('info', 'standalone captcha elements gone, nothing to solve', {});
            return;
          }
          var rec = await this._recognizeCaptchaImage(captcha.img);
          if (rec.ok) {
            this._fillCaptchaInput(captcha, rec.code);
            await sleep(300);
            this._clickCaptchaSubmit(captcha);
            emitRuntimeLog('info', 'standalone captcha code submitted', { attempt: attempt, length: rec.code.length });
          } else {
            emitRuntimeLog('error', 'captcha recognize failed', {
              attempt: attempt,
              error: String(rec.error || '').slice(0, 160)
            });
          }

          await sleep(2600);
          this._standaloneCaptchaAt = 0; // 强制重新判定，不受节流影响
          if (!this._isStandaloneCaptchaPage()) {
            emitRuntimeLog('info', 'standalone captcha solved', {});
            this._afterStandaloneCaptchaSolved();
            return;
          }
          try { captcha.img.click(); } catch (e2) {} // 识别错/过期就换一张
          await sleep(700);
        }
        emitRuntimeLog('warn', 'standalone captcha unsolved after retries, reload page', {});
        try { window.location.reload(); } catch (e3) {}
      } finally {
        this._captchaBusy = false;
      }
    },


    // 验证通过后：弹出窗口自动关闭；主标签页则回退，把位置让回学习通继续刷课
    _afterStandaloneCaptchaSolved: function () {
      try {
        if (window.opener && !window.opener.closed) {
          emitRuntimeLog('info', 'captcha popup solved, closing window', {});
          try { window.close(); return; } catch (e0) {}
        }
      } catch (e) {}
      try {
        if (history.length > 1) {
          emitRuntimeLog('info', 'captcha solved, going back to previous page', {});
          history.back();
          return;
        }
      } catch (e2) {}
      emitRuntimeLog('info', 'captcha solved, waiting for page redirect', {});
    },


    _handleCaptchaDialog: async function (captcha) {
      if (this._captchaBusy) return;
      this._captchaBusy = true;
      var attempts = this._captchaAttempts || 0;
      try {
        emitRuntimeLog('warn', 'captcha detected, recognizing', { attempt: attempts + 1, match: captcha.why || '' });
        console.log('%c[Omitone] captcha detected (' + (captcha.why || 'unknown') + '), recognizing...', 'color:#FF9800');

        var dataUrl = this._captureCaptchaImage(captcha.img);
        if (!dataUrl) {
          var absUrl = this._resolveImageUrl(captcha.img);
          if (absUrl) {
            var fetched = await bridgeSend('fetch_image', { url: absUrl });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = fetched.dataUrl;
          }
        }
        if (!dataUrl) {
          emitRuntimeLog('error', 'captcha image capture failed', {});
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        var result = await bridgeSend('llm_captcha', { image: dataUrl });
        if (!result || !result.success) {
          var errText = String((result && result.error) || '无响应').slice(0, 200);
          var hint = /API Key/i.test(errText) ? '（未配置 API Key：验证码识别独立于 AI 答题开关，只需在 popup 填好 API Key 和视觉模型）'
            : /image|multimodal|vision|not support|unsupported|400|415/i.test(errText) ? '（当前模型可能不支持图片输入：请在 popup 的"验证码识别模型"里填写视觉模型，如 gemini-2.5-flash / qwen-vl-max / gpt-4o-mini）'
            : '';
          emitRuntimeLog('error', 'captcha recognize failed', {
            error: errText,
            hint: hint
          });
          console.warn('[Omitone] captcha recognize failed:', errText, hint);
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        var code = this._cleanCaptchaCode(result.data);
        if (!code) {
          emitRuntimeLog('error', 'captcha code empty after clean', { raw: String(result.data || '').slice(0, 60) });
          this._captchaFailCount = (this._captchaFailCount || 0) + 1;
          if (this._captchaFailCount >= 3) {
            this._captchaFailCount = 0;
            this._captchaReload();
          }
          return;
        }

        emitRuntimeLog('info', 'captcha code filled', { length: code.length });
        this._fillCaptchaInput(captcha, code);
        await sleep(350);

        // 回读：值真的进去了吗？进不去说明是受控组件把我们写的值吞了 —— 那后面怎么点都没用
        var landed = '';
        try { landed = String((captcha.input && captcha.input.value) || ''); } catch (e0) {}
        if (landed.replace(/\s/g, '') !== String(code).replace(/\s/g, '')) {
          emitRuntimeLog('warn', 'captcha value not landed', { want: String(code).length, got: landed.length });
        }

        // 逐个策略试提交（含二次确认），每种都回读结果
        var okStrategy = await this._submitCaptchaWithStrategies(captcha, code);

        // 兜底：再等一轮。有的站点提交后要 5 秒以上才收起弹窗
        for (var waitIdx = 0; waitIdx < 3; waitIdx++) {
          await sleep(1200);
          if (!this._captchaStillOpen() || this._captchaSuccessShown(captcha)) {
            emitRuntimeLog('info', 'captcha solved, continue', { strategy: okStrategy || 'late', waited: (waitIdx + 1) * 1200 });
            this._captchaAttempts = 0;
            this._captchaFailCount = 0;
            this._captchaActive = false;
            return;
          }
        }

        var stillThere = this._captchaStillOpen();
        if (!stillThere) {
          emitRuntimeLog('info', 'captcha solved, continue', {});
          this._captchaAttempts = 0;
          this._captchaFailCount = 0;
          this._captchaActive = false;
          return;
        }
        this._captchaAttempts = attempts + 1;
        if (this._captchaAttempts >= 3) {
          this._captchaAttempts = 0;
          emitRuntimeLog('warn', 'captcha wrong too many times, reload page', {});
          this._captchaReload();
        } else {
          emitRuntimeLog('warn', 'captcha seems wrong, will retry with new image', { attempt: this._captchaAttempts });
          try { captcha.img.click(); } catch (e2) {}
        }
      } finally {
        this._captchaBusy = false;
      }
    },


    _backgroundCaptchaTick: function () {
      if (this._captchaBusy) return;
      var captcha = this._checkCaptchaDialog();
      if (captcha) {
        var self = this;
        this._handleCaptchaDialog(captcha).catch(function () {
          self._captchaBusy = false;
        });
      }
    },
