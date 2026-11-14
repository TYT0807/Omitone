var OMITONE_CODE_REV = '62aea53efc';
/**
 * Omitone page runtime for Chaoxing.
 * Runs in the page context and talks to the isolated content script bridge.
 */
(function () {
  'use strict';

  var INSTANCE_ID = (window._XXT_UID || 0) + 1;
  window._XXT_UID = INSTANCE_ID;

  function isActiveInstance() {
    return window._XXT_UID === INSTANCE_ID;
  }

  var APP_NAME = 'Omitone';
  var AUTO_START_ATTR = 'data-xxt-auto-start';

  /**
   * 弹题填完答案后的「静默期」。
   *
   * 为什么需要它：站点在答完之后会**重绘弹窗**（给正确项打勾 / 加提示 / 重排），
   * 而防重问的指纹取的是**选项文本** —— 文本一变指纹就变、"已答放行"立刻失效，
   * 弹窗被当成新题 → 再问模型 → 再点一次选项 → 站点再重绘 …… 死循环。
   * 现场表现就是"选项一直闪"，而且指纹一变 `_popupQuizAttempts` 就被重置，
   * "最多问 3 次就放手"这个安全阀**永远触发不了**。
   * 所以填完之后统一静默一段时间，无论指纹怎么变都不碰它。
   *
   * ⚠️ 「已答放行」的窗口**必须与它相等，绝不能更长** ——
   * 详见 `_handlePopupQuiz` 里填答成功那一段（曾经写成 30 秒，
   * 于是答错后有 22 秒处于"静默期已过、却仍被当成已答"的没人管空档）。
   */
  var POPUP_QUIZ_QUIET_MS = 8000;

  /**
   * 模型接口返回 4xx（Key 无效 / 无权限 / 模型名不存在）之后，跳过答题的窗口。
   *
   * ⚠️ 它**不是退避**，绝不能和 `_markQuizApiConnectionFailed` 的 45 秒混为一谈：
   * 4xx 是配置问题，重试一万次也还是 4xx，退避只会把"配置填错了"伪装成
   * "网络连不上、插件卡死"（用户根本看不到服务商给的 "Invalid API key"）。
   * 这里给 60 秒只是留出改配置的时间，改完下一轮自动恢复。
   */
  var PERMANENT_LLM_ERROR_SKIP_MS = 60000;

  /**
   * 投票任务点（insertvote）的四个数。
   *
   * 覆盖层是平台自己点出来的（直接访问那个 api/work 地址是 403），所以要等它长出来；
   * 提交后任务盒翻 `ans-job-finished` 是异步的，也要等。两个等待都有界 ——
   * 新增 await 必须可超时是硬规矩（AGENTS §2.2）。
   *
   * 次数与冷却管的是另一件事：投不出去时不能每 5 秒再交一次，
   * 但**绝不能永久跳过** —— 冷却到期照旧重试，并把次数留在日志里。
   */
  var VOTE_OVERLAY_WAIT_MS = 12000;
  var VOTE_BOX_WAIT_MS = 15000;
  var VOTE_MAX_TRIES = 4;
  var VOTE_COOLDOWN_MS = 5 * 60 * 1000;

  var DEFAULT_CONFIG = {
    playbackRate: 1.0,
    autoMaxPlaybackRate: true,
    playbackRateCap: 4,
    muted: false,
    // 讨论任务点：自动打开讨论页并发布评论（内容见 discussionReply），完成后自动返回继续刷课
    enableDiscussion: true,
    discussionReply: '1',
    discussionTimeoutMs: 90000,
    // 投票任务点（insertvote）：点开平台自己的投票覆盖层、随手勾第一项、提交。
    // 不计分，只要把任务盒翻成已完成；关掉它就会停在「还有任务点未完成」那一节。
    enableVote: true,
    autoNext: true,
    enableQuiz: true,
    // 内部调参（不上弹窗）：追加的题目容器选择器。学习通改版换了题目标记时，
    // 在 chrome.storage.local 的 config 里加一条就能顶上，不必等发版 ——
    // 会追加到真源 `_questionSelectors` 的**末尾**逐个尝试（内置清单优先命中）。
    // 校验在 libs/runtime-policy.js 的 validField（字符串数组，≤12 条、单条 ≤200 字符）。
    // 例：{"questionSelectorOverrides": [".newQuizBox"]}
    questionSelectorOverrides: [],
    // 「乱选」：不接 AI，本地随机生成答案。给不想配 API key 的用户用，
    // 只求把卷交出去，不求对。默认关。
    randomAnswer: false,
    // 乱选填满整卷之后、**点提交之前**留给检查的秒数（判据见 75-quiz-dom.js `_maybeSubmitQuiz`）。
    // 为什么默认 30 而不是 0：交卷是不可逆的，而乱选的答案是猜的 —— 原样填完就交，
    // 用户看到的第一句永远是「怎么不能改了」。30 秒里可以自己改、也可以直接交（手动点）。
    // 设 0 = 完全不自动交卷，停在「等你检查后自己交」；设大了就是给自己更多检查时间。
    randomAnswerReviewSec: 30,
    enableCaptcha: true,
    // 主内容区被换成跨域页面（验证码/反作弊）且持续 20 秒无法访问时自动刷新恢复（3 分钟冷却）
    blockedReload: true,
    enableMedia: true,
    enableSeek: true,
    // 防拖拽 + 倍速锁 1x 的视频：老师要求的只是「观看时长 ≥ 总时长的 90%」，
    // 拖不动、也加不了速，最后那 10% 纯粹是白等。
    // 这类视频在**平台自己标记任务点已完成**之后立刻进下一个（判据见 _isNinetyPercentVideo）。
    // 关键安全阀：只认平台给出的完成标记，不靠"播够 90% 就自己认定完成"。
    advanceAtNinetyPercent: true,
    enablePPT: true,
    enableHyperlink: true,
    restudy: false,
    apiType: 'openai',
    apiUrl: 'https://api.deepseek.com',
    hasApiKey: false,
    apiConnectionFailed: false,
    // 失败原因字符串（apiConnectionError）**故意不投影到页面**：它可能带服务商原话，
    // 而 publicConfig 走 window.postMessage，页面脚本看得见。真源只在弹窗与后台之间。
    model: 'deepseek-flash',
    captchaModel: '',
    // ===== 视觉模型（图片理解）=====
    //
    // 背景：题干和选项里经常带图片（数学图形、化学结构、电路图、表格截图、
    // "看图选择"），而题目解析只读文本 —— 图片被静默丢掉，模型只能瞎猜。
    //
    // ⚠️ 但这东西**默认必须是关的**。原因不是技术风险，是钱：
    // 一张 1000×800 的 PNG 编码成 base64 后约 200~400KB，按视觉模型计费
    // 往往是纯文本的几十倍，而一道题可能带好几张图。
    // 用户能接受"刷不了课"，不能接受"花了钱还是不行" ——
    // 所以没明确开启、没设预算之前，一张图都不发。
    visionEnabled: false,
    // 发图时用哪个模型。留空则回落 captchaModel，再回落 model。
    //
    // 单独一个字段是必要的：主模型往往是为"便宜快"挑的文本模型（deepseek-chat
    // 这类），它**不支持图片**，塞图进去要么 400 要么被忽略掉、
    // 用户只会看到"开了却没用，但钱扣了"。所以这里必须能单独指定。
    visionModel: '',
    // 单题最多带几张图。默认 2 —— 超过这个数的题通常是"资料题"，
    // 图多得离谱、收益却很低，不如直接放弃。
    visionMaxImagesPerQuestion: 2,
    // 单张图最大字节数（base64 之前的原始大小）。超过就**跳过不缩放**：
    // 缩放需要 canvas 重编码，在页面上下文里既慢又容易踩跨域污染，
    // 而且缩放后的图模型未必看得清。跳过并写日志，比偷偷发一张大图省钱。
    visionMaxImageBytes: 400000,
    // 每章视觉调用预算（次）。用完就停，直到进入下一章。
    // 这是最重要的那道闸：即使配置写错、或者页面版式异常导致重复抓图，
    // 也不可能无限发请求。用完时**必定**写一条 warn 日志，
    // 绝不静默 —— "钱花了但不知道花在哪"是最不能接受的失败方式。
    visionBudgetPerChapter: 30,
    // 一次请求里最多打包几张图（把同一题的图合到一次请求，而不是一题一请求）。
    // 合包能显著省钱：省掉重复的系统提示词与题干。
    visionImagesPerRequest: 2,
    // 思考强度：'off'（默认，最省最快）/ 'low' / 'high'。
    //
    // ⚠️ 只有 'off' 是实测过的 —— 它就是本项目原来一直用的行为（DeepSeek 关思考）。
    // 'low' / 'high' 会多发推理参数：支持的厂商没问题，不支持的厂商可能直接 400。
    // 因此 content.js 里是**按渠道白名单**发参数的，未知渠道一个参数都不发
    // （见 libs/thinking.js 的说明）。默认值选 'off' 也意味着老用户升级后行为不变。
    thinkingLevel: 'off',
    systemPrompt: '',
    videoCheckInterval: 1500,
    // 慢机自适应：auto=按实测帧率/核心数放大所有等待上限，on=固定 2 倍，off=完全不放大。
    // 默认 auto 且测不出来时系数为 1 —— 老机器的行为完全不变。
    slowMachineMode: 'auto',
    // 题目文字还在 font-cxsecret 密文态时，最多等多久再按现状答题（原来是写死的 8000）。
    fontDecryptWaitMs: 8000,
    stepSwitchGraceMs: 7000,
    stepSwitchInitDelayMs: 2200,
    taskDiscoverGraceMs: 8000,
    taskPendingGraceMs: 7000,
    quizSubmitWaitMs: 25000,
    quizMaxSubmitAttempts: 20,
    // 一题都填不上时，是否**自动跳过这一卷**（内部调参，不上弹窗）。
    //
    // ⚠️ 默认**关**。原因（2026-11-10 事故）：有卷子的题一题都落不到页面上，
    // 旧行为是卡住（用户看得见、可以手动做），而"自动跳过"会让整卷悄无声息地被跳过 ——
    // 用户看到的是「所有答题都废了」，比卡住更糟。只有在确认"填不上"是结构性问题、
    // 且后面的任务更值得先做时，才由用户显式打开。
    quizZeroFillSkip: false,
    // 同一道选择题连续这么多次没被平台接受后，就"放弃继续折腾"：
    // 不再为它扩错答列表、不再进 LLM 请求，直接填本地最优猜测，让整卷交得出去。
    // 不设这条的后果是"一道多选把整卷钉在原地"——用户报的"章节小测一直卡住"。
    quizQuestionMaxMisses: 3,
    // 同一道弹题最多问模型几次，超过就放手并冷却（见 _giveUpPopupQuiz）。
    // 以前只靠 _getPopupQuizMaxAttempts 里的 `|| 3` 兜底，默认值表里查不到。
    popupQuizMaxAttempts: 3,
    documentSkipTimeoutMs: 120000,
    // 单个任务点连续多少次"派发了但没完成"就放弃（记入 24 小时跳过名单）。
    // 用于对付老师设成防拖拽/不可翻页、或本身不计分的任务点 —— 它们只会白耗时间。
    // 只在**确认没完成**时计数，拿不准一律当作完成，所以调小也相对安全。
    taskGiveUpAttempts: 4,
    pptFlipIntervalMs: 1000,
    guardNoProgressMs: 6000,
    guardResumeCooldownMs: 2500,
    guardMaxResumeWindow: 15000,
    guardMaxResumes: 5
  };

  function mergeConfig(config) {
    var nextConfig = Object.assign({}, config || {});
    delete nextConfig.forceLearn;
    return Object.assign({}, DEFAULT_CONFIG, nextConfig);
  }

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent) return true;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!(rect && rect.width > 0 && rect.height > 0);
  }

  /**
   * 取「页面上的文字」。
   *
   * ⚠️ **回落分支必须跳过 `<script>` / `<style>` 的源码。**
   * 原先写的是 `el.innerText || el.textContent` —— 看上去等价，实则有毒：
   * `innerText` 在**元素不可见 / 未渲染**时返回空串，而**空串是假值**，
   * 于是 `||` 会回落到 `textContent`，**而 `textContent` 会把脚本源码一起算成文字**。
   * 后果是「平台自己脚本里的一句话」会被当成页面文案。
   *
   * 实测（2026-10-17，用户现场）：`work` 模块页的 `<script>` 里有一行无障碍支持代码
   * `jobIconDiv.set({'aria-label': '任务点已完成'});` —— 于是整份 **19 道题的卷子**
   * 被判成「已完成」→ 静默跳过 → 页面推不动 → 空转死循环。
   *
   * 同类隐患（都靠关键词判断，都会中同一招）：`_isCurrentCompleted` 判整章完成、
   * 重做判定、验证码判定、提交确认弹窗判定。所以修在这里、而不是修某一个调用点。
   */
  var TEXT_OF_SKIP_TAGS = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };

  function textOf(el) {
    if (!el) return '';
    var visibleText = '';
    try { visibleText = el.innerText || ''; } catch (eVisible) {}
    if (visibleText) return String(visibleText).replace(/\s+/g, ' ').trim();

    // 兜底：自己走一遍 DOM，跳过脚本类节点。
    // 只有「可见文本为空」时才走这里（不可见或真的没字），所以不在热路径上。
    // 拼接用空串、不补分隔符 —— 与 `textContent` 的语义逐字一致，只少了脚本源码。
    var parts = [];
    (function collect(node) {
      if (!node) return;
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      if (TEXT_OF_SKIP_TAGS[String(node.tagName || '').toUpperCase()]) return;
      var kids = node.childNodes;
      for (var i = 0; kids && i < kids.length; i++) collect(kids[i]);
    })(el);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ── 慢机自适应 ──────────────────────────────────────────────────────────
  // 轻薄本 / CPU 高负载时，DOM 渲染、iframe 加载、字体解密都被拉长，而本项目
  // 原来的等待全是「固定睡 N 毫秒」：页面还没就绪就判「没任务 / 没填上 / 交卷失败」。
  // 这里给一个统一系数，所有宽限都乘它。默认 auto；测不出帧率时系数恒为 1，
  // 所以 e2e 无头环境和正常机器上的行为与改动前完全一致。
  var perfProbe = { fps: 0, cores: 0 };

  function perfFactor() {
    var mode = 'auto';
    try {
      var cfg = window._xxtApp && window._xxtApp.configs;
      if (cfg && cfg.slowMachineMode) mode = String(cfg.slowMachineMode);
    } catch (eMode) {}
    if (mode === 'off') return 1;
    if (mode === 'on') return 2;
    var factor = 1;
    if (perfProbe.fps > 0) {
      if (perfProbe.fps < 25) factor = 2;
      else if (perfProbe.fps < 45) factor = 1.5;
    }
    if (perfProbe.cores > 0 && perfProbe.cores <= 4 && factor < 1.5) factor = 1.5;
    return factor;
  }

  function scaledMs(base) {
    return Math.round(Number(base || 0) * perfFactor());
  }

  function startPerfProbe() {
    try { perfProbe.cores = Number(navigator.hardwareConcurrency || 0); } catch (eCores) {}
    if (typeof requestAnimationFrame !== 'function') return;
    var frames = 0, startAt = 0;
    function tick(now) {
      if (!startAt) startAt = now;
      frames += 1;
      if (now - startAt < 700) { requestAnimationFrame(tick); return; }
      perfProbe.fps = frames / ((now - startAt) / 1000);
      window.__omitonePerf = {
        fps: Math.round(perfProbe.fps),
        cores: perfProbe.cores,
        factor: perfFactor()
      };
      emitRuntimeLog('info', 'performance profile', window.__omitonePerf);
    }
    requestAnimationFrame(tick);
  }

  /**
   * 等「条件就绪」，而不是睡够固定时间。
   * ⚠️ 自带墙钟超时，Promise 一定会 resolve —— 满足「新增 await 必须可超时」。
   * 轮询用主线程定时器，但超时判据用 Date.now()，所以 CPU 满载把定时器延后时
   * 也只是走到兜底分支，不会变成新的死锁点。
   */
  function waitForReady(check, baseMs) {
    var limit = scaledMs(baseMs || 1000);
    var started = Date.now();
    return new Promise(function (resolve) {
      function step() {
        var ok = false;
        try { ok = !!check(); } catch (eCheck) {}
        if (ok) return resolve(true);
        if (Date.now() - started >= limit) return resolve(false);
        setTimeout(step, 150);
      }
      step();
    });
  }

  var bridgeMsgId = 0;
  var bridgeCallbacks = Object.create(null);

  function emitRuntimeLog(level, message, meta) {
    try {
      window.postMessage({
        source: 'xxt_app',
        type: 'runtime_log',
        level: level || 'info',
        message: message,
        meta: meta || null
      }, '*');
    } catch (e) {}
  }

  var BRIDGE_TIMEOUT_MS = 90000; // content 侧异常不回消息时必须超时释放，否则 _runTick 的 await 永久挂起、整个循环死亡

  function bridgeSend(type, payload) {
    return new Promise(function (resolve) {
      var id = ++bridgeMsgId;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete bridgeCallbacks[id];
        resolve({ success: false, error: 'bridge timeout: ' + type + ' no response in ' + BRIDGE_TIMEOUT_MS + 'ms' });
      }, BRIDGE_TIMEOUT_MS);
      bridgeCallbacks[id] = function (data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data);
      };
      window.postMessage({ source: 'xxt_app', id: id, type: type, payload: payload }, '*');
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'xxt_bridge') return;

    if (msg.type === 'config_response' || msg.type === 'llm_response') {
      var cb = bridgeCallbacks[msg.id];
      if (cb) {
        cb(msg.data);
        delete bridgeCallbacks[msg.id];
      }
      return;
    }

    if (msg.type === 'XXT_CONFIG_UPDATED' && window._xxtApp) {
      window._xxtApp.configs = mergeConfig(Object.assign({}, window._xxtApp.configs || {}, msg.data || {}));
      if (window._xxtApp.configs.apiConnectionFailed) {
        window._xxtApp._quizApiFailUntil = Math.max(window._xxtApp._quizApiFailUntil || 0, Date.now() + 45000);
      }
      console.log('%c[Omitone] config updated', 'color:#2196F3');
    }
  });

  var app = {
    configs: mergeConfig({ hasApiKey: false, autoNext: true, enableQuiz: false }),


    _videoEl: null,

    _videoCount: 0,

    _currentVideoIndex: 0,

    _isPlaying: false,

    _checkInterval: null,

    _tickLoopInterval: null,

    // 主循环的重入锁与看门狗时间戳。
    // ⚠️ 这两个原先**从未声明**，全靠 `this._tickRunning = true` 现建 —— 值上没坏
    //    （undefined 是假值），但破坏了"状态字段全在这一个文件里"这条规矩：
    //    想找主循环的状态，在 10-config-state.js 里 grep 不到。
    _tickRunning: false,

    _tickStartedAt: 0,

    // 主循环的"代"号：看门狗强制释放锁时 +1，用来作废旧 tick 的复位权（见 _runTick 的 finally）
    _tickEpoch: 0,

    // 「进度心跳」时间戳：**由长任务的循环主动刷新**，用来把看门狗的判据从
    // 「tick 活了多久」改成「多久没有进展」（见 _startTickLoop 的看门狗与 _tickProgress）。
    // 为什么需要它：PPT 音频任务的单页等待上限是 600 秒（40-media.js 的 _waitSlideAudioDone），
    // 远超看门狗的 150 秒 —— 没有心跳时，**正常干活的长任务会被误判成卡死并强制放锁**，
    // 于是新一轮 tick 与仍在推进的旧 tick 同时操作同一个任务点。
    _tickProgressAt: 0,

    // 心跳日志节流：只在 note 变化或距上次日志超过 30 秒时才打，避免刷爆日志
    _tickProgressNote: '',
    _tickProgressLogAt: 0,

    _quizInProgress: false,

    // `_quizInProgress` 置真的时刻 —— 专给「泄漏自愈」用（70-quiz-flow.js `_handleQuiz`）。
    // 没有它，异常岔路留下的 true 就是永久的：第一行挡住一切、整页停摆，
    // 日志里只有一条 30 秒去重的 tick error。声明在这儿而不是就地赋值，
    // 是为了让它进片段头清单（`npm run check` 第 15 项核对状态字段与计数）。
    _quizInProgressAt: 0,

    _quizAnswered: false,

    _quizSubmitPending: false,

    _quizSubmitStartedAt: 0,

    _quizSubmitLogAt: 0,

    _quizLastSubmitAttemptAt: 0,

    _quizHoldLogAt: 0,

    // 批次 10-C：「有作答框 + 命中题形容器、却一题没抠出来」的帧 —— 完成判定的**有界**延时。
    // `_quizParseRetryUntil` 是窗口终点，`_quizParseRetryScope` 记住这个窗口已经给过哪张卡片
    // （同一张卡片只给一次，用完就放行，避免把「跳过」换成另一种「磨蹭」），
    // `_quizParseRetryWarnAt` 只给「窗口已用掉」那条 warn 去重。声明在此见本段头注。
    _quizParseRetryUntil: 0,
    _quizParseRetryScope: '',
    _quizParseRetryWarnAt: 0,

    // 批次 19-B：任务帧**自己说还在加载**（「正在为您加载文件…」）或整张白纸时的有界搜索窗。
    // 现场（2026-11-11 真页面）：13:41:20 `study begin {attachments:6}` →
    //   13:41:33 `every candidate frame was rejected {sig.text:"正在为您加载文件..."}` →
    //   `study finished on page {searchedCount:0}` → 整节 6 个任务点被翻过去。
    // 与 `_quizParseRetry*` 同一套纪律：每张卡片只给一个窗口，用完放行，不许把「跳过」换成「磨蹭」。
    _taskFrameLoadingUntil: 0,
    _taskFrameLoadingScope: '',

    // 批次 38：**目录**说这一节还有 N 个待完成、而页面上认得出的任务框都已完成时的有界否决窗。
    // 现场（2026-11-13 真页面）：`_isCurrentCompleted` 靠「一个未完成 task 框都没找到」
    //   这份 **absence 证据**直接判成"这一节做完了"并翻页 —— 而目录那一行还挂着
    //   `catalog_points_*` / `jobUnfinishCount>0`，说明这一节还有任务框**没挂载**出来。
    // 与上面两族同一套纪律：`_catalogVetoUntil` 是窗口终点，`_catalogVetoScope` 记住
    // 这个窗口已经给过哪一张卡片（同一张只给一次，用完放行，不许把「跳过」换成「磨蹭」），
    // `_catalogVetoWarnAt` 只给「窗口已用掉」那条 warn 去重。
    // ⚠️ 三者都**不进 `_resetRuntimeState`** —— 和 `_quizParseRetry*` / `_taskFrameLoading*`
    //   一样靠 scope 比对自我失效：换卡片 = 换 scope = 自动重新起算，不需要清。
    _catalogVetoUntil: 0,
    _catalogVetoScope: '',
    _catalogVetoWarnAt: 0,

    _quizCorrectAnswerCache: null,

    _quizCurrentAnsweredKeys: null,

    _quizCurrentAnswerValues: null,

    _quizCurrentQuestions: null,

    _quizReadyToSubmit: false,

    _quizReadyWorkKey: '',

    // 「当前在答的是哪一份卷子」的身份键（jobid / workid 一类）。
    //
    // 为什么必须有它：`_quizAnswered` / `_quizCurrentQuestions` 这一组字段是
    // **页面级**的，只在 `_resetRuntimeState()` 里清 —— 而那个函数的调用点只有
    // `run()` / 换章节 / `nextUnit()` / 换学习卡片。**同一张学习卡片里挂着两份试卷时，
    // 交完第一份不会经过任何一个调用点**，于是 `_quizAnswered` 一直是 true，
    // `_handleQuiz` 第一行就直接 return，第二份**永远不答**（实测症状：
    // 两个单元测试任务点只做了第一个）。
    // 有了这个键，换一份卷子就 `_syncQuizPaperRunState()` 把那一组状态重置，
    // 同时不影响同一份卷子内部的重试/重做（键不变就不重置）。
    _quizRunPaperKey: '',

    _quizForceSkipUntil: 0,

    // 「这一份卷子」的暂停键 —— 与 `_quizForceSkipUntil` 成对写入（走 `_setQuizForceSkip`）。
    //
    // 为什么必须有它：`_quizForceSkipUntil` 单独一个时间戳是**页面级**的，
    // 而 `_isQuizLearningPending()` 第一行就 `if (this._isQuizForceSkipping(preferredDoc || null)) return false;`
    // —— 于是「A 卷子坏了」会被调度理解成「这一页所有答题任务点都不用做」，
    // 一张坏卷子能把整门课冻结到冷却结束。写入时带上卷子身份键，
    // 判定时只对同一份卷子生效（键为空 = 老的全局语义，见 `_isQuizForceSkipping`）。
    // ⚠️ 键是**按文档**算的（`_getQuizWorkKey(doc)` 会先解析提交文档），
    //   所以写入端与读取端必须用同一个文档表达式 —— 判定端要拿到当前文档，
    //   两侧错开时表现不是「没暂停」而是「这一节永久停摆」（日志却写着已暂停）。
    _quizForceSkipPaperKey: '',

    // 「乱选填完了，先别交，给用户留几秒改」的窗口（判据见 75-quiz-dom.js `_maybeSubmitQuiz`，
    // 秒数来自配置 `randomAnswerReviewSec`；用户 2026-11-12：交完就不能改了，这太诡异）。
    //   _quizReviewPaperKey   窗口是为**哪一份卷子**arm 的（键变了 = 换卷子，旧窗口作废）
    //   _quizReviewUntil      窗口到点时刻；到点那一次才真的点提交。
    //                         0 = 「这份卷子正停在等用户自己交」（设置填 0 时走这条）
    // 两个字段合起来就是「按卷子键只打一条日志」的去重位 —— 这条每秒被调到，
    // 只按时间节流仍会把日志刷满（用户 2026-11-12 抱怨过刷屏）。
    _quizReviewPaperKey: '',
    _quizReviewUntil: 0,

    // 上一次给「题干乱码」计轮的时刻。
    //
    // `_handleQuiz` 被 OCS 循环**每秒**调一次，所以乱码轮次绝不能按调用次数累加
    // —— 那样 3 秒就数满 3 轮。只有间隔够久（≥10 秒）才 +1，见 `_handleQuiz` 的乱码守卫。
    _quizGarbledRoundAt: 0,

    _quizApiSkipLogAt: 0,

    // 「这一节被答题链路挡住了」的三个时刻（判据见 `_isQuizBlockedByApi`，批次 13-B）。
    //   _quizBlockedByApiAt   最近一次「因链路不可用拒掉必做测验帧」——30 秒内不算新鲜
    //   _quizBlockedSinceAt   本轮阻塞的起点，用来算已按住多久（预算 3 分钟）
    //   两个日志节流位各自独立：按住与放弃是两条不同含义的日志，共用会互相顶掉。
    _quizBlockedByApiAt: 0,
    _quizBlockedSinceAt: 0,
    _quizBlockedHoldLogAt: 0,
    _quizBlockedGiveUpLogAt: 0,

    // 「这一轮没答题、原因是哪个」那条 warn 的节流时刻（判据见 `_handleQuiz` 开头的三道闸门）。
    // 与 `_quizHoldLogAt`（`_shouldHoldQuizBeforeNext` 用）**分开**：共用一个时间戳会让两条
    // 不同含义的日志互相顶掉，谁先打谁后打全看运气。
    _quizHoldReasonLogAt: 0,

    // 「这份卷子已经用本地答案答过多选了」的卷子键集合。
    //
    // 为什么需要它（现场实测 2026-10-10，多选本地作答刚上线就炸出来的）：
    //   多选的本地答案是**猜的** —— 一份卷子只要有一道多选，基本就过不了及格线；
    //   而平台"没过"之后的流程是 **重做 → 重答 → 重交**（上限 20 次）。
    //   于是线上表现从"填不满、卡着不动"变成了「只做多选题、其他的不做、**疯狂提交**」，
    //   而每一次提交都是**真的交上去**。
    //   判据放在这里而不是只用提交计数：提交计数在**同一轮内**还没 +1 时可以漏判。
    _quizLocalMultiplePapers: {},

    _quizScanDiagAt: 0,

    // 视频内嵌弹题（弹窗题）的失败计数。
    // 弹题答不上来时弹窗不会消失，而 tick 每 250ms 一轮 —— 没有下面这三个字段，
    // 同一道题会被反复发给模型：用户看到的就是"AI 一直在扫描、但从不填空、课程空转"。
    _popupQuizKey: '',

    _popupQuizAttempts: 0,

    _popupQuizBlockedUntil: 0,

    _popupQuizLogAt: 0,

    _popupQuizSolvedKey: '',

    _popupQuizSolvedAt: 0,

    // 本题已经填过、但没能让弹窗消失的答案（=错的）。重试时带给模型，
    // 由 libs/prompt.js 渲染成「禁:1=D;」前缀 —— 否则模型每轮都回同一个答案。
    _popupQuizWrongAnswers: [],

    _popupQuizLastFilled: '',

    // 填完答案后的一段静默期：期间**完全不去碰弹题**，见 _activePopupBlock 的说明。
    _popupQuizQuietUntil: 0,

    _popupBlockCheckedAt: 0,

    _popupBlockCached: null,

    // 前缀缓存：记住"本卷最近一次发过请求"，用于决定重试时是否整批重发
    _quizBatchSentKey: '',

    _quizBatchSentAt: 0,

    // 「继续学习」提示：弹题答完 / 视频暂停后，播放器右下角会出现这个按钮，
    // 不点它进不去正常播放页 —— 不处理就又变成"AI 一直在跑但课程不动"。
    _continueStudyAt: 0,

    _continueStudyScanAt: 0,

    _continueStudyKey: '',

    _continueStudyClicks: 0,

    _continueStudyBlockedUntil: 0,

    _taskAttempts: null,

    _taskProgress: null,

    _detectedMaxRate: 0,

    _rateDetectVideo: null,

    _rateDetectBusy: false,

    _rateProbing: false,

    _bgWorker: null,

    _bgWorkerUrl: null,

    _workerDelayCallbacks: null,

    _workerDelaySeq: 0,

    _audioKeepalive: null,

    _mediaRepaired: null,

    // 死流水线「原地重载」按源记账（批次 50，键同 `_getMediaSeekKey`）。
    // 与 `_mediaRepaired` 一样**不随换节清理**：那是"这个源试过没有"的事实，
    // 清了就会在同一节里反复重载。
    _mediaReloadKeys: null,

    _pauseResumePending: false,

    // 批次 20-H：后台暂停恢复这条日志原本一次 pause 就写一条，实测 200 格缓冲里占了 97 条，
    // 把讨论那半的证据全冲掉了。现在 60 秒最多一条，并带上被抑制掉的条数。
    _pauseResumeLogAt: 0,

    _pauseResumeSuppressed: 0,

    _visibilityBound: false,

    _captchaActive: false,

    _captchaBusy: false,

    _captchaAttempts: 0,

    _captchaFailCount: 0,

    _captchaLastCheckAt: 0,

    _captchaLastResult: null,

    // 批次 36-A：页面内验证码弹窗的「停手」辅助状态。
    // 轮次与冷却本身记在 sessionStorage（见 `_readCaptchaDialogBudget`）；
    // 下面两个只是"弹窗消失了多久"与"这条提醒发过没有"，被刷新抹掉无关紧要。
    _captchaDialogAbsentAt: 0,

    _captchaDialogPauseLogged: false,

    // 批次 36-C：会话账本底座的可写性探测结果（null = 还没探过）。
    // 一旦探出「这台浏览器存不住」，账本就退回内存（`_ledgerMemory`）并只提醒一次。
    _ledgerSessionOk: null,

    _ledgerMemory: null,

    _discussionWindow: null,

    _discussionOpenedAt: 0,

    _discussionScanAt: 0,

    _discussionBusy: false,

    _discussionPosted: false,

    _discussionExpanded: false,

    _discussionBefore: null,

    _discussionScrollAt: 0,

    _discussionCardOpened: false,

    _discussionPageUrl: '',

    _discussionPageAt: 0,

    _discussionPageResult: false,

    _studyDeclineAnnounced: false,

    _discussionEditorEl: null,

    // 批次 20-F：刷课页读过讨论页递回来的 window.name 没有（每份文档只读一次）
    _discussionNameRead: false,

    _discussionPendingCache: null,

    _discussionHoldSinceAt: 0,

    _discussionHoldKey: '',

    _discussionHoldSpent: 0,

    _discussionDupLogAt: 0,

    _discussionSettledLogAt: 0,

    _unfinishedPromptClickedAt: 0,

    // 批次 21：投票任务点的尝试台账（键 = jobid）。**只在内存里** ——
    // 刷新页面就该重新观察一次，写进 localStorage 反而会把"这一轮没投出去"
    // 拖成"这一章永远不投"。
    _voteTryMap: {},

    _quizApiFailUntil: 0,

    _quizApiLastError: '',

    _stepNavigationBound: false,

    _stepSwitchPending: false,

    _stepSwitchAt: 0,

    _skipChainCount: 0,

    _lastChapterKey: '',

    _delayedNextUnitTimer: null,

    _guardLastTime: 0,

    _guardLastWallTs: 0,

    _guardLastResumeTs: 0,

    _resumeWindowStart: 0,

    _resumeAttemptCount: 0,

    _activeMediaJobPending: false,

    _activeMediaJobManaged: false,

    _activeDocumentJobPending: false,

    _activeDocumentJobManaged: false,

    _activeDocumentJobDoc: null,

    _mediaWaitLogAt: 0,

    // 上一条「media pending, delay completion」发出时的**播放状态**签名（批次 37）。
    // 只放 paused/playing 这一维，调用方标识（reason）绝不许进来 —— 那会把 30 秒闸绕过去。
    // 它**不需要**跟着 `_mediaWaitLogAt = 0` 一起清：判据是 `!_mediaWaitLogAt || 超 30 秒 || (签名变了 && 超 5 秒)`，
    // `_mediaWaitLogAt` 归零那一支排在前面，任何换视频/换章节/收摊的复位点都已经先放行一条了。
    _mediaWaitLogSig: '',

    // 「手里这个视频**从来没有过源**」是从什么时候开始算的（批次 40，0 = 没有）。
    // 判据只认 readyState 0 且拿不到 duration 这一族；超过 `documentSkipTimeoutMs` 就放手，
    // 源一旦挂上（或换成别的视频）立刻清零 —— 所以它必须是**独立字段**，
    // 不能借 `_mediaWaitLogAt`（那个是日志节流时间戳，会被别的调用方冲开）。
    _mediaNoSourceSince: 0,

    // 「手里这个视频**流水线已死**（`video.error` 非空）」从什么时候开始算的（批次 50，0 = 没有）。
    // 与上面那条**互斥地覆盖另一族**：`_mediaNoSourceSince` 要 readyState 0 且拿不到 duration，
    // 而解码器半路死掉是 readyState 4 + 有时长 + `paused:false` —— 现场实测那一节被它占住将近一刻钟。
    // 同样必须是**独立字段**，不借 `_mediaWaitLogAt`（那是日志节流时间戳）。
    _mediaBrokenSince: 0,

    _documentWaitLogAt: 0,

    _lastLearningTabSwitchAt: 0,

    _lastLearningCardKey: '',

    _docTaskState: null,

    _treeContainerEl: null,

    _taskDiscoverStartedAt: 0,

    _taskWaitLogAt: 0,

    _pendingTaskKey: '',

    _pendingTaskStartedAt: 0,

    _pendingTaskLogAt: 0,

    _submitConfirmLastClickAt: 0,

    _activeJobId: '',


    _cellData: {
      cells: 0,
      nCells: 0,
      currentCellIndex: 0,
      currentNCellIndex: 0,
      currentVideoTitle: ''
    },


    _assertActive: function () {
      return isActiveInstance();
    },


    run: function () {
      if (!this._assertActive()) return;
      // Authorized external captcha pages run only the OCR loop, never study scheduling.
      if (this.configs.pageScope === 'captcha') {
        this._clearTickLoop();
        var captchaApp = this;
        var captchaTick = function () {
          if (!captchaApp._assertActive() || captchaApp.configs.pageScope !== 'captcha') return;
          captchaApp._runStandaloneCaptchaMode().catch(function (error) {
            emitRuntimeLog('error', 'captcha loop failed', { error: String(error && error.message || error).slice(0, 200) });
          });
        };
        this._tickLoopInterval = setInterval(captchaTick, 1500);
        captchaTick();
        return;
      }
      // 「已开启」持久化到 chrome.storage（经 content 桥接）。run() 是所有启动入口的汇合点
      //（页面中间面板【开始】/ 弹窗【开始】/ 刷新后自动续跑都会走到这里），在这里落一次标记，
      // 才能保证页面跳转、以及讨论任务 window.open 新开的标签页里，content.js 的
      // maybeMarkAutoResume 读到 xxtRunning → shouldAutoStart() 为真 → 自动续跑。
      // 否则从页面面板点【开始】时 xxtRunning 恒为 false，新开的讨论窗口 shouldAutoStart() 为假、
      // 命中「是讨论页且没开启 → 静默 return」→ 插件在新窗口里一动不动（用户报的「讨论新窗口失灵」）。
      // storage_set 桥接不回消息，直接投递、不 await，避免 bridgeSend 的 promise 空挂到超时。
      try { window.postMessage({ source: 'xxt_app', type: 'storage_set', payload: { xxtRunning: true } }, '*'); } catch (ePersist) {}
      this.configs = mergeConfig(this.configs);
      this._initCellData();
      this._resetRuntimeState();
      this._clearTickLoop();
      this._bindStepNavigation();
      // 只在启动时测一次帧率（700ms rAF），慢机据此放宽下面所有等待上限。
      // 测不出来时 perfFactor() 恒为 1，行为与改动前一致。
      startPerfProbe();
      console.log('%c[Omitone] start', 'color:#4CAF50;font-weight:bold');
      try { this._installSubmitSniffer(); } catch (eSniff) {}
      // ⚠️ 把**当前这份运行代码带哪些修复**写进日志。
      // 为什么必须有：这一整轮排查里最贵的开销就是"修复到底装上了没有"——
      // 实测两次被它坑：用户 reload 的时间点早于改动落盘、以及浏览器缓存了
      // 旧的 content.js/page.js，于是**日志里看不到效果**，两边都以为修好了。
      // 有了这行，一眼就能对照：日志里缺哪个标记 = 那份改动还没被加载。
      emitRuntimeLog('info', 'start', {
        build: ['truncate-split', 'sep-parse', 'quiz-pending', 'mismatch-discard', 'rich-fill',
          'chunk-5', 'quiz-no-progress-skip', 'multi-llm-first',
          // 2026-10-17 这一轮加的：缺哪个标记，就说明那份改动没被加载
          'text-skip-script', 'noop-guard', 'discussion-outcome', 'quiz-hold-guard',
          // 2026-11-10 批次 7 加的（缺哪个就说明那一半还没进浏览器）：
          // popup-scope=只在弹窗容器里点按钮 / radio-clickthrough=分离控件补点文本项 /
          // choice-visible=审计按"看得见的选中"计数 / idle-stuck-repeat=空转每 2 分钟重播
          // 2026-11-11 批次 20 加的：flag-3state=#isFinished 空值不再当"未完成" /
          // post-evidence=回帖确认要真证据 / page-dedup=同一话题本站只发一次 /
          // study-hold-discuss=还有讨论没做完时不许宣布整节完成
          // 20-F 加的：post-hydrate-wait=回帖先等页面水合、基线贴着点击取、
          // 点了没反应再点一次，结果用 window.name 递回刷课页
          // 20-G 加的：box-finished=#isFinished 是空的时改读任务盒的 ans-job-finished /
          // go-to-job=「还有任务点未完成」那道门点去学习、不再点下一节
          // 2026-11-11 批次 21 加的：vote-job=投票任务点（insertvote）认得出类型、
          // 走平台自己那一次点击真投出去（缺这个标记就说明新 page.js 没被加载）
          'popup-scope', 'radio-clickthrough', 'choice-visible', 'idle-stuck-repeat',
          'flag-3state', 'post-evidence', 'page-dedup', 'study-hold-discuss',
          'post-hydrate-wait', 'box-finished', 'go-to-job', 'vote-job'],
        // 代码内容指纹（由 `tools/concat-page.js` 按片段内容算出，拼在 page.js 第一行）。
        // 装 dist 的人看 `content bridge ready` 里的 build；**直接加载源码目录**的人看这个 ——
        // 它一变就说明代码换了，改完没重新加载一眼就能看出来。
        code: (typeof OMITONE_CODE_REV === 'string' ? OMITONE_CODE_REV : '')
      });
      this._startTickLoop();
    },


    play: function () {
      if (!this._assertActive()) return;
      this._runTick();
    },


    _resetRuntimeState: function () {
      this._runtimeVersion = (this._runtimeVersion || 0) + 1;
      this._videoEl = null;
      this._videoCount = 0;
      this._currentVideoIndex = 0;
      this._isPlaying = false;
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizSubmitLogAt = 0;
      this._quizLastSubmitAttemptAt = 0;
      this._quizHoldLogAt = 0;
      this._quizHoldReasonLogAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      // 换章节/换卡片时连"在答哪一份卷子"的身份一起清掉：
      // 回到同一份卷子时视为全新一轮（与 `_quizAnswered = false` 配套，语义一致）
      this._quizRunPaperKey = '';
      this._quizApiSkipLogAt = 0;
      // 换节 / 换卡片 = 新的一节：按住阻塞的预算重新起算（判据见 `_isQuizBlockedByApi`）。
      // ⚠️ 这四个必须在同一个地方清 —— 少清 `_quizBlockedSinceAt` 的话，
      // 上一节按住满 3 分钟的记录会让下一节**一被挡住就直接翻页**。
      this._quizBlockedByApiAt = 0;
      this._quizBlockedSinceAt = 0;
      this._quizBlockedHoldLogAt = 0;
      this._quizBlockedGiveUpLogAt = 0;
      // 「本地答过多选」的卷子集合跟着卷子身份一起清：
      // 换章节 / 换卡片之后回到同一份卷子，应当重新享有"第一次尝试"的待遇。
      this._quizLocalMultiplePapers = {};
      this._skipChainCount = 0;
      this._activeMediaJobPending = false;
      this._activeMediaJobManaged = false;
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._mediaWaitLogAt = 0;
      this._mediaNoSourceSince = 0;
      this._mediaBrokenSince = 0;
      this._documentWaitLogAt = 0;
      this._lastLearningTabSwitchAt = 0;
      this._lastLearningCardKey = '';
      this._stepSwitchPending = false;
      this._docTaskState = null;
      this._taskDiscoverStartedAt = Date.now();
      this._taskWaitLogAt = 0;
      this._pendingTaskKey = '';
      this._pendingTaskStartedAt = 0;
      this._pendingTaskLogAt = 0;
      this._submitConfirmLastClickAt = 0;
      this._activeJobId = '';
      if (this._ocsStudyRunning) emitRuntimeLog('info', 'reset study running flag');
      this._ocsStudyRunning = false;
      this._ocsSearchedJobs = [];
      this._ocsSearchDeadline = 0;
      this._ocsLastNoJobLogAt = 0;
      this._lastSearchEmptyLogAt = 0;
      // 「这一节判成已完成」是**凭哪个证据**判的（`_isCurrentCompleted` 写入，
      // `_skipIfCompleted` 打进 `skip completed` 日志）—— 空串 = 没判成完成。
      this._completionEvidence = '';
      this._jobTransitionUntil = 0;
      this._studyCompleteAt = 0;
      // 「点了下一节但页面没动」的防空转计数（判据见 _studyProgressKey）
      this._nextUnitNoopCount = 0;
      this._nextUnitNoopKey = '';
      this._nextUnitBlockedKey = '';
      this._chapterChangedAt = Date.now();
      this._attachmentFingerprint = '';
      this._ocsStudyStarted = false;
      this._restudySkipNoticeAt = 0;
      // 「为讨论任务点按住这一节」的预算按**新一轮**起算（批次 20-D）：
      // 上一节烧掉的 90 秒不该让下一节一发现讨论就直接翻页。
      this._discussionHoldSinceAt = 0;
      this._discussionHoldKey = '';
      this._discussionHoldSpent = 0;
      this._discussionPendingCache = null;
      this._clearCheckInterval();
    },


    /**
     * 对"确认是任务点但不支持的类型"做去重告警（每种模块只记一条）。
     *
     * 静默丢弃任务点是最难排查的一类问题：用户只看到"这个任务点没做"，
     * 完全无从判断是识别失败、还是压根不支持。留一条日志就能区分。
     */
    _unsupportedJobLogged: null,


    // ===== 视觉理解：把题目配图转成文字 =====
    //
    // 为什么只转文字、不直接把图交给答题模型：
    //   答题链的系统提示词 + 题目文本是一个**每次都一样的长前缀**，DeepSeek 会把它
    //   当作缓存单元按约 1/10 价计费（见 content.js logCacheUsage 的说明）。
    //   一旦把每次都不同的图片塞进这个前缀，缓存立刻全部失效 ——
    //   省下的那点「模型看图」的钱，会乘以十倍从输入侧漏出去。
    //   所以图片走独立请求，只把结果文字拼进题干。

    // 「这一章的看图预算已用完」只提醒一次用的键（每道题都刷一条会把日志淹掉）。
    // ⚠️ 计数本身**不在这里** —— 批次 36-B 起记在 sessionStorage（见 `_readVisionLedger`）：
    // 记在内存里的话，刷课链路里那几步"自己刷新自己"（跳章 / 验证码墙 / 跨域中间页）
    // 一刷就归零，「每章最多 N 次」实际变成「每刷一次再来 N 次」。
    _visionBudgetWarnedKey: '',


    // ===================== 讨论任务点 =====================
    // 讨论任务点不在课程 iframe 内：点击后会跳转到独立的讨论页（新标签页或当前标签页），
    // 必须在该页面发布评论才算完成。原识别逻辑只认 video/quiz/read/document 等类型，
    // 这类任务点会被判成 other 直接跳过，因此这里单独实现：
    //   刷课页：检测讨论任务点 → 打开讨论页 → 暂停推进等待
    //   讨论页：自动填内容 → 点发布 → 检测成功 → 关闭/返回
    //   回到刷课页：刷新章节继续运行（全程有超时兜底，绝不会卡住）

    _discussionStoreKey: 'omitone_discussion_done',


    // ===================== 做不完的任务点 =====================
    // 学习通允许老师把任务点配置成"锁住"的形态：视频开防拖拽（拖了会被弹回）、
    // 文档/PPT 不给翻页、或者任务点本身就是不计分的摆设。
    // 插件对这些只会一次次重试，白耗时间 —— 尤其是反复回到同一章时。
    //
    // 这里的策略是**只放弃"确实完成不了"的**：每派发一次任务点就检查它是否真的完成了，
    // 没完成才计数；连续 N 次都没完成就记入 localStorage（24 小时）并跳过，同时留日志。
    // 判定"是否完成"拿不准时一律当作完成（`_isJobCompleted` 返回 true），
    // 宁可多跑一次也不要误跳过必做任务点。

    _taskGiveUpStoreKey: 'omitone_task_giveup',


    /**
     * 按选择器优先级收集题目容器。
     *
     * 注意这里**不能**在第一个"有命中"的选择器上无条件 break：
     * 用 `.TiMu` 之类的选择器命中一批节点后，还要过一遍可见性/文本过滤，
     * 过滤后可能一个都不剩（占位容器、被隐藏的模板节点）。
     * 1.0.11 之前是命中就 break，于是"某个宽泛选择器抢先命中但全是空壳"会让整次扫描
     * 直接返回 0 题 —— 表现就是用户看到的"AI 扫描不到题目"。
     * 现在改成：挨个选择器试，谁第一个给出**过滤后非空**的结果就用谁。
     */
    /**
     * 题目容器选择器，按优先级尝试。
     *
     * 命名来源：对照开源实现 cxmooc-tools 的 src/mooc/chaoxing/question.ts 校正过。
     * 学习通有**两套**题目标记，之前的清单只覆盖了课程页那一套：
     *   课程页：  容器 .TiMu         标题 .Zy_TItle > .clearfix   选项 .Zy_ulTop/.Zy_ulBottom > li
     *   作业/考试：容器 .Cy_TItle     标题 .Cy_TItle.clearfix      选项 .Cy_ulTop/.Cy_ulBottom li
     * 缺了 .Cy_TItle 这一族，作业与考试页会整体扫不到题 —— 而这正是"AI 扫描不到题目"的常见场景。
     */
    _questionSelectors: [
      '.TiMu', '.Cy_TItle', '.questionLi', '.singleQuesId', '.questionItem', '.tiBank', '.topicItem',
      '.exam_question', '.question-content', '.singleQues', '.mark_item', '.questionBox',
      'li.quesLi', '.answerOption', 'div[class*="question"]', 'div[class*="topic"]',
      'div[class*="TiMu"]', 'div[class*="Cy_TItle"]'
    ],

    /**
     * 「这份文档有没有题目容器」的并集选择器 —— `_detectQuiz` 的 DOM 兜底、
     * 视觉闸门（_isTextOnly）、独立验证码页判定共用。
     *
     * ⚠️ 这份清单曾经手抄在 `_detectQuiz` 里，抄的时候漏了 `.Cy_TItle` ——
     * 作业/考试页的 DOM 兜底整体失效（与下面 `_quizContainerSelector` 注释里那次
     * 是同一类事故，且不报错、不留日志）。现在**只准改这里**；
     * `tools/check.js` 的「选择器真源守卫」会把真源之外的手抄直接报红。
     */
    _quizDetectorSelector: '.TiMu, .Cy_TItle, .questionLi, .singleQuesId, .questionItem, .tiBank, .topicItem, .exam_question, .question-content, .singleQues, .mark_item, .questionBox, .answerOption',

    /**
     * 题干候选选择器，按优先级逐个试；候选清洗后长度 ≥ 4 才算数（`_parseQuestionElement`）。
     * ⚠️ 属性选择器区分大小写，[class*="title"] 匹配不到 "Zy_TItle" / "Cy_TItle" —— 必须显式列出。
     */
    _questionTitleSelectors: [
      '.fontLabel', '.mark_name',
      // 学习通真实结构：题号在 .fontLabel，题干与题号同处 .Pt1 / .Zy_TItle。
      // .question-stem / [data-question-text] 是 mooc2 新版前端的题干标记
      // （2026-10-31 从同类开源实现的真实页面知识补入）。
      '.Pt1', '.Zy_TItle', '.question-stem', '[data-question-text]',
      '.question-title', '.topicTitle', '.question_content', '.qContent', '.mark_title',
      '.question-name', '.title', 'h3', 'h4', '.stem', '[class*="question"]', '[class*="title"]'
    ],

    /**
     * 选项 <li> 的候选容器，按优先级逐个试（`_getOptionItems`）。
     * 课程页 Zy_ 族在前、作业/考试页 Cy_ 族紧随 —— 顺序有含义：
     * ⚠️ `<li>` 必须排在 `<label>` 之前（qid 挂在 li 上；返回 label 会让
     * 隐藏答案域永远写不上 → 答案填了也永不提交，见 _getOptionItems 处的说明）。
     */
    _optionListSelectors: [
      '.Zy_ulTop > li', '.Zy_ulBottom > li', '.Zy_ulTk > li',
      '.Cy_ulTop li', '.Cy_ulBottom li', '.Cy_ulTk li',
      '[class*="before-after"]', '.answerBg',
      'li.clearfix'
    ],

    /**
     * "这一页有没有题目容器"用的**并集选择器**（一串，不是数组）。
     *
     * ⚠️ 它和上面的 `_questionSelectors` **不是一回事，别合并**：
     *   - `_questionSelectors` 是**有序的备选列表**，`_collectQuestionContainers` 逐个试、
     *     命中一个就用它（还带嵌套去重），目的是"尽量抠到题"；
     *   - 这一串是**一次性并集**，只回答"页面上有没有题目容器 / 有几个"，
     *     用于判分结果页的可交互性判断与诊断计数。
     *
     * ⚠️ **这个字符串曾经被手抄在三处**（`30-log.js` 的诊断、`70-quiz-flow.js` 的结果页判断、
     * `72-quiz-answers.js` 的正确答案收集），其中一处抄成了 `.Cy_TITle`（大小写错），
     * 于是那个诊断在作业/考试页上把容器数报成 0 —— 而且**不报错、不留日志**。
     * 现在三处统一读这里：**改选择器只改这一行** —— 手抄的那份必然漂移，别再抄第四份。
     */
    _quizContainerSelector: '.TiMu, .Cy_TItle, .questionLi, .singleQuesId, .questionItem, .mark_item, .questionBox',

    /**
     * 「题目容器里有没有能作答的控件」—— 判「这是不是答题页」的**必要条件**真源。
     *
     * 为什么必须有这一条：`_quizDetectorSelector` 那串类名里有 `.question-content`
     * `.answerOption` `.tiBank` `.topicItem` 这类**通用名字**，课件（轮盘 PPT）帧和
     * 文档帧里同样会出现。拿「选择器命中」当「这是测验任务」，一个带 `.question-content`
     * 的 PPT 帧就被判成 quiz，于是 `_runChaoxingReadJob` 永远轮不到 ——
     * 用户报的「刷 PPT 报废」正是这条（2026-11-10）。
     *
     * 真实题面必带下面之一：选项 `li[qid]`（填答案全靠它）、隐藏答案域 `#answer…`、
     * 填空/简答的 `textarea[id^="answer"]`、新版前端的 `[role="radio"/"checkbox"]`。
     * 课件里的装饰性 `.question-content` 一个都没有。
     *
     * ⚠️ 只准用在「判类型」这一处；不收窄 `_quizDetectorSelector` 本身
     *    （72-quiz-answers / 74-quiz-vision / 30-log 还靠它做 closest 与包装查找）。
     */
    _quizAnswerControlSelector: '[qid], input[id^="answer"], textarea[id^="answer"], [role="radio"], [role="checkbox"]',

    _getMainFrame: function () {
      return document.querySelector('#iframe');
    },


    _getMainDocument: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
      } catch (e) {
        return null;
      }
    },


    _getCurrentTitle: function () {
      var el = document.querySelector('.prev_title');
      return el ? textOf(el).slice(0, 60) : '';
    },


    _getCurrentChapterId: function () {
      if (this._lastChapterKey) return String(this._lastChapterKey);
      var frame = this._getMainFrame();
      var raw = frame ? (frame.src || '') : location.href;
      var match = raw.match(/(?:knowledgeid|chapterId)=([^&]+)/i);
      return match ? String(match[1]) : '';
    },


    _dismissPopups: function () {
      // 「还有任务点未完成」这道门单独管：它不是要关掉的弹窗，是平台在说"这一节还有事没做"。
      try {
        if (this._handleUnfinishedTaskPrompt()) return true;
      } catch (eP) {}
      var texts = ['继续', '下一节', '跳过', '取消', '关闭', '知道了', '确定'];
      // ⚠️ **只在弹窗容器之内**按文案点按钮（2026-11-10 真实日志逼出来的）。
      // 整页扫会抓到章节页**常驻**的「下一节」导航（class 带 `prev_next`）：
      // 19:12:18 `skip completed` → `dismiss popups: click {cls:"… prev_next next fr"}`
      // → 页面被带去 `https://i.chaoxing.com/base?…`，那里没有课程结构可认，
      // 之后只剩 `search job: no attachments and no synthetic job` 每分钟一条，
      // 19:13:23 `study stuck` 之后彻底静默 —— 用户看到的"直接下一页、然后卡住"就是这条链。
      // 翻页有它自己的路：`_switchToNextLearningCard()` 与 `nextUnit()` 的 `#prevNextFocusNext`。
      var dialogBox = '.layui-layer, .el-message-box, .ant-modal, .dialog, .modal, ' +
        '[role="dialog"], [role="alertdialog"], #workpop, #confirmSubWin, .AlertCon02';
      try {
        var buttons = document.querySelectorAll('button, a, .btn, [class*="btn"], .layui-layer-btn a, .layui-layer-btn0, .layui-layer-btn1');
        for (var i = 0; i < buttons.length; i++) {
          if (!visible(buttons[i])) continue;
          var container = null;
          try {
            container = buttons[i].closest ? buttons[i].closest(dialogBox) : null;
          } catch (e0) {}
          // 容器外 = 页面自己的常驻控件，不归这个函数管。
          // 双保险：就算它被裹进了某个"dialog"壳，带 `prev_next` 的导航也不许点。
          if (!container || /prev_next/.test(String(buttons[i].className || ''))) continue;
          var t = textOf(buttons[i]);
          if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(textOf(container))) {
            return false;
          }
          // 「还有任务点未完成」这道门里一个都不许点：那个「下一节」会把人带回同一道门。
          if (this._isUnfinishedTaskPrompt(container)) continue;
          for (var j = 0; j < texts.length; j++) {
            if (t.indexOf(texts[j]) !== -1) {
              // 记下到底点了什么。这个函数**只按文案匹配、点完就返回**，
              // 现场报过「答对后选项一直闪」，但看不出是谁在点 —— 补上日志才能定位。
              emitRuntimeLog('info', 'dismiss popups: click', {
                text: String(t).slice(0, 30),
                cls: String(buttons[i].className || '').slice(0, 60),
                matched: texts[j]
              });
              buttons[i].click();
              return true;
            }
          }
        }
        var closeBtn = document.querySelector('.layui-layer-close, .pop-close, .dialog-close, .modal-close, [class*="close"]');
        if (closeBtn && visible(closeBtn)) {
          var closeContainer = null;
          try { closeContainer = closeBtn.closest ? closeBtn.closest(dialogBox) : null; } catch (e1) {}
          // 关不掉就别乱关：`[class*="close"]` 在课程页上能抓到整页右上角的关闭、
          // 退出按钮，那和"关掉一个弹窗"完全是两件事。
          if (!closeContainer) return false;
          if (/确认提交|确定提交|确认交卷|是否提交|是否交卷|交卷确认/.test(textOf(closeContainer))) {
            return false;
          }
          closeBtn.click();
          return true;
        }
      } catch (e) {}
      return false;
    },


    /**
     * 这道弹窗是不是平台在说「这一节还有任务点没做完」。
     *
     * 实测（2026-11-11 章节 9000049219）它有两种容器，文案都是
     * 「当前章节还有任务点未完成，是否去完成？」：
     *   `#jobFinishTip.AlertCon02` 里的 `a.graybtn02.marleft10.nextbutton`
     *   `.maskDiv.jobFinishTip` 里的 `a.btnBlue.popMoveDele`
     * 两种的 onclick 都带 `scroll2Job()` —— 那才是"去完成"的键。
     */
    _isUnfinishedTaskPrompt: function (node) {
      if (!node) return false;
      try {
        if (/jobFinishTip/i.test(String(node.className || '')) || node.id === 'jobFinishTip') return true;
      } catch (e0) {}
      try {
        return /还有任务点未完成|是否去完成/.test(textOf(node));
      } catch (e1) { return false; }
    },


    /**
     * 认下这道门，点它自己的「去学习」键（批次 20-G）。
     *
     * 为什么必须专门管它：`_dismissPopups` 的文案表里有「下一节」，而这个弹窗里
     * **恰好也有一个带 next 的按钮**（`PCount.next` 那条路）。旧行为是抓到它、点它 →
     * 平台同一道门再弹一次 → 再点 —— 页面在"点下一节 / 被拒绝"里原地转圈。
     * 用户肉眼看到的"卡在这一节"就是这里（实测日志 `dismiss popups: click {text:"下一节"}`
     * 反复出现，而 `#jobFinishTip` 一直在）。
     *
     * 返回 true 表示"这道门已经归我管"，`_dismissPopups` 就别再碰里面的任何按钮。
     * 找不到键时**也返回 true**：宁可不点，也不要退回点「下一节」。
     */
    _handleUnfinishedTaskPrompt: function () {
      var box = null;
      try {
        var boxes = document.querySelectorAll('#jobFinishTip, .jobFinishTip, .AlertCon02, .maskDiv, .layui-layer');
        for (var i = 0; i < boxes.length; i++) {
          if (!visible(boxes[i])) continue;
          if (!this._isUnfinishedTaskPrompt(boxes[i])) continue;
          box = boxes[i];
          break;
        }
      } catch (e0) { return false; }
      if (!box) return false;

      var pick = null;
      var label = '';
      try {
        var nodes = box.querySelectorAll('a, button, .btn, [class*="btn"]');
        for (var j = 0; j < nodes.length; j++) {
          if (!visible(nodes[j])) continue;
          var onclick = '';
          try { onclick = String(nodes[j].getAttribute('onclick') || ''); } catch (e1) {}
          // scroll2Job 是平台自己的"跳回未完成任务点"，优先级高于文案
          if (/scroll2Job/.test(onclick)) { pick = nodes[j]; label = textOf(nodes[j]); break; }
          if (!pick && /去学习|去完成/.test(textOf(nodes[j]))) { pick = nodes[j]; label = textOf(nodes[j]); }
        }
      } catch (e2) {}

      // 20 秒冷却：这道门每 3 秒就会被扫一次，别把页面来回滚。
      // 计的是"点过键"的次数；认出门但没点，就不烧冷却。
      var now = Date.now();
      if (pick && now - (this._unfinishedPromptClickedAt || 0) < 20000) return true;
      emitRuntimeLog('info', pick ? 'unfinished task prompt: go to job' : 'unfinished task prompt: no button', {
        box: String(box.id || box.className || '').slice(0, 60),
        button: pick ? String(label || '').slice(0, 20) : '',
        cls: pick ? String(pick.className || '').slice(0, 50) : ''
      });
      if (!pick) return true;
      this._unfinishedPromptClickedAt = now;
      try { pick.click(); } catch (e3) {}
      return true;
    },


    _walkFrames: function (doc, visitor, depth) {
      if (!doc || depth > 4) return;
      var frames = [];
      try {
        frames = doc.querySelectorAll("iframe");
      } catch (e) {}

      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        visitor(frame);
        try {
          var subDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          this._walkFrames(subDoc, visitor, depth + 1);
        } catch (e2) {}
      }
    },


    _safeJsonParse: function (value, fallback) {
      try {
        return JSON.parse(value);
      } catch (e) {
        return fallback;
      }
    },


    // 跨域窗口读 .document 会抛 SecurityError:
    // "Blocked a frame with origin X from accessing a cross-origin frame"
    // 该异常一旦冒泡到 _runTick，会打断整轮调度（验证码检测、播放巡检全部停摆）。
    // 所有 iframe/window -> document 的访问必须统一走下面三个助手。
    _safeDocOf: function (source) {
      try {
        if (!source) return null;
        if (source.contentDocument) return source.contentDocument;
        var win = source.contentWindow || source;
        if (win && win.document) return win.document;
      } catch (e) {}
      return null;
    },


    _safeWinDoc: function (win) {
      try { return (win && win.document) || null; } catch (e) { return null; }
    },


    // 帧是否同源可访问（跨域返回 false，绝不抛异常）
    _isFrameSameOrigin: function (frame) {
      try {
        var win = frame && frame.contentWindow;
        return !!(win && win.document);
      } catch (e) {
        return false;
      }
    },


    _getMainWindow: function () {
      var frame = this._getMainFrame();
      if (!frame) return null;
      try {
        return frame.contentWindow || null;
      } catch (e) {
        return null;
      }
    },


    // 给可能永久 pending 的 Promise（如 video.play() 在视频源停摆时）加超时护栏，
    // 防止 _runTick 的 await 挂死导致整个循环停止
    _withTimeout: function (promise, ms) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(undefined); // 超时按成功放行，实际播放状态由后续巡检兜底
        }, ms || 10000);
        Promise.resolve(promise).then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });
    },


    // ---- 后台/最小化防节流 ----
    // 浏览器对后台标签页的 setTimeout/setInterval 有强节流（最低 1 次/分钟），
    // 且静音（不可听）媒体在后台会被暂停/降速播放。以下三层防御保证最小化后视频继续推进：
    // 1. Worker 心跳：Web Worker 内的定时器不受标签页可见性节流，用它持续驱动视频守护
    // 2. pause 事件立即恢复：事件派发不受定时器节流，视频被网站/浏览器暂停后第一时间恢复
    // 3. 无声音频保活：让浏览器把标签页视为"正在播放音频"，豁免强节流与后台静音媒体限制
    _ensureBackgroundWorker: function () {
      if (this._bgWorker) return this._bgWorker;
      try {
        var code = [
          'var interval=null;',
          'onmessage=function(e){var d=e.data||{};',
          "if(d.op==='interval'){",
          '  if(interval)clearInterval(interval);',
          '  interval=setInterval(function(){postMessage({op:"tick"})},d.ms||1500);',
          '}else if(d.op==="delay"){',
          '  setTimeout(function(){postMessage({op:"fire",id:d.id})},d.ms||0);',
          '}else if(d.op==="stop"){',
          '  if(interval)clearInterval(interval);interval=null;',
          '}};'
        ].join('');
        var blob = new Blob([code], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);
        var worker = new Worker(url);
        var self = this;
        this._workerDelayCallbacks = {};
        worker.onmessage = function (e) {
          var d = e.data || {};
          if (d.op === 'tick') {
            if (document.hidden) {
              self._checkVideoStatus();
              if (typeof self._backgroundCaptchaTick === 'function') self._backgroundCaptchaTick();
            }
            return;
          }
          if (d.op === 'fire' && self._workerDelayCallbacks) {
            var fn = self._workerDelayCallbacks[d.id];
            delete self._workerDelayCallbacks[d.id];
            if (typeof fn === 'function') fn();
          }
        };
        worker.postMessage({ op: 'interval', ms: this.configs.videoCheckInterval || 1500 });
        this._bgWorker = worker;
        this._bgWorkerUrl = url;
        emitRuntimeLog('info', 'background worker heartbeat started');
      } catch (e) {
        this._bgWorker = null;
        emitRuntimeLog('warn', 'background worker unavailable, fallback to page timers', {
          error: String(e && e.message ? e.message : e).slice(0, 120)
        });
      }
      return this._bgWorker;
    },


    _workerDelay: function (fn, ms) {
      if (this._bgWorker && this._workerDelayCallbacks) {
        this._workerDelaySeq = (this._workerDelaySeq || 0) + 1;
        var id = 'wd' + this._workerDelaySeq;
        this._workerDelayCallbacks[id] = fn;
        try {
          this._bgWorker.postMessage({ op: 'delay', id: id, ms: ms || 0 });
          return;
        } catch (e) {}
      }
      setTimeout(fn, ms || 0);
    },


    _bindVisibilityHandlers: function () {
      if (this._visibilityBound) return;
      this._visibilityBound = true;
      var self = this;
      document.addEventListener('visibilitychange', function () {
        self._syncAudioKeepalive();
        if (!document.hidden) {
          // 回到前台：立即校验一次视频状态与倍速
          self._checkVideoStatus();
          var video = self._getVideoEl();
          if (video) self._ensurePlaybackRate(video, 'visibility-resume');
        }
      });
    },


    _resolveImageUrl: function (img) {
      try {
        var doc = img.ownerDocument || document;
        var base = doc.baseURI || window.location.href;
        return new URL(img.src || img.currentSrc || '', base).href;
      } catch (e) {
        return '';
      }
    },


    // 主 iframe 被换成跨域页面：JS 完全无法访问其内部，既检测不到验证码也填不了。
    //
    // ⚠️ 批次 35：跨域有**两种**，处置正好相反，旧代码把它们并成一种、还把刷新次数记在内存里 ——
    //   ① 帧地址仍是**同一个站**的另一台机器（平台自己的验证 / 反爬中间页）：刷新**有机会**解决；
    //   ② 帧地址压根是**别家**（浏览器拦截页 / 代理 / 门户改写）：刷新**必然**解决不了。
    // 而旧写法每轮末尾 `location.reload()`，一刷新内存计数全清零（`_blockedReloadAt` 变回 0，
    // 于是 `now - 0 > 180000` **恒真**）—— 只要那一帧一直读不到，就是**每 20 秒刷一次、永远刷不完**。
    // 同学那边「看不到下面那个录音，然后卡死了」正是这一族：整页反复刷新，
    // 页面下方那些任务点永远来不及渲染出来，看上去就是"插件在那儿发呆、页面自己一直在跳"。
    // 所以预算改记 sessionStorage（活得比刷新久、比标签页短），一轮 3 次，用完停 30 分钟。
    _frameOriginOf: function (frame) {
      var raw = '';
      try { raw = String((frame && (frame.getAttribute('src') || frame.src)) || ''); } catch (eRaw) { return ''; }
      if (!raw) return '';
      // about:blank / about:srcdoc 没有站点概念，原样带进日志（短串，不含地址信息）
      if (/^about:/i.test(raw)) return raw.slice(0, 24);
      try { return new URL(raw, location.href).origin; } catch (eUrl) { return ''; }
    },


    /**
     * 这一帧和顶层页是不是**同一个站** —— 按域名的最后两段比。
     *
     * 为什么不在这里抄一份"哪些域名算学习通"：那份真源在 `libs/runtime-policy.js`（内容脚本侧），
     * page.js 再抄一遍，将来两处一定会读出相反的含义（本项目踩过同族：同一个 class 两处反着读）。
     * 而这里要的判据本来与厂商无关：能跑到这一步的顶层页必然是课程站自己，
     * 所以"帧被换成同站另一台机器"与"帧被换成别家的页面"用"与顶层同不同站"就分得开。
     */
    _isFrameSameSiteAsTop: function (origin) {
      var host = '';
      try { host = String(new URL(origin || 'about:blank', location.href).hostname || ''); } catch (eHost) { return false; }
      var topHost = '';
      try { topHost = String(location.hostname || ''); } catch (eTop) { return false; }
      var tail = function (h) {
        var parts = String(h || '').toLowerCase().split('.');
        return parts.length < 2 ? '' : parts.slice(-2).join('.');
      };
      var a = tail(host), b = tail(topHost);
      return !!a && a === b;
    },


    /**
     * 会话账本 —— 「刷新把账一起抹掉」这一族的共用底座（批次 36）。
     *
     * 四本账都必须**跨过一次 `location.reload()` 还记得已经花掉几次**：
     * 跨域刷新（`_readBlockedReloadBudget`）、整页验证码墙（14-A）、
     * 页面内验证码弹窗（批次 36-A）、每章看图花钱（批次 36-B）。
     * 记在内存里等于没有账 —— 刷新一清，安全阀就变成「每轮 3 次、无限轮」。
     *
     * ⚠️ sessionStorage 自己也可能直接抛（无痕模式、本站 Cookie 被禁、
     * iframe 的第三方存储限制）。旧写法是 `try { 读 } catch { 当没账 }` ——
     * 于是「这台浏览器根本存不住」与「这一次还没花过」在代码里同形，
     * 安全阀恰好在最需要它的浏览器上失效。
     * 现在改成：先探一次可写性；存不住就退回**本页内存**（跨不了刷新，
     * 但仍然挡住同一份文档里的死循环），并**只提醒一次**，
     * 让用户知道这台浏览器上的自动重试上限只能管到本次刷新为止。
     */
    _sessionLedgerUsable: function () {
      if (this._ledgerSessionOk !== null) return this._ledgerSessionOk;
      var ok = false;
      try {
        sessionStorage.setItem('omitone:__ledger_probe', '1');
        sessionStorage.removeItem('omitone:__ledger_probe');
        ok = true;
      } catch (e) {
        ok = false;
      }
      this._ledgerSessionOk = ok;
      if (!ok) {
        if (!this._ledgerMemory) this._ledgerMemory = {};
        emitRuntimeLog('warn', 'session storage unavailable, retry budgets reset on every reload', {
          hint: '这台浏览器存不住会话数据（无痕模式 / 禁用了本站 Cookie / 嵌套页面的第三方存储限制）。' +
            '插件照样会限制自动重试，但**刷新一次账就清零** —— 若页面因此反复刷新，请手动关掉对应开关'
        });
      }
      return ok;
    },


    _readSessionLedger: function (key) {
      var name = String(key || '');
      if (!name) return null;
      if (!this._sessionLedgerUsable()) return (this._ledgerMemory && this._ledgerMemory[name]) || null;
      try {
        var raw = sessionStorage.getItem(name);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        return (obj && typeof obj === 'object') ? obj : null;
      } catch (e) {
        return null;
      }
    },


    _writeSessionLedger: function (key, value) {
      var name = String(key || '');
      if (!name) return;
      var obj = (value && typeof value === 'object') ? value : {};
      if (!this._sessionLedgerUsable()) {
        if (!this._ledgerMemory) this._ledgerMemory = {};
        this._ledgerMemory[name] = obj;
        return;
      }
      try { sessionStorage.setItem(name, JSON.stringify(obj)); } catch (e) {}
    },


    // 刷新预算：记在 sessionStorage，理由见 `_checkBlockedByCrossOrigin` 上面那段。
    // `href` 变了 = 换了一面墙（翻章 / 换课），旧账作废（与 14-A 验证码墙同一个口径）。
    _readBlockedReloadBudget: function () {
      var obj = this._readSessionLedger('omitone:blocked-reload-budget') || {};
      if (obj.href && obj.href !== String(location.href || '')) return { reloads: 0, resumeAt: 0 };
      return { reloads: Number(obj.reloads) || 0, resumeAt: Number(obj.resumeAt) || 0 };
    },


    _writeBlockedReloadBudget: function (reloads, resumeAt, href) {
      this._writeSessionLedger('omitone:blocked-reload-budget',
        { reloads: reloads || 0, resumeAt: resumeAt || 0, href: href || '' });
    },


    _markMainFrameCrossOrigin: function () {
      if (!this._mainFrameCrossOriginSince) this._mainFrameCrossOriginSince = Date.now();
    },


    // 刷新单独抽出来，是为了让测试能盯住这个动作本身（与 `_reloadForStandaloneCaptcha` 同一条理由）：
    // 真刷一次整页会打断后面几步，而这一步正是这一面墙上最贵的动作。
    _reloadBlockedPage: function () {
      try { window.location.reload(); } catch (e) {}
    },


    _checkBlockedByCrossOrigin: function () {
      var frame = this._getMainFrame();
      if (!frame) return false;
      if (this._isFrameSameOrigin(frame)) {
        this._mainFrameCrossOriginSince = 0;
        // 读得通了 = 这面墙过了。那笔刷新账必须作废 —— 留着它，下一次真被挡住时
        // 起手就是"预算已用完、停 30 分钟"，等于把上一次墙的账算到这面墙上（14-A 同条规矩）。
        this._writeBlockedReloadBudget(0, 0, '');
        return false;
      }

      this._markMainFrameCrossOrigin();
      var now = Date.now();
      var held = now - (this._mainFrameCrossOriginSince || now);

      // 页面还在加载时 iframe 归属可能未定，先不判定为被拦截，避免误刷新
      if (document.readyState !== 'complete') {
        this._mainFrameCrossOriginSince = 0;
        return false;
      }

      var srcOrigin = this._frameOriginOf(frame);
      var sameSite = this._isFrameSameSiteAsTop(srcOrigin);
      var budget = this._readBlockedReloadBudget();
      var maxReloads = 3;

      if (now - (this._crossOriginLogAt || 0) > 15000) {
        this._crossOriginLogAt = now;
        // ⚠️ `srcOrigin` 读的是 iframe 的 **src 属性**，而属性只记"当初想让它去哪"，
        //    帧自己导航走之后属性不会跟着变。所以这条日志只能说"读不到"，
        //    不能说"这一帧现在是跨域的"（现场实测到地址与顶层一模一样却读不到的一格）。
        var sameOrigin = !!srcOrigin && srcOrigin === String(location.origin || '');
        emitRuntimeLog('warn', 'main frame unreadable', {
          heldSec: Math.round(held / 1000),
          // 只报 origin，不报完整地址：学习通的地址里全是 clazzid / cnum / chapterId，
          // 而这份日志是会被「复制日志」发出去的。
          srcOrigin: srcOrigin || '(no-src)',
          topOrigin: String(location.origin || ''),
          sameSite: sameSite,
          sameOrigin: sameOrigin,
          reloads: budget.reloads,
          resumeInMs: Math.max(0, (budget.resumeAt || 0) - now),
          // 三种读不到的下一步完全不同，别再只甩一句"可能被验证码挡了"
          hint: !sameSite
            ? '内容帧被换成了另一家的地址（见 srcOrigin）—— 刷新解决不了；先查浏览器的跟踪防范 / 广告拦截扩展与网络代理，或退出重新登录'
            : sameOrigin
              ? '内容帧的地址和这一页一模一样却读不到 —— 帧正在切换、或被平台的验证 / 反爬中间页占住（src 属性可能是旧的），刷新有机会解决'
              : '内容帧还是课程站的地址，但换到了另一台机器（见 srcOrigin），JS 读不到 —— 多半是平台的验证 / 反爬中间页，刷新有机会解决'
        });
      }

      // 别家页面占着内容帧：刷新是白刷（刷完还是它），停在原地等人来处理
      if (!sameSite) return true;

      if (held > 20000 && this.configs.blockedReload !== false && now >= (budget.resumeAt || 0)) {
        if (budget.reloads >= maxReloads) {
          // 一整轮 3 次都没救回来 —— 收手 30 分钟，期间一次都不刷（上面那条日志会持续说还剩多久）
          this._writeBlockedReloadBudget(0, now + 30 * 60000, location.href);
          emitRuntimeLog('warn', 'blocked page reload round spent, pausing reloads', {
            reloads: maxReloads, resumeInMs: 30 * 60000, heldSec: Math.round(held / 1000)
          });
        } else {
          this._writeBlockedReloadBudget(budget.reloads + 1, budget.resumeAt || 0, location.href);
          emitRuntimeLog('warn', 'blocked page unreachable from JS, reload to recover', {
            reload: budget.reloads + 1, of: maxReloads, heldSec: Math.round(held / 1000)
          });
          this._reloadBlockedPage();
        }
      }

      return true; // 主内容都拿不到，本轮没必要继续跑后面的逻辑
    },


    // 遍历文档树（含 iframe 递归，跨域自动跳过），对每个可访问文档执行 cb
    _walkDocs: function (root, cb) {
      var self = this;
      var seen = [];
      (function walk(doc, depth) {
        if (!doc || depth > 4) return;
        if (seen.indexOf(doc) >= 0) return;
        seen.push(doc);
        try { cb(doc); } catch (e0) {}
        var frames = [];
        try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e1) { return; }
        for (var i = 0; i < frames.length && i < 12; i++) walk(self._safeDocOf(frames[i]), depth + 1);
      })(root, 0);
    },


    _studyDocs: function () {
      var docs = [];
      var mainDoc = null;
      try { mainDoc = this._getMainDocument(); } catch (e0) {}
      if (mainDoc) docs.push(mainDoc);
      if (document !== mainDoc) docs.push(document);
      return docs;
    },


    _walkDocuments: function (visitor, startDoc, depth) {
      var doc = startDoc || document;
      var level = typeof depth === 'number' ? depth : 0;
      if (!doc || level > 4) return false;
      if (visitor(doc)) return true;

      var iframes = [];
      try {
        iframes = doc.querySelectorAll('iframe');
      } catch (e) {}

      for (var i = 0; i < iframes.length; i++) {
        try {
          var subDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
          if (this._walkDocuments(visitor, subDoc, level + 1)) return true;
        } catch (e2) {}
      }
      return false;
    },

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

    _clearMediaPendingState: function (reason) {
      var hadPending = !!(this._activeMediaJobPending || this._isPlaying || this._videoEl || this._checkInterval);
      this._clearCheckInterval();
      this._videoEl = null;
      this._videoCount = 0;
      this._currentVideoIndex = 0;
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._activeMediaJobManaged = false;
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._mediaWaitLogAt = 0;
      this._mediaNoSourceSince = 0;
      this._mediaBrokenSince = 0;
      this._documentWaitLogAt = 0;
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      if (hadPending) {
        emitRuntimeLog('info', 'clear media pending', { reason: reason || '' });
      }
    },


    _isActiveMediaPending: function (reason) {
      // 有些播放器在切换清晰度/广告后会悄悄重置内部状态，把 _isPlaying 清掉，
      // 于是 tick 以为「没有任务」→ 每 5 秒搜一次 → `study no runnable job` 刷屏
      // （2026-10-26 日志：一个视频播放的 6 分钟里刷了 70 多条）。
      // 只要手里那个 video 元素还在播，就应当按「任务进行中」处理。
      var liveVideo = this._videoEl;
      var stillPlaying = !!(liveVideo && liveVideo.isConnected && !liveVideo.paused && !liveVideo.ended);
      if (!this._activeMediaJobPending && !this._isPlaying && !stillPlaying) return false;
      // ⚠️ **先解析元素，再问「这一节是不是该放行」**（批次 51）。
      //    旧写法把这两步反着来：放行判据读的是缓存字段 `this._videoEl`，元素要到下一行
      //    才 `|| this._getVideoEl()` 拿 —— 而 `_getVideoEl()` 自己会把缓存填回去。
      //    于是同一节里「还在播」与「任务框都显示已完成」逐拍轮流成立：
      //    放行那一拍 `_clearMediaPendingState` 把日志时钟和批次 40/50 的放手窗口一起清零，
      //    下一拍 OCS 循环用 `_getVideoEl()` 重新拿到元素 → 又变回占住 → 再被清零。
      //    现场实测（2026-11-13，用户挂着刷课，CDP 9334，12.4 小时那份日志）：
      //    这一对每秒两条，「media pending, delay completion」独占 20500 条 =
      //    整份 200 条环形日志的 **81%**（证据窗只剩约 100 秒，用户来问"刚才为什么跳过"时
      //    那一刻的记录早被挤没了）；更糟的是 `_mediaBrokenSince` 每次刚武装就被清零 ——
      //    **批次 50 那 120 秒的有界放手在这一格里一秒都攒不起来**，正是要它放手的形状。
      //    方向是**只放得更少**：元素还在播就不许因为"框都显示完成"而放行这一节。
      var media = liveVideo || this._getVideoEl();
      if (this._shouldReleaseMediaPendingForCurrentCompletion(reason || 'media-pending', media)) {
        this._clearMediaPendingState('completed-visible-task:' + (reason || ''));
        return false;
      }

      if (!media) {
        if (!this._activeMediaJobPending) return false;
        var missingNow = Date.now();
        if (!this._mediaWaitLogAt || missingNow - this._mediaWaitLogAt > 5000) {
          this._mediaWaitLogAt = missingNow;
          emitRuntimeLog('info', 'media pending, waiting for element', { reason: reason || '' });
        }
        return true;
      }

      if (media.ended) {
        if (this._activeMediaJobManaged) {
          this._activeMediaJobPending = false;
          this._activeMediaJobManaged = false;
          this._isPlaying = false;
          this._videoEl = null;
          this._videoCount = 0;
          this._currentVideoIndex = 0;
          this._mediaWaitLogAt = 0;
          emitRuntimeLog('info', 'managed media job ended', { reason: reason || '', jobid: this._activeJobId || '' });
          return false;
        }
        if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
          this._currentVideoIndex++;
          this._videoEl = null;
          this._activeMediaJobPending = true;
          this._mediaWaitLogAt = 0;
          return true;
        }
        this._activeMediaJobPending = false;
        this._isPlaying = false;
        this._mediaWaitLogAt = 0;
        return false;
      }

      // 「拿到元素但源从来没挂上」必须**有界放手**（批次 40）。
      // 现场实测（2026-11-13，用户挂着刷课，CDP 9334）：这一节的播放器是
      // `<video id="video_html5_api" class="vjs-tech">`，readyState 0 / networkState 3（NETWORK_NO_SOURCE）
      // / duration null / currentTime 0 / error 空 / 0×0，`media.ended` 因此**永远是 false** ——
      // 上面那条分支救不了它，于是 `_activeMediaJobPending` 恒真、整节停摆 12 分钟，
      // 一条答题都没发出去，日志里 guard 时间戳每秒被刷新一次（= 一直在重试，但永不放手）。
      // 判据只认「既没有首帧也没有时长」这种**从来没有过源**的形状；窗口对齐
      // `documentSkipTimeoutMs`（默认 120 秒，62-tasks-run.js 里等文档资源用的就是它），
      // 正常视频哪怕首帧慢也会在窗口内变成 readyState>0 或拿到 duration，那时清零重新计。
      // ⚠️ 放手必须留 warn：静默跳过用户的任务点是这个项目不许的事（AGENTS §2.7），
      //    而且现场证据（readyState/networkState/src）要一起落进日志，
      //    否则「视频没播成」和「这一节压根没视频」两种情况在日志里长成一个样。
      var noSourceShape = Number(media.readyState) === 0 && !(Number(media.duration) > 0);
      if (!noSourceShape) {
        this._mediaNoSourceSince = 0;
      } else if (!this._mediaNoSourceSince) {
        this._mediaNoSourceSince = Date.now();
      } else if (Date.now() - this._mediaNoSourceSince >= (Number(this.configs.documentSkipTimeoutMs) || 120000)) {
        var stuckHeldMs = Date.now() - this._mediaNoSourceSince;
        var stuckSrc = '';
        try { stuckSrc = String(media.currentSrc || media.src || '').slice(0, 120); } catch (eSrc) {}
        this._mediaNoSourceSince = 0;
        emitRuntimeLog('warn', 'media has no source, release pending', {
          reason: reason || '', readyState: Number(media.readyState),
          networkState: Number(media.networkState), heldMs: stuckHeldMs, src: stuckSrc
        });
        this._clearMediaPendingState('media-no-source');
        return false;
      }

      // 「源挂上了、播到一半**解码器死了**」这一族上面那条看不见（批次 50）——
      // `noSourceShape` 要的是 readyState 0 且拿不到 duration，而现场那次是
      // readyState 4 / duration 1448 / `error.code=3`：
      // 2026-11-14 用户挂着刷课（CDP 9334），`currentTime` 从 628.771 起**将近一刻钟一格没动**，
      // `paused` 却是 false —— 于是播放中的每一道判据都说"在播"，只有 `error` 说真话。
      // 放手窗口沿用 `documentSkipTimeoutMs`（**不加新配置键**：加一个键要动三份默认值 +
      // 界面绑定 + 策略区间，那些都由自检第 12 项守着，能复用就别新开面）。
      // ⚠️ 放手**不等于标记完成** —— `_clearMediaPendingState` 只清状态、不上报完成，
      //    真正的"这一节做完没"仍由平台的 `#isFinished` 说话；反复重派由外层的
      //    `_countTaskIncomplete`（进度快照 `media:<秒>` 恒等 → 4 次就放弃 24 小时）收住。
      //    静默跳过用户的任务点是这个项目不许的事（AGENTS §2.7），所以这里必须留 warn，
      //    并把 code / message / 位置 / 是否重载过一起写进日志。
      var brokenCode = this._mediaErrorCode(media);
      if (!brokenCode) {
        this._mediaBrokenSince = 0;
      } else if (!this._mediaBrokenSince) {
        this._mediaBrokenSince = Date.now();
      } else if (Date.now() - this._mediaBrokenSince >= (Number(this.configs.documentSkipTimeoutMs) || 120000)) {
        var brokenHeldMs = Date.now() - this._mediaBrokenSince;
        var brokenMsg = '';
        try { brokenMsg = String((media.error && media.error.message) || '').slice(0, 140); } catch (eErr) {}
        var brokenKey = this._getMediaSeekKey(media);
        this._mediaBrokenSince = 0;
        emitRuntimeLog('warn', 'media pipeline dead, release pending', {
          code: brokenCode,
          message: brokenMsg,
          reason: reason || '',
          currentTime: Number(media.currentTime || 0),
          duration: Number(media.duration || 0),
          heldMs: brokenHeldMs,
          reloaded: !!(brokenKey && this._mediaReloadKeys && this._mediaReloadKeys[brokenKey])
        });
        this._clearMediaPendingState('media-pipeline-dead');
        return false;
      }

      this._activeMediaJobPending = true;
      this._ensurePlaybackRate(media, reason || 'pending');
      if (media.paused) {
        this._isPlaying = true;
        this._tryResumePlayback(reason || 'pending');
      }

      var now = Date.now();
      // 签名只放**播放状态**这一维（paused / playing），外加批次 50 的第三态 `broken<code>`。
      // ⚠️ reason 绝不能再进签名：reason 是「谁来问的」（'completion-check'、
      //    'ocs-runner-active-job' 等十几个调用方标识），同一个视频每秒被两个调用方
      //    一先一后地问，签名就每秒翻一次 —— 下面那道 30 秒闸被自己的签名绕过去。
      //    现场实测（2026-11-13，用户挂着刷课，CDP 9334 读 SW 那份 runtimeLogs）：
      //    200 条环形日志里 196 条是这一句，整个窗口只装得下约 100 秒；
      //    用户来问「刚才那节为什么跳过」时，那一刻的证据早被挤没了 ——
      //    而这条日志的本意恰恰是「让人看得见进度」，反过来把别的证据全冲掉。
      //    心跳本身留着（30 秒一条照样看得出 currentTime 在走），reason 仍在 payload 里。
      //    状态真变了（暂停↔播放）仍然立刻出，但受 5 秒下限约束：
      //    播放器自己抖动时不许把闸再冲开一次。
      var deadCode = this._mediaErrorCode(media);
      // ⚠️ 死流水线**不许**再报成 `playing`（批次 50）：现场那一节 `paused` 恒 false、
      //    时间恒 628.771，于是 200 条环里每一条都写着"playing" —— 而这句话的本意是
      //    「看得出进度在不在走」。**诊断工具骗人比没有诊断更糟**（AGENTS §5）：
      //    看日志的人会照着"在播"往别处查。
      var mediaSig = deadCode ? ('broken' + deadCode) : (media.paused ? 'paused' : 'playing');
      var waitPayload = {
        reason: reason || '',
        currentTime: Number(media.currentTime || 0),
        duration: Number(media.duration || 0)
      };
      if (deadCode) waitPayload.errCode = deadCode;
      var sinceWaitLog = now - (Number(this._mediaWaitLogAt) || 0);
      if (!this._mediaWaitLogAt || sinceWaitLog > 30000
        || (mediaSig !== this._mediaWaitLogSig && sinceWaitLog > 5000)) {
        this._mediaWaitLogAt = now;
        this._mediaWaitLogSig = mediaSig;
        emitRuntimeLog('info', 'media pending, delay completion', waitPayload);
      }
      return true;
    },


    // 从候选媒体里挑一个：优先可见的（video 或 audio），其次隐藏的 audio。
    // 音频常被自定义播放器隐藏（无可见控件/零尺寸）但照样能播；
    // 隐藏的 video 不选，避免误选页面上无关的隐藏视频元素。
    _pickMedia: function (list) {
      var i;
      for (i = 0; i < list.length; i++) {
        var m = list[i];
        if (visible(m) || (m.getClientRects && m.getClientRects().length > 0)) return m;
      }
      for (i = 0; i < list.length; i++) {
        if (String(list[i].tagName || '').toLowerCase() === 'audio') return list[i];
      }
      return null;
    },


    _isVisibleMedia: function (media) {
      return !!media && (visible(media) || (media.getClientRects && media.getClientRects().length > 0));
    },


    _findMediaInDocument: function (doc, depth) {
      if (!doc || !doc.querySelectorAll) return null;
      var picked = this._pickMedia(Array.from(doc.querySelectorAll('video, audio')));
      if (picked) return picked;

      // 播放器可能被包在子 iframe 里（音频任务点常见），递归找一层
      var level = typeof depth === 'number' ? depth : 0;
      if (level >= 3) return null;
      var frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return null; }
      for (var i = 0; i < frames.length && i < 8; i++) {
        var subDoc = this._safeDocOf(frames[i]);
        if (!subDoc) continue;
        var sub = this._findMediaInDocument(subDoc, level + 1);
        if (sub) return sub;
      }
      return null;
    },


    _waitForMediaInDocument: function (doc, timeoutMs) {
      var self = this;
      return new Promise(function (resolve) {
        var deadline = Date.now() + (timeoutMs || 8000);
        var timer = setInterval(function () {
          var media = self._findMediaInDocument(doc);
          if (media) {
            clearInterval(timer);
            resolve(media);
            return;
          }
          if (Date.now() >= deadline) {
            clearInterval(timer);
            resolve(null);
          }
        }, 200);
      });
    },


    _getMediaSeekKey: function (media) {
      if (!media) return '';
      var src = '';
      try { src = media.currentSrc || media.src || ''; } catch (e) {}
      if (src) return src;
      if (this._activeJobId) return 'job:' + this._activeJobId;
      return '';
    },


    // 可拖动的视频/音频：直接拖到结尾。每个媒体只检查一次、最多只做一次拖动动作；
    // 网站有防拖拽把进度弹回时也不再重试，避免与播放器对抗。
    // 音频原先被排除（旧注释「只拖视频」），但实测有些音频任务同样能拖到底、平台照常计完成
    //（用户反馈）；拖不动的音频会在下面的「弹回检测」里被标记为不可拖，自动回落到正常播放。
    // 注意：PPT 逐页音频走的是 _runPptAudioJob，不设 _videoEl、不经这条路，所以不受影响。
    _trySeekToEnd: function (video, reason) {
      var mediaTag = video && String(video.tagName || '').toUpperCase();
      if (mediaTag !== 'VIDEO' && mediaTag !== 'AUDIO') return false; // 只拖视频/音频，其它元素不碰
      if (!this.configs.enableSeek) return false;
      if (this._rateProbing) return false; // 倍速探测期间不动进度条，探测结束后的巡检会再进来
      if (this._captchaActive) return false;
      if (!this._seekTriedKeys) this._seekTriedKeys = Object.create(null);
      if (!this._seekRevertedKeys) this._seekRevertedKeys = Object.create(null);
      var key = this._getMediaSeekKey(video);
      if (!key) return false;
      if (this._seekTriedKeys[key]) return false; // 本视频已检查过，只做一次
      if (Object.keys(this._seekTriedKeys).length > 300) {
        this._seekTriedKeys = Object.create(null);
        this._seekRevertedKeys = Object.create(null);
      }

      var duration = Number(video.duration);
      if (!isFinite(duration) || duration <= 20) return false; // 元数据未就绪/时长太短：不标记，下次再检查
      this._seekTriedKeys[key] = true; // 检查完成：此后无论成败都不再动这个视频

      var current = Number(video.currentTime || 0);
      if (current >= duration - 8) return false; // 已在结尾附近，无需拖动

      var target = Math.max(0, duration - 3); // 留 3 秒自然播完，让 ended 事件与任务完成正常触发
      try {
        video.currentTime = target;
      } catch (e) {
        return false;
      }
      emitRuntimeLog('info', 'seekable video: seek to end', {
        reason: reason || '',
        from: Number(current.toFixed(1)),
        to: Number(target.toFixed(1)),
        duration: Number(duration.toFixed(1))
      });
      console.log('%c[Omitone] seekable video, seek to end: ' + current.toFixed(1) + 's -> ' + target.toFixed(1) + 's / ' + duration.toFixed(1) + 's', 'color:#4CAF50');

      // 1.5 秒后验证进度是否被网站弹回。
      //
      // ⚠️ 原来这里是「只记日志、不再重试」，实测量出一笔很贵的账：
      //    2026-10-26 的日志里，385 秒的视频 seek 到 382 秒后被播放器**静默吞掉**
      //    （currentTime 从 3 秒继续涨），插件以为拖过了，于是按 1 倍速完整看了 6 分半。
      //    播放器在 metadata 刚就绪时吞掉第一次 seek 很常见，所以这里允许再补两次；
      //    两次都弹回才认定「这个视频不可拖拽」，结论仍然给 _isNinetyPercentVideo 复用。
      var self = this;
      var verifySeek = function (attempt) {
        try {
          if (!video.isConnected) return;
          var now = Number(video.currentTime || 0);
          if (now >= duration - 12) {
            self._seekRevertedKeys[key] = false; // 拖成功 → 可拖拽，不走 90% 提前结束
            console.log('[Omitone] seek to end confirmed, now=' + now.toFixed(1) + 's');
            return;
          }
          if (attempt < 2) {
            try { video.currentTime = target; } catch (eRetry) { return; }
            emitRuntimeLog('info', 'seek reverted by site, retry', {
              attempt: attempt + 1,
              from: Number(now.toFixed(1)),
              to: Number(target.toFixed(1))
            });
            self._workerDelay(function () { verifySeek(attempt + 1); }, 1500);
            return;
          }
          self._seekRevertedKeys[key] = true;  // 两次都弹回 → 不可拖拽
          console.log('[Omitone] seek reverted by site player, continue normal playback');
          emitRuntimeLog('info', 'seek reverted by site, keep playing normally');
        } catch (e) {}
      };
      this._workerDelay(function () { verifySeek(0); }, 1500);
      return true;
    },


    _playChaoxingMediaJob: async function (job) {
      if (!job || !job.doc) return false;
      if (!this.configs.enableMedia) {
        console.log('%c[Omitone] media learning disabled, skip: ' + job.name, 'color:#FF9800');
        return true;
      }

      var video = this._findMediaInDocument(job.doc);
      if (!video) {
        video = await this._waitForMediaInDocument(job.doc, 8000);
      }

      if (video) {
        this._videoEl = video;
        this._videoCount = 1;
        this._currentVideoIndex = 0;
      }

      if (!video) {
        this._activeMediaJobPending = false;
        console.warn('[Omitone] chaoxing media not ready:', job.name);
        return false;
      }

      var isAudioTask = String(video.tagName || '').toLowerCase() === 'audio';

      this._activeJobId = job.jobid || '';
      this._skipChainCount = 0;
      this._activeMediaJobPending = !video.ended;
      this._activeMediaJobManaged = true;
      this._mediaWaitLogAt = 0;
      this._isPlaying = true;
      // 每个任务点重新探测最大倍速：避免上一个视频的探测结果串到当前音频上
      this._resetRateDetection();
      this._ensurePlaybackRate(video, 'job-media');
      if (isAudioTask) {
        // 音频诊断：把格式/MIME/浏览器支持情况与最终倍速记进日志，方便确认 m4a 到底能不能播
        var audioSrc = String(video.currentSrc || video.src || '');
        var audioMime = this._guessMediaMime(audioSrc);
        var canPlay = 'unknown';
        try {
          var probe = document.createElement('audio');
          canPlay = probe.canPlayType(audioMime || 'audio/mp4') || 'no';
        } catch (eProbe) {}
        emitRuntimeLog('info', 'audio task started', {
          name: job.name,
          src: audioSrc.slice(-70),
          mime: audioMime || 'unknown',
          canPlay: canPlay,
          muted: !!video.muted,
          rate: Number(video.playbackRate || 1)
        });
      }
      this._trySeekToEnd(video, 'job-start');
      this._videoEventHandle();
      try {
        await this._withTimeout(video.play(), 12000);
        this._startVideoMonitoring();
      } catch (e) {
        try {
          video.muted = true;
          await this._withTimeout(video.play(), 12000);
          this._isPlaying = true;
          this._startVideoMonitoring();
          // play() 被拒后浏览器会把 currentTime 打回 0，站点也可能顺手把倍速重置成 1。
          // 不补这两下，日志里就是「seek 到 102/105 → 静音重试 → 从 0.8s 用 1x 重看一遍」。
          try { this._trySeekToEnd(video, 'after-muted-retry'); } catch (eSeek) {}
          try { this._ensurePlaybackRate(video, 'after-muted-retry'); } catch (eRate) {}
          emitRuntimeLog('warn', 'media autoplay blocked, muted retry ok', { name: job.name });
        } catch (e2) {
          // 静音重试仍失败：多半是音源格式/MIME 不支持（m4a 常见），尝试重新封装音源后播放
          var errText = String((e2 && e2.name) || '') + ' ' + String((e2 && e2.message) || '');
          if (/NotSupported/i.test(errText) || (video.error && video.error.code === 4)) {
            var repaired = await this._maybeRepairMediaSource(video);
            if (repaired) {
              this._isPlaying = true;
              this._startVideoMonitoring();
              emitRuntimeLog('info', 'media play recovered after source repair', { name: job.name });
              return true;
            }
          }
          this._isPlaying = false;
          // 站点的播放器自己在同一刻调 load()/pause() 时，这一发 play() 的 promise 会被它打断。
          // 这**不等于**"这个视频看不了"：下一拍会重新接上（现场实测：打完这两句 currentTime 照走）。
          // 状态面板把 error 级日志读成「异常运行」，所以只把这种自愈的中断降级；
          // 真读不到源的仍然留 error —— 那才是要人看一眼的那一种。
          var interruptedBySite = /interrupted by/i.test(errText);
          var errDetail = String((e2 && e2.message) || e2 || '').slice(0, 160);
          if (interruptedBySite) {
            emitRuntimeLog('warn', 'media play interrupted by site player', {
              name: job.name,
              error: errDetail,
              hint: '站点播放器自己动了 load/pause，这一下 play 被打断 —— 会重新接上，不用管'
            });
          } else {
            emitRuntimeLog('error', 'media play failed', {
              name: job.name,
              error: errDetail
            });
            console.error('[Omitone] chaoxing media play failed:', e2 && e2.message ? e2.message : e2);
          }
        }
      }
      return true;
    },


    _startSlideMedia: function (doc) {
      var medias = [];
      try {
        medias = Array.from(doc.querySelectorAll('audio, video'));
      } catch (e) {}
      var self = this;
      medias.forEach(function (media) {
        if (media.ended) return;
        try {
          media.muted = !!self.configs.muted;
        } catch (e1) {}
        if (media.paused) {
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') {
              p.catch(function () {
                try {
                  media.muted = true;
                  media.play().catch(function () {});
                } catch (e2) {}
              });
            }
          } catch (e3) {}
        }
      });
      return medias.length;
    },


    _waitSlideAudioDone: async function (doc) {
      var waited = 0;
      while (waited < 600000) {
        // ⚠️ 心跳：本循环上限 600 秒，远超看门狗的 150 秒 —— 不刷心跳会被误判成卡死，
        //    导致新一轮 tick 与这次并行操作同一个任务点（见 64-tasks-loop.js 的看门狗）。
        this._tickProgress('ppt-audio wait');
        var active = [];
        try {
          active = Array.from(doc.querySelectorAll('audio, video')).filter(function (media) {
            return !media.ended && (Number(media.currentTime || 0) > 0 || !media.paused);
          });
        } catch (e) {}
        if (!active.length) return true;

        active.forEach(function (media) {
          if (!media.paused) return;
          try {
            var p = media.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (e2) {}
        });

        var remaining = 0;
        for (var i = 0; i < active.length; i++) {
          var left = Number(active[i].duration || 0) - Number(active[i].currentTime || 0);
          if (!(left > 0)) left = 1;
          if (left > remaining) remaining = left;
        }
        var waitMs = Math.min(Math.ceil(remaining * 1000) + 800, 30000);
        await sleep(waitMs);
        waited += waitMs;
      }
      return false;
    },


    _ensurePlaybackRate: function (video, reason) {
      if (!video) return;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 音频不再由插件静音（旧的 audioMuted 开关已删）。
      // 它反复出现「录不上进度 / 声音忽大忽小」这类问题，而用户随手静音标签页就能解决。
      try {
        video.muted = !isAudio && !!this.configs.muted;
      } catch (e0) {}
      if (this.configs.autoMaxPlaybackRate !== false && this._rateDetectVideo !== video) {
        this._scheduleMaxRateDetection(video);
      }
      if (this._rateProbing) return;
      var target = this._getTargetPlaybackRate();
      try {
        if (video.defaultPlaybackRate !== target) video.defaultPlaybackRate = target;
      } catch (e) {}
      try {
        if (Math.abs(Number(video.playbackRate || 1) - target) > 0.01) {
          video.playbackRate = target;
          console.log('%c[Omitone] rate guard ' + reason + ': ' + target + 'x', 'color:#607D8B');
        }
      } catch (e2) {}
    },


    _getTargetPlaybackRate: function () {
      if (this.configs.autoMaxPlaybackRate !== false && Number(this._detectedMaxRate) > 0) {
        return this._clampAutoRate(this._detectedMaxRate);
      }
      var target = Number(this.configs.playbackRate || 1);
      return isFinite(target) && target > 0 ? target : 1;
    },


    _clampAutoRate: function (rate) {
      var value = Number(rate) || 1;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      if (value > cap) value = cap;
      if (value < 0.5) value = 0.5;
      return value;
    },


    _resetRateDetection: function () {
      this._detectedMaxRate = 0;
      this._rateDetectVideo = null;
    },


    _scheduleMaxRateDetection: function (video) {
      if (!video) return;
      this._rateDetectVideo = video;
      if (this._rateDetectBusy) return;
      var self = this;
      var epoch = this._rateEpoch || 0;
      this._rateDetectBusy = true;

      var runDetect = function () {
        self._detectMaxPlaybackRate(video).then(function (rate) {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return; // 任务已切换，探测结果作废
          if (Number(rate) > 0) {
            self._detectedMaxRate = rate;
            emitRuntimeLog('info', 'auto playback rate detected', { rate: rate });
            self._ensurePlaybackRate(self._getVideoEl() || video, 'auto-rate');
          } else {
            self._rateDetectVideo = null;
          }
        }).catch(function () {
          self._rateDetectBusy = false;
          if ((self._rateEpoch || 0) !== epoch) return;
          self._rateDetectVideo = null;
        });
      };

      // 暂停状态下播放器可能不接管倍速，等播放开始后再探测
      if (!video.paused) {
        runDetect();
        return;
      }
      var tries = 0;
      var timer = setInterval(function () {
        if ((self._rateEpoch || 0) !== epoch) { // 任务已切换，放弃这次探测
          clearInterval(timer);
          self._rateDetectBusy = false;
          return;
        }
        tries++;
        if (!video.paused) {
          clearInterval(timer);
          runDetect();
          return;
        }
        if (tries >= 60) {
          clearInterval(timer);
          self._rateDetectBusy = false;
          self._rateDetectVideo = null;
        }
      }, 500);
    },


    _detectMaxPlaybackRate: async function (video) {
      if (!video) return 0;
      // 首选：播放器倍速菜单里暴露的档位（老师设置的上限会体现在菜单中）
      var menuMax = this._readRateMenuMax(video);
      if (menuMax > 0) {
        emitRuntimeLog('info', 'rate menu max found', { rate: menuMax });
        return this._clampAutoRate(menuMax);
      }
      // 备选：从高到低试设倍速，观察播放器是否把倍速压回
      var probed = await this._probeMaxPlaybackRate(video);
      // ⚠️ 探测不出来 ≠ 上限就是 1 倍。原来这里 `probed || 1` 会把「不知道」当成
      // 「只能 1 倍」，然后把用户自己设的播放速度也一起压回 1（日志里
      // `auto playback rate detected {"rate":1}` 之后就是全程 1 倍速）。
      // 返回 0 表示「没测出上限」，让 _getTargetPlaybackRate 回退到配置里的速度。
      if (!probed) return 0;
      return this._clampAutoRate(probed);
    },


    _readRateMenuMax: function (video) {
      var doc = video && (video.ownerDocument || document);
      if (!doc) return 0;
      var isAudio = String(video.tagName || '').toLowerCase() === 'audio';
      // 优先在播放器容器内找倍速菜单；音频不做整文档扫描，避免读到页面上其他视频播放器的档位
      var scopes = [];
      try {
        var container = video.closest
          ? video.closest('.video-js, .vjs-player, [class*="player"], [class*="Player"]')
          : null;
        if (container) scopes.push(container);
      } catch (e0) {}
      if (!isAudio) scopes.push(doc);

      var selector = '.vjs-menu-item, .vjs-menu-content li, [class*="speed"] li, [class*="Speed"] li, [class*="rate"] li';
      var maxRate = 0;
      for (var s = 0; s < scopes.length; s++) {
        var nodes = [];
        try {
          nodes = Array.from(scopes[s].querySelectorAll(selector));
        } catch (e) {
          continue;
        }
        for (var i = 0; i < nodes.length; i++) {
          var text = textOf(nodes[i]);
          if (!text || text.length > 16) continue;
          var match = text.match(/(\d+(?:\.\d+)?)\s*(?:x|X|倍)/);
          if (!match) continue;
          var rate = parseFloat(match[1]);
          if (rate > 0 && rate < 32 && rate > maxRate) maxRate = rate;
        }
        if (maxRate > 0) break;
      }
      return maxRate;
    },


    _probeMaxPlaybackRate: async function (video) {
      var self = this;
      var cap = Number(this.configs.playbackRateCap || 4);
      if (!isFinite(cap) || cap <= 0) cap = 4;
      var candidates = [4, 3, 2.5, 2, 1.75, 1.5, 1.25, 1].filter(function (c) { return c <= cap; });
      var best = 0;
      this._rateProbing = true;
      try {
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          try { video.playbackRate = candidate; } catch (e) { continue; }
          var settled = await self._waitRateSettle(video, 700);
          if (settled > 0 && Math.abs(settled - candidate) <= 0.05) {
            best = candidate;
            break;
          }
          if (settled > best) best = settled;
        }
      } finally {
        this._rateProbing = false;
      }
      return best;
    },


    _waitRateSettle: async function (video, waitMs) {
      var last = -1;
      var stable = 0;
      var elapsed = 0;
      while (elapsed < (waitMs || 700)) {
        await sleep(150);
        elapsed += 150;
        var current = Number(video.playbackRate || 0);
        if (Math.abs(current - last) <= 0.001) {
          stable += 150;
          if (stable >= 300) return current;
        } else {
          stable = 0;
        }
        last = current;
      }
      return last > 0 ? last : 0;
    },


    _startVideoMonitoring: function () {
      this._clearCheckInterval();
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      this._ensureBackgroundWorker();
      this._bindVisibilityHandlers();
      this._syncAudioKeepalive();
      var self = this;
      this._checkInterval = setInterval(function () {
        self._checkVideoStatus();
      }, this.configs.videoCheckInterval || 1500);
    },


    _clearCheckInterval: function () {
      if (this._checkInterval) {
        clearInterval(this._checkInterval);
        this._checkInterval = null;
      }
      this._syncAudioKeepalive();
    },


    _startAudioKeepalive: function () {
      if (this._audioKeepalive) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        oscillator.frequency.value = 50;
        gain.gain.value = 0.003; // 近乎无声：人耳不可辨，但足以让浏览器将标签页视为正在播放音频
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          ctx.resume().catch(function () {});
        }
        this._audioKeepalive = { ctx: ctx, oscillator: oscillator };
        emitRuntimeLog('info', 'audio keepalive started (anti background throttling)');
      } catch (e) {}
    },


    _stopAudioKeepalive: function () {
      if (!this._audioKeepalive) return;
      try { this._audioKeepalive.oscillator.stop(); } catch (e0) {}
      try { this._audioKeepalive.ctx.close(); } catch (e1) {}
      this._audioKeepalive = null;
    },


    _syncAudioKeepalive: function () {
      var hidden = !!(document.hidden || document.visibilityState === 'hidden');
      if (this._isPlaying && hidden) this._startAudioKeepalive();
      else this._stopAudioKeepalive();
    },


    _checkVideoStatus: function () {
      try {
        var video = this._getVideoEl();
        if (!video) return;
        this._ensurePlaybackRate(video, 'guard');
        this._trySeekToEnd(video, 'guard');

        if (video.paused && this._isPlaying && !this._captchaActive) {
          this._tryResumePlayback('paused');
        } else if (this._isPlaying && !video.ended) {
          var now = Date.now();
          var current = Number(video.currentTime || 0);
          if (this._guardLastWallTs === 0) {
            this._guardLastWallTs = now;
            this._guardLastTime = current;
          } else {
            var stalled = Math.abs(current - this._guardLastTime) < 0.01;
            var stalledMs = now - this._guardLastWallTs;
            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
              this._tryResumePlayback('no-progress');
              this._guardLastWallTs = now;
              this._guardLastTime = Number(video.currentTime || 0);
            } else if (!stalled) {
              this._guardLastWallTs = now;
              this._guardLastTime = current;
            }
          }
        }

        // 防拖拽 + 倍速锁 1x 的视频：平台只要求 ≥90%，平台标记完成后就别再白等最后 10%
        if (!video.ended && this._isPlaying && this._shouldAdvanceAtNinetyPercent(video)) {
          this._finishCurrentMedia('ninety-percent');
          return;
        }

        if (video.ended && this._isPlaying) {
          this._finishCurrentMedia('guard');
        }
      } catch (e) {}
    },


    /**
     * 当前视频"播完了"的统一收尾。
     *
     * 两条路径共用：正常的 `ended`，以及「防拖拽 + 锁 1 倍速」的视频到 90% 且平台已标记完成。
     * 抽出来是为了不让两条路各写一份 —— 收尾漏掉一个字段（比如 `_activeMediaJobManaged`）
     * 会让状态机卡住，而症状是"这个任务点过了但下一个不动"，很难查。
     */
    _finishCurrentMedia: function (reason) {
      this._clearCheckInterval();
      if (this._activeMediaJobManaged) {
        this._isPlaying = false;
        this._activeMediaJobPending = false;
        this._activeMediaJobManaged = false;
        this._videoEl = null;
        this._videoCount = 0;
        this._currentVideoIndex = 0;
        this._mediaWaitLogAt = 0;
        emitRuntimeLog('info', 'managed media job ended', { reason: reason || 'guard', jobid: this._activeJobId || '' });
        return;
      }
      if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
        this._currentVideoIndex++;
        this._videoEl = null;
        this._activeMediaJobPending = true;
        this._mediaWaitLogAt = 0;
        return;
      }
      this._isPlaying = false;
      this._activeMediaJobPending = false;
      this._mediaWaitLogAt = 0;
      this.nextUnit();
    },


    // 倍速是否被平台锁在 1 倍速。探测没结果（0）时一律当作"没锁定" ——
    // 宁可多播一会儿，也不要在没确认的情况下提前结束。
    _isRateLockedAtOne: function () {
      var rate = Number(this._detectedMaxRate);
      return isFinite(rate) && rate > 0 && rate <= 1.001;
    },


    /**
     * 「防拖拽 + 倍速锁 1x」的视频 —— 平台只要求观看时长 ≥ 总时长的 90%。
     *
     * 判据是两个"平台不让我们加速"的信号**同时**成立：
     *   1) 拖到结尾被播放器弹回（不可拖拽，见 _trySeekToEnd）
     *   2) 倍速探测结果就是 1x（老师把倍速也锁了）
     * 只满足一个都不算：能拖的视频早就拖到结尾了，能加速的视频也不该提前结束。
     */
    _isNinetyPercentVideo: function (video) {
      if (!video) return false;
      var mediaTag = String(video.tagName || '').toLowerCase();
      if (mediaTag !== 'video' && mediaTag !== 'audio') return false; // 视频/音频都适用（拖不动+锁1x 时到 90% 提前收尾）
      if (!this._isRateLockedAtOne()) return false;
      var key = this._getMediaSeekKey(video);
      if (!key) return false;
      return !!(this._seekRevertedKeys && this._seekRevertedKeys[key]);
    },


    /**
     * 该不该在播到 90% 时提前收尾。
     *
     * 最关键的一条：**必须由平台自己给出"任务点已完成"的标记**。
     * 只按"播够 90% 就当作完成"会误跳过任务点，比多花十分钟严重得多 ——
     * 这与本仓库对"拿不准"的一贯取舍一致（见 `_isJobCompleted` 的说明）。
     */
    _shouldAdvanceAtNinetyPercent: function (video) {
      try {
        if (this.configs.advanceAtNinetyPercent === false) return false;
        if (!this._isNinetyPercentVideo(video)) return false;

        var duration = Number(video.duration);
        if (!isFinite(duration) || duration <= 0) return false;
        var ratio = Number(video.currentTime || 0) / duration;
        if (!(ratio >= 0.9)) return false;  // 还没到 90%
        if (ratio >= 0.995) return false;   // 已到结尾，交给 ended 那条路，避免两条路抢

        if (!this._isDocumentFrameFinished(video.ownerDocument)) return false; // 平台没确认完成就不动

        emitRuntimeLog('info', 'advance at 90% (locked 1x + not seekable)', {
          ratio: Number(ratio.toFixed(3)),
          duration: Number(duration.toFixed(1)),
          jobid: this._activeJobId || ''
        });
        console.log('%c[Omitone] 防拖拽+锁1x：已到 ' + (ratio * 100).toFixed(0) +
          '%，平台已标记完成，直接进下一个', 'color:#4CAF50');
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * 媒体元素此刻是不是"流水线已死"—— 返回 `MediaError.code`
     * （1 中止 / 2 网络 / 3 解码失败 / 4 源不支持），没报错返回 0。
     *
     * 为什么要单独问它：现场实测（2026-11-14，用户挂着刷课，CDP 9334）那一节解码器抛了
     * `PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding`，而 `paused` 仍是 false、
     * `readyState` 仍是 4、`duration` 照样是 1448 —— 手上每一道"看 paused / 看有没有源"的判据
     * 都说"在播"，**只有 `error` 这一个字段说真话**。
     * ⚠️ 整个取值包 try：自定义播放器偶尔把 `error` 换成别的形状（字符串、没有 code 的对象），
     *    而这条判据在 guard 与 tick 上每秒都会被问一次 —— 它一抛就把整轮巡检打死。
     */
    _mediaErrorCode: function (media) {
      try {
        if (!media) return 0;
        var code = Number(media.error && media.error.code);
        return (code >= 1 && code <= 4) ? code : 0;
      } catch (e) {
        return 0;
      }
    },


    /**
     * 死流水线的**原地重载**：源不动，`load()` 让浏览器重建解码管线，播放位置等元数据回来再接回去。
     * 每个源只试一次（按 `_getMediaSeekKey` 记进 `_mediaReloadKeys`，与 `_mediaRepaired` 同一族），
     * 免得"重载 ↔ 放手"互相打转。
     *
     * ⚠️ 为什么不用 `_maybeRepairMediaSource` 那条 blob 补救：那是**整个文件取回来重封 MIME**，
     *    治的是"格式 / MIME 不对"这一族，对"下载到一半坏包"没用；而且它靠 `fetch` ——
     *    现场那次它已经把 src 记成"补救过了"（`_mediaRepaired[src]=true`）却**一个 blob 都没挂上**
     *    （`currentSrc` 仍是远端地址，多半被 CDN 的 CORS 挡在 `fetch` 那一步），
     *    于是那条路对这一族永久关闭。**一个补救只管自己那一族，别指望它顺带治解码。**
     * ⚠️ 这里**不等任何东西**（不调 `await`）：`load()` 之后由一次性 `loadedmetadata` 补 seek，
     *    下一轮 guard 看到 `error` 已被清掉就照常走。在这条链上加等待就得配超时，
     *    而等待本身没有收益（AGENTS §2.2）。
     */
    _reloadMediaInPlace: function (media, reason) {
      try {
        var code = this._mediaErrorCode(media);
        if (!code) return false;
        var key = this._getMediaSeekKey(media);
        if (!key) return false;
        if (!this._mediaReloadKeys) this._mediaReloadKeys = Object.create(null);
        if (this._mediaReloadKeys[key]) return false;
        this._mediaReloadKeys[key] = Date.now();

        var resumeAt = Number(media.currentTime || 0);
        emitRuntimeLog('warn', 'media pipeline dead, reload in place', {
          code: code,
          resumeAt: resumeAt,
          reason: reason || ''
        });
        if (resumeAt > 0) {
          var self = this;
          media.addEventListener('loadedmetadata', function () {
            // `load()` 会把 currentTime 归零，位置必须等元数据回来再补 ——
            // 现在就设会被 readyState 0 的状态吞掉，症状是"重载过了，却从第一秒重新播"。
            try { media.currentTime = resumeAt; } catch (e0) {}
            self._ensurePlaybackRate(media, 'reload');
          }, { once: true });
        }
        media.load();
        var started = media.play();
        if (started && typeof started.catch === 'function') {
          started.catch(function () {
            // 自动播放策略挡住了就静音重试一次（与 _tryResumePlayback 同一个兜底）
            try {
              media.muted = true;
              var retry = media.play();
              if (retry && typeof retry.catch === 'function') retry.catch(function () {});
            } catch (e1) {}
          });
        }
        return true;
      } catch (e) {
        return false;
      }
    },


    _tryResumePlayback: function (reason) {
      var now = Date.now();
      var video = this._getVideoEl();
      if (!video || !this._isPlaying) return;

      // ⚠️ 死流水线先走重载，而且**必须放在下面三道闸之前**：那三道闸烧完 5 次就永久 return，
      //    而计数器只在 `play` 事件里清零 —— 管线死了 `play` 事件永远不会来，
      //    于是重载一次也轮不到（现场那 5 发 play() 全白烧，之后一动不动）。
      if (this._mediaErrorCode(video)) {
        this._reloadMediaInPlace(video, reason || 'resume');
        return;
      }

      if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;

      if (!this._resumeWindowStart || now - this._resumeWindowStart > this.configs.guardMaxResumeWindow) {
        this._resumeWindowStart = now;
        this._resumeAttemptCount = 0;
      }
      if (this._resumeAttemptCount >= this.configs.guardMaxResumes) return;

      this._resumeAttemptCount++;
      this._guardLastResumeTs = now;

      this._ensurePlaybackRate(video, reason || 'resume');
      video.play().catch(function () {
        video.muted = true;
        video.play().catch(function () {});
      });
    },


    _getVideoEl: function (index) {
      var idx = typeof index === 'number' ? index : this._currentVideoIndex;
      var self = this;
      if (!this._videoEl) {
        function findVideos(doc, depth) {
          if (!doc || depth > 4) return { visible: [], hiddenAudio: [] };
          var all = Array.from(doc.querySelectorAll('video, audio'));
          var vis = all.filter(self._isVisibleMedia);
          var hiddenAudio = all.filter(function (media) {
            return String(media.tagName || '').toLowerCase() === 'audio' && !self._isVisibleMedia(media);
          });
          var frames = Array.from(doc.querySelectorAll('iframe'));
          for (var i = 0; i < frames.length; i++) {
            try {
              var subDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
              var sub = findVideos(subDoc, depth + 1);
              vis = vis.concat(sub.visible);
              hiddenAudio = hiddenAudio.concat(sub.hiddenAudio);
            } catch (e) {}
          }
          return { visible: vis, hiddenAudio: hiddenAudio };
        }

        try {
          var doc = this._getMainDocument();
          var found = doc ? findVideos(doc, 0) : findVideos(document, 0);
          // 优先可见媒体，其次隐藏的音频（音频任务点常把 <audio> 藏起来）
          var allVideos = found.visible.length ? found.visible : found.hiddenAudio;
          if (allVideos.length === 0) return null;
          this._videoCount = allVideos.length;
          this._videoEl = allVideos[Math.min(idx, allVideos.length - 1)];
        } catch (e2) {
          return null;
        }
      }
      return this._videoEl;
    },


    _videoEventHandle: function () {
      var el = this._videoEl;
      if (!el) return;

      try {
        if (this._onVideoEnded) el.removeEventListener('ended', this._onVideoEnded);
        if (this._onVideoLoaded) el.removeEventListener('loadedmetadata', this._onVideoLoaded);
        if (this._onVideoPlay) el.removeEventListener('play', this._onVideoPlay);
        if (this._onVideoPause) el.removeEventListener('pause', this._onVideoPause);
        if (this._onVideoRateChange) el.removeEventListener('ratechange', this._onVideoRateChange);
        if (this._onVideoError) el.removeEventListener('error', this._onVideoError);
      } catch (e) {}

      this._onVideoEnded = this._handleVideoEnded.bind(this);
      this._onVideoLoaded = this._handleVideoLoaded.bind(this);
      this._onVideoPlay = this._handleVideoPlay.bind(this);
      this._onVideoPause = this._handleVideoPause.bind(this);
      this._onVideoRateChange = this._handleVideoRateChange.bind(this);
      this._onVideoError = this._handleMediaError.bind(this);

      el.addEventListener('ended', this._onVideoEnded);
      el.addEventListener('loadedmetadata', this._onVideoLoaded);
      el.addEventListener('play', this._onVideoPlay);
      el.addEventListener('pause', this._onVideoPause);
      el.addEventListener('ratechange', this._onVideoRateChange);
      el.addEventListener('error', this._onVideoError);
    },


    // 媒体元素报错（1 中止 / 2 网络 / 3 解码失败 / 4 格式或 MIME 不支持）
    // 之前完全没有这个监听，m4a 之类的格式问题永远不会被发现
    _handleMediaError: function (event) {
      var el = event && event.target ? event.target : this._getVideoEl();
      if (!el) return;
      var code = el.error ? el.error.code : 0;
      var message = el.error ? String(el.error.message || '') : '';
      var src = String(el.currentSrc || el.src || '');
      emitRuntimeLog('error', 'media error', {
        code: code,
        message: message.slice(0, 120),
        src: src.slice(-80),
        tag: String(el.tagName || '').toLowerCase()
      });

      // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED（m4a、服务器 MIME 不对最常见），3 = 解码失败
      if (code === 4 || code === 3) {
        var self = this;
        this._maybeRepairMediaSource(el).then(function (ok) {
          emitRuntimeLog(ok ? 'info' : 'error', ok ? 'media source repaired (m4a/mime fallback), replaying' : 'media source repair failed', {
            src: src.slice(-80)
          });
        }).catch(function () {});
      }
    },


    _guessMediaMime: function (url) {
      var u = String(url || '').toLowerCase().split('?')[0];
      if (/\.m3u8$/.test(u)) return '';
      if (/\.m4a$|\.aac$/.test(u)) return 'audio/mp4';
      if (/\.mp3$/.test(u)) return 'audio/mpeg';
      if (/\.ogg$|\.oga$/.test(u)) return 'audio/ogg';
      if (/\.wav$/.test(u)) return 'audio/wav';
      if (/\.webm$/.test(u)) return 'audio/webm';
      if (/\.mp4$|\.m4v$/.test(u)) return 'video/mp4';
      return 'audio/mp4'; // 学习通音频多为 m4a（AAC）
    },


    // 音源不受支持时的兜底：把音频文件取回来，用正确的 MIME 重新封装成 Blob 再播。
    // 全程在页面内完成（不经过扩展消息），避免大文件传输。
    _maybeRepairMediaSource: async function (media) {
      try {
        if (!media) return false;
        var src = String(media.currentSrc || media.src || '');
        if (!src || /^blob:/i.test(src)) return false;
        if (/\.m3u8/i.test(src)) return false; // HLS 由播放器自己处理，不能这样补救

        if (!this._mediaRepaired) this._mediaRepaired = Object.create(null);
        if (this._mediaRepaired[src]) return false;
        this._mediaRepaired[src] = true; // 每个源只补救一次，避免死循环

        // ⚠️ fetch 与读响应体都**必须**可超时。服务器接了连接却不回数据时（CDN 卡住、
        //    被门户/代理吞掉），await 会永久挂起 —— 而这条链在 _runTick 上，
        //    一挂就是整个调度停摆（验证码检测、播放巡检、任务点推进全停）。
        //    注意 try/catch 拦不住"挂起"，只有超时能。
        //    _withTimeout 超时是 resolve(undefined)，下面两处 `!response` / `!buf` 判断正好接得住。
        var response = await this._withTimeout(fetch(src, { credentials: 'include' }), 20000);
        if (!response || !response.ok) return false;
        var buf = await this._withTimeout(response.arrayBuffer(), 60000);
        if (!buf || buf.byteLength < 1024) return false;

        var type = this._guessMediaMime(src);
        var blob = new Blob([buf], { type: type });
        var objectUrl = URL.createObjectURL(blob);
        var resumeAt = Number(media.currentTime || 0);

        media.src = objectUrl;
        media.load();
        await new Promise(function (resolve) {
          var done = false;
          var finish = function () {
            if (!done) { done = true; resolve(); }
          };
          media.addEventListener('canplay', finish, { once: true });
          media.addEventListener('error', finish, { once: true });
          setTimeout(finish, 8000);
        });

        if (resumeAt > 0) {
          try { media.currentTime = resumeAt; } catch (e0) {}
        }
        this._ensurePlaybackRate(media, 'repair');
        await this._withTimeout(media.play(), 12000);
        return true;
      } catch (e) {
        return false;
      }
    },


    /**
     * `ended` 事件的处理。收尾逻辑与 `_checkVideoStatus` 那条路**完全一致**，
     * 所以统一走 `_finishCurrentMedia`。
     *
     * 这里原本多清了三个字段（`_activeDocumentJobPending` / `_activeDocumentJobManaged` /
     * `_activeDocumentJobDoc`），已经确认那是**过界的**，理由有三条：
     *   1) `nextUnit()` 末尾会调 `_resetRuntimeState()`，那些字段本来就会被清掉 ——
     *      正常路径下多清一次是纯冗余；
     *   2) 只有在 `nextUnit()` **提前返回**时（典型是 `autoNext:false`）才有差别，
     *      而那时清掉它们等于**放弃一个可能正在进行的文档任务点** —— 正是本仓库
     *      最怕的"静默漏做"。不清才是对的；
     *   3) 对称：文档任务点完成时（约 2607 行）只清文档自己的状态，不去动媒体状态。
     *      媒体这边同理，只管媒体。
     * 万一真的残留了过期的文档状态，文档那条路自己有 `document stuck timeout` 会兜住。
     */
    _handleVideoEnded: function () {
      this._finishCurrentMedia('event');
    },


    _handleVideoLoaded: function (event) {
      this._resetRateDetection();
      var loadedVideo = event && event.target ? event.target : this._getVideoEl();
      this._ensurePlaybackRate(loadedVideo, 'loadedmetadata');
      this._trySeekToEnd(loadedVideo, 'loadedmetadata');
    },


    _handleVideoPlay: function () {
      this._isPlaying = true;
      this._stepSwitchPending = false;
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      this._syncAudioKeepalive();
      var video = this._getVideoEl();
      this._ensurePlaybackRate(video, 'play');
      this._guardLastTime = Number((video && video.currentTime) || 0);
      this._guardLastWallTs = Date.now();
      if (this._delayedNextUnitTimer) {
        clearTimeout(this._delayedNextUnitTimer);
        this._delayedNextUnitTimer = null;
      }
    },


    _handleVideoPause: function (event) {
      // pause 事件的派发不受后台定时器节流影响：视频被网站/浏览器在后台暂停时立即安排恢复
      var video = event && event.target ? event.target : this._getVideoEl();
      if (!video || video.ended || !this._isPlaying) return;
      if (this._rateProbing) return;
      if (this._pauseResumePending) return;

      var self = this;
      this._pauseResumePending = true;
      this._workerDelay(function () {
        self._pauseResumePending = false;
        var current = self._getVideoEl() || video;
        if (!current || current.ended || !self._isPlaying || !current.paused) return;
        // 验证码/弹窗题/提交确认弹窗打开期间视频是被有意暂停的，不要抢恢复
        try {
          if (self._captchaActive || self._checkCaptchaDialog()) return;
          // ⚠️ 这里必须用 _popupQuizBlocksPlayback 而不是 _activePopupBlock：
          // 后者在"刚答完的静默期"里会返回 null（那是给"要不要再问模型"用的），
          // 但弹窗其实还挂在页面上、视频正是被它有意暂停的。用错就会去抢恢复播放、
          // 和站点对打 —— 现场表现是"答完弹题后视频不动，看着像卡死"。
          if (self._popupQuizBlocksPlayback && self._popupQuizBlocksPlayback()) return;
          if (self._checkSubmitConfirmDialog && self._checkSubmitConfirmDialog()) return;
        } catch (e) {}
        var duration = Number(current.duration || 0);
        if (duration && Number(current.currentTime || 0) >= duration - 0.5) return;

        // ⚠️ 这条 warn 要节流（批次 20-H，实测冲掉过别的现场证据）：
        // 标签页在后台时站点自己会把视频暂停，于是它**每秒一条**，把 runtimeLogs
        // 那个只有 200 条的缓冲区整个占满 —— 真正要看的「讨论为什么没发上」就被冲走了。
        var hiddenNow = !!(document.hidden || document.visibilityState === 'hidden');
        var now = Date.now();
        self._pauseResumeSuppressed = (self._pauseResumeSuppressed || 0) + 1;
        if (now - (self._pauseResumeLogAt || 0) >= 60000) {
          emitRuntimeLog('warn', 'video paused unexpectedly, resuming (anti background pause)', {
            hidden: hiddenNow,
            time: Math.round(Number(current.currentTime || 0)),
            suppressed: self._pauseResumeSuppressed - 1
          });
          self._pauseResumeLogAt = now;
          self._pauseResumeSuppressed = 0;
        }
        var resumed = current.play();
        if (resumed && typeof resumed.then === 'function') {
          resumed.then(function () {
            self._ensurePlaybackRate(current, 'pause-resume');
          }).catch(function () {
            try {
              current.muted = true;
              current.play().catch(function () {});
            } catch (e1) {}
          });
        }
      }, 600);
    },


    _handleVideoRateChange: function (event) {
      this._ensurePlaybackRate(event && event.target ? event.target : this._getVideoEl(), 'ratechange');
    },


    /**
     * 找「继续学习」按钮。
     *
     * 学习通在几种情况下会在**播放器右下角**挂一个「继续学习」：弹题答完之后、
     * 视频被判定为挂机之后、或者从插题回到正常播放之前。**不点它进不去正常播放页**，
     * 于是一切照常跑、课程一动不动 —— 和弹题空转是同一类"看着在忙其实卡住"的故障。
     *
     * 这个按钮没有稳定的类名（不同课程模板不一样），只能靠文案 + 位置 + 形态打分：
     * 文案命中「继续学习/继续观看/继续播放」→ 只接受"按钮样"的小节点（避免点到大容器）
     * → 与视频同文档的加分、本身是 button/a 的加分。
     */
    /**
     * 处理完一个覆盖层（弹题 / 「继续学习」）之后把视频拉起来。
     *
     * 两个分支原本各写一份，逻辑稍有出入就会出现"弹题这条能恢复、继续学习那条不能"
     * 这种只在真机上才看得出的差别 —— 抽出来保证两条路走的是同一套动作。
     * 注意只在 `_isPlaying` 时恢复：用户没开刷课时不该替他播。
     */
    _resumeVideoAfterOverlay: function (reason) {
      if (!this._isPlaying) return;
      var video = this._getVideoEl();
      if (!video || !video.paused) return;
      this._ensurePlaybackRate(video, reason || 'overlay');
      try { video.play(); } catch (e) {}
    },

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
      this._healCaptchaDialogBudget(!!result);
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


    // 等一张图解码完：load / error / 超时三条路都要能出来（超时是 resolve(false)，不抛）。
    // 单独成一个方法是因为 `_recognizeCaptchaImage` 里那次 await 必须可超时 —— 永久悬挂
    // 会把整个 tick 循环钉死（实测真墙上就是这一族：150 秒后被看门狗强行放锁）。
    _waitForCaptchaImage: function (img, ms) {
      return new Promise(function (resolve) {
        var settled = false;
        function fin(ok) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { img.removeEventListener('load', onLoad); img.removeEventListener('error', onErr); } catch (e) {}
          resolve(!!ok);
        }
        function onLoad() { fin((img.naturalWidth || 0) > 0); }
        function onErr() { fin(false); }
        var timer = setTimeout(function () { fin(false); }, ms || 2500);
        try {
          if (img.complete && (img.naturalWidth || 0) > 0) { fin(true); return; }
          img.addEventListener('load', onLoad);
          img.addEventListener('error', onErr);
        } catch (e3) { fin(false); }
      });
    },


    _cleanCaptchaCode: function (raw) {
      var text = String(raw || '');
      var quoted = text.match(/[「『“"]([^」』”"]{1,24})[」』”"]/);
      if (quoted && quoted[1]) text = quoted[1];
      var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length) text = lines[lines.length - 1];
      text = text.replace(/^.*?(?:答案|结果|验证码|code|result)\s*[:：]\s*/i, '');
      text = text.replace(/[\s"'`~!@#$%^&*()（）\-_=+\[\]【】{}\\|;:;,.，。、：；！？·…<>《》/?？]+/g, '');
      // 超过 8 个字符就不是验证码的形状（超星是 4 位，见过的站点最多 6 位），别当答案交上去。
      // 这条是实测逼出来的：deepseek-flash 没看清图时回「图中没有可识别的验证码字符。」，
      // 旧写法剥掉句号后正好剩 12 个汉字、卡在旧的「截断到 12」以内，于是那句人话被填进输入框
      // 并按了提交 —— 一次尝试白废，还把汉字塞进了站方的校验接口。
      // 旧的截断到 12 一并删掉：超过 8 一律不收，那一行永远走不到（留着就是死代码）。
      // 为什么不用「只认字母数字」：libs/prompt.js 的 CAPTCHA_PROMPT 明写「可能含汉字」，
      // 那样会把汉字验证码这一族整个判死。形状（长度）才是两者都不得罪的判据。
      if (text.length > 8) return '';
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


    // 返回「这一下到底是怎么提交的」，调用方要把它写进日志。
    // 以前这个函数什么都不返回、日志只写一句 code submitted —— 于是「一次都没提交成功」
    // 和「提交成功了但码不对」在日志里长得一模一样（实测真墙就是被这个盲区埋了整整几轮）。
    _clickCaptchaSubmit: function (captcha) {
      var doc = captcha.input.ownerDocument || document;
      var button = null;
      try { button = doc.querySelector('#sub'); } catch (e0) {}
      if (button) {
        try { button.click(); return 'sub-id'; } catch (e1) {}
      }
      // 实测真墙（【9010】那面）的因果链是这样的：`_detectStandaloneCaptcha` 把 dialog 写成
      // `document.body`，所以这道扫描**确实跑了**、也**确实扫到了**那个
      // `input[type=submit][value=提交]` —— 但按钮的文本是用 `textOf()` 读的，
      // 而 `textOf` 只认 innerText 和子节点，对 `<input>` 永远返回空串（input 没有子节点）。
      // 于是 `/^提交/` 判不上、button 留空，最后只剩那条「派发一个合成 Enter」——
      // 而合成 KeyboardEvent 不激活原生表单提交。结果：码认对了、也填进 #ucode 了、
      // 日志写着 code submitted，页面却一次都没被提交过
      // —— 墙不过、任务点一直 captcha-not-cleared、整节被按住。
      // 修法就是读标签时把 `el.value` 算进去；范围也一并放宽：独立页没有真正的弹层容器，
      // 但只认**显式声明的提交控件**（input/button[type=submit]），
      // 这样够得着墙上的「提交」，又不会在课程页里误点到别的「提交」。
      var sel = captcha.dialog ? 'button, input[type="submit"], input[type="button"], a, [role="button"]'
                               : 'input[type="submit"], button[type="submit"]';
      var root = captcha.dialog || doc;
      try {
        var candidates = root.querySelectorAll(sel);
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          if (!el.offsetWidth && !el.offsetHeight) continue;   // 看不见的按钮不算
          var label = String(textOf(el) || el.value || '').trim();
          if (/^(确定|提交|验证|确认|立即验证|OK)/.test(label)) { button = el; break; }
        }
      } catch (e6) {}
      if (button) {
        try { button.click(); return captcha.dialog ? 'dialog-button' : 'submit-input'; } catch (e7) {}
      }
      // 再退一步：能走原生表单提交就走它（requestSubmit 会真提交，dispatchEvent 不会）
      try {
        var form = captcha.input.form ||
          (captcha.img && captcha.img.closest && captcha.img.closest('form'));
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return 'form-requestSubmit';
        }
      } catch (e8) {}
      // 最后才是模拟回车：它对绑了 keydown 的老页面仍然有用，但不能当成「已经提交了」
      try {
        var win = doc.defaultView || window;
        captcha.input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        captcha.input.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'enter-key';
      } catch (e2) {}
      return 'nothing';
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

    /**
     * 页面内验证码弹窗实在过不去时刷新整页 —— 批次 36-A：**刷新要记账**。
     *
     * 旧写法只刷不记：`location.reload()` 顺手把 `_captchaAttempts` / `_captchaFailCount`
     * 一起抹掉（它们是页面内存里的字段），于是「3 次识别 → 刷新 → 再来 3 次」是**真的无限**，
     * 而每一次识别都是一发看图请求、真金白银。挂着刷课整夜跑就在这条路上烧钱。
     *
     * 口径与 14-A（整页验证码墙）、批次 35（跨域中间页）完全一致：
     * 账记 sessionStorage、换页（href 变了）即作废、连续 3 轮刷新仍过不去就停手 30 分钟；
     * 停手期间连识别都不发（见 `_handleCaptchaDialog` 顶上那道闸）。
     */
    _captchaReload: function () {
      var budget = this._readCaptchaDialogBudget();
      var rounds = budget.rounds + 1;
      if (rounds >= 3) {
        this._writeCaptchaDialogBudget(rounds, Date.now() + 30 * 60000, String(location.href || ''));
        emitRuntimeLog('error', 'captcha dialog unsolved after 3 page reloads, stop spending', {
          rounds: rounds,
          resumeInMs: 30 * 60000,
          hint: '不再刷新这一页，也不再发识别请求 —— 每一次刷新与识别都是再花一次钱、再向站方要一张新验证码。' +
            '这一步请你在页面上亲手输入一次验证码；想让插件自己过，去设置里把「验证码识别模型」填成会看图的模型' +
            '（如 qwen-vl-max / gemini-2.5-flash / gpt-4o-mini）'
        });
        return;
      }
      this._writeCaptchaDialogBudget(rounds, 0, String(location.href || ''));
      emitRuntimeLog('warn', 'captcha unsolved, reload page', { round: rounds });
      this._reloadCaptchaDialogPage();
    },


    // 刷新单独抽出来，是为了让测试能盯住这个动作本身（与 `_reloadForStandaloneCaptcha` 同一条理由）：
    // 真刷一次整页会打断后面几步，而这一步是这一面墙上最贵的动作。
    _reloadCaptchaDialogPage: function () {
      try { window.location.reload(); } catch (e) {}
    },


    // 批次 36-A：弹窗验证码的刷新轮次。`rounds` = 这一页已经为同一个弹窗刷新过几次。
    // `href` 变了 = 换了另一面墙（翻章 / 换课），旧账作废。
    _readCaptchaDialogBudget: function () {
      var obj = this._readSessionLedger('omitone:captcha-dialog-budget') || {};
      if (obj.href && obj.href !== String(location.href || '')) return { rounds: 0, pauseUntil: 0 };
      return { rounds: Number(obj.rounds) || 0, pauseUntil: Number(obj.pauseUntil) || 0 };
    },


    _writeCaptchaDialogBudget: function (rounds, pauseUntil, href) {
      this._writeSessionLedger('omitone:captcha-dialog-budget',
        { rounds: rounds || 0, pauseUntil: pauseUntil || 0, href: href || '' });
    },


    /**
     * 弹窗**真的消失了**（连续 60 秒没再检测到）就把账清零 —— 条件愈合必须清账。
     *
     * 不清的话：这一章曾经卡住过一次，下一章新弹的验证码（同一份文档里 href 可能没变）
     * 会被 30 分钟前的旧账直接跳过，用户只会看到"这个验证码它不理"。
     * 要"连续"而不是"一次没看到"：检测有抖动，一次漏看就把账清掉等于把安全阀拆了
     * （清完下一次调用就又能发一发付费识别）。
     */
    _healCaptchaDialogBudget: function (present) {
      if (present) {
        this._captchaDialogAbsentAt = 0;
        return;
      }
      var now = Date.now();
      if (!this._captchaDialogAbsentAt) {
        this._captchaDialogAbsentAt = now;
        return;
      }
      if (now - this._captchaDialogAbsentAt < 60000) return;
      this._captchaDialogAbsentAt = now;
      var budget = this._readCaptchaDialogBudget();
      if (!budget.rounds && !budget.pauseUntil) return;
      this._writeCaptchaDialogBudget(0, 0, '');
      this._captchaDialogPauseLogged = false;
      emitRuntimeLog('info', 'captcha dialog gone, retry budget reset', {
        hadRounds: budget.rounds,
        hadPauseUntil: budget.pauseUntil
      });
    },


    // ===== 独立验证码页：验证码不在学习通界面内，而是一个独立网址 / 弹出窗口 / 被跳转到的验证页 =====
    // 这类页面是顶层页面（不是跨域 iframe），插件可以完整访问 DOM，因此完全可以自动识别并填写。
    _recognizeCaptchaImage: async function (img) {
      // 图还没解码完就截图，截到的是一张**空白**，而这一发是真金白银：
      // 实测真墙第一次尝试模型只能回「图中没有可识别的验证码字符」，第二次起才是真码。
      // 先等解码（带超时，不许白等），等不出来就不拿空白去问模型 —— 改走按地址取图。
      if (!(img.naturalWidth > 0)) await this._waitForCaptchaImage(img, 2500);
      var dataUrl = this._captureCaptchaImage(img);
      if (!(img.naturalWidth > 0)) dataUrl = '';
      if (!dataUrl) {
        var absUrl = this._resolveImageUrl(img);
        if (absUrl) {
          try {
            var fetched = await bridgeSend('fetch_image', { url: absUrl });
            if (fetched && fetched.success && fetched.dataUrl) dataUrl = fetched.dataUrl;
          } catch (e0) {}
        }
      }
      // 自己这一侧的失败串一律说中文：下面那道「结构性失败」判据认的是厂商的英文说法，
      // 而旧串 'captcha image capture failed' 里的 image 会把它误判成「模型没有看图能力」，
      // 于是停手 15 分钟并让用户去做一件完全无关的事（去设置里换看图模型）。
      if (!dataUrl) return { ok: false, error: '验证码的图还没加载完，或画布被跨域挡住（这次没有请求模型）' };

      var result = await bridgeSend('llm_captcha', { image: dataUrl });
      if (!result || !result.success) {
        return { ok: false, error: String((result && result.error) || '桥接没回话（扩展可能刚重新加载过，刷新页面即可）').slice(0, 200) };
      }
      var code = this._cleanCaptchaCode(result.data);
      if (!code) return { ok: false, error: '模型回的不是一个验证码形状', raw: String(result.data || '').slice(0, 60) };
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
        // 「这一页是课程页、不是独立验证码页」的凭据。⚠️ 这里原来还并着
        // `_quizDetectorSelector` —— 那串通用类名（`.question-content` 等）在课件与
        // 文档页里也会出现，于是普通课件页被误认成课程页、验证码永远轮不到处理。
        // 判据换成「这页真抠得出题」，见 `_documentHasQuiz`。
        if (document.querySelector('#video, #audio, .swiper-container, .ans-attach')) return false;
        if (this._documentHasQuiz(document)) return false;
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
      var budget = this._readStandaloneCaptchaBudget();
      var nowMs = Date.now();
      if (budget.pauseUntil > nowMs) {
        // 停手期间连识别都不发 —— 识别要请求、刷新也要请求，
        // 而每一次请求都是让站方把这面墙坐实的理由
        if (!this._standaloneCaptchaPauseLogged) {
          this._standaloneCaptchaPauseLogged = true;
          emitRuntimeLog('warn', 'standalone captcha paused, waiting for a human', {
            resumeInMs: budget.pauseUntil - nowMs,
            hint: '这一步请你在页面上亲手输入一次验证码。想让它自己过：在设置里把「验证码识别模型」或「看图模型」填成会看图的模型（如 qwen-vl-max / gemini-2.5-flash / gpt-4o-mini）'
          });
        }
        return;
      }
      if (budget.pauseUntil) {
        this._writeStandaloneCaptchaBudget(0, 0, '');
        this._standaloneCaptchaPauseLogged = false;
        budget = { cycles: 0, pauseUntil: 0 };
        emitRuntimeLog('info', 'standalone captcha resume retry', { hint: '冷却到点，再给一轮机会' });
      }
      this._captchaBusy = true;
      emitRuntimeLog('warn', 'standalone captcha page detected, solving', {
        url: String(location.href || '').slice(0, 120),
        cycle: budget.cycles + 1
      });
      try {
        if (this.configs.enableCaptcha === false) {
          emitRuntimeLog('info', 'captcha handling disabled by switch', {});
          return;
        }
        var structural = '', structReason = '';
        for (var attempt = 1; attempt <= 4; attempt++) {
          var captcha = this._detectStandaloneCaptcha();
          if (!captcha) {
            this._writeStandaloneCaptchaBudget(0, 0, '');
            emitRuntimeLog('info', 'standalone captcha elements gone, nothing to solve', {});
            return;
          }
          var rec = await this._recognizeCaptchaImage(captcha.img);
          if (rec.ok) {
            this._fillCaptchaInput(captcha, rec.code);
            await sleep(300);
            // via 是这里唯一的凭据：没有它，「点了提交」与「压根没按钮可点」在日志里同形
            var via = String(this._clickCaptchaSubmit(captcha) || 'nothing');
            emitRuntimeLog('info', 'standalone captcha code submitted', {
              attempt: attempt, length: rec.code.length, via: via
            });
          } else {
            emitRuntimeLog('error', 'captcha recognize failed', {
              attempt: attempt,
              error: String(rec.error || '').slice(0, 160)
            });
            // 「看不懂图」与「思考把输出预算占满」都是结构性失败：同一份配置再跑 3 次
            // 只是把同样的钱再花 3 遍 —— 当场收手。但**两者的出路完全不同**，
            // 混成一个 reason 就等于把用户支到另一条不相干的路上（见 14-B④ 的同一个坑）。
            // ⚠️ 判据只认**厂商侧**的说法。以前里面混着 `image` 和 `empty`，
            // 而我们自己那一侧的失败串正好叫 'captcha image capture failed'、
            // 'empty code after clean' —— 于是图没加载完、模型回了一句人话，全被误判成
            // 「这个模型没有看图能力」：实测真墙因此停手 15 分钟，还让用户去设置里
            // 换「看图模型」（那是完全无关的一条路）。自己这边的失败串从此说中文。
            var errText = String(rec.error || '');
            if (/not support|unsupported|multimodal|vision|不支持|空回复|看图/i.test(errText)) {
              structural = errText.slice(0, 120);
              // 结束原因 length = 思考 token 把 max_tokens 吃光（厂商确实看见图了），
              // 该调的是「思考强度」，不是模型
              structReason = /结束原因 length|思考把输出的预算占满/.test(errText) ? 'thinkingBudgetFull' : 'noVisionModel';
              break;
            }
          }

          await sleep(2600);
          this._standaloneCaptchaAt = 0; // 强制重新判定，不受节流影响
          if (!this._isStandaloneCaptchaPage()) {
            this._writeStandaloneCaptchaBudget(0, 0, '');
            emitRuntimeLog('info', 'standalone captcha solved', {});
            this._afterStandaloneCaptchaSolved();
            return;
          }
          try { captcha.img.click(); } catch (e2) {} // 识别错/过期就换一张
          await sleep(700);
        }
        var cycles = budget.cycles + 1;
        if (structural || cycles >= 2) {
          var pauseMs = structural ? 15 * 60000 : 10 * 60000;
          var pauseUntil = Date.now() + pauseMs;
          this._writeStandaloneCaptchaBudget(cycles, pauseUntil, String(location.href || ''));
          emitRuntimeLog('error', 'standalone captcha stopped, needs a human', {
            cycles: cycles,
            reason: structural ? structReason : 'twoCyclesUnsolved',
            error: structural,
            resumeInMs: pauseMs,
            hint: '不再刷新这一页（每刷新一次就是再向站方要一张新验证码，账号会被扣得更紧）。' +
              '请亲手在页面上输入一次验证码；' +
              (structReason === 'thinkingBudgetFull'
                ? '这一条不是模型看不懂图 —— 是思考把输出的预算占满了。把设置里的「思考强度」调到关闭（或换不带思考的模型），再回来点一次即可。'
                : '想让插件自己过，请在设置里把「验证码识别模型」或「看图模型」填成会看图的模型（如 qwen-vl-max / gemini-2.5-flash / gpt-4o-mini）')
          });
          return;
        }
        this._writeStandaloneCaptchaBudget(cycles, 0, String(location.href || ''));
        emitRuntimeLog('warn', 'standalone captcha unsolved after retries, reload page', { cycle: cycles });
        this._reloadForStandaloneCaptcha();
      } finally {
        this._captchaBusy = false;
      }
    },


    // 刷新单独抽出来，是为了让测试能盯住这个动作本身 —— 它是这一面墙上最贵的一步
    _reloadForStandaloneCaptcha: function () {
      try { window.location.reload(); } catch (e) {}
    },


    // 14-A：验证码墙的预算记在 sessionStorage 而不是内存里。
    // 旧写法每轮末尾无条件 `location.reload()`，页面一刷内存计数全清零 ——
    // 于是「4 次识别 → 刷新 → 再来 4 次」是**真的无限**（实测在真页面上整夜跑）。
    // sessionStorage 活得比刷新久、又比标签页短，正好是这里要的粒度。
    // 批次 36：读写都走 `_readSessionLedger` / `_writeSessionLedger` ——
    // 那对底座管住了「sessionStorage 抛异常被当成没账」这个漏洞（见 20-dom.js）。
    // `href` 变了 = 换了一面墙，旧账作废。
    _readStandaloneCaptchaBudget: function () {
      var obj = this._readSessionLedger('omitone:standalone-captcha-budget') || {};
      if (obj.href && obj.href !== String(location.href || '')) return { cycles: 0, pauseUntil: 0 };
      return { cycles: Number(obj.cycles) || 0, pauseUntil: Number(obj.pauseUntil) || 0 };
    },


    _writeStandaloneCaptchaBudget: function (cycles, pauseUntil, href) {
      this._writeSessionLedger('omitone:standalone-captcha-budget',
        { cycles: cycles || 0, pauseUntil: pauseUntil || 0, href: href || '' });
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
      /**
       * 批次 36-A：停手期间连取图、连识别都不发 —— 与整页验证码墙同一道闸。
       *
       * 位置必须在 `_captchaBusy = true` 之后、**任何动作之前**：下面每一个分支都是
       * 一发付费请求（`fetch_image` / `llm_captcha`），而旧写法只靠内存里的
       * attempts / failCount 计数 —— 那两个字段会被它自己触发的 `location.reload()`
       * 抹掉，所以那道"3 次就收手"的闸实际上从来没关上过。
       */
      var dialogBudget = this._readCaptchaDialogBudget();
      var nowMs = Date.now();
      if (dialogBudget.pauseUntil > nowMs) {
        if (!this._captchaDialogPauseLogged) {
          this._captchaDialogPauseLogged = true;
          emitRuntimeLog('warn', 'captcha dialog paused, waiting for a human', {
            rounds: dialogBudget.rounds,
            resumeInMs: dialogBudget.pauseUntil - nowMs,
            hint: '同一个弹窗已经刷新过 3 轮还是过不去，插件停手 30 分钟：' +
              '这期间不再发识别请求、也不再刷新页面。请亲手在页面上输入一次验证码'
          });
        }
        // 别让「插件自己不想再试」继续冒充「页面正被验证码挡着」：
        // `_captchaActive` 是媒体播放与任务点推进的闸门，人手动关掉弹窗后它不该还亮着
        this._captchaActive = false;
        return;
      }
      if (dialogBudget.pauseUntil) {
        this._writeCaptchaDialogBudget(0, 0, '');
        this._captchaDialogPauseLogged = false;
        emitRuntimeLog('info', 'captcha dialog resume retry', { hint: '冷却到点，再给一轮机会' });
      }
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
            this._writeCaptchaDialogBudget(0, 0, '');
            this._captchaDialogPauseLogged = false;
            return;
          }
        }

        var stillThere = this._captchaStillOpen();
        if (!stillThere) {
          emitRuntimeLog('info', 'captcha solved, continue', {});
          this._captchaAttempts = 0;
          this._captchaFailCount = 0;
          this._captchaActive = false;
          this._writeCaptchaDialogBudget(0, 0, '');
          this._captchaDialogPauseLogged = false;
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

    _detectPageChange: function () {
      var frame = this._getMainFrame();
      var raw = frame ? (frame.src || '') : location.href;
      var match = raw.match(/(?:knowledgeid|chapterId)=([^&]+)/i);
      var key = match ? match[1] : raw;
      // 「这一节的目录项被认出来多久了」—— 批次 20-I。
      // 原先 `_chapterChangedAt` 只由 `_resetRuntimeState()` 写，也就是**只有换过章节**才有值，
      // 首次进页面时它是 0。而"帧还没渲染"这个窗口第一次加载时同样存在，
      // 所以这里把**首次认出章节号**也算一次变更（判据见 `_isCurrentCompleted` 末段）。
      var isNewKey = !this._lastChapterKey || this._lastChapterKey !== key;
      if (this._lastChapterKey && this._lastChapterKey !== key) {
        this._resetRuntimeState();
        this._lastLearningCardKey = '';
        this._initCellData();
        console.log('%c[Omitone] chapter changed', 'color:#2196F3');
        emitRuntimeLog('info', 'chapter changed');
      }
      this._lastChapterKey = key;
      if (isNewKey) this._chapterChangedAt = Date.now();
      this._detectLearningCardChange();
    },

    _isCurrentCompleted: function () {
      this._completionEvidence = '';
      if (this._isActiveMediaPending('completion-check')) return false;
      // ⚠️ 批次 10-C：上一轮扫描里若有一帧「有作答框、命中题形容器、却一题没抠出来」，
      //   **这一刻不许宣称整节完成** —— 那一族形状就是真实日志里 00:46:04 的第二份卷子，
      //   重载之后它当场答成 3 题。窗口是有界的（每张卡片一个，见 `_maybeHoldSkipForUnparsedQuiz`），
      //   过期后照旧推进，所以这里买的不是"永久停摆"，是"别把还没长出来的卷子读成已经做完"。
      if (this._quizParseRetryUntil > Date.now()) return false;

      var mainDoc = this._getMainDocument();
      // ⚠️ 判据顺序：**先问「页面上还有没有没做完的可见任务点」，再认「任务点已完成」那句文案**。
      // 原先文案那条排在最前面，而它是**页面级**的：一张卡片里挂两份测验时，
      // 刚交完的那一份就会把这句话渲染出来，另一份还挂在页面上一个字没答。
      // 于是第一份交完 1 秒就 `skip completed` + 点「下一节」，第二份被整节翻过去
      //（2026-11-10 真实日志：19:12:17 `quiz submit finished` → 19:12:18 `skip completed`，
      //  此后整段再没有任何答题记录 = 用户报的「第一次遇到题目过了，第二次不答题」）。
      // 反过来「跳过」是不可逆的、而「多等一轮」只是慢一点，所以这里必须让
      // **未完成任务点的证据压过一句文案**。
      var state = this._getVisibleTaskCompletionState();
      if (state.hasTasks && !state.allFinished) return false;

      try {
        if (mainDoc && /任务点已完成/.test(textOf(mainDoc.body))) {
          this._completionEvidence = 'text-marker';
          return true;
        }
      } catch (e0) {}

      if (state.hasTasks) {
        // ⚠️ 批次 38：走到这里靠的是一份 **absence 证据**（"这一页此刻没认出没做完的框"），
        //   而目录那一项上写着「N个待完成任务点」是一份**正面证据**。让正面证据先按住它一会儿
        //   —— 有界、一张卡片一次，用完照旧放行（判据与实测账见 `_maybeHoldSkipForCatalog`）。
        if (this._maybeHoldSkipForCatalog()) return false;
        this._completionEvidence = 'all-tasks-finished';
        return true;
      }

      // ⚠️ 批次 20-I：下面这四行原判据，是拿用户**正在刷的那门课**（163 个目录项）量出来的，
      //   量到的三条和注释里想的意思相反：
      //   ① 现场只有两种标记，各带一句人话：
      //        `<span class="icon_Completed prevTips">…已完成…</span>`（83 项）
      //        `<span class="catalog_points_yi prevTips">…N个待完成任务点…</span>`（57 项）
      //      `.catalog_points_er` / `.catalog_points_san` 在这门课**一个都没出现**。
      //      原第 94 行把 `catalog_points_yi` 和 `icon_Completed` **并列**当成"这一节已完成"的证据 ——
      //      可 yi 那句文案就是「还有 N 个待完成任务点」，语义正好反。
      //      今天没酿成事故纯属侥幸：`_hasTaskPoint()` 里「目录带 yi 就算有任务点」把它的返回值
      //      兜成 true，末行 `!this._hasTaskPoint()` 于是过不去。**同一个 class 在同一个文件里
      //      被两处读出相反含义**，改哪一处都会把另一处拆掉 —— 现在两处统一口径：
      //      `catalog_points_*` 一律算"还没做完"（那边也一起改了）。
      //   ② 目录项的 id 是 `cur<chapterId>`（140/163 是这个形状），稳态下它与 `.posCatalog_active`
      //      **是同一个元素**；但 active 那一下是平台自己的脚本挪的，而 `_detectPageChange` 读主帧
      //      `src`，**当场就变**。真日志：`chapter changed` 与 `skip completed {by:"catalog-marker",
      //      tasks:0}` 同一秒 —— 认 active 等于允许拿**上一节**的"已完成"给刚切过来的这一节发证。
      //   ③ 平台还留了一份机器可读的正面否决：`<input type="hidden" class="jobUnfinishCount" value="N">`
      //      （现场 57 项带它，值 1~6，与 yi 标记的 N 一致）。N>0 说的是"这一节还有事"，
      //      比"这一瞬间页面里没认出任务点"这种 absence 证据硬。
      // 两道窗口也不许越过：帧自己说还在加载（批次 19-B）时不认目录；章节号刚认出来的
      // 发现窗口内不认目录 —— 目录图标是页面级的，它"显示已完成"时那一节可能还一个字没渲染。
      // 成本是有界的：`_taskDiscoveryWindowMs(0)` = 10 秒，过完照旧推进；
      // 真没任务点的空节由 `_tryAdvanceIdleSection` 那条（自带 30 秒窗和 `study stuck` 日志）接手。
      if (this._taskFrameLoadingUntil > Date.now()) return false;
      if (!this._chapterChangedAt ||
          Date.now() - this._chapterChangedAt < this._taskDiscoveryWindowMs(0)) return false;

      var catalogItem = this._catalogItemForChapter();
      if (!catalogItem) return false;
      if (this._catalogUnfinishedCount(catalogItem) > 0) return false;
      if (catalogItem.querySelector('[class*="catalog_points"]')) return false;
      if (!catalogItem.querySelector('.icon_Completed, .icon_completed')) return false;

      if (this._detectQuiz()) return false;

      var currentVideo = this._getVideoEl();
      if (currentVideo && !currentVideo.ended) return false;

      if (!this._hasTaskPoint()) {
        this._completionEvidence = 'catalog-marker';
        return true;
      }
      return false;
    },

    /**
     * 「这一节的目录项是哪一颗」—— 批次 20-I。
     *
     * 优先按章节号认（现场形状 `id="cur9000049294"`），拿不到章节号或目录里没有这颗时才退回
     * `.posCatalog_active`。退回那一支必须留着：OCS / 移动端布局下目录结构不一样，
     * 而 `_getCurrentChapterId()` 也可能只认得到一个 URL 兜底键。
     */
    _catalogItemForChapter: function () {
      var cid = '';
      try { cid = String(this._getCurrentChapterId() || ''); } catch (eCid) { cid = ''; }
      if (/^\d+$/.test(cid)) {
        try {
          var byId = document.getElementById('cur' + cid);
          if (byId) return byId;
        } catch (eById) {}
      }
      try {
        return document.querySelector('.posCatalog_select.posCatalog_active, .posCatalog_active');
      } catch (eAct) { return null; }
    },

    /**
     * 目录项上的「还有几个任务点没做」（`input.jobUnfinishCount`）。
     * 拿不到返回 NaN —— 调用方一律用 `> 0` 判，NaN 走"没有这份证据"，不当否决也不当放行。
     * ⚠️ 那颗 input **自己就是直接子节点**，`querySelector('.jobUnfinishCount')` 能找到它，
     *    但对 `<input>` 取文字的那套（`textOf()`/`innerText`）永远拿不到值（批次 14-B 同一族坑），
     *    所以这里只读 `.value`。
     */
    _catalogUnfinishedCount: function (item) {
      if (!item || !item.querySelector) return NaN;
      var n = null;
      try { n = item.querySelector('.jobUnfinishCount, input[name="jobUnfinishCount"]'); } catch (e) { return NaN; }
      if (!n) return NaN;
      var raw = String(n.value !== undefined && n.value !== null ? n.value : (n.getAttribute && n.getAttribute('value')) || '');
      var num = Number(raw.replace(/[^0-9]/g, ''));
      return raw === '' || isNaN(num) ? NaN : num;
    },

    _skipIfCompleted: function () {
      if (this.configs.restudy) {
        var now = Date.now();
        if (!this._restudySkipNoticeAt || now - this._restudySkipNoticeAt > 5000) {
          this._restudySkipNoticeAt = now;
          emitRuntimeLog('info', 'restudy enabled, skip-completed disabled');
        }
        return false;
      }
      if (!this._isCurrentCompleted()) return false;
      // ⚠️ 交卷结果还没回来时绝不跳章。实测（2026-11-10 日志）：
      // `skip completed` 与点「下一节」发生在同一秒，20 毫秒后才出现 `quiz submit finished`
      // —— 平台还没处理完提交，页面就被推走了，用户看到的就是「题没答/没交上」。
      // 等提交结束（或 quizSubmitWaitMs 超时）再走正常完成判定。
      if (this._quizSubmitPending) return false;
      if (this._switchToNextLearningCard('skip-completed')) return true;
      console.log('%c[Omitone] skip completed: ' + this._getCurrentTitle(), 'color:#FF9800');
      // 批次 11-B：这一句以前只有 `{title, by}` —— 用户问「怎么说已完成了？」时，
      // 日志本身答不上来。现在把**判成完成的当场依据**一起落盘（全部只读取证，判据没动）。
      emitRuntimeLog('info', 'skip completed', Object.assign(
        { title: this._getCurrentTitle(), by: this._completionEvidence || 'unknown' },
        this._skipCompletedEvidence()
      ));
      this._dismissPopups();
      this.nextUnit();
      return true;
    },

    _hasTaskPoint: function () {
      var frame = this._getMainFrame();
      if (!frame) {
        // 没有主帧（OCS / 移动端布局）：这一族的课程内容是直接挂在**顶层页**上的，
        // 所以把同一套判据改挂到 `document` 上探测，而不是"无脑 true / 无脑 false"。
        var bareHit = null;
        try {
          bareHit = document.querySelector(
            '.ans-job-icon, .ans-task-icon, .taskPoint, .ans-job-num, ' +
            '#panView, .fileBox, .pageNum, #pageNumber'
          );
        } catch (eBare) { bareHit = null; }
        if (bareHit) return true;

        var bareActive = this._catalogItemForChapter();
        // ⚠️ `catalog_points_*` 一整族的文案是「N个待完成任务点」（批次 20-I 现场量的），
        //    所以它在这儿算**有任务点** —— 与 `_isCurrentCompleted` 末段同一口径，不许反过来读。
        if (bareActive && bareActive.querySelector('[class*="catalog_points"]')) return true;
        if (bareActive && this._catalogUnfinishedCount(bareActive) > 0) return true;

        var bareText = '';
        try { bareText = textOf(document.body); } catch (eBareText) { bareText = ''; }
        if (bareText.indexOf('任务点') !== -1) return true;
        // 三种探测都没命中时**保守返回 true**（=「认不出就当有任务点」）。
        //
        // 为什么必须保守：这个返回值同时喂三条跳过出口 ——
        //   ① `_isCurrentCompleted()` 末行的 `return !this._hasTaskPoint()`
        //      → `_skipIfCompleted()` → `nextUnit()`，整节直接翻过去；
        //   ② `_runTick` 尾部的 `_isTextOnly() && !_hasTaskPoint()` 跳过分支；
        //   ③ 62-tasks-run.js `_locateDocumentTask` 的 `worthHandling(doc)`
        //      —— 判 false 就不接管文档任务，PDF.js / 翻页文档整族没人管。
        // 返回 false 的含义是**肯定的**「这一页没有任务点」，可我们其实什么都没认出来
        // （`_getMainFrame()` 为空时，任务点 markup 常在读不到的子帧 / 延迟渲染的容器里）。
        // 把"判不出"写成"没有"，就是静默跳过 —— 用户看到的「所有题目都被跳过」（2026-11-10）。
        //
        // 那空节谁来推进？不能靠这里 —— **空节的前进只允许走 `_tryAdvanceIdleSection`**，
        // 那条自带时间窗（`_idleEmptySince` 要连续空够时长）和日志（`study no runnable job`
        // 有节流），是"能解释、可恢复"的出口；本方法没有"观察了几秒"的概念，
        // 每一帧都是当场判断，一旦判错就是立刻跳走、无窗、无声。
        // 宁可慢一点、空转几秒有日志，也不能听见什么都没说就翻页。
        return true;
      }

      var doc = this._getMainDocument();
      if (!doc) return true;   // 主帧在、但跨域读不到 —— 必须保守

      var catalogItem = this._catalogItemForChapter();
      // 同上：`catalog_points_*` 与 `jobUnfinishCount>0` 都是平台在说"这一节还有任务点没做"。
      // 按章节号认（`#cur<chapterId>`），不认 `.posCatalog_active` —— 后者切章节时会慢半拍，
      // 拿上一节的标记给这一节作证就是这个函数最容易漏的一类误判。
      if (catalogItem && catalogItem.querySelector('[class*="catalog_points"]')) return true;
      if (catalogItem && this._catalogUnfinishedCount(catalogItem) > 0) return true;
      if (doc.querySelector('.ans-job-icon, .ans-task-icon, .taskPoint, .ans-job-num, [class*="task"], [class*="job"]')) return true;
      if (textOf(doc.body).indexOf('任务点') !== -1) return true;
      return false;
    },

    _classifyTaskFrame: function (frame) {
      if (!frame) return null;
      var src = String(frame.getAttribute("src") || frame.src || "");
      var shadowSrc = String(frame.getAttribute("_src") || "");
      var dataText = String(frame.getAttribute("data") || "");
      var frameClass = String(frame.className || "");
      var wrap = frame.parentElement;
      var wrapClass = String((wrap && wrap.className) || "");

      // 显式 "job":false 表示这不是任务点（老师没把它设为任务点）——
      // 直接跳过，别再靠类名去推断。与 _getAttachmentWorkType 同一条判据，
      // 来自开源实现 cxmooc-tools 的 CxTask（`if (taskinfo.job) ... else 视为已完成`）。
      // 不加这一道，"不被要求完成的视频"仍会被当成任务点反复处理。
      if (/"job"\s*:\s*false/i.test(dataText)) return null;

      var hasTaskMarker = !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]'));
      var explicitJob = !!frame.getAttribute('jobid') || /"job"\s*:\s*true|"isPassed"\s*:\s*false/i.test(dataText);
      var isTask = frameClass.indexOf("ans-attach") !== -1 ||
        frameClass.indexOf("insertvideo") !== -1 ||
        frameClass.indexOf("insertaudio") !== -1 ||
        frameClass.indexOf("insertdoc") !== -1 ||
        wrapClass.indexOf("ans-attach-ct") !== -1 ||
        !!(wrap && wrap.querySelector(".ans-job-icon"));
      if (!isTask) return null;

      var type = "other";
      var taskHint = [src, shadowSrc, dataText].join(" ");
      if (/api\/work|work\/do(Home)?Work|exam\/test|reVersionTestStartNew|selectWorkQuestion|workid|worktype|jobid\":\"work-|jobid=work-/i.test(taskHint)) type = "quiz";
      // insertaudio 是独立的音频任务点模块，早期只认 insertvideo，音频帧会被判成 other 而跳过
      else if (frameClass.indexOf("insertvideo") !== -1 || frameClass.indexOf("insertaudio") !== -1 || /video|audio|ananas\/modules\/(?:video|audio)/i.test(src)) type = "video";
      else if (frameClass.indexOf("insertdoc") !== -1 || /modules\/(?:doc|docx|ppt|pptx|pdf|innerbook)/i.test(src)) type = "document";

      var finished = false;
      if (wrap) {
        // ⚠️ 批次 20-I：这里原先还认 `.catalog_points_yi` 当"这个任务点已完成"。
        //   现场（用户正在刷的这门课，逐帧量过）：任务盒里**从来没有**这个 class ——
        //   它只长在**目录项**上，那句文案是「N个待完成任务点」，意思正好相反。
        //   留着它就是等哪天目录 DOM 挪进卡片、把没做完的任务点直接判成做完。
        finished = wrap.classList.contains("ans-job-finished") ||
          !!wrap.querySelector(".job-color, .ans-job-finished");
      }

      var doc = null;
      try {
        doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
        if (!finished && doc && doc.querySelector(".ans-job-finished, .job-color")) finished = true;
      } catch (e) {}

      return {
        frame: frame,
        wrap: wrap,
        doc: doc,
        src: src,
        shadowSrc: shadowSrc,
        dataText: dataText,
        type: type,
        finished: finished,
        hasTaskMarker: hasTaskMarker || explicitJob
      };
    },

    _collectVisibleTaskFrames: function () {
      var tasks = [];
      var doc = this._getMainDocument();
      if (!doc) return tasks;

      this._walkFrames(doc, function (frame) {
        var task = this._classifyTaskFrame(frame);
        if (!task) return;
        if (!visible(frame) && !(task.wrap && visible(task.wrap))) return;
        task.orderIndex = tasks.length;
        tasks.push(task);
      }.bind(this), 0);

      tasks.sort(function (a, b) {
        var markerDiff = Number(!!b.hasTaskMarker) - Number(!!a.hasTaskMarker);
        if (markerDiff) return markerDiff;
        return Number(a.orderIndex || 0) - Number(b.orderIndex || 0);
      });

      return tasks;
    },

    _getChaoxingAttachments: function () {
      var chapterId = this._getCurrentChapterId();
      var filterByChapter = function (attachments) {
        if (!attachments || !attachments.length || !chapterId) return attachments || [];
        var matched = attachments.filter(function (attachment) {
          var otherInfo = String((attachment && attachment.otherInfo) || '');
          var m = otherInfo.match(/nodeId_(\d+)/i);
          if (m && m[1]) return String(m[1]) === chapterId;
          return false;
        });
        return matched.length ? matched : attachments;
      };

      try {
        if (Array.isArray(window.attachments) && window.attachments.length) return filterByChapter(window.attachments);
      } catch (e) {}

      var mainWin = this._getMainWindow();
      try {
        if (mainWin && Array.isArray(mainWin.attachments) && mainWin.attachments.length) return filterByChapter(mainWin.attachments);
      } catch (e2) {}

      try {
        if (mainWin && mainWin.mArg && Array.isArray(mainWin.mArg.attachments) && mainWin.mArg.attachments.length) {
          return filterByChapter(mainWin.mArg.attachments);
        }
      } catch (e3) {}

      return [];
    },

    _getChaoxingFrameData: function (frame, win) {
      var direct = '';
      try { direct = frame ? (frame.getAttribute('data') || '') : ''; } catch (e) {}
      if (direct) return this._safeJsonParse(direct, {});

      try {
        var parentFrame = win && win.parent && win.parent.frameElement;
        if (parentFrame) {
          var parentData = parentFrame.getAttribute('data') || '';
          if (parentData) return this._safeJsonParse(parentData, {});
        }
      } catch (e2) {}

      return {};
    },

    /**
     * 沿**祖先帧链**找这个帧所属任务点的 jobid。
     *
     * 为什么必须有（现场故障，实测日志）：真实页面上「带 jobid 的帧」和
     * 「带题目（`.TiMu`）的帧」**不是同一个帧**，而是分在三层：
     *
     *   /ananas/modules/work/index.html?…          ← 有 data（jobid / _jobid），没有 .TiMu
     *     └─ /mooc-ans/api/work?api=1&workId=…     ← data 为【空】，也没有 .TiMu
     *          └─ /mooc-ans/work/doHomeWorkNew?…   ← 有 .TiMu（整卷题目），data 也是空
     *
     * `_searchChaoxingJobOcs` 只认「本帧自己的 `data`」，
     * 于是带 jobid 的那层被"没有 .TiMu"挡掉、有 .TiMu 的那层被"没有 jobid"挡掉 ——
     * **每一层都被 continue，一个任务点都匹配不到**。
     * 后果不是"报错"，而是它认为"本页没有任务点"→ `nextUnit()` 直接跳过整章，
     * 用户看到的就是「两个单元测试只做了第一个，第二个连试都没试」。
     *
     * 所以取不到本层 jobid 时，往上找——jobid 挂在祖先帧的 `data` 上。
     */
    _findJobIdInAncestorFrames: function (win) {
      try {
        var cur = win;
        for (var depth = 0; depth < 6 && cur; depth++) {
          var el = null;
          try { el = cur.frameElement; } catch (eFrame) { el = null; }
          if (!el) break;

          var id = '';
          try {
            id = String(el.getAttribute('jobid') || el.getAttribute('_jobid') || '');
            if (!id) {
              var parsed = this._safeJsonParse(el.getAttribute('data') || '', null);
              id = String((parsed && (parsed.jobid || parsed._jobid)) || '');
            }
          } catch (eAttr) {}
          if (id) return id;

          // 同一层容器上还可能挂着 jobid（任务点外层 `.ans-attach-ct` 常把 jobid
          // 写在 **div 上**而不是 iframe 的 data 里）。
          //
          // ⚠️ **必须先看容器自己。** 原先这里只写 `wrap.querySelector('[jobid]')` ——
          // 而 **`querySelector` 只找后代、永远返回不了 `wrap` 自己**，
          // 于是下面那个 `holder === wrap` 条件**不可达**：「jobid 在容器 div 上」
          // 这条路径**完全没生效**。
          // 实测（e2e 的 `/two-quizzes-divjob` 变体场景）：`ancestorJobId` 恒为空串 →
          // `_searchChaoxingJobOcs` 返回 null → **整章被静默跳过** ——
          // 与用户报过的「两个大题目只做第一个」症状一模一样。
          //
          // ⚠️ 这里必须**确认这个 jobid 属于我们这一帧**：只接受
          //   「容器自己」或「包含本帧的元素」，否则会在一个容器里塞了两个任务点时
          //   把**兄弟任务点的 jobid** 当成本帧的身份 —— 那会让插件去跑错的任务点，
          //   比"匹配不到"严重得多（匹配不到只是漏做，绑错是**做错**）。
          try {
            var wrap = el.parentElement;
            var holder = null;

            // ① 容器**自己**身上的 jobid / _jobid / data.jobid
            if (wrap && wrap.getAttribute) {
              var ownId = String(wrap.getAttribute('jobid') || wrap.getAttribute('_jobid') || '');
              if (!ownId) {
                var wrapData = this._safeJsonParse(wrap.getAttribute('data') || '', null);
                ownId = String((wrapData && (wrapData.jobid || wrapData._jobid)) || '');
              }
              if (ownId) holder = wrap;
            }

            // ② 容器**后代**里的 jobid 承载元素（要它包着本帧才算数）
            if (!holder && wrap && wrap.querySelector) {
              holder = wrap.querySelector('[jobid], [data*="jobid"]');
            }

            var belongsToThisFrame = !!holder && (holder === wrap || (holder.contains && holder.contains(el)));
            if (holder && holder !== el && belongsToThisFrame) {
              var hid = String(holder.getAttribute('jobid') || holder.getAttribute('_jobid') || '');
              if (!hid) {
                var hp = this._safeJsonParse(holder.getAttribute('data') || '', null);
                hid = String((hp && (hp.jobid || hp._jobid)) || '');
              }
              if (hid) return hid;
            }
          } catch (eWrap) {}

          try { cur = cur.parent; } catch (eUp) { break; }
        }
      } catch (e) {}
      return '';
    },

    _detectChaoxingJobElements: function (doc) {
      if (!doc || !doc.querySelector) return null;
      var videojs = doc.querySelector('#video, #audio, .video-js, #video_html5_api');
      // ⚠️ 「像题即题」的老判据（`doc.querySelector(_quizDetectorSelector)`）已换掉：
      //    那串类名里的 `.question-content` / `.answerOption` 在课件帧与文档帧里同样出现，
      //    于是一个轮盘 PPT 帧被判成 quiz、阅读链路永远轮不到（2026-11-10「刷 PPT 报废」）。
      //    现在问的是「这页真抠得出题、且题里有能填的控件」吗 —— 见 `_documentHasQuiz`。
      var quiz = this._documentHasQuiz(doc);
      // ⚠️ `quiz` 与 `quizLike` 是**两个不同的问题**，别合并：
      //   `quiz` = 「这帧是什么任务」（判类型，走 `_kindFromChaoxingElements` 那一份顺序）；
      //   `quizLike` = 「这帧值不值得进 jobid 匹配」（准入闸的弱信号，整页扫通用类名）。
      //   只留 `quiz` 那一个信号当闸会把**认不出作答控件的真卷子整帧拒掉** ——
      //   三层嵌套的卷子（jobid 在外层、`.TiMu` 在内层）就是这么被静默漏掉的形状，
      //   实测把 2026-10-17 那份故障夹具全线改红过（2026-11-10 批次 2）。
      //   准入闸宁可宽：判错类型的代价是"多看一眼"，判不进门的代价是"整章跳过"。
      var quizLike = !!doc.querySelector(this._quizDetectorSelector);
      // 投票封面（`ananas/modules/zt/vote`）：框里只有图标与标题，选项要在平台
      // 自己点开之后才出现在顶层 `#voteIframe` 里 —— 上面任何一条 DOM 信号都照不到它，
      // 于是整帧被准入闸拒掉、连 jobid 都不匹配（2026-11-11 真页实测）。
      var vote = !!doc.querySelector('.ans-cmp-iconVote');
      var read = doc.querySelector('#img.imglook, .imglook#img');
      var pptWithAudio = doc.querySelector('.swiper-container');
      var hyperlink = doc.querySelector('#hyperlink');
      var timereader = doc.querySelector('iframe[name="bookifame"][src*="timing"]');
      var documentJob = doc.querySelector('#panView, .fileBox, .pageNum, #docContainer, .docBox');

      if (!(videojs || quiz || quizLike || vote || read || pptWithAudio || hyperlink || timereader || documentJob)) return null;

      return {
        videojs: videojs,
        quiz: quiz,
        quizLike: quizLike,
        vote: vote,
        read: read,
        pptWithAudio: pptWithAudio,
        hyperlink: hyperlink,
        timereader: timereader,
        documentJob: documentJob
      };
    },

    _matchChaoxingAttachment: function (attachments, frameData) {
      if (!attachments || !attachments.length || !frameData) return null;
      var targetJobId = frameData.jobid || frameData._jobid;
      var targetObjectId = frameData.objectid || frameData.objectId;

      for (var i = 0; i < attachments.length; i++) {
        var attachment = attachments[i];
        if (!attachment) continue;
        var attachmentJobId = attachment.jobid || (attachment.property && attachment.property._jobid);
        if (targetJobId && attachmentJobId && String(targetJobId) === String(attachmentJobId)) {
          return attachment;
        }
        var attachmentObjectId = attachment.objectId || (attachment.property && attachment.property.objectid);
        if (!targetJobId && targetObjectId && attachmentObjectId && String(targetObjectId) === String(attachmentObjectId)) {
          return attachment;
        }
      }

      return null;
    },

    _getChaoxingJobName: function (attachment) {
      if (!attachment) return '未知任务点';
      var property = attachment.property || {};
      return property.name || property.title || (property.bookname ? property.bookname + (property.author || '') : '') || '未知任务点';
    },

    _getAttachmentWorkType: function (attachment) {
      if (!attachment) return 'not-job';

      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      // ⚠️ isPassed 必须排在 job 前面。
      // 两者同时为真（任务点已通过）时，如果先判 job 就会返回 'job'，
      // 调用点看到 'job' 就直接开跑 —— 于是**已经完成的任务点被重做一遍**，
      // 长视频尤其致命（等于白播一整遍）。返回 'finished' 才会被跳过，
      // 而"重学模式"（restudy）本来就会把 'finished' 也当作要重做。
      if (attachment.isPassed === true) return 'finished';
      if (attachment.job === true) return 'job';

      // ⚠️ 显式 job:false 必须在这里就返回，**不能**落到下面的"按模块名推断"。
      // 老师没把某个视频/文档设为任务点时，接口给的就是 job:false ——
      // 它和"字段缺失"是两件事，但我们旧代码一律继续往下推断成 job，
      // 结果就是去"完成"一个根本不需要完成的任务点，白白耗时间。
      //
      // 这条判据来自开源实现 cxmooc-tools（src/mooc/chaoxing/task.ts）：
      //   if (this.taskinfo.job) { this.done = false } else { this.done = true }
      // 即"没有 job 标记就当作已完成、不处理"。
      var jobFlag = attachment.job !== undefined ? attachment.job : property.job;
      if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
        return 'not-job';
      }

      // 到这里说明 job 字段缺失（超星部分接口确实不带），才允许按模块名推断。
      // 只列**确定是任务点**的模块，不要把 insertimage 加进来：
      // 图片大多是正文内容而非任务点，推断成任务点会让插件去"处理"一堆纯展示的图片。
      if (/insertdoc|insertvideo|insertaudio|work|exam|quiz|book|link/.test(module)) return 'job';
      // 扩展名要允许**不带前导点**：学习通的 property.type 常见写法是 "ppt"/"mp4" 而不是 ".ppt"，
      // 旧正则 `\.(ppt|…)$` 只认带点的写法，这两种任务点会被判成 not-job 直接漏掉。
      if (/(?:^|\.)(?:ppt|pptx|pdf|doc|docx|mp4|m3u8|avi|mp3|m4a|jpg|jpeg|png)$/.test(type)) return 'job';
      if (attachment.jobid || property.jobid || property._jobid || attachment.objectId || property.objectid) return 'job';

      return 'not-job';
    },

    /**
     * 附件元数据 → 任务类型。这份映射现在**只此一份**（`_buildAttachmentOnlyJob` 与
     * 任务类型仲裁 `_kindFromChaoxingElements` 共用）—— 以前它在附件构造里手写一遍、
     * 在 OCS 路由旁又各写一遍，改顺序时必然只改到其中一份。
     *
     * 返回空串 = 附件说不出这是什么任务，调用方据此回落到 DOM 判据。
     *
     * ⚠️ 这一族的粒度只到 `read`：`insertdoc` / ppt / pdf / doc / 图片在附件里都是
     *    「一个文档」，究竟是图片阅读、轮盘 PPT 还是翻页文档只有 DOM 知道 ——
     *    `_runChaoxingReadJob` 对这三种走**不同翻页器**，所以 read 家族的具体 flavour
     *    要留给 DOM 定（见 `_kindFromChaoxingElements` 的注释）。
     */
    _kindFromAttachment: function (attachment) {
      if (!attachment) return '';
      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      if (/insertdoc/.test(module) || /(?:^|\.)(?:ppt|pptx|pdf|doc|docx)$/.test(type)) return 'read';
      // 音频任务点走的是同一套媒体流程（_playChaoxingMediaJob 本身已支持 audio 元素），
      // 早期只认 insertvideo，insertaudio 会掉到「说不出」然后被整条丢弃
      if (/insertvideo|insertaudio/.test(module) || /(?:^|\.)(?:mp4|m3u8|avi|mp3|m4a)$/.test(type) || /video|audio/.test(type)) return 'video';
      // 投票任务点（2026-11-11 实测章节 9000049220 的唯一未完成点）：附件是
      // `module:"insertvote"` + `type:"vote"` + `job:true`。这里原先说不出类型，
      // 于是既不建 job、也不进「认不出」的那条去重日志之外的任何分支 ——
      // 整节只剩这一个未完成任务盒，「下一节」被平台拦下 → 去学习 → 回到同一章，
      // 表现为 study finished → next unit → 任务点未完成 的死循环。
      // ⚠️ 必须排在 work|exam|quiz 之前：投票页渲染出来的就是「答题」（有单选题），
      //    让 quiz 族先抢会把它送去接 AI 答题，而投票只要随手投一项。
      if (/insertvote/.test(module) || /^vote$/.test(type) || /(?:^|\/)vote(?:\/|$)/.test(type)) return 'vote';
      if (/work|exam|quiz/.test(module)) return 'quiz';
      // 图片任务点：打开看一眼即可，按「阅读」处理
      if (/insertimage/.test(module) || /^(?:image|jpg|jpeg|png|gif|webp)/.test(type)) return 'read';
      return '';
    },

    /**
     * 任务类型仲裁的**唯一一处顺序**（2026-11-10）。调用方拿到 kind 之后按 kind 分派，
     * 不许再各自按 `found.xxx` / `elements.xxx` 布尔位重排一遍 ——
     * 仲裁与路由留两份顺序，下一次改顺序必然只改到其中一份。
     *
     * 顺序（固定）：
     *   ① 附件元数据 —— 「这个任务点是什么」的权威来源。卷子常常渲染在
     *      本帧抠不到题的那一层（三层嵌套的 jobid 场景），只有附件说得出 quiz；
     *   ②..⑧ DOM，从最具体到最兜底：
     *      videojs → quiz → vote → read → ppt-audio → timereader → hyperlink → document。
     *      （`document` 是兜底，绝不能排在 ppt/timereader 之前 —— 它那些类名太通用。）
     *
     * 唯一的例外是 read 家族：附件那份映射只说得出 `read`，分不清图片阅读 /
     * 轮盘 PPT / 翻页文档，而这三种在 `_runChaoxingReadJob` 里走不同翻页器，
     * 所以 read 家族让 DOM 的具体 flavour 赢；跨家族（video / quiz）仍以附件为准。
     */
    _kindFromChaoxingElements: function (elements, attachment, doc) {
      var fromAttachment = this._kindFromAttachment(attachment);
      var fromDom = '';
      if (elements) {
        if (elements.videojs) fromDom = 'video';
        else if (elements.quiz) fromDom = 'quiz';
        else if (elements.vote) fromDom = 'vote';
        else if (elements.read) fromDom = 'read';
        else if (elements.pptWithAudio) fromDom = 'ppt-audio';
        else if (elements.timereader) fromDom = 'timereader';
        else if (elements.hyperlink) fromDom = 'hyperlink';
        else if (elements.documentJob || elements.pagedDoc) fromDom = 'document';
      } else if (doc) {
        // 调用方只给了文档、没有探测包：用**同一个**判据现算一次。
        // 顺序只留一份、判据也只留一份，别在调用方再手抄一遍 DOM 探测。
        if (this._documentHasQuiz(doc)) fromDom = 'quiz';
      }

      if (fromAttachment && fromAttachment !== 'read') return fromAttachment;
      return fromDom || fromAttachment || '';
    },

    _buildAttachmentOnlyJob: function (attachment) {
      if (!attachment) return null;
      var property = attachment.property || {};
      var module = String(property.module || attachment.module || '').toLowerCase();
      var type = String(property.type || attachment.type || '').toLowerCase();

      // 与 _getAttachmentWorkType 同一条判据：显式 job:false 表示老师没把它设为任务点。
      // 这里也必须挡一道 —— 否则调用方若没先过滤，仍然会造出一个"要去做"的任务。
      // ⚠️ 这道闸门留在本方法里，不进 `_kindFromAttachment`：映射只管「是什么」，
      //    「要不要做」不是它的职责（仲裁时 job:false 的附件同样要说得出类型）。
      var jobFlag = attachment.job !== undefined ? attachment.job : property.job;
      if (jobFlag === false || jobFlag === 0 || String(jobFlag).toLowerCase() === 'false') {
        return null;
      }

      var kind = this._kindFromAttachment(attachment);
      if (!kind) {
        // 讨论任务点说不出 kind 是设计如此（`insertbbs` 既不是视频也不是阅读/测验），
        // 它归讨论域那条独立 tick 链管 —— 原先这里和"真认不出类型"共用一句
        // 「unsupported task point type, skipped」，把"换了人做"报成"没人做"，
        // 而任务盒名字里没有「讨论」二字的那一族看起来就像被无声跳过了（批次 29，
        // 与准入闸「讨论任务点…由讨论链路处理」那条原因同一个口径）。
        if (this._isDiscussionAttachment(attachment)) {
          this._logDiscussionHandoffOnce(attachment);
          return null;
        }
        // 不要静默丢弃：任务点被无声跳过时，用户只能看到"这个任务点没做"，
        // 完全无从判断是识别失败还是不支持的题型。这里留一条去重日志。
        this._logUnsupportedJobOnce(module, type);
        return null;
      }

      return {
        frame: null,
        win: null,
        doc: null,
        attachment: attachment,
        kind: kind,
        workType: this._getAttachmentWorkType(attachment),
        name: this._getChaoxingJobName(attachment),
        jobid: attachment.jobid || property._jobid || property.jobid || '',
        objectid: attachment.objectId || property.objectid || '',
        hasTaskMarker: !!attachment.job,
        visible: true,
        synthetic: 'attachment'
      };
    },

    _resolveJobFrame: function (job) {
      if (!job) return job;
      if (job.frame && job.win && job.doc) return job;

      var targetJobId = String(job.jobid || (job.attachment && (job.attachment.jobid || (job.attachment.property && job.attachment.property._jobid))) || '');
      var targetObjectId = String(job.objectid || (job.attachment && (job.attachment.objectId || (job.attachment.property && job.attachment.property.objectid))) || '');
      var found = null;

      this._walkFrames(document, function (frame) {
        if (found) return;
        var win = null;
        var doc = null;
        try {
          win = frame.contentWindow || null;
          doc = frame.contentDocument || (win && win.document) || null;
        } catch (e) {}
        var frameData = this._getChaoxingFrameData(frame, win);
        var frameJobId = String(frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || '');
        // ⚠️ 和 `_findJobIdInAncestorFrames` **保持一致**：jobid 可能挂在任务点外层容器
        //    （`.ans-attach-ct`）上，只在本帧的 `data` / 属性里找会漏。
        //    漏的后果不是"匹配不到"，而是**匹配上了却反查不回帧** ——
        //    `_runChaoxingJob` 靠这里拿 `job.doc`，拿不到就"跑不起来"（e2e 变体场景实测）。
        if (!frameJobId && win) {
          try { frameJobId = String(this._findJobIdInAncestorFrames(win) || ''); } catch (eAnc) {}
        }
        var frameObjectId = String(frameData.objectid || frameData.objectId || frame.getAttribute('objectid') || '');

        if (targetJobId && frameJobId && targetJobId === frameJobId) {
          found = { frame: frame, win: win, doc: doc };
          return;
        }
        if (!targetJobId && targetObjectId && frameObjectId && targetObjectId === frameObjectId) {
          found = { frame: frame, win: win, doc: doc };
        }
      }.bind(this), 0);

      if (found) {
        job.frame = found.frame;
        job.win = found.win;
        job.doc = found.doc;
      }
      return job;
    },

    _isJobAlreadySearched: function (job, searchedJobs) {
      if (!job || !searchedJobs || !searchedJobs.length) return false;
      var mid = (job.attachment && job.attachment.property && job.attachment.property.mid) || '';
      var fingerprint = String(mid || job.jobid || job.name || '');
      if (!fingerprint) return false;
      return searchedJobs.some(function (item) {
        return String(item.mid || item.jobid || item.name || '') === fingerprint;
      });
    },

    _getAttachmentFingerprint: function (attachments) {
      if (!attachments || !attachments.length) return '';
      return attachments.map(function (attachment) {
        if (!attachment) return '';
        var property = attachment.property || {};
        return [
          attachment.jobid || property._jobid || property.jobid || '',
          attachment.mid || property.mid || '',
          attachment.objectId || property.objectid || '',
          property.name || ''
        ].join(':');
      }).join('|');
    },

    _buildSyntheticChaoxingJob: function (frame, win, doc, elements) {
      if (!frame || !elements) return null;
      var frameData = this._getChaoxingFrameData(frame, win);
      // 仲裁只走 `_kindFromChaoxingElements` 这一份顺序。这里没有附件可问 ——
      // 会落到「合成型任务」这条构造路径，正是因为附件清单里没匹配上它。
      var kind = this._kindFromChaoxingElements(elements, null, doc) || 'other';

      var wrap = frame.parentElement;
      // 批次 20-I：`.catalog_points_yi` 已从"已完成"判据里去掉 —— 它只长在目录项上、
      // 文案是「N个待完成任务点」（任务盒里现场量到 0 个），当完成证据是反的。
      var finished = !!(wrap && wrap.querySelector('.job-color, .ans-job-finished'));
      var name = frameData.name || frame.getAttribute('title') || this._getCurrentTitle() || '未知任务点';
      return {
        frame: frame,
        win: win,
        doc: doc,
        attachment: null,
        kind: kind,
        workType: finished ? 'finished' : 'job',
        name: name,
        jobid: frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || frame.src || '',
        hasTaskMarker: !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]')),
        visible: true
      };
    },

    _buildFrameFallbackJob: function (frame) {
      if (!frame) return null;
      var className = String(frame.className || '');
      var src = String(frame.getAttribute('src') || frame.src || '');
      var data = String(frame.getAttribute('data') || '');
      var wrap = frame.parentElement;

      var kind = '';
      if (/ans-insertvideo-online|insertvideo/i.test(className) || /modules\/video|modules\/audio|video|audio/i.test(src)) {
        kind = 'video';
      } else if (/insertdoc/i.test(className) || /pagenum|objectid|\.ppt|\.pptx|\.pdf|\.doc|\.docx/i.test(data + ' ' + src)) {
        kind = 'read';
      }
      if (!kind) return null;

      var frameWin = null;
      var frameDoc = null;
      try {
        frameWin = frame.contentWindow || null;
        frameDoc = frameWin && frameWin.document ? frameWin.document : null;
      } catch (e0) {}
      var frameData = this._getChaoxingFrameData(frame, frameWin);
      // 批次 20-I：`.catalog_points_yi` 已从"已完成"判据里去掉 —— 它只长在目录项上、
      // 文案是「N个待完成任务点」（任务盒里现场量到 0 个），当完成证据是反的。
      var finished = !!(wrap && wrap.querySelector('.job-color, .ans-job-finished'));
      return {
        frame: frame,
        win: frameWin,
        doc: frameDoc,
        attachment: null,
        kind: kind,
        workType: finished ? 'finished' : 'job',
        name: frameData.name || frame.getAttribute('title') || this._getCurrentTitle() || '未知任务点',
        jobid: frameData.jobid || frameData._jobid || frame.getAttribute('jobid') || frame.getAttribute('_jobid') || src,
        hasTaskMarker: !!(wrap && wrap.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]')),
        visible: true
      };
    },

    /**
     * 「这一帧为什么认不出类型」的紧凑签名 —— **批次 9-D 只取证，不改判据**。
     *
     * 为什么值得记：`javascript:` / `javascript:void(function(){document.open` 那一族帧
     * 在真实日志里每秒都被拒成同一句「认不出任务类型」，而它是「第一个做了、
     * 第二个又不做了」唯一可疑的现场。旧签名只有 src + 原因，**判不了那是空帧还是第二份卷子**，
     * 而凭这个去放宽类型判定，会连带把别的帧一起误收（正是用户警告过的"修一半、别的报废"）。
     *
     * 只在帧被拒时调用；整条 reject 日志本身有 30 秒 + 组合变化节流，允许多跑几次查询。
     * 每项都包异常 —— 跨域帧与 `document.open()` 写到一半的帧都可能直接抛。
     */
    // ⚠️ **这个对象要落进运行日志，所以里面只许出现字符串和数字。**
    // 真源：`runtime-log-store.js` 的 `cleanLogMeta` 从**第 4 层**起一律写成 `'[truncated]'`
    //   meta(0) → rejects(1) → 单条帧(2) → sig(3) → **sig 里的数组或对象 = 第 4 层** → 没了。
    // 批次 9 第一版把 `qHit` 写成「选择器 → 命中数」的**对象**，于是用户 2026-11-11 导出的
    // 真实日志里那条取证长这样：`"sig":{"answer":0,"frames":1,"qHit":"[truncated]","text":""}`
    // —— 取证字段自己不可读，等于白取证。**字符串只受 2000 字截断，数字原样保留**，
    // 所以前 5 个选择器的命中数按**位置**压成 `"1/0/0/3/0"`（`qHits`，用来定位是哪个类名命中的），
    // 总和 `qTotal` 则按**整份**清单的并集数（用来判"有没有题形"，见下面那段警告）。
    /**
     * 这一帧是不是**讨论模块**（`insertbbs` / `bbscircle`）—— 只用来把拒绝原因说准，
     * 不参与任何准入判定（批次 20-D）。
     *
     * 判据取三处，因为实测两种形状都出现过：模块自己就带 `module` 属性，
     * 或者属性在外层容器上、帧只留下 `/ananas/modules/insertbbs/index.html` 这个 src。
     * （讨论任务点的**真判据**只有一份，在讨论域的 `_findDiscussionModuleFrames`；
     * 这里只是给它配一句人能看懂的拒绝原因，不许在这里长出第二套讨论识别。）
     */
    _isDiscussionModuleFrame: function (frame) {
      if (!frame) return false;
      var mod = '';
      var src = '';
      try { mod = String(frame.getAttribute && frame.getAttribute('module') || ''); } catch (e0) {}
      try { src = String(frame.getAttribute && frame.getAttribute('src') || ''); } catch (e1) {}
      if (!mod) {
        // 属性挂在上层容器上时，往上最多找两层
        var box = frame.parentElement;
        for (var up = 0; up < 2 && box; up++) {
          try {
            mod = String(box.getAttribute && box.getAttribute('module') || '');
          } catch (e2) { mod = ''; }
          if (mod) break;
          box = box.parentElement;
        }
      }
      return /insertbbs|bbscircle|bbs|discuss/i.test(mod + ' ' + src);
    },


    /**
     * 这一帧是不是**投票封面**（`ananas/modules/zt/vote`）。
     *
     * 为什么单独问、不并进 `_kindFromAttachment`：附件那份映射已经认得出 insertvote，
     * 但 OCS 扫描的准入闸（`_searchChaoxingJobOcs`）在**匹配 jobid 之前**只看 DOM ——
     * 投票封面帧里既没有播放器也没有题形容器，那条闸当场把它拒了，附件根本没机会说话
     * （2026-11-11 真页实测：`rejects:[… "帧里认不出任务类型" src=/ananas/modules/zt/vote/…]`，
     * 而整节的未完成任务点就是它，于是 study finished → next unit → 「还有任务点未完成」死循环）。
     *
     * 判据只要一样就够：模块地址（帧自己说的），或封面那枚投票图标
     * `.ans-cmp-iconVote`（ananas 组件类名，别的模块没有）。
     */
    _isVoteCoverFrame: function (frame, doc) {
      var src = '';
      try { src = String(frame && (frame.getAttribute && frame.getAttribute('src') || frame.src) || ''); } catch (e0) { src = ''; }
      if (/ananas\/modules\/zt\/vote|\/zt\/vote\//.test(src)) return true;
      if (!doc || !doc.querySelector) return false;
      try { return !!doc.querySelector('.ans-cmp-iconVote'); } catch (e1) { return false; }
    },


    _frameRejectSignature: function (doc, found) {
      if (!doc) return { reach: 'no-doc' };
      var sig = {};
      var count = function (sel) {
        try { return doc.querySelectorAll(sel).length; } catch (e) { return -1; }
      };
      var fullText = '';
      try {
        fullText = String((doc.body && doc.body.innerText) || '').replace(/\s+/g, ' ').trim();
      } catch (eText) { fullText = ''; }
      // `text` 与 `textLen` 必须**两个都给**：只给片段时，「文本本来就空」和
      // 「片段被切没了」在日志里长得一模一样（`textLen` 才是判据，`text` 只是给人看的引子）。
      sig.textLen = fullText.length;
      sig.text = fullText.slice(0, 40);
      // 题形命中数**按真源清单逐个报**（批次 9-D）：这里手抄 `.TiMu` / `.questionLi`
      // 就等于给诊断开第二份选择器，改版时它比排查更容易骗人。
      // 前 5 条单独给位置串，是为了「哪个类名命中的」一眼能定位；
      // 它**不是**总数 —— 总数见下面 `qTotal`。
      var hits = [];
      try {
        (this._questionSelectors || []).slice(0, 5).forEach(function (sel) {
          hits.push(count(sel));
        });
      } catch (eSel) {}
      sig.qHits = hits.join('/');
      // ⚠️ `qTotal` 必须按**整份** `_questionSelectors` 的并集数，不能只数前 5 条。
      //   这条清单是**有序备选**，`_collectQuestionContainers`（抠题真源）是逐条试到底的，
      //   而真实日志里唯一命中的那条排在第 15：
      //     00:46:04 `quiz scan found 0 questions {docs:8,inputs:9,matchedSelectors:{"div[class*=\"question\"]":1}}`
      //   只数前 5 条 → `qTotal` 恒为 0 → 批次 10-C 的延时窗口**永远不会武装**，
      //   判据修对了、喂它的数取错了，等于没修（e2e 场景 45 的夹具就是照这个改的）。
      //   一次并集查询，不是 18 次：这一族帧每秒都可能重扫，取证也要算成本。
      sig.qTotal = 0;
      try {
        var allSelectors = this._questionSelectors || [];
        if (allSelectors.length) sig.qTotal = Math.max(0, count(allSelectors.join(',')));
      } catch (eUnion) {}
      sig.video = count('video');
      // 作答控件读**真源** `_quizAnswerControlSelector`（`li[qid]` / `#answer…` / `[role=radio|checkbox]`），
      // 不是只数 `[id^="answer"]`：新版前端有的卷子只有 `qid` 或 role，光看 id 会把真卷子读成"没有作答框"，
      // 于是 10-C 的延时窗口武装不上。准入闸问的就是这一串，取证必须和它同一个口径。
      sig.answer = count(this._quizAnswerControlSelector);
      sig.frames = count('iframe');
      try { sig.pan = doc.getElementById && doc.getElementById('panView') ? 1 : 0; } catch (ePan) { sig.pan = -1; }
      if (found) {
        try {
          sig.signals = Object.keys(found).filter(function (k) { return !!found[k]; }).join(',');
        } catch (eSig) {}
      }
      return sig;
    },

    /**
     * 「这一帧**有作答框、也命中了题形容器**，却一题都没抠出来」—— 批次 10-C。
     *
     * 为什么这一族不能当成「整节已完成」：真实日志 00:46:04
     *   `quiz scan found 0 questions {docs:8, inputs:9, matchedSelectors:{"div[class*=\"question\"]":1}}`
     *   → 1 秒后 `skip completed {by:"all-tasks-finished"}` → 点「下一节」；
     * 而 00:46:16 重新加载之后，**同一份卷子当场答成 3 题**。也就是说那一帧里坐着的就是一份
     * 还没渲染完的真卷子（有题形容器、有作答控件），只是抠题暂时为空 —— 平台把内容
     * `document.write` 进子帧需要时间，我们扫得太早，就把"还没长出来"读成了"已经做完"。
     * 这正是用户报的「第一个做了、第二个又不做了」和「判定为已完成了」。
     *
     * ⚠️ **代价必须封顶**：用户的另一条抱怨是「在已经完成的界面磨蹭很久」。所以这里不是
     * 「一直等」，而是**每个作用域（章节+卡片）只给一个窗口**，用完就照旧推进 ——
     * 与「判不准时停在原地、代价可见、会自愈」那条规矩一致，但不许把磨蹭换成另一种磨蹭。
     */
    _maybeHoldSkipForUnparsedQuiz: function (sig, src) {
      if (!sig) return false;
      if (!(Number(sig.qTotal) >= 1) || !(Number(sig.answer) >= 1)) return false;
      var now = Date.now();
      if (this._quizParseRetryUntil > now) return true;               // 同一窗口内不续期，否则永不超时
      var scope = '';
      try { scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || ''))); } catch (eScope) {}
      if (scope && scope === this._quizParseRetryScope) {
        // 本张卡片已经用过窗口，且**这一轮没再给出新证据**：不再续期，让它推进。
        this._noteQuizParseRetryExhausted(now, sig, src);
        return false;
      }
      this._quizParseRetryScope = scope;
      this._quizParseRetryUntil = now + Math.min(12000, scaledMs(8000));
      emitRuntimeLog('warn', 'quiz frame has answer controls but no parsable questions, delay skip', {
        src: String(src || '').slice(0, 40),
        qHits: String(sig.qHits || ''), qTotal: sig.qTotal, answer: sig.answer,
        // 批次 11-A：`src:"quiz-scan"` 这一路给的是**页面级**数字，没有单帧文本可报，
        // 于是 `containers`（收着的题容器数）就是"命中了却被过滤掉 / 压根没容器"的分界。
        textLen: Number(sig.textLen) || 0, containers: Number(sig.containers) || 0,
        drop: String(sig.drop || ''),
        hint: '题形容器命中≥1 且作答框≥1、却一题都没抠出来 —— 多半是平台还没把卷子渲染进这一帧。' +
          '本卡片只给一个延时窗口，过期后照旧推进（不再空等）',
        holdMs: this._quizParseRetryUntil - now
      });
      return true;
    },

    /**
     * 「目录那一项还写着有任务点没做完」时，把 `all-tasks-finished` 那一句**有界按住** —— 批次 38。
     *
     * 为什么这一支单独要一份否决：走到 `all-tasks-finished` 的前提是
     * 「页面上**认得出**的任务框全都已完成」，这是一份 **absence 证据** —— 它说的是
     * "这一瞬间我没看见没做完的框"，不是"这一节没有没做完的任务点"。而学习通的任务框是
     * **惰性挂载**的（附件清单里有、DOM 里还没长出来），于是
     * 「刚交完第一份卷子、第二份还没挂载」和「整节真做完了」在这一支里**长得一模一样**。
     *
     * 现场账（2026-11-13，`.workbuddy/hold-no-skip.js` 把"本来要跳过"按住量到的三条）：
     * `skip completed {by:"all-tasks-finished", tasks:1, unfinished:0}` 连出三次，
     * 而**同一秒**目录项上分别写着「还有 1 / 2 / （数字读成 NaN）个待完成任务点」——
     * `unfinished` 读的是隐藏 `input.jobUnfinishCount`，那一族卡片上压根没有它。
     *
     * ⚠️ 所以这里认的是**「未做完」那颗标记本身**（`[class*="catalog_points"]`，现场文案
     *    「N个待完成任务点」），隐藏 input 只当加码证据 —— 与 `_hasTaskPoint()` 末段、
     *    `catalog-marker` 那一支**同一口径**，不许反过来读（批次 20-I 的教训：同一个 class
     *    在同一个文件里被两处读出相反含义，改一处就拆另一处）。
     *
     * 成本被两件事夹住，不许把"跳过"换成"磨蹭"（与 `_maybeHoldSkipForUnparsedQuiz` 同一套纪律）：
     *   ① **一张卡片只给一个窗口**：`_studyProgressKey()` 变了才算新证据、才重新起算；
     *      窗口内不续期，否则页面每几秒抖一下就是永不超时；
     *   ② **到期放行 + 留一条 warn**：AGENTS §2.7 —— 跳过用户的任务点必须可解释、可恢复。
     */
    _maybeHoldSkipForCatalog: function () {
      var item = null;
      try { item = this._catalogItemForChapter(); } catch (eItem) { item = null; }
      if (!item) return false;                       // 目录项都认不出来 = 没有这份证据，不否决
      var claimed = this._catalogUnfinishedCount(item);
      var marker = false;
      try { marker = !!item.querySelector('[class*="catalog_points"]'); } catch (eM) { marker = false; }
      if (!marker && !(claimed > 0)) return false;   // 目录没说"还有几个没做"

      var now = Date.now();
      if (this._catalogVetoUntil > now) return true;
      var scope = '';
      try {
        scope = String(this._studyProgressKey() || this._lastChapterKey || '') || 'no-scope';
      } catch (eScope) { scope = 'no-scope'; }
      if (scope === this._catalogVetoScope) {
        this._noteCatalogVetoSpent(now, claimed, marker);
        return false;
      }
      this._catalogVetoScope = scope;
      // 基础 15 秒：这里等的是**整帧挂载**（比同一帧渲染完慢），但又短到不至于让慢一节的
      // 代价扩散；`scaledMs` 让慢机放大，硬上限 20 秒保证最坏成本有界。
      this._catalogVetoUntil = now + Math.min(20000, scaledMs(15000));
      emitRuntimeLog('warn', 'catalog still lists unfinished task points, delay skip', {
        claimed: claimed, marker: marker, holdMs: this._catalogVetoUntil - now,
        hint: '页面上认得出的任务框都已完成，但目录那一项还写着「N个待完成任务点」—— ' +
          '多半是这一节还有任务框没挂载。先按住不翻页，窗口用掉照旧推进'
      });
      return true;
    },

    _noteCatalogVetoSpent: function (now, claimed, marker) {
      if (this._catalogVetoWarnAt && now - this._catalogVetoWarnAt < 60000) return;
      this._catalogVetoWarnAt = now;
      emitRuntimeLog('warn', 'catalog veto window spent, allow skip', {
        claimed: claimed, marker: !!marker,
        hint: '这一张卡片的延时窗口已经用掉：目录仍说有待完成，但页面没再长出新的任务框 —— ' +
          '放行完成判定。上一条 `delay skip` 与这条相隔多久，就是这一族任务框挂载实际需要的时间'
      });
    },

    _noteQuizParseRetryExhausted: function (now, sig, src) {
      if (this._quizParseRetryWarnAt && now - this._quizParseRetryWarnAt < 60000) return;
      this._quizParseRetryWarnAt = now;
      emitRuntimeLog('warn', 'quiz parse retry spent, allow skip', {
        src: String(src || '').slice(0, 40),
        qTotal: sig.qTotal, answer: sig.answer,
        containers: Number(sig.containers) || 0,
        hint: '延时窗口已经用掉：这一帧仍然抠不出题，放行完成判定 —— 下一份日志里这条与上一条' +
          ' `delay skip` 相隔多久，就是这一族卷子渲染实际需要的时间'
      });
    },

    /**
     * 页面级「有作答框 + 命中题形、却一题没抠出来」信号 —— 批次 11-A。
     *
     * ⚠️ 这一条补的是 10-C 接错的那根线。10-C 的窗口只挂在**「帧被拒」**那条路上，
     * 而真实日志 01:49:17 那一帧的签名是 `answer:0`、`text:""`（卷子压根还没被
     * `document.write` 进那一帧），闸门条件 `qTotal>=1 && answer>=1` 当场不成立 ——
     * 于是"修好了"的延时窗口在真实页面**一次都没武装过**，用户看到的还是同一句
     * `skip completed {by:"all-tasks-finished"}`。
     * 同一时刻真正量到正确形状的，是 `_handleQuiz` 那句 0 题诊断（00:46:04：
     * `inputs:9` + `matchedSelectors:{"div[class*=\"question\"]":1}` + 容器 0 个），
     * 但它说完就扔，没有任何判据读它。这里把**同一份数字**接进**同一个有界窗口**。
     *
     * 一次诊断要遍历 ≤8 个文档 × 18 条选择器，所以只在「这张卡片还可能拿到窗口」时才算：
     * 窗口已经武装（`_isCurrentCompleted` 正在拦）或本卡片预算已用掉 → 直接 null。
     * 落盘字段全部标量（批次 10-A 的规矩）。批次 12：`dropStages` 真实形状是
     * 「选择器 → {matched,filtered,deduped,unparsable}」，旧写法按数字读它 → `:NaN`，
     * 现在统一走 `_flattenDropStages`；`qTotal` 改成**逐文档取最大值再相加**，
     * 因为真页面同一批 24 道题被三族选择器各数一遍，相加给出页面里根本没有的 73。
     */
    _quizScanRetrySignal: function (preferredDoc) {
      var now = Date.now();
      if (this._quizParseRetryUntil > now) return null;
      var scope = '';
      try {
        scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || '')));
      } catch (eScope) {}
      if (scope && scope === this._quizParseRetryScope) return null;

      var diag = null;
      try { diag = this._diagnoseQuestionScan(preferredDoc || null); } catch (eDiag) { return null; }
      if (!diag || !Array.isArray(diag.docs)) return null;

      var answer = 0;
      var qTotal = 0;
      diag.docs.forEach(function (d) {
        if (!d) return;
        answer += Number(d.inputs) || 0;
        var hitMap = d.selectors || {};
        // ⚠️ 批次 12：这里取**每条选择器命中的最大值**，不是全部相加。
        // 真页面实测：同一批 24 道题被 `.TiMu` / `.singleQuesId` / `div[class*="TiMu"]`
        // 各数了一遍，相加给出 `qTotal:73` —— 一个页面里根本没有的数字。
        // 三条选择器的各自数量本来就在 `matchedSelectors` 里，这里只要"大概有几道题"，
        // 而判据是 `>=1`：取最大值一样能开门（真页面那条 `div[class*="question"]:1` 仍然算 1）。
        var docMax = 0;
        Object.keys(hitMap).forEach(function (k) {
          var n = Number(hitMap[k]) || 0;
          if (n > docMax) docMax = n;
        });
        qTotal += docMax;
      });
      if (!(qTotal >= 1) || !(answer >= 1)) return null;

      return {
        qTotal: qTotal, qHits: '', answer: answer,
        containers: Number(diag.containers) || 0,
        docs: diag.docs.length, drop: this._flattenDropStages(diag.dropStages),
        textLen: 0, text: ''
      };
    },

    /**
     * 「凭什么说这一节做完了」—— 批次 11-B，**只取证、不改判据**。
     *
     * 用户四轮反馈里最要命的一句是「怎么说已完成了？」，而 `skip completed` 整条日志只有
     * `{title, by}` 两个字段：既看不出那一刻任务点清单长什么样，也看不出页面上还剩几个
     * 作答框、延时窗口是用掉了还是根本没武装。下一份导出必须能自己回答这个问题。
     *
     * 全部走只读判据：`_isQuizLearningPending` 会重置答题状态（有副作用），**不许**调。
     */
    _skipCompletedEvidence: function () {
      var ev = {
        by: this._completionEvidence || 'unknown',
        tasks: 0, unfinished: 0, taskTypes: '', unfinishedTypes: '',
        inputs: 0, qTotal: 0, containers: 0, drop: '',
        retryLeftMs: 0, retrySpent: false
      };
      try {
        var tasks = this._collectVisibleTaskFrames();
        ev.tasks = tasks.length;
        // `_classifyTaskFrame` 给的是 `type`（work/video/read/…），不是 `kind` ——
        // 「看见了哪几个任务点、各自完成没有」必须按这一族名字落盘，否则又是一句自证的空话。
        var allTypes = {};
        var openTypes = {};
        tasks.forEach(function (t) {
          var k = String((t && t.type) || 'other');
          allTypes[k] = (allTypes[k] || 0) + 1;
          if (!t || !t.finished) openTypes[k] = (openTypes[k] || 0) + 1;
        });
        var joinTypes = function (map) {
          return Object.keys(map).map(function (k) { return k + ':' + map[k]; }).join('/');
        };
        ev.unfinished = tasks.filter(function (t) { return !t || !t.finished; }).length;
        ev.taskTypes = joinTypes(allTypes).slice(0, 90);
        ev.unfinishedTypes = joinTypes(openTypes).slice(0, 90);
      } catch (eTasks) {}
      try {
        var diag = this._diagnoseQuestionScan(null);
        if (diag && Array.isArray(diag.docs)) {
          ev.inputs = diag.docs.reduce(function (sum, d) { return sum + (Number(d && d.inputs) || 0); }, 0);
          // 与 `_quizScanRetrySignal` 同一个口径（批次 12）：每份文档取最大命中数再相加，
          // 求和会把同一批题按族名数三遍（真页面 24 题报成 73）。
          ev.qTotal = diag.docs.reduce(function (sum, d) {
            var hitMap = (d && d.selectors) || {};
            var docMax = 0;
            Object.keys(hitMap).forEach(function (k) {
              var n = Number(hitMap[k]) || 0;
              if (n > docMax) docMax = n;
            });
            return sum + docMax;
          }, 0);
          ev.containers = Number(diag.containers) || 0;
          ev.drop = this._flattenDropStages(diag.dropStages);
        }
      } catch (eDiag) {}
      try {
        ev.retryLeftMs = Math.max(0, (Number(this._quizParseRetryUntil) || 0) - Date.now());
        var scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || '')));
        ev.retrySpent = !!(scope && scope === this._quizParseRetryScope);
      } catch (eRetry) {}
      // ⚠️ 只落**标量**（批次 10-A 那条：日志里塞对象，`Number(对象)` = NaN、深度也被存储裁掉）。
      // 目录这一族是 `by:"catalog-marker"` 的全部依据，没有它们这句话就还是答不上「凭什么说做完了」。
      try {
        var cat = this._catalogItemForChapter();
        ev.catalogId = cat ? String(cat.id || '').slice(0, 24) : '';
        ev.catalogMark = cat ? (function (node) {
          var kids = node.children || [];
          for (var ci = 0; ci < kids.length; ci++) {
            var kc = String(kids[ci].className || '');
            if (/catalog_points|icon_Completed|icon_completed/.test(kc)) return kc.replace(/\s+/g, ' ').trim().slice(0, 34);
          }
          return '';
        })(cat) : '';
        ev.catalogUnfinished = String(this._catalogUnfinishedCount(cat));
        ev.chapterAgeMs = this._chapterChangedAt ? Date.now() - this._chapterChangedAt : -1;
        ev.frameLoadingLeftMs = Math.max(0, (Number(this._taskFrameLoadingUntil) || 0) - Date.now());
      } catch (eCat) {}
      return ev;
    },


    _searchIFramesOcs: function (rootDoc) {
      var list = [];
      try {
        list = Array.from(rootDoc.querySelectorAll('iframe'));
      } catch (e) {
        return [];
      }
      var result = [];
      while (list.length) {
        var frame = list.shift();
        try {
          if (frame && frame.contentWindow && frame.contentWindow.document) {
            result.push(frame);
            var frames = frame.contentWindow.document.querySelectorAll('iframe');
            list = list.concat(Array.from(frames || []));
          }
        } catch (e2) {}
      }
      return result;
    },

    _searchChaoxingJobOcs: function (searchedJobs) {
      var knowCardWin = this._getMainWindow();
      if (!knowCardWin) return null;
      // 跨域窗口读 .document 会抛 SecurityError：验证码/反作弊页常把主 iframe 指向跨域地址，
      // 裸访问会每轮打断 tick（验证码永远轮不到处理）—— 必须走 _safeWinDoc
      var knowCardDoc = this._safeWinDoc(knowCardWin);
      if (!knowCardDoc) {
        this._markMainFrameCrossOrigin();
        // ⚠️ 批次 35：这一刻 `searchedCount` 必然是 0（连一个帧都枚举不出来），
        //   而现场日志原先只有「清单认到了 10 个任务点、一个帧都没配上」这一格事实 ——
        //   真正的原因（主帧读不到、它指向哪一站）没人说。判据与 `_checkBlockedByCrossOrigin`
        //   共用同两个 helper，所以这句和那句不可能互相打脸。
        //   节流 15 秒：本方法被 OCS 循环每秒调一次。
        var nowUnreadable = Date.now();
        if (nowUnreadable - (this._frameUnreadableLogAt || 0) > 15000) {
          this._frameUnreadableLogAt = nowUnreadable;
          var unreadOrigin = this._frameOriginOf(this._getMainFrame());
          emitRuntimeLog('warn', 'study search skipped: main frame document unreadable', {
            srcOrigin: unreadOrigin || '(no-src)',
            topOrigin: String(location.origin || ''),
            sameSite: this._isFrameSameSiteAsTop(unreadOrigin),
            attachments: (this._getChaoxingAttachments() || []).length
          });
        }
        return null;
      }
      this._mainFrameCrossOriginSince = 0;
      var appRef = this;
      var attachments = this._getChaoxingAttachments();
      var searchJobElement = function (frame) {
        var doc = appRef._safeDocOf(frame);
        if (!doc) return null;
        return {
          videojs: doc.querySelector('#video,#audio'),
          // 与 `_detectChaoxingJobElements` 同一个判据：问「抠不抠得出题」，
          // 不再问「像不像题」（`.question-content` 一类通用类名在课件帧里也有）。
          quiz: appRef._documentHasQuiz(doc),
          // 准入闸专用的弱信号，见 `_detectChaoxingJobElements` 里同名字段的注释。
          // 判类型**不许**读它 —— 那正是「像题即题」把课件判成测验的那条路。
          quizLike: !!doc.querySelector(appRef._quizDetectorSelector),
          // 投票封面帧：这里能拿到 frame 自己，所以模块地址也算信号。
          // 判"这是不是投票"只此一处真源（`_isVoteCoverFrame`），两条扫描链共用。
          vote: appRef._isVoteCoverFrame(frame, doc),
          read: doc.querySelector('#img.imglook'),
          pptWithAudio: doc.querySelector('.swiper-container'),
          hyperlink: doc.querySelector('#hyperlink'),
          timereader: doc.querySelector('iframe[name="bookifame"][src*="timing"]'),
          // 纯 PDF / WPS 文档帧：既没有 #img.imglook（那不是图片型阅读），
          // 也没有 swiper（那不是带音频的 PPT），只有 #panView / .pageNum。
          //
          // 以前这里没有这一项，于是这类帧在下面那行 `!(found.xxx || ...)` 里
          // 直接 `continue` —— **永远不进入 OCS 调度**。
          // 「有些微课 PDF/WPS 文档卡住没有任何动作」正是由此而来。
          // 注意这一项必须放在 || 链的**最后**：它是兜底，不能抢走上面更明确的类型。
          pagedDoc: (doc.getElementById && doc.getElementById('panView')) || doc.querySelector('.pageNum')
        };
      };

      var iframes = this._searchIFramesOcs(knowCardDoc);
      // 每个被跳过的帧**为什么**被跳过 —— 一个都没匹配上时打出来。
      //
      // 为什么值得记：这个函数的失败**没有任何报错**，只是返回 null，
      // 然后整章被 `nextUnit()` 推过去。现场日志里只有一句
      // `search finished on page {"searchedCount":0}` —— 知道"没匹配上"，
      // 但**不知道卡在哪一条**（帧认不出？取不到 jobid？jobid 不在附件清单里？），
      // 只能靠人猜。用户报过的「两个大题目只做第一个」当初就是这么查的。
      //
      // 只记前 8 条，避免日志洪水。
      var rejects = [];
      var noteReject = function (frame, reason, sig) {
        if (rejects.length >= 8) return;
        var src = '';
        try { src = String(frame && frame.getAttribute && frame.getAttribute('src') || '').slice(0, 40); } catch (eSrc) {}
        var item = { src: src, reason: reason };
        // ⚠️ 「认不出类型」这一族必须带**帧里到底有什么**（批次 9-D，只取证不改判据）。
        // 真实日志 00:46:55 的 `frames:8` 里有 4 个 `javascript:void(function(){document.open`
        // 和 3 个 `javascript:` 帧全落在这一条 —— 这正是用户报的「第一个做了、第二个又不做了」
        // 唯一的可疑现场，但旧日志只报 src 前 40 字，**判不了那是空帧还是第二份卷子**。
        // 没有证据就动类型判定，代价是别的帧跟着一起被误收（用户明确警告过的"修一半报废一堆"）。
        if (sig) {
          item.sig = sig;
          // 批次 10-C：**这一条不改准入判据**（那是 9-D 刻意留着的），只在
          // 「有作答框 + 命中题形容器 + 一题没抠出」时给完成判定加一个有界延时。
          if (appRef._maybeHoldSkipForUnparsedQuiz(sig, src)) item.delay = 'quiz-parse';
          // 批次 19-B：帧**自己说还没加载好**（「正在为您加载文件…」或整张白纸）时，
          // 给发现窗口加一个有界延时。同样不改准入判据，只把"这一节做完了"往后推。
          if (appRef._noteTaskFrameStillLoading(sig, src, (attachments || []).length > 0)) item.loading = 'frame-loading';
        }
        rejects.push(item);
      };
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        try {
          var win = frame.contentWindow;
          var doc = appRef._safeWinDoc(win);
          var found = searchJobElement(frame);
          // 类型仲裁只有一份顺序 —— `_kindFromChaoxingElements`。
          // 这一关先只问 DOM（附件要到下面匹配 jobid 时才拿到），因为
          // 「帧里什么信号都没有」必须在匹配 jobid 之前就被拒掉并留下原因。
          var domKind = this._kindFromChaoxingElements(found, null, doc);
          // ⚠️ 准入闸问的是「这帧有没有**任何**任务信号」，不是「这帧是什么任务」——
          //   后者只许由 `_kindFromChaoxingElements` 一处回答。两个问题合并成一个
          //  （只用 `!domKind` 当闸）会把「认不出作答控件的真卷子」整帧拒掉：
          //   三层嵌套里 `.TiMu` 只挂在内层、且那份卷子的选项没有 `qid` 时，
          //   `domKind` 为空 → 连 jobid 匹配都不做 → 整章静默跳过。
          //   实测这样改把 3 条 2026-10-17 真实故障夹具全线改红（2026-11-10 批次 2）。
          //   弱信号 `quizLike` 只放它**进门**，类型仍然由「附件 + 窄判据」定，
          //   所以课件页该走阅读链路还是走阅读链路（见「任务类型仲裁」场景）。
          if (!win || !found || (!domKind && !found.quizLike)) {
            // ⚠️ 讨论任务点（`insertbbs` / `bbscircle`）**本来就不归这条链** —— 它由
            // 讨论域那条独立的 `_tryDiscussionTask` 处理。原先它和"真认不出类型"共用
            // 同一句原因，于是实测日志里的 `rejects:[work + 3× insertbbs]` 看起来像
            // "识别失败"，而实际是"这压根不是我该做的活"（批次 20-D：只分开原因，不放开准入）。
            var discReject = this._isDiscussionModuleFrame(frame)
              ? '讨论任务点（insertbbs/bbscircle）：由讨论链路处理，这条链不建 job'
              : '';
            noteReject(frame, discReject || '帧里认不出任务类型（视频/阅读/测验/PPT/超链接/翻页文档都没有）',
              this._frameRejectSignature(doc, found));
            continue;
          }
          // 纯文档帧还有一道闸：外层容器必须真的带任务点。
          // 否则它只是页面上的说明性/预览性文档，接管它会白白占住调度。
          if (domKind === 'document') {
            if (!appRef._frameHasTaskPoint(doc)) {
              noteReject(frame, '纯文档帧，但外层容器没有任务点标记');
              continue;
            }
          }
          var frameDataStr = (win.frameElement && win.frameElement.getAttribute('data')) || (((win.frameElement && win.frameElement.contentWindow) && win.frameElement.contentWindow.parent && win.frameElement.contentWindow.parent.frameElement && win.frameElement.contentWindow.parent.frameElement.getAttribute('data'))) || '{}';
          var frameData = this._safeJsonParse(frameDataStr, {});
          var targetJobId = frameData.jobid || frameData._jobid || this._findJobIdInAncestorFrames(win);
          if (!targetJobId) {
            // 签名在这一支同样要带：「第二份卷子在哪一层」的取证不区分它死在准入闸还是死在 jobid
            noteReject(frame, '取不到 jobid（本层 data 为空，往上找祖先帧也没有）',
              this._frameRejectSignature(doc, found));
            continue;
          }

          var attachment = attachments.find(function (attachmentItem) {
            var attachmentJobId = attachmentItem && (attachmentItem.jobid || (attachmentItem.property && attachmentItem.property._jobid));
            if (!attachmentJobId) return false;
            return String(attachmentJobId) === String(targetJobId);
          });
          if (!attachment) {
            noteReject(frame, 'jobid=' + String(targetJobId).slice(0, 20) + ' 在附件清单里找不到');
            continue;
          }
          if (searchedJobs && searchedJobs.find(function (job2) {
            return job2 && String(job2.mid || job2.jobid || '') === String((attachment.property && attachment.property.mid) || attachment.jobid || '');
          })) {
            noteReject(frame, '这个任务点本轮已经搜过');
            continue;
          }

          var jobName = this._getChaoxingJobName(attachment);
          var jobKind = this._kindFromChaoxingElements(found, attachment, doc);
          var workType = this._getAttachmentWorkType(attachment);
          if (this._isDocumentFrameFinished(doc) || (jobKind === 'quiz' && this._isQuizPassedOrFinished(doc))) {
            workType = 'finished';
          }
          // 同一份卷子我们**自己刚答过**，这一轮也不必再做。
          // 平台有时交完卷不马上渲染结果页（提交按钮还挂着），于是"页面看着没做完"，
          // 而 `_handleQuiz` 因为有 `_quizAnswered` 又直接返回 —— 两边一夹就是死循环
          //（实测 2026-10-17：同一份卷子被反复匹配 6 分钟，一次都没真做）。
          if (jobKind === 'quiz' && workType === 'job' && this._quizAnswered &&
              this._quizRunPaperKey && String(targetJobId) === String(this._quizRunPaperKey)) {
            workType = 'finished';
          }
          var func = null;
          // ⚠️ 路由**只按上面仲裁出来的 jobKind 分派**，不许再看 `found.xxx` 布尔位：
          //   仲裁与路由各留一份顺序的话，下一次改顺序必然只改到其中一份
          //   （原来这两份已经不一致：这里 `timereader` 排在 `ppt-audio` 前，
          //   `_buildSyntheticChaoxingJob` 那份却把 `documentJob` 排在两者之前）。
          if (jobKind === 'video') {
            if (!this.configs.enableMedia) {
              noteReject(frame, '是视频任务，但「媒体」开关是关的');
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (self, jobFrame, jobWin, jobDoc, name, att) {
                return function () {
                  return self._playChaoxingMediaJob({
                    frame: jobFrame,
                    win: jobWin,
                    doc: jobDoc,
                    attachment: att,
                    kind: 'video',
                    workType: workType,
                    name: name,
                    jobid: targetJobId
                  });
                };
              }(this, frame, win, doc, jobName, attachment);
            }
          } else if (jobKind === 'quiz') {
            if (this._isQuizApiUnavailable()) {
              // ⚠️ 这两条以前都是**静默** continue —— 现场日志里一个字都没有，
              // 用户只看到「本页没有可做的任务点」，然后整章被推过去，还反复空转。
              // 与 AGENTS §2.7「跳过用户的任务点必须留日志 + 可恢复」冲突，补上原因。
              // 只在 `workType === 'job'`（平台说这份卷子**还必做**）时记 13-B 的按住标记：
              // 已经做完的卷子不该因为没填 key 就把整节按住。
              if (workType === 'job') this._noteQuizBlockedByApi(this._getQuizApiUnavailableReason());
              noteReject(frame, '是测验任务，但答题链路当前不可用（' + (this._getQuizApiUnavailableReason() || '原因未知') + '）');
              continue;
            }
            if (!(workType === 'job' || (workType === 'finished' && this.configs.restudy))) {
              noteReject(frame, '是测验任务，但被判定为「' + workType + '」——重学模式没开时不再重做');
              continue;
            }
            func = function (self, jobDoc, jobKey) {
              return async function () {
                // ⚠️ 必须先切"在答哪一份卷子"：同一张学习卡片里有两份试卷时，
                //    第一份交完 `_quizAnswered` 会一直为 true，
                //    而 `_handleQuiz` 第一行就会因此直接 return —— 第二份永远不答。
                self._syncQuizPaperRunState(jobKey, jobDoc);
                await self._handleQuiz(jobDoc);
              };
            }(this, doc, targetJobId);
          } else if (jobKind === 'read' || jobKind === 'ppt-audio' || jobKind === 'timereader' || jobKind === 'document') {
            if (!this.configs.enablePPT) {
              noteReject(frame, '是阅读/文档任务，但「文档」开关是关的');
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (self, jobFrame, jobWin, jobDoc, name, att, jobKind) {
                return function () {
                  return self._runChaoxingReadJob({
                    frame: jobFrame,
                    win: jobWin,
                    doc: jobDoc,
                    attachment: att,
                    kind: jobKind,
                    workType: workType,
                    name: name,
                    jobid: targetJobId
                  });
                };
              }(this, frame, win, doc, jobName, attachment, jobKind);
            }
          } else if (jobKind === 'vote') {
            // ⚠️ 用 `=== false` 而不是 `!x`（与 enableDiscussion 那几道闸同一个写法）：
            //   升级前的 localStorage 里**没有** enableVote 这一项，`!undefined` 会把
            //   所有老用户的投票静默挡掉 —— 那正是本次要修的那个死循环。
            if (this.configs.enableVote === false) {
              noteReject(frame, '是投票任务，但「自动投票」开关是关的');
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (self, jobFrame, jobWin, jobDoc, name, att) {
                return function () {
                  return self._runChaoxingVoteJob({
                    frame: jobFrame,
                    win: jobWin,
                    doc: jobDoc,
                    attachment: att,
                    kind: 'vote',
                    workType: workType,
                    name: name,
                    jobid: targetJobId
                  });
                };
              }(this, frame, win, doc, jobName, attachment);
            }
          } else if (jobKind === 'hyperlink') {
            if (!this.configs.enableHyperlink) {
              noteReject(frame, '是超链接任务，但「超链接」开关是关的');
              continue;
            }
            if (workType === 'job' || (workType === 'finished' && this.configs.restudy)) {
              func = function (jobDoc) {
                return function () {
                  try {
                    var link = jobDoc.querySelector('#hyperlink, a[href]');
                    if (link) link.click();
                  } catch (e3) {}
                  return Promise.resolve();
                };
              }(doc);
            }
          }

          if (func) {
            // 已经在"放弃名单"里的任务点直接跳过：这类任务点多半被老师设成防拖拽/
            // 不可翻页，或者本身不计分。反复重试只会耗时间（尤其是反复回到同一章时）。
            // 名单 24 小时自动过期，控制台 xxtAI.clearTaskGiveUp() 也能立刻清掉。
            if (this._isTaskGivenUp(this._taskPointKey({ jobid: targetJobId, attachment: attachment, name: jobName }))) {
              if (!this._taskGiveUpLogged) this._taskGiveUpLogged = Object.create(null);
              var giveUpKey = String(targetJobId || jobName);
              if (!this._taskGiveUpLogged[giveUpKey]) {
                this._taskGiveUpLogged[giveUpKey] = true;
                emitRuntimeLog('info', 'skip task point in give-up list', {
                  name: String(jobName || '').slice(0, 40),
                  hint: '24 小时内不再尝试；xxtAI.clearTaskGiveUp() 可清除'
                });
              }
              noteReject(frame, '这个任务点在"放弃名单"里（24 小时内不再尝试）');
              continue;
            }
            return {
              mid: (attachment.property && attachment.property.mid) || attachment.jobid || targetJobId,
              jobid: targetJobId,
              attachment: attachment,
              kind: jobKind,
              name: jobName,
              workType: workType,
              frame: frame,
              win: win,
              doc: doc,
              func: func
            };
          }

          // 走到这里：帧认得出类型、jobid 也对上了，但**这一轮轮不到它做** ——
          // workType 不是 job（已判完成 / 不是任务点），或对应的开关是关的。
          // 以前这里一句话都不说，于是「任务点被跳过」在日志里完全不可见（本次排查
          // 就卡在这上面：日志只有 frames:8 和 7 条「认不出类型」，看不出第 8 个帧去哪了）。
          noteReject(frame, '帧认出来了但本轮不需要执行（workType=' + workType + '）');
          continue;
        } catch (e4) {}
      }
      // 一个都没匹配上 —— 把每个帧**被哪一条挡下来**打出来。
      // 这条日志是"整章被跳过"这类问题唯一能自证的线索：没有它，
      // 现场只剩一句 `searchedCount: 0`，得靠人猜是哪一层出的问题。
      if (rejects.length) {
        // ⚠️ 必须节流：本方法被 OCS 循环**每秒**调一次，而"一个任务点都没匹配上"
        // 这个状态**可能持续好几分钟**（典型：整页的题都在一个认不出的帧里）。
        // 不节流的话日志缓冲会被这一条刷爆、把真正有用的条目全挤掉 ——
        // 实测用户导出的 200 条里，大半就是同一句的重复。
        // 判据：拒绝原因的组合变了（页面结构变了）或距上次已超过 30 秒，才再记一条。
        var rejectSignature = rejects.map(function (item) {
          return String(item.reason || '');
        }).join('|');
        var nowReject = Date.now();
        if (rejectSignature !== this._jobRejectSignature || nowReject - (this._jobRejectLogAt || 0) > 30000) {
          this._jobRejectSignature = rejectSignature;
          this._jobRejectLogAt = nowReject;
          emitRuntimeLog('warn', 'search job: every candidate frame was rejected', {
            frames: iframes.length,
            attachments: attachments.length,
            rejects: rejects
          });
        }
      }
      return null;
    },

    /**
     * 「学习进度键」= 章节 id + 当前学习卡片 + 附件指纹。
     *
     * 用来判断 `nextUnit()` 到底有没有让页面往前走：三者都没变，就是**点了等于没点**。
     * 全空时返回空串（调用方据此关闭这道闸，避免在识别不出章节的页面上误判）。
     */
    _studyProgressKey: function () {
      var chapterId = '';
      try { chapterId = String(this._getCurrentChapterId() || ''); } catch (e) {}
      var cardKey = '';
      try { cardKey = String(this._getExplicitActiveLearningCardKey() || ''); } catch (e2) {}
      var fingerprint = '';
      try { fingerprint = String(this._getAttachmentFingerprint(this._getChaoxingAttachments()) || ''); } catch (e3) {}
      if (!chapterId && !cardKey && !fingerprint) return '';
      return chapterId + '|' + cardKey + '|' + fingerprint;
    },

    /**
     * 「这一节的附件清单可能还没渲染完」给多长的发现窗口 —— 两条 runner 共用一份口径。
     *
     * ⚠️ 0 个附件**反而要等最久**。真实日志（2026-11-11，3.1 那一节 8 秒被翻过去）：
     *   13:15:33 `study begin {attachments:0}`
     *   13:15:36 `search job: every candidate frame was rejected {attachments:6,frames:1,…}`
     * 同一个 getter 三秒后读到 6 个 —— 也就是说"0"几乎从来不是"这一节没任务点"，
     * 而是"平台还没把卡片列表画出来"。旧公式 `min(3 + n*2, 10)` 在 n=0 时只给 **3 秒**：
     * 越是什么都没看见，就越快断定没活干，判据和事实正好相反。
     * 空窗的代价是多等 7 秒，翻过去的代价是整节的视频/测验一个字没动 —— 用户看到的
     * 就是「7.3的就直接跳过了」。
     */
    _taskDiscoveryWindowMs: function (attachmentCount) {
      // ⚠️ 必须夹住下界：负数会让 `3 + n*2` 变成负的，窗口终点落在过去 ——
      //   等于"立刻放弃"，比原来的 3 秒还糟（这条是集成测试 [18] ② 抓出来的）。
      var n = Math.max(0, Number(attachmentCount) || 0);
      return scaledMs((n === 0 ? 10 : Math.min(3 + n * 2, 10)) * 1000);
    },

    /**
     * 「这一帧自己说还没加载好」—— 批次 19-B。
     *
     * 同一天真页面两笔账，两种形状、同一个后果（整节被 `nextUnit` 翻过去）：
     *   13:15:36 `{attachments:6, sig.textLen:0}` —— 帧还是一张白纸
     *   13:41:33 `{attachments:6, sig.text:"正在为您加载文件..."}` —— 平台自己写着在加载
     * 13:41:33 那一轮**已经等满了 10 秒**（本批次前半段刚修的发现窗口）还是没等到，
     * 所以固定的秒数不够，必须认这个**正面证据**：帧里写着"正在加载"就不等于"这一节没任务点"。
     *
     * 成本封顶与 `_maybeHoldSkipForUnparsedQuiz` 同一套纪律：每张卡片只给一个窗口、
     * 同一窗口内不续期、用完放行 —— 不许把「跳过」换成另一种「磨蹭」。
     * 返回窗口终点（0 = 这一族不算还在加载，或本卡片的窗口已经用掉）。
     */
    _noteTaskFrameStillLoading: function (sig, src, hasInventory) {
      if (!sig) return 0;
      var text = String(sig.text || '');
      var saysLoading = /正在[^。\n]{0,8}加载|加载中|loading/i.test(text);
      var blank = !text.replace(/\s+/g, '') && !(Number(sig.qTotal) || 0) &&
        !(Number(sig.video) || 0) && !(Number(sig.answer) || 0) && !(Number(sig.pan) || 0);
      if (!saysLoading && !(blank && hasInventory)) return 0;
      var now = Date.now();
      if (this._taskFrameLoadingUntil > now) return this._taskFrameLoadingUntil;
      var scope = '';
      try { scope = String(this._studyProgressKey() || (location.href + '|' + (this._getCurrentTitle() || ''))); } catch (eScope) {}
      if (scope && scope === this._taskFrameLoadingScope) return 0;
      this._taskFrameLoadingScope = scope;
      this._taskFrameLoadingUntil = now + Math.min(20000, scaledMs(15000));
      emitRuntimeLog('warn', 'task frame still loading, search window extended', {
        src: String(src || '').slice(0, 40),
        why: saysLoading ? 'loading-text' : 'blank-frame-with-attachments',
        text: text.slice(0, 24),
        holdMs: this._taskFrameLoadingUntil - now,
        hint: '帧里还写着「正在加载」（或整张白纸、可清单上明明有任务点）—— 这不叫"这一节做完了"。' +
          '本张卡片只给这一个窗口，过期后照旧推进'
      });
      return this._taskFrameLoadingUntil;
    },

    /**
     * 发现窗口的一轮续期判定 —— **就地**改 `state`（`{startedAt, until, seen, budget}`），
     * 返回这一轮窗口终点**有没有被推后**（不是"有没有看到新附件"）。
     *
     * 抽出来只因为它必须能被测：「开跑读一次、三秒后断定这节没活」就是 3.1 整节
     * 被 `nextUnit` 翻过去的直接原因，而这段算术埋在 200 行的循环里没法断言。
     * 规矩：数量**只增不减**（少了不许缩窗，否则一个抖动就把窗口清零）、
     * 每多认一个任务点补一秒搜索预算（沿用原来的 `attachmentCount--` 语义）、
     * 窗口取「按数量续的窗」与「帧还在加载窗 `loadingUntil`」的**较大者**，
     * 再被 `startedAt + scaledMs(45000)` 硬顶夹住 —— 没有顶，清单抖动就等于这条
     * 循环永不超时，而一个永不超时的悬挂会杀死整个 tick 主循环。
     */
    _noteOcsDiscoveryTick: function (state, liveCount, now, loadingUntil) {
      var seen = Number(state.seen) || 0;
      var grew = (Number(liveCount) || 0) - seen;
      var want = Number(state.until) || 0;
      if (grew > 0) {
        state.seen = Number(liveCount) || 0;
        state.budget = (Number(state.budget) || 0) + grew;
        want = Math.max(want, now + this._taskDiscoveryWindowMs(state.seen));
      }
      var lu = Number(loadingUntil) || 0;
      if (lu > want) want = lu;
      if (want > (Number(state.startedAt) || 0) + scaledMs(45000)) {
        want = (Number(state.startedAt) || 0) + scaledMs(45000);
      }
      if (!(want > (Number(state.until) || 0))) return false;
      state.until = want;
      return true;
    },

    _ensureOcsStudyRunner: function () {
      if (this._ocsStudyStarted) return true;
      var knowCardWin = this._getMainWindow();
      if (!knowCardWin) return false;
      var knowCardDoc = this._safeWinDoc(knowCardWin); // 跨域窗口裸读 .document 会抛 SecurityError
      if (!knowCardDoc) {
        this._markMainFrameCrossOrigin();
        return false;
      }
      this._ocsStudyStarted = true;
      var version = this._runtimeVersion || 0;
      var self = this;
      (async function () {
        try {
          await sleep(3000);
          if (version !== self._runtimeVersion) return;

          var searchedJobs = [];
          var seenInventory = (self._getChaoxingAttachments() || []).length;
          // 发现窗口的状态收在一个对象里，续期算术交给 `_noteOcsDiscoveryTick`（能断言）。
          var discovery = {
            startedAt: Date.now(),
            until: 0,
            seen: seenInventory,
            budget: seenInventory
          };
          discovery.until = discovery.startedAt + self._taskDiscoveryWindowMs(seenInventory);
          emitRuntimeLog('info', 'study begin', {
            attachments: seenInventory,
            windowMs: discovery.until - discovery.startedAt
          });

          while (version === self._runtimeVersion) {
            // ⚠️ 心跳：这是个**开放条件**的循环（等页面版本号变化才退出），
            //    里面还有 await job.func()（可能是一次完整的答题/文档任务）。
            //    不刷心跳会让"正常在推进的一轮"被看门狗当成卡死。
            self._tickProgress('ocs study loop');
            if (self._isActiveStudyJobPending('ocs-runner-active-job')) {
              await sleep(1000);
              continue;
            }
            var job = self._searchChaoxingJobOcs(searchedJobs);
            if (job && job.func) {
              var trackBeforeRun = job.kind !== 'quiz';
              if (trackBeforeRun) {
                searchedJobs.push({
                  mid: job.mid || '',
                  jobid: job.jobid || '',
                  name: job.name || ''
                });
              }
              // 有活干 = 有进展，把"点下一节没反应"的计数清零
              self._nextUnitNoopCount = 0;
              self._nextUnitBlockedKey = '';
              // 同一份任务点被**每秒**重复匹配时不再刷屏。
              // 实测（2026-10-17）：答题链路的"无进展"窗口是 60 秒，期间每秒都会重新匹配一次，
              // 于是「study matched job」也每秒一条，把 200 条的日志缓冲刷满。
              var matchedLogKey = String(job.jobid || job.name || '');
              var matchedLogNow = Date.now();
              if (matchedLogKey !== self._matchedJobLogKey || matchedLogNow - (self._matchedJobLogAt || 0) > 10000) {
                self._matchedJobLogKey = matchedLogKey;
                self._matchedJobLogAt = matchedLogNow;
                emitRuntimeLog('info', 'study matched job', { kind: job.kind, name: job.name, workType: job.workType });
              }
              await job.func();
              if (version !== self._runtimeVersion) return;

              // 只在**有证据**时才判定任务点卡住：
              //   - 已完成 → 清零计数，避免历史值影响后续判断
              //   - 未完成且**两次进度快照完全一致** → 认定卡住，计数
              //   - 未完成但探测不到进度（快照为空）→ 一律不计
              // 绝不能简单用"没完成"来计数：长视频一次本来就跑不完，
              // 那样会让必做任务点被误跳过。
              var jobKey = self._taskPointKey(job);
              if (self._isJobCompleted(job)) {
                if (jobKey) {
                  if (self._taskAttempts) delete self._taskAttempts[jobKey];
                  if (self._taskProgress) delete self._taskProgress[jobKey];
                }
              } else if (jobKey) {
                var snapshot = self._taskProgressSnapshot(job);
                if (!self._taskProgress) self._taskProgress = Object.create(null);
                var previous = self._taskProgress[jobKey];
                self._taskProgress[jobKey] = snapshot;
                if (snapshot && previous !== undefined && snapshot === previous) {
                  self._countTaskIncomplete(job, 'stuck-no-progress');
                }
              }

              if (job.kind === 'quiz' && self._isQuizLearningPending(job.doc || null)) {
                await sleep(1000);
                continue;
              }
              if (!trackBeforeRun) {
                searchedJobs.push({
                  mid: job.mid || '',
                  jobid: job.jobid || '',
                  name: job.name || ''
                });
              }
              await sleep(1000);
              continue;
            }
            if (discovery.budget > 0) {
              discovery.budget--;
              await sleep(1000);
              continue;
            }
            // ⚠️ 每一轮重新问一次附件清单：**看到新的就续窗**。
            //   只在开跑那一刻读一次，就是 13:15:33 那次「读 0 → 3 秒后断定这节没活 →
            //   整节被 nextUnit 翻过去」的直接原因（同一刻 `_searchChaoxingJobOcs`
            //   自己读到的是 6 个 —— 一个函数两个口径，慢的那一个说了算）。
            var liveInventory = 0;
            try { liveInventory = (self._getChaoxingAttachments() || []).length; } catch (eInv) {}
            var grewFrom = discovery.seen;
            if (self._noteOcsDiscoveryTick(discovery, liveInventory, Date.now(), self._taskFrameLoadingUntil)) {
              if (discovery.seen > grewFrom) {
                emitRuntimeLog('info', 'study inventory grew', {
                  from: grewFrom, to: discovery.seen,
                  waitedMs: Date.now() - discovery.startedAt,
                  windowMs: discovery.until - Date.now(),
                  hint: '开跑时清单还是空的，中途才渲染出来 —— 发现窗口按新数量续期，' +
                    '别把「还没画出来」读成「没任务点」。这一轮真正多等了多久，看 windowMs'
                });
              }
            }
            if (Date.now() < discovery.until) {
              await sleep(1000);
              continue;
            }
            if (self._isActiveStudyJobPending('ocs-runner')) {
              await sleep(1000);
              continue;
            }
            break;
          }

          if (version !== self._runtimeVersion) return;
          if (self._isQuizLearningPending(null)) {
            if (self._isQuizApiUnavailable()) {
              self._skipQuizForApiUnavailable(null, null);
              if (version !== self._runtimeVersion) return;
            } else if (!self._quizInProgress && !self._quizAnswered) {
              emitRuntimeLog('info', 'study fallback quiz handler', { searchedCount: searchedJobs.length });
              await self._handleQuiz(null);
              if (version !== self._runtimeVersion) return;
            }
            if (!self._isQuizLearningPending(null)) {
              emitRuntimeLog('info', 'study quiz fallback completed', { searchedCount: searchedJobs.length });
            } else {
            // 把"卡在哪几题"一起带上：只有 searchedCount 的话，看不出是
            // "模型没答上"还是"答上了但填不进 DOM"（实测 25 题只填 23 题，
            // 两种日志一模一样，只能靠人肉数题）。
            var pendingDesc = self._describePendingQuizQuestions(null);
            // ⚠️ **数不出具体待答题时不许 hold**（批次 9-C）。
            // 现场：真实日志 00:45:59 → 00:46:16 连磨两轮 `study hold quiz before finish
            // {pending:{total:0}}`，最后是页面自己刷新才走通 —— 用户看到的"在已经做完的
            // 界面磨蹭很久"就是这两轮。`_isQuizLearningPending` 走的是「页面上有题的形状」
            // 那类宽判据（`_hasActiveQuizSubmitForm` / `_detectQuiz`），而 `_extractQuestions`
            // 一道容器都没收着，于是**为 0 道题按住整节**。
            // 「该不该 hold」抽成判据 `_shouldHoldQuizBeforeFinish`（批次 9-C）——
            // 留在这一大坨循环里它没法直接测，而它恰好是"卡住整节"与"照常推进"的分岔口。
            if (self._shouldHoldQuizBeforeFinish(pendingDesc)) {
              emitRuntimeLog('info', 'study hold quiz before finish', {
                searchedCount: searchedJobs.length,
                pending: pendingDesc
              });
              self._ocsStudyStarted = false;
              return;
            }
            emitRuntimeLog('warn', 'study quiz hold skipped: nothing pending to wait for', {
              searchedCount: searchedJobs.length,
              pending: pendingDesc,
              hint: '判据说还有题要做、但一道具体的待答容器都数不出来 —— 继续 hold 只会按住这一节；为什么数不出来见上一条 quiz scan 诊断的 dropStages'
            });
            }
          }
          if (self._isActiveStudyJobPending('ocs-finish-check')) {
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-finish-check')) {
              self._tickProgress('ocs wait finish-check');
              await sleep(1000);
            }
            if (version !== self._runtimeVersion) return;
          }
          if (self._isQuizLearningPending(null)) {
            if (self._isQuizApiUnavailable()) {
              self._skipQuizForApiUnavailable(null, null);
              if (version !== self._runtimeVersion) return;
            }
          }
          if (self._isQuizLearningPending(null)) {
            emitRuntimeLog('info', 'study hold quiz before next', { searchedCount: searchedJobs.length });
            self._ocsStudyStarted = false;
            return;
          }
          // ⚠️ 「我这条链没活」推不出「这一节做完了」（批次 20-D）。
          // 讨论任务点压根不建 job：它的类型 `_kindFromAttachment` 认不出来，
          // 上面那关就把它拒了（拒绝原因现在会明说"由讨论链路处理"），
          // 于是**挂着三个没发帖的讨论的页面**在这里读出来就是 `searchedCount:0`
          // → 翻页。实测 22:46:46 / 22:47:08 每二十秒翻一次，而平台一步都不认。
          // 该不该为讨论按住，判据在讨论域的 `_shouldHoldDiscussionBeforeFinish`
          // （带预算、带"一份文档最多烧两个预算"的兜底 —— 按住不放比翻过去更糟）。
          var discHold = self._shouldHoldDiscussionBeforeFinish();
          if (discHold.hold) {
            emitRuntimeLog('info', 'study hold discussion before finish', {
              searchedCount: searchedJobs.length,
              pending: discHold.pending,
              total: discHold.total,
              reason: discHold.reason,
              heldMs: discHold.heldMs,
              budgetMs: discHold.budgetMs
            });
            self._ocsStudyStarted = false;
            return;
          }
          if (discHold.pending > 0) {
            emitRuntimeLog('warn', 'study discussion hold spent, advance anyway', {
              searchedCount: searchedJobs.length,
              pending: discHold.pending,
              total: discHold.total,
              reason: discHold.reason,
              heldMs: discHold.heldMs,
              spent: discHold.spent,
              hint: '还有讨论任务点没落地，但为它按住的预算已经烧完（或已封顶）—— 照常推进。反复出现说明讨论链路自己发不出去，看 discussion reply not confirmed / discussion nothing pending 那两条'
            });
          }
          // `searchedCount:0` 单独一句没法回答「凭什么说这一节做完了」——
          // 把窗口读数一起落下：这一轮到底等过几个附件、等了多久，一眼分得开
          // "真的空章节"与"清单压根没渲染出来"（2026-11-11 的 3.1 是后者）。
          emitRuntimeLog('info', 'study finished on page', {
            searchedCount: searchedJobs.length,
            attachments: discovery.seen,
            waitedMs: Date.now() - discovery.startedAt
          });
          if (self.configs.autoNext) {
            await sleep(5000);
            if (version !== self._runtimeVersion) return;
            while (version === self._runtimeVersion && self._isActiveStudyJobPending('ocs-next-check')) {
              self._tickProgress('ocs wait next-check');
              await sleep(1000);
            }
            if (version !== self._runtimeVersion) return;
            if (self._isQuizLearningPending(null)) {
              if (self._isQuizApiUnavailable()) {
                self._skipQuizForApiUnavailable(null, null);
                if (version !== self._runtimeVersion) return;
              }
            }
            if (self._isQuizLearningPending(null)) {
              emitRuntimeLog('info', 'study hold quiz before delayed next', { searchedCount: searchedJobs.length });
              self._ocsStudyStarted = false;
              return;
            }
            // ⚠️ 防「点了下一节、页面却根本没动」的空转。
            //
            // 现场（2026-10-17 实测）：本卡片还压着一个没做完的任务点（题目），
            // 平台就不让往下走 —— `nextUnit()` 点了等于没点，于是 15 秒一轮无限循环，
            // 而日志里只有反复的 `study begin` / `study finished on page`，
            // 完全看不出"其实一步都没走"。用户看到的就是「跳过题目卡住」。
            //
            // 判据：连续 3 轮准备点下一节时，「学习进度键」**完全相同**
            //（章节 + 学习卡片 + 附件指纹三者都没变 = 前一次点击没起作用）。
            // 真的往前走了，键必然变，所以不会误伤。
            var progressKey = self._studyProgressKey();
            if (progressKey && progressKey === self._nextUnitNoopKey) {
              self._nextUnitNoopCount = (self._nextUnitNoopCount || 0) + 1;
            } else {
              self._nextUnitNoopCount = 0;
              self._nextUnitBlockedKey = '';
            }
            self._nextUnitNoopKey = progressKey;
            if (self._nextUnitNoopCount >= 3) {
              if (self._nextUnitBlockedKey !== progressKey) {
                self._nextUnitBlockedKey = progressKey;
                emitRuntimeLog('error', 'study stuck: 下一节点了没反应，已停止空转', {
                  rounds: self._nextUnitNoopCount,
                  attachments: discovery.seen,
                  hint: '本学习卡片上还有没做完的任务点，平台因此不让往下走。请手动处理它（例如把这道题做完交卷）；' +
                        '处理完会自动继续，也可在控制台执行 xxtAI.next() 手动推进'
                });
              }
              self._ocsStudyStarted = false;
              return;
            }
            emitRuntimeLog('info', 'study next unit', { searchedCount: searchedJobs.length });
            self.nextUnit();
          }
        } catch (e) {
          self._ocsStudyStarted = false;
          emitRuntimeLog('error', 'study runner error', { message: e && e.message ? e.message : String(e) });
          throw e;
        }
      })();
      return true;
    },

    _searchChaoxingJob: function (searchedJobs) {
      var attachments = this._getChaoxingAttachments();

      var jobs = [];
      var startDoc = document || this._getMainDocument();
      if (!startDoc) {
        emitRuntimeLog('warn', 'search job: no main document');
        return null;
      }

      try {
        var directFrames = startDoc.querySelectorAll('iframe.ans-attach-online, iframe.ans-insertvideo-online, iframe[class*="insertdoc"], iframe[class*="insertvideo"]');
        for (var df = 0; df < directFrames.length; df++) {
          var directFrame = directFrames[df];
          var directFallbackJob = this._buildFrameFallbackJob(directFrame);
          if (!directFallbackJob) continue;

          var directFrameData = this._getChaoxingFrameData(directFrame, directFrame.contentWindow || null);
          var directAttachment = this._matchChaoxingAttachment(attachments, directFrameData);
          if (directAttachment) {
            directFallbackJob.attachment = directAttachment;
            directFallbackJob.name = this._getChaoxingJobName(directAttachment);
            directFallbackJob.workType = this._getAttachmentWorkType(directAttachment);
            if (this._isDocumentFrameFinished(directFallbackJob.doc) ||
              (directFallbackJob.kind === 'quiz' && this._isQuizPassedOrFinished(directFallbackJob.doc))) {
              directFallbackJob.workType = 'finished';
            }
          }
          jobs.push(directFallbackJob);
        }
      } catch (eDirect) {}

      this._walkFrames(startDoc, function (frame) {
        try {
          var win = frame.contentWindow;
          var doc = win && win.document;
          var elements = this._detectChaoxingJobElements(doc);
          if (!elements) {
            var fallbackJob = this._buildFrameFallbackJob(frame);
            if (fallbackJob) jobs.push(fallbackJob);
            return;
          }

          var frameData = this._getChaoxingFrameData(frame, win);
          var attachment = this._matchChaoxingAttachment(attachments, frameData);
          if (!attachment) {
            var syntheticJob = this._buildSyntheticChaoxingJob(frame, win, doc, elements);
            if (syntheticJob) {
              emitRuntimeLog('info', 'synthetic job created', { kind: syntheticJob.kind, name: syntheticJob.name });
              jobs.push(syntheticJob);
            }
            return;
          }

          // 仲裁走唯一那一份顺序（原来这里手抄的链把 documentJob 排在 timereader /
          // pptWithAudio **之前** —— 与 OCS 路由那份顺序已经不一致，正是"两份顺序必漂移"的现场）
          var kind = this._kindFromChaoxingElements(elements, attachment, doc) || 'other';

          var workType = this._getAttachmentWorkType(attachment);
          if (this._isDocumentFrameFinished(doc) || (kind === 'quiz' && this._isQuizPassedOrFinished(doc))) {
            workType = 'finished';
          }
          var hasTaskMarker = !!(frame.parentElement && frame.parentElement.querySelector('.ans-job-icon, .ans-task-icon, .task-condition, [aria-label*="任务点"], [aria-label*="未完成"]'));

          jobs.push({
            frame: frame,
            win: win,
            doc: doc,
            attachment: attachment,
            kind: kind,
            workType: workType,
            name: this._getChaoxingJobName(attachment),
            jobid: frameData.jobid || frameData._jobid || '',
            hasTaskMarker: hasTaskMarker,
            visible: visible(frame) || !!(frame.parentElement && visible(frame.parentElement))
          });
        } catch (e) {}
      }.bind(this), 0);

      var self = this;
      jobs = jobs.filter(function (job) {
        if (searchedJobs && searchedJobs.length) {
          var mid = (job.attachment && job.attachment.property && job.attachment.property.mid) || '';
          var fingerprint = mid || job.jobid || job.name;
          if (fingerprint && searchedJobs.some(function (item) {
            return String(item.mid || item.jobid || item.name || '') === String(fingerprint);
          })) return false;
        }
        if (job.workType === 'job') return true;
        if (job.workType === 'finished') return !!self.configs.restudy;
        return false;
      });

      if (!jobs.length && attachments.length) {
        for (var ai = 0; ai < attachments.length; ai++) {
          var attachmentJob = this._buildAttachmentOnlyJob(attachments[ai]);
          if (!attachmentJob) continue;
          if (this._isJobAlreadySearched(attachmentJob, searchedJobs)) continue;
          if (attachmentJob.workType === 'job' ||
            (attachmentJob.workType === 'finished' && !!this.configs.restudy)) {
            emitRuntimeLog('info', 'attachment-only job created', { kind: attachmentJob.kind, name: attachmentJob.name, workType: attachmentJob.workType });
            jobs.push(attachmentJob);
          }
        }
      }

      if (!jobs.length) {
        // 空章节时这个方法一次 tick 会被调好几次，原来每条都写日志 ——
        // 实测 5 秒能刷 8 条 warn，把 200 条环形缓冲冲掉一大截。
        var nowEmpty = Date.now();
        if (!this._lastSearchEmptyLogAt || nowEmpty - this._lastSearchEmptyLogAt > 5000) {
          this._lastSearchEmptyLogAt = nowEmpty;
          emitRuntimeLog('warn', attachments.length ? 'search job: attachments exist but no runnable job' : 'search job: no attachments and no synthetic job');
        }
        return null;
      }

      var kindWeight = {
        video: 0,
        quiz: 1,
        read: 2,
        document: 2,
        timereader: 2,
        'ppt-audio': 2,
        vote: 3,
        hyperlink: 3,
        other: 4
      };

      jobs.sort(function (a, b) {
        var markerDiff = Number(!!b.hasTaskMarker) - Number(!!a.hasTaskMarker);
        if (markerDiff) return markerDiff;

        var workDiff = (a.workType === 'job' ? 0 : a.workType === 'not-job' ? 1 : 2) - (b.workType === 'job' ? 0 : b.workType === 'not-job' ? 1 : 2);
        if (workDiff) return workDiff;

        return (kindWeight[a.kind] || 99) - (kindWeight[b.kind] || 99);
      });

      emitRuntimeLog('info', 'search job matched candidates', { count: jobs.length, first: jobs[0] ? { kind: jobs[0].kind, name: jobs[0].name, workType: jobs[0].workType } : null });
      return jobs[0] || null;
    },

    _getVisibleTaskCompletionState: function () {
      var tasks = this._collectVisibleTaskFrames();
      return {
        hasTasks: tasks.length > 0,
        allFinished: tasks.length > 0 && tasks.every(function (task) { return !!task.finished; })
      };
    },

    _isActiveDocumentPending: function (reason) {
      if (!this._activeDocumentJobPending) return false;
      var handled = false;
      try {
        handled = this._handleDocumentTask(this._activeDocumentJobDoc || null);
      } catch (e) {
        emitRuntimeLog('warn', 'document pending check failed', { reason: reason || '', message: e && e.message ? e.message : String(e) });
      }
      if (!this._activeDocumentJobPending) return false;
      if (!handled) {
        this._activeDocumentJobPending = false;
        this._activeDocumentJobManaged = false;
        this._activeDocumentJobDoc = null;
        return false;
      }
      var now = Date.now();
      if (!this._documentWaitLogAt || now - this._documentWaitLogAt > 5000) {
        this._documentWaitLogAt = now;
        emitRuntimeLog('info', 'document pending, delay next job', { reason: reason || '' });
      }
      return true;
    },

    _isActiveStudyJobPending: function (reason) {
      if (this._isActiveMediaPending(reason || 'study-job')) return true;
      if (this._isActiveDocumentPending(reason || 'study-job')) return true;
      return false;
    },

    _clearDocumentPendingState: function (reason) {
      var hadPending = !!(this._activeDocumentJobPending || this._activeDocumentJobManaged || this._activeDocumentJobDoc);
      this._activeDocumentJobPending = false;
      this._activeDocumentJobManaged = false;
      this._activeDocumentJobDoc = null;
      this._documentWaitLogAt = 0;
      this._docTaskState = null;
      if (hadPending) {
        emitRuntimeLog('info', 'clear document pending', { reason: reason || '' });
      }
    },

    _runChaoxingJob: async function (job) {
      if (!job) return false;
      this._resolveJobFrame(job);

      console.log('[Omitone] active chaoxing job:', job.kind, job.workType, job.name);

      if (job.kind === 'video') {
        return this._playChaoxingMediaJob(job);
      }

      if (job.kind === 'quiz') {
        // ⚠️ 先把"在答哪一份卷子"切过去。同一张学习卡片里挂着两份试卷时，
        //    交完第一份 `_quizAnswered` 会一直为 true，而下面几行都吃这个标志 ——
        //    不切的话第二份会被当成"已经答过了"直接跳过（实测症状）。
        this._syncQuizPaperRunState(this._getQuizPaperKeyFromJob(job), job.doc || null);
        if (this._isQuizApiUnavailable()) return this._skipQuizForApiUnavailable(null, job.doc || null);
        if (this._isQuizPassedOrFinished(job.doc || null)) {
          this._quizInProgress = false;
          this._quizSubmitPending = false;
          this._quizAnswered = true;
          emitRuntimeLog('info', 'quiz already finished');
          return true;
        }
        if (this._monitorQuizSubmit(job.doc || null)) return true;
        if (this._prepareQuizRedoIfNeeded(job.doc || null)) return true;
        if (this._quizInProgress) return true;
        if (!this._quizAnswered) {
          await this._handleQuiz(job.doc);
        } else {
          this._maybeSubmitQuiz(job.doc || null);
        }
        return true;
      }

      if (job.kind === 'read' || job.kind === 'document' || job.kind === 'timereader' || job.kind === 'ppt-audio') {
        if (!this.configs.enablePPT) {
          console.log('%c[Omitone] document learning disabled, skip: ' + job.name, 'color:#FF9800');
          return true;
        }
        return this._runChaoxingReadJob(job);
      }

      if (job.kind === 'vote') {
        return this._runChaoxingVoteJob(job);
      }

      if (job.kind === 'hyperlink') {
        if (!this.configs.enableHyperlink) {
          console.log('%c[Omitone] hyperlink learning disabled, skip: ' + job.name, 'color:#FF9800');
          return true;
        }
        try {
          var link = job.doc.querySelector('#hyperlink, a[href]');
          if (link) link.click();
        } catch (e) {}
        return true;
      }

      return false;
    },

    _runChaoxingReadJob: async function (job) {
      if (!job) return false;

      try {
        if (!job.win && job.frame) {
          try { job.win = job.frame.contentWindow || null; } catch (eWin) {}
        }
        if (!job.doc && job.win) {
          try { job.doc = job.win.document || null; } catch (eDoc) {}
        }
        if (!job.win) return false;

        console.log('[Omitone] chaoxing read runner:', job.kind, job.name);
        emitRuntimeLog('info', 'chaoxing read runner', { kind: job.kind, name: job.name });
        this._activeDocumentJobPending = true;
        this._activeDocumentJobManaged = true;
        this._activeDocumentJobDoc = job.doc || null;
        this._documentWaitLogAt = 0;

        try {
          if (job.frame && typeof job.frame.scrollIntoView === 'function') {
            job.frame.scrollIntoView({ block: 'center' });
          } else if (job.frame && job.frame.parentElement && typeof job.frame.parentElement.scrollIntoView === 'function') {
            job.frame.parentElement.scrollIntoView({ block: 'center' });
          }
        } catch (eScroll) {}

        if (job.kind === 'read' && typeof job.win.finishJob === 'function') {
          job.win.finishJob();
          emitRuntimeLog('info', 'read finishJob called', { name: job.name });
          this._clearDocumentPendingState('read-finishJob');
          return true;
        }

        var panView = job.doc.getElementById && job.doc.getElementById('panView');
        var innerWin = panView && panView.contentWindow;
        var innerDoc = innerWin && innerWin.document;

        if (job.kind === 'ppt-audio') {
          return await this._runPptAudioJob(job);
        }

        if (job.kind === 'timereader') {
          try {
            var timerFrame = job.doc.querySelector('iframe[name="bookifame"][src*="timing"]') || null;
            var src = String(
              (timerFrame && (timerFrame.getAttribute('src') || timerFrame.src)) ||
              (job.doc.defaultView && job.doc.defaultView.frameElement && job.doc.defaultView.frameElement.getAttribute('src')) ||
              ''
            );
            var timingParam = src ? new URL(src, location.href).searchParams.get('timing') : null;
            var timing = timingParam !== null && timingParam !== '' ? parseInt(timingParam, 10) : 60;
            if (!Number.isFinite(timing) || timing < 0) timing = 60;
            var waitMs = (timing + 3) * 3 * 1000;
            emitRuntimeLog('info', 'timereader wait', { name: job.name, timing: timing, waitMs: waitMs });
            await sleep(waitMs);
            emitRuntimeLog('info', 'timereader wait complete', { name: job.name });
            var endPage = '';
            try {
              if (typeof job.win.getFrameAttr === 'function') {
                endPage = String(job.win.getFrameAttr('end') || '');
              }
            } catch (eEnd) {}
            if (!endPage) {
              try {
                var dataText = job.frame ? String(job.frame.getAttribute('data') || '') : '';
                var data = this._safeJsonParse(dataText, {});
                endPage = String(data.end || (data.property && data.property.end) || '');
              } catch (eData) {}
            }
            if (!endPage) endPage = '99999';
            try {
              if (typeof job.win.onchangepage === 'function') {
                job.win.onchangepage(endPage, 0);
                emitRuntimeLog('info', 'timereader onchangepage', { name: job.name, end: endPage });
              }
            } catch (eChange) {
              emitRuntimeLog('warn', 'timereader onchangepage failed', { message: eChange && eChange.message ? eChange.message : String(eChange) });
            }
            try {
              if (job.win.top && job.win.top !== job.win && typeof job.win.top.onchangepage === 'function') {
                job.win.top.onchangepage(endPage, 0);
                emitRuntimeLog('info', 'timereader top onchangepage', { name: job.name, end: endPage });
              }
            } catch (eTopChange) {}
            await sleep(5000);
            this._clearDocumentPendingState('timereader-complete');
            return true;
          } catch (e1) {
            emitRuntimeLog('error', 'timereader error', { message: e1 && e1.message ? e1.message : String(e1) });
            this._clearDocumentPendingState('timereader-error');
            return true;
          }
        }

        if (job.kind === 'document' && typeof job.win.finishJob === 'function') {
          job.win.finishJob();
          this._clearDocumentPendingState('document-finishJob');
          return true;
        }

        if (innerDoc && innerDoc.querySelector('.fileBox')) {
          var scrollRoot = innerDoc.scrollingElement || innerDoc.documentElement || innerDoc.body;
          if (!scrollRoot) return true;

          var maxScroll = Math.max(0, Number(scrollRoot.scrollHeight || 0) - Number(scrollRoot.clientHeight || 0));
          var pageHeight = Math.max(240, Number(scrollRoot.clientHeight || 0) - 60);
          var nextTop = Math.min(maxScroll, Number(scrollRoot.scrollTop || 0) + pageHeight);

          if (typeof innerWin.scrollTo === 'function') innerWin.scrollTo(0, nextTop);
          else scrollRoot.scrollTop = nextTop;
          return true;
        }

        if (typeof job.win.setScrollTop === 'function') {
          var pageNodes = job.doc.querySelectorAll('.pageNum02');
          var targetPage = Math.max(1, pageNodes.length || 1);
          job.win.setScrollTop(targetPage);
          return true;
        }

        return this._handleDocumentTask(job.doc);
      } catch (e) {
        return this._handleDocumentTask(job.doc);
      }
    },

    _runPptAudioJob: async function (job) {
      var win = job.win;
      var doc = job.doc || this._safeWinDoc(win) || null;
      if (!win || !doc) return false;

      var slides = doc.querySelectorAll('.swiper-container .swiper-slide').length ||
        doc.querySelectorAll('.swiper-slide').length || 0;
      var intervalMs = Math.max(300, Number(this.configs.pptFlipIntervalMs || 1000));

      function buildFlipper() {
        if (typeof win.swiperNext === 'function') {
          return function () { win.swiperNext(); return true; };
        }
        if (win.swiper && typeof win.swiper.slideNext === 'function') {
          return function () { win.swiper.slideNext(); return true; };
        }
        var nextBtn = doc.querySelector('.swiper-button-next');
        if (nextBtn) {
          return function () {
            var btn = doc.querySelector('.swiper-button-next');
            if (!btn || btn.classList.contains('swiper-button-disabled')) return false;
            btn.click();
            return true;
          };
        }
        var container = doc.querySelector('.swiper-container') || doc.body;
        if (container) {
          return function () {
            try {
              container.dispatchEvent(new (doc.defaultView || window).KeyboardEvent('keydown', {
                key: 'ArrowRight', keyCode: 39, which: 39, bubbles: true
              }));
            } catch (e) {}
            return true;
          };
        }
        return null;
      }

      var flipNext = buildFlipper();
      if (!flipNext) {
        emitRuntimeLog('warn', 'ppt-audio no flip method, use document fallback', { name: job.name });
        return this._handleDocumentTask(doc);
      }

      emitRuntimeLog('info', 'ppt-audio flip begin', { name: job.name, totalPages: slides, intervalMs: intervalMs });

      var total = slides > 0 ? slides + 1 : 60;
      for (var i = 0; i < total; i++) {
        if (!this._assertActive()) return false;
        // ⚠️ 心跳：整轮翻页可能远超看门狗的 150 秒（每页还要等音频放完）。
        //    不刷心跳会被误判成"卡死的 tick"，从而放锁并起第二个 tick 并行翻页。
        //    note 里带页号，日志节流后正好成了这个长任务耗时的观测点。
        this._tickProgress('ppt-audio page ' + (i + 1) + '/' + (slides || '?'));
        this._startSlideMedia(doc);
        await this._waitSlideAudioDone(doc);
        emitRuntimeLog('info', 'document page', {
          currentPage: Math.min(i + 1, slides || i + 1),
          totalPages: slides,
          key: 'ppt-audio'
        });
        var flipped = false;
        try { flipped = flipNext(); } catch (eFlip) {}
        if (!flipped) break;
        await sleep(intervalMs);
        if (slides > 0 && i >= slides - 1) break;
      }

      try {
        if (typeof win.finishJob === 'function') {
          win.finishJob();
          emitRuntimeLog('info', 'ppt-audio finishJob called', { name: job.name });
        }
      } catch (eFinish) {}

      this._clearDocumentPendingState('ppt-audio-complete');
      return true;
    },

    /**
     * 空转逃生：这一节确实没有可做的任务时，把页面往前推一步，而不是原地刷日志。
     *
     * 现场（2026-11-10 日志，整整 14 分钟）：交完卷、点掉平台弹的「下一节」之后，
     * 日志每 6 秒一条 `study no runnable job {attachments:0,searchedCount:0}`，
     * 页面一直停在原来那张卡片上，直到重启页面才继续 —— 而重启后第一件事就是
     * `switch learning card before next unit`，说明**本该走的就是这一步**。
     *
     * 为什么原来的兜底接不住：`_skipIfCompleted()` 要能判出"这一节完成了"
     * （附件 0、任务帧 0、目录里也没有已完成标记时它判不出），而下面
     * `_ocsSearchedJobs.length > 0` 那一段只覆盖"搜到过任务点"的页面。
     * 两边都不管"空页面"，于是页面永远停在那里。
     *
     * 判据（全部成立才动，宁可多等也不误跳）：
     *   - 平台附件数为 0，且**一个可见任务帧都没有**（真没活干）
     *   - 主文档加载完成（判据只有 `readyState === 'complete'` 一条：这里用的是**外层页**，
     *     它永远带着导航与目录，正文长度判不出「还在渲染」，原先那条「正文不是空壳」
     *     的长度守卫已经把整道逃生门锁死过，删得对；渲染没完成由 readyState 兜住）
     *   - 没有在答的卷子、没有在等结果的任务点
     *   - 已经连续空了 30 秒
     *   - 同一个「学习进度键」只推一次：点了页面没动就停手，不连点（连点是刷课插件的经典事故）
     *
     * @returns {boolean} true = 已经处理（调用方直接 return），false = 继续正常流程
     */
    _tryAdvanceIdleSection: function (attachments) {
      if (attachments && attachments.length) {
        this._idleEmptySince = 0;
        return false;
      }
      var frames = [];
      try { frames = this._collectVisibleTaskFrames() || []; } catch (eFrames) { return false; }
      if (frames.length) {
        this._idleEmptySince = 0;
        return false;
      }
      if (this._isQuizLearningPending(null) || this._isActiveStudyJobPending('idle-section')) {
        this._idleEmptySince = 0;
        return false;
      }
      // 页面里还在放的视频，绝不算"空" —— 平台偶尔会先渲染内容、后出附件列表。
      // ⚠️ 这里**故意不用 `_detectQuiz()`**：交完卷之后标题还是「章节测验」、地址还带着
      //    `api/work`，它会一直返回 true —— 那正是本节要修的那个场景，用它当护栏
      //    等于把逃生门从里面锁上。题目这一侧由 `_collectVisibleTaskFrames()`（任务帧）
      //    与 `_isQuizLearningPending()`（待答/待交）两道判据守着。
      try {
        var idleVideo = this._getVideoEl();
        if (idleVideo && idleVideo.isConnected !== false && !idleVideo.ended) {
          this._idleEmptySince = 0;
          return false;
        }
      } catch (eVideo) { return false; }

      // ⚠️ 这里必须退到**外层页**，不能只看主帧。
      //   `_tryAdvanceIdleSection` 唯一的调用点（本文件 `_runOcsStyleStudy`）只在
      //   `_ensureOcsStudyRunner()` 返回 false 时才会被走到，而那只发生在
      //   「没有 #iframe」或「主帧跨域读不到」两种情况下 —— 这两种情况下
      //   `_getMainDocument()` **必然是 null**，写成 `var doc = this._getMainDocument()`
      //   就等于 `return false`，整道逃生门是死的（2026-11-10 那个 14 分钟卡死会原样复现）。
      // 空转判定本来就该问"外层页渲染完了没有"。
      var doc = this._getMainDocument() || document;
      if (!doc || !doc.body || String(doc.readyState || '') !== 'complete') return false;

      // ⚠️ 批次 20-I：**这页压根不是刷课页时，一步都不许推。**
      // 现场那条链（2026-11-10 19:12:18 之后）：`skip completed` → `_dismissPopups()` 误点了
      // 常驻的「下一节」→ 页面被带去 `https://i.chaoxing.com/base?…`，那里没有课程结构，
      // 而这条逃生门照样往下走：附件 0、任务帧 0、没视频、readyState complete →
      // 30 秒后拿 `location.href + 标题` 当键**又点一次**，然后在陌生页面上 `study stuck`。
      // 后果不是"白点一下"，是**学习进度停在原地而日志看着像在推进**。
      // 这道门只挡"整页连一个课程标记都认不出"的形状，正常刷课页 / OCS 页都有其中一样，
      // 挡不住它们；被挡下时**一定出日志**，不静默。
      var looksLikeCourse = false;
      try {
        looksLikeCourse = !!(doc.querySelector('.ans-attach-ct, .ans-job-icon, [id^="cur"], .posCatalog_select, .prev_title') ||
          document.querySelector('.ans-attach-ct, .ans-job-icon, [id^="cur"], .posCatalog_select, .prev_title'));
      } catch (eShape) { looksLikeCourse = true; }   // 读不动就当"像"，不许在这里静默跳走
      if (!looksLikeCourse) {
        var declineNow = Date.now();
        if (!this._idleDeclineLogAt || declineNow - this._idleDeclineLogAt >= 120000) {
          this._idleDeclineLogAt = declineNow;
          emitRuntimeLog('warn', 'study idle declined: 这一页认不出课程结构，不点前进', {
            href: String(location.href || '').slice(0, 110),
            everyMs: 120000,
            hint: '页面被推到了没有课程目录/任务点的地方（刷课页之外的地址）。' +
              '这里不点「下一节」，是因为在陌生页面上点它只会把进度越带越偏 —— 请手动回到章节页'
          });
        }
        this._idleEmptySince = 0;
        return true;
      }

      var now = Date.now();
      if (!this._idleEmptySince) {
        this._idleEmptySince = now;
        return false;
      }
      var idleMs = scaledMs(30000);
      if (now - this._idleEmptySince < idleMs) return false;

      // 进度键：章节 + 当前卡片 + 附件指纹。拿不到时退回地址 + 标题，
      // 保证"每次都会有一个键"，否则空串会让下面的去重失效、变成每 30 秒点一次。
      var key = '';
      try { key = String(this._studyProgressKey() || ''); } catch (eKey) {}
      if (!key) key = String(location.href || '') + '|' + String(this._getCurrentTitle() || '');

      if (key === this._idleAdvanceKey) {
        // 上一次已经推过了、页面还是原样：不再点，但**不能只说一次**。
        // 现场（2026-11-10 19:13:23）这里打了一条就永久静默，而后面只剩
        // `search job: no attachments and no synthetic job` 每分钟一条 —— 用户分不清
        // "还在慢慢跑"和"一步都没动"。静默空转是最糟的结局。
        // 现在每 2 分钟重播一次，并把**当前地址**带上：那条键尾巴上的 `||` 加上
        // `https://i.chaoxing.com/base?…` 直接说明"页面被推到没有课程结构的地方了"。
        var stuckNow = Date.now();
        if (this._idleStuckLoggedKey !== key || stuckNow - (this._idleStuckLoggedAt || 0) >= 120000) {
          this._idleStuckLoggedKey = key;
          this._idleStuckLoggedAt = stuckNow;
          emitRuntimeLog('error', 'study stuck: 本节没有可识别的任务，点了前进也没反应', {
            title: String(this._getCurrentTitle() || '').slice(0, 40),
            key: key.slice(0, 80),
            href: String(location.href || '').slice(0, 120),
            everyMs: 120000,
            hint: '这一页已经推过前进、仍认不出任务点，插件停在这里不再乱点 —— 每 2 分钟重复一次，这条日志还在动说明还在等，不是跑了'
          });
        }
        return true;
      }
      this._idleAdvanceKey = key;
      this._idleEmptySince = 0;

      emitRuntimeLog('warn', 'study idle: no task in this section, advance', {
        idleMs: idleMs,
        title: String(this._getCurrentTitle() || '').slice(0, 40)
      });
      if (!this.configs.autoNext) return true;
      if (this._switchToNextLearningCard('idle-section')) return true;
      this.nextUnit();
      return true;
    },

    _runOcsStyleStudy: async function (expectedVersion) {
      if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
        return true;
      }
      var now = Date.now();
      if (this._chapterChangedAt && now - this._chapterChangedAt < 3000) {
        return true;
      }
      if (this._jobTransitionUntil && now < this._jobTransitionUntil) {
        return true;
      }

      if (!this._ocsSearchedJobs) this._ocsSearchedJobs = [];

      var attachments = this._getChaoxingAttachments();
      var attachmentFingerprint = this._getAttachmentFingerprint(attachments);
      if (attachmentFingerprint && attachmentFingerprint !== this._attachmentFingerprint) {
        this._attachmentFingerprint = attachmentFingerprint;
        this._ocsSearchedJobs = [];
        this._ocsSearchDeadline = 0;
        this._studyCompleteAt = 0;
        this._jobTransitionUntil = 0;
        this._ocsLastNoJobLogAt = 0;
        emitRuntimeLog('info', 'attachment fingerprint changed', { count: attachments.length });
      }
      if (!this._ocsSearchDeadline) {
        // 窗口口径与 `_ensureOcsStudyRunner` 共用 `_taskDiscoveryWindowMs`（0 个附件给满窗，
        // 不是给最短）—— 两份公式各写一处，早晚会漂回「读 0 就 3 秒断定没活干」。
        var waitTimeout = this._taskDiscoveryWindowMs(attachments.length || 0);
        this._ocsSearchDeadline = now + waitTimeout;
        emitRuntimeLog('info', 'study begin', { attachments: attachments.length, runner: 'style' });
      }

      if (this._isActiveStudyJobPending('ocs-style-active-job')) {
        this._studyCompleteAt = 0;
        return true;
      }

      var job = this._searchChaoxingJob(this._ocsSearchedJobs);
      if (job) {
        this._studyCompleteAt = 0;
        var trackBeforeRun = job.kind !== 'quiz';
        if (trackBeforeRun) {
          this._ocsSearchedJobs.push({
            mid: (job.attachment && job.attachment.property && job.attachment.property.mid) || '',
            jobid: job.jobid || '',
            name: job.name || ''
          });
        }
        emitRuntimeLog('info', 'study matched job', { kind: job.kind, name: job.name, workType: job.workType });
        await this._runChaoxingJob(job);
        if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
          return true;
        }
        if (job.kind === 'quiz' && this._isQuizLearningPending(job.doc || null)) {
          this._jobTransitionUntil = Date.now() + 1000;
          emitRuntimeLog('info', 'study hold quiz job', { name: job.name });
          return true;
        }
        if (!trackBeforeRun) {
          this._ocsSearchedJobs.push({
            mid: (job.attachment && job.attachment.property && job.attachment.property.mid) || '',
            jobid: job.jobid || '',
            name: job.name || ''
          });
        }
        this._jobTransitionUntil = Date.now() + 4000;
        emitRuntimeLog('info', 'job transition cooldown', { until: this._jobTransitionUntil, name: job.name });
        return true;
      }

      if (now < this._ocsSearchDeadline) {
        return true;
      }

      if (this._isActiveStudyJobPending('ocs-style-finish-check')) {
        this._studyCompleteAt = 0;
        return true;
      }

      if (this._isQuizLearningPending(null)) {
        if (this._isQuizApiUnavailable()) {
          this._skipQuizForApiUnavailable(null, null);
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
        } else if (!this._quizInProgress && !this._quizAnswered) {
          emitRuntimeLog('info', 'study fallback quiz handler', { searchedCount: this._ocsSearchedJobs.length, runner: 'style' });
          await this._handleQuiz(null);
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
          if (!this._isQuizLearningPending(null)) {
            emitRuntimeLog('info', 'study quiz fallback completed', { searchedCount: this._ocsSearchedJobs.length, runner: 'style' });
          } else {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold quiz before page complete', { searchedCount: this._ocsSearchedJobs.length });
            return true;
          }
        } else {
          this._studyCompleteAt = 0;
          emitRuntimeLog('info', 'study hold quiz before page complete', { searchedCount: this._ocsSearchedJobs.length });
          return true;
        }
      }

      if (this._ocsSearchedJobs.length > 0) {
        if (!this._studyCompleteAt) {
          this._studyCompleteAt = now;
          emitRuntimeLog('info', 'study finished on page', { searchedCount: this._ocsSearchedJobs.length });
          return true;
        }
        if (now - this._studyCompleteAt >= 3000) {
          if (expectedVersion != null && expectedVersion !== this._runtimeVersion) {
            return true;
          }
          if (this._isActiveStudyJobPending('ocs-style-next-check')) {
            this._studyCompleteAt = 0;
            return true;
          }
          if (this._isQuizLearningPending(null)) {
            if (this._isQuizApiUnavailable()) {
              this._skipQuizForApiUnavailable(null, null);
              return true;
            }
          }
          if (this._isQuizLearningPending(null)) {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold quiz before next unit', { searchedCount: this._ocsSearchedJobs.length });
            return true;
          }
          // ⚠️ 讨论任务点不建 job，`searchedCount` 数不到它（批次 20-D，与 60 片段同一判据）。
          // 这一支翻的是「这一页的 job 都跑完了」，而讨论还在等 tick 链去开回帖页。
          var discHoldStyle = this._shouldHoldDiscussionBeforeFinish();
          if (discHoldStyle.hold) {
            this._studyCompleteAt = 0;
            emitRuntimeLog('info', 'study hold discussion before next unit', {
              searchedCount: this._ocsSearchedJobs.length,
              pending: discHoldStyle.pending,
              total: discHoldStyle.total,
              reason: discHoldStyle.reason,
              heldMs: discHoldStyle.heldMs,
              budgetMs: discHoldStyle.budgetMs
            });
            return true;
          }
          if (discHoldStyle.pending > 0) {
            emitRuntimeLog('warn', 'study discussion hold spent, advance anyway', {
              searchedCount: this._ocsSearchedJobs.length,
              pending: discHoldStyle.pending,
              total: discHoldStyle.total,
              reason: discHoldStyle.reason,
              spent: discHoldStyle.spent,
              runner: 'style'
            });
          }
          emitRuntimeLog('info', 'study next unit', { searchedCount: this._ocsSearchedJobs.length });
          if (this.configs.autoNext) {
            this.nextUnit();
          }
          return true;
        }
        return true;
      }

      // 空页面逃生：真的没活干就往前走一步。没有这一条，日志里就是
      // 「study no runnable job」每 5 秒一条、连刷 14 分钟（见 _tryAdvanceIdleSection 的说明）。
      if (this._tryAdvanceIdleSection(attachments)) return true;

      // 节流从 5 秒放宽到 20 秒：200 条环形缓冲经不起一条 warn 每 5 秒刷一次，
      // 真错误会被冲走（这次日志里 40 条是同一句话）。
      if (!this._ocsLastNoJobLogAt || now - this._ocsLastNoJobLogAt > 20000) {
        this._ocsLastNoJobLogAt = now;
        emitRuntimeLog('warn', 'study no runnable job', { attachments: attachments.length, searchedCount: this._ocsSearchedJobs.length });
      }
      return false;
    },

    _shouldWaitForTaskDiscovery: function (reason) {
      var now = Date.now();
      if (!this._taskDiscoverStartedAt) this._taskDiscoverStartedAt = now;
      var graceMs = scaledMs(Number(this.configs.taskDiscoverGraceMs || 8000));
      if (graceMs <= 0) return false;

      var doc = this._getMainDocument();
      var bodyText = '';
      try {
        bodyText = doc && doc.body ? textOf(doc.body) : '';
      } catch (e) {}

      // 刚切过章节时「附件数为 0」不等于这一章没任务：轻薄本上平台异步渲染
      // 要好几秒，原来的判据会立刻放行 → nextUnit 推过去 → 后面的题全不做。
      // 只在「刚切换」这个窗口内等附件，普通空章节仍按原逻辑快速跳过。
      var hasAttachments = false;
      try { hasAttachments = this._getChaoxingAttachments().length > 0; } catch (eAttach) {}
      var recentlySwitched = !!this._stepSwitchPending ||
        !!(this._stepSwitchAt && now - this._stepSwitchAt < graceMs);

      var shouldHold = !doc ||
        !!(doc && doc.readyState && doc.readyState !== 'complete') ||
        bodyText.length < 20 ||
        (recentlySwitched && !hasAttachments) ||
        this._hasTaskPoint();

      if (!shouldHold) return false;
      if (now - this._taskDiscoverStartedAt < graceMs) {
        this._logTaskWait((reason || 'discovery') + ' ' + (now - this._taskDiscoverStartedAt) + '/' + graceMs + 'ms' +
          ' factor=' + perfFactor() + ' attachments=' + (hasAttachments ? 'yes' : 'no'), now);
        return true;
      }
      return false;
    },

    _getTaskIdentity: function (task) {
      if (!task) return '';
      var frameId = '';
      try { frameId = task.frame ? (task.frame.id || task.frame.name || '') : ''; } catch (e) {}
      return [task.type, task.src, task.shadowSrc, task.dataText, frameId].join('|').slice(0, 400);
    },

    _isTaskStillLoading: function (task) {
      if (!task) return false;
      var hint = [task.src, task.shadowSrc, task.dataText].join(' ').trim();
      if (!hint) return true;
      if (!task.doc) return true;
      try {
        if (task.doc.readyState && task.doc.readyState !== 'complete') return true;
      } catch (e) {}

      try {
        var bodyText = task.doc.body ? textOf(task.doc.body) : '';
        if (!bodyText) return true;
        if (/加载中|正在加载|请稍候|loading/i.test(bodyText)) return true;
      } catch (e2) {}

      if (task.type === 'other') {
        try {
          if (!task.doc.querySelector('video, audio, .ans-insertvideo-online, .fileBox, .pageNum, ' + this._quizContainerSelector + ', [qid], [role="radio"], [role="checkbox"]')) {
            return true;
          }
        } catch (e3) {
          return true;
        }
      }
      return false;
    },

    _handlePendingTask: function (task) {
      var now = Date.now();
      var key = this._getTaskIdentity(task);
      if (this._pendingTaskKey !== key) {
        this._pendingTaskKey = key;
        this._pendingTaskStartedAt = now;
        this._pendingTaskLogAt = 0;
      }

      var graceMs = scaledMs(Number(this.configs.taskPendingGraceMs || 7000));
      var stillLoading = this._isTaskStillLoading(task);
      if (stillLoading && (now - this._pendingTaskStartedAt < graceMs)) {
        if (now - this._pendingTaskLogAt >= 3000) {
          this._pendingTaskLogAt = now;
          console.log('%c[Omitone] waiting task ready: ' + (task.type || 'other') + ' ' + (now - this._pendingTaskStartedAt) + '/' + graceMs + 'ms', 'color:#9C27B0');
        }
        return true;
      }
      return false;
    },

    // 文档帧自己身上有没有「任务点」证据。
    //
    // 为什么不能只看 _hasTaskPoint()：那个方法只扫主文档 + 左侧章节目录，
    // 而文档任务点在真实页面里是**挂在 iframe 外层包裹容器上**的
    // （`<div class="ans-attach-ct ans-job-...">` 里再套 iframe），
    // 主文档里往往只剩一个类名被改写过、或干脆没有标记。
    //
    // 这里沿 frameElement 往上找 4 层，看包裹容器上有没有任务点痕迹。
    // 找不到就返回 false —— 调用方按「没有任务点」处理，让它走跳过逻辑，
    // 而不是把它当成一个永远做不完的任务接管住。
    _frameHasTaskPoint: function (doc) {
      try {
        if (!doc || !doc.defaultView) return false;
        var node = doc.defaultView.frameElement;
        for (var i = 0; i < 4 && node; i++) {
          var cls = String(node.className || '');
          if (/(^|\s)(ans-job-icon|ans-job-finished|ans-job-num|taskPoint)(\s|$)/.test(cls)) return true;
          if (/(^|\s)ans-job-/.test(cls)) return true;
          if (node.getAttribute && (node.getAttribute('jobid') || node.getAttribute('_jobid'))) return true;
          var dataText = String(node.getAttribute ? (node.getAttribute('data') || '') : '');
          if (dataText && /"job"\s*:\s*true/i.test(dataText)) return true;
          if (textOf(node).indexOf('任务点') !== -1) return true;
          node = node.parentElement;
        }
      } catch (e) {}
      return false;
    },

    _locateDocumentTask: function (preferredDoc) {
      var self = this;
      var startDoc = this._getMainDocument() || document;

      // 没有任务点的文档不值得开一条长任务。
      //
      // 这是「有些微课 PDF/WPS 文档没有任务点时会卡住」的正解：
      // 以前只要 DOM 结构像文档（有 #panView / .pageNum），就无条件接管，
      // 于是 tick 每轮都在这里 `return true`，永远轮不到 tail 的
      // `_isTextOnly() && !_hasTaskPoint() → nextUnit()` 跳过分支。
      // 页面表现就是「一动不动，日志也不更新」。
      //
      // 判定顺序有讲究：
      //   1. 外层容器明确写了任务点 → 接管（正常路径，绝不能误伤）
      //   2. 主文档/章节目录有任务点   → 接管（老逻辑）
      //   3. 两者都没有               → 不接管，交回 tick 走跳过
      function worthHandling(doc) {
        if (self._frameHasTaskPoint(doc)) return true;
        if (self._hasTaskPoint()) return true;
        return false;
      }

      function buildTask(doc) {
        if (!doc) return null;
        try {
          if (doc.getElementById && doc.getElementById('panView')) {
            return worthHandling(doc) ? self._buildPagedDocumentTask(doc) : null;
          }
          if ((doc.getElementById && doc.getElementById('markDataStr')) || doc.querySelector('.pageNum')) {
            return worthHandling(doc) ? self._buildScrollDocumentTask(doc) : null;
          }
          // 原生 PDF.js / aria 页码文档（真实平台结构，2026-10-31 从同类开源实现补入）：
          // 计数器 #pageNumber / input[aria-label="页码"]，下一页 #next / button[aria-label="下一页"]。
          // 与 #panView（超星私有查看器）是两族 —— 此前这一族零覆盖，
          // 文档只能靠滚动兜底慢慢磨、翻页完成判定也接不上。
          if (doc.querySelector('#pageNumber, input[aria-label="页码"], input[aria-label="Page"]') &&
              doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]')) {
            return worthHandling(doc) ? self._buildAriaPagedDocumentTask(doc) : null;
          }
        } catch (e) {}
        return null;
      }

      if (preferredDoc) {
        var preferredTask = buildTask(preferredDoc);
        if (preferredTask) return preferredTask;
      }

      var chaoxingJob = this._searchChaoxingJob();
      if (chaoxingJob && (chaoxingJob.kind === 'document' || chaoxingJob.kind === 'timereader' || chaoxingJob.kind === 'ppt-audio') && chaoxingJob.doc) {
        var jobTask = buildTask(chaoxingJob.doc);
        if (jobTask) return jobTask;
      }

      function walk(doc, depth) {
        if (!doc || depth > 4) return null;
        var currentTask = buildTask(doc);
        if (currentTask) return currentTask;

        var frames = [];
        try {
          frames = doc.querySelectorAll('iframe');
        } catch (e2) {}

        for (var i = 0; i < frames.length; i++) {
          try {
            var subDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
            var found = walk(subDoc, depth + 1);
            if (found) return found;
          } catch (e3) {}
        }
        return null;
      }

      return walk(startDoc, 0);
    },

    _extractFrameKey: function (doc, fallback) {
      try {
        var frame = doc && doc.defaultView && doc.defaultView.frameElement;
        if (frame) return frame.src || frame.getAttribute('src') || frame.id || fallback;
      } catch (e) {}
      return fallback;
    },

    _isDocumentFrameFinished: function (doc) {
      try {
        if (!doc) return false;
        if (doc.querySelector('.ans-job-finished, .job-color, .icon_Completed, .testTit_status_complete')) return true;
        var frame = doc.defaultView && doc.defaultView.frameElement;
        var wrap = frame && frame.parentElement;
        if (!wrap) return false;
        if (wrap.classList && wrap.classList.contains('ans-job-finished')) return true;
        if (wrap.querySelector && wrap.querySelector('.job-color, .ans-job-finished, .icon_Completed, .testTit_status_complete')) return true;
        if (textOf(wrap).indexOf('任务点已完成') !== -1) return true;
      } catch (e) {}
      return false;
    },

    _buildPagedDocumentTask: function (doc) {
      var win = doc.defaultView;
      var panView = doc.getElementById('panView');
      var innerDoc = null;
      try {
        innerDoc = panView && (panView.contentDocument || (panView.contentWindow && panView.contentWindow.document));
      } catch (e) {}

      var items = innerDoc ? Array.from(innerDoc.querySelectorAll('.fileBox li')) : [];
      var totalPages = items.length || (innerDoc ? innerDoc.querySelectorAll('.pageNum').length : 0) || doc.querySelectorAll('.pageNum').length || 1;
      var scrollRoot = innerDoc ? (innerDoc.scrollingElement || innerDoc.documentElement || innerDoc.body) : null;
      var scrollTop = scrollRoot ? Number(scrollRoot.scrollTop || 0) : 0;
      var scrollHeight = scrollRoot ? Number(scrollRoot.scrollHeight || 0) : 0;
      var clientHeight = scrollRoot ? Number(scrollRoot.clientHeight || 0) : 0;
      var maxScroll = Math.max(0, scrollHeight - clientHeight);
      var firstHeight = items[0] ? Math.max(1, Math.round(items[0].getBoundingClientRect().height + 16)) : 0;
      var currentPage = 1;
      if (items.length && innerDoc) {
        for (var i = 0; i < items.length; i++) {
          var itemTop = Number(items[i].offsetTop || 0);
          if (scrollTop + 40 >= itemTop) currentPage = i + 1;
        }
      } else if (firstHeight) {
        currentPage = Math.max(1, Math.min(totalPages, Math.floor(scrollTop / firstHeight) + 1));
      }

      return {
        key: this._extractFrameKey(doc, 'paged-doc'),
        finished: !!(win && win.finishFlag) || this._isDocumentFrameFinished(doc),
        currentPage: currentPage,
        totalPages: totalPages,
        atEnd: maxScroll <= 0 || scrollTop >= maxScroll - 40,
        scrollStep: function (targetPage) {
          var nextPage = targetPage || Math.min(totalPages, currentPage + 1);
          try {
            if (win && typeof win.setScrollTop === 'function') {
              win.setScrollTop(nextPage);
              return true;
            }
          } catch (e) {}
          try {
            if (scrollRoot && items.length && items[nextPage - 1]) {
              scrollRoot.scrollTop = Math.min(maxScroll, Number(items[nextPage - 1].offsetTop || 0));
              return true;
            }
            if (scrollRoot) {
              var stepTop = firstHeight ? Math.min(maxScroll, scrollTop + firstHeight) : maxScroll;
              scrollRoot.scrollTop = stepTop;
              return true;
            }
          } catch (e2) {}
          return false;
        }
      };
    },

    _buildScrollDocumentTask: function (doc) {
      var win = doc.defaultView;
      var scrollRoot = doc.scrollingElement || doc.documentElement || doc.body;
      var totalPages = doc.querySelectorAll('.pageNum').length || 1;
      var scrollTop = scrollRoot ? Number(scrollRoot.scrollTop || 0) : 0;
      var maxScroll = scrollRoot ? Math.max(0, Number(scrollRoot.scrollHeight || 0) - Number(scrollRoot.clientHeight || 0)) : 0;
      var currentPage = totalPages > 1 && maxScroll > 0 ? Math.max(1, Math.min(totalPages, Math.floor((scrollTop / maxScroll) * (totalPages - 1)) + 1)) : 1;

      return {
        key: this._extractFrameKey(doc, 'scroll-doc'),
        finished: this._isDocumentFrameFinished(doc),
        currentPage: currentPage,
        totalPages: totalPages,
        atEnd: maxScroll <= 0 || scrollTop >= maxScroll - 40,
        scrollStep: function () {
          try {
            if (scrollRoot) {
              var pageHeight = Math.max(200, Number(scrollRoot.clientHeight || 0) - 80);
              var nextTop = Math.min(maxScroll, scrollTop + pageHeight);
              if (win && typeof win.scrollTo === 'function') win.scrollTo(0, nextTop);
              else scrollRoot.scrollTop = nextTop;
              return true;
            }
          } catch (e) {}
          return false;
        }
      };
    },

    /**
     * 原生 PDF.js / aria 页码文档任务（真实平台结构，2026-10-31 从同类开源实现补入）。
     *
     * 结构：页码计数器 `#pageNumber` / `input[aria-label="页码"]`（PDF.js 标准，
     * 总页数在 `#numPages`），翻页按钮 `#next` / `button[aria-label="下一页"]`、
     * `#lastPage` / `button[aria-label="末页"]`。
     *
     * 完成语义与滚动任务一致：翻到末页（atEnd）≠ 完成，等平台自己的完成标记
     * （finishFlag / 帧完成标记）；迟迟不来由 documentSkipTimeoutMs 兜底跳过。
     */
    _buildAriaPagedDocumentTask: function (doc) {
      var counter = doc.querySelector('#pageNumber, input[aria-label="页码"], input[aria-label="Page"]');
      var nextBtn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
      if (!counter && !nextBtn) return null;

      var numPagesEl = doc.querySelector('#numPages');
      var total = 0;
      try {
        total = parseInt(numPagesEl && numPagesEl.textContent, 10) ||
          parseInt(counter && counter.getAttribute && (counter.getAttribute('max') || counter.getAttribute('aria-valuemax')), 10) || 0;
      } catch (e) {}
      if (!(total > 0)) total = 0; // 未知总页数：靠「下一页禁用」判定到尾

      var self = this;
      function readPage() {
        try {
          var v = parseInt(counter && counter.value, 10);
          if (v > 0) return v;
          var cur = doc.querySelector('[data-slide-current]');
          v = parseInt(cur && (cur.getAttribute('data-slide-current') || cur.textContent), 10);
          return v > 0 ? v : 1;
        } catch (e) { return 1; }
      }
      function nextDisabled() {
        try {
          var btn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
          if (!btn) return true;
          return btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true';
        } catch (e) { return false; }
      }

      return {
        key: self._extractFrameKey(doc, 'aria-paged-doc'),
        finished: !!(doc.defaultView && doc.defaultView.finishFlag) || self._isDocumentFrameFinished(doc),
        currentPage: readPage(),
        totalPages: total,
        atEnd: nextDisabled() || (total > 0 && readPage() >= total),
        scrollStep: function () {
          try {
            var btn = doc.querySelector('#next, button[aria-label="下一页"], [data-slide-next], button[title="下一页"]');
            if (!btn || btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true') return false;
            btn.click();
            return true;
          } catch (e) { return false; }
        }
      };
    },

    _handleDocumentTask: function (preferredDoc) {
      var now = Date.now();
      var task = this._locateDocumentTask(preferredDoc);
      if (!task) return false;

      if (!this._docTaskState || this._docTaskState.key !== task.key) {
        this._docTaskState = { key: task.key, lastActionAt: 0, settleAt: 0, lastPage: 0, stallAt: 0, lastProgressAt: now, startedAt: now };
      }

      var state = this._docTaskState;
      if (now - state.lastActionAt < 120) return true;
      state.lastActionAt = now;

      var skipTimeoutMs = Number(this.configs.documentSkipTimeoutMs || 120000);
      var progressAnchor = state.lastProgressAt || state.startedAt || now;
      if (skipTimeoutMs > 0 && now - progressAnchor >= skipTimeoutMs) {
        console.warn('[Omitone] document stuck timeout, skip current task after ' + skipTimeoutMs + 'ms');
        emitRuntimeLog('warn', 'document stuck timeout', { timeoutMs: skipTimeoutMs, key: task.key });
        if (this._activeDocumentJobManaged) {
          this._clearDocumentPendingState('document-timeout');
          return true;
        }
        this.nextUnit();
        return true;
      }

      if (task.finished) {
        state.settleAt = state.settleAt || now;
        if (now - state.settleAt > 150) {
          console.log('%c[Omitone] document done', 'color:#4CAF50');
          emitRuntimeLog('info', 'document done', { key: task.key });
          if (this._activeDocumentJobManaged) {
            // ⚠️ 这里以前只 clear 状态就 return true。
            //
            // 后果：_runChaoxingReadJob 的 document 分支只在**页面自己出现
            // finishJob** 时才 clear（见 'document-finishJob'），而大多数
            // PDF/WPS 文档页根本没有这个函数；于是任务真的读完了、
            // task.finished 也变真了，这个分支却只是把状态抹掉，
            // **永远不推进下一节** —— 表现就是「文档显示已完成，但卡在这一章不动」。
            //
            // 正确做法：清完状态后，跟非托管路径一样推进。
            this._clearDocumentPendingState('document-done');
            if (this.configs.autoNext) {
              this._skipChainCount++;
              this.nextUnit();
            }
            return true;
          }
          this.nextUnit();
        }
        return true;
      }

      state.settleAt = 0;
      if (task.currentPage !== state.lastPage) {
        state.lastPage = task.currentPage;
        state.lastProgressAt = now;
        state.stallAt = 0;
        console.log('%c[Omitone] document page ' + task.currentPage + '/' + task.totalPages, 'color:#2196F3');
        emitRuntimeLog('info', 'document page', { currentPage: task.currentPage, totalPages: task.totalPages, key: task.key });
      } else if (!task.atEnd) {
        if (!state.stallAt) state.stallAt = now;
        if (now - state.stallAt > 2200) {
          task.scrollStep(task.currentPage + 1);
          state.lastActionAt = now;
          state.stallAt = now;
          console.log('%c[Omitone] document stall recovery', 'color:#FF9800');
          emitRuntimeLog('warn', 'document stall recovery', { currentPage: task.currentPage, totalPages: task.totalPages, key: task.key });
          return true;
        }
      }

      if (task.atEnd) {
        task.scrollStep(task.totalPages);
        return true;
      }

      task.scrollStep(task.totalPages);
      return true;
    },

    /**
     * 投票任务点（附件 `module:"insertvote"` + `type:"vote"`）。
     *
     * ⚠️ 只能走平台自己的那一次点击。封面帧 `ananas/modules/zt/vote/index-pc-new.html`
     * 的内联脚本会现算出 `mooc-ans/api/work?...&type=vote&ktoken=…&enc=…`，把它写进
     * **顶层文档**的 `#voteIframe` 并 show `.voteContainer`（2026-11-11 真页实测）。
     * 直接访问那个地址是 403 —— enc 是服务端按 jobid 算的，抄不来也不该抄。
     *
     * 所以这里做的就是把用户那几下点出来：点封面 → 等覆盖层长出选项 →
     * 每组（按 input[name] 分）勾第一项 → 点提交 → 等平台把任务盒翻成
     * `ans-job-finished`（就是「下一节」放不放行那条判据，与 20-G 同源）。
     * 投票不计分，随手投一项就是完成任务点的全部要求。
     *
     * 每一步都可超时、都留证据；连续 VOTE_MAX_TRIES 次没翻旗就进 VOTE_COOLDOWN_MS
     * 冷却（到期自动再试，是"能解释、可恢复"的出口，不是永久跳过），
     * 免得把同一个投票的提交打成刷屏。
     */
    _runChaoxingVoteJob: async function (job) {
      if (!job) return false;
      // 与准入闸同一句写法：`=== false` 才是"用户关了"，
      // 老配置里**没有这一项**（undefined）必须照常投。
      if (this.configs.enableVote === false) {
        emitRuntimeLog('info', 'vote disabled, skip', { jobid: job.jobid, name: job.name });
        return true;
      }

      var boxBefore = this._voteBoxFinished(job);
      if (boxBefore === true) {
        emitRuntimeLog('info', 'vote already finished', { jobid: job.jobid, by: 'box-flag' });
        return true;
      }

      var cooled = this._voteTryCooledDown(job);
      if (cooled) {
        emitRuntimeLog('warn', 'vote cooling down', {
          jobid: job.jobid, tries: cooled.tries, retryInMs: cooled.retryInMs, last: cooled.last
        });
        return true;
      }

      var voteDoc = await this._openVoteOverlay(job);
      if (!voteDoc) {
        this._noteVoteTry(job, 'overlay');
        emitRuntimeLog('warn', 'vote overlay not ready', {
          jobid: job.jobid, hasCoverFrame: !!job.frame, hasCoverDoc: !!job.doc
        });
        return true;
      }

      var form = this._voteOverlayForm(voteDoc);
      if (!form.firsts.length && !form.submit) {
        // 覆盖层里既没有选项也没有提交键：多半是「已参与」或压根没有这道投票
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-form');
        emitRuntimeLog('warn', 'vote has nothing to submit', { jobid: job.jobid, text: form.text });
        return true;
      }

      var picked = this._pickVoteOptions(form);
      if (!picked.checked) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-check');
        emitRuntimeLog('warn', 'vote option not selectable', {
          jobid: job.jobid, groups: picked.groups, inputs: form.inputCount
        });
        return true;
      }

      if (!form.submit) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'no-submit');
        emitRuntimeLog('warn', 'vote submit button missing', {
          jobid: job.jobid, picked: picked.values.join(','), text: form.text
        });
        return true;
      }
      try {
        form.submit.click();
      } catch (eClick) {
        this._closeVoteOverlay(voteDoc);
        this._noteVoteTry(job, 'submit-throw');
        emitRuntimeLog('warn', 'vote submit click threw', { jobid: job.jobid, err: String(eClick && eClick.message || eClick).slice(0, 60) });
        return true;
      }

      var wait = await this._waitVoteBoxFinished(job, voteDoc);
      var boxAfter = this._voteBoxFinished(job);
      var ok = wait.by === 'box' || boxAfter === true;
      this._closeVoteOverlay(voteDoc);
      emitRuntimeLog(ok ? 'info' : 'warn', ok ? 'vote submitted' : 'vote submitted but box not finished', {
        jobid: job.jobid, picked: picked.values.join(','), groups: picked.checked,
        submitBy: form.submitBy, by: wait.by, waitedMs: wait.waitedMs, dismissed: wait.dismissed,
        boxBefore: boxBefore, boxAfter: boxAfter
      });
      if (ok) this._clearVoteTry(job); else this._noteVoteTry(job, 'not-finished');
      return true;
    },

    /**
     * 展开投票覆盖层并拿到它的文档；拿不到返回 null。
     *
     * 已经在顶层展开且就是这一份投票 → 直接复用，不再重复点封面。
     */
    _openVoteOverlay: async function (job) {
      var jobid = String(job && job.jobid || '');
      var ready = this._voteOverlayDocReady(jobid);
      if (ready) return ready;

      var cover = null;
      try {
        var d = job && job.doc;
        if (d) {
          cover = d.querySelector('#render') || d.querySelector('#cover') ||
            d.querySelector('.ans-cmp-icon') || d.querySelector('.ans-attach-cmp');
        }
      } catch (eFind) {}
      if (!cover) return null;
      try {
        cover.click();
      } catch (eClick) {
        return null;
      }

      var deadline = Date.now() + VOTE_OVERLAY_WAIT_MS;
      var waited = 0;
      while (Date.now() < deadline) {
        var doc = this._voteOverlayDocReady(jobid);
        if (doc) {
          this._tickProgress('vote overlay');
          return doc;
        }
        await sleep(500);
        waited += 500;
      }
      emitRuntimeLog('debug', 'vote overlay wait exhausted', { jobid: jobid, waitedMs: waited });
      return null;
    },

    /**
     * 顶层那份投票覆盖层现在能不能读。
     *
     * 四个条件缺一不可：`#voteIframe` 在、`.voteContainer` **可见**、文档已开出来、
     * **body 里真有字**。
     *
     * 可见这条不是洁癖 —— 收起状态里所有 `offsetParent` 都是 null，
     * 于是选项与提交键会一起被读成"不存在"，然后每轮都白点一次封面。
     *
     * 「有字」这条是 2026-11-11 真页实测补的：平台把 `#voteIframe` 的 src 写进顶层
     * 之后还要一段时间才把卷子填进去。上一轮这里只看到"框架在、可见、文档开着"
     * 就当就绪直接复用，跳过了点封面，于是
     * `vote has nothing to submit {"jobid":"9000000000000001","text":""}` ——
     * 正文明明是空的。空档期算"没就绪"，让上面那个轮询继续等／再点一次封面，
     * 比拿一份空卷子去判"这道题没得提交"准得多。
     */
    _voteOverlayDocReady: function (jobid) {
      var frame = null;
      try { frame = document.getElementById('voteIframe'); } catch (e0) { return null; }
      if (!frame) return null;
      try {
        var container = document.querySelector('.voteContainer');
        if (container && !container.offsetParent) {
          var display = '';
          try { display = String(window.getComputedStyle(container).display || ''); } catch (eCs) { display = ''; }
          if (display === 'none') return null;
        }
      } catch (e1) {}
      var doc = null;
      try { doc = frame.contentDocument; } catch (eCross) { return null; }
      if (!doc || !doc.body) return null;
      if (String(doc.readyState || '') === 'loading') return null;
      if (jobid && String(frame.src || '').indexOf(jobid) < 0) return null;
      if (!this._voteOverlayHasContent(doc)) return null;
      return doc;
    },

    /**
     * 投票覆盖层里是不是真写出了东西。
     *
     * 判据用"文字或选项任一存在"，不用"文字够长"：有些投票只有图标和两个
     * radio，正文文字短；反过来一份刚开出来的空文档两者都没有。
     */
    _voteOverlayHasContent: function (doc) {
      try {
        var text = '';
        try { text = String(doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ''); } catch (eTxt) { text = ''; }
        if (text.length > 0) return true;
        return !!(doc.querySelector && doc.querySelector(
          '.topic-option-list, .topic-options, input[type=radio], input[type=checkbox]'
        ));
      } catch (e) {
        return false;
      }
    },

    /**
     * 投票覆盖层的一份快照：选项按 name 分组取第一项、提交键、正文摘要。
     *
     * 选项只认两种形状（真页实测：`input[name=answer8000083064]` +
     * `.topic-option-list` 里一个 radio），别的 input 一律不当选项 ——
     * 覆盖层里还挂着「本地上传 / 从云盘选择」那些隐藏弹窗，里面也有 input。
     */
    _voteOverlayForm: function (voteDoc) {
      var out = { firsts: [], inputs: [], inputCount: 0, submit: null, submitBy: '', text: '' };
      var self = this;
      var all = [];
      try { all = [].slice.call(voteDoc.querySelectorAll('input[type=radio], input[type=checkbox]')); } catch (e0) {}
      out.inputs = all.filter(function (i) {
        if (!i || i.disabled) return false;
        var inTopic = false;
        try { inTopic = !!(i.closest && i.closest('.topic-option-list, .topic-options, .ans-qt-list')); } catch (e1) { inTopic = false; }
        return inTopic || /^answer/i.test(String(i.name || ''));
      });
      out.inputCount = out.inputs.length;
      var seen = {};
      out.inputs.forEach(function (i) {
        var key = String(i.name || i.type || 'q');
        if (seen[key]) return;
        seen[key] = true;
        out.firsts.push(i);
      });
      try {
        var cands = [].slice.call(voteDoc.querySelectorAll('a.btn-submit, a.jb_btn_92, button, a, input[type=button], input[type=submit]'));
        for (var c = 0; c < cands.length; c++) {
          var el = cands[c];
          var label = String((el.innerText || el.textContent || el.value) || '').replace(/\s+/g, '').slice(0, 12);
          var isSubmitClass = false;
          try { isSubmitClass = /btn-submit/.test(String(el.className || '')); } catch (e2) { isSubmitClass = false; }
          if (!isSubmitClass && !/^(提交|确定|投票|立即投票)$/.test(label)) continue;
          if (/^(取消|返回|关闭)$/.test(label)) continue;
          out.submit = el;
          out.submitBy = isSubmitClass ? 'class' : 'text';
          break;
        }
      } catch (e3) {}
      out.text = self._voteOverlayText(voteDoc);
      return out;
    },

    _voteOverlayText: function (voteDoc) {
      try {
        return String((voteDoc.body && (voteDoc.body.innerText || voteDoc.body.textContent)) || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch (e) {
        return '';
      }
    },

    /**
     * 每组勾第一项，勾完**读回 checked** 才算数。
     *
     * 「勾选证据」这条不是多余：真页实测 `.click()` 之后 `checked` 由 false 变 true，
     * 而沙盒里出过"根本没选就交上去"的症状（批次 19-A 记的那件事）。
     * 读不回来就当作没投出去，交给上层重试，绝不报"提交成功"。
     */
    _pickVoteOptions: function (form) {
      var values = [];
      var checked = 0;
      (form.firsts || []).forEach(function (input) {
        try { input.click(); } catch (eClick) {}
        if (!input.checked) {
          try { input.checked = true; } catch (eSet) {}
        }
        if (input.checked) {
          checked++;
          values.push(String(input.value || input.name || '').slice(0, 16));
        }
      });
      return { groups: (form.firsts || []).length, checked: checked, values: values };
    },

    _waitVoteBoxFinished: async function (job, voteDoc) {
      var deadline = Date.now() + VOTE_BOX_WAIT_MS;
      var waited = 0;
      var dismissed = 0;
      while (Date.now() < deadline) {
        if (this._voteBoxFinished(job) === true) return { by: 'box', waitedMs: waited, dismissed: dismissed };
        if (this._dismissVoteDialog(voteDoc)) dismissed++;
        await sleep(600);
        waited += 600;
        this._tickProgress('vote wait box');
      }
      return { by: 'timeout', waitedMs: waited, dismissed: dismissed };
    },

    /**
     * 「这个投票做完了没有」= 它所在任务盒带不带 `ans-job-finished`。
     *
     * 复用 20-G 那份判据（`_discussionBoxFinishedFlag`），不再抄第二份 ——
     * 平台「下一节」放不放行用的就是这条，图标 aria-label 是滞后的、不可信。
     * 返回 null = 读不到盒子（跨域 / 结构不同），调用方按"没确认"处理。
     */
    _voteBoxFinished: function (job) {
      try {
        var node = job && job.frame ? job.frame : null;
        if (!node && job && job.doc) {
          var w = null;
          try { w = job.doc.defaultView; } catch (eWin) { w = null; }
          try { node = w && w.frameElement; } catch (eFe) { node = null; }
        }
        return this._discussionBoxFinishedFlag(node);
      } catch (e) {
        return null;
      }
    },

    /**
     * 提交后可能弹出「已到截止时间，作答内容已自动提交」这类提示
     * （真页实测就在覆盖层里，默认隐藏，触发时才可见）。只点可见盒子里的
     * 「知道了 / 确定」，**不点提交** —— 那是重复交卷。
     */
    _dismissVoteDialog: function (voteDoc) {
      try {
        if (!voteDoc) return '';
        var boxes = [].slice.call(voteDoc.querySelectorAll('.popDiv, .maskDiv, .layui-layer'));
        for (var i = 0; i < boxes.length; i++) {
          var box = boxes[i];
          var visible = false;
          try { visible = !!box.offsetParent; } catch (eVis) { visible = false; }
          if (!visible) continue;
          var btn = null;
          [].forEach.call(box.querySelectorAll('a, button'), function (x) {
            var label = String((x.innerText || x.value) || '').replace(/\s+/g, '').slice(0, 10);
            if (!btn && /^(知道了|确定|确认)$/.test(label)) btn = x;
          });
          if (btn) {
            btn.click();
            return String(btn.innerText || btn.value || '').replace(/\s+/g, '').slice(0, 10);
          }
        }
      } catch (e) {}
      return '';
    },

    /**
     * 收起覆盖层。优先按平台自己的「返回」，它会把 `.voteContainer` 关回去；
     * 按不到才直接收起容器 —— 覆盖层一直挡着刷课页，后面的视频/讨论都点不着。
     */
    _closeVoteOverlay: function (voteDoc) {
      try {
        if (voteDoc) {
          var back = null;
          [].forEach.call(voteDoc.querySelectorAll('a, button'), function (x) {
            var label = String((x.innerText || x.textContent) || '').replace(/\s+/g, '');
            if (!back && /^返回$/.test(label)) back = x;
          });
          if (back) { back.click(); return 'back'; }
        }
      } catch (e) {}
      try {
        var container = document.querySelector('.voteContainer');
        if (container) { container.style.display = 'none'; return 'hide'; }
      } catch (e2) {}
      return 'none';
    },

    _voteTryKeyOf: function (job) {
      return String((job && (job.jobid || job.objectid)) || (job && job.name) || 'vote');
    },

    /** 记一次没成功的尝试；键是 jobid，同一章里多个投票各算各的。 */
    _noteVoteTry: function (job, reason) {
      if (!this._voteTryMap || typeof this._voteTryMap !== 'object') this._voteTryMap = {};
      var key = this._voteTryKeyOf(job);
      var prev = this._voteTryMap[key] || { n: 0, at: 0 };
      this._voteTryMap[key] = { n: Number(prev.n || 0) + 1, at: Date.now(), last: String(reason || '') };
    },

    _clearVoteTry: function (job) {
      try {
        if (this._voteTryMap) delete this._voteTryMap[this._voteTryKeyOf(job)];
      } catch (e) {}
    },

    /** 够次数就冷却，冷却到期自动放行 —— 返回 null 表示"可以再试"。 */
    _voteTryCooledDown: function (job) {
      var key = this._voteTryKeyOf(job);
      var rec = this._voteTryMap && this._voteTryMap[key];
      if (!rec) return null;
      var tries = Number(rec.n || 0);
      if (tries < VOTE_MAX_TRIES) return null;
      var age = Date.now() - Number(rec.at || 0);
      if (age >= VOTE_COOLDOWN_MS) {
        this._clearVoteTry(job);
        return null;
      }
      return { tries: tries, retryInMs: VOTE_COOLDOWN_MS - age, last: String(rec.last || '') };
    },


    /**
     * 进度心跳：**长任务的循环必须定期调它**。
     *
     * 看门狗原先判的是「tick 活了多久 > 150 秒」，那会误杀正常的长任务 ——
     * PPT 音频任务单页等待上限 600 秒（`_waitSlideAudioDone`），远超 150 秒。
     * 误杀的后果不是"少干点活"，而是**放锁后新一轮 tick 与仍在推进的旧 tick 并行**，
     * 同时操作同一个任务点（重复翻页 / 重复提交）。
     *
     * 改成「多久没有进展」之后语义才对：
     *   - 真挂起 → 循环不再推进 → 心跳不再刷新 → 150 秒后照旧放锁（防线没有放松）
     *   - 正常长任务 → 一直在推进 → 心跳持续刷新 → 不会被误杀
     *
     * 日志做 30 秒去重：这个函数会被每秒调用多次，不加节流会刷爆控制台。
     */
    _tickProgress: function (note) {
      try {
        var now = Date.now();
        this._tickProgressAt = now;
        var label = String(note || '');
        // 只在"换了阶段"或"距上次日志超过 30 秒"时打一条，兼作长任务耗时的观测点
        if (label !== this._tickProgressNote || now - (this._tickProgressLogAt || 0) > 30000) {
          this._tickProgressNote = label;
          this._tickProgressLogAt = now;
          var tickMs = this._tickStartedAt ? (now - this._tickStartedAt) : 0;
          emitRuntimeLog('info', 'tick progress', { note: label, tickMs: tickMs });
        }
      } catch (e) {}
    },

    _startTickLoop: function () {
      if (this._tickLoopInterval) return;
      var self = this;
      this._tickLoopInterval = setInterval(function () {
        if (!self._assertActive()) {
          self._clearTickLoop();
          return;
        }
        // 看门狗：判定「**多久没有进展**」而不是「tick 跑了多久」。
        //
        // 为什么是"无进展"：正常的长任务（PPT 音频逐页等待，上限 600 秒）会被
        // "总时长"判据误杀 —— 强行放锁后，新旧两个 tick 同时操作同一个任务点。
        // 心跳由长任务的循环主动刷新（见 _tickProgress），所以：
        //   有进展 → 不触发（这是本次修正的行为）
        //   真挂起 → 心跳停 → 150 秒后照旧触发（防线不变）
        // 兜底用 _tickStartedAt：兼容心跳尚未打过一次（字段为 0）的边界。
        var lastProgress = self._tickProgressAt || self._tickStartedAt;
        if (self._tickRunning && lastProgress && Date.now() - lastProgress > 150000) {
          // ⚠️ 必须先"作废"这次 tick 的复位权：它可能过一会儿才醒过来，
          //    醒来后无条件复位会把**新 tick 的锁**清掉 —— 于是下一轮又起一个 tick，
          //    两个 tick 并行推进（可能重复提交、重复跳章）。
          self._tickEpoch = (self._tickEpoch || 0) + 1;
          self._tickRunning = false;
          self._tickStartedAt = 0;
          self._tickProgressAt = 0;
          emitRuntimeLog('error', 'tick watchdog: stuck tick force-released, loop resumed', {});
          console.error('[Omitone] tick watchdog: stuck tick force-released');
        }
        self._runTick();
      }, 250);
      this._runTick();
    },

    _clearTickLoop: function () {
      if (this._tickLoopInterval) {
        clearInterval(this._tickLoopInterval);
        this._tickLoopInterval = null;
      }
      this._clearCheckInterval();
    },

    _runTick: async function () {
      if (this._tickRunning) return;
      this._tickRunning = true;
      var myEpoch = this._tickEpoch = (this._tickEpoch || 0) + 1;
      this._tickStartedAt = Date.now();
      // 心跳与 tick 同起点：看门狗判"无进展"，所以开始那一刻必须先刷一次，
      // 否则字段为 0 会走 _tickStartedAt 兜底（也能工作，但语义上应该显式初始化）
      this._tickProgressAt = this._tickStartedAt;
      // ⚠️ 这里**不要**复位 `_tickProgressNote`。
      // 它是日志节流用的"上次打了哪个阶段"；而 `_ensureOcsStudyRunner` 那个
      // **脱离 tick 的异步循环**每 1 秒就调一次 `_tickProgress('ocs study loop')`，
      // 而 `_runTick` 每 250ms 就复位一次 —— 于是"note 变了"这个条件永远成立，
      // 心跳日志变成每秒一条，把日志缓冲刷爆、盖住真正有用的条目（实测踩过）。
      // 只保留 30 秒时间窗节流，阶段真的变了（note 不同）时照样立刻打一条。
      try {
        // 讨论上下文（讨论区独立网址 / 讨论模块页）：发完评论自动返回，期间不做任何刷课动作。
        // 必须放在最前：讨论页不再被误判为课程页，否则会去"找任务点 → 跳章节"
        if (this._isDiscussionContext()) {
          await this._runDiscussionMode();
          return;
        }

        // 独立验证码页（验证码不在学习通界面内，而是独立网址 / 弹出窗口 / 被跳转到的验证页）：
        // 这类页面是顶层页面，插件能完整访问，直接识别填写，处理期间不做任何刷课动作
        if (this._isStandaloneCaptchaPage()) {
          await this._runStandaloneCaptchaMode();
          return;
        }

        // 验证码拦截检测放在最前：页面被验证码挡住时，其他一切（页面变更检测/跳过已完成/答题/播放）都不该继续
        var captchaDialog = null;
        try { captchaDialog = this._checkCaptchaDialog(); } catch (eCap) { captchaDialog = null; }
        if (captchaDialog) {
          if (!this._captchaBusy) await this._handleCaptchaDialog(captchaDialog);
          return;
        }

        // 主 iframe 被换成跨域页面（验证码/反作弊）：JS 完全无法访问，只能靠刷新恢复
        if (this._checkBlockedByCrossOrigin()) return;

        // 讨论页处理期间（已打开讨论标签）：刷课页完全暂停推进，等它关闭或超时再继续
        if (this._handleDiscussionWait()) return;

        // 讨论任务点：在本节其它任务（视频/题目）之前处理掉，处理完刷新章节再继续，
        // 避免和正在播放的视频抢进度
        if (await this._tryDiscussionTask()) return;

        try { this._detectPageChange(); } catch (ePage) {}
        var runtimeVersion = this._runtimeVersion || 0;

        if (this._skipIfCompleted()) {
          return;
        }

        var submitConfirm = this._checkSubmitConfirmDialog();
        if (submitConfirm) {
          this._handleSubmitConfirmDialog(submitConfirm);
          return;
        }

        if (this._monitorQuizSubmit()) {
          return;
        }

        // 必须走 _activePopupBlock 而不是 _checkPopupQuiz：
        // 弹题答不上来时弹窗不会消失，用 _checkPopupQuiz 会让这一支永远命中，
        // 后面的刷课逻辑（播放、跳章、放弃机制）一次都跑不到 —— 课程就此空转。
        var popup = this._activePopupBlock();
        if (popup) {
          await this._handlePopupQuiz(popup);
          this._resumeVideoAfterOverlay('popup');
          return;
        }

        // 弹题答完之后，播放器右下角会冒出「继续学习」，点了才回到正常播放页。
        // 必须放在弹题之后、播放逻辑之前 —— 顺序反了就会永远轮不到它。
        if (this._tryContinueStudyPrompt()) {
          this._resumeVideoAfterOverlay('continue-study');
          return;
        }

        if (this._ensureOcsStudyRunner()) {
          return;
        }

        var ocsStudyHandled = await this._runOcsStyleStudy(runtimeVersion);
        if (ocsStudyHandled) {
          return;
        }

        if (this._isPlaying) {
          var playingVideo = this._getVideoEl();
          if (playingVideo && !playingVideo.ended) {
            this._ensurePlaybackRate(playingVideo, "tick");
            return;
          }
          if (playingVideo && playingVideo.ended) {
            this._isPlaying = false;
            this._clearCheckInterval();
            this.nextUnit();
            return;
          }
          this._isPlaying = false;
          this._clearCheckInterval();
          this._videoEl = null;
        }

        var tasks = this._collectVisibleTaskFrames();
        if (tasks.length > 0) {
          this._taskDiscoverStartedAt = 0;
          this._taskWaitLogAt = 0;

          var unfinishedTasks = tasks.filter(function (task) { return !task.finished; });
          if (unfinishedTasks.length === 0) {
            if (this.configs.autoNext) this.nextUnit();
            return;
          }

          var activeTask = unfinishedTasks[0];
          console.log('[Omitone] active task type:', activeTask.type, activeTask.src || 'inline');

          if (activeTask.type === 'quiz') {
            // ⚠️ 同一张学习卡片里可能挂着**两份**测验任务点（实测：
            //    「专题五…单元测试」+「7.4…单元测试」）。这是页面级 `_quizAnswered`
            //    的已知盲区：交完第一份后它一直是 true，`_handleQuiz` 第一行就直接
            //    return —— 第二份永远不答。这里先按"这份卷子的身份"切一次状态；
            //    同一份卷子重复调用是空操作（键不变直接返回）。
            this._syncQuizPaperRunState(this._getQuizPaperKeyFromTask(activeTask), activeTask.doc || null);
            if (this._handlePendingTask(activeTask)) return;
            this._pendingTaskKey = '';
            this._pendingTaskStartedAt = 0;
            this._pendingTaskLogAt = 0;
            if (this._isQuizApiUnavailable()) {
              this._skipQuizForApiUnavailable(null, activeTask.doc || null);
              return;
            }
            if (this._monitorQuizSubmit(activeTask.doc || null)) return;
            if (this._prepareQuizRedoIfNeeded(activeTask.doc || null)) return;
            if (this._quizInProgress) return;
            if (!this._quizAnswered) {
              await this._handleQuiz(activeTask.doc || null);
            } else {
              this._maybeSubmitQuiz(activeTask.doc || null);
            }
            return;
          }

          if (this._handlePendingTask(activeTask)) return;
          this._pendingTaskKey = '';
          this._pendingTaskStartedAt = 0;
          this._pendingTaskLogAt = 0;

          if (activeTask.type === 'document') {
            if (this._handleDocumentTask(activeTask.doc || null)) return;
          }

          if (activeTask.type === 'video') {
            var video = this._getVideoEl();
            if (video) {
              this._skipChainCount = 0;
              this._isPlaying = true;
              this._ensurePlaybackRate(video, 'start');
              this._videoEventHandle();
              try {
                await this._withTimeout(video.play(), 12000);
                this._startVideoMonitoring();
              } catch (e2) {
                this._isPlaying = false;
                console.error('play failed:', e2 && e2.message ? e2.message : e2);
              }
              return;
            }
            return;
          }

          if (activeTask.type === 'other') {
            if (this._handleDocumentTask()) return;
            var fallbackVideo = this._getVideoEl();
            if (fallbackVideo) {
              this._skipChainCount = 0;
              this._isPlaying = true;
              this._ensurePlaybackRate(fallbackVideo, 'fallback');
              this._videoEventHandle();
              try {
                await this._withTimeout(fallbackVideo.play(), 12000);
                this._startVideoMonitoring();
              } catch (fallbackErr) {
                this._isPlaying = false;
              }
              return;
            }
            if (!this._isQuizApiUnavailable() && !this._quizAnswered && !this._quizInProgress && this._detectQuiz()) {
              await this._handleQuiz(activeTask.doc || null);
            }
            return;
          }

          return;
        }

        if (this._advanceLearningStep()) return;

        if (this._shouldWaitForTaskDiscovery('no-task-frames')) return;

        if (this._isTextOnly() && !this._hasTaskPoint()) {
          this._skipChainCount++;
          this.nextUnit();
          return;
        }
      } catch (err) {
        var errMsg = String((err && err.message) || err || '');
        var errStack = String((err && err.stack) || '')
          .split('\n').slice(0, 3).join(' | ').slice(0, 300);
        // 同一条错误 30 秒内只记一次：否则每 250ms 一条，会刷爆日志并盖住真正有用的信息
        var nowErr = Date.now();
        if (errMsg !== this._lastTickErrMsg || nowErr - (this._lastTickErrAt || 0) > 30000) {
          this._lastTickErrMsg = errMsg;
          this._lastTickErrAt = nowErr;
          this._lastTickErrCount = 1;
          emitRuntimeLog('error', 'tick error', { message: errMsg.slice(0, 200), stack: errStack });
        } else {
          this._lastTickErrCount = (this._lastTickErrCount || 0) + 1;
        }
        console.error('tick error:', err);
      } finally {
        // ⚠️ 只有**仍然持有锁**的那一次才允许复位。
        // 看门狗可能在 150 秒后把锁强制释放并交给新的 tick；若这次（旧的）此刻才醒来，
        // 无条件复位会清掉新 tick 的锁 → 下一轮再起一个 tick → 两个 tick 并行。
        // 正常路径下 epoch 必然相等，行为与改动前完全一致。
        if (this._tickEpoch === myEpoch) {
          this._tickRunning = false;
          this._tickStartedAt = 0;
          // 心跳也要一起清：留着旧值会让下一轮 tick 一开始就"看起来很久没进展"
          this._tickProgressAt = 0;
        }
      }
    },

    _tick: async function () {
      return this._runTick();
    },

    _taskGiveUpMap: function () {
      try {
        var raw = localStorage.getItem(this._taskGiveUpStoreKey);
        var parsed = raw ? this._safeJsonParse(raw, {}) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    },

    /** 任务点的稳定标识：优先 jobid/objectid，兜底用 module + 名称 */
    _taskPointKey: function (job) {
      if (!job) return '';
      var att = job.attachment || {};
      var prop = att.property || {};
      var id = job.jobid || att.jobid || prop._jobid || prop.jobid ||
        job.objectid || att.objectId || prop.objectid;
      if (id) return 'job:' + String(id);
      var module = String(prop.module || att.module || '');
      var name = String(job.name || '').slice(0, 40);
      if (!module && !name) return '';
      return 'nm:' + module + '|' + name;
    },

    _isTaskGivenUp: function (key) {
      if (!key) return false;
      var record = this._taskGiveUpMap()[key];
      if (!record || !record.at) return false;
      return Date.now() - Number(record.at) < 24 * 3600 * 1000;
    },

    _markTaskGivenUp: function (key, info) {
      if (!key) return;
      try {
        var map = this._taskGiveUpMap();
        map[key] = {
          at: Date.now(),
          name: String((info && info.name) || '').slice(0, 60),
          reason: String((info && info.reason) || ''),
          attempts: Number((info && info.attempts) || 0)
        };
        localStorage.setItem(this._taskGiveUpStoreKey, JSON.stringify(map));
      } catch (e) {}
    },

    /** 用户在控制台里可以清掉放弃记录，让插件重新尝试这些任务点 */
    _clearTaskGiveUp: function () {
      try { localStorage.removeItem(this._taskGiveUpStoreKey); } catch (e) {}
      this._taskAttempts = {};
      this._taskProgress = null;
    },

    _taskGiveUpList: function () {
      var map = this._taskGiveUpMap();
      var now = Date.now();
      return Object.keys(map).map(function (key) {
        var record = map[key] || {};
        return {
          key: key,
          name: record.name || '',
          reason: record.reason || '',
          attempts: record.attempts || 0,
          ageMinutes: Math.round((now - Number(record.at || 0)) / 60000),
          expired: now - Number(record.at || 0) >= 24 * 3600 * 1000
        };
      });
    },

    /**
     * 任务点是否真的完成了。
     * **拿不准就返回 true** —— 这个函数的返回值会喂给"放弃计数"，
     * 误判成"没完成"会把必做任务点跳过，比多跑一次严重得多。
     */
    _isJobCompleted: function (job) {
      if (!job) return true;
      try {
        if (job.doc) {
          if (this._isDocumentFrameFinished(job.doc)) return true;
          if (this._isQuizPassedOrFinished(job.doc)) return true;
        }
        var frame = job.frame;
        var wrap = job.wrap || (frame && frame.parentElement);
        if (wrap && wrap.classList && wrap.classList.contains('ans-job-finished')) return true;
        if (wrap && wrap.querySelector && wrap.querySelector('.ans-job-finished, .job-color')) return true;
      } catch (e) {
        return true;
      }
      return false;
    },

    /**
     * 任务点的"进度快照"。
     *
     * 这个函数是"做不完就放弃"机制的**安全阀**：只有当同一个任务点连续两次
     * 快照**完全一致**时才认定它卡住了；探测不到进度就返回空串，调用方一律不计。
     *
     * 为什么不能简单地用"没完成"来计数：长视频一次本来就跑不完，
     * `_isJobCompleted` 会一直返回 false，按"没完成"计数会让**必做任务点被误跳过** ——
     * 那比多花点时间严重得多。
     */
    _taskProgressSnapshot: function (job) {
      if (!job) return '';
      try {
        var doc = job.doc;
        if (!doc || !doc.querySelector) return '';

        var media = doc.querySelector('video, audio');
        if (media) return 'media:' + Math.floor(Number(media.currentTime || 0));

        // 只有**确实可滚动**的文档才用 scrollTop 当进度。
        // 否则"不可滚动的页面"会给出恒定的 scroll:0，看起来和"卡住"一模一样，
        // 于是每一次重派都被计成一次卡住 —— 这是把"测不到"误当成"没进展"。
        var scroller = doc.scrollingElement || doc.documentElement;
        if (scroller) {
          var scrollable = Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0);
          if (scrollable > 20) return 'scroll:' + Math.floor(Number(scroller.scrollTop || 0));
        }
      } catch (e) {}
      return '';
    },

    /**
     * 记录一次"派发了但没完成"。
     *
     * ⚠️ 调用方必须已经确认"确实卡住"（见 _taskProgressSnapshot 的说明）。
     * 达到上限就记入放弃列表。
     */
    _countTaskIncomplete: function (job, reason) {
      var key = this._taskPointKey(job);
      if (!key) return;
      if (!this._taskAttempts) this._taskAttempts = Object.create(null);

      this._taskAttempts[key] = (this._taskAttempts[key] || 0) + 1;
      var attempts = this._taskAttempts[key];
      var limit = Math.max(1, Number(this.configs.taskGiveUpAttempts || 4));

      if (attempts < limit) {
        emitRuntimeLog('info', 'task point stuck, will retry', {
          name: String(job.name || '').slice(0, 40),
          attempts: attempts,
          limit: limit,
          reason: reason || ''
        });
        return;
      }

      this._markTaskGivenUp(key, { name: job.name, reason: reason || 'incomplete', attempts: attempts });
      emitRuntimeLog('warn', 'task point given up (stuck without progress)', {
        name: String(job.name || '').slice(0, 40),
        attempts: attempts,
        reason: reason || '',
        hint: '该任务点可能被设为防拖拽/不可翻页，或本身不计分。24 小时内不再尝试；控制台 xxtAI.clearTaskGiveUp() 可清除'
      });
    },

    _getExplicitActiveLearningCardKey: function () {
      var cards = this._getLearningCards();
      if (!cards.length) return '';

      for (var i = 0; i < cards.length; i++) {
        var cls = String(cards[i].className || '');
        var selected = /\bactive\b/.test(cls) ||
          (cards[i].getAttribute && String(cards[i].getAttribute('aria-selected') || '') === 'true') ||
          !!(cards[i].querySelector && cards[i].querySelector('.active, .on, .current, [aria-selected="true"]'));
        if (!selected) continue;

        var marker = cards[i].getAttribute ? [
          cards[i].getAttribute('cardid') || '',
          cards[i].id || '',
          cards[i].getAttribute('onclick') || '',
          this._getLearningCardText(cards[i])
        ].join('|') : this._getLearningCardText(cards[i]);
        return [i, marker].join('|').slice(0, 300);
      }
      return '';
    },

    _detectLearningCardChange: function () {
      var key = this._getExplicitActiveLearningCardKey();
      if (!key) return;
      if (this._lastLearningCardKey && this._lastLearningCardKey !== key) {
        this._resetRuntimeState();
        emitRuntimeLog('info', 'learning card changed, reset pending state');
      }
      this._lastLearningCardKey = key;
    },

    _getLearningCards: function () {
      var cards = [];
      try {
        cards = Array.from(document.querySelectorAll([
          '#prev_tab .prev_ul li',
          '#prev_tab li[cardid]',
          '#prev_tab li[onclick*="changeDisplayContent"]',
          '.prev_list .prev_ul li',
          '.prev_list li[cardid]',
          '.prev_list li[onclick*="changeDisplayContent"]',
          '.prev_select_con li[cardid]',
          '.prev_select_con li[onclick*="changeDisplayContent"]',
          'li[id^="dct"][cardid]',
          'li[id^="dct"][onclick*="changeDisplayContent"]'
        ].join(',')));
      } catch (e) {}

      var seen = [];
      var self = this;
      return cards.filter(function (card) {
        if (!card || card.tagName !== 'LI') return false;
        if (seen.indexOf(card) !== -1) return false;
        seen.push(card);
        var marker = String((card.getAttribute && (card.getAttribute('cardid') || card.getAttribute('onclick') || card.id)) || '');
        var text = self._getLearningCardText(card);
        if (!marker && !/视频|测验|测试|作业|考试|答题|习题|讨论|资料|文档|阅读/.test(text)) return false;
        return true;
      });
    },

    _getLearningCardText: function (card) {
      if (!card) return '';
      return [
        textOf(card),
        card.getAttribute ? (card.getAttribute('title') || '') : '',
        card.getAttribute ? (card.getAttribute('aria-label') || '') : ''
      ].join(' ').replace(/\s+/g, '');
    },

    _getActiveLearningCardIndex: function (cards) {
      for (var i = 0; i < cards.length; i++) {
        var cls = String(cards[i].className || '');
        if (/\bactive\b/.test(cls)) return i;
        if (cards[i].getAttribute && String(cards[i].getAttribute('aria-selected') || '') === 'true') return i;
        if (cards[i].querySelector && cards[i].querySelector('.active, .on, .current, [aria-selected="true"]')) return i;
      }

      var currentType = this._getCurrentVisibleLearningTaskType();
      if (currentType) {
        for (var j = 0; j < cards.length; j++) {
          var text = this._getLearningCardText(cards[j]);
          if (currentType === 'video' && /视频|学习视频/.test(text)) return j;
          if (currentType === 'quiz' && this._isAssessmentLearningCard(cards[j])) return j;
        }
      }
      return -1;
    },

    _getCurrentVisibleLearningTaskType: function () {
      try {
        var tasks = this._collectVisibleTaskFrames();
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i] && !tasks[i].finished && tasks[i].type) return tasks[i].type;
        }
        for (var j = 0; j < tasks.length; j++) {
          if (tasks[j] && tasks[j].type) return tasks[j].type;
        }
      } catch (e) {}

      var video = this._getVideoEl();
      if (video) return 'video';
      if (this._detectQuiz()) return 'quiz';
      return '';
    },

    _isAssessmentLearningCard: function (card) {
      var text = this._getLearningCardText(card);
      return /测验|测试|作业|考试|答题|习题/.test(text);
    },

    _looksLikeVideoLearningCard: function (card) {
      return /视频|学习视频/.test(this._getLearningCardText(card));
    },

    _findFallbackNextLearningCardIndex: function (cards) {
      if (!cards || cards.length <= 1) return -1;

      var videoIndex = -1;
      for (var i = 0; i < cards.length; i++) {
        if (videoIndex < 0 && this._looksLikeVideoLearningCard(cards[i])) videoIndex = i;
        if (this._isAssessmentLearningCard(cards[i])) {
          if (videoIndex >= 0 && i > videoIndex) return i;
        }
      }

      var currentTitle = this._getCurrentTitle();
      if (!/测验|测试|作业|考试|答题|习题/.test(currentTitle)) {
        for (var j = 0; j < cards.length; j++) {
          if (this._isAssessmentLearningCard(cards[j])) return j;
        }
      }
      return -1;
    },

    _switchToNextLearningCard: function (reason) {
      var cards = this._getLearningCards();
      if (cards.length <= 1) return false;

      var activeIndex = this._getActiveLearningCardIndex(cards);
      var targetIndex = activeIndex >= 0 && activeIndex < cards.length - 1 ? activeIndex + 1 : this._findFallbackNextLearningCardIndex(cards);
      if (targetIndex < 0 || targetIndex >= cards.length) return false;
      if (activeIndex >= 0 && targetIndex === activeIndex) return false;

      var now = Date.now();
      if (this._lastLearningTabSwitchAt && now - this._lastLearningTabSwitchAt < scaledMs(Number(this.configs.stepSwitchGraceMs || 7000))) {
        return true;
      }

      var nextCard = cards[targetIndex];
      if (!nextCard) return false;

      this._lastLearningTabSwitchAt = now;
      this._clearMediaPendingState('switch-learning-card');

      try {
        var clickTarget = nextCard.querySelector ? (nextCard.querySelector('.prev_white, a, [role="option"], [role="button"]') || nextCard) : nextCard;
        try { clickTarget.click(); } catch (clickErr) { nextCard.click(); }
        emitRuntimeLog('info', 'switch learning card before next unit', {
          reason: reason || '',
          from: activeIndex + 1,
          to: targetIndex + 1,
          text: this._getLearningCardText(nextCard)
        });
      } catch (e) {
        return false;
      }

      this._resetRuntimeState();
      this._lastLearningTabSwitchAt = now;
      this._stepSwitchPending = true;
      this._stepSwitchAt = now;

      var self = this;
      setTimeout(function () {
        try {
          self._initCellData();
          self.play();
        } catch (e2) {}
      }, Number(this.configs.stepSwitchInitDelayMs || 2200));

      return true;
    },

    nextUnit: function () {
      if (!this._assertActive()) return;
      if (!this.configs.autoNext) return;
      if (this._isActiveMediaPending('next-unit')) return;
      // 冷却窗口内**放行离开**：这里问的是「能不能走」，不是「这一卷要不要暂停」，
      // 所以不比卷子键（`_isQuizForceSkipping()` 无参调用算出来的是另一个文档的键，
      // 会把 nextUnit 拦在 hold 上 —— 见 `_isQuizSkipWindowLive` 的注释）。
      if (!this._isQuizSkipWindowLive() && this._shouldHoldQuizBeforeNext('next-unit')) return;
      if (this._switchToNextLearningCard('next-unit')) return;
      this._dismissPopups();
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) nextButton.click();
      } catch (e) {}
      this._resetRuntimeState();
    },

    _advanceLearningStep: function () {
      if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < scaledMs(Number(this.configs.stepSwitchGraceMs || 7000))) return true;
      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1 || title === '视频') return false;
      var cards = this._getLearningCards();
      var activeIndex = this._getActiveLearningCardIndex(cards);
      if (activeIndex > 0) return false;
      if (activeIndex >= 0 && this._isAssessmentLearningCard(cards[activeIndex])) return false;
      var tabs = Array.from(document.querySelectorAll('.prev_white'));
      for (var i = 0; i < tabs.length; i++) {
        if (!visible(tabs[i])) continue;
        var tabText = textOf(tabs[i]).replace(/\s+/g, '');
        if (tabText === '2视频' || tabText === '视频') {
          this._stepSwitchPending = true;
          this._stepSwitchAt = Date.now();
          tabs[i].click();
          return true;
        }
      }
      return false;
    },

    _bindStepNavigation: function () {
      if (this._stepNavigationBound) return;
      this._stepNavigationBound = true;

      document.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target.closest([
          '.prev_white',
          '#prev_tab .prev_ul li',
          '#prev_tab li[cardid]',
          '.prev_list li[cardid]',
          '.prev_select_con li[cardid]',
          'li[id^="dct"][cardid]'
        ].join(',')) : null;
        if (!target) return;
        var text = textOf(target).replace(/\s+/g, '');
        if (!/视频|测验|测试|作业|考试|答题|习题|讨论|资料|文档|阅读/.test(text)) return;
        app._resetRuntimeState();
        app._stepSwitchPending = true;
        app._stepSwitchAt = Date.now();
        setTimeout(function () {
          // 慢机上切换学习卡片是异步渲染：固定 2.2 秒后 DOM 可能还是空的，
          // _initCellData 抓到空树，之后就一直 attachments:0、后面的题全不做。
          // 先等「文档加载完 + 章节树容器出现」，等不到按超时兜底继续，绝不死等。
          waitForReady(function () {
            try { return document.readyState === 'complete' && !!app._getTreeContainer(); }
            catch (eTree) { return false; }
          }, Number(app.configs.taskDiscoverGraceMs || 8000)).then(function () {
            try { app._initCellData(); } catch (eInit) {}
            app.play();
          });
        }, scaledMs(Number(app.configs.stepSwitchInitDelayMs || 2200)));
      });
    },

    _initCellData: function () {
      var tree = this._getTreeContainer();
      var rootUl = tree ? (tree.querySelector(':scope > ul') || tree.querySelector('ul')) : null;
      var cells = rootUl ? Array.from(rootUl.children).filter(function (node) { return node.tagName === 'LI'; }) : [];
      this._cellData.cells = cells.length;
      this._cellData.nCells = 0;
      this._cellData.currentCellIndex = 0;
      this._cellData.currentNCellIndex = 0;
      this._cellData.currentVideoTitle = '';

      for (var i = 0; i < cells.length; i++) {
        var nCells = Array.from(cells[i].querySelectorAll('.posCatalog_select:not(.firstLayer)'));
        this._cellData.nCells += nCells.length;
        for (var j = 0; j < nCells.length; j++) {
          if (nCells[j].classList.contains('posCatalog_active')) {
            this._cellData.currentCellIndex = i;
            this._cellData.currentNCellIndex = j;
            var titleSpan = nCells[j].querySelector('.posCatalog_name');
            this._cellData.currentVideoTitle = titleSpan ? (titleSpan.getAttribute('title') || textOf(titleSpan)) : '';
          }
        }
      }
    },

    _getTreeContainer: function () {
      if (!this._treeContainerEl) {
        this._treeContainerEl = document.querySelector('#coursetree');
      }
      return this._treeContainerEl;
    },

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


    /**
     * 这个节点是哪个模块（批次 52）。
     *
     * 现场有两代渲染，都在 2026-11-14 用只读探针在同一次会话里量到：
     *   A `…/mooc-ans/knowledge/cards` 里
     *     `<iframe class="ans-module ans-insertbbs-module" module="insertbbs" data="{…}">`
     *     —— 模块名写在 **module 属性**上（这一代连 src 都没有，内容全靠页面 JS 后填）。
     *   B 另一门课的同一份 cards 文档里 `[module]` 数出来是 **0**，任务盒里的模块 iframe
     *     是 `<iframe src="/ananas/modules/video/index.html?…" class="ans-attach-online ans-insertvideo-online" data="{…}">`
     *     —— 模块名**只写在 class 上**。
     * 原先只按 `iframe[module]` 找，遇到 B 这一代一条都匹配不到，讨论任务点在刷课页侧
     * 就变成"这一节没有讨论"（静默漏做）。
     *
     * 只认讨论系的名字（insertbbs / bbscircle / bbs），别的模块一律返回空串 ——
     * 拿 class 里任意一段当模块名会把 video、work 都拖进来。
     */
    _discussionModuleName: function (el) {
      if (!el || !el.getAttribute) return '';
      var name = String(el.getAttribute('module') || '').trim();
      if (name) return name;
      var cls = String(el.getAttribute('class') || '');
      var m = cls.match(/(?:^|[\s_-])(insertbbs|bbscircle|bbs)(?=[\s_-]|$)/i);
      return m ? m[1] : '';
    },


    // 卡片还没渲染时的退路：找讨论模块 iframe（module=insertbbs），它带着 mid / jobid / 标题
    // ⚠️ 必须按**节点**去重（批次 52）：`_studyDocs()` 回的是 `[主帧文档, 顶层文档]`，
    //    而 `_walkDocs` 的 `seen` 是**每次调用各自一份** —— 从顶层那一路再走进主帧文档时，
    //    同一枚模块 iframe 会被第二次收集。摘掉这道去重实测就是翻倍（沙盒夹具 3 枚 → `mods:6`、
    //    `discussion all settled` 的 total 一起翻），现场那一节按 jobid 去重后有 3 枚不同的讨论 ——
    //    于是第 2 步对同一份章节页发两遍请求（最坏 2×15 秒）。
    _findDiscussionModuleFrames: function () {
      var self = this;
      var out = [];
      var taken = [];
      var docs = this._studyDocs();
      for (var d = 0; d < docs.length; d++) {
        this._walkDocs(docs[d], function (doc) {
          var frames = [];
          try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e1) { return; }
          for (var i = 0; i < frames.length; i++) {
            if (taken.indexOf(frames[i]) >= 0) continue;
            var name = self._discussionModuleName(frames[i]);
            if (!/insertbbs|bbs|discuss/i.test(name)) continue;
            taken.push(frames[i]);
            out.push({
              frame: frames[i],
              module: name,
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


    /**
     * 「模块找到了、话题地址却没解出来」——把断掉的那一环点名（批次 52）。
     *
     * 这条链原先有四个出口全部 `return ''`（读不到 #frame_content、没有 mid、请求没回、
     * 回来了但卡片正则没命中），而 `_findDiscussionTask` 对空串只会 `continue`。
     * 于是现场日志里**一个字都没有**：讨论任务点没做、也没说为什么。
     *
     * ⚠️ 节流**按理由各记一笔**（与批次 37 同族）：原先只有一个槽位记「上一条的理由」，
     * 而一节里几个讨论模块的失败理由常常不一样（一个没 mid、一个章节页没回、一个平台已记完成），
     * `_tryDiscussionTask` 每 3 秒就把它们挨个再走一遍 —— 理由轮着换，槽位永远对不上，
     * 于是每一条都被播出去，200 条的日志环几分钟就被同一件事刷满（实测：换个理由立刻又出一条）。
     * 现在同一个理由 90 秒内只播一条，不同理由各自 90 秒；五分钟没人再提的理由顺手剪掉，
     * 免得这张表只增不减。
     */
    _logDiscussionResolveFail: function (reason, info) {
      var now = Date.now();
      var memo = this._discussionResolveFailLog || {};
      if (now - Number(memo[reason] || 0) < 90000) return;
      var next = {};
      Object.keys(memo).forEach(function (k) {
        if (k !== reason && now - Number(memo[k] || 0) < 300000) next[k] = memo[k];
      });
      next[reason] = now;
      this._discussionResolveFailLog = next;
      var payload = { reason: reason };
      Object.keys(info || {}).forEach(function (k) { payload[k] = info[k]; });
      payload.hint = '讨论模块 iframe 找到了，但话题地址没解出来 —— reason: ' +
        'no-chapter-url=既没读到内层 #frame_content 也没有 data.mid；' +
        'fetch-failed=章节页请求没回或超时；' +
        'no-topic-card=章节页回来了但里面没有 #topicMainDiv[data]；' +
        'server-says-finished=平台自己写了「这个讨论已做完」（章节页 #isFinished=true），不再重复发帖';
      emitRuntimeLog('warn', 'discussion topic url not resolved', payload);
    },


    /**
     * 章节页解析结果的缓存（批次 54）。
     *
     * 为什么必须有：`_tryDiscussionTask` 每 3 秒一轮，而第 2 步 `_findDiscussionTask`
     * 对**每一枚**讨论模块各调一次 `_resolveDiscussionUrlFromModule` —— 每次一发
     * `fetch(章节页)`。现场那一代（2026-11-14 量过：模块全部没有 src，第 1 步数不出卡片）
     * 只要这几枚讨论**都已做完**，每一轮就全部返回空串、`return null`，下一轮原样重来 ——
     * 3 枚模块 = **每分钟 60 发请求打在平台上，永不停**，用户只是挂着那一页而已。
     *
     * 两档有效期，按「这个结论会不会自己变」分：
     *   · `url` / `finished` 各 10 分钟 —— 话题地址是服务端写死的；平台说「已完成」
     *     短期内也不会翻回去（真要翻，10 分钟后照样重新量到）；
     *   · `empty` 30 秒 —— 「章节页里还没卡片」「这一发没回数据」都会自己变（懒渲染、
     *     网络抖动），不能按成功那一档冻 10 分钟，否则就成了"悄悄跳过任务点"。
     *
     * ⚠️ 键是**章节页绝对地址**，不是模块：同一枚讨论换个 `utenc` 就是另一个键，
     * 那种情况下多抓一次是正确行为（平台换了说法，就该重新读）。
     */
    _DISCUSSION_CHAPTER_TTL: { ok: 600000, bad: 30000 },


    /** 命中就返回那条缓存；过期就地删掉并返回 null（下次重抓）。 */
    _discussionChapterCached: function (abs) {
      var c = this._discussionChapterCache;
      if (!c) return null;
      var e = c[abs];
      if (!e) return null;
      var ttl = (e.kind === 'url' || e.kind === 'finished') ?
        this._DISCUSSION_CHAPTER_TTL.ok : this._DISCUSSION_CHAPTER_TTL.bad;
      if (Date.now() - (e.at || 0) > ttl) {
        delete c[abs];
        return null;
      }
      return e;
    },


    /** 写一条解析结果，顺带把已过期的清掉（防止换了几十个章节后缓存只涨不落）。 */
    _discussionChapterRemember: function (abs, kind, url) {
      var c = this._discussionChapterCache || (this._discussionChapterCache = {});
      var now = Date.now();
      var self = this;
      Object.keys(c).forEach(function (k) {
        var e = c[k];
        var ttl = (e.kind === 'url' || e.kind === 'finished') ?
          self._DISCUSSION_CHAPTER_TTL.ok : self._DISCUSSION_CHAPTER_TTL.bad;
        if (now - (e.at || 0) > ttl) delete c[k];
      });
      c[abs] = { at: now, kind: kind, url: url || '' };
      return c[abs];
    },


    // 从讨论模块 iframe → 内嵌 #frame_content → 取回页面 HTML → 解析出讨论区地址
    _resolveDiscussionUrlFromModule: async function (mod) {
      if (!mod || !mod.frame) return '';
      var data = mod.data || {};
      var trace = {
        module: String(mod.module || ''),
        hasMid: !!data.mid,
        hasJobid: !!(data.jobid || data._jobid),
        isJob: data.isJob === true
      };
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
      if (!chapterSrc) {
        this._logDiscussionResolveFail('no-chapter-url', trace);
        return '';
      }
      var abs = chapterSrc;
      try { abs = new URL(chapterSrc, location.href).href; } catch (e1) {}
      trace.chapterUrl = String(abs).slice(0, 120);
      // 先问缓存（批次 54）：命中就一发请求都不发。`serverFinished` 仍要写回**这一枚**
      // 模块对象上 —— 调用方每轮重新 `_findDiscussionModuleFrames()`，拿到的是新包装对象，
      // 它读的是 `modules[i].serverFinished`，不是缓存里那份。
      var hit = this._discussionChapterCached(abs);
      if (hit) {
        this._discussionChapterCacheHits = (this._discussionChapterCacheHits || 0) + 1;
        if (hit.kind === 'url') return String(hit.url || '');
        if (hit.kind === 'finished') mod.serverFinished = true;
        return '';
      }
      var resp = null;
      this._discussionChapterFetches = (this._discussionChapterFetches || 0) + 1;
      try {
        // ⚠️ 同样必须可超时：本函数在 _runTick 的讨论任务点链路上（`await _tryDiscussionTask()`），
        //    服务端不回数据时 await 会永久挂起。外层的 try/catch **拦不住挂起** —— 只有超时能。
        resp = await this._withTimeout(fetch(abs, { credentials: 'include' }), 15000);
      } catch (e2) { resp = null; }
      var html = null;
      if (resp && resp.text) {
        try { html = await this._withTimeout(resp.text(), 15000); } catch (e3) { html = null; }
      }
      if (typeof html !== 'string' || !html) {
        this._discussionChapterRemember(abs, 'empty');
        this._logDiscussionResolveFail('fetch-failed', trace);
        return '';
      }
      var m = html.match(/id=["']topicMainDiv["'][^>]*\bdata=["']([^"']+)["']/i) ||
        html.match(/\bdata=["'](https?:\/\/groupweb\.chaoxing\.com\/course\/topic[^"']+)["']/i);
      if (!m) {
        trace.htmlChars = html.length;
        this._discussionChapterRemember(abs, 'empty');
        this._logDiscussionResolveFail('no-topic-card', trace);
        return '';
      }
      /**
       * 平台在这份章节页里写了自己的说法（2026-11-14 实测）：
       *   `<input type="hidden" id="isFinished" value="true"/>`，
       *   而它自己的脚本就是拿这个值往父帧 `postMessage({opType:"completeTopic"})`。
       * ⚠️ 为什么只有这里读得到：这一代（2026-11-14 那门课的 3 个讨论）模块 iframe **没有 src**，
       *    话题卡片不在活的文档里，第 1 步 `_collectDiscussionTargets` 自然数不出它 ——
       *    不读这一句，等于"本地没记过 → 对着一个平台已判做完的话题再发一条回帖"。
       * 只认明确的 `true`：空值（批次 20-G 那一代实测就是空串）与缺失一律照常返回地址 ——
       * 拿不准时不许悄悄跳过任务点（AGENTS §2 #6/#7）。
       */
      var fin = html.match(/id=["']isFinished["'][^>]*\bvalue=["']([^"']*)["']/i);
      if (fin && String(fin[1]).toLowerCase() === 'true') {
        trace.serverFinished = true;
        // 把这枚模块**自己**也标上：调用方（`_findDiscussionTask` 第 2 步）要靠它把
        // 「平台说做完了」那一格记进「这一节的讨论都处理完了」那本账，而不是当成断链
        mod.serverFinished = true;
        this._discussionChapterRemember(abs, 'finished');
        this._logDiscussionResolveFail('server-says-finished', trace);
        return '';
      }
      var topicUrl = String(m[1]).replace(/&amp;/g, '&');
      this._discussionChapterRemember(abs, 'url', topicUrl);
      return topicUrl;
    },


    /**
     * 「这一节的讨论任务点都算处理完了」的**依据**（批次 20-D）。
     *
     * 为什么专门写一条：这个出口原本直接 `return null`，于是"三个话题真发过了"和
     * "三个话题全被重试预算挡在外面"（20-A 之前的实际现场）留下一模一样的空白 ——
     * 用户只看到讨论没做、日志里啥也没有。分类计数直接指出是哪一类。
     * 60 秒最多播一条：`_tryDiscussionTask` 每 3 秒就会走到这里一次。
     * ⚠️ 批次 52 起**第 2 步（从模块 iframe 解地址）也喂它**：2026-11-14 现场那一代模块全部没有
     * src、只走第 2 步，这句话在那一代上从来没打印过 —— 三个话题都发过了和三条链都断了，
     * 日志里同样是一片空白。
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
      // 走通了的每一枚都要记账：否则"三个话题真发过了"和"三条链全断了"
      // 在第 2 步这条路上都是**一句日志都没有**（第 1 步早就有 `_logDiscussionAllSettled`，
      // 2026-11-14 现场那一代模块全部没有 src、只走这条路，那句话因此从来没打印过）。
      var settled = [];
      for (var i = 0; i < modules.length; i++) {
        var url = await this._resolveDiscussionUrlFromModule(modules[i]);
        if (!url) {
          if (modules[i].serverFinished === true) settled.push({ key: '', finished: true });
          continue;
        }
        // 同样必须用稳定键：多讨论任务点下 url.slice(-70) 会碰撞，导致漏做
        var moduleKey = this._discussionKeyOf(url);
        settled.push({ key: moduleKey, url: url, finished: false });
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
        if (settled.length) this._logDiscussionAllSettled(settled);
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
    // ⚠️ 节流从 30 秒放到 **120 秒**：这一支曾经每 tick 都会被 `study-page` 拒一次，
    //    30 秒等于一条都没挡住（现场实测约 31 秒一条，和 `media pending` 一起把
    //    200 条日志环刷满，真正要看的「为什么跳过这一节」几条分钟后就查不到了）。
    //    换了**别的**理由仍然立刻出日志 —— 节流只压同一条重复。
    //    批次 54-D 之后，刷课页那一支先被 `_studyDeclineAnnounced` 收成"一份页面只说一次"，
    //    这把 120 秒的尺主要管的是**还在反复重算的其它理由**（如非课程页的 `return-jump-expired`）。
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
      /**
       * 刷课页这一支**只由网址决定**（`_isStudyCourseHref` 是一串纯网址正则），所以提到缓存判定
       * 之前问一次（批次 54）。不提的话，为了得出"这一页不是回帖页"这个永远不会变的结论，
       * `_computeDiscussionPage` 每 2 秒要把 `document.body.innerText` 前 3000 字读出来
       * 再跑一遍正则。
       *
       * ⚠️ 日志键从"整条网址"改成**这一份文档**（批次 54-D）—— 现场量出来的：
       *   同一份刷课页上相邻两条 `study-page` 间隔 ~100 秒，而对同一网址摘要连采三次，
       *   **只有 `chapterId` 那一格在变**（`courseId` / `clazzid` / `cpi` / `enc` / `openc` 全部不变）。
       *   也就是说"每网址一条"= **每一节一条**：刷一节课照样几十条，
       *   和旧写法那条 120 秒节流在用户眼里长得一模一样（症状没变）。
       *   现在一份页面只说一次：翻到第几节都不再补，但**换页面／刷新之后还会说**，
       *   所以"平台真把回帖页搬到 study 形状的网址上"这种怪事仍然看得见 ——
       *   这一族不许被永久消音（AGENTS §2 #7：静默永久跳过是不可接受的）。
       */
      if (this._isStudyCourseHref(href.toLowerCase())) {
        var announced = this._studyDeclineAnnounced === true;
        this._studyDeclineAnnounced = true;
        this._discussionPageUrl = href;
        this._discussionPageAt = now;
        this._discussionPageResult = false;
        if (announced) return false;
        return this._declineDiscussionPage('study-page', { href: href.slice(0, 90) });
      }
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

    _isQuizResultCompletedPage: function () {
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      try {
        var text = doc.body ? textOf(doc.body) : '';
        if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text)) return false;
        if (doc.querySelector('.testTit_status_complete')) return true;
        if (/任务点已完成|已完成|已通过|恭喜/.test(text) &&
          doc.querySelector(this._quizContainerSelector + ', .answerCon, .answerScore')) {
          return true;
        }
      } catch (e) {}
      return false;
    },

    /**
     * 「这一节该不该为『任务框都显示已完成』而放手」—— 唯一调用方是 `_isActiveMediaPending`，
     * 它必须把**自己即将用来决定"还占不占着"的那枚元素**一起传进来（批次 51）。
     * ⚠️ 不许改回读 `this._videoEl` 缓存：那个缓存会被 `_getVideoEl()` 一拍一填、
     *    被 `_clearMediaPendingState()` 一拍一清，两个调用方因此逐拍各执一词。
     * `media` 为空 = 这一页压根没有媒体元素，此时"框都做完了"才算数。
     */
    _shouldReleaseMediaPendingForCurrentCompletion: function (reason, media) {
      if (!this._activeMediaJobPending && !this._isPlaying) return false;
      if (media && !media.ended && (this._activeMediaJobManaged || this._isPlaying)) return false;

      var state = this._getVisibleTaskCompletionState();
      if (state.hasTasks && state.allFinished) return true;

      if (this._isQuizResultCompletedPage()) return true;

      var mainDoc = this._getMainDocument();
      try {
        var bodyText = mainDoc && mainDoc.body ? textOf(mainDoc.body) : '';
        if (bodyText && /任务点已完成/.test(bodyText) && !/未完成|待完成/.test(bodyText)) return true;
      } catch (e) {}

      return false;
    },

    /**
     * 作业/考试提交之后，页面会翻成一张**判分结果页**：
     * 每道题下面多出「我的答案 / 正确答案 / 本题得分」。
     *
     * 为什么单列一条判据（现场故障）：`_isDocumentFrameFinished` 认的是
     * `.ans-job-finished / .job-color / .icon_Completed / .testTit_status_complete`
     * 和父层 wrapper 的「任务点已完成」文本 —— 这套标记是**课程章节页**的。
     * 作业结果页往往只有 `.Py_answer` 那一族，于是四条都不命中，
     * `_isQuizPassedOrFinished` 恒为 false → `_monitorQuizSubmit` 一直 hold →
     * 25 秒后超时、整页重载、重新扫描、重新答题、重新提交。
     * 用户看到的就是"题目一直扫描，AI 重复提交"。
     *
     * 三条判据**同时**成立才算完成，宁可漏判也不要误判
     * （误判 = 把没交的卷当已完成，直接跳过这个任务点）：
     *   ① 出现判分痕迹（我的答案/正确答案/得分/解析）
     *   ② 题目控件已不可交互（input 全 disabled）或题目容器已消失
     *   ③ 不含重做文案
     */
    _isQuizResultPageFinished: function (doc) {
      try {
        if (!doc || !doc.body) return false;
        var text = textOf(doc.body);
        if (!text) return false;
        // ③ 重做文案一票否决：这是"没通过、要重做"，绝不能算完成
        if (/未达到及格线|未达到通过标准|请重做|很遗憾|未通过/.test(text)) return false;

        // ① 判分痕迹：学习通结果页的标志性结构
        var hasGradeMark = false;
        if (doc.querySelector('.Py_answer, .Py_tk, .answerScore, .answerCon, .mark_answer')) {
          hasGradeMark = true;
        } else if (/我的答案|正确答案|本题得分|答案解析/.test(text)) {
          hasGradeMark = true;
        }
        if (!hasGradeMark) return false;

        // ② 已不可交互：题目区被结果区替换，或所有控件都 disabled
        // 选择器读真源 `_quizContainerSelector`，别手抄（手抄的那份必然漂移）
        var containers = doc.querySelectorAll(this._quizContainerSelector);
        if (!containers.length) return true;

        var controls = doc.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea');
        if (!controls.length) return true;
        for (var i = 0; i < controls.length; i++) {
          if (!controls[i].disabled) return false; // 还有能点的 → 结果页尚未落地
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * 「这份文档到底是不是答题页」—— 任务类型仲裁的**唯一**判据（2026-11-10）。
     *
     * 为什么不能再拿 `_quizDetectorSelector` 命中当「这是测验任务」：那串并集里
     * 有 `.question-content`、`.answerOption`、`.tiBank`、`.topicItem` 这类**通用名字**，
     * 课件（轮盘 PPT）帧和文档帧里同样会出现。一个挂着 `.question-content` 的 PPT 帧
     * 因此被判成 quiz，`_runChaoxingReadJob` 再也轮不到 —— 用户看到的「刷 PPT 功能报废」
     * 正是这一条；同一份误判还让 `_isQuizLearningPending` 恒为真、
     * 把 `_tryAdvanceIdleSection` 的逃生门也锁死（两条腿一起接近瘫痪）。
     *
     * 判据换成「真的抠得出题，而且题里有能填的控件」，两条同时成立：
     *   1) `_collectQuestionContainers(doc)` 非空 —— 走有序真源 `_questionSelectors`，
     *      带可见性/文本过滤与嵌套去重，比一次性并集严格得多；
     *   2) 容器内存在答题控件（真源 `_quizAnswerControlSelector`）——
     *      课件里那些装饰性的 `.question-content` 一个都没有。
     *
     * ⚠️ 整文档的控件预筛必须放在收集容器**之前**，这是性能闸不是省事：
     *    OCS 调度每秒对每个帧调一次本方法，而 `_collectQuestionContainers` 要跑
     *    十几条选择器 + 逐个可见性判断。一道控件都答不了的页面必然不是答题页，
     *    先用一次 `querySelector` 挡掉，非答题页的开销与改前持平。
     */
    _documentHasQuiz: function (doc) {
      if (!doc || !doc.querySelectorAll) return false;
      var controlSelector = this._quizAnswerControlSelector;
      try {
        if (!doc.querySelector(controlSelector)) return false;
      } catch (ePre) {
        return false;
      }

      var containers = [];
      try {
        containers = this._collectQuestionContainers(doc);
      } catch (eCol) {
        return false;
      }
      for (var i = 0; i < containers.length; i++) {
        try {
          if (containers[i] && containers[i].querySelector(controlSelector)) return true;
        } catch (eCtl) {}
      }
      return false;
    },

    _detectQuiz: function () {
      var title = this._getCurrentTitle();
      if (title.indexOf('章节测验') !== -1 || title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1) {
        // 标题命中只是快路径，必须有「真的在测验页面」的佐证才能算数：
        // 顶层地址 / 主 iframe / 主 iframe 内嵌 iframe 的地址里存在 work/exam 页面。
        // 没有佐证就直接放过——否则课程目录里名为「课程考试」的章节（本身 0 任务点、
        // 树节点已标完成）会被误判成"有测验"：完成检查被否决 → 永不跳过 →
        // study 循环每 5 秒空转，反复报 "quiz scan found 0 questions"（真实页面实测的坑）。
        var hrefs = [String(location.href || '')];
        try { hrefs.push(String((this._getMainFrame() || {}).src || '')); } catch (eFrame) {}
        try {
          var mainDoc = this._getMainDocument();
          if (mainDoc) {
            Array.from(mainDoc.querySelectorAll('iframe')).forEach(function (fr) {
              hrefs.push(String(fr.getAttribute('src') || ''));
            });
          }
        } catch (eDoc) {}
        var onWorkPage = hrefs.some(function (u) {
          return /ananas\/modules\/work|api\/work|work\/do(Home)?Work|exam\/test|testpaper|reVersionTestStartNew|selectWorkQuestion/i.test(u);
        });
        if (onWorkPage) return true;
      }
      var tasks = this._collectVisibleTaskFrames();
      if (tasks.some(function (task) { return task.type === 'quiz' && !task.finished; })) return true;

      // DOM 兜底的判据与任务类型仲裁**同一个**：「题目容器里真的有能作答的控件」。
      // 原来这里整页扫 `_quizDetectorSelector` 的通用类名，于是挂着一个
      // `.question-content` 的课件页/文档页也返回 true —— 那就是「接近瘫痪」的第二条腿：
      // `_isQuizLearningPending` 恒为真 → `_tryAdvanceIdleSection` 的逃生门被冻住，
      // 而 `_handleQuiz` 又抠不出题，什么都不做（2026-11-10）。
      // ⚠️ 容器清单读真源 `_quizContainerSelector`（这份清单曾被手抄在此且漏了 .Cy_TItle，
      //    作业/考试页的 DOM 兜底整体失效 —— 真源处有完整教训记录，别再抄回来），
      //    也不要换成 `_questionSelectors` 那份有序备选：两处用途不同，见 10-config-state.js 各自的注释。
      var containerSelector = this._quizContainerSelector;
      var controlSelector = this._quizAnswerControlSelector;
      return this._walkDocuments(function (doc2) {
        try {
          // 便宜的整页预筛：本方法在每轮 tick 里都会跑，绝不能每次都去遍历全部容器
          if (!doc2.querySelector(controlSelector)) return false;
          var nodes = Array.from(doc2.querySelectorAll(containerSelector));
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j]) || textOf(nodes[j]).length === 0) continue;
            if (nodes[j].querySelector(controlSelector)) return true;
          }
        } catch (eWalk) {}
        return false;
      });
    },

    _skipQuiz: function () {
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this.nextUnit();
    },

    _getQuizFieldValue: function (doc, id) {
      try {
        var el = doc && doc.getElementById ? doc.getElementById(id) : null;
        return el ? String(el.value || el.getAttribute('value') || '').trim() : '';
      } catch (e) {
        return '';
      }
    },

    _getQuizWorkKey: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument() || document;
      var parts = [
        this._getQuizFieldValue(doc, 'courseId'),
        this._getQuizFieldValue(doc, 'classId'),
        this._getQuizFieldValue(doc, 'workRelationId') || this._getQuizFieldValue(doc, 'workId') || this._getQuizFieldValue(doc, 'oldWorkId'),
        this._getQuizFieldValue(doc, 'jobid'),
        this._getQuizFieldValue(doc, 'knowledgeid') || this._getCurrentChapterId()
      ].join('|');
      // 五个 id 字段全空时，键必须**至少细到「一帧一份卷子」**，否则同一张卡片里的
      // 两份卷子会被记成同一份：坏掉那一份的 90 秒暂停会连累另一份，两份卷子的
      // 提交次数与答案缓存也会互相顶掉（2026-11-10 批次 3）。
      if (!parts.replace(/\|/g, '')) parts = this._getQuizDocumentIdentity(doc);
      return 'omitone.quiz.correct.' + encodeURIComponent(parts).slice(0, 180);
    },

    /**
     * `_getQuizWorkKey` 在「五个 id 字段全空」时的兜底身份。
     *
     * 为什么不能再只写 `location.href`：顶层地址对同一张卡片里的两份卷子**是同一个值**，
     * 于是批次 1 拆掉的「按页冷却」在兜底分支里悄悄又回来了 —— 一份坏卷子照样能
     * 冻住它的邻居，而且这条路径只在认不出 id 的页面上走，日常测试碰不到。
     *
     * 分两级把它拆开：① **这份文档自己的 URL**（每个 iframe 各不相同）；
     * ② 宿主帧的身份（`jobid` / `id` / `name` / `data`）。`about:blank` / `about:srcdoc`
     * 这类帧的 URL 全都一样，分不开任何东西，所以那种 URL 直接当「没有信号」处理。
     *
     * ⚠️ 这个键同时被提交次数、答案缓存、`_quizReadyWorkKey` 复用，所以**稳定压倒一切**：
     *   同一个文档两次算出不同的键，等于冷却形同不存在、交卷上限每轮被重置
     *   （比按页合并更烧用户的提交次数）。因此帧在这一页里的序号只当**最后一层**兜底 ——
     *   页面重排时它会变，能不用就不用。
     */
    _getQuizDocumentIdentity: function (doc) {
      var url = '';
      try { url = String((doc && (doc.URL || (doc.location && doc.location.href))) || ''); } catch (eUrl) {}
      if (/^about:(?:blank|srcdoc)$/i.test(url)) url = '';
      var frame = null;
      try { frame = doc && doc.defaultView ? doc.defaultView.frameElement : null; } catch (eFrame) {}
      var frameId = '';
      if (frame) {
        try {
          frameId = String(frame.getAttribute('jobid') || frame.getAttribute('id') ||
            frame.getAttribute('name') || frame.getAttribute('data') || '');
        } catch (eAttr) {}
        if (!url && !frameId) {
          try {
            var host = frame.ownerDocument || document;
            frameId = 'idx' + Array.prototype.indexOf.call(host.querySelectorAll('iframe'), frame);
          } catch (eIdx) {}
        }
      }
      var bits = [url, frameId];
      if (!bits[0] && !bits[1]) bits[0] = String(location.href || '');
      bits.push(this._getCurrentChapterId());
      return bits.join('|');
    },

    /**
     * 「当前在答的是哪一份卷子」——**换了一份就把那一组答题状态重置掉**。
     *
     * 为什么必须有（现场故障）：同一张学习卡片里可以挂**两份**测验任务点
     * （实测：一张卡片里两个单元测试，URL 分别是
     * `/mooc-ans/work/doHomeWorkNew?...&oldWorkId=…`）。
     * 而 `_quizAnswered` / `_quizCurrentQuestions` 这一组是**页面级**的，
     * 只在 `_resetRuntimeState()` 里清，调用点只有
     * `run()` / 换章节 / `nextUnit()` / 换学习卡片 ——
     * **同一张卡片里从一份卷子切到另一份，一次都不经过**。
     * 于是交完第一份后 `_quizAnswered` 恒为 true，
     * `_handleQuiz` 第一行（`if (this._quizAnswered || this._quizInProgress) return;`）
     * 直接返回 —— 第二份**永远不答**。
     *
     * ⚠️ 三道保险，缺一不可：
     *   ① **拿不到身份键（空串）就什么都不做** —— 宁可沿用旧状态，
     *      也不要因为认不出身份而把已答状态清掉、去重答一遍
     *   ② **键没变就什么都不做** —— 同一份卷子的重试/重做必须保留状态，
     *      否则会绕过 `_quizReadyToSubmit` 等判定，造成重复提交
     *   ③ **换过去那份本来就已完成时，重新置回"已答"** —— 不然后续路径
     *      会把一份交过的卷子当新卷子处理
     *
     * @param {string} paperKey 任务点身份（jobid / workid 一类），由调用方给出
     * @param {Document} [paperDoc] 即将处理的那份卷子的文档，用于保险 ③
     * @returns {boolean} 是否真的发生了"换卷子"
     */
    _syncQuizPaperRunState: function (paperKey, paperDoc) {
      var key = String(paperKey || '').trim();
      if (!key) return false;                 // ① 认不出身份 → 不动
      if (this._quizRunPaperKey === key) return false;   // ② 还是同一份 → 不动
      var switched = !!this._quizRunPaperKey;
      this._quizRunPaperKey = key;
      if (!switched) return false;            // 第一次记录身份，谈不上"切换"

      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      // 换卷子 = 上一份的检查窗口作废（留着会让新卷子直接跳过窗口、填完就交）
      this._quizReviewPaperKey = '';
      this._quizReviewUntil = 0;
      emitRuntimeLog('info', 'quiz paper switched, reset per-paper state', { paper: key.slice(0, 90) });

      // ③ 换过去那份已经完成时，别把它当"没答过"
      if (paperDoc && this._isQuizPassedOrFinished(paperDoc)) {
        this._quizAnswered = true;
      }
      return true;
    },

    /**
     * 从任务点对象里推出"这是哪一份卷子"的身份键。
     *
     * 取值的优先顺序是**稳定 → 不稳定**：jobid（任务点自己的 id）→ attachment 的
     * jobid / mid → 名字兜底。拿不到就返回空串，`_syncQuizPaperRunState` 收到空串
     * 会**什么都不做**（宁可沿用旧状态，也不要因为认不出身份而重答一遍）。
     */
    _getQuizPaperKeyFromJob: function (job) {
      if (!job) return '';
      var attachment = job.attachment || null;
      var property = (attachment && attachment.property) || null;
      var candidates = [
        job.jobid,
        attachment && attachment.jobid,
        property && property._jobid,
        property && property.jobid,
        property && property.mid,
        job.mid,
        job.name
      ];
      for (var i = 0; i < candidates.length; i++) {
        var value = String(candidates[i] == null ? '' : candidates[i]).trim();
        if (value) return value;
      }
      return '';
    },

    /**
     * 从 `_classifyTaskFrame` 出来的任务点对象里推出卷子身份键。
     *
     * ⚠️ **不能用 `task.src` 当身份**：真实页面上两个任务点的外层帧 src
     * **完全相同**（都是 `/ananas/modules/work/index.html?v=…&castscreen=0`），
     * 身份只写在 `data` 属性里。用 src 会让两份卷子看起来是同一份，
     * 于是"换卷子重置"永远不触发 —— bug 原样复发。
     * 取不到就返回空串（调用方会什么都不做）。
     */
    _getQuizPaperKeyFromTask: function (task) {
      if (!task) return '';
      var data = null;
      try { data = this._safeJsonParse(task.dataText || '', null); } catch (e) { data = null; }
      var candidates = [
        data && data._jobid,
        data && data.jobid,
        data && data.workid,
        data && data.workId
      ];
      for (var i = 0; i < candidates.length; i++) {
        var value = String(candidates[i] == null ? '' : candidates[i]).trim();
        if (value) return value;
      }
      try {
        if (task.frame && task.frame.getAttribute) {
          var attr = String(task.frame.getAttribute('jobid') || task.frame.getAttribute('_jobid') || '').trim();
          if (attr) return attr;
        }
      } catch (e2) {}
      return '';
    },

    /**
     * 「页面上现在的题目」和「我们记着已经答过的那一份」是不是**两份不同的卷子**。
     *
     * 为什么需要它：换卷子本来由 `_syncQuizPaperRunState()` 负责，但它要的是
     * **任务点身份**（jobid / attachment.jobid / mid / name）。真实页面里同一份文档
     * 接着显示第二份卷子时，这几个 id 常常一个都拿不到（或两份给的是同一个），
     * 于是 `_quizAnswered` 一直是 true、`_handleQuiz` 第一行静默 return，
     * 第二份**永远不答**（2026-11-10 用户报的「第一次遇到题目过了，第二次不答题」）。
     *
     * 判据刻意做得很窄，只在**完全对不上**时才认换卷：
     *   - 两边都取得到题目身份（qid）才比；任何一边取不到 → false（认不出就当没换）
     *   - 有**任何一道**重叠 → false —— 同一份卷子的补填/重做必须保留状态，
     *     否则会把一份已交过的卷子当新卷子再交一次（那正是「疯狂提交」的形状）
     *   - 只有「出现若干道完全没见过的题，且旧题一道都不在」→ true
     *
     * @param {Document} doc 现在页面上这份卷子的文档
     * @returns {boolean} true = 页面上已经是另一份卷子的题目
     */
    _isQuizPaperChangedInDom: function (doc) {
      try {
        var remembered = this._quizCurrentQuestions;
        if (!doc || !remembered || !remembered.length) return false;
        var oldIds = {};
        var oldCount = 0;
        for (var i = 0; i < remembered.length; i++) {
          var q = remembered[i];
          var oldId = q && q._element ? String(this._getQuestionIdFromElement(q._element) || '').trim() : '';
          if (!oldId) continue;
          oldIds[oldId] = 1;
          oldCount++;
        }
        if (!oldCount) return false;

        var nodes = this._collectQuestionContainers(doc);
        var fresh = 0;
        var overlap = 0;
        var seenFresh = {};
        for (var j = 0; j < nodes.length; j++) {
          var newId = String(this._getQuestionIdFromElement(nodes[j]) || '').trim();
          if (!newId) continue;
          if (oldIds[newId]) { overlap++; break; }
          if (!seenFresh[newId]) { seenFresh[newId] = 1; fresh++; }
        }
        if (overlap) return false;
        return fresh > 0;
      } catch (e) {
        return false;
      }
    },

    /**
     * 「这份卷子的**提交账**记在哪个文档上」—— 只有一处答案（2026-11-10 批次 8）。
     *
     * 表达式与 ready 那一路**同形**（`preferredDoc || 题目所在文档`）：
     * 写账端与读账端错开时，症状不是报错，而是**上限永远读不到次数** ——
     * 「一次没过就再交一次、一直交」的疯狂提交就是这么来的
     * （`_handleSubmitConfirmDialog` 原先传 `null`，`null → 主文档` 那本粗账被写，
     * ready 键与 `_shouldSkipQuizBySubmitAttempts` 读的是**题目文档**那本细账）。
     *
     * ⚠️ 只管提交账：答案缓存与按卷冷却仍按调用点自己那份文档算键，
     * 动 `_resolveQuizAnswerDocument` 的 `null` 兜底会把十几条读路径一起卷进来。
     */
    _getQuizAccountDocument: function (preferredDoc) {
      return preferredDoc || this._getQuizDocumentFromQuestions(this._quizCurrentQuestions) || null;
    },

    _getQuizSubmitAttemptKey: function (preferredDoc) {
      return this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)) + '.submitAttempts';
    },

    /**
     * 这一份卷子允许多少次交卷。
     *
     * 默认取配置的 `quizMaxSubmitAttempts`（20）—— 卷子没过时重答重交，是既有设计。
     *
     * ⚠️ 但**本地兜底过多选的卷子只给 2 次**（首发 + 一次认真重做）。
     * 为什么：那一轮的多选答案是猜的，一份卷子只要有一道多选基本就过不了；
     * 若照旧允许 20 次，就会变成"交一次→没过→再交一次…"的**疯狂提交**，
     * 而每一次提交都是**真的交上去**（平台可能记次数，用户明确报过这个症状）。
     * 给一次重做的机会足够：批次 7 之后多选**默认就交给模型**，
     * 只有"模型那一份填不进 DOM、靠本地猜测补上的卷子"才会被记进 `_quizLocalMultiplePapers`
     * 并收到 2 次（见 `_answerLocalMultiChoiceQuestions` 的 refill 那一趟）。
     * 真能过就在这一次过；过不了就是这张卷子过不了，继续交只是拿用户的提交次数去赌。
     */
    _getQuizMaxSubmitAttempts: function (preferredDoc) {
      var max = Number(this.configs.quizMaxSubmitAttempts || 20);
      if (!(max > 0)) max = 20;
      var key = this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)) || this._quizRunPaperKey || '';
      if (key && (this._quizLocalMultiplePapers || {})[key]) return Math.min(max, 2);
      return max;
    },

    _getQuizApiUnavailableReason: function () {
      // 这条不是「API 不可用」，是「用户自己把答题关了」—— 两者后面走的路完全不同
      // （前者要按住等恢复，后者直接翻页），所以理由必须分开命名（批次 13-B）。
      if (!this.configs.enableQuiz) return 'quiz-toggle-off';
      // ⚠️ 乱选模式**不需要** API key，也不受连接失败影响 —— 答案在本地生成。
      // 少了这一句，乱选会走 _skipQuizForApiUnavailable 把整道题跳过，
      // 变成「什么都不答」而不是「乱选」。
      if (this._isRandomAnswerMode()) return '';
      if (!this.configs.hasApiKey) return 'api-key-missing';
      if (Date.now() < (this._quizApiFailUntil || 0)) return 'api-connection-failed';
      return '';
    },

    /** 乱选模式是否生效。`enableQuiz` 仍要开 —— 关掉它是「完全不答题」的意思。 */
    _isRandomAnswerMode: function () {
      return !!(this.configs && this.configs.enableQuiz && this.configs.randomAnswer);
    },

    /**
     * 本地生成随机答案，**形状与 AI 返回的完全一致**（位置式数组）。
     *
     * 之所以刻意对齐形状：下游的填充 / 提交 / 判分识别因此**一行都不用改**，
     * 只换「答案从哪来」这一个源头 —— 改动面越小，越不容易碰坏别的功能。
     *
     * 各题型：单选 → 随机一个字母；判断 → 随机 true/false；
     * 多选 → 随机 1~2 项（用户实测：平台**接受**只选一项）；
     * 填空 / 简答 → 固定占位文本（乱选模式下不求对，只求把卷交出去）。
     */
    _buildRandomQuizAnswers: function (questions) {
      var list = questions || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var q = list[i] || {};
        var type = q.type || 'single';
        var count = (q.options || []).length;
        // 只有"读不到选项"（0 或 1 个）时才兜底成 4 —— 让字母至少有可能匹配上。
        // 选项多的时候**按真实数量**取（原先 >8 会硬压成 4，没必要，而且浪费了正确匹配的机会）。
        if (count < 2) count = 4;
        if (count > 26) count = 26;
        if (type === 'judge') {
          out.push(Math.random() < 0.5);
        } else if (type === 'multiple') {
          var pool = [];
          for (var k = 0; k < count; k++) pool.push(String.fromCharCode(65 + k));
          var picked = [];
          var want = Math.random() < 0.5 ? 1 : 2;
          while (pool.length && picked.length < want) {
            picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
          }
          out.push(picked.sort());
        } else if (type === 'fill' || type === 'short') {
          out.push('不会');
        } else {
          out.push(String.fromCharCode(65 + Math.floor(Math.random() * count)));
        }
      }
      return out;
    },

    _isQuizApiUnavailable: function () {
      return !!this._getQuizApiUnavailableReason();
    },

    /**
     * 「这一节压着一张**因为链路不可用而做不了**的卷子」—— 批次 13-B 的核心判据。
     *
     * 为什么不能直接拿 `_isQuizApiUnavailable()` 当答案：那条判据里还混着
     * 「用户自己关掉答题」（`quiz-toggle-off`），那种情况翻页是对的（他就不想做题）；
     * 而 key 没填 / 网络退避 时翻页 = 把必做题扔掉。以前 `_isQuizLearningPending`
     * 对两者一视同仁返回 false，上层于是宣布「这一节已完成」并翻节 ——
     * 这正是用户那句「还没做就判已完成、无语了」。
     *
     * 三个条件缺一不可：
     *   1. 原因是**可恢复**的那两类；
     *   2. 本轮确实因为该原因拒过测验任务点（`_noteQuizBlockedByApi` 的标记还新）——
     *      没有这条证据就不许凭空按住整节；
     *   3. 按住的时间还没超过预算 —— 超了就退回「跳过并大声记日志」，
     *      否则一个永远不填 key 的用户会把整轮刷课冻在这一节上。
     */
    _isQuizBlockedByApi: function () {
      var reason = this._getQuizApiUnavailableReason();
      if (!reason || reason === 'quiz-toggle-off') return false;
      var now = Date.now();
      if (!this._quizBlockedByApiAt || now - this._quizBlockedByApiAt > 30000) return false;
      return now - (this._quizBlockedSinceAt || now) < 180000;
    },

    /** 记下「因为链路不可用而拒掉了一个测验任务点」—— 上面那条判据的唯一证据来源。 */
    _noteQuizBlockedByApi: function (reason) {
      if (!reason || reason === 'quiz-toggle-off') return;
      var now = Date.now();
      // 上一轮阻塞已经断了（超过 60 秒没再拒过），当成**新的一次**重新起算，
      // 否则「填过 key 又掉线」会继承第一次的时长、直接跳过而不按住。
      if (!this._quizBlockedSinceAt || now - (this._quizBlockedByApiAt || 0) > 60000) {
        this._quizBlockedSinceAt = now;
      }
      this._quizBlockedByApiAt = now;
    },

    _resetQuizStateForSkip: function () {
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizSubmitLogAt = 0;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._quizReviewPaperKey = '';
      this._quizReviewUntil = 0;
      // 换任务了，上一道弹题的失败记录不该带过来
      this._popupQuizKey = '';
      this._popupQuizAttempts = 0;
      this._popupQuizBlockedUntil = 0;
      // 换卷了，前缀缓存的"刚发过整批"记录也失效
      this._quizBatchSentKey = '';
      this._quizBatchSentAt = 0;
    },

    _markQuizApiConnectionFailed: function (error) {
      var message = error && error.message ? error.message : String(error || 'LLM 请求失败');
      // 不再永久写入 storage：改为 45 秒退避，期间跳过答题，之后自动重试并自愈
      this._quizApiFailUntil = Date.now() + 45000;
      this._quizApiLastError = String(message).slice(0, 300);
      emitRuntimeLog('warn', 'api connection failed, skip quiz', { error: message.slice(0, 200), retryInMs: 45000 });
    },

    _skipQuizForApiUnavailable: function (reason, preferredDoc) {
      var skipReason = reason || this._getQuizApiUnavailableReason() || 'api-unavailable';
      // ⚠️「答不了」不等于「没题做」（批次 13-B）。被可恢复的原因挡住、且这一轮确实
      // 因此拒过测验任务点时，这里**不许翻页**：翻过去就等于把必做题宣布成已完成。
      // 返回 false 让调用方回落到它自己的 hold 分支；超过按住预算后自动放行，
      // 所以一个永远不填 key 的用户也不会被冻在这一节。
      if (this._isQuizBlockedByApi()) {
        var heldMs = Date.now() - (this._quizBlockedSinceAt || Date.now());
        if (!this._quizBlockedHoldLogAt || Date.now() - this._quizBlockedHoldLogAt > 10000) {
          this._quizBlockedHoldLogAt = Date.now();
          emitRuntimeLog('warn', 'quiz blocked by api, holding unit', {
            reason: skipReason,
            heldMs: heldMs,
            hint: '这一节压着没做的题，但答题链路现在用不了 —— 已**停在本节不翻页**（不是已完成）。' +
              '填好 API Key 或等网络恢复就会自动继续；按住超过 3 分钟才会跳过这一节'
          });
        }
        return false;
      }
      // 按住预算用完（3 分钟）仍未恢复 → 放行跳过，但要把「这些题并没做过」说清楚。
      // ⚠️ 这里**不改** `_quizBlockedSinceAt`：清零会让 `_isQuizBlockedByApi()` 下一秒
      // 又算成新的一次阻塞、重新按住，于是永远翻不了页（自锁）。它由
      // `_resetRuntimeState()`（换节）与 `_noteQuizBlockedByApi()`（间隔 60 秒以上
      // 视为新事故）负责起算，所以每一节都拿到自己那份预算。
      var blockedSince = this._quizBlockedSinceAt || 0;
      if (blockedSince && skipReason !== 'quiz-toggle-off' && Date.now() - blockedSince >= 180000 &&
          (!this._quizBlockedGiveUpLogAt || Date.now() - this._quizBlockedGiveUpLogAt > 10000)) {
        this._quizBlockedGiveUpLogAt = Date.now();
        emitRuntimeLog('warn', 'quiz blocked too long, giving up unit', {
          reason: skipReason,
          heldMs: Date.now() - blockedSince,
          hint: '按住整节超过 3 分钟仍未恢复，改判跳过 —— 这些题**没做过**，配好链路后请开重学把这节补回来'
        });
      }
      this._setQuizForceSkip(15000);
      this._resetQuizStateForSkip();
      var now = Date.now();
      if (!this._quizApiSkipLogAt || now - this._quizApiSkipLogAt > 3000) {
        this._quizApiSkipLogAt = now;
        emitRuntimeLog('warn', 'skip quiz because api unavailable', {
          reason: skipReason,
          error: String(this._quizApiLastError || '').slice(0, 160)
        });
      }
      if (this._switchToNextLearningCard(skipReason)) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          this._setQuizForceSkip(15000);
          return true;
        }
      } catch (e) {}
      if (this.configs.autoNext) this.nextUnit();
      return true;
    },

    _getQuizSubmitAttemptCount: function (preferredDoc) {
      try {
        return Number(sessionStorage.getItem(this._getQuizSubmitAttemptKey(preferredDoc)) || 0) || 0;
      } catch (e) {
        return 0;
      }
    },

    _setQuizSubmitAttemptCount: function (preferredDoc, count) {
      try {
        sessionStorage.setItem(this._getQuizSubmitAttemptKey(preferredDoc), String(Math.max(0, count || 0)));
      } catch (e) {}
    },

    _clearQuizSubmitAttemptCount: function (preferredDoc) {
      try {
        sessionStorage.removeItem(this._getQuizSubmitAttemptKey(preferredDoc));
      } catch (e) {}
    },

    _incrementQuizSubmitAttemptCount: function (preferredDoc) {
      var count = this._getQuizSubmitAttemptCount(preferredDoc) + 1;
      this._setQuizSubmitAttemptCount(preferredDoc, count);
      emitRuntimeLog('info', 'quiz submit attempt count', { count: count, max: this._getQuizMaxSubmitAttempts(preferredDoc) });
      return count;
    },

    _shouldSkipQuizBySubmitAttempts: function (preferredDoc) {
      return this._getQuizSubmitAttemptCount(preferredDoc) >= this._getQuizMaxSubmitAttempts(preferredDoc);
    },

    /**
     * 写入「暂停这一卷」的冷却。**时间戳与卷子身份键必须成对写**，
     * 所以所有写入点一律走这里，不许再直接赋 `_quizForceSkipUntil`。
     *
     * @param {number} durationMs 冷却时长
     * @param {string} [paperKey] 卷子身份键；**不传 = 全局冷却**（老语义）——
     *   用于「Key/接口不可用」「真的交过卷之后」这类与具体卷子无关的场景。
     */
    _setQuizForceSkip: function (durationMs, paperKey) {
      this._quizForceSkipUntil = Date.now() + durationMs;
      this._quizForceSkipPaperKey = paperKey ? String(paperKey) : '';
      return this._quizForceSkipUntil;
    },

    /**
     * 「现在是不是在暂停这一卷」。
     *
     * ⚠️ **调用点必须把当前文档传进来**（`_handleQuiz` / `_isQuizLearningPending`）。
     * 卷子键是**按文档算**的：`_getQuizWorkKey(doc)` 里先 `_resolveQuizSubmitDocument(doc)`，
     * 传题目所在的内层 `#frame_content` 与不传（退到主文档 / document）
     * 读到的 `workRelationId` 可能不是同一个 —— 于是写入端记 A 键、判定端问 B 键，
     * 「暂停 90 秒」永远对不上：R1 已关掉跳过出口、R2 已删掉 `_skipQuiz()`，
     * 结果不是「没暂停」而是**该节点永久停摆**，日志却写着已暂停（错地图比没地图更糟）。
     * 判定端与写入端共用同一个文档表达式，是这条不复发的前提。
     *
     * @param {Document} [doc] 当前这份卷子的文档；不传时用「正在答的题」所在文档兜底。
     */
    _isQuizForceSkipping: function (doc) {
      if (!this._quizForceSkipUntil || Date.now() >= this._quizForceSkipUntil) return false;
      // 冷却还没过，但**只对写入时那一份卷子**生效（R3：一张坏卷子不该冻结整门课）。
      var paperKey = this._quizForceSkipPaperKey || '';
      if (!paperKey) return true;                 // 写入时没带卷子键 → 全局冷却，与今天一致
      // 与写入侧**同一个**文档表达式，别在这里另起一份。
      var keyDoc = doc || this._getQuizDocumentFromQuestions(this._quizCurrentQuestions) || null;
      var currentKey = '';
      try { currentKey = String(this._getQuizWorkKey(keyDoc) || ''); } catch (eKey) { currentKey = ''; }
      // ⚠️ 认不出当前卷子时**让冷却继续生效**（保守 = true），别写反成「认不出就放行」：
      //   那样 401 / 接口不可用这些既有退避会在取键失败的瞬间失效，插件立刻又开始白烧请求。
      if (!currentKey) return true;
      return currentKey === paperKey;
    },

    /**
     * 「现在是不是落在**任意一个**『暂停』窗口里」—— 不比卷子键。
     *
     * 只给两处拿不到卷子文档的调用点用：`nextUnit`（64-tasks-loop.js）与
     * `_shouldHoldQuizBeforeNext` 的第一行。它们问的不是「这一卷要不要暂停」，
     * 而是「我能不能离开这一节」：窗口还在 = 刚刚放弃过一份卷子 = 正该往前走，
     * 此时 `_shouldHoldQuizBeforeNext` 那道「交卷前别急着走」的闸门只会帮倒忙。
     *
     * ⚠️ 为什么这里不能沿用无参的 `_isQuizForceSkipping()`（HIGH-1 的同一家族、
     *   方向倒过来）：卷子键是**按文档**算的。无参时它读 `_quizCurrentQuestions`
     *   所在的文档，而那组状态在放弃时会被清掉 —— 清掉之后它退到主文档重算，
     *   算出来的是**另一个键**（两边都非空、就是不相等），于是返回 false，
     *   `nextUnit` 被 hold 拦住、`_handleQuiz` 又在冷却里不干活 = **该走的走不了**。
     *   认不出卷子时宁可放行离开：代价只是同一张卡片里另一份卷子这 90 秒内
     *   不被补做（下一轮 OCS 仍会按卷判它），远小于「该节点停摆」的后果。
     */
    _isQuizSkipWindowLive: function () {
      return !!(this._quizForceSkipUntil && Date.now() < this._quizForceSkipUntil);
    },

    _forceSkipQuizAfterMaxAttempts: function (preferredDoc) {
      var count = this._getQuizSubmitAttemptCount(preferredDoc);
      var max = this._getQuizMaxSubmitAttempts(preferredDoc);
      this._setQuizForceSkip(15000);
      this._quizInProgress = false;
      this._quizAnswered = false;
      this._quizSubmitPending = false;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      emitRuntimeLog('warn', 'skip quiz after max submit attempts', { count: count, max: max });

      if (this._switchToNextLearningCard('quiz-max-submit-attempts')) return true;
      try {
        var nextButton = document.querySelector('#prevNextFocusNext');
        if (nextButton) {
          nextButton.click();
          this._resetRuntimeState();
          this._setQuizForceSkip(15000);
          return true;
        }
      } catch (e) {}
      this.nextUnit();
      return true;
    },

    _getQuizQuestionRuntimeKey: function (question) {
      if (!question || !question._element) return '';
      var qid = this._getQuestionIdFromElement(question._element);
      if (qid) return 'id:' + qid;
      var titleKey = this._getQuizTitleKeyFromElement(question._element, question.title);
      if (titleKey) return 'title:' + titleKey;
      return 'index:' + String(question.index != null ? question.index : '');
    },

    _markQuizQuestionAnsweredThisRun: function (question, source, answer, type) {
      var key = this._getQuizQuestionRuntimeKey(question);
      if (!key) return;
      if (!this._quizCurrentAnsweredKeys) this._quizCurrentAnsweredKeys = {};
      if (!this._quizCurrentAnswerValues) this._quizCurrentAnswerValues = {};
      this._quizCurrentAnsweredKeys[key] = source || 'unknown';
      if (answer !== undefined && answer !== null && String(answer).trim()) {
        var answerType = type || (question && question.type) || 'single';
        this._quizCurrentAnswerValues[key] = {
          answer: answer,
          canonical: this._canonicalQuizAnswerForQuestion(answer, answerType, question),
          type: answerType,
          source: source || 'unknown',
          at: Date.now()
        };
      }
    },

    _wasQuizQuestionAnsweredThisRun: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      return !!(key && this._quizCurrentAnsweredKeys && this._quizCurrentAnsweredKeys[key]);
    },

    _unmarkQuizQuestionAnsweredThisRun: function (question) {
      var key = this._getQuizQuestionRuntimeKey(question);
      if (!key) return;
      if (this._quizCurrentAnsweredKeys) delete this._quizCurrentAnsweredKeys[key];
      if (this._quizCurrentAnswerValues) delete this._quizCurrentAnswerValues[key];
    },

    _isQuizPassedOrFinished: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      try {
        // 判分结果页优先于 frame 标记判断：作业/考试结果页两套标记都没有，
        // 只有 .Py_answer 那一族（见 _isQuizResultPageFinished 的说明）。
        if (doc && this._isQuizResultPageFinished(doc)) return true;
        // ⚠️「这份文档的卷子已完成」只能对**真是一张卷子的文档**说（批次 13-A）。
        // 现场：`_resolveQuizSubmitDocument(null)` 落在知识卡片那份文档上，
        // 而卡片页每条任务点后面都写着「已完成」—— `_isDocumentFrameFinished` 当场为真，
        // 于是「还没做的题」被读成「这一节已完成」，直接翻下一节
        //（用户的原话：「这到底是在用什么东西看？怎么说已完成了？」）。
        // 「看不见题」不等于「题做完了」：卷子帧跨域、还没加载、或压根没找着时，
        // 宁可返回 false 让上层走 hold/告警，也不许在这里替平台宣布完成。
        if (doc && !this._docHasQuizPaperShape(doc)) return false;
        if (doc && this._isDocumentFrameFinished(doc)) return true;
        var text = doc && doc.body ? textOf(doc.body) : '';
        if (text && !/未达到及格线|未达到通过标准|请重做|很遗憾/.test(text) && /任务点已完成|已通过|通过标准|恭喜/.test(text)) return true;
      } catch (e) {}
      return false;
    },

    _hasActiveQuizSubmitForm: function (preferredDoc) {
      var doc = this._resolveQuizSubmitDocument(preferredDoc) || preferredDoc || this._getMainDocument();
      if (!doc) return false;
      try {
        var hasQuiz = !!doc.querySelector(this._quizContainerSelector + ', input[id^="answertype"]');
        if (!hasQuiz) return false;
        var buttons = Array.from(doc.querySelectorAll('.btnSubmit, .workBtnIndex, .bluebtn, button, a, input[type="submit"], input[type="button"]'));
        return buttons.some(function (button) {
          if (!visible(button)) return false;
          var label = String(button.textContent || button.value || button.title || '').trim();
          return /提交|交卷|完成/.test(label) || /btnBlueSubmit|submitCheckTimes/.test(String(button.getAttribute('onclick') || ''));
        });
      } catch (e) {
        return false;
      }
    },

    _markQuizSubmitPending: function (preferredDoc, reason) {
      var now = Date.now();
      var wasPending = this._quizSubmitPending;
      this._quizSubmitPending = true;
      this._quizSubmitStartedAt = now;
      this._quizSubmitLogAt = 0;
      this._quizLastSubmitAttemptAt = now;
      var attemptCount = wasPending ? this._getQuizSubmitAttemptCount(preferredDoc) : this._incrementQuizSubmitAttemptCount(preferredDoc);
      var questionsDoc = this._getQuizDocumentFromQuestions(this._quizCurrentQuestions);
      // ⚠️ 三个键**必须同源**（批次 8）：`key` 是这次真正记账的槽位、`accountFrom` 是它的出处、
      // `readyKey` 是 ready 那一路的键。三者对不上就是"上限绕得开"那一族故障的现场证据，
      // 而它只能在这条日志里同时看到（批次 8 之前只能靠人肉复现）。
      emitRuntimeLog('info', 'quiz submit pending', {
        reason: reason || '',
        key: this._getQuizWorkKey(this._getQuizAccountDocument(preferredDoc)),
        accountFrom: preferredDoc ? 'caller' : (questionsDoc ? 'questions' : 'fallback-document'),
        readyKey: this._quizReadyWorkKey || '',
        attemptCount: attemptCount,
        maxAttempts: this._getQuizMaxSubmitAttempts(preferredDoc)
      });
    },

    /**
     * 提交之后，这一轮填的答案是不是**被清空了**。
     *
     * 判据：`_quizCurrentQuestions` 里**一道题都不再"已填写"**。
     * 平台判错重置、或静默丢弃提交时就是这样 —— 选项全没了。
     *
     * 为什么需要它：`_isQuizRedoRequired` 只认「未达到及格线 / 请重做 / 很遗憾」
     * 这类**文案**（或可见的重做弹窗）。而现场遇到过**不带这些文案的静默拒绝** ——
     * 用户描述是「提交闪了一下框、回到题目、选项全没了」。
     * 那种情况下四个 `_rememberWrongQuizAnswers` 调用点**一个都不会命中**，
     * 于是填过的答案不被记成错的，下一轮**原样再填一遍**，形成死循环。
     * 这里用"表单被清空"这个**不依赖文案**的信号兜住它。
     */
    _isQuizAnswersCleared: function (preferredDoc) {
      try {
        var qs = this._quizCurrentQuestions;
        if (!qs || !qs.length) return false;
        for (var i = 0; i < qs.length; i++) {
          if (this._getQuizQuestionFilledValue(preferredDoc, qs[i])) return false;
        }
        return true;
      } catch (e) { return false; }
    },

    /**
     * 提交前把平台**真正会提交的字段**打出来（`#answer{qid}` + `#answertype{qid}`）。
     *
     * 为什么需要：现场报「作业提交失败」，但用户**手动随便选**（多选只选一个）却能提交成功 ——
     * 说明失败与答案对错无关，是**我们生成的提交状态**平台不认。
     * 把这份快照与手动提交时同名字段一比，就能看出差在哪（题型值？格式？空值？）。
     */
    /**
     * 只读抓包：把平台**提交作业**的请求体与响应打出来。
     *
     * 为什么需要：现场报「作业提交失败」，而用户**手动随便选**却能提交成功 ——
     * 失败与答案对错无关，是提交状态平台不认。`btnBlueSubmit()` 本身没抛异常
     *（抛了我们会打印 `btnBlueSubmit failed`，日志里没有），所以拒绝发生在**服务端**。
     * 那唯一能说明原因的就是这次请求的**响应体** —— 平台自己的错误文案在里面。
     *
     * ⚠️ 铁律：**完全穿透**。钩子自身出任何问题都必须原样走原方法 ——
     * 在这里抛一个错，整个页面的 AJAX 都会废掉，比原 bug 严重得多。
     * 所以每一层都 try/catch，且只**读**不**改**（不碰参数、不碰返回值）。
     *
     * 只记跟作业/提交相关的 URL，避免把整页的请求都刷进日志。
     */
    _installSubmitSniffer: function () {
      if (this._submitSnifferInstalled) return;
      this._submitSnifferInstalled = true;
      try {
        var self = this;
        var interesting = /work|submit|exam|homework|answer/i;
        var XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype && XHR.prototype.open && XHR.prototype.send) {
          var origOpen = XHR.prototype.open;
          var origSend = XHR.prototype.send;
          XHR.prototype.open = function (method, url) {
            try {
              this.__omitoneUrl = String(url || '');
              this.__omitoneMethod = String(method || '');
              if (interesting.test(this.__omitoneUrl)) {
                console.log('[Omitone] submit sniffer →', this.__omitoneMethod, this.__omitoneUrl);
              }
            } catch (e0) {}
            return origOpen.apply(this, arguments);
          };
          XHR.prototype.send = function (body) {
            try {
              if (this.__omitoneUrl && interesting.test(this.__omitoneUrl)) {
                var b = body;
                if (b && typeof b !== 'string') {
                  try { b = JSON.stringify(b); } catch (e1) { b = String(b); }
                }
                console.log('[Omitone] submit sniffer body', String(b || '').slice(0, 800));
                this.addEventListener('loadend', function () {
                  try {
                    console.log('[Omitone] submit sniffer ←', this.status,
                      String(this.responseText || '').slice(0, 800));
                  } catch (e2) {}
                });
              }
            } catch (e3) {}
            return origSend.apply(this, arguments);
          };
          console.log('[Omitone] submit sniffer installed');
        }
      } catch (e) { console.warn('[Omitone] submit sniffer 安装失败（不影响功能）', e); }
    },

    _monitorQuizSubmit: function (preferredDoc) {
      if (this._prepareQuizRedoIfNeeded(preferredDoc || null)) return true;
      if (!this._quizSubmitPending) return false;

      if (this._isQuizPassedOrFinished(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizAnswered = true;
        this._clearQuizSubmitAttemptCount(preferredDoc || null);
        emitRuntimeLog('info', 'quiz submit finished');
        return false;
      }

      var now = Date.now();

      // 提交后**表单被清空** = 平台没接受这次提交（判错重置 / 静默丢弃）。
      // 这种拒绝不带「请重做」那类文案，`_isQuizRedoRequired` 认不出来 ——
      // 不补这一支，填过的答案就不会进错误缓存，下一轮原样再填，死循环。
      // 给平台 2 秒渲染时间再判，避免"刚提交、DOM 还没更新"时误判。
      // ⚠️ 这里**只记日志，绝不把答案记成错的**。
      //
      // 第一版写成了「静默清空 → 判为被拒绝 → 把答案记进错误缓存」，依据是「平台判错重置」。
      // 但用户实测推翻了它：**显示的是「作业提交失败」，而他随便乱选（多选只选一个）
      // 反而能提交成功** —— 说明失败与答案对错无关，是**我们生成的提交状态**平台不认。
      // 这种前提下把答案记成错的，会**误禁正确答案**，下一轮只会更错。
      //
      // 所以只留一条日志作为信号。真要判「被拒绝」，得先证明失败与答案有关。
      if (now - (this._quizSubmitStartedAt || 0) > scaledMs(2000) && this._isQuizAnswersCleared(preferredDoc || null)) {
        this._quizSubmitPending = false;
        this._quizSubmitStartedAt = 0;
        emitRuntimeLog('warn', 'quiz answers cleared after submit', {
          note: '表单被清空了 —— 只是记录，不据此把答案判错（失败原因尚未查明）'
        });
        return false;
      }

      var waitMs = scaledMs(Number(this.configs.quizSubmitWaitMs || 25000));
      if (this._quizSubmitStartedAt && now - this._quizSubmitStartedAt > waitMs) {
        this._quizSubmitPending = false;
        // 超时时把「为什么没认出结果页」一并记下来 ——
        // 没有这段的话，日志里只剩一句「等超时了」，缺哪道条件完全靠猜。
        var diag = this._describeQuizResultPage(preferredDoc || null);
        diag.waitMs = waitMs;
        emitRuntimeLog('warn', 'quiz submit wait timeout', diag);
        return false;
      }

      if (!this._quizSubmitLogAt || now - this._quizSubmitLogAt > 3000) {
        this._quizSubmitLogAt = now;
        console.log('%c[Omitone] waiting quiz submit result', 'color:#9C27B0');
      }
      return true;
    },

    _shouldHoldQuizBeforeNext: function (reason) {
      // 这里不比卷子键，理由见 `_isQuizSkipWindowLive`（这一处无参调
      // `_isQuizForceSkipping()` 是 HIGH-1 倒过来的那个形态）。
      if (this._isQuizSkipWindowLive()) return false;
      // 被可恢复的原因挡住时**要**按住（批次 13-B）；用户自己关掉答题则照旧不 hold。
      if (this._isQuizApiUnavailable() && !this._isQuizBlockedByApi()) return false;
      if (this._monitorQuizSubmit()) return true;
      var doc = this._resolveQuizSubmitDocument(null) || this._getMainDocument();
      if (!doc) return false;
      if (!this._detectQuiz() && !this._hasActiveQuizSubmitForm(doc)) return false;
      if (this._isQuizPassedOrFinished(doc)) return false;
      var now = Date.now();
      var shouldLog = !this._quizHoldLogAt || now - this._quizHoldLogAt > 3000;
      if (this._isQuizRedoRequired(doc)) {
        if (this._shouldSkipQuizBySubmitAttempts(doc)) {
          return this._forceSkipQuizAfterMaxAttempts(doc);
        }
        this._rememberCorrectQuizAnswers(doc);
        this._rememberWrongQuizAnswers(doc);
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        if (shouldLog) {
          this._quizHoldLogAt = now;
          emitRuntimeLog('warn', 'hold quiz redo before next', { reason: reason || '' });
        }
        return true;
      }
      if (this._hasActiveQuizSubmitForm(doc)) {
        if (shouldLog) {
          this._quizHoldLogAt = now;
          emitRuntimeLog('warn', 'hold unsubmitted quiz before next', { reason: reason || '' });
        }
        return true;
      }
      return false;
    },

    /**
     * 「卷子卡住」时到底卡在哪几题 —— 给 hold 类日志用的诊断切片。
     *
     * 为什么必须有：现场只有一句 `study hold quiz before finish`，**看不出是
     * "没答上"还是"答上了但填不进去"**。实测踩过：25 题只填上 23 题，
     * 每一轮的日志一模一样，只能靠人肉在页面上逐题数 —— 而这本来是日志一句话能说清的。
     * 它把未填的那几题的**题型、题干前缀、文本框数、富文本编辑器数、qid** 一起带上，
     * 一眼就能判断该去查哪条填答路径（`_fillText` / `_fillTextarea` / `_applyChoiceAnswer`）。
     */
    _describePendingQuizQuestions: function (preferredDoc) {
      try {
        var questions = this._quizCurrentQuestions || [];
        if (!questions.length) {
          var fallbackDoc = this._resolveQuizAnswerDocument(preferredDoc || null) || null;
          questions = fallbackDoc ? this._extractQuestions(fallbackDoc) : [];
        }
        if (!questions.length) return { total: 0 };
        var doc = this._resolveQuizAnswerDocument(preferredDoc || null) || this._getMainDocument() || document;
        var byType = {};
        var unfilled = [];
        var self = this;
        questions.forEach(function (question, index) {
          var type = String((question && question.type) || '?');
          byType[type] = (byType[type] || 0) + 1;
          var value = '';
          try { value = self._getQuizQuestionFilledValue(doc, question); } catch (e) { value = ''; }
          if (value) return;
          var el = question && question._element;
          var qid = '';
          try { qid = self._getQuestionIdFromElement(el) || ''; } catch (e2) { qid = ''; }
          unfilled.push({
            no: index + 1,
            type: type,
            title: String((question && question.title) || '').slice(0, 18),
            textInputs: el ? el.querySelectorAll('input[type="text"], input:not([type])').length : -1,
            richEditors: el ? el.querySelectorAll('iframe').length : -1,
            qid: String(qid).slice(0, 24)
          });
        });
        return {
          total: questions.length,
          unfilledCount: unfilled.length,
          byType: byType,
          unfilled: unfilled.slice(0, 6)
        };
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 120) };
      }
    },

    /**
     * 「为了这份卷子，这一节要不要按住不放手」—— 只有一处答案（2026-11-11 批次 9-C）。
     *
     * 现场：真实日志 00:45:59 → 00:46:16 连磨两轮 `study hold quiz before finish
     * {pending:{total:0}}`，最后是页面自己刷新才走通。用户报的"在已经做完的界面磨蹭很久"
     * 就是这两轮 —— hold 的是**0 道题**。
     *
     * 根因是两把判据不同源：`_isQuizLearningPending` 走的是「页面上有题的形状」那类宽判据
     * （`_hasActiveQuizSubmitForm` / `_detectQuiz`），而 `_describePendingQuizQuestions`
     * 要**数得出具体容器**。宽判据说有、具体数出来是 0 时，继续等不会等出任何东西。
     *
     * ⚠️ 三个保守分支不许放宽：数不出题但**答题动作正在飞**（`_quizInProgress` / `_quizSubmitPending`）
     * 时要 hold（正在填不该放手）；`pendingDesc` 是 `{error}` 这种**没数成**的形状时也 hold ——
     * 宁可慢，不能因为自己数漏了就整节放行。
     */
    _shouldHoldQuizBeforeFinish: function (pendingDesc) {
      if (!pendingDesc) return true;
      if (pendingDesc.total !== 0) return true;
      if (this._quizInProgress || this._quizSubmitPending) return true;
      return false;
    },

    _isQuizLearningPending: function (preferredDoc) {
      if (this._isQuizForceSkipping(preferredDoc || null)) return false;
      // ⚠️ 批次 13-B：以前这里无条件 `return false`，把「答题链路现在用不了」
      // 当成「这一页没有题要做」—— 上层随即宣布本节完成并翻节，
      // 用户看到的是「题一道没做就说已完成了」。
      // 现在可恢复的阻塞（key 没填 / 网络退避）继续算 pending，让调度器按住这一节。
      if (this._isQuizApiUnavailable()) return this._isQuizBlockedByApi();
      if (this._monitorQuizSubmit(preferredDoc || null)) return true;
      if (this._quizInProgress || this._quizSubmitPending) return true;

      var doc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
      if (doc && this._isQuizPassedOrFinished(doc)) return false;

      // ⚠️ **自己刚答过这份卷子 → 这一轮不需要再答。**
      // 不加这一条会死锁（实测 2026-10-17，卡了整整 6 分钟）：
      //   刚交完卷 → `_quizAnswered` 仍为真 → `_handleQuiz` 第一行就直接 return（不干活）；
      //   而平台还没渲染出结果页、提交按钮还在 → `_hasActiveQuizSubmitForm` 又说"还有题" →
      //   调度器每秒把同一份卷子交给它、它每秒空转，永远不前进，日志里只有一行行的
      //   `study matched job`。
      // 只有"平台明确要求重做"时才继续算 pending —— 那条在下面有自己的分支。
      if (this._quizAnswered && !this._isQuizRedoRequired(doc || null)) return false;

      if (this._isQuizRedoRequired(doc || null)) {
        if (this._shouldSkipQuizBySubmitAttempts(doc || null)) {
          return this._forceSkipQuizAfterMaxAttempts(doc || null);
        }
        this._rememberCorrectQuizAnswers(doc || null);
        this._rememberWrongQuizAnswers(doc || null);
        this._quizAnswered = false;
        this._quizCurrentAnsweredKeys = {};
        this._quizCurrentAnswerValues = {};
        this._quizCurrentQuestions = null;
        this._quizReadyToSubmit = false;
        this._quizReadyWorkKey = '';
        return true;
      }

      if (doc && this._hasActiveQuizSubmitForm(doc)) return true;
      if (this._detectQuiz() && !(doc && this._isQuizPassedOrFinished(doc))) return true;
      return false;
    },

    _handleQuiz: async function (preferredDoc) {
      // "放弃这一卷"的冷却窗口内直接退出：否则跳过去之后任务点还在页面上，
      // 下一秒又被匹配回来、再问一次模型（白烧 token），看起来像"跳过根本没生效"。
      // _quizInProgress 一旦因为异常岔在 true 上，第一行就会挡住一切 —— 整页永久停摆，
      // 日志里只留一条 30 秒去重的 tick error。5 分钟没换过就当成泄漏，清掉并留 warn。
      if (this._quizInProgress && this._quizInProgressAt && Date.now() - this._quizInProgressAt > 300000) {
        emitRuntimeLog('warn', 'quiz in-progress state leaked, reset', { ageMs: Date.now() - this._quizInProgressAt });
        this._quizInProgress = false;
      }
      // ⚠️ 这里必须把 `preferredDoc` 传下去：冷却是按卷子键生效的，而键按文档算 ——
      //   不传 = 读侧算的是另一个文档的键 = 本 bug（见 `_isQuizForceSkipping` 上方注释）。
      var holdForceSkip = this._isQuizForceSkipping(preferredDoc || null);
      var holdBusy = !!this._quizInProgress;
      var holdAnswered = !!this._quizAnswered;
      if (holdForceSkip || holdBusy || holdAnswered) {
        if (holdAnswered && !holdForceSkip && !holdBusy) {
          var holdDoc = this._resolveQuizSubmitDocument(preferredDoc || null) || preferredDoc || this._getMainDocument();
          // 结果页/重做提示在的时候「已答」是有意义的中间态，后面自有分支处理；
          // 两者都没有、页面上却是一批完全没见过的题 = 同一份文档里的**第二份卷子**。
          if (!this._isQuizPassedOrFinished(holdDoc) && !this._isQuizRedoRequired(holdDoc) &&
              this._isQuizPaperChangedInDom(holdDoc)) {
            emitRuntimeLog('info', 'quiz paper switched by question identity', {
              hint: '页面上出现一批完全不认识的题目，按「换了一份卷子」重置答题状态后照常作答'
            });
            // 「换一份卷子要清的那一组状态」与「放弃这一卷」是同一组，复用同一份实现，
            // 不在这里手抄第二遍（手抄过少一个字段就会留下上一份卷子的答案状态）。
            this._resetQuizStateForSkip();
            holdAnswered = false;
          }
        }
        var holdReason = holdForceSkip ? 'force-skip' : (holdBusy ? 'in-progress' : (holdAnswered ? 'answered' : ''));
        // 「题目明明在页面上，却一个字都不答」是这一族最难查的现场：三个原因过去共用
        // 一个**静默**出口，日志里连一个字都没有。现在把命中的那一个写清楚（10 秒节流，
        // 与既有 warn 同频，不会冲掉环形缓冲）。
        if (holdReason) {
          var nowHold = Date.now();
          if (!this._quizHoldReasonLogAt || nowHold - this._quizHoldReasonLogAt > 10000) {
            this._quizHoldReasonLogAt = nowHold;
            emitRuntimeLog('warn', 'quiz held: nothing answered this round', {
              reason: holdReason,
              paper: String(this._quizRunPaperKey || '').slice(0, 60),
              hint: holdReason === 'force-skip'
                ? '这一卷在「暂停」冷却窗口内，窗口过了自己会重来（看上一条 quiz paused / skip quiz）'
                : (holdReason === 'in-progress'
                  ? '上一轮答题还没结束；超过 5 分钟会按状态泄漏自愈'
                  : '自认这份卷子已答完，但页面上既没有结果页也没有重做提示，题目身份也认不出变化')
            });
          }
          return;
        }
      }
      if (!this.configs.enableQuiz) { // 硬守卫：AI 答题开关关闭时只刷课，任何情况下都不取题、不调 API
        this._skipQuizForApiUnavailable(null, preferredDoc || null);
        return;
      }
      if (this._isQuizApiUnavailable()) {
        this._skipQuizForApiUnavailable(null, preferredDoc || null);
        return;
      }
      if (this._shouldSkipQuizBySubmitAttempts(preferredDoc || null)) {
        this._forceSkipQuizAfterMaxAttempts(preferredDoc || null);
        return;
      }
      // 字体反爬解密在 content.js 里异步进行（MutationObserver + 有界防抖），抽题原本不等它 ——
      // 竞态窗口里抽到的是密文题干，直接发给模型必错还烧 token（README 已知缺陷 #6 的竞态面）。
      // 看到 .font-cxsecret 残留就等下一轮 tick（解密扫描通常 300ms~1s 内完成）；
      // 上限 8 秒：真解不出来就按现状继续，交给下面的题干乱码守卫接手，绝不死等成新的卡死点。
      //
      // ⚠️ 两条从日志里长出来的修正（2026-11-10 批次 5）：
      //   ① 探测范围收成**题目那一份文档及其子帧**。不相干的装饰帧里常年挂着解不掉的残留，
      //      整页扫描会把它们算成"这一卷还没解密"，于是每份卷子先白等满 8 秒再照答 ——
      //      实测两份题面本来就正常的卷子各白等 8.1s / 12.2s，用户看到的就是"卡住不答题"。
      //   ② 除了 data-om-font-miss，还认解密层的**终局判据**（nodecl / nomap，见 _probeFontDecrypt）：
      //      它已经明确说过"这一份解不了"，再等 8 秒也不会多出一个字形。
      var fontProbe = this._probeFontDecrypt(preferredDoc || null);
      if (fontProbe.secret) {
        var fontNoWait = fontProbe.miss || fontProbe.terminal;
        var fontWaitLimitMs = scaledMs(Number(this.configs.fontDecryptWaitMs || 8000));
        if (fontNoWait) {
          // 本轮不等：把等待窗口清掉，别留一个"等到一半"的戳给下一轮误读
          this._fontSecretWaitSince = 0;
          // 这条会被 OCS 循环每秒撞到，必须节流（30 秒一条，并报压掉了多少条）
          if (!this._fontNoWaitLogAt || Date.now() - this._fontNoWaitLogAt > 30000) {
            var noWaitSuppressed = this._fontNoWaitSuppressed || 0;
            this._fontNoWaitLogAt = Date.now();
            this._fontNoWaitSuppressed = 0;
            emitRuntimeLog('info', 'font decrypt verdict: answer as-is', {
              state: fontProbe.state,
              fontMiss: fontProbe.miss,
              terminal: fontProbe.terminal,
              scope: preferredDoc ? 'quiz-doc' : 'whole-page',
              suppressed: noWaitSuppressed,
              hint: fontProbe.miss
                ? '字形哈希在映射表里查不到（data-om-font-miss）—— 等也不会变好，按现状作答并交给乱码守卫'
                : '解密层已对这一份文档给出终局判据：nodecl=文档里没有字体声明，nomap=映射表建不起来'
            });
          } else {
            this._fontNoWaitSuppressed = (this._fontNoWaitSuppressed || 0) + 1;
          }
        } else {
          // ⚠️ 「解密扫描**没覆盖到这一份文档**」时等满 8 秒是纯白等（批次 9-B）。
          // 真实日志 00:46:41 → 00:46:49：`state:"(none)"`、`sweepAgoMs:-1` 等满上限，
          // 一个字也没多解出来 —— 而 content.js 那一次扫描若真会跑到这一份文档，
          // 两秒多的防抖窗口就足够落戳。**已经在扫的文档（有戳）仍等满原窗口**，
          // 别把这条宽限当成"整体不等"。
          var sweepNotCovered = fontProbe.sweepAgoMs < 0 || fontProbe.state === '(none)';
          var fontEffectiveLimitMs = sweepNotCovered ? Math.min(fontWaitLimitMs, scaledMs(2500)) : fontWaitLimitMs;
          var secretWaitSince = this._fontSecretWaitSince || 0;
          if (!secretWaitSince) {
            this._fontSecretWaitSince = Date.now();
            // state='(none)' / sweepAgoMs=-1 就说明 content.js 那一次扫描**没跑到这一份文档**
            // —— 这是"连解码都没有"这句话唯一能被证实的形式，也是下一轮排查的落点。
            emitRuntimeLog('info', 'quiz waiting font decrypt', {
              hint: '题目文字还在 font-cxsecret 密文态，等解密扫描完成（本条每轮等待窗口只打一次）',
              state: fontProbe.state,
              sweepAgoMs: fontProbe.sweepAgoMs,
              waitLimitMs: fontEffectiveLimitMs,
              scope: preferredDoc ? 'quiz-doc' : 'whole-page'
            });
            return;
          }
          if (Date.now() - secretWaitSince < fontEffectiveLimitMs) return;
          this._fontSecretWaitSince = 0;
          emitRuntimeLog('warn', 'font decrypt pending over limit, answer anyway', {
            waitedMs: Date.now() - secretWaitSince,
            limitMs: fontEffectiveLimitMs,
            configuredLimitMs: fontWaitLimitMs,
            slowFactor: perfFactor(),
            state: fontProbe.state,
            sweepAgoMs: fontProbe.sweepAgoMs,
            scope: preferredDoc ? 'quiz-doc' : 'whole-page',
            hint: sweepNotCovered
              ? '这一份文档上连扫描戳都没有 —— 是 content.js 的解密扫描没覆盖到它，不是解得慢；批次 9-B 之后不再为此白等满配置窗口'
              : '等满上限仍未解出，按现状作答'
          });
        }
      } else {
        this._fontSecretWaitSince = 0;
      }
      this._quizInProgress = true;
      this._quizInProgressAt = Date.now();
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';
      this._rememberCorrectQuizAnswers(preferredDoc || null);
      var questions = this._extractQuestions(preferredDoc);
      if (questions.length === 0) {
        console.warn('[Omitone] no questions extracted');
        // 扫不到题这件事必须留下可查的线索，否则用户只能反馈"AI 扫描不到题目"，
        // 而这句话后面藏着至少四种完全不同的原因（见 hint）。30 秒节流避免刷屏。
        if (Date.now() - (this._quizScanDiagAt || 0) > 30000) {
          this._quizScanDiagAt = Date.now();
          var diag = this._diagnoseQuestionScan(preferredDoc);
          emitRuntimeLog('error', 'quiz scan found 0 questions', {
            hint: diag.hint || '',
            docs: diag.docs.length,
            matchedSelectors: diag.docs.reduce(function (sum, d) {
              return Object.assign(sum, d.selectors);
            }, {}),
            inputs: diag.docs.reduce(function (sum, d) { return sum + d.inputs; }, 0),
            // ⚠️ 批次 12：`dropStages` 是「选择器 → {matched,filtered,deduped,unparsable}」。
            // 旧写法把每条的值当**数字**读，落盘就成了 `div[class*="question"]:NaN`；
            // 这里统一压成标量串（口径与 `_quizScanRetrySignal`、`_skipCompletedEvidence` 同一份）。
            // 并把容器是从**哪几份文档**数的也一起落盘 ——
            // 真页面实测：`containers` 以前固定在卡片页上数，卷子那份文档永远数不到（恒为 0）。
            containers: Number(diag.containers) || 0,
            containerDocs: Number(diag.containerDocs) || 0,
            containerPaths: String(diag.containerPaths || '').slice(0, 150),
            dropStages: this._flattenDropStages(diag.dropStages),
            samples: diag.samples.slice(0, 3)
          });
        }
        this._quizInProgress = false;
        // ⚠️ 批次 11-A：这一族的「0 题」必须喂给完成判定，不能只写一句诊断就扔掉。
        // 真实日志 00:46:04 已经量到了正确形状（`inputs:9` + 题形命中 1 + 容器 0），
        // 那是平台还没把卷子写进子帧 —— 00:46:16 重新加载后同一份当场答成 3 题。
        // 当时没有任何判据读这份数字，1 秒后就是 `skip completed {by:"all-tasks-finished"}`，
        // 用户看到的正是「第二个不答」+「判定为已完成了」。
        // 窗口有界：每张卡片一次、≤12 秒，用完照旧推进（`_quizScanRetrySignal` 在预算已用掉
        // 或窗口已武装时直接返回 null，所以这里每节课最多多扫一次诊断）。
        var scanSig = this._quizScanRetrySignal(preferredDoc);
        if (scanSig) this._maybeHoldSkipForUnparsedQuiz(scanSig, 'quiz-scan');
        return;
      }
      this._quizCurrentQuestions = questions;
      // 先解析本文档：「有没有进展」的判断要用它（后面填答用的是同一个表达式，
      // 这份先算好，避免同一个表达式出现两份）。
      var quizDocForProgress = preferredDoc || this._getQuizDocumentFromQuestions(questions) || null;
      if (quizDocForProgress) {
        // 「没进展就别每 30 秒把整卷重问一遍」的闸。
        //
        // 现场实测（2026-10-10）：25 题只填上 23，之后每轮都是
        // `clear stale quiz answers {"count":23}` → 把 23 条抹掉 → 把 25 题**原样重问一遍**，
        // 日志一轮一轮一模一样（用户看到的"一直卡住、填的还是重复的答案"），
        // 既没有进展又白烧 token。
        // 判据：**页面上已填题数与上轮相同**（=这一轮不会有新进展）且距上轮不足 60 秒 → 跳过本轮。
        // 窗口只有 60 秒，之后照常重试 —— 不会把它永久卡死（本仓库对"拿不准"的一贯取舍）。
        // ⚠️ 这两个状态必须**按卷子隔离**。
        // 实测（2026-10-17）：上一份卷子最后一轮 filled=0，紧跟着换到新卷子，
        // 新卷子第一轮当然也是 filled=0 → 被误判成"没有进展" → **新卷子白等 60 秒才开答**。
        // 用户看到的就是"做完上一题之后卡顿一下才开始做这道"。
        var quizPaperKey = '';
        try { quizPaperKey = String(this._getQuizWorkKey(quizDocForProgress) || ''); } catch (ePaperKey) {}
        // ⚠️ 按卷冷却写入时必须用**这一个**键（`quizPaperKey`）。
        // 判定端 `_isQuizForceSkipping(doc)` 用的文档表达式是
        // `doc || _getQuizDocumentFromQuestions(_quizCurrentQuestions) || null`，
        // 而调用点传的 `doc` 就是这里的 `preferredDoc`，且 `_quizCurrentQuestions` 已被
        // 赋成这里的 `questions` —— 两侧算出的文档**同一个**，键才可能对得上。
        // 别在这里再算一份「兜底用无参 `_getQuizWorkKey(null)`」的键：那正是读写侧错开的方式。
        if (quizPaperKey !== this._quizRoundPaperKey) {
          this._quizRoundPaperKey = quizPaperKey;
          this._quizRoundFilledCount = -1;   // -1 与任何真实题数都不相等 → 新卷子必定放行
          this._quizRoundNoProgressAt = 0;
          this._quizNoProgressLogAt = 0;
          this._quizZeroFillRounds = 0;
          this._quizZeroFillAt = 0;
        }

        // ===== 题干乱码守卫（第二层保护）=====
        //
        // 第一层是上面那道「等解密」：.font-cxsecret 类名还在时不抽题。
        // 但解密扫描完成后、映射表里却没有那个字形哈希时（表快照落后于平台字符集），
        // 残留的 PUA 字符（U+E000~U+F8FF）会混进题干 —— 发给模型必错，还白烧 token 与提交次数。
        // README 的口径是「看到乱码请立刻停下」：这里把它变成机器判据 ——
        // 按卷子记轮数（⚠️ 必须按卷子隔离，同 #43 的教训），连续 3 轮仍有乱码就**暂停这一卷** 90 秒。
        // ⚠️ 必须放在「无进展闸」**之前**：乱码卷 filled 计数不变，会被 60 秒闸先拦下，
        // 轮次就永远数不满、乱码卷永远跳不出。
        var garbledCount = 0;
        for (var gi = 0; gi < questions.length; gi++) {
          if (questions[gi].garbled) garbledCount++;
        }
        // 主信号（文档级）：content.js 解密时统计「出现了自定义字形但查表未命中」——
        // font-cxsecret 的真实机制是**正常中文字符 + 自定义字形**，不是 PUA 私有区！
        // 表缺字形时题干是通顺但错误的中文，下面按字符占比的 PUA 检测（兜底层）根本
        // 看不出来 —— 解密层的 miss 标记才是可靠信号（真实机制由同类开源实现交叉证实）。
        // ⚠️ 探测文档**以题目所属文档为准**，不以调用方传进来的 `quizDocForProgress` 为准。
        // `quizDocForProgress` 优先取 preferredDoc，而 `_extractQuestions(preferredDoc)`
        // 会自己钻 `#frame_content` 到**内层文档**抠题 —— 于是出现「preferredDoc 是外层、
        // 题在内层」。content.js 的 `data-om-font-miss` 写在它**解密的那一个文档**上
        // （=有题的那一个），只查外层就等于把守卫**静默关掉**（失败方向还不保守：
        // 乱码题照样发给模型），真实嵌套页就是这样漏的。
        // 一份页面上的题还可能分属**多个**文档，所以这里去重后**逐个探**
        // （宁可多探，不可漏探）；只探出题文档，不探既不出题的装饰帧 ——
        // 后者会把守卫变成"页面上随便哪个帧残留个标记就整卷暂停"的误报源。
        // 一个出题文档都拿不到时才退回 quizDocForProgress（旧语义），**不走全书扫描**。
        var garbledProbeDocs = [];
        try { garbledProbeDocs = this._getQuizDocumentsFromQuestions(questions); } catch (eProbeDocs) { garbledProbeDocs = []; }
        if (!garbledProbeDocs.length && quizDocForProgress) garbledProbeDocs = [quizDocForProgress];
        var probeMiss = false;
        for (var gpi = 0; gpi < garbledProbeDocs.length; gpi++) {
          if (this._hasFontDecryptMiss(garbledProbeDocs[gpi])) { probeMiss = true; break; }
        }
        if (!garbledCount && probeMiss) {
          garbledCount = questions.length;
        }
        if (garbledCount) {
          if (quizPaperKey !== (this._quizGarbledPaperKey || '')) {
            this._quizGarbledPaperKey = quizPaperKey;
            this._quizGarbledRounds = 0;
            this._quizGarbledRoundAt = 0;   // 换了一份卷子 → 新一轮立刻可计
          }
          // ⚠️ 轮次按**时间窗**累加，绝不能按调用次数（真实现场 2026-11-10）：
          // 本函数被 OCS 循环**每秒**调一次，按次数累加时 3 秒就数满 3 轮，
          // "跳过"比"乱码"发生得还快；而且每一秒一条 warn，200 条的日志缓冲
          // 两个半分钟就被刷空，排查时连"发生过什么"都看不到。
          // 现在只有距上次计数 ≥10 秒才 +1，warn 也跟着只在计数时打（每 10 秒最多一条）。
          var garbledNow = Date.now();
          var garbledCounted = !this._quizGarbledRoundAt || garbledNow - this._quizGarbledRoundAt >= 10000;
          if (garbledCounted) {
            this._quizGarbledRoundAt = garbledNow;
            this._quizGarbledRounds = (this._quizGarbledRounds || 0) + 1;
            emitRuntimeLog('warn', 'quiz text garbled by font decrypt', {
              garbled: garbledCount,
              total: questions.length,
              rounds: this._quizGarbledRounds
            });
          }
          this._quizInProgress = false;
          if (this._quizGarbledRounds >= 3) {
            this._quizGarbledPaperKey = '';
            this._quizGarbledRounds = 0;
            this._quizGarbledRoundAt = 0;
            // 数满 3 轮**不再跳卷**。原来的 `_skipQuiz()` 会走 `nextUnit()` 把整节翻过去，
            // 可"乱码"只说明这份卷子的题面读不得，不表示这一节该放弃 ——
            // 而跳走的代价是**不可见**的（用户只会看到"所有题目都被跳过"）。
            // 改成给这一卷 90 秒按卷冷却：代价可见（这一节还停在这里）、且会自愈
            // （90 秒后同一份卷子再试一次，换了别的卷子完全不受影响）。
            // 本仓库的一贯取舍：拿不准就停住、留日志，别替用户翻页。
            this._setQuizForceSkip(90000, quizPaperKey);
            emitRuntimeLog('error', 'quiz paused: text stays garbled', {
              garbled: garbledCount,
              hint: '连续 3 轮题干仍含密文字符 —— 字体映射表（resources/table.json）可能缺少新字形，更新后重新构建即可恢复；这一卷暂停 90 秒，不跳走'
            });
            return;
          }
          return;
        }
        if (quizPaperKey && quizPaperKey === (this._quizGarbledPaperKey || '')) {
          this._quizGarbledPaperKey = '';
          this._quizGarbledRounds = 0;
        }

        var filledNow = 0;
        for (var fi = 0; fi < questions.length; fi++) {
          if (this._getQuizQuestionFilledValue(quizDocForProgress, questions[fi])) filledNow++;
        }
        var nowProgress = Date.now();
        var sinceLast = nowProgress - (this._quizRoundNoProgressAt || 0);
        if (this._quizRoundFilledCount === filledNow && sinceLast < 60000) {
          // ===== 零填充死循环的出口 =====
          //
          // `filledNow === 0` 不是"这轮没进展"，而是**这卷一道题都落不到页面上**
          //（选项认不出 / 点不上）。原来的闸只管"别重问"，于是变成：
          //   ？秒后放行 → 重问 → 还是 0 → 再闸 60 秒 → …
          // 现场（2026-11-10 14:00）：整整 5 轮 `quiz round skipped: no progress`，
          // 页面一步没动，后面的任务全部做不了 —— 用户看到的就是"卡死了"。
          // 任务点的"卡住就放弃"计数也接不住它：`_taskProgressSnapshot` 对卷子恒为空，
          // 按那条规则"测不到进度一律不计"。
          //
          // 所以这里按**分钟**计数（本函数每秒都会被调一次，不能按调用次数算），
          // 连续 3 轮零填充就明确跳过这一卷、**只让这一卷**暂停 90 秒 —— 让后面的任务先走。
          // 只是跳过，不删任何记录：下一轮课程还能重新答。
          if (filledNow === 0) {
            var zeroNow = Date.now();
            if (!this._quizZeroFillAt || zeroNow - this._quizZeroFillAt >= 55000) {
              this._quizZeroFillAt = zeroNow;
              this._quizZeroFillRounds = (this._quizZeroFillRounds || 0) + 1;
            }
            // ⚠️ 只有显式打开 `quizZeroFillSkip` 才允许跳过。
            // 默认关：跳过是**不可见**的（用户只会看到"所有答题都废了"），
            // 而卡住至少看得见、能手动做。这条教训是 2026-11-10 用真实课程换来的。
            if (this._quizZeroFillRounds >= 3 && this.configs.quizZeroFillSkip === true) {
              this._quizZeroFillRounds = 0;
              this._quizZeroFillAt = 0;
              this._quizInProgress = false;
              this._quizAnswered = false;
              this._quizCurrentQuestions = null;
              this._quizReadyToSubmit = false;
              this._quizReadyWorkKey = '';
              this._setQuizForceSkip(90000, quizPaperKey);
              emitRuntimeLog('error', 'quiz skipped: no question could be filled', {
                total: questions.length,
                rounds: 3,
                hint: '这一卷的题一个都落不到页面上（选项认不出或点不上），先跳过去做后面的任务；只有这一卷暂停 90 秒，别的卷子照常'
              });
              this.nextUnit();
              return;
            }
          } else {
            this._quizZeroFillRounds = 0;
            this._quizZeroFillAt = 0;
          }

          // ⚠️ 这条必须节流：本函数被 OCS 循环**每秒**调一次，60 秒窗口内会打出
          // 60 条一模一样的 warn —— 实测把 200 条的日志缓冲整段刷满，
          // 真正有用的记录全被挤掉，排查时连"发生过什么"都看不到。
          if (!this._quizNoProgressLogAt || nowProgress - this._quizNoProgressLogAt > 10000) {
            this._quizNoProgressLogAt = nowProgress;
            emitRuntimeLog('warn', 'quiz round skipped: no progress', {
              filled: filledNow,
              total: questions.length,
              retryInMs: 60000 - sinceLast,
              hint: '同一份卷子这一轮不会拿到新答案，先不重问（省 token）；60 秒后照常重试（本条日志每 10 秒最多一条）'
            });
          }
          this._quizInProgress = false;
          return;
        }
        this._quizRoundFilledCount = filledNow;
        this._quizRoundNoProgressAt = nowProgress;
      }
      // ===== 题目配图 → 文字（可选，默认关闭）=====
      //
      // 放在这里的原因：题目已经解析完、还没发请求。此时：
      //   - 题干与选项都在手里，能准确判断哪道题真的带图（省掉无图题的冤枉请求）
      //   - 一次只处理**这一卷**的题，开销天然有上界
      //   - 失败也无所谓，往下走就是"和没开视觉时完全一样"
      //
      // 它是 async 的，会 await 一段时间。但预算与张数都有硬上限，
      // 最坏情况就是这一卷慢一点，不会失控。
      // 乱选模式跳过配图识别：既然答案是随机的，把图读成文字纯属白花 token。
      if (!this._isRandomAnswerMode()) {
        await this._applyVisionToQuestions(questions, preferredDoc || null);
      }

      var quizDoc = preferredDoc || this._getQuizDocumentFromQuestions(questions) || null;

      this._clearUnconfirmedQuizAnswers(questions, quizDoc);
      var allQuestionsConfirmedCached = this._areAllQuizQuestionsConfirmedCached(questions, quizDoc);
      this._fillCachedQuizAnswers(questions, quizDoc);
      this._clearKnownWrongFilledQuizAnswers(questions, quizDoc);
      if (allQuestionsConfirmedCached && this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true })) {
        console.log('[Omitone] quiz ready from cached correct answers');
        this._quizAnswered = true;
        this._quizReadyToSubmit = true;
        this._quizReadyWorkKey = this._getQuizWorkKey(quizDoc);
        this._quizInProgress = false;
        this._maybeSubmitQuiz(quizDoc, questions);
        return;
      }

      var self = this;
      var payload = [];
      var skippedConfirmed = 0;
      var skippedBestEffort = 0;
      // ===== 多选**照旧问模型**（批次 7 改回来的）=====
      //
      // 这里原本有一趟"多选本地作答"，用来省 token。它的前提被现场推翻了：
      //   · 本地答案是猜的 —— 一份卷子里只要有多选，基本就过不了及格线（该方法自己的注释就这么写）；
      //   · 而 2026-11-10 真实日志里 `quiz submit attempt count {count:1,max:2}` ——
      //     **课后检测只给两次机会**。第一趟拿猜的答案去交，等于白白烧掉一次真提交；
      //     第二趟交回模型时，已经用过的那次提交并不能把正确率换回来。
      // 用户 2026-11-10 的原话：「只回答的多选题，估计是乱选的」——看到的就是这一趟。
      // 现在多选与其他题一样进 payload；本地猜测只剩一个身份：
      // 模型那一份**填不进 DOM** 之后的补填（见本文件稍后那一趟 `_answerLocalMultiChoiceQuestions(questions, quizDoc)`，
      // 它只在"模型答案落地后仍然空着"时才动手，并把这份卷子记进 `_quizLocalMultiplePapers`）。
      var batchWorkKey = this._getQuizWorkKey(quizDoc);
      // 这一轮是否**整批重发**（含已知正确答案的题）。
      //
      // 为什么要整批重发：DeepSeek 的前缀缓存要求请求前缀完整匹配某个已持久化的
      // 「缓存前缀单元」。第一次提问只发"需要的题"，重试若再从中间删掉几道，
      // 前缀就从删除处断掉 —— 命中率归零。
      // 整批重发时，重试的输入是上一次输入的**超集且前缀一致**（官方 Example 1 的
      // `A+B` → `A+B+C`），整段命中，按约 1/10 价计费。
      //
      // 但不能无条件整批重发：第一次提问时如果一个都没有发过，多带的题只会按原价
      // 计费。所以只在"本卷刚发过请求"（30 分钟内）时才整批重发。
      var batchRecent = batchWorkKey
        && batchWorkKey === this._quizBatchSentKey
        && (Date.now() - (this._quizBatchSentAt || 0) < 30 * 60 * 1000);

      questions.forEach(function (q, i) {
        // 已进入"放弃折腾"的题**不再问模型**：它已经试过好几轮都没被接受，
        // 再问只会把整卷拖在同一个地方（用户报的"一直卡住"），而且白花 token。
        // 这一类题的答案由 _fillBestEffortQuizAnswers 在本地补齐，有日志、可恢复。
        if (self._isQuizQuestionBestEffort(q, quizDoc)) {
          skippedBestEffort++;
          return;
        }
        // 已经"确认正确 + 本轮已填 + DOM 里确实有值"的题不再问模型：
        // _fillCachedQuizAnswers 已经把答案填回去了，重复提问纯属白花 token。
        // 三个条件必须同时成立 —— 只看缓存会让"缓存存在但填不进去"的题永远没人作答，
        // 导致表单填不满、反复重试。
        var alreadyCorrect = self._getConfirmedCachedQuizAnswer(q, quizDoc)
          && self._wasQuizQuestionAnsweredThisRun(q)
          && self._isQuizQuestionFilled(quizDoc, q);
        if (alreadyCorrect) {
          skippedConfirmed++;
          if (!batchRecent) return;
        }
        var wrongAnswers = self._getKnownWrongQuizAnswers(q, quizDoc).map(function (item) {
          return item.answer || item.canonical;
        });
        // index 必须是该题在 questions[] 中的位置：_fillAnswers 用 answerItem.index 取题。
        // content.js 会把这个值原样透传回来，不会因为分批而错位。
        payload.push({ index: i, type: q.type, title: q.title, options: q.options, previousWrongAnswers: wrongAnswers });
      });

      if (skippedConfirmed > 0 || skippedBestEffort > 0) {
        emitRuntimeLog('info', batchRecent ? 'resend full batch for prefix cache' : 'skip llm for cached-correct questions',
          { skipped: skippedConfirmed, bestEffort: skippedBestEffort, asked: payload.length });
      }
      if (payload.length) {
        // 记在"发出去"这一侧而不是"收到成功响应"那一侧：缓存单元是在请求到达时建立的，
        // 即便这次解析失败，前缀也已经进了缓存，下次仍可命中。
        this._quizBatchSentKey = batchWorkKey;
        this._quizBatchSentAt = Date.now();
      }
      if (payload.length === 0) {
        // 两种情况：
        //   ① 全部题目都靠缓存填好了，却没能走上面的提前提交分支 —— 状态自相矛盾，
        //      此时发一次空请求只会白白消耗配额；
        //   ② **全部题目都进了"放弃折腾"**。这种必须自己收尾：本地填猜测、能交就交，
        //      否则这一卷会永远停在"不发请求、也不提交"的状态 —— 又是一种卡住。
        // （批次 7 之前还有第三种"整卷都是多选、已本地作答"—— 多选现在照旧问模型，那一支没了。）
        emitRuntimeLog('warn', 'quiz payload empty after cache filter', {
          total: questions.length,
          bestEffort: skippedBestEffort
        });
        if (skippedBestEffort > 0) {
          this._fillBestEffortQuizAnswers(questions, quizDoc);
          // 这条分支**不会再发请求**（payload 为空），所以它是这一卷最后一次机会：
          // 还空着的题若不补占位，`rescueReady` 永远 false → 不发不交 → 整节原地转圈。
          this._fillBlankQuizQuestions(questions, quizDoc);
          var rescueReady = this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true });
          this._quizAnswered = rescueReady;
          this._quizReadyToSubmit = rescueReady;
          this._quizReadyWorkKey = rescueReady ? this._getQuizWorkKey(quizDoc) : '';
          this._quizInProgress = false;
          if (rescueReady) this._maybeSubmitQuiz(quizDoc, questions);
          return;
        }
        this._quizInProgress = false;
        return;
      }

      try {
        // 乱选模式：**不发任何请求**，本地生成同形状的 result，直接走后面的填充。
        // 下游（填充 / 提交 / 判分识别）因此一行都不用改 —— 只换「答案从哪来」。
        var result;
        if (this._isRandomAnswerMode()) {
          this._logRandomAnswers(questions);
          result = { success: true, data: this._buildRandomQuizAnswers(questions) };
        } else {
          result = await bridgeSend('llm_request', { questions: payload });
        }
        if (!result || !result.success) {
          console.error('quiz llm request failed:', result && result.error ? result.error : 'unknown');
          this._quizInProgress = false;
          if (result && result.parseError) {
            // API 连接正常，仅答案解析失败：保留测验稍后重试，不标记连接失败
            emitRuntimeLog('warn', 'quiz llm parse failed, keep quiz for retry', {
              error: String(result.error || '').slice(0, 160)
            });
            this._setQuizForceSkip(8000);
            return;
          }
          if (result && result.permanentError) {
            // 服务商返回 4xx：配置问题（Key 无效 / 无权限 / 模型名不存在）。
            //
            // 这一支必须**早于** `_markQuizApiConnectionFailed`：
            // 那会设一个 45 秒的 `_quizApiFailUntil` 退避窗口，于是"填错 Key"
            // 在用户眼里变成"网络连不上、插件每隔 45 秒卡一下"，
            // 而服务商明明把 "Invalid API key" 原话返回来了。
            // 所以这里只跳过本轮、把原话留给用户，改好配置后自动恢复。
            emitRuntimeLog('error', 'quiz llm rejected permanently, no retry', {
              error: String(result.error || '').slice(0, 200),
              skipMs: PERMANENT_LLM_ERROR_SKIP_MS
            });
            this._quizApiLastError = String(result.error || '').slice(0, 300);
            this._setQuizForceSkip(PERMANENT_LLM_ERROR_SKIP_MS);
            return;
          }
          this._markQuizApiConnectionFailed(result && result.error ? result.error : 'LLM 请求失败');
          this._skipQuizForApiUnavailable('llm-request-failed', quizDoc);
          return;
        }

        var answers = Array.isArray(result.data) ? result.data : (result.data && Array.isArray(result.data.answers) ? result.data.answers : []);
        console.log('[Omitone] quiz answers count:', answers.length, answers);
        if (!answers.length) {
          this._quizInProgress = false;
          return;
        }

        this._fillAnswers(answers, questions, quizDoc);
        this._fillCachedQuizAnswers(questions, quizDoc);
        this._clearKnownWrongFilledQuizAnswers(questions, quizDoc);
        // 补填"放弃折腾"的题：它们没进这次请求，表单缺了它们就永远不提交。
        // 放在清理之后是有意的：先让 `_clearKnownWrongFilledQuizAnswers` 处理其他题，
        // 再补上这些题的本地猜测，本轮就不会被它误清。
        this._fillBestEffortQuizAnswers(questions, quizDoc);
        // 多选**补填**（批次 7 之后本地答案只剩这一个身份）：它是**幂等**的 ——
        //   上面 `_fillAnswers` 已经填好的题在入口第一道判断上就返回了（不重填，
        //   复选重填会把自己切掉），只有仍然空着的才被补上。
        // 少了这一步就有个窄缝：模型给的多选组合恰好落在"已知错答"里（组合试完那一种），
        // 会被上面那步抹掉、又没有别的答案可补 → 表单缺一题 → 整卷永不提交。
        this._answerLocalMultiChoiceQuestions(questions, quizDoc);
        // 交卷前的最后一道占位（批次 16）：模型那一份被整批丢弃、多选也补不上的题，
        // 不再留白 —— 留白就是稳丢的分，而且表单不满这一卷永远交不出去。
        this._fillBlankQuizQuestions(questions, quizDoc);
        var formReady = this._areQuizAnswersFilled(quizDoc, questions, { requireThisRun: true });
        console.log('[Omitone] quiz form ready:', formReady);
        this._quizAnswered = formReady;
        this._quizReadyToSubmit = formReady;
        this._quizReadyWorkKey = formReady ? this._getQuizWorkKey(quizDoc) : '';
        this._quizInProgress = false;
        if (formReady) {
          this._maybeSubmitQuiz(quizDoc, questions);
        } else {
          console.warn('[Omitone] skip submit because some answers are still empty');
        }
      } catch (e) {
        this._quizInProgress = false;
        console.error('quiz llm error:', e);
        this._markQuizApiConnectionFailed(e);
        this._skipQuizForApiUnavailable('llm-request-error', quizDoc);
      }
    },

    _extractQuestions: function (preferredDoc) {
      var foundQuestions = [];
      if (preferredDoc) {
        try {
          var innerQuizFrame = preferredDoc.getElementById && preferredDoc.getElementById('frame_content');
          if (innerQuizFrame) {
            var innerQuizDoc = innerQuizFrame.contentDocument || (innerQuizFrame.contentWindow && innerQuizFrame.contentWindow.document);
            if (innerQuizDoc) {
              var innerQuestions = this._extractFromDocument(innerQuizDoc);
              console.log('[Omitone] inner quiz frame questions:', innerQuestions.length);
              if (innerQuestions.length > 0) {
                for (var iq = 0; iq < innerQuestions.length; iq++) {
                  innerQuestions[iq]._inIframe = true;
                  innerQuestions[iq]._iframe = innerQuizFrame;
                }
                return innerQuestions;
              }
            }
          }
        } catch (innerErr) {}

        var directQuestions = this._extractFromDocument(preferredDoc);
        console.log('[Omitone] preferred quiz doc questions:', directQuestions.length);
        if (directQuestions.length > 0) {
          var directFrame = null;
          try {
            directFrame = preferredDoc.defaultView && preferredDoc.defaultView.frameElement;
          } catch (e) {}
          for (var d = 0; d < directQuestions.length; d++) {
            directQuestions[d]._inIframe = !!directFrame;
            directQuestions[d]._iframe = directFrame;
          }
          return directQuestions;
        }
      }
      this._walkDocuments(function (doc) {
        var questions = this._extractFromDocument(doc);
        if (questions.length > 0) {
          var frame = null;
          try {
            frame = doc.defaultView && doc.defaultView.frameElement;
          } catch (e) {}
          for (var i = 0; i < questions.length; i++) {
            questions[i]._inIframe = !!frame;
            questions[i]._iframe = frame;
          }
          foundQuestions = questions;
          return true;
        }
        return false;
      }.bind(this));
      return foundQuestions;
    },

    _getQuizDocumentFromQuestions: function (questions) {
      if (!questions || !questions.length) return null;
      for (var i = 0; i < questions.length; i++) {
        try {
          var el = questions[i] && questions[i]._element;
          if (el && el.ownerDocument) return el.ownerDocument;
        } catch (e) {}
      }
      return null;
    },

    /**
     * 「这些题分别落在**哪几个**文档里」—— 上面那个单数版的复数版，按文档去重。
     *
     * 为什么要单独有它（HIGH-2）：一份页面上的题**可能分属多个文档**
     * （外层 + 内层 `#frame_content`，甚至两个平级 iframe）。
     * 只探「第一个出题文档」会漏掉后面的那些 —— 而漏探的失败方向是
     * **把乱码题放行给模型**（不保守），正是乱码守卫要防的事。
     * 判"这份卷子读不读得"这类守卫一律用它逐个探：**宁可多探，不可漏探**。
     *
     * @param {Array} questions 抠出来的题（带 `_element`）
     * @returns {Array} 去重后的出题文档，按首次出现顺序
     */
    _getQuizDocumentsFromQuestions: function (questions) {
      var docs = [];
      if (!questions || !questions.length) return docs;
      for (var i = 0; i < questions.length; i++) {
        try {
          var el = questions[i] && questions[i]._element;
          var doc = el && el.ownerDocument;
          if (doc && docs.indexOf(doc) === -1) docs.push(doc);
        } catch (e) {}
      }
      return docs;
    },

    _looksLikeQuizTitle: function () {
      var title = this._getCurrentTitle();
      return title.indexOf('章节测验') !== -1 || title.indexOf('作业') !== -1 || title.indexOf('考试') !== -1;
    },

    _extractFromDocument: function (doc) {
      var questions = [];
      if (!doc || !doc.querySelectorAll) return questions;

      var containers = this._collectQuestionContainers(doc);
      if (!containers.length) return questions;

      var self = this;
      containers.forEach(function (container, index) {
        var question = self._parseQuestionElement(container, index);
        if (question) questions.push(question);
      });
      return questions;
    },


    /**
     * 「这一份文档（含它的子帧）里到底还有没有没解开的密文」+「解密层给出的结论」。
     *
     * 一次遍历同时收四件事，省掉 `_handleQuiz` 里三回重复的全页扫描：
     *   secret   —— 还有带文字的 .font-cxsecret（=「还没解开」）
     *   miss     —— 这些文档里有 data-om-font-miss（表缺字形的实锤）
     *   terminal —— 这些文档里有 content.js 的**终局判据**（nodecl / nomap）：
     *               扫描确实跑到过这一份、并且明确说了"再等也不会好"。
     *               以前闸门只认 miss，于是「文档里根本没有字体声明」这一族
     *               每份卷子都要白等满 8 秒才继续（实测 2026-11-10：8.1s / 12.2s 各一次，
     *               而这两份卷子的题面其实是好的）—— 这就是用户看到的"卡住"。
     *   state    —— 各文档的结论拼起来，写进日志。`state:'(none)'` 直接说明
     *               content.js 那一次扫描**没跑到这一份文档**（不是"跑过但解不开"），
     *               这是"连解码都没有"这句话唯一能被证实的形式。
     *   sweepAgoMs —— 最近一次扫描距今多久；-1 = 这些文档上从来没有过扫描戳。
     *
     * @param {Document} [startDoc] 传了就只从这一份文档往下走（含它的子帧）；
     *   不传 = 全书扫描（没有 preferredDoc 时的旧语义）。
     */
    _probeFontDecrypt: function (startDoc) {
      var out = { secret: false, miss: false, terminal: false, state: '', sweepAgoMs: -1 };
      var freshest = -1;
      var addState = function (st) {
        if (!st || out.state.indexOf(st) !== -1) return;
        out.state = out.state ? out.state + ',' + st : st;
      };
      var probe = function (doc) {
        if (!doc || !doc.querySelector) return false;
        var hit = false;
        try {
          var nodes = doc.querySelectorAll('.font-cxsecret');
          for (var i = 0; i < nodes.length; i++) {
            if (textOf(nodes[i]).length > 0) { hit = true; break; }
          }
        } catch (e) { return false; }
        if (!hit) return false;      // 没有残留的文档，它的结论对这道闸门没有意义
        out.secret = true;
        var st = '';
        var sw = 0;
        try {
          var el = doc.documentElement;
          if (el && el.getAttribute) {
            st = el.getAttribute('data-om-font-state') || '';
            sw = Number(el.getAttribute('data-om-font-sweep') || 0) || 0;
            if (el.getAttribute('data-om-font-miss')) out.miss = true;
          }
        } catch (e2) {}
        if (st === 'nodecl' || st === 'nomap') out.terminal = true;
        addState(st || '(none)');
        if (sw > 0) {
          var ago = Date.now() - sw;
          if (freshest < 0 || ago < freshest) freshest = ago;
        }
        return false;                // 不提前退出：要把每一份出题文档的结论收齐
      };
      if (startDoc) this._walkDocuments(probe, startDoc); else this._walkDocuments(probe);
      out.sweepAgoMs = freshest;
      return out;
    },


    /**
     * 「解密未命中」标记（content.js 解密后写在 documentElement 上）探测。
     *
     * 这是乱码守卫的**主信号**：font-cxsecret 的真实机制是正常中文字符 + 自定义字形
     * （不是 PUA），表缺字形时文本通顺但内容错误 —— 只有解密层自己知道哪些字形没查到。
     *
     * @param {Document} [targetDoc] 传了就**只查这一个文档**。
     *   乱码计数必须走这条：`_walkDocuments` 扫全书时，任何一个不相干的帧带标记
     *   就会把**这一页每一份卷子**都判成乱码 —— 而缺标记的那个帧可能只是课程首页的
     *   一个装饰性子帧。一道坏字形能把整门课的卷子全数暂停，就是"所有题目都被跳过"
     *   的另一条路径（2026-11-10）。题目所在文档自己没带标记，就不算它乱码。
     *   不传 = 全书扫描（排查用的宽口径：「这一页上到底有没有出现过缺字形标记」）。
     *   ⚠️ 「等不等解密」已经不看这里了 —— 那一处走 `_probeFontDecrypt`，
     *   它把密文残留、缺字形标记和解密层的终局判据（nodecl / nomap）一次收齐。
     */
    _hasFontDecryptMiss: function (targetDoc) {
      var probe = function (doc) {
        if (!doc || !doc.documentElement || !doc.documentElement.getAttribute) return false;
        try {
          if (doc.documentElement.getAttribute('data-om-font-miss')) return true;
        } catch (e) {}
        return false;
      };
      if (targetDoc) return probe(targetDoc);
      var found = false;
      this._walkDocuments(function (doc) {
        if (!probe(doc)) return false;
        found = true;
        return true;
      });
      return found;
    },


    /**
     * 一段文字里 PUA 密文字符（U+E000~U+F8FF）的占比 —— **兜底层**。
     *
     * ⚠️ 认知修正（2026-10-31，同类开源实现交叉证实）：font-cxsecret 的真实机制是
     * 「正常中文字符 + 自定义字形」——文本里放的是普通中文，字形却画成别的字。
     * 所以表缺字形时题干是**通顺但错误**的中文，这个 PUA 检测实际上抓不到它；
     * 抓它靠上面的 `_hasFontDecryptMiss`（解密层标记）。本检测保留作兜底：
     * 防其他平台/未来改版真的把密文放进私有区。
     * 占比阈值 0.3：个别未知字形不应拦下整卷，成片密文才判定为乱码。
     */
    _quizTextGarbledRatio: function (text) {
      var meaningful = String(text || '').replace(/\s/g, '');
      if (!meaningful.length) return 0;
      var hits = meaningful.match(/[\uE000-\uF8FF]/g);
      return (hits ? hits.length : 0) / meaningful.length;
    },

    _findVisibleQuizRedoDialog: function () {
      var found = null;
      this._walkDocuments(function (doc) {
        var selectors = ['#workpop', '#submitBack', '.AlertCon02', '.layui-layer', '.dialog', '.modal', '[role="dialog"]', '[role="alertdialog"]'];
        for (var i = 0; i < selectors.length; i++) {
          var nodes = doc.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j])) continue;
            if (/未达到及格线|未达到通过标准|请重做|很遗憾/.test(textOf(nodes[j]))) {
              found = nodes[j];
              return true;
            }
          }
        }
        return false;
      });
      return found;
    },

    _isQuizRedoRequired: function (preferredDoc) {
      var matched = false;
      var docs = [];
      var submitDoc = this._resolveQuizSubmitDocument(preferredDoc);
      if (submitDoc) docs.push(submitDoc);
      if (preferredDoc && docs.indexOf(preferredDoc) === -1) docs.push(preferredDoc);
      if (!docs.length) {
        var mainDoc = this._getMainDocument();
        if (mainDoc) docs.push(mainDoc);
      }
      for (var i = 0; i < docs.length; i++) {
        try {
          var body = docs[i] && docs[i].body;
          if (body && /未达到及格线|未达到通过标准|请重做|很遗憾/.test(textOf(body))) {
            matched = true;
            break;
          }
        } catch (e) {}
      }
      return matched || !!this._findVisibleQuizRedoDialog();
    },

    _prepareQuizRedoIfNeeded: function (preferredDoc) {
      if (!this._isQuizRedoRequired(preferredDoc)) return false;
      if (this._shouldSkipQuizBySubmitAttempts(preferredDoc || null)) {
        return this._forceSkipQuizAfterMaxAttempts(preferredDoc || null);
      }
      this._rememberCorrectQuizAnswers(preferredDoc || null);
      this._rememberWrongQuizAnswers(preferredDoc || null);
      this._quizSubmitPending = false;
      this._quizSubmitStartedAt = 0;
      this._quizAnswered = false;
      this._quizCurrentAnsweredKeys = {};
      this._quizCurrentAnswerValues = {};
      this._quizCurrentQuestions = null;
      this._quizReadyToSubmit = false;
      this._quizReadyWorkKey = '';

      var dialog = this._findVisibleQuizRedoDialog();
      if (dialog) {
        emitRuntimeLog('warn', 'quiz redo required');
        return true;
      }
      return false;
    },

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

        // mooc2 新版作业页把 qid 放在容器的 data 属性上（容器类名 .singleQuesId）。
        // 真源 `_quizDetectorSelector`：closest 按并集找最近的题目容器 ——
        // 真实 TiMu/Cy 容器带的是 qid 属性、没有 data，会正常落到下面的回退，语义不变
        var wrapper = el.closest ? el.closest(this._quizDetectorSelector) : null;
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
        // 真源 `_questionTitleSelectors`：缓存键的取材必须与抠题同源，手抄的那份曾漏了 .Pt1 / .Zy_TItle
        var titleEl = el.querySelector(this._questionTitleSelectors.join(', '));
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
          // 真源 `_quizContainerSelector`（含 .Cy_TItle）：作业/考试页的错答也必须收集，
          // 否则「避开错答」在那两类页面上静默失效（正确答案记忆一直读的是真源，两边曾不对称）
          nodes = Array.from(doc.querySelectorAll(self._quizContainerSelector));
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
     * 多选**补填**：模型那一份落地之后，仍然空着的多选用本地答案填上。
     *
     * ⚠️ 批次 7（2026-11-10）之前，这个方法还兼任「多选根本不问模型」的省 token 路径 ——
     * 在 `_handleQuiz` 拼 payload 之前先本地作答，并把这批题从请求里剔掉。
     * 那个前提被现场推翻了，两条独立证据：
     *   1. 本地答案是**猜的** → 一份卷子只要有一道多选，基本就过不了及格线（这条它自己也承认）；
     *   2. 真实日志里课后检测的上限是 `quiz submit attempt count {count:1,max:2}` ——
     *      **只给两次机会**。第一趟拿猜的答案去交，等于白烧一次真提交。
     * 用户 2026-11-10 的原话就是这一趟的症状：「只回答的多选题，估计是乱选的」。
     * 现在多选**照旧进 payload**（与单选/判断同等对待），这里只剩"补填"这一个身份。
     *
     * 为什么"补填"这一趟非留不可：整卷的提交前置是**每题都有值**
     * （见 `_areQuizAnswersFilled`），少一道题就永远不提交 —— 那是本仓库最怕的静默卡住，
     * 比这一题猜错贵得多。典型缺口：模型给的多选组合恰好落在"已知错答"里，
     * 被 `_clearKnownWrongFilledQuizAnswers` 抹掉后，这一轮没有别的答案能补上它。
     *
     * 答案来源复用 `_chooseFallbackQuizAnswer`（全仓库唯一的"本地兜底答案"实现）：
     * 它天然**避开已知错答**，所以判错一次下一轮就换一组组合，且不花 token。
     *
     * ⚠️ 兜底纪律：本地**算不出**答案的题（读不到选项字母、或者填不进 DOM）
     * **绝不占用"已处理"名额**，也不给卷子记 `_quizLocalMultiplePapers` ——
     * 它们保持"没答上"，下一轮照旧问模型。
     *
     * @returns {Object} 形如 `{1: true, 3: true}` 的下标表：这些题已由本地补填
     */
    _answerLocalMultiChoiceQuestions: function (questions, preferredDoc) {
      var handled = {};
      if (!questions || !questions.length) return handled;

      var paperKey = this._getQuizWorkKey(preferredDoc || null) || this._quizRunPaperKey || '';
      var self = this;
      var doc = preferredDoc || null;
      var filledCount = 0;
      var deferred = 0;

      questions.forEach(function (question, index) {
        if (!question || !question._element) return;
        if (String(question.type || '') !== 'multiple') return;

        // 本轮已经填好了（模型的答案 / 缓存回填）：直接采信，**不重填** ——
        // 复选是开关，重填等于把刚点上的切掉。
        if (self._wasQuizQuestionAnsweredThisRun(question) && self._isQuizQuestionFilled(doc, question)) {
          handled[index] = true;
          return;
        }

        var qid = self._getQuestionIdFromElement(question._element);
        var guess = self._chooseFallbackQuizAnswer('multiple', question, doc, '', 2);
        if (!guess || !guess.length) {
          deferred++;
          emitRuntimeLog('warn', 'local multiple choice skipped, keep for llm', {
            index: index,
            qid: qid || '',
            hint: '读不到选项字母，本地无法作答 —— 这一题照旧交给模型，不会留空'
          });
          return;
        }

        self._fillMultiChoice(question._element, guess);
        var value = self._getQuizQuestionFilledValue(doc, question);
        if (!value) {
          deferred++;
          emitRuntimeLog('warn', 'local multiple choice fill failed, keep for llm', {
            index: index,
            qid: qid || '',
            answer: guess.join('')
          });
          return;
        }

        self._markQuizQuestionAnsweredThisRun(question, 'local-multiple', value, 'multiple');
        handled[index] = true;
        filledCount++;
      });

      if (filledCount) {
        if (paperKey) {
          if (!this._quizLocalMultiplePapers) this._quizLocalMultiplePapers = {};
          this._quizLocalMultiplePapers[paperKey] = true;
        }
        emitRuntimeLog('warn', 'multiple choice filled locally as refill', {
          count: filledCount,
          deferred: deferred,
          paperKey: paperKey ? 'set' : 'missing',
          hint: '模型那一份没能把这些多选填进页面，本地先补上让卷子交得出去；这份卷子的交卷上限因此收到 2 次，不拿提交次数去赌'
        });
      }
      return handled;
    },

    /**
     * 填空题的占位答案：**每个空格各给一个「1」**，用 `|||` 连起来。
     *
     * 为什么不能整题只给一个「1」：`_fillText` 按 `|||` 把答案分给每一格，
     * 分不到的格子重复**最后一格**，而平台真正提交的隐藏域 `#answer{qid}`
     * 写的是 `values.join('')`。于是两格的题只给一串「1」时，隐藏域里就只有
     * 一个字符 —— 用户看到的正是「填空题空的、后面那格没填」。
     *
     * 格子数按 `_fillText` 同一个选择器数，保证「数的」和「填的」是同一批控件。
     * 一格都数不出来（答题框是富文本编辑器）时返回单个「1」，走 `_fillTextarea` 那条路。
     */
    _blankFillPlaceholder: function (el) {
      var boxes = 0;
      try {
        boxes = Array.from(el.querySelectorAll('input[type="text"], input:not([type])')).length;
      } catch (e) {
        boxes = 0;
      }
      var parts = [];
      for (var i = 0; i < (boxes || 1); i++) parts.push('1');
      return parts.join('|||');
    },


    /**
     * 交卷前最后一道：**任何还空着的题都不许带着空白交出去**。
     *
     * 现场证据（2026-11-11，用户那份 20 题的卷子，单选 5 / 多选 5 / 填空 5 / 判断 5）：
     *   `llm answer count mismatch, batch discarded` 主批 5 次 + 补问批 5 次，
     *   `quiz round skipped: no progress` 13 次 —— 模型其实**答了**（收到的数组里
     *   连着 `["A","D",true,"历史|||人民"]` 这种真实答案），只因为长度对不上被**整批丢掉**，
     *   于是这些题从头到尾没人填 → 表单永远不满 → 整卷既交不出去也不跳过。
     *   用户看到的正是那一句「填空题空的，单选题欠了几个」。
     *
     * 取舍按用户 2026-11-11 的裁定：「填空题我觉得不用动脑子，随便填个 1 也行，
     * 大部分情况下这个错误没人管的」—— 留白是**稳丢的分**，占位是**有可能对**的分，
     * 而卡死连交卷机会都烧掉。所以这里只在"确实空着"时补，且：
     *   - 只补选择/文字题，**不碰多选**（复选重填会把自己切掉，那条路归
     *     `_answerLocalMultiChoiceQuestions` 管，它已经跑过了）；
     *   - 单选/判断的占位**走 `_chooseFallbackQuizAnswer`**，天然避开已知错答，
     *     不是硬写 A；
     *   - 记的 source 是 `blank-fallback` —— 与 `confirmed-cache` / `llm` 分开，
     *     提交审计与"下次别再问模型"那几处判据都不会把它当成正确答案。
     *
     * @returns {Object} 形如 `{2: true, 7: true}` 的下标表：这些题由占位补上
     */
    _fillBlankQuizQuestions: function (questions, preferredDoc) {
      var filled = {};
      if (!questions || !questions.length) return filled;
      var self = this;
      var doc = preferredDoc || null;
      var filledCount = 0;
      var unfillable = [];

      questions.forEach(function (question, index) {
        if (!question || !question._element) return;
        var type = String(question.type || '');
        if (type !== 'single' && type !== 'judge' && type !== 'fill' && type !== 'short') return;
        if (self._isQuizQuestionFilled(doc, question)) return;

        var guess = '';
        if (type === 'fill') guess = self._blankFillPlaceholder(question._element);
        else if (type === 'short') guess = '不会';
        else guess = self._chooseFallbackQuizAnswer(type, question, doc, '', 1);
        if (guess === null || guess === undefined || String(guess).trim() === '') {
          unfillable.push(index);
          return;
        }

        if (type === 'fill') self._fillText(question._element, guess);
        else if (type === 'short') self._fillTextarea(question._element, guess);
        else self._fillChoice(question._element, guess, 'radio');

        var value = self._getQuizQuestionFilledValue(doc, question);
        if (!value) {
          unfillable.push(index);
          return;
        }
        self._markQuizQuestionAnsweredThisRun(question, 'blank-fallback', value, type);
        filled[index] = true;
        filledCount++;
      });

      if (filledCount) {
        emitRuntimeLog('warn', 'blank questions filled with placeholder before submit', {
          count: filledCount,
          unfillable: unfillable.length,
          hint: '这些题模型那一份没能落到页面上（多为整批长度不符被丢弃），先按占位补上让卷子交得出去；' +
            '填空补 1、简答补「不会」、单选与判断在选项里挑一个没被判过错的'
        });
      }
      if (unfillable.length) {
        emitRuntimeLog('warn', 'blank questions could not be filled even with placeholder', {
          indices: unfillable.slice(0, 20),
          hint: '这些题连答题框都找不到（或读不到选项字母）—— 保持未答，下一轮照旧问模型'
        });
      }
      return filled;
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

    /**
     * 视觉预算闸门 —— 这是整个视觉功能里**最重要的安全阀**。
     *
     * 用户能接受「刷不了课」，不能接受「花了钱还是不行」。所以要保证：
     * 无论配置写错、页面版式异常、还是某道题反复触发，都不可能无限发请求。
     *
     * 返回 true = 允许再发一次；false = 预算耗尽，必须停。
     * 耗尽时**必定写一条 warn 日志**，绝不静默 —— 静默烧钱是最糟的失败方式。
     *
     * ⚠️ 批次 36-B：这本账改记 sessionStorage。旧写法记在页面内存里，而刷课链路里
     * 有好几步是**自己刷新自己**（跳章、验证码墙、跨域中间页、任务点 reload），
     * 一刷就归零 —— 于是"每章最多 N 次"实际是"每刷一次再来 N 次"，
     * 安全阀恰好挡不住它最该挡的那种失败：反复失败 → 反复刷新 → 反复发图。
     */
    _takeVisionBudget: function (chapterKey) {
      if (!this.configs.visionEnabled) return false;
      var key = String(chapterKey || 'unknown');
      var used = this._readVisionLedger(key).used;
      var cap = Number(this.configs.visionBudgetPerChapter);
      if (!isFinite(cap) || cap < 0) cap = 0;
      if (used >= cap) {
        // 同一章只提醒一次，否则每道题刷一条，日志会被淹掉
        if (this._visionBudgetWarnedKey !== key) {
          this._visionBudgetWarnedKey = key;
          emitRuntimeLog('warn', 'vision budget exhausted for this chapter, images will be ignored', {
            used: used,
            cap: cap,
            chapter: key
          });
        }
        return false;
      }
      this._writeVisionLedger(key, used + 1);
      return true;
    },


    // 账本里只留**当前这一章**的数：`chapter` 对不上就当没花过 ——
    // 就是旧写法"换章即重置"那一条。不清零的话，一学期下来后面所有章节都用不了视觉。
    _readVisionLedger: function (chapterKey) {
      var key = String(chapterKey || 'unknown');
      var obj = this._readSessionLedger('omitone:vision-budget') || {};
      if (String(obj.chapter || '') !== key) return { chapter: key, used: 0 };
      return { chapter: key, used: Number(obj.used) || 0 };
    },


    _writeVisionLedger: function (chapterKey, used) {
      this._writeSessionLedger('omitone:vision-budget',
        { chapter: String(chapterKey || 'unknown'), used: Number(used) || 0 });
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
        // 批次 36-B：额度从会话账本读（旧的内存字段 `_visionUsedInChapter` 已被它自己的刷新抹掉）。
        var capNow = Number(this.configs.visionBudgetPerChapter);
        if (!isFinite(capNow) || capNow < 0) capNow = 0;
        if (this._readVisionLedger(chapterKey).used >= capNow) {
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
          usedBudget: this._readVisionLedger(chapterKey).used
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
      // ⚠️ 原来这里并着 `_quizDetectorSelector` 一整串通用类名 —— 课件页里挂一个
      //    `.question-content` 就被判成「不是纯文本页」，视觉预算与跳过分支跟着一起失真。
      //    收窄成「真抠得出题」（`_documentHasQuiz`）；答题控件那半保留原样，
      //    因为「页面上有能点的答案框」本身就是「不是纯文本」的充分证据。
      if (this._documentHasQuiz(doc)) return false;
      if (doc.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return false;
      return true;
    },

    _collectQuestionContainers: function (doc) {
      if (!doc || !doc.querySelectorAll) return [];
      var selectors = this._questionSelectors;
      // 学习通改版应急通道：storage config 里的 questionSelectorOverrides 追加在真源
      // **末尾**逐个尝试 —— 内置清单优先命中，改版新类名兜底。只影响抠题收集与诊断，
      // 不影响检测并集（检测还有 URL/任务点佐证那条路）。校验已在 runtime-policy 做过，这里再防一层。
      var overrides = this.configs && this.configs.questionSelectorOverrides;
      if (Array.isArray(overrides) && overrides.length) {
        for (var ov = 0; ov < overrides.length; ov++) {
          if (typeof overrides[ov] === 'string' && overrides[ov]) selectors = selectors.concat([overrides[ov]]);
        }
      }

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
      // 真源 `_questionTitleSelectors`（在 10-config-state.js）：按优先级试，
      // 候选清洗后长度 ≥ 4 才算数 —— 属性选择器大小写敏感的教训记录在真源处
      var titleSelectors = this._questionTitleSelectors;
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
      // 乱码标记：题干或任一选项的 PUA 密文字符占比过高（映射表缺字形时会出现，
      // 解密扫描完成后类名已被摘掉、只能从文本本身判断）。_handleQuiz 据此拦下整卷。
      var garbled = this._quizTextGarbledRatio(title) >= 0.3;
      if (!garbled) {
        for (var g = 0; g < options.length; g++) {
          if (this._quizTextGarbledRatio(options[g]) >= 0.3) { garbled = true; break; }
        }
      }
      return {
        index: index,
        type: this._detectQuestionType(el),
        title: title,
        options: options,
        garbled: garbled,
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
      // 真源 `_optionListSelectors`（在 10-config-state.js）：Zy_/Cy_ 两族 + 兜底，顺序有含义
      var listSelectors = this._optionListSelectors;
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

      // 容器认错时的补偿：只抓到题干那块、选项在兄弟节点里（见 _getOptionsFromAncestor）
      var widened = this._getOptionsFromAncestor(el);
      if (widened.length) return widened;

      return [];
    },


    /**
     * 「题干抠对了、选项却在兄弟节点里」的补偿。
     *
     * 现场（2026-11-10 14:00 日志）：一道单选题反复重问，
     * 每次都是 `single choice matched nothing, fallback picked {"clicked":0}`，
     * 接着 `quiz round skipped: no progress` 把整卷钉死（一题都填不上，永不提交）。
     * 成因是题目容器被认成了**只装题干的那一块**，选项在它的同级 ——
     * 在 `el` 内部当然一个都找不到。
     *
     * 最多向上找**两层**（先 parentElement，不行再它的 parentElement），
     * 且必须同时满足三条，否则宁可返回空：
     *   ① 那一层里只有这一道题 —— 多了就会把别的题的选项捞进来，点错题比不答更糟
     *      （按"不被其它命中节点包含"去重后再数，嵌套命中不算多题）
     *   ② 捞出来 2~8 个 —— 少于 2 不成题；多于 8 基本是把整页都算进来了
     *   ③ 每个候选都有文本、且不再包含更内层的候选项（只取最内层）
     */
    _getOptionsFromAncestor: function (el) {
      var parent = el && el.parentElement;
      if (!parent || !parent.querySelectorAll || !this._questionSelectors) return [];
      // 填空/简答本来就没有选项 —— 向上捞只会捞到页面上的列表，把题干喂脏。
      try {
        if (el.querySelector && el.querySelector('input[type="text"], input:not([type]), textarea')) return [];
      } catch (eIn) { return []; }

      // 先试最近一层，不行再往上一层：题干与选项常被同一层包裹，
      // 单看 parentElement 有时会漏掉整个容器。
      var scopes = [parent, parent.parentElement];
      for (var s = 0; s < scopes.length; s++) {
        var scope = scopes[s];
        if (!scope || !scope.querySelectorAll) continue;

        // 只统计"不被其它命中节点包含"的那些 —— 选择器本身会在一道题内部嵌套命中
        // （.TiMu 里还有 .question-content / div[class*="question"]），
        // 直接 count 会把单题页数成 2+，于是这条补偿在真实页面从来没生效过。
        var raw = [];
        try { raw = Array.from(scope.querySelectorAll(this._questionSelectors.join(','))); } catch (eQ) { continue; }
        var outer = raw.filter(function (node) {
          return !raw.some(function (other) { return other !== node && other.contains && other.contains(node); });
        });
        if (outer.length > 1) continue;

        var out = [];
        try {
          var loose = Array.from(scope.querySelectorAll('li, label, [class*="option"], [class*="choice"]'));
          out = loose.filter(function (node) {
            if (node === el) return false;
            if (el.contains && el.contains(node)) return false;
            if (textOf(node).length === 0) return false;
            return !node.querySelector('li, [class*="option"], [class*="choice"]');
          });
        } catch (eL) { return []; }
        if (out.length < 2 || out.length > 8) continue;
        return out;
      }
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
          // 「这一题模型给的是空答案」必须落进日志。它和「填上了但页面没写上」
          // 在用户眼里是同一个症状（答题框空着、卷子却交上去了），
          // 在日志里却是完全两回事 —— 原先这里静默 return，只能靠猜。
          emitRuntimeLog('warn', 'quiz answer empty, question left blank', {
            index: answerItem.index,
            type: type,
            raw: String(answerItem.answer == null ? '' : answerItem.answer).slice(0, 20)
          });
          self._clearQuizQuestionAnswer(question);
          self._unmarkQuizQuestionAnsweredThisRun(question);
          return;
        }
        // 文字题要知道**到底写进可见答题框了没有**：-1 = 选择题，不归这个计数管
        var visibleWrites = -1;
        if (type === 'single' || type === 'judge') self._fillChoice(question._element, finalAnswer, 'radio');
        else if (type === 'multiple') self._fillMultiChoice(question._element, finalAnswer);
        else if (type === 'fill') visibleWrites = self._fillText(question._element, finalAnswer);
        else if (type === 'short') visibleWrites = self._fillTextarea(question._element, finalAnswer);
        if (visibleWrites === 0) self._logMissingAnswerBox(question._element, type, finalAnswer);
        var questionDoc = question._element && question._element.ownerDocument ? question._element.ownerDocument : null;
        var filledValue = self._getQuizQuestionFilledValue(preferredDoc || questionDoc || null, question);
        if (filledValue) {
          self._markQuizQuestionAnsweredThisRun(question, 'llm', filledValue, type);
        }
        // 选择题那一侧的对称检查：**值写进去了 ≠ 页面上看得出选中**（与上面 `visibleWrites` 同一族）。
        // 现场（2026-11-10）就是这一格漏了 —— 单选一道都看不见选中，交卷前的审计却自证 ok。
        // 只报不改判定：把它升级成"没答上"会让整卷永远交不出去（批次 6 同一取舍）。
        if (filledValue && (type === 'single' || type === 'multiple' || type === 'judge')) {
          if (!self._hasVisibleChoiceSelection(question._element)) {
            self._logMissingChoiceSelection(question._element, filledValue);
          }
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
      } else if (inputType === 'radio') {
        // 「文本与控件分离」的作业/考试页（选项文本一列、radio 另一列）：
        // 上面只点了配到的那个 radio，**站点挂在自己 <a>/li 上的选中态样式没被触发** ——
        // 于是 input.checked 是 true、`#answer{qid}` 也写了值，可页面上那道单选
        // **看起来完全没答**。用户 2026-11-10 的原话：「单选题一题也是空着的」，
        // 而同一条卷子的审计写着 `checkedInDom:5 / choice:5`（自证 ok，见 `_auditQuizFillBeforeSubmit`）。
        // 复选**不能**走这一支：复选点第二次就是取消（那正是"多选随机少选一项"的老 bug）。
        // 单选点两次仍是选中（radio 只认"选中"这一态），所以补点文本项是安全的。
        try { item.click(); } catch (eSep) {}
        var sepTarget = null;
        try {
          // 站点把选中态挂在哪一层不固定：`<a>`（作业页常态）、`.fl`、`label`。
          // ⚠️ 带真 href 的链接**绝不点** —— 这段是在整页扫选项里跑的，点错一下就是导航。
          var cands = item.querySelectorAll('a, .fl, .fl.after, label, span');
          for (var c = 0; c < cands.length; c++) {
            var href = String(cands[c].getAttribute && cands[c].getAttribute('href') || '').trim();
            if (href && !/^javascript:/i.test(href)) continue;
            sepTarget = cands[c];
            break;
          }
        } catch (eSep2) {}
        if (sepTarget && sepTarget !== item) {
          try { sepTarget.click(); } catch (eSep3) {}
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
      // ⚠️ 选中态**不能**跟 qid 绑在一起。原来写的是 `if (qid && badge)`：
      // qid 抓不到时连 `.check_answer` 都不加 —— 页面看起来完全没选中，
      // 可 input.checked 已经是 true，_getQuizQuestionFilledValue 又说"填了"，
      // 于是提交照常放行。用户看到的就是「单选题不答」。
      // 现在：只要有徽标就写选中态；跨组清理有 qid 用 qid，没有就清同组兄弟。
      if (badge) {
        if (inputType === 'radio') {
          if (qid) {
            Array.from(doc.querySelectorAll('.choice' + qid)).forEach(function (node) {
              node.classList.remove('check_answer');
            });
          } else if (item.parentElement) {
            Array.from(item.parentElement.children).forEach(function (sib) {
              var sibBadge = sib.querySelector && sib.querySelector('.num_option, .num_option_dx');
              if (sibBadge && sibBadge !== badge) sibBadge.classList.remove('check_answer');
            });
          }
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

      // qid 抓不到时留一条 warn：平台读的是 #answer{qid}，没有 qid 就等于
      // 「点了、也选中了，但提交上去的是空」——这是最难从截图看出来的失败。
      if (!qid) {
        emitRuntimeLog('warn', 'option clicked without qid', {
          text: textOf(item).slice(0, 30),
          letter: String(letter || '').slice(0, 4)
        });
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
      if (clicked) return;

      // ⚠️ 匹配不上就空着 = 整卷永远交不出去。实测（2026-11-10）：
      // 题干/选项还在 font-cxsecret 密文态时，模型给的字母对不上任何选项，
      // 单选就静默留空；用户看到的是「单选题不答，多选乱选反而没问题」。
      // 单选/判断这里补一次兜底：按候选顺序选一个（避开已判错的），
      // 宁可填一个可能错的，也不要交白卷 —— 与多选本地作答同一策略。
      var type = this._detectQuestionType(el);
      if (type !== 'single' && type !== 'judge') {
        console.warn('[Omitone] no matching option for answer', answer, textOf(el).slice(0, 120));
        return;
      }
      var fallback = this._chooseFallbackQuizAnswer(type, { _element: el }, null, '', 1);
      if (!fallback) {
        console.warn('[Omitone] no matching option and no fallback', answer, textOf(el).slice(0, 120));
        return;
      }
      var retried = this._applyChoiceAnswer(el, fallback, type, inputType);
      emitRuntimeLog('warn', 'single choice matched nothing, fallback picked', {
        answer: String(answer == null ? '' : answer).slice(0, 20),
        fallback: String(fallback).slice(0, 4),
        clicked: retried,
        type: type
      });

      // 连兜底都一个点不上 —— 这一题的结构我们没认出来。把它的形状抄一份进日志
      // （每题只记一次），下一次就能直接照着改，不用再靠猜。
      if (!retried && !el._omFillDiagAt) {
        el._omFillDiagAt = Date.now();
        var countIn = function (sel) {
          try { return el.querySelectorAll(sel).length; } catch (e) { return -1; }
        };
        emitRuntimeLog('warn', 'quiz fill: no clickable option in question', {
          title: textOf(el).replace(/\s+/g, ' ').slice(0, 30),
          tag: String(el.tagName || '').toLowerCase(),
          cls: String(el.className || '').slice(0, 60),
          qid: this._getQuestionIdFromElement(el) || '',
          li: countIn('li'),
          label: countIn('label'),
          radio: countIn('input[type="radio"]'),
          checkbox: countIn('input[type="checkbox"]'),
          optionCls: countIn('[class*="option"]'),
          choiceCls: countIn('[class*="choice"]'),
          html: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220)
        });
      }
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


    /**
     * 填空题：把答案按 `|||` 分段写进题目容器里的**每一个文本框**，并同步隐藏答案域。
     *
     * 返回真正写到的可见答题控件数（0 = 这道题在我们眼里一个答题框都没有）。
     * 这个返回值是给 `_fillAnswers` 的：只写进隐藏域、可见框却空着，
     * 就是用户报的「长题不答、卷子照交」—— 光看审计里的 withValue 是看不出来的。
     */
    _fillText: function (el, answer) {
      var value = this._normalizeAnswerValue(answer);
      var inputs = Array.from(el.querySelectorAll('input[type="text"], input:not([type])'));
      if (!inputs.length) {
        // ⚠️ 有的「填空题」答题框**根本不是 input，而是一个富文本编辑器**（UEditor 的 iframe）。
        // 现场实测（诊断日志，2026-10-10）：25 题里恰好有 2 道填空题是
        // `textInputs: 0, richEditors: 1` —— 于是这里 `return` 掉、**那两题永远填不上**，
        // 表单永远不满 → 永不提交 → 整卷每 30 秒重来一轮（用户看到的"一直卡住"）。
        // 题型判定按 `typename`（"填空题"）给了 'fill'，可填答路径却只认 input，
        // 两边对"填空题"的理解不一致 —— 这是这条 bug 的根。
        // 交给简答那条路：它会写 textarea / iframe 正文，**并且同步隐藏答案域**。
        //
        // ⚠️ 顺手留一条日志：这条兜底**跑没跑**、以及**上游给的答案是不是空的**，
        // 必须能从日志分辨 —— 上一版兜底是静默的，结果"修复到底装上了没有"
        // 只能靠猜（现场日志里那两题一模一样地未填，分不清是"没跑到"还是"答案是空的"）。
        try {
          // ⚠️ page.js 跑在**页面上下文**，这里只有 `emitRuntimeLog`；
          //    `appendRuntimeLog` 是 content.js 的，写了就是 ReferenceError
          //    （被下面的 catch 吞掉 = 这条日志等于没打）。上一版就栽在这。
          emitRuntimeLog('warn', 'fill fallback: rich editor', {
            qid: String(this._getQuestionIdFromElement(el) || '').slice(0, 24),
            emptyAnswer: !String(value == null ? '' : value).trim()
          });
        } catch (eLog) {}
        return this._fillTextarea(el, answer);
      }

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
      return inputs.length;
    },


    /**
     * 文字题（简答，以及答题框不是 input 的填空）的填答。
     *
     * 返回**真正写到的可见答题控件数**（富文本 iframe 正文也算）。这条计数是为
     * 「长题不答」准备的：原先下面三档都找不到时，只有末尾那个隐藏域会写上值，
     * 于是页面上答题框完全空着、判定却读得到值、审计报 withValue=total、卷子直接交出去。
     */
    _fillTextarea: function (el, answer) {
      var value = String(this._normalizeAnswerValue(answer) || '');
      var targets = this._collectAnswerEditableNodes(el);
      var written = 0;
      for (var t = 0; t < targets.length; t++) {
        if (this._writeAnswerText(targets[t], value)) written++;
      }

      var iframes = Array.from(el.querySelectorAll('iframe'));
      for (var i = 0; i < iframes.length; i++) {
        try {
          var body = iframes[i].contentDocument && iframes[i].contentDocument.body;
          if (body) {
            body.innerHTML = this._answerToHtml(value);
            written++;
          }
        } catch (e) {}
      }

      // 简答题同样要同步隐藏答案域：平台提交时读的是 #answer{qid}，
      // 只写 textarea/富文本编辑器的话，页面自身 JS 不一定会把内容回填进去。
      // ⚠️ 这一档**不算进 written** —— 它就是「只有隐藏域有值、答题框却空着」的来源。
      try {
        var doc = el.ownerDocument || document;
        var qid = this._getQuestionIdFromElement(el);
        var hidden = (qid && doc.getElementById) ? doc.getElementById('answer' + qid) : this._findQuizAnswerInput(el, qid);
        if (hidden && value) {
          // 可见控件可能就是这一个 `#answer{qid}`（简答的常见形状）—— 上面已经用
          // 原型 setter 写过同一串文本，这里再直接赋值一次是幂等的，
          // 但**不能省**：万一 `_writeAnswerText` 那一路抛错了，隐藏域就是唯一的兜底。
          hidden.value = value;
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
      return written;
    },


    /**
     * 「这份文档本身像不像一张卷子」的最便宜探针：一个并集选择器，不做容器去重。
     *
     * 只用来决定「要不要继续往下找文档」，所以必须便宜 —— `_collectQuestionContainers`
     * 要把整串选择器逐个试到底并去重，放在帧循环里会拖慢每一次 tick。
     */
    _docHasQuizPaperShape: function (doc) {
      if (!doc || !doc.querySelector) return false;
      try {
        return !!doc.querySelector(this._quizContainerSelector + ', input[id^="answertype"]');
      } catch (e) {
        return false;
      }
    },


    /**
     * 往下找「真正装着题目那份文档」：广度优先、深度有界（≤3 层帧、每层最多 12 帧）。
     *
     * 只在外层文档一道题都收不着时才被调用，所以它改的是「文档挑错了」这一类，
     * 本来就传对文档的十几条读路径一步都不走这条路。
     * 跨域帧一律走 `_safeDocOf` —— 裸读 `.document` 抛的 SecurityError
     * 会静默打断整轮 tick（AGENTS §2 #1）。
     */
    _findQuizPaperDocumentBelow: function (rootDoc, depth) {
      if (!rootDoc || (depth || 0) >= 3) return null;
      var frames = [];
      try { frames = Array.prototype.slice.call(rootDoc.querySelectorAll('iframe'), 0, 12); } catch (e) { return null; }
      // 学习通把卷子放在 `#frame_content` 里，DOM 顺序却常排在其它任务点帧之后 —— 先看它
      frames.sort(function (a, b) { return (b.id === 'frame_content' ? 1 : 0) - (a.id === 'frame_content' ? 1 : 0); });
      var subDocs = [];
      for (var i = 0; i < frames.length; i++) {
        var direct = this._safeDocOf(frames[i]);
        if (!direct) continue;
        if (this._docHasQuizPaperShape(direct)) return direct;
        subDocs.push(direct);
      }
      for (var s = 0; s < subDocs.length; s++) {
        var deeper = this._findQuizPaperDocumentBelow(subDocs[s], (depth || 0) + 1);
        if (deeper) return deeper;
      }
      return null;
    },


    _resolveQuizAnswerDocument: function (preferredDoc) {
      // 最后一个兜底 `|| document` 不能省：题目可能就在顶层文档里（页面没有 #iframe，
      // 或者题目被 _walkDocuments 在更深的 iframe 中找到）。
      // 旧实现此时返回 null，_getQuizQuestionFilledValue 随即返回空串，
      // 于是"答案明明已经填进 DOM 却判定未填写"，_areQuizAnswersFilled 永远 false，
      // 提交被永久阻塞 —— 表现为答题跑完但从不交卷。
      var doc = preferredDoc || this._getMainDocument() || document;
      if (!doc) return null;
      // ⚠️ 一层 `#frame_content` 跳转改成了有界深走。真实拓扑比想象深（2026-11-11 实测）：
      //   top(/mycourse/studentstudy) → #iframe(/knowledge/cards)
      //     → iframe.ans-attach-(work 模块) → #frame_content(/work/doHomeWorkNew)  ← 卷子在这里
      // 旧实现只在卡片文档里找一个 id=`frame_content` 的节点，卡片文档没有这个 id，
      // 于是原样返回卡片文档：这份文档上抠题抠出 0 道，而 `_isDocumentFrameFinished`
      // 却当场为真（每张任务点后面都写着「已完成」）——「题还没做」被读成
      // 「这一节已完成」，直接翻下一节（用户：「怎么说已完成了？」）。
      if (this._docHasQuizPaperShape(doc)) return doc;
      return this._findQuizPaperDocumentBelow(doc, 0) || doc;
    },


    /**
     * 富文本答题框（UEditor 的 iframe）里的答案文本。
     *
     * ⚠️ 判定必须与填答**对称**：`_fillTextarea` 会写 textarea / iframe 正文 + 隐藏域，
     * 而这里如果不读 iframe 正文，就会出现"**填了却判成未填**"——
     * 现场实测（2026-10-10）：两道填空题的答题框就是一个 iframe，
     * 日志里 `fill fallback: rich editor {"emptyAnswer":false}` 说明填答已跑到、答案非空，
     * 可 `unfilledCount` 仍是 2 → 表单永远不满 → 永不提交（用户看到的"东西全做完了就是不交"）。
     */
    _readRichEditorValue: function (el) {
      if (!el || !el.querySelectorAll) return '';
      var frames = [];
      try { frames = Array.from(el.querySelectorAll('iframe')); } catch (e) { return ''; }
      for (var i = 0; i < frames.length; i++) {
        try {
          var body = frames[i].contentDocument && frames[i].contentDocument.body;
          if (!body) continue;
          var text = textOf(body);
          if (text) return text;
        } catch (e2) {}
      }
      return '';
    },

    /**
     * 「文字答题控件」= 用户能打字的那种框：textarea、非隐藏的 input、contenteditable 区块。
     *
     * 刻意**不包含** `input[type="hidden"]` —— 那是平台的提交字段，不是答题框。
     * 把隐藏域当「已填写」，正是「答题框完全空着、审计却报有值、卷子直接交出去」的根。
     */
    _isAnswerTextControl: function (node) {
      if (!node || !node.tagName) return false;
      var tag = String(node.tagName).toLowerCase();
      if (tag === 'textarea') return true;
      if (tag === 'input') {
        var type = '';
        try { type = String(node.getAttribute('type') || node.type || 'text').toLowerCase(); } catch (e) { return false; }
        return type === '' || type === 'text' || type === 'search' || type === 'number' || type === 'email' || type === 'tel';
      }
      if (tag === 'iframe' || tag === 'body' || tag === 'html') return false;
      var ce = '';
      try { ce = String(node.getAttribute && node.getAttribute('contenteditable') || '').toLowerCase(); } catch (e2) { return false; }
      return ce === 'true' || ce === '';
    },

    /** 答案文本 → 富文本里的 HTML。转义是必需的：答案里的 `<` 不许被当成标签注进页面。 */
    _answerToHtml: function (value) {
      return '<p>' + String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>') + '</p>';
    },

    /**
     * 往一个文字答题控件里写文本。走原型 setter —— React/Vue 受控组件不认裸赋值，
     * 只写 `.value` 时框里看着有字、组件状态里却是空的。
     */
    _writeAnswerText: function (node, value) {
      try {
        var tag = String(node.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
          var proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(node, value);
          else node.value = value;
        } else {
          node.innerHTML = this._answerToHtml(value);
        }
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * 这道题**看得见**的文字答题控件，按可靠度依次找：
     *   ① 题目容器内；
     *   ② 容器里一个都没有 → 按平台约定取 `#answer{qid}`（前提是它是能打字的框，不是隐藏域）；
     *   ③ 还没有 → 向上最多 3 层再找，**只在那一层恰好只有一个候选时**才认。
     *
     * ③ 还没有 → 向上最多 3 层再找，**只在那一层恰好只有一个候选时**才认。
     *
     * ③ 的存在是因为抠题容器有时只圈到题干、答题框渲染在它外面 ——
     * 那种形状下旧实现一个控件都找不到，于是只写进隐藏域。
     * ③ 的两条限制都不能省：向上找到的框可能是**别的一道题**的，
     * 写错框比不写更糟（会把隔壁题的答案覆盖掉）。所以
     *   · 某一层里能数出 ≥2 个题目容器 → 这一层已经在装"隔壁题"，立刻停；
     *   · 只在那一层恰好只有一个候选时才收，且候选的 qid 必须对得上（它自己没有 qid 才算中性）。
     */
    _collectAnswerEditableNodes: function (el) {
      var found = [];
      if (!el || !el.querySelectorAll) return found;
      var self = this;
      var collect = function (scope) {
        var out = [];
        var nodes;
        try { nodes = Array.prototype.slice.call(scope.querySelectorAll('input, textarea, [contenteditable]')); } catch (e) { return out; }
        for (var i = 0; i < nodes.length; i++) {
          if (self._isAnswerTextControl(nodes[i])) out.push(nodes[i]);
        }
        return out;
      };

      found = collect(el);
      if (found.length) return found;

      var qid = '';
      try { qid = String(this._getQuestionIdFromElement(el) || ''); } catch (eQ) {}
      var doc = el.ownerDocument || document;
      try {
        var byId = qid && doc && doc.getElementById ? doc.getElementById('answer' + qid) : null;
        if (this._isAnswerTextControl(byId)) return [byId];
      } catch (eId) {}

      var depth = 0;
      var parent = el.parentElement;
      while (parent && depth++ < 3) {
        try {
          // 这一层已经装着好几道题 → 再往上的框归属说不清，停
          if (parent.querySelectorAll(this._quizDetectorSelector).length > 1) break;
        } catch (eScope) { break; }
        var candidates = collect(parent);
        if (qid) {
          candidates = candidates.filter(function (node) {
            var nodeQid = '';
            try { nodeQid = String(self._getQuestionIdFromElement(node) || ''); } catch (eN) {}
            return !nodeQid || nodeQid === qid;
          });
        }
        if (candidates.length === 1) return candidates;
        parent = parent.parentElement;
      }
      return found;
    },

    /**
     * 只读**文字答题控件**里的内容（多空用 `|||` 连，与填答侧的约定一致），
     * 外加富文本 iframe 正文。
     *
     * 与 `_getQuizQuestionFilledValue` 的分工：那边**隐藏域优先**（平台提交读的是它），
     * 这里刻意不看隐藏域 —— 「只有隐藏域有值」正是用户看到「答题框空着」的那种形状，
     * 提交前的审计拿它和 withValue 对比就能把这一条钉死在日志里。
     */
    _readVisibleAnswerText: function (el) {
      if (!el) return '';
      var parts = [];
      var nodes = this._collectAnswerEditableNodes(el);
      for (var i = 0; i < nodes.length; i++) {
        var tag = String(nodes[i].tagName || '').toLowerCase();
        var one = '';
        try {
          one = (tag === 'input' || tag === 'textarea') ? String(nodes[i].value || '') : textOf(nodes[i]);
        } catch (e) { one = ''; }
        one = String(one || '').trim();
        if (one) parts.push(one);
      }
      if (!parts.length) {
        var rich = this._readRichEditorValue(el);
        if (rich) parts.push(String(rich).trim());
      }
      return parts.join('|||');
    },

    /**
     * 文字题一个可见答题框都没写到的现场快照（同一个元素只记一次）。
     *
     * 形状抄 `_applyChoiceAnswer` 里那条同族日志：有了 tag/cls/各类控件的计数，
     * 下一次直接照着补选择器，不用再靠猜。`answerLen` 用来区分
     * 「模型给的答案是空的」和「答案非空但我们找不到框」。
     */
    _logMissingAnswerBox: function (el, type, answer) {
      if (!el || el._omNoBoxDiagAt) return;
      try {
        el._omNoBoxDiagAt = Date.now();
        var countIn = function (sel) {
          try { return el.querySelectorAll(sel).length; } catch (e) { return -1; }
        };
        var qid = '';
        try { qid = String(this._getQuestionIdFromElement(el) || ''); } catch (eQ) {}
        var doc = el.ownerDocument || document;
        emitRuntimeLog('warn', 'quiz fill: no visible answer box in question', {
          type: type,
          qid: qid,
          title: textOf(el).replace(/\s+/g, ' ').slice(0, 30),
          tag: String(el.tagName || '').toLowerCase(),
          cls: String(el.className || '').slice(0, 60),
          textarea: countIn('textarea'),
          textInput: countIn('input[type="text"], input:not([type])'),
          editable: countIn('[contenteditable]'),
          iframe: countIn('iframe'),
          answerFieldIsVisibleBox: this._isAnswerTextControl(qid && doc && doc.getElementById ? doc.getElementById('answer' + qid) : null),
          answerLen: String(answer == null ? '' : answer).length,
          html: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220)
        });
      } catch (e) {}
    },


    /**
     * 这道选择题**在页面上看得出选中吗** —— 用户眼睛能看到的证据才算。
     *
     * 存在的理由（2026-11-10 真实日志）：一份卷子审计写着
     * `quiz fill audit ok {"checkedInDom":5,"choice":5,"missing":[]}`，
     * 可用户看到的是**单选题一题也是空着的**。审计与用户看到的是两件事：
     * 旧审计写的是 `querySelector('input:checked, .cur, .selected, …')` ——
     * `input:checked` 命中一个 `display:none` 的原生控件、`.cur` 命中页面自己的
     * 当前章节高亮，都算"选中"。把"看不见"当"已答"，就会拿着白卷交卷。
     *
     * 三档证据，任一命中且**那个元素真的可见**才算数：
     *   ① 我们或站点打的选中 class（`check_answer` / `check_answer_dx` —— 站点的 CSS 真的会画出来）
     *   ② 勾选中的原生控件本身是可见的（`display:none` 的原生 radio 不算）
     *   ③ 站点自己的选中类（`.cur` / `.selected` / `.active`）
     *
     * ⚠️ **`aria-checked` 故意不算证据**。它是我们自己在 `_clickOptionItem` 里
     * 只要有 qid 就给文本项加上的（`item.setAttribute('aria-checked','true')`），
     * 页面没有任何 CSS 因为它而变样。拿它当"看得见"就是**自己给自己开的证明**：
     * 现场那道「隐藏域有值、input 已勾上、屏幕上什么都没有」的单选会被判成已答
     * —— 正是这个函数要抓出来的东西。
     *
     * ⚠️ 返回 false **不会**拦住交卷 —— 与批次 6 那条"只提醒不拦"的取舍一致：
     * 拦住就会回到「整卷永远不交」那个老 bug。它只负责让日志不再自证清白。
     */
    _hasVisibleChoiceSelection: function (el) {
      if (!el || !el.querySelectorAll) return false;
      var nodes = [];
      try {
        nodes = Array.from(el.querySelectorAll('[class*="check_answer"], .cur, .selected, .active'));
      } catch (e) { return false; }
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i] === el) continue;
        if (visible(nodes[i])) return true;
      }
      try {
        var inputs = Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        for (var k = 0; k < inputs.length; k++) {
          if (inputs[k].checked && visible(inputs[k])) return true;
        }
      } catch (e2) {}
      return false;
    },


    /**
     * 选择题「有值却看不见选中」的现场快照（同一个元素只记一次）。
     *
     * 与 `_logMissingAnswerBox` 同族，只是这次要抓的是**选项那一侧**的形状：
     * 徽标有没有、radio 藏在哪一列、文本与控件是不是分家 —— 有了这些计数
     * 和一小段 HTML，下一次直接照着补选择器，不用再靠猜。
     */
    _logMissingChoiceSelection: function (el, value) {
      if (!el || el._omNoCheckDiagAt) return;
      try {
        el._omNoCheckDiagAt = Date.now();
        var countIn = function (sel) {
          try { return el.querySelectorAll(sel).length; } catch (e) { return -1; }
        };
        var qid = '';
        try { qid = String(this._getQuestionIdFromElement(el) || ''); } catch (eQ) {}
        emitRuntimeLog('warn', 'quiz fill: no visible selection in question', {
          qid: qid,
          value: String(value == null ? '' : value).slice(0, 8),
          title: textOf(el).replace(/\s+/g, ' ').slice(0, 30),
          tag: String(el.tagName || '').toLowerCase(),
          cls: String(el.className || '').slice(0, 60),
          li: countIn('li'),
          label: countIn('label'),
          radio: countIn('input[type="radio"]'),
          checkbox: countIn('input[type="checkbox"]'),
          visibleRadio: countIn('input[type="radio"]:not([style*="none"])'),
          badge: countIn('.num_option, .num_option_dx'),
          markCls: countIn('[class*="check_answer"]'),
          html: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220)
        });
      } catch (e) {}
    },


    _getQuizQuestionFilledValue: function (preferredDoc, question) {
      var doc = this._resolveQuizAnswerDocument(preferredDoc);
      if (!question || !question._element) return '';
      var qid = this._getQuestionIdFromElement(question._element);
      // qid 缺失不能直接判"没填"：新版结构卷子根本不带 #answer{qid}，
      // 平台读的就是可见控件本身。原来这里一 return '' 就整卷永远不提交。
      // 隐藏域优先（平台提交时读的就是它）。**两个文档都查一遍**：
      // 填答（`_fillTextarea` / `_fillText`）写的是 `el.ownerDocument`，
      // 而这里过去只用调用方给的 doc —— 题目与 preferredDoc 不同文档时
      // 就会"写进去、读不到"，判定与填答不对称。
      var hidden = null;
      var ownerDoc = question._element.ownerDocument || null;
      if (qid) {
        try { if (ownerDoc && ownerDoc.getElementById) hidden = ownerDoc.getElementById('answer' + qid); } catch (e0) {}
        try { if (!hidden && doc && doc.getElementById) hidden = doc.getElementById('answer' + qid); } catch (e1) {}
      }
      var hiddenValue = hidden ? String(hidden.value || '').trim() : '';
      // 隐藏域优先，但它为空时必须回退到可见控件：
      // 简答题走的是富文本编辑器，页面自身的 JS 未必把内容同步进隐藏域；
      // 只认隐藏域会导致"明明填了却判定未填写"，从而永远卡住不提交。
      if (hiddenValue) return hiddenValue;
      var visible = this._getQuizAnswerValue(question._element, qid);
      if (visible) return visible;
      // 最后是富文本正文：判定必须覆盖"填答能写到的每一处"。
      var richValue = this._readRichEditorValue(question._element);
      if (richValue) return richValue;
      // 再补一档「文字答题控件」：答题框渲染在题目容器之外、或是 contenteditable 编辑器时，
      // 上面几档全都读不到 —— 于是填了却判成未填，整卷永远不提交。
      // ⚠️ 只给文字题用：这一档比 `_getQuizAnswerValue` 松（按形状找框，不按 answer\d+ 的
      //    id 找），让选择题走它会把"容器里恰好有个带字的框"误判成已答、直接交白卷。
      var textishType = String(question.type || '');
      if (textishType === 'fill' || textishType === 'short') {
        var editText = this._readVisibleAnswerText(question._element);
        if (editText) return editText;
      }
      // 最后一档：可见控件自己的勾选态。**三条同时成立才算已填**，否则宁可判未填：
      //   ① 本题作用域内有 name/id 形如 answer\d+ 的控件 —— 说明平台按表单字段收答案；
      //   ② 勾选数符合题型：single/judge 恰好 1，multiple ≥1（单选出现两个勾选必须判未填）；
      //   ③ 取控件 value；空则按它在同组里的位置推字母 A/B/C…，绝不返回占位串。
      try {
        var boxes = Array.from(question._element.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        var identified = boxes.filter(function (box) {
          var key = String(box.getAttribute('name') || box.id || '');
          return /^answer\d+/i.test(key);
        });
        if (identified.length) {
          var pickedBoxes = identified.filter(function (box) { return !!box.checked; });
          var boxType = this._detectQuestionType(question._element);
          var expectOne = (boxType === 'single' || boxType === 'judge');
          if (pickedBoxes.length && (!expectOne || pickedBoxes.length === 1)) {
            var pickedBox = pickedBoxes[0];
            var pickedValue = String(pickedBox.value || pickedBox.getAttribute('value') || '').trim();
            if (!pickedValue) {
              var boxOrder = identified.indexOf(pickedBox);
              pickedValue = boxOrder >= 0 ? String.fromCharCode(65 + boxOrder) : '';
            }
            if (pickedValue) return pickedValue;
          }
        }
      } catch (ePick) {}
      return '';
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
        // qid 只用于日志：新版结构卷子没有 #answer{qid}，不能拿它当"没填"的判据。
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


    /**
     * 提交前审计：**「读得到值」不等于「页面上真的答了」**。
     *
     * 实测（2026-11-10）两类，各自的数不一样：
     *   · 单选题：隐藏域/控件值写进去了，自定义控件的选中态没生效
     *     → 看 checkedInDom 与 choice 的差（选中态的判据是 `_hasVisibleChoiceSelection`，
     *       **不可见的** `input:checked` 与页面自带的 `.cur` 高亮都不算，批次 7 换的）；
     *   · 填空/简答（长题）：**只有隐藏域有值，答题框完全空着** ——
     *     旧审计对文字题直接 continue，于是日志写着 ok、卷子却交了白框
     *     → 看 textVisible 与 text 的差（textHidden 里是题号）。
     *
     * ⚠️ 这两条各自都有一段"现场快照"日志配套：`quiz fill: no visible selection in question`
     * 与 `quiz fill: no visible answer box in question` —— 光知道"5 题里 3 题没看得见"
     * 定位不了形状，得把那一题的 DOM 计数与一小段 HTML 抄出来才能接着修。
     *
     * 单独成一个方法（而不是inline在 `_maybeSubmitQuiz` 里）是为了能被 e2e 直接驱动：
     * 那一串闸（自动提交开关、提交次数上限、ready 状态）任一不过就轮不到审计，
     * 而这两个数会不会分开，恰恰是只能在闸里看到的。
     *
     * ⚠️ 它**只报不拦**：把"框里没字"升级成拦住提交，就会回到「整卷永远不交」那个老 bug。
     */
    _auditQuizFillBeforeSubmit: function (submitQuestions, preferredDoc) {
      if (!submitQuestions || !submitQuestions.length) return null;
      var auditValue = 0;
      var auditChoice = 0;
      var auditChecked = 0;
      var auditText = 0;
      var auditTextVisible = 0;
      var auditMissing = [];
      var auditTextHidden = [];
      for (var ai = 0; ai < submitQuestions.length; ai++) {
        var aq = submitQuestions[ai];
        var aEl = aq && aq._element;
        if (!aEl) continue;
        var aHasValue = false;
        try { aHasValue = !!this._getQuizQuestionFilledValue(preferredDoc, aq); } catch (eV) {}
        if (!aHasValue) continue;
        auditValue++;
        var aType = String((aq && aq.type) || '');
        if (!aType) {
          // 题号没带 type 时按 DOM 再判一次 —— 判不准就宁可当文字题，
          // 那样只会多问一句「框里真有字吗」，不会漏报。
          try { aType = String(this._detectQuestionType(aEl) || ''); } catch (eD) {}
        }
        if (aType !== 'single' && aType !== 'multiple' && aType !== 'judge') {
          // 文字题不看选中态，看的是**答题框里到底有没有字**（隐藏域不算）。
          // ⚠️ 只有这一条能抓住「长题不答却交了」—— withValue 对它是恒真的。
          auditText++;
          var aTextVisible = false;
          try { aTextVisible = !!String(this._readVisibleAnswerText(aEl) || '').trim(); } catch (eT) {}
          if (aTextVisible) auditTextVisible++;
          else auditTextHidden.push(aq.index != null ? aq.index : ai);
          continue;
        }
        auditChoice++;
        // ⚠️ 这里**不能**再用一个宽松选择器自证清白（批次 6 那一轮的教训在选择题侧重演）：
        // 旧写法在整个文档里找 `input:checked, .cur, .selected` —— 前者能命中一个
        // `display:none` 的原生控件，后三者能命中页面自己的当前章节高亮，
        // 都不等于"用户看得见这道题答了"。判据换成 `_hasVisibleChoiceSelection`：
        // **只在这道题的容器里**找，且三档证据都要那个元素**真的可见**才算
        // （`aria-checked` 是我们自己写上去的，页面不会因此画出任何东西，故不算）。
        var aChecked = false;
        try { aChecked = this._hasVisibleChoiceSelection(aEl); } catch (eC) {}
        if (aChecked) auditChecked++;
        else {
          auditMissing.push(aq.index != null ? aq.index : ai);
          // 光报"5 题里 3 题看不见选中"没法定位形状 —— 把这一题的选项结构抄一份进日志
          this._logMissingChoiceSelection(aEl, aHasValue);
        }
      }
      var auditBad = auditChecked < auditChoice || auditTextVisible < auditText;
      var auditLabel = auditTextVisible < auditText
        ? 'quiz fill audit: text answer not in a visible box'
        : (auditChecked < auditChoice ? 'quiz fill audit: value without visible selection' : 'quiz fill audit ok');
      var meta = {
        total: submitQuestions.length,
        withValue: auditValue,
        choice: auditChoice,
        checkedInDom: auditChecked,
        text: auditText,
        textVisible: auditTextVisible,
        // 只报"4/5"没法定位是哪一题，下一次照样要人肉数 —— 把题号带上
        missing: auditMissing.slice(0, 8),
        textHidden: auditTextHidden.slice(0, 8)
      };
      emitRuntimeLog(auditBad ? 'warn' : 'info', auditLabel, meta);
      return { label: auditLabel, level: auditBad ? 'warn' : 'info', meta: meta };
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

      this._auditQuizFillBeforeSubmit(submitQuestions, effectiveDoc || submitDoc);

      if (!this._quizReadyToSubmit || (this._quizReadyWorkKey && this._quizReadyWorkKey !== currentKey)) {
        emitRuntimeLog('warn', 'block quiz submit without ready state', { key: currentKey });
        this._quizAnswered = false;
        return false;
      }
      // ===== 乱选交卷前的「可设置检查窗口」（2026-11-12，用户直接提出）=====
      //
      // 原话：「关于乱答最好留一个可设置的窗口，别直接默认『不会』然后就提交还不能修改啊，
      // 这太诡异了」。乱选的答案是**猜的**，而交卷不可逆 —— 填完立刻交，
      // 用户看到的第一个事实永远是「想改也改不了了」。所以这里按配置停一下手：
      //   · `randomAnswerReviewSec > 0`：arm 一个窗口，窗口内每次被调到都只等不点，
      //     到点那一次才真的交（这期间 `_quizAnswered` 已经是 true，
      //     `_handleQuiz` 开头会直接 return，不会把用户刚改的答案又随机冲掉）；
      //   · `randomAnswerReviewSec === 0`：完全不自动交卷，停在「等你检查后自己交」，
      //     每 10 秒一条日志说清怎么恢复（静默按住用户的卷子是本仓库最不能接受的一类）。
      // ⚠️ 窗口必须记住「是为哪一份卷子 arm 的」：这里被 OCS 循环**每秒**调到，
      //   没有卷子键就会每一秒重数一遍，窗口永远走不完（同族坑见 `_quizGarbledRoundAt`）。
      //   `_quizReviewUntil === 0` 是「这份卷子正停在等用户」的记号 ——
      //   所以用户把设置从 0 调回大于 0 时，这里会**重新 arm**，不会一升设置就立刻交卷。
      // ⚠️ 两种状态**各按卷子键只打一条日志**：这条每秒被调到，只按时间节流仍会把日志刷满，
      //   而完全静默又让人不知道插件在等什么。
      if (this._isRandomAnswerMode()) {
        var reviewSec = Number(this.configs && this.configs.randomAnswerReviewSec);
        if (!isFinite(reviewSec)) reviewSec = 30;
        var reviewKey = String(this._getQuizWorkKey(effectiveDoc || submitDoc) || '');
        var reviewNow = Date.now();
        if (reviewSec <= 0) {
          if (this._quizReviewPaperKey !== reviewKey || this._quizReviewUntil !== 0) {
            this._quizReviewPaperKey = reviewKey;
            this._quizReviewUntil = 0;
            emitRuntimeLog('info', 'quiz held for manual review', {
              key: reviewKey.slice(0, 60),
              hint: '乱选已把整卷填满，按设置停在「不自动交卷」：检查完自己点提交即可；' +
                '想让它自己交，把设置「乱选交卷前留几秒检查」改成大于 0'
            });
          }
          return false;
        }
        if (this._quizReviewPaperKey !== reviewKey || this._quizReviewUntil === 0) {
          this._quizReviewPaperKey = reviewKey;
          this._quizReviewUntil = reviewNow + reviewSec * 1000;
          emitRuntimeLog('info', 'quiz review window armed before submit', {
            seconds: reviewSec,
            key: reviewKey.slice(0, 60),
            hint: '乱选填完了整卷，' + reviewSec + ' 秒内可以自己改，到点自动交卷（交卷不可逆）'
          });
          return false;
        }
        if (reviewNow < this._quizReviewUntil) return false;
        this._quizReviewPaperKey = '';
        this._quizReviewUntil = 0;
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
      // ⚠️ **提交账的键只有一处判据**：`_getQuizAccountDocument`（2026-11-10 批次 8）。
      // 这里原先直接传 `null`：`_resolveQuizSubmitDocument(null)` 退回主文档，
      // 于是同一份卷子算出**两个键**（真实日志里那个 `courseId||||knowledgeid` 就是它）——
      // 提交次数记在 A 账、上限读在 B 账，`_shouldSkipQuizBySubmitAttempts` 永远读到 0，
      // 「按卷最多 2 次」形同不存在，表现成用户报过的**疯狂提交**。
      // 现在记账那一路自己会归一，这里显式取**同一份判据**，是为了让本函数下面那两条
      // warn 里的 `currentKey` 就是账本键 —— 别改回手抄第二份表达式（那是分叉的起点）。
      var confDoc = this._getQuizAccountDocument(null);
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
        var currentKey = this._getQuizWorkKey(confDoc);
        var readyForConfirm = this._quizReadyToSubmit || this._quizSubmitPending || this._quizAnswered;
        if (!readyForConfirm) {
          emitRuntimeLog('warn', 'wait submit confirm until quiz ready', { key: currentKey });
          this._submitConfirmLastClickAt = 0;
          return true;
        }
        if (this._quizReadyWorkKey && currentKey && this._quizReadyWorkKey !== currentKey) {
          // 批次 8 之后这一条**不该再出现**：两侧都按"题目所在文档"算键。
          // 真出现了就是键的算法又分叉了（比如题目文档在弹窗出现后换了），
          // 仍按设计继续提交，但把它留成 warn —— 这正是"上限绕得开"那族故障的探针。
          emitRuntimeLog('warn', 'submit confirm key mismatch, continue because quiz is ready', { readyKey: this._quizReadyWorkKey, key: currentKey });
        }
        this._markQuizSubmitPending(confDoc, 'confirm-dialog');
      }
      try { submitBtn.click(); } catch (e) {}
      return true;
    },

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
  };

  function removeStartPanel() {
    var panel = document.getElementById('xxt-panel');
    if (panel) panel.remove();
  }

  function showStartPanel(config) {
    removeStartPanel();

    var currentConfig = mergeConfig(config);
    var hasApiKey = !!(currentConfig.hasApiKey || currentConfig.randomAnswer);
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

  var defaultConfig = mergeConfig({ hasApiKey: false, autoNext: true, enableQuiz: false });
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
    /**
     * 清空"已经发过的讨论"名单。
     *
     * 什么时候用：某个讨论明明没发出去（或没发成功），但插件把它记成了已做 ——
     * 这时这一页的讨论就不会再被尝试。清掉之后刷新页面，它会重新扫一遍。
     * （名单存在 localStorage 的 `omitone_discussion_done`，24 小时自动过期。）
     */
    clearDiscussionDone: function () {
      if (!app) return false;
      try {
        localStorage.removeItem(app._discussionStoreKey);
        emitRuntimeLog('info', 'discussion done list cleared (manual)', {});
        console.log('[Omitone] 已清空"讨论已发"名单，刷新页面会重新扫一遍');
        return true;
      } catch (e) {
        return false;
      }
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
    },
    /**
     * 只读探针 —— 排查「明明没做完却说已完成」「这一节的第二个不做」时，
     * 一次把插件**眼里**的这一节打出来：任务点分类、平台附件账本、完成判定、
     * 抠题结果、延时窗口状态。
     *
     * ⚠️ 这里调的每个方法都必须只读：不许点下一节、不许交卷、不许发 AI 请求、
     * 不许复位任何答题状态（尤其别调 `_isQuizLearningPending`，它会复位答题状态）。
     * 判据本身一个字不改 —— 探针只是把同一套判据的输入输出摊开给人看。
     */
    probe: function () {
      if (!app) return null;
      var out = { at: new Date().toISOString(), href: String(location.href || '').slice(0, 110) };
      function safe(name, fn) {
        try { out[name] = fn(); } catch (e) {
          out[name] = 'ERR:' + (e && e.name ? e.name : '?') + ' ' + String((e && e.message) || e || '').slice(0, 50);
        }
      }
      safe('completion', function () {
        var s = app._getVisibleTaskCompletionState();
        return { hasTasks: !!s.hasTasks, allFinished: !!s.allFinished };
      });
      safe('tasks', function () {
        return app._collectVisibleTaskFrames().map(function (t) {
          return {
            type: t.type, finished: !!t.finished, marker: !!t.hasTaskMarker,
            src: String(t.src || '').slice(0, 56),
            wrap: String((t.wrap && t.wrap.className) || '').slice(0, 40),
            doc: t.doc ? 'ok' : 'null'
          };
        });
      });
      safe('attachments', function () {
        return app._getChaoxingAttachments().map(function (a) {
          var p = (a && a.property) || {};
          return {
            jobid: String(a.jobid || '').slice(0, 24), module: String(p.module || ''),
            job: String(a.job), isPassed: String(p.isPassed),
            title: String(p.title || p.name || '').slice(0, 22)
          };
        });
      });
      safe('progressKey', function () { return String(app._studyProgressKey() || ''); });
      safe('retryWindow', function () {
        return {
          leftMs: Math.max(0, (Number(app._quizParseRetryUntil) || 0) - Date.now()),
          scope: String(app._quizParseRetryScope || '')
        };
      });
      safe('sig', function () {
        var s = app._quizScanRetrySignal(null);
        return s ? { qTotal: s.qTotal, answer: s.answer, containers: s.containers, docs: s.docs, drop: s.drop } : null;
      });
      safe('questions', function () {
        var qs = app._extractQuestions(null) || [];
        var types = {};
        qs.forEach(function (q) { types[q.type] = (types[q.type] || 0) + 1; });
        return { n: qs.length, types: types, first: qs.length ? String(qs[0].title || '').slice(0, 28) : '' };
      });
      console.log('[Omitone] probe:', out);
      return out;
    }
  };
})();


