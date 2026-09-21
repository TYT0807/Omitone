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

  var DEFAULT_CONFIG = {
    playbackRate: 1.0,
    autoMaxPlaybackRate: true,
    playbackRateCap: 4,
    muted: false,
    // 音频任务点只需进度不需要出声，默认静音播放（不干扰用户、也不受自动播放限制）
    audioMuted: true,
    // 讨论任务点：自动打开讨论页并发布评论（内容见 discussionReply），完成后自动返回继续刷课
    enableDiscussion: true,
    discussionReply: '1',
    discussionTimeoutMs: 90000,
    autoNext: true,
    enableQuiz: true,
    // 「乱选」：不接 AI，本地随机生成答案。给不想配 API key 的用户用，
    // 只求把卷交出去，不求对。默认关。
    randomAnswer: false,
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
    apiKey: '',
    apiConnectionFailed: false,
    // 连通性检测失败时由 content.js / popup.js 写入的最近一次原因（只用于诊断展示）
    apiConnectionError: '',
    model: 'deepseek-v4-flash',
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
    stepSwitchGraceMs: 7000,
    stepSwitchInitDelayMs: 2200,
    taskDiscoverGraceMs: 8000,
    taskPendingGraceMs: 7000,
    quizSubmitWaitMs: 25000,
    quizMaxSubmitAttempts: 20,
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

  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
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
