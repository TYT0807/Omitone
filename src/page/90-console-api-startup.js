/* ==========================================================================
 * Omitone page.js 片段 11/11 —— app 收尾 / window.xxtAI 控制台入口 / 启动
 * 原 page.js 第 9677–9898 行
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * **本文件以 `};` 开头**（闭合 app 对象字面量），随后是 window.xxtAI 与启动逻辑
 * window.xxtAI 是给用户的手动调试入口（skipQuiz / diagnosePopup / taskGiveUpList 等）—— 必须保留
 * ========================================================================== */
// @omitone-part-header-end
  };

  function removeStartPanel() {
    var panel = document.getElementById('xxt-panel');
    if (panel) panel.remove();
  }

  function showStartPanel(config) {
    removeStartPanel();

    var currentConfig = mergeConfig(config);
    var hasApiKey = !!String(currentConfig.apiKey || '').trim();
    var playOn = currentConfig.autoNext !== false;
    var quizOn = !!(currentConfig.enableQuiz && hasApiKey);

    var panel = document.createElement('div');
    panel.id = 'xxt-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'z-index:999999',
      'background:#fff',
      'border:1px solid #ddd',
      'border-radius:10px',
      'padding:24px',
      'min-width:280px',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.12)',
      'color:#111'
    ].join(';');

    function renderToggle(on) {
      return '<span style="display:inline-flex;width:36px;height:20px;background:' + (on ? '#111' : '#ddd') + ';border-radius:20px;position:relative;">' +
        '<span style="position:absolute;top:2px;left:' + (on ? '18px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:#fff;"></span>' +
        '</span>';
    }

      panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">' +
        '<strong style="font-size:15px;">' + APP_NAME + '</strong>' +
        '<span style="font-size:11px;color:#999;">page runtime</span>' +
      '</div>' +
      '<div id="xxt-row-play" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;">' +
        '<span>自动连播</span>' +
        '<span id="xxt-toggle-play">' + renderToggle(playOn) + '</span>' +
      '</div>' +
      '<div id="xxt-row-quiz" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;' + (hasApiKey ? 'cursor:pointer;' : 'opacity:.45;') + '">' +
        '<span>自动答题</span>' +
        '<span id="xxt-toggle-quiz">' + (hasApiKey ? renderToggle(quizOn) : '<span style="font-size:11px;color:#999;">需 API Key</span>') + '</span>' +
      '</div>' +
      '<button id="xxt-btn-start" style="width:100%;margin-top:16px;padding:10px 0;border:none;border-radius:6px;background:#111;color:#fff;font-weight:600;cursor:pointer;">开始</button>' +
      '<button id="xxt-btn-close" style="width:100%;margin-top:8px;padding:9px 0;border:1px solid #e6e6e6;border-radius:6px;background:#fff;color:#666;cursor:pointer;">关闭</button>';

    document.body.appendChild(panel);

    function updatePlay() {
      var slot = document.getElementById('xxt-toggle-play');
      if (slot) slot.innerHTML = renderToggle(playOn);
    }

    function updateQuiz() {
      var slot = document.getElementById('xxt-toggle-quiz');
      if (slot && hasApiKey) slot.innerHTML = renderToggle(quizOn);
    }

    document.getElementById('xxt-row-play').addEventListener('click', function () {
      playOn = !playOn;
      updatePlay();
    });

    if (hasApiKey) {
      document.getElementById('xxt-row-quiz').addEventListener('click', function () {
        quizOn = !quizOn;
        updateQuiz();
      });
    }

    document.getElementById('xxt-btn-start').addEventListener('click', function () {
      panel.remove();
      app.configs = mergeConfig(Object.assign({}, currentConfig, { autoNext: playOn, enableQuiz: quizOn && hasApiKey }));
      app.run();
      window._xxtApp = app;
    });

    document.getElementById('xxt-btn-close').addEventListener('click', function () {
      panel.remove();
      window._xxtApp = app;
    });
  }

  function shouldAutoStart() {
    var root = document.documentElement;
    if (!root) return false;
    var flag = root.getAttribute(AUTO_START_ATTR) === '1';
    if (flag) root.removeAttribute(AUTO_START_ATTR);
    return flag;
  }

  var defaultConfig = mergeConfig({ apiKey: '', autoNext: true, enableQuiz: false });
  app.configs = defaultConfig;
  window._xxtApp = app;

  bridgeSend('get_config').then(function (config) {
    app.configs = mergeConfig(config || defaultConfig);
    // 只有"刷课进行中"（有续跑标记）时才自动开始——讨论页/验证码页也一样，
    // 避免没在刷课时打开讨论区就被自动发评论
    if (shouldAutoStart()) {
      app.run();
      return;
    }
    // 未刷课时进入讨论页/独立验证码页：保持静默，不显示面板、不做任何操作
    if (app._isDiscussionContext() || app._isStandaloneCaptchaPage()) return;
    if (app._getMainFrame()) showStartPanel(app.configs);
  }).catch(function () {
    if (shouldAutoStart()) {
      app.run();
      return;
    }
    if (app._isDiscussionContext() || app._isStandaloneCaptchaPage()) return;
    if (app._getMainFrame()) showStartPanel(defaultConfig);
  });

  var preventPause = function (event) {
    event.stopPropagation();
    event.preventDefault();
  };

  var resumeNow = function () {
    if (app && typeof app._tryResumePlayback === 'function') app._tryResumePlayback('page-event');
  };

  document.addEventListener('mouseleave', preventPause);
  window.addEventListener('mouseleave', preventPause);
  document.addEventListener('mouseout', preventPause);
  window.addEventListener('mouseout', preventPause);
  window.addEventListener('blur', resumeNow);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) resumeNow();
  });

  window.xxtAI = {
    reload: function () {
      bridgeSend('get_config').then(function (config) {
        app.configs = mergeConfig(config || defaultConfig);
        showStartPanel(app.configs);
      });
    },
    next: function () {
      if (app) app.nextUnit();
    },
    skipQuiz: function () {
      if (app) app._skipQuiz();
    },
    /**
     * 题目扫描诊断。扫不到题时在页面控制台执行 `xxtAI.diagnose()`，
     * 返回值会直接打印出来，同时写入运行日志（popup → 查看日志 可以看到）。
     * 把这段输出发出来就能定位是哪一环断了。
     */
    diagnose: function () {
      if (!app) return null;
      var report = app._diagnoseQuestionScan(null);
      emitRuntimeLog('info', 'quiz scan diagnosis (manual)', report);
      console.log('[Omitone] quiz scan diagnosis:', report);
      console.log(JSON.stringify(report, null, 2));
      return report;
    },
    /** 手动跑一次题目抽取，返回抽到的题目数组（不答题、不提交）。 */
    scanQuiz: function () {
      if (!app) return null;
      var questions = app._extractQuestions(null);
      console.log('[Omitone] scanned questions:', questions.length, questions);
      emitRuntimeLog('info', 'quiz scan (manual)', {
        count: questions.length,
        types: questions.map(function (q) { return q.type; })
      });
      return questions;
    },
    /**
     * 弹窗题诊断。视频里弹出的题"AI 扫描了但从不填空"时，在页面控制台执行
     * `xxtAI.diagnosePopup()`：它会把弹窗的真实结构、抠到的选项、推断出的字母
     * 以及放弃计数一起打出来，据此就能判断是结构不认识还是选项匹配不上。
     */
    diagnosePopup: function () {
      if (!app) return null;
      var node = null;
      try { node = app._checkPopupQuiz(); } catch (e) { node = null; }
      var report = {
        found: !!node,
        blocked: !!(app._popupQuizBlockedUntil && Date.now() < app._popupQuizBlockedUntil),
        attempts: app._popupQuizAttempts,
        maxAttempts: app._getPopupQuizMaxAttempts(),
        popup: node ? app._describePopupQuiz(node) : null
      };
      console.log('[Omitone] popup quiz diagnose:', report);
      emitRuntimeLog('info', 'popup quiz diagnose (manual)', report);
      return report;
    },
    /**
     * 查看/清除"做不完的任务点"名单。
     * 老师把任务点设成防拖拽或不可翻页时，插件连续几次做不完就会记入这个名单、
     * 24 小时内不再尝试。想让它再试一次就调 clearTaskGiveUp()。
     */
    taskGiveUpList: function () {
      if (!app) return null;
      var list = app._taskGiveUpList();
      console.log('[Omitone] task give-up list:', list);
      return list;
    },
    clearTaskGiveUp: function () {
      if (!app) return null;
      app._clearTaskGiveUp();
      emitRuntimeLog('info', 'task give-up list cleared (manual)', {});
      console.log('[Omitone] task give-up list cleared');
      return true;
    }
  };
})();



