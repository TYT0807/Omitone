/* ==========================================================================
 * Omitone page.js 片段 00/15 —— IIFE 外壳 / 常量 / 工具函数（app 对象开口）
 * 原 page.js 第 1–230 行（IIFE 外壳 + `var app = {`）
 *
 * ⚠️ 本文件不是独立的 JS —— 它是 page.js 的一段切片，单独看必然语法错误。
 *    根目录的 page.js 由 tools/concat-page.js 按文件名排序拼接而成（npm run concat）。
 *    改这个域请改本文件，然后跑 npm run concat；直接改根目录 page.js 会被覆盖。
 *
 * IIFE 外壳、全部常量（INSTANCE_ID / APP_NAME / DEFAULT_CONFIG 等）
 * 运行日志实现 emitRuntimeLog 与日志缓冲（对外写日志都走它）
 * 桥接消息（bridgeSend / bridgeCallbacks / BRIDGE_TIMEOUT_MS）、存储读写、mergeConfig 等工具函数
 * **本文件以 `var app = {` 结尾** —— 后面各域的属性块会被拼在它下面
 * ========================================================================== */
// @omitone-part-header-end
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
    // 连通性检测失败时由 content.js / popup.js 写入的最近一次原因（只用于诊断展示）
    apiConnectionError: '',
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
